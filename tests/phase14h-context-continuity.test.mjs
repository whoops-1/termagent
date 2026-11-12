import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import crypto from 'node:crypto'

const temp = (prefix = 'termagent-14h-') => fs.mkdtemp(path.join(os.tmpdir(), prefix))
const signal = new AbortController().signal
const toolContext = (cwd, readFileState) => ({
  sessionID: 'phase14h',
  agent: 'build',
  cwd,
  abort: signal,
  readFileState,
})

async function readTool() {
  const { builtinTools } = await import('../dist/tools/builtin.js')
  return builtinTools({ timeout: 5000, maxOutput: 100_000 }).find(tool => tool.name === 'read_file')
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

test('14H restores durable read coverage into a fresh cache and rehydrates the exact range', async () => {
  const { FileReadStateCache } = await import('../dist/tools/file-state.js')
  const root = await temp()
  try {
    const file = path.join(root, 'src', 'module.ts')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const content = Array.from({ length: 80 }, (_, index) => `export const value${index + 1} = ${index + 1};`).join('\r\n') + '\r\n'
    await fs.writeFile(file, content)

    const originalCache = new FileReadStateCache()
    const tool = await readTool()
    const first = await tool.execute({ path: 'src/module.ts', startLine: 21, endLine: 34 }, toolContext(root, originalCache))
    assert.equal(first.metadata.cache, 'miss')

    const durableCoverage = originalCache.contextSnapshot(64)
    assert.equal(durableCoverage.length, 1)
    assert.deepEqual(durableCoverage[0].ranges, [{ startLine: 21, endLine: 34 }])

    // A new Agent.run() receives a new in-memory cache. The persisted machine
    // state must repopulate it instead of making the model read the range again.
    const recoveredCache = new FileReadStateCache()
    const restored = await recoveredCache.restoreCoverage(durableCoverage, { cwd: root })
    assert.deepEqual(restored, {
      restoredFiles: 1,
      restoredRanges: 1,
      restoredBytes: Buffer.byteLength(content.split('\r\n').slice(20, 34).join('\n')),
      skipped: 0,
    })

    const rehydrated = await tool.execute({ path: 'src/module.ts', startLine: 21, endLine: 34 }, toolContext(root, recoveredCache))
    assert.equal(rehydrated.metadata.cache, 'rehydrated')
    assert.match(rehydrated.output, /21: export const value21 = 21;/)
    assert.match(rehydrated.output, /34: export const value34 = 34;/)

    const duplicate = await tool.execute({ path: 'src/module.ts', startLine: 21, endLine: 34 }, toolContext(root, recoveredCache))
    assert.equal(duplicate.metadata.cache, 'unchanged')
    assert.doesNotMatch(duplicate.output, /export const value21/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H refuses to restore read coverage when file content changed but size and mtime were preserved', async () => {
  const { FileReadStateCache } = await import('../dist/tools/file-state.js')
  const root = await temp()
  try {
    const file = path.join(root, 'src', 'stable-size.ts')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const original = 'export const name = "alpha";\nexport const count = 2;\n'
    await fs.writeFile(file, original)
    const before = await fs.stat(file)

    const coverage = [{
      canonicalPath: file,
      mtimeMs: before.mtimeMs,
      size: before.size,
      totalLines: 2,
      contentHash: hash(original),
      ranges: [{ startLine: 1, endLine: 2 }],
    }]

    const changed = original.replace('alpha', 'bravo')
    assert.equal(Buffer.byteLength(changed), before.size)
    await fs.writeFile(file, changed)
    await fs.utimes(file, before.atime, before.mtime)

    const recoveredCache = new FileReadStateCache()
    const restored = await recoveredCache.restoreCoverage(coverage, { cwd: root })
    assert.equal(restored.restoredRanges, 0)
    assert.equal(restored.skipped, 1)
    assert.equal(recoveredCache.stats().entries, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H does not restore persisted read coverage outside the active worker scope or through an escaping symlink', async () => {
  const { FileReadStateCache } = await import('../dist/tools/file-state.js')
  const root = await temp()
  const external = await temp('termagent-14h-external-')
  try {
    const scope = path.join(root, 'packages', 'allowed')
    const outside = path.join(root, 'packages', 'private', 'secret.ts')
    await fs.mkdir(scope, { recursive: true })
    await fs.mkdir(path.dirname(outside), { recursive: true })
    await fs.writeFile(outside, 'export const secret = true;\n')
    const outsideStat = await fs.stat(outside)

    const escapingLink = path.join(scope, 'linked-secret.ts')
    try {
      await fs.symlink(outside, escapingLink)
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return
      throw error
    }
    const externalFile = path.join(external, 'outside.ts')
    await fs.writeFile(externalFile, 'export const outside = true;\n')
    const externalStat = await fs.stat(externalFile)

    const records = [
      {
        canonicalPath: outside,
        mtimeMs: outsideStat.mtimeMs,
        size: outsideStat.size,
        totalLines: 1,
        contentHash: hash('export const secret = true;\n'),
        ranges: [{ startLine: 1, endLine: 1 }],
      },
      {
        canonicalPath: escapingLink,
        mtimeMs: outsideStat.mtimeMs,
        size: outsideStat.size,
        totalLines: 1,
        contentHash: hash('export const secret = true;\n'),
        ranges: [{ startLine: 1, endLine: 1 }],
      },
      {
        canonicalPath: externalFile,
        mtimeMs: externalStat.mtimeMs,
        size: externalStat.size,
        totalLines: 1,
        contentHash: hash('export const outside = true;\n'),
        ranges: [{ startLine: 1, endLine: 1 }],
      },
    ]

    const recoveredCache = new FileReadStateCache()
    const restored = await recoveredCache.restoreCoverage(records, {
      cwd: root,
      scopePaths: ['packages/allowed'],
    })
    assert.equal(restored.restoredFiles, 0)
    assert.equal(restored.restoredRanges, 0)
    assert.equal(restored.skipped, 3)
    assert.equal(recoveredCache.stats().entries, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(external, { recursive: true, force: true })
  }
})

test('14H context and repository allocations scale with verified model windows without a 12K sample ceiling', async () => {
  const { createContextBudget, deriveRepositoryContextBudget } = await import('../dist/context/budget.js')
  const { resolveContextLimits } = await import('../dist/context/model-limits.js')

  const small = createContextBudget({ maxContextTokens: 128_000 })
  const large = createContextBudget({ maxContextTokens: 1_000_000 })
  assert.ok(large.usableTokens > small.usableTokens * 5)
  assert.ok(large.recentTokens > small.recentTokens)

  const smallRepo = deriveRepositoryContextBudget(128_000, { repositoryFiles: 20_000 })
  const largeRepo = deriveRepositoryContextBudget(1_000_000, { repositoryFiles: 20_000 })
  assert.ok(largeRepo.mapTokens >= smallRepo.mapTokens)
  assert.ok(largeRepo.retrievalTokens >= smallRepo.retrievalTokens)
  assert.ok(largeRepo.mapTokens <= 64_000)
  assert.ok(largeRepo.retrievalTokens <= 48_000)

  const route = resolveContextLimits({ providerConfig: {
    provider: 'example',
    model: 'example-large',
    baseUrl: 'https://api.example.test/v1',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  } })
  assert.equal(route.contextWindow, 1_000_000)
  assert.equal(route.contextSource, 'provider-profile')
  assert.equal(route.maxOutputTokens, 64_000)

  const sample = JSON.parse(await fs.readFile(new URL('../.termagent-example.json', import.meta.url), 'utf8'))
  assert.equal(Object.hasOwn(sample, 'maxContextTokens'), false)
})

test('14H safely skips oversized lines without shifting later line numbers', async () => {
  const { FileReadStateCache } = await import('../dist/tools/file-state.js')
  const root = await temp()
  try {
    const file = path.join(root, 'generated', 'large-line.txt')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const content = `${'x'.repeat(300 * 1024)}\nexport const target = true;\n`
    await fs.writeFile(file, content)
    const stat = await fs.stat(file)
    const coverage = [{
      canonicalPath: file,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      totalLines: 2,
      contentHash: hash(content),
      ranges: [{ startLine: 2, endLine: 2 }],
    }]

    const recoveredCache = new FileReadStateCache()
    const restored = await recoveredCache.restoreCoverage(coverage, { cwd: root })
    assert.equal(restored.restoredFiles, 1)
    assert.equal(restored.restoredRanges, 1)
    assert.equal(restored.skipped, 0)

    const tool = await readTool()
    const result = await tool.execute({ path: 'generated/large-line.txt', startLine: 2, endLine: 2 }, toolContext(root, recoveredCache))
    assert.equal(result.metadata.cache, 'rehydrated')
    assert.match(result.output, /2: export const target = true;/)
    assert.doesNotMatch(result.output, /1: x{20}/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H rejects oversized persisted files before scanning them', async () => {
  const { FileReadStateCache } = await import('../dist/tools/file-state.js')
  const root = await temp()
  try {
    const file = path.join(root, 'large.bin')
    const handle = await fs.open(file, 'w')
    try { await handle.truncate(33 * 1024 * 1024) } finally { await handle.close() }
    const stat = await fs.stat(file)
    const recoveredCache = new FileReadStateCache()
    const restored = await recoveredCache.restoreCoverage([{
      canonicalPath: file,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      totalLines: 1,
      contentHash: hash('unused'),
      ranges: [{ startLine: 1, endLine: 1 }],
    }], { cwd: root })
    assert.equal(restored.restoredFiles, 0)
    assert.equal(restored.skipped, 1)
    assert.equal(recoveredCache.stats().entries, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H restores read coverage into a new Agent.run turn and supplies the evidence before the repeated read', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const { builtinTools } = await import('../dist/tools/builtin.js')
  const root = await temp()
  try {
    await fs.writeFile(path.join(root, 'continuity.ts'), 'export const first = 1;\nexport const second = 2;\n')
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-continuity')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    builtinTools({ timeout: 5000, maxOutput: 100_000 }).forEach(tool => registry.add(tool))

    class Provider {
      id = 'mock'
      model = 'mock-large'
      config = { provider: 'mock', model: 'mock-large', baseUrl: 'https://mock.invalid/v1', contextWindow: 256_000 }
      calls = 0
      requests = []
      async *stream(messages) {
        this.calls++
        this.requests.push(messages.map(message => ({ ...message })))
        if (this.calls === 1 || this.calls === 3) {
          yield { type: 'tool_call', call: { id: `read-${this.calls}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'continuity.ts', startLine: 1, endLine: 2 }) } } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'completed' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }

    const provider = new Provider()
    const agent = new Agent(provider, registry, store, 4, 0, 1)
    const firstReads = []
    await agent.run({ sessionId: session.id, messages: [], cwd: root, instructions: '', prompt: 'inspect continuity.ts', onToolResult: (name, output, metadata) => { if (name === 'read_file') firstReads.push(metadata) } })
    assert.equal(firstReads[0]?.cache, 'miss')

    const secondReads = []
    await agent.run({ sessionId: session.id, messages: [], cwd: root, instructions: '', prompt: 'use what you already learned from continuity.ts', onToolResult: (name, output, metadata) => { if (name === 'read_file') secondReads.push(metadata) } })
    assert.equal(secondReads.length, 1)
    assert.equal(secondReads[0]?.cache, 'unchanged')
    assert.ok(provider.requests[2].some(message => typeof message.content === 'string' && message.content.includes('continuity.ts#L1-2')))
    assert.ok(provider.requests[2].some(message => typeof message.content === 'string' && message.content.includes('export const second = 2;')))

    const loaded = await store.load(session.id)
    const checkpoint = await store.latestContextCheckpoint(session.id)
    assert.ok(checkpoint?.machineState?.readCoverage?.some(item => item.canonicalPath.endsWith('continuity.ts')))
    assert.ok(loaded.events.some(event => event.type === 'context.checkpoint'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H hierarchical instruction loading adds only the touched subtree and safely restores prior instruction paths', async () => {
  const { loadInstructionFiles, loadScopedInstructionFiles, loadInstructionPaths } = await import('../dist/context/instructions.js')
  const root = await temp()
  const external = await temp('termagent-14h-instruction-external-')
  try {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Repository-wide rules: preserve backwards compatibility.\n')
    const feature = path.join(root, 'packages', 'feature')
    const sibling = path.join(root, 'packages', 'other')
    await fs.mkdir(path.join(feature, 'src'), { recursive: true })
    await fs.mkdir(sibling, { recursive: true })
    const featureInstruction = path.join(feature, 'AGENTS.md')
    const siblingInstruction = path.join(sibling, 'AGENTS.md')
    await fs.writeFile(featureInstruction, 'Feature rules: keep this package server-rendered.\n')
    await fs.writeFile(siblingInstruction, 'Other package rules: unrelated.\n')
    const externalInstruction = path.join(external, 'AGENTS.md')
    await fs.writeFile(externalInstruction, 'External instructions must never enter this workspace.\n')

    const base = await loadInstructionFiles(root)
    assert.ok(base.files.some(file => file.path.endsWith(`${path.sep}AGENTS.md`)))
    assert.equal(base.files.some(file => file.path === featureInstruction), false)

    const scoped = await loadScopedInstructionFiles(root, ['packages/feature/src/module.ts'])
    assert.ok(scoped.files.some(file => file.path === featureInstruction))
    assert.equal(scoped.files.some(file => file.path === siblingInstruction), false)

    const restored = await loadInstructionPaths(root, [featureInstruction, externalInstruction])
    assert.ok(restored.files.some(file => file.path === featureInstruction))
    assert.equal(restored.files.some(file => file.path === externalInstruction), false)

    const escaping = path.join(feature, 'nested-escape')
    try {
      await fs.symlink(external, escaping, 'dir')
      const escaped = await loadScopedInstructionFiles(root, ['packages/feature/nested-escape/AGENTS.md'])
      assert.equal(escaped.files.some(file => file.path === externalInstruction), false)
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(external, { recursive: true, force: true })
  }
})

test('14H restores nested instructions across Agent.run restarts and reloads changed content without leaking siblings', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const { builtinTools } = await import('../dist/tools/builtin.js')
  const root = await temp()
  try {
    const feature = path.join(root, 'packages', 'feature')
    const sibling = path.join(root, 'packages', 'sibling')
    await fs.mkdir(path.join(feature, 'src'), { recursive: true })
    await fs.mkdir(sibling, { recursive: true })
    await fs.writeFile(path.join(feature, 'AGENTS.md'), 'Feature rule v1: preserve the public API.\n')
    await fs.writeFile(path.join(sibling, 'AGENTS.md'), 'Sibling-only rule: never enter the feature prompt.\n')
    await fs.writeFile(path.join(feature, 'src', 'module.ts'), 'export const value = 42;\n')

    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-nested-instructions')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    builtinTools({ timeout: 5000, maxOutput: 100_000 }).forEach(tool => registry.add(tool))

    class Provider {
      id = 'mock'
      model = 'mock-large'
      config = { provider: 'mock', model: 'mock-large', baseUrl: 'https://mock.invalid/v1', contextWindow: 256_000 }
      calls = 0
      requests = []
      async *stream(messages) {
        this.calls++
        this.requests.push(messages.map(message => ({ ...message })))
        if (this.calls === 1 || this.calls === 2) {
          yield { type: 'tool_call', call: {
            id: `nested-read-${this.calls}`,
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'packages/feature/src/module.ts', startLine: 1, endLine: 1 }) },
          } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'continued with scoped instructions' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }

    const provider = new Provider()
    const agent = new Agent(provider, registry, store, 4, 0, 1)
    await agent.run({ sessionId: session.id, messages: [], cwd: root, instructions: '', prompt: 'inspect the feature module' })

    const loaded = await store.load(session.id)
    const instructionEvent = loaded.events.find(event => event.type === 'context.instructions' && event.data?.files?.some(file => file.path.endsWith(`${path.sep}packages${path.sep}feature${path.sep}AGENTS.md`)))
    assert.ok(instructionEvent, 'nested instruction discovery should be persisted as a durable session event')
    assert.ok(provider.requests[1].some(message => message.role === 'system' && message.content.includes('Feature rule v1: preserve the public API.')))
    assert.ok(provider.requests[1].every(message => typeof message.content !== 'string' || !message.content.includes('Sibling-only rule')))

    // A fresh Agent.run must recover the previously discovered path from the
    // durable event log, not rely on the first Agent instance's in-memory map.
    await fs.writeFile(path.join(feature, 'AGENTS.md'), 'Feature rule v2: preserve the new API contract.\n')
    await agent.run({ sessionId: session.id, messages: [], cwd: root, instructions: '', prompt: 'continue the feature task' })
    const restartedRequest = provider.requests[3]
    const restartedSystem = restartedRequest.find(message => message.role === 'system')?.content || ''
    assert.match(restartedSystem, /Feature rule v2: preserve the new API contract\./)
    assert.doesNotMatch(restartedSystem, /Feature rule v1: preserve the public API\./)
    assert.doesNotMatch(restartedSystem, /Sibling-only rule/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H restores previously loaded skills by ID and digest into a fresh Agent.run prompt', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const { loadSkill } = await import('../dist/skills/invoker.js')
  const root = await temp()
  try {
    const skillPath = path.join(root, '.termagent', 'skills', 'context-keeper', 'SKILL.md')
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.writeFile(skillPath, [
      '---',
      'name: context-keeper',
      'description: Preserve important repository facts across coding-agent turns.',
      '---',
      '# Context keeper',
      'When continuing a task, reuse verified file paths and decisions already established.',
      'Do not repeat broad repository scans unless the working tree or task scope changed.',
      '',
    ].join('\n'))
    const skill = await loadSkill(root, 'context-keeper')
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-skill')
    await store.append(session.id, { type: 'skill.load', ts: Date.now(), data: { action: 'load', id: skill.descriptor.id, sha256: skill.sha256, path: skill.path, source: 'test-fixture' } })

    class Provider {
      id = 'mock'
      model = 'mock-large'
      config = { provider: 'mock', model: 'mock-large', baseUrl: 'https://mock.invalid/v1', contextWindow: 256_000 }
      request = []
      async *stream(messages) {
        this.request = messages.map(message => ({ ...message }))
        yield { type: 'text', delta: 'continued' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
    const provider = new Provider()
    const agent = new Agent(provider, new ToolRegistry(new PermissionGate('auto')), store, 2, 0, 1)
    await agent.run({ sessionId: session.id, messages: [], cwd: root, instructions: '', prompt: 'continue implementation' })

    const systemPrompt = provider.request.find(message => message.role === 'system')?.content || ''
    assert.match(systemPrompt, /<restored_skill id="context-keeper">/)
    assert.match(systemPrompt, /Do not repeat broad repository scans unless the working tree or task scope changed\./)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H context limit resolution honors explicit overrides, provider metadata, adapter output caps, and conservative unknown-model fallback', async () => {
  const { resolveContextLimits, CONSERVATIVE_CONTEXT_WINDOW } = await import('../dist/context/model-limits.js')
  const metadata = resolveContextLimits({ providerConfig: {
    provider: 'gateway', model: 'vendor/model-1m', baseUrl: 'https://gateway.example/v1',
    extra: { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  } })
  assert.equal(metadata.contextWindow, 1_000_000)
  assert.equal(metadata.contextSource, 'provider-metadata')
  assert.equal(metadata.maxOutputTokens, 64_000)
  assert.equal(metadata.outputSource, 'provider-metadata')

  const explicit = resolveContextLimits({
    providerConfig: { provider: 'gateway', model: 'vendor/model-1m', baseUrl: 'https://gateway.example/v1', contextWindow: 1_000_000 },
    configuredContextWindow: 256_000,
  })
  assert.equal(explicit.contextWindow, 256_000)
  assert.equal(explicit.contextSource, 'user-config')

  const adapter = resolveContextLimits({ providerConfig: {
    provider: 'compatible', model: 'unknown-model', baseUrl: 'https://compatible.example/v1', maxTokens: 8192,
  } })
  assert.equal(adapter.contextWindow, CONSERVATIVE_CONTEXT_WINDOW)
  assert.equal(adapter.contextSource, 'conservative-fallback')
  assert.equal(adapter.maxOutputTokens, 8192)
  assert.equal(adapter.outputSource, 'adapter-config')
})

test('14H provider-reported cache tokens are included in current request context occupancy', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const root = await temp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-usage')
    class Provider {
      id = 'anthropic'
      model = 'mock'
      config = { provider: 'anthropic', model: 'mock', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'do-not-persist-secret', contextWindow: 200_000 }
      async *stream() {
        yield { type: 'usage', usage: { inputTokens: 100, contextTokens: 110, outputTokens: 10, totalTokens: 135, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 3, cacheTokensExcludedFromInput: true, modalityTokens: { prompt: { text: 90, image: 10 }, cached: { text: 20 }, unexpected: { secret: 7 } } } }
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
    const usage = []
    const agent = new Agent(new Provider(), new ToolRegistry(new PermissionGate('auto')), store, 2, 0, 1)
    await agent.run({ sessionId: session.id, messages: [], cwd: root, instructions: '', prompt: 'continue', onUsage: value => usage.push(value) })
    assert.equal(usage.length, 1)
    assert.equal(usage[0].inputTokens, 125)
    assert.equal(usage[0].contextTokens, 110)
    assert.ok(usage[0].estimateRequestTokens >= usage[0].estimateInputTokens, 'the durable report must preserve the full request footprint')
    assert.equal(usage[0].nonCachedInputTokens, 100)
    assert.equal(usage[0].outputTokens, 10)
    assert.equal(usage[0].totalTokens, 135, 'reported inclusive totals must not have cache counts added a second time')
    assert.equal(usage[0].reasoningTokens, 3)
    assert.equal(usage[0].cacheReadTokens, 20)
    assert.equal(usage[0].cacheWriteTokens, 5)
    const loaded = await store.load(session.id)
    const durableUsage = loaded.events.filter(event => event.type === 'provider.usage')
    assert.equal(durableUsage.length, 1)
    assert.equal(durableUsage[0].kind, 'session.provider.usage')
    assert.equal(durableUsage[0].category, 'provider')
    assert.equal(durableUsage[0].durable, true)
    const { knownEventDurability } = await import('../dist/protocol/types.js')
    assert.equal(knownEventDurability('session.provider.usage'), 'durable')
    assert.equal(durableUsage[0].data.turnId, loaded.events.find(event => event.type === 'turn' && event.data?.status === 'started')?.data.id)
    assert.deepEqual(durableUsage[0].data.modalityTokens, { prompt: { text: 90, image: 10 }, cached: { text: 20 } })
    assert.equal(loaded.messages.some(message => message.role === 'provider'), false, 'usage events stay outside the conversation projection')
    const rawSession = await fs.readFile(store.file(session.id), 'utf8')
    assert.doesNotMatch(rawSession, /do-not-persist-secret/)
    const { latestProviderUsageFromEvents } = await import('../dist/providers/types.js')
    assert.deepEqual(latestProviderUsageFromEvents(loaded.events), usage[0])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H discards usage telemetry from a failed provider attempt before retrying', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const root = await temp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-retry-usage')
    class Provider {
      id = 'retry-provider'
      model = 'mock'
      config = { provider: 'retry-provider', model: 'mock', baseUrl: 'https://provider.test/v1', contextWindow: 128_000 }
      attempts = 0
      async *stream() {
        this.attempts += 1
        if (this.attempts === 1) {
          yield { type: 'usage', usage: { inputTokens: 90_000, outputTokens: 5_000, totalTokens: 95_000 } }
          const error = new Error('temporary upstream failure')
          error.status = 503
          throw error
        }
        yield { type: 'text', delta: 'recovered' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
    const provider = new Provider()
    const usage = []
    const agent = new Agent(provider, new ToolRegistry(new PermissionGate('auto')), store, 2, 0, 2)
    await agent.run({ sessionId: session.id, messages: [], cwd: root, instructions: '', prompt: 'continue', onUsage: value => usage.push(value) })
    assert.equal(provider.attempts, 2)
    assert.equal(usage.length, 1)
    assert.equal(usage[0].estimated, true, 'the retry did not return usage, so the failed attempt must not be presented as the successful request')
    assert.equal(usage[0].inputTokens, usage[0].estimateInputTokens)
    assert.notEqual(usage[0].inputTokens, 90_000)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})


test('14H restores the latest valid provider usage report and rejects untrusted telemetry fields', async () => {
  const { latestProviderUsageFromEvents } = await import('../dist/providers/types.js')
  const events = [
    { type: 'provider.usage', ts: 100, data: {
      inputTokens: 10, nonCachedInputTokens: 8, outputTokens: 2, totalTokens: 12,
      contextWindow: 128_000, contextSource: 'provider-profile', provider: 'mock', model: 'model-a',
      estimateInputTokens: 9, estimateRequestTokens: 13, estimated: false, contextSource: 'provider\nprofile', modalityTokens: {
        prompt: { text: 8, image: -1, 'bad key!': 3, ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field${index}`, index + 1])) },
        rogue: { leaked: 4 },
      },
    } },
    { type: 'provider.usage', ts: 200, data: { inputTokens: 'invalid' } },
  ]
  const restored = latestProviderUsageFromEvents(events)
  assert.equal(restored.recordedAt, 100)
  assert.deepEqual(restored.modalityTokens, { prompt: { text: 8, field0: 1, field1: 2, field2: 3, field3: 4, field4: 5, field5: 6, field6: 7, field7: 8, field8: 9, field9: 10, field10: 11 } })
  assert.equal(restored.contextSource, 'provider profile')
  assert.equal(restored.inputTokens, 10)
  assert.equal(restored.estimateRequestTokens, 13)
  assert.equal(restored.estimated, false)
  const boundedDate = latestProviderUsageFromEvents([{ type: 'provider.usage', ts: 9_007_199_254_740_991, data: { inputTokens: 1, nonCachedInputTokens: 1, outputTokens: 0, totalTokens: 1, contextWindow: 128_000, contextSource: 'fallback', provider: 'mock', model: 'm', estimateInputTokens: 1, recordedAt: 9_007_199_254_740_991 } }])
  assert.equal(boundedDate.recordedAt, 8_640_000_000_000_000)
  assert.equal(Number.isFinite(new Date(boundedDate.recordedAt).getTime()), true)
})

test('14H aggregates durable provider usage without double-counting inclusive cache and reasoning fields', async () => {
  const { aggregateProviderUsageReports, providerUsageReportsFromEvents } = await import('../dist/providers/types.js')
  const events = [
    { type: 'provider.usage', ts: 100, data: {
      inputTokens: 125, contextTokens: 110, nonCachedInputTokens: 100, outputTokens: 10, totalTokens: 135,
      estimated: false, contextWindow: 200_000, contextSource: 'provider-profile', provider: 'anthropic', model: 'sonnet',
      cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 3, toolUsePromptTokens: 0, estimateInputTokens: 100, driftPercent: 9.1,
    } },
    { type: 'provider.usage', ts: 200, data: {
      inputTokens: 90, contextTokens: 90, nonCachedInputTokens: 80, outputTokens: 5, totalTokens: 95,
      estimated: false, contextWindow: 200_000, contextSource: 'provider-profile', provider: 'anthropic', model: 'sonnet',
      cacheReadTokens: 10, estimateInputTokens: 100, driftPercent: -11.1,
    } },
    { type: 'provider.usage', ts: 300, data: {
      inputTokens: 20, nonCachedInputTokens: 20, outputTokens: 4, totalTokens: 24,
      estimated: true, contextWindow: 128_000, contextSource: 'conservative-fallback', provider: 'openai-compatible', model: 'custom',
      estimateInputTokens: 19,
    } },
    { type: 'provider.usage', ts: 400, data: { inputTokens: 'corrupt' } },
    { type: 'message', ts: 500, data: { inputTokens: 999_999 } },
  ]
  const reports = providerUsageReportsFromEvents(events)
  assert.equal(reports.length, 3, 'malformed and non-usage session events are excluded')
  assert.equal(reports[2].recordedAt, 300, 'event timestamps provide a fallback when the report omitted one')
  const aggregate = aggregateProviderUsageReports(reports)
  assert.equal(aggregate.requests, 3)
  assert.equal(aggregate.providerReportedRequests, 2)
  assert.equal(aggregate.estimatedRequests, 1)
  assert.equal(aggregate.inputTokens, 235)
  assert.equal(aggregate.nonCachedInputTokens, 200)
  assert.equal(aggregate.outputTokens, 19)
  assert.equal(aggregate.totalTokens, 254, 'cache/reasoning/tool-use breakdowns must not be added to inclusive totals again')
  assert.equal(aggregate.estimateInputTokens, 219)
  assert.equal(aggregate.cacheReadTokens, 30)
  assert.equal(aggregate.cacheWriteTokens, 5)
  assert.equal(aggregate.reasoningTokens, 3)
  assert.equal(aggregate.toolUsePromptTokens, 0)
  assert.equal(aggregate.contextSamples, 2)
  assert.equal(aggregate.averageContextTokens, 100)
  assert.equal(aggregate.peakContextTokens, 110)
  assert.equal(aggregate.driftSamples, 2)
  assert.equal(aggregate.driftPercent, 0, 'aggregate drift is weighted by measured request occupancy, not averaged percentages')
  assert.equal(aggregate.firstRecordedAt, 100)
  assert.equal(aggregate.lastRecordedAt, 300)
  assert.deepEqual(aggregate.routes.map(route => [route.provider, route.model, route.requests, route.totalTokens]), [
    ['anthropic', 'sonnet', 2, 230],
    ['openai-compatible', 'custom', 1, 24],
  ])
  assert.equal(aggregateProviderUsageReports([]).requests, 0)
})

test('14H 10K-module repository map preserves focused relevance, token bounds, and warm-index reuse', async () => {
  const { buildRepositoryMap, formatRepositoryMap } = await import('../dist/context/repository.js')
  const { estimateTokens } = await import('../dist/context/budget.js')
  const root = await temp()
  const home = await temp('termagent-14h-repo-home-')
  const previousHome = process.env.HOME
  try {
    process.env.HOME = home
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'large-repo-fixture', version: '1.0.0' }))
    await fs.writeFile(path.join(root, 'README.md'), '# Large repository fixture\n')

    const fileCount = 10_000
    for (let index = 0; index < fileCount; index++) {
      const number = String(index).padStart(4, '0')
      const previous = String(Math.max(0, index - 1)).padStart(4, '0')
      const importLine = index > 0 ? `import { symbol${previous} } from './module-${previous}.js';\n` : ''
      const dependencyLine = index > 0 ? `  return symbol${previous} + ${index};\n` : `  return ${index};\n`
      await fs.writeFile(path.join(root, 'src', `module-${number}.ts`), `${importLine}export const symbol${number} = ${index};\nexport function feature${number}() {\n${dependencyLine}}\n`)
    }

    const coldStarted = Date.now()
    const cold = await buildRepositoryMap(root)
    const coldElapsed = Date.now() - coldStarted
    assert.equal(cold.files.length, fileCount + 2)
    assert.equal(cold.cache.miss, fileCount + 2)
    assert.ok(cold.edges.length > 7_000, `expected a connected 10K-module reference graph, received ${cold.edges.length} edges`)
    assert.ok(cold.files.some(file => file.path === 'src/module-9999.ts' && file.symbols.some(symbol => symbol.name === 'feature9999')))

    const warmStarted = Date.now()
    const warm = await buildRepositoryMap(root)
    const warmElapsed = Date.now() - warmStarted
    assert.equal(warm.files.length, cold.files.length)
    assert.equal(warm.cache.hit, cold.files.length)
    assert.equal(warm.cache.miss, 0)
    assert.ok(warmElapsed < 60_000 && coldElapsed < 60_000, `repository index stalled: cold=${coldElapsed}ms warm=${warmElapsed}ms`)

    const rendered = formatRepositoryMap(warm, 800, 64_000, {
      focusFiles: ['src/module-9999.ts'],
      focusSymbols: ['feature9999'],
    })
    assert.ok(estimateTokens(rendered) <= 64_000)
    assert.match(rendered, /src\/module-9999\.ts/)
    assert.match(rendered, /Important files:/)
    assert.match(rendered, /README\.md/)
    assert.match(rendered, /Structural file map \(800\/10002\)/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('14H automatic compaction records the request-footprint trigger and durable before/after headroom', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const root = await temp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-compaction-diagnostics')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    const requests = []
    const provider = {
      id: 'mock',
      model: 'mock-4k',
      config: { provider: 'mock', model: 'mock-4k', baseUrl: 'https://mock.invalid/v1', contextWindow: 4_000, maxTokens: 512 },
      async *stream(messages, tools) {
        requests.push({ messages: messages.map(message => ({ ...message })), tools })
        yield { type: 'text', delta: 'continued after compaction' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const history = [{ role: 'system', content: 'stale system prompt' }]
    for (let index = 0; index < 18; index++) {
      history.push({ role: 'user', content: `historical request ${index}: ${'u'.repeat(720)}` })
      history.push({ role: 'assistant', content: `historical response ${index}: ${'a'.repeat(720)}` })
    }
    // The existing accounting surface accepts image/media estimates separately
    // from text. Keep one payload in the fixture so compaction cannot accidentally
    // spend its text-only budget against an unreserved multimodal estimate.
    history.at(-2).images = [{ type: 'image', media_type: 'image/png', data: 'x'.repeat(4_000) }]
    const agent = new Agent(provider, registry, store, 1, 4_000, 1, undefined, [], { threshold: 1, reserveTokens: 0, recentTokens: 1_000 })
    await agent.run({ sessionId: session.id, messages: history, cwd: root, instructions: '', prompt: 'continue the current work' })

    const loaded = await store.load(session.id)
    const compactions = loaded.events.filter(event => event.type === 'compaction')
    const started = compactions.find(event => event.data?.stage === 'started')
    const completed = compactions.find(event => ['micro-prune', 'full-compaction'].includes(event.data?.stage))
    assert.ok(started, 'automatic compaction should persist a durable start event')
    assert.ok(completed, 'automatic compaction should persist a durable completion event')
    assert.equal(started.data.reason, 'estimated-request-footprint-exceeded-budget')
    assert.equal(started.data.trigger, 'turn-entry')
    assert.ok(started.data.before.estimatedRequestTokens > started.data.before.usableTokens)
    assert.equal(started.data.compactionTargetTokens, Math.floor(started.data.before.usableTokens * 0.90), 'ordinary compaction must leave a 10% headroom margin')
    assert.ok(started.data.before.multimodalTokens > 0, 'the compaction trigger must include the image/media estimate')
    assert.equal(started.data.before.estimatedRequestTokens, started.data.before.messageTokens + started.data.before.toolSchemaTokens + started.data.before.multimodalTokens + started.data.before.additionalRequestTokens)
    assert.ok(completed.data.before.estimatedRequestTokens > completed.data.before.usableTokens)
    assert.ok(completed.data.after.multimodalTokens > 0, 'compaction must retain and reserve the multimodal estimate')
    assert.ok(completed.data.after.headroomTokens >= 0)
    assert.ok(completed.data.removedMessages > 0 || completed.data.prunedToolResults > 0)
    assert.ok(completed.data.retainedMessages > 0)
    assert.equal(completed.data.after.contextWindowTokens, 4_000)
    assert.ok(requests.length >= 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H uses the latest provider-measured prompt as a baseline when resuming an OpenAI-compatible route', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const root = await temp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-measured-baseline')
    await store.append(session.id, { type: 'provider.usage', ts: Date.now() - 1000, data: {
      inputTokens: 18_500, nonCachedInputTokens: 18_500, outputTokens: 300, totalTokens: 18_800,
      contextWindow: 20_000, contextSource: 'provider-profile', provider: 'openai-compatible', model: 'mercury-3',
      estimateInputTokens: 13_000, estimated: false,
    } })
    const requests = []
    const provider = {
      id: 'openai-compatible',
      model: 'mercury-3',
      config: { provider: 'openai-compatible', model: 'mercury-3', baseUrl: 'https://provider.invalid/v1', contextWindow: 20_000, maxTokens: 1_024 },
      async *stream(messages) {
        requests.push(messages.map(message => ({ ...message })))
        yield { type: 'text', delta: 'The resumed request was compacted before sending.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const history = []
    for (let index = 0; index < 25; index++) {
      history.push({ role: 'user', content: `historical request ${index}: ${'u'.repeat(1_000)}` })
      history.push({ role: 'assistant', content: `historical response ${index}: ${'a'.repeat(1_000)}` })
    }
    const agent = new Agent(provider, new ToolRegistry(new PermissionGate('auto')), store, 1, 0, 1, undefined, [], { threshold: 1, reserveTokens: 1_000, recentTokens: 2_000 })
    await agent.run({ sessionId: session.id, messages: history, cwd: root, instructions: '', prompt: 'Continue from the previous work.' })

    const loaded = await store.load(session.id)
    const started = loaded.events.find(event => event.type === 'compaction' && event.data?.stage === 'started')
    const completed = loaded.events.find(event => event.type === 'compaction' && event.data?.stage === 'full-compaction')
    assert.ok(started, 'provider-measured input plus newly added prompt content should trigger compaction')
    assert.equal(started.data.trigger, 'turn-entry')
    assert.ok(started.data.before.estimatedRequestTokens > started.data.before.usableTokens)
    assert.ok(started.data.before.providerUsageBaseline.measuredTokens >= 18_500)
    assert.ok(completed, 'the measured-baseline trigger must finish compaction')
    assert.ok(completed.data.after.estimatedRequestTokens <= started.data.compactionTargetTokens, 'ordinary compaction must leave 10% headroom below the hard usable ceiling')
    assert.ok(requests.length >= 1)
    assert.ok(requests[0].length < history.length + 2, 'the first provider request must use the compacted history')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H compacts after a provider-reported oversized final response before returning to ready state', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const root = await temp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-post-response-compaction')
    const provider = {
      id: 'openai-compatible',
      model: 'mercury-3',
      config: { provider: 'openai-compatible', model: 'mercury-3', baseUrl: 'https://provider.invalid/v1', contextWindow: 20_000, maxTokens: 1_024 },
      async *stream() {
        yield { type: 'usage', usage: { inputTokens: 19_300, outputTokens: 20, totalTokens: 19_320 } }
        yield { type: 'text', delta: 'Final response completed.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const history = []
    for (let index = 0; index < 25; index++) {
      history.push({ role: 'user', content: `historical request ${index}: ${'u'.repeat(1_000)}` })
      history.push({ role: 'assistant', content: `historical response ${index}: ${'a'.repeat(1_000)}` })
    }
    // Agent.run reloads durable turn history after each provider round. Seed the
    // same history in SessionStore so this fixture mirrors a resumed real session.
    for (const message of history) await store.appendMessage(session.id, message)
    const estimates = []
    const agent = new Agent(provider, new ToolRegistry(new PermissionGate('auto')), store, 1, 0, 1, undefined, [], { threshold: 1, reserveTokens: 1_000, recentTokens: 2_000 })
    await agent.run({
      sessionId: session.id, messages: history, cwd: root, instructions: '', prompt: 'Finish the requested task.',
      onUsage: report => estimates.push(report),
    })

    assert.equal(estimates.length, 1)
    assert.equal(estimates[0].estimated, false)
    assert.ok(estimates[0].estimateRequestTokens < estimates[0].contextWindow, 'the local request estimate must be below the provider window in this regression')
    const loaded = await store.load(session.id)
    const started = loaded.events.find(event => event.type === 'compaction' && event.data?.stage === 'started' && event.data?.trigger === 'post-provider-response')
    const completed = loaded.events.find(event => event.type === 'compaction' && event.data?.stage === 'full-compaction' && event.data?.trigger === 'post-provider-response')
    assert.ok(started, 'the no-tool final-response branch must invoke the compaction gate')
    assert.ok(started.data.before.estimatedRequestTokens > started.data.before.usableTokens)
    assert.ok(completed, 'the provider-measured over-limit context must be compacted before Agent.run returns')
    assert.ok(completed.data.after.estimatedRequestTokens <= started.data.compactionTargetTokens, 'compaction must finish below its target, not merely below the hard ceiling')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H provider-native preflight can trigger compaction and recount the projected request', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const root = await temp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-native-count')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    const counted = []
    let streamMessages
    const provider = {
      id: 'mock-native-count',
      model: 'mock-native-count-5k',
      config: { provider: 'mock-native-count', model: 'mock-native-count-5k', baseUrl: 'https://mock.invalid/v1', contextWindow: 5_000, maxOutputTokens: 256 },
      async countTokens(messages, tools, signal) {
        assert.equal(signal.aborted, false)
        counted.push({ messageCount: messages.length, toolCount: tools.length })
        return { inputTokens: counted.length === 1 ? 5_200 : 800, source: 'mock-native-counter' }
      },
      async *stream(messages) {
        streamMessages = messages.map(message => ({ ...message }))
        yield { type: 'text', delta: 'continued with provider-native token preflight' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const history = []
    for (let index = 0; index < 14; index++) {
      history.push({ role: 'user', content: `historical user ${index}: ${'u'.repeat(430)}` })
      history.push({ role: 'assistant', content: `historical assistant ${index}: ${'a'.repeat(430)}` })
    }
    await new Agent(provider, registry, store, 1, 5_000, 1, undefined, [], { threshold: 1, reserveTokens: 256, recentTokens: 1_000 }).run({
      sessionId: session.id,
      messages: history,
      cwd: root,
      instructions: '',
      prompt: 'Continue the current task.',
    })

    assert.ok(counted.length >= 2, 'the request should be counted before and after compaction')
    assert.ok(counted[0].messageCount > counted[1].messageCount, 'post-compaction count must use the projected message list')
    assert.ok(streamMessages.length < history.length + 2, 'the provider should receive the compacted request')
    const loaded = await store.load(session.id)
    const started = loaded.events.find(event => event.type === 'compaction' && event.data?.stage === 'started')
    const completed = loaded.events.find(event => event.type === 'compaction' && event.data?.stage === 'full-compaction')
    assert.ok(started, 'provider-count-triggered compaction should persist its start record')
    assert.ok(completed, 'provider-count-triggered compaction should persist its completion record')
    assert.deepEqual(started.data.before.providerCount, { inputTokens: 5_200, source: 'mock-native-counter' })
    assert.equal(completed.data.after.providerCount, undefined, 'pre-compaction count must not be mislabeled as an after-compaction measurement')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H recovers once from an explicit provider context-overflow rejection by compacting and retrying', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { ProviderHttpError } = await import('../dist/providers/errors.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const root = await temp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'phase14h-provider-overflow-recovery')
    const requests = []
    let attempts = 0
    const provider = {
      id: 'openai-compatible', model: 'mercury-3',
      config: { provider: 'openai-compatible', model: 'mercury-3', baseUrl: 'https://provider.invalid/v1', contextWindow: 20_000, maxTokens: 1_024 },
      async *stream(messages) {
        attempts++
        requests.push(messages.map(message => ({ ...message })))
        if (attempts === 1) throw new ProviderHttpError(400, '{"error":{"code":"context_length_exceeded","message":"maximum context length is 20000 tokens"}}')
        yield { type: 'text', delta: 'Recovered after provider context overflow.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const history = []
    for (let index = 0; index < 24; index++) {
      history.push({ role: 'user', content: `historical request ${index}: ${'u'.repeat(1_000)}` })
      history.push({ role: 'assistant', content: `historical response ${index}: ${'a'.repeat(1_000)}` })
    }
    for (const message of history) await store.appendMessage(session.id, message)
    const agent = new Agent(provider, new ToolRegistry(new PermissionGate('auto')), store, 1, 0, 1, undefined, [], { threshold: 1, reserveTokens: 1_000, recentTokens: 2_000 })
    const result = await agent.run({ sessionId: session.id, messages: history, cwd: root, instructions: '', prompt: 'Continue the current task.' })

    assert.equal(attempts, 2, 'the provider request should be retried exactly once after recovery')
    assert.match(String(result), /Recovered after provider context overflow/)
    assert.ok(requests[1].length < requests[0].length, 'the retry must use the compacted conversation')
    const loaded = await store.load(session.id)
    const started = loaded.events.find(event => event.type === 'compaction' && event.data?.stage === 'started' && event.data?.reason === 'provider-context-overflow')
    const completed = loaded.events.find(event => event.type === 'compaction' && event.data?.stage === 'full-compaction' && event.data?.reason === 'provider-context-overflow')
    assert.ok(started, 'overflow recovery must persist a durable compaction-start event')
    assert.ok(completed, 'overflow recovery must persist a completed compaction event')
    assert.ok(completed.data.after.estimatedRequestTokens < completed.data.compactionTargetTokens || completed.data.after.estimatedRequestTokens <= completed.data.after.usableTokens)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
