import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function savedEnv() {
  return Object.fromEntries([
    'HOME', 'TERMAGENT_PROVIDER', 'TERMAGENT_BASE_URL', 'TERMAGENT_API_KEY',
    'TERMAGENT_MODEL', 'TERMAGENT_APPROVALS', 'TERMAGENT_TASK_ROOT', 'TERMAGENT_SERVER_TOKEN',
  ].map(name => [name, process.env[name]]))
}

function restoreEnv(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

async function runTerminalClient(script, cwd, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 12_000)
  child.stdin.end('/quit\n')
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


test('server lifecycle publishes daemon health, rejects a duplicate owner, and releases on shutdown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14f-server-'))
  const workspace = path.join(root, 'workspace')
  const home = path.join(root, 'home')
  const previous = savedEnv()
  let server
  try {
    await mkdir(path.join(workspace, '.termagent'), { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(path.join(workspace, '.termagent', 'config.json'), JSON.stringify({ approvals: 'ask', maxToolRounds: 4 }))
    process.env.HOME = home
    process.env.TERMAGENT_PROVIDER = 'openai-compatible'
    process.env.TERMAGENT_BASE_URL = 'http://127.0.0.1:1/v1'
    process.env.TERMAGENT_API_KEY = 'test'
    process.env.TERMAGENT_MODEL = 'phase14f-test'
    process.env.TERMAGENT_APPROVALS = 'ask'
    process.env.TERMAGENT_TASK_ROOT = path.join(home, '.termagent', 'tasks')
    process.env.TERMAGENT_SERVER_TOKEN = 'phase14f-test-token'

    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(path.join(home, '.termagent', 'sessions'))
    const session = await store.create(workspace, 'phase14f-test')
    await store.appendPermissionAsked(session.id, {
      requestId: 'orphan-permission', tool: 'write_file', action: 'edit', resources: ['main.ts'], revision: 1,
    })
    await store.appendQuestionAsked(session.id, {
      requestId: 'orphan-question', questions: [{ id: 'continue', question: 'Continue?' }], revision: 1,
    })
    await store.append(session.id, {
      type: 'turn', ts: Date.now(), data: {
        id: 'orphan-turn', beforeSnapshot: 'before', started: Date.now(), beforeMessageCount: 1, status: 'started',
      },
    })

    const { serve } = await import('../dist/server/index.js')
    const { readDaemonOwner } = await import('../dist/server/daemon-owner.js')
    server = await serve(workspace, { host: '127.0.0.1', port: 0, token: 'phase14f-test-token' })
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const response = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer phase14f-test-token` },
    })
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.daemon.mode, 'server')
    assert.equal(health.daemon.state, 'ready')
    assert.equal(health.daemon.endpoint, baseUrl)
    assert.equal((await store.getInteractionState(session.id, 'orphan-permission')).cancelReason, 'daemon-restart')
    assert.equal((await store.getInteractionState(session.id, 'orphan-question')).status, 'cancelled')
    const recoveredTurn = (await store.load(session.id)).events.filter(event => event.type === 'turn').at(-1)
    assert.equal(recoveredTurn.data.status, 'interrupted')

    await assert.rejects(
      serve(workspace, { host: '127.0.0.1', port: 0, token: 'another-token' }),
      /already has a server runtime owner/,
    )
    const entry = new URL('../dist/cli/repl.js', import.meta.url).href
    const script = `import { start } from ${JSON.stringify(entry)}; await start(${JSON.stringify(workspace)});`
    const terminal = await runTerminalClient(script, workspace, process.env)
    assert.equal(terminal.code, 0, terminal.stderr || terminal.stdout)
    assert.match(terminal.stdout, /Attached to the existing TermAgent daemon/)
    const sharedOwner = await readDaemonOwner(workspace)
    assert.equal(sharedOwner.mode, 'server')
    assert.equal(sharedOwner.id, health.daemon.id)

    await server.termagent.shutdown()
    server = undefined
    assert.equal(await readDaemonOwner(workspace), undefined)

    const replacement = await serve(workspace, { host: '127.0.0.1', port: 0, token: 'phase14f-test-token' })
    await replacement.termagent.shutdown()
  } finally {
    if (server) await server.termagent.shutdown().catch(() => undefined)
    restoreEnv(previous)
    await rm(root, { recursive: true, force: true })
  }
})
