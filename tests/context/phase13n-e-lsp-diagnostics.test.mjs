import test from 'node:test'
import assert from 'node:assert/strict'

function diagnostic(message, severity = 1) {
  return {
    message,
    severity,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    source: 'typescript',
  }
}

test('13N-E: empty first publication stays provisional and only becomes clean after quiescence plus minimum settle time', async () => {
  const { LspDiagnosticTracker } = await import('../../dist/context/lsp-diagnostics.js')
  const tracker = new LspDiagnosticTracker({ quiescenceMs: 70, minSettleMs: 150, budgetMs: 500 })
  tracker.begin({ key: 'ts:/repo/a.ts', serverId: 'typescript', filePath: '/repo/a.ts', startedAt: 0 })

  tracker.publish('ts:/repo/a.ts', { diagnostics: [], timestamp: 10 })
  assert.equal(tracker.status('ts:/repo/a.ts', 100).status, 'provisional')
  assert.equal(tracker.status('ts:/repo/a.ts', 149).status, 'provisional')
  assert.equal(tracker.status('ts:/repo/a.ts', 160).status, 'clean')
})

test('13N-E: asynchronous stale-to-final publication cannot render the stale empty set as clean', async () => {
  const { LspDiagnosticTracker } = await import('../../dist/context/lsp-diagnostics.js')
  const tracker = new LspDiagnosticTracker({ quiescenceMs: 30, minSettleMs: 80, budgetMs: 500 })
  const startedAt = Date.now()
  tracker.begin({ key: 'ra:/repo/lib.rs', serverId: 'rust-analyzer', filePath: '/repo/lib.rs', startedAt })

  const wait = tracker.waitForSettled('ra:/repo/lib.rs', { pollMs: 5 })
  await new Promise(resolve => setTimeout(resolve, 10))
  tracker.publish('ra:/repo/lib.rs', { diagnostics: [], timestamp: Date.now() })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(tracker.get('ra:/repo/lib.rs').status, 'provisional')
  tracker.publish('ra:/repo/lib.rs', { diagnostics: [diagnostic('missing import', 2)], timestamp: Date.now() })
  const settled = await wait
  assert.equal(settled.status, 'clean')
  assert.equal(settled.errorCount, 0)
  assert.equal(settled.warningCount, 1)
})

test('13N-E: an error publication settles as failed after the server becomes quiet', async () => {
  const { LspDiagnosticTracker } = await import('../../dist/context/lsp-diagnostics.js')
  const tracker = new LspDiagnosticTracker({ quiescenceMs: 40, minSettleMs: 100, budgetMs: 300 })
  tracker.begin({ key: 'ts:/repo/a.ts', serverId: 'typescript', filePath: '/repo/a.ts', startedAt: 1000 })
  tracker.publish('ts:/repo/a.ts', { diagnostics: [diagnostic('type error', 1)], timestamp: 1020 })
  assert.equal(tracker.status('ts:/repo/a.ts', 1050).status, 'provisional')
  const settled = tracker.status('ts:/repo/a.ts', 1061)
  assert.equal(settled.status, 'failed')
  assert.equal(settled.errorCount, 1)
})

test('13N-E: no publication before the diagnostics budget becomes timed_out, never clean', async () => {
  const { LspDiagnosticTracker } = await import('../../dist/context/lsp-diagnostics.js')
  const tracker = new LspDiagnosticTracker({ quiescenceMs: 20, minSettleMs: 50, budgetMs: 100 })
  tracker.begin({ key: 'go:/repo/main.go', serverId: 'gopls', filePath: '/repo/main.go', startedAt: 0 })
  assert.equal(tracker.status('go:/repo/main.go', 99).status, 'running')
  const timeout = tracker.status('go:/repo/main.go', 100)
  assert.equal(timeout.status, 'timed_out')
})

test('13N-E: cancellation is explicit and terminal', async () => {
  const { LspDiagnosticTracker } = await import('../../dist/context/lsp-diagnostics.js')
  const tracker = new LspDiagnosticTracker({ budgetMs: 500 })
  tracker.begin({ key: 'py:/repo/a.py', serverId: 'pyright', filePath: '/repo/a.py', startedAt: 0 })
  const cancelled = tracker.cancel('py:/repo/a.py', 'user cancelled', 30)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.reason, 'user cancelled')
})

test('13N-E: duplicate publications are coalesced and semantic fingerprint ignores lifecycle timing fields', async () => {
  const { LspDiagnosticTracker, lspDiagnosticSemanticFingerprint } = await import('../../dist/context/lsp-diagnostics.js')
  const tracker = new LspDiagnosticTracker({ quiescenceMs: 10, minSettleMs: 10, budgetMs: 100 })
  tracker.begin({ key: 'ts:/repo/a.ts', serverId: 'typescript', filePath: '/repo/a.ts', startedAt: 0 })
  const first = tracker.publish('ts:/repo/a.ts', { diagnostics: [diagnostic('same', 2), diagnostic('same', 2)], timestamp: 1 })
  const second = tracker.publish('ts:/repo/a.ts', { diagnostics: [diagnostic('same', 2)], timestamp: 2 })
  assert.equal(first.diagnostics.length, 1)
  assert.equal(second.diagnostics.length, 1)
  const a = lspDiagnosticSemanticFingerprint({ ...second, publicationCount: 2, startedAt: 1, lastPublicationAt: 2, settledAt: 3 })
  const b = lspDiagnosticSemanticFingerprint({ ...second, publicationCount: 99, startedAt: 900, lastPublicationAt: 901, settledAt: 999 })
  assert.equal(a, b)
})

