import { knownEventDurability, PROTOCOL_VERSION, type CommandEnvelope, type CommandKind, type DurableSequence, type EventEnvelope, type InteractionRequestState, type ReconnectRequest, type ReconciliationSnapshot } from './types.js'

export class ProtocolValidationError extends Error {
  readonly code = 'invalid-protocol'
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path}`)
    this.name = 'ProtocolValidationError'
  }
}
const EVENT_CATEGORIES = new Set(['session','message','tool','task','todo','permission','question','context','mutation','diff','skill','provider','runtime'])

const COMMAND_KINDS: ReadonlySet<CommandKind> = new Set([
  'session.prompt',
  'session.steer',
  'session.queue',
  'session.resume',
  'session.abort',
  'session.interrupt',
  'session.compact',
  'session.undo',
  'session.redo',
  'session.fork',
  'session.rename',
  'permission.resolve',
  'question.answer',
  'question.reject',
  'question.cancel',
  'task.cancel',
  'task.resume',
  'task.send',
  'session.agent.select',
  'session.model.select',
])

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError('Expected object', path)
}

function assertString(value: unknown, path: string, maxLength = 4096): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000\r\n]/.test(value)) throw new ProtocolValidationError('Expected a non-empty string without control/newline characters', path)
}

function assertTimestamp(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ProtocolValidationError('Expected a finite non-negative timestamp', path)
}

function assertSequence(value: unknown, path: string): asserts value is DurableSequence {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ProtocolValidationError('Expected a non-negative safe integer sequence', path)
}

function assertVersion(value: unknown, path: string): asserts value is typeof PROTOCOL_VERSION {
  if (value !== PROTOCOL_VERSION) throw new ProtocolValidationError(`Unsupported protocol version; expected ${PROTOCOL_VERSION}`, path)
}

export function validateEventEnvelope(value: unknown): EventEnvelope {
  assertRecord(value, '$')
  assertVersion(value.version, '$.version')
  assertString(value.eventId, '$.eventId', 256)
  assertString(value.sessionId, '$.sessionId', 256)
  assertTimestamp(value.timestamp, '$.timestamp')
  assertString(value.category, '$.category', 64)
  if (!EVENT_CATEGORIES.has(value.category)) throw new ProtocolValidationError('Unknown event category', '$.category')
  assertString(value.kind, '$.kind', 256)
  if (typeof value.durable !== 'boolean') throw new ProtocolValidationError('Expected boolean durable flag', '$.durable')

  const known = knownEventDurability(value.kind)
  if (known && known !== (value.durable ? 'durable' : 'live')) throw new ProtocolValidationError(`Event kind ${value.kind} is classified as ${known}`, '$.durable')

  if (value.durable) {
    assertSequence(value.sequence, '$.sequence')
    if (value.sequence === 0) throw new ProtocolValidationError('Durable event sequence must be greater than zero', '$.sequence')
  } else if (value.sequence !== null) {
    throw new ProtocolValidationError('Live-only events must not carry a durable sequence', '$.sequence')
  }

  return value as unknown as EventEnvelope
}

export function validateCommandEnvelope(value: unknown): CommandEnvelope {
  assertRecord(value, '$')
  assertVersion(value.version, '$.version')
  assertString(value.commandId, '$.commandId', 256)
  assertString(value.clientId, '$.clientId', 256)
  assertString(value.sessionId, '$.sessionId', 256)
  assertTimestamp(value.issuedAt, '$.issuedAt')
  assertString(value.kind, '$.kind', 128)
  if (!COMMAND_KINDS.has(value.kind as CommandKind)) throw new ProtocolValidationError(`Unsupported command kind ${value.kind}`, '$.kind')
  if (value.expectedSequence !== undefined) assertSequence(value.expectedSequence, '$.expectedSequence')
  if (value.expectedRevision !== undefined) assertString(value.expectedRevision, '$.expectedRevision', 256)
  return value as unknown as CommandEnvelope
}

export function validateReconnectRequest(value: unknown): ReconnectRequest {
  assertRecord(value, '$')
  assertVersion(value.version, '$.version')
  assertString(value.clientId, '$.clientId', 256)
  assertString(value.sessionId, '$.sessionId', 256)
  assertSequence(value.lastDurableSequence, '$.lastDurableSequence')
  if (value.knownRevision !== undefined) assertString(value.knownRevision, '$.knownRevision', 256)
  return value as unknown as ReconnectRequest
}

export function validateReconciliationSnapshot(value: unknown): ReconciliationSnapshot {
  assertRecord(value, '$')
  assertVersion(value.version, '$.version')
  assertString(value.sessionId, '$.sessionId', 256)
  assertSequence(value.sequence, '$.sequence')
  assertString(value.revision, '$.revision', 256)
  assertTimestamp(value.capturedAt, '$.capturedAt')
  if (!('state' in value)) throw new ProtocolValidationError('Missing snapshot state', '$.state')
  return value as unknown as ReconciliationSnapshot
}

export function validateInteractionRequest(value: unknown): InteractionRequestState {
  assertRecord(value, '$')
  if (value.kind !== 'permission' && value.kind !== 'question') throw new ProtocolValidationError('Expected permission or question request', '$.kind')
  assertString(value.requestId, '$.requestId', 256)
  assertString(value.sessionId, '$.sessionId', 256)
  const revision = value.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new ProtocolValidationError('Expected non-negative safe integer revision', '$.revision')
  assertTimestamp(value.createdAt, '$.createdAt')
  if (value.resolvedAt !== undefined) assertTimestamp(value.resolvedAt, '$.resolvedAt')
  if (value.kind === 'permission') {
    if (value.status !== 'pending' && value.status !== 'resolved' && value.status !== 'cancelled') throw new ProtocolValidationError('Invalid permission request status', '$.status')
    assertString(value.tool, '$.tool', 256)
    assertString(value.action, '$.action', 128)
    if (!Array.isArray(value.resources)) throw new ProtocolValidationError('Expected resource array', '$.resources')
    if (value.resolution !== undefined) {
      assertRecord(value.resolution, '$.resolution')
      assertString(value.resolution.commandId, '$.resolution.commandId', 256)
      assertString(value.resolution.clientId, '$.resolution.clientId', 256)
      if (value.resolution.decision !== 'once' && value.resolution.decision !== 'always' && value.resolution.decision !== 'deny') throw new ProtocolValidationError('Invalid permission decision', '$.resolution.decision')
      if ((value.status === 'pending') && value.resolution) throw new ProtocolValidationError('Pending permission request cannot have a resolution', '$.resolution')
      if (value.status === 'resolved' && !value.resolution) throw new ProtocolValidationError('Resolved permission request requires a resolution', '$.resolution')
    }
    return value as unknown as InteractionRequestState
  }
  if (value.status !== 'pending' && value.status !== 'replied' && value.status !== 'rejected' && value.status !== 'cancelled') throw new ProtocolValidationError('Invalid question request status', '$.status')
  if (!Array.isArray(value.questions)) throw new ProtocolValidationError('Expected question array', '$.questions')
  if (value.resolution !== undefined) {
    assertRecord(value.resolution, '$.resolution')
    assertString(value.resolution.commandId, '$.resolution.commandId', 256)
    assertString(value.resolution.clientId, '$.resolution.clientId', 256)
    if (value.resolution.disposition !== 'replied' && value.resolution.disposition !== 'rejected' && value.resolution.disposition !== 'cancelled') throw new ProtocolValidationError('Invalid question disposition', '$.resolution.disposition')
    if (value.resolution.answers !== undefined && !Array.isArray(value.resolution.answers)) throw new ProtocolValidationError('Expected answer array', '$.resolution.answers')
    if (value.resolution.disposition === 'replied' && value.resolution.answers === undefined) throw new ProtocolValidationError('Replied question requests require answers', '$.resolution.answers')
    if (value.status === 'pending') throw new ProtocolValidationError('Pending question request cannot have a resolution', '$.resolution')
    if (value.status === 'replied' && value.resolution.disposition !== 'replied') throw new ProtocolValidationError('Replied question request requires a replied resolution', '$.resolution.disposition')
    if (value.status === 'rejected' && value.resolution.disposition !== 'rejected') throw new ProtocolValidationError('Rejected question request requires a rejected resolution', '$.resolution.disposition')
    if (value.status === 'cancelled' && value.resolution.disposition !== 'cancelled') throw new ProtocolValidationError('Cancelled question request requires a cancelled resolution', '$.resolution.disposition')
  }
  if (value.status !== 'pending' && value.resolution === undefined) throw new ProtocolValidationError('Resolved question request requires a resolution', '$.resolution')
  return value as unknown as InteractionRequestState
}
