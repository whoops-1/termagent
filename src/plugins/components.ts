import { promises as fs } from 'node:fs'
import path from 'node:path'
import { computePluginTreeDigest, loadInstalledPlugins } from './marketplace.js'
import { readPluginManifest, resolvePluginComponentPath } from './manifest.js'
import type { PluginManifest } from './types.js'
import type { CustomAgent, CustomCommand } from '../agent/custom.js'
import type { MCPServer } from '../config/config.js'
import { loadPluginHooks } from './hooks.js'
import type { PluginHookSpec, PluginHooks } from './hooks.js'
import { parseFrontmatterText } from '../agent/custom.js'
import { installedPluginsRoot } from './marketplace.js'
import { within } from '../util/fs.js'
import { assertRealpathWithin, evaluatePluginSecurity } from './security.js'

export type PluginProvenance = {
  pluginId: string
  pluginName: string
  marketplace: string
  version: string
  installPath: string
}

export type PluginCommand = CustomCommand & {
  allowedTools?: string[]
  plugin: PluginProvenance
}

export type PluginAgent = CustomAgent & {
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[]
  plugin: PluginProvenance
}

export type PluginMCPServer = MCPServer & {
  pluginId: string
  pluginName: string
  marketplace: string
  serverName: string
}

export type PluginComponentLoadOptions = {
  /** Inspect disabled installs for management UI without activating them. */
  includeDisabled?: boolean
}

export type PluginComponentLoadResult = {
  commands: PluginCommand[]
  agents: PluginAgent[]
  mcpServers: Record<string, PluginMCPServer>
  hooks: PluginHooks
  errors: Array<{ plugin: string; component: string; error: string }>
}

function unique<T>(values: T[]): T[] { return [...new Set(values)] }

async function isFile(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isFile() } catch { return false }
}

async function isDirectory(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory() } catch { return false }
}

async function readText(p: string): Promise<string> { return fs.readFile(p, 'utf8') }

async function collectMarkdown(root: string): Promise<string[]> {
  if (!await isDirectory(root)) return []
  const realRoot = await fs.realpath(root).catch(() => null)
  if (!realRoot) return []
  const out: string[] = []
  const visited = new Set<string>()
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()!
    let real: string
    try { real = await fs.realpath(current) } catch { continue }
    if (!within(realRoot, real) || visited.has(real)) continue
    visited.add(real)
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [] as any[])
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name.startsWith('.')) continue
      const child = path.join(current, entry.name)
      if (entry.isDirectory() || entry.isSymbolicLink()) stack.push(child)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(child)
    }
  }
  return out.sort()
}

function scalar(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key]
  return value === undefined || value === null ? undefined : String(value).trim() || undefined
}

function list(meta: Record<string, unknown>, key: string): string[] | undefined {
  const value = meta[key]
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map(String).map(x => x.trim()).filter(Boolean)
  return String(value).split(/[,\s]+/).map(x => x.trim()).filter(Boolean)
}

function resolveDeclaredPaths(root: string, declared: string | string[] | undefined, fallback: string): string[] {
  const raw = declared === undefined ? [fallback] : Array.isArray(declared) ? declared : [declared]
  const out: string[] = []
  for (const entry of unique([fallback, ...raw])) {
    try { out.push(resolvePluginComponentPath(root, entry)) } catch {}
  }
  return out
}

