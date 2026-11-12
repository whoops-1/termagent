# Phase 14H — Durable provider usage aggregation

## Scope

Expose historical provider token usage from the durable session history without creating a new usage database, telemetry service, provider billing layer, or duplicate event abstraction. This implementation is deliberately session-scoped. Workspace-wide/all-session analytics remain a separate open item.

## Existing TermAgent sources reused

- `src/session/store.ts`: durable, ordered session events already include `provider.usage`.
- `src/providers/types.ts`: existing validation/normalization for secret-free `ProviderUsageReport` records.
- `src/server/runtime.ts`: canonical `contextSnapshot()` used by authenticated session context and snapshot APIs.
- `src/cli/repl.ts`: existing `/usage` and `/context` command surface.
- `web/app/app.js`: existing context inspector and slash-command UI.

No new HTTP endpoint or alternate source of truth was introduced. Both clients read the same daemon-generated aggregate via the existing context snapshot.

## Upstream study and adaptation

OpenCode was reviewed at commit `2f0e2dbbff4b271b122399b89a1d8965c2a40fe0`:

- [`packages/core/src/session/usage.ts`](https://github.com/anomalyco/opencode/blob/2f0e2dbbff4b271b122399b89a1d8965c2a40fe0/packages/core/src/session/usage.ts) normalizes provider usage and combines token/cost records.
- [`packages/core/src/session/stats.ts`](https://github.com/anomalyco/opencode/blob/2f0e2dbbff4b271b122399b89a1d8965c2a40fe0/packages/core/src/session/stats.ts) aggregates durable session usage by time and model and keeps compaction usage distinct from message usage.
- [`packages/core/test/session-stats.test.ts`](https://github.com/anomalyco/opencode/blob/2f0e2dbbff4b271b122399b89a1d8965c2a40fe0/packages/core/test/session-stats.test.ts) covers fork semantics, durable event aggregation and large ID batches.

TermAgent reuses the normalization, additive aggregation, model grouping and regression-test ideas. It does **not** copy OpenCode's Effect/Drizzle/SQLite stack: TermAgent already has JSONL session events and a daemon context projection. It also does not estimate money because TermAgent has no verified price catalog for every custom endpoint/model route.

The supplied OpenClaude source was checked at `src/services/tokenEstimation.ts` and `src/utils/requestSizeBreakdown.ts`. Those implementations emphasize provider-native count fallback and a classified request-footprint breakdown. They inform the interpretation of TermAgent's existing request estimates and provider measurements, not the persistence layer for usage analytics.

## Aggregate semantics

`aggregateProviderUsageEvents(events)` accepts a durable event list and uses a generator to avoid allocating a second event-sized array. Only well-formed `provider.usage` records are counted; malformed records and unrelated event types are ignored. Missing report timestamps fall back to the event timestamp.

The result includes:

- total requests, split into provider-reported and estimate-only requests;
- inclusive input, output and total tokens, plus non-cached input as a subset;
- cache-read, cache-write, reasoning and tool-use input breakdowns;
- average and peak final-request context occupancy where reported;
- weighted estimator drift over provider-measured requests only;
- first/last recorded timestamps;
- a bounded provider/model breakdown (up to 32 named routes plus one overflow bucket).

**Important accounting rule:** provider-reported `totalTokens` is retained as the inclusive total. Cache, reasoning and tool-use fields are shown as separate breakdowns and are not added to the inclusive totals a second time. No cost is presented without verified route pricing.

## User-visible surfaces

- Terminal `/usage`: aggregates the active session's durable history.
- Web View `/usage`: opens the existing context inspector's provider-usage section.
- Web View `/context`: shows the same aggregate alongside context-budget and workspace diagnostics.
- Existing context API and snapshot both return the same `usage` projection from the runtime.

## Validation

- `npm run build` — PASS.
- `node --check web/app/app.js` — PASS.
- `node --test tests/phase14h-context-continuity.test.mjs tests/phase14h-controlled-replay.test.mjs tests/providers-native-token-count.test.mjs tests/phase14c-http-sdk.test.mjs tests/phase14d-webview.test.mjs` — **42/42 PASS**.
- The HTTP integration test appends a durable provider usage event, then verifies the context endpoint and snapshot return the aggregate and do not double-count cache/reasoning details.

Full repository suite reruns are pending. This feature does not close the 14H gate: provider-backed clean-equivalent replay, cross-session/workspace analytics, request/media accounting precision, broader compaction quality, scale/device-memory benchmarks, subagent scope cases and physical Termux validation remain open.
