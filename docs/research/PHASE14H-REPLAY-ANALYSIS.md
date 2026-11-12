# Phase 14H — supplied session replay analysis

**Status:** Historical traces replayed; controlled clean-equivalent comparison remains open.

## Method

`tools/phase14h-session-replay.mjs` parses the supplied durable JSONL events and loads each trace through TermAgent's existing `SessionStore.load()` and `latestContextCheckpoint()` projection. It does not create a replacement session store, invoke a provider, or execute historical shell/file mutations.

The analyzer checks durable sequence continuity, context-checkpoint/compaction epoch pairing, message-level assistant tool-call/result pairing, tool lifecycle completion, exact repeated exploration-tool signatures across compaction epochs, summary-section coverage, task-notification consumption, and the estimator data actually recorded in the log.

It also runs the current `compactMessages()` implementation once over the reconstructed message-only transcript. The comparison reserves the trace's recorded schema-token estimate and the current checkpoint-notice allowance. This is a one-pass counterfactual, not an incremental agent replay: the JSONL does not contain the exact system prompt, instruction-file contents, route framing, full tool schemas, or provider responses needed to recreate every historical request.

## 759-event trace — 50 recorded full compactions

- Model: `mercury-3`; recorded context window: 12,000 tokens; recorded usable request budget: 7,792 tokens.
- Duration: 626.4 minutes across 4 committed turns; 165 reconstructed messages; estimated message-only transcript size: 28,684 tokens.
- 50/50 compactions have matching full-compaction context checkpoints. No durable sequence gaps, duplicate sequences, or unmatched compaction epochs were found.
- Recorded post-compaction request footprint (message estimate + schema estimate): mean 7,395.94 tokens, p50 7,419, p95 7,550, against 7,792 usable tokens. Mean remaining headroom was 396 tokens. The post-compaction footprint therefore stayed close to the configured budget; this does not by itself prove the compaction trigger was wrong.
- The 50 historical summaries covered a mean of 8.64/11 required structural headings. `## Requirements` and `## Decisions` were absent from every recorded historical summary. The oldest historical summary path also had two records with additional missing headings.
- There were 102 unique assistant tool calls and 102 corresponding tool-result messages. No orphaned calls, unmatched results, or duplicate result IDs were found.
- There were 68 exploration calls: 23 `read_file`, 17 `repo_map`, 25 `glob`, and 3 `grep`. Nineteen calls repeated an exact normalized tool/argument signature across compaction epochs, across eight repeated signatures. This is direct evidence that the recorded session re-requested some identical exploration after compaction.
- Read coverage was non-empty in 48/52 checkpoints. Exploration, evidence-ledger, tool-output-reference, and continuation state were populated in all 52. No checkpoint had non-empty `activeTaskIds`, `todo`, or `loadedSkills`; the `instructions` field was absent in this historical trace. Absence in this trace is not proof of a current implementation failure because it predates the Phase 14H continuity changes and those state types may not have been active in that session.
- Six task notifications were recorded, all failed child-agent jobs due to provider HTTP 401 `invalid_api_key`; four were marked consumed and two were not. This is relevant historical evidence for Phase 14I's child-agent delivery/credential work, not a Phase 14H acceptance result.
- The 165 `provider.turn` records contain no provider-reported usage fields. Request-estimator drift cannot be measured from this trace.

### Current compactor one-pass counterfactual

Applying the current TermAgent compactor to the 165 reconstructed messages, with the trace's schema reserve and the calculated checkpoint-notice reserve:

- Input: 28,684 estimated message tokens.
- Message reduction budget: 4,957 estimated tokens.
- Output: 10 messages, 4,205 estimated message tokens; 153 messages removed from this projection.
- Seven assistant tool calls and all seven corresponding tool results remained paired; no retained orphaned call was found.
- All 11 required summary headings survived the fitted summary.

This demonstrates the present compactor's one-pass budget and pairing behavior on this historical transcript. It does not establish a lower incremental compaction count or lower end-to-end latency.

## 415-event companion trace — 24 recorded full compactions

