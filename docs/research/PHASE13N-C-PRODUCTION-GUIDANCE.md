# Phase 13N-C — Production Exploration Guidance

## Scope

13N-C wires the existing adaptive exploration guidance module into the production `Agent.run()` path. This phase does not replace runtime loop safety or the pre-execution read gate. Guidance remains model-facing advice; enforcement remains in the existing runtime mechanisms.
The Explore configuration is a specialized, read-only role with explicit routing guidance and qualitative thoroughness levels. The implementation connects that guidance to TermAgent's existing `ExplorationState`, telemetry, `ToolRegistry`, and provider request flow without creating a second exploration runtime.

The existing design research remains consistent with the same architectural principle: semantic runtime state should be shared by clients, while presentation and routing guidance stay above the authoritative runtime.

## Implementation

the relevant TermAgent subsystem now accepts a bounded evidence-state projection containing discovered files, covered read ranges, search observations, symbols, settled verification facts, semantic progress revision, no-progress rounds, and the latest evidence note.

`Agent.run()` imports and invokes the helper for Explore requests and subsequent rounds once semantic exploration tracking is active. The rendered guidance is truncated before insertion into the provider request so it cannot grow without bound. The same bounded notice is rebuilt after context compaction when the request is reconstructed.

The guidance explicitly covers:

- prompt-aware routing between `repo_map`, `glob`, `grep`, and `read_file`;
- quick/medium/very-thorough exploration intent;
- current evidence state;
- continuation from uncovered ranges;
- batching independent read/search calls in one provider response;
- changing strategy after no-progress;
- optional bounded specialist-subagent use; and
- the prohibition against a ceremonial fixed tool sequence.

## Safety boundary

Guidance does not mutate `ExplorationState`, telemetry, session truth, or tool permissions. It cannot make a redundant read valid. The pre-execution read gate and loop guards remain authoritative. Rehydration remains evidence restoration rather than new semantic progress.

## Verification

- `npm run build`: PASS
- `tests/agent/phase13n-c-guidance.test.mjs`: 3/3 PASS
- package dry-run: expected to remain clean; full archive verification is performed with the phase ZIP
- repository-wide aggregate test runner: not a green gate because of the pre-existing long-lived test/runner issue documented in the 13M hardening report
- ARMv7/Termux hardware: not available on the verification host

## Result

13N-C is `[verified]` at the focused implementation/regression level. The production Agent now actually consumes the adaptive guidance module that previously existed only as an unreferenced helper.
