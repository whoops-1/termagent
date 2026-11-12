import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

function savedEnv() {
  return Object.fromEntries([
    'HOME', 'TERMAGENT_PROVIDER', 'TERMAGENT_BASE_URL', 'TERMAGENT_API_KEY',
    'TERMAGENT_MODEL', 'TERMAGENT_APPROVALS', 'TERMAGENT_TASK_ROOT', 'TERMAGENT_SERVER_TOKEN', 'TERMAGENT_PAIRING_CODE',
  ].map(name => [name, process.env[name]]))
}

function restoreEnv(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

async function runTerminalClient(script, cwd, env, input = '/quit\n') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 12_000)
  child.stdin.end(input)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function openTerminalClient(script, cwd, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  return {
    child,
    send: value => child.stdin.write(value),
    close: () => child.stdin.end(),
    output: () => ({ stdout, stderr }),
    exited,
  }
}


async function waitFor(fn, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await fn()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out waiting for condition; last value: ${JSON.stringify(value)}`)
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14f3-'))
  const workspace = path.join(root, 'workspace')
  const home = path.join(root, 'home')
  const previous = savedEnv()
  let server
  let modelServer
  try {
    await mkdir(path.join(workspace, '.termagent'), { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(path.join(workspace, '.termagent', 'config.json'), JSON.stringify({ approvals: 'ask', maxToolRounds: 5 }))
    process.env.HOME = home
    delete process.env.TERMAGENT_SERVER_TOKEN
    delete process.env.TERMAGENT_PAIRING_CODE
    process.env.TERMAGENT_PROVIDER = 'openai-compatible'
    process.env.TERMAGENT_API_KEY = 'phase14f3-test-key'
    process.env.TERMAGENT_MODEL = 'phase14f3-mock'
    process.env.TERMAGENT_APPROVALS = 'ask'
    process.env.TERMAGENT_TASK_ROOT = path.join(home, '.termagent', 'tasks')

    let requests = 0
    modelServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        requests += 1
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (options.question && requests === 1) {
          const call = {
            id: 'call_phase14f3_question',
            type: 'function',
            function: {
              name: 'question',
              arguments: JSON.stringify({ questions: [{ id: 'choice', question: 'Which option should I use?', options: [{ label: 'A' }, { label: 'B' }], multiple: false, custom: false }] }),
            },
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        } else {
          const text = options.question ? 'Question answer received.' : 'Shared daemon response.'
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        }
        res.end()
      })
    })
    await new Promise(resolve => modelServer.listen(0, resolve))
    process.env.TERMAGENT_BASE_URL = `http://127.0.0.1:${modelServer.address().port}/v1`

    const { serve } = await import('../dist/server/index.js')
    const { TermAgentClient } = await import('../dist/client/client.js')
    server = await serve(workspace, { host: '127.0.0.1', port: 0, requirePairing: Boolean(options.pairing) })
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const client = new TermAgentClient({ baseUrl, clientId: 'phase14f3-browser' })

    const cleanup = async () => {
      if (server) await server.termagent.shutdown().catch(() => undefined)
      if (modelServer) await new Promise(resolve => modelServer.close(resolve))
      restoreEnv(previous)
      await rm(root, { recursive: true, force: true })
    }
    return { root, workspace, home, server, client, baseUrl, cleanup, get modelRequests() { return requests } }
  } catch (error) {
    if (server) await server.termagent.shutdown().catch(() => undefined)
    if (modelServer) await new Promise(resolve => modelServer.close(resolve))
    restoreEnv(previous)
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

test('14F.3 terminal renderer replaces an incomplete streamed reply with durable assistant history', async () => {
  const { TerminalUI } = await import('../dist/cli/ui.js')
  const input = new EventEmitter()
  input.isTTY = false
  const output = new EventEmitter()
  output.columns = 80
  output.rows = 24
  output.write = () => true
  const ui = new TerminalUI({ title: 'daemon-client', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), input, output })
  ui.enter()
  try {
    ui.addUser('recover this reply')
    ui.startAssistant()
    ui.appendAssistant('partial response')
    ui.reconcileAssistantMessage('complete durable response')
    const assistant = ui.entries.find(entry => entry.kind === 'assistant')
    assert.equal(assistant.text, 'complete durable response')
  } finally {
    ui.leave()
  }
})

