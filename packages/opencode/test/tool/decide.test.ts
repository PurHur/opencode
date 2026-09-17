import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { Env } from "@/env"
import {
  type Answer,
  DecideTool,
  DEFAULT_MODEL,
  DEFAULT_URL,
  NO_CREDENTIALS,
  TYPESAFE_URL,
  formatAnswers,
  resolveTarget,
  validateQuestions,
} from "../../src/tool/decide"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"
import { testInstanceStoreLayer } from "../fixture/fixture"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node, Config.node, Auth.node, Env.node]), [
      [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
    ]),
    testInstanceStoreLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const ENV_KEYS = [
  "EXPERIENTIAL_API_KEY",
  "EXPERIENTIAL_BASE_URL",
  "TYPESAFE_API_KEY",
  "OPENCODE_DECIDE_MODEL",
  "OPENCODE_AUTH_CONTENT",
]

const withEnv = <A, E, R>(env: Record<string, string>, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
      for (const k of ENV_KEYS) delete process.env[k]
      // keep the machine's real auth.json out of the picture
      process.env.OPENCODE_AUTH_CONTENT = "{}"
      Object.assign(process.env, env)
      return saved
    }),
    () => self,
    (saved) =>
      Effect.sync(() => {
        for (const k of ENV_KEYS) {
          if (saved[k] === undefined) delete process.env[k]
          else process.env[k] = saved[k]
        }
      }),
  )

