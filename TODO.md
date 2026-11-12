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

**Context-budget note (corrected during Phase 14H):** the 14F6 source does not default `maxContextTokens` to 12,000. `environmentDefaults()` leaves it unset unless `TERMAGENT_CONTEXT_WINDOW` is supplied; the previous `.termagent-example.json` explicitly carried a 12,000-token cap, and a project/global config can retain that explicit override. The active Agent route now resolves the context window from explicit config, provider profile, provider/model `extra` metadata, or a labelled conservative fallback. Check `/context` for the actual source before attributing a particular session's limit. The old fixed `7792` usable-token calculation is not a valid current default.

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
- [verified] Parse text-encoded tool calls before transcript projection using incremental protocol framing rather than renderer masking.
- [verified] Reconcile split/incomplete XML, resolve names against the live tool registry, and route recovered calls through the existing permission/lifecycle executor.
- [verified] Keep native provider calls and text-recovered calls in one semantic call stream with no protocol markup leakage.

**13N-I status:** `[verified]` for the Terminal UI presentation layer and provider text-tool compatibility hardening. Themes, banner variants, bounded effects, motion modes, exploration HUD, semantic interaction, visual fallbacks, and text-tool protocol recovery are implemented and covered by focused regression tests. The future Web renderer remains a Phase 14 concern. Detailed notes: `docs/research/PHASE13N-I-SEMANTIC-UI-VISUAL-SYSTEM.md`.

### 13N-J-C — Shell service/process semantics

- [test] Keep semantic no-progress detection scoped away from operational shell/write rounds so distinct command attempts do not inherit an exploration stagnation streak.
- [test] Preserve descendants intentionally launched with an unquoted shell `&` after the shell leader exits, while retaining cleanup for unintended descendants and termination paths.
- [test] Surface EADDRINUSE as structured shell metadata plus model-facing guidance to inspect or reuse the existing service instead of launching another copy.

**13N-J-C status:** `[test]` after focused agent/process/shell regressions and a clean TypeScript build. Physical Termux/ARMv7 behavior remains unverified on the x86_64 host.

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

# Phase 14 — Runtime Reliability, Context, Provider Platform and Web View

Web View is a first-class client of TermAgent's canonical runtime. It is not an ANSI mirror. The browser, terminal, and future clients must observe and mutate the same session state through semantic events and commands. Phase 14 also closes reliability gaps exposed while using the runtime on a real repository: context capacity and compaction, instruction/skill continuity, background-agent orchestration, provider configuration, session-state locking, and live event delivery. These are shared-runtime concerns, not separate terminal-only or browser-only features.

**Phase 14 status: REOPENED / P0 reliability work added.** Phases 14A–14E have host-side implementation and focused regression evidence, and Phase 14F.1/.2/.3/.4 have verified partial sub-gates for owner fencing, SSE reconciliation, terminal daemon attachment, and cross-client state projection. The session UI showed `ctx 5k/12k`, and the supplied example configuration previously contained a 12K `maxContextTokens` cap; the 14F6 source default itself does not hardcode 12K. An existing project/global `maxContextTokens` or `TERMAGENT_CONTEXT_WINDOW` override can still intentionally cap a route, so `/context` provenance and the effective config must be checked before attributing a particular session’s cap. The uploaded 759-event session records 50 compaction events, while child-agent failures are not reliably fed into an already-running parent turn, child provider credentials can be omitted when only an in-memory key exists, the session-state lease can exhaust its acquisition window, and tool events can be persisted but not become visible in the live Web View until reconnect. These findings reopen the relevant 14B/14F live-delivery validation and require the new 14H–14J work below. Phase 14 remains incomplete until these issues, full terminal/browser parity, cross-client interaction/cancellation and recovery, performance measurements, the repository-wide regression gate, and physical mobile/deployment validation are closed.

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

- [verified] Add a runtime-owned session event publisher/subscriber boundary.
- [verified] Replace the current 250 ms JSONL polling SSE implementation with race-free replay-then-tail semantics.
- [verified] Replay durable events after a supplied sequence cursor, then subscribe to newly committed durable events without gaps.
- [verified] Send a connection/ready frame that identifies the current durable sequence.
- [verified] Preserve heartbeat and explicit connection-state semantics.
- [verified] Ensure transport disconnects do not mutate session truth.
- [verified] Add an authoritative session snapshot endpoint for reconciliation after missed live-only events, alongside the existing context endpoint.
- [verified] Add reconnect/race regression coverage at the replay→tail handoff, cursor validation, and subscriber cleanup boundaries.

**14B status:** `[reopened for live end-to-end validation]` The runtime publisher/subscriber, replay→tail handoff, heartbeat/connection frames, cursor validation, snapshot reconciliation, reconnect behavior, and subscriber cleanup have focused regression coverage. However, the user-observed Web View session did not display tool calls while the agent was running; those calls appeared after the agent was stopped and the runtime reconnected. The transport/reducer path must be traced end-to-end and proven live before this sub-gate can be considered closed. Existing focused tests remain useful evidence but do not override this production symptom.

### 14C — HTTP API and dependency-free client SDK

- [verified] Refactor the corresponding module so route functions only adapt HTTP to canonical commands/services.
- [verified] Define stable session, history, event-stream, permission, question, task, diff, context, and runtime-status endpoints.
- [verified] Prefer durable history + durable event stream as the public synchronization contract.
- [verified] Add a typed dependency-free client API in the corresponding module for all Web View operations.
- [verified] Implement a fetch-based SSE reader with explicit auth headers and reconnect support; do not require browser `EventSource` when header-based auth is needed.
- [verified] Keep the protocol usable without the browser and without VS Code.
- [verified] Add schema/route drift tests.

**14C status:** `[verified]` implementation and focused HTTP/client regression gate. The stable plural checkpoint-create route was corrected after route-drift testing exposed the legacy singular-only handler. Phase 14C does not close the overall Phase 14 gate; browser implementation, security/pairing, two-way mirror verification, and the separate 13N rollout/platform gate remain open.

### 14D — Browser Web View application

**Status:** `[IMPLEMENTED; integration blocker closed by 14E.1; device validation open]`. The host-side browser application and focused rendering/client tests exist. Phase 14E.1 now connects the server-owned `PermissionGate` to the canonical durable interaction state, so browser Allow/Deny settles the exact wait awaited by the original tool execution; the server runtime no longer falls back to stdin for these requests. Physical Android/Brave behavior and live-provider interaction remain unverified. See `docs/phases/PHASE14E1-PERMISSION-RESOLVER.md` and the original source assessment for the pre-fix diagnosis.

- [verified] Add the browser application under `web/` without coupling it to Node runtime modules.
- [verified] Implement initial bootstrap/session discovery.
- [verified] Implement transcript projection from canonical events/state.
- [verified] Implement streaming assistant output from live events with durable completion reconciliation.
- [verified] Implement tool cards, expandable tool input/output, paths, task state, reasoning/activity, and diffs.
- [verified] Render permission/question surfaces from durable interaction state; Phase 14E.1 proves the browser decision resumes the original server-owned permission wait and the original tool call.
- [verified] Implement session switching, new sessions, abort, saved-session resume, compact, undo/redo, task inspection/continuation, and exposed session commands.
- [verified] Implement browser-local presentation state such as collapsed cards, scroll-follow, focus/theme preferences, panels, and responsive layout.
- [verified] Add accessible keyboard navigation and responsive layouts without changing runtime contracts.

**14D implementation notes:** the uploaded v4 prototype remains unchanged under `web/prototype/`; `web/app/` uses its exact stylesheet as the foundation and binds the layout to the existing typed client and durable event protocol. Focused verification is documented in `PHASE-14D-REPORT.md` and `docs/research/PHASE14D-WEB-VIEW.md`.

### 14E — Security, pairing, and remote access (IMPLEMENTED; deployment validation open)

**14E.1 status: `[verified]` permission resolver integration.** The server-owned gate awaits the canonical durable interaction state. Browser commands do not own a second promise: they commit through `SessionStore`, notify the runtime-local event bus, and settle the same wait that is already inside `PermissionGate.check()` / `ToolRegistry.execute()`. See `docs/phases/PHASE14E1-PERMISSION-RESOLVER.md`.

- [verified] Wire the server `PermissionGate` requester to the same durable `SessionStore` interaction resolution that HTTP/browser clients use; remove the server fallback to interactive stdin for server-owned permission requests. Browser allow/deny settles the original tool-call wait.
- [verified] Cover once/always/deny, first-writer-wins races, duplicate commands, stale/wrong-session IDs, timeout, cancellation/abort, graceful server shutdown and restart reconstruction, browser disconnect/reconnect, and concurrent requests at the 14E.1 integration boundary. Abrupt-crash orphan reconciliation remains deferred until 14F provides exclusive owner fencing.
- [verified] Keep local browser access as the default deployment mode; refuse non-loopback binds unless secure remote authentication is explicitly configured.
- [verified] Add one-time device pairing, opaque hashed device tokens, expiry, revocation, authenticated client identity, and workspace/session/task scopes.
- [verified] Validate Host/Origin and state-changing request provenance; bearer-only Authorization avoids ambient-cookie CSRF, with Fetch Metadata, JSON-only mutations, no CORS, and no URL credentials.
- [verified] Add request/mutation/pairing rate limits, pairing brute-force protection, command-scope authorization, bounded audit events, and safe error/log redaction.
- [verified] Keep provider credentials, raw process environment, custom-agent prompt bodies, token hashes, and unrelated configuration values out of browser projections.
- [verified] Security-test unauthenticated remote access, expired/revoked tokens, replay, wrong scope, bad Origin/Host, cross-site/CSRF-style requests, duplicate commands, and stale interactions.

