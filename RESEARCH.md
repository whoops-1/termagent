# TermAgent Research Notes

These notes record the engineering decisions that shaped TermAgent's runtime, UI, extensibility, and mobile behavior. They describe the resulting contracts and the reasons behind them rather than tying the implementation to any particular external codebase.

## 0.9 — Commands, sessions, and checkpoints

TermAgent's command system supports Markdown command templates with `$ARGUMENTS`, positional arguments, shell-output interpolation through `!` backtick expressions, `@` file references, and optional agent/model/subtask selection. These features are implemented with Node primitives and share the normal permission and session lifecycle.

Session continuation and forking are first-class operations. The session store is JSONL-based, while checkpoints provide explicit restore-to-boundary semantics without rewriting conversation history.

The portability boundary stays deliberately small: shell execution uses the host shell, file access uses Node filesystem APIs, and checkpoints use the existing JSONL session store. No native database or architecture-specific runtime is required for these features.

## 1.0 — Interactive terminal architecture

The terminal layer keeps logical input state separate from rendering and runtime execution. Prompt text, cursor offset, visual line/column, history, paste state, and editing mode are maintained by the input layer; `TerminalUI` owns geometry, painting, terminal modes, and modal surfaces.

Prompt editing never owns agent/provider state. Permission and question selectors temporarily become the input owner while visible, then return ownership to the composer. This prevents readline-style buffering from competing with the raw terminal UI.

The renderer remains Node + ANSI/VT rather than depending on a heavyweight UI framework. The same separation also makes the model usable for the later Web View without making the terminal renderer authoritative.

## Phase 2 — Context intelligence

The repository map is intentionally structural: it enumerates relevant files, extracts useful symbols and relationships, and presents a bounded view instead of attempting to index an entire workspace in one request. TermAgent keeps the implementation dependency-light and uses bounded regex-based analysis where that is sufficient.

Compaction is model-aware enough to account for system content, tool schemas, recent conversation, and output headroom. The runtime keeps a recent tail and a deterministic local summary so compaction does not require another provider round trip.

## Phase 3 — Execution intelligence

The workflow layer separates planning, building, exploration, verification, and recovery. Durable task records own long-running work; bounded workspace-scoped workers handle parallel specialist operations; provider routing can vary by role without moving orchestration state into the UI.

Cross-process state uses filesystem leases and atomic JSON/JSONL persistence. This keeps recovery deterministic on Termux and avoids introducing a second database solely for coordination.

## Phase 4 — Plugin marketplace and skill discovery

Plugin packages are metadata-first. Marketplace registration, plugin state, component discovery, trust policy, blocklists, revision tracking, and reconciliation are separate concerns with explicit persistence boundaries.

Skills are treated as prompt content rather than executable plugins. Discovery exposes cheap descriptor metadata first; full `SKILL.md` bodies are loaded only when needed. Realpath checks and SHA-256 verification protect the load boundary.

The package layer accepts both the compatible `.claude-plugin/plugin.json` manifest location and the native `.termagent-plugin/plugin.json` alias. This is a compatibility contract, not a reason to introduce another plugin runtime.

## Phase 7 — Trust, integrity, and supply-chain controls

Downloaded plugin content is treated as mutable input. Installation records source identity, content digest, and revision; trust approvals are invalidated when any of those inputs change.

Plugin tree digests are deterministic, cached marketplace manifests are rechecked before use, symlink escapes are rejected through realpath containment, and malformed security policy fails closed. Skill content is scanned before discovery and again immediately before full-body invocation.

The security model deliberately keeps enforcement local. Remote feeds can provide policy data later, but the runtime must remain able to make a deterministic decision from local state.

## Phase 8 — Dependency and lifecycle reconciliation

Marketplace declarations and installed state are kept separate. Dependencies are resolved deterministically, cycles and missing dependencies are detected before activation, and local mutations are serialized so concurrent refresh/update actions cannot corrupt state.

An `update-available` state never unloads the currently working version mid-session. Startup reconciliation repairs orphaned or dependency-broken records while leaving user-owned marketplace material intact.

