import crypto from 'node:crypto'
import type { SessionStore, SessionEvent } from './store.js'

export type PromptQueueStatus = 'queued' | 'executing' | 'completed' | 'cancelled' | 'failed'

export type QueuedPrompt = {
  id: string
  sessionId: string
  content: string
  createdAt: number
  updatedAt: number
  position: number
  status: PromptQueueStatus
  sourceClient: string
  metadata?: Record<string, unknown>
  error?: string
  startedAt?: number
  completedAt?: number
}

export type PromptQueueAction =
  | 'queued'
  | 'edited'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'reordered'

function normalizeContent(value: unknown) {
  return typeof value === 'string' ? value.trimEnd() : ''
}

function normalizeItem(event: SessionEvent, previous?: QueuedPrompt): QueuedPrompt | undefined {
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
  const id = typeof data.id === 'string' ? data.id : ''
  if (!id) return previous
  const status = typeof data.status === 'string' && ['queued', 'executing', 'completed', 'cancelled', 'failed'].includes(data.status)
    ? data.status as PromptQueueStatus
    : previous?.status ?? 'queued'
  const content = normalizeContent(data.content ?? previous?.content)
  if (!content && !previous) return undefined
  return {
    id,
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : previous?.sessionId ?? '',
    content,
    createdAt: Number(data.createdAt ?? previous?.createdAt ?? event.ts),
    updatedAt: Number(data.updatedAt ?? event.ts),
    position: Number.isSafeInteger(Number(data.position)) ? Math.max(0, Number(data.position)) : previous?.position ?? 0,
    status,
    sourceClient: typeof data.sourceClient === 'string' ? data.sourceClient : previous?.sourceClient ?? 'terminal',
    ...(data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
      ? { metadata: structuredClone(data.metadata) as Record<string, unknown> }
      : previous?.metadata ? { metadata: previous.metadata } : {}),
    ...(typeof data.error === 'string' && data.error ? { error: data.error } : previous?.error ? { error: previous.error } : {}),
    ...(Number.isFinite(Number(data.startedAt)) ? { startedAt: Number(data.startedAt) } : previous?.startedAt ? { startedAt: previous.startedAt } : {}),
    ...(Number.isFinite(Number(data.completedAt)) ? { completedAt: Number(data.completedAt) } : previous?.completedAt ? { completedAt: previous.completedAt } : {}),
  }
}

