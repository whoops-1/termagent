# TermAgent 0.9 Design

## Source-backed goals

TermAgent 0.9 adopts two proven interaction patterns from TermAgent's command system and session model:

- Markdown commands accept `$ARGUMENTS` and positional `$1`, `$2`, etc.
- Commands can inject shell output with `!` backtick expressions and attach file content with `@path` references.
- Sessions can be continued and forked, while TermAgent adds explicit checkpoints so long autonomous work can be resumed to a known conversation boundary.

The implementation stays dependency-free and uses Node.js built-ins so the ARMv7 Termux target is not exposed to another native dependency.

## Command interpolation

Command templates are rendered immediately before the agent call. Arguments are substituted first. Shell expressions are then executed from the project root with bounded output. File references are resolved relative to the project root and included as bounded fenced content. Paths outside the project are not read.

This keeps command definitions declarative while reusing the existing provider, agent, permissions and context pipeline.

## Checkpoints

A checkpoint is an append-only session event containing a stable checkpoint ID, timestamp, message count and execution metadata. Restoring a checkpoint does not rewrite or truncate the underlying JSONL session. It simply reconstructs the in-memory message list up to the checkpoint boundary.

Commands:

- `/checkpoint` creates a manual checkpoint.
- `/checkpoints` lists checkpoints for the active session.
- `/restore <id>` restores the conversation state to that checkpoint.
- `/resume <session>` continues the full session.

Autonomous runs automatically create an `auto-start` checkpoint before the first model call.

## Why no database

The event log remains JSONL. It is append-only, inspectable and portable, and avoids SQLite/native addons that would complicate ARMv7 Android support.
