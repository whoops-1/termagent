# TermAgent — dependency-aware implementation plan

**Date:** 2026-11-01  
**Status:** Proposed only; no implementation is authorized until the project owner approves the architecture and sequence.  
**Baseline:** supplied `1.18.0 Phase14D-Mobile-Fetch-Fix` full source archive.

This plan deliberately separates the work needed to make existing Phase 14 behavior correct from future capability development. Source paths below are the inspected current paths; new module names are proposals, not claims that files already exist.

## Sequencing overview

```text
Baseline/branch identity
        |
14E.1 permission resolver integration
        |
14E.2 remote auth + pairing + API authorization
        |
14F daemon owner + terminal/browser attachment + durable replay/recovery
        |
14 performance + Android validation gate
        |
16B safe web tools  ----+
16F provider protocol  -+--> 16A LSP + 16D repository graph
                                |
                          16E project knowledge
                                |
                       Cloud readiness audit
                                |
                       Phase 18 (future only)
```

Phase 14E and 14F are both required for safe client parity. The permission fix is first because it blocks the central browser interaction. Remote authentication must be complete before any deployment beyond loopback. The owner has selected one long-lived runtime daemon: Phase 14F therefore enforces single ownership and makes terminal/browser attach as clients; it does not build a multi-process event broker. Durable cursor replay remains the recovery contract. Phase 16B can run after the network-policy design; 16F can be developed independently after Phase 14 contracts stabilize; 16A and 16D should share a workspace identity/execution abstraction; 16E should build on their provenance and durable project identity. The Hermes-inspired Telegram notification companion is planned for Phase 17, after Phase 14 and selected Phase 16 security foundations.

## Gate 0 — establish the trusted working tree

**Objective:** Make sure implementation starts from the latest actual code, not a stale archive or remote branch.

**Existing state:** The supplied full-source archive has source, `dist`, tests and Web View but no `.git`. The older Git snapshot is behind. Public GitHub `main` was inspected and is missing files from the supplied Web View archive, so it is not a safe replacement.

**Required work:** obtain/confirm the authoritative current repository checkout or Git bundle, inspect branch/head/status and all uncommitted changes, compare it to the supplied Phase14D archive, preserve newer changes, and record a baseline commit/checksum manifest.

**Likely files:** repository metadata only; no product source changes.

**Tests:** `git status`, `git log`, archive-vs-working-tree diff, package metadata validation, build and focused baseline tests.

**Acceptance:** owner-approved baseline commit and clean working-tree diff inventory; no later files overwritten.

**Risks:** continuing from an archive without Git history can lose intervening work.  
**Complexity:** Low–Medium.

## Phase 14E.1 — server permission requester / original promise resolution

**Objective:** A browser decision must resolve the exact permission promise awaited by the original tool call.

**Existing implementation:** `src/cli/repl.ts` installs a CLI requester through `gate.setRequester()`. `src/server/runtime.ts` creates a server `PermissionGate` without a requester. `src/tools/permissions.ts` falls back to `askLegacy()` with readline on process stdin. `src/server/api.ts` resolves durable `SessionStore` permission state, but that does not settle the readline promise.

**Required changes:** install a server-side requester before any request is published; await the existing durable interaction resolution (`SessionStore.waitForInteractionResolution(...)` or a narrowly adapted primitive); map the winning durable once/always/deny decision into existing PermissionGate semantics. Avoid a second HTTP-owned approval promise. Ensure the gate, API, and all clients refer to one request ID and one authoritative resolution.

**Likely files:** `src/server/runtime.ts`, `src/tools/permissions.ts`, `src/session/store.ts`, `src/server/api.ts`, permission/protocol types and tests.

**Dependencies:** use current SessionStore first-writer-wins resolution and abort/timeout primitives; do not change event transport in this slice.

**Tests:** end-to-end server-created Agent run with a permission-required tool; browser allow resumes the same call with stdin disconnected; deny; once; always; concurrent browser/terminal replies; duplicate response; timeout/expiry; wrong session/request; cancellation and shutdown; reconnect while pending; ensure no side effect after denial/cancel.

**Acceptance:** browser click-to-agent continuation is verified from the original blocked promise, no terminal approval, no duplicate execution, and same durable outcome visible in terminal and browser.

