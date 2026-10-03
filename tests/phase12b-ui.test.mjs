import test from 'node:test'
import assert from 'node:assert/strict'
import { renderPicker, pickerWindow } from '../dist/design-system/picker.js'
import { renderUserTurn, renderAssistantTurn } from '../dist/design-system/transcript.js'
import { stripAnsi, widthOf } from '../dist/design-system/ansi.js'
import { THEMES } from '../dist/design-system/theme.js'

const theme = THEMES.termagent

function fakeOutput(columns, rows = 24) {
  const writes = []
  return {
    output: { columns, rows, write(value) { writes.push(value); return true }, on() {}, off() {} },
    writes,
  }
}

function assertWidth(rows, width) {
  for (const row of rows) assert.ok(widthOf(row) <= width, `row exceeded ${width}: ${stripAnsi(row)}`)
}

test('Phase 12B transcript removes repeated speaker badges and keeps user panel semantics', () => {
  for (const width of [40, 56, 80, 120]) {
    const user = renderUserTurn({ text: 'Explain the new terminal UI.', width, theme, capability: 'truecolor' })
    const assistant = renderAssistantTurn({ text: 'The content is now the identity cue.', reasoning: 'Check transcript hierarchy.', width, theme, capability: 'truecolor' })
    const plain = stripAnsi([...user, ...assistant].join('\n'))

    assert.doesNotMatch(plain, /◆ You/)
    assert.doesNotMatch(plain, /◆ TermAgent/)
    assert.match(stripAnsi(user[0]), /^│  /)
    assert.match(plain, /Explain the new terminal UI\./)
    assert.match(plain, /The content is now the identity/)
    assert.match(plain, /cue\./)
    assertWidth([...user, ...assistant], width)
  }
})

test('Phase 12B command picker uses a bounded 60-column frame at wide widths', () => {
  const rows = renderPicker({
    options: [
      { label: '/provider', description: 'Switch provider profile' },
      { label: '/model', description: 'Show the current model' },
      { label: '/plugins', description: 'Manage installed plugins' },
    ],
    selectedIndex: 0,
    width: 60,
    maxVisible: 8,
    availableRows: 20,
    title: 'Command palette',
    footer: '↑↓ select · Enter run · Esc close',
    commandLayout: true,
    commandNameWidth: 24,
    commandDescriptionGap: 2,
    commandItemPaddingLeft: 3,
    commandItemPaddingRight: 3,
    theme,
    capability: 'plain',
  })
  assertWidth(rows, 60)
  assert.equal(widthOf(rows[1]), 60)
  const line = stripAnsi(rows[1])
  assert.equal(line.indexOf('Switch provider profile'), 30)
  assert.match(line, /› \/provider/)
  assert.doesNotMatch(line, /Type to search/)
})

test('Phase 12B command picker stacks descriptions below 56 terminal columns', () => {
  const rows = renderPicker({
    options: [
      { label: '/provider', description: 'Switch provider profile' },
      { label: '/model', description: 'Show the current model' },
      { label: '/plugins', description: 'Manage installed plugins' },
    ],
    selectedIndex: 0,
    width: 48,
    maxVisible: 8,
    availableRows: 20,
    title: 'Commands',
    footer: '↑↓ select · Enter run · Esc close',
    commandLayout: 'stacked',
    commandNameWidth: 24,
    commandDescriptionGap: 2,
    commandItemPaddingLeft: 3,
    commandItemPaddingRight: 3,
    theme,
    capability: 'plain',
  })
  assertWidth(rows, 48)
  const plain = rows.map(stripAnsi)
  const providerRow = plain.findIndex(x => x.includes('/provider'))
  assert.equal(plain[providerRow + 1]?.replace(/^│\s*/, '').replace(/\s*│$/, '').trim(), 'Switch provider profile')
  assert.ok(!plain[providerRow].includes('Switch provider profile'))
})

