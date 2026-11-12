// 14I-B1 — live event delivery (Phase 14I batch-2 trace fixes).
// Covers: the Web View no longer blanket-suppresses live events while the
// foreground POST prompt stream is active (only the stream's own duplicate
// sources are suppressed), and the server SSE durable poll is gated on the
// durable sequence so connected clients do not rescan the full session log
// every tick. Read-and-assert, following the established web test pattern.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// Assertion normalization: match on logical content regardless of CRLF/LF.
const readNormalized = async filePath => (await readFile(path.join(repoRoot, filePath), 'utf8')).replace(/\r\n/g, '\n')

test('14I-B1: the Web View suppression is narrowed to the POST stream\'s duplicate sources', async () => {
  const app = await readNormalized(path.join('web', 'app', 'app.js'))
  assert.ok(!app.includes('if (state.promptStreamActive || Date.now() < state.promptStreamSuppressUntil) return;'),
    'the blanket suppression that hid all live events during a prompt must be gone')
  assert.ok(app.includes('Phase 14I batch-2\n  // live-delivery trace'),
    'the narrowed suppression documents the trace conclusion it implements')
  for (const duplicateSource of [
    "'session.text.delta'", "'session.reasoning.delta'", "'runtime.activity.changed'", "'session.tool.output.delta'",
  ]) {
    assert.ok(app.includes(duplicateSource), `the POST stream's duplicate source must still be suppressed: ${duplicateSource}`)
  }
  // Durable frames reconcile tool-call history regardless of the prompt stream.
  assert.ok(app.includes("handleDurableEvent(frame.data)"), "durable event frames still drive history")
})

test('14I-B1: the SSE durable poll is gated on the durable sequence before fetching pages', async () => {
  const http = await readNormalized(path.join('src', 'server', 'http.ts'))
  assert.ok(http.includes('const durableSequenceNow = await api.currentSequence(id)'),
    'the poll must check the (fast-path) durable sequence before replaying pages')
  assert.ok(http.includes('if (durableSequenceNow > cursor) await replay()'),
    'replay must be skipped when the durable sequence has not moved')
  assert.ok(http.includes('do not share this in-process event bus'),
    'the ≤1 s child-process delivery floor is documented at the gate')
})

test('14I-B1: the event bus still wakes subscribers for durable publishes (live same-process delivery)', async () => {
  const bus = await readNormalized(path.join('src', 'session', 'event-bus.ts'))
  assert.ok(bus.includes('publishDurable(event: DurableEventEnvelope): void'))
  assert.ok(bus.includes('wake.dirty = true\n      wake.waiter?.()'),
    'durable publishes must resolve waiting SSE loops immediately')
})
