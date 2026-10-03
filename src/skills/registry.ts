import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureDir, expandHome, within } from '../util/fs.js'
import { scanSkillContent, type SkillSecurityFinding, type SkillSecurityStatus } from './security.js'

export type SkillTrustTier = 'official' | 'verified' | 'community' | 'deprecated'

export type SkillRegistryEntry = {
  id: string
  name: string
  description: string
  version: string
  license?: string
  trust: SkillTrustTier
  source: string
  sha256: string
  repo?: string
  path?: string
  homepage?: string
  title?: string
  category?: string
  tags?: string[]
  author?: string
}

export type SkillRegistryRevocation = {
  id: string
  version?: string
  sha256?: string
  reason?: string
  revokedAt?: string
}

export type SkillRegistryDocument = {
  version?: number
  name?: string
  description?: string
  skills: SkillRegistryEntry[]
  revocations?: SkillRegistryRevocation[] | string[]
  revocationsUrl?: string
}

export type SkillRegistryConfig = {
  id: string
  url: string
  revocationsUrl?: string
  addedAt: string
  lastFetchedAt?: string
  lastSuccessAt?: string
  registryDigest?: string
  revision?: string
  stale?: boolean
  error?: string
}

export type InstalledRegistrySkill = {
  id: string
  registryId: string
  name: string
  version: string
  source: string
  sha256: string
  path: string
  trust: SkillTrustTier
  installedAt: string
  updatedAt: string
  status: 'installed' | 'revoked' | 'broken'
  error?: string
}

export type SkillRegistryTrustApproval = {
  registryId: string
  skillId: string
  source: string
  version: string
  sha256: string
  trust: SkillTrustTier
  approvedAt: string
}

export type SkillRegistrySecurityState = {
  version: 1
  trust?: Record<string, SkillRegistryTrustApproval>
  revoked?: Record<string, { reason?: string; revokedAt?: string }>
}

export type RemoteSkillArtifact = {
  content: string
  sha256: string
  securityStatus: SkillSecurityStatus
  securityFindings: SkillSecurityFinding[]
  bytes: number
  url: string
}

export type SkillRegistryProvider = {
  fetchRegistry: (url: string) => Promise<{ document: SkillRegistryDocument; digest: string; raw: string }>
  fetchSkill: (url: string) => Promise<RemoteSkillArtifact>
  fetchRevocations?: (url: string) => Promise<SkillRegistryRevocation[]>
}

export type SkillRegistryState = {
  registries: Record<string, SkillRegistryConfig>
}

function registryStateDir(): string { return expandHome('~/.termagent/skill-registries') }
function registryConfigPath(): string { return path.join(registryStateDir(), 'registries.json') }
function installedPath(): string { return path.join(registryStateDir(), 'installed.json') }
function securityPath(): string { return path.join(registryStateDir(), 'security.json') }
function cacheDir(): string { return path.join(registryStateDir(), 'cache') }
function installDir(): string { return path.join(registryStateDir(), 'installed') }
function skillCacheDir(): string { return path.join(cacheDir(), 'skills') }
const REGISTRY_STATE_VERSION = 1
const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const REMOTE_FETCH_TIMEOUT_MS = 30_000
const MAX_REGISTRY_BYTES = 512 * 1024
const MAX_REVOCATION_BYTES = 256 * 1024
const MAX_SKILL_BYTES = 64 * 1024
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i
const ID_RE = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/i

