# Phase 6 - established style terminal interaction rework

## Baseline

TermAgent 1.5.0 with the completed `/provider` manager.

## Goal

Make the terminal interaction model follow the useful parts of the reference without importing its UI runtime. The existing Node + ANSI/VT renderer and mobile/Termux input path remain the foundation.

## Main transcript

The transcript intentionally stays sparse:

```text
user message
compact tool activity
compact change summary
assistant response
activity state
```

Tool arguments, large tool output, and full diffs are not rendered continuously in the main conversation.

## Dedicated inspectors

### Reasoning

`Ctrl+E` or `/thinking` opens a full-screen reasoning inspector. The assistant entry retains streamed reasoning, while the main transcript shows only a compact reasoning summary.

### Tool details

`Ctrl+O` or `/details` opens the latest tool call. The inspector shows arguments, result output, timing/state, and a link into the diff viewer when the tool produced file changes.

### Diff viewer

`/diff` and tool-details `d` open a dedicated file-oriented diff inspector:

```text
file list
  -> Enter
file detail
  -> Esc back
```

The existing Git/text diff engine in the relevant TermAgent subsystem remains the source of diff data.

### Permission/question views

Permission and question requests now take over the full terminal viewport. Existing selection models and Promise-based resolution remain unchanged. File write/edit permission requests continue to show a bounded proposed diff preview.

## Mobile/Termux behavior

- PromptEditor remains the owner of prompt editing.
- While an inspector is active, PromptEditor stays attached but yields input through `isModalActive`.
- Inspector input is handled by a separate parser.
- SGR/X10 mouse clicks are ignored, wheel events scroll inspectors, and terminal navigation sequences do not become model interrupts.
- Raw-mode ownership is coordinated between PromptEditor, active turns, and inspectors so closing an inspector does not strand the terminal in raw mode.
The design was adapted after inspecting the established terminal interaction patterns, including its REPL, reasoning/tool message components, permission dialogs, file edit/write permission requests, and diff presentation. Only interaction/state semantics were adapted; the framework-specific terminal UI renderer was not copied.
