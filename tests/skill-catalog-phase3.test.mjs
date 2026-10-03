import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, symlink, writeFile, utimes, readFile } from 'node:fs/promises'
import { loadSkillCatalog, SkillCatalog, formatSkillDescriptors } from '../dist/skills/catalog.js'

async function withHome(home, fn) {
  const previous = process.env.HOME
  process.env.HOME = home
  try { return await fn() } finally { process.env.HOME = previous }
}

async function writeSkill(root, name, content) {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), content)
  return dir
}

test('catalog discovers project and global skills as descriptors without body injection', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'testing', '---\ndescription: Run focused tests\n---\n# Testing\nSECRET_BODY_SHOULD_NOT_APPEAR\n')
    await writeSkill(path.join(home, '.termagent', 'skills'), 'deploy', '# Deploy\n')
    await withHome(home, async () => {
      const catalog = await loadSkillCatalog(project)
      const list = catalog.list()
      assert.deepEqual(list.map(s => s.id), ['deploy', 'testing'])
      assert.equal(list.find(s => s.id === 'testing')?.description, 'Run focused tests')
      assert.equal(JSON.stringify(list).includes('SECRET_BODY_SHOULD_NOT_APPEAR'), false)
      assert.match(formatSkillDescriptors(list), /testing: Run focused tests/)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('project skill precedence beats .claude and global roots', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    await writeSkill(path.join(project, '.claude', 'skills'), 'same', '---\ndescription: project claude\n---\n')
    await writeSkill(path.join(project, '.termagent', 'skills'), 'same', '---\ndescription: project termagent\n---\n')
    await writeSkill(path.join(home, '.termagent', 'skills'), 'same', '---\ndescription: global\n---\n')
    await withHome(home, async () => {
      const catalog = await loadSkillCatalog(project)
      assert.equal(catalog.list().filter(s => s.id === 'same').length, 1)
      assert.equal(catalog.get('same').description, 'project termagent')
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('nested skill directories and symlinked skill directories are discovered once safely', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  const external = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-external-'))
  try {
    await writeSkill(path.join(project, '.termagent', 'skills', 'category'), 'nested', '# Nested\n')
    const internalTarget = await writeSkill(path.join(project, '.termagent', 'skills', 'shared'), 'linked', '# Linked\n')
    await mkdir(path.join(project, '.termagent', 'skills'), { recursive: true })
    await symlink(internalTarget, path.join(project, '.termagent', 'skills', 'linked'))
    await withHome(home, async () => {
      const catalog = await loadSkillCatalog(project)
      assert.deepEqual(catalog.list().map(s => s.id), ['linked', 'nested'])
      const details = catalog.get('linked')
      assert.equal(details.sha256.startsWith('sha256:'), true)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }) }
})

test('external symlink that escapes the configured skill root is ignored', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  const external = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-external-'))
  try {
    const linked = await writeSkill(external, 'escape', '# Escape\n')
    await mkdir(path.join(project, '.termagent', 'skills'), { recursive: true })
    await symlink(linked, path.join(project, '.termagent', 'skills', 'escape'))
    await withHome(home, async () => {
      assert.deepEqual((await loadSkillCatalog(project)).list(), [])
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }) }
})

test('malformed frontmatter degrades to a descriptor with warnings', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'broken', '---\ndescription without colon\n---\n# Fallback title\n')
    await withHome(home, async () => {
      const details = (await loadSkillCatalog(project)).get('broken')
      assert.equal(details.description, 'Fallback title')
      assert.ok(details.warnings.length > 0)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('descriptor cache preserves indexed details when path, mtime and size are unchanged', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    const dir = await writeSkill(path.join(project, '.termagent', 'skills'), 'cached', '---\ndescription: Cached\n---\n')
    await withHome(home, async () => {
      const first = await loadSkillCatalog(project)
      const a = first.get('cached')
      const second = await loadSkillCatalog(project)
      const b = second.get('cached')
      assert.equal(b.sha256, a.sha256)
      assert.equal(b.mtimeMs, a.mtimeMs)
      assert.equal(b.size, a.size)
      assert.equal(b.path, path.join(dir, 'SKILL.md'))
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('changed skill content invalidates digest and descriptor metadata', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    const dir = await writeSkill(path.join(project, '.termagent', 'skills'), 'changing', '---\ndescription: One\n---\n')
    await withHome(home, async () => {
      const first = await loadSkillCatalog(project)
      const old = first.get('changing')
      const file = path.join(dir, 'SKILL.md')
      await writeFile(file, '---\ndescription: Two\n---\n')
      const second = await loadSkillCatalog(project)
      const next = second.get('changing')
      assert.notEqual(next.sha256, old.sha256)
      assert.equal(next.description, 'Two')
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('plugin skills are namespaced and expose provenance without body content', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    const pluginRoot = path.join(home, '.termagent', 'plugins', 'demo')
    await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await mkdir(path.join(pluginRoot, 'skills'), { recursive: true })
    await writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }))
    await writeFile(path.join(pluginRoot, 'marker.txt'), 'plain')
    await writeSkill(path.join(pluginRoot, 'skills'), 'review', '---\ndescription: Review code\n---\nSECRET_PLUGIN_BODY\n')
    await withHome(home, async () => {
      const catalog = await loadSkillCatalog(project)
      const skill = catalog.list().find(s => s.id === 'demo@local:review')
      assert.ok(skill)
      assert.equal(skill.pluginId, 'demo@local')
      assert.equal(skill.marketplace, 'local')
      assert.equal(skill.version, '1.2.3')
      assert.equal(JSON.stringify(skill).includes('SECRET_PLUGIN_BODY'), false)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('installed plugin skill entries are discovered from installed plugin metadata', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    const installRoot = path.join(home, '.termagent', 'plugins', 'cache', 'market', 'demo', '1.0.0__abc123')
    await mkdir(path.join(installRoot, '.claude-plugin'), { recursive: true })
    await writeFile(path.join(installRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0', skills: ['./skills'] }))
    await writeSkill(path.join(installRoot, 'skills'), 'ship', '---\ndescription: Ship safely\n---\n')
    const statePath = path.join(home, '.termagent', 'plugins', 'installed.json')
    await mkdir(path.dirname(statePath), { recursive: true })
    await writeFile(statePath, JSON.stringify({ version: 1, plugins: {
      'demo@market': { id:'demo@market', marketplace:'market', plugin:'demo', source:'./demo', installPath:installRoot, version:'1.0.0', digest:'sha256:' + '1'.repeat(64), installedAt:'x', lastUpdated:'x', status:'installed' }
    }}))
    await withHome(home, async () => {
      const skill = (await loadSkillCatalog(project)).get('demo@market:ship')
      assert.equal(skill.description, 'Ship safely')
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('descriptor listing is deterministic and capped', async () => {
  const input = [
    { id:'z', name:'z', description:'Z', source:'project' },
    { id:'a', name:'a', description:'A', source:'global' },
  ]
  const output = formatSkillDescriptors(input, 25)
  assert.match(output, /- a:/)
  assert.doesNotMatch(output, /- z:/)
})
test('skill details surface exposes provenance, digest and warnings without changing descriptor shape', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'details', '---\ndescription: Details skill\nuser-invocable: false\n---\n# Details\n')
    await withHome(home, async () => {
      const catalog = await loadSkillCatalog(project)
      const descriptor = catalog.list()[0]
      const details = catalog.get('details')
      assert.equal(descriptor.userInvocable, false)
      assert.equal(details.userInvocable, false)
      assert.equal(details.description, 'Details skill')
      assert.match(details.path, /SKILL\.md$/)
      assert.match(details.sha256, /^sha256:[a-f0-9]{64}$/)
      assert.equal(typeof details.size, 'number')
      assert.equal(typeof details.mtimeMs, 'number')
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('plugin skill namespaces remain distinct when two marketplaces expose the same plugin and skill name', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    for (const market of ['one', 'two']) {
      const root = path.join(home, '.termagent', 'plugins', 'cache', market, 'demo', `1.0.0__${market}`)
      await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
      await writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
      await writeSkill(path.join(root, 'skills'), 'review', `# ${market} review\n`)
    }
    const statePath = path.join(home, '.termagent', 'plugins', 'installed.json')
    await mkdir(path.dirname(statePath), { recursive: true })
    const rec = (market) => ({ id:`demo@${market}`, marketplace:market, plugin:'demo', source:'./demo', installPath:path.join(home, '.termagent', 'plugins', 'cache', market, 'demo', `1.0.0__${market}`), version:'1.0.0', digest:'sha256:'+'1'.repeat(64), installedAt:'x', lastUpdated:'x', status:'installed' })
    await writeFile(statePath, JSON.stringify({ version:1, plugins:{ 'demo@one':rec('one'), 'demo@two':rec('two') } }))
    await withHome(home, async () => {
      const ids=(await loadSkillCatalog(project)).list().map(s=>s.id).filter(id=>id.includes(':review')).sort()
      assert.deepEqual(ids, ['demo@one:review','demo@two:review'])
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('catalog handles a moderately large skill set deterministically', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-skill-project-'))
  try {
    const root = path.join(project, '.termagent', 'skills')
    for (let i = 0; i < 120; i++) await writeSkill(root, `skill-${String(i).padStart(3, '0')}`, `---\ndescription: Skill ${i}\n---\n# Skill ${i}\n`)
    await withHome(home, async () => {
      const list = (await loadSkillCatalog(project)).list()
      assert.equal(list.length, 120)
      assert.equal(list[0].id, 'skill-000')
      assert.equal(list.at(-1).id, 'skill-119')
      assert.equal(new Set(list.map(s => s.id)).size, 120)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test.after(() => SkillCatalog.clear())
