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

## Context capacity and memory continuity (Phase 14H)

TermAgent resolves the active request context window and output-token limit separately. The context window is the provider/model input capacity; `maxOutputTokens` and the adapter's legacy `maxTokens` are output limits. An output cap must never be interpreted as an input context window.

The context-window resolution order is:

1. `maxContextTokens` in the effective TermAgent configuration (including `TERMAGENT_CONTEXT_WINDOW` when no project/global config overrides it).
2. `contextWindow` on the selected provider profile.
3. `contextWindow` in the selected provider/model metadata (`providers.<name>.extra.contextWindow`).
4. A clearly labelled conservative 128,000-token fallback when the active route has no verified context metadata.

For example, a custom profile can provide verified route metadata explicitly:

```json
{
  "providers": {
    "my-model": {
      "provider": "openai-compatible",
      "model": "my-model-id",
      "baseUrl": "https://api.example.invalid/v1",
      "apiKeyEnv": "MY_MODEL_API_KEY",
      "contextWindow": 200000,
      "maxOutputTokens": 16000
    }
  }
}
```

The `extra.contextWindow` and `extra.maxOutputTokens` metadata fields are also accepted for catalog/provider metadata. These values must describe the selected model/route, not a generic vendor maximum. TermAgent does not assume that an unknown endpoint supports a one-million-token context. Use `/context` to inspect the active provider/model, sanitized endpoint, context-window source, output-limit source, estimated request footprint, usable budget, compaction threshold, recent-turn target, and repository-map/retrieval allocations.

`maxContextTokens` is an intentional hard override. If a previous local `.termagent/config.json` still contains `"maxContextTokens": 12000`, that value continues to cap the selected route until it is removed or changed. The current `.termagent-example.json` no longer imposes a fixed 12,000-token limit. Environment defaults are merged first; a project/global config file overrides them.

`contextRecentTokens`, `repoMapTokens`, and `maxContextBytes` set explicit allocations when positive; `0` or omission selects automatic, model-aware allocation. Repository indexing/map/retrieval still has independent hard caps on paths, files, bytes, and prompt tokens to protect long-lived Termux/mobile processes. Those resource-safety bounds are not a cap on the model's total input context. `maxContextMessages` is deprecated and ignored; history retention and compaction are token-budget driven rather than silently truncated by message count.

The context estimator is conservative and is not a provider tokenizer. Where providers report input usage, TermAgent compares the estimate with measured usage; Anthropic cache-read/cache-write token counts are included in input occupancy. Provider-specific framing and non-text payloads can still create estimation drift, so `/context` is a diagnostic estimate rather than a billing figure.

### Memory and instruction continuity

TermAgent keeps the durable session transcript separate from the bounded active provider projection. Context checkpoints retain machine-readable state such as exploration state, evidence, task/workflow state, read coverage, loaded-skill references, and instruction paths. Read coverage is restored only after workspace/scope containment, file metadata, content hash, line count, and resource limits are revalidated. Restored file ranges are rehydrated into the prompt only within a small evidence budget.

Instruction files are loaded from global roots and the root-to-workspace ancestor chain. When tools touch deeper paths, the relevant nested instruction scope is discovered and loaded before the corresponding operation proceeds. Persisted instruction paths are restored only from the workspace or approved global roots. Skills use progressive disclosure: descriptors are cheap to keep in the base prompt, full skill text is loaded only when relevant/invoked, and previously loaded skills are restored by stable ID and content digest after a new turn or compaction. Changed or unsafe content is not blindly restored.

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


### Provider-reported usage and estimator diagnostics

The provider adapters normalize their native usage fields into one `ProviderUsage` contract. The normalized input fields have provider-specific semantics, so TermAgent keeps cache subsets and final-request occupancy explicit instead of assuming every provider reports the same shape:

- OpenAI-compatible routes treat `prompt_tokens` / `input_tokens` and `completion_tokens` / `output_tokens` as inclusive totals. Cache and reasoning counters are detail subsets. Common cache aliases and usage attached to `choices[0].usage` are accepted.
- Anthropic's `input_tokens` is non-cached input. Cache-read and cache-creation input are separate and are added once when TermAgent calculates inclusive input occupancy. When the stream reports `message_start` followed by `message_delta`, the final snapshot updates the initial snapshot without double counting. Beta per-iteration usage is summed for billing, while `contextTokens` reports the final iteration's context occupancy. `output_tokens_details.thinking_tokens` is a subset of output tokens.
- Gemini's input-side usage includes `promptTokenCount` plus `toolUsePromptTokenCount`; output includes `candidatesTokenCount` plus `thoughtsTokenCount`. Cached prompt tokens are a subset of prompt input. `totalTokenCount` is preferred when supplied. Available prompt/cache/candidate/tool-use modality breakdowns are retained for `/context`.

`/context` displays only the latest completed provider report in the current process. It includes the local prompt estimate and a drift percentage, but this is a diagnostic comparison, not a billing guarantee or a provider-native tokenizer. For Anthropic multi-iteration requests the drift comparison uses final-request context occupancy rather than summing all internal iteration inputs. Usage from an attempt that fails and is retried is discarded. Durable cross-session usage history, native provider tokenizers, and complete multimodal/framing accounting are not implemented yet.