function digest(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`
}

function normalizeRegistryId(id: string): string {
  const value = id.trim().toLowerCase()
  if (!NAME_RE.test(value)) throw new Error(`Invalid skill registry id: ${id}`)
  return value
}

function normalizeSkillId(id: string): { registryNamespace: string; skillName: string; normalized: string } {
  const value = id.trim().toLowerCase()
  const match = ID_RE.exec(value)
  if (!match) throw new Error(`Invalid skill registry skill id: ${id} (expected namespace/name)`)
  return { registryNamespace: match[1]!, skillName: match[2]!, normalized: value }
}

function validateUrl(url: string, label: string): string {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`${label} must be a valid URL`) }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(`${label} must use http or https`)
  if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') {
    throw new Error(`${label} must use https unless it targets localhost`)
  }
  return url.trim()
}

function validateSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase()
  if (/^sha256:[0-9a-f]{64}$/.test(normalized)) return normalized
  if (/^[0-9a-f]{64}$/.test(normalized)) return `sha256:${normalized}`
  throw new Error(`${label} must be a SHA-256 digest`)
}

function validateTrust(value: unknown): SkillTrustTier {
  if (value === 'official' || value === 'verified' || value === 'community' || value === 'deprecated') return value
  throw new Error(`invalid skill trust tier: ${String(value)}`)
}

function readFrontmatterScalar(content: string, key: string): string | undefined {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return undefined
  const block = normalized.slice(4, end)
  const line = block.split('\n').find(value => value.trimStart().startsWith(`${key}:`))
  if (!line) return undefined
  const raw = line.slice(line.indexOf(':') + 1).trim()
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1)
  return raw
}

function assertSkillIdentity(content: string, entry: SkillRegistryEntry): void {
  const name = readFrontmatterScalar(content, 'name')
  const version = readFrontmatterScalar(content, 'version')
  if (name !== entry.name) throw new Error(`skill frontmatter name mismatch: registry=${entry.name}, fetched=${name || '(missing)'}`)
  if (version !== entry.version) throw new Error(`skill frontmatter version mismatch: registry=${entry.version}, fetched=${version || '(missing)'}`)
}

function resolveRemoteUrl(raw: string, baseUrl: string | undefined, label: string): string {
  try {
    const resolved = baseUrl ? new URL(raw, baseUrl).toString() : raw
    return validateUrl(resolved, label)
  } catch (error) {
    throw error instanceof Error ? error : new Error(`${label} must be a valid URL`)
  }
}

function validateEntry(raw: unknown, baseUrl?: string): SkillRegistryEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('registry skill entry must be an object')
  const v = raw as Record<string, unknown>
  const id = String(v.id ?? '').trim().toLowerCase()
  const parsed = normalizeSkillId(id)
  if (parsed.skillName !== String(v.name ?? parsed.skillName).trim().toLowerCase()) {
    throw new Error(`registry entry ${id} has mismatched name`)
  }
  const description = String(v.description ?? '').trim()
  if (!description) throw new Error(`registry entry ${id} is missing description`)
  const version = String(v.version ?? '').trim()
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`registry entry ${id} has invalid version`)
  const rawSource = String(v.source ?? '').trim()
  const source = resolveRemoteUrl(rawSource, baseUrl, `registry entry ${id} source`)
  const sha256 = validateSha256(String(v.sha256 ?? ''), `registry entry ${id} sha256`)
  const tags = v.tags === undefined ? undefined : Array.isArray(v.tags) && v.tags.every(x => typeof x === 'string' && NAME_RE.test(x)) ? v.tags.map(String) : (() => { throw new Error(`registry entry ${id} tags must be an array of names`) })()
  return {
    id,
    name: parsed.skillName,
    description,
    version,
    license: typeof v.license === 'string' ? v.license : undefined,
    trust: validateTrust(v.trust),
    source,
    sha256,
    repo: typeof v.repo === 'string' ? v.repo : undefined,
    path: typeof v.path === 'string' ? v.path : undefined,
    homepage: typeof v.homepage === 'string' ? v.homepage : undefined,
    title: typeof v.title === 'string' ? v.title : undefined,
    category: typeof v.category === 'string' ? v.category : undefined,
    tags,
    author: typeof v.author === 'string' ? v.author : undefined,
  }
}

function normalizeRevocation(raw: unknown): SkillRegistryRevocation {
  if (typeof raw === 'string') {
    const value = raw.trim()
    const at = value.lastIndexOf('@')
    if (at <= 0 || at === value.length - 1) throw new Error(`invalid skill revocation id: ${raw}`)
    const id = value.slice(0, at).toLowerCase()
    normalizeSkillId(id)
    return { id, version: value.slice(at + 1) }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('skill revocation must be a string or object')
  const v = raw as Record<string, unknown>
  const id = String(v.id ?? '').trim().toLowerCase()
  normalizeSkillId(id)
  return {
    id,
    version: v.version === undefined ? undefined : String(v.version),
    sha256: v.sha256 === undefined ? undefined : validateSha256(String(v.sha256), `revocation ${id} sha256`),
    reason: v.reason === undefined ? undefined : String(v.reason),
    revokedAt: v.revokedAt === undefined ? undefined : String(v.revokedAt),
  }
}

function validateDocument(raw: unknown, baseUrl?: string): SkillRegistryDocument {
  const array = Array.isArray(raw)
  const root = array ? { skills: raw } : raw
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('skill registry must be a JSON array or object')
  const v = root as Record<string, unknown>
  if (!Array.isArray(v.skills)) throw new Error('skill registry must contain a skills array')
  const seen = new Set<string>()
  const skills = v.skills.map(entry => validateEntry(entry, baseUrl)).map(entry => {
    if (seen.has(entry.id)) throw new Error(`duplicate skill id in registry: ${entry.id}`)
    seen.add(entry.id)
    return entry
  })
  let revocations: SkillRegistryRevocation[] | undefined
  if (v.revocations !== undefined) {
    if (!Array.isArray(v.revocations)) throw new Error('registry revocations must be an array')
    revocations = v.revocations.map(normalizeRevocation)
  }
  const revocationsUrl = v.revocationsUrl === undefined ? undefined : resolveRemoteUrl(String(v.revocationsUrl), baseUrl, 'registry revocationsUrl')
  return {
    version: typeof v.version === 'number' ? v.version : undefined,
    name: typeof v.name === 'string' ? v.name : undefined,
    description: typeof v.description === 'string' ? v.description : undefined,
    skills,
    revocations,
    revocationsUrl,
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function loadJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T } catch { return fallback }
}

class RemoteHttpError extends Error {
  readonly status: number

  constructor(label: string, status: number) {
    super(`${label}: HTTP ${status}`)
    this.name = 'RemoteHttpError'
    this.status = status
  }
}

async function fetchRemoteText(url: string, label: string, maxBytes: number): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    // fetch follows redirects. Revalidate the final URL so an HTTPS source
    // cannot silently downgrade to cleartext HTTP during retrieval.
    validateUrl(response.url, label)
    if (!response.ok) throw new RemoteHttpError(label, response.status)
    const declaredLength = response.headers.get('content-length')
    if (declaredLength && Number.parseInt(declaredLength, 10) > maxBytes) {
      throw new Error(`${label} exceeds the maximum supported size (${maxBytes} bytes)`)
    }
    if (!response.body) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytesRead = 0
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maxBytes) {
        await reader.cancel()
        throw new Error(`${label} exceeds the maximum supported size (${maxBytes} bytes)`)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${label} timed out after ${REMOTE_FETCH_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function createSkillRegistryProvider(): SkillRegistryProvider {
  return {
    async fetchRegistry(url: string) {
      const text = await fetchRemoteText(url, 'registry fetch failed', MAX_REGISTRY_BYTES)
      let raw: unknown
      try { raw = JSON.parse(text) } catch { throw new Error('registry fetch returned invalid JSON') }
      const document = validateDocument(raw, url)
      return { document, digest: digest(text), raw: text }
    },
    async fetchRevocations(url: string) {
      const text = await fetchRemoteText(url, 'revocation fetch failed', MAX_REVOCATION_BYTES)
      let raw: unknown
      try { raw = JSON.parse(text) } catch { throw new Error('revocation fetch returned invalid JSON') }
      if (!Array.isArray(raw)) throw new Error('revocations.json must contain an array')
      return raw.map(normalizeRevocation)
    },
    async fetchSkill(url: string) {
      const content = await fetchRemoteText(url, 'skill fetch failed', MAX_SKILL_BYTES)
      const bytes = Buffer.byteLength(content, 'utf8')
      const security = scanSkillContent(content)
      return { content, sha256: digest(content), securityStatus: security.status, securityFindings: security.findings, bytes, url }
    },
  }
}

async function ensureSafeDirectory(root: string): Promise<void> {
  const absolute = path.resolve(root)
  const home = path.resolve(process.env.HOME || process.cwd())
  if (!within(home, absolute)) throw new Error(`registry path escapes HOME: ${absolute}`)
  const parts = absolute.slice(home.length).split(path.sep).filter(Boolean)
  let current = home
  for (const part of parts) {
    current = path.join(current, part)
    try {
      const s = await fs.lstat(current)
      if (s.isSymbolicLink()) throw new Error(`registry directory must not contain symlinks: ${current}`)
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') continue
      throw error
    }
  }
  await ensureDir(absolute)
}

async function saveRegistryCache(registryId: string, raw: string): Promise<void> {
  const dir = path.join(cacheDir(), registryId)
  await ensureSafeDirectory(dir)
  await atomicWrite(path.join(dir, 'registry.json'), raw)
}

async function saveRevocationsCache(registryId: string, revocations: SkillRegistryRevocation[]): Promise<void> {
  const dir = path.join(cacheDir(), registryId)
  await ensureSafeDirectory(dir)
  await atomicWrite(path.join(dir, 'revocations.json'), `${JSON.stringify(revocations, null, 2)}\n`)
}

async function loadRevocationsCache(registryId: string): Promise<{ revocations: SkillRegistryRevocation[]; fetchedAt: number } | null> {
  const file = path.join(cacheDir(), registryId, 'revocations.json')
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const fetchedAt = (await fs.stat(file)).mtimeMs
    return { revocations: parsed.map(normalizeRevocation), fetchedAt }
  } catch {
    return null
  }
}

async function clearRegistryCache(registryId: string): Promise<void> {
  await fs.rm(path.join(cacheDir(), registryId), { recursive: true, force: true })
}

async function loadRegistryCache(registryId: string, registryUrl: string): Promise<{ document: SkillRegistryDocument; raw: string; digest: string; fetchedAt: number } | null> {
  const file = path.join(cacheDir(), registryId, 'registry.json')
  try {
    const raw = await fs.readFile(file, 'utf8')
    const document = validateDocument(JSON.parse(raw), registryUrl)
    const fetchedAt = (await fs.stat(file)).mtimeMs
    return { document, raw, digest: digest(raw), fetchedAt }
  } catch {
    return null
  }
}

function initialState(): SkillRegistryState {
  return { registries: Object.create(null) as Record<string, SkillRegistryConfig> }
}

function normalizeStoredRegistry(value: unknown, fallbackId: string): SkillRegistryConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = normalizeRegistryId(String(raw.id ?? fallbackId))
  const url = validateUrl(String(raw.url ?? ''), `skill registry '${id}' URL`)
  const revocationsUrl =
    raw.revocationsUrl === undefined
      ? undefined
      : validateUrl(String(raw.revocationsUrl), `skill registry '${id}' revocations URL`)
  const addedAt = typeof raw.addedAt === 'string' && raw.addedAt ? raw.addedAt : new Date(0).toISOString()
  const config: SkillRegistryConfig = { id, url, addedAt }
  if (revocationsUrl) config.revocationsUrl = revocationsUrl
  if (typeof raw.lastFetchedAt === 'string') config.lastFetchedAt = raw.lastFetchedAt
  if (typeof raw.lastSuccessAt === 'string') config.lastSuccessAt = raw.lastSuccessAt
  if (typeof raw.registryDigest === 'string') config.registryDigest = raw.registryDigest
  if (typeof raw.revision === 'string') config.revision = raw.revision
  if (typeof raw.stale === 'boolean') config.stale = raw.stale
  if (typeof raw.error === 'string') config.error = raw.error
  return config
}

async function loadState(): Promise<SkillRegistryState> {
  const state = await loadJson(registryConfigPath(), initialState())
  if (!state || typeof state !== 'object' || Array.isArray(state)) return initialState()
  const rawRegistries = (state as Record<string, unknown>).registries
  if (!rawRegistries || typeof rawRegistries !== 'object' || Array.isArray(rawRegistries)) return initialState()
  const registries = Object.create(null) as Record<string, SkillRegistryConfig>
  for (const [key, value] of Object.entries(rawRegistries as Record<string, unknown>)) {
    try {
      const normalized = normalizeStoredRegistry(value, key)
      if (normalized) registries[normalized.id] = normalized
    } catch {
      // Ignore malformed individual entries instead of poisoning the whole state file.
    }
  }
  return { registries }
}

async function saveState(state: SkillRegistryState): Promise<void> {
  await atomicWrite(registryConfigPath(), `${JSON.stringify({ version: REGISTRY_STATE_VERSION, ...state }, null, 2)}\n`)
}

async function loadInstalledMap(): Promise<Record<string, InstalledRegistrySkill>> {
  const data = await loadJson(installedPath(), { version: 1, skills: {} as Record<string, InstalledRegistrySkill> })
  if (!data || typeof data !== 'object' || !data.skills || typeof data.skills !== 'object') return {}
  return data.skills
}

async function saveInstalledMap(skills: Record<string, InstalledRegistrySkill>): Promise<void> {
  await atomicWrite(installedPath(), `${JSON.stringify({ version: 1, skills }, null, 2)}\n`)
}

async function loadSecurityState(): Promise<SkillRegistrySecurityState> {
  const state = await loadJson(securityPath(), { version: 1 } as SkillRegistrySecurityState)
  if (!state || state.version !== 1) throw new Error('skill registry security state is malformed')
  return state
}

async function saveSecurityState(state: SkillRegistrySecurityState): Promise<void> {
  await atomicWrite(securityPath(), `${JSON.stringify(state, null, 2)}\n`)
}

function trustKey(entry: Pick<SkillRegistryTrustApproval, 'registryId'|'skillId'>): string {
  return `${entry.registryId}:${entry.skillId}`
}

function revokedMatch(entry: SkillRegistryEntry, revocations: SkillRegistryRevocation[]): SkillRegistryRevocation | undefined {
  return revocations.find(item => item.id === entry.id && (!item.version || item.version === entry.version) && (!item.sha256 || item.sha256 === entry.sha256))
}

function revocationsUrlFor(registry: SkillRegistryConfig, document: SkillRegistryDocument): string | undefined {
  if (document.revocationsUrl) return document.revocationsUrl
  if (registry.revocationsUrl) return registry.revocationsUrl
  try {
    const parsed = new URL(registry.url)
    if (parsed.pathname.endsWith('/registry.json')) {
      parsed.pathname = `${parsed.pathname.slice(0, -'registry.json'.length)}revocations.json`
      return parsed.toString()
    }
  } catch {
    return undefined
  }
  return undefined
}

function isRemoteNotFound(error: unknown): boolean {
  return error instanceof RemoteHttpError && error.status === 404
}

async function resolveRevocations(
  provider: SkillRegistryProvider,
  registry: SkillRegistryConfig,
  document: SkillRegistryDocument,
): Promise<SkillRegistryRevocation[]> {
  const fromDocument = document.revocations ? document.revocations.map(normalizeRevocation) : []
  if (fromDocument.length > 0) return fromDocument

  const url = revocationsUrlFor(registry, document)
  if (!url || !provider.fetchRevocations) return []

  try {
    const revocations = await provider.fetchRevocations(url)
    await saveRevocationsCache(registry.id, revocations)
    return revocations
  } catch (error) {
    const cached = await loadRevocationsCache(registry.id)
    if (cached && !isStale(cached.fetchedAt)) return cached.revocations
    if (isRemoteNotFound(error)) return cached?.revocations ?? []
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to obtain the skill revocation list for registry '${registry.id}': ${message}`)
  }
}

