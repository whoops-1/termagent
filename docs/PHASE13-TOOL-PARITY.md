# Phase 13 Tool Capability Review

## Purpose

This document records the current TermAgent tool surface, the owner of each capability, and the areas that remain intentionally deferred. It is an internal engineering inventory, not a promise that every possible tool belongs in the product.

## Capability map

| Capability | TermAgent owner | Current state | Notes |
|---|---|---|---|
| File search | `src/tools/grep.ts`, `src/tools/glob.ts` | Active | Bounded search with stable result metadata. |
| Repository map | `src/context/repository.ts` | Active | File inventory, symbols, and structural context. |
| File reads | `src/tools/read-file.ts` | Active | Range-aware reads backed by the read-state cache. |
| Patch application | `src/tools/apply-patch.ts`, `src/patch/` | Active | Structured patch parsing and verification. |
| Background tasks | `src/tasks/` | Active | Durable lifecycle, output references, and cancellation. |
| Long-running processes | `src/tasks/processes.ts` | Active | Process groups, bounded tails, stdin timeouts, and deterministic stop behavior. |
| LSP diagnostics | `src/context/lsp-diagnostics.ts` | Active model | Diagnostic truth model is ready; full language-server lifecycle remains separate work. |
| Web access | `src/tools/` | Deferred | Network features require an explicit product/security decision. |
| Notebook editing | `src/tools/` | Deferred | No dedicated notebook document model yet. |
| Generic batch tool | `src/tools/` | Deferred | Bounded `parallel_agents` remains the explicit concurrency primitive. |

## Rules

1. Reuse existing TermAgent services and semantic state instead of creating parallel state stores.
2. Keep mobile constraints visible in every long-running or process-heavy feature.
3. Prefer bounded, deterministic outputs.
4. A deferred capability should remain explicit in the inventory rather than being represented as a fake implementation.
5. Tool contracts, permission behavior, persistence, and UI projections should evolve together.

## Review checklist

For a new capability, verify the schema, runtime owner, persistence requirements, permission behavior, cancellation semantics, UI projection, tests, and release impact before marking it active.
