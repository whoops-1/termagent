# TermAgent Updated Roadmap

## Version

**Baseline:** TermAgent 1.1.7 (`TermAgent-1.1.7-q1-ui-final2.zip`)

**Planning note:** the roadmap consolidates the architecture and interaction work already completed in TermAgent.

**Target:** Termux-first, Node.js, ARMv7-safe coding agent.

---

# 1. Purpose of this roadmap

The previous roadmap was:

```text
1.1.6
  -> Q1 UI / interaction completeness
  -> Q2 agent intelligence / context
  -> Q3 capability completion and compatibility
  -> Q4 ARMv7 optimization / hardening
```

That plan was sensible when TermAgent's interactive layer was still being repaired.

TermAgent 1.1.7 has now crossed that point. The command picker, conversation viewport, mouse-safe running turns, reasoning panel, agent modes, custom commands, sessions, tasks, skills, MCP, and the headless API are already present.

The updated roadmap therefore changes the emphasis:

```text
1.1.7
  |
  +--> Foundation hardening
  |      - turn transactions
  |      - snapshots / undo / redo
  |      - execution state machine
  |      - context intelligence
  |
  +--> Interaction completion
  |      - rich dialogs
  |      - history search
  |      - editor / Vim
  |      - tool details
  |      - diff viewer
  |
  +--> Agent capability expansion
  |      - smarter routing
  |      - verification workflow
  |      - better repository map
  |      - better context budgeting
  |      - richer background agents
  |
  +--> Compatibility + hardening
         - feature parity
         - ARMv7 performance
         - crash / recovery behavior
         - API / SDK maturity
```

The key change is that **state and intelligence come before cosmetic parity**. The UI should expose strong underlying state, not simulate it.

---

# 2. Current TermAgent 1.1.7 baseline

The uploaded 1.1.7 source was inspected and executed.

## Verified baseline

- TypeScript build: passing.
- Automated test suite: 49/49 passing.
- PTY verification: 80x24 and 60x20 were exercised in the supplied project work.
- Command picker navigation beyond the eighth visible result: implemented.
- `Ctrl+P` command palette: implemented.
- Mouse click/touch protection during model turns: implemented.
- Mouse-wheel scrolling during model turns: implemented.
- Explicit provider reasoning events: implemented.
- Collapsible reasoning UI: implemented.
- Activity states: implemented.
- Session fork/checkpoints: implemented.
- Background task backend: implemented.
- Custom command loading/frontmatter: implemented.
- Custom agent loading/frontmatter: implemented.
- MCP stdio client: implemented.
- Skills loading: implemented.
- Headless HTTP/SSE server: implemented.

## Important current source observations

### Repository intelligence is still shallow

the relevant TermAgent subsystem builds a strong file inventory, but the map is path/kind/size/language oriented. It does not currently build a symbol/reference graph.

the relevant TermAgent subsystem performs lexical path matching and then reads a bounded prefix of selected files. The current default is roughly:

- a small tokenized query,
- path/basename matching,
- top candidate files,
- first 180 lines / bounded bytes from each file.

That is useful, but it is not yet structural codebase intelligence.

### Context compaction is heuristic

the relevant TermAgent subsystem estimates tokens using roughly `characters / 4` and keeps a recent-message window plus a locally generated summary.

This is intentionally dependency-light, but it is not tokenizer-aware and does not preserve structured tool state as deeply as a mature session model.

### Agent execution is not yet transaction-oriented

the relevant TermAgent subsystem has a good tool loop, retries, compaction, profiles, and autonomous mode. However, a turn does not currently have a first-class transaction/snapshot record tying together:

- the user prompt,
- assistant response,
- tool calls,
- files changed,
- verification results,
- rollback state.

That is the main architectural gap behind missing `/undo` and `/redo`.

### Background process cancellation is comparatively simple

the relevant TermAgent subsystem stores PID information and cancellation can terminate the stored process/process group. It does not yet have the stronger process-identity verification model seen in recent the implementation work.

### Server API is intentionally minimal

The HTTP server already exposes sessions, prompts, tasks, agents and skills, but it is much smaller than TermAgent's session/event API. It is useful now, but it should not become the internal authority for every future UI behavior until its event/state model is richer.

### Minor consistency issue found in 1.1.7

