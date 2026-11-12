# Phase 14H — Context, memory, instructions, and skill continuity research

**Status:** Implementation in progress. This is an adaptation record, not a completion report.

## Architectural decision

Extend TermAgent's existing context budget, durable context checkpoint, exploration state, evidence ledger, file-read state cache, hierarchical instruction loader, and descriptor-first skill catalog. Do not add a separate memory store or copy an upstream runtime wholesale.

## Upstream patterns studied

### OpenCode

Reviewed `packages/core/src/session/compaction.ts` at commit `644d41f37a56a3bb4df096dc52d20d1ad919a3e6`:

- Context ceiling is resolved from the active model limits, with a separately reserved output/summary budget.
- The default compaction reserve is a share of the effective model window with a minimum reserve. The implementation explicitly protects enough room for a final response and the compaction summary.
- Automatic compaction can precompute a summary off the critical path, while retaining it until the actual compaction boundary so prompt-cache reuse is not needlessly broken.
- Compaction can progressively shorten old history: full transcript first, then clipped tool outputs, then removed tool outputs/clipped inputs, then user-only text, and finally omission. This is more controlled than truncating one arbitrary prefix.
- Its summary is structured around objective, requirements, decisions, work state, completed/active/blocked work, next move, relevant files, and important context.
- Machine/session history is not equivalent to the prose summary. The summary explicitly excludes repository/setup instructions because current instruction sources are loaded separately.

Also reviewed `packages/core/src/session/prompt.ts`: explicitly attached skill IDs are resolved through the skill service and `Skill.prepare`; full skill contents are materialized only for skills selected for the prompt. This supports progressive disclosure rather than putting every skill body into every request.

Source: https://github.com/anomalyco/opencode/blob/644d41f37a56a3bb4df096dc52d20d1ad919a3e6/packages/core/src/session/compaction.ts

### OpenClaude 0.31.0

Reviewed the supplied `openclaude-main` archive, especially:

- `src/services/compact/autoCompact.ts`
- `src/services/compact/compact.ts`
- `src/services/compact/postCompactCleanup.ts`
- `src/services/compact/apiMicrocompact.ts`
- `src/services/compact/cachedMicrocompact.ts`
- `src/utils/context.ts` and model-limit resolution paths
- `src/tools/SkillTool/SkillTool.ts` and `src/tools/SkillTool/prompt.ts`
- `src/commands/context/context.tsx` and `src/commands/ctx_viz/ctx-noninteractive.ts`

Useful patterns:

- Resolve effective context from the active model/runtime limits and reserve model output capacity separately.
- Use a threshold buffer that cannot become negative on small contexts. This guards against auto-compaction triggering on every message due to bad limit arithmetic.
- Track automatic-compaction failures and use a cooldown/circuit breaker to avoid retry storms when the context cannot be compacted successfully.
- Separate context-window display from the lower auto-compaction threshold; the display should represent the actual model window, not the threshold.
- Micro-compaction and post-compaction cleanup are separate stages from full summary compaction.
- Keep explicit skill bodies bounded against the active context window.

OpenClaude's model context metadata is not a reason to assume every compatible endpoint has the same window. TermAgent must resolve the active provider/model/route and surface provenance, not borrow a global vendor number.

### LaudaCode

Reviewed `Anon4You/Laudacode` source:

- `src/budget.rs` uses a model-aware fraction of the configured context window for automatic compaction.
- `src/agent.rs` has a simple structured compaction summary, but its 300-word summary and transcript character cap are much less expressive than OpenCode's structured retained-tail approach.
- `src/agent.rs` and `src/skills.rs` use descriptor-first skills: skill names/descriptions are listed; full content is read only when relevant.
- `load_agents_md()` uses bounded AGENTS.md input (global plus selected ancestors, with a local override) rather than blindly appending every instruction file.
- `config.example.toml` exposes a configurable context window and defaults to 128K when not configured.

LaudaCode is useful as a lightweight Termux implementation reference, not as the target for TermAgent's multi-client durable state or compaction richness.

Source: https://github.com/Anon4You/Laudacode

## TermAgent baseline found in the 14F6 source

Several capabilities already existed and should not be rebuilt:

- `src/context/model-limits.ts` resolves input window and output cap separately. Input precedence is explicit config, provider profile, provider/model `extra.contextWindow`, then labelled 128K conservative fallback. Output cap supports profile/metadata and the adapter's `maxTokens` compatibility setting.
- `src/context/budget.ts` shares a request-budget model for messages and schemas, and scales repository map/retrieval budgets with the model window while retaining hard resource ceilings for mobile memory safety.
- `src/agent/compaction.ts` already contains micro-pruning, full compaction, complete tool-call/result group preservation, and structured machine state checkpointing.
- `src/context/state.ts`, `src/context/exploration.ts`, and `src/context/evidence-ledger.ts` already preserve durable non-prose task/exploration/evidence state.
- `src/context/instructions.ts` already loads global and root-to-workspace instructions, discovers nested instruction scopes for paths touched by tools, and restores saved paths only from allowed roots.
- `src/skills/invoker.ts` and the skill catalog already implement descriptor-first discovery, explicit full-body loading, digest checks, and skill load/skip events.

