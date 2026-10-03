# TermAgent Phase 13F Report

## Scope

Phase 13F replaces lossy tool-output summarization as the primary provider-facing storage path with TermAgent’s durable tool-output store. Complete oversized textual results stay on disk, the model receives a bounded projection, and request-level context accounting prevents large outputs from unnecessarily triggering compaction.

The store is deliberately bounded and restart-safe, preserving full output separately from the compact transcript while retaining structured metadata and attachments.

## TermAgent changes

### ToolOutputStore

Added the relevant TermAgent subsystem.

- Stable per-session/per-tool-call key derived from SHA-256 of `sessionId + NUL + toolCallId`.
- Managed `.log` payload and `.json` metadata sidecar.
- Complete oversized textual output is persisted once and reused when the same tool-call/content hash is reconstructed.
- Limits are enforced by UTF-8 byte count and line count.
- Preview is head/tail oriented and itself bounded by the requested byte/line budget.
- Stable references use `tool-output://<64-hex-key>`.
- Metadata and attachments are retained separately from the textual preview.
- Retention cleanup only removes managed `tool_<hash>.log/json` files older than the configured retention period.
- Retrieval is paginated through `read(reference, { startLine, endLine })`.

### Agent integration

the relevant TermAgent subsystem now:

- owns a `ToolOutputStore` instance for each agent runtime;
- cleans expired managed output at most hourly;
- bounds tool-result projections against current context headroom rather than passing large raw tool output directly into the next request;
- preserves compatibility for explicit `preserveOutput` results and `use_skill`, which intentionally remain inline;
- replaces the old summary-only storage path for ordinary tool execution;
- uses `accountContext()` for request accounting and reports tool definitions, calls, results, summaries, skills, notices, and other message tokens using the existing estimator.

### read_file integration

the relevant TermAgent subsystem recognizes `tool-output://` references and retrieves the complete stored result in bounded numbered ranges. The returned metadata identifies the reference, backing path, total lines, selected range, and continuation state.

### Configuration

Added:

- `toolOutputMaxLines`
- `toolOutputMaxBytes`
- `toolOutputRetentionDays`

The default store is `~/.termagent/tool-output`. `TERMAGENT_TOOL_OUTPUT_ROOT` is supported for isolated runtimes/tests, with environment overrides for worker-side limits.

### Compatibility layer

the relevant TermAgent subsystem retains `summarizeToolOutput()` for legacy callers and tests, but it is no longer the primary persistence mechanism for normal tool execution.

## Important behavior

A large result is no longer kept as a giant live tool message. The complete result remains retrievable, while the provider sees only a bounded projection containing the stable reference. Reconstructing the same tool call with unchanged content reuses the existing payload file instead of rewriting it.

Structured metadata and attachments are not folded into the textual preview. Structured-only output is serialized for persistence when it is the only available contextual content, while native attachment records remain separate.

The output reference is intentionally virtual. `read_file` resolves only validated `tool-output://` keys against the managed store root, so a model cannot turn the reference into an arbitrary filesystem path.

## Verification

- TypeScript build: **PASS**
- Phase 13F dedicated suite: **9/9 PASS**
- Phase 13A–13F targeted regression matrix: verified after integration changes
- Large-output compaction regression: **PASS**, including a 20,000-line tool result with zero compaction events and a bounded follow-up provider request.

The historical aggregate `npm test` stall remains a separate inherited runner issue and is not reported as a 13F failure or pass.

## Files
- `tests/phase13f-tool-output.test.mjs`
- `docs/PHASE13F-REPORT.md`
- `docs/CONFIGURATION.md`
- `docs/phase13/tool-inventory.json`
- `TODO.md`
