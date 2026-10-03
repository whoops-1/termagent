import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import {
  addMarketplaceSource,
  getMarketplaceAutoUpdate,
  defaultMarketplaceAutoUpdate,
  loadInstalledPlugins,
  setMarketplaceAutoUpdate,
} from '../dist/plugins/marketplace.js'
import { installPlugin, getPluginState } from '../dist/plugins/plugin-install.js'
import { cleanupInterruptedPluginOperations } from '../dist/plugins/reconcile.js'
import { resolveDependencyClosure } from '../dist/plugins/dependency-resolver.js'
import { updateConfiguredPlugins } from '../dist/plugins/updates.js'
import { loadInstalledPluginComponents } from '../dist/plugins/components.js'
import { reconcileInstalledPluginState } from '../dist/plugins/reconcile.js'

async function tempHome(prefix = 'termagent-phase8-') { return mkdtemp(path.join(os.tmpdir(), prefix)) }
async function withHome(home, fn) { const old = process.env.HOME; process.env.HOME = home; try { return await fn() } finally { process.env.HOME = old } }

async function makeMarketplace(root, {
  marketplaceName = 'demo-marketplace',
  plugins = [
    { name: 'demo-plugin', version: '1.0.0', dependencies: [] },
  ],
  allowCrossMarketplaceDependenciesOn,
} = {}) {
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
  for (const plugin of plugins) {
    const pluginRoot = path.join(root, 'plugins', plugin.name)
    await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: plugin.manifestName || plugin.name,
      version: plugin.version,
      description: plugin.description || `${plugin.name} plugin`,
      ...(plugin.commands ? { commands: './commands' } : {}),
    }, null, 2))
    await writeFile(path.join(pluginRoot, 'README.md'), plugin.body || plugin.name)
    if (plugin.commands) {
      await mkdir(path.join(pluginRoot, 'commands'), { recursive: true })
      await writeFile(path.join(pluginRoot, 'commands', 'check.md'), '---\ndescription: Check\n---\ncheck')
    }
  }
  await writeFile(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: marketplaceName,
    owner: { name: 'Phase 8 Test' },
    plugins: plugins.map(plugin => ({
      name: plugin.name,
      source: `./plugins/${plugin.name}`,
      version: plugin.version,
      ...(plugin.dependencies?.length ? { dependencies: plugin.dependencies } : {}),
    })),
    ...(allowCrossMarketplaceDependenciesOn ? { allowCrossMarketplaceDependenciesOn } : {}),
  }, null, 2))
}

 test('dependency resolver produces deterministic dependency-first order', async () => {
  const marketplaces = new Map([
    ['alpha', {
      name: 'alpha', owner: { name: 'x' }, plugins: [
        { name: 'root', source: './root', dependencies: ['mid', 'leaf'] },
        { name: 'mid', source: './mid', dependencies: ['leaf'] },
        { name: 'leaf', source: './leaf', dependencies: [] },
      ],
    }],
  ])
  const result = await resolveDependencyClosure('root@alpha', marketplaces)
  assert.equal(result.ok, true)
  assert.deepEqual(result.closure, ['leaf@alpha', 'mid@alpha', 'root@alpha'])

  const withActivePendingUpdate = await resolveDependencyClosure(
    'root@alpha',
    marketplaces,
    new Set(['mid@alpha']),
  )
  assert.equal(withActivePendingUpdate.ok, true)
  assert.deepEqual(withActivePendingUpdate.closure, ['leaf@alpha', 'root@alpha'])
})

