# Running opencode-fork with a small / local model

This fork's native orchestration (`workflow`, `agent_create`, `goal`, `task`)
works with a small or local model — a quantized 20-30B served by llama.cpp,
vLLM, or any OpenAI-compatible endpoint — if you tune a few things and keep the
tool calls simple. This guide covers the setup and the one hazard that trips
people up most.

For the tools themselves, see [`native-orchestration.md`](./native-orchestration.md).
A ready-to-adapt config lives in
[`../examples/small-model-config.jsonc`](../examples/small-model-config.jsonc).

## 1. Point opencode-fork at a local llama.cpp

Start the server (llama.cpp's `llama-server` here) with a real context window and
tool-call support, then describe it to opencode as a custom provider using the
generic OpenAI-compatible adapter:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "llama.cpp/<MODEL>",
  "small_model": "llama.cpp/<MODEL>",
  "provider": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llama.cpp (local)",
      "options": { "baseURL": "http://127.0.0.1:8081/v1", "apiKey": "local" },
      "models": {
        "<MODEL>": {
          "name": "My local 30B (Q4)",
          "reasoning": true,
          "tool_call": true,
          "temperature": true,
          "limit": { "context": 262144, "output": 32768 },
          "interleaved": { "field": "reasoning_content" }
        }
      }
    }
  }
}
```

Point `baseURL` at your server's `/v1` endpoint, set `limit.context` to the
window you actually launched with, and set `interleaved.field` to whatever field
your build returns reasoning tokens in (`reasoning_content` is common; drop the
block if reasoning arrives inline). See the example config for a comment on every
key.

## 2. The one hazard: a single-slot server serializes subagents

The failure that surprises people: **a `workflow` fans out several subagents, but
your llama.cpp was launched with `--parallel 1`, so the server can only decode one
request at a time.** The subagents do not run in parallel — they queue. Six
"parallel" steps become six sequential steps plus scheduling overhead, and the
run looks hung.

There is nothing to fix in config; it is a server property. Handle it two ways:

- **Keep workflow `concurrency` low** — `2` on a single-slot server, `2-3` if you
  launched llama.cpp with `--parallel 3` (matching the slot count). Running eight
  subagents against one slot just thrashes.
- If you genuinely want parallelism, launch the server with more slots
  (`--parallel N`) and enough context per slot, then raise `concurrency` toward
  `N`. `concurrency` is a workflow tool argument, not a config key (see §4).

## 3. Use a genuinely tool-call-capable model

Native orchestration is built on tool calls. The model must reliably emit valid
tool-call JSON, so set `"tool_call": true` only for a model that actually does it.

Two practical notes:

- **Heavily-abliterated / "uncensored" fine-tunes often derail on nested tool
  schemas.** They may advertise tool support but produce malformed arguments when
  a tool takes a structured object (the workflow graph form, `agent_create`
  payloads). If you must use one, prefer the **workflow string-list form** (§5) —
  a flat list of plain-string steps is the lowest-ceremony call and asks the least
  of the model's JSON discipline.
- If the model has a reasoning channel, set `reasoning: true` and the correct
  `interleaved` field so its thinking is parsed out of the tool-call stream rather
  than corrupting it.

## 4. Workflow tuning happens at call time, not in config

`concurrency`, `retries`, and `step_timeout_seconds` are **arguments to the
`workflow` tool**, passed per call — they are NOT config keys, so do not add them
to your config file. The model sets them when it invokes a workflow; you steer it
via your prompt ("run the workflow with concurrency 2"). Defaults and limits, from
the workflow tool schema:

| Argument | Default | Max | What to use on a small/local model |
| --- | --- | --- | --- |
| `concurrency` | 4 | 8 | `2` on a single slot; match your `--parallel` count otherwise |
| `retries` | 2 | 5 | Keep `2`. Retries only fire on *transient* errors (model still loading, 503, overloaded, connection reset, timeout) — exactly the flakiness a cold local server produces |
| `step_timeout_seconds` | 0 (no limit) | 3600 | Set e.g. `300` so one wedged step is cancelled and marked a timeout instead of hanging the whole run. Local decode is slow — do not set this too tight |

The only orchestration-related **config** key is `subagent_depth` (default `1`).
Set it to `2` if you want a subagent to itself start a workflow or task, since a
workflow launched from inside a subagent counts as one level of nesting.

## 5. Watching a workflow run

When a workflow runs, the TUI shows it as an **inline live block** under the tool
call. Each step shows a state (`pending` -> `running` -> `done` / `error` /
`skipped`) that updates as it goes, and **each step is clickable** — selecting it
opens that subagent's own session so you can watch its output live and read the
full transcript, not just the truncated result that flows back to the parent. On a
slow local model this is the best way to tell a long-running step apart from a
stuck one.

## 6. Copy-paste workflow examples (string-list form)

Prefer the plain string-list form on a small model: no ids, no `depends_on`, and
each step automatically receives the previous step's result.

A straight research pipeline:

```json
{
  "description": "research a library",
  "steps": [
    "Find the three most popular Rust web frameworks and note their GitHub stars and last release date",
    "For each framework, summarize routing, middleware, and async support",
    "Recommend one for a small team building a JSON API, with a short justification"
  ]
}
```

A fan-out then join — the inner array runs in parallel (keep it within your slot
count), and the final step receives all three results:

```json
{
  "description": "audit codebase",
  "steps": [
    [
      "Audit the auth and session code for security issues; list file:line and severity",
      "Audit error handling and logging for gaps; list file:line",
      "Audit the test suite for missing coverage; list what is untested"
    ],
    "Merge the three audits into one prioritized report, highest severity first, with concrete fixes"
  ]
}
```

Tips that matter most on a weak model:

- Keep steps few and concrete (3-5). Each step is a fresh subagent with no memory
  of the others, so put every path, constraint, and output format in its text.
- Do not restate a previous step's output in the next prompt — the string list
  forwards it automatically.
- Keep `concurrency` at or below your server's slot count (§2).
