import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expandHome, within } from '../util/fs.js'
import type { MarketplaceSource, PluginSource, PluginTrustState } from './marketplace-types.js'

export type PluginTrustApproval = {
  source: string
  digest: string
  revision?: string
  approvedAt: string
}

export type PluginSecurityRevocation = {
  digest?: string
  revision?: string
  reason?: string
  revokedAt?: string
}

export type PluginSecurityPolicy = {
  version: 1
  blockedPlugins?: string[]
  blockedMarketplaces?: string[]
  revokedPlugins?: Record<string, PluginSecurityRevocation>
  revokedDigests?: Record<string, string>
  revokedRevisions?: Record<string, string>
  trust?: Record<string, PluginTrustApproval>
}

const DEFAULT_POLICY: PluginSecurityPolicy = { version: 1 }
const RESERVED_MARKETPLACE_NAMES = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'life-sciences',
  'knowledge-work-plugins',
])
const OFFICIAL_GITHUB_ORG = 'anthropics'

function securityPolicyPath(): string {
  return expandHome('~/.termagent/plugins/security.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

export function sourceFingerprint(source: MarketplaceSource | PluginSource): string {
  const normalized = typeof source === 'string'
    ? source.trim().replace(/\\/g, '/')
    : canonicalize(source)
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.chmod(path.dirname(file), 0o700).catch(() => undefined)
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function normalizePolicy(value: unknown): PluginSecurityPolicy {
  if (!isRecord(value) || value.version !== 1) throw new Error('security policy must be a version 1 object')

  const stringList = (name: string): string[] | undefined => {
    const raw = value[name]
    if (raw === undefined) return undefined
    if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`security policy ${name} must be an array of non-empty strings`)
    return raw.map(item => item.trim())
  }

  const stringMap = (name: string): Record<string, string> | undefined => {
    const raw = value[name]
    if (raw === undefined) return undefined
    if (!isRecord(raw) || Object.values(raw).some(item => typeof item !== 'string')) throw new Error(`security policy ${name} must be an object of string reasons`)
    return Object.fromEntries(Object.entries(raw).map(([key, reason]) => [key, String(reason)]))
  }

  let revokedPlugins: Record<string, PluginSecurityRevocation> | undefined
  if (value.revokedPlugins !== undefined) {
    if (!isRecord(value.revokedPlugins)) throw new Error('security policy revokedPlugins must be an object')
    revokedPlugins = {}
    for (const [key, raw] of Object.entries(value.revokedPlugins)) {
      if (!isRecord(raw)) throw new Error(`security policy revokedPlugins.${key} must be an object`)
      if (raw.digest !== undefined && typeof raw.digest !== 'string') throw new Error(`security policy revokedPlugins.${key}.digest must be a string`)
      if (raw.revision !== undefined && typeof raw.revision !== 'string') throw new Error(`security policy revokedPlugins.${key}.revision must be a string`)
      if (raw.reason !== undefined && typeof raw.reason !== 'string') throw new Error(`security policy revokedPlugins.${key}.reason must be a string`)
      if (raw.revokedAt !== undefined && typeof raw.revokedAt !== 'string') throw new Error(`security policy revokedPlugins.${key}.revokedAt must be a string`)
      revokedPlugins[key] = { digest: raw.digest as string | undefined, revision: raw.revision as string | undefined, reason: raw.reason as string | undefined, revokedAt: raw.revokedAt as string | undefined }
    }
  }

  let trust: Record<string, PluginTrustApproval> | undefined
  if (value.trust !== undefined) {
    if (!isRecord(value.trust)) throw new Error('security policy trust must be an object')
    trust = {}
    for (const [key, raw] of Object.entries(value.trust)) {
      if (!isRecord(raw) || typeof raw.source !== 'string' || typeof raw.digest !== 'string' || typeof raw.approvedAt !== 'string') throw new Error(`security policy trust.${key} is malformed`)
      if (raw.revision !== undefined && typeof raw.revision !== 'string') throw new Error(`security policy trust.${key}.revision must be a string`)
      trust[key] = { source: raw.source, digest: raw.digest, revision: raw.revision as string | undefined, approvedAt: raw.approvedAt }
    }
  }

  return {
    version: 1,
    blockedPlugins: stringList('blockedPlugins'),
    blockedMarketplaces: stringList('blockedMarketplaces'),
    revokedPlugins,
    revokedDigests: stringMap('revokedDigests'),
    revokedRevisions: stringMap('revokedRevisions'),
    trust,
  }
}

export async function loadPluginSecurityPolicy(): Promise<PluginSecurityPolicy> {
  try {
    return normalizePolicy(JSON.parse(await fs.readFile(securityPolicyPath(), 'utf8')))
  } catch (error) {
    if ((error as any)?.code === 'ENOENT') return { ...DEFAULT_POLICY }
    throw new Error(`Failed to load plugin security policy: ${(error as Error).message}`)
  }
}

export async function savePluginSecurityPolicy(policy: PluginSecurityPolicy): Promise<void> {
  await atomicWrite(securityPolicyPath(), normalizePolicy(policy))
}

export async function updatePluginSecurityPolicy(update: (policy: PluginSecurityPolicy) => void): Promise<PluginSecurityPolicy> {
  const policy = await loadPluginSecurityPolicy()
  update(policy)
  await savePluginSecurityPolicy(policy)
  return policy
}

export function isPluginBlocked(policy: PluginSecurityPolicy, pluginId: string): boolean {
  return Boolean(policy.blockedPlugins?.some(id => id.toLowerCase() === pluginId.toLowerCase()))
}

export function isMarketplaceBlocked(policy: PluginSecurityPolicy, marketplaceName: string): boolean {
  return Boolean(policy.blockedMarketplaces?.some(id => id.toLowerCase() === marketplaceName.toLowerCase()))
}

export function getRevocationReason(policy: PluginSecurityPolicy, pluginId: string, digest?: string, revision?: string): string | undefined {
  if (digest && policy.revokedDigests?.[digest]) return policy.revokedDigests[digest]
  if (revision && policy.revokedRevisions?.[revision]) return policy.revokedRevisions[revision]
  const entry = policy.revokedPlugins?.[pluginId]
  if (!entry) return undefined
  if (entry.digest && digest !== entry.digest) return undefined
  if (entry.revision && revision !== entry.revision) return undefined
  return entry.reason || 'plugin is revoked by security policy'
}

export async function evaluatePluginSecurity(pluginId: string, marketplaceName: string, digest?: string, revision?: string): Promise<{ blocked: boolean; reason?: string }> {
  const policy = await loadPluginSecurityPolicy()
  if (isMarketplaceBlocked(policy, marketplaceName)) return { blocked: true, reason: `marketplace '${marketplaceName}' is blocked by security policy` }
  if (isPluginBlocked(policy, pluginId)) return { blocked: true, reason: `plugin '${pluginId}' is blocked by security policy` }
  const revoked = getRevocationReason(policy, pluginId, digest, revision)
  if (revoked) return { blocked: true, reason: revoked }
  return { blocked: false }
}

export function getPluginTrustState(policy: PluginSecurityPolicy, pluginId: string, source: PluginSource, digest: string, revision?: string): PluginTrustState {
  const approval = policy.trust?.[pluginId]
  if (!approval) return 'unapproved'
  if (approval.source !== sourceFingerprint(source) || approval.digest !== digest || approval.revision !== revision) return 'invalidated'
  return 'approved'
}

export async function getStoredPluginTrust(pluginId: string, source: PluginSource, digest: string, revision?: string): Promise<PluginTrustState> {
  const policy = await loadPluginSecurityPolicy()
  return getPluginTrustState(policy, pluginId, source, digest, revision)
}

export async function approvePluginTrust(pluginId: string, source: PluginSource, digest: string, revision?: string): Promise<void> {
  await updatePluginSecurityPolicy(policy => {
    policy.trust = policy.trust || {}
    policy.trust[pluginId] = {
      source: sourceFingerprint(source), digest, revision, approvedAt: new Date().toISOString(),
    }
  })
}

export async function revokePluginTrust(pluginId: string): Promise<void> {
  await updatePluginSecurityPolicy(policy => {
    policy.trust = policy.trust || {}
    delete policy.trust[pluginId]
  })
}

export async function assertPathNotSymlink(target: string, label = 'path'): Promise<void> {
  try {
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${target}`)
  } catch (error) {
    if ((error as any)?.code === 'ENOENT') return
    throw error
  }
}

export async function assertRealpathWithin(root: string, target: string, label = 'path'): Promise<string> {
  await assertPathNotSymlink(root, `${label} security root`)
  const realRoot = await fs.realpath(root)
  const realTarget = await fs.realpath(target)
  if (!within(realRoot, realTarget)) throw new Error(`${label} escapes security root: ${target}`)
  return realTarget
}

export async function assertInstalledPluginContained(installPath: string): Promise<string> {
  return assertRealpathWithin(expandHome('~/.termagent/plugins/cache'), installPath, 'installed plugin path')
}

export function validateReservedMarketplaceNameSource(name: string, source: MarketplaceSource): string | null {
  const normalizedName = name.trim().toLowerCase()
  if (!RESERVED_MARKETPLACE_NAMES.has(normalizedName)) return null

  if (source.source === 'github') {
    const org = source.repo.split('/')[0]?.toLowerCase()
    return org === OFFICIAL_GITHUB_ORG
      ? null
      : `The name '${name}' is reserved for official Anthropic marketplaces. Only repositories from 'github.com/${OFFICIAL_GITHUB_ORG}/' can use this name.`
  }

  if (source.source === 'git') {
    const hostPath = extractHostAndFirstPathSegment(source.url)
    if (hostPath?.host === 'github.com' && hostPath.firstSegment === OFFICIAL_GITHUB_ORG) return null
    return `The name '${name}' is reserved for official Anthropic marketplaces. Only repositories from 'github.com/${OFFICIAL_GITHUB_ORG}/' can use this name.`
  }

  return `The name '${name}' is reserved for official Anthropic marketplaces and can only be used with GitHub sources from the '${OFFICIAL_GITHUB_ORG}' organization.`
}

function extractHostAndFirstPathSegment(raw: string): { host: string; firstSegment: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (!trimmed.includes('://')) {
    const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(trimmed)
    if (!scp) return null
    const first = scp[2]!.replace(/^\/+/, '').split('/')[0]
    return first ? { host: scp[1]!.toLowerCase(), firstSegment: first.toLowerCase() } : null
  }
  try {
    const parsed = new URL(trimmed)
    const first = parsed.pathname.replace(/^\/+/, '').split('/')[0]
    return first ? { host: parsed.hostname.toLowerCase(), firstSegment: first.toLowerCase() } : null
  } catch {
    return null
  }
}

export function getReservedMarketplaceNames(): string[] {
  return [...RESERVED_MARKETPLACE_NAMES].sort()
}
