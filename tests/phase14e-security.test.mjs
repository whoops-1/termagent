import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function request(base, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base)
    const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request(url, {
      method,
      headers: {
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        ...(body != null && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type') ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
    }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14e-root-'))
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14e-home-'))
  const authStorePath = path.join(home, 'auth-private', 'devices.json')
  const old = Object.fromEntries(['HOME', 'TERMAGENT_BASE_URL', 'TERMAGENT_API_KEY', 'TERMAGENT_MODEL', 'TERMAGENT_APPROVALS'].map(key => [key, process.env[key]]))
  process.env.HOME = home
  process.env.TERMAGENT_BASE_URL = 'http://127.0.0.1:9'
  process.env.TERMAGENT_API_KEY = 'phase14e-test-key'
  process.env.TERMAGENT_MODEL = 'phase14e-security-test'
  process.env.TERMAGENT_APPROVALS = 'auto'
  await mkdir(path.join(root, '.termagent'), { recursive: true })
  const { createRuntime } = await import('../dist/server/runtime.js')
  const { startServer } = await import('../dist/server/http.js')
  const runtime = await createRuntime(root)
  let server
  const serverOptions = { host: '127.0.0.1', port: 0, requirePairing: true, authStorePath, ...options }
  try {
    server = await startServer(runtime, serverOptions)
  } catch (error) {
    await runtime.close()
    restoreEnv(old)
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    throw error
  }
  const address = server.address()
  let base = `http://127.0.0.1:${address.port}`
  return {
    root, home, authStorePath, runtime, get server() { return server }, get base() { return base },
    async restart() {
      await new Promise(resolve => server.close(() => resolve()))
      server = await startServer(runtime, serverOptions)
      const address = server.address()
      base = `http://127.0.0.1:${address.port}`
    },
    async close() {
      await new Promise(resolve => server.close(() => resolve()))
      await runtime.close()
      restoreEnv(old)
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    },
  }
}

function restoreEnv(old) {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

test('Phase 14E fails closed for remote binds without explicit authenticated HTTPS configuration', async () => {
  const { validateServerOptions } = await import('../dist/server/http.js')
  assert.throws(() => validateServerOptions({ host: '0.0.0.0', port: 4096 }), /Refusing a non-loopback bind/)
  assert.throws(() => validateServerOptions({ host: '192.168.1.22', port: 4096, allowRemote: true, tlsCertFile: 'cert.pem', tlsKeyFile: 'key.pem', publicOrigin: 'http://agent.example' }), /HTTPS origin/)
  assert.throws(() => validateServerOptions({ host: '0.0.0.0', port: 4096, allowRemote: true, tlsCertFile: 'cert.pem', publicOrigin: 'https://agent.example' }), /Remote binds require TLS certificate and key/)
  assert.throws(() => validateServerOptions({ host: '127.0.0.1', port: 4096, tlsCertFile: 'cert.pem' }), /Both TLS certificate and TLS key/)
  assert.doesNotThrow(() => validateServerOptions({ host: '0.0.0.0', port: 4096, allowRemote: true, tlsCertFile: 'cert.pem', tlsKeyFile: 'key.pem', publicOrigin: 'https://agent.example' }))
  assert.throws(() => validateServerOptions({ host: '127.0.0.1', port: 4096, publicOrigin: 'https://agent.example' }), /requires --require-pairing/)
})

test('Phase 14E one-time pairing issues hashed workspace-scoped tokens, enforces Host/Origin and supports revocation', async () => {
  const f = await fixture()
  try {
    const code = f.server.termagent.pairingCode
    assert.match(code, /^[A-F0-9]{10}$/)

    let r = await request(f.base, 'GET', '/api/v1/info')
    assert.equal(r.status, 401)
    r = await request(f.base, 'GET', '/')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /text\/html/)

    r = await request(f.base, 'POST', '/api/v1/pair', { code, deviceName: 'Android browser' })
    assert.equal(r.status, 201, r.body)
    const paired = JSON.parse(r.body)
    assert.match(paired.token, /^ta_dev_[A-Za-z0-9_-]{40,}$/)
    assert.equal(paired.scope, 'workspace')
    assert.equal(paired.device.name, 'Android browser')
    assert.ok(paired.device.scopes.includes('interaction:resolve'))
    assert.ok(paired.device.scopes.includes('task:control'))
    assert.equal('tokenHash' in paired.device, false)
    assert.equal('workspaceId' in paired.device, false)

    const stored = await readFile(f.authStorePath, 'utf8')
    assert.equal(stored.includes(paired.token), false, 'raw device token must never be persisted')
    assert.equal(stored.includes(code), false, 'one-time pairing code must never be persisted')
    const record = JSON.parse(stored).devices[0]
    assert.match(record.tokenHash, /^[a-f0-9]{64}$/)
    const directoryMode = (await stat(path.dirname(f.authStorePath))).mode & 0o777
    const fileMode = (await stat(f.authStorePath)).mode & 0o777
    assert.equal(directoryMode, 0o700)
    assert.equal(fileMode, 0o600)

    const auth = { authorization: `Bearer ${paired.token}` }
    r = await request(f.base, 'GET', '/api/v1/device', null, auth)
    assert.equal(r.status, 200)
    const deviceInfo = JSON.parse(r.body)
    assert.equal(deviceInfo.device.id, paired.device.id)
    assert.equal('tokenHash' in deviceInfo.device, false)

    r = await request(f.base, 'GET', '/api/v1/info', null, auth)
    assert.equal(r.status, 200)
    const nativeFetch = await fetch(`${f.base}/api/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(nativeFetch.status, 201, 'native Node fetch metadata without Origin must remain usable')
    for (const pathname of ['/api/v1/info', '/api/v1/status', '/api/v1/models', '/api/v1/agents']) {
      const exposed = await request(f.base, 'GET', pathname, null, auth)
      assert.equal(exposed.status, 200)
      assert.equal(exposed.body.includes('phase14e-test-key'), false, `${pathname} must not expose provider credentials`)
    }

    r = await request(f.base, 'POST', '/api/v1/pair', { code, deviceName: 'Replay' })
    assert.equal(r.status, 401, 'pairing code must be single-use')

    r = await request(f.base, 'GET', '/api/v1/info', null, { host: 'attacker.invalid', ...auth })
    assert.equal(r.status, 421)
    r = await request(f.base, 'GET', '/api/v1/info', null, { origin: 'https://evil.invalid', ...auth })
    assert.equal(r.status, 403)
    r = await request(f.base, 'GET', '/api/v1/info', null, { origin: 'null', ...auth })
    assert.equal(r.status, 403)
    r = await request(f.base, 'POST', '/api/v1/sessions', {}, { 'sec-fetch-site': 'cross-site', ...auth })
    assert.equal(r.status, 403)
    r = await request(f.base, 'POST', '/api/v1/sessions', '{}', { 'content-type': 'text/plain', ...auth })
    assert.equal(r.status, 415)

    const session = JSON.parse((await request(f.base, 'POST', '/api/v1/sessions', {}, auth)).body)
    const foreignRoot = await mkdtemp(path.join(os.tmpdir(), 'termagent-14e-foreign-'))
    try {
      const foreign = await f.runtime.store.create(foreignRoot, 'foreign')
      r = await request(f.base, 'GET', `/api/v1/sessions/${foreign.id}`, null, auth)
      assert.equal(r.status, 404, 'workspace-scoped device cannot inspect another workspace session')
      r = await request(f.base, 'GET', '/api/v1/sessions', null, auth)
      const listed = JSON.parse(r.body).sessions
      assert.ok(listed.some(item => item.id === session.id))
      assert.ok(!listed.some(item => item.id === foreign.id))
    } finally {
      await rm(foreignRoot, { recursive: true, force: true })
    }

    r = await request(f.base, 'POST', '/api/v1/device/revoke', {}, auth)
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.body), { revoked: true })
    r = await request(f.base, 'GET', '/api/v1/info', null, auth)
    assert.equal(r.status, 401, 'revoked token must fail at the next request boundary')
    await f.restart()
    r = await request(f.base, 'GET', '/api/v1/info', null, auth)
    assert.equal(r.status, 401, 'revocation must remain effective after a server restart')
  } finally {
    await f.close()
  }
})

test('Phase 14E device token expiry and pairing brute-force controls are enforced', async () => {
  const f = await fixture({ deviceTokenTtlMs: 35 })
  try {
    const code = f.server.termagent.pairingCode
    const pairedResponse = await request(f.base, 'POST', '/api/v1/pair', { code, deviceName: 'Expiry test' })
    assert.equal(pairedResponse.status, 201, pairedResponse.body)
    const token = JSON.parse(pairedResponse.body).token
    await new Promise(resolve => setTimeout(resolve, 55))
    const expired = await request(f.base, 'GET', '/api/v1/info', null, { authorization: `Bearer ${token}` })
    assert.equal(expired.status, 401)

    const second = await fixture()
    try {
      const staleCode = second.server.termagent.pairingCode
      for (let i = 0; i < 5; i++) {
        const denied = await request(second.base, 'POST', '/api/v1/pair', { code: '0000000000', deviceName: 'Brute force' })
        assert.equal(denied.status, 401)
      }
      const replay = await request(second.base, 'POST', '/api/v1/pair', { code: staleCode, deviceName: 'Old code' })
      assert.equal(replay.status, 429, 'pair attempts from one source are rate-limited after five failures')
      const state = JSON.parse(await readFile(second.authStorePath, 'utf8'))
      assert.ok(state.audit.some(item => item.event === 'pairing.locked'))
    } finally {
      await second.close()
    }
  } finally {
    await f.close()
  }
})


test('Phase 14E enforces per-device scopes at write, interaction and task command boundaries', async () => {
  const f = await fixture()
  try {
    const paired = JSON.parse((await request(f.base, 'POST', '/api/v1/pair', {
      code: f.server.termagent.pairingCode,
      deviceName: 'Least privilege test',
    })).body)
    const state = JSON.parse(await readFile(f.authStorePath, 'utf8'))
    state.devices[0].scopes = ['workspace:read']
    await writeFile(f.authStorePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await f.restart()

    const auth = { authorization: `Bearer ${paired.token}` }
    let r = await request(f.base, 'GET', '/api/v1/info', null, auth)
    assert.equal(r.status, 200, 'read scope remains usable')
    r = await request(f.base, 'POST', '/api/v1/sessions', {}, auth)
    assert.equal(r.status, 403, 'read-only device cannot create or mutate sessions')

    state.devices[0].scopes = ['workspace:read', 'workspace:write']
    await writeFile(f.authStorePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await f.restart()
    const sessionResponse = await request(f.base, 'POST', '/api/v1/sessions', {}, auth)
    assert.equal(sessionResponse.status, 201, sessionResponse.body)
    const session = JSON.parse(sessionResponse.body)

    r = await request(f.base, 'POST', `/api/v1/sessions/${session.id}/permissions/not-a-real-request`, { decision: 'once' }, auth)
    assert.equal(r.status, 403, 'workspace write cannot resolve permissions without interaction:resolve')
    r = await request(f.base, 'POST', `/api/v1/sessions/${session.id}/commands`, {
      sessionId: session.id,
      kind: 'permission.resolve',
      commandId: 'scope-test-command',
      payload: { requestId: 'not-a-real-request', decision: 'once' },
    }, auth)
    assert.equal(r.status, 403, 'generic command endpoint must enforce interaction scope too')
    r = await request(f.base, 'POST', '/api/v1/tasks/not-a-real-task/cancel', {}, auth)
    assert.equal(r.status, 403, 'workspace write cannot control tasks without task:control')
  } finally {
    await f.close()
  }
})


function secureRequest(base, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base)
    const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    const req = https.request(url, {
      method,
      rejectUnauthorized: false,
      headers: {
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        ...(body != null && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type') ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
    }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

test('Phase 14E direct remote mode serves TLS and binds authorization to the configured public origin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14e-tls-root-'))
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14e-tls-home-'))
  const certFile = path.join(home, 'cert.pem')
  const keyFile = path.join(home, 'key.pem')
  const authStorePath = path.join(home, 'auth', 'devices.json')
  const old = Object.fromEntries(['HOME', 'TERMAGENT_BASE_URL', 'TERMAGENT_API_KEY', 'TERMAGENT_MODEL', 'TERMAGENT_APPROVALS'].map(key => [key, process.env[key]]))
  let runtime
  let server
  let allocator
  try {
    process.env.HOME = home
    process.env.TERMAGENT_BASE_URL = 'http://127.0.0.1:9'
    process.env.TERMAGENT_API_KEY = 'phase14e-tls-secret'
    process.env.TERMAGENT_MODEL = 'phase14e-tls-test'
    process.env.TERMAGENT_APPROVALS = 'auto'
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=127.0.0.1', '-days', '1'], { stdio: 'ignore' })
    const { chmod } = await import('node:fs/promises')
    await chmod(keyFile, 0o600)
    allocator = net.createServer()
    await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve))
    const port = allocator.address().port
    await new Promise(resolve => allocator.close(resolve))
    allocator = undefined

    const { createRuntime } = await import('../dist/server/runtime.js')
    const { startServer } = await import('../dist/server/http.js')
    runtime = await createRuntime(root)
    const origin = `https://127.0.0.1:${port}`
    server = await startServer(runtime, {
      host: '0.0.0.0', port, allowRemote: true,
      tlsCertFile: certFile, tlsKeyFile: keyFile,
      publicOrigin: origin, authStorePath,
    })

    let r = await secureRequest(origin, 'GET', '/api/v1/info', null, { origin })
    assert.equal(r.status, 401, 'remote API must require a paired bearer token')
    r = await secureRequest(origin, 'GET', '/api/v1/info', null, { host: `attacker.invalid:${port}`, origin })
    assert.equal(r.status, 421, 'public Host must match the configured HTTPS origin')
    r = await secureRequest(origin, 'GET', '/api/v1/info', null, { origin: 'https://attacker.invalid' })
    assert.equal(r.status, 403, 'public Origin must match the configured HTTPS origin')

    const code = server.termagent.pairingCode
    r = await secureRequest(origin, 'POST', '/api/v1/pair', { code, deviceName: 'TLS remote device' }, { origin })
    assert.equal(r.status, 201, r.body)
    const token = JSON.parse(r.body).token
    r = await secureRequest(origin, 'GET', '/api/v1/info', null, { origin, authorization: `Bearer ${token}` })
    assert.equal(r.status, 200, r.body)
    assert.equal(r.body.includes('phase14e-tls-secret'), false)
    assert.equal(server.termagent.remote, true)
  } finally {
    if (allocator?.listening) await new Promise(resolve => allocator.close(resolve))
    if (server) await new Promise(resolve => server.close(() => resolve()))
    if (runtime) await runtime.close()
    restoreEnv(old)
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})


test('Phase 14E reverse-proxy mode requires the public Host and HTTPS Origin', async () => {
  const f = await fixture({ publicOrigin: 'https://agent.example.test' })
  try {
    const code = f.server.termagent.pairingCode
    let r = await request(f.base, 'GET', '/api/v1/info', null, { host: 'agent.example.test', origin: 'https://agent.example.test' })
    assert.equal(r.status, 401, 'reverse-proxy API remains authenticated')
    r = await request(f.base, 'GET', '/api/v1/info', null, { host: '127.0.0.1:4096', origin: 'https://agent.example.test' })
    assert.equal(r.status, 421, 'proxy must preserve the public Host header')
    r = await request(f.base, 'GET', '/api/v1/info', null, { host: 'agent.example.test', origin: 'https://wrong.example.test' })
    assert.equal(r.status, 403)

    r = await request(f.base, 'POST', '/api/v1/pair', { code, deviceName: 'Reverse proxy device' }, {
      host: 'agent.example.test', origin: 'https://agent.example.test',
    })
    assert.equal(r.status, 201, r.body)
    const token = JSON.parse(r.body).token
    r = await request(f.base, 'GET', '/api/v1/info', null, {
      host: 'agent.example.test', origin: 'https://agent.example.test', authorization: `Bearer ${token}`,
    })
    assert.equal(r.status, 200, r.body)
    assert.equal(f.server.termagent.publicOrigin, 'https://agent.example.test')
    assert.equal(r.headers['strict-transport-security'], 'max-age=31536000')
  } finally {
    await f.close()
  }
})
