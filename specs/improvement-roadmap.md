# Fork improvement roadmap — "great small-model orchestration"

Goal: make dynamic workflows + subagents work superbly with small/local models.
Executed autonomously in conflict-safe waves. Hard rule: **every change must pass
`bun tsgo --noEmit` + relevant `bun test` before it is committed, and the full
package typecheck before it is pushed. Never land broken code.**

Progress markers: [ ] todo · [~] in progress · [x] done · [!] blocked/skipped

## Wave 1 — disjoint files, run in parallel
- [x] 1. workflow.ts: per-step **retry** on transient errors (503 "Loading model",
      5xx, isRetryable, ECONNRESET) with backoff. Param `retries` (default 2, 0..5).
      (improve/wf-robustness-2)
- [x] 2. workflow.ts: per-step **timeout** (`step_timeout_seconds`, 0=off) →
      cancel child, mark step error. (improve/wf-robustness-2)
- [x] 3. workflow.ts: **small-model-friendly validation errors** via
      `formatValidationError` so a dumb model self-corrects malformed calls.
      (improve/wf-robustness-2)
- [x] 4. tui index.tsx: workflow block **duration + counts + failure visibility**;
      completed block keeps a useful clickable summary. (improve/wf-tui-2)

## Wave 2 — workflow.ts follow-ups (sequential after Wave 1 #1-3)
- [x] 5. workflow.ts: **dynamic planning** — a `goal` string param that a planner
      subagent expands into steps before execution (truly "dynamic" workflows).
      (improve/wf-planning)
- [x] 6. workflow.ts: head+tail truncation of oversized child results before
      injecting downstream (deterministic, cheap — no summarizer subagent).
      (improve/wf-planning)

## Wave 3 — separate subsystems, parallel
- [!] 7. session/prompt.ts: **tool-call repair** — DEFERRED. High value for small
      models but a change to the hot prompt loop; not safe to rush. Approach: on a
      tool-arg decode failure for an orchestration tool, re-issue the step once with
      the tool's `formatValidationError` text appended (guard against retry loops).
      Do as a dedicated, reviewed change.
- [x] 8. config: **small-model preset** / documented defaults (lower concurrency,
      subagent_depth, sensible reminders) for weak local backends.
      (improve/small-model-config: examples/small-model-config.jsonc + docs/small-model-guide.md)
- [!] 9. **resume/recover** an interrupted workflow — DEFERRED (core-loop change).
      Root cause: `SessionProcessor.cleanup` (processor.ts:539) marks orphaned tool
      parts `interrupted` only via `Effect.ensuring` on a graceful turn end; a hard
      kill (server restart dropping the connection, or process death) skips it, so a
      tool part stays `pending` and the assistant message keeps `time.completed`
      unset. The loop's orphan check (prompt.ts:1108 `isOrphanedInterruptedTool`)
      only recognizes parts already error+interrupted, so a raw `pending` orphan is
      never recovered. Safe fix: in `SessionPrompt.prompt` (prompt.ts:1056), after
      `revert.cleanup`, guard with `SessionRunState.assertNotBusy`; only when NOT
      busy, sweep tool parts still `pending`/`running`, mark them error+`metadata.
      interrupted`, and complete the owning assistant message. Caveat: if the stuck
      fiber is alive-but-blocked the runner stays registered, `assertNotBusy` throws,
      and the sweep is correctly skipped — so this helps the hard-kill case only.
      Workaround today: Esc / restart the session.

## Wave 4 — integration + hardening
- [ ] 10. goals ↔ workflow: let a workflow read active goals / mark one complete. (optional)
- [ ] 11. broaden tests: integration test exercising retry + timeout + planning. (optional)
- [x] 12. polish pass: documented retries/timeout/dynamic-planning in
      docs/native-orchestration.md; cross-linked small-model guide. (improve/docs-polish)

## Log
(appended as waves complete)
