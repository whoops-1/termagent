# Phase 14E — Security, pairing, and remote access

**Implementation date:** 2026-11-01  
**Status:** Implemented; automated host-side security gate passes. Physical Android/Brave and production-network validation remain open.

## Scope

Phase 14E closes the security boundary around the Phase 14D Web View and incorporates the separately completed Phase 14E.1 permission-resolver integration. It does not introduce the Phase 14F single-runtime daemon or cross-process ownership model.

The existing `src/server/http.ts` remains the transport boundary. The new `src/server/security.ts` owns device credentials, pairing-code lifecycle, device records, persistence, expiry, revocation, and security audit records. Session and task authorization continues through the existing `createApi()` workspace checks and canonical command ledger.

## Deployment modes

### Local default

`termagent --serve` binds to `127.0.0.1:4096` by default. Local loopback access remains the default mode. Non-loopback binds are rejected unless `--allow-remote` and the required authenticated TLS configuration are explicitly supplied.

A legacy static bearer token remains available for loopback-only compatibility. It cannot be combined with device pairing and cannot be used for direct remote binds.

### Reverse proxy terminates TLS

Bind TermAgent to loopback and declare the public HTTPS origin:

```sh
termagent --serve \
  --host 127.0.0.1 \
  --port 4096 \
  --require-pairing \
  --public-origin https://agent.example.com
```

The reverse proxy must terminate HTTPS, keep the upstream listener private, and preserve the original public `Host` header. TermAgent validates that Host against the configured origin and validates browser Origin against the exact configured HTTPS origin. It does not trust `X-Forwarded-For`, `X-Forwarded-Host`, or other forwarding headers for authorization or rate-limit identity. Configure corresponding request limits at the proxy because proxied clients share the upstream peer address from TermAgent's perspective.

### TermAgent terminates TLS directly

```sh
chmod 600 ./server.key
termagent --serve \
  --host 0.0.0.0 \
  --port 4096 \
  --allow-remote \
  --tls-cert ./server.crt \
  --tls-key ./server.key \
  --public-origin https://agent.example.com
```

Both certificate and key are required. The private key must not be group/world-readable. Remote mode without TLS and an explicit HTTPS public origin fails closed. Direct TLS listener behavior is covered by an automated self-signed-certificate smoke test; the certificate used by that test is not a production certificate.

## Pairing and device credentials

- Startup creates a random one-time pairing code with a five-minute lifetime. The code is printed only to the owner-controlled server terminal and is never returned by an unauthenticated discovery endpoint.
- `POST /api/v1/pair` exchanges the code for an opaque 256-bit random device bearer token. The code is single-use and rotates after successful redemption or expiry.
- Pairing attempts are bounded per source and per active code. The device count is capped at 32.
- Device tokens expire after 30 days by default. Their raw values are returned only once and held by the browser in memory; browser local/session storage and URL query parameters are not used.
- Only SHA-256 token hashes are persisted. Auth state is workspace-specific, written atomically, with a `0700` parent directory and `0600` state file.
- Device records have immutable device IDs and server-assigned workspace scopes. Authenticated command envelopes use the device ID as `clientId`; a browser cannot impersonate another client by supplying a body/header ID.
- `GET /api/v1/device` returns the current device's safe metadata. `POST /api/v1/device/revoke` revokes that device. Revocation is persisted and checked at each request boundary; active SSE and prompt streams revalidate periodically and close/abort after revocation or expiry.
- Safe audit records are retained for pairing, revocation, and pairing lockout events. Raw credentials and token hashes are not included in device API responses or logs.

The current browser surface supports self-revocation. An owner-facing remote device inventory/revoke-other-device UI is not included in this slice; for a lost device, stop the server and remove that device's record from the owner-controlled auth-state file before restarting. Do not edit the file while the server is running because the live store is process-owned.

## Authorization boundary

Device access is scoped to the workspace root used to start the server:

- session reads and writes reject sessions whose stored workspace path is outside that root;
- task reads and controls reject tasks and attached sessions outside the workspace;
- `workspace:read` and `workspace:write` are checked at the HTTP boundary;
- permission/question resolution additionally requires `interaction:resolve`;
- task mutations additionally require `task:control`;
- self-revocation requires `device:revoke:self`.

The device ID supplied by the auth store replaces client-supplied identity in command envelopes. The generic command endpoint checks elevated interaction/task scopes as well as the individual permission/question/task routes.

## Browser request protections