**Risks:** race between publishing request, storing waiter and user resolution; cancellation leaks; always-rule semantics accidentally differ from CLI.  
**Complexity:** Medium–High.

## Phase 14E.2 — remote authentication, pairing and request authorization

**Objective:** Local use remains simple, but remote access fails closed until the user explicitly configures a secure boundary.

**Existing implementation:** `src/server/http.ts` supports a static bearer token, but missing token means `authOk()` allows requests. CLI can bind non-loopback addresses. There is no device pairing/token lifecycle/scope/revocation/Origin/rate-limit system.

**Required changes:** distinguish loopback from remote bind; refuse public bind unless explicitly enabled with auth. Add one-time pairing code exchange for device identity and opaque token; store only token hashes; expiry/revocation/rotation; command scope and session/workspace authorization; Host/Origin validation; request size/rate limits; brute-force throttling; CSRF controls suited to bearer vs cookie authentication; security audit event/redaction. Provider keys and runtime secrets stay in server memory/config and never reach browser JS.

**Likely files:** `src/server/http.ts`, new `src/server/auth/*` or `src/security/*`, `src/server/api.ts`, `src/protocol/*`, `src/client/client.ts`, config schema/defaults, CLI flags, security tests and `SECURITY.md`.

**Dependencies:** approve token-storage and pairing UX; permission command must already be first-writer/idempotent.

**Tests:** loopback without token; remote bind without explicit auth rejected; pairing success/expiry/replay/brute force; valid/invalid/revoked token; scope mismatch; origin/host mismatch; CSRF depending credential transport; duplicate state-changing commands; secret redaction; token rotation/revoke takes effect.

**Acceptance:** no unauthenticated remote command surface, minimal browser credential exposure, and every protected operation authorizes the token for the relevant session/workspace.

**Risks:** DNS rebinding/Host confusion, local network exposure, token leakage through URL/log/referrer, CORS misconfiguration.  
**Complexity:** High.

## Phase 14F.1 — single-daemon lifecycle and exclusive ownership

**Objective:** Establish one long-lived TermAgent runtime as the sole owner of Agent runs, active controllers, permission waiters, session writes, tasks, providers and the event bus.

**Existing implementation:** `src/server/runtime.ts` composes the server-owned runtime; `src/session/store.ts` has durable JSONL state, monotonic sequences and a turn lease; `src/session/event-bus.ts` is process-local; `src/agent/*` and `src/tasks/*` own runtime/worker state. A second `SessionStore` instance does not receive the first instance's in-memory bus wakeups. This is a confirmed limitation of competing independent runtimes, not a reason to add a distributed event broker under the accepted one-daemon topology.

**Required changes:** add daemon lifecycle, process identity, an exclusive owner lock/lease, health/heartbeat and endpoint discovery; implement safe stale-owner recovery; ensure only one process opens live runtime ownership for a given state root. A second launch must attach as a client or fail clearly. Define startup, foreground/daemonized mode, graceful shutdown, lock release, stale-lock rules and crash recovery without treating a stale PID alone as proof of ownership.

**Likely files:** `src/server/runtime.ts`, `src/index.ts`, `src/cli/*`, `src/session/store.ts`, new `src/daemon/*` or `src/runtime/owner/*`, configuration and tests.

**Dependencies:** accepted ADR-019. Preserve current JSONL and monotonic sequence as durable truth. Do not introduce Redis, a broker or a distributed lease service.

**Tests:** simultaneous starts from separate OS processes; lock contention; PID reuse/stale lock; owner crash during active turn; graceful stop; restart; stale owner cannot append/commit after takeover; Termux/Linux lock semantics; state directory permission and corruption handling.

**Acceptance:** exactly one daemon owns each TermAgent state root; duplicate starts attach or fail safely; restart has explicit interrupted-turn/task semantics; no duplicate Agent/PermissionGate/TaskManager writer is created.

**Risks:** unsafe stale-owner takeover, lock files surviving abrupt termination, detached-process lifecycle differences on Termux.  
**Complexity:** High.

## Phase 14F.2 — terminal and browser client attachment

