# HANDOFF PROMPT — TERMAGENT

## Resume point: Phase 14 continuation, Single Runtime Daemon, Hermes research complete

You are continuing the long-running **TermAgent** project. The attached ZIP is the current full-source checkpoint and documentation bundle:

`TermAgent-1.18.0-Phase14D-Hermes-Research-Checkpoint-Full-Source.zip`

Read this entire prompt, then inspect the attached repository itself before making changes. The ZIP includes the full TermAgent project (source, compiled distribution, tests, Web View, documentation, prior phase reports, research, ADRs and this handoff prompt). It is not a source patch.

---

# 1. Non-negotiable project rules

1. **Do not build from scratch where a relevant upstream implementation already exists.** Search/read the actual OpenCode/OpenClaude/Hermes/Cline/other relevant GitHub source and official docs, understand its implementation, then adapt it to TermAgent. Do not blindly copy names, branding, UI, or architecture.
2. **TermAgent remains the sole agent engine.** Preserve the existing Agent, provider abstraction, ToolRegistry, PermissionGate, skills, plugins, MCP, context management, repository intelligence, sessions, tasks and specialists wherever practical. Do not add another agent orchestration framework.
3. Preserve the local CLI and Termux/Android ARMv7 compatibility. Node.js/TypeScript is preferred. The package currently identifies as `@whoops-1/termagent@1.18.0`; do not change version/package metadata or publish without explicit release approval.
4. Prefer a modular monolith and one long-lived runtime owner. Avoid unnecessary microservices, Redis, Celery, Elasticsearch, Python backend services, native dependencies and fashionable transports without measured need.
5. Mobile browser is the primary remote control surface. The supplied production UI is in `web/app/`; the user's preferred v4 visual prototype is in `web/prototype/`. Preserve its visual language and mobile-first priority.
6. Do not claim tests, device checks, performance numbers, branch state or deployment validation that were not actually performed. Separate host-side browser tests from physical Android/Termux validation.
7. Keep protocol/runtime state separate from UI state. HTTP + SSE remains primary; Phase 14G WebSocket is deferred unless measurements establish a real need.
8. Do not implement a roadmap phase simply because it is documented. Respect the current approval boundary below.

# 2. Source checkpoint and limitations

The ZIP contains the full source tree based on the supplied `TermAgent-1.18.0-Phase14D-Mobile-Fetch-Fix-Full-Source` baseline, with the current research and roadmap documents integrated.

- Package: `@whoops-1/termagent`
- Version: `1.18.0`
- Runtime: TypeScript / Node.js >=22
- Current baseline: Phase 14D Web View plus the Android Brave Fetch receiver fix
- The browser client uses `globalThis.fetch.bind(globalThis)` for its default fetch implementation. This fixes the reported Android Brave `Illegal invocation` failure.
- Source, `dist/`, tests, docs, `web/app/`, `web/prototype/` and prior reports are included.
- The archive intentionally excludes `node_modules` and `.git` history.
- The source archive has no `.git` metadata, so it does **not** prove the latest commit/branch or uncommitted state of the user's actual checkout. Inspect the live repository/Git history when available. Do not overwrite newer user work with this archive. If no live checkout is available, treat this ZIP as the best supplied source baseline and state the limitation.

The completed archive contains 857 files: the 844-file Phase 14D base plus 13 added research/decision/spec/handoff/manifest files and updates to three existing roadmap/progress/architecture documents. The `dist/` directory is included. Build outputs must be regenerated with the project's normal build after source modifications.

# 3. User's long-term goal

TermAgent is evolving from a Termux-first terminal coding agent into a mobile-accessible autonomous development environment. The user's Android phone is the control device; eventually a cloud Linux workspace will execute builds, tests, browsers and shell commands.

The intended user experience is: open TermAgent in Chrome on Android, select a project, connect a GitHub repository, start an agent, issue work, observe live execution, inspect files/diffs, approve sensitive operations, use a terminal, run tests/builds, inspect Git, commit/push, monitor tasks and resume previous work.

This is **not immediate Phase 18 deployment work**. Complete and audit Phase 14, the selected Phase 16 work and Phase 17 operational prerequisites first.

The key eventual cloud separation is:

- TermAgent control plane: Agent loop, providers, ToolRegistry, permission policy, session state, task orchestration, credentials and API.
- Workspace execution plane: isolated filesystem, shell/processes, dependencies, builds, tests, browser automation and Git work.
- Keep provider secrets in the control plane; never inherit them wholesale into untrusted workspace processes.

# 4. Accepted architectural decision: Option A, one runtime daemon

The user explicitly selected **Option A: Single Runtime Daemon**. This is the accepted topology recorded in the updated architecture / ADR-019.

One long-lived TermAgent daemon is the exclusive owner of:

- Agent instances and active turns/controllers
- Provider clients and ToolRegistry
- PermissionGate and original pending interaction promises
- SessionStore writes and CommandLedger
- TaskManager/background workers
- Runtime event bus and authoritative session state

Terminal UI and browser Web View attach as clients to the same daemon. Future Telegram is another daemon-owned adapter/client. No client creates its own agent runtime for the same session.

This decision supersedes the earlier multi-process owner-routing alternative. Do not design a distributed event broker or multi-owner execution system as the initial solution. Enforce single ownership with a robust lock/lease and clear lifecycle semantics; consider cross-process notifications only if the actual chosen daemon topology requires them for clients or external observers.

The daemon must support graceful startup/shutdown, stale owner recovery, health/heartbeat, client attach/detach, event replay and explicit active-run recovery behavior. Keep HTTP/SSE as the browser protocol. Terminal may attach through a local IPC or loopback API adapter if the inspection shows that to be the cleanest path; decide based on existing source, not assumptions.

# 5. Current project state

## Phase 13 baseline

TermAgent already has substantial implementations:

- Agent orchestration and plan/build/explore modes
- Multiple providers, routing and fallbacks
- Tool-call lifecycle, incremental text/XML tool-call parsing
- File read/write/edit/search and shell tools
- Git and repository mapping/context
- Background tasks, task manager and specialist/custom agents
- Skills, plugins, marketplaces and MCP
- Persistent sessions, checkpoints, queue and recovery
- Semantic terminal UI, permissions/questions, Todo, diffs and activity
- Provider streaming/retry/cancellation foundations
- JS/TS/Python structural analysis and a diagnostic state tracker

Historical Phase 13 details remain in `PROGRESS.md`, `TODO.md`, `docs/` and phase reports. The repository-wide full test runner has had previously recorded non-terminating/legacy failure issues; do not claim it is green without re-running and documenting the exact gate.

## Phase 14A–14D

14A: canonical event/interaction model.

14B: runtime-owned durable session event bus and replay-then-tail SSE design. The bus is a wakeup mechanism and the SessionStore is durable truth. It was designed for one runtime owner.

14C: typed HTTP API and dependency-free client SDK in `src/client/`, `src/server/api.ts`, `src/server/http.ts` and `src/protocol/`.

14D: browser application in `web/app/`, based on canonical API/client/event contracts, with mobile-first layout and tool/activity/session/interactions surfaces. The v4 prototype is retained in `web/prototype/`.

The Android Brave bug was fixed in the client default fetch binding:

```ts
this.http = options.fetch || globalThis.fetch.bind(globalThis)
```

The user reported the previous `Window.fetch` Illegal invocation. Automated focused tests were recorded as passing after this fix; physical testing on the user's Android device remains a required validation item.

14D host-side focused tests and Chromium responsive checks were reported in `PROGRESS.md`/`PHASE-14D-REPORT.md`. Those are not physical Android, real provider, or cloud validations.

## Important confirmed Phase 14D permission defect

This is the immediate known blocker.

Relevant source:
- `src/tools/permissions.ts`
- `src/server/runtime.ts`
- `src/server/api.ts`
- `src/server/http.ts`
- `src/session/store.ts`
- Terminal setup path in `src/cli/repl.ts`

`PermissionGate` has a `setRequester()` hook and a legacy fallback that asks through `readline`/`process.stdin` when no requester is installed.

The CLI attaches an interactive requester. The server runtime currently constructs the gate roughly as:

```ts
const gate = new PermissionGate(cfg.approvals, process.stdin, process.stdout, cfg.permissionRules || [], store)
```

