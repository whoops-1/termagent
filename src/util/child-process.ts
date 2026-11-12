import { spawn } from 'node:child_process'

export type ProcessGroupTermination = {
  signalled: boolean
  forced: boolean
  remaining: boolean
}

type WaitOptions = { timeoutMs?: number; pollMs?: number }

export type TerminationStage = 'graceful' | 'forced'

/**
 * The platform decision for terminating a detached child and its tree.
 *
 * POSIX targets the negative pid so the whole detached process group receives
 * the signal. Windows has no POSIX process groups and `process.kill(-pid)` is
 * invalid there, so the tree is terminated with `taskkill /PID <pid> /T /F`:
 * `/T` walks the child tree, `/F` forces termination. Exit code 128 means the
 * process was not found and is treated as a successful termination.
 *
 * The decision is pure so tests can assert argv without spawning processes.
 */
export type ProcessGroupTerminationPlan =
  | { platform: 'win32'; command: string; args: string[]; notFoundExitCode: number }
  | { platform: 'posix'; groupPid: number; signal: string }

export function planProcessGroupTermination(
  pid: number,
  options: { stage?: TerminationStage; platform?: 'win32' },
): { platform: 'win32'; command: string; args: string[]; notFoundExitCode: number }
export function planProcessGroupTermination(
  pid: number,
  options: { stage?: TerminationStage; platform?: 'posix' },
): { platform: 'posix'; groupPid: number; signal: string }
export function planProcessGroupTermination(
  pid: number,
  options?: { stage?: TerminationStage; platform?: typeof process.platform },
): ProcessGroupTerminationPlan
export function planProcessGroupTermination(
  pid: number,
  options: { stage?: TerminationStage; platform?: typeof process.platform } = {},
): ProcessGroupTerminationPlan {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    return { platform: 'win32', command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'], notFoundExitCode: 128 }
  }
  return { platform: 'posix', groupPid: -pid, signal: options.stage === 'forced' ? 'SIGKILL' : 'SIGTERM' }
}

export type TaskkillExitOutcome = 'terminated' | 'not-found' | 'unresolved'

/** Classify a taskkill exit code: 0 terminated, 128 process not found, everything else (including a signaled run) unresolved. */
export function taskkillExitOutcome(exitCode: number | null | undefined): TaskkillExitOutcome {
  if (exitCode === null || exitCode === undefined) return 'unresolved'
  if (exitCode === 0) return 'terminated'
  if (exitCode === 128) return 'not-found'
  return 'unresolved'
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined
}

/**
 * POSIX process-group probe. A negative pid targets the entire process group
 * created by a detached child. EPERM still proves the group exists.
 */
export function processGroupAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0 || process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

export function signalProcessGroup(pid: number | undefined, signal: string): boolean {
  if (!pid || pid <= 0) return false
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return true
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return false
    }
  }
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

export async function waitForProcessGroupExit(pid: number | undefined, options: WaitOptions = {}): Promise<boolean> {
  if (!pid || pid <= 0 || process.platform === 'win32') return true
  const timeoutMs = Math.max(0, options.timeoutMs ?? 1500)
  const pollMs = Math.max(10, options.pollMs ?? 30)
  const started = Date.now()
  while (processGroupAlive(pid)) {
    if (Date.now() - started >= timeoutMs) return false
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  return true
}

/**
 * Terminate a detached process group, escalating once after a bounded
 * grace period. On POSIX this targets the process group created by the
 * detached child. On Windows there are no process groups, so the child tree
 * is force-terminated with `taskkill /T /F` and exit code 128 (process not
 * found) counts as success. Dependency-free for Termux/ARMv7.
 */
export async function terminateProcessGroup(
  pid: number | undefined,
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<ProcessGroupTermination> {
  if (!pid || pid <= 0) return { signalled: false, forced: false, remaining: false }

  if (process.platform === 'win32') {
    return terminateWindowsProcessTree(pid)
  }

  const existed = processGroupAlive(pid)
  if (!existed) return { signalled: false, forced: false, remaining: false }

  const signalled = signalProcessGroup(pid, 'SIGTERM')
  if (!signalled && !processGroupAlive(pid)) return { signalled: false, forced: false, remaining: false }

  const gone = await waitForProcessGroupExit(pid, options)
  if (gone) return { signalled, forced: false, remaining: false }

  const forced = signalProcessGroup(pid, 'SIGKILL')
  const remaining = !(await waitForProcessGroupExit(pid, { timeoutMs: Math.max(200, options.graceMs ?? 1500) }))
  return { signalled, forced, remaining }
}

/**
 * Windows has no POSIX process groups; taskkill walks the detached child tree
 * itself. When taskkill is unavailable or refuses, fall back to the
 * single-process termination Node supports on win32.
 */
async function terminateWindowsProcessTree(pid: number): Promise<ProcessGroupTermination> {
  const plan = planProcessGroupTermination(pid, { stage: 'forced', platform: 'win32' })
  const exitCode = await runTerminationCommand(plan.command, plan.args)
  const outcome = taskkillExitOutcome(exitCode)
  if (outcome === 'terminated') return { signalled: true, forced: true, remaining: false }
  if (outcome === 'not-found') return { signalled: false, forced: false, remaining: false }
  const killed = signalProcessGroup(pid, 'SIGKILL')
  return { signalled: killed, forced: killed, remaining: !killed }
}

function runTerminationCommand(command: string, args: string[], timeoutMs = 5_000): Promise<number | null | undefined> {
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null | undefined) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(code)
    }
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', () => finish(undefined))
    child.once('close', (code: number | null) => finish(code))
    // A stalled taskkill must not hang termination forever; the caller falls
    // back to the single-process kill on an undefined result.
    timer = setTimeout(() => finish(undefined), Math.max(1, timeoutMs))
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

/**
 * Writes to child stdin with an explicit completion bound. A timed-out write
 * may have partially reached the child, so callers must treat the operation as
 * delivered-or-unknown rather than blindly retrying.
 */
export async function writeChildStdinWithTimeout(
  child: any,
  input: string,
  options: { timeoutMs?: number; appendNewline?: boolean } = {},
): Promise<void> {
  const stream = child.stdin
  if (!stream) throw new Error('Child stdin is not writable')

  const payload = options.appendNewline === false || input.endsWith('\n') ? input : `${input}\n`
  const timeoutMs = Math.max(1, options.timeoutMs ?? 1000)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        stream.write(payload, 'utf8', (error: Error | null) => (error ? reject(error) : resolve()))
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`child stdin write timed out after ${timeoutMs}ms; input may be partially delivered`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