**Objective:** Make the terminal and browser independent clients of the same daemon-owned runtime.

**Existing implementation:** Phase 14C provides `src/client/client.ts`, canonical command/event envelopes and HTTP/SSE; Phase 14D uses this client in `web/app/`. The terminal REPL currently composes much of its runtime locally and needs a shared-runtime attachment path.

**Required changes:** extract/reuse a renderer-neutral client command interface. The CLI should locate or start the daemon according to an explicit, tested lifecycle policy, then attach through a local transport (HTTP loopback or Unix domain socket) using the same versioned command/event schemas. The browser continues using HTTP/SSE. Terminal rendering remains ANSI/VT and browser rendering remains the v4-derived Web View. There must not be a second Agent runtime for a session already owned by the daemon. Keep a documented standalone mode only where it claims an exclusive owner before execution.

**Likely files:** `src/cli/repl.ts`, `src/cli/ui.ts`, `src/client/*`, `src/protocol/*`, `src/server/api.ts`, `src/server/http.ts`, daemon bootstrap and client tests.

**Dependencies:** 14F.1 owner lifecycle; 14E.1 shared permission resolution before the browser/terminal share approval state.

**Tests:** terminal attaches to existing daemon; browser attaches concurrently; no second provider/Agent instance; messages and commands route to the correct session; stale/missing daemon discovery; daemon unavailable; client reconnect and auth; preserve existing CLI keyboard/PTY behavior.

**Acceptance:** terminal and browser issue the same canonical commands and observe the same authoritative runtime, with one Agent execution and one PermissionGate for the session.

**Risks:** CLI interaction assumptions tied to in-process runtime objects; local transport authentication and PTY focus/input ownership.  
**Complexity:** High.

## Phase 14F.3 — durable replay, client parity and recovery

**Objective:** Every attached client converges on the same state through durable event replay and explicit reconciliation.

**Existing implementation:** Phase 14A/C canonical envelopes, CommandLedger, snapshot, HTTP API and dependency-free client exist; Phase 14B's in-daemon SessionEventBus already provides same-owner replay→tail. Its process-local nature is acceptable only when the single-owner invariant is enforced.

**Required changes:** make reconnect reconcile from the durable cursor/snapshot; handle SSE write backpressure and slow consumers; signal transient gaps rather than silently evicting activity; never lose durable events; ensure interaction state (permission/question/queue/task/todo/diff/checkpoint) hydrates correctly. Route interruption through the daemon's canonical command to its in-process controller. Define restart policy for active turns/tasks: interrupted, recoverable or explicitly requiring user action; never synthesize completion.

**Likely files:** `src/protocol/*`, `src/session/event-bus.ts`, `src/session/store.ts`, `src/client/client.ts`, `src/server/http.ts`, `src/server/api.ts`, `web/app/app.js`, terminal client adapter and integration tests.

**Dependencies:** 14E.1, 14F.1 and 14F.2. The two-store missed-wakeup probe remains documented as a guard against accidentally reintroducing competing runtime owners; cross-process event brokers are deferred.

**Tests:** terminal + browser + second browser; conflicting permission/question replies; duplicate commands; queue edits; task transitions; diff/checkpoint; branch/session switch; disconnect during stream; background/foreground; daemon restart; durable cursor/no duplicates; owner shutdown and interrupted-run recovery.

**Acceptance:** all attached clients converge on the same authoritative event/interaction state; reconnect replays every durable event after the cursor; transient activity loss is explicit and reconcilable; cancellation reaches the sole owner.

**Risks:** snapshot/live interleaving, optimistic UI rollback, lost in-flight live-only deltas.  
**Complexity:** High.

## Phase 14F.4 — physical Android and client parity gate

**Objective:** Validate the same daemon-backed runtime from actual Termux and Android browsers.

**Existing implementation:** prior Chromium checks were host-side smoke tests; they do not establish real-device behavior.

**Required changes:** validate Android Brave/Chrome navigation, keyboard/IME, focus, scrolling, safe areas, background/foreground, offline/online and daemon lifecycle. Verify local terminal attaches to the same daemon while the browser is open.

**Likely files:** tests/integration/daemon-client fixtures, `docs/DEVICE_TEST.md`, browser app fixes only where device evidence identifies a problem.

