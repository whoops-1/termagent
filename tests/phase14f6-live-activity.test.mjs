import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_KEYS = [
  'HOME', 'TERMAGENT_PROVIDER', 'TERMAGENT_BASE_URL', 'TERMAGENT_API_KEY',
  'TERMAGENT_MODEL', 'TERMAGENT_APPROVALS', 'TERMAGENT_TASK_ROOT',
]

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14f6-live-'))
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14f6-home-'))
  const old = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  let runtime
  try {
    await mkdir(path.join(root, '.termagent'), { recursive: true })
    await writeFile(path.join(root, '.termagent', 'config.json'), JSON.stringify({ approvals: 'ask', maxToolRounds: 2 }))
    process.env.HOME = home
    process.env.TERMAGENT_PROVIDER = 'openai-compatible'
    process.env.TERMAGENT_BASE_URL = 'http://127.0.0.1:1/v1'
    process.env.TERMAGENT_API_KEY = 'test'
    process.env.TERMAGENT_MODEL = 'phase14f6-live-test'
    process.env.TERMAGENT_APPROVALS = 'ask'
    process.env.TERMAGENT_TASK_ROOT = path.join(home, '.termagent', 'tasks')
    const { createRuntime } = await import('../dist/server/runtime.js')
    runtime = await createRuntime(root)
    const session = await runtime.store.create(root, 'phase14f6-live-test')
    return {
      root, home, runtime, session,
      async close() {
        await runtime.close()
        for (const key of ENV_KEYS) {
          if (old[key] === undefined) delete process.env[key]
          else process.env[key] = old[key]
        }
        await rm(root, { recursive: true, force: true })
        await rm(home, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (runtime) await runtime.close()
    for (const key of ENV_KEYS) {
      if (old[key] === undefined) delete process.env[key]
      else process.env[key] = old[key]
    }
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

test('14F6 emits immediate preparation and provider-thinking stages before the first token', async () => {
  const f = await fixture()
  try {
    const statuses = []
    const live = []
    const subscription = f.runtime.events.subscribe(f.session.id)
    const provider = f.runtime.getProvider()
    provider.stream = async function* () {
      yield { type: 'text', delta: 'Live output reached the client.' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const running = f.runtime.runPrompt(f.session.id, [], 'Explain the workspace.', {
      onStatus: message => statuses.push(message),
    })
    while (true) {
      const changed = await subscription.waitForChange(25)
      live.push(...subscription.drainLive())
      if (await Promise.race([running.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 0))])) break
      if (!changed) continue
    }
    await running
    subscription.close()

    assert.equal(statuses[0], 'Preparing workspace context')
    assert.ok(statuses.includes('Thinking'))
    assert.ok(live.some(event => event.kind === 'runtime.activity.changed' && event.payload.activityLabel === 'Preparing workspace context'))
    assert.ok(live.some(event => event.kind === 'runtime.activity.changed' && event.payload.activityLabel === 'Thinking'))
  } finally {
    await f.close()
  }
})

test('14F6 Web View consumes prompt SSE and paints the current stage inline on mobile', async () => {
  const { readFile } = await import('node:fs/promises')
  const app = await readFile(new URL('../web/app/app.js', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../web/app/styles.css', import.meta.url), 'utf8')
  assert.match(app, /state\.client\.streamPrompt\(promptSessionId, prompt/)
  assert.match(app, /handlePromptStreamFrame\(frame, promptSessionId\)/)
  assert.match(app, /class="live-stage" role="status" aria-live="polite"/)
  assert.match(app, /Live updates reconnecting…/)
  assert.doesNotMatch(app, /No heartbeat received\. Reconnecting/)
  assert.match(styles, /\.live-stage\s*\{/)
})
