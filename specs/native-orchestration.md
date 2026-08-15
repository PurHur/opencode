# Native orchestration: dynamic subagents, goals, workflows

Design for three native features in this fork, implemented in the v1 stack
(`packages/opencode/src`). Planned by Fable; implemented by Opus subagents.

Branch: `feat/native-orchestration`

> **Status: shipped.** All three tools (`workflow`, `agent_create`, `goal`) and the
> clickable inline workflow rendering in the TUI are implemented on this branch. This
> file is the design record; for the user-facing guide, copy-paste examples, and
> ready-made command templates see [`docs/native-orchestration.md`](../docs/native-orchestration.md)
> and [`examples/opencode-commands/`](../examples/opencode-commands/).

## Feature 1 — Dynamic subagents (`agent_create` tool)

Let the model define a new subagent at runtime and immediately spawn it via the
existing `task` tool.

- **Agent service** (`packages/opencode/src/agent/agent.ts`): add a mutable
  runtime overlay (`Map<string, Agent.Info>`) merged into `list()`/`get()`
  *after* config agents. New interface methods:
  - `register(info: Agent.Info): Effect<Agent.Info>` — validates name
    (kebab-case, must not collide with built-in/config agents), forces
    `mode: "subagent"`, derives permissions via
    `SubagentPermissions` like config agents do.
  - `unregister(name)` — only removes runtime-registered agents.
  The overlay lives outside the cached `InstanceState` so no invalidation is
  needed; `list()` concatenates state agents + overlay.
- **Tool** `packages/opencode/src/tool/agent-create.ts`, id `agent_create`:
  params `{ name, description, prompt, model?: "provider/model", persist?: bool }`.
  - Calls `ctx.ask({ permission: "agent_create", patterns: [name] })`.
  - `persist: true` additionally writes `.opencode/agent/<name>.md` with
    frontmatter (`description`, `mode: subagent`) using the same shape as
    `cli/cmd/agent.ts` `create` — so the agent survives restarts.
  - Returns a short confirmation listing the agent name and how to invoke it
    (task tool with `subagent_type: <name>`).
- **Registry** (`tool/registry.ts`): register the tool (import, init map,
  `builtin` array, `node.deps`). `describeTask` already recomputes per step, so
  new agents show up in the task tool description on the next assistant step —
  verify with a test.
- **Tests** (`test/tool/agent-create.test.ts` + additions to
  `test/agent/agent.test.ts`): register → visible in `list()`; task tool can
  resolve it; name collision rejected; persist writes the md file.

## Feature 2 — Persistent goals (`goal` tool)

Project-scoped goals that survive across sessions and are re-surfaced to the
model every turn.

- **Schema/event**: `packages/schema/src/goal.ts` — `GoalV1.Info`:
  `{ id, projectID, directory, content, status: "active"|"completed"|"abandoned",
  priority?: number, note?, time: { created, updated, completed? } }` + event
  `goal.updated`; register in `packages/schema/src/event-manifest.ts`.
- **Table**: `GoalTable` in `packages/core/src/session/sql.ts` (mirror
  `TodoTable`, but keyed by `project_id` + `directory`, NOT session), plus a
  migration `packages/core/src/database/migration/<ts>_goals.ts` registered in
  `migration.gen.ts` (follow `20260511173437_session-metadata.ts`).
- **Service**: `packages/opencode/src/session/goal.ts` — `Goal.Interface`:
  `list()`, `upsert(items)`, `setStatus(id, status)`; publishes `goal.updated`.
- **Tool**: `packages/opencode/src/tool/goal.ts`, id `goal` — actions
  `{ action: "add"|"complete"|"abandon"|"list", ... }` (single tool, action
  param — keeps the tool count low for small local models).
  `ctx.ask({ permission: "goal" })` on mutations only.
