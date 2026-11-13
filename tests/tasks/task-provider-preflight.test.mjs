// 14I-B3 Stream C — provider preflight + snapshot completeness.
// Covers: preflightTaskProviderConfig ok/failure shapes, secret-free reasons,
// snapshot metadata carry-through, classifyProviderAttemptError classes, and
// the durable terminalCredentialError worker marker. Tests import dist/ like
// every other suite here; build happens at integration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_KEYS = [
  'HOME', 'TERMAGENT_TASK_ROOT', 'TERMAGENT_SESSION_ROOT',
  'PREFLIGHT_API_KEY_ENV', 'PREFLIGHT_SECRET_ENV',
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-preflight-'))
  const taskRoot = path.join(root, 'tasks')
  await mkdir(taskRoot, { recursive: true })
  process.env.HOME = root
  process.env.TERMAGENT_TASK_ROOT = taskRoot
  for (const key of ENV_KEYS) if (key !== 'HOME') delete process.env[key]
  return {
    root, taskRoot,
    cleanup: async () => { restoreEnv(previous); await rm(root, { recursive: true, force: true }) },
  }
}

const fakeProvider = config => ({ id: 'fixture-provider', model: config.model, config })

test('14I-C: preflight ok when the credential ref resolves against the task root', async () => {
  const { preflightTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const { newTaskCredentialRef, saveTaskProviderCredential } = await import('../../dist/tasks/task-credentials.js')
  const f = await fixture()
  try {
    const ref = newTaskCredentialRef()
    await saveTaskProviderCredential(f.taskRoot, ref, { provider: 'openai-compatible', model: 'ref-model', baseUrl: 'https://route.example/v1' }, 'ref-key')
    const result = await preflightTaskProviderConfig({
      provider: 'openai-compatible', model: 'ref-model', baseUrl: 'https://route.example/v1', credentialRef: ref,
    }, { taskRoot: f.taskRoot })
    assert.deepEqual(result, { ok: true })
  } finally { await f.cleanup() }
})

test('14I-C: preflight ok when apiKeyEnv is resolvable in opts.env', async () => {
  const { preflightTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    process.env.PREFLIGHT_API_KEY_ENV = 'env-resolved-key'
    const result = await preflightTaskProviderConfig({
      provider: 'anthropic', model: 'env-model', baseUrl: 'https://api.example/v1', apiKeyEnv: 'PREFLIGHT_API_KEY_ENV',
    }, { taskRoot: f.taskRoot, env: process.env })
    assert.deepEqual(result, { ok: true })
  } finally { await f.cleanup() }
})

test('14I-C: missing model reports missing-model', async () => {
  const { preflightTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const result = await preflightTaskProviderConfig({ provider: 'openai-compatible', baseUrl: 'https://route.example/v1' }, { taskRoot: f.taskRoot })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'missing-model')
    assert.match(result.reason, /model/i)
  } finally { await f.cleanup() }
})

test('14I-C: missing base URL reports incompatible-route', async () => {
  const { preflightTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const result = await preflightTaskProviderConfig({ provider: 'openai-compatible', model: 'route-model' }, { taskRoot: f.taskRoot })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'incompatible-route')
    assert.match(result.reason, /base URL/i)
  } finally { await f.cleanup() }
})

test('14I-C: missing provider adapter marker reports incompatible-route', async () => {
  const { preflightTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const result = await preflightTaskProviderConfig({ model: 'route-model', baseUrl: 'https://route.example/v1' }, { taskRoot: f.taskRoot })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'incompatible-route')
    assert.match(result.reason, /adapter|transport/i)
  } finally { await f.cleanup() }
})

test('14I-C: unknown unsupported adapter reports incompatible-route', async () => {
  const { preflightTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const result = await preflightTaskProviderConfig({ provider: 'bedrock', model: 'route-model', baseUrl: 'https://route.example/v1' }, { taskRoot: f.taskRoot })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'incompatible-route')
    assert.match(result.reason, /bedrock/)
    assert.match(result.reason, /adapter/i)
  } finally { await f.cleanup() }
})

test('14I-C: missing credential with no ref and no resolvable env reports missing-credential', async () => {
  const { preflightTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const result = await preflightTaskProviderConfig({ provider: 'openai-compatible', model: 'route-model', baseUrl: 'https://route.example/v1' }, { taskRoot: f.taskRoot, env: {} })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'missing-credential')
    assert.match(result.reason, /credential|No credential/i)
  } finally { await f.cleanup() }
})

test('14I-C: a credential ref that does not exist reports missing-credential (existence/parse check only)', async () => {
  const { preflightTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const { newTaskCredentialRef } = await import('../../dist/tasks/task-credentials.js')
  const f = await fixture()
  try {
    const missingRef = newTaskCredentialRef()
    const result = await preflightTaskProviderConfig({
      provider: 'openai-compatible', model: 'route-model', baseUrl: 'https://route.example/v1', credentialRef: missingRef,
    }, { taskRoot: f.taskRoot, env: {} })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'missing-credential')
    assert.match(result.reason, /missing or invalid/)
  } finally { await f.cleanup() }
})

