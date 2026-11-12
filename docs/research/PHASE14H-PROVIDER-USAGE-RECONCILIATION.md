# Phase 14H — Provider usage reconciliation

**Status:** Implemented and host-regression-tested; optional Anthropic/Gemini native input-count preflight is now integrated. OpenAI-compatible tokenization, exact wire/framing and live multimodal accounting remain open.

## Why this slice was needed

TermAgent already normalized basic usage for OpenAI-compatible, Gemini, and Anthropic streams, but the native protocols do not share one accounting convention. A single `inputTokens + outputTokens` interpretation was insufficient for Anthropic server-side iterations and Gemini tool-use prompt tokens. The adapter boundary is the correct owner because each adapter already translates provider-native wire events into TermAgent's `StreamEvent` contract.

## Upstream patterns inspected

At OpenCode revision `324c89dd63854eb7e0132733645f7a46ef5a71e8`:

- `packages/ai/src/protocols/openai-chat.ts` maps Chat usage fields, cache aliases (`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, `cached_tokens`, `cache_read_input_tokens`), cache-write aliases, and nested reasoning-token details. It also checks usage attached to the selected choice.
- `packages/ai/src/protocols/anthropic-messages.ts` sums per-iteration input/cache/output and reasoning usage; derives total billed input by adding non-cached, cache-read, and cache-write counts; and keeps last-iteration context occupancy separate. It merges the final `message_delta` snapshot over the initial `message_start` usage instead of double-counting two snapshots.
- `packages/core/src/plugin/provider/claude-agent/language-model/usage.ts` tracks maximum counters for successive snapshots of the same request and uses the final API request's input as context occupancy, while summing outputs across distinct message IDs.

References:

- https://github.com/anomalyco/opencode/blob/324c89dd63854eb7e0132733645f7a46ef5a71e8/packages/ai/src/protocols/openai-chat.ts
- https://github.com/anomalyco/opencode/blob/324c89dd63854eb7e0132733645f7a46ef5a71e8/packages/ai/src/protocols/anthropic-messages.ts
- https://github.com/anomalyco/opencode/blob/324c89dd63854eb7e0132733645f7a46ef5a71e8/packages/core/src/plugin/provider/claude-agent/language-model/usage.ts

The supplied OpenClaude 0.31.0 source was also reviewed earlier for cache-aware usage, compaction reserves, and model-aware context accounting. No parallel provider-usage service was added.

## TermAgent adaptation

### Anthropic Messages

The existing `AnthropicProvider` now deep-merges the streaming `message_start` and `message_delta` usage snapshots, with the final delta taking precedence when it supplies a field. This matters because the initial event can have zero output while the final event carries the completed output and cache counters. If `iterations` is present, input/cache/output/reasoning counts are summed across iterations for billed turn totals. `contextTokens` is calculated from the final iteration only, because aggregate internal iterations are not the final prompt occupancy. Anthropic `inputTokens` remains the non-cached amount and `cacheTokensExcludedFromInput` remains true; the Agent adds cache counts once.

### Gemini

Google's `UsageMetadata.totalTokenCount` is documented as the sum of prompt, candidate, tool-use-prompt, and thought tokens. Prompt count includes cached content; the cached count is a subset. TermAgent now includes `toolUsePromptTokenCount` on the input side, includes thoughts in output, trusts the supplied total when present, and retains available prompt/cache/candidate/tool-use modality breakdowns.

Official reference: https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/GenerateContentResponse

### Context, estimator, and durable telemetry

`ProviderUsage` now carries optional final-request context occupancy, tool-use prompt counts, and a structured modality breakdown. The `/context` report displays these fields where supplied. For Anthropic multi-iteration accounting, estimator drift uses final-request context occupancy instead of aggregate billing input. The live UI's context meter uses the same occupancy field when it is available.

The Agent now appends a `provider.usage` event through the existing `SessionStore` after each completed provider round. The report is normalized and bounded before persistence: finite non-negative token counts, limited provider/model/source strings, four recognized modality groups with at most 12 entries each, and constrained keys. It stores no endpoint, API key, raw request/response body, or provider metadata. The event is durable and provider-categorized but does not enter the conversation-message projection. `/context` restores the newest valid event when a session is resumed; switching to a forked child checks the child's own history rather than carrying a measurement across branches. If appending usage telemetry fails, the Agent reports a status warning without aborting a successful turn. This provides durable per-request history, not aggregate billing analytics or native tokenization truth.

### Provider-native input-count preflight (2026-11-09)

The upstream review distinguishes two useful patterns. OpenCode keeps its shared token helper intentionally lightweight (`packages/core/src/util/token.ts`: approximately four characters per token), so a local estimate remains cheap and dependency-free. The supplied OpenClaude 0.31.0 `src/services/tokenEstimation.ts` adds an optional Anthropic `messages.countTokens` call for a native request count, while retaining a rough fallback when the API is unavailable. TermAgent adapts the optional provider-boundary approach rather than importing a tokenizer stack or replacing `accountContext()`.

TermAgent's `Provider` contract now has an optional `countTokens(messages, tools, signal)` capability. The Anthropic adapter posts to `/v1/messages/count_tokens` and reads `input_tokens`; the Gemini adapter posts to `/v1beta/models/{model}:countTokens` and reads `totalTokens`. Both adapters reuse the same request-lowering helper as generation, then remove generation-only fields that are not part of input counting. The count requests include the provider-native message shape, system instructions, and tool declarations supported by each endpoint. Gemini also preserves `cachedContent` when present.

The Agent calls the native counter only when the local request estimate reaches 72% of the effective usable context budget. This avoids an extra network round trip on ordinary small turns. The effective preflight occupancy is the larger of the local estimate and provider count; this is deliberately conservative. If the native count pushes the request over budget, the existing compaction owner receives the extra request-token delta, compacts, then the Agent recounts the projected post-compaction request before generation. Durable compaction start diagnostics retain the pre-compaction provider count; the post-compaction diagnostic does not reuse that stale value.

Unsupported endpoints are remembered per provider instance for HTTP 404/405/501. A request-specific HTTP 400 is not cached as permanent capability failure. Network/transient server failures fall back to the local estimate. Authentication failures (401/403) remain fail-fast, and cancellation follows the request signal. OpenAI-compatible providers keep the local estimate because Chat Completions has no universal count-token endpoint shared by gateways.

This is a native **input-count API**, not a downloaded/model-family tokenizer. The canonical `ChatMessage` contract currently carries text content and tool interactions, not image/audio/video attachment parts. Although the provider APIs themselves can count some multimodal inputs, this TermAgent slice does not claim live multimodal transport or exact non-text payload accounting. Provider-specific hidden framing, unsupported gateway extensions, and request schemas outside the supported count endpoint fields remain limitations.

Official endpoint references: [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) and [Gemini token counting](https://ai.google.dev/gemini-api/docs/tokens). Upstream implementation references: [OpenCode token estimate](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/util/token.ts) and OpenClaude 0.31.0 `src/services/tokenEstimation.ts`.

## Regression coverage

Added/extended tests verify:

1. Anthropic final streaming usage replaces initial input/cache/output/reasoning snapshot values without double counting.
2. Anthropic beta iteration usage sums turn billing but preserves final iteration context occupancy.
3. Gemini tool-use prompt tokens contribute to input/total usage and are displayed separately.
4. Gemini modality details are normalized by modality for prompt, cache, candidates, and tool-use prompt.
5. Existing OpenAI-compatible alias/choice-level mapping and retry-usage isolation remain covered.
6. Durable usage-event kind/category, reload behavior, separation from message projection, exclusion of API key material, modality sanitization, and fallback past malformed newest records are covered by Phase 14H tests.
7. Native count preflight covers Anthropic/Gemini request lowering, message/system/tool inclusion, count result normalization, unsupported-endpoint caching, non-cached request-specific 400s, fail-fast authentication, near-budget invocation, post-compaction recount, and exclusion of stale pre-compaction counts from completion diagnostics.

## Remaining limitations

- No provider-specific tokenizer package is integrated. Anthropic and Gemini now have optional native input-count preflight; OpenAI-compatible and custom gateways without a compatible endpoint use the local estimator.
- Modality counts are retained when providers send them, but TermAgent does not yet compute exact image/audio/video token estimates from request payloads.
- Native count endpoints include supported tool and system-input costs, but HTTP/SSE framing and provider-specific hidden prompt transformations are not universally exposed or reconciled. TermAgent does not yet have live image/audio/video attachment parts in its canonical ChatMessage contract.
- `/context` restores the latest completed per-request report, but aggregate historical usage analytics are not yet implemented.
- The historical JSONL logs do not include provider usage or the exact original request payloads, so no reliable tokenization/latency A/B replay can be made from them.

This slice narrows the usage-accounting gap but does not close Phase 14H.
