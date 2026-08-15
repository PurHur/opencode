import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Config } from "@/config/config"
import { Cause, Duration, Effect, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import type { TaskPromptOps } from "./task"

const id = "workflow"
const DEFAULT_AGENT = "general"
// The agent used for the planning phase when a goal is given: the dedicated
// `planner` agent if the user has one, otherwise the default general agent.
const PLANNER_AGENT = "planner"
const MAX_STEPS = 16
const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 8
const RESULT_LIMIT = 8000
// When a result exceeds RESULT_LIMIT we keep both ends: the head carries the
// setup, the tail carries the conclusion. A slow local backend rules out a
// summarizer subagent, so this stays cheap and deterministic.
const RESULT_HEAD = 5000
const RESULT_TAIL = 2500
const DEFAULT_RETRIES = 2
const MAX_RETRIES = 5
const MAX_STEP_TIMEOUT = 3600

// Errors from a child turn that are worth retrying: the assistant message error
// is a retryable API error (>=500 or explicitly retryable), or its text looks
// like a transient loading/overload/network condition a slow local model hits.
const TRANSIENT_MESSAGE = /loading model|503|overloaded|ECONNRESET|reset|timeout/i

// A retryable step failure. Kept as a distinct Error subclass so the retry loop
// can tell it apart from a permanent failure (which fails the step immediately).
class TransientStepError extends Error {}

function isTransientError(err: { name: string; data: Record<string, unknown> }) {
  const data = err.data ?? {}
  if (err.name === "APIError") {
    if (typeof data.statusCode === "number" && data.statusCode >= 500) return true
    if (data.isRetryable === true) return true
  }
  const message = typeof data.message === "string" ? data.message : err.name
  return TRANSIENT_MESSAGE.test(message)
}

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
  goal: Schema.optional(Schema.String).annotate({
    description:
      "A high-level goal to plan into steps automatically. Provide this INSTEAD of steps when you want the " +
      "workflow to plan itself: a planning subagent expands the goal into concrete steps that are then run. " +
      "If steps are also given, they win and goal is ignored.",
  }),
  steps: Schema.optional(Schema.mutable(Schema.Array(StepEntry))).annotate({
    description:
      "The steps to run in order. Each step is EITHER a plain string (a task that runs after the previous " +
      "step and automatically receives its result), OR an array of strings (tasks that run in parallel), OR an " +
      `object {prompt, agent?, depends_on?, id?} for an explicit graph. Most workflows are just a list of strings. At most ${MAX_STEPS} steps. Omit when providing a goal.`,
  }),
  concurrency: Schema.optional(Schema.Number).annotate({
    description: `Maximum number of steps to run at once (default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY})`,
  }),
  retries: Schema.optional(Schema.Number).annotate({
    description:
      `How many times to retry a step that fails with a transient error such as "loading model", 503, ` +
      `overloaded, connection reset, or timeout (default ${DEFAULT_RETRIES}, max ${MAX_RETRIES}, 0 disables). ` +
      "Non-transient errors always fail immediately.",
  }),
  step_timeout_seconds: Schema.optional(Schema.Number).annotate({
    description:
      `Cancel a single step and mark it a timeout error if it runs longer than this many seconds ` +
      `(default 0 = no limit, max ${MAX_STEP_TIMEOUT}).`,
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type RawStep = Schema.Schema.Type<typeof StepEntry>

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
  plan?: string[]
}

// The instruction handed to the planning subagent. The literal prefix
// "Break this goal into" is also how a caller (or a test) recognises the
// planning turn among the step turns.
export function plannerPrompt(goal: string) {
  return (
    `Break this goal into 2 to ${MAX_STEPS} concrete, independent workflow steps. ` +
    `Reply with ONLY a JSON array of short step instruction strings, nothing else. Goal: ${goal}`
  )
}

// Parse the planner's final text into a list of step instructions. Lenient: the
// model may wrap the array in prose or a markdown code fence, so we take the
// span from the first "[" to the last "]" and JSON-parse that. Returns an empty
// array when nothing usable is found.
export function parsePlan(text: string): string[] {
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
  } catch {
    return []
  }
}

function truncate(text: string) {
  if (text.length <= RESULT_LIMIT) return text
  const removed = text.length - RESULT_HEAD - RESULT_TAIL
  return (
    text.slice(0, RESULT_HEAD) + `\n… [truncated ${removed} characters] …\n` + text.slice(text.length - RESULT_TAIL)
  )
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
  if (steps.length === 0) return 'steps must not be empty; provide at least one step, e.g. "steps": ["do the task"]'
  if (steps.length > MAX_STEPS)
    return `too many steps (${steps.length}); use at most ${MAX_STEPS} by combining related work into fewer steps`
  const ids = new Set<string>()
  for (const step of steps) {
    if (!step.id.trim()) return "every step needs a non-empty id; omit id to have one generated automatically"
    if (!step.prompt.trim()) return `step "${step.id}" needs a non-empty prompt describing what the subagent should do`
    if (ids.has(step.id)) return `duplicate step id "${step.id}"; give each step a unique id`
    ids.add(step.id)
  }
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (dep === step.id) return `step "${step.id}" depends on itself; remove "${step.id}" from its depends_on`
      if (!ids.has(dep))
        return `step "${step.id}" depends on unknown step "${dep}"; depends_on must reference an existing step id`
    }
  }
  if (!layers(steps)) return "steps contain a dependency cycle; make sure depends_on forms a graph with no loops"
  return undefined
}

