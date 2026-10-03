# Configuration

TermAgent reads project configuration from `.termagent/config.json` and supports environment-variable overrides for provider/runtime values.

Common settings include:

- provider and model selection
- provider profiles
- role-based routing
- approval policy
- shell and output limits
- context token limits
- compaction thresholds
- repository-map limits
- fallback providers
- plugins and MCP servers

Keep secrets in environment variables or local files excluded from version control.

## Phase 5 controls

### Keybindings

`keybinds` overrides prompt shortcuts without replacing the rest of the built-in map. Example:

```json
{
  "keybinds": {
    "agents": "alt+a",
    "variants": "ctrl+t",
    "commands": "ctrl+p",
    "history": "ctrl+r",
    "editor": "ctrl+g",
    "stash": "ctrl+s",
    "sessions": "ctrl+l"
  }
}
```

### Permission rules

`permissionRules` can allow, deny, or force an interactive prompt for individual tools. An optional `pattern` is matched against serialized arguments.

```json
{
  "approvals": "auto",
  "permissionRules": [
    { "tool": "read_*", "decision": "allow" },
    { "tool": "bash", "decision": "ask", "pattern": "*rm -rf*" },
    { "tool": "write_*", "decision": "allow" }
  ]
}
```

### Model variants

Provider profiles may define named variants with reasoning effort, temperature, output limits, and provider-specific extra request fields.

```json
{
  "providers": {
    "main": {
      "provider": "openai-compatible",
      "model": "example-model",
      "baseUrl": "https://example.invalid/v1",
      "apiKeyEnv": "TERMAGENT_API_KEY",
      "variants": {
        "fast": { "reasoningEffort": "low", "maxTokens": 2048 },
        "deep": { "reasoningEffort": "high", "maxTokens": 8192 }
      }
    }
  }
}
```

Use `/variants` to inspect configured variants and the configured variant shortcut to cycle them.

### Smart routing

Routing is opt-in and makes one simple-versus-strong model choice for the full turn.

```json
{
  "smartRouting": {
    "enabled": true,
    "simpleModel": "fast",
    "strongModel": "main",
    "simpleMaxChars": 160,
    "simpleMaxWords": 28
  }
}
```

The default is conservative: disabled routing uses the strong model. Code, non-text input, planning/reasoning keywords, long prompts, multi-paragraph prompts, and the first session turn stay on the strong path.

## Phase 13F: tool-output storage

Oversized textual tool results are persisted outside the provider context and replaced with a bounded preview containing a stable retrieval reference. This keeps the complete result available without forcing the next model request to carry the entire output.

Configuration is stored alongside the other runtime limits:

```json
{
  "toolOutputMaxLines": 2000,
  "toolOutputMaxBytes": 51200,
  "toolOutputRetentionDays": 7
}
```

`toolOutputMaxLines` and `toolOutputMaxBytes` are the default persistence thresholds. The retention setting controls how long managed `tool_*` result files are kept. The default managed directory is `~/.termagent/tool-output`; `TERMAGENT_TOOL_OUTPUT_ROOT` can override it for tests or isolated deployments.

When a result is persisted, the model receives a reference such as `tool-output://<sha256-key>`. The normal `read_file` tool accepts that reference and can retrieve a bounded line range from the complete stored result. This is deliberate retrieval, rather than automatically injecting the full output back into context.

## Phase 13H: staged compaction and context checkpoints

Context reduction is staged. TermAgent first applies the Phase 13F tool-output bound, then micro-prunes older tool-result payloads, preserves recent complete turns, and performs full summary compaction only when the request still exceeds its usable context budget.

The active provider projection is persisted as a `context.checkpoint` event. The checkpoint stores an epoch, projection hash, summary revision, machine-owned context state, and the reduced active messages. The full session transcript remains durable and is not replaced by the checkpoint.

Machine-owned state records read coverage, managed tool-output references, active task IDs, workflow state, todo state, file mutation evidence, and continuation metadata. Read coverage is revalidated against current file identity before selected line ranges are rehydrated into the next provider context.

`/compact` remains an explicit full-compaction request. Automatic context pressure follows the staged reduction path.
## Phase 13N-D: automatic post-edit verification

Post-edit verification is an opt-in declarative hook. When enabled, a successful `write_file`, `edit_file`, or `apply_patch` batch is followed by one bounded verification run through the existing durable TaskManager. The default is disabled.

```json
{
  "postEditVerification": {
    "enabled": true,
    "command": "npm run check",
    "timeoutMs": 120000,
    "maxOutputBytes": 20000,
    "tools": ["write_file", "edit_file", "apply_patch"]
  }
}
```

Omit `command` to use the same safe project-command detection used by `verify_project`. Timeouts are capped at five minutes and persisted task output remains bounded. An automatic pass is recorded as durable verification evidence for the current mutation batch, so the agent does not repeat the same verification unless explicitly requested with `force: true`.