test('14F.3 daemon owns queued prompt execution and returns the same durable transcript to clients', async () => {
  const f = await fixture()
  try {
    const ownerBefore = await (await import('../dist/server/daemon-owner.js')).readDaemonOwner(f.workspace)
    const info = await f.client.info()
    const health = await f.client.health()
    assert.equal(info.cwd, f.workspace)
    assert.equal(health.daemon.id, ownerBefore.id)
    assert.equal(health.daemon.pid, ownerBefore.pid)
    assert.equal(health.daemon.mode, 'server')

    const session = await f.client.createSession(f.workspace, info.model)
    const accepted = await f.client.enqueue(session.id, 'Answer from the shared daemon', {
      commandId: 'phase14f3-shared-queue', mode: 'plan', autonomous: false,
    })
    assert.equal(accepted.receipt.status, 'accepted')
    assert.equal(accepted.result.metadata.mode, 'plan')

    const queue = await waitFor(() => f.client.getQueue(session.id, false), items => items[0]?.status === 'completed')
    assert.equal(queue[0].status, 'completed')

    const entry = new URL('../dist/cli/repl.js', import.meta.url).href
    const script = `import { start } from ${JSON.stringify(entry)}; await start(${JSON.stringify(f.workspace)});`
    const terminal = await runTerminalClient(script, f.workspace, process.env, 'Prompt submitted from the terminal\n/quit\n')
    assert.equal(terminal.code, 0, terminal.stderr || terminal.stdout)
    assert.match(terminal.stdout, /Queued prompt/)
    const bothCompleted = await waitFor(
      () => f.client.getQueue(session.id, false),
      items => items.length === 2 && items.every(item => item.status === 'completed'),
    )
    assert.equal(bothCompleted.length, 2)
    const history = await f.client.getHistory(session.id)
    assert.deepEqual(history.messages.map(message => [message.role, message.content]), [
      ['user', 'Answer from the shared daemon'],
      ['assistant', 'Shared daemon response.'],
      ['user', 'Prompt submitted from the terminal'],
      ['assistant', 'Shared daemon response.'],
    ])
    const eventPage = await f.client.getEvents(session.id, 0)
    const sequences = eventPage.events.map(event => event.sequence)
    assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]), 'durable event sequence must remain strictly increasing while the queue worker starts')
    const ownerAfter = await (await import('../dist/server/daemon-owner.js')).readDaemonOwner(f.workspace)
    assert.equal(ownerAfter.id, ownerBefore.id)
    assert.equal(ownerAfter.mode, 'server')
  } finally {
    await f.cleanup()
  }
})

test('14F.3 daemon queue worker waits for a question resolved by a second client', async () => {
  const f = await fixture({ question: true })
  try {
    const session = await f.client.createSession(f.workspace, 'phase14f3-mock')
    const accepted = await f.client.enqueue(session.id, 'Ask me to choose an option', { commandId: 'phase14f3-question-queue' })
    assert.equal(accepted.receipt.status, 'accepted')

    const pending = await waitFor(() => f.client.listQuestions(session.id), items => items.some(item => item.status === 'pending'))
    const request = pending.find(item => item.status === 'pending')
    assert.ok(request)
    assert.equal(request.questions[0].question, 'Which option should I use?')
    const answered = await f.client.answerQuestion(session.id, request.requestId, [['B']], { commandId: 'phase14f3-question-answer' })
    assert.equal(answered.receipt.status, 'accepted')

    await waitFor(() => f.client.getQueue(session.id, false), items => items[0]?.status === 'completed')
    const history = await f.client.getHistory(session.id)
    assert.ok(history.messages.some(message => message.role === 'assistant' && message.content === 'Question answer received.'))
    const eventPage = await f.client.getEvents(session.id, 0)
    const resolution = eventPage.events.find(event => event.kind === 'session.question.resolved' && event.payload?.requestId === request.requestId)
    assert.ok(resolution)
    assert.equal(resolution.kind, 'session.question.resolved')
    assert.deepEqual(resolution.payload.answers, [['B']])
  } finally {
    await f.cleanup()
  }
})

