# Changelog
## 2026-10-04

### Phase 14B — reconnect-safe session events

- Added a runtime-owned session event wakeup bus backed by durable SessionStore sequence reads.
- Replaced durable-event SSE polling with replay-then-tail semantics and explicit connection/heartbeat frames.
- Added reconnect-safe cursor handling and an authoritative session snapshot endpoint.

### Phase 14B — Event streaming

- Added a runtime-owned durable session event publisher/subscriber boundary.
- Replaced durable-event SSE polling with replay-then-tail wakeups keyed by persisted sequence.
- Added explicit ready/cursor semantics and a session snapshot reconciliation endpoint.


## Unreleased

### Phase 14F.6 — Live activity and reconnection reliability

- Routed foreground Web View prompts through the existing SSE `streamPrompt()` client so status, reasoning, response text, tool lifecycle, questions and completion are presented while the run is in progress.
- Published “Preparing workspace context” before context retrieval and “Thinking” before the provider emits its first token; added an inline mobile live-stage indicator.
- Exposed event-stream connection lifecycle to the client and separated live-event connectivity from actual server health, with health-probed stream replacement from the last durable cursor.
- Added prompt-stream heartbeats and hardened SSE frame parsing for split LF/CRLF/CR boundaries.
- Preserved permission policy: tool/shell permission-denied output is surfaced as an explicit activity result, never auto-approved or bypassed.
- Adapted OpenCode's explicit SSE lifecycle and shared activity-stream patterns to TermAgent's existing runtime, JSONL durability and HTTP/SSE protocol.
- Verified TypeScript build, Web View syntax, and 75/75 Phase 14 regression tests; physical Android Brave validation remains outstanding. The repository-wide test command exceeded its 240-second limit and is not claimed as passing.

### Phase 14F.5 — First-class Subagents workspace

- Added a session-scoped hierarchical Subagents workspace built from the existing TaskManager parent/child graph, with role, scope, status, duration, activity, usage, and nested delegation visibility.
- Added worker turn/tool lifecycle activity and durable task-event SSE replay/tail so detached child workers update the Web View without creating a second agent runtime.
- Added bounded child-transcript, event-history and output reads; safe public task/event projections omit provider credentials, worker tokens, permission rules, process identity, raw output tails and prompt-bearing event payloads.
- Added Web View details and live follow-up/cancel/resume controls, plus daemon terminal `/subagents`, `/subagent-send`, and `/subagent-resume` commands.
- Adapted OpenCode child-session tracking and OpenClaude teammate-detail patterns to TermAgent's TaskManager, TaskEventLog, SessionStore and existing Web View. No unsupported pause control was added.
- Verified the Phase 14F.5 tests (4/4) and focused Phase 13I/14A–14F.5 regression set (81/81). The complete test command remains blocked by the `/auto` E2E assertion also reproduced against the Phase 14F.4 baseline and by the aggregate run timeout; see the Phase 14F.5 report.

### Phase 14F.4 — Cross-client state convergence

- Reconstructed terminal tool transcripts by stable provider call ID and propagated call identity through live runtime events, durable tool lifecycle records and permission requests.
- Kept non-interactive daemon-attached terminals passive so they do not reject or cancel browser-owned permissions/questions they cannot render.
- Expanded attached-terminal daemon projections for tool lifecycle, Todo/tasks, workflow/verification, diffs, checkpoints, compaction, queues and history reconciliation.
- Added attached-terminal diff, task, cancel/interrupt, checkpoint, restore and branch commands using existing daemon APIs.
- Adapted upstream keyed tool lifecycle reconciliation to TermAgent's existing HTTP/SSE, durable event and snapshot protocol; full multi-client TTY/mobile parity remains open.

### Phase 14F.3 — Terminal daemon client convergence

- Made terminal startup attach to a ready workspace daemon before constructing local Agent runtime state, while retaining the standalone path when no server owns the workspace.
- Added terminal device pairing and owner-only per-workspace credential persistence with `/device revoke`.
- Routed terminal prompts, queue/session operations, turn controls, permissions and questions through the daemon-owned runtime and existing HTTP/SSE protocol.
- Added durable assistant-history reconciliation for incomplete transient streams and server-owned queue-worker recovery.
- Fixed asynchronous SessionStore mutation reentrancy with `AsyncLocalStorage` and moved queue-worker kickoff outside the command-ledger mutation.
- Documented the initial daemon-client command subset and remaining TTY parity, remote attach, mobile validation and repository-wide test limitations.

