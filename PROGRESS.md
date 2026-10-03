# TermAgent Progress

## Loop safety fix

- Fixed normal Build-mode turns with no configured tool-round limit repeatedly continuing after successful work.
- Added full-input repeated-call detection plus a bounded write-only-round guard; a safety stop disables tools and requests a final text-only summary.
- Interactive configuration now defaults to 50 tool rounds while preserving explicit `0` as an unlimited escape hatch.
- Reproduced the screenshot failure with a live OpenAI-compatible SSE provider and confirmed three distinct rewrites stop on the fourth text-only turn.
- Verification: build and 181/181 tests passing.

## Phase 5 parity pass

- Fixed a real user-facing context-budget failure where generated repository/skills context could exceed the available message budget before the provider request. Dynamic context is now bounded to the computed request budget.
- Added a native interactive `/provider` manager with Set provider, Edit provider, Add provider, Remove provider, and Done actions backed by persistent profiles.
- Provider profile editing now supports real cursor movement, Delete, and Ctrl+U line clearing instead of append-only text entry.
- Exact slash commands now execute on the first Enter when the typed command is already an exact completion.
- Completed the implementation review across session/workflow, model/agent selection, input, tools, context, extensibility, API, and worker-safety behavior.
- Added interactive model, custom-agent, session, and task selection surfaces while keeping the existing `PromptEditor` and terminal renderer as the shared UI primitives.
- Added model variants, reasoning effort metadata, per-agent/per-command model selection, and opt-in per-turn smart routing.
- Added interactive question handling in the TUI plus an API/SSE question lifecycle.
- Added configurable keybindings, rule-based permission overrides, safe parallel read scheduling, bounded tool-output summarization, and context inspection.
- Fixed the fast background-worker exit race discovered by the full-suite parity regression.
- Verification after the worker fix and parity additions: full repository test gate, clean build, package dry-run, source hygiene scan, and clean extracted-artifact verification.
- Physical ARMv7/Termux runtime validation remains pending because this environment has no ARMv7 Android device.

## Phase 5 hardening

- Fixed snapshot creation with ignored build/state directories by resolving ignore rules over an explicit file candidate set and staging only allowed paths through NUL-safe pathspec input.
- Added a permanent regression covering ignored `dist/` and `.termagent/` directories during snapshot creation and restore.
- Command completion now ranks exact command triggers ahead of longer prefix matches while preserving fuzzy matching.
- Added regression coverage for `/checkpoint` versus `/checkpoints` selection.
- Verification: build, full test suite, package dry-run, and compiled CLI smoke with ignored directories.

## 1.1.5 UI architecture hardening

- Added a renderer-independent `SelectModel` based on TermAgent's focused `Select` interaction pattern.
- Kept permission selection isolated from the prompt editor so approval keystrokes cannot leak into the composer.
- Added Home/End and Space selection semantics alongside Up/Down, j/k, Enter and numeric shortcuts.
- Added a dedicated 1.1.5 UI design note.
- Added regression coverage for selection focus and submit/cancel behavior.

## 1.1.4 UI hardening

- Ported the implementation style declarative cursor approach: logical cursor state is rendered into the prompt frame instead of relying on the terminal's implicit caret.
- Consolidated prompt rendering around the shared visual-row layout used by the editor for wrapped multiline input.
- Fixed composer state so a submitted prompt is cleared before the agent turn and cannot remain as a second copy below the conversation.
- Made permission requests a true UI-owned modal/select state with exclusive stdin ownership while pending.
- Added explicit `awaiting approval` tool state so the UI never labels a tool as running before approval is granted.
- Used standard ANSI inverse-video cursor rendering for broader Termux compatibility.
- Added a permission stdin regression test covering once/always/deny selection.
- Added PTY screenshot verification at 80x24 and 60x20 for multiline cursor editing and shell approval.

## 1.1.2 UI rewrite

- Reworked interactive UI around an TermAgent-inspired separation between logical input state, visual row layout, and terminal cursor coordinates.
- Added row-diff rendering with absolute terminal coordinates to avoid line-drift and stale-prompt artifacts.
- Fixed submitted prompts being left in the input surface by repainting the editor on reset.
- Added a permission modal that owns stdin while a tool approval is pending.
- Connected `PermissionGate` to the interactive UI instead of `readline` for TTY sessions.
- Added Allow once / Always allow / Reject navigation and single-key shortcuts.
- Kept the fallback `readline` permission path for non-TTY use.

## 1.1.2

- Paused the planned 1.2 API expansion to repair the interactive TUI first.
- Replaced the interactive prompt's incremental line erasure with a persistent alternate-screen renderer.
- Added TermAgent-style session header, conversation viewport, bottom prompt surface and footer controls.
- Added TermAgent-style agent cycling (`Tab`/`Shift+Tab`) plus command/variant shortcut wiring (`Ctrl+P`/`Ctrl+T`).
- Fixed multiline backspace/delete repaint corruption by separating logical input state from terminal rendering.
- Changed Up/Down behavior to move vertically inside multiline input before falling back to history.
- Added bare Escape handling and model-turn interrupt propagation through AbortSignal.
- Prevented aborted provider calls from entering retry backoff.
- Removed the default tool-step ceiling for built-in modes; `TERMAGENT_MAX_TOOL_ROUNDS` remains available as an explicit cap.
- Changed the step boundary to a final text-only response instead of a hard tool-loop exception.
- Kept the non-TTY line-oriented execution path unchanged.

Verification target: TypeScript build, full test suite, interactive PTY smoke test, multiline editing/delete behavior, interrupt smoke test, shortcut smoke test, and uncapped/capped agent-loop regression coverage.

## 1.1.0

- Added reusable runtime composition in the corresponding module.
- Added Node built-in HTTP/SSE server in the corresponding module.
- Added server lifecycle entrypoint in the corresponding module.
- Added CLI `--serve`, `--host`, `--port`, and `--token` options.
- Added session/task/agent/skill HTTP endpoints.
- Added streamed model/tool events over SSE.
- Kept existing Agent/ToolRegistry/SessionStore/TaskManager as the execution core.
- Added server design/setup documentation.

Verification target: build, unit suite, HTTP integration, SSE integration, auth, session APIs, task APIs, and extracted-archive smoke test.

- Added zero-credential `examples/mock-provider.mjs` for real-device smoke testing.
- Added `docs/DEVICE_TEST.md` with ARMv7 Termux validation steps.

## 1.1.6 UI fixes
- Automatic slash-command picker with 8 visible filtered options and keyboard selection.
- Conversation viewport scroll with PageUp/PageDown, Ctrl+Up/Down, SGR mouse wheel, and a right-hand rail.
- Empty provider responses now retry and surface an explicit error instead of silently returning to the prompt.
## 1.1.6 verification

- `npm run build`: PASS.
- `npm test`: PASS, 41/41 tests.
- Added real prompt-level tests for automatic slash picker activation, filtering, arrow selection, and scroll key direction.
- Added conversation viewport scroll regression coverage.
- PTY verification from the compiled binary covered command picker, submission/composer reset, permission selector, and conversation scrolling.
- No runtime UI package or native terminal dependency added.

- Fixed a UI data-flow bug where streamed assistant text was received by the agent callbacks but no assistant entry was created, so the reply was invisible in the conversation.
- Final automated suite: 42/42 tests passing.
- Final PTY screenshots inspected at 80x24 and 60x20 for slash picker, submission, permission approval, and conversation scrolling.

## 1.5.0 UI interaction hardening

- Fixed command-picker navigation so the eight visible rows are only a viewport. Selection moves through the full result list and preserves the global selected index.
- Added the implementation style command palette path for `Ctrl+P`, reusing the same selection model rather than printing an unselectable command dump.
- Fixed model-turn mouse handling so touch/click sequences are ignored while mouse-wheel events still scroll the conversation. Split SGR mouse sequences are covered by regression tests.
- Added live activity phases for thinking, explicit reasoning, writing, tools, permission requests, retries, and compaction.
- Added a provider-reasoning panel that is collapsed by default and toggled with `Ctrl+E` or `/thinking`.
- Ensured streamed assistant text always materializes a visible assistant entry, fixing turns that previously received provider output but displayed no answer.
- Added explicit retry behavior for empty provider responses.
- Added independent conversation scrolling with a fixed prompt/composer.
- Added PTY screenshot verification for the command picker, filter/selection, multiline editing, mouse-safe running turns, reasoning expansion, permission approval, response rendering, and chat scrolling.
- Added a feature matrix comparing TermAgent capabilities with current TermAgents behavior and identified the remaining Q1-Q4 gaps.

### 1.5.0 verification

- `npm run build`: PASS.
- `npm test`: PASS, 49/49 tests.
- PTY screenshots manually inspected at 80x24 and 60x20.
- Slash-picker selection was exercised beyond the eighth visible row.
- `Ctrl+P` command palette was exercised with filtering and keyboard selection.
- Mouse-click interruption was exercised using SGR press/release sequences during an active model turn.
- Permission flow was exercised end-to-end with the model turn continuing after approval.
### Post-verification fix: standalone Escape handling

