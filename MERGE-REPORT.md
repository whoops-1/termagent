# TermAgent 1.18.0 UI Merge Report

## Production merge

The Stage E UI design-system work is merged into the production CLI renderer. The existing TermAgent state machine, provider flow, tools, persistence, and server architecture remain in place.

Merged production areas:
The obsolete duplicate experimental CLI implementation was removed after merge so there is one production source of truth for CLI behavior.

## Visual behavior

- Full ANSI Shadow splash is shown for a fresh empty session.
- The startup splash collapses to a compact `>_ TermAgent v1.18.0` header after conversation begins.
- The banner uses a forest-green semantic palette and has narrow-terminal fallbacks.
- No rainbow gradient or mascot/smiley treatment remains.
- Picker layout preserves the global selection index and uses bounded visible windows.
- Dialog, transcript, tool, diff, reasoning, Markdown, table, and footer surfaces use width-safe semantic rendering.

## Verification

- Root TypeScript build: PASS
- Root test suite: 325/325 PASS
- Merged UI hardening suite: 8/8 PASS
- Experimental design-system/PTY suite: 64/64 PASS
- Preview TypeScript build: PASS
- JavaScript syntax checks: 107 production JS files + preview JS files PASS
- CLI `--help`: PASS
- CLI `--version`: PASS (`1.18.0`)
- CLI `--doctor --json`: PASS, valid JSON
- Source hygiene scan: PASS
- reference brand-name scan in shipped production source: PASS
- Visual QA: 80x24 production splash and post-input compact state rendered and inspected
