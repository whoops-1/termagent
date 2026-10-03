import process from 'node:process'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { loadConfig } from './config/config.js'
import { inspectLegacyLayout, migrationStatePath, readMigrationState } from './migration.js'
import { loadKnownMarketplacesSafe, loadInstalledPlugins, marketplaceStateRoot, installedPluginsRoot } from './plugins/marketplace.js'
import { loadPluginSecurityPolicy } from './plugins/security.js'
import { listSkillRegistries, listInstalledRegistrySkills, getSkillRegistryInstallRoot } from './skills/registry.js'
import { loadSkillCatalog } from './skills/catalog.js'

export type DoctorStatus = 'ok' | 'warn' | 'error'
export type DoctorCheck = {
  id: string
  group: 'environment' | 'configuration' | 'migration' | 'marketplaces' | 'plugins' | 'skills' | 'storage'
  label: string
  status: DoctorStatus
  value: string
  detail?: string
  remediation?: string
}

export type DoctorReport = {
  ok: boolean
  checks: DoctorCheck[]
  counts: Record<DoctorStatus, number>
  migrationState: string
  legacy: Awaited<ReturnType<typeof inspectLegacyLayout>>
  generatedAt: string
}

function command(name: string, args: string[] = [], timeoutMs = 3000): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: { ok: boolean; out: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let timer: ReturnType<typeof setTimeout>
    const child = spawn(name, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: unknown) => { out += String(chunk) })
    child.stderr.on('data', (chunk: unknown) => { err += String(chunk) })
    child.on('error', (error: Error) => finish({ ok: false, out: error.message }))
    child.on('close', (code: number | null) => finish({ ok: code === 0, out: (out || err).trim() }))
    timer = setTimeout(() => {
      try { child.kill() } catch { /* child may already be gone */ }
      finish({ ok: false, out: 'timeout' })
    }, timeoutMs)
  })
}

function check(
  checks: DoctorCheck[],
  input: Omit<DoctorCheck, 'id'> & { id?: string },
): void {
  checks.push({ ...input, id: input.id || `${input.group}.${input.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` })
}

async function pathState(file: string): Promise<{ exists: boolean; directory: boolean; mode?: number }> {
  try {
    const stat = await fs.stat(file)
    return { exists: true, directory: stat.isDirectory(), mode: stat.mode & 0o777 }
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { exists: false, directory: false }
    throw error
  }
}

