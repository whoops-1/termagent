# TermAgent 1.1.2 UI Rewrite

## Why the 1.1.2 renderer was not enough

The previous TUI still split responsibility between an input editor and a screen renderer in a way that could leave a submitted buffer visible, place the cursor outside the prompt, or let `readline` compete with the raw-mode terminal UI.
TermAgent's current terminal UI uses a custom Ink-style framework-specific renderer, not a heavyweight terminal UI framework. Its `BaseTextInput` keeps `value`, a character `offset`, and explicit `cursorLine`/`cursorColumn` state, then declares the cursor separately from text rendering. `PromptInput` also keeps internal input/cursor state and treats permission prompts as modal/selectable UI. TermAgent follows those same boundaries without importing framework-specific UI dependencies, or native UI packages.

Relevant implementation areas:
Relevant implementation areas were used to validate the behavior described below.

## TermAgent mapping

```text
PromptEditor
  └── logical buffer + cursor offset
        │
        ▼
TerminalUI
  ├── visual wrapping
  ├── cursorLine/cursorColumn calculation
  ├── frame buffer + row diff
  ├── alternate screen
  └── modal permission UI
        │
        ▼
      Termux VT
```

This is intentionally not a literal port of TermAgent's custom framework-specific renderer. The target runtime is Node on ARMv7 Android, so avoiding additional native or architecture-specific packages remains a hard constraint.

## Permission flow

```text
Agent
  -> ToolRegistry.execute
    -> PermissionGate.check
      -> interactive PermissionRequester
        -> TerminalUI.requestPermission
          -> modal rendered
          -> stdin owned by permission selector
          -> once / always / deny
        -> PermissionGate resolves
    -> tool executes or receives denial error
```

The model-turn interrupt handler ignores Escape while the permission modal owns the keyboard, but Ctrl+C still aborts the turn.

## Rendering rules

- No LF-based frame painting.
- Every changed row is addressed with an absolute `CSI <row>;1H`.
- Every frame clears changed rows with `CSI 2K`.
- Cursor coordinates are derived from the same input layout used to paint the prompt.
- The prompt buffer is blanked on submit before the agent turn begins.
- Modal UI hides the text cursor and exclusively handles approval input.
