import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { webfetchTool, websearchTool } from '../dist/tools/web.js'
import { ToolRegistry, normalizeToolDefinition } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { builtinTools } from '../dist/tools/builtin.js'

const signal = new AbortController().signal
const mkCtx = () => ({ sessionID: 'phase16b', agent: 'build', cwd: process.cwd(), abort: signal })

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}
function base(server) {
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}
async function close(server) {
  if (server) await new Promise(resolve => server.close(resolve))
}

const webFetch = (overrides = {}) => webfetchTool({ allowPrivateHosts: true, ...overrides })
const webSearch = (overrides = {}) => websearchTool(overrides)

test('16B builtins register as network-risk tools and are gated in read-only modes', async () => {
  const names = builtinTools({ timeout: 5000, maxOutput: 5000 }).map(tool => tool.name)
  assert.ok(names.includes('webfetch'))
  assert.ok(names.includes('websearch'))
  const fetchTool = webfetchTool()
  const searchTool = websearchTool()
  assert.equal(fetchTool.risk, 'network')
  assert.equal(searchTool.risk, 'network')
  assert.equal(fetchTool.permission.action, 'network')
  assert.equal(searchTool.permission.action, 'network')
  assert.equal(normalizeToolDefinition({ name: 'generic_net', description: 'x', schema: {}, risk: 'network' }).permission.action, 'network')

  const registry = new ToolRegistry(new PermissionGate('auto'))
  registry.add(fetchTool).add(searchTool)
  const build = registry.selectSchemas({ mode: 'build', allowShell: true, allowWrite: true })
  const buildNames = build.tools.map(tool => tool.function.name)
  assert.ok(buildNames.includes('webfetch'))
  assert.ok(buildNames.includes('websearch'))
  const explore = registry.selectSchemas({ mode: 'explore', allowShell: false, allowWrite: false })
  const exploreNames = explore.tools.map(tool => tool.function.name)
  assert.ok(!exploreNames.includes('webfetch'))
  assert.ok(!exploreNames.includes('websearch'))
})

test('16B webfetch returns a bounded text preview with metadata', async t => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>hello termagent</body></html>')
  })
  t.after(() => close(server))
  const result = await webFetch().execute({ url: `${base(server)}/page` }, mkCtx())
  assert.match(result.output, /\[status 200 · text\/html · \d+ bytes · 0 redirect\(s\)\]/)
  assert.match(result.output, /hello termagent/)
  assert.equal(result.metadata.network.kind, 'webfetch')
  assert.equal(result.metadata.network.status, 200)
  assert.equal(result.metadata.network.truncated, false)
  assert.equal(result.metadata.network.binary, false)
})

test('16B webfetch truncates oversized responses and summarizes binary bodies', async t => {
  const server = await listen((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('a'.repeat(5000))
    } else {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    }
  })
  t.after(() => close(server))

  const big = await webFetch({ maxBytes: 1024 }).execute({ url: `${base(server)}/big` }, mkCtx())
  assert.equal(big.metadata.network.truncated, true)
  assert.equal(big.metadata.network.bytes, 5000)
  assert.match(big.output, /\[response truncated/)

  const image = await webFetch().execute({ url: `${base(server)}/img` }, mkCtx())
  assert.equal(image.metadata.network.binary, true)
  assert.match(image.output, /Binary response body omitted/)
})

test('16B webfetch aborts on timeout', async t => {
  const server = await listen((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('slow')
    }, 500)
  })
  t.after(() => close(server))
  await assert.rejects(
    () => webFetch({ timeoutMs: 50 }).execute({ url: `${base(server)}/slow` }, mkCtx()),
  )
})

test('16B webfetch follows bounded redirects and detects loops and caps', async t => {
  const server = await listen((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/final' }); res.end(); return }
    if (req.url === '/final') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('final body'); return }
    if (req.url === '/loop-a') { res.writeHead(302, { location: '/loop-b' }); res.end(); return }
    if (req.url === '/loop-b') { res.writeHead(302, { location: '/loop-a' }); res.end(); return }
    if (req.url === '/chain1') { res.writeHead(302, { location: '/chain2' }); res.end(); return }
    if (req.url === '/chain2') { res.writeHead(302, { location: '/chain3' }); res.end(); return }
    if (req.url === '/chain3') { res.writeHead(302, { location: '/chain4' }); res.end(); return }
    if (req.url === '/chain4') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('done'); return }
    res.writeHead(404); res.end()
  })
  t.after(() => close(server))

  const ok = await webFetch().execute({ url: `${base(server)}/start` }, mkCtx())
  assert.match(ok.output, /final body/)
  assert.equal(ok.metadata.network.hops, 1)

  await assert.rejects(
    () => webFetch().execute({ url: `${base(server)}/loop-a` }, mkCtx()),
    /Redirect loop detected/,
  )
  await assert.rejects(
    () => webFetch({ maxRedirects: 2 }).execute({ url: `${base(server)}/chain1` }, mkCtx()),
    /Too many redirects/,
  )
})

