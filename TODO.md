# TermAgent TODO

TermAgent implementation and capability roadmap. This plan follows the current architecture while preserving TermAgent's zero-dependency runtime foundation and Node/ANSI/VT portability. Mobile/Termux is a deployment target, not a feature ceiling. Full, mature capabilities should be adopted when their engineering value justifies them.

## Roadmap status semantics

Active roadmap entries use explicit status tags instead of a binary checkbox:

- `[ ]` planned or not started.
- `[impl]` implementation is present in the repository, but required verification is incomplete or the behavior is not yet established end-to-end.
- `[test]` automated regression coverage exists for the item, but the verification gate is not fully closed.
- `[verified]` the implementation and the relevant recorded verification evidence currently support the item.
- `[blocked]` current evidence contradicts the requirement, a required environment is unavailable, or a known gate prevents closure.

A phase-level `REOPENED` or `BLOCKED` status is authoritative for the phase gate. Individual `[verified]` entries mean only that those specific subclaims have supporting evidence; they do not imply that the surrounding phase is complete. Legacy `[x]` markers have been normalized to these explicit statuses.
## Phase 1 — Plugin contract and compatibility layer

- [verified] Define a validated plugin manifest contract compatible with the `.claude-plugin/plugin.json` shape.
- [verified] Support TermAgent's native `.termagent-plugin/plugin.json` alias without changing the compatible layout.
- [verified] Discover plugin package manifests without executing package code.
- [verified] Validate plugin names, versions, metadata, dependencies, and component paths.
- [verified] Enforce plugin-root-relative component paths and reject traversal/absolute paths.
- [verified] Preserve legacy local `.js`/`.mjs` plugin loading unchanged.
- [verified] Add focused manifest/package discovery tests and adversarial path/schema cases.
- [verified] Document the contract, compatibility rules, and next-phase boundaries.
- [verified] Run the full brutal verification gate: build, full test suite, package dry-run, source hygiene, and extracted-archive smoke.

## Phase 2 — Marketplace sources, cache, and installation

- [verified] Implement marketplace manifest schemas and persistent marketplace registrations.
- [verified] Support GitHub, git, URL, directory, and file marketplace sources.
- [verified] Add shallow/recorded/sparse checkout where applicable to reduce Termux data use.
- [verified] Add marketplace cache and refresh/reconciliation state.
- [verified] Add plugin installation metadata with source/revision/digest tracking.
- [verified] Add install/update/remove/orphaned/broken states.
- [verified] Add marketplace trust/source validation and explicit third-party install confirmation.
- [verified] Brutal-test network failures, corrupted manifests, path escapes, stale caches, and partial installs.

## Phase 3 — Skill catalog and descriptor index

- [verified] Replace body-based prompt selection with `SkillDescriptor` metadata.
- [verified] Discover project, global, and plugin-provided `SKILL.md` files.
- [verified] Build a local deterministic skill index with invalidation by path/mtime/size/digest.
- [verified] Namespace plugin skills to avoid collisions.
- [verified] Keep full skill bodies out of the base system prompt.
- [verified] Add descriptor listing and skill details surfaces.
- [verified] Brutal-test duplicate names, precedence, malformed frontmatter, symlinks, and large skill sets.

## Phase 4 — Explicit skill loading and agent discovery

- [verified] Add one shared `search_skills` tool.
- [verified] Add one shared `use_skill` tool.
- [verified] Make model-facing skill discovery descriptor-only until explicit load.
- [verified] Support explicit `/skill` invocation and namespaced plugin skills.
- [verified] Add deterministic relevance scoring with a minimum threshold instead of always returning top-N.
- [verified] Add mid-turn rediscovery signals: user input, write pivot, subagent spawn, and explicit discovery.
- [verified] Record skill search/load/skip decisions in session events.
- [verified] Brutal-test ambiguous prompts, no-match prompts, repeated discovery, and skill-loading loops.

## Phase 5 — Plugin component integration

- [verified] Integrate plugin commands with the existing custom-command system.
- [verified] Integrate plugin agents with the existing custom-agent system.
- [verified] Integrate plugin MCP servers with the existing MCP client and preserve provenance.
- [verified] Add declarative plugin hooks on top of existing lifecycle/permission infrastructure.
- [verified] Keep arbitrary executable plugin code as explicit local-only compatibility until a separate trust model exists.
- [verified] Brutal-test component collisions, deterministic activation ordering, failed component load, and permission propagation.

## Phase 6 — Plugin/marketplace TUI

- [verified] Add `/plugins` manager with installed/enabled/disabled/broken/update states.
- [verified] Add `/marketplace` browser with marketplace selection, search, plugin details, install, and trust confirmation.
- [verified] Add `/skills` browser with search, details, source, and plugin provenance.
- [verified] Preserve TermAgent's current modal input ownership and ANSI/VT renderer.
- [verified] Add compact component counts, source/revision display, and failure details.
- [verified] Brutal-test 60x20 and 80x24 layouts, long names, pagination, keyboard navigation, touch/mouse interaction, and cancellation.

## Phase 7 — Trust, integrity, and supply-chain hardening

- [verified] Add SHA-256/plugin revision verification and cached-integrity checks.
- [verified] Add marketplace reserved-name/source validation.
- [verified] Add plugin trust state and explicit approval persistence.
- [verified] Add skill-content linting for suspicious hidden Unicode, role-injection markers, secret-exfiltration patterns, and concealed execution instructions.
- [verified] Add revocation/blocklist support.
- [verified] Add safe realpath/root containment checks for every installed component.
- [verified] Brutal-test hostile manifests, symlinks, Unicode confusables, malicious URLs, and revoked content.

## Phase 8 — Dependency resolution, updates, and reconciliation

- [verified] Resolve plugin dependencies and allowed cross-marketplace dependencies.
- [verified] Add deterministic install/update ordering.
- [verified] Reconcile declared vs installed state on startup.
- [verified] Handle deleted marketplace entries, orphaned plugins, and interrupted installs.
- [verified] Add configurable auto-update behavior with safe defaults.
- [verified] Brutal-test dependency cycles, partial updates, stale revisions, concurrent changes, and rollback behavior.

## Phase 9 — Context-budget and performance optimization

- [verified] Account for skill descriptors and discovery results in the existing context budget.
- [verified] Bound loaded skill bodies and tool schemas before provider requests.
- [verified] Cache descriptor/index work between turns.
- [verified] Prefetch only where it reduces latency without excessive mobile-data cost.
- [verified] Add performance fixtures for 10/100/1000 skills and large plugin catalogs.
- [verified] Brutal-test low-memory/slow-storage conditions and context pressure.

## Phase 10 — Pure Skill Registry support

- [verified] Define a registry provider interface separate from full plugin packages.
- [verified] Support a lightweight `registry.json` + `SKILL.md` distribution format.
- [verified] Add trust/revocation metadata for remote skills.
- [verified] Allow remote skills to be installed without granting executable plugin permissions.
- [verified] Keep the plugin marketplace and pure skill registry as distinct distribution layers.
- [verified] Brutal-test remote skill fetch failure, stale metadata, digest mismatch, and offline cache behavior.

## Phase 11 — Release hardening and migration

- [verified] Add migration for existing `.termagent/skills`, `.claude/skills`, `.termagent/plugins`, and config entries.
- [verified] Add `/doctor` diagnostics for marketplace/plugin/skill state.
- [verified] Add full documentation and examples for plugin authors and skill authors.
- [verified] Add end-to-end fixtures covering install → enable → discover → use → update → disable → remove.
- [verified] Run complete release verification on every phase and before every version bump.
- [verified] Validate the extracted release artifact independently from the workspace.

## Phase 12 — UI/UX freeze before feature parity

This phase is intentionally UI/UX-only. Provider, model, tool, and other feature-parity work must not reopen the presentation architecture after Phase 12 is frozen. Follow `TermAgent-UI-UX-Research-Plan.md` as the source of truth.

### 12A — Research and comparison

