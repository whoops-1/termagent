# TermAgent Architecture Assessment and Roadmap Review

**Review date:** 2026-11-01  
**Baseline:** `TermAgent-1.18.0-Phase14D-Mobile-Fetch-Fix-Full-Source-1.zip` (uploaded handover baseline)  
**Review mode:** Source inspection, focused tests, static/browser implementation inspection, upstream research.  
**Code changes:** None. This review does not implement product features.

## 1. Executive assessment

TermAgent already has the right reusable core for the intended product: one provider-neutral agent loop, a typed tool registry, permission gate, session/event persistence, task manager, plugin/skill/MCP integration, context/repository intelligence, an HTTP adapter, a dependency-free client, and a browser projection. The right direction is to keep that engine and create a stronger boundary between the **control plane** (agent orchestration, provider credentials, authorization, sessions and durable events) and the **execution environment** (workspace file and process operations).

The most important immediate finding is not a visual defect. The reported Android browser approval failure has a confirmed server-runtime cause: `createRuntime()` constructs `PermissionGate` without setting a requester. The CLI explicitly injects `ui.requestPermission()` in `src/cli/repl.ts`, but the server does not. With no requester, `PermissionGate.check()` falls back to `askLegacy()`, which blocks on `process.stdin`. The Web View's `permission.resolve` command writes the durable decision to `SessionStore`; it does not settle that readline promise. Therefore the browser can show and persist an approval while the original tool call remains blocked until the terminal receives input.

A competing-runtime failure mode was also confirmed. `SessionEventBus` is process-local. A durable JSONL append from a second `SessionStore` instance is visible on disk and advances the sequence, but it does not wake a subscriber attached to the first instance's bus. A two-store executable probe produced `missed-wakeup` while the observing store read the incremented durable sequence. This shows why two independent runtime owners must not be allowed to write the same live session. The selected Option A single-daemon topology removes the need for a distributed event broker; daemon ownership and durable-cursor reconnect/reconciliation are the required controls.

The Web View also has measurable design-level sources of avoidable work, although no real latency numbers are available yet. Each refresh fans out into a snapshot, status and approximately six additional API reads. Many durable events schedule a refresh after 160 ms. Each live text/reasoning delta causes `renderFeed()` to reconstruct the entire transcript and assign `innerHTML`, including Markdown parsing for historical messages. On a phone, this is a likely dominant rendering/request amplification source. It needs instrumentation and targeted profiling rather than a guessed transport replacement.

Cloud readiness is the largest architectural gap. Shell execution currently inherits `process.env`; task workers and plugin hooks also inherit broad environment state. File tools apply path checks, but a shell is not constrained by those checks and there is no OS-level workspace sandbox. The server can bind beyond localhost without requiring a token, because authentication is optional and `authOk()` returns true when no token was configured. Those are blockers before public/cloud execution.

**Recommendation:** Reopen Phase 14 as an integration/reliability gate. First fix the server permission waiter, then secure remote access. The project owner has selected a single long-lived runtime daemon, so 14F must enforce one owner and attach terminal/browser as clients; it should not build a general cross-process event broker. Prove simultaneous client parity, durable replay/recovery and physical Android behavior, then measure performance. Keep HTTP/SSE. After Phase 14, execute the selected Phase 16 capabilities in dependency order. The Hermes-inspired Telegram owner companion is proposed for Phase 17, not immediate work. Do not begin Phase 18 until security, storage, execution-boundary and failure-recovery gates are audited.

## 2. What was inspected and what is authoritative

### 2.1 Supplied source snapshot

The latest supplied `Phase14D-Mobile-Fetch-Fix` archive was extracted into a scratch review directory. It contains `src/`, compiled `dist/`, tests, `web/app/`, `web/prototype/`, the Phase 14D report, research notes and project documentation. `package.json` reports:

- package: `@whoops-1/termagent`
- version: `1.18.0`
- Node requirement: `>=22`
- runtime: TypeScript/Node, with the local terminal experience retained
- production browser files included under `web/app`
- dependency-free public client/protocol package exports

The archive does **not** contain `.git`. It cannot establish branch, uncommitted changes, tag ancestry or the exact commit from which this archive was cut.

### 2.2 Git and public repository cross-check

A separately supplied older `TermAgent.zip` contains Git metadata at commit `127e23a21a4165cab3deb635323e716e4f63fa76` (`release: publish scoped npm package`) and reports `main...origin/main`. That snapshot is older and is not substituted for the Phase 14D archive.

Both accessible GitHub branches (`main` and `kilo/patient-stack-zu6`) were also cross-checked. Both package manifests still report 1.18.0; both branch lookups return 404 for `web/app/app.js`, and both server runtime revisions construct `PermissionGate` without `setRequester()`. The branches have different runtime/TODO blob revisions, but neither is an exact replacement for the fuller supplied Phase 14D archive. This public repository state is not a safe replacement for the uploaded source baseline.

**Authority rule for this review:** source-level findings below refer to the supplied Phase 14D archive. The public branch is only a cross-check. No files in the uploaded source archive or user's repository were overwritten.

