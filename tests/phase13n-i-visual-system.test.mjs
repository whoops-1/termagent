import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import { THEMES, listThemes, loadThemeCatalog } from '../dist/design-system/theme.js'
import { stripAnsi, widthOf } from '../dist/design-system/ansi.js'
import { BANNER_STYLES, renderBanner, renderBannerStyleRows as __BANNER_STYLE_ROWS } from '../dist/design-system/banner.js'
import { BANNER_EFFECTS, renderEffectPickerRows, applyBannerEffect } from '../dist/design-system/effects.js'
import { buildExplorationHUDModel, renderExplorationHUD } from '../dist/design-system/exploration-hud.js'
import { PromptEditor } from '../dist/cli/input.js'
import { saveUIPreferences, loadConfig } from '../dist/config/config.js'
import { TerminalUI } from '../dist/cli/ui.js'

function captureOutput(columns = 80, rows = 32) {
  const writes = []
  const output = new EventEmitter()
  output.columns = columns
  output.rows = rows
  output.write = chunk => { writes.push(String(chunk)); return true }
  return { writes, output }
}

function explorationSnapshot(overrides = {}) {
  return {
    cwd: '/tmp/project',
    discoveredFiles: ['/tmp/project/crypto.py'],
    files: [{ canonicalPath: '/tmp/project/crypto.py', mtimeMs: 1, size: 100, totalLines: 972, coveredRanges: [{ startLine: 1, endLine: 970 }], fullCoverage: false }],
    reads: [{ canonicalPath: '/tmp/project/crypto.py', requestedRange: { startLine: 1, endLine: 970 }, previousCoverage: [], newCoverage: [{ startLine: 1, endLine: 970 }], resultingCoverage: [{ startLine: 1, endLine: 970 }], fullCoverage: false }],
    searches: [{ kind: 'grep', query: '/watch', path: '/tmp/project/crypto.py', include: undefined, discoveredFiles: ['/tmp/project/crypto.py'], symbols: [], resultKeys: ['crypto.py:/watch'] }],
    symbols: [],
    settledVerificationFacts: [],
    progressRevision: 1,
    lastProgress: 'discovered /watch implementation',
    ...overrides,
  }
}

const telemetry = { toolCalls: 1, usefulCalls: 1, repeatedCalls: 0, overlappingCalls: 0, newFiles: 1, newRanges: 1, reconstructedEvidence: 0, searchNovelty: 1, novelSearchResults: 1, newSymbols: 0, settledVerificationFacts: 0, rounds: 1, noProgressRounds: 0, terminationReason: 'unknown' }

 test('13N-I visual catalog uses original TermAgent theme names and exposes semantic metadata', () => {
  const names = Object.values(THEMES).map(theme => theme.name)
  assert.deepEqual(names, ['TermAgent', 'Forge', 'Tideglass', 'Violet Wire', 'Mossline', 'Emberglass', 'Paperlite', 'Signalnight'])
  assert.equal(new Set(names).size, names.length)
  const rows = listThemes()
  assert.equal(rows.length, 8)
  assert.ok(rows.every(row => row.swatches.length >= 3))
})

test('13N-I custom theme files are loaded safely from project theme directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-theme-'))
  const themesDir = path.join(dir, '.termagent', 'themes')
  await fs.mkdir(themesDir, { recursive: true })
  await fs.writeFile(path.join(themesDir, 'oceanic.json'), JSON.stringify({ base: 'tideglass', name: 'Oceanic Study', primary: '#123456', banner: { gradient: ['#123456', '#234567', '#345678'], tagline: 'Read the current.' } }))
  await fs.writeFile(path.join(themesDir, 'broken.json'), '{not-json')
  const catalog = await loadThemeCatalog(dir)
  assert.equal(catalog.oceanic?.name, 'Oceanic Study')
  assert.equal(catalog.oceanic?.primary, '#123456')
  assert.equal(catalog.broken, undefined)
  await fs.rm(dir, { recursive: true, force: true })
})

