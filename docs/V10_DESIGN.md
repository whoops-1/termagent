# TermAgent 1.0 Interactive Terminal Design

## Goal

Replace the line-oriented TTY prompt with a dependency-free interactive terminal editor while keeping the existing agent engine, sessions, providers, tools, MCP, plugins, skills, tasks, and context layers unchanged.
- TermAgent: the relevant TermAgent subsystem routes interactive runs to a dedicated runtime and treats TTY capability as a hard requirement for interactive mode. It also supports replay, continuation, forking, slash commands, agent/model selection, file inputs, and a direct interactive mode.
- TermAgent: the relevant TermAgent subsystem maintains a prompt-history ring derived from session messages. TermAgent derives initial history from persisted user turns and keeps a bounded local history ring.
- TermAgent: the relevant TermAgent subsystem documents common line-editing shortcuts such as Ctrl+A/E, Ctrl+B/F, word movement, deletion, kill-to-start/end, and Ctrl+G cancellation. TermAgent implements the low-cost subset using Node raw TTY input.
- TermAgent: the relevant TermAgent subsystem owns prompt buffer state, cursor position, paste handling, mode detection, and input-change state rather than putting those concerns in the agent engine. TermAgent follows the same separation: the relevant TermAgent subsystem owns editing state and the relevant TermAgent subsystem owns command/agent dispatch.

## Interaction model

When stdin and stdout are both TTYs, `PromptEditor` enters raw mode and consumes terminal key sequences directly. Enter submits the prompt. Ctrl+J and Alt+Enter insert newlines. Arrow-up/down walk the bounded prompt history. Tab resolves slash commands, custom agents, and project-relative `@file` candidates. Backspace/delete, Home/End, Ctrl+A/E, Ctrl+B/F, Alt+B/F, Ctrl+W, Alt+D, Ctrl+U/K, Ctrl+D, and Ctrl+L provide common terminal editing behavior.

Bracketed paste is enabled while the editor is active. Pasted newlines therefore become part of the prompt rather than being treated as submission keystrokes. Terminal resize events trigger a redraw using display-width-aware row calculation for common wide Unicode ranges.

The renderer owns only the rows occupied by the current prompt/completion popup. It clears and redraws that small region rather than maintaining a full alternate-screen UI. This keeps CPU and memory usage low on ARMv7 phones and avoids a dependency on a heavyweight terminal UI framework or another native renderer.

## Non-TTY behavior

When stdout or stdin is not a TTY, `repl.ts` keeps a standard Node readline async iterator. This preserves shell pipelines, CI, automated tests, and redirected input. The interactive editor is never initialized in that path.

## Session/agent integration

Submitted prompts are remembered by the editor and continue through the same `handleInput` command dispatcher used by every existing TermAgent feature. Model streaming still uses the existing `Agent.run()` callback interface. The input editor is disabled while a model turn is executing, so streamed model/tool output cannot corrupt the editable prompt surface.

## Portability constraints

The interactive layer uses only Node standard-library terminal/process APIs and ANSI/VT control sequences. It introduces no runtime npm dependency and no native binary. The design therefore remains compatible with the target ARMv7 Android/Termux runtime.

## Reliability fix discovered during 1.0 verification

Background task state writes now serialize per task and use unique temporary filenames before atomic rename. Worker shell execution listens to `exit` and records failures explicitly. Worker entry has fatal-error handling so unexpected exceptions mark the task failed instead of leaving stale `running` state.
