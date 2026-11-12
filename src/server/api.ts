import crypto from 'node:crypto'
import path from 'node:path'
import type { Runtime } from './runtime.js'
import { validateCommandEnvelope } from '../protocol/validation.js'
import type { ApiCommand, CommandResult, PromptResult } from '../protocol/api.js'
import type { PermissionResolution, QuestionResolution, InteractionRequestState } from '../protocol/types.js'
import { buildSubagentWorkspace, projectTask, projectTaskEvent } from '../tasks/subagents.js'
import { VERSION } from '../version.js'

export type ApiQuestionAsked = (request: Awaited<ReturnType<ReturnType<typeof createApi>['questions']>>[number]) => void | Promise<void>

export type ApiPromptOptions = {
  mode?: string
  autonomous?: boolean
  agent?: string
  signal?: AbortSignal
  onText?: (text: string) => void
  onReasoning?: (text: string) => void
  onTool?: (name: string, args: unknown, callId?: string) => void
  onToolResult?: (name: string, output: string, metadata?: unknown) => void
  onStatus?: (status: string) => void
  onQuestionAsked?: (request: unknown) => void | Promise<void>
}

function numberParam(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isSafeInteger(n) ? Math.max(0, n) : fallback
}

export function createApi(runtime: Runtime) {
  const workspaceRoot = path.resolve(runtime.cwd)
  const isWithinWorkspace = (target: string) => {
    const relative = path.relative(workspaceRoot, path.resolve(target))
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  }

  async function assertSessionScope(id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Session not found')
    let loaded
    try { loaded = await runtime.store.load(id) } catch { throw new Error('Session not found') }
    if (!loaded.meta?.cwd || path.resolve(loaded.meta.cwd) !== workspaceRoot) throw new Error('Session not found')
    return loaded
  }

  async function assertTaskScope(id: string) {
    const task = await runtime.tasks.get(id)
    if (!task || typeof task.cwd !== 'string' || !isWithinWorkspace(task.cwd)) throw new Error('Task not found')
    if (task.sessionId) await assertSessionScope(String(task.sessionId))
    if (task.parentSessionId) await assertSessionScope(String(task.parentSessionId))
    if (task.childSessionId) await assertSessionScope(String(task.childSessionId))
    return task
  }

  async function listWorkspaceTasks() {
    const candidates = (await runtime.tasks.list()).filter((task: any) => typeof task.cwd === 'string' && isWithinWorkspace(task.cwd))
    // Tasks often share parent/child sessions. Validate each distinct session
    // once instead of loading the same session for every task on every poll.
    const sessionIds = new Set<string>()
    for (const task of candidates) {
      for (const id of [task.sessionId, task.parentSessionId, task.childSessionId]) {
        if (typeof id === 'string' && id) sessionIds.add(id)
      }
    }
    const checks = await Promise.all([...sessionIds].map(async (id) => {
      try { await assertSessionScope(id); return [id, true] as const }
      catch { return [id, false] as const }
    }))
    const valid = new Set(checks.filter(([, ok]) => ok).map(([id]) => id))
    return candidates.filter((task: any) =>
      [task.sessionId, task.parentSessionId, task.childSessionId]
        .every((id: unknown) => typeof id !== 'string' || !id || valid.has(id)),
    )
  }
  const findQuestion = async (sessionId: string, questions: unknown[]) => {
    const pending: InteractionRequestState[] = await runtime.store.pendingInteractions(sessionId)
    // Compare the stable durable projection. The in-memory tool prompt also
    // carries presentation-only fields (header/custom/multiple) that are not
    // persisted by SessionStore.interactionStates().
    const normalized = JSON.stringify((Array.isArray(questions) ? questions : []).map((question: any, index: number) => ({
      id: String(question?.id || `q_${index + 1}`),
      question: String(question?.question || ''),
      ...(Array.isArray(question?.options) ? {
        options: question.options.map((option: any) => ({
          label: String(option?.label || ''),
          ...(option?.description === undefined ? {} : { description: String(option.description) }),
        })).filter((option: any) => option.label),
      } : {}),
      ...(question?.multiple !== undefined || question?.multi !== undefined
        ? { multi: Boolean(question?.multiple ?? question?.multi) }
        : {}),
    })))
    const match = pending
      .filter((item: InteractionRequestState) => item.kind === 'question')
      .reverse()
      .find((item: InteractionRequestState) => item.kind === 'question' && JSON.stringify(item.questions) === normalized)
    if (!match || match.kind !== 'question') throw new Error('Question request was not persisted before waiting for its answer')
    return match
  }

  const waitForQuestion = async (sessionId: string, questions: unknown[], signal?: AbortSignal, onAsked?: (request: unknown) => void | Promise<void>) => {
    const match = await findQuestion(sessionId, questions)
    await onAsked?.(match)
    const resolved = await runtime.store.waitForInteractionResolution(sessionId, match.requestId, signal)
    if (resolved.kind !== 'question') throw new Error(`Interaction ${match.requestId} changed kind unexpectedly`)
    return resolved.status === 'replied' ? (resolved.resolution?.answers ?? []) : []
  }

  async function executeCommand(command: ApiCommand): Promise<CommandResult> {
    const validated = validateCommandEnvelope(command) as ApiCommand
    const payload = validated.payload && typeof validated.payload === 'object' && !Array.isArray(validated.payload)
      ? validated.payload as Record<string, unknown>
      : {}

    if (validated.kind === 'task.cancel' || validated.kind === 'task.resume' || validated.kind === 'task.send') {
      await assertTaskScope(String(payload.taskId ?? ''))
    } else {
      await assertSessionScope(validated.sessionId)
    }

    const execution = await runtime.ledger.execute(validated, async () => {
      switch (validated.kind) {
        case 'session.queue': {
          const metadata = {
            ...(typeof payload.mode === 'string' ? { mode: payload.mode } : {}),
            ...(typeof payload.agent === 'string' ? { agent: payload.agent } : {}),
            ...(typeof payload.autonomous === 'boolean' ? { autonomous: payload.autonomous } : {}),
          }
          const result = await runtime.queue.enqueue(validated.sessionId, String(payload.prompt ?? ''), {
            sourceClient: validated.clientId,
            ...(Object.keys(metadata).length ? { metadata } : {}),
          })
          // Queue execution is kicked only after the command ledger commits its
          // receipt. Starting a worker inside this transaction would inherit
          // its async mutation context and race the receipt's durable sequence.
          return { result }
        }
        case 'session.queue.edit':
          return { result: await runtime.queue.edit(validated.sessionId, String(payload.queueId ?? ''), String(payload.prompt ?? '')) }
        case 'session.queue.cancel':
          return { result: await runtime.queue.cancel(validated.sessionId, String(payload.queueId ?? '')) }
        case 'session.queue.move': {
          const direction = Number(payload.direction) < 0 ? -1 : 1
          return { result: await runtime.queue.move(validated.sessionId, String(payload.queueId ?? ''), direction as -1 | 1) }
        }
        case 'session.interrupt':
        case 'session.abort': {
          const interrupted = runtime.interrupt(validated.sessionId)
          return { result: { sessionId: validated.sessionId, interrupted } }
        }
        case 'session.compact':
          return { result: await runtime.compactSession(validated.sessionId) }
        case 'session.undo':
          return { result: await runtime.store.undo(validated.sessionId, runtime.cwd) }
        case 'session.redo':
          return { result: await runtime.store.redo(validated.sessionId, runtime.cwd) }
        case 'session.fork':
          return { result: await runtime.store.fork(validated.sessionId, Number.isFinite(Number(payload.at)) ? Number(payload.at) : undefined) }
        case 'permission.resolve': {
          const resolution: PermissionResolution = {
            commandId: validated.commandId,
            clientId: validated.clientId,
            decision: payload.decision === 'always' ? 'always' : payload.decision === 'deny' ? 'deny' : 'once',
          }
          return { result: await runtime.store.resolvePermission(validated.sessionId, String(payload.requestId ?? ''), resolution) }
        }
        case 'question.answer':
        case 'question.reject':
        case 'question.cancel': {
          const disposition = validated.kind === 'question.answer' ? 'replied' : validated.kind === 'question.reject' ? 'rejected' : 'cancelled'
          const resolution: QuestionResolution = {
            commandId: validated.commandId,
            clientId: validated.clientId,
            disposition,
            answers: Array.isArray(payload.answers)
              ? payload.answers.map((item: unknown) => Array.isArray(item) ? item.map(String) : [String(item)])
              : disposition === 'replied' ? [] : undefined,
          }
          return { result: await runtime.store.resolveQuestion(validated.sessionId, String(payload.requestId ?? ''), resolution) }
        }
        case 'task.cancel':
          return { result: await runtime.tasks.cancel(String(payload.taskId ?? '')) }
        case 'task.resume':
          return { result: await runtime.tasks.resume(String(payload.taskId ?? ''), String(payload.prompt ?? '')) }
        case 'task.send':
          return { result: await runtime.tasks.queuePrompt(String(payload.taskId ?? ''), String(payload.prompt ?? '')) }
        default:
          throw new Error(`Command ${validated.kind} is not available through the HTTP API`)
      }
    })
    if (validated.kind === 'session.queue' && execution.receipt.status === 'accepted') {
      // Run after the ledger's AsyncLocalStorage transaction has closed, so
      // the queue worker acquires its own session mutation lease.
      queueMicrotask(() => { void runtime.kickQueue?.(validated.sessionId) })
    }
    return execution
  }

  const sessionHistory = async (id: string) => {
    const x = await assertSessionScope(id)
    return {
      meta: x.meta,
      messages: x.messages,
      sequence: await runtime.store.currentSequence(id),
      revision: await runtime.store.revision(id),
    }
  }

  return {
    health: () => ({ ok: true, name: 'termagent' as const, version: VERSION, node: process.version, platform: process.platform, arch: process.arch, ...(runtime.getDaemonInfo?.() ? { daemon: runtime.getDaemonInfo() } : {}) }),
    info: () => ({
      name: 'termagent' as const,
      version: VERSION,
      cwd: runtime.cwd,
      provider: runtime.getProvider().id,
      model: runtime.getProvider().model,
      features: ['sessions', 'history', 'events', 'streaming', 'permissions', 'questions', 'tasks', 'subagents', 'diff', 'context', 'runtime-status', 'client-sdk', 'commands'],
    }),
    status: async () => ({
      name: 'termagent' as const,
      version: VERSION,
      cwd: runtime.cwd,
      provider: runtime.getProvider().id,
      model: runtime.getProvider().model,
      mode: runtime.getMode(),
      runningSessions: (await runtime.tasks.list())
        .filter((task: any) => typeof task.cwd === 'string' && isWithinWorkspace(task.cwd))
        .filter((task: any) => task.kind === 'agent' && (task.status === 'queued' || task.status === 'running'))
        .map((task: any) => String(task.sessionId ?? ''))
        .filter(Boolean),
    }),
    commands: () => ({
      commands: ['session.queue', 'session.queue.edit', 'session.queue.cancel', 'session.queue.move', 'session.interrupt', 'session.abort', 'session.compact', 'session.undo', 'session.redo', 'session.fork', 'permission.resolve', 'question.answer', 'question.reject', 'question.cancel', 'task.cancel', 'task.resume', 'task.send'],
    }),
    listSessions: async () => (await runtime.store.list()).filter((item: { cwd?: string }) => item.cwd && path.resolve(item.cwd) === workspaceRoot),
    assertSession: assertSessionScope,
    createSession: async (cwd?: string, model?: string) => {
      if (cwd && path.resolve(cwd) !== path.resolve(runtime.cwd)) throw new Error(`Server is scoped to ${runtime.cwd}; start another server for a different project`)
      return await runtime.store.create(runtime.cwd, String(model || runtime.getProvider().model || ''))
    },
    getSession: sessionHistory,
    history: sessionHistory,
    messages: async (id: string, after = 0, limit?: number, tail = false) => {
      const x = await assertSessionScope(id)
      const total = x.messages.length
      const bounded = limit === undefined ? undefined : Math.max(1, Math.min(500, Number.isSafeInteger(limit) ? limit : 100))
      const offset = tail && bounded !== undefined ? Math.max(0, total - bounded) : numberParam(after)
      const end = bounded === undefined ? total : offset + bounded
      return { messages: x.messages.slice(offset, end), offset, total }
    },
    events: async (id: string, after = 0) => { await assertSessionScope(id); return runtime.store.durableEvents(id, numberParam(after), 100) },
    currentSequence: async (id: string) => { await assertSessionScope(id); return runtime.store.currentSequence(id) },
    statusForSession: async (id: string) => {
      const x = await assertSessionScope(id)
      return {
        sessionId: id,
        running: runtime.isRunning(id),
        messageCount: x.messages.length,
        updated: x.meta?.updated,
        sequence: await runtime.store.currentSequence(id),
        revision: await runtime.store.revision(id),
      }
    },
    diff: async (id: string, staged = false) => {
      await assertSessionScope(id)
      return await (await import('../diff/render.js')).renderGitDiff(runtime.cwd, { staged, color: false, maxBytes: runtime.cfg.maxOutputBytes })
    },
    context: async (id: string) => {
      await assertSessionScope(id)
      return runtime.contextSnapshot(id)
    },
    snapshot: async (id: string) => {
      const x = await assertSessionScope(id)
      return {
        version: 1 as const,
        sessionId: id,
        sequence: await runtime.store.currentSequence(id),
        revision: await runtime.store.revision(id),
        capturedAt: Date.now(),
        state: {
          meta: x.meta,
          messages: x.messages,
          pendingInteractions: await runtime.store.pendingInteractions(id),
          context: await runtime.contextSnapshot(id),
        },
      }
    },
    permissions: async (id: string) => { await assertSessionScope(id); return (await runtime.store.pendingInteractions(id) as InteractionRequestState[]).filter((item: InteractionRequestState) => item.kind === 'permission') },
    questions: async (id: string) => { await assertSessionScope(id); return (await runtime.store.pendingInteractions(id)).filter((item: InteractionRequestState) => item.kind === 'question') },
    todo: async (id: string) => { await assertSessionScope(id); return runtime.store.getTodo(id) },
    queue: async (id: string, activeOnly = true) => { await assertSessionScope(id); return runtime.queue.list(id, activeOnly) },
    checkpoints: async (id: string) => { await assertSessionScope(id); return runtime.store.listCheckpoints(id) },
    checkpoint: async (id: string, label = 'api') => {
      const x = await assertSessionScope(id)
      return runtime.store.checkpoint(id, x.messages, { label })
    },
    restoreCheckpoint: async (id: string, checkpointId: string) => { await assertSessionScope(id); return runtime.store.restoreCheckpoint(id, checkpointId) },
    branchCheckpoint: async (id: string, checkpointId: string, restoreWorkspace = false) => { await assertSessionScope(id); return runtime.store.forkFromCheckpoint(id, checkpointId, { restoreWorkspace }) },
    tasks: async () => (await runtime.tasks.list())
      .filter((task: any) => typeof task.cwd === 'string' && isWithinWorkspace(task.cwd))
      .map(projectTask),
    subagents: async (id: string) => {
      await assertSessionScope(id)
      return buildSubagentWorkspace(await listWorkspaceTasks(), id)
    },
    task: async (id: string) => projectTask(await assertTaskScope(id)),
    taskEvents: async (id: string, limit?: number, after?: number) => {
      await assertTaskScope(id)
      const events = await runtime.tasks.history(id)
      const bounded = limit === undefined ? undefined : Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100
      const selected = after !== undefined
        ? events.filter((event: { seq: number }) => event.seq > numberParam(after)).slice(0, bounded ?? 100)
        : bounded === undefined ? events : events.slice(-bounded)
      return selected.map(projectTaskEvent)
    },
    taskOutput: async (id: string, maxBytes = 20_000, tail = true) => { await assertTaskScope(id); return runtime.tasks.readOutput(id, maxBytes, tail) },
    agents: () => ({ builtin: ['build', 'plan', 'explore'], custom: runtime.customAgents.map((agent: any) => ({ name: String(agent.name || ''), description: String(agent.description || ''), ...(typeof agent.readOnly === 'boolean' ? { readOnly: agent.readOnly } : {}) })) }),
    skills: () => ({ skills: runtime.skills.map((s: any) => ({ name: s.name, description: s.description })) }),
    tools: () => ({ tools: runtime.registry.list().map((t: any) => ({ name: t.name, description: t.description, risk: t.risk, schema: t.schema })) }),
    models: () => {
      const profiles = Object.entries(runtime.cfg.providers || {}).map(([name, p]: any) => ({
        name,
        provider: p.provider,
        model: p.model,
        baseUrl: (() => { try { return new URL(String(p.baseUrl)).origin } catch { return 'custom endpoint' } })(),
        variants: Object.keys(p.variants || {}).map((v: string) => ({
          name: v,
          ...(p.variants[v]?.reasoningEffort ? { reasoningEffort: p.variants[v].reasoningEffort } : {}),
          ...(Number.isFinite(p.variants[v]?.temperature) ? { temperature: p.variants[v].temperature } : {}),
          ...(Number.isFinite(p.variants[v]?.maxTokens) ? { maxTokens: p.variants[v].maxTokens } : {}),
        })),
      }))
      return {
        active: { provider: runtime.getProvider().id, model: runtime.getProvider().model },
        profiles,
        // Project configuration is not a browser API. Project only the known
        // routing selectors and smart-routing knobs; never serialize arbitrary
        // config objects where a future field could carry a credential or prompt.
        routing: Object.fromEntries(
          ['default', 'planning', 'building', 'verification', 'subagent']
            .flatMap((key) => {
              const value = (runtime.cfg.routing as Record<string, unknown> | undefined)?.[key]
              return typeof value === 'string' && value.length <= 128 ? [[key, value]] : []
            }),
        ),
        smartRouting: {
          enabled: Boolean(runtime.cfg.smartRouting?.enabled),
          ...(typeof runtime.cfg.smartRouting?.simpleModel === 'string' ? { simpleModel: runtime.cfg.smartRouting.simpleModel.slice(0, 128) } : {}),
          ...(typeof runtime.cfg.smartRouting?.strongModel === 'string' ? { strongModel: runtime.cfg.smartRouting.strongModel.slice(0, 128) } : {}),
        },
      }
    },
    prompt: async (id: string, prompt: string, options: ApiPromptOptions = {}): Promise<PromptResult> => {
      const x = await assertSessionScope(id)
      const result = await runtime.runPrompt(id, x.messages, prompt, {
        mode: options.mode,
        autonomous: options.autonomous,
        customAgent: typeof options.agent === 'string' ? runtime.customAgents.find((item: any) => item.name === options.agent) : undefined,
        signal: options.signal,
        onText: options.onText,
        onReasoning: options.onReasoning,
        onTool: options.onTool,
        onToolResult: options.onToolResult,
        onStatus: options.onStatus,
        onQuestion: (questions: unknown[], signal?: AbortSignal) => waitForQuestion(id, questions, signal, options.onQuestionAsked),
      })
      return { sessionId: id, text: result }
    },
    findQuestion,
    executeCommand,
    newConnectionId: () => `conn_${crypto.randomBytes(8).toString('hex')}`,
  }
}

