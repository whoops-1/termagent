# Changelog

## Unreleased

### 13N-J mobile runtime and release hardening

- Hardened managed process lifecycle around POSIX process groups, descendant cleanup, bounded output tails, timed stdin, and deterministic stop/cancel semantics.
- Added target-aware Android/ARMv7 release bundles, SHA-256 manifests, archive self-verification, prebuilt-first installation, source-build fallback, and ARMv7 CI smoke coverage.
- Added `termagent-device-smoke` for physical Termux validation and kept the real-device ARMv7 gate explicit instead of treating emulation as Android proof.

### 13N-I terminal interaction hardening

- Added semantic Markdown tables with alignment, Unicode-aware width handling, responsive wrapping, and compact fallback layouts.
- Added a runtime-owned durable prompt queue with queued/executing/completed/cancelled/failed states, edit/cancel/reorder operations, and automatic draining.
- Kept the composer interactive during live turns and made ordinary input/mouse activity non-cancelling.
- Added the richer semantic theme, banner, motion, and Exploration HUD system from the Complete Visual System + HUD snapshot.
- Added a narrow compatibility bridge for providers that leak XML-style tool-call markup into assistant text, while preserving the existing tool executor and loop guards.
- Fixed interactive shutdown so the terminal goodbye always includes the exact `termagent --resume <session-id>` command.
- Refreshed the public documentation and design notes so they describe current TermAgent behavior directly.
- Removed historical source/provenance wording from public documentation, design notes, tests, and generated output; the repository now describes its own architecture and behavior directly.

### Verification

- 13N-J-B release suite: **10/10 PASS**.
- Combined focused 13N-J-A + 13N-I regression gate: **75/75 PASS** before the final shutdown-only patch.
- Shutdown regression: **1/1 PASS** after passing the active session ID to `TerminalUI.leave()`.
- `npm run build` — **PASS**.
- `npm pack --dry-run` — **PASS**.
- Repository-wide aggregate test remains a separate gate because the known provider-manager test process does not terminate.

## 1.18.0

### Phase 11 release hardening and migration

- Added non-destructive, idempotent migration for legacy project/global skill roots, `.termagent/plugins`, and legacy plugin/skill config aliases.
- Added atomic config backups and centralized migration records under `~/.termagent/migrations.json`; legacy user content is adopted in place rather than moved or deleted.
- Added `/doctor` and `termagent --doctor` diagnostics covering environment, configuration, migration, marketplaces, installed plugins, plugin security policy, pure skill registries, skill catalog health, and storage permissions.
- Added machine-readable `--doctor --json` output for scripts and CI.
- Added documented plugin and skill authoring guides plus minimal declarative plugin and pure-skill examples.
- Added an end-to-end lifecycle fixture covering install → enable → discover → use → update → disable → remove, including disabled-plugin skill suppression.
- Added release-surface regressions for global migration, configured skill paths, migration corruption, CLI doctor JSON, authoring examples, and help output.
- Hardened configured skill-path discovery to use the effective project/global configuration after migration.

### Verification

- Phase 11 focused suite: **10/10 PASS**.
- Full repository suite: **325/325 PASS**.
- Release/source-hygiene suite: **6/6 PASS**.
- Clean build, package dry-run, extracted package smoke, final archive integrity, and extracted-release smoke must pass before this release is considered complete.

## 1.17.0

### Phase 10 pure skill registry support

- Added a transport-independent `SkillRegistryProvider` for declarative `registry.json` + `SKILL.md` distribution.
- Added dedicated registry, cache, installed-skill, trust, and revocation state under `~/.termagent/skill-registries/`.
- Added bounded 30-second remote fetches, 512 KiB registry / 256 KiB revocation / 64 KiB skill limits, HTTPS enforcement with localhost HTTP fixtures, and redirect destination validation.
- Added required SHA-256 skill pins, exact frontmatter name/version checks, cached-body integrity checks, and stale last-known-good registry handling.
- Added exact-match trust approvals bound to registry, skill, source, version, digest, and trust tier.
- Added fail-closed remote revocation handling with separate cached revocation state.
- Added pure-skill installation that never grants plugin commands, agents, MCP servers, hooks, or executable plugin permissions.
- Added registry provenance to the shared skill catalog plus live digest, security, path-containment, and revocation checks before invocation.
- Added `/skill-registry` management commands and registry-aware `/skills` install/uninstall flows.
- Added 17 focused Phase 10 tests covering remote failure, stale metadata, cache tampering, digest mismatch, revocations, redirect validation, symlinks, and size limits.

### Verification

- Phase 10 focused suite: 17/17 PASS.

## 1.16.0

### Phase 9 context-budget and performance optimization