A final PTY pass found an input-state edge case after closing `Ctrl+P`: the terminal sends a bare ESC as an incomplete escape sequence until we can distinguish it from a split mouse/control sequence. Without a timeout, the editor could retain `escapeBuffer='\x1b'` and silently consume subsequent typed characters. The editor now promotes a lone ESC to the normal completion-close path after a short 70ms grace period, while real multi-byte terminal sequences continue through the sequence parser.

Post-fix verification:
- Rebuilt `dist` from source.
- Full `npm test`: 49/49 PASS.
- Real PTY CLI flow: `Ctrl+P` -> navigate beyond 8 rows -> filter -> Escape -> type new prompt -> submit -> active-turn mouse click -> `Ctrl+E` -> permission -> approval -> final streamed response: PASS.
- PTY raw output confirmed the post-Escape prompt text reached the model turn and the click did not generate an interrupt.
## Phase 1: Transactional turns (implemented after 1.5.0)

- Added a private Git-backed snapshot store that never touches the project's real Git index.
- Agent turns now record before/after filesystem snapshots and tag persisted messages with the turn ID.
- Added `/undo` and `/redo` to the CLI command layer and command palette.
- Added HTTP `POST /api/v1/sessions/:id/undo` and `/redo` endpoints.
- Undo/redo refuse to overwrite manual filesystem changes when the working tree no longer matches the expected turn boundary.
- Starting a new turn after undo creates a new history branch and clears the redo stack.
- Added regression coverage for restore, redo, working-tree drift, and branching.
- Verification: TypeScript build passes; all 52 tests pass.

The snapshot design is intentionally implemented using TermAgent TermAgent's snapshot/revert model rather than modifying the user's Git repository directly. TermAgent documents snapshots as the mechanism behind session undo/revert and also notes their potential indexing/disk costs, so TermAgent keeps the snapshot repository private and excludes high-noise directories such as `node_modules`, `dist`, and `.git`.
### Phase 1 hostile verification standard

Phase 1 was re-run under an adversarial test cycle instead of relying on the original happy-path regressions. The hardened suite now covers:

- concurrent snapshot creation across multiple `SnapshotStore` instances;
- concurrent turns across multiple `SessionStore` instances;
- concurrent undo requests and serialized history mutation;
- provider failure after a successful filesystem mutation;
- repeated multi-turn undo/redo, including state reconstruction after `SessionStore` recreation;
- manual working-tree drift, including files that become newly Git-ignored during a turn;
- preservation of pre-existing Git-ignored user files;
- refusal to overwrite an ignored path that blocks a snapshot-required path;
- binary files, symlinks, executable permissions, file/directory type changes, and user Git index isolation;
- working-directory/session mismatch protection;
- invalid snapshot identifier rejection;
- truncated final JSONL recovery and fatal middle-of-log corruption;
- a model-based history fuzz test of 250 randomized operations, repeated across four independent seeds;
- full project build and full regression suite after the hardening pass.

The snapshot implementation now serializes operations per snapshot store, session turns are explicitly busy while running, ignored files are preserved during restore, protected overlay snapshots prevent ignore-rule changes from bypassing drift detection, snapshot trees are recorded against Git garbage collection, and session logs tolerate a torn final line while still rejecting internal corruption. Session turn leases also serialize separate TermAgent processes and recover after an owner process dies.

During the hostile rerun we found and fixed: first-use snapshot repository initialization races; cross-process session races; catastrophic deletion of Git-ignored user files during restore; ignore-rule changes that could bypass manual-edit detection; unreferenced snapshot trees that Git GC could delete; and test/cleanup paths that were doing expensive Git maintenance on every turn.

Final hostile verification after the last fixes: 26 Phase 1 hardening tests plus 3 original Phase 1 tests pass; the actual CLI undo/redo flow and HTTP undo/redo endpoints pass; four model-based fuzz runs of 250 operations each pass; separate-process snapshot initialization, turn contention, and dead-owner recovery pass; and the full repository gate is rerun from a clean build before packaging; the final repository gate is 79/79 tests with a clean TypeScript build, followed by archive extraction and smoke verification.

This test discipline is now the Phase standard for subsequent work: resulting behavior is inspected first, adversarial regressions are added before declaring a phase complete, concurrency and recovery are tested explicitly, stateful features get model-based stress coverage, and the entire repository is rebuilt and re-tested after the final fix.
## Phase 2: Context intelligence

Implemented after the hardened Phase 1 baseline. The change stayed within TermAgent's dependency-light Node/ANSI architecture and did not add native runtime dependencies.

### Repository map and retrieval

- Added cached per-file analysis under `~/.termagent/repomap-cache` with atomic cache writes and invalidation.
- Added NUL-safe Git/ripgrep enumeration with a Node filesystem fallback.
- Added TypeScript/JavaScript/Python symbol extraction for functions, classes, interfaces/types/enums/variables/methods plus imports and references.
- Added CommonJS, combined/default/named/namespace/side-effect JavaScript imports and Python relative/package imports.
- Added import-alias usage references, IDF-weighted dependency edges, and PageRank-style structural ranking.
- Added fused lexical/content/symbol/graph retrieval with file, UTF-8 byte, and token bounds plus focused-file/focused-symbol selection.
- Added the `repo_map` read-only tool and `/repomap` CLI surface with token/focus/stats/invalidation controls.

### Context budget and compaction

- Added conservative Unicode-aware token estimation and request-budget calculation.
- Agent now estimates the complete request, including the newly persisted user prompt and tool schemas, before provider execution.
- Added deterministic structured compaction with objective/details/work-state/next-move/relevant-file sections.
- Recent user/assistant/tool units are kept atomically, tool errors are preserved, and previous compaction summaries roll forward into later summaries.
- System instructions are preserved exactly when they fit; irreducible system/schema overflow fails before provider execution rather than truncating instructions.
- Server and background-agent runtimes now pass the same compaction configuration knobs as the CLI.

### Phase 2 verification

The phase was stress-tested beyond the original happy paths. Targeted context tests cover cache reuse/invalidation, content-only retrieval, symbol-centered retrieval, graph neighborhoods, aliases, side-effect/CommonJS/Python imports, same-name graph explosion, Unicode byte bounds, pathological analyzer caps, corrupted caches, concurrent cache builds, repeated compaction, tool-call/result atomicity, prompt-added overflow, system/schema overflow, and rolling-summary preservation. CLI `/repomap` and the `repo_map` tool are exercised end-to-end.

Final repository gate after a clean build: **118/118 tests passed**, with zero failures, skips, cancellations, or TODO tests. The complete suite includes the Phase 1 hostile verification set plus the Phase 2 context and integration regressions. The release archive was then smoke-checked after extraction.

### Bugs found and fixed during the Phase 2 hostile pass

- content-search parsing that incorrectly handled ripgrep NUL records; fixed by using newline-safe content matching while retaining NUL-safe repository enumeration;
- compaction summaries that could consume the recent tail; fixed by reserving recent context before sizing the summary;
- repeated compaction that dropped earlier summaries; fixed by folding the previous summary into the next summary source;
- imported-name ambiguity that caused noisy same-name graph cross-talk; fixed by resolving imports to their actual target definitions;
- import aliases omitted from weighted usage references; fixed by recording alias usages;
- CommonJS and Python package/relative imports missing from graph edges; fixed with explicit resolvers;
- size/mtime-only cache invalidation that missed same-size edits with restored mtimes; fixed with ctime in the cache key/validation;
- context checks that ignored the newly submitted user prompt; fixed by persisting it before preflight compaction;
- tool/schema overflow paths that could reach the provider; fixed with a hard preflight failure;
- compaction that could split tool-call/result pairs; fixed with atomic tool units;
- UTF-16 string-length budgeting that violated UTF-8 byte limits; fixed with byte-accurate accounting and safe truncation;
- pathological files able to generate unbounded symbol/reference arrays; fixed with per-file analysis caps;
- repository-map output capable of exceeding its requested token budget; fixed with estimator-based rendering bounds.

The Phase verification standard remains mandatory for later phases: inspect the relevant implementation first, adversarial regressions, concurrency/recovery where relevant, stateful fuzzing, resource/platform checks, full rebuild, full suite, and extracted-artifact smoke verification.
## Phase 3: Execution intelligence

- Added a persisted autonomous workflow controller with planning, building, verification, iteration, complete, and blocked states. Completion requires a real successful verification result.
- Added repeated-tool/no-progress guards and bounded autonomous step and verification-failure limits.
- Added phase-aware tool filtering and a second execution-time authorization check.
- Added cross-process-safe TaskManager state updates and TaskEventLog sequence allocation with stale-lock recovery.
- Added per-session TodoWrite state with cross-process read-modify-write serialization.
- Added bounded `parallel_agents` scheduling with explicit in-project, non-overlapping workspace scopes, a four-agent session cap, and cross-process admission locking.
- Scoped workers cannot recursively launch agent workers and cannot use arbitrary shell or Git tools; file-writing tools enforce scope boundaries.
- Added structured verification results and automatic verification-command detection for Node, Make, Python, Rust, and Go with bounded timeouts.
- Added role-aware provider routing for planning, building, verification, and subagent work while retaining no-fallback-after-output and permanent-error behavior.

