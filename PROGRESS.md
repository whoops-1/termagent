# 2026-11-11 — Phase 14H adaptive-estimator shadow replay

Resumed Phase 14H using the user-supplied `provider-traces.zip` (110 captures) and matching `mwbs4kru-6f3f02ae.jsonl` (1,161 durable events). The replay validates the session identity through the trace's SHA-256 session hash and matches all 110 captures to durable `provider.usage` events by turn/round, timestamp, provider, model, context window, input/output counts, and full-request estimate. All 11 turns match, and the three completed compaction boundaries are replayed. The files contain prompt, tool, code and response content, so the raw trace/session data remains excluded from the source archive.

The first (raw) replay confirms a 40.5% weighted undercount by the local full-request estimator. However, a shadow replay of the existing `Agent.run()` calibration formula tells a different story: aggregate signed adaptive prediction error is +0.1% (slight overestimation), mean absolute per-request error 3.5%, p50 2.1%, p95 13.7%, maximum 29.3%. Ten of 11 turns seed calibration from prior persisted usage; 106 requests are measured-baseline-backed, 109 use the rolling route ratio, and none have a native token count. The first request is a cold start and is predicted from the raw local estimate only.

One request crossed the usable budget: 84,381 provider-observed input against 84,000 usable. Adaptive prediction was 82,463, so the request exceeded the budget by 381 tokens; the predictor was 2.27% low. The largest absolute adaptive error is a conservative post-compaction overestimate (39,285 versus 30,377, 29.3%). The three compactions show provider-observed input declining afterward, but this chronology is observational, not a clean-equivalent A/B. This single `openai-compatible/mercury-3` route supports the current route-scoped calibration strategy; it is not evidence for a global multiplier or for all providers.

Reviewed OpenCode `packages/core/src/util/token.ts` (generic chars/4 estimate) and OpenClaude `src/services/tokenEstimation.ts` plus `src/utils/requestSizeBreakdown.ts` (optional provider counts, content categories/bounds, and request contributor allocation). The upstream rough heuristics are not a suitable replacement for TermAgent's route-scoped online calibration on this dataset. No runtime token-estimation behavior was changed in this iteration. The replay utility now accepts `--session-log`, refuses mismatched session identity, simulates predictions without looking ahead to the current response usage, resets measured baselines across compaction and route changes, and explicitly prints budget-crossing misses and calibration source distribution.

Added deterministic regression tests for no-lookahead, persisted-usage seeding across turns, compaction baseline reset, route-change reset and identity mismatch refusal. Focused provider trace suite: **9/9 PASS**. The complete current repository suite passed **85/85 test files; 744/744 tests PASS** at serial concurrency. `npm run build`, `node scripts/verify-dist.mjs`, `node dist/index.js --version` (`1.18.0`), and `npm pack --dry-run` (325 files; 501.5 kB tarball) also PASS. No provider calls were made by the replay. Native count comparison, controlled provider-backed compaction A/B, another route/model, overflow-path validation using a provider rejection, and physical Termux verification remain open. Phase 14H remains **IN PROGRESS**; Phase 14I has not started.

Replay command:

```sh
npm run phase14h:provider-replay -- "$HOME/.termagent/provider-traces" --session-log /path/to/session.jsonl
```

Research references:
- https://github.com/anomalyco/opencode/blob/dev/packages/core/src/util/token.ts
- https://github.com/Twigpine/openclaude/blob/main/src/services/tokenEstimation.ts
- https://github.com/Twigpine/openclaude/blob/main/src/utils/requestSizeBreakdown.ts

---

# 2026-11-10 — Phase 14H provider-measured compaction trigger repair

Resumed from the second user-supplied session log (`mwai6tsy-80da7804.jsonl`). The 1,024-event trace contains 9 committed turns, 90/90 provider-reported usage rounds, 131/131 paired tool calls/results, 9 baseline checkpoints, and zero compaction events/full-compaction checkpoints. Across those reports it records 12,043,265 inclusive input tokens (1,693,999 uncached + 10,349,266 cache read), 87,501 output tokens, and 12,130,766 total tokens. Its weighted message-estimate drift is +31.9%. The trace's analyzer reports 122,998 reconstructed message-estimate tokens and 0 compactions. The durable log does not independently attest that the provider usage originated from a live endpoint.

The failure had two causes in the existing `Agent.run()` path: automatic compaction only used the local estimated request footprint (ignoring prior durable provider-measured input occupancy), and final/no-tool response branches returned before invoking the post-round compaction hook. Consequently a route without a native count endpoint could keep reporting >200K measured input while the local estimate remained much lower and the turn returned to Ready without a compaction event.

Reviewed current OpenCode `packages/core/src/session/compaction.ts` (`Estimate = measured + estimated`, last provider-measured prompt as anchor, estimate only subsequent deltas) and OpenClaude `src/services/compact/autoCompact.ts` (output reservation, forced overflow recovery and bounded failure handling). Adapted the measured-plus-estimated anchor using TermAgent's existing `provider.usage` JSONL events, request-accounting helper, `Agent.run()` and compactor. New usage events persist `estimateRequestTokens` (full request footprint, including tool schemas and multimodal estimate); old events remain supported with the existing message-estimate plus schema fallback. The runtime derives a short, bounded, route/model/window-scoped median correction from up to five recent measured samples; it is not global and resets on route changes. The compaction trigger compares local estimate, route-corrected estimate, measured anchor plus added-request delta, and any native input count. The post-provider-response hook now also runs after a final no-tool response and terminal tool-blocked branches, so over-budget usage causes compaction before returning Ready. The UI marks post-compaction/reconstructed local values with `~` while provider-measured live usage remains unmarked.

Regression coverage reproduces both failures: (1) resumed OpenAI-compatible route where last provider-measured context exceeds the local estimate and compaction must occur before the next request; (2) provider-reported oversized final response where compaction must occur before the run returns. Existing native-count preflight and old-report compatibility remain covered. No extra usage store, tokenizer dependency, compaction subsystem, or new provider route was added.

Verification: complete repository inventory **104/104 test files; 874/874 tests PASS**, executed serially in bounded batches. Focused Phase 14H continuity/controlled replay/provider trace/session replay and semantic UI gate **46/46 PASS**. `tsc -p tsconfig.json --pretty false` PASS; `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (**325 files**, 500.8 kB package); `node dist/index.js --version` reports `1.18.0`; `TERMAGENT_ALLOW_NON_ANDROID=1 npm run device:smoke` PASS on Linux x64 only (`termux:false`). No physical Android/Termux test or live provider request was performed. The uploaded 1,024-event trace itself still has zero compactions; the new tests validate the corrected runtime paths, not a provider-backed replay of that historical request stream. Phase 14H remains **IN PROGRESS**; Phase 14I has not started.

---

# 2026-11-10 — Phase 14H durable session usage replay reconciliation

Resumed Phase 14H from a user-supplied 136-event durable session log (`mwah4u1t-68024136`). The log contains 3 committed turns, 11 `provider.usage` records marked as provider-reported, 17 completed tool calls with 17 matching tool results, and 3 baseline context checkpoints. It records no compaction event and no full-compaction checkpoint, so it cannot support a clean-equivalent compaction A/B. All 11 usage records are from the single recorded route `openai-compatible/mercury-3`; their origin is not independently attested by the log analyzer.

The replay initially reported `0/33` provider usage events because it searched only `provider.turn` lifecycle payloads. The current runtime persists usage as a distinct durable `provider.usage` event. Fixed `tools/phase14h-session-replay.mjs` to use the existing `aggregateProviderUsageEvents()` from `dist/providers/types.js`, recognize dedicated events, retain compatibility with older usage embedded in `provider.turn`, and avoid double-counting the legacy copy when the dedicated event exists. Added strict round-key parsing so null/blank round identifiers are not coerced to round zero. No new usage store, estimator, or aggregation path was introduced.

The corrected replay reports **11/11 provider rounds recorded**, 314,389 inclusive input tokens (76,440 uncached + 237,949 cache read), 5,631 output tokens, and 320,020 total tokens. Cache reads represent approximately **75.7%** of reported input. The weighted message-estimate drift is **+19.7% relative to provider-measured context**; this is not the same denominator as the provider-trace replay's full-request drift. All usage records belong to one route and one session, so do not apply a global estimator multiplier from this sample. Native count drift is unavailable for this route in the supplied trace.

Upstream review was refreshed against OpenCode's explicit `SessionEvent.UsageRecorded` flow and non-overlapping usage normalization (`packages/core/src/session/usage.ts`, `packages/ai/src/schema/events.ts`, `packages/core/src/session/compaction.ts`), plus OpenClaude's VCR and request-size contributor breakdown (`src/services/vcr.ts`, `src/utils/requestSizeBreakdown.ts`). TermAgent reuses its existing durable usage event and shared aggregation helper. References: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/usage.ts ; https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts ; https://github.com/Twigpine/openclaude/blob/main/src/services/vcr.ts ; https://github.com/Twigpine/openclaude/blob/main/src/utils/requestSizeBreakdown.ts .

Verification: `node --check` on replay tool and test: PASS; Phase 14H continuity/controlled replay/provider trace/session replay focused suite: **34/34 PASS** (serial). The replay output for the supplied session has 0 sequence/epoch mismatches, 17/17 tool pairs, 0 duplicate result IDs, and 3 baseline checkpoints. The four-worker full repository run was attempted after this patch but hit the 240-second execution limit after test 446 without an assertion failure or final TAP summary; this is inconclusive, not a pass. `npm run build`, `node scripts/verify-dist.mjs`, `npm pack --dry-run` (325 files), and `node dist/index.js --version` (`1.18.0`) pass. No physical Termux validation was performed. Phase 14H remains **IN PROGRESS**; Phase 14I has not started.

---

# 2026-11-10 — Phase 14H opt-in provider trace capture and replay

Reviewed OpenCode's Claude Agent recorded-session fake-process approach (`specs/v2/claude-agent-provider.md`, `packages/core/test/plugin/provider/claude-agent/lib/fake-claude.ts`) and OpenClaude's VCR capture/normalization path (`src/services/vcr.ts`) plus request-size breakdown (`src/utils/requestSizeBreakdown.ts`). Adapted the applicable pattern to TermAgent's existing `Agent.run()` → provider-adapter boundary; no alternate provider runner, SDK, storage service, or second estimator was introduced.

Added `src/providers/trace.ts` and wired it into successful provider rounds. `TERMAGENT_PROVIDER_TRACE_DIR` opts in to atomic request-trace files containing exact provider-boundary messages/tool schemas, route/window provenance, local request-component estimates, normalized provider usage, optional provider-native count, and response/tool-call content. Capture is disabled by default, uses `0700` directories and `0600` files, writes atomically, enforces a 32 MiB record ceiling, and excludes provider configuration/credentials/endpoints. Exact prompt and response text is not scrubbed because that would invalidate exact-payload comparisons; it can contain pasted secrets or personal data and requires private handling.

Added `tools/phase14h-provider-trace-replay.mjs` and `npm run phase14h:provider-replay`. The analyzer validates the request SHA-256, recomputes TermAgent's existing `accountContext()` and message estimates, and compares those with captured provider usage and optional native counts. It reports whether provider-usage values are present, but cannot independently authenticate whether a trace came from a live provider or a synthetic/test adapter. No real live-provider trace has been collected in this environment. The clean-equivalent legacy-vs-current compaction A/B remains open because it still needs chronological production request states and deterministic recorded tool outcomes.

A review caught and corrected two overclaims before packaging: the trace metadata now distinguishes provider configuration credentials from possible secrets inside prompt/response content, and the analyzer no longer labels any file containing usage fields as intrinsically `providerBacked`.

Verification: `npm run build` PASS; provider trace focused tests **6/6 PASS**; combined Phase 14H/provider-native-count tests **37/37 PASS**; the complete repository inventory **84/84 test files, 733/733 tests PASS** when run in serial batches with zero failures. The single combined `npm test` process exceeded the available tool time limit before printing its final TAP summary; the full file set was instead executed successfully in batches. `node --check tools/phase14h-provider-trace-replay.mjs` PASS; `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (**325 package files**); `node dist/index.js --version` reports `1.18.0`; device smoke passes as Linux x64 only (`termux:false`). No physical Android/Termux run is claimed.

Phase 14H remains **IN PROGRESS**. Next: capture traces from a real configured provider, review/redact before sharing, and build a clean-equivalent replay using matching request chronology and recorded tool outcomes. Workspace-wide usage semantics, exact multimodal/framing costs, broader summary-shortening audits, 500K/1M and constrained-memory benchmarks, nested subagent scope cases, and physical Termux checks also remain open. Do not begin Phase 14I until 14H acceptance is closed.

---

# 2026-11-09 — Phase 14H durable provider-usage history projection

Adapted OpenCode's session-level usage normalization and aggregation pattern to TermAgent's existing `provider.usage` JSONL events. The aggregator validates persisted records, streams through the event list without constructing a second event-sized array, groups by provider/model (bounded to 32 route buckets plus an overflow bucket), and reports request counts, inclusive token totals, cache/reasoning/tool-use breakdowns, measured context average/peak, and weighted estimator drift. Inclusive totals remain authoritative: cache and reasoning fields are breakdowns and are never added to them again. No pricing is guessed and no cost is displayed.

The terminal `/usage` command now reads the durable event history. The existing context snapshot now includes the same per-session usage aggregate, so `/usage` in Web View and its context inspector consume the daemon's canonical projection. No new API route, data store, telemetry service, or dependency was introduced. The provider usage data remains session-scoped; workspace-wide aggregation across all sessions is still open.

Upstream review: OpenCode `packages/core/src/session/usage.ts`, `packages/core/src/session/stats.ts`, and `packages/core/test/session-stats.test.ts` (commit `2f0e2dbbff4b271b122399b89a1d8965c2a40fe0`). Adapted its normalization/additive aggregation and durable-history testing principles, not its Effect/Drizzle/SQLite implementation. OpenClaude's supplied `src/services/tokenEstimation.ts` and `src/utils/requestSizeBreakdown.ts` informed the existing provider usage and context-estimate boundaries; no second accounting system was copied. See `docs/research/PHASE14H-HISTORICAL-USAGE-AGGREGATION.md`.

Verification for this slice: TypeScript build PASS; browser JavaScript syntax PASS; combined Phase 14H, provider-native-count, HTTP SDK and Web View focused suites **42/42 PASS**. The HTTP test writes a durable usage event and verifies both the context API and initial snapshot aggregate it without double-counting. The full repository test runner did not reach a final TAP summary in this environment: the four-worker run hit a 180-second tool limit and the serial run hit a 360-second tool limit without printing an assertion failure at the point of interruption. These runs are **inconclusive**, not passes or confirmed test failures; full-suite completion remains pending. `node scripts/verify-dist.mjs` and `npm pack --dry-run` PASS (323 package files). Phase 14H remains **IN PROGRESS**.

---

# 2026-11-09 — Phase 14H provider-native input-count preflight

Reviewed OpenCode's lightweight `packages/core/src/util/token.ts` estimator and OpenClaude 0.31.0's `src/services/tokenEstimation.ts` API-count path. Implemented the optional provider-boundary pattern in TermAgent's existing Anthropic and Gemini adapters; no tokenizer dependency or parallel accounting service was introduced.

Both adapters reuse their existing request-lowering helpers and strip generation-only fields before calling the native count endpoint. Anthropic uses `/v1/messages/count_tokens` and reads `input_tokens`; Gemini uses `/v1beta/models/{model}:countTokens` and reads `totalTokens`. The Agent only preflights when the local estimate reaches 72% of usable capacity, uses the larger local/native value, passes the pre-compaction count to the durable compaction-start diagnostic, then recounts the compacted projection before generation. The compaction completion record no longer repeats the stale pre-compaction value as an after measurement. Unsupported 404/405/501 endpoints are cached per provider instance; request-specific 400s and transient errors fall back; 401/403 remain fail-fast. OpenAI-compatible gateways retain local estimates.

A review caught and corrected a diagnostic accuracy issue: the first draft copied the pre-compaction native count into the completion record's after snapshot. The final code records it only in the before snapshot; the Agent's separate post-compaction preflight is the measurement used for admission. The canonical `ChatMessage` contract remains text/tool-only, so no live image/audio/video attachment or exact media-cost claim is made.

Focused provider + Phase 14H tests: **25/25 PASS** after adding request-specific 400 retry behavior, Gemini unsupported/auth handling, and the stale diagnostic-snapshot regression. `npm run build`: PASS. Full repository suite: **726/726 PASS** with four workers (28.0s) and **726/726 PASS** serially (96.6s). `node scripts/verify-dist.mjs`: PASS. `npm pack --dry-run`: PASS (323 files; 2,161,270 unpacked bytes). `TERMAGENT_ALLOW_NON_ANDROID=1 npm run device:smoke`: PASS as a Linux x64 rehearsal only (`termux:false`). No physical Android/Termux validation was performed. Phase 14H remains **IN PROGRESS**; Phase 14I has not started.

---

# 2026-11-09 — Phase 14H continuation: request-footprint compaction diagnostics

Reviewed OpenClaude's `autoCompact.ts`, `apiMicrocompact.ts`, `microCompact.ts`, and `requestSizeBreakdown.ts`, plus OpenCode's request accounting and session compaction patterns. Kept TermAgent's existing `accountContext()`, `maybeCompact()`, compactor, `SessionStore`, tool-output archive, and `/context` command; no duplicate context or telemetry subsystem was introduced.

Automatic compaction now uses the same request-footprint estimator used while constructing provider requests, including its tool-schema and multimodal estimates, instead of a text-message/schema-only trigger. The text-history budget subtracts schemas, additional request tokens, and multimodal estimate because those costs are not shortened by the current text compactor. Trigger origin is recorded (`turn-entry`, `route-change`, `provider-request`, `post-tool-round`).