- Added explicit context-section budgeting for instructions, repository context, skill descriptors, and explicitly loaded skill bodies.
- Added deterministic tool-schema bounding with required-property preservation and a fail-closed path for catastrophically oversized single-tool definitions.
- Added bounded skill-body tool output that preserves both the beginning and ending sections when truncation is required.
- Added per-session tool schema rendering cache, descriptor-field/search-result caches, concurrent skill catalog build coalescing, generation-aware invalidation, and bounded project cache eviction.
- Changed the CLI skill catalog to load on demand, avoiding unnecessary skill-directory scans during ordinary startup; no remote prefetch is introduced.
- Added performance coverage for 10/100/1000 skills, 300-plugin catalogs, concurrent discovery, cache invalidation, bounded context requests, 64 MB Node heap execution, and project-cache eviction.

### Verification

- Phase 9 focused suite: **10/10 PASS**.
- Full repository suite: **298/298 PASS**.
- Low-memory Phase 9 run (`--max-old-space-size=64`): **10/10 PASS**.
- Release/source-hygiene suite: **6/6 PASS**.
- Build, package dry-run, extracted-package smoke, and final archive integrity checks passed.

## 1.15.0

### Phase 8 dependency resolution, updates, and reconciliation

- Added marketplace-aware dependency resolution with dependencies-first deterministic ordering, cycle detection, missing-dependency diagnostics, and a root-marketplace allowlist for explicit cross-marketplace dependencies.
- Made plugin lifecycle writes process-serialized and made multi-plugin installs transactional so dependencies installed before a later failure are rolled back with their published paths and installation metadata.
- Added startup reconciliation for interrupted staging directories, deleted marketplace entries, orphaned installs, dependency failures, and current content/revision drift.
- Added configurable marketplace auto-update defaults: official marketplaces may default on, third-party marketplaces default off, and `TERMAGENT_AUTO_UPDATE=0|false|off|no` disables the background cycle globally.
- Kept `update-available` installations active until the replacement version is successfully published, preserving the current session while an update is pending.
- Added Phase 8 regression coverage for dependency graphs, cycles, rollback, concurrency, interrupted operations, stale stored revisions, reconciliation, active pending updates, and update opt-out behavior.

## 1.14.0

### Phase 7 trust, integrity, and supply-chain hardening

- Added deterministic SHA-256 plugin tree verification plus Git revision checks for recorded plugin and marketplace sources.
- Added cached marketplace manifest integrity checks so edited remote caches are reported as broken instead of silently trusted.
- Added reserved marketplace-name validation using exact official GitHub host/organization matching, rejecting lookalike hosts and direct URL impersonation.
- Added persistent plugin trust approvals keyed by source fingerprint, content digest, and revision, with explicit confirmation required again after any trust input changes.
- Added a private, atomic `~/.termagent/plugins/security.json` policy store supporting plugin/marketplace blocklists, revoked digests/revisions, and plugin trust approvals.
- Added fail-closed policy parsing so malformed security policy data cannot silently disable protections.
- Added a skill-content security scanner covering hidden Unicode, role/system injection markers, secret-exfiltration patterns, unsafe fetch helpers, concealed execution, destructive confirmation bypasses, and Unicode confusables.
- Added live skill rescanning before body loading and removed blocked skill descriptors from model-facing discovery.
- Added realpath/root containment checks for installed plugins and declared command, agent, MCP, and hook components, with no activation on digest or containment failures.
- Added focused Phase 7 adversarial coverage for hostile manifests, URL impersonation, cache tampering, trust invalidation, digest tampering, symlink escapes, revocation/blocklists, Unicode/role injection, and corrupted policy state.

### Verification

- Phase 7 focused suite: 13/13 PASS.
- Full repository suite: 276/276 PASS.
- Release/source-hygiene suite: 6/6 PASS.
- Clean build, package dry-run, extracted package smoke, and final archive integrity checks passed.

## 1.13.0

### Phase 6 plugin/marketplace TUI

- Added a full-screen `/plugins` manager using the existing ANSI/VT renderer and modal stdin ownership.
- Added installed plugin state display for enabled, disabled, broken, orphaned, and update-available plugins with compact component counts and revision/digest metadata.
- Added `/marketplace` browsing with marketplace details, plugin filtering, plugin detail pages, install actions, refresh/remove actions, and explicit trust confirmation before installation or update.
- Added `/skills` browsing with search, plugin provenance, version/source metadata, and on-demand skill detail inspection.
- Added keyboard navigation, page navigation, mouse selection, mouse-wheel navigation, split CSI/SGR input buffering, and cancellation handling without leaking input into the prompt or blocking permission/question modals.
- Added responsive 60x20 marketplace detail rendering so provenance fields remain visible while plugin rows are prioritized on small terminals.
- Added UI regression coverage plus screenshot-based visual QA fixtures for 60x20 and 80x24 layouts, long names, pagination, dialogs, marketplace plugin details, and mouse interaction.

