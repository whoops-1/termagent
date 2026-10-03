# TermAgent phase verification standard

Every feature phase follows the same verification order.
Read the relevant TermAgents implementation and current behavior before changing TermAgent. Adapt the useful architecture instead of inventing a parallel design.

## Adversarial tests

Each phase needs direct regression tests for normal behavior plus failure cases, state corruption, concurrency (including separate processes when relevant), cancellation/interruption, input boundaries, persistence/restart behavior, crash/recovery behavior, and data-loss risks appropriate to the feature.

## Stress and model checks

Stateful features must be exercised with repeated transitions or a small model-based fuzz run where practical. A passing happy path is not enough. The state model should survive repeated randomized transitions, and known failure boundaries should have explicit regressions.

## Resource and platform checks

Keep Termux/ARMv7 constraints in mind. Avoid unnecessary native dependencies, unbounded work, or duplicated large-data processing.

## Final gate

Before a phase is declared complete:

1. Rebuild TypeScript from source.
2. Run targeted regression tests.
3. Run the entire repository test suite.
4. Run an extracted-archive or CLI/API smoke check when the phase affects those surfaces.
5. Review the diff and record discovered bugs and fixes in `PROGRESS.md`.

A phase is not considered complete merely because the original tests still pass.
