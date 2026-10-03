# TermAgent 0.6 Design

## Autonomous coding

`/auto <task>` enables an explicit autonomous workflow. The agent is instructed to inspect first, plan, implement with existing tools, run `verify_project`, inspect failures, repair them, and repeat until completion or a hard blocker. This reuses the existing agent loop, tool registry, repository retrieval, skills, sessions, retry and compaction instead of creating a second agent implementation.

## Verification

`verify_project` detects safe project verification commands from common manifests and can also accept an explicit command. Output is bounded and timeout-protected.

## Durable background work

Background shell and agent jobs are stored as JSON records under `~/.termagent/tasks`. A detached Node worker executes each job and updates its record. Startup recovery checks running PIDs and marks vanished workers failed instead of leaving stale `running` records forever.

## Parallel agents

`parallel_agents` creates 2-4 independent background agent jobs. It is intentionally explicit because concurrent agents editing the same files can conflict. Results remain durable and are observed with `task_status`.

## ARMv7 constraints

The implementation uses Node built-ins and the existing TermAgent provider/tool/session layers. No PTY, SQLite, a heavyweight terminal UI framework, Bun, native addon, or architecture-specific runtime was introduced.
