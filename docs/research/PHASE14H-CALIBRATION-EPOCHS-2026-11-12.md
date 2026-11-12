# Phase 14H — Compaction-epoch calibration review (2026-11-12)

## Scope

Investigate why the provider-measured adaptive estimator carried a large post-compaction error, compare calibration transition strategies on two chronological TermAgent provider-trace/session-log datasets, and record the selected candidate behavior. This is an offline shadow replay; it is not a provider-backed compaction A/B and does not establish task-quality equivalence.

## Source finding

`src/agent/agent.ts` kept three related values inside `Agent.run()`:

- `providerUsageBaseline`: latest measured request/context anchor;
- `recentRatios`: bounded provider/model/context-window estimate-to-observed samples;
- `providerTokenRatio`: median correction applied to request estimates.

Before this continuation, successful micro-pruning and full compaction cleared only `providerUsageBaseline`. The ratio samples and median remained live even though compaction materially changed the prompt projection. Route changes already cleared the full calibration state.

## Implemented candidate

On successful micro-prune or full compaction, TermAgent now:

1. clears the measured baseline;
2. clears pre-compaction rolling ratio samples;
3. retains a one-request warm-start factor equal to `1 + (priorRatio - 1) * 0.75`;
4. replaces that warm-start factor with the first valid same-route provider measurement after compaction.

This is a decayed prior, not continued use of old samples. Route changes still clear calibration completely. `tools/phase14h-provider-trace-replay.mjs` mirrors the runtime behavior and can compare `carry`, `reset`, and decayed-prior policies without look-ahead. The current output includes an explicit `compaction-epoch-prior` source classification so the warm-start is not mislabeled as a cold start.

## Chronological replay evidence

Both supplied datasets are internally paired trace/session-log sets with exact request payload hashes and provider usage event matching. Both used the same `openai-compatible/mercury-3` route; these are not cross-provider evidence.

| Dataset | Captures | Compactions | Policy | Mean abs. error | P95 abs. error | Max abs. error | Missed usable-budget crossings |
|---|---:|---:|---|---:|---:|---:|---:|
| 110-capture session | 110 | 3 | carry | 3.5% | 13.7% | 29.3% | 1 |
| 110-capture session | 110 | 3 | reset | 3.9% | 13.7% | 46.2% | 1 |
| 110-capture session | 110 | 3 | decay 0.75 | 3.1% | 11.4% | 28.6% | 1 |
| 70-capture session | 70 | 2 | carry | 4.8% | 14.9% | 63.0% | 2 |
| 70-capture session | 70 | 2 | reset | 5.6% | 37.9% | 55.3% | 2 |
| 70-capture session | 70 | 2 | decay 0.75 | 4.7% | 14.0% | 55.3% | 2 |

The 75%-toward-prior decay was the best of the compared policies on mean absolute error and P95 for both datasets. It also reduced the largest observed error relative to carry in both datasets. Full reset worsened P95 substantially in the 70-capture dataset. All policies retained the same provider-observed budget-crossing misses, showing that epoch calibration alone does not solve the pre-compaction trigger timing problem.

### Budget crossings and the screenshot

The 70-capture dataset contains two provider-observed values above the 84,000-token application usable budget:

- predicted 82,212; observed 86,707; 2,707 over the budget;
- predicted 82,181; observed 84,863; 863 over the budget.

The accompanying Termux screenshot shows the application's final preflight guard after tool/schema bounding:

`Request still exceeds the configured context budget after tool/schema bounding (84100 estimated/provider-counted request tokens > 84000)`

and reports `toolDefinitions=2424`, `toolCalls=7862`, `toolResults=18074`.

This is evidence of an application-level preflight rejection after local reduction, not evidence of a provider HTTP 400/413/422 context-overflow response. The 70-capture session predates the separately supplied compaction-headroom candidate, so it does not validate that newer 90%-of-usable-budget normal compaction target.

## Interpretation and limits

- The decayed prior is a better candidate than either full carry or full reset on these two datasets, but both datasets use one route/model family. Keep it under validation until a new real Termux session and another provider route are tested.
- Two budget misses remain in the 70-capture replay and one remains in the 110-capture replay. These are predictions of the replay policy against an application usable-budget threshold, not provider rejections.
- Maximum per-request errors remain material (28.6% and 55.3%); aggregate signed error near zero must not be treated as proof of per-request accuracy.
- The headroom target and calibration epoch policy solve different problems: headroom moves normal compaction earlier; epoch calibration improves the first request estimate after a context-shape change.
- The offline policy comparison does not execute providers/tools, compare retained task context, or measure real-world latency/cost. A deterministic task/fixture A/B and real-provider confirmation remain separate requirements.

## Verification performed

- `npm run build`: PASS.
- `node --test tests/phase14h-provider-trace.test.mjs tests/phase14h-context-continuity.test.mjs`: 30/30 PASS after the epoch-prior assertion was corrected to classify the following request as measured-baseline-backed.
- Both chronological replay datasets: request payload hashes verified; durable usage matches all captures (110/110 and 70/70).
- Full repository suite and refreshed distribution/package checks are not yet completed for this continuation.

## Upstream references inspected

- OpenCode compaction and measured/estimated usage: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts and https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/usage.ts
- OpenClaude auto compaction, overflow reason and cooldown: https://github.com/Twigpine/openclaude/blob/main/src/services/compact/autoCompact.ts
- OpenClaude token estimation and optional provider count-token path: https://github.com/Twigpine/openclaude/blob/main/src/services/tokenEstimation.ts

TermAgent retains its existing `Agent.run()`, durable `provider.usage` events, `accountContext()`, `maybeCompact()` and provider trace replay. No parallel calibration or compaction subsystem was introduced.