- [verified] Inspect the current TermAgent transcript, picker, diff, permission, question, Todo, dialog, focus, resize, and renderer behavior.
- [verified] Inspect the corresponding the implementation and reusable primitives.
- [verified] Inspect the corresponding the implementation and reusable primitives.
- [verified] Run a full current-vs-existing UI model/UX comparison and record independently discovered issues.
- [verified] Freeze exact command-picker geometry: bounded width, outer padding, row padding, fixed command-name column, description gap, footer, and height budgeting.
- [verified] Define the shared diff surface contract for transcript, `Ctrl+O`, and permission preview.
- [verified] Define the compact permission/question dock contract.
- [verified] Define transcript identity rules removing repeated `You`/`TermAgent` labels.

### 12B — Transcript and picker

- [verified] Remove `◆ You` and `◆ TermAgent` from normal transcript rendering without replacing them with another repeated speaker badge.
- [verified] Preserve the existing user left-border/panel semantics while making content the primary identity cue.
- [verified] Rebuild the command picker around the frozen 60-column bounded layout where space permits.
- [verified] Use a fixed **24-column command-name cell** and a **2-column name/description gap** for terminals at or above 56 columns.
- [verified] Use the stacked command/description fallback below 56 columns.
- [verified] Keep picker selection global so moving down past visible item 8 never jumps to item 1 unless the true end of the list is reached.
- [verified] Make visible picker rows height-aware.
- [verified] Remove ad-hoc description budgeting that subtracts non-rendered query/footer widths.
- [verified] Add deterministic picker snapshots at 40/48/56/60/64/80/120 columns.

**12B verification:** 339/339 full tests passed; production TypeScript build passed; all 107 generated production `.js` files passed `node --check`; focused Phase 12B picker/transcript/input/hardening tests passed; deterministic snapshots cover 40/48/56/60/64/80/120 columns.

### 12C — Shared diff system

- [verified] Replace the current primitive diff presentation with one shared renderer/model contract.
- [verified] Render real edit diffs inline in the main transcript.
- [verified] Render real apply-patch diffs inline in the main transcript.
- [verified] Make unified/split selection width-aware.
- [verified] Add line numbers, semantic backgrounds, syntax-aware content, and added/removed markers.
- [verified] Add explicit empty/clean, binary, untracked, large, and truncated states across the shared diff surface and its consumers.
- [verified] Rebuild `Ctrl+O` diff inspection around the shared diff renderer.
- [verified] Support list → detail → previous/next file navigation without a second diff implementation.
- [verified] Reuse the same diff renderer for permission edit previews.

**12C verification:** 352/352 full tests passed; production TypeScript build passed; all 107 generated production `.js` files passed `node --check`; focused diff/UI suite passed 32/32; package dry-run passed; CLI `--version` and `--help` passed; deterministic main and `Ctrl+O` diff visual snapshots were inspected at 90 and 140 columns.

### 12D — Compact permission/question interaction

- [verified] Convert permission requests from the current blocking/full-screen path into a compact dock above the prompt.
- [verified] Keep the conversation transcript visible while permission is pending.
- [verified] Keep permission dock input ownership explicit and prevent prompt leakage.
- [verified] Convert question requests into the same dock architecture.
- [verified] Keep question navigation/selection local to the dock.
- [verified] Ensure Escape/Enter ownership is deterministic for picker → dock → prompt transitions.
- [verified] Add permission/question PTY-style regression coverage with active-agent and resize scenarios.

**12D verification:** 358/358 full tests passed; production TypeScript build passed; all 107 generated production `.js` files passed `node --check`; focused Phase 12C + 12D diff/dock suite passed 24/24; CLI `--version` and `--help` passed; `npm pack --dry-run` passed; compact 80x20 and 48x20 dock/composer scenarios passed; permission/question visual QA snapshots were inspected.

### 12E — Todo and interaction consistency

- [verified] Keep completed Todo history persistent but hide the active Todo surface when no item is pending/in progress.
- [verified] Use one status vocabulary across Todo, tool rows, activity, and completion states.
- [verified] Centralize geometry calculations so border/padding width is counted exactly once.
- [verified] Ensure ANSI16, ANSI256, truecolor, and plain output have identical geometry.
- [verified] Ensure mouse filtering cannot move a picker selection through synthetic layout events.
- [verified] Ensure terminal clicks never interrupt an active agent turn unless the user explicitly cancels it.

**12E verification:** 365/365 full tests passed with forced exit; production TypeScript build passed; all 109 generated production `.js` files passed `node --check`; focused 12E/UI regression suite passed 26/26; `npm pack --dry-run`, CLI `--version`, CLI `--help`, and `--doctor --json` passed; deterministic 80x20/48x16 picker, shared diff, permission dock, and status visual QA snapshots were rendered and inspected; the supplied ANSI Shadow banner-font fix was applied in TypeScript with rectangular six-row word geometry.

### 12F — Responsive hardening and visual freeze

- [verified] Test 40x20, 48x20, 56x20, 60x24, 64x24, 80x24, 100x30, 120x30, and 160x40 layouts.
- [verified] Test resize while picker, diff, permission, question, and inspector surfaces are active.
- [verified] Test long command names, long descriptions, long paths, huge outputs, and 100+ changed files.
- [verified] Add deterministic visual snapshots for startup, transcript, picker, inline diff, diff inspector, permission dock, question dock, and narrow fallbacks.
- [verified] Add focus/ownership regression tests for every transient surface.
- [verified] Run the complete build, full regression suite, PTY suite, and clean extracted-artifact smoke test.
- [verified] Freeze the UI primitives and geometry contract before resuming feature parity.

**12F verification:** 391/391 regression tests passed across 47 test files using isolated per-file processes; focused 12F UI + PTY tests passed 26/26; production TypeScript build passed; all 109 generated production `.js` files passed `node --check`; deterministic visual snapshots passed; `npm pack --dry-run` passed; CLI `--version`, `--help`, and `--doctor --json` passed; source-hygiene scan passed. The production PTY helper now closes the renderer before exiting, preventing stale TTY handles from leaking into later regression files. A long-path regression was added to the 12F UI suite.

### Phase 12 gate

Phase 12 is complete. Implementation, focused UI tests, PTY tests, visual snapshots, full regression, build, package verification, source hygiene, and extracted-artifact smoke all pass. UI primitives and geometry are frozen; feature parity may resume only against this frozen UI contract.

## Phase 13 — tool/runtime capability and context correctness

This phase resumes feature parity after the Phase 12 UI freeze. Implementations must follow the documented interaction model state models and contracts, adapting them to TermAgent's existing runtime rather than inventing duplicate subsystems. TermAgent is a general-purpose coding-agent platform; mobile/Termux is a deployment target and portability requirement, not a capability ceiling. The zero-dependency foundation remains an architectural advantage, not a reason to omit high-value capabilities.

### 13A — Tool/runtime audit baseline

- [verified] Create a machine-readable inventory of every TermAgent built-in, plugin, MCP, skill, task, question, permission, and orchestration tool.
- [verified] For each tool, record existing implementation contract, existing implementation contract, input/output schema, permission point, cancellation, concurrency, persistence, context cost, and known TermAgent gap.
- [verified] Classify every gap as critical, high, medium, or intentional TermAgent-specific behavior.
- [verified] Add regression fixtures for every current tool before changing behavior.
- [verified] Keep the parity matrix and implementation decisions in `docs/PHASE13-TOOL-PARITY.md`.

**13A status:** Complete. Baseline artifacts and contract fixtures are in place; the historical aggregate test-runner stall remains separately documented rather than being treated as a feature failure.

### 13B — Read tool: stateful, bounded, coverage-aware reading

- [verified] Add a session-scoped `ReadFileState` cache modeled on TermAgent's read-state/cache pattern.
- [verified] Track canonical path, file metadata, requested ranges, normalized content, partial/full-read state, and last use.
- [verified] Use bounded cache eviction without treating mobile as the design ceiling.
- [verified] Detect exact duplicate reads and return compact cache/unchanged information instead of replaying identical content.
- [verified] Detect overlapping reads and expose existing coverage so the model can continue from uncovered ranges.
- [verified] Return structured line/range/continuation metadata.
- [verified] Enforce byte/line caps independently of requested range.
- [verified] Preserve useful bounded evidence rather than blindly retaining only a prefix.
- [verified] Detect binary files/unsupported encodings before misleading text output.
- [verified] Warm/invalidate relevant caches after writes and edits.
- [verified] Preserve relevant read state through compaction.
- [verified] Add tests for identical, overlapping, changed, partial, full, large, binary, Unicode, and CRLF reads.

