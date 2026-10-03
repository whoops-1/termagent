# TermAgent 0.8 Design

## Custom agents
TermAgent 0.8 loads Markdown agent definitions from project and global `.termagent` locations and also accepts the legacy `.termagent/agents` locations used by older projects. Frontmatter carries description, mode, model, permission and step limits. The Markdown body becomes the agent prompt. Built-in modes remain available and custom agents are selected with `/agent <name>`.

The implementation intentionally reuses the existing Agent loop, provider abstraction, permission gate and tool registry. A custom agent does not introduce a second execution engine.

## Custom commands
Markdown command files are loaded from `.termagent/commands` and compatible TermAgent command directories. `$ARGUMENTS` and positional `$1`, `$2`, etc. are expanded before execution. Commands can select an agent and therefore inherit that agent's prompt and permissions. This mirrors the useful TermAgent command model without adding a template framework dependency.

## Durable workflow state
Task state remains in compact JSON snapshots for fast status reads. An append-only JSONL event stream is now kept beside each task. Events record state changes, starts, completions and failures. This gives recovery/debugging a chronological history without requiring SQLite.

## Recovery
Startup recovery marks queued/running tasks whose worker PID no longer exists as failed. The event stream remains available through `/task-log <id>`. Future versions can replay checkpoints rather than merely detecting dead workers.

## ARMv7 constraints
No native modules, Bun, a heavyweight terminal UI framework, SQLite addon or architecture-specific binary was introduced. All new functionality uses Node.js standard-library filesystem and process APIs.