- Same model label and workspace; 19.0 minutes, 1 committed turn, 62 reconstructed messages, 25,188 estimated message tokens.
- Recorded 24 full compactions, all with matching checkpoints; window and usable budget were again 12,000 and 7,792 tokens.
- Post-compaction footprint p50 7,424 tokens and p95 7,464 tokens.
- All 33 assistant tool calls were paired with one tool result; no exact repeated exploration signatures were found in this trace.
- 27 task notifications were present and none had a matching consumed event in this log.
- Provider usage fields were again absent.
- The current one-pass compactor retained 10 messages and 4,475 estimated message tokens from 25,188 input tokens, removing 56 messages from the projection. Five tool calls and their five results remained paired; all 11 required summary headings survived.

The 759-event and 415-event traces are not a controlled A/B pair. They differ substantially in duration, committed-turn count, event count, message count, and task activity. The 415-event file is therefore reported as a companion observation, not as a clean baseline.

## Corrective change found by replay

The one-pass replay exposed a real summary-fitting bug in `src/agent/compaction.ts`: `fitText()` prioritized important headings but did not classify `## Work State` and `## Todo` as structural headings. Those headings could disappear from the fitted prompt even though `buildSummary()` had created them. The fitter now retains every required structural heading, selects content by section priority while restoring original line order, and deduplicates repeated summary facts. Regression coverage asserts all 11 headings and complete tool-call/result groups under a constrained budget. A separate four-cycle test forces successive compactions and verifies the active objective, requirement, decision, exact file references, Todo ID, retained verification evidence, budget compliance, and atomic tool-call/result units across the cycles.

## What remains before the replay gate can close

1. Capture a clean-equivalent deterministic workload with identical prompts, tool outcomes, provider route, tool schemas, and workspace snapshot. Use a recorded/mock provider response stream; do not replay destructive tools against a live workspace.
2. Persist or ingest provider-reported usage so each request can be compared against TermAgent's estimate, including cache, image, reasoning, framing, and tool-schema costs.
3. Measure incremental compaction count and trigger reason per provider request under current model-aware limits. The existing logs only record compaction results, not the complete request footprint at every provider call.
4. Broaden the four-cycle synthetic continuity test into a controlled replay with explicit read coverage, exploration, task IDs, nested instructions, skill digests, and stale-versus-current state conflicts.
5. Expand the current 1,000-module cold/warm repository fixture to larger workspaces and run physical Termux memory/latency checks.

## Reproduction

```sh
npm run build
node tools/phase14h-session-replay.mjs /path/to/759-event-session.jsonl /path/to/companion-session.jsonl
node tools/phase14h-session-replay.mjs /path/to/759-event-session.jsonl --json
node --test tests/phase14h-session-replay.test.mjs
```

## 2026-11-09 continuation — controlled request-footprint replay

Added `tools/phase14h-controlled-replay.mjs`, a deterministic policy replay harness built on the existing `accountContext()`, `createContextBudget()`, `estimateMessagesTokens()`, and `compactMessages()` implementations. It does not add a second estimator or compactor.

The workload format pins one provider/model route, context/output limits, tool schemas, initial messages, workspace snapshot identifier, and an ordered list of requests. Each request records the exact messages/tool outcomes to append plus any additional request-token estimate not represented as ordinary chat messages. A canonical SHA-256 fingerprint covers the normalized route, schema, ordered inputs, and workspace snapshot identifier. The harness runs two policies over that identical workload:

- `legacy-message-schema-only`: the former trigger/target calculation using message and tool-schema estimates, but not the additional request overhead or multimodal estimate.
- `request-footprint-aware`: the current `accountContext()` footprint plus additional request overhead, reserving schemas, multimodal estimate, and additional request tokens before selecting the text-history budget.

The two runs report compaction count, requests that remain over the estimated usable budget, peak/mean post-policy request estimate, removed-message count, and retained tool-call/result integrity. The sample workload is `docs/examples/phase14h-controlled-replay.example.json`.

