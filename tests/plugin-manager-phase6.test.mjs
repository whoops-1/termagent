import test from 'node:test'
import assert from 'node:assert/strict'
import { PluginManagerController } from '../dist/cli/tui/plugin-manager.js'

function snapshot() {
  const marketplace = {
    name: 'termagent-community',
    owner: 'Community',
    description: 'A marketplace with useful development plugins.',
    source: { source: 'github', repo: 'example/termagent-community', ref: 'main' },
    status: 'ready',
    lastUpdated: '2026-09-27T10:00:00.000Z',
    revision: '0123456789abcdef0123456789abcdef01234567',
    digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    installLocation: '/tmp/marketplaces/termagent-community',
    plugins: Array.from({ length: 12 }, (_, i) => ({
      name: `plugin-${String(i + 1).padStart(2, '0')}`,
      version: `1.0.${i}`,
      description: `Plugin ${i + 1} description for terminal testing and browsing.`,
      source: { source: 'github', repo: `example/plugin-${i + 1}`, ref: 'main' },
      category: 'development',
      tags: ['dev', 'test'],
      strict: true,
    })),
  }
  return {
    plugins: [
      {
        id: 'zebra@termagent-community', marketplace: 'termagent-community', plugin: 'zebra', source: 'github',
        status: 'installed', enabled: true, version: '1.2.3', revision: 'fedcba9876543210fedcba9876543210fedcba98',
        digest: 'sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        installPath: '/home/u/.termagent/plugins/zebra', error: undefined,
        components: { commands: 3, agents: 2, skills: 4, mcp: 1, hooks: 2 },
      },
      {
        id: 'alpha@termagent-community', marketplace: 'termagent-community', plugin: 'alpha-with-a-very-long-name-that-must-be-clipped', source: 'github',
        status: 'update-available', enabled: true, version: '0.9.0', revision: '1111111111111111111111111111111111111111',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        installPath: '/home/u/.termagent/plugins/alpha', error: undefined,
        components: { commands: 0, agents: 1, skills: 2, mcp: 0, hooks: 0 },
      },
      {
        id: 'disabled@termagent-community', marketplace: 'termagent-community', plugin: 'disabled', source: 'github',
        status: 'installed', enabled: false, version: '2.0.0', revision: '2222222222222222222222222222222222222222',
        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        installPath: '/home/u/.termagent/plugins/disabled', error: undefined,
        components: { commands: 1, agents: 0, skills: 0, mcp: 0, hooks: 1 },
      },
    ],
    marketplaces: [marketplace],
    skills: [
      { id: 'zebra:review', name: 'review', description: 'Review code changes carefully.', source: 'plugin', pluginId: 'zebra@termagent-community', pluginName: 'zebra', marketplace: 'termagent-community', version: '1.2.3', userInvocable: true },
      { id: 'local:notes', name: 'notes', description: 'Organize project notes.', source: 'project', userInvocable: true },
    ],
  }
}

function callbacks(log) {
  let snap = snapshot()
  return {
    async refresh() { log.push(['refresh']); return snap },
    async togglePlugin(...args) { log.push(['toggle', ...args]) },
    async removePlugin(...args) { log.push(['remove', ...args]) },
    async installPlugin(...args) { log.push(['install', ...args]); return { message: 'installed' } },
    async refreshMarketplace(...args) { log.push(['marketplace-refresh', ...args]) },
    async removeMarketplace(...args) { log.push(['marketplace-remove', ...args]) },
    async skillDetails(id) { log.push(['skill-details', id]); return { ...snap.skills.find(s => s.id === id), path: '/tmp/SKILL.md', root: '/tmp', size: 10, mtimeMs: 1, sha256: 'sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd', frontmatter: { description: 'x' }, warnings: [] } },
  }
}

test('plugin manager renders compact list at 60x20 and preserves the footer', () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'plugins')
  const frame = c.render(60, 20).join('\n')
  assert.match(frame, /Plugin manager/)
  assert.match(frame, /installed/)
  assert.match(frame, /↑↓ select/)
  assert.ok(c.render(60, 20).length <= 20)
})

