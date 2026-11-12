import type { TaskRecord } from './manager.js'

/** A browser/terminal-safe task projection. Provider credentials and worker secrets never cross the API. */
export type PublicTaskRecord = {
  id: string
  kind: 'shell' | 'agent'
  command?: string
  prompt?: string
  cwd: string
  started: number
  updated: number
  ended?: number
  status: TaskRecord['status']
  pid?: number
  exitCode?: number
  sessionId?: string
  childSessionId?: string
  parentSessionId?: string
  parentTaskId?: string
  specialistRole?: string
  delegationDepth?: number
  scopePaths: string[]
  background: boolean
  coordinated: boolean
  runCount: number
  pendingPromptCount: number
  result?: string
  error?: string
  usage?: TaskRecord['usage']
  activity?: TaskActivity
  outputBytes: number
  outputTruncated: boolean
}

export type TaskActivity = {
  kind: 'tool' | 'status' | 'turn' | 'output'
  label: string
  at: number
  callId?: string
  outcome?: 'success' | 'error' | 'running'
}


export type PublicTaskEvent = { seq: number; ts: number; type: string; data: Record<string, unknown> }

/**
 * Event history is an API surface too. Whitelist progress metadata instead of
 * forwarding the JSONL payload verbatim: legacy state events contain output
 * tails, and message/turn events can contain private prompt text.
 */
export function projectTaskEvent(event: { seq: number; ts: number; type: string; data: any }): PublicTaskEvent {
  const source = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as Record<string, any> : {}
  const activity = source.activity && typeof source.activity === 'object' ? source.activity as Record<string, any> : undefined
  const safeActivity = activity ? {
    ...(typeof activity.kind === 'string' ? { kind: activity.kind } : {}),
    ...(typeof activity.label === 'string' ? { label: activity.label.slice(0, 160) } : {}),
    ...(Number.isFinite(activity.at) ? { at: activity.at } : {}),
    ...(typeof activity.callId === 'string' ? { callId: activity.callId.slice(0, 128) } : {}),
    ...(typeof activity.outcome === 'string' ? { outcome: activity.outcome } : {}),
  } : undefined
  const pick = (...keys: string[]): Record<string, unknown> => {
    const data: Record<string, unknown> = {}
    for (const key of keys) {
      const value = source[key]
      if (value === undefined || value === null) continue
      if (typeof value === 'string') data[key] = value.slice(0, key === 'error' ? 240 : 500)
      else if (typeof value === 'number' || typeof value === 'boolean') data[key] = value
    }
    return data
  }
  let data: Record<string, unknown> = {}
  switch (event.type) {
    case 'state':
      data = { ...pick('kind', 'status', 'pid', 'exitCode', 'sessionId', 'childSessionId', 'parentSessionId', 'parentTaskId', 'specialistRole'), ...(safeActivity ? { activity: safeActivity } : {}) }
      break
    case 'agent.created':
      data = pick('specialistRole', 'parentSessionId', 'parentTaskId', 'delegationDepth')
      if (Array.isArray(source.scopePaths)) data.scopePaths = source.scopePaths.filter((item: unknown) => typeof item === 'string').slice(0, 32).map((item: string) => item.slice(0, 240))
      break
    case 'started':
      data = pick('pid')
      break
    case 'tool.started':
      data = { ...pick('name', 'callId'), ...(safeActivity ? { activity: safeActivity } : {}) }
      break
    case 'tool.completed':
      data = { ...pick('name', 'callId', 'outcome', 'outputLength'), ...(safeActivity ? { activity: safeActivity } : {}) }
      break
    case 'status':
    case 'turn.started':
      data = { ...pick('run', 'startedAt'), ...(safeActivity ? { activity: safeActivity } : {}) }
      break
    case 'turn.completed':
      data = { ...pick('run', 'durationMs', 'outputBytes'), ...(safeActivity ? { activity: safeActivity } : {}) }
      if (source.usage && typeof source.usage === 'object') {
        const usage = source.usage
        data.usage = {
          inputTokens: Math.max(0, Number(usage.inputTokens) || 0),
          outputTokens: Math.max(0, Number(usage.outputTokens) || 0),
          totalTokens: Math.max(0, Number(usage.totalTokens) || 0),
          estimated: Boolean(usage.estimated),
        }
      }
      break
    case 'output.progress':
      data = pick('outputBytes', 'final')
      break
    case 'continued':
      data = pick('previousRunMs')
      break
    case 'completed':
      data = pick('exitCode', 'sessionId', 'childSessionId')
      break
    case 'finished':
      data = pick('exitCode', 'termination', 'outputBytes', 'backgrounded', 'backgroundChildrenPreserved')
      break
    case 'cancelled':
      data = pick('signalled')
      break
    case 'parent_notified':
      data = pick('status')
      break
    case 'message_queued':
      data = { queued: true }
      break
    case 'resumed':
      data = { queued: true }
      break
    case 'failed':
      data = { failed: true }
      break
    default:
      // Unknown future/internal event types remain visible by name but never
      // expose arbitrary unreviewed payloads.
      data = {}
  }
  return { seq: event.seq, ts: event.ts, type: event.type, data }
}

