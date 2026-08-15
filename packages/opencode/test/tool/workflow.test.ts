import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit, Fiber } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { type TaskPromptOps } from "../../src/tool/task"
import { WorkflowTool, normalizeSteps } from "../../src/tool/workflow"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
)

const it = testEffect(layer)

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("WorkflowToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function replyWithError(input: SessionPrompt.PromptInput, message: string): SessionV1.WithParts {
  const result = reply(input, "")
  if (result.info.role === "assistant")
    result.info.error = { name: "APIError", data: { message, isRetryable: true } }
  return result
}

function promptText(input: SessionPrompt.PromptInput) {
  return input.parts.find((part) => part.type === "text")?.text ?? ""
}

// Prompts are prefixed with `<stepID>|` so the stub can tell which step it is
// running without depending on session ids.
function stepOf(input: SessionPrompt.PromptInput) {
  return promptText(input).split("|")[0] ?? ""
}

const context = (input: {
  chat: SessionID
  assistant: MessageID
  promptOps: TaskPromptOps
  abort?: AbortSignal
  ask?: (req: unknown) => Effect.Effect<void>
  metadata?: (val: { title?: string; metadata?: any }) => Effect.Effect<void>
}) => ({
  sessionID: input.chat,
  messageID: input.assistant,
  agent: "build",
  abort: input.abort ?? new AbortController().signal,
  extra: { promptOps: input.promptOps },
  messages: [],
  metadata: input.metadata ?? (() => Effect.void),
  ask: input.ask ?? (() => Effect.void),
})

