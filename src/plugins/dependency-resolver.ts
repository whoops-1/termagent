function parsePluginIdentifier(plugin: string): { name: string; marketplace?: string } {
  const [name, marketplace] = plugin.split('@')
  return marketplace ? { name: name || '', marketplace } : { name: name || '' }
}
import type { MarketplaceManifest, MarketplacePluginEntry } from './marketplace-types.js'

export type PluginId = string

export type DependencyResolutionError =
  | { reason: 'cycle'; chain: PluginId[] }
  | { reason: 'not-found'; missing: PluginId; requiredBy: PluginId }
  | { reason: 'cross-marketplace'; dependency: PluginId; requiredBy: PluginId }

export type DependencyResolutionResult =
  | { ok: true; closure: PluginId[] }
  | { ok: false; error: DependencyResolutionError }

function qualifyDependency(dep: string, declaringId: PluginId): PluginId {
  if (dep.includes('@')) return dep
  const marketplace = parsePluginIdentifier(declaringId).marketplace
  return marketplace ? `${dep}@${marketplace}` : dep
}

function normalizeMarketplaceName(name: string): string {
  return name.toLowerCase()
}

function pluginId(name: string, marketplace: string): string {
  return `${name}@${marketplace}`
}

export type DependencyGraph = Map<PluginId, MarketplacePluginEntry>

export function buildDependencyGraph(
  marketplaces: ReadonlyMap<string, MarketplaceManifest>,
): DependencyGraph {
  const graph = new Map<PluginId, MarketplacePluginEntry>()
  for (const [marketplaceName, marketplace] of marketplaces) {
    for (const entry of marketplace.plugins) {
      graph.set(pluginId(entry.name, marketplaceName), entry)
    }
  }
  return graph
}

export async function resolveDependencyClosure(
  rootId: PluginId,
  marketplaces: ReadonlyMap<string, MarketplaceManifest>,
  alreadyInstalled: ReadonlySet<PluginId> = new Set(),
): Promise<DependencyResolutionResult> {
  const graph = buildDependencyGraph(marketplaces)
  const root = parsePluginIdentifier(rootId)
  if (!root.marketplace) {
    return {
      ok: false,
      error: {
        reason: 'not-found',
        missing: rootId,
        requiredBy: rootId,
      },
    }
  }
  const rootMarketplace = marketplaces.get(root.marketplace)
  if (!rootMarketplace) {
    return {
      ok: false,
      error: {
        reason: 'not-found',
        missing: rootId,
        requiredBy: rootId,
      },
    }
  }

  const allowCross = new Set(
    (rootMarketplace.allowCrossMarketplaceDependenciesOn ?? []).map(normalizeMarketplaceName),
  )
  const closure: PluginId[] = []
  const visiting: string[] = []
  const visited = new Set<string>()

  const walk = async (id: PluginId, requiredBy: PluginId): Promise<DependencyResolutionError | null> => {
    if (id !== rootId && alreadyInstalled.has(id)) return null
    if (visiting.includes(id)) {
      return { reason: 'cycle', chain: [...visiting, id] }
    }
    if (visited.has(id)) return null

    const parsed = parsePluginIdentifier(id)
    const marketplaceName = parsed.marketplace
    if (!marketplaceName) {
      return { reason: 'not-found', missing: id, requiredBy }
    }
    const normalizedMarketplace = normalizeMarketplaceName(marketplaceName)
    const normalizedRoot = normalizeMarketplaceName(root.marketplace!)
    if (normalizedMarketplace !== normalizedRoot && !allowCross.has(normalizedMarketplace)) {
      return { reason: 'cross-marketplace', dependency: id, requiredBy }
    }

    const entry = graph.get(id)
    if (!entry) {
      // Marketplace names are case-insensitive for the resolver, but plugin IDs
      // retain the catalog spelling. Find the canonical key without guessing.
      const canonical = [...graph.keys()].find(key => key.toLowerCase() === id.toLowerCase())
      if (!canonical) return { reason: 'not-found', missing: id, requiredBy }
      return walk(canonical, requiredBy)
    }

    visited.add(id)
    visiting.push(id)
    for (const raw of entry.dependencies ?? []) {
      if (typeof raw !== 'string' || !raw.trim()) {
        return { reason: 'not-found', missing: raw || '<invalid dependency>', requiredBy: id }
      }
      const dependency = qualifyDependency(raw.trim(), id)
      const error = await walk(dependency, id)
      if (error) return error
    }
    visiting.pop()
    closure.push(id)
    return null
  }

  const error = await walk(rootId, rootId)
  return error ? { ok: false, error } : { ok: true, closure }
}

export function formatDependencyResolutionError(error: DependencyResolutionError): string {
  switch (error.reason) {
    case 'cycle':
      return `Dependency cycle detected: ${error.chain.join(' -> ')}`
    case 'not-found':
      return `Dependency "${error.missing}" required by "${error.requiredBy}" was not found in the configured marketplaces`
    case 'cross-marketplace':
      return `Dependency "${error.dependency}" required by "${error.requiredBy}" crosses marketplace boundaries without an explicit allowlist entry`
  }
}

export function findMissingInstalledDependencies(
  records: ReadonlyMap<PluginId, { enabled?: boolean; dependencies?: string[]; status?: 'installed' | 'update-available' | 'broken' | 'orphaned' }>,
): Array<{ pluginId: PluginId; dependency: PluginId }> {
  const enabled = new Set([...records.entries()].filter(([, record]) => record.enabled !== false && (record.status === undefined || record.status === 'installed' || record.status === 'update-available')).map(([id]) => id))
  const missing: Array<{ pluginId: PluginId; dependency: PluginId }> = []
  for (const [id, record] of records) {
    if (record.enabled === false) continue
    for (const raw of record.dependencies ?? []) {
      const dependency = qualifyDependency(raw, id)
      if (!enabled.has(dependency)) missing.push({ pluginId: id, dependency })
    }
  }
  return missing
}

export function qualifyDependencyReference(dep: string, declaringId: string): string {
  return qualifyDependency(dep, declaringId)
}
