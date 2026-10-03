# TermAgent 0.5 Design

## Goal
Add proven extensibility and operational diagnostics without native dependencies.

## Skills
Skills are local Markdown instruction bundles discovered from project `.termagent/skills`, `.claude/skills`, and global `~/.termagent/skills`. Matching skills are injected into the current turn only. The full skill catalog is not sent to the model. A `skill` tool can load a named skill explicitly.

## Diagnostics
`/doctor` checks Node version, platform/architecture, git, ripgrep, npm, shell, and TermAgent storage. It is intentionally dependency-free.

## Portability
No native module is introduced. Skills are text files and doctor uses Node child_process only.
