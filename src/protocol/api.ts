import type { CommandEnvelope, CommandReceipt, EventEnvelope, InteractionRequestState, ReconciliationSnapshot, DurableSequence } from './types.js'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  name?: string
  reasoning?: string
}

export type SessionMeta = {
  id: string
  cwd: string
  model: string
  created: number
  updated: number
  parentId?: string
  branchPoint?: number
  parentCheckpointId?: string
  parentSnapshotId?: string
}

export interface SessionHistory {
  meta?: SessionMeta
  messages: ChatMessage[]
  sequence: DurableSequence
  revision: string
}

export interface SessionStatus {
  sessionId: string
  running: boolean
  messageCount: number
  updated?: number
  sequence: DurableSequence
  revision: string
}

export interface RuntimeStatus {
  name: 'termagent'
  version: string
  cwd: string
  provider: string
  model: string
  mode: string
  runningSessions: string[]
}

export interface ServerInfo {
  name: 'termagent'
  version: string
  cwd: string
  provider: string
  model: string
  features: string[]
}

export interface SessionSnapshotState {
  meta?: SessionMeta
  messages: ChatMessage[]
  pendingInteractions: InteractionRequestState[]
  context: unknown
}

export type SessionSnapshot = ReconciliationSnapshot<SessionSnapshotState>

export interface Page<T> {
  items: T[]
  after: number
  total: number
  hasMore: boolean
}

export type QueuedPrompt = {
  id: string
  sessionId: string
  content: string
  createdAt: number
  updatedAt: number
  position: number
  status: 'queued' | 'executing' | 'completed' | 'cancelled' | 'failed'
  sourceClient: string
  metadata?: Record<string, unknown>
  error?: string
  startedAt?: number
  completedAt?: number
}

export interface TaskActivity {
  kind: 'tool' | 'status' | 'turn' | 'output'
  label: string
  detail?: string
  at: number
  callId?: string
  outcome?: 'success' | 'error' | 'running'
}

/** Safe task projection returned to clients; provider credentials and worker tokens are never serialized. */
export interface TaskRecord {
  id: string
  kind: 'shell' | 'agent'
  command?: string
  prompt?: string
  cwd: string
  started: number
  updated: number
  ended?: number
  status: 'queued' | 'running' | 'exited' | 'failed' | 'cancelled'
  pid?: number
  exitCode?: number
  outputBytes: number
  outputTruncated: boolean
  sessionId?: string
  childSessionId?: string
  parentSessionId?: string
  parentTaskId?: string
  specialistRole?: string
  delegationDepth?: number
  scopePaths: string[]
  result?: string
  error?: string
  runCount: number
  pendingPromptCount: number
  background: boolean
  coordinated: boolean
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; estimated: boolean }
  activity?: TaskActivity
}

export interface SubagentNode {
  task: TaskRecord
  depth: number
  children: SubagentNode[]
}

export interface SubagentWorkspace {
  sessionId: string
  agents: SubagentNode[]
  counts: { total: number; queued: number; running: number; completed: number; failed: number; cancelled: number }
}

export interface TaskEvent { seq: number; ts: number; type: string; data: unknown }

export interface ToolSummary { name: string; description: string; risk: string; schema: Record<string, unknown> }
export interface ModelProfile { name: string; provider: string; model: string; baseUrl?: string; variants: Array<Record<string, unknown>> }
export interface AgentSummary { name: string; description?: string; readOnly?: boolean }
export interface SkillSummary { name: string; description: string }
export interface CommandSummary { name: string; description?: string }

export interface PromptResult { sessionId: string; text: string }

export interface CommandResult<T = unknown> {
  receipt: CommandReceipt
  result?: T
}

export interface ApiRouteDefinition {
  id: string
  method: 'GET' | 'POST' | 'PATCH'
  path: string
}