- Host is validated against the bound loopback host/port or configured public origin. Absolute-form request targets are rejected.
- Browser Origin must be absent for non-browser clients or exactly match the expected origin; `null`, malformed, and mismatched origins are rejected.
- Fetch Metadata rejects cross-site requests. Mutations require `application/json`; form-compatible content types are rejected.
- CORS is not enabled and `OPTIONS` preflight is not granted. The browser uses same-origin requests and Authorization bearer headers.
- Tokens are never accepted in URL query strings and no authentication cookie is issued.
- Responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. Public-origin deployments also receive HSTS. Static assets have an explicit CSP and are intentionally public; API/runtime data is authenticated.
- The server applies fixed-window per-source request and mutation limits, plus pairing-specific limits.

The bearer-only design avoids ambient-cookie CSRF. Exact Origin checks, Fetch Metadata, JSON-only state-changing requests, no CORS, and no URL credentials provide additional browser-side defenses. Non-browser clients still require a valid bearer credential for all protected routes.

## Data minimization and error handling

- Provider API keys and `apiKeyEnv` are not projected into browser model responses.
- Model profile base URLs are projected as origins; arbitrary provider variant extensions are omitted.
- Routing and smart-routing objects are projected through a fixed allowlist rather than serializing arbitrary runtime config.
- Custom agent prompts and unrelated runtime environment are not returned by discovery endpoints.
- Device token hashes and workspace IDs are omitted from device responses.
- Internal 5xx details are redacted from HTTP/SSE responses; pairing errors use generic messages.

Authenticated session/task content and tool output remain available to a paired workspace device because they are the content the Web View is designed to inspect. A paired device should therefore be treated as having the capabilities represented by its granted workspace scopes.

## Upstream implementation study and adaptation

See `docs/research/PHASE14E-UPSTREAM-SECURITY-PAIRING.md`.

The design adapts:

- OpenCode's centralized authorization middleware and server-level pairing/session flow;
- OpenCode's single-use pairing-code contract and session credentials;
- OpenClaude's explicit bearer `Authorization` use in its direct-connect manager;
- TermAgent's existing workspace-aware `createApi()` and durable command/event model.

It intentionally does not copy OpenCode's password-derived HMAC session token scheme. TermAgent issues independent high-entropy per-device bearer values and stores only their hashes so one device can be revoked without rotating every device. It also does not adopt query-string credentials or OpenClaude's unauthenticated gRPC server binding.

## Verification

`tests/phase14e-security.test.mjs` covers:

1. default remote-bind refusal and invalid TLS/public-origin combinations;
2. one-time pairing, hash-only persistence, file permissions, replay, workspace isolation, Host/Origin/Fetch Metadata, JSON-only mutations, safe API projection, and revocation;
3. token expiry, pairing lockout, and rate limits;
4. read/write, interaction, and task scope enforcement at direct and generic command boundaries;
5. a real local HTTPS listener with a generated test certificate, exact Host/Origin enforcement, pairing, and authenticated API access;
6. TLS-terminating reverse-proxy mode with public Host/Origin enforcement and HSTS.

Phase verification on 2026-11-01:

- `npm run build`: PASS.
- `node --check web/app/app.js`: PASS.
- `node --test --test-concurrency=1 tests/phase14e-security.test.mjs`: PASS, 6/6.
- Focused cross-phase command (`phase14a-event-interaction`, `phase14b-event-stream`, `phase14c-http-sdk`, `phase14d-webview`, `phase14e1-permission-resolver`, `phase14e-security`, and `server` tests): PASS, 43/43.
- `node scripts/verify-dist.mjs`: PASS (release artifacts verified).
- `npm pack --dry-run`: PASS (package contents and generated distribution artifacts accepted).
- Full `npm test`: not green. The `/auto` CLI end-to-end test reproduces the known pristine-checkpoint failure (`Expected: after`, `Actual: before`); the complete runner exceeded 480 seconds after more than 269 tests had started. No full-suite pass is claimed. Details are recorded in `PROGRESS.md`.

## Explicit limitations and boundaries

- Physical Android/Termux/Brave testing and real public-network deployment have not been performed in this environment.
- Reverse-proxy deployments must preserve Host and configure proxy-side rate limits; TermAgent intentionally does not trust forwarded client identity headers.
- Device management currently supports self-revocation in the Web View, not a remote admin revoke-other-device screen.
- Device-auth state is owned by one server process. Do not run multiple unsupervised TermAgent processes against the same auth store; Phase 14F's accepted Option A owner fencing remains a separate milestone.
- Hard-crash permission orphan reconciliation remains deferred until Phase 14F establishes exclusive runtime ownership.
- The aggregate repository test result is partial and not green; see the precise failure and timeout record in `PROGRESS.md`.

## Exit assessment

The Phase 14E code-level security and pairing boundary is implemented and covered by focused automated tests. The separate physical/mobile and deployment-validation sub-gates remain open. Phase 14F is not started or implied by this report.