the relevant TermAgent subsystem still reports version `1.1.2` in the `/health` and `/api/v1/info` responses while `package.json` is `1.1.7`.

This should be corrected as part of hardening.

---

# 3. What the architecture review tells us

## 3.1 Stateful session and terminal architecture

the terminal UI is organized around a command registry, dialogs, keymaps, session actions, model selection, tool detail views, and session state rather than one monolithic prompt handler.

The current TUI command registry includes:

- `/compact`
- `/details`
- `/editor`
- `/models`
- `/sessions`
- `/thinking`
- `/undo`
- `/redo`

TermAgent's `/undo` and `/redo` are tied to snapshots so file changes can also be reverted/restored. The snapshot system is enabled by default and maintains an internal Git representation of changes.

The HTTP API treats session operations as first-class actions: prompt, command, shell, summarize/compact, fork, revert/unrevert, permission responses, and child-session/task relationships.

### TermAgent lesson

Do not copy TermAgent's a heavyweight terminal UI framework runtime into TermAgent.

Copy the **state model and workflow semantics**:

```text
session
  -> turn
     -> tool activity
     -> file change set
     -> verification
     -> snapshot
     -> revert / restore
```

Then keep TermAgent's Node + ANSI/VT renderer.

Key implementation areas:

- `src/cli/ui.ts` — terminal rendering and session interaction surfaces
- `src/session/snapshot.ts` — snapshot/checkpoint behavior
- `src/session/store.ts` — durable session state and events
- `src/server/http.ts` — local HTTP/SSE adapter
- `src/cli/repl.ts` — command dispatch and interactive session flow

---

## 3.2 Interaction depth

TermAgent prompt handling should continue to keep editor state, history, queue state, and submission state explicitly separated.

The current TermAgent implementation includes components/features for:

- history search,
- external editor,
- model picker,
- thinking control,
- background tasks,
- quick open,
- teams,
- Vim input,
- command queue/stash behavior,
- configurable shortcut hints.

This confirms that TermAgent's current input layer is solid, but it is not yet a complete developer-workflow surface.

Implementation areas:

- `src/cli/input.ts` — logical prompt/editor state
- `src/cli/tui/text-input.ts` — terminal editor rendering and cursor behavior
- `src/cli/tui/select.ts` — structured selection/picker behavior

---

## 3.3 Repository intelligence

TermAgent's newer repo-map implementation is much stronger than TermAgent's current lexical map.

Its current approach is:

```text
file enumeration
   -> symbol extraction
   -> cross-file reference graph
   -> PageRank ranking
   -> token-budgeted structural map
   -> cache by file path / mtime / size
```

Supported languages currently include TypeScript, JavaScript, and Python.

This is especially relevant because TermAgent already has the place where a repo-map system belongs: the repository map + retrieval subsystems.

We should therefore evolve those files rather than introduce a parallel context subsystem.

Implementation areas:

- `src/context/repository.ts` — repository inventory and map construction
- `src/context/retrieval.ts` — query-specific context selection
- `src/context/symbols.ts` — symbol extraction and relationships

---

## 3.4 Model routing

TermAgent can use an opt-in smart-routing layer that makes one model choice per user turn, choosing a simple or strong model and falling back to the strong model on eligible failure.

It deliberately keeps the routing decision stable for the whole turn rather than changing models halfway through tool execution.

This is useful for TermAgent because the provider abstraction already exists. The missing part is the routing policy and metadata, not a new provider architecture.

Implementation area:

- `src/agent/smart-routing.ts` — per-turn model routing and fallback policy

---

## 3.5 Agent routing and step limits

TermAgent's custom agents can have model routing and explicit tool-step limits. When a bounded agent reaches its limit, it stops tool use and asks for a concise completion summary rather than failing with a generic loop error.

TermAgent already has a similar `steps` field in `CustomAgent` and already uses a final text-only step when a limit is reached. That means this feature is **mostly present**, not a future blank slate.

The next improvement is making the step budget visible and auditable, especially for subagents/background agents.

Implementation areas:

- `src/agent/agent.ts` — turn execution and tool-loop orchestration
- `src/agent/profiles.ts` — role and tool-scope definitions

---

# 4. Updated priority areas

