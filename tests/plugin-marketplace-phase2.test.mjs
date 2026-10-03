import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, access, stat } from 'node:fs/promises'
import {
  addMarketplaceSource,
  assertMarketplaceManifest,
  getMarketplace,
  knownMarketplacesPath,
  loadInstalledPlugins,
  loadKnownMarketplaces,
  loadKnownMarketplacesSafe,
  refreshMarketplace,
  removeMarketplace,
  validateMarketplaceSource,
} from '../dist/plugins/marketplace.js'
import { getPluginState, installPlugin, removePlugin, reconcileInstalledPlugins } from '../dist/plugins/plugin-install.js'

async function tempHome(prefix = 'termagent-phase2-') {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function makeGitMarketplace(root, { marketplaceName = 'demo-marketplace', pluginName = 'demo-plugin', version = '1.0.0', body = '# Demo\n' } = {}) {
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
  await mkdir(path.join(root, 'plugins', pluginName, '.claude-plugin'), { recursive: true })
  await writeFile(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: marketplaceName,
    owner: { name: 'Test Owner' },
    plugins: [{ name: pluginName, source: `./plugins/${pluginName}`, version }],
  }, null, 2))
  await writeFile(path.join(root, 'plugins', pluginName, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: pluginName,
    version,
    description: 'Test plugin',
  }, null, 2))
  await writeFile(path.join(root, 'plugins', pluginName, 'README.md'), body)
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'termagent@example.invalid'])
  git(root, ['config', 'user.name', 'TermAgent Test'])
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'initial'])
  return git(root, ['rev-parse', 'HEAD'])
}

async function closeServer(server) {
  await new Promise(resolve => server.close(resolve))
}

async function withHome(home, fn) {
  const old = process.env.HOME
  process.env.HOME = home
  try { return await fn() } finally { process.env.HOME = old }
}

test('marketplace manifest accepts compatible plugin source variants', () => {
  const manifest = assertMarketplaceManifest({
    name: 'catalog',
    owner: { name: 'Owner' },
    plugins: [
      { name: 'local', source: './plugins/local', version: '1.0.0' },
      { name: 'npm-plugin', source: { source: 'npm', package: 'demo-pkg', version: '^1.0.0' } },
      { name: 'pip-plugin', source: { source: 'pip', package: 'demo-pip', version: '==1.0.0' } },
      { name: 'git-plugin', source: { source: 'git-subdir', url: 'https://example.invalid/repo.git', path: 'plugins/git-plugin', ref: 'main' } },
    ],
  })
  assert.equal(manifest.plugins.length, 4)
  assert.equal(manifest.plugins[2].source.source, 'pip')
})

test('marketplace validation rejects traversal, bad names, and unsafe sparse paths', () => {
  assert.throws(() => assertMarketplaceManifest({ name: '../catalog', owner: { name: 'x' }, plugins: [] }), /unsafe identifier/i)
  assert.throws(() => assertMarketplaceManifest({ name: 'catalog', owner: { name: 'x' }, plugins: [{ name: 'p', source: '../secret' }] }), /must start with/i)
  assert.throws(() => assertMarketplaceManifest({ name: 'catalog', owner: { name: 'x' }, plugins: [{ name: 'p', source: { source: 'git', url: 'https://example.invalid/repo.git', sparsePaths: ['../outside'] } }] }), /unsafe path/i)
  assert.throws(() => validateMarketplaceSource({ source: 'github', repo: 'https://evil.example/anthropics/repo' }), /owner\/repository/i)
})