test('plugin manager clamps global selection instead of wrapping', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'marketplaces')
  for (let i = 0; i < 20; i++) await c.handleKey('down')
  assert.equal(c.getSelectedIndex(), 0)
  await c.handleKey('home')
  assert.equal(c.getSelectedIndex(), 0)
  await c.handleKey('end')
  assert.equal(c.getSelectedIndex(), 0)
})

test('plugin manager supports marketplace plugin selection and details', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'marketplaces')
  await c.handleKey('enter')
  assert.match(c.render(80, 24).join('\n'), /Available plugins/)
  await c.handleKey('down')
  await c.handleKey('enter')
  assert.match(c.render(80, 24).join('\n'), /plugin-02@termagent-community/)
  await c.handleKey('i')
  assert.match(c.render(80, 24).join('\n'), /Trust confirmation/)
  assert.match(c.render(80, 24).join('\n'), /plugin-02@termagent-community/)
})

test('plugin trust confirmation installs only the selected marketplace plugin', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'marketplaces')
  await c.handleKey('enter')
  await c.handleKey('down')
  await c.handleKey('enter')
  await c.handleKey('i')
  await c.handleKey('y')
  assert.ok(log.some(x => x[0] === 'install' && x[1] === 'termagent-community' && x[2] === 'plugin-02' && x[3] === true), JSON.stringify(log))
})

test('plugin enable/disable action uses explicit state and refreshes', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'plugins')
  await c.handleKey('down')
  await c.handleKey('e')
  assert.ok(log.some(x => x[0] === 'toggle' && x[1] === 'termagent-community' && x[2] === 'disabled' && x[3] === true), JSON.stringify(log))
  assert.ok(log.some(x => x[0] === 'refresh'))
})

test('plugin manager mouse row 5 opens the first list item and wheel scroll moves selection', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'plugins')
  assert.equal(c.getSelectedRowTop(), 5)
  await c.mouseClick(5, 0)
  assert.match(c.render(80, 24).join('\n'), /alpha-with-a-very-long-name-that-must-be-clipped/)
  const c2 = new PluginManagerController(callbacks(log), snapshot(), 'plugins')
  await c2.mouseClick(0, 65)
  assert.equal(c2.getSelectedIndex(), 2)
})

test('marketplace detail mouse click selects a visible plugin row', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'marketplaces')
  await c.handleKey('enter')
  // In this fixture the marketplace has 8 detail rows, so first plugin is row 17.
  await c.mouseClick(18, 0)
  assert.match(c.render(80, 24).join('\n'), /plugin-02@termagent-community/)
})
test('TerminalUI plugin manager accepts split SGR click and wheel input without touching the prompt', async () => {
  const { EventEmitter } = await import('node:events')
  const { TerminalUI } = await import('../dist/cli/ui.js')
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const output = new EventEmitter()
  output.columns = 80
  output.rows = 24
  const writes = []
  output.write = chunk => { writes.push(String(chunk)); return true }
  const log = []
  const ui = new TerminalUI({ title: 'plugin-ui', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output, input })
  try {
    ui.enter()
    // Session 1: wheel + keyboard navigation. Three installed plugin states
    // exist, so one wheel-down step of 3 lands on the third sorted row (zebra).
    let pending = ui.openPluginManager(callbacks(log), 'plugins')
    await new Promise(r => setTimeout(r, 10))
    input.emit('data', '\x1b[<65;12;5M')
    await new Promise(r => setTimeout(r, 10))
    input.emit('data', '\r')
    await new Promise(r => setTimeout(r, 10))
    let frame = writes.at(-1) || ''
    assert.match(frame, /zebra/) 
    input.emit('data', 'q')
    input.emit('data', 'q')
    await pending
    assert.equal(ui.isPluginManagerActive(), false)

    // Session 2: split SGR click. The first chunk contains only a prefix, so
    // it must not be interpreted as digits/section-switch keys.
    pending = ui.openPluginManager(callbacks(log), 'plugins')
    await new Promise(r => setTimeout(r, 10))
    input.emit('data', '\x1b[<0;12;')
    input.emit('data', '5M')
    await new Promise(r => setTimeout(r, 10))
    frame = writes.at(-1) || ''
    assert.match(frame, /alpha-with-a-very-long-name-that-must-be-clipped/) 
    input.emit('data', 'q')
    input.emit('data', 'q')
    await pending
    assert.equal(ui.isPluginManagerActive(), false)
    assert.equal(ui.isPermissionActive(), false)
    assert.equal(ui.isQuestionActive(), false)
  } finally {
    ui.leave()
  }
})

