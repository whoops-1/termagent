import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Agent } from '../dist/agent/agent.js'
import { PluginHookManager, loadPluginHooks } from '../dist/plugins/hooks.js'
import { loadInstalledPluginComponents } from '../dist/plugins/components.js'
import { computePluginTreeDigest, installedPluginsPath, installedPluginsRoot } from '../dist/plugins/marketplace.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { builtinTools } from '../dist/tools/builtin.js'
import { connectMCP } from '../dist/mcp/client.js'
import { SessionStore } from '../dist/session/store.js'

async function withHome(home, fn) {
  const old = process.env.HOME
  process.env.HOME = home
  try { return await fn() } finally { process.env.HOME = old }
}

async function writeInstalled(home, record) {
  const root = path.join(home, '.termagent', 'plugins')
  await mkdir(root, { recursive: true })
  await writeFile(installedPluginsPath(), JSON.stringify({ version: 1, plugins: { [record.id]: record } }, null, 2))
}

async function makeInstalledPlugin(home, { id = 'demo@local', plugin = 'demo', marketplace = 'local', version = '1.0.0' } = {}) {
  const installPath = path.join(installedPluginsRoot(), marketplace, plugin, version)
  await mkdir(path.join(installPath, '.claude-plugin'), { recursive: true })
  const record = {
    id,
    marketplace,
    plugin,
    source: `./${plugin}`,
    installPath,
    version,
    digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    installedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    status: 'installed'
  }
  await writeInstalled(home, record)
  return { installPath, record }
}

function gitLikePluginManifest(extra = {}) {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'Demo plugin',
    ...extra
  }
}