**14E implementation status:** the code-level permission, pairing, TLS/origin, bearer-token, expiry/revocation, workspace-scope, and command-scope requirements have focused host-side evidence. The combined Phase 14A–14E.1 plus server regression set passes 43/43; the production build, release-artifact verification, and package dry-run pass. The repository-wide test command remains not green because of the known `/auto` CLI assertion and the aggregate runner timeout; no full-suite pass is claimed. Physical Android/Brave and production-network deployment checks remain open. The Web View currently supports self-revocation; revoke-other-device administration is a documented limitation. Physical Android/Brave validation remains open. Phase 14F.1 now adds workspace owner fencing and post-lock restart interaction reconciliation. See `docs/phases/PHASE14E-SECURITY-PAIRING-REMOTE-ACCESS.md` and `PROGRESS.md`.

### 14F — Two-way terminal/browser synchronization (REOPENED / P0; Option A ACCEPTED)

**Runtime topology decision (2026-11-01):** the project owner selected **Option A — one long-lived TermAgent runtime daemon**. It is the only owner of Agent instances, active turn controllers, PermissionGate waiters, SessionStore writes, TaskManager workers, providers and the runtime event bus. Terminal and browser are clients. See accepted `ADR-019`.

- [verified] Introduce the daemon lifecycle and exclusive workspace owner lease with process identity, local owner discovery, authenticated health/heartbeat metadata and stale-owner recovery. A second launch fails clearly with owner mode/PID/endpoint instead of silently creating a competing runtime. After acquiring the lease, startup reconciles orphaned pending permissions/questions and marks unmatched turns interrupted. See `docs/phases/PHASE14F1-DAEMON-OWNERSHIP.md`.
- [verified, partial] The interactive terminal now attaches to a ready workspace daemon before constructing local Agent state; standalone mode remains available when no server owns the workspace. The daemon-client command catalog and rich TTY parity are still incomplete. See `docs/phases/PHASE14F3-TERMINAL-DAEMON-CLIENT.md`.
- [verified, partial] Attached terminal prompts, queue operations, session operations, interactions and turn controls use the existing typed `TermAgentClient` command/event protocol over HTTP/SSE. Advanced standalone-only commands and full UI parity remain open.
- [verified] The daemon remains the only live runtime writer; `SessionEventBus` is a wakeup mechanism and JSONL + monotonic sequence is durable truth. Queue worker execution is daemon-owned; no cross-process event broker was added.
- [verified] Make SSE replay/tail recover from reconnect, slow consumers, write backpressure and live-buffer overflow; emit an explicit gap/reconciliation condition instead of silently dropping transient frames. Durable JSONL is replayed from the last sequence; a 1-second poll supplements process-local wakeups; live overflow emits a gap that triggers snapshot reconciliation. the durable session-event `writeSse()` path serializes writes through Node's `drain` signal. See `docs/phases/PHASE14F2-DURABLE-SSE-RECONCILIATION.md`.
- [verified, partial] Terminal interrupt/cancel and abort use daemon API commands that reach the daemon-owned active controller. Full cross-client cancellation/race coverage remains open.
- [ ] Open terminal and Web View on the same session simultaneously and verify messages, reasoning/activity, tool calls/results, Todo, tasks, diffs, queue, checkpoints, permissions, questions, metadata and run status converge.
- [ ] Resolve permission from browser and question from terminal; verify both surfaces converge to the same durable winner. Verify terminal permission controls route through the same daemon interaction resolution.
- [ ] Test two browsers plus terminal, duplicate commands, conflicting responses, queue edits, session switch, cancellation, daemon crash/restart, stale lock recovery and client attach/detach.
- [ ] Disconnect Web View during streaming and reconnect from the last durable sequence; reconstruct state after browser and daemon restarts with explicit active-run recovery semantics.
- [ ] Run physical Android/Brave/Chrome tests for keyboard, viewport, orientation, dialogs, scrolling, background/foreground, offline/online, network handoff and long transcripts.

**14F exit criteria:** one enforced runtime owner; terminal and browser are clients of that owner; every client observes the same durable state; permission/question decisions are deterministic; cancellation reaches the owning daemon; reconnect and daemon recovery are documented and tested.

**14F.1 implementation status — `[verified]` owner foundation only (2026-11-01):** `src/server/daemon-owner.ts` creates a workspace-keyed exclusive lease with a random owner/token identity, PID and Linux process-start identity, safe metadata registration, heartbeat, stale-owner recovery guard, and compare-before-release. `serve()` and the standalone REPL acquire the same lease before runtime construction. `/health` publishes the safe owner projection and endpoint. On fenced startup, `SessionStore.recoverOrphanedRuntimeState()` durably cancels stranded permission/question requests and records unfinished turns as `interrupted`. Eleven focused tests (10 owner tests + 1 server-owner integration test) and the TypeScript build pass. The terminal currently fails clearly when a server already owns the workspace; it is not yet a shared-runtime client. Phase 14F's terminal attachment, true simultaneous browser/terminal convergence, and device tests remain unchecked. Full report: `docs/phases/PHASE14F1-DAEMON-OWNERSHIP.md`; upstream adaptation: `docs/research/PHASE14F-UPSTREAM-DAEMON-OWNER-ADAPTATION.md`.


**14F.2 implementation status — `[verified]` durable SSE/reconciliation sub-gate (2026-11-01):** `SessionEventBus` now reports timed wakeups and transient overflow; the SSE tail combines local wakeups with a 1-second durable JSONL poll, writes serially through response drain, and emits a `gap` frame when bounded live delivery drops frames. The Web View fetches a canonical snapshot on a gap without advancing its durable cursor from that frame. Upstream OpenCode V2 event-stream architecture was studied and adapted without adding a second feed abstraction or cross-process event broker. Focused event-stream/Web View tests pass 13/13; the full Phase 14A–14F focused set is recorded in `PROGRESS.md`. Terminal daemon-client attachment, shared command handling, full cross-client convergence and physical Android/Brave tests remain open. Report: `docs/phases/PHASE14F2-DURABLE-SSE-RECONCILIATION.md`; research: `docs/research/PHASE14F2-UPSTREAM-EVENT-STREAM-ADAPTATION.md`.

**14F.3 implementation status — `[verified, partial]` terminal daemon-client convergence (2026-11-03):** `src/cli/repl.ts` now attaches to an existing ready server owner before local runtime construction; `src/cli/daemon-client.ts` uses the existing `TermAgentClient` for prompt queueing, sessions, queue controls, interruption/abort, history operations and durable SSE/live events. Daemon-owned queue workers execute attached terminal prompts. Terminal pairing persists a workspace-bound device credential atomically with POSIX 0700/0600 permissions; `/device revoke` revokes and removes it. Auto-attach is loopback-only. `SessionStore` now uses `AsyncLocalStorage` for async-chain mutation reentrancy, and queue execution is kicked after the command ledger transaction completes. Durable assistant history repairs incomplete transient streaming. The daemon-client command catalog remains smaller than the standalone REPL, and rich TTY permission/question flows, full UI parity, remote attachment, detach/restart recovery with live clients, two-browser coverage and physical Android/Brave validation remain open. Focused Phase 14A–14F suite: **63/63 PASS**; F3 + owner integration: **7/7 PASS**. `npm test` remains not green: the `/auto` integration assertion fails alone; a Phase 13G failure seen in the aggregate run passed on isolated rerun; aggregate run timed out at test 203 after 600s. Reports: `docs/phases/PHASE14F3-TERMINAL-DAEMON-CLIENT.md`, `docs/research/PHASE14F3-UPSTREAM-TERMINAL-DAEMON-CLIENT-ADAPTATION.md`.


**14F.4 implementation status — `[verified, partial]` cross-client state convergence (2026-11-03):** `TerminalUI` now hydrates tool-call/result history by stable provider `callId`, and live/durable lifecycle updates reconcile concurrent same-name calls independently. The call ID is propagated through runtime activity/SSE and permission interaction projections so the terminal can associate a permission with its exact requesting tool call. A non-TTY attached terminal is passive and no longer auto-denies/cancels browser-owned interactions; failed interaction resolution remains retryable until durable state confirms settlement. Attached-mode `/diff`, task inspection, task cancellation, checkpoint/list/restore/branch commands use existing daemon APIs. New regressions cover call-ID hydration, passive-client question ownership and daemon diff/task/checkpoint/branch commands. Focused Phase 14 suite: **66/66 PASS**; build, distribution verification, version, browser syntax and package dry-run pass. Full repository test suite, rich interactive TTY parity, two-browser + terminal concurrency, client detach/reconnect and daemon crash/restart with live clients, and physical Android/Termux/Brave/Chrome validation remain open. Report: `docs/phases/PHASE14F4-CROSS-CLIENT-STATE-CONVERGENCE.md`; upstream adaptation: `docs/research/PHASE14F4-UPSTREAM-CLIENT-STATE-PROJECTION-ADAPTATION.md`.

### 14G — Optional WebSocket transport

