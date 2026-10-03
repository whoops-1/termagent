# Provider Manager

## Purpose

Interactive `/provider` configuration is a modal terminal surface for managing saved model-provider profiles without leaving the chat session.

## Runtime flow

```text
/provider
   |
   v
Provider manager
   +--> Set provider
   |      +--> saved profile
   |      +--> environment/default
   |
   +--> Edit provider
   |      +--> select profile
   |      +--> edit fields
   |
   +--> Add provider
   |      +--> provider type
   |      +--> model
   |      +--> base URL
   |      +--> API key
   |
   +--> Remove provider
   |      +--> confirm
   |
   +--> Done
```

The modal owns stdin while it is open. The existing prompt editor remains mounted but ignores input until the manager closes.

## Persistence

Profiles are stored in `.termagent/config.json` for a project that already has a project config. Otherwise the manager uses `~/.termagent/config.json`.

Saved config files are written with mode `0600` and the directory is created with mode `0700` where supported.

An edit with an empty API-key field preserves the existing credential instead of clearing it.

## Editing behavior

The form supports:

- Up/Down or Tab between fields.
- Left/Right provider-type selection.
- Left/Right cursor movement in text fields.
- Home/End cursor movement.
- Backspace/Delete character editing.
- Ctrl+U to clear the current text field.
- Enter to advance through the form and save on the final field.
- Escape to return to the previous screen.

## Session activation

Set provider and creation of a new profile update the active in-memory provider and the UI model label. Editing an inactive profile leaves the current provider unchanged.

Removing the active profile selects the next saved profile when one exists; otherwise the runtime falls back to environment/default settings.

## Verification

The provider manager has persistence tests covering add, activate, rename, remove, environment reset, and config permissions. A terminal UI test covers the modal lifecycle, management menu, and a complete add-provider form. A real PTY smoke test also exercised `/provider`, the management menu, and provider creation against an isolated configuration.
