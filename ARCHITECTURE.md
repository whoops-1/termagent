# TermAgent Architecture

## Architecture capability posture

TermAgent is a general-purpose coding-agent platform with a zero-dependency foundation. Mobile/Termux compatibility is a supported deployment target and portability requirement, not a ceiling on feature scope or architectural ambition. New capabilities should be evaluated on correctness, security, maintainability, extensibility, and value. Resource cost should be engineered and bounded where appropriate, but should not by itself be used to discard a mature, high-value capability.

The architecture therefore prefers full semantic implementations with clean extension points over deliberately degraded feature subsets. Optional integrations such as LSP, Web View, VS Code, network tools, richer indexing, and advanced plugin capabilities may be layered onto the same core without changing the authoritative runtime model.
## Phase 3 execution intelligence

the corresponding module is the execution controller used by autonomous runs. It persists planning, building, verification, iteration, and terminal blocked/complete states through `SessionStore`, filters tools by phase, and requires a successful `verify_project` result before completion. Recovery is bounded by autonomous step, verification-failure, repeated-tool, and no-progress limits.

the corresponding module and the corresponding module use filesystem leases and atomic replacement to keep task records and event sequences safe across separate TermAgent processes. `parallel_agents` adds cross-process session admission control and explicit in-project workspace scopes. Scoped workers remove recursive agent-launch, arbitrary shell, and Git capabilities while the existing file tools enforce scope boundaries.

the corresponding module supports role-specific provider selection for planning, building, verification, and subagent work while preserving the existing retry/fallback rule that a provider that has already emitted output must not silently hand the turn to a different model.

The execution architecture is organized around explicit agent phases, durable task workers, provider routing, verification, and bounded recovery while keeping the runtime Node-only for ARMv7 Termux.

## Phase 2 context intelligence

Phase 2 consolidates repository intelligence into four layers. the corresponding module enumerates workspace files with Git/ripgrep/Node fallbacks, caches per-file analysis outside the project, extracts TypeScript/JavaScript/Python symbols, resolves common import forms, and builds a directed dependency graph. Structural rank combines dependency counts with inverse document frequency and PageRank-style propagation.

the corresponding module fuses lexical path matches, bounded `rg` content matches, symbol-definition proximity, explicit focus selectors, and graph-neighbor boosts. Results are capped by file count, UTF-8 bytes, and token estimates. The `repo_map` tool and `/repomap` CLI expose the same structural view without requiring a model request.

the corresponding module owns conservative, Unicode-aware token estimation and request-budget calculations. `Agent` performs the budget check after the user prompt is persisted and before the first provider request, so the new turn cannot create an avoidable context overflow. Tool schemas are counted as part of the request.

the corresponding module keeps the durable JSONL transcript unchanged while producing a bounded active projection. System instructions are preserved exactly when they fit, recent whole turns are retained atomically, previous summaries are folded into later summaries, and tool-call/result evidence is not split. When the irreducible system/schema budget is too large, the agent fails before calling the provider instead of silently truncating instructions.

Repository intelligence and compaction stay Node-only and native-dependency free for ARMv7 Termux.
## Phase 4 application and service architecture

Phase 4 establishes the application/runtime boundary independently of any one presentation surface. The terminal is a client of the runtime, not the owner of agent/session semantics. The same principle is used for future Web View and VS Code clients.

```text
                         Canonical Runtime
                              |
          +-------------------+-------------------+
          |                   |                   |
     SessionStore        TaskManager        Interaction/Events
          |                   |                   |
          +-------------------+-------------------+
                              |
                     Client Transport Layer
                     /          |          \
                  HTTP/JSON    SSE      future WS
                   /            |            \
                  /             |             \
        Terminal Client     Web View Client    VS Code Client
          (ANSI/VT)          (HTML/CSS/JS)       (Webview)

All clients submit semantic commands to the same runtime and receive the same
canonical session/runtime events. No client executes agent/tool side effects
directly.
```

the corresponding module, the corresponding module, and the corresponding module remain independent utilities. `PromptEditor` owns terminal-local draft editing, while the runtime owns durable session state, agent execution, task state, permissions, questions, tool lifecycle, and canonical interaction events. A presentation client may have its own transient layout/scroll state, but user actions that affect the session are submitted through the shared interaction contract.

The client SDK is dependency-free and generated directly from the public TypeScript API surface. Streaming methods use cancellation-aware readers and always release the underlying response body. The protocol is transport-neutral: HTTP + SSE is the initial local/remote transport, while a future WebSocket transport may be added without changing command/event semantics.

## 0.4 session resilience

The active model context is a projection of the durable JSONL session. the corresponding module performs conservative token estimation and replaces older active messages with a bounded local summary while leaving durable events intact. `SessionStore.fork()` creates a new durable session with parent metadata and a copied history prefix.

Provider resilience is separated from providers themselves. the corresponding module classifies transient failures and applies bounded exponential backoff. the corresponding module composes multiple existing provider implementations into a deterministic fallback chain. No provider implementation needs to know about fallback policy.
## Skills and diagnostics
Skills are loaded as Markdown instruction bundles at runtime and selected lexically per user turn. Diagnostics are implemented with Node built-ins so ARMv7 Android remains the baseline.

## 0.6 Autonomous and Background Execution

Autonomous mode is not a second agent implementation. It reuses the existing Agent, ToolRegistry, repository retrieval, skills, SessionStore, retry and compaction layers, with an explicit workflow instruction and a verification tool.

Background work is represented by durable JSON task records. A detached Node worker executes shell or agent tasks and writes bounded output/status. The worker entrypoint is resolved from the installed module rather than the caller's argv, so tests and installed CLI usage share the same worker path. Startup recovery checks worker PIDs and marks vanished work failed.

Parallel agent work is deliberately explicit. `parallel_agents` creates independent durable jobs rather than executing concurrent edits inside the foreground session. This keeps failure/recovery isolated and lets the user inspect each task separately.

## 0.7 Agent Profiles

TermAgent now has explicit `build`, `plan`, and `explore` profiles in the corresponding module. `Agent.run()` filters the tool catalog by each tool's declared risk before sending schemas to the provider. Execution applies a second policy check. This keeps policy enforcement explicit while retaining TermAgent's Node-only runtime.

The CLI exposes `/agent`, `/build`, `/plan`, and `/explore`. Autonomous `/auto` always forces build mode.
## Interactive terminal architecture

the corresponding module owns only the TTY editor lifecycle. The CLI loop remains in the corresponding module, while the existing agent, provider, tools, sessions, background workers, MCP, plugins, skills, and context modules remain unchanged in their responsibilities. When stdin/stdout are TTYs, `PromptEditor` takes raw input and returns a complete prompt. When they are not TTYs, `repl.ts` uses a standard line iterator so shell pipes and automated tests remain line-oriented.

