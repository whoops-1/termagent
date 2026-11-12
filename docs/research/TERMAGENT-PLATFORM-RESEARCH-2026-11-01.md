# Comparative Research: Coding Agents, Remote Workspaces and Browser Control

**Research cut-off:** 2026-11-01  
**Purpose:** extract implementation patterns that can improve TermAgent without replacing its agent engine.  
**Method:** current official documentation, repository source inspection where accessible, architecture docs, release/maintenance notices and pricing pages. Findings below are not endorsements and should be revalidated before dependency/provider selection.

## 1. Executive synthesis

The strongest common pattern is a separation of concerns:

- an **agent/control plane** owns model/provider calls, agent loops, policies, canonical conversation state, permissions and durable events;
- a **workspace/execution plane** owns files, shell/processes, Git, builds, test execution and language tooling;
- clients are projections/adapters that issue canonical commands and consume canonical events;
- workspace and session lifecycles have distinct persistence, recovery and security controls.

TermAgent already has most of the agent/control-plane capabilities. Its immediate problems are interaction wiring and multi-process notification, not a need to adopt another agent framework. The largest future change is the execution boundary: current shell/worker processes inherit server environment and execute on the host, while the cloud target requires an isolated workspace service.

## 2. Coding agent engines

| Project | Architecture / stack | Execution and permissions | State, extensibility and remote shape | TermAgent lesson / avoid |
|---|---|---|---|---|
| **OpenCode** — https://github.com/anomalyco/opencode | TypeScript/Bun-oriented agent product with server, typed JS SDK, TUI and web UI; semantic session parts for text, tool, reasoning, diff, etc. | Server exposes session-scoped permission requests and explicit replies; permission decisions are represented as structured state rather than terminal text. | Typed API, durable session history/event contracts and independent client renderers. | Reuse typed semantic contracts, tool/permission lifecycle and client SDK ideas. Do not import Bun/OpenTUI/SolidJS or mirror upstream component names/branding. |
| **Aider** — https://github.com/Aider-AI/aider / https://aider.chat/docs/ | Python CLI pair-programming agent; repo-map based context selection; Git-aware workflow. | Runs local shell/Git actions through configured tools and human-in-the-loop approvals. | Repo map uses symbol/import relationships and graph rank to choose a bounded subset of repository context. | Strengthen TermAgent's current import graph and ranked token-budgeted map. Do not port the Python runtime or add a large parser dependency without validating ARM packaging. |
| **Continue** — https://github.com/continuedev/continue | TypeScript/Rust ecosystem for IDE and agent features; indexing components and editor integrations. | IDE-hosted actions and agent flows with extension/provider interfaces. | Indexing uses content-addressed cache keys and branch/workspace labels so unchanged file content can be reused across branches. | Adopt content hash artifacts and incremental invalidation for Phase 16D. Avoid adopting its entire editor/runtime architecture. |
| **Cline** — https://github.com/cline/cline | Layered shared/LLM/agents/core packages; current SDK has host adapters, persistent sessions and Hub/cloud integration. | `SdkInteractionCoordinator` keeps a pending approval resolver, publishes the UI request, then resolves that same promise on the user's reply; failed delivery denies rather than executing unseen. This is an unusually direct analogue for TermAgent's bug. | Agent loop is separated from stateful runtime/session persistence; Hub/cloud controllers reconcile snapshots, dedupe event IDs, track reconnect and unconfirmed queue/command outcomes. | Highest-value permission lifecycle reference. Copy the resolver ownership and host adapter patterns. Avoid transplanting the entire VS Code monorepo or cloud provider stack. |
| **Roo Code** — https://github.com/RooCodeInc/Roo-Code | VS Code agent with configurable modes (Code, Ask, Architect, Debug, Orchestrator) and mode-specific prompts/tool permissions. | Restricts tool groups and changes capability access by mode; orchestrator can delegate to subagents. | Task/mode and delegated agent workflow. | Use clear mode-specific policy and task delegation patterns with TermAgent's existing agents/tasks. Do not add another independent orchestration engine. |
| **SWE-agent / mini-SWE-agent** — https://github.com/SWE-agent/SWE-agent / https://github.com/SWE-agent/mini-swe-agent | Benchmark-focused autonomous software engineering agent family. | Uses SWE-ReX to interact with local or remote shell runtimes. | Current SWE-agent documentation says the project is maintenance-only and superseded by mini-swe-agent. SWE-ReX remains a reusable remote execution abstraction. | Study SWE-ReX's execution adapter. Do not choose the old SWE-agent engine as TermAgent's base. |
| **OpenHands** — https://github.com/All-Hands-AI/OpenHands | Agent server/backend, runtime/sandbox abstraction, browser/desktop-facing Agent Canvas; React/TypeScript UI. | Agent actions run through the Agent Server and sandbox/runtime, not directly in the Canvas browser code. | Conversation/session events are available through backend APIs; local, Docker and hosted/cloud runtimes exist. | Adopt the clean API/UI/runtime/sandbox boundaries. Do not replace TermAgent's current agent loop or introduce Python backend by default. |

