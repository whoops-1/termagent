import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDir, within } from '../util/fs.js'
import { readPluginManifest, resolvePluginComponentPath } from './manifest.js'
import {
  getMarketplace,
  installedPluginsPath,
  installedPluginsRoot,
  loadInstalledPlugins,
  loadKnownMarketplaces,
  marketplaceCacheRoot,
  saveInstalledPlugins,
  validatePluginForInstallation,
  isThirdPartySource,
} from './marketplace.js'
import type { InstallPluginOptions, InstalledPluginsFile, MarketplacePluginEntry, PluginSource, PluginState } from './marketplace-types.js'
import { assertInstalledPluginContained, assertPathNotSymlink, evaluatePluginSecurity, getStoredPluginTrust, approvePluginTrust } from './security.js'
import { formatDependencyResolutionError, resolveDependencyClosure } from './dependency-resolver.js'

function pluginId(plugin: string, marketplace: string): string {
  return `${plugin}@${marketplace}`
}

let lifecycleQueue: Promise<void> = Promise.resolve()

export function withPluginLifecycleLock<T>(work: () => Promise<T>): Promise<T> {
  const run = lifecycleQueue.then(work, work)
  lifecycleQueue = run.then(() => undefined, () => undefined)
  return run
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true } catch { return false }
}

async function assertInstalledSourceContained(root: string, target: string): Promise<string> {
  const realRoot = await fs.realpath(root)
  const realTarget = await fs.realpath(target)
  if (!within(realRoot, realTarget)) throw new Error(`Plugin source escapes marketplace root: ${target}`)
  return realTarget
}

function safeName(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value.includes('..') || value.startsWith('.') || value.endsWith('.')) throw new Error(`Unsafe plugin name: ${value}`)
  return value
}

function safeVersionPath(version: string, digest: string): string {
  const normalized = version.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown'
  return `${normalized}__${digest.slice(-12)}`
}