### Phase 3 hardening findings

- Fixed terminal-state mutation, verification-failure transition ordering, cross-process TodoWrite lost updates, scheduler TOCTOU admission races, provider adapter/model deduplication, out-of-project parallel scopes, task event sequence races, and stale state-lock recovery.
- The adversarial suite covers state corruption, randomized workflow transitions, cross-process persistence, stale owners, scope violations, recursive worker suppression, provider fallback boundaries, actual local OpenAI-compatible streaming, verification timeouts, and full autonomous lifecycle enforcement.

### Phase 3 verification target

The phase must pass the full `docs/PHASE_TEST_STANDARD.md` gate: clean build, targeted execution tests, full repository suite, real CLI/API surfaces where affected, cross-process stress, and an extracted archive smoke check.

### Phase 3 final hardening pass

The execution layer was re-run under the standing Phase test standard after the initial implementation, including focused lifecycle tests, process-boundary stress, failure injection, provider-routing integration, and real CLI execution.

Additional bugs found and fixed after the first green Phase 3 run:

- Background shell tasks did not persist their worker PID immediately, leaving task status vulnerable to stale `queued` state and making recovery unreliable.
- Worker spawn failures could leave durable tasks permanently queued. Worker launch now waits for the process `spawn` event, persists the PID before returning success, and marks failed launches explicitly.
- Orphaned queued tasks without a PID are now converted to explicit failures during startup recovery instead of remaining indistinguishable from live work.
- Partial `parallel_agents` launches now roll back every task created by the failed launch so a mid-batch spawn failure cannot leave a mixture of queued/running zombies.
- Provider routers cannot be persisted as a fake worker provider. Background and parallel agent tools resolve the concrete `subagent` provider before writing durable task state, so workers can reconstruct the provider in a separate process.
- CLI and server startup now construct the provider router before registering background/parallel agent tools, preventing those tools from accidentally capturing the pre-routing provider instance.

Final Phase 3 verification:

- Clean TypeScript build: PASS.
- Focused Phase 3 execution + CLI end-to-end tests: 34/34 PASS.
- Full repository suite after the final fixes: 149/149 PASS, zero failures/skips/cancellations.
- Stateful workflow fuzzing: four independent seeds, 500 transitions per seed, all invariants preserved.
- Cross-process TodoWrite, task-event, scheduler admission, task-update, stale-lock recovery, and worker-state tests: PASS.
- Real local OpenAI-compatible SSE streaming through provider routing: PASS.
- Real CLI `/auto` lifecycle with file mutation and detected project verification: PASS.
- Provider-routing persistence tests for background and parallel workers: PASS.
- The final source tree is archived and will be rebuilt/tested again after extraction before release.

## Phase 4: Interaction, API, and SDK

- Added bounded prompt history search and reverse-history navigation.
- Added prompt-local undo/redo with bounded edit history and draft replacement resets.
- Added Vim insert/normal editing for the terminal prompt, including Unicode-safe deletion.
- Added external-editor prompt composition using `$VISUAL`/`$EDITOR`, safe argument splitting, mode-600 temp files, and conversation export.
- Added durable cross-process prompt stash and queue state with atomic writes and stale-lock recovery.
- Added richer tool-step presentation and bounded per-file Git diff rendering with statistics and UTF-8 byte limits.
- Added structured task list/detail formatting and terminal task inspection support.
- Added session, task, model, agent, skill, and tool discovery endpoints.
- Added session status, diff, durable event pagination, and long-lived SSE event streaming.
- Added streaming prompt events for reasoning, text, tool start/end, completion, and errors.
- Added a dependency-free typed JavaScript client under `termagent/client` with cancellation-aware streaming readers.
- Added package versioning, declaration output, public package metadata, contribution/security/conduct documents, and Phase 4 API/interaction documentation.
- Removed external project names from repository source/docs and added a release regression that scans the complete tree.

### Phase 4 hardening findings

- Fixed provider configuration defaults being captured at module import, which caused multiple runtimes in one process to reuse stale endpoints.
- Fixed queued task cancellation being overwritten by late worker startup/final status updates; cancellation is now terminal.
- Fixed worker PID persistence and spawn failure handling, including orphaned queued-task recovery and partial parallel-launch rollback.
- Fixed background/parallel worker provider persistence so durable tasks reconstruct concrete providers rather than transient router objects.
- Fixed package client export regression coverage for conditional `types` + `import` exports.
- Fixed SDK stream cleanup so early iterator termination cancels the underlying response reader.
- Fixed safe UTF-8 diff truncation when ANSI color output is enabled.
- Fixed draft queue persistence with atomic writes and cross-process leases.
- Fixed external editor command parsing so quoted editor commands do not require a shell.

### Phase 4 verification

- Clean TypeScript build: PASS.
- Full repository test suite: **161/161 PASS**, zero failures/skips/cancellations.
- Interactive CLI regressions for history, Vim, stash/queue, diff, details, palette, scrolling, reasoning, permissions, and undo/redo: PASS.
- HTTP API and client SDK tests including paged events, model/tool/agent discovery, prompt SSE, cancellation, and stream cleanup: PASS.
- Cross-process prompt queue, task cancellation, worker lifecycle, and scheduler tests: PASS.
- Real local OpenAI-compatible HTTP/SSE provider exercise through the runtime/router: PASS.
- Repository independence scan including generated `dist`: PASS; no prohibited external project names remain.
- `npm pack --dry-run`: PASS; package contains runtime, declarations, documentation, and no development test tree.
- Final extracted-archive build/test smoke check is required before release.

## 1.8.0 Phase 1 — plugin contract and compatibility layer (historical)

- Added the corresponding module for plugin manifest/package metadata types.
- Added the corresponding module for compatible `.claude-plugin/plugin.json` parsing plus native `.termagent-plugin/plugin.json` support.
- Added the corresponding module for metadata-only package discovery from project, user, and configured plugin roots.
- Legacy `.js`/`.mjs` plugin execution remains unchanged; manifest discovery never imports executable package files.
- Added plugin-root-relative path validation, duplicate component-path detection, metadata/identity checks, dependency identifier validation, and dual-manifest ambiguity rejection.
- Added `docs/PHASE8-PLUGIN-MARKETPLACE.md` and copied the complete research implementation plan to `PLUGIN-MARKETPLACE-IMPLEMENTATION-PLAN.md` so a future chat can resume from the same roadmap.

### Phase 1 brutal verification

- `npm run build`: PASS.
- Focused plugin manifest suite: PASS, 8/8 tests.
- Full repository suite: PASS, 200/200 tests.
- `npm pack --dry-run`: PASS, package contains the new compiled plugin manifest modules and phase documentation.
- CLI smoke: `node dist/index.js --version` => `1.8.0`; help output PASS.
- Source-hygiene scan over executable source/tests/config: PASS.
- Real package extraction smoke: PASS; extracted `dist/plugins/loader.js` successfully discovered and parsed a plugin manifest without executing a sibling `index.mjs`.
- Adversarial checks covered traversal, absolute/Windows paths, duplicate component paths, malformed identity/version/author metadata, dual manifest ambiguity, malformed package isolation, and non-execution during discovery.

## Historical resume point after Phase 1

The 1.8.0 Phase 1 checkpoint above is retained as historical context. The active baseline is now documented under the 1.9.0 Phase 2 section below.

## 1.9.0 Phase 2 — marketplace sources, cache, and installation

Phase 2 was implemented after a fresh implementation review of marketplace state, caching, and installation helpers and current the plugin system resolution/metadata patterns. The implementation is intentionally smaller and dependency-free for ARMv7/Termux.

### Implemented

- Added the corresponding module with marketplace/plugin source unions, manifest, persisted registration, installed-plugin, lifecycle-state, and progress types.
- Added the corresponding module with compatible marketplace validation, GitHub/git/URL/directory/file retrieval, shallow/recorded/sparse Git checkout, private persistent state, atomic JSON writes, refresh, removal, and reconciliation.
- Added the corresponding module with explicit third-party confirmation, local/remote Git plugin materialization, safe source-root containment, symlink rejection, manifest validation, content SHA-256, revision tracking, idempotent installation paths, update detection, remove, broken, and orphaned states.
- Kept npm/pip plugin sources catalog-visible for manifest compatibility but deferred their executable installation to the later dependency/update phase.
- Kept remote JavaScript execution out of the marketplace install path. The existing legacy `.js`/`.mjs` loader remains the only executable plugin compatibility path in this phase.
- Aligned storage with the rollout plan: marketplace registrations/cache under `~/.termagent/marketplaces/`, installed state/cache under `~/.termagent/plugins/`.
- Added `tests/plugin-marketplace-phase2.test.mjs` with 12 adversarial tests.