**Status: DEFERRED.** Do not implement WebSocket in the current roadmap. Keep HTTP/SSE as the authoritative transport. Reopen only if measured end-to-end profiling shows an interaction/throughput problem that batching, incremental rendering, backpressure, and reconnect changes cannot solve.

### Phase 14 performance and mobile sub-gate

Before transport changes, collect reproducible p50/p95 and sample counts for: prompt submit→ack, agent start→first event, provider first token→browser, tool start→result, permission click→agent resume, SSE publish→browser receipt, event receipt→DOM render, session switch→ready, and cancel click→execution stopped. Correlate timestamps with request/command/event IDs; never infer numbers from user perception.

Then profile and address: repeated snapshot/status/Todo/queue/context/diff/task/checkpoint request fan-out; 160 ms durable-event refresh bursts; full transcript `innerHTML` reconstruction and repeated Markdown parsing on each text/reasoning delta; SSE `res.write()` backpressure; silent 128-frame live-buffer eviction; tab visibility/background reconnection; and incremental mobile rendering. Do not adopt WebSockets without benchmark evidence.

### 14H — Model-aware context, memory continuity, and instruction loading

**Purpose:** Remove TermAgent's artificial context ceiling and stop large-repository work from repeatedly rediscovering the same files. Extend the existing `context/budget.ts`, `context/state.ts`, `context/exploration.ts`, `context/evidence-ledger.ts`, `agent/compaction.ts`, `agent/compaction` checkpoint projection, instruction loader, and skill catalog. Do not replace these systems with a new memory subsystem.

