import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config/config.js'
import { discoverPluginPackages } from '../plugins/registry.js'
import { readPluginManifest, resolvePluginComponentPath } from '../plugins/manifest.js'
import { loadInstalledPlugins } from '../plugins/marketplace.js'
import type { InstalledPluginRecord } from '../plugins/marketplace-types.js'
import { within } from '../util/fs.js'
import { scanSkillContent, formatSkillSecurityWarnings, type SkillSecurityFinding, type SkillSecurityStatus } from './security.js'
import { isRegistrySkillPathSafe, listInstalledRegistrySkills } from './registry.js'

export type SkillSource = 'project' | 'global' | 'plugin' | 'registry'

export type SkillDescriptor = {
  id: string
  name: string
  description: string
  source: SkillSource
  pluginId?: string
  pluginName?: string
  marketplace?: string
  version?: string
  userInvocable?: boolean
  disableModelInvocation?: boolean
  securityStatus?: SkillSecurityStatus
  registryId?: string
  trust?: string
}

export type SkillDetails = SkillDescriptor & {
  path: string
  root: string
  size: number
  mtimeMs: number
  sha256: string
  frontmatter: Record<string, string>
  warnings: string[]
  securityFindings: SkillSecurityFinding[]
}

type IndexedSkill = IndexEntry

type IndexEntry = {
  fingerprint: string
  descriptor: SkillDescriptor
  details: SkillDetails
  realPath: string
}

const memoryIndexes = new Map<string, Map<string, IndexEntry>>()
const memoryGenerations = new Map<string, number>()
const inFlightBuilds = new Map<string, Promise<SkillCatalog>>()
const MAX_CACHED_PROJECTS = 8

let catalogStats = { builds: 0, warmBuilds: 0, parsedFiles: 0, reusedFiles: 0, searchInvalidations: 0 }

async function LOCAL_ROOTS(cwd: string): Promise<Array<{ root: string; source: SkillSource }>> {
  return [
    { root: path.join(cwd, '.termagent', 'skills'), source: 'project' as const },
    { root: path.join(cwd, '.claude', 'skills'), source: 'project' as const },
    { root: path.join(process.env.HOME || cwd, '.termagent', 'skills'), source: 'global' as const },
    { root: path.join(process.env.HOME || cwd, '.claude', 'skills'), source: 'global' as const },
    ...(await readConfiguredSkillRoots(cwd)),
  ]
}

async function readConfiguredSkillRoots(cwd: string): Promise<Array<{ root: string; source: SkillSource }>> {
  try {
    const cfg = await loadConfig(cwd)
    return (cfg.skillPaths ?? [])
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map(value => ({ root: path.resolve(cwd, value), source: 'project' as const }))
  } catch {
    return []
  }
}

function cacheKey(cwd: string): string {
  return path.resolve(cwd)
}

function cleanScalar(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function parseFrontmatter(content: string): { values: Record<string, string>; warnings: string[] } {
  const values: Record<string, string> = Object.create(null)
  const warnings: string[] = []
  if (!content.startsWith('---')) return { values, warnings }
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { values, warnings }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end === -1) {
    warnings.push('frontmatter is not closed with ---')
    return { values, warnings }
  }
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? ''
    if (!line.trim() || line.trim().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) {
      warnings.push(`frontmatter line ${i + 1} is not a key: value pair`)
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!key) {
      warnings.push(`frontmatter line ${i + 1} has an empty key`)
      continue
    }
    if (!value) {
      warnings.push(`frontmatter field '${key}' has an empty value`)
      continue
    }
    values[key] = cleanScalar(value)
  }
  return { values, warnings }
}

function fallbackDescription(content: string, name: string): string {
  const heading = content
    .split(/\r?\n/)
    .find(line => /^#\s+\S/.test(line.trim()))
  return heading ? heading.replace(/^#\s+/, '').trim() : name
}

function parseDescriptor(content: string, name: string): Pick<SkillDetails, 'description' | 'frontmatter' | 'warnings' | 'userInvocable' | 'disableModelInvocation' | 'securityStatus' | 'securityFindings'> {
  const { values, warnings } = parseFrontmatter(content)
  const security = scanSkillContent(content)
  warnings.push(...formatSkillSecurityWarnings(security.findings))
  const description = values.description || values.Description || fallbackDescription(content, name)
  const userInvocable = values['user-invocable'] === undefined ? undefined : values['user-invocable'].toLowerCase() !== 'false'
  const disableModelInvocation = values['disable-model-invocation'] === undefined ? undefined : values['disable-model-invocation'].toLowerCase() === 'true'
  return { description, frontmatter: values, warnings, userInvocable, disableModelInvocation, securityStatus: security.status, securityFindings: security.findings }
}

async function statSkill(file: string): Promise<{ size: number; mtimeMs: number }> {
  const stat = await fs.stat(file)
  return { size: stat.size, mtimeMs: stat.mtimeMs }
}

async function realPathIfExists(file: string): Promise<string | null> {
  try {
    return await fs.realpath(file)
  } catch {
    return null
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile()
  } catch {
    return false
  }
}

function fingerprint(pathName: string, size: number, mtimeMs: number, sha256: string): string {
  return `${path.resolve(pathName)}|${size}|${mtimeMs}|${sha256}`
}

function pluginSkillId(record: InstalledPluginRecord, name: string): string {
  return `${record.id}:${name}`
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const count = Math.max(1, Math.min(limit, items.length || 1))
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  }))
  return results
}

