import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureDir, expandHome, within } from '../util/fs.js'
import { readPluginManifest } from './manifest.js'
import { assertPathNotSymlink, assertRealpathWithin, validateReservedMarketplaceNameSource } from './security.js'
import type {
  MarketplaceManifest,
  MarketplacePluginEntry,
  MarketplaceProgressEvent,
  MarketplaceResult,
  MarketplaceSource,
  KnownMarketplace,
  KnownMarketplacesFile,
  PluginSource,
} from './marketplace-types.js'

const execFileAsync = promisify(execFile)

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA_PATTERN = /^[a-f0-9]{40}$/i
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/

export function marketplaceStateRoot(): string {
  return expandHome('~/.termagent/marketplaces')
}

export function knownMarketplacesPath(): string {
  return path.join(marketplaceStateRoot(), 'known.json')
}

export function marketplaceCacheRoot(): string {
  return path.join(marketplaceStateRoot(), 'cache')
}

export function installedPluginsRoot(): string {
  return expandHome('~/.termagent/plugins/cache')
}

export function installedPluginsPath(): string {
  return expandHome('~/.termagent/plugins/installed.json')
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700).catch(() => undefined)
}

function fail(where: string, message: string): never {
  throw new Error(`Invalid ${where}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(where, 'must be a non-empty string')
  return value.trim()
}

function safeName(value: unknown, where: string): string {
  const name = nonEmptyString(value, where)
  if (!NAME_PATTERN.test(name) || name.includes('..') || name.startsWith('.') || name.endsWith('.')) {
    fail(where, `contains an unsafe identifier: ${name}`)
  }
  return name
}

function safeVersion(value: unknown, where: string): string {
  const version = nonEmptyString(value, where)
  if (!VERSION_PATTERN.test(version)) fail(where, `must be semver-like (x.y.z): ${version}`)
  return version
}

function normalizeRelativeRepoPath(value: unknown, where: string): string {
  const raw = nonEmptyString(value, where).replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) fail(where, 'must be a relative repository path')
  const parts = raw.split('/')
  if (parts.some(part => part === '..' || part === '.')) fail(where, 'contains unsafe path segments')
  return raw.replace(/^\.\//, '')
}

function validateUrl(value: unknown, where: string, allowFile = false): string {
  const raw = nonEmptyString(value, where)
  if (allowFile && raw.startsWith('file://')) return raw
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    fail(where, 'must be a valid URL')
  }
  const allowed = allowFile ? ['http:', 'https:', 'ssh:', 'git:', 'file:'] : ['http:', 'https:']
  if (!allowed.includes(parsed.protocol)) {
    fail(where, `unsupported URL protocol: ${parsed.protocol}`)
  }
  return raw
}

function validateGitLocation(value: unknown, where: string): string {
  const raw = nonEmptyString(value, where)
  if (/^[^@\s]+@[^:\s]+:.+$/.test(raw)) return raw
  return validateUrl(raw, where, true)
}

function validateSparsePaths(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail(where, 'must be an array')
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const item = normalizeRelativeRepoPath(value[i], `${where}[${i}]`)
    if (seen.has(item)) fail(where, `contains duplicate path ${item}`)
    seen.add(item)
    out.push(item)
  }
  return out
}

function validateHeaders(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail(where, 'must be an object')
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) out[key] = nonEmptyString(raw, `${where}.${key}`)
  return out
}

export function validateMarketplaceSource(value: unknown, where = 'marketplace source'): MarketplaceSource {
  if (!isRecord(value)) fail(where, 'must be an object')
  const source = nonEmptyString(value.source, `${where}.source`)
  if (source === 'url') {
    return {
      source: 'url',
      url: validateUrl(value.url, `${where}.url`),
      headers: validateHeaders(value.headers, `${where}.headers`),
    }
  }
  if (source === 'github') {
    const repo = nonEmptyString(value.repo, `${where}.repo`)
    if (!REPO_PATTERN.test(repo)) fail(`${where}.repo`, 'must use owner/repository format')
    const ref = value.ref === undefined ? undefined : nonEmptyString(value.ref, `${where}.ref`)
    const sha = value.sha === undefined ? undefined : nonEmptyString(value.sha, `${where}.sha`)
    if (sha && !SHA_PATTERN.test(sha)) fail(`${where}.sha`, 'must be a 40-character commit SHA')
    return {
      source: 'github', repo, ref, sha,
      path: value.path === undefined ? undefined : normalizeRelativeRepoPath(value.path, `${where}.path`),
      sparsePaths: validateSparsePaths(value.sparsePaths, `${where}.sparsePaths`),
    }
  }
  if (source === 'git') {
    const ref = value.ref === undefined ? undefined : nonEmptyString(value.ref, `${where}.ref`)
    const sha = value.sha === undefined ? undefined : nonEmptyString(value.sha, `${where}.sha`)
    if (sha && !SHA_PATTERN.test(sha)) fail(`${where}.sha`, 'must be a 40-character commit SHA')
    return {
      source: 'git',
      url: validateGitLocation(value.url, `${where}.url`),
      ref, sha,
      path: value.path === undefined ? undefined : normalizeRelativeRepoPath(value.path, `${where}.path`),
      sparsePaths: validateSparsePaths(value.sparsePaths, `${where}.sparsePaths`),
    }
  }
  if (source === 'directory' || source === 'file') {
    return { source, path: path.resolve(nonEmptyString(value.path, `${where}.path`)) }
  }
  fail(`${where}.source`, `unsupported source type: ${source}`)
}

function validatePluginSource(value: unknown, where: string): PluginSource {
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/\\/g, '/')
    if (!normalized.startsWith('./')) fail(where, 'relative plugin sources must start with ./')
    if (normalized === './') fail(where, 'must point to a plugin subdirectory, not the marketplace root')
    const parts = normalized.slice(2).split('/')
    if (parts.some(part => part === '..' || part === '.')) fail(where, 'contains unsafe path segments')
    return normalized
  }
  if (!isRecord(value)) fail(where, 'must be a relative path or a source object')
  const source = nonEmptyString(value.source, `${where}.source`)
  if (source === 'npm' || source === 'pip') {
    const pkg = nonEmptyString(value.package, `${where}.package`)
    const version = value.version === undefined ? undefined : nonEmptyString(value.version, `${where}.version`)
    const registry = value.registry === undefined ? undefined : validateUrl(value.registry, `${where}.registry`)
    return { source, package: pkg, version, registry }
  }
  if (source === 'github' || source === 'git' || source === 'url') {
    const base = source === 'github'
      ? (() => {
          const repo = nonEmptyString(value.repo, `${where}.repo`)
          if (!REPO_PATTERN.test(repo)) fail(`${where}.repo`, 'must use owner/repository format')
          return { source: 'github' as const, repo }
        })()
      : { source: source as 'git' | 'url', ...(source === 'git' ? { url: validateGitLocation(value.url, `${where}.url`) } : { url: validateUrl(value.url, `${where}.url`, true) }) }
    const ref = value.ref === undefined ? undefined : nonEmptyString(value.ref, `${where}.ref`)
    const sha = value.sha === undefined ? undefined : nonEmptyString(value.sha, `${where}.sha`)
    if (sha && !SHA_PATTERN.test(sha)) fail(`${where}.sha`, 'must be a 40-character commit SHA')
    return {
      ...base,
      ref,
      sha,
      path: value.path === undefined ? undefined : normalizeRelativeRepoPath(value.path, `${where}.path`),
      sparsePaths: validateSparsePaths(value.sparsePaths, `${where}.sparsePaths`),
    } as PluginSource
  }
  if (source === 'git-subdir') {
    const ref = value.ref === undefined ? undefined : nonEmptyString(value.ref, `${where}.ref`)
    const sha = value.sha === undefined ? undefined : nonEmptyString(value.sha, `${where}.sha`)
    if (sha && !SHA_PATTERN.test(sha)) fail(`${where}.sha`, 'must be a 40-character commit SHA')
    return {
      source: 'git-subdir',
      url: validateGitLocation(value.url, `${where}.url`),
      path: normalizeRelativeRepoPath(value.path, `${where}.path`),
      ref, sha,
    }
  }
  fail(`${where}.source`, `unsupported plugin source type: ${source}`)
}

export function assertMarketplaceManifest(value: unknown, source = '<memory>'): MarketplaceManifest {
  if (!isRecord(value)) fail(source, 'top level value must be an object')
  const name = safeName(value.name, `${source}.name`)
  if (!isRecord(value.owner)) fail(`${source}.owner`, 'must be an object')
  const ownerName = nonEmptyString(value.owner.name, `${source}.owner.name`)
  const ownerEmail = value.owner.email === undefined ? undefined : nonEmptyString(value.owner.email, `${source}.owner.email`)
  const ownerUrl = value.owner.url === undefined ? undefined : validateUrl(value.owner.url, `${source}.owner.url`)
  if (!Array.isArray(value.plugins)) fail(`${source}.plugins`, 'must be an array')
  const seen = new Set<string>()
  const plugins: MarketplacePluginEntry[] = []
  for (let i = 0; i < value.plugins.length; i++) {
    const item = value.plugins[i]
    if (!isRecord(item)) fail(`${source}.plugins[${i}]`, 'must be an object')
    const pluginName = safeName(item.name, `${source}.plugins[${i}].name`)
    if (seen.has(pluginName)) fail(`${source}.plugins`, `contains duplicate plugin name ${pluginName}`)
    seen.add(pluginName)
    const plugin: MarketplacePluginEntry = {
      ...item,
      name: pluginName,
      source: validatePluginSource(item.source, `${source}.plugins[${i}].source`),
    }
    if (item.version !== undefined) plugin.version = safeVersion(item.version, `${source}.plugins[${i}].version`)
    if (item.description !== undefined) plugin.description = nonEmptyString(item.description, `${source}.plugins[${i}].description`)
    if (item.category !== undefined) plugin.category = nonEmptyString(item.category, `${source}.plugins[${i}].category`)
    if (item.tags !== undefined) {
      if (!Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string' || !tag.trim())) fail(`${source}.plugins[${i}].tags`, 'must be an array of non-empty strings')
      plugin.tags = item.tags.map(tag => String(tag).trim())
    }
    if (item.dependencies !== undefined) {
      if (!Array.isArray(item.dependencies) || item.dependencies.some(dep => typeof dep !== 'string' || !dep.trim())) fail(`${source}.plugins[${i}].dependencies`, 'must be an array of non-empty strings')
      const dependencies = item.dependencies.map(dep => String(dep).trim())
      const seenDependencies = new Set<string>()
      for (const dep of dependencies) {
        const [depName, depMarketplace, ...extra] = dep.split('@')
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(depName || '') || extra.length > 0 || (depMarketplace !== undefined && !/^[a-z0-9][a-z0-9._-]*$/i.test(depMarketplace))) {
          fail(`${source}.plugins[${i}].dependencies`, `invalid plugin dependency identifier: ${dep}`)
        }
        if (seenDependencies.has(dep.toLowerCase())) fail(`${source}.plugins[${i}].dependencies`, `contains duplicate dependency ${dep}`)
        seenDependencies.add(dep.toLowerCase())
      }
      plugin.dependencies = dependencies
    }
    if (item.strict !== undefined && typeof item.strict !== 'boolean') fail(`${source}.plugins[${i}].strict`, 'must be boolean')
    plugins.push(plugin)
  }
  let metadata: MarketplaceManifest['metadata']
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) fail(`${source}.metadata`, 'must be an object')
    metadata = { ...value.metadata }
    if (value.metadata.pluginRoot !== undefined) metadata.pluginRoot = normalizeRelativeRepoPath(value.metadata.pluginRoot, `${source}.metadata.pluginRoot`)
    if (value.metadata.version !== undefined) metadata.version = nonEmptyString(value.metadata.version, `${source}.metadata.version`)
    if (value.metadata.description !== undefined) metadata.description = nonEmptyString(value.metadata.description, `${source}.metadata.description`)
  }
  if (value.forceRemoveDeletedPlugins !== undefined && typeof value.forceRemoveDeletedPlugins !== 'boolean') fail(`${source}.forceRemoveDeletedPlugins`, 'must be boolean')
  let allowCrossMarketplaceDependenciesOn: string[] | undefined
  if (value.allowCrossMarketplaceDependenciesOn !== undefined) {
    if (!Array.isArray(value.allowCrossMarketplaceDependenciesOn) || value.allowCrossMarketplaceDependenciesOn.some(item => typeof item !== 'string' || !item.trim())) fail(`${source}.allowCrossMarketplaceDependenciesOn`, 'must be an array of non-empty strings')
    allowCrossMarketplaceDependenciesOn = value.allowCrossMarketplaceDependenciesOn.map(item => safeName(item, `${source}.allowCrossMarketplaceDependenciesOn`))
  }
  return {
    ...value,
    name,
    owner: { name: ownerName, email: ownerEmail, url: ownerUrl },
    plugins,
    forceRemoveDeletedPlugins: value.forceRemoveDeletedPlugins as boolean | undefined,
    metadata,
    allowCrossMarketplaceDependenciesOn,
  }
}

export function isThirdPartySource(source: MarketplaceSource): boolean {
  return source.source === 'github' || source.source === 'git' || source.source === 'url'
}

const OFFICIAL_AUTO_UPDATE_MARKETPLACES = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'life-sciences',
])

export function defaultMarketplaceAutoUpdate(name: string, source?: MarketplaceSource): boolean {
  return Boolean(source && isThirdPartySource(source) && OFFICIAL_AUTO_UPDATE_MARKETPLACES.has(name.toLowerCase()))
}

export async function getMarketplaceAutoUpdate(name: string): Promise<boolean> {
  const normalized = safeCacheName(name)
  const known = await loadKnownMarketplaces()
  const state = known[normalized] ?? known[name]
  if (!state) throw new Error(`Marketplace not found: ${name}`)
  return state.autoUpdate ?? defaultMarketplaceAutoUpdate(normalized, state.source)
}

export async function setMarketplaceAutoUpdate(name: string, enabled: boolean): Promise<boolean> {
  const normalized = safeCacheName(name)
  const known = await loadKnownMarketplaces()
  const key = Object.hasOwn(known, normalized) ? normalized : name
  const state = known[key]
  if (!state) throw new Error(`Marketplace not found: ${name}`)
  state.autoUpdate = Boolean(enabled)
  await saveKnownMarketplaces(known)
  return state.autoUpdate
}

export function describeSource(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github': return `github:${source.repo}${source.ref ? `@${source.ref}` : ''}${source.sha ? `#${source.sha}` : ''}`
    case 'git': return `git:${redactCredentials(source.url)}${source.ref ? `@${source.ref}` : ''}${source.sha ? `#${source.sha}` : ''}`
    case 'url': return `url:${redactCredentials(source.url)}`
    case 'directory': return `directory:${source.path}`
    case 'file': return `file:${source.path}`
  }
}

function redactCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : ''
      parsed.password = parsed.password ? '***' : ''
      return parsed.toString()
    }
  } catch { /* scp-like or malformed, keep literal */ }
  if (/^[^@\s]+@[^:\s]+:/.test(url)) return url.replace(/^[^@\s]+@/, '***@')
  return url
}

function safeCacheName(name: string): string {
  const normalized = safeName(name, 'marketplace name')
  return normalized.toLowerCase()
}

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensurePrivateDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function loadKnownMarketplaces(): Promise<KnownMarketplacesFile> {
  try {
    const value = await readJsonFile<unknown>(knownMarketplacesPath())
    if (!isRecord(value)) throw new Error('top level value must be an object')
    const out = Object.create(null) as KnownMarketplacesFile
    for (const [name, entry] of Object.entries(value)) {
      safeName(name, `known_marketplaces key ${name}`)
      if (!isRecord(entry)) fail(`known_marketplaces.${name}`, 'must be an object')
      out[name] = validateKnownMarketplace(entry, `known_marketplaces.${name}`)
    }
    return out
  } catch (error) {
    if ((error as any).code === 'ENOENT') return {}
    throw new Error(`Failed to load known marketplaces: ${(error as Error).message}`)
  }
}

export async function loadKnownMarketplacesSafe(): Promise<KnownMarketplacesFile> {
  try { return await loadKnownMarketplaces() } catch { return {} }
}

function validateKnownMarketplace(value: Record<string, unknown>, where: string): KnownMarketplace {
  const source = validateMarketplaceSource(value.source, `${where}.source`)
  const installLocation = path.resolve(nonEmptyString(value.installLocation, `${where}.installLocation`))
  const lastUpdated = nonEmptyString(value.lastUpdated, `${where}.lastUpdated`)
  const status = value.status === undefined ? 'ready' : nonEmptyString(value.status, `${where}.status`)
  if (status !== 'ready' && status !== 'broken') fail(`${where}.status`, 'must be ready or broken')
  const revision = value.revision === undefined ? undefined : nonEmptyString(value.revision, `${where}.revision`)
  if (revision && !SHA_PATTERN.test(revision)) fail(`${where}.revision`, 'must be a full git commit SHA')
  const digest = value.digest === undefined ? undefined : nonEmptyString(value.digest, `${where}.digest`)
  if (digest && !/^sha256:[a-f0-9]{64}$/i.test(digest)) fail(`${where}.digest`, 'must be sha256:<64 hex characters>')
  const autoUpdate = value.autoUpdate === undefined ? undefined : value.autoUpdate
  if (autoUpdate !== undefined && typeof autoUpdate !== 'boolean') fail(`${where}.autoUpdate`, 'must be boolean')
  const error = value.error === undefined ? undefined : nonEmptyString(value.error, `${where}.error`)
  return { source, installLocation, lastUpdated, revision, digest, status: status as KnownMarketplace['status'], autoUpdate, error }
}

export async function saveKnownMarketplaces(value: KnownMarketplacesFile): Promise<void> {
  const normalized = Object.create(null) as KnownMarketplacesFile
  for (const [name, entry] of Object.entries(value)) {
    safeName(name, `known_marketplaces key ${name}`)
    normalized[name] = validateKnownMarketplace(entry as unknown as Record<string, unknown>, `known_marketplaces.${name}`)
  }
  await writeJsonAtomic(knownMarketplacesPath(), normalized)
}

function validateInstalledPluginRecord(value: unknown, where: string): import('./marketplace-types.js').InstalledPluginRecord {
  if (!isRecord(value)) fail(where, 'must be an object')
  const id = nonEmptyString(value.id, `${where}.id`)
  const marketplace = safeName(value.marketplace, `${where}.marketplace`)
  const plugin = safeName(value.plugin, `${where}.plugin`)
  const installPath = path.resolve(nonEmptyString(value.installPath, `${where}.installPath`))
  if (!path.isAbsolute(installPath)) fail(`${where}.installPath`, 'must be absolute')
  const version = nonEmptyString(value.version, `${where}.version`)
  const digest = nonEmptyString(value.digest, `${where}.digest`)
  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) fail(`${where}.digest`, 'must be sha256:<64 hex characters>')
  const source = validatePluginSource(value.source, `${where}.source`)
  const installedAt = nonEmptyString(value.installedAt, `${where}.installedAt`)
  const lastUpdated = nonEmptyString(value.lastUpdated, `${where}.lastUpdated`)
  const status = nonEmptyString(value.status, `${where}.status`)
  if (!['installed', 'update-available', 'broken', 'orphaned'].includes(status)) fail(`${where}.status`, 'must be an installed plugin status')
  const revision = value.revision === undefined ? undefined : nonEmptyString(value.revision, `${where}.revision`)
  if (revision && !SHA_PATTERN.test(revision)) fail(`${where}.revision`, 'must be a full git commit SHA')
  const enabled = value.enabled === undefined ? true : value.enabled
  if (typeof enabled !== 'boolean') fail(`${where}.enabled`, 'must be boolean')
  let dependencies: string[] | undefined
  if (value.dependencies !== undefined) {
    if (!Array.isArray(value.dependencies) || value.dependencies.some(item => typeof item !== 'string' || !item.trim())) fail(`${where}.dependencies`, 'must be an array of non-empty strings')
    dependencies = value.dependencies.map(item => String(item).trim())
  }
  const error = value.error === undefined ? undefined : nonEmptyString(value.error, `${where}.error`)
  return { id, marketplace, plugin, source, installPath, version, revision, digest, installedAt, lastUpdated, status: status as import('./marketplace-types.js').InstalledPluginRecord['status'], enabled, dependencies, error }
}

export async function loadInstalledPlugins(): Promise<import('./marketplace-types.js').InstalledPluginsFile> {
  try {
    const value = await readJsonFile<unknown>(installedPluginsPath())
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.plugins)) throw new Error('invalid installed_plugins.json schema')
    const plugins = Object.create(null) as import('./marketplace-types.js').InstalledPluginsFile['plugins']
    for (const [id, record] of Object.entries(value.plugins)) {
      plugins[id] = validateInstalledPluginRecord(record, `installed_plugins.plugins.${id}`)
    }
    return { version: 1, plugins }
  } catch (error) {
    if ((error as any).code === 'ENOENT') return { version: 1, plugins: Object.create(null) }
    throw new Error(`Failed to load installed plugins: ${(error as Error).message}`)
  }
}

export async function saveInstalledPlugins(value: import('./marketplace-types.js').InstalledPluginsFile): Promise<void> {
  if (value.version !== 1 || !isRecord(value.plugins)) throw new Error('Invalid installed plugins state')
  const plugins = Object.create(null) as import('./marketplace-types.js').InstalledPluginsFile['plugins']
  for (const [id, record] of Object.entries(value.plugins)) plugins[id] = validateInstalledPluginRecord(record, `installed_plugins.plugins.${id}`)
  await writeJsonAtomic(installedPluginsPath(), { version: 1, plugins })
}

async function fileDigest(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  hash.update(await fs.readFile(file))
  return `sha256:${hash.digest('hex')}`
}

async function treeDigest(root: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  async function walk(dir: string, relativeRoot: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a: any, b: any) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const absolute = path.join(dir, entry.name)
      const relative = path.join(relativeRoot, entry.name).split(path.sep).join('/')
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in plugin content: ${relative}`)
      if (entry.isDirectory()) {
        hash.update(`D:${relative}\n`)
        await walk(absolute, relative)
      } else if (entry.isFile()) {
        hash.update(`F:${relative}\n`)
        hash.update(await fs.readFile(absolute))
      }
    }
  }
  await walk(root, '')
  return `sha256:${hash.digest('hex')}`
}