### 2.3 Test/build evidence collected on the scratch copy

- `npm run build`: PASS.
- Focused Phase 14A–14D, permission and Phase 13N-F provider reliability set: **38/38 PASS**.
- Phase 13N-E LSP diagnostic state tests plus server HTTP/API test: **13/13 PASS**.
- Separate cross-store wakeup probe: durable sequence advanced, local subscriber did not wake. This is an observed negative result, not a timing benchmark.

The complete repository test suite was not used as a green gate in this review. The Phase 14D Chromium checks documented in `PHASE-14D-REPORT.md` use a deterministic fake-client fixture and desktop-host Chromium. They do not prove physical Android/Brave behavior or the full live-provider/server permission lifecycle. The prior mobile fetch receiver regression was fixed in the supplied archive, but that does not close the permission interaction issue.

## 3. Phase 14D permission approval: confirmed root cause

### 3.1 Current source path

1. `src/server/runtime.ts` creates a `SessionEventBus`, a `SessionStore`, a `PermissionGate`, and the `ToolRegistry`.
2. The gate is created with `new PermissionGate(..., store)` but no `setRequester()` call is made.
3. `src/tools/permissions.ts` persists the pending request with `appendPermissionAsked()`.
4. `PermissionGate.check()` selects `this.requester` when present; otherwise it invokes `askLegacy()`.
5. `askLegacy()` creates a readline interface over the configured input/output, defaulting to `process.stdin` and `process.stdout`.
6. The browser independently resolves the durable request through the `permission.resolve` API command in `src/server/api.ts`, which calls `runtime.store.resolvePermission(...)`.
7. That durable write does not complete the separate readline promise awaited by the original `PermissionGate.check()` call.

The CLI path proves the intended extension point exists: `src/cli/repl.ts` calls `gate.setRequester(request => ui.requestPermission(request))`. The server path has no browser-equivalent requester.

### 3.2 Required architecture correction

The server's requester must await the **same persisted interaction request** that the browser/terminal can resolve, rather than creating a second approval promise in the HTTP handler. A narrow adapter can use the existing `SessionStore.waitForInteractionResolution(sessionId, requestId, signal, timeout)` primitive. The gate maps the durable decision back into its existing once/always/deny semantics. The resolver must be installed before a permission request is exposed to a client, and the first accepted durable resolution must win.

This adapter must handle terminal/browser race, duplicate response, denial, cancellation, request timeout/expiry, stale UI, disconnect/reconnect and a session abort. It must fail closed if the request disappears, expires, changes kind or is cancelled. A browser disconnect must not cancel a valid pending interaction; a session abort must settle the waiter.

### 3.3 Regression tests required

- Real integration test: start a server-owned agent run, force a write/shell permission, resolve it through HTTP, and prove the **same original tool call** resumes without stdin input.
- Same test for deny, once, and always.
- Two clients resolve the same request concurrently; exactly one durable resolution is accepted and the gate observes that winner.
- Reject expired/stale IDs and wrong-session IDs.
- Cancel/abort while a request is pending; no tool side effect occurs after cancellation.
- Disconnect and reconnect the browser while permission is pending; pending state is rehydrated and can still be resolved.
- Server shutdown while a permission is pending; no false success or orphaned worker.

## 4. Multi-client synchronization and runtime ownership

### 4.1 Confirmed event-bus limitation

`src/session/event-bus.ts` is an in-memory map of subscribers per `SessionEventBus` instance. `SessionStore.appendCore()` appends the durable event to JSONL and calls only the bus attached to that `SessionStore` instance. It does not publish to other processes or bus instances.

`SessionStore.waitForInteractionResolution()` subscribes to the local bus and, when a bus exists, awaits `waitForChange()` without a periodic filesystem recheck. The 250 ms fallback is only used when there is no event bus. Under the accepted one-daemon topology, permission resolution and its waiter are owned by the same process, so this is not a normal cross-process interaction path. The owner lock must prevent external runtimes from attempting to resolve live interactions independently.

The HTTP SSE loop in `src/server/http.ts` subscribes to the daemon's local event bus and waits for that bus. Its 15-second heartbeat reports `currentSequence`, but the heartbeat path does not replay durable events. This is acceptable only when all live writes are made by the same daemon. Reconnects still need to replay from the durable cursor, and stale/second owners must be rejected.

A two-instance probe confirmed this behavior: store B appended a durable event to the shared session JSONL; store A's event-bus subscriber did not wake within the 250 ms probe window; store A nevertheless read the advanced sequence from disk. This characterizes what happens if two independent runtime owners are accidentally started. Under the accepted one-daemon topology, such competing live writers are unsupported and must be prevented by exclusive owner locking.

### 4.2 Existing protections worth retaining

- Durable JSONL session state is the recovery source of truth.
- Monotonic sequence assignment is protected by the state lease.
- `CommandLedger` provides command-id idempotency.
- Permission/question resolution uses first-writer-wins durable state.
- `SessionStore.beginTurn()` has a filesystem turn lease, protecting against two processes starting two turns for the same session.

