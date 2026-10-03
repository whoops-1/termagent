# TermAgent UI/UX Research & Freeze Plan

**Date:** 2026-10-03  
**Scope:** Terminal interaction, layout, presentation, and responsive behavior  
**Status:** 13N-I is implemented and frozen; later UI changes require a deliberate regression pass.

## 1. Goal

TermAgent's terminal interface should feel like one coherent coding environment rather than a collection of separate panels. Every visible surface must communicate its purpose, stay usable on narrow Termux screens, and remain connected to semantic runtime state.

The guiding rule is simple: extend the existing component when the capability already has a suitable owner. Presentation code should project runtime state, not create a second source of truth.

## 2. Core design system

The UI is organized around a small set of shared layers:

```text
semantic runtime state
        ↓
Theme + semantic tokens
        ↓
shared geometry/layout
        ↓
surface renderers
        ↓
keyboard / mouse / touch hit targets
```

The main reusable surfaces are:

- `src/design-system/theme.ts` — semantic colors, built-in themes, persistence, custom theme validation
- `src/design-system/banner.ts` / `banner-font.ts` — responsive identity banner
- `src/design-system/effects.ts` / `motion.ts` — bounded ambient motion
- `src/design-system/markdown.ts` — semantic Markdown and table layout
- `src/design-system/transcript.ts` / `transcript-cache.ts` — transcript projection and render caching
- `src/design-system/composer.ts` / `footer.ts` — prompt/status surface
- `src/design-system/queue.ts` — queued-prompt presentation
- `src/design-system/exploration-hud.ts` — exploration progress projection
- `src/design-system/picker.ts` / `src/cli/tui/select.ts` — structured selection
- `src/design-system/geometry.ts` / `layout.ts` — shared width/height policy
- `src/design-system/hit-targets.ts` — semantic interaction regions

## 3. Transcript hierarchy

User messages are distinct from the composer and from assistant output. Normal transcript rendering does not need repeated speaker badges. Identity is communicated through spacing, borders, semantic surfaces, and metadata.

Assistant content is rendered directly. Reasoning, tool activity, diffs, questions, and permissions each have a recognizable semantic row or bounded surface. Metadata stays secondary to the content.

Tool output that is large or noisy should be summarized or retained as a bounded preview rather than consuming the entire visible transcript.

## 4. Composer contract

The composer is a semantic component, not a painted rectangle. Its density adapts to terminal width:

- wide terminals can show status, provider/model, context usage, queue depth, tool activity, mode, and hints;
- medium terminals collapse secondary metadata;
- narrow terminals keep only the essential state and input affordances.

The input remains usable while the agent is working. The runtime owns turn execution and queue state; the editor owns only the current draft.

The status vocabulary includes ready, working, queued, question, permission, compaction, and error states. The explicit interrupt action is separate from ordinary interaction, so clicking or touching the composer cannot cancel a running turn.

## 5. Prompt queue

Queued prompts are durable runtime state. A queue item has its own lifecycle and must never be inferred from painted UI:

```text
draft → queued → executing → completed
                   ↓
              cancelled / failed
```

The terminal projects this state and provides edit, cancel, and reorder controls without taking ownership of the queue itself.

Running prompts are never presented as editable queue items. Reordering affects only queued entries and cannot move an executing turn.

## 6. Markdown tables

Markdown tables are represented semantically before terminal layout:

```text
Markdown
   ↓
Table model
   ↓
column measurement
   ↓
responsive layout
   ↓
terminal rows
```

The renderer handles escaped pipes, empty cells, Unicode width, alignment, long content, narrow terminals, and no-color output. Normal widths use a grid; constrained widths switch to a compact stacked/card representation rather than forcing horizontal overflow.

Inline/code formatting inside a cell is retained where it can be represented without corrupting column measurement.

## 7. Exploration HUD

The HUD is a projection of the existing `ExplorationState` and `ExplorationTelemetry` models. It never maintains a second exploration database.

Supported states are:

```text
READING
EXPLORING
SEARCHING
VERIFYING
COMPLETE
WAITING
```

The HUD surfaces the current file or search, coverage, uncovered ranges, useful discovery counts, recent discovery, and verification evidence. At narrow widths it collapses to the minimum information needed to explain what the agent is doing.

## 8. Theme system

Themes are semantic token sets. A theme can control:

- transcript and composer surfaces
- status colors
- Markdown and syntax colors
- diffs
- selection/focus
- queue state
- exploration state
- banner palette
- motion intensity

Built-in, user, and project themes use the same validation and token schema. The picker supports fuzzy search, live preview, Enter-to-commit, Esc-to-rollback, keyboard navigation, and touch/mouse selection. Theme preview must never mutate durable configuration until the user confirms it.

## 9. Banner and ambient motion

The banner has wide, medium, and compact forms and is allowed to use bounded ambient motion only in its own region.

Effects are deterministic, low-frequency, and row-limited. Motion is disabled entirely when configured off or when plain/no-color output is requested. Narrow terminals automatically reduce effect complexity, and heavy streaming suppresses unnecessary redraws.

The transcript itself must remain static unless its semantic content changes.

## 10. Shared interaction geometry

All bounded surfaces use the shared geometry helpers rather than local padding arithmetic. Width, height, wrapping, remaining-width, and hit-target coordinates are calculated from the same policy.

This is especially important for mobile terminals where one extra column can turn a usable control into an accidental horizontal overflow.

## 11. Accessibility and fallback behavior

The UI must remain understandable when color is unavailable. Semantic meaning cannot depend exclusively on hue.

Selection uses more than a background color. Errors include explicit text. Progress states have textual labels. Borders are optional cues, not the only way to distinguish surfaces.

Plain terminal output keeps the same semantic information without requiring ANSI support.

## 12. Regression contract

Any UI change must preserve:

- exact frame width at tested terminal sizes;
- queue/runtime ownership separation;
- explicit interrupt semantics;
- picker global selection and scrolling;
- responsive composer density;
- Markdown table correctness;
- exploration coverage truth;
- Theme → tokens → renderer flow;
- semantic hit-target safety;
- transcript cache invalidation rules.

The frozen responsive matrix includes representative 40, 48, 56, 60, 64, 80, 120, and 160 column layouts.

## 13. Current implementation status

13N-I completed the semantic UI/performance work and the final visual-system pass. The current tree includes the responsive composer, durable queue projection, semantic Markdown tables, theme picker, banner/effect system, exploration HUD, user-message surface, and busy-state interaction protection.

The focused UI/regression gate should remain deterministic. The repository-wide aggregate test command is tracked separately because a long-lived provider/process test can prevent the runner from terminating.
