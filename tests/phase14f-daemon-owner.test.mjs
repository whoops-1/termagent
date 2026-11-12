import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14f-'))
  const stateRoot = path.join(root, 'state')
  const workspace = path.join(root, 'workspace')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace, { recursive: true }))
  const { acquireDaemonOwner, readDaemonOwner } = await import('../dist/server/daemon-owner.js')
  return { root, stateRoot, workspace, acquireDaemonOwner, readDaemonOwner }
}

test('daemon owner lease is exclusive per canonical workspace and publishes safe endpoint metadata', async () => {
  const f = await fixture()
  let owner
  try {
    owner = await f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'server', heartbeatMs: 500 })
    await owner.update({ state: 'ready', endpoint: 'http://127.0.0.1:4096' })

    const info = await f.readDaemonOwner(f.workspace, { stateRoot: f.stateRoot })
    assert.equal(info.id, owner.id)
    assert.equal(info.mode, 'server')
    assert.equal(info.state, 'ready')
    assert.equal(info.endpoint, 'http://127.0.0.1:4096')
    assert.equal(info.pid, process.pid)

    await assert.rejects(
      f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'terminal' }),
      /already has a server runtime owner.*PID/,
    )
  } finally {
    await owner?.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('simultaneous owner acquisition has exactly one winner', async () => {
  const f = await fixture()
  const outcomes = await Promise.allSettled([
    f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'server' }),
    f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'terminal' }),
  ])
  const winners = outcomes.filter(item => item.status === 'fulfilled')
  const losers = outcomes.filter(item => item.status === 'rejected')
  try {
    assert.equal(winners.length, 1)
    assert.equal(losers.length, 1)
    assert.match(String(losers[0].reason), /already has a (server|terminal) runtime owner/)
  } finally {
    for (const winner of winners) await winner.value.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('a separate Node process cannot acquire a workspace already owned by the parent process', async () => {
  const f = await fixture()
  let owner
  try {
    owner = await f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'server' })
    const script = `
      import { acquireDaemonOwner } from ${JSON.stringify(new URL('../dist/server/daemon-owner.js', import.meta.url).href)};
      try {
        await acquireDaemonOwner(${JSON.stringify(f.workspace)}, { stateRoot: ${JSON.stringify(f.stateRoot)}, mode: 'terminal' });
        process.exitCode = 2;
      } catch (error) {
        console.log(String(error.message));
      }
    `
    const { spawnSync } = await import('node:child_process')
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /already has a server runtime owner/)
  } finally {
    await owner?.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('daemon owner leases are independent across workspaces', async () => {
  const f = await fixture()
  let first
  let second
  try {
    const other = path.join(f.root, 'other-workspace')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(other, { recursive: true }))
    first = await f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'server' })
    second = await f.acquireDaemonOwner(other, { stateRoot: f.stateRoot, mode: 'terminal' })
    assert.notEqual(first.workspaceId, second.workspaceId)
  } finally {
    await second?.release()
    await first?.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('daemon owner recovers a lock whose recorded process identity is no longer alive', async () => {
  const f = await fixture()
  let owner
  try {
    const { createHash } = await import('node:crypto')
    const cwd = await import('node:fs/promises').then(({ realpath }) => realpath(f.workspace))
    const workspaceId = createHash('sha256').update(cwd).digest('hex').slice(0, 32)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(f.stateRoot, { recursive: true }))
    const lockFile = path.join(f.stateRoot, `${workspaceId}.lock`)
    await writeFile(lockFile, JSON.stringify({
      version: 1,
      id: 'stale-owner',
      token: 'stale-token',
      workspaceId,
      cwd,
      pid: 2_000_000_000,
      processStart: '1',
      mode: 'server',
      startedAt: Date.now() - 60_000,
    }))

    owner = await f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'terminal' })
    const current = JSON.parse(await readFile(lockFile, 'utf8'))
    assert.equal(current.id, owner.id)
    assert.notEqual(current.id, 'stale-owner')
  } finally {
    await owner?.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('daemon owner refuses a lock with a live PID unless the Linux process start identity proves PID reuse', async () => {
  const f = await fixture()
  let owner
  try {
    const { createHash } = await import('node:crypto')
    const cwd = await import('node:fs/promises').then(({ realpath }) => realpath(f.workspace))
    const workspaceId = createHash('sha256').update(cwd).digest('hex').slice(0, 32)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(f.stateRoot, { recursive: true }))
    const lockFile = path.join(f.stateRoot, `${workspaceId}.lock`)
    const record = {
      version: 1,
      id: 'old-process-instance',
      token: 'old-instance-token',
      workspaceId,
      cwd,
      pid: process.pid,
      processStart: 'definitely-not-the-current-start-time',
      mode: 'server',
      startedAt: Date.now() - 60_000,
    }
    await writeFile(lockFile, JSON.stringify(record))

    owner = await f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'terminal' })
    assert.equal(JSON.parse(await readFile(lockFile, 'utf8')).id, owner.id)
  } finally {
    await owner?.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('owner release does not delete a newer lease that replaced its lock token', async () => {
  const f = await fixture()
  let owner
  try {
    owner = await f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'server' })
    const lockFile = path.join(f.stateRoot, `${owner.workspaceId}.lock`)
    const replaced = JSON.parse(await readFile(lockFile, 'utf8'))
    replaced.id = 'successor-owner'
    replaced.token = 'successor-token'
    await writeFile(lockFile, JSON.stringify(replaced))

    await owner.release()
    owner = undefined
    assert.equal(JSON.parse(await readFile(lockFile, 'utf8')).id, 'successor-owner')
  } finally {
    await owner?.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('daemon state directory and owner files are private on POSIX', async () => {
  if (process.platform === 'win32') return
  const f = await fixture()
  let owner
  try {
    owner = await f.acquireDaemonOwner(f.workspace, { stateRoot: f.stateRoot, mode: 'server' })
    const directoryMode = (await stat(f.stateRoot)).mode & 0o777
    const lockMode = (await stat(path.join(f.stateRoot, `${owner.workspaceId}.lock`))).mode & 0o777
    const metadataMode = (await stat(path.join(f.stateRoot, `${owner.workspaceId}.json`))).mode & 0o777
    assert.equal(directoryMode, 0o700)
    assert.equal(lockMode, 0o600)
    assert.equal(metadataMode, 0o600)
  } finally {
    await owner?.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('startup recovery preserves live task child sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14f-task-recovery-'))
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(path.join(root, '.termagent', 'sessions'))
    const session = await store.create(root, 'worker-model')
    await store.appendPermissionAsked(session.id, {
      requestId: 'worker-permission', tool: 'write_file', action: 'edit', resources: ['worker.ts'], revision: 1,
    })
    await store.append(session.id, { type: 'turn', ts: Date.now(), data: {
      id: 'worker-turn', beforeSnapshot: 'before', started: Date.now(), beforeMessageCount: 1, status: 'started',
    } })

    const result = await store.recoverOrphanedRuntimeState(root, 'replacement-owner', new Set([session.id]))
    assert.equal(result.taskSessionsPreserved, 1)
    assert.equal((await store.getInteractionState(session.id, 'worker-permission')).status, 'pending')
    assert.equal((await store.load(session.id)).events.filter(event => event.type === 'turn').at(-1).data.status, 'started')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('startup recovery cancels orphaned interactions and marks unmatched turns interrupted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14f-recovery-'))
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(path.join(root, '.termagent', 'sessions'))
    const session = await store.create(root, 'test-model')
    await store.appendPermissionAsked(session.id, {
      requestId: 'permission-1', tool: 'write_file', action: 'edit', resources: ['example.txt'], revision: 1,
    })
    await store.appendQuestionAsked(session.id, {
      requestId: 'question-1', questions: [{ id: 'continue', question: 'Continue?' }], revision: 1,
    })
    await store.append(session.id, {
      type: 'turn', ts: Date.now(), data: {
        id: 'unfinished-turn', beforeSnapshot: 'before-snapshot', started: Date.now(), beforeMessageCount: 1, status: 'started',
      },
    })

    const result = await store.recoverOrphanedRuntimeState(root, 'new-daemon-owner')
    assert.deepEqual(result, { sessionsChecked: 1, taskSessionsPreserved: 0, permissionsCancelled: 1, questionsCancelled: 1, turnsInterrupted: 1 })
    assert.deepEqual(await store.pendingInteractions(session.id), [])
    const loaded = await store.load(session.id)
    const recoveredTurn = loaded.events.filter(event => event.type === 'turn').at(-1)
    assert.equal(recoveredTurn.data.status, 'interrupted')
    assert.deepEqual(recoveredTurn.data.recovery, { reason: 'daemon-restart', ownerId: 'new-daemon-owner' })
    const permission = await store.getInteractionState(session.id, 'permission-1')
    const question = await store.getInteractionState(session.id, 'question-1')
    assert.equal(permission.status, 'cancelled')
    assert.equal(permission.cancelReason, 'daemon-restart')
    assert.equal(question.status, 'cancelled')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
