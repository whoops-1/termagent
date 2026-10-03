# Phase 10: Pure Skill Registry

TermAgent 1.17 adds a separate distribution layer for declarative `SKILL.md` files. A pure skill registry is not a plugin marketplace: it distributes prompt content and metadata only. It never grants executable plugin permissions, never imports remote JavaScript, and never modifies the plugin marketplace state.

## Registry model

A registry is a JSON document containing a `skills` array. The current the skill registry uses an array-root `registry.json`, so TermAgent accepts both the reference array form and an object with `skills` plus optional metadata.

A skill entry contains, at minimum:

```json
{
  "id": "community/pr-review",
  "name": "pr-review",
  "description": "Reviews pull requests for correctness, style, and risks.",
  "trust": "official",
  "version": "0.1.0",
  "license": "MIT",
  "source": "https://example.invalid/skills/pr-review/SKILL.md",
  "sha256": "sha256:<64 hex characters>"
}
```

Optional provenance fields include `repo`, `path`, `homepage`, `title`, `category`, `tags`, and `author`.

## Provider boundary

`the skill registry` exposes the small provider contract used by the rest of the implementation:

```ts
export type SkillRegistryProvider = {
  fetchRegistry: (url: string) => Promise<...>
  fetchSkill: (url: string) => Promise<RemoteSkillArtifact>
  fetchRevocations?: (url: string) => Promise<SkillRegistryRevocation[]>
}
```

The default provider uses the existing Node `fetch` implementation. Tests inject a provider, so registry logic is independent of transport and does not require the plugin system.

## Distribution and state layout

```text
~/.termagent/skill-registries/
├── registries.json
├── installed.json
├── security.json
├── cache/
│   ├── <registry>/registry.json
│   ├── <registry>/revocations.json
│   └── skills/<registry>/<skill>/<version>/SKILL.md
└── installed/
    └── <registry>/<skill>/<version>/SKILL.md
```

Registry caches and installed skills stay under the user's home directory. Intermediate directories are checked for symlink escapes, and installed records must resolve to the exact derived `SKILL.md` path under the pure-registry install root.

## Remote fetch limits

Remote registry, revocation, and skill retrieval is bounded and time-limited:

- registry JSON: 512 KiB
- revocations JSON: 256 KiB
- `SKILL.md`: 64 KiB
- request timeout: 30 seconds

HTTPS is required for remote hosts. Plain HTTP is accepted only for localhost test fixtures. The final response URL is checked again after redirects, so an HTTPS registry cannot silently redirect to a disallowed HTTP or remote destination.

## Integrity and metadata

Every registry skill must publish a SHA-256 digest. TermAgent recomputes the digest from the fetched or cached `SKILL.md` content and rejects mismatches. The cached copy is treated as valid only after the same digest, frontmatter identity, size, and content-security checks succeed.

The registry `name` and `version` must match the corresponding `SKILL.md` frontmatter. This prevents registry metadata from silently describing different content.

Registry metadata can be served from the last known-good cache after a remote fetch failure. A cached registry becomes stale after seven days by default. Listing can inspect stale data, but installation requires an explicit `--allow-stale` override so network failure cannot silently turn old metadata into a fresh trust decision.

## Trust

Trust metadata describes provenance; it does not grant execution permission.

TermAgent stores approvals using the exact tuple:

```text
registry id + skill id + source + version + sha256 + trust tier
```

Any change invalidates the old approval. A skill therefore cannot inherit approval merely because its name is unchanged.

Installation requires explicit confirmation unless the exact tuple was previously approved. Approval is recorded only after the artifact passes digest, frontmatter, size, path, and content-security checks.

## Revocations

A registry can provide revocations inline or through `revocations.json`. Entries can target an entire skill ID, one version, or an exact digest. Remote revocation data is cached separately.

A known-good cached revocation list can be reused when a refresh fails. If no known-good list exists, a revocation fetch failure is fail-closed and installation is refused. A confirmed HTTP 404 is treated as a registry with no revocation list.

Revocation state is also checked immediately before registry-sourced skill invocation, not only during installation.

## Pure-skill installation boundary

Installing a pure registry skill writes only the registry skill state and the declarative `SKILL.md` artifact. It does not:

- add an entry to `~/.termagent/plugins/installed.json`
- enable a plugin
- load plugin commands, agents, MCP servers, or hooks
- grant tool permissions
- import remote JavaScript

The skill catalog labels these skills with `source: "registry"` and preserves registry/trust provenance.

## CLI

```text
/skill-registry list
/skill-registry add <id> <registry.json URL> [revocations.json URL]
/skill-registry refresh <id>
/skill-registry search <id> [query]
/skill-registry install <registry-id> <namespace/skill> [--yes] [--allow-stale]
/skill-registry installed
/skill-registry uninstall <namespace/skill>

/skills registries
/skills installed
/skills install <namespace/skill> [--yes] [--allow-stale]
/skills uninstall <namespace/skill>
```

The compact `/skills install` path selects the configured registry whose ID matches the namespace. Registry registration remains explicit, so an ordinary `/skills` call never triggers an unsolicited remote registry fetch.

## Relationship to the plugin marketplace

The two distribution layers intentionally converge only at the skill catalog:

```text
plugin marketplace
  -> installed plugin
  -> plugin-provided SKILL.md
  -> SkillCatalog

pure skill registry
  -> installed SKILL.md
  -> SkillCatalog
```

The plugin path can carry executable components elsewhere in the plugin package. The pure registry path cannot. This separation keeps registry caching, trust, revocation, and skill invocation independently auditable.
The design follows the current the skill registry shape: a lightweight `registry.json`, per-skill `SKILL.md` sources, published `sha256`, trust metadata, and a reserved `revocations.json`. TermAgent's installer also stages remote content, enforces bounded remote reads, validates registry metadata, and refuses direct HTTPS installs without a digest pin.

the implementation discovery service independently uses a small remote `index.json` contract, bounded concurrent downloads, path-segment validation, version markers, and transactional replacement of cached skill directories. TermAgent adapts those ideas to its existing Node/Termux architecture rather than importing TermAgent's Effect runtime.
