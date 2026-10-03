import { promises as fs } from 'node:fs'
import path from 'node:path'
import { installedPluginsRoot, marketplaceCacheRoot, loadInstalledPlugins, saveInstalledPlugins } from './marketplace.js'
import { getPluginState } from './plugin-install.js'
import { qualifyDependencyReference } from './dependency-resolver.js'
import type { PluginState } from './marketplace-types.js'

async function removeMatchingTemporaryEntries(root: string, matcher: RegExp): Promise<string[]> {
  const removed: string[] = []
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !matcher.test(entry.name)) continue
      const target = path.join(root, entry.name)
      try {
        await fs.rm(target, { recursive: true, force: true })
        removed.push(target)
      } catch {
        // A concurrent cleanup is harmless. The important part is that we do
        // not treat an inability to remove one stale staging directory as a
        // reason to discard valid installed state.
      }
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  return removed
}

export async function cleanupInterruptedPluginOperations(): Promise<string[]> {
  const removed: string[] = []
  removed.push(...await removeMatchingTemporaryEntries(marketplaceCacheRoot(), /^\..+\.tmp-/))

  try {
    const marketplaces = await fs.readdir(installedPluginsRoot(), { withFileTypes: true })
    for (const marketplace of marketplaces) {
      if (!marketplace.isDirectory()) continue
      const marketplacePath = path.join(installedPluginsRoot(), marketplace.name)
      const plugins = await fs.readdir(marketplacePath, { withFileTypes: true }).catch(() => [])
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue
        removed.push(...await removeMatchingTemporaryEntries(path.join(marketplacePath, plugin.name), /^\.install-/))
      }
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  return removed
}

function dependencyError(pluginId: string, dependency: string): string {
  return `Plugin ${pluginId} cannot remain enabled because dependency ${dependency} is not installed and enabled`
}

export async function reconcileInstalledPluginState(): Promise<{
  states: PluginState[]
  changed: string[]
  dependencyBroken: string[]
}> {
  const installed = await loadInstalledPlugins()
  const states: PluginState[] = []
  const changed: string[] = []

  for (const record of Object.values(installed.plugins).sort((a, b) => a.id.localeCompare(b.id))) {
    const beforeStatus = record.status
    const beforeError = record.error
    const state = await getPluginState(record.marketplace, record.plugin)
    states.push(state)
    record.status = state.status === 'not-installed' ? 'orphaned' : state.status
    record.error = state.error
    if (state.dependencies) record.dependencies = [...state.dependencies]
    if (beforeStatus !== record.status || beforeError !== record.error) changed.push(record.id)
  }

  const enabled = new Set(
    Object.values(installed.plugins)
      .filter(record => (record.status === 'installed' || record.status === 'update-available') && record.enabled !== false)
      .map(record => record.id.toLowerCase()),
  )
  const dependencyBroken: string[] = []
  for (const record of Object.values(installed.plugins).sort((a, b) => a.id.localeCompare(b.id))) {
    if (record.status !== 'installed' || record.enabled === false || !record.dependencies?.length) continue
    for (const raw of record.dependencies) {
      const dependency = qualifyDependencyReference(raw, record.id)
      if (!enabled.has(dependency.toLowerCase())) {
        record.status = 'broken'
        record.error = dependencyError(record.id, dependency)
        dependencyBroken.push(record.id)
        if (!changed.includes(record.id)) changed.push(record.id)
        break
      }
    }
  }

  await saveInstalledPlugins(installed)
  return { states, changed, dependencyBroken }
}

export async function reconcilePluginStateOnStartup(): Promise<{
  cleaned: string[]
  changed: string[]
  dependencyBroken: string[]
}> {
  const cleaned = await cleanupInterruptedPluginOperations()
  const result = await reconcileInstalledPluginState()
  return { cleaned, changed: result.changed, dependencyBroken: result.dependencyBroken }
}