async function git(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
    ...args,
  ], {
    cwd,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
  })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}

async function gitNoThrow(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await git(args, cwd)
    return { code: 0, ...result }
  } catch (error) {
    const e = error as any
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message ?? '') }
  }
}

function githubUrl(repo: string): string {
  return ` '')}.git`
}

async function cloneGit(url: string, target: string, ref?: string, sha?: string, sparsePaths?: string[]): Promise<string> {
  const sparse = sparsePaths && sparsePaths.length > 0
  if (sha) {
    await ensureDir(target)
    const init = await gitNoThrow(['init', '-q', target])
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`)
    const remote = await gitNoThrow(['remote', 'add', 'origin', url], target)
    if (remote.code !== 0) throw new Error(`git remote add failed: ${remote.stderr}`)
    if (sparse) {
      const sparseInit = await gitNoThrow(['sparse-checkout', 'init', '--cone'], target)
      if (sparseInit.code !== 0) throw new Error(`git sparse-checkout init failed: ${sparseInit.stderr}`)
      const sparseSet = await gitNoThrow(['sparse-checkout', 'set', '--', ...sparsePaths!], target)
      if (sparseSet.code !== 0) throw new Error(`git sparse-checkout set failed: ${sparseSet.stderr}`)
    }
    const fetchArgs = ['fetch', '--depth', '1']
    if (sparse) fetchArgs.push('--filter=blob:none')
    fetchArgs.push('origin', sha)
    const fetch = await gitNoThrow(fetchArgs, target)
    if (fetch.code !== 0) throw new Error(`git fetch ${sha} failed: ${fetch.stderr}`)
    const checkout = await gitNoThrow(['checkout', '--detach', 'FETCH_HEAD'], target)
    if (checkout.code !== 0) throw new Error(`git checkout failed: ${checkout.stderr}`)
  } else {
    const args = ['clone', '--depth', '1']
    if (sparse) args.push('--filter=blob:none', '--no-checkout')
    else args.push('--recurse-submodules', '--shallow-submodules')
    if (ref) args.push('--branch', ref)
    args.push(url, target)
    const result = await gitNoThrow(args)
    if (result.code !== 0) throw new Error(`git clone failed: ${result.stderr}`)
    if (sparse) {
      const sparseResult = await gitNoThrow(['sparse-checkout', 'set', '--cone', '--', ...sparsePaths!], target)
      if (sparseResult.code !== 0) throw new Error(`git sparse-checkout set failed: ${sparseResult.stderr}`)
      const checkout = await gitNoThrow(['checkout', 'HEAD'], target)
      if (checkout.code !== 0) throw new Error(`git checkout failed: ${checkout.stderr}`)
    }
  }
  const rev = await git(['rev-parse', 'HEAD'], target)
  return rev.stdout.trim()
}

async function readMarketplaceFromRoot(root: string, manifestPath?: string): Promise<{ marketplace: MarketplaceManifest; manifestFile: string; raw: string; digest: string }> {
  const relative = manifestPath ?? '.claude-plugin/marketplace.json'
  const candidate = path.resolve(root, relative)
  if (!within(root, candidate)) throw new Error(`Marketplace manifest escapes cache root: ${relative}`)
  const raw = await fs.readFile(candidate, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const marketplace = assertMarketplaceManifest(parsed, candidate)
  return { marketplace, manifestFile: candidate, raw, digest: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}` }
}