const withServer = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url.toString().replace(/\/$/, "")),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("DecideToolTest.exec")(function* (args: Tool.InferParameters<typeof DecideTool>) {
  const info = yield* DecideTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const sample: { answers: Record<string, Answer>; model: string; usage: Record<string, number> } = {
  answers: {
    risky: { type: "noul", noul: 0.59 },
    action: {
      type: "choice",
      choice: "request_changes",
      confidence: 0.91,
      probabilities: { approve: 0.04, escalate: 0.01, request_changes: 0.95 },
    },
    quality: {
      type: "score",
      score: 1.04,
      confidence: 0.71,
      legend: { "0": "tests preserved", "1": "migration safety", "2": "clarity" },
      probabilities: { "0": 0.08, "1": 0.8, "2": 0.12 },
    },
  },
  model: "jev-latest",
  usage: { input_tokens: 401, output_tokens: 73, cost: 0 },
}

const questions = {
  risky: { type: "noul" as const, instructions: "Is this PR risky?" },
  action: {
    type: "choice" as const,
    instructions: "What should the reviewer do?",
    criteria: { approve: "Approve", request_changes: "Ask for changes", escalate: null },
  },
  quality: {
    type: "score" as const,
    instructions: "Rate the PR",
    criteria: ["tests preserved", "migration safety", "clarity"],
  },
}

describe("decide.resolveTarget", () => {
  test("returns undefined when nothing is configured", () => {
    expect(resolveTarget({ env: {} })).toBeUndefined()
  })

  test("env key wins over auth store and config", () => {
    const target = resolveTarget({
      env: { EXPERIENTIAL_API_KEY: "env-key" },
      auth: { type: "api", key: "auth-key" },
      options: { apiKey: "cfg-key" },
    })
    expect(target).toEqual({ url: DEFAULT_URL, key: "env-key", model: DEFAULT_MODEL, source: "EXPERIENTIAL_API_KEY" })
  })

  test("auth store wins over config", () => {
    const target = resolveTarget({ env: {}, auth: { type: "api", key: "auth-key" }, options: { apiKey: "cfg-key" } })
    expect(target?.key).toBe("auth-key")
    expect(target?.source).toBe("auth.json")
  })

  test("config key and options are honoured", () => {
    const target = resolveTarget({
      env: {},
      options: { apiKey: "cfg-key", baseURL: "https://gw.example/v1/", decisionModel: "jev-next" },
    })
    expect(target).toEqual({ url: "https://gw.example/v1", key: "cfg-key", model: "jev-next", source: "config" })
  })

  test("falls back to TYPESAFE_API_KEY on the TypeSafe host", () => {
    const target = resolveTarget({ env: { TYPESAFE_API_KEY: "ts-key" } })
    expect(target).toEqual({ url: TYPESAFE_URL, key: "ts-key", model: DEFAULT_MODEL, source: "TYPESAFE_API_KEY" })
  })

  test("env overrides for url and model beat config", () => {
    const target = resolveTarget({
      env: { EXPERIENTIAL_API_KEY: "k", EXPERIENTIAL_BASE_URL: "http://localhost:1/v1", OPENCODE_DECIDE_MODEL: "m" },
      options: { baseURL: "https://gw.example/v1", decisionModel: "jev-next" },
    })
    expect(target?.url).toBe("http://localhost:1/v1")
    expect(target?.model).toBe("m")
  })

  test("ignores oauth auth entries", () => {
    expect(
      resolveTarget({ env: {}, auth: { type: "oauth", refresh: "r", access: "a", expires: 0 } as any }),
    ).toBeUndefined()
  })
})

describe("decide.validateQuestions", () => {
  test("accepts a well-formed set", () => {
    expect(validateQuestions(questions)).toEqual([])
  })

  test("rejects empty questions", () => {
    expect(validateQuestions({})).toEqual(["questions must contain at least one entry"])
  })

  test("choice needs object criteria with two options", () => {
    expect(validateQuestions({ a: { type: "choice", instructions: "x" } })[0]).toContain("choice questions need")
    expect(validateQuestions({ a: { type: "choice", instructions: "x", criteria: ["a", "b"] } })[0]).toContain("object")
    expect(validateQuestions({ a: { type: "choice", instructions: "x", criteria: { only: "one" } } })[0]).toContain(
      "two options",
    )
  })

  test("score needs array criteria with two levels", () => {
    expect(validateQuestions({ a: { type: "score", instructions: "x" } })[0]).toContain("array")
    expect(validateQuestions({ a: { type: "score", instructions: "x", criteria: { a: "b" } } })[0]).toContain("array")
    expect(validateQuestions({ a: { type: "score", instructions: "x", criteria: ["one"] } })[0]).toContain("two levels")
  })

  test("noul criteria must be true/false object", () => {
    expect(validateQuestions({ a: { type: "noul", instructions: "x", criteria: ["y"] } })[0]).toContain("not an array")
    expect(validateQuestions({ a: { type: "noul", instructions: "x", criteria: { yes: "y" } } })[0]).toContain(
      'only accept "true" and "false"',
    )
    expect(validateQuestions({ a: { type: "noul", instructions: "x", criteria: { true: "y", false: "n" } } })).toEqual(
      [],
    )
  })

  test("rejects blank instructions", () => {
    expect(validateQuestions({ a: { type: "noul", instructions: "  " } })[0]).toContain("non-empty")
  })
})

describe("decide.formatAnswers", () => {
  test("renders one line per answer with probabilities sorted", () => {
    const lines = formatAnswers(sample.answers)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe("- risky: noul=0.59 (probability the answer is yes)")
    expect(lines[1]).toBe(
      "- action: choice=request_changes confidence=0.91 [request_changes 0.95, approve 0.04, escalate 0.01]",
    )
    expect(lines[2]).toBe(
      '- quality: score=1.04 (0..2) confidence=0.71 [1 "migration safety" 0.80, 2 "clarity" 0.12, 0 "tests preserved" 0.08]',
    )
  })
})

describe("tool.decide", () => {
  it.instance("posts state and questions to /systemone and formats the answers", () =>
    Effect.gen(function* () {
      const seen: { auth?: string | null; body?: any; path?: string } = {}
      yield* withServer(
        async (req) => {
          seen.auth = req.headers.get("authorization")
          seen.path = new URL(req.url).pathname
          seen.body = await req.json()
          return Response.json(sample)
        },
        (url) =>
          withEnv(
            { EXPERIENTIAL_API_KEY: "test-key", EXPERIENTIAL_BASE_URL: `${url}/v1` },
            Effect.gen(function* () {
              const result = yield* exec({ state: "PR deletes a test and edits a migration", questions })
              expect(seen.path).toBe("/v1/systemone")
              expect(seen.auth).toBe("Bearer test-key")
              expect(seen.body.model).toBe("jev-latest")
              expect(seen.body.state).toBe("PR deletes a test and edits a migration")
              expect(seen.body.questions).toEqual(questions)
              expect(result.title).toBe("3 decisions via jev-latest")
              expect(result.output).toContain("- risky: noul=0.59")
              expect(result.output).toContain("- action: choice=request_changes confidence=0.91")
              expect(result.output).toContain("usage: 401 in / 73 out tokens")
              expect(result.metadata.answers).toEqual(sample.answers)
              expect(result.metadata.attempts).toBe(1)
            }),
          ),
      )
    }),
  )

  it.instance("sends structured state as JSON and honours the model override", () =>
    Effect.gen(function* () {
      let body: any
      yield* withServer(
        async (req) => {
          body = await req.json()
          return Response.json({ model: "jev-next", answers: { ok: { type: "noul", noul: 1 } } })
        },
        (url) =>
          withEnv(
            { EXPERIENTIAL_API_KEY: "k", EXPERIENTIAL_BASE_URL: url },
            Effect.gen(function* () {
              const result = yield* exec({
                state: { files: ["a.ts", "b.ts"], failing: true },
                questions: { ok: { type: "noul", instructions: "Is it fine?" } },
                model: "jev-next",
              })
              expect(body.model).toBe("jev-next")
              expect(body.state).toEqual({ files: ["a.ts", "b.ts"], failing: true })
              expect(result.title).toBe("1 decision via jev-next")
              expect(result.metadata.model).toBe("jev-next")
            }),
          ),
      )
    }),
  )

  it.instance("retries transient gateway errors and then succeeds", () =>
    Effect.gen(function* () {
      let calls = 0
      yield* withServer(
        () => {
          calls++
          if (calls < 3) return new Response("error code: 502", { status: 502 })
          return Response.json(sample)
        },
        (url) =>
          withEnv(
            { EXPERIENTIAL_API_KEY: "k", EXPERIENTIAL_BASE_URL: url },
            Effect.gen(function* () {
              const result = yield* exec({ state: "x", questions })
              expect(calls).toBe(3)
              expect(result.metadata.attempts).toBe(3)
            }),
          ),
      )
    }),
  )

  it.instance("gives up after three transient failures with the gateway message", () =>
    Effect.gen(function* () {
      let calls = 0
      yield* withServer(
        () => {
          calls++
          return new Response("error code: 502", { status: 502 })
        },
        (url) =>
          withEnv(
            { EXPERIENTIAL_API_KEY: "k", EXPERIENTIAL_BASE_URL: url },
            Effect.gen(function* () {
              const exit = yield* exec({ state: "x", questions }).pipe(Effect.exit)
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) {
                const message = Cause.prettyErrors(exit.cause)[0]?.message ?? ""
                expect(message).toContain("HTTP 502")
                expect(message).toContain("after 3 attempts")
              }
              expect(calls).toBe(3)
            }),
          ),
      )
    }),
  )

  it.instance("does not retry client errors and surfaces the API message", () =>
    Effect.gen(function* () {
      let calls = 0
      yield* withServer(
        () => {
          calls++
          return Response.json(
            { error: { message: "This TypeSafe model supports native decisions, not chat.", code: "unsupported" } },
            { status: 400 },
          )
        },
        (url) =>
          withEnv(
            { EXPERIENTIAL_API_KEY: "k", EXPERIENTIAL_BASE_URL: url },
            Effect.gen(function* () {
              const exit = yield* exec({ state: "x", questions }).pipe(Effect.exit)
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) {
                const message = Cause.prettyErrors(exit.cause)[0]?.message ?? ""
                expect(message).toContain("HTTP 400, unsupported")
                expect(message).toContain("native decisions, not chat")
              }
              expect(calls).toBe(1)
            }),
          ),
      )
    }),
  )

  it.instance("rejects malformed questions before calling the API", () =>
    Effect.gen(function* () {
      let calls = 0
      yield* withServer(
        () => {
          calls++
          return Response.json(sample)
        },
        (url) =>
          withEnv(
            { EXPERIENTIAL_API_KEY: "k", EXPERIENTIAL_BASE_URL: url },
            Effect.gen(function* () {
              const exit = yield* exec({
                state: "x",
                questions: { pick: { type: "choice", instructions: "which?" } },
              }).pipe(Effect.exit)
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) {
                expect(Cause.prettyErrors(exit.cause)[0]?.message ?? "").toContain("choice questions need")
              }
              expect(calls).toBe(0)
            }),
          ),
      )
    }),
  )

  it.instance("fails with guidance when no credentials are configured", () =>
    withEnv(
      {},
      Effect.gen(function* () {
        const exit = yield* exec({ state: "x", questions }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.prettyErrors(exit.cause)[0]?.message ?? "").toBe(NO_CREDENTIALS)
        }
      }),
    ),
  )

  it.instance(
    "reads the key from provider.experiential.options in config",
    () =>
      Effect.gen(function* () {
        let auth: string | null = null
        yield* withServer(
          (req) => {
            auth = req.headers.get("authorization")
            return Response.json(sample)
          },
          (url) =>
            withEnv(
              { EXPERIENTIAL_BASE_URL: url },
              Effect.gen(function* () {
                yield* exec({ state: "x", questions })
                expect(auth).toBe("Bearer from-config")
              }),
            ),
        )
      }),
    { config: { provider: { experiential: { options: { apiKey: "from-config" } } } } },
  )
})