test('dependency resolver detects cycles and missing dependencies', async () => {
  const cycle = new Map([['alpha', { name: 'alpha', owner: { name: 'x' }, plugins: [
    { name: 'a', source: './a', dependencies: ['b'] },
    { name: 'b', source: './b', dependencies: ['a'] },
  ] }]])
  const cycleResult = await resolveDependencyClosure('a@alpha', cycle)
  assert.equal(cycleResult.ok, false)
  assert.equal(cycleResult.error.reason, 'cycle')

  const missing = new Map([['alpha', { name: 'alpha', owner: { name: 'x' }, plugins: [
    { name: 'a', source: './a', dependencies: ['missing'] },
  ] }]])
  const missingResult = await resolveDependencyClosure('a@alpha', missing)
  assert.equal(missingResult.ok, false)
  assert.equal(missingResult.error.reason, 'not-found')
})

test('cross-marketplace dependencies require an explicit root allowlist', async () => {
  const restricted = new Map([
    ['a', { name: 'a', owner: { name: 'x' }, plugins: [{ name: 'root', source: './root', dependencies: ['helper@b'] }] }],
    ['b', { name: 'b', owner: { name: 'x' }, plugins: [{ name: 'helper', source: './helper', dependencies: [] }] }],
  ])
  let result = await resolveDependencyClosure('root@a', restricted)
  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'cross-marketplace')

  restricted.get('a').allowCrossMarketplaceDependenciesOn = ['b']
  result = await resolveDependencyClosure('root@a', restricted)
  assert.equal(result.ok, true)
  assert.deepEqual(result.closure, ['helper@b', 'root@a'])
})