function isStale(fetchedAt?: number, maxAgeMs = DEFAULT_STALE_AFTER_MS): boolean {
  return !fetchedAt || Date.now() - fetchedAt > maxAgeMs
}

export async function listSkillRegistries(): Promise<SkillRegistryConfig[]> {
  const state = await loadState()
  return Object.values(state.registries).sort((a, b) => a.id.localeCompare(b.id))
}

export async function addSkillRegistry(
  id: string,
  url: string,
  options: { revocationsUrl?: string } = {},
): Promise<SkillRegistryConfig> {
  const registryId = normalizeRegistryId(id)
  const normalizedUrl = validateUrl(url, 'skill registry URL')
  const normalizedRevocationsUrl =
    options.revocationsUrl === undefined
      ? undefined
      : validateUrl(options.revocationsUrl, 'revocations URL')
  const state = await loadState()
  const existing = state.registries[registryId]
  const sourceChanged = existing !== undefined && existing.url !== normalizedUrl
  const revocationSourceChanged =
    existing !== undefined &&
    normalizedRevocationsUrl !== undefined &&
    existing.revocationsUrl !== normalizedRevocationsUrl
  const value: SkillRegistryConfig = existing
    ? { ...existing, id: registryId, url: normalizedUrl }
    : { id: registryId, url: normalizedUrl, addedAt: new Date().toISOString() }
  if (normalizedRevocationsUrl !== undefined) value.revocationsUrl = normalizedRevocationsUrl
  else if (existing && sourceChanged) delete value.revocationsUrl
  state.registries[registryId] = value
  if (sourceChanged || revocationSourceChanged) {
    await clearRegistryCache(registryId)
  }
  await saveState(state)
  return value
}

