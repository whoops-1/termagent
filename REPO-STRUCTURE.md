# TermAgent Official Repository Structure

**Status:** Canonical project rule
**Introduced:** TermAgent 1.18 / post-Phase 13L

This document is the authoritative repository-organization contract for TermAgent. New code, new tests, new documentation, and future extensions follow this structure. Existing legacy files may remain where moving them would create unnecessary churn, but new work must not create a second organizational convention.

## 1. Repository shape

```text
TermAgent/
├── AGENTS.md                         # AI-agent work rules. Read before changing code.
├── REPO-STRUCTURE.md                 # Canonical repository structure and ownership rules.
├── ARCHITECTURE.md                   # Authoritative architectural design and boundaries.
├── TODO.md                           # Authoritative phase plan and implementation gates.
├── README.md                         # User-facing project overview.
├── CONTRIBUTING.md                   # Human contributor workflow and validation.
├── SECURITY.md                       # Security model and disclosure policy.
├── CHANGELOG.md                      # Release history.
├── CODE_OF_CONDUCT.md
├── LICENSE
├── SETUP.md
├── PROGRESS.md
├── FIX-REPORT.md
├── MERGE-REPORT.md
├── package.json
├── tsconfig.json
│
├── src/                              # Node/TermAgent runtime source.
│   ├── agent/                        # Agent selection, orchestration, policies, loops.
│   ├── cli/                          # Terminal-only input, presentation integration, commands.
│   ├── client/                       # Public dependency-free programmatic client/SDK.
│   ├── config/                       # Configuration loading, normalization, defaults.
│   ├── context/                      # Repository intelligence, retrieval, budget, compaction state.
│   ├── design-system/                # Terminal visual primitives only; no runtime business state.
│   ├── diff/                         # Canonical diff generation/render model.
│   ├── interaction/                  # Client-neutral commands, request state, event projection.
│   ├── mcp/                          # MCP transport and integration.
│   ├── plugins/                      # Plugin manifests, marketplace, trust, lifecycle.
│   ├── providers/                    # Provider adapters, routing, streaming, model capabilities.
│   ├── protocol/                     # Stable transport-neutral schemas for commands/events/state.
│   ├── server/                       # HTTP/SSE/WebSocket transport and route adapters only.
│   ├── session/                      # Durable session log, replay, snapshots, fork/undo/redo.
│   ├── skills/                       # Skill discovery, loading, registry, security.
│   ├── tasks/                        # Durable task/worker lifecycle and recovery.
│   ├── tools/                        # Built-in tool contracts and execution implementations.
│   ├── util/                         # Small cross-domain utilities with no business ownership.
│   └── version.ts
│
├── web/                              # Optional browser Web View application.
│   ├── src/                           # Browser-only UI and state projection.
│   ├── public/                        # Static public assets.
│   ├── tests/                         # Web UI tests.
│   └── package.json                   # Web-only build dependencies; never required by core runtime.
│
├── extensions/
│   └── vscode/                        # Future VS Code extension.
│       ├── src/                        # Extension-host code and protocol adapter.
│       ├── webview/                    # Custom VS Code Webview UI, if used.
│       ├── tests/
│       └── package.json
│
├── tests/                             # Runtime regression and integration tests.
│   ├── agent/
│   ├── client/
│   ├── context/
│   ├── interaction/
│   ├── plugins/
│   ├── providers/
│   ├── protocol/
│   ├── server/
│   ├── session/
│   ├── skills/
│   ├── tasks/
│   ├── tools/
│   ├── ui/
│   └── fixtures/
│
├── docs/
│   ├── architecture/                 # Architecture design notes and protocol docs.
│   ├── phases/                        # Phase reports and completion records.
│   ├── research/                      # architecture research and capability investigations.
│   ├── protocol/                      # Public protocol/API documentation.
│   └── assets/                        # Screenshots, deterministic UI fixtures, diagrams.
│
├── scripts/                           # Build/release/verification helpers only.
├── tools/                             # Developer-only utilities and visual/test harnesses.
├── experimental/                     # Non-production experiments. Must be clearly labeled.
├── dist/                              # Generated build output. Never edit manually.
└── .termagent-example.json            # Example configuration.
```

## 2. Domain ownership

### the relevant TermAgent subsystem
Owns the agent's reasoning/execution orchestration. It may call the ToolRegistry, SessionStore, Context, Providers, Tasks, Interaction, and Skills services. It must not contain terminal-rendering or browser UI code.