The editor does not allocate a persistent screen buffer or install a UI framework. It redraws only the small region it owns, computes terminal display width for common wide Unicode characters, and uses bracketed paste so pasted newlines are inserted instead of accidentally submitting the prompt.

## 1.1.5 UI selection architecture

Permission selection is implemented as a renderer-independent `SelectModel` in the corresponding module, keeping selection state independent from its terminal presentation. The model owns focused option, movement, keyboard shortcuts, submit, and cancel semantics; `TerminalUI` owns drawing and terminal input ownership. This keeps the permission modal deterministic without importing React, Ink, or a heavyweight terminal UI framework.

## 1.1.4 UI hardening

The terminal UI keeps logical prompt state independent from rendered rows, the cursor position is application state, and approval dialogs own input while active. The renderer paints a complete logical frame using absolute row addressing; it does not depend on where the terminal cursor happened to be left by the previous frame.

`PromptEditor` owns input editing. the corresponding module owns visual layout. `TerminalUI` owns message/tool/status/permission state and turns that state into screen rows. `repl.ts` owns the agent session loop but does not paint terminal rows.

The cursor is now declarative: the renderer paints an inverse-video cell at the layout-derived cursor row/column while the hardware cursor stays hidden. This lets the renderer declare the cursor position without relying on terminal side effects.

The permission pipeline is:

```text
Agent
  -> ToolRegistry
    -> PermissionGate
      -> TerminalUI.requestPermission()
        -> permission state + selection
        -> exclusive stdin handler
        -> once / always / deny
      -> execute or fail closed
```

No a heavyweight terminal UI framework, React, Yoga, native PTY, SQLite addon, or architecture-specific UI binary was added.

## 1.1.6 interaction model
The command picker is part of UI state rather than the prompt's rendered rows. The conversation viewport has an independent scroll offset, so prompt editing and history navigation cannot move the same cursor or erase each other.

## 1.5.0 UI interaction state machine

The Q1 UI pass extends the previous prompt/cursor separation into a single explicit interaction state model. `PromptEditor` owns logical draft text and cursor position. `TerminalUI` owns conversation rows, activity, completion, reasoning visibility, scroll offset, and permission focus. Only one modal interaction owns stdin at a time.

```text
stdin
  -> PromptEditor
       | submit / edit / scroll / palette
       v
    REPL + TerminalUI state
       |
       +--> command picker / command palette
       +--> conversation viewport
       +--> activity state
       +--> reasoning panel
       +--> permission SelectModel
       |
       v
  full ANSI/VT frame
```

### Completion viewport

The completion list is never truncated to eight items for navigation. The model retains the full filtered array and selected global index; `TerminalUI.commandMenu()` renders a window of at most eight rows around that index plus a range indicator. This avoids the previous eighth-row wrap bug. `Ctrl+P` opens the same selection engine without inserting text into the prompt.

### Active-turn mouse handling

When an agent turn is active, `TerminalUI.onTurnInput` ignores button press/release sequences and consumes wheel events as viewport scrolls. Escape is treated as an interrupt only after a short delayed decision, allowing split mouse/CSI sequences from Termux to be recognized first. This prevents touch input from becoming an accidental abort.

### Activity and reasoning

Agent callbacks update explicit activity phases. Provider adapters emit only reasoning that is explicitly present in the provider payload. Reasoning is stored on the assistant entry separately from visible response text and is rendered as a collapsible panel. `Ctrl+E` changes only display state; it does not change the model's reasoning capability.

### Permission ownership

`PermissionGate` delegates interactive requests to `TerminalUI.requestPermission()`. The permission selector attaches its own stdin handler and removes it before resolving. Once the choice is accepted, tool execution continues; on denial it fails closed. The prompt editor is not active while the selector owns stdin.
## 1.8 plugin package contract

TermAgent now has a metadata-only plugin package layer in front of the existing legacy plugin loader. A package is identified by either compatible `.claude-plugin/plugin.json` or native `.termagent-plugin/plugin.json`. `discoverPluginPackages()` scans explicit project/user/configured roots and only inspects package roots or direct child package directories; it does not recursively traverse vendored directories and does not import executable code.

The manifest contract is intentionally close to the validated schema shape: identifiers and semver-like versions are validated, component declarations may point to `commands`, `agents`, `skills`, and `outputStyles`, command mappings may carry metadata, dependencies may be qualified with `@marketplace`, and optional metadata/MCP/hooks/config fields are retained for later phase integration. Component file/directory declarations must use `./...` relative paths with no absolute paths or traversal segments. `resolvePluginComponentPath()` repeats root containment checks at resolution time.

This phase does not perform network access, installation, updating, executable remote plugin loading, or trust decisions. Legacy `.js`/`.mjs` local plugins continue through the corresponding module exactly as before. Phase 2 adds the marketplace distribution/state layer on top of this contract.

## 1.9 marketplace distribution and installation state

Phase 2 adds a manifest-driven marketplace layer without changing the Phase 1 executable-plugin compatibility boundary. the corresponding module validates marketplace manifests, persists registrations, materializes remote Git/URL catalogs, refreshes them transactionally, and reconciles broken cache state. the corresponding module materializes one marketplace plugin into the user installation cache and records provenance/integrity metadata.

The persistent layout follows the implementation plan while preserving the existing legacy plugin directory:

```text
~/.termagent/
├── marketplaces/
│   ├── known.json
│   └── cache/<marketplace>/
└── plugins/
    ├── installed.json
    ├── cache/<marketplace>/<plugin>/<version>__<digest>/
    └── *.js / *.mjs                 # legacy local plugins, unchanged
```

The marketplace state machine is deliberately split from executable loading:

```text
marketplace source
    -> fetch / clone
    -> validate marketplace.json
    -> private cache
    -> catalog entry

catalog entry
    -> explicit third-party confirmation when applicable
    -> materialize plugin to temp path
    -> validate plugin manifest (unless strict:false)
    -> SHA-256 content digest + revision
    -> atomic installation state update
```

Remote marketplace refreshes use a staged directory and a backup of the previous live cache. State is saved only after the new materialization passes validation, so failed network or filesystem work keeps the previous cache available. Git uses the system executable with shallow history, optional sparse checkout, recorded SHA support, disabled Git hooks, non-interactive credentials, and strict SSH host checking.

Phase 2 intentionally does not activate downloaded JavaScript plugins, resolve npm/pip dependencies, or add marketplace UI commands. Those remain later phases so distribution, installation, trust, execution, and skill discovery stay separable.
## 1.10.0 skill catalog

TermAgent now has a descriptor-first skill catalog. the corresponding module discovers project/global skills and plugin-provided skills, parses only discovery metadata, namespaces plugin skills, and stores path/mtime/size/SHA-256 fingerprints for deterministic invalidation. Full `SKILL.md` bodies are not part of the base prompt. Runtime entry points expose a compact descriptor listing; Phase 4 owns explicit body loading through `use_skill`.
## 1.11.0 explicit skill loading and agent discovery