export type SubagentNode = {
  task: PublicTaskRecord
  depth: number
  children: SubagentNode[]
}

export type SubagentWorkspace = {
  sessionId: string
  agents: SubagentNode[]
  counts: {
    total: number
    queued: number
    running: number
    completed: number
    failed: number
    cancelled: number
  }
}

export function projectTask(task: TaskRecord): PublicTaskRecord {
  return {
    id: task.id,
    kind: task.kind,
    ...(task.command ? { command: task.command } : {}),
    ...(task.prompt ? { prompt: task.prompt } : {}),
    cwd: task.cwd,
    started: task.started,
    updated: task.updated,
    ...(task.ended !== undefined ? { ended: task.ended } : {}),
    status: task.status,
    ...(task.pid !== undefined ? { pid: task.pid } : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.childSessionId ? { childSessionId: task.childSessionId } : {}),
    ...(task.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.specialistRole ? { specialistRole: task.specialistRole } : {}),
    ...(task.delegationDepth !== undefined ? { delegationDepth: task.delegationDepth } : {}),
    scopePaths: [...(task.scopePaths || [])],
    background: Boolean(task.background || task.backgrounded),
    coordinated: Boolean(task.coordinated),
    runCount: Number(task.runCount || 0),
    pendingPromptCount: task.pendingPrompts?.length || 0,
    ...(task.result ? { result: task.result.slice(-12_000) } : {}),
    ...(task.error ? { error: task.error.slice(0, 2_000) } : {}),
    ...(task.usage ? { usage: { ...task.usage } } : {}),
    ...(task.activity ? { activity: { kind: task.activity.kind, label: task.activity.label.slice(0, 160), at: task.activity.at, ...(task.activity.callId ? { callId: task.activity.callId.slice(0, 128) } : {}), ...(task.activity.outcome ? { outcome: task.activity.outcome } : {}) } } : {}),
    outputBytes: Math.max(Number(task.outputBytes || 0), Buffer.byteLength(task.output || '', 'utf8')),
    outputTruncated: Boolean(task.outputTruncated),
  }
}

/**
 * Project the existing TaskManager parentTaskId/parentSessionId graph into the
 * current session's agent tree. Old records without parentTaskId are attached
 * by their parent session; orphaned/cyclic records are never promoted into a
 * different user's root session.
 */
export function buildSubagentWorkspace(tasks: TaskRecord[], sessionId: string): SubagentWorkspace {
  const agents = tasks.filter((task) => task.kind === 'agent')
  const byId = new Map(agents.map((task) => [task.id, task]))
  const childSession = (task: TaskRecord) => task.childSessionId || (task.sessionId && task.sessionId !== task.parentSessionId ? task.sessionId : undefined)
  const isDirectChild = (task: TaskRecord) =>
    task.parentSessionId === sessionId && (!task.parentTaskId || !byId.has(task.parentTaskId))

  const childrenOf = (parent: TaskRecord) => {
    const session = childSession(parent)
    return agents.filter((candidate) => {
      if (candidate.id === parent.id) return false
      if (candidate.parentTaskId) return candidate.parentTaskId === parent.id
      return Boolean(session && candidate.parentSessionId === session)
    }).sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
  }

  const visited = new Set<string>()
  const flat: PublicTaskRecord[] = []
  const build = (task: TaskRecord, depth: number): SubagentNode | undefined => {
    if (visited.has(task.id)) return undefined
    visited.add(task.id)
    const projected = projectTask(task)
    flat.push(projected)
    const children = childrenOf(task).flatMap((child) => {
      const node = build(child, depth + 1)
      return node ? [node] : []
    })
    return { task: projected, depth, children }
  }

  const roots = agents.filter(isDirectChild).sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
  const tree = roots.flatMap((task) => {
    const node = build(task, 0)
    return node ? [node] : []
  })
  const count = (status: TaskRecord['status']) => flat.filter((task) => task.status === status).length
  return {
    sessionId,
    agents: tree,
    counts: {
      total: flat.length,
      queued: count('queued'),
      running: count('running'),
      completed: count('exited'),
      failed: count('failed'),
      cancelled: count('cancelled'),
    },
  }
}