It does not attach a server/browser-owned requester. In `PermissionGate.check()`, the gate persists `appendPermissionAsked(...)`, then waits on `this.requester(...)` if present, otherwise `askLegacy(...)` (readline).

The HTTP permission-resolution path in `src/server/api.ts` uses the durable store interaction-resolution mechanism, but that does not necessarily resolve the original `askLegacy()` readline promise. This explains the reported behavior: browser state can record Allow while the original tool call is still blocked waiting for Termux stdin.

**Required outcome:** Browser Allow/Deny/Once/Always must resolve the exact original pending permission request and resume/deny the original tool execution. There must be one authoritative request identity, one pending resolver/promise and one durable final decision. Terminal and browser are two surfaces for that same request. Do not create a second independent approval executor or fake a UI-only state change.

Inspect all code paths again and confirm exact behavior before editing. The current durable interaction waiting primitive may be reusable, but preserve command idempotency, first-writer-wins semantics, timeouts, abort/cancellation and session scoping.

## Other known Phase 14 risks

- EventBus is process-local; separate SessionStore instances do not wake each other's subscribers. Under the accepted single-daemon model, do not overbuild a cross-process broker; enforce single daemon ownership and ensure multiple clients attach to that owner.
- Runtime `activeControllers` are process-local. A client must issue interrupt to the daemon that owns the turn; single-daemon topology solves this by design.
- Browser event handlers may re-render the entire transcript per delta; inspect `web/app/app.js` and profile before optimizing.
- Durable events can cause API refresh fan-out; measure and consolidate using incremental event projections.
- SSE writes/backpressure and live transient event overflow need explicit handling and durable cursor reconciliation.
- Browser tab backgrounding/reconnect and Android virtual keyboard, touch, scroll, safe-area and navigation must be tested.
- Permission requests must not become stale, duplicate or cross-session-resolvable.

# 6. Hermes Agent research completed

Hermes was researched at pinned revision:

`NousResearch/hermes-agent@a4994d4ead8f9c915b485cec5689909b349a49df`

Full report: `docs/research/TERMAGENT-HERMES-AGENT-RESEARCH-2026-11-01.md`.

Other existing comparison reports:
- `docs/research/TERMAGENT-PLATFORM-RESEARCH-2026-11-01.md`
- `docs/research/TERMAGENT-ARCHITECTURE-ASSESSMENT-2026-11-01.md`
- `docs/research/TERMAGENT-IMPLEMENTATION-PLAN-2026-11-01.md`

Key Hermes lessons:

1. Long-lived messaging gateway owns platform adapters and routes each source to a persistent conversation/session.
2. Telegram adapter has authorization/pairing, chat/thread routing, commands, update admission/deduplication, busy-session handling, typing, streaming, delivery pacing, retry-after handling and media support.
3. **Crucial:** Hermes deliberately does not register generic `send_message` as an ordinary model-callable tool. Sender helpers are used by cron/CLI/notifier. This limits arbitrary outbound messaging initiated by model output. TermAgent should adopt that principle.
4. Scheduled trigger, agent execution, durable result and notification delivery are separate. A notification failure must not rerun completed agent work. Delivery has its own outbox/ledger states and ambiguous-send handling.
5. Bounded curated memory and cross-session search; progressive-disclosure skills; bounded isolated delegation; health/watchdog and restart recovery.
6. Hermes is Python and uses python-telegram-bot. Do not port its AIAgent/runtime, provider stack or Python dependencies. TermAgent should implement any Telegram Bot API adapter in TypeScript behind the existing daemon and services.

Researched Hermes source includes:
- `gateway/platforms/base.py`, `gateway/run.py`, `gateway/session.py`
- `plugins/platforms/telegram/adapter.py`, update admission modules
- `tools/send_message_tool.py`, `tools/send_message_senders.py`
- `cron/scheduler.py`, `cron/scheduler_provider.py`, `cron/scheduler_delivery.py`
- memory, skills, delegation and security documentation

Useful direct research links and exact commit pins are in the report. The Hermes report and prior comparative report are included in the ZIP.

# 7. Telegram feature direction — NOT STARTED

The user wants TermAgent to be able to send messages to them through a Telegram bot token, since the future daemon will run 24/7.