export async function removeSkillRegistry(id: string): Promise<void> {
  const registryId = normalizeRegistryId(id)
  const state = await loadState()
  delete state.registries[registryId]
  await saveState(state)
  await clearRegistryCache(registryId)
}

export async function getSkillRegistry(id: string): Promise<SkillRegistryConfig | undefined> {
  const state = await loadState()
  return state.registries[normalizeRegistryId(id)]
}

export async function refreshSkillRegistry(id: string, options: { provider?: SkillRegistryProvider; maxAgeMs?: number } = {}): Promise<{ registry: SkillRegistryConfig; document: SkillRegistryDocument; stale: boolean; fromCache: boolean }> {
  const registryId = normalizeRegistryId(id)
  const state = await loadState()
  const registry = state.registries[registryId]
  if (!registry) throw new Error(`Unknown skill registry: ${registryId}`)
  const provider = options.provider || createSkillRegistryProvider()
  try {
    const result = await provider.fetchRegistry(registry.url)
    await saveRegistryCache(registryId, result.raw)
    const now = new Date().toISOString()
    registry.lastFetchedAt = now
    registry.lastSuccessAt = now
    registry.registryDigest = result.digest
    registry.stale = false
    registry.error = undefined
    await saveState(state)
    return { registry, document: result.document, stale: false, fromCache: false }
  } catch (error) {
    const cached = await loadRegistryCache(registryId, registry.url)
    registry.lastFetchedAt = new Date().toISOString()
    registry.stale = true
    registry.error = error instanceof Error ? error.message : String(error)
    await saveState(state)
    if (!cached) throw new Error(`${registry.error}; no offline registry cache is available`)
    const stale = isStale(cached.fetchedAt, options.maxAgeMs)
    registry.registryDigest = cached.digest
    return { registry, document: cached.document, stale, fromCache: true }
  }
}

