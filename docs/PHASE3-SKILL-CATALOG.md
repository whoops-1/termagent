# Phase 3: Skill Catalog and Descriptor Index

Phase 3 replaces TermAgent's previous body-based skill selection with a descriptor-first local catalog. Full `SKILL.md` content is intentionally not part of the base system prompt in this phase. Explicit loading is reserved for Phase 4.
The current design skill loader identifies skills by directories containing `SKILL.md`, supports nested skill directories, resolves symlink identity with `realpath`, and keeps frontmatter metadata available for discovery while loading full content when a skill is actually invoked. Its current experimental skill-search layer also separates local discovery from later explicit loading. Current the implementation exposes skills as a distinct plugin-provided service rather than making skill bodies part of generic plugin metadata.

TermAgent adapts those ideas to the existing Node + ANSI/VT + ARMv7/Termux architecture and keeps the implementation dependency-free.

## Catalog model

```text
project/global SKILL.md
          +
installed/local plugin skills
          |
          v
      SkillCatalog
          |
          v
    SkillDescriptor index
          |
          +--> list()
          +--> get(id) -> SkillDetails
          +--> compact descriptor listing
```

A model-facing descriptor contains only:

- stable `id`
- skill `name`
- short `description`
- `source`
- optional plugin provenance/version
- optional invocation flags from frontmatter

`SkillDetails` additionally contains the resolved file path, root, size, mtime, SHA-256 digest, parsed scalar frontmatter, and warnings for inspection/debugging surfaces.

## Discovery roots and precedence

Project skills are checked before global skills:

1. `<project>/.termagent/skills`
2. `<project>/.claude/skills`
3. `~/.termagent/skills`
4. `~/.claude/skills`
5. local plugin packages discovered by the Phase 1 package registry
6. installed marketplace plugins recorded by `installed.json`

Unnamespaced project/global skill IDs use the first discovered definition, giving project-local definitions precedence over global ones. Plugin skills are always namespaced as `<plugin>@<marketplace>:<skill>` so they do not collide with local skills or skills from another marketplace.

## Index invalidation

The in-process index stores a fingerprint made from:

```text
resolved path + size + mtime + sha256
```

The catalog re-hashes `SKILL.md` content during a scan, so a content change is detected even when a filesystem preserves the previous timestamp and size. A stable fingerprint reuses the prior parsed descriptor/details object rather than reparsing frontmatter.

The index is process-local in Phase 3. A persistent index and larger-scale performance tuning belong to Phase 9.

## Symlink behavior

Skill roots may contain symlinked directories, but a resolved skill file must remain inside its configured real root. Realpath-based visited tracking also prevents duplicate discovery and symlink cycles.

Marketplace-installed plugin content already rejects symlinks during installation, so this containment primarily protects project/global local skills.

## Runtime behavior change

the relevant TermAgent subsystem, the relevant TermAgent subsystem, and the relevant TermAgent subsystem now provide the model with a compact descriptor listing rather than selected skill bodies.

The old `loadSkills`, `selectSkills`, and `formatSkills` APIs remain as descriptor-only compatibility wrappers in the relevant TermAgent subsystem. They no longer read or inject full `SKILL.md` content.

The legacy `skill` tool is retained only as a non-body compatibility surface and is not registered by the normal runtime. The shared `use_skill` tool is intentionally deferred to Phase 4.

## Verification targets

Phase 3 must cover:

- duplicate local skill names and precedence
- nested skill directories
- internal and escaping symlink behavior
- malformed frontmatter degradation
- descriptor-only prompt output
- path/mtime/size/digest invalidation
- plugin skill provenance and namespace isolation
- missing/broken installed plugin state
- deterministic and bounded descriptor listing

Passing the Phase 3 gate does not imply Phase 4 functionality. `search_skills`, `use_skill`, `/skill`, and mid-turn discovery remain explicitly out of scope until Phase 4.