The approved design direction is a **private single-owner Telegram Companion**, planned in Phase 17, not immediate implementation.

Recommended service architecture:

```text
TermAgent daemon events / bounded owner intents
                     |
                     v
             NotificationService
                     |
                Policy check
                     |
              Durable outbox
                     |
       dedupe / redact / rate-limit
                     |
              Telegram adapter
                     |
             Paired private owner
```

Initial notifications may include:
- Agent run completion/failure
- Permission required (with authenticated Web View deep-link, not approval-by-URL)
- Significant task milestones, opt-in
- Scheduled reports
- Daemon degraded/recovered transitions

Do not send every token or every tool event to Telegram. Use event categories, preference settings, quiet hours, coalescing and rate limits.

Outbox state should distinguish at least `pending`, `claimed`, `delivered`, `failed`, `delivery_unknown`, `cancelled`. Network timeout after Telegram accepted a message is ambiguous; blindly retrying can duplicate it. Separate task execution result from notification delivery result.

Telegram security requirements:
- One explicitly paired owner/private chat initially.
- Bot token stored only in daemon-side secret storage/config; never sent to browser assets, model prompts, shell/task/plugin child environments or logs.
- Short-lived, single-use pairing code; sender identity verification; revocation; token rotation.
- User must open bot and send `/start` before bot can initiate a private chat.
- Choose long polling or webhook (not both). If polling is used, persist update cursor/deduplication in daemon-owned state and handle replay/restart.
- Honor Telegram length limits, per-chat pacing, HTTP 429 `retry_after`, transient errors and safe Markdown formatting.
- No generic arbitrary-recipient `send_message` model tool. If a model-facing owner notification intent is later approved, it must have no recipient argument and only enqueue policy-checked messages to the paired owner.
- Telegram approval/stop/control commands are later work and must route through the canonical daemon command API and same PermissionGate; no separate permission path.

Hermes docs note Telegram Bot API tokens are secret, bot cannot DM before user starts the bot, long polling conflicts with webhook, and updates can be replayed after crashes. The exact Telegram details are in the Hermes research report. Re-verify current Telegram Bot API constraints before Phase 17 implementation because they can change.

# 8. Updated roadmap and status

Authoritative status lives in `TODO.md`; progress and decisions live in `PROGRESS.md`, `ARCHITECTURE.md`, `docs/decisions/` and `docs/research/`.

## Phase 14

- 14A–14D: implemented/focused host-tested as recorded, but entire Phase 14 is NOT complete.
- 14E: security, pairing and remote access remains open.
- 14F: browser/terminal two-way parity and daemon ownership remains open.
- 14G: optional WebSocket deferred.

The user selected single runtime daemon Option A. Phase 14F must implement/verify that topology. Avoid premature cross-process event broker complexity.

## Phase 15

VS Code integration discontinued as an active milestone and deferred indefinitely. Preserve generic client/protocol/API compatibility; do not implement the extension now.

## Phase 16: selected completion

- 16A LSP/code intelligence: selected; current `src/context/lsp-diagnostics.ts` is a diagnostic state model, not a complete LSP client/manager. Needs process lifecycle, JSON-RPC, initialize, document sync, definition/references/symbol queries and cancellation.
- 16B Web tools: selected; general safe web_search/web_fetch are missing as first-class tools. Needs network permission + SSRF/redirect/DNS/IP/content/size/time protections.
- 16C Notebook/document editing: deferred.
- 16D Structural repository intelligence: useful file inventory, JS/TS/Python lexical analysis, import edges and structural ranking exist. Improve content hashes, incremental graph persistence, references, language support and evidence fusion.
- 16E Persistent project knowledge: existing instructions, sessions, EvidenceLedger and context caches are not a unified provenance-bearing cross-session project knowledge store. Add inspectable, editable, invalidatable records; no vector DB initially.
- 16F Provider protocol: typed streams, AbortSignal, retry/backoff, Retry-After and idle stream handling exist. Formal capability descriptors, structured output contract, stable tool-call correlation and deterministic stream recording/replay remain to do.

## Phase 17 (planned after Phase 14 and selected Phase 16)

- 17A architecture cleanup after daemon and client contracts are proven.
- 17B NotificationService + durable outbox.
- 17C private Telegram owner companion.
- 17D scheduled/event-triggered automation.
- 17E daemon health/watchdog/recovery.