test('Phase 12B picker viewport remains globally indexed and height-aware', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ label: `/command-${i + 1}`, description: `Description ${i + 1}` }))
  for (const selectedIndex of [0, 7, 8, 15, 19]) {
    const win = pickerWindow(items.length, selectedIndex, 8)
    assert.ok(selectedIndex >= win.start && selectedIndex < win.end)
  }

  for (const availableRows of [7, 8, 9, 10, 11, 12, 14]) {
    const rows = renderPicker({
      options: items,
      selectedIndex: 15,
      width: 60,
      maxVisible: 8,
      availableRows,
      title: 'Command palette',
      query: '',
      footer: '↑↓ select · Enter run · Esc close',
      commandLayout: true,
      commandNameWidth: 24,
      commandDescriptionGap: 2,
      commandItemPaddingLeft: 3,
      commandItemPaddingRight: 3,
      theme,
      capability: 'plain',
    })
    assert.ok(rows.length <= availableRows, `picker ${rows.length} > ${availableRows}`)
    assertWidth(rows, 60)
    const plain = stripAnsi(rows.join('\n'))
    assert.match(plain, /command-16/)
  }
})

test('Phase 12B command picker matches deterministic snapshots across the supported terminal widths', async () => {
  const fs = await import('node:fs')
  const descriptions = {
    help: 'Show available commands',
    model: 'Show the current model',
    provider: 'Switch provider profile',
    agent: 'Choose an agent mode',
    agents: 'List available agents',
    commands: 'List custom commands',
    plan: 'Switch to read-only planning',
    build: 'Switch to development mode',
    explore: 'Switch to read-only exploration',
    sessions: 'List saved sessions',
    resume: 'Resume a saved session',
    fork: 'Fork the current session',
    skills: 'Browse discovered skills',
  }
  const items = Object.entries(descriptions).map(([key, description]) => ({ label: `/${key}`, description }))
  for (const width of [40, 48, 56, 60, 64, 80, 120]) {
    const pickerWidth = Math.min(60, Math.max(24, width - 4))
    const rows = renderPicker({
      options: items,
      selectedIndex: 3,
      width: pickerWidth,
      maxVisible: 8,
      availableRows: 14,
      title: 'Commands',
      query: '',
      footer: '↑↓ select · Enter run · Esc close',
      commandLayout: width >= 56 ? true : 'stacked',
      commandNameWidth: 24,
      commandDescriptionGap: 2,
      commandItemPaddingLeft: 3,
      commandItemPaddingRight: 3,
      theme,
      capability: 'plain',
    })
    const expected = fs.readFileSync(`tests/qa/snapshots/phase12b-picker-${width}.txt`, 'utf8').replace(/\n+$/, '')
    assert.equal(rows.map(stripAnsi).join('\n'), expected, `snapshot mismatch at ${width} columns`)
  }
})
test('Phase 12B TerminalUI transcript no longer paints speaker badges', async () => {
  const { TerminalUI } = await import('../dist/cli/ui.js')
  for (const width of [40, 56, 80]) {
    const { output, writes } = fakeOutput(width)
    const ui = new TerminalUI({ title: 'transcript', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output })
    try {
      ui.enter()
      ui.addUser('hello from the user')
      ui.startAssistant()
      ui.appendAssistant('hello from the assistant')
      await new Promise(resolve => setTimeout(resolve, 20))
      const plain = stripAnsi(writes.at(-1) ?? '')
      assert.doesNotMatch(plain, /◆ You/)
      assert.doesNotMatch(plain, /◆ TermAgent/)
      assert.match(plain, /hello from the user/)
      assert.match(plain, /hello from the assistant/)
    } finally {
      ui.leave()
    }
  }
})

test('Phase 12B TerminalUI command picker stays bounded and preserves the global selection index', async () => {
  const { TerminalUI } = await import('../dist/cli/ui.js')
  for (const width of [40, 48, 56, 60, 64, 80, 120]) {
    const { output, writes } = fakeOutput(width)
    const ui = new TerminalUI({ title: 'picker', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output })
    try {
      ui.enter()
      ui.setCompletion({ kind: 'palette', items: Array.from({ length: 12 }, (_, i) => `/command-${String(i + 1).padStart(2, '0')}`), index: 9, query: '' })
      await new Promise(resolve => setTimeout(resolve, 20))
      const plain = stripAnsi(writes.at(-1) ?? '')
      assert.match(plain, /\/command-10/)
      assert.ok(width <= 60 || width >= 56)
    } finally {
      ui.leave()
    }
  }
})