### the relevant TermAgent subsystem
Owns durable session truth. Session persistence, event sequencing, message projection, compaction checkpoints, snapshots, branches, undo, redo, and replay belong here. Session state must remain usable without any UI.

### the relevant TermAgent subsystem
Owns client-neutral interaction semantics. Permission requests, questions, commands, command idempotency, request resolution, event projection, and client attachment state belong here. This is the main seam for Terminal, Web View, and VS Code clients.

### the relevant TermAgent subsystem
Owns stable schemas and versioned wire-neutral contracts. Protocol types must not import a UI framework, HTTP request/response type, ANSI renderer, DOM API, or VS Code API.

### the relevant TermAgent subsystem
Owns transport. HTTP, SSE, and future WebSocket handlers convert wire requests into canonical commands and canonical events into transport frames. Server handlers must not implement business rules that belong in `agent`, `interaction`, `session`, `tasks`, or `tools`.

### the relevant TermAgent subsystem
Owns the dependency-free public client. It may know HTTP/SSE/WebSocket transport details but must not contain CLI or browser presentation logic.

### the relevant TermAgent subsystem
Owns terminal-specific input and presentation integration. It consumes runtime/client semantics and maps them to ANSI/VT UI. It is never the authority for session state.

### `web/`
Owns browser presentation. Web View state is a projection of runtime state. Browser code may be visually rich and may use frontend dependencies, but it must not duplicate agent execution or filesystem mutation logic.

### `extensions/vscode`
Owns VS Code integration. The extension host is responsible for attaching to TermAgent, authentication, workspace mapping, lifecycle, and VS Code APIs. It must reuse the canonical TermAgent runtime protocol rather than running a second agent implementation.

### the relevant TermAgent subsystem
Owns repository intelligence: file inventory, symbols, references, structural indexing, lexical search, retrieval, context budget, and compaction support. It may cache derived data but must distinguish derived indexes from durable session truth.

### the relevant TermAgent subsystem
Owns durable task execution and worker recovery. Tasks must expose explicit lifecycle states and output references. Completion notifications should identify state; large output should be retrieved deliberately.

### the relevant TermAgent subsystem
Owns actual tool definitions and execution semantics. Each tool must declare its schema, permissions, output contract, mutation/read-only semantics, concurrency behavior, and provenance where applicable.

## 3. Dependency direction

The default dependency direction is:

```text
protocol
  ↓
interaction ← session ← context
  ↓             ↓
server       tasks/tools/providers/plugins/skills
  ↓
client
  ↓
cli / web / extensions-vscode
```

This is conceptual rather than a rigid import DAG, but the ownership rule is strict: presentation code must depend on runtime contracts, never the reverse.

### Forbidden dependency directions

- the relevant TermAgent subsystem importing the relevant TermAgent subsystem, `web`, or `extensions/vscode`.
- the relevant TermAgent subsystem importing terminal renderer or DOM code.
- the relevant TermAgent subsystem importing HTTP, SSE, WebSocket, browser, React, Ink, or VS Code APIs.
- the relevant TermAgent subsystem directly performing file edits, tool authorization, or agent reasoning.
- `web/` importing Node-only source modules merely to reuse business logic.
- VS Code Webview code receiving provider credentials or performing privileged filesystem operations directly.

## 4. Source-file rules

1. Use TypeScript ESM for runtime source.
2. Keep `strict` type checking enabled.
3. Use two-space indentation, single-quoted strings, and no semicolons for new or substantially modified source.
4. Keep one responsibility per module. A large module may be split when it develops multiple independently changing responsibilities.
5. Do not create `index2`, `new-*`, `*-final`, `*-fixed`, or duplicate “replacement” modules. Extend or replace the authoritative module.
6. Do not hide business logic inside HTTP route functions, CLI renderers, or web components.
7. Do not manually edit `dist/` or other generated output.
8. Prefer explicit types at public boundaries and avoid introducing new `any` at domain boundaries.
9. Normalize and validate external input at the boundary.
10. Use stable identifiers for durable resources and explicit sequence/revision values for concurrency-sensitive state.

## 5. Runtime-state rules

TermAgent distinguishes four classes of state:

```text
Durable truth       → session/task/config state persisted by the runtime.
Derived state       → repository indexes, caches, search indexes, projections.
Live state          → streaming deltas, heartbeats, connection status.
Presentation state  → scroll position, panel expansion, cursor, viewport geometry.
```

Only durable truth may be used to reconstruct a session after reconnect. Derived/live/presentation state must never be mistaken for durable history.