### Focused verification

- `npm run build` — PASS.
- `node --test --test-concurrency=1 tests/plugin-marketplace-phase2.test.mjs` — 12/12 PASS.
- `npm test` — 212/212 PASS.

### Phase 2 brutal verification

- `npm run build`: PASS.
- Focused marketplace/install suite: PASS, 12/12 tests.
- Full repository suite: PASS, 212/212 tests, zero failures/skips/cancellations.
- `node dist/index.js --version`: `1.9.0`.
- CLI help smoke: PASS.
- Source-hygiene scan over executable source/tests/config: PASS; no prohibited external-project references.
- `npm pack --dry-run`: PASS; package includes the compiled marketplace/install modules and phase documentation.
- Actual npm package extraction smoke: PASS; extracted CLI and marketplace API were loaded successfully.

### Resume point

TermAgent baseline is now `1.10.0`, Phase 1, Phase 2, and Phase 3 are complete. The next phase is Phase 4: explicit skill loading and agent discovery.
## 1.10.0 Phase 3 — skill catalog and descriptor index

Implemented the corresponding module and converted runtime/REPL/worker skill context to descriptor-only listings. The catalog discovers project/global skills, local plugin package skills, and installed marketplace plugin skills. Plugin IDs are namespaced as `<plugin>@<marketplace>:<skill>`. Realpath-based traversal prevents symlink cycles and ignores skills that resolve outside their configured root. Each index entry fingerprints resolved path + size + mtime + SHA-256 digest, with parsed frontmatter metadata and warnings retained only in `SkillDetails`.

The previous the corresponding module remains as a descriptor-only compatibility wrapper. Full `SKILL.md` bodies are no longer used for automatic prompt selection. The runtime no longer registers the old per-skill body-loading tool. Phase 4 remains responsible for `search_skills`, `use_skill`, `/skill`, and explicit/mid-turn skill loading.

### Phase 3 focused verification

- `npm run build`: PASS.
- Skill catalog suite: PASS, 13/13.
- Legacy skills regression updated for descriptor-only behavior: PASS, 1/1.

### Phase 3 release checkpoint

The implementation and focused tests are complete. Final release gating below records the complete verification before the Phase 4 handoff.
## 1.11.0 Phase 4 — explicit skill loading and agent discovery

Implemented the Phase 4 runtime on top of the 1.10.0 `SkillCatalog`. Added the corresponding module for deterministic thresholded descriptor search and the corresponding module for exact body loading with root containment and SHA-256 verification. Replaced the legacy skill tool surface with two shared tools: `search_skills` and `use_skill`.

The agent now performs turn-zero user-input discovery and mid-turn write-pivot/subagent-spawn rediscovery, updating the system prompt with descriptor metadata only. Explicit `/skill <id> [args]` invocation uses the same live loader and suppresses automatic rediscovery so the loaded `SKILL.md` cannot become a recursive search query. Plugin skill names use the Phase 3 namespace format. Search/load/skip decisions are persisted as `skill.search`, `skill.load`, and `skill.skip` session events. Full `use_skill` output bypasses generic tool-result summarization so loaded instructions remain intact.

A final hardening adjustment records `skill.skip` when a direct `/skill` invocation fails before loading, preserving a complete decision trail.

### Phase 4 focused verification

- Phase 4 skill discovery suite: PASS, 12/12.
- Full repository suite after the final Phase 4 code changes: PASS, 237/237.
- Clean TypeScript build: PASS.

### Phase 4 final release checkpoint

- Clean TypeScript build: PASS.
- Phase 4 focused skill-discovery tests: 12/12 PASS.
- Full repository suite after the final Phase 4 code and version changes: 237/237 PASS, zero failures/skips/cancellations.
- Release/source-hygiene hardening suite: 6/6 PASS.
- CLI version smoke: PASS, reports 1.11.0.
- npm pack dry-run: PASS, 197 package files.
- Actual npm package extraction: PASS.
- Extracted artifact API smoke: PASS for `SkillCatalog` search/invocation modules and the two shared skill tools.
- Final project archive integrity: PASS.

Phase 4 is complete. The next phase remains Phase 5 plugin component integration and is not started by this checkpoint.

## 1.12.0 Phase 5 — plugin component integration

Implemented the installed-plugin component activation layer on top of the 1.9 marketplace installation state. the corresponding module loads only durable `installed` records, verifies the package manifest name matches the installed-state identity, resolves component paths inside the installed-plugin root, and processes records in deterministic plugin-ID order. Commands and agents are merged with TermAgent's existing custom definition path and are namespaced to the plugin so identical filenames across marketplaces do not collide.

Plugin MCP servers are converted into TermAgent's existing stdio MCP configuration and retain plugin ID/name/marketplace/server provenance through `MCPClient` and into each generated tool. Declarative command hooks are loaded from `hooks/hooks.json` and manifest hook declarations, receive JSON context on stdin plus plugin-root/event environment variables, and run through the existing `PermissionGate`. A failing `PreToolUse` hook blocks the underlying tool; post-tool and lifecycle failures are isolated to hook status handling. Arbitrary JavaScript from marketplace packages is not imported, preserving the separate trust boundary for executable legacy plugins.

Additional hardening added before the final gate: manifest/state identity mismatch now blocks activation, and installed plugin iteration is deterministic regardless of JSON insertion order. Focused tests cover namespacing, executable-entrypoint non-import, MCP provenance, permission propagation, pre-tool blocking, command allowlists, agent disallow lists, sibling failure isolation, and manifest identity mismatch.

### Phase 5 focused verification

- Build: PASS.
- Phase 5 component suite: **12/12 PASS**.
- Full repository suite: **248/248 PASS**, zero failures/skips/cancellations.
- Release/source-hygiene hardening suite: **6/6 PASS**.

### Phase 5 final gate

The implementation remains declarative for marketplace plugins. Plugin dependency resolution/install ordering remains Phase 8; trust/integrity policy hardening remains Phase 7; manager UI and enable/disable flows remain Phase 6.
## 1.13.0 Phase 6 — plugin/marketplace TUI

Phase 6 is complete. The terminal UI is implemented as the corresponding module on top of the existing ANSI/VT `TerminalUI`. It provides `/plugins`, `/marketplace`, and `/skills` flows, bounded keyboard navigation, page-up/page-down, search, nested marketplace plugin details, trust/remove confirmations, enable/disable, mouse click/wheel input, and responsive 60x20 metadata compaction.

The UI is intentionally callback-driven: marketplace/plugin/skill persistence and component activation stay in the previously completed Phase 2-5 services. `TerminalUI.openPluginManager()` establishes modal ownership, disables editor focus, and restores raw-mode state on exit. The plugin manager input parser buffers split SGR/X10/CSI sequences so mouse packets cannot leak their numeric bytes into section switching or prompt input.

### Phase 6 focused verification

- 14/14 UI-focused regression tests passed.
- Covered list/detail rendering, 60x20 and 80x24 constraints, long-name clipping, pagination, search, plugin enable/disable, trust confirmation, remove cancellation, marketplace plugin selection, SGR/X10 mouse handling, mouse wheel movement, split escape-sequence buffering, and skill detail inspection.

### Screenshot QA

- `01-plugin-list-60x20.png`: plugin list/footer and long-name clipping.
- `02-plugin-detail-80x24.png`: revision/digest/component detail layout.
- `03-trust-confirm-60x20.png`: install trust confirmation at narrow width.
- `04-skill-detail-80x24.png`: skill provenance and SHA-256 detail.
- `05-marketplace-detail-80x24.png`: marketplace metadata and plugin browser.
- `06-marketplace-plugin-detail-80x24.png`: nested marketplace plugin detail.
- `07-marketplace-detail-60x20.png`: compact small-terminal marketplace layout after visual correction.
- `08-remove-confirm-60x20.png`: destructive-action confirmation at narrow width.

### Phase 6 final gate

- Build: PASS.
- Full repository suite: **263/263 PASS**.
- Release/source-hygiene suite: **6/6 PASS**.
- CLI version: **1.13.0**.
- Package dry-run and extracted-package API/CLI smoke: PASS.
- Final archive integrity: PASS.

Phase 7 followed this completed Phase 6 boundary.
### Phase 7 completed — trust, integrity, and supply-chain hardening

TermAgent 1.14 implements the security boundary planned for the plugin marketplace and skill systems. Plugin installs now carry deterministic content digests and Git revisions; remote marketplace caches are verified before use; reserved marketplace names are checked against exact official-source identity; trust approvals persist only for an exact source/digest/revision tuple; local blocklists and revocations are enforced at install and activation boundaries; installed components use realpath containment; and skills are scanned for hidden/role-injection/exfiltration/execution patterns before descriptor exposure and body loading.

The security policy is stored atomically under `~/.termagent/plugins/security.json` with private permissions. Policy corruption fails closed. The Phase 7 code intentionally does not add a remote security-feed dependency.