test('14I-C: preflight reasons never contain secret material', async () => {
  const { preflightTaskProviderConfig } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const secret = 'sk-live-secret-material-do-not-leak'
    process.env.PREFLIGHT_SECRET_ENV = secret
    const result = await preflightTaskProviderConfig({
      provider: 'openai-compatible', model: 'secret-model', baseUrl: 'https://route.example/v1', apiKeyEnv: 'PREFLIGHT_SECRET_ENV',
    }, { taskRoot: f.taskRoot, env: {} })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'missing-credential')
    assert.equal(result.reason.includes(secret), false, 'reason must not embed the secret value')
    assert.match(result.reason, /PREFLIGHT_SECRET_ENV/i, 'the env var name may appear but never its value')
  } finally { await f.cleanup() }
})

test('14I-C: snapshot carries model, base URL, headers, variant/reasoning, output limits, context metadata, adapter choice and no raw key', async () => {
  const { subagentProviderSnapshot } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    const provider = fakeProvider({
      provider: 'anthropic', providerId: 'anthropic-profile', model: 'claude-sonnet', baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-in-memory-secret', apiKeyEnv: 'PREFLIGHT_UNSET_ENV',
      temperature: 0.7, maxTokens: 1024, maxOutputTokens: 4096, contextWindow: 200000,
      variant: 'sonnet-4', reasoningEffort: 'medium', streamIdleTimeoutMs: 120000,
      extra: { headers: { 'x-custom': 'header-value' }, adapter: 'anthropic-native' },
    })
    const snapshot = await subagentProviderSnapshot(provider, undefined, { label: 'a child task', taskRoot: f.taskRoot, env: {} })
    assert.equal(snapshot.apiKey, undefined, 'raw key is never persisted in the snapshot')
    assert.equal(snapshot.apiKeyEnv, undefined, 'in-memory key is saved to the credential store and referenced by ref')
    assert.match(snapshot.credentialRef, /^[a-f0-9]{24}$/)
    assert.equal(JSON.stringify(snapshot).includes('sk-ant-in-memory-secret'), false, 'secret must not leak into the snapshot')
    assert.equal(snapshot.provider, 'anthropic')
    assert.equal(snapshot.providerId, 'anthropic-profile')
    assert.equal(snapshot.model, 'claude-sonnet')
    assert.equal(snapshot.baseUrl, 'https://api.anthropic.com/v1')
    assert.equal(snapshot.temperature, 0.7)
    assert.equal(snapshot.maxTokens, 1024)
    assert.equal(snapshot.maxOutputTokens, 4096)
    assert.equal(snapshot.contextWindow, 200000)
    assert.equal(snapshot.variant, 'sonnet-4')
    assert.equal(snapshot.reasoningEffort, 'medium')
    assert.equal(snapshot.streamIdleTimeoutMs, 120000)
    assert.deepEqual(snapshot.extra, { headers: { 'x-custom': 'header-value' }, adapter: 'anthropic-native' })
    assert.equal(snapshot.extra.headers['x-custom'], 'header-value')
    assert.equal(snapshot.extra.adapter, 'anthropic-native')
  } finally { await f.cleanup() }
})

test('14I-C: snapshot keeps apiKeyEnv when it is resolvable and never falls back to process-global env', async () => {
  const { subagentProviderSnapshot } = await import('../../dist/tasks/task-provider.js')
  const f = await fixture()
  try {
    process.env.PREFLIGHT_API_KEY_ENV = 'env-resolved-key'
    const provider = fakeProvider({
      provider: 'openai-compatible', model: 'env-model', baseUrl: 'https://api.example/v1', apiKeyEnv: 'PREFLIGHT_API_KEY_ENV',
    })
    const snapshot = await subagentProviderSnapshot(provider, undefined, { label: 'a child task', taskRoot: f.taskRoot, env: { PREFLIGHT_API_KEY_ENV: 'env-resolved-key' } })
    assert.equal(snapshot.apiKeyEnv, 'PREFLIGHT_API_KEY_ENV')
    assert.equal(snapshot.credentialRef, undefined)
    assert.equal(snapshot.apiKey, undefined)
    assert.equal(JSON.stringify(snapshot).includes('env-resolved-key'), false, 'the secret value itself is never in the snapshot')
  } finally { await f.cleanup() }
})

