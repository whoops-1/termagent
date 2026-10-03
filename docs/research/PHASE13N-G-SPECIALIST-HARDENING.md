# Phase 13N-G - Specialist Sub-Agent Hardening

Date: 2026-10-02
Status: `[verified]` at the specialist delegation contract level

## Basis

This phase hardens TermAgent’s specialist-worker model. Specialist roles have explicit tool allowlists, read-only boundaries where required, bounded concurrent delegation, compact reports, and their own permission contracts. The existing `TaskManager`, `PermissionGate`, `ToolRegistry`, worker process, and durable session model remain authoritative.

## Changes

### 1. Explicit specialist roles

Added the relevant TermAgent subsystem with these roles:

- `general`: inherits the parent's derived tool policy for backward-compatible generic tasks.
- `researcher`: read-only repository exploration.
- `planner`: read-only analysis and planning.
- `coder`: file editing without arbitrary shell.
- `reviewer`: read-only change review.
- `tester`: read-only project inspection plus `verify_project`, but no arbitrary shell.

Each role declares its allowed tools, mutation policy, shell policy, prompt guidance, and maximum rounds.

### 2. Parent-policy intersection

A child role never expands the parent's capabilities. The effective child tool set is:

`parent-derived allowed tools ∩ specialist role allowlist`

The intersection is applied when the task is created and enforced again by the worker/Agent tool policy.

### 3. Scope inheritance

A child task that omits `scope_paths` now inherits the parent's declared workspace scope instead of silently expanding to the full project. Explicit narrower scopes remain supported.

### 4. Delegation bounds

TaskManager now centrally enforces a maximum number of active child agents per parent session. The coordinated parallel path can bypass scope-conflict checks, but not the global child-agent concurrency limit.

Delegation depth is explicit and bounded by `TERMAGENT_MAX_AGENT_DEPTH`, defaulting to one child generation. This makes recursion policy durable instead of relying only on the current worker tool registry happenstance.

### 5. Parent/child cancellation

Tasks now persist `parentTaskId`. Cancelling a task recursively cancels active descendants using the existing durable TaskManager cancellation path. The existing process identity protections remain in place.

### 6. Durable linkage and accounting

Task records now retain:

- `specialistRole`
- `delegationDepth`
- `parentTaskId`
- estimated input/output/total token usage

Usage is explicitly marked as estimated. TermAgent does not pretend provider billing data exists when the current provider abstraction does not expose it.

### 7. Compact specialist reports

Worker completion results are normalized into a bounded role-tagged report of at most 6000 characters. Full output remains in the existing durable output file, so parent context stays bounded without destroying evidence.

### 8. Background and parallel entry points

`task`, `background_agent`, and `parallel_agents` all accept the specialist role and apply the same role-policy intersection. This prevents one delegation entry point from becoming a capability-policy bypass.

## Verification

Phase-specific suite:

`tests/phase13n-g-specialists.test.mjs`

Result: **5/5 PASS**

The suite covers:

1. role registry and explicit allowlists
2. parent-policy intersection and scope inheritance
3. central concurrent-agent limits
4. durable parent-child cancellation
5. worker role, bounded report, and estimated usage accounting

Broader focused regression group:

**140/142 PASS**

Two existing failures remain:

- Phase 13B cache/Agent expectation mismatch
- Phase 13L `verify_project` timeout-state expectation mismatch

Neither is caused by the 13N-G specialist changes. They remain visible in the regression gate rather than being relabeled as passed.

## Deliberate non-changes

The phase does not introduce a new execution engine, new worker transport, or duplicate permission system. It reuses the existing TaskManager, PermissionGate, ToolRegistry, Agent runner, session store, and durable task-output path.

It also does not give the `tester` role arbitrary shell access. Project verification is exposed through the existing `verify_project` tool so the verification surface remains bounded.
