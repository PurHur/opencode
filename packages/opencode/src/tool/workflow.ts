import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Config } from "@/config/config"
import { Cause, Effect, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import type { TaskPromptOps } from "./task"

const id = "workflow"
const DEFAULT_AGENT = "general"
const MAX_STEPS = 16
const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 8
const RESULT_LIMIT = 8000

export type StepState = "pending" | "running" | "done" | "error" | "skipped"

// Advanced form: an explicit step object for a dependency graph.
const StepObject = Schema.Struct({
  id: Schema.optional(Schema.String).annotate({
    description: "Optional unique id, referenced by other steps in depends_on and {{id}}. Auto-generated if omitted.",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: `The type of specialized agent to run this step (defaults to "${DEFAULT_AGENT}")`,
  }),
  prompt: Schema.String.annotate({
    description: "The instructions for this step. Use {{otherId}} to inject the final text of a step in depends_on",
  }),
  depends_on: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Step ids that must complete before this step starts",
  }),
}).annotate({ identifier: "WorkflowStep" })

// Each step is the simple string form, a parallel batch of strings, or the advanced object.
const StepEntry = Schema.Union([Schema.String, Schema.Array(Schema.String), StepObject])

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the workflow" }),
  steps: Schema.mutable(Schema.Array(StepEntry)).annotate({
    description:
      "The steps to run in order. Each step is EITHER a plain string (a task that runs after the previous " +
      "step and automatically receives its result), OR an array of strings (tasks that run in parallel), OR an " +
      `object {prompt, agent?, depends_on?, id?} for an explicit graph. Most workflows are just a list of strings. At most ${MAX_STEPS} steps.`,
  }),
  concurrency: Schema.optional(Schema.Number).annotate({
    description: `Maximum number of steps to run at once (default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY})`,
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type RawStep = Params["steps"][number]

// Internal, fully-resolved step used by the scheduler.
type StepInput = {
  id: string
  agent?: string
  prompt: string
  depends_on: string[]
  autoInject: boolean // prepend dependency results when the prompt has no {{id}} placeholders
}

// Turn the flexible input (strings / batches / objects) into an explicit DAG.
// Plain strings and batches chain onto whatever ran immediately before them, so
// `["a", "b", "c"]` is a pipeline and `["a", ["b", "c"], "d"]` fans out then joins.
export function normalizeSteps(raw: RawStep[]): StepInput[] {
  const out: StepInput[] = []
  let previous: string[] = []
  raw.forEach((entry, index) => {
    const batch = typeof entry === "string" ? [entry] : Array.isArray(entry) ? [...entry] : undefined
    if (batch) {
      const ids: string[] = []
      batch.forEach((prompt, offset) => {
        const id = batch.length > 1 ? `s${index + 1}_${offset + 1}` : `s${index + 1}`
        out.push({ id, prompt, depends_on: [...previous], autoInject: true })
        ids.push(id)
      })
      previous = ids
      return
    }
    // The explicit object form controls its own dependencies: omitting depends_on
    // means "no dependencies" (an independent root), unlike the auto-chained strings.
    const step = entry as { id?: string; agent?: string; prompt: string; depends_on?: readonly string[] }
    const id = step.id?.trim() || `s${index + 1}`
    const depends_on = step.depends_on ? [...step.depends_on] : []
    const autoInject = depends_on.length > 0 && !depends_on.some((dep) => step.prompt.includes(`{{${dep}}}`))
    out.push({ id, agent: step.agent, prompt: step.prompt, depends_on, autoInject })
    previous = [id]
  })
  return out
}

type Metadata = {
  description: string
  steps: Record<string, StepState>
  sessions: Record<string, string>
}

function truncate(text: string) {
  if (text.length <= RESULT_LIMIT) return text
  return text.slice(0, RESULT_LIMIT) + `\n… [truncated ${text.length - RESULT_LIMIT} characters]`
}

function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Kahn's algorithm, grouped into layers. Every step in a layer only depends on
 * steps from earlier layers, so a layer can be run concurrently. Returns
 * `undefined` when the graph contains a cycle (some step never becomes ready).
 */
export function layers(steps: StepInput[]) {
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.depends_on ?? [])]))
  const out: string[][] = []
  const done = new Set<string>()
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => [...deps].every((dep) => done.has(dep)))
    if (ready.length === 0) return undefined
    for (const [step] of ready) {
      remaining.delete(step)
    }
    for (const [step] of ready) {
      done.add(step)
    }
    out.push(ready.map(([step]) => step))
  }
  return out
}

