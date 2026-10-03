import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { renderMarkdown, tableLayout } from '../dist/design-system/markdown.js'
import { renderComposer, composerStateFrom } from '../dist/design-system/composer.js'
import { renderQueuePanel } from '../dist/design-system/queue.js'
import { buildExplorationHUDModel, renderExplorationHUD } from '../dist/design-system/exploration-hud.js'
import { renderBanner } from '../dist/design-system/banner.js'
import { BANNER_EFFECTS, applyBannerEffect } from '../dist/design-system/effects.js'
import { loadThemeCatalog, listThemes } from '../dist/design-system/theme.js'
import { THEMES } from '../dist/design-system/theme.js'
import { widthOf, stripAnsi } from '../dist/design-system/ansi.js'
import { SessionStore } from '../dist/session/store.js'
import { SessionPromptQueue, projectPromptQueue } from '../dist/session/prompt-queue.js'
import { PromptEditor } from '../dist/cli/input.js'
import { saveUIPreferences } from '../dist/config/config.js'

const theme = THEMES.termagent
const noColor = 'plain'
function assertRowsFit(rows, width) {
  for (const row of rows) assert.ok(widthOf(stripAnsi(row)) <= width, `row exceeds ${width}: ${stripAnsi(row)}`)
}

function fixtureExploration() {
  return {
    state: {
      version: 1,
      cwd: '/workspace/project',
      scopePaths: [],
      discoveredFiles: ['src/agent/processor.ts'],
      files: [{ canonicalPath: '/workspace/project/src/agent/processor.ts', totalLines: 1000, coveredRanges: [{ startLine: 1, endLine: 820 }], fullCoverage: false }],
      reads: [{ canonicalPath: '/workspace/project/src/agent/processor.ts', requestedRange: { startLine: 821, endLine: 932 }, previouslyCovered: [{ startLine: 1, endLine: 820 }], newlyCovered: [{ startLine: 821, endLine: 932 }], resultingCoverage: [{ startLine: 1, endLine: 932 }], fullCoverage: false, overlap: false, overlapNoNewInfo: false, versionKey: 'v1' }],
      searches: [], symbols: [], progressRevision: 4, lastProgress: '/watch implementation',
    },
    telemetry: {
      toolCalls: 4, usefulCalls: 4, repeatedCalls: 0, overlappingCalls: 0, newFiles: 1, newRanges: 1, reconstructedEvidence: 0, searchNovelty: 0, novelSearchResults: 0, newSymbols: 0, settledVerificationFacts: 0, rounds: 2, noProgressRounds: 0, terminationReason: 'unknown',
    },
  }
}

test('13N-I table engine renders real grids, wraps content, and stays width-safe', () => {
  const source = [
    '| Command | Description | Status |',
    '| :--- | :---: | ---: |',
    '| `/watch` | Welcome message with **buttons** | ready |',
    '| `/fiat <amount> <FROM> <TO>` | A deliberately long conversion description that must wrap instead of overflow. | ready |',
    '| empty | | done |',
    '| Unicode | `🧪 漢字` | ok |',
  ].join('\n')
  for (const width of [120, 84, 64, 52, 44, 36, 30]) {
    const rows = renderMarkdown(source, { width, theme, capability: noColor })
    assert.ok(rows.length >= 4)
    assertRowsFit(rows, width)
    assert.ok(rows.some(row => row.includes('Command')))
    assert.ok(rows.some(row => row.includes('/watch')))
    assert.ok(rows.some(row => row.includes('Unicode')))
  }
  const aligned = renderMarkdown('| Name | Value |\n| ---: | :---: |\n| alpha | 42 |', { width: 52, theme, capability: noColor }).map(stripAnsi).join('\n')
  assert.match(aligned, /Name.*Value/)
  const headerRow = aligned.split('\n').find(row => row.includes('Name') && row.includes('Value')) ?? ''
  const nameColumn = headerRow.indexOf('│')
  const valueSeparator = headerRow.indexOf('│', nameColumn + 1)
  const nameStart = headerRow.indexOf('Name')
  const valueStart = headerRow.indexOf('Value')
  assert.ok(nameStart > nameColumn + 3)
  assert.ok(valueStart > valueSeparator)
  assert.ok(nameStart > headerRow.indexOf('│ ') + 10, `expected right-aligned Name header, got: ${headerRow}`)
  assert.ok(valueStart > valueSeparator + 3, `expected centered Value header, got: ${headerRow}`)
  assert.equal(tableLayout({ header: [{ source: 'A', segments: [] }, { source: 'B', segments: [] }], align: ['left', 'left'], rows: [] }, 80).mode, 'grid')
})

