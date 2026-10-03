import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { renderPicker, pickerLayout } from '../dist/design-system/picker.js'
import { THEMES, themeTokens } from '../dist/design-system/theme.js'
import { TranscriptRenderCache } from '../dist/design-system/transcript-cache.js'
import { HitTargetRegistry } from '../dist/design-system/hit-targets.js'
import { defaultCompletionItems, parsePromptMouseSequence, PromptEditor } from '../dist/cli/input.js'
import { TerminalUI } from '../dist/cli/ui.js'

function wait(ms = 10) { return new Promise(resolve => setTimeout(resolve, ms)) }
function captureOutput(columns = 80, rows = 24) {
  const writes = []
  const output = new EventEmitter()
  output.columns = columns
  output.rows = rows
  output.write = chunk => { writes.push(String(chunk)); return true }
  return { writes, output }
}

const theme = THEMES.termagent

test('13N-I picker rows render semantic label/detail/badge/status without legacy display parsing', () => {
  const rows = renderPicker({
    width: 64,
    selectedIndex: 0,
    theme,
    capability: 'plain',
    title: 'Picker',
    footer: 'choose',
    commandLayout: true,
    rows: [
      { id: 'provider:openai', label: 'OpenAI', detail: 'Production', badge: 'active', status: 'active', value: 'openai' },
      { id: 'provider:bad', label: 'Broken', detail: 'Unavailable', badge: 'error', status: 'error', value: 'bad' },
    ],
  })
  assert.ok(rows.some(row => row.includes('OpenAI')))
  assert.ok(rows.some(row => row.includes('Production')))
  assert.ok(rows.some(row => row.includes('[active]')))
  assert.ok(rows.some(row => row.includes('Broken')))
  assert.ok(rows.some(row => row.includes('[error]')))
})

test('13N-I picker layout and semantic hit viewport agree on short terminals', () => {
  const options = {
    total: 20,
    selectedIndex: 11,
    maxVisible: 8,
    availableRows: 9,
    commandStacked: true,
    framed: true,
    hasQuery: false,
    hasFooter: true,
  }
  const layout = pickerLayout(options)
  assert.equal(layout.window.end - layout.window.start, layout.maxVisible)
  assert.ok(layout.window.start <= 11 && layout.window.end > 11)
  assert.equal(layout.rowHeight, 2)
  assert.equal(layout.listOffsetRows, 1)
})

test('13N-I transcript cache rerenders only on revision/key changes', () => {
  const cache = new TranscriptRenderCache()
  const entry = {}
  let renders = 0
  const render = () => { renders++; return { lines: [`frame-${renders}`] } }
  assert.deepEqual(cache.getOrRender(entry, '80|dark', 0, render).lines, ['frame-1'])
  assert.deepEqual(cache.getOrRender(entry, '80|dark', 0, render).lines, ['frame-1'])
  assert.deepEqual(cache.getOrRender(entry, '80|dark', 1, render).lines, ['frame-2'])
  assert.deepEqual(cache.getOrRender(entry, '96|dark', 1, render).lines, ['frame-3'])
  assert.equal(renders, 3)
  assert.deepEqual(cache.stats(), { hits: 1, misses: 3 })
})

test('13N-I semantic hit targets prioritize explicit controls and block ordinary busy clicks', async () => {
  const registry = new HitTargetRegistry()
  const calls = []
  registry.register({ id: 'row', x: 0, y: 0, width: 20, height: 2, onActivate: () => calls.push('row') })
  registry.register({ id: 'interrupt', x: 0, y: 0, width: 20, height: 2, priority: 100, allowWhileBusy: true, onActivate: () => calls.push('interrupt') })
  assert.equal(registry.hitTest(2, 1, { busy: false }).id, 'interrupt')
  assert.equal(registry.hitTest(2, 1, { busy: true }).id, 'interrupt')
  assert.equal(await registry.dispatch(2, 1, { busy: true }), true)
  assert.deepEqual(calls, ['interrupt'])

  const normal = new HitTargetRegistry()
  normal.register({ id: 'ordinary', x: 0, y: 0, width: 20, onActivate: () => calls.push('ordinary') })
  assert.equal(await normal.dispatch(2, 0, { busy: true }), false)

  const disabled = new HitTargetRegistry()
  disabled.register({ id: 'disabled', x: 0, y: 0, width: 20, disabled: true, onActivate: () => calls.push('disabled') })
  assert.equal(disabled.hitTest(2, 0)?.id, undefined)
  assert.equal(await disabled.dispatch(2, 0), false)
})

