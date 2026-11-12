# Phase 14D — Browser Web View

**Status:** Implemented; focused-verified. Phase 14 as a whole remains open because pairing/security and two-way mirror acceptance are later phases.

## Design contract

The supplied `TermAgent-WebView-Prototype-v4.zip` is the visual source of truth. `web/prototype/` retains its HTML, CSS, JavaScript, and design document without edits. The production presentation lives in `web/app/`; its `index.html` retains the prototype's component hierarchy and control placement, and `styles.css` begins with the exact prototype stylesheet. Additional CSS is limited to runtime-rendered Markdown tables and the content structures that the prototype's simulated data did not need to render.

The v4 document explicitly calls for no animation library, no decorative motion, and reduced-motion support. Therefore this implementation does not add GSAP or Motion as dependencies. It keeps the supplied restrained CSS transitions, caret/spinner states, and the existing `prefers-reduced-motion` rules rather than introducing another animation system.

## Upstream patterns studied

- OpenCode `packages/session-ui/src/components/message-part.tsx`, commit/blob `d2a00b9d44c0bb1eba045ed3aa7eb00e45688ce4`: structured presentation of message parts, with text, reasoning, tool calls/results, files, and errors rendered semantically instead of flattening a transcript into one string. TermAgent adapts that model to its own `ChatMessage` and `EventEnvelope` contracts and the v4 visual design. https://github.com/anomalyco/opencode/blob/dev/packages/session-ui/src/components/message-part.tsx
- OpenCode SDK documentation, commit/blob `24546213be517e5badef046c3e4bcd359c59adda`: a typed client contract remains separate from the browser presentation. TermAgent uses its already-existing dependency-free `TermAgentClient` rather than duplicating route construction in the UI. https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/sdk.mdx
- OpenCode session service, commit/blob `a2a91cd47b5e854606444d1fc09fb18515fbe3b7`: session state and execution remain owned by the runtime/session layer. TermAgent's UI is a projection and submits canonical commands; it does not become a second agent engine. https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts
- OpenClaude's prompt-input implementation was used as an interaction reference for queueing, contextual input actions, history-oriented workflows, and shortcut affordances. These behaviors were selected only where they fit the provided v4 interaction model; the upstream UI framework was not imported. https://github.com/Gitlawb/openclaude/blob/main/src/components/PromptInput/PromptInput.tsx

## Architecture

```text
TermAgent SessionStore / runtime
        |                       
        +-- durable event log   +-- bounded live event bus
                    |           |
                    +-----+-----+
                          |
                 HTTP + reconnectable SSE
                          |
              src/client + src/protocol
                          |
                 web/app/app.js
                          |
               v4 visual component tree
```

The browser imports the compiled client at `/web-assets/client/client.js` and protocol API helpers at `/web-assets/protocol/api.js`. These paths are allowlisted; no arbitrary filesystem path is accepted for static serving. The UI has no dependency on Node runtime modules, and the frontend introduces no package dependency or build pipeline.

`src/server/runtime.ts` publishes text/reasoning deltas, activity/tool output, and run state through the existing runtime-owned `SessionEventBus`. The bus buffers transient live frames per subscriber, coalesces adjacent text/reasoning deltas from the same run, and caps each pending queue. Durable events remain backed by `SessionStore`; the browser's recovery cursor advances from durable sequence numbers only. Completion causes the browser to fetch an authoritative snapshot, reconciling its temporary live-output projection with persisted messages.

The browser does not automatically replay a prompt when reconnecting. A saved session is resumed by selecting it; a background agent task can be explicitly continued with a user-supplied continuation prompt. This avoids accidentally repeating a tool-bearing turn after a network failure.

## Implemented surface

- Responsive session discovery/switching and new-session creation.
- Transcript projection from a session snapshot and recent durable events.
- Live assistant text/reasoning, run status and duration, activity timeline, tool cards with expandable input/output, paths, task inspection, Todo/progress, diff preview, and verification proof chips.
- Shared pending permission and question forms that invoke the canonical resolution API.
- Stop/abort, prompt queue submission and removal, compact, undo/redo, checkpoint creation/restoration/branching, and task inspect/cancel/continue actions.
- Composer mode selection, slash-command suggestions, path hints, latest/live-edge behavior, focus mode, local theme preference, reconnect status, and in-memory bearer-token entry.
- Markdown headings, paragraphs, inline code/emphasis, safe HTTP(S)/mailto links, unordered and ordered lists, blockquotes, fenced code blocks, and horizontally scrollable semantic tables.
- Accessible tab arrow-key navigation, Escape close behavior, bottom-sheet focus containment/restoration, labelled permission/question surfaces, and mobile layouts without page-level horizontal overflow.

## Hosting and security boundary

`termagent --serve` now serves the Web View at the printed root URL. A configured `--token` continues to protect health/API/session routes; static presentation assets are public and contain no credentials. The browser token is held only in JavaScript memory and never written into local storage, URL parameters, or HTML. The static server sets content-type, `nosniff`, a restrictive frame/base/object CSP, and `Referrer-Policy: no-referrer`.

At the Phase 14D checkpoint, this Web View had not yet completed its remote security boundary. Phase 14E subsequently added explicit remote-bind controls, TLS/public-origin enforcement, one-time device pairing, bearer-token authorization and revocation, Origin/Fetch Metadata protections, workspace/action scopes, rate limits, and minimized API projections. See `docs/phases/PHASE14E-SECURITY-PAIRING-REMOTE-ACCESS.md` for the later implementation and its remaining physical-device/deployment validation limits.

## Verification and limits

Focused automated tests cover static asset serving, CSP/security headers, unchanged API bearer-token enforcement, real client access to the live SSE stream, prompt completion reconciliation against durable session history, transient delta coalescing, and preservation of the supplied v4 stylesheet.

A browser smoke was also run in Chromium at 390×844, 768×900, and 1440×960 using a deterministic fake client fixture. It confirmed transcript/tool/table rendering, prompt submission, sheet open/close, no page errors, and no mobile horizontal overflow. This screenshot smoke is a presentation test, not a physical Android/Termux test or a real-provider end-to-end test. The host has not proven device-specific Chromium behavior.

Markdown rendering is intentionally dependency-free and implements the listed common blocks rather than the full CommonMark/GFM specification. Syntax highlighting, attachment upload, remote pairing and broad two-client conflict testing are not claimed as complete by Phase 14D.