test('16B webfetch rejects non-http schemes and embedded credentials', async () => {
  await assert.rejects(() => webFetch({ allowPrivateHosts: false }).execute({ url: 'file:///etc/passwd' }, mkCtx()), /Unsupported URL protocol/)
  await assert.rejects(() => webFetch({ allowPrivateHosts: false }).execute({ url: 'ftp://example.com/file' }, mkCtx()), /Unsupported URL protocol/)
  await assert.rejects(() => webFetch({ allowPrivateHosts: false }).execute({ url: 'http://user:pass@example.com/' }, mkCtx()), /embedded credentials/)
})

test('16B webfetch blocks private and reserved targets by default', async () => {
  const blocked = ['http://127.0.0.1:8080/', 'http://[::1]:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://0.0.0.0/']
  for (const url of blocked) {
    await assert.rejects(() => webfetchTool().execute({ url }, mkCtx()), /non-public address class/, `expected ${url} to be blocked`)
  }
})

test('16B webfetch runs through PermissionGate with network action', async t => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('permitted')
  })
  t.after(() => close(server))
  const url = `${base(server)}/perm`

  const asked = []
  const gate = new PermissionGate('ask')
  gate.setRequester(async request => {
    asked.push(request)
    return 'once'
  })
  const registry = new ToolRegistry(gate)
  registry.add(webFetch())
  const result = await registry.execute('webfetch', { url }, mkCtx())
  assert.match(result.output, /permitted/)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].action, 'network')
  assert.ok(asked[0].resources.includes(url))

  const denyGate = new PermissionGate('ask')
  denyGate.setRequester(async () => 'deny')
  const denyRegistry = new ToolRegistry(denyGate)
  denyRegistry.add(webFetch())
  await assert.rejects(() => denyRegistry.execute('webfetch', { url }, mkCtx()), /Permission denied/)

  const ruleGate = new PermissionGate('ask', process.stdin, process.stdout, [{ tool: 'webfetch', decision: 'deny' }])
  const ruleRegistry = new ToolRegistry(ruleGate)
  ruleRegistry.add(webFetch())
  await assert.rejects(() => ruleRegistry.execute('webfetch', { url }, mkCtx()), /Permission denied by rule/)
})

test('16B websearch requires a configured endpoint', async () => {
  await assert.rejects(() => webSearch().execute({ query: 'termagent' }, mkCtx()), /requires a configured search endpoint/)
})

test('16B websearch GET returns bounded structured results and sends bearer auth', async t => {
  let sawAuth = ''
  const server = await listen((req, res) => {
    sawAuth = req.headers.authorization || ''
    const q = new URL(req.url, 'http://localhost').searchParams.get('q')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results: [
      { title: 'First', url: 'https://example.com/1', snippet: 'one' },
      { title: 'Second', url: 'https://example.com/2', snippet: 'two' },
      { title: 'Third', url: 'https://example.com/3', snippet: 'three' },
    ], query: q }))
  })
  t.after(() => close(server))
  process.env.TEST_P16B_SEARCH_KEY = 's3cret'
  try {
    const tool = webSearch({ webSearch: { url: `${base(server)}/search`, method: 'GET', apiKeyEnv: 'TEST_P16B_SEARCH_KEY', maxResults: 2 } })
    const result = await tool.execute({ query: 'termagent', maxResults: 2 }, mkCtx())
    assert.equal(sawAuth, 'Bearer s3cret')
    assert.match(result.output, /1\. First/)
    assert.match(result.output, /2\. Second/)
    assert.doesNotMatch(result.output, /Third/)
    assert.equal(result.metadata.network.returned, 2)
    assert.equal(result.metadata.network.method, 'GET')
  } finally {
    delete process.env.TEST_P16B_SEARCH_KEY
  }
})

test('16B websearch POST sends a JSON body', async t => {
  let bodyPayload = null
  const server = await listen(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    bodyPayload = JSON.parse(raw)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results: [{ title: 'Hit', url: 'https://example.com/hit', snippet: 'post' }] }))
  })
  t.after(() => close(server))
  const tool = webSearch({ webSearch: { url: `${base(server)}/search`, method: 'POST' } })
  const result = await tool.execute({ query: 'post query' }, mkCtx())
  assert.deepEqual(bodyPayload, { query: 'post query', maxResults: 8 })
  assert.match(result.output, /Hit/)
  assert.equal(result.metadata.network.method, 'POST')
})
