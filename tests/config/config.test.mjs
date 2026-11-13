import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, saveUIPreferences } from '../../dist/config/config.js'

const HOME_ENV_KEYS = ['HOME', 'USERPROFILE']

/** Runs an async `run()` with HOME/USERPROFILE cleared, mutated, and restored. */
async function withHomeEnvAsync(mutate, run) {
  const saved = new Map()
  for (const key of HOME_ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  try {
    mutate(process.env)
    return await run()
  } finally {
    for (const key of HOME_ENV_KEYS) {
      if (saved.get(key) === undefined) delete process.env[key]
      else process.env[key] = saved.get(key)
    }
  }
}

async function tempDir(prefix) { return fs.mkdtemp(path.join(os.tmpdir(), prefix)) }

async function writeUserConfig(home, value) {
  await fs.mkdir(path.join(home, '.termagent'), { recursive: true })
  await fs.writeFile(path.join(home, '.termagent', 'config.json'), JSON.stringify(value), 'utf8')
}

test('loadConfig resolves the user-level candidate through the shared home resolver', async () => {
  const project = await tempDir('termagent-config-project-')
  const home = await tempDir('termagent-config-home-')
  try {
    await writeUserConfig(home, { maxToolRounds: 77 })
    const config = await withHomeEnvAsync(
      env => { env.HOME = home; env.USERPROFILE = '/termagent-test/unused-profile' },
      () => loadConfig(project)
    )
    assert.strictEqual(config.maxToolRounds, 77)
  } finally {
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('loadConfig honors USERPROFILE when HOME is unset (Windows path)', async () => {
  const project = await tempDir('termagent-config-project-')
  const home = await tempDir('termagent-config-home-')
  try {
    await writeUserConfig(home, { maxToolRounds: 77 })
    const config = await withHomeEnvAsync(
      env => { env.USERPROFILE = home },
      () => loadConfig(project)
    )
    assert.strictEqual(config.maxToolRounds, 77)
  } finally {
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('loadConfig keeps the project-level candidate ahead of the user-level candidate', async () => {
  const project = await tempDir('termagent-config-project-')
  const home = await tempDir('termagent-config-home-')
  try {
    await fs.mkdir(path.join(project, '.termagent'), { recursive: true })
    await fs.writeFile(path.join(project, '.termagent', 'config.json'), JSON.stringify({ maxToolRounds: 5 }), 'utf8')
    await writeUserConfig(home, { maxToolRounds: 77 })
    const config = await withHomeEnvAsync(
      env => { env.HOME = home },
      () => loadConfig(project)
    )
    assert.strictEqual(config.maxToolRounds, 5)
  } finally {
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('saveUIPreferences updates the user-level candidate resolved by the home resolver', async () => {
  const project = await tempDir('termagent-config-project-')
  const home = await tempDir('termagent-config-home-')
  try {
    await writeUserConfig(home, { maxToolRounds: 77 })
    const userFile = path.join(home, '.termagent', 'config.json')
    await withHomeEnvAsync(
      env => { env.HOME = home },
      () => saveUIPreferences(project, { theme: 'signal' })
    )
    const saved = JSON.parse(await fs.readFile(userFile, 'utf8'))
    assert.strictEqual(saved.ui.theme, 'signal')
    assert.strictEqual(saved.maxToolRounds, 77)
    const projectFileExists = await fs.access(path.join(project, '.termagent', 'config.json')).then(() => true, () => false)
    assert.strictEqual(projectFileExists, false)
  } finally {
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('saveUIPreferences still creates a project-level file when no config exists yet', async () => {
  const project = await tempDir('termagent-config-project-')
  const home = await tempDir('termagent-config-home-')
  try {
    await withHomeEnvAsync(
      env => { env.HOME = home },
      () => saveUIPreferences(project, { theme: 'split' })
    )
    const created = JSON.parse(await fs.readFile(path.join(project, '.termagent', 'config.json'), 'utf8'))
    assert.strictEqual(created.ui.theme, 'split')
  } finally {
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})
