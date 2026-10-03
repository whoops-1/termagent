# Interactive UI verification

TermAgent uses an TermAgent-inspired terminal UI architecture without importing a heavyweight terminal UI framework. TermAgent's current text-input implementation keeps the logical input value, cursor line/column, rendered value, and viewport offset as separate state, and its permission prompt composes a reusable scaffold with a selectable list. TermAgent mirrors those boundaries with Node/ANSI primitives for ARMv7 Termux.

## Automated checks

The UI was verified through a real pseudo-terminal (PTY), not by unit-testing ANSI strings alone. The harness drives the compiled `dist/index.js`, changes terminal dimensions, sends real key sequences, parses the resulting ANSI screen state, and writes screenshots.

Cases covered:

- long wrapped prompt
- Up/Down movement across visual rows
- mid-buffer left/delete editing
- bracketed multiline paste
- submit and immediate draft clearing
- interactive shell permission prompt
- `y` / `a` / `n` permission selection
- post-approval tool execution
- command picker viewport navigation beyond the eighth visible row
- `Ctrl+P` palette filtering and execution
- SGR mouse click/release during a live model turn
- live activity phases and explicit reasoning collapse/expand
- PageUp/PageDown conversation scrolling at narrow terminal sizes

The screenshots were manually inspected after rendering. The permission modal now appears as an actual decision surface instead of falling through to an invisible or `readline` prompt.

The verification harness lives outside the release archive so the runtime has no Python or screenshot dependency.