Focused Phase 7 adversarial coverage now includes 13 tests for reserved-name URL impersonation, hostile manifests, marketplace cache tampering, exact trust persistence/invalidation, installed digest tampering, source and installed-root symlink escapes, revocation/blocklists, skill Unicode/role/exfiltration/concealed-execution scanning, warning-only Unicode confusables, and corrupted security policy.

Release gate completed:

- `npm run build` — PASS.
- `npm test` — **276/276 PASS**.
- `tests/plugin-security-phase7.test.mjs` — **13/13 PASS**.
- `tests/phase4-release-hardening.test.mjs` — **6/6 PASS**.
- `node dist/index.js --version` — `1.14.0`.
- `npm pack --dry-run` — PASS; final package contains 219 files.
- Extracted npm package CLI/security API smoke — PASS.
- Source-hygiene scan — PASS.
- Final ZIP integrity and extracted-release smoke — PASS.

## 1.15.0 Phase 8 — dependency resolution, updates, and reconciliation

Phase 8 adds the plugin lifecycle layer. the corresponding module performs deterministic metadata-only dependency resolution, preserving dependency-first install order, detecting cycles and missing dependencies, qualifying bare references against their declaring marketplace, and blocking cross-marketplace dependencies unless the root marketplace explicitly allowlists the destination. the corresponding module serializes lifecycle mutations and treats multi-plugin installation as a transaction, restoring the previous installation metadata snapshot and removing only paths introduced by the failed transaction.

the corresponding module runs before component discovery at startup. It removes abandoned marketplace/plugin staging directories, re-evaluates installed records against current marketplace entries and on-disk content, preserves explicit orphaned state for deleted marketplace entries, and marks enabled plugins with unsatisfied dependencies as broken. `update-available` remains an active pending-replacement state so current commands/agents/MCP/hooks/skills do not disappear before the replacement is installed.

the corresponding module refreshes only marketplaces with auto-update enabled and then updates enabled plugins in deterministic marketplace/plugin-ID order. Official the the marketplace implementation names use the established safe default policy; third-party marketplaces default to off. `TERMAGENT_AUTO_UPDATE=0|false|off|no` disables the background updater globally.

### Phase 8 focused verification

- Phase 8 lifecycle suite: **12/12 PASS**.
- Coverage includes deterministic dependency order, cycles, missing dependencies, root-scoped cross-marketplace allowlists, transactional rollback, concurrent installs, pending-update activation, orphan/dependency reconciliation, stale stored revisions, interrupted staging cleanup, marketplace auto-update configuration, local update application, and global auto-update disablement.

### Phase 8 final release gate

- `npm run build` — PASS.
- `npm test` — **288/288 PASS**, zero failures/skips/cancellations.
- `tests/phase4-release-hardening.test.mjs` — **6/6 PASS**.
- `node dist/index.js --version` — `1.15.0`.
- `npm pack --dry-run` — PASS; package contains **225 files**.
- Actual npm package extraction — PASS; extracted CLI reports `1.15.0`; dependency resolver module imports successfully; Phase 8 documentation is present.
- Source-hygiene scan — PASS; no `node_modules` tree or package entries.

Phase 8 is complete. Phase 9 remains untouched.

## 1.16.0 Phase 9 — context-budget and performance optimization

Phase 9 is complete. Context budgeting now reserves explicit space for tool schemas, project instructions, repository context, skill descriptors, and explicitly loaded skill bodies. Tool schemas are compacted deterministically before provider requests, while catastrophically oversized single definitions fail before execution. Per-round workflow notices are also fitted into the remaining request budget.

Skill indexing is now metadata-first on warm builds: unchanged files reuse previously parsed descriptors/security findings/digests without re-reading `SKILL.md`. Concurrent catalog loads share one in-flight build, catalog generations drive deterministic search-cache invalidation, and project/search caches are bounded to protect long-lived Termux processes. The CLI no longer eagerly scans the complete skill catalog at startup; `/skills` loads it on demand. No remote prefetch was introduced.

Model-facing `use_skill` output is bounded with head/tail preservation, while direct `loadSkill()` still returns the exact full body after live digest/security verification. The existing tool registry now caches rendered raw schemas until a tool is added/replaced.

### Phase 9 performance fixtures

- 10 skills: cold ≈ 11.1 ms, warm ≈ 2.7 ms.
- 100 skills: cold ≈ 28.6 ms, warm ≈ 15.8 ms.
- 1,000 skills: cold ≈ 229.8 ms, warm ≈ 129.9 ms.
- 300 plugin packages: discovery completed without errors in well under the 10 s fixture ceiling.
- Low-memory run: Phase 9 suite passed with Node `--max-old-space-size=64`.

### Phase 9 focused verification

- Phase 9 context/performance suite: **10/10 PASS**.
- Full repository suite: **298/298 PASS**.
- Low-memory Phase 9 suite: **10/10 PASS**.
- Release/source-hygiene suite: **6/6 PASS**.

### Phase 9 final release gate

- `npm run build` — PASS.
- `npm test` — **298/298 PASS**, zero failures/skips/cancellations.
- `node dist/index.js --version` — `1.16.0`.
- `npm pack --dry-run` — PASS; package contains **226 files**.
- Actual npm package extraction/smoke — PASS; extracted CLI reports `1.16.0`; catalog module loads and exposes Phase 9 stats.
- Final ZIP integrity/extracted-release smoke — PASS after final archive creation.

Phase 9 completes the context/performance boundary. Phase 10 remains untouched.

## 1.17.0 Phase 10 — pure skill registry support

Phase 10 implementation is complete in the current workspace.

### Implemented

- Added the corresponding module with a transport-independent `SkillRegistryProvider` contract and the production HTTP provider.
- Added registry state, installed-skill state, trust approvals, revocations, registry/skill caches, stale-state tracking, and atomic persistence under `~/.termagent/skill-registries/`.
- Added array-root and object-root registry parsing, strict namespace/name/version/trust/digest validation, relative remote source resolution, bounded remote reads, timeout handling, HTTPS enforcement, localhost HTTP fixtures, and redirected-response revalidation.
- Added exact SHA-256 verification for registry metadata and `SKILL.md` content, plus frontmatter name/version identity checks.
- Added offline last-known-good registry caching with stale metadata detection and explicit `allowStale` installation override.
- Added persistent exact-match trust approval and revocation state, including fail-closed revocation fetch behavior when no known-good cache exists.
- Added pure-skill installation that does not touch plugin installation state or executable plugin permissions.
- Added symlink/root containment protection for cache and installed skill paths and live verification before invocation.
- Added `registry` provenance to the shared `SkillCatalog` and live registry revocation/digest/security checks in the corresponding module.
- Added `/skill-registry` and `/skills` registry-management commands.
- Reused the existing module so remote registry skills are scanned with the same content-security boundary used by local and plugin skills.
- Updated the registry catalog warm path to reuse prior indexed registry descriptors when file metadata is unchanged.
- Added 17 focused Phase 10 regression tests covering transport, parsing, integrity, trust, revocation, stale/offline behavior, cache tampering, symlink containment, path-state tampering, redirect validation, and remote size limits.

Phase 10 is not considered complete until the documentation, full suite, build, package dry-run, source-hygiene scan, and extracted release smoke tests below all pass.

### Phase 10 final release gate

- `npm run build` — PASS.
- `npm test` — **315/315 PASS**, zero failures/skips/cancellations.
- `tests/skill-registry-phase10.test.mjs` — **17/17 PASS**.
- `tests/phase4-release-hardening.test.mjs` — **6/6 PASS**.
- `node dist/index.js --version` — `1.17.0`.
- `npm pack --dry-run` — PASS; package contains **229 files**.
- Actual npm package extraction/smoke — PASS; extracted CLI reports `1.17.0`, public registry provider/installation exports load, and Phase 10 documentation is present.
- Source-hygiene scan — PASS; no `node_modules` tree in the release workspace.
- Final ZIP integrity and extracted-release smoke — PASS after final archive creation.

Phase 10 completes the pure-skill registry boundary. Phase 11 remains untouched.
## 1.18.0 Phase 11 — release hardening and migration

Phase 11 implementation is complete. Legacy project/global skill roots and `.termagent/plugins` are adopted in place, while legacy configuration aliases are migrated into canonical `plugins` and `skillPaths` fields. Project/global configs are backed up before edits, migration state is stored atomically in `~/.termagent/migrations.json`, and repeated startup runs are idempotent.

`/doctor` and `termagent --doctor` now expose structured health checks for environment, configuration, migration state, marketplaces, plugin lifecycle/security state, pure skill registry health, skill catalog health, and storage permissions. `--json` emits the same report for automation. Doctor reports malformed migration state as an error without crashing the command.

Phase 11 adds full authoring documentation and checked-in examples, plus an isolated E2E lifecycle covering marketplace/plugin install, enablement, discovery, invocation, update, disablement, and removal. A release-surface regression suite also checks global config migration, configured skill-path discovery, doctor JSON, diagnostics on corrupted migration state, and authoring fixtures.

