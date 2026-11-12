import type {
  ApiCommand,
  ApiEvent,
  ApiCommandResult,
  AgentSummary,
  ChatMessage,
  CommandSummary,
  ModelProfile,
  PromptResult,
  RuntimeStatus,
  ServerInfo,
  SessionHistory,
  SessionMeta,
  SessionSnapshot,
  SessionStatus,
  SkillSummary,
  TaskEvent,
  TaskRecord,
  SubagentWorkspace,
  ToolSummary,
  QueuedPrompt,
} from '../protocol/api.js'
import { apiPath } from '../protocol/api.js'
import type { CommandKind, CommandReceipt, InteractionRequestState, ReconnectRequest, DurableSequence } from '../protocol/types.js'

export type ClientOptions = {
  baseUrl: string
  token?: string
  headers?: HeadersInit
  clientId?: string
  fetch?: typeof fetch
}

export type PromptOptions = {
  stream?: boolean
  mode?: string
  autonomous?: boolean
  agent?: string
}

export type SseFrame = { event: string; data: unknown }
export type EventStreamConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'
export type EventStreamOptions = {
  onConnectionState?: (state: EventStreamConnectionState, detail?: { attempt: number; error?: string }) => void
  signal?: AbortSignal
  reconnect?: boolean
  maxRetries?: number
  initialRetryDelayMs?: number
  maxRetryDelayMs?: number
}

export type CommandOptions = {
  commandId?: string
  expectedSequence?: DurableSequence
  expectedRevision?: string
}

export type EnqueueOptions = CommandOptions & {
  mode?: string
  autonomous?: boolean
  agent?: string
}

export class TermAgentError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message)
    this.name = 'TermAgentError'
  }
}

