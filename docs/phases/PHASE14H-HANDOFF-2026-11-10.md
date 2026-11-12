# TermAgent Phase 14H handoff — 2026-11-10

## Current state

- Version: `1.18.0`.
- Phase 14H: **IN PROGRESS**. Do not begin Phase 14I until the 14H acceptance gate is closed.
- Current source: provider-usage history plus opt-in provider-request trace capture/replay.
- OpenRecall remains out of scope.

## Implemented in this continuation

- Added `src/providers/trace.ts`, an opt-in capture at the existing `Agent.run()` provider boundary.
- `TERMAGENT_PROVIDER_TRACE_DIR` enables capture; an unset variable disables it.
- Captures exact provider-boundary messages and tool schemas, route/window provenance, existing `accountContext()` breakdown, message estimate, normalized provider usage, optional provider-native count, and returned text/reasoning/tool calls.
- Captures are atomic JSON files, maximum 32 MiB, mode `0600`; directories are mode `0700` where supported.
- Provider configuration objects, API keys, auth headers, base URLs and endpoint query strings are not serialized.
- Exact prompt and response content is intentionally retained and may itself contain secrets, pasted credentials, personal information or source code. Do not share captures before reviewing them.
- Failed provider rounds are not captured; capture I/O failures do not fail an otherwise successful agent response.
- Added `tools/phase14h-provider-trace-replay.mjs` and `npm run phase14h:provider-replay`. The analyzer validates request SHA-256, recomputes the current TermAgent message/full-request estimates, and compares them against captured provider usage and optional native input count.
- The analyzer reports whether provider-usage values are available; it cannot independently prove that a trace came from a live provider rather than a synthetic/test adapter.
- No real live-provider trace has yet been captured in this environment. The provider-backed estimator calibration and clean-equivalent legacy-vs-current compaction A/B remain open.
- No second provider runner, storage service, telemetry system, or estimator was introduced.

## Upstream implementations studied

**OpenCode**
- `specs/v2/claude-agent-provider.md`: recorded real sessions are replayed through a fake `claude` process while exercising the real SDK rather than mocking it.
- `packages/core/test/plugin/provider/claude-agent/lib/fake-claude.ts`: scripted protocol exchange replay and process lifecycle.

**OpenClaude**
- `src/services/vcr.ts`: exact request/response fixture capture, input normalization and replay.
- `src/utils/requestSizeBreakdown.ts`: categorized request footprint breakdown and safe display-name handling.

Adapted the capture/replay and exact-request accounting principles to TermAgent's existing `Agent.run()`, provider adapter, `accountContext()`, and trace tooling. Did not copy the upstream SDK/process or storage architecture.

## Validation

- `npm run build`: PASS.
- `node --check tools/phase14h-provider-trace-replay.mjs`: PASS.
- `tests/phase14h-provider-trace.test.mjs`: **6/6 PASS**.
- Combined Phase 14H continuity, controlled replay, provider trace, session replay and provider-native-count suite: **37/37 PASS**.
- Complete repository test inventory: **84/84 test files and 733/733 tests PASS** when executed in serial batches, zero failures.
- The single combined `npm test` process exceeded the available tool time limit before its final TAP summary. All files were completed in batches instead; no test failures were observed.
- `node scripts/verify-dist.mjs`: PASS.
- `npm pack --dry-run`: PASS, 325 package files.
- `node dist/index.js --version`: `1.18.0`.
- `TERMAGENT_ALLOW_NON_ANDROID=1 npm run device:smoke`: PASS as Linux x64 (`termux:false`) only.
- No physical Android/Termux validation was performed.

## Remaining Phase 14H gates

1. Collect reviewed traces from real configured provider sessions and use them to measure estimator drift across routes/models.
2. Build a clean-equivalent old-vs-current compaction replay with identical request chronology, provider responses and recorded tool outcomes; do not call synthetic fixtures provider-backed.
3. Define workspace-wide usage aggregation across sessions, forks and subagents without double counting.
4. Improve authoritative media payload, provider framing and hidden tool/schema overhead accounting.
5. Validate broader transcript-shortening stages and multi-cycle summary quality against real long traces.
6. Benchmark 500K/1M context and large repositories under constrained memory.
7. Test nested instruction/skill conflicts and restart behavior across subagents.
8. Perform physical Android/Termux validation, including memory and latency checks.

## Next recommended move

Enable `TERMAGENT_PROVIDER_TRACE_DIR` for a small number of real provider requests, keep the directory private, and review the captures before sharing them. Use those traces to quantify route-specific estimator drift, then extend the recorded sequence with tool-outcome chronology for clean-equivalent compaction A/B. Keep Phase 14H open until those and the remaining device/scaling gates are satisfied.
