import { getMarketplaceAutoUpdate, loadKnownMarketplaces, refreshMarketplace } from './marketplace.js'
import { installPlugin, getPluginState } from './plugin-install.js'
import type { InstallPluginOptions } from './marketplace-types.js'

function isAutoUpdateDisabledByEnvironment(): boolean {
  const value = process.env.TERMAGENT_AUTO_UPDATE?.trim().toLowerCase()
  return value === '0' || value === 'false' || value === 'off' || value === 'no'
}

export type PluginUpdateCycleResult = {
  marketplaces: string[]
  refreshed: string[]
  refreshFailures: Array<{ name: string; error: string }>
  updated: string[]
  updateFailures: Array<{ id: string; error: string }>
}

export async function updateConfiguredPlugins(options: InstallPluginOptions = {}): Promise<PluginUpdateCycleResult> {
  if (isAutoUpdateDisabledByEnvironment()) {
    return { marketplaces: [], refreshed: [], refreshFailures: [], updated: [], updateFailures: [] }
  }

  const known = await loadKnownMarketplaces()
  const marketplaces: string[] = []
  for (const name of Object.keys(known).sort((a, b) => a.localeCompare(b))) {
    if (await getMarketplaceAutoUpdate(name)) marketplaces.push(name)
  }

  const refreshed: string[] = []
  const refreshFailures: Array<{ name: string; error: string }> = []
  for (const name of marketplaces) {
    try {
      await refreshMarketplace(name)
      refreshed.push(name)
    } catch (error) {
      refreshFailures.push({ name, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const updated: string[] = []
  const updateFailures: Array<{ id: string; error: string }> = []
  const refreshedSet = new Set(marketplaces.map(name => name.toLowerCase()))
  const current = await import('./marketplace.js').then(m => m.loadInstalledPlugins())
  for (const record of Object.values(current.plugins).sort((a, b) => a.id.localeCompare(b.id))) {
    if (record.enabled === false || record.status === 'broken' || !refreshedSet.has(record.marketplace.toLowerCase())) continue
    try {
      const state = await getPluginState(record.marketplace, record.plugin)
      if (state.status !== 'update-available') continue
      const result = await installPlugin(record.marketplace, record.plugin, { ...options, thirdPartyConfirmed: true })
      if (result.status !== 'installed') throw new Error(result.error || `update failed for ${record.id}`)
      updated.push(record.id)
    } catch (error) {
      updateFailures.push({ id: record.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { marketplaces, refreshed, refreshFailures, updated, updateFailures }
}

export function autoUpdatePluginsInBackground(options: InstallPluginOptions = {}): void {
  void updateConfiguredPlugins(options).catch(() => undefined)
}
