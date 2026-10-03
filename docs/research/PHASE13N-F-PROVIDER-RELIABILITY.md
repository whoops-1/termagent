# Phase 13N-F — Provider Reliability

## Status

`[verified]` at the provider reliability contract level.

The dedicated Phase 13N-F suite passes 9/9. The combined focused Phase 13M/P4/P6/P7 + 13N-A/B/C/D/E/F + provider-adapter gate passes 67/67. `npm run build` passes.

The repository-wide aggregate `npm test` runner remains a separate known gate because long-lived process tests prevent the current multi-file runner from completing cleanly. Physical ARMv7/Termux execution is unavailable on the x86_64 verification host.
This phase was implemented after reviewing the provider runtime reliability behavior and the failure modes captured during the reliability investigation.

TermAgent's session retry layer uses explicit retryable-error classification, honors server-provided retry headers, uses exponential backoff with jitter, and treats context overflow as non-retryable. Its processor also accumulates streamed tool-call deltas incrementally and refuses to trigger a provider fallback after a stream has already emitted content. The implementation here adapts those ideas to TermAgent's existing Promise/AsyncGenerator provider architecture instead of importing the runtime stack.

TermAgent's provider layer has a substantially richer retry matrix and an explicit stream-idle watchdog. Its historical OpenAI-provider retry defect also demonstrates why a provider adapter must expose structured status/header information rather than throw an opaque plain `Error`. The current TermAgent implementation therefore keeps the error contract provider-agnostic at the retry layer while retaining raw provider metadata for the lifecycle layer.

## Implemented changes

### Typed provider errors

the relevant TermAgent subsystem adds:

- `ProviderHttpError` with HTTP status, response headers, response body, and parsed `retryAfterMs`.
- `ProviderStreamIdleError` with idle duration and a `safeToRetry` flag.
- `parseRetryAfter()` handling `retry-after-ms`, delta-seconds, and HTTP-date forms.

OpenAI-compatible, Anthropic, and Gemini adapters now throw `ProviderHttpError` for non-2xx responses.

### Cancellation-aware retry

the relevant TermAgent subsystem now:

- accepts an `AbortSignal`.
- cancels backoff waits immediately when the signal aborts.
- supports deterministic jitter injection for tests.
- honors `retryAfterMs` before exponential backoff.
- refuses retries for explicit aborts and unsafe partial-stream failures.

### Stream-idle watchdog

the relevant TermAgent subsystem now supports a bounded idle timeout. The default is 90 seconds and can be overridden with `streamIdleTimeoutMs`; zero disables the watchdog.

The watchdog is per-read, so every received chunk/data payload resets the effective silence window. A stream that stalls before emitting any payload is marked safe to retry. A stream that has already emitted provider data is marked unsafe to replay automatically.

`Agent.run()` surfaces the stalled-stream error through its existing status callback, so the terminal activity layer can render a concrete provider-stall state rather than appearing frozen.

### Partial-output replay safety

The previous retry path could clear the local accumulation buffers and replay a complete provider response after partial output had already been sent to the UI. That creates duplicate visible text/reasoning.

13N-F makes partial-stream failures non-retryable. The caller receives the explicit failure instead of silently duplicating streamed content.

### Opaque provider metadata

Provider tool metadata remains typed as `unknown` at the shared boundary. No provider-specific fields are normalized into a generic schema merely for convenience. Tool lifecycle persistence continues to round-trip nested arrays/objects without dropping keys.

### Reasoning isolation

Reasoning controls remain provider-specific:

- OpenAI-compatible: `reasoning_effort`.
- Anthropic: `thinking` with an adapter-specific budget.
- Gemini: `generationConfig.thinkingConfig`.

Tests assert the controls do not leak across wire formats.

## Context-budget comparison

TermAgent currently uses a deterministic global default:

- `maxContextTokens = 12000`
- `compactionThreshold = 0.82`
- `contextReserveTokens = 768`
- default `maxOutputTokens` reserve in the budget helper = `2048`

Therefore the default usable request budget is:

`floor(12000 × 0.82) - max(2048, 768) = 9840 - 2048 = 7792`

This value is a **working budget**, not a claim that the selected model has a 12K provider context window.

TermAgent's context-overflow calculation derives its usable threshold from model metadata: it uses `model.limit.input` when available, otherwise the model's context limit, then subtracts a dynamic output reservation. The resulting design therefore adapts to models with very different context capacities rather than applying one 12K global ceiling.

TermAgent's current choice is deliberate because its context layer is provider-agnostic and must remain deterministic on ARMv7/Termux. Tool schemas, skills, repository retrieval, recovery notices, and recent context are all competing for the same bounded working window. A model-aware provider-capability layer can be added later without changing the semantic distinction between hard provider capacity and local working budget.

## Configuration

`streamIdleTimeoutMs` is now accepted on the root provider configuration and on individual saved provider profiles.

Example:

```json
{
  "streamIdleTimeoutMs": 120000,
  "providers": {
    "local": {
      "provider": "openai-compatible",
      "model": "local-model",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "streamIdleTimeoutMs": 180000
    }
  }
}
```

A value of `0` disables the stream-idle watchdog. Slow local/self-hosted providers should prefer a larger bounded value rather than disabling all protection.

## Regression coverage

`tests/phase13n-f-provider-reliability.test.mjs` covers:

1. deterministic exponential backoff;
2. server-directed `Retry-After` delay;
3. cancellation during retry backoff;
4. typed HTTP error metadata;
5. real OpenAI-compatible 429 retry using `Retry-After`;
6. pre-output versus post-output stream-idle classification;
7. suppression of unsafe partial-output replay;
8. provider-specific reasoning payload isolation;
9. nested provider metadata round-trip plus stream cancellation.

## Known limitations

This phase does not add automatic provider model discovery or model-specific context-window negotiation. It also does not implement a second streaming protocol for non-SSE providers. Those are separate capability concerns and should not be smuggled into the reliability layer merely because humans enjoy scope creep.
