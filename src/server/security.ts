import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEVICE_SCOPES = [
  'workspace:read',
  'workspace:write',
  'interaction:resolve',
  'task:control',
  'device:revoke:self',
] as const

export type DeviceScope = typeof DEVICE_SCOPES[number]

export type DeviceRecord = {
  id: string
  name: string
  tokenHash: string
  workspaceId: string
  scopes: DeviceScope[]
  issuedAt: number
  expiresAt: number
  revokedAt?: number
}

export type SafeDeviceRecord = Omit<DeviceRecord, 'tokenHash' | 'workspaceId'>

type AuditRecord = {
  id: string
  at: number
  event: 'device.paired' | 'device.revoked' | 'pairing.locked'
  deviceId: string
  deviceName: string
}

type AuthState = {
  version: 1
  workspaceId: string
  devices: DeviceRecord[]
  audit: AuditRecord[]
}

export type PairingResult = {
  token: string
  device: SafeDeviceRecord
  scope: 'workspace'
}

export type DeviceAuthOptions = {
  workspaceRoot: string
  storePath?: string
  pairingTtlMs?: number
  tokenTtlMs?: number
  now?: () => number
  onPairingCode?: (info: { code: string; expiresAt: number }) => void
}

const PAIRING_TTL_MS = 5 * 60 * 1000
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_DEVICES = 32
const MAX_AUDIT_RECORDS = 500
const MAX_PAIR_ATTEMPTS = 5

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function sanitizeDeviceName(value: unknown): string {
  const normalized = String(value || 'TermAgent device')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
  return normalized || 'TermAgent device'
}

function safeDevice(record: DeviceRecord): SafeDeviceRecord {
  const { tokenHash: _tokenHash, workspaceId: _workspaceId, ...safe } = record
  return { ...safe, scopes: [...safe.scopes] }
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>()

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.windows.get(key)
    if (!current || now - current.startedAt >= windowMs || now < current.startedAt) {
      this.windows.set(key, { startedAt: now, count: 1 })
      this.prune(now)
      return true
    }
    current.count += 1
    return current.count <= limit
  }

  private prune(now: number) {
    if (this.windows.size < 256) return
    for (const [key, value] of this.windows) {
      if (now - value.startedAt > 10 * 60 * 1000) this.windows.delete(key)
    }
    while (this.windows.size > 2048) {
      const first = this.windows.keys().next().value
      if (!first) break
      this.windows.delete(first)
    }
  }
}

export class DeviceAuthStore {
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly storePath: string
  readonly rateLimiter = new FixedWindowRateLimiter()
  private readonly now: () => number
  private readonly pairingTtlMs: number
  private readonly tokenTtlMs: number
  private readonly onPairingCode?: DeviceAuthOptions['onPairingCode']
  private state: AuthState
  private pairingCode = ''
  private pairingCodeHash = ''
  private pairingExpiresAt = 0
  private failedPairingAttempts = 0
  private writeQueue: Promise<unknown> = Promise.resolve()

  private constructor(options: DeviceAuthOptions, state: AuthState) {
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.workspaceId = sha256(this.workspaceRoot)
    this.storePath = options.storePath || path.join(
      os.homedir() || process.cwd(),
      '.termagent',
      'server-auth',
      `${this.workspaceId.slice(0, 32)}.json`,
    )
    this.now = options.now || Date.now
    this.pairingTtlMs = options.pairingTtlMs ?? PAIRING_TTL_MS
    this.tokenTtlMs = options.tokenTtlMs ?? TOKEN_TTL_MS
    this.onPairingCode = options.onPairingCode
    if (!Number.isFinite(this.pairingTtlMs) || this.pairingTtlMs <= 0) throw new Error('Pairing code TTL must be positive')
    if (!Number.isFinite(this.tokenTtlMs) || this.tokenTtlMs <= 0) throw new Error('Device token TTL must be positive')
    this.state = state
    this.rotatePairingCode()
  }