export async function listRegistrySkills(id: string, options: { query?: string; provider?: SkillRegistryProvider; allowStale?: boolean } = {}): Promise<{ registry: SkillRegistryConfig; skills: SkillRegistryEntry[]; revocations: SkillRegistryRevocation[]; stale: boolean; fromCache: boolean }> {
  const result = await refreshSkillRegistry(id, { provider: options.provider })
  if (result.stale && options.allowStale === false) throw new Error(`skill registry '${id}' metadata is stale`)
  const revocations = await resolveRevocations(options.provider || createSkillRegistryProvider(), result.registry, result.document)
  if (revocations.length > 0) await mergeRemoteRevocations(revocations)
  const query = options.query?.trim().toLowerCase()
  const skills = result.document.skills.filter(entry => {
    if (!query) return true
    const haystack = `${entry.id} ${entry.name} ${entry.description} ${entry.category || ''} ${(entry.tags || []).join(' ')}`.toLowerCase()
    return haystack.includes(query)
  })
  return { registry: result.registry, skills, revocations, stale: result.stale, fromCache: result.fromCache }
}

export async function getSkillRegistryRevocationState(input: { id: string; version: string; sha256: string }): Promise<{ revoked: boolean; reason?: string }> {
  const entry = {
    id: input.id.trim().toLowerCase(),
    name: normalizeSkillId(input.id).skillName,
    description: '',
    version: input.version,
    source: 'https://invalid.local/skill.md',
    sha256: input.sha256,
    trust: 'community' as const,
  }
  return isLocallyRevoked(entry)
}