**Dependencies:** 14F.1–14F.3 and device access.

**Tests:** actual Android/Termux matrix, multi-client prompt/permission/stop/resume, network handoff, browser process recreation, terminal process recreation, long transcript and tool output.

**Acceptance:** measured device evidence shows that terminal and browser are two clients of one daemon and that reconnect/interaction behavior remains correct.

**Risks:** device/OS/browser version variability.  
**Complexity:** Medium–High.

## Phase 14 performance and Android validation

**Objective:** Make mobile response feel immediate based on measured bottlenecks, not transport folklore.

**Existing implementation:** browser request fan-out on refresh, a 160ms durable-event refresh debounce, full transcript reconstruction on each live delta, `innerHTML` write, repeated Markdown processing, SSE write without backpressure, bounded live buffer with silent eviction. No validated p50/p95 baselines exist.

**Required changes:** add timestamp/trace IDs at prompt submit, server ack, runtime start, provider first token, event publish, browser receive, DOM commit, permission click/resolution, tool start/end, session ready and cancellation. Use Performance API/Server-Timing and bounded diagnostic ring buffer, avoid persisting prompt contents/secrets in telemetry. Then batch/reduce snapshot fan-out; event-driven local projection; render streaming segment incrementally and schedule updates with animation frame; parse static messages once; backpressure and explicit live event gap; pause hidden tab work and reconcile on visibility resume.

**Likely files:** `src/server/http.ts`, `src/server/runtime.ts`, provider stream adapters, `src/session/event-bus.ts`, `web/app/app.js`, `web/app/*css`, perf test harness and Android checklist.

**Dependencies:** 14F event identity/cursor semantics; instrument before optimizing.

**Tests/benchmarks:** p50/p95 + sample count across all nine operations in handover; large transcript stress; simulated throttled 4G/latency; background/foreground; long code blocks; Android Chrome/Brave device run; memory/long task/layout profile.

**Acceptance:** baseline and after report includes measured before/after values with sample counts; no regressions in ordering/recovery; target latency budgets agreed after baseline; physical Android passes.

**Risks:** optimizing host Chromium not Android; telemetry overhead; rendering race with optimistic/durable reconciliation.  
**Complexity:** Medium–High.

## Phase 16B — secure web search/fetch

**Objective:** Add research tools without turning the agent into an SSRF proxy or silently exposing internal infrastructure.

**Existing implementation:** no general agent-facing `web_search`/`web_fetch` built-ins. Existing fetch calls in provider/marketplace/skill code are not a network permission system.

**Required changes:** define provider-neutral search adapter and bounded fetch tool; domain/resource policy and permission actions; strict URL/port allowlist policy; DNS A/AAAA resolution and private/link-local/loopback/metadata rejection; pin validated connection IP where supported; revalidate redirects; time/response/decompression/MIME/output caps; strip auth headers/cookies; store full result out-of-band with provenance; quote/extract in a prompt-injection-aware way.

**Likely files:** `src/tools/builtin.ts`, new `src/tools/web/*`, `src/tools/permissions.ts`, tool types/registry, config network rules, task artifact storage, tests/security fixtures.

**Dependencies:** permission contract from 14E and SSRF/network boundary design.

**Tests:** public URL success; redirect to private IP; IPv4/IPv6 edge cases; DNS rebinding simulation; localhost/metadata; non-HTTP schemes/odd ports; redirect loops; oversized/compressed response; slow server; invalid MIME; auth redirect leakage; content that attempts prompt injection.

**Acceptance:** user-visible web results have source/provenance; unsafe/internal endpoints blocked at connection boundary; network actions follow the same PermissionGate lifecycle.

**Risks:** DNS TOCTOU and proxy behavior; search API provider cost; malicious page content.  
**Complexity:** High.

## Phase 16F — provider protocol maturity

**Objective:** Make provider differences explicit and replayable without rewriting the working retry/cancel core.

**Existing implementation:** `Provider.stream()` typed stream events; AbortSignal cancellation; retry/backoff, Retry-After, cancellation during backoff, idle detection and partial-output duplicate safeguards documented in 13N-F.