- [implemented; focused tests pass] Resolve the effective input context window and output-token limit from the selected provider + model + endpoint/route metadata. Precedence is explicit user override → provider-profile metadata → provider/model `extra` metadata → clearly labelled 128K conservative fallback. `/context` reports source provenance; catalog/route-backed metadata expansion remains part of 14J.
- [implemented; focused tests pass] Remove the fixed 12K cap from the shipped example configuration and use route-aware capacity. The screenshot displayed `ctx 5k/12k`, but source inspection shows there is no global 12K default in `environmentDefaults()`; the prior example file explicitly carried `maxContextTokens: 12000`, and existing local config can still carry that intentional override. `/context` now identifies `user-config` and explains how to remove it. Actual route/catalog metadata coverage remains open. Note: 14F6 defaults `maxContextMessages`, `maxContextBytes`, `contextRecentTokens`, and `repoMapTokens` to `0`; these are not defaults of 80/36KB/3000/2600.
- [partially implemented; component breakdown is visible in `/context`] Complete one request-budget calculation for system prompt, project instructions, repository map/retrieval, skill descriptors and loaded skill bodies, tool schemas, tool calls/arguments, tool results, prior summaries, recent messages, images/multimodal payloads, reasoning, output reserve, and provider-specific framing/overhead. Multimodal and adapter-specific costs still need authoritative accounting.
- [implemented; focused tests pass] Normalize provider-reported usage for Anthropic, OpenAI-compatible Chat/Responses-style aliases, and Gemini. Cache/reasoning breakdowns remain subsets when the provider's input/output totals are inclusive; Anthropic's separately reported cache counts are added to effective input exactly once. `/context` exposes the latest provider report and estimate drift for the current process. Anthropic and Gemini now have optional provider-native input-count preflight on near-budget requests; OpenAI-compatible routes and unsupported gateways retain local estimation. This is not a universal tokenizer, and exact media payload/framing overhead remains open. Sanitized per-request usage is persisted as a durable provider event and restored into `/context` when a session is resumed (forks use the child's own history and do not inherit a parent measurement); a session-scoped durable aggregate is now exposed through the existing context snapshot and terminal/Web View `/usage` surfaces. The aggregate separates provider-reported and estimated requests, preserves inclusive token totals, reports cache/reasoning/tool-use breakdowns and weighted estimator drift, bounds route cardinality, and deliberately does not guess pricing. Workspace-wide aggregation and clean-equivalent drift replay remain open. A failed provider retry discards usage from the failed attempt.
- [partially implemented] Context and repository allocations use the resolved model window, output reserve is resolved separately, and physical payload/file/path caps remain independent safety limits. Audit every compaction threshold, recent-turn reserve, instruction/skill/schema share, and route-specific overhead at small, medium, 500K, and 1M windows before calling the scaling policy complete.
- [implemented] `maxContextMessages` is deprecated and ignored; the source has no active history-trimming consumer. Retain whole turns and valid assistant-tool-call/result groups, and compact based on the effective request budget.
- [partially implemented; focused tests pass; physical Termux validation open] Automatic compaction uses the complete `accountContext()` request estimate plus the latest durable provider-measured context anchor and an estimate of content added since that measurement. New provider usage events retain `estimateRequestTokens`; older records remain compatible through the message-estimate/schema fallback. A bounded median correction uses up to five recent samples for the exact provider/model/context-window route and never changes a global tokenizer multiplier. Successful micro-prune/full compaction now starts a new calibration epoch: clear the previous measured baseline and rolling samples, then warm-start the first request with a 75%-toward-prior ratio; the first new same-route usage measurement replaces that prior. Route changes still clear calibration completely. Two chronological Mercury-3 datasets (110 and 70 captures) show lower mean/P95 absolute replay error for this decayed prior than either full carry or full reset, but both are single-route and usable-budget misses remain; keep this policy under validation. Native Anthropic `messages/count_tokens` and Gemini `:countTokens` preflight remains available near 72% of usable capacity and the compacted request is recounted. Final/no-tool response branches now run the post-provider-response compaction hook before returning Ready. UI local/recomputed context figures carry `~`; provider-reported usage stays unmarked. OpenAI-compatible routes without native count rely on durable measured baselines after the first successful response. Exact wire framing, media attachment accounting, provider-specific hidden framing and physical provider verification remain open. Explicit provider overflow recovery remains one bounded compact-and-retry attempt for 400/413/422 context-limit responses.
- [partially implemented; focused tests pass] Improve compaction quality and continuity. The fitted summary retains all 11 structural headings, preserves original bullet/section association, prioritizes current state, deduplicates repeated facts, and keeps tool-call/result groups atomic. A four-cycle test verifies objective, requirements, decisions, exact file references, active Todo, verification evidence, budget, and complete tool units. Broader machine-state and real-trace multi-cycle audits remain open.
- [partially implemented; selective micro-prune implemented and tested] Summary fitting now uses section-aware prioritization, all structural headings, original line order, recent evidence, and duplicate suppression. Safe micro-pruning now removes only old successful archived read-only results while retaining a durable output reference; broader transcript-shortening levels and hierarchical summary merging still need validation against very long histories.
- [implemented; focused tests pass] Restore bounded read coverage into the next `Agent.run` from durable context checkpoints, revalidate current content by streaming SHA-256 plus scope/realpath/stat/line-count checks, and rehydrate only previously inspected ranges within a small prompt-evidence budget. Existing exploration/evidence/workflow/task projections are restored from machine state. Broad repository index cache warm-recovery and daemon recovery stress tests remain open.
- [implemented; focused tests pass] Repository map/retrieval allocations already scale with the resolved model window and retain independent resource ceilings (map ≤64K tokens/800 paths; retrieval ≤48K tokens/192KB/24 files, with per-file byte bounds). Explicit `repoMapTokens`/`maxContextBytes` overrides remain available. [ ] Add large-repository stress/quality coverage for prioritization, symbol/reference coverage, pagination, and index warm-recovery; do not remove mobile payload safety caps or dump the entire repository.
- [partially implemented] The existing bounded `ExplorationStateSnapshot` is persisted in context machine state and restored at the next `Agent.run`; it tracks discovered paths, inspected ranges/file identity, search signatures/results, symbols, verification facts, and progress. The evidence ledger separately preserves verification, task, mutation, and file evidence. Still audit whether dependency edges and durable output references are adequately connected to the working set, and prove no broad scan repeats after daemon restart/compaction.
- [implemented; focused tests pass] Existing hierarchical loader resolves global and root-to-workspace instruction files, then discovers nested instruction scopes for paths actually touched and persists their references. Restored paths are realpath-checked against workspace/global roots. Full ancestor precedence/conflict diagnostics, multi-agent scope tests, and large nested-tree stress remain open.
- [implemented; focused tests pass] Keep existing descriptor-first/progressive-disclosure loading. Persist loaded skill IDs/digests/paths and restore unchanged skill bodies after a new Agent.run/compaction; restored skill content now receives its explicit-skill context allocation even without a fresh explicit invocation. Preserve security/provenance checks; large skill catalogs and near-budget restoration remain open.
- [partially implemented] The four-cycle fixture exercises repeated compaction with oversized multi-turn inputs, and a separate 10,000-module fixture covers 10,002 repository paths, graph extraction, prioritization, bounded rendering, and warm-index reuse. Still add >80-message histories, multiple tool-schema sizes, nested `AGENTS.md` trees, explicit skills and near-budget combinations at several model windows, then verify memory bounds on Termux.
- [implemented; focused tests pass] Add opt-in, local provider-request trace capture at the existing `Agent.run()` → provider adapter boundary and an offline estimator replay analyzer. Captures preserve exact request messages/tool schemas, normalized provider usage, optional native input count, route/window provenance, estimator breakdown, and response/tool-call data; request hashes are verified before replay. Capture is disabled by default, writes atomic `0600` files in a `0700` directory, rejects records over 32 MiB, and never serializes provider configuration credentials or endpoint config. Exact prompt/response content is intentionally retained for token comparison and may itself contain pasted secrets or personal data; operators must keep traces private and review before sharing. The analyzer reports usage presence but cannot independently attest live provider origin. Two user-supplied Mercury-3 datasets are paired with durable session logs: 110/110 and 70/70 exact request/event matches, three and two completed compactions respectively. The 70-capture run contains two 84K usable-budget crossings and is accompanied by a screenshot of the application preflight guard at 84,100 > 84,000 after tool/schema bounding. The shadow replay compares carry/reset/decayed epoch policies; 75%-toward-prior decay gives the best mean/P95 absolute error across these two datasets, but both remain single-route and still show budget-crossing misses. See `docs/research/PHASE14H-REPLAY-ANALYSIS.md`, `docs/research/PHASE14H-CALIBRATION-EPOCHS-2026-11-12.md`, and `tools/phase14h-provider-trace-replay.mjs`.
- [implemented; regression tests pass] Reconcile dedicated durable `provider.usage` records in `tools/phase14h-session-replay.mjs` using the existing `aggregateProviderUsageEvents()` helper. Preserve compatibility with legacy usage embedded in `provider.turn`, avoid counting both representations for the same turn/round, and validate round identifiers without null/blank-to-zero coercion. The user-supplied 136-event session now reports 11/11 provider rounds with usage, 17/17 tool-result pairs and 3 baseline checkpoints; it has no compaction event and does not close the clean-equivalent compaction A/B gate. Single-route estimator drift is diagnostic only; do not apply a global multiplier. See `docs/research/PHASE14H-REPLAY-ANALYSIS.md`.
- [implemented; regression tests pass] Fix the provider-measured compaction gap using OpenCode's measured-plus-estimated compaction anchor pattern and OpenClaude's explicit output/headroom and failure-guard principles. The current `Agent.run()` reuses durable `provider.usage` reports, estimates only the delta since the latest report, uses a bounded route/model/window-specific correction from up to five samples, and performs compaction after final/no-tool responses before returning Ready. Old usage records remain compatible; route switches invalidate the baseline. Add `estimateRequestTokens` to new durable reports and mark reconstructed UI usage with `~`. Regression tests cover resumed OpenAI-compatible sessions and oversized final responses. The second supplied 1,024-event log has 90/90 provider-usage records and 0 compactions; replaying it is diagnostic only and does not itself validate the patched runtime. Upstream: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts and https://github.com/Twigpine/openclaude/blob/main/src/services/compact/autoCompact.ts.
- [implemented; focused regression tests pass; real provider rejection unverified] Add bounded first-request overflow recovery at the existing provider stream boundary. Classify only explicit context-limit failures on HTTP 400/413/422, force one compact to a 72% usable-budget target, persist `provider-context-overflow` compaction events, and retry the request once using the compacted history. A second overflow is surfaced instead of looping; unrelated 400s, auth/rate-limit errors and cancellation do not enter this path. Reuse the existing `ProviderHttpError`, `Agent.run()` retry flow, `maybeCompact()`, and `compactMessages()`; no second retry or compaction subsystem. Upstream review: OpenClaude `autoCompact.ts` forced overflow reason and failure-cooldown design plus `compact.ts` bounded prompt-too-long retry/truncation; TermAgent adapts the safe compact-and-retry subset to its summary compactor. Tests cover common error signatures, unrelated errors, and end-to-end one-time recovery. The supplied screenshot is an application-level post-bounding preflight guard, not a provider rejection; obtain provider-backed overflow evidence before accepting the recovery path.
- [historical traces replayed; deterministic controlled policy harness implemented; provider-backed clean equivalent still open] The supplied 759-event/50-compaction trace and 415-event companion were replayed through the existing SessionStore projection. A new offline harness runs the same canonical route, schema, ordered messages/tool outcomes, additional request overhead, and workspace snapshot identifier against the legacy message/schema-only trigger and the current full request-footprint trigger. Its synthetic 14-request fixture produces 2 estimated-budget overflows under the legacy calculation and 0 under request-footprint-aware accounting (peak estimate 17,545 vs 13,668 tokens). This is a synthetic policy comparison, not proof of provider-tokenizer accuracy, latency/cost improvement, or production-session A/B improvement. Raw historical JSONL files with complete request payloads/provider usage are still required. See `docs/research/PHASE14H-REPLAY-ANALYSIS.md` and `docs/examples/phase14h-controlled-replay.example.json`.
- [candidate implemented; local build/focused tests pass; device validation open] Normal compaction now targets 90% of usable capacity to leave request-growth/model-estimation headroom; explicit provider-overflow recovery retains the more aggressive 72% target. The 84,100 > 84,000 screenshot predates this headroom build and therefore does not validate the candidate. Verify ordinary compaction occurs before the preflight guard and preserves task context on physical Termux.
- [offline calibration-policy comparison implemented] `phase14h-provider-trace-replay.mjs` now compares pre-fix ratio carry, full reset, and decayed priors (25/50/75%) without look-ahead. The 75% decay is the current runtime candidate because it improved mean and P95 absolute error in both supplied Mercury-3 sessions. Add further route/provider datasets and a clean-equivalent task-quality A/B before locking this policy.

### 14I — Background-agent orchestration, session-state integrity, and live event delivery

**Purpose:** Make background work observable and actionable to the running parent agent, remove avoidable session lock contention, and ensure live events reach every attached client without requiring a reconnect. Reuse the existing `TaskManager`, task event log, `SessionStore`, `SessionEventBus`, daemon owner, `TermAgentClient`, tool lifecycle, and command ledger.

- [x] Deliver task lifecycle events to the active parent-agent turn, not only to the durable parent-session mailbox. A child completion/failure that arrives while the parent is reasoning must become structured runtime input or an explicit orchestrator wakeup that the parent can consume before it launches more work. Keep durable notification persistence as the recovery source of truth. Batch 2: `deliverTaskNotification` helper, durable `task.notification.consumed` markers, settlement wakeup at every agent round boundary (round > 0), turn-start consumption retained; durable persistence remains the recovery source of truth.
- [ ] Make parent orchestration await/observe every launched task: capture task IDs, inspect status/results, distinguish queued/running/completed/failed/cancelled/timed-out, and reconcile all child outcomes before declaring completion or deciding to launch more work. Progress events may update structured state; failures/completions must be actionable without flooding the conversation with every progress update.
- [ ] Make notification delivery idempotent and race-safe across active turns, turn boundaries, reconnects, daemon restarts, and duplicate worker completion. A notification must never be lost between durable append, parent wakeup, acknowledgement/consumption, and model-context injection. Preserve child output references for deliberate retrieval.
- [ ] Prevent orchestration loops and duplicate work. Track launched task IDs and scope assignments, detect duplicate/overlapping scopes before launch, detect repeated no-progress launches, bound fan-out/delegation depth/retries, and require a changed cause or configuration before retrying a deterministic failure.
- [ ] Fix child-agent provider credential resolution. `src/tools/parallel.ts`, `src/tools/background.ts`, and `src/tasks/task-provider.ts` currently have duplicated provider-snapshot logic that deliberately removes the in-memory `apiKey` and retains `apiKeyEnv`. Consolidate this behind one daemon-owned credential-reference/resolution path: do not persist raw secrets in task JSON, but guarantee that a worker can securely resolve the exact selected provider/account credential even when the parent key existed only in memory.
- [ ] Snapshot a validated provider/model/account/endpoint/adapter configuration for each child task. Before spawning, verify credential availability and route compatibility without exposing the secret. Return a precise preflight error when unavailable. A 401/403 or invalid credential is terminal for that attempt; do not retry the same credential or spawn replacement agents. Transient network/rate-limit/server errors may use only bounded, configured retries.
- [ ] Unify provider-snapshot construction and credential handling for parallel agents, background agents, specialist agents, and future worker processes. Ensure model, base URL, headers, variant/reasoning settings, output limits, context metadata, and adapter choice are not lost or inferred from unrelated process-global environment variables.
- [ ] Fix session-state lock contention behind `Session state is busy: unable to acquire state lock`. The current `acquireStateLease()` retries 60 times with roughly 10 ms waits (about 600 ms total), which can fail during concurrent session writes. Use bounded backoff with a measured/justified wait policy and diagnostics; distinguish a live owner, malformed/incomplete lock, stale owner, and genuinely stuck operation.
- [ ] Strengthen lock ownership and stale-lock recovery. PID liveness alone is insufficient for robust process identity; use the daemon/worker process-start identity plus token/owner metadata where available. Never remove a live owner's lock merely because a short timeout elapsed. Ensure release is compare-before-delete and crash recovery is safe across Termux process restarts.
- [x] Reduce lock hold time and session-state write amplification. Audit `appendCore()`, trailing-record repair, durable sequence allocation, and repeated history reads. Avoid rescanning/parsing the entire JSONL history for every append where a durable sequence index/checkpoint can safely provide the next sequence. Keep a recovery scan for startup/repair and preserve atomic monotonic sequences across processes. Batch 2: stat-validated `sequenceCache` fast path validated under the state lease, full-scan fallback preserved for external mutation, crash recovery unchanged.
- [ ] Add lock/session diagnostics: owner PID and process identity, operation kind, acquisition wait, hold duration, retry count, recovery decision, JSONL size, sequence/index state, and session ID. Redact prompts, credentials, and sensitive data. Report lock contention separately from corrupt JSONL and stale locks.
- [x] Trace the live event path using stable request/command/event/call IDs from runtime event publication through durable append, event bus, SSE write, client parser, state reducer, and transcript renderer. Identify why tool calls persisted to history but were not shown in the active Web View until stop/reconnect. Do not mark this fixed merely because reconnect replay works. Batch 2 trace conclusion: durable tool-call frames flow via `handleDurableEvent`; the blanket live-event suppression during POST prompt streams hid the rest — suppression is now scoped to the stream's own duplicate sources, and the durable poll is sequence-gated.
- [ ] Ensure tool-call start/input, tool result/output, call IDs, task activity, reasoning/activity, Todo, diff, permission/question, and final message events render while the run is active. Keep the durable event log authoritative; live events are a latency path, not a separate source of truth.
- [ ] On reconnect, replay every missed durable event from the last acknowledged sequence, deduplicate already-applied events, reconcile live-only state from an authoritative snapshot, and avoid duplicate/missing tool cards. Also recover when a client remains connected but its event subscription/reducer silently stops applying frames.
- [ ] Add end-to-end tests that keep a long-running agent active while terminal and browser are both attached. Assert that each tool-call lifecycle transition becomes visible before the agent is stopped, then disconnect/reconnect midway and prove exact convergence without duplicate cards or missing results.
- [ ] Add stress tests with concurrent task completion, several workers appending to one parent session, long JSONL histories, simultaneous browser/terminal subscribers, slow SSE consumers, lock owner crash, stale lock recovery, and daemon restart. Verify no duplicate sequences, lost notifications, orphaned tool calls, or unexplained `Session state is busy` warnings.

### 14J — Universal provider platform, authentication, catalog, and `/provider` experience

**Purpose:** Replace the current three-way provider selection (OpenAI-compatible, Anthropic, Gemini) and catch-all OpenAI-compatible fallback with an extensible provider platform. “Support every type of provider” means supporting the relevant protocol families and authentication patterns through explicit adapters/descriptors, plus custom integrations; do not claim a proprietary protocol is supported merely because its name appears in a catalog.

- [ ] Define one provider descriptor/profile contract that separates provider identity, vendor/gateway, endpoint, transport/protocol, model ID, account, authentication method, custom headers/options, model capabilities, limits, and provenance. Make the daemon-owned provider registry/configuration the single source of truth for terminal, Web View, parent agents, subagents, and background workers.
- [ ] Replace the three-provider hardcoded selection path with an extensible adapter registry. Preserve existing OpenAI-compatible, Anthropic Messages, and Gemini native implementations while making unsupported transport families fail explicitly instead of silently falling through to OpenAI-compatible.
- [ ] Support the major provider protocol families through native or verified adapters: OpenAI Chat Completions and Responses; Anthropic Messages; Gemini native; Azure OpenAI; AWS Bedrock; Google Vertex AI; and OpenAI-compatible gateways/local servers. Keep provider-specific request/response formats, streaming parsers, tool-call semantics, reasoning fields, multimodal payloads, cache metadata, usage accounting, cancellation, and error normalization inside the correct adapter.
- [ ] Build a broad, maintained provider catalog for hosted vendors and gateways (including OpenAI, Anthropic, Google, OpenRouter, DeepSeek, Moonshot/Kimi, Mistral, Groq, Together, Fireworks, Cerebras, xAI, NVIDIA, Novita, Chutes, and others) without equating catalog membership with verified protocol compatibility. Allow custom providers and custom model IDs when catalog data is absent or stale.
- [ ] Support local/self-hosted inference targets including Ollama, LM Studio, llama.cpp servers, vLLM, and generic OpenAI-compatible endpoints, with local endpoint discovery where safe and appropriate. Keep local/no-key auth and cloud-hosted authentication distinct.
- [ ] Implement provider-declared authentication methods: API key, environment variable, OAuth authorization-code/PKCE, OAuth device code, provider CLI/command login, cloud identity/default credentials (AWS/Azure/GCP), local/no-key, and custom header/form credentials where the adapter requires them. Expose only methods actually supported by each provider descriptor.
- [ ] Implement secure credential storage and lifecycle: add, test, activate, rename/label, rotate, deactivate, remove, refresh, expiry handling, account switching, multiple accounts per provider, and secure daemon-side credential references for workers. Never serialize raw keys into task records, event payloads, Web View snapshots, status output, logs, or project files.
- [ ] Add dynamic model discovery from provider-native catalog endpoints and a cached public catalog (models.dev/OpenCode-style pattern where appropriate). Record discovery source, timestamp, account/endpoint scope, and metadata freshness. Catalog failure/offline startup must not disable a previously working manually configured model.
- [ ] Define per-model capability and limit metadata: context window, max output, tool/function calling, streaming, vision/image input, audio/video where supported, reasoning controls, structured output, prompt caching, and supported request formats. Use verified per-model data for context sizing and tool availability; allow explicit user overrides with provenance.
- [ ] Rebuild provider/model interaction around clear responsibilities: `/provider` lists and manages provider profiles; `/connect` (or equivalent command flow) handles authentication/account connection; `/models` discovers, searches, previews, and selects models. `/provider` should support add/list/use/edit/remove/test/status and preserve a manual model-ID path at all times.
- [ ] Adapt LaudaCode's useful `/provider add/list/use/edit/remove`, test-before-save, authenticated model catalog fetch, and manual model-ID fallback. Adapt OpenCode's provider integration catalog, separate connect/model flows, OAuth/command/key/environment methods, account lifecycle, and model metadata. Adapt OpenClaude's descriptor-driven provider/vendor/gateway catalog, API-format selection, route metadata, provider validation, custom headers, local discovery, and secret handling. Reuse these designs in TermAgent's current architecture rather than copying their UI or implementation wholesale.
- [ ] Make API-format/adapter selection explicit for custom providers (for example Chat Completions, Responses, Responses-compatible, Anthropic Messages, Gemini native, and other verified protocols). Allow provider-specific options and headers with schema validation; never guess a protocol solely from a provider display name.
- [ ] Preserve existing provider configuration and behavior during schema migration: current profiles, environment-variable mappings, variants, model overrides, smart routing, role routes, fallback lists, retry policy, reasoning effort, custom headers, and working credentials must survive without requiring users to re-enter secrets.
- [ ] Resolve a complete immutable provider route for every request: provider descriptor + account/credential reference + endpoint + transport adapter + model + variant/capabilities. Parent agents, planning/building/verification roles, specialists, parallel tasks, and background tasks must use the same resolver and report the selected route safely.
- [ ] Define error-class-based fallback. Only configured transient failures (network, timeout, rate limit, eligible server errors) may retry/fallback with bounded limits. Invalid credentials (401/403), missing model, unsupported protocol/capability, malformed request, or permission errors must fail fast with a precise cause. Never create a new child agent as an implicit provider retry.
- [ ] Add provider diagnostics and `/status` projections for selected provider/account/model/adapter, credential source (never secret value), connectivity, context/output limits, capability flags, catalog freshness, retries/fallbacks, and provider error category. Keep the same safe state visible in terminal and Web View.
- [ ] Add adapter conformance tests for request URL/headers/body, response parsing, streaming/chunk fragmentation, tool-call IDs and metadata/signatures, tool-result round trips, multimodal payloads, reasoning, structured outputs, usage/cache fields, cancellation, retries, and 401/403 fail-fast behavior. Test every supported provider family, not just generic happy-path JSON.
- [ ] Add provider security tests for endpoint validation, HTTPS defaults for remote endpoints, explicitly approved insecure/local exceptions, bounded redirects/responses, timeouts, credential redaction, auth refresh races, secret-store failures, and daemon restart. Do not turn the daemon into an unrestricted network proxy through user-supplied URLs.
- [ ] Add Termux/Android validation for provider setup, key entry, OAuth/device-code or command-based flows where supported, long provider/model lists, model search, manual IDs, disconnect/reconnect, and network loss. Ensure the `/provider` UX remains usable on narrow screens and does not require a desktop browser for API-key providers.

**Upstream references and adaptation rules:**

- **OpenCode V2:** use its provider catalog/integration model, `/connect` vs `/models` separation, declared key/OAuth/command/environment methods, provider-specific forms, multiple account lifecycle, custom provider configuration, and model metadata as architectural references. Keep HTTP/SSE and TermAgent's daemon-owned provider state; do not import OpenCode's dependency stack wholesale. References: [OpenCode provider CLI](https://dev.opencode.ai/v2/docs/cli/providers), [OpenCode provider configuration](https://dev.opencode.ai/v2/docs/providers/), [OpenCode provider catalog](https://opencode.ai/docs/providers/).
- **OpenClaude 0.31.0 source archive supplied in this project:** adapt `src/commands/provider/provider.tsx`, `src/components/ProviderManager.tsx`, `src/integrations/descriptors.ts`, `src/integrations/registry.ts`, `src/integrations/providerUiMetadata.ts`, `src/integrations/routeMetadata.ts`, `src/utils/providerDiscovery.ts`, `src/utils/providerValidation.ts`, `src/utils/providerProfile.ts`, and `src/utils/providerSecrets.ts` for descriptors, vendor/gateway catalogs, API-format selection, route metadata, validation, custom headers, local model discovery, OAuth and credential handling.
- **LaudaCode:** adapt the focused provider-management CLI workflow, authenticated catalog fetch, test-before-save behavior, manual model ID fallback, environment/config precedence, and provider status reporting. Its README primarily targets OpenAI-compatible endpoints, so use it as a compact Termux UX reference rather than as the native-protocol coverage target. References: [LaudaCode repository](https://github.com/Anon4You/Laudacode), [provider CLI](https://github.com/Anon4You/Laudacode/blob/main/src/cli.rs), [provider orchestration](https://github.com/Anon4You/Laudacode/blob/main/src/repl.rs).

**14H status:** Active / partially implemented. The runtime now anchors request estimation on the latest route-matching provider-measured context, estimates post-measurement deltas, applies a bounded route-scoped median correction, and checks compaction after final/no-tool responses. A bounded first-request provider-overflow compact-and-retry path is implemented. The UI marks local/recomputed values with `~`. New 2026-11-11 analysis pairs 110 exact provider captures with a 1,161-event durable session log: 110/110 usage records match by timestamp/route/input/output/full-request estimate, 11/11 turns match, and 3 compaction boundaries are replayed. The raw estimate has 40.5% weighted undercount, but a shadow replay of the existing runtime adaptive formula has +0.1% aggregate signed error, 3.5% mean absolute error, 2.1% p50, 13.7% p95, and 29.3% maximum absolute error. One request crossed the 84,000 usable budget at 84,381 while the adaptive prediction was 82,463; native token-count data was unavailable. This single Mercury-3 route confirms the value of existing route-scoped calibration, not a case for a global multiplier. The replay tool now supports `--session-log`, validates matching session identity, replays only prior measurements and compaction resets, and reports budget-crossing misses. Focused provider-trace replay tests: **9/9 PASS**. The 110 captures include 3 completed compactions, but this remains observational evidence, not clean-equivalent legacy-vs-current compaction A/B. The current full repository rerun after this analyzer change passed **85/85 test files; 744/744 tests** at serial concurrency. Remaining: independent provider/model traces, native tokenizer comparison where supported, cold-start and post-compaction calibration evaluation, controlled provider-backed A/B, explicit overflow-path validation, physical Android/Termux validation, workspace-wide usage analytics, multimodal/wire-framing costs, 500K+/1M and device-memory benchmarks, and richer subagent scope/conflict coverage. The previous device smoke was Linux x64 (`termux:false`). Do not start Phase 14I until 14H acceptance is closed.

### Phase 14 gate

- [ ] Phases 14H, 14I, and 14J are complete and their implementation/research reports are linked from `PROGRESS.md`.
- [ ] The active provider/model/endpoint route supplies a verified context window and output limit, with explicit provenance and safe fallback for unknown models.
- [ ] Context accounting includes system/instruction/repository/skill/tool/message/multimodal/output costs; no stale sample/local 12K override or deprecated message-count truncation silently overrides a larger verified route window.
- [ ] Large repositories scale repository-map and retrieval allocations without dumping the entire codebase into the prompt or repeatedly rediscovering already-inspected files.
- [ ] Compaction is driven by the effective request budget, preserves recent complete turns and valid tool-call/result groups, retains machine-readable exploration/read/evidence/task/skill state, and does not cause repeated repository-wide exploration.
- [ ] Global, repository, and nested `AGENTS.md` / `TERMAGENT.md` / `CLAUDE.md` instruction scopes resolve deterministically for parent and child agents; relevant loaded skills survive compaction/restart without permanently loading every skill body.
- [ ] Parent agents receive in-flight child task completion/failure events and handle every launched task. Notifications are durable, delivered, consumed, and deduplicated across turn boundaries/restarts.
- [ ] Child agents resolve the exact daemon-owned provider/account credentials without persisting raw secrets. Provider 401/403 failures fail fast and cannot create retry/spawn loops.
- [ ] Session-state mutation remains sequence-safe under concurrent workers. The lock wait/recovery policy handles live, stale, malformed, and crashed owners without false `Session state is busy` failures or unsafe lock deletion.
- [ ] JSONL/event appends avoid unnecessary full-history rescans while preserving atomic durable sequence assignment and recovery after partial writes.
- [ ] Tool-call/activity/task events appear in the active Web View and attached terminal before a run is stopped. Reconnect replays missed durable events and reconciles state exactly once; the original “tool calls appear only after reconnect” symptom is covered by an end-to-end regression.
- [ ] Provider architecture distinguishes identity, account, credential, endpoint, protocol adapter, model, and capabilities. Unsupported formats fail explicitly rather than falling through to OpenAI-compatible.
- [ ] `/provider`, `/connect`, and `/models` cover provider lifecycle, supported authentication methods, model discovery/search, manual IDs, custom endpoints, local models, and safe diagnostics on mobile and Web View.
- [ ] Native provider adapters and OpenAI-compatible gateways pass adapter conformance tests for streaming, tools, metadata, multimodal requests, usage, cancellation, retries, and error classes.
- [ ] Provider/model state is daemon-owned and identical for terminal, browser, parent agents, subagents, and background tasks; credentials never appear in session/event/browser/log projections.
- [ ] Browser and terminal remain equivalent runtime clients; permissions/questions are deterministic; reconnect, daemon restart, task recovery, lock recovery, and cancellation are tested.
- [ ] Run the full repository test suite, focused 14A–14J suites, TypeScript/build/package checks, browser distribution/syntax checks, daemon restart/reconnect tests, and physical Termux/Android/Brave/Chrome validation. Record known unrelated failures explicitly; do not call a timed-out aggregate test run a pass.

---

# Phase 15 — VS Code integration (discontinued / deferred indefinitely)

**Roadmap decision (2026-11-01):** Phase 15 is no longer an active milestone. Do not allocate implementation or maintenance work to a VS Code extension while the browser/cloud roadmap is the primary target. Preserve the generic protocol, typed client, presentation-independent runtime, and extension-friendly contracts. The original 15A–15D specification is preserved unchanged in `docs/research/PHASE15-DEFERRED-SPEC.md`; reopening requires an explicit roadmap decision.

# Phase 16 — Selected capability completion

**Roadmap decision (2026-11-01):** actively complete 16A, 16B, 16D, 16E, and 16F. Defer 16C notebooks. Existing partial foundations are not considered completion; each capability requires the scoped deliverables and its own regression gate.

### 16A — LSP/code intelligence (SELECTED; diagnostic tracker exists, LSP manager missing)

- [verified] Retain the existing 13N-E asynchronous diagnostic state tracker and EvidenceLedger integration as the diagnostics state contract.
- [ ] Implement a provider-neutral JSON-RPC language-server process manager, capability negotiation, lifecycle, stderr/log handling, timeout and restart policy.
- [ ] Implement diagnostics after edits.
- [ ] Implement definitions/references/symbol search where supported.
- [ ] Feed LSP evidence into repository retrieval and verification without making LSP mandatory for unsupported languages.
- [ ] Make server process lifecycle durable/recoverable.

### 16B — Web tools (SELECTED; agent-facing tools not present)

- [ ] Define and test network permission policy before exposing general web requests.
- [ ] Add bounded fetch/search result storage and context projection.
- [ ] Preserve complete results out-of-band where useful.
- [ ] Add SSRF, redirect, size, timeout, content-type, and authentication safety controls.

### 16C — Notebook/structured document editing (DEFERRED)

No implementation is scheduled. The deferred scope is preserved in `docs/research/PHASE16C-NOTEBOOKS-DEFERRED-SPEC.md`; do not add notebook dependencies as part of the selected Phase 16 roadmap.

### 16D — Structural repository intelligence (SELECTED; useful foundation exists)

- [verified] Retain the existing file inventory, cached JS/TS/Python analyses, import edges, structural rank and token-bounded repository map.
- [ ] Replace or supplement metadata-only cache identity with content hashes and precise incremental invalidation.
- [ ] Improve language coverage and parser fallbacks while retaining lexical fallback.
- [ ] Add dependency/reference graph persistence and incremental invalidation.
- [ ] Fuse lexical, structural, symbol, and recent-session evidence.
- [ ] Use exploration state to avoid redundant reads/searches.

### 16E — Memory and project knowledge (SELECTED; no unified persistent project-knowledge store)

- [ ] Define a workspace-scoped, provenance-bearing, inspectable knowledge record and lifecycle.
- [ ] Separate durable user/project knowledge from repository-derived facts.
- [ ] Add explicit memory provenance and invalidation rules.
- [ ] Add optional semantic/vector retrieval without coupling core session truth to one storage engine.
- [ ] Make memory import/export inspectable and reversible.

### 16F — Advanced provider protocol maturity (SELECTED; base provider platform moved into Phase 14)

**Scope boundary:** Phase 14J now owns the provider registry, profile/auth lifecycle, model catalog, selected protocol adapters, provider manager, model capability metadata, and their conformance/security gate because the canonical Phase 14 daemon and Web View must manage the same provider state. Do not duplicate that work here.

- [verified] Preserve typed provider stream events, AbortSignal cancellation, retry/backoff, Retry-After handling, cancellation during backoff, idle-stream distinction and partial-output replay safeguards from 13N-F.
- [ ] Extend provider-specific structured-output, multimodal/audio, batch, caching, and advanced reasoning contracts beyond the Phase 14 minimum only where a supported provider/model requires them.
- [ ] Add deterministic recorder/replay and differential conformance fixtures for newly adopted advanced protocol features, reusing the Phase 14 adapter test harness.
- [ ] Add a provider-specific transport adapter only when a real provider requires a protocol not already covered by the Phase 14 registry; this is separate from deferred Phase 14G browser WebSocket transport.

**Selected 16A/16B/16D/16E/16F scope is authoritative; 16C remains deferred.**

### Phase 16 gate

- [ ] Every deferred capability has an explicit adopt/adapt/rewrite/defer decision.
- [ ] No capability is intentionally degraded solely because it is complex.
- [ ] New capabilities integrate with the canonical session/interaction/protocol architecture.

---

# Phase 17 — Persistent runtime operations, notifications and Telegram companion (PLANNED)

This phase follows Phase 14 closure and the selected Phase 16 capabilities. It prepares TermAgent for reliable 24/7 operation without beginning Phase 18 cloud workspace deployment. The single daemon selected in Phase 14F is the only agent/runtime owner.

### 17A — Repository and runtime-state architecture migration and cleanup

- [ ] Follow `REPO-STRUCTURE.md` and `AGENTS.md` when current layout blocks correct evolution.
- [ ] Move newly developed protocol schemas and canonical interaction semantics into their domain modules.
- [ ] Keep the browser app under `web/`; do not create an active VS Code extension track.
- [ ] Mirror tests into domain-specific `tests/` structure.
- [ ] Consolidate legacy duplicate helpers and eliminate parallel implementations.
- [ ] Split oversized runtime/server modules where ownership is mixed; remove compatibility shims only after characterization tests.
- [ ] Keep one authoritative implementation for every production capability.
- [ ] Use `docs/research/OPENCLAUDE-TERMAGENT-RUNTIME-STORE-REVIEW-2026-11-12.md` as the storage-layout characterization; it compares runtime user-data roots, not source repository trees.
- [ ] Introduce one central runtime path resolver and configurable state root, with explicit owners and state classes (durable truth, derived cache, referenced artifact, sensitive diagnostics). Preserve the current root by default.
- [ ] Add a stable project/workspace identity index and project/session views without exposing raw absolute paths as directory names. Keep the canonical `SessionStore` JSONL contract and flat-path reader during the first index rollout.
- [ ] Evaluate project/session grouping for session and task records only after characterization tests cover create, load, append, fork, restore, concurrent writer, daemon restart, cleanup and legacy flat-path access. Any move must be versioned, atomic, idempotent, lock-safe, restart-recoverable and rollback-compatible.
- [ ] Group task records/events by session through an index/path resolver while preserving task IDs and parent/child relationships; do not change task identity or event-sequence semantics as a layout-only refactor.
- [ ] Keep provider traces isolated by capture run/session and make export archives land outside the live trace directory. Preserve opt-in defaults, private permissions, secret sanitation and explicit content-retention policy.
- [ ] Define lifecycle/retention for drafts, tasks, tool-output references, repo-map caches, provider traces, plugin downloads and snapshots. Never garbage-collect a referenced output, live task/session, or recoverable snapshot.
- [ ] Treat `snapshots/<sessionId>/` as an opaque Git repository. Do not reorganize, shard or rewrite its internal Git object-store paths; lifecycle operations may act only at the enclosing snapshot boundary.
- [ ] Provide migration dry-run, manifest, verification, resumability, rollback and post-migration audit before removing any legacy paths. Never delete a source path until the destination is verified and readers have switched safely.

### 17B — Runtime notification service and durable outbox

- [ ] Define renderer/platform-neutral notification intents sourced from canonical run/task/permission/runtime events.
- [ ] Add a daemon-owned durable outbox with dedupe identity, claimed/delivered/failed/unknown states, retry metadata and restart recovery.
- [ ] Separate agent execution outcome from notification delivery outcome; never rerun work merely because delivery failed.
- [ ] Add notification preferences by category, project/session/task, importance, quiet hours, coalescing and rate limits.
- [ ] Redact secrets and sensitive command/tool output before any external delivery; emit auditable records without storing unnecessary payload data.
- [ ] If a model-facing `notify_owner` intent is added, it must have no recipient argument and may target only the paired owner under policy. Do not add generic arbitrary-target `send_message` to the default ToolRegistry.

### 17C — Telegram owner companion (initially single-user/private)

- [ ] Add an optional TypeScript Telegram Bot API adapter owned by the runtime daemon; do not add a Python agent or parallel orchestration runtime.
- [ ] Implement explicit owner pairing, expiry, one-time use, rate limiting, revocation and one private chat scope. The owner must first start the bot.
- [ ] Keep the bot token daemon-only; never expose it to browser assets, prompts, shell/task/plugin child environments or logs.
- [ ] Deliver opted-in run completion/failure, permission-required deep-links, milestone, scheduled-report and daemon-health notifications.
- [ ] Respect Telegram text length, per-chat pacing, 429 `retry_after`, message formatting and ambiguous-delivery handling; no token-per-message streaming.
- [ ] Persist inbound update cursor/dedup if pairing or commands use long polling/webhooks. Configure one ingress mode only.
- [ ] Keep Telegram approval/control commands deferred until they route through the same canonical command/PermissionGate contract and pass multi-client parity tests.

### 17D — Scheduled and event-triggered automation

- [ ] Add user-owned one-shot/recurring schedules with pause/resume/edit/trigger/remove and timezone-aware next-run calculation.
- [ ] Run scheduled agent work in fresh, bounded sessions with selected skill/model policy and a durable execution ledger.
- [ ] Separate scheduler trigger, agent execution and outbound delivery interfaces.
- [ ] Support a restricted script-only/no-agent job mode only after workspace execution is isolated and resource-limited.
- [ ] Add authenticated external event triggers (for example GitHub webhook) with signature validation, dedupe and the same job admission ledger.
- [ ] Prevent recursive or runaway scheduling from scheduled-agent sessions.

### 17E — Daemon health, watchdog and operational recovery

- [ ] Expose runtime owner, heartbeat, provider connectivity, scheduler health, outbox backlog and degraded reasons.
- [ ] Add bounded graceful shutdown, task settlement, interrupted-run recovery and supervisor-compatible exit semantics.
- [ ] Add stale-heartbeat/watchdog behavior without treating an ordinary Telegram/network disconnect as a process failure.
- [ ] Send deduplicated owner notifications on degraded/recovered state transitions.
- [ ] Test abrupt kill, restart, network outage, Telegram 429/5xx, failed delivery, ambiguous send timeout and scheduler restart.

**Phase 17 exit criteria:** one daemon owns the runtime; owner notification routing is secure and auditable; delivery is restart-safe and distinct from execution; scheduled work is bounded/recoverable; operational health is observable. Phase 17 does not implement cloud workspaces or public multi-tenant deployment.

---

# Phase 18 — TermAgent Cloud Edition (future direction; NOT ACTIVE)

This is a strategic architecture direction only. Do not start deployment or build the cloud product until Phase 14 and selected Phase 16 capabilities have been audited and closed. Preserve these design constraints while implementing earlier work: TermAgent remains the single agent engine; local and cloud use the same Agent/ToolRegistry/provider/session/protocol contracts; a local or remote `ExecutionEnvironment` adapter owns filesystem/process operations; provider credentials remain in the control plane; untrusted build/test/shell commands run in a workspace sandbox rather than as children of the public API process.

Future workstreams are 18A cloud runtime foundation, 18B workspace manager/Git import, 18C sandboxed remote execution, 18D extension of the existing mobile-first Web View, 18E workflows built from existing specialist agents, and 18F persistence/recovery/observability/resource budgets. Phase 14F has selected a single-daemon topology: the same daemon/control-plane owner serves local terminal, browser and (after Phase 17) Telegram clients; cloud workspaces are execution adapters, not additional agent runtimes. Railway is the preferred control-plane candidate and its separate VM Sandbox API should be evaluated as the first workspace adapter; untrusted commands must never run as children of the control-plane service. Compare Railway Sandboxes with Daytona/E2B/Coder-style execution, including private-network reachability, persistent workspace lifecycle, resource caps and current cost, before selecting infrastructure.

**Entry gate:** Phase 14 secure remote access and single-daemon multi-client parity are complete; selected Phase 16 work and Phase 17 persistent operations/notification gates are complete; secrets are separated from workspace execution; workspace isolation/resource limits and persistent storage/recovery have been tested; cost/hosting review is current.

# TermAgent architecture owners

Keep protocol, session, tool, UI, plugin, skill, context, and release decisions tied to the owning module documented in `ARCHITECTURE.md` and `REPO-STRUCTURE.md`.


# Historical completed work

The 1.7 execution-safety, semantic loop detection, completion gate, provider manager, and earlier UI primitives remain historical baseline work. Phase 12 supersedes the visual treatment of the transcript, picker, diff, permission/question interaction, and active Todo surfaces while preserving their underlying behavior and contracts.

# TODO maintenance rules

- [verified] Every phase implementation starts only after its upstream research/contract section is understood; the 2026-11-01 architecture/research review is recorded before 14E/14F implementation.
- [ ] Never mark a task complete from intention alone. Link completion to code/tests/report evidence.
- [ ] When a plan changes, update this file and `ARCHITECTURE.md` in the same planning change. External feature imports must cite the inspected upstream revision and record adopt/adapt/defer decisions; see `docs/research/TERMAGENT-HERMES-AGENT-RESEARCH-2026-11-01.md`.
- [ ] Keep historical reports immutable unless correcting a factual error; use current architecture/TODO documents for new decisions.
- [ ] A newly discovered architectural flaw may introduce a hardening phase before a rollout gate. Do not force flawed work through a numbered gate merely to preserve numbering purity.

# Phase gate rule

A phase is not marked complete until its implementation, focused regression tests, full suite, build, package dry-run, source-hygiene scan, extracted-artifact smoke test, and all phase-specific recovery/concurrency/replay checks pass. After a passing phase, stop and propose the next phase rather than silently starting it.


### XML / loop-safety follow-up

- [x] Prevent task execution metadata (`taskId`) from activating semantic exploration no-progress detection.
- [x] Regression-test three distinct `bash` verification calls followed by a fourth model response.


## 2026-11-12 — Phase 14H epoch calibration and runtime-store architecture review

Reviewed the user-supplied `~/.openclaude` and `~/.termagent` runtime trees and inspected OpenClaude `sessionStorage.ts`, `envUtils.ts`, `memdir/paths.ts`, and `autoCompact.ts`, plus OpenCode `session/compaction.ts` and `session/usage.ts`. This is a runtime-data comparison, not a source-repository comparison. TermAgent already has domain-owned session, snapshot, task, tool-output, repo-map, plugin and provider-trace stores; the inconsistency is mainly flat session/task/trace layouts and the lack of one central project/session path index. The 41k+ entries beneath TermAgent snapshots are Git object-store internals and remain opaque. Recorded future layout work under Phase 17A; no state migration is started in Phase 14H. See `docs/research/OPENCLAUDE-TERMAGENT-RUNTIME-STORE-REVIEW-2026-11-12.md` and the new runtime-state section in `ARCHITECTURE.md`.

Audited compaction calibration lifecycle: pre-compaction rolling ratios had survived a changed context projection. Implemented a bounded 75%-toward-prior one-request warm start after micro-prune/full compaction, while clearing old baseline/samples. The replay can compare carry/reset/decay25/50/75 without look-ahead. Across two supplied Mercury-3 datasets (110 and 70 captures), decay75 achieved mean/P95 absolute errors of 3.1%/11.4% and 4.7%/14.0%; it outperformed carry and full reset on mean/P95 in both. Budget-crossing misses remained (one and two respectively), so this does not resolve trigger timing. New report: `docs/research/PHASE14H-CALIBRATION-EPOCHS-2026-11-12.md`. `npm run build` PASS; focused Phase14H provider-trace/context-continuity tests 30/30 PASS; complete parallel repository suite 744/744 PASS; `node scripts/verify-dist.mjs` PASS; `npm pack --dry-run` PASS (325 files; 501.7 kB). The serialized `npm test` runner timed out at the 180-second execution limit without a final TAP summary and remains unresolved. Physical Termux/headroom validation, cross-provider data and provider-rejected overflow evidence remain open. Phase 14H remains IN PROGRESS; Phase 14I has not started.

## 2026-11-12 — Phase 14I batch-1 work division and contribution workflow

Phase 14I P0 work is divided into four non-overlapping work streams so parallel execution cannot collide at file level. Each stream owns its files exclusively; shared docs (`TODO.md`, `PROGRESS.md`, `ARCHITECTURE.md`) are updated only at integration, not by individual streams. Coordination contract for the second maintainer and downstream starter work: `docs/COLLABORATION-STARTERS.md`.

### 14I-S1 — Child-agent provider credential resolution (TODO 14I items 5–7)

- [ ] Consolidate the three duplicated provider-snapshot builders (`src/tools/parallel.ts`, `src/tools/background.ts`, `src/tasks/task-provider.ts`) behind one authoritative snapshot builder in `src/tasks/task-provider.ts` with identical behavior at every call site.
- [ ] Add a daemon-owned task credential store (`src/tasks/task-credentials.ts`) for provider keys that exist only in memory, mirroring the established 0700/0600 atomic-write pattern in `src/cli/daemon-credentials.ts`. Task JSON must never contain raw keys.
- [ ] Worker-side credential resolution with precise preflight errors: credential reference → resolvable env var → no-key local parity. A missing or corrupt reference fails with an explicit cause instead of a silent 401.
- [ ] TaskManager lifecycle sweep removes orphaned and retention-expired credential files while keeping files for resumable tasks.
- [ ] S3's one-line `fileURLToPath` fix in `src/tasks/manager.ts` spawnWorker is applied by this stream because it owns the file.

**File ownership:** `src/tasks/**`, `src/tools/task.ts`, `src/tools/background.ts`, `src/tools/parallel.ts`, `tests/tasks/`, `tests/phase14f5-subagents.test.mjs`.

### 14I-S2 — Session-state lock hardening (TODO 14I items 8–11)

- [ ] Replace the fixed 60×10 ms lease loop in `src/session/store.ts` with bounded exponential backoff plus jitter under a configurable, justified wait policy.
- [ ] Classify live owner / malformed lock / stale owner / stuck operation; never remove a live owner's lock merely because a short timeout elapsed; release remains compare-before-delete.
- [ ] Add redacted lock diagnostics: owner PID, operation kind, acquisition wait, retries, recovery decision, session identity; report contention separately from corrupt JSONL and stale locks.
- [ ] The durable-sequence append optimization (avoiding full-history rescans) is deliberately deferred to batch 2; this stream does not change the JSONL append contract.

**File ownership:** `src/session/**`, `tests/session/`.

### 14I-S3 — Windows port hardening (batch 1)

- [ ] Add one shared home-directory resolver in `src/util/` and use it from owned callers; `process.env.HOME` is unset on Windows and `src/config/config.ts` currently falls back to cwd for user-level config.
- [ ] Add a Windows process-group termination path (`taskkill /T /F` semantics) in `src/util/child-process.ts` alongside the POSIX group-kill path.
- [ ] Fix Windows-broken worker entry resolution (`URL.pathname` → `fileURLToPath`) — applied by 14I-S1 because it owns `src/tasks/manager.ts`.
- [ ] Audit and report (report-only, no edits outside ownership): Windows shell selection (`SHELL` absent), ANSI/VT enablement and raw-mode behavior, `src/server/daemon-owner.ts` Linux process-start identity fallback, long-path and mixed-separator handling in `src/tools/**` and `src/tasks/**`.

**File ownership:** `src/util/**`, `src/config/**`, `src/cli/**`, `src/server/daemon-owner.ts`. Findings for other streams are reported, never edited directly.

### 14I-S4 — Install website (batch 1)

- [ ] Build a static, zero-dependency install/landing site under `web/site/` (separate from the `web/app/` Web View): hero with animated terminal mock, install tabs for cmd / PowerShell / npm with working copy buttons, feature cards, scroll-driven animations, reduced-motion support.
- [ ] Use only real package facts: `npm install -g @whoops-1/termagent` requires Node ≥ 22 (`engines`), binary `termagent`, programmatic client and protocol subpath exports; include the source-clone and build path.
- [ ] All visuals are self-contained inline SVG/CSS; no external network assets and no build step, so the site works from any static host and in restricted networks.
- [ ] When it lands, add the `web/site/` ownership note to `REPO-STRUCTURE.md` in the same change.

**File ownership:** `web/site/**` only.

### Batch-2 queue (starts only after batch-1 integration)

- [x] Live event delivery trace: establish why tool calls persisted to history were not visible in the active Web View until stop/reconnect; the SSE durable poll is 1 s and child-process appends are only observed by that poll (TODO 14I items 12–14). Batch 2 landed the durable-sequence fast-path gate before durable poll replay pages and narrowed Web View live-event suppression to the foreground prompt stream's duplicate sources (`session.text.delta`, `session.reasoning.delta`, `runtime.activity.changed`, `session.tool.output.delta`); the ≤1 s delivery floor for detached-worker appends is documented at the gate.
- [x] Parent orchestration wakeup: deliver task lifecycle events into the active parent-agent turn with idempotent, race-safe notification delivery (TODO 14I items 1–4). Batch 2 landed the `deliverTaskNotification` helper with durable `task.notification.consumed` markers and child-task settlement wakeup at every agent round boundary (round > 0), turn-start consumption retained; Windows EPERM is now classified as lock contention alongside EEXIST.
- [x] Durable-sequence append optimization: avoid full-history JSONL rescans per append while preserving atomic monotonic sequences (TODO 14I item on write amplification). Batch 2 landed a stat-validated in-memory `sequenceCache` fast path for `nextDurableSequence`/`currentSequence` with authoritative full-scan fallback on external append/truncate, plus turn-lease token compare-before-recover and mtime/size confirm guards.

### Batch-1 integration gate

- [x] One owner per file held; no stream edits shared docs.
- [x] After all four streams land: one sequential `npm run build`, focused regression pass for `tests/tasks/`, `tests/session/`, and the touched Phase 14 suites, `npm pack --dry-run`, and source-hygiene scan. Executed 2026-11-12 at the batch-2 integration gate: build PASS, focused regressions PASS, pack dry-run PASS (331 files), `verify-dist.mjs` PASS, full-tree bounded sweep 886 tests with every failure stash-verified as pre-existing Windows debt.
- [x] `PROGRESS.md` receives one consolidated batch-1 entry written at integration; individual streams return summaries instead of editing shared docs. Landed as the consolidated 2026-11-12 Phase 14I entry covering batch-1 + batch-2.

**Contribution workflow (2026-11-12):** the main dev repository is `whoops-1/termagent`; contributions flow through the `Tauseef666-ctrl/termagent` fork with branch-based pull requests so both maintainers can review before landing on `main`. No direct pushes to `main` for phase work.