export async function doctor(cwd = process.cwd()): Promise<DoctorReport> {
  const project = path.resolve(cwd)
  const checks: DoctorCheck[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  check(checks, { group: 'environment', label: 'Node.js', status: nodeMajor >= 22 ? 'ok' : 'error', value: process.version, detail: nodeMajor >= 22 ? 'Runtime requirement satisfied.' : 'TermAgent requires Node.js 22 or newer.', remediation: 'Upgrade Node.js before using the CLI.' })
  check(checks, { group: 'environment', label: 'Platform', status: 'ok', value: `${process.platform}/${process.arch}` })
  check(checks, { group: 'environment', label: 'Working directory', status: 'ok', value: project })

  for (const [name, args, required] of [
    ['git', ['--version'], false],
    ['rg', ['--version'], false],
    ['npm', ['--version'], false],
    ['sh', ['-c', 'printf ok'], true],
  ] as Array<[string, string[], boolean]>) {
    const result = await command(name, args)
    check(checks, {
      group: 'environment',
      label: name,
      status: result.ok ? 'ok' : required ? 'error' : 'warn',
      value: result.ok ? result.out.split('\n')[0] || 'available' : (result.out || 'unavailable'),
      remediation: result.ok ? undefined : `${name} is optional for basic operation but may be needed by related features.`,
    })
  }

  try {
    const cfg = await loadConfig(project)
    check(checks, { group: 'configuration', label: 'Config', status: 'ok', value: path.join(project, '.termagent', 'config.json'), detail: `provider=${cfg.provider}, model=${cfg.model || '(unset)'}` })
  } catch (error) {
    check(checks, { group: 'configuration', label: 'Config', status: 'error', value: 'invalid', detail: error instanceof Error ? error.message : String(error), remediation: 'Fix the JSON in .termagent/config.json and rerun /doctor.' })
  }

  const legacy = await inspectLegacyLayout(project)
  if (legacy.hasLegacyState) {
    const aliasCount = legacy.configAliasEntries.length + legacy.globalConfigAliasEntries.length
    check(checks, { group: 'migration', label: 'Legacy migration', status: aliasCount ? 'warn' : 'ok', value: aliasCount ? `${aliasCount} legacy config entries` : 'compatibility paths detected', detail: aliasCount ? [...legacy.configAliasEntries, ...legacy.globalConfigAliasEntries].join(', ') : 'Existing skill/plugin locations are preserved by the compatibility loader.', remediation: aliasCount ? 'Restart TermAgent once to run the non-destructive Phase 11 config migration. A pre-migration backup is created automatically.' : undefined })
  } else {
    check(checks, { group: 'migration', label: 'Legacy migration', status: 'ok', value: 'nothing to migrate' })
  }

  try {
    const migrationState = await readMigrationState()
    check(checks, { group: 'migration', label: 'Migration record', status: 'ok', value: migrationStatePath(), detail: `version=${migrationState.version}, projects=${Object.keys(migrationState.projects ?? {}).length}; records do not move user skill/plugin files.` })
  } catch (error) {
    const state = await pathState(migrationStatePath())
    check(checks, { group: 'migration', label: 'Migration record', status: state.exists ? 'error' : 'warn', value: state.exists ? 'invalid' : migrationStatePath(), detail: state.exists ? (error instanceof Error ? error.message : String(error)) : 'No migration record has been created yet.', remediation: state.exists ? 'Back up and repair or remove the invalid migrations.json, then rerun /doctor.' : undefined })
  }
  check(checks, { group: 'migration', label: 'Legacy project skills', status: legacy.projectSkillsRoots.length ? 'warn' : 'ok', value: `${legacy.projectSkillsRoots.length} roots`, detail: legacy.projectSkillsRoots.join(', ') || 'none', remediation: legacy.projectSkillsRoots.length ? 'These paths remain supported for compatibility; migrate content manually only when desired.' : undefined })
  check(checks, { group: 'migration', label: 'Legacy global skills', status: legacy.globalSkillsRoots.length ? 'warn' : 'ok', value: `${legacy.globalSkillsRoots.length} roots`, detail: legacy.globalSkillsRoots.join(', ') || 'none' })
  check(checks, { group: 'migration', label: 'Legacy executable plugins', status: legacy.legacyPluginFiles.length ? 'warn' : 'ok', value: `${legacy.legacyPluginFiles.length} files`, detail: legacy.legacyPluginFiles.join(', ') || 'none', remediation: legacy.legacyPluginFiles.length ? 'Legacy .js/.mjs plugins remain executable compatibility content. Review them before sharing the project.' : undefined })

  try {
    const marketplaces = await loadKnownMarketplacesSafe()
    const names = Object.keys(marketplaces).sort()
    const broken = names.filter(name => marketplaces[name]?.status === 'broken')
    check(checks, { group: 'marketplaces', label: 'Marketplace state', status: broken.length ? 'error' : 'ok', value: `${names.length} registered`, detail: `ready=${names.length - broken.length}, broken=${broken.length}`, remediation: broken.length ? `Open /marketplace and refresh: ${broken.join(', ')}` : undefined })
    check(checks, { group: 'storage', label: 'Marketplace cache', status: 'ok', value: marketplaceStateRoot() })
  } catch (error) {
    check(checks, { group: 'marketplaces', label: 'Marketplace state', status: 'error', value: 'unreadable', detail: error instanceof Error ? error.message : String(error), remediation: 'Back up ~/.termagent/marketplaces and inspect known.json.' })
  }

  try {
    const plugins = await loadInstalledPlugins()
    const records = Object.values(plugins.plugins)
    const broken = records.filter(r => r.status === 'broken').length
    const orphaned = records.filter(r => r.status === 'orphaned').length
    const pending = records.filter(r => r.status === 'update-available').length
    const disabled = records.filter(r => r.enabled === false).length
    check(checks, { group: 'plugins', label: 'Installed plugins', status: broken ? 'error' : orphaned || pending ? 'warn' : 'ok', value: `${records.length} installed`, detail: `enabled=${records.length - disabled}, disabled=${disabled}, broken=${broken}, orphaned=${orphaned}, update-available=${pending}`, remediation: broken || orphaned ? 'Run /plugins and inspect the affected plugin details before enabling or removing them.' : undefined })
    check(checks, { group: 'storage', label: 'Plugin cache', status: 'ok', value: installedPluginsRoot() })
    try {
      const policy = await loadPluginSecurityPolicy()
      const blocked = policy.blockedPlugins?.length || 0
      const revoked = Object.keys(policy.revokedPlugins || {}).length + Object.keys(policy.revokedDigests || {}).length + Object.keys(policy.revokedRevisions || {}).length
      check(checks, { group: 'plugins', label: 'Plugin security policy', status: 'ok', value: `blocked=${blocked}, revoked=${revoked}`, detail: 'Policy is parseable and available locally.' })
    } catch (error) {
      check(checks, { group: 'plugins', label: 'Plugin security policy', status: 'error', value: 'invalid', detail: error instanceof Error ? error.message : String(error), remediation: 'Fix or restore ~/.termagent/plugins/security.json. Policy corruption is fail-closed.' })
    }
  } catch (error) {
    check(checks, { group: 'plugins', label: 'Installed plugins', status: 'error', value: 'unreadable', detail: error instanceof Error ? error.message : String(error), remediation: 'Back up ~/.termagent/plugins and inspect installed.json.' })
  }

  try {
    const registries = await listSkillRegistries()
    const installedSkills = await listInstalledRegistrySkills()
    const stale = registries.filter(r => r.stale).length
    const broken = installedSkills.filter(s => s.status === 'broken').length
    const revoked = installedSkills.filter(s => s.status === 'revoked').length
    check(checks, { group: 'skills', label: 'Pure skill registries', status: stale ? 'warn' : 'ok', value: `${registries.length} registered`, detail: `stale=${stale}`, remediation: stale ? 'Refresh stale registries before installing new skills.' : undefined })
    check(checks, { group: 'skills', label: 'Pure registry skills', status: broken || revoked ? 'error' : 'ok', value: `${installedSkills.length} installed`, detail: `broken=${broken}, revoked=${revoked}` })
    check(checks, { group: 'storage', label: 'Pure skill install root', status: 'ok', value: getSkillRegistryInstallRoot() })
  } catch (error) {
    check(checks, { group: 'skills', label: 'Pure skill registries', status: 'error', value: 'unreadable', detail: error instanceof Error ? error.message : String(error), remediation: 'Back up ~/.termagent/skill-registries and inspect its JSON state.' })
  }

  try {
    const catalog = await loadSkillCatalog(project)
    const skills = catalog.list()
    const blocked = skills.filter(skill => skill.securityStatus === 'blocked').length
    const warnings = skills.filter(skill => skill.securityStatus === 'warning').length
    check(checks, { group: 'skills', label: 'Skill catalog', status: blocked ? 'error' : warnings ? 'warn' : 'ok', value: `${skills.length} discoverable`, detail: `security-warnings=${warnings}, blocked=${blocked}` })
  } catch (error) {
    check(checks, { group: 'skills', label: 'Skill catalog', status: 'error', value: 'unavailable', detail: error instanceof Error ? error.message : String(error), remediation: 'Inspect skill roots and rerun /skills.' })
  }

  for (const candidate of [path.join(process.env.HOME || project, '.termagent'), path.join(project, '.termagent')]) {
    try {
      const state = await pathState(candidate)
      if (!state.exists) continue
      check(checks, { group: 'storage', label: `Storage permissions ${candidate}`, status: state.mode !== undefined && (state.mode & 0o077) === 0 ? 'ok' : 'warn', value: `mode=${state.mode?.toString(8) || '?'}`, detail: 'TermAgent state directories should not be group/world writable.', remediation: 'Use chmod 700 on private TermAgent state directories.' })
    } catch (error) {
      check(checks, { group: 'storage', label: `Storage ${candidate}`, status: 'error', value: 'unreadable', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const counts = { ok: 0, warn: 0, error: 0 } as Record<DoctorStatus, number>
  for (const item of checks) counts[item.status]++
  return {
    ok: counts.error === 0,
    checks,
    counts,
    migrationState: migrationStatePath(),
    legacy,
    generatedAt: new Date().toISOString(),
  }
}