Phase 4 adds a shared skill discovery/loading pair on top of the Phase 3 catalog. the corresponding module performs descriptor-only relevance ranking with a minimum threshold and bounded delta from the top result. the corresponding module exposes exactly two model-facing tools: `search_skills` returns descriptors/relevance only, while `use_skill` loads one exact skill through the corresponding module.

The invoker rechecks live catalog membership, user/model invocation flags, realpath root containment, regular-file status, `SKILL.md` naming, and SHA-256 equality before returning the full body. This makes the catalog a discovery index rather than a trust boundary.

the corresponding module performs automatic discovery from user input and rediscovery after successful writes or subagent creation. Each normalized signal/query pair is processed once per run and the system prompt is updated with the compact descriptor results. Full skill bodies are excluded from automatic discovery.

The CLI's `/skill` path uses the same live invoker with the user-invocation policy enabled, records `skill.load`/`skill.skip` events, and passes the explicit body as task instructions with automatic discovery suppressed. Plugin skill IDs remain namespaced using `<plugin>@<marketplace>:<skill>`.

Phase 4 does not activate arbitrary plugin commands/agents/MCP, add plugin manager UI, or introduce a remote skill registry. Those remain isolated later phases.

## 1.12.0 plugin component integration

Phase 5 connects the installed marketplace-plugin state to TermAgent's existing command, agent, MCP, permission, and lifecycle infrastructure without activating arbitrary plugin JavaScript. the corresponding module reads only plugins whose installation state is `installed`, verifies the installed manifest identity against durable state, resolves declared component paths inside the installation root, and exposes namespaced commands/agents plus plugin-provenanced MCP definitions.

Commands and agents are merged into the existing custom definitions rather than introducing a second registry. Plugin commands use `<plugin>:<path>` names and carry the plugin allowlist/provenance. Plugin agents use `<plugin>:<agent>` names and carry tool/disallow/skill metadata. Installed plugin records are processed in deterministic ID order, and malformed plugins are isolated so a sibling plugin can still activate.

MCP servers are converted into the existing stdio `MCPServer` shape and carry plugin provenance through `MCPClient` into every MCP tool. Logical plugin server keys are namespaced to avoid collisions with ordinary MCP servers.

Declarative plugin hooks are loaded from `hooks/hooks.json` and manifest hook files. The Phase 5 hook manager supports command hooks on the existing lifecycle events used by TermAgent, sends a JSON hook context over stdin, exposes plugin-root/event metadata as environment variables, and routes hook execution through the shared `PermissionGate` before spawning `sh`. Pre-tool hook failures therefore block the underlying tool; post-tool and lifecycle hook failures are isolated and surfaced as status without corrupting the agent turn.

Plugin component activation is intentionally separate from arbitrary executable plugin entrypoints. The existing legacy `.js`/`.mjs` loader remains the explicit local compatibility path. Remote marketplace content is declarative in Phase 5; dependency resolution, enable/disable management UI, trust UI, and deeper supply-chain checks remain later phases.
## 1.13.0 Phase 6 — plugin/marketplace terminal UI

Phase 6 adds a terminal-native UI layer on top of the existing marketplace, plugin component, and skill catalog APIs. the corresponding module is a stateful controller rather than a second UI runtime: it renders fixed-width ANSI frames, owns list/detail/confirmation state, and exposes asynchronous callbacks to the existing persistence and activation services.

The controller provides three related browsers: `/plugins` for installed lifecycle state, `/marketplace` for registered marketplace/plugin discovery and trust-gated installation, and `/skills` for descriptor browsing and on-demand detail loading. Plugin rows show compact command/agent/skill/MCP/hook counts; detail views surface source, revision, digest, installation path, and failures. Marketplace plugin rows use a separate selection state so browsing a marketplace does not disturb the top-level marketplace selection.

`TerminalUI` treats the plugin manager as a blocking modal alongside the existing permission, question, provider, and inspector views. It temporarily owns stdin, disables prompt focus, preserves the current raw-mode lifecycle, and restores the editor on close. Mouse input supports SGR and legacy X10 packets, including buffering of split escape sequences and correct wheel codes. Keyboard navigation uses bounded global selection, page-up/page-down, explicit detail transitions, and dedicated cancellation paths.

Small terminals are handled deliberately. At 60x20, marketplace detail metadata is compacted to source/status/revision/digest so the available-plugin list remains useful and the footer never scrolls off-screen. At 80x24, the fuller owner/updated/about metadata remains visible. Action success messages are applied after refresh so the user sees what actually changed instead of a generic refresh message.
\n\n## 1.14 trust, integrity, and supply-chain hardening\n\nPhase 7 adds a security boundary around installed marketplace plugins and prompt-only skills. The implementation stays dependency-light and uses the existing Node.js filesystem, Git, ANSI/VT, and permission infrastructure. No downloaded plugin JavaScript is imported.\n\n### Security state\n\n```text\n~/.termagent/plugins/\n├── installed.json\n├── cache/<marketplace>/<plugin>/<version>__<digest>/\n└── security.json\n```\n\n`security.json` is private (`0700` parent directory, `0600` file) and is written with a temporary file + rename. It contains optional plugin/marketplace blocklists, revocation records for plugin IDs, digests, and Git revisions, plus persistent trust approvals. An approval records a source fingerprint, exact content digest, optional exact revision, and approval timestamp.\n\nTrust is intentionally exact-match rather than name-based:\n\n```text\nplugin id + source fingerprint + digest + revision\n                    │\n             ┌──────┴──────┐\n             │             │\n          approved     invalidated / unapproved\n             │             │\n          reuse      require confirmation\n```\n\nChanging any trust input invalidates the old approval. This prevents a previously approved marketplace entry from silently inheriting trust after its source, revision, or content changes.\n\n### Integrity\n\nMarketplace manifests fetched from remote sources carry a SHA-256 digest. Reading a cached remote marketplace recomputes the manifest digest and fails on mismatch. Plugin packages use a deterministic SHA-256 tree digest over sorted paths and file bytes; symlinks are rejected. Installed plugin state stores both the digest and, when available, the Git revision. Pinned plugin sources must materialize exactly the requested commit.\n\n`getPluginState()` and `loadInstalledPluginComponents()` recompute the installed plugin digest before exposing components. A mismatch produces a broken state and prevents command, agent, MCP, or hook activation.\n\n### Realpath containment\n\nLexical `./` validation is only the first layer. Before installed component reads, the loader resolves realpaths and verifies that the result remains inside the installed plugin root. Declared command/agent/MCP/hook files and recursive Markdown discovery apply this check before content is read. Installed plugin roots are also checked against the private plugin cache root.\n\n### Marketplace identity\n\nReserved marketplace names use exact official-source validation based on the implementation behavior: official GitHub sources must resolve to `github.com` and the `anthropics` organization. Host/path substring tricks such as `github.com.attacker.com`, `evilgithub.com`, or attacker-controlled parent domains are rejected. Direct URL sources cannot claim reserved official marketplace names.\n\n### Skill security\n\nSkills remain declarative Markdown. the corresponding module scans every line, including fenced code, before descriptor exposure and again immediately before full-body invocation. Findings with error severity block discovery/loading; warning findings remain visible in metadata. Rules cover zero-width/BIDI/Unicode-tag characters, hidden HTML comments, prompt/system role markers, instruction overrides, secret references combined with URLs, common exfiltration endpoints, unsafe network helpers, encoded evaluation, destructive confirmation bypasses, concealed interpreter execution, raw-IP URLs, and mixed Latin/Cyrillic/Greek confusables.\n\n### Policy failure mode\n\nSecurity policy parsing is fail-closed. Missing policy means no additional restrictions; malformed JSON or schema data is an error and therefore blocks operations that require policy evaluation rather than silently treating corruption as an empty policy.\n\nPhase 7 deliberately does not add a new remote security-feed dependency. Revocations and blocklists are represented locally so the runtime remains deterministic and usable offline. A remote registry/automated feed can be layered on later without weakening the local enforcement chokepoints.\n
## 1.15.0 Phase 8 — dependency, update, and reconciliation lifecycle