export async function approveSkillRegistryTrust(entry: SkillRegistryEntry, registryId: string): Promise<void> {
  const state = await loadSecurityState()
  state.trust = state.trust || {}
  state.trust[trustKey({ registryId, skillId: entry.id })] = {
    registryId,
    skillId: entry.id,
    source: entry.source,
    version: entry.version,
    sha256: entry.sha256,
    trust: entry.trust,
    approvedAt: new Date().toISOString(),
  }
  await saveSecurityState(state)
}

export async function getSkillRegistryTrustState(registryId: string, entry: SkillRegistryEntry): Promise<'approved'|'unapproved'|'invalidated'> {
  const state = await loadSecurityState()
  const approval = state.trust?.[trustKey({ registryId, skillId: entry.id })]
  if (!approval) return 'unapproved'
  if (approval.source !== entry.source || approval.version !== entry.version || approval.sha256 !== entry.sha256 || approval.trust !== entry.trust) return 'invalidated'
  return 'approved'
}

async function mergeRemoteRevocations(revocations: SkillRegistryRevocation[]): Promise<void> {
  const state = await loadSecurityState()
  state.revoked = state.revoked || {}
  for (const revocation of revocations) {
    const key = `${revocation.id}@${revocation.version || '*'}${revocation.sha256 ? `:${revocation.sha256}` : ''}`
    state.revoked[key] = { reason: revocation.reason, revokedAt: revocation.revokedAt }
  }
  await saveSecurityState(state)
}

async function isLocallyRevoked(entry: SkillRegistryEntry): Promise<{ revoked: boolean; reason?: string }> {
  const state = await loadSecurityState()
  for (const [key, value] of Object.entries(state.revoked || {})) {
    const [base, hash] = key.split(':')
    const at = base.lastIndexOf('@')
    const id = at > 0 ? base.slice(0, at) : base
    const version = at > 0 ? base.slice(at + 1) : '*'
    if (id === entry.id && (version === '*' || version === entry.version) && (!hash || hash === entry.sha256)) return { revoked: true, reason: value.reason }
  }
  return { revoked: false }
}

async function skillCachePathFor(registryId: string, entry: SkillRegistryEntry): Promise<string> {
  const parsed = normalizeSkillId(entry.id)
  const root = path.join(skillCacheDir(), normalizeRegistryId(registryId), parsed.skillName, entry.version)
  await ensureSafeDirectory(root)
  return path.join(root, 'SKILL.md')
}