A correction is important: the Phase 14F6 `environmentDefaults()` does **not** set a global 12,000-token context window. The old `.termagent-example.json` did explicitly set `maxContextTokens: 12000`; an existing local config can still contain that intentional override. `maxContextMessages`, `maxContextBytes`, `contextRecentTokens`, and `repoMapTokens` default to zero in source. The old message-count field is now deprecated/ignored. A screenshot showing `ctx 5k/12k` must be diagnosed from the actual selected config and `/context` provenance, not treated as proof of a global code default.

## Changes made in the current Phase 14H implementation pass

1. Removed the fixed 12K context ceiling from `.termagent-example.json`; existing explicit local overrides remain user-controlled.
2. Improved `/context` so the active model, endpoint (without query/credentials), effective input/output limits, source provenance, estimate, usable/remaining tokens, compaction threshold/target, recent-turn target, message/tool breakdown, and repository allocations are visible.
3. Corrected output-limit provenance so legacy adapter `maxTokens` is labelled `adapter-config`, not provider-profile metadata.
4. Added bounded durable read-coverage restoration to the existing `FileReadStateCache`: workspace/scope and realpath containment, stat and content SHA-256 revalidation, line-count validation, bounded file/total scan sizes, and bounded restored content. Oversized files/lines are skipped without losing subsequent line-number alignment.
5. Reused existing `ContextMachineState` checkpoints to save up to 64 read-state entries and restore them at the start of a new `Agent.run`, including across ordinary turn boundaries. Rehydrated evidence is separately limited before it enters model context.
6. Fixed a loaded-skill continuity bug: when a previously loaded skill is restored from durable `skill.load` state, the section allocator now gives it the explicit-skill budget even if the new turn does not contain a fresh explicit invocation.
7. Added regression tests for context provenance, 128K-to-1M budget scaling without removing device hard caps, sample configuration, safe read-state restore, nested instruction path restoration, skill restoration, and Anthropic cache-token occupancy.
8. Fixed stale tests that instantiated `ToolRegistry` without its required `PermissionGate`; adjusted a compact-fit fixture so the irreducible system prompt itself fits the intentionally tiny test window.

## Remaining work before the 14H gate

- Verify a complete request footprint against each active route, including all provider-specific framing and non-text costs; current estimator is conservative and cannot replace a native tokenizer.
- Improve compaction diagnostics and prove the staged behavior against the supplied 759-event workload (50 compactions), including a clean equivalent run. Record measured prompt usage, estimate drift, compaction count, retained tail, and repeated exploration.
- Review summary quality and preservation of all actionable state through multiple successive compactions. The current machine state is retained; the remaining work is demonstrating quality and avoiding unnecessary compaction/recompaction.
- Add large-repository cold/warm benchmarks and ensure repository indexes are reused without dumping the full map into the request.
- Exercise nested instructions and loaded skills through daemon restart and subagent scope boundaries, with conflict/precedence cases and near-budget behavior.
- Measure Termux memory/latency impact with realistic repositories. The streaming restore limits in this pass are host-tested only; physical Android/Termux validation remains required.

## Current verification record

- TypeScript build: passed after the Phase 14H source changes.
- Focused Phase 14H/context/read-state/compaction/repository/skill suites: **114 passed, 0 failed** in the most recent run.
- Full repository `npm test`, package/release verification, replay of the supplied session workload, and physical Termux/mobile tests have not yet been run as part of this resumed pass. Phase 14H is therefore **not complete**.


## 2026-11-05 — Provider usage normalization and context telemetry

This slice extends the existing provider adapters and Agent usage callback. It does not create a separate token-meter subsystem.

### OpenCode pattern inspected

Inspected the OpenCode `openai-chat` protocol implementation at `packages/ai/src/protocols/openai-chat.ts` (repository revision `dev` during this research pass). Its usage mapper accepts the Chat Completions fields `prompt_tokens`, `completion_tokens`, and `total_tokens`; reads cached-token variants from nested `prompt_tokens_details.cached_tokens` and provider aliases such as `prompt_cache_hit_tokens`, `cached_tokens`, and `cache_read_input_tokens`; reads cache writes from `prompt_tokens_details.cache_write_tokens` and `cache_created_input_tokens`; and extracts `completion_tokens_details.reasoning_tokens`. It also handles usage attached to the first choice, not only top-level usage. TermAgent adapted those normalization patterns inside `src/providers/openai-compatible.ts` and additionally accepts `input_tokens` / `output_tokens` and their nested detail aliases for compatible gateways that expose a Responses-like usage object on this route.