Compaction emits a durable start record and a completion record with method, reason, trigger, message/schema/multimodal/additional-token components, before/after request estimate, usable tokens, headroom, removed/pruned/retained counts, and timestamp. `/context` shows the latest completed automatic compaction. This improves diagnosis but remains heuristic rather than provider-native or exact serialized request accounting.

Added nested instruction restoration integration coverage through a fresh `Agent.run()`: saved paths restore, changed content is reloaded, and sibling instruction scopes do not leak. Added an automatic-compaction regression that retains a recent multimodal estimate while checking durable before/after headroom. Expanded repository-map stress coverage from 1,000 to **10,000 modules** / **10,002 indexed paths**.

Verification: Phase 14H continuity **16/16 PASS**; full repository suite **716/716 PASS** at four-worker concurrency (27.8s); full repository suite **716/716 PASS** at serial concurrency (82.7s); `npm run build` PASS; `node scripts/verify-dist.mjs` PASS; CLI version **1.18.0**. Earlier Phase 13I exit/order and serial-runner failures did not reproduce on these complete reruns.

Remaining 14H work: controlled clean-equivalent/provider-backed replay; native tokenizer and precise multimodal/provider framing accounting; aggregate usage analytics; broader transcript shortening and real-trace multi-cycle quality; 500K+/1M repository/context and constrained-memory benchmarks; subagent instruction/skill conflict and restart cases; physical Android/Termux validation. The image estimate is synthetic coverage of the existing accounting hook and does not establish live multimodal transport support. Phase 14H remains **IN PROGRESS**.

---

# TermAgent Progress

# Phase 14F.4 — Cross-client state convergence (2026-11-03)

- Added stable provider `callId` propagation through Agent, runtime activity callbacks, API/SSE events and terminal transcript entries. `TerminalUI.hydrate()` reconstructs assistant tool calls and joins tool-role results by `tool_call_id`; live lifecycle events update that same entry. Concurrent calls with the same visible tool name remain independent.
- Persisted `toolCallId` on permission-request event/state projections, so reconnect and terminal permission UI can associate the request with the exact provider tool call instead of guessing from tool name or latest active tool. Resolution remains on the existing durable Phase 14E.1 first-writer-wins path.
- Fixed passive attached terminal behavior: a non-TTY terminal no longer auto-denies a permission or cancels a question it cannot render. Interaction resolver state is only retired after a confirmed durable resolution/no-longer-pending state; transient errors remain retryable.
- Expanded daemon-client projection for tool lifecycle, Todo, task notifications, workflow progress, verification, workspace mutations/diff invalidation, provider status, context/checkpoints, compaction, queue changes and undo/redo reconciliation.
- Added attached-terminal `/diff`, `/tasks`, `/task-log`, `/task-output`, `/cancel`, `/interrupt`, `/checkpoint`, `/checkpoints`, `/restore` and `/branch` commands backed by existing daemon APIs. This remains a subset of standalone REPL command coverage.
- Studied OpenCode's keyed tool-part/lifecycle reconciliation, event subscription/connection patterns and server-owned-runtime/TUI-client architecture. Adapted stable call identity and reconciliation to TermAgent's existing `TermAgentClient`, JSONL durable sequence, SSE gap and snapshot model; no second runtime, event system, broker or WebSocket was added. Research: `docs/research/PHASE14F4-UPSTREAM-CLIENT-STATE-PROJECTION-ADAPTATION.md`; report: `docs/phases/PHASE14F4-CROSS-CLIENT-STATE-CONVERGENCE.md`.
- Verification: TypeScript production build PASS; focused Phase 14A–14F regression suite **66/66 PASS**; release artifact verification PASS; `dist/index.js --version` reports `1.18.0`; Web View JavaScript syntax PASS; `npm pack --dry-run` PASS (317 package files).
- Remaining: rich interactive TTY permission/question parity, two browsers plus terminal under concurrent load, attach/detach and daemon crash/restart with live clients, physical Android/Termux/Brave/Chrome tests, performance measurements and a green repository-wide test gate. Phase 14F remains OPEN.

# Phase 14F.3 — Terminal daemon client convergence (2026-11-03)

- Converted the interactive terminal entry path to discover and attach to a ready workspace server owner before constructing a local Agent runtime. The attached client validates `/api/info` plus `/health` against the registered owner ID/PID/mode/state and canonical workspace path. A race during owner acquisition rechecks and attaches to the server instead of creating a second runtime.
- Added a terminal daemon-client adapter using the existing `TermAgentClient`, command API, durable queue, JSONL sequence cursor, transient SSE frames and snapshot reconciliation. Server daemon queue workers own prompt execution; terminal prompts never call a local Agent while attached.
- Added terminal pairing with the existing one-time device code flow and persisted a workspace-bound terminal device credential under `~/.termagent/devices/` using atomic writes and POSIX 0700/0600 permissions. `/device revoke` revokes the device server-side and removes the local credential. Automatic attachment remains loopback-only; explicit remote attach is deferred.
- Routed queue edits/cancel/reorder, session operations, mode/agent metadata, interrupt/abort, compact, undo/redo, fork, permission and question responses through the daemon API. The existing TerminalUI and question/permission modals are reused. The initial daemon-client slash-command catalog is deliberately a subset of standalone REPL commands; provider/model/plugin/marketplace/theme/skills administration and some advanced terminal utilities are not yet exposed in attached mode.
- Added durable assistant-response reconciliation: if the transient stream prefix is missing or differs, replace it with the canonical persisted assistant message rather than leaving a partial response in the terminal. SSE gap frames trigger a fresh snapshot and pending interaction/queue/Todo reconciliation.
- The integration exposed a `SessionStore` nested-mutation race: process-wide mutation-depth tracking could treat unrelated concurrent worker tasks as nested and skip the file lease, leading to duplicate durable sequence numbers. Replaced it with async-call-chain-scoped `AsyncLocalStorage` reentrancy. Queue worker startup is scheduled after the `CommandLedger` transaction completes so the worker cannot race the command receipt append.
- Studied OpenCode's `service.ts`, `service-probe.ts`, Promise/Effect service lifecycle, CLI `server-connection.ts`, `service-config.ts`, and its project architecture guidance that the TUI is an HTTP/SSE client of a daemon-owned runtime. Adapted the discovery/probe/connection principles to TermAgent's existing owner lease and `TermAgentClient`. OpenClaude's supplied lockfile remained a no-op stub and was not copied. Research: `docs/research/PHASE14F3-UPSTREAM-TERMINAL-DAEMON-CLIENT-ADAPTATION.md`; report: `docs/phases/PHASE14F3-TERMINAL-DAEMON-CLIENT.md`.
- Verification: TypeScript build PASS; full Phase 14A–14F focused suite **63/63 PASS**; dedicated F3 + owner integration tests **7/7 PASS**; release artifact verification PASS; version reports `1.18.0`; Web View JS syntax PASS; `npm pack --dry-run` PASS (317 files).
- Repository-wide `npm test` remains not green: `/auto` CLI integration fails alone with actual `before\n` vs expected `after\n`; the aggregate run also showed a Phase 13G interruption assertion failure that passed when its file was rerun alone (15/15). The aggregate suite reached test 203 before the 600-second command timeout. No full-suite pass is claimed.
- Remaining: rich TTY permission/question behavior and full simultaneous-client UI parity need interactive tests; complete standalone slash-command parity, remote terminal attach, attach/detach and daemon crash/restart with live clients, two browsers + terminal, physical Android/Termux/Brave validation and a green repository-wide regression gate remain open. Phase 14F is not complete.

# Phase 14F.2 — Durable SSE tail, backpressure and transient-gap reconciliation (2026-11-01)

- Kept the daemon-owned JSONL session log and monotonic sequence as durable truth; the EventBus remains a local wakeup optimization. Added a bounded 1-second durable-tail poll so SSE also notices writes made by daemon-managed child workers that do not share the in-memory bus.
- Added an explicit overflow marker to each bounded 128-frame live subscriber buffer. The SSE stream emits a `gap` frame with `snapshotRequired` and the latest durable sequence when transient frames are dropped; the Web View reconciles from the canonical snapshot without treating the gap as a durable event.
- Added a serialized durable session-event SSE writer that waits for Node's `drain` event and stops on response close/error. Heartbeats and paired-device re-authorization now run inside the same stream loop, avoiding concurrent frame producers during replay/backpressure.
- Studied OpenCode's V2 event-stream architecture and adapted its core delivery principles to TermAgent's existing JSONL + cursor + wakeup model; no second event-feed abstraction, distributed broker, or WebSocket was added. Research: `docs/research/PHASE14F2-UPSTREAM-EVENT-STREAM-ADAPTATION.md`; report: `docs/phases/PHASE14F2-DURABLE-SSE-RECONCILIATION.md`.
- Verification: `npm run build` PASS; browser JavaScript syntax PASS; focused event stream + Web View tests **13/13 PASS**; combined Phase 14A–14F focused regression gate **58/58 PASS** (includes prior A–E.1, owner/server, and new 14F.2 coverage).
- Combined focused command: `node --test tests/phase14a-event-interaction.test.mjs tests/phase14b-event-stream.test.mjs tests/phase14c-http-sdk.test.mjs tests/phase14d-webview.test.mjs tests/phase14e-security.test.mjs tests/phase14e1-permission-resolver.test.mjs tests/phase14f-daemon-owner.test.mjs tests/phase14f-server-owner.test.mjs tests/server.test.mjs` — **58/58 PASS**.
- Release checks: `node scripts/verify-dist.mjs` PASS; `node dist/index.js --version` reports `1.18.0`; `npm pack --dry-run` PASS (313 packaged files).
- Remaining: interactive TerminalUI is still not a daemon client; canonical terminal command/event attachment, interrupt/question/permission convergence, two-browser + terminal tests, detach/reconnect/recovery through real clients, and physical Android/Termux/Brave validation remain open. Phase 14F is not complete.

# Phase 14F.1 — Exclusive daemon ownership and restart reconciliation (2026-11-01)

- Added a workspace-keyed exclusive runtime owner lease shared by `termagent --serve` and the standalone terminal entry point. Owner creation is exclusive, separate workspaces remain independent, and duplicate launches fail clearly instead of silently opening a second Agent runtime.
- Added private registration/lease files with POSIX `0700`/`0600` modes, random owner and lease identities, PID/process-start identity, owner mode, endpoint, lifecycle state and heartbeat metadata. The safe owner projection is included in authenticated `/health`; local `readDaemonOwner()` only returns a matching live process.
- Added guarded stale-owner reclaim with process identity checks, Linux/Android `/proc/<pid>/stat` start-time validation, and token-checked release so an old owner cannot delete a successor's lock.
- Made server startup acquire ownership before constructing the runtime and release it after HTTP server/runtime shutdown. Added an explicit `termagent.shutdown()` lifecycle hook.
- Made standalone TUI startup acquire the same owner lease before migrations/session/task recovery/runtime setup. Until terminal-client attachment lands, invoking the TUI while a server owns the workspace exits clearly rather than creating a duplicate runtime.
- Added owner-fenced restart reconciliation: stranded permission waits are cancelled with `daemon-restart`, unanswered questions are cancelled with a recovery client identity, and unmatched started turns get a durable `interrupted` record/event. No unfinished turn is marked successful.
- Adapted OpenCode's registration/probe/ensure/stop identity and compare-before-release patterns. Inspected the supplied OpenClaude source: its current `src/server/lockfile.ts` is explicitly an inert no-op stub and was not copied. Research: `docs/research/PHASE14F-UPSTREAM-DAEMON-OWNER-ADAPTATION.md`; report: `docs/phases/PHASE14F1-DAEMON-OWNERSHIP.md`.
- Verification: TypeScript production build PASS; focused Phase 14F tests PASS, 11/11, including concurrent owner acquisition, stale PID/PID reuse, modes, successor-safe release, interaction/turn recovery, health metadata, duplicate-server rejection and shutdown/reacquisition.
- Remaining: interactive TerminalUI is not yet a daemon client, so simultaneous terminal + browser operation is not yet supported; SSE backpressure/gap handling is now implemented and host-tested in Phase 14F.2; client attach/detach, full convergence tests, and physical Android/Termux/Brave validation remain open. Phase 14F is not complete.

# Phase 14E — Security, pairing, and remote access (2026-11-01)