**Required changes:** add capability descriptor per model/provider (tools, parallel tools, images, structured output, reasoning, max context, cancellation support); canonical structured output request/result/validation; stable provider request and tool-call IDs across chunks; deterministic capture/replay at normalized event boundary, redacting secrets and respecting user privacy; provider adapter conformance suite.

**Likely files:** `src/providers/types.ts`, provider registry/adapters, `src/agent/*` tool-call normalization, config/model metadata, stream fixture recorder and provider tests.

**Dependencies:** Phase14 canonical lifecycle; no separate transport migration required.

**Tests:** every provider adapter against event fixture suite; split/empty/malformed tool frames; stable IDs; abort before/during retry; Retry-After; idle timeout; structured schema invalid; replay redaction and deterministic replay.

**Acceptance:** provider capability is queryable, normalized stream replay is deterministic, tool calls are correlated, and all current retry/cancel regressions remain passing.

**Risks:** provider feature drift; sensitive prompt capture; assuming model catalog claims equal real capabilities.  
**Complexity:** Medium–High.

## Phase 16A — LSP and code intelligence

**Objective:** Convert existing diagnostic tracker into optional, reusable workspace language-server services.

**Existing implementation:** `src/context/lsp-diagnostics.ts` state model and `EvidenceLedger`; no process manager, JSON-RPC client, didOpen/didChange/didClose, definition/reference/hover/documentSymbol requests, or document position mapping.

**Required changes:** provider-neutral JSON-RPC transport over stdio; server discovery/config; spawn lifecycle and resource limits; initialize/capability negotiation; document version/sync; diagnostics routed to existing tracker; definition/reference/symbol APIs and `ToolRegistry` tools; clean shutdown/restart; optional per language and fallback.

**Likely files:** `src/context/lsp-diagnostics.ts`, new `src/context/lsp/*`, `src/context/repository.ts`, `src/tools/builtin.ts`, tool types, session/evidence events, tests.

**Dependencies:** Phase18 workspace adapter design (but can implement local adapter first); 16F protocol IDs not tightly coupled; use same workspace identity as 16D.

**Tests:** fake stdio LSP server protocol tests; TypeScript/Python language server smoke; document incremental changes; diagnostics settle; definition/reference results; timeout/crash/restart; unsupported server fallback; Termux missing server.

**Acceptance:** basic LSP features available for configured workspace languages without being mandatory on Termux; lifecycle safe and recoverable; evidence participates in repository retrieval/verification.

**Risks:** server binaries/versions; language server RAM; workspace path differences; protocol edge conditions.  
**Complexity:** High.

## Phase 16D — structural repository intelligence

**Objective:** Evolve current lightweight repository map into persisted, incrementally invalidated dependency/symbol/reference context.

**Existing implementation:** `src/context/repository.ts` file inventory, JS/TS/Python analysis cache, import edges and PageRank-like rank; `src/context/symbols.ts` regex-based symbol/import/reference extraction; token-budgeted repo map.

**Required changes:** content-hash file analysis cache; persisted graph with schema/version/workspace revision; incremental invalidate/re-resolve changed and dependent nodes; distinguish lexical references from parser/LSP-verified references; enrich language coverage with adapter/fallback; combine symbols, import/dependency graph, tests, recent session evidence and query relevance; maintain token budget and ARMv7 fallback.

**Likely files:** `src/context/repository.ts`, `src/context/symbols.ts`, `src/context/retrieval.ts`, evidence/ledger types, new graph store/index modules, tests.

**Dependencies:** canonical workspace identity; LSP data may enrich but must not be mandatory. Continue's content-hash indexing and Aider's PageRank token budget are references.

**Tests:** rename/move/delete; dependency chain invalidation; branch switch same-content cache reuse; cyclic graph; unresolved imports; large repo budget; graph persistence/reload; stale/corrupted graph fallback; compare retrieval relevance fixtures.

**Acceptance:** changed files update graph incrementally without stale edges; retrieval selects cross-file relevant files and produces measured quality improvement on representative repository tasks.

**Risks:** false lexical references, graph churn, storage bloat, language-specific parsing; do not ship a native-only parser requirement.  
**Complexity:** High.

