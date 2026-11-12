import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const ENV_KEYS = [
  'HOME', 'TERMAGENT_PROVIDER', 'TERMAGENT_BASE_URL', 'TERMAGENT_API_KEY',
  'TERMAGENT_MODEL', 'TERMAGENT_APPROVALS', 'TERMAGENT_TASK_ROOT',
  'TERMAGENT_SESSION_ROOT', 'TERMAGENT_SERVER_TOKEN', 'TERMAGENT_PAIRING_CODE',
]
function saveEnv() { return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) }
function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function fixture() {
  const previous = saveEnv()
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14f5-workspace-'))
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14f5-home-'))
  let runtime
  let server
  try {
    await mkdir(path.join(root, '.termagent'), { recursive: true })
    await writeFile(path.join(root, '.termagent', 'config.json'), JSON.stringify({ approvals: 'auto' }))
    process.env.HOME = home
    process.env.TERMAGENT_PROVIDER = 'openai-compatible'
    process.env.TERMAGENT_BASE_URL = 'http://127.0.0.1:9/v1'
    process.env.TERMAGENT_API_KEY = 'phase14f5-runtime-provider-secret'
    process.env.TERMAGENT_MODEL = 'phase14f5-mock'
    process.env.TERMAGENT_APPROVALS = 'auto'
    process.env.TERMAGENT_TASK_ROOT = path.join(home, '.termagent', 'tasks')
    process.env.TERMAGENT_SESSION_ROOT = path.join(home, '.termagent', 'sessions')
    delete process.env.TERMAGENT_SERVER_TOKEN
    delete process.env.TERMAGENT_PAIRING_CODE

    const { createRuntime } = await import('../dist/server/runtime.js')
    const { startServer } = await import('../dist/server/http.js')
    const { TermAgentClient } = await import('../dist/client/client.js')
    runtime = await createRuntime(root)
    server = await startServer(runtime, { host: '127.0.0.1', port: 0, token: 'phase14f5-http-token' })
    const client = new TermAgentClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      token: 'phase14f5-http-token',
      clientId: 'phase14f5-test-client',
    })
    return {
      root, home, runtime, server, client, baseUrl: `http://127.0.0.1:${server.address().port}`,
      async cleanup() {
        await new Promise(resolve => server.close(resolve))
        await runtime.close()
        restoreEnv(previous)
        await rm(root, { recursive: true, force: true })
        await rm(home, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (server) await new Promise(resolve => server.close(resolve))
    if (runtime) await runtime.close()
    restoreEnv(previous)
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

test('14F.5 projects the existing TaskManager parent/child graph without exposing worker credentials', async () => {
  const { buildSubagentWorkspace, projectTask } = await import('../dist/tasks/subagents.js')
  const base = {
    cwd: '/workspace', started: 10, updated: 20, status: 'running', output: 'secret process output',
    provider: { provider: 'openai-compatible', model: 'test', apiKey: 'provider-secret' },
    workerToken: 'worker-token-secret', permissionRules: [{ tool: 'bash', decision: 'always' }],
    processIdentity: { command: 'node worker.js', cwd: '/workspace' }, scopePaths: ['src'],
    kind: 'agent', background: false, coordinated: false,
  }
  const root = { ...base, id: 'agent-root', prompt: 'Plan the feature', sessionId: 'root-session', parentSessionId: 'root-session', childSessionId: 'child-session', specialistRole: 'planner', delegationDepth: 0 }
  const nested = { ...base, id: 'agent-child', prompt: 'Implement the parser', sessionId: 'child-session', parentSessionId: 'child-session', parentTaskId: 'agent-root', specialistRole: 'coder', delegationDepth: 1, status: 'exited' }
  const unrelated = { ...base, id: 'agent-other', prompt: 'Do unrelated work', sessionId: 'other-session', parentSessionId: 'other-session' }
  const sibling = { ...base, id: 'agent-sibling', prompt: 'A separate direct child', sessionId: 'root-session', parentSessionId: 'root-session' }
  const shell = { ...base, id: 'shell-other', kind: 'shell', parentSessionId: 'root-session' }

  const projected = projectTask(root)
  assert.equal(projected.id, 'agent-root')
  assert.equal(projected.outputBytes, Buffer.byteLength('secret process output'))
  for (const field of ['provider', 'workerToken', 'permissionRules', 'processIdentity', 'output']) {
    assert.equal(field in projected, false, `${field} must not cross the client boundary`)
  }
  assert.equal(JSON.stringify(projected).includes('provider-secret'), false)
  assert.equal(JSON.stringify(projected).includes('worker-token-secret'), false)

  const workspace = buildSubagentWorkspace([root, nested, unrelated, sibling, shell], 'root-session')
  assert.deepEqual(workspace.counts, { total: 3, queued: 0, running: 2, completed: 1, failed: 0, cancelled: 0 })
  assert.equal(workspace.agents.length, 2)
  const rootNode = workspace.agents.find(node => node.task.id === 'agent-root')
  assert.equal(rootNode.depth, 0)
  assert.equal(rootNode.children[0].task.id, 'agent-child')
  assert.equal(rootNode.children[0].depth, 1)
  assert.equal(workspace.agents.find(node => node.task.id === 'agent-sibling').children.length, 0, 'queued siblings sharing the parent session must not be mistaken for child sessions')
})

test('14F.5 HTTP/API exposes a session-scoped hierarchical subagent workspace and sanitized task summaries', async () => {
  const f = await fixture()
  try {
    const parent = await f.client.createSession(f.root, 'phase14f5-mock')
    const other = await f.client.createSession(f.root, 'phase14f5-mock')
    const provider = { provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'provider-secret-never-return-this' }
    const rootTask = await f.runtime.tasks.createAgent('Coordinate implementation', f.root, provider, ['src/planning'], parent.id, { specialistRole: 'planner' })
    const childSession = await f.runtime.store.create(f.root, 'phase14f5-mock', { id: parent.id, at: Date.now() })
    for (let index = 0; index < 18; index++) {
      await f.runtime.store.append(childSession.id, { type: 'message', ts: Date.now() + index, data: { role: index % 2 ? 'assistant' : 'user', content: `child transcript message ${index}` } })
    }
    const childTail = await f.client.getMessages(childSession.id, 0, 5, true)
    assert.equal(childTail.offset, 13)
    assert.equal(childTail.total, 18)
    assert.equal(childTail.messages.length, 5)
    assert.equal(childTail.messages[4].content, 'child transcript message 17')
    await f.runtime.tasks.update(rootTask.id, {
      sessionId: childSession.id,
      childSessionId: childSession.id,
      activity: { kind: 'tool', label: 'Using read', detail: 'path: src/index.ts', at: Date.now(), callId: 'call-1', outcome: 'running' },
      output: 'private output snippet',
      workerToken: 'worker-token-never-return-this',
      permissionRules: [{ tool: 'bash', decision: 'deny' }],
      processIdentity: { command: 'node child.js', cwd: f.root },
    })
    const childTask = await f.runtime.tasks.createAgent('Implement child module', f.root, provider, ['src/implementation'], childSession.id, {
      specialistRole: 'coder', parentTaskId: rootTask.id, delegationDepth: 1,
    })
    await f.runtime.tasks.update(childTask.id, { status: 'exited', ended: Date.now(), result: 'Implemented child module.' })
    await f.runtime.tasks.createAgent('Unrelated sibling session', f.root, provider, ['docs'], other.id, { specialistRole: 'researcher' })
    await f.runtime.tasks.createShell('echo shell', f.root, parent.id)

    const workspace = await f.client.listSubagents(parent.id)
    assert.equal(workspace.sessionId, parent.id)
    assert.equal(workspace.counts.total, 2)
    assert.equal(workspace.agents.length, 1)
    assert.equal(workspace.agents[0].task.specialistRole, 'planner')
    assert.equal(workspace.agents[0].children[0].task.specialistRole, 'coder')
    assert.equal(workspace.agents[0].children[0].task.parentTaskId, rootTask.id)
    assert.equal(workspace.agents[0].task.activity.label, 'Using read')
    assert.equal('detail' in workspace.agents[0].task.activity, false, 'activity projection must omit potentially sensitive tool arguments')

    const publicTask = await f.client.getTask(rootTask.id)
    assert.equal(publicTask.id, rootTask.id)
    for (let index = 0; index < 6; index++) await f.runtime.tasks.event(rootTask.id, `fixture.${index}`, { index })
    const boundedEvents = await f.client.getTaskEvents(rootTask.id, 2)
    assert.deepEqual(boundedEvents.map(item => item.type), ['fixture.4', 'fixture.5'], 'event polling can request a bounded tail')
    assert.ok((await f.client.getTaskEvents(rootTask.id)).length >= boundedEvents.length, 'unbounded callers remain backward compatible')

    // Exercise the actual task-event SSE route and SDK iterator, not merely
    // the presence of a stream method in the source tree.
    const beforeStream = await f.runtime.tasks.history(rootTask.id)
    const afterSequence = beforeStream.at(-1)?.seq || 0
    const streamAbort = new AbortController()
    let readyResolve
    let eventsResolve
    const streamReady = new Promise(resolve => { readyResolve = resolve })
    const twoEvents = new Promise(resolve => { eventsResolve = resolve })
    const streamed = []
    const consume = (async () => {
      for await (const frame of f.client.streamTaskEvents(rootTask.id, afterSequence, {
        signal: streamAbort.signal, initialRetryDelayMs: 10, maxRetryDelayMs: 50,
      })) {
        if (frame.event === 'ready') readyResolve()
        if (frame.event === 'event' && frame.data && typeof frame.data === 'object') {
          streamed.push(frame.data)
          if (streamed.length >= 2) {
            eventsResolve()
            break
          }
        }
      }
    })()
    try {
      await Promise.race([streamReady, new Promise((_, reject) => setTimeout(() => reject(new Error('task event SSE did not become ready')), 2500))])
      await f.runtime.tasks.event(rootTask.id, 'stream.fixture.one', { secret: 'must be stripped' })
      await f.runtime.tasks.event(rootTask.id, 'stream.fixture.two', { safe: true })
      await Promise.race([twoEvents, new Promise((_, reject) => setTimeout(() => reject(new Error('task event SSE did not deliver durable events')), 2500))])
    } finally {
      streamAbort.abort()
      await consume
    }
    assert.deepEqual(streamed.map(item => item.type), ['stream.fixture.one', 'stream.fixture.two'])
    assert.equal(JSON.stringify(streamed).includes('must be stripped'), false, 'SSE uses the same privacy projection as the history endpoint')
    assert.equal(publicTask.outputBytes > 0, true)
    for (const field of ['provider', 'workerToken', 'permissionRules', 'processIdentity', 'output']) {
      assert.equal(field in publicTask, false, `${field} must not be exposed by GET task`)
    }
    const raw = JSON.stringify({ workspace, publicTask })
    assert.equal(raw.includes('provider-secret-never-return-this'), false)
    assert.equal(raw.includes('worker-token-never-return-this'), false)
    assert.equal(raw.includes('private output snippet'), false)
    await f.client.sendTask(rootTask.id, 'Check one more implementation edge case')
    const withInstruction = await f.runtime.tasks.get(rootTask.id)
    assert.equal(withInstruction.pendingPrompts.length, 1, 'live follow-up must enter the existing child-task queue')
    const safeHistory = await f.client.getTaskEvents(rootTask.id)
    assert.equal(JSON.stringify(safeHistory).includes('private output snippet'), false, 'legacy state-event output tails must never be forwarded')
    assert.equal(JSON.stringify(safeHistory).includes('Check one more implementation edge case'), false, 'queued instruction text is not duplicated into event metadata')
    assert.equal(safeHistory.some(item => item.type === 'message_queued' && item.data.queued === true), true)
    await f.client.cancelTask(rootTask.id)
    assert.equal((await f.runtime.tasks.get(rootTask.id)).status, 'cancelled')
    await f.client.resumeTask(childTask.id, 'Continue from the saved child session and verify the tests')
    const resumed = await f.runtime.tasks.get(childTask.id)
    assert.equal(resumed.status, 'queued')
    assert.equal(resumed.prompt, 'Continue from the saved child session and verify the tests')

    const foreignScope = await f.client.listSubagents(other.id)
    assert.equal(foreignScope.counts.total, 1)
    const response = await fetch(`${f.baseUrl}/api/v1/sessions/${encodeURIComponent(parent.id)}/subagents`, {
      headers: { authorization: 'Bearer phase14f5-http-token' },
    })
    assert.equal(response.status, 200)
  } finally {
    await f.cleanup()
  }
})


test('14F.5 real child worker persists turn lifecycle, output progress and usage onto its subagent record', async () => {
  const f = await fixture()
  const modelServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Child agent completed the requested analysis.' }, finish_reason: null }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  try {
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const parent = await f.client.createSession(f.root, 'phase14f5-mock')
    // The worker no longer trusts raw api keys in task JSON: the fixture must
    // persist a task credential and hand createAgent a secret-free snapshot
    // that references it, exactly like the parent-side builders do.
    const { newTaskCredentialRef, saveTaskProviderCredential } = await import('../dist/tasks/task-credentials.js')
    const credentialRef = newTaskCredentialRef()
    const route = { provider: 'openai-compatible', model: 'phase14f5-worker', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1` }
    await saveTaskProviderCredential(f.runtime.tasks.taskRoot(), credentialRef, route, 'worker-fixture-key')
    const task = await f.runtime.tasks.createAgent(
      'Summarize the repository structure', f.root,
      { provider: route.provider, model: route.model, baseUrl: route.baseUrl, credentialRef },
      ['.'], parent.id, { specialistRole: 'general' },
    )
    const { runTaskWorker } = await import('../dist/tasks/worker.js')
    await runTaskWorker(task.id, f.runtime.tasks)
    const final = await f.runtime.tasks.get(task.id)
    const events = await f.runtime.tasks.history(task.id)
    assert.equal(final.status, 'exited')
    assert.equal(final.runCount, 1)
    assert.equal(final.activity.label, 'Agent completed')
    assert.ok(final.outputBytes > 0)
    assert.ok(final.usage.totalTokens >= 0)
    assert.ok(final.childSessionId)
    assert.ok(events.some(item => item.type === 'turn.started'))
    assert.ok(events.some(item => item.type === 'turn.completed'))
    assert.ok(events.some(item => item.type === 'output.progress' && item.data.outputBytes > 0), 'short outputs still publish a final byte-count checkpoint')
    assert.ok(events.some(item => item.type === 'completed'))
    assert.equal(events.find(item => item.type === 'turn.started').data.run, 1)
    const child = await f.runtime.store.load(final.childSessionId)
    assert.ok(child.messages.some(message => message.role === 'assistant' && String(message.content).includes('Child agent completed')))
  } finally {
    await new Promise(resolve => modelServer.close(resolve))
    await f.cleanup()
  }
})

test('14F.5 Web View and daemon terminal expose the shared Subagents workspace without a fake pause control', async () => {
  const { readFile } = await import('node:fs/promises')
  const [html, js, css, terminal] = await Promise.all([
    readFile(new URL('../web/app/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/app/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/app/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/cli/daemon-client.ts', import.meta.url), 'utf8'),
  ])
  assert.match(html, /id="subagentsBtn"/)
  assert.match(html, /id="subagentCount"/)
  assert.match(js, /listSubagents\(rootId\)/)
  assert.match(js, /getTaskEvents\(taskId, 120\)/)
  assert.match(js, /streamTaskEvents\(taskId, lastEventSequence/ , 'the active detail uses the durable child-task event stream')
  assert.match(js, /getMessages\(childSessionId, 0, 14, true\)/)
  assert.match(js, /sendTask\(id, prompt\)/)
  assert.match(js, /resumeTask\(id, prompt\)/)
  assert.match(js, /cancelTask\(id\)/)
  assert.match(css, /\.agent-tree/)
  assert.match(css, /@media \(max-width:420px\)/)
  assert.match(terminal, /case 'subagents'/)
  assert.match(terminal, /case 'subagent-send'/)
  assert.match(terminal, /case 'subagent-resume'/)
  assert.doesNotMatch(js, /Pause agent|pauseTask\(/)
})