- Kept Web View local-only by default. Non-loopback listeners now require explicit remote mode, TLS, and an HTTPS public origin; reverse-proxy mode can terminate TLS while TermAgent stays on loopback.
- Added one-time five-minute pairing codes, 256-bit per-device bearer credentials, 30-day expiry by default, hash-only auth-state storage, 0700/0600 filesystem modes, workspace binding, and device self-revocation.
- Bound command client identity to authenticated device IDs and enforced workspace read/write, interaction-resolution, task-control, and self-revocation scopes.
- Added strict Host/Origin checks, Fetch Metadata rejection, JSON-only mutations, no CORS or query-string tokens/cookies, per-source request/mutation/pairing limits, and bounded pairing/revocation audit records.
- Minimized API data projections: provider credentials and environment are omitted, routing/config output is allowlisted, and internal server errors are not returned over HTTP/SSE.
- Adapted OpenCode's centralized authorization + one-time pairing flow, OpenClaude's explicit bearer-header pattern, and TermAgent's existing workspace-aware API/command/event primitives. Research: `docs/research/PHASE14E-UPSTREAM-SECURITY-PAIRING.md`; full report: `docs/phases/PHASE14E-SECURITY-PAIRING-REMOTE-ACCESS.md`.
- Added six focused integration tests including a generated-cert direct HTTPS smoke test and a TLS-terminating reverse-proxy test.
- Verification: `npm run build` PASS; `node --check web/app/app.js` PASS; `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS; focused Phase 14A–14E.1 plus HTTP-server regressions PASS, 43/43.
- Aggregate `npm test` is not green: the `/auto` CLI end-to-end assertion fails with the same `Expected: after / Actual: before` result documented against the pristine Phase 14D checkpoint. The full runner exceeded 480 seconds after more than 269 tests had started; no full-suite pass is claimed.
- Limits at the Phase 14E checkpoint: no physical Android/Brave or production-network validation and no revoke-other-device UI. Phase 14F.1 now serializes server/terminal runtime startup per workspace and performs owner-fenced interaction recovery; full terminal-client attachment remains open.

# Phase 14E.1 — Server-owned permission resolver integration (2026-11-01)

- Connected the server-owned `PermissionGate` to the existing durable `SessionStore.waitForInteractionResolution()` path. Browser Allow/Once/Always and Deny now settle the exact permission wait blocking the original `ToolRegistry.execute()` call; server-owned requests no longer fall back to `readline`/`process.stdin`.
- Kept the existing durable event log and first-writer-wins store authoritative. HTTP remains a command adapter and the runtime-local event bus is only a wakeup mechanism; no second HTTP-owned promise or duplicate in-memory resolver map was added.
- Hardened interaction waiting across subscribe/read, timeout, `AbortSignal`, and simultaneous durable replies; persisted permission cancellation reasons and ensured an aborted turn cannot start the protected tool after a concurrent approval.
- Added independent fallback permission identities for concurrent calls that have no provider tool-call ID.
- Made graceful runtime close abort and await in-flight runs, including the period before `Agent.run()` starts.
- Upstream behavior study: OpenCode deferred permission requests, Cline pending approval resolvers, and the request-ID callback lifecycle in the supplied OpenClaude gRPC server. The implementation adapts the pattern to TermAgent's durable store rather than copying the upstream in-memory maps.
- Verification: `npm run build` PASS; focused `tests/phase14e1-permission-resolver.test.mjs` PASS 9/9. The aggregate `npm test` is not green: the CLI `/auto` end-to-end assertion fails identically on the pristine checkpoint, and the full runner exceeded 240 seconds. No full-suite pass is claimed.
- Remaining boundaries at this checkpoint: hard-crash orphan reconciliation was still deferred here and is now implemented after the 14F.1 owner lease; secure pairing/remote access were delivered in 14E, while physical Android/Brave validation remains open. See `docs/phases/PHASE14E1-PERMISSION-RESOLVER.md`.

## Loop safety fix

- Fixed normal Build-mode turns with no configured tool-round limit repeatedly continuing after successful work.
- Added full-input repeated-call detection plus a bounded write-only-round guard; a safety stop disables tools and requests a final text-only summary.
- Interactive configuration now defaults to 50 tool rounds while preserving explicit `0` as an unlimited escape hatch.
- Reproduced the screenshot failure with a live OpenAI-compatible SSE provider and confirmed three distinct rewrites stop on the fourth text-only turn.
- Verification: build and 181/181 tests passing.

## Phase 5 parity pass

- Fixed a real user-facing context-budget failure where generated repository/skills context could exceed the available message budget before the provider request. Dynamic context is now bounded to the computed request budget.
- Added a native interactive `/provider` manager with Set provider, Edit provider, Add provider, Remove provider, and Done actions backed by persistent profiles.
- Provider profile editing now supports real cursor movement, Delete, and Ctrl+U line clearing instead of append-only text entry.
- Exact slash commands now execute on the first Enter when the typed command is already an exact completion.
- Completed the implementation review across session/workflow, model/agent selection, input, tools, context, extensibility, API, and worker-safety behavior.
- Added interactive model, custom-agent, session, and task selection surfaces while keeping the existing `PromptEditor` and terminal renderer as the shared UI primitives.
- Added model variants, reasoning effort metadata, per-agent/per-command model selection, and opt-in per-turn smart routing.
- Added interactive question handling in the TUI plus an API/SSE question lifecycle.
- Added configurable keybindings, rule-based permission overrides, safe parallel read scheduling, bounded tool-output summarization, and context inspection.
- Fixed the fast background-worker exit race discovered by the full-suite parity regression.
- Verification after the worker fix and parity additions: full repository test gate, clean build, package dry-run, source hygiene scan, and clean extracted-artifact verification.
- Physical ARMv7/Termux runtime validation remains pending because this environment has no ARMv7 Android device.

## Phase 5 hardening

- Fixed snapshot creation with ignored build/state directories by resolving ignore rules over an explicit file candidate set and staging only allowed paths through NUL-safe pathspec input.
- Added a permanent regression covering ignored `dist/` and `.termagent/` directories during snapshot creation and restore.
- Command completion now ranks exact command triggers ahead of longer prefix matches while preserving fuzzy matching.
- Added regression coverage for `/checkpoint` versus `/checkpoints` selection.
- Verification: build, full test suite, package dry-run, and compiled CLI smoke with ignored directories.

## 1.1.5 UI architecture hardening

- Added a renderer-independent `SelectModel` based on TermAgent's focused `Select` interaction pattern.
- Kept permission selection isolated from the prompt editor so approval keystrokes cannot leak into the composer.
- Added Home/End and Space selection semantics alongside Up/Down, j/k, Enter and numeric shortcuts.
- Added a dedicated 1.1.5 UI design note.
- Added regression coverage for selection focus and submit/cancel behavior.

## 1.1.4 UI hardening

- Ported the implementation style declarative cursor approach: logical cursor state is rendered into the prompt frame instead of relying on the terminal's implicit caret.
- Consolidated prompt rendering around the shared visual-row layout used by the editor for wrapped multiline input.
- Fixed composer state so a submitted prompt is cleared before the agent turn and cannot remain as a second copy below the conversation.
- Made permission requests a true UI-owned modal/select state with exclusive stdin ownership while pending.
- Added explicit `awaiting approval` tool state so the UI never labels a tool as running before approval is granted.
- Used standard ANSI inverse-video cursor rendering for broader Termux compatibility.
- Added a permission stdin regression test covering once/always/deny selection.
- Added PTY screenshot verification at 80x24 and 60x20 for multiline cursor editing and shell approval.

## 1.1.2 UI rewrite

- Reworked interactive UI around an TermAgent-inspired separation between logical input state, visual row layout, and terminal cursor coordinates.
- Added row-diff rendering with absolute terminal coordinates to avoid line-drift and stale-prompt artifacts.
- Fixed submitted prompts being left in the input surface by repainting the editor on reset.
- Added a permission modal that owns stdin while a tool approval is pending.
- Connected `PermissionGate` to the interactive UI instead of `readline` for TTY sessions.
- Added Allow once / Always allow / Reject navigation and single-key shortcuts.
- Kept the fallback `readline` permission path for non-TTY use.

## 1.1.2

- Paused the planned 1.2 API expansion to repair the interactive TUI first.
- Replaced the interactive prompt's incremental line erasure with a persistent alternate-screen renderer.
- Added TermAgent-style session header, conversation viewport, bottom prompt surface and footer controls.
- Added TermAgent-style agent cycling (`Tab`/`Shift+Tab`) plus command/variant shortcut wiring (`Ctrl+P`/`Ctrl+T`).
- Fixed multiline backspace/delete repaint corruption by separating logical input state from terminal rendering.
- Changed Up/Down behavior to move vertically inside multiline input before falling back to history.
- Added bare Escape handling and model-turn interrupt propagation through AbortSignal.
- Prevented aborted provider calls from entering retry backoff.
- Removed the default tool-step ceiling for built-in modes; `TERMAGENT_MAX_TOOL_ROUNDS` remains available as an explicit cap.
- Changed the step boundary to a final text-only response instead of a hard tool-loop exception.
- Kept the non-TTY line-oriented execution path unchanged.

Verification target: TypeScript build, full test suite, interactive PTY smoke test, multiline editing/delete behavior, interrupt smoke test, shortcut smoke test, and uncapped/capped agent-loop regression coverage.

## 1.1.0

- Added reusable runtime composition in the corresponding module.
- Added Node built-in HTTP/SSE server in the corresponding module.
- Added server lifecycle entrypoint in the corresponding module.
- Added CLI `--serve`, `--host`, `--port`, and `--token` options.
- Added session/task/agent/skill HTTP endpoints.
- Added streamed model/tool events over SSE.
- Kept existing Agent/ToolRegistry/SessionStore/TaskManager as the execution core.
- Added server design/setup documentation.

Verification target: build, unit suite, HTTP integration, SSE integration, auth, session APIs, task APIs, and extracted-archive smoke test.

- Added zero-credential `examples/mock-provider.mjs` for real-device smoke testing.
- Added `docs/DEVICE_TEST.md` with ARMv7 Termux validation steps.

## 1.1.6 UI fixes
- Automatic slash-command picker with 8 visible filtered options and keyboard selection.
- Conversation viewport scroll with PageUp/PageDown, Ctrl+Up/Down, SGR mouse wheel, and a right-hand rail.
- Empty provider responses now retry and surface an explicit error instead of silently returning to the prompt.
## 1.1.6 verification

- `npm run build`: PASS.
- `npm test`: PASS, 41/41 tests.
- Added real prompt-level tests for automatic slash picker activation, filtering, arrow selection, and scroll key direction.
- Added conversation viewport scroll regression coverage.
- PTY verification from the compiled binary covered command picker, submission/composer reset, permission selector, and conversation scrolling.
- No runtime UI package or native terminal dependency added.

- Fixed a UI data-flow bug where streamed assistant text was received by the agent callbacks but no assistant entry was created, so the reply was invisible in the conversation.
- Final automated suite: 42/42 tests passing.
- Final PTY screenshots inspected at 80x24 and 60x20 for slash picker, submission, permission approval, and conversation scrolling.

## 1.5.0 UI interaction hardening

- Fixed command-picker navigation so the eight visible rows are only a viewport. Selection moves through the full result list and preserves the global selected index.
- Added the implementation style command palette path for `Ctrl+P`, reusing the same selection model rather than printing an unselectable command dump.
- Fixed model-turn mouse handling so touch/click sequences are ignored while mouse-wheel events still scroll the conversation. Split SGR mouse sequences are covered by regression tests.
- Added live activity phases for thinking, explicit reasoning, writing, tools, permission requests, retries, and compaction.
- Added a provider-reasoning panel that is collapsed by default and toggled with `Ctrl+E` or `/thinking`.
- Ensured streamed assistant text always materializes a visible assistant entry, fixing turns that previously received provider output but displayed no answer.
- Added explicit retry behavior for empty provider responses.
- Added independent conversation scrolling with a fixed prompt/composer.
- Added PTY screenshot verification for the command picker, filter/selection, multiline editing, mouse-safe running turns, reasoning expansion, permission approval, response rendering, and chat scrolling.
- Added a feature matrix comparing TermAgent capabilities with current TermAgents behavior and identified the remaining Q1-Q4 gaps.

### 1.5.0 verification

- `npm run build`: PASS.
- `npm test`: PASS, 49/49 tests.
- PTY screenshots manually inspected at 80x24 and 60x20.
- Slash-picker selection was exercised beyond the eighth visible row.
- `Ctrl+P` command palette was exercised with filtering and keyboard selection.
- Mouse-click interruption was exercised using SGR press/release sequences during an active model turn.
- Permission flow was exercised end-to-end with the model turn continuing after approval.
### Post-verification fix: standalone Escape handling

A final PTY pass found an input-state edge case after closing `Ctrl+P`: the terminal sends a bare ESC as an incomplete escape sequence until we can distinguish it from a split mouse/control sequence. Without a timeout, the editor could retain `escapeBuffer='\x1b'` and silently consume subsequent typed characters. The editor now promotes a lone ESC to the normal completion-close path after a short 70ms grace period, while real multi-byte terminal sequences continue through the sequence parser.

Post-fix verification:
- Rebuilt `dist` from source.
- Full `npm test`: 49/49 PASS.
- Real PTY CLI flow: `Ctrl+P` -> navigate beyond 8 rows -> filter -> Escape -> type new prompt -> submit -> active-turn mouse click -> `Ctrl+E` -> permission -> approval -> final streamed response: PASS.
- PTY raw output confirmed the post-Escape prompt text reached the model turn and the click did not generate an interrupt.
## Phase 1: Transactional turns (implemented after 1.5.0)

- Added a private Git-backed snapshot store that never touches the project's real Git index.
- Agent turns now record before/after filesystem snapshots and tag persisted messages with the turn ID.
- Added `/undo` and `/redo` to the CLI command layer and command palette.
- Added HTTP `POST /api/v1/sessions/:id/undo` and `/redo` endpoints.
- Undo/redo refuse to overwrite manual filesystem changes when the working tree no longer matches the expected turn boundary.
- Starting a new turn after undo creates a new history branch and clears the redo stack.
- Added regression coverage for restore, redo, working-tree drift, and branching.
- Verification: TypeScript build passes; all 52 tests pass.

The snapshot design is intentionally implemented using TermAgent TermAgent's snapshot/revert model rather than modifying the user's Git repository directly. TermAgent documents snapshots as the mechanism behind session undo/revert and also notes their potential indexing/disk costs, so TermAgent keeps the snapshot repository private and excludes high-noise directories such as `node_modules`, `dist`, and `.git`.
### Phase 1 hostile verification standard

Phase 1 was re-run under an adversarial test cycle instead of relying on the original happy-path regressions. The hardened suite now covers:

- concurrent snapshot creation across multiple `SnapshotStore` instances;
- concurrent turns across multiple `SessionStore` instances;
- concurrent undo requests and serialized history mutation;
- provider failure after a successful filesystem mutation;
- repeated multi-turn undo/redo, including state reconstruction after `SessionStore` recreation;
- manual working-tree drift, including files that become newly Git-ignored during a turn;
- preservation of pre-existing Git-ignored user files;
- refusal to overwrite an ignored path that blocks a snapshot-required path;
- binary files, symlinks, executable permissions, file/directory type changes, and user Git index isolation;
- working-directory/session mismatch protection;
- invalid snapshot identifier rejection;
- truncated final JSONL recovery and fatal middle-of-log corruption;
- a model-based history fuzz test of 250 randomized operations, repeated across four independent seeds;
- full project build and full regression suite after the hardening pass.

The snapshot implementation now serializes operations per snapshot store, session turns are explicitly busy while running, ignored files are preserved during restore, protected overlay snapshots prevent ignore-rule changes from bypassing drift detection, snapshot trees are recorded against Git garbage collection, and session logs tolerate a torn final line while still rejecting internal corruption. Session turn leases also serialize separate TermAgent processes and recover after an owner process dies.

During the hostile rerun we found and fixed: first-use snapshot repository initialization races; cross-process session races; catastrophic deletion of Git-ignored user files during restore; ignore-rule changes that could bypass manual-edit detection; unreferenced snapshot trees that Git GC could delete; and test/cleanup paths that were doing expensive Git maintenance on every turn.

Final hostile verification after the last fixes: 26 Phase 1 hardening tests plus 3 original Phase 1 tests pass; the actual CLI undo/redo flow and HTTP undo/redo endpoints pass; four model-based fuzz runs of 250 operations each pass; separate-process snapshot initialization, turn contention, and dead-owner recovery pass; and the full repository gate is rerun from a clean build before packaging; the final repository gate is 79/79 tests with a clean TypeScript build, followed by archive extraction and smoke verification.

This test discipline is now the Phase standard for subsequent work: resulting behavior is inspected first, adversarial regressions are added before declaring a phase complete, concurrency and recovery are tested explicitly, stateful features get model-based stress coverage, and the entire repository is rebuilt and re-tested after the final fix.
## Phase 2: Context intelligence

Implemented after the hardened Phase 1 baseline. The change stayed within TermAgent's dependency-light Node/ANSI architecture and did not add native runtime dependencies.

### Repository map and retrieval

- Added cached per-file analysis under `~/.termagent/repomap-cache` with atomic cache writes and invalidation.
- Added NUL-safe Git/ripgrep enumeration with a Node filesystem fallback.
- Added TypeScript/JavaScript/Python symbol extraction for functions, classes, interfaces/types/enums/variables/methods plus imports and references.
- Added CommonJS, combined/default/named/namespace/side-effect JavaScript imports and Python relative/package imports.
- Added import-alias usage references, IDF-weighted dependency edges, and PageRank-style structural ranking.
- Added fused lexical/content/symbol/graph retrieval with file, UTF-8 byte, and token bounds plus focused-file/focused-symbol selection.
- Added the `repo_map` read-only tool and `/repomap` CLI surface with token/focus/stats/invalidation controls.

### Context budget and compaction

- Added conservative Unicode-aware token estimation and request-budget calculation.
- Agent now estimates the complete request, including the newly persisted user prompt and tool schemas, before provider execution.
- Added deterministic structured compaction with objective/details/work-state/next-move/relevant-file sections.
- Recent user/assistant/tool units are kept atomically, tool errors are preserved, and previous compaction summaries roll forward into later summaries.
- System instructions are preserved exactly when they fit; irreducible system/schema overflow fails before provider execution rather than truncating instructions.
- Server and background-agent runtimes now pass the same compaction configuration knobs as the CLI.

### Phase 2 verification

The phase was stress-tested beyond the original happy paths. Targeted context tests cover cache reuse/invalidation, content-only retrieval, symbol-centered retrieval, graph neighborhoods, aliases, side-effect/CommonJS/Python imports, same-name graph explosion, Unicode byte bounds, pathological analyzer caps, corrupted caches, concurrent cache builds, repeated compaction, tool-call/result atomicity, prompt-added overflow, system/schema overflow, and rolling-summary preservation. CLI `/repomap` and the `repo_map` tool are exercised end-to-end.

Final repository gate after a clean build: **118/118 tests passed**, with zero failures, skips, cancellations, or TODO tests. The complete suite includes the Phase 1 hostile verification set plus the Phase 2 context and integration regressions. The release archive was then smoke-checked after extraction.

### Bugs found and fixed during the Phase 2 hostile pass

- content-search parsing that incorrectly handled ripgrep NUL records; fixed by using newline-safe content matching while retaining NUL-safe repository enumeration;
- compaction summaries that could consume the recent tail; fixed by reserving recent context before sizing the summary;
- repeated compaction that dropped earlier summaries; fixed by folding the previous summary into the next summary source;
- imported-name ambiguity that caused noisy same-name graph cross-talk; fixed by resolving imports to their actual target definitions;
- import aliases omitted from weighted usage references; fixed by recording alias usages;
- CommonJS and Python package/relative imports missing from graph edges; fixed with explicit resolvers;
- size/mtime-only cache invalidation that missed same-size edits with restored mtimes; fixed with ctime in the cache key/validation;
- context checks that ignored the newly submitted user prompt; fixed by persisting it before preflight compaction;
- tool/schema overflow paths that could reach the provider; fixed with a hard preflight failure;
- compaction that could split tool-call/result pairs; fixed with atomic tool units;
- UTF-16 string-length budgeting that violated UTF-8 byte limits; fixed with byte-accurate accounting and safe truncation;
- pathological files able to generate unbounded symbol/reference arrays; fixed with per-file analysis caps;
- repository-map output capable of exceeding its requested token budget; fixed with estimator-based rendering bounds.

The Phase verification standard remains mandatory for later phases: inspect the relevant implementation first, adversarial regressions, concurrency/recovery where relevant, stateful fuzzing, resource/platform checks, full rebuild, full suite, and extracted-artifact smoke verification.
## Phase 3: Execution intelligence

- Added a persisted autonomous workflow controller with planning, building, verification, iteration, complete, and blocked states. Completion requires a real successful verification result.
- Added repeated-tool/no-progress guards and bounded autonomous step and verification-failure limits.
- Added phase-aware tool filtering and a second execution-time authorization check.
- Added cross-process-safe TaskManager state updates and TaskEventLog sequence allocation with stale-lock recovery.
- Added per-session TodoWrite state with cross-process read-modify-write serialization.
- Added bounded `parallel_agents` scheduling with explicit in-project, non-overlapping workspace scopes, a four-agent session cap, and cross-process admission locking.
- Scoped workers cannot recursively launch agent workers and cannot use arbitrary shell or Git tools; file-writing tools enforce scope boundaries.
- Added structured verification results and automatic verification-command detection for Node, Make, Python, Rust, and Go with bounded timeouts.
- Added role-aware provider routing for planning, building, verification, and subagent work while retaining no-fallback-after-output and permanent-error behavior.

### Phase 3 hardening findings

- Fixed terminal-state mutation, verification-failure transition ordering, cross-process TodoWrite lost updates, scheduler TOCTOU admission races, provider adapter/model deduplication, out-of-project parallel scopes, task event sequence races, and stale state-lock recovery.
- The adversarial suite covers state corruption, randomized workflow transitions, cross-process persistence, stale owners, scope violations, recursive worker suppression, provider fallback boundaries, actual local OpenAI-compatible streaming, verification timeouts, and full autonomous lifecycle enforcement.

### Phase 3 verification target

The phase must pass the full `docs/PHASE_TEST_STANDARD.md` gate: clean build, targeted execution tests, full repository suite, real CLI/API surfaces where affected, cross-process stress, and an extracted archive smoke check.

### Phase 3 final hardening pass

The execution layer was re-run under the standing Phase test standard after the initial implementation, including focused lifecycle tests, process-boundary stress, failure injection, provider-routing integration, and real CLI execution.

Additional bugs found and fixed after the first green Phase 3 run:

- Background shell tasks did not persist their worker PID immediately, leaving task status vulnerable to stale `queued` state and making recovery unreliable.
- Worker spawn failures could leave durable tasks permanently queued. Worker launch now waits for the process `spawn` event, persists the PID before returning success, and marks failed launches explicitly.
- Orphaned queued tasks without a PID are now converted to explicit failures during startup recovery instead of remaining indistinguishable from live work.
- Partial `parallel_agents` launches now roll back every task created by the failed launch so a mid-batch spawn failure cannot leave a mixture of queued/running zombies.
- Provider routers cannot be persisted as a fake worker provider. Background and parallel agent tools resolve the concrete `subagent` provider before writing durable task state, so workers can reconstruct the provider in a separate process.
- CLI and server startup now construct the provider router before registering background/parallel agent tools, preventing those tools from accidentally capturing the pre-routing provider instance.

Final Phase 3 verification:

- Clean TypeScript build: PASS.
- Focused Phase 3 execution + CLI end-to-end tests: 34/34 PASS.
- Full repository suite after the final fixes: 149/149 PASS, zero failures/skips/cancellations.
- Stateful workflow fuzzing: four independent seeds, 500 transitions per seed, all invariants preserved.
- Cross-process TodoWrite, task-event, scheduler admission, task-update, stale-lock recovery, and worker-state tests: PASS.
- Real local OpenAI-compatible SSE streaming through provider routing: PASS.
- Real CLI `/auto` lifecycle with file mutation and detected project verification: PASS.
- Provider-routing persistence tests for background and parallel workers: PASS.
- The final source tree is archived and will be rebuilt/tested again after extraction before release.

## Phase 4: Interaction, API, and SDK

- Added bounded prompt history search and reverse-history navigation.
- Added prompt-local undo/redo with bounded edit history and draft replacement resets.
- Added Vim insert/normal editing for the terminal prompt, including Unicode-safe deletion.
- Added external-editor prompt composition using `$VISUAL`/`$EDITOR`, safe argument splitting, mode-600 temp files, and conversation export.
- Added durable cross-process prompt stash and queue state with atomic writes and stale-lock recovery.
- Added richer tool-step presentation and bounded per-file Git diff rendering with statistics and UTF-8 byte limits.
- Added structured task list/detail formatting and terminal task inspection support.
- Added session, task, model, agent, skill, and tool discovery endpoints.
- Added session status, diff, durable event pagination, and long-lived SSE event streaming.
- Added streaming prompt events for reasoning, text, tool start/end, completion, and errors.
- Added a dependency-free typed JavaScript client under `termagent/client` with cancellation-aware streaming readers.
- Added package versioning, declaration output, public package metadata, contribution/security/conduct documents, and Phase 4 API/interaction documentation.
- Removed external project names from repository source/docs and added a release regression that scans the complete tree.

### Phase 4 hardening findings

- Fixed provider configuration defaults being captured at module import, which caused multiple runtimes in one process to reuse stale endpoints.
- Fixed queued task cancellation being overwritten by late worker startup/final status updates; cancellation is now terminal.
- Fixed worker PID persistence and spawn failure handling, including orphaned queued-task recovery and partial parallel-launch rollback.
- Fixed background/parallel worker provider persistence so durable tasks reconstruct concrete providers rather than transient router objects.
- Fixed package client export regression coverage for conditional `types` + `import` exports.
- Fixed SDK stream cleanup so early iterator termination cancels the underlying response reader.
- Fixed safe UTF-8 diff truncation when ANSI color output is enabled.
- Fixed draft queue persistence with atomic writes and cross-process leases.
- Fixed external editor command parsing so quoted editor commands do not require a shell.

### Phase 4 verification

- Clean TypeScript build: PASS.
- Full repository test suite: **161/161 PASS**, zero failures/skips/cancellations.
- Interactive CLI regressions for history, Vim, stash/queue, diff, details, palette, scrolling, reasoning, permissions, and undo/redo: PASS.
- HTTP API and client SDK tests including paged events, model/tool/agent discovery, prompt SSE, cancellation, and stream cleanup: PASS.
- Cross-process prompt queue, task cancellation, worker lifecycle, and scheduler tests: PASS.
- Real local OpenAI-compatible HTTP/SSE provider exercise through the runtime/router: PASS.
- Repository independence scan including generated `dist`: PASS; no prohibited external project names remain.
- `npm pack --dry-run`: PASS; package contains runtime, declarations, documentation, and no development test tree.
- Final extracted-archive build/test smoke check is required before release.

## 1.8.0 Phase 1 — plugin contract and compatibility layer (historical)

- Added the corresponding module for plugin manifest/package metadata types.
- Added the corresponding module for compatible `.claude-plugin/plugin.json` parsing plus native `.termagent-plugin/plugin.json` support.
- Added the corresponding module for metadata-only package discovery from project, user, and configured plugin roots.
- Legacy `.js`/`.mjs` plugin execution remains unchanged; manifest discovery never imports executable package files.
- Added plugin-root-relative path validation, duplicate component-path detection, metadata/identity checks, dependency identifier validation, and dual-manifest ambiguity rejection.
- Added `docs/PHASE8-PLUGIN-MARKETPLACE.md` and copied the complete research implementation plan to `PLUGIN-MARKETPLACE-IMPLEMENTATION-PLAN.md` so a future chat can resume from the same roadmap.

### Phase 1 brutal verification

- `npm run build`: PASS.
- Focused plugin manifest suite: PASS, 10/10 tests.
- Full repository suite: PASS, 200/200 tests.
- `npm pack --dry-run`: PASS, package contains the new compiled plugin manifest modules and phase documentation.
- CLI smoke: `node dist/index.js --version` => `1.8.0`; help output PASS.
- Source-hygiene scan over executable source/tests/config: PASS.
- Real package extraction smoke: PASS; extracted `dist/plugins/loader.js` successfully discovered and parsed a plugin manifest without executing a sibling `index.mjs`.
- Adversarial checks covered traversal, absolute/Windows paths, duplicate component paths, malformed identity/version/author metadata, dual manifest ambiguity, malformed package isolation, and non-execution during discovery.

## Historical resume point after Phase 1

The 1.8.0 Phase 1 checkpoint above is retained as historical context. The active baseline is now documented under the 1.9.0 Phase 2 section below.

## 1.9.0 Phase 2 — marketplace sources, cache, and installation

Phase 2 was implemented after a fresh implementation review of marketplace state, caching, and installation helpers and current the plugin system resolution/metadata patterns. The implementation is intentionally smaller and dependency-free for ARMv7/Termux.

### Implemented

- Added the corresponding module with marketplace/plugin source unions, manifest, persisted registration, installed-plugin, lifecycle-state, and progress types.
- Added the corresponding module with compatible marketplace validation, GitHub/git/URL/directory/file retrieval, shallow/recorded/sparse Git checkout, private persistent state, atomic JSON writes, refresh, removal, and reconciliation.
- Added the corresponding module with explicit third-party confirmation, local/remote Git plugin materialization, safe source-root containment, symlink rejection, manifest validation, content SHA-256, revision tracking, idempotent installation paths, update detection, remove, broken, and orphaned states.
- Kept npm/pip plugin sources catalog-visible for manifest compatibility but deferred their executable installation to the later dependency/update phase.
- Kept remote JavaScript execution out of the marketplace install path. The existing legacy `.js`/`.mjs` loader remains the only executable plugin compatibility path in this phase.
- Aligned storage with the rollout plan: marketplace registrations/cache under `~/.termagent/marketplaces/`, installed state/cache under `~/.termagent/plugins/`.
- Added `tests/plugin-marketplace-phase2.test.mjs` with 12 adversarial tests.

### Focused verification

- `npm run build` — PASS.
- `node --test --test-concurrency=1 tests/plugin-marketplace-phase2.test.mjs` — 12/12 PASS.
- `npm test` — 212/212 PASS.

### Phase 2 brutal verification

- `npm run build`: PASS.
- Focused marketplace/install suite: PASS, 12/12 tests.
- Full repository suite: PASS, 212/212 tests, zero failures/skips/cancellations.
- `node dist/index.js --version`: `1.9.0`.
- CLI help smoke: PASS.
- Source-hygiene scan over executable source/tests/config: PASS; no prohibited external-project references.
- `npm pack --dry-run`: PASS; package includes the compiled marketplace/install modules and phase documentation.
- Actual npm package extraction smoke: PASS; extracted CLI and marketplace API were loaded successfully.

### Resume point

TermAgent baseline is now `1.10.0`, Phase 1, Phase 2, and Phase 3 are complete. The next phase is Phase 4: explicit skill loading and agent discovery.
## 1.10.0 Phase 3 — skill catalog and descriptor index

Implemented the corresponding module and converted runtime/REPL/worker skill context to descriptor-only listings. The catalog discovers project/global skills, local plugin package skills, and installed marketplace plugin skills. Plugin IDs are namespaced as `<plugin>@<marketplace>:<skill>`. Realpath-based traversal prevents symlink cycles and ignores skills that resolve outside their configured root. Each index entry fingerprints resolved path + size + mtime + SHA-256 digest, with parsed frontmatter metadata and warnings retained only in `SkillDetails`.

The previous the corresponding module remains as a descriptor-only compatibility wrapper. Full `SKILL.md` bodies are no longer used for automatic prompt selection. The runtime no longer registers the old per-skill body-loading tool. Phase 4 remains responsible for `search_skills`, `use_skill`, `/skill`, and explicit/mid-turn skill loading.

### Phase 3 focused verification

- `npm run build`: PASS.
- Skill catalog suite: PASS, 13/13.
- Legacy skills regression updated for descriptor-only behavior: PASS, 1/1.

### Phase 3 release checkpoint

The implementation and focused tests are complete. Final release gating below records the complete verification before the Phase 4 handoff.
## 1.11.0 Phase 4 — explicit skill loading and agent discovery

Implemented the Phase 4 runtime on top of the 1.10.0 `SkillCatalog`. Added the corresponding module for deterministic thresholded descriptor search and the corresponding module for exact body loading with root containment and SHA-256 verification. Replaced the legacy skill tool surface with two shared tools: `search_skills` and `use_skill`.

The agent now performs turn-zero user-input discovery and mid-turn write-pivot/subagent-spawn rediscovery, updating the system prompt with descriptor metadata only. Explicit `/skill <id> [args]` invocation uses the same live loader and suppresses automatic rediscovery so the loaded `SKILL.md` cannot become a recursive search query. Plugin skill names use the Phase 3 namespace format. Search/load/skip decisions are persisted as `skill.search`, `skill.load`, and `skill.skip` session events. Full `use_skill` output bypasses generic tool-result summarization so loaded instructions remain intact.

A final hardening adjustment records `skill.skip` when a direct `/skill` invocation fails before loading, preserving a complete decision trail.

### Phase 4 focused verification

- Phase 4 skill discovery suite: PASS, 12/12.
- Full repository suite after the final Phase 4 code changes: PASS, 237/237.
- Clean TypeScript build: PASS.

### Phase 4 final release checkpoint

- Clean TypeScript build: PASS.
- Phase 4 focused skill-discovery tests: 12/12 PASS.
- Full repository suite after the final Phase 4 code and version changes: 237/237 PASS, zero failures/skips/cancellations.
- Release/source-hygiene hardening suite: 6/6 PASS.
- CLI version smoke: PASS, reports 1.11.0.
- npm pack dry-run: PASS, 197 package files.
- Actual npm package extraction: PASS.
- Extracted artifact API smoke: PASS for `SkillCatalog` search/invocation modules and the two shared skill tools.
- Final project archive integrity: PASS.

Phase 4 is complete. The next phase remains Phase 5 plugin component integration and is not started by this checkpoint.

## 1.12.0 Phase 5 — plugin component integration

Implemented the installed-plugin component activation layer on top of the 1.9 marketplace installation state. the corresponding module loads only durable `installed` records, verifies the package manifest name matches the installed-state identity, resolves component paths inside the installed-plugin root, and processes records in deterministic plugin-ID order. Commands and agents are merged with TermAgent's existing custom definition path and are namespaced to the plugin so identical filenames across marketplaces do not collide.

Plugin MCP servers are converted into TermAgent's existing stdio MCP configuration and retain plugin ID/name/marketplace/server provenance through `MCPClient` and into each generated tool. Declarative command hooks are loaded from `hooks/hooks.json` and manifest hook declarations, receive JSON context on stdin plus plugin-root/event environment variables, and run through the existing `PermissionGate`. A failing `PreToolUse` hook blocks the underlying tool; post-tool and lifecycle failures are isolated to hook status handling. Arbitrary JavaScript from marketplace packages is not imported, preserving the separate trust boundary for executable legacy plugins.

Additional hardening added before the final gate: manifest/state identity mismatch now blocks activation, and installed plugin iteration is deterministic regardless of JSON insertion order. Focused tests cover namespacing, executable-entrypoint non-import, MCP provenance, permission propagation, pre-tool blocking, command allowlists, agent disallow lists, sibling failure isolation, and manifest identity mismatch.

### Phase 5 focused verification

- Build: PASS.
- Phase 5 component suite: **12/12 PASS**.
- Full repository suite: **248/248 PASS**, zero failures/skips/cancellations.
- Release/source-hygiene hardening suite: **6/6 PASS**.

### Phase 5 final gate

The implementation remains declarative for marketplace plugins. Plugin dependency resolution/install ordering remains Phase 8; trust/integrity policy hardening remains Phase 7; manager UI and enable/disable flows remain Phase 6.
## 1.13.0 Phase 6 — plugin/marketplace TUI

Phase 6 is complete. The terminal UI is implemented as the corresponding module on top of the existing ANSI/VT `TerminalUI`. It provides `/plugins`, `/marketplace`, and `/skills` flows, bounded keyboard navigation, page-up/page-down, search, nested marketplace plugin details, trust/remove confirmations, enable/disable, mouse click/wheel input, and responsive 60x20 metadata compaction.

The UI is intentionally callback-driven: marketplace/plugin/skill persistence and component activation stay in the previously completed Phase 2-5 services. `TerminalUI.openPluginManager()` establishes modal ownership, disables editor focus, and restores raw-mode state on exit. The plugin manager input parser buffers split SGR/X10/CSI sequences so mouse packets cannot leak their numeric bytes into section switching or prompt input.

### Phase 6 focused verification

- 14/14 UI-focused regression tests passed.
- Covered list/detail rendering, 60x20 and 80x24 constraints, long-name clipping, pagination, search, plugin enable/disable, trust confirmation, remove cancellation, marketplace plugin selection, SGR/X10 mouse handling, mouse wheel movement, split escape-sequence buffering, and skill detail inspection.

### Screenshot QA

- `01-plugin-list-60x20.png`: plugin list/footer and long-name clipping.
- `02-plugin-detail-80x24.png`: revision/digest/component detail layout.
- `03-trust-confirm-60x20.png`: install trust confirmation at narrow width.
- `04-skill-detail-80x24.png`: skill provenance and SHA-256 detail.
- `05-marketplace-detail-80x24.png`: marketplace metadata and plugin browser.
- `06-marketplace-plugin-detail-80x24.png`: nested marketplace plugin detail.
- `07-marketplace-detail-60x20.png`: compact small-terminal marketplace layout after visual correction.
- `08-remove-confirm-60x20.png`: destructive-action confirmation at narrow width.

### Phase 6 final gate

- Build: PASS.
- Full repository suite: **263/263 PASS**.
- Release/source-hygiene suite: **6/6 PASS**.
- CLI version: **1.13.0**.
- Package dry-run and extracted-package API/CLI smoke: PASS.
- Final archive integrity: PASS.

Phase 7 followed this completed Phase 6 boundary.
### Phase 7 completed — trust, integrity, and supply-chain hardening

TermAgent 1.14 implements the security boundary planned for the plugin marketplace and skill systems. Plugin installs now carry deterministic content digests and Git revisions; remote marketplace caches are verified before use; reserved marketplace names are checked against exact official-source identity; trust approvals persist only for an exact source/digest/revision tuple; local blocklists and revocations are enforced at install and activation boundaries; installed components use realpath containment; and skills are scanned for hidden/role-injection/exfiltration/execution patterns before descriptor exposure and body loading.

The security policy is stored atomically under `~/.termagent/plugins/security.json` with private permissions. Policy corruption fails closed. The Phase 7 code intentionally does not add a remote security-feed dependency.

Focused Phase 7 adversarial coverage now includes 13 tests for reserved-name URL impersonation, hostile manifests, marketplace cache tampering, exact trust persistence/invalidation, installed digest tampering, source and installed-root symlink escapes, revocation/blocklists, skill Unicode/role/exfiltration/concealed-execution scanning, warning-only Unicode confusables, and corrupted security policy.

Release gate completed:

- `npm run build` — PASS.
- `npm test` — **276/276 PASS**.
- `tests/plugin-security-phase7.test.mjs` — **13/13 PASS**.
- `tests/phase4-release-hardening.test.mjs` — **6/6 PASS**.
- `node dist/index.js --version` — `1.14.0`.
- `npm pack --dry-run` — PASS; final package contains 219 files.
- Extracted npm package CLI/security API smoke — PASS.
- Source-hygiene scan — PASS.
- Final ZIP integrity and extracted-release smoke — PASS.

## 1.15.0 Phase 8 — dependency resolution, updates, and reconciliation

Phase 8 adds the plugin lifecycle layer. the corresponding module performs deterministic metadata-only dependency resolution, preserving dependency-first install order, detecting cycles and missing dependencies, qualifying bare references against their declaring marketplace, and blocking cross-marketplace dependencies unless the root marketplace explicitly allowlists the destination. the corresponding module serializes lifecycle mutations and treats multi-plugin installation as a transaction, restoring the previous installation metadata snapshot and removing only paths introduced by the failed transaction.

the corresponding module runs before component discovery at startup. It removes abandoned marketplace/plugin staging directories, re-evaluates installed records against current marketplace entries and on-disk content, preserves explicit orphaned state for deleted marketplace entries, and marks enabled plugins with unsatisfied dependencies as broken. `update-available` remains an active pending-replacement state so current commands/agents/MCP/hooks/skills do not disappear before the replacement is installed.

the corresponding module refreshes only marketplaces with auto-update enabled and then updates enabled plugins in deterministic marketplace/plugin-ID order. Official the the marketplace implementation names use the established safe default policy; third-party marketplaces default to off. `TERMAGENT_AUTO_UPDATE=0|false|off|no` disables the background updater globally.

### Phase 8 focused verification

- Phase 8 lifecycle suite: **12/12 PASS**.
- Coverage includes deterministic dependency order, cycles, missing dependencies, root-scoped cross-marketplace allowlists, transactional rollback, concurrent installs, pending-update activation, orphan/dependency reconciliation, stale stored revisions, interrupted staging cleanup, marketplace auto-update configuration, local update application, and global auto-update disablement.

### Phase 8 final release gate

- `npm run build` — PASS.
- `npm test` — **288/288 PASS**, zero failures/skips/cancellations.
- `tests/phase4-release-hardening.test.mjs` — **6/6 PASS**.
- `node dist/index.js --version` — `1.15.0`.
- `npm pack --dry-run` — PASS; package contains **225 files**.
- Actual npm package extraction — PASS; extracted CLI reports `1.15.0`; dependency resolver module imports successfully; Phase 8 documentation is present.
- Source-hygiene scan — PASS; no `node_modules` tree or package entries.

Phase 8 is complete. Phase 9 remains untouched.

## 1.16.0 Phase 9 — context-budget and performance optimization

Phase 9 is complete. Context budgeting now reserves explicit space for tool schemas, project instructions, repository context, skill descriptors, and explicitly loaded skill bodies. Tool schemas are compacted deterministically before provider requests, while catastrophically oversized single definitions fail before execution. Per-round workflow notices are also fitted into the remaining request budget.

Skill indexing is now metadata-first on warm builds: unchanged files reuse previously parsed descriptors/security findings/digests without re-reading `SKILL.md`. Concurrent catalog loads share one in-flight build, catalog generations drive deterministic search-cache invalidation, and project/search caches are bounded to protect long-lived Termux processes. The CLI no longer eagerly scans the complete skill catalog at startup; `/skills` loads it on demand. No remote prefetch was introduced.

Model-facing `use_skill` output is bounded with head/tail preservation, while direct `loadSkill()` still returns the exact full body after live digest/security verification. The existing tool registry now caches rendered raw schemas until a tool is added/replaced.

### Phase 9 performance fixtures

- 10 skills: cold ≈ 11.1 ms, warm ≈ 2.7 ms.
- 100 skills: cold ≈ 28.6 ms, warm ≈ 15.8 ms.
- 1,000 skills: cold ≈ 229.8 ms, warm ≈ 129.9 ms.
- 300 plugin packages: discovery completed without errors in well under the 10 s fixture ceiling.
- Low-memory run: Phase 9 suite passed with Node `--max-old-space-size=64`.

### Phase 9 focused verification

- Phase 9 context/performance suite: **10/10 PASS**.
- Full repository suite: **298/298 PASS**.
- Low-memory Phase 9 suite: **10/10 PASS**.
- Release/source-hygiene suite: **6/6 PASS**.

### Phase 9 final release gate

- `npm run build` — PASS.
- `npm test` — **298/298 PASS**, zero failures/skips/cancellations.
- `node dist/index.js --version` — `1.16.0`.
- `npm pack --dry-run` — PASS; package contains **226 files**.
- Actual npm package extraction/smoke — PASS; extracted CLI reports `1.16.0`; catalog module loads and exposes Phase 9 stats.
- Final ZIP integrity/extracted-release smoke — PASS after final archive creation.

Phase 9 completes the context/performance boundary. Phase 10 remains untouched.

## 1.17.0 Phase 10 — pure skill registry support

Phase 10 implementation is complete in the current workspace.

### Implemented

- Added the corresponding module with a transport-independent `SkillRegistryProvider` contract and the production HTTP provider.
- Added registry state, installed-skill state, trust approvals, revocations, registry/skill caches, stale-state tracking, and atomic persistence under `~/.termagent/skill-registries/`.
- Added array-root and object-root registry parsing, strict namespace/name/version/trust/digest validation, relative remote source resolution, bounded remote reads, timeout handling, HTTPS enforcement, localhost HTTP fixtures, and redirected-response revalidation.
- Added exact SHA-256 verification for registry metadata and `SKILL.md` content, plus frontmatter name/version identity checks.
- Added offline last-known-good registry caching with stale metadata detection and explicit `allowStale` installation override.
- Added persistent exact-match trust approval and revocation state, including fail-closed revocation fetch behavior when no known-good cache exists.
- Added pure-skill installation that does not touch plugin installation state or executable plugin permissions.
- Added symlink/root containment protection for cache and installed skill paths and live verification before invocation.
- Added `registry` provenance to the shared `SkillCatalog` and live registry revocation/digest/security checks in the corresponding module.
- Added `/skill-registry` and `/skills` registry-management commands.
- Reused the existing module so remote registry skills are scanned with the same content-security boundary used by local and plugin skills.
- Updated the registry catalog warm path to reuse prior indexed registry descriptors when file metadata is unchanged.
- Added 17 focused Phase 10 regression tests covering transport, parsing, integrity, trust, revocation, stale/offline behavior, cache tampering, symlink containment, path-state tampering, redirect validation, and remote size limits.

Phase 10 is not considered complete until the documentation, full suite, build, package dry-run, source-hygiene scan, and extracted release smoke tests below all pass.

### Phase 10 final release gate

- `npm run build` — PASS.
- `npm test` — **315/315 PASS**, zero failures/skips/cancellations.
- `tests/skill-registry-phase10.test.mjs` — **17/17 PASS**.
- `tests/phase4-release-hardening.test.mjs` — **6/6 PASS**.
- `node dist/index.js --version` — `1.17.0`.
- `npm pack --dry-run` — PASS; package contains **229 files**.
- Actual npm package extraction/smoke — PASS; extracted CLI reports `1.17.0`, public registry provider/installation exports load, and Phase 10 documentation is present.
- Source-hygiene scan — PASS; no `node_modules` tree in the release workspace.
- Final ZIP integrity and extracted-release smoke — PASS after final archive creation.

Phase 10 completes the pure-skill registry boundary. Phase 11 remains untouched.
## 1.18.0 Phase 11 — release hardening and migration

Phase 11 implementation is complete. Legacy project/global skill roots and `.termagent/plugins` are adopted in place, while legacy configuration aliases are migrated into canonical `plugins` and `skillPaths` fields. Project/global configs are backed up before edits, migration state is stored atomically in `~/.termagent/migrations.json`, and repeated startup runs are idempotent.

`/doctor` and `termagent --doctor` now expose structured health checks for environment, configuration, migration state, marketplaces, plugin lifecycle/security state, pure skill registry health, skill catalog health, and storage permissions. `--json` emits the same report for automation. Doctor reports malformed migration state as an error without crashing the command.

Phase 11 adds full authoring documentation and checked-in examples, plus an isolated E2E lifecycle covering marketplace/plugin install, enablement, discovery, invocation, update, disablement, and removal. A release-surface regression suite also checks global config migration, configured skill-path discovery, doctor JSON, diagnostics on corrupted migration state, and authoring fixtures.

The phase is complete only after the final build, focused suite, full repository suite, release hardening suite, package dry-run, source-hygiene scan, actual npm extraction/smoke, final ZIP integrity check, and independent extracted-release smoke all pass. Phase 12 remains untouched.

## 1.18.0 Phase 13M-P3 — semantic no-progress detection

Phase 13M-P3 is complete at the subphase level. the corresponding module now projects cumulative semantic repository/execution state instead of deriving progress from tool-result text or transport references. The projection covers exploration discovery/read coverage/searches/symbols, Todo state, mutation evidence, task lifecycle state, and autonomous workflow state, then canonicalizes and SHA-256 hashes that projection.

The semantic projection intentionally excludes `tool-output://` references, managed output paths, call/turn IDs, generated Todo/task/child-session IDs, timestamps, and workflow loop counters. Equivalent searches are collapsed by semantic query/path/result evidence instead of raw tool arguments. Restored `ExplorationState` coverage is authoritative across Agent turn boundaries even though `FileReadStateCache` is recreated per run, so a fresh process cannot manufacture progress by rereading already-covered ranges.