async function copyTree(source: string, target: string): Promise<void> {
  await ensureDir(target)
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const src = path.join(source, entry.name)
    const dst = path.join(target, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in plugin source: ${entry.name}`)
    if (entry.isDirectory()) await copyTree(src, dst)
    else if (entry.isFile()) await fs.copyFile(src, dst)
  }
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const result = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes', ...args], { cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' } })
  return String(result.stdout).trim()
}

function githubUrl(repo: string): string {
  return ` '')}.git`
}

async function materializeGit(source: Exclude<PluginSource, string>, temp: string): Promise<{ root: string; revision?: string }> {
  if (source.source === 'github' || source.source === 'git' || source.source === 'git-subdir' || source.source === 'url') {
    const url = source.source === 'github' ? githubUrl(source.repo) : source.url
    await ensureDir(temp)
    if (source.sha) {
      await runGit(['init', '-q', temp])
      await runGit(['remote', 'add', 'origin', url], temp)
      if (source.source === 'git-subdir') {
        await runGit(['sparse-checkout', 'init', '--cone'], temp)
        await runGit(['sparse-checkout', 'set', '--', source.path], temp)
      } else if (('sparsePaths' in source && source.sparsePaths?.length)) {
        await runGit(['sparse-checkout', 'init', '--cone'], temp)
        await runGit(['sparse-checkout', 'set', '--', ...source.sparsePaths], temp)
      }
      const fetchArgs: string[] = ['fetch', '--depth', '1']
      if ((source.source === 'git-subdir' && source.path) || ('sparsePaths' in source && source.sparsePaths?.length)) fetchArgs.push('--filter=blob:none')
      fetchArgs.push('origin', source.sha)
      await runGit(fetchArgs, temp)
      await runGit(['checkout', '--detach', 'FETCH_HEAD'], temp)
    } else {
      const args = ['clone', '--depth', '1']
      if (source.source === 'git-subdir' || ('sparsePaths' in source && source.sparsePaths?.length)) args.push('--filter=blob:none', '--no-checkout')
      else args.push('--recurse-submodules', '--shallow-submodules')
      if (source.ref) args.push('--branch', source.ref)
      args.push(url, temp)
      await runGit(args)
      if (source.source === 'git-subdir') {
        await runGit(['sparse-checkout', 'set', '--cone', '--', source.path], temp)
        await runGit(['checkout', 'HEAD'], temp)
      } else if (('sparsePaths' in source && source.sparsePaths?.length)) {
        await runGit(['sparse-checkout', 'set', '--cone', '--', ...source.sparsePaths], temp)
        await runGit(['checkout', 'HEAD'], temp)
      }
    }
    const root = source.path ? path.join(temp, source.path) : temp
    return { root, revision: await runGit(['rev-parse', 'HEAD'], temp) }
  }
  throw new Error('Unsupported plugin source')
}

function requiresConfirmation(source: PluginSource, marketplaceSourceIsThirdParty: boolean): boolean {
  return marketplaceSourceIsThirdParty || typeof source !== 'string'
}

async function installPluginSingle(
  marketplaceName: string,
  pluginName: string,
  options: InstallPluginOptions = {},
  forceEnable = false,
): Promise<PluginState> {
  safeName(marketplaceName)
  safeName(pluginName)
  const { marketplace, installLocation, state } = await getMarketplace(marketplaceName)
  const entry = marketplace.plugins.find(item => item.name === pluginName)
  if (!entry) throw new Error(`Plugin not found in marketplace: ${pluginName}@${marketplaceName}`)
  const id = pluginId(pluginName, marketplace.name)
  const source = entry.source
  const security = await evaluatePluginSecurity(id, marketplace.name)
  if (security.blocked) {
    return { id, marketplace: marketplace.name, plugin: pluginName, status: 'broken', error: security.reason }
  }
  if (typeof source !== 'string' && (source.source === 'npm' || source.source === 'pip')) {
    throw new Error(`Plugin source '${source.source}' is catalog-only in Phase 2; executable package installation is deferred to the dependency/update phase`)
  }
  const root = installedPluginsRoot()
  await assertPathNotSymlink(root, 'installed plugin cache root')
  const marketplaceRoot = path.join(root, safeName(marketplace.name))
  const pluginRoot = path.join(marketplaceRoot, safeName(pluginName))
  const temp = path.join(pluginRoot, `.install-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  await ensureDir(pluginRoot)
  await fs.chmod(installedPluginsRoot(), 0o700).catch(() => undefined)
  await fs.chmod(marketplaceRoot, 0o700).catch(() => undefined)
  await fs.chmod(pluginRoot, 0o700).catch(() => undefined)
  let materializedRoot = temp
  let revision: string | undefined = state.revision
  try {
    if (typeof source === 'string') {
      const resolved = resolvePluginComponentPath(installLocation, source)
      await assertInstalledSourceContained(installLocation, resolved)
      await copyTree(resolved, temp)
    } else {
      const materialized = await materializeGit(source, temp)
      materializedRoot = materialized.root
      revision = materialized.revision
      if (source.sha && revision?.toLowerCase() !== source.sha.toLowerCase()) {
        throw new Error(`Pinned plugin revision mismatch for ${id}: expected ${source.sha}, got ${revision ?? 'unknown'}`)
      }
    }
    const requireManifest = entry.strict !== false
    const { version: detectedVersion, digest } = await validatePluginForInstallation(materializedRoot, pluginName, requireManifest)
    const version = requireManifest ? detectedVersion : (entry.version ?? detectedVersion)
    const evaluated = await evaluatePluginSecurity(id, marketplace.name, digest, revision)
    if (evaluated.blocked) throw new Error(evaluated.reason)
    const trustState = await getStoredPluginTrust(id, source, digest, revision)
    const needsApproval = requiresConfirmation(source, isThirdPartySource(state.source)) && trustState !== 'approved'
    if (needsApproval && options.thirdPartyConfirmed !== true) {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
      if (materializedRoot !== temp) await fs.rm(materializedRoot, { recursive: true, force: true }).catch(() => undefined)
      return { id, marketplace: marketplace.name, plugin: pluginName, status: 'not-installed', error: `explicit install confirmation is required unless persisted plugin trust approval matches (trust state: ${trustState})` }
    }
    const installDir = path.join(pluginRoot, safeVersionPath(version, digest))
    if (await pathExists(installDir)) {
      const existing = await validatePluginForInstallation(installDir, pluginName, entry.strict !== false)
      if (existing.digest !== digest) throw new Error(`Installation path collision or tampering detected for ${id}`)
      await fs.rm(temp, { recursive: true, force: true })
      if (materializedRoot !== temp) await fs.rm(materializedRoot, { recursive: true, force: true }).catch(() => undefined)
    } else if (typeof source === 'string') {
      await fs.rename(temp, installDir)
    } else if (materializedRoot === temp) {
      await fs.rename(temp, installDir)
    } else {
      const finalSource = materializedRoot
      await fs.mkdir(installDir, { recursive: false }).catch(async (error: any) => {
        if ((error as any).code !== 'EEXIST') throw error
        await fs.rm(installDir, { recursive: true, force: true })
        await fs.mkdir(installDir)
      })
      await copyTree(finalSource, installDir)
      await fs.rm(temp, { recursive: true, force: true })
    }
    const now = new Date().toISOString()
    const installed = await loadInstalledPlugins()
    installed.plugins[id] = {
      id,
      marketplace: marketplace.name,
      plugin: pluginName,
      source,
      installPath: installDir,
      version,
      revision,
      digest,
      installedAt: installed.plugins[id]?.installedAt ?? now,
      lastUpdated: now,
      status: 'installed',
      enabled: forceEnable ? true : installed.plugins[id]?.enabled !== false,
      dependencies: entry.dependencies ? [...entry.dependencies] : undefined,
    }
    await saveInstalledPlugins(installed)
    if (requiresConfirmation(source, isThirdPartySource(state.source))) {
      await approvePluginTrust(id, source, digest, revision)
    }
    options.onProgress?.(`Installed ${id} ${version}`)
    return { id, marketplace: marketplace.name, plugin: pluginName, status: 'installed', version, revision, digest, installPath: installDir, enabled: installed.plugins[id]?.enabled !== false }
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    if (materializedRoot !== temp && materializedRoot.startsWith(`${temp}${path.sep}`)) await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
export async function installPlugin(
  marketplaceName: string,
  pluginName: string,
  options: InstallPluginOptions = {},
): Promise<PluginState> {
  return withPluginLifecycleLock(async () => {
    safeName(marketplaceName)
    safeName(pluginName)
    const rootId = pluginId(pluginName, marketplaceName)
    const known = await loadKnownMarketplaces()
    const marketplaces = new Map<string, import('./marketplace-types.js').MarketplaceManifest>()
    for (const name of Object.keys(known).sort((a, b) => a.localeCompare(b))) {
      try {
        const loaded = await getMarketplace(name)
        marketplaces.set(loaded.marketplace.name, loaded.marketplace)
      } catch {
        // A broken unrelated marketplace does not make the root unusable. If a
        // dependency points at it, the resolver reports it as not found.
      }
    }

    if (!marketplaces.has(marketplaceName)) {
      const loaded = await getMarketplace(marketplaceName)
      marketplaces.set(loaded.marketplace.name, loaded.marketplace)
    }

    const before = await loadInstalledPlugins()
    const alreadyInstalled = new Set(
      Object.entries(before.plugins)
        .filter(([, record]) => (record.status === 'installed' || record.status === 'update-available') && record.enabled !== false)
        .map(([id]) => id),
    )
    const resolution = await resolveDependencyClosure(rootId, marketplaces, alreadyInstalled)
    if (!resolution.ok) {
      const message = formatDependencyResolutionError(resolution.error)
      return { id: rootId, marketplace: marketplaceName, plugin: pluginName, status: 'broken', error: message }
    }

    const addedPaths = new Set<string>()
    try {
      const closure = resolution.closure
      for (const id of closure) {
        const parsed = id.split('@')
        const dependencyMarketplace = parsed[1]
        const dependencyPlugin = parsed[0]
        if (!dependencyMarketplace || !dependencyPlugin) throw new Error(`Invalid resolved plugin id: ${id}`)
        const previousPath = (await loadInstalledPlugins()).plugins[id]?.installPath
        const state = await installPluginSingle(
          dependencyMarketplace,
          dependencyPlugin,
          options,
          id !== rootId,
        )
        if (state.status !== 'installed') {
          // The root operation preserves the existing single-plugin API: a
          // trust prompt or security-block result is a structured state, not
          // an unexpected exception. Dependencies are different: a dependency
          // that cannot be materialized makes the whole transaction fail.
          if (id === rootId) return state
          throw new Error(state.error || `Failed to install ${id}`)
        }
        if (state.installPath && state.installPath !== previousPath) addedPaths.add(state.installPath)
      }
      const installed = await loadInstalledPlugins()
      const final = installed.plugins[rootId]
      if (!final) throw new Error(`Installation completed without recording ${rootId}`)
      return {
        id: final.id,
        marketplace: final.marketplace,
        plugin: final.plugin,
        status: final.status,
        version: final.version,
        revision: final.revision,
        digest: final.digest,
        installPath: final.installPath,
        error: final.error,
        enabled: final.enabled,
        dependencies: final.dependencies,
      }
    } catch (error) {
      // Installions are published one version+digest at a time. Roll back the
      // metadata snapshot and remove only paths this transaction introduced.
      const rollbackErrors: string[] = []
      for (const installPath of addedPaths) {
        try { await fs.rm(installPath, { recursive: true, force: true }) }
        catch (rollbackError) { rollbackErrors.push(String(rollbackError)) }
      }
      await saveInstalledPlugins(before)
      if (rollbackErrors.length) {
        throw new Error(`${(error as Error).message}; rollback also failed: ${rollbackErrors.join('; ')}`)
      }
      throw error
    }
  })
}
async function setPluginEnabledUnlocked(
  marketplaceName: string,
  pluginName: string,
  enabled: boolean,
): Promise<PluginState> {
  const id = pluginId(pluginName, marketplaceName)
  const installed = await loadInstalledPlugins()
  const record = installed.plugins[id]
  if (!record) throw new Error(`Plugin not installed: ${id}`)
  if (enabled) {
    const realPath = await assertInstalledPluginContained(record.installPath)
    const currentDigest = await validatePluginForInstallation(realPath, record.plugin, false).then(result => result.digest)
    if (currentDigest !== record.digest) throw new Error(`Cannot enable tampered plugin ${id}: digest mismatch`)
    const security = await evaluatePluginSecurity(id, marketplaceName, currentDigest, record.revision)
    if (security.blocked) throw new Error(security.reason)
    if (typeof record.source !== 'string') {
      const trustState = await getStoredPluginTrust(id, record.source, currentDigest, record.revision)
      if (trustState !== 'approved') throw new Error(`Cannot enable ${id}: explicit plugin trust approval is required (${trustState})`)
    }
  }
  record.enabled = Boolean(enabled)
  await saveInstalledPlugins(installed)
  return {
    id,
    marketplace: record.marketplace,
    plugin: record.plugin,
    status: record.status,
    version: record.version,
    revision: record.revision,
    digest: record.digest,
    installPath: record.installPath,
    error: record.error,
    enabled: record.enabled,
    dependencies: record.dependencies,
  }
}
export async function setPluginEnabled(
  marketplaceName: string,
  pluginName: string,
  enabled: boolean,
): Promise<PluginState> {
  return withPluginLifecycleLock(() => setPluginEnabledUnlocked(marketplaceName, pluginName, enabled))
}

async function togglePluginEnabledUnlocked(
  marketplaceName: string,
  pluginName: string,
): Promise<PluginState> {
  const id = pluginId(pluginName, marketplaceName)
  const installed = await loadInstalledPlugins()
  const record = installed.plugins[id]
  if (!record) throw new Error(`Plugin not installed: ${id}`)
  return setPluginEnabledUnlocked(marketplaceName, pluginName, record.enabled === false)
}

export async function togglePluginEnabled(
  marketplaceName: string,
  pluginName: string,
): Promise<PluginState> {
  return withPluginLifecycleLock(() => togglePluginEnabledUnlocked(marketplaceName, pluginName))
}

async function removePluginUnlocked(marketplaceName: string, pluginName: string): Promise<void> {
  const id = pluginId(pluginName, marketplaceName)
  const installed = await loadInstalledPlugins()
  const entry = installed.plugins[id]
  if (entry) {
    try {
      await assertInstalledPluginContained(entry.installPath)
      await fs.rm(entry.installPath, { recursive: true, force: true })
    } catch (error) {
      if ((error as any)?.code !== 'ENOENT') throw error
    }
    delete installed.plugins[id]
    await saveInstalledPlugins(installed)
    return
  }
  throw new Error(`Plugin not installed: ${id}`)
}

export async function removePlugin(marketplaceName: string, pluginName: string): Promise<void> {
  return withPluginLifecycleLock(() => removePluginUnlocked(marketplaceName, pluginName))
}
async function sourceFingerprint(marketplaceName: string, entry: MarketplacePluginEntry, installLocation: string): Promise<{ digest?: string; revision?: string; version?: string }> {
  if (typeof entry.source === 'string') {
    const sourcePath = resolvePluginComponentPath(installLocation, entry.source)
    const { version, digest } = await validatePluginForInstallation(sourcePath, entry.name, entry.strict !== false)
    return { version, digest }
  }
  if (entry.source.source === 'npm' || entry.source.source === 'pip') return { version: entry.version }
  return { revision: ('sha' in entry.source ? entry.source.sha : undefined) ?? ('ref' in entry.source ? entry.source.ref : undefined), version: entry.version }
}

export async function getPluginState(marketplaceName: string, pluginName: string): Promise<PluginState> {
  const id = pluginId(pluginName, marketplaceName)
  const installed = await loadInstalledPlugins()
  const record = installed.plugins[id]
  let marketplace
  try {
    marketplace = await getMarketplace(marketplaceName)
  } catch (error) {
    if (record) return { id, marketplace: marketplaceName, plugin: pluginName, status: 'orphaned', version: record.version, digest: record.digest, installPath: record.installPath, enabled: record.enabled !== false, dependencies: record.dependencies, error: (error as Error).message }
    return { id, marketplace: marketplaceName, plugin: pluginName, status: 'not-installed' }
  }
  const entry = marketplace.marketplace.plugins.find(item => item.name === pluginName)
  if (!entry) {
    if (record) return { id, marketplace: marketplaceName, plugin: pluginName, status: 'orphaned', version: record.version, digest: record.digest, installPath: record.installPath, enabled: record.enabled !== false, dependencies: record.dependencies, error: 'plugin no longer exists in marketplace' }
    return { id, marketplace: marketplaceName, plugin: pluginName, status: 'not-installed' }
  }
  if (!record) return { id, marketplace: marketplaceName, plugin: pluginName, status: 'not-installed' }
  try {
    const realInstallPath = await assertInstalledPluginContained(record.installPath)
    const actualInstalled = await validatePluginForInstallation(realInstallPath, record.plugin, entry.strict !== false)
    if (actualInstalled.digest !== record.digest) throw new Error(`installed plugin integrity mismatch: expected ${record.digest}, got ${actualInstalled.digest}`)
    const security = await evaluatePluginSecurity(id, marketplaceName, record.digest, record.revision)
    if (security.blocked) throw new Error(security.reason)
    const current = await sourceFingerprint(marketplaceName, entry, marketplace.installLocation)
    const sameSource = JSON.stringify(record.source) === JSON.stringify(entry.source)
    const sameDigest = current.digest && record.digest === current.digest
    const entrySha = typeof entry.source === 'string' ? undefined : ('sha' in entry.source ? entry.source.sha : undefined)
    const sameRevision = current.revision && (record.revision === current.revision || record.revision === entrySha)
    const sameVersion = current.version && record.version === current.version
    if (sameDigest || sameRevision || (sameSource && sameVersion && typeof entry.source !== 'string') || (sameSource && current.digest === undefined && current.revision === undefined && typeof entry.source !== 'string')) {
      record.status = 'installed'
      record.error = undefined
      return { id, marketplace: marketplaceName, plugin: pluginName, status: 'installed', version: record.version, revision: record.revision, digest: record.digest, installPath: record.installPath, enabled: record.enabled !== false, dependencies: entry.dependencies ? [...entry.dependencies] : record.dependencies, trust: typeof record.source === 'string' ? 'approved' : await getStoredPluginTrust(id, record.source, record.digest, record.revision) }
    }
    record.status = 'update-available'
    record.error = undefined
    return { id, marketplace: marketplaceName, plugin: pluginName, status: 'update-available', version: record.version, revision: record.revision, digest: record.digest, installPath: record.installPath, enabled: record.enabled !== false, dependencies: entry.dependencies ? [...entry.dependencies] : record.dependencies, trust: typeof record.source === 'string' ? 'approved' : await getStoredPluginTrust(id, record.source, record.digest, record.revision) }
  } catch (error) {
    record.status = 'broken'
    record.error = (error as Error).message
    return { id, marketplace: marketplaceName, plugin: pluginName, status: 'broken', version: record.version, revision: record.revision, digest: record.digest, installPath: record.installPath, enabled: record.enabled !== false, dependencies: record.dependencies, error: record.error }
  }
}

export async function listPluginStates(): Promise<PluginState[]> {
  const installed = await loadInstalledPlugins()
  const out: PluginState[] = []
  for (const record of Object.values(installed.plugins)) {
    out.push(await getPluginState(record.marketplace, record.plugin))
  }
  return out
}

export async function reconcileInstalledPlugins(): Promise<PluginState[]> {
  const installed = await loadInstalledPlugins()
  const states: PluginState[] = []
  for (const record of Object.values(installed.plugins)) {
    const state = await getPluginState(record.marketplace, record.plugin)
    states.push(state)
    record.status = state.status === 'not-installed' ? 'orphaned' : state.status
    record.error = state.error
  }
  await saveInstalledPlugins(installed)
  return states
}