**13B status:** Complete. The read-state subsystem is now the basis for future semantic exploration coverage tracking.

### 13C — Write/Edit: stale-state safety and structured mutations

- [verified] Require fresh read evidence for existing-file mutation.
- [verified] Reject writes when the file changed after the read and require a reread.
- [verified] Use atomic/write-if-unchanged mutation semantics.
- [verified] Preserve BOM and line-ending behavior where appropriate.
- [verified] Separate path resolution/containment from mutation and preserve external-directory approval.
- [verified] Preserve exact-match edit semantics with structured replacement counts and diff metadata.
- [verified] Reject empty `oldText`, identical replacements, and ambiguous matches.
- [verified] Support optional `replaceAll` without weakening the default safety rule.
- [verified] Record mutation metadata suitable for undo/review/future LSP integration.
- [verified] Correctly invalidate/seed read state after mutation.
- [verified] Add concurrency, stale-write, BOM, CRLF, permission, diff, and partial-failure tests.

**13C status:** Complete.

### 13D — Search and filesystem discovery

- [verified] Use one shared bounded filesystem-search subsystem for `grep`, `glob`, directory listing, and repository discovery.
- [verified] Prefer ripgrep when available and preserve deterministic Node fallback semantics.
- [verified] Use regex-aware grep semantics.
- [verified] Return structured result/pagination/truncation metadata.
- [verified] Centralize ignored-path and hidden-directory policy.
- [verified] Enforce root/scope containment consistently.
- [verified] Deterministically sort result order by normalized path/line/text before pagination.
- [verified] Test empty, small, large, Unicode, regex, ignored, symlink, and narrow-scope searches.

**13D status:** Complete.

### 13E — Shell/Git execution

- [verified] Use durable structured command execution with task identity, cwd, timeout, exit status, cancellation, and output metadata.
- [verified] Parse likely affected paths/sensitive operations before execution.
- [verified] Retain complete output out-of-band and expose bounded previews.
- [verified] Promote long-running work to background tasks when appropriate.
- [verified] Detect likely interactive commands and fail/transition explicitly.
- [verified] Terminate process trees on cancellation.
- [verified] Distinguish timeout, cancellation, non-zero exit, and signal termination.
- [verified] Preserve argument-aware Git mutation policy and fail closed when classification is uncertain.
- [verified] Add comprehensive execution regression tests.

**13E/13F status:** Complete and verified through the Phase 13 tool parity work.

### 13F — Tool output storage and context budgeting

- [verified] Persist oversized tool output in managed storage with deterministic retention.
- [verified] Keep bounded model previews plus stable retrieval references.
- [verified] Bound by bytes and lines, not only JS string size.
- [verified] Preserve structured metadata and attachments independently from text previews.
- [verified] Make reconstruction idempotent by tool-call identity.
- [verified] Allow deliberate retrieval through `read_file`.
- [verified] Count schemas, calls, results, summaries, skills, and system notices in one context-budget model.
- [verified] Add large-output fixtures that do not trigger avoidable full-session compaction.

**13F status:** Complete.

### 13G — Tool-call lifecycle and provider-turn settlement

- [verified] Durably record tool calls before side effects.
- [verified] Execute local calls through the canonical ToolRegistry path.
- [verified] Persist typed success/failure/provider-executed outcomes.
- [verified] Settle all local tool calls before continuing the provider turn.
- [verified] Preserve tool provenance and provider metadata.
- [verified] Normalize interruption/decline/failure behavior into explicit lifecycle outcomes.
- [verified] Preserve existing provider-stream ordering and incremental publication behavior.
- [verified] Add lifecycle tests for parallel calls, failure, cancellation, provider errors, and incomplete results.

**13G status:** Complete.

### 13H — Compaction/context state

- [verified] Keep durable transcript unchanged while maintaining a bounded active projection.
- [verified] Preserve system instructions and whole recent turns atomically.
- [verified] Preserve tool/task/question/skill state required for continuation.
- [verified] Maintain projection/checkpoint hashes and compaction epochs.
- [verified] Rehydrate relevant state after compaction without re-reading all historical output.
- [verified] Add regression coverage for repeated compaction and context pressure.

**13H status:** Complete.

### 13I — Tasks/subagents/background execution

- [verified] Make task state durable and recoverable.
- [verified] Track child-session linkage, output references, lifecycle, notifications, resume/send-message queues, and scope conflicts.
- [verified] Preserve parent/child cancellation and permission inheritance rules.
- [verified] Keep completion notifications compact and retrieve full output deliberately.
- [verified] Prevent recursive unbounded task spawning by default.
- [verified] Add foreground/background/cancel/timeout/recovery/result retrieval tests.

**13I status:** Complete.

### 13J — Todo, Question, Skill, and workflow tools

- [verified] Make Todo session-owned and durable with structured old/new state.
- [verified] Keep completed history while removing inactive Todo UI from live context.
- [verified] Preserve deterministic verification nudges.
- [verified] Use stable question IDs, structured multi-question requests, answer/reject/cancel states, and durable replay.
- [verified] Keep skills descriptor-first and on-demand, with bounded content and security checks.
- [verified] Keep workflow/verification state separate from ordinary tool text.

**13J status:** Complete.

### 13K — Tool permissions, schemas, and registry architecture

- [verified] Make tool definitions typed/structured with input/output metadata, permissions, read-only/concurrency flags, and provenance.
- [verified] Validate arguments before execution.
- [verified] Make registry selection agent/mode/workflow/context aware.
- [verified] Separate local, plugin, MCP, and provider-hosted tools.
- [verified] Preserve tool provenance through session persistence.
- [verified] Keep permission evaluation resource-aware and external-directory-aware.
- [verified] Add registry/schema/permission/provenance tests.

**13K status:** Complete.

### 13L — Capability gaps and TermAgent-specific replacements

- [verified] Implement established style `apply_patch` with add/update/delete hunks, preflight validation, conditional mutation, batch permission, and explicit partial-failure reporting.
- [verified] Evaluate the implementation `batch` and record the selected-revision result rather than inventing an unavailable core tool.
- [verified] Evaluate the language-server integration and the language-server integration; record the architecture required for a real implementation instead of a fake shim.
- [verified] Evaluate webfetch/websearch as first-class network capabilities rather than permanently excluding them by deployment assumptions.
- [verified] Evaluate the implementation NotebookEdit and record the structured notebook subsystem it would require.
- [verified] Keep `repo_map` as a bounded structural view that complements search/read primitives.
- [verified] Move `verify_project` execution/result handling onto durable TaskManager infrastructure.

**13L status:** Complete. `apply_patch`, permission batching, durable verification, and registry integration are implemented. The selected baseline has no core `batch` or LSP tool; these remain capability candidates rather than missing hacks. TermAgent's richer LSP/NotebookEdit and network features remain candidates for future parity/recovery phases, not discarded because of mobile.

---

# Phase 13M-Preflight — Agent exploration and runtime hardening

This is a required hardening phase inserted before the Phase 13 rollout gate. It exists because the observed 33-tool-call `crypto.py` exploration session exposed a real gap between correct tools and efficient agent behavior.

### 13M-P1 — Canonical tool-call identity

- [verified] Replace raw `JSON.stringify(input)` identity checks with recursively canonicalized input serialization.
- [verified] Ensure object key order cannot create distinct repeat signatures.
- [verified] Normalize only semantically irrelevant representation differences; preserve meaningful values, ranges, paths, and selectors.
- [verified] Include tool name and execution scope in the canonical identity.
- [verified] Exclude ephemeral call IDs, managed output references, timestamps, and renderer-only metadata from repeat identity.
- [verified] Add direct regressions for reordered keys, equivalent defaults, array order where order is semantic, and distinct ranges.