function pathsForManifestSkills(pluginRoot: string, skills: string | string[] | undefined): string[] {
  const declared = skills === undefined ? ['./skills'] : (Array.isArray(skills) ? skills : [skills])
  const all = new Set<string>(['./skills', ...declared])
  const out: string[] = []
  for (const relative of all) {
    try {
      const resolved = resolvePluginComponentPath(pluginRoot, relative)
      if (within(pluginRoot, resolved)) out.push(resolved)
    } catch {
      // Invalid manifest paths were already rejected by the manifest layer.
    }
  }
  return out
}

async function collectSkillFiles(root: string): Promise<Array<{ file: string; realRoot: string }>> {
  const realRoot = await realPathIfExists(root)
  if (!realRoot) return []
  if (!await isDirectory(root)) return []
  const out: Array<{ file: string; realRoot: string }> = []
  const visited = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    const currentReal = await realPathIfExists(current)
    if (!currentReal || visited.has(currentReal)) continue
    visited.add(currentReal)

    const skillFile = path.join(current, 'SKILL.md')
    if (await isFile(skillFile)) out.push({ file: skillFile, realRoot })

    let entries: any[] = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = path.join(current, entry.name)
      if (entry.isDirectory() || entry.isSymbolicLink()) stack.push(child)
    }
  }
  return out
}

async function readIndexedSkill(file: string, source: SkillSource, root: string, existing?: IndexEntry, plugin?: InstalledPluginRecord, forcedId?: string, forcedName?: string): Promise<IndexEntry | null> {
  const realPath = await realPathIfExists(file)
  if (!realPath) return null
  const realRoot = await realPathIfExists(root)
  if (!realRoot || !within(realRoot, realPath)) return null
  const { size, mtimeMs } = await statSkill(file)
  const resolvedFile = path.resolve(file)
  const key = path.resolve(realPath)
  // Warm-cache fast path: an unchanged mtime+size is enough to reuse the
  // descriptor and digest. Hashing every SKILL.md on every turn made a 1,000
  // skill catalog unnecessarily read every body from slow Termux storage.
  // The digest is recomputed only after the file metadata changes.
  if (existing && existing.details.path === resolvedFile && existing.details.size === size && Math.abs(existing.details.mtimeMs - mtimeMs) < 0.01 && existing.realPath === realPath) {
    catalogStats.reusedFiles++
    return existing
  }

  const content = await fs.readFile(file, 'utf8')
  const digestHash = crypto.createHash('sha256')
  digestHash.update(content)
  const digest = `sha256:${digestHash.digest('hex')}`
  const currentFingerprint = fingerprint(key, size, mtimeMs, digest)

  const name = forcedName || path.basename(path.dirname(file))
  catalogStats.parsedFiles++
  const parsed = parseDescriptor(content, name)
  const descriptor: SkillDescriptor = {
    id: forcedId || name,
    name,
    description: parsed.description,
    source,
    pluginId: plugin?.id,
    pluginName: plugin?.plugin,
    marketplace: plugin?.marketplace,
    version: plugin?.version,
    userInvocable: parsed.userInvocable,
    disableModelInvocation: parsed.disableModelInvocation,
    securityStatus: parsed.securityStatus,
  }
  const details: SkillDetails = {
    ...descriptor,
    path: path.resolve(file),
    root: path.resolve(root),
    size,
    mtimeMs,
    sha256: digest,
    frontmatter: parsed.frontmatter,
    warnings: parsed.warnings,
    securityFindings: parsed.securityFindings,
  }
  return { fingerprint: currentFingerprint, descriptor, details, realPath }
}

async function collectLocal(cwd: string, previous: Map<string, IndexEntry>): Promise<IndexedSkill[]> {
  const found: IndexedSkill[] = []
  const roots = await LOCAL_ROOTS(cwd)
  const batches = await mapWithConcurrency(roots, 4, async ({ root, source }) => {
    const items = await collectSkillFiles(root)
    return mapWithConcurrency(items, 8, async item => {
      const rawName = path.basename(path.dirname(item.file))
      return readIndexedSkill(item.file, source, root, previous.get(path.resolve(item.file)), undefined, rawName, rawName)
    })
  })
  for (const batch of batches) for (const entry of batch) if (entry) found.push(entry)
  return found
}

