# TermAgent Plugin Authoring

TermAgent plugins are manifest-driven packages. Marketplace-installed packages are treated as declarative component bundles: TermAgent can load commands, agents, skills, MCP server definitions, and hooks from a validated package without importing arbitrary JavaScript from the package.

## Package layout

```text
my-plugin/
├── .claude-plugin/plugin.json
├── commands/
│   └── check.md
├── agents/
│   └── reviewer.md
└── skills/
    └── review/
        └── SKILL.md
```

`.termagent-plugin/plugin.json` is also accepted for native TermAgent packages. Do not ship both manifests: that is rejected as ambiguous.

## Manifest

A minimal package can look like:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Project-specific review helpers",
  "commands": "./commands",
  "agents": "./agents",
  "skills": "./skills"
}
```

Component paths must start with `./` and cannot contain `.` or `..` path segments. Names and versions must use the package validation rules.

### Commands

A Markdown command may contain frontmatter and a body. It is exposed as `<plugin>:<command>` and inherits the normal TermAgent permission model.

```markdown
---
description: Check the repository state
allowed-tools:
  - read_file
  - grep
---
Inspect the repository, summarize the relevant state, and report concrete findings.
```

Manifest command mappings can also provide `description`, `argumentHint`, `model`, `allowedTools`, or inline `content`.

### Agents

Agents are Markdown definitions exposed as `<plugin>:<agent>`. The supported metadata is the same metadata TermAgent already understands for custom agents: prompt, model, tools, disallowed tools, skills, mode, and description.

### Skills

Plugin skills are prompt-only and namespaced as:

```text
<plugin>@<marketplace>:<skill>
```

The skill body is not inserted into the base system prompt. Discovery exposes metadata; the body is loaded only through the normal skill invocation boundary.

### MCP and hooks

MCP definitions use TermAgent's existing stdio shape and receive plugin provenance. Hooks are declarative command hooks routed through the existing permission gate. Never rely on arbitrary package startup code for marketplace behavior.

## Marketplace distribution

A marketplace entry refers to the plugin package with a relative source:

```json
{
  "name": "my-plugin",
  "source": "./plugins/my-plugin",
  "version": "1.0.0",
  "strict": true
}
```

Remote marketplace sources are integrity checked and may require explicit trust approval. Plugin content is copied into TermAgent's private installation cache before activation.

## Security requirements

Keep plugin packages deterministic and self-contained. Do not use symlinks to escape the package root. Do not rely on runtime network downloads. Keep secrets out of manifests, commands, agent prompts, and MCP configuration. Marketplace-installed arbitrary JavaScript is intentionally not imported by the declarative component loader.

Legacy `.js` and `.mjs` plugins remain available from local `.termagent/plugins` directories for compatibility. They are executable code, so treat them as trusted local code and review them before sharing a project.

## Test before publishing

At minimum:

```sh
npm run build
npm test
termagent --doctor
```

Then test install, enablement, discovery, invocation, update, disablement, and removal in a disposable project. Phase 11's end-to-end fixture in `tests/phase11-end-to-end.test.mjs` is the established lifecycle test in this repository.
