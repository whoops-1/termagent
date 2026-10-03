# Phase 13N-I Report: Semantic UI State and Performance

Phase 13I adds the semantic UI/performance layer required before the multi-client Web View work. It is implemented on top of the existing TermAgent TUI rather than by replacing the renderer stack.

## Delivered

- Structured picker and completion rows with stable semantic IDs, labels, details, badges, status, disabled state, and values, with legacy string compatibility.
- Shared picker geometry used by both rendering and mouse hit testing.
- Weakly keyed transcript render caching with explicit per-entry revisions so stable transcript entries are not re-rendered during unrelated prompt/status updates.
- Renderer-neutral SGR/X10 mouse parsing and semantic hit-target registration.
- Busy-state input hardening where only the explicit `esc interrupt` target can abort a live turn.
- Shared grouped `ThemeTokens` for future Terminal/Web/VS Code renderers while preserving the current flat theme API.
- Regression coverage for disabled picker rows and for the Phase 12F visual layout contract.
The implementation adopts the validated memoization, stable-identity, and semantic click-guard patterns recorded during the UI review while preserving TermAgent's ARMv7-safe Node/ANSI architecture.

## Verification

- `npm run build` -> **PASS**
- `tests/phase13n-i-semantic-ui.test.mjs` -> **9/9 PASS**
- Focused compatibility set -> **71/73 PASS**
- Phase 12F visual snapshots -> **PASS**
- Two remaining focused failures are legacy `requestQuestion()` return-shape expectations outside the 13N-I scope.
- Repository-wide aggregate remains a known runner gate because of the existing provider-manager hang; ARMv7/Termux hardware verification remains unavailable on this host.