  static async open(options: DeviceAuthOptions): Promise<DeviceAuthStore> {
    const workspaceRoot = path.resolve(options.workspaceRoot)
    const workspaceId = sha256(workspaceRoot)
    const storePath = options.storePath || path.join(
      os.homedir() || process.cwd(),
      '.termagent',
      'server-auth',
      `${workspaceId.slice(0, 32)}.json`,
    )
    await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 })
    try { await fs.chmod(path.dirname(storePath), 0o700) } catch {}

    let state: AuthState = { version: 1, workspaceId, devices: [], audit: [] }
    try {
      const fileInfo = await fs.lstat(storePath)
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('Device authorization state must be a regular file, not a symlink')
      await fs.chmod(storePath, 0o600)
      const raw = JSON.parse(await fs.readFile(storePath, 'utf8')) as Partial<AuthState>
      if (raw.version !== 1 || raw.workspaceId !== workspaceId || !Array.isArray(raw.devices) || !Array.isArray(raw.audit)) {
        throw new Error('Device authorization state has an unsupported or mismatched format')
      }
      state = {
        version: 1,
        workspaceId,
        devices: raw.devices.filter((item): item is DeviceRecord => Boolean(
          item && typeof item.id === 'string' && /^dev_[a-f0-9]{24}$/.test(item.id) &&
          typeof item.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(item.tokenHash) &&
          item.workspaceId === workspaceId && Array.isArray(item.scopes) && item.scopes.length > 0 &&
          item.scopes.every(scope => DEVICE_SCOPES.includes(scope as DeviceScope)) &&
          typeof item.name === 'string' && Number.isFinite(item.issuedAt) && Number.isFinite(item.expiresAt) &&
          (item.revokedAt === undefined || Number.isFinite(item.revokedAt)),
        )),
        audit: raw.audit.filter((item): item is AuditRecord => Boolean(
          item && typeof item.id === 'string' && ['device.paired', 'device.revoked', 'pairing.locked'].includes(String(item.event)) &&
          typeof item.deviceId === 'string' && Number.isFinite(item.at),
        )).slice(-MAX_AUDIT_RECORDS),
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }

    return new DeviceAuthStore({ ...options, workspaceRoot, storePath }, state)
  }

  pairingInfo(): { code: string; expiresAt: number } {
    if (!this.isPairingCodeActive()) this.rotatePairingCode(true)
    return { code: this.pairingCode, expiresAt: this.pairingExpiresAt }
  }

  isPairingCodeActive(): boolean {
    return Boolean(this.pairingCode && this.pairingExpiresAt > this.now() && this.failedPairingAttempts < MAX_PAIR_ATTEMPTS)
  }

  async pair(code: unknown, name: unknown, rateLimitKey: string): Promise<PairingResult> {
    return await this.serialize(async () => {
      const now = this.now()
      if (!this.rateLimiter.allow(`pair:${rateLimitKey}`, 5, 5 * 60 * 1000, now)) {
        throw new Error('Pairing temporarily rate limited')
      }
      // Expired or exhausted codes rotate before comparison. The replacement is only
      // printed by the server process; it is never returned to the untrusted caller.
      if (!this.isPairingCodeActive()) this.rotatePairingCode(true)
      const candidate = String(code || '').replace(/\s+/g, '').toUpperCase()
      const candidateHash = /^[A-F0-9]{10}$/.test(candidate) ? sha256(candidate) : sha256('invalid-pairing-code')
      const codeMatches = safeEqual(candidateHash, this.pairingCodeHash)
      if (!this.isPairingCodeActive() || !codeMatches) {
        this.failedPairingAttempts += 1
        if (this.failedPairingAttempts >= MAX_PAIR_ATTEMPTS) {
          this.state.audit.push({ id: crypto.randomUUID(), at: now, event: 'pairing.locked', deviceId: 'unknown', deviceName: 'pairing-code' })
          this.state.audit = this.state.audit.slice(-MAX_AUDIT_RECORDS)
          await this.persist()
          this.rotatePairingCode(true)
        }
        throw new Error('Invalid or expired pairing code')
      }

      const activeDevices = this.state.devices.filter(item => !item.revokedAt && item.expiresAt > now)
      if (activeDevices.length >= MAX_DEVICES) throw new Error('Device pairing limit reached; revoke an existing device first')

      const token = `ta_dev_${crypto.randomBytes(32).toString('base64url')}`
      const device: DeviceRecord = {
        id: `dev_${crypto.randomBytes(12).toString('hex')}`,
        name: sanitizeDeviceName(name),
        tokenHash: sha256(token),
        workspaceId: this.workspaceId,
        scopes: [...DEVICE_SCOPES],
        issuedAt: now,
        expiresAt: now + this.tokenTtlMs,
      }

      this.state.devices.push(device)
      this.state.audit.push({ id: crypto.randomUUID(), at: now, event: 'device.paired', deviceId: device.id, deviceName: device.name })
      this.state.audit = this.state.audit.slice(-MAX_AUDIT_RECORDS)
      try {
        await this.persist()
      } catch (error) {
        this.state.devices = this.state.devices.filter(item => item.id !== device.id)
        this.state.audit = this.state.audit.filter(item => item.deviceId !== device.id || item.event !== 'device.paired')
        throw error
      }

      // Each issued code can be redeemed once. Rotate immediately so additional
      // devices can pair without restarting the daemon; the replacement is logged
      // only to the owner-controlled server terminal.
      this.rotatePairingCode(true)
      return { token, device: safeDevice(device), scope: 'workspace' }
    })
  }

  async authenticate(token: string): Promise<SafeDeviceRecord | undefined> {
    if (!token || token.length > 256) return undefined
    const candidateHash = sha256(token)
    const now = this.now()
    for (const item of this.state.devices) {
      if (!safeEqual(candidateHash, item.tokenHash)) continue
      if (item.workspaceId !== this.workspaceId || item.revokedAt || item.expiresAt <= now) return undefined
      return safeDevice(item)
    }
    return undefined
  }

  async getDevice(id: string): Promise<SafeDeviceRecord | undefined> {
    const item = this.state.devices.find(record => record.id === id)
    if (!item || item.revokedAt || item.expiresAt <= this.now()) return undefined
    return safeDevice(item)
  }

  async revokeSelf(id: string): Promise<boolean> {
    return await this.serialize(async () => {
      const item = this.state.devices.find(record => record.id === id)
      if (!item || item.revokedAt || item.expiresAt <= this.now()) return false
      const revokedAt = this.now()
      const previousAudit = this.state.audit
      item.revokedAt = revokedAt
      this.state.audit = [...previousAudit, { id: crypto.randomUUID(), at: revokedAt, event: 'device.revoked' as const, deviceId: item.id, deviceName: item.name }].slice(-MAX_AUDIT_RECORDS)
      try {
        await this.persist()
      } catch (error) {
        delete item.revokedAt
        this.state.audit = previousAudit
        throw error
      }
      return true
    })
  }

  async audit(event: AuditRecord['event'], deviceId: string, deviceName: string): Promise<void> {
    await this.serialize(async () => {
      this.state.audit.push({ id: crypto.randomUUID(), at: this.now(), event, deviceId, deviceName })
      this.state.audit = this.state.audit.slice(-MAX_AUDIT_RECORDS)
      await this.persist()
    })
  }

  private rotatePairingCode(notify = false) {
    this.pairingCode = crypto.randomBytes(5).toString('hex').toUpperCase()
    this.pairingCodeHash = sha256(this.pairingCode)
    this.pairingExpiresAt = this.now() + this.pairingTtlMs
    this.failedPairingAttempts = 0
    if (notify) { try { this.onPairingCode?.({ code: this.pairingCode, expiresAt: this.pairingExpiresAt }) } catch {} }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist() {
    const directory = path.dirname(this.storePath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    try { await fs.chmod(directory, 0o700) } catch {}
    const temporary = `${this.storePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fs.chmod(temporary, 0o600)
      await fs.rename(temporary, this.storePath)
      await fs.chmod(this.storePath, 0o600)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}

export function isLoopbackBind(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1' || normalized.startsWith('127.')
}

export function parsePublicOrigin(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Public origin must be an absolute HTTPS origin') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Public origin must be an HTTPS origin without credentials, path, query or fragment')
  }
  return url
}

export function extractBearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header || '')
  return match?.[1]?.trim() || undefined
}

export function constantTimeTokenEqual(candidate: string, expected: string): boolean {
  if (!candidate || !expected || candidate.length > 512 || expected.length > 512) return false
  return safeEqual(sha256(candidate), sha256(expected))
}