### Phase 14F.2 — Durable SSE tail, backpressure and transient-gap reconciliation

- Kept the append-only JSONL event log as truth and added a bounded one-second SSE durable-tail poll to complement process-local EventBus wakeups.
- Made durable session-event SSE writes honor Node response backpressure, with stream-serialized heartbeats and authorization re-checks.
- Added explicit transient live-buffer overflow signaling and Web View snapshot reconciliation without advancing the durable cursor from a gap frame.
- Added regression coverage for detached-worker durable writes, buffer overflow, browser reconciliation, and waiting for response drain.

### Phase 14F.1 — Exclusive daemon ownership and restart reconciliation

- Added a workspace-keyed exclusive owner lease shared by server and standalone terminal startup, with process identity, heartbeat, endpoint metadata and guarded stale-owner recovery.
- Added authenticated health discovery of safe daemon metadata, and an explicit server shutdown lifecycle hook that releases the owner after runtime shutdown.
- Prevented a second terminal/server runtime from silently opening the same workspace; until terminal attachment is implemented, the second launcher fails with owner details.
- Reconciled orphaned permission and question requests after fenced startup and recorded unmatched started turns as interrupted.
- Adapted OpenCode service registration/probe/recovery behavior; inspected but did not port the supplied OpenClaude no-op lockfile stub.

### Phase 14E — Security, pairing, and remote access

- Kept loopback-only Web View access as the default and made direct non-loopback binds fail closed without explicit HTTPS device pairing.
- Added direct HTTPS and TLS-terminating reverse-proxy deployment modes with exact public Host/Origin validation.
- Added one-time short-lived pairing codes, random per-device bearer tokens, hash-only owner-mode persistence, token expiry, and device self-revocation.
- Added workspace/session/task authorization scopes and server-assigned command client identity; permission/question and task mutations require dedicated scopes.
- Added JSON-only mutation requests, Fetch Metadata checks, no CORS/query credentials/cookies, bounded per-source request and pairing limits, and audit records.
- Minimized browser configuration projections and redacted internal HTTP/SSE errors.
- Added direct TLS, reverse-proxy, workspace, scope, expiry, revocation, replay, Origin/Host, and CSRF-style integration tests.

### Phase 14E.1 — Server-owned permission resolver integration

- Connected the server `PermissionGate` requester to the canonical durable `SessionStore` interaction wait, so browser Allow/Once/Always and Deny settle the exact permission wait already awaited by the original `ToolRegistry.execute()` call.
- Kept browser HTTP handlers as command adapters; the existing durable store and runtime-local event bus remain authoritative instead of introducing an HTTP-owned or duplicate in-memory promise registry.
- Made interaction waiting race-safe across subscribe/read, durable reply, timeout and `AbortSignal`; re-read durable state after timeout/abort races so the first committed resolution wins.
- Persisted cancellation reasons for interrupted, timed-out and failed permission waits, and prevented an already-aborted turn from starting a tool even when approval committed concurrently.
- Added unique fallback permission identities for concurrent direct tool calls that do not carry provider tool-call IDs.
- Registered active run completion before asynchronous context retrieval and made graceful runtime shutdown abort and await active turns before closing MCP clients.
- Added nine focused permission-resolver integration/regression tests.

### Phase 14D — Browser Web View

- Bound the supplied v4 mobile-first Web View prototype to the existing typed HTTP/SSE client without replacing the runtime, protocol, or session store.
- Added allowlisted Web View static asset routes and browser URL output for `termagent --serve`; API/session data remains bearer-token protected.
- Projected canonical session snapshots, durable replay events and bounded transient run events into transcript, tool, reasoning, activity, permission/question, plan, queue, task, diff and verification surfaces.
- Added mobile-first session navigation, live composer/queue interactions, slash suggestions, context/runtime panels, checkpoints, task continuation, compact/undo/redo, accessible sheet/tab controls and dependency-free Markdown tables.
- Preserved the uploaded prototype unchanged and added no frontend dependencies or animation library.
- Added focused static-asset/auth/SSE/reconciliation/coalescing/design-foundation tests.


### Phase 14C — HTTP API and dependency-free client SDK

