# Phase 16 — Capability recovery and full parity expansion: start contract

**Status:** Phase 16 opened. Sub-phase 16B (web tools) is implemented and regression-tested; the remaining 16A/16C/16D/16E/16F capabilities have explicit decisions recorded below and are sequenced as further Phase 16 work.

## Purpose

Phase 16 reopens capabilities previously deferred because TermAgent lacked the supporting architecture. Per `TODO.md` Phase 16 gate rules, every deferred capability must receive an explicit adopt / adapt / rewrite / defer decision, no capability may be degraded *only* because it is complex, and new capabilities must integrate with the canonical session/interaction/protocol architecture.

## Baseline

- Runtime foundations: `SessionStore` (durable JSONL + monotonic durable sequence), `ToolRegistry` + `PermissionGate` (risk/permission/request model), bounded context budget (`src/context/budget.ts`), durable `TaskManager`, `ToolOutputStore`, agent loop (`src/agent/agent.ts`), and protocol seam (`src/protocol/`).
- Prior deferred status: `docs/PHASE13-TOOL-PARITY.md` and `docs/phase13/tool-inventory.json` recorded web access, LSP, notebook editing, memory, and provider growth as deferred because the supporting runtime was absent.
- Existing partial groundwork: `src/context/lsp-diagnostics.ts` models diagnostic truth states but is not a language-server manager; `src/context/repository.ts` builds a cached symbol/reference graph with per-file mtime invalidation; provider adapters already implement bounded streaming/retry/cancellation.

## Decisions

| Capability | Decision | Evidence / notes |
|---|---|---|
| 16A LSP/code intelligence | **Defer** (keep diagnostic state machine) | The runtime has a correct diagnostics truth model (`lsp-diagnostics.ts`, Phase 13N-E) but no language-server manager, workspace document lifecycle, or per-language server spawn/recovery. Building that is a full sub-phase and is not required for 16B-16F. Recorded prerequisite: define a provider-neutral language-server manager with durable process lifecycle before adding an `lsp` tool. |
| 16B Web tools | **Adopt** (implemented in this phase) | `webfetch` + `websearch` are now first-class built-in tools. See implementation section. They remain approval-gated so the default offline-only Termux path is preserved until a user approves network access. |
| 16C Notebook/structured document editing | **Defer** | No established notebook workflow or document model in TermAgent; adding it would create a second structured-mutation subsystem. Reopen when a real notebook requirement exists. |
| 16D Structural repository intelligence | **Adapt incrementally** (defer to later 16D slice) | Existing `repository.ts` already provides cached file inventory, symbols, references, structural rank, per-file mtime/size invalidation, and a dependency graph. Remaining work (extra language coverage, graph persistence, evidence fusion) is a coherent follow-up slice, not required to start 16B. |
| 16E Memory and project knowledge | **Defer** | Requires a durable user/project knowledge store with provenance and invalidation rules, separate from repository-derived facts. No production surface exists; designing it well is its own sub-phase with an explicit semantic/vector retrieval choice. |
| 16F Provider protocol maturity | **Adapt** (later 16F slice) | Current adapters already implement bounded streaming, typed retry/backoff, stream-idle watchdogs, and cancellation. Remaining items (deterministic recorder/replay fixtures, capability metadata, optional WebSocket provider transport) are incremental and can be added without a new architecture. |

The Phase 16 gate (explicit decisions, no complexity-only degradation, canonical architecture integration) is met by the table above; implementation proceeds sub-phase by sub-phase, starting with 16B.

## 16B implementation

### Modules

- `src/util/network-safety.ts` — URL/protocol/credential validation, IPv4/IPv6 host classification (loopback, link-local, CGNAT, private, reserved, multicast, unspecified, public), DNS resolution with fail-closed private-address rejection for `webfetch`.
- `src/tools/web.ts` — `webfetchTool` and `websearchTool` as typed `ToolDefinition`s.

### Permission model

