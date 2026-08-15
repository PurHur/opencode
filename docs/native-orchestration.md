# Native orchestration

This fork ships three native tools that let a model plan and delegate work on its
own: **`workflow`** for running several subagent steps as one unit, **`agent_create`**
for defining a specialist subagent at runtime, and **`goal`** for project-scoped
intent that survives across sessions. The TUI renders a running workflow as a live,
clickable block so you can watch each step.

**Status: shipped** on branch `feat/native-orchestration`. The design notes live in
[`specs/native-orchestration.md`](../specs/native-orchestration.md).

- [Overview](#overview)
- [When to use what](#when-to-use-what-workflow-vs-task-vs-goal)
- [The `workflow` tool](#the-workflow-tool)
  - [Form 1 — a plain list of steps (start here)](#form-1--a-plain-list-of-steps-start-here)
  - [Form 2 — a parallel batch](#form-2--a-parallel-batch)
  - [Form 3 — an explicit graph](#form-3--an-explicit-graph)
  - [Form 4 — a goal (dynamic planning)](#form-4--a-goal-dynamic-planning)
  - [Parameters](#workflow-parameters)
  - [Partial failure](#partial-failure)
  - [Reliability & dynamic planning](#reliability--dynamic-planning)
- [The `agent_create` tool](#the-agent_create-tool)
- [The `goal` tool](#the-goal-tool)
- [Watching progress](#watching-progress-in-the-tui)
- [Tips for small / local models](#tips-for-small--local-models)
- [Worked examples](#worked-examples)
- [Example command templates](#example-command-templates)

## Overview

| Tool | What it does | Persistence |
| --- | --- | --- |
| `workflow` | Runs several subagent steps in one call. Each step is a fresh child session; results flow forward automatically, and independent steps run in parallel. | Ephemeral (one call). |
| `agent_create` | Defines a new subagent at runtime. Invoke it afterwards through the `task` tool with `subagent_type: "<name>"`. | Session-only, or written to `.opencode/agent/<name>.md` with `persist: true`. |
| `goal` | Records long-lived, project-scoped goals that are re-surfaced to the model at the start of every turn. | Persists across sessions in the project database. |

## When to use what: workflow vs task vs goal

- **`task`** — a single piece of delegated work. Use it when you will read the
  result yourself and then decide what to do next.
- **`workflow`** — multi-part work you can plan up front (research several things,
  inspect several targets, then combine) and want executed in one go rather than
  issuing `task` calls one at a time. Do **not** use it when you must inspect each
  intermediate result before choosing the next step — that is a job for `task`.
- **`goal`** — an objective that spans more than one session ("ship the auth
  rewrite", "get the test suite green"). Goals are not step tracking; use
  `todowrite` for step-by-step work inside a single session.

## The `workflow` tool

A workflow runs several subagent steps as one unit. Each step runs in its own fresh
subagent (a child session) with **no memory of the other steps** — everything a step
needs must be in its text. Results flow forward automatically, and steps whose
dependencies are all satisfied run concurrently.

There are three ways to write a step. You can mix them in one `steps` list.

### Form 1 — a plain list of steps (start here)

Each string is one task. It runs after the previous one and automatically receives
the previous step's result. A plain list is therefore a pipeline.

```json
{
  "description": "research topic",
  "steps": [
    "Research the most active smart contracts on Ethereum and list their addresses",
    "For each contract from the previous step, scan the source for vulnerabilities",
    "Write a short report of the findings"
  ]
}
```

### Form 2 — a parallel batch

Make a step an **array of strings**. Those tasks run at the same time, and the next
step receives all of their results.

```json
{
  "description": "scan chains",
  "steps": [
    ["Scan Ethereum contracts", "Scan Base contracts", "Scan Arbitrum contracts"],
    "Combine the findings from all chains into one report"
  ]
}
```

So `["a", "b", "c"]` is a pipeline, and `["a", ["b", "c"], "d"]` fans out after `a`
then joins back at `d`.

### Form 3 — an explicit graph

When you need a real dependency graph, a step may be an object:

```json
{ "prompt": "...", "agent": "general", "id": "x", "depends_on": ["y"] }
```

- `prompt` (required) — the instructions for the step.
- `id` — a unique id, referenced by other steps. Auto-generated if omitted.
- `agent` — the subagent type to run this step (defaults to `general`).
- `depends_on` — step ids that must finish before this one starts.

Inside a prompt, `{{y}}` is replaced with the final text of step `y`. If a step
depends on others but uses no `{{id}}` placeholder, the dependency results are
injected automatically at the top of its prompt (the same auto-forwarding that makes
the plain string list a pipeline). Note the difference from the string form: an
object step with **no** `depends_on` is an independent root, whereas a plain string
always chains onto whatever ran immediately before it.

### Form 4 — a goal (dynamic planning)

If you know the goal but not the exact steps, pass **`goal`** instead of `steps` and
omit `steps` entirely. A planning subagent (the `planner` agent if you have one,
otherwise `general`) expands the goal into 2–16 concrete steps, which then run as a
normal pipeline. The chosen plan is reported back in the output (and in the TUI block).

```json
{
  "description": "hunt vulns",
  "goal": "find and report vulnerabilities in the most active smart contracts"
}
```

Provide **either** `goal` (to plan) **or** `steps` (to run a known plan). If both are
given, `steps` win and `goal` is ignored. Planning fails with
`planner did not return any steps` if the planner cannot produce a usable list, so on
a weak local model prefer an explicit `steps` list when you already know the plan.

<a id="workflow-parameters"></a>
### Parameters

| Param | Required | Notes |
| --- | --- | --- |
| `description` | yes | A short (3-5 words) description of the workflow. Also the title shown in the TUI. |
| `steps` | yes, unless `goal` | The ordered list. Each entry is a string, an array of strings, or an object. **Max 16 steps.** Omit when providing a `goal`. |
| `goal` | yes, unless `steps` | A high-level goal to plan into steps automatically (see [Form 4](#form-4--a-goal-dynamic-planning)). Ignored if `steps` is also given. |
| `concurrency` | no | Maximum steps to run at once. Default `4`, max `8`. |
| `retries` | no | Times to retry a step that fails with a *transient* error. Default `2`, max `5`, `0` disables. See [Reliability](#reliability--dynamic-planning). |
| `step_timeout_seconds` | no | Cancel and error a step that runs longer than this. Default `0` (no limit), max `3600`. |

Other behavior worth knowing:

- Long step results are truncated to ~8000 characters when injected into a dependent
  step and in the final output. Truncation keeps **both ends** — the first ~5000 and
  the last ~2500 characters — with a `… [truncated N characters] …` marker between
  them, so a step keeps its setup and its conclusion rather than being cut off flat.
- Workflows cannot be started from inside a subagent past the configured
  `subagent_depth` (default 1). Raise `subagent_depth` in config to allow nesting.
  The depth guard is checked before any subagent (planner included) is spawned.
- The first `workflow` call in a session asks for permission (per agent type used).
- Invalid input is rejected before any subagent runs, with plain-language messages
  aimed at small models — e.g. an empty list, more than 16 steps, a duplicate id, a
  `depends_on` that names an unknown step, or a dependency cycle each report exactly
  what to change.

### Partial failure

If a step fails, its dependents are **skipped**, but every other result is still
returned. Each step reports its own state in the output — `done`, `error`, or
`skipped` — so the calling model can synthesize from whatever succeeded rather than
losing the whole run. Always check the per-step states before trusting the summary.

### Reliability & dynamic planning

Two per-call arguments make a workflow survive a flaky or slow backend, and one lets
the workflow plan itself. All three are especially useful with a small / local model
(see the [small-model guide](./small-model-guide.md)).

**`retries`** (default `2`, max `5`, `0` disables) — when a step fails with a
*transient* error, it is retried with exponential backoff (2s, 4s, 8s, …). A failure
counts as transient when the model's error is a retryable API error (HTTP status
≥ 500, or explicitly flagged retryable) **or** its message matches `loading model`,
`503`, `overloaded`, `ECONNRESET`, `reset`, or `timeout` — exactly the flakiness a
cold local server produces. Non-transient errors always fail the step immediately,
without retrying. Values are clamped to the `0`–`5` range.

**`step_timeout_seconds`** (default `0` = no limit, max `3600`) — if a single step
runs longer than this, it is cancelled and marked a `timeout` error (`step timed out
after Ns`), and its dependents are skipped like any other step failure. Use it so one
wedged step cannot hang the whole run; on a slow local model do not set it too tight.
A timeout is not treated as transient, so it does not consume a retry.

```json
{
  "description": "audit with guardrails",
  "steps": [
    "Scan the auth code for vulnerabilities; list file:line and severity",
    "Write a prioritized report of the findings"
  ],
  "concurrency": 2,
  "retries": 3,
  "step_timeout_seconds": 300
}
```

**`goal`** (dynamic planning) — provide a `goal` and omit `steps`, and a planner
subagent expands it into concrete steps that are then run (see
[Form 4](#form-4--a-goal-dynamic-planning)):

```json
{
  "description": "hunt vulns",
  "goal": "find and report vulnerabilities in the most active smart contracts"
}
```

## The `agent_create` tool

Defines a new subagent at runtime and makes it immediately available to the `task`
tool for the rest of the session.

| Param | Required | Notes |
| --- | --- | --- |
| `name` | yes | Lowercase kebab-case id, e.g. `code-reviewer`. Must not collide with an existing agent. |
| `description` | yes | One sentence describing when this agent should be used. |
| `prompt` | yes | The agent's system prompt: what it does, what it avoids, what it returns. |
| `model` | no | `provider/model` override. Omit to inherit the caller's model. |
| `persist` | no | `true` writes `.opencode/agent/<name>.md` so the agent survives restarts. Defaults to `false`. |

After creating it, invoke the agent through the `task` tool with
`subagent_type: "<name>"`. Create an agent only when a specialist is worth reusing
several times; for one-off work that `general` or `explore` already covers, call
`task` directly.

## The `goal` tool

Tracks long-lived, project-scoped goals. Unlike todos, goals persist across sessions
and are re-surfaced in a `<goals>` reminder at the start of every turn.

| Param | Required | Notes |
| --- | --- | --- |
| `action` | yes | One of `add`, `complete`, `abandon`, `list`. |
| `content` | for `add` | The goal text. Keep it short and outcome-shaped. |
| `id` | for `complete` / `abandon` | The goal id, taken from the `<goals>` reminder or a `list` call. |

- `add` records a new goal (one goal per call — do not batch unrelated objectives).
- `complete` / `abandon` close a goal by id.
- `list` shows every goal, active ones first.

Mutations (`add`, `complete`, `abandon`) ask for permission; `list` does not. By
default, subagents cannot mutate goals.

## Watching progress in the TUI

When a workflow runs, the TUI shows it as an **inline live block** under the tool
call. Each step has a state that updates as it runs (`pending` → `running` →
`done` / `error` / `skipped`). Each step is **clickable**: selecting it opens the
subagent's own session so you can watch that step's output live and read its full
transcript, not just the truncated result that flows back to the parent.

## Tips for small / local models

Small local models plan best when the work is broken up for them and the tool call
stays simple:

- **Prefer the plain string-list form.** It is the lowest-ceremony option and needs
  no ids or `depends_on` — the pipeline wiring is automatic.
- **Keep steps few and concrete.** Three to five specific steps beat a dozen vague
  ones. Each step is a fresh subagent, so spell out exactly what it should produce.
- **Put everything the step needs in its text.** Steps share no memory. If a step
  needs a path, a constraint, or a format, write it into the prompt.
- **Use a modest `concurrency` (2-4).** Local backends have limited parallel decode
  capacity; running eight subagents at once usually just thrashes. On a single local
  model, `concurrency: 2` is often the sweet spot.
- **Let results flow.** Do not restate a previous step's output in the next prompt —
  a plain list forwards it automatically.

## Worked examples

### Codebase audit

Fan out an audit across dimensions, then consolidate:

```json
{
  "description": "audit codebase",
  "steps": [
    [
      "Audit the authentication and session code for security issues; list file:line and severity",
      "Audit error handling and logging for gaps; list file:line",
      "Audit the test suite for missing coverage of critical paths; list what is untested"
    ],
    "Merge the three audits into one prioritized report, highest severity first, with concrete fixes"
  ]
}
```

The three audits run in parallel (`concurrency` permitting), and the final step
receives all three results and produces one ranked report.

### Research

A straight pipeline — each step builds on the last:

```json
{
  "description": "research a library",
  "steps": [
    "Find the three most popular Rust web frameworks and note their GitHub stars and last release date",
    "For each framework, summarize routing, middleware, and async support",
    "Recommend one for a small team building a JSON API, with a two-paragraph justification"
  ]
}
```

## Example command templates

Ready-to-copy slash-command templates live in
[`examples/opencode-commands/`](../examples/opencode-commands/). Copy any of them
into your project's `.opencode/command/` directory (or the global
`~/.config/opencode/command/`) and invoke by filename. They are templates — adjust
the prompts, `agent`, and `model` to your setup.

- `research.md` — research a topic in parallel, then summarize.
- `audit.md` — audit changed files across several dimensions, then report.
- `refactor.md` — plan, apply, and verify a refactor as one workflow.

### Command frontmatter reference

opencode command files are markdown with optional YAML frontmatter. The recognized
frontmatter fields are:

| Field | Notes |
| --- | --- |
| `description` | Short summary shown in the command list. |
| `agent` | Which agent runs the command. |
| `model` | `provider/model` override for the command. |
| `variant` | Model variant, if your provider exposes one. |
| `subtask` | `true` runs the command as a subtask. |

The markdown body is the prompt template. Inside it you can use:

- `$ARGUMENTS` — everything the user typed after the command name.
- `$1`, `$2`, … — positional arguments (the last placeholder absorbs the rest).
- `` !`shell command` `` — replaced with the command's output.
- `@path/to/file` — a file reference.

If the body contains no `$ARGUMENTS` / `$N` placeholder and the user passes
arguments, those arguments are appended to the end of the prompt.
