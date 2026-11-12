# Hermes Agent Research for TermAgent

**Research date:** 2026-11-01  
**Upstream repository:** [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)  
**Inspected upstream revision:** [`a4994d4ead8f9c915b485cec5689909b349a49df`](https://github.com/NousResearch/hermes-agent/commit/a4994d4ead8f9c915b485cec5689909b349a49df)  
**Research mode:** official Hermes documentation + source inspection of gateway, Telegram adapter, message sender, session router, scheduler, memory, skills, delegation and security modules.  
**TermAgent code changes:** none. This report informs roadmap/design only.

## 1. Executive summary

Hermes is relevant to TermAgent because it treats a long-running agent as a persistent service that can be reached from messaging surfaces, scheduled work and a local CLI. Its strongest transferable ideas are not a new model loop or another agent framework. They are the surrounding operational capabilities:

1. A **single long-lived messaging gateway** that owns platform connections, routes messages to persistent sessions, and delivers responses through the source channel.
2. A **Telegram adapter** with explicit authorization, per-chat session identity, command routing, busy-session handling, streaming updates, rate limits and reconnect logic.
3. A **separate notification/delivery path**. Importantly, Hermes' `send_message_tool.py` explicitly documents that `send_message` is *not* registered as an agent-callable model tool. Cron delivery, the CLI, notifier code and an opt-in MCP server use its sender helpers. The comment explains the safety intent: the agent must not fire cross-platform messages on its own.
4. A persistent **scheduler and execution ledger** that runs isolated agent sessions, records outcomes, supports delivery targets, and includes script-only jobs that do not invoke an LLM.
5. **Agent-curated bounded memory**, cross-session search, progressive-disclosure skills, constrained delegation and service health monitoring.

For TermAgent, the right adaptation is a runtime-owned notification and messaging subsystem attached to the existing engine. Do not port Hermes' Python `AIAgent`, provider stack, tools registry, CLI or orchestration loop. Keep TermAgent's `Agent`, `ToolRegistry`, `PermissionGate`, `SessionStore`, `TaskManager`, skills, plugins, MCP and provider adapters authoritative.

The recommended Telegram feature is a **private owner companion channel** first: the daemon sends opt-in progress, completion, failure, permission and scheduled-report notifications to one explicitly paired Telegram chat. Later, a separately gated inbound adapter can allow the owner to send commands to the same TermAgent daemon. Browser, terminal and Telegram must remain clients of one runtime, not three agents.

## 2. Upstream repository and source scope

The repository is [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). The source inspection was pinned to commit `a4994d4ead8f9c915b485cec5689909b349a49df` to make the observations reproducible. Official documentation is rolling documentation and may advance independently of that source revision.

Inspected implementation areas:

| Area | Inspected source / documentation | What it establishes |
|---|---|---|
| Gateway architecture | [`gateway/platforms/base.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/gateway/platforms/base.py), [`gateway/run.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/gateway/run.py), [Gateway internals](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/website/docs/developer-guide/gateway-internals.md) | One background gateway owns adapters and message routing; shared base adapter handles busy-session and delivery behavior. |
| Telegram | [`plugins/platforms/telegram/adapter.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/plugins/platforms/telegram/adapter.py), [`plugins/platforms/telegram/update_admission.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/plugins/platforms/telegram/update_admission.py), [Telegram setup](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram) | Telegram Bot API adapter; inbound update handling, outbound text/media, topics, command menu, polling/webhook configuration, dedup and authorization. |
| Session routing | [`gateway/session.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/gateway/session.py), [session lifecycle](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/website/docs/developer-guide/gateway-session-lifecycle.md) | Platform/chat/thread/user/profile are structured routing identity, not display-only metadata. |
| Outbound delivery | [`tools/send_message_tool.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/tools/send_message_tool.py), [`tools/send_message_senders.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/tools/send_message_senders.py) | Sender helpers are separate from the model tool registry; delivery has retries, target validation and redaction. |
| Cron and notifications | [`cron/scheduler.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/cron/scheduler.py), [`cron/scheduler_provider.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/cron/scheduler_provider.py), [`cron/scheduler_delivery.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/cron/scheduler_delivery.py), [Cron docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) | Scheduler trigger is separate from job execution and delivery; persistent jobs, attempt recovery and delivery states. |
| Memory | [Memory docs](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/website/docs/user-guide/features/memory.md) | Bounded USER/MEMORY stores, explicit writes, session search and memory safety controls. |
| Skills | [Skills docs](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/website/docs/user-guide/features/skills.md) | AgentSkills-compatible progressive disclosure and agent-maintained procedural knowledge. |
| Delegation | [`tools/delegate_tool.py`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/tools/delegate_tool.py), [Delegation docs](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/website/docs/user-guide/features/delegation.md), [`tools/AGENTS.md`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/tools/AGENTS.md) | Isolated child context, bounded concurrency, role/tool restrictions and structured output. |
| Security | [`SECURITY.md`](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/SECURITY.md), [Security docs](https://hermes-agent.nousresearch.com/docs/user-guide/security) | OS-level sandbox boundary, authorization, approval, credential scoping and explicit limits of in-process heuristics. |

The source code is Python and uses `python-telegram-bot` for the Telegram adapter. Hermes supports many messaging adapters, but TermAgent should not adopt its runtime language or dependency stack merely to implement Telegram delivery. Telegram's Bot API is HTTPS/JSON and can be integrated behind a small TypeScript adapter using the existing Node runtime and standard Fetch APIs.

## 3. Hermes gateway and Telegram architecture

### 3.1 One gateway process

Hermes describes its messaging gateway as a single background process connected to its configured platforms. Adapters normalize inbound platform events into a shared gateway session path; the gateway session store maps each source to a persistent conversation and the agent processes the turn. Cron and delivery also run under gateway-owned service lifecycle.

The important principle for TermAgent is **one runtime owner, multiple clients**. This aligns with the newly selected TermAgent Option A. Browser, terminal and Telegram must call the same daemon command and event services. A Telegram request must never instantiate a parallel Agent or a separate permission store.

### 3.2 Telegram inbound and outbound behavior

Hermes' Telegram adapter uses `python-telegram-bot` and implements more than a call to `sendMessage`:

- Long polling or webhook ingress.
- Text, media, voice, image and document handling.
- User/chat allowlists and authorization checks.
- Thread/forum-topic routing and reply anchors.
- Slash-command registration and menu prioritization.
- Busy-session handling, queued messages and explicit control-command interception.
- Inbound update admission/deduplication.
- Typing indicators and progressive streaming updates.
- Error classification, retry-after handling, delivery formatting and per-chat outbound pacing.

Hermes documents concurrent processing across different chats while keeping messages from the same chat sequential. Its adapter also suppresses repeated Telegram `update_id` values. At the inspected revision this particular admission cache is bounded and in-memory, so it is not an exactly-once guarantee across process restarts. TermAgent should adopt the per-chat ordering and update identity, but strengthen deduplication using a durable inbox cursor/ledger owned by the single daemon.

Hermes session routing uses a structured `SessionSource` including platform, chat ID, chat type, user ID, thread ID, scope/profile and message metadata. A session key is built through one canonical helper rather than hand-assembled by adapters. This is worth adopting if TermAgent later supports inbound Telegram prompts: map the paired Telegram identity to an explicit TermAgent session/route record and keep chat/topic/user identifiers separate from the session's display title.

### 3.3 Telegram authorization and pairing

Hermes supports user allowlists and pairing/authorization modes for messaging surfaces, with separate distinctions between administrators and ordinary users. Commands and capabilities may be allowed differently by role. Its docs also warn that storing bot credentials is separate from the gateway being connected.

TermAgent's first version should be narrower: one owner identity and one private chat, established by authenticated one-time pairing. Do not accept arbitrary chats or group traffic. If group support is introduced later, it needs an explicit group allowlist and command policy; a bot token alone must not authorize the sender.

### 3.4 Outbound messages are deliberately not a generic agent tool

This is one of the most important details in Hermes' implementation. `tools/send_message_tool.py` contains an explicit comment that `send_message` is intentionally **not** registered as an agent-callable model tool, because the agent must not fire cross-platform messages on its own. The reusable sender helpers are consumed by scheduled-task delivery, the `hermes send` CLI, a notifier and an opt-in MCP server.

Hermes therefore separates:

- agent work and its final result;
- platform delivery and routing;
- scheduler/notifier policy deciding when a result should be delivered.

TermAgent should preserve this separation rather than expose an unrestricted `send_message(target, message)` capability to every model call or specialist agent. The user still needs proactive notifications, so the proposed adaptation is a **runtime-owned notification intent/outbox**: the engine can request an owner notification for an allowed category, but the notification service owns destination, authorization, deduplication, quiet-hours/rate policy and delivery. There is no arbitrary `chat_id`/platform field in the model-facing request.

Suggested first-party notification categories:

- `run.completed` — requested work has finished and final summary is available.
- `run.failed` — work stopped with a useful error/verification summary.
- `permission.required` — an operation is waiting for the owner; the Telegram message links to the Web View rather than replacing the canonical permission interaction.
- `task.milestone` — opt-in milestones on a long task, coalesced and rate-limited.
- `scheduled.report` — output from a user-created scheduled job.
- `runtime.degraded` — daemon or integration health has crossed a defined threshold.

Never send raw environment variables, tool secrets, private file contents or unredacted command output through notifications. Sensitive approval details should remain behind the authenticated Web View; Telegram can notify and deep-link, not bypass the permission service.

## 4. Scheduled automation and reliable delivery

Hermes' cron subsystem is a particularly useful reference for a 24/7 TermAgent.

### 4.1 Scheduler/execution/delivery separation

Its `CronScheduler` provider decides *when* a job becomes due. Shared scheduler code owns execution and delivery; a provider does not reimplement the agent loop. The built-in gateway scheduler ticks periodically (documented as every 60 seconds), while alternative trigger providers can be plugged in.

The cron tools support one-shot and recurring jobs, pause/resume/edit/remove/manual trigger, stopping an in-flight run, optional skill injection and delivery targets. Runs execute in fresh sessions. `context_from` can pass a prior job's output to a later job without making all runs share one unbounded conversation.

### 4.2 Persistent attempts and recovery

The source separates job records, execution records and delivery state. Its docs describe durable fire identity, pre-dispatch validation, interrupted-run recovery, an execution ledger, file-lock/CAS claims and delivery handoff. A known result is not supposed to re-run just because delivery or the gateway was restarted. An ambiguous send that may already have reached the platform is not blindly retried as though exactly-once delivery existed.

This is directly useful for TermAgent. A future scheduler/outbox should distinguish:

`scheduled -> claimed -> running -> result_ready -> delivery_pending -> delivered`

with terminal outcomes such as `failed`, `blocked_config`, `delivery_failed` and `delivery_unknown`. The execution identity must be stable across restart. Delivery state must be independent from agent-run state.

### 4.3 Script-only jobs

Hermes supports no-agent scheduled jobs: a script runs, its stdout is delivered, no LLM/provider is involved, empty output can mean no alert, and errors become notifications. This is a strong pattern for health checks, disk/runtime alerts, simple HTTP checks and CI status polling. TermAgent should implement this only after secure workspace execution boundaries exist; do not run an untrusted user script as a privileged control-plane child.

### 4.4 External-event triggers

Hermes supports event-triggered cron jobs, where a webhook can fire a scheduled workflow immediately rather than wait for a clock tick. This could eventually support GitHub webhook notifications, build failures or PR review events. In TermAgent it must use authenticated webhook verification, deduplication and the same scheduler/job admission ledger.

## 5. Persistent memory and skills

### 5.1 Bounded memory model

Hermes separates agent notes (`MEMORY.md`) and user profile (`USER.md`), stores them independently, bounds their size, and loads a frozen prompt snapshot at session start. The agent changes memory through explicit add/patch/remove operations. It also offers cross-session full-text search through SQLite FTS5. Memory writes can be staged for approval, and content is scanned because stored memory re-enters future prompts.

Useful adaptations:

- Keep personal preferences, stable environment details and project knowledge separate.
- Add/patch/remove operations instead of free-form rewriting.
- Explicit size budgets and inspectable memory state.
- Search historical sessions rather than stuffing entire transcripts into prompts.
- Scan memory for prompt-injection/exfiltration patterns and keep provenance.

What not to copy literally: Hermes' character-limited two-file memory is a personal-agent model, not sufficient for TermAgent's multi-project knowledge. TermAgent's selected 16E plan should retain richer records with source path/commit/hash, confidence, timestamps and invalidation. Hermes' own docs warn that multiple processes writing the same home can compound memory changes; the single-runtime-daemon decision avoids multiple concurrent TermAgent memory writers.

### 5.2 Skills as procedural memory

Hermes uses an AgentSkills-compatible progressive-disclosure approach: short descriptors are discoverable, full instructions load when the skill is selected. Skills can be installed externally or created/updated by the agent, and can carry setup requirements. This fits TermAgent's existing skills registry and marketplace. The importable lesson is the progressive-disclosure and reusable-workflow pattern, not a replacement skill framework.

Autonomous skill self-improvement should be guarded: a candidate skill change should be recorded as a proposed patch with provenance, tested in a constrained environment, and reviewable/approvable before it becomes active. Do not allow a background agent to silently rewrite security-critical skills or tool permissions.

## 6. Delegation, hooks and operational health

### 6.1 Delegation

Hermes delegates to child agents with fresh isolated conversation context, a provided goal/context package, bounded concurrency/depth, role-dependent tool access and optional JSON output schemas. Its leaf role cannot recursively delegate or access selected control tools. This complements TermAgent's existing specialist agents and role-specific permission intersections.

Import patterns only:

- require explicit context handoff; children do not magically inherit a complete parent transcript;
- separate parent/child task ownership and cancellation;
- bounded queues/concurrency and delegation depth;
- child toolsets narrower than or equal to the parent;
- validate structured outputs before merging results;
- record child result provenance in parent task state.

Do not import Hermes' subagent framework or duplicate TermAgent specialist orchestration.

### 6.2 Event hooks

Hermes has lifecycle hooks for platform events, command handling and tool execution. TermAgent already has plugin hooks and task/session events, so this is not a reason to create another extension system. The lesson is to use well-defined, versioned event hooks with explicit observer vs mutator semantics, timeout bounds and a narrow data contract. Hooks that can change execution should be treated as trusted code.

### 6.3 Gateway liveness and recovery

Hermes documents gateway heartbeat state, a scheduler-health status, event-loop liveness watchdogs and supervised restart behavior. For TermAgent's future daemon, adopt:

- process identity and single-owner lock;
- health endpoint including runtime-owner and scheduler heartbeat;
- degraded status distinct from healthy-but-disconnected Telegram;
- graceful shutdown with bounded agent/task settlement;
- supervisor restart and explicit interrupted-turn recovery;
- stale heartbeat alerts;
- one-time transition notifications to avoid alert storms.

A Telegram bot's profile description may be used as a convenience signal, but Hermes' own docs note that bots have no normal online/offline presence dot and that a profile description is a global, last-known indicator, not a reliable health API. TermAgent health must come from its daemon endpoint/state, not cosmetic Telegram status.

## 7. Telegram Bot API constraints for TermAgent

The platform's current official documentation establishes several constraints that must shape the design:

1. **A bot cannot initiate a private conversation.** The owner must first open the bot and send `/start` (or add it to a group); TermAgent cannot send the first DM to an untouched account. Sources: [Telegram Bots intro](https://core.telegram.org/bots), [Bot tutorial](https://core.telegram.org/bots/tutorial).
2. **Bot API calls are HTTPS requests authenticated by the bot token.** The token is part of the API URL path, so request URLs must never be logged or exposed in diagnostics. Source: [Bot API](https://core.telegram.org/bots/api).
3. **Inbound updates use either `getUpdates` long polling or `setWebhook`, not both concurrently.** Updates are retained by Telegram for no longer than 24 hours. Sources: [Bot FAQ](https://core.telegram.org/bots/faq), [Webhook guide](https://core.telegram.org/bots/webhooks).
4. **Outbound rate limits exist.** Telegram's FAQ recommends avoiding more than one message per second in a single chat; excessive sends can result in 429 errors. Respect `retry_after` when provided and coalesce updates instead of sending one Telegram message per token. Source: [Bot FAQ](https://core.telegram.org/bots/faq).
5. **Text messages are bounded.** Telegram's send-message text limit is 1–4096 characters after entity parsing; longer responses need safe chunking or a document attachment. Source: [Bot tutorial](https://core.telegram.org/bots/tutorial).

For a private single-user daemon, long polling is the simplest initial inbound pairing/control option and does not require a public webhook endpoint. A public cloud deployment may later prefer webhook delivery for lower inbound latency, but it adds a public ingress path, HTTPS requirement and secret-token validation. The implementation must configure exactly one mode and persist update identity/offset. The Telegram API's update retention is not durable application storage, so TermAgent must persist its own inbox cursor/admission result.

## 8. Proposed TermAgent Telegram Companion design

### 8.1 Scope of the first release

Initial capability: **outbound owner notifications plus secure one-time chat pairing**. Do not start with multi-user, group chat, general-purpose cross-channel messaging or multiple independent bot personalities.

Pairing flow:

1. Owner enables Telegram from the authenticated Web View or local CLI.
2. The daemon creates a random, short-lived, single-use pairing code bound to the current owner account/runtime.
3. Owner sends `/start` and `/pair <code>` to the bot.
4. The daemon checks code expiry, attempt limits and update identity, then binds the Telegram sender/chat IDs to the owner.
5. The owner confirms the pairing in the authenticated TermAgent client (or the configured explicit owner Telegram ID is matched), and the pairing code is consumed.
6. Bot token and paired identifiers remain in daemon-managed secret/config storage; the browser never receives the token.

The exact confirmation UX is a design choice for the implementation milestone. A code by itself must be short-lived, single-use, rate-limited and scoped; possession of an unexpired code must not silently grant access to a broad runtime API.

### 8.2 One daemon, one owner notification route

```text
                    TermAgent Daemon
       +------------------------------------------+
       | Agent / ToolRegistry / PermissionGate    |
       | SessionStore / TaskManager / EventBus    |
       | Scheduler (later) / NotificationService |
       | Telegram adapter + durable inbox/outbox  |
       +----------------------+-------------------+
                              |
             +----------------+----------------+
             |                |                |
         HTTP/SSE         Local IPC         Telegram Bot API
          Browser        Terminal client     Paired owner
```

The Telegram adapter is a transport adapter. It does not own an Agent, session history or permission ledger. Telegram-originated control operations, once added, must become canonical commands to the daemon.

### 8.3 Notification service and outbox

Proposed notification envelope:

```ts
interface NotificationIntent {
  id: string
  dedupeKey: string
  category: 'run.completed' | 'run.failed' | 'permission.required'
          | 'task.milestone' | 'scheduled.report' | 'runtime.degraded'
  sessionId?: string
  taskId?: string
  sourceEventId?: string
  importance: 'normal' | 'important' | 'critical'
  summary: string
  createdAt: number
}
```

The notification service decides whether a category is enabled and allowed. It resolves the paired owner destination, redacts secrets, rate-limits, coalesces low-value progress, records an outbox row and delegates to the Telegram adapter. A model-facing `notify_owner` intent, if approved, has no destination parameter and can only create a notification for the paired owner; it cannot send to arbitrary Telegram chats or other platforms.

Outbox lifecycle should include `pending`, `claimed`, `delivered`, `failed`, `delivery_unknown` and `cancelled`. Use a stable dedupe key derived from source event/task/category. Retry only failures known not to have delivered; if a request times out after the Telegram server may have accepted it, record `delivery_unknown` rather than blindly duplicating the message. Respect Telegram `retry_after`, per-chat pacing and message length constraints.

### 8.4 Default notification policy

Start conservative and configurable:

| Event | Default policy | Reason |
|---|---|---|
| Task completed | Enabled for tasks explicitly marked notify | Useful for unattended work. |
| Task failed / verification failed | Enabled | Failure must not silently disappear. |
| Permission required | Enabled, with Web View deep-link | Owner can return to the canonical approval UI. |
| Every token/tool step | Disabled | Spam and Telegram rate limits; activity belongs in Web View. |
| Long-task milestone | Opt-in, coalesced (e.g. only meaningful milestone transitions) | Keep progress useful rather than noisy. |
| Runtime degraded/recovered | Enabled on state transition, deduplicated | 24/7 service observability. |
| Scheduled report | Enabled only for an owner-created schedule | User explicitly requested delivery. |

Quiet hours, per-project subscriptions and critical-alert bypass can be added with user-owned settings. Do not permit unbounded autonomous messaging.

### 8.5 Inbound command scope (later, not first slice)

After pairing and authorization are proven, consider a limited owner command set: `/status`, `/sessions`, `/stop`, `/resume`, `/approve`, `/deny`, `/new`, and a normal prompt command. Every operation must route through the canonical command API, enforce the same session scope and idempotency as the Web View, and append normal durable events. Permission approval through Telegram must resolve the original pending `PermissionGate` waiter; it must not create a Telegram-specific approval executor.

A message sent to the bot must not create an independent agent conversation unless it is explicitly mapped to a TermAgent session. While a run is busy, new prompts should follow the same durable queue/steer/interrupt policy already defined by TermAgent, not Telegram-specific ad hoc behavior.

## 9. What TermAgent should import, adapt or avoid

| Hermes feature/pattern | Decision | TermAgent adaptation |
|---|---|---|
| Single persistent messaging gateway | **ADOPT** | Use the selected single TermAgent daemon; adapters are clients/transports, not agent runtimes. |
| Telegram adapter | **ADAPT** | TypeScript Bot API adapter behind daemon notification/inbound interfaces; no Python Telegram dependency. |
| User allowlist/pairing and role authorization | **ADOPT** | Start with one owner and one private chat; scoped pairing and explicit revocation. |
| Per-chat session routing | **ADAPT** | Map a paired Telegram route to canonical TermAgent session IDs; preserve user/chat/thread identity separately. |
| Busy-session queue/control interception | **ADAPT** | Reuse TermAgent prompt queue, task/session and interruption contracts. |
| Streaming edits and typing indicators | **ADAPT** | Optional Telegram status card updates, throttled/coalesced; never token-per-message. |
| Generic `send_message` model tool | **DO NOT COPY** | Hermes deliberately withholds it from the model. Use runtime notification intents and an owner-only destination policy. |
| Durable scheduled jobs and execution ledger | **ADOPT LATER** | Build on TermAgent TaskManager/SessionStore with stable run identity, restart recovery and independent delivery ledger. |
| Script-only/no-agent scheduled jobs | **ADAPT LATER** | Use for simple health checks after workspace execution is isolated; no LLM call where none is needed. |
| Bounded memory, explicit add/patch/remove | **ADAPT** | Retain the richer Phase16E provenance/freshness model; no unbounded prompt dump. |
| Skills progressive disclosure | **ADOPT** | Reuse existing TermAgent skills registry and AgentSkills conventions; keep security review and install trust controls. |
| Automatic skill self-improvement | **GUARD** | Generate reviewable/tested patches; don't silently activate changes to trusted/security skills. |
| Isolated bounded delegation and structured child output | **ADAPT** | TermAgent already has specialist workers; enforce role, tool and workspace scopes. |
| Large multi-platform adapter catalog / Bot Mode | **DEFER** | Telegram owner companion is enough for initial cloud operations. |
| Gateway health heartbeat and watchdog | **ADOPT** | Runtime daemon heartbeat/degraded state, process supervision and restart-safe task recovery. |
| Arbitrary gateway plugin hooks | **DEFER/GUARD** | Reuse existing plugin lifecycle only with bounded, typed and trusted hooks. |

## 10. Dependencies and implementation order

Telegram must not be used to bypass the unfinished Phase 14 interaction/security work. Recommended order:

1. **Phase 14E.1:** fix the original server permission promise and add end-to-end tests.
2. **Phase 14E.2:** close remote auth, pairing/token scopes, Origin/CSRF and fail-closed bind behavior.
3. **Phase 14F:** implement the selected single runtime daemon and attach terminal/browser clients to it; prove command, event, permission, cancellation and recovery parity.
4. **Phase 14 performance/mobile gate:** instrument and optimize SSE, UI and real-device behavior.
5. **Selected Phase 16:** secure web tools, provider protocol, LSP, repository graph and project memory.
6. **Phase 17:** daemon runtime-service cleanup, notification/outbox, Telegram owner companion, then scheduled/event-triggered automation and optional inbound commands.
7. **Phase 18:** cloud workspace execution and deployment only after readiness audit.

Phase 17 is not authorized to start in this research pass. The immediate next implementation proposal remains Phase 14E.1.

## 11. Risks and non-goals

- Telegram bot token compromise gives control over the bot; never expose it to the browser, model prompt, shell process or logs.
- Telegram bots cannot send the first private DM. Owner must start the bot before delivery works.
- Bot API delivery cannot provide a universal exactly-once guarantee after ambiguous network failures. Preserve `delivery_unknown` rather than making false claims.
- A bot token does not prove the sender is the owner. Pairing and sender authorization are required for inbound commands.
- Frequent progress updates will hit Telegram limits and annoy the owner. Coalesce at meaningful state transitions.
- Webhook mode introduces a public inbound endpoint and signature/secret validation. Long polling is simpler for the first private daemon but has 24-hour update retention.
- The agent should not send arbitrary messages to arbitrary chat IDs; first version is owner-only and category-limited.
- Notifications are not an execution isolation boundary. A successful Telegram send says nothing about whether the agent's workspace was sandboxed.

## 12. References

### Hermes source and official docs

- Repository: https://github.com/NousResearch/hermes-agent
- Inspected revision: https://github.com/NousResearch/hermes-agent/commit/a4994d4ead8f9c915b485cec5689909b349a49df
- Gateway internals: https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/website/docs/developer-guide/gateway-internals.md
- Telegram adapter: https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/plugins/platforms/telegram/adapter.py
- Telegram documentation: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram
- Messaging architecture: https://hermes-agent.nousresearch.com/docs/user-guide/messaging
- Outbound sender: https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/tools/send_message_tool.py
- Cron scheduler internals: https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/website/docs/developer-guide/cron-internals.md
- Cron documentation: https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
- Memory documentation: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- Skills documentation: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- Delegation documentation: https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- Security policy: https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/SECURITY.md

### Telegram official docs

- Bots introduction: https://core.telegram.org/bots
- Bot API: https://core.telegram.org/bots/api
- Bot FAQ: https://core.telegram.org/bots/faq
- Bot tutorial: https://core.telegram.org/bots/tutorial
- Webhook guide: https://core.telegram.org/bots/webhooks
