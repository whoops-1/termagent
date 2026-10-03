# Phase 13N-D — Post-edit verification and EvidenceLedger

Status: **VERIFIED at the focused implementation/regression level**
Date: 2026-10-01
Repository version: 1.18.0

## Scope

13N-D adapts the declarative post-edit verification idea into TermAgent's existing runtime. The implementation does not introduce a second shell runner, session store, or workflow engine. It reuses `TaskManager`, `startManagedShell()`, `verify_project`, `ToolCallLifecycle`, `ExecutionWorkflow`, `ExplorationState`, `SessionStore`, and `ContextMachineState`.

The implementation is intentionally opt-in. `postEditVerification.enabled` defaults to `false`; when enabled, a successful mutation made by an allowed mutation tool can trigger one verification command after the tool round settles.
The design uses a declarative verification hook pattern: observe successful mutation activity, dispatch a bounded verification action, and feed the settled result back into the agent loop. TermAgent keeps verification inside the existing task execution stack. The existing TaskManager and managed-shell path remain the execution authority.

The runtime also retains the established style principle that exact duplicate tool-loop protection and semantic no-progress detection are separate safety layers. Verification is evidence, not a substitute for those controls.

## Implementation

### Declarative post-edit verification

the relevant TermAgent subsystem adds `postEditVerification` with:

- `enabled`
- optional `command`
- `timeoutMs`
- `maxOutputBytes`
- mutation `tools` allowlist

Defaults are safe and explicit: disabled, with `write_file`, `edit_file`, and `apply_patch` as the recognized mutation tools when configured.

the relevant TermAgent subsystem normalizes bounds and invokes the existing `verify_project` implementation through a supplied `TaskManager`. Numeric configuration is sanitized for non-finite values.

### Verification result contract

the relevant TermAgent subsystem now produces explicit settled states:

- `passed`
- `failed`
- `timeout`
- `cancelled`
- `no_command`

Each result includes bounded model-visible output and durable task metadata. The task output file remains the out-of-band full-result artifact; metadata carries `taskId`, `outputPath`, `outputBytes`, and `outputTruncated`. Verification command text is not placed into semantic evidence fingerprints.

### Mutation trigger

`Agent.run()` now marks settled successful mutation calls when mutation metadata is actually present. `apply_patch` participates in the same mutation classification as `write_file` and `edit_file`. The automatic verifier runs once for the resulting mutation batch when the configured tool allowlist permits it.

A successful automatic result is associated with the semantic mutation fingerprint for the current run. A subsequent `verify_project` call for the same mutation batch is returned from that successful automatic result unless the request includes `force=true`. An explicit forced call still reaches the normal ToolRegistry execution path.

### Evidence propagation

Automatic verification is deliberately not represented as a synthetic provider tool lifecycle record. Instead it produces four explicit semantic/durable surfaces:

1. a `session.verification.completed` durable session event;
2. a bounded system notice in the current model context;
3. a settled verification observation in `ExplorationState`;
4. a derived `EvidenceLedger` verification entry plus workflow observation.

This preserves the distinction between provider-issued tool calls and runtime-owned verification work.

### EvidenceLedger

the relevant TermAgent subsystem derives a bounded snapshot containing:

- exploration files and covered ranges;
- search observations and result keys;
- symbols;
- verification results;
- mutation evidence;
- task state and output references;
- workflow state.

The ledger is derived state. `SessionStore` event history and `TaskManager` records remain authoritative and continue to own persistence/recovery. The ledger is embedded in `ContextMachineState` checkpoints so it survives context reconstruction.

The semantic fingerprint intentionally excludes lifecycle/task/output identities such as tool call IDs, task IDs, output paths, output sizes, and truncation flags. It keeps the actual semantic verification result, command fingerprint, mutation hashes, exploration evidence, and workflow state. This prevents bookkeeping churn from manufacturing semantic progress.

All collections are hard bounded: files 256, searches 96, symbols 512, verifications 32, mutations 32, tasks 64.

## Security and operational boundaries

Automatic verification is disabled by default because enabling it allows configured shell commands to execute after mutations. The existing configuration is therefore the consent boundary for this feature. Scoped worker restrictions in `verify_project` continue to prevent arbitrary explicit verification commands when a worker is constrained.

Verification output is bounded before it becomes model-visible. Full task output remains in the TaskManager output artifact referenced by path. The semantic ledger does not retain raw command text, which reduces the chance of sensitive literals entering semantic progress state.

## Test coverage

`tests/agent/phase13n-d-verification-ledger.test.mjs` covers:

1. passed, failed, timeout, and no-command verification states;
2. cancellation as a settled state;
3. automatic verification after a successful mutation;
4. same-batch automatic verification caching;
5. explicit `force=true` verification reruns;
6. `apply_patch` participation in automatic verification;
7. mutation allowlist enforcement;
8. automatic verification evidence in `ExplorationState`, session events, and checkpoints;
9. EvidenceLedger bounds and semantic fingerprint stability;
10. ContextMachineState ledger serialization;
11. durable verification event kind/category mapping;
12. bounded large verification output with an out-of-band task output path.

Results:

- `npm run build`: **PASS**
- dedicated 13N-D suite: **9/9 PASS**
- combined Phase 13M/P4/P6 + 13N-A/B/C/D suite: **38/38 PASS**

## Repository-level gate disposition

The repository-wide `npm test` runner remains a separate known blocker because the existing aggregate suite can fail on unrelated baseline tests and can remain alive in long-running process tests. The current 13N-D work does not claim that aggregate gate is green.

Physical ARMv7/Termux execution is also unavailable on the current x86_64 host. No ARMv7 execution claim is made here.

## Files changed
- `docs/CONFIGURATION.md`
- `tests/agent/phase13n-d-verification-ledger.test.mjs`
- `TODO.md`
- `PROGRESS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`

## Gate result

13N-D is **verified at the focused implementation/regression level**. The wider Phase 13N/13M rollout gate remains open for the separate repository-wide test and real-device requirements.
