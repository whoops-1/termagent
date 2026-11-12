# Phase 14H — Context, memory continuity, and instruction loading

**Status:** IN PROGRESS — implementation and parallel host regression gate pass; remaining acceptance evidence is explicitly listed below.

## Objective

Increase usable model context based on the actual selected provider/model route while preventing the larger context window from merely allowing more repeated exploration. Preserve TermAgent's existing context, checkpoint, repository intelligence, instruction, and skill systems. Keep device memory/payload bounds separate from model input-token capacity.

## Source findings and correction

The screenshot displayed `ctx 5k/12k`, but source inspection found no global 12K default in `src/config/config.ts`. `environmentDefaults()` leaves `maxContextTokens` unset unless `TERMAGENT_CONTEXT_WINDOW` is supplied. The supplied Phase 14F6 `.termagent-example.json` had an explicit `maxContextTokens: 12000` entry, and any existing `.termagent/config.json` can retain the same intentional cap. The current sample has been corrected. `/context` now reveals the active model/endpoint, limit source, output reserve, request estimate, usable and remaining capacity, compaction threshold/target, recent retention, prompt breakdown, and repository budgets.

Likewise, Phase 14F6 defaults `maxContextMessages`, `maxContextBytes`, `contextRecentTokens`, and `repoMapTokens` to zero. `maxContextMessages` is deprecated/ignored; it is not a default 80-message trimming rule. Repository map/retrieval were already model-aware and bounded by explicit mobile safety caps. These distinctions are now recorded in `TODO.md` and `docs/CONFIGURATION.md` so the roadmap does not carry forward the earlier inaccurate diagnosis.

## Implemented in this pass

- Removed the static 12,000-token ceiling from `.termagent-example.json`.
- Added/verified context-limit source provenance and corrected adapter output-limit provenance.
- Added `/context` diagnostics for model, sanitized endpoint, input window/output source, request estimate, usable budget, recent tail, prompt component accounting, and repository-map/retrieval allocations.
- Restored bounded file-read coverage into the fresh per-turn cache from durable context checkpoint state.
- Revalidated file identity with realpath containment, scope containment, file metadata, full SHA-256 content hash, total line count, before/after stat, and hard scan/restore limits.
- Kept raw file content out of durable session state; only metadata and complete line ranges are checkpointed. Rehydrated prompt evidence is subject to a much smaller independent budget.
- Restored prior loaded skill content by stable skill ID and digest. Corrected section budgeting so restored skill bodies are not assigned zero tokens when the current prompt contains no fresh explicit invocation.
- Documented existing nested instruction loading and safely restored saved instruction paths from workspace/global roots.
- Added focused regression tests covering these behaviors.
- Reworked the summary fitter to preserve all structural headings, keep each bullet under its original section, prioritize objective/requirements/decisions/Todo/current work before explanatory detail, retain the newest completed/blocked evidence first under pressure, and deduplicate repeated summary facts. A four-cycle regression fixture verifies objective, requirements, decisions, files, active Todo, verification evidence, all 11 headings, budget compliance, and atomic tool-call/result groups across successive compactions.
- Added a synthetic 10,000-module repository stress fixture (10,002 indexed paths including package/readme) that verifies dependency-graph extraction, focused symbol/file prioritization, bounded map output, cold index creation, and full warm-cache reuse (10,002 hits, zero misses). This validates the current indexed repository-map path at this fixture size; it does not prove million-token model-window or physical mobile limits.
- Corrected disjoint context-section accounting so summary and skill sections are not double-counted. Fixed durable API question projection matching by comparing stable persisted fields rather than UI-only properties. Updated affected API, lifecycle, `/auto`, UI snapshot, and provider usage fixtures to current behavior.

## Selective staged micro-pruning continuation — 2026-11-06

Reviewed upstream context shortening behavior before changing the existing TermAgent primitive. OpenClaude's API microcompaction clears configured read-result tool outputs separately from tool-use inputs. OpenCode's transcript compactor defines progressive levels: whole transcript, clipped outputs, omitted outputs with clipped inputs, user-only clipped text, then omission. TermAgent adopts the selective read-result principle at its existing `microPruneToolResults()` stage.