describe("tool.workflow", () => {
  it.instance("runs a diamond DAG deps-first, in parallel, with interpolated results", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()

      const started: string[] = []
      const seen: Record<string, string> = {}
      // Layer-2 steps must overlap: each one waits on a barrier that only opens
      // once both are in flight. If they were serialized the test would time out.
      const barrier = defer<void>()
      let inFlight = 0
      let maxInFlight = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const step = stepOf(input)
            started.push(step)
            seen[step] = promptText(input)
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            if (step === "b" || step === "c") {
              if (inFlight === 2) barrier.resolve()
              yield* Effect.promise(() => barrier.promise)
            }
            inFlight--
            return reply(input, `result-${step}`)
          }),
      }

      const metadata: any[] = []
      const result = yield* awaitWithTimeout(
        def.execute(
          {
            description: "diamond",
            steps: [
              { id: "a", prompt: "a|collect facts" },
              { id: "b", prompt: "b|from {{a}}", depends_on: ["a"] },
              { id: "c", prompt: "c|from {{a}}", depends_on: ["a"] },
              { id: "d", prompt: "d|merge {{b}} and {{c}}", depends_on: ["b", "c"] },
            ],
          },
          context({
            chat: chat.id,
            assistant: assistant.id,
            promptOps,
            metadata: (val) =>
              Effect.sync(() => {
                metadata.push(val)
              }),
          }),
        ),
        "workflow did not run layer-2 steps concurrently",
        "10 seconds",
      )

      expect(started[0]).toBe("a")
      expect(started.slice(1, 3).toSorted()).toEqual(["b", "c"])
      expect(started[3]).toBe("d")
      expect(maxInFlight).toBe(2)

      expect(seen["b"]).toBe("b|from result-a")
      expect(seen["c"]).toBe("c|from result-a")
      expect(seen["d"]).toBe("d|merge result-b and result-c")

      expect(result.metadata.steps).toEqual({ a: "done", b: "done", c: "done", d: "done" })
      expect(result.output).toContain(`<workflow description="diamond">`)
      expect(result.output).toContain(`<step id="a" agent="general" state="done">`)
      expect(result.output).toContain("result-d")

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(4)
      for (const kid of kids) {
        expect(kid.agent).toBe("general")
        expect(kid.permission).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
        expect(kid.permission).toContainEqual({ permission: "workflow", pattern: "*", action: "deny" })
      }

      // progress reporting: at least one update where a step is still running
      expect(metadata.some((item) => Object.values(item.metadata?.steps ?? {}).includes("running"))).toBe(true)
      expect(metadata.at(-1)?.metadata?.steps).toEqual({ a: "done", b: "done", c: "done", d: "done" })
    }),
  )

  it.instance("runs a plain list of strings as a pipeline, feeding each result to the next", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()

      const prompts: string[] = []
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            prompts.push(promptText(input))
            return reply(input, prompts.length === 1 ? "FINDINGS" : "SUMMARY")
          }),
      }

      const result = yield* def.execute(
        { description: "research", steps: ["Research the topic", "Write a summary"] },
        context({ chat: chat.id, assistant: assistant.id, promptOps }),
      )

      // Step 1 gets the bare prompt; step 2 auto-receives step 1's result.
      expect(prompts[0]).toBe("Research the topic")
      expect(prompts[1]).toContain("Results from previous steps")
      expect(prompts[1]).toContain("FINDINGS")
      expect(prompts[1]).toContain("Write a summary")

      expect(result.metadata.steps).toEqual({ s1: "done", s2: "done" })
      expect(yield* sessions.children(chat.id)).toHaveLength(2)
    }),
  )

  it.instance("runs a batch of strings in parallel, then joins them", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()

      const barrier = defer<void>()
      let inFlight = 0
      let maxInFlight = 0
      let joinPrompt = ""
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const text = promptText(input)
            if (text.includes("Scan")) {
              inFlight++
              maxInFlight = Math.max(maxInFlight, inFlight)
              if (inFlight === 2) barrier.resolve()
              yield* Effect.promise(() => barrier.promise)
              inFlight--
              return reply(input, `hit-${text.includes("chain A") ? "A" : "B"}`)
            }
            joinPrompt = text
            return reply(input, "merged")
          }),
      }

      const result = yield* awaitWithTimeout(
        def.execute(
          { description: "fan out", steps: [["Scan chain A", "Scan chain B"], "Merge the results"] },
          context({ chat: chat.id, assistant: assistant.id, promptOps }),
        ),
        "workflow did not run the batch concurrently",
        "10 seconds",
      )

      expect(maxInFlight).toBe(2)
      expect(joinPrompt).toContain("hit-A")
      expect(joinPrompt).toContain("hit-B")
      expect(result.metadata.steps).toEqual({ s1_1: "done", s1_2: "done", s2: "done" })
    }),
  )

  it.instance("asks once up front listing the agents involved", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const asked: any[] = []

      yield* def.execute(
        {
          description: "ask once",
          steps: [
            { id: "a", prompt: "a|one" },
            { id: "b", prompt: "b|two", agent: "general" },
          ],
        },
        context({
          chat: chat.id,
          assistant: assistant.id,
          promptOps: {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) => Effect.succeed(reply(input, "ok")),
          },
          ask: (req) =>
            Effect.sync(() => {
              asked.push(req)
            }),
        }),
      )

      expect(asked).toHaveLength(1)
      expect(asked[0].permission).toBe("workflow")
      expect(asked[0].patterns).toEqual(["general"])
    }),
  )

  it.instance("rejects cycles, unknown deps, duplicate ids, unknown agents and oversized graphs", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => Effect.succeed(reply(input, "ok")),
      }

      const attempt = (steps: any[]) =>
        def
          .execute({ description: "bad", steps }, context({ chat: chat.id, assistant: assistant.id, promptOps }))
          .pipe(Effect.exit)

      const cycle = yield* attempt([
        { id: "a", prompt: "a|x", depends_on: ["b"] },
        { id: "b", prompt: "b|x", depends_on: ["a"] },
      ])
      expect(Exit.isFailure(cycle)).toBe(true)

      const unknownDep = yield* attempt([{ id: "a", prompt: "a|x", depends_on: ["nope"] }])
      expect(Exit.isFailure(unknownDep)).toBe(true)

      const duplicate = yield* attempt([
        { id: "a", prompt: "a|x" },
        { id: "a", prompt: "a|y" },
      ])
      expect(Exit.isFailure(duplicate)).toBe(true)

      const selfDep = yield* attempt([{ id: "a", prompt: "a|x", depends_on: ["a"] }])
      expect(Exit.isFailure(selfDep)).toBe(true)

      const empty = yield* attempt([])
      expect(Exit.isFailure(empty)).toBe(true)

      const tooMany = yield* attempt(
        Array.from({ length: 17 }, (_, index) => ({ id: `s${index}`, prompt: `s${index}|x` })),
      )
      expect(Exit.isFailure(tooMany)).toBe(true)

      const unknownAgent = yield* attempt([{ id: "a", prompt: "a|x", agent: "nope" }])
      expect(Exit.isFailure(unknownAgent)).toBe(true)

      // nothing ran
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("skips dependents of a failed step and still returns partial results", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const started: string[] = []
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const step = stepOf(input)
            started.push(step)
            if (step === "b") return yield* Effect.die(new Error("b exploded"))
            return reply(input, `result-${step}`)
          }),
      }

      const result = yield* def.execute(
        {
          description: "partial",
          steps: [
            { id: "a", prompt: "a|one" },
            { id: "b", prompt: "b|from {{a}}", depends_on: ["a"] },
            { id: "c", prompt: "c|from {{a}}", depends_on: ["a"] },
            { id: "d", prompt: "d|from {{b}}", depends_on: ["b"] },
            { id: "e", prompt: "e|from {{d}}", depends_on: ["d"] },
          ],
        },
        context({ chat: chat.id, assistant: assistant.id, promptOps }),
      )

      expect(result.metadata.steps).toEqual({ a: "done", b: "error", c: "done", d: "skipped", e: "skipped" })
      expect(started.toSorted()).toEqual(["a", "b", "c"])
      expect(result.output).toContain(`<step id="b" agent="general" state="error">`)
      expect(result.output).toContain("b exploded")
      expect(result.output).toContain(`<step id="d" agent="general" state="skipped">`)
      expect(result.output).toContain("result-c")
      expect(result.title).toContain("2/5")
    }),
  )

  it.instance("marks a step errored when the child turn reports an API error", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const step = stepOf(input)
            if (step === "a") return replyWithError(input, "Loading model")
            return reply(input, `result-${step}`)
          }),
      }

      const result = yield* def.execute(
        {
          description: "child error",
          retries: 0,
          steps: [
            { id: "a", prompt: "a|one" },
            { id: "b", prompt: "b|from {{a}}", depends_on: ["a"] },
          ],
        },
        context({ chat: chat.id, assistant: assistant.id, promptOps }),
      )

      expect(result.metadata.steps).toEqual({ a: "error", b: "skipped" })
      expect(result.output).toContain(`<step id="a" agent="general" state="error">`)
      expect(result.output).toContain("Loading model")
      expect(result.output).toContain(`<step id="b" agent="general" state="skipped">`)
    }),
  )

  it.instance("retries a step that fails transiently, then succeeds", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const attempts: Record<string, number> = {}
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const step = stepOf(input)
            attempts[step] = (attempts[step] ?? 0) + 1
            // First attempt at "a" reports a transient "Loading model" error.
            if (step === "a" && attempts[step] === 1) return replyWithError(input, "503 Loading model")
            return reply(input, `result-${step}`)
          }),
      }

      const result = yield* awaitWithTimeout(
        def.execute(
          {
            description: "retry then succeed",
            steps: [
              { id: "a", prompt: "a|one" },
              { id: "b", prompt: "b|from {{a}}", depends_on: ["a"] },
            ],
          },
          context({ chat: chat.id, assistant: assistant.id, promptOps }),
        ),
        "workflow retry did not complete",
        "20 seconds",
      )

      expect(attempts["a"]).toBe(2)
      expect(result.metadata.steps).toEqual({ a: "done", b: "done" })
      expect(result.output).toContain("result-a")
      expect(result.output).toContain("result-b")
    }),
  )

  it.instance("does not retry a non-transient error and skips dependents", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const attempts: Record<string, number> = {}
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const step = stepOf(input)
            attempts[step] = (attempts[step] ?? 0) + 1
            if (step === "a") {
              const failed = reply(input, "")
              if (failed.info.role === "assistant")
                failed.info.error = { name: "APIError", data: { message: "bad request", statusCode: 400, isRetryable: false } }
              return failed
            }
            return reply(input, `result-${step}`)
          }),
      }

      const result = yield* def.execute(
        {
          description: "non-transient",
          steps: [
            { id: "a", prompt: "a|one" },
            { id: "b", prompt: "b|from {{a}}", depends_on: ["a"] },
          ],
        },
        context({ chat: chat.id, assistant: assistant.id, promptOps }),
      )

      // A non-transient error must not be retried.
      expect(attempts["a"]).toBe(1)
      expect(result.metadata.steps).toEqual({ a: "error", b: "skipped" })
      expect(result.output).toContain("bad request")
    }),
  )

  it.instance("times out a step whose child never resolves", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const never = defer<SessionV1.WithParts>()
      const cancels: SessionID[] = []
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancels.push(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: () => Effect.promise(() => never.promise),
      }

      const result = yield* awaitWithTimeout(
        def.execute(
          { description: "timeout", step_timeout_seconds: 1, steps: [{ id: "a", prompt: "a|hang forever" }] },
          context({ chat: chat.id, assistant: assistant.id, promptOps }),
        ),
        "workflow did not time out the hung step",
        "20 seconds",
      )

      expect(result.metadata.steps).toEqual({ a: "error" })
      expect(result.output).toContain("step timed out after 1s")
      // The hung child must have been cancelled.
      expect(cancels.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.instance("stops retrying after the retry limit and fails the step", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const attempts: Record<string, number> = {}
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const step = stepOf(input)
            attempts[step] = (attempts[step] ?? 0) + 1
            if (step === "a") return replyWithError(input, "Loading model")
            return reply(input, `result-${step}`)
          }),
      }

      const result = yield* awaitWithTimeout(
        def.execute(
          {
            description: "retry limit",
            retries: 1,
            steps: [
              { id: "a", prompt: "a|one" },
              { id: "b", prompt: "b|from {{a}}", depends_on: ["a"] },
            ],
          },
          context({ chat: chat.id, assistant: assistant.id, promptOps }),
        ),
        "workflow retry-limit did not complete",
        "20 seconds",
      )

      // 1 initial attempt + 1 retry, then give up.
      expect(attempts["a"]).toBe(2)
      expect(result.metadata.steps).toEqual({ a: "error", b: "skipped" })
      expect(result.output).toContain("Loading model")
    }),
  )

  it.instance("cancels running child sessions when the abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const abort = new AbortController()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const cancels: SessionID[] = []
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancels.push(sessionID)
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          { description: "cancel me", steps: [{ id: "a", prompt: "a|long running" }] },
          context({ chat: chat.id, assistant: assistant.id, promptOps, abort: abort.signal }),
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)
      expect(cancels).toEqual([input.sessionID])

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance(
    "refuses to start beyond the configured subagent depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nested = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const def = yield* (yield* WorkflowTool).init()
        let asked = false

        const exit = yield* def
          .execute(
            { description: "nested", steps: [{ id: "a", prompt: "a|x" }] },
            {
              sessionID: child.id,
              messageID: nested.id,
              agent: "general",
              abort: new AbortController().signal,
              extra: {
                promptOps: {
                  cancel: () => Effect.void,
                  resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
                  prompt: (input: SessionPrompt.PromptInput) => Effect.succeed(reply(input, "ok")),
                } satisfies TaskPromptOps,
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.sync(() => (asked = true)),
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(asked).toBe(false)
        expect(yield* sessions.children(child.id)).toHaveLength(0)
      }),
    { config: {} },
  )
})