- New `PermissionAction` value `network` and new tool `risk` value `network` (`src/tools/types.ts`).
- `defaultPermissionAction` maps `network` risk (and `webfetch`/`websearch` names) to the `network` action; `permissionRequests` derives the resource from the target URL (or `websearch`/`*`).
- `PermissionGate` treats `network` like shell: it is not a read action, so default `ask` mode prompts per call, `auto` approvals allow, `deny` blocks, and rule-based deny works.
- Explore/Plan profiles (read-only) exclude network tools because `ToolRegistry.selectSchemas` and `Agent.run` treat `network` risk like `shell` when `allowShell` is false. Build mode includes them.

### Safety controls (`webfetch`)

- HTTP(S) only; URLs with embedded credentials rejected.
- Manual redirect handling: per-hop URL re-validation, hop cap (default 5), and redirect-loop detection.
- Fail-closed SSRF guard: loopback/private/link-local/CGNAT/reserved/multicast/unspecified addresses are blocked (IPv4 and IPv6, including `::ffff:` mapped IPv4). Cloud metadata range `169.254.169.254` and `169.254.0.0/16` are blocked.
- Size bound (default 200 KB captured), timeout (configurable, default 15 s, forwarded turn abort), binary content detection (content-type plus UTF-8 validity), bounded text preview, and structured metadata (status, final URL, content-type, bytes, truncation, hops, binary).
- DNS-to-connect race (TOCTOU on re-resolution) is documented as a v1 limitation; the pre-connect DNS check is fail-closed.

### `websearch`

- Requires an explicit endpoint (`config.webSearch.url` or `TERMAGENT_SEARCH_URL`); returns a clear error when unset, so no bundled search provider is added.
- Optional API key via `apiKeyEnv`, GET (query params) or POST (JSON body), bounded results (default 8, cap 20), normalized title/url/snippet output, and endpoint metadata.
- The endpoint is admin-configured; only http(s) scheme is validated for it.

### Configuration

- `Config.networkTimeoutMs` (env `TERMAGENT_NETWORK_TIMEOUT_MS`, default 15000).
- `Config.webSearch` (`url`, `apiKeyEnv`, `method`, `headers`, `maxResults`) with env fallbacks.
- Both tools register through `builtinTools(...)`, so CLI and server runtimes receive them with config.

### Tests

`tests/phase16b-web.test.mjs` (11 cases): registration/risk/mode gating, preview + metadata, size truncation, binary summary, timeout, bounded redirects + loop + cap, scheme/credential rejection, private/reserved target blocking, `PermissionGate` network flow (once/always/deny/rule), websearch endpoint requirement, GET + bearer auth, POST body.

### Verification evidence

- Production build: `tsc -p tsconfig.json` PASS.
- `tests/phase16b-web.test.mjs`: 11/11 PASS.
- `tests/permissions.test.mjs`: PASS (unchanged).
- `tests/phase13a-tool-contracts.test.mjs`: 11/11 PASS (inventory updated with `webfetch`/`websearch` entries and capability.web activation).
- `tests/tools.test.mjs`, `tests/phase13k-tool-architecture.test.mjs`, `tests/phase5-parity.test.mjs` (isolated), `tests/server.test.mjs`: PASS.
- Known pre-existing baseline failures unrelated to 16B remain as documented in `TODO.md` (e.g. `tests/phase3-execution.test.mjs` still asserts the legacy `status:'failed'` for a verification timeout, while the durable-task `verify` now reports `status:'timeout'`; `verify.ts` is unchanged by 16B).

## Remaining Phase 16 work

- 16B follow-ups: optional durable out-of-band retention of complete bodies (currently only bounded inline previews are kept), websearch response caching, and richer network result context projection.
- 16A LSP, 16C notebook, 16E memory: deferred by explicit decision above (recorded prerequisites).
- 16D structural intelligence and 16F provider maturity: incremental slices to be scheduled as the next Phase 16 sub-phases.