The phase is complete only after the final build, focused suite, full repository suite, release hardening suite, package dry-run, source-hygiene scan, actual npm extraction/smoke, final ZIP integrity check, and independent extracted-release smoke all pass. Phase 12 remains untouched.

## 1.18.0 Phase 13M-P3 — semantic no-progress detection

Phase 13M-P3 is complete at the subphase level. the corresponding module now projects cumulative semantic repository/execution state instead of deriving progress from tool-result text or transport references. The projection covers exploration discovery/read coverage/searches/symbols, Todo state, mutation evidence, task lifecycle state, and autonomous workflow state, then canonicalizes and SHA-256 hashes that projection.

The semantic projection intentionally excludes `tool-output://` references, managed output paths, call/turn IDs, generated Todo/task/child-session IDs, timestamps, and workflow loop counters. Equivalent searches are collapsed by semantic query/path/result evidence instead of raw tool arguments. Restored `ExplorationState` coverage is authoritative across Agent turn boundaries even though `FileReadStateCache` is recreated per run, so a fresh process cannot manufacture progress by rereading already-covered ranges.

The agent recomputes the semantic fingerprint after every provider/tool round. A changed fingerprint counts as meaningful progress; an unchanged fingerprint enters the existing semantic loop guard. Raw identical-call and prolonged read-only guards remain independent backstops.

### Phase 13M-P3 verification

- `tests/agent/phase13m-p3-semantic-progress.test.mjs` — **6/6 PASS**.
- Combined Agent/P2/P3 regression — **32/32 PASS**.
- Full Phase 13 A-L + P2 + P3 suite — **151/151 PASS**.
- `npm run build` — **PASS**.
- Generated JavaScript syntax — **124/124 PASS**.
- `npm pack --dry-run` — **PASS** with `TERM=xterm` in the non-TTY verification environment.

The repository-wide `npm test` aggregate still does not reach a clean completion. The latest run timed out after reaching test 364 and exposed eight pre-existing/unrelated failures in `/auto` E2E, Phase 12F resize, Phase 2 context/tool-budget tests, a Phase 13F diff test, client SDK contract, and the source external-name hygiene test. Those failures are retained as separate rollout-gate work and are not being counted as P3 failures.

Detailed implementation and design and implementation notes are in `docs/research/PHASE13M-P3-SEMANTIC-PROGRESS.md`.

## Phase 13M-P4 — Exploration intervention policy

- Added a three-stage semantic exploration intervention ladder: first no-progress round produces a strategy-change nudge, the second constrains the redundant exploration action on the next model turn, and the third stops the exploration subtask with a bounded evidence summary.
- Reused the existing `ToolLoopGuard` rather than adding a parallel loop detector. Constrained exploration identity is semantic for `read_file`, `grep`, `glob`, and `repo_map`, so cosmetic probe/output arguments cannot bypass the intervention while legitimate ranges and queries remain available.
- Intervention notices remain transient model-context messages and are not persisted as session history. Meaningful semantic progress clears previous constraints.
- Added bounded specialized-agent configuration through `TERMAGENT_SEMANTIC_NUDGE_THRESHOLD`, `TERMAGENT_SEMANTIC_CONSTRAIN_THRESHOLD`, and `TERMAGENT_SEMANTIC_LOOP_THRESHOLD`; semantic stop thresholds are capped at 12.
- Added focused P4 tests covering escalation, reset, legitimate alternative ranges/searches, bounded configuration, bounded/evidence-rich messages, real Agent enforcement, and transient-notice persistence behavior.
- Verification: Phase 13A-L + P2 + P3 + P4 focused tests 177/177; frozen UI/PTy regression 45/45; production TypeScript build PASS; generated production JavaScript syntax 125/125 PASS; `npm pack --dry-run` PASS.
- Repository-wide `npm test` remains a gate blocker because the aggregate run still encounters previously known failures in `/auto`, Phase 12F resize, multiple Phase 2 context tests, and Phase 13F diff behavior and then times out before completing the complete suite. P4 is therefore implementation-complete but not phase-gate-complete.
## 1.18.0 Phase 13M-P5 — exploration routing and agent guidance

Phase 13M-P5 adds an adaptive exploration-guidance layer instead of another discovery subsystem. the corresponding module infers a qualitative thoroughness level and selects intent-appropriate tool preferences across `repo_map`, `glob`, `grep`, and `read_file`. Explore system prompts now receive the actual user prompt, so the routing reflects the requested investigation rather than only project instructions.

The guidance preserves the distinct discovery/search/read responsibilities, adds TermAgent's independent-call parallelization guidance, and explicitly directs the agent to continue from uncovered read ranges, follow truncated-result continuation, switch strategy on no-progress, and avoid duplicated delegated searches. Build mode also receives bounded subagent/delegation guidance when specialized task tools are available; Explore remains read-only. No fixed discovery sequence or fixed call count is enforced.

### Phase 13M-P5 verification

- `tests/agent/phase13m-p5-exploration-routing.test.mjs` — **4/4 PASS**.
- Combined P2 + P3 + P4 + P5 suite — **18/18 PASS**.
- Selected Phase 13A-L + P2-P5 regression set — **86/86 PASS**.
- `npm run build` — **PASS**.

Repository-wide `npm test` remains a separate rollout-gate blocker because the aggregate suite still contains unrelated failures and timeout behavior documented by the Phase 13 hardening reports.
## 1.18.0 Phase 13M-P6 — exploration efficiency telemetry

Phase 13M-P6 adds runtime-derived `ExplorationTelemetry` without introducing a second tracing or session-state system. The telemetry reuses P2 `ExplorationObservation` evidence and the P4 semantic exploration-action identity, recording tool calls, useful calls, semantically repeated calls, overlapping reads, cumulative newly discovered files, newly covered range segments, novel searches, tool-bearing rounds, no-progress rounds, and categorized termination reason.

Telemetry is emitted through an internal `Agent.run()` callback and is intentionally not persisted into `SessionStore`. Tool attempts are counted exactly once at settlement, including constrained/rejected actions; assistant-only final response rounds do not count as exploration rounds. Read observations now expose an explicit overlap flag computed from requested range versus previous coverage.

A deterministic `tests/fixtures/phase13m-p6-crypto-33-call.json` workload contains 33 potential tool calls over a 1,372-line `crypto.py`: five useful range reads followed by syntactically varied rereads. The Agent regression confirms semantic termination before the potential-call workload is exhausted and records the expected telemetry. A second forty-read Explore regression confirms legitimate long exploration remains governed by semantic progress rather than a fixed call ceiling.

### Phase 13M-P6 verification

- `tests/agent/phase13m-p6-exploration-telemetry.test.mjs` — **3/3 PASS**.
- Selected Phase 13/P2-P6 agent regression set — **PASS**.
- `npm run build` — **PASS**.
- Generated JavaScript syntax checks — **PASS**.
- `npm pack --dry-run` — **PASS**.

The complete repository rollout gate remains separate and continues to inherit previously documented unrelated failures/timeouts. P7 and the final 13M gate remain pending.

## 1.19.0 Phase 13M-P7 — client/runtime protocol preparation

Phase 13M-P7 establishes the stable protocol seam required for the future Web View and VS Code clients. the corresponding module now owns versioned renderer-neutral event and command envelopes, durable/live event classification, independent durable-sequence semantics, command idempotency and stale-state guards, permission/question wire-state models with first-writer-wins resolution semantics, and reconnect/reconciliation contracts. The protocol is transport-neutral and has no HTTP, SSE, browser, or VS Code dependency.

The public package now exposes `./protocol` so future clients can consume the same contract without importing runtime or presentation modules. Phase 14 remains responsible for assigning and persisting durable sequences, implementing the runtime event bus, migrating HTTP/SSE routes to canonical commands/events, and building the browser client.
## Phase 13M — final verification and rollout gate

The historical Phase 13M completion result is **REOPENED as of 2026-09-30**. A real Build-mode `crypto.py` session contradicted the earlier end-to-end claim: semantic intervention did not visibly intervene before the legacy exact-repeat backstop, while the Explore-mode trace progressed through uncovered ranges normally.

The revalidation hardened the existing architecture rather than replacing it. the corresponding module no longer uses tool lifecycle bookkeeping as semantic progress evidence; failed/constrained tools do not mutate `ExplorationState`; and partial version metadata cannot erase already-known read coverage. The deterministic Build regression now terminates before the historical 19-read sequence is exhausted, and the forced-compaction/fresh-Agent regression preserves authoritative coverage across checkpoint restore.

Current evidence:
- Production TypeScript build — **PASS**.
- Targeted Agent/P4/P6 regression set — **29/29 PASS**.
- New 13M hardening regressions — **4/4 PASS**.
- Repository-wide independent test-file verification — **65 PASS, 9 FAIL across 74 files**. All nine failing files reproduce against the untouched Phase 14A baseline and are retained as separate pre-existing gate work.
- Aggregate `npm test` — **not a passing gate**; the multi-file runner again failed to terminate under the verification harness.
- Physical ARMv7/Termux execution — unavailable on the current x86_64 host.