test('installed plugin components load commands and agents with namespaced provenance', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-components-'))
  try {
    await withHome(home, async () => {
      const { installPath, record } = await makeInstalledPlugin(home)
      await writeFile(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(gitLikePluginManifest({
        commands: { summary: { source: './commands/summary.md', description: 'Summarize the project', allowedTools: ['read_file'] } },
        agents: './agents'
      })))
      await mkdir(path.join(installPath, 'commands'), { recursive: true })
      await mkdir(path.join(installPath, 'agents'), { recursive: true })
      await writeFile(path.join(installPath, 'commands', 'default.md'), '---\ndescription: Default command\n---\nDo the default task.')
      await writeFile(path.join(installPath, 'commands', 'summary.md'), '---\ndescription: Summary command\n---\nSummarize carefully.')
      await writeFile(path.join(installPath, 'agents', 'review.md'), '---\ndescription: Review agent\ntools: [read_file]\ndisallowedTools: [write_file]\nskills: [pdf]\n---\nReview the project.')
      record.digest = await computePluginTreeDigest(installPath)
      await writeInstalled(home, record)
      const result = await loadInstalledPluginComponents()
      const names = result.commands.map(x => x.name)
      assert.deepEqual(names.sort(), ['demo:default', 'demo:summary'])
      assert.equal(result.commands.find(x => x.name === 'demo:summary').plugin.pluginId, 'demo@local')
      assert.deepEqual(result.commands.find(x => x.name === 'demo:summary').allowedTools, ['read_file'])
      assert.equal(result.agents.length, 1)
      assert.equal(result.agents[0].name, 'demo:review')
      assert.deepEqual(result.agents[0].tools, ['read_file'])
      assert.deepEqual(result.agents[0].disallowedTools, ['write_file'])
      assert.deepEqual(result.agents[0].skills, ['pdf'])
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})
test('plugin management inspection can count disabled components without activating them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-disabled-inspection-'))
  try {
    await withHome(home, async () => {
      const { installPath, record } = await makeInstalledPlugin(home, { id: 'disabled@local', plugin: 'disabled' })
      record.enabled = false
      await writeInstalled(home, record)
      await writeFile(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(gitLikePluginManifest({
        name: 'disabled',
        commands: './commands',
      })))
      await mkdir(path.join(installPath, 'commands'), { recursive: true })
      await writeFile(path.join(installPath, 'commands', 'check.md'), '---\ndescription: Check\n---\ncheck')
      record.digest = await computePluginTreeDigest(installPath)
      await writeInstalled(home, record)
      const inactive = await loadInstalledPluginComponents()
      assert.equal(inactive.commands.length, 0)
      const inspected = await loadInstalledPluginComponents({ includeDisabled: true })
      assert.equal(inspected.commands.length, 1)
      assert.equal(inspected.commands[0].name, 'disabled:check')
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('installed plugin manifest must match installed state before activation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-manifest-mismatch-'))
  try {
    await withHome(home, async () => {
      const { installPath } = await makeInstalledPlugin(home, { id: 'demo@local', plugin: 'demo' })
      await writeFile(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(gitLikePluginManifest({ name: 'tampered' })))
      await mkdir(path.join(installPath, 'commands'), { recursive: true })
      await writeFile(path.join(installPath, 'commands', 'ignored.md'), '---\ndescription: should not load\n---\nno')
      const current = JSON.parse(await readFile(installedPluginsPath(), 'utf8'))
      const rec = current.plugins['demo@local']
      rec.digest = await computePluginTreeDigest(installPath)
      await writeFile(installedPluginsPath(), JSON.stringify(current, null, 2))
      const result = await loadInstalledPluginComponents()
      assert.equal(result.commands.length, 0)
      assert.ok(result.errors.some(x => x.plugin === 'demo@local' && /does not match/.test(x.error)))
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('two plugins with the same component names do not collide', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-collision-'))
  try {
    await withHome(home, async () => {
      const first = await makeInstalledPlugin(home, { id: 'alpha@local', plugin: 'alpha' })
      const secondPath = path.join(installedPluginsRoot(), 'local', 'beta', '1.0.0')
      await mkdir(path.join(secondPath, '.claude-plugin'), { recursive: true })
      const second = {
        id: 'beta@local', marketplace: 'local', plugin: 'beta', source: './beta',
        installPath: secondPath, version: '1.0.0', digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111', installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString(), status: 'installed'
      }
      await writeFile(installedPluginsPath(), JSON.stringify({ version: 1, plugins: { 'beta@local': second, 'alpha@local': first.record } }, null, 2))
      for (const [root, name] of [[first.installPath, 'alpha'], [secondPath, 'beta']]) {
        await writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(gitLikePluginManifest({ name })))
        await mkdir(path.join(root, 'commands'), { recursive: true })
        await writeFile(path.join(root, 'commands', 'same.md'), '---\ndescription: same\n---\nDo it.')
      }
      first.record.digest = await computePluginTreeDigest(first.installPath)
      second.digest = await computePluginTreeDigest(secondPath)
      await writeFile(installedPluginsPath(), JSON.stringify({ version: 1, plugins: { 'beta@local': second, 'alpha@local': first.record } }, null, 2))
      const result = await loadInstalledPluginComponents()
      assert.deepEqual(result.commands.map(x => x.name), ['alpha:same', 'beta:same'])
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('component loader never imports arbitrary executable plugin entrypoints', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-no-exec-'))
  try {
    await withHome(home, async () => {
      const { installPath, record } = await makeInstalledPlugin(home)
      const marker = path.join(home, 'EXECUTED')
      await writeFile(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(gitLikePluginManifest()))
      await writeFile(path.join(installPath, 'index.mjs'), `await import('node:fs/promises').then(fs=>fs.writeFile(${JSON.stringify(marker)}, 'bad'))`)
      record.digest = await computePluginTreeDigest(installPath)
      await writeInstalled(home, record)
      await loadInstalledPluginComponents()
      await assert.rejects(access(marker))
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('plugin MCP servers are loaded and preserve plugin provenance through the MCP tool', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-mcp-'))
  try {
    await withHome(home, async () => {
      const { installPath, record } = await makeInstalledPlugin(home)
      const server = path.join(installPath, 'server.mjs')
      await writeFile(server, `import readline from 'node:readline'; readline.createInterface({input:process.stdin}).on('line', l => { const r=JSON.parse(l); if(r.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'p',version:'1'}}})+'\\n'); else if(r.method==='tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{tools:[{name:'hello',description:'hello',inputSchema:{type:'object',properties:{}}}]}})+'\\n'); else if(r.method==='tools/call') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:'plugin-mcp-ok'}]}})+'\\n') })`)
      await writeFile(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(gitLikePluginManifest({ mcpServers: { demo: { command: process.execPath, args: ['./server.mjs'] } } })))
      record.digest = await computePluginTreeDigest(installPath)
      await writeInstalled(home, record)
      const loaded = await loadInstalledPluginComponents()
      assert.ok(loaded.mcpServers.plugin_demo_demo)
      assert.equal(loaded.mcpServers.plugin_demo_demo.pluginId, 'demo@local')
      const mcp = await connectMCP(loaded.mcpServers, installPath)
      assert.equal(mcp.tools.length, 1)
      assert.equal(mcp.tools[0].name, 'mcp_plugin_demo_demo_hello')
      assert.equal(mcp.tools[0].provenance.pluginId, 'demo@local')
      const out = await mcp.tools[0].execute({}, { sessionID:'x', agent:'build', cwd:installPath, abort:new AbortController().signal })
      assert.equal(out.output, 'plugin-mcp-ok')
      assert.equal(out.metadata.provenance.pluginName, 'demo')
      await Promise.all(mcp.clients.map(c => c.close()))
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('plugin hooks run through the existing permission gate and can receive JSON context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-hooks-'))
  try {
    const hookFile = path.join(root, 'hooks.json')
    const marker = path.join(root, 'hook.txt')
    await writeFile(hookFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: `node -e 'let d="";process.stdin.on("data",b=>d+=b).on("end",()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},process.env.TERMAGENT_HOOK_EVENT+":"+JSON.parse(d).toolName))'` }] }] } }))
    const hooks = await loadPluginHooks(root, { hooks: './hooks.json' }, 'demo@local')
    const gate = new PermissionGate('auto')
    const manager = new PluginHookManager(hooks, gate)
    await manager.emit({ event:'PreToolUse', toolName:'write_file', toolArgs:{path:'a'}, cwd:root, sessionID:'s' })
    assert.equal(await readFile(marker, 'utf8'), 'PreToolUse:write_file')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('plugin hook command is denied when the existing permission gate denies shell', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-hook-deny-'))
  try {
    const hookFile = path.join(root, 'hooks.json')
    const marker = path.join(root, 'denied')
    await writeFile(hookFile, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type:'command', command:`touch ${JSON.stringify(marker)}` }] }] } }))
    const hooks = await loadPluginHooks(root, { hooks:'./hooks.json' }, 'demo@local')
    const gate = new PermissionGate('deny')
    const manager = new PluginHookManager(hooks, gate)
    await assert.rejects(() => manager.emit({event:'PreToolUse', toolName:'read_file', cwd:root, sessionID:'s'}), /Permission denied/)
    await assert.rejects(access(marker))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pre-tool plugin hook failure prevents the underlying tool from executing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-prehook-'))
  try {
    const hookFile = path.join(root, 'hooks.json')
    await writeFile(hookFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'write_file', hooks: [{ type:'command', command:'exit 7' }] }] } }))
    const hooks = await loadPluginHooks(root, { hooks:'./hooks.json' }, 'demo@local')
    const marker = path.join(root, 'tool-was-run')
    const gate = new PermissionGate('auto')
    const manager = new PluginHookManager(hooks, gate)
    const registry = new ToolRegistry(gate)
    registry.add({ name:'write_file', risk:'write', description:'write', schema:{type:'object'}, execute:async()=>{ await writeFile(marker,'ran'); return {output:'ran'} } })
    class Provider {
      calls=0
      async *stream(_messages, schemas){
        this.calls++
        if(this.calls===1){
          assert.ok(schemas.some(x=>x.function.name==='write_file'))
          yield {type:'tool_call',call:{id:'x1',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'x',content:'x'})}}}
          yield {type:'done',finishReason:'tool_calls'}
        } else {
          yield {type:'text',delta:'blocked safely'}
          yield {type:'done',finishReason:'stop'}
        }
      }
    }
    const provider = new Provider()
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'mock')
    const agent = new Agent(provider, registry, store, 3, 12000, 1, undefined, [], {}, manager)
    let out=''
    await agent.run({sessionId:session.id,messages:[],cwd:root,instructions:'test',prompt:'write something',onText:s=>out+=s})
    assert.equal(out,'blocked safely')
    await assert.rejects(access(marker))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('plugin command tool allowlist is enforced at schema and execution time', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-allowlist-'))
  try {
    const gate = new PermissionGate('auto')
    const registry = new ToolRegistry(gate)
    builtinTools({timeout:5000,maxOutput:5000}).forEach(t=>registry.add(t))
    class Provider {
      calls=0
      async *stream(_messages, schemas){
        this.calls++
        if(this.calls===1){
          assert.ok(schemas.some(x=>x.function.name==='read_file'))
          assert.equal(schemas.some(x=>x.function.name==='write_file'), false)
          yield {type:'tool_call',call:{id:'x1',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'blocked.txt',content:'nope'})}}}
          yield {type:'done',finishReason:'tool_calls'}
        } else {
          assert.ok(schemas.some(x=>x.function.name==='read_file'))
          assert.equal(schemas.some(x=>x.function.name==='write_file'), false)
          yield {type:'text',delta:'allowlist enforced'}
          yield {type:'done',finishReason:'stop'}
        }
      }
    }
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'mock')
    const agent = new Agent(new Provider(), registry, store, 3)
    await agent.run({sessionId:session.id,messages:[],cwd:root,instructions:'test',prompt:'run command',allowedTools:['read_file']})
    await assert.rejects(access(path.join(root, 'blocked.txt')))
  } finally { await rm(root, {recursive:true,force:true}) }
})

