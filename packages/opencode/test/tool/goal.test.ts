import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Goal } from "@/session/goal"
import { SessionReminders } from "@/session/reminders"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      Config.node,
      CrossSpawnSpawner.node,
      Database.node,
      EventV2Bridge.node,
      FSUtil.node,
      Goal.node,
      Ripgrep.node,
      RuntimeFlags.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      ToolRegistry.node,
      Truncate.node,
    ]),
  ),
)

const context = (sessionID: SessionID): Tool.Context => ({
  sessionID,
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const goalTool = Effect.fnUntraced(function* () {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const tool = (yield* registry.tools({ ...ref, agent: yield* agents.get("build") })).find((tool) => tool.id === "goal")
  if (!tool) throw new Error("goal tool not registered")
  return tool
})

const run = Effect.fnUntraced(function* (sessionID: SessionID, params: Record<string, unknown>) {
  const tool = yield* goalTool()
  return yield* tool.execute(params, context(sessionID))
})

const ids = (output: string) => output.split("\n").map((line) => line.split(" ")[0] ?? "")

const goalBlock = (messages: SessionV1.WithParts[]) =>
  messages
    .at(-1)
    ?.parts.flatMap((part) => (part.type === "text" && part.text.includes("<goals>") ? [part.text] : []))
    .at(0)

const userMessage = (sessionID: SessionID): SessionV1.WithParts => ({
  info: {
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  },
  parts: [],
})

describe("tool.goal", () => {
  it.instance("adds, lists, completes and abandons goals", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goals" })

      const added = yield* run(chat.id, { action: "add", content: "ship the orchestration feature" })
      expect(added.output).toContain("ship the orchestration feature")
      expect(added.output).toContain("[active]")
      expect(added.title).toBe("1 active goals")

      yield* run(chat.id, { action: "add", content: "delete the dead code" })
      const listed = yield* run(chat.id, { action: "list" })
      expect(listed.title).toBe("2 active goals")
      const [first, second] = ids(listed.output)

      const completed = yield* run(chat.id, { action: "complete", id: first })
      expect(completed.title).toBe("1 active goals")
      expect(completed.output).toContain(`${first} [completed]`)

      const abandoned = yield* run(chat.id, { action: "abandon", id: second })
      expect(abandoned.title).toBe("0 active goals")
      expect(abandoned.output).toContain(`${second} [abandoned]`)

      // Closed goals stay listed, active ones sort first.
      const goals = yield* (yield* Goal.Service).list()
      expect(goals.map((goal) => goal.status)).toEqual(["completed", "abandoned"])
      expect(goals[0]?.time.completed).toBeGreaterThan(0)
    }),
  )

  it.instance("requires content to add and a known id to close", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goals" })

      const missingContent = yield* Effect.exit(run(chat.id, { action: "add" }))
      expect(missingContent._tag).toBe("Failure")

      const unknownID = yield* Effect.exit(run(chat.id, { action: "complete", id: "goal_nope" }))
      expect(unknownID._tag).toBe("Failure")
    }),
  )

  it.instance("keeps goals across sessions in the same project", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const first = yield* sessions.create({ title: "first" })
      const second = yield* sessions.create({ title: "second" })
      expect(first.id).not.toBe(second.id)

      yield* run(first.id, { action: "add", content: "survive the session boundary" })

      const listed = yield* run(second.id, { action: "list" })
      expect(listed.output).toContain("survive the session boundary")
      expect(listed.title).toBe("1 active goals")
    }),
  )

  it.instance("injects active goals into the per-turn reminder", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const chat = yield* sessions.create({ title: "goals" })
      const agent = yield* agents.get("build")

      const empty = yield* SessionReminders.apply({
        messages: [userMessage(chat.id)],
        agent,
        session: chat,
      })
      expect(goalBlock(empty)).toBeUndefined()

      yield* run(chat.id, { action: "add", content: "keep the reminder honest" })
      const goals = yield* (yield* Goal.Service).list()

      const withGoals = yield* SessionReminders.apply({
        messages: [userMessage(chat.id)],
        agent,
        session: chat,
      })
      const block = goalBlock(withGoals)
      expect(block).toContain("keep the reminder honest")
      expect(block).toContain(goals[0]?.id)
      expect(block).toContain("</goals>")
    }),
  )

  it.instance("omits closed goals from the reminder", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const chat = yield* sessions.create({ title: "goals" })
      const agent = yield* agents.get("build")

      const added = yield* run(chat.id, { action: "add", content: "already done" })
      yield* run(chat.id, { action: "complete", id: ids(added.output)[0] })

      const messages = yield* SessionReminders.apply({
        messages: [userMessage(chat.id)],
        agent,
        session: chat,
      })
      expect(goalBlock(messages)).toBeUndefined()
    }),
  )
})
