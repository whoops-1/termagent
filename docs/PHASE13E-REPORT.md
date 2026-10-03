# Phase 13E — Shell/Git execution: safe, resumable, structured

## Status

**Implemented and verified.** Phase 13E establishes a durable shell execution path for `bash` and `git`, integrated with TermAgent’s existing `TaskManager`. The design keeps command execution resumable and observable, with bounded output, explicit lifecycle states, process-tree cancellation, timeout handling, background promotion, and command-specific permission checks.

## TermAgent changes

### Durable shell runner

Added the relevant TermAgent subsystem. It provides:

- stable task identity through `TaskManager`
- durable output-file retention
- bounded head/tail previews
- timeout handling
- automatic foreground-to-background promotion
- explicit background execution
- AbortSignal cancellation
- process-group termination on POSIX, with direct-child fallback
- output-size watchdog
- interactive-command and prompt-like-output detection
- distinct completion, non-zero, timeout, cancellation, signal, output-limit, and spawn-error states
- early process-listener attachment to avoid fast-command exit races
- terminal event persistence before exposing terminal task state

### TaskManager

the relevant TermAgent subsystem now records shell timeout state and durable shell output metadata. Cancellation no longer rewrites a foreground task into a background task.

### Bash tool

the relevant TermAgent subsystem now uses the durable runner. Long foreground commands can be promoted after the configured blocking budget (`TERMAGENT_SHELL_AUTO_BACKGROUND_MS`), while `run_in_background=true` returns a durable task ID immediately.

### Git safety

Added the relevant TermAgent subsystem for argument-aware classification of read-only, mutating, sensitive, and destructive Git commands. Forced pushes, hard resets, destructive clean/branch operations, and other destructive patterns are rejected explicitly. Arguments are shell-quoted so Git inputs cannot become shell syntax.

## Verification

- TypeScript build: **PASS**
- Phase 13E tests: **13/13 PASS**
- Phase 3 execution suite: **31/31 PASS**
- Combined Phase 13A–13E + agent/context/permissions/tools/context-performance suite: **131/131 PASS**

## Important regression fixed during 13E

A fast background shell could make its terminal task status visible before its final event-log append completed. Consumers polling `TaskManager` could observe `exited`, clean the task directory, and race the pending event writer. The runner now persists the terminal event before exposing the terminal status.

## Deliberate boundary

The durable output file currently coalesces stdout and stderr into one command-output stream. Phase 13F now provides the established style durable `ToolOutputStore` and bounded provider projection for tool results; separate stdout/stderr channel files remain a future refinement.

Destructive Git operations currently fail closed instead of opening a richer argument-specific approval flow. The classifier is still argument-aware and is a safer boundary than the previous top-level denylist; richer approval semantics belong in Phase 13K.

## Files
- `tests/phase13e-shell-git.test.mjs`
- `docs/phase13/tool-inventory.json`
- `TODO.md`

## Verification limitation carried forward

The historical aggregate `npm test` command has previously stalled after hundreds of tests in this archive. The targeted Phase 13E and compatibility suites complete successfully; the aggregate-runner issue remains separately tracked and is not treated as a Phase 13E pass.