## Phase 9 — Context budget and performance

Warm paths avoid unnecessary hashing and repeated parsing. Skill descriptors use metadata for cache reuse, while live skill loading performs full integrity checks. Tool schemas are cached at the registry boundary, and final context bounding remains in the agent layer.

In-memory caches are bounded and concurrent work is coalesced where duplicate filesystem work would otherwise accumulate. No background network activity is introduced merely to improve perceived performance on mobile devices.

## Phase 10 — Pure-skill registry

Pure skills are distributed independently from executable plugins. Registry entries carry version, source, SHA-256, trust, and optional revocation metadata. Installation stages content before activation, validates path and metadata boundaries, and keeps cached revocation state separate from ordinary skill content.

Remote registry handling uses explicit size and timeout limits, HTTPS/localhost restrictions, redirected-URL validation, and the existing skill-content scanner. Stale metadata is visible rather than silently promoted to current truth.

## Phase 11 — Release hardening and migration

Migration is non-destructive. Existing TermAgent-compatible roots remain in place, while configuration aliases are normalized into canonical fields with backups and atomic writes.

`/doctor` stays observational. It reports structured health information without refreshing remote state simply because diagnostics were requested. Human-readable and JSON diagnostics are generated from the same report model.

## Phase 13 — Read coverage, exploration, verification, and provider reliability

The exploration system separates discovered files, file versions, covered ranges, search novelty, symbols, verification facts, and progress. Read coverage is durable enough to survive compaction and checkpoint restore, while telemetry remains derived from the same runtime state.

Loop protection compares meaningful execution identity rather than transient timestamps or output details. Exploration guidance adds strategy changes when calls stop producing new evidence, while the runtime remains authoritative over execution and safety.

Post-edit verification is routed through durable task infrastructure. Evidence ledgers retain concrete facts such as changed paths, verification commands, diagnostics, and read coverage rather than relying on a generic success flag.

Provider reliability keeps retry classification, stream-idle detection, content-aware overflow handling, and tool-call accumulation at the provider/runtime boundary. Once a stream has emitted meaningful content, fallback must not silently replay the same partial turn through another provider.

## Phase 13N-I — Semantic UI and visual system

The UI is built around semantic state rather than ANSI string parsing. Themes expose semantic tokens, banners use responsive layouts, effects are bounded to the banner/activity region, and selection surfaces share hit-target geometry across keyboard, mouse, and touch.

Markdown tables use a structured table model with column widths, alignment, Unicode-aware measurement, wrapping, and narrow-terminal layouts. Composer state, queued prompts, user messages, and exploration HUD data are semantic projections of runtime state rather than independent UI copies.

Queued prompts belong to the runtime. The UI exposes edit, cancel, reorder, and state transitions without taking ownership of execution. The composer stays interactive while the agent works, and only the explicit interrupt command cancels the active turn.

## Phase 13N-I — Text tool-call compatibility

Some providers can emit tool requests as text markup rather than structured calls. TermAgent recognizes a narrowly defined XML-style form only when the function is available in the current tool set.

Recovered calls enter the normal permission, lifecycle, loop-guard, exploration, and execution path. The streaming layer withholds a possible protocol block so raw markup is not painted into the transcript. When tools are disabled by the loop guard, the markup is suppressed rather than executed.

## Phase 13N-J — Mobile process and release hardening

Managed processes own their POSIX process group, use bounded termination escalation, retain bounded output previews, and enforce explicit stdin deadlines. Descendant cleanup is part of the task lifecycle rather than an incidental shell cleanup step.

Release bundles are target-aware even though the main TermAgent artifact is JavaScript. Target metadata distinguishes Android ARMv7 from Linux ARMv7, release archives are deterministic, SHA-256 manifests are published with the bundles, and the installer prefers a verified prebuilt artifact before falling back to a source build.

The final mobile gate is physical Termux execution. Emulation and CI can validate architecture-specific behavior, but only the device can confirm the Android/Bionic runtime boundary and the full installed CLI path.