These are meaningful foundations. The bus and durable sequence contract are suitable for a single daemon owner. The probe remains a regression guard against accidentally creating a competing owner; a distributed notification layer is not required under the selected topology.

### 4.3 Runtime parity gaps

`createRuntime()` keeps `activeControllers` in memory. This is acceptable when only the daemon owns live turns; it is not sufficient if a terminal CLI independently starts another Agent process. Therefore the CLI must attach to the daemon for shared sessions, and interrupt must be a canonical daemon command. A second process must not open another in-memory Agent/PermissionGate against the same session state.

The project owner has now selected **Option A: a single long-lived runtime daemon**. This resolves the topology choice. The daemon owns `activeControllers`, permission waiters, the `SessionStore` writer and event bus. Terminal and browser submit canonical commands to that owner. Phase 14F should implement exclusive ownership, endpoint discovery, CLI/client attachment, durable-cursor reconnect and owner recovery. It should not add cross-process bus notifications, Redis or another distributed broker unless multi-daemon operation is explicitly approved later.

## 5. Web View performance and mobile inspection

### 5.1 Request amplification

`web/app/app.js` `refreshCurrent()` loads session snapshot and status, then separately reads Todo, queue, context, diff, task list and checkpoints. Several durable event kinds trigger `scheduleRefresh()` after 160 ms. This means a burst of logically related events can create repeated groups of HTTP calls even when the event payload already contains enough information to update a local projection.

**Plan:** instrument API counts first; apply durable events directly to local projections where safe; coalesce refreshes per state revision; move expensive/infrequent data such as diff, task details and checkpoints behind their panels or explicit refresh triggers; add a compact summary endpoint only if measurement shows the fan-out is material.

### 5.2 Full transcript reconstruction on streaming deltas

`handleLiveEvent()` updates `state.liveText` / `state.liveReasoning` and calls `renderFeed()`. `renderFeed()` iterates the whole transcript, rebuilds tool cards and Markdown for historical messages, and replaces the full feed via `innerHTML`. If the provider emits many deltas, the browser repeats work proportional to transcript size for every chunk.

**Plan:** keep historical transcript DOM stable; update one live text node; batch appended delta updates with `requestAnimationFrame`; parse Markdown only after a message reaches durable completion or after a throttled interval; preserve tool cards keyed by event/message ID; consider bounded transcript virtualization only after profiling. Pause nonessential timers while `document.hidden` and recover from a durable cursor when visible.

### 5.3 Stream correctness/performance

- `res.write()` in the SSE helper ignores writable backpressure.
- The live-event buffer is bounded and adjacent text/reasoning chunks coalesce, but overflow drops the oldest live event without an explicit overflow/gap signal.
- Durable replay can reconstruct completed semantic state but cannot recreate every ephemeral token delta; a slow/disconnected client should be told that it missed live-only data and reconciled, not silently treated as perfectly up to date.
- Session selection performs snapshot/history work before it starts the new event stream. Durable cursor replay repairs persisted changes, but not the live-only interval. Reconcile with the server's authoritative snapshot and establish the event subscription before the UI advertises itself as current.
- Browser backgrounding, Android keyboard resize, network online/offline and visibility changes need explicit lifecycle tests.

### 5.4 No fabricated latency metrics

No request-to-ack, first-event, first-token, server-publish-to-browser, permission-click-to-resume, event-to-render, session-switch or cancellation timings are present in the baseline report. The screenshots and fake-client browser checks are not performance benchmarks. Actual timing numbers are therefore **unknown**.

A two-pass benchmark is required:

1. Add correlation IDs and low-overhead, bounded timing instrumentation, then record the unoptimized baseline on a documented host/device and network.
2. Apply one optimization at a time and rerun the same script, preserving environment, browser version, provider, model, prompt and repository size. Report p50/p95, sample count and raw run conditions.

Do not compare timestamps from the phone and server as one-way latency without clock-offset calibration. Use client monotonic durations for UI and round-trip operations, server monotonic durations for API/internal stages, and an explicit time-sync/uncertainty procedure for cross-host event delivery.

## 6. Security and cloud execution readiness

### 6.1 Optional server authentication

`src/index.ts` defaults `--serve` to `127.0.0.1`, which is the correct local default. But `--host` or `TERMAGENT_SERVER_HOST` can select `0.0.0.0` / `::`; `--token` is optional, and `authOk()` returns true when the token is absent. Therefore a non-loopback bind can expose mutating APIs without authentication.

**Required:** reject non-loopback bind unless the operator explicitly enables remote access and configures a supported authentication/pairing mode. Do not permit a warning-only path. Keep local mode simple and safe by default.

### 6.2 Pairing and API controls

A Phase 14E single-user first release can use short-lived one-time pairing codes exchanged for random, opaque, server-stored token credentials. Store only token hashes, attach device/client identity and scopes, and support expiry/revocation. Keep secrets out of query strings, static HTML, logs and persistent browser local storage. A secure HTTP-only cookie needs CSRF defenses; a header bearer token avoids ambient-cookie CSRF but still needs Origin/Host validation and a deliberate CORS policy. Protect state-changing endpoints, validate session/workspace scope, rate-limit pairing and authentication attempts, and emit audit events without transcript/tool secrets.

