export type MarketplaceSource =
  | { source: 'url'; url: string; headers?: Record<string, string> }
  | { source: 'github'; repo: string; ref?: string; sha?: string; path?: string; sparsePaths?: string[] }
  | { source: 'git'; url: string; ref?: string; sha?: string; path?: string; sparsePaths?: string[] }
  | { source: 'directory'; path: string }
  | { source: 'file'; path: string }

export type PluginSource =
  | string
  | { source: 'npm'; package: string; version?: string; registry?: string }
  | { source: 'pip'; package: string; version?: string; registry?: string }
  | { source: 'github'; repo: string; ref?: string; sha?: string; path?: string; sparsePaths?: string[] }
  | { source: 'git'; url: string; ref?: string; sha?: string; path?: string; sparsePaths?: string[] }
  | { source: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
  | { source: 'url'; url: string; ref?: string; sha?: string; path?: string; sparsePaths?: string[] }

export type MarketplacePluginEntry = {
  name: string
  source: PluginSource
  version?: string
  description?: string
  category?: string
  tags?: string[]
  strict?: boolean
  dependencies?: string[]
  [key: string]: unknown
}

export type MarketplaceManifest = {
  name: string
  owner: { name: string; email?: string; url?: string }
  plugins: MarketplacePluginEntry[]
  forceRemoveDeletedPlugins?: boolean
  metadata?: {
    pluginRoot?: string
    version?: string
    description?: string
    [key: string]: unknown
  }
  allowCrossMarketplaceDependenciesOn?: string[]
  [key: string]: unknown
}

export type KnownMarketplace = {
  source: MarketplaceSource
  installLocation: string
  lastUpdated: string
  revision?: string
  digest?: string
  status: 'ready' | 'broken'
  autoUpdate?: boolean
  error?: string
}

export type KnownMarketplacesFile = Record<string, KnownMarketplace>

export type InstalledPluginRecord = {
  id: string
  marketplace: string
  plugin: string
  source: PluginSource
  installPath: string
  version: string
  revision?: string
  digest: string
  installedAt: string
  lastUpdated: string
  status: 'installed' | 'update-available' | 'broken' | 'orphaned'
  enabled?: boolean
  dependencies?: string[]
  error?: string
}

export type InstalledPluginsFile = {
  version: 1
  plugins: Record<string, InstalledPluginRecord>
}

export type PluginTrustState = 'approved' | 'unapproved' | 'invalidated'

export type PluginState = {
  id: string
  marketplace: string
  plugin: string
  status: InstalledPluginRecord['status'] | 'not-installed'
  version?: string
  revision?: string
  digest?: string
  installPath?: string
  error?: string
  enabled?: boolean
  dependencies?: string[]
  trust?: PluginTrustState
}

export type MarketplaceProgressEvent =
  | { type: 'fetch'; source: string }
  | { type: 'validate'; marketplace: string }
  | { type: 'ready'; marketplace: string; revision?: string; digest?: string }

export type InstallPluginOptions = {
  thirdPartyConfirmed?: boolean
  onProgress?: (message: string) => void
}

export type MarketplaceResult = {
  name: string
  installLocation: string
  alreadyMaterialized: boolean
  source: MarketplaceSource
  revision?: string
  digest?: string
}