**13M-P1 status:** Complete. the corresponding module now builds recursive stable JSON identities, `ToolLoopGuard` uses the canonical identity with SHA-256, and the agent includes workspace execution scope (`cwd` + scope paths). Focused agent/Phase 13 regression tests pass 159/159; production TypeScript build and all 122 generated JavaScript syntax checks pass; `npm pack --dry-run` includes the new canonical module. The repository-wide suite still reports unrelated failures outside P1 in this verification run; those are not in the changed P1 paths and are not being silently folded into this task.

### 13M-P2 — Read coverage and semantic exploration state

- [verified] Connect existing `ReadFileState`/`FileReadStateCache` evidence to agent-level exploration progress.
- [verified] Record requested range, previously covered ranges, newly covered ranges, and full-coverage status.
- [verified] Detect overlap that yields zero new information.
- [verified] Keep file metadata/version identity so changes invalidate old coverage.
- [verified] Add a structured `ExplorationState` model for discovered files, searches, read coverage, symbols, and meaningful progress.
- [verified] Keep exploration state derived/reconstructible rather than making it a replacement for durable session truth.

**13M-P2 status:** Implemented. `FileReadStateCache` now publishes structured read-coverage evidence to the agent; `ExplorationState` tracks bounded discovered files, read coverage, search novelty, symbols, file versions, and meaningful exploration progress; checkpoint restore reconstructs the derived projection. Focused P2 tests pass 6/6, Phase 13 + P2 integration tests pass 145/145, and the production TypeScript build passes. The final 13M gate later exercised every repository test file in isolation; see `docs/research/PHASE13M-HARDENING-REVALIDATION.md` for the aggregate-runner environment exception. Detailed design rationale and semantics are recorded in `docs/research/PHASE13M-P2-EXPLORATION-STATE.md`.

### 13M-P3 — Semantic no-progress detection

- [verified] Replace output-text/reference-based no-progress identity with a structured progress fingerprint.
- [verified] Track meaningful changes in discovered files, searched queries, read coverage, symbols, mutations, task state, and workflow state.
- [verified] Ensure `tool-output://` references and generated IDs cannot manufacture apparent progress.
- [verified] Make the detector cross-turn and cross-provider-message rather than only current-message local.
- [verified] Add regression scenarios with different syntactic calls producing identical semantic coverage.

**13M-P3 status:** Implementation present; end-to-end gate REOPENED on 2026-09-30. The Build-mode production trace showed that lifecycle-record churn could still manufacture apparent semantic progress after otherwise equivalent reads. The hardening patch removes tool lifecycle records from the semantic fingerprint and adds a direct regression proving different lifecycle IDs/timestamps/output references hash identically when semantic state is unchanged. Current focused hardening coverage passes 4/4 and the production build passes.

### 13M-P4 — Exploration intervention policy

- [verified] On first consecutive semantic no-progress action, emit a precise strategy-change nudge.
- [verified] On the second, reject or constrain the redundant action and recommend a different tool/range.
- [verified] On the third consecutive no-progress action, end the exploration subtask with an explicit reason and collected evidence.
- [verified] Keep the existing global loop guard as an emergency backstop rather than the primary detector.
- [verified] Make thresholds configurable for specialized agents without permitting unbounded values by default.

**13M-P4 status:** Implementation present; end-to-end gate REOPENED on 2026-09-30. The nudge → constrain → stop policy is now exercised by the Build-mode regression. The hardening pass also keeps constrained/failed reads out of `ExplorationState`, because a refusal or execution error is control flow rather than repository evidence. The dedicated intervention tests pass, the hardening regression passes 4/4, and the production build passes.

### 13M-P5 — Exploration routing and agent guidance

- [verified] Strengthen the dedicated Explore agent instructions to prefer `repo_map` for structure when useful, Glob for file-pattern discovery, Grep for content/symbol search, and Read for known paths/ranges.
- [verified] Tell agents to parallelize independent reads/searches where the caller can safely do so.
- [verified] Tell agents to continue from uncovered ranges instead of rereading covered ranges.
- [verified] Tell agents to switch strategy when no new information is gained.
- [verified] Use specialized subagents for broad exploration when that materially improves context efficiency.
- [verified] Keep routing adaptive; do not force a ceremonial repo_map → glob → grep → read sequence on every task.

**13M-P5 status:** `[verified]` production wiring completed in 13N-C. the corresponding module now serves as the authoritative model-facing routing helper for Explore turns and subsequent evidence-tracked rounds. Focused guidance tests and the production build pass. Runtime read/loop enforcement remains authoritative over advisory guidance.

### 13M-P6 — Exploration efficiency telemetry

- [verified] Record internal metrics for tool calls, useful calls, repeated calls, overlapping calls, new files, new ranges, search novelty, and termination reason.
- [verified] Reproduce the 33-call-shaped `crypto.py` exploration workload as an automated fixture.
- [verified] Establish a deterministic target that the reproduction terminates after useful exploration rather than exhausting the global read-only limit.
- [verified] Do not optimize toward a fixed call count if legitimate large-repository tasks require more work; measure semantic progress instead.

**13M-P6 status:** Implementation present; end-to-end gate REOPENED on 2026-09-30. Telemetry remains the runtime evidence layer, and the Build-mode regression now publishes semantic termination plus no-progress counts. The previous production failure means telemetry alone cannot be treated as proof of correctness. Current telemetry and hardening tests pass; full gate disposition is recorded in `docs/research/PHASE13M-HARDENING-REVALIDATION.md`.

### 13M-P7 — Client/runtime preparation for Web View

- [verified] Define canonical renderer-neutral `EventEnvelope` and `CommandEnvelope` schemas in the corresponding module.
- [verified] Define durable versus live-only event classification.
- [verified] Define monotonic durable event sequencing independent of JSONL array offsets.
- [verified] Define command idempotency and expected-sequence/expected-revision semantics.
- [verified] Define authoritative permission/question request state and first-writer-wins resolution.
- [verified] Define reconnect semantics based on durable event sequence plus authoritative snapshot reconciliation.
- [verified] Keep these as architecture/protocol preparation only; do not build the browser UI in this phase.

**13M-P7 status:** Complete at the preparation level. Added the dependency-free the corresponding module contract with validated `EventEnvelope`/`CommandEnvelope` schemas, known durable/live event classifications, independent durable-sequence helpers, command idempotency/fingerprint semantics, stale-state guards, permission/question first-writer-wins wire-state models, and reconnect/snapshot planning. The public `./protocol` package export is now reserved for future browser and VS Code clients. Browser UI, durable SessionStore sequencing, event-bus replay/tail, and HTTP route migration remain intentionally deferred to Phase 14.

### 13M gate

- [verified] Re-run the exact repeated-read fixture across multiple sessions and after compaction.
- [verified] Confirm reordered JSON arguments produce the same repeat identity.
- [verified] Confirm managed output references cannot make semantic fingerprints differ.
- [verified] Confirm legitimate overlapping reads with uncovered lines continue successfully.
- [verified] Confirm a legitimate long exploration task is not incorrectly terminated.
- [test] Build and run the affected runtime/client/protocol regression set.

**13M-Preflight gate status:** REOPENED on 2026-09-30. Dedicated component tests pass, but the Build-mode production trace invalidated the previous end-to-end completion claim. The current hardening evidence and remaining exceptions are recorded in `docs/research/PHASE13M-HARDENING-REVALIDATION.md`.

---

# Phase 13M — Verification and rollout gate

Phase 13M is intentionally separate from 13M-Preflight. Do not start this gate until 13M-Preflight is complete.

### 13M-A — Full parity matrix

- [verified] Run every Phase 13 tool contract against its focused fixtures.
- [verified] Verify built-in, plugin, MCP, provider-hosted, task, skill, question, permission, and workflow paths.
- [verified] Verify provenance, persistence, cancellation, permission, and context-budget contracts.

### 13M-B — Pathological context workloads