The agent recomputes the semantic fingerprint after every provider/tool round. A changed fingerprint counts as meaningful progress; an unchanged fingerprint enters the existing semantic loop guard. Raw identical-call and prolonged read-only guards remain independent backstops.

### Phase 13M-P3 verification

- `tests/agent/phase13m-p3-semantic-progress.test.mjs` — **6/6 PASS**.
- Combined Agent/P2/P3 regression — **32/32 PASS**.
- Full Phase 13 A-L + P2 + P3 suite — **151/151 PASS**.
- `npm run build` — **PASS**.
- Generated JavaScript syntax — **124/124 PASS**.
- `npm pack --dry-run` — **PASS** with `TERM=xterm` in the non-TTY verification environment.

The repository-wide `npm test` aggregate still does not reach a clean completion. The latest run timed out after reaching test 364 and exposed eight pre-existing/unrelated failures in `/auto` E2E, Phase 12F resize, Phase 2 context/tool-budget tests, a Phase 13F diff test, client SDK contract, and the source external-name hygiene test. Those failures are retained as separate rollout-gate work and are not being counted as P3 failures.

Detailed implementation and design and implementation notes are in `docs/research/PHASE13M-P3-SEMANTIC-PROGRESS.md`.

## Phase 13M-P4 — Exploration intervention policy

