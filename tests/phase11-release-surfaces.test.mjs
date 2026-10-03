import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

async function temp(prefix) { return mkdtemp(path.join(os.tmpdir(), prefix)) }
async function withHome(home, fn) { const previous = process.env.HOME; process.env.HOME = home; try { return await fn() } finally { process.env.HOME = previous } }

function runCli(cwd, home, args) {
  return spawnSync(process.execPath, [path.resolve('dist/index.js'), ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
}

test('migration adopts global config aliases and creates a global backup without moving content', async () => {
  const root = await temp('termagent-phase11-global-project-')
  const home = await temp('termagent-phase11-global-home-')
  try {
    await mkdir(path.join(home, '.termagent', 'skills', 'global-skill'), { recursive: true })
    await mkdir(path.join(home, '.termagent', 'plugins'), { recursive: true })
    const pluginFile = path.join(home, '.termagent', 'plugins', 'legacy.mjs')
    await writeFile(pluginFile, 'export default async()=>{}')
    const config = path.join(home, '.termagent', 'config.json')
    await writeFile(config, JSON.stringify({ pluginDirs: ['./.termagent/plugins'], skillDirs: ['./.termagent/skills'], model: 'fixture' }, null, 2))

    await withHome(home, async () => {
      const { migrateLegacyState, inspectLegacyLayout } = await import('../dist/migration.js')
      const before = await inspectLegacyLayout(root)
      assert.ok(before.globalConfigAliasEntries.length > 0)
      const result = await migrateLegacyState(root)
      assert.equal(result.globalConfig?.changed, true)
      const migrated = JSON.parse(await readFile(config, 'utf8'))
      assert.deepEqual(migrated.plugins, ['./.termagent/plugins'])
      assert.deepEqual(migrated.skillPaths, ['./.termagent/skills'])
      assert.ok(result.globalConfig?.backup)
      assert.equal(await readFile(pluginFile, 'utf8'), 'export default async()=>{}')
      const backup = JSON.parse(await readFile(result.globalConfig.backup, 'utf8'))
      assert.deepEqual(backup.pluginDirs, ['./.termagent/plugins'])
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('configured skillPaths are discovered through the normal catalog after migration', async () => {
  const project = await temp('termagent-phase11-configured-skill-')
  const home = await temp('termagent-phase11-configured-home-')
  try {
    const custom = path.join(project, 'custom-skills')
    await mkdir(path.join(custom, 'configured'), { recursive: true })
    await writeFile(path.join(custom, 'configured', 'SKILL.md'), '---\ndescription: configured skill\n---\n\n# Configured\n')
    await mkdir(path.join(project, '.termagent'), { recursive: true })
    await writeFile(path.join(project, '.termagent', 'config.json'), JSON.stringify({ skillPaths: ['./custom-skills'], model: 'fixture' }, null, 2))
    await withHome(home, async () => {
      const { loadSkillCatalog } = await import('../dist/skills/catalog.js')
      const catalog = await loadSkillCatalog(project, { includeLocalPlugins: false })
      assert.ok(catalog.list().some(skill => skill.name === 'configured'))
    })
  } finally {
    await rm(project, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('doctor exposes migration corruption as a diagnostic error instead of throwing', async () => {
  const project = await temp('termagent-phase11-doctor-corrupt-')
  const home = await temp('termagent-phase11-doctor-corrupt-home-')
  try {
    await mkdir(path.join(home, '.termagent'), { recursive: true })
    await writeFile(path.join(home, '.termagent', 'migrations.json'), '{not-json')
    await withHome(home, async () => {
      const { doctor } = await import('../dist/doctor.js')
      const report = await doctor(project)
      const migration = report.checks.find(c => c.label === 'Migration record')
      assert.equal(migration?.status, 'error')
      assert.equal(report.ok, false)
    })
  } finally {
    await rm(project, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('termagent --doctor --json produces machine-readable diagnostics and exit status', async () => {
  const project = await temp('termagent-phase11-cli-doctor-')
  const home = await temp('termagent-phase11-cli-doctor-home-')
  try {
    const result = runCli(project, home, ['--doctor', '--json'])
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, null)
    const report = JSON.parse(result.stdout)
    assert.ok(Array.isArray(report.checks))
    assert.equal(typeof report.counts.ok, 'number')
    assert.equal(typeof report.counts.warn, 'number')
    assert.equal(typeof report.counts.error, 'number')
    assert.ok(report.checks.some(c => c.group === 'plugins'))
    assert.ok(report.checks.some(c => c.group === 'skills'))
  } finally {
    await rm(project, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('authoring examples are present with declarative plugin and pure-skill boundaries', async () => {
  const pluginManifest = JSON.parse(await readFile('docs/examples/plugin-basic/.claude-plugin/plugin.json', 'utf8'))
  assert.equal(pluginManifest.name, 'example-review')
  assert.equal(pluginManifest.skills, './skills')
  const { readPluginManifest } = await import('../dist/plugins/manifest.js')
  const loaded = await readPluginManifest('docs/examples/plugin-basic')
  assert.equal(loaded.manifest.name, 'example-review')
  assert.equal(loaded.manifest.version, '1.0.0')
  const command = await readFile('docs/examples/plugin-basic/commands/check.md', 'utf8')
  const skill = await readFile('docs/examples/plugin-basic/skills/review/SKILL.md', 'utf8')
  const pure = await readFile('docs/examples/skill-basic/SKILL.md', 'utf8')
  assert.match(command, /description: Check a small project change/)
  assert.match(skill, /## Use this skill when/)
  assert.match(pure, /name: release-review/)
})

test('top-level doctor help documents JSON output', () => {
  const result = spawnSync(process.execPath, [path.resolve('dist/index.js'), '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--doctor \[--json\]/)
})
test('termagent --doctor stays non-interactive and reports grouped state', () => {
  const project = path.resolve('.')
  const home = os.tmpdir()
  const result = runCli(project, home, ['--doctor'])
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, null)
  assert.match(result.stdout, /ENVIRONMENT/)
  assert.match(result.stdout, /MARKETPLACES/)
  assert.match(result.stdout, /SKILLS/)
  assert.doesNotMatch(result.stdout, /Open an interactive session|TERMAGENT_PROMPT/)
})
