# Phase 13L Report

## Scope

Phase 13L reviews the remaining high-value tool capabilities and implements only those that fit TermAgent's current architecture and Termux constraints. Capabilities that require a larger missing subsystem remain explicitly deferred instead of gaining a parallel runtime.

- `specs/v2/tools.md`

The selected core capability set contains `apply-patch.ts`, but no `batch.ts` and no `lsp.ts`. The V2 edit/file-mutation implementation also explicitly leaves LSP diagnostics integration as future work. The selected web tools perform real external network access and therefore were evaluated separately against TermAgent's mobile/offline goals.


TermAgent's LSP tool requires a dedicated language-server manager, initialization lifecycle, VS Code LSP types, file-open state, and multiple symbol/call-hierarchy operations. NotebookEdit is a structured Jupyter document editor with `.ipynb` validation, cell identity/index handling, read-before-edit freshness, and file-history integration.

## Implementation

### 1. First-class `apply_patch`

Files:
The patch parser and derivation logic are implemented using TermAgent's the relevant TermAgent subsystem.

Supported operations:

- `*** Add File:`
- `*** Update File:` with `@@` chunks
- `*** Delete File:`
- heredoc-wrapped patch input
- exact/trimmed/normalized context matching
- BOM-aware updates and EOF matching

the implementation rejects move hunks, so TermAgent also rejects `*** Move to:` rather than silently inventing move semantics.

Mutation flow:

1. Validate the patch schema and byte bound.
2. Parse all hunks and reject malformed/unsupported operations.
3. Resolve every target inside the project and declared worker scope.
4. Preflight all targets before any permission request or mutation.
5. Build one canonical `edit` permission request containing all target resources.
6. Apply prepared changes sequentially.
7. Use `createFileExclusive` for additions and conditional `writeIfUnchanged`/`removeIfUnchanged` for updates/deletes.
8. Invalidate affected read-state entries.
9. Return a bounded summary plus per-file diff metadata.

The implementation intentionally remains sequential rather than atomic, matching the V2 implementation. When a later mutation fails, the tool throws an explicit message naming the failed resource and all earlier resources that were already applied.

Patch input is capped at 200,000 UTF-8 bytes and each rendered file diff is capped at 24,000 bytes.

### 2. Permission batching

the relevant TermAgent subsystem now evaluates all resources within one declared `ToolPermissionRequest` before prompting. Per-resource rules can still deny or pre-allow individual resources, but all unresolved resources are sent through one requester call.

This fits TermAgent's existing resource-array permission request model and enables the required one-approval `apply_patch` batch behavior without creating a second permission service.

Legacy `always` approval behavior remains compatible by retaining both exact resource approvals and a broad tool/action approval key.

### 3. Durable `verify_project`

Files:
`verify_project` now uses the existing `TaskManager` and `startManagedShell()` infrastructure. Verification commands therefore gain the same durable task record, terminal event, managed-output file, cancellation, timeout, and recovery semantics as shell/git tasks.

The model-visible result preserves the historical timeout contract by reporting `124` for verification timeout while the underlying durable TaskManager record retains the real managed-shell `timeout` termination and OS-derived exit code.

Scoped workers continue to reject arbitrary explicit verification commands and use automatic project detection.

### 4. Deterministic grep correction

The existing Phase 13D grep implementation was relying on ripgrep's emitted file order while its regression contract expected deterministic ordering. The ripgrep result set is now sorted by normalized relative path, line number, and line text before pagination. This keeps Phase 13D deterministic without replacing its existing search implementation.

### 5. `repo_map`

No new repository-discovery system was introduced. The existing `repo_map` remains a bounded structural view layered beside `glob`, `grep`, and `read_file`. Its output remains constrained by the existing token/output budget.

## Evaluated but intentionally not added

### `batch`

No matching `batch` tool exists in the selected the V2 implementation core or application tool tree at the recorded behavior. TermAgent therefore does not invent a local `batch` abstraction. Existing `parallel_agents` remains the bounded agent-level concurrency primitive.

### LSP

No first-class LSP tool exists in the current core capability set at the selected revision. the implementation has a full LSP tool, but it depends on a dedicated LSP runtime and language-server lifecycle that TermAgent does not presently provide. It remains deferred rather than implemented as a scratch subsystem.

### webfetch/websearch

TermAgent's web tools make real external network requests and introduce a permanent network/data dependency. TermAgent's default builtin set therefore remains network-light/offline-friendly. Network-capable MCP or plugin tools can still be explicitly installed by a user or environment that chooses to incur that cost.

No new network dependency or native package was added in 13L.

### NotebookEdit

TermAgent's notebook editor is intentionally out of scope because TermAgent has no established notebook workflow or notebook-specific runtime layer. Adding it now would create a second structured-document mutation path without a demonstrated requirement.

## Compatibility

Preserved:

- existing `ToolDefinition` and `ToolRegistry.add()` contracts
- old `schema`/`risk`/`parallelSafe` metadata
- existing permission rule configuration
- existing `PermissionGate` requester contract
- existing file mutation locks and read-state cache
- existing durable shell/task infrastructure
- scoped-worker command restrictions
- `verify_project` legacy timeout result semantics
- bounded `repo_map`

No new runtime dependency or native binary is required.

## Tests

Focused Phase 13L:

- `tests/phase13l-missing-capabilities.test.mjs` -> **10/10 PASS**

The focused suite covers:

- structured patch parse/derive behavior
- malformed patch rejection before permission
- single approval for multi-file patch batches
- add/update/delete sequential mutation
- explicit partial-application failure reporting
- generic permission request batching
- durable verification task settlement
- legacy verification timeout mapping
- scoped worker restriction
- bounded `repo_map`

Permission regression:

- `tests/permissions.test.mjs` -> **2/2 PASS**

Phase 13A through 13L:

- **138/138 PASS**

Phase 13E repeated regression:

- **13/13 PASS** across three consecutive runs

Broader compatibility sweep:

- **159/159 PASS** across Phase 3 execution, Agent, context performance, skills, tools, permissions, plugins, providers, and runtime compatibility.

The historical aggregate `npm test` command remains unclaimed because of the previously documented stall/timeout behavior.

## Build and artifact gates

- `npm run build` -> PASS
- Generated JavaScript syntax checks -> PASS
- ZIP integrity -> PASS
- `npm pack --dry-run` -> PASS

## Changed files
- `tests/phase13l-missing-capabilities.test.mjs`
- `docs/phase13/tool-inventory.json`
- `docs/PHASE13L-REPORT.md`
- `TODO.md`

## Status

Phase 13L is complete. The selected capability `apply_patch` architecture is now a first-class TermAgent builtin, verification uses the durable task infrastructure, repository mapping remains bounded, and capabilities outside the current runtime scope remain explicitly deferred.