Origin validation, CSRF and DNS-rebinding defenses must be considered together with reverse-proxy/TLS configuration. Remote access should be explicit; a private tunnel/VPN can be the first low-friction operational boundary, but it does not replace application authorization.

### 6.3 Environment and sandbox isolation

- `src/tasks/shell-command.ts` supplies `env: process.env` to shell children.
- `src/tasks/manager.ts` spawns task workers with `{...process.env, TERMAGENT_TASK_ROOT, TERMAGENT_WORKER_TOKEN}`.
- `src/plugins/hooks.ts` likewise builds hook environments from `process.env`.

This is inappropriate for a cloud control plane that holds provider, GitHub, database and pairing secrets. A tool can print environment variables; a project dependency or shell command can exfiltrate inherited credentials. File-tool path checks are not an operating-system sandbox; Bash is unrestricted by that lexical path guard. MCP servers and plugins/hooks are also executable extension code and need an explicit trust boundary.

**Required before cloud execution:** introduce a strict environment allowlist for workspace processes (`PATH`, minimal home/temp/locale/terminal values and explicit workspace configuration only), keep provider keys in the control plane, use scoped/short-lived credential brokerage for Git operations, and run untrusted builds/tests/shell in a separate sandbox/workspace runtime. Apply filesystem, process, CPU, memory, disk, execution-time, output and network-egress limits. Avoid a shared host workspace accessible to sibling agents.

## 7. Capability audit: Phase 16

### 16A — LSP/code intelligence: selected, currently partial

Existing: `src/context/lsp-diagnostics.ts` provides a careful diagnostic state model (`unknown`, `running`, `provisional`, `clean`, `failed`, `timed_out`, `cancelled`) with quiescence/settle rules; `EvidenceLedger` carries bounded diagnostic evidence. The 13N-E tests pass 12/12.

Missing: LSP executable discovery/selection, JSON-RPC framing, `initialize`/`initialized` and shutdown lifecycle, document `didOpen`/`didChange`/`didClose`, position encoding, request cancellation, definition, references, hover and document/workspace symbol requests, process recovery and language-server resource management. The existing LSP research doc explicitly states these are non-goals of 13N-E.

Recommendation: build a provider-neutral per-workspace LSP manager and document synchronization layer, reuse the diagnostic tracker unchanged, and treat each language server as a resource with bounded memory/process/time and lifecycle cleanup. Prefer installed project tools; optional language-server packages should be declared per workspace image/template, never made mandatory for base TermAgent or ARMv7 local mode.

### 16B — Web tools: selected, no first-class agent tools found

The built-in tool registry does not expose general-purpose web search/fetch tools. Existing URL fetches in provider clients, plugin marketplace or skill-registry paths are not a safe user-agent network tool. Add explicit `web_search` and `web_fetch` capabilities only behind a network permission policy. A fetch policy must address scheme/port, redirects, all IPv4/IPv6 private/link-local/loopback/metadata ranges, DNS rebinding/TOCTOU, connection pinning, response size, time, MIME/content type, decompression, authentication leakage and prompt-injection boundaries. The official OWASP SSRF guide recommends allowlists where practical, network-layer restrictions and disabling/revalidating redirects; string/regex-only URL checks are not a sufficient boundary.

### 16C — Notebooks/structured documents: deferred

Keep the existing specification and architectural notes. No notebook editing work is scheduled in the current roadmap.

### 16D — Structural repository intelligence: selected, substantial foundation exists

Existing: `src/context/repository.ts` inventories files, caches per-file analyses, resolves local JS/TS and Python imports, derives file edges, computes a PageRank-like structural rank and uses a token-bounded map. `src/context/symbols.ts` extracts symbols/imports/references with regex for TypeScript/JavaScript and Python.

Limitations: references are lexical name appearances, not fully resolved AST/LSP references; language support in the analyzer is limited to TS/JS/Python; cache invalidation depends on path/size/mtime/ctime; graph edges/ranking are rebuilt in memory per map generation rather than stored as a versioned incremental graph; no cross-workspace dependency graph. This is useful v1 structure, not semantic code intelligence yet.

Recommendation: use content hashes to reuse file artifacts across branches, add parser adapters where they are lightweight/reliable, enrich dependency edges with LSP where available, persist graph artifacts by workspace revision and incrementally invalidate only affected nodes. Retain the lexical fallback and avoid a mandatory native Tree-sitter binary that would create Termux/ARM packaging trouble.

### 16E — Memory and project knowledge: selected, no structured cross-session knowledge store found

Existing: `TERMAGENT.md`/`AGENTS.md`/`CLAUDE.md` instruction loading, session history, context checkpoints, `EvidenceLedger`, exploration state and repository cache. These are not a unified cross-session project-knowledge store with provenance, source freshness and invalidation. Repository facts, user-provided instructions, inferred design decisions and transient session events must not be blended as equal-confidence memory.

