import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve('experimental/ui-v2/dist/preview/design-system')
const ansi = await import(path.join(root, 'ansi.js'))
const theme = await import(path.join(root, 'theme.js'))
const layout = await import(path.join(root, 'layout.js'))
const banner = await import(path.join(root, 'banner.js'))
const activity = await import(path.join(root, 'activity.js'))
const footer = await import(path.join(root, 'footer.js'))

test('semantic themes expose consistent role tokens', () => {
  const oc = theme.getTheme('termagent')
  assert.equal(oc.background, '#000000')
  assert.equal(oc.text, '#ffffff')
  assert.equal(oc.accent, '#ff7a1a')
  assert.equal(oc.primary, '#b1b9f9')
  assert.equal(oc.secondary, '#af87ff')
  assert.equal(oc.selection, '#264f78')
  const expected = ['background','panel','surface','text','muted','border','borderActive','primary','secondary','accent','user','assistant','tool','reasoning','success','warning','error','info','selection','diffAdded','diffRemoved','markdownHeading','markdownLink','markdownCode']
  for (const [name, value] of Object.entries(theme.THEMES)) {
    assert.equal(value.name.length > 0, true, name)
    for (const token of expected) assert.match(value[token], /^#[0-9a-f]{6}$/i, `${name}.${token}`)
  }
})

test('ANSI capability detection remains terminal-aware', () => {
  assert.equal(ansi.detectColorCapability({ NO_COLOR: '1', TERM: 'xterm-256color' }), 'plain')
  assert.equal(ansi.detectColorCapability({ COLORTERM: 'truecolor', TERM: 'xterm-256color' }), 'truecolor')
  assert.equal(ansi.detectColorCapability({ TERM: 'xterm-256color' }), 'ansi256')
  assert.equal(ansi.detectColorCapability({ TERM: 'xterm' }), 'ansi16')
})

test('width-safe helpers ignore ANSI escape sequences', () => {
  const styled = ansi.paint('TermAgent', { fg: '#7c3aed', capability: 'truecolor' })
  assert.equal(ansi.widthOf(styled), 9)
  assert.equal(ansi.widthOf(ansi.clip(styled, 5)), 5)
  assert.equal(ansi.widthOf(ansi.padRight(styled, 14)), 14)
  assert.equal(ansi.background('', 'truecolor'), '')
  assert.equal(ansi.foreground('', 'truecolor'), '')
  assert.equal(ansi.paint('plain', { fg: '#fff', attrs: { bold: true }, capability: 'plain' }), 'plain')
})

test('layout primitives never emit rows wider than the target width', () => {
  const t = theme.getTheme('termagent')
  const width = 40
  const rows = layout.panel(['A deliberately long design-system row that must clip safely'], { width, theme:t, capability:'truecolor', title:'Prompt' })
  for (const row of rows) assert.ok(ansi.widthOf(row) <= width)
  assert.equal(ansi.widthOf(layout.selectedRow('A very long picker option that is clipped', width, true, t, 'truecolor')), width)
})

test('TermAgent banner has a narrow fallback', () => {
  const t = theme.getTheme()
  assert.ok(banner.bannerWidth('1.18.0') > 38)
  const wide = banner.renderBanner({ width: 80, version:'1.18.0', theme:t, capability:'truecolor' })
  const narrow = banner.renderBanner({ width: 30, version:'1.18.0', theme:t, capability:'truecolor' })
  assert.match(ansi.stripAnsi(wide.join('\n')), /████████╗/)
  assert.match(ansi.stripAnsi(wide.join('\n')), /╚══██╔══╝/)
  assert.match(ansi.stripAnsi(wide.join('\n')), /✦ Open terminal for any LLM ✦/)
  assert.match(ansi.stripAnsi(narrow.join('\n')), /TermAgent/)
  for (const row of [...wide, ...narrow]) assert.ok(ansi.widthOf(row) <= 80)
  assert.equal(ansi.widthOf(narrow[0]), 30)
  assert.doesNotMatch(ansi.stripAnsi(wide.join('\n')), /☺|🙂|😊|😀/)
})

test('activity and footer render semantic state without raw Markdown-like decoration', () => {
  const t = theme.getTheme()
  const row = activity.renderActivity({ width:60, phase:'writing', label:'Writing response', elapsedSeconds:3, frame:4, theme:t, capability:'truecolor' })
  assert.match(ansi.stripAnsi(row), /Writing response · 3s/)
  assert.equal(ansi.widthOf(row), 60)
  const footerRows = footer.renderFooter({ width:60, cwd:'/data/data/com.termux/files/home/TermAgent', context:'prompt', theme:t, capability:'truecolor' })
  assert.equal(footerRows.length, 2)
  for (const footerRow of footerRows) assert.ok(ansi.widthOf(footerRow) <= 60)
})
