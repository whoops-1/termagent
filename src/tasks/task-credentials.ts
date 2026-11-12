import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Task-scoped, daemon-owned provider credential store.
 *
 * Child-agent task records must never persist raw provider API keys. When the
 * parent runtime holds a key only in memory (config-file literal or
 * programmatic config), the snapshot saved into the task record carries an
 * opaque `credentialRef` instead, and the key itself is stored here under the
 * task root with daemon-owned permissions. The ref is a random 24-hex token;
 * possession of the task root directory is what guards the secret, so refs are
 * safe to keep inside task JSON and event streams.
 */

export interface TaskCredentialRoute {
  provider: string
  model: string
  baseUrl: string
}

export interface TaskProviderCredential {
  version: 1
  ref: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  createdAt: number
}

const CREDENTIAL_REF_PATTERN = /^[a-f0-9]{24}$/

export function newTaskCredentialRef(): string {
  return crypto.randomBytes(12).toString('hex')
}

function credentialDirectory(root: string): string {
  return path.join(root, 'credentials')
}

function decodeTaskCredential(value: unknown, ref: string, route: TaskCredentialRoute): TaskProviderCredential | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Partial<TaskProviderCredential>
  if (item.version !== 1 || item.ref !== ref) return undefined
  if (item.provider !== route.provider || item.model !== route.model || item.baseUrl !== route.baseUrl) return undefined
  if (typeof item.apiKey !== 'string' || !item.apiKey) return undefined
  if (typeof item.createdAt !== 'number' || !Number.isSafeInteger(item.createdAt)) return undefined
  return item as TaskProviderCredential
}

export async function saveTaskProviderCredential(root: string, ref: string, route: TaskCredentialRoute, apiKey: string): Promise<string> {
  // The ref is interpolated into the credential file name. Reject anything that
  // is not a plain 24-hex token before it can escape the credentials directory.
  if (typeof ref !== 'string' || !CREDENTIAL_REF_PATTERN.test(ref)) throw new Error('Refusing to persist an invalid task provider credential')
  const decoded = decodeTaskCredential(
    { version: 1, ref, provider: route.provider, model: route.model, baseUrl: route.baseUrl, apiKey, createdAt: Date.now() },
    ref,
    route,
  )
  if (!decoded) throw new Error('Refusing to persist an invalid task provider credential')
  const directory = credentialDirectory(root)
  const file = path.join(directory, `${ref}.json`)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700).catch(() => undefined)
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(decoded, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try { await fs.rename(temporary, file) }
  catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  if (process.platform !== 'win32') await fs.chmod(file, 0o600).catch(() => undefined)
  return file
}

export async function loadTaskProviderCredential(root: string, ref: string, route: TaskCredentialRoute): Promise<TaskProviderCredential | undefined> {
  if (typeof ref !== 'string' || !CREDENTIAL_REF_PATTERN.test(ref)) return undefined
  const file = path.join(credentialDirectory(root), `${ref}.json`)
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { return undefined }
  return decodeTaskCredential(parsed, ref, route)
}
