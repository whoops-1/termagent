import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Mirrors the env-isolation fixture pattern of tests/phase14f5-subagents.test.mjs.
const ENV_KEYS = [
  'HOME', 'TERMAGENT_PROVIDER', 'TERMAGENT_BASE_URL', 'TERMAGENT_API_KEY',
  'TERMAGENT_MODEL', 'TERMAGENT_APPROVALS', 'TERMAGENT_TASK_ROOT',
  'TERMAGENT_SESSION_ROOT',
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-task-credentials-'))
  const taskRoot = path.join(root, 'tasks')
  process.env.HOME = root
  for (const key of ENV_KEYS) if (key !== 'HOME') delete process.env[key]
  return {
    root, taskRoot,
    cleanup: async () => {
      restoreEnv(previous)
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

const fakeProvider = config => ({ id: 'fixture-provider', model: config.model, config })
const credentialsDir = taskRoot => path.join(taskRoot, 'credentials')
const credentialFile = (taskRoot, ref) => path.join(credentialsDir(taskRoot), `${ref}.json`)
const listCredentials = async taskRoot => fs.readdir(credentialsDir(taskRoot)).catch(() => [])
const credentialError = ref =>
  `Child agent credential reference ${ref} is missing or invalid; restart the task from its parent runtime`
const expectsCredentialError = ref => error =>
  error instanceof Error && error.message === credentialError(ref)

test('task credentials: env-resolvable keys stay as apiKeyEnv without a credential file', async () => {
  const { subagentProviderSnapshot, resolveTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const provider = fakeProvider({
      provider: 'openai-compatible', model: 'env-model', baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'in-memory-key-that-must-not-persist', apiKeyEnv: 'TASK_CREDENTIALS_ENV_KEY',
    })
    const snapshot = await subagentProviderSnapshot(provider, undefined, {
      label: 'a child task', taskRoot: f.taskRoot, env: { TASK_CREDENTIALS_ENV_KEY: 'env-resolved-key' },
    })
    assert.equal(snapshot.apiKeyEnv, 'TASK_CREDENTIALS_ENV_KEY')
    assert.equal(snapshot.credentialRef, undefined)
    assert.equal(snapshot.apiKey, undefined)
    assert.equal(JSON.stringify(snapshot).includes('in-memory-key-that-must-not-persist'), false)
    assert.deepEqual(await listCredentials(f.taskRoot), [])
    const resolved = await resolveTaskProviderConfig(snapshot, { taskRoot: f.taskRoot, env: { TASK_CREDENTIALS_ENV_KEY: 'env-resolved-key' } })
    assert.equal(resolved.apiKey, 'env-resolved-key')
  } finally { await f.cleanup() }
})

test('task credentials: in-memory-only keys persist a ref file and a secret-free snapshot', async () => {
  const { subagentProviderSnapshot } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const provider = fakeProvider({
      provider: 'anthropic', model: 'memory-model', baseUrl: 'https://api.example/v1',
      apiKey: 'in-memory-only-secret', apiKeyEnv: 'TASK_CREDENTIALS_UNSET_KEY',
    })
    const snapshot = await subagentProviderSnapshot(provider, undefined, { label: 'a background agent', taskRoot: f.taskRoot, env: {} })
    assert.match(snapshot.credentialRef, /^[a-f0-9]{24}$/)
    assert.equal('apiKeyEnv' in snapshot, false, 'the credential ref is authoritative once saved')
    assert.equal(JSON.stringify(snapshot).includes('in-memory-only-secret'), false)
    const stored = JSON.parse(await fs.readFile(credentialFile(f.taskRoot, snapshot.credentialRef), 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.ref, snapshot.credentialRef)
    assert.equal(stored.apiKey, 'in-memory-only-secret')
    assert.equal(stored.provider, snapshot.provider)
    assert.equal(stored.model, snapshot.model)
    assert.equal(stored.baseUrl, snapshot.baseUrl)
    assert.equal(typeof stored.createdAt, 'number')
    if (process.platform !== 'win32') {
      const fileStat = await fs.stat(credentialFile(f.taskRoot, snapshot.credentialRef))
      assert.equal(fileStat.mode & 0o777, 0o600, 'credential files are daemon-owned 0600')
      const dirStat = await fs.stat(credentialsDir(f.taskRoot))
      assert.equal(dirStat.mode & 0o777, 0o700, 'credential directories are daemon-owned 0700')
    }
  } finally { await f.cleanup() }
})

test('task credentials: resolution through a ref returns the exact key and drops raw snapshot keys', async () => {
  const { subagentProviderSnapshot, resolveTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const provider = fakeProvider({
      provider: 'anthropic', model: 'resolve-model', baseUrl: 'https://resolve.example/v1',
      apiKey: 'ref-resolved-secret',
    })
    const snapshot = await subagentProviderSnapshot(provider, undefined, { label: 'a child task', taskRoot: f.taskRoot, env: {} })
    const resolved = await resolveTaskProviderConfig(snapshot, { taskRoot: f.taskRoot, env: {} })
    assert.equal(resolved.apiKey, 'ref-resolved-secret')
    assert.equal(resolved.credentialRef, undefined)
    assert.equal(resolved.provider, 'anthropic')
    assert.equal(resolved.model, snapshot.model)
    assert.equal(resolved.baseUrl, snapshot.baseUrl)

    // Defense in depth: a raw key smuggled into task JSON is never trusted.
    const rawOnly = await resolveTaskProviderConfig(
      { provider: 'openai-compatible', model: 'raw-model', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'raw-key-in-json' },
      { taskRoot: f.taskRoot, env: {} },
    )
    assert.equal(rawOnly.apiKey, undefined)
    const rawAlongsideRef = await resolveTaskProviderConfig(
      { ...snapshot, apiKey: 'raw-key-in-json' },
      { taskRoot: f.taskRoot, env: {} },
    )
    assert.equal(rawAlongsideRef.apiKey, 'ref-resolved-secret', 'the credential ref wins over any raw key in task JSON')
  } finally { await f.cleanup() }
})

test('task credentials: missing, corrupt and route-mismatched refs fail with a precise error', async () => {
  const { newTaskCredentialRef, saveTaskProviderCredential } = await import('../../dist/tasks/task-credentials.js')
  const { subagentProviderSnapshot, resolveTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const missingRef = newTaskCredentialRef()
    await assert.rejects(
      () => resolveTaskProviderConfig(
        { provider: 'openai-compatible', model: 'missing-model', baseUrl: 'http://127.0.0.1:9/v1', credentialRef: missingRef },
        { taskRoot: f.taskRoot, env: {} },
      ),
      expectsCredentialError(missingRef),
      'missing ref file',
    )

    const corruptRef = newTaskCredentialRef()
    await fs.mkdir(credentialsDir(f.taskRoot), { recursive: true })
    await fs.writeFile(credentialFile(f.taskRoot, corruptRef), '{ this is not json', 'utf8')
    await assert.rejects(
      () => resolveTaskProviderConfig(
        { provider: 'openai-compatible', model: 'corrupt-model', baseUrl: 'http://127.0.0.1:9/v1', credentialRef: corruptRef },
        { taskRoot: f.taskRoot, env: {} },
      ),
      expectsCredentialError(corruptRef),
      'corrupt ref file',
    )

    const routeProvider = fakeProvider({
      provider: 'openai-compatible', model: 'route-model', baseUrl: 'https://route-a.example/v1', apiKey: 'route-a-secret',
    })
    const snapshot = await subagentProviderSnapshot(routeProvider, undefined, { label: 'a child task', taskRoot: f.taskRoot, env: {} })
    const drifted = { ...snapshot, baseUrl: 'https://route-b.example/v1' }
    await assert.rejects(
      () => resolveTaskProviderConfig(drifted, { taskRoot: f.taskRoot, env: {} }),
      expectsCredentialError(snapshot.credentialRef),
      'route mismatch',
    )

    await assert.rejects(
      () => saveTaskProviderCredential(f.taskRoot, '../escape', { provider: 'p', model: 'm', baseUrl: 'b' }, 'k'),
      /Refusing to persist an invalid task provider credential/,
      'malformed refs are never persisted',
    )
    await assert.rejects(
      () => resolveTaskProviderConfig(
        { provider: 'openai-compatible', model: 'escape-model', baseUrl: 'http://127.0.0.1:9/v1', credentialRef: '../escape' },
        { taskRoot: f.taskRoot, env: {} },
      ),
      expectsCredentialError('../escape'),
      'malformed refs never resolve',
    )
  } finally { await f.cleanup() }
})

test('task credentials: declared-but-unset env keys keep local no-key parity without hard failures', async () => {
  const { subagentProviderSnapshot, resolveTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const provider = fakeProvider({
      provider: 'openai-compatible', model: 'local-model', baseUrl: 'http://127.0.0.1:9/v1',
      apiKeyEnv: 'TASK_CREDENTIALS_DECLARED_UNSET',
    })
    const snapshot = await subagentProviderSnapshot(provider, undefined, { label: 'a child task', taskRoot: f.taskRoot, env: {} })
    assert.equal(snapshot.apiKeyEnv, 'TASK_CREDENTIALS_DECLARED_UNSET')
    assert.equal(snapshot.credentialRef, undefined)
    assert.deepEqual(await listCredentials(f.taskRoot), [])
    const resolved = await resolveTaskProviderConfig(snapshot, { taskRoot: f.taskRoot, env: {} })
    assert.equal(resolved.apiKey, undefined)
    assert.equal(resolved.apiKeyEnv, 'TASK_CREDENTIALS_DECLARED_UNSET')
    await assert.rejects(
      () => resolveTaskProviderConfig(undefined, { taskRoot: f.taskRoot }),
      /Agent task is missing provider configuration/,
    )
  } finally { await f.cleanup() }
})

test('task credentials: subagent snapshots preserve the per-context missing-base-URL errors', async () => {
  const { subagentProviderSnapshot } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    for (const label of ['parallel agents', 'a background agent', 'a child task']) {
      await assert.rejects(
        () => subagentProviderSnapshot(fakeProvider({ provider: 'openai-compatible', model: 'no-route' }), undefined, { label, taskRoot: f.taskRoot, env: {} }),
        new Error(`Provider fixture-provider has no base URL for ${label}`),
      )
    }
  } finally { await f.cleanup() }
})

test('task credentials: ProviderRouter subagent selection routes through the shared snapshot boundary', async () => {
  const { subagentProviderSnapshot, resolveTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const { ProviderRouter } = await import('../../dist/providers/router.js')
  const f = await fixture()
  try {
    const stub = fakeProvider({
      provider: 'openai-compatible', model: 'router-sub-model', baseUrl: 'https://router.example/v1',
      apiKey: 'router-in-memory-key', apiKeyEnv: 'TASK_CREDENTIALS_ROUTER_UNSET',
    })
    const router = new ProviderRouter([stub])
    const snapshot = await subagentProviderSnapshot(router, undefined, { label: 'a child task', taskRoot: f.taskRoot, env: {} })
    assert.equal(snapshot.model, 'router-sub-model')
    assert.equal(snapshot.provider, 'openai-compatible')
    assert.match(snapshot.credentialRef, /^[a-f0-9]{24}$/)
    assert.equal(JSON.stringify(snapshot).includes('router-in-memory-key'), false)
    const resolved = await resolveTaskProviderConfig(snapshot, { taskRoot: f.taskRoot, env: {} })
    assert.equal(resolved.apiKey, 'router-in-memory-key')
  } finally { await f.cleanup() }
})

test('task credentials: cleanup keeps live and settled-recent refs and sweeps settled-stale and orphan refs', async () => {
  const { newTaskCredentialRef, saveTaskProviderCredential } = await import('../../dist/tasks/task-credentials.js')
  const { TaskManager } = await import('../../dist/tasks/manager.js')
  const f = await fixture()
  const manager = new TaskManager(path.join(f.root, 'cleanup-tasks'), false)
  try {
    const route = { provider: 'openai-compatible', model: 'sweep-model', baseUrl: 'https://sweep.example/v1' }
    const snapshotFor = ref => ({ provider: route.provider, model: route.model, baseUrl: route.baseUrl, credentialRef: ref })
    const liveRef = newTaskCredentialRef()
    const recentRef = newTaskCredentialRef()
    const staleRef = newTaskCredentialRef()
    const orphanRef = newTaskCredentialRef()
    for (const ref of [liveRef, recentRef, staleRef, orphanRef]) {
      await saveTaskProviderCredential(manager.taskRoot(), ref, route, `secret-for-${ref}`)
    }

    const live = await manager.createAgent('live work', f.root, snapshotFor(liveRef), ['live'], 'session')
    const recent = await manager.createAgent('recent work', f.root, snapshotFor(recentRef), ['recent'], 'session')
    const stale = await manager.createAgent('stale work', f.root, snapshotFor(staleRef), ['stale'], 'session')
    assert.equal(live.status, 'queued')
    await manager.update(recent.id, { status: 'exited', ended: Date.now(), result: 'done' })
    const staleRecord = JSON.parse(await fs.readFile(path.join(manager.taskRoot(), `${stale.id}.json`), 'utf8'))
    staleRecord.status = 'exited'
    staleRecord.ended = Date.now() - 8 * 86400000
    staleRecord.updated = Date.now() - 8 * 86400000
    await fs.writeFile(path.join(manager.taskRoot(), `${stale.id}.json`), JSON.stringify(staleRecord))

    await manager.cleanup(7)
    const remaining = await listCredentials(manager.taskRoot())
    assert.equal(remaining.includes(`${liveRef}.json`), true, 'refs of active tasks survive')
    assert.equal(remaining.includes(`${recentRef}.json`), true, 'refs of settled-but-recent tasks survive')
    assert.equal(remaining.includes(`${staleRef}.json`), false, 'refs of settled-stale tasks are swept')
    assert.equal(remaining.includes(`${orphanRef}.json`), false, 'orphan refs are swept')
  } finally { await f.cleanup() }
})
