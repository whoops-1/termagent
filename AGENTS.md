# TermAgent AI Agent Coding Rules

Read this file before modifying TermAgent. Then read `REPO-STRUCTURE.md`, `ARCHITECTURE.md`, and the relevant section of `TODO.md` before designing a change.

## Mission

TermAgent is a general-purpose coding-agent platform with a zero-dependency runtime foundation. Termux/mobile compatibility is a deployment target and portability requirement, not a capability ceiling.

The goal is not to keep TermAgent artificially small. The goal is to keep it architecturally correct, extensible, secure, testable, and portable while adding mature capabilities when their engineering value justifies them.

## Mandatory verification workflow

Do not rebuild an existing TermAgent capability from scratch when the repository already contains the needed implementation or pattern.

For non-trivial implementation work:

1. Locate the closest existing TermAgent implementation.
2. Read its source and relevant tests.
3. Understand its state model, public contract, concurrency, failure, persistence, and recovery behavior.
4. Identify the existing TermAgent primitive that should own the new behavior.
5. Extend that primitive instead of introducing a parallel subsystem.
6. Preserve useful semantics and keep mobile constraints explicit.
7. Add regression tests alongside the change.
8. Record the resulting design decision in `docs/research/` or the phase report.

## Architecture rules

### Runtime before presentation

The runtime owns:

- sessions
- agent execution
- tools
- permissions
- questions
- tasks
- context
- providers
- durable events
- interaction requests

Clients own presentation:

- terminal geometry
- browser UI
- VS Code UI
- scroll/selection/layout state

Never move runtime truth into a renderer.

### One implementation per capability

Use the existing authoritative module. Do not create parallel read tools, search implementations, session stores, permission systems, diff engines, task managers, or agent loops merely because a feature needs a new caller.

### State classifications

Every new state field must be classified as:

```text
DURABLE   persisted and replayable
DERIVED   computed/cacheable
LIVE      streamed and reconnectable only through durable state
LOCAL     presentation-only
```

Do not serialize live-only data as durable truth unless the contract explicitly requires it.

## Web View / multi-client rules

Web View is a peer client, not a second runtime.

```text
             TermAgent Runtime
                    |
            canonical commands
                    |
            canonical events
          /         |         \
      Terminal     Web       VS Code
```

Never mirror ANSI output into the browser.

For browser/VS Code work:

- design semantic events first;
- keep durable and live-only events distinct;
- give durable events monotonic replay cursors;
- make state-changing commands idempotent where possible;
- guard stale state with expected revision/sequence when necessary;
- make concurrent permission/question resolution deterministic;
- reconnect from durable state rather than trying to reconstruct the UI stream;
- keep browser credentials and tool secrets out of presentation payloads;
- keep remote access disabled unless explicitly configured.

## Exploration rules

When exploring a repository:

1. Use structural discovery first when available.
2. Use Glob for file patterns.
3. Use Grep for content/symbol discovery.
4. Read specific files/ranges after candidates are known.
5. Parallelize independent reads when the runtime can safely do so.
6. Track what has already been inspected.
7. Never repeatedly read the same range when no new information is required.
8. Prefer semantic progress over raw tool-call count.

The exploration subsystem must detect canonical duplicate calls, covered read ranges, and semantic no-progress. Tool-output references, UUIDs, and JSON key ordering must not defeat duplicate detection.

## Mutation rules

Existing-file mutation requires fresh read evidence and write-if-unchanged semantics.

Before any mutation:

```text
resolve path
→ validate containment
→ validate preconditions
→ authorize
→ apply conditionally
→ record durable result
→ invalidate/update read state
```

Never silently overwrite external changes.

For batch mutations, preflight the complete batch before permission or mutation. Do not leave half-applied state without an explicit result.

## Task rules

Tasks are durable state machines. They must expose:

```text
created
running
waiting/blocked
completed
failed
cancelled
```

Large task output is stored/retrieved deliberately. Do not dump entire logs into the parent model context merely to determine task completion.

## Protocol rules

Public protocol schemas live in the protocol package.

A protocol change must define:

- versioning
- validation
- error cases
- persistence/replay behavior
- compatibility behavior
- client behavior after reconnect

HTTP routes are adapters. They are not the domain model.

## TypeScript rules

- ESM.
- Strict TypeScript.
- Two spaces.
- Single quotes.
- No semicolons for new/substantially modified code.
- Avoid new `any` at domain boundaries.
- Validate external inputs immediately.
- Prefer small named domain types to unstructured objects.
- Do not hide significant behavior inside giant one-line functions.

## Dependency rules

The core runtime should remain dependency-free where practical, but dependency-free is not an excuse to omit a high-value capability. Optional frontends/adapters may have their own dependencies.

Before adding a dependency:

- confirm the capability it enables;
- inspect maintenance/license/security status;
- define where the dependency belongs;
- ensure the core runtime does not become coupled to optional presentation code;
- document fallback/unsupported environments when a native dependency is truly required.

## Testing rules

Behavior changes require tests. New test files should follow the official test tree in `REPO-STRUCTURE.md`.

For lifecycle/protocol features, test at minimum:

```text
happy path
validation failure
permission denial
concurrent request
duplicate request
stale request
interruption
restart/recovery
replay/reconnect
```

For Web View/multi-client behavior, test:

```text
terminal + web connected simultaneously
question visible in both
permission resolved from either client
first-writer-wins resolution
client reconnect after missed events
durable reconstruction after disconnect
```

## Source hygiene

- Do not manually edit `dist/`.
- Do not commit credentials or runtime session state.
- Do not create duplicate “fixed” or “final” versions of files.
- Do not leave experimental code on the production import path.
- Keep generated artifacts clearly marked.

## Documentation rules

When behavior changes:

- update `TODO.md` for phase scope;
- update `ARCHITECTURE.md` for durable architectural changes;
- update protocol docs when public interfaces change;
- add a phase report when the phase gate completes.

## Completion rule

A phase is complete only when its implementation, focused tests, regression suite, build, package verification, documentation, and required runtime/compatibility checks pass.

Never silently start the next phase after completing a phase. Stop at the gate and propose the next defined phase.
