import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { resolveHomeDirectory } from '../../dist/util/paths.js'

const HOME_ENV_KEYS = ['HOME', 'USERPROFILE']

/**
 * Runs `run()` with HOME and USERPROFILE cleared, applies `mutate` on top, and
 * restores the original environment afterwards.
 */
function withHomeEnv(mutate, run) {
  const saved = new Map()
  for (const key of HOME_ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  try {
    mutate(process.env)
    return run()
  } finally {
    for (const key of HOME_ENV_KEYS) {
      if (saved.get(key) === undefined) delete process.env[key]
      else process.env[key] = saved.get(key)
    }
  }
}

test('resolveHomeDirectory prefers HOME when it is set', () => {
  const resolved = withHomeEnv(
    env => { env.HOME = '/termagent-test/home'; env.USERPROFILE = '/termagent-test/profile' },
    () => resolveHomeDirectory()
  )
  assert.strictEqual(resolved, '/termagent-test/home')
})

test('resolveHomeDirectory falls back to USERPROFILE when HOME is unset', () => {
  const resolved = withHomeEnv(
    env => { env.USERPROFILE = '/termagent-test/profile' },
    () => resolveHomeDirectory()
  )
  assert.strictEqual(resolved, '/termagent-test/profile')
})

test('resolveHomeDirectory treats an empty HOME as unset', () => {
  const resolved = withHomeEnv(
    env => { env.HOME = ''; env.USERPROFILE = '/termagent-test/profile' },
    () => resolveHomeDirectory()
  )
  assert.strictEqual(resolved, '/termagent-test/profile')
})

test('resolveHomeDirectory treats an empty USERPROFILE as unset when HOME is set', () => {
  const resolved = withHomeEnv(
    env => { env.HOME = '/termagent-test/home'; env.USERPROFILE = '' },
    () => resolveHomeDirectory()
  )
  assert.strictEqual(resolved, '/termagent-test/home')
})

test('resolveHomeDirectory falls back to os.homedir() when HOME and USERPROFILE are unset', () => {
  // Compared against os.homedir() inside the same cleared environment so the
  // assertion is independent of the host's real HOME/USERPROFILE. On stripped
  // hosts os.homedir() itself can throw; the resolver must agree either way.
  const result = withHomeEnv(() => undefined, () => {
    let expected
    let expectedThrew = false
    try { expected = os.homedir() } catch { expectedThrew = true }
    let actual
    let actualThrew = false
    try { actual = resolveHomeDirectory() } catch { actualThrew = true }
    return { expected, expectedThrew, actual, actualThrew }
  })
  if (result.expectedThrew) {
    assert.ok(result.actualThrew, 'resolveHomeDirectory should surface the same os.homedir() failure')
  } else {
    assert.ok(!result.actualThrew, 'resolveHomeDirectory threw while os.homedir() succeeded')
    assert.strictEqual(result.actual, result.expected)
  }
})