async function collectInstalledPluginSkills(previous: Map<string, IndexEntry>): Promise<IndexedSkill[]> {
  let installed
  try {
    installed = await loadInstalledPlugins()
  } catch {
    return []
  }

  const records = Object.values(installed.plugins).filter(record => (record.status === 'installed' || record.status === 'update-available') && record.enabled !== false)
  const batches = await mapWithConcurrency(records, 4, async record => {
    const batch: IndexedSkill[] = []
    try {
      const manifestResult = await readPluginManifest(record.installPath)
      const roots = pathsForManifestSkills(record.installPath, manifestResult.manifest.skills)
      for (const root of roots) {
        const items = await collectSkillFiles(root)
        const entries = await mapWithConcurrency(items, 8, async item => {
          const rawName = path.basename(path.dirname(item.file))
          const id = pluginSkillId(record, rawName)
          return readIndexedSkill(item.file, 'plugin', root, previous.get(path.resolve(item.file)), record, id, rawName)
        })
        for (const entry of entries) if (entry) batch.push(entry)
      }
    } catch {
      // Broken plugin manifests are already represented in plugin state. Skills should degrade gracefully.
    }
    return batch
  })
  return batches.flat()
}
async function collectInstalledRegistrySkills(previous: Map<string, IndexEntry>): Promise<IndexedSkill[]> {
  const installed = await listInstalledRegistrySkills()
  const out: IndexedSkill[] = []
  for (const record of installed) {
    if (record.status !== 'installed') continue
    if (!(await isRegistrySkillPathSafe(record))) continue
    const root = path.dirname(record.path)
    const entry = await readIndexedSkill(
      record.path,
      'registry',
      root,
      previous.get(path.resolve(record.path)),
      undefined,
      record.id,
      record.name,
    )
    if (entry && entry.details.sha256 === record.sha256) {
      entry.descriptor.registryId = record.registryId
      entry.descriptor.trust = record.trust
      entry.details.registryId = record.registryId
      entry.details.trust = record.trust
      out.push(entry)
    }
  }
  return out
}

async function collectLocalPluginPackages(cwd: string, previous: Map<string, IndexEntry>): Promise<IndexedSkill[]> {
  const discovered = await discoverPluginPackages(cwd)
  const batches = await mapWithConcurrency(discovered.packages, 4, async pkg => {
    const batch: IndexedSkill[] = []
    try {
      const roots = pathsForManifestSkills(pkg.root, pkg.manifest.skills)
      const pseudo: InstalledPluginRecord = {
        id: `${pkg.manifest.name}@local`,
        marketplace: 'local',
        plugin: pkg.manifest.name,
        source: './local',
        installPath: pkg.root,
        version: pkg.manifest.version || '0.0.0',
        digest: 'sha256:' + '0'.repeat(64),
        installedAt: '',
        lastUpdated: '',
        status: 'installed',
      }
      for (const root of roots) {
        const items = await collectSkillFiles(root)
        const entries = await mapWithConcurrency(items, 8, async item => {
          const rawName = path.basename(path.dirname(item.file))
          const id = pluginSkillId(pseudo, rawName)
          return readIndexedSkill(item.file, 'plugin', root, previous.get(path.resolve(item.file)), pseudo, id, rawName)
        })
        for (const entry of entries) if (entry) batch.push(entry)
      }
    } catch {
      // Ignore malformed local plugin packages in the catalog; registry exposes their errors separately.
    }
    return batch
  })
  return batches.flat()
}

function choosePrecedence(skills: IndexedSkill[]): IndexedSkill[] {
  const localSeen = new Set<string>()
  const pluginIds = new Set<string>()
  const out: IndexedSkill[] = []

  for (const skill of skills) {
    if (skill.descriptor.source === 'plugin' || skill.descriptor.source === 'registry') {
      // Plugin skills are fully namespaced. Same plugin/name is deduped by path order.
      const namespaceKey = skill.descriptor.id.toLowerCase()
      if (pluginIds.has(namespaceKey)) continue
      pluginIds.add(namespaceKey)
      out.push(skill)
      continue
    }
    const key = skill.descriptor.name.toLowerCase()
    if (localSeen.has(key)) continue
    localSeen.add(key)
    out.push(skill)
  }
  return out
}

export class SkillCatalog {
  readonly cwd: string
  readonly generation: number
  private index: Map<string, IndexEntry>

