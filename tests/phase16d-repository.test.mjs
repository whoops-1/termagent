import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildRepositoryMap, invalidateRepositoryCache } from '../dist/context/repository.js'
import { analyzeSource } from '../dist/context/symbols.js'

async function temp(prefix) { return await mkdtemp(path.join(tmpdir(), prefix)) }
async function cleanup(root) { await rm(root, { recursive: true, force: true }) }

async function writeProject(root) {
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'lib'), { recursive: true })
  await writeFile(path.join(root, 'lib', 'auth.ts'), `export function authenticateUser(token: string) {\n  return token.length > 0\n}\nexport class AuthService {}\n`)
  await writeFile(path.join(root, 'src', 'auth-client.ts'), `import { authenticateUser, AuthService } from '../lib/auth'\nexport function login(token: string) {\n  const ok = authenticateUser(token)\n  return new AuthService() && ok\n}\n`)
  await writeFile(path.join(root, 'src', 'helper.py'), `def run_helper():\n    return 1\n`)
  await writeFile(path.join(root, 'src', 'main.py'), `from .helper import run_helper\n\ndef entry():\n    return run_helper()\n`)
  await writeFile(path.join(root, 'README.md'), `# TermAgent\n\n## Installation\n\nrun npm install\n\n### Notes\n`)
}

function edgeKey(edge) {
  return `${edge.from}|${edge.to}|${edge.weight}|${[...edge.symbols].sort().join(',')}`
}
function structuralMap(map) {
  return new Map(map.files.map(file => [file.path, file.structural]))
}

test('16D cache payload persists edges, ranks, and a file fingerprint', async () => {
  const root = await temp('termagent-p16d-persist-')
  await writeProject(root)
  await invalidateRepositoryCache(root)
  try {
    const map = await buildRepositoryMap(root)
    const payload = JSON.parse(await readFile(map.cache.path, 'utf8'))
    assert.equal(payload.version, 4)
    assert.equal(payload.root, path.resolve(root))
    assert.ok(Array.isArray(payload.edges))
    assert.equal(payload.edges.length, map.edges.length)
    assert.ok(payload.ranks && typeof payload.ranks === 'object')
    for (const file of map.files) assert.ok(payload.ranks[file.path] !== undefined)
    assert.equal(typeof payload.fingerprint, 'string')
    assert.ok(payload.fingerprint.length > 0)
  } finally { await cleanup(root) }
})

test('16D unchanged tree warm path reuses persisted graph without recompute', async () => {
  const root = await temp('termagent-p16d-warm-')
  await writeProject(root)
  await invalidateRepositoryCache(root)
  try {
    const first = await buildRepositoryMap(root)
    const second = await buildRepositoryMap(root)
    assert.equal(second.cache.miss, 0)
    assert.equal(second.cache.hit, first.files.length)
    assert.deepEqual([...second.edges].map(edgeKey).sort(), [...first.edges].map(edgeKey).sort())
    assert.deepEqual(structuralMap(second), structuralMap(first))
    const third = await buildRepositoryMap(root)
    assert.equal(third.cache.miss, 0)
    assert.deepEqual([...third.edges].map(edgeKey).sort(), [...first.edges].map(edgeKey).sort())
  } finally { await cleanup(root) }
})

test('16D single-file change reparses only that file and rebuilds edges', async () => {
  const root = await temp('termagent-p16d-incremental-')
  await writeProject(root)
  await invalidateRepositoryCache(root)
  try {
    await buildRepositoryMap(root)
    await writeFile(path.join(root, 'src', 'helper.py'), `def run_helper():\n    return 2\n\ndef extra_helper():\n    return 3\n`)
    const next = await buildRepositoryMap(root)
    assert.equal(next.cache.miss, 1)
    assert.equal(next.cache.hit, next.files.length - 1)
    assert.ok(next.edges.some(edge => edge.from === 'src/main.py' && edge.to === 'src/helper.py'))
    assert.ok(next.files.find(file => file.path === 'src/helper.py').symbols.some(symbol => symbol.name === 'extra_helper'))
  } finally { await cleanup(root) }
})

test('16D invalidation forces a cold rebuild with no cached graph reuse', async () => {
  const root = await temp('termagent-p16d-invalidate-')
  await writeProject(root)
  await invalidateRepositoryCache(root)
  try {
    await buildRepositoryMap(root)
    const warm = await buildRepositoryMap(root)
    assert.equal(warm.cache.miss, 0)
    await invalidateRepositoryCache(root)
    const cold = await buildRepositoryMap(root)
    assert.ok(cold.cache.miss >= 5)
  } finally { await cleanup(root) }
})

test('16D language coverage: markdown headings become heading symbols', async () => {
  const root = await temp('termagent-p16d-md-')
  await writeProject(root)
  await invalidateRepositoryCache(root)
  try {
    const map = await buildRepositoryMap(root)
    const readme = map.files.find(file => file.path === 'README.md')
    assert.ok(readme)
    const headings = readme.symbols.filter(symbol => symbol.kind === 'heading')
    assert.ok(headings.some(symbol => symbol.name === 'TermAgent' && symbol.line === 1))
    assert.ok(headings.some(symbol => symbol.name === 'Installation' && symbol.line === 3))
    assert.ok(headings.some(symbol => symbol.name === 'Notes' && symbol.line === 7))
  } finally { await cleanup(root) }
})

test('16D analyzeSource extracts markdown headings and strips emphasis', () => {
  const analysis = analyzeSource('README.md', '# Title *emphasized*\n\n## "Quoted" & [link](x)\n\n### Code `inline`\n')
  assert.equal(analysis.language, 'unknown')
  assert.deepEqual(analysis.symbols.map(symbol => [symbol.name, symbol.kind, symbol.line]), [
    ['Title emphasized', 'heading', 1],
    ['"Quoted" & [link](x)', 'heading', 3],
    ['Code inline', 'heading', 5],
  ])
  assert.equal(analysis.references.length, 0)
})