test('13N-E: provisional LSP evidence is excluded from exploration progress, settled evidence is retained', async () => {
  const { ExplorationState } = await import('../../dist/context/exploration.js')
  const exploration = new ExplorationState('/repo')
  const first = exploration.observeTool('lsp_diagnostics', {}, {
    lspDiagnostics: { status: 'provisional', serverId: 'typescript', filePath: '/repo/a.ts', diagnosticCount: 0, errorCount: 0, warningCount: 0 },
  })
  assert.equal(first.meaningful, false)
  const settled = exploration.observeTool('lsp_diagnostics', {}, {
    lspDiagnostics: { status: 'clean', serverId: 'typescript', filePath: '/repo/a.ts', diagnosticCount: 0, errorCount: 0, warningCount: 0 },
  })
  assert.equal(settled.meaningful, true)
  assert.equal(exploration.snapshot().settledVerificationFacts.length, 1)
})

test('13N-E: evidence ledger carries provisional and settled LSP state without task identifiers or timestamps', async () => {
  const { buildEvidenceLedger } = await import('../../dist/context/evidence-ledger.js')
  const exploration = {
    version: 1,
    cwd: '/repo',
    scopePaths: [],
    discoveredFiles: [],
    files: [],
    reads: [],
    searches: [],
    symbols: [],
    progressRevision: 0,
    settledVerificationFacts: [],
  }
  const ledger = buildEvidenceLedger({
    exploration,
    lspDiagnostics: [
      { serverId: 'typescript', filePath: '/repo/a.ts', status: 'provisional', diagnosticCount: 0, errorCount: 0, warningCount: 0, reason: 'indexing' },
      { serverId: 'typescript', filePath: '/repo/a.ts', status: 'clean', diagnosticCount: 0, errorCount: 0, warningCount: 0 },
    ],
    tasks: [{ id: 'secret-task-id', kind: 'lsp', status: 'done', termination: 'completed', exitCode: 0, outputPath: '/private/log' }],
  })
  assert.equal(ledger.lspDiagnostics.length, 2)
  assert.equal(ledger.lspDiagnostics[0].status, 'provisional')
  assert.equal(ledger.lspDiagnostics[1].status, 'clean')
  assert.ok(!ledger.fingerprint.includes('secret-task-id'))
  assert.ok(!ledger.fingerprint.includes('/private/log'))
})

test('13N-E: lifecycle LSP metadata is normalized into the ledger automatically', async () => {
  const { buildEvidenceLedger } = await import('../../dist/context/evidence-ledger.js')
  const exploration = {
    version: 1,
    cwd: '/repo',
    scopePaths: [],
    discoveredFiles: [],
    files: [],
    reads: [],
    searches: [],
    symbols: [],
    progressRevision: 0,
    settledVerificationFacts: [],
  }
  const ledger = buildEvidenceLedger({
    exploration,
    lifecycle: [{
      callId: 'call-1',
      turnId: 'turn-1',
      name: 'lsp_diagnostics',
      state: 'completed',
      outcome: 'success',
      arguments: {},
      metadata: {
        lspDiagnostics: {
          serverId: 'typescript',
          filePath: '/repo/a.ts',
          status: 'provisional',
          diagnosticCount: 0,
          errorCount: 0,
          warningCount: 0,
          timestamp: 123456,
        },
      },
      startedAt: 1,
      endedAt: 2,
    }],
  })
  assert.deepEqual(ledger.lspDiagnostics, [{
    serverId: 'typescript',
    filePath: '/repo/a.ts',
    status: 'provisional',
    diagnosticCount: 0,
    errorCount: 0,
    warningCount: 0,
  }])
})

test('13N-E: unknown state is explicit before a diagnostic run exists', async () => {
  const { LspDiagnosticTracker } = await import('../../dist/context/lsp-diagnostics.js')
  const tracker = new LspDiagnosticTracker()
  const unknown = tracker.get('missing')
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.serverId, '')
})

test('13N-E: an early empty publication can still time out instead of becoming clean when the budget is shorter than the minimum settle window', async () => {
  const { LspDiagnosticTracker } = await import('../../dist/context/lsp-diagnostics.js')
  const tracker = new LspDiagnosticTracker({ quiescenceMs: 10, minSettleMs: 100, budgetMs: 50 })
  tracker.begin({ key: 'ts:/repo/a.ts', serverId: 'typescript', filePath: '/repo/a.ts', startedAt: 0 })
  tracker.publish('ts:/repo/a.ts', { diagnostics: [], timestamp: 10 })
  assert.equal(tracker.status('ts:/repo/a.ts', 30).status, 'provisional')
  assert.equal(tracker.status('ts:/repo/a.ts', 50).status, 'timed_out')
})

test('13N-E: legacy checkpoints without the LSP ledger field remain renderable', async () => {
  const { renderMachineState } = await import('../../dist/context/state.js')
  const legacy = {
    version: 1,
    sessionId: 's',
    epoch: 1,
    checkpointId: 'c',
    sourceEventCount: 0,
    projectionHash: 'hash',
    summaryRevision: 0,
    readCoverage: [],
    evidenceLedger: {
      version: 1,
      progressRevision: 0,
      fingerprint: 'fp',
      files: [],
      searches: [],
      symbols: [],
      verifications: [],
      mutations: [],
      tasks: [],
    },
    toolOutputReferences: [],
    activeTaskIds: [],
    todo: [],
    mutations: [],
    createdAt: 0,
  }
  const rendered = renderMachineState(legacy, 300)
  assert.match(rendered, /evidenceLedger=rev:0/)
  assert.doesNotMatch(rendered, /lsp:/)
})