### Cline approval flow: the most relevant source pattern

The current Cline `sdk-interaction-coordinator.ts` source registers the pending approval resolver before posting the UI state. The agent awaits that promise; a browser/host response settles it. It also rejects safely if delivery fails and explicitly tracks the awaiting-approval turn phase. This demonstrates the right shape for TermAgent:

`Tool -> PermissionGate -> persisted request + one resolver -> clients render -> one client response -> same resolver settles -> tool resumes`.

TermAgent currently splits the durable HTTP response from the PermissionGate's fallback readline wait. It should wire the two together rather than create another frontend-specific approval channel.

## 3. Cloud workspaces and execution systems

| Project | Workspace architecture | Lifecycle / isolation / access | TermAgent lesson / avoid |
|---|---|---|---|
| **Coder** — https://github.com/coder/coder | Self-hosted control plane provisions arbitrary workspace resources; workspace agent exposes process/file/SSH/port services. Current Coder Agents keep the agent loop and LLM provider calls in the control plane and dispatch file/process work through the same tunnel used by IDE/web terminal. | Workspace agent dials out to control plane; workspace can require no inbound ports or LLM credentials. Chat/session state persists in control plane, source files remain in workspace. | Excellent target architecture for secret separation and reusing one workspace path for agent, terminal and IDE. Avoid operating a full Terraform/Kubernetes Coder platform too early for a single-user product. |
| **Daytona** — https://github.com/daytonaio/daytona / https://www.daytona.io/docs/ | Sandbox API and Toolbox API; tools include filesystem, Git, process execution, PTY, logs and LSP. Container and Linux VM options exist in current stable docs. | Filesystem persists across stop/start; VM pause/resume can preserve memory/process state. Newer v2 documentation is explicitly alpha and describes Firecracker microVM isolation, per-sandbox kernel/filesystem/network and egress policy. | Strong candidate to evaluate as a managed workspace provider. Carefully distinguish stable v0 from v2 alpha before depending on features. Use its process/files/Git/LSP APIs, not its agent loop. |
| **E2B** — https://github.com/e2b-dev/E2B | Managed sandbox infrastructure for agents; API provides shell, filesystem, browser, networking, metrics and sandbox lifecycle. | Product describes one isolated microVM per agent session; pause/snapshot lifecycle and configurable egress. | Candidate for a secure per-workspace execution provider. Compare costs, persistence and network policy with Daytona before commitment. Keep TermAgent orchestration outside E2B. |
| **CodeSandbox Devboxes** — https://codesandbox.io/ | Cloud development environments/Devboxes with browser IDE and SDK entry points. | Relevant for remote dev environment lifecycle, template and preview experiences. The exact current production sandbox implementation and plan limits were not sufficiently verified in this research pass, so do not make a runtime security/technology decision from product marketing alone. | Include in a hands-on API trial and source/terms review. Do not assume Devbox is interchangeable with a secure untrusted-code sandbox without verifying boundary, process API, persistence, outbound network policy and pricing. |
| **Ona (formerly Gitpod)** — https://ona.com/ | Rebranded from Gitpod in September 2025; positions itself as mission control for autonomous SWE agents with sandboxed execution, browser VS Code and phone access. | Browser/mobile developer experience and agent/workspace lifecycle are close to the target product. | Best product/UX benchmark for cloud-first agent collaboration. Do not confuse product-level agent workflows with a reusable TermAgent runtime API. |
| **Eclipse Che** — https://eclipse.dev/che/ | Kubernetes-native CDE. Dashboard maps Devfiles to DevWorkspace CRs; operator reconciles pods, services, routes and persistent volumes. | Kubernetes RBAC, per-user namespaces/workspaces, PV-backed source and browser IDE. | Useful reference for reproducible devfiles and workspace lifecycle. Too operationally heavy for initial Railway single-user launch. |
| **OpenHands runtimes** — https://github.com/All-Hands-AI/OpenHands | AgentServer with Docker/local/remote/cloud execution providers. | Docker sandbox mounts the working repository and isolates agent commands; remote/hosted variants abstract workspace runtime. | Reuse the separation of AgentServer and runtime. Do not assume a bind-mounted container is a sufficiently strong hostile-code boundary for public multi-tenant cloud. |