- Added a stable renderer-neutral HTTP API for sessions, history, durable event replay/streaming, runtime status, context/snapshot, permissions, questions, Todo/queue, tasks, diffs, checkpoints, and capability discovery.
- Kept `src/server/http.ts` at the transport boundary and routed state-changing operations through the canonical `CommandEnvelope`/`CommandLedger` path.
- Added a typed dependency-free `src/client` API based on standard Fetch APIs.
- Added header-authenticated fetch-based SSE parsing with durable cursor tracking, reconnect backoff, and cancellation.
- Added route/schema drift tests and corrected the stable plural checkpoint-create route while retaining the legacy singular compatibility alias.
- Kept durable SessionStore history/events authoritative for recovery; live-only connection/heartbeat/streaming fragments remain transport events.

### 13N-J-C shell service/process semantics

- Scoped semantic no-progress detection away from operational shell/write rounds so unrelated command execution cannot inherit an exploration stagnation streak.
- Preserved intentional shell background descendants after a successful shell-leader exit while keeping process-group cleanup for ordinary foreground commands and cancellation/timeout paths.
- Added durable `backgroundChildrenPreserved` task/result metadata for the shell lifecycle.
- Added structured `EADDRINUSE` detection and model-facing guidance to inspect/reuse an existing endpoint before another launch.
- Strengthened shell guidance to use durable background execution for persistent servers and watchers.

### 13N-J mobile runtime and release hardening

- Hardened managed process lifecycle around POSIX process groups, descendant cleanup, bounded output tails, timed stdin, and deterministic stop/cancel semantics.
- Added target-aware Android/ARMv7 release bundles, SHA-256 manifests, archive self-verification, prebuilt-first installation, source-build fallback, and ARMv7 CI smoke coverage.
- Added `termagent-device-smoke` for physical Termux validation and kept the real-device ARMv7 gate explicit instead of treating emulation as Android proof.

### 13N-I terminal interaction hardening

- Added semantic Markdown tables with alignment, Unicode-aware width handling, responsive wrapping, and compact fallback layouts.
- Added a runtime-owned durable prompt queue with queued/executing/completed/cancelled/failed states, edit/cancel/reorder operations, and automatic draining.
- Kept the composer interactive during live turns and made ordinary input/mouse activity non-cancelling.
- Added the richer semantic theme, banner, motion, and Exploration HUD system from the Complete Visual System + HUD snapshot.
- Replaced the post-hoc XML regex/gate compatibility path with a bounded incremental text-tool protocol parser that runs before transcript projection.
- Added split-stream handling, wrapperless calls, multiple calls, parameter variants, JSON wrappers, schema-aware registry resolution, finish-time reconciliation, and a compatibility mapping from model `shell` to TermAgent `bash`.
- Routed XML-recovered calls into the existing semantic tool-call, permission, loop-guard, lifecycle, and result pipeline; the renderer never receives internal tool-call XML.
- Fixed interactive shutdown so the terminal goodbye always includes the exact `termagent --resume <session-id>` command.
- Refreshed the public documentation and design notes so they describe current TermAgent behavior directly.
- Removed historical source/provenance wording from public documentation, design notes, tests, and generated output; the repository now describes its own architecture and behavior directly.

### Verification

- 13N-J-B release suite: **10/10 PASS**.
- Combined focused 13N-J-A + 13N-I regression gate: **75/75 PASS** before the final shutdown-only patch.
- Shutdown regression: **1/1 PASS** after passing the active session ID to `TerminalUI.leave()`.
- XML text-tool compatibility suite: **15/15 PASS**; broader provider/tool/agent gate: **127/127 PASS**.
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

## Unreleased

### Phase 14E — Security, pairing, and remote access

- Kept loopback-only Web View access as the default and made direct non-loopback binds fail closed without explicit HTTPS device pairing.
- Added direct HTTPS and TLS-terminating reverse-proxy deployment modes with exact public Host/Origin validation.
- Added one-time short-lived pairing codes, random per-device bearer tokens, hash-only owner-mode persistence, token expiry, and device self-revocation.
- Added workspace/session/task authorization scopes and server-assigned command client identity; permission/question and task mutations require dedicated scopes.
- Added JSON-only mutation requests, Fetch Metadata checks, no CORS/query credentials/cookies, bounded per-source request and pairing limits, and audit records.
- Minimized browser configuration projections and redacted internal HTTP/SSE errors.
- Added direct TLS, reverse-proxy, workspace, scope, expiry, revocation, replay, Origin/Host, and CSRF-style integration tests.

### Loop-safety correction

- Fixed the semantic no-progress guard incorrectly treating shell/task execution metadata (`taskId`) as semantic progress state.
- Distinct shell verification commands no longer terminate a normal turn after three executions merely because they did not change repository state.
- Existing identical-call and exploration no-progress protections remain in place.
