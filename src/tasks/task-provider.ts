import path from 'node:path'
import type { Provider, ProviderConfig } from '../providers/types.js'
import { ProviderRouter } from '../providers/router.js'
import { loadTaskProviderCredential, newTaskCredentialRef, saveTaskProviderCredential, type TaskCredentialRoute } from './task-credentials.js'

/**
 * Authoritative provider snapshot/credential boundary for child-agent tasks.
 *
 * Persisted task records must never contain a raw provider API key. Parent-side
 * builders produce a secret-free snapshot via `subagentProviderSnapshot`; when
 * the parent's key exists only in memory it is saved to the task credential
 * store and the snapshot references it by `credentialRef`. Worker-side consumers
 * rehydrate the key through `resolveTaskProviderConfig`, which never trusts a
 * raw key found in task JSON.
 */

export interface TaskProviderSnapshot extends ProviderConfig {
  provider: string
  credentialRef?: string
}

type SnapshotWithRef = ProviderConfig & { credentialRef?: string }

export interface SubagentSnapshotOptions {
  /** Per-context tail of the missing-base-URL error: 'parallel agents' | 'a background agent' | 'a child task'. */
  label: string
  taskRoot?: string
  env?: Record<string, string | undefined>
}

export interface TaskResolutionOptions {
  taskRoot?: string
  env?: Record<string, string | undefined>
}

export function defaultTaskRoot(): string {
  return process.env.TERMAGENT_TASK_ROOT || path.join(process.env.HOME || process.cwd(), '.termagent', 'tasks')
}

/** Build the durable, secret-free provider snapshot persisted into a task record. */
export async function subagentProviderSnapshot(provider: Provider, fallback: ProviderConfig | undefined, opts: SubagentSnapshotOptions): Promise<TaskProviderSnapshot> {
  const selected = provider instanceof ProviderRouter ? provider.select('subagent') : { provider, config: provider.config || fallback }
  const cfg = selected.config
  if (!cfg?.baseUrl) throw new Error(`Provider ${selected.provider.id} has no base URL for ${opts.label}`)
  const taskRoot = opts.taskRoot || defaultTaskRoot()
  const env = opts.env ?? process.env
  const snapshot: TaskProviderSnapshot = { ...cfg, provider: cfg.provider || selected.provider.id, model: selected.provider.model, baseUrl: cfg.baseUrl }
  delete snapshot.apiKey
  if (cfg.apiKeyEnv && env[cfg.apiKeyEnv]) {
    snapshot.apiKeyEnv = cfg.apiKeyEnv
    return snapshot
  }
  if (cfg.apiKey) {
    const ref = newTaskCredentialRef()
    const route: TaskCredentialRoute = { provider: snapshot.provider, model: snapshot.model, baseUrl: snapshot.baseUrl }
    await saveTaskProviderCredential(taskRoot, ref, route, cfg.apiKey)
    delete snapshot.apiKeyEnv
    snapshot.credentialRef = ref
    return snapshot
  }
  snapshot.apiKeyEnv = cfg.apiKeyEnv
  return snapshot
}

/** Rehydrate a worker-ready provider config from a persisted snapshot without trusting raw keys in task JSON. */
export async function resolveTaskProviderConfig(snapshot: ProviderConfig | undefined, opts: TaskResolutionOptions = {}): Promise<ProviderConfig> {
  if (!snapshot) throw new Error('Agent task is missing provider configuration')
  const taskRoot = opts.taskRoot || defaultTaskRoot()
  const env = opts.env ?? process.env
  const source = snapshot as SnapshotWithRef
  const ref = typeof source.credentialRef === 'string' && source.credentialRef ? source.credentialRef : undefined
  const config: SnapshotWithRef = { ...source }
  delete config.apiKey
  delete config.credentialRef
  if (ref) {
    const credential = await loadTaskProviderCredential(taskRoot, ref, { provider: source.provider || '', model: source.model, baseUrl: source.baseUrl })
    if (!credential) throw new Error(`Child agent credential reference ${ref} is missing or invalid; restart the task from its parent runtime`)
    config.apiKey = credential.apiKey
  } else if (config.apiKeyEnv) {
    const fromEnv = env[config.apiKeyEnv]
    if (fromEnv) config.apiKey = fromEnv
    else delete config.apiKey
  }
  return config
}

/** Provider adapters the worker can create through `createProvider`; anything else is an unknown transport at preflight. */
const KNOWN_PROVIDER_ADAPTERS = ['openai-compatible', 'anthropic', 'gemini']