test('14F.3 terminal invocation attaches to an existing local server instead of acquiring a second runtime', async () => {
  const f = await fixture()
  try {
    const { readDaemonOwner } = await import('../dist/server/daemon-owner.js')
    const owner = await readDaemonOwner(f.workspace)
    const script = `import { start } from ${JSON.stringify(new URL('../dist/cli/repl.js', import.meta.url).href)}; await start(${JSON.stringify(f.workspace)});`
    const child = await runTerminalClient(script, f.workspace, process.env)
    assert.equal(child.code, 0, child.stderr || child.stdout)
    assert.match(child.stdout, /Attached to the existing TermAgent daemon/)
    const after = await readDaemonOwner(f.workspace)
    assert.equal(after.id, owner.id)
    assert.equal(after.mode, 'server')
    assert.equal(after.pid, owner.pid)
  } finally {
    await f.cleanup()
  }
})

test('14F.3 terminal pairs once, persists an owner-only workspace credential, and reuses it', async () => {
  const f = await fixture({ pairing: true })
  try {
    const entry = new URL('../dist/cli/repl.js', import.meta.url).href
    const script = `import { start } from ${JSON.stringify(entry)}; await start(${JSON.stringify(f.workspace)});`
    const firstEnv = { ...process.env, TERMAGENT_PAIRING_CODE: f.server.termagent.pairingCode }
    const first = await runTerminalClient(script, f.workspace, firstEnv)
    assert.equal(first.code, 0, first.stderr || first.stdout)
    assert.match(first.stderr, /Terminal paired successfully/)
    assert.match(first.stdout, /Attached to the existing TermAgent daemon/)

    const deviceDirectory = path.join(f.home, '.termagent', 'devices')
    const files = await (await import('node:fs/promises')).readdir(deviceDirectory)
    assert.equal(files.length, 1)
    const credentialPath = path.join(deviceDirectory, files[0])
    const credential = JSON.parse(await (await import('node:fs/promises')).readFile(credentialPath, 'utf8'))
    assert.equal(credential.workspaceId, (await (await import('../dist/server/daemon-owner.js')).readDaemonOwner(f.workspace)).workspaceId)
    assert.match(credential.token, /^ta_dev_/)
    if (process.platform !== 'win32') {
      const stat = await (await import('node:fs/promises')).stat(credentialPath)
      assert.equal(stat.mode & 0o777, 0o600)
    }

    const secondEnv = { ...process.env }
    delete secondEnv.TERMAGENT_PAIRING_CODE
    const second = await runTerminalClient(script, f.workspace, secondEnv)
    assert.equal(second.code, 0, second.stderr || second.stdout)
    assert.match(second.stdout, /Attached to the existing TermAgent daemon/)

    const revoked = await runTerminalClient(script, f.workspace, secondEnv, '/device revoke\n')
    assert.equal(revoked.code, 0, revoked.stderr || revoked.stdout)
    assert.match(revoked.stdout, /This terminal device has been revoked/)
    assert.deepEqual(await (await import('node:fs/promises')).readdir(deviceDirectory), [])
  } finally {
    await f.cleanup()
  }
})

test('14F.3 terminal auto-attachment refuses a non-loopback server endpoint', async () => {
  const { startDaemonClient } = await import('../dist/cli/daemon-client.js')
  await assert.rejects(startDaemonClient('/workspace', undefined, {
    id: 'daemon-id', workspaceId: 'workspace-id', pid: process.pid,
    mode: 'server', state: 'ready', startedAt: Date.now(), heartbeatAt: Date.now(),
    endpoint: 'https://remote.example.test',
  }), /non-loopback URL/)
})


test('14F.4 terminal transcript hydrates tool calls by call ID and reconciles concurrent same-name tools independently', async () => {
  const { TerminalUI } = await import('../dist/cli/ui.js')
  const input = new EventEmitter()
  input.isTTY = false
  const output = new EventEmitter()
  output.columns = 90
  output.rows = 28
  output.write = () => true
  const ui = new TerminalUI({ title: 'phase14f4', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), input, output })
  ui.enter()
  try {
    ui.hydrate([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tool-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'tool-b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
      ] },
      { role: 'tool', tool_call_id: 'tool-b', name: 'read_file', content: 'contents of b' },
      { role: 'tool', tool_call_id: 'tool-a', name: 'read_file', content: 'contents of a' },
    ])
    let tools = ui.entries.filter(entry => entry.kind === 'tool')
    assert.equal(tools.length, 2)
    assert.deepEqual(tools.map(entry => [entry.callId, entry.output]), [
      ['tool-a', 'contents of a'], ['tool-b', 'contents of b'],
    ])

    ui.updateToolLifecycle({ callId: 'live-a', name: 'read_file', state: 'pending', parsedArguments: { path: 'c.txt' } })
    ui.updateToolLifecycle({ callId: 'live-b', name: 'read_file', state: 'pending', parsedArguments: { path: 'd.txt' } })
    ui.updateToolLifecycle({ callId: 'live-a', name: 'read_file', state: 'running', parsedArguments: { path: 'c.txt' } })
    ui.updateToolLifecycle({ callId: 'live-b', name: 'read_file', state: 'running', parsedArguments: { path: 'd.txt' } })
    ui.endTool('read_file', 'result d', undefined, 'live-b')
    ui.endTool('read_file', 'result c', undefined, 'live-a')
    tools = ui.entries.filter(entry => entry.kind === 'tool')
    assert.equal(tools.length, 4, 'call ID updates must not create duplicate entries')
    assert.equal(tools.find(entry => entry.callId === 'live-a').output, 'result c')
    assert.equal(tools.find(entry => entry.callId === 'live-b').output, 'result d')
    assert.equal(tools.filter(entry => entry.running || entry.waiting).length, 0)
  } finally {
    ui.leave()
  }
})