async function loadCachedSkillArtifact(registryId: string, entry: SkillRegistryEntry): Promise<RemoteSkillArtifact | null> {
  const file = await skillCachePathFor(registryId, entry)
  try {
    const link = await fs.lstat(file)
    if (link.isSymbolicLink()) return null
    const stat = await fs.stat(file)
    if (stat.size > MAX_SKILL_BYTES) return null
    const content = await fs.readFile(file, 'utf8')
    if (digest(content) !== entry.sha256) return null
    const security = scanSkillContent(content)
    if (security.status === 'blocked') return null
    assertSkillIdentity(content, entry)
    return { content, sha256: digest(content), securityStatus: security.status, securityFindings: security.findings, bytes: Buffer.byteLength(content, 'utf8'), url: entry.source }
  } catch {
    return null
  }
}

async function cacheSkillArtifact(registryId: string, entry: SkillRegistryEntry, content: string): Promise<void> {
  const file = await skillCachePathFor(registryId, entry)
  const root = path.dirname(file)
  await ensureSafeDirectory(root)
  try {
    const existing = await fs.lstat(file)
    if (existing.isSymbolicLink()) throw new Error(`cached skill path must not be a symlink: ${file}`)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }
  await atomicWrite(file, content)
}

async function installPathFor(registryId: string, entry: SkillRegistryEntry): Promise<string> {
  const parsed = normalizeSkillId(entry.id)
  const targetRoot = path.join(installDir(), normalizeRegistryId(registryId), parsed.skillName, entry.version)
  await ensureSafeDirectory(targetRoot)
  return path.join(targetRoot, 'SKILL.md')
}

function expectedInstallPath(record: Pick<InstalledRegistrySkill, 'registryId' | 'id' | 'version'>): string {
  const parsed = normalizeSkillId(record.id)
  return path.resolve(installDir(), normalizeRegistryId(record.registryId), parsed.skillName, record.version, 'SKILL.md')
}

export async function isRegistrySkillPathSafe(record: Pick<InstalledRegistrySkill, 'registryId' | 'id' | 'version' | 'path'>): Promise<boolean> {
  try {
    const expected = expectedInstallPath(record)
    if (path.resolve(record.path) !== expected) return false
    const base = await fs.realpath(installDir())
    const root = await fs.realpath(path.dirname(expected))
    const actual = await fs.realpath(expected)
    return within(base, root) && within(root, actual)
  } catch {
    return false
  }
}

export async function installSkillFromRegistry(registryIdInput: string, skillIdInput: string, options: { provider?: SkillRegistryProvider; confirm?: boolean; allowStale?: boolean } = {}): Promise<InstalledRegistrySkill> {
  const registryId = normalizeRegistryId(registryIdInput)
  const skillId = normalizeSkillId(skillIdInput).normalized
  const provider = options.provider || createSkillRegistryProvider()
  const result = await listRegistrySkills(registryId, { provider })
  if (result.stale && options.allowStale !== true) throw new Error(`skill registry '${registryId}' metadata is stale; refresh it before installing`)
  const entry = result.skills.find(item => item.id === skillId)
  if (!entry) throw new Error(`Skill '${skillId}' not found in registry '${registryId}'`)

  const revoked = revokedMatch(entry, result.revocations)
  if (revoked) {
    await mergeRemoteRevocations([revoked])
    throw new Error(`Skill '${skillId}@${entry.version}' is revoked${revoked.reason ? `: ${revoked.reason}` : ''}`)
  }
  const localRevocation = await isLocallyRevoked(entry)
  if (localRevocation.revoked) throw new Error(`Skill '${skillId}@${entry.version}' is revoked${localRevocation.reason ? `: ${localRevocation.reason}` : ''}`)

  const trust = await getSkillRegistryTrustState(registryId, entry)
  if (trust !== 'approved' && !options.confirm) {
    throw new Error(`Trust approval required for ${skillId}@${entry.version} (registry=${registryId}, trust=${entry.trust}). Review the skill before installing.`)
  }

  let artifact = await loadCachedSkillArtifact(registryId, entry)
  if (!artifact) artifact = await provider.fetchSkill(entry.source)
  if (artifact.securityStatus === 'blocked') throw new Error(`Skill '${skillId}' is blocked by content security policy (${artifact.securityFindings.map(f => `${f.code} line ${f.line}`).join(', ')})`)
  if (artifact.bytes > MAX_SKILL_BYTES) throw new Error(`Skill '${skillId}' is too large to install`)
  if (artifact.sha256 !== entry.sha256) throw new Error(`Digest mismatch for ${skillId}: registry=${entry.sha256}, fetched=${artifact.sha256}`)
  assertSkillIdentity(artifact.content, entry)
  await cacheSkillArtifact(registryId, entry, artifact.content)
  const targetPath = await installPathFor(registryId, entry)
  const root = path.dirname(targetPath)
  const realRoot = path.resolve(root)
  await ensureSafeDirectory(realRoot)
  try {
    const existing = await fs.lstat(targetPath)
    if (existing.isSymbolicLink()) throw new Error(`installed skill path must not be a symlink: ${targetPath}`)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }
  const installed = await loadInstalledMap()
  const previousRecord = installed[entry.id]
  await atomicWrite(targetPath, artifact.content)
  const written = await fs.readFile(targetPath, 'utf8')
  if (digest(written) !== entry.sha256) {
    await fs.rm(root, { recursive: true, force: true })
    throw new Error(`Installed skill digest verification failed for ${skillId}`)
  }

  const record: InstalledRegistrySkill = {
    id: entry.id,
    registryId,
    name: entry.name,
    version: entry.version,
    source: entry.source,
    sha256: entry.sha256,
    path: targetPath,
    trust: entry.trust,
    installedAt: installed[entry.id]?.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'installed',
  }
  try {
    // Persist the exact approval only after the artifact has passed security,
    // digest, and frontmatter checks. The approval remains valid solely for
    // this source/version/digest/trust tuple.
    if (options.confirm && trust !== 'approved') await approveSkillRegistryTrust(entry, registryId)
    installed[entry.id] = record
    await saveInstalledMap(installed)
  } catch (error) {
    // If this was a brand-new install, do not leave an orphaned skill body
    // behind when durable state publication fails. Existing installations
    // are preserved because the target artifact is already exact and safe.
    if (!previousRecord || previousRecord.path !== targetPath) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }
  return record
}