Sample result on the 2026-11-09 host snapshot (14 identical ordered requests, fixture route `fixture-provider/fixture-model-20k`, synthetic recorded tool results): legacy accounting performed 5 compactions and left 2 requests above the estimated usable budget, with a 17,545-token peak actual estimate. Request-footprint-aware accounting performed 6 compactions and left 0 requests above the estimated usable budget, with a 13,668-token peak. Mean estimated request size was 11,836 vs 10,831. This demonstrates the expected behavior of the accounting correction on this synthetic fixture; it does not establish provider-backed token accuracy, latency/cost improvement, or production-session A/B improvement.

Run after building `dist`:

```sh
node tools/phase14h-controlled-replay.mjs docs/examples/phase14h-controlled-replay.example.json
node tools/phase14h-controlled-replay.mjs path/to/workload.json --json
node tools/phase14h-controlled-replay.mjs path/to/workload.json --out replay-report.md
```

The harness explicitly labels the run as provider-free. A real clean-equivalent experiment still requires matching provider route and tool schemas, identical prompts/tool outcomes, a pinned workspace snapshot, actual provider usage, and timing/cost observations. The earlier 759-event and 415-event historical logs are not present in this archive as raw JSONL inputs, so the synthetic example must not be represented as a replay of those sessions.

## Opt-in provider trace capture and estimator replay

`TERMAGENT_PROVIDER_TRACE_DIR=/absolute/private/path` enables one atomic JSON capture for each completed provider request. Capture is disabled when the variable is unset. The capture records the exact `ChatMessage[]` and tool schemas passed to the provider boundary, the normalized provider usage, any provider-native count result, the current estimator breakdown, the route/window provenance, and the assistant response/tool calls. Session and turn IDs are SHA-256 pseudonyms. Provider configuration objects (including configured API keys, authorization headers, base URLs, and endpoint query strings) are not serialized. However, exact prompt/response content is preserved and can itself contain secrets, pasted credentials, code, or personal data; the capture metadata states this explicitly. The analyzer can validate payload identity and compare recorded usage values, but cannot independently prove whether a file originated from a live provider rather than a test or synthetic adapter.

**Privacy:** request and response content can contain source code, prompts, personal data, or secrets pasted into a conversation. These files are deliberately not secret-scrubbed because modifying request content would invalidate exact-payload token comparison. The user must explicitly enable capture, keep the directory private, and review every capture before sharing it. Files are created with mode `0600` and the directory with mode `0700` where supported. Individual captures over 32 MiB are rejected without truncation.

Replay and analyze captures after building:

```sh
TERMAGENT_PROVIDER_TRACE_DIR="$HOME/.termagent/provider-traces" termagent
npm run build
npm run phase14h:provider-replay -- "$HOME/.termagent/provider-traces"
npm run phase14h:provider-replay -- "$HOME/.termagent/provider-traces" --json
```

The analyzer verifies each request-payload SHA-256, recomputes the exact TermAgent message and full-request estimates from the captured messages/schemas, then compares them with the provider-reported context/input counts and optional native preflight count. When produced by a real configured provider session, this supplies provider-reported estimator calibration. Treat each trace's origin as an operator-verified fact; the replay analyzer does not cryptographically attest provider authenticity. It does **not** claim the clean-equivalent legacy-vs-current compaction A/B is complete: that still requires a chronological capture of pre-compaction conversation states, response streams, and recorded tool outcomes so both policies can replay the same workload without executing tools.


## 2026-11-10 continuation — durable provider-usage event reconciliation

A newer user-supplied session log (`mwah4u1t-68024136.jsonl`) contains 136 durable events, 3 committed turns, 11 `provider.usage` records, 17 completed tool calls and 17 corresponding tool-result messages, plus 3 baseline context checkpoints. It has no `compaction` event and no `full-compaction` checkpoint. The log therefore provides a provider-usage observation and tool chronology, but not the pre/post-compaction chronology required for a clean-equivalent compaction A/B.

