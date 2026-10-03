# TermAgent interactive UI architecture

## Goal

The interactive UI follows the behavior and state separation used by TermAgent's terminal UI without copying its React runtime. TermAgent keeps prompt text, cursor offset, and rendered/viewport state separate in `BaseTextInput`, and composes permission requests from a scaffold plus a reusable `Select` component. TermAgent mirrors those boundaries with small Node/ANSI components so the runtime stays ARMv7-safe. TermAgent's current package is Node-compatible at runtime and uses `react`, `react-reconciler`, custom `ink.js`, `CustomSelect`, `wrap-ansi`, `figures`, and `cli-boxes`; it does not depend on a heavyweight terminal UI framework.

## 1.6.0 interaction model

The main transcript is intentionally sparse. Tool calls, change summaries, assistant responses, and compact activity state stay visible in chat. Large tool arguments/results, reasoning text, and complete diffs move into dedicated inspectors.

```text
Main chat
  -> compact tool activity
  -> compact change summary
  -> response

Ctrl+E / /thinking
  -> reasoning inspector

Ctrl+O / /details
  -> tool-details inspector
  -> d
       -> diff file list
       -> Enter -> file detail

/diff
  -> diff file list
  -> Enter -> file detail

permission/question/provider request
  -> blocking full-screen modal
```

Inspectors are views over the existing `TerminalUI` execution state. They do not create a second agent loop, message store, or renderer.

## State flow

```text
stdin
  -> PromptEditor
       value + cursorOffset + preferredColumn + history
       -> visual layout
       -> UI state
  -> TerminalUI
       messages / tool activity / status / permission
       -> frame renderer
       -> ANSI/VT terminal
```

The input editor never edits terminal rows directly when the TTY UI is active. A submitted value is remembered and cleared before the submit result is returned to the agent loop. This prevents a stale draft from surviving into the next render.

## Visual cursor

the relevant TermAgent subsystem computes the exact same visual rows used for painting and returns the cursor row/column plus viewport character offsets. Up/down movement targets visual wrapped rows, not only logical newline-separated lines. This is important for pasted long prompts.

## Permission prompt

The permission path follows TermAgent's reusable select pattern:

```text
ToolRegistry
  -> PermissionGate
     -> PermissionRequester
        -> TerminalUI.requestPermission()
             -> permission state
             -> selection navigation
             -> allow once / always allow / reject
             -> resolve Promise
        -> tool executes or receives denial
```

The permission UI owns stdin while visible, so the prompt editor and model interrupt listener cannot consume approval keys accidentally. Escape denies the request, while Ctrl+C also fails closed.

## Rendering rules

- Alternate-screen UI is retained.
- Wrapping is disabled while a frame is painted.
- Changed rows are addressed with absolute `CSI <row>;1H` coordinates.
- Changed rows are erased before repainting.
- Rows are rendered to the actual terminal width, not `width - 1`.
- The cursor is painted declaratively inside the prompt frame from the same layout state used to paint the input; the hardware terminal cursor stays hidden while the UI is active.
- Prompt rows and user-message rows fill their visual background across the terminal width.
- The model-thinking state is represented by compact activity text rather than a fake empty assistant message. Reasoning is inspectable through the dedicated reasoning view instead of being expanded in the main transcript.

## Why we do not install a heavyweight terminal UI framework

TermAgent uses a heavyweight terminal UI framework today, but TermAgent's target is 32-bit ARMv7 Termux. The UI therefore copies interaction and state patterns from TermAgent while keeping the final renderer dependency-free and based on Node standard APIs plus ANSI/VT control sequences.
## 1.1.6 command picker and chat viewport

The 1.1.6 prompt follows the implementation of separating logical input/cursor state from the suggestion list and focused selection. The command picker is bounded to eight visible rows and updates from the current slash query. Conversation scrolling is held in `TerminalUI.scrollOffset`; PageUp/PageDown, Ctrl+Up/Down, Ctrl+Home/End, and mouse-wheel input change this viewport without invoking prompt history.

The implementation deliberately remains renderer-agnostic and native-dependency-free. TermAgent keeps the renderer dependency-light and native to its ANSI/VT stack. The target is stable behavior and semantic state, not a framework-specific rendering runtime.
## 1.1.7 interaction hardening

The suggestion list and its viewport are separate concerns. `PromptEditor` owns the full filtered result set and focused index; `TerminalUI.commandMenu()` owns the eight-row viewport. A focused index of 0..N is therefore independent of what happens to be visible.

Agent-turn stdin uses a terminal-sequence parser rather than treating every ESC-prefixed byte as an interrupt. SGR/X10 mouse click and wheel reports, CSI navigation, and split control sequences are consumed before interrupt handling. This prevents touch/click input from aborting a running request. Ctrl+C remains an explicit interrupt and a standalone Escape is still available with a mobile-safe delay for split sequences.

Activity and reasoning are durable UI state, not terminal side effects. The provider emits explicit `reasoning` events only when a provider exposes an explicit reasoning/thinking field. The UI stores that content on the assistant entry. The main transcript shows only a compact reasoning row, while the dedicated reasoning inspector displays the full emitted content. The implementation never fabricates hidden reasoning; it only displays reasoning content explicitly emitted by the provider.

## Phase 13N-I semantic presentation layer

13N-I adds a renderer-neutral semantic layer without replacing the Node/ANSI renderer. `CompletionItem` and `PickerRow` carry stable IDs and semantic fields; `pickerLayout()` is the shared geometry contract; `HitTargetRegistry` turns rendered coordinates into intent; and `ThemeTokens` provides grouped visual semantics for future clients.

The transcript renderer uses a `WeakMap` cache keyed by entry identity and explicit revision. A stable transcript item therefore survives unrelated status/composer renders without rebuilding markdown/diff/tool presentation. Streaming or lifecycle changes bump only the affected entry.

The active-turn mouse rule is intentionally fail-closed: ordinary clickable regions are not busy-enabled, and only the explicit interrupt target is allowed to abort a live turn. This avoids treating arbitrary touch/click coordinates or terminal escape sequences as cancellation commands.
