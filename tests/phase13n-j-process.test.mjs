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
      command: `node -e ${JSON.stringify(`const {spawn}=require('child_process');const fs=require('fs');const p=spawn('sleep',['20'],{stdio:'ignore'});p.unref();fs.writeFileSync(${JSON.stringify(marker)},String(p.pid));`)}`,
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

test('13N-J-A intentional shell background syntax preserves the descendant after leader exit', async () => {
  const root = await temp()
  try {
    const { TaskManager, startManagedShell, hasShellBackgroundOperator } = await load()
    assert.equal(hasShellBackgroundOperator('sleep 1 &'), true)
    assert.equal(hasShellBackgroundOperator('sleep 1 && echo ok'), false)
    assert.equal(hasShellBackgroundOperator("printf '&'"), false)
    assert.equal(hasShellBackgroundOperator("printf \"&\""), false)

    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const marker = path.join(root, 'child.pid')
    const handle = await startManagedShell(manager, {
      shell: 'sh',
      command: `sleep 2 & echo $! > ${JSON.stringify(marker)}`,
      cwd: root,
      timeout: 5000,
      maxPreviewBytes: 1000,
      detached: true,
    })
    const result = await handle.result
    assert.equal(result.termination, 'completed')
    assert.equal(result.backgroundChildrenPreserved, true)
    const pid = Number((await readFile(marker, 'utf8')).trim())
    assert.ok(pid > 0)
    assert.equal(alive(pid), true)
    const events = await manager.history(handle.task.id)
    assert.ok(events.some(event => event.type === 'background_children_preserved'))
    try { process.kill(pid, 'SIGKILL') } catch {}
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('13N-J-A shell results surface an actionable EADDRINUSE diagnostic', async () => {
  const root = await temp()
  let server
  try {
    const { createServer } = await import('node:net')
    server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    process.env.TERMAGENT_TASK_ROOT = path.join(root, 'tasks')
    const { builtinTools } = await import('../dist/tools/builtin.js')
    const bash = builtinTools({ timeout: 5000, maxOutput: 2000 }).find(tool => tool.name === 'bash')
    assert.ok(bash, 'missing bash tool')
    const result = await bash.execute({
      command: `node -e 'require("net").createServer().listen(${port}, "127.0.0.1")'`,
      timeout: 1000,
    }, { sessionID: '13nj-eaddr', agent: 'build', cwd: root, abort: new AbortController().signal })
    assert.equal(result.metadata.shell.addressInUse, true)
    assert.match(result.output, /EADDRINUSE|already owns the requested address\/port/i)
    assert.match(result.output, /Do not launch another instance/i)
  } finally {
    server?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('13N-J-C real bash lifecycle keeps an intentionally backgrounded server alive and diagnoses a second launch', async () => {
  const root = await temp()
  let pid = 0
  try {
    const { createServer } = await import('node:net')
    const probe = createServer()
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', resolve)
    })
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))

    await writeFile(path.join(root, 'server.mjs'), `import http from 'node:http'\nconst port=Number(process.env.PORT)\nhttp.createServer((req,res)=>{if(req.url==='/health'){res.end('healthy\\n');return}res.statusCode=404;res.end('not-found\\n')}).listen(port,'127.0.0.1',()=>console.log('server-ready:'+port))\n`)

    process.env.TERMAGENT_TASK_ROOT = path.join(root, 'tasks')
    const { builtinTools } = await import('../dist/tools/builtin.js')
    const tools = builtinTools({ timeout: 5000, maxOutput: 2000 })
    const bash = tools.find(tool => tool.name === 'bash')
    assert.ok(bash, 'missing bash tool')
    const context = { sessionID: '13nj-real-bash', agent: 'build', cwd: root, abort: new AbortController().signal }

    const started = await bash.execute({
      command: `PORT=${port} node server.mjs > server.log 2>&1 & echo $! > server.pid; sleep 0.25; curl -fsS http://127.0.0.1:${port}/health`,
    }, context)
    assert.equal(started.metadata.shell.status, 'completed')
    assert.equal(started.metadata.shell.backgroundChildrenPreserved, true)
    assert.match(started.output, /healthy/) 
    pid = Number((await readFile(path.join(root, 'server.pid'), 'utf8')).trim())
    assert.ok(pid > 0)
    assert.equal(alive(pid), true)

    const reused = await bash.execute({ command: `curl -fsS http://127.0.0.1:${port}/health` }, context)
    assert.equal(reused.metadata.shell.status, 'completed')
    assert.match(reused.output, /healthy/)

    const duplicate = await bash.execute({ command: `PORT=${port} node server.mjs`, timeout: 1000 }, context)
    assert.equal(duplicate.metadata.shell.addressInUse, true)
    assert.match(duplicate.output, /EADDRINUSE|already owns the requested address\/port/i)
    assert.match(duplicate.output, /Do not launch another instance/i)
  } finally {
    if (pid > 0) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
})
