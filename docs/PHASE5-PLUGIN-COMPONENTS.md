# TermAgent 1.12.0: Plugin Component Integration

Phase 5 connects installed marketplace plugins to TermAgent's existing runtime components without importing arbitrary remote plugin JavaScript.

## Runtime flow

```text
installed.json
    |
    v
loadInstalledPluginComponents()
    |
    +--> namespaced commands ----> CustomCommand[]
    |
    +--> namespaced agents ------> CustomAgent[]
    |
    +--> plugin MCP -------------> MCPClient -> ToolDefinition[]
    |
    +--> declarative hooks ------> PluginHookManager -> PermissionGate
```

Only records with `status: "installed"` are activated. The loader checks that the installed path remains inside the TermAgent plugin cache and that `.claude-plugin/plugin.json` names the same plugin recorded in `installed.json`.

## Commands

Commands are discovered from the default `commands/` directory and manifest-declared command paths. Names are namespaced as:

```text
<plugin>:<relative-command-path>
```

Manifest command mappings can provide a description, model, argument hint, allowed tools, or inline content. Plugin commands carry provenance and their `allowed-tools` list is enforced by the Agent before both schema exposure and execution.

## Agents

Agents are discovered from the default `agents/` directory and manifest-declared paths. Names are namespaced as:

```text
<plugin>:<agent-name>
```

The supported Phase 5 metadata is the subset TermAgent already understands: model, tools, disallowed tools, skills, mode, description, and prompt content. The existing Agent applies the tool allow/disallow policy even when a provider emits a tool call that was not present in the filtered schema.

## MCP

Plugin MCP is currently limited to TermAgent's existing stdio MCP shape. `.mcp.json` and manifest `mcpServers` entries become namespaced server definitions such as:

```text
plugin_<plugin>_<server>
```

MCP tools preserve plugin ID, plugin name, marketplace, and logical server name as provenance. The underlying plugin metadata is removed before the child process is launched, so MCP receives only its normal command/args/env configuration.

## Hooks

Declarative command hooks are read from `hooks/hooks.json` and manifest hook files. Phase 5 supports the lifecycle events that TermAgent can emit today, including `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, and `FileChanged`.

Hook commands receive the event context as JSON on stdin and these environment variables:

```text
CLAUDE_PLUGIN_ROOT
TERMAGENT_PLUGIN_ROOT
TERMAGENT_PLUGIN_ID
TERMAGENT_HOOK_EVENT
```

Hook execution is routed through the existing `PermissionGate` as a shell-risk operation. A failing synchronous `PreToolUse` hook prevents the underlying tool call. Post-tool and lifecycle hook failures are surfaced through status handling so one broken hook cannot destroy the agent turn.

## Trust boundary

Marketplace packages are still declarative in Phase 5. TermAgent does not import arbitrary JavaScript or MJS files from installed marketplace packages. The pre-existing `.js`/`.mjs` plugin loader remains an explicit local compatibility path.

Plugin dependency resolution and deterministic dependency ordering remain Phase 8. Trust UI and deeper supply-chain validation remain Phase 6/7 respectively.

## Verification

The Phase 5 focused suite covers namespacing, deterministic activation order, manifest/state mismatch rejection, executable-entrypoint non-import, MCP provenance, hook context and permission propagation, pre-tool blocking, command allowlists, agent disallow lists, and failure isolation.
