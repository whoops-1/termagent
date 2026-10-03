import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { TerminalUI } from '../../dist/cli/ui.js'
import { THEMES } from '../../dist/design-system/theme.js'
import { bannerWidth, renderBanner } from '../../dist/design-system/banner.js'
import { renderPicker, pickerWindow } from '../../dist/design-system/picker.js'
import { renderDialogFrame } from '../../dist/design-system/surfaces.js'
import { renderUserTurn, renderAssistantTurn, renderToolActivity, renderSystemRow } from '../../dist/design-system/transcript.js'
import { widthOf } from '../../dist/design-system/ansi.js'

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]/g
const strip = s => String(s).replace(ANSI, '')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const requiredThemeKeys = [
  'background','panel','surface','text','muted','subtle','border','borderActive','primary','secondary','accent',
  'user','assistant','tool','reasoning','success','warning','error','info','selection',
  'diffAdded','diffRemoved','diffContext','markdownHeading','markdownLink','markdownCode','markdownQuote',
  'syntaxComment','syntaxKeyword','syntaxFunction','syntaxVariable','syntaxString','syntaxNumber','syntaxType','syntaxOperator','syntaxPunctuation',
]

function fakeOutput(columns, rows) {
  const writes = []
  const output = new EventEmitter()
  output.columns = columns
  output.rows = rows
  output.write = chunk => { writes.push(String(chunk)); return true }
  return { output, writes }
}

function assertRowsFit(rows, width, label='rows') {
  assert.ok(Array.isArray(rows), `${label} must be an array`)
  for (const row of rows) {
    const plain = strip(row)
    assert.ok(!plain.includes('\n') && !plain.includes('\r'), `${label} must contain terminal rows, not embedded newlines`)
    assert.ok(widthOf(plain) <= width, `${label} overflowed width ${width}: ${plain}`)
  }
}

test('merged design system exposes a complete semantic token set', () => {
  assert.ok(Object.keys(THEMES).length >= 3)
  for (const [name, theme] of Object.entries(THEMES)) {
    assert.equal(typeof theme.name, 'string', `${name} needs a display name`)
    for (const key of requiredThemeKeys) assert.equal(typeof theme[key], 'string', `${name}.${key} missing`)
  }
})

test('banner is width-safe across terminal sizes and color capabilities', () => {
  assert.ok(bannerWidth('1.18.0') > 38)
  for (const width of [24, 25, 30, 31, 38, 39, 46, 47, 52, 53, 60, 64, 72, 80, 100, 120, 160]) {
    for (const capability of ['none','ansi16','ansi256','truecolor']) {
      const rows = renderBanner({ width, version:'1.18.0', theme:THEMES.termagent, capability })
      assertRowsFit(rows, width, `banner ${width}/${capability}`)
      assert.ok(rows.length >= 1 && rows.length <= 14)
      assert.doesNotMatch(strip(rows.join('\n')), /rainbow|🙂|😊|😄/i)
    }
  }
})

test('picker keeps the global selection index inside its visible window', () => {
  for (const total of [0,1,2,6,7,8,9,12,25,50]) {
    const items = Array.from({ length: total }, (_, i) => ({ label: `item-${i+1}`, value: String(i+1) }))
    for (const maxVisible of [1,2,6,8,12]) {
      for (let selected = -2; selected <= total + 2; selected++) {
        const win = pickerWindow(total, selected, maxVisible)
        assert.ok(win.start >= 0)
        assert.ok(win.end >= win.start)
        assert.ok(win.end <= total || total === 0)
        assert.ok(win.end - win.start <= Math.max(1, maxVisible))
        if (total > 0) {
          const clamped = Math.max(0, Math.min(selected, total - 1))
          assert.ok(clamped >= win.start && clamped < win.end)
        }
      }
    }
  }
  for (const width of [24, 40, 48, 60, 72, 80]) {
    for (const selected of [0,7,8,11]) {
      const rows = renderPicker({
        width,
        selectedIndex:selected,
        maxVisible:8,
        options:Array.from({ length:12 }, (_, i) => ({ label:`/command-${String(i+1).padStart(2,'0')}` })),
        title:'Commands',
        query:'',
        footer:'Enter select · Esc close',
        theme:THEMES.termagent,
        capability:'ansi16',
      })
      assertRowsFit(rows, width, `picker ${width}/${selected}`)
      assert.ok(rows.length <= 14)
      const plain = strip(rows.join('\n'))
      assert.match(plain, /Commands/)
      if (width >= 40) {
        assert.match(plain, selected === 0 ? /command-01/ : selected === 7 ? /command-08|command-09/ : selected === 8 ? /command-09|command-10/ : /command-10|command-11|command-12/)
      }
    }
  }
})

