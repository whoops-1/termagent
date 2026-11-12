import assert from 'node:assert/strict'
import test from 'node:test'
import { runControlledReplay, formatControlledReplay } from '../tools/phase14h-controlled-replay.mjs'

function workloadFixture() {
  const requests = []
  for (let index = 1; index <= 14; index++) {
    const callId = `replay-call-${index}`
    requests.push({
      id: `request-${index}`,
      objective: 'Implement Phase 14H request-aware compaction while preserving complete tool units and verification state.',
      additionalRequestTokens: 2_000,
      append: [
        { role: 'user', content: `Continue the same repository task, inspect the next focused module, and preserve prior decisions. ${'user-context '.repeat(430)}` },
        {
          role: 'assistant',
          content: `I will inspect the scoped file and keep the existing implementation. ${'analysis '.repeat(110)}`,
          tool_calls: [{ id: callId, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/context/part-${index}.ts`, startLine: 1, endLine: 90 }) } }],
        },
        { role: 'tool', tool_call_id: callId, name: 'read_file', content: `Verified source module ${index}. ${'implementation-detail '.repeat(430)} PASS: focused regression preserved the existing request contract.` },
        { role: 'assistant', content: `Module ${index} is understood and the focused test passed. ${'verified-result '.repeat(75)}` },
      ],
    })
  }
  return {
    version: 1,
    id: 'same-input-request-accounting-replay',
    objective: 'Preserve exact tool outcomes and test evidence across controlled compaction.',
    workspaceSnapshot: 'fixture-workspace-sha256:deadbeef',
    route: { provider: 'fixture-provider', model: 'fixture-model-20k', contextWindow: 20_000, maxOutputTokens: 2_048, threshold: 0.88, reserveTokens: 1_000, recentTokens: 2_000 },
    initialMessages: [{ role: 'system', content: `Stable TermAgent system instructions. ${'system-rule '.repeat(80)}` }],
    tools: [{ type: 'function', function: { name: 'read_file', description: `Read a bounded source range and return exact source lines. ${'schema-description '.repeat(120)}`, parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path'] } } }],
    requests,
  }
}

test('14H controlled replay uses identical ordered inputs for both policies and catches omitted request overhead', () => {
  const fixture = workloadFixture()
  const result = runControlledReplay(fixture)
  assert.equal(result.equivalence.identicalInputs, true)
  assert.equal(result.equivalence.identicalProviderRoute, true)
  assert.equal(result.equivalence.identicalToolSchemas, true)
  assert.equal(result.equivalence.identicalOrderedRequests, true)
  assert.equal(result.equivalence.providerExecuted, false)
  assert.match(result.workload.sha256, /^[a-f0-9]{64}$/)
  assert.ok(result.comparison.legacy.overflowRequests > 0, 'legacy accounting should expose requests hidden by omitted overhead')
  assert.ok(result.comparison.current.compactions > 0, 'request-footprint policy should trigger compaction')
  assert.equal(result.comparison.current.overflowRequests, 0, 'request-footprint policy should reserve schema and additional request overhead')
  assert.ok(result.comparison.current.finalToolPairIntegrity.unmatchedCalls.length === 0)
  assert.ok(result.comparison.current.finalToolPairIntegrity.unmatchedResults.length === 0)
  assert.match(formatControlledReplay(result), /not a provider-backed A\/B experiment/)
})

test('14H controlled replay is deterministic and changes its fingerprint when any replay input changes', () => {
  const fixture = workloadFixture()
  const first = runControlledReplay(fixture)
  const second = runControlledReplay(fixture)
  assert.deepEqual(first, second)
  const changed = structuredClone(fixture)
  changed.requests[0].append[0].content += ' changed prompt'
  const third = runControlledReplay(changed)
  assert.notEqual(first.workload.sha256, third.workload.sha256)
  const changedObjective = structuredClone(fixture)
  changedObjective.objective += ' include the new invariant'
  assert.notEqual(first.workload.sha256, runControlledReplay(changedObjective).workload.sha256)
})

test('14H controlled replay rejects missing route or malformed request fixtures', () => {
  const fixture = workloadFixture()
  assert.throws(() => runControlledReplay({ ...fixture, route: undefined }), /route must include provider and model/)
  assert.throws(() => runControlledReplay({ ...fixture, requests: [{ append: 'not-an-array' }] }), /append must be an array/)
})
