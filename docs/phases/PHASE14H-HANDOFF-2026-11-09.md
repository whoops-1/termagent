# TermAgent Phase 14H handoff — 2026-11-09

## Current state

- Version: `1.18.0`.
- Phase 14H: **IN PROGRESS**. Do not begin Phase 14I until the Phase 14H acceptance gate is closed.
- Latest source checkpoint: `TermAgent-1.18.0-Phase14H-Provider-Count-2026-11-09.zip`.
- Current continuation: session-scoped durable provider usage aggregation.
- OpenRecall is explicitly out of scope for this continuation.

## Implemented in this continuation

- Added streaming aggregation of normalized `provider.usage` events from the existing session JSONL event history.
- Added provider/model route buckets with bounded cardinality.
- Kept inclusive input/output/total token accounting separate from cache, reasoning and tool-use breakdowns to avoid double-counting.
- Added provider-reported vs estimated request counts, final-context average/peak, weighted measured estimator drift, and timestamps.
- Added terminal `/usage` output.
- Added the aggregate to the existing daemon `contextSnapshot`, so the context API and initial snapshot expose the same value.
- Added Web View `/usage` and provider usage history to the context inspector.
- Did not add a new endpoint, database, telemetry service, dependency, or unverified cost calculation.

## Upstream implementation studied

OpenCode at commit `2f0e2dbbff4b271b122399b89a1d8965c2a40fe0`:
- `packages/core/src/session/usage.ts`
- `packages/core/src/session/stats.ts`
- `packages/core/test/session-stats.test.ts`

Adapted usage normalization, aggregation, model grouping and durable-history regression principles. Did not copy its Effect/Drizzle/SQLite architecture.

OpenClaude supplied source checked:
- `src/services/tokenEstimation.ts`
- `src/utils/requestSizeBreakdown.ts`

## Validation

- TypeScript build: PASS.
- Browser JS syntax: PASS.
- Focused Phase 14H/provider-native-count/HTTP SDK/Web View suites: **42/42 PASS**.
- HTTP integration verifies durable usage aggregation appears in both the context API and snapshot without double-counting.
- `node scripts/verify-dist.mjs`: PASS.
- `npm pack --dry-run`: PASS (323 package files).
- `node dist/index.js --version`: `1.18.0`.
- `TERMAGENT_ALLOW_NON_ANDROID=1 npm run device:smoke`: PASS as Linux x64 (`termux:false`) only.
- The immediately preceding checkpoint had a 726/726 full-suite baseline. Full-suite reruns after this continuation did not reach final TAP output before tool limits (180 seconds parallel and 360 seconds serial). Current full-suite status is **inconclusive**, not passing or failing.

## Remaining Phase 14H gates

1. Complete a reliable full-repository regression run after the latest changes.
2. Run provider-backed clean-equivalent replay using captured real provider request/usage traces. Do not substitute a fabricated fixture and call it provider-backed.
3. Expand usage analytics from per-session to workspace-wide/cross-session only after defining fork/subagent aggregation semantics and deduplication rules.
4. Improve native tokenizer/request-framing coverage; exact multimodal payload accounting remains open because the current `ChatMessage` contract does not carry live media attachments.
5. Validate broader transcript shortening and multi-cycle summary quality against real long traces.
6. Benchmark 500K/1M context and large repositories under constrained memory.
7. Test nested instruction/skill scope conflicts and restart behavior across subagents.
8. Perform physical Android/Termux validation, including memory and latency checks.

## Next recommended move

Resolve the full-suite runner stall or obtain a complete test result in the target development environment, then move to a genuine provider-backed clean-equivalent replay with sanitized captured request/usage data. Keep the current usage analytics session-scoped until cross-session semantics are specified.
