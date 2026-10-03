# TermAgent 1.1.5 UI hardening

TermAgent 1.1.5 keeps the 1.1.4 rendering architecture but factors interactive selection into a small renderer-independent `SelectModel`.
TermAgent's prompt implementation keeps the prompt value and cursor offset as independent state and delegates terminal editing/rendering to its dedicated text-input component. Its permission prompt likewise renders a focused `Select` inside a permission scaffold instead of mixing approval input with the prompt editor.

TermAgent mirrors those invariants without importing React, Ink, or a heavyweight terminal UI framework:

- `PromptEditor` owns logical prompt text and cursor index.
- `TerminalUI` owns the rendered application state.
- `layoutTextInput()` is the single source of truth for wrapped visual rows and cursor coordinates.
- `SelectModel` owns focused-option state and key-to-selection semantics.
- `TerminalUI` paints the selected option and supplies the actual ANSI/VT terminal frame.

## Prompt transaction

Submitting a prompt is a transaction:

1. `PromptEditor` snapshots the logical value.
2. The editor records history and resets its draft.
3. `TerminalUI.setInput('', 0)` clears the composer state.
4. `TerminalUI.addUser()` moves the submitted value into conversation history.
5. `providerRun()` switches focus from the composer to the running-turn surface.

There is no second copy of the submitted prompt in the composer.

## Cursor model

The terminal hardware caret remains hidden during the alternate-screen UI. The cursor is painted into the prompt frame using inverse video, so cursor location is a pure function of prompt state and layout. This prevents terminal scroll/wrap side effects from moving the caret below the prompt.

## Permission model

While a permission request is pending, the permission selector owns stdin. The prompt editor does not receive those bytes. The selector supports:

- Up/Down and `j`/`k` focus movement
- Home/End focus movement
- Enter/Space confirmation
- `1` Allow once
- `2` Always allow
- `3` Reject
- `y`/`a`/`n` aliases
- Escape/Ctrl+C rejection

The active tool row changes to `awaiting approval` before the modal is painted and only changes to `running` after a positive selection.

## ARMv7 constraint

This layer remains dependency-free at runtime. No React, Ink, a heavyweight terminal UI framework, node-pty, native terminal renderer, or architecture-specific binary is required.
