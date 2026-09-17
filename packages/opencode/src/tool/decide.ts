import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { Env } from "@/env"
import * as Tool from "./tool"
import DESCRIPTION from "./decide.txt"

/**
 * `decide` calls a TypeSafe "System One" decision model (Jev) through the
 * Experiential Labs gateway. Jev is not a chat model: it takes `state` plus
 * typed questions (noul / choice / score) and returns calibrated
 * probabilities. The chat model driving the session stays whatever the user
 * configured (e.g. a free OpenCode Zen model); this tool just gives it a
 * cheap, structured second opinion.
 */

export const PROVIDER_ID = "experiential"
export const DEFAULT_MODEL = "jev-latest"
export const DEFAULT_URL = "https://api.experientiallabs.ai/v1"
export const TYPESAFE_URL = "https://api.typesafe.ai/v1"

const TIMEOUT_MS = 60_000
const MAX_ATTEMPTS = 3
const MAX_STATE_CHARS = 120_000
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

const Criteria = Schema.Union([
  Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  Schema.Array(Schema.String),
])

export const Question = Schema.Struct({
  type: Schema.Literals(["noul", "choice", "score"]).annotate({
    description: '"noul" = yes/no probability, "choice" = pick one option, "score" = rate on an ordered rubric',
  }),
  instructions: Schema.String.annotate({
    description: "The question to evaluate against the state, phrased as a single clear judgment",
  }),
  criteria: Schema.optional(Criteria).annotate({
    description:
      'choice: REQUIRED object {option: description|null}. score: REQUIRED array of >=2 level descriptions, lowest first. noul: optional {"true": "...", "false": "..."}',
  }),
})

export const Parameters = Schema.Struct({
  state: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]).annotate({
    description:
      "The content to judge: a diff, log, spec, file, list of candidates, or a JSON object. Everything the decision needs must be in here",
  }),
  questions: Schema.Record(Schema.String, Question).annotate({
    description:
      'Map of question id -> question. Ids are yours; answers come back under the same ids. Example: {"risky": {"type": "noul", "instructions": "Is this change risky to merge?"}}',
  }),
  model: Schema.optional(Schema.String).annotate({
    description: 'Decision model id. Defaults to the configured model ("jev-latest"). Rarely needed.',
  }),
})

export type Params = Schema.Schema.Type<typeof Parameters>
export type QuestionInput = Schema.Schema.Type<typeof Question>

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | {
      type: "score"
      score: number
      confidence?: number
      legend?: Record<string, string>
      probabilities?: Record<string, number>
    }

export type Response = {
  id?: string
  model?: string
  answers: Record<string, Answer>
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
}

export type Target = {
  /** Base URL, without trailing slash. `/systemone` is appended. */
  url: string
  key: string
  model: string
  /** Where the key came from, for diagnostics. */
  source: string
}