## Area A - Turn transaction + reversible changes

### Why this moves ahead

TermAgent can checkpoint session messages, but checkpoints do not equal filesystem rollback.

The missing abstraction is a **turn record**.

Recommended shape:

```text
Turn
├── id
├── sessionId
├── userMessage
├── assistantMessage
├── toolCalls[]
├── changedFiles[]
├── verification[]
├── snapshotBefore
├── snapshotAfter
├── state
└── timestamps
```

Then build:

```text
/undo
/redo
```

on top of that.


TermAgent uses snapshots and a dedicated restore path. The important lesson is: rollback has to track the exact affected files rather than blindly restoring the entire working tree. Targeted restore is the safer semantic model for `/redo`.

### TermAgent implementation direction

Do not require a permanent hidden Git repository immediately.

Design an abstraction:

```ts
SnapshotStore
  capture(turn)
  diff(turn)
  restore(turn)
  discard(turn)
```

Provide:

1. Git-backed implementation when the project is a Git repo.
2. A lightweight file-backup fallback for non-Git projects if practical.
3. A config switch to disable snapshots on resource-constrained projects.

### Acceptance criteria

- `/undo` removes the last turn from visible conversation state.
- Files changed by that turn are restored.
- `/redo` restores only the files affected by that turn.
- Unrelated user changes made after `/undo` are not destroyed.
- Undo/redo is blocked while the session is busy.
- Failed snapshot/restore operations enter an explicit error state.

---

# 5. Area B - Structural repository intelligence

This is the largest agent-quality upgrade.

## Current

```text
query
 -> lexical path score
 -> top files
 -> bounded leading excerpts
```

## Target

```text
repo scan
  -> file cache
  -> symbol extraction
  -> reference graph
  -> structural ranking
  -> lexical ranking
  -> query-specific fusion
  -> token-budgeted context
```

### Reuse strategy

The repository-map subsystem should remain the single structural context entry point.

TermAgent should preserve its current `RepositoryMap` API and add fields such as:

```ts
symbols
references
rank
language
hash
```

Then extend retrieval to combine:

- exact path matches,
- filename matches,
- symbol-name matches,
- import/reference relationships,
- important project files,
- recent Git changes,
- task-specific keywords.

### Cache design

Cache per file using:

```text
path + size + mtime
```

and invalidate only changed files.

### ARMv7 rule

Do not make a large native parser mandatory just to get a repo map.

Preferred sequence:

1. existing system tools when available,
2. lightweight JS/TS parsing,
3. optional tree-sitter integration only when it can be validated on ARMv7,
4. lexical fallback always retained.

### Acceptance criteria

For a large repository, the agent should identify the correct subsystem from a natural-language request without needing to read the first 180 lines of many unrelated files.

---

# 6. Area C - Context budgeting and compaction

TermAgent's current `characters / 4` token estimate is an intentional lightweight heuristic, but it becomes increasingly unreliable as models and providers differ.

## Target architecture

```text
Provider metadata
   |
   +-- context window
   +-- output reservation
   +-- tokenizer / approximate tokenizer
   +-- reasoning budget
   |
   v
ContextBudget
   |
   +-- system
   +-- instructions
   +-- repo map
   +-- retrieved files
   +-- conversation
   +-- tool output
   +-- reserved output
```

### Do not overbuild this

The first release should support provider-declared context limits and a better weighted estimator.

A pluggable tokenizer interface should exist so exact tokenizers can be added later.

### Compaction behavior

Carry forward the most useful context-management ideas:

- compact before the request becomes invalid,
- make compacting observable,
- preserve active task constraints,
- preserve changed files and verification facts,
- allow an explicit `/compact`,
- support a separate compact model later if useful.

Current TermAgent implementation areas:

- `src/cli/` and `src/design-system/` for terminal interaction and visual layout.
- `src/session/` for prompt history, snapshots, and restore behavior.

---

# 7. Area D - Execution state machine

The current UI has activity states, but the underlying execution lifecycle should become equally explicit.

Recommended state flow:

```text
idle
 |
 v
planning
 |
 v
context-loading
 |
 v
model-thinking
 |
 +--> tool-requested
 |       |
 |       +--> awaiting-permission
 |       |       |
 |       |       +--> denied
 |       |       +--> approved
 |       |
 |       v
 |    tool-running
 |       |
 |       v
 |    tool-result
 |       |
 +-------+
 |
 v
verifying
 |
 +--> retrying
 |
 v
completed
```