export interface TaskProviderPreflightFailure {
  kind: 'missing-credential' | 'missing-model' | 'incompatible-route'
  reason: string
}

export type TaskProviderPreflightResult = { ok: true } | { ok: false } & TaskProviderPreflightFailure

function preflightFailure(kind: TaskProviderPreflightFailure['kind'], reason: string): { ok: false } & TaskProviderPreflightFailure {
  return { ok: false, kind, reason }
}

/**
 * Preflight a child-task provider snapshot before spawning.
 *
 * Verifies provider/model/baseUrl presence and credential availability without
 * loading the secret into the result: a `credentialRef` is checked for
 * existence/parse against the task root only (route bound), and `apiKeyEnv` is
 * checked for resolvability in opts.env ?? process.env. The reason string never
 * contains secret material. Unknown/unsupported adapter/transport markers fail
 * as 'incompatible-route'. Returns `{ ok: true }` when the route is usable.
 */
export async function preflightTaskProviderConfig(snapshot: TaskProviderSnapshot | ProviderConfig, opts: TaskResolutionOptions = {}): Promise<TaskProviderPreflightResult> {
  const taskRoot = opts.taskRoot || defaultTaskRoot()
  const env = opts.env ?? process.env
  const config = snapshot as TaskProviderSnapshot
  if (!config.model) return preflightFailure('missing-model', 'Child task provider snapshot is missing a model; configure a model before spawning')
  if (!config.baseUrl) return preflightFailure('incompatible-route', 'Child task provider snapshot is missing a base URL; the provider route cannot be resolved')
  const provider = typeof config.provider === 'string' && config.provider ? config.provider : undefined
  if (!provider) return preflightFailure('incompatible-route', 'Child task provider snapshot is missing a provider adapter marker; no transport is selected for the route')
  if (!KNOWN_PROVIDER_ADAPTERS.includes(provider)) return preflightFailure('incompatible-route', `Unsupported provider adapter '${provider}' for ${config.baseUrl}; the route cannot be created`)
  const ref = typeof config.credentialRef === 'string' && config.credentialRef ? config.credentialRef : undefined
  if (ref) {
    const credential = await loadTaskProviderCredential(taskRoot, ref, { provider: config.provider || '', model: config.model, baseUrl: config.baseUrl })
    if (!credential) return preflightFailure('missing-credential', `Credential reference ${ref} is missing or invalid for ${provider}/${config.model} at ${config.baseUrl}; the task credential store has no usable key for this route`)
  } else if (config.apiKey) {
    // A raw key carried on the config is available but never revealed in the result.
  } else if (config.apiKeyEnv) {
    if (!env[config.apiKeyEnv]) return preflightFailure('missing-credential', `Environment variable ${config.apiKeyEnv} is not resolvable for ${provider}/${config.model} at ${config.baseUrl}; no credential is available to this task`)
  } else {
    return preflightFailure('missing-credential', `No credential is available for ${provider}/${config.model} at ${config.baseUrl}; no credential ref, apiKey, or resolvable apiKeyEnv is present`)
  }
  return { ok: true }
}

/**
 * Classify a provider attempt error without matching on secret content.
 *
 * 401/403 and invalid-credential message classes are credential-terminal: the
 * same credential must never be retried and no replacement agent spawned.
 * Transient classes (408/409/425/429/5xx, network, timeout, rate-limit) may
 * use only bounded, configured retries where such a mechanism exists.
 */
export function classifyProviderAttemptError(error: unknown): 'credential-terminal' | 'transient' | 'unknown' {
  let status: number | undefined
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const value = error as { status?: unknown }
    if (typeof value.status === 'number') status = value.status
  }
  let message = ''
  if (typeof error === 'string') {
    message = error
  } else if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const value = error as { message?: unknown }
    if (typeof value.message === 'string') message = value.message
  }
  const lower = message.toLowerCase()
  if (
    status === 401 || status === 403 ||
    /\b(?:401|403)\b/.test(lower) ||
    /invalid (?:credential|api ?key|token|auth)|unauthorized|forbidden|authentication failed|bad credentials|credentials rejected/i.test(lower)
  ) {
    return 'credential-terminal'
  }
  if (
    status === 408 || status === 409 || status === 425 || status === 429 ||
    (status !== undefined && status >= 500) ||
    /timeout|timed out|overloaded|temporar|rate.?limit|econnreset|fetch failed|socket|empty model response|service unavailable|resource exhausted|network/i.test(lower)
  ) {
    return 'transient'
  }
  return 'unknown'
}
