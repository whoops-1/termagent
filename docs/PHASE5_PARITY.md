# Phase 5 Parity Review

## Purpose

Phase 5 is the feature-by-feature parity pass for TermAgent. The implementation process is implementation-first: inspect current design behavior, identify the state model and reusable algorithm, adapt it to TermAgent's existing primitives, add regression coverage, update documentation, and record platform validation.

## Implemented parity areas

| Area | TermAgent implementation | Verification | ARMv7 status |
| --- | --- | --- | --- |
| Session/workflow | Session picker, resume, fork, checkpoints, undo/redo, compact, export, history | CLI/unit/integration tests | Source/build only |
| Model selection | Configured-model picker, runtime switching, variants, reasoning effort, request extras | Provider + input tests | Source/build only |
| Agent selection | Interactive custom-agent picker, per-agent model target, bounded subagents | Agent/routing tests | Source/build only |
| Routing | Stable per-turn simple/strong routing, explicit status reason | Phase 5 routing tests | Source/build only |
| Input | History search, editor, Vim, queue/stash, configurable shortcuts, exact command ranking | Input/UI tests | Source/build only |
| Tools | Diff preview, tool details, interactive questions, permission rules, task inspection/logs, safe parallel reads | Tool/UI/API tests | Source/build only |
| Context | Repo map, structural retrieval, context inspection, bounded compaction and tool-output summaries | Context/agent/API tests | Source/build only |
| Extensibility | Commands, skills, MCP, plugins, client SDK | Existing extension/API suites | Source/build only |
| API/headless | Session catalog, context, abort alias, questions, SSE status/question events | API parity integration test | Source/build only |
| Worker safety | Process identity checks, worker tokens, fast-exit worker race protection | Runtime/task tests | Source/build only |
The implementation review confirmed several behavior patterns worth retaining:

- command and selection surfaces use a single logical selection model; TermAgent keeps its renderer-independent `PromptEditor` and `SelectModel`;
- session actions are stateful operations, so the CLI and HTTP layer call the same session/runtime primitives;
- model variants are request metadata rather than separate providers;
- smart routing makes one decision for a complete turn and exposes its reason;
- interactive questions own input exclusively until an answer is resolved;
- permission policies can override the global approval mode;
- independent read-only tools may run concurrently, while their results are committed in model order;
- large tool output is bounded before becoming permanent model context while the UI can retain the richer live result;
- task cancellation checks stored process identity before signalling a PID.

Heavy runtime-specific UI stacks, native databases, and architecture-specific dependencies remain outside the implementation boundary.

## Important fixes found during Phase 5

### Ignored snapshot paths

Snapshot capture now resolves ignore rules against an explicit candidate set and stages only the allowed paths. Regression coverage includes ignored `dist/` and `.termagent/` directories.

### Exact command matching

Exact command triggers now rank ahead of longer prefix matches. This prevents `/checkpoint` from being selected as `/checkpoints`.

### Fast background workers

The worker now attaches process listeners before waiting for identity bookkeeping and checks `exitCode`/`signalCode` after listener registration. A fast command can therefore not disappear between spawn and listener setup while leaving a durable task stuck in `running`.

## Verification standard

- `npm run build`
- `npm test`
- focused Phase 5 tests
- compiled CLI and API smoke checks where practical
- clean archive rebuild/test
- source hygiene scan
- package dry-run
- physical ARMv7/Termux verification when target hardware is available

## Current platform note

This environment can validate Node.js behavior and compile-time ARM-safe design choices, but it does not provide a physical ARMv7 Android/Termux device. ARMv7-specific runtime performance, terminal behavior, and resource usage remain a device-validation item for the later hardening phase.

## Phase 5 status

The parity implementation slice is complete for the documented areas above and is regression-tested. The milestone is ready for final artifact validation; physical ARMv7 validation remains explicitly pending rather than being inferred from x64 execution.
