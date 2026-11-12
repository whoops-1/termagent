# TermAgent 1.18.0 — Phase 14H handoff (2026-11-12)

## Status

Phase 14H remains IN PROGRESS. Phase 14I has not started. This archive continues the 2026-11-11 compaction-headroom candidate and adds an epoch-aware adaptive-estimator candidate plus an OpenClaude runtime-store architecture review.

## Implementation changes in this continuation

- `src/agent/agent.ts`: after successful micro-prune/full compaction, clear the old measured provider baseline and rolling route-ratio samples. Warm-start the first request in the new epoch with `1 + (priorRatio - 1) * 0.75`; the next same-route provider usage report replaces the warm-start. Route changes still reset calibration completely.
- `tools/phase14h-provider-trace-replay.mjs`: add look-ahead-free comparison of `carry`, `reset`, and decay policies (25%, 50%, 75% of the prior deviation retained). Identify the first post-compaction warm-start prediction as `compaction-epoch-prior` instead of cold-start. Primary runtime replay defaults to decay 0.75.
- `tests/phase14h-provider-trace.test.mjs`: verify that predictions use only prior usage, the compaction boundary applies the decayed prior for one request, the next measured report replaces it, and carry/reset alternatives remain available for comparison.
- `TODO.md`, `ARCHITECTURE.md`: update Phase 14H calibration/headroom status and record the runtime-store review in Phase 17A.
- `docs/research/PHASE14H-CALIBRATION-EPOCHS-2026-11-12.md`: document the source finding, two dataset comparisons, remaining errors, and evidence limits.
- `docs/research/OPENCLAUDE-TERMAGENT-RUNTIME-STORE-REVIEW-2026-11-12.md`: document the supplied runtime tree comparison and upstream storage-path patterns.

The 90% normal compaction target and 72% explicit overflow recovery target from the prior headroom candidate remain in this source archive. The 70-capture Termux session and screenshot predate that headroom build and do not validate it.

## Chronological provider-trace replay

Both user-supplied datasets have matching session logs, exact request payload hash verification, and one-to-one durable provider-usage event matches. Both use `openai-compatible/mercury-3`; neither is cross-provider evidence.

| Dataset | Captures | Completed compactions | Policy | Mean absolute error | P95 | Max | Missed usable-budget crossings |
|---|---:|---:|---|---:|---:|---:|---:|
| 110 captures | 110/110 | 3 | Carry | 3.5% | 13.7% | 29.3% | 1 |
| 110 captures | 110/110 | 3 | Reset | 3.9% | 13.7% | 46.2% | 1 |
| 110 captures | 110/110 | 3 | Decay 0.75 | 3.1% | 11.4% | 28.6% | 1 |
| 70 captures | 70/70 | 2 | Carry | 4.8% | 14.9% | 63.0% | 2 |
| 70 captures | 70/70 | 2 | Reset | 5.6% | 37.9% | 55.3% | 2 |
| 70 captures | 70/70 | 2 | Decay 0.75 | 4.7% | 14.0% | 55.3% | 2 |

Decay 0.75 produced the best mean and P95 absolute error among the compared policies on both sessions. It also reduced the maximum error relative to carry in both sessions. It did not remove provider-observed usable-budget crossing misses. This is offline shadow evidence, not proof of task correctness, true provider overflow recovery, latency/cost improvement, or compaction-summary quality.

## Verification

- `npm run build`: PASS.
- `node --test tests/phase14h-provider-trace.test.mjs tests/phase14h-context-continuity.test.mjs`: 30/30 PASS.
- After a formatter-only replay-report adjustment, `node --test tests/phase14h-provider-trace.test.mjs`: 9/9 PASS.
- Full repository parallel run `node --test --test-concurrency=4 tests/*.test.mjs`: 744/744 PASS (29.7 seconds).
- `node scripts/verify-dist.mjs`: PASS.
- `npm pack --dry-run`: PASS, 325 package files, 501.7 kB tarball.
- Serial `npm test`: timed out at the 180-second execution limit without a final TAP summary; no serial pass/fail claim.
- Source hygiene scan found no likely provider-key patterns, raw JSONL traces, `.env`, PEM, or key files in the source archive.
- Physical Android/Termux verification: NOT performed for this archive.

## Remaining Phase 14H gates

1. Install this candidate and validate the 90% normal-compaction headroom policy on physical Termux. Confirm that the preflight `84100 > 84000` condition is avoided or safely reduced, and capture a new matching trace/session pair.
2. Validate epoch calibration on the new runtime dataset and collect at least one different provider/model route.
3. Exercise an actual provider-rejected context overflow (HTTP 400/413/422) to prove forced compact + one retry; the supplied screenshot is an application-level preflight guard, not a provider rejection.
4. Run a clean-equivalent deterministic task/fixture A/B comparing original, headroom-only, and headroom + epoch-decay strategies. Record same task inputs, initial workspace snapshot, tool outcomes, retained task context and task correctness.
5. Refresh full compatibility/device-memory and package checks after the physical validation.

The supplied OpenClaude runtime tree comparison is recorded for future Phase 17A. It does not authorize moving application state during Phase 14H. Preserve current canonical paths until migration characterization tests, versioned migration, rollback and legacy readers are designed.

## Upstream references inspected

- https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/usage.ts
- https://github.com/Twigpine/openclaude/blob/main/src/services/compact/autoCompact.ts
- https://github.com/Twigpine/openclaude/blob/main/src/utils/sessionStorage.ts
- https://github.com/Twigpine/openclaude/blob/main/src/utils/envUtils.ts

No secrets or user trace payloads are included in this source archive.
