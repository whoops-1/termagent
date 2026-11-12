import process from 'node:process'
import path from 'node:path'
import readline from 'node:readline/promises'
import { loadConfig } from '../config/config.js'
import { TermAgentClient, TermAgentError } from '../client/client.js'
import type { ChatMessage, QueuedPrompt, ServerInfo, SessionMeta, SessionSnapshot, TaskRecord, TaskEvent, SubagentNode } from '../protocol/api.js'
import type { EventEnvelope, InteractionRequestState, PermissionRequestState, QuestionRequestState } from '../protocol/types.js'
import { loadThemeCatalog } from '../design-system/theme.js'
import { loadTerminalDeviceCredential, removeTerminalDeviceCredential, saveTerminalDeviceCredential } from './daemon-credentials.js'
import { banner } from './renderer.js'
import { PromptEditor, defaultCompletionItems } from './input.js'
import { TerminalUI } from './ui.js'
import type { DiffResult } from '../diff/render.js'
import { readDaemonOwner, type DaemonOwnerPublicInfo } from '../server/daemon-owner.js'
import type { QuestionPrompt } from '../tools/types.js'

function isLoopbackUrl(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.')
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function durableEnvelope(value: unknown): EventEnvelope | undefined {
  if (!value || typeof value !== 'object') return undefined
  const event = value as Partial<EventEnvelope>
  return typeof event.kind === 'string' && event.payload !== undefined ? event as EventEnvelope : undefined
}

function sessionBasename(cwd: string): string {
  return path.basename(cwd) || cwd
}

function writePairingNotice(): void {
  process.stderr.write('Terminal paired successfully. Its scoped device credential is stored locally with owner-only permissions.\n')
}

export async function startDaemonClient(cwd: string, resume: string | undefined, owner: DaemonOwnerPublicInfo): Promise<void> {
  if (owner.mode !== 'server' || owner.state !== 'ready' || !owner.endpoint) {
    throw new Error('A TermAgent server owns this workspace but is not ready. Wait for its Web View endpoint, then reconnect.')
  }
  if (!isLoopbackUrl(owner.endpoint)) {
    throw new Error('The workspace server is exposed through a non-loopback URL. Terminal auto-attachment is disabled for remote endpoints; connect explicitly with the configured secure device credentials.')
  }

  const staticToken = process.env.TERMAGENT_SERVER_TOKEN
  const savedCredential = staticToken ? undefined : await loadTerminalDeviceCredential(owner.workspaceId)
  let client = new TermAgentClient({
    baseUrl: owner.endpoint,
    token: staticToken || savedCredential?.token,
    clientId: savedCredential?.deviceId,
  })
  let info: ServerInfo
  const verifyDaemon = async (candidate: TermAgentClient) => {
    const serverInfo = await candidate.info()
    const health = await candidate.health()
    const daemon = health && typeof health === 'object' ? (health as Record<string, any>).daemon : undefined
    if (!daemon || daemon.mode !== 'server' || daemon.state !== 'ready' || daemon.id !== owner.id || daemon.pid !== owner.pid) {
      throw new Error('The server endpoint did not confirm the registered daemon identity.')
    }
    return serverInfo
  }
  try {
    info = await verifyDaemon(client)
  } catch (error) {
    if (!(error instanceof TermAgentError && error.status === 401)) {
      throw new Error(`Could not attach to the existing TermAgent daemon at ${owner.endpoint}: ${messageOf(error)}`)
    }
    if (staticToken) throw new Error('The running TermAgent server rejected TERMAGENT_SERVER_TOKEN.')
    if (savedCredential) await removeTerminalDeviceCredential(owner.workspaceId)
    let pairingCode = process.env.TERMAGENT_PAIRING_CODE?.trim()
    if (!pairingCode) {
      if (!process.stdin.isTTY) {
        throw new Error('This daemon requires device pairing. Start an interactive terminal or set TERMAGENT_PAIRING_CODE for a one-time pairing attempt.')
      }
      const prompt = readline.createInterface({ input: process.stdin, output: process.stderr })
      try { pairingCode = (await prompt.question('Enter the one-time pairing code printed by the TermAgent server: ')).trim() }
      finally { prompt.close() }
    }
    if (!/^[A-Fa-f0-9]{10}$/.test(pairingCode)) throw new Error('Pairing code must contain exactly 10 hexadecimal characters.')
    const unauthenticated = new TermAgentClient({ baseUrl: owner.endpoint })
    const paired = await unauthenticated.pair(pairingCode, `TermAgent Terminal · ${process.platform}`)
    const device = paired.device as Record<string, unknown>
    if (typeof device.id !== 'string' || typeof device.expiresAt !== 'number') throw new Error('The pairing server returned an invalid device record.')
    await saveTerminalDeviceCredential({
      version: 1,
      workspaceId: owner.workspaceId,
      deviceId: device.id,
      token: paired.token,
      expiresAt: device.expiresAt,
    })
    client = new TermAgentClient({ baseUrl: owner.endpoint, token: paired.token, clientId: device.id })
    try { info = await verifyDaemon(client) }
    catch (pairError) {
      await removeTerminalDeviceCredential(owner.workspaceId).catch(() => undefined)
      throw pairError
    }
    writePairingNotice()
  }

  const expectedCwd = await canonicalPath(cwd)
  const actualCwd = await canonicalPath(info.cwd)
  if (expectedCwd !== actualCwd) {
    throw new Error(`The registered daemon workspace does not match this terminal directory. Expected ${expectedCwd}; server reports ${info.cwd}.`)
  }

  const cfg = await loadConfig(cwd)
  const themes = await loadThemeCatalog(cwd)
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const commands = ['help', 'status', 'sessions', 'resume', 'new', 'plan', 'build', 'explore', 'mode', 'agent', 'queue', 'interrupt', 'cancel', 'abort', 'compact', 'undo', 'redo', 'fork', 'diff', 'tasks', 'subagents', 'subagent-send', 'subagent-resume', 'task-log', 'task-output', 'checkpoint', 'checkpoints', 'restore', 'branch', 'permissions', 'questions', 'device', 'quit', 'exit']
  let editor!: PromptEditor
  let ui: TerminalUI | null = null
  let session: SessionMeta
  let snapshot: SessionSnapshot
  let mode = 'build'
  let selectedAgent: string | undefined
  let editingQueuedId: string | undefined
  let streamAbort: AbortController | undefined
  let turnController: AbortController | undefined
  let turnId: string | undefined
  let streamedAssistant = ''
  let streamedReasoning = ''
  let closed = false
  let interactionTail: Promise<void> = Promise.resolve()
  const interactionControllers = new Map<string, AbortController>()
  const interactionQueued = new Set<string>()
  const interactionFinished = new Set<string>()
  const write = (text: string) => {
    if (ui) ui.system(text)
    else console.log(text)
  }
  const warn = (text: string) => {
    if (ui) ui.system(text, 'warn')
    else console.warn(text)
  }
  const showError = (error: unknown) => {
    if (ui) ui.system(messageOf(error), 'error')
    else console.error(messageOf(error))
  }

  const sessions = await client.listSessions()
  const available = sessions.sessions.filter(item => path.resolve(item.cwd) === expectedCwd)
  if (resume) {
    const found = available.find(item => item.id === resume)
    if (!found) throw new Error(`Session ${resume} was not found in the attached workspace.`)
    session = found
  } else {
    const latest = [...available].sort((a, b) => b.updated - a.updated)[0]
    session = latest || await client.createSession(cwd, info.model)
  }
  snapshot = await client.getSnapshot(session.id)

  if (interactive) {
    ui = new TerminalUI({
      title: sessionBasename(cwd),
      model: session.model || info.model,
      provider: info.provider,
      mode,
      cwd,
      theme: cfg.ui?.theme,
      themes,
      bannerStyle: cfg.ui?.bannerStyle,
      effect: cfg.ui?.effect,
      animations: cfg.ui?.animations !== false,
      motion: cfg.ui?.motion ?? (cfg.ui?.animations === false ? 'off' : 'full'),
      onMouseTarget: async target => {
        if (!target.startsWith('picker:')) return
        const index = Number(target.slice('picker:'.length))
        if (!Number.isInteger(index) || index < 0) return
        const result = await editor.clickCompletion(index)
        if (result?.type === 'submit') await dispatchInput(result.value)
      },
      onQueueAction: async (action, id) => {
        try {
          if (action === 'edit') {
            const item = (await client.getQueue(session.id, false)).find(value => value.id === id)
            if (!item) return warn(`Queue item ${id} is no longer available.`)
            editingQueuedId = id
            editor.setValue(item.content)
            write(`Editing queued prompt ${id}. Submit the edited text to save it.`)
            return
          }
          if (action === 'cancel') await client.cancelQueue(session.id, id)
          else if (action === 'up') await client.moveQueue(session.id, id, -1)
          else if (action === 'down') await client.moveQueue(session.id, id, 1)
          await syncQueue()
        } catch (error) { showError(error) }
      },
    })
    ui.hydrate(snapshot.state.messages)
    ui.enter()
  } else {
    banner(`${info.provider}:${info.model}`, cwd)
    write(`Attached to the existing TermAgent daemon · ${owner.endpoint}`)
  }

  const syncSnapshot = async (rehydrate = false) => {
    snapshot = await client.getSnapshot(session.id)
    if (rehydrate) ui?.hydrate(snapshot.state.messages)
    const context = snapshot.state.context && typeof snapshot.state.context === 'object'
      ? snapshot.state.context as Record<string, unknown>
      : {}
    ui?.setContextUsage(Number(context.tokens || 0), Number(context.limit || cfg.maxContextTokens || 128000))
    const todo = await client.getTodo(session.id).catch(() => [])
    ui?.setTodos(todo as any[])
    await syncQueue()
    return snapshot
  }

  const syncQueue = async () => {
    const items = await client.getQueue(session.id, true)
    ui?.setQueue(items)
    return items
  }

  const endTurn = () => {
    turnController = undefined
    turnId = undefined
    ui?.endAgentTurn()
  }

  const startTurn = (id?: string) => {
    if (turnController) {
      if (!turnId && id) turnId = id
      return
    }
    turnId = id
    streamedAssistant = ''
    streamedReasoning = ''
    turnController = new AbortController()
    const controller = turnController
    controller.signal.addEventListener('abort', () => {
      void client.interrupt(session.id).catch(error => showError(error))
    }, { once: true })
    ui?.startAssistant()
    ui?.beginAgentTurn(controller)
  }

  const pendingInteraction = async (requestId: string): Promise<InteractionRequestState | undefined> => {
    const [permissions, questions] = await Promise.all([
      client.listPermissions(session.id),
      client.listQuestions(session.id),
    ])
    return [...permissions, ...questions].find(item => item.requestId === requestId && item.status === 'pending')
  }

  const finishInteraction = (requestId: string) => {
    interactionFinished.add(requestId)
    interactionControllers.get(requestId)?.abort(new Error('Interaction resolved by another client'))
    interactionControllers.delete(requestId)
  }

  const handleInteraction = async (state: InteractionRequestState) => {
    // A non-TTY terminal is a passive event client. It must never deny or cancel
    // a browser-owned interaction merely because it cannot render the modal.
    if (!ui || closed || state.sessionId !== session.id || state.status !== 'pending' || interactionFinished.has(state.requestId)) return
    const current = await pendingInteraction(state.requestId)
    if (!current) { finishInteraction(state.requestId); return }
    if (interactionControllers.has(state.requestId)) return
    const controller = new AbortController()
    interactionControllers.set(state.requestId, controller)
    let settled = false
    try {
      if (current.kind === 'permission') {
        const permission = current as PermissionRequestState
        const choice = await ui.requestRemotePermission({
          requestId: permission.requestId,
          sessionId: permission.sessionId,
          tool: permission.tool,
          action: permission.action,
          resources: permission.resources,
          signal: controller.signal,
        })
        if (controller.signal.aborted || closed) return
        const stillPending = await pendingInteraction(permission.requestId)
        if (!stillPending) { settled = true; finishInteraction(permission.requestId); return }
        const result = await client.resolvePermission(session.id, permission.requestId, choice)
        settled = result.receipt.status === 'accepted' || result.receipt.status === 'duplicate'
      } else {
        const question = current as QuestionRequestState
        const response = await ui.requestQuestion(question.questions as QuestionPrompt[], controller.signal)
        if (controller.signal.aborted || closed) return
        const stillPending = await pendingInteraction(question.requestId)
        if (!stillPending) { settled = true; finishInteraction(question.requestId); return }
        const result = response.status === 'replied'
          ? await client.answerQuestion(session.id, question.requestId, response.answers)
          : response.status === 'rejected'
            ? await client.rejectQuestion(session.id, question.requestId)
            : await client.cancelQuestion(session.id, question.requestId)
        settled = result.receipt.status === 'accepted' || result.receipt.status === 'duplicate'
      }
    } catch (error) {
      if (!controller.signal.aborted && !closed) {
        showError(error)
        // A request may have reached the daemon even when its response was lost.
        // Only retire it after checking the durable pending-interaction state.
        try { settled = !(await pendingInteraction(state.requestId)) }
        catch { settled = false }
      }
    } finally {
      if (interactionControllers.get(state.requestId) === controller) interactionControllers.delete(state.requestId)
      if (settled || controller.signal.aborted || closed) interactionFinished.add(state.requestId)
      else {
        interactionFinished.delete(state.requestId)
        if (ui && !closed) setTimeout(() => { void syncInteractions().catch(showError) }, 900)
      }
    }
  }

  const enqueueInteraction = (state: InteractionRequestState) => {
    if (!ui || interactionQueued.has(state.requestId) || interactionFinished.has(state.requestId)) return
    interactionQueued.add(state.requestId)
    interactionTail = interactionTail.then(() => handleInteraction(state)).catch(showError).finally(() => interactionQueued.delete(state.requestId))
  }

  const syncInteractions = async () => {
    const [permissions, questions] = await Promise.all([
      client.listPermissions(session.id),
      client.listQuestions(session.id),
    ])
    for (const item of [...permissions, ...questions]) {
      if (item.status === 'pending') enqueueInteraction(item)
      else finishInteraction(item.requestId)
    }
  }

  const syncFromSnapshot = async () => {
    const next = await syncSnapshot(true)
    write('Event stream gap detected. The durable session snapshot has been reconciled.')
    await syncInteractions()
    return next
  }

  const handleEnvelope = async (event: EventEnvelope) => {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, any> : {}
    switch (event.kind) {
      case 'session.message.user': {
        const message = payload.message && typeof payload.message === 'object' ? payload.message as ChatMessage : payload as unknown as ChatMessage
        if (typeof message.content === 'string') {
          ui?.addUser(message.content)
          if (!ui) process.stdout.write(`\nYou: ${message.content}\n`)
        }
        break
      }
      case 'session.message.assistant': {
        const message = payload.message && typeof payload.message === 'object' ? payload.message as ChatMessage : payload as unknown as ChatMessage
        if (typeof message.content === 'string' && (message.content !== streamedAssistant || (typeof message.reasoning === 'string' && message.reasoning !== streamedReasoning))) {
          // Live deltas are intentionally transient. The durable assistant
          // message repairs any text lost during a terminal disconnect.
          ui?.reconcileAssistantMessage(message.content, typeof message.reasoning === 'string' ? message.reasoning : undefined)
          if (!ui) {
            if (message.content.startsWith(streamedAssistant)) process.stdout.write(`${message.content.slice(streamedAssistant.length)}\n`)
            else process.stdout.write(`\n[Recovered final response from durable session history]\n${message.content}\n`)
          }
        }
        break
      }
      case 'session.message.tool': {
        const message = payload.message && typeof payload.message === 'object' ? payload.message as ChatMessage : payload as unknown as ChatMessage
        if (message.role === 'tool') {
          const name = typeof message.name === 'string' ? message.name : 'tool'
          const output = typeof message.content === 'string' ? message.content : ''
          ui?.endTool(name, output, undefined, message.tool_call_id)
        }
        break
      }
      case 'session.tool.called':
      case 'session.tool.started':
      case 'session.tool.progress':
      case 'session.tool.completed':
      case 'session.tool.failed':
        ui?.updateToolLifecycle(payload)
        break
      case 'session.turn.started':
        startTurn(typeof payload.id === 'string' ? payload.id : undefined)
        break
      case 'session.turn.completed':
      case 'session.turn.failed':
      case 'session.turn.interrupted':
        endTurn()
        void syncSnapshot(false).catch(() => undefined)
        break
      case 'session.permission.asked':
      case 'session.question.asked':
        await syncInteractions()
        break
      case 'session.permission.resolved':
      case 'session.question.resolved':
        if (typeof payload.requestId === 'string') finishInteraction(payload.requestId)
        break
      case 'session.todo.updated':
        if (Array.isArray(payload.items)) ui?.setTodos(payload.items)
        else void client.getTodo(session.id).then(items => ui?.setTodos(items as any[])).catch(() => undefined)
        break
      case 'session.task.created':
      case 'session.task.updated':
        if (typeof payload.taskId === 'string' || typeof payload.id === 'string') {
          const id = String(payload.taskId || payload.id)
          void client.getTask(id).then(task => ui?.system(`Task ${task.id.slice(0, 10)} · ${task.status} · ${task.command || task.prompt || task.kind}`)).catch(() => undefined)
        }
        break
      case 'session.task.notification':
        if (typeof payload.summary === 'string' || typeof payload.status === 'string') {
          const state = String(payload.status || 'updated')
          write(`Task ${String(payload.taskId || '').slice(0, 10)} ${state}: ${String(payload.summary || payload.error || '').slice(0, 220)}`)
        }
        break
      case 'session.workflow.updated': {
        const summary = typeof payload.summary === 'string' ? payload.summary : typeof payload.phase === 'string' ? payload.phase : typeof payload.status === 'string' ? payload.status : 'Workflow updated'
        ui?.setStatus(`workflow · ${summary}`)
        break
      }
      case 'session.verification.completed':
        write(`Verification ${payload.ok === false || payload.status === 'failed' ? 'failed' : 'completed'}${typeof payload.exitCode === 'number' ? ` · exit ${payload.exitCode}` : ''}${typeof payload.error === 'string' ? ` · ${payload.error}` : ''}`)
        break
      case 'session.mutation.applied': {
        const files = Array.isArray(payload.files) ? payload.files.filter((value: unknown) => typeof value === 'string') : typeof payload.path === 'string' ? [payload.path] : []
        if (files.length) write(`Workspace changes applied · ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` +${files.length - 5} more` : ''}`)
        break
      }
      case 'session.diff.updated':
        ui?.setStatus('working tree diff updated')
        break
      case 'session.provider.updated':
        if (typeof payload.state === 'string') ui?.setStatus(`provider · ${payload.state}${typeof payload.round === 'number' ? ` · round ${payload.round}` : ''}`)
        break
      case 'session.context.checkpoint':
        void syncSnapshot(false).catch(() => undefined)
        break
      case 'session.checkpoint.created':
        write(`Checkpoint created · ${String(payload.id || '').slice(0, 10)}${payload.label ? ` · ${String(payload.label)}` : ''}`)
        break
      case 'session.checkpoint.restored':
        write(`Checkpoint restored · ${String(payload.checkpointId || '').slice(0, 10)}`)
        void syncSnapshot(true).catch(() => undefined)
        break
      case 'session.compaction.started':
        ui?.setStatus('compacting context…')
        break
      case 'session.compaction.completed':
        write('Context compaction completed.')
        void syncSnapshot(true).catch(() => undefined)
        break
      case 'session.queue.updated':
        void syncQueue().catch(() => undefined)
        break
      case 'session.history.undo':
      case 'session.history.redo':
        void syncSnapshot(true).catch(() => undefined)
        break
    }
  }

  const handleLive = (event: EventEnvelope) => {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, any> : {}
    switch (event.kind) {
      case 'session.text.delta':
        if (typeof payload.delta === 'string') {
          streamedAssistant += payload.delta
          ui?.appendAssistant(payload.delta)
          if (!ui) process.stdout.write(payload.delta)
        }
        break
      case 'session.reasoning.delta':
        if (typeof payload.delta === 'string') { streamedReasoning += payload.delta; ui?.appendReasoning(payload.delta) }
        break
      case 'runtime.activity.changed':
        if (payload.state === 'tool' && payload.phase === 'started' && typeof payload.name === 'string') ui?.startTool(payload.name, payload.args, typeof payload.callId === 'string' ? payload.callId : undefined)
        else if (payload.state === 'working') ui?.setStatus(String(payload.message || 'working'))
        break
      case 'session.tool.output.delta':
        if (typeof payload.name === 'string') ui?.endTool(payload.name, String(payload.output || ''), payload.metadata, typeof payload.callId === 'string' ? payload.callId : undefined)
        break
      case 'runtime.status.changed':
        if (payload.state === 'working' && payload.phase === 'started') startTurn()
        else if (payload.state === 'idle' && payload.phase && payload.phase !== 'completed') {
          // The durable turn event below remains authoritative for lifecycle closure.
          ui?.setStatus(String(payload.phase))
        }
        break
    }
  }

  const startEventPump = (sessionId: string, initialCursor: number) => {
    streamAbort?.abort()
    const controller = new AbortController()
    streamAbort = controller
    void (async () => {
      let cursor = initialCursor
      while (!closed && !controller.signal.aborted && session.id === sessionId) {
        let resnapshot = false
        try {
          for await (const frame of client.streamEvents(sessionId, cursor, { signal: controller.signal, reconnect: true })) {
            if (controller.signal.aborted || closed || session.id !== sessionId) break
            if (frame.event === 'event') {
              const event = durableEnvelope(frame.data)
              if (!event) continue
              if (event.durable && typeof event.sequence === 'number') cursor = event.sequence
              await handleEnvelope(event)
            } else if (frame.event === 'live') {
              const event = durableEnvelope(frame.data)
              if (event) handleLive(event)
            } else if (frame.event === 'gap') {
              const data = frame.data && typeof frame.data === 'object' ? frame.data as Record<string, unknown> : {}
              if (data.snapshotRequired === true) {
                const next = await syncFromSnapshot()
                cursor = next.sequence
                resnapshot = true
                break
              }
            } else if (frame.event === 'error') {
              const data = frame.data && typeof frame.data === 'object' ? frame.data as Record<string, unknown> : {}
              throw new Error(String(data.message || data.code || 'Event stream failed'))
            }
          }
        } catch (error) {
          if (controller.signal.aborted || closed) break
          if (error instanceof TermAgentError && error.status < 500) {
            showError(error)
            break
          }
          warn(`Event stream reconnecting: ${messageOf(error)}`)
          await new Promise(resolve => setTimeout(resolve, 750))
        }
        if (resnapshot) continue
        if (!controller.signal.aborted && !closed && session.id === sessionId) await new Promise(resolve => setTimeout(resolve, 250))
      }
    })().catch(showError)
  }

  const activateSession = async (nextSession: SessionMeta) => {
    streamAbort?.abort()
    endTurn()
    session = nextSession
    interactionControllers.forEach(controller => controller.abort(new Error('Session changed')))
    interactionControllers.clear()
    interactionQueued.clear()
    interactionFinished.clear()
    snapshot = await client.getSnapshot(session.id)
    ui?.clearConversation()
    ui?.hydrate(snapshot.state.messages)
    ui?.setTitle(sessionBasename(cwd))
    await syncSnapshot(false)
    const status = await client.getSessionStatus(session.id)
    if (status.running) startTurn()
    await syncInteractions()
    startEventPump(session.id, snapshot.sequence)
    write(`Switched to session ${session.id}`)
  }

  const setMode = (next: string) => {
    if (!['build', 'plan', 'explore'].includes(next)) throw new Error(`Unknown mode: ${next}`)
    mode = next
    ui?.setMode(mode)
    write(`Agent mode: ${mode}`)
  }

  const queueList = async () => {
    const items = await client.getQueue(session.id, false)
    if (!items.length) { write('Queue is empty.'); return }
    for (const item of items) write(`${item.position}. ${item.status} · ${item.id.slice(0, 10)} · ${item.content.replace(/\s+/g, ' ').slice(0, 140)}`)
  }

  const resolveTask = async (reference: string): Promise<TaskRecord> => {
    const { tasks } = await client.listTasks()
    const exact = tasks.find(task => task.id === reference)
    if (exact) return exact
    const matches = tasks.filter(task => task.id.startsWith(reference))
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) throw new Error(`Task reference ${reference} is ambiguous (${matches.length} matches).`)
    throw new Error(`Task ${reference} was not found in this workspace.`)
  }

  const taskList = async () => {
    const { tasks } = await client.listTasks()
    if (!tasks.length) { write('No workspace tasks.'); return }
    for (const task of tasks.sort((a, b) => b.updated - a.updated)) {
      const description = (task.command || task.prompt || task.result || task.error || task.kind || '').replace(/\s+/g, ' ').slice(0, 110)
      write(`${task.status.padEnd(9)} · ${task.id.slice(0, 12)} · ${task.kind} · ${description}`)
    }
  }

  const resolveSubagent = async (reference: string): Promise<TaskRecord> => {
    const workspace = await client.listSubagents(session.id)
    const rows: TaskRecord[] = []
    const visit = (node: SubagentNode) => { rows.push(node.task); node.children.forEach(visit) }
    workspace.agents.forEach(visit)
    const exact = rows.find(task => task.id === reference)
    if (exact) return exact
    const matches = rows.filter(task => task.id.startsWith(reference))
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) throw new Error(`Subagent reference ${reference} is ambiguous (${matches.length} matches).`)
    throw new Error(`Subagent ${reference} is not attached to the active session.`)
  }

  const subagentList = async () => {
    const workspace = await client.listSubagents(session.id)
    const { counts } = workspace
    write(`Subagents · ${counts.total} total · ${counts.running} running · ${counts.queued} queued · ${counts.completed} completed · ${counts.failed + counts.cancelled} stopped`)
    if (!workspace.agents.length) { write('No subagents are attached to this session.'); return }
    const render = (node: SubagentNode) => {
      const task = node.task
      const role = task.specialistRole || 'general'
      const elapsed = Math.max(0, Math.floor(((task.ended || Date.now()) - task.started) / 1000))
      const scope = task.scopePaths.length ? task.scopePaths.join(', ') : '(workspace)'
      const activity = task.activity?.label ? ` · ${task.activity.label}` : ''
      write(`${'  '.repeat(node.depth)}${task.status.padEnd(9)} · ${role} · ${task.id.slice(0, 12)} · ${elapsed}s${activity}`)
      write(`${'  '.repeat(node.depth + 1)}${(task.prompt || '').replace(/\s+/g, ' ').slice(0, 150)}`)
      write(`${'  '.repeat(node.depth + 1)}scope: ${scope}`)
      if (task.usage) write(`${'  '.repeat(node.depth + 1)}usage: ${task.usage.totalTokens} tokens${task.usage.estimated ? ' (estimated)' : ''} · ${task.runCount} run(s)`)
      for (const child of node.children) render(child)
    }
    for (const node of workspace.agents) render(node)
  }

  const subagentDetail = async (reference: string) => {
    const task = await resolveSubagent(reference)
    if (task.kind !== 'agent') throw new Error(`Task ${task.id} is not a subagent`)
    const childSessionId = task.childSessionId || (task.sessionId && task.sessionId !== task.parentSessionId ? task.sessionId : undefined)
    const [events, output, childPage] = await Promise.all([
      client.getTaskEvents(task.id, 120),
      client.getTaskOutput(task.id, 12_000, true),
      childSessionId ? client.getMessages(childSessionId, 0, 12, true) : Promise.resolve(undefined),
    ])
    write(`Subagent ${task.id} · ${task.specialistRole || 'general'} · ${task.status}`)
    write(`Parent: ${task.parentTaskId || task.parentSessionId || 'unknown'} · Child session: ${childSessionId || 'not created'}`)
    write(`Scope: ${task.scopePaths.join(', ') || '(workspace)'} · Depth: ${task.delegationDepth ?? 0} · Runs: ${task.runCount}`)
    if (task.usage) write(`Usage: ${task.usage.totalTokens} tokens (${task.usage.inputTokens} in / ${task.usage.outputTokens} out${task.usage.estimated ? ', estimated' : ''})`)
    if (task.activity?.label) write(`Current activity: ${task.activity.label}`)
    const messages = childPage?.messages || []
    if (messages.length) {
      write('Recent child conversation:')
      for (const message of messages.slice(-8)) {
        const content = String(message.content || '').replace(/\s+/g, ' ').trim()
        const tools = message.tool_calls?.map(call => call.function.name).join(', ')
        if (content) write(`  ${message.role}: ${content.slice(0, 220)}`)
        if (tools) write(`  tools: ${tools}`)
      }
    }
    if (events.length) {
      write('Recent lifecycle:')
      for (const item of events.slice(-16)) {
        const data = item.data && typeof item.data === 'object' ? item.data as Record<string, unknown> : {}
        const name = typeof data.name === 'string' ? ` · ${data.name}` : ''
        const message = typeof data.message === 'string' ? ` · ${data.message.slice(0, 100)}` : ''
        write(`  ${new Date(item.ts).toLocaleTimeString()} · ${item.type}${name}${message}`)
      }
    }
    if (output) write(`Latest output:\n${output.slice(-4000)}`)
  }

  const checkpointList = async () => {
    const { checkpoints } = await client.listCheckpoints(session.id)
    const rows = checkpoints as Array<{ id?: string; label?: string; ts?: number; messageCount?: number }>
    if (!rows.length) { write('No checkpoints for this session.'); return }
    rows.forEach((item, index) => write(`${index + 1}. ${String(item.id || '').slice(0, 10)} · ${item.label || 'checkpoint'} · ${item.messageCount ?? 0} messages · ${item.ts ? new Date(item.ts).toLocaleString() : 'unknown time'}`))
  }

  const submitPrompt = async (text: string, autonomous = false) => {
    const prompt = text.trim()
    if (!prompt) return
    if (editingQueuedId) {
      const id = editingQueuedId
      editingQueuedId = undefined
      await client.editQueue(session.id, id, prompt)
      editor.setValue('')
      await syncQueue()
      write(`Updated queued prompt ${id}.`)
      return
    }
    const result = await client.enqueue(session.id, prompt, { mode, autonomous, ...(selectedAgent ? { agent: selectedAgent } : {}) })
    editor.setValue('')
    await syncQueue()
    const queued = result.result as QueuedPrompt | undefined
    write(queued ? `Queued prompt ${queued.position}.` : 'Prompt submitted to the daemon queue.')
  }

  const dispatchInput = async (raw: string): Promise<boolean> => {
    const input = raw.trim()
    if (!input) return false
    try {
      if (!input.startsWith('/')) { await submitPrompt(input); return false }
      const [command, ...parts] = input.slice(1).split(/\s+/)
      const arg = parts.join(' ')
      switch ((command || '').toLowerCase()) {
        case 'quit': case 'exit': return true
        case 'help':
          write('Shared daemon commands: /status, /sessions, /resume <id>, /new, /plan, /build, /explore, /agent <name>, /queue, /interrupt, /cancel [task-id], /abort, /compact, /undo, /redo, /fork, /diff [staged], /tasks, /subagents [task-id], /subagent-send <task-id> <message>, /subagent-resume <task-id> <message>, /task-log <id>, /task-output <id>, /checkpoint [label], /checkpoints, /restore <checkpoint-id>, /branch <checkpoint-id>, /permissions, /questions, /device revoke, /quit. Terminal and Web View share the daemon-owned execution.')
          return false
        case 'status': {
          const [runtime, current] = await Promise.all([client.status(), client.getSessionStatus(session.id)])
          write(`Daemon ${owner.pid} · ${runtime.provider}:${runtime.model} · session ${session.id} · ${current.running ? 'running' : 'idle'} · seq ${current.sequence}`)
          return false
        }
        case 'sessions': {
          const result = await client.listSessions()
          for (const item of result.sessions) write(`${item.id}${item.id === session.id ? '  ← current' : ''} · ${new Date(item.updated).toLocaleString()} · ${item.model}`)
          return false
        }
        case 'resume': {
          if (!arg) { warn('Usage: /resume <session-id>'); return false }
          const result = await client.listSessions()
          const target = result.sessions.find(item => item.id === arg && path.resolve(item.cwd) === expectedCwd)
          if (!target) throw new Error(`Session ${arg} not found in this workspace.`)
          await activateSession(target)
          return false
        }
        case 'new': {
          const created = await client.createSession(cwd, info.model)
          await activateSession(created)
          return false
        }
        case 'plan': case 'build': case 'explore': setMode(command!.toLowerCase()); return false
        case 'mode': setMode(arg); return false
        case 'agent': {
          if (!arg) {
            const agents = await client.listAgents()
            write(`Available agents: ${[...agents.builtin, ...agents.custom.map(agent => agent.name)].join(', ')}`)
            return false
          }
          const agents = await client.listAgents()
          const name = agents.custom.find(agent => agent.name === arg)?.name
          if (!name) throw new Error(`Unknown custom agent: ${arg}`)
          selectedAgent = name
          write(`Custom agent selected: ${name}`)
          return false
        }
        case 'auto': await submitPrompt(arg, true); return false
        case 'queue': {
          const [sub, id] = parts
          if (!sub) { await queueList(); return false }
          if (sub === 'cancel' && id) await client.cancelQueue(session.id, id)
          else if (sub === 'up' && id) await client.moveQueue(session.id, id, -1)
          else if (sub === 'down' && id) await client.moveQueue(session.id, id, 1)
          else if (sub === 'edit' && id) {
            const item = (await client.getQueue(session.id, false)).find(value => value.id === id || value.id.startsWith(id))
            if (!item) throw new Error(`Queue item ${id} not found.`)
            editingQueuedId = item.id
            editor.setValue(item.content)
            write(`Editing queue item ${item.id}; submit text to save.`)
            return false
          } else { warn('Usage: /queue [cancel|up|down|edit] <id>'); return false }
          await syncQueue()
          return false
        }
        case 'interrupt': await client.interrupt(session.id); write('Interrupt requested.'); return false
        case 'cancel': {
          if (!arg) { await client.interrupt(session.id); write('Interrupt requested.'); return false }
          const task = await resolveTask(arg)
          await client.cancelTask(task.id)
          write(`Cancellation requested for task ${task.id}.`)
          return false
        }
        case 'abort': await client.abort(session.id); write('Abort requested.'); return false
        case 'compact': await client.compact(session.id); await syncSnapshot(true); write('Context compacted.'); return false
        case 'undo': await client.undo(session.id); await syncSnapshot(true); return false
        case 'redo': await client.redo(session.id); await syncSnapshot(true); return false
        case 'fork': {
          const result = await client.fork(session.id)
          const list = await client.listSessions()
          const next = [...list.sessions].filter(item => item.id !== session.id && path.resolve(item.cwd) === expectedCwd).sort((a, b) => b.created - a.created)[0]
          if (next) await activateSession(next)
          else write(JSON.stringify(result.result ?? result))
          return false
        }
        case 'diff': {
          const result = await client.getDiff(session.id, parts.some(part => part === 'staged')) as DiffResult
          if (ui) ui.openWorkingTreeDiff(result, parts.includes('staged') ? 'Staged changes' : 'Working tree')
          else write(result.text || 'No changes.')
          return false
        }
        case 'tasks': await taskList(); return false
        case 'subagents': {
          if (arg) await subagentDetail(arg)
          else await subagentList()
          return false
        }
        case 'subagent-send': {
          const split = arg.indexOf(' ')
          if (split < 1) { warn('Usage: /subagent-send <task-id> <message>'); return false }
          const task = await resolveSubagent(arg.slice(0, split))
          if (task.kind !== 'agent') throw new Error(`Task ${task.id} is not a subagent`)
          await client.sendTask(task.id, arg.slice(split + 1))
          write(`Instruction queued for subagent ${task.id}.`)
          return false
        }
        case 'subagent-resume': {
          const split = arg.indexOf(' ')
          if (split < 1) { warn('Usage: /subagent-resume <task-id> <message>'); return false }
          const task = await resolveSubagent(arg.slice(0, split))
          if (task.kind !== 'agent') throw new Error(`Task ${task.id} is not a subagent`)
          await client.resumeTask(task.id, arg.slice(split + 1))
          write(`Subagent ${task.id} queued to resume.`)
          return false
        }
        case 'task-log': {
          if (!arg) { warn('Usage: /task-log <task-id>'); return false }
          const task = await resolveTask(arg)
          const events: TaskEvent[] = await client.getTaskEvents(task.id)
          if (!events.length) { write(`No events for task ${task.id}.`); return false }
          for (const event of events.slice(-60)) write(`${new Date(event.ts).toLocaleTimeString()} · ${event.type} · ${JSON.stringify(event.data).slice(0, 240)}`)
          return false
        }
        case 'task-output': {
          if (!arg) { warn('Usage: /task-output <task-id>'); return false }
          const task = await resolveTask(arg)
          const output = await client.getTaskOutput(task.id, 20_000, true)
          write(output || '(no task output)')
          return false
        }
        case 'checkpoint': {
          const result = await client.createCheckpoint(session.id, arg || 'terminal')
          const checkpoint = (result as any).result ?? result
          write(`Checkpoint created · ${String(checkpoint.id || 'saved').slice(0, 10)} · ${checkpoint.label || arg || 'terminal'}`)
          return false
        }
        case 'checkpoints': await checkpointList(); return false
        case 'restore': {
          if (!arg) { warn('Usage: /restore <checkpoint-id>'); return false }
          const result = await client.restoreCheckpoint(session.id, arg)
          await syncSnapshot(true)
          write(`Restored checkpoint ${String((result as any).checkpoint?.id || arg).slice(0, 10)}.`)
          return false
        }
        case 'branch': {
          if (!arg) { warn('Usage: /branch <checkpoint-id> [--restore-workspace]'); return false }
          const restoreWorkspace = parts.includes('--restore-workspace')
          const result = await client.branchCheckpoint(session.id, parts[0]!, restoreWorkspace) as any
          const next = result?.meta ?? result?.session ?? result
          if (!next || typeof next.id !== 'string') throw new Error('The server returned an invalid checkpoint branch session.')
          await activateSession(next as SessionMeta)
          return false
        }
        case 'permissions': case 'questions': await syncInteractions(); {
          const [permissions, questions] = await Promise.all([client.listPermissions(session.id), client.listQuestions(session.id)])
          const items = command === 'permissions' ? permissions : questions
          write(items.filter(item => item.status === 'pending').map(item => `${item.requestId} · ${item.kind} · pending`).join('\n') || `No pending ${command}.`)
          return false
        }
        case 'device': {
          if (arg !== 'revoke') { write('Usage: /device revoke'); return false }
          const result = await client.revokeDevice()
          await removeTerminalDeviceCredential(owner.workspaceId)
          write(result.revoked ? 'This terminal device has been revoked. Reconnect and pair it again to use the daemon.' : 'This terminal device was already revoked.')
          return true
        }
        default: warn(`Unknown command: /${command}. Use /help.`); return false
      }
    } catch (error) {
      showError(error)
      return false
    }
  }

  editor = new PromptEditor({
    history: snapshot.state.messages.filter(message => message.role === 'user' && typeof message.content === 'string').map(message => message.content as string),
    completions: defaultCompletionItems(commands, [], cwd),
    onChange: (value, cursor) => ui?.setInput(value, cursor),
    onMouse: event => { void ui?.handleMouse(event) },
    onScroll: delta => { if (delta <= -100000) ui?.scrollToTop(); else if (delta >= 100000) ui?.scrollToBottom(); else ui?.scroll(delta) },
    isModalActive: () => Boolean(ui?.isPermissionActive() || ui?.isQuestionActive() || ui?.isInspectorActive()),
    onReadStateChange: active => ui?.setEditorReading(active),
  })

  await syncSnapshot(false)
  const running = await client.getSessionStatus(session.id)
  if (running.running) startTurn()
  await syncInteractions()
  startEventPump(session.id, snapshot.sequence)

  try {
    if (interactive) {
      while (!closed) {
        const result = await editor.read()
        if (result.type === 'exit') break
        if (result.type === 'cancel') continue
        if (await dispatchInput(result.value)) break
      }
    } else {
      const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          if (closed) break
          if (await dispatchInput(line)) break
        }
      } finally { lines.close() }
    }
  } finally {
    closed = true
    streamAbort?.abort()
    interactionControllers.forEach(controller => controller.abort(new Error('Terminal client closed')))
    interactionControllers.clear()
    endTurn()
    ui?.leave(session.id)
  }
}

async function canonicalPath(value: string): Promise<string> {
  const absolute = path.resolve(value)
  try {
    const fs = await import('node:fs/promises') as unknown as { realpath: (value: string) => Promise<string> }
    return await fs.realpath(absolute)
  } catch {
    return absolute
  }
}