Micro-pruning now requires all of the following: the result is outside the protected recent turns; its tool is registered with both `risk: 'read'` and `readOnly: true`; its lifecycle is completed with `success`; and a valid `tool-output://<sha256>` reference exists. Shell/write outputs, failed/deferred/interrupted results, non-read-only plugin results, recent turns, unarchived results, and existing prune markers are retained. The replacement marker includes the tool name, call ID, and full-output reference. Only the active prompt projection changes; the ToolOutputStore archive and durable session event log remain untouched. Repeated micro-pruning is idempotent.

Regression tests cover archived read-only pruning, recent call/result integrity, shell and write protection, missing-reference protection, failed-result preservation, and marker idempotence. Focused gate: **43/43 PASS**. Complete repository gate after the change: `node --test --test-concurrency=4 tests/*.test.mjs` — **713/713 PASS** (29.1 seconds). The first full rerun exposed two unrelated worker/plugin timing failures; both affected files passed independently and the subsequent complete four-worker run passed cleanly.


## Durable provider usage history — 2026-11-06

Added provider usage as a typed durable session event (`session.provider.usage`) using the existing SessionStore append/replay pipeline. Each completed provider round records only a bounded report: effective input, final-request context occupancy, non-cached input, output, total, estimator input/drift, context-window provenance, cache/reasoning/tool-use counts, a constrained modality breakdown, provider/model identifiers, timestamp, turn ID, and round number. API keys, base URLs/endpoints, raw request/response bodies, and raw provider metadata are excluded.

The normalizer rejects incomplete/invalid token reports, clamps numeric values, bounds provider/model/source strings, limits modality groups and keys, and ignores unsupported modality groups. The latest valid report is restored from the selected session's durable events at startup, `/resume`, and whenever a fork switches the active session to its own event history; a newly created child with no usage event correctly has no inherited request measurement. Provider usage events are typed as durable provider-category events but remain outside the conversation-message projection, so they are not added to model context. A failed session write does not abort an otherwise successful provider turn; it surfaces a bounded status warning instead.

Regression coverage verifies durable event kind/category, session reload, separation from conversation messages, absence of configured API key material, modality sanitation, malformed newest-event fallback, and restored latest report. Focused Phase 14H context suite: 14/14 PASS after this addition; full repository verification is recorded in the latest progress entry. Aggregate historical analytics and controlled provider-backed replay remain open.

## Verification completed

- `npm run build`: **PASS**.
- Focused context/continuity/compaction/agent/E2E set before the latest provider slice: **180/180 PASS**. The provider/context focused set after the latest slice: **28/28 PASS**.
- Entire repository test inventory using bounded parallel test workers before the latest micro-pruning slice: `node --test --test-concurrency=4 tests/*.test.mjs`: **711/711 PASS**.
- The package's serialized `npm test` command (`--test-concurrency=1`) remains unvalidated end-to-end. In bounded attempts it did not finish within the execution window and emitted no failing assertion before termination. The serial run is not counted as a pass or as a failed test suite; it remains an execution-time/serial-throughput question.
- `node scripts/verify-dist.mjs`: **PASS**.
- `npm pack --dry-run`: **PASS**.
- Android ARMv7/ARM64 release bundle generation: **PASS** (bundle generation only; not physical Android execution).
- `TERMAGENT_ALLOW_NON_ANDROID=1 npm run device:smoke`: **PASS** as a Linux rehearsal only (`termux:false`); it is not physical Termux validation.

## Replay findings and corrective change

The supplied 759-event/50-compaction log and the 415-event companion log have now been reconstructed through the existing `SessionStore` projection. The 759-event trace has 102/102 assistant tool-call/result pairs intact, but also contains 19 exact repeated exploration calls across compaction epochs. Its historical post-compaction footprint had p50 7,419 and p95 7,550 estimated tokens against 7,792 usable tokens; provider usage fields are absent. The companion trace is not a controlled clean equivalent because its duration, turn count, message count, and task activity differ.