describe("workflow.normalizeSteps", () => {
  test("chains plain strings into a sequential pipeline", () => {
    const steps = normalizeSteps(["research", "analyze", "report"])
    expect(steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"])
    expect(steps.map((s) => s.depends_on)).toEqual([[], ["s1"], ["s2"]])
    expect(steps.map((s) => s.prompt)).toEqual(["research", "analyze", "report"])
    // string steps auto-inject their (single) dependency's result
    expect(steps.map((s) => s.autoInject)).toEqual([true, true, true])
  })

  test("runs a string array as a parallel batch that the next step joins", () => {
    const steps = normalizeSteps([["scan a", "scan b"], "merge"])
    expect(steps.map((s) => s.id)).toEqual(["s1_1", "s1_2", "s2"])
    expect(steps.find((s) => s.id === "s1_1")!.depends_on).toEqual([])
    expect(steps.find((s) => s.id === "s2")!.depends_on).toEqual(["s1_1", "s1_2"])
  })

  test("keeps the explicit object form independent unless depends_on is given", () => {
    const steps = normalizeSteps([
      { id: "a", prompt: "one" },
      { id: "b", prompt: "two" },
      { id: "c", prompt: "merge {{a}} and {{b}}", depends_on: ["a", "b"] },
    ])
    expect(steps.find((s) => s.id === "a")!.depends_on).toEqual([])
    expect(steps.find((s) => s.id === "b")!.depends_on).toEqual([])
    expect(steps.find((s) => s.id === "c")!.depends_on).toEqual(["a", "b"])
    // {{a}}/{{b}} placeholders present -> explicit interpolation, no auto-injection
    expect(steps.find((s) => s.id === "c")!.autoInject).toBe(false)
  })

  test("auto-generates ids for objects that omit them", () => {
    const steps = normalizeSteps([{ prompt: "no id" }, { prompt: "also none" }])
    expect(steps.map((s) => s.id)).toEqual(["s1", "s2"])
  })

  test("mixes forms, chaining strings onto the preceding step", () => {
    const steps = normalizeSteps([{ id: "seed", prompt: "seed" }, "follow up"])
    expect(steps[1].id).toBe("s2")
    expect(steps[1].depends_on).toEqual(["seed"])
  })
})