- **Injection**: in `packages/opencode/src/session/reminders.ts`, append a
  `<goals>` reminder block listing active goals (if any) so every prompt sees
  them (same mechanism as existing reminders, called from `prompt.ts`).
  Cap at ~20 goals, oldest-first.
- **Subagents**: deny `goal` mutations for subagents by default (same spot as
  todowrite: `agent.ts` general agent + `subagent-permissions.ts`).
- **Tests** (`test/tool/goal.test.ts`): add/list/complete across two sessions
  in the same instance dir (persistence), reminder injection contains active
  goals.

## Feature 3 — Deterministic workflows (`workflow` tool)

A native fan-out primitive: a declarative step list executed deterministically
(DAG), each step a fresh child session, parallel where dependencies allow.

- **Tool** `packages/opencode/src/tool/workflow.ts`, id `workflow`. Params:
  ```
  {
    description: string,
    steps: [{ id: string, agent?: string,        // default "general"
              prompt: string,                     // may contain {{stepId}} to
                                                  // interpolate a dep's result
              depends_on?: string[] }],
    concurrency?: number  // default 4, max 8
  }
  ```
- **Validation**: unique step ids, deps must reference existing ids, cycle
  detection (topological sort up front), max 16 steps. Reject depth-nesting:
  reuse the existing `subagent_depth` walk from `task.ts` so a workflow can't
  start inside a subagent beyond configured depth.
- **Execution**: get `promptOps` from `ctx.extra.promptOps` (same contract as
  `task.ts`). Topological layers → for each ready step:
  `sessions.create({ parentID: ctx.sessionID, agent, title: step.id, permission: derived })`
  then `ops.prompt(...)`; run ready steps with `Effect.forEach(..., { concurrency })`.
  `{{stepId}}` placeholders in prompts are replaced with the dep's final text
  (truncated to ~8k chars). Step result = last text part (as `task.ts:213`).
  Child permissions via `deriveSubagentSessionPermission`; children keep
  `task` denied (no nested fan-out by default).
- **Cancellation**: listen on `ctx.abort` → `ops.cancel` all running child
  sessions (mirror `task.ts` abort handling).
- **Progress**: call `ctx.metadata()` as steps start/finish
  (`{ steps: { [id]: "pending"|"running"|"done"|"error" } }`) so the TUI/CLI
  generic tool renderer shows movement.
- **Output**: structured summary —
  `<workflow>` block with per-step `<step id state>` and each step's result
  text (truncated), so the parent model can synthesize. Failed step: dependent
  steps are skipped, workflow reports partial results rather than throwing.
- **Registry**: register like the others. Description file `workflow.txt`
  explaining when to use (multi-part independent work) — keep it short.
- **Tests** (`test/tool/workflow.test.ts`, modeled on `task.test.ts` with
  stubbed `TaskPromptOps`): diamond DAG runs deps-first with parallelism
  (assert layer-2 steps see interpolated results), cycle rejected, failing
  step skips dependents, abort cancels.

## Conventions

- Effect `Schema` for tool params (not zod). No semicolons, prettier width 120,
  `oxlint` clean. Typecheck: `cd packages/opencode && bun tsgo --noEmit` (or
  `bun turbo typecheck` at root). Tests: `cd packages/opencode && bun test <file>`.
- Tool descriptions live in sibling `.txt` files (see `todowrite.txt`).
- Every new tool: import + init in `registry.ts` `Effect.all` map + `builtin`
  array + `node.deps` for new services.

## E2E acceptance (local box)

Using `~/.config/opencode/opencode.json` (llama.cpp `:50130`, Qwen3.8-27B):

1. `bun dev run "Create a subagent named haiku-writer that writes haikus, then use it to write a haiku about forks"` → agent_create + task round-trip.
2. `bun dev run "Add a goal to ship the orchestration feature"` then a second
   `bun dev run "What are my current goals?"` → persistence + reminder injection.
3. `bun dev run "Run a workflow with two parallel steps (list files in /etc, list files in /var) and a third step that summarizes both"` → DAG execution.
