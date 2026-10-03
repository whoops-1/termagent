import test from 'node:test'
import assert from 'node:assert/strict'

function readMetadata(path, startLine, endLine, extra = {}) {
  return {
    canonicalPath: `/repo/${path}`,
    mtimeMs: 1,
    size: 1000,
    totalLines: 100,
    requestedRange: { startLine, endLine },
    returnedRanges: [{ startLine, endLine }],
    ...extra,
  }
}

test('13N-B evidence delta distinguishes new coverage from redundant covered ranges', async () => {
  const { ExplorationState } = await import('../../dist/context/exploration.js')
  const state = new ExplorationState('/repo')

  const first = state.observeTool('read_file', { path: 'sample.ts', startLine: 1, endLine: 100 }, readMetadata('sample.ts', 1, 100))
  const head = state.observeTool('read_file', { path: 'sample.ts', startLine: 1, endLine: 50 }, readMetadata('sample.ts', 1, 50))
  const tail = state.observeTool('read_file', { path: 'sample.ts', startLine: 51, endLine: 100 }, readMetadata('sample.ts', 51, 100))
  const middle = state.observeTool('read_file', { path: 'sample.ts', startLine: 25, endLine: 75 }, readMetadata('sample.ts', 25, 75))

  assert.equal(first.meaningful, true)
  assert.deepEqual(first.evidence.newRanges, [{ startLine: 1, endLine: 100 }])
  assert.equal(head.meaningful, false)
  assert.equal(tail.meaningful, false)
  assert.equal(middle.meaningful, false)
  for (const observation of [head, tail, middle]) {
    assert.deepEqual(observation.evidence.newRanges, [])
    assert.deepEqual(observation.evidence.reconstructedRanges, [])
  }
})

test('13N-B rehydrated evidence is meaningful without changing semantic coverage', async () => {
  const { ExplorationState } = await import('../../dist/context/exploration.js')
  const { semanticProgressFingerprint } = await import('../../dist/agent/progress.js')
  const state = new ExplorationState('/repo')

  state.observeTool('read_file', { path: 'sample.ts', startLine: 1, endLine: 100 }, readMetadata('sample.ts', 1, 100))
  const before = state.snapshot()
  const fingerprintBefore = semanticProgressFingerprint({ exploration: before, todos: [], mutations: [] })

  const rehydrated = state.observeTool(
    'read_file',
    { path: 'sample.ts', startLine: 25, endLine: 75 },
    readMetadata('sample.ts', 25, 75, { cache: 'rehydrated' }),
  )
  const after = state.snapshot()
  const fingerprintAfter = semanticProgressFingerprint({ exploration: after, todos: [], mutations: [] })

  assert.equal(rehydrated.meaningful, false)
  assert.deepEqual(rehydrated.evidence.newRanges, [])
  assert.deepEqual(rehydrated.evidence.reconstructedRanges, [{ startLine: 25, endLine: 75 }])
  assert.equal(fingerprintAfter !== fingerprintBefore, false)
})

test('13N-B verify_project produces a stable semantic fact without retaining command text', async () => {
  const { ExplorationState } = await import('../../dist/context/exploration.js')
  const state = new ExplorationState('/repo')

  const first = state.observeTool('verify_project', {}, {
    verification: { status: 'passed', command: 'npm test -- --secret=do-not-persist', exitCode: 0 },
  })
  const repeat = state.observeTool('verify_project', {}, {
    verification: { status: 'passed', command: 'npm test -- --secret=do-not-persist', exitCode: 0 },
  })

  assert.equal(first.meaningful, true)
  assert.equal(repeat.meaningful, false)
  assert.equal(first.evidence.settledVerificationFacts.length, 1)
  assert.match(first.evidence.settledVerificationFacts[0], /^verify:passed:[0-9a-f]{32}$/)
  assert.doesNotMatch(first.evidence.settledVerificationFacts[0], /do-not-persist/)
})

test('13N-B search evidence is counted only when result content is genuinely new', async () => {
  const { ExplorationState } = await import('../../dist/context/exploration.js')
  const state = new ExplorationState('/repo')

  const first = state.observeTool('glob', { pattern: 'src/*.ts' }, {
    glob: { pattern: 'src/*.ts', path: '/repo', discoveredFiles: ['/repo/a.ts', '/repo/b.ts'] },
  })
  const repeat = state.observeTool('glob', { pattern: 'src/*.ts' }, {
    glob: { pattern: 'src/*.ts', path: '/repo', discoveredFiles: ['/repo/a.ts', '/repo/b.ts'] },
  })
  const expanded = state.observeTool('glob', { pattern: 'src/*.ts' }, {
    glob: { pattern: 'src/*.ts', path: '/repo', discoveredFiles: ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'] },
  })

  assert.equal(first.meaningful, true)
  assert.equal(first.evidence.novelSearchResults, 2)
  assert.equal(repeat.meaningful, false)
  assert.equal(repeat.evidence.novelSearchResults, 0)
  assert.equal(expanded.meaningful, true)
  assert.equal(expanded.evidence.novelSearchResults, 1)
  assert.deepEqual(expanded.evidence.newFiles, ['/repo/c.ts'])
})

test('13N-B settled verification facts are semantic evidence and deduplicated', async () => {
  const { ExplorationState } = await import('../../dist/context/exploration.js')
  const state = new ExplorationState('/repo')

  const first = state.observeTool('verify_project', {}, {
    verification: { status: 'passed', fact: 'npm run build passed' },
  })
  const repeat = state.observeTool('verify_project', {}, {
    verification: { status: 'passed', fact: 'npm run build passed' },
  })
  const second = state.observeTool('verify_project', {}, {
    verification: { status: 'failed', fact: 'npm test failed in one file' },
  })

  assert.equal(first.meaningful, true)
  assert.equal(repeat.meaningful, false)
  assert.equal(second.meaningful, true)
  assert.deepEqual(state.snapshot().settledVerificationFacts, ['npm run build passed', 'npm test failed in one file'])
})

test('13N-B telemetry exposes evidence deltas without treating lifecycle churn as progress', async () => {
  const { ExplorationTelemetry } = await import('../../dist/agent/exploration-telemetry.js')
  const telemetry = new ExplorationTelemetry()

  const observation = {
    meaningful: true,
    reason: 'new evidence',
    newFiles: ['/repo/a.ts'],
    newRanges: [{ startLine: 1, endLine: 10 }],
    newSearch: true,
    overlap: false,
    evidence: {
      newFiles: ['/repo/a.ts'],
      newRanges: [{ startLine: 1, endLine: 10 }],
      reconstructedRanges: [],
      novelSearchResults: 2,
      newSymbols: [{ name: 'main' }],
      settledVerificationFacts: ['npm run build passed'],
    },
  }

  telemetry.recordCall({ toolName: 'grep', input: { pattern: 'main', probe: 1 }, observation })
  telemetry.recordCall({ toolName: 'grep', input: { pattern: 'main', probe: 2 }, observation: {
    ...observation,
    meaningful: false,
    evidence: { ...observation.evidence, newFiles: [], newRanges: [], reconstructedRanges: [], novelSearchResults: 0, newSymbols: [], settledVerificationFacts: [] },
  } })

  const snapshot = telemetry.snapshot()
  assert.equal(snapshot.toolCalls, 2)
  assert.equal(snapshot.repeatedCalls, 1)
  assert.equal(snapshot.newFiles, 1)
  assert.equal(snapshot.newRanges, 1)
  assert.equal(snapshot.novelSearchResults, 2)
  assert.equal(snapshot.newSymbols, 1)
  assert.equal(snapshot.settledVerificationFacts, 1)
})