function marketplaceRootForFile(file: string): string {
  const absolute = path.resolve(file)
  return path.basename(path.dirname(absolute)) === '.claude-plugin' ? path.dirname(path.dirname(absolute)) : path.dirname(absolute)
}

async function stagePath(root: string, label: string): Promise<string> {
  await assertPathNotSymlink(root, 'marketplace cache root')
  await ensurePrivateDir(root)
  return path.join(root, `.${label}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
}

async function fetchMarketplace(source: MarketplaceSource, onProgress?: (event: MarketplaceProgressEvent) => void): Promise<{ name: string; root: string; revision?: string; digest: string }> {
  const cacheRoot = marketplaceCacheRoot()
  await ensurePrivateDir(cacheRoot)
  if (source.source === 'directory') {
    const root = path.resolve(source.path)
    const { marketplace, digest } = await readMarketplaceFromRoot(root)
    onProgress?.({ type: 'validate', marketplace: marketplace.name })
    return { name: marketplace.name, root, digest }
  }
  if (source.source === 'file') {
    const file = path.resolve(source.path)
    const root = marketplaceRootForFile(file)
    const { marketplace, digest } = await readMarketplaceFromRoot(root, path.relative(root, file))
    onProgress?.({ type: 'validate', marketplace: marketplace.name })
    return { name: marketplace.name, root, digest }
  }
  const temp = await stagePath(cacheRoot, 'marketplace')
  try {
    onProgress?.({ type: 'fetch', source: describeSource(source) })
    let revision: string | undefined
    let digest: string
    if (source.source === 'url') {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      let response: Response
      try {
        response = await fetch(source.url, { headers: source.headers, signal: controller.signal, redirect: 'follow' })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      const raw = await response.text()
      const parsed = JSON.parse(raw) as unknown
      const marketplace = assertMarketplaceManifest(parsed, source.url)
      await fs.mkdir(path.join(temp, '.claude-plugin'), { recursive: true })
      await fs.writeFile(path.join(temp, '.claude-plugin', 'marketplace.json'), raw, 'utf8')
      digest = `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`
      onProgress?.({ type: 'validate', marketplace: marketplace.name })
      return { name: marketplace.name, root: temp, digest }
    }
    const url = source.source === 'github' ? githubUrl(source.repo) : source.url
    const sparsePaths = source.sparsePaths && source.sparsePaths.length > 0
      ? Array.from(new Set([...source.sparsePaths, source.path ? path.posix.dirname(source.path) : '.claude-plugin']))
      : undefined
    revision = await cloneGit(url, temp, source.ref, source.sha, sparsePaths)
    if (source.sha && revision.toLowerCase() !== source.sha.toLowerCase()) throw new Error(`Pinned marketplace revision mismatch: expected ${source.sha}, got ${revision}`)
    const manifest = await readMarketplaceFromRoot(temp, source.path)
    digest = manifest.digest
    onProgress?.({ type: 'validate', marketplace: manifest.marketplace.name })
    return { name: manifest.marketplace.name, root: temp, revision, digest }
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true } catch { return false }
}

export async function addMarketplaceSource(sourceInput: MarketplaceSource, onProgress?: (event: MarketplaceProgressEvent) => void): Promise<MarketplaceResult> {
  const source = validateMarketplaceSource(sourceInput)
  if (source.source === 'directory' || source.source === 'file') source.path = path.resolve(source.path)
  const known = await loadKnownMarketplaces()
  for (const [name, entry] of Object.entries(known)) {
    if (JSON.stringify(entry.source) === JSON.stringify(source) && entry.status === 'ready') {
      try {
        const manifestRelative = source.source === 'url'
          ? '.claude-plugin/marketplace.json'
          : source.source === 'file'
            ? path.relative(entry.installLocation, source.path)
            : (source.source === 'directory' ? '.claude-plugin/marketplace.json' : (source.path ?? '.claude-plugin/marketplace.json'))
        const current = await readMarketplaceFromRoot(entry.installLocation, manifestRelative)
        if (current.marketplace.name !== name) continue
        if (source.source !== 'directory' && source.source !== 'file' && entry.digest && current.digest !== entry.digest) {
          throw new Error(`Marketplace cache integrity mismatch for ${name}: expected ${entry.digest}, got ${current.digest}`)
        }
        const reservedError = validateReservedMarketplaceNameSource(current.marketplace.name, source)
        if (reservedError) throw new Error(reservedError)
        return { name, installLocation: entry.installLocation, alreadyMaterialized: true, source, revision: entry.revision, digest: current.digest }
      } catch {
        // State claims the source is ready but the materialized cache is gone/corrupt.
        // Continue into a fresh materialization instead of trusting stale state.
      }
    }
  }

  const fetched = await fetchMarketplace(source, onProgress)
  const reservedError = validateReservedMarketplaceNameSource(fetched.name, source)
  if (reservedError) {
    if (source.source !== 'directory' && source.source !== 'file') await fs.rm(fetched.root, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(reservedError)
  }
  const cacheRoot = marketplaceCacheRoot()
  const finalPath = path.join(cacheRoot, safeCacheName(fetched.name))
  let installLocation = fetched.root
  let previousBackup: string | undefined
  const isRemote = source.source !== 'directory' && source.source !== 'file'

  try {
    if (isRemote) {
      // Stage the new cache beside the live entry. The old entry is only removed
      // after the state file has been persisted, so an interrupted update keeps
      // a usable previous cache instead of leaving the marketplace half-written.
      const staged = await stagePath(cacheRoot, 'marketplace-live')
      await fs.rename(fetched.root, staged)
      installLocation = finalPath
      if (await pathExists(finalPath)) {
        previousBackup = await stagePath(cacheRoot, 'marketplace-old')
        await fs.rename(finalPath, previousBackup)
      }
      await fs.rename(staged, finalPath)
    }

    const now = new Date().toISOString()
    const previous = known[fetched.name]
    known[fetched.name] = {
      source,
      installLocation,
      lastUpdated: now,
      revision: fetched.revision,
      digest: fetched.digest,
      status: 'ready',
    }
    if (previous && previous.installLocation !== installLocation && within(cacheRoot, previous.installLocation) && !isRemote) {
      // Local sources are never cache-owned, so there is deliberately nothing
      // to remove here. This branch only documents that distinction.
    }
    await saveKnownMarketplaces(known)
    if (previousBackup) await fs.rm(previousBackup, { recursive: true, force: true }).catch(() => undefined)
    onProgress?.({ type: 'ready', marketplace: fetched.name, revision: fetched.revision, digest: fetched.digest })
    return { name: fetched.name, installLocation, alreadyMaterialized: false, source, revision: fetched.revision, digest: fetched.digest }
  } catch (error) {
    if (isRemote) {
      await fs.rm(finalPath, { recursive: true, force: true }).catch(() => undefined)
      if (previousBackup) await fs.rename(previousBackup, finalPath).catch(() => undefined)
      else await fs.rm(fetched.root, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }
}
export async function refreshMarketplace(name: string, onProgress?: (event: MarketplaceProgressEvent) => void): Promise<MarketplaceResult> {
  const normalized = safeCacheName(name)
  const known = await loadKnownMarketplaces()
  const entry = known[normalized] ?? known[name]
  if (!entry) throw new Error(`Marketplace not found: ${name}`)

  let result: Awaited<ReturnType<typeof fetchMarketplace>>
  try {
    result = await fetchMarketplace(entry.source, onProgress)
    const reservedError = validateReservedMarketplaceNameSource(result.name, entry.source)
    if (reservedError) {
      if (entry.source.source !== 'directory' && entry.source.source !== 'file') await fs.rm(result.root, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(reservedError)
    }
  } catch (error) {
    entry.status = 'broken'
    entry.error = (error as Error).message
    await saveKnownMarketplaces(known).catch(() => undefined)
    throw error
  }
  const oldLocation = entry.installLocation
  let installLocation = oldLocation
  let previousBackup: string | undefined
  try {
    if (entry.source.source !== 'directory' && entry.source.source !== 'file') {
      const finalPath = path.join(marketplaceCacheRoot(), safeCacheName(result.name))
      const staged = await stagePath(marketplaceCacheRoot(), 'marketplace-refresh')
      await fs.rename(result.root, staged)
      if (await pathExists(finalPath)) {
        previousBackup = await stagePath(marketplaceCacheRoot(), 'marketplace-old')
        await fs.rename(finalPath, previousBackup)
      }
      await fs.rename(staged, finalPath)
      installLocation = finalPath
    }

    known[result.name] = {
      ...entry,
      installLocation,
      lastUpdated: new Date().toISOString(),
      revision: result.revision,
      digest: result.digest,
      status: 'ready',
      error: undefined,
    }
    if (normalized !== result.name) delete known[normalized]
    await saveKnownMarketplaces(known)
    if (previousBackup) await fs.rm(previousBackup, { recursive: true, force: true }).catch(() => undefined)
    return { name: result.name, installLocation, alreadyMaterialized: false, source: entry.source, revision: result.revision, digest: result.digest }
  } catch (error) {
    if (previousBackup && installLocation === path.join(marketplaceCacheRoot(), safeCacheName(result.name))) {
      await fs.rm(installLocation, { recursive: true, force: true }).catch(() => undefined)
      await fs.rename(previousBackup, installLocation).catch(() => undefined)
    } else if (entry.source.source !== 'directory' && entry.source.source !== 'file') {
      await fs.rm(result.root, { recursive: true, force: true }).catch(() => undefined)
    }
    entry.status = 'broken'
    entry.error = (error as Error).message
    await saveKnownMarketplaces(known).catch(() => undefined)
    throw error
  }
}
export async function refreshAllMarketplaces(onProgress?: (event: MarketplaceProgressEvent) => void): Promise<{ refreshed: string[]; failed: Array<{ name: string; error: string }> }> {
  const known = await loadKnownMarketplacesSafe()
  const refreshed: string[] = []
  const failed: Array<{ name: string; error: string }> = []
  for (const name of Object.keys(known)) {
    try {
      await refreshMarketplace(name, onProgress)
      refreshed.push(name)
    } catch (error) {
      failed.push({ name, error: (error as Error).message })
    }
  }
  return { refreshed, failed }
}

export async function removeMarketplace(name: string): Promise<void> {
  const known = await loadKnownMarketplaces()
  const entry = known[name]
  if (!entry) throw new Error(`Marketplace not found: ${name}`)
  if (entry.source.source !== 'directory' && entry.source.source !== 'file' && within(marketplaceCacheRoot(), entry.installLocation)) {
    await fs.rm(entry.installLocation, { recursive: true, force: true })
  }
  delete known[name]
  await saveKnownMarketplaces(known)
}

export async function getMarketplace(name: string): Promise<{ marketplace: MarketplaceManifest; installLocation: string; state: KnownMarketplace }> {
  const known = await loadKnownMarketplaces()
  const state = known[name]
  if (!state) throw new Error(`Marketplace not found: ${name}`)
  const manifestRelative = state.source.source === 'url' || state.source.source === 'directory'
    ? '.claude-plugin/marketplace.json'
    : state.source.source === 'file'
      ? path.relative(state.installLocation, state.source.path)
      : (state.source.path ?? '.claude-plugin/marketplace.json')
  if (state.source.source !== 'directory' && state.source.source !== 'file') {
    await assertRealpathWithin(marketplaceCacheRoot(), state.installLocation, 'marketplace cache path')
  }
  const { marketplace, digest } = await readMarketplaceFromRoot(state.installLocation, manifestRelative)
  const reservedError = validateReservedMarketplaceNameSource(marketplace.name, state.source)
  if (reservedError) throw new Error(reservedError)
  if (state.source.source !== 'directory' && state.source.source !== 'file' && state.digest && digest !== state.digest) {
    throw new Error(`Marketplace cache integrity mismatch for ${name}: expected ${state.digest}, got ${digest}`)
  }
  return { marketplace, installLocation: state.installLocation, state }
}

export async function reconcileMarketplaces(): Promise<{ ready: string[]; broken: string[] }> {
  const known = await loadKnownMarketplacesSafe()
  const ready: string[] = []
  const broken: string[] = []
  let dirty = false
  for (const [name, entry] of Object.entries(known)) {
    try {
      const root = entry.installLocation
      const manifestRelative = entry.source.source === 'url' || entry.source.source === 'directory'
        ? '.claude-plugin/marketplace.json'
        : entry.source.source === 'file'
          ? path.relative(entry.installLocation, entry.source.path)
          : (entry.source.path ?? '.claude-plugin/marketplace.json')
      if (entry.source.source !== 'directory' && entry.source.source !== 'file') {
        await assertRealpathWithin(marketplaceCacheRoot(), root, 'marketplace cache path')
      }
      const result = await readMarketplaceFromRoot(root, manifestRelative)
      const reservedError = validateReservedMarketplaceNameSource(result.marketplace.name, entry.source)
      if (reservedError) throw new Error(reservedError)
      if (entry.source.source !== 'directory' && entry.source.source !== 'file' && entry.digest && result.digest !== entry.digest) {
        throw new Error(`Marketplace cache integrity mismatch for ${name}: expected ${entry.digest}, got ${result.digest}`)
      }
      if (entry.source.source !== 'directory' && entry.source.source !== 'file' && entry.revision) {
        const cleanRevision = entry.revision.toLowerCase()
        if (cleanRevision.length !== 40) throw new Error(`Invalid stored marketplace revision for ${name}`)
      }
      entry.status = 'ready'
      entry.error = undefined
      if (entry.status !== 'ready') { entry.status = 'ready'; dirty = true }
      ready.push(name)
    } catch (error) {
      if (entry.status !== 'broken' || entry.error !== (error as Error).message) {
        entry.status = 'broken'
        entry.error = (error as Error).message
        dirty = true
      }
      broken.push(name)
    }
  }
  if (dirty) await saveKnownMarketplaces(known)
  return { ready, broken }
}

export async function validatePluginForInstallation(pluginRoot: string, expectedName?: string, requireManifest = true): Promise<{ version: string; digest: string; manifestPath?: string }> {
  try {
    const result = await readPluginManifest(pluginRoot)
    if (expectedName && result.manifest.name !== expectedName) throw new Error(`Plugin manifest name '${result.manifest.name}' does not match marketplace entry '${expectedName}'`)
    const digest = await treeDigest(pluginRoot)
    return { version: result.manifest.version ?? '0.0.0', digest, manifestPath: result.manifestPath }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (requireManifest || !message.includes('No plugin manifest found')) throw error
    const digest = await treeDigest(pluginRoot)
    return { version: '0.0.0', digest }
  }
}

export async function computePluginTreeDigest(pluginRoot: string): Promise<string> {
  return treeDigest(pluginRoot)
}

