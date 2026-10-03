# Phase 13N-I: Semantic UI State and Performance

## Scope

Phase 13N-I moves interaction and picker state from display-string interpretation toward stable semantic data, adds per-entry transcript rendering reuse, introduces coordinate-based semantic hit targets, hardens busy-turn input so ordinary clicks cannot interrupt the agent, and exposes grouped theme tokens for the future Terminal/Web/VS Code clients.

The implementation extends the existing TermAgent Node/ANSI UI. It does not replace the renderer with a heavyweight terminal UI framework/React or introduce a second UI state store.

The recorded research note is `the implementation` the recorded behavior.

Relevant implementation patterns:

- Session TUI message rows are treated as stable renderable units so unchanged rows do not need to reconstruct their expensive content on every render.
- The TUI uses component-level memoization and stable list identity around message rendering rather than parsing already-rendered terminal strings back into semantic state.
- Clickable surfaces guard mouse-up actions when a text selection exists. the a documented issue #24986 documents the failure mode: drag-selecting a question option can otherwise submit the option on mouse-up. The existing guard pattern is `renderer.getSelection()?.getSelectedText()` before activating a clickable surface. See the issue for the documented root cause and affected handlers:  TermAgent/issues/24986.


The recorded research note is `the implementation` the recorded behavior.

Relevant local source patterns inspected from that revision:

- the relevant TermAgent subsystem uses memoized message rendering and cheap derived slices for the visible transcript.
- the relevant TermAgent subsystem keeps stable item identity and per-item handlers.
- the relevant TermAgent subsystem uses a module-level object-identity cache for expensive diff rendering.

TermAgent adapts these principles with a `WeakMap` keyed by mutable entry object plus an explicit revision counter. This avoids relying on immutable React object identity while still limiting invalidation to entries that actually changed.

## Implementation

### Structured semantic picker rows

the relevant TermAgent subsystem now accepts `PickerRow` values with:

- `id`
- `label`
- `detail`
- `badge`
- `status`
- `value`
- `disabled`
- `key`

The legacy `PickerOption[]` path remains supported and is adapted into semantic rows. Layout calculation is centralized in `pickerLayout()` so the rendered viewport and registered hit-target viewport use the same row height, visible-window, query/footer, and short-terminal constraints.

the relevant TermAgent subsystem now exposes structured `CompletionItem` and `CompletionState` data while preserving the old `items: string[]` compatibility field. Command, agent, and file completion sources emit stable semantic IDs. File rows also carry a directory badge where applicable.

### Transcript rendering cache

the relevant TermAgent subsystem provides an entry-identity `WeakMap` cache. `TerminalUI` assigns each mutable transcript entry an explicit revision. A cache key includes render dimensions and semantic visual modes that can legitimately change output, including width, theme, color capability, reasoning visibility, and diff mode.

A stable entry therefore reuses its rendered lines across unrelated prompt/status renders. Assistant streaming, tool lifecycle changes, tool results, and permission transitions bump only the affected entry's revision.

The existing absolute-row frame diff remains in place. This phase adds semantic render reuse before that terminal diff, rather than replacing the proven frame-addressing layer.

### Semantic mouse and touch hit targets

the relevant TermAgent subsystem provides `HitTargetRegistry` with coordinate bounds, priority, disabled state, and an explicit `allowWhileBusy` capability. Rendering registers semantic targets; input dispatch tests coordinates against the registry instead of inspecting terminal strings.

`PromptEditor` parses both SGR and X10 mouse reports into a renderer-neutral `PromptMouseEvent`. X10 packets are held until their complete six-byte form is available so split mouse reports cannot be misread as ordinary Escape input.

The current UI registers command-picker rows and the explicit `esc interrupt` control. The picker target bounds are derived from the same `pickerLayout()` used to render the menu.

### Busy-state interrupt hardening

During an active agent turn, ordinary mouse presses are ignored by semantic dispatch because their targets are not permitted while busy. The only busy-enabled target is the explicit `interrupt` control. Ctrl+C continues to use the same interrupt function.

This is intentionally narrower than a generic "click cancels" mechanism. A future Web/VS Code client can expose a different semantic command without coupling that client to terminal escape sequences.

### Shared semantic theme tokens

the relevant TermAgent subsystem defines grouped `ThemeTokens` for:

- surfaces
- content
- borders
- accents
- status
- semantic roles
- diffs
- markdown
- syntax

`themeTokens()` in the relevant TermAgent subsystem returns a stable cached view over the existing flat `Theme` object. Current terminal renderers remain unchanged, while future Web/VS Code renderers can consume the same semantic role vocabulary without importing ANSI-specific presentation code.
## Reconciled live-input and queue work

The final 13N-I tree keeps the richer visual system from the Complete Visual System + HUD snapshot and adds the missing runtime interaction layer. Prompt input remains owned by `PromptEditor` while the agent runs. The agent no longer needs to attach a second stdin listener when the editor is active, so ordinary typing, picker use, and touch events cannot accidentally cancel the turn.

`SessionPromptQueue` is the runtime authority. Queued prompts are durable `prompt.queue` session events and are projected to the terminal through `queuePanelEntries()`. The same visible-row geometry drives edit/cancel hit targets, and executing rows are intentionally non-editable. Queue mutation occurs under the existing session mutation lock.

Session switching, restore, compaction, destructive undo/redo, provider mutation, and quit/exit are blocked while an active turn is running so an in-flight turn cannot finalize against another session.

## Markdown tables

Markdown tables are parsed before ANSI rendering into a semantic table model. Width calculation accounts for Unicode display width, wrapped inline segments, declared alignment, empty cells, and terminal breakpoints. Wide terminals use bordered grids; tighter terminals use compact grids; constrained mobile widths fall back to per-record cards.

## Compatibility behavior

The phase deliberately keeps the old picker and completion string interfaces available. New callers can supply semantic rows, while existing code can continue supplying strings. Command descriptions are derived from canonical command IDs only; generic palette rows no longer receive synthetic display text such as `palette`, which keeps the existing Phase 12F visual contract stable.

## Verification

### Build

- `npm run build` -> **PASS**

### Phase-specific gate

- `tests/phase13n-i-semantic-ui.test.mjs` -> **9/9 PASS**

Coverage includes structured rows, shared picker geometry, transcript cache invalidation, hit-target priority/busy filtering/disabled targets, SGR and X10 parsing, semantic completion compatibility, mouse selection, TerminalUI hit-target registration, and theme-token identity/grouping.

### Focused compatibility gate

- Phase 14A event/interactions + Phase 13N-H + HTTP server + Phase 13N-I + Phase 12E/12F + input/UI suites -> **71/73 PASS**.
- Phase 12F deterministic visual snapshots -> **PASS** after removing the synthetic `palette` detail from generic palette rows.
- The two remaining failures are the same legacy `requestQuestion()` return-shape expectation in `tests/phase12f-ui.test.mjs` and `tests/ui.test.mjs`: those tests expect the old raw `string[][]`, while the current API returns the structured `{ status: 'replied', answers: string[][] }` contract used by the protocol/session/question system. They are not caused by 13N-I.

### Aggregate test boundary

The repository-wide `npm test` runner is not being used as a phase gate. Earlier aggregate runs reached 478 passing tests and then hung in the existing long-lived provider-manager test. Physical ARMv7/Termux execution is also unavailable on the x86_64 verification host.

## Phase result

13N-I is verified at its own feature gate. The semantic UI layer is now suitable as the presentation contract for later multi-client work without forcing Web or VS Code to scrape ANSI output.