- [test] Reproduce the 1,372-line `crypto.py` exploration and verify semantic completion without redundant read loops; current focused fixtures exist, but the real Build-mode environment still needs revalidation.
- [verified] Test repositories from tiny to very large, with overlapping ranges and mixed tool strategies.
- [verified] Exercise repeated compaction, tool-output retrieval, long reasoning, background tasks, and context pressure.
- [verified] Include 10/50/100/500 tool-call scenarios.
- [verified] Include command outputs around 1 MB, 10 MB, and 100 MB with deterministic bounded projections.

### 13M-C — Deterministic replay and recovery

- [verified] Feed identical provider/tool streams into fresh sessions and compare durable projections.
- [verified] Verify event ordering, turn ordering, tool-call identity, task state, question/permission state, and compaction metadata.
- [verified] Test interrupted processes, partial JSONL writes, stale locks, task recovery, and session recovery.
- [verified] Verify replay does not depend on ephemeral tool-output references.

### 13M-D — Interruption boundaries

- [verified] Interrupt before tool execution.
- [verified] Interrupt during tool execution.
- [verified] Interrupt after tool completion but before continuation.
- [verified] Interrupt during provider streaming.
- [verified] Interrupt during compaction.
- [verified] Interrupt during background task settlement.
- [verified] Verify every interrupted state remains reconstructible and does not present false success.

### 13M-E — Runtime/package/release verification

- [verified] Run production build.
- [verified] Run focused Phase 13 tests.
- [blocked] Run complete regression suite; the aggregate runner remains non-terminating and the isolated baseline still has known failures.
- [verified] Run PTY/UI regression suite.
- [verified] Run `npm pack --dry-run` and inspect the package manifest.
- [verified] Run generated JavaScript syntax checks.
- [verified] Run source-hygiene/security scans.
- [verified] Extract the package/release artifact into a clean directory and repeat essential checks.
- [blocked] Verify supported Node/Termux/ARMv7 behavior; portability remains a requirement, not a feature ceiling. Physical ARMv7 hardware execution is unavailable on the current x86_64 verification host.

### 13M-F — Phase 13 completion gate

- [verified] Parity matrix complete.
- [verified] Repeated-read fixture passes.
- [verified] Deterministic replay passes.
- [verified] Interruption/recovery passes.
- [verified] Package/extracted-artifact checks pass.
- [blocked] No unresolved critical/high regression remains without an explicit documented disposition; the reopened exploration/platform gate is still active.

**Phase 13 completion rule:** Do not mark Phase 13 complete until every gate above passes or an explicit exception is documented in the phase report.

**13M rollout gate status:** REOPENED on 2026-09-30. A real Build-mode session contradicted the prior end-to-end completion claim: semantic intervention did not visibly intervene before the legacy exact-repeat backstop. The current patch fixes the observed lifecycle/progress and failed-tool evidence boundaries and adds an end-to-end Build regression plus compaction/restore coverage. Repository-wide per-file verification currently has 65 passing files and 9 pre-existing failing files reproduced against the untouched Phase 14A baseline; the aggregate `npm test` runner still does not terminate reliably. Physical ARMv7 execution remains unavailable on the x86_64 verification host. Full current evidence is in `docs/research/PHASE13M-HARDENING-REVALIDATION.md`.

**Phase 13 status:** REOPENED for 13M end-to-end hardening. Phase 14/Web work remains on hold until the exploration gate is closed again.

---

## 2026-09-30 — Production regression revalidation

The historical 13M completion claim is reopened by a real Build-mode session trace. The earlier Explore-mode trace remains evidence that coverage-aware reading can progress correctly; the two modes must not be treated as one identical failure.

### Behavioral evidence

- Build-mode session: 182 events, 56 tool-call records, repeated `crypto.py` reads, repeated context compactions, and no visible semantic nudge/constrain/stop before the legacy exact-repeat backstop blocked an identical call.
- Explore-mode session: 61 events and monotonic `crypto.py` coverage progression through previously missing ranges. An overlapping request was useful when it contained uncovered lines.

### Root cause identified in TermAgent

1. the corresponding module included tool lifecycle records in the semantic fingerprint. New call/turn/output-reference/timestamp values could therefore look like semantic progress even when exploration state did not change.
2. the corresponding module could feed failed/blocked tool settlements into exploration observation. A refusal is execution control flow, not new repository evidence.
3. the corresponding module treated a partially populated version record as a replacement for complete version evidence, allowing missing fields to disturb previously known coverage.

### Current hardening

- Semantic fingerprints now derive semantic exploration progress from durable domain state rather than lifecycle bookkeeping.
- Failed or constrained tools no longer mutate `ExplorationState`.
- Version changes are detected only from version fields actually present in the new observation, so incomplete metadata cannot erase valid coverage.
- Existing nudge → constrain → stop behavior remains authoritative, with semantic action constraints checked before tool execution.
- A deterministic Build-mode fixture based on the historical `crypto.py` read sequence verifies termination before the historical 19-read sequence is exhausted.
- A forced-compaction regression verifies coverage survives checkpoint persistence and is authoritative after a fresh `Agent` instance is restored.

### Verification evidence

- Production TypeScript build: PASS.
- Targeted Agent/P4/P6 regressions: 29/29 PASS.
- New 13M hardening regressions: 4/4 PASS.
- Repository-wide independent test-file run: 65 PASS, 9 FAIL across 74 test files. All 9 failures reproduce against the untouched `TermAgent-1.18.0-Phase14A.zip` baseline and are outside the changed exploration paths.
- Aggregate `npm test`: still subject to the repository's known non-termination behavior; this is not counted as a passing aggregate gate.
- ARMv7/Termux hardware execution: unavailable on the current x86_64 verification host.

### Gate disposition

The exploration machinery is hardened against the observed Build-mode failure, but Phase 13M is intentionally **REOPENED** until the current behavior is re-run in the real Termux/ARMv7 environment and the remaining repository baseline failures are separately disposed of. Phase 14 Web View work stays behind this gate.
# Phase 13N — the implementation-informed hardening and capability improvements

A complete review of the implementation `0.10.0`  surfaced several practical patterns worth adapting. These are additions to the existing TermAgent architecture, not a replacement implementation. Full notes: `docs/research/TERMAGENT-DESIGN-IDEAS.md`.

### 13N-A — Pre-execution semantic read gate

- [verified] Fix the corresponding module so a fully covered non-exact `read_file` request cannot fall through to a real filesystem read when `FileReadStateCache.lookup()` reports complete coverage.
- [verified] Preserve exact-cache hits, rehydration after compaction, overlap reads with uncovered ranges, and legitimate rereads after file-version drift.
- [verified] Add explicit classification for already-covered ranges where the existing cache result is insufficiently descriptive.
- [verified] Ensure cosmetic arguments cannot bypass the semantic read gate.
- [verified] Add end-to-end tests for `1-100 → 1-50`, `1-100 → 51-100`, `1-100 → 25-75`, and `1-100 → 51-150`.
- [verified] Add compaction/rehydration coverage for fully covered non-exact ranges.
- [verified] Add file-version-drift coverage proving stale coverage is invalidated.
- [verified] Verify constrained/blocked reads are rejected before filesystem execution rather than only after the round settles.

**13N-A status:** `[verified]` implementation and focused regression gate. The combined read-gate/hardening set passes 31/31. This does not close the broader Phase 13M rollout gate. Detailed notes: `docs/research/PHASE13N-A-READ-GATE.md`.

### 13N-B — Evidence-based exploration progress

- [verified] Define an explicit semantic evidence delta produced by each exploration-capable tool.
- [verified] Count new files, new ranges, newly reconstructed evidence, novel search results, symbols, and settled verification facts as meaningful progress only when genuinely new.
- [verified] Keep lifecycle IDs, timestamps, output references, retry counters, and UI-only changes out of progress semantics.
- [verified] Preserve the existing nudge → constrain → stop intervention policy.
- [verified] Keep the exact-identical-call doom-loop backstop as a separate safety layer.
- [verified] Add adversarial tests showing different but fully covered read ranges cannot manufacture progress.

**13N-B status:** `[verified]` at the focused implementation/regression level. `ExplorationState.observeTool()` now emits explicit evidence deltas for reads, searches, and verification; semantic progress excludes rehydration and lifecycle churn; and telemetry exposes the evidence dimensions without turning cosmetic or repeated calls into progress. The 13N-B suite passes 6/6 and the combined focused regression set passes 26/26.