function validate(steps: StepInput[]) {
  if (steps.length === 0) return "steps must not be empty"
  if (steps.length > MAX_STEPS) return `too many steps (${steps.length}), the maximum is ${MAX_STEPS}`
  const ids = new Set<string>()
  for (const step of steps) {
    if (!step.id.trim()) return "every step needs a non-empty id"
    if (!step.prompt.trim()) return `step "${step.id}" needs a non-empty prompt`
    if (ids.has(step.id)) return `duplicate step id "${step.id}"`
    ids.add(step.id)
  }
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (dep === step.id) return `step "${step.id}" depends on itself`
      if (!ids.has(dep)) return `step "${step.id}" depends on unknown step "${dep}"`
    }
  }
  if (!layers(steps)) return "steps contain a dependency cycle"
  return undefined
}

function renderOutput(input: {
  description: string
  steps: StepInput[]
  states: Record<string, StepState>
  results: Record<string, string>
}) {
  return [
    `<workflow description="${escape(input.description)}">`,
    ...input.steps.flatMap((step) => [
      `<step id="${escape(step.id)}" agent="${escape(step.agent ?? DEFAULT_AGENT)}" state="${input.states[step.id]}">`,
      truncate(input.results[step.id] ?? ""),
      "</step>",
    ]),
    "</workflow>",
  ].join("\n")
}