  private constructor(cwd: string, index: Map<string, IndexEntry>, generation: number) {
    this.cwd = path.resolve(cwd)
    this.index = index
    this.generation = generation
  }

  static async build(cwd: string, options: { includeLocalPlugins?: boolean } = {}): Promise<SkillCatalog> {
    const key = cacheKey(cwd)
    const previous = memoryIndexes.get(key) || new Map<string, IndexEntry>()
    const previousByPath = new Map<string, IndexEntry>()
    for (const entry of previous.values()) previousByPath.set(entry.details.path, entry)
    const previousGener = memoryGenerations.get(key) || 0
    catalogStats.builds++
    catalogStats.reusedFiles = 0
    catalogStats.parsedFiles = 0

    const [local, pluginLocal, installedRegistry, installedPlugins] = await Promise.all([
      collectLocal(cwd, previousByPath),
      options.includeLocalPlugins === false ? Promise.resolve([] as IndexedSkill[]) : collectLocalPluginPackages(cwd, previousByPath),
      collectInstalledRegistrySkills(previousByPath),
      collectInstalledPluginSkills(previousByPath),
    ])
    const selected = choosePrecedence([...local, ...pluginLocal, ...installedRegistry, ...installedPlugins])
    const next = new Map<string, IndexEntry>()
    for (const skill of selected) next.set(skill.descriptor.id, skill)

    let changed = next.size !== previous.size
    if (!changed) {
      for (const [id, entry] of next) {
        if (previous.get(id) !== entry) { changed = true; break }
      }
    }
    const generation = changed ? previousGener + 1 : previousGener
    if (!changed && previous.size > 0) catalogStats.warmBuilds++
    if (changed) catalogStats.searchInvalidations++
    // Touch the active project so the bounded project cache behaves like an
    // LRU rather than permanently favoring the order in which projects first
    // appeared in a long-lived process.
    memoryIndexes.delete(key)
    memoryIndexes.set(key, next)
    memoryGenerations.delete(key)
    memoryGenerations.set(key, generation)
    // Bound project-scoped caches so long-lived API processes do not grow
    // without limit as users work across many directories.
    while (memoryIndexes.size > MAX_CACHED_PROJECTS) {
      const first = memoryIndexes.keys().next().value as string | undefined
      if (!first || first === key) break
      memoryIndexes.delete(first)
      memoryGenerations.delete(first)
    }
    return new SkillCatalog(cwd, next, generation)
  }

  static clear(cwd?: string): void {
    if (cwd === undefined) {
      memoryIndexes.clear()
      memoryGenerations.clear()
      return
    }
    const key = cacheKey(cwd)
    memoryIndexes.delete(key)
    memoryGenerations.delete(key)
  }

  list(): SkillDescriptor[] {
    return [...this.index.values()]
      .map(entry => entry.descriptor)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): SkillDetails | undefined {
    return this.index.get(id)?.details
  }

  has(id: string): boolean {
    return this.index.has(id)
  }

  details(): SkillDetails[] {
    return [...this.index.values()]
      .map(entry => entry.details)
      .sort((a, b) => a.id.localeCompare(b.id))
  }
}

export async function loadSkillCatalog(cwd: string): Promise<SkillCatalog> {
  const key = cacheKey(cwd)
  const active = inFlightBuilds.get(key)
  if (active) return active
  const build = SkillCatalog.build(cwd).finally(() => { inFlightBuilds.delete(key) })
  inFlightBuilds.set(key, build)
  return build
}

export function getSkillCatalogStats(): { builds: number; warmBuilds: number; parsedFiles: number; reusedFiles: number; searchInvalidations: number; cachedProjects: number } {
  return { ...catalogStats, cachedProjects: memoryIndexes.size }
}

export async function listSkillDescriptors(cwd: string): Promise<SkillDescriptor[]> {
  return (await loadSkillCatalog(cwd)).list()
}

export function formatSkillDescriptors(skills: SkillDescriptor[], maxChars = 8000): string {
  if (skills.length === 0) return '(no skills discovered)'
  const lines: string[] = []
  let used = 0
  const limit = Math.max(1, maxChars)
  for (const skill of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
    const namespace = skill.pluginId ? ` [plugin:${skill.pluginId}]` : ` [${skill.source}]`
    const description = skill.description.replace(/\s+/g, ' ').slice(0, 240)
    const line = `- ${skill.id}: ${description}${namespace}`
    const next = used + line.length + (lines.length ? 1 : 0)
    if (next > limit) break
    lines.push(line)
    used = next
  }
  return lines.join('\n') || '(no skills fit the descriptor budget)'
}

export async function getSkillDetails(cwd: string, id: string): Promise<SkillDetails | undefined> {
  const catalog = await loadSkillCatalog(cwd)
  return catalog.get(id)
}
