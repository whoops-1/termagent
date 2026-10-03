export type ProcessGroupTermination = {
  signalled: boolean
  forced: boolean
  remaining: boolean
}

type WaitOptions = { timeoutMs?: number; pollMs?: number }

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
 * Terminate a detached POSIX process group, escalating once after a bounded
 * grace period. This mirrors the useful part of the design pattern while
 * remaining dependency-free for Termux/ARMv7.
 */
export async function terminateProcessGroup(
  pid: number | undefined,
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<ProcessGroupTermination> {
  if (!pid || pid <= 0) return { signalled: false, forced: false, remaining: false }

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
