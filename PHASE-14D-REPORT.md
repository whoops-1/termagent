# TermAgent 1.18.0 — Phase 14D Report

## Status

**Implemented and focused-verified.** Phase 14D adds a browser Web View over the existing Phase 14C API/client and Phase 14B event stream. The overall Phase 14 gate remains open for Phase 14E security/pairing and Phase 14F two-way mirror verification.

## Visual fidelity

The uploaded v4 prototype is the design contract. `web/prototype/` is retained byte-for-byte from the uploaded archive. Production `web/app/styles.css` begins with the exact v4 stylesheet, while the production HTML keeps its mobile-first layout and core control placement. The production JavaScript binds the visual shell to runtime state instead of using simulated transcript/session data. No additional frontend dependencies or animation library were introduced, in keeping with the v4 design notes.

## Runtime integration

- Static Web View routes serve the root page, stylesheet, browser application, and the already-compiled client/protocol modules.
- The server still enforces the configured bearer token for API and session data; only the presentation assets are public.
- The browser uses `TermAgentClient`, snapshot reconciliation, and the canonical durable SSE cursor. Live text/reasoning/activity is rendered as a transient projection, not treated as session truth.
- Live events are broadcast by the runtime-owned event bus. Pending transient output is bounded and adjacent same-run text/reasoning chunks are coalesced; persisted session events remain the recovery contract.
- `termagent --serve` prints the browser Web View URL.

## Features

Responsive session switch/new session, transcript and tool cards, reasoning/activity, task and diff inspection, plan/Todo progress, proof chips, permission/question resolution, context/model display, stop/abort, prompt queue submit/remove, compact/undo/redo, checkpoints, task output/cancel/continue, theme preference, focus mode, slash commands, Markdown tables/code/lists/links, and reconnect/replay status.

## Tests

- `npm run build`: PASS.
- `node --check web/app/app.js`: PASS.
- `tests/phase14d-webview.test.mjs`: **6/6 PASS**.
- Combined Phase 14B/14C/14D HTTP/SSE/client gate: **13/13 PASS** when run after the latest changes.
- Chromium smoke at 390×844, 768×900, 1440×960: no page errors; seeded transcript/tool/table content renders; composer submission and Options sheet toggling work; page-level horizontal overflow is absent at all three viewports.
- `npm pack --dry-run --json`: PASS for `@whoops-1/termagent@1.18.0`; production `web/app/{index.html,styles.css,app.js}` are included while the prototype and QA screenshots are excluded from the npm package.
- `node scripts/verify-dist.mjs`: PASS.

The browser smoke used a deterministic fake client fixture. It is not claimed as an end-to-end run against a live provider or a physical Termux/Android browser. The entire repository test suite has not been used as a green gate; historical unrelated legacy failures/non-termination are already documented in `PROGRESS.md`.

## Upstream research

See `docs/research/PHASE14D-WEB-VIEW.md`. The UI reuses TermAgent's existing typed client, API route schema, session snapshots, event bus, and durable sequence model. OpenCode's semantic message-part rendering and typed SDK boundary plus OpenClaude's richer prompt interaction model were studied; upstream frontend frameworks were not copied into TermAgent.

## Remaining gates

Phase 14E still owns authenticated pairing, origin/CSRF protections, revocation, and remote-access boundaries. Phase 14F still owns full simultaneous terminal/browser convergence, conflicting permission/question resolution, disconnect and process-restart recovery. Physical ARMv7/Termux browser validation remains unverified.