### Verification

- Phase 6 focused suite: 14/14 PASS.
- Full repository suite: 263/263 PASS.
- Release/source-hygiene suite: 6/6 PASS.
- Clean build, package dry-run, extracted package smoke, and final archive integrity checks passed.

## 1.12.0

### Phase 5 plugin component integration

- Integrated installed plugin commands into the existing custom-command path with namespaced identities and plugin provenance.
- Integrated installed plugin agents into the existing custom-agent path with namespaced identities and tool/disallow metadata.
- Integrated declarative plugin MCP servers into the existing MCP client and propagated plugin provenance onto generated MCP tools.
- Added declarative plugin lifecycle hooks routed through the shared permission gate, including pre-tool blocking and post-tool/lifecycle status handling.
- Added manifest/state identity verification and deterministic installed-plugin processing before activation.
- Kept remote marketplace JavaScript execution disabled; legacy local `.js`/`.mjs` plugins remain the explicit compatibility path.

### Verification

- Phase 5 focused suite: 11/11 PASS.
- Full repository suite: 248/248 PASS.
- Release/source-hygiene suite: 6/6 PASS.
- Clean build, package dry-run, extracted package smoke, and final archive integrity checks passed.

## 1.11.0

### Explicit skill loading and agent discovery

- Added shared `search_skills` and `use_skill` tools on top of the Phase 3 `SkillCatalog`.
- Added deterministic relevance scoring with a minimum threshold and top-score delta filter, keeping weak descriptor matches out of model-facing discovery.
- Added automatic turn-zero discovery plus write-pivot and subagent-spawn rediscovery using descriptor metadata only.
- Added exact skill loading with realpath containment and SHA-256 digest verification before exposing full `SKILL.md` content.
- Added explicit `/skill <id> [args]` invocation, including namespaced plugin skills, with automatic discovery suppressed for the explicit body.
- Added `skill.search`, `skill.load`, and `skill.skip` session events for discovery and invocation decisions.
- Added loop protection coverage for repeated `use_skill` calls and preserved loaded skill output without tool-result summarization.

Phase gate: build, focused Phase 4 skill-discovery tests, full repository suite, source-hygiene scan, CLI/API smoke checks, package dry-run, and extracted-artifact verification must pass before Phase 4 is considered complete.

## 1.10.0

### Skill catalog and descriptor index

- Replaced body-based automatic skill selection with a descriptor-first `SkillCatalog`.
- Added project/global `SKILL.md` discovery plus local and installed plugin-provided skills.
- Added deterministic `SkillDescriptor` IDs, plugin provenance/version metadata, and `SkillDetails` inspection data.
- Added nested discovery, realpath-based symlink deduplication/root containment, and SHA-256 content fingerprints combined with path, mtime, and size.
- Removed full `SKILL.md` bodies from base runtime prompts; legacy loader helpers are now descriptor-only compatibility wrappers.
- Deferred `search_skills`, `use_skill`, `/skill`, and mid-turn discovery to Phase 4.

## 1.9.0

### Plugin marketplace sources, cache, and installation state

- Added compatible `.claude-plugin/marketplace.json` validation plus support for GitHub, git, URL, directory, and file marketplace sources.
- Added dependency-free marketplace persistence under `~/.termagent/marketplaces/` with atomic state writes and private permissions.
- Added shallow, recorded-SHA, and sparse Git materialization using the system `git` executable, with non-interactive credential/SSH behavior.
- Added cache refresh/reconciliation with transactional replacement so stale good caches survive failed refreshes.
- Added plugin installation materialization under `~/.termagent/plugins/cache/` with source, revision, SHA-256 digest, version, and lifecycle state metadata.
- Added explicit third-party install confirmation and install/update/remove/broken/orphaned state handling without auto-executing downloaded JavaScript.
- Added 12 focused adversarial marketplace/install tests covering traversal, corrupt state, network failure, sparse checkout, stored revisions, confirmation, updates, and partial installs.

Phase gate: build, full test suite, focused marketplace tests, package dry-run, source-hygiene scan, and extracted-artifact smoke test must pass before Phase 2 is considered complete.

## 1.8.0

### Plugin contract and compatibility layer

- Added validated plugin manifest support for compatible `.claude-plugin/plugin.json` packages and the native `.termagent-plugin/plugin.json` alias.
- Added metadata-only plugin package discovery without executing package code.
- Added manifest validation for identifiers, metadata, dependencies, and component paths with plugin-root containment checks.
- Preserved legacy local `.js`/`.mjs` plugin loading unchanged.
- Added adversarial manifest/path tests and documented the full plugin marketplace + skill discovery rollout plan.

Phase gate: build, full test suite, package dry-run, source-hygiene scan, and extracted-artifact smoke test must pass before Phase 1 is considered complete.