## 4. Browser-based agent control and local-to-remote access

| Product/pattern | What it demonstrates | TermAgent implication |
|---|---|---|
| **Claude Code Remote Control** — https://code.claude.com/docs/en/remote-control | A local Claude Code session can be viewed/steered from phone or browser. Execution, filesystem, MCP and project configuration stay local to the machine running the session. | Remote control is a client/transport layer, not necessarily a cloud workspace. It validates mobile control and session attachment; TermAgent's cloud edition will additionally need remote Linux execution and persistence. |
| **OpenHands Agent Canvas** — https://github.com/OpenHands/OpenHands/blob/main/docs/architecture.md | The Canvas is a React/TS client that renders conversation, terminal, browser, files and settings and translates actions into Agent Server calls. It explicitly does not execute agent actions or provide sandbox isolation. | Keep `web/app` a presentation projection using `TermAgentClient`; move execution and authority out of the frontend. |
| **Cline Hub / SDK** — https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md | A daemon/Hub owns session state and routes client events/commands; CLI and editor hosts attach through typed clients. Cloud session controller reconciles snapshots and deduplicates events across reconnect. | Candidate reference if Phase14F chooses one runtime owner/daemon rather than separate runtime processes sharing local files. |
| **OpenCode server/Web UI** — https://github.com/anomalyco/opencode | Session-scoped events, typed HTTP client and permission reply APIs form a remote-control path. | Retain HTTP/SSE and client SDK semantics; extend replay/notification to cross-process instead of migrating transport prematurely. |

## 5. Remote event delivery and synchronization patterns

Patterns worth adopting:

1. **Separate durable and transient events.** Durable messages, tool lifecycle, permission resolution, question result, Todo, queue, task, checkpoint and diff updates are persisted with monotonic sequence. Token deltas, heartbeats and activity hints are transient. A reconnect replays durable sequence and reconciles an authoritative snapshot.
2. **Subscribe-before-replay.** Register the wakeup subscription before reading durable history so a commit between replay and tail cannot be lost.
3. **Use one resolver per pending interaction.** The owner awaits a pending promise/future; all clients are renderers of the same pending request; exactly one accepted reply settles it.
4. **Use idempotent command IDs and first-writer-wins.** A lost HTTP reply must not cause a duplicate execution; distinguish “not dispatched”, “accepted”, and “outcome unknown”.
5. **Treat slow consumers explicitly.** Bound transient buffers, coalesce adjacent text, honor `ServerResponse.write()` backpressure, signal when transient data was dropped, and reconcile durable state. Do not silently drop important durable events.
6. **Reconnect on a durable cursor.** Event IDs/sequences are an application-level recovery contract, not simply transport reconnection.
7. **Avoid giant whole-state events.** Cline's published changelog documents removing enormous transcript payloads from status updates after a process-memory incident. Stream bounded deltas and send snapshots only on attach/reconciliation.

