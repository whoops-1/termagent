# Phase 13M-P1 — Canonical Tool-Call Identity

Status: implemented in the working tree; phase-level gate remains pending.
The Phase 13 loop guard originally compared completed tool parts by tool name plus a serialized input object. That preserves values, but ordinary object serialization is order-sensitive, so equivalent inputs can receive different repeat signatures.

TermAgent's recorded Phase 13 revision is ``. Its tool-failure loop guard separates persistent tool/error signatures from path/category counters and deliberately ignores ephemeral tool-result details. That supports the broader TermAgent rule that loop detection should identify meaningful execution identity rather than transport or rendering artifacts.

## TermAgent adaptation

TermAgent keeps its existing `ToolLoopGuard` thresholds and permission behavior, but moves identity construction into the relevant TermAgent subsystem.

`canonicalJson()` recursively sorts object keys while preserving array order. Object properties whose value is `undefined` are omitted, matching the JSON input semantics used by the tool protocol. Meaningful scalar values, ranges, selectors, paths, and array ordering are otherwise preserved.

`canonicalToolCallIdentity()` combines:

- tool name;
- canonicalized tool input;
- execution scope (`cwd` and scope paths).

Execution-scope path lists are normalized as an unordered set because they describe the allowed workspace scope rather than an ordered selector. Tool input arrays remain ordered.

The loop guard hashes that canonical identity with SHA-256. This removes object-key-order sensitivity while keeping the guard state compact and avoiding the smaller collision space of the previous 32-bit FNV hash.

## Regressions

The Phase 13 test suite now covers nested key reordering, omitted/undefined optional values, semantic array ordering, distinct read ranges, tool-name separation, workspace/scope separation, and the combined scoped repeat path through `ToolLoopGuard`.

The agent execution path passes the current session `cwd` and `scopePaths` into the loop identity, so the same tool arguments executed under a different workspace scope cannot accidentally inherit a repeat count.
