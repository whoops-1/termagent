import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionGate } from '../dist/tools/permissions.js'

const tool = { name: 'bash', risk: 'shell', description: 'run shell', schema: {}, async execute() { return { output: 'ok' } } }

test('permission requester resolves once, always, and deny decisions', async () => {
  const gate = new PermissionGate('ask')
  const decisions = ['once', 'always', 'deny']
  let calls = 0
  gate.setRequester(async () => decisions[calls++])

  await assert.doesNotReject(() => gate.check(tool, { command: 'printf once' }))
  await assert.doesNotReject(() => gate.check(tool, { command: 'printf always' }))
  // Once is consumed, but Always allow is remembered by tool name.
  await assert.doesNotReject(() => gate.check(tool, { command: 'printf remembered' }))
  assert.equal(calls, 2)

  const denyGate = new PermissionGate('ask')
  denyGate.setRequester(async () => 'deny')
  await assert.rejects(() => denyGate.check(tool, { command: 'false' }), /Permission denied for bash/)
})

test('aborted permission requests fail closed before asking', async () => {
  const gate = new PermissionGate('ask')
  const controller = new AbortController()
  controller.abort()
  let called = false
  gate.setRequester(async () => { called = true; return 'once' })
  await assert.rejects(() => gate.check(tool, {}, controller.signal), /Permission cancelled for bash/)
  assert.equal(called, false)
})
