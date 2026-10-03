import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const temp = async () => mkdtemp(path.join(os.tmpdir(), 'termagent-13nj-process-'))

async function load() {
  const { TaskManager } = await import('../dist/tasks/manager.js')
  const shell = await import('../dist/tasks/shell-command.js')
  const lifecycle = await import('../dist/util/child-process.js')
  return { TaskManager, ...shell, ...lifecycle }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitDead(pid, timeout = 2500) {
  const started = Date.now()
  while (alive(pid) && Date.now() - started < timeout) await new Promise(r => setTimeout(r, 25))
  return !alive(pid)
}

test('13N-J-A kills descendants left behind by a completed foreground shell', async () => {
  const root = await temp()
  try {
    const { TaskManager, startManagedShell } = await load()
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const marker = path.join(root, 'child.pid')
    const handle = await startManagedShell(manager, {
      shell: 'sh',
      command: `sleep 20 & echo $! > ${JSON.stringify(marker)}; exit 0`,
      cwd: root,
      timeout: 5000,
      maxPreviewBytes: 1000,
      detached: true,
    })
    const result = await handle.result
    assert.equal(result.termination, 'completed')
    const pid = Number((await readFile(marker, 'utf8')).trim())
    assert.ok(pid > 0)
    assert.equal(await waitDead(pid), true)
    const events = await manager.history(handle.task.id)
    assert.ok(events.some(event => event.type === 'descendant_cleanup'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('13N-J-A preserves an explicitly backgrounded managed process until cancelled', async () => {
  const root = await temp()
  try {
    const { TaskManager, startManagedShell } = await load()
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const handle = await startManagedShell(manager, {
      shell: 'sh',
      command: 'sleep 20',
      cwd: root,
      timeout: 5000,
      maxPreviewBytes: 1000,
      detached: true,
      background: true,
    })
    await handle.background()
    await new Promise(r => setTimeout(r, 50))
    const task = await manager.get(handle.task.id)
    assert.equal(task.status, 'running')
    assert.ok(task.pid > 0)
    assert.equal(alive(task.pid), true)
    await manager.cancel(task.id)
    assert.equal(await waitDead(task.pid), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('13N-J-A timeout escalates through the entire process group', async () => {
  const root = await temp()
  try {
    const { TaskManager, startManagedShell } = await load()
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const marker = path.join(root, 'child.pid')
    const handle = await startManagedShell(manager, {
      shell: 'sh',
      command: `sleep 20 & echo $! > ${JSON.stringify(marker)}; wait`,
      cwd: root,
      timeout: 120,
      maxPreviewBytes: 1000,
      detached: true,
    })
    const result = await handle.result
    assert.equal(result.termination, 'timeout')
    const pid = Number((await readFile(marker, 'utf8')).trim())
    assert.ok(pid > 0)
    assert.equal(await waitDead(pid), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('13N-J-A bounded shell previews respect the requested UTF-8 byte budget', async () => {
  const root = await temp()
  try {
    const { TaskManager, startManagedShell } = await load()
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const handle = await startManagedShell(manager, {
      shell: 'sh',
      command: `printf '%s' ${JSON.stringify('界'.repeat(1000))}`,
      cwd: root,
      timeout: 5000,
      maxPreviewBytes: 100,
      detached: true,
    })
    const result = await handle.result
    assert.equal(result.outputTruncated, true)
    assert.ok(Buffer.byteLength(result.outputPreview, 'utf8') <= 100, `preview bytes=${Buffer.byteLength(result.outputPreview, 'utf8')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('13N-J-A stdin completion is bounded and normal managed stdin still works', async () => {
  const root = await temp()
  try {
    const { TaskManager, startManagedShell } = await load()
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const handle = await startManagedShell(manager, {
      shell: 'sh',
      command: 'read line; printf "got:%s" "$line"',
      cwd: root,
      timeout: 5000,
      maxPreviewBytes: 1000,
      detached: true,
      stdin: 'mobile-input',
      stdinTimeoutMs: 1000,
    })
    const result = await handle.result
    assert.equal(result.termination, 'completed')
    assert.match(result.outputPreview, /got:mobile-input/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('13N-J-A stdin timeout reports an indeterminate delivery error without hanging the caller', async () => {
  const { writeChildStdinWithTimeout } = await load()
  const fake = {
    stdin: {
      write(_payload, _encoding, _callback) {
        // Deliberately never acknowledges the write.
      },
    },
  }
  const started = Date.now()
  await assert.rejects(
    () => writeChildStdinWithTimeout(fake, 'data', { timeoutMs: 40 }),
    /timed out after 40ms.*partially delivered/i,
  )
  assert.ok(Date.now() - started < 500)
})

test('13N-J-A process group probing treats a missing group as settled', async () => {
  const { processGroupAlive, terminateProcessGroup } = await load()
  assert.equal(processGroupAlive(999_999), false)
  const result = await terminateProcessGroup(999_999, { graceMs: 50 })
  assert.deepEqual(result, { signalled: false, forced: false, remaining: false })
})

test('13N-J-A cancellation refuses to signal a mismatched stored process identity', async () => {
  const root = await temp()
  try {
    const { TaskManager } = await load()
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const task = await manager.createShell('printf never', root)
    await manager.update(task.id, {
      pid: process.pid,
      processIdentity: { command: 'definitely-not-this-process', cwd: root, startTime: 'wrong-start' },
    })
    const result = await manager.cancel(task.id)
    assert.equal(result.status, 'cancelled')
    assert.match(result.output, /did not signal the stored PID/i)
    assert.equal(alive(process.pid), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