## Phase 16E — persistent project knowledge

**Objective:** Store durable project context that survives sessions, but distinguish facts, instructions and inference with provenance.

**Existing implementation:** instruction file loader, session logs, context machine checkpoints, EvidenceLedger, exploration state and repository cache. No unified cross-session project memory with provenance/freshness/invalidation.

**Required changes:** workspace-scoped memory store (versioned JSONL or JSON initially), schemas for project summary, architecture decisions, conventions, schemas, known issues, discoveries and pending tasks; each record includes provenance/source URI or path, file hash/commit, confidence/confirmation, timestamp, freshness/expiry/invalidation; inspect/review/edit/delete/export/import; source-change invalidation; agent reads memory with provenance and never treats stale inferred facts as user instructions.

**Likely files:** `src/context/instructions.ts`, `src/context/*`, `src/session/store.ts` only where linkage appropriate, new `src/context/project-memory/*`, tools/API, tests.

**Dependencies:** stable workspace identity and 16D repository content hashes; avoid vector DB until retrieval tests demonstrate need.

**Tests:** create and recall; update conflicting fact; file hash changed invalidates; branch/source provenance; distinguish user-approved decision vs inferred note; delete/export/import; malformed store recovery; cross-session context budgets.

**Acceptance:** user can inspect why a fact is known, source and age; stale repository facts no longer guide agent; reversible updates with no single-vector-store dependency.

**Risks:** confusing project memory with model/user memory, instruction injection, staleness, uncontrolled growth.  
**Complexity:** Medium–High.

## Phase 17 — Runtime operations and Telegram owner companion (planned, not authorized yet)

### 17A — architecture cleanup

**Objective:** consolidate code around the selected daemon/service/client ownership and remove parallel implementations only where characterization tests prove safe.

**Existing implementation:** current modules already separate Agent, SessionStore, TaskManager, client/protocol and Web View. Phase 14F is responsible for implementing the first daemon lifecycle, owner lock and terminal/browser client attachment. Phase 17A is not a second daemon implementation.

**Required changes:** after the daemon and client seams are proven, reorganize modules toward the documented repository structure, consolidate duplicate helpers, split oversized mixed-responsibility modules and align tests with domain ownership. Preserve compatibility facades until characterization tests prove removal safe. Do not move code merely for directory aesthetics and do not create a second agent loop.

**Likely files:** `REPO-STRUCTURE.md`, `src/server/*`, `src/client/*`, `src/protocol/*`, `src/cli/*`, `src/agent/*`, `src/tasks/*`, domain test folders and import/export facades.

**Dependencies:** completed Phase 14F and selected Phase 16 contracts; repository structure review.

**Tests:** import/export compatibility, no duplicate implementations, domain test isolation, package build, extracted-artifact smoke, CLI/daemon attach regression and source-hygiene checks.

**Acceptance:** clear module ownership with no behavioral regression; daemon owner and client boundaries from 14F remain unchanged. **Complexity:** Medium–High.

### 17B — notification service and durable outbox

**Objective:** deliver opt-in unattended-work notifications without making the model a generic messaging relay.

**Existing implementation:** TaskManager notifications and canonical session/task/runtime events exist, but there is no generalized external delivery outbox.

**Required changes:** notification envelope/category policy, stable dedupe key, durable outbox states, owner destination resolution, redaction, retry/unknown delivery semantics, quiet hours, coalescing and rate limits. A model-facing `notify_owner` intent, if included, has no arbitrary recipient argument.

**Likely files:** new `src/notifications/*`, session/task event producers, config, `src/server/runtime.ts`, `src/protocol/*`, tests.

**Dependencies:** 14E authentication/scopes, 14F single daemon, safe secrets boundary.

**Tests:** duplicate event, restart with pending outbox, known retryable error, ambiguous timeout, redaction failure, rate limit, quiet hours, opt-out and owner destination mismatch.

**Acceptance:** run outcome is independent from delivery outcome; outbox survives daemon restart; no arbitrary external recipients. **Complexity:** Medium–High.

### 17C — Telegram owner companion

**Objective:** let the daemon send the owner timely notifications through a private Telegram bot.