### 13N-C — Production exploration guidance wiring

- [verified] Integrate the corresponding module into the authoritative production `Agent.run()` path.
- [verified] Make guidance consume current prompt intent and current evidence state, including no-progress streak and progress revision.
- [verified] Encourage one-batch independent read/search calls while preserving adaptive routing.
- [verified] Encourage continuation from uncovered ranges and strategy changes after no new evidence.
- [verified] Prevent guidance from becoming a fixed ceremonial `repo_map → glob → grep → read` script.

**13N-C status:** `[verified]` at the focused implementation/regression level. Production `Agent.run()` now injects bounded, dynamic exploration guidance into the provider request for Explore turns and subsequent evidence-tracked rounds. Guidance is recomputed from the current prompt, available exploration tools, `ExplorationState`, and telemetry; it does not mutate semantic state or act as runtime enforcement. The dedicated 13N-C suite passes 3/3 and the production build passes.

### 13N-D — Post-edit verification and verification ledger

- [verified] Research/adapt TermAgent's declarative post-edit hook pattern on top of the existing TaskManager/shell infrastructure, implemented as an opt-in configuration-driven post-mutation verifier rather than a second execution engine.
- [verified] Add bounded post-mutation verification commands with explicit `passed`/`failed`/`timeout`/`cancelled`/`no_command` states.
- [verified] Feed settled verification results into the durable session verification event, workflow observation, `ExplorationState` evidence, and the derived EvidenceLedger.
- [verified] Prevent successful automated verification from triggering redundant same-batch manual re-verification unless explicitly requested; `force=true` performs the explicit rerun.
- [verified] Define an `EvidenceLedger` projection for file coverage, searches, symbols, verification, mutations, tasks, and workflow state with bounded collections and a semantic fingerprint.
- [verified] Preserve the ledger as derived semantic state; `SessionStore` and `TaskManager` remain the authoritative durable truth.
- [verified] Preserve bounded verification previews plus durable task output paths/byte counts/truncation state as out-of-band full-output references.

**13N-D status:** `[verified]` at the focused implementation/regression level. The dedicated verification/ledger suite passes 9/9; the combined Phase 13M/13N focused regression gate passes 38/38. The broader repository aggregate test runner and physical ARMv7/Termux execution remain separate rollout gates. Detailed notes: `docs/research/PHASE13N-D-VERIFICATION-LEDGER.md`.

### 13N-E — LSP verification correctness

- [verified] Model LSP diagnostics as `unknown`, `running`, `provisional`, `clean`, `failed`, `timed_out`, or `cancelled`.
- [verified] Never render an unsettled zero-diagnostic publication as a clean result; an early empty publication remains provisional until quiescence and the minimum-settle policy are satisfied.
- [verified] Add quiescence/budget tests using asynchronous diagnostic publication sequences, including stale-to-final publications and budget expiry.
- [verified] Feed settled/provisional status into the verification ledger and keep diagnostic lifecycle timing/task identity out of semantic fingerprints.

**13N-E status:** `[verified]` at the diagnostic-state/evidence-contract level. The runtime now has a reusable asynchronous diagnostic state machine plus ledger integration, but it does not claim to be the language-server manager itself. Actual LSP process/session management remains the later Phase 16 capability work. Detailed notes: `docs/research/PHASE13N-E-LSP-VERIFICATION.md`.

### 13N-F — Provider reliability audit

- [verified] Re-audit tool-call delta accumulation against current design provider implementations; adapters accumulate partial tool-call arguments by provider-native stream identity before emitting normalized calls.
- [verified] Preserve opaque provider metadata exactly where round-trip requirements exist.
- [verified] Add deterministic retry/backoff fixtures, including `Retry-After`, stalled streams, and cancellation during backoff.
- [verified] Add stream-idle watchdog behavior with explicit user-visible stalled-stream state.
- [verified] Verify provider-specific reasoning parameters remain adapter-specific rather than leaking across providers.

**13N-F status:** `[verified]` at the provider reliability contract level. Typed HTTP errors now preserve status/headers/body and `Retry-After`; retries honor cancellation; SSE streams have a bounded idle watchdog; partial streamed output is never replayed automatically; provider metadata remains opaque; and reasoning options stay adapter-specific. Detailed notes: `docs/research/PHASE13N-F-PROVIDER-RELIABILITY.md`.

**Context-budget note:** TermAgent defaults to `maxContextTokens=12000`. With the default `compactionThreshold=0.82`, `contextReserveTokens=768`, and the budget helper's default 2048 output reserve, the normal usable request budget is `9840 - 2048 = 7792` estimated tokens before compaction. the implementation instead derives its usable threshold from each model's provider metadata (`model.limit.input` or `model.limit.context`) and reserves output capacity dynamically; there is no equivalent global 12K ceiling in the model-aware overflow calculation. A future model-aware budget layer can expose the same separation between provider hard cap and TermAgent working budget without weakening deterministic local budgeting.

### 13N-G — Specialist sub-agent hardening

- [verified] Compare current TermAgent task/sub-agent contracts with TermAgent's restricted specialist roster pattern and TermAgent's per-agent permission model.
- [verified] Add explicit built-in specialist role tool allowlists and read-only/restricted-shell policies.
- [verified] Bound concurrent delegation centrally and make maximum delegation depth explicit.
- [verified] Preserve parent/child cancellation, inherited workspace scope, inherited permission rules, durable parent-task linkage, and estimated token usage accounting.
- [verified] Standardize bounded specialist result reports for parent-agent consumption while retaining full durable output separately.

**13N-G status:** `[verified]` for the specialist hardening contract. The specialist roster is production-wired through task/background-agent/parallel-agent creation and worker execution. Repository-wide aggregate tests remain blocked by the pre-existing 13B/13L expectation failures documented in the current regression report. Detailed notes: `docs/research/PHASE13N-G-SPECIALIST-HARDENING.md`.

### 13N-H — Checkpoint/branch UX

- [verified] Add immutable checkpoint UX over authoritative session state.
- [verified] Add checkpoint listing with labels, timestamps, and message counts.
- [verified] Add branch-from-checkpoint commands without copying mutable render state.
- [verified] Test checkpoint replay after compaction, interruption, and reconnect.

**13N-H status:** `[verified]` at the checkpoint/session UX level. Checkpoints persist an immutable message projection plus a durable workspace snapshot; restore appends a `checkpoint.restore` event and reconstructs active history from that point forward; branch-from-checkpoint leaves the source session untouched and can optionally restore the workspace. Checkpoint references accept exact IDs, unique prefixes, and displayed `#N` indexes. Legacy metadata-only checkpoints remain listable but cannot be restored or branched safely. Detailed notes: `docs/research/PHASE13N-H-CHECKPOINT-BRANCH-UX.md`.

### 13N-I — Semantic UI state, visual system, motion and exploration HUD

**13N-I closure rule:** this phase is one cohesive Terminal UI pass. Do not create separate future TODOs for individual theme, banner, animation, or exploration-HUD features.

#### Semantic foundation

- [verified] Promote picker data to structured semantic rows with label/detail/badge/status fields rather than display-string parsing.
- [verified] Cache stable transcript layout and rerender only changed/streaming entries.
- [verified] Register semantic hit targets during rendering for touch/mouse interaction.
- [verified] Ensure busy-state clicks cannot cancel the agent unless they target the explicit interrupt control.
- [verified] Extend the presentation system toward semantic theme tokens shared by future Terminal/Web/VS Code renderers.

#### Visual system completion

