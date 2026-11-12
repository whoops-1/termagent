# ADR-021: Runtime-owned notifications and Telegram owner companion

**Status:** Proposed, awaiting project-owner approval  
**Date:** 2026-11-01  
**Upstream research:** Hermes Agent, inspected revision `a4994d4ead8f9c915b485cec5689909b349a49df`; Telegram Bot API official documentation.

## Context

TermAgent is moving toward a 24/7 daemon/cloud runtime and needs a way to notify its owner when unattended work finishes, fails, needs attention or produces a scheduled report. Telegram is the selected first messaging channel under consideration.

Hermes provides a mature Telegram gateway and cross-channel delivery subsystem. Its `tools/send_message_tool.py` explicitly states that `send_message` is not registered as an agent-callable model tool because the agent must not fire cross-platform messages on its own. Scheduler, CLI and notifier surfaces use the underlying sender functions instead. Its cron subsystem also separates job execution from outbound delivery and records execution/delivery state independently.

Telegram imposes platform constraints: a bot cannot initiate a private conversation until the user has contacted it; Bot API requests carry the bot token in the HTTPS URL; long polling and webhook are mutually exclusive; updates are retained for at most 24 hours; and sending more than roughly one message per second to a single chat risks flood-control errors.

## Proposed decision

Add a daemon-owned **NotificationService + durable outbox + Telegram adapter** after Phase 14 and selected Phase 16 prerequisites. The first release is private owner-only delivery, not a general multi-platform messaging framework.

The service accepts bounded semantic notification intents tied to TermAgent run/task/session/runtime events. It owns policy, destination resolution, deduplication, secret redaction, throttling, quiet hours and delivery state. A model-facing `notify_owner` capability may be considered only if it has no recipient field, is restricted to the paired owner and is subject to category/rate policy. No generic `send_message(target, message)` tool is introduced.

The first channel is one paired private Telegram chat. Pairing is one-time, time-limited and rate-limited; the owner must first send `/start` to the bot. The bot token remains daemon-only and never enters browser JavaScript, prompts, shell environments or logs. Initial notification categories are completed/failed runs, required permission (with a Web View link rather than bypassing approval), opted-in milestones, scheduled reports and daemon degraded/recovered transitions.

The outbox must distinguish `pending`, `claimed`, `delivered`, `failed`, `delivery_unknown` and `cancelled`. A network timeout after Telegram may have accepted a message is `delivery_unknown`, not a blind retry. Use stable event/task/category dedupe keys, bounded retries, `retry_after`, per-chat pacing and message chunking.

Inbound Telegram control commands are a later milestone. They must route into the same daemon command API, session scope, command idempotency and `PermissionGate` interaction state. Telegram cannot create a second Agent runtime or bypass the canonical approval service.

## Consequences

- The TermAgent daemon owns the Telegram connection and notification delivery lifecycle.
- The same runtime can notify the owner regardless of whether a task was started from terminal or Web View.
- Notification delivery is separate from the agent's execution status and must not falsely imply task completion.
- The feature requires secure secret storage, token rotation/revocation, pairing and audit coverage.
- Telegram is one adapter; the service contract should remain platform-neutral without implementing many platforms now.
- A durable inbox cursor is required if inbound pairing/commands are enabled. In-memory update dedup alone is insufficient across daemon restarts.

## Alternatives rejected

- Exposing arbitrary Telegram `sendMessage` to every model/specialist: too much recipient freedom and notification-spam risk.
- Passing the bot token into the agent shell environment or browser: credential exposure.
- Implementing a parallel Telegram agent/bot engine: duplicates Agent and session orchestration.
- Sending a Telegram message for every token/tool event: rate-limit and alert-fatigue failure.
- Treating Telegram delivery as exactly-once: the Bot API does not give TermAgent a universal idempotency key for an ambiguous send timeout.

## Dependencies

Phase 14E secure authentication/pairing and permission resolution; Phase 14F single-daemon owner and terminal/browser parity; selected Phase 16 security/provider foundations; daemon lifecycle/secret-boundary review.

## Acceptance criteria for the future implementation phase

- Only the authenticated owner can pair and receive messages.
- Bot token never appears in browser state, prompts, child process environments, logs or notification payloads.
- Notification policy, user preferences, quiet hours and rate limits are inspectable and reversible.
- Task/run status and notification delivery status are separate and correct after restart.
- Duplicate source events do not create duplicate queued notifications.
- Delivery retry behavior distinguishes known failure from ambiguous outcome.
- Telegram inbound command, if enabled, maps to the same canonical command/session/permission state as the browser and terminal.
- The agent's ordinary tools and specialist agents cannot message arbitrary external destinations.