Every state transition should be observable by:

- TUI renderer,
- session log,
- SSE server stream,
- background-task event log.

This creates one source of truth instead of separately inventing CLI/server/task states.

---

# 8. Q1 - Interaction layer, revised

Q1 remains useful, but it is no longer the first thing to expand blindly.

## Already done

- command palette foundation,
- fuzzy slash picker,
- full-result selection navigation,
- `@` file/path completion foundation,
- agent mode switching,
- model display/switching path,
- permission selection,
- mouse-safe interaction,
- conversation scrolling,
- reasoning visibility,
- activity indicators,
- custom command discovery.

## Remaining Q1 work

### 1. Rich command palette

Convert the current picker into a categorized command surface:

```text
Commands
──────────────
Session
  New session
  Switch session
  Fork
  Undo
  Redo
  Compact

Agent
  Models
  Agents
  Thinking
  Permissions

Tools
  Tasks
  MCP
  Skills
  Diff
```

This follows the direction of TermAgent's command registry without copying its UI runtime.

### 2. Prompt history search

Add a reverse/fuzzy history surface rather than only arrow-key history.

the prompt system input uses a dedicated `HistorySearchDialog` and history-search hook.

### 3. External editor

Add `/editor` and a keybinding.

Use `$EDITOR` and keep the call blocking until the editor exits.



### 4. Vim input mode

Treat Vim mode as an input-engine layer, not a renderer feature.

Keep the current logical-cursor architecture.

### 5. Prompt queue/stash

When a turn is running, let users prepare another prompt rather than forcing them to wait or interrupt.

TermAgent prompt handling has explicit queue and draft concepts.

### 6. Custom keybindings

Create a small config layer such as:

```json
{
  "keybinds": {
    "commandPalette": "ctrl+p",
    "modelPicker": "ctrl+t",
    "historySearch": "ctrl+r"
  }
}
```

Configured keybindings should merge with defaults so individual actions can be overridden without redefining the entire map.



### 7. Rich tool detail surfaces

Implement:

```text
collapsed tool
    -> expand
    -> args
    -> live output
    -> final output
    -> duration
    -> exit status
```

Provide an explicit `/details` style toggle.



### 8. Diff viewer

Move from raw `/diff` text toward:

```text
Files changed
  M src/a.ts
  M src/b.ts
  A src/c.ts

Enter -> file diff
↑↓    -> file
Tab   -> hunk
```

Keep the renderer dependency-light and width-aware.

---

# 9. Q2 - Agent intelligence, revised

Q2 becomes the most important capability phase.

## 1. Repo map + structural retrieval

Implement Area B first.

## 2. Explicit planning state

The current autonomous prompt tells the model to plan, implement and verify, but planning is not yet a first-class artifact.

Introduce:

```text
Plan
├── goal
├── steps[]
├── completed[]
├── blocked[]
└── verification[]
```

Use the existing todo/workflow/session plumbing instead of creating a second task database.

## 3. Verification loop

The existing `verify_project` tool is a strong foundation.

Upgrade autonomous execution from:

```text
model says plan -> tool calls -> final answer
```

to:

```text
plan
 -> inspect
 -> implement
 -> verify
 -> inspect failures
 -> fix
 -> verify again
 -> finish
```

Verification should become a state, not merely a tool the model may remember to call.

## 4. Smarter model routing

Adapt TermAgent's smart-routing behavior.

Add configuration such as:

```json
{
  "routing": {
    "enabled": false,
    "simpleModel": "...",
    "strongModel": "..."
  }
}
```

One routing decision should cover the full turn.

Fallback should be explicit and observable.

## 5. Provider/model metadata

Expand the current provider layer so models can expose:

- context window,
- reasoning support,
- tool-call support,
- vision support,
- max output,
- effort/variant options.

This enables the TUI and context budgeter to make real decisions instead of displaying static labels.

## 6. Better tool scheduling

TermAgent already has a `parallel_agents` tool, but the main agent tool-call loop executes tool calls sequentially.

Introduce a tool scheduling policy:

```text
independent read-only calls -> parallel
same-file writes            -> serial
write + dependent read      -> serial
shell mutating operations  -> serial
```

This should be based on tool metadata, not a hardcoded list scattered throughout the code.

## 7. Tool-result summarization

Large grep/read/shell output should be summarized before becoming permanent session context where practical.

Preserve:

- key matches,
- exit code,
- important errors,
- changed files,
- commands executed.

Discard repetitive noise.

---

# 10. Q3 - capability completion, revised

Q3 becomes a structured compatibility program rather than a feature bucket.

For every candidate feature:

```text
1. Find design documentation.
2. Identify the state model.
3. Identify reusable algorithms.
4. Identify runtime-specific parts.
5. Adapt only the useful behavior.
6. Keep Node + ANSI/VT + ARMv7 constraints.
7. Add focused tests.
8. Add a source map note.
```

## Priority parity groups

### Session/workflow

- sessions list/switch,
- fork,
- undo/redo,
- compact,
- export,
- replay/history,
- checkpoints.

### Agent/model

- richer agent picker,
- model picker,
- model variants/effort,
- routing,
- per-agent model selection,
- bounded subagents.

### Input

- history search,
- external editor,
- Vim mode,
- queue/stash,
- custom keybindings.

### Tools

- tool details,
- question/interactive tool UI,
- richer permission rules,
- task/agent inspection,
- background logs.

### Context

- repo map,
- smart retrieval,
- context visualization,
- compaction controls.

### Extensibility

- custom commands,
- skills CLI/workflows,
- MCP UX,
- client SDK.

### Do not copy

The following should remain intentionally excluded unless an ARM-safe equivalent proves useful:

- TermAgent's a heavyweight terminal UI framework renderer,
- unnecessary Bun-only runtime assumptions,
- heavy native databases solely for feature parity,
- native parser stacks without ARMv7 validation.

---

# 11. Background agents and team-style execution

TermAgent already has durable background tasks. The next step is not another task backend.

## Current

```text
TaskManager
  -> worker process
  -> JSON state
  -> event log
```

## Target

```text
TaskManager
  -> AgentTask
       -> model
       -> agent profile
       -> turn events
       -> files changed
       -> verification
       -> result
       -> UI inspector
```

Build a TUI task panel:

```text
Background Tasks
────────────────────────
● auth-refactor     running
● test-suite        running
✓ docs-update       done
✗ lint-fix          failed

Enter  inspect
L      logs
K      cancel
R      retry
```

TermAgent should continue toward local background sessions and more observable long turns while keeping its process model lightweight and mobile-safe.

Sources:
---

# 12. Background-process safety

This should be treated as a hardening requirement rather than a polish item.

Process cancellation must verify the stored worker identity before killing a PID. The relevant code paths include the task registry, status refresh, process inspection, and kill handling.

TermAgent's current `TaskManager.cancel()` is comparatively simple.

## Target

Before killing a PID, verify enough identity information to ensure the PID still represents the expected worker.

Record at task creation:

```text
pid
command
cwd
start time
session id
random worker token
```

At cancellation:

```text
stored pid
   -> is process alive?
   -> does command identity match?
   -> does cwd/session identity match where available?
   -> then signal
```

Never blindly assume a PID remains owned by the original task.

documented issue:
---

# 13. Server/API roadmap

The current server should evolve from a thin command endpoint into a shared runtime event API.

## Required event categories

```text
session.created
session.updated
turn.started
turn.completed
turn.failed
assistant.delta
reasoning.delta
tool.started
tool.output
tool.completed
permission.requested
permission.resolved
verification.started
verification.completed
snapshot.created
snapshot.restored
task.started
task.completed
```

The TUI and headless server should consume the same runtime events.

## Future endpoints

At minimum:

```text
GET  /api/v1/sessions
POST /api/v1/sessions
GET  /api/v1/sessions/:id
POST /api/v1/sessions/:id/prompt
POST /api/v1/sessions/:id/abort
POST /api/v1/sessions/:id/fork
POST /api/v1/sessions/:id/undo
POST /api/v1/sessions/:id/redo
POST /api/v1/sessions/:id/compact
GET  /api/v1/sessions/:id/events
GET  /api/v1/sessions/:id/diff
GET  /api/v1/tasks
GET  /api/v1/tasks/:id/events
GET  /api/v1/models
GET  /api/v1/agents
GET  /api/v1/skills
GET  /api/v1/commands
```