Phase 8 keeps the Phase 7 trust and integrity boundary intact while adding a small lifecycle layer modeled on the earlier lifecycle behavior.

### Dependency graph

the corresponding module builds a metadata-only graph from validated marketplace manifests. Bare dependencies inherit the declaring plugin's marketplace; qualified dependencies use `plugin@marketplace`. Resolution uses a deterministic DFS and returns dependencies before the requested root. Cycles and missing dependencies fail before any filesystem mutation. Cross-marketplace dependencies are denied unless the root marketplace explicitly lists the destination marketplace in `allowCrossMarketplaceDependenciesOn`.

### Install transaction

the corresponding module serializes marketplace/plugin state mutations through one process-local lifecycle queue. A dependency closure is installed sequentially in resolver order. Each newly published versioned install path is tracked. If a later dependency or root install fails, the previous `installed.json` snapshot is restored and only paths created by the current transaction are removed. Existing installations are not deleted as part of rollback.

### Pending updates

`update-available` represents a valid installed version with newer marketplace/source material available. Component and skill loaders continue using the currently installed version until the replacement is installed successfully. This follows TermAgent's non-in-place update model, where the active session is not mutated mid-turn.

### Reconciliation

the corresponding module cleans abandoned marketplace/plugin staging directories and re-checks every installed record against its marketplace entry and installed content. Deleted catalog entries become `orphaned`; missing/tampered content becomes `broken`; dependency checks use the still-active installed/update-available set. The reconciliation result is persisted before normal component discovery starts.

### Auto-update

the corresponding module refreshes only marketplaces whose stored/default auto-update setting is enabled, processes them in sorted order, then processes enabled installed plugins in sorted ID order. Official marketplace names follow the documented interaction model safe default policy; third-party marketplaces remain opt-in. `TERMAGENT_AUTO_UPDATE` provides a global disable switch suitable for offline or bandwidth-sensitive Termux sessions. Updates remain background-only for the running session and become active after the next component-load cycle/restart.
## 1.16.0 Phase 9 — context-budget and performance optimization

Phase 9 keeps TermAgent's existing dependency-light provider and terminal architecture while making context size a first-class bounded resource. the corresponding module now partitions the request budget into tool schemas, instructions, repository context, skill descriptors, and explicit skill content. Tool schemas are deterministically compacted or dropped by priority when they exceed their allocation; a catastrophically oversized single definition is rejected rather than reduced into an unreliable contract.

the corresponding module counts discovered skill descriptors inside the same request budget and limits explicitly loaded skill text to its allocated section. Per-provider-round notices are also budgeted before being appended to the request, so workflow reminders cannot silently push an otherwise valid request over the configured limit.

the corresponding module caches raw rendered tool schemas until the registry mutates. Filtering and request-specific context bounding remain in the Agent because those depend on the active permissions and workflow state.

the corresponding module uses metadata-first warm reuse: unchanged skill files reuse their previously parsed descriptor, security findings, and digest without reading the body again. Concurrent callers share one in-flight build; project caches are bounded and touched as an LRU; descriptor/search caches avoid repeated tokenization and ranking work. Catalog generations invalidate search results deterministically when the selected descriptor set changes.

the corresponding module and the corresponding module keep exact full-body loading available to direct invocations while bounding the model-facing `use_skill` tool result. Truncation preserves both head and tail content because procedures often put critical verification or cleanup information near the end.

The CLI no longer eagerly scans the complete skill catalog during ordinary startup. `/skills` loads descriptors on demand, while the agent discovers skills only when the skill tools are registered. No network prefetch is added, preserving the Termux/mobile-data constraint.

## 1.17.0 Phase 10 — pure skill registry support

Phase 10 adds a declarative skill distribution layer that is deliberately separate from the executable plugin marketplace. the corresponding module owns registry transport, validation, caching, trust approval, revocations, installation, and installed-state verification. The public `SkillRegistryProvider` interface keeps transport independent from the plugin subsystem and lets tests inject deterministic providers.

The registry accepts the current the skill registry array-root `registry.json` shape as well as an object with a `skills` array. Every entry requires a namespace-qualified ID, description, semver-like version, trust tier, HTTPS source, and SHA-256 content digest. Relative sources and revocation URLs resolve from the registry URL. Remote reads are bounded and timed, and the final redirected response URL is revalidated.

Pure skill state is isolated under `~/.termagent/skill-registries/`. Registry caches and installed skills use atomic writes and home-directory containment checks. Installed records are accepted by the catalog only when the recorded path equals the derived `<registry>/<skill>/<version>/SKILL.md` path and realpath containment succeeds. Cached or installed `SKILL.md` content is checked for size, security-scanner findings, exact frontmatter name/version identity, and the published digest.

Registry metadata uses last-known-good caching. A failed registry refresh can return cached metadata while marking it stale; installation refuses stale metadata unless the caller explicitly supplies `allowStale`. Revocations are cached separately. Fresh cached revocations can survive a temporary fetch failure, while the absence of a known-good list causes non-404 revocation-fetch failures to fail closed.

Trust approvals are bound to `registryId + skillId + source + version + sha256 + trust`. Any changed trust input invalidates the approval, and confirmed approval is stored only after the candidate content passes security and integrity checks. Trust metadata never becomes executable permission: installing a pure registry skill modifies only pure-skill state and the shared `SkillCatalog`, not plugin enablement or plugin component registration.

The catalog merges registry skills alongside project/global/plugin skills but keeps source provenance. the corresponding module performs a live revocation check, registry-install-root containment check, content security scan, and digest recheck immediately before returning a registry skill body to the agent. This preserves the Phase 4 descriptor-first discovery model while adding a remote, auditable distribution source.

## 1.18.0 Phase 11 — release hardening and migration

