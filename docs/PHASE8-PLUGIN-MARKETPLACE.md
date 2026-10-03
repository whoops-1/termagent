# Phase 8: Plugin Marketplace + Intelligent Skill Discovery

## Design policy

The marketplace layer is intentionally small and dependency-light. Distribution, package validation, trust state, installation, activation, and skill discovery are kept separate so each stage can fail safely and remain observable on Termux.

The implementation preserves the existing plugin and skill contracts while adding deterministic lifecycle handling, filesystem containment, transactional installation, and explicit trust decisions.

## Core architectural distinction

```text
Marketplace = distribution/catalog source
Plugin      = installable package of components
Skill       = task-specific instructions/workflow
Tool        = executable capability
```

A plugin may expose skills, commands, agents, MCP servers, and hooks. A skill remains primarily prompt/instruction content and does not automatically acquire executable privileges.

## Phase 1 completed

Implemented a validated manifest/compatibility layer without changing legacy plugin execution:

- The `.claude-plugin/plugin.json` manifest shape is accepted for compatibility.
- `.termagent-plugin/plugin.json` is accepted as the native alias.
- Package manifests are discoverable without importing or executing plugin code.
- Names, semver-ish versions, author/metadata fields, dependencies, and component path declarations are validated.
- Component paths must remain relative to the plugin root and cannot contain `..` traversal or absolute paths.
- Duplicate component paths are rejected inside each component list.
- Legacy `.js`/`.mjs` local plugins continue to load as before.

### Deliberate Phase 1 boundary

Phase 1 does not download, execute, install, update, or trust remote plugins. Manifest discovery is metadata-only. This keeps the new contract safe to exercise before adding marketplace I/O.

## Target skill flow

```text
installed plugin / local skill directories
        ↓
SkillCatalog
        ↓
SkillDescriptor index
        ↓
search_skills(query)
        ↓
model sees compact metadata
        ↓
use_skill(skill-id)
        ↓
load + verify full SKILL.md
        ↓
current-turn instructions
```

The base prompt should not contain the full catalog. Discovery should be cheap and deterministic; loading should be explicit and scoped to the current task.

## Phase gates

Every phase must end with:

1. focused regression tests;
2. full `npm test`;
3. `npm run build`;
4. `npm pack --dry-run`;
5. source-hygiene/adversarial checks;
6. extracted-artifact smoke test;
7. progress/architecture/changelog documentation.

Only after all gates pass is the phase marked complete.

## Phase 2 completed: marketplace sources, cache, and installation

The second phase ports the marketplace lifecycle concepts into TermAgent without importing the separate runtime or dependency stack.

### Persistent state

```text
~/.termagent/
├── marketplaces/
│   ├── known.json
│   └── cache/<marketplace>/
└── plugins/
    ├── installed.json
    └── cache/<marketplace>/<plugin>/<version>__<digest>/
```

`known.json` is registration/materialization state. `installed.json` is plugin installation state. Both are written atomically and use private directory/file permissions.

### Marketplace source handling

Implemented source types are:

- `github`: `owner/repo`, optional ref/SHA/subdirectory/sparse paths;
- `git`: full Git URL, optional ref/SHA/subdirectory/sparse paths;
- `url`: direct JSON marketplace document;
- `directory`: read-only local marketplace root;
- `file`: read-only local marketplace manifest.

Remote Git sources use the system `git` executable rather than a Node Git dependency. Shallow clones are the default. Pinned SHAs use a shallow fetch + detached checkout. Sparse checkout can restrict large repositories to the relevant marketplace/plugin directories. Git hooks are disabled, credential prompting is disabled, and SSH host-key verification is strict.

### Cache and refresh semantics

Remote marketplace retrieval happens in a temporary directory. The manifest is parsed and validated before the cache is made live. Refreshes stage the replacement and preserve a backup of the previous live cache until the new `known.json` state has been persisted. Failed fetch/validation leaves the old cache in place and records a broken marketplace status.

Local `directory` and `file` sources are never treated as cache-owned directories, so marketplace removal does not delete user source content.

### Installation semantics

A marketplace plugin is installed by materializing its declared source into a temporary directory, rejecting symlinks, validating the package manifest when `strict` is not explicitly false, computing a deterministic SHA-256 tree digest, and then publishing the version+digest directory. Installation state records:

- marketplace/plugin identity;
- source declaration;
- install path;
- version;
- Git revision when available;
- content digest;
- install/update timestamps;
- current lifecycle state.

