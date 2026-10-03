# Phase 9 — Context Budget and Performance

## Scope

Phase 9 makes skill discovery and tool schemas first-class context consumers and reduces repeated local filesystem work between turns. The implementation keeps the existing TermAgent provider, ANSI/VT UI, and dependency-free runtime model.

## Context budgeting

the relevant TermAgent subsystem exposes deterministic allocations for:

- instructions;
- repository context;
- skill descriptors;
- explicitly loaded skill content;
- tool schemas.

The Agent subtracts bounded tool schemas from the usable context budget before building the system prompt. The prompt itself reserves space for its fixed core text before allocating the remaining sections. Workflow notices are also fitted into the remaining request budget before a provider call.

Tool schemas are compacted before requests. Required properties remain present whenever their tool survives bounding. A catastrophically oversized single-tool definition is rejected instead of being reduced until its contract becomes unreliable.

## Skill-body bounds

Explicitly loaded skills are bounded in the system prompt. The model-facing `use_skill` tool also returns a bounded representation. `truncateAroundTokenBudget()` preserves both the beginning and end of a large body, separated by an explicit truncation marker. Direct `loadSkill()` callers still receive the exact full body and full digest verification.

## Descriptor/index caching

The skill catalog uses a process-local indexed cache keyed by resolved project. Unchanged files reuse the previous descriptor/details object when path, resolved path, size, and mtime are unchanged. Catalog generations advance only when the selected descriptor set changes. Search results include the catalog generation in their cache key.

Concurrent `loadSkillCatalog()` callers share a single in-flight build. Project caches are bounded to eight active entries and are touched on access as an LRU. Search and descriptor-field caches are separately bounded.

## Prefetch policy

The CLI does not eagerly scan all skill directories during normal startup. `/skills` loads the catalog when explicitly requested. The agent performs skill discovery from the model-facing skill tools only when those tools are registered. No remote skill or marketplace data is prefetched by Phase 9.

## Verification

Focused suite: 10/10 PASS.

Full repository suite: 298/298 PASS.

Low-memory run: 10/10 PASS with Node `--max-old-space-size=64`.

Release hardening: 6/6 PASS.

Performance fixtures: 10, 100, and 1,000 skills plus a 300-plugin catalog.

Observed release-workspace benchmark (cold/warm): 10 skills ≈ 11.1/2.7 ms, 100 skills ≈ 28.6/15.8 ms, 1,000 skills ≈ 229.8/129.9 ms.