- Added a three-stage semantic exploration intervention ladder: first no-progress round produces a strategy-change nudge, the second constrains the redundant exploration action on the next model turn, and the third stops the exploration subtask with a bounded evidence summary.
- Reused the existing `ToolLoopGuard` rather than adding a parallel loop detector. Constrained exploration identity is semantic for `read_file`, `grep`, `glob`, and `repo_map`, so cosmetic probe/output arguments cannot bypass the intervention while legitimate ranges and queries remain available.
- Intervention notices remain transient model-context messages and are not persisted as session history. Meaningful semantic progress clears previous constraints.
- Added bounded specialized-agent configuration through `TERMAGENT_SEMANTIC_NUDGE_THRESHOLD`, `TERMAGENT_SEMANTIC_CONSTRAIN_THRESHOLD`, and `TERMAGENT_SEMANTIC_LOOP_THRESHOLD`; semantic stop thresholds are capped at 12.
- Added focused P4 tests covering escalation, reset, legitimate alternative ranges/searches, bounded configuration, bounded/evidence-rich messages, real Agent enforcement, and transient-notice persistence behavior.
- Verification: Phase 13A-L + P2 + P3 + P4 focused tests 177/177; frozen UI/PTy regression 45/45; production TypeScript build PASS; generated production JavaScript syntax 125/125 PASS; `npm pack --dry-run` PASS.
- Repository-wide `npm test` remains a gate blocker because the aggregate run still encounters previously known failures in `/auto`, Phase 12F resize, multiple Phase 2 context tests, and Phase 13F diff behavior and then times out before completing the complete suite. P4 is therefore implementation-complete but not phase-gate-complete.
## 1.18.0 Phase 13M-P5 — exploration routing and agent guidance

Phase 13M-P5 adds an adaptive exploration-guidance layer instead of another discovery subsystem. the corresponding module infers a qualitative thoroughness level and selects intent-appropriate tool preferences across `repo_map`, `glob`, `grep`, and `read_file`. Explore system prompts now receive the actual user prompt, so the routing reflects the requested investigation rather than only project instructions.

The guidance preserves the distinct discovery/search/read responsibilities, adds TermAgent's independent-call parallelization guidance, and explicitly directs the agent to continue from uncovered read ranges, follow truncated-result continuation, switch strategy on no-progress, and avoid duplicated delegated searches. Build mode also receives bounded subagent/delegation guidance when specialized task tools are available; Explore remains read-only. No fixed discovery sequence or fixed call count is enforced.

### Phase 13M-P5 verification

- `tests/agent/phase13m-p5-exploration-routing.test.mjs` — **4/4 PASS**.
- Combined P2 + P3 + P4 + P5 suite — **18/18 PASS**.
- Selected Phase 13A-L + P2-P5 regression set — **86/86 PASS**.
- `npm run build` — **PASS**.

Repository-wide `npm test` remains a separate rollout-gate blocker because the aggregate suite still contains unrelated failures and timeout behavior documented by the Phase 13 hardening reports.
## 1.18.0 Phase 13M-P6 — exploration efficiency telemetry

Phase 13M-P6 adds runtime-derived `ExplorationTelemetry` without introducing a second tracing or session-state system. The telemetry reuses P2 `ExplorationObservation` evidence and the P4 semantic exploration-action identity, recording tool calls, useful calls, semantically repeated calls, overlapping reads, cumulative newly discovered files, newly covered range segments, novel searches, tool-bearing rounds, no-progress rounds, and categorized termination reason.

Telemetry is emitted through an internal `Agent.run()` callback and is intentionally not persisted into `SessionStore`. Tool attempts are counted exactly once at settlement, including constrained/rejected actions; assistant-only final response rounds do not count as exploration rounds. Read observations now expose an explicit overlap flag computed from requested range versus previous coverage.

A deterministic `tests/fixtures/phase13m-p6-crypto-33-call.json` workload contains 33 potential tool calls over a 1,372-line `crypto.py`: five useful range reads followed by syntactically varied rereads. The Agent regression confirms semantic termination before the potential-call workload is exhausted and records the expected telemetry. A second forty-read Explore regression confirms legitimate long exploration remains governed by semantic progress rather than a fixed call ceiling.

### Phase 13M-P6 verification

- `tests/agent/phase13m-p6-exploration-telemetry.test.mjs` — **3/3 PASS**.
- Selected Phase 13/P2-P6 agent regression set — **PASS**.
- `npm run build` — **PASS**.
- Generated JavaScript syntax checks — **PASS**.
- `npm pack --dry-run` — **PASS**.

The complete repository rollout gate remains separate and continues to inherit previously documented unrelated failures/timeouts. P7 and the final 13M gate remain pending.

## 1.19.0 Phase 13M-P7 — client/runtime protocol preparation

Phase 13M-P7 establishes the stable protocol seam required for the future Web View and VS Code clients. the corresponding module now owns versioned renderer-neutral event and command envelopes, durable/live event classification, independent durable-sequence semantics, command idempotency and stale-state guards, permission/question wire-state models with first-writer-wins resolution semantics, and reconnect/reconciliation contracts. The protocol is transport-neutral and has no HTTP, SSE, browser, or VS Code dependency.

The public package now exposes `./protocol` so future clients can consume the same contract without importing runtime or presentation modules. Phase 14 remains responsible for assigning and persisting durable sequences, implementing the runtime event bus, migrating HTTP/SSE routes to canonical commands/events, and building the browser client.
## Phase 13M — final verification and rollout gate

The historical Phase 13M completion result is **REOPENED as of 2026-09-30**. A real Build-mode `crypto.py` session contradicted the earlier end-to-end claim: semantic intervention did not visibly intervene before the legacy exact-repeat backstop, while the Explore-mode trace progressed through uncovered ranges normally.

The revalidation hardened the existing architecture rather than replacing it. the corresponding module no longer uses tool lifecycle bookkeeping as semantic progress evidence; failed/constrained tools do not mutate `ExplorationState`; and partial version metadata cannot erase already-known read coverage. The deterministic Build regression now terminates before the historical 19-read sequence is exhausted, and the forced-compaction/fresh-Agent regression preserves authoritative coverage across checkpoint restore.

Current evidence:
- Production TypeScript build — **PASS**.
- Targeted Agent/P4/P6 regression set — **29/29 PASS**.
- New 13M hardening regressions — **4/4 PASS**.
- Repository-wide independent test-file verification — **65 PASS, 9 FAIL across 74 files**. All nine failing files reproduce against the untouched Phase 14A baseline and are retained as separate pre-existing gate work.
- Aggregate `npm test` — **not a passing gate**; the multi-file runner again failed to terminate under the verification harness.
- Physical ARMv7/Termux execution — unavailable on the current x86_64 host.

Full current evidence is recorded in `docs/research/PHASE13M-HARDENING-REVALIDATION.md`. Phase 14 Web View work remains behind the reopened exploration gate.

### 2026-09-30 13M revalidation note

The Phase 14A implementation remains in the repository, but the next Web View/multi-client phase must not be treated as the active priority while the reopened exploration gate is unresolved. See `docs/research/PHASE13M-HARDENING-REVALIDATION.md`.

## 1.19.0 Phase 14A — canonical event log and interaction model

Phase 14A is complete. TermAgent now persists public event metadata (`eventId`, protocol version, category, kind, durable flag, and monotonic sequence) with each new session event. `SessionStore` serializes cross-process sequence assignment with its existing state lease and exposes durable-event pages keyed by sequence rather than JSONL offsets. Legacy records without explicit metadata remain readable through deterministic compatibility projection.

the corresponding module is the stable renderer-neutral contract for durable/live event envelopes, command envelopes, command idempotency fingerprints, expected sequence/revision guards, permission/question state, first-writer-wins resolution, and reconnect/reconciliation planning. the corresponding module provides deterministic duplicate-command admission and durable command receipts.

Permission/question requests are reconstructible from session events and survive process restart. Concurrent resolution is first-writer-wins and later resolution attempts converge on the authoritative stored result. The Web View preparation explicitly leaves high-frequency deltas, activity, heartbeats, and connection state live-only.

A robustness pass also added trailing JSONL recovery: a genuinely incomplete final write is truncated before the next durable append, while newline-terminated corruption is rejected rather than silently discarded.