test('13N-I banner styles render width-aware and all fit without trailing overflow', () => {
  for (const style of BANNER_STYLES) {
    const wide = renderBanner({ width: 80, version: '1.18.0', theme: THEMES.termagent, capability: 'truecolor', style: style.id })
    const narrow = renderBanner({ width: 32, version: '1.18.0', theme: THEMES.termagent, capability: 'truecolor', style: style.id })
    assert.ok(wide.length >= 1)
    assert.ok(narrow.length >= 1)
    assert.ok(wide.every(row => widthOf(row) <= 80))
    assert.ok(narrow.every(row => widthOf(row) <= 32))
  }
})

test('13N-I banner/effect surfaces stay width-safe across terminal color capabilities', () => {
  for (const capability of ['plain', 'ansi16', 'ansi256', 'truecolor']) {
    const banner = renderBanner({ width: 64, version: '1.18.0', theme: THEMES.signalnight, capability, style: 'showcase', effect: 'drift', frame: 7, animations: true })
    assert.ok(banner.length >= 1)
    assert.ok(banner.every(row => widthOf(row) <= 64))
    assert.ok(stripAnsi(banner.join('\n')).length > 0)
  }
})

test('13N-I banner effects are bounded, deterministic and disabled cleanly', () => {
  assert.equal(BANNER_EFFECTS.length, 7)
  const rows = ['        TERMAGENT        ', '                            ']
  for (const effect of BANNER_EFFECTS) {
    const a = applyBannerEffect({ rows, width: 28, frame: 10, effect: effect.id, theme: THEMES.termagent, capability: 'truecolor' })
    const b = applyBannerEffect({ rows, width: 28, frame: 10, effect: effect.id, theme: THEMES.termagent, capability: 'truecolor' })
    assert.deepEqual(a, b)
    assert.equal(a.length, rows.length)
    assert.ok(a.every(row => row.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').length <= 28))
  }
  assert.deepEqual(applyBannerEffect({ rows, width: 28, frame: 10, effect: 'off', theme: THEMES.termagent, capability: 'truecolor' }), rows.map(row => row.padEnd(28)))
})

test('13N-I banner style rows track the live style rather than the theme default', () => {
  const rows = __BANNER_STYLE_ROWS(THEMES.termagent, 'signal')
  assert.equal(rows.find(row => row.value === 'signal')?.status, 'active')
  assert.equal(rows.find(row => row.value === 'showcase')?.status, 'default')
})
test('13N-I effect and banner rows expose selected semantic states', () => {
  const effects = renderEffectPickerRows(THEMES.termagent, 'ripple')
  assert.equal(effects.find(row => row.value === 'ripple')?.status, 'active')
  assert.equal(effects.find(row => row.value === 'off')?.status, 'default')
})

test('13N-I exploration HUD reconstructs the requested 1-970 / 971-972 state', () => {
  const model = buildExplorationHUDModel(explorationSnapshot(), telemetry, 'read_file', true)
  assert.equal(model.visible, true)
  assert.equal(model.mode, 'reading')
  assert.equal(model.subject, 'crypto.py')
  assert.equal(model.percent, Math.round((970 / 972) * 100))
  assert.equal(model.coveredLabel, '1-970 inspected')
  assert.equal(model.remainingLabel, '971-972 remaining')
  assert.match(model.discoveryLabel, /\/watch/)
  const rows = renderExplorationHUD({ width: 64, theme: THEMES.termagent, capability: 'truecolor', model })
  assert.ok(rows.some(row => row.includes('READING')))
  assert.ok(rows.some(row => row.includes('1-970 inspected')))
})

test('13N-I exploration HUD never calls disjoint coverage one contiguous range', () => {
  const snapshot = explorationSnapshot({
    files: [{ canonicalPath: '/tmp/project/crypto.py', mtimeMs: 1, size: 100, totalLines: 1000, coveredRanges: [{ startLine: 1, endLine: 100 }, { startLine: 500, endLine: 600 }], fullCoverage: false }],
    reads: [{ canonicalPath: '/tmp/project/crypto.py', requestedRange: { startLine: 500, endLine: 600 }, previousCoverage: [{ startLine: 1, endLine: 100 }], newCoverage: [{ startLine: 500, endLine: 600 }], resultingCoverage: [{ startLine: 1, endLine: 100 }, { startLine: 500, endLine: 600 }], fullCoverage: false }],
  })
  const model = buildExplorationHUDModel(snapshot, telemetry, 'read_file', true)
  assert.equal(model.coveredLabel, '201 lines inspected')
})
test('13N-I UI preferences persist through the existing config store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-ui-config-'))
  await fs.mkdir(path.join(dir, '.termagent'), { recursive: true })
  await fs.writeFile(path.join(dir, '.termagent', 'config.json'), JSON.stringify({ provider: 'openai-compatible', model: 'x', ui: { theme: 'termagent' } }))
  await saveUIPreferences(dir, { theme: 'signalnight', bannerStyle: 'split', effect: 'drift', motion: 'reduced', animations: true })
  const config = await loadConfig(dir)
  assert.equal(config.ui?.theme, 'signalnight')
  assert.equal(config.ui?.bannerStyle, 'split')
  assert.equal(config.ui?.effect, 'drift')
  assert.equal(config.ui?.motion, 'reduced')
  assert.equal(config.ui?.animations, true)
  await fs.rm(dir, { recursive: true, force: true })
})