Full current evidence is recorded in `docs/research/PHASE13M-HARDENING-REVALIDATION.md`. Phase 14 Web View work remains behind the reopened exploration gate.

### 2026-09-30 13M revalidation note

The Phase 14A implementation remains in the repository, but the next Web View/multi-client phase must not be treated as the active priority while the reopened exploration gate is unresolved. See `docs/research/PHASE13M-HARDENING-REVALIDATION.md`.

## 1.19.0 Phase 14A — canonical event log and interaction model

Phase 14A is complete. TermAgent now persists public event metadata (`eventId`, protocol version, category, kind, durable flag, and monotonic sequence) with each new session event. `SessionStore` serializes cross-process sequence assignment with its existing state lease and exposes durable-event pages keyed by sequence rather than JSONL offsets. Legacy records without explicit metadata remain readable through deterministic compatibility projection.

the corresponding module is the stable renderer-neutral contract for durable/live event envelopes, command envelopes, command idempotency fingerprints, expected sequence/revision guards, permission/question state, first-writer-wins resolution, and reconnect/reconciliation planning. the corresponding module provides deterministic duplicate-command admission and durable command receipts.

Permission/question requests are reconstructible from session events and survive process restart. Concurrent resolution is first-writer-wins and later resolution attempts converge on the authoritative stored result. The Web View preparation explicitly leaves high-frequency deltas, activity, heartbeats, and connection state live-only.

A robustness pass also added trailing JSONL recovery: a genuinely incomplete final write is truncated before the next durable append, while newline-terminated corruption is rejected rather than silently discarded.

### Phase 14A verification

- `tests/phase14a-event-interaction.test.mjs` — **13/13 PASS**.
- `npm run build` — **PASS**.
- Cross-process sequence assignment — **PASS**.
- Cross-process duplicate command admission — **PASS**.
- Legacy sequence compatibility — **PASS**.
- Live-only envelope validation/factory — **PASS**.
- Incomplete-tail repair and corrupt-tail fail-closed behavior — **PASS**.
- `CommandLedger` duplicate, semantic-conflict, and stale-command behavior — **PASS**.
- Permission/question reconstruction and first-writer-wins resolution — **PASS**.

Detailed implementation notes are in `docs/research/PHASE14A-CANONICAL-EVENT-INTERACTION.md`. Phase 14B remains intentionally unstarted; the current HTTP/SSE polling implementation is preserved until the runtime event publisher/subscriber boundary is implemented.

## 1.19.0 Phase 13N-A — pre-execution semantic read gate

Phase 13N-A closes the remaining semantic-read execution gap uncovered by the reopened Phase 13M Build-mode trace. `FileReadStateCache.lookup()` now exposes an explicit `already-covered` classification for fully covered non-exact ranges while preserving exact `unchanged`, post-compaction `rehydrated`, partial `overlap`, and fresh/miss behavior.

The `read_file` builtin returns the already-covered result before invoking the content-reading stream, and file text/binary inspection is delayed until actual content access is necessary. Cache coverage is now derived only from complete source segments, an ephemeral context-visible coverage union distinguishes redundant reads from legitimate rehydration after compaction, and durable read-state projections exclude incomplete segments. Cosmetic arguments therefore cannot turn an already-covered semantic range back into a filesystem read.

A related context-budget edge exposed by the new cheaper cache results was also hardened without changing the existing compaction architecture: `maybeCompact()` can reserve additional request overhead, request construction rechecks the final bounded request, and token truncation reserves its marker budget.

#
## Phase 13N-C — Production exploration guidance wiring

Status: `[verified]` at the focused implementation/regression level.

Implemented the existing the corresponding module through the authoritative `Agent.run()` request path instead of leaving it as an unused helper. Guidance is bounded before insertion, recomputed from the live user prompt and current exploration evidence, and updated with the no-progress streak. It explicitly encourages batching independent read/search calls, continuing from uncovered ranges, and changing strategy after no new semantic evidence while preserving adaptive rather than ceremonial routing.

Verification: production TypeScript build passes; the dedicated 13N-C guidance suite passes 3/3. The broader repository aggregate test runner remains a separate known gate and is not represented as green by this phase.

Roadmap status tags are now explicit (`[ ]`, `[impl]`, `[test]`, `[verified]`, `[blocked]`); a phase gate can remain REOPENED even when individual subclaims are verified.

## Phase 13N-A verification

- `npm run build` — **PASS**.
- New 13N-A read-gate suite — **7/7 PASS**.
- Phase 13M-P4 intervention suite — **6/6 PASS**.
- Phase 13B read-state suite — **14/14 PASS**.
- Phase 13M hardening suite — **4/4 PASS**.
- Combined focused regression set — **31/31 PASS**.
- Physical ARMv7/Termux execution remains unavailable on the current x86_64 verification host.
- Repository-wide aggregate `npm test` remains a separate known gate issue because of pre-existing failures and process-lifecycle timeout behavior documented in the Phase 13M revalidation report.

The implementation details and exact semantics are recorded in `docs/research/PHASE13N-A-READ-GATE.md`. The next TODO item is 13N-B, evidence-based exploration progress.
## 1.19.0 Phase 13N-B — evidence-based exploration progress

13N-B converts exploration observations into explicit evidence deltas while preserving the existing `ExplorationState`/`ToolLoopGuard` architecture. Read observations distinguish newly covered ranges from already-known coverage and from post-compaction rehydration; rehydration is visible as reconstructed evidence but does not reset semantic no-progress detection. `grep`, `glob`, and `repo_map` deduplicate discovered files, symbols, and search result keys before counting them as progress. Settled verification metadata can contribute a stable semantic fact, with verification command text hashed so sensitive literals are not retained in the semantic state.

The P6 telemetry projection now exposes the additional evidence dimensions `reconstructedEvidence`, `novelSearchResults`, `newSymbols`, and `settledVerificationFacts` while preserving the older efficiency counters. Cosmetic grep arguments continue to collapse to the same semantic call identity, so they cannot manufacture repeat/progress evidence.

### Phase 13N-B verification

- `npm run build` — **PASS**.
- `tests/agent/phase13n-b-evidence-progress.test.mjs` — **6/6 PASS**.
- Combined Phase 13M hardening/P4/P6 + 13N-A/B focused set — **26/26 PASS**.
- Aggregate `npm test` remains a separate known repository-level gate issue.
- Physical ARMv7/Termux execution remains unavailable on the current x86_64 verification host.

Detailed evidence and source boundaries are recorded in `docs/research/PHASE13N-B-EVIDENCE-PROGRESS.md`. The next TODO item is 13N-C, production exploration-guidance wiring.

## 2026-10-01 — Phase 13N-D verification ledger

Implemented 13N-D on top of the existing TaskManager, managed-shell, lifecycle, workflow, ExplorationState, and SessionStore infrastructure. `verify_project` now has explicit settled verification states, bounded previews, durable task output references, and a `force` escape hatch for explicit reruns. Successful configured mutations can trigger one automatic verification per mutation batch; a later same-batch `verify_project` call is served from the successful automatic result unless `force=true`.

Added the derived `EvidenceLedger` projection with bounded files/searches/symbols/verifications/mutations/tasks/workflow state. Ledger fingerprints deliberately ignore lifecycle IDs, task IDs, output paths, output sizes, truncation flags, and other presentation/runtime identities. The ledger is persisted inside `ContextMachineState` checkpoints while SessionStore and TaskManager remain authoritative.

The new durable verification event maps to `session.verification.completed` with category `verification`. Automatic verification results are also fed into `ExplorationState` as settled semantic evidence and into workflow observation.

Verification: `npm run build` PASS; dedicated 13N-D suite 9/9 PASS; combined 13M/P4/P6 + 13N-A/B/C/D focused suite 38/38 PASS. Repository-wide `npm test` remains a known non-terminating/legacy gate, and ARMv7/Termux hardware is unavailable on the x86_64 verification host.
## 2026-10-02 — Phase 13N-E LSP verification correctness

Implemented the LSP diagnostic truth model on top of the existing evidence/verification architecture. the corresponding module models `unknown`, `running`, `provisional`, `clean`, `failed`, `timed_out`, and `cancelled`; coalesces repeated publications by retaining the latest bounded diagnostic set; requires quiescence before settlement; and applies a minimum settle window specifically to empty diagnostic publications so an early zero-result notification cannot be presented as clean.

The tracker exposes a bounded verification record and a semantic fingerprint that ignores publication timing/count lifecycle churn. `EvidenceLedger` now carries bounded LSP state, and lifecycle metadata with `lspDiagnostics` is normalized automatically. Provisional states are deliberately excluded from `ExplorationState` semantic progress; terminal LSP states become stable verification facts. Machine-context rendering includes the LSP count only when non-zero, avoiding unnecessary context-budget pressure.

