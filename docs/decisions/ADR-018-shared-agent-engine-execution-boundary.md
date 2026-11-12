# ADR-018: Preserve the TermAgent engine and isolate workspace execution

**Status:** Proposed, awaiting project-owner approval  
**Date:** 2026-11-01

## Context

TermAgent already owns provider routing, agent orchestration, ToolRegistry, skills/plugins/MCP, context, session persistence, task management, permission handling and canonical event/command contracts. Phase 18 requires the same engine to serve local Termux and cloud workspaces. Current shell and task-worker processes inherit broad `process.env`, and shell execution is not isolated by the file-tool workspace path guard.

## Decision proposal

Keep the Agent loop and agent-facing tool contracts shared. Introduce a narrow execution-environment boundary for filesystem, shell, process, Git and PTY operations. Implement:

- Local adapter: current Node filesystem/process behavior, with least-privilege environment and scope enforcement.
- Cloud adapter: authenticated RPC to an isolated workspace runtime/sandbox provider.
- Control plane: provider credentials, agent loop, permission policy, session/event authority and durable project/session metadata.
- Workspace plane: source tree, package installs, shells, processes, tests and Git working tree. It must not receive model-provider credentials or unrelated service secrets.

Keep TermAgent-specific types at the boundary. Do not leak Daytona/E2B/Coder SDK types into Agent or ToolRegistry.

## Consequences

- Local CLI remains a first-class supported mode.
- Cloud execution can change without changing provider or agent orchestration.
- Existing built-in tools need injected execution adapters instead of direct process/filesystem access in cloud mode.
- Plugin/MCP trust boundaries must be reviewed because extension code can also execute in the control plane.
- Workspace lifecycle, resource limits, credentials and network egress become explicit contracts.

## Alternatives rejected

- A second agent engine for cloud: duplicates the most valuable existing implementation.
- Running arbitrary shell directly inside a public control-plane service: exposes environment secrets and platform filesystem.
- Immediately splitting all services into microservices: unnecessary for the initial private single-user deployment.