TermAgent already implements much of this within one process. The missing layer is cross-process wakeup/command ownership and an end-to-end pending permission resolver.

## 6. Multi-agent execution patterns

- Cline's current SDK keeps core agent loop stateless relative to host persistence, while the Hub owns session coordination and cloud controllers track active sessions, approvals, pending inputs and reconnect state.
- Roo Code's Orchestrator mode delegates bounded work to subagents with specific modes/tool access.
- Coder Agents supports control-plane subagent orchestration while workspace operations are separately routed through a workspace daemon.
- OpenHands uses event-driven AgentServer/runtime boundaries and optional automation services.
- TermAgent already has `TaskManager`, child sessions, specialist/custom agents, background tasks and parallel-agent tools. Priority should be stronger lifecycle correlation, shared project context and workspace resource quotas, not adding a second delegation framework.

## 7. Hosting platform comparison (current published limits reviewed 2026-11-01)

### Railway — preferred initial control plane candidate, with caveats

Current published plan/docs indicate:

- Free: `$0/month`, after the one-time trial it provides `$1/month` credit, per-service maximum `1 vCPU / 0.5 GB RAM`, `0.5 GB` volume. The initial trial is `$5` for 30 days and advertises no credit card required.
- Hobby: `$5/month` minimum subscription with `$5` of monthly usage included; overage is billed. The paid subscription requires a credit card. Default max per service is much larger, but those maxima are ceilings, not free allocations.
- Regular service resource rates: approximately `$20/vCPU-month`, `$10/GB RAM-month`, `$0.15/GB volume-month`, `$0.05/GB egress` in the current pricing docs.
- Railway now exposes a separate Sandbox API for isolated Linux VMs used for coding agents, builds and untrusted code. Free allows up to 10 running/creating sandboxes per environment; the current Free sandbox default/maximum is 2 vCPU / 2 GB RAM. Sandbox VM use is metered separately at `$50/GB memory-month`, `$50/vCPU-month`, and `$0.05/GB egress`, metered per second. Memory remains billable while the VM is holding it; destroy/idle-timeout the sandbox when finished.
- Volumes are persistent service storage but size is limited by plan: Free/Trial 0.5 GB, Hobby 5 GB, Pro 50 GB default with paid resize options.

This can host an early control-plane experiment, but the 0.5 GB Free service and 0.5 GB volume are not an unrestricted build/Chromium workspace. The separate Sandbox VM product is now a credible first workspace adapter candidate: it gives a distinct VM process/filesystem boundary and is controlled via SDK/CLI. It is not free capacity at scale: after the one-time trial, the Free tier gives `$1` monthly resource credit; VM memory/CPU billing consumes it. Sandboxes can join the same Railway environment/private network as services/databases, so private-network reachability, egress, resource quotas and credential paths require explicit tests. Hobby is not a free plan and requires a card.

### Render — good preview, not an always-on persistent coding host on Free

Free web services spin down after 15 minutes without inbound traffic; wake-up takes about a minute. Their filesystem is ephemeral, free web services cannot attach persistent disks or get shell access/one-off jobs, and free Postgres databases expire after 30 days (1 GB). Useful for a preview web frontend; not suitable for the authoritative always-on agent and persistent workspace.

### Vercel — frontend hosting, not the agent/workspace owner

Current Function docs describe bounded maximum duration: 300 seconds on Hobby with fluid compute; functions are terminated at the duration limit. Hobby plan limits and quotas are designed for personal projects. Use for a static frontend only if desired; keep long-running agent sessions, process workers, persistent state and remote workspace execution in a persistent runtime.

