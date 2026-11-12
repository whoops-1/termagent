// 14I-B3 Stream O — orchestration observe/reconcile + loop prevention.
// Covers: fan-out and delegation-depth guardrails, duplicate/overlapping scope
// refusal, duplicate/no-progress launch refusal with a changed-cause retry,
// terminal credential errors never being respawned, redacted task-lock
// contention diagnostics, corrupt task records reported as a separate
// diagnostics class, and the pure parent reconciliation helper.
// Tests import dist/ like every other suite here; build happens at integration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_KEYS = [
  'HOME', 'TERMAGENT_TASK_ROOT', 'TERMAGENT_TASK_LOCK_TIMEOUT_MS',
  'TERMAGENT_TASK_MAX_FANOUT', 'TERMAGENT_TASK_MAX_DEPTH', 'TERMAGENT_TASK_MAX_RETRIES',
  'TERMAGENT_MAX_ACTIVE_AGENTS', 'TERMAGENT_MAX_AGENT_DEPTH',
  'TERMAGENT_TEST_CHILD_KEY',
]
function saveEnv() { return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) }
function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// Beyond any plausible pid allocation on POSIX and Windows: kill(pid, 0) → ESRCH.
const DEAD_PID = 2147483647
const signal = new AbortController().signal

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
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14i-b3-home-'))
  const taskRoot = path.join(home, '.termagent', 'tasks')
  await mkdir(taskRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_TASK_ROOT = taskRoot
  delete process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS
  delete process.env.TERMAGENT_TASK_MAX_FANOUT
  delete process.env.TERMAGENT_TASK_MAX_DEPTH
  delete process.env.TERMAGENT_TASK_MAX_RETRIES
  delete process.env.TERMAGENT_MAX_ACTIVE_AGENTS
  delete process.env.TERMAGENT_MAX_AGENT_DEPTH
  // A resolvable credential reference keeps the child provider snapshot
  // preflight (owned by the provider stream) satisfied for this fixture.
  process.env.TERMAGENT_TEST_CHILD_KEY = 'test-key'
  const { TaskManager, computeLaunchFingerprint } = await import('../../dist/tasks/manager.js')
  const manager = new TaskManager(taskRoot, false)
  const provider = { provider: 'openai-compatible', model: 'mock', baseUrl: 'http://127.0.0.1', apiKeyEnv: 'TERMAGENT_TEST_CHILD_KEY' }
  return {
    manager, taskRoot, provider, computeLaunchFingerprint,
    lockPath: id => path.join(taskRoot, `.${id}.task.lock`),
    writeTask: async (id, overrides = {}) => writeFile(path.join(taskRoot, `${id}.json`), JSON.stringify({
      id, kind: 'agent', status: 'running', prompt: 'SECRET-PROMPT-DO-NOT-LOG', cwd: taskRoot,
      started: Date.now(), updated: Date.now(), ...overrides,
    }), 'utf8'),
    writeLock: async (lockPath, owner) => writeFile(lockPath, typeof owner === 'string' ? owner : JSON.stringify(owner) + '\n', 'utf8'),
    async cleanup() {
      restoreEnv(previous)
      await rmWithRetry(home)
    },
  }
}

test('14I-B3: fan-out cap refuses the launch and names the count and the env knob', async () => {
  const f = await fixture()
  try {
    process.env.TERMAGENT_TASK_MAX_FANOUT = '2'
    const { TaskManager } = await import('../../dist/tasks/manager.js')
    const manager = new TaskManager(f.taskRoot, false)
    await manager.createAgent('one', f.taskRoot, f.provider, ['a'], 'parent', { background: true })
    await manager.createAgent('two', f.taskRoot, f.provider, ['b'], 'parent', { background: true })
    await assert.rejects(
      () => manager.createAgent('three', f.taskRoot, f.provider, ['c'], 'parent', { background: true }),
      error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /delegation limit exceeded/i)
        assert.match(error.message, /2 active child agent/)
        assert.match(error.message, /TERMAGENT_TASK_MAX_FANOUT/)
        return true
      },
    )
  } finally { await f.cleanup() }
})