Phase 11 closes the extension rollout with a non-destructive adoption layer, structured diagnostics, authoring references, and a full lifecycle fixture. the corresponding module normalizes legacy project and global config aliases into canonical `plugins` and `skillPaths`, records observed legacy roots and executable plugin files, creates a pre-migration config backup before changing a file, and persists idempotent migration records atomically in `~/.termagent/migrations.json`. Existing `.termagent/skills`, `.claude/skills`, and `.termagent/plugins` content stays in place and remains supported by the compatibility loaders.

the corresponding module resolves configured skill roots through the effective `loadConfig()` result, so migrated project or global `skillPaths` participate in normal descriptor-first discovery without a second configuration parser. Disabled marketplace plugins are excluded from plugin-skill discovery while their installed files remain intact for re-enable/update operations.

the corresponding module reports structured health checks grouped into environment, configuration, migration, marketplaces, plugins, skills, and storage. It does not refresh remote marketplaces or registries. `termagent --doctor --json` serializes the same report for external automation, while `/doctor --json` exposes it inside the interactive CLI. Invalid migration state is surfaced as a diagnostic error instead of aborting the diagnostic process.

Authoring guidance lives in `docs/AUTHORING-PLUGINS.md` and `docs/AUTHORING-SKILLS.md`, with declarative reference fixtures under `docs/examples/`. The plugin example contains only a manifest, Markdown command, and Markdown skill; the pure-skill example contains only `SKILL.md` content and no executable surface.

The Phase 11 E2E fixture exercises the complete marketplace/plugin/skill lifecycle in isolated temporary state. It verifies that updates become visible only after a successful replacement, disabling removes plugin skills from the catalog and invocation path, and removal clears installed plugin state. Release packaging is independently extracted and smoke-tested so workspace-only assumptions cannot mask missing or stale `dist` output.
## Phase 13N-H — Checkpoint and branch state model

Checkpoint state is a durable projection over the authoritative session log, not a copy of terminal render state. A checkpoint captures an immutable conversation projection and a workspace snapshot reference. Restore is represented by a durable `checkpoint.restore` event; session reconstruction ignores pre-restore active history and stale context checkpoints. Branching creates a new session linked to the checkpoint and copies semantic conversation state only. Workspace restoration is explicit for branching and implicit for direct restore.

Checkpoint snapshots participate in snapshot retention so ordinary turn cleanup cannot invalidate an advertised checkpoint. Legacy metadata-only checkpoints remain listable for compatibility but are rejected for restore/branch because message and workspace state cannot be reconstructed safely.

## Phase 13N-I — Semantic UI, visual system, motion and exploration HUD

The terminal renderer exposes one semantic presentation layer between runtime/session state and ANSI painting. Picker/completion rows, themes, banners, effects, exploration state, and hit targets carry structured data first; rendering is a projection of that data. `HitTargetRegistry` records coordinate geometry and activation policy during rendering, while `TranscriptRenderCache` reuses stable entry layouts with explicit revision invalidation. Render caches and hit targets remain presentation-only and never become session truth.

Themes use grouped `ThemeTokens` plus banner and motion metadata. User/project theme files are validated and merged without overwriting built-in identifiers, and visual preview changes remain transient until committed. Multiple banner compositions are width-aware and ambient effects are constrained to the banner band. Full/reduced/off motion controls whether decorative animation runs, and the renderer schedules a timer only while actual motion is needed.

The Exploring HUD is derived from existing `ExplorationStateSnapshot` and `ExplorationTelemetrySnapshot`; it does not create a second coverage or discovery store. Disjoint coverage is preserved as disjoint evidence instead of being flattened into a misleading range. This is deliberate preparation for Phase 14, where the same semantic state can be projected into a Web View.

## Future Web View / multi-client presentation architecture

Web View is a planned first-class client surface. It is not a second UI implementation of the terminal and must not be built by mirroring rendered ANSI output. The source of truth is the semantic runtime/session state and event stream; TerminalUI, Web View, and a future VS Code extension are independent projections of that state.

### Core principle

```text
                         TermAgent Runtime
                               |
               +---------------+---------------+
               |                               |
        Durable session events          Live runtime events
               |                               |
               +---------------+---------------+
                               |
                        Client event model
                    /           |           \\
                   /            |            \\
              Terminal       Browser       VS Code
              renderer        renderer       Webview
                   |             |             |
                   +-------------+-------------+
                                 |
                         semantic commands
                                 |
                         Interaction Gateway
                                 |
              +------------------+------------------+
              |                  |                  |
          prompt/send       permission         question
          steer/queue       decision            answer
          abort/resume      tool approval       response
```

The runtime is authoritative. A client never becomes a competing agent runner merely because it can display or control a session. Terminal and browser actions therefore converge on the same command handlers and durable state transitions.

### Canonical session/runtime events

The future public protocol should expose a versioned, renderer-neutral event envelope:

```text
EventEnvelope {
  version
  eventId
  sessionId
  sequence        // durable monotonic cursor where applicable
  timestamp
  kind            // session | tool | task | permission | question | ui | runtime
  durable         // replayable or live-only
  payload
}
```

Durable events include, at minimum, user prompts accepted into the session, assistant text/reasoning/tool-call/result events, permission requests and decisions, question requests and answers, Todo/task state changes, session lifecycle transitions, compaction state changes, and mutation/diff metadata required for faithful reconstruction of the current session view. High-frequency token/activity/connection events may remain live-only.

The transport must preserve the distinction between replayable session history and live-only activity. A reconnecting client can rebuild authoritative state from durable events and a cursor, then resume live activity. This follows the useful separation already present in the implementation session-event design, where durable session events are exposed as a replayable SSE stream while instance-wide live events are a distinct non-replay stream.

### Canonical interaction commands

Client actions that change runtime state use a versioned command model rather than client-specific HTTP handlers:

```text
CommandEnvelope {
  version
  commandId       // idempotency key
  clientId
  sessionId
  expectedSequence? / expectedRevision?
  kind
  payload
}
```

Required command families include:

- prompt submission, steer, queue, resume, abort/cancel;
- permission decisions, including once/always/deny semantics;
- question answers, multi-select answers, custom answers, reject/cancel;
- task controls and explicit result retrieval;
- future client-neutral session commands such as fork, rename, compact, or model/agent selection where those become public runtime operations.

Purely visual actions such as scroll position, collapsed panels, selected tabs, and browser window geometry remain client-local unless explicitly promoted to shared session state.

### Two-way mirror semantics

The Web View is a live mirror of the same session, not a copy of the terminal transcript. When the runtime emits a permission request or question, every connected client receives the same semantic request. The first valid decision is applied by the authoritative runtime, persisted, and then emitted as the resulting state transition so every other client converges on the same state.

This requires deterministic concurrency semantics:

```text
web clicks Approve -----\\
                         > Interaction Gateway -> one durable decision
terminal clicks Deny ---/                               |
                                                        v
                                              Permission.Resolved event
                                                        |
                                      +-----------------+-----------------+
                                      |                                   |
                                  terminal                              web
                                  updates                             updates
```