### Phase 14A verification

- `tests/phase14a-event-interaction.test.mjs` — **13/13 PASS**.
- `npm run build` — **PASS**.
- Cross-process sequence assignment — **PASS**.
- Cross-process duplicate command admission — **PASS**.
- Legacy sequence compatibility — **PASS**.
- Live-only envelope validation/factory — **PASS**.
- Incomplete-tail repair and corrupt-tail fail-closed behavior — **PASS**.
- `CommandLedger` duplicate, semantic-conflict, and stale-command behavior — **PASS**.
- Permission/question reconstruction and first-writer-wins resolution — **PASS**.

Detailed implementation notes are in `docs/research/PHASE14A-CANONICAL-EVENT-INTERACTION.md`. Phase 14B remains intentionally unstarted; the current HTTP/SSE polling implementation is preserved until the runtime event publisher/subscriber boundary is implemented.

## 1.19.0 Phase 13N-A — pre-execution semantic read gate

Phase 13N-A closes the remaining semantic-read execution gap uncovered by the reopened Phase 13M Build-mode trace. `FileReadStateCache.lookup()` now exposes an explicit `already-covered` classification for fully covered non-exact ranges while preserving exact `unchanged`, post-compaction `rehydrated`, partial `overlap`, and fresh/miss behavior.

The `read_file` builtin returns the already-covered result before invoking the content-reading stream, and file text/binary inspection is delayed until actual content access is necessary. Cache coverage is now derived only from complete source segments, an ephemeral context-visible coverage union distinguishes redundant reads from legitimate rehydration after compaction, and durable read-state projections exclude incomplete segments. Cosmetic arguments therefore cannot turn an already-covered semantic range back into a filesystem read.

A related context-budget edge exposed by the new cheaper cache results was also hardened without changing the existing compaction architecture: `maybeCompact()` can reserve additional request overhead, request construction rechecks the final bounded request, and token truncation reserves its marker budget.

#
## Phase 13N-C — Production exploration guidance wiring

Status: `[verified]` at the focused implementation/regression level.

Implemented the existing the corresponding module through the authoritative `Agent.run()` request path instead of leaving it as an unused helper. Guidance is bounded before insertion, recomputed from the live user prompt and current exploration evidence, and updated with the no-progress streak. It explicitly encourages batching independent read/search calls, continuing from uncovered ranges, and changing strategy after no new semantic evidence while preserving adaptive rather than ceremonial routing.

Verification: production TypeScript build passes; the dedicated 13N-C guidance suite passes 3/3. The broader repository aggregate test runner remains a separate known gate and is not represented as green by this phase.

Roadmap status tags are now explicit (`[ ]`, `[impl]`, `[test]`, `[verified]`, `[blocked]`); a phase gate can remain REOPENED even when individual subclaims are verified.

## Phase 13N-A verification

- `npm run build` — **PASS**.
- New 13N-A read-gate suite — **7/7 PASS**.
- Phase 13M-P4 intervention suite — **6/6 PASS**.
- Phase 13B read-state suite — **14/14 PASS**.
- Phase 13M hardening suite — **4/4 PASS**.
- Combined focused regression set — **31/31 PASS**.
- Physical ARMv7/Termux execution remains unavailable on the current x86_64 verification host.
- Repository-wide aggregate `npm test` remains a separate known gate issue because of pre-existing failures and process-lifecycle timeout behavior documented in the Phase 13M revalidation report.

The implementation details and exact semantics are recorded in `docs/research/PHASE13N-A-READ-GATE.md`. The next TODO item is 13N-B, evidence-based exploration progress.
## 1.19.0 Phase 13N-B — evidence-based exploration progress

13N-B converts exploration observations into explicit evidence deltas while preserving the existing `ExplorationState`/`ToolLoopGuard` architecture. Read observations distinguish newly covered ranges from already-known coverage and from post-compaction rehydration; rehydration is visible as reconstructed evidence but does not reset semantic no-progress detection. `grep`, `glob`, and `repo_map` deduplicate discovered files, symbols, and search result keys before counting them as progress. Settled verification metadata can contribute a stable semantic fact, with verification command text hashed so sensitive literals are not retained in the semantic state.

The P6 telemetry projection now exposes the additional evidence dimensions `reconstructedEvidence`, `novelSearchResults`, `newSymbols`, and `settledVerificationFacts` while preserving the older efficiency counters. Cosmetic grep arguments continue to collapse to the same semantic call identity, so they cannot manufacture repeat/progress evidence.

### Phase 13N-B verification

- `npm run build` — **PASS**.
- `tests/agent/phase13n-b-evidence-progress.test.mjs` — **6/6 PASS**.
- Combined Phase 13M hardening/P4/P6 + 13N-A/B focused set — **26/26 PASS**.
- Aggregate `npm test` remains a separate known repository-level gate issue.
- Physical ARMv7/Termux execution remains unavailable on the current x86_64 verification host.

Detailed evidence and source boundaries are recorded in `docs/research/PHASE13N-B-EVIDENCE-PROGRESS.md`. The next TODO item is 13N-C, production exploration-guidance wiring.

## 2026-10-01 — Phase 13N-D verification ledger

Implemented 13N-D on top of the existing TaskManager, managed-shell, lifecycle, workflow, ExplorationState, and SessionStore infrastructure. `verify_project` now has explicit settled verification states, bounded previews, durable task output references, and a `force` escape hatch for explicit reruns. Successful configured mutations can trigger one automatic verification per mutation batch; a later same-batch `verify_project` call is served from the successful automatic result unless `force=true`.

Added the derived `EvidenceLedger` projection with bounded files/searches/symbols/verifications/mutations/tasks/workflow state. Ledger fingerprints deliberately ignore lifecycle IDs, task IDs, output paths, output sizes, truncation flags, and other presentation/runtime identities. The ledger is persisted inside `ContextMachineState` checkpoints while SessionStore and TaskManager remain authoritative.

The new durable verification event maps to `session.verification.completed` with category `verification`. Automatic verification results are also fed into `ExplorationState` as settled semantic evidence and into workflow observation.

Verification: `npm run build` PASS; dedicated 13N-D suite 9/9 PASS; combined 13M/P4/P6 + 13N-A/B/C/D focused suite 38/38 PASS. Repository-wide `npm test` remains a known non-terminating/legacy gate, and ARMv7/Termux hardware is unavailable on the x86_64 verification host.
## 2026-10-02 — Phase 13N-E LSP verification correctness

Implemented the LSP diagnostic truth model on top of the existing evidence/verification architecture. the corresponding module models `unknown`, `running`, `provisional`, `clean`, `failed`, `timed_out`, and `cancelled`; coalesces repeated publications by retaining the latest bounded diagnostic set; requires quiescence before settlement; and applies a minimum settle window specifically to empty diagnostic publications so an early zero-result notification cannot be presented as clean.

The tracker exposes a bounded verification record and a semantic fingerprint that ignores publication timing/count lifecycle churn. `EvidenceLedger` now carries bounded LSP state, and lifecycle metadata with `lspDiagnostics` is normalized automatically. Provisional states are deliberately excluded from `ExplorationState` semantic progress; terminal LSP states become stable verification facts. Machine-context rendering includes the LSP count only when non-zero, avoiding unnecessary context-budget pressure.

The implementation uses a diagnostic registry/coalescing path with explicit quiescence and budget rules. It does not add a new language-server process manager in this phase; that remains deferred to the dedicated LSP/code-intelligence capability phase.

Verification: `npm run build` PASS; dedicated 13N-E suite 12/12 PASS; combined Phase 13M/13N focused regression set 78/79 PASS with the single 13B tiny-budget compaction test reproducing unchanged against the 13N-D baseline. Aggregate `npm test` remains a separate repository-level runner gate, and physical ARMv7/Termux execution remains unavailable on the x86_64 verification host.

## Phase 13N-F — Provider reliability

- Provider HTTP failures now retain status, response headers, bounded response body, and parsed `Retry-After` information.
- Retry backoff now observes cancellation and accepts deterministic jitter injection for regression fixtures.
- SSE provider streams now have a bounded idle watchdog; pre-output stalls may retry, while post-output stalls fail closed to avoid duplicate visible responses.
- Provider-specific reasoning parameters remain isolated to the OpenAI-compatible, Anthropic, and Gemini adapters.
- Opaque provider tool metadata remains round-trip safe through the durable lifecycle/session path.
- Status callbacks surface stalled-provider state through the existing terminal activity mechanism.
- Phase 13N-F dedicated suite: **9/9 PASS**.
- Combined focused Phase 13M/P4/P6/P7 + 13N-A/B/C/D/E/F + provider-adapter gate: **67/67 PASS**.
- `npm run build`: **PASS**.
## Phase 13N-G — Specialist sub-agent hardening

Status: `[verified]` at the specialist delegation contract level.

Implemented named specialist roles (`general`, `researcher`, `planner`, `coder`, `reviewer`, `tester`) with role-scoped tool allowlists, explicit read-only/restricted-shell policies, inherited parent workspace scopes, centrally bounded concurrency, explicit delegation depth, recursive parent-task cancellation, durable parentTaskId linkage, and estimated token-usage accounting. Specialist reports are bounded for parent context while full worker output remains in the durable task output store.

Verification: 5/5 phase-specific tests pass; 140/142 broader focused 13M/13N-adjacent tests pass. The two remaining failures reproduce as pre-existing expectation mismatches in Phase 13B and Phase 13L and are not caused by 13N-G.

## 2026-10-02 — Phase 13N-H checkpoint/branch UX

Implemented checkpoint/branch UX on top of the existing SessionStore and SnapshotStore rather than creating a second session model. Manual checkpoints now persist an immutable message projection, SHA-256 message hash, source sequence, workspace snapshot ID, label, and model/provider metadata. Checkpoint snapshots are retained during normal turn-snapshot cleanup.

Restore is a durable state transition: it refuses to run during an active turn, restores the checkpoint workspace snapshot, appends a `checkpoint.restore` event containing the immutable message projection, and causes subsequent session loads to treat pre-restore messages/context checkpoints as abandoned history. Branch-from-checkpoint creates a new session linked to the source session/checkpoint, copies semantic conversation state only, does not copy mutable UI/render buffers, and can optionally restore the checkpoint workspace.

Checkpoint references support exact IDs, unique prefixes, and the `#N` index shown by `/checkpoints`. The terminal exposes `/checkpoints`, `/checkpoint`, `/restore`, `/branch <checkpoint-id> [--restore]`, and `/fork checkpoint <checkpoint-id>`. The authenticated HTTP API exposes checkpoint list/create/restore/branch routes. Older metadata-only checkpoints remain listable but fail closed for restore/branch because they do not contain a trustworthy immutable message/workspace target.

### Phase 13N-H verification

- `npm run build` — **PASS**.
- `tests/phase13n-h-checkpoints.test.mjs` — **8/8 PASS**.
- Combined focused checkpoint/provider/specialist/compaction/task/protocol/server set — **59/59 PASS**.
- HTTP checkpoint create/list/branch/restore coverage — **PASS**.
- Aggregate repository `npm test` remains a separate blocked gate: the run reached 478 passing tests before hanging in the existing provider-manager long-lived process test.
- Two older expectation mismatches also remain documented outside the H scope: the 13B tiny-budget compaction expectation and the legacy 13L timeout expectation.
- Physical ARMv7/Termux execution remains unavailable on the verification host.
## 2026-10-03 — Phase 13N-I XML tool-call pipeline hardening

The first compatibility attempt was not sufficient. The uploaded trace showed the provider emitting the complete XML request as assistant text, while the old streaming gate withheld it and the late recovery path rejected the concrete `shell` spelling because the real registry exposes `bash`. When recovery failed, the old finish path re-injected the held XML through `onText`, which is why the terminal rendered the protocol markup.

Replaced that path with `XmlToolCallStreamParser`, an incremental protocol adapter that sits directly on provider text deltas before assistant transcript emission. It keeps partial XML framing in bounded buffers, resolves tool names against the live `ToolRegistry`, supports the observed `shell` → `bash` compatibility spelling, parses structured parameters/JSON wrappers, reconciles incomplete frames at finish, and feeds recovered calls into the same `calls` collection used by native provider tool calls. No alternate executor was introduced.

Upstream research confirmed the split between protocol parsing and rendering: mature reference implementations normalize provider output into semantic text/tool events before session projection, keep assistant content separate from tool calls, and use stateful XML framing with explicit argument and finish-time reconciliation.

Verification: the exact screenshot-shaped reproduction now executes the registered `bash` tool once, produces a semantic tool-call lifecycle, and emits no `<tool_call>`, `<function=`, or `<parameter=` text to the assistant transcript. The focused XML compatibility suite is **15/15 PASS**; the broader provider/tool/agent regression selection is **127/127 PASS**; the Phase 4 release-hygiene file is **6/6 PASS**; and `npm run build` is **PASS**. The repository-level `npm test` gate was also exercised with a 125-second cap: it reached 324 passing tests, 2 unrelated expectation failures (`/auto` E2E and the documented tiny-budget 13B expectation), then stopped producing progress at test 326 without a final TAP summary. Physical Termux/ARMv7 execution remains unverified on this host.

Detailed notes: `docs/research/PHASE13N-I-TEXT-TOOL-CALL-COMPAT.md`.

## 2026-10-03 — Phase 13N-I reconciled semantic UI, visual system, queue and mobile pass

Rebased the final 13N-I work onto the authoritative `TermAgent-1.18.0-Phase13N-I-Complete-Visual-System-HUD.zip` snapshot after discovering that the previously supplied source archive was stale. The richer visual system from that snapshot was preserved; the missing Markdown table, queue, composer, live-input, user-surface, and protocol projection work was merged selectively.

The semantic Markdown renderer now handles real tables without ANSI-string guessing. Headers, separator alignment, empty cells, escaped pipes, Unicode display width, inline formatting, wrapping, compact grids, and mobile cards are represented before terminal painting. Declared column alignment is preserved for headers and body cells.

Prompt submission now remains live while an agent turn runs. The runtime-owned `SessionPromptQueue` persists queue transitions as session events, supports editing/cancellation/reordering, keeps executing work non-editable, gives numeric queue commands a queued-only interpretation, and recovers stale `executing` entries after a process restart. Queue rendering exposes running work separately from editable pending prompts, and the same row geometry is used for touch targets.

The composer is a semantic, responsive surface rather than a disabled input rectangle. It carries agent state, provider/model, context usage, tool count, queue count and actionable hints while the underlying `PromptEditor` remains active. User messages now have their own transcript surface. Session-changing operations that could invalidate an in-flight turn are blocked until that turn finishes.

### Phase 13N-I verification

- `npm run build` — **PASS**.
- Reconciled focused UI/UX gate — **129/129 PASS**.
- Current Markdown regression test — **4/4 PASS**.
- Phase 12F deterministic visual snapshots — **PASS**.
- Mobile sanity views at 60×24 and 40×20 — **PASS**.
- The repository-wide aggregate runner remains a separate blocked gate because the existing provider-manager long-lived process does not terminate. No partial aggregate pass count is treated as a green result.
- Physical ARMv7/Termux execution remains the 13N-J rollout gate.

Detailed notes: `docs/research/PHASE13N-I-SEMANTIC-UI-VISUAL-SYSTEM.md`.

## 13N-J-A — Mobile process lifecycle hardening

Started from the repaired 13N-I tree and adapted the existing durable `TaskManager` / managed-shell runtime using the recorded process-group and bounded-process patterns. Added reusable POSIX process-group signalling/escalation and timed child-stdin writes, cleaned up descendant groups after foreground shell completion, kept explicitly backgrounded tasks cancellable, and made shell previews obey their UTF-8 byte budget including truncation markers.

Verification: `npm run build` PASS; combined 13N-J-A + 13E + 13I process/task gate **32/32 PASS**. Physical ARMv7/Termux execution remains open on the x86_64 host. Release engineering is deferred to 13N-J-B.
## 2026-10-04 — Phase 13N-J-C shell service/process semantics

The uploaded Termux trace showed a second failure after the XML parser fix: the semantic no-progress guard remained active after earlier repository exploration and counted later bash rounds as stagnant execution, even when the commands differed. The guard is now scoped away from operational shell/write rounds, while the existing exact repeated-call protection remains intact.

The same trace also exposed shell lifetime ambiguity around commands containing `&`. The managed shell path now detects intentional shell background syntax, preserves surviving descendants after a successful shell-leader exit, and records `backgroundChildrenPreserved` in task/result metadata. Ordinary unintended descendants and timeout/cancellation/output-limit paths still use process-group cleanup.

Bash results now surface `EADDRINUSE` as structured metadata and include explicit model-facing guidance to reuse or inspect an already-running service rather than launching another copy. Persistent services are additionally directed toward TermAgent's durable background execution path.

Verification: `npm run build` PASS; focused XML/tool-call + shell/process gate **41/41 PASS**. Full repository aggregation remains a separate gate and physical ARMv7/Termux smoke is still unverified on the x86_64 host.

## 2026-10-03 — Phase 13N-J-B Android/ARMv7 release engineering

Added explicit release target metadata for `android-armv7`, `android-arm64`, `linux-armv7`, `linux-arm64`, and `linux-x64`; deterministic target-labeled bundle generation; `release-manifest.json`; `SHA256SUMS`; and a prebuilt-first Termux-aware installer with source-build fallback. Because TermAgent has no native runtime addon, the application bundle remains JavaScript and the target labels describe runtime/installer compatibility rather than a native TermAgent binary.