test('dialog, transcript, and tool rows never exceed their requested width', () => {
  for (const width of [28, 32, 40, 60, 80]) {
    const theme = THEMES.termagent
    const dialog = renderDialogFrame({
      width, height:18, title:'Permission required', subtitle:'The agent is waiting for approval.',
      content:['Run a very long shell command with unicode ✓ 漢字 that must remain clipped safely.'],
      footer:'↑↓ select · Enter confirm · Esc reject', theme, capability:'ansi256', tone:'warning', maxWidth:78,
    })
    assert.equal(dialog.length, 18)
    assertRowsFit(dialog, width, `dialog ${width}`)

    for (const rows of [
      renderUserTurn({ text:'A very long user message with **Markdown** and unicode ✓ 漢字 '.repeat(4), width, theme, capability:'truecolor' }),
      renderAssistantTurn({ text:'# Answer\n\nA long response '.repeat(4), reasoning:'internal reasoning '.repeat(20), width, theme, capability:'truecolor' }),
      renderToolActivity({ tool:{ name:'write_file', summary:'src/very-long-file-name-that-needs-clipping.ts', running:false, durationMs:12345, additions:999, deletions:888, hasDiff:true }, width, theme, capability:'truecolor' }),
      renderSystemRow({ system:{ text:'Warning '.repeat(20), tone:'warn' }, width, theme, capability:'ansi16' }),
    ]) assertRowsFit(rows, width, `transcript ${width}`)
  }
})

test('TerminalUI shows the full splash only for a fresh session, then collapses to a compact header', async () => {
  const { output, writes } = fakeOutput(80, 24)
  const ui = new TerminalUI({ title:'demo', model:'mock', provider:'openai-compatible', mode:'build', cwd:process.cwd(), output })
  try {
    ui.enter()
    await sleep(25)
    const splash = writes.join('')
    assert.match(strip(splash), /TERMAGENT/i)
    assert.match(strip(splash), /Open terminal for any LLM/i)
    ui.addUser('hello')
    await sleep(25)
    const latest = writes.at(-1) || ''
    assert.match(strip(latest), /TermAgent/)
    assert.doesNotMatch(strip(latest), /AI AGENT FOR YOUR TERMINAL/)
  } finally {
    ui.leave()
  }
})

test('TerminalUI command picker keeps a global viewport with eight visible choices when the terminal allows', async () => {
  for (const [width, expectedFirst, expectedLast] of [[72,'/command-01','/command-08'], [56,'/command-01','/command-08']]) {
    const { output, writes } = fakeOutput(width, 24)
    const ui = new TerminalUI({ title:'picker', model:'mock', provider:'openai-compatible', mode:'build', cwd:process.cwd(), output })
    try {
      ui.enter()
      await sleep(10)
      ui.setCompletion({ kind:'command', items:Array.from({ length:12 }, (_, i) => `/command-${String(i+1).padStart(2,'0')}`), index:0, query:'' })
      await sleep(30)
      const frame = strip(writes.at(-1) || '')
      assert.match(frame, new RegExp(expectedFirst.replace('/', '\\/')))
      assert.match(frame, new RegExp(expectedLast.replace('/', '\\/')))
      assert.doesNotMatch(frame, new RegExp('/command-09'))
    } finally {
      ui.leave()
    }
  }
})

test('TerminalUI survives rapid state churn without losing input focus or emitting malformed rows', async () => {
  const { output, writes } = fakeOutput(100, 32)
  const ui = new TerminalUI({ title:'churn', model:'mock', provider:'openai-compatible', mode:'build', cwd:process.cwd(), output })
  try {
    ui.enter()
    for (let i = 0; i < 20; i++) {
      ui.setInput(`draft-${i} ✓ 漢字`)
      ui.setTheme(i % 2 ? 'forge' : 'termagent')
      ui.addUser(`message-${i}`)
      ui.startAssistant()
      ui.appendAssistant(`response-${i}`)
      ui.appendReasoning(`reason-${i}`)
      ui.startTool('bash', { command:`echo ${i}` })
      ui.endTool('bash', 'done')
      ui.setInput('')
    }
    await sleep(80)
    for (const write of writes.filter(x => /\x1b\[\d+;1H/.test(x))) {
      assert.equal(write.includes('\n'), false)
      assert.equal(write.includes('\r'), false)
    }
    assert.equal(ui.getThemeName(), 'Forge')
  } finally {
    ui.leave()
  }
})

// Timing/lifecycle regression: repeated enter/leave must not leave activity or render timers alive.
test('TerminalUI enter/leave is idempotent under repeated lifecycle cycles', async () => {
  const { output } = fakeOutput(80, 24)
  const ui = new TerminalUI({ title:'lifecycle', model:'m', provider:'p', mode:'build', cwd:process.cwd(), output })
  for (let i = 0; i < 15; i++) {
    ui.enter()
    ui.enter()
    ui.startAssistant()
    ui.beginAgentTurn(new AbortController())
    ui.endAgentTurn()
    ui.leave()
    ui.leave()
  }
  await sleep(50)
})
