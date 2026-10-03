# TermAgent 1.18 Stage G Fix Report

## Scope

This stage fixes the Todo lifecycle and session-context leakage found during terminal-session QA. The implementation preserves the existing session history while preventing completed Todo state from being presented as active work or reused as a steering signal on an unrelated follow-up turn.

## Changes

- Completed-only Todo state is hidden from the live terminal UI, matching the established lifecycle used by the terminal UI pattern.
- Todo persistence keeps completed entries in history so session audit/history remains intact.
- New turns restore only active Todo items from the persisted Todo state.
- Historical completed `todo` tool messages are redacted from the in-memory model context when they contain only completed items, preventing an old task description from steering a later request.
- Stale compacted `## Todo` and `## Next Move` sections are neutralized when the session has no active Todo work.
- The read-loop guard now detects prolonged consecutive read-only rounds and stops runaway repository rereads while preserving explicit exploration mode behavior.
- The system prompt provides the current UTC timestamp and explicitly forbids invented timestamps for date-sensitive edits.
- Regression tests cover completed Todo UI hiding, persisted Todo lifecycle, stale summary sanitization, stale tool-message redaction, read-only churn, and timestamp availability.

## Validation

Build:

- `npm run build` — PASS
- All generated JavaScript files — syntax check PASS

Test files:

- 41 test files executed individually with `node --test --test-concurrency=1`
- 332 total test cases — PASS
- 0 failures
- 0 cancellations

Additional focused validation:

- `tests/agent.test.mjs` — 16/16 PASS
- `tests/tools.test.mjs` — 5/5 PASS
- `tests/ui.test.mjs` — 19/19 PASS
- `tests/plugin-security-phase7.test.mjs` — 13/13 PASS

The monolithic `node --test tests/*.test.mjs` invocation was also stress-tested. It still stalls during the multi-file test-runner sequence despite the affected test files passing independently. That runner-level hang is treated separately from the application changes in this stage; no test failure was observed before the stall.

## Result

The production source and compiled `dist/` output are included together. No `node_modules` directory is included, so the archive remains suitable for transfer to a Termux checkout.