export async function uninstallRegistrySkill(skillIdInput: string): Promise<void> {
  const skillId = normalizeSkillId(skillIdInput).normalized
  const installed = await loadInstalledMap()
  const record = installed[skillId]
  if (!record) return
  if (!(await isRegistrySkillPathSafe(record))) throw new Error(`Refusing to remove unsafe registry skill path: ${record.path}`)
  const root = path.dirname(record.path)
  await fs.rm(root, { recursive: true, force: true })
  delete installed[skillId]
  await saveInstalledMap(installed)
}

export async function listInstalledRegistrySkills(): Promise<InstalledRegistrySkill[]> {
  const skills = await loadInstalledMap()
  return Object.values(skills).sort((a, b) => a.id.localeCompare(b.id))
}

export async function verifyInstalledRegistrySkill(skillIdInput: string): Promise<{ ok: boolean; reason?: string }> {
  const skillId = normalizeSkillId(skillIdInput).normalized
  const installed = await loadInstalledMap()
  const record = installed[skillId]
  if (!record) return { ok: false, reason: `Skill '${skillId}' is not installed` }
  const revoked = await isLocallyRevoked({ id: record.id, name: record.name, description: '', version: record.version, source: record.source, sha256: record.sha256, trust: record.trust })
  if (revoked.revoked) {
    record.status = 'revoked'
    record.error = revoked.reason || 'revoked'
    await saveInstalledMap(installed)
    return { ok: false, reason: record.error }
  }
  try {
    const installBase = await fs.realpath(installDir())
    const realRoot = await fs.realpath(path.dirname(record.path))
    const realPath = await fs.realpath(record.path)
    if (!within(installBase, realRoot)) throw new Error('skill install root escapes the registry install directory')
    if (!within(realRoot, realPath)) throw new Error('skill path escapes its install root')
    const stat = await fs.stat(realPath)
    if (!stat.isFile()) throw new Error('skill path is not a regular file')
    const content = await fs.readFile(realPath, 'utf8')
    const security = scanSkillContent(content)
    if (security.status === 'blocked') throw new Error(`skill content is blocked by security policy (${security.findings.map(f => f.code).join(', ')})`)
    const actual = digest(content)
    if (actual !== record.sha256) throw new Error(`digest mismatch: expected ${record.sha256}, got ${actual}`)
    record.status = 'installed'
    record.error = undefined
    await saveInstalledMap(installed)
    return { ok: true }
  } catch (error) {
    record.status = 'broken'
    record.error = error instanceof Error ? error.message : String(error)
    await saveInstalledMap(installed)
    return { ok: false, reason: record.error }
  }
}

export function getSkillRegistryInstallRoot(): string { return installDir() }
export function getSkillRegistryCacheRoot(): string { return cacheDir() }
