# TermAgent Design Ideas





**Review date:** 2026-10-01

This document consolidates reusable engineering ideas identified during the TermAgent design review. The goal is to record durable principles and practical improvements that fit the existing runtime, rather than preserve temporary implementation details.

## Executive summary

the earlier design is a compact pure-Rust terminal coding agent with an unusually strong set of practical Termux/Android-oriented features. The most valuable ideas for TermAgent are:

1. evidence-oriented exploration and a narrow exact-repeat backstop
2. batching independent read/search calls while preserving model call order
3. post-edit verification hooks that immediately feed results back to the model
4. explicit provisional versus settled LSP diagnostics
5. a structured verification/evidence ledger
6. specialist sub-agents with restricted toolsets
7. immutable session checkpoints and branching
8. semantic picker rows instead of display-string parsing
9. render caching and geometry-aware mobile TUI interaction
10. a shared semantic theme/token model for future multi-client rendering
11. robust cancellation/retry/stream-idle handling
12. Android/ARMv7 release engineering with prebuilt-first installation and checksums

Some the earlier design mechanisms are intentionally simpler than TermAgent's existing architecture and should **not** replace it. In particular, its `read_file` implementation has no range-aware semantic cache, and its compaction is a small summary projection rather than provenance-rich durable state.

## 1. Exploration safety: pair semantic progress with a narrow exact-repeat guard

the earlier design blocks three consecutive byte-identical tool calls before executing the third one. This is intentionally a backstop, not its primary exploration planner.

Useful pattern:

```text
semantic evidence progress
        |
        +-- progress -> reset no-progress state
        |
        +-- no progress #1 -> nudge
        +-- no progress #2 -> constrain strategy
        +-- no progress #3 -> stop/summarize

independent backstop:
three identical tool+arguments calls -> block
```

### TermAgent adaptation

Keep the existing semantic intervention architecture. Strengthen the progress definition so that progress is measured from **new evidence**, not merely repository-state mutation.

Evidence that should count when newly observed:

- new file
- newly covered line range
- newly reconstructed content required after compaction
- new search hit or search-result file
- new symbol/reference/location fact
- settled verification result
- mutation result that changes durable semantic state
- meaningful task/question/permission transition where that transition is part of the workflow contract

Do not count as semantic progress:

- call IDs
- turn IDs
- timestamps
- output references
- retry counters
- UI state
- cosmetic tool arguments
- the fact that a redundant read physically executed

## 2. Parallel independent inspection

the earlier design's agent batches independent read-only calls. It gates every call first, then runs pure reads concurrently, and finally inserts results back into the original model call order.

This is a useful pattern for mobile latency:

```text
model emits:
  read A
  grep B
  glob C
  read D

runtime:
  gate A/B/C/D sequentially
  execute A/B/C/D concurrently
  append results as A/B/C/D
```

### TermAgent adaptation

The existing TermAgent runtime already has the pieces needed for this pattern. The next implementation should:

- encourage one-batch independent inspection in agent guidance
- keep writes and order-dependent actions sequential
- preserve deterministic provider result ordering
- make the exploration evidence ledger aggregate results from the whole batch
- run the semantic progress check after the entire batch settles

## 3. Post-edit verification hooks

the earlier design can execute configured commands after every successful file mutation and append the verdict directly to the tool result. It also tells the model not to rerun successful hooks manually.

Suggested configuration shape:

```toml
[hooks]
post_edit = [
  "npm run build",
  "npm test"
]
```

### TermAgent adaptation

Add a declarative post-mutation verification layer on top of the existing TaskManager/shell infrastructure.

Required properties:

- runs only after successful mutations
- receives touched-path information
- has a bounded timeout
- returns exit code plus bounded useful output
- distinguishes pass, fail, timeout, and cancellation
- is recorded as structured evidence
- does not automatically rerun when the model already has a successful result
- remains optional and explicitly configured

This should feed the same semantic/evidence projection used by exploration and compaction.

## 4. LSP diagnostics: provisional is not clean

the earlier design handles asynchronous language-server diagnostics as a distinct state. An early empty diagnostics publication is not treated as a final clean result until the server becomes quiet or the diagnostics budget expires.

### TermAgent adaptation

Model-facing verification state should support at least:

```text
unknown
running
provisional
clean
failed
timed_out
cancelled
```

A provisional result must never be rendered or summarized as a clean verification result.

## 5. Evidence Ledger

The strongest combined idea from the review is to make durable semantic evidence explicit rather than reconstructing it from raw tool output.

Suggested logical shape:

```text
EvidenceLedger
├── files
│   ├── path
│   ├── version
│   ├── observed_ranges
│   └── full_coverage
├── searches
│   ├── normalized_query
│   ├── result_files
│   └── symbols
├── symbols
├── verifications
│   ├── command
│   ├── status
│   ├── timestamp
│   └── bounded_summary
├── mutations
├── tasks
└── workflow
```

The ledger should be a **derived semantic projection**, not a replacement for SessionStore/event truth.

### Why it matters

A single evidence model can serve:

- semantic no-progress detection
- compaction summaries
- sub-agent handoff
- replay/debugging
- Web View projections
- verification display
- exploration telemetry

## 6. Structured verification display

A useful TUI surface can show what has actually been established:

```text
┌ Verification ─────────────────┐
│ ✓ npm run build               │
│   exit 0 · 12.4s              │
│                               │
│ ⚠ npm test                    │
│   timed out                   │
│                               │
│ • LSP diagnostics             │
│   still analysing             │
└───────────────────────────────┘
```

This is better than a single `last tool = test` status because the model and user can distinguish proven, provisional, and unresolved state.

## 7. Specialist sub-agents with restricted capabilities

the earlier design provides a small built-in team:

- planner
- researcher
- coder
- reviewer
- tester

Each role gets an explicit tool allowlist, role prompt, and read-only policy. Delegation supports bounded concurrent execution.

### TermAgent adaptation

Use this pattern with the existing durable task/sub-agent system rather than creating a second agent runtime.

Important constraints:

- per-role tool allowlist
- bounded fan-out
- parent/child session linkage
- inherited cancellation and permissions
- explicit spend accounting
- compact report returned to parent
- reviewer remains read-only
- no unbounded recursive delegation by default

## 8. Checkpoints and branching

the earlier design exposes immutable conversation checkpoints and branches a fresh session from a selected checkpoint.

This is a particularly good user-facing workflow for risky coding work.

### TermAgent adaptation

TermAgent should keep the existing durable event/session architecture, but add explicit UX for:

```text
/checkpoint [label]
/checkpoints
/branch <checkpoint>
```

A checkpoint should be immutable and refer to the authoritative durable state rather than a mutable render cache.

## 9. Structured picker rows

the earlier design uses a semantic picker row:

```text
PickerRow {
  label,
  detail,
  badge,
}
```

instead of forcing renderers to re-parse strings such as `"label · detail"`.

### TermAgent adaptation

Promote picker data to semantic UI state wherever the current terminal UI still passes display strings around.

This will help future terminal/Web/VS Code renderers share one model while differing only in presentation.

## 10. TUI render caching and interaction geometry

the earlier design caches already-wrapped transcript rows so only a growing streaming tail is rewrapped.

It also stores the last-drawn rectangles and maps touch/mouse events back to semantic targets.

### TermAgent adaptation

Prioritize these as performance/interaction follow-ups:

- cache stable transcript layout
- invalidate only changed entries
- retain semantic hit targets from the render pass
- make taps resolve to commands/actions rather than screen coordinates alone
- keep touch interaction non-interrupting while the model is busy unless the target is an explicit interrupt control

## 11. Shared semantic theme tokens

the earlier design centralizes its visual palette into one `Theme` object covering:

- transcript text
- accents
- errors/warnings
- borders
- selected surfaces
- code background
- syntax tokens
- modes
- progress meters
- banner gradients

### TermAgent adaptation

Extend the implementation-system direction so renderers consume **semantic tokens**, not terminal-specific colors.

Future shape:

```text
semantic tokens
   ├── ANSI/terminal renderer
   ├── Web renderer
   └── VS Code renderer
```

This is particularly important for the future two-way Web View because the browser should render shared semantic state, not scraped ANSI output.

## 12. Provider and streaming reliability

the earlier design's provider layer contains several practical hardening patterns worth adopting where they fit the current runtime:

- fragmented tool-call accumulation
- preservation of opaque provider metadata such as thought signatures
- retry on transient connection/HTTP failures
- jittered exponential backoff
- `Retry-After` support
- cancellation during retry sleeps
- stream-idle watchdog
- provider-aware reasoning parameters

### TermAgent adaptation

Re-audit the current provider abstraction against these behaviors and add deterministic stream-recording fixtures for:

- fragmented tool calls
- provider metadata preservation
- transient failure/retry
- stalled stream
- cancellation during backoff
- cancellation while streaming

## 13. Managed process reliability

the earlier design's long-lived process manager keeps bounded stdout/stderr tails, uses process groups on Unix, supports stdin/EOF, and handles the case where a shell exits while a descendant still owns the output pipe.

### TermAgent adaptation

