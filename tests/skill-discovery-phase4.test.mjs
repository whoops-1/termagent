import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { rankSkillDescriptors, scoreSkill, searchSkills } from '../dist/skills/discovery.js'
import { loadSkill } from '../dist/skills/invoker.js'
import { skillTools } from '../dist/tools/skills.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { SessionStore } from '../dist/session/store.js'
import { Agent } from '../dist/agent/agent.js'
import { builtinTools } from '../dist/tools/builtin.js'

async function writeSkill(root, name, content) {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), content)
  return dir
}

function runCli(cwd, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('dist/index.js')], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, out, err }))
    child.stdin.write(input)
    child.stdin.end()
  })
}

async function makeProject() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase4-home-'))
  const project = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase4-project-'))
  await mkdir(path.join(project, '.termagent', 'skills'), { recursive: true })
  return { home, project }
}

async function withHome(home, fn) {
  const previous = process.env.HOME
  process.env.HOME = home
  try { return await fn() } finally { process.env.HOME = previous }
}

function mockProvider(script) {
  return {
    id: 'mock', model: 'mock', config: { maxTokens: 500 }, calls: 0,
    async *stream(messages, schemas) {
      const step = script[this.calls++] || { text: 'done' }
      if (step.check) step.check(messages, schemas)
      if (step.call) yield { type: 'tool_call', call: step.call }
      if (step.text) yield { type: 'text', delta: step.text }
      yield { type: 'done', finishReason: step.call ? 'tool_calls' : 'stop' }
    }
  }
}

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

test('skill search returns only thresholded relevant descriptors, not weak top-N noise', async () => {
  const skills = [
    { id: 'pr-review', name: 'pr-review', description: 'Review pull requests for correctness and security', source: 'project' },
    { id: 'security-audit', name: 'security-audit', description: 'Audit code for vulnerabilities and unsafe behavior', source: 'project' },
    { id: 'db-migration', name: 'db-migration', description: 'Review and execute database migrations', source: 'project' },
  ]
  const results = rankSkillDescriptors(skills, 'review this pull request for security issues')
  assert.deepEqual(results.map(x => x.id), ['pr-review', 'security-audit'])
  assert.equal(results.some(x => x.id === 'db-migration'), false)
  assert.ok(results.every(x => x.relevance >= 0.34))
  assert.equal(scoreSkill(skills[0], 'completely unrelated gardening task'), 0)
})