Verification: `npm run build` PASS; release tests 10/10 PASS; combined 13N-J-A + 13N-I/provider/specialist/checkpoint gate 75/75 PASS; generated JavaScript syntax 145/145 PASS; `npm pack --dry-run` PASS; deterministic multi-target release bundles and SHA-256 manifest generation PASS; workflow YAML and installer syntax PASS. Physical Termux/ARMv7 smoke remains the final 13N-J platform gate.


## 13N-N: shell loop-safety correction

- Root cause confirmed from the uploaded session trace: the affected turn executed three distinct `bash` calls, while each shell result carried a `taskId` in execution metadata.
- `containsSemanticMetadata()` treated `taskId` as semantic state, activating the exploration no-progress guard during ordinary shell execution.
- The semantic fingerprint intentionally excludes tool-lifecycle bookkeeping, so the three shell rounds appeared identical and triggered the existing threshold of 3.
- Corrected metadata classification so only `mutation` and `todo` state can activate that semantic guard.
- Added an agent-level regression reproducing three distinct shell verification calls with task metadata and requiring the fourth provider response.


## Phase 14B — Event bus and reconnect-safe streaming

Implemented a runtime-owned durable session event bus, race-free replay-then-tail SSE handoff, explicit durable cursor validation, subscriber cleanup, and an authoritative session snapshot endpoint. The server no longer uses the previous 250 ms JSONL polling loop for durable session events. Focused 14B regressions cover replay/tail handoff and ahead-of-head cursor rejection; broader package/release verification remains a separate gate.


## 2026-10-04 — Phase 14B implementation slice

Implemented the runtime-owned session event bus and race-free replay→tail event stream, replacing 250 ms durable JSONL polling. Added explicit connection/ready/heartbeat frames, cursor validation, reconnect-safe durable replay, subscriber cleanup, and an authoritative `/snapshot` reconciliation endpoint plus client accessor. Focused Phase 14A/14B/server regressions pass 17/17; production TypeScript build passes. The overall Phase 14 gate remains open, and the separate 13N real-device/platform gate is still pending.

## 2026-10-08 — Phase 14C HTTP API and dependency-free client SDK

Implemented Phase 14C on top of the canonical SessionStore, CommandLedger, TaskManager, SessionPromptQueue, protocol envelopes, and Phase 14B event bus. `src/server/http.ts` now acts as the HTTP/SSE transport adapter while `src/server/api.ts` owns service/command adaptation. The stable API covers session/history/events/event-stream/status/diff/context/snapshot, permissions/questions, Todo/queue, checkpoints, tasks, prompting/commands, and runtime capability discovery.

Added `src/client/client.ts` as a typed dependency-free consumer using standard Fetch APIs. JSON requests and SSE carry explicit merged headers and bearer auth; the SSE reader advances only on durable event sequence and reconnects explicitly after transport termination. Browser `EventSource` is not required.

Route/schema drift tests compare the public route inventory with the client inventory and enforce unique method/path pairs. The implementation uncovered and corrected a genuine checkpoint route mismatch: the stable client contract uses plural `/checkpoints`, while the old server exposed only singular `/checkpoint`; the plural route is now canonical and the singular path remains a compatibility alias.

Verification: Phase 14A + 14B + 14C focused HTTP/event/client suite **22/22 PASS**; Phase 14C dedicated suite **4/4 PASS**; Phase 4 public-client regressions **2/2 PASS**; Phase 5 parity **9/9 PASS**; existing server regression **1/1 PASS**; Phase 13N release regression **10/10 PASS**; production TypeScript build **PASS**. Overall Phase 14 remains open for 14D+ and security/two-way-mirror gates; the separate real Termux/ARMv7 rollout gate remains open.

Detailed design/research: `docs/research/PHASE14C-HTTP-API-CLIENT-SDK.md`.

## 2026-10-09 — Phase 14D Web View implementation

Implemented the browser Web View against the existing Phase 14C `TermAgentClient` and Phase 14B durable replay/live event stream. The user's uploaded v4 prototype remains byte-for-byte intact under `web/prototype/`; production assets in `web/app/` preserve the v4 component layout and begin with its exact stylesheet. Runtime status, text/reasoning deltas, tool activity/output and other live events are projected into the v4 surface; completed output reconciles against the authoritative session snapshot/history.

The server now allowlists static Web View routes while retaining configured bearer-token enforcement on health/API/session data. The browser token is memory-only. `termagent --serve` prints the Web View root URL. The dependency-free client remains the only browser/runtime boundary, with no React, Node browser coupling, or new frontend dependencies.

The UI includes session switching/creation, run status/stop, live text/reasoning, expandable tool cards, task and diff inspection, Todo/proof UI, shared permission/question controls, prompt queue submission/removal, context/runtime view, compact/undo/redo, checkpoints, task continuation, slash commands, focus/theme preferences, safe Markdown including scrollable tables, and keyboard/focus handling. Per v4's own design constraints, no Motion/GSAP package was introduced; only the supplied restrained CSS/reduced-motion approach is retained.

Verification: `npm run build` PASS; browser app syntax PASS; Phase 14D tests **6/6 PASS**; combined Phase 14B/14C/14D HTTP/SSE/client gate **13/13 PASS**; Chromium smoke at 390×844, 768×900 and 1440×960 had no page errors and no page-level horizontal overflow. Prompt submission and Options-sheet open/close were exercised. The browser screenshot smoke used a deterministic fake client fixture; it is not a real-provider or physical Android/Termux test. Phase 14E pairing/security and Phase 14F two-client convergence remain open.

Detailed report: `PHASE-14D-REPORT.md`. Research and architecture lineage: `docs/research/PHASE14D-WEB-VIEW.md`.


## 2026-11-01 — Phase 14 / selected Phase 16 / Cloud Edition architecture review

Completed a source-based architecture audit using the supplied Phase14D-Mobile-Fetch-Fix full-source archive. No product implementation or runtime behavior was changed. The archive has no `.git` metadata; the separate older Git snapshot and accessible GitHub `main` were checked and are not substitutes for this newer Phase 14D source.

Confirmed P0 issue: the server `PermissionGate` has no `setRequester()` adapter and falls back to stdin readline; browser `permission.resolve` persists a separate durable state change and does not resolve the original blocked tool request. Confirmed cross-process issue: `SessionEventBus` is process-local, and cross-store append probe advanced durable sequence without waking the first store's subscriber. SSE heartbeat does not replay that missed durable sequence. The existing session turn lease and CommandLedger idempotency remain useful foundations.

Audited Web View request fan-out, full-transcript rendering on stream deltas, SSE backpressure and transient-buffer behavior; identified profiling targets but collected no end-to-end performance timings. Audited security gaps around optional auth on non-loopback binds, environment inheritance into shell/workers/hooks, and lack of OS-level workspace sandboxing.

Reviewed selected Phase 16 capabilities: 16A has a diagnostic tracker but no language-server process manager; 16B has no safe agent-facing web tools; 16D has a useful lexical/structural graph foundation; 16E lacks a unified provenance-aware persistent project memory; 16F has provider retry/stream/cancellation foundations with remaining capability/schema/record-replay contracts.

Focused scratch-copy verification: `npm run build` PASS; Phase 14A–D/permission/13N-F tests **38/38 PASS**; Phase13N-E LSP diagnostic + server HTTP tests **13/13 PASS**. A deliberately separate two-store event-bus probe reproduced the missed-wakeup failure. No complete-suite green claim and no physical Android test are made.

Created `docs/research/TERMAGENT-ARCHITECTURE-ASSESSMENT-2026-11-01.md`, `docs/research/TERMAGENT-PLATFORM-RESEARCH-2026-11-01.md`, proposed ADR-018–020, preserved Phase 15 specification as deferred history, and updated the active roadmap/architecture. Awaiting approval before Phase 14E/14F or Phase 16 implementation.


## 2026-11-01 Hermes Agent research and runtime-owner decision

- Project owner selected Option A: one long-lived TermAgent runtime daemon; ADR-019 is now accepted. Terminal, browser and future Telegram clients attach to the same Agent/session/permission/task authority.
- Researched Hermes Agent at inspected revision `a4994d4ead8f9c915b485cec5689909b349a49df`, including its Telegram adapter, gateway/session routing, outbound sender, cron scheduler/delivery, memory, skills, delegation and security model.
- Key finding: Hermes explicitly keeps generic `send_message` out of the default model-callable tool registry; scheduler/CLI/notifier code owns outbound delivery. The planned TermAgent design follows this separation with a daemon-owned notification service and durable outbox.
- Added Telegram Bot API constraints to the design: bot cannot initiate a private chat before the user starts it; `getUpdates` and webhook are mutually exclusive; updates are retained for at most 24 hours; respect per-chat send pacing and 429 retry-after; token stays daemon-only.
- Added proposed ADR-021 and Phase 17 planning for owner pairing, notifications, Telegram adapter, durable scheduling and daemon health. Phase 17/Telegram work is not started.
- Documentation-only changes; no product source, compiled output, package metadata or tests were modified in this research pass. Immediate next proposed implementation remains Phase 14E.1.

## 2026-11-04 — Phase 14H context and memory continuity implementation slice

Resumed Phase 14H from the Phase 14F6 source snapshot. Corrected the earlier context-limit diagnosis against source: `environmentDefaults()` does not impose a 12K window; the supplied sample configuration previously did, and a user-owned `.termagent/config.json` can still intentionally impose it. Removed that fixed cap from `.termagent-example.json`, documented exact context/output resolution and source provenance, and improved `/context` diagnostics to show the active route and its effective budgets.

Extended the existing per-turn `FileReadStateCache` using the durable `ContextMachineState` checkpoint rather than creating a parallel memory store. Up to 64 read-state records can be restored after a new turn/restart, but only after workspace/scope and realpath containment, metadata, SHA-256, line count and resource-limit checks. Revalidation streams file bytes and captures only previously inspected complete ranges; oversized/pathological files are skipped. Prompt evidence remains separately bounded. Fixed restored skill content to receive the explicit-skill context allocation after restart/compaction, while retaining descriptor-first discovery and ID/digest validation. Existing hierarchical instruction loading and safe path restoration are now explicitly tested as part of this workstream.

Focused build and regression verification:
- `npm run build`: **PASS**.
- Phase 14H + Phase 13B/13H + context/repository/skill focused suites: **114/114 PASS**.
- `node scripts/verify-dist.mjs`: **PASS**.
- `npm pack --dry-run`: **PASS**.
- `npm run release:build -- android-armv7 android-arm64` using a temporary release directory: **PASS** (bundle generation only; does not mean Android was executed).
- `TERMAGENT_ALLOW_NON_ANDROID=1 npm run device:smoke`: **PASS** as a Linux x64 rehearsal only; it reports `termux:false`, so it is not physical Termux validation.

The full `npm test` aggregate was attempted but did **not** pass: it surfaced failures in four loop-guard assertions (`tests/agent.test.mjs` returned status `Thinking` instead of the expected loop-guard status), the `/auto` CLI E2E assertion (`before\n` remained instead of `after\n`), and the Phase 13F context accounting assertion (`191` vs expected `211`). The aggregate then stalled and was terminated at the 600-second timeout while reporting test 230, without a final TAP summary. The loop-guard and Phase 13F failures were reproduced in an isolated run (**24/29 pass, 5 fail**). These failures are not counted as Phase 14H passes and need separate triage before the overall Phase 14 gate.

Still open for 14H: supplied JSONL replay and comparative compaction measurements, large-repository stress/warm-index reuse, compaction summary/threshold audit, provider tokenizer/estimation drift, restart/subagent nested-instruction/skill edge cases, and physical Termux/Android memory and latency checks. Phase 14H remains **IN PROGRESS**; 14I has not started.

Detailed report: `docs/phases/PHASE14H-CONTEXT-MEMORY-INSTRUCTION-LOADING.md`. Upstream research: `docs/research/PHASE14H-CONTEXT-MEMORY-UPSTREAM-ADAPTATION.md`.


## 2026-11-05 — Phase 14H durable session replay and compaction summary correction

Added `tools/phase14h-session-replay.mjs`, which replays supplied JSONL traces through the existing `SessionStore` projection without executing historical tools or calling a provider. The 759-event/50-compaction trace has 102/102 tool-call/result pairs intact, 19 repeated exact exploration calls across compaction epochs, and 0 provider-usage records. Its compaction footprint had p50 7,419 and p95 7,550 estimated tokens against a 7,792-token usable budget. The 415-event companion trace was analyzed separately but is not a controlled clean-equivalent workload.

A one-pass current-compactor counterfactual reduced the 759-event reconstructed message projection from 28,684 to 4,382 estimated tokens and retained seven complete tool-call/result pairs. This does not demonstrate a lower incremental compaction count or latency. The replay exposed that the fitted summary omitted `## Work State` and `## Todo` headings; `src/agent/compaction.ts` now preserves all required structural headings and a regression test asserts this under a constrained budget.

Verification in this slice: TypeScript build PASS; new replay/summary tests **3/3 PASS**. A full 14H focused gate, package checks, and the repository-wide suite remain to be run after this slice. Phase 14H remains IN PROGRESS; the controlled replay, provider usage reconciliation, large-repository stress, full regression gate, and physical Termux verification remain open.


## 2026-11-05 — Phase 14H multi-cycle, repository-scale, and regression gate continuation

Corrected the summary-fitting implementation based on repeated-compaction coverage: section priority now applies to content rather than detaching bullets from their headings, selected content returns in original order, repeated facts are deduplicated, and the newest completed/blocked evidence is preferred under a tight summary budget. A four-cycle synthetic regression passes while checking the active objective, requirement, decision, relevant paths, active Todo ID, verification evidence, structural skeleton, token budget, and complete tool call/result units.

Added a 1,000-module TypeScript repository fixture (1,002 indexed paths). It passes dependency graph extraction, focused symbol/file prioritization, bounded 64K-token/800-path map rendering, and cold/warm index checks. The warm pass reports 1,002 cache hits and zero misses. This is host-side fixture evidence only, not proof of million-token model context or physical Termux resource behavior.

The supplied JSONL replay was rerun with the built code. The 759-event trace records 50 full compactions, 102/102 tool-call/result pairs, 19 repeated exploration calls across compaction epochs, and no provider usage telemetry. Current one-pass counterfactual: 28,684 → 4,205 estimated message tokens with 10 messages retained and no orphaned retained call. The 415-event companion one-pass check is 25,188 → 4,475. These are not controlled A/B or provider replay measurements.

Verification: TypeScript build PASS; focused Phase 14H/context/agent/E2E suite **180/180 PASS**; complete repository suite **704/704 PASS** using `node --test --test-concurrency=4 tests/*.test.mjs`. The package's serialized `npm test` runner (`--test-concurrency=1`) still stalled after reporting test 258 during a 15-minute run, without a final TAP result. This runner behavior remains an open engineering issue even though the complete parallel test run is green. Package/release checks and physical Android validation are recorded separately in the final phase report.

Phase 14H remains IN PROGRESS. Remaining acceptance work: clean-equivalent deterministic replay, provider tokenizer/usage drift, full multimodal/provider overhead accounting, staged pruning, expanded large-workspace and near-budget tests, nested instruction/subagent restart cases, serialized runner diagnosis, and physical Termux memory/latency verification. Phase 14I has not started.


## 2026-11-05 — Phase 14H provider usage normalization and retry telemetry isolation

Inspected the current OpenCode `packages/ai/src/protocols/openai-chat.ts` usage mapper and adapted its standard Chat usage fields, provider cache aliases, nested reasoning/cache details, and choice-level usage fallback in TermAgent's existing OpenAI-compatible adapter. Also compared the supplied OpenClaude 0.31.0 `LocalAgentTask` and token utility behavior for Anthropic's separate uncached-input/cache-read/cache-write reporting. Verified Gemini usage semantics against Google's `UsageMetadata` reference: effective prompt includes cached content, candidate and thought tokens are output, and cached prompt count is a subset.

TermAgent now normalizes usage for OpenAI-compatible, Gemini, and Anthropic adapters without counting cache subsets twice. `/context` surfaces the most recent provider report, local input estimate and drift, and cache/reasoning breakdown. The telemetry is deliberately process-local at this stage. Fixed retry isolation so provider usage captured by a failed stream attempt cannot leak into the report for a subsequent retry. Added a regression where the first attempt emits inflated usage and fails, and the retry succeeds without usage; the resulting report is correctly marked estimated instead of reusing the failed attempt's figures.

Validation in this slice: `npm run build` PASS; focused provider/context tests **24/24 PASS**. The full four-worker suite has now been rerun with the expanded inventory: **707/707 PASS** in 28.9 seconds. The serial aggregate rerun still did not produce a final TAP result before the execution limit; its latest visible TAP event was test 285 while the checkpoint test file was active. That file passes 8/8 in isolation, so no individual assertion has been identified as the cause. The serial aggregate runner remains slow/unresolved; the last diagnostic reached test 263 while the `phase13l-missing-capabilities` file, which passes on its own, was active. No single test has yet been confirmed as the serial blocker.

This remains an incomplete 14H sub-gate: tokenizer accuracy, multimodal and provider framing/tool-use accounting, durable usage history, clean-equivalent provider replay, staged pruning, broader restart/subagent checks, and physical Termux validation are still outstanding.


