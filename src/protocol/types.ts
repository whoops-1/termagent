import { canonicalJson } from '../util/canonical.js'

export const PROTOCOL_VERSION = 1 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION

export type DurableSequence = number & { readonly __brand: 'TermAgentDurableSequence' }

export function durableSequence(value: number): DurableSequence {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Durable sequence must be a non-negative safe integer')
  return value as DurableSequence
}

export function nextDurableSequence(current: DurableSequence): DurableSequence {
  if (current >= Number.MAX_SAFE_INTEGER) throw new RangeError('Durable sequence exhausted safe integer range')
  return durableSequence(current + 1)
}

export function assertDurableSequenceAdvances(previous: DurableSequence, current: DurableSequence): void {
  if (current <= previous) throw new RangeError(`Durable sequence must advance strictly: ${previous} -> ${current}`)
}

export type EventDurability = 'durable' | 'live'
export type EventCategory = 'session' | 'message' | 'tool' | 'task' | 'todo' | 'permission' | 'question' | 'context' | 'mutation' | 'diff' | 'verification' | 'skill' | 'provider' | 'runtime'

export type KnownEventKind =
  | 'session.created'
  | 'session.updated'
  | 'session.turn.started'
  | 'session.turn.completed'
  | 'session.turn.failed'
  | 'session.message.user'
  | 'session.message.assistant'
  | 'session.message.tool'
  | 'session.message.updated'
  | 'session.reasoning.started'
  | 'session.reasoning.completed'
  | 'session.tool.called'
  | 'session.tool.started'
  | 'session.tool.progress'
  | 'session.tool.completed'
  | 'session.tool.failed'
  | 'session.task.created'
  | 'session.task.updated'
  | 'session.task.notification'
  | 'session.todo.updated'
  | 'session.permission.asked'
  | 'session.permission.resolved'
  | 'session.question.asked'
  | 'session.question.resolved'
  | 'session.compaction.started'
  | 'session.compaction.completed'
  | 'session.mutation.applied'
  | 'session.diff.updated'
  | 'session.verification.completed'
  | 'session.skill.search'
  | 'session.skill.load'
  | 'session.skill.skip'
  | 'session.provider.updated'
  | 'session.branch.created'
  | 'session.context.checkpoint'
  | 'session.summary.updated'
  | 'session.queue.updated'
  | 'session.workflow.updated'
  | 'session.checkpoint.created'
  | 'session.checkpoint.restored'
  | 'session.history.undo'
  | 'session.history.redo'
  | 'session.command.receipt'
  | 'session.text.delta'
  | 'session.reasoning.delta'
  | 'session.tool.output.delta'
  | 'runtime.activity.changed'
  | 'runtime.status.changed'
  | 'runtime.heartbeat'
  | 'runtime.connection.changed'

export type EventKind = KnownEventKind | (string & {})

export const DURABLE_EVENT_KINDS: ReadonlySet<KnownEventKind> = new Set([
  'session.created',
  'session.updated',
  'session.turn.started',
  'session.turn.completed',
  'session.turn.failed',
  'session.message.user',
  'session.message.assistant',
  'session.reasoning.started',
  'session.reasoning.completed',
  'session.tool.called',
  'session.tool.started',
  'session.tool.progress',
  'session.tool.completed',
  'session.tool.failed',
  'session.task.created',
  'session.task.updated',
  'session.todo.updated',
  'session.permission.asked',
  'session.permission.resolved',
  'session.question.asked',
  'session.question.resolved',
  'session.compaction.started',
  'session.compaction.completed',
  'session.mutation.applied',
  'session.diff.updated',
  'session.verification.completed',
  'session.skill.search',
  'session.skill.load',
  'session.skill.skip',
  'session.provider.updated',
  'session.branch.created',
  'session.context.checkpoint',
  'session.summary.updated',
  'session.workflow.updated',
  'session.checkpoint.created',
  'session.checkpoint.restored',
  'session.history.undo',
  'session.history.redo',
  'session.command.receipt',
  'session.message.tool',
  'session.message.updated',
  'session.task.notification',
  'session.queue.updated',
])

export const LIVE_ONLY_EVENT_KINDS: ReadonlySet<KnownEventKind> = new Set([
  'session.text.delta',
  'session.reasoning.delta',
  'session.tool.output.delta',
  'runtime.activity.changed',
  'runtime.status.changed',
  'runtime.heartbeat',
  'runtime.connection.changed',
])

