// 14I-B3 Stream O — parent orchestration observe/reconcile (TODO item 857).
// Covers: the parent observes every child task it launched, distinguishes the
// child lifecycle states, injects exactly one structured reconciliation
// message per changed status fingerprint, and blocks completion while a child
// is still queued or running. Tests import dist/ like every other suite here;
// build happens at integration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_KEYS = ['HOME', 'TERMAGENT_TASK_ROOT', 'TERMAGENT_SESSION_ROOT', 'TERMAGENT_TASK_OBSERVE_MAX']
function saveEnv() { return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) }
function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function rmWithRetry(target, attempts = 5) {
  for (let index = 1; index <= attempts; index++) {
    try { await rm(target, { recursive: true, force: true }); return }
    catch (error) {
      if (index === attempts || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * index))
    }
  }
}

async function fixture() {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14i-b3-agent-'))
  const taskRoot = path.join(home, '.termagent', 'tasks')
  const sessionRoot = path.join(home, '.termagent', 'sessions')
  await mkdir(taskRoot, { recursive: true })
  await mkdir(sessionRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_TASK_ROOT = taskRoot
  process.env.TERMAGENT_SESSION_ROOT = sessionRoot
  delete process.env.TERMAGENT_TASK_OBSERVE_MAX
  return {
    home, taskRoot, sessionRoot,
    async cleanup() {
      restoreEnv(previous)
      await rmWithRetry(home)
    },
  }
}

function childLauncher(manager, { settle = false } = {}) {
  return {
    name: 'background_agent', risk: 'shell', description: 'launch a background child agent',
    schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    async execute(args, ctx) {
      const task = await manager.createAgent(
        String(args.prompt || 'child work'),
        ctx.cwd,
        { provider: 'openai-compatible', model: 'mock', baseUrl: 'http://127.0.0.1' },
        ['.'],
        ctx.sessionID,
        { background: true },
      )
      if (settle) await manager.update(task.id, { status: 'exited', result: 'child done', ended: Date.now() })
      return { output: `Started background agent ${task.id}`, metadata: { taskId: task.id, status: 'running', background: true } }
    },
  }
}

function scriptedProvider(captured, { settleFirstCall = false } = {}) {
  return {
    id: 'mock', model: 'mock', calls: 0,
    config: { provider: 'openai-compatible', model: 'mock', baseUrl: 'http://127.0.0.1' },
    async *stream(messages) {
      this.calls++
      captured.push(messages.map(message => ({ role: message.role, content: String(message.content || '') })))
      if (this.calls === 1) {
        yield { type: 'tool_call', call: { id: 'c1', type: 'function', function: { name: 'background_agent', arguments: JSON.stringify({ prompt: 'child work' }) } } }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text', delta: settleFirstCall ? 'the child already finished' : 'still waiting for the child' }
      yield { type: 'done', finishReason: 'stop' }
    },
  }
}

test('14I-B3: the parent turn waits for a pending child task and blocks completion until it reconciles', async () => {
  const f = await fixture()
  try {
    process.env.TERMAGENT_TASK_OBSERVE_MAX = '2'
    const { SessionStore } = await import('../../dist/session/store.js')
    const { TaskManager } = await import('../../dist/tasks/manager.js')
    const { Agent } = await import('../../dist/agent/agent.js')
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')
    const sessions = new SessionStore(f.sessionRoot)
    const parent = await sessions.create(f.home, 'mock')
    const manager = new TaskManager(f.taskRoot, false, f.sessionRoot)
    const registry = new ToolRegistry(new PermissionGate('auto')).add(childLauncher(manager))
    const captured = []
    const provider = scriptedProvider(captured)
    const agent = new Agent(provider, registry, sessions, 2, 6000, 1, undefined, undefined, {}, undefined, {}, undefined, manager)
    await agent.run({ sessionId: parent.id, messages: [], cwd: f.home, instructions: '', prompt: 'delegate the work' })

    assert.ok(captured.length >= 3, `the parent kept the turn alive while the child was pending (provider calls: ${captured.length})`)
    const last = captured[captured.length - 1].map(message => message.content)
    assert.equal(last.filter(content => content.includes('<task-reconciliation tasks=')).length, 1, 'exactly one structured reconciliation message per changed fingerprint')
    assert.ok(last.some(content => content.includes('<task-reconciliation-pending')), 'completion was blocked until the child reconciled')
    assert.ok(last.some(content => content.includes('Completion must wait')))
    assert.ok(last.some(content => content.includes('status="queued"')), 'the pending child is reported as queued')
  } finally { await f.cleanup() }
})

test('14I-B3: a settled child task is reconciled and lets the parent complete without a blocking notice', async () => {
  const f = await fixture()
  try {
    const { SessionStore } = await import('../../dist/session/store.js')
    const { TaskManager } = await import('../../dist/tasks/manager.js')
    const { Agent } = await import('../../dist/agent/agent.js')
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')
    const sessions = new SessionStore(f.sessionRoot)
    const parent = await sessions.create(f.home, 'mock')
    const manager = new TaskManager(f.taskRoot, false, f.sessionRoot)
    const registry = new ToolRegistry(new PermissionGate('auto')).add(childLauncher(manager, { settle: true }))
    const captured = []
    const provider = scriptedProvider(captured, { settleFirstCall: true })
    const agent = new Agent(provider, registry, sessions, 2, 6000, 1, undefined, undefined, {}, undefined, {}, undefined, manager)
    await agent.run({ sessionId: parent.id, messages: [], cwd: f.home, instructions: '', prompt: 'delegate the work' })

    assert.equal(captured.length, 2, 'the parent completed as soon as the child settled')
    const last = captured[captured.length - 1].map(message => message.content)
    assert.equal(last.some(content => content.includes('<task-reconciliation-pending')), false, 'no blocking notice once the child settled')
    assert.ok(last.some(content => content.includes('<task-reconciliation tasks=')), 'the child outcome is reconciled')
    assert.ok(last.some(content => content.includes('status="completed"')), 'the settled child is reported as completed')
    assert.ok(last.some(content => content.includes('child done')), 'the child result summary is actionable')
  } finally { await f.cleanup() }
})
