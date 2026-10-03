import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expandHome, exists } from './util/fs.js'

const MIGRATION_VERSION = 1
const GLOBAL_MIGRATION_PATH = () => expandHome('~/.termagent/migrations.json')
const CONFIG_PATH = (cwd: string) => path.join(cwd, '.termagent', 'config.json')
const GLOBAL_CONFIG_PATH = () => expandHome('~/.termagent/config.json')

export type LegacyLayoutReport = {
  cwd: string
  projectSkillsRoots: string[]
  globalSkillsRoots: string[]
  legacyPluginFiles: string[]
  configuredPluginEntries: string[]
  configuredSkillEntries: string[]
  configPath: string
  configAliasEntries: string[]
  globalConfigAliasEntries: string[]
  hasLegacyState: boolean
}

export type MigrationConfigChange = {
  file: string
  changed: boolean
  backup?: string
  changes: Array<{ from: string; to: string; entries: string[] }>
}

export type MigrationRecord = {
  version: number
  cwd: string
  migratedAt: string
  config?: MigrationConfigChange
  globalConfig?: MigrationConfigChange
  adopted: {
    projectSkillRoots: string[]
    globalSkillRoots: string[]
    legacyPluginFiles: string[]
  }
}

export type MigrationResult = {
  migrated: boolean
  alreadyCurrent: boolean
  record: MigrationRecord
  config: MigrationConfigChange
  globalConfig?: MigrationConfigChange
}

type JsonMap = Record<string, unknown>

type MigrationFile = {
  version: number
  projects?: Record<string, MigrationRecord>
}

function isRecord(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeEntry(cwd: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const value = raw.trim()
  const resolved = path.resolve(cwd, value)
  const relative = path.relative(cwd, resolved).replace(/\\/g, '/')
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `./${relative}` : resolved
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

async function listSkillRoots(candidates: string[]): Promise<string[]> {
  const present: string[] = []
  for (const candidate of candidates) if (await exists(candidate)) present.push(candidate)
  return present
}

async function listLegacyPluginFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries
      .filter((entry: any) => entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')))
      .map((entry: any) => path.join(root, entry.name))
      .sort((a: string, b: string) => a.localeCompare(b))
  } catch {
    return []
  }
}

async function readConfigAliases(file: string, baseDir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    if (!isRecord(raw)) return []
    return uniqueStrings([
      ['pluginDirs', raw.pluginDirs],
      ['pluginPaths', raw.pluginPaths],
      ['pluginDirectories', raw.pluginDirectories],
      ['plugin', raw.plugin],
      ['skillDirs', raw.skillDirs],
      ['skills', raw.skills],
      ['skill', raw.skill],
    ].flatMap(([name, value]) => {
      const entries = stringEntries(value).map(entry => normalizeEntry(baseDir, entry) || entry)
      return entries.map(entry => `${name}:${entry}`)
    }))
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw new Error(`Invalid config: ${file}: ${(error as Error).message}`)
  }
}

export async function inspectLegacyLayout(cwd: string): Promise<LegacyLayoutReport> {
  const project = path.resolve(cwd)
  const home = process.env.HOME || cwd
  const projectSkillsRoots = await listSkillRoots([
    path.join(project, '.termagent', 'skills'),
    path.join(project, '.claude', 'skills'),
  ])
  const globalSkillsRoots = await listSkillRoots([
    path.join(home, '.termagent', 'skills'),
    path.join(home, '.claude', 'skills'),
  ])
  const legacyPluginFiles = [
    ...(await listLegacyPluginFiles(path.join(project, '.termagent', 'plugins'))),
    ...(await listLegacyPluginFiles(path.join(home, '.termagent', 'plugins'))),
  ]

  const configPath = CONFIG_PATH(project)
  let rawConfig: JsonMap = {}
  try {
    rawConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as JsonMap
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw new Error(`Invalid config: ${configPath}: ${(error as Error).message}`)
  }

  const configuredPluginEntries = Array.isArray(rawConfig.plugins)
    ? rawConfig.plugins.filter((entry): entry is string => typeof entry === 'string').map(entry => normalizeEntry(project, entry) || entry)
    : []
  const configuredSkillEntries = Array.isArray(rawConfig.skillPaths)
    ? rawConfig.skillPaths.filter((entry): entry is string => typeof entry === 'string').map(entry => normalizeEntry(project, entry) || entry)
    : []
  const configAliasEntries = await readConfigAliases(configPath, project)
  const globalConfigAliasEntries = await readConfigAliases(GLOBAL_CONFIG_PATH(), home)

  return {
    cwd: project,
    projectSkillsRoots,
    globalSkillsRoots,
    legacyPluginFiles: uniqueStrings(legacyPluginFiles),
    configuredPluginEntries: uniqueStrings(configuredPluginEntries),
    configuredSkillEntries: uniqueStrings(configuredSkillEntries),
    configPath,
    configAliasEntries: uniqueStrings(configAliasEntries),
    globalConfigAliasEntries,
    hasLegacyState: projectSkillsRoots.length > 0 || globalSkillsRoots.length > 0 || legacyPluginFiles.length > 0 || configAliasEntries.length > 0 || globalConfigAliasEntries.length > 0,
  }
}

