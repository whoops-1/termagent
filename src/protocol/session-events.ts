import crypto from 'node:crypto'
import { canonicalJson } from '../util/canonical.js'
import type { DurableEventEnvelope, EventCategory, EventKind, LiveEventEnvelope, LiveEventKind, ProtocolVersion } from './types.js'

export interface StoredSessionEventLike {
  type: string
  ts: number
  data: unknown
  eventId?: string
  version?: ProtocolVersion
  sequence?: number
  durable?: true
  category?: EventCategory
  kind?: EventKind
}

export function legacyEventKind(event: Pick<StoredSessionEventLike, 'type' | 'data'>): EventKind {
  switch (event.type) {
    case 'meta':
      return 'session.created'
    case 'branch':
      return 'session.branch.created'
    case 'message': {
      const message = event.data && typeof event.data === 'object' && 'message' in event.data
        ? (event.data as { message?: unknown }).message
        : event.data
      const role = message && typeof message === 'object' && 'role' in message
        ? String((message as { role?: unknown }).role || '')
        : ''
      if (role === 'user') return 'session.message.user'
      if (role === 'assistant') return 'session.message.assistant'
      if (role === 'tool') return 'session.message.tool'
      return 'session.message.updated'
    }
    case 'context.checkpoint':
      return 'session.context.checkpoint'
    case 'compaction':
      return event.data && typeof event.data === 'object' && (event.data as { stage?: unknown }).stage === 'started'
        ? 'session.compaction.started'
        : 'session.compaction.completed'
    case 'summary':
      return 'session.summary.updated'
    case 'todo':
      return 'session.todo.updated'
    case 'workflow':
      return 'session.workflow.updated'
    case 'checkpoint':
      return 'session.checkpoint.created'
    case 'checkpoint.restore':
      return 'session.checkpoint.restored'
    case 'turn': {
      const status = event.data && typeof event.data === 'object' ? String((event.data as { status?: unknown }).status || '') : ''
      if (status === 'started') return 'session.turn.started'
      if (status === 'failed') return 'session.turn.failed'
      return 'session.turn.completed'
    }
    case 'undo':
      return 'session.history.undo'
    case 'redo':
      return 'session.history.redo'
    case 'skill.search':
      return 'session.skill.search'
    case 'skill.load':
      return 'session.skill.load'
    case 'skill.skip':
      return 'session.skill.skip'
    case 'question.asked':
      return 'session.question.asked'
    case 'question.replied':
    case 'question.rejected':
    case 'question.cancelled':
      return 'session.question.resolved'
    case 'permission.asked':
      return 'session.permission.asked'
    case 'permission.resolved':
    case 'permission.cancelled':
      return 'session.permission.resolved'
    case 'tool.call':
      return 'session.tool.called'
    case 'provider.turn':
      return 'session.provider.updated'
    case 'task.notification':
    case 'task.notification.consumed':
      return 'session.task.notification'
    case 'prompt.queue':
      return 'session.queue.updated'
    case 'mutation':
      return 'session.mutation.applied'
    case 'diff':
      return 'session.diff.updated'
    case 'verification':
      return 'session.verification.completed'
    case 'command.receipt':
      return 'session.command.receipt'
    default:
      return `session.${event.type}`
  }
}

export function legacyEventCategory(kind: EventKind): EventCategory {
  if (kind.startsWith('session.message')) return 'message'
  if (kind.startsWith('session.tool')) return 'tool'
  if (kind.startsWith('session.task')) return 'task'
  if (kind.startsWith('session.todo')) return 'todo'
  if (kind.startsWith('session.permission')) return 'permission'
  if (kind.startsWith('session.question')) return 'question'
  if (kind.startsWith('session.context')) return 'context'
  if (kind.startsWith('session.mutation')) return 'mutation'
  if (kind.startsWith('session.diff')) return 'diff'
  if (kind.startsWith('session.skill')) return 'skill'
  if (kind.startsWith('session.provider')) return 'provider'
  if (kind === 'session.verification.completed') return 'verification'
  if (kind.startsWith('session.reasoning')) return 'message'
  if (kind.startsWith('session.text')) return 'message'
  if (kind.startsWith('session')) return 'session'
  return 'runtime'
}

function stableLegacyEventId(sessionId: string, sequence: number, event: Pick<StoredSessionEventLike, 'type' | 'data'>): string {
  const seed = `${sessionId}\0${sequence}\0${event.type}\0${canonicalJson(event.data)}`
  return `evt_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

export function toDurableEventEnvelope(
  sessionId: string,
  event: StoredSessionEventLike,
  sequence: number,
): DurableEventEnvelope {
  const kind = event.kind ?? legacyEventKind(event)
  const category = event.category ?? legacyEventCategory(kind)
  const eventId = event.eventId ?? stableLegacyEventId(sessionId, sequence, event)
  return {
    version: event.version ?? 1,
    eventId,
    sessionId,
    sequence: sequence as DurableEventEnvelope['sequence'],
    timestamp: event.ts,
    category,
    kind,
    durable: true,
    payload: event.data,
  }
}

export function enrichStoredEvent(sessionId: string, event: StoredSessionEventLike, sequence: number): StoredSessionEventLike {
  const kind = event.kind ?? legacyEventKind(event)
  return {
    ...event,
    eventId: event.eventId ?? stableLegacyEventId(sessionId, sequence, event),
    version: event.version ?? 1,
    sequence,
    durable: true,
    category: event.category ?? legacyEventCategory(kind),
    kind,
  }
}
export function toLiveEventEnvelope<TPayload>(
  sessionId: string,
  eventId: string,
  kind: LiveEventKind,
  payload: TPayload,
  timestamp = Date.now(),
): LiveEventEnvelope<TPayload> {
  return {
    version: 1,
    eventId,
    sessionId,
    sequence: null,
    timestamp,
    category: legacyEventCategory(kind),
    kind,
    durable: false,
    payload,
  }
}