export const WorkflowTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const database = yield* Database.Service

    const run = Effect.fn("WorkflowTool.execute")(function* (params: Params, ctx: Tool.Context) {
      const cfg = yield* config.get()

      const steps = normalizeSteps(params.steps)
      const invalid = validate(steps)
      if (invalid) return yield* Effect.fail(new Error(`Invalid workflow: ${invalid}`))

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      const resolved = new Map<string, Agent.Info>()
      for (const name of new Set(steps.map((step) => step.agent ?? DEFAULT_AGENT))) {
        const info = yield* agents.get(name)
        if (!info) return yield* Effect.fail(new Error(`Unknown agent type: ${name} is not a valid agent type`))
        resolved.set(name, info)
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [...resolved.keys()],
          always: ["*"],
          metadata: {
            description: params.description,
            steps: steps.map((step) => step.id),
          },
        })
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant
      const inherited = { modelID: msg.info.modelID, providerID: msg.info.providerID }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("WorkflowTool requires promptOps in ctx.extra"))

      const order = layers(steps)!
      const states: Record<string, StepState> = Object.fromEntries(steps.map((step) => [step.id, "pending"]))
      const results: Record<string, string> = {}
      const childSessions: Record<string, string> = {}
      const running = new Set<SessionID>()

      const report = () =>
        ctx.metadata({
          title: params.description,
          metadata: {
            description: params.description,
            steps: { ...states },
            sessions: { ...childSessions },
          } satisfies Metadata,
        })

      const bridge = yield* EffectBridge.make()
      function onAbort() {
        for (const sessionID of running) bridge.fork(ops.cancel(sessionID))
      }
      ctx.abort.addEventListener("abort", onAbort)

      const runStep = Effect.fn("WorkflowTool.runStep")(function* (step: StepInput) {
        const next = resolved.get(step.agent ?? DEFAULT_AGENT)!
        const childPermission = deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          subagent: next,
        })
        const childToolDenies = [
          ...(next.permission.some((rule) => rule.permission === id)
            ? []
            : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
          ...(cfg.experimental?.primary_tools?.map((permission) => ({
            permission,
            pattern: "*" as const,
            action: "deny" as const,
          })) ?? []),
        ]
        const child = yield* sessions.create({
          parentID: ctx.sessionID,
          title: `${params.description}: ${step.id} (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        })

        childSessions[step.id] = child.id
        states[step.id] = "running"
        running.add(child.id)
        yield* report()

        let prompt = step.prompt
        for (const dep of step.depends_on) {
          prompt = prompt.split(`{{${dep}}}`).join(truncate(results[dep] ?? ""))
        }
        // For simple string steps (no {{id}} placeholders), automatically feed the
        // dependency results forward so a plain list of steps behaves as a pipeline.
        if (step.autoInject) {
          const context = step.depends_on
            .map((dep) => results[dep])
            .filter((value): value is string => Boolean(value && value.trim()))
            .map((value) => `<result>\n${truncate(value)}\n</result>`)
            .join("\n")
          if (context) prompt = `Results from previous steps:\n${context}\n\nYour task:\n${prompt}`
        }

        const parts = yield* ops.resolvePromptParts(prompt)
        const result = yield* ops
          .prompt({
            messageID: MessageID.ascending(),
            sessionID: child.id,
            model: next.model ?? inherited,
            variant: next.model ? undefined : variant,
            agent: next.name,
            parts,
          })
          .pipe(
            Effect.onInterrupt(() => ops.cancel(child.id)),
            Effect.ensuring(
              Effect.sync(() => {
                running.delete(child.id)
              }),
            ),
          )

        if (result.info.role === "assistant" && result.info.error) {
          const err = result.info.error
          const detail = "message" in err.data && err.data.message ? err.data.message : err.name
          return yield* Effect.fail(new Error(detail))
        }

        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const dependents = (root: string) => {
        const marked = new Set([root])
        let grew = true
        while (grew) {
          grew = false
          for (const step of steps) {
            if (marked.has(step.id)) continue
            if (step.depends_on.some((dep) => marked.has(dep))) {
              marked.add(step.id)
              grew = true
            }
          }
        }
        marked.delete(root)
        return marked
      }

      yield* report()

      const concurrency = Math.max(1, Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY))
      yield* Effect.gen(function* () {
        for (const layer of order) {
          const pending = layer.filter((step) => states[step] === "pending")
          yield* Effect.forEach(
            pending,
            Effect.fnUntraced(function* (stepID: string) {
              const step = steps.find((item) => item.id === stepID)!
              const exit = yield* runStep(step).pipe(Effect.exit)
              if (exit._tag === "Success") {
                states[step.id] = "done"
                results[step.id] = exit.value
              } else {
                states[step.id] = "error"
                results[step.id] = renderCause(exit.cause)
                for (const skipped of dependents(step.id)) {
                  if (states[skipped] === "pending") states[skipped] = "skipped"
                }
              }
              yield* report()
            }),
            { concurrency },
          )
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", onAbort)
          }),
        ),
      )

      const counts = steps.reduce(
        (acc, step) => {
          acc[states[step.id]]++
          return acc
        },
        { pending: 0, running: 0, done: 0, error: 0, skipped: 0 } as Record<StepState, number>,
      )

      return {
        title: `${params.description} (${counts.done}/${steps.length})`,
        metadata: {
          description: params.description,
          steps: { ...states },
          sessions: { ...childSessions },
        } satisfies Metadata,
        output: renderOutput({ description: params.description, steps, states, results }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function renderCause(cause: Cause.Cause<unknown>) {
  const squashed = Cause.squash(cause)
  const message = squashed instanceof Error ? squashed.message : String(squashed)
  return message.length > 0 ? message : "step failed"
}