test('14I-B3: delegation depth cap refuses the launch and names the env knob', async () => {
  const f = await fixture()
  try {
    process.env.TERMAGENT_TASK_MAX_DEPTH = '1'
    const { TaskManager } = await import('../../dist/tasks/manager.js')
    const manager = new TaskManager(f.taskRoot, false)
    await manager.createAgent('child', f.taskRoot, f.provider, ['a'], 'parent', { background: true, delegationDepth: 1 })
    await assert.rejects(
      () => manager.createAgent('grandchild', f.taskRoot, f.provider, ['b'], 'parent', { background: true, delegationDepth: 2, parentTaskId: 'child' }),
      error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /delegation depth 2 exceeds the configured maximum of 1/)
        assert.match(error.message, /TERMAGENT_TASK_MAX_DEPTH/)
        return true
      },
    )
  } finally { await f.cleanup() }
})

test('14I-B3: overlapping scopes are refused and the conflicting task id is named', async () => {
  const f = await fixture()
  try {
    const first = await f.manager.createAgent('one', f.taskRoot, f.provider, ['src'], 'parent', { background: true })
    await assert.rejects(
      () => f.manager.createAgent('two', f.taskRoot, f.provider, ['src/lib'], 'parent', { background: true }),
      error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /scope conflict/i)
        assert.ok(error.message.includes(first.id), 'the conflicting task id is named')
        return true
      },
    )
    // Two explicitly coordinated launches may not claim the same scope either.
    const coordinated = await f.manager.createAgent('three', f.taskRoot, f.provider, ['src/other'], 'parent', { background: true, coordinated: true })
    await assert.rejects(
      () => f.manager.createAgent('four', f.taskRoot, f.provider, ['src/other/lib'], 'parent', { background: true, coordinated: true }),
      error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /scope conflict/i)
        assert.ok(error.message.includes(coordinated.id), 'the conflicting coordinated task id is named')
        return true
      },
    )
  } finally { await f.cleanup() }
})

test('14I-B3: a duplicate launch is refused until the cause materially changes', async () => {
  const f = await fixture()
  try {
    const fingerprint = f.computeLaunchFingerprint({ kind: 'agent', prompt: 'refactor the parser', scopePaths: ['src'] })
    const task = await f.manager.createAgent('refactor the parser', f.taskRoot, f.provider, ['src'], 'parent', { background: true, launchFingerprint: fingerprint })
    await f.manager.update(task.id, { status: 'failed', error: 'worker crashed' })

    const refused = await f.manager.evaluateLaunchAttempt({ parentSessionId: 'parent', fingerprint, label: 'child task' })
    assert.equal(refused.allowed, false)
    assert.equal(refused.reason, 'duplicate-terminal')
    assert.equal(refused.taskId, task.id)
    assert.match(refused.message, /retry_cause/)

    // A materially changed cause unlocks exactly one retry, and the cause is
    // recorded durably with the attempt.
    const retry = await f.manager.createAgent('refactor the parser', f.taskRoot, f.provider, ['src'], 'parent', { background: true, launchFingerprint: fingerprint, launchRetryCause: 'fixture was missing; added it' })
    assert.equal(retry.launchRetryCause, 'fixture was missing; added it')
    await f.manager.update(retry.id, { status: 'failed', error: 'crashed again' })

    // Repeating the same retry cause is not a changed cause.
    const unchanged = await f.manager.evaluateLaunchAttempt({ parentSessionId: 'parent', fingerprint, retryCause: 'fixture was missing; added it', label: 'child task' })
    assert.equal(unchanged.allowed, false)
    assert.equal(unchanged.reason, 'duplicate-terminal')

    // A different cause is a materially changed cause.
    const changed = await f.manager.evaluateLaunchAttempt({ parentSessionId: 'parent', fingerprint, retryCause: 'dependency was upgraded', label: 'child task' })
    assert.equal(changed.allowed, true)

    // A changed prompt is a different unit of work and is always allowed.
    const other = f.computeLaunchFingerprint({ kind: 'agent', prompt: 'refactor the lexer', scopePaths: ['src'] })
    const otherDecision = await f.manager.evaluateLaunchAttempt({ parentSessionId: 'parent', fingerprint: other, label: 'child task' })
    assert.equal(otherDecision.allowed, true)
  } finally { await f.cleanup() }
})

