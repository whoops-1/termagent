import type { TaskRecord } from './manager.js'

function compact(text: string | undefined, max = 120) {
  const value = (text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function formatTaskList(tasks: TaskRecord[]) {
  if (!tasks.length) return 'No background tasks.'
  const active = tasks.filter(t => t.status === 'queued' || t.status === 'running')
  const done = tasks.filter(t => t.status !== 'queued' && t.status !== 'running')
  const lines = [`Tasks · ${active.length} active · ${done.length} finished`, '']
  const render = (title: string, group: TaskRecord[]) => {
    if (!group.length) return
    lines.push(title)
    for (const t of group) {
      const age = Math.max(0, Math.floor((Date.now() - t.started) / 1000))
      const work = compact(t.command || t.prompt, 96)
      lines.push(`${t.status.padEnd(9)} ${t.id}  ${age}s  ${work || '(no description)'}`)
    }
    lines.push('')
  }
  render('Active', active)
  render('Finished', done)
  return lines.join('\n').trimEnd()
}

export function summarizeTask(task: TaskRecord) {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    pid: task.pid ?? null,
    sessionId: task.sessionId ?? null,
    scopePaths: task.scopePaths ?? [],
    started: task.started,
    updated: task.updated,
    elapsedMs: Math.max(0, task.updated - task.started),
    command: task.command ?? null,
    prompt: task.prompt ?? null,
    outputBytes: Buffer.byteLength(task.output || '', 'utf8'),
  }
}

export function formatTaskDetail(task: TaskRecord) {
  const summary = summarizeTask(task)
  const lines = [
    `Task ${summary.id}`,
    `status: ${summary.status}`,
    `kind: ${summary.kind}`,
    `pid: ${summary.pid ?? '-'}`,
    `session: ${summary.sessionId ?? '-'}`,
    `elapsed: ${Math.floor(summary.elapsedMs / 1000)}s`,
    `cwd: ${task.cwd}`,
    `scope: ${summary.scopePaths.length ? summary.scopePaths.join(', ') : '(entire project)'}`,
  ]
  if (summary.command) lines.push(`command: ${summary.command}`)
  if (summary.prompt) lines.push(`prompt: ${compact(summary.prompt, 220)}`)
  if (task.exitCode !== undefined) lines.push(`exit code: ${task.exitCode}`)
  if (summary.outputBytes) lines.push(`output: ${summary.outputBytes} bytes`)
  return lines.join('\n')
}
