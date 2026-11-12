import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { Runtime } from './runtime.js'
import { createApi } from './api.js'
import { VERSION } from '../version.js'
import { toLiveEventEnvelope } from '../protocol/session-events.js'
import { validateCommandEnvelope } from '../protocol/validation.js'
import type { ApiCommand } from '../protocol/api.js'
import type { CommandKind } from '../protocol/types.js'
import {
  DeviceAuthStore,
  FixedWindowRateLimiter,
  constantTimeTokenEqual,
  extractBearerToken,
  isLoopbackBind,
  parsePublicOrigin,
  type SafeDeviceRecord,
} from './security.js'

const JSON_BODY_LIMIT = 2 * 1024 * 1024
const SSE_HEARTBEAT_MS = 15_000
const SSE_REPLAY_PAGE = 100
const SSE_DURABLE_POLL_MS = 1_000
const TASK_SSE_DURABLE_POLL_MS = 500
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEB_ASSETS = new Map<string, { file: string; type: string }>([
  ['/', { file: path.resolve(SERVER_DIR, '../../web/app/index.html'), type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: path.resolve(SERVER_DIR, '../../web/app/index.html'), type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: path.resolve(SERVER_DIR, '../../web/app/styles.css'), type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: path.resolve(SERVER_DIR, '../../web/app/app.js'), type: 'text/javascript; charset=utf-8' }],
  ['/web-assets/client/client.js', { file: path.resolve(SERVER_DIR, '../client/client.js'), type: 'text/javascript; charset=utf-8' }],
  ['/web-assets/protocol/api.js', { file: path.resolve(SERVER_DIR, '../protocol/api.js'), type: 'text/javascript; charset=utf-8' }],
])

