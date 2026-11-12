# Source checkpoint manifest — 2026-11-01

This archive contains the integrated TermAgent 1.18.0 source through **Phase 14E — Security, pairing, and remote access**, including the previously completed Phase 14E.1 permission-resolver integration.

- Package: `@whoops-1/termagent`
- Package version: `1.18.0`
- Node engine: `>=22`
- Source baseline: supplied Phase 14D Hermes research checkpoint, with the 14E.1 resolver integration and Phase 14E security/pairing implementation applied.
- `src/`, compiled `dist/`, `tests/`, `docs/`, `web/app/`, and `web/prototype/` are included.
- Phase 14E adds the pairing/authentication store, TLS and reverse-proxy modes, request provenance protections, per-device scopes, expiry/revocation, API data minimization, regression tests, upstream adaptation research, and operational documentation.
- Phase 14E.1 connects the server-owned permission gate to the canonical durable interaction resolver so browser decisions settle the original tool wait.
- The supplied Phase 14D mobile Brave Fetch binding fix remains included.
- No `.git` history or `node_modules` is included. Inspect the target working tree before replacing files; never overwrite newer user work with this archive.
- The project-selected Option A single-daemon topology remains a later Phase 14F implementation. This archive does not claim daemon owner fencing, multi-client terminal convergence, or cloud workspace execution.

## Verification snapshot

- Production TypeScript build: PASS.
- Focused Phase 14A–14E.1 and HTTP-server regressions: 43/43 PASS.
- Browser JavaScript syntax check: PASS.
- Release artifact verification: PASS.
- `npm pack --dry-run`: PASS.
- The aggregate `npm test` run is not green: the known `/auto` CLI assertion reproduces the pristine-checkpoint failure, and the full runner exceeded 480 seconds after more than 269 tests had started. No full-suite pass is claimed.
- Physical Android/Termux/Brave and production-network deployment validation remain open.

This is a full source checkpoint for continued development, not an npm publication or a claim that the complete Phase 14 rollout gate is closed. Detailed boundaries and evidence are in `PROGRESS.md` and `docs/phases/PHASE14E-SECURITY-PAIRING-REMOTE-ACCESS.md`.