test('plugin agent disallowed tool is enforced even if the model emits it anyway', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-agent-policy-'))
  try {
    const gate = new PermissionGate('auto')
    const registry = new ToolRegistry(gate)
    builtinTools({timeout:5000,maxOutput:5000}).forEach(t=>registry.add(t))
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'mock')
    class Provider { calls=0; async *stream(_m,schemas){ this.calls++; if(this.calls===1){ assert.equal(schemas.some(x=>x.function.name==='bash'), false); yield {type:'tool_call',call:{id:'x',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'touch blocked-agent'})}}}; yield {type:'done',finishReason:'tool_calls'} } else { yield {type:'text',delta:'agent policy enforced'}; yield {type:'done',finishReason:'stop'} } } }
    const agent = new Agent(new Provider(), registry, store, 3)
    await agent.run({sessionId:session.id,messages:[],cwd:root,instructions:'test',prompt:'review',customAgent:{name:'demo:review',description:'review',mode:'subagent',prompt:'review',disallowedTools:['bash']}})
    await assert.rejects(access(path.join(root,'blocked-agent')))
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('failed component load is isolated from a sibling plugin', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-isolation-'))
  try {
    await withHome(home, async () => {
      const bad = await makeInstalledPlugin(home, { id:'bad@local', plugin:'bad' })
      const goodPath = path.join(installedPluginsRoot(), 'local', 'good', '1.0.0')
      await mkdir(path.join(goodPath, '.claude-plugin'), { recursive: true })
      const good = { id:'good@local', marketplace:'local', plugin:'good', source:'./good', installPath:goodPath, version:'1.0.0', digest:'sha256:2222222222222222222222222222222222222222222222222222222222222222', installedAt:new Date().toISOString(), lastUpdated:new Date().toISOString(), status:'installed' }
      await writeFile(installedPluginsPath(), JSON.stringify({ version:1, plugins:{'bad@local':bad.record,'good@local':good} }, null, 2))
      await writeFile(path.join(bad.installPath,'.claude-plugin','plugin.json'), '{not json')
      await writeFile(path.join(goodPath,'.claude-plugin','plugin.json'), JSON.stringify({name:'good',version:'1.0.0'}))
      await mkdir(path.join(goodPath,'commands'), {recursive:true})
      await writeFile(path.join(goodPath,'commands','ok.md'), '---\ndescription: okay\n---\nokay')
      bad.record.digest = await computePluginTreeDigest(bad.installPath)
      good.digest = await computePluginTreeDigest(goodPath)
      await writeFile(installedPluginsPath(), JSON.stringify({ version:1, plugins:{'bad@local':bad.record,'good@local':good} }, null, 2))
      const result=await loadInstalledPluginComponents()
      assert.equal(result.commands.some(x=>x.name==='good:ok'),true)
      assert.ok(result.errors.some(x=>x.plugin==='bad@local'))
    })
  } finally { await rm(home,{recursive:true,force:true}) }
})