async function loadMigrationFile(): Promise<MigrationFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(GLOBAL_MIGRATION_PATH(), 'utf8')) as unknown
    if (!isRecord(parsed) || parsed.version !== MIGRATION_VERSION || (parsed.projects !== undefined && !isRecord(parsed.projects))) {
      throw new Error(`Invalid migration state: ${GLOBAL_MIGRATION_PATH()}`)
    }
    return { version: MIGRATION_VERSION, projects: parsed.projects as Record<string, MigrationRecord> | undefined }
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { version: MIGRATION_VERSION, projects: {} }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

async function atomicJsonWrite(file: string, value: unknown, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.chmod(path.dirname(file), 0o700).catch(() => undefined)
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function stringEntries(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return []
}

async function migrateConfigAt(file: string, cwd: string): Promise<MigrationConfigChange> {
  const changes: MigrationConfigChange['changes'] = []
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { file, changed: false, changes: [] }
    }
    throw new Error(`Invalid config: ${file}: ${(error as Error).message}`)
  }
  if (!isRecord(raw)) throw new Error(`Invalid config: ${file}: top level value must be an object`)

  const config = { ...raw }
  const pluginEntries = new Set(stringEntries(config.plugins))
  const skillEntries = new Set(stringEntries(config.skillPaths))

  for (const key of ['pluginDirs', 'pluginPaths', 'pluginDirectories']) {
    const entries = stringEntries(config[key]).map(entry => normalizeEntry(cwd, entry) || entry)
    if (entries.length) {
      for (const entry of entries) pluginEntries.add(entry)
      changes.push({ from: key, to: 'plugins', entries })
      delete config[key]
    }
  }
  if (typeof config.plugin === 'string' && config.plugin.trim()) {
    const entries = [normalizeEntry(cwd, config.plugin) || config.plugin]
    for (const entry of entries) pluginEntries.add(entry)
    changes.push({ from: 'plugin', to: 'plugins', entries })
    delete config.plugin
  }

  for (const key of ['skillDirs', 'skillPaths']) {
    const entries = stringEntries(config[key]).map(entry => normalizeEntry(cwd, entry) || entry)
    if (entries.length) {
      for (const entry of entries) skillEntries.add(entry)
      if (key !== 'skillPaths') changes.push({ from: key, to: 'skillPaths', entries })
      if (key !== 'skillPaths') delete config[key]
    }
  }
  if (Array.isArray(config.skills) && config.skills.every(item => typeof item === 'string')) {
    const entries = stringEntries(config.skills).map(entry => normalizeEntry(cwd, entry) || entry)
    for (const entry of entries) skillEntries.add(entry)
    changes.push({ from: 'skills', to: 'skillPaths', entries })
    delete config.skills
  }
  if (typeof config.skill === 'string' && config.skill.trim()) {
    const entries = [normalizeEntry(cwd, config.skill) || config.skill]
    for (const entry of entries) skillEntries.add(entry)
    changes.push({ from: 'skill', to: 'skillPaths', entries })
    delete config.skill
  }

  if (pluginEntries.size) config.plugins = [...pluginEntries].sort()
  if (skillEntries.size) config.skillPaths = [...skillEntries].sort()

  if (changes.length === 0) return { file, changed: false, changes: [] }

  const backup = `${file}.pre-phase11.bak`
  if (!(await exists(backup))) await fs.copyFile(file, backup)
  await atomicJsonWrite(file, config, 0o600)
  return { file, changed: true, backup, changes }
}

async function migrateProjectConfig(cwd: string): Promise<MigrationConfigChange> {
  return migrateConfigAt(CONFIG_PATH(cwd), cwd)
}

async function migrateGlobalConfig(home = process.env.HOME || process.cwd()): Promise<MigrationConfigChange> {
  return migrateConfigAt(path.join(home, '.termagent', 'config.json'), home)
}

export async function migrateLegacyState(cwd: string): Promise<MigrationResult> {
  const project = path.resolve(cwd)
  const migrationFile = await loadMigrationFile()
  const existing = migrationFile.projects?.[project]
  if (existing?.version === MIGRATION_VERSION) {
    const config = await migrateProjectConfig(project)
    const globalConfig = await migrateGlobalConfig()
    if (!config.changed && !globalConfig.changed) {
      return { migrated: false, alreadyCurrent: true, record: existing, config, ...(globalConfig.changed ? { globalConfig } : {}) }
    }
  }

  const layout = await inspectLegacyLayout(project)
  const config = await migrateProjectConfig(project)
  const globalConfig = await migrateGlobalConfig()
  const record: MigrationRecord = {
    version: MIGRATION_VERSION,
    cwd: project,
    migratedAt: new Date().toISOString(),
    ...(config.changed ? { config } : {}),
    ...(globalConfig.changed ? { globalConfig } : {}),
    adopted: {
      projectSkillRoots: [...layout.projectSkillsRoots],
      globalSkillRoots: [...layout.globalSkillsRoots],
      legacyPluginFiles: [...layout.legacyPluginFiles],
    },
  }
  const projects = { ...(migrationFile.projects || {}), [project]: record }
  await atomicJsonWrite(GLOBAL_MIGRATION_PATH(), { version: MIGRATION_VERSION, projects })
  return { migrated: true, alreadyCurrent: false, record, config, ...(globalConfig.changed ? { globalConfig } : {}) }
}

export async function readMigrationState(): Promise<MigrationFile> {
  return loadMigrationFile()
}

export function migrationStatePath(): string {
  return GLOBAL_MIGRATION_PATH()
}