## 6. Event and command rules

All cross-client state-changing actions use canonical commands.

```text
CommandEnvelope
  version
  commandId
  clientId
  sessionId
  expectedSequence / expectedRevision (where relevant)
  kind
  payload
```

All cross-client observable state changes use canonical events.

```text
EventEnvelope
  version
  eventId
  sessionId
  sequence (for durable events)
  timestamp
  kind
  durable
  payload
```

A UI must never invent a state transition locally and hope the runtime eventually agrees.

## 7. Web View rules

The Web View is a first-class runtime client.

- Never convert ANSI output into HTML.
- Never make the browser the owner of session state.
- Never make the terminal the owner of session state.
- Terminal, browser, and VS Code must converge on the same durable session state.
- Durable session events require replay/reconnect semantics.
- Live-only streaming events must be explicitly marked non-durable.
- Permission/question decisions are first-writer-wins authoritative runtime commands.
- Browser state-changing requests must be authenticated and protected from cross-site request forgery.
- Remote browser access must be explicitly enabled; local access is the default deployment mode.

## 8. architecture research rules

Before implementing a feature that exists in the implementation or another mature TermAgent:

1. Locate the implementation.
2. Pin the inspected revision/commit.
3. Read the actual source, not only summaries or issue comments.
4. Identify the state model, error model, concurrency model, persistence model, and public behavior.
5. Map those responsibilities onto existing TermAgent primitives.
6. Decide: adopt, adapt, replace, or explicitly defer.
7. Record the decision in the relevant phase/research document.
8. Preserve license/attribution obligations when reusing implementation code.

“Implement a simplified version because this is mobile” is not an acceptable architecture decision by itself.

## 9. Test organization

New tests should mirror source ownership:

```text
src/interaction/foo.ts   → tests/interaction/foo.test.mjs
src/server/foo.ts        → tests/server/foo.test.mjs
src/tools/foo.ts         → tests/tools/foo.test.mjs
```

Cross-cutting integration scenarios belong in the most specific subsystem that owns the contract. End-to-end multi-client scenarios belong in `tests/server` or a future `tests/e2e` tree.

The existing flat `tests/*.test.mjs` collection is legacy and may remain until a dedicated test-tree migration is justified. New test files should use the official domain tree.

## 10. Documentation rules

- `ARCHITECTURE.md` defines long-lived architecture.
- `TODO.md` defines implementation order and acceptance gates.
- `REPO-STRUCTURE.md` defines repository ownership and organization.
- `AGENTS.md` defines how coding agents work in the repository.
- `docs/research/` records architecture findings and design decisions.
- `docs/phases/` records completed phase results.
- Root phase reports may remain for historical compatibility, but new phase reports should prefer `docs/phases/`.

A design change that materially alters a public contract must update the relevant architecture/protocol documentation in the same phase.

## 11. Generated and temporary data

- `dist/` is generated.
- Test captures and temporary logs belong under ignored directories or `docs/assets/` only when intentionally preserved as fixtures.
- Do not commit credentials, API keys, session secrets, personal session logs, generated local caches, or ` .termagent-state` runtime state.
- Runtime caches must have an explicit owner and invalidation rule.

## 12. Rewrite policy

A rewrite is justified when:

- multiple patches are compensating for a wrong ownership boundary;
- the implementation cannot express a required invariant without exceptions;
- protocol/state semantics are incompatible with future clients;
- repeated regressions demonstrate duplicated or contradictory logic;
- correctness cannot be established with focused tests.

A rewrite must first preserve behavior with characterization tests, then replace the authoritative implementation in one ownership boundary. Do not maintain two production implementations indefinitely.

## 13. Completion standard

A feature is not “done” when the happy path works. It must have:

```text
contract
→ implementation
→ failure semantics
→ concurrency semantics
→ persistence/replay semantics where relevant
→ tests
→ documentation
→ package/runtime verification
```

For multi-client features, add:

```text
reconnect
→ duplicate command
→ stale command
→ concurrent command
→ client disconnect during pending request
→ runtime restart behavior
```

## 14. Source of truth precedence

When documents disagree, use this order:

```text
actual current source behavior
    ↓
ARCHITECTURE.md
    ↓
REPO-STRUCTURE.md / AGENTS.md
    ↓
TODO.md phase decisions
    ↓
historical roadmap/report documents
```

A phase report may describe historical behavior without changing current architecture. Update the authoritative document when a new decision is made.