export function projectPromptQueue(events: readonly SessionEvent[], activeOnly = true): QueuedPrompt[] {
  const state = new Map<string, QueuedPrompt>()
  for (const event of events) {
    if (event.type !== 'prompt.queue') continue
    const item = normalizeItem(event, state.get(String(event.data?.id ?? '')))
    if (item) state.set(item.id, item)
  }
  const items = [...state.values()]
  return items
    .filter(item => !activeOnly || item.status === 'queued' || item.status === 'executing')
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export class SessionPromptQueue {
  constructor(private readonly store: SessionStore) {}

  private async current(sessionId: string, activeOnly = true) {
    const loaded = await this.store.load(sessionId)
    return projectPromptQueue(loaded.events, activeOnly)
  }

  private async append(sessionId: string, action: PromptQueueAction, item: Partial<QueuedPrompt> & { id: string }) {
    const now = Date.now()
    return await this.store.append(sessionId, {
      type: 'prompt.queue',
      ts: now,
      data: {
        action,
        sessionId,
        ...item,
        updatedAt: now,
        ...(item.createdAt === undefined ? { createdAt: now } : {}),
      },
    })
  }

  async enqueue(sessionId: string, content: string, options: { sourceClient?: string; metadata?: Record<string, unknown> } = {}) {
    const normalized = normalizeContent(content)
    if (!normalized) throw new Error('Queued prompt cannot be empty')
    return await this.store.withSessionMutation(sessionId, async () => {
      const items = await this.current(sessionId)
      const now = Date.now()
      const nextPosition = items.reduce((max, item) => Math.max(max, item.position), -1) + 1
      const item: QueuedPrompt = {
        id: `qp_${now.toString(36)}_${crypto.randomBytes(5).toString('hex')}`,
        sessionId,
        content: normalized,
        createdAt: now,
        updatedAt: now,
        position: nextPosition,
        status: 'queued',
        sourceClient: options.sourceClient ?? 'terminal',
        ...(options.metadata ? { metadata: structuredClone(options.metadata) } : {}),
      }
      await this.append(sessionId, 'queued', item)
      return item
    })
  }

  async list(sessionId: string, activeOnly = true) {
    return await this.current(sessionId, activeOnly)
  }

  async edit(sessionId: string, id: string, content: string) {
    const normalized = normalizeContent(content)
    if (!normalized) throw new Error('Queued prompt cannot be empty')
    return await this.store.withSessionMutation(sessionId, async () => {
      const item = (await this.current(sessionId, false)).find(value => value.id === id)
      if (!item) throw new Error(`Queued prompt not found: ${id}`)
      if (item.status !== 'queued') throw new Error(`Queued prompt ${id} is no longer editable`)
      const next = { ...item, content: normalized }
      await this.append(sessionId, 'edited', next)
      return next
    })
  }

  async cancel(sessionId: string, id: string) {
    return await this.store.withSessionMutation(sessionId, async () => {
      const item = (await this.current(sessionId, false)).find(value => value.id === id)
      if (!item) throw new Error(`Queued prompt not found: ${id}`)
      if (item.status !== 'queued') throw new Error(`Queued prompt ${id} cannot be cancelled from ${item.status}`)
      const next = { ...item, status: 'cancelled' as const, completedAt: Date.now() }
      await this.append(sessionId, 'cancelled', next)
      return next
    })
  }

  async move(sessionId: string, id: string, direction: -1 | 1) {
    return await this.store.withSessionMutation(sessionId, async () => {
      const active = await this.current(sessionId)
      const queued = active.filter(value => value.status === 'queued')
      const index = queued.findIndex(value => value.id === id)
      if (index < 0) {
        const item = active.find(value => value.id === id)
        if (item?.status === 'executing') throw new Error(`Queued prompt ${id} is currently executing`)
        throw new Error(`Queued prompt not found: ${id}`)
      }
      const target = index + direction
      if (target < 0 || target >= queued.length) return active

      const reordered = queued.slice()
      const [item] = reordered.splice(index, 1)
      reordered.splice(target, 0, item!)
      const base = Math.min(...reordered.map(value => value.position))
      for (let i = 0; i < reordered.length; i++) {
        const value = reordered[i]!
        const position = base + i
        if (value.position === position) continue
        await this.append(sessionId, 'reordered', { ...value, position })
      }
      return await this.current(sessionId)
    })
  }

  /**
   * A process crash can leave a durable queue item marked executing. There is
   * no live worker behind such an event after restart, so put it back into the
   * runnable queue before the first drain. The historical startedAt is kept as
   * evidence of the previous attempt; status is the authoritative state.
   */
  async recoverStaleExecuting(sessionId: string) {
    return await this.store.withSessionMutation(sessionId, async () => {
      const items = await this.current(sessionId, false)
      const stale = items.filter(value => value.status === 'executing')
      for (const item of stale) {
        await this.append(sessionId, 'queued', { ...item, status: 'queued' })
      }
      return stale.length
    })
  }

  async claimNext(sessionId: string) {
    return await this.store.withSessionMutation(sessionId, async () => {
      const item = (await this.current(sessionId)).find(value => value.status === 'queued')
      if (!item) return undefined
      const next = { ...item, status: 'executing' as const, startedAt: Date.now() }
      await this.append(sessionId, 'started', next)
      return next
    })
  }

  async complete(sessionId: string, id: string) {
    return await this.store.withSessionMutation(sessionId, async () => {
      const item = (await this.current(sessionId, false)).find(value => value.id === id)
      if (!item) return undefined
      const next = { ...item, status: 'completed' as const, completedAt: Date.now() }
      await this.append(sessionId, 'completed', next)
      return next
    })
  }

  async fail(sessionId: string, id: string, error: unknown) {
    return await this.store.withSessionMutation(sessionId, async () => {
      const item = (await this.current(sessionId, false)).find(value => value.id === id)
      if (!item) return undefined
      const next = { ...item, status: 'failed' as const, error: error instanceof Error ? error.message : String(error), completedAt: Date.now() }
      await this.append(sessionId, 'failed', next)
      return next
    })
  }

  async history(sessionId: string) {
    return await this.current(sessionId, false)
  }
}