Recommendation: add inspectable project knowledge records with type/source/provenance, workspace ID, originating file/commit/hash or user source, confidence/confirmation state, creation/update time and invalidation policy. Start with versioned JSONL/JSON in the project metadata store; no vector database initially. Support review, edit, delete, export/import and explain-why-this-fact-is-present. Optional semantic retrieval can be added only after real retrieval failure is measured.

### 16F — Provider protocol: selected, significant reliability base exists

Existing: provider-neutral `Provider.stream()` emits typed text, reasoning, tool-call, tool-result and done events; cancellation uses `AbortSignal`; Phase 13N-F implements retry/backoff, Retry-After, cancellation during backoff, idle-stream distinction and unsafe-partial-output replay suppression. Its documented focused set covers nine core regressions and the current Phase 13N-F suite passes.

Missing/unclear against the selected 16F scope: a formal provider capability descriptor, consistent structured-output contract, deterministic raw/normalized stream recorder/replay, exhaustive stable tool-call ID correlation across fragmented provider frames and stream resume semantics. Do not rewrite provider retry. Specify and test the missing contract first; add a recorder fixture at the normalized stream boundary and provider-specific adapters behind the existing interface.

## 8. External project research and architectural lessons

The companion research report contains the project-by-project comparison, links and source notes: `docs/research/TERMAGENT-PLATFORM-RESEARCH-2026-11-01.md`.

Key conclusions:

- **OpenCode:** strong reference for typed client/API, semantic session parts, server-side permission workflows and durable-vs-live event distinctions. Reuse concepts and endpoint semantics, not its frontend framework wholesale.
- **Cline:** the most useful direct permission-flow reference. Its current interaction coordinator creates a pending approval promise before publishing the request to the UI, then resolves that same promise when the UI responds; failed delivery denies safely. Its core/agents layering separates the stateless agent loop from persistence and host lifecycle.
- **Claude Code Remote Control:** proves a local coding session can be remotely steered from mobile while the local environment, filesystem and tools remain local. It validates the remote-control interaction model, not the need for a cloud execution environment.
- **OpenHands Agent Canvas:** its web interface is explicitly a projection and API client; it does not execute the agent or provide the sandbox. This matches TermAgent's target separation.
- **Coder Agents:** a particularly strong architectural reference for cloud execution: agent loop/control plane keeps LLM credentials, while workspace agents execute file/process operations through the same path as IDE/terminal access. It describes a durable chat store separate from workspace storage.
- **SWE-ReX:** useful execution-interface abstraction: one agent can target a local or remote runtime without changing its orchestration logic. Its Python implementation is a pattern reference, not a recommendation to add a Python backend.
- **Railway Sandboxes / Daytona / E2B:** Railway now also offers isolated on-demand Linux VM sandboxes, checkpoints/forks and SDK-driven command execution; this should be tested first because Railway is already the preferred control-plane candidate. Its sandbox is a separate VM primitive, not a reason to execute shell inside the service process. Daytona exposes process/filesystem/Git/LSP/PTY and persistent sandbox lifecycle; stable v0 and v2 alpha must be distinguished. E2B remains another microVM candidate. Compare isolation, private-network exposure, persistence, process APIs, quotas and cost before selecting.
- **Ona (formerly Gitpod):** closest product benchmark for browser/mobile cloud development environments and teams of autonomous software agents. It rebranded from Gitpod in September 2025.
- **Eclipse Che/Coder:** illustrate full Kubernetes-based CDE platforms. Powerful but operationally too heavy for TermAgent's first single-user cloud deployment.
- **Aider/Continue:** excellent repository-map and incremental indexing lessons. Aider uses graph-ranked repo-map context; Continue uses content-hash-addressed incremental codebase artifacts across branches.
- **Roo Code:** mode-specific agent/tool permissions and orchestration/delegation as reusable workflow ideas. Keep TermAgent's existing specialist/task model rather than add another engine.
- **SWE-agent:** its own docs state it is maintenance-only and superseded by mini-swe-agent; inspect SWE-ReX for execution boundaries rather than adopting old SWE-agent as a foundation.

## 9. Cloud Edition architecture recommendation (design only)

Keep the existing TypeScript TermAgent engine. Evolve the **execution adapter**, not the agent loop:

```text
                  TermAgent control plane
       Agent / provider / tools / policy / sessions
              /            |             \
         Terminal       Web View      API / SSE
               \           |           /
                 canonical session events
                           |
                 workspace execution API
                           |
          +----------------+----------------+
          |                                 |
     local adapter                    cloud adapter
     Termux filesystem                sandbox provider
     local spawn                      isolated VM/container
```

The existing `ToolRegistry` and built-in tool contracts should remain the agent-facing API. Filesystem, shell and process implementations should depend on an explicit `ExecutionEnvironment`/workspace interface that has a local adapter now and a sandbox-backed adapter later. Do not pass a Railway control-plane `cwd` path into a remote workspace and pretend it is the same filesystem.

