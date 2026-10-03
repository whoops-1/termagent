# TermAgent Plugin Marketplace and Skill Discovery Plan

## Status

This document describes the plugin and skill architecture carried forward by TermAgent. It records the intended contracts, security boundaries, lifecycle rules, and remaining work. It is not a source-comparison document.

## 1. Scope

TermAgent treats plugins, skills, commands, agents, and MCP integrations as related but distinct extension types.

```text
marketplace catalog
       ↓
 plugin package
   ┌───┼────┬──────┐
   ↓   ↓    ↓      ↓
skills commands agents  integrations
   ↓
compact discovery metadata
   ↓
explicit skill loading
```

The plugin system extends existing loaders and registries. It does not create a second command system, agent system, permission engine, MCP client, or session store.

## 2. Existing implementation seams

The main modules involved are:

- `src/plugins/manifest.ts` — manifest parsing and package metadata
- `src/plugins/marketplace.ts` — marketplace state and catalog operations
- `src/plugins/plugin-install.ts` — materialization and installation lifecycle
- `src/plugins/reconcile.ts` — startup reconciliation and orphan handling
- `src/plugins/registry.ts` — active plugin registrations
- `src/plugins/security.ts` — trust, validation, and revocation
- `src/plugins/updates.ts` — deterministic update scheduling
- `src/plugins/dependency-resolver.ts` — metadata-only dependency resolution
- `src/plugins/components.ts` — command/agent/MCP/skill component discovery
- `src/skills/catalog.ts` — descriptor catalog
- `src/skills/discovery.ts` — relevance and discovery
- `src/skills/invoker.ts` — explicit skill activation
- `src/skills/loader.ts` — bounded body loading
- `src/skills/registry.ts` — installed registry state
- `src/skills/security.ts` — content validation and revocation
- `src/cli/tui/plugin-manager.ts` — terminal management UI

These modules should remain the owners of their respective behavior.

## 3. Marketplace model

A marketplace is a catalog of installable plugin entries. The catalog can be stored remotely or supplied locally, but the runtime treats the resulting data as untrusted input until validated.

A marketplace entry carries enough metadata for browsing and installation without fetching the package body:

```json
{
  "name": "example-tools",
  "description": "Developer utilities",
  "category": "development",
  "tags": ["git", "testing"],
  "source": {
    "kind": "git",
    "url": "https://example.invalid/tools.git"
  }
}
```

Supported source classes are represented by the existing `PluginSource` union. New source types must preserve the same validation, trust, installation, and reconciliation contracts.

## 4. Plugin manifest

A plugin manifest is descriptor-first. It may declare:

```text
metadata
commands
agents
skills
hooks
MCP servers
configuration
optional dependencies
```

The parser validates required fields before any component is loaded. Unknown fields may be retained as metadata where compatibility requires it, but executable behavior must always pass through a known component type.

## 5. Installation lifecycle

Installation is a stateful transaction:

```text
catalog entry
    ↓
validate source
    ↓
resolve dependencies
    ↓
preflight destination
    ↓
materialize package
    ↓
validate manifest
    ↓
validate components
    ↓
record installation
    ↓
activate enabled components
```

A failed multi-plugin installation restores the previous installation metadata snapshot and removes only paths created by the failed transaction.

The runtime distinguishes configuration intent from materialized installation state. This prevents an invalid or partially installed package from being treated as active simply because it appears in configuration.

## 6. Dependencies

Dependency resolution is metadata-only and deterministic.

Allowed forms include:

- a plugin name resolved against the declaring marketplace;
- `plugin@marketplace` for an explicit marketplace;
- future version-qualified forms handled by the resolver rather than the installer.

The root marketplace controls whether cross-marketplace dependencies are allowed. A plugin cannot silently expand the trust boundary merely by declaring another marketplace dependency.

The resolver reports:

```text
missing dependency
cycle
ambiguous dependency
blocked cross-marketplace dependency
```

before materialization begins.

## 7. Reconciliation and updates

Startup reconciliation runs before component activation. It:

- removes abandoned staging directories;
- verifies installed records against current marketplace entries;
- rechecks package digests and manifest identity;
- records deleted marketplace entries as orphaned;
- marks broken dependency states explicitly;
- preserves `update-available` state until the replacement is fully installed.

Automatic updates operate in deterministic marketplace/plugin order. A failed update does not silently disable a previously working package.

## 8. Trust and security

Plugin packages are third-party code and are treated as untrusted until the user explicitly approves them under the configured policy.

Validation covers:

- path traversal;
- absolute-path escape;
- symlink escape;
- manifest/package identity mismatch;
- unsafe source hosts and paths;
- unsafe component locations;
- revoked package digests;
- stale or conflicting installation metadata.

The skill security boundary is intentionally stricter because a skill is instruction content rather than executable code. Skill folders are limited to the supported metadata/Markdown surface, and skill bodies are scanned for suspicious Unicode, credential-path references, exfiltration patterns, hidden evaluation, and confirmation-bypass instructions.

## 9. Skill discovery

Skill discovery is two-stage.

### Stage A: compact catalog

The model receives concise descriptors:

```text
Available skills:
- database-review: Reviews schema and migration changes.
- ci-fix: Diagnoses pipeline failures.
- frontend-implementation: Builds UI changes within project conventions.
```

Only metadata participates in automatic relevance selection.

### Stage B: explicit load

Once a skill is selected, `use_skill` loads the bounded `SKILL.md` body after validating the resolved path, digest, and trust policy.

This keeps large instruction bodies out of unrelated prompts and makes the loaded skill explicit in the turn lifecycle.

## 10. Skill discovery signals

Discovery may run when:

- the user request clearly matches a skill description;
- repository exploration changes the task shape;
- a write pivot reveals a specialized workflow;
- an explicit `/skill` or `use_skill` request names a skill.

The system should not run expensive discovery after every tool result.

## 11. Namespacing

Installed plugin skills use a stable namespace:

```text
plugin@marketplace:skill
```

This prevents identical skill names from different marketplaces from colliding. Explicit namespace requests bypass relevance ranking but remain subject to availability and security policy.

Commands and agents use the same collision-safe namespace strategy.

## 12. CLI/TUI behavior

The terminal UI exposes:

```text
/plugins
/marketplace
/skills
```

The manager provides:

- browse/search;
- inspect package metadata;
- install/update/remove;
- enable/disable;
- trust confirmation;
- dependency status;
- validation errors;
- installed versus available state.

The TUI displays compact metadata on narrow terminals and avoids full-screen takeover for ordinary management actions.

## 13. Runtime activation

Activation remains deterministic:

```text
installed records
     ↓
validate enabled state
     ↓
resolve component roots
     ↓
load commands/agents/skills/MCP/hooks
     ↓
register into existing registries
```

A broken plugin contributes no active executable components. The plugin record remains inspectable so the user can diagnose or repair it.

## 14. MCP integration

Plugin-provided MCP servers are configured through the existing MCP client. The plugin package does not get a private transport or bypass the normal permission policy.

MCP component names are qualified and collision-safe. Server failures degrade to diagnostics rather than taking down unrelated tools or plugins.

## 15. Hooks

Hooks must use declarative matching and the existing permission/event machinery. A manifest must not turn a plugin hook into an unrestricted shell execution path.

Future hook expansion should include:

- lifecycle event filters;
- bounded input/output contracts;
- explicit cancellation behavior;
- durable error records.

## 16. Package schema evolution

The plugin schema must remain forward-compatible without becoming permissive at execution boundaries.

For schema changes:

1. parse and validate at the manifest boundary;
2. normalize to one internal representation;
3. preserve unknown metadata where useful;
4. reject unsafe executable components early;
5. add round-trip tests for persisted records;
6. keep migration explicit when stored state changes shape.

## 17. Remaining engineering work

The remaining plugin/skill roadmap is deliberately incremental:

- richer registry search and ranking;
- better dependency-version constraints;
- transactional package replacement with recovery logs;
- more detailed hook lifecycle records;
- project/user/local scope diagnostics;
- package provenance and digest inspection in the TUI;
- optional remote skill catalogs with explicit trust policy;
- richer background update reporting.

None of these requires a second runtime authority.