The implementation uses a diagnostic registry/coalescing path with explicit quiescence and budget rules. It does not add a new language-server process manager in this phase; that remains deferred to the dedicated LSP/code-intelligence capability phase.

Verification: `npm run build` PASS; dedicated 13N-E suite 12/12 PASS; combined Phase 13M/13N focused regression set 78/79 PASS with the single 13B tiny-budget compaction test reproducing unchanged against the 13N-D baseline. Aggregate `npm test` remains a separate repository-level runner gate, and physical ARMv7/Termux execution remains unavailable on the x86_64 verification host.

## Phase 13N-F — Provider reliability

- Provider HTTP failures now retain status, response headers, bounded response body, and parsed `Retry-After` information.
- Retry backoff now observes cancellation and accepts deterministic jitter injection for regression fixtures.
- SSE provider streams now have a bounded idle watchdog; pre-output stalls may retry, while post-output stalls fail closed to avoid duplicate visible responses.
- Provider-specific reasoning parameters remain isolated to the OpenAI-compatible, Anthropic, and Gemini adapters.
- Opaque provider tool metadata remains round-trip safe through the durable lifecycle/session path.
- Status callbacks surface stalled-provider state through the existing terminal activity mechanism.
- Phase 13N-F dedicated suite: **9/9 PASS**.
- Combined focused Phase 13M/P4/P6/P7 + 13N-A/B/C/D/E/F + provider-adapter gate: **67/67 PASS**.
- `npm run build`: **PASS**.
## Phase 13N-G — Specialist sub-agent hardening

Status: `[verified]` at the specialist delegation contract level.

Implemented named specialist roles (`general`, `researcher`, `planner`, `coder`, `reviewer`, `tester`) with role-scoped tool allowlists, explicit read-only/restricted-shell policies, inherited parent workspace scopes, centrally bounded concurrency, explicit delegation depth, recursive parent-task cancellation, durable parentTaskId linkage, and estimated token-usage accounting. Specialist reports are bounded for parent context while full worker output remains in the durable task output store.

Verification: 5/5 phase-specific tests pass; 140/142 broader focused 13M/13N-adjacent tests pass. The two remaining failures reproduce as pre-existing expectation mismatches in Phase 13B and Phase 13L and are not caused by 13N-G.

## 2026-10-02 — Phase 13N-H checkpoint/branch UX

Implemented checkpoint/branch UX on top of the existing SessionStore and SnapshotStore rather than creating a second session model. Manual checkpoints now persist an immutable message projection, SHA-256 message hash, source sequence, workspace snapshot ID, label, and model/provider metadata. Checkpoint snapshots are retained during normal turn-snapshot cleanup.

Restore is a durable state transition: it refuses to run during an active turn, restores the checkpoint workspace snapshot, appends a `checkpoint.restore` event containing the immutable message projection, and causes subsequent session loads to treat pre-restore messages/context checkpoints as abandoned history. Branch-from-checkpoint creates a new session linked to the source session/checkpoint, copies semantic conversation state only, does not copy mutable UI/render buffers, and can optionally restore the checkpoint workspace.

Checkpoint references support exact IDs, unique prefixes, and the `#N` index shown by `/checkpoints`. The terminal exposes `/checkpoints`, `/checkpoint`, `/restore`, `/branch <checkpoint-id> [--restore]`, and `/fork checkpoint <checkpoint-id>`. The authenticated HTTP API exposes checkpoint list/create/restore/branch routes. Older metadata-only checkpoints remain listable but fail closed for restore/branch because they do not contain a trustworthy immutable message/workspace target.

### Phase 13N-H verification

- `npm run build` — **PASS**.
- `tests/phase13n-h-checkpoints.test.mjs` — **8/8 PASS**.
- Combined focused checkpoint/provider/specialist/compaction/task/protocol/server set — **59/59 PASS**.
- HTTP checkpoint create/list/branch/restore coverage — **PASS**.
- Aggregate repository `npm test` remains a separate blocked gate: the run reached 478 passing tests before hanging in the existing provider-manager long-lived process test.
- Two older expectation mismatches also remain documented outside the H scope: the 13B tiny-budget compaction expectation and the legacy 13L timeout expectation.
- Physical ARMv7/Termux execution remains unavailable on the verification host.
## 2026-10-03 — Phase 13N-I provider text-tool-call recovery

A Termux screenshot and trace exposed a provider compatibility failure: after the semantic loop guard blocked a repeated `read_file` call, the provider emitted the next tool request as XML-like assistant text. The UI therefore showed `<tool_call>...</tool_call>` instead of executing a tool or ending with clean user-facing text.

The fix is intentionally narrow. Native structured tool events remain canonical. A streaming gate suppresses candidate XML protocol blocks, `recoverTextToolCalls()` recognizes only the supported dialect, verifies that the function is currently offered, coerces parameter values, and feeds the resulting call into the normal Agent/tool lifecycle. Final tool-disabled steps may suppress the markup but never execute it. Unknown or malformed functions are not executed.

Verification: `npm run build` PASS; focused compatibility + agent/UI regression selection **70/70 PASS**; generated JavaScript syntax PASS. The repository-wide aggregate runner remains non-terminating because of the documented provider-manager long-lived test process.

Detailed notes: `docs/research/PHASE13N-I-TEXT-TOOL-CALL-COMPAT.md`.

## 2026-10-03 — Phase 13N-I reconciled semantic UI, visual system, queue and mobile pass

Rebased the final 13N-I work onto the authoritative `TermAgent-1.18.0-Phase13N-I-Complete-Visual-System-HUD.zip` snapshot after discovering that the previously supplied source archive was stale. The richer visual system from that snapshot was preserved; the missing Markdown table, queue, composer, live-input, user-surface, and protocol projection work was merged selectively.

The semantic Markdown renderer now handles real tables without ANSI-string guessing. Headers, separator alignment, empty cells, escaped pipes, Unicode display width, inline formatting, wrapping, compact grids, and mobile cards are represented before terminal painting. Declared column alignment is preserved for headers and body cells.

Prompt submission now remains live while an agent turn runs. The runtime-owned `SessionPromptQueue` persists queue transitions as session events, supports editing/cancellation/reordering, keeps executing work non-editable, gives numeric queue commands a queued-only interpretation, and recovers stale `executing` entries after a process restart. Queue rendering exposes running work separately from editable pending prompts, and the same row geometry is used for touch targets.

The composer is a semantic, responsive surface rather than a disabled input rectangle. It carries agent state, provider/model, context usage, tool count, queue count and actionable hints while the underlying `PromptEditor` remains active. User messages now have their own transcript surface. Session-changing operations that could invalidate an in-flight turn are blocked until that turn finishes.

### Phase 13N-I verification

- `npm run build` — **PASS**.
- Reconciled focused UI/UX gate — **129/129 PASS**.
- Current Markdown regression test — **4/4 PASS**.
- Phase 12F deterministic visual snapshots — **PASS**.
- Mobile sanity views at 60×24 and 40×20 — **PASS**.
- The repository-wide aggregate runner remains a separate blocked gate because the existing provider-manager long-lived process does not terminate. No partial aggregate pass count is treated as a green result.
- Physical ARMv7/Termux execution remains the 13N-J rollout gate.

Detailed notes: `docs/research/PHASE13N-I-SEMANTIC-UI-VISUAL-SYSTEM.md`.

## 13N-J-A — Mobile process lifecycle hardening

Started from the repaired 13N-I tree and adapted the existing durable `TaskManager` / managed-shell runtime using the recorded process-group and bounded-process patterns. Added reusable POSIX process-group signalling/escalation and timed child-stdin writes, cleaned up descendant groups after foreground shell completion, kept explicitly backgrounded tasks cancellable, and made shell previews obey their UTF-8 byte budget including truncation markers.

Verification: `npm run build` PASS; combined 13N-J-A + 13E + 13I process/task gate **32/32 PASS**. Physical ARMv7/Termux execution remains open on the x86_64 host. Release engineering is deferred to 13N-J-B.
## 2026-10-03 — Phase 13N-J-B Android/ARMv7 release engineering

Added explicit release target metadata for `android-armv7`, `android-arm64`, `linux-armv7`, `linux-arm64`, and `linux-x64`; deterministic target-labeled bundle generation; `release-manifest.json`; `SHA256SUMS`; and a prebuilt-first Termux-aware installer with source-build fallback. Because TermAgent has no native runtime addon, the application bundle remains JavaScript and the target labels describe runtime/installer compatibility rather than a native TermAgent binary.

Verification: `npm run build` PASS; release tests 10/10 PASS; combined 13N-J-A + 13N-I/provider/specialist/checkpoint gate 75/75 PASS; generated JavaScript syntax 145/145 PASS; `npm pack --dry-run` PASS; deterministic multi-target release bundles and SHA-256 manifest generation PASS; workflow YAML and installer syntax PASS. Physical Termux/ARMv7 smoke remains the final 13N-J platform gate.