Commands must therefore be idempotent and, where appropriate, guarded by an expected state/revision so stale clients cannot silently overwrite a newer decision. Duplicate command delivery must settle to the same durable result instead of executing the underlying side effect twice.

### Rendering contract

The semantic event/state model must be rich enough to represent all important terminal surfaces without prescribing their visual geometry:

```text
transcript
assistant response + streaming state
reasoning
activity / current operation
file reads and search results
shell/task execution
Todo state
inline diffs and diff inspection
permission requests
question requests
errors / completion state
session metadata / agent / model
plugin/MCP/skill activity and provenance
```

TerminalUI continues to own ANSI/VT layout, raw input, picker geometry, and terminal-specific focus. Web View may render the same semantics using richer cards, panels, syntax highlighting, diff views, file trees, progress indicators, and responsive layouts. VS Code can reuse that browser-grade presentation inside a Webview while using the same runtime protocol.

### API and transport requirements

The existing HTTP/SSE layer is therefore an architectural seam, not merely a terminal-adjacent convenience API. Future work should keep the following separations explicit:

```text
Runtime domain logic
        |
        +-- Session/Event model
        +-- Interaction command model
        +-- Authorization / PermissionGate
        +-- TaskManager
        +-- ToolRegistry
        |
        +-- Transport adapters
             +-- local HTTP + SSE
             +-- future WebSocket
        |
        +-- Client adapters
             +-- terminal
             +-- browser Web View
             +-- VS Code Webview
```

No business logic should depend on Express-like request objects, browser APIs, DOM state, ANSI escape sequences, or a particular client. This keeps the same runtime usable from Termux, a local browser tab, a remote browser client, and an IDE integration.

### Connection and recovery

Each client maintains:

```text
connectionId
clientId
sessionId
lastDurableSequence
subscriptions
local UI state
```

The durable event cursor is the recovery primitive. On reconnect, the client requests events after its last durable sequence, reconciles any authoritative session snapshot/state needed by the protocol, and resumes live events. High-frequency live activity is not required to be perfectly replayable; durable state is.

The protocol should support heartbeats, explicit connection state, server-side session validation, bounded event payloads, and clear behavior when a client disconnects during a pending question/permission interaction.

### Security boundary

Local Web View may bind to a local interface by default, while remote access must be an explicit configuration choice. Authentication/authorization, origin checks, CSRF protection for browser-mediated state-changing requests, session scoping, and command idempotency belong in the transport/control plane. Browser code must never receive credentials or internal permission secrets that are unnecessary for presentation.

VS Code integration should use the same authenticated local/runtime contract rather than creating a privileged second execution path inside the extension.

### Future VS Code integration

The intended path is:

```text
TermAgent runtime
       |
       +-- HTTP/SSE protocol
               |
        VS Code extension
               |
        VS Code Webview panel
               |
     browser-style TermAgent UI
```

A later VS Code extension may provide launch/attach, workspace/session discovery, authentication to the local TermAgent instance, notifications, and panel lifecycle. It should not reimplement agent execution, permissions, tasks, or tool semantics.

### Web View implementation blueprint

The Web View design plan for Web View is documented in `docs/research/WEB-VIEW-RESEARCH.md` and is treated as part of the architecture contract. The first production seam is HTTP command submission plus a durable SSE event stream; WebSocket remains an optional transport over the same protocol.

The current TermAgent server is not yet sufficient for that contract. the corresponding module currently implements SSE by polling the JSONL session file every 250ms, and question completion is held in a request-local `pendingQuestions` map. Those are acceptable transitional mechanisms for the current local API, but they are not the long-term multi-client synchronization model. Web View implementation must replace them with a runtime-owned event publisher, durable event sequencing, durable/reconstructible request state, and race-free replay-then-tail subscriptions.

The `SessionStore` remains append-only JSONL durable truth, and Phase 14A now persists an authoritative monotonic durable sequence in every newly appended event. Legacy records may be assigned a compatibility sequence during migration/read projection, but new public replay semantics must not depend on array offsets. Phase 14B will build the runtime publisher/subscriber around this sequence.

The implementation boundary is:

```text
src/session       durable truth + sequence + replay
       |
src/interaction  commands + pending requests + idempotency
       |
src/protocol     versioned command/event schemas
       |
src/server      HTTP/SSE/future WS transport adapters
       |
src/client      dependency-free protocol client
       |
  +----+----------------+
  |                     |
src/cli              web/ / VS Code
ANSI renderer        independent projections
```

A permission/question answer is a command that resolves authoritative request state. The resulting durable event is what every renderer observes. A repeated command is idempotently settled; a stale command is rejected or reported as already resolved rather than executing the underlying side effect twice.

For browser authentication, the protocol should support authenticated fetch-based SSE rather than depending on the browser `EventSource` API when custom authorization headers are required. Browser pairing/session credentials must remain scoped and revocable, and provider credentials must never enter browser presentation state.

The Web View application itself belongs outside the Node runtime source tree. `web/` may use an independent frontend toolchain or framework without adding those dependencies to the TermAgent runtime package. The VS Code extension belongs under `extensions/vscode/` and communicates with its Webview through the VS Code extension-host message API rather than allowing the Webview to own privileged runtime access.

### Phase 14A implementation state

Phase 14A is implemented in the current runtime. the corresponding module owns durable sequence assignment and replay-compatible event metadata; the corresponding module owns the renderer-neutral command/event contract; and the corresponding module owns command admission/idempotency semantics. Permission and question requests are reconstructed from the durable session event log, so their pending/resolved state is not tied to an HTTP request lifetime.

The implementation uses the existing JSONL store plus a cross-process session-state lease to serialize sequence assignment and append the sequence metadata in the same durable event record. This is intentionally a pre-event-bus implementation. Phase 14B will replace polling with a runtime-owned publisher/subscriber boundary and race-free replay-then-tail delivery without moving durable truth out of `SessionStore`.

Legacy session records without sequence metadata are mapped to compatibility cursors during read/migration paths. New writes always persist `eventId`, protocol version, category, kind, durable marker, and sequence in the stored event. Live-only protocol frames carry `sequence: null` and are never persisted as durable session events.

Command admission is deterministic for duplicate delivery: the same client/session/command identifier with the same semantic fingerprint returns the previous receipt, while reuse with different semantics is rejected. Expected sequence/revision checks prevent stale clients from silently overwriting newer state. Permission/question resolution is first-writer-wins and persisted as the resulting durable state transition.

### Multi-client correctness invariants

The following invariants are mandatory before Web View is considered production-ready:

```text
1. One authoritative runtime state.
2. One canonical command vocabulary.
3. One canonical event vocabulary.
4. Durable events have monotonic replay cursors.
5. Live deltas never become durable truth.
6. Duplicate commands are idempotent where retry is possible.
7. Stale/concurrent decisions converge deterministically.
8. Replay + live tail has no event-loss race.
9. Terminal/Web/VS Code never execute agent tools independently.
10. Reconnect reconstructs state from durable truth.
```

