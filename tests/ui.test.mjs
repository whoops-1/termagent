import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TerminalUI } from '../dist/cli/ui.js'
import { stripAnsi } from '../dist/design-system/ansi.js'

function wait(ms = 20) { return new Promise(r => setTimeout(r, ms)) }

function captureOutput(columns = 80, rows = 24) {
  const writes = []
  const output = { columns, rows, write(chunk) { writes.push(String(chunk)); return true }, on() {}, off() {} }
  return { writes, output }
}
test('interactive renderer redraws absolute rows without newline drift', async () => {
  const { writes, output } = captureOutput()
  const ui = new TerminalUI({ title: 'demo', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    await wait()
    ui.setInput('first line that is deliberately long enough to wrap and a second line')
    await wait()
    ui.setInput('first line that is deliberately long enough to wrap and a second line\nactual second line')
    await wait()
    ui.addUser('typed prompt')
    await wait()
    const frames = writes.filter(x => x.includes('\x1b[1;1H'))
    assert.ok(frames.length >= 1)
    const renderedWrites = writes.filter(x => /\x1b\[\d+;1H/.test(x))
    assert.ok(renderedWrites.length >= 4)
    assert.ok(renderedWrites.some(x => /\x1b\[2;1H/.test(x)), 'at least one changed row should be addressed absolutely')
    for (const frame of renderedWrites) assert.equal(frame.includes('\n'), false, 'a frame must not rely on LF to advance terminal rows')
    assert.match(frames[0], /\x1b\[1;1H/)
    assert.match(frames[0], /\x1b\[2;1H/)
  } finally {
    ui.leave()
  }
})

test('submitted prompt state can be cleared without leaving stale editor text', async () => {
  const { writes, output } = captureOutput()
  const ui = new TerminalUI({ title: 'clear', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    await wait()
    ui.setInput('stale prompt')
    await wait()
    ui.setInput('')
    await wait()
    const last = writes.at(-1) || ''
    assert.equal(last.includes('stale prompt'), false)
  } finally {
    ui.leave()
  }
})

test('interactive prompt cursor is declaratively rendered inside the composer', async () => {
  const { writes, output } = captureOutput()
  const ui = new TerminalUI({ title: 'cursor', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    await wait()
    ui.setInput('hello\nworld')
    await wait()
    const frame = writes.at(-1) || ''
    assert.match(frame, /\x1b\[7m/)
    assert.match(frame, /\x1b\[\d+;1H/)
    assert.equal(frame.includes('\x1b[?25h'), false, 'hardware cursor must stay hidden during the frame')
  } finally {
    ui.leave()
  }
})
test('permission prompt owns stdin and resolves once/always/deny without leaking to the editor', async () => {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const { writes, output: baseOutput } = captureOutput()
  const output = new EventEmitter()
  output.columns = baseOutput.columns
  output.rows = baseOutput.rows
  output.write = baseOutput.write
  const ui = new TerminalUI({ title: 'permission', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
  const tool = { name: 'bash', description: 'shell', risk: 'shell', schema: { type: 'object' } }
  try {
    ui.enter()
    const pending = ui.requestPermission({ tool, args: { command: 'echo hi' } })
    await wait()
    assert.ok(writes.some(x => x.includes('Permission required')))
    input.emit('data', 'a')
    assert.equal(await pending, 'always')
    assert.equal(ui.isPermissionActive(), false)
  } finally {
    ui.leave()
  }
})
test('interactive question prompt owns stdin and returns selected and custom answers', async () => {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const { writes, output: baseOutput } = captureOutput(90, 28)
  const output = new EventEmitter()
  output.columns = baseOutput.columns
  output.rows = baseOutput.rows
  output.write = baseOutput.write
  const ui = new TerminalUI({ title:'question', model:'mock', provider:'openai-compatible', mode:'build', cwd:process.cwd(), output, input })
  try {
    ui.enter()
    const pending = ui.requestQuestion([{ header:'Color', question:'Pick a color', options:[{label:'blue',description:'Blue'},{label:'green',description:'Green'}], multi:false, custom:false }])
    await wait()
    assert.ok(writes.some(x => x.includes('Question')))
    input.emit('data', '2')
    input.emit('data', '\r')
    assert.deepEqual((await pending).answers, [['green']])
    assert.equal(ui.isQuestionActive(), false)

    const customPending = ui.requestQuestion([{ header:'Name', question:'Your name', options:[], multi:false, custom:true }])
    await wait()
    input.emit('data', 'T')
    input.emit('data', 'e')
    input.emit('data', 'r')
    input.emit('data', 'm')
    input.emit('data', 'A')
    input.emit('data', 'g')
    input.emit('data', 'e')
    input.emit('data', 'n')
    input.emit('data', 't')
    input.emit('data', '\r')
    assert.deepEqual((await customPending).answers, [['TermAgent']])
  } finally { ui.leave() }
})

test('permission selection model matches established style focus and submit semantics', async () => {
  const { SelectModel } = await import('../dist/cli/tui/select.js')
  const select = new SelectModel([
    { value: 'once', label: 'Allow once', key: '1' },
    { value: 'always', label: 'Always allow', key: '2' },
    { value: 'deny', label: 'Reject', key: '3' },
  ])
  assert.equal(select.selected.value, 'once')
  assert.equal(select.handleKey('down')?.value, 'always')
  assert.equal(select.selected.value, 'always')
  assert.equal(select.handleKey('enter')?.type, 'submit')
  assert.equal(select.handleKey('1')?.value, 'once')
  assert.equal(select.selected.value, 'once')
  assert.equal(select.handleKey('escape')?.type, 'cancel')
})
test('streamed assistant text materializes a visible assistant conversation entry', async () => {
  const { writes, output } = captureOutput()
  const ui = new TerminalUI({ title: 'assistant', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    await wait()
    ui.addUser('hello')
    await wait()
    ui.startAssistant()
    ui.appendAssistant('response text')
    await wait()
    const frame = writes.at(-1) || ''
    assert.match(frame, /response text/)
  } finally {
    ui.leave()
  }
})

test('conversation viewport scrolls older and newer rows independently from the prompt', async () => {
  const { writes, output } = captureOutput(80, 20)
  const ui = new TerminalUI({ title: 'scroll', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    await wait()
    for (let i = 1; i <= 16; i++) ui.addUser(`message-${i}`)
    await wait()
    const before = writes.at(-1) || ''
    ui.scroll(5)
    await wait()
    const older = writes.at(-1) || ''
    ui.scroll(-5)
    await wait()
    const newer = writes.at(-1) || ''
    assert.match(before, /message-16/)
    assert.match(older, /message-11|message-10/)
    assert.match(newer, /message-16/)
  } finally {
    ui.leave()
  }
})
test('command picker keeps global selection while rendering an eight-row window', async () => {
  const { writes, output } = captureOutput(72, 24)
  const ui = new TerminalUI({ title: 'picker', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  const items = Array.from({ length: 12 }, (_, i) => `/command-${String(i + 1).padStart(2, '0')}`)
  try {
    ui.enter()
    await wait()
    ui.setCompletion({ kind: 'command', items, index: 0, query: '' })
    await wait()
    let frame = writes.at(-1) || ''
    assert.match(frame, /\/command-01/)
    assert.match(frame, /\/command-08/)
    assert.doesNotMatch(frame, /\/command-09/)

    ui.setCompletion({ kind: 'command', items, index: 9, query: '' })
    await wait()
    frame = writes.at(-1) || ''
    assert.match(frame, /\/command-10/)
    assert.match(frame, /9-12 of 12|3-10 of 12|4-11 of 12|5-12 of 12/)
    assert.doesNotMatch(frame, /\/command-01/)
  } finally {
    ui.leave()
  }
})
test('command picker reserves its metadata row on narrow terminals', async () => {
  const { writes, output } = captureOutput(60, 20)
  const ui = new TerminalUI({ title: 'narrow', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  const items = Array.from({ length: 12 }, (_, i) => `/cmd-${i + 1}`)
  try {
    ui.enter()
    await wait()
    ui.setCompletion({ kind: 'command', items, index: 9, query: '' })
    await wait()
    const frame = writes.at(-1) || ''
    assert.match(frame, /9-12 of 12|3-10 of 12|4-11 of 12|5-12 of 12/)
    assert.match(frame, /\x1b\[16;1H/)
    assert.match(frame, /\x1b\[19;1H/)
  } finally {
    ui.leave()
  }
})

test('active agent does not interpret a split SGR mouse click as Escape', async () => {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const { output: baseOutput } = captureOutput(80, 24)
  const output = new EventEmitter()
  output.columns = baseOutput.columns
  output.rows = baseOutput.rows
  output.write = baseOutput.write
  const ui = new TerminalUI({ title: 'mouse', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
  const controller = new AbortController()
  try {
    ui.enter()
    ui.startAssistant()
    ui.beginAgentTurn(controller)
    input.emit('data', '\x1b')
    await wait(40)
    input.emit('data', '[<0;12;8M')
    await wait()
    assert.equal(controller.signal.aborted, false)
    input.emit('data', '\x1b[<0;12;8m')
    await wait()
    assert.equal(controller.signal.aborted, false)
  } finally {
    ui.leave()
  }
})

test('active agent ignores mouse clicks but handles wheel scrolling and Ctrl+E reasoning toggle', async () => {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const { writes, output: baseOutput } = captureOutput(80, 24)
  const output = new EventEmitter()
  output.columns = baseOutput.columns
  output.rows = baseOutput.rows
  output.write = baseOutput.write
  const ui = new TerminalUI({ title: 'turn', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
  const controller = new AbortController()
  try {
    ui.enter()
    ui.addUser('hello')
    ui.startAssistant()
    ui.beginAgentTurn(controller)
    ui.appendReasoning('first reasoning block')
    const before = writes.length
    input.emit('data', '\x1b[<0;12;8M')
    await wait()
    assert.equal(controller.signal.aborted, false, 'mouse click must not interrupt the turn')
    input.emit('data', '\x1b[<64;12;8M')
    await wait()
    assert.equal(controller.signal.aborted, false, 'mouse wheel must not interrupt the turn')
    input.emit('data', '\x05')
    await wait()
    assert.ok(writes.length > before, 'Ctrl+E should redraw the reasoning panel')
    input.emit('data', '\x03')
    await wait()
    assert.equal(controller.signal.aborted, true)
  } finally {
    ui.leave()
  }
})

test('reasoning is compact in chat and opens a dedicated inspector', async () => {
  const { writes, output } = captureOutput(80, 24)
  const ui = new TerminalUI({ title: 'reasoning', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    await wait()
    ui.startAssistant()
    ui.appendReasoning('step one: inspect files')
    await wait()
    const all = writes.join('')
    assert.match(all, /Reasoning/)
    assert.doesNotMatch(all, /step one: inspect files/)
    ui.toggleThinking()
    await wait()
    assert.equal(ui.isThinkingVisible(), true)
    const opened = writes.join('')
    assert.match(opened, /◆ Reasoning/)
    assert.match(opened, /step one: inspect files/)
    assert.match(opened, /Esc close/)
    ui.toggleThinking()
    await wait()
    assert.equal(ui.isThinkingVisible(), false)
  } finally {
    ui.leave()
  }
})

test('write/edit tool results render the shared diff inline and reuse it in the inspector', async () => {
  const { writes, output } = captureOutput(90, 28)
  const ui = new TerminalUI({ title:'diff', model:'mock', provider:'openai-compatible', mode:'build', cwd:process.cwd(), output })
  try {
    ui.enter()
    ui.startTool('edit_file', { path:'src/example.ts', oldText:'value = 1', newText:'value = 2' })
    ui.endTool('edit_file', 'edited 1 occurrence(s)', {
      diff:'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export const value = 1\n+export const value = 2',
      fileDiff:{path:'src/example.ts', additions:1, deletions:1}
    })
    await wait(50)
    const main = stripAnsi(writes.join(''))
    assert.match(main, /edit_file/)
    assert.match(main, /src\/example\.ts/)
    assert.match(main, /\+1/)
    assert.match(main, /-1/)
    assert.match(main, /-.*export const value = 1/)
    assert.match(main, /\+.*export const value = 2/)
    ui.openLatestToolDetails()
    await wait()
    const details = writes.join('')
    assert.match(details, /◆ Tool details/)
    assert.match(details, /edited 1 occurrence/)
    assert.match(details, /Press d to open the diff inspector/)
    assert.equal(ui.areToolDetailsVisible(), true)
    ui['onInspectorData']?.('d')
    await wait()
    assert.equal(ui.isInspectorActive(), true)
    ui['onInspectorData']?.('\r')
    await wait()
    const diff = writes.join('')
    assert.match(diff, /◆ Changes · edit_file/)
    assert.match(diff, /src\/example\.ts/)
    assert.match(diff, /export const value = 2/)
  } finally {
    ui.leave()
  }
})

test('working tree diff opens as a file list and then a file detail view', async () => {
  const { writes, output } = captureOutput(90, 28)
  const ui = new TerminalUI({ title:'working-tree', model:'mock', provider:'openai-compatible', mode:'build', cwd:process.cwd(), output })
  try {
    ui.enter()
    ui.openWorkingTreeDiff({
      text:'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      files:[{path:'src/a.ts', additions:1, deletions:1}], additions:1, deletions:1
    }, 'Working tree')
    await wait()
    assert.match(writes.join(''), /◆ Working tree/)
    assert.match(writes.join(''), /src\/a\.ts/)
    assert.match(writes.join(''), /Enter open/)
    ui['onInspectorData']?.('\x1b[B')
    await wait()
    assert.equal(ui['inspector']?.selected, 0)
    ui['onInspectorData']?.('\r')
    await wait()
    assert.match(writes.join(''), /src\/a\.ts/)
    assert.match(writes.join(''), /- old/)
    assert.match(writes.join(''), /\+ new/)
  } finally {
    ui.leave()
  }
})

test('write/edit permission prompt previews the proposed diff before approval', async () => {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const os = await import('node:os')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-ui-perm-diff-'))
  await fs.mkdir(path.join(root, 'src'), { recursive:true })
  await fs.writeFile(path.join(root, 'src/example.ts'), 'export const value = 1\n', 'utf8')
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const { writes, output: baseOutput } = captureOutput(100, 32)
  const output = new EventEmitter()
  output.columns = baseOutput.columns
  output.rows = baseOutput.rows
  output.write = baseOutput.write
  const ui = new TerminalUI({ title:'permission-diff', model:'mock', provider:'openai-compatible', mode:'build', cwd:root, output, input })
  const tool = { name:'edit_file', description:'edit', risk:'write', schema:{type:'object'} }
  try {
    ui.enter()
    const pending = ui.requestPermission({ tool, args:{ path:'src/example.ts', oldText:'value = 1', newText:'value = 2' } })
    await wait(120)
    const frame = stripAnsi(writes.join(''))
    assert.match(frame, /changes/)
    assert.match(frame, /- export const value = 1/)
    assert.match(frame, /\+ export const value = 2/)
    input.emit('data', 'n')
    assert.equal(await pending, 'deny')
  } finally {
    ui.leave()
    await fs.rm(root, { recursive:true, force:true })
  }
})
test('todo panel keeps completion count while only rendering active todo items in the main chat', async()=>{
  const { writes, output } = captureOutput(80, 24)
  const ui = new TerminalUI({ title:'todo', model:'mock', provider:'openai-compatible', mode:'build', cwd:process.cwd(), output })
  try {
    ui.enter()
    ui.setTodos([
      {id:'1',task:'Create file',status:'done'},
      {id:'2',task:'Run verification',status:'in_progress'},
      {id:'3',task:'Return response',status:'pending'},
    ])
    await wait()
    const frame=writes.at(-1)||''
    assert.match(frame,/Todo 1\/3/)
    assert.doesNotMatch(stripAnsi(frame),/Create file/)
    assert.doesNotMatch(stripAnsi(frame),/\[x\]/)
    assert.match(frame,/\[>\]/)
    assert.match(frame,/Run verification/)
    assert.match(frame,/\[ \]/)
    assert.match(frame,/Return response/)
  } finally { ui.leave() }
})
test('todo panel disappears when every todo is complete', async()=>{
  const { writes, output } = captureOutput(80, 24)
  const ui = new TerminalUI({ title:'todo-complete', model:'mock', provider:'openai-compatible', mode:'build', cwd:process.cwd(), output })
  try {
    ui.enter()
    ui.setTodos([
      {id:'1',task:'Create file',status:'done'},
      {id:'2',task:'Run verification',status:'done'},
      {id:'3',task:'Return response',status:'done'},
    ])
    await wait()
    const frame=writes.at(-1)||''
    assert.doesNotMatch(frame,/Todo 3\/3/)
    assert.doesNotMatch(frame,/Create file/)
    assert.doesNotMatch(frame,/Run verification/)
  } finally { ui.leave() }
})

test('prompt input is ignored while an agent turn is active', async()=>{
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const { writes, output: baseOutput } = captureOutput(80, 24)
  const output = new EventEmitter()
  output.columns = baseOutput.columns
  output.rows = baseOutput.rows
  output.write = baseOutput.write
  const ui = new TerminalUI({ title:'input-lock', model:'mock', provider:'openai-compatible', mode:'build', cwd:process.cwd(), output, input })
  const controller = new AbortController()
  try {
    ui.enter(); ui.startAssistant(); ui.beginAgentTurn(controller)
    input.emit('data','this must be ignored')
    await wait()
    const frame=writes.at(-1)||''
    assert.doesNotMatch(frame,/this must be ignored/)
    assert.equal(controller.signal.aborted,false)
    input.emit('data','\x03')
    await wait()
    assert.equal(controller.signal.aborted,true)
  } finally { ui.leave() }
})
