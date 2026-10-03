import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function tempHome(prefix = 'termagent-phase11-home-') { return mkdtemp(path.join(os.tmpdir(), prefix)) }

async function withHome(home, fn) {
  const previous = process.env.HOME
  process.env.HOME = home
  try { return await fn() } finally { process.env.HOME = previous }
}

test('Phase 11 migration normalizes legacy config aliases without moving user content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase11-migrate-'))
  const home = await tempHome()
  try {
    await mkdir(path.join(root, '.termagent', 'skills', 'legacy-skill'), { recursive: true })
    await mkdir(path.join(root, '.claude', 'skills', 'claude-skill'), { recursive: true })
    await mkdir(path.join(root, '.termagent', 'plugins'), { recursive: true })
    await writeFile(path.join(root, '.termagent', 'skills', 'legacy-skill', 'SKILL.md'), '---\ndescription: legacy\n---\nlegacy')
    await writeFile(path.join(root, '.claude', 'skills', 'claude-skill', 'SKILL.md'), '---\ndescription: claude\n---\nclaude')
    await writeFile(path.join(root, '.termagent', 'plugins', 'legacy.mjs'), 'export default async()=>{}')
    await writeFile(path.join(root, '.termagent', 'config.json'), JSON.stringify({
      pluginDirs: ['./.termagent/plugins'],
      plugin: './.termagent/plugins',
      skillDirs: ['./.claude/skills'],
      skills: ['./.termagent/skills'],
      model: 'fixture',
    }, null, 2))

    await withHome(home, async () => {
      const { migrateLegacyState } = await import('../dist/migration.js')
      const { inspectLegacyLayout } = await import('../dist/migration.js')
      const result = await migrateLegacyState(root)
      assert.equal(result.migrated, true)
      assert.equal(result.config.changed, true)

      const config = JSON.parse(await readFile(path.join(root, '.termagent', 'config.json'), 'utf8'))
      assert.deepEqual(config.plugins, ['./.termagent/plugins'])
      assert.deepEqual(config.skillPaths, ['./.claude/skills', './.termagent/skills'])
      assert.equal(config.pluginDirs, undefined)
      assert.equal(config.plugin, undefined)
      assert.equal(config.skillDirs, undefined)
      assert.equal(config.skills, undefined)
      assert.deepEqual(JSON.parse(await readFile(path.join(root, '.termagent', 'config.json.pre-phase11.bak'), 'utf8')).pluginDirs, ['./.termagent/plugins'])

      assert.equal(await readFile(path.join(root, '.termagent', 'plugins', 'legacy.mjs'), 'utf8'), 'export default async()=>{}')
      assert.equal((await inspectLegacyLayout(root)).legacyPluginFiles.length, 1)

      const second = await migrateLegacyState(root)
      assert.equal(second.alreadyCurrent, true)
      assert.equal(second.migrated, false)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('doctor reports plugin, skill registry, legacy, and storage state without a network refresh', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase11-doctor-'))
  const home = await tempHome()
  try {
    await mkdir(path.join(root, '.termagent'), { recursive: true })
    await mkdir(path.join(root, '.termagent', 'skills', 'local'), { recursive: true })
    await writeFile(path.join(root, '.termagent', 'skills', 'local', 'SKILL.md'), '---\ndescription: local skill\n---\n\n# Local\n')
    await writeFile(path.join(root, '.termagent', 'config.json'), JSON.stringify({ model: 'fixture' }, null, 2))
    await withHome(home, async () => {
      const { doctor } = await import('../dist/doctor.js')
      const report = await doctor(root)
      assert.equal(report.ok, true)
      assert.ok(report.checks.some(c => c.group === 'skills' && c.label === 'Skill catalog' && c.value.includes('discoverable')))
      assert.ok(report.checks.some(c => c.group === 'migration' && c.label === 'Legacy project skills' && c.status === 'warn'))
      assert.ok(report.checks.some(c => c.group === 'plugins' && c.label === 'Installed plugins'))
      assert.equal(typeof report.counts.warn, 'number')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
