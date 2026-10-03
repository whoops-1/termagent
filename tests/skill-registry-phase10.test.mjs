import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import crypto from 'node:crypto'

async function tempHome(prefix = 'termagent-phase10-') { return mkdtemp(path.join(os.tmpdir(), prefix)) }
async function withHome(home, fn) { const previous = process.env.HOME; process.env.HOME = home; try { return await fn() } finally { process.env.HOME = previous } }
function sha(content) { return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}` }

function safeSkill(name, version = '0.1.0', extra = '') {
  return `---\nname: ${name}\ndescription: A registry skill for testing.\ntrust: community\nversion: ${version}\nlicense: MIT\n---\n\n# ${name}\n\n## Use this skill when\n- Testing remote pure-skill registry behavior.\n\n## Procedure\n1. Read the relevant project context.\n2. Apply the requested workflow and verify the result.\n${extra}`
}

function providerFor(document, skills = {}, revocations = []) {
  let registryCalls = 0
  let skillCalls = 0
  return {
    get registryCalls() { return registryCalls },
    get skillCalls() { return skillCalls },
    async fetchRegistry() { registryCalls++; const raw = JSON.stringify(document); return { document, digest: sha(raw), raw } },
    async fetchSkill(url) { skillCalls++; const content = skills[url]; if (content === undefined) throw new Error(`missing fake skill: ${url}`); const security = { status: 'clean', findings: [] }; return { content, sha256: sha(content), securityStatus: security.status, securityFindings: security.findings, bytes: Buffer.byteLength(content), url } },
    async fetchRevocations() { return revocations },
  }
}
test('phase 10: registry provider installs pure SKILL.md without plugin permissions and exposes provenance', async () => {
  const home = await tempHome(); const project = await tempHome('termagent-phase10-project-')
  const content = safeSkill('review')
  const entry = { id: 'community/review', name: 'review', description: 'Review code', trust: 'community', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/review/SKILL.md', sha256: sha(content) }
  const document = { version: 1, name: 'Test registry', skills: [entry], revocations: [] }
  const provider = providerFor(document, { [entry.source]: content })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      const catalogMod = await import('../dist/skills/catalog.js')
      await registry.addSkillRegistry('community', 'https://registry.example.invalid/registry.json')
      await assert.rejects(() => registry.installSkillFromRegistry('community', 'community/review', { provider }), /Trust approval required/)
      const installed = await registry.installSkillFromRegistry('community', 'community/review', { provider, confirm: true })
      assert.equal(installed.id, 'community/review')
      assert.equal(installed.status, 'installed')
      assert.equal(installed.trust, 'community')
      assert.match(installed.path, /skill-registries[\\/]installed[\\/]community[\\/]review[\\/]0\.1\.0[\\/]SKILL\.md$/)
      assert.equal(await registry.getSkillRegistryTrustState('community', entry), 'approved')

      const catalog = await catalogMod.loadSkillCatalog(project)
      const found = catalog.get('community/review')
      assert.ok(found)
      assert.equal(found.source, 'registry')
      assert.equal(found.registryId, 'community')
      assert.equal(found.trust, 'community')
      assert.equal(found.sha256, entry.sha256)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('phase 10: remote digest mismatch is rejected before any pure skill is installed', async () => {
  const home = await tempHome()
  const content = safeSkill('broken')
  const entry = { id: 'demo/broken', name: 'broken', description: 'Broken digest', trust: 'verified', version: '1.2.3', license: 'MIT', source: 'https://skills.example.invalid/broken/SKILL.md', sha256: sha('different content') }
  const document = { version: 1, skills: [entry] }
  const provider = providerFor(document, { [entry.source]: content })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await assert.rejects(() => registry.installSkillFromRegistry('demo', entry.id, { provider, confirm: true }), /Digest mismatch/)
      assert.deepEqual(await registry.listInstalledRegistrySkills(), [])
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('phase 10: remote revocations are persisted and block later installs', async () => {
  const home = await tempHome()
  const content = safeSkill('revoked')
  const entry = { id: 'demo/revoked', name: 'revoked', description: 'Revoked skill', trust: 'official', version: '1.0.0', license: 'MIT', source: 'https://skills.example.invalid/revoked/SKILL.md', sha256: sha(content) }
  const document = { version: 1, skills: [entry] }
  const provider = providerFor(document, { [entry.source]: content }, [{ id: entry.id, version: entry.version, sha256: entry.sha256, reason: 'withdrawn by publisher' }])
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await assert.rejects(() => registry.installSkillFromRegistry('demo', entry.id, { provider, confirm: true }), /revoked: withdrawn by publisher/)
      assert.deepEqual(await registry.listInstalledRegistrySkills(), [])
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('phase 10: offline registry metadata and cached skill body support reinstall without network access', async () => {
  const home = await tempHome()
  const content = safeSkill('offline', '0.2.0')
  const entry = { id: 'demo/offline', name: 'offline', description: 'Offline skill', trust: 'verified', version: '0.2.0', license: 'MIT', source: 'https://skills.example.invalid/offline/SKILL.md', sha256: sha(content) }
  const document = { version: 1, skills: [entry] }
  const first = providerFor(document, { [entry.source]: content })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await registry.installSkillFromRegistry('demo', entry.id, { provider: first, confirm: true })
      assert.equal(first.skillCalls, 1)
      await registry.uninstallRegistrySkill(entry.id)

      const offline = {
        async fetchRegistry() { throw new Error('offline') },
        async fetchSkill() { throw new Error('skill network must not be used') },
        async fetchRevocations() { return [] },
      }
      const result = await registry.installSkillFromRegistry('demo', entry.id, { provider: offline, confirm: true, allowStale: true })
      assert.equal(result.id, entry.id)
      assert.equal(result.status, 'installed')
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('phase 10: stale metadata can be detected from an aged offline registry cache', async () => {
  const home = await tempHome()
  const content = safeSkill('stale')
  const entry = { id: 'demo/stale', name: 'stale', description: 'Stale skill', trust: 'verified', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/stale/SKILL.md', sha256: sha(content) }
  const document = { version: 1, skills: [entry] }
  const first = providerFor(document, { [entry.source]: content })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await registry.refreshSkillRegistry('demo', { provider: first })
      const cache = path.join(registry.getSkillRegistryCacheRoot(), 'demo', 'registry.json')
      const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
      await utimes(cache, old, old)
      const offline = { async fetchRegistry() { throw new Error('network unavailable') }, async fetchSkill() { throw new Error('not expected') }, async fetchRevocations() { return [] } }
      const result = await registry.refreshSkillRegistry('demo', { provider: offline, maxAgeMs: 7 * 24 * 60 * 60 * 1000 })
      assert.equal(result.fromCache, true)
      assert.equal(result.stale, true)
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('phase 10: exact trust approval is invalidated by a registry digest/version/source change', async () => {
  const home = await tempHome()
  const firstContent = safeSkill('trust', '0.1.0')
  const firstEntry = { id: 'demo/trust', name: 'trust', description: 'Trust test', trust: 'verified', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/trust/SKILL.md', sha256: sha(firstContent) }
  const firstDoc = { version: 1, skills: [firstEntry] }
  const secondContent = safeSkill('trust', '0.2.0')
  const secondEntry = { ...firstEntry, version: '0.2.0', sha256: sha(secondContent) }
  const first = providerFor(firstDoc, { [firstEntry.source]: firstContent })
  const second = providerFor({ version: 1, skills: [secondEntry] }, { [secondEntry.source]: secondContent })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await registry.installSkillFromRegistry('demo', firstEntry.id, { provider: first, confirm: true })
      assert.equal(await registry.getSkillRegistryTrustState('demo', firstEntry), 'approved')
      assert.equal(await registry.getSkillRegistryTrustState('demo', secondEntry), 'invalidated')
      await assert.rejects(() => registry.installSkillFromRegistry('demo', secondEntry.id, { provider: second }), /Trust approval required/)
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('phase 10: HTTP registry fetch handles network failure and still uses the last known-good cache', async () => {
  const home = await tempHome()
  const content = safeSkill('http')
  const entry = { id: 'demo/http', name: 'http', description: 'HTTP registry', trust: 'verified', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/http/SKILL.md', sha256: sha(content) }
  const payload = JSON.stringify({ version: 1, skills: [entry] })
  let body = payload
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(body) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('http', `http://127.0.0.1:${port}/registry.json`)
      const first = await registry.refreshSkillRegistry('http')
      assert.equal(first.fromCache, false)
      server.close()
      await new Promise(resolve => server.on('close', resolve))
      const second = await registry.refreshSkillRegistry('http')
      assert.equal(second.fromCache, true)
      assert.equal(second.document.skills[0].id, entry.id)
    })
  } finally { server.close(); await rm(home, { recursive: true, force: true }) }
})

test('phase 10: malformed remote registry is rejected instead of becoming an installable cache', async () => {
  const home = await tempHome()
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{"skills":[{"id":"demo/bad","name":"bad","description":"bad","version":"not-semver","trust":"community","source":"./bad/SKILL.md","sha256":"'+'0'.repeat(64)+'"}]}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('bad', `http://127.0.0.1:${port}/registry.json`)
      await assert.rejects(() => registry.refreshSkillRegistry('bad'), /invalid version/)
      assert.equal((await registry.listSkillRegistries()).find(r => r.id === 'bad')?.stale, true)
    })
  } finally {
    server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('phase 10: array-root registry resolves relative SKILL.md and revocation URLs from registry location', async () => {
  const home = await tempHome()
  const content = safeSkill('relative', '0.3.0')
  const entry = { id: 'demo/relative', name: 'relative', description: 'Relative source', trust: 'verified', version: '0.3.0', license: 'MIT', source: './skills/relative/SKILL.md', sha256: sha(content) }
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', req.url?.endsWith('.md') ? 'text/markdown' : 'application/json')
    if (req.url === '/registry.json') res.end(JSON.stringify([entry]))
    else if (req.url === '/revocations.json') res.end('[]')
    else if (req.url === '/skills/relative/SKILL.md') res.end(content)
    else { res.statusCode = 404; res.end('not found') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', `http://127.0.0.1:${port}/registry.json`)
      const result = await registry.listRegistrySkills('demo')
      assert.equal(result.skills[0].source, `http://127.0.0.1:${port}/skills/relative/SKILL.md`)
      await registry.installSkillFromRegistry('demo', entry.id, { confirm: true })
      assert.equal((await registry.listInstalledRegistrySkills())[0].id, entry.id)
    })
  } finally {
    server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('phase 10: blocked remote skill content cannot be installed even when its digest and metadata match', async () => {
  const home = await tempHome()
  const content = safeSkill('blocked')
  const entry = { id: 'demo/blocked', name: 'blocked', description: 'Blocked skill', trust: 'community', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/blocked/SKILL.md', sha256: sha(content) }
  const document = { version: 1, skills: [entry] }
  const provider = providerFor(document, { [entry.source]: content })
  provider.fetchSkill = async (url) => ({ content, sha256: sha(content), securityStatus: 'blocked', securityFindings: [{ code: 'scanner.safety_bypass', line: 3, message: 'blocked' }], bytes: Buffer.byteLength(content), url })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await assert.rejects(() => registry.installSkillFromRegistry('demo', entry.id, { provider, confirm: true }), /blocked by content security policy/)
      assert.deepEqual(await registry.listInstalledRegistrySkills(), [])
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('phase 10: revocation-list fetch failures fail closed when no known-good list exists', async () => {
  const home = await tempHome()
  const content = safeSkill('revocation-offline')
  const entry = { id: 'demo/revocation-offline', name: 'revocation-offline', description: 'Revocation failure', trust: 'verified', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/revocation-offline/SKILL.md', sha256: sha(content) }
  const provider = providerFor({ version: 1, skills: [entry] }, { [entry.source]: content })
  provider.fetchRevocations = async () => { throw new Error('revocation endpoint unavailable') }
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await assert.rejects(() => registry.listRegistrySkills('demo', { provider }), /Unable to obtain the skill revocation list/)
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('phase 10: tampered cached SKILL.md is never trusted as an offline install', async () => {
  const home = await tempHome()
  const content = safeSkill('tamper')
  const entry = { id: 'demo/tamper', name: 'tamper', description: 'Tamper test', trust: 'verified', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/tamper/SKILL.md', sha256: sha(content) }
  const first = providerFor({ version: 1, skills: [entry] }, { [entry.source]: content })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await registry.installSkillFromRegistry('demo', entry.id, { provider: first, confirm: true })
      await registry.uninstallRegistrySkill(entry.id)
      const cacheFile = path.join(registry.getSkillRegistryCacheRoot(), 'skills', 'demo', 'tamper', '0.1.0', 'SKILL.md')
      await writeFile(cacheFile, safeSkill('tamper', '0.1.0', '\nTampered locally.'))
      const offline = {
        async fetchRegistry() { throw new Error('registry offline') },
        async fetchSkill() { throw new Error('skill network must not be used after cache tamper') },
        async fetchRevocations() { return [] },
      }
      await assert.rejects(() => registry.installSkillFromRegistry('demo', entry.id, { provider: offline, confirm: true, allowStale: true }), /skill network must not be used after cache tamper/)
      assert.deepEqual(await registry.listInstalledRegistrySkills(), [])
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('phase 10: symlinked install version directory is rejected before writing a pure skill', async () => {
  const home = await tempHome(); const outside = await tempHome('termagent-phase10-outside-')
  const content = safeSkill('symlink')
  const entry = { id: 'demo/symlink', name: 'symlink', description: 'Symlink target', trust: 'community', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/symlink/SKILL.md', sha256: sha(content) }
  const provider = providerFor({ version: 1, skills: [entry] }, { [entry.source]: content })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      const versionDir = path.join(registry.getSkillRegistryInstallRoot(), 'demo', 'symlink', '0.1.0')
      await mkdir(path.dirname(versionDir), { recursive: true })
      await symlink(outside, versionDir)
      await assert.rejects(() => registry.installSkillFromRegistry('demo', entry.id, { provider, confirm: true }), /symlink/)
      assert.deepEqual(await registry.listInstalledRegistrySkills(), [])
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('phase 10: stale registry metadata requires explicit override before installation', async () => {
  const home = await tempHome()
  const content = safeSkill('stale-install')
  const entry = { id: 'demo/stale-install', name: 'stale-install', description: 'Stale install', trust: 'verified', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/stale-install/SKILL.md', sha256: sha(content) }
  const provider = providerFor({ version: 1, skills: [entry] }, { [entry.source]: content })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await registry.refreshSkillRegistry('demo', { provider })
      const cache = path.join(registry.getSkillRegistryCacheRoot(), 'demo', 'registry.json')
      const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
      await utimes(cache, old, old)
      const offline = {
        async fetchRegistry() { throw new Error('registry offline for stale test') },
        async fetchSkill() { return { content, sha256: sha(content), securityStatus: 'clean', securityFindings: [], bytes: Buffer.byteLength(content), url: entry.source } },
        async fetchRevocations() { return [] },
      }
      await assert.rejects(() => registry.installSkillFromRegistry('demo', entry.id, { provider: offline, confirm: true }), /metadata is stale/)
      const installed = await registry.installSkillFromRegistry('demo', entry.id, { provider: offline, confirm: true, allowStale: true })
      assert.equal(installed.status, 'installed')
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})
test('phase 10: the default registry provider rejects a response redirected to a disallowed HTTP host', async () => {
  const registryModule = await import('../dist/skills/registry.js')
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      url: 'http://attacker.example/registry.json',
      headers: { get() { return null } },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[]'))
          controller.close()
        },
      }),
    })
    const provider = registryModule.createSkillRegistryProvider()
    await assert.rejects(() => provider.fetchRegistry('https://trusted.example/registry.json'), /must use https unless it targets localhost/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('phase 10: tampered installed registry state cannot redirect catalog or removal outside the registry root', async () => {
  const home = await tempHome(); const outside = await tempHome('termagent-phase10-outside-installed-')
  const project = await tempHome('termagent-phase10-project-')
  const content = safeSkill('state-tamper')
  const entry = { id: 'demo/state-tamper', name: 'state-tamper', description: 'State tamper', trust: 'verified', version: '0.1.0', license: 'MIT', source: 'https://skills.example.invalid/state-tamper/SKILL.md', sha256: sha(content) }
  const provider = providerFor({ version: 1, skills: [entry] }, { [entry.source]: content })
  try {
    await withHome(home, async () => {
      const registry = await import('../dist/skills/registry.js')
      const catalogMod = await import('../dist/skills/catalog.js')
      await registry.addSkillRegistry('demo', 'https://registry.example.invalid/registry.json')
      await registry.installSkillFromRegistry('demo', entry.id, { provider, confirm: true })

      const installedFile = path.join(home, '.termagent', 'skill-registries', 'installed.json')
      const state = JSON.parse(await (await import('node:fs/promises')).readFile(installedFile, 'utf8'))
      const outsideSkill = path.join(outside, 'SKILL.md')
      await writeFile(outsideSkill, content)
      state.skills[entry.id].path = outsideSkill
      await writeFile(installedFile, JSON.stringify(state, null, 2))

      const catalog = await catalogMod.loadSkillCatalog(project)
      assert.equal(catalog.get(entry.id), undefined)
      const verified = await registry.verifyInstalledRegistrySkill(entry.id)
      assert.equal(verified.ok, false)
      assert.match(verified.reason, /install root|unsafe registry skill path/)
      await assert.rejects(() => registry.uninstallRegistrySkill(entry.id), /unsafe registry skill path/)
      assert.equal(await (await import('node:fs/promises')).readFile(outsideSkill, 'utf8'), content)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})
test('phase 10: default provider enforces the remote payload size cap while allowing localhost HTTP fixtures', async () => {
  const registryModule = await import('../dist/skills/registry.js')
  const previousFetch = globalThis.fetch
  try {
    const provider = registryModule.createSkillRegistryProvider()
    const oldMax = 512 * 1024
    const huge = new Uint8Array(oldMax + 1)
    huge.fill(65)
    globalThis.fetch = async url => ({
      ok: true,
      status: 200,
      url: String(url),
      headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(huge.byteLength) : null } },
      body: new ReadableStream({
        start(controller) { controller.enqueue(huge); controller.close() },
      }),
    })
    await assert.rejects(
      () => provider.fetchRegistry('https://trusted.example/registry.json'),
      /maximum supported size|exceeds the maximum supported size/,
    )

    const localhostRaw = JSON.stringify({ version: 1, skills: [] })
    globalThis.fetch = async url => ({
      ok: true,
      status: 200,
      url: String(url),
      headers: { get() { return null } },
      body: new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(localhostRaw)); controller.close() },
      }),
    })
    const local = provider.fetchRegistry('http://localhost:17817/registry.json')
    const localResult = await local
    assert.deepEqual(localResult.document.skills, [])
  } finally {
    globalThis.fetch = previousFetch
  }
})
