import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve('experimental/ui-v2/dist/design-system')
const motion = await import(path.join(root, 'motion.js'))
const theme = await import(path.join(root, 'theme.js'))
const ansi = await import(path.join(root, 'ansi.js'))

for (const name of ['termagent', 'forge', 'tideglass', 'paperlite']) {
  test(`motion surfaces stay width-safe in ${name} theme`, () => {
    const t = theme.getTheme(name)
    const startup = motion.renderStartup({ width: 60, frame: 3, theme: t, capability: 'truecolor' })
    const done = motion.renderCompletion({ width: 60, label: 'Turn complete · changes applied', now: 123456, theme: t, capability: 'truecolor' })
    assert.equal(ansi.widthOf(startup), 60)
    assert.equal(ansi.widthOf(done), 60)
    assert.match(ansi.stripAnsi(startup), /Starting TermAgent/)
    assert.match(ansi.stripAnsi(done), /Turn complete/)
  })
}

test('elapsed and animation helpers are deterministic for fixed timestamps', () => {
  assert.equal(motion.animationFrame(1000, 80), 12)
  assert.equal(motion.elapsedSecondsSince(1000, 4999), 3)
  assert.equal(motion.elapsedSecondsSince(1000, 5000), 4)
  assert.equal(motion.pulse(0, 300), true)
  assert.equal(motion.pulse(150, 300), false)
})