function renderOutput(input: {
  description: string
  steps: StepInput[]
  states: Record<string, StepState>
  results: Record<string, string>
  plan?: string[]
}) {
  return [
    `<workflow description="${escape(input.description)}">`,
    ...(input.plan && input.plan.length > 0
      ? ["<plan>", ...input.plan.map((step, index) => `${index + 1}. ${escape(step)}`), "</plan>"]
      : []),
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

      // Depth guard first: it must apply to the planning subagent too, and it
      // must reject before anything (planner included) is spawned or asked.
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

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("WorkflowTool requires promptOps in ctx.extra"))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant
      const inherited = { modelID: msg.info.modelID, providerID: msg.info.providerID }

      // Compute the child-session permission set for a given subagent: inherited
      // permissions plus denies for nested workflow/task so a step (or the
      // planner) cannot recurse. Shared by the planner and every step.
      const childPermissionsFor = (next: Agent.Info) => {
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
        return [
          ...childPermission,
          ...childToolDenies.filter(
            (deny) =>
              !childPermission.some(
                (rule) =>
                  rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
              ),
          ),
        ]
      }

      // PLANNING PHASE: a goal with no explicit steps is expanded by a planning
      // subagent into concrete step instructions. Explicit steps always win, so
      // goal is ignored whenever steps are provided.
      let rawSteps: RawStep[] = params.steps ? [...params.steps] : []
      const goal = params.goal?.trim()
      let plan: string[] | undefined
      if (goal && rawSteps.length === 0) {
        const plannerAgent = (yield* agents.get(PLANNER_AGENT)) ?? (yield* agents.get(DEFAULT_AGENT))
        if (!plannerAgent)
          return yield* Effect.fail(new Error(`Unknown agent type: ${DEFAULT_AGENT} is not a valid agent type`))

        // The planning child is subagent work, so it goes through the same ask.
        if (!ctx.extra?.bypassAgentCheck) {
          yield* ctx.ask({
            permission: id,
            patterns: [plannerAgent.name],
            always: ["*"],
            metadata: { description: params.description, steps: ["plan"] },
          })
        }

        const plannerChild = yield* sessions.create({
          parentID: ctx.sessionID,
          title: `${params.description}: plan (@${plannerAgent.name} subagent)`,
          agent: plannerAgent.name,
          permission: childPermissionsFor(plannerAgent),
        })
        const plannerParts = yield* ops.resolvePromptParts(plannerPrompt(goal))
        const plannerResult = yield* ops
          .prompt({
            messageID: MessageID.ascending(),
            sessionID: plannerChild.id,
            model: plannerAgent.model ?? inherited,
            variant: plannerAgent.model ? undefined : variant,
            agent: plannerAgent.name,
            parts: plannerParts,
          })
          .pipe(Effect.onInterrupt(() => ops.cancel(plannerChild.id)))

        const plannerText = plannerResult.parts.findLast((item) => item.type === "text")?.text ?? ""
        plan = parsePlan(plannerText)
        if (plan.length === 0) return yield* Effect.fail(new Error("planner did not return any steps"))
        rawSteps = plan
      }

      const steps = normalizeSteps(rawSteps)
      const invalid = validate(steps)
      if (invalid) return yield* Effect.fail(new Error(`Invalid workflow: ${invalid}`))

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

      const retries = Math.max(0, Math.min(Math.floor(params.retries ?? DEFAULT_RETRIES), MAX_RETRIES))
      const stepTimeout = Math.max(0, Math.min(Math.floor(params.step_timeout_seconds ?? 0), MAX_STEP_TIMEOUT))

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
            ...(plan ? { plan } : {}),
          } satisfies Metadata,
        })

      const bridge = yield* EffectBridge.make()
      function onAbort() {
        for (const sessionID of running) bridge.fork(ops.cancel(sessionID))
      }
      ctx.abort.addEventListener("abort", onAbort)

      const runStep = Effect.fn("WorkflowTool.runStep")(function* (step: StepInput) {
        const next = resolved.get(step.agent ?? DEFAULT_AGENT)!
        const childPermissions = childPermissionsFor(next)

        // The prompt (dependency interpolation and auto-injected context) is the
        // same across attempts, so build it once before any retry.
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

        // A single attempt: fresh subagent session, run the turn (optionally under
        // a timeout), then classify the outcome. Transient failures raise a
        // TransientStepError so the retry loop can catch them.
        const attempt = Effect.fn("WorkflowTool.attempt")(function* () {
          const child = yield* sessions.create({
            parentID: ctx.sessionID,
            title: `${params.description}: ${step.id} (@${next.name} subagent)`,
            agent: next.name,
            permission: childPermissions,
          })

          childSessions[step.id] = child.id
          states[step.id] = "running"
          running.add(child.id)
          yield* report()

          const turn = ops
            .prompt({
              messageID: MessageID.ascending(),
              sessionID: child.id,
              model: next.model ?? inherited,
              variant: next.model ? undefined : variant,
              agent: next.name,
              parts,
            })
            .pipe(
              // Cancel the child on interrupt — from the outer abort signal as well
              // as from the per-step timeout, which interrupts this turn.
              Effect.onInterrupt(() => ops.cancel(child.id)),
              Effect.ensuring(
                Effect.sync(() => {
                  running.delete(child.id)
                }),
              ),
            )

          const result = yield* stepTimeout > 0
            ? turn.pipe(
                Effect.timeoutOrElse({
                  duration: Duration.seconds(stepTimeout),
                  orElse: () => Effect.fail(new Error(`step timed out after ${stepTimeout}s`)),
                }),
              )
            : turn

          if (result.info.role === "assistant" && result.info.error) {
            const err = result.info.error
            const detail = "message" in err.data && err.data.message ? err.data.message : err.name
            if (isTransientError(err)) return yield* Effect.fail(new TransientStepError(detail))
            return yield* Effect.fail(new Error(detail))
          }

          return result.parts.findLast((item) => item.type === "text")?.text ?? ""
        })

        // Retry transient failures with exponential backoff (2s, 4s, 8s, …).
        // Non-transient failures propagate immediately.
        const withRetry = (attemptIndex: number): Effect.Effect<string> =>
          attempt().pipe(
            Effect.catchIf(
              (error): error is TransientStepError => error instanceof TransientStepError && attemptIndex < retries,
              () =>
                Effect.sleep(Duration.seconds(2 ** (attemptIndex + 1))).pipe(
                  Effect.andThen(withRetry(attemptIndex + 1)),
                ),
            ),
          )

        return yield* withRetry(0)
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
          ...(plan ? { plan } : {}),
        } satisfies Metadata,
        output: renderOutput({ description: params.description, steps, states, results, plan }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      formatValidationError: () =>
        'workflow.steps must be a list; each item is a string, an array of strings, or an object with a "prompt". ' +
        'Example: {"description":"x","steps":["do a","do b"]}',
      execute: (params: Params, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function renderCause(cause: Cause.Cause<unknown>) {
  const squashed = Cause.squash(cause)
  const message = squashed instanceof Error ? squashed.message : String(squashed)
  return message.length > 0 ? message : "step failed"
}