test('14I-B3: an identical launch that is still in flight is refused as duplicate work', async () => {
  const f = await fixture()
  try {
    const fingerprint = f.computeLaunchFingerprint({ kind: 'agent', prompt: 'long running review', scopePaths: ['src'] })
    const task = await f.manager.createAgent('long running review', f.taskRoot, f.provider, ['src'], 'parent', { background: true, launchFingerprint: fingerprint })
    const decision = await f.manager.evaluateLaunchAttempt({ parentSessionId: 'parent', fingerprint, label: 'child task' })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'duplicate-in-flight')
    assert.equal(decision.taskId, task.id)
    // A different parent session is a different orchestration scope.
    const otherSession = await f.manager.evaluateLaunchAttempt({ parentSessionId: 'other', fingerprint, label: 'child task' })
    assert.equal(otherSession.allowed, true)
  } finally { await f.cleanup() }
})

test('14I-B3: a terminal credential error is never retried or respawned', async () => {
  const f = await fixture()
  try {
    const fingerprint = f.computeLaunchFingerprint({ kind: 'agent', prompt: 'call the api', scopePaths: ['src'] })
    const task = await f.manager.createAgent('call the api', f.taskRoot, f.provider, ['src'], 'parent', { background: true, launchFingerprint: fingerprint })
    await f.manager.update(task.id, { status: 'failed', error: '401 invalid credential', terminalCredentialError: true })
    const decision = await f.manager.evaluateLaunchAttempt({ parentSessionId: 'parent', fingerprint, retryCause: 'rotated the credential', label: 'child task' })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'terminal-credential')
    assert.match(decision.message, /terminal credential error/)
    await assert.rejects(() => f.manager.assertLaunchPermitted({ parentSessionId: 'parent', fingerprint, retryCause: 'rotated the credential', label: 'child task' }), /terminal credential error/)
  } finally { await f.cleanup() }
})

test('14I-B3: repeated retries are bounded by the retry budget', async () => {
  const f = await fixture()
  try {
    process.env.TERMAGENT_TASK_MAX_RETRIES = '1'
    const fingerprint = f.computeLaunchFingerprint({ kind: 'agent', prompt: 'flaky job', scopePaths: ['src'] })
    const first = await f.manager.createAgent('flaky job', f.taskRoot, f.provider, ['src'], 'parent', { background: true, launchFingerprint: fingerprint })
    await f.manager.update(first.id, { status: 'failed', error: 'boom' })
    const retry = await f.manager.createAgent('flaky job', f.taskRoot, f.provider, ['src'], 'parent', { background: true, launchFingerprint: fingerprint, launchRetryCause: 'first fix' })
    await f.manager.update(retry.id, { status: 'failed', error: 'boom again' })
    const decision = await f.manager.evaluateLaunchAttempt({ parentSessionId: 'parent', fingerprint, retryCause: 'second fix', label: 'child task' })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'retry-budget')
    assert.match(decision.message, /TERMAGENT_TASK_MAX_RETRIES/)
  } finally { await f.cleanup() }
})

test('14I-B3: the background agent tool refuses a duplicate launch and accepts a changed cause', async () => {
  const f = await fixture()
  try {
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')
    const { backgroundAgentTool } = await import('../../dist/tools/background.js')
    f.manager.spawnWorker = async id => { await f.manager.update(id, { status: 'failed', error: 'worker crashed' }); return 4321 }
    const provider = { id: 'mock', model: 'mock', config: { provider: 'openai-compatible', model: 'mock', baseUrl: 'http://127.0.0.1', apiKeyEnv: 'TERMAGENT_TEST_CHILD_KEY' } }
    const registry = new ToolRegistry(new PermissionGate('auto')).add(backgroundAgentTool(f.manager, provider, provider.config))
    const ctx = { sessionID: 'parent', agent: 'build', cwd: f.taskRoot, abort: signal }
    const started = await registry.execute('background_agent', { prompt: 'inspect the module', scope_paths: ['src'] }, ctx)
    assert.match(started.output, /Started background agent/)
    await assert.rejects(
      () => registry.execute('background_agent', { prompt: 'inspect the module', scope_paths: ['src'] }, ctx),
      error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Refusing to launch/)
        assert.match(error.message, /retry_cause/)
        return true
      },
    )
    const retried = await registry.execute('background_agent', { prompt: 'inspect the module', scope_paths: ['src'], retry_cause: 'the fixture was missing; added it' }, ctx)
    assert.match(retried.output, /Started background agent/)
    const records = await f.manager.list()
    assert.ok(records.every(record => typeof record.launchFingerprint === 'string' && record.launchFingerprint.length === 64))
  } finally { await f.cleanup() }
})