export function knownEventDurability(kind: string): EventDurability | undefined {
  if (DURABLE_EVENT_KINDS.has(kind as KnownEventKind)) return 'durable'
  if (LIVE_ONLY_EVENT_KINDS.has(kind as KnownEventKind)) return 'live'
  return undefined
}

export type LiveEventKind = Extract<KnownEventKind,
  | 'session.text.delta'
  | 'session.reasoning.delta'
  | 'session.tool.output.delta'
  | 'runtime.activity.changed'
  | 'runtime.status.changed'
  | 'runtime.heartbeat'
  | 'runtime.connection.changed'
>
export type DurableEventKind = Exclude<KnownEventKind, LiveEventKind>

export interface EventEnvelope<TPayload = unknown> {
  version: ProtocolVersion
  eventId: string
  sessionId: string
  sequence: DurableSequence | null
  timestamp: number
  category: EventCategory
  kind: EventKind
  durable: boolean
  payload: TPayload
}

export type DurableEventEnvelope<TPayload = unknown> = EventEnvelope<TPayload> & {
  durable: true
  sequence: DurableSequence
}

export type LiveEventEnvelope<TPayload = unknown> = EventEnvelope<TPayload> & {
  durable: false
  sequence: null
}

export interface EventStreamReady {
  type: 'ready'
  version: ProtocolVersion
  sessionId: string
  currentSequence: DurableSequence
  replayAfter: DurableSequence
  snapshotRequired: boolean
}

export interface EventStreamHeartbeat {
  type: 'heartbeat'
  version: ProtocolVersion
  sessionId: string
  timestamp: number
  currentSequence: DurableSequence
}

export interface EventStreamError {
  type: 'error'
  version: ProtocolVersion
  sessionId: string
  code: 'invalid-cursor' | 'session-not-found' | 'unauthorized' | 'server-error'
  message: string
}

export type EventStreamFrame =
  | EventStreamReady
  | DurableEventEnvelope
  | LiveEventEnvelope
  | EventStreamHeartbeat
  | EventStreamError

export interface CommandEnvelope<TPayload = unknown> {
  version: ProtocolVersion
  commandId: string
  clientId: string
  sessionId: string
  issuedAt: number
  expectedSequence?: DurableSequence
  expectedRevision?: string
  kind: CommandKind
  payload: TPayload
}

export type CommandKind =
  | 'session.prompt'
  | 'session.steer'
  | 'session.queue'
  | 'session.resume'
  | 'session.abort'
  | 'session.interrupt'
  | 'session.compact'
  | 'session.undo'
  | 'session.redo'
  | 'session.fork'
  | 'session.rename'
  | 'permission.resolve'
  | 'question.answer'
  | 'question.reject'
  | 'question.cancel'
  | 'task.cancel'
  | 'task.resume'
  | 'task.send'
  | 'session.agent.select'
  | 'session.model.select'

export type CommandAdmissionStatus = 'accepted' | 'duplicate' | 'stale' | 'rejected'

export interface CommandReceipt {
  version: ProtocolVersion
  commandId: string
  clientId: string
  sessionId: string
  status: CommandAdmissionStatus
  currentSequence: DurableSequence
  appliedSequence?: DurableSequence
  originalReceipt?: string
  reason?: 'expected-sequence-mismatch' | 'expected-revision-mismatch' | 'already-resolved' | 'idempotency-conflict' | 'invalid-command' | 'unauthorized' | 'unsupported'
}

export interface PermissionResolution {
  commandId: string
  clientId: string
  decision: 'once' | 'always' | 'deny'
}

export interface QuestionResolution {
  commandId: string
  clientId: string
  disposition: 'replied' | 'rejected' | 'cancelled'
  answers?: string[][]
}

export interface PermissionRequestState {
  kind: 'permission'
  requestId: string
  sessionId: string
  revision: number
  status: 'pending' | 'resolved' | 'cancelled'
  tool: string
  action: string
  resources: string[]
  createdAt: number
  resolvedAt?: number
  resolution?: PermissionResolution
}

export interface QuestionRequestState {
  kind: 'question'
  requestId: string
  sessionId: string
  revision: number
  status: 'pending' | 'replied' | 'rejected' | 'cancelled'
  questions: ReadonlyArray<{
    id: string
    question: string
    options?: ReadonlyArray<{ label: string; description?: string }>
    multi?: boolean
    custom?: boolean
  }>
  createdAt: number
  resolvedAt?: number
  resolution?: QuestionResolution
}

