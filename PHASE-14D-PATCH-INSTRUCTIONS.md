# Applying the Phase 14D Web View source patch

This is a focused source patch for a TermAgent tree that already contains the Phase 14A–14C protocol, runtime, HTTP API, and dependency-free `TermAgentClient`. It is deliberately not a complete repository export.

1. Extract this archive at the root of that TermAgent repository, preserving paths.
2. Run `npm run build` to regenerate `dist/` from the source. The package metadata stays at `@whoops-1/termagent@1.18.0`.
3. Run the focused regression gate:

   ```sh
   node --check web/app/app.js
   node --test tests/phase14b-event-stream.test.mjs tests/phase14c-http-sdk.test.mjs tests/phase14d-webview.test.mjs
   ```

4. Start the local runtime using `termagent --serve` (or the project's normal serve command). Open the printed Web View URL. When bearer-token auth is configured, the browser must supply that token in the client UI before reading API/session data.

`web/prototype/` contains the uploaded v4 prototype unchanged. `web/app/` is its production projection using the existing HTTP/SSE client and durable event model. The archive omits generated `dist/`, dependency directories, repository metadata, and screenshots.

Phase 14D host-side implementation is focused-verified. Phase 14E pairing/origin/CSRF/revocation work and Phase 14F full two-client convergence are still open. Physical Termux/Android browser validation has not been claimed.