test('multi-plugin install rolls back already-installed dependencies on later failure', async () => {
  const home = await tempHome()
  const root = await tempHome('termagent-phase8-marketplace-')
  try {
    await makeMarketplace(root, {
      plugins: [
        { name: 'root', version: '1.0.0', dependencies: ['good', 'bad'] },
        { name: 'good', version: '1.0.0' },
        { name: 'bad', version: '1.0.0', manifestName: 'different-name' },
      ],
    })
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      await assert.rejects(() => installPlugin('demo-marketplace', 'root'), /does not match marketplace entry|manifest name/i)
      const installed = await loadInstalledPlugins()
      assert.deepEqual(Object.keys(installed.plugins), [])
      const goodPath = path.join(home, '.termagent', 'plugins', 'cache', 'demo-marketplace', 'good')
      const goodEntries = await (await import('node:fs/promises')).readdir(goodPath, { withFileTypes: true }).catch(() => [])
      assert.deepEqual(goodEntries, [])
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
})

test('plugin lifecycle writes are serialized under concurrent installs', async () => {
  const home = await tempHome()
  const root = await tempHome('termagent-phase8-concurrent-')
  try {
    await makeMarketplace(root, { plugins: [
      { name: 'alpha', version: '1.0.0' },
      { name: 'beta', version: '1.0.0' },
    ] })
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      const [a, b] = await Promise.all([
        installPlugin('demo-marketplace', 'alpha'),
        installPlugin('demo-marketplace', 'beta'),
      ])
      assert.equal(a.status, 'installed')
      assert.equal(b.status, 'installed')
      const state = await loadInstalledPlugins()
      assert.deepEqual(Object.keys(state.plugins).sort(), ['alpha@demo-marketplace', 'beta@demo-marketplace'])
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
})
test('update-available plugins remain active until the new version is committed', async () => {
  const home = await tempHome()
  const root = await tempHome('termagent-phase8-active-update-')
  try {
    await makeMarketplace(root, { plugins: [{ name: 'active', version: '1.0.0', body: 'one', commands: true }] })
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      const first = await installPlugin('demo-marketplace', 'active')
      assert.equal(first.status, 'installed')

      await writeFile(path.join(root, 'plugins', 'active', 'README.md'), 'two')
      const state = await getPluginState('demo-marketplace', 'active')
      assert.equal(state.status, 'update-available')
      const loaded = await loadInstalledPluginComponents()
      assert.deepEqual(loaded.commands.map(command => command.name), ['active:check'])
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
})

test('startup reconciliation marks deleted plugins orphaned and disabled dependencies broken', async () => {
  const home = await tempHome()
  const root = await tempHome('termagent-phase8-reconcile-')
  try {
    await makeMarketplace(root, { plugins: [
      { name: 'base', version: '1.0.0' },
      { name: 'consumer', version: '1.0.0', dependencies: ['base'] },
      { name: 'deleted', version: '1.0.0' },
    ] })
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      await installPlugin('demo-marketplace', 'consumer')
      await installPlugin('demo-marketplace', 'deleted')
      const installed = await loadInstalledPlugins()
      installed.plugins['base@demo-marketplace'] = {
        id: 'base@demo-marketplace', marketplace: 'demo-marketplace', plugin: 'base',
        source: './plugins/base', installPath: path.join(home, '.termagent', 'plugins', 'cache', 'demo-marketplace', 'base', 'missing'),
        version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(), status: 'orphaned', enabled: false,
      }
      await (await import('../dist/plugins/marketplace.js')).saveInstalledPlugins(installed)
      const marketplaceManifestPath = path.join(root, '.claude-plugin', 'marketplace.json')
      const marketplaceManifest = JSON.parse(await readFile(marketplaceManifestPath, 'utf8'))
      marketplaceManifest.plugins = marketplaceManifest.plugins.filter(plugin => plugin.name !== 'deleted')
      await writeFile(marketplaceManifestPath, JSON.stringify(marketplaceManifest))

      const result = await reconcileInstalledPluginState()
      assert.ok(result.dependencyBroken.includes('consumer@demo-marketplace'))
      assert.ok(result.changed.includes('deleted@demo-marketplace'))
      const after = await loadInstalledPlugins()
      assert.equal(after.plugins['deleted@demo-marketplace'].status, 'orphaned')
      assert.equal(after.plugins['consumer@demo-marketplace'].status, 'broken')
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
})

test('recorded plugin revision changes are reported as an available update', async () => {
  const home = await tempHome()
  const marketplaceRoot = await tempHome('termagent-phase8-recorded-marketplace-')
  const pluginRoot = await tempHome('termagent-phase8-recorded-plugin-')
  try {
    const { execFileSync } = await import('node:child_process')
    const { pathToFileURL } = await import('node:url')
    const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim()
    await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'remote', version: '1.0.0', description: 'remote' }))
    await writeFile(path.join(pluginRoot, 'README.md'), 'one')
    git(pluginRoot, ['init', '-q']); git(pluginRoot, ['config', 'user.email', 'test@example.invalid']); git(pluginRoot, ['config', 'user.name', 'TermAgent Test']); git(pluginRoot, ['add', '.']); git(pluginRoot, ['commit', '-q', '-m', 'one'])
    const firstSha = git(pluginRoot, ['rev-parse', 'HEAD'])
    await mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })
    await writeFile(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'recorded-marketplace', owner: { name: 'Phase 8 Test' }, plugins: [{ name: 'remote', source: { source: 'git', url: pathToFileURL(pluginRoot).href, sha: firstSha }, version: '1.0.0' }] }))
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: marketplaceRoot })
      const first = await installPlugin('recorded-marketplace', 'remote', { thirdPartyConfirmed: true })
      assert.equal(first.status, 'installed')

      await writeFile(path.join(pluginRoot, 'README.md'), 'two')
      git(pluginRoot, ['add', 'README.md']); git(pluginRoot, ['commit', '-q', '-m', 'two'])
      const secondSha = git(pluginRoot, ['rev-parse', 'HEAD'])
      const manifest = JSON.parse(await readFile(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), 'utf8'))
      manifest.plugins[0].source.sha = secondSha
      await writeFile(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify(manifest))
      await (await import('../dist/plugins/marketplace.js')).refreshMarketplace('recorded-marketplace')

      const state = await getPluginState('recorded-marketplace', 'remote')
      assert.equal(state.status, 'update-available')
      assert.equal(state.revision, firstSha)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(marketplaceRoot, { recursive: true, force: true }); await rm(pluginRoot, { recursive: true, force: true }) }
})

