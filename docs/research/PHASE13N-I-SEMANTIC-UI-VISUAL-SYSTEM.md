# Phase 13N-I — Semantic UI, Visual System, Motion and Exploration HUD

**Date:** 2026-10-03
**Scope:** Terminal UI completion pass before 13N-J

## Intent

This phase freezes the semantic UI as one presentation system rather than leaving a chain of theme/banner/animation TODOs. The visual language uses TermAgent-specific names, data shapes, limits, and rendering primitives.

## Implemented

- Structured picker rows remain the canonical completion surface, with semantic swatches and shared geometry.
- Themes are now a first-class catalog with grouped semantic tokens, banner metadata, motion metadata, and optional custom JSON theme files under user/project `.termagent/themes`. Invalid custom themes are ignored safely; built-ins cannot be overwritten.
- `/theme` uses live preview with explicit apply/revert behavior.
- Banner rendering now supports multiple TermAgent-native compositions and width-aware fallback. The existing default splash remains byte-compatible with the frozen Phase 12F visual contract.
- Banner effects are restricted to the banner band, deterministic, theme-aware, width-safe, and disabled cleanly. They run only while motion is requested.
- UI motion has three states: `full`, `reduced`, and `off`. Reduced mode removes decorative banner effects and animated spinner/pulse changes while keeping state text and completion indicators visible.
- Banner style/effect/theme/motion preferences persist through the existing configuration writer rather than a second preference store.
- The Exploring HUD is a read-only projection over `ExplorationStateSnapshot` and `ExplorationTelemetrySnapshot`. It reports the current file, coverage percentage, actual inspected ranges, remaining ranges, discovery text, verification evidence, and bounded counts.
- Disjoint coverage is never rendered as a false contiguous interval.
- TerminalUI uses the same semantic data path for picker, banner, effect, exploration HUD, queue, composer, and hit-target registration.
- Markdown tables are parsed into semantic cell/row models and laid out as grids, compact tables, or responsive cards; ANSI output is a terminal projection, not the parsing source.
- Prompt submission stays interactive during agent work. The runtime-owned `SessionPromptQueue` persists queued prompts as session events, supports editing/cancellation/reordering, distinguishes executing work from queued work, and recovers stale executing records after restart.
- The composer remains enabled while a turn is active and exposes state, context usage, provider/model, tools, queue count, and responsive hints without owning runtime state.
- Session-changing commands are blocked while a live turn owns the session, preventing an active turn from finalizing against a newly selected session.

## Originality / adaptation rule

User-facing identifiers use TermAgent-specific names. The design work focuses on semantic theme tokens, live theme selection, width-aware banner behavior, banner-scoped ambient motion, structured picker rows, and mobile-friendly fallbacks. Implementation details stay within the existing TermAgent Node/ANSI architecture.

## Exploring HUD contract

The HUD is derived, never authoritative:

```text
ExplorationState + ExplorationTelemetry
             ↓
     ExplorationHUDModel
             ↓
        Terminal view
```

This keeps the future Web View architecture honest: a browser can consume the same semantic exploration state without storing a second coverage database.

## Reconciliation and queue contract

The authoritative base for the final 13N-I pass is `TermAgent-1.18.0-Phase13N-I-Complete-Visual-System-HUD.zip`. The richer theme/banner/effect/HUD system from that archive was preserved. Only the missing table, queue, composer, live-input, and protocol projection work was merged from the earlier branch. No parallel browser state was introduced.

The queue admits follow-up work above the busy session runner while keeping durable session events and terminal/Web-safe semantic state authoritative. The executing prompt is never editable or reorderable. Numeric queue commands address queued prompts only, and startup/session recovery converts orphaned `executing` entries back to `queued`.

## Verification

- `npm run build` — PASS.
- Reconciled UI/UX gate — **129/129 PASS**.
- `tests/experimental/ui-markdown.test.mjs` now targets the current `dist` renderer instead of the obsolete preview renderer.
- Phase 12F visual contracts and deterministic snapshots — PASS.
- Mobile sanity snapshots at 60×24 and 40×20 — PASS.
- Aggregate repository runner remains non-green because the known provider-manager long-lived process does not terminate; no aggregate pass count is claimed.
- Physical ARMv7/Termux execution remains a later 13N-J rollout gate because the verification host is x86_64.

## Remaining boundary

The future Web renderer presentation contract remains intentionally unimplemented here. It begins in Phase 14 after the 13N gate; the Terminal UI does not maintain a parallel browser-specific state model.