test('13N-I table engine handles pipe escapes, header-only tables, many columns, and ANSI-free output', () => {
  const source = [
    '| A | B | C | D | E |',
    '| --- | --- | --- | --- | --- |',
    '| one | `A\\|B` |  | wide value | final |',
  ].join('\n')
  const rows = renderMarkdown(source, { width: 56, theme, capability: noColor })
  assertRowsFit(rows, 56)
  assert.ok(rows.some(row => row.includes('A|B')))
  assert.ok(rows.some(row => /A/.test(stripAnsi(row))))
  assert.ok(!rows.join('\n').includes('\x1b['))
  const headerOnly = renderMarkdown('| Name | Meaning |\n| --- | --- |', { width: 50, theme, capability: noColor })
  assert.ok(headerOnly.length > 3)
  assertRowsFit(headerOnly, 50)
})

test('13N-I responsive composer exposes state, context, model identity, and preserves mobile density', () => {
  const meta = {
    state: composerStateFrom({ turnActive: true, queuedCount: 2, permission: false, question: false }),
    provider: 'anthropic', model: 'claude/test', mode: 'build', contextTokens: 6144, contextLimit: 12000,
    queuedCount: 2, activeTools: 2, workspace: '/workspace/project', modelLine: 'Build · claude/test Anthropic',
    tip: 'Tip: Ctrl+P opens the command palette.',
  }
  for (const width of [120, 80, 60, 44, 32]) {
    const rows = renderComposer({ width, inputLines: ['hello world'], inputCursor: { row: 0, column: 5 }, showCursor: true, meta, theme, capability: noColor })
    assertRowsFit(rows, width)
    const plain = rows.map(stripAnsi).join('\n')
    assert.match(plain, /Working/)
    if (width >= 52) assert.match(plain, /ctx 6k\/12k/)
    else assert.match(plain, /ctx 6k/)
    if (width >= 52) assert.match(plain, /Build · claude\/test/)
    if (width < 52) assert.equal(rows.length <= 5, true)
  }
})
test('13N-I user transcript surface stays visually separate from the composer', async () => {
  const input = new (await import('node:events')).EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const writes = []
  const output = { columns: 80, rows: 24, write(chunk) { writes.push(String(chunk)); return true }, on() {}, off() {} }
  const { TerminalUI } = await import('../dist/cli/ui.js')
  const ui = new TerminalUI({ title: 'surface', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter(); ui.addUser('hello from user'); ui.setInput('draft in composer'); await new Promise(r => setTimeout(r, 10))
    const plain = stripAnsi(writes.join(''))
    assert.match(plain, /You/)
    assert.match(plain, /hello from user/)
    assert.match(plain, /draft in composer/)
    assert.doesNotMatch(plain, /◆ You/)
    assert.ok(widthOf(stripAnsi(ui['bodyLines'](80)[0])) <= 80)
  } finally { ui.leave() }
})

test('13N-I queue surface distinguishes running work from editable pending prompts', () => {
  const now = Date.now()
  const items = [
    { id: 'qp-run', sessionId: 's', content: 'active message', createdAt: now, updatedAt: now, position: 0, status: 'executing', sourceClient: 'terminal' },
    ...[1, 2, 3].map(i => ({ id: `qp-${i}`, sessionId: 's', content: `queued message ${i}`, createdAt: now + i, updatedAt: now + i, position: i, status: 'queued', sourceClient: 'terminal' })),
  ]
  const rows = renderQueuePanel({ width: 80, items, theme, capability: noColor })
  const plain=rows.map(stripAnsi).join('\n')
  assertRowsFit(rows, 80)
  assert.match(plain, /Queue · 3 queued · 1 running/)
  assert.match(plain, /running/)
  assert.match(plain, /active message.*running/)
  assert.match(plain, /edit · ×/)
  assert.doesNotMatch(plain, /edit · ×\s*$/m)
})

test('13N-I exploration HUD projects reading/search/verification/complete states from existing semantic telemetry', () => {
  const f = fixtureExploration()
  const reading = buildExplorationHUDModel(f.state, f.telemetry, 'read_file', true)
  assert.equal(reading?.mode, 'reading')
  assert.equal(reading?.percent, 82)
  assert.match(reading?.remainingLabel ?? '', /821-1000/)
  assertRowsFit(renderExplorationHUD({ width: 72, model: reading, theme, capability: noColor }), 72)

  const searching = buildExplorationHUDModel(f.state, f.telemetry, 'grep', true)
  assert.equal(searching?.mode, 'searching')

  const verifying = buildExplorationHUDModel({ ...f.state, settledVerificationFacts: ['verify:build:ok'] }, { ...f.telemetry, settledVerificationFacts: 1 }, 'verify_project', true)
  assert.equal(verifying?.mode, 'verifying')

  const complete = buildExplorationHUDModel({ ...f.state, files: [{ ...f.state.files[0], coveredRanges: [{ startLine: 1, endLine: 1000 }], fullCoverage: true }] }, f.telemetry, undefined, true)
  assert.equal(complete?.mode, 'complete')
})

test('13N-I themes load built-ins and project overrides, then persist the selected theme', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-theme-'))
  try {
    await fs.mkdir(path.join(cwd, '.termagent', 'themes'), { recursive: true })
    await fs.writeFile(path.join(cwd, '.termagent', 'themes', 'project.json'), JSON.stringify({ id: 'project-slate', name: 'Project Slate', description: 'A project palette', text: '#abcabc' }))
    const catalog = await loadThemeCatalog(cwd)
    const rows = listThemes(catalog)
    assert.ok(catalog.termagent)
    assert.ok(Object.keys(catalog).length >= 7)
    const project = catalog['project']
    assert.equal(project?.text, '#abcabc')
    assert.ok(rows.some(entry => entry.id === 'project'))
    await saveUIPreferences(cwd, { theme: 'termagent' })
    const saved = JSON.parse(await fs.readFile(path.join(cwd, '.termagent', 'config.json'), 'utf8'))
    assert.equal(saved.ui.theme, 'termagent')
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})
test('13N-I disabled animations do not install an ambient redraw timer', async () => {
  const { TerminalUI } = await import('../dist/cli/ui.js')
  const output = { columns: 80, rows: 24, write() { return true }, on() {}, off() {} }
  const input = new (await import('node:events')).EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input; input.resume = () => input; input.pause = () => input; input.setEncoding = () => input
  const ui = new TerminalUI({ title: 'motion', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input, animations: false })
  try { ui.enter(); assert.equal(ui['ambientTimer'], undefined) } finally { ui.leave() }
})

test('13N-I ambient effects and banner modes are terminal-safe and bounded', () => {
  for (const width of [120, 72, 52, 40, 30]) {
    const banner = renderBanner({ width, version: '1.18.0', theme, capability: noColor })
    assertRowsFit(banner, width)
    for (const effect of BANNER_EFFECTS) {
      const rows = applyBannerEffect({ rows: banner, width, frame: 2, effect: effect.id, theme, capability: noColor })
      assertRowsFit(rows, width)
    }
  }
  const rows = ['hello'.padEnd(40), 'world'.padEnd(40)]
  assert.deepEqual(applyBannerEffect({ rows, width: 40, frame: 1, effect: 'off', theme, capability: noColor }), rows)
  assert.deepEqual(applyBannerEffect({ rows, width: 40, frame: 1, effect: 'pulse', theme, capability: noColor }), rows)
})

test('13N-I runtime queue is durable, ordered, editable, cancellable, and serialized by session mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-queue-'))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-cwd-'))
  try {
    const store = new SessionStore(root)
    const session = await store.create(cwd, 'mock/provider')
    const queue = new SessionPromptQueue(store)
    const [a, b, c, d] = await Promise.all(['first', 'second', 'third', 'fourth'].map(content => queue.enqueue(session.id, content, { sourceClient: 'terminal' })))
    let items = await queue.list(session.id)
    assert.deepEqual(items.map(x => x.content), ['first', 'second', 'third', 'fourth'])
    assert.deepEqual(items.map(x => x.position), [0, 1, 2, 3])

    await queue.edit(session.id, b.id, 'second edited')
    await queue.move(session.id, d.id, -1)
    items = await queue.list(session.id)
    assert.equal(items.find(x => x.id === b.id)?.content, 'second edited')
    assert.deepEqual(items.map(x => x.content), ['first', 'second edited', 'fourth', 'third'])

    const next = await queue.claimNext(session.id)
    assert.equal(next?.status, 'executing')
    assert.equal(next?.id, a.id)
    assert.equal((await queue.list(session.id)).length, 4)
    assert.equal((await queue.list(session.id)).filter(x => x.status === 'queued').length, 3)
    await queue.complete(session.id, next.id)
    await queue.cancel(session.id, c.id)

    const replay = await store.load(session.id)
    const projected = projectPromptQueue(replay.events, false)
    assert.equal(projected.find(x => x.id === a.id)?.status, 'completed')
    assert.equal(projected.find(x => x.id === c.id)?.status, 'cancelled')
    assert.equal(projected.filter(x => x.status === 'queued').length, 2)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(cwd, { recursive: true, force: true })
  }
})
test('13N-I queued prompt edits stay edits and do not create a duplicate queue item', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-queue-edit-'))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-queue-cwd-'))
  try {
    const store = new SessionStore(root)
    const session = await store.create(cwd, 'mock/provider')
    const queue = new SessionPromptQueue(store)
    const item = await queue.enqueue(session.id, 'original')
    await queue.edit(session.id, item.id, 'edited while agent works')
    const items = await queue.list(session.id)
    assert.equal(items.length, 1)
    assert.equal(items[0]?.content, 'edited while agent works')
    assert.equal(items[0]?.status, 'queued')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(cwd, { recursive: true, force: true })
  }
})
test('13N-I stale executing prompts recover to queued state after runtime restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-queue-recover-'))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-queue-recover-cwd-'))
  try {
    const store = new SessionStore(root)
    const session = await store.create(cwd, 'mock/provider')
    const first = new SessionPromptQueue(store)
    const item = await first.enqueue(session.id, 'recover me')
    await first.claimNext(session.id)
    assert.equal((await first.list(session.id)).find(x => x.id === item.id)?.status, 'executing')

    const restarted = new SessionPromptQueue(store)
    assert.equal(await restarted.recoverStaleExecuting(session.id), 1)
    const recovered = await restarted.list(session.id)
    assert.equal(recovered.find(x => x.id === item.id)?.status, 'queued')
    assert.equal((await restarted.claimNext(session.id))?.id, item.id)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('prompt editor exposes dedicated live-overlay routing hooks for inspector control', async () => {
  const seen = []
  const editor = new PromptEditor({
    onOverlayKey: key => { seen.push(key) },
    isOverlayActive: () => true,
    isModalActive: () => false,
  })
  const result = await editor['handleSequence']?.('\x1b[A')
  assert.equal(result, null)
  assert.deepEqual(seen, ['up'])
})