test('auto-update can be disabled globally without refreshing marketplaces', async () => {
  const home = await tempHome()
  const root = await tempHome('termagent-phase8-autoupdate-disabled-')
  try {
    await makeMarketplace(root, { plugins: [{ name: 'auto', version: '1.0.0', body: 'one' }] })
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      await setMarketplaceAutoUpdate('demo-marketplace', true)
      const previous = process.env.TERMAGENT_AUTO_UPDATE
      process.env.TERMAGENT_AUTO_UPDATE = '0'
      try {
        const result = await updateConfiguredPlugins()
        assert.deepEqual(result.refreshed, [])
        assert.deepEqual(result.updated, [])
      } finally {
        if (previous === undefined) delete process.env.TERMAGENT_AUTO_UPDATE
        else process.env.TERMAGENT_AUTO_UPDATE = previous
      }
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
})

test('startup cleanup removes abandoned marketplace and plugin staging directories', async () => {
  const home = await tempHome()
  try {
    await withHome(home, async () => {
      const marketplaceTmp = path.join(home, '.termagent', 'marketplaces', 'cache', '.marketplace-refresh.tmp-123')
      const pluginTmp = path.join(home, '.termagent', 'plugins', 'cache', 'demo', 'plugin', '.install-123-abcd')
      await mkdir(marketplaceTmp, { recursive: true })
      await mkdir(pluginTmp, { recursive: true })
      await writeFile(path.join(marketplaceTmp, 'partial.json'), '{}')
      await writeFile(path.join(pluginTmp, 'partial'), 'x')
      const removed = await cleanupInterruptedPluginOperations()
      assert.equal(removed.length, 2)
      await assert.rejects(() => access(marketplaceTmp))
      await assert.rejects(() => access(pluginTmp))
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('auto-update defaults off for third-party marketplaces and is configurable', async () => {
  assert.equal(defaultMarketplaceAutoUpdate('community-marketplace', { source: 'github', repo: 'community/tools' }), false)
  assert.equal(defaultMarketplaceAutoUpdate('claude-plugins-official', { source: 'github', repo: 'anthropics/claude-plugins-official' }), true)

  const home = await tempHome()
  const root = await tempHome('termagent-phase8-autoupdate-')
  try {
    await makeMarketplace(root, { plugins: [{ name: 'auto', version: '1.0.0', body: 'one' }] })
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      assert.equal(await getMarketplaceAutoUpdate('demo-marketplace'), false)
      assert.equal(await setMarketplaceAutoUpdate('demo-marketplace', true), true)
      assert.equal(await getMarketplaceAutoUpdate('demo-marketplace'), true)
      assert.equal(await setMarketplaceAutoUpdate('demo-marketplace', false), false)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
})

test('configured auto-update refreshes and installs a changed local plugin', async () => {
  const home = await tempHome()
  const root = await tempHome('termagent-phase8-update-')
  try {
    await makeMarketplace(root, { plugins: [{ name: 'auto', version: '1.0.0', body: 'one' }] })
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      await setMarketplaceAutoUpdate('demo-marketplace', true)
      const first = await installPlugin('demo-marketplace', 'auto')
      assert.equal(first.status, 'installed')

      await writeFile(path.join(root, 'plugins', 'auto', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'auto', version: '1.1.0', description: 'updated' }, null, 2))
      await writeFile(path.join(root, 'plugins', 'auto', 'README.md'), 'two')

      const before = await getPluginState('demo-marketplace', 'auto')
      assert.equal(before.status, 'update-available')
      const result = await updateConfiguredPlugins()
      assert.deepEqual(result.refreshed, ['demo-marketplace'])
      assert.deepEqual(result.updated, ['auto@demo-marketplace'])
      const after = await getPluginState('demo-marketplace', 'auto')
      assert.equal(after.status, 'installed')
      assert.equal(after.version, '1.1.0')
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
})