The OpenAI API reference confirms that Chat Completions usage totals are prompt + completion, cache fields are prompt details, and reasoning tokens are completion details. Streaming with `stream_options.include_usage` sends a final usage chunk with an empty `choices` array; an interrupted stream may not deliver that chunk. This is why the adapter reads top-level usage even when there is no first choice. Sources: `https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create` and `https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events`.

### OpenClaude pattern inspected

Inspected the supplied OpenClaude 0.31.0 source archive, notably `src/tasks/LocalAgentTask/LocalAgentTask.tsx`, `src/utils/tokens.ts`, and `src/utils/analyzeContext.ts`. Its usage/progress UI treats Anthropic's `input_tokens` as uncached input and adds `cache_creation_input_tokens` plus `cache_read_input_tokens` to calculate effective input occupancy. TermAgent preserves the same distinction through `ProviderUsage.cacheTokensExcludedFromInput`; `src/agent/agent.ts` adds those cache counts once and avoids adding them again when the adapter already supplies an inclusive `totalTokens`.

Anthropic's published API usage schema reports `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` as separate fields. Source: `https://docs.anthropic.com/en/api/messages`.

### Gemini usage semantics

Google's `UsageMetadata` definition states that `promptTokenCount` is the effective prompt size including cached content, `cachedContentTokenCount` is a subset of that prompt, `candidatesTokenCount` counts response candidates, `thoughtsTokenCount` counts thinking output, and `totalTokenCount` is prompt + thoughts + response candidates. TermAgent now includes thoughts in normalized output and keeps cached prompt tokens as a breakdown rather than adding them again. The adapter's current `ProviderUsage` shape does not yet expose `toolUsePromptTokenCount` or modality detail arrays, so complete Gemini-specific accounting for those fields remains open instead of being guessed. Source: `https://ai.google.dev/api/generate-content`.

### TermAgent adaptation and limits

- `src/providers/openai-compatible.ts`: normalize top-level or choice-level usage, standard field names, nested cached/reasoning details, and compatible aliases.
- `src/providers/gemini.ts`: map prompt/cache/candidate/thinking/total fields using the documented inclusive semantics.
- `src/providers/anthropic.ts`: preserve the separate-cache accounting contract.
- `src/agent/agent.ts`: derive effective input, uncached input and total without cache double counting; clear usage from a failed retry attempt before the next attempt.
- `src/cli/repl.ts`: `/context` reports the latest provider usage, estimated input, drift and cache/reasoning breakdown. This snapshot is in-memory and does not survive process restart.

Focused tests cover OpenAI-compatible alias mapping, Gemini cache/thinking accounting, Anthropic inclusive totals, and retry-attempt telemetry isolation. This work improves provider-reported accounting but does not turn the local character/token heuristic into a provider tokenizer. Full multimodal input, provider framing, tool-use prompt tokens, incomplete streams with absent final usage, and persistent usage history still require follow-up.


## 2026-11-06 — Staged tool-result micro-pruning safety

A targeted follow-up review compared TermAgent's existing `microPruneToolResults()` with OpenClaude 0.31.0 `src/services/compact/apiMicrocompact.ts` and OpenCode `packages/core/src/session/compaction.ts` at revision `324c89dd63854eb7e0132733645f7a46ef5a71e8`.

OpenClaude's API microcompaction is selective: its `clear_tool_uses_20250919` strategy targets configured read-result tools and can separately clear tool-use inputs. OpenCode's transcript compaction uses explicit shortening levels: complete transcript, clipped tool outputs, omitted tool outputs with clipped tool inputs, user-only clipped text, then omission. These patterns support staged rather than indiscriminate reduction.

TermAgent now adapts the selective part at the existing compaction primitive. It only replaces a result when all conditions hold: the tool registry marks the tool both `risk: 'read'` and `readOnly: true`; the result belongs to an older, non-protected turn; the lifecycle is completed with a successful outcome; and the full result has a syntactically valid durable `tool-output://<sha256>` reference. Shell/write/plugin results without an explicit read-only contract, failed/deferred/interrupted results, recent turns, and unarchived output remain verbatim. The marker identifies the tool and call and includes the full-output reference. Prune markers are idempotent across subsequent compaction passes.