function randomId(prefix: string): string {
  try {
    const value = globalThis.crypto?.randomUUID?.()
    if (value) return `${prefix}_${value}`
  } catch {}
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

function clampCursor(value: number): number {
  return Math.max(0, Number.isSafeInteger(value) ? value : Math.floor(Number(value) || 0))
}

async function* decodeSse(response: Response): AsyncGenerator<SseFrame> {
  if (!response.body) throw new Error('Server returned no event stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let carry = ''

  const parseFrame = (frame: string): SseFrame | undefined => {
    let event = 'message'
    const dataLines: string[] = []
    for (const rawLine of frame.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
      if (rawLine.startsWith(':')) continue
      if (rawLine.startsWith('event:')) event = rawLine.slice(6).trim()
      else if (rawLine.startsWith('data:')) dataLines.push(rawLine.slice(5).replace(/^ /, ''))
    }
    if (!dataLines.length) return undefined
    const raw = dataLines.join('\n')
    try { return { event, data: JSON.parse(raw) } } catch { return { event, data: raw } }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      carry += decoder.decode(value, { stream: true })
      let boundaryMatch = /\r\n\r\n|\n\n|\r\r/.exec(carry)
      while (boundaryMatch) {
        const frame = carry.slice(0, boundaryMatch.index)
        carry = carry.slice(boundaryMatch.index + boundaryMatch[0].length)
        const parsed = parseFrame(frame)
        if (parsed) yield parsed
        boundaryMatch = /\r\n\r\n|\n\n|\r\r/.exec(carry)
      }
    }
    carry += decoder.decode()
    if (carry.trim()) {
      const parsed = parseFrame(carry)
      if (parsed) yield parsed
    }
  } finally {
    try { await reader.cancel() } catch {}
  }
}

export const CLIENT_ROUTE_IDS = [
  'pair', 'device.get', 'device.revoke',
  'health', 'info', 'status', 'commands', 'sessions.list', 'sessions.create', 'session.get',
  'session.history', 'session.messages', 'session.events', 'session.events.stream', 'session.status',
  'session.diff', 'session.context', 'session.snapshot', 'session.permissions', 'session.permission.resolve',
  'session.questions', 'session.question.resolve', 'session.todo', 'session.queue', 'session.queue.enqueue',
  'session.queue.mutate', 'session.prompt', 'session.command', 'session.checkpoints', 'session.checkpoint.create',
  'session.checkpoint.restore', 'session.checkpoint.branch', 'tasks.list', 'task.get', 'task.events', 'task.events.stream',
  'task.output', 'task.cancel', 'task.resume', 'task.send', 'subagents.list', 'tools.list', 'models.list', 'agents.list',
  'skills.list',
] as const

export class TermAgentClient {
  private readonly root: string
  private readonly token?: string
  private readonly clientId: string
  private readonly baseHeaders: Headers
  private readonly http: typeof fetch

  constructor(options: ClientOptions) {
    this.root = options.baseUrl.replace(/\/$/, '')
    this.token = options.token
    this.clientId = options.clientId || randomId('client')
    this.baseHeaders = new Headers(options.headers)
    // Native browser fetch requires its Window/global receiver in some browsers.
    // Store a bound default so later calls through `this.http(...)` cannot throw
    // "Illegal invocation" in mobile browsers. Custom fetch adapters stay untouched.
    this.http = options.fetch || globalThis.fetch.bind(globalThis)
  }

  getClientId(): string { return this.clientId }

  private headers(init?: HeadersInit, accept = 'application/json'): Headers {
    const headers = new Headers(this.baseHeaders)
    if (init) new Headers(init).forEach((value, key) => headers.set(key, value))
    if (!headers.has('accept')) headers.set('accept', accept)
    if (this.token) headers.set('authorization', `Bearer ${this.token}`)
    return headers
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const headers = this.headers(init.headers)
    const response = await this.http(`${this.root}${pathname}`, { ...init, headers })
    const raw = await response.text()
    let data: unknown = raw
    try { data = raw ? JSON.parse(raw) : undefined } catch {}
    if (!response.ok) {
      const record = data && typeof data === 'object' ? data as Record<string, unknown> : undefined
      throw new TermAgentError(
        String(record?.error || record?.message || data || response.statusText || 'Request failed'),
        response.status,
        typeof record?.code === 'string' ? record.code : undefined,
      )
    }
    return data as T
  }

  private json<T>(pathname: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
    return this.request<T>(pathname, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  pair(code: string, deviceName = 'TermAgent Web'): Promise<{ token: string; device: Record<string, unknown>; scope: 'workspace' }> {
    return this.json(apiPath.pair(), 'POST', { code, deviceName })
  }
  getDevice(): Promise<{ authType: string; device?: Record<string, unknown> }> { return this.request(apiPath.device()) }
  revokeDevice(): Promise<{ revoked: boolean }> { return this.json(apiPath.revokeDevice(), 'POST', {}) }
  info(): Promise<ServerInfo> { return this.request<ServerInfo>(apiPath.info()) }
  health(): Promise<Record<string, unknown>> { return this.request<Record<string, unknown>>(apiPath.health()) }
  status(): Promise<RuntimeStatus> { return this.request<RuntimeStatus>(apiPath.status()) }
  listCommands(): Promise<{ commands: Array<string | CommandSummary> }> { return this.request(apiPath.commands()) }
  listSessions(): Promise<{ sessions: SessionMeta[] }> { return this.request(apiPath.sessions()) }
  createSession(cwd?: string, model?: string): Promise<SessionMeta> {
    return this.json(apiPath.sessions(), 'POST', { ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) })
  }
  getSession(id: string): Promise<SessionHistory> { return this.request(apiPath.session(id)) }
  getHistory(id: string): Promise<SessionHistory> { return this.request(apiPath.history(id)) }
  getMessages(id: string, after = 0, limit?: number, tail = false): Promise<{ messages: ChatMessage[]; offset: number; total: number }> { return this.request(apiPath.messages(id, clampCursor(after), limit, tail)) }
  getEvents(id: string, after = 0): Promise<{ events: ApiEvent[]; hasMore: boolean; currentSequence: DurableSequence }> { return this.request(apiPath.events(id, clampCursor(after))) }
  getSessionStatus(id: string): Promise<SessionStatus> { return this.request(apiPath.sessionStatus(id)) }
  getDiff(id: string, staged = false): Promise<unknown> { return this.request(apiPath.diff(id, staged)) }
  getContext(id: string): Promise<unknown> { return this.request(apiPath.context(id)) }
  getSnapshot(id: string): Promise<SessionSnapshot> { return this.request(apiPath.snapshot(id)) }
  listPermissions(id: string): Promise<InteractionRequestState[]> { return this.request(apiPath.permissions(id)) }
  listQuestions(id: string): Promise<InteractionRequestState[]> { return this.request(apiPath.questions(id)) }
  getTodo(id: string): Promise<unknown[]> { return this.request(apiPath.todo(id)) }
  getQueue(id: string, activeOnly = true): Promise<QueuedPrompt[]> { return this.request(`${apiPath.queue(id)}?active=${activeOnly ? '1' : '0'}`) }
  listCheckpoints(id: string): Promise<{ checkpoints: unknown[] }> { return this.request(apiPath.checkpoints(id)) }
  listTasks(): Promise<{ tasks: TaskRecord[] }> { return this.request(apiPath.tasks()) }
  listSubagents(sessionId: string): Promise<SubagentWorkspace> { return this.request(apiPath.subagents(sessionId)) }
  getTask(id: string): Promise<TaskRecord> { return this.request(apiPath.task(id)) }
  getTaskEvents(id: string, limit?: number, after?: number): Promise<TaskEvent[]> { return this.request(apiPath.taskEvents(id, limit, after)) }
  getTaskOutput(id: string, maxBytes = 20_000, tail = true): Promise<string> {
    return this.request(`${apiPath.taskOutput(id)}?maxBytes=${Math.max(1, Math.floor(maxBytes))}&tail=${tail ? '1' : '0'}`)
  }
  listTools(): Promise<{ tools: ToolSummary[] }> { return this.request(apiPath.tools()) }
  listModels(): Promise<{ active: { provider: string; model: string }; profiles: ModelProfile[]; routing: Record<string, unknown>; smartRouting: Record<string, unknown> }> { return this.request(apiPath.models()) }
  listAgents(): Promise<{ builtin: string[]; custom: AgentSummary[] }> { return this.request(apiPath.agents()) }
  listSkills(): Promise<{ skills: SkillSummary[] }> { return this.request(apiPath.skills()) }

  async *streamEvents(id: string, after = 0, options: EventStreamOptions = {}): AsyncGenerator<SseFrame> {
    let cursor = clampCursor(after)
    let retries = 0
    let attempt = 0
    let connectedOnce = false
    const reconnect = options.reconnect !== false
    const maxRetries = options.maxRetries === undefined ? Infinity : Math.max(0, Math.floor(options.maxRetries))
    const initialDelay = Math.max(0, options.initialRetryDelayMs ?? 250)
    const maxDelay = Math.max(initialDelay, options.maxRetryDelayMs ?? 5_000)
    const notify = (state: EventStreamConnectionState, error?: unknown) => {
      try {
        options.onConnectionState?.(state, {
          attempt,
          ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
        })
      } catch {
        // Observability hooks must never break the event transport.
      }
    }

    try {
      while (true) {
        if (options.signal?.aborted) return
        attempt += 1
        notify(connectedOnce ? 'reconnecting' : 'connecting')
        const headers = this.headers({ accept: 'text/event-stream' }, 'text/event-stream')
        try {
          const response = await this.http(`${this.root}${apiPath.eventStream(id, cursor)}`, { headers, signal: options.signal })
          if (!response.ok) {
            const raw = await response.text()
            let data: unknown = raw
            try { data = raw ? JSON.parse(raw) : undefined } catch {}
            const record = data && typeof data === 'object' ? data as Record<string, unknown> : undefined
            throw new TermAgentError(String(record?.error || record?.message || raw || response.statusText), response.status, typeof record?.code === 'string' ? record.code : undefined)
          }
          retries = 0
          connectedOnce = true
          notify('connected')
          for await (const frame of decodeSse(response)) {
            if (frame.event === 'event' && frame.data && typeof frame.data === 'object') {
              const event = frame.data as Partial<ApiEvent>
              if (event.durable === true && typeof event.sequence === 'number') cursor = event.sequence as DurableSequence
            } else if (frame.event === 'ready' && frame.data && typeof frame.data === 'object') {
              const ready = frame.data as { currentSequence?: number; replayAfter?: number }
              if (typeof ready.replayAfter === 'number') cursor = Math.max(cursor, ready.replayAfter) as DurableSequence
            }
            yield frame
            if (frame.event === 'error') return
          }
          if (!reconnect || options.signal?.aborted) return
          const ended = new Error('Event stream ended without closing the client')
          notify('reconnecting', ended)
        } catch (error) {
          if (options.signal?.aborted) return
          if (error instanceof TermAgentError && error.status < 500) throw error
          if (!reconnect) throw error
          notify('reconnecting', error)
        }

        if (!reconnect || options.signal?.aborted) return
        if (Number.isFinite(maxRetries) && retries >= maxRetries) return
        const delay = Math.min(maxDelay, initialDelay * 2 ** retries)
        retries += 1
        await this.delay(delay, options.signal)
      }
    } finally {
      notify('closed')
    }
  }

  async *streamTaskEvents(id: string, after = 0, options: EventStreamOptions = {}): AsyncGenerator<SseFrame> {
    let cursor = clampCursor(after)
    let retries = 0
    const reconnect = options.reconnect !== false
    const maxRetries = options.maxRetries === undefined ? Infinity : Math.max(0, Math.floor(options.maxRetries))
    const initialDelay = Math.max(0, options.initialRetryDelayMs ?? 250)
    const maxDelay = Math.max(initialDelay, options.maxRetryDelayMs ?? 5_000)

    while (true) {
      if (options.signal?.aborted) return
      const headers = this.headers({ accept: 'text/event-stream' }, 'text/event-stream')
      let ended = false
      try {
        const response = await this.http(`${this.root}${apiPath.taskEventStream(id, cursor)}`, { headers, signal: options.signal })
        if (!response.ok) {
          const raw = await response.text()
          let data: unknown = raw
          try { data = raw ? JSON.parse(raw) : undefined } catch {}
          const record = data && typeof data === 'object' ? data as Record<string, unknown> : undefined
          throw new TermAgentError(String(record?.error || record?.message || raw || response.statusText), response.status, typeof record?.code === 'string' ? record.code : undefined)
        }
        retries = 0
        for await (const frame of decodeSse(response)) {
          ended = true
          if (frame.event === 'event' && frame.data && typeof frame.data === 'object') {
            const event = frame.data as Partial<TaskEvent>
            if (typeof event.seq === 'number') cursor = Math.max(cursor, event.seq)
          } else if (frame.event === 'ready' && frame.data && typeof frame.data === 'object') {
            const ready = frame.data as { replayAfter?: number }
            if (typeof ready.replayAfter === 'number') cursor = Math.max(cursor, ready.replayAfter)
          }
          yield frame
          if (frame.event === 'error') return
        }
        if (!reconnect || options.signal?.aborted) return
      } catch (error) {
        if (options.signal?.aborted) return
        if (error instanceof TermAgentError && error.status < 500) throw error
        if (!reconnect) throw error
      }

      if (!reconnect || options.signal?.aborted) return
      if (Number.isFinite(maxRetries) && retries >= maxRetries) return
      const delay = Math.min(maxDelay, initialDelay * 2 ** retries)
      retries += 1
      await this.delay(delay, options.signal)
      if (ended && delay === 0) continue
    }
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        signal?.removeEventListener('abort', abort)
        resolve()
      }, ms)
      const abort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  async prompt(id: string, prompt: string, options: Omit<PromptOptions, 'stream'> = {}): Promise<PromptResult> {
    return this.json(apiPath.prompt(id), 'POST', { prompt, ...options, stream: false })
  }

  async *streamPrompt(id: string, prompt: string, options: Omit<PromptOptions, 'stream'> = {}, streamOptions: { signal?: AbortSignal } = {}): AsyncGenerator<SseFrame> {
    const headers = this.headers({ 'content-type': 'application/json', accept: 'text/event-stream' }, 'text/event-stream')
    const response = await this.http(`${this.root}${apiPath.prompt(id)}`, {
      method: 'POST', headers, body: JSON.stringify({ prompt, ...options, stream: true }), signal: streamOptions.signal,
    })
    if (!response.ok) {
      const raw = await response.text()
      let data: unknown = raw
      try { data = raw ? JSON.parse(raw) : undefined } catch {}
      const record = data && typeof data === 'object' ? data as Record<string, unknown> : undefined
      throw new TermAgentError(String(record?.error || record?.message || raw || response.statusText), response.status, typeof record?.code === 'string' ? record.code : undefined)
    }
    for await (const frame of decodeSse(response)) yield frame
  }

  command(sessionId: string, kind: CommandKind, payload: Record<string, unknown> = {}, options: CommandOptions = {}): Promise<ApiCommandResult> {
    const command: ApiCommand = {
      version: 1,
      commandId: options.commandId || randomId('cmd'),
      clientId: this.clientId,
      sessionId,
      issuedAt: Date.now(),
      ...(options.expectedSequence === undefined ? {} : { expectedSequence: options.expectedSequence }),
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      kind,
      payload,
    }
    return this.json(apiPath.commandsForSession(sessionId), 'POST', command)
  }

  enqueue(id: string, prompt: string, options: EnqueueOptions = {}) {
    const { mode, autonomous, agent, ...commandOptions } = options
    return this.command(id, 'session.queue', {
      prompt,
      ...(mode ? { mode } : {}),
      ...(autonomous === undefined ? {} : { autonomous }),
      ...(agent ? { agent } : {}),
    }, commandOptions)
  }
  editQueue(id: string, queueId: string, prompt: string, options?: CommandOptions) { return this.command(id, 'session.queue.edit', { queueId, prompt }, options) }
  cancelQueue(id: string, queueId: string, options?: CommandOptions) { return this.command(id, 'session.queue.cancel', { queueId }, options) }
  moveQueue(id: string, queueId: string, direction: -1 | 1, options?: CommandOptions) { return this.command(id, 'session.queue.move', { queueId, direction }, options) }
  interrupt(id: string, options?: CommandOptions) { return this.command(id, 'session.interrupt', {}, options) }
  abort(id: string, options?: CommandOptions) { return this.command(id, 'session.abort', {}, options) }
  compact(id: string, options?: CommandOptions) { return this.command(id, 'session.compact', {}, options) }
  undo(id: string, options?: CommandOptions) { return this.command(id, 'session.undo', {}, options) }
  redo(id: string, options?: CommandOptions) { return this.command(id, 'session.redo', {}, options) }
  fork(id: string, at?: number, options?: CommandOptions) { return this.command(id, 'session.fork', { ...(at === undefined ? {} : { at }) }, options) }
  resolvePermission(id: string, requestId: string, decision: 'once' | 'always' | 'deny', options?: CommandOptions) { return this.command(id, 'permission.resolve', { requestId, decision }, options) }
  answerQuestion(id: string, requestId: string, answers: string[][], options?: CommandOptions) { return this.command(id, 'question.answer', { requestId, answers }, options) }
  rejectQuestion(id: string, requestId: string, options?: CommandOptions) { return this.command(id, 'question.reject', { requestId }, options) }
  cancelQuestion(id: string, requestId: string, options?: CommandOptions) { return this.command(id, 'question.cancel', { requestId }, options) }
  async cancelTask(id: string, options?: CommandOptions) {
    const task = await this.getTask(id)
    if (!task.sessionId) throw new TermAgentError(`Task ${id} is not attached to a session`, 409)
    return this.command(task.sessionId, 'task.cancel', { taskId: id }, options)
  }
  async resumeTask(taskId: string, prompt: string, options?: CommandOptions) {
    const task = await this.getTask(taskId)
    if (!task.sessionId) throw new TermAgentError(`Task ${taskId} is not attached to a session`, 409)
    return this.command(task.sessionId, 'task.resume', { taskId, prompt }, options)
  }
  async sendTask(taskId: string, prompt: string, options?: CommandOptions) {
    const task = await this.getTask(taskId)
    if (!task.sessionId) throw new TermAgentError(`Task ${taskId} is not attached to a session`, 409)
    return this.command(task.sessionId, 'task.send', { taskId, prompt }, options)
  }

  createCheckpoint(id: string, label = 'client') { return this.json(apiPath.checkpoints(id), 'POST', { label }) }
  restoreCheckpoint(id: string, checkpointId: string) { return this.json(apiPath.checkpointRestore(id, checkpointId), 'POST', {}) }
  branchCheckpoint(id: string, checkpointId: string, restoreWorkspace = false) { return this.json(apiPath.checkpointBranch(id, checkpointId), 'POST', { restoreWorkspace }) }
}

export type { SessionMeta, SessionHistory, SessionSnapshot, SessionStatus, RuntimeStatus, ServerInfo, ChatMessage, ApiEvent, ReconnectRequest, CommandReceipt, QueuedPrompt }