The first run of this replay analyzer reported zero provider-usage records because it inspected `provider.turn` lifecycle events only. Current TermAgent appends usage as a separate `provider.usage` event. The analyzer now reads both formats and delegates normalization/aggregation to the existing `aggregateProviderUsageEvents()` helper. It retains old `provider.turn`-embedded usage compatibility, suppresses an embedded legacy copy when the matching dedicated event is present, and rejects invalid round identifiers rather than treating `null` as numeric round zero. This does not add a parallel usage aggregator.

Corrected result for this session:

- 11/11 provider rounds have a usage record; all 11 are marked provider-reported (`estimated: false`). The event format cannot independently attest the actual live origin.
- Inclusive input: 314,389 tokens; non-cached input: 76,440; cache-read subset: 237,949; cache-write: 0.
- Output: 5,631; total input + output: 320,020. Cache counts are input subsets and are not added a second time.
- Cache read is approximately 75.7% of input.
- Weighted message-estimate drift is +19.7%, with the denominator being provider-measured context as defined by `aggregateProviderUsageEvents()`. This is distinct from the full-request drift in `phase14h-provider-trace-replay.mjs`.
- Route: `openai-compatible/mercury-3` only. No native token-count result is available. This single-route/single-session sample is not a basis for a global estimator adjustment.
- Tool calls/results: 17/17 paired, no duplicate result IDs. Three checkpoints are baseline-only; no compaction epoch was exercised.

The usage semantics follow OpenCode's current non-overlapping invariant: `nonCachedInputTokens + cacheReadInputTokens + cacheWriteInputTokens = inputTokens`, and reasoning remains an output breakdown. OpenCode also emits a separate durable `UsageRecorded` event for generation and compaction usage. OpenClaude's VCR illustrates exact-input fixture capture/replay, and its request-size breakdown demonstrates contributor categorization. TermAgent keeps its own provider event contract, `SessionStore`, and shared aggregation helper.

References:
- OpenCode usage normalization: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/usage.ts
- OpenCode usage schema invariant: https://github.com/anomalyco/opencode/blob/3b04ec6f5950b25713f869adf80b878e16a8d50a/packages/ai/src/schema/events.ts
- OpenCode compaction usage recording: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts
- OpenClaude VCR: https://github.com/Twigpine/openclaude/blob/main/src/services/vcr.ts
- OpenClaude request breakdown: https://github.com/Twigpine/openclaude/blob/main/src/utils/requestSizeBreakdown.ts

Focused Phase 14H suite after the fix: **34/34 PASS**. Follow-up checks: `npm run build`, `node scripts/verify-dist.mjs`, `npm pack --dry-run` (325 files), and CLI version `1.18.0` all PASS. The four-worker full repository run hit the 240-second execution limit after test 446 without a reported assertion failure or final TAP summary; it is inconclusive. No physical Termux validation was performed. Remaining replay gate: collect a clean-equivalent request chronology with matching prompts, exact route/tool schemas, recorded provider responses and tool outcomes; include a compaction transition/checkpoint; compare policy outcomes without re-executing destructive tools.


## 2026-11-10 continuation — provider-measured compaction trigger gap

The second supplied session (`mwai6tsy-80da7804.jsonl`) contains 1,024 durable events over 47.7 minutes, 9 committed turns, 231 reconstructed messages, 90/90 provider-reported usage rounds, 131/131 paired tool calls/results, 9 baseline checkpoints, and **zero compaction events**. Usage totals are 12,043,265 inclusive input tokens (1,693,999 uncached + 10,349,266 cache read), 87,501 output tokens, and 12,130,766 total tokens. Weighted message-estimate drift is +31.9%. This is one route/model (`openai-compatible/mercury-3`) and the JSONL's `estimated:false` field is not cryptographic proof of a live-provider origin. The replay is diagnostic: it does not execute old requests or fabricate response events.

The runtime inspection identified two independent causes. First, `maybeCompact()` used local request-footprint estimate only and did not use a prior durable provider-measured context value when an OpenAI-compatible adapter had no native count endpoint. Second, some final/no-tool branches exited without running the post-provider-response compaction check. Therefore the UI could show provider-reported context above the configured window while the internal estimate stayed below threshold, and a completed final response could return without compaction.

