# Phase 14E.1 upstream permission resolver adaptation

**Research date:** 2026-11-01

## Question

How do existing agent systems ensure that an approval arriving from a remote UI settles the *same* permission wait that is blocking the original tool call?

## OpenCode

Source reviewed: [`packages/opencode/src/permission/index.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts).

OpenCode maintains a pending permission entry with its request ID and a deferred result. The ask path publishes the request and awaits the deferred value. The reply path identifies the exact pending request and resolves or rejects that same deferred wait. Lifecycle finalization cleans up pending entries. The important property is request-identity correlation from the UI command back to the original suspended permission check.

## Cline

Source reviewed: [`sdk/packages/core/src/hub/server/handlers/approval-handlers.ts`](https://github.com/cline/cline/blob/main/sdk/packages/core/src/hub/server/handlers/approval-handlers.ts).

Cline's approval handler creates an approval ID, registers a pending resolver before surfacing the request, and resolves the matching approval when the UI responds. The entry is removed as part of resolution. Cancellation has a corresponding path for settling pending approvals rather than leaving their callers waiting indefinitely.

## OpenClaude

Source reviewed from the user-supplied `openclaude-main.zip`: `openclaude-main/src/grpc/server.ts`.

The gRPC server stores callbacks keyed by request/prompt identity. A remote approval response invokes the callback for that exact key and removes it. When the stream ends, pending requests are drained with a rejecting response. This is another direct example of response-to-original-wait correlation.

## Adaptation into TermAgent

TermAgent already persists permission asks and decisions as session events. `SessionStore.resolvePermission()` is session-scoped and first-writer-wins, while `SessionEventBus` notifies subscribers inside the owning runtime. `SessionStore.waitForInteractionResolution()` already provides the appropriate durable wait primitive.

The Phase 14E.1 implementation connects the server's `PermissionGate` to that existing wait primitive. The HTTP/browser layer commits the canonical command; the runtime waiter wakes and re-reads the durable event projection. No independent promise is created in the HTTP handler, and no second in-memory resolver map is introduced. This preserves TermAgent's existing durable source of truth and accepted single-daemon direction while delivering the same key invariant taught by upstream: a response resolves the original request that is waiting for it.

## Trade-offs and follow-on

The upstream in-memory maps are local to their owning process. TermAgent's event bus is also runtime-local; durable session events allow a reconnecting client to reconstruct state, but do not magically wake a second process's bus. The accepted Option A daemon topology therefore needs exclusive owner fencing in Phase 14F. A hard process crash also destroys the suspended Agent continuation; once owner fencing exists, startup can safely mark pending requests from a dead owner as interrupted. Until then, an eager orphan sweep would be unsafe.

The integration deliberately does not add a general event broker, WebSocket transport, or a separate permission service. Those changes are unnecessary for this bug and would duplicate ownership already present in TermAgent.