### VS Code integration posture

The eventual VS Code integration should provide both a native Chat Participant and, where richer UI is justified, a custom Webview. The native Chat Participant is the natural integration for conversational coding, while the custom Webview can expose TermAgent's richer tool/task/diff/session surfaces. The extension host remains the privileged bridge to the TermAgent runtime.

### ExplorationState and read-coverage projection

Phase 13M-P2 introduces a derived exploration projection in the corresponding module. It consumes structured evidence already produced by the authoritative `FileReadStateCache` instead of creating a second read cache.

`FileReadStateCache` remains responsible for file freshness, cached text segments, read requests, and the complete/fresh evidence required by mutation safety. `ExplorationState` answers a different question: what useful repository evidence has this agent already observed? It tracks bounded discovered-file paths, per-file line coverage, search signatures, symbols, file-version identity, recent observations, and a meaningful-progress revision.

The projection is checkpointed with the existing context-machine state and restored into a fresh runtime object. It is explicitly **derived/reconstructible**, so it never replaces `SessionStore` durable truth. A changed file version invalidates its previous exploration coverage. A read whose requested range is already fully covered reports zero new coverage, while a read that extends coverage reports only the newly observed ranges. Search metadata similarly records novelty without retaining arbitrary tool output.

This separation is important for later semantic no-progress detection: P3 can consume the same structured progress evidence without depending on rendered text, managed `tool-output://` references, or ephemeral call IDs.

### SemanticProgressState and cumulative no-progress detection

Phase 13M-P3 introduces the corresponding module as the single semantic projection consumed by the agent loop guard. It deliberately sits above individual tool-call outputs. The projection combines exploration coverage/discovery, Todo state, successful mutation evidence, task lifecycle state, and autonomous workflow state, then canonicalizes and hashes that semantic projection.

The projection excludes transport and renderer plumbing that can change without repository progress: tool-output references, output paths, call IDs, turn IDs, timestamps, generated Todo/task identifiers, workflow repeat counters, and other execution bookkeeping. Task state is grouped internally by the observed task identity, but the identity itself is not fingerprinted. This means a restarted or retried task with a new generated ID does not look like progress unless its meaningful state changes.

Search novelty is also semantic rather than purely syntactic. The persisted exploration search signature remains useful for cache/observation identity, but the P3 fingerprint collapses equivalent searches using their kind, query/path, discovered files, and discovered symbols. Thus changing an irrelevant argument such as a probe or output limit cannot manufacture progress when the repository evidence is unchanged. Reads use the restored `ExplorationState` coverage as the authority when a fresh per-run `FileReadStateCache` is recreated, preventing cross-turn rereads from appearing novel merely because the cache process-local state was lost.

The detector runs after each provider/tool round, not only inside one provider message. The cumulative projection is checkpoint-restored with `ExplorationState`, so semantic history survives compaction and later Agent runs. A fingerprint change indicates meaningful state evolution; an unchanged fingerprint feeds the existing semantic loop guard. The existing raw repeat and read-only guards remain complementary safety mechanisms rather than sources of semantic truth.

### Exploration routing and agent guidance

Phase 13M-P5 adds the corresponding module as the routing/guidance layer for repository exploration. It does not replace `repo_map`, `glob`, `grep`, `read_file`, or the existing task system. Instead, it classifies the user's exploration intent and gives the model an adaptive tool preference: structural requests may start with `repo_map`, file-pattern requests may start with `glob`, symbol/content requests may start with `grep`, and requests naming concrete files may start directly with `read_file`.

The guidance explicitly rejects a ceremonial `repo_map → glob → grep → read` sequence. It tells the agent to continue from uncovered ranges, follow search continuation metadata, parallelize independent inspection calls when safe, and switch strategy when an action produces no new evidence. Thoroughness is qualitative (`quick`, `medium`, `very-thorough`) rather than a fixed call-count target.

When the active tool set exposes `task`, `background_agent`, or `parallel_agents`, build-mode guidance permits a bounded specialized subagent for broad independent exploration and tells the parent not to duplicate that work. Explore mode itself remains read-only because its active tool set does not expose write/shell capabilities.

The actual user prompt is passed into Explore-mode guidance so routing reflects the task being investigated, not merely project-level instructions. This keeps exploration intent separate from generic repository instructions and preserves P6's future semantic-efficiency telemetry boundary.

### Exploration efficiency telemetry

Phase 13M-P6 adds the corresponding module as runtime-derived diagnostic state. It consumes the existing `ExplorationObservation` evidence and the P4 semantic exploration-action identity instead of inspecting rendered tool output. Counters cover tool calls, useful calls, semantically repeated calls, overlapping reads, cumulative new files, newly covered range segments, novel searches, tool-bearing rounds, no-progress rounds, and categorized termination reason.

Telemetry is deliberately not persisted as session truth. The Agent exposes an internal `onExplorationTelemetry` callback so tests and runtime diagnostics can observe snapshots without adding another durable event family. Tool attempts are counted at settlement so constrained/rejected actions count once and final assistant-only response rounds do not become fake exploration no-progress rounds.

The 33-call `crypto.py` regression is represented as a deterministic potential-call fixture and is verified to stop on semantic no-progress before exhausting that workload. A separate forty-read regression demonstrates that legitimate long exploration is not capped by a historical call count. Future adaptive routing may consume these metrics, but the metrics themselves are never a termination threshold.

### Client/runtime protocol preparation

Phase 13M-P7 defines the transport-neutral contract in the corresponding module. The protocol package contains the versioned `EventEnvelope` and `CommandEnvelope`, known durable/live event classification, durable sequence helpers, command idempotency/fingerprint semantics, compare-and-set guards, wire-level permission/question request state, first-writer-wins resolution semantics, and reconnect/reconciliation models. It is deliberately lower-level than HTTP/SSE/WebSocket and imports no presentation or transport APIs.

Durable events carry a positive monotonic `sequence`; sequence `0` is a cursor only. Live-only events carry no durable sequence and can never advance recovery state. The sequence is an independent runtime value and must not be derived from JSONL array indexes. Known event kinds are classified centrally, while unknown future kinds remain extensible only when their durability is explicitly declared.

Command idempotency is scoped to `sessionId + clientId + commandId`. A canonical command fingerprint covers meaningful command content so a retry with the same key can be replayed deterministically, while reusing the same key for different semantics can be rejected as an idempotency conflict. `expectedSequence`/`expectedRevision` provide stale-client guards for concurrency-sensitive commands.

Permission and question request models in the corresponding module are wire contracts only. The authoritative mutable request state remains reserved for the corresponding module. `firstWriterWins()` freezes the required semantic rule: a pending request accepts exactly one valid resolution; subsequent concurrent or duplicate resolutions become deterministic `already-resolved` results and cannot overwrite the winner.

