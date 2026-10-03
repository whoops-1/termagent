import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TerminalUI } from '../dist/cli/ui.js'
import { stripAnsi, widthOf } from '../dist/design-system/ansi.js'
import { renderPicker } from '../dist/design-system/picker.js'
import { THEMES } from '../dist/design-system/theme.js'

const SIZES = [
  [40, 20], [48, 20], [56, 20], [60, 24], [64, 24],
  [80, 24], [100, 30], [120, 30], [160, 40],
]
const THEME = THEMES.termagent

function wait(ms = 10) { return new Promise(resolve => setTimeout(resolve, ms)) }

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
  output.writes = []
  output.write = chunk => { output.writes.push(String(chunk)); return true }
  return { input, output }
}

function assertFrame(ui, width, height) {
  const frame = ui['previousFrame']
  assert.equal(frame.length, height, `frame row count mismatch at ${width}x${height}`)
  for (const [index, row] of frame.entries()) {
    assert.equal(widthOf(row), width, `row ${index + 1} width mismatch at ${width}x${height}`)
  }
}

function diffResult(fileCount = 1) {
  const files = []
  const chunks = []
  for (let i = 0; i < fileCount; i++) {
    const name = 'src/example-000.ts'
    const patch = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,3 +1,4 @@\n const before = ${i}\n-const value = ${i}\n+const value = ${i + 1}\n+const extra = ${i}\n`
    files.push({ path: name, status: 'modified', additions: 2, deletions: 1 })
    chunks.push(patch)
  }
  return { text: chunks.join('\n'), files, additions: fileCount * 2, deletions: fileCount }
}

async function permissionAt(width, height) {
  const { input, output } = harness(width, height)
  const ui = new TerminalUI({ title: 'phase12f', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
  ui.enter()
  const pending = ui.requestPermission({
    tool: { name: 'bash', description: 'shell', risk: 'shell', schema: { type: 'object' } },
    args: { command: 'echo phase12f' },
  })
  await wait(15)
  return { ui, input, pending }
}

async function questionAt(width, height) {
  const { input, output } = harness(width, height)
  const ui = new TerminalUI({ title: 'phase12f', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
  ui.enter()
  const pending = ui.requestQuestion([{
    header: 'Choice',
    question: 'Which option should be used for the responsive test?',
    options: Array.from({ length: 8 }, (_, i) => ({ label: `option-${i}` })),
    multi: false,
    custom: false,
  }])
  await wait(15)
  return { ui, input, pending }
}

test('phase12F responsive matrix preserves exact frame geometry', async () => {
  for (const [width, height] of SIZES) {
    const { input, output } = harness(width, height)
    const ui = new TerminalUI({ title: 'phase12f', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
    try {
      ui.enter()
      ui.addUser(`USER ${'long transcript '.repeat(12)}`)
      ui.startAssistant()
      ui.appendAssistant('ASSISTANT '.repeat(80))
      ui.render()
      assertFrame(ui, width, height)
    } finally { ui.leave() }
  }
})

test('phase12F short splash falls back before the banner can consume the composer', () => {
  for (const [width, height] of [[40, 20], [48, 20], [56, 20]]) {
    const { input, output } = harness(width, height)
    const ui = new TerminalUI({ title: 'phase12f', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
    try {
      ui.enter()
      ui['startupUntil'] = Date.now() + 900
      ui.render()
      const frame = ui['previousFrame'].map(stripAnsi).join('\n')
      assertFrame(ui, width, height)
      assert.match(frame, />_ TermAgent v1\.18\.0/)
      assert.match(frame, /Build · mock provider/)
      assert.match(frame, /Ctrl\+P commands/)
      assert.match(frame, /Starting TermAgent/)
    } finally { ui.leave() }
  }
})

test('phase12F full splash remains available when 60x24 can afford the minimum body', () => {
  const { input, output } = harness(60, 24)
  const ui = new TerminalUI({ title: 'phase12f', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter()
    ui['startupUntil'] = Date.now() + 900
    ui.render()
    const frame = ui['previousFrame'].map(stripAnsi).join('\n')
    assertFrame(ui, 60, 24)
    assert.match(frame, /████/) 
    assert.match(frame, /Starting TermAgent/)
    assert.match(frame, /Build · mock provider/)
  } finally { ui.leave() }
})

test('phase12F wide composer renders its reserved tip row instead of clipping it', () => {
  for (const [width, height] of [[64, 24], [80, 24], [120, 30], [160, 40]]) {
    const { input, output } = harness(width, height)
    const ui = new TerminalUI({ title: 'phase12f', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
    try {
      ui.enter(); ui.addUser('tip test'); ui.render()
      const frame = ui['previousFrame'].map(stripAnsi).join('\n')
      assert.match(frame, /Tip: /)
      assertFrame(ui, width, height)
    } finally { ui.leave() }
  }
})

test('phase12F long picker labels/descriptions remain bounded at narrow and wide breakpoints', () => {
  for (const width of [40, 48, 56, 60, 80, 120, 160]) {
    const pickerWidth = Math.min(60, width - 4)
    const rows = renderPicker({
      options: [{
        label: '/a-command-name-that-is-far-too-long-for-humans',
        description: 'A description that is also absurdly long and should never force geometry to expand.',
      }, ...Array.from({ length: 20 }, (_, i) => ({ label: `/cmd-${i}`, description: 'long description '.repeat(8) }))],
      selectedIndex: 17,
      width: pickerWidth,
      maxVisible: 8,
      availableRows: 12,
      title: 'Command palette',
      footer: '↑↓ select · Enter run · Esc close',
      commandLayout: width < 56 ? 'stacked' : true,
      commandNameWidth: 24,
      commandDescriptionGap: 2,
      commandItemPaddingLeft: 3,
      commandItemPaddingRight: 3,
      theme: THEME,
      capability: 'plain',
    })
    for (const row of rows) assert.equal(widthOf(row), pickerWidth, `${width}: picker row overflow/underflow`)
  }
})

test('phase12F huge tool output stays capped by the inspector viewport', () => {
  const { input, output } = harness(80, 24)
  const ui = new TerminalUI({ title: 'tool', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter()
    ui.startTool('huge_output_tool', { payload: 'x'.repeat(50000) })
    ui.endTool('huge_output_tool', 'y'.repeat(100000))
    ui.openLatestToolDetails()
    ui.render()
    assertFrame(ui, 80, 24)
    const lines = ui['toolInspectorLines'](80, ui['inspector'])
    assert.ok(lines.some(line => stripAnsi(line).includes('output truncated')))
  } finally { ui.leave() }
})

test('phase12F long file paths stay bounded across inspector breakpoints', () => {
  const { input, output } = harness(80, 24)
  const ui = new TerminalUI({ title: 'long paths', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter()
    const longPath = `${'src/very-long-directory/'.repeat(12)}example-responsive-hardening-file.ts`
    const patch = `diff --git a/${longPath} b/${longPath}\n--- a/${longPath}\n+++ b/${longPath}\n@@ -1 +1 @@\n-old\n+new\n`
    ui.openWorkingTreeDiff({
      text: patch,
      files: [{ path: longPath, status: 'modified', additions: 1, deletions: 1 }],
      additions: 1,
      deletions: 1,
    }, 'Working tree changes')
    for (const [w, h] of [[80, 24], [48, 20], [40, 20], [160, 40]]) {
      output.columns = w; output.rows = h; output.emit('resize')
      ui.render()
      assertFrame(ui, w, h)
    }
  } finally { ui.leave() }
})

test('phase12F 100+ changed files remain navigable and bounded', async () => {
  const { input, output } = harness(80, 24)
  const ui = new TerminalUI({ title: 'many diffs', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter()
    ui.openWorkingTreeDiff(diffResult(120), 'Working tree changes')
    assert.equal(ui['inspector']?.files.length, 120)
    ui.render(); assertFrame(ui, 80, 24)
    output.columns = 40; output.rows = 20; output.emit('resize'); await wait(20)
    ui.render(); assertFrame(ui, 40, 20)
    input.emit('data', '\r'); await wait(10)
    assert.equal(ui['inspector']?.view, 'detail')
    ui.render(); assertFrame(ui, 40, 20)
  } finally { ui.leave() }
})

test('phase12F resize while picker, permission, question, and inspector are active keeps surfaces bounded', async () => {
  {
    const { input, output } = harness(80, 24)
    const ui = new TerminalUI({ title: 'picker', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
    try {
      ui.enter(); ui.setCompletion({ kind: 'palette', query: '', index: 40, items: Array.from({ length: 60 }, (_, i) => `/cmd-${i}`) })
      for (const [w, h] of [[80, 24], [40, 20], [120, 30]]) { output.columns = w; output.rows = h; output.emit('resize'); await wait(15); ui.render(); assertFrame(ui, w, h) }
      assert.equal(ui['promptFocused'], true)
    } finally { ui.leave() }
  }
  {
    const { ui, input, pending } = await permissionAt(80, 24)
    try {
      for (const [w, h] of [[80, 24], [48, 20], [40, 20], [100, 30]]) { ui['output'].columns = w; ui['output'].rows = h; ui['output'].emit('resize'); await wait(15); ui.render(); assertFrame(ui, w, h) }
      const before = ui['input'].value
      input.emit('data', 'x')
      assert.equal(ui['input'].value, before)
      input.emit('data', 'n')
      assert.equal(await pending, 'deny')
    } finally { ui.leave() }
  }
  {
    const { ui, input, pending } = await questionAt(80, 24)
    try {
      for (const [w, h] of [[80, 24], [56, 20], [40, 20], [120, 30]]) { ui['output'].columns = w; ui['output'].rows = h; ui['output'].emit('resize'); await wait(15); ui.render(); assertFrame(ui, w, h) }
      const before = ui['question'].selected
      const total = ui['questionOptions']().length
      input.emit('data', '\x1b[B'); await wait(5)
      assert.equal(ui['question'].selected, (before + 1) % total)
      input.emit('data', '\r')
      assert.deepEqual((await pending).answers, [['option-1']])
    } finally { ui.leave() }
  }
  {
    const { input, output } = harness(120, 30)
    const ui = new TerminalUI({ title: 'inspector', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
    try {
      ui.enter(); ui.openWorkingTreeDiff(diffResult(6));
      for (const [w, h] of [[120, 30], [64, 24], [40, 20], [160, 40]]) { output.columns = w; output.rows = h; output.emit('resize'); await wait(15); ui.render(); assertFrame(ui, w, h) }
      assert.equal(ui['promptFocused'], false)
      input.emit('data', '\x1b'); await wait(90)
      assert.equal(ui.isInspectorActive(), false)
      assert.equal(ui['promptFocused'], true)
    } finally { ui.leave() }
  }
})

test('phase12F active-turn inspector owns stdin and restores turn input on close', async () => {
  const { input, output } = harness(80, 24)
  const ui = new TerminalUI({ title: 'ownership', model: 'mock', provider: 'provider', mode: 'build', cwd: process.cwd(), output, input })
  const controller = new AbortController()
  try {
    ui.enter(); ui.startTool('tool', { command: 'echo hi' }); ui.endTool('tool', 'output'); ui.beginAgentTurn(controller); ui.openLatestToolDetails()
    assert.equal(input.listenerCount('data'), 1, 'inspector should replace turn handler')
    input.emit('data', 'j'); await wait(5)
    assert.equal(controller.signal.aborted, false)
    input.emit('data', '\x1b'); await wait(90)
    assert.equal(ui.isInspectorActive(), false)
    assert.equal(input.listenerCount('data'), 1, 'turn handler should be restored')
    input.emit('data', '\x03'); await wait(5)
    assert.equal(controller.signal.aborted, true)
  } finally {
    if (!controller.signal.aborted) controller.abort()
    ui.leave()
  }
})

test('phase12F deterministic visual snapshots stay byte-stable', async () => {
  const fs = await import('node:fs/promises')
  const { SNAPSHOTS, SNAPSHOT_ROOT, renderPhase12FSnapshot, snapshotName } = await import('../tools/phase12f-visual.mjs')
  for (const [scene, width, height] of SNAPSHOTS) {
    const expected = (await fs.readFile(`${SNAPSHOT_ROOT}/${snapshotName(scene, width, height)}`, 'utf8')).replace(/\n+$/, '')
    const actual = await renderPhase12FSnapshot(scene, width, height)
    assert.equal(actual, expected, `snapshot drift: ${scene} ${width}x${height}`)
  }
})