async function loadCommands(root: string, manifest: PluginManifest, plugin: PluginProvenance, errors: PluginComponentLoadResult['errors']): Promise<PluginCommand[]> {
  const out: PluginCommand[] = []
  const loadedPaths = new Set<string>()
  const seen = async (file: string): Promise<boolean> => {
    const identity = await fs.realpath(file).catch(() => path.resolve(file))
    if (loadedPaths.has(identity)) return true
    loadedPaths.add(identity)
    return false
  }
  for (const dir of resolveDeclaredPaths(root, manifest.commands as any, './commands')) {
    try {
      if (await isDirectory(dir)) {
        for (const file of await collectMarkdown(dir)) {
          if (await seen(file)) continue
          const rel = path.relative(dir, file).replace(/\\/g, '/')
          const base = rel.replace(/\.md$/i, '').split('/').join(':')
          const text = await readText(file)
          const parsed = parseFrontmatterText(text)
          out.push({
            name: `${plugin.pluginName}:${base}`,
            description: scalar(parsed.meta, 'description') || base,
            agent: scalar(parsed.meta, 'agent'),
            model: scalar(parsed.meta, 'model'),
            subtask: parsed.meta.subtask === true || parsed.meta.subtask === 'true',
            template: parsed.body,
            allowedTools: list(parsed.meta, 'allowed-tools'),
            plugin,
          })
        }
      } else if (await isFile(dir) && dir.toLowerCase().endsWith('.md')) {
        await assertRealpathWithin(root, dir, 'plugin command component')
        if (await seen(dir)) continue
        const text = await readText(dir)
        const parsed = parseFrontmatterText(text)
        const base = path.basename(dir).replace(/\.md$/i, '')
        out.push({name:`${plugin.pluginName}:${base}`,description:scalar(parsed.meta,'description')||base,agent:scalar(parsed.meta,'agent'),model:scalar(parsed.meta,'model'),subtask:parsed.meta.subtask===true||parsed.meta.subtask==='true',template:parsed.body,allowedTools:list(parsed.meta,'allowed-tools'),plugin})
      }
    } catch (error) {
      errors.push({ plugin: plugin.pluginId, component: 'commands', error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (manifest.commands && typeof manifest.commands === 'object' && !Array.isArray(manifest.commands)) {
    for (const [name, metadata] of Object.entries(manifest.commands as Record<string, any>)) {
      const fq = `${plugin.pluginName}:${name}`
      if (metadata.content !== undefined) {
        out.push({name:fq,description:metadata.description||name,model:metadata.model,template:String(metadata.content),allowedTools:metadata.allowedTools,plugin})
      } else if (metadata.source) {
        try {
          const file = resolvePluginComponentPath(root, metadata.source)
          await assertRealpathWithin(root, file, 'plugin command component')
          const alreadyLoaded = await seen(file)
          if (alreadyLoaded) {
            const existing = out.find(command => command.name === fq)
            if (existing) {
              existing.description = metadata.description || existing.description
              existing.model = metadata.model || existing.model
              existing.allowedTools = metadata.allowedTools || existing.allowedTools
              existing.argumentHint = metadata.argumentHint || existing.argumentHint
            }
            continue
          }
          const text = await readText(file); const parsed = parseFrontmatterText(text)
          out.push({name:fq,description:metadata.description||scalar(parsed.meta,'description')||name,agent:scalar(parsed.meta,'agent'),model:metadata.model||scalar(parsed.meta,'model'),subtask:parsed.meta.subtask===true||parsed.meta.subtask==='true',template:parsed.body,allowedTools:metadata.allowedTools||list(parsed.meta,'allowed-tools'),argumentHint:metadata.argumentHint,plugin})
        } catch (error) { errors.push({plugin:plugin.pluginId,component:`command:${name}`,error:error instanceof Error?error.message:String(error)}) }
      }
    }
  }
  return out
}

async function loadAgents(root: string, manifest: PluginManifest, plugin: PluginProvenance, errors: PluginComponentLoadResult['errors']): Promise<PluginAgent[]> {
  const out: PluginAgent[] = []
  const loadedPaths = new Set<string>()
  const seen = async (file: string): Promise<boolean> => {
    const identity = await fs.realpath(file).catch(() => path.resolve(file))
    if (loadedPaths.has(identity)) return true
    loadedPaths.add(identity)
    return false
  }
  for (const dir of resolveDeclaredPaths(root, manifest.agents as any, './agents')) {
    try {
      if (await isDirectory(dir)) for (const file of await collectMarkdown(dir)) {
        if (await seen(file)) continue
        const parsed = parseFrontmatterText(await readText(file))
        const base = String(parsed.meta.name || path.basename(file).replace(/\.md$/i,''))
        out.push({name:`${plugin.pluginName}:${base}`,description:String(parsed.meta.description||parsed.meta['when-to-use']||base),mode: 'subagent',model:scalar(parsed.meta,'model'),prompt:parsed.body,tools:list(parsed.meta,'tools'),disallowedTools:list(parsed.meta,'disallowedTools'),skills:list(parsed.meta,'skills'),plugin})
      }
      else if (await isFile(dir) && dir.toLowerCase().endsWith('.md')) {
        await assertRealpathWithin(root, dir, 'plugin agent component')
        if (await seen(dir)) continue
        const parsed = parseFrontmatterText(await readText(dir)); const base=String(parsed.meta.name||path.basename(dir).replace(/\.md$/i,''))
        out.push({name:`${plugin.pluginName}:${base}`,description:String(parsed.meta.description||parsed.meta['when-to-use']||base),mode:'subagent',model:scalar(parsed.meta,'model'),prompt:parsed.body,tools:list(parsed.meta,'tools'),disallowedTools:list(parsed.meta,'disallowedTools'),skills:list(parsed.meta,'skills'),plugin})
      }
    } catch(error){ errors.push({plugin:plugin.pluginId,component:'agents',error:error instanceof Error?error.message:String(error)}) }
  }
  return out
}

function substitutePluginVars(value: string, root: string): string {
  return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', root).replaceAll('${TERMAGENT_PLUGIN_ROOT}', root)
}

function parseMcpServer(value: any, plugin: PluginProvenance, name: string): PluginMCPServer | null {
  if (!value || typeof value !== 'object') return null
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  if (!command) return null
  const args = Array.isArray(value.args) ? value.args.map((x:any)=>substitutePluginVars(String(x),plugin.installPath)) : undefined
  const env = value.env && typeof value.env === 'object' ? Object.fromEntries(Object.entries(value.env).map(([k,v])=>[k,substitutePluginVars(String(v),plugin.installPath)])) : undefined
  return {command, args, env, pluginId:plugin.pluginId, pluginName:plugin.pluginName, marketplace:plugin.marketplace, serverName:name}
}

async function loadMcp(root: string, manifest: PluginManifest, plugin: PluginProvenance, errors: PluginComponentLoadResult['errors']): Promise<Record<string,PluginMCPServer>> {
  const out: Record<string,PluginMCPServer> = {}
  const specs: any[] = []
  const defaultPath = path.join(root,'.mcp.json')
  if (await isFile(defaultPath)) { await assertRealpathWithin(root, defaultPath, 'plugin MCP component'); specs.push(defaultPath) }
  if (manifest.mcpServers !== undefined) specs.push(manifest.mcpServers)
  for (const spec of specs) {
    try {
      let value: any
      if (typeof spec === 'string') {
        const file = resolvePluginComponentPath(root, spec)
        const safeFile = await assertRealpathWithin(root, file, 'plugin MCP component')
        value = JSON.parse(await readText(safeFile))
      } else {
        value = spec
      }
      const entries = value && typeof value === 'object' && value.mcpServers && typeof value.mcpServers === 'object' ? value.mcpServers : value
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue
      for (const [name, config] of Object.entries(entries)) {
        const parsed = parseMcpServer(config,plugin,name)
        if (parsed) out[`plugin_${plugin.pluginName}_${name}`] = parsed
      }
    } catch(error){ errors.push({plugin:plugin.pluginId,component:'mcp',error:error instanceof Error?error.message:String(error)}) }
  }
  return out
}

export async function loadInstalledPluginComponents(options: PluginComponentLoadOptions = {}): Promise<PluginComponentLoadResult> {
  const result: PluginComponentLoadResult = {commands:[],agents:[],mcpServers:{},hooks:{},errors:[]}
  const installed = await loadInstalledPlugins()
  const records = Object.values(installed.plugins)
    .filter(record => (record.status === 'installed' || record.status === 'update-available') && (options.includeDisabled === true || record.enabled !== false))
    .sort((a, b) => a.id.localeCompare(b.id))
  for (const record of records) {
    try {
      const realInstallPath = await assertRealpathWithin(installedPluginsRoot(), record.installPath, 'installed plugin path')
      const security = await evaluatePluginSecurity(record.id, record.marketplace, record.digest, record.revision)
      if (security.blocked) throw new Error(security.reason)
      const actualDigest = await computePluginTreeDigest(realInstallPath)
      if (actualDigest !== record.digest) throw new Error(`Installed plugin integrity mismatch: expected ${record.digest}, got ${actualDigest}`)
      const {manifest} = await readPluginManifest(realInstallPath)
      if (manifest.name !== record.plugin) {
        throw new Error(`Installed plugin manifest name '${manifest.name}' does not match installed state '${record.plugin}'`)
      }
      const plugin: PluginProvenance = {pluginId:record.id,pluginName:record.plugin,marketplace:record.marketplace,version:record.version,installPath:realInstallPath}
      result.commands.push(...await loadCommands(realInstallPath,manifest,plugin,result.errors))
      result.agents.push(...await loadAgents(realInstallPath,manifest,plugin,result.errors))
      Object.assign(result.mcpServers,await loadMcp(realInstallPath,manifest,plugin,result.errors))
      const loadedHooks = await loadPluginHooks(realInstallPath,manifest,plugin.pluginId)
      for (const [event, specs] of Object.entries(loadedHooks)) { const key = event as keyof PluginHooks; result.hooks[key] = [...(result.hooks[key] || []), ...(specs as PluginHookSpec[])] }
    } catch(error) { result.errors.push({plugin:record.id,component:'manifest',error:error instanceof Error?error.message:String(error)}) }
  }
  return result
}