test('14I-B3: the launch tools consume the child provider preflight contract when it is available', async () => {
  const f = await fixture()
  try {
    delete process.env.TERMAGENT_TEST_CHILD_KEY
    const taskProvider = await import('../../dist/tasks/task-provider.js')
    const preflightAvailable = typeof taskProvider.preflightTaskProviderConfig === 'function'
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')
    const { backgroundAgentTool } = await import('../../dist/tools/background.js')
    f.manager.spawnWorker = async () => 4321
    const provider = { id: 'mock', model: 'mock', config: { provider: 'openai-compatible', model: 'mock', baseUrl: 'http://127.0.0.1', apiKeyEnv: 'TERMAGENT_TEST_CHILD_KEY' } }
    const registry = new ToolRegistry(new PermissionGate('auto')).add(backgroundAgentTool(f.manager, provider, provider.config))
    const ctx = { sessionID: 'parent', agent: 'build', cwd: f.taskRoot, abort: signal }
    if (preflightAvailable) {
      await assert.rejects(
        () => registry.execute('background_agent', { prompt: 'unresolvable credential' }, ctx),
        error => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /preflight/i)
          assert.match(error.message, /missing-credential/)
          return true
        },
      )
      assert.equal((await f.manager.list()).length, 0, 'a refused launch never creates a child task')
    } else {
      const started = await registry.execute('background_agent', { prompt: 'unresolvable credential' }, ctx)
      assert.match(started.output, /Started background agent/)
    }
  } finally { await f.cleanup() }
})

test('14I-B3: lock contention diagnostics are structured and redacted', async () => {
  const f = await fixture()
  try {
    process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS = '300'
    const { TaskManager } = await import('../../dist/tasks/manager.js')
    const manager = new TaskManager(f.taskRoot, false)
    await f.writeTask('t1', { status: 'running', prompt: 'SECRET-PROMPT-DO-NOT-LOG' })
    await f.writeLock(f.lockPath('t1'), { pid: process.pid, token: 'foreign-token', started: Date.now(), identity: 'node#12345' })
    await assert.rejects(() => manager.update('t1', { status: 'exited' }), error => error instanceof Error && error.message.startsWith('Task t1 is busy:'))
    const contention = manager.lastTaskLeaseContention()
    assert.ok(contention, 'a contention record is available')
    assert.equal(contention.lock, 'task')
    assert.equal(contention.id, 't1')
    assert.equal(contention.opKind, 'task-record:t1')
    assert.equal(contention.decision, 'live-owner')
    assert.equal(contention.ownerPid, process.pid)
    assert.equal(contention.ownerIdentity, 'node#12345')
    assert.ok(contention.waitMs >= 0)
    assert.ok(contention.retries >= 0)
    assert.ok(contention.at > 0)
    assert.ok(contention.attempts >= 1)
    const serialized = JSON.stringify(contention)
    assert.equal(serialized.includes('SECRET-PROMPT-DO-NOT-LOG'), false, 'no prompt content in lock diagnostics')
    assert.equal(serialized.includes('foreign-token'), false, 'no lock token in lock diagnostics')
  } finally { await f.cleanup() }
})

test('14I-B3: a stale lock owner is recovered and reported as a recovery decision', async () => {
  const f = await fixture()
  try {
    const { TaskManager } = await import('../../dist/tasks/manager.js')
    const manager = new TaskManager(f.taskRoot, false)
    await f.writeTask('t2', { status: 'running' })
    await f.writeLock(f.lockPath('t2'), { pid: DEAD_PID, token: 'stale-token', started: Date.now() })
    await manager.update('t2', { status: 'exited' })
    const contention = manager.lastTaskLeaseContention()
    assert.equal(contention.decision, 'recovered-stale')
    assert.equal(contention.ownerPid, DEAD_PID)
    assert.equal(contention.lock, 'task')
    assert.equal(contention.id, 't2')
  } finally { await f.cleanup() }
})