A single-pass counterfactual using the current compactor reduced the 759-event trace projection from 28,684 to 4,205 estimated message tokens while preserving 7 complete tool-call/result pairs. The current fitted summary initially dropped the `## Work State` and `## Todo` headings; that defect is fixed and covered by a regression test. The current summary now retains all 11 required headings in this fixture. This is not evidence of improved incremental compaction count or latency. Full method and limitations: `docs/research/PHASE14H-REPLAY-ANALYSIS.md`.

## Still open

1. Complete and diagnose the serialized package script (`--test-concurrency=1`). The latest bounded attempt reached test 218/711 in 120 seconds without an emitted failing assertion but did not complete. Distinguish expected serial runtime from process-order/lifecycle overhead before changing the device-oriented package script.
2. Deterministic clean-equivalent replay with identical prompts, tool outcomes, provider route, schemas, and workspace snapshot; incremental compaction count/trigger reason and latency comparison.
3. Provider-specific tokenizer and estimator drift across supported adapters, including framing, multimodal costs, and tool-use prompt/modality overhead. Per-request usage reports are durable and restored into `/context` on session resume; aggregate historical analytics and controlled provider-backed drift replay remain open. Anthropic separate cache accounting, OpenAI-compatible usage aliases, Gemini cached/thinking usage, and live `/context` reporting are implemented and tested.
4. Expand large-repository performance and relevance tests beyond the current 1,000-module fixture, including map/retrieval quality under 500K+/million-token windows and constrained-memory devices.
5. Broader multi-cycle compaction audit over real long traces, machine-state edge cases, and conflicting/newer versus stale task state. The four-cycle synthetic continuity test now passes, but this is not a substitute for a controlled provider-backed workload.
6. Restart/subagent tests for nested instruction scopes and skill restoration, plus near-budget conflict/precedence cases.
7. Physical Termux/Android memory and latency verification. Host tests do not substitute for device tests.

Do not mark Phase 14H complete until these items and the TODO.md 14H acceptance criteria pass. Proceed to Phase 14I only after the 14H gate is actually closed.


## 2026-11-05 continuation — provider usage accounting

Adapted upstream usage handling patterns from OpenCode's OpenAI Chat protocol and the supplied OpenClaude 0.31.0 source archive. OpenAI-compatible usage now accepts top-level and choice-level usage, Chat Completions fields, nested cache/reasoning breakdowns, and common compatible Responses-style aliases. Gemini's effective prompt includes cached content; thinking tokens are included in output; cache and reasoning detail fields remain subsets. Anthropic's cache-read/cache-write values remain separate from uncached `input_tokens`, and are added exactly once when calculating effective input. Inclusive provider `totalTokens` is not increased by cache subsets a second time.

`/context` now displays the latest provider-reported usage (input, uncached/cache breakdown, output, reasoning, inclusive total), the local request estimate and drift. The latest report is held in process memory only. A retry regression found and fixed a smaller accounting issue: usage emitted by a failed attempt is cleared before a retry, preventing it from being reported as the successful request's usage when the retry does not return usage.

Additional regression coverage: OpenAI-compatible usage alias and choice-level mapping; Gemini cached/thought totals; Anthropic cache occupancy and no-double-count total; failed-attempt usage isolation. Focused test command: `node --test tests/phase14h-context-continuity.test.mjs tests/phase13n-f-provider-reliability.test.mjs` — **24/24 PASS** after the retry-isolation regression was added. The full repository suite was rerun with four workers: **707/707 PASS** in 28.9 seconds. The serial aggregate rerun still did not produce a final TAP result before the execution limit; its latest visible TAP event was test 285. The checkpoint test file passes 8/8 in isolation.

Remaining accounting gaps: provider-native tokenizer integration, full multimodal/framing/tool-use prompt overhead, durable usage telemetry across restart, and a provider-backed clean-equivalent historical replay. This slice does not close Phase 14H.