## Phase 18 (future, not active)

TermAgent Cloud Edition: cloud runtime, GitHub workspace import, isolated Linux execution, browser control center (extend existing Web View), existing specialist-agent workflows and recovery/observability. Railway is the preferred initial control-plane candidate; Railway Sandboxes should be compared with Daytona/E2B/Coder/self-hosted execution. Never run untrusted project commands as child processes of the publicly exposed control-plane service. Keep provider credentials outside workspace execution.

# 9. Immediate next proposed work — Phase 14E.1

The latest user-approved action is the Hermes research + docs update and acceptance of Option A. **The user has not yet explicitly authorized starting Phase 14E.1.** The last assistant proposed Phase 14E.1 and recommended beginning it, but the user asked for a handoff before saying to start. Therefore do not begin code implementation until the user instructs you to start the phase.

When authorized, Phase 14E.1 is:

**Permission Resolver Integration**

Objective: browser/terminal decisions resolve the exact original pending PermissionGate request and unblock the original tool execution.

Before modifying code:
1. Read `AGENTS.md`, `README.md`, `TODO.md`, `CHANGELOG.md`, `PROGRESS.md`, `ARCHITECTURE.md`, Phase 14A/C/D reports, research report and accepted ADRs.
2. Inspect current source and actual Git status/head if available. The supplied ZIP has no Git history.
3. Re-read upstream Cline's interaction coordinator pattern and OpenCode permission request/response patterns. In Hermes research, note Telegram approval control routing but do not import framework code.
4. Trace exact lifecycle from tool call -> PermissionGate.check -> appendPermissionAsked -> pending resolver -> durable interaction state -> HTTP command -> original promise -> tool continuation -> event projection.
5. Identify whether the fix is a server-owned requester backed by `waitForInteractionResolution`, or a better existing canonical interaction API. Do not assume; prove it.

Likely source files:
- `src/tools/permissions.ts`
- `src/server/runtime.ts`
- `src/server/api.ts`
- `src/server/http.ts`
- `src/session/store.ts`
- `src/interaction/ledger.ts`
- `src/protocol/*`
- tests under `tests/`

Required tests:
- Browser/HTTP Allow resumes original pending tool without stdin.
- Browser/HTTP deny rejects original tool and does not execute it.
- Once vs Always semantics persist appropriately.
- Terminal and browser race: exactly one authoritative first-writer-wins result.
- Duplicate/stale/wrong-session request IDs.
- Timeout/expiry.
- Abort/cancel while waiting.
- Multiple concurrent permission requests.
- Disconnect/reconnect while pending; request reconstructs from durable state and can still be resolved once.
- Server shutdown/restart semantics are explicit; no unresolved promise silently hangs.
- No readline fallback in headless server runtime.

Acceptance criteria:
- A server-owned agent run issues permission-required operation.
- Browser receives the durable request.
- Browser Allow resolves the original PermissionGate wait and the tool runs, with no terminal input.
- Browser Deny resolves the original request as denied and the tool does not run.
- Terminal and browser show the same final durable resolution.
- Tests prove races, cancellation, expiry and replay behavior.
- Build, focused tests, package dry-run and generated dist checks pass.
- Physical Android/Termux validation is recorded separately.

Do not combine the 14E.1 fix with the entire 14E/14F/security implementation. Deliver a focused phase slice and report exact files, design, tests, caveats and an updated full-source ZIP on completion.

# 10. What the next assistant must do first

First establish the current source state from the attached ZIP and, when connected, the user's live Git repository. Read the project instructions and core docs. Confirm the current phase status and the approved Option A topology. Do not start Phase 14E.1 until explicitly asked.

If the user says **Start Phase 14E.1**, research upstream permission lifecycle first, implement the focused fix in the existing runtime, add the regression suite and update progress/roadmap/change documentation. Never ask the user to repeat already documented context.

If the user asks another question first, answer from the included source/research docs and distinguish source facts from inference/current external research.

The final objective remains: one reliable TermAgent engine, one authoritative daemon, local terminal + mobile browser clients, later secure Telegram owner companion, then an isolated cloud workspace execution plane.
