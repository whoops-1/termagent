import path from 'node:path'
import { promises as fs } from 'node:fs'
import { exists } from '../util/fs.js'
import type {
  PluginCommandMetadata,
  PluginManifest,
  PluginManifestLocation,
} from './types.js'

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/
const MANIFEST_LOCATIONS: PluginManifestLocation[] = [
  '.claude-plugin/plugin.json',
  '.termagent-plugin/plugin.json',
]

function fail(pathName: string, message: string): never {
  throw new Error(`Invalid plugin manifest ${pathName}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown, field: string, options: { required?: boolean; url?: boolean } = {}): string | undefined {
  if (value === undefined) {
    if (options.required) fail(field, 'is required')
    return undefined
  }
  if (typeof value !== 'string' || value.trim() === '') fail(field, 'must be a non-empty string')
  if (options.url) {
    try {
      const u = new URL(value)
      if (!u.protocol || !u.hostname) fail(field, 'must be a valid URL')
    } catch {
      fail(field, 'must be a valid URL')
    }
  }
  return value.trim()
}

function normalizeRelativePath(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') fail(field, 'must be a non-empty relative path')
  const rawValue = raw.trim()
  const value = rawValue.replace(/\\/g, '/')
  if (value.startsWith('/') || WINDOWS_ABSOLUTE.test(value)) fail(field, `must be relative: ${rawValue}`)
  if (!value.startsWith('./')) fail(field, `must start with './': ${rawValue}`)
  const parts = value.slice(2).split('/')
  if (parts.some(part => part === '..' || part === '.')) fail(field, `contains unsafe path segments: ${rawValue}`)
  return value
}

function validatePathList(value: unknown, field: string): string | string[] | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return normalizeRelativePath(value, field)
  if (!Array.isArray(value)) fail(field, 'must be a relative path or array of relative paths')
  const seen = new Set<string>()
  const out = value.map((entry, index) => {
    const normalized = normalizeRelativePath(entry, `${field}[${index}]`)
    if (seen.has(normalized)) fail(field, `contains duplicate path ${normalized}`)
    seen.add(normalized)
    return normalized
  })
  return out
}

function validateCommands(value: unknown): PluginManifest['commands'] {
  if (value === undefined) return undefined
  if (typeof value === 'string' || Array.isArray(value)) return validatePathList(value, 'commands')
  if (!isRecord(value)) fail('commands', 'must be a path, path array, or command mapping')
  const out: Record<string, PluginCommandMetadata> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (!NAME_PATTERN.test(name)) fail(`commands.${name}`, 'command name must contain only letters, numbers, dots, underscores, and hyphens')
    if (!isRecord(entry)) fail(`commands.${name}`, 'must be an object')
    const hasSource = entry.source !== undefined
    const hasContent = entry.content !== undefined
    if (hasSource === hasContent) fail(`commands.${name}`, 'must contain exactly one of source or content')
    const command: PluginCommandMetadata = {}
    if (hasSource) command.source = normalizeRelativePath(entry.source, `commands.${name}.source`)
    if (hasContent) command.content = stringField(entry.content, `commands.${name}.content`, { required: true })
    if (entry.description !== undefined) command.description = stringField(entry.description, `commands.${name}.description`, { required: true })
    if (entry.argumentHint !== undefined) command.argumentHint = stringField(entry.argumentHint, `commands.${name}.argumentHint`, { required: true })
    if (entry.model !== undefined) command.model = stringField(entry.model, `commands.${name}.model`, { required: true })
    if (entry.allowedTools !== undefined) {
      if (!Array.isArray(entry.allowedTools) || entry.allowedTools.some(item => typeof item !== 'string' || !item.trim())) fail(`commands.${name}.allowedTools`, 'must be an array of non-empty strings')
      command.allowedTools = entry.allowedTools.map(item => String(item).trim())
    }
    out[name] = command
  }
  return out
}

function validateAuthor(value: unknown): PluginManifest['author'] {
  if (value === undefined) return undefined
  if (typeof value === 'string') return stringField(value, 'author', { required: true })
  if (!isRecord(value)) fail('author', 'must be a string or object')
  const name = stringField(value.name, 'author.name', { required: true })!
  const email = value.email === undefined ? undefined : stringField(value.email, 'author.email', { required: true })
  const url = value.url === undefined ? undefined : stringField(value.url, 'author.url', { required: true, url: true })
  return { name, email, url }
}

function validateDependencies(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) fail('dependencies', 'must be a non-empty array when provided')
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const dep = stringField(value[i], `dependencies[${i}]`, { required: true })!
    const parts = dep.split('@')
    const pluginName = parts[0] || ''
    const marketplace = parts.length === 2 ? parts[1] || '' : undefined
    if (!NAME_PATTERN.test(pluginName) || pluginName.includes('..') || (marketplace !== undefined && !NAME_PATTERN.test(marketplace))) {
      fail(`dependencies[${i}]`, `invalid plugin dependency identifier: ${dep}`)
    }
    if (seen.has(dep)) fail('dependencies', `contains duplicate dependency ${dep}`)
    seen.add(dep)
    out.push(dep)
  }
  return out
}

export function assertPluginManifest(value: unknown, source = '<memory>'): PluginManifest {
  if (!isRecord(value)) fail(source, 'top level value must be an object')
  const name = stringField(value.name, 'name', { required: true })!
  if (!NAME_PATTERN.test(name) || name.includes('..') || name.startsWith('.') || name.endsWith('.')) {
    fail('name', `invalid plugin name: ${name}`)
  }
  const version = value.version === undefined ? undefined : stringField(value.version, 'version', { required: true })
  if (version && !VERSION_PATTERN.test(version)) fail('version', `must be semver-like (x.y.z): ${version}`)
  const description = value.description === undefined ? undefined : stringField(value.description, 'description', { required: true })
  const homepage = value.homepage === undefined ? undefined : stringField(value.homepage, 'homepage', { required: true, url: true })
  const repository = value.repository === undefined ? undefined : stringField(value.repository, 'repository', { required: true })
  const license = value.license === undefined ? undefined : stringField(value.license, 'license', { required: true })
  const author = validateAuthor(value.author)
  const keywords = value.keywords === undefined ? undefined : (() => {
    if (!Array.isArray(value.keywords) || value.keywords.some(item => typeof item !== 'string' || !item.trim())) fail('keywords', 'must be an array of non-empty strings')
    return value.keywords.map(item => String(item).trim())
  })()
  return {
    name,
    version,
    description,
    author,
    homepage,
    repository,
    license,
    keywords,
    dependencies: validateDependencies(value.dependencies),
    commands: validateCommands(value.commands),
    agents: validatePathList(value.agents, 'agents'),
    skills: validatePathList(value.skills, 'skills'),
    outputStyles: validatePathList(value.outputStyles, 'outputStyles'),
    hooks: value.hooks,
    mcpServers: value.mcpServers,
    settings: value.settings === undefined ? undefined : isRecord(value.settings) ? value.settings : fail('settings', 'must be an object'),
    channels: value.channels,
    lspServers: value.lspServers,
  }
}

export async function readPluginManifest(pluginRoot: string): Promise<{ manifest: PluginManifest; manifestPath: string; location: PluginManifestLocation }> {
  const root = path.resolve(pluginRoot)
  const present = [] as Array<{ location: PluginManifestLocation; path: string }>
  for (const location of MANIFEST_LOCATIONS) {
    const manifestPath = path.join(root, location)
    if (await exists(manifestPath)) present.push({ location, path: manifestPath })
  }
  if (present.length > 1) {
    throw new Error(`Ambiguous plugin package ${root}: found both ${present.map(item => item.location).join(' and ')}`)
  }
  for (const entry of present) {
    const { location, path: manifestPath } = entry
    let raw: string
    try {
      raw = await fs.readFile(manifestPath, 'utf8')
    } catch (error) {
      throw new Error(`Unable to read plugin manifest ${manifestPath}: ${(error as Error).message}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Invalid JSON in plugin manifest ${manifestPath}: ${(error as Error).message}`)
    }
    return { manifest: assertPluginManifest(parsed, manifestPath), manifestPath, location }
  }
  throw new Error(`No plugin manifest found in ${root}; expected ${MANIFEST_LOCATIONS.join(' or ')}`)
}

export function resolvePluginComponentPath(pluginRoot: string, relativePath: string): string {
  const root = path.resolve(pluginRoot)
  const normalized = normalizeRelativePath(relativePath, 'component path')
  const resolved = path.resolve(root, normalized)
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error(`Plugin component escapes plugin root: ${relativePath}`)
  }
  return resolved
}