This does not remove the durable session event or managed output file. It changes only the active prompt projection. The full-output reference remains available through `read_file` paging. Regression tests cover the successful read-only path, recent-pair retention, shell/write protection, missing durable reference, failed lifecycle protection, and repeat-prune idempotence.


## 2026-11-06 — Durable usage event adaptation

OpenCode's provider adapters preserve normalized usage at the adapter boundary and its agent-side usage tracker distinguishes per-call input context from output aggregated across multiple model calls. TermAgent already exposes normalized `ProviderUsage`, a `SessionStore` append-only event log, and a provider usage callback. The implementation now connects those existing primitives: a compact `session.provider.usage` durable event is appended for each completed provider round, and the latest valid event is restored on session resume and active-session changes for `/context`; forked children use their own event history and do not inherit a measurement for a different branch.

The event is deliberately not a copy of raw provider metadata. It persists bounded numeric token counts, estimator drift, context-limit provenance, sanitized modality groups, provider/model labels, timestamp and turn/round identity. Credentials, endpoints, raw request bodies and unbounded upstream payloads are excluded. This follows the useful distinction between durable usage snapshots and raw provider responses without introducing a separate telemetry database. It is not yet an aggregate analytics ledger or a source of provider-native tokenization truth.


## 2026-11-09 — request-footprint compaction alignment

The next implementation slice adapts two upstream ideas while retaining TermAgent's existing architecture:

- OpenClaude's automatic compactor separates the effective model window from the lower compaction threshold and treats output capacity as a reserve. Its context breakdown groups contributors so the trigger is explainable.
- OpenClaude's micro-compaction keeps result pruning distinct from transcript summarization. TermAgent continues to use its existing selective `microPruneToolResults()` stage and only prunes archived, successful, old read-only outputs.
- OpenCode's session compaction and request protocol accounting reinforce that the active request, not a text-only approximation of conversation history, is what must fit the route budget.

TermAgent now routes automatic-compaction decisions through its existing `accountContext()` calculation. It subtracts schema, additional-request, and estimated multimodal costs before assigning the text-history budget that the current compactor can actually shorten. Trigger provenance is explicit. Durable start/completion events include a component breakdown and before/after headroom, and `/context` projects the most recent completed automatic compaction.

This is a more consistent estimator path, not exact wire-size accounting. `accountContext()` still relies on local estimates; provider framing, native tokenization, and real multimodal payload accounting remain incomplete. A synthetic optional image estimate tests the existing accounting hook; the current chat-message transport model does not establish end-to-end image attachment support.

The same continuation added a true `Agent.run()` nested-instruction restart test and expanded repository-map stress from 1,000 to 10,000 synthetic modules (10,002 indexed paths). On 2026-11-09, the Phase 14H continuity file passed 16/16; the complete repository suite passed 716/716 both at four-worker and serial concurrency; build and distribution verification passed. This remains host evidence only.

## 2026-11-09 — Provider-native input-count preflight

A follow-up source review compared OpenCode `packages/core/src/util/token.ts` and OpenClaude 0.31.0 `src/services/tokenEstimation.ts`. OpenCode intentionally uses a dependency-free four-characters-per-token estimate in its shared helper. OpenClaude keeps that kind of rough fallback but uses Anthropic's native Messages count endpoint when the provider client exposes it; the count path includes tools and thinking when supported. The useful adaptation is an optional native request count at the provider boundary, not a heavyweight tokenizer dependency in TermAgent's core.

TermAgent now adds optional `Provider.countTokens()` implementations to the existing Anthropic and Gemini adapters. Each count path reuses the adapter's generation request-lowering helper, then keeps only the input fields accepted by the corresponding native count endpoint. The Agent invokes it only when the local request estimate reaches 72% of usable capacity, uses the larger of local/native counts for conservative admission, passes the pre-compaction native count into the existing compaction diagnostic, and performs a fresh count on the compacted projection before generation. Unsupported endpoint responses (404/405/501) are cached for that provider instance; request-specific 400s and transient network/server failures fall back without permanently disabling the feature; 401/403 remain fail-fast.

Anthropic uses `POST /v1/messages/count_tokens` (`input_tokens`); Gemini uses `POST /v1beta/models/{model}:countTokens` (`totalTokens`). OpenAI-compatible gateways retain local estimation because the Chat Completions shape has no universal count endpoint. This does not yet provide a native tokenizer for those routes. The canonical TermAgent `ChatMessage` currently has string content plus tool calls/results; it does not represent media attachment parts, so no claim is made that native multimodal APIs can count media which TermAgent cannot yet send. Provider-specific framing, hidden transformations, and exact media costs remain open.

References: [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting), [Gemini token counting](https://ai.google.dev/gemini-api/docs/tokens), [OpenCode token estimate](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/util/token.ts).

