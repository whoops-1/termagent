import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export interface TerminalDeviceCredential {
  version: 1
  workspaceId: string
  deviceId: string
  token: string
  expiresAt: number
}

function credentialPath(workspaceId: string, home = process.env.HOME || os.homedir()): string {
  if (!/^[a-f0-9]{32}$/i.test(workspaceId)) throw new Error('Invalid daemon workspace identity')
  return path.join(home, '.termagent', 'devices', `${workspaceId}.json`)
}

function decodeCredential(value: unknown, workspaceId: string): TerminalDeviceCredential | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<TerminalDeviceCredential>
  if (item.version !== 1 || item.workspaceId !== workspaceId) return undefined
  if (typeof item.deviceId !== 'string' || !/^dev_[a-f0-9]{24}$/i.test(item.deviceId)) return undefined
  if (typeof item.token !== 'string' || !item.token.startsWith('ta_dev_') || item.token.length > 256) return undefined
  if (!Number.isSafeInteger(item.expiresAt) || Number(item.expiresAt) <= Date.now()) return undefined
  return item as TerminalDeviceCredential
}

export async function loadTerminalDeviceCredential(
  workspaceId: string,
  options: { home?: string; now?: number } = {},
): Promise<TerminalDeviceCredential | undefined> {
  const file = credentialPath(workspaceId, options.home)
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch {
    await fs.rm(file, { force: true }).catch(() => undefined)
    return undefined
  }
  const credential = decodeCredential(parsed, workspaceId)
  if (!credential || credential.expiresAt <= (options.now ?? Date.now())) {
    await fs.rm(file, { force: true }).catch(() => undefined)
    return undefined
  }
  return credential
}

export async function saveTerminalDeviceCredential(
  credential: TerminalDeviceCredential,
  options: { home?: string } = {},
): Promise<string> {
  const decoded = decodeCredential(credential, credential.workspaceId)
  if (!decoded) throw new Error('Refusing to persist an invalid or expired terminal device credential')
  const file = credentialPath(credential.workspaceId, options.home)
  const directory = path.dirname(file)
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

export async function removeTerminalDeviceCredential(
  workspaceId: string,
  options: { home?: string } = {},
): Promise<void> {
  await fs.rm(credentialPath(workspaceId, options.home), { force: true })
}