Final verification refresh for this continuation: `npm run build` PASS; `node --test --test-concurrency=4 tests/*.test.mjs` **707/707 PASS** (28.9 seconds); `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (323 package files, 488.7 kB tarball); Android ARMv7 and ARM64 release bundles regenerated with the latest source. The serial runner did not reach a final summary within this environment's execution limit; the last emitted TAP event was #285 and the active checkpoint test file passes independently. No physical Android or Termux claim is made.

Correction to the historical Phase 14H test count above: the 704/704 result predates the final provider-usage and retry-isolation regression cases. The current test inventory is **707/707 PASS** with four workers (not 704). The serialized runner's latest attempt did not produce a final TAP summary within the execution limit; its final visible test was #285. The active checkpoint test file passes 8/8 when isolated, so the serial aggregate issue remains unlocalized.


## 2026-11-06 — Phase 14H provider usage and context occupancy reconciliation

Continued provider usage research from the remaining 14H gaps. Inspected OpenCode's current OpenAI Chat usage mapper, Anthropic Messages usage/iteration mapper, and Claude-agent per-message usage tracker at revision `324c89dd63854eb7e0132733645f7a46ef5a71e8`. Verified Gemini `UsageMetadata.totalTokenCount` semantics against Google's current REST reference: the total includes prompt, candidate, tool-use-prompt, and thoughts tokens, while cached content is a subset of prompt tokens.

Updated the existing Anthropic adapter to deep-merge `message_start` and final `message_delta` usage snapshots, preserve final cache/input details, sum beta per-iteration billing usage, and report the final iteration's context occupancy separately. Updated the existing Gemini adapter to include tool-use prompt tokens on the input side and retain supplied prompt/cache/candidate/tool-use modality details. Extended the existing `ProviderUsage` contract and `/context` live report with optional final-request occupancy, tool-use prompt count, and modality details. Context meter and drift calculations now use final-request context occupancy when an adapter can provide it.

Regression coverage added for final Anthropic stream usage, Anthropic iteration totals versus final context occupancy, and Gemini tool-use/modality reporting. Focused run: `node --test tests/phase13n-f-provider-reliability.test.mjs tests/phase14h-context-continuity.test.mjs` — **28/28 PASS** after `tsc -p tsconfig.json`.

Remaining: provider-native tokenizers, exact non-text payload and framing overhead, durable usage history, controlled provider-backed replay, serial runner diagnosis, broader restart/subagent tests, and physical Termux validation. Phase 14H remains IN PROGRESS; Phase 14I has not started.


Final verification refresh for the 2026-11-06 provider-usage continuation: `tsc -p tsconfig.json` PASS; focused provider/context tests **28/28 PASS**; complete repository suite `node --test --test-concurrency=4 tests/*.test.mjs` **711/711 PASS** on the final rerun (32.8 seconds). The first complete run had one transient worker exit-state assertion; `phase13i-tasks.test.mjs` passed 11/11 in isolation and the full rerun was green. `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (323 files, 490.1 kB tarball); Android ARMv7 and ARM64 release bundles regenerated. A bounded serial `npm test` attempt did not finish within 420 seconds and emitted no failing assertion before termination; it is not marked as either a passing or failing complete run. No physical Android/Termux validation was performed.


## 2026-11-06 — Phase 14H selective staged micro-pruning

Inspected OpenClaude 0.31.0 `apiMicrocompact.ts` and OpenCode `session/compaction.ts` at `324c89dd63854eb7e0132733645f7a46ef5a71e8`. Adapted the selective clear-tool-result principle to TermAgent's existing `microPruneToolResults()` rather than adding a separate compaction path. TermAgent now prunes only old results from registry-declared read-only tools (`risk: read` and `readOnly: true`) that have a valid durable ToolOutputStore reference and a completed successful lifecycle. Recent turns, shell/write results, missing-reference results, failures, deferred/interrupted results and previously pruned markers remain intact. The marker preserves tool name, call ID and full-output reference. The stored output and durable session log are untouched; only the prompt projection changes. Pruning is idempotent across repeated passes.

Regression tests added for the archived read-only happy path, recent paired results, shell/write and unarchived-output protection, failed lifecycle protection, and idempotence. Build PASS; focused run `tests/phase13h-compaction-context.test.mjs`, `tests/phase14h-context-continuity.test.mjs`, and `tests/phase13n-f-provider-reliability.test.mjs` passed **43/43**. The full repository suite, release artifact verification, package dry-run, Android bundle generation and physical Termux checks remain to be refreshed after this change. Phase 14H remains IN PROGRESS; Phase 14I has not started.


Final verification refresh for the selective staged micro-pruning slice: TypeScript build PASS; focused context/compaction/provider gate **43/43 PASS**; full parallel repository suite **713/713 PASS** with four workers (29.1 seconds); `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (323 files, 490.7 kB package); Android ARMv7/ARM64 bundle generation PASS; device smoke PASS on Linux x64 only (`termux:false`). The serialized package test command remains unvalidated end-to-end; this slice also had a bounded two-worker run time out after test 485 without an emitted assertion failure. No physical Android/Termux validation was performed. Phase 14H remains IN PROGRESS.


## 2026-11-06 — Phase 14H durable provider usage history

Connected the existing `ProviderUsage` normalization and `SessionStore` append-only event log. Each completed provider round now appends a typed durable `session.provider.usage` event containing a bounded, secret-free report with request/context occupancy, cache/reasoning/tool-use/modality breakdowns, estimator drift, context-window provenance, provider/model labels, and turn/round identity. The durable event is intentionally not a conversation message and does not enter future model context.

Added a strict report normalizer: required token fields must be finite and non-negative; counts and labels are bounded; modality groups and entries are allowlisted/capped; unsupported keys/groups and invalid values are dropped. `/context` restores the newest valid usage report when the application starts on a resumed session, when `/resume` selects a session, and whenever `/fork` switches to the child session’s own event history (a child without a usage event correctly reports none). A telemetry event write failure is non-fatal to the provider turn and is surfaced as a status warning.

Tests verify durable kind/category, event persistence/reload, no message projection pollution, configured API-key exclusion, modality sanitation, malformed-latest fallback and report restoration. `npm run build`: PASS. Focused Phase 14H continuity test file: **14/14 PASS**. Full repository gate, dist verification, package/release checks are being refreshed after this slice. Phase 14H remains IN PROGRESS; native tokenizers, exact multimodal/framing costs, aggregate usage analytics, controlled provider replay, serial runner diagnosis and physical Termux checks remain open.


Final verification refresh for durable provider usage history — 2026-11-06: TypeScript build PASS; Phase 14H context-continuity suite **14/14 PASS**; complete parallel repository suite `node --test --test-concurrency=4 tests/*.test.mjs` **714/714 PASS** on a clean rerun in 29.6 seconds. An earlier full rerun had one transient failure that did not reproduce on the next complete run. `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (323 files; 492.1 kB); Android ARMv7/ARM64 bundle generation PASS; device smoke PASS as Linux x64 rehearsal only (`termux:false`). No physical Android/Termux validation was performed. The serialized `npm test` runner remains unresolved and no full serial result is claimed. Phase 14H remains IN PROGRESS.


Final rerun after tightening usage-report input bounds — 2026-11-06: context normalizer now caps modality enumeration work (at most 64 inspected keys per group and 12 accepted entries), strips control characters from display identifiers, requires a positive context window, and bounds timestamps to the JavaScript Date range. Context-continuity suite **14/14 PASS**. Complete four-worker repository suite **714/714 PASS** (29.2 seconds). A previous attempt failed one Phase 13I real-worker assertion (`failed` rather than expected `exited`); `tests/phase13i-tasks.test.mjs` passed 11/11 independently, and the subsequent full suite passed. Build PASS; distribution verification PASS; package dry-run PASS (323 files, 492.2 kB); ARMv7/ARM64 bundle generation PASS. Device smoke remains Linux x64 only (`termux:false`).

## 2026-11-09 — Phase 14H deterministic controlled replay

Added `tools/phase14h-controlled-replay.mjs` and `docs/examples/phase14h-controlled-replay.example.json`. The harness replays the same canonical, ordered request workload twice: the former message/schema-only compaction accounting and the current complete request-footprint accounting. It fingerprints route, schemas, ordered messages/tool outcomes, additional request overhead, and workspace snapshot identifier, then reports compaction counts, budget-overflow requests, request-size estimates, removed messages, and tool-call/result integrity.

The synthetic 14-request fixture yielded 5 compactions / 2 requests still above the estimated usable budget / 17,545 peak tokens for the legacy calculation versus 6 compactions / 0 over-budget requests / 13,668 peak tokens for the request-footprint-aware calculation. This is useful deterministic policy evidence, but it is not a provider-backed A/B experiment and does not validate tokenization, true cost, latency, or Android memory. The 759-event and 415-event historical JSONL sources are not included in this archive as raw logs; they must not be described as having been used by this new controlled harness.

Upstream review: OpenCode's current session compaction implementation keeps the recently used conversation beside a structured summary and treats estimate/overflow recovery as part of its compaction policy; the supplied OpenClaude source adds conservative summary output reservation and a consecutive-failure cooldown circuit breaker. TermAgent retains its own `accountContext`, `ContextBudget`, `compactMessages`, and durable checkpoint contracts; this continuation adds only a developer replay harness and does not fork the runtime compactor. See `docs/research/PHASE14H-REPLAY-ANALYSIS.md`.

Focused tests: `tests/phase14h-controlled-replay.test.mjs` — 3/3 PASS. Build PASS. Full suite, distribution/package checks, and final archive verification are pending for this continuation. Phase 14H remains IN PROGRESS; no physical Termux validation is claimed.

Final verification refresh for the 2026-11-09 controlled-replay continuation: focused Phase 14H continuity/replay suite **23/23 PASS**; full repository suite **719/719 PASS** with four workers (28.4 seconds) and **719/719 PASS** serially (95.6 seconds); `npm run build` PASS; `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (323 package files); device smoke PASS only as Linux x64 rehearsal (`termux:false`). The earlier serial invocation that stopped after test 234 had no TAP summary and is superseded by the completed 719/719 serial rerun. No physical Android/Termux validation was performed. Phase 14H remains IN PROGRESS because this offline synthetic policy replay is not a clean-equivalent provider-backed replay and provider-native tokenizer/framing costs, large-window/device-memory scaling, richer subagent conflict/restart coverage, and Termux validation remain open.


## 2026-11-11 — Phase 14H bounded provider context-overflow recovery

Resumed the Phase 14H context-overflow gap using the current OpenClaude implementation as the reference. Inspected `src/services/compact/autoCompact.ts` for the explicit `context-overflow` force reason, summary headroom policy and retry-storm protection, plus `src/services/compact/compact.ts` for bounded prompt-too-long recovery. Also rechecked OpenCode's measured/estimated compaction anchor in `packages/core/src/session/compaction.ts`. TermAgent keeps its existing `ProviderHttpError`, `Agent.run()` retry flow, `maybeCompact()`, `compactMessages()` and durable event store; no parallel recovery subsystem was added.

Added `isProviderContextOverflowError()` for explicit context-limit failures on HTTP 400/413/422. In `Agent.run()`, the first such failure forces one compaction toward 72% of usable context, records `provider-context-overflow` start/completion events, and retries once with the compacted history. A second rejection is surfaced; auth/rate-limit/unrelated errors and cancellation do not enter the recovery path. Forced compaction also applies the smaller target to safe micro-prune completion checks.

Regression tests cover common context-overflow signatures, rejection of unrelated/ambiguous errors, and an end-to-end mock provider that rejects its first request then succeeds after compaction. Focused Phase 14H context + provider-overflow tests: **23/23 PASS**; TypeScript build and `scripts/verify-dist.mjs` PASS. Full repository suite, package dry-run, source-hygiene checks and archive generation remain pending. No live-provider or physical Termux validation is claimed. Phase 14H remains IN PROGRESS; Phase 14I has not started.

## 2026-11-12 — Phase 14I batch-1 + batch-2 integration (live delivery, orchestration, shell, append)

Phase 14I ran as two four-stream batches on `phase-14i/batch1-work-division`, divided with strict per-stream file ownership so parallel execution could not collide at file level; shared docs (`TODO.md`, `PROGRESS.md`) were updated only at integration. Batch 1 (commits `c28f9c3`–`8e72246`) landed S1 child-agent provider credential resolution, S2 session-state lease hardening, S3 Windows port hardening (home resolution via `resolveHomeDirectory`, taskkill path, daemon-owner degrade), and S4 the static zero-dependency install website with GitHub Pages deployment; it merged through PR #1 on `whoops-1/termagent`.

Batch 2 completed four streams at the batch-1 integration gate. **B1 live event delivery:** the Web View invisibility root cause was the durable poll/suppression boundary, not the durable event log — the SSE durable poll now gates on the durable sequence (stat-validated fast path) before replaying pages, and the Web View blanket live-event suppression during the foreground POST prompt stream was narrowed to only the stream's duplicate sources (`session.text.delta`, `session.reasoning.delta`, `runtime.activity.changed`, `session.tool.output.delta`); durable frames still reconcile through `handleDurableEvent`. **B2 parent orchestration + task lock hardening:** a shared classified lock core in `src/tasks/manager.ts` (bounded backoff + jitter, live/malformed/stale classification, compare-before-recover/release, `lastTaskLeaseContention()` diagnostics, `waitTaskSettled` settle waiters, `withTaskLock`/`withSessionLock`), and `Agent` gained `deliverTaskNotification` with child-task settlement wakeup injected at every agent round boundary (round > 0); delivery is idempotent via durable `task.notification.consumed` markers and race-safe under the session lock; settle wakeup stays poll-based because `fs.watch` is platform-fragmented and fd-expensive on mobile. **B3 platform shell hardening:** new authoritative async `resolveShell` in `src/util/platform-shell.ts` (POSIX keeps `$SHELL || sh` with `-lc` byte-for-byte; win32: `TERMAGENT_SHELL` override → PATH sh-compatible discovery → COMSPEC fallback that refuses sh-only scripts with actionable remediation), wired into the task shell-command runner, task worker, bash/git builtin tools, `verify_project`, agent interpolation, doctor, and plugin hooks — call sites no longer pass `shell: 'sh'`. **B4 session append optimization:** a stat-validated in-memory `sequenceCache` fast path for `nextDurableSequence`/`currentSequence`, validated under the state lease with authoritative full-scan fallback on external append/truncate; turn-lease TOCTOU fixes (token compare-before-recover, mtime/size confirm guards); crash recovery unchanged.

Windows findings recorded at the gate: lock acquire treats EPERM as contention alongside EEXIST (Windows create-exclusive signal under concurrency); `spawnPlanFor` now returns `windowsVerbatimArguments` for cmd-grammar shells because Node's default arg quoting rewrites inner quotes to `\"`, which cmd swallows — `node -e "process.exit(5)"` degraded to bare `node -e` and exited 0 on EOF stdin (a false pass, empirically reproduced and now covered by a regression test); managed shells no longer detach on win32 because a detached `cmd.exe` drops the redirected output handle for grandchild processes, silently losing their output.

New focused suites: `tests/tasks/task-lock.test.mjs`, `tests/util/platform-shell.test.mjs`, `tests/session/session-append.test.mjs`, `tests/webapp-live-suppression.test.mjs` — **26/26 PASS**. Focused regression across `tests/tasks/`, `tests/session/`, `tests/util/` plus the Web View suite: **53/53 PASS**. Focused regression across `tests/server/`, `tests/protocol/`, `tests/agent/`, `tests/config/`, the install-site and 14F5 suites: **72/72 PASS** after the Windows fixes (both prior failures were pre-existing Windows limitations, one of which — the 13N-D verification path — is now exercised end-to-end). `npm run build`: PASS. `npm pack --dry-run`: PASS (331 files; 519.4 kB package; 2.2 MB unpacked). `node scripts/verify-dist.mjs`: PASS.

Full-tree bounded sweep (`node --test --test-concurrency=4` over every domain directory and root-level suite): **886 tests, 769 pass, 117 fail**. Every one of the 117 failures was verified pre-existing by a stash comparison (identical per-file failing-test sets with all batch-2 changes removed); the sweep introduced **zero batch-2 regressions** and batch-2 fixed one previously failing phase13e test. The failing set is Windows test-infrastructure debt: hardcoded `sh`/POSIX-path assumptions in test helpers and a few tests (phase13d/e, phase2-context, phase3-execution, phase5-parity, plugin/security, skill-catalog/registry, provider-manager, runtime-features, v09, phase12f-pty, phase13n-j, phase14a/d/e/f3, phase4), `symlink`/`pathToFileURL`/`sh -lc` limitations in `tests/phase1-hardening.test.mjs` (6), ESM raw-path `import()` crashes in `tests/experimental/ui-*.test.mjs`, POSIX-path assertions in `tests/agent/phase13n-b-evidence-progress.test.mjs`, and two Windows-limited `tests/context.test.mjs` repository-map tests. One test fixed during the gate: `tests/phase12c-diff-ui.test.mjs` hung the suite because `requestPermission` awaited a real `git diff` child after `leave()` — a pre-existing teardown race in `src/cli/ui.ts` (late continuation re-armed a ref'd activity interval) — closed by re-validating `active` after the await and guarding `setActivity()` timer creation, plus replacing the test's fixed 50 ms wait with a poll (cold `git` spawn on Windows exceeds it): **13/13 PASS**, file exits cleanly. `tests/phase12b-ui.test.mjs` has one deterministic snapshot-width failure (pre-existing).

Pre-existing Windows test-infrastructure limitations (unchanged by this work, documented for the Windows-port backlog): `tests/phase1-hardening.test.mjs` fails 6 tests that require symlink privileges, POSIX-only filenames, `pathToFileURL`-style child spawning, or a POSIX `sh -lc` git probe inside the test itself; `tests/experimental/ui-*.test.mjs` crash on the ESM loader because they `import()` raw Windows paths; `tests/agent/phase13n-b-evidence-progress.test.mjs` asserts POSIX-normalized paths that `path.resolve` rewrites on win32.

No physical Android/Termux validation was performed or claimed; device constraints remain a deployment target for later validation. Phase 14I remains IN PROGRESS: remaining work is parent-orchestration observe/reconcile and loop prevention, live-render/reconnect/stress assertions for the Web View, the Windows test-infrastructure backlog above, and physical device validation. Phase 14J has not started.
