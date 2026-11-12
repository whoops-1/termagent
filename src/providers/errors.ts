export type ProviderErrorHeaders = Record<string, string>

export class ProviderHttpError extends Error {
  readonly code = 'PROVIDER_HTTP'
  readonly status: number
  readonly headers: ProviderErrorHeaders
  readonly responseBody: string
  readonly retryAfterMs?: number

  constructor(status: number, responseBody: string, headers: ProviderErrorHeaders = {}) {
    super(`Provider HTTP ${status}: ${responseBody.slice(0, 2000)}`)
    this.name = 'ProviderHttpError'
    this.status = status
    this.headers = { ...headers }
    this.responseBody = responseBody
    this.retryAfterMs = parseRetryAfter(this.headers)
  }
}

export class ProviderStreamIdleError extends Error {
  readonly code = 'PROVIDER_STREAM_IDLE'
  readonly idleTimeoutMs: number
  readonly safeToRetry: boolean

  constructor(idleTimeoutMs: number, safeToRetry: boolean) {
    super(
      safeToRetry
        ? `Provider stream idle timeout after ${idleTimeoutMs}ms`
        : `Provider stream stalled after partial output (${idleTimeoutMs}ms idle); retry suppressed to avoid duplicate output`,
    )
    this.name = 'ProviderStreamIdleError'
    this.idleTimeoutMs = idleTimeoutMs
    this.safeToRetry = safeToRetry
  }
}

export function parseRetryAfter(headers: Headers | ProviderErrorHeaders, now = Date.now()): number | undefined {
  const get = (name: string) => headers instanceof Headers ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()]
  const retryAfterMs = get('retry-after-ms')
  if (retryAfterMs) {
    const value = Number.parseFloat(retryAfterMs)
    if (Number.isFinite(value) && value >= 0) return Math.min(value, 2147483647)
  }

  const retryAfter = get('retry-after')
  if (!retryAfter) return undefined
  const seconds = Number.parseFloat(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), 2147483647)

  const at = Date.parse(retryAfter)
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - now), 2147483647)
  return undefined
}

export function responseHeaders(response: Response): ProviderErrorHeaders {
  return Object.fromEntries(response.headers.entries())
}

/** Detect provider responses that explicitly reject the prompt for exceeding its context limit. */
export function isProviderContextOverflowError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: unknown; code?: unknown; message?: unknown; responseBody?: unknown }
  const status = Number(value.status)
  if (![400, 413, 422].includes(status)) return false
  const text = `${String(value.code ?? '')} ${String(value.message ?? '')} ${String(value.responseBody ?? '')}`.toLowerCase()
  return /context[_ -]length[_ -]exceeded|maximum context(?: length)?|context window (?:is )?(?:exceeded|too small)|prompt (?:is )?too long|input (?:is )?too long|too many tokens|token limit (?:exceeded|reached)|request (?:exceeds|exceeded) (?:the )?(?:model )?context|prompt_too_long/.test(text)
}