For the initial cloud prototype, Railway is a plausible **control-plane and sandbox candidate**, but not an automatic security boundary for arbitrary processes inside the service. Current Free service allowance is up to 1 vCPU, 0.5 GB RAM and 0.5 GB volume, with $1 monthly resource credit after the one-time $5/30-day trial; the trial can be started without a card. Hobby is $5/month minimum with $5 usage credit and requires a card for the subscription. Railway now documents separate isolated Linux VM Sandboxes, available on all plans, with per-second VM billing; these may offer a simpler first workspace adapter than adding another vendor. However, sandbox networking can join the same Railway environment/private network, so egress and access to control-plane services must be tested and restricted. The Free sandbox allowance is small and the $1 monthly credit is not an unrestricted free workspace budget. If Railway Sandboxes do not meet isolation/persistence/quotas, compare Daytona or E2B. In every case, run untrusted commands outside the API service process.

Render Free spins down after 15 minutes idle, has ephemeral filesystem and no persistent disks/SSH/one-off jobs; free Postgres expires after 30 days. Vercel Functions have bounded execution duration (current docs list 300 seconds maximum on Hobby with fluid compute), making Vercel suitable for static frontend hosting but not the persistent agent/workspace owner. Pricing and limits change; re-check them before deployment.

Do not add Redis, Celery or microservices by default. A single control-plane service and a sandbox API are sufficient to begin if the execution contract is clean. The current JSONL store may remain a single-node persistence backend initially, but multi-replica operation will require a durable shared store and an explicit event/lease backend. Workspace files and session state should have separate backup/recovery lifecycles.

## 10. Revised roadmap and implementation sequence

### Gate 0 — establish trusted current state (no feature implementation)

- Retain the uploaded Phase 14D archive as the working code baseline until a current Git bundle/repository is available.
- Preserve the independent Git snapshot/public `main` as historical cross-checks, not replacements.
- Keep the current source tree untouched while this plan is reviewed.

### Phase 14E — secure remote interaction and repair the permission runtime

1. **14E.1 Permission resolver integration (P0):** connect the server PermissionGate to the durable pending-interaction waiter. Make the browser action settle the original tool-call promise. Add full lifecycle/race/cancel/expiry tests.
2. **14E.2 Pairing/authentication (P0):** require auth for remote binds, implement one-time pairing, revocable token records, expiration, client identity and scope, Origin/Host validation, CSRF as applicable, rate limits and audit trail.
3. **14E.3 Secret and API boundary (P0):** no provider secrets or raw environment values in browser state; scrub logs/errors; restrict workspace/session access and state-changing API scopes.
4. **14E.4 Remote security tests (P0):** unauthenticated, replay, expired/revoked, wrong scope, bad origin, CSRF, duplicate commands and pairing brute force.

**Acceptance:** browser approval resumes the original pending tool without terminal input; deny/once/always behave as configured; non-loopback binding without explicit secure configuration fails closed; revocation takes effect promptly.

### Phase 14F — true two-way terminal/browser runtime convergence

1. **14F.1 Cross-process durable event wake/replay:** keep JSONL as truth; add an inter-process wake mechanism with bounded replay fallback so independent server/CLI stores cannot miss durable commits. Handle subscriber slow-consumer/backpressure/overflow with explicit cursor-gap reconciliation.
2. **14F.2 Runtime command ownership:** make interrupt/cancel address the runtime currently holding the session turn lease; do not rely on process-local `activeControllers`. Preserve fencing/first-writer behavior.
3. **14F.3 State projection convergence:** prove messages, tool lifecycle, questions, permissions, tasks, Todo, queue, diffs, checkpoint, session metadata and run status converge.
4. **14F.4 Recovery tests:** disconnect/reconnect, process restart, pending approval, interrupted turn, duplicate command, two browser clients and browser+CLI simultaneous use.
5. **14F.5 Physical Android gate:** test current Brave/Chrome on the actual device with keyboard, viewport, orientation, background/foreground, offline/online and long transcript cases.

**Acceptance:** one authoritative turn owner; every connected client can observe and resolve shared interactions; missed durable events replay in order; cancellation reaches the owning runtime; restarts have explicit recover/restart/fail semantics.

### Phase 14 performance sub-gate (before any transport migration)

Add measurements for prompt acknowledgement, agent-start-to-first-event, provider-first-token-to-browser, tool start/result, permission click-to-resume, SSE publish-to-render, event-to-render, session switch and cancellation. Record p50/p95 and sample count. Then optimize request fan-out, incremental rendering, SSE backpressure, transient overflow signaling, visibility handling and reconnect reconciliation. Retain HTTP/SSE unless the measured bottleneck remains after this work.

### Phase 14G — optional WebSocket

**Deferred.** Do not implement. Reconsider only after measured HTTP/SSE performance shows a concrete capability/latency problem that cannot be fixed with batching, backpressure and reconnect improvements.

### Phase 15 — VS Code

**Discontinued as an active milestone / deferred indefinitely.** Preserve the canonical client, protocol and host-independent engine seams. No extension implementation or maintenance is scheduled until the browser/cloud roadmap has shipped and a clear requirement reopens it.

### Phase 16 — selected capability completion

Suggested order and dependencies:

