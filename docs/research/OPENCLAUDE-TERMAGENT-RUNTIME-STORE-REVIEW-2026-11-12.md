# OpenClaude and TermAgent runtime-state layout review

**Date:** 2026-11-12  
**Scope:** User-supplied `~/.openclaude` archive and `~/.termagent` tree, plus the corresponding storage-path implementations. This is a runtime-data comparison, not a comparison of the complete source-repository trees.

## Evidence inspected

- User-supplied `.openclaude.zip`: 1,443 archive entries, 946 regular files, approximately 45.4 MB uncompressed.
- User-supplied `.termagent.tree.txt`: 42,684 lines, approximately 2.8 MB; it describes `~/.termagent`, not the TermAgent source repository.
- TermAgent source: `src/session/store.ts`, `src/session/snapshot.ts`, `src/tasks/manager.ts`, `src/tasks/events.ts`, `src/agent/tool-output-store.ts`, `src/context/repository.ts`, and `src/providers/trace.ts`.
- OpenClaude source at inspected revision `77a96c21a98fa3a939b038bd4fba313911712466`: `src/utils/envUtils.ts`, `src/utils/sessionStorage.ts`, `src/memdir/paths.ts`, and `src/services/compact/autoCompact.ts`.

## Observed OpenClaude layout

The supplied state archive separates several different lifecycles into distinct top-level domains:

```text
~/.openclaude/
├── backups/
├── bg-sessions/
├── cache/
├── debug/
├── file-history/
├── plugins/
├── projects/
├── sessions/
├── shell-snapshots/
├── statsig/
├── tasks/
└── todos/
```

Notable contents in this snapshot:

- `plugins/`: 735 files split among plugin cache, marketplace materializations, and installation/marketplace metadata.
- `projects/`: 164 files under project-keyed directories. The supplied sample includes session-specific subagent transcripts and metadata.
- `tasks/`: 20 files grouped under session IDs, including task state, lock, and high-watermark files.
- `file-history/`: session-scoped file-history snapshots.
- `shell-snapshots/`: shell environment snapshots.
- `backups/`: timestamped configuration backups.
- `bg-sessions/`: recovery/retention journals.
- `todos/`: agent-scoped Todo state.

OpenClaude source resolves its independent config home to `~/.openclaude` by default and supports `OPENCLAUDE_CONFIG_DIR`. Its session-storage implementation resolves transcript paths against the session's project directory rather than treating all project transcripts as one undifferentiated directory. The implementation also centralizes session-file locking and replacement behavior. This is the most useful architectural pattern to adapt: project-aware ownership and explicit storage lifecycles, not a literal copy of every folder.

References:

- https://github.com/Twigpine/openclaude/blob/77a96c21a98fa3a939b038bd4fba313911712466/src/utils/envUtils.ts
- https://github.com/Twigpine/openclaude/blob/77a96c21a98fa3a939b038bd4fba313911712466/src/utils/sessionStorage.ts
- https://github.com/Twigpine/openclaude/blob/77a96c21a98fa3a939b038bd4fba313911712466/src/memdir/paths.ts

## Observed TermAgent layout

```text
~/.termagent/
├── config.json
├── daemons/
├── drafts/
├── migrations.json
├── plugins/
├── provider-traces/
├── repomap-cache/
├── sessions/
├── snapshots/
├── tasks/
└── tool-output/
```

The supplied tree contains approximately:

- 129 session JSONL files directly under `sessions/`.
- 70 provider trace JSON files directly under `provider-traces/`.
- 16 repository-map cache files directly under `repomap-cache/`.
- 5 draft JSON files directly under `drafts/`.
- 1 plugin installation-state file under `plugins/`.
- About 1,195 task-related entries under the flat `tasks/` directory (state/event/lock records; this is not a count of distinct tasks).
- About 200 files under `tool-output/` (metadata and output-file pairs).
- 113 first-level session entries under `snapshots/`; the remaining tens of thousands of tree entries are largely Git object-store internals beneath the per-session snapshot repositories.
- Three provider-trace ZIP files appear beside the live trace directory in this particular user tree. They are treated as user-managed archives; the tree does not establish that TermAgent created them.

