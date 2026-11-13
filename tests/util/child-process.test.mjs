import test from 'node:test'
import assert from 'node:assert/strict'
import { planProcessGroupTermination, taskkillExitOutcome, terminateProcessGroup } from '../../dist/util/child-process.js'

test('planProcessGroupTermination targets the Windows process tree with taskkill /T /F', () => {
  assert.deepStrictEqual(planProcessGroupTermination(4242, { stage: 'graceful', platform: 'win32' }), {
    platform: 'win32',
    command: 'taskkill',
    args: ['/PID', '4242', '/T', '/F'],
    notFoundExitCode: 128,
  })
})

test('planProcessGroupTermination collapses Windows escalation into a single forced tree kill', () => {
  // Windows has no graceful cross-process signal, so the graceful and forced
  // stages must agree on one taskkill invocation.
  const graceful = planProcessGroupTermination(4242, { stage: 'graceful', platform: 'win32' })
  const forced = planProcessGroupTermination(4242, { stage: 'forced', platform: 'win32' })
  assert.deepStrictEqual(graceful, forced)
})

test('planProcessGroupTermination signals the POSIX process group with TERM then KILL', () => {
  assert.deepStrictEqual(planProcessGroupTermination(4242, { stage: 'graceful', platform: 'linux' }), {
    platform: 'posix',
    groupPid: -4242,
    signal: 'SIGTERM',
  })
  assert.deepStrictEqual(planProcessGroupTermination(4242, { stage: 'forced', platform: 'linux' }), {
    platform: 'posix',
    groupPid: -4242,
    signal: 'SIGKILL',
  })
})

test('planProcessGroupTermination defaults to the host platform', () => {
  const plan = planProcessGroupTermination(4242)
  if (process.platform === 'win32') {
    assert.strictEqual(plan.platform, 'win32')
    assert.deepStrictEqual(plan.args, ['/PID', '4242', '/T', '/F'])
  } else {
    assert.strictEqual(plan.platform, 'posix')
    assert.strictEqual(plan.groupPid, -4242)
  }
})

test('taskkillExitOutcome treats 0 as terminated, 128 as not-found, others unresolved', () => {
  assert.strictEqual(taskkillExitOutcome(0), 'terminated')
  assert.strictEqual(taskkillExitOutcome(128), 'not-found')
  assert.strictEqual(taskkillExitOutcome(1), 'unresolved')
  assert.strictEqual(taskkillExitOutcome(255), 'unresolved')
  assert.strictEqual(taskkillExitOutcome(undefined), 'unresolved')
  assert.strictEqual(taskkillExitOutcome(null), 'unresolved')
})

test('terminateProcessGroup refuses invalid pids without spawning on any platform', async () => {
  for (const pid of [undefined, 0, -1, -4242]) {
    assert.deepStrictEqual(
      await terminateProcessGroup(pid, { graceMs: 1 }),
      { signalled: false, forced: false, remaining: false },
    )
  }
})
