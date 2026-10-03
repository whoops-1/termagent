export type PluginAuthor = {
  name: string
  email?: string
  url?: string
}

export type PluginCommandMetadata = {
  source?: string
  content?: string
  description?: string
  argumentHint?: string
  model?: string
  allowedTools?: string[]
}

export type PluginManifest = {
  name: string
  version?: string
  description?: string
  author?: PluginAuthor | string
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  dependencies?: string[]
  commands?: string | string[] | Record<string, PluginCommandMetadata>
  agents?: string | string[]
  skills?: string | string[]
  hooks?: unknown
  mcpServers?: unknown
  outputStyles?: string | string[]
  settings?: Record<string, unknown>
  channels?: unknown
  lspServers?: unknown
}

export type PluginManifestLocation = '.claude-plugin/plugin.json' | '.termagent-plugin/plugin.json'

export type PluginPackage = {
  manifest: PluginManifest
  root: string
  manifestPath: string
  manifestLocation: PluginManifestLocation
  source: 'project' | 'user' | 'configured'
}

export type PluginDiscoveryResult = {
  packages: PluginPackage[]
  errors: Array<{ path: string; error: string }>
}
