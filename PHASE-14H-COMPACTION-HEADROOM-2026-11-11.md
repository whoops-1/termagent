# Phase 14H — Compaction Headroom Follow-up

Date: 2026-11-11
Base: `TermAgent-1.18.0-Phase14H-Adaptive-Estimator-Replay-2026-11-11.zip`

## Evidence reviewed

- 70 provider trace captures from `provider-traces(2).zip`.
- Matching session log `mwbzj0m6-66803c02.jsonl`.
- Termux screenshot `Screenshot_2026-11-11-16-45-36-175_com.termux.jpg`.
- Replay output supplied in the project conversation.

The replay matched 70/70 provider usage events and nine turns, and identified two provider-observed requests above the 84,000-token TermAgent usable budget. The screenshot shows the final request preflight guard firing at 84,100 tokens after tool/schema bounding, with 2,424 tool-definition tokens, 7,862 tool-call tokens, and 18,074 tool-result tokens.

The guard is correct to reject a request that still exceeds the configured usable budget. The weakness was that ordinary compaction targeted the hard usable ceiling itself, leaving no deliberate headroom for request growth and estimator error before the next provider call.

## Upstream implementation research

Reviewed the upstream compaction architecture in:

- OpenCode `packages/core/src/session/compaction.ts`: configurable reserve buffer, proactive compaction ceiling, and stepped shrinking after provider overflow.
- OpenClaude `src/services/compact/autoCompact.ts`: automatic compaction threshold deliberately below the effective context limit, with a reserve margin and separate forced-overflow path.

These patterns support retaining a margin below the hard request ceiling rather than compacting only to the exact ceiling.

## Change

In `src/agent/agent.ts`, ordinary compaction now targets 90% of `budget.usableTokens`, while provider-overflow recovery retains its more aggressive 72% target. This keeps the existing measured-baseline, route-ratio, native-count, micro-prune, and full-compaction mechanisms intact; it changes only the normal post-compaction target.

The focused continuity test now asserts that ordinary compaction targets 90% of the usable budget and finishes below that target.

## Verification

- `npm run build`: passed.
- `node --test tests/phase14h-context-continuity.test.mjs tests/phase14h-provider-trace.test.mjs`: 30/30 passed.
- `node scripts/verify-dist.mjs`: passed.
- `npm pack --dry-run --json`: passed; 325 package files, 2,191,188 unpacked bytes.
- Full `npm test`: did not complete within the 300-second execution window; output reached test 226 before timeout. This is inconclusive, not a test failure report.

## Remaining validation

1. Run full test suite to completion in a longer window.
2. Add/verify a high-context regression reproducing the 84k budget boundary and confirming post-compaction headroom.
3. Re-run a real Termux Mercury-3 session on this updated build; inspect whether the 84,100 post-bounding guard is avoided and whether compaction remains stable.
4. Validate a second provider route if available.
5. Exercise provider-rejected overflow recovery with real provider evidence; existing tests cover the simulated rejection path only.
6. Run controlled compaction A/B with equivalent task outcomes.

This is a Phase 14H follow-up patch, not Phase 14H acceptance and not Phase 14I start.