test('14I-C: classifyProviderAttemptError classes 401/403 as credential-terminal', async () => {
  const { classifyProviderAttemptError } = await import('../../dist/tasks/task-provider.js')
  assert.equal(classifyProviderAttemptError({ status: 401, message: 'Provider HTTP 401: invalid key' }), 'credential-terminal')
  assert.equal(classifyProviderAttemptError({ status: 403, message: 'Provider HTTP 403: forbidden' }), 'credential-terminal')
  assert.equal(classifyProviderAttemptError(new Error('invalid credential for upstream route')), 'credential-terminal')
  assert.equal(classifyProviderAttemptError(new Error('unauthorized: bad credentials')), 'credential-terminal')
  assert.equal(classifyProviderAttemptError(new Error('403 Forbidden')), 'credential-terminal')
})

test('14I-C: classifyProviderAttemptError classes network/5xx as transient', async () => {
  const { classifyProviderAttemptError } = await import('../../dist/tasks/task-provider.js')
  assert.equal(classifyProviderAttemptError({ status: 500, message: 'internal server error' }), 'transient')
  assert.equal(classifyProviderAttemptError({ status: 429, message: 'rate limited', retryAfterMs: 1 }), 'transient')
  assert.equal(classifyProviderAttemptError(new Error('fetch failed: econnreset')), 'transient')
  assert.equal(classifyProviderAttemptError(new Error('timeout after 30s')), 'transient')
})

test('14I-C: classifyProviderAttemptError reports unknown for other failures', async () => {
  const { classifyProviderAttemptError } = await import('../../dist/tasks/task-provider.js')
  assert.equal(classifyProviderAttemptError({ status: 400, message: 'bad request' }), 'unknown')
  assert.equal(classifyProviderAttemptError(new Error('something unexpected happened')), 'unknown')
  assert.equal(classifyProviderAttemptError('provider exploded'), 'unknown')
})

test('14I-C: worker sets durable terminalCredentialError on credential-terminal provider failure', async () => {
  const { runTaskWorker } = await import('../../dist/tasks/worker.js')
  const { TaskManager } = await import('../../dist/tasks/manager.js')
  const f = await fixture()
  const manager = new TaskManager(f.taskRoot, false)
  const secret = 'sk-worker-secret-12345'
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls++
    return new Response(JSON.stringify({ error: { message: 'Invalid API key', leaked: secret } }), {
      status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' },
    })
  }
  try {
    process.env.PREFLIGHT_API_KEY_ENV = secret
    const id = 'w-credential-terminal'
    await writeFile(path.join(f.taskRoot, `${id}.json`), JSON.stringify({
      id, kind: 'agent', status: 'queued', prompt: 'say hi', cwd: f.root, started: Date.now(), updated: Date.now(),
      provider: { provider: 'openai-compatible', model: 'worker-model', baseUrl: 'https://route.example/v1', apiKeyEnv: 'PREFLIGHT_API_KEY_ENV' },
      output: '', permissionMode: 'deny',
    }), 'utf8')
    await runTaskWorker(id, manager)
    const record = JSON.parse(await readFile(path.join(f.taskRoot, `${id}.json`), 'utf8'))
    assert.equal(record.status, 'failed')
    assert.equal(record.terminalCredentialError, true, 'durable terminal credential marker is set on the task record')
    assert.equal(record.error, 'Provider credential was rejected by the upstream route (401/403 or invalid credential). This attempt is terminal: the same credential is not retried and no replacement agent is spawned.', 'secret-free terminal reason')
    assert.equal(record.error.includes(secret), false, 'reason contains no secret material')
    assert.equal(record.output.includes(secret), false, 'output contains no secret material')
    assert.ok(fetchCalls >= 1, 'the provider call was actually attempted')
  } finally {
    globalThis.fetch = originalFetch
    await f.cleanup()
  }
})

test('14I-C: worker does not set terminalCredentialError on transient provider failure', async () => {
  const { runTaskWorker } = await import('../../dist/tasks/worker.js')
  const { TaskManager } = await import('../../dist/tasks/manager.js')
  const f = await fixture()
  const manager = new TaskManager(f.taskRoot, false)
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls++
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429, statusText: 'Too Many Requests', headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
    })
  }
  try {
    process.env.PREFLIGHT_API_KEY_ENV = 'transient-key'
    const id = 'w-transient'
    await writeFile(path.join(f.taskRoot, `${id}.json`), JSON.stringify({
      id, kind: 'agent', status: 'queued', prompt: 'say hi', cwd: f.root, started: Date.now(), updated: Date.now(),
      provider: { provider: 'openai-compatible', model: 'worker-model', baseUrl: 'https://route.example/v1', apiKeyEnv: 'PREFLIGHT_API_KEY_ENV' },
      output: '', permissionMode: 'deny',
    }), 'utf8')
    await runTaskWorker(id, manager)
    const record = JSON.parse(await readFile(path.join(f.taskRoot, `${id}.json`), 'utf8'))
    assert.equal(record.status, 'failed')
    assert.equal(record.terminalCredentialError, undefined, 'no durable terminal marker on transient failure')
    assert.ok(fetchCalls >= 2, 'bounded retries were attempted for the transient failure')
  } finally {
    globalThis.fetch = originalFetch
    await f.cleanup()
  }
})
