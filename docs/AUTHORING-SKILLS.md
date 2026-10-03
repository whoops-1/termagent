# TermAgent Skill Authoring

A TermAgent skill is a `SKILL.md` instruction bundle. Pure registry skills are prompt content only. Installing one does not install executable plugins, MCP servers, hooks, commands, or agents.

## Local skill layout

```text
 .termagent-state/skills/my-skill/SKILL.md
.termagent/skills/my-skill/SKILL.md
```

`.claude/skills` remains supported for Claude-compatible projects. Global skills can live in the corresponding directories under `HOME`.

## Recommended structure

```markdown
---
name: my-skill
description: Review a migration and verify it before merging.
version: 1.0.0
trust: community
license: MIT
category: migration
tags:
  - database
  - review
---

# Migration Review

## Use this skill when
- The user asks for a database migration review.

## Do NOT use this skill when
- The request is unrelated to a database migration.

## Procedure
1. Inspect the migration and surrounding schema.
2. Check locking, compatibility, rollback, and verification behavior.
3. Report concrete findings with file paths and evidence.

## Examples
- In scope: review an index or schema migration.
- Out of scope: write application feature code unrelated to the migration.

## Self-check before responding
- Verify that every finding is grounded in the inspected files.
- Verify that the suggested rollout and rollback behavior are explicit.
```

Pure registry entries should publish the exact SHA-256 digest of the normalized `SKILL.md` bytes they distribute.

```json
{
  "id": "example/my-skill",
  "name": "my-skill",
  "description": "Review a migration and verify it before merging.",
  "trust": "community",
  "version": "1.0.0",
  "license": "MIT",
  "source": "https://example.invalid/skills/my-skill/SKILL.md",
  "sha256": "<64-hex-digits>"
}
```

## Discovery and invocation

The catalog exposes only descriptors such as name and description. The full body is loaded only when the agent explicitly invokes the skill. That keeps large skill bodies out of the base request and provides a clear security boundary.

Skill content is scanned for hidden Unicode, fake role markers, credential/exfiltration patterns, unsafe fetches, concealed execution, and related instruction-injection signals. A blocked skill is not discoverable or invocable.

## Registry trust and revocation

Registry trust metadata is separate from author text. A skill cannot self-promote to an official trust tier merely by changing its frontmatter. Registries may revoke an entire skill ID, one version, or an exact digest.

A changed digest, source, version, or trust tier invalidates a previous approval. This makes the approval specific to the exact content that was reviewed.

## Publishing checklist

```sh
# Validate the skill directory in the registry repository.
bun run scripts/validate-skill.ts skills/my-skill/

# Rebuild the registry metadata.
bun run build:registry
```

For TermAgent consumers, use a test registry first and verify:

```text
add registry → search → inspect → approve/install → discover → invoke → revoke/verify → uninstall
```

Never tell users to disable digest checking or revocation checks to make a skill install succeed.