test('13N-I mouse parser normalizes SGR and X10 coordinates for semantic dispatch', () => {
  assert.deepEqual(parsePromptMouseSequence('\x1b[<0;7;9M'), {
    button: 0, column: 6, row: 8, action: 'press', protocol: 'sgr'
  })
  assert.deepEqual(parsePromptMouseSequence('\x1b[<0;7;9m'), {
    button: 0, column: 6, row: 8, action: 'release', protocol: 'sgr'
  })
  const x10 = '\x1b[M' + String.fromCharCode(32, 40, 42)
  assert.deepEqual(parsePromptMouseSequence(x10), {
    button: 0, column: 7, row: 9, action: 'press', protocol: 'x10'
  })
  assert.equal(parsePromptMouseSequence('\x1b[5~'), null)
})

test('13N-I default completion source emits semantic rows while legacy adapter stays string-compatible', async () => {
  const cwd = process.cwd()
  const complete = defaultCompletionItems(['help', 'model'], ['reviewer'], cwd)
  const rows = await complete('/', 1)
  assert.deepEqual(rows.map(row => row.value), ['/help', '/model'])
  assert.deepEqual(rows.map(row => row.id), ['command:help', 'command:model'])
  assert.equal(rows[0].label, '/help')

  const legacy = await (await import('../dist/cli/input.js')).defaultCompletions(['help'], [], cwd)('/', 1)
  assert.deepEqual(legacy, ['/help'])
})

test('13N-I PromptEditor exposes structured completion rows and click selection', async () => {
  const seen = []
  const editor = new PromptEditor({
    completions: () => [{ id: 'command:help', label: '/help', value: '/help', detail: 'Show help', badge: 'core', status: 'active' }],
    onCompletion: state => seen.push(state),
    onChange: () => {},
  })
  await editor.handleSequence('/')
  const state = seen.at(-1)
  assert.equal(state.rows[0].id, 'command:help')
  assert.equal(state.rows[0].detail, 'Show help')
  await editor.clickCompletion(0)
  assert.equal(editor.snapshot().value, '/help')
})

test('13N-I TerminalUI caches stable transcript entries and registers semantic picker/interrupt targets', async () => {
  const { output } = captureOutput(80, 24)
  const ui = new TerminalUI({
    title: 'semantic-ui', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output,
    onMouseTarget: async () => {},
  })
  try {
    ui.enter()
    await wait()
    ui.addUser('stable message')
    await wait()
    const before = ui.transcriptCacheStats()
    ui.setInput('typing')
    await wait()
    const after = ui.transcriptCacheStats()
    assert.ok(after.hits > before.hits, `expected stable transcript cache hit: ${JSON.stringify({ before, after })}`)

    ui.setCompletion({
      kind: 'command',
      items: ['/help', '/model'],
      rows: [
        { id: 'command:help', label: '/help', value: '/help', detail: 'Show help' },
        { id: 'command:model', label: '/model', value: '/model', detail: 'Show model' },
      ],
      index: 0,
      query: '',
    })
    await wait()
    assert.ok(ui.hitTargetSnapshot().some(target => target.id === 'picker:0'))

    const controller = new AbortController()
    ui.beginAgentTurn(controller)
    ui.render()
    const interrupt = ui.hitTargetSnapshot().find(target => target.id === 'interrupt')
    assert.ok(interrupt)
    assert.equal(controller.signal.aborted, false)
    await ui.handleMouse({ button: 0, column: 0, row: interrupt.y, action: 'press', protocol: 'sgr' })
    assert.equal(controller.signal.aborted, true)
  } finally {
    ui.leave()
  }
})

test('13N-I semantic theme tokens are stable and grouped for future renderers', () => {
  const first = themeTokens(theme)
  const second = themeTokens(theme)
  assert.equal(first, second)
  assert.equal(first.surface.background, theme.background)
  assert.equal(first.content.text, theme.text)
  assert.equal(first.status.warning, theme.warning)
  assert.equal(first.role.assistant, theme.assistant)
  assert.equal(first.diff.added, theme.diffAdded)
  assert.equal(first.syntax.keyword, theme.syntaxKeyword)
})
