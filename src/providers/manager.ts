import path from 'node:path'
import { promises as fs } from 'node:fs'
import { exists } from '../util/fs.js'
import type { Config, ProviderProfile } from '../config/config.js'

export type ProviderManagerProfile = ProviderProfile & {
  name: string
  apiKeyConfigured: boolean
}

export type ProviderManagerSnapshot = {
  profiles: ProviderManagerProfile[]
  activeName?: string
}

export type ProviderProfileDraft = {
  name: string
  provider: string
  model: string
  baseUrl: string
  apiKey?: string
}

const HOME = () => process.env.HOME || process.cwd()

export async function getProviderConfigPath(cwd: string): Promise<string> {
  const projectPath = path.join(cwd, '.termagent', 'config.json')
  if (await exists(projectPath)) return projectPath
  return path.join(HOME(), '.termagent', 'config.json')
}

async function readConfigObject(filePath: string): Promise<Record<string, unknown>> {
  if (!(await exists(filePath))) return {}
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Invalid TermAgent config: ${filePath}: ${(error as Error).message}`)
  }
}

async function writeConfigObject(filePath: string, config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try { await fs.chmod(filePath, 0o600) } catch {}
}

export async function listProviderProfiles(cwd: string, cfg: Config): Promise<ProviderManagerSnapshot> {
  const profiles = Object.entries(cfg.providers || {}).map(([name, profile]) => ({
    ...profile,
    name,
    apiKeyConfigured: Boolean(profile.apiKey || (profile.apiKeyEnv && process.env[profile.apiKeyEnv])),
  }))
  const activeName = cfg.providers?.[cfg.provider] ? cfg.provider : undefined
  return { profiles, activeName }
}

export function profileFromDraft(draft: ProviderProfileDraft, existing?: ProviderProfile): ProviderProfile {
  const profile: ProviderProfile = {
    provider: draft.provider.trim() || existing?.provider || 'openai-compatible',
    model: draft.model.trim(),
    baseUrl: draft.baseUrl.trim(),
  }
  const key = draft.apiKey?.trim()
  if (key) profile.apiKey = key
  else if (existing?.apiKey) profile.apiKey = existing.apiKey
  else if (existing?.apiKeyEnv) profile.apiKeyEnv = existing.apiKeyEnv
  return profile
}

export async function saveProviderProfile(cwd: string, draft: ProviderProfileDraft, existingName?: string): Promise<{ name: string; profile: ProviderProfile; path: string }> {
  const name = draft.name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('Provider name must be 1-64 characters and use only letters, numbers, ., _, or -.')
  }
  if (!draft.model.trim()) throw new Error('Model is required.')
  if (!draft.baseUrl.trim()) throw new Error('Base URL is required.')

  const filePath = await getProviderConfigPath(cwd)
  const config = await readConfigObject(filePath)
  const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, ProviderProfile>
  const existing = existingName ? providers[existingName] : undefined
  const profile = profileFromDraft(draft, existing)
  providers[name] = profile
  if (existingName && existingName !== name) delete providers[existingName]
  config.providers = providers

  // Creating the first saved profile also makes it convenient to activate immediately,
  // matching the provider-manager workflow users expect. Existing active providers remain active.
  if (!config.provider || (existingName && config.provider === existingName)) {
    config.provider = name
    config.model = profile.model
    config.baseUrl = profile.baseUrl
  }
  await writeConfigObject(filePath, config)
  return { name, profile, path: filePath }
}

export async function removeProviderProfile(cwd: string, name: string): Promise<{ removed: ProviderProfile; path: string; nextActive?: string }> {
  const filePath = await getProviderConfigPath(cwd)
  const config = await readConfigObject(filePath)
  const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, ProviderProfile>
  const removed = providers[name]
  if (!removed) throw new Error(`Unknown provider profile: ${name}`)
  delete providers[name]
  config.providers = providers

  let nextActive: string | undefined
  if (config.provider === name) {
    const remaining = Object.keys(providers)
    nextActive = remaining[0]
    if (nextActive) {
      const next = providers[nextActive]!
      config.provider = nextActive
      config.model = next.model
      config.baseUrl = next.baseUrl
    }
    else {
      delete config.provider
      delete config.model
      delete config.baseUrl
    }
  }
  await writeConfigObject(filePath, config)
  return { removed, path: filePath, nextActive }
}

export async function setActiveProviderProfile(cwd: string, name: string): Promise<{ profile: ProviderProfile; path: string }> {
  const filePath = await getProviderConfigPath(cwd)
  const config = await readConfigObject(filePath)
  const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, ProviderProfile>
  const profile = providers[name]
  if (!profile) throw new Error(`Unknown provider profile: ${name}`)
  config.provider = name
  config.model = profile.model
  config.baseUrl = profile.baseUrl
  config.apiKeyEnv = profile.apiKeyEnv || ''
  await writeConfigObject(filePath, config)
  return { profile, path: filePath }
}

export async function useEnvironmentProvider(cwd: string): Promise<{ path: string }> {
  const filePath = await getProviderConfigPath(cwd)
  const config = await readConfigObject(filePath)
  delete config.provider
  delete config.model
  delete config.baseUrl
  delete config.apiKeyEnv
  await writeConfigObject(filePath, config)
  return { path: filePath }
}
