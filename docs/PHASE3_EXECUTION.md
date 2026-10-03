# Phase 3: Skill catalog and descriptor index

Phase 3 turns TermAgent skill discovery into a descriptor-first catalog. It replaces the previous behavior that selected skills by matching against the beginning of `SKILL.md` and injected their bodies into the base prompt.

## Implementation boundary

```text
SKILL.md files
    -> SkillCatalog
    -> SkillDescriptor index
    -> compact descriptor listing

full SKILL.md body
    -> NOT injected here
    -> Phase 4 `use_skill`
```

## Included

- project and global `SKILL.md` discovery
- local plugin package skill discovery
- installed marketplace plugin skill discovery
- nested skill directories
- namespace-safe plugin skill IDs
- realpath-based symlink deduplication and root containment
- descriptor metadata and details API
- SHA-256 + path/mtime/size invalidation fingerprints
- deterministic bounded descriptor formatting
- descriptor-only compatibility wrappers for the old loader API

## Explicitly deferred

- `search_skills` tool
- `use_skill` tool
- `/skill` invocation
- automatic relevance matching during a turn
- inter-turn and mid-turn rediscovery signals
- plugin commands/agents/MCP integration
- skill trust/revocation/linting
- persistent index/performance tuning beyond the current process-local cache

## Phase gate

Do not mark Phase 3 complete until build, focused catalog tests, full test suite, package dry-run, source-hygiene scan, and extracted artifact smoke all pass. Stop at the Phase 3 boundary before beginning Phase 4.
