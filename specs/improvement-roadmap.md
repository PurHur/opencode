# Fork improvement roadmap — "great small-model orchestration"

Goal: make dynamic workflows + subagents work superbly with small/local models.
Executed autonomously in conflict-safe waves. Hard rule: **every change must pass
`bun tsgo --noEmit` + relevant `bun test` before it is committed, and the full
package typecheck before it is pushed. Never land broken code.**

Progress markers: [ ] todo · [~] in progress · [x] done · [!] blocked/skipped

## Wave 1 — disjoint files, run in parallel
- [ ] 1. workflow.ts: per-step **retry** on transient errors (503 "Loading model",
      5xx, isRetryable, ECONNRESET) with backoff. Param `retries` (default 2, 0..5).
- [ ] 2. workflow.ts: per-step **timeout** (`step_timeout_seconds`, 0=off) →
      cancel child, mark step error. (bundled with #1, same file/agent)
- [ ] 3. workflow.ts: **small-model-friendly validation errors** via
      `formatValidationError` so a dumb model self-corrects malformed calls.
      (bundled with #1)
- [ ] 4. tui index.tsx: workflow block **duration + counts + failure visibility**;
      completed block keeps a useful clickable summary.

## Wave 2 — workflow.ts follow-ups (sequential after Wave 1 #1-3)
- [ ] 5. workflow.ts: **dynamic planning** — a `goal` string param that a planner
      subagent expands into steps before execution (truly "dynamic" workflows).
- [ ] 6. workflow.ts: **auto-summarize** oversized child results before injecting
      into downstream prompts (helps small context windows).

## Wave 3 — separate subsystems, parallel
- [ ] 7. session/prompt.ts (or registry): **tool-call repair** — when a small model
      emits malformed tool args, retry the step once with a corrective hint.
- [ ] 8. config: **small-model preset** / documented defaults (lower concurrency,
      subagent_depth, sensible reminders) for weak local backends.
- [ ] 9. **resume/recover** an interrupted workflow: detect an orphaned `pending`
      workflow tool call (turn cut off) and surface/clean it instead of hanging
      forever. (Directly fixes the "Planning workflow…" stuck state.)

## Wave 4 — integration + hardening
- [ ] 10. goals ↔ workflow: let a workflow read active goals / mark one complete.
- [ ] 11. broaden tests: an integration test exercising retry + timeout + planning.
- [ ] 12. polish pass: descriptions, examples, and a `models` note recommending a
      tool-reliable local model; update docs/native-orchestration.md.

## Log
(appended as waves complete)
