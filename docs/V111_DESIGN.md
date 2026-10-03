# TermAgent 1.1.2 Interactive TUI Design

TermAgent 1.1.2 pauses the 1.2 API work and fixes the interactive terminal surface first.

## Goal

Make the TTY experience behave like a modern TermAgent-style coding-agent TUI while keeping the ARMv7 portability constraint intact.

TermAgent TUI is built around a persistent session surface: conversation content occupies the main viewport, the prompt is anchored at the bottom, and the footer exposes prompt controls. TermAgent also provides `@` file references and multiline prompt editing with several newline shortcuts.

TermAgent reproduces that interaction model with Node's standard terminal APIs and ANSI/VT sequences instead of a heavyweight terminal UI framework. This avoids the native UI dependency that is problematic for the target 32-bit ARM Android runtime.

## Layout

- Alternate terminal screen while interactive mode is active.
- Persistent session header with the current task title, agent mode and model.
- Scrollable conversation viewport.
- User messages rendered as a visually separated panel with a colored rail.
- Assistant streaming output remains in the conversation viewport.
- Tool calls and tool results stay attached to the conversation rather than printing directly into the shell prompt.
- Prompt is fixed at the bottom with a model/agent/provider row.
- Footer shows the primary prompt actions. `Tab`/`Shift+Tab` cycle built-in agents; `Ctrl+P` surfaces commands and `Ctrl+T` reports the current variant availability.

## Input correctness

The old editor mixed cursor-row calculations, wrapped rows and incremental terminal erasure. That could make a backspace repaint the physical line above the cursor instead of only changing the input buffer. The renderer now redraws every row at an absolute terminal coordinate with line wrapping disabled during the frame, so newline carriage semantics cannot shift subsequent rows horizontally.

1.1.2 moves interactive rendering to a stable screen renderer. The editor only owns the logical buffer/cursor; `TerminalUI` owns the screen. The full screen is rebuilt from application state, so stale physical rows cannot be interpreted as part of the input buffer.

Vertical arrow keys now move between multiline logical lines and only fall back to history at the top/bottom boundary. History no longer steals every Up/Down press.

Bare Escape is recognized, bracketed paste remains enabled, and modified Enter sequences are accepted for newline insertion.

## Interrupts

While a model turn is running, TermAgent temporarily places stdin in raw mode and listens for Escape/Ctrl+C. That signal aborts the provider request through the existing Agent signal path instead of corrupting the prompt renderer.

Abort errors are not retried.

## Agent iteration budget

Interactive runs use a 50-round default safety cap. `TERMAGENT_MAX_TOOL_ROUNDS=0` explicitly disables the round cap for advanced/headless use, while loop guards still protect normal turns from repeated identical calls and repeated write-only rounds.

The last iteration is text-only. When the configured step budget is reached, the model is asked to summarize completed work and remaining work rather than causing a hard `Tool loop exceeded ...` failure.

Built-in modes do not impose a tool-step cap by default. Set TERMAGENT_MAX_TOOL_ROUNDS or a custom agent `steps` value to impose one.

## Non-TTY behavior

Pipes and CI continue to use the existing line-oriented path. TermAgent-style alternate-screen renderer is only enabled when stdin and stdout are both TTYs.

## Portability

No a heavyweight terminal UI framework, Bun, node-pty, SQLite addon, Rust runtime, or architecture-specific UI binary is introduced by 1.1.2.