export const API_ROUTES: readonly ApiRouteDefinition[] = [
  { id: 'pair', method: 'POST', path: '/api/v1/pair' },
  { id: 'device.get', method: 'GET', path: '/api/v1/device' },
  { id: 'device.revoke', method: 'POST', path: '/api/v1/device/revoke' },
  { id: 'health', method: 'GET', path: '/health' },
  { id: 'info', method: 'GET', path: '/api/v1/info' },
  { id: 'status', method: 'GET', path: '/api/v1/status' },
  { id: 'commands', method: 'GET', path: '/api/v1/commands' },
  { id: 'sessions.list', method: 'GET', path: '/api/v1/sessions' },
  { id: 'sessions.create', method: 'POST', path: '/api/v1/sessions' },
  { id: 'session.get', method: 'GET', path: '/api/v1/sessions/:sessionId' },
  { id: 'session.history', method: 'GET', path: '/api/v1/sessions/:sessionId/history' },
  { id: 'session.messages', method: 'GET', path: '/api/v1/sessions/:sessionId/messages' },
  { id: 'session.events', method: 'GET', path: '/api/v1/sessions/:sessionId/events' },
  { id: 'session.events.stream', method: 'GET', path: '/api/v1/sessions/:sessionId/events/stream' },
  { id: 'session.status', method: 'GET', path: '/api/v1/sessions/:sessionId/status' },
  { id: 'session.diff', method: 'GET', path: '/api/v1/sessions/:sessionId/diff' },
  { id: 'session.context', method: 'GET', path: '/api/v1/sessions/:sessionId/context' },
  { id: 'session.snapshot', method: 'GET', path: '/api/v1/sessions/:sessionId/snapshot' },
  { id: 'session.permissions', method: 'GET', path: '/api/v1/sessions/:sessionId/permissions' },
  { id: 'session.permission.resolve', method: 'POST', path: '/api/v1/sessions/:sessionId/permissions/:requestId' },
  { id: 'session.questions', method: 'GET', path: '/api/v1/sessions/:sessionId/questions' },
  { id: 'session.question.resolve', method: 'POST', path: '/api/v1/sessions/:sessionId/questions/:requestId' },
  { id: 'session.todo', method: 'GET', path: '/api/v1/sessions/:sessionId/todo' },
  { id: 'session.queue', method: 'GET', path: '/api/v1/sessions/:sessionId/queue' },
  { id: 'session.queue.enqueue', method: 'POST', path: '/api/v1/sessions/:sessionId/queue' },
  { id: 'session.queue.mutate', method: 'PATCH', path: '/api/v1/sessions/:sessionId/queue/:queueId' },
  { id: 'session.prompt', method: 'POST', path: '/api/v1/sessions/:sessionId/prompt' },
  { id: 'session.command', method: 'POST', path: '/api/v1/sessions/:sessionId/commands' },
  { id: 'session.checkpoints', method: 'GET', path: '/api/v1/sessions/:sessionId/checkpoints' },
  { id: 'session.checkpoint.create', method: 'POST', path: '/api/v1/sessions/:sessionId/checkpoints' },
  { id: 'session.checkpoint.restore', method: 'POST', path: '/api/v1/sessions/:sessionId/checkpoints/:checkpointId/restore' },
  { id: 'session.checkpoint.branch', method: 'POST', path: '/api/v1/sessions/:sessionId/checkpoints/:checkpointId/branch' },
  { id: 'tasks.list', method: 'GET', path: '/api/v1/tasks' },
  { id: 'subagents.list', method: 'GET', path: '/api/v1/sessions/:sessionId/subagents' },
  { id: 'task.get', method: 'GET', path: '/api/v1/tasks/:taskId' },
  { id: 'task.events', method: 'GET', path: '/api/v1/tasks/:taskId/events' },
  { id: 'task.events.stream', method: 'GET', path: '/api/v1/tasks/:taskId/events/stream' },
  { id: 'task.output', method: 'GET', path: '/api/v1/tasks/:taskId/output' },
  { id: 'task.cancel', method: 'POST', path: '/api/v1/tasks/:taskId/cancel' },
  { id: 'task.resume', method: 'POST', path: '/api/v1/tasks/:taskId/resume' },
  { id: 'task.send', method: 'POST', path: '/api/v1/tasks/:taskId/send' },
  { id: 'tools.list', method: 'GET', path: '/api/v1/tools' },
  { id: 'models.list', method: 'GET', path: '/api/v1/models' },
  { id: 'agents.list', method: 'GET', path: '/api/v1/agents' },
  { id: 'skills.list', method: 'GET', path: '/api/v1/skills' },
]

