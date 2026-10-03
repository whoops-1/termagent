# TermAgent Experimental UI/UX TODO

This checklist is derived directly from `UI-RESEARCH-PLAN.md`. The experimental renderer was approved and merged into production the relevant TermAgent subsystem, the relevant TermAgent subsystem, and related TUI presentation paths. This directory now remains as deterministic visual QA and design-system fixtures.

## Stage A · Visual foundations

- [verified] Create isolated experimental UI workspace under `experimental/ui-v2`.
- [verified] Create this implementation TODO from the research plan.
- [verified] Define semantic design tokens for surfaces, text, roles, status, diff, Markdown, code, selection, and syntax.
- [verified] Implement ANSI/VT color capability handling for plain, ANSI-16, ANSI-256, and truecolor output.
- [verified] Add width-safe ANSI measurement, clipping, padding, and line helpers.
- [verified] Add reusable terminal layout primitives for panels, rules, selected rows, and key hints.
- [verified] Design and implement the TermAgent-owned multiline ANSI 3D/shadow wordmark with narrow-terminal fallback.
- [verified] Replace experimental rainbow-gradient/mascot treatment with the TermAgent-designed sober dark semantic palette.
- [verified] Add semantic activity/status rendering primitives with restrained spinner states.
- [verified] Add prompt/footer rendering primitives that consume semantic theme tokens.
- [verified] Wire the new primitives into the experimental TerminalUI frame renderer.
- [verified] Add experimental PTY snapshots for the foundation states and validate them through a real pseudo-terminal harness.

## Stage B · Response presentation

- [verified] Add Markdown block/inline parsing and semantic ANSI rendering.
- [verified] Render headings with hierarchy.
- [verified] Render unordered/ordered/nested lists.
- [verified] Render blockquotes and horizontal rules.
- [verified] Render inline code and links.
- [verified] Add dedicated code-block frames.
- [verified] Add language labels and plaintext fallback.
- [verified] Add lightweight syntax-highlighting strategy compatible with Termux/ARMv7 constraints (no native dependency).
- [verified] Add width-safe code-block handling.
- [verified] Add dedicated table rendering.
- [verified] Add table width calculation, alignment, and narrow-terminal vertical fallback.
- [verified] Add focused regression tests for Markdown/code/table formatting.

## Stage C · Conversation hierarchy

- [verified] Create semantic user-turn rendering.
- [verified] Create semantic assistant-response rendering.
- [verified] Create tool activity/start/running/completed rendering.
- [verified] Create reasoning summary and inspector presentation.
- [verified] Create compact diff summary presentation.
- [verified] Create error/warning/system message rows.
- [verified] Preserve existing inspector state and interaction semantics.

## Stage D · Interaction surfaces

- [verified] Redesign the picker while preserving the global selection index.
- [verified] Redesign the command palette using the picker foundation.
- [verified] Redesign permission dialogs with a reusable semantic modal frame.
- [verified] Redesign question dialogs with a reusable semantic modal frame.
- [verified] Refresh provider/plugin modal presentation and preserve selected-row backgrounds.
- [verified] Refresh reasoning/tool/diff inspector presentation with shared modal framing.
- [verified] Add focused interaction snapshots at 60x20 and 80x24, plus 40-column stress scenes.

## Stage E · Motion and micro-interactions

- [verified] Add reusable spinner frames.
- [verified] Add active-work shimmer/glimmer.
- [verified] Add elapsed timer after a short active-work delay.
- [verified] Add completion transition.
- [verified] Add startup loading transition.
- [verified] Add contextual local tips and shortcut hints.
- [verified] Add goodbye/resume screen using the real session ID.
- [verified] Ensure animation timers never keep the process alive after exit; live activity interval is cleared on terminal leave/end-agent-turn.

## Stage F · Visual QA and compatibility

- [verified] Build a deterministic PTY screenshot/frame harness using a deliberately wider recording PTY to avoid edge-wrap corruption from ANSI sequences.
- [verified] Review 60x20 layouts through 60-column PTY snapshots.
- [verified] Review 80x24 layouts through 80-column PTY snapshots.
- [verified] Stress narrower mobile widths at 40 columns and banner widths down to 32 columns.
- [verified] Exercise active streaming presentation across deterministic width changes (resize fixture).
- [verified] Verify picker navigation beyond the visible viewport.
- [verified] Verify mouse/touch does not interrupt active turns using the existing production interaction/state tests.
- [verified] Verify modal open/close presentation through centered frame snapshots.
- [verified] Stress Markdown, code, table, and diff widths through 40/60/80-column scenes and renderer tests.
- [verified] Verify ANSI capability fallbacks through plain/ANSI-16/ANSI-256/truecolor renderer tests.
- [verified] Measure long-response rendering performance with a 900-line mixed-Markdown fixture.
- [verified] Verify startup, active, completion, and exit visual consistency.
- [verified] Compare experimental screens against the approved TermAgent design-system reference. **Checkpoint: ANSI Shadow wordmark, forest semantic palette, and compact/full header behavior were visually inspected at production 80x24 plus narrow preview widths.**

## Merge gate · TermAgent 1.18.0

- [verified] Experimental UI approved visually.
- [verified] Production behavior and state flow preserved by the regression suite.
- [blocked] Historical 325/325 full-suite claim is no longer a current verification gate; see the current repository test status in `PROGRESS.md`.
- [verified] Experimental PTY tests green at 60x20 and 80x24.
- [verified] No frame overflows terminal width.
- [verified] No active-turn interruption regressions in the merged interaction tests.
- [verified] Markdown is semantic rather than raw source punctuation.
- [verified] Code blocks are visually distinct and readable.
- [verified] Tables remain readable on narrow terminals.
- [verified] Theme changes apply consistently across the UI.
- [verified] Animations degrade safely and stop on exit.
- [verified] Resume command uses the real session ID: `termagent --resume <session_id>`.
- [verified] No new dependency was added for the UI merge.
- [verified] Production UI is now the source of truth; obsolete experimental CLI duplicates were removed.

## Working rule

Do not silently move to the next stage. Finish a coherent stage, test it, inspect the visual output, and only then continue.
