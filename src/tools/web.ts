import { assertPublicHttpTarget, decideNetworkTarget } from '../util/network-safety.js'
import type { WebSearchConfig } from '../config/config.js'
import type { ToolDefinition, ToolContext } from './types.js'

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_BYTES = 200_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_SEARCH_RESULTS = 8
const MAX_SEARCH_RESULTS = 20

interface WebFetchOptions {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  allowPrivateHosts?: boolean
}

interface WebSearchOptions {
  webSearch?: WebSearchConfig
  timeoutMs?: number
}

async function fetchBounded(current: string, opts: { timeoutMs: number; maxBytes: number; maxRedirects: number; allowPrivateHosts: boolean }, outerSignal: AbortSignal) {
  let target = String(current)
  const seen = new Set<string>()
  let hops = 0
  const startedAt = Date.now()

  let response: Response
  let decisionUrl: URL
  for (;;) {
    if (outerSignal.aborted) throw new Error('Network fetch interrupted')
    if (opts.allowPrivateHosts) {
      try {
        decisionUrl = assertPublicHttpTarget(target).url
      } catch (error) {
        throw error
      }
    } else {
      const decision = await decideNetworkTarget(target)
      if (!decision.ok) throw new Error(decision.reason || 'Network target rejected')
      decisionUrl = assertPublicHttpTarget(target).url
    }
    if (seen.has(decisionUrl.href)) throw new Error(`Redirect loop detected at ${decisionUrl.href}`)
    seen.add(decisionUrl.href)

    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    outerSignal.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      response = await fetch(decisionUrl.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html, application/xhtml+xml, text/plain, application/json, */*;q=0.8',
          'user-agent': 'termagent-webfetch/1.0',
        },
      })
    } finally {
      clearTimeout(timer)
      outerSignal.removeEventListener('abort', onOuterAbort)
    }
    if (outerSignal.aborted) throw new Error('Network fetch interrupted')

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location) throw new Error(`Redirect response ${response.status} without a Location header`)
      hops += 1
      if (hops > opts.maxRedirects) throw new Error(`Too many redirects (limit ${opts.maxRedirects})`)
      target = new URL(location, decisionUrl.href).href
      continue
    }

    let bytes = 0
    let truncated = false
    const chunks: Buffer[] = []
    const reader = response.body?.getReader()
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = opts.maxBytes - bytes
        if (value.byteLength > remaining) {
          if (remaining > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining))
          bytes += value.byteLength
          truncated = true
          break
        }
        chunks.push(Buffer.from(value))
        bytes += value.byteLength
      }
      await reader.cancel().catch(() => {})
    }
    const contentType = response.headers.get('content-type') || ''
    const contentLengthHeader = response.headers.get('content-length')
    const buffer = Buffer.concat(chunks)
    const isBinary = /^(image|video|audio)\//i.test(contentType) || /^application\/(pdf|zip|gzip|octet-stream)/i.test(contentType) || !isUtf8(buffer)
    const elapsedMs = Date.now() - startedAt
    return {
      status: response.status,
      finalUrl: decisionUrl.href,
      contentType,
      contentLengthHeader: contentLengthHeader ? Number(contentLengthHeader) : undefined,
      bytes,
      truncated,
      buffer,
      isBinary,
      hops,
      elapsedMs,
    }
  }
}

function isUtf8(buffer: Buffer): boolean {
  if (!buffer.length) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

function formatFetchOutput(result: Awaited<ReturnType<typeof fetchBounded>>): string {
  const statusLine = `[status ${result.status} · ${result.contentType.split(';')[0] || 'unknown'} · ${result.bytes.toLocaleString()} bytes · ${result.hops} redirect(s)]`
  if (result.isBinary) {
    return `${statusLine}\nBinary response body omitted. Use a dedicated binary analysis workflow or inspect the bytes programmatically.`
  }
  const text = result.buffer.toString('utf8')
  if (result.truncated) {
    return `${statusLine}\n${text}\n…[response truncated at ${result.bytes.toLocaleString()} bytes; the full body was not retained]`
  }
  return `${statusLine}\n${text}`
}

export function webfetchTool(opts: WebFetchOptions = {}): ToolDefinition {
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Math.floor(Number(opts.timeoutMs)) : DEFAULT_TIMEOUT_MS
  const maxBytes = Number.isFinite(Number(opts.maxBytes)) && Number(opts.maxBytes) > 0 ? Math.floor(Number(opts.maxBytes)) : DEFAULT_MAX_BYTES
  const maxRedirects = Number.isFinite(Number(opts.maxRedirects)) && Number(opts.maxRedirects) > 0 ? Math.floor(Number(opts.maxRedirects)) : DEFAULT_MAX_REDIRECTS
  const allowPrivateHosts = Boolean(opts.allowPrivateHosts)
  return {
    name: 'webfetch',
    description: 'Fetch a URL over HTTP(S) with bounded size, timeout, redirect, and SSRF controls. Text responses are returned as a bounded preview; binary responses are summarized without content. Network access requires permission.',
    risk: 'network',
    readOnly: true,
    parallelSafe: true,
    permission: { action: 'network' },
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Absolute http(s) URL to fetch.' },
      },
      required: ['url'],
    },
    async execute(args: any, ctx: ToolContext) {
      const url = String(args.url || '')
      if (!url) throw new Error('url is required')
      const result = await fetchBounded(url, { timeoutMs, maxBytes, maxRedirects, allowPrivateHosts }, ctx.abort)
      return {
        title: result.finalUrl,
        output: formatFetchOutput(result),
        metadata: {
          network: {
            kind: 'webfetch',
            url: result.finalUrl,
            status: result.status,
            contentType: result.contentType,
            contentLengthHeader: result.contentLengthHeader,
            bytes: result.bytes,
            truncated: result.truncated,
            hops: result.hops,
            binary: result.isBinary,
          },
        },
      }
    },
  }
}

function parseSearchResults(payload: any): Array<{ title: string; url: string; snippet: string }> {
  const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.items) ? payload.items : []
  const out: Array<{ title: string; url: string; snippet: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const title = String(item.title ?? item.title_text ?? item.headline ?? item.name ?? '')
    const url = String(item.url ?? item.link ?? item.href ?? item.permalink ?? '')
    const snippet = String(item.snippet ?? item.description ?? item.content ?? item.text ?? '')
    if (title || url) out.push({ title, url, snippet })
  }
  return out
}

export function websearchTool(opts: WebSearchOptions = {}): ToolDefinition {
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Math.floor(Number(opts.timeoutMs)) : DEFAULT_TIMEOUT_MS
  return {
    name: 'websearch',
    description: 'Search the web through a configured search endpoint. Requires config webSearch.url or TERMAGENT_SEARCH_URL. Returns bounded, structured results. Network access requires permission.',
    risk: 'network',
    readOnly: true,
    parallelSafe: true,
    permission: { action: 'network' },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        maxResults: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS },
      },
      required: ['query'],
    },
    async execute(args: any, ctx: ToolContext) {
      const endpoint = opts.webSearch?.url || ''
      if (!endpoint) throw new Error('websearch requires a configured search endpoint (config webSearch.url or TERMAGENT_SEARCH_URL)')
      const query = String(args.query || '').trim()
      if (!query) throw new Error('query is required')
      const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number.isFinite(Number(args.maxResults)) ? Math.floor(Number(args.maxResults)) : (opts.webSearch?.maxResults || DEFAULT_SEARCH_RESULTS)))

      const method = (opts.webSearch?.method || 'GET') === 'POST' ? 'POST' : 'GET'
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(opts.webSearch?.headers || {}),
      }
      const apiKeyEnv = opts.webSearch?.apiKeyEnv || ''
      if (apiKeyEnv) {
        const apiKey = process.env[apiKeyEnv] || ''
        if (apiKey && !headers.authorization && !headers.Authorization) headers.authorization = `Bearer ${apiKey}`
      }

      let target: string
      let body: string | undefined
      if (method === 'GET') {
        const url = new URL(endpoint)
        url.searchParams.set('q', query)
        url.searchParams.set('maxResults', String(maxResults))
        target = url.href
      } else {
        target = endpoint
        body = JSON.stringify({ query, maxResults })
      }

      const controller = new AbortController()
      const onOuterAbort = () => controller.abort()
      ctx.abort.addEventListener('abort', onOuterAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetch(target, { method, headers, body, signal: controller.signal })
      } finally {
        clearTimeout(timer)
        ctx.abort.removeEventListener('abort', onOuterAbort)
      }
      if (!response.ok) throw new Error(`Search endpoint responded ${response.status} ${response.statusText}`)
      let payload: any
      try {
        payload = await response.json()
      } catch {
        throw new Error('Search endpoint did not return JSON')
      }
      const results = parseSearchResults(payload).slice(0, maxResults)
      const lines: string[] = []
      results.forEach((result, index) => {
        lines.push(`${index + 1}. ${result.title || '(no title)'}`)
        if (result.url) lines.push(`   ${result.url}`)
        if (result.snippet) lines.push(`   ${result.snippet}`)
      })
      const output = lines.length ? lines.join('\n') : 'No results'
      return {
        title: `web search: ${query}`,
        output,
        metadata: {
          network: {
            kind: 'websearch',
            endpoint: new URL(endpoint).origin,
            method,
            query,
            maxResults,
            returned: results.length,
          },
        },
      }
    },
  }
}