Audit the current managed task/shell implementation specifically for:

- descendant process cleanup
- pipe ownership after parent exit
- bounded output retention
- stdin timeout behavior
- monotonic process/task IDs
- graceful stop versus forced kill

## 14. Skills and progressive disclosure

the earlier design keeps skill discovery small and loads `SKILL.md` details only when a skill is relevant. Project entries override global ones.

TermAgent already has a descriptor-first skill system. The useful follow-up is to make **activation, loaded body, and applied workflow** part of the Evidence Ledger so compaction can preserve what was actually activated without carrying every skill body forward.

## 15. Mobile-friendly diff bounds

the earlier design limits its LCS work and output size. Large changes fall back to a coarse diff rather than allowing memory/time usage to grow without bound.

### TermAgent adaptation

Apply the same principle to expensive analysis paths:

```text
bounded exact analysis
        ↓
when limit is exceeded
        ↓
bounded coarse fallback
```

Each fallback must remain explicit so the model knows precision was reduced.

## 16. Android/ARMv7 release engineering

the earlier design's release history includes Android NDK targets for `armv7`, `aarch64`, `x86_64`, and `i686`, plus prebuilt-first installation and checksum verification.

### TermAgent adaptation

Add a dedicated release-engineering workstream for:

- ARMv7 Android builds
- reproducible cross-compilation
- checksum manifests
- prebuilt-first installation
- source-build fallback
- Termux-specific installation verification
- architecture detection tests

No ARMv7 success should be claimed from x86_64 CI alone. A real Termux smoke run remains the final evidence.

## 17. Ideas deliberately not adopted as-is

### Simple `read_file` implementation

the earlier design rereads the underlying file for each request. This is not suitable for the current exploration-safety work because it has no semantic coverage model.

### Exact-repeat-only loop protection

Useful as a backstop, insufficient as the primary detector for semantic exploration.

### Minimal summary compaction

the earlier design's compaction is a compact summary of recent conversation text. TermAgent should preserve richer provenance and durable semantic state rather than replacing the existing context architecture with a short transcript summary.

### JSON-file session truth

the earlier design stores session snapshots directly as JSON. TermAgent's durable event/session architecture should remain authoritative because it is needed for replay, reconnect, multi-client synchronization, permissions, questions, and future Web View behavior.

## 18. Concrete next implementation order

### Next 1 — close the 13M read gate

Adapt the existing `FileReadStateCache.lookup()` and `ExplorationState` so a fully covered non-exact range cannot fall through to a real filesystem read merely because it was not an exact cache key.

Required cases:

```text
1-100
→ 1-50       => no filesystem reread
1-100
→ 51-100     => no filesystem reread
1-100
→ 25-75      => no filesystem reread
1-100
→ 51-150     => read only 101-150
compaction
→ covered range => rehydrate when context requires it
file changed
→ old coverage invalidated, reread new evidence
```

### Next 2 — turn exploration progress into evidence progress

Make the no-progress detector consume explicit evidence deltas and ensure a physically executed redundant read cannot be counted as semantic progress.

### Next 3 — production-wire exploration guidance

the relevant TermAgent subsystem must actually participate in the production `Agent.run()` path or be explicitly retired. A correct module that is never invoked is decorative architecture.

### Next 4 — verification ledger + post-edit hooks

Reuse existing TaskManager/shell infrastructure. Add structured verification evidence and expose it to the model and UI through the same semantic state contract.

### Next 5 — provider/retry audit

Add stalled-stream and retry/cancellation fixtures and preserve provider-specific opaque metadata.

### Next 6 — structured UI state

Promote picker rows, activity, verification status, and diff surfaces toward semantic renderer-neutral models.

### Next 7 — Android release engineering

Build and verify ARMv7 artifacts on actual supported hardware/Termux before calling the portability gate complete.

## 19. Verification checklist for future phases

A the earlier design-inspired change should not be considered complete until it has:

- focused unit tests
- end-to-end agent tests
- deterministic replay coverage where applicable
- compaction/recovery coverage where applicable
- cancellation coverage
- concurrency coverage
- source-hygiene/security checks
- package/extracted-artifact checks
- real Termux/ARM verification when the change touches platform/runtime assumptions

## Source areas reviewed

The complete review covered the repository tree, configuration and documentation files, release workflow and all readable Rust modules, including:
- `tests/fixtures/tiny_mcp_server.py`
- `.github/workflows/release.yml`
- `AGENTS.md`
- `README.md`
- `config.example.toml`
- `Cargo.toml`
- `Cargo.lock`
- `install.sh`

No credentials or secret values from repository/tool-output content are reproduced here.