Only add endpoints when they map to real runtime state.

---

# 14. Client SDK

The server exposes a generated client for session, command, provider, and permission APIs.

TermAgent does not need a generated SDK immediately, but it should eventually expose a small typed client around the same API.

Target packages/modules:

```text
src/server/types.ts
src/client/index.ts
src/client/session.ts
src/client/tasks.ts
src/client/events.ts
```

The CLI itself should eventually be able to use the client/runtime boundary for headless-style operations without duplicating business logic.

---

# 15. Q4 - ARMv7 and Termux hardening, revised

Q4 should begin once the preceding state/agent changes stabilize.

## Runtime benchmarks

Measure:

- cold startup,
- warm startup,
- repository scan time,
- repo-map build time,
- retrieval time,
- TUI repaint cost,
- memory during long sessions,
- memory during parallel tasks,
- provider streaming throughput.

## Large-repository tests

At least test repositories with:

- thousands of files,
- large generated directories,
- many Git changes,
- deeply nested paths,
- mixed languages.

## Android/Termux tests

Validate on the actual target:

- Android 10,
- ARMv7,
- Node.js ARM build,
- Termux shell,
- limited RAM,
- interrupted process recovery,
- terminal resize,
- SIGINT / Escape behavior,
- storage permission boundaries.

## Native dependency policy

Default rule:

```text
native dependency required
      |
      +-- works on ARMv7 and is justified -> consider
      |
      +-- unavailable / heavy / optional -> keep pure Node fallback
```

Do not add native dependencies for UI aesthetics.

---

# 16. Features already present that should NOT be rebuilt

This is important for future sessions.

Do not recreate these systems unless fixing or extending them:

- `PromptEditor` logical cursor/layout model
- alternate-screen ANSI renderer
- command suggestion viewport
- `SelectModel`
- permission gate integration
- activity/reasoning state in the UI
- session JSONL store
- checkpoints/forking
- `TaskManager`
- `ToolRegistry`
- custom agents loader
- custom commands loader
- skills loader
- MCP stdio client
- provider registry/router
- repository map file inventory
- lexical retrieval baseline
- HTTP/SSE runtime
- autonomous `verify_project` foundation

The correct development style is **extend these primitives rather than build parallel ones**.

---

# 17. Updated implementation sequence

This is the dependency order I recommend now.

## Phase 1 - Transactional execution foundation

1. Turn state model.
2. Snapshot abstraction.
3. Git-backed snapshot implementation.
4. Targeted restore.
5. `/undo`.
6. `/redo`.
7. Tests for unrelated working-tree changes.
8. Error states for failed restore.

## Phase 2 - Context intelligence

1. Repo map cache improvements.
2. Symbol extraction.
3. Reference graph.
4. Structural ranking.
5. Lexical + structural retrieval fusion.
6. Context budget abstraction.
7. Better compaction preservation.

## Phase 3 - Execution intelligence

1. Explicit planning state.
2. Verification state.
3. Retry/recovery policy.
4. Tool scheduling / safe parallel reads.
5. Tool-result summarization.
6. Model-aware routing.
7. Provider/model capability metadata.

## Phase 4 - Interaction completion

1. Rich command palette.
2. Session picker.
3. History search.
4. External editor.
5. Vim mode.
6. Prompt queue/stash.
7. Rich tool details.
8. Diff viewer.
9. Keybinding config.
10. Better task panel.

## Phase 5 - Parity pass

Feature-by-feature review against current design behavior.

Every feature gets:

```text
implementation reviewed
architecture mapped
TermAgent decision recorded
implementation adapted
tests added
docs updated
ARMv7 checked
```

## Phase 6 - API + headless maturity

1. shared runtime event model,
2. richer SSE stream,
3. undo/redo API,
4. permission/question API,
5. diff API,
6. typed client SDK.

## Phase 7 - ARMv7 hardening

1. startup benchmarks,
2. memory profiling,
3. long-session tests,
4. large-repo tests,
5. background worker recovery,
6. terminal resize/input tests,
7. provider/network fault tests,
8. packaging/install validation.

