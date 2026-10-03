import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TerminalUI } from '../dist/cli/ui.js'
import { stripAnsi, widthOf } from '../dist/design-system/ansi.js'

function wait(ms = 30) { return new Promise(resolve => setTimeout(resolve, ms)) }

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

test('phase12D permission dock preserves transcript and prompt while blocking prompt input', async () => {
  const { input, output } = harness(96, 30)
  const ui = new TerminalUI({ title: 'd', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter()
    ui.addUser('transcript remains visible during approval')
    ui.startAssistant()
    const pending = ui.requestPermission({
      tool: { name: 'bash', description: 'shell', risk: 'shell', schema: { type: 'object' } },
      args: { command: 'echo protected' },
    })
    await wait()
    const combined = output.writes.join('')
    assert.match(stripAnsi(combined), /transcript remains visible during approval/)
    assert.match(stripAnsi(combined), /Permission required/)
    assert.match(stripAnsi(combined), /Allow once/)
    assert.match(stripAnsi(combined), /esc interrupt/)
    input.emit('data', 'x')
    await wait(5)
    assert.equal(ui['input'].value, '')
    input.emit('data', 'n')
    assert.equal(await pending, 'deny')
    assert.equal(ui.isPermissionActive(), false)
  } finally {
    ui.leave()
  }
})

test('phase12D permission dock remains width-safe and bounded during resize', async () => {
  const { input, output } = harness(100, 30)
  const ui = new TerminalUI({ title: 'd', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter(); ui.startAssistant()
    const pending = ui.requestPermission({
      tool: { name: 'bash', description: 'shell', risk: 'shell', schema: { type: 'object' } },
      args: { command: 'printf very-long-command' },
    })
    await wait()
    for (const width of [100, 80, 64, 56, 48, 40]) {
      output.columns = width
      const rows = ui['permissionBox'](width)
      assert.ok(rows.length <= 14, `permission dock became too tall at ${width}: ${rows.length}`)
      for (const row of rows) assert.ok(widthOf(stripAnsi(row)) <= width, `permission row overflowed ${width}: ${row}`)
      ui.render()
    }
    input.emit('data', 'n')
    assert.equal(await pending, 'deny')
  } finally {
    ui.leave()
  }
})

test('phase12D question dock preserves transcript, bounds visible options, and owns navigation', async () => {
  const { input, output } = harness(96, 30)
  const ui = new TerminalUI({ title: 'd', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter()
    ui.addUser('question transcript stays visible')
    ui.startAssistant()
    const pending = ui.requestQuestion([{
      header: 'Decision',
      question: 'Choose a compact option',
      options: [
        { label: 'one' }, { label: 'two' }, { label: 'three' }, { label: 'four' }, { label: 'five' },
      ],
      multi: false,
      custom: true,
    }])
    await wait()
    const rows = ui['questionBox'](96)
    assert.ok(rows.length <= 12, `question dock became too tall: ${rows.length}`)
    assert.match(stripAnsi(rows.join('\n')), /1\. one/)
    assert.match(stripAnsi(rows.join('\n')), /4\. four/)
    assert.match(stripAnsi(rows.join('\n')), /showing 1-4 of 6/)
    assert.match(stripAnsi(output.writes.join('')), /question transcript stays visible/)
    input.emit('data', '\x1b[B')
    await wait(5)
    assert.equal(ui['question'].selected, 1)
    input.emit('data', '\r')
    assert.deepEqual((await pending).answers, [['two']])
    assert.equal(ui.isQuestionActive(), false)
  } finally {
    ui.leave()
  }
})

test('phase12D custom question editing remains local to the dock', async () => {
  const { input, output } = harness(80, 26)
  const ui = new TerminalUI({ title: 'd', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter(); ui.startAssistant(); ui.setInput('draft must survive')
    const pending = ui.requestQuestion([{ header: 'Name', question: 'Name?', options: [], multi: false, custom: true }])
    await wait()
    input.emit('data', 'TermAgent')
    input.emit('data', '\r')
    assert.deepEqual((await pending).answers, [['TermAgent']])
    assert.equal(ui['input'].value, 'draft must survive')
  } finally {
    ui.leave()
  }
})
test('phase12D docks preserve the composer on compact 80x20 and 48x20 terminals', async () => {
  for (const [width, height] of [[80, 20], [48, 20]]) {
    const { input, output } = harness(width, height)
    const ui = new TerminalUI({ title: 'd', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
    try {
      ui.enter(); ui.startAssistant()
      const permission = ui.requestPermission({
        tool: { name: 'bash', description: 'shell', risk: 'shell', schema: { type: 'object' } },
        args: { command: 'echo protected' },
      })
      await wait()
      const plain = stripAnsi(output.writes.join(''))
      assert.match(plain, /Permission required/)
      assert.match(plain, /Build · mock OpenAI Compatible/)
      assert.ok(ui['permissionBox'](width).length <= 10)
      input.emit('data', 'n')
      assert.equal(await permission, 'deny')

      const question = ui.requestQuestion([{
        header: 'Compact', question: 'Choose', options: [{ label: 'one' }, { label: 'two' }, { label: 'three' }, { label: 'four' }], multi: false, custom: false,
      }])
      await wait()
      const questionPlain = stripAnsi(output.writes.join(''))
      assert.match(questionPlain, /Question/)
      assert.match(questionPlain, /Build · mock OpenAI Compatible/)
      assert.ok(ui['questionBox'](width).length <= 10)
      input.emit('data', '\r')
      assert.deepEqual((await question).answers, [['one']])
    } finally {
      ui.leave()
    }
  }
})

test('phase12D write permission retains the shared diff preview inside the compact dock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-phase12d-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/example.ts'), 'export const value = 1\n', 'utf8')
  const { input, output } = harness(100, 32)
  const ui = new TerminalUI({ title: 'd', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: root, output, input })
  try {
    ui.enter(); ui.startAssistant()
    const pending = ui.requestPermission({
      tool: { name: 'edit_file', description: 'edit', risk: 'write', schema: { type: 'object' } },
      args: { path: 'src/example.ts', oldText: 'value = 1', newText: 'value = 2' },
    })
    await wait(100)
    const plain = stripAnsi(output.writes.join(''))
    assert.match(plain, /Permission required/)
    assert.match(plain, /changes/)
    assert.match(plain, /src\/example\.ts/)
    assert.match(plain, /- export const value = 1/)
    assert.match(plain, /\+ export const value = 2/)
    input.emit('data', 'n')
    assert.equal(await pending, 'deny')
  } finally {
    ui.leave()
    await fs.rm(root, { recursive: true, force: true })
  }
})