## 1.7.0

### Execution safety and task visibility

- Preserved the active user objective and live todo/completion state across automatic context compaction instead of reconstructing the objective from only removed messages.
- Added semantic no-progress loop detection across repeated tool cycles, covering patterns such as status checks → file inspection → unchanged todo state.
- Added a completion gate that requests a final text-only response immediately after all explicit non-autonomous todo items are marked done.
- Expanded the todo tool with atomic bulk updates so a model can update multiple existing todo items in one call without receiving an `Unknown todo: undefined` error from an `items` payload.
- Added a persistent main-chat todo panel with `[x]`, `[>]`, and `[ ]` task states plus compact progress counts.
- Kept prompt input disabled during active agent turns; only interruption/navigation/inspection controls are processed until the turn completes or is interrupted.
- Added regression tests for compaction preservation, semantic loop prevention, completion gating, todo rendering, and active-turn input isolation.


- Added compact transcript/tool-use and separate reasoning/permission interaction patterns.
- Added explicit task/step presentation and task-state concepts.
- Adapted these behaviors to the existing TermAgent Node/ANSI/VT architecture instead of replacing the renderer.

## 1.6.0

### Interaction rework

- Reworked the main terminal transcript so tool calls stay compact instead of dumping arguments, output, and diffs inline.
- Added dedicated full-screen inspectors for streamed reasoning, tool arguments/results, and file diffs.
- Added a two-stage diff viewer with changed-file selection and per-file detail navigation.
- Moved permission and question prompts into blocking full-screen views while preserving the existing permission resolver and selection model.
- Added `Ctrl+E` for reasoning inspection and `Ctrl+O` for the latest tool details.
- Added `/thinking`, `/details`, and `/diff` interactive inspector behavior without replacing the existing Node/ANSI renderer.
- Kept mouse clicks non-destructive and made mouse-wheel scrolling work inside inspectors.
- Preserved the existing `/provider` manager and Termux input architecture.


- Added modal/permission/tool interaction state to the terminal REPL.
- Added compact tool/thinking entries with detailed inspection support.
- Added approval-time diff presentation for file edits and writes.
- Added reusable blocking permission presentation.
- Added changed-file navigation and detailed diff inspection.
- Adapted to TermAgent's existing ANSI/VT renderer rather than copying the framework-specific UI runtime.

## 1.5.0

### Phase 5

- Fixed oversized repository/skills context blocking turns when the configured request budget is smaller than the generated dynamic context; dynamic context is now token-bounded while core instructions remain preserved.
- Added a full interactive `/provider` manager with Set provider, Edit provider, Add provider, Remove provider, and Done actions, persisted provider profiles, and a guided configuration form.
- Exact slash commands now submit immediately when the typed command already matches the selected completion.
- Added configurable prompt keybindings and interactive model, agent, session, and task selection.
- Added per-profile model variants with reasoning/output controls and provider-specific request extras.
- Added opt-in per-turn smart routing and per-agent/per-command model targets.
- Added interactive question tools with TUI and SSE/API response paths.
- Added rule-based permission overrides, safe parallel execution for explicitly independent read tools, and bounded model-context summaries for oversized tool output.
- Added session context inspection and a richer task inspector/log surface.
- Fixed a fast background-worker exit race that could leave durable tasks stuck in `running`.

- Fixed snapshot creation when ignored build/state directories are present by resolving ignore rules against an explicit candidate path set before staging.
- Command completion now ranks an exact trigger above longer prefix matches.
### Loop safety

- Added a normal-turn safety cap of 50 tool rounds by default, with `TERMAGENT_MAX_TOOL_ROUNDS` available for explicit tuning or `0` for an intentional unlimited mode.
- Added repeated-tool-call detection and a three-consecutive-write-only-round guard so a model that keeps restarting a completed task is forced into a text-only summary instead of looping indefinitely.
- Added regression coverage for identical-call loops, distinct repeated rewrites, and the configured turn-cap behavior.
### Patch updates

- File write/edit tool calls now carry structured unified diffs into the terminal UI.
- Write/edit permission prompts show a bounded proposed-change preview before approval.
- Inline tool results show file paths, additions/deletions, and changed lines without requiring `/diff`.
### Added

- Interactive history search and prompt draft undo/redo.
- Vim-style prompt editing.
- External-editor prompt composition and conversation export.
- Prompt stash and durable queue support.
- Tool execution detail visibility and richer Git diff output.
- Session event streaming over HTTP/SSE.
- Dependency-free JavaScript client SDK.
- Structured task presentation and task detail views.
- Public provider, agent, skill, model, and tool discovery endpoints.

### Hardened

- Cross-process task and queue synchronization.
- Streaming interruption and session status reporting.
- Unicode-safe terminal editing and output sizing.
- Atomic persistence for draft, task, and session-related state.
