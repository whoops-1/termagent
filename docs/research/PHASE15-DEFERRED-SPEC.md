# Phase 15 — VS Code Integration (Deferred Specification)

Status: discontinued as an active milestone and deferred indefinitely by the 2026-11-01 roadmap decision. The original specification is preserved below for future reference; no implementation is scheduled.

# Phase 15 — VS Code integration

The long-term VS Code integration uses the same TermAgent runtime rather than embedding a second agent engine inside the extension.

### 15A — Extension-host adapter

- [ ] Create `extensions/vscode/` using the official repository structure.
- [ ] Implement a typed TermAgent client in the extension host.
- [ ] Implement workspace-to-TermAgent session attachment and discovery.
- [ ] Implement secure local/remote authentication and connection lifecycle.
- [ ] Reuse canonical events/commands; do not duplicate task, permission, question, or agent logic.

### 15B — Native VS Code Chat Participant

- [ ] Evaluate the VS Code Chat Participant API for native `@termagent` integration.
- [ ] Stream TermAgent responses into the VS Code chat experience.
- [ ] Map user messages and cancellation to canonical runtime commands.
- [ ] Preserve TermAgent as the authoritative agent/tool runtime.
- [ ] Map errors and progress into native VS Code chat affordances where practical.

### 15C — Full custom VS Code Webview

- [ ] Add a custom Webview panel/view only where richer TermAgent UI exceeds native Chat API capabilities.
- [ ] Keep the Webview itself stateless or minimally stateful and restore through extension state/reconciliation.
- [ ] Extension host receives runtime events and forwards sanitized semantic messages to the Webview.
- [ ] Webview sends user actions back to the extension host with `postMessage()`; extension host submits canonical TermAgent commands.
- [ ] Do not require the Webview to call localhost directly, especially where Remote Development/Codespaces portability matters.
- [ ] Follow VS Code Webview CSP, `localResourceRoots`, serialization, accessibility, and lifecycle guidance.

### 15D — IDE-native actions

- [ ] Open referenced files at locations.
- [ ] Open diffs in the VS Code diff editor.
- [ ] Surface task status in the activity bar/status area where useful.
- [ ] Support workspace/session selection.
- [ ] Support attach/detach without changing session ownership.

### Phase 15 gate

- [ ] Native `@termagent` chat path works.
- [ ] Custom Webview path works where needed.
- [ ] Both use the same canonical runtime.
- [ ] Session state remains consistent with terminal/Web View clients.
- [ ] VS Code restart/restore behavior is tested.

---

