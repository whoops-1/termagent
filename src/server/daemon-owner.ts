import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type DaemonMode = 'server' | 'terminal'
export type DaemonOwnerState = 'starting' | 'ready' | 'stopping'

export interface DaemonOwnerPublicInfo {
  id: string
  workspaceId: string
  pid: number
  mode: DaemonMode
  state: DaemonOwnerState
  startedAt: number
  heartbeatAt: number
  endpoint?: string
}

interface OwnerLockRecord {
  version: 1
  id: string
  token: string
  workspaceId: string
  cwd: string
  pid: number
  processStart?: string
  /**
   * Recorded when a platform-specific process identity (e.g. /proc starttime)
   * is unavailable, so the lock still carries durable timestamp metadata.
   */
  processStartMs?: number
  mode: DaemonMode
  startedAt: number
}

interface OwnerMetadata extends DaemonOwnerPublicInfo {
  token: string
  cwd: string
}

export interface DaemonOwnerLease {
  readonly id: string
  readonly workspaceId: string
  update(patch: Partial<Pick<DaemonOwnerPublicInfo, 'state' | 'endpoint'>>): Promise<void>
  publicInfo(): DaemonOwnerPublicInfo
  release(): Promise<void>
}

export interface AcquireDaemonOwnerOptions {
  stateRoot?: string
  mode: DaemonMode
  heartbeatMs?: number
}

const DEFAULT_HEARTBEAT_MS = 2_000
const MALFORMED_LOCK_GRACE_MS = 15_000

function stateRoot(options: AcquireDaemonOwnerOptions): string {
  return options.stateRoot || path.join(process.env.HOME || os.homedir(), '.termagent', 'daemons')
}

async function canonicalWorkspace(cwd: string): Promise<string> {
  const absolute = path.resolve(cwd)
  try {
    return await fs.realpath(absolute)
  } catch {
    return absolute
  }
}

function workspaceId(cwd: string): string {
  return crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 32)
}

/**
 * Platform-conditional process-start identity. Linux exposes a stable
 * starttime via /proc; on win32 (or any host without /proc data) this returns
 * undefined and callers must degrade to pid plus recorded timestamp metadata
 * instead of crashing. Note that without this identity, a reused PID cannot be
 * distinguished from the original owner on Windows, so liveness checks fail
 * closed on `process.kill(pid, 0)`.
 */
export async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return undefined
    // /proc/<pid>/stat starts the remaining fields at field 3; starttime is field 22.
    return stat.slice(close + 1).trim().split(/\s+/)[19]
  } catch {
    return undefined
  }
}

async function processIsAlive(pid: number, expectedStart?: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as { code?: string }).code === 'ESRCH') return false
    if ((error as { code?: string }).code !== 'EPERM') throw error
  }
  if (!expectedStart) return true
  const actualStart = await processStartIdentity(pid)
  // If identity cannot be checked, fail closed: a live PID may still be the owner.
  return actualStart === undefined || actualStart === expectedStart
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  if (process.platform !== 'win32') await fs.chmod(file, 0o600).catch(() => undefined)
}

async function recordIsStale(record: OwnerLockRecord | undefined, file: string): Promise<boolean> {
  if (!record || record.version !== 1 || !record.token || !record.id) {
    const info = await fs.stat(file).catch(() => undefined)
    return Boolean(info && Date.now() - info.mtimeMs > MALFORMED_LOCK_GRACE_MS)
  }
  return !(await processIsAlive(record.pid, record.processStart))
}