1. **16B Web tools** (medium/high): after network permission/SSRF policy is specified. Add web_search/web_fetch, bounded extraction, provenance, domain decisions, DNS/IP pinning, redirect revalidation, content and output limits.
2. **16F Provider protocol maturity** (medium): preserve existing retry/cancellation; add capability metadata, structured-output contract, stable tool-call correlation and deterministic stream record/replay.
3. **16A LSP/code intelligence** (high): implement JSON-RPC transport and per-workspace server lifecycle/document sync; reuse diagnostic state tracker; add definition/reference/symbol commands and test on multiple languages.
4. **16D Structural repo intelligence** (high): add content-hash cache, persistent versioned dependency graph, parser adapters/fallbacks, import/reference resolution, graph-aware retrieval and incremental invalidation.
5. **16E Project knowledge/memory** (medium): use workspace-scoped, provenance-bearing facts/decisions built on existing session/context persistence; reversible review/edit/invalidate; no vector DB in v1.
6. **16C Notebooks** deferred, not part of acceptance.

The exact 16A vs 16B vs 16F sequence can be adjusted after the Phase 14 design review. The non-negotiable dependency is that 16B network access is gated by a safe network permission/SSRF design, and 16A/16D run against the same canonical workspace identity.

### Phase 17 — architecture cleanup

Retain as a later technical-debt phase. Avoid large file moves while 14E/14F interaction contracts are still changing. Refactor only when required to support the established stable seams.

### Phase 18 — TermAgent Cloud Edition (design only; not active)

- 18A Cloud runtime foundation: environment/config profiles, persistent control-plane store, health/monitoring, shutdown and recovery.
- 18B Workspace manager: GitHub import/clone, project identity, workspace metadata, project instructions and persistent filesystem lifecycle.
- 18C Remote execution: Linux sandbox adapter, language/tool images, process sessions, PTY, limits, isolation and egress policy.
- 18D Cloud control center: extend the existing mobile-first Web View with project/workspace selection, file browser/editor, terminal, Git changes and resource/task view.
- 18E Advanced agent roles: Coding/Research/Browser/DevOps/Project Manager workflows built from existing specialist agents and tool contracts.
- 18F Reliability: checkpoints, durable workspaces, task/session recovery, backups, observability, resource/cost budgets and failure drills.

**Phase 18 entry gate:** Phase 14 and selected 16 work are closed; local/cloud adapter parity is demonstrated; secrets are separated from execution; sandbox isolation and recovery are tested; storage/backup and hosting economics have been reviewed. Railway remains the preferred initial control-plane candidate and its newly documented VM Sandbox API should be included in the first sandbox proof-of-concept, then compared with Daytona/E2B/Coder-style options. Free-plan/no-card limits and sandbox network isolation must be verified before choosing.

The detailed source-file-level, testable, dependency-aware plan for every selected milestone is in `docs/research/TERMAGENT-IMPLEMENTATION-PLAN-2026-11-01.md`. It records existing implementation, target changes, likely source modules, dependencies, tests, acceptance, risks and complexity.

## 11. Earlier open decisions from the initial review (updated 2026-11-01)

1. **Runtime topology:** resolved. The project owner selected Option A, one long-lived daemon; see accepted ADR-019 and Section 12. The multiple-runtime/inter-process broker alternative is not active.
2. **Remote access boundary:** still open. Decide whether initial remote pairing also requires a private tunnel/access proxy or whether application pairing is sufficient for the private single-user deployment.
3. **Cloud sandbox:** still open. Compare Railway Sandboxes with Daytona/E2B; confirm whether self-hosted Coder/container infrastructure is a requirement.
4. **Persistence:** still open for the future Cloud Edition. Determine whether single-daemon JSONL on persistent storage is sufficient for the first private instance or whether PostgreSQL is required before cloud deployment.

These remaining decisions do not block the narrowly scoped Phase 14E.1 permission-resolver integration. No product implementation is started by this review.


## 12. Accepted runtime-owner decision and Hermes Agent findings (2026-11-01)

The project owner selected **Option A: one long-lived TermAgent runtime daemon**. This resolves the first item in the earlier open-decision list and supersedes any suggestion that Phase 14F should build a general cross-process event broker. ADR-019 is now accepted. The daemon is the single owner of Agent instances, active turn controllers, PermissionGate waiters, SessionStore writes, TaskManager workers, provider orchestration and the in-daemon event bus. Terminal and browser attach as clients; later Telegram transport is also owned by this daemon. Phase 14F now focuses on daemon lifecycle/owner lock, terminal client attachment, durable replay/recovery and physical Android parity. The earlier two-SessionStore missed-wakeup probe remains valid as a test proving that a competing runtime must not be started; it does not justify distributed infrastructure for the selected topology.