### Candidate recommendation

For a controlled Phase 18 proof of concept:

- Railway control plane only (one instance while storage and runtime are single-writer).
- First evaluate Railway Sandboxes as the isolated workspace adapter because it uses a supported TypeScript SDK and avoids immediately adding a second infrastructure vendor. Verify that the sandbox cannot read control-plane secrets and that its private network/egress policy can be narrowed appropriately.
- Run the same contract tests against Daytona or E2B as alternatives; Daytona stable v0 persistence/Toolbox APIs and E2B microVM lifecycle may suit persistent developer workspaces better.
- Existing `web/app` served by the current TermAgent HTTP service or static-hosted with its API base URL configured securely.
- Keep provider secrets and session authority in control plane; workspace receives no model provider credentials.

Compare Coder if self-hosting and workspace networking control become primary; compare Ona if a complete cloud CDE/agent product is preferred over assembling a smaller service. Recheck pricing, free-tier eligibility, credit-card rules, retention, sandbox network reachability and abuse limits before committing.

## 8. Reusable libraries and protocols worth investigating

| Area | Candidate | Reason | Adoption stance |
|---|---|---|---|
| LSP | Official Language Server Protocol 3.17 JSON-RPC | Standard document synchronization and language features across servers. | Implement a small Node JSON-RPC transport/manager or reuse a maintained lightweight client; avoid a native runtime requirement. |
| Sandbox process/filesystem | Daytona Toolbox API; E2B SDK; Coder Workspace Agent API; SWE-ReX abstraction | Common file, process, logs, shell session and PTY contract. | Wrap behind TermAgent's own narrow `ExecutionEnvironment` interface. Do not let provider-specific types leak into Agent/ToolRegistry. |
| Durable event sync | HTTP SSE + monotonic cursor + replay endpoint | Simpler than WebSocket for server-to-client updates; browser SDK already supports custom auth headers. | Retain; add cross-process notify and durable replay fallback/backpressure. |
| Session/command state | Existing `CommandEnvelope`, `CommandLedger`, `SessionStore` | Already offers command idempotency and durable first-writer-wins interaction. | Reuse; add inter-process ownership/fencing and test cross-process semantics. |
| Repository indexing | Content-addressed cache / Merkle tree pattern (Continue); symbol graph rank (Aider) | Incremental reuse across branches, token-budgeted structural context. | Adapt into current `RepositoryMap`; no mandatory embeddings/vector DB. |
| Network security | OWASP SSRF guidance | Protects DNS, IP ranges, redirects and internal metadata/network endpoints. | Build in the HTTP request/connection layer, not only URL validation helpers. |
| Terminal browser UI | xterm.js | Mature browser terminal emulator if a true workspace terminal is added. | Evaluate only at Phase18D; existing TermAgent Web View remains the main UI. |
| Code editor | Monaco | Rich browser editor and code model; pairs with LSP. | Defer until workspace/file API and LSP semantics stabilize. |

## 9. What not to copy

- Do not copy a second agent loop from Coder/OpenHands/Cline into TermAgent.
- Do not bind untrusted shell processes to the control plane's `process.env` or workspace filesystem.
- Do not assume a UI state update is proof that the original permission future was resolved.
- Do not treat process-local in-memory EventBus notifications as cross-process delivery.
- Do not make WebSocket a reflexive replacement for SSE without measurements.
- Do not introduce Kubernetes/Coder/Che infrastructure for a single-user initial release unless workspace scale/isolation requirements justify the operations burden.
- Do not depend on a 30-day free database, ephemeral disk or short-lived function for durable agent sessions.
- Do not add Redis/Celery/vector databases merely because a competitor includes them.
- Do not import heavy native parsing libraries that break Termux/ARMv7 without an optional fallback.

## 10. Primary source list

### Coding agents and UI/runtime