test('14F.4 non-interactive terminal remains a passive client and does not cancel browser-owned questions', async () => {
  const f = await fixture({ question: true })
  let terminal
  try {
    const session = await f.client.createSession(f.workspace, 'phase14f4-mock')
    const entry = new URL('../dist/cli/repl.js', import.meta.url).href
    const script = `import { start } from ${JSON.stringify(entry)}; await start(${JSON.stringify(f.workspace)});`
    terminal = openTerminalClient(script, f.workspace, process.env)

    const accepted = await f.client.enqueue(session.id, 'Ask a question that the browser will answer', { commandId: 'phase14f4-passive-terminal' })
    assert.equal(accepted.receipt.status, 'accepted')
    const questions = await waitFor(() => f.client.listQuestions(session.id), items => items.some(item => item.status === 'pending'))
    const request = questions.find(item => item.status === 'pending')
    assert.ok(request)
    await new Promise(resolve => setTimeout(resolve, 180))
    const stillPending = await f.client.listQuestions(session.id)
    assert.ok(stillPending.some(item => item.requestId === request.requestId && item.status === 'pending'), `passive terminal must not auto-cancel the interaction: ${JSON.stringify({ stillPending, terminal: terminal.output(), queue: await f.client.getQueue(session.id, false) })}`)

    const resolved = await f.client.answerQuestion(session.id, request.requestId, [['B']], { commandId: 'phase14f4-browser-answer' })
    assert.equal(resolved.receipt.status, 'accepted')
    const queue = await waitFor(() => f.client.getQueue(session.id, false), items => items[0]?.status === 'completed')
    assert.equal(queue[0].status, 'completed')

    terminal.send('/quit\n')
    terminal.close()
    assert.equal(await terminal.exited, 0, terminal.output().stderr || terminal.output().stdout)
  } finally {
    if (terminal) { terminal.child.kill('SIGKILL'); await terminal.exited.catch(() => undefined) }
    await f.cleanup()
  }
})

test('14F.4 terminal exposes daemon-owned diff, task, checkpoint and branch state', async () => {
  const f = await fixture()
  try {
    const session = await f.client.createSession(f.workspace, 'phase14f4-mock')
    const checkpoint = await f.client.createCheckpoint(session.id, 'before-branch')
    const checkpointRecord = checkpoint.result ?? checkpoint
    assert.equal(typeof checkpointRecord.id, 'string')

    const entry = new URL('../dist/cli/repl.js', import.meta.url).href
    const script = `import { start } from ${JSON.stringify(entry)}; await start(${JSON.stringify(f.workspace)});`
    const terminal = await runTerminalClient(script, f.workspace, process.env, `/checkpoints\n/tasks\n/diff\n/branch ${checkpointRecord.id}\n/quit\n`)
    assert.equal(terminal.code, 0, terminal.stderr || terminal.stdout)
    assert.match(terminal.stdout, /before-branch/)
    assert.match(terminal.stdout, /No workspace tasks\./)
    assert.match(terminal.stdout, /No changes\./)
    assert.match(terminal.stdout, /Switched to session/)
    const sessions = await f.client.listSessions()
    assert.ok(sessions.sessions.some(item => item.parentId === session.id && item.parentCheckpointId === checkpointRecord.id))
  } finally {
    await f.cleanup()
  }
})