test('directory marketplace is persisted and repeated registration is idempotent', async () => {
  const home = await tempHome()
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'termagent-marketplace-dir-'))
  try {
    await mkdir(path.join(sourceRoot, '.claude-plugin'), { recursive: true })
    await mkdir(path.join(sourceRoot, 'plugins', 'demo', '.claude-plugin'), { recursive: true })
    await writeFile(path.join(sourceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'local-marketplace', owner: { name: 'Owner' }, plugins: [{ name: 'demo', source: './plugins/demo' }] }))
    await writeFile(path.join(sourceRoot, 'plugins', 'demo', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await withHome(home, async () => {
      const first = await addMarketplaceSource({ source: 'directory', path: sourceRoot })
      const second = await addMarketplaceSource({ source: 'directory', path: sourceRoot })
      assert.equal(first.alreadyMaterialized, false)
      assert.equal(second.alreadyMaterialized, true)
      const state = await loadKnownMarketplaces()
      assert.equal(state['local-marketplace'].installLocation, path.resolve(sourceRoot))
      assert.equal(state['local-marketplace'].status, 'ready')
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(sourceRoot, { recursive: true, force: true })
  }
})

test('file marketplace resolves .claude-plugin/marketplace.json without treating it as a cache-relative path', async () => {
  const home = await tempHome()
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-marketplace-file-'))
  const file = path.join(root, '.claude-plugin', 'marketplace.json')
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ name: 'file-marketplace', owner: { name: 'Owner' }, plugins: [] }))
    await withHome(home, async () => {
      const result = await addMarketplaceSource({ source: 'file', path: file })
      const loaded = await getMarketplace('file-marketplace')
      assert.equal(result.installLocation, root)
      assert.equal(loaded.marketplace.name, 'file-marketplace')
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('URL marketplace cache is atomic and failed refresh preserves the previous good cache', async () => {
  const home = await tempHome()
  let mode = 'good'
  const server = http.createServer((req, res) => {
    if (req.url !== '/marketplace.json') { res.statusCode = 404; res.end(); return }
    if (mode === 'good') {
      const body = JSON.stringify({ name: 'url-marketplace', owner: { name: 'Owner' }, plugins: [] })
      res.setHeader('content-type', 'application/json')
      res.end(body)
    } else {
      res.statusCode = 500
      res.end('broken')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await withHome(home, async () => {
      const source = { source: 'url', url: `http://127.0.0.1:${port}/marketplace.json` }
      const added = await addMarketplaceSource(source)
      const cachedManifest = path.join(added.installLocation, '.claude-plugin', 'marketplace.json')
      const before = await readFile(cachedManifest, 'utf8')
      mode = 'bad'
      await assert.rejects(() => refreshMarketplace('url-marketplace'), /HTTP 500/i)
      const after = await readFile(cachedManifest, 'utf8')
      assert.equal(after, before)
      const state = await loadKnownMarketplaces()
      assert.equal(state['url-marketplace'].status, 'broken')
      assert.match(state['url-marketplace'].error, /HTTP 500/i)
    })
  } finally {
    await closeServer(server)
    await rm(home, { recursive: true, force: true })
  }
})

test('git marketplace supports shallow checkout, sparse paths, and recorded SHA', async () => {
  const home = await tempHome()
  const remote = await mkdtemp(path.join(os.tmpdir(), 'termagent-git-marketplace-'))
  try {
    const sha = await makeGitMarketplace(remote)
    await mkdir(path.join(remote, 'outside'), { recursive: true })
    await writeFile(path.join(remote, 'outside', 'outside.bin'), 'large-ish outside content')
    git(remote, ['add', '.'])
    git(remote, ['commit', '-q', '-m', 'outside'])
    await withHome(home, async () => {
      const sparseResult = await addMarketplaceSource({ source: 'git', url: pathToFileURL(remote).href, sparsePaths: ['.claude-plugin', 'plugins'] })
      assert.equal((await stat(path.join(sparseResult.installLocation, '.claude-plugin', 'marketplace.json'))).isFile(), true)
      await assert.rejects(access(path.join(sparseResult.installLocation, 'outside', 'outside.bin')))

      const recorded = await addMarketplaceSource({ source: 'git', url: pathToFileURL(remote).href, sha })
      const recordedState = await loadKnownMarketplaces()
      assert.equal(recordedState['demo-marketplace'].revision, sha)
      assert.ok(recorded.installLocation.endsWith(path.join('marketplaces', 'cache', 'demo-marketplace')))
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('remote marketplace plugin install requires explicit third-party confirmation and records digest/revision', async () => {
  const home = await tempHome()
  const remote = await mkdtemp(path.join(os.tmpdir(), 'termagent-install-git-'))
  try {
    const sha = await makeGitMarketplace(remote)
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'git', url: pathToFileURL(remote).href, sha })
      const blocked = await installPlugin('demo-marketplace', 'demo-plugin')
      assert.equal(blocked.status, 'not-installed')
      assert.match(blocked.error, /confirmation is required/i)
      assert.equal(Object.keys((await loadInstalledPlugins()).plugins).length, 0)

      const installed = await installPlugin('demo-marketplace', 'demo-plugin', { thirdPartyConfirmed: true })
      assert.equal(installed.status, 'installed')
      assert.equal(installed.revision, sha)
      assert.match(installed.digest, /^sha256:[a-f0-9]{64}$/)
      const persisted = await loadInstalledPlugins()
      assert.equal(persisted.plugins['demo-plugin@demo-marketplace'].revision, sha)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  }
})

test('local marketplace install, update detection, and broken install are transaction-safe', async () => {
  const home = await tempHome()
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-local-install-'))
  try {
    await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
    await mkdir(path.join(root, 'plugins', 'demo', '.claude-plugin'), { recursive: true })
    await writeFile(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'local', owner: { name: 'Owner' }, plugins: [{ name: 'demo', source: './plugins/demo', version: '1.0.0' }] }))
    await writeFile(path.join(root, 'plugins', 'demo', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await writeFile(path.join(root, 'plugins', 'demo', 'body.txt'), 'v1')
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      const first = await installPlugin('local', 'demo')
      assert.equal(first.status, 'installed')
      const originalPath = first.installPath
      await writeFile(path.join(root, 'plugins', 'demo', 'body.txt'), 'v2')
      const updated = await getPluginState('local', 'demo')
      assert.equal(updated.status, 'update-available')

      const second = await installPlugin('local', 'demo')
      assert.equal(second.status, 'installed')
      assert.notEqual(second.installPath, originalPath)
      assert.notEqual(second.digest, first.digest)

      await writeFile(path.join(root, 'plugins', 'demo', '.claude-plugin', 'plugin.json'), '{bad json')
      await assert.rejects(() => installPlugin('local', 'demo'), /Invalid JSON/i)
      const persisted = await loadInstalledPlugins()
      assert.equal(persisted.plugins['demo@local'].installPath, second.installPath)
      assert.equal((await readFile(path.join(second.installPath, '.claude-plugin', 'plugin.json'), 'utf8')).includes('1.0.0'), true)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('installed plugin paths outside the private installation root are reported as broken instead of read', async () => {
  const home = await tempHome()
  try {
    await withHome(home, async () => {
      const statePath = path.join(home, '.termagent', 'plugins', 'installed.json')
      await mkdir(path.dirname(statePath), { recursive: true })
      await writeFile(statePath, JSON.stringify({ version: 1, plugins: {
        'demo@market': {
          id: 'demo@market', marketplace: 'market', plugin: 'demo', source: './demo',
          installPath: path.resolve(home, '..', 'outside'), version: '1.0.0',
          digest: `sha256:${'a'.repeat(64)}`, installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString(), status: 'installed',
        },
      } }))
      const result = await reconcileInstalledPlugins()
      assert.equal(result[0].status, 'orphaned')
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('broken marketplace state is recoverable without overwriting corrupted registration data', async () => {
  const home = await tempHome()
  try {
    await withHome(home, async () => {
      await mkdir(path.dirname(knownMarketplacesPath()), { recursive: true })
      const bad = '{broken-json\n'
      await writeFile(knownMarketplacesPath(), bad)
      await assert.rejects(() => loadKnownMarketplaces(), /Failed to load known marketplaces|Unexpected token/i)
      assert.deepEqual(await loadKnownMarketplacesSafe(), {})
      assert.equal(await readFile(knownMarketplacesPath(), 'utf8'), bad)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('removing a marketplace leaves installed plugin metadata orphaned until explicitly removed', async () => {
  const home = await tempHome()
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-remove-market-'))
  try {
    await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
    await mkdir(path.join(root, 'plugins', 'demo', '.claude-plugin'), { recursive: true })
    await writeFile(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'remove-me', owner: { name: 'Owner' }, plugins: [{ name: 'demo', source: './plugins/demo' }] }))
    await writeFile(path.join(root, 'plugins', 'demo', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      await installPlugin('remove-me', 'demo')
      await removeMarketplace('remove-me')
      const state = await getPluginState('remove-me', 'demo')
      assert.equal(state.status, 'orphaned')
      await removePlugin('remove-me', 'demo')
      assert.equal((await loadInstalledPlugins()).plugins['demo@remove-me'], undefined)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('reconcileInstalledPlugins persists dynamically detected status', async () => {
  const home = await tempHome()
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-reconcile-'))
  try {
    await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
    await mkdir(path.join(root, 'plugins', 'demo', '.claude-plugin'), { recursive: true })
    await writeFile(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'reconcile', owner: { name: 'Owner' }, plugins: [{ name: 'demo', source: './plugins/demo' }] }))
    await writeFile(path.join(root, 'plugins', 'demo', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await withHome(home, async () => {
      await addMarketplaceSource({ source: 'directory', path: root })
      const installed = await installPlugin('reconcile', 'demo')
      await rm(installed.installPath, { recursive: true, force: true })
      const states = await reconcileInstalledPlugins()
      assert.equal(states[0].status, 'broken')
      const persisted = await loadInstalledPlugins()
      assert.equal(persisted.plugins['demo@reconcile'].status, 'broken')
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})
