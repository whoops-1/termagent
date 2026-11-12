# Phase 14E upstream security and pairing research

**Research date:** 2026-11-01  
**Purpose:** Identify proven upstream patterns for protecting a browser-accessible agent runtime, then adapt them to TermAgent's existing HTTP/SSE server and workspace model.

## OpenCode: centralized authorization and pairing

Sources reviewed at commit `69269e4ebe309a08919b3c9be7948b9fd699c3a4`:

- [`packages/server/src/middleware/authorization.ts`](https://github.com/anomalyco/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/server/src/middleware/authorization.ts)
- [`packages/server/src/auth.ts`](https://github.com/anomalyco/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/server/src/auth.ts)
- [`packages/protocol/src/groups/server.ts`](https://github.com/anomalyco/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/protocol/src/groups/server.ts)
- [`packages/web/src/content/docs/server.mdx`](https://github.com/anomalyco/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/web/src/content/docs/server.mdx)

The authorization middleware is centralized rather than reimplemented route by route. It accepts HTTP Basic credentials and a signed session credential, but treats pairing connection as a separate route whose handler must validate the pairing code. Its session-cookie path checks that the request Origin host matches the Host header before accepting the cookie. The pairing protocol has a creation endpoint and a single-use code redemption endpoint; browser clients receive a cookie while API clients receive a token. The server auth module derives session signatures from the configured password and uses constant-time signature comparison. Password rotation therefore invalidates issued sessions.

**TermAgent adaptation:** keep authorization at the outer HTTP boundary; use the already typed server API and `createApi()` for workspace checks; use an explicit pairing route; bind the identity used by the command ledger to the authenticated device record; check elevated scopes at the point a permission, question, or task command crosses the boundary.

**Intentional differences:** TermAgent does not introduce Basic auth or ambient cookies. Each device receives a random 256-bit opaque token, only its SHA-256 hash is persisted, and a single device can be revoked without rotating other devices. Tokens are accepted only in the `Authorization: Bearer` header, never in URL query parameters. This also keeps the browser token in memory rather than writing it to local storage.

## OpenClaude: explicit bearer credentials and correlated control requests

Sources reviewed from the user-supplied `openclaude-main.zip`:

- `openclaude-main/src/server/directConnectManager.ts`
- `openclaude-main/src/server/createDirectConnectSession.ts`
- `openclaude-main/src/grpc/server.ts`

OpenClaude's direct-connect manager attaches its configured auth token as an `Authorization: Bearer ...` header. Its session-creation helper does the same for the HTTP session request. This gives TermAgent a useful precedent for explicit header credentials rather than query-string secrets.

The gRPC server's permission callback map is keyed by prompt/request ID. A reply resolves the exact stored callback and removes it; when the stream ends, pending permission callbacks are drained with a denying response. This is relevant to the already-completed 14E.1 permission-resolver integration, which adapts the same request-correlated lifecycle to TermAgent's durable SessionStore rather than adding another callback map.

The inspected OpenClaude gRPC server binds with insecure credentials. TermAgent does **not** copy that transport-security posture for remote access.

## TermAgent-native primitives retained

TermAgent already had:

- a local HTTP/SSE server in `src/server/http.ts`;
- workspace/session/task validation in `src/server/api.ts`;
- typed command envelopes and a durable command ledger;
- a typed dependency-free browser client;
- a memory-only browser credential location;
- durable permission/question resolution from Phase 14E.1.

The phase therefore extends the existing server and client seam rather than adding a second auth server, session database, or command system. `src/server/security.ts` owns the device credential lifecycle and persistent auth records; `src/server/http.ts` performs request authentication and scope checks before passing validated operations to the existing API.

## Security choices

1. **Loopback by default.** This keeps the local workflow simple and refuses public binds without explicit TLS and pairing configuration.
2. **Explicit HTTPS origin.** Direct TLS and TLS-terminating reverse-proxy modes both require a configured HTTPS origin. The proxy must preserve Host; forwarded headers are not trusted for client identity.
3. **Pairing code and opaque device token.** A short-lived one-time code is delivered out-of-band through the server terminal. A successful exchange returns a high-entropy bearer token once.
4. **Hash-only persistence.** The auth state stores token hashes and safe metadata, not raw bearer values or pairing codes. State files and directories use owner-only modes.
5. **Workspace-scoped authorization.** Sessions and tasks are constrained to the server's workspace. Device IDs, not user-supplied client IDs, identify remote command sources.
6. **Bearer, not cookie.** No cookie is issued, so there is no ambient browser credential. Tokens are not put in URLs.
7. **Browser request provenance.** Exact Host/Origin, Fetch Metadata, JSON-only mutations, no CORS, and no form-compatible state-changing content types protect browser routes.
8. **Revocation/expiry at active boundaries.** Requests validate current token state; long-running prompts and SSE connections periodically recheck.
9. **Data minimization.** Discovery endpoints use allowlisted config projections; provider keys, environment, custom-agent prompt bodies, token hashes and workspace IDs are omitted.
10. **No premature multi-process assumptions.** The auth store is process-owned. Phase 14F must implement accepted Option A exclusive runtime-owner fencing before supporting competing clients/processes as separate owners.

## References

- OpenCode, authorization middleware: <https://github.com/anomalyco/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/server/src/middleware/authorization.ts>
- OpenCode, auth/session token logic: <https://github.com/anomalyco/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/server/src/auth.ts>
- OpenCode, pairing protocol: <https://github.com/anomalyco/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/protocol/src/groups/server.ts>
- OpenCode, server docs: <https://github.com/anomalyco/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/web/src/content/docs/server.mdx>
- OpenClaude source: supplied `openclaude-main.zip`, paths listed above.
- OWASP, Cross-Site Request Forgery Prevention Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html>
