# Process Improvement Memo






This memo is based on a full source/configuration/documentation/test/workflow review of the repository. The suggestions are ordered roughly by engineering leverage rather than by how flashy they look in a terminal demo.

## 1. Make exploration evidence-aware

The current exact-repeat guard is useful, but it only catches three byte-identical calls in a row. A stronger exploration loop can measure whether each action actually produced new evidence.

Track a compact exploration state such as:

```text
Files
  path
  version
  observed ranges
  full coverage

Searches
  normalized query
  discovered files
  discovered symbols

Verification
  command
  status
  bounded summary
```

Then define progress from the delta between states.

```text
new evidence
  -> reset no-progress counter

no new evidence #1
  -> nudge the model to change strategy

no new evidence #2
  -> constrain redundant strategy

no new evidence #3
  -> stop and summarize what is already known
```

Keep the existing exact-duplicate block as a separate emergency backstop.

### Why this helps

A model can legitimately read different ranges, search different paths, or revisit a file after context loss. Those are not equivalent to making no progress. Evidence deltas distinguish them cleanly.

## 2. Prevent redundant reads before filesystem execution

The current `read_file` path is intentionally simple. A useful next improvement is to add a coverage classification before the filesystem read.

Desired behavior:

```text
first read 1-100
  -> read filesystem

then read 1-50
  -> already covered, return existing evidence

then read 25-75
  -> already covered, return existing evidence

then read 51-150
  -> read only 101-150
```

When context was compacted and the text is still reconstructible, return the reconstructed evidence instead of touching the disk again.

When the file version changed, invalidate the previous coverage and read the new version.

This prevents the agent from wasting both disk I/O and model context on redundant reads.

## 3. Parallelize independent read-only calls

The current batch execution model is one of the strongest parts of the project. Keep the rule explicit in the agent instructions:

```text
independent reads/searches -> emit in one tool-call batch
writes or order-dependent actions -> keep sequential
```

At runtime:

1. Gate every call in emitted order.
2. Run pure read-only calls concurrently.
3. Store results by tool-call ID.
4. Return them to the model in original call order.

This reduces provider round trips while keeping the transcript deterministic.

## 4. Add post-edit verification hooks

A very practical feature is a small configuration layer for commands that should run after successful edits.

Example:

```toml
[hooks]
post_edit = [
  "cargo fmt --check",
  "cargo test"
]
```

For every successful edit:

```text
edit
  -> hook(s)
  -> exit code + bounded output
  -> tool result
```

The tool result should clearly distinguish:

```text
PASS
FAIL
TIMEOUT
CANCELLED
```

The agent prompt should tell the model not to rerun a hook manually when the hook already succeeded, unless the user explicitly asks.

## 5. Treat LSP diagnostics as asynchronous

Language servers can publish provisional diagnostics while indexing or analyzing.

Do not treat:

```text
0 diagnostics
```

as equivalent to:

```text
analysis finished and file is clean
```

Use a state model such as:

```text
unknown
running
provisional
clean
failed
timed_out
cancelled
```

When the server has not reached a settled state by the configured budget, tell the model that the result is provisional instead of silently presenting it as clean.

## 6. Build a verification ledger

A small structured verification history would make `/status`, the model context, and debugging much clearer.

Example:

```text
Verification
────────────
✓ cargo fmt --check
  exit 0 · 1.2s

✓ cargo test
  exit 0 · 18.8s

⚠ rust-analyzer
  still analysing

✗ npm run build
  exit 1
```

Store only the semantic facts needed for reasoning and UI. Keep large command output bounded or externalized.

## 7. Expand specialist sub-agents carefully

The current `planner`, `researcher`, `coder`, `reviewer`, and `tester` roster is a good foundation.

A useful next step is to make the restrictions stronger and easier to configure:

- role-specific tool allowlists
- explicit read-only roles
- maximum concurrent delegates
- parent/child cancellation
- per-role token/cost budgets
- compact result reports
- no unbounded recursive delegation

The reviewer should remain read-only by default.

## 8. Improve checkpoint UX

The checkpoint/branch system is already useful. Make the workflow visually prominent and easy to inspect:

```text
/checkpoint before-refactor
/checkpoints
/branch <checkpoint>
```

A checkpoint picker can show:

```text
#1  before-refactor   42 msgs   2026-10-01
#2  before-tests      61 msgs   2026-10-01
```

Keep checkpoints immutable.

## 9. Promote picker data to structured state

The current `PickerRow { label, detail, badge }` approach is good. Extend it across all picker-like surfaces and avoid making rendering code split strings to recover semantics.

Useful additional fields later could include:

```text
label
detail
badge
group
status
icon
search_text
selectable
```

This will make keyboard, mouse, and future frontend rendering easier to keep consistent.

## 10. Improve TUI performance with render caching

For large transcripts, re-wrapping every historical line on every frame is wasteful.

Cache:

```text
entry identity
width
wrapped lines
```

Invalidate only when:

- terminal width changes
- the entry changes
- theme changes
- font/character-width assumptions change

Streaming tails can stay uncached until settled.

## 11. Keep mouse/touch geometry semantic

The TUI already stores rectangles for interactive surfaces. Extend this pattern so the render pass registers semantic targets such as:

```text
picker row 4
approval yes
question option 2
scroll hint
composer
close overlay
```

A touch event should resolve to a semantic action, not just a coordinate hack. This becomes increasingly useful as mobile interaction grows.

## 12. Add a stronger interrupt UX

The existing double-Esc idea is sensible. Keep the accidental-cancellation protection, but ensure the UI makes the state obvious:

```text
Esc once
→ interrupt armed

Esc again within window
→ cancel
```

Also provide an explicit visual interrupt target while busy.

## 13. Harden provider streaming

The provider layer is already careful. Continue the same approach with deterministic tests for:

- fragmented tool-call IDs/names/arguments
- provider-specific metadata preservation
- transient HTTP errors
- transport failures
- retry backoff
- Retry-After
- stream idle timeout
- cancellation during backoff
- cancellation during streaming

Keep retry count bounded so a phone is never trapped in a retry staircase.

## 14. Preserve opaque provider metadata

The `extra_content` approach for provider-specific fields is a strong protocol choice.

General rule:

```text
runtime understands what it needs
provider-specific opaque fields survive round-trip unchanged
```

This avoids breaking providers when the protocol carries metadata the local runtime does not interpret.

## 15. Improve managed-process edge cases

Long-lived process support is already strong. The next audit should specifically target:

- shell parent exits while a child retains pipes
- descendant process cleanup
- pipe drain completion
- stdin write timeout
- stdin-after-EOF errors
- bounded stdout/stderr history
- monotonic process IDs
- stop versus forced kill behavior

Include real-process fixtures, not only mock objects.

## 16. Make skills progressively disclosed

Keep the current pattern:

```text
skill discovery
  -> compact descriptor
  -> user/model selects
  -> full SKILL.md loaded
```

Avoid putting complete skill bodies into the base prompt.

Project-defined skills should override global ones deterministically, and skill activation decisions should be visible enough to debug why a workflow was selected.

## 17. Bound expensive diff generation

The current LCS-based diff approach is sensible for small changes. Keep hard limits around both:

```text
LCS work
rendered diff size
```

For very large changes, fall back to a coarse replacement representation and clearly tell the model/user that the diff was abbreviated.

This protects low-memory devices from a single pathological edit.

## 18. Improve configuration round-trip tests

Because `Config::save()` rewrites the entire config structure, every persisted section should have a round-trip test.

For every new setting:

```text
construct
→ save
→ load
→ assert value survives
```

Also test that unrelated sections survive the same save.

This prevents a surprisingly nasty class of "the setting worked until the next menu action" bugs.

## 19. Strengthen Android release engineering

The release workflow is already headed in the right direction. Keep it explicit and verifiable:

- Android NDK builds for `armv7`
- Android NDK builds for `aarch64`
- Linux targets where useful
- checksum manifests
- prebuilt-first installer
- source-build fallback
- architecture detection
- Termux install smoke tests

Fix environment-variable naming by the exact target triple expected by the compiler/build crate. Cross-compilation bugs often hide there instead of in Rust code itself.

## 20. Consider a single semantic theme model

The `Theme` struct already centralizes a large amount of TUI styling. Take it one step further by distinguishing semantic roles from literal colors:

```text
accent
success
warning
error
surface
surface_fg
border
border_focus
muted
code
selection
```

Every renderer should consume those semantic roles.

That will make later UI redesigns dramatically cheaper because the application stops encoding meaning as scattered color choices.

## 21. Improve the status/dashboard surface

A compact dashboard can expose facts that users otherwise have to infer from logs:

```text
provider
model
session
cwd
requests
tokens
budget
active plan
last verification
busy state
```

Use badges and compact values so it remains useful on phone-sized terminals.

## 22. Add deterministic replay fixtures

Provider and tool systems become much easier to debug when a real stream can be recorded and replayed.

Record:

```text
provider request identity
stream events
tool calls
tool results
termination reason
```

Then replay against a fresh runtime and assert the semantic result is unchanged.

Keep secrets out of recorded fixtures.

## 23. Security details worth preserving

Keep these properties explicit:

- API keys are never shown in `/status`-style output
- config files holding keys use owner-only permissions where supported
- MCP tools get explicit third-party consent policy
- secret-looking files get a deny-by-default path
- workspace containment remains symlink-aware
- unsafe TLS mode is explicitly labeled as dangerous
- logs exclude prompts, file contents, and credentials

## 24. Suggested order for the next releases

### Immediate reliability

1. coverage-aware read classification before filesystem execution
2. evidence-aware exploration progress
3. stalled-stream and retry tests
4. post-edit verification hooks

### Next capability layer

5. settled/provisional LSP diagnostics
6. verification ledger
7. stronger delegation budgets/recovery
8. checkpoint UX polish

### Performance and UX

9. render caching
10. semantic hit targets
11. semantic picker models
12. unified theme tokens

### Platform

13. reproducible ARMv7 builds
14. prebuilt installer verification
15. real Termux smoke suite

## 25. What to avoid

Do not solve every problem by adding another background loop or global cache. Each new state holder should have a clear owner, lifecycle, invalidation rule, and test.

Do not turn exact tool-call counts into a proxy for correctness. A large repository may legitimately need many reads.

Do not call an incomplete verification result clean.

Do not expose raw provider credentials or large command outputs through the normal UI/log path.

Do not trade deterministic tool-result ordering for a small concurrency speedup.

Do not make a UI optimization that changes the semantic state visible to the agent.

## Final target architecture

The long-term shape can remain simple:

```text
                 Agent runtime
                      │
        ┌─────────────┼─────────────┐
        │             │             │
     tools        semantic state   sessions
        │             │             │
        └─────────────┼─────────────┘
                      │
                TUI / clients
                      │
        ┌─────────────┼─────────────┐
        │             │             │
      terminal       future UI    integrations
```

The key principle is to keep execution, semantic state, and presentation responsibilities separate enough that each can become more capable without turning the project into one giant state machine.
