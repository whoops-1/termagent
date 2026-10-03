import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import {
  getProviderConfigPath,
  listProviderProfiles,
  removeProviderProfile,
  saveProviderProfile,
  setActiveProviderProfile,
  useEnvironmentProvider,
} from '../dist/providers/manager.js'
import { TerminalUI } from '../dist/cli/ui.js'

function fakeTTY() {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  return input
}

function outputStream(columns = 80, rows = 24) {
  const writes = []
  const output = new EventEmitter()
  output.columns = columns
  output.rows = rows
  output.write = chunk => { writes.push(String(chunk)); return true }
  return { output, writes }
}

test('provider manager persists, activates, renames, removes, and clears active profile safely', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'termagent-provider-manager-'))
  const home = await mkdtemp(path.join(tmpdir(), 'termagent-provider-home-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const saved = await saveProviderProfile(cwd, {
      name: 'nvidia',
      provider: 'openai-compatible',
      model: 'nvidia/test-model',
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret-value',
    })
    assert.equal(saved.name, 'nvidia')
    const globalPath = path.join(home, '.termagent', 'config.json')
    const config = JSON.parse(await readFile(globalPath, 'utf8'))
    assert.equal(config.providers.nvidia.model, 'nvidia/test-model')
    assert.equal(config.provider, 'nvidia')

    const listed = await listProviderProfiles(cwd, { providers: config.providers, provider: config.provider })
    assert.equal(listed.activeName, 'nvidia')
    assert.equal(listed.profiles[0].apiKeyConfigured, true)

    await setActiveProviderProfile(cwd, 'nvidia')
    const edited = await saveProviderProfile(cwd, {
      name: 'nvidia-main',
      provider: 'openai-compatible',
      model: 'nvidia/test-model-2',
      baseUrl: 'https://example.test/v2',
      apiKey: '',
    }, 'nvidia')
    assert.equal(edited.name, 'nvidia-main')
    const afterEdit = JSON.parse(await readFile(globalPath, 'utf8'))
    assert.equal(afterEdit.providers.nvidia, undefined)
    assert.equal(afterEdit.providers['nvidia-main'].apiKey, 'secret-value')

    await removeProviderProfile(cwd, 'nvidia-main')
    const afterRemove = JSON.parse(await readFile(globalPath, 'utf8'))
    assert.equal(afterRemove.providers['nvidia-main'], undefined)
    assert.equal(afterRemove.provider, undefined)

    await saveProviderProfile(cwd, {
      name: 'a', provider: 'openai-compatible', model: 'a-model', baseUrl: 'https://a.test/v1', apiKey: 'a-key',
    })
    await saveProviderProfile(cwd, {
      name: 'b', provider: 'gemini', model: 'gemini-model', baseUrl: 'https://b.test', apiKey: 'b-key',
    })
    await setActiveProviderProfile(cwd, 'b')
    await useEnvironmentProvider(cwd)
    const envReset = JSON.parse(await readFile(globalPath, 'utf8'))
    assert.equal(envReset.provider, undefined)
    assert.equal(envReset.model, undefined)
    assert.equal(envReset.baseUrl, undefined)

    const stat = await import('node:fs/promises').then(m => m.stat(globalPath))
    assert.equal(stat.mode & 0o777, 0o600)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(cwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('provider manager opens a native terminal window with four management actions', async () => {
  const input = fakeTTY()
  const { output, writes } = outputStream(88, 26)
  const ui = new TerminalUI({ title: 'provider-test', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
  let saved
  try {
    ui.enter()
    const promise = ui.openProviderManager({
      refresh: async () => ({ profiles: [], activeName: undefined }),
      setActive: async () => 'activated',
      save: async draft => { saved = draft; return 'saved' },
      remove: async () => 'removed',
    })
    await new Promise(r => setTimeout(r, 10))
    assert.equal(ui.isProviderManagerActive(), true)
    const frame = writes.join('')
    assert.match(frame, /Provider manager/)
    assert.match(frame, /Set provider/)
    assert.match(frame, /Edit provider/)
    assert.match(frame, /Add provider/)
    assert.match(frame, /Remove provider/)
    assert.match(frame, /Done/)

    input.emit('data', '3')
    await new Promise(r => setTimeout(r, 2))
    assert.match(writes.join(''), /Add provider/)
    input.emit('data', '\r')
    await new Promise(r => setTimeout(r, 2))
    input.emit('data', 'demo')
    input.emit('data', '\r')
    await new Promise(r => setTimeout(r, 2))
    input.emit('data', '\r')
    await new Promise(r => setTimeout(r, 2))
    input.emit('data', 'demo-model')
    input.emit('data', '\r')
    await new Promise(r => setTimeout(r, 2))
    input.emit('data', '\x15')
    input.emit('data', 'https://demo.test/v1')
    input.emit('data', '\r')
    await new Promise(r => setTimeout(r, 2))
    input.emit('data', 'key')
    input.emit('data', '\r')
    for (let i = 0; i < 50 && !saved; i++) await new Promise(r => setTimeout(r, 5))
    assert.ok(saved)
    assert.equal(saved.name, 'demo')
    assert.equal(saved.provider, 'openai-compatible')
    assert.equal(saved.model, 'demo-model')
    assert.equal(saved.baseUrl, 'https://demo.test/v1')
    assert.equal(saved.apiKey, 'key')

    input.emit('data', '\x1b')
    await new Promise(r => setTimeout(r, 90))
    await promise
    assert.equal(ui.isProviderManagerActive(), false)
  } finally {
    ui.leave()
  }
})