---

# 18. What changed from the previous Q1-Q4 plan

## Previous Q1

**UI completeness.**

### Updated

Keep Q1, but treat it as the **remaining interaction surface**, not a full rebuild. Most basic prompt/UI work is already finished.

Move history search, editor, queue/stash, rich tool details, diff view, and configurable keybindings into this remaining scope.

## Previous Q2

**Agent intelligence/context.**

### Updated

This is now the most important engineering phase.

Move repo-map intelligence, context budgeting, explicit planning, verification, tool scheduling, and routing upward in priority.

## Previous Q3

**Feature parity.**

### Updated

Keep it as a behavior-compatibility program based on TermAgent state contracts and regression tests.

## Previous Q4

**ARMv7 optimization.**

### Updated

Keep this as the hardening phase, but add process safety, crash recovery, server correctness, event consistency, and large-repository testing.

---

# 19. New near-term target: TermAgent 1.2

The next milestone should not be defined as “more features” alone.

It should be:

> **TermAgent 1.2 = reversible coding workflow + structural codebase intelligence + reliable agent execution.**

## 1.2 acceptance target

A representative workflow should work like this:

```text
termagent
   |
   +--> inspect repository structure
   |
   +--> identify relevant files from structural + lexical context
   |
   +--> make a plan
   |
   +--> capture turn snapshot
   |
   +--> edit files
   |
   +--> run verification
   |
   +--> repair failures
   |
   +--> verify again
   |
   +--> show diff / tool details
   |
   +--> persist turn state
   |
   +--> allow /undo
   |
   +--> allow /redo
```

That is a much more meaningful milestone than adding another decorative widget to the terminal.

---

# 20. Design rules for every future TermAgent change

1. **Inspect inspect the relevant implementation first.**
   Read the actual TermAgent implementation and documentation for the feature before changing its behavior.

2. **Reuse architecture, not accidental runtime details.**
   a heavyweight terminal UI framework, runtime-specific APIs, native stores, or heavyweight libraries should not be imported merely simply because another stack uses them.

3. **Extend existing TermAgent primitives.**
   Prefer existing `Agent`, `SessionStore`, `TaskManager`, `ToolRegistry`, `RepositoryMap`, `TerminalUI`, and provider abstractions.

4. **Make state first-class.**
   A thing the UI displays should have a corresponding runtime state/event whenever practical.

5. **Make failures explicit.**
   No operation should silently transition to a success-looking UI state before the underlying async work has actually succeeded.

6. **Keep ARMv7 as a design constraint.**
   Optimize for real Termux operation, not just successful compilation on x64.

7. **Tests accompany features.**
   Add unit/integration tests plus PTY coverage for interactive changes.

8. **Document design rationale.**
   For each substantial behavior, record the TermAgent component that owns it and any deliberate deviations from earlier assumptions.

---

- TUI commands and editor/undo/details/thinking/keybind behavior:
- Command system:
- Session revert service:
- Snapshot service:
- Session HTTP API:
- TUI command registry:
- JS SDK:
- Config/snapshot behavior:


   reviewed the recorded release notes

---

# 22. Bottom line

TermAgent 1.1.7 does not need another wholesale rewrite.

The codebase now has the right basic seams:

```text
Agent
SessionStore
TaskManager
ToolRegistry
RepositoryMap
ProviderRouter
TerminalUI
HTTP/SSE runtime
```

The next step is to make those pieces **stateful, context-aware, reversible, and observable**.

The session/snapshot/state model should remain the central architectural reference inside TermAgent.

Further work should prioritize repository intelligence, richer prompt interaction, lightweight background workflows, and stable routing patterns.

The final TermAgent architecture should remain:

```text
                 TermAgent
                    |
       +------------+------------+
       |                         |
   Agent Runtime             Terminal UI
       |                         |
 +-----+-----+             +-----+-----+
 |     |     |             |     |     |
Tool  Context Session     Input Render State
 |      |      |             |      |     |
 +------+------+-------------+------+-----+
                    |
                 Node.js
                    |
                  Termux
                    |
                 ARMv7
```

Not a wholesale rewrite.
Not a second runtime.

**TermAgent should be a deliberate ARMv7-compatible adaptation of the strongest ideas from both.**
