import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'

export type DraftState = { stash?: string; queue: string[] }

type Lease = { path: string; token: string }

function stateFile(cwd: string) {
  const id = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 24)
  return path.join(process.env.HOME || os.homedir(), '.termagent', 'drafts', `${id}.json`)
}

function lockFile(cwd: string) { return `${stateFile(cwd)}.lock` }

async function readState(cwd: string): Promise<DraftState> {
  try {
    const data = JSON.parse(await fs.readFile(stateFile(cwd), 'utf8'))
    return { stash: typeof data?.stash === 'string' ? data.stash : undefined, queue: Array.isArray(data?.queue) ? data.queue.filter((x: unknown): x is string => typeof x === 'string' && Boolean(x.trim())) : [] }
  } catch { return { queue: [] } }
}

async function writeState(cwd: string, state: DraftState) {
  const file = stateFile(cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(temp, JSON.stringify({ stash: state.stash, queue: state.queue }, null, 2) + '\n', { mode: 0o600 })
  await fs.rename(temp, file)
}

async function acquire(cwd: string): Promise<Lease> {
  const lock = lockFile(cwd)
  await fs.mkdir(path.dirname(lock), { recursive: true })
  const token = crypto.randomBytes(12).toString('hex')
  const payload = JSON.stringify({ pid: process.pid, token, started: Date.now() }) + '\n'
  const staleAfterMs = 30_000
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      const handle = await fs.open(lock, 'wx')
      try { await handle.writeFile(payload, 'utf8') } finally { await handle.close() }
      return { path: lock, token }
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      let owner: any
      try { owner = JSON.parse(await fs.readFile(lock, 'utf8')) } catch (readError) {
        if ((readError as { code?: string }).code === 'ENOENT') continue
        const info = await fs.stat(lock).catch(() => undefined)
        if (info && Date.now() - info.mtimeMs < 5000) { await new Promise(r => setTimeout(r, 15)); continue }
        await fs.rm(lock, { force: true }); continue
      }
      const pid = Number(owner?.pid)
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 10)); continue }
        catch (probeError) { if ((probeError as { code?: string }).code !== 'ESRCH') throw probeError }
      }
      const info = await fs.stat(lock).catch(() => undefined)
      if (!info || Date.now() - info.mtimeMs >= staleAfterMs) {
        await fs.rm(lock, { force: true })
        continue
      }
      await new Promise(r => setTimeout(r, 10))
    }
  }
  throw new Error('Prompt draft state is busy')
}

async function release(lease: Lease) {
  try {
    const owner = JSON.parse(await fs.readFile(lease.path, 'utf8'))
    if (owner?.pid === process.pid && owner?.token === lease.token) await fs.rm(lease.path, { force: true })
  } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
}

export class PromptQueueStore {
  constructor(private readonly cwd: string) {}
  private async mutate(fn: (state: DraftState) => DraftState | Promise<DraftState>) {
    const lease = await acquire(this.cwd)
    try { const next = await fn(await readState(this.cwd)); await writeState(this.cwd, next); return next }
    finally { await release(lease) }
  }
  async stash(text: string) { await this.mutate(state => ({ ...state, stash: text })) }
  async clearStash() { await this.mutate(state => { const next = { ...state }; delete next.stash; return next }) }
  async popStash() {
    let value: string | undefined
    await this.mutate(state => { value = state.stash; const next = { ...state }; delete next.stash; return next })
    return value
  }
  async enqueue(text: string) {
    const next = await this.mutate(state => ({ ...state, queue: [...state.queue, text] }))
    return next.queue.length
  }
  async dequeue() {
    let value: string | undefined
    await this.mutate(state => { value = state.queue[0]; return { ...state, queue: state.queue.slice(1) } })
    return value
  }
  async list() { return await readState(this.cwd) }
  async clear() { await this.mutate(() => ({ queue: [] })) }
}