function json(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

type ServerAuthContext = {
  authType: 'local' | 'legacy-token' | 'device'
  deviceId: string
  clientId: string
  scopes: readonly string[]
  bearerToken?: string
  device?: SafeDeviceRecord
}

export type StartServerOptions = {
  host: string
  port: number
  token?: string
  allowRemote?: boolean
  requirePairing?: boolean
  tlsCertFile?: string
  tlsKeyFile?: string
  publicOrigin?: string
  authStorePath?: string
  pairingTtlMs?: number
  deviceTokenTtlMs?: number
}

export type TermAgentHttpServer = Server & {
  termagent: {
    authMode: 'local' | 'legacy-token' | 'device-pairing'
    remote: boolean
    publicOrigin?: string
    pairingCode?: string
    pairingExpiresAt?: number
    shutdown?: () => Promise<void>
  }
}

const FULL_SCOPES = ['workspace:read', 'workspace:write', 'interaction:resolve', 'task:control', 'device:revoke:self'] as const

function safeHostHeader(value: string | undefined): string | undefined {
  if (!value || value.length > 255 || /[\s\/@\\,]/.test(value)) return undefined
  try {
    const url = new URL(`http://${value}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    return url.host.toLowerCase()
  } catch {
    return undefined
  }
}

function clientAddress(req: IncomingMessage): string {
  return String(req.socket.remoteAddress || 'unknown').slice(0, 96)
}

export function validateServerOptions(opts: StartServerOptions) {
  const remote = !isLoopbackBind(opts.host)
  const pairingEnabled = Boolean(opts.requirePairing || opts.allowRemote || remote)
  if (remote && !opts.allowRemote) throw new Error('Refusing a non-loopback bind. Pass --allow-remote and configure authenticated HTTPS pairing.')
  if (remote && !pairingEnabled) throw new Error('Remote access requires device pairing authentication.')
  if (remote && (!opts.tlsCertFile || !opts.tlsKeyFile)) {
    throw new Error('Remote binds require TLS certificate and key files. For TLS termination by a reverse proxy, bind to loopback and configure --require-pairing --public-origin.')
  }
  if (Boolean(opts.tlsCertFile) !== Boolean(opts.tlsKeyFile)) throw new Error('Both TLS certificate and TLS key files must be configured together.')
  if (remote && opts.token) throw new Error('Static shared tokens are disabled for direct remote binds. Use one-time device pairing.')
  if (pairingEnabled && opts.token) throw new Error('Static shared tokens cannot be combined with device pairing; remove --token or disable --require-pairing.')
  if (opts.publicOrigin && !pairingEnabled) throw new Error('--public-origin requires --require-pairing.')
  if (opts.publicOrigin) parsePublicOrigin(opts.publicOrigin)
  if (remote && !opts.publicOrigin) throw new Error('Direct remote access requires an explicit --public-origin HTTPS origin.')
  return { remote, pairingEnabled }
}

function requestOriginAllowed(req: IncomingMessage, host: string, publicOrigin?: URL): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (origin === 'null' || origin.length > 512) return false
  try {
    const parsed = new URL(origin)
    if (parsed.origin !== origin) return false
    const expected = publicOrigin?.origin || `${req.socket.encrypted ? 'https' : 'http'}://${host}`
    return parsed.origin === expected
  } catch {
    return false
  }
}

function browserRequestIsSameOrigin(req: IncomingMessage, method: string): boolean {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  if (site && site !== 'same-origin' && !(site === 'none' && !isMutation)) return false
  // Do not require Origin solely because Sec-Fetch-Mode exists: Node's native
  // fetch sends `sec-fetch-mode: cors` without Origin. Browser cross-site
  // mutations are still rejected by Fetch Metadata, exact Origin when present,
  // JSON-only bodies, and the absence of an OPTIONS/CORS grant.
  return true
}

function hasScope(auth: ServerAuthContext, scope: string): boolean {
  return auth.scopes.includes('*') || auth.scopes.includes(scope)
}

function requireScope(auth: ServerAuthContext, scope: string): boolean {
  return hasScope(auth, scope)
}

async function serveWebAsset(pathname: string, res: ServerResponse): Promise<boolean> {
  const asset = WEB_ASSETS.get(pathname)
  if (!asset) return false
  try {
    const body = await readFile(asset.file)
    res.statusCode = 200
    res.setHeader('Content-Type', asset.type)
    res.setHeader('Content-Length', body.byteLength)
    res.setHeader('Cache-Control', pathname === '/' || pathname === '/index.html' ? 'no-cache' : 'no-cache')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'")
    res.end(body)
    return true
  } catch {
    json(res, 500, { error: 'Web View asset is missing from this installation' })
    return true
  }
}

function sseHeaders(res: ServerResponse) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
}

function sse(res: ServerResponse, event: string, data: unknown) {
  if (res.writableEnded || res.destroyed) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** @internal Write one SSE frame and respect Node's writable backpressure signal. */
export function writeSse(res: ServerResponse, event: string, data: unknown): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return Promise.resolve(false)
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  if (res.write(frame)) return Promise.resolve(true)
  return new Promise(resolve => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      res.off('error', onClose)
    }
    const onDrain = () => { cleanup(); resolve(!res.writableEnded && !res.destroyed) }
    const onClose = () => { cleanup(); resolve(false) }
    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onClose)
    if (res.destroyed || res.writableEnded) onClose()
  })
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > JSON_BODY_LIMIT) throw new Error('Request body exceeds 2 MiB')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Invalid JSON body') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object')
  return parsed as Record<string, unknown>
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`
}

function errorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/^Session is busy:/.test(message)) return 409
  if (/^Task scope conflict:|^Task .* is (already|no longer)|^Queued prompt .* (is currently|cannot|no longer)/.test(message)) return 409
  if (/^Session not found$|^Task not found$/.test(message)) return 404
  if (/Pairing temporarily rate limited/.test(message)) return 429
  if (/Invalid or expired pairing code/.test(message)) return 401
  if (/Device pairing limit reached/.test(message)) return 409
  if (/Request origin rejected|Insufficient device scope/.test(message)) return 403
  if (/invalid-protocol|expected-sequence-mismatch|expected-revision-mismatch|Request body exceeds|Invalid JSON|JSON body|Invalid durable event cursor|Cursor .* ahead/.test(message)) return 400
  return 500
}

function sessionIdFromParts(parts: string[]) {
  return decodeURIComponent(parts[3] || '')
}

function commandEnvelope(
  req: IncomingMessage,
  sessionId: string,
  kind: CommandKind,
  payload: Record<string, unknown>,
  body: Record<string, unknown> = {},
  authenticatedClientId?: string,
): ApiCommand {
  const header = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value
  const commandId = String(body.commandId || header(req.headers['x-termagent-command-id']) || randomId('cmd'))
  const clientId = authenticatedClientId || String(body.clientId || header(req.headers['x-termagent-client-id']) || 'http')
  const expectedSequence = body.expectedSequence
  const expectedRevision = body.expectedRevision
  return validateCommandEnvelope({
    version: 1,
    commandId,
    clientId,
    sessionId,
    issuedAt: Date.now(),
    ...(Number.isSafeInteger(expectedSequence) ? { expectedSequence } : {}),
    ...(typeof expectedRevision === 'string' ? { expectedRevision } : {}),
    kind,
    payload,
  }) as ApiCommand
}

async function streamTaskEvents(runtime: Runtime, api: ReturnType<typeof createApi>, id: string, res: ServerResponse, after: number, stillAuthorized: () => Promise<boolean>) {
  // Validate the task and its workspace/session ownership before committing
  // the response to an SSE stream. The task JSONL remains the durable source.
  await api.task(id)
  sseHeaders(res)
  if (!Number.isSafeInteger(after) || after < 0) {
    await writeSse(res, 'error', { version: 1, taskId: id, code: 'invalid-cursor', message: 'Invalid task event cursor' })
    res.end()
    return
  }

  let cursor = after
  let closed = false
  let lastHeartbeatAt = Date.now()
  const cleanup = () => { closed = true }
  res.on('close', cleanup)
  res.on('error', cleanup)

  const currentEvents = await runtime.tasks.history(id)
  const currentSequence = currentEvents.at(-1)?.seq ?? 0
  if (cursor > currentSequence) {
    await writeSse(res, 'error', { version: 1, taskId: id, code: 'invalid-cursor', message: `Cursor ${cursor} is ahead of current task event sequence ${currentSequence}` })
    res.end()
    return
  }

  try {
    if (!(await writeSse(res, 'ready', { type: 'ready', version: 1, taskId: id, currentSequence, replayAfter: cursor }))) return
    if (!(await writeSse(res, 'connection', { type: 'connection', version: 1, taskId: id, state: 'connected' }))) return

    const replay = async () => {
      while (!closed) {
        const page = await api.taskEvents(id, 100, cursor)
        for (const event of page) {
          if (closed || !(await writeSse(res, 'event', event))) return
          cursor = event.seq
        }
        if (page.length < 100) return
      }
    }

    await replay()
    while (!closed) {
      // Detached agent workers do not share the server's in-process event bus.
      // Poll their append-only task log for durable wakeups and reconnect repair.
      await new Promise(resolve => setTimeout(resolve, TASK_SSE_DURABLE_POLL_MS))
      if (closed) break
      if (Date.now() - lastHeartbeatAt >= SSE_HEARTBEAT_MS) {
        if (!(await stillAuthorized())) {
          await writeSse(res, 'error', { version: 1, taskId: id, code: 'unauthorized', message: 'Device authorization expired or revoked' })
          res.end()
          break
        }
        await api.task(id)
        if (!(await writeSse(res, 'heartbeat', { type: 'heartbeat', version: 1, taskId: id, timestamp: Date.now() }))) break
        lastHeartbeatAt = Date.now()
      }
      await replay()
    }
  } catch (error) {
    if (!closed) {
      const message = error instanceof Error ? error.message : String(error)
      const code = /Task not found|Session not found/i.test(message) ? 'task-not-found' : 'server-error'
      await writeSse(res, 'error', { version: 1, taskId: id, code, message: code === 'server-error' ? 'Internal server error' : message })
      res.end()
    }
  } finally {
    cleanup()
  }
}

async function streamSessionEvents(runtime: Runtime, api: ReturnType<typeof createApi>, id: string, res: ServerResponse, after: number, stillAuthorized: () => Promise<boolean>) {
  sseHeaders(res)
  if (!Number.isSafeInteger(after) || after < 0) {
    await writeSse(res, 'error', { version: 1, sessionId: id, code: 'invalid-cursor', message: 'Invalid durable event cursor' })
    res.end()
    return
  }

  let cursor = after
  let closed = false
  let lastHeartbeatAt = Date.now()
  const subscription = runtime.events?.subscribe(id)

  const cleanup = () => {
    if (closed) return
    closed = true
    subscription?.close()
  }
  res.on('close', cleanup)
  res.on('error', cleanup)

  try {
    const current = await api.currentSequence(id)
    if (cursor > current) {
      await writeSse(res, 'error', { version: 1, sessionId: id, code: 'invalid-cursor', message: `Cursor ${cursor} is ahead of current durable sequence ${current}` })
      res.end()
      return
    }

    // `ready` establishes the durable cursor before clients consume connection metadata.
    if (!(await writeSse(res, 'ready', {
      type: 'ready', version: 1, sessionId: id, currentSequence: current, replayAfter: cursor, snapshotRequired: false,
    }))) return
    if (!(await writeSse(res, 'connection', toLiveEventEnvelope(id, api.newConnectionId(), 'runtime.connection.changed', { state: 'connected' })))) return

    const replay = async () => {
      while (!closed) {
        const page = await api.events(id, cursor)
        for (const event of page.events) {
          if (closed || !(await writeSse(res, 'event', event))) return
          cursor = event.sequence
        }
        if (!page.hasMore) return
      }
    }

    await replay()
    while (!closed) {
      // The event bus is an in-process wakeup optimization, not durable truth.
      // Polling the append-only sequence also observes writes from detached task
      // workers and other supported child processes that do not share this bus.
      await (subscription?.waitForChange(SSE_DURABLE_POLL_MS) ?? new Promise(resolve => setTimeout(resolve, SSE_DURABLE_POLL_MS)))
      if (closed) break

      // Keep all writes serialized through this loop. A timer that writes in
      // parallel with replay could interleave heartbeats with durable/live
      // frames and create another producer while the response is backpressured.
      if (Date.now() - lastHeartbeatAt >= SSE_HEARTBEAT_MS) {
        if (!(await stillAuthorized())) {
          await writeSse(res, 'error', { version: 1, sessionId: id, code: 'unauthorized', message: 'Device authorization expired or revoked' })
          res.end()
          break
        }
        const currentSequence = await api.currentSequence(id)
        if (!(await writeSse(res, 'heartbeat', { type: 'heartbeat', version: 1, sessionId: id, timestamp: Date.now(), currentSequence }))) break
        lastHeartbeatAt = Date.now()
      }

      const buffered = subscription?.drainLiveWithGap() ?? { events: [], overflowed: false }
      if (buffered.overflowed) {
        const currentSequence = await api.currentSequence(id)
        if (!(await writeSse(res, 'gap', {
          type: 'gap', version: 1, sessionId: id, reason: 'live-buffer-overflow',
          currentSequence, snapshotRequired: true,
        }))) break
      }
      for (const live of buffered.events) {
        if (!(await writeSse(res, 'live', live))) break
      }
      if (closed) break
      await replay()
    }
  } catch (error) {
    if (!closed) {
      const message = error instanceof Error ? error.message : String(error)
      const code = /Invalid session|not found/i.test(message) ? 'session-not-found' : 'server-error'
      await writeSse(res, 'error', { version: 1, sessionId: id, code, message: code === 'server-error' ? 'Internal server error' : message })
      res.end()
    }
  } finally {
    cleanup()
  }
}

export async function startServer(runtime: Runtime, opts: StartServerOptions): Promise<TermAgentHttpServer> {
  const { remote, pairingEnabled } = validateServerOptions(opts)
  const api = createApi(runtime)
  const publicOrigin = opts.publicOrigin ? parsePublicOrigin(opts.publicOrigin) : undefined
  let livePairingMetadata: TermAgentHttpServer['termagent'] | undefined
  const deviceAuth = pairingEnabled ? await DeviceAuthStore.open({
    workspaceRoot: runtime.cwd,
    storePath: opts.authStorePath,
    pairingTtlMs: opts.pairingTtlMs,
    tokenTtlMs: opts.deviceTokenTtlMs,
    onPairingCode: info => {
      if (livePairingMetadata) { livePairingMetadata.pairingCode = info.code; livePairingMetadata.pairingExpiresAt = info.expiresAt }
      console.log(`TermAgent new one-time pairing code: ${info.code} (expires in ${Math.max(1, Math.ceil((info.expiresAt - Date.now()) / 1000))}s)`)
    },
  }) : undefined
  const limiter = new FixedWindowRateLimiter()
  let actualPort = opts.port

  const serverHandler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method || 'GET'
      if (publicOrigin) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
      const host = safeHostHeader(req.headers.host)
      if (!host) return json(res, 400, { error: 'Invalid Host header' })
      if (publicOrigin) {
        if (host !== publicOrigin.host.toLowerCase()) return json(res, 421, { error: 'Misdirected request' })
      } else {
        const expectedHosts = new Set([
          `localhost:${actualPort}`,
          `127.0.0.1:${actualPort}`,
          `[::1]:${actualPort}`,
        ])
        if (!expectedHosts.has(host)) return json(res, 421, { error: 'Misdirected request' })
      }
      if (req.url?.startsWith('http://') || req.url?.startsWith('https://') || req.url?.startsWith('//')) {
        return json(res, 400, { error: 'Absolute request targets are not supported' })
      }
      const url = new URL(req.url || '/', `http://${host}`)
      if (!requestOriginAllowed(req, host, publicOrigin) || !browserRequestIsSameOrigin(req, method)) {
        return json(res, 403, { error: 'Request origin rejected' })
      }
      if (!limiter.allow(`requests:${clientAddress(req)}`, 900, 60_000)) {
        res.setHeader('Retry-After', '60')
        return json(res, 429, { error: 'Rate limit exceeded' })
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || '').trim())) {
          return json(res, 415, { error: 'State-changing requests must use application/json' })
        }
        if (!limiter.allow(`mutations:${clientAddress(req)}`, 120, 60_000)) {
          res.setHeader('Retry-After', '60')
          return json(res, 429, { error: 'Mutation rate limit exceeded' })
        }
      }
      if (method === 'OPTIONS') return json(res, 405, { error: 'Method not allowed' })

      const parts = url.pathname.split('/').filter(Boolean)
      // Static assets are intentionally public but Host validation above prevents DNS-rebinding access.
      if (method === 'GET' && WEB_ASSETS.has(url.pathname)) return await serveWebAsset(url.pathname, res)

      // Pairing is the sole unauthenticated API command. Codes are short-lived, single-use,
      // rate-limited, and exchanged for a scoped opaque device token.
      if (method === 'POST' && url.pathname === '/api/v1/pair' && deviceAuth) {
        const body = await readBody(req)
        try {
          const paired = await deviceAuth.pair(body.code, body.deviceName, clientAddress(req))
          return json(res, 201, { token: paired.token, device: paired.device, scope: paired.scope })
        } catch (error) {
          const status = errorStatus(error)
          return json(res, status, { error: status === 429 ? 'Pairing temporarily rate limited' : status === 409 ? 'Device pairing limit reached' : 'Invalid or expired pairing code' })
        }
      }

      const bearerToken = extractBearerToken(req.headers.authorization)
      let auth: ServerAuthContext | undefined
      if (deviceAuth) {
        if (bearerToken) {
          const device = await deviceAuth.authenticate(bearerToken)
          if (device) auth = { authType: 'device', deviceId: device.id, clientId: device.id, scopes: device.scopes, bearerToken, device }
        }
      } else if (opts.token) {
        if (bearerToken && constantTimeTokenEqual(bearerToken, opts.token)) {
          auth = { authType: 'legacy-token', deviceId: 'legacy-token', clientId: String(req.headers['x-termagent-client-id'] || 'http'), scopes: FULL_SCOPES }
        }
      } else {
        auth = { authType: 'local', deviceId: 'local', clientId: String(req.headers['x-termagent-client-id'] || 'local'), scopes: FULL_SCOPES }
      }
      if (!auth) {
        res.setHeader('Cache-Control', 'no-store')
        if (!req.headers['sec-fetch-mode'] || req.headers['sec-fetch-mode'] === 'navigate') res.setHeader('WWW-Authenticate', 'Bearer')
        return json(res, 401, { error: 'Unauthorized' })
      }
      const scope = method === 'GET' || method === 'HEAD' ? 'workspace:read' : 'workspace:write'
      if (!requireScope(auth, scope)) return json(res, 403, { error: 'Insufficient device scope' })

      if (method === 'GET' && url.pathname === '/api/v1/device') {
        return json(res, 200, { authType: auth.authType, ...(auth.device ? { device: auth.device } : {}) })
      }
      if (method === 'POST' && url.pathname === '/api/v1/device/revoke') {
        if (auth.authType !== 'device' || !deviceAuth || !requireScope(auth, 'device:revoke:self')) return json(res, 404, { error: 'Device management unavailable' })
        const revoked = await deviceAuth.revokeSelf(auth.deviceId)
        return json(res, 200, { revoked })
      }

      const requireDeviceCurrent = async () => {
        if (auth?.authType !== 'device' || !deviceAuth || !auth.bearerToken) return true
        const current = await deviceAuth.authenticate(auth.bearerToken)
        return Boolean(current && current.id === auth.deviceId)
      }
      if (method === 'GET' && url.pathname === '/health') return json(res, 200, api.health())
      if (method === 'GET' && url.pathname === '/api/v1/info') return json(res, 200, api.info())
      if (method === 'GET' && url.pathname === '/api/v1/status') return json(res, 200, await api.status())
      if (method === 'GET' && url.pathname === '/api/v1/commands') return json(res, 200, api.commands())
      if (method === 'GET' && url.pathname === '/api/v1/sessions') return json(res, 200, { sessions: await api.listSessions() })
      if (method === 'POST' && url.pathname === '/api/v1/sessions') {
        const body = await readBody(req)
        return json(res, 201, await api.createSession(typeof body.cwd === 'string' ? body.cwd : undefined, typeof body.model === 'string' ? body.model : undefined))
      }
      if (method === 'GET' && url.pathname === '/api/v1/tools') return json(res, 200, await api.tools())
      if (method === 'GET' && url.pathname === '/api/v1/models') return json(res, 200, await api.models())
      if (method === 'GET' && url.pathname === '/api/v1/agents') return json(res, 200, await api.agents())
      if (method === 'GET' && url.pathname === '/api/v1/skills') return json(res, 200, await api.skills())
      if (method === 'GET' && url.pathname === '/api/v1/tasks') return json(res, 200, { tasks: await api.tasks() })

      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'tasks' && parts[3]) {
        if (method !== 'GET' && !requireScope(auth, 'task:control')) return json(res, 403, { error: 'Insufficient device scope' })
        const taskId = decodeURIComponent(parts[3])
        if (method === 'GET' && parts.length === 4) return json(res, 200, await api.task(taskId))
        if (method === 'GET' && parts[4] === 'events' && parts[5] === 'stream') {
          const after = Number(url.searchParams.get('after') || 0)
          return await streamTaskEvents(runtime, api, taskId, res, after, requireDeviceCurrent)
        }
        if (method === 'GET' && parts[4] === 'events') {
          const rawLimit = url.searchParams.get('limit')
          const parsedLimit = rawLimit === null ? undefined : Number(rawLimit)
          const limit = parsedLimit === undefined ? undefined : Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 100
          const rawAfter = url.searchParams.get('after')
          const after = rawAfter === null ? undefined : Number(rawAfter)
          return json(res, 200, await api.taskEvents(taskId, limit, after !== undefined && Number.isFinite(after) ? Math.floor(after) : undefined))
        }
        if (method === 'GET' && parts[4] === 'output') {
          const maxBytes = Math.max(1, Math.min(1_000_000, Number(url.searchParams.get('maxBytes') || 20_000)))
          const tail = url.searchParams.get('tail') !== '0'
          return json(res, 200, await api.taskOutput(taskId, Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 20_000, tail))
        }
        if (method === 'POST' && (parts[4] === 'cancel' || parts[4] === 'resume' || parts[4] === 'send')) {
          const body = await readBody(req)
          const task = await api.task(taskId)
          if (!task?.sessionId) {
            if (parts[4] === 'cancel') return json(res, 200, await runtime.tasks.cancel(taskId))
            throw new Error(`Task ${taskId} is not attached to a session`)
          }
          const kind = parts[4] === 'cancel' ? 'task.cancel' : parts[4] === 'resume' ? 'task.resume' : 'task.send'
          const payload = parts[4] === 'cancel'
            ? { taskId }
            : { taskId, prompt: String(body.prompt || '') }
          const command = commandEnvelope(req, task.sessionId, kind, payload, body, auth.clientId)
          const result = await api.executeCommand(command)
          return json(res, 200, result)
        }
      }

      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'sessions' && parts[3]) {
        const id = sessionIdFromParts(parts)
        await api.assertSession(id)
        const tail = parts.slice(4)

        if (method === 'GET' && tail.length === 0) return json(res, 200, await api.getSession(id))
        if (method === 'GET' && tail[0] === 'subagents') return json(res, 200, await api.subagents(id))
        if (method === 'GET' && tail[0] === 'history') return json(res, 200, await api.history(id))
        if (method === 'GET' && tail[0] === 'messages') {
          const rawLimit = url.searchParams.get('limit')
          const parsedLimit = rawLimit === null ? undefined : Number(rawLimit)
          const limit = parsedLimit === undefined ? undefined : Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 100
          return json(res, 200, await api.messages(id, Number(url.searchParams.get('after') || 0), limit, url.searchParams.get('tail') === '1'))
        }
        if (method === 'GET' && tail[0] === 'events' && tail[1] === 'stream') return streamSessionEvents(runtime, api, id, res, Number(url.searchParams.get('after') || 0), requireDeviceCurrent)
        if (method === 'GET' && tail[0] === 'events') return json(res, 200, await api.events(id, Number(url.searchParams.get('after') || 0)))
        if (method === 'GET' && tail[0] === 'status') return json(res, 200, await api.statusForSession(id))
        if (method === 'GET' && tail[0] === 'diff') return json(res, 200, await api.diff(id, url.searchParams.get('staged') === '1'))
        if (method === 'GET' && tail[0] === 'context') return json(res, 200, await api.context(id))
        if (method === 'GET' && tail[0] === 'snapshot') return json(res, 200, await api.snapshot(id))
        if (method === 'GET' && tail[0] === 'permissions') return json(res, 200, await api.permissions(id))
        if (method === 'GET' && tail[0] === 'questions') return json(res, 200, await api.questions(id))
        if (method === 'GET' && tail[0] === 'todo') return json(res, 200, await api.todo(id))
        if (method === 'GET' && tail[0] === 'queue') return json(res, 200, await api.queue(id, url.searchParams.get('active') !== '0'))
        if (method === 'GET' && tail[0] === 'checkpoints') return json(res, 200, { checkpoints: await api.checkpoints(id) })

        if (method === 'POST' && tail[0] === 'permissions' && tail[1]) {
          if (!requireScope(auth, 'interaction:resolve')) return json(res, 403, { error: 'Insufficient device scope' })
          const body = await readBody(req)
          const command = commandEnvelope(req, id, 'permission.resolve', { requestId: decodeURIComponent(tail[1]), decision: body.decision }, body, auth.clientId)
          return json(res, 200, await api.executeCommand(command))
        }
        if (method === 'POST' && tail[0] === 'questions' && tail[1]) {
          if (!requireScope(auth, 'interaction:resolve')) return json(res, 403, { error: 'Insufficient device scope' })
          const body = await readBody(req)
          const requestId = decodeURIComponent(tail[1])
          const status = body.status === 'rejected' || body.status === 'cancelled' ? body.status : 'replied'
          if (!runtime.ledger) {
            const resolution = { commandId: String(body.commandId || randomId('cmd')), clientId: auth.clientId, disposition: status, ...(status === 'replied' ? { answers: Array.isArray(body.answers) ? body.answers : [] } : {}) } as any
            return json(res, 200, await runtime.store.resolveQuestion(id, requestId, resolution))
          }
          const kind: CommandKind = status === 'rejected' ? 'question.reject' : status === 'cancelled' ? 'question.cancel' : 'question.answer'
          const payload = { requestId, ...(status === 'replied' ? { answers: body.answers } : {}) }
          return json(res, 200, await api.executeCommand(commandEnvelope(req, id, kind, payload, body, auth.clientId)))
        }

        if (method === 'POST' && tail[0] === 'queue') {
          const body = await readBody(req)
          const command = commandEnvelope(req, id, 'session.queue', { prompt: String(body.prompt || '') }, body, auth.clientId)
          return json(res, 200, await api.executeCommand(command))
        }
        if (method === 'PATCH' && tail[0] === 'queue' && tail[1]) {
          const body = await readBody(req)
          const queueId = decodeURIComponent(tail[1])
          const kind: CommandKind = body.action === 'cancel' ? 'session.queue.cancel' : body.action === 'move' ? 'session.queue.move' : 'session.queue.edit'
          const payload = kind === 'session.queue.cancel' ? { queueId } : kind === 'session.queue.move' ? { queueId, direction: Number(body.direction) < 0 ? -1 : 1 } : { queueId, prompt: String(body.prompt || '') }
          return json(res, 200, await api.executeCommand(commandEnvelope(req, id, kind, payload, body, auth.clientId)))
        }

        if (method === 'POST' && tail[0] === 'commands') {
          const body = await readBody(req)
          if (String(body.sessionId || '') !== id) return json(res, 400, { error: 'Command sessionId does not match URL session' })
          const kind = String(body.kind || '')
          if (kind.startsWith('question.') || kind === 'permission.resolve') {
            if (!requireScope(auth, 'interaction:resolve')) return json(res, 403, { error: 'Insufficient device scope' })
          }
          if (kind.startsWith('task.') && !requireScope(auth, 'task:control')) return json(res, 403, { error: 'Insufficient device scope' })
          // Paired devices always use their immutable server-issued identity.
          // Loopback/legacy shared-token mode retains client-supplied identity
          // for compatibility with existing multi-client command receipts.
          const clientId = auth.authType === 'device' ? auth.clientId : String(body.clientId || auth.clientId)
          const command = { ...body, clientId } as unknown as ApiCommand
          return json(res, 200, await api.executeCommand(command))
        }

        if (method === 'POST' && tail[0] === 'prompt') {
          const body = await readBody(req)
          const prompt = String(body.prompt || '').trim()
          if (!prompt) return json(res, 400, { error: 'prompt is required' })
          if (body.stream === false) {
            const controller = new AbortController()
            const authPoll = auth.authType === 'device' ? setInterval(() => { void requireDeviceCurrent().then(ok => { if (!ok) controller.abort(new Error('Device authorization expired or revoked')) }).catch(() => controller.abort()) }, 5_000) : undefined
            try {
              const result = await api.prompt(id, prompt, { mode: typeof body.mode === 'string' ? body.mode : undefined, autonomous: Boolean(body.autonomous), agent: typeof body.agent === 'string' ? body.agent : undefined, signal: controller.signal })
              return json(res, 200, result)
            } finally { if (authPoll) clearInterval(authPoll) }
          }

          sseHeaders(res)
          const controller = new AbortController()
          let closed = false
          const authPoll = auth.authType === 'device' ? setInterval(() => { void requireDeviceCurrent().then(ok => { if (!ok) controller.abort(new Error('Device authorization expired or revoked')) }).catch(() => controller.abort()) }, 5_000) : undefined
          const promptHeartbeat = setInterval(() => { if (!closed) sse(res, 'heartbeat', { timestamp: Date.now() }) }, SSE_HEARTBEAT_MS)
          req.on('aborted', () => { closed = true; controller.abort() })
          res.on('close', () => { closed = true; controller.abort() })
          try {
            const result = await api.prompt(id, prompt, {
              mode: typeof body.mode === 'string' ? body.mode : undefined,
              autonomous: Boolean(body.autonomous),
              agent: typeof body.agent === 'string' ? body.agent : undefined,
              signal: controller.signal,
              onReasoning: delta => { if (!closed) sse(res, 'reasoning', { delta }) },
              onText: delta => { if (!closed) sse(res, 'text', { delta }) },
              onTool: (name, args, callId) => { if (!closed) sse(res, 'tool_start', { name, args, callId }) },
              onToolResult: (name, output, metadata) => { if (!closed) sse(res, 'tool_end', { name, output, metadata, callId: (metadata as any)?.toolLifecycle?.callId }) },
              onStatus: message => { if (!closed) sse(res, 'status', { message }) },
              onQuestionAsked: request => { if (!closed) { const value = request as any; sse(res, 'question', { ...value, id: value.requestId }) } },
            })
            if (!closed) sse(res, 'done', result)
          } catch {
            if (!closed) sse(res, 'error', { message: 'Prompt failed. Check the TermAgent server terminal for details.' })
          } finally {
            if (authPoll) clearInterval(authPoll)
            clearInterval(promptHeartbeat)
            if (!res.writableEnded) res.end()
          }
          return
        }

        if (method === 'POST' && (tail[0] === 'interrupt' || tail[0] === 'abort')) {
          const body = await readBody(req)
          if (runtime.ledger) {
            const kind: CommandKind = tail[0] === 'interrupt' ? 'session.interrupt' : 'session.abort'
            return json(res, 200, await api.executeCommand(commandEnvelope(req, id, kind, {}, body, auth.clientId)))
          }
          const interrupted = runtime.interrupt ? runtime.interrupt(id) : false
          return json(res, interrupted ? 202 : 409, { sessionId: id, interrupted })
        }
        if (method === 'POST' && tail[0] === 'compact') {
          const body = await readBody(req)
          if (runtime.ledger) return json(res, 200, await api.executeCommand(commandEnvelope(req, id, 'session.compact', {}, body, auth.clientId)))
          if (runtime.compactSession) return json(res, 200, await runtime.compactSession(id))
          return json(res, 500, { error: 'Compact service unavailable' })
        }
        if (method === 'POST' && tail[0] === 'undo') {
          const body = await readBody(req)
          if (runtime.ledger) return json(res, 200, await api.executeCommand(commandEnvelope(req, id, 'session.undo', {}, body, auth.clientId)))
          const result = await runtime.store.undo(id, runtime.cwd)
          return json(res, 200, { turn: result.turn, messages: result.messages })
        }
        if (method === 'POST' && tail[0] === 'redo') {
          const body = await readBody(req)
          if (runtime.ledger) return json(res, 200, await api.executeCommand(commandEnvelope(req, id, 'session.redo', {}, body, auth.clientId)))
          const result = await runtime.store.redo(id, runtime.cwd)
          return json(res, 200, { turn: result.turn, messages: result.messages })
        }
        if (method === 'POST' && tail[0] === 'fork') {
          const body = await readBody(req)
          if (runtime.ledger) return json(res, 201, await api.executeCommand(commandEnvelope(req, id, 'session.fork', { ...(body.at === undefined ? {} : { at: Number(body.at) }) }, body, auth.clientId)))
          return json(res, 201, await runtime.store.fork(id, Number.isFinite(Number(body.at)) ? Number(body.at) : undefined))
        }
        if (method === 'POST' && tail[0] === 'checkpoints' && tail[1] && tail[2] === 'restore') return json(res, 200, await api.restoreCheckpoint(id, decodeURIComponent(tail[1])))
        if (method === 'POST' && tail[0] === 'checkpoints' && tail[1] && tail[2] === 'branch') {
          const body = await readBody(req)
          return json(res, 201, await api.branchCheckpoint(id, decodeURIComponent(tail[1]), Boolean(body.restoreWorkspace)))
        }
        if (method === 'POST' && (tail[0] === 'checkpoints' || tail[0] === 'checkpoint') && !tail[1]) {
          return json(res, 201, await api.checkpoint(id, String((await readBody(req)).label || 'api')))
        }
        if (method === 'POST' && tail[0] === 'resume') {
          const body = await readBody(req)
          // Legacy alias: route the operation through the durable task service when a task is supplied.
          if (!requireScope(auth, 'task:control')) return json(res, 403, { error: 'Insufficient device scope' })
          const taskId = String(body.taskId || '')
          if (!taskId) return json(res, 400, { error: 'taskId is required' })
          const task = await api.task(taskId)
          if (!task?.sessionId || task.sessionId !== id) return json(res, 409, { error: 'Task does not belong to this session' })
          return json(res, 200, await api.executeCommand(commandEnvelope(req, id, 'task.resume', { taskId, prompt: String(body.prompt || '') }, body, auth.clientId)))
        }
      }

      return json(res, 404, { error: 'Not found' })
    } catch (error) {
      const status = error instanceof URIError ? 400 : errorStatus(error)
      return json(res, status, { error: status < 500 ? (error instanceof Error ? error.message : String(error)) : 'Internal server error' })
    }
  }

  let server: Server
  if (opts.tlsCertFile && opts.tlsKeyFile) {
    const [cert, key, keyInfo] = await Promise.all([
      readFile(opts.tlsCertFile),
      readFile(opts.tlsKeyFile),
      stat(opts.tlsKeyFile),
    ])
    if ((keyInfo.mode & 0o077) !== 0) throw new Error('TLS private key permissions are too broad; restrict the key file to its owner (chmod 600).')
    server = https.createServer({ cert, key }, serverHandler)
  } else {
    server = http.createServer(serverHandler)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host, resolve)
  })
  const address = server.address()
  actualPort = typeof address === 'object' && address ? address.port : opts.port
  const pairing = deviceAuth?.pairingInfo()
  const result = server as TermAgentHttpServer
  result.termagent = {
    authMode: deviceAuth ? 'device-pairing' : opts.token ? 'legacy-token' : 'local',
    remote: remote || Boolean(publicOrigin),
    ...(publicOrigin ? { publicOrigin: publicOrigin.origin } : {}),
    ...(pairing ? { pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt } : {}),
  }
  livePairingMetadata = result.termagent
  if (deviceAuth) {
    const pairingRefresh = setInterval(() => {
      const current = deviceAuth.pairingInfo()
      result.termagent.pairingCode = current.code
      result.termagent.pairingExpiresAt = current.expiresAt
    }, 30_000)
    ;(pairingRefresh as any).unref?.()
    result.once('close', () => clearInterval(pairingRefresh))
  }
  return result
}