- OpenCode repository: https://github.com/anomalyco/opencode
- OpenCode JS SDK docs: https://opencode.ai/docs/sdk/
- OpenCode permission API/source: https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/permission
- Cline SDK architecture: https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md
- Cline interaction coordinator: https://github.com/cline/cline/blob/main/apps/vscode/src/sdk/sdk-interaction-coordinator.ts
- Cline cloud controller: https://github.com/cline/cline/blob/main/sdk/packages/core/src/cloud/controller.ts
- Roo Code repository: https://github.com/RooCodeInc/Roo-Code
- Aider repository/docs: https://github.com/Aider-AI/aider and https://aider.chat/docs/
- Continue indexing: https://github.com/continuedev/continue/blob/main/core/indexing/README.md
- SWE-agent status: https://swe-agent.com/latest/usage/whats_next/
- SWE-ReX repository/docs: https://github.com/SWE-agent/SWE-ReX and https://swe-rex.com/latest/
- OpenHands architecture: https://github.com/OpenHands/OpenHands/blob/main/docs/architecture.md
- Claude Code Remote Control: https://code.claude.com/docs/en/remote-control

### Workspaces and cloud infrastructure

- Coder Agent architecture: https://coder.com/docs/ai-coder/agents/architecture
- Coder platform architecture: https://coder.com/docs/install/plan/architecture/
- Daytona sandbox docs: https://www.daytona.io/docs/en/linux-sandboxes/
- Daytona process execution: https://www.daytona.com/docs/process-execution
- Daytona isolation (v2 alpha): https://www.daytona.io/docs/en/v2/isolation/
- E2B: https://e2b.dev/
- CodeSandbox: https://codesandbox.io/
- Ona/Gitpod rebrand: https://ona.com/stories/gitpod-is-now-ona
- Eclipse Che architecture: https://eclipse.dev/che/docs/stable/discover/architecture-overview/
- OpenHands Docker sandbox: https://github.com/OpenHands/docs/blob/main/openhands/usage/sandboxes/docker.mdx

### Security and pricing

- OWASP SSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- Railway pricing: https://docs.railway.com/pricing/plans
- Railway trial: https://docs.railway.com/pricing/free-trial
- Railway volumes: https://docs.railway.com/volumes/reference
- Render free tier: https://render.com/docs/free
- Vercel function limits: https://vercel.com/docs/functions/limitations
- Vercel Hobby plan: https://vercel.com/docs/plans/hobby


### Technical blog / engineering write-up comparison

- **Coder, “Inside the Stack: Secure and Scale AI Coding Agents with Coder” (2026-07-08):** useful explanation of control-plane responsibilities, development workspace execution, Agent Firewall and AI Gateway; supports the split between control plane identity/secrets and execution workspace. https://coder.com/blog/inside-the-stack-secure-and-scale-ai-coding-agents-with-coder
- **Railway, “Use Agents in Railway Sandboxes” (updated 2026-10-29):** practical SDK-driven create/configure/checkpoint/fork/destroy loop for isolated Linux VMs, and an example fan-out to parallel sandbox agents. https://railway.com/guides/agents-in-sandboxes
- **Ona, “Gitpod is now Ona” (2025-09-02):** product-direction article positioning browser/mobile access and sandboxed autonomous software agents; useful as a UX/product benchmark rather than a low-level runtime design. https://ona.com/stories/gitpod-is-now-ona

## 11. Additional source-level verification notes (2026-11-01)

