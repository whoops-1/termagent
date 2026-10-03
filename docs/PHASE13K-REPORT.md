# Phase 13K Report

## Scope

Phase 13K turns the tool layer from a thin name-to-function map into an explicit capability registry. Tools now carry schema, execution kind, read-only/concurrency metadata, permission declarations, availability rules, and provenance fields, while the registry remains lightweight enough for Termux.

The phase builds on the existing `BashTool`, `MCPTool`, and tool-search/cache paths instead of adding another registration system.

## Implementation

### Tool definition metadata

the relevant TermAgent subsystem now defines:

- canonical `inputSchema` and optional `outputSchema`
- `ToolKind`: `local`, `provider-hosted`, `plugin`, `mcp`, `declarative`
- `readOnly` and `ToolConcurrency` metadata
- `ToolProvenance` with provider/plugin/MCP source fields
- canonical permission actions: `read`, `edit`, `shell`, `external_directory`, `task`, `skill`
- per-tool permission declarations and dynamic availability hooks
- an explicit `ToolResult` contract while keeping the existing output string/metadata surface

Normalization is performed once at registration so existing tools can continue supplying the older `schema`, `risk`, and `parallelSafe` fields.

### Schema validation

the relevant TermAgent subsystem introduces a dependency-free JSON Schema boundary for the subset used by TermAgent. It validates object/array/string/number/integer/boolean/null types, required fields, enums, const values, nested schemas, additional properties, common numeric/string/array constraints, and basic combinators.

The registry validates input before permission or execution. Invalid input therefore never reaches a tool executor. Optional output schemas are validated after execution, producing an explicit `ToolValidationError` instead of a successful result.

### Registry architecture

the relevant TermAgent subsystem now stores scoped registrations as per-name overlays. The latest active registration wins; closing that registration reveals the previous active registration. This provides deterministic collision behavior without rewriting every tool or adding a second registry system.

Stable provider-facing schemas remain cached only in `schemas()`. Dynamic filtering is performed by `selectSchemas()` on every selection so availability, agent/mode limits, workflow state, permission rules, and context budget remain live. Agent-level caching of dynamic selections was removed to prevent stale `isEnabled` decisions.

Selection uses the existing `boundToolSchemas()` context-budget implementation, keeping the Phase 9 token estimator and priority ordering instead of inventing a second budgeting algorithm.

### Permission model

the relevant TermAgent subsystem keeps legacy `tool`/`pattern` rules compatible while adding canonical action/resource evaluation.

Default actions are derived from the normalized tool contract:

- read tools -> `read`
- write tools -> `edit`
- shell tools -> `shell`
- task/background/agent tools -> `task`
- skill tools -> `skill`

Path-bearing arguments are extracted into concrete resources. Tools that explicitly declare external-directory capability can generate an additional forced `external_directory` request when paths leave the workspace. Permission prompts receive the canonical action and resource context. This is opt-in so legacy project-scoped file tools continue to reject traversal through their own safety boundary without unexpectedly prompting.

Static deny rules are applied during schema selection. Resource-pattern rules are evaluated again at execution time, after argument validation, so model-visible availability and execution authorization are distinct but consistent layers.

### Tool source separation and provenance

Local executable tools remain the normal registry path. Pure declarative and provider-hosted definitions are represented explicitly but are rejected by local execution.

Plugin-loaded tools now receive plugin provenance automatically when they do not already supply it. MCP tools retain their server provenance and normalize to `kind: "mcp"`.

`ToolCallLifecycleRecord` now persists `kind` and `provenance`. Agent-created lifecycle records attach the current local definition provenance, while provider-executed calls are marked `kind: "provider-hosted"` with provider/model identity. The durable `tool.call` event therefore preserves execution source through session reloads.

### Provider-hosted behavior

The existing Phase 13G rule remains intact: a provider-hosted tool call is never dispatched to the local registry. Phase 13K adds an explicit non-executable provider-hosted definition helper and lifecycle provenance instead of registering a fake executable handler.

## Compatibility

The implementation deliberately preserves:

- the existing `{output,title?,metadata?}` tool result surface
- old `schema`, `risk`, and `parallelSafe` fields as compatibility inputs
- existing `PermissionRule.tool` and `PermissionRule.pattern` configuration
- existing `ToolRegistry.add()` chaining
- existing plugin and MCP registration paths
- existing Agent workflow/read/write/shell filtering
- existing `boundToolSchemas()` budgeting behavior
- existing provider-hosted execution separation

No new runtime dependency or native binary is required.

## Tests

Final verification below uses the built `dist` output corresponding to this source tree.

Focused Phase 13K:

- `tests/phase13k-tool-architecture.test.mjs` -> **15/15 PASS**

The suite covers:

- registration collisions and restoration
- local/plugin/MCP/declarative/provider-hosted metadata
- input validation with no executor invocation
- output schema validation
- canonical permissions and external-directory protection
- resource-pattern rules
- static deny filtering
- dynamic availability
- schema caching/invalidation
- bounded mode/workflow selection
- plugin provenance
- durable lifecycle provenance
- provider-hosted separation
- task/skill action mapping

Prior-phase regression sweep:

- Phase 13A through 13K -> **130/130 PASS**

Generated JavaScript syntax check: **119/119 files PASS**

Broader compatibility sweep: **121/121 PASS** across Phase 3 execution, context performance, skills, tools, plugins, and providers.

Phase 13E repeated regression: **13/13 PASS** across three consecutive runs.

The repository's historical aggregate `npm test` command still contains the previously documented stall/timeout behavior and is not claimed as passing.

## Files changed
- `tests/phase13k-tool-architecture.test.mjs`
- `docs/phase13/tool-inventory.json`
- `docs/PHASE13K-REPORT.md`
- `TODO.md`

## Release verification

- `npm run build` -> PASS
- Generated JavaScript syntax check -> **119/119 PASS**
- Phase 13A-13K targeted suites -> **130/130 PASS**
- Phase 13K focused suite -> **15/15 PASS**
- Broader compatibility sweep -> **121/121 PASS**
- Phase 13E repeated regression -> **13/13 PASS** across 3 consecutive runs
- `npm pack --dry-run` -> PASS
- `unzip -t` -> PASS
- Final archive: `TermAgent-1.18-phase13K-tool-architecture-final.zip`
- Final archive SHA-256: `0e525359019c056f7b2e8ace468348ca84e68e5544eb611800e5765f8f880e6d`

## Status

Phase 13K is complete and packaged. The historical aggregate `npm test` runner remains the only intentionally unclaimed gate because of its previously documented stall/timeout behavior.
