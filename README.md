# opencode — native orchestration fork

A fork of **[sst/opencode](https://github.com/sst/opencode)**. For everything about
opencode itself (install, usage, config, providers, TUI, SDK), see the **[original
README](https://github.com/sst/opencode#readme)** and **[opencode.ai/docs](https://opencode.ai/docs)**.

This document only covers **what this fork adds or changes.** The goal of the fork
is to make dynamic, multi-agent workflows work well — including with small / local
models served over an OpenAI-compatible endpoint (e.g. a quantized model under
llama.cpp).

Everything below is implemented natively (built-in tools + TUI rendering), not via
plugins. Full guides:

- **[docs/native-orchestration.md](docs/native-orchestration.md)** — the three new tools, with copy-paste examples
- **[docs/small-model-guide.md](docs/small-model-guide.md)** — running the fork against a small / local model
- **[examples/](examples/)** — a tuned `small-model-config.jsonc` and ready-made `opencode-commands/`

---

## What's new

### 1. `workflow` — deterministic multi-agent workflows

Runs several subagent steps as one workflow, each in its own fresh subagent session,
in parallel where dependencies allow. Designed to be trivial for a weak model to call.

- **Simple form:** `steps` is just a list of strings; each step runs after the
  previous one and automatically receives its result (a pipeline).
  ```json
  { "description": "research topic",
    "steps": ["Research active contracts and list addresses",
              "Scan each for vulnerabilities",
              "Write a report"] }
  ```
- **Parallel batch:** a step can be an array of strings — they run at once and the
  next step receives all of their results: `["Scan chain A", "Scan chain B"]`.
- **Explicit graph (advanced):** a step can be an object
  `{ prompt, agent?, depends_on?, id? }` with `{{id}}` result interpolation.
- **Dynamic planning:** pass a `goal` instead of `steps` and a planner subagent
  expands it into steps, then runs them.
- **Reliability for flaky local backends:** `retries` (default 2) retries a step on
  transient errors (e.g. `loading model`, 503, connection reset) with backoff;
  `step_timeout_seconds` bounds a hung step. Long step results are head+tail
  truncated when fed forward. A failed step skips its dependents and the rest still
  return. Malformed calls get a corrective, small-model-friendly error message.
- **Live in the TUI:** renders as an inline block with per-step status glyphs
  (`✓ • ✗ – ○`), running-subagent activity, elapsed time, and counts — and each step
  row is **clickable** to open that subagent's session and watch its output.

### 2. `agent_create` — dynamic subagents at runtime

Lets the model define a new subagent on the fly (`name`, `description`, `prompt`,
optional `model`) and immediately spawn it via the `task` tool. With `persist: true`
it's written to `.opencode/agent/<name>.md` so it survives restarts.

### 3. `goal` — persistent, project-scoped goals

A single `goal` tool with `action: add | complete | abandon | list`. Goals are
stored per project (SQLite), persist across sessions, and are re-surfaced to the
model each turn so long-running objectives don't get lost.

### Sidebar panels: Goals & Subagents

Two new right-sidebar panels (alongside Todo / LSP / context):

- **Goals** — the current project's active goals.
- **Subagents** — the current session's active child sessions: running `task`
  subagents *and* `workflow` steps, with live status.

### 4. Small / local model support

- `examples/small-model-config.jsonc` — a commented config for a local
  OpenAI-compatible (llama.cpp) endpoint.
- `docs/small-model-guide.md` — setup, the single-slot-server concurrency caveat,
  and tips (prefer the string-list workflow form; keep concurrency low).
- `OPENCODE_THEME_MODE=dark|light` — forces the TUI theme mode synchronously at
  startup, bypassing terminal background auto-detection (which is unreliable inside
  `screen`/`tmux` and can render a light palette on a dark terminal).

---

## Build & run this fork

```sh
bun install
bun run --cwd packages/opencode build   # or: bun dev run "..."
```

Point it at your model with a config like `examples/small-model-config.jsonc`.
Tests: `cd packages/opencode && bun test`.

## Status

Feature branch: `feat/native-orchestration`. All new tools ship with unit tests and
the new TUI rendering has render tests. See
[`specs/native-orchestration.md`](specs/native-orchestration.md) and
[`specs/improvement-roadmap.md`](specs/improvement-roadmap.md) for design notes and
the remaining backlog.
