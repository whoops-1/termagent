import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function tempDir(prefix) { return mkdtemp(path.join(os.tmpdir(), prefix)) }
async function withHome(home, fn) { const previous=process.env.HOME; process.env.HOME=home; try{return await fn()}finally{process.env.HOME=previous} }

async function writePluginVersion(root, version, skillText) {
  const pluginRoot = path.join(root, 'plugins', 'lifecycle')
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
  await mkdir(path.join(pluginRoot, 'skills', 'lifecycle-skill'), { recursive: true })
  await writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'lifecycle', version, description: 'Phase 11 lifecycle fixture', skills: './skills',
  }, null, 2))
  await writeFile(path.join(pluginRoot, 'skills', 'lifecycle-skill', 'SKILL.md'), `---\ndescription: lifecycle fixture skill\n---\n\n# Lifecycle\n\n${skillText}\n`)
}

async function makeMarketplace(root, version='1.0.0', skillText='version one') {
  await writePluginVersion(root, version, skillText)
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
  await writeFile(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'fixture-lifecycle', owner: { name: 'Phase 11' },
    plugins: [{ name: 'lifecycle', source: './plugins/lifecycle', version }],
  }, null, 2))
}

test('end-to-end plugin lifecycle: install → enable → discover → use → update → disable → remove', async () => {
  const home = await tempDir('termagent-phase11-e2e-home-')
  const project = await tempDir('termagent-phase11-e2e-project-')
  const marketplace = await tempDir('termagent-phase11-e2e-marketplace-')
  try {
    await makeMarketplace(marketplace, '1.0.0', 'version one')
    await withHome(home, async () => {
      const { addMarketplaceSource } = await import('../dist/plugins/marketplace.js')
      const { installPlugin, setPluginEnabled, removePlugin, getPluginState } = await import('../dist/plugins/plugin-install.js')
      const { loadInstalledPlugins } = await import('../dist/plugins/marketplace.js')
      const { loadSkillCatalog } = await import('../dist/skills/catalog.js')
      const { loadSkill } = await import('../dist/skills/invoker.js')

      await addMarketplaceSource({ source: 'directory', path: marketplace })

      const installed = await installPlugin('fixture-lifecycle', 'lifecycle')
      assert.equal(installed.status, 'installed')
      assert.equal(installed.enabled, true)

      await setPluginEnabled('fixture-lifecycle', 'lifecycle', true)
      let catalog = await loadSkillCatalog(project, { includeLocalPlugins: false })
      assert.ok(catalog.list().some(skill => skill.id === 'lifecycle@fixture-lifecycle:lifecycle-skill'))

      const invoked = await loadSkill(project, 'lifecycle@fixture-lifecycle:lifecycle-skill')
      assert.match(invoked.content, /version one/)

      await writePluginVersion(marketplace, '1.1.0', 'version two')
      const pending = await getPluginState('fixture-lifecycle', 'lifecycle')
      assert.equal(pending.status, 'update-available')
      assert.equal(pending.enabled, true)

      const updated = await installPlugin('fixture-lifecycle', 'lifecycle', { thirdPartyConfirmed: true })
      assert.equal(updated.status, 'installed')
      assert.equal(updated.enabled, true)
      catalog = await loadSkillCatalog(project, { includeLocalPlugins: false })
      const afterUpdate = await loadSkill(project, 'lifecycle@fixture-lifecycle:lifecycle-skill')
      assert.match(afterUpdate.content, /version two/)

      await setPluginEnabled('fixture-lifecycle', 'lifecycle', false)
      catalog = await loadSkillCatalog(project, { includeLocalPlugins: false })
      assert.equal(catalog.list().some(skill => skill.id === 'lifecycle@fixture-lifecycle:lifecycle-skill'), false)
      await assert.rejects(() => loadSkill(project, 'lifecycle@fixture-lifecycle:lifecycle-skill'), /Unknown skill/)

      await setPluginEnabled('fixture-lifecycle', 'lifecycle', true)
      catalog = await loadSkillCatalog(project, { includeLocalPlugins: false })
      assert.ok(catalog.list().some(skill => skill.id === 'lifecycle@fixture-lifecycle:lifecycle-skill'))

      await removePlugin('fixture-lifecycle', 'lifecycle')
      const state = await loadInstalledPlugins()
      assert.equal(state.plugins['lifecycle@fixture-lifecycle'], undefined)
      catalog = await loadSkillCatalog(project, { includeLocalPlugins: false })
      assert.equal(catalog.list().some(skill => skill.id === 'lifecycle@fixture-lifecycle:lifecycle-skill'), false)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
    await rm(marketplace, { recursive: true, force: true })
  }
})
