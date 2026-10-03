import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

import {
  createContextBudget,
  allocateContextSections,
  boundToolSchemas,
  estimateMessagesTokens,
  estimateTokens,
  truncateAroundTokenBudget,
} from '../dist/context/budget.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import {
  SkillCatalog,
  loadSkillCatalog,
  getSkillCatalogStats,
} from '../dist/skills/catalog.js'
import { clearSkillSearchCaches, searchSkills } from '../dist/skills/discovery.js'
import { skillTools } from '../dist/tools/skills.js'
import { discoverPluginPackages } from '../dist/plugins/registry.js'

async function temp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeSkill(root, name, body = 'Use this skill when requested.\n## Procedure\nPerform the documented procedure carefully.\n') {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\ndescription: Skill ${name}\n---\n${body}`, 'utf8')
}

async function withHome(home, fn) {
  const old = process.env.HOME
  process.env.HOME = home
  try { return await fn() } finally {
    if (old === undefined) delete process.env.HOME
    else process.env.HOME = old
  }
}

test('phase 9: context budget allocates room for descriptors and explicit skill bodies without exceeding the section budget', () => {
  const budget = createContextBudget({ maxContextTokens: 12000, maxOutputTokens: 2000, threshold: 0.82, reserveTokens: 512 })
  const sections = allocateContextSections(budget.usableTokens, { explicitSkill: true })
  assert.ok(sections.skillDescriptors > 0)
  assert.ok(sections.explicitSkill > 0)
  assert.ok(sections.instructions > 0)
  assert.ok(sections.repository > 0)
  const sum = sections.instructions + sections.repository + sections.skillDescriptors + sections.explicitSkill
  assert.ok(sum <= Math.max(128, budget.usableTokens))

  const longSkill = 'IMPORTANT_STEP '.repeat(4000)
  const bounded = truncateAroundTokenBudget(longSkill, sections.explicitSkill)
  assert.ok(estimateTokens(bounded) <= sections.explicitSkill)
  assert.match(bounded, /truncated to fit context budget; middle omitted/)
})

test('phase 9: tool schemas are bounded while required properties remain intact', () => {
  const tools = Array.from({ length: 18 }, (_, i) => ({
    type: 'function',
    function: {
      name: `plugin_tool_${i}`,
      description: `Long plugin description ${'details '.repeat(250)}`,
      parameters: {
        type: 'object',
        properties: {
          required_value: { type: 'string', description: 'A required value ' + 'x'.repeat(500) },
          optional_a: { type: 'string', description: 'Optional ' + 'y'.repeat(900) },
          optional_b: { type: 'string', description: 'Optional ' + 'z'.repeat(900) },
        },
        required: ['required_value'],
      },
    },
  }))
  const bounded = boundToolSchemas(tools, 2200)
  assert.ok(bounded.originalTokens > bounded.estimatedTokens)
  assert.ok(bounded.estimatedTokens <= 2200)
  assert.ok(bounded.tools.length > 0)
  for (const tool of bounded.tools) {
    const required = tool.function.parameters.required || []
    const properties = tool.function.parameters.properties || {}
    for (const key of required) assert.ok(Object.hasOwn(properties, key), `${tool.function.name} lost required property ${key}`)
  }

  const catastrophic = [{
    type: 'function',
    function: { name: 'catastrophic', description: 'x'.repeat(50000), parameters: { type: 'object' } },
  }]
  const rejected = boundToolSchemas(catastrophic, 1000)
  assert.deepEqual(rejected.tools, [])
})

test('phase 9: tool schema rendering is cached across turns and invalidated only when the registry changes', () => {
  const registry = new ToolRegistry(new PermissionGate('auto'))
  registry.add({ name: 'read_file', description: 'Read files', risk: 'read', schema: { type: 'object' }, execute: async () => ({ output: 'ok' }) })
  const first = registry.schemas()
  const second = registry.schemas()
  assert.equal(first, second)

  registry.add({ name: 'grep', description: 'Search', risk: 'read', schema: { type: 'object' }, execute: async () => ({ output: 'ok' }) })
  const third = registry.schemas()
  assert.notEqual(third, first)
  assert.equal(third.length, 2)
})

test('phase 9: 10/100/1000 skill catalogs warm without re-reading bodies', async () => {
  const home = await temp('termagent-p9-home-')
  const project = await temp('termagent-p9-skills-')
  try {
    await withHome(home, async () => {
      for (const count of [10, 100, 1000]) {
        SkillCatalog.clear()
        clearSkillSearchCaches()
        const skillsRoot = path.join(project, '.termagent', 'skills')
        await fs.rm(skillsRoot, { recursive: true, force: true })
        await fs.mkdir(skillsRoot, { recursive: true })
        for (let i = 0; i < count; i++) await writeSkill(skillsRoot, `skill-${count}-${i}`)

        const coldStart = Date.now()
        const cold = await SkillCatalog.build(project)
        const coldElapsed = Date.now() - coldStart
        assert.equal(cold.list().length, count)

        const afterCold = getSkillCatalogStats()
        assert.equal(afterCold.parsedFiles, count)

        const warmStart = Date.now()
        const warm = await loadSkillCatalog(project)
        const warmElapsed = Date.now() - warmStart
        assert.equal(warm.list().length, count)

        const afterWarm = getSkillCatalogStats()
        assert.equal(afterWarm.parsedFiles, 0)
        assert.equal(afterWarm.reusedFiles, count)
        assert.ok(warm.generation === cold.generation)
        assert.ok(warmElapsed <= Math.max(2000, coldElapsed * 6 + 250), `warm ${count}: ${warmElapsed}ms vs cold ${coldElapsed}ms`)
      }
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(project, { recursive: true, force: true })
  }
})

test('phase 9: concurrent catalog requests collapse into one build', async () => {
  const home = await temp('termagent-p9-concurrency-home-')
  const project = await temp('termagent-p9-concurrency-')
  try {
    await withHome(home, async () => {
      SkillCatalog.clear()
      const root = path.join(project, '.termagent', 'skills')
      for (let i = 0; i < 80; i++) await writeSkill(root, `concurrent-${i}`)
      const before = getSkillCatalogStats().builds
      const catalogs = await Promise.all(Array.from({ length: 8 }, () => loadSkillCatalog(project)))
      assert.equal(new Set(catalogs.map(c => c.generation)).size, 1)
      assert.equal(getSkillCatalogStats().builds - before, 1)
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(project, { recursive: true, force: true })
  }
})

test('phase 9: a changed skill invalidates the descriptor generation and search cache', async () => {
  const home = await temp('termagent-p9-invalidate-home-')
  const project = await temp('termagent-p9-invalidate-')
  try {
    await withHome(home, async () => {
      SkillCatalog.clear()
      clearSkillSearchCaches()
      await writeSkill(path.join(project, '.termagent', 'skills'), 'deploy', '---\ndescription: Deploy applications\n---\n\n## Procedure\nDeploy carefully.\n')
      const first = await searchSkills(project, 'deploy')
      assert.equal(first[0]?.id, 'deploy')
      const catalog1 = await loadSkillCatalog(project)
      const details = catalog1.get('deploy')
      assert.ok(details)
      await new Promise(resolve => setTimeout(resolve, 10))
      await fs.writeFile(details.path, '---\ndescription: Database migrations\n---\n\n## Procedure\nReview migration files.\n', 'utf8')
      const second = await searchSkills(project, 'database')
      assert.equal(second[0]?.id, 'deploy')
      const catalog2 = await loadSkillCatalog(project)
      assert.ok(catalog2.generation > catalog1.generation)
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(project, { recursive: true, force: true })
  }
})

test('phase 9: bounded use_skill output preserves both beginning and ending sections before provider requests', async () => {
  const home = await temp('termagent-p9-skill-home-')
  const project = await temp('termagent-p9-skill-body-')
  try {
    await withHome(home, async () => {
      const root = path.join(project, '.termagent', 'skills')
      await writeSkill(root, 'large', '---\ndescription: Large procedure\n---\n\n## Procedure\nBEGIN_MARKER\n' + 'middle '.repeat(6000) + '\nEND_MARKER\n')
      const [tool] = skillTools(undefined, { maxBodyTokens: 700 }).filter(t => t.name === 'use_skill')
      const result = await tool.execute({ name: 'large' }, { sessionID: 's', agent: 'build', cwd: project, abort: new AbortController().signal })
      assert.ok(estimateTokens(result.output) <= 700)
      assert.match(result.output, /BEGIN_MARKER/)
      assert.match(result.output, /END_MARKER/)
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(project, { recursive: true, force: true })
  }
})

test('phase 9: large plugin catalogs are bounded by direct-child discovery rather than recursive explosion', async () => {
  const home = await temp('termagent-p9-plugin-home-')
  const project = await temp('termagent-p9-plugin-catalog-')
  try {
    await withHome(home, async () => {
      const root = path.join(project, '.termagent', 'plugins')
      await fs.mkdir(root, { recursive: true })
      for (let i = 0; i < 300; i++) {
        const pluginRoot = path.join(root, `plugin-${i}`)
        await fs.mkdir(path.join(pluginRoot, '.termagent-plugin'), { recursive: true })
        await fs.writeFile(path.join(pluginRoot, '.termagent-plugin', 'plugin.json'), JSON.stringify({ name: `plugin-${i}`, version: '1.0.0' }), 'utf8')
        await fs.mkdir(path.join(pluginRoot, 'nested', 'ignored'), { recursive: true })
      }
      const start = Date.now()
      const result = await discoverPluginPackages(project)
      const elapsed = Date.now() - start
      assert.equal(result.errors.length, 0)
      assert.equal(result.packages.length, 300)
      assert.ok(elapsed < 10000, `plugin catalog discovery took ${elapsed}ms`)
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(project, { recursive: true, force: true })
  }
})
test('phase 9: discovered skill descriptors are counted inside the provider request budget', async () => {
  const home = await temp('termagent-p9-agent-home-')
  const project = await temp('termagent-p9-agent-context-')
  try {
    await withHome(home, async () => {
      const root = path.join(project, '.termagent', 'skills')
      for (let i = 0; i < 120; i++) {
        await writeSkill(root, `deployment-${i}`, '\n## Procedure\nDeploy the application and verify the release result.\n')
      }

      const { Agent } = await import('../dist/agent/agent.js')
      const { SessionStore } = await import('../dist/session/store.js')
      const store = new SessionStore(path.join(project, '.sessions'))
      const session = await store.create(project, 'mock')
      const registry = new ToolRegistry(new PermissionGate('auto'))
      skillTools().forEach(tool => registry.add(tool))
      const observed = []
      const provider = {
        id: 'mock', model: 'mock', config: { maxTokens: 500 },
        async *stream(messages, tools) {
          observed.push({ messages: structuredClone(messages), tools: structuredClone(tools) })
          yield { type: 'text', delta: 'done' }
          yield { type: 'done', finishReason: 'stop' }
        },
      }
      const agent = new Agent(provider, registry, store, 1, 3500, 1)
      await agent.run({ sessionId: session.id, messages: [], cwd: project, instructions: 'Keep deployment work bounded and verified.', prompt: 'deployment' })

      assert.equal(observed.length, 1)
      const request = observed[0]
      const requestTokens = estimateMessagesTokens(request.messages) + estimateTokens(request.tools)
      const budget = createContextBudget({ maxContextTokens: 3500, maxOutputTokens: 500 })
      assert.ok(requestTokens <= budget.usableTokens, `request ${requestTokens} > usable ${budget.usableTokens}`)
      const system = request.messages.find(m => m.role === 'system')?.content || ''
      assert.match(system, /Relevant skills \(descriptors only\)/)
      assert.match(system, /deployment-\d+/)
      assert.doesNotMatch(system, /Deploy the application and verify the release result\./)
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(project, { recursive: true, force: true })
  }
})

test('phase 9: project cache stays bounded to protect long-lived low-memory processes', async () => {
  const home = await temp('termagent-p9-eviction-home-')
  try {
    await withHome(home, async () => {
      SkillCatalog.clear()
      for (let i = 0; i < 12; i++) {
        const project = await temp(`termagent-p9-cache-project-${i}-`)
        const root = path.join(project, '.termagent', 'skills')
        await writeSkill(root, `cache-${i}`)
        await loadSkillCatalog(project)
        await fs.rm(project, { recursive: true, force: true })
      }
      assert.ok(getSkillCatalogStats().cachedProjects <= 8)
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