test('searchSkills searches the live catalog and excludes skill bodies from results', async () => {
  const { home, project } = await makeProject()
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'testing', '---\ndescription: Run focused tests\n---\nSECRET_BODY\n')
    await withHome(home, async () => {
      const results = await searchSkills(project, 'run focused tests')
      assert.equal(results.length, 1)
      assert.equal(results[0].id, 'testing')
      assert.equal(JSON.stringify(results).includes('SECRET_BODY'), false)
      assert.ok(results[0].relevance > 0.5)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('use_skill loads the exact full SKILL.md and verifies its current digest', async () => {
  const { home, project } = await makeProject()
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'testing', '---\ndescription: Run tests\n---\n# Testing\nFULL_BODY\n')
    await withHome(home, async () => {
      const loaded = await loadSkill(project, 'testing')
      assert.equal(loaded.descriptor.id, 'testing')
      assert.match(loaded.content, /FULL_BODY/)
      assert.match(loaded.sha256, /^sha256:[a-f0-9]{64}$/)
      assert.equal(loaded.sha256, loaded.descriptor && (await loadSkill(project, 'testing')).sha256)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('use_skill refuses model-disabled and non-user-invocable skills as requested', async () => {
  const { home, project } = await makeProject()
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'hidden', '---\ndescription: Hidden\nuser-invocable: false\n---\n')
    await writeSkill(path.join(project, '.termagent', 'skills'), 'model-off', '---\ndescription: Model off\ndisable-model-invocation: true\n---\n')
    await withHome(home, async () => {
      await assert.rejects(loadSkill(project, 'hidden', { requireUserInvocable: true }), /cannot be invoked directly/i)
      await assert.rejects(loadSkill(project, 'model-off'), /disabled for model invocation/i)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('skill tools are exactly one search tool plus one load tool and record decisions', async () => {
  const { home, project } = await makeProject()
  const events = []
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'testing', '---\ndescription: Run tests\n---\nFULL_BODY\n')
    await withHome(home, async () => {
      const tools = skillTools(async (_session, event) => { events.push(event) })
      assert.deepEqual(tools.map(t => t.name), ['search_skills', 'skill', 'use_skill'])
      const searchResult = await tools[0].execute({ query: 'run tests' }, { sessionID: 's1', agent: 'build', cwd: project, abort: new AbortController().signal })
      assert.match(searchResult.output, /"testing"/)
      assert.equal(searchResult.output.includes('FULL_BODY'), false)
      const useResult = await tools.find(t => t.name === 'skill').execute({ name: 'testing' }, { sessionID: 's1', agent: 'build', cwd: project, abort: new AbortController().signal })
      assert.match(useResult.output, /FULL_BODY/)
      assert.deepEqual(events.map(x => x.action), ['search', 'load'])
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('agent performs initial user-input discovery without loading unrelated bodies', async () => {
  const { home, project } = await makeProject()
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'deploy', '---\ndescription: Deploy the application\n---\nDEPLOY_BODY\n')
    await writeSkill(path.join(project, '.termagent', 'skills'), 'database', '---\ndescription: Review database migrations\n---\nDB_BODY\n')
    await withHome(home, async () => {
      const store = new SessionStore(path.join(project, '.sessions'))
      const session = await store.create(project, 'mock')
      const registry = new ToolRegistry(new PermissionGate('auto'))
      skillTools(async (id, event) => { await store.append(id, { type: `skill.${event.action}`, ts: Date.now(), data: event }) }).forEach(t => registry.add(t))
      const provider = mockProvider([{ text: 'done', check(messages) {
        const system = messages.find(m => m.role === 'system')?.content || ''
        assert.match(system, /deploy/)
        assert.doesNotMatch(system, /DEPLOY_BODY/)
        assert.doesNotMatch(system, /DB_BODY/)
      } }])
      const agent = new Agent(provider, registry, store, 2)
      await agent.run({ sessionId: session.id, messages: [], cwd: project, instructions: 'test', prompt: 'deploy the application' })
      const events = (await store.load(session.id)).events.filter(e => e.type.startsWith('skill.'))
      assert.equal(events.some(e => e.type === 'skill.search' && e.data.signal === 'user_input'), true)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('agent rediscovery runs after a write pivot and updates descriptor context only', async () => {
  const { home, project } = await makeProject()
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'deploy', '---\ndescription: Deploy the application\n---\nDEPLOY_BODY\n')
    await writeSkill(path.join(project, '.termagent', 'skills'), 'db-migration', '---\ndescription: Review database migrations\n---\nDB_BODY\n')
    await withHome(home, async () => {
      const store = new SessionStore(path.join(project, '.sessions'))
      const session = await store.create(project, 'mock')
      const registry = new ToolRegistry(new PermissionGate('auto'))
      builtinTools({ timeout: 5000, maxOutput: 5000 }).filter(t => t.name === 'write_file').forEach(t => registry.add(t))
      skillTools(async (id, event) => { await store.append(id, { type: `skill.${event.action}`, ts: Date.now(), data: event }) }).forEach(t => registry.add(t))
      const provider = mockProvider([
        { call: toolCall('w1', 'write_file', { path: 'db-migration.sql', content: 'create table x;' }) },
        { text: 'done', check(messages) {
          const system = messages.find(m => m.role === 'system')?.content || ''
          assert.match(system, /db-migration/)
          assert.doesNotMatch(system, /DB_BODY/)
        } }
      ])
      const agent = new Agent(provider, registry, store, 3)
      await agent.run({ sessionId: session.id, messages: [], cwd: project, instructions: 'test', prompt: 'deploy the application' })
      const events = (await store.load(session.id)).events.filter(e => e.type === 'skill.search')
      assert.equal(events.some(e => e.data.signal === 'user_input'), true)
      assert.equal(events.some(e => e.data.signal === 'write_pivot'), true)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('agent rediscovery runs after a subagent spawn signal', async () => {
  const { home, project } = await makeProject()
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'parallel-review', '---\ndescription: Review parallel agent results\n---\nBODY\n')
    await withHome(home, async () => {
      const store = new SessionStore(path.join(project, '.sessions'))
      const session = await store.create(project, 'mock')
      const registry = new ToolRegistry(new PermissionGate('auto'))
      registry.add({ name: 'background_agent', risk: 'shell', description: 'fake', schema: { type: 'object' }, async execute() { return { output: 'started' } } })
      skillTools(async (id, event) => { await store.append(id, { type: `skill.${event.action}`, ts: Date.now(), data: event }) }).forEach(t => registry.add(t))
      const provider = mockProvider([
        { call: toolCall('a1', 'background_agent', { prompt: 'parallel review of results' }) },
        { text: 'done', check(messages) {
          const system = messages.find(m => m.role === 'system')?.content || ''
          assert.match(system, /parallel-review/)
          assert.doesNotMatch(system, /BODY/)
        } }
      ])
      const agent = new Agent(provider, registry, store, 3)
      await agent.run({ sessionId: session.id, messages: [], cwd: project, instructions: 'test', prompt: 'prepare the review' })
      const events = (await store.load(session.id)).events.filter(e => e.type === 'skill.search')
      assert.equal(events.some(e => e.data.signal === 'subagent_spawn'), true)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('explicit use_skill loads the body and the agent preserves it without summarizing', async () => {
  const { home, project } = await makeProject()
  try {
    const body = '---\ndescription: Detailed procedure\n---\n' + 'IMPORTANT_LINE\n'.repeat(120)
    await writeSkill(path.join(project, '.termagent', 'skills'), 'procedure', body)
    await withHome(home, async () => {
      const store = new SessionStore(path.join(project, '.sessions'))
      const session = await store.create(project, 'mock')
      const registry = new ToolRegistry(new PermissionGate('auto'))
      skillTools(async (id, event) => { await store.append(id, { type: `skill.${event.action}`, ts: Date.now(), data: event }) }).forEach(t => registry.add(t))
      const provider = mockProvider([
        { call: toolCall('s1', 'use_skill', { name: 'procedure' }) },
        { text: 'done' }
      ])
      const messages=[]
      const agent = new Agent(provider, registry, store, 3)
      await agent.run({ sessionId: session.id, messages, cwd: project, instructions: 'test', prompt: 'follow procedure' })
      const toolMessage = messages.find(m => m.role === 'tool' && m.name === 'use_skill')
      assert.ok(toolMessage)
      assert.ok(toolMessage.content.includes('IMPORTANT_LINE'))
      assert.ok(toolMessage.content.length > 1000)
      assert.equal((await store.load(session.id)).events.some(e => e.type === 'skill.load'), true)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('explicit skill invocation can be suppressed from automatic discovery', async () => {
  const { home, project } = await makeProject()
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'procedure', '---\ndescription: Procedure\n---\nSECRET_SKILL_BODY\n')
    await withHome(home, async () => {
      const store = new SessionStore(path.join(project, '.sessions'))
      const session = await store.create(project, 'mock')
      const registry = new ToolRegistry(new PermissionGate('auto'))
      skillTools().forEach(t => registry.add(t))
      const provider = mockProvider([{ text: 'done', check(messages, schemas) {
        const system = messages.find(m => m.role === 'system')?.content || ''
        assert.match(system, /Explicitly loaded skill: procedure/)
        assert.match(system, /SECRET_SKILL_BODY/)
        assert.equal(schemas.some(x => x.function.name === 'search_skills'), true)
      } }])
      const agent = new Agent(provider, registry, store, 2)
      await agent.run({ sessionId: session.id, messages: [], cwd: project, instructions: 'test', prompt: 'apply it', skillDiscoverySuppressed: true, explicitSkill: { id: 'procedure', content: 'SECRET_SKILL_BODY', sha256: 'sha256:test' } })
      const events = (await store.load(session.id)).events.filter(e => e.type === 'skill.search')
      assert.equal(events.length, 0)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})

test('repeated identical use_skill calls are bounded by the existing loop guard', async () => {
  const { home, project } = await makeProject()
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'repeat', '---\ndescription: Repeat skill\n---\nBODY\n')
    await withHome(home, async () => {
      const store = new SessionStore(path.join(project, '.sessions'))
      const session = await store.create(project, 'mock')
      const registry = new ToolRegistry(new PermissionGate('auto'))
      skillTools().forEach(t => registry.add(t))
      const provider = {
        id:'mock',model:'mock',config:{maxTokens:500},calls:0,
        async *stream(){
          this.calls++
          yield { type:'tool_call', call:toolCall(`u${this.calls}`,'use_skill',{name:'repeat'}) }
          yield { type:'done', finishReason:'tool_calls' }
        }
      }
      const agent = new Agent(provider, registry, store, 0)
      await agent.run({ sessionId: session.id, messages: [], cwd: project, instructions: 'test', prompt: 'repeat the skill' })
      assert.equal(provider.calls, 4)
      assert.equal((await store.load(session.id)).events.some(e => e.type === 'skill.skip' && /loop/i.test(e.data.reason || '')), false)
    })
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) }
})
test('CLI /skill performs exact explicit invocation and suppresses discovery from the skill body', async () => {
  const { home, project } = await makeProject()
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'skill executed' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }) + '\n\n')
      res.end()
    })
  })
  try {
    await writeSkill(path.join(project, '.termagent', 'skills'), 'pr-review', '---\ndescription: Review pull requests\n---\nEXPLICIT_SKILL_MARKER\n')
    await new Promise(resolve => server.listen(0, resolve))
    const port = server.address().port
    const result = await runCli(project, { HOME: home, TERMAGENT_API_KEY: 'test', TERMAGENT_BASE_URL: `http://127.0.0.1:${port}`, TERMAGENT_MODEL: 'mock', TERMAGENT_APPROVALS: 'auto' }, '/skill pr-review review current changes\n/quit\n')
    assert.equal(result.code, 0, result.err)
    assert.match(result.out, /skill executed/)
    assert.equal(requests.length, 1)
    const system = String(requests[0].messages?.[0]?.content || '')
    assert.match(system, /Explicitly loaded skill: pr-review/)
    assert.match(system, /EXPLICIT_SKILL_MARKER/)
    assert.match(system, /automatic skill discovery suppressed/i)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})
