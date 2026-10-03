import test from 'node:test'
import assert from 'node:assert/strict'

test('13M-P7 durable events require positive replay sequences and live events do not', async () => {
  const { validateEventEnvelope, ProtocolValidationError } = await import('../../dist/protocol/index.js')

  const durable = {
    version: 1,
    eventId: 'evt-1',
    sessionId: 'sess-1',
    sequence: 7,
    timestamp: 100,
    category: 'message',
    kind: 'session.message.user',
    durable: true,
    payload: { text: 'hello' },
  }
  assert.equal(validateEventEnvelope(durable).sequence, 7)

  const live = {
    ...durable,
    eventId: 'evt-2',
    sequence: null,
    kind: 'session.text.delta',
    durable: false,
    payload: { delta: 'hi' },
  }
  assert.equal(validateEventEnvelope(live).sequence, null)

  assert.throws(
    () => validateEventEnvelope({ ...durable, sequence: 0 }),
    ProtocolValidationError,
  )
  assert.throws(
    () => validateEventEnvelope({ ...live, sequence: 8 }),
    ProtocolValidationError,
  )
})

test('13M-P7 known event classification rejects contradictory durability', async () => {
  const { validateEventEnvelope } = await import('../../dist/protocol/index.js')
  assert.throws(() => validateEventEnvelope({
    version: 1,
    eventId: 'evt-1',
    sessionId: 'sess-1',
    sequence: null,
    timestamp: 1,
    category: 'message',
    kind: 'session.text.delta',
    durable: true,
    payload: {},
  }))
})

test('13M-P7 command envelopes define a deterministic idempotency key and stale-state checks', async () => {
  const { validateCommandEnvelope, commandIdempotencyKey, commandFingerprint, durableSequence, expectedStateMatches } = await import('../../dist/protocol/index.js')
  const command = validateCommandEnvelope({
    version: 1,
    commandId: 'cmd-1',
    clientId: 'web-1',
    sessionId: 'sess-1',
    issuedAt: 1,
    expectedSequence: 10,
    expectedRevision: 'rev-2',
    kind: 'session.prompt',
    payload: { prompt: 'continue' },
  })

  assert.equal(commandIdempotencyKey(command), JSON.stringify(['sess-1', 'web-1', 'cmd-1']))
  assert.notEqual(commandFingerprint(command), commandFingerprint({ ...command, payload: { prompt: 'different' } }))
  assert.equal(expectedStateMatches(command, { sequence: durableSequence(10), revision: 'rev-2' }), true)
  assert.equal(expectedStateMatches(command, { sequence: durableSequence(11), revision: 'rev-2' }), false)
  assert.equal(expectedStateMatches(command, { sequence: durableSequence(10), revision: 'rev-3' }), false)
})

test('13M-P7 interaction request state is explicitly first-writer-wins', async () => {
  const { firstWriterWins } = await import('../../dist/protocol/index.js')
  const request = {
    kind: 'question',
    requestId: 'q-1',
    sessionId: 'sess-1',
    revision: 1,
    status: 'pending',
    questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }],
    createdAt: 1,
  }
  const first = firstWriterWins(request, { commandId: 'cmd-a', clientId: 'terminal', disposition: 'replied', answers: [['A']] }, 2)
  assert.equal(first.applied, true)
  assert.equal(first.request.status, 'replied')

  const second = firstWriterWins(first.request, { commandId: 'cmd-b', clientId: 'web', disposition: 'replied', answers: [['B']] }, 3)
  assert.equal(second.applied, false)
  assert.equal(second.reason, 'already-resolved')

  const rejected = firstWriterWins({ ...request, requestId: 'q-2' }, { commandId: 'cmd-c', clientId: 'terminal', disposition: 'rejected' }, 4)
  assert.equal(rejected.request.status, 'rejected')

  const cancelled = firstWriterWins({ ...request, requestId: 'q-3' }, { commandId: 'cmd-d', clientId: 'terminal', disposition: 'cancelled' }, 5)
  assert.equal(cancelled.request.status, 'cancelled')
})

test('13M-P7 reconnect contract carries a durable cursor and an authoritative snapshot boundary', async () => {
  const { validateReconnectRequest, validateReconciliationSnapshot, durableSequence, nextDurableSequence, assertDurableSequenceAdvances, planReconnect }  = await import('../../dist/protocol/index.js')
  const request = validateReconnectRequest({
    version: 1,
    clientId: 'web-1',
    sessionId: 'sess-1',
    lastDurableSequence: 42,
    knownRevision: 'rev-4',
  })
  const snapshot = validateReconciliationSnapshot({
    version: 1,
    sessionId: request.sessionId,
    sequence: 50,
    revision: 'rev-5',
    capturedAt: 99,
    state: { status: 'busy' },
  })
  assert.equal(request.lastDurableSequence, 42)
  assert.equal(snapshot.sequence, durableSequence(50))
  assert.equal(nextDurableSequence(durableSequence(50)), durableSequence(51))
  assert.doesNotThrow(() => assertDurableSequenceAdvances(durableSequence(50), durableSequence(51)))
  assert.throws(() => assertDurableSequenceAdvances(durableSequence(51), durableSequence(51)))

  const replay = planReconnect(request, { sequence: durableSequence(50), revision: 'rev-4' })
  assert.equal(replay.strategy, 'replay')
  assert.equal(replay.replayAfter, durableSequence(42))

  const snapshotPlan = planReconnect(request, { sequence: durableSequence(50), revision: 'rev-5', firstReplayableSequence: durableSequence(45) })
  assert.equal(snapshotPlan.strategy, 'snapshot-and-replay')
  assert.equal(snapshotPlan.replayAfter, durableSequence(50))
})