const sessionBase = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`
export const apiPath = {
  pair: () => '/api/v1/pair',
  device: () => '/api/v1/device',
  revokeDevice: () => '/api/v1/device/revoke',
  health: () => '/health',
  info: () => '/api/v1/info',
  status: () => '/api/v1/status',
  commands: () => '/api/v1/commands',
  sessions: () => '/api/v1/sessions',
  session: (id: string) => sessionBase(id),
  history: (id: string) => `${sessionBase(id)}/history`,
  messages: (id: string, after = 0, limit?: number, tail = false) => {
    const params = new URLSearchParams({ after: String(Math.max(0, Math.floor(after))) })
    if (limit !== undefined) params.set('limit', String(Math.max(1, Math.min(500, Math.floor(limit)))))
    if (tail) params.set('tail', '1')
    return `${sessionBase(id)}/messages?${params.toString()}`
  },
  events: (id: string, after = 0) => `${sessionBase(id)}/events?after=${Math.max(0, Math.floor(after))}`,
  eventStream: (id: string, after = 0) => `${sessionBase(id)}/events/stream?after=${Math.max(0, Math.floor(after))}`,
  sessionStatus: (id: string) => `${sessionBase(id)}/status`,
  diff: (id: string, staged = false) => `${sessionBase(id)}/diff?staged=${staged ? '1' : '0'}`,
  context: (id: string) => `${sessionBase(id)}/context`,
  snapshot: (id: string) => `${sessionBase(id)}/snapshot`,
  permissions: (id: string) => `${sessionBase(id)}/permissions`,
  permission: (id: string, requestId: string) => `${sessionBase(id)}/permissions/${encodeURIComponent(requestId)}`,
  questions: (id: string) => `${sessionBase(id)}/questions`,
  question: (id: string, requestId: string) => `${sessionBase(id)}/questions/${encodeURIComponent(requestId)}`,
  todo: (id: string) => `${sessionBase(id)}/todo`,
  queue: (id: string) => `${sessionBase(id)}/queue`,
  queueItem: (id: string, queueId: string) => `${sessionBase(id)}/queue/${encodeURIComponent(queueId)}`,
  prompt: (id: string) => `${sessionBase(id)}/prompt`,
  commandsForSession: (id: string) => `${sessionBase(id)}/commands`,
  checkpoints: (id: string) => `${sessionBase(id)}/checkpoints`,
  checkpointRestore: (id: string, checkpointId: string) => `${sessionBase(id)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
  checkpointBranch: (id: string, checkpointId: string) => `${sessionBase(id)}/checkpoints/${encodeURIComponent(checkpointId)}/branch`,
  tasks: () => '/api/v1/tasks',
  subagents: (id: string) => `${sessionBase(id)}/subagents`,
  task: (id: string) => `/api/v1/tasks/${encodeURIComponent(id)}`,
  taskEvents: (id: string, limit?: number, after?: number) => {
    const params = new URLSearchParams()
    if (limit !== undefined) params.set('limit', String(Math.max(1, Math.min(500, Math.floor(limit)))))
    if (after !== undefined) params.set('after', String(Math.max(0, Math.floor(after))))
    const query = params.toString()
    return `/api/v1/tasks/${encodeURIComponent(id)}/events${query ? `?${query}` : ''}`
  },
  taskEventStream: (id: string, after = 0) => `/api/v1/tasks/${encodeURIComponent(id)}/events/stream?after=${Math.max(0, Math.floor(after))}`,
  taskOutput: (id: string) => `/api/v1/tasks/${encodeURIComponent(id)}/output`,
  taskCancel: (id: string) => `/api/v1/tasks/${encodeURIComponent(id)}/cancel`,
  taskResume: (id: string) => `/api/v1/tasks/${encodeURIComponent(id)}/resume`,
  taskSend: (id: string) => `/api/v1/tasks/${encodeURIComponent(id)}/send`,
  tools: () => '/api/v1/tools',
  models: () => '/api/v1/models',
  agents: () => '/api/v1/agents',
  skills: () => '/api/v1/skills',
}

export type ApiCommand = CommandEnvelope<Record<string, unknown>>
export type ApiCommandResult = CommandResult
export type ApiEvent = EventEnvelope
export type ApiSnapshot = SessionSnapshot