type Metadata = {
  model: string
  answers?: Record<string, Answer>
  usage?: Response["usage"]
  attempts?: number
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function trimSlash(url: string) {
  return url.replace(/\/+$/, "")
}

/**
 * Pure credential/model resolution so it can be unit tested. Precedence:
 *   key:   EXPERIENTIAL_API_KEY env > `opencode auth login` entry for
 *          provider "experiential" > provider.experiential.options.apiKey
 *          > TYPESAFE_API_KEY env (then the TypeSafe API host is used)
 *   url:   EXPERIENTIAL_BASE_URL env > provider.experiential.options.baseURL
 *          > gateway default (or TypeSafe host when only TYPESAFE_API_KEY is set)
 *   model: OPENCODE_DECIDE_MODEL env > provider.experiential.options.decisionModel > "jev-latest"
 */
export function resolveTarget(input: {
  env: Record<string, string | undefined>
  auth?: Auth.Info
  options?: Record<string, unknown>
}): Target | undefined {
  const opts = input.options ?? {}
  const model = str(input.env.OPENCODE_DECIDE_MODEL) ?? str(opts.decisionModel) ?? DEFAULT_MODEL
  const url = str(input.env.EXPERIENTIAL_BASE_URL) ?? str(opts.baseURL)

  const fromEnv = str(input.env.EXPERIENTIAL_API_KEY)
  if (fromEnv) return { url: trimSlash(url ?? DEFAULT_URL), key: fromEnv, model, source: "EXPERIENTIAL_API_KEY" }

  const fromAuth = input.auth?.type === "api" ? str(input.auth.key) : undefined
  if (fromAuth) return { url: trimSlash(url ?? DEFAULT_URL), key: fromAuth, model, source: "auth.json" }

  const fromConfig = str(opts.apiKey)
  if (fromConfig) return { url: trimSlash(url ?? DEFAULT_URL), key: fromConfig, model, source: "config" }

  const typesafe = str(input.env.TYPESAFE_API_KEY)
  if (typesafe) return { url: trimSlash(url ?? TYPESAFE_URL), key: typesafe, model, source: "TYPESAFE_API_KEY" }

  return undefined
}

export const resolve = Effect.fn("Decide.resolve")(function* (input: {
  config: Config.Interface
  auth: Auth.Interface
  env: Env.Interface
}) {
  const cfg = yield* input.config.get()
  const options = cfg.provider?.[PROVIDER_ID]?.options as Record<string, unknown> | undefined
  const stored = yield* input.auth.get(PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
  const env = yield* input.env.all()
  return resolveTarget({ env, auth: stored, options })
})

export function validateQuestions(questions: Record<string, QuestionInput>): string[] {
  const errors: string[] = []
  const entries = Object.entries(questions)
  if (entries.length === 0) errors.push("questions must contain at least one entry")
  for (const [id, q] of entries) {
    if (!q.instructions?.trim()) errors.push(`${id}: instructions must be a non-empty string`)
    const criteria = q.criteria
    switch (q.type) {
      case "choice": {
        if (!criteria || Array.isArray(criteria)) {
          errors.push(`${id}: choice questions need "criteria" as an object {option: description}`)
          break
        }
        if (Object.keys(criteria).length < 2) errors.push(`${id}: choice questions need at least two options`)
        break
      }
      case "score": {
        if (!criteria || !Array.isArray(criteria)) {
          errors.push(`${id}: score questions need "criteria" as an array of level descriptions`)
          break
        }
        if (criteria.length < 2) errors.push(`${id}: score questions need at least two levels`)
        break
      }
      case "noul": {
        if (criteria && Array.isArray(criteria)) {
          errors.push(`${id}: noul criteria must be an object with "true" and/or "false" keys, not an array`)
          break
        }
        if (criteria) {
          const extra = Object.keys(criteria).filter((k) => k !== "true" && k !== "false")
          if (extra.length) errors.push(`${id}: noul criteria only accept "true" and "false" keys (got ${extra.join(", ")})`)
        }
        break
      }
    }
  }
  return errors
}

function fmt(n: number | undefined) {
  return typeof n === "number" ? n.toFixed(2) : "?"
}

function fmtProbabilities(p: Record<string, number> | undefined, legend?: Record<string, string>) {
  if (!p) return ""
  const parts = Object.entries(p)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => (legend?.[k] ? `${k} "${legend[k]}" ${fmt(v)}` : `${k} ${fmt(v)}`))
  return `[${parts.join(", ")}]`
}

export function formatAnswers(answers: Record<string, Answer>): string[] {
  return Object.entries(answers).map(([id, a]) => {
    switch (a.type) {
      case "noul":
        return `- ${id}: noul=${fmt(a.noul)} (probability the answer is yes)`
      case "choice":
        return `- ${id}: choice=${a.choice} confidence=${fmt(a.confidence)} ${fmtProbabilities(a.probabilities)}`
      case "score": {
        const levels = a.legend ? Object.keys(a.legend).length : a.probabilities ? Object.keys(a.probabilities).length : 0
        const range = levels > 0 ? ` (0..${levels - 1})` : ""
        return `- ${id}: score=${fmt(a.score)}${range} confidence=${fmt(a.confidence)} ${fmtProbabilities(a.probabilities, a.legend)}`
      }
      default:
        return `- ${id}: ${JSON.stringify(a)}`
    }
  })
}

function parseResponse(text: string): Response {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Decision API returned non-JSON body: ${text.slice(0, 300)}`)
  }
  if (!data || typeof data !== "object" || typeof (data as Response).answers !== "object") {
    throw new Error(`Decision API response has no "answers" object: ${text.slice(0, 300)}`)
  }
  return data as Response
}

function apiErrorMessage(status: number, text: string) {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } | string }
    const err = parsed.error
    if (typeof err === "string") return `Decision API error (HTTP ${status}): ${err}`
    if (err?.message) return `Decision API error (HTTP ${status}${err.code ? `, ${err.code}` : ""}): ${err.message}`
  } catch {}
  return `Decision API error (HTTP ${status}): ${text.slice(0, 300) || "empty body"}`
}

function describeError(err: unknown) {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
  return String(err)
}

export const NO_CREDENTIALS =
  `No credentials for the decision model. Set EXPERIENTIAL_API_KEY, run "opencode auth login" and add provider id "${PROVIDER_ID}", ` +
  `or set provider.${PROVIDER_ID}.options.apiKey in opencode.json (TYPESAFE_API_KEY is also accepted).`

export const DecideTool = Tool.define<
  typeof Parameters,
  Metadata,
  HttpClient.HttpClient | Config.Service | Auth.Service | Env.Service
>(
  "decide",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const env = yield* Env.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      formatValidationError: () =>
        'Expected {"state": string|object, "questions": {"<id>": {"type": "noul"|"choice"|"score", "instructions": string, "criteria"?: object|array}}}. ' +
        "choice needs criteria as an object of options; score needs criteria as an array of >=2 levels.",
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const target = yield* resolve({ config, auth, env })
          if (!target) throw new Error(NO_CREDENTIALS)

          const problems = validateQuestions(params.questions)
          if (problems.length) throw new Error(`Invalid questions:\n${problems.map((p) => `- ${p}`).join("\n")}`)

          const stateText = typeof params.state === "string" ? params.state : JSON.stringify(params.state)
          if (stateText.length > MAX_STATE_CHARS) {
            throw new Error(
              `state is ${stateText.length} characters; keep it under ${MAX_STATE_CHARS} (the model reads roughly 30k tokens)`,
            )
          }

          const model = params.model ?? target.model
          const ids = Object.keys(params.questions)

          yield* ctx.ask({
            permission: "decide",
            patterns: [model],
            always: ["*"],
            metadata: { model, questions: ids },
          })

          const body = { model, state: params.state, questions: params.questions }
          const request = yield* HttpClientRequest.post(`${target.url}/systemone`).pipe(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${target.key}`,
              accept: "application/json",
              "user-agent": "opencode-decide",
            }),
            HttpClientRequest.bodyJson(body),
            Effect.orDie,
          )

          const once = Effect.gen(function* () {
            const response = yield* http.execute(request)
            const text = yield* response.text
            return { status: response.status, text }
          }).pipe(
            Effect.timeoutOrElse({
              duration: TIMEOUT_MS,
              orElse: () => Effect.succeed({ status: 0, text: `request timed out after ${TIMEOUT_MS / 1000}s` }),
            }),
            Effect.catch((err) => Effect.succeed({ status: 0, text: describeError(err) })),
          )

          let attempts = 0
          let last = { status: 0, text: "" }
          while (attempts < MAX_ATTEMPTS) {
            if (ctx.abort.aborted) throw new Error("decide aborted")
            attempts++
            last = yield* once
            if (last.status >= 200 && last.status < 300) break
            const retryable = last.status === 0 || RETRYABLE.has(last.status)
            if (!retryable || attempts >= MAX_ATTEMPTS) break
            yield* Effect.sleep(`${500 * 2 ** (attempts - 1)} millis`)
          }

          if (last.status < 200 || last.status >= 300) {
            const suffix = attempts > 1 ? ` (after ${attempts} attempts)` : ""
            throw new Error(apiErrorMessage(last.status, last.text) + suffix)
          }

          const parsed = parseResponse(last.text)
          const lines = formatAnswers(parsed.answers)
          const usage = parsed.usage
          const usageLine = usage
            ? `usage: ${usage.input_tokens ?? "?"} in / ${usage.output_tokens ?? "?"} out tokens${
                typeof usage.cost === "number" ? `, cost ${usage.cost}` : ""
              }`
            : undefined

          return {
            title: `${ids.length} decision${ids.length === 1 ? "" : "s"} via ${parsed.model ?? model}`,
            output: [
              `Decisions from ${parsed.model ?? model}:`,
              ...lines,
              "",
              "answers (JSON):",
              JSON.stringify(parsed.answers, null, 2),
              ...(usageLine ? ["", usageLine] : []),
            ].join("\n"),
            metadata: {
              model: parsed.model ?? model,
              answers: parsed.answers,
              usage,
              attempts,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
