# TermAgent 0.7 Design

## Purpose

0.7 adopts the useful agent orchestration pattern visible in current TermAgent: a small set of primary modes with permission-scoped tool access, plus focused exploration/planning behavior. TermAgent's current source defines `build`, `plan`, `general`, and `explore`; `plan` is explicitly restricted through permissions while `explore` is read-only. TermAgent also supports custom agents with bounded tool-use steps.

TermAgent keeps the same architectural idea but expresses it through the existing zero-dependency Node tool registry instead of introducing a new runtime or native TUI.

## Modes

### build
Full development mode. Write and edit tools and shell tools are available subject to the existing permission gate.

### plan
Read-only analysis mode. The model receives only tools classified as `read`. This is enforced twice: the tool catalog sent to the model is filtered and execution checks the mode again.

### explore
A tighter read-only mode intended for fast repository discovery. It uses the same read-only filtering but a smaller round budget.

## Task tracking

The `todo` tool keeps a small in-process list for the current session. It supports set, add, update, and list operations. This follows the useful visibility pattern of TermAgent's todo tooling without introducing a database.

## CLI

- `/agent` shows the active mode.
- `/agent build|plan|explore` changes mode.
- `/build`, `/plan`, and `/explore` are shorthand switches.
- `/auto <task>` always uses build mode because autonomous implementation requires write and verification tools.

## Safety

Tool filtering is based on each tool's declared risk rather than a hard-coded list of filenames. This means future MCP/plugin tools inherit the same mode policy automatically when they declare their risk correctly.

## Portability

No new runtime dependency, native addon, runtime-specific component, a heavyweight terminal UI framework component, PTY implementation, or architecture-specific binary was added in 0.7.