TermAgent already has real domain ownership; the layout is not an absence of architecture:

- `SessionStore` owns durable JSONL session files under `sessions/<sessionId>.jsonl`.
- Snapshot Git repositories are intentionally isolated under `snapshots/<sessionId>/` and should be treated as opaque Git stores.
- `TaskManager` and `TaskEventLog` currently store task state and event logs as flat files under the shared `tasks/` root.
- `ToolOutputStore` stores session/tool-call-derived output references as hash-named `.json`/`.log` pairs under a flat `tool-output/` root, with a seven-day default retention policy.
- Repository-map data is derived/cacheable and stored separately under `repomap-cache/`.
- Provider request traces are opt-in and privacy-sensitive; they are stored separately from durable session JSONL, but are not grouped by session in the current layout.

## Main differences and risks

1. **Project ownership:** OpenClaude's session artifacts are project-scoped. TermAgent's session logs are flat and rely on each session's metadata to recover `cwd`; there is no obvious project namespace/index in the supplied state tree.
2. **Task ownership:** OpenClaude groups task files by session. TermAgent's task state and event files share one flat directory even though task records already carry session/parent-session identity.
3. **Artifact ownership:** TermAgent separates snapshots, tool outputs, traces, and repo-map cache by domain, which is good. The next improvement is to make high-volume artifacts session/project-aware and define retention/garbage-collection rules for each type.
4. **Git snapshots:** TermAgent's large snapshot subtree is not evidence of accidental directory sprawl. It is an internal Git object database. Do not reorganize files inside it; manage lifecycle at the enclosing snapshot-repository boundary.
5. **Diagnostic exports:** User-managed trace archives sitting in the application state root make it harder to distinguish application-owned state from exports. Future export commands should write to a clearly designated export location outside the active trace directory.
6. **Path ownership:** Runtime path construction is currently distributed across `SessionStore`, `TaskManager`, `ToolOutputStore`, repository indexing, and trace capture. A single path-policy module would make retention, permission modes, migration, and test isolation easier to reason about.
7. **Retention and recovery:** Durable session/task truth, derived caches, reconstructable snapshots, large tool-output artifacts, and diagnostic traces need different retention policies. A generic cleanup routine must not remove live tasks, active sessions, or outputs still referenced by durable events/checkpoints.

## Adopt / adapt / defer

### Adapt

- Project-keyed organization or indexes for sessions, tasks, and agent artifacts.
- Session-scoped task state and task event logs.
- Central configuration-root resolution with an explicit TermAgent override, independent from OpenClaude/Claude environment variables.
- Explicit backup, export, diagnostic, cache, and recovery domains.
- Per-domain retention and crash-safe cleanup policies.

### Preserve

- TermAgent's authoritative `SessionStore` JSONL event log and its durable replay semantics.
- Existing `TaskManager`/`TaskEventLog` ownership and state machine.
- Content-addressed `tool-output://` references.
- The existing private Git snapshot repository per session; treat its internal layout as Git-owned.
- The repository-map cache as derived state, separate from durable session truth.

### Defer

- Do not rename or move live runtime directories during Phase 14H.
- Do not copy OpenClaude's full storage schema or import its implementation wholesale.
- Do not migrate session/task files until path resolution, locking, fork/restore, concurrent writers, interrupted migrations, and old-version compatibility have characterization tests.

## Planned implementation boundary

Schedule the storage-layout work under Phase 17A, after Phase 14 closure and selected Phase 16 work. First introduce/test a central storage-path policy and a project index while retaining existing canonical session paths. Then evaluate session-scoped task directories, per-session trace partitions, export separation, and retention/GC. Any path migration must be versioned, atomic, idempotent, reversible or recoverable, and able to read legacy flat paths until migration is verified.

The storage migration is deliberately independent from the Phase 14H estimator/compaction work. It must not delay the current context reliability gate or cause live session data to move during the present validation cycle.