**Existing implementation:** no Telegram Bot API adapter. Hermes provides a source-level reference but does not get imported as a runtime dependency.

**Required changes:** TypeScript Bot API adapter, one-time pairing with a paired private chat, token storage/redaction, optional long polling for pairing, durable inbound update cursor, outbound send retry/rate/length handling, Web View deep-links for pending permissions. Initial scope is single-owner/private; general groups and many platforms are out of scope.

**Likely files:** new `src/notifications/telegram/*`, `src/config/*`, daemon bootstrap, pairing API/CLI, tests and `SECURITY.md`.

**Dependencies:** 17B; Telegram pairing must use the Phase14E security model.

**Tests:** unpaired sender, expired/used code, wrong account, revoked token, bot blocked, flood control, long text chunking, update replay, restart, secret leak scan and end-to-end completion/failure notification.

**Acceptance:** only paired owner receives permitted categories; token never reaches browser/prompt/child environment/log; message delivery state is truthful. **Complexity:** Medium–High.

### 17D/17E — scheduled automation and daemon operations

**Objective:** add reliable schedules and 24/7 health/recovery.

**Required changes:** durable one-shot/recurring job definitions, stable run ledger, fresh bounded sessions, pause/resume/edit/trigger/remove, separate trigger/execution/delivery, optional script-only jobs after sandbox readiness, webhook triggers with signature verification, daemon heartbeat/watchdog, graceful stop and interrupted task recovery.

**Likely files:** new `src/scheduler/*`, `src/notifications/*`, `src/daemon/*`, TaskManager/session store, webhook/API/client surfaces.

**Dependencies:** 17A–17C; 18C isolation for arbitrary scripts.

**Tests:** DST/timezone behavior, no double fire, missed/overdue jobs, restart during run/delivery, owner shutdown, network outage, webhook replay/signature, outbox recovery and resource caps.

**Acceptance:** jobs are auditable/recoverable; scheduler health is distinct from daemon and Telegram connection health; no untrusted script runs with control-plane privileges. **Complexity:** High.

## Phase 18 readiness review (not implementation)

**Objective:** Establish whether the system can operate as a secure private single-user cloud development environment.

**Existing implementation:** TermAgent has a local runtime/server/browser but assumes one host workspace and inherited env. There is no workspace manager or isolated workspace execution adapter.

**Required design outputs:** choose control-plane persistence (JSONL single-instance vs Postgres if multi-replica need), `ExecutionEnvironment` interface + local adapter, sandbox provider evaluation (Railway Sandboxes first proof-of-concept; compare Daytona/E2B/Coder/self-hosted), repository import/credentials flow, workspace lifecycle/quotas, storage/backup, graceful shutdown and recovery, observability/cost controls, sandbox networking and secret broker. Railway can host the control plane and offers a separate VM Sandbox product to evaluate, but untrusted commands must never execute as children of the control-plane service. Validate sandbox/private-network isolation before selection.

**Likely future files:** new execution adapter boundary under tools/tasks; workspace domain module; config; auth; server runtime; cloud deployment manifests; not to be created in this planning phase.

**Dependencies:** Phase14 + selected Phase16 complete; ADRs 018–020 approved; threat model and cost model reviewed.

**Tests:** sandbox breakout tests; secret visibility probes; workspace cross-access; cpu/mem/process/disk/time/network limits; restart recovery; backup restore; agent/provider outage; resource budget tests.

**Acceptance:** explicit security review proves controls; local CLI parity retained; workspaces are isolated; persistent state recoverable; budget and cost limits measured.

**Risks:** Railway Free credit and service limits; sandbox VM metering and private-network reachability; egress; Git credential leakage; false belief VM/container boundaries alone prevent all escapes.  
**Complexity:** Very High.

## Deferred / not active

- **14G WebSocket:** defer. HTTP/SSE remains canonical until measurements demonstrate an unresolved limitation.
- **15 VS Code extension:** discontinued as an active milestone and deferred indefinitely; preserve protocol and generic client.
- **16C notebooks:** defer; original scope preserved in `PHASE16C-NOTEBOOKS-DEFERRED-SPEC.md`.
- **Phase 18 implementation:** not active; complete only a readiness architecture review after prerequisite gates.