- **OpenCode event contracts:** its current v2 API explicitly labels the instance-wide `/api/event` subscription as volatile: slow consumers can overflow/fail the stream and disconnected periods are missed. This reinforces the distinction between a convenience/live broadcast and a session-scoped durable replay contract. TermAgent should keep its monotonic per-session cursor and snapshot reconciliation as truth, not replace them with an instance-wide firehose.
- **OpenCode permission future:** its permission implementation stores a pending request and a corresponding deferred/future; a reply succeeds/fails that original deferred and removes it from the pending map. This is the same essential invariant TermAgent is missing on the server path: browser resolution must settle the promise awaited by the tool's permission check.
- **Cline interaction coordinator:** the inspected `SdkInteractionCoordinator` registers its approval resolver before posting the approval surface, ties the pending resolver to the exact tool-call/message identity, clears that resolver on a response, and denies the request if publishing the UI request fails. Its cloud controller buffers/deduplicates events and reconciles snapshots after reconnect. These are source-level patterns, not a suggestion to import Cline's SDK or replace TermAgent's own engine.
- **Coder Agents:** current official docs explicitly state that the agent loop and provider credentials live in the control plane, while workspace operations are executed through the same workspace connection used by IDE/web terminal. Workspaces do not need LLM API keys. This is the strongest reference for a TermAgent `ExecutionEnvironment` boundary.
- **Railway current plan details:** Free is $0 with $1 monthly resource credit after a one-time $5/30-day trial, 1 vCPU/0.5 GB RAM and 0.5 GB service volume caps. Trial can be started without a card; Hobby is $5/month with $5 usage credit and the subscription requires a card. Railway Sandboxes are separate isolated Linux VMs with their own VM pricing and resource limits, so they are worth a proof-of-concept but are not unlimited free compute.
- **Vercel nuance:** with Fluid Compute, current Function maximum duration is 300 seconds on Hobby and up to 800 seconds on Pro/Enterprise; non-Fluid configurations have lower caps. This is still a bounded request execution model and is not a durable long-lived process/workspace owner.
- **Render Free:** services spin down after 15 minutes idle, take about a minute to wake, have ephemeral local filesystem and no free persistent disk; free Postgres expires after 30 days. This is unsuitable as the authoritative persistent agent/workspace runtime.

### Additional verified source URLs

- OpenCode v2 API event contract: https://dev.opencode.ai/v2/docs/api
- OpenCode permission deferred/resolution source: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/permission.ts
- Cline current interaction coordinator: https://github.com/cline/cline/blob/main/apps/vscode/src/sdk/sdk-interaction-coordinator.ts
- Cline cloud session controller: https://github.com/cline/cline/blob/main/sdk/packages/core/src/cloud/controller.ts
- Coder Agents security and workspace model: https://coder.com/docs/ai-coder/agents/getting-started
- Railway current pricing: https://railway.com/pricing
- Railway pricing plan ceilings: https://docs.railway.com/pricing/plans
- Railway free trial details: https://docs.railway.com/pricing/free-trial
- Railway no-card / payment FAQ: https://docs.railway.com/pricing/faqs
- Railway Sandboxes: https://docs.railway.com/sandboxes
- Railway agents-in-sandboxes engineering guide: https://railway.com/guides/agents-in-sandboxes
- Coder AI-stack architecture blog: https://coder.com/blog/inside-the-stack-secure-and-scale-ai-coding-agents-with-coder
- Render free service limitations: https://render.com/docs/free
- Vercel Function duration limits: https://vercel.com/docs/functions/limitations
- Daytona persistent sandbox lifecycle: https://www.daytona.io/docs/en/persistence/
- Daytona sandbox API / toolbox / LSP capabilities: https://www.daytona.io/docs/quickstart
- Ona's Gitpod rebrand: https://ona.com/stories/gitpod-is-now-ona
- Roo Code mode/tool-group permission behavior: https://github.com/RooCodeInc/Roo-Code/blob/main/apps/docs/docs/basic-usage/using-modes.md
- Aider repository map token/rank settings: https://github.com/Aider-AI/aider/blob/main/aider/website/docs/config/options.md
- Continue content-addressed codebase indexing: https://github.com/continuedev/continue/blob/main/core/indexing/README.md
- OpenHands Docker sandbox: https://github.com/OpenHands/docs/blob/main/openhands/usage/sandboxes/docker.mdx