- [verified] Replace inconsistent palette names and hardcoded banner colors with the original TermAgent theme catalog and per-theme visual metadata.
- [verified] Add a dedicated theme picker with live preview, commit/rollback, semantic swatches, keyboard navigation, and touch-safe hit targets.
- [verified] Add user/project theme-file loading with validation and safe fallback.
- [verified] Add multiple original banner compositions with width-aware fallback instead of a single startup splash.
- [verified] Add a bounded ambient-effects engine for the banner band, with low-frame-rate redraw and a hard off switch.
- [verified] Add persistent banner style/effect preferences plus full/reduced/off motion modes.
- [verified] Add a reduced-motion accessibility profile that removes decorative shimmer/pulse while keeping state changes visible.
- [verified] Add the exploration HUD as a semantic projection of ExplorationState + ExplorationTelemetry, including file coverage, remaining ranges, discoveries, and verification state.
- [ ] Add the same exploration presentation contract to the future Web renderer without duplicating runtime state.
- [verified] Add accessibility/color-capability regression coverage for the new terminal visual system.
- [verified] Freeze the Terminal UI contracts after the dedicated 13N-I suite and relevant Phase 12 regressions pass.

#### Reconciled interaction completion

- [verified] Semantic Markdown tables with alignment-preserving responsive layout and mobile card fallback.
- [verified] Runtime-owned prompt queue with durable session events, edit/cancel/reorder, executing-vs-queued presentation, and stale execution recovery.
- [verified] Composer remains usable during agent turns with context/provider/model/state/queue information and responsive density.
- [verified] User messages use a separate semantic surface from the composer.
- [verified] Session-changing commands cannot race an active turn.
- [verified] Legacy experimental Markdown test now exercises the current renderer rather than the obsolete preview build.
- [verified] Recover recognized text-encoded tool calls through the canonical Agent/tool lifecycle without creating a second executor.
- [verified] Suppress leaked tool protocol markup from live/final terminal output and fail closed when tools are disabled.

**13N-I status:** `[verified]` for the Terminal UI presentation layer and provider text-tool compatibility hardening. Themes, banner variants, bounded effects, motion modes, exploration HUD, semantic interaction, visual fallbacks, and text-tool protocol recovery are implemented and covered by focused regression tests. The future Web renderer remains a Phase 14 concern. Detailed notes: `docs/research/PHASE13N-I-SEMANTIC-UI-VISUAL-SYSTEM.md`.

### 13N-J — Mobile process/release hardening

- [verified] Audit managed process cleanup for descendant-held pipes, process groups, bounded tails, stdin timeouts, and stop semantics. See `docs/research/PHASE13N-J-A-PROCESS-LIFECYCLE.md`.
- [verified] Add target-aware ARMv7 Android/Termux release automation with explicit Android ABI/target metadata, deterministic target-labeled bundles, and an ARMv7 QEMU CI smoke path.
- [verified] Add SHA-256 manifests and prebuilt-first installation with source-build fallback, target self-identification, and checksum verification before extraction.
- [ ] Run `termagent-device-smoke` on the real Termux ARMv7 phone before declaring platform support complete.

### 13N gate

- [ ] 13M read gate is closed first; no Web View implementation begins before redundant reads are blocked pre-execution.
- [ ] Evidence progress survives compaction/restart and does not treat lifecycle churn as semantic progress.
- [ ] Exploration guidance is either production-wired or explicitly retired.
- [ ] Verification ledger and post-edit verification tests pass.
- [ ] Provider retry/stream/cancellation fixtures pass.
- [ ] Structured UI/performance changes preserve the frozen Phase 12 contracts.
- [ ] ARMv7/Termux evidence is real when the platform is touched.

# Phase 14 — Web View and Multi-Client Runtime

Web View is a first-class client of TermAgent's canonical runtime. It is not an ANSI mirror. The browser, terminal, and future VS Code integration must observe and mutate the same session state through semantic events and commands.

### 14A — Canonical event log and interaction model

- [verified] Introduce a durable monotonic session-event sequence independent of JSONL array indexes.
- [verified] Make `SessionStore.append()` assign and persist the authoritative durable sequence atomically with the event.
- [verified] Define public durable event types for session lifecycle, user/assistant messages, reasoning/tool lifecycle, tasks, Todo, permissions, questions, compaction, mutations, diffs, skills, and provider state where user-visible.
- [verified] Define explicit live-only event types for high-frequency streaming deltas, activity, heartbeats, and connection state.
- [verified] Define `EventEnvelope` versioning and validation in the corresponding module.
- [verified] Define `CommandEnvelope` with `commandId`, `clientId`, `sessionId`, optional expected sequence/revision, kind, and payload.
- [verified] Make command handling idempotent and deterministic where duplicate delivery is possible.
- [verified] Define first-writer-wins semantics for permission/question resolution.
- [verified] Make pending permission/question requests durable/reconstructible rather than existing only inside an HTTP handler closure.

**14A status:** Complete. `SessionStore` now writes authoritative sequence/event metadata under the existing cross-process session-state lease, exposes durable event envelopes and paged replay by durable cursor, and retains compatibility mapping for legacy records that predate explicit sequence metadata. `CommandLedger` provides per-session/client/command idempotency, semantic command fingerprints, stale expected-sequence/revision checks, and durable receipts. Permission/question requests are reconstructed from session events and resolve with first-writer-wins semantics. Live-only event types remain unsequenced and non-durable. An incomplete final JSONL write is repaired before a subsequent append; newline-terminated corruption fails closed rather than being silently discarded.

### 14B — Event bus and reconnect-safe streaming

- [ ] Add a runtime-owned session event publisher/subscriber boundary.
- [ ] Replace the current 250 ms JSONL polling SSE implementation with race-free replay-then-tail semantics.
- [ ] Replay durable events after a supplied sequence cursor, then subscribe to newly committed durable events without gaps.
- [ ] Send a connection/ready frame that identifies the current durable sequence.
- [ ] Preserve heartbeat and explicit connection-state semantics.
- [ ] Ensure transport disconnects do not mutate session truth.
- [ ] Add authoritative snapshot/context endpoints for reconciliation after missed live-only events.
- [ ] Add reconnect tests at every event boundary.

### 14C — HTTP API and dependency-free client SDK

- [ ] Refactor the corresponding module so route functions only adapt HTTP to canonical commands/services.
- [ ] Define stable session, history, event-stream, permission, question, task, diff, context, and runtime-status endpoints.
- [ ] Prefer durable history + durable event stream as the public synchronization contract.
- [ ] Add a typed dependency-free client API in the corresponding module for all Web View operations.
- [ ] Implement a fetch-based SSE reader with explicit auth headers and reconnect support; do not require browser `EventSource` when header-based auth is needed.
- [ ] Keep the protocol usable without the browser and without VS Code.
- [ ] Add schema/route drift tests.

### 14D — Browser Web View application

- [ ] Add the browser application under `web/` without coupling it to Node runtime modules.
- [ ] Implement initial bootstrap/session discovery.
- [ ] Implement transcript projection from canonical events/state.
- [ ] Implement streaming assistant output from live events with durable completion reconciliation.
- [ ] Implement tool cards, expandable tool input/output, paths, task state, reasoning/activity, and diffs.
- [ ] Implement shared permission/question surfaces.
- [ ] Implement session switching, new sessions, abort, resume, compact, undo/redo, task inspection, and other exposed commands.
- [ ] Implement browser-local presentation state such as collapsed cards, scroll, panels, and responsive layout.
- [ ] Add accessible keyboard navigation and responsive layouts without changing runtime contracts.

### 14E — Security, pairing, and remote access

- [ ] Keep local browser access as the default deployment mode.
- [ ] Require explicit configuration to expose TermAgent beyond localhost.
- [ ] Add authenticated browser pairing/bootstrap rather than embedding long-lived provider/session secrets into page source.
- [ ] Add origin validation and CSRF protection for state-changing browser requests.
- [ ] Scope credentials/commands to authorized workspaces and sessions.
- [ ] Never send provider API keys, permission internals, filesystem secrets, or unrelated environment values to the browser.
- [ ] Add duplicate-command, stale-command, expired-auth, origin, and replay security tests.

### 14F — Two-way mirror verification

- [ ] Open terminal and Web View on one session simultaneously.
- [ ] Verify user messages, assistant responses, reasoning/activity, tool calls/results, Todo, tasks, diffs, permissions, and questions converge.
- [ ] Resolve a permission from Web View and verify terminal convergence.
- [ ] Resolve a question from terminal and verify Web View convergence.
- [ ] Submit simultaneous conflicting decisions and verify one authoritative durable result.
- [ ] Disconnect Web View during streaming and reconnect from the durable cursor.
- [ ] Restart the Web View client without restarting TermAgent and reconstruct exact authoritative state.
- [ ] Restart TermAgent and verify durable session reconstruction plus explicit active-run recovery behavior.