Reconnect uses the client's `lastDurableSequence` plus an optional known revision. The contract supports either durable replay from that cursor or authoritative snapshot reconciliation followed by replay when the cursor/revision is no longer sufficient. P7 does not yet persist sequences, replace polling SSE, or implement replay/tail; those responsibilities remain Phase 14 runtime work.

### Current architecture gaps reserved for Web View

The following are known future changes rather than accidental omissions:

- public durable session sequence numbers;
- runtime event bus and replay/tail synchronization;
- canonical command admission/idempotency;
- durable pending permission/question state;
- stable protocol schemas under the corresponding module;
- client-neutral interaction service under the corresponding module;
- a fuller public client SDK;
- browser `web/` application;
- VS Code extension under `extensions/vscode`.

### Agent exploration intervention policy

The semantic exploration state from P2/P3 is now coupled to an intervention ladder in `ToolLoopGuard`, rather than using a hard stop as the first response to semantic churn.

```text
semantic no-progress
        |
        +--> 1: nudge -> change strategy
        |
        +--> 2: constrain redundant exploration action
        |
        +--> 3: stop exploration with bounded evidence
```

The default ladder is 1 / 2 / 3 consecutive no-progress rounds and is independently configurable for specialized agents, with a hard maximum of 12 semantic stop rounds. Constrained exploration identities intentionally ignore cosmetic probe/output arguments while preserving meaningful path, range, query, and selector differences.

The intervention message is derived/live context, not durable session truth. A meaningful semantic progress change clears prior constrained actions. The final exploration-stop notice is supplied to the model together with the existing loop-safety reason so the model can summarize what was actually established without making additional tool calls.

### Architectural rule

**Never mirror ANSI output into Web View. Mirror semantic state/events into multiple renderers.**

That single rule prevents the future Web View and VS Code client from becoming reverse-engineering projects. It also preserves the Phase 12 frozen terminal UI while allowing the browser/IDE presentation to evolve independently.

## Phase 13 completion gate

Phase 13 P1-P7 implementation work exists, but the 13M end-to-end rollout gate is reopened pending pre-execution semantic read hardening. The current verification contract and reopened status are recorded in `docs/research/PHASE13M-HARDENING-REVALIDATION.md`. Canonical tool identity, derived exploration coverage, cumulative semantic progress, intervention, adaptive routing, efficiency telemetry, and renderer-neutral protocol preparation remain implemented components, but they are not treated as a closed stable baseline until the production Build-mode exploration regression is fixed and reverified.

The rollout gate intentionally used isolated test-file execution because the default Node multi-file test runner can retain process-level handles across a large aggregate run even when every individual test file passes. This is a verification-harness behavior, not a production runtime contract. The production package remains zero-runtime-dependency and no native binary artifacts were found in `dist`. Physical ARMv7/Termux execution was not available on the x86_64 verification host and is explicitly documented rather than claimed.

Phase 14 must start from the P7 protocol contract and the Web View blueprint already recorded in this architecture. No browser implementation is implied by completion of Phase 13.

## Phase 13N-E — LSP diagnostic verification state

Status: `[verified]` at the diagnostic-state/evidence-contract level.

the corresponding module provides a reusable asynchronous diagnostic tracker rather than a second LSP process manager. A diagnostic run moves through `unknown → running → provisional → clean/failed/timed_out/cancelled` as evidence arrives. Every `textDocument/publishDiagnostics`-style publication replaces the bounded current set for that file and resets the quiescence window. An empty publication is not allowed to settle immediately; it requires both the configured quiet window and the minimum empty-result settle time. If the budget expires first, the state is `timed_out`, never `clean`. Error-severity diagnostics settle as `failed`; warning/info/hint-only diagnostics can settle as `clean` once quiescent.

The tracker deliberately treats publication timing, publication count, and other lifecycle churn as non-semantic. Its semantic fingerprint contains the server/file identity, settled/provisional state, and bounded diagnostic content. `EvidenceLedger` stores bounded LSP verification state, and lifecycle records carrying `metadata.lspDiagnostics` are normalized automatically. Only terminal LSP states contribute to `ExplorationState` semantic verification facts, so a provisional zero-diagnostic publication cannot manufacture exploration progress.

This phase uses asynchronous diagnostic coalescing and explicit uncertainty. It intentionally does **not** claim to implement a language-server process/session manager. Actual LSP server startup, document synchronization, symbol/definition queries, and live diagnostic transport remain a later capability phase.

## Phase 13N-D — post-edit verification and EvidenceLedger

Status: `[verified]` at the focused implementation/regression level.

Post-edit verification is implemented as a configuration-driven declarative hook layered on the existing `TaskManager` + `startManagedShell()` execution path. It is opt-in (`postEditVerification.enabled`) and defaults to disabled, so enabling it is an explicit shell-execution policy choice. Successful `write_file`, `edit_file`, and `apply_patch` mutations can trigger one verification command per settled mutation batch. The result is represented with explicit settled states (`passed`, `failed`, `timeout`, `cancelled`, `no_command`) and persisted as `session.verification.completed`.

A successful automatic verification is retained as an in-run semantic result for the current mutation fingerprint. A later `verify_project` request for the same batch is served from that result unless the model explicitly sets `force=true`; a forced verification still executes through the normal tool registry. The automatic path deliberately does not synthesize a provider tool-call lifecycle record, because it is runtime-owned work; the durable verification event, system notice, workflow observation, and evidence projection carry its semantic linkage.

`EvidenceLedger` is a bounded derived projection over exploration files/searches/symbols, verification results, mutations, tasks, and workflow state. Its semantic fingerprint excludes lifecycle identifiers, task identifiers, output paths, output sizes, and output truncation flags, while preserving the actual durable semantic result. Full verification output remains in the TaskManager output artifact; the ledger retains only bounded metadata/references.

The implementation keeps `SessionStore` event history and `TaskManager` records authoritative. The ledger is rebuilt into `ContextMachineState` checkpoints and is therefore available after compaction/restart without becoming a second source of truth.

## Specialist delegation

TermAgent specialist workers use explicit, role-scoped capability contracts built around the restricted specialist roster and per-agent permission model. The runtime intersects the selected role allowlist with the parent permission-derived tool set before creating the child task, then the worker enforces the same role contract again.

Specialist roles are `general`, `researcher`, `planner`, `coder`, `reviewer`, and `tester`. Read-only roles cannot mutate files; `coder` can use file mutation tools but not arbitrary shell; `tester` can invoke `verify_project` but not arbitrary shell. Child scopes inherit the parent's declared workspace scope when no narrower scope is supplied.

Task linkage stores `parentTaskId`, `delegationDepth`, `specialistRole`, permission policy, workspace scope, and estimated token usage. Parent cancellation recursively cancels tracked descendants. Central concurrency and depth limits prevent unbounded delegation even when tasks are created through different entry points.

