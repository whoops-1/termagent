# Phase 13J Report

## Scope

Phase 13J aligned TermAgent's Todo, Question, Skill, and workflow/verification state around one consistent lifecycle model while preserving the existing session-event, security, registry, and mobile/Termux architecture.


Research inputs:

- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`

Observed design patterns used by this phase:

- Todo state is session-owned and structured rather than relying on rendered tool text.
- Question requests use stable IDs and structured prompts/options/answers, with explicit replied/rejected events.
- Skill loading is explicit and on-demand; the base context contains descriptors while `SKILL.md` content is loaded by the native `skill` tool.
- Skill loading returns bounded instructions plus a sampled resource list and keeps the skill's base directory available for relative references.
- Workflow/todo state is separate from normal tool-result prose.



Research inputs:

- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`

Observed design patterns used by this phase:

- Todo/progress state is treated as structured execution state, not merely display text.
- Verification guidance is tied to deterministic workflow state and completion checks.
- User questions support explicit structured choices, multi-select, and custom responses.
- Skill discovery is descriptor-first and full content is loaded only when needed.
- Compaction must preserve machine-relevant state separately from ordinary transcript prose.

## Implemented behavior

### Todo

- Added structured old/new state in tool metadata.
- Session Todo persistence now retains previous state for transitions.
- Completed-only Todo lists collapse from the live model/context surface while remaining durable in session history.
- Active items remain machine-readable for context reconstruction and workflow gates.
- Priority is retained in state and fingerprints.
- When every Todo is completed, the autonomous workflow receives a deterministic verification nudge and enters the verifying phase rather than treating Todo completion as final completion.

### Question

- Added stable `que_...` request IDs.
- Added normalized headers, options, multi-select support, and custom-answer support.
- Added explicit terminal states: `replied`, `rejected`, and `cancelled`.
- Persisted question requested/terminal events in `SessionStore`.
- Replayed completed requests without invoking the interactive callback again.
- Forwarded `AbortSignal` into question interaction so cancellation is explicit.
- Preserved the existing CLI/server callback surfaces rather than introducing a parallel question service.

### Skill

- Added native `skill` tool semantics while retaining `use_skill` as a compatibility alias.
- Base context receives compact skill descriptors without full bodies.
- Full `SKILL.md` content is loaded only after explicit skill invocation.
- Loaded content is bounded before provider/context use.
- Resource files are sampled and referenced with the skill base directory.
- Existing skill digest, security, lint, registry, revocation, and provenance checks remain authoritative.
- Loaded-skill identity and digest are persisted into machine context and session events for replay after compaction.
- Existing automatic discovery remains descriptor-only and can coexist with explicit loading.

### Workflow and verification

- Workflow phase state is persisted separately from ordinary tool output.
- Structured workflow metadata is emitted alongside rendered output.
- Compaction/checkpoint reconstruction retains Todo, question, loaded-skill, and workflow machine state.
- Deterministic Todo completion nudges the autonomous flow into verification; a successful verification can then transition the workflow to completion.
- Completed workflow state does not get resurrected from stale Todo prose on unrelated follow-up turns.

## Compatibility notes

- `use_skill` remains available as a compatibility alias; the native model-facing contract is `skill`.
- Existing TermAgent session-event storage remains the source of truth rather than adding a separate SQL table solely to mirror the implementation internals.
- Existing Phase 9 bounded skill-output behavior remains enforced. Wrapper/resource text is budgeted together with the skill body.
- Question UI/API integration continues through TermAgent's existing CLI/server surfaces, with structured request state underneath.
- Workflow/verification tools remain TermAgent-specific where resulting behavior is not a one-to-one API contract.

## Verification

Build:

- `npm run build` -> PASS
- Generated JavaScript `node --check` sweep -> PASS

Focused Phase 13J:

- `tests/phase13j-tool-state.test.mjs` -> **9/9 PASS**

Sequential Phase 13A-13J:

- **106/106 PASS**

Broader compatibility sweep:

- Phase 3 execution + Agent + context-performance + skill catalog/discovery/registry + Phase 13J -> **108/108 PASS**

Archive integrity:

- `unzip -t` -> PASS

The repository's historical aggregate `npm test` runner still contains the previously documented stall/timeout behavior. This phase does not claim that aggregate command passes.

## Files changed for 13J

- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `the runtime process layer`
- `docs/phase13/tool-inventory.json`
- `TODO.md`
- `tests/phase13j-tool-state.test.mjs`

## Final regression note

During the final regression pass, an existing Phase 13E background-shell cleanup race was reproduced: terminal task status could become visible before the final parent-notification event was committed. `TaskManager.finish()` was tightened so parent notification is settled before the terminal state is published. Phase 13E then passed three consecutive runs, and the final Phase 13A-13J and broader gates remained green.

## Status

Phase 13J is complete. The next checklist section is Phase 13K, covering typed tool schemas, permissions/resource extraction, registry architecture, provenance, provider-hosted tool separation, and bounded tool-definition selection.
