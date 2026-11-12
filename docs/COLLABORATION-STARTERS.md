# TermAgent Starter Collaboration Contract

**Status:** Active coordination contract
**Introduced:** 2026-11-12
**Audience:** the second maintainer building downstream starter projects ("starters") and any contributor landing work in TermAgent itself.

This document defines how starter work and TermAgent runtime work stay coordinated without merge conflicts, duplicated implementations, or silent contract drift. When this document disagrees with current source behavior, `ARCHITECTURE.md` and `REPO-STRUCTURE.md` take precedence (see the source-of-truth order in `REPO-STRUCTURE.md` §14).

## 1. Repository roles

```text
whoops-1/termagent            main dev repository (canonical; protected main)
Tauseef666-ctrl/termagent     contribution fork (branch-based pull requests)
starter repositories          downstream templates; never push into TermAgent
```

- Phase work, hardening, and feature changes land **only** through pull requests from the fork into `whoops-1/termagent` `main`. No direct pushes to `main` for phase work.
- Starter repositories are independent. They consume published TermAgent artifacts; they do not receive TermAgent source commits.

## 2. What starters consume (stable contract)

Starters may rely on exactly the following public surfaces:

| Surface | Contract | Notes |
| --- | --- | --- |
| npm package `@whoops-1/termagent` | Node ≥ 22 (`engines`), zero runtime dependencies | binary `termagent`; version-pinned by starters |
| Programmatic client | `@whoops-1/termagent/client` | typed client for sessions, prompts, events |
| Protocol schemas | `@whoops-1/termagent/protocol` | transport-neutral envelopes and event kinds |
| Web View app | `web/app/` (shipped inside the package) | browser projection of the runtime |
| Install website | `web/site/` (batch 1) | static, dependency-free; real install commands only |

Starters **must not**:

- import runtime internals that are not in the package `exports` map;
- vendor, patch, or fork `dist/` output;
- duplicate session, permission, provider, or task logic locally;
- hardcode model/provider credentials into starter templates.

Starters configure the runtime through `.termagent/config.json` and `TERMAGENT_*` environment variables only. Anything else is a runtime feature request and belongs in `TODO.md` via a pull request.

## 3. Current work division (batch 1, 2026-11-12)

The authoritative division lives in `TODO.md` under “2026-11-12 — Phase 14I batch-1 work division”:

- **14I-S1** child-agent provider credential resolution — owns `src/tasks/**`, the three subagent tools, `tests/tasks/`
- **14I-S2** session-state lock hardening — owns `src/session/**`, `tests/session/`
- **14I-S3** Windows port hardening batch 1 — owns `src/util/**`, `src/config/**`, `src/cli/**`, `src/server/daemon-owner.ts`
- **14I-S4** install website — owns `web/site/**`

One owner per file. Shared documents (`TODO.md`, `PROGRESS.md`, `ARCHITECTURE.md`, `REPO-STRUCTURE.md`) are updated only at batch integration, never by individual streams mid-flight. Starters that need a runtime change open a pull request against one of these streams' scope or wait for batch 2.

## 4. Status vocabulary

Use the roadmap's explicit statuses everywhere (issues, PR descriptions, starter changelogs):

```text
[ ]         planned or not started
[impl]      implementation present; verification incomplete
[test]      regression coverage exists; gate not closed
[verified]  implementation and recorded evidence support the claim
[blocked]   evidence contradicts the claim or a required environment is unavailable
```

Never mark a task complete from intention alone; link completion to code, tests, and a report.

## 5. Verification expectations

- Contributions run: `npm run build`, the focused test files they touched, and `npm pack --dry-run` before opening a PR.
- `node --test` aggregate runs are known to time out in this repository; serial or batched per-file runs are the accepted evidence. A timed-out aggregate run is **not** a pass and must not be reported as one.
- Quick type feedback without build side effects: `npx tsc -p tsconfig.json --noEmit --pretty false`.
- Tests import from `dist/*.js`, so a build must precede test runs.

## 6. Starter release alignment

- Pin exact TermAgent package versions in starter templates; do not use floating ranges.
- When TermAgent publishes a new version, starters re-test their templates against it before bumping, and record the result in their own changelog.
- Install commands shown in starter docs must match `web/site/` and `package.json` exactly (`npm install -g @whoops-1/termagent`; Node ≥ 22). Divergent instructions are treated as documentation bugs.
- Breaking protocol or client changes are announced through a TermAgent release note; starters must not ship against unreleased `main` commits.

## 7. Escalation and decisions

- Architectural disagreements are resolved through `TODO.md` phase decisions and `ARCHITECTURE.md` updates in the same change, not through side-channel forks of runtime modules.
- A newly discovered flaw may add a hardening sub-phase before a rollout gate (see TODO maintenance rules); propose it in the pull request rather than expanding scope silently.
- Integration gates: batch work is complete only when the batch-1 integration gate in `TODO.md` is closed (sequential build, focused regressions, package dry-run, source-hygiene scan, consolidated `PROGRESS.md` entry).