export type InteractionRequestState = PermissionRequestState | QuestionRequestState

export interface ReconnectRequest {
  version: ProtocolVersion
  clientId: string
  sessionId: string
  lastDurableSequence: DurableSequence
  knownRevision?: string
}

export interface ReconciliationSnapshot<TState = unknown> {
  version: ProtocolVersion
  sessionId: string
  sequence: DurableSequence
  revision: string
  capturedAt: number
  state: TState
}

export interface ReconnectPlan<TState = unknown> {
  version: ProtocolVersion
  sessionId: string
  requestedAfter: DurableSequence
  currentSequence: DurableSequence
  revision: string
  strategy: 'replay' | 'snapshot-and-replay'
  replayAfter: DurableSequence
  snapshot?: ReconciliationSnapshot<TState>
}

export function commandIdempotencyKey(command: Pick<CommandEnvelope, 'sessionId' | 'clientId' | 'commandId'>): string {
  return JSON.stringify([command.sessionId, command.clientId, command.commandId])
}
export function commandFingerprint(command: CommandEnvelope): string {
  return canonicalJson({
    version: command.version,
    sessionId: command.sessionId,
    kind: command.kind,
    expectedSequence: command.expectedSequence,
    expectedRevision: command.expectedRevision,
    payload: command.payload,
  })
}

export function expectedStateMatches(command: Pick<CommandEnvelope, 'expectedSequence' | 'expectedRevision'>, current: { sequence: DurableSequence; revision?: string }): boolean {
  if (command.expectedSequence !== undefined && command.expectedSequence !== current.sequence) return false
  if (command.expectedRevision !== undefined && command.expectedRevision !== current.revision) return false
  return true
}

export function planReconnect(request: ReconnectRequest, current: { sequence: DurableSequence; revision: string; firstReplayableSequence?: DurableSequence }): ReconnectPlan {
  const firstReplayable = current.firstReplayableSequence ?? durableSequence(1)
  const cursorBoundary = Math.max(0, firstReplayable - 1)
  const cursorIsAvailable = request.lastDurableSequence >= cursorBoundary
  const revisionMatches = request.knownRevision === undefined || request.knownRevision === current.revision
  if (cursorIsAvailable && revisionMatches) {
    return {
      version: PROTOCOL_VERSION,
      sessionId: request.sessionId,
      requestedAfter: request.lastDurableSequence,
      currentSequence: current.sequence,
      revision: current.revision,
      strategy: 'replay',
      replayAfter: request.lastDurableSequence,
    }
  }
  return {
    version: PROTOCOL_VERSION,
    sessionId: request.sessionId,
    requestedAfter: request.lastDurableSequence,
    currentSequence: current.sequence,
    revision: current.revision,
    strategy: 'snapshot-and-replay',
    replayAfter: current.sequence,
  }
}

export function firstWriterWins(
  request: PermissionRequestState,
  resolution: PermissionResolution,
  resolvedAt?: number,
): { applied: true; request: PermissionRequestState } | { applied: false; reason: 'already-resolved'; request: PermissionRequestState }
export function firstWriterWins(
  request: QuestionRequestState,
  resolution: QuestionResolution,
  resolvedAt?: number,
): { applied: true; request: QuestionRequestState } | { applied: false; reason: 'already-resolved'; request: QuestionRequestState }
export function firstWriterWins(
  request: InteractionRequestState,
  resolution: PermissionResolution | QuestionResolution,
  resolvedAt = Date.now(),
): { applied: true; request: InteractionRequestState } | { applied: false; reason: 'already-resolved'; request: InteractionRequestState } {
  if (request.status !== 'pending') return { applied: false, reason: 'already-resolved', request }

  if (request.kind === 'permission') {
    if (!('decision' in resolution)) throw new TypeError('Permission request requires a permission decision')
    return {
      applied: true,
      request: {
        ...request,
        status: 'resolved',
        resolvedAt,
        resolution,
        revision: request.revision + 1,
      },
    }
  }

  if (!('disposition' in resolution)) throw new TypeError('Question request requires a disposition')
  if (resolution.disposition === 'replied' && !resolution.answers) throw new TypeError('Answered question requests require answers')
  return {
    applied: true,
    request: {
      ...request,
      status: resolution.disposition,
      resolvedAt,
      resolution,
      revision: request.revision + 1,
    },
  }
}