### 14G — Optional WebSocket transport

- [ ] Evaluate WebSocket only after HTTP/SSE semantics are complete.
- [ ] Reuse the same command/event schemas; WebSocket must be a transport adapter, not a second protocol.
- [ ] Use it only where bidirectional live traffic materially benefits from lower latency or richer connection semantics.
- [ ] Preserve durable SSE/HTTP recovery semantics even when WebSocket is used.

### Phase 14 gate

- [ ] Browser and terminal are equivalent runtime clients.
- [ ] Durable events replay correctly.
- [ ] Live updates never become the only source of truth.
- [ ] Permission/question state is deterministic across clients.
- [ ] Reconnect/recovery is tested.
- [ ] Security model is tested.
- [ ] Package/build and browser distribution checks pass.

---

# Phase 15 — VS Code integration

The long-term VS Code integration uses the same TermAgent runtime rather than embedding a second agent engine inside the extension.

### 15A — Extension-host adapter

- [ ] Create `extensions/vscode/` using the official repository structure.
- [ ] Implement a typed TermAgent client in the extension host.
- [ ] Implement workspace-to-TermAgent session attachment and discovery.
- [ ] Implement secure local/remote authentication and connection lifecycle.
- [ ] Reuse canonical events/commands; do not duplicate task, permission, question, or agent logic.

### 15B — Native VS Code Chat Participant

- [ ] Evaluate the VS Code Chat Participant API for native `@termagent` integration.
- [ ] Stream TermAgent responses into the VS Code chat experience.
- [ ] Map user messages and cancellation to canonical runtime commands.
- [ ] Preserve TermAgent as the authoritative agent/tool runtime.
- [ ] Map errors and progress into native VS Code chat affordances where practical.

### 15C — Full custom VS Code Webview

- [ ] Add a custom Webview panel/view only where richer TermAgent UI exceeds native Chat API capabilities.
- [ ] Keep the Webview itself stateless or minimally stateful and restore through extension state/reconciliation.
- [ ] Extension host receives runtime events and forwards sanitized semantic messages to the Webview.
- [ ] Webview sends user actions back to the extension host with `postMessage()`; extension host submits canonical TermAgent commands.
- [ ] Do not require the Webview to call localhost directly, especially where Remote Development/Codespaces portability matters.
- [ ] Follow VS Code Webview CSP, `localResourceRoots`, serialization, accessibility, and lifecycle guidance.

### 15D — IDE-native actions

- [ ] Open referenced files at locations.
- [ ] Open diffs in the VS Code diff editor.
- [ ] Surface task status in the activity bar/status area where useful.
- [ ] Support workspace/session selection.
- [ ] Support attach/detach without changing session ownership.

### Phase 15 gate

- [ ] Native `@termagent` chat path works.
- [ ] Custom Webview path works where needed.
- [ ] Both use the same canonical runtime.
- [ ] Session state remains consistent with terminal/Web View clients.
- [ ] VS Code restart/restore behavior is tested.

---

# Phase 16 — Capability recovery and full parity expansion

This phase reopens capabilities previously deferred because TermAgent lacked the supporting architecture. Decisions must be based on engineering value and current TermAgents, not on resource pessimism.

### 16A — LSP/code intelligence

- [ ] Reassess the current session and language-server integration architecture when this phase is reopened.
- [ ] Define a provider-neutral language-server manager and workspace document lifecycle.
- [ ] Implement diagnostics after edits.
- [ ] Implement definitions/references/symbol search where supported.
- [ ] Feed LSP evidence into repository retrieval and verification without making LSP mandatory for unsupported languages.
- [ ] Make server process lifecycle durable/recoverable.

### 16B — Web tools

- [ ] Re-research current design webfetch/websearch implementations and network policies.
- [ ] Define network permission and domain/resource classification.
- [ ] Add bounded fetch/search result storage and context projection.
- [ ] Preserve complete results out-of-band where useful.
- [ ] Add SSRF, redirect, size, timeout, content-type, and authentication safety controls.

### 16C — Notebook/structured document editing

- [ ] Research the implementation NotebookEdit and related notebook state.
- [ ] Define cell-aware document model and mutation protocol.
- [ ] Preserve per-cell history, execution/output state, and diff/review semantics.
- [ ] Add a real NotebookEdit implementation rather than text-file imitation.

### 16D — Structural repository intelligence

- [ ] Reassess the current symbol/reference graph against the latest internal implementation approaches.
- [ ] Improve language coverage and parser fallbacks.
- [ ] Add dependency/reference graph persistence and incremental invalidation.
- [ ] Fuse lexical, structural, symbol, and recent-session evidence.
- [ ] Use exploration state to avoid redundant reads/searches.

### 16E — Memory and project knowledge

- [ ] Research the implementation project memory and current design memory patterns.
- [ ] Separate durable user/project knowledge from repository-derived facts.
- [ ] Add explicit memory provenance and invalidation rules.
- [ ] Add optional semantic/vector retrieval without coupling core session truth to one storage engine.
- [ ] Make memory import/export inspectable and reversible.

### 16F — Provider protocol maturity

- [ ] Reassess streaming, retries, cancellation, structured outputs, tool-call IDs, and provider capability metadata against current design implementations.
- [ ] Add transport-specific adapters only behind the provider-neutral contract.
- [ ] Add deterministic recorder/replay fixtures for provider streams.
- [ ] Revisit WebSocket provider transports where a real provider benefits from them.

### Phase 16 gate

- [ ] Every deferred capability has an explicit adopt/adapt/rewrite/defer decision.
- [ ] No capability is intentionally degraded solely because it is complex.
- [ ] New capabilities integrate with the canonical session/interaction/protocol architecture.

---

# Phase 17 — Repository architecture migration and cleanup

This phase is allowed to be a real refactor when the current layout prevents correct evolution. Follow `REPO-STRUCTURE.md` and `AGENTS.md`.

- [ ] Move newly developed protocol schemas into the corresponding module.
- [ ] Move canonical client/server interaction semantics into the corresponding module.
- [ ] Move the browser application into `web/` and VS Code integration into `extensions/vscode/`.
- [ ] Mirror new tests into the domain-specific `tests/` structure.
- [ ] Consolidate legacy duplicate helpers and eliminate parallel implementations.
- [ ] Split oversized runtime/server modules where ownership is currently mixed.
- [ ] Remove obsolete compatibility shims only after characterization tests prove they are no longer needed.
- [ ] Update imports/docs and keep one authoritative implementation for every production capability.

---

# TermAgent architecture owners

Keep protocol, session, tool, UI, plugin, skill, context, and release decisions tied to the owning module documented in `ARCHITECTURE.md` and `REPO-STRUCTURE.md`.


# Historical completed work

The 1.7 execution-safety, semantic loop detection, completion gate, provider manager, and earlier UI primitives remain historical baseline work. Phase 12 supersedes the visual treatment of the transcript, picker, diff, permission/question interaction, and active Todo surfaces while preserving their underlying behavior and contracts.

# TODO maintenance rules

- [ ] Every phase implementation starts only after its research/contract section is understood.
- [ ] Never mark a task complete from intention alone. Link completion to code/tests/report evidence.
- [ ] When a plan changes, update this file and `ARCHITECTURE.md` in the same planning change.
- [ ] Keep historical reports immutable unless correcting a factual error; use current architecture/TODO documents for new decisions.
- [ ] A newly discovered architectural flaw may introduce a hardening phase before a rollout gate. Do not force flawed work through a numbered gate merely to preserve numbering purity.

# Phase gate rule

A phase is not marked complete until its implementation, focused regression tests, full suite, build, package dry-run, source-hygiene scan, extracted-artifact smoke test, and all phase-specific recovery/concurrency/replay checks pass. After a passing phase, stop and propose the next phase rather than silently starting it.
