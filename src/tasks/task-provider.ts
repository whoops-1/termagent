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