async function removeStaleOwner(lockFile: string, metadataFile: string, recoveryFile: string): Promise<boolean> {
  const recoveryToken = crypto.randomBytes(16).toString('hex')
  const selfIdentity = await processStartIdentity(process.pid)
  let recoveryHandle
  try {
    recoveryHandle = await fs.open(recoveryFile, 'wx', 0o600)
    await recoveryHandle.writeFile(JSON.stringify({
      pid: process.pid,
      processStart: selfIdentity,
      ...(selfIdentity ? {} : { processStartMs: Date.now() }),
      token: recoveryToken,
    }), 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
    const guard = await readJson<{ pid: number; processStart?: string; processStartMs?: number }>(recoveryFile)
    const guardInfo = await fs.stat(recoveryFile).catch(() => undefined)
    const staleGuard = guard
      ? !(await processIsAlive(guard.pid, guard.processStart))
      : Boolean(guardInfo && Date.now() - guardInfo.mtimeMs > MALFORMED_LOCK_GRACE_MS)
    if (staleGuard) await fs.rm(recoveryFile, { force: true })
    return false
  } finally {
    if (recoveryHandle) await recoveryHandle.close().catch(() => undefined)
  }

  try {
    const observed = await readJson<OwnerLockRecord>(lockFile)
    if (!(await recordIsStale(observed, lockFile))) return false
    const current = await readJson<OwnerLockRecord>(lockFile)
    if ((observed?.token || '') !== (current?.token || '')) return false
    if (!(await recordIsStale(current, lockFile))) return false

    if (observed?.token) {
      const metadata = await readJson<OwnerMetadata>(metadataFile)
      if (metadata?.token === observed.token) await fs.rm(metadataFile, { force: true })
    }
    await fs.rm(lockFile, { force: true })
    return true
  } finally {
    const guard = await readJson<{ token?: string }>(recoveryFile)
    if (guard?.token === recoveryToken) await fs.rm(recoveryFile, { force: true }).catch(() => undefined)
  }
}

function publicProjection(metadata: OwnerMetadata): DaemonOwnerPublicInfo {
  return {
    id: metadata.id,
    workspaceId: metadata.workspaceId,
    pid: metadata.pid,
    mode: metadata.mode,
    state: metadata.state,
    startedAt: metadata.startedAt,
    heartbeatAt: metadata.heartbeatAt,
    ...(metadata.endpoint ? { endpoint: metadata.endpoint } : {}),
  }
}

export async function readDaemonOwner(cwd: string, options: { stateRoot?: string } = {}): Promise<DaemonOwnerPublicInfo | undefined> {
  const canonical = await canonicalWorkspace(cwd)
  const id = workspaceId(canonical)
  const root = options.stateRoot || path.join(process.env.HOME || os.homedir(), '.termagent', 'daemons')
  const lockFile = path.join(root, `${id}.lock`)
  const metadataFile = path.join(root, `${id}.json`)
  const [lock, metadata] = await Promise.all([
    readJson<OwnerLockRecord>(lockFile),
    readJson<OwnerMetadata>(metadataFile),
  ])
  if (!lock || !metadata || lock.token !== metadata.token || lock.id !== metadata.id || lock.workspaceId !== id || metadata.workspaceId !== id) return undefined
  if (!(await processIsAlive(lock.pid, lock.processStart))) return undefined
  return publicProjection(metadata)
}

export async function acquireDaemonOwner(cwd: string, options: AcquireDaemonOwnerOptions): Promise<DaemonOwnerLease> {
  const canonical = await canonicalWorkspace(cwd)
  const workspace = workspaceId(canonical)
  const root = stateRoot(options)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await fs.chmod(root, 0o700).catch(() => undefined)

  const lockFile = path.join(root, `${workspace}.lock`)
  const metadataFile = path.join(root, `${workspace}.json`)
  const recoveryFile = path.join(root, `${workspace}.recover`)
  const startedAt = Date.now()
  // Platform-conditional identity capture: undefined on win32 or whenever /proc
  // data is unavailable, in which case the record degrades to pid + timestamp.
  const processStart = await processStartIdentity(process.pid).catch(() => undefined)
  const record: OwnerLockRecord = {
    version: 1,
    id: crypto.randomBytes(16).toString('hex'),
    token: crypto.randomBytes(32).toString('hex'),
    workspaceId: workspace,
    cwd: canonical,
    pid: process.pid,
    processStart,
    ...(processStart ? {} : { processStartMs: startedAt }),
    mode: options.mode,
    startedAt,
  }

  let lockHandle
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      lockHandle = await fs.open(lockFile, 'wx', 0o600)
      await lockHandle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await lockHandle.sync()
      await lockHandle.close()
      lockHandle = undefined
      break
    } catch (error) {
      const createdLock = Boolean(lockHandle)
      await lockHandle?.close().catch(() => undefined)
      lockHandle = undefined
      if ((error as { code?: string }).code !== 'EEXIST') {
        if (createdLock) await fs.rm(lockFile, { force: true }).catch(() => undefined)
        throw error
      }

      const existing = await readJson<OwnerLockRecord>(lockFile)
      if (existing && !(await recordIsStale(existing, lockFile))) {
        const metadata = await readJson<OwnerMetadata>(metadataFile)
        const mode = metadata?.mode || existing.mode || 'unknown'
        const endpoint = metadata?.endpoint ? ` Web View: ${metadata.endpoint}` : ''
        throw new Error(`TermAgent already has a ${mode} runtime owner for this workspace (PID ${existing.pid}).${endpoint} Stop that owner before starting another runtime.`)
      }
      await removeStaleOwner(lockFile, metadataFile, recoveryFile)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  if (!lockHandle && !(await readJson<OwnerLockRecord>(lockFile))?.token) {
    throw new Error('Unable to establish exclusive TermAgent daemon ownership')
  }
  const owned = await readJson<OwnerLockRecord>(lockFile)
  if (owned?.token !== record.token) throw new Error('TermAgent daemon ownership changed while starting; refusing to continue')

  let metadata: OwnerMetadata = {
    ...publicProjection({ ...record, state: 'starting', heartbeatAt: Date.now(), token: record.token }),
    token: record.token,
    cwd: canonical,
  }
  let writeQueue = Promise.resolve()
  let released = false

  const persist = (patch: Partial<Pick<DaemonOwnerPublicInfo, 'state' | 'endpoint'>> = {}) => {
    writeQueue = writeQueue.then(async () => {
      if (released) return
      const current = await readJson<OwnerLockRecord>(lockFile)
      if (current?.token !== record.token) throw new Error('TermAgent daemon owner lease was lost')
      metadata = { ...metadata, ...patch, heartbeatAt: Date.now() }
      await writeJsonAtomic(metadataFile, metadata)
    })
    return writeQueue
  }

  await persist()
  const heartbeat = setInterval(() => { void persist().catch(() => undefined) }, Math.max(500, options.heartbeatMs || DEFAULT_HEARTBEAT_MS))
  ;(heartbeat as unknown as { unref?: () => void }).unref?.()

  return {
    id: record.id,
    workspaceId: workspace,
    update: async patch => { await persist(patch) },
    publicInfo: () => publicProjection(metadata),
    release: async () => {
      if (released) return
      clearInterval(heartbeat)
      await writeQueue.catch(() => undefined)
      released = true
      const current = await readJson<OwnerLockRecord>(lockFile)
      const currentMetadata = await readJson<OwnerMetadata>(metadataFile)
      if (current?.token === record.token) {
        if (currentMetadata?.token === record.token) await fs.rm(metadataFile, { force: true })
        await fs.rm(lockFile, { force: true })
      }
    },
  }
}