Hermes Agent was inspected at pinned revision [`a4994d4ead8f9c915b485cec5689909b349a49df`](https://github.com/NousResearch/hermes-agent/commit/a4994d4ead8f9c915b485cec5689909b349a49df). Its most important lesson for the proposed Telegram feature is separation of **agent execution from outbound messaging**: `tools/send_message_tool.py` explicitly keeps generic `send_message` out of the model-callable tool registry, while cron/CLI/notifier code reuse sender helpers. Its single messaging gateway, structured platform/chat/session routing, bounded per-chat concurrency, update identity, durable cron execution/delivery records, bounded curated memory, progressive-disclosure skills, isolated delegation and operational watchdogs are useful patterns. Detailed source paths, adopt/adapt/defer decisions and a TermAgent design are in `TERMAGENT-HERMES-AGENT-RESEARCH-2026-11-01.md`.

The recommended TermAgent feature is a **daemon-owned NotificationService with a durable outbox**, followed by a private single-owner Telegram adapter in Phase 17. Initial categories: opted-in run completion/failure, pending permission deep-links, meaningful opt-in milestones, owner-created scheduled reports and daemon degraded/recovered transitions. Do not emit one message per token/tool event. Do not expose arbitrary `send_message(target, text)` to ordinary agents or specialists. If a model-facing `notify_owner` capability is later approved, it has no destination argument and may create only a bounded owner notification intent under policy. Outbound delivery state must be independent of task completion and support pending/claimed/delivered/failed/delivery_unknown/cancelled, deduplication, rate limits, quiet hours, redaction and safe retries.

Telegram constraints verified against its official Bot API documentation: a bot cannot initiate a private conversation until the user first starts it; long polling and webhook are mutually exclusive; pending updates are retained for at most 24 hours; bot tokens are embedded in the Bot API HTTPS request path and must never appear in logs; and per-chat pacing/429 retry handling is required. The first feature should therefore be owner-only, explicitly paired, token-isolated and notifications-first. Inbound Telegram control commands are later and must route through the same canonical daemon command/PermissionGate contracts as browser and terminal. Sources: [Telegram Bots](https://core.telegram.org/bots), [Bot API](https://core.telegram.org/bots/api), [Bots FAQ](https://core.telegram.org/bots/faq), [Getting updates](https://core.telegram.org/bots/api#getting-updates).

ADR-021 records this as **Proposed**, not accepted, because the owner has asked for research and roadmap planning rather than authorizing Telegram implementation. Phase 17 is planned after Phase 14 and selected Phase 16. The immediate next implementation proposal remains Phase 14E.1: connect the server PermissionGate to the same durable interaction waiter so an HTTP/browser approval resolves the original tool-call promise.

### Remaining decisions (not blockers for Phase 14E.1)

1. For remote pairing, whether a private tunnel/access proxy is required in addition to TermAgent device pairing.
2. Whether the first future cloud sandbox proof-of-concept should be Railway Sandboxes compared directly with Daytona/E2B, or whether self-hosted Coder/container infrastructure is a hard requirement.
3. Whether a future multi-replica Cloud Edition needs PostgreSQL before deployment, or whether a single daemon plus durable JSONL on persistent storage is sufficient for the first private instance.

No TermAgent product implementation was changed in this follow-up research pass. The updated docs are planning artifacts only.


## 10. Phase 14E.1 follow-up — permission resolver defect closed

**Follow-up date:** 2026-11-01  
**Follow-up baseline:** the supplied `TermAgent-1.18.0-Phase14D-Hermes-Research-Checkpoint-Full-Source.zip` copy, as documented in `SOURCE-CHECKPOINT-2026-11-01.md`.

The confirmed Phase 14D failure described in Sections 1 and 3 was fixed in the Phase 14E.1 working copy. `src/server/runtime.ts` now installs a `PermissionGate` requester that awaits the canonical durable interaction state through `SessionStore.waitForInteractionResolution()`. The HTTP/browser resolver continues to commit through `SessionStore.resolvePermission()`. The runtime waiter re-reads the first-writer durable result and returns it to the original permission check awaited by the tool registry. Browser Allow/Once/Always can therefore release the original tool path; Deny prevents the tool side effect. The server-owned gate no longer routes this interaction through stdin.

Focused evidence: the new Phase 14E.1 suite passes 9/9, and the TypeScript build passes. It covers browser Allow/Deny, a new client instance rehydrating a pending request, first-writer races, stale/wrong-session behavior, Always, concurrent requests, abort/cancellation, graceful shutdown/restart reconstruction, timeout, and an approval/abort race. This does not prove physical Android/Brave behavior or a live-provider production session.

The original aggregate test warning remains: `tests/e2e-cli.test.mjs` fails the `/auto` completion assertion (`before\n` instead of `after\n`) on both the Phase 14E.1 work copy and the pristine checkpoint copy. The aggregate runner also exceeded its 240-second limit; no repository-wide pass is claimed.

This follow-up closes only the missing server permission requester. The selected single-runtime daemon is not yet fenced by an exclusive owner lease, and terminal/browser are not yet attached as clients of that daemon. A hard crash destroys the in-memory Agent continuation and may leave the durable request marked pending; orphan reconciliation is deferred until Phase 14F can prove that the prior owner is dead. Secure pairing, remote authorization, CSRF/Origin controls, rate limiting, and Android device validation remain open. See `docs/phases/PHASE14E1-PERMISSION-RESOLVER.md` and `docs/research/PHASE14E1-UPSTREAM-PERMISSION-RESOLVER-ADAPTATION.md`.