Adapted OpenCode's current `Estimate { measured, estimated }` pattern in `packages/core/src/session/compaction.ts`: anchor on the latest provider-measured request and estimate only the request delta since that anchor. New TermAgent `provider.usage` records also carry `estimateRequestTokens`, the full existing `accountContext()` footprint. Old reports remain supported with the prior message estimate plus currently bounded schema tokens. The runtime derives a bounded median correction from up to five recent samples, only for the matching provider/model/context window; the correction is not global and is reset on a route change. The effective compaction signal is the largest of local estimate, route-corrected estimate, measured anchor plus added-request delta, and native provider count if one is available. Final/no-tool responses and terminal tool-blocked responses now run the compaction check before returning Ready. The composer distinguishes a reconstructed/local context estimate with `~`; live provider usage remains unmarked.

Regression tests cover a resumed OpenAI-compatible session whose measured baseline exceeds its local estimate and a final no-tool response whose provider-reported input exceeds the limit. Existing Anthropic/Gemini native preflight and legacy usage-report compatibility remain covered. These are deterministic mock-provider tests; no live provider call was performed. The supplied 1,024-event trace itself still has no compaction entries, so it is not evidence of a post-fix replay.

Upstream references: [OpenCode session compaction](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts), [OpenCode session usage](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/usage.ts), and [OpenClaude auto compaction](https://github.com/Twigpine/openclaude/blob/main/src/services/compact/autoCompact.ts). OpenClaude's current code includes output reservation and bounded repeated-failure handling; its `reactiveCompact.ts` in the inspected snapshot is a feature-gated stub, so no claim of active reactive compaction is made.

Verification: repository inventory **104/104 test files; 874/874 tests PASS** in serial bounded batches; focused Phase 14H/context/trace/replay and semantic UI suites **46/46 PASS**; `tsc -p tsconfig.json --pretty false` PASS; `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (325 files, 500.8 kB); `node dist/index.js --version` is `1.18.0`; Linux x64 device smoke PASS (`termux:false`). Physical Android/Termux, live-provider request capture, first-request overflow recovery when a provider rejects before reporting usage, and provider-backed clean-equivalent compaction A/B remain open.

## 2026-11-11 continuation — adaptive estimator shadow replay against real provider traces

A newer user-supplied dataset pairs 110 exact provider-request captures (`provider-traces.zip`) with a 1,161-event durable session log (`mwbs4kru-6f3f02ae.jsonl`). The source files are intentionally not included in the TermAgent source archive because captures contain prompt, source-code, tool-argument, and provider-response content.

The replay now accepts a matching session log and performs a **shadow replay of the existing `Agent.run()` route-scoped calibration algorithm**. It verifies the session identity by comparing the trace's session-ID hash with the session metadata ID, groups captures by hashed turn and request round, matches each usage event to the exact capture timestamp/route/input/output/full-request-estimate, restores only provider-usage events after the latest completed compaction at turn entry, uses only prior measurements when predicting a request, resets the measured baseline at an in-turn completed compaction, preserves the rolling route ratio for the remainder of that `Agent.run()`, and resets calibration on provider/model/context-window change. Current capture usage is applied only after that capture's prediction.

The dataset matches the session log exactly: **110/110** usage events match on timestamp, provider, model, context window, input tokens, output tokens, and full-request estimate; all 11 turns match; all 3 compaction boundaries are replayed. One route/model is present (`openai-compatible/mercury-3`), and no provider-native token count was captured.

### Results: raw estimator versus runtime adaptive estimator

The raw local full-request estimate still materially undercounts the provider:

- Raw estimated full-request tokens: 3,402,759 across the 110 requests.
- Provider-observed input/context: 5,721,114.
- Weighted raw undercount: **40.5%**.
- Mean per-request absolute raw drift: **35.2%**.

However, the runtime already has a provider-route-scoped adaptive correction. Replaying that exact formula changes the interpretation significantly:

- Aggregate signed adaptive prediction error: **+0.1%** (positive means slight overestimation).
- Mean per-request absolute error: **3.5%**.
- p50 absolute error: **2.1%**.
- p95 absolute error: **13.7%**.
- Maximum absolute error: **29.3%**.
- Underpredictions: 52; overpredictions: 58.
- Turns seeded from durable prior provider usage: 10/11.
- One request was a true cold-start prediction with no prior calibration measurement.
- Native token-count predictions: 0/110.

This evidence changes the next engineering decision: **do not replace the existing runtime estimator with a global multiplier**. The route-scoped online calibration is effective for this particular Mercury workload, while the raw local estimator by itself remains inadequate. The replay should keep reporting both rather than collapsing them into one accuracy figure.

### Remaining miss and limits

There was one provider-observed budget crossing: 84,381 input tokens against an 84,000-token usable budget. The runtime shadow prediction was 82,463, so it missed the crossing by 381 actual tokens (the prediction was 1,537 tokens below the configured budget, and the actual request was 381 above it). The absolute prediction error was 2.27%. This is a useful concrete calibration miss; it does not establish that the context overflow/retry path ran, because the session has no corresponding overflow-recovery event.

The largest absolute adaptive error was a conservative overestimate immediately after a compaction: 39,285 predicted versus 30,377 observed (29.3%). The route ratio persisted through the compaction while the measured baseline was reset, as the runtime currently does. A single post-compaction observation is not enough evidence to change that behavior; more route/session samples are needed.

The original 110-capture analysis also records three successful compactions and four context epochs. Captures show provider input falling after the three compactions, but this is observational chronology, **not** a clean-equivalent legacy-versus-current A/B. It cannot prove that another policy would preserve the same answers, cost, or tool outcomes.

### Replay command

After building TermAgent, pass both the trace directory and matching session JSONL:

```sh
npm run phase14h:provider-replay -- "$HOME/.termagent/provider-traces" --session-log /path/to/session.jsonl
npm run phase14h:provider-replay -- "$HOME/.termagent/provider-traces" --session-log /path/to/session.jsonl --json
```

The CLI refuses to simulate adaptive calibration when the session identity does not match. Its report distinguishes raw estimation from the runtime adaptive prediction and lists any adaptive prediction that misses the configured usable-budget crossing.

### Upstream comparison and decision

The upstream sources reviewed for this iteration:

- [OpenCode token estimate](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/util/token.ts): the core generic estimate is `input.length / 4`; it does not provide a provider tokenizer for arbitrary OpenAI-compatible endpoints.
- [OpenClaude token estimation](https://github.com/Twigpine/openclaude/blob/main/src/services/tokenEstimation.ts): supports provider/native token counting where available and a rough fallback; includes JSON/code/list/table content categories and estimates with bounds.
- [OpenClaude request-size breakdown](https://github.com/Twigpine/openclaude/blob/main/src/utils/requestSizeBreakdown.ts): attributes context to system prompt, schemas, history, tool calls/results, attachments, memory, agents and skills. Contributors are apportioned against request categories to avoid treating overlapping categories as independent extra tokens.

The inspected upstream heuristics are useful for first-request estimates and contributor diagnostics, but the measured Mercury trace indicates route-scoped calibration is considerably more accurate once usage exists. Do not port a generic content ratio or global multiplier before collecting independent provider/model traces and evaluating cold-start behavior. The next investigation should focus on the cold-start miss, the single 84,381/84,000 budget crossing, and whether post-compaction ratio retention should use a more conservative decay or reset policy.

### Verification and status

The new shadow replay is covered by deterministic tests for no-lookahead prediction, persisted-usage seeding across turns, in-turn compaction baseline reset, exact provider-usage matching, and session-identity mismatch refusal. The focused provider-trace file passes **8/8** tests. This is analyzer/test coverage only; the live provider was not contacted during replay, native token count remains unavailable, and the clean-equivalent compaction A/B remains open. Physical Android/Termux validation remains open. Phase 14H remains active; do not start Phase 14I.