Remote marketplace installs and remote plugin-source installs require an explicit `thirdPartyConfirmed: true` option. The flag is intentionally an API-level confirmation hook rather than a new UI, because the marketplace TUI is a later phase.

### Lifecycle states

Phase 2 exposes:

```text
not-installed
installed
update-available
broken
orphaned
```

`update-available` is detected from current local content digests, explicit source/revision changes, and declared version changes where those comparisons are available. Remote branch movement without a changed marketplace/plugin declaration is deliberately not guessed; later reconciliation/update work will own network-aware dependency/update behavior.

### Compatibility boundary

Marketplace installation does **not** automatically activate arbitrary JavaScript. NPM/PyPI plugin source entries remain parseable for catalog compatibility, but their executable package installation is deferred. Existing `.termagent/plugins/*.js` and `.mjs` plugins continue to load through the legacy loader.

### Verification gate

Phase 2 passed 12 focused marketplace/install tests and the complete 212-test TermAgent suite. Build, package dry-run, source-hygiene, and extracted-artifact smoke checks also passed. The phase is complete at 1.9.0; Phase 3 is now complete at 1.10.0.
## Phase 6 status

Phase 6 is complete in TermAgent 1.13.0. The implementation adds terminal-native `/plugins`, `/marketplace`, and `/skills` management on top of the Phase 2-5 marketplace/plugin/skill services. The UI preserves `TerminalUI` stdin ownership and ANSI/VT rendering, and it adds explicit trust/remove confirmations, enable/disable flows, search, nested marketplace plugin details, revision/digest display, component counts, and bounded mouse/keyboard navigation.

Visual QA covers 60x20 and 80x24 frames. A dense 60x20 marketplace detail layout was corrected after screenshot inspection so source/revision/digest stay visible while more plugin rows remain usable and the footer is preserved.

Phase 7 was the preceding hardening boundary for deeper trust, integrity, revocation, and supply-chain behavior.
## Phase 7 status

Phase 7 is complete in TermAgent 1.14.0. The security boundary now covers deterministic plugin SHA-256 content digests, Git revision checks, cached marketplace integrity, reserved marketplace identity validation, exact-match trust approvals, local blocklist/revocation policy, fail-closed policy parsing, skill-content security scanning, and realpath containment for installed plugin components. Phase 8 can build on these chokepoints for dependency resolution, deterministic updates, and state reconciliation without weakening the existing trust boundary.\n
## Phase 8 status

Phase 8 is complete in TermAgent 1.15.0. The lifecycle layer now resolves marketplace plugin dependencies before any install mutation, enforces a root-scoped cross-marketplace allowlist, installs dependencies in deterministic order, serializes process-local lifecycle writes, rolls back partial dependency/root transactions, reconciles installed state and orphaned entries at startup, cleans abandoned staging directories, and runs configurable background marketplace/plugin updates with safe defaults.

The implementation keeps pending `update-available` plugins active until a replacement is successfully installed, so an update does not cause the current session's component catalog to disappear. Startup reconciliation treats deleted marketplace entries as orphaned records and marks enabled plugins with unavailable dependencies as broken. The update path refreshes configured marketplaces first, then updates enabled installed plugins in deterministic ID order.

### Phase 8 verification

Focused lifecycle coverage includes dependency-first ordering, cycles and missing dependencies, cross-marketplace allowlists, rollback after a later dependency failure, concurrent installs, interrupted staging cleanup, active pending updates, startup orphan/dependency reconciliation, stale stored revisions, global auto-update disable, marketplace auto-update configuration, and local update application.
## Phase 9 status

Phase 9 is complete in TermAgent 1.16.0. Context requests now reserve explicit space for skill descriptors and explicitly loaded skill content, bound tool schemas before provider requests, and budget per-round workflow notices. Skill catalogs reuse unchanged metadata without re-reading bodies, share concurrent builds, maintain bounded project/search caches, and expose generation-based invalidation. The CLI loads the full skill catalog on demand instead of scanning it during every startup, and model-facing `use_skill` results are bounded with head/tail preservation.

### Phase 9 performance verification

The dedicated performance suite covers 10, 100, and 1,000 skills plus a 300-plugin catalog, concurrent build coalescing, cache invalidation, context-pressure handling, and low-memory execution. Benchmarks on the release workspace measured approximately 11/2.7 ms cold/warm at 10 skills, 28.6/15.8 ms at 100 skills, and 229.8/129.9 ms at 1,000 skills. The focused suite passed under a 64 MB Node heap.