test('14I-B3: a corrupt task record is reported separately from lock contention', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.taskRoot, 'broken.json'), '{ this is not json', 'utf8')
    const records = await f.manager.list()
    assert.equal(records.some(record => record.id === 'broken'), false, 'a corrupt record is not surfaced as a task')
    const diagnostics = f.manager.taskRecordDiagnostics()
    const corrupt = diagnostics.find(item => item.id === 'broken')
    assert.ok(corrupt, 'the corrupt record is diagnosed')
    assert.equal(corrupt.class, 'task-record')
    assert.equal(corrupt.kind, 'corrupt-record')
    assert.ok(corrupt.at > 0)
    assert.equal(JSON.stringify(corrupt).includes('this is not json'), false, 'no record content in diagnostics')
    await assert.rejects(() => f.manager.get('broken'), /corrupt/i)
    // The two diagnostics classes stay separate.
    assert.equal(f.manager.lastTaskLeaseContention(), undefined)
    assert.notEqual(f.manager.lastTaskRecordDiagnostic().class, 'lock')
  } finally { await f.cleanup() }
})

test('14I-B3: the parent reconciliation helper classifies child outcomes and dedupes by fingerprint', async () => {
  const { classifyChildTaskOutcome, planChildTaskReconciliation, renderChildTaskBlockingNotice } = await import('../../dist/agent/agent.js')
  assert.equal(classifyChildTaskOutcome({ status: 'queued' }), 'queued')
  assert.equal(classifyChildTaskOutcome({ status: 'running' }), 'running')
  assert.equal(classifyChildTaskOutcome({ status: 'exited' }), 'completed')
  assert.equal(classifyChildTaskOutcome({ status: 'failed' }), 'failed')
  assert.equal(classifyChildTaskOutcome({ status: 'failed', termination: 'timeout' }), 'timed-out')
  assert.equal(classifyChildTaskOutcome({ status: 'cancelled' }), 'cancelled')

  const tasks = [
    { id: 'b', kind: 'agent', outcome: 'running', summary: '' },
    { id: 'a', kind: 'agent', outcome: 'completed', summary: 'done' },
    { id: 'c', kind: 'shell', outcome: 'failed', summary: 'boom' },
  ]
  const first = planChildTaskReconciliation(tasks, { previousFingerprint: '' })
  assert.equal(first.changed, true)
  assert.equal(first.inject, true)
  assert.equal(first.pending, 1)
  assert.equal(first.terminal, 2)
  assert.equal(first.fingerprint, 'a:completed|b:running|c:failed')
  assert.match(first.message, /<task-reconciliation tasks="3" pending="1" settled="2">/)
  assert.match(first.message, /id="a"[^>]*status="completed"/)
  assert.match(first.message, /id="c"[^>]*status="failed">boom</)

  // The same fingerprint must not be injected again: no progress flooding.
  const second = planChildTaskReconciliation(tasks, { previousFingerprint: first.fingerprint })
  assert.equal(second.changed, false)
  assert.equal(second.inject, false)
  assert.equal(second.message, '')

  // A changed status fingerprint produces exactly one new reconciliation.
  const changed = planChildTaskReconciliation([...tasks, { id: 'd', kind: 'agent', outcome: 'queued', summary: '' }], { previousFingerprint: first.fingerprint })
  assert.equal(changed.changed, true)
  assert.equal(changed.pending, 2)

  // Observations are bounded.
  const many = Array.from({ length: 40 }, (_, index) => ({ id: `t${index}`, kind: 'agent', outcome: 'running', summary: '' }))
  const bounded = planChildTaskReconciliation(many, { previousFingerprint: '', maxObserve: 12 })
  assert.equal(bounded.observed, 12)
  assert.match(bounded.message, /<task-omitted count="28"\/>/)

  const notice = renderChildTaskBlockingNotice(tasks, 1)
  assert.match(notice, /<task-reconciliation-pending count="1">/)
  assert.match(notice, /Completion must wait/)
  assert.match(notice, /b\(running\)/)
})
