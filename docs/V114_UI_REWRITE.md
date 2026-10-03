# TermAgent 1.1.4 UI hardening

## Purpose

1.1.4 continues the UI-only work paused before the planned 1.2 API expansion. It focuses on the four failures observed on a real Termux screen:

1. submitted text remaining in the composer;
2. the terminal cursor landing below the composer;
3. cursor movement/deletion behaving incorrectly across wrapped multiline input;
4. shell permission approval not owning the keyboard reliably.
The implementation is based on the current TermAgent terminal UI architecture rather than TermAgent's a heavyweight terminal UI framework runtime.

TermAgent's `BaseTextInput` keeps the logical value and cursor offset separate from rendered state and declares the cursor independently. `PromptInput` keeps cursor offset as application state and lets vertical movement operate on visual lines. Permission UI is represented as selectable state instead of a readline question.

TermAgent mirrors those boundaries with plain Node/ANSI components:

```text
PromptEditor
  value + cursorOffset + preferredColumn + history
          │
          ▼
Text-input layout
  visual rows + cursorRow + cursorColumn + viewport
          │
          ▼
TerminalUI state
  messages + tools + status + permission + prompt focus
          │
          ▼
Absolute-row frame renderer
          │
          ▼
Termux VT
```

This is deliberately a behavioral/architectural port, not a copy of TermAgent's framework-specific terminal UI runtime. No a heavyweight terminal UI framework, React, Yoga, native PTY, or architecture-specific UI binary is required by TermAgent.

## Prompt transaction

A submitted prompt now follows one state transition:

```text
editor Enter
  -> remember history
  -> clear editor value/cursor
  -> onChange('', 0)
  -> CLI receives submitted value
  -> UI adds user message
  -> agent turn starts
  -> composer remains empty while model/tools run
```

The composer and conversation history therefore cannot render the same submitted text as two separate copies.

## Declarative cursor

The hardware terminal cursor remains hidden while the alternate-screen UI is active. The prompt cursor is drawn as part of the rendered frame from the exact visual row/column returned by the shared text-input layout.

The cursor is therefore derived from application state rather than from the terminal's current implicit caret position. This prevents row drift when text wraps or the Android soft keyboard changes the terminal viewport.

## Permission ownership

While a permission request is pending, `TerminalUI` owns stdin. The agent-turn interrupt handler explicitly ignores input while the permission state exists, preventing two consumers from receiving the same key.

Available decisions:

- `y` / `1`: allow once
- `a` / `2`: always allow
- `n` / `d` / `3`: reject
- Up/Down or `j`/`k`: move selection
- Enter: confirm selected decision
- Escape or Ctrl+C: reject/fail closed

The current tool row changes from `running` to `awaiting approval` before the modal is shown and returns to `running` only after approval.

## Screenshot verification

The release is checked with a PTY harness that feeds the compiled CLI actual terminal-size changes and reconstructs screenshots from the ANSI stream at both 80x24 and 60x20.

Verified states:

- multiline prompt wrapping;
- cursor moved into the middle of a wrapped line;
- deletion and insertion at the moved cursor;
- submitted prompt appears once in conversation history and disappears from the composer;
- permission selector is visible at 60x20;
- approval input resolves without leaking into the prompt editor;
- post-approval tool result returns to the normal composer.