test('skills browser search and detail remain available', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'skills', 'zebra')
  assert.match(c.render(80, 24).join('\n'), /zebra:review/)
  await c.handleKey('enter')
  assert.ok(log.some(x => x[0] === 'skill-details'))
  const frame = c.render(80, 24).join('\n')
  assert.match(frame, /SHA-256/)
})
test('plugin manager preserves success messages after refresh', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'plugins')
  await c.handleKey('down')
  await c.handleKey('e')
  const frame = c.render(80, 24).join('\n')
  assert.match(frame, /Enabled disabled@termagent-community/) 
  assert.doesNotMatch(frame, /Enabled disabled@termagent-community.*Refreshed/) 
})

test('plugin manager supports page navigation without wrapping', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'marketplaces')
  await c.handleKey('enter')
  await c.handleKey('pagedown')
  await c.handleKey('enter')
  assert.match(c.render(80, 24).join('\n'), /plugin-07@termagent-community/)
  await c.handleKey('escape')
  await c.handleKey('pageup')
  await c.handleKey('enter')
  assert.match(c.render(80, 24).join('\n'), /plugin-01@termagent-community/)
})

test('plugin manager search filters plugins and can be cleared', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'plugins')
  await c.handleKey('/')
  for (const ch of 'disabled') await c.handleKey(ch)
  assert.equal(c.getQuery(), 'disabled')
  assert.match(c.render(80, 24).join('\n'), /disabled/) 
  assert.doesNotMatch(c.render(80, 24).join('\n'), /alpha-with/) 
  await c.handleKey('enter')
  assert.equal(c.isSearching(), false)
  await c.handleKey('/')
  for (let i = 0; i < 'disabled'.length; i++) await c.handleKey('backspace')
  assert.equal(c.getQuery(), '')
  assert.match(c.render(80, 24).join('\n'), /alpha-with/)
})

test('trust and removal dialogs can be cancelled cleanly', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'marketplaces')
  await c.handleKey('enter')
  await c.handleKey('i')
  assert.match(c.render(60, 20).join('\n'), /Trust confirmation/) 
  await c.handleKey('escape')
  assert.doesNotMatch(c.render(60, 20).join('\n'), /Trust confirmation/) 
  assert.equal(log.some(x => x[0] === 'install'), false)

  const p = new PluginManagerController(callbacks(log), snapshot(), 'plugins')
  await p.handleKey('enter')
  await p.handleKey('x')
  assert.match(p.render(60, 20).join('\n'), /Confirm removal/) 
  await p.handleKey('escape')
  assert.doesNotMatch(p.render(60, 20).join('\n'), /Confirm removal/) 
  assert.equal(log.some(x => x[0] === 'remove'), false)
})
test('small marketplace detail prioritizes plugin rows without clipping the footer', async () => {
  const log = []
  const c = new PluginManagerController(callbacks(log), snapshot(), 'marketplaces')
  await c.handleKey('enter')
  const frame = c.render(60, 20).join('\n')
  assert.doesNotMatch(frame, /details truncated for terminal height/)
  assert.match(frame, /Available plugins · 12/)
  assert.match(frame, /plugin-06/)
  assert.match(frame, /Enter plugin/)
})
