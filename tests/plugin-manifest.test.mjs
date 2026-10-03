import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { assertPluginManifest, discoverPluginPackages, readPluginManifest, resolvePluginComponentPath } from '../dist/plugins/loader.js'

test('compatible plugin manifest validates and discovers without executing code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-plugin-manifest-'))
  try {
    const plugin = path.join(root, '.termagent', 'plugins', 'demo')
    await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true })
    await mkdir(path.join(plugin, 'skills', 'review'), { recursive: true })
    await writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'demo-plugin',
      version: '1.2.3',
      description: 'A demo plugin',
      author: { name: 'Test Author' },
      skills: ['./skills/review'],
      commands: { review: { source: './commands/review.md', description: 'Review code' } },
      dependencies: ['helper-plugin@community'],
    }))
    const { packages, errors } = await discoverPluginPackages(root)
    assert.equal(errors.length, 0)
    assert.equal(packages.length, 1)
    assert.equal(packages[0].manifest.name, 'demo-plugin')
    assert.equal(packages[0].manifestLocation, '.claude-plugin/plugin.json')
    assert.equal(packages[0].source, 'project')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native .termagent-plugin alias is accepted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-plugin-alias-'))
  try {
    await mkdir(path.join(root, '.termagent-plugin'), { recursive: true })
    await writeFile(path.join(root, '.termagent-plugin', 'plugin.json'), JSON.stringify({ name: 'native-alias' }))
    const result = await readPluginManifest(root)
    assert.equal(result.location, '.termagent-plugin/plugin.json')
    assert.equal(result.manifest.name, 'native-alias')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('manifest rejects unsafe component paths and duplicate paths', () => {
  assert.throws(() => assertPluginManifest({ name: 'unsafe', skills: ['../secret'] }), /must start with '\.\/'|unsafe path/i)
  assert.throws(() => assertPluginManifest({ name: 'unsafe', skills: ['./a', './a'] }), /duplicate path/i)
  assert.throws(() => assertPluginManifest({ name: 'unsafe', agents: ['/absolute'] }), /must be relative/i)
  assert.throws(() => assertPluginManifest({ name: 'unsafe', skills: ['C:/secret'] }), /must be relative/i)
})

test('manifest rejects malformed identity and metadata', () => {
  assert.throws(() => assertPluginManifest({ name: '../bad' }), /invalid plugin name/i)
  assert.throws(() => assertPluginManifest({ name: 'bad name' }), /invalid plugin name/i)
  assert.throws(() => assertPluginManifest({ name: 'bad', version: '1.2' }), /semver-like/i)
  assert.throws(() => assertPluginManifest({ name: 'bad', author: {} }), /author\.name.*required/i)
})

test('component paths resolve inside plugin root', () => {
  const root = path.join(os.tmpdir(), 'termagent-plugin-root')
  assert.equal(resolvePluginComponentPath(root, './skills/review'), path.join(root, 'skills', 'review'))
  assert.throws(() => resolvePluginComponentPath(root, './skills/../secret'), /unsafe path/i)
})
test('ambiguous dual manifest locations are rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-plugin-dual-'))
  try {
    await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
    await mkdir(path.join(root, '.termagent-plugin'), { recursive: true })
    await writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'dual-plugin' }))
    await writeFile(path.join(root, '.termagent-plugin', 'plugin.json'), JSON.stringify({ name: 'dual-plugin-native' }))
    await assert.rejects(() => readPluginManifest(root), /Ambiguous plugin package/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('package discovery never imports executable plugin files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-plugin-noexec-'))
  try {
    const plugin = path.join(root, '.termagent', 'plugins', 'nonexec')
    await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true })
    await writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'nonexec-plugin' }))
    await writeFile(path.join(plugin, 'index.mjs'), "throw new Error('plugin code must not execute during metadata discovery')")
    const result = await discoverPluginPackages(root)
    assert.equal(result.packages[0].manifest.name, 'nonexec-plugin')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('discovery reports malformed package but continues scanning siblings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-plugin-scan-'))
  try {
    const pluginsRoot = path.join(root, '.termagent', 'plugins')
    await mkdir(path.join(pluginsRoot, 'good', '.termagent-plugin'), { recursive: true })
    await mkdir(path.join(pluginsRoot, 'bad', '.claude-plugin'), { recursive: true })
    await writeFile(path.join(pluginsRoot, 'good', '.termagent-plugin', 'plugin.json'), JSON.stringify({ name: 'good-plugin' }))
    await writeFile(path.join(pluginsRoot, 'bad', '.claude-plugin', 'plugin.json'), '{not-json')
    const result = await discoverPluginPackages(root)
    assert.equal(result.packages.length, 1)
    assert.equal(result.packages[0].manifest.name, 'good-plugin')
    assert.equal(result.errors.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
