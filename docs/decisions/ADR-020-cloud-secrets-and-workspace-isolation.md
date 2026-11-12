# ADR-020: Separate control-plane secrets from untrusted workspace processes

**Status:** Proposed, awaiting project-owner approval  
**Date:** 2026-11-01

## Context

`src/tasks/shell-command.ts` inherits `process.env`; `src/tasks/manager.ts` starts workers with a spread of `process.env`; plugin hooks also inherit broad environment state. TermAgent's server process will need provider/API credentials and may later hold database, pairing and GitHub credentials. File-tool path validation does not constrain arbitrary shell processes.

## Decision proposal

Before cloud execution:

- create child-process environments from an explicit allowlist, never by copying all server variables;
- keep LLM and control-plane credentials in the agent service;
- broker Git credentials using narrowly scoped, short-lived credentials or a controlled Git proxy/helper;
- put shell, build, test, browser and project-controlled scripts inside an isolated workspace runtime;
- enforce filesystem, process, CPU, memory, disk, wall-clock, output and egress limits;
- treat plugins, hooks and MCP servers as executable code with an explicit trust policy and separate process/secret boundary;
- audit/redact credentials and private environment details in task output and logs.

## Consequences

- A cloud execution adapter and workspace sandbox are prerequisite infrastructure, not optional hardening.
- TermAgent can begin with a single-user scope without assuming that project code is trusted.
- The local CLI remains supported but should also default to least-privilege child environments.