Updated release verification for the selective-pruning slice: `npm run build` PASS; `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (323 files; 490.7 kB package); Android ARMv7 and ARM64 bundle generation PASS; device smoke PASS on Linux x64 only (`termux:false`). No physical Android/Termux validation was performed.


Latest verification refresh — 2026-11-06: `npm run build` PASS; focused continuity suite **14/14 PASS**; full repository suite `node --test --test-concurrency=4 tests/*.test.mjs` **714/714 PASS** on a clean rerun (29.2 seconds). An earlier concurrent run had a transient worker-exit assertion in the Phase 13I real-worker test (`failed` versus expected `exited`); that file passed 11/11 in isolation and the following full run completed green. `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (323 package files, 492.1 kB); Android ARMv7/ARM64 release bundle generation PASS. Device smoke PASS only as a Linux x64 rehearsal (`termux:false`). The serialized package script (`--test-concurrency=1`) remains without a complete final TAP result, and physical Termux verification remains open. Phase 14H remains IN PROGRESS.


## 2026-11-09 continuation — request-footprint compaction and continuity

Reviewed the existing OpenClaude `autoCompact.ts`, `apiMicrocompact.ts`, `microCompact.ts`, and `requestSizeBreakdown.ts` patterns, plus OpenCode's session compaction and provider request-accounting behavior. Kept TermAgent's existing `accountContext()`, `maybeCompact()`, compactor, `SessionStore`, and `/context` command. No second budget or telemetry subsystem was introduced.

Automatic compaction now uses the same existing request-footprint estimate used by request construction, including the estimator's multimodal contribution and live tool-schema cost, rather than triggering from text-message and schema estimates alone. Since the compactor shortens text history, the usable message budget subtracts schemas, additional request tokens, and multimodal estimate before calculating the text-history target. Trigger origin is labelled (`turn-entry`, `route-change`, `provider-request`, or `post-tool-round`).

A durable compaction lifecycle event is written before the compaction attempt and a completion event records the method, trigger, reason, before/after request estimates, message/schema/multimodal/additional-token components, usable budget, headroom, removed/pruned/retained counts, and timestamp. `/context` now displays the latest completed automatic compaction summary. Estimates remain heuristic: this does not provide provider-native tokenization or exact image/audio/video/provider framing.

Added `Agent.run()` restart integration coverage for nested instruction restoration: it verifies saved nested paths are restored, changed instruction content is reloaded, and a sibling scope does not leak. Added an automatic-compaction integration regression that exercises a recent multimodal estimate and verifies durable before/after budget diagnostics. The repository-map fixture now exercises 10,000 modules and 10,002 indexed paths.

Verification on the 2026-11-09 source snapshot: Phase 14H continuity **16/16 PASS**; full repository suite **716/716 PASS** with four workers (27.8 seconds); full repository suite **716/716 PASS** serially with `--test-concurrency=1` (82.7 seconds); `npm run build` PASS; `node scripts/verify-dist.mjs` PASS; CLI reports version **1.18.0**. The earlier serial-runner/Phase 13I exit instability did not reproduce in either complete run on this snapshot.

Still open: deterministic clean-equivalent replay with provider usage and identical tool outcomes; native tokenizer and exact multimodal/framing accounting; aggregate historical provider analytics; large-window (500K/1M) and constrained-memory measurement; broader multi-cycle real-trace and nested instruction/subagent conflict tests; and physical Android/Termux validation. The synthetic 10K repository fixture and Linux host checks do not substitute for device measurements. Phase 14H remains **IN PROGRESS**.

## 2026-11-09 continuation — deterministic replay harness

Added a controlled offline replay harness that executes the same canonical ordered workload under the previous message/schema-only compaction accounting and the current full request-footprint accounting. The workload fingerprint includes the provider/model route, tool schemas, message/tool-result sequence, additional-request overhead, and workspace snapshot identifier. Both policies reuse the authoritative TermAgent budget and compactor functions. A synthetic 14-request fixture shows 2 estimated-budget overflows under the legacy calculation and 0 under request-footprint-aware accounting (peak estimate 17,545 vs 13,668 tokens). This is a deterministic synthetic policy comparison only, not provider-backed or physical-device evidence. The clean-equivalent replay acceptance item remains open.
