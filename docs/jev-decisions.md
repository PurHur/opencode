# Jev decisions in opencode

This fork adds a native `decide` tool that calls **Jev**, TypeSafe's "System One"
decision model, through the Experiential Labs gateway
(`https://platform.experientiallabs.ai/models/jev-latest`).

Jev is **not a chat model**. It cannot write code, stream, or call tools. It takes a
piece of `state` plus typed questions and returns calibrated probabilities. That makes
it a poor choice as the main model for an agent, but a very good, very cheap second
opinion. So the setup is:

| Role | Model | Cost |
| --- | --- | --- |
| Chat / agent loop / tool calls | any OpenCode Zen `*-free` model (no login needed) | free |
| Decisions (`decide` tool) | `jev-latest` via Experiential Labs | free tier |

## Quick start

```sh
# 1. key for the decision model (Experiential Labs gateway key)
export EXPERIENTIAL_API_KEY=xpl_...

# 2. run with a free chat model
opencode -m opencode/minimax-m2.5-free
```

Or make it permanent in `opencode.json` (see `examples/jev-free.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/minimax-m2.5-free",
  "small_model": "opencode/minimax-m2.5-free"
}
```

Instead of the environment variable you can store the key with
`opencode auth login` → *Other* → provider id `experiential`, or put it in config:

```jsonc
{
  "provider": {
    "experiential": {
      "options": {
        "apiKey": "{env:EXPERIENTIAL_API_KEY}",
        "baseURL": "https://api.experientiallabs.ai/v1", // optional
        "decisionModel": "jev-latest" // optional
      }
    }
  }
}
```

The `decide` tool only appears in the tool list when a key resolves. Precedence:

| Setting | Order |
| --- | --- |
| key | `EXPERIENTIAL_API_KEY` → auth store entry `experiential` → `provider.experiential.options.apiKey` → `TYPESAFE_API_KEY` |
| base URL | `EXPERIENTIAL_BASE_URL` → `provider.experiential.options.baseURL` → gateway default (TypeSafe host if only `TYPESAFE_API_KEY` is set) |
| model | `OPENCODE_DECIDE_MODEL` → `provider.experiential.options.decisionModel` → `jev-latest` |

## The `decide` tool

```jsonc
{
  "state": "<diff, log, spec, list of candidates, or a JSON object>",
  "questions": {
    "risky": { "type": "noul", "instructions": "Is this change risky to merge?" },
    "action": {
      "type": "choice",
      "instructions": "What should happen next?",
      "criteria": { "merge": "Safe to merge", "fix": "Needs changes", "ask": "Ask the user" }
    },
    "quality": {
      "type": "score",
      "instructions": "How well does the output meet the spec?",
      "criteria": ["misses the point", "partially", "fully"]
    }
  }
}
```

| Type | `criteria` | Answer |
| --- | --- | --- |
| `noul` | optional `{"true": "...", "false": "..."}` | `noul`: probability the answer is yes |
| `choice` | required object `{option: description \| null}`, ≥ 2 options | `choice`, `probabilities`, `confidence` |
| `score` | required array of ≥ 2 level descriptions, lowest first | `score` (0 … N-1), `probabilities`, `confidence`, `legend` |

The tool output is a short line per answer followed by the raw `answers` JSON, so both
small and large chat models can read it:

```
Decisions from jev-latest:
- risky: noul=0.59 (probability the answer is yes)
- action: choice=fix confidence=0.91 [fix 0.95, merge 0.04, ask 0.01]
- quality: score=1.04 (0..2) confidence=0.71 [1 "partially" 0.80, 2 "fully" 0.12, 0 "misses the point" 0.08]
```

Behaviour:

- Questions are validated locally before any request (choice needs object criteria,
  score needs ≥ 2 levels, noul criteria only `true`/`false`).
- Gateway 5xx / 429 / timeouts are retried up to 3 times with backoff. The gateway
  does return sporadic `502`s.
- 4xx errors are surfaced with the gateway's message and are not retried.
- Permission id is `decide` (allowed by default; set `permission.decide: "ask"` to
  confirm each call).
- `state` is capped at 120k characters; TypeSafe documents roughly 32k tokens shared
  by state and questions.

## Using the Experiential gateway for chat too (optional, paid)

The same key also fronts an OpenAI-compatible `/v1/chat/completions` endpoint with
tool calling. If you want to route chat through it instead of a free Zen model,
declare the models you want:

```jsonc
{
  "provider": {
    "experiential": {
      "name": "Experiential Labs",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://api.experientiallabs.ai/v1", "apiKey": "{env:EXPERIENTIAL_API_KEY}" },
      "models": {
        "claude-haiku-4.5": { "name": "Claude Haiku 4.5 (Experiential)", "tool_call": true, "limit": { "context": 200000, "output": 8192 } }
      }
    }
  },
  "model": "experiential/claude-haiku-4.5"
}
```

`jev-latest` must **not** be listed as a chat model: the gateway rejects it with
`unsupported_capability`. It is only reachable through the `decide` tool.

## Development

- Source: `packages/opencode/src/tool/decide.ts`, description `decide.txt`, wiring in `tool/registry.ts`.
- Tests: `bun test test/tool/decide.test.ts test/tool/parameters.test.ts test/tool/registry.test.ts` from `packages/opencode`.
- Typecheck: `bun tsgo --noEmit` in `packages/opencode`.
- Build a single binary: `cd packages/opencode && bun run script/build.ts --single --skip-embed-web-ui --skip-install`.
