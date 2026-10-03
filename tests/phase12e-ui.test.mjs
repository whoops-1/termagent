import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { renderActivity } from '../dist/design-system/activity.js'
import { renderPicker } from '../dist/design-system/picker.js'
import { renderDockFrame } from '../dist/design-system/surfaces.js'
import { renderDiffFile } from '../dist/design-system/diff.js'
import { statusDescriptor, todoStatus, toolStatus, activityStatus } from '../dist/design-system/status.js'
import { stripAnsi, widthOf } from '../dist/design-system/ansi.js'
import { compose3DWord } from '../dist/design-system/banner-font.js'
import { THEMES } from '../dist/design-system/theme.js'

const theme = THEMES.termagent
const capabilities = ['plain', 'ansi16', 'ansi256', 'truecolor']

function assertRowsFit(rows, width, label = 'rows') {
  for (const row of rows) assert.equal(widthOf(row), width, `${label} row width mismatch: ${widthOf(row)} != ${width}`)
}

function normalize(rows) {
  return rows.map(stripAnsi)
}

function harness(width = 80, height = 24) {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const output = new EventEmitter()
  output.columns = width
  output.rows = height
  output.write = () => true
  return { input, output }
}

test('phase12E canonical UI status vocabulary maps todo, tool, and activity states', () => {
  assert.deepEqual(statusDescriptor('pending'), { label: 'pending', marker: '[ ]' })
  assert.deepEqual(statusDescriptor('working'), { label: 'working', marker: '[>]' })
  assert.deepEqual(statusDescriptor('waiting'), { label: 'waiting', marker: '[!]' })
  assert.deepEqual(statusDescriptor('done'), { label: 'done', marker: '[x]' })
  assert.equal(todoStatus('pending'), 'pending')
  assert.equal(todoStatus('in_progress'), 'working')
  assert.equal(todoStatus('done'), 'done')
  assert.equal(toolStatus({ running: true }), 'working')
  assert.equal(toolStatus({ waiting: true }), 'waiting')
  assert.equal(toolStatus({}), 'done')
  assert.equal(activityStatus('thinking'), 'working')
  assert.equal(activityStatus('permission'), 'waiting')
  assert.equal(activityStatus('done'), 'done')
  assert.equal(activityStatus('error'), 'failed')
})

test('phase12E banner word rows are rectangular so lower T rows cannot shift', () => {
  for (const word of ['TERM', 'AGENT']) {
    const rows = compose3DWord(word, 1)
    const widths = rows.map(widthOf)
    assert.ok(widths.length === 6)
    assert.ok(widths.every((width) => width === widths[0]), `${word}: ${widths.join(', ')}`)
  }
})

test('phase12E renderers preserve identical stripped geometry across every color capability', () => {
  const pickerArgs = {
    options: [
      { label: '/provider', description: 'Switch provider profile' },
      { label: '/model', description: 'Show the current model' },
      { label: '/plugins', description: 'Manage installed plugins' },
      { label: '/skills', description: 'Browse discovered skills' },
    ],
    selectedIndex: 2,
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
  }
  const diffFile = {
    path: 'src/example.ts',
    patch: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,3 @@\n export const a = 1\n-export const b = 2\n+export const b = 3\n+export const c = 4',
    additions: 2,
    deletions: 1,
    status: 'modified',
  }
  const outputs = new Map()
  for (const capability of capabilities) {
    const picker = renderPicker({ ...pickerArgs, theme, capability })
    const activity = [renderActivity({ width: 60, phase: 'writing', label: 'Writing response', elapsedSeconds: 5, frame: 3, theme, capability })]
    const dock = renderDockFrame({ width: 60, title: 'Permission required', content: ['Allow edit?', '$ src/example.ts'], footer: '↑↓ select · Enter confirm · Esc reject', tone: 'warning', theme, capability })
    const diff = renderDiffFile({ width: 60, file: diffFile, theme, capability, view: 'unified', maxRows: 12 })
    for (const rows of [picker, activity, dock, diff]) assertRowsFit(rows, 60)
    outputs.set(capability, [normalize(picker), normalize(activity), normalize(dock), normalize(diff)])
  }
  const baseline = JSON.stringify(outputs.get('plain'))
  for (const capability of capabilities) assert.equal(JSON.stringify(outputs.get(capability)), baseline, capability)
})

test('phase12E Todo panel hides completed rows but retains completion count for active work', async () => {
  const { TerminalUI } = await import('../dist/cli/ui.js')
  const { output } = harness(80, 24)
  const ui = new TerminalUI({ title: 'todo', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    ui.setTodos([
      { id: '1', task: 'completed task', status: 'done' },
      { id: '2', task: 'active task', status: 'in_progress' },
      { id: '3', task: 'pending task', status: 'pending' },
    ])
    const activeRows = ui['todoPanelLines'](80)
    const activeText = stripAnsi(activeRows.join('\n'))
    assert.match(activeText, /Todo 1\/3/)
    assert.match(activeText, /active task/)
    assert.match(activeText, /pending task/)
    assert.doesNotMatch(activeText, /completed task/)

    ui.setTodos([{ id: '1', task: 'completed task', status: 'done' }])
    assert.deepEqual(ui['todoPanelLines'](80), [])
  } finally {
    ui.leave()
  }
})
test('phase12E activity status markers are terminal-state aware without duplicating labels', () => {
  const common = { width: 50, elapsedSeconds: 4, frame: 0, theme, capability: 'plain' }
  const thinking = stripAnsi(renderActivity({ ...common, phase: 'thinking', label: 'Thinking' }))
  const waiting = stripAnsi(renderActivity({ ...common, phase: 'permission', label: 'Permission required' }))
  const done = stripAnsi(renderActivity({ ...common, phase: 'done', label: 'Completed' }))
  const failed = stripAnsi(renderActivity({ ...common, phase: 'error', label: 'Verification failed' }))
  assert.match(thinking, /⠋ Thinking · 4s/)
  assert.match(waiting, /! Permission required · 4s/)
  assert.match(done, /✓ Completed · 4s/)
  assert.match(failed, /× Verification failed · 4s/)
  assert.doesNotMatch(done, /Completed done/)
  assert.doesNotMatch(failed, /failed failed/)
})

test('phase12E activityWidth matches rendered content budget for transient states', () => {
  for (const phase of ['thinking', 'permission', 'done', 'error']) {
    const width = 50
    const label = phase === 'permission' ? 'Permission required' : phase === 'error' ? 'Verification failed' : phase
    const rendered = stripAnsi(renderActivity({ width, phase, label, elapsedSeconds: 7, frame: 0, theme, capability: 'plain' }))
    assert.equal(rendered.length, width)
    assert.ok(rendered.trimEnd().length <= width)
  }
})

test('phase12E synthetic mouse clicks cannot interrupt an active turn, including X10 mouse reports', async () => {
  const { TerminalUI } = await import('../dist/cli/ui.js')
  for (const click of ['\x1b[<0;10;10M', '\x1b[M' + String.fromCharCode(32) + String.fromCharCode(40) + String.fromCharCode(40)]) {
    const { input, output } = harness(80, 24)
    const ui = new TerminalUI({ title: 'mouse', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
    const controller = new AbortController()
    try {
      ui.enter()
      ui.beginAgentTurn(controller)
      input.emit('data', click)
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(controller.signal.aborted, false, `mouse click interrupted turn: ${JSON.stringify(click)}`)
      assert.equal(ui['turnActive'], true)
    } finally {
      controller.abort()
      ui.endAgentTurn()
      ui.leave()
    }
  }
})