test('13N-I reduced motion disables decorative animation while preserving explicit state', () => {
  const { output } = captureOutput(72, 30)
  const input = new EventEmitter()
  input.isTTY = false
  const ui = new TerminalUI({ title: 'test', model: 'model', provider: 'provider', mode: 'build', cwd: '/tmp/project', themes: THEMES, theme: 'signalnight', effect: 'spark', animations: true, output, input })
  assert.equal(ui.getMotionMode(), 'full')
  ui.setMotionMode('reduced')
  assert.equal(ui.getMotionMode(), 'reduced')
  assert.equal(ui.getAnimations(), true)
  ui.setMotionMode('off')
  assert.equal(ui.getAnimations(), false)
})

test('13N-I visual palette lifecycle reports cancel and commit distinctly', async () => {
  const events = []
  const editor = new PromptEditor({ onChange: () => {}, onCompletion: (state, reason) => events.push({ state, reason }) })
  editor.openThemePalette([
    { id: 'theme:forge', label: 'Forge', value: 'forge' },
    { id: 'theme:termagent', label: 'TermAgent', value: 'termagent' },
  ], async () => {}, 'forge')
  editor.closeCommandPalette()
  editor.openThemePalette([
    { id: 'theme:forge', label: 'Forge', value: 'forge' },
    { id: 'theme:termagent', label: 'TermAgent', value: 'termagent' },
  ], async () => {}, 'termagent')
  await editor.clickCompletion(0)
  assert.equal(events.at(-1)?.reason, 'commit')
  assert.ok(events.some(event => event.reason === 'cancel'))
})
test('13N-I TerminalUI projects exploration and palette state without creating a second UI model', () => {
  const { output } = captureOutput(72, 30)
  const input = new EventEmitter()
  input.isTTY = false
  const ui = new TerminalUI({ title: 'test', model: 'model', provider: 'provider', mode: 'build', cwd: '/tmp/project', themes: THEMES, theme: 'termagent', output, input })
  ui.enter()
  ui.setCompletion({
    kind: 'theme',
    items: ['Forge', 'TermAgent'],
    rows: [
      { id: 'theme:forge', label: 'Forge', value: 'forge', detail: 'Warm workspace', swatches: ['#ffb07a', '#ff7043', '#7bd88f'] },
      { id: 'theme:termagent', label: 'TermAgent', value: 'termagent', detail: 'Default workspace', swatches: ['#78d6ff', '#b29cff', '#ff895c'] },
    ],
    index: 0,
    query: '',
  })
  const controller = new AbortController()
  ui.beginAgentTurn(controller)
  ui.setExploration(explorationSnapshot(), telemetry)
  ui.render()
  const hitTargets = ui.hitTargetSnapshot()
  assert.ok(hitTargets.some(target => target.id === 'picker:0'))
  assert.ok(hitTargets.some(target => target.id === 'footer:interrupt' || target.id === 'interrupt'))
  ui.endAgentTurn()
  ui.leave()
})
