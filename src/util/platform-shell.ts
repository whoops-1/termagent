import { stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Authoritative platform shell resolution for TermAgent.
 *
 * TermAgent historically assumed a POSIX `sh` everywhere: shell-selection sites
 * used `process.env.SHELL || 'sh'` and spawned `sh -lc <script>`. That silently
 * breaks on win32, where no `sh` exists and COMSPEC (cmd.exe) has different
 * argv and grammar conventions. This module is the single decision point so
 * every spawning call site derives the same executable + argv shape.
 *
 * Platform decision (documented design, Phase 14I-B3):
 *
 * POSIX (non-win32) — unchanged exactly:
 *   command = `$SHELL || sh`, flags = `-lc` (login shell + command), which is
 *   what every historical call site did. `TERMAGENT_SHELL` is intentionally
 *   ignored on POSIX to keep existing behavior byte-for-byte stable.
 *
 * win32 — decision order:
 *   1. `TERMAGENT_SHELL` explicit override wins. If the override is a
 *      sh-compatible executable it gets sh-style flags; if it is cmd.exe it
 *      gets cmd-style flags; any other value is assumed to be a sh-compatible
 *      shell because the override exists precisely to point TermAgent at one
 *      (see the error guidance below). A cmd-like override still refuses to
 *      mangle sh-style scripts: it fails loudly instead.
 *   2. Otherwise prefer a sh-compatible shell found on PATH (`sh.exe` first,
 *      then `bash.exe`; entries under the Windows system directory are skipped
 *      so the WSL `bash.exe` shim is never picked as a "native" shell).
 *   3. Otherwise fall back to COMSPEC (cmd.exe) with `/d /s /c`. This can run
 *      plain Windows commands, but sh-style scripts need the override — so
 *      instead of silently mangling them, resolution fails with a precise,
 *      actionable error telling the user how to point TermAgent at a
 *      sh-compatible shell.
 *
 * The decision itself is a pure, testable, async function: it never spawns a
 * process. PATH discovery only probes existence through an injectable async
 * predicate.
 */

export type ShellKind = 'posix' | 'windows'

export type ShellSource =
  | 'posix-shell-env'
  | 'posix-default-sh'
  | 'explicit-shell'
  | 'termagent-shell-override'
  | 'path-sh'
  | 'comspec'

/**
 * A resolved shell invocation. `args` are the flag arguments that precede the
 * script; the script text is appended by the caller.
 *
 * Prefer `spawnPlanFor(decision, script)` over appending args manually: the
 * plan carries the spawn option that keeps the script intact on cmd.exe.
 */
export interface ResolvedShell {
  /** Executable to spawn (bare name or absolute path). */
  command: string
  /** Flag arguments preceding the script. */
  args: string[]
  /** Invocation grammar family the flags belong to. */
  kind: ShellKind
  /** How the shell was selected (diagnostics only; not behavioral). */
  source: ShellSource
}

export interface ShellResolutionInput {
  /**
   * The sh-style script the caller wants to execute. Required so the win32
   * cmd.exe fallback can refuse to mangle sh-style scripts instead of
   * silently producing wrong behavior.
   */
  script: string
  /**
   * Explicit caller-selected shell executable. Preserves the historical
   * call-site contract where a caller passed `shell: 'sh'` explicitly; the
   * caller owns the executable choice and only the argv flags are derived.
   */
  shell?: string
  /**
   * Login-shell mode. `true` (default) yields `-lc`, `false` yields `-c`.
   * Preserves each call site's historical semantics exactly.
   */
  login?: boolean
  /** Environment to consult. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Platform to decide for. Defaults to `process.platform`. */
  platform?: string
  /** Injectable existence probe for PATH discovery (tests). */
  pathExists?: (candidate: string) => Promise<boolean>
}

/** Basenames (minus extension) treated as sh-compatible shells. */
const SH_FAMILY = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'mksh'])

/**
 * Lexical signals that a script uses POSIX sh grammar cmd.exe cannot run.
 * Deliberately conservative and high-signal (same philosophy as the shell
 * background-operator probe in `tasks/shell-command.ts`): this is a safety
 * signal, not a shell parser. Operators cmd.exe DOES support (`&&`, `||`,
 * pipes, `>`, `2>&1`) are intentionally not signals.
 */
const POSIX_ONLY_SIGNALS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\{?[A-Za-z_?@#*]/, reason: 'POSIX parameter/variable expansion ($VAR, ${VAR}, $?)' },
  { pattern: /\$\(/, reason: 'POSIX command substitution $(...)' },
  { pattern: /`/, reason: 'POSIX backtick command substitution' },
  { pattern: /\bexport\s+[A-Za-z_]/, reason: 'POSIX `export`' },
  { pattern: /\bunset\s+-?[a-zA-Z]/, reason: 'POSIX `unset`' },
  { pattern: /(?:^|\s)\[\[/, reason: 'bash `[[` conditional' },
  { pattern: /(?:^|\s)function\s+\w+/, reason: 'POSIX shell function definition' },
  { pattern: /(?:^|\s)~(?:\/|\s|$)/, reason: '`~` home shorthand' },
  { pattern: /(?:^|\s)\.\/[^\s]*\.sh\b/, reason: 'direct .sh script execution' },
  { pattern: /\\\r?\n/, reason: 'POSIX backslash line continuation' },
  { pattern: /;/, reason: '`;` command separator' },
  { pattern: /(?:^|\s)'[^']*'(?=\s|$)/, reason: 'single-quoted argument' },
]

function shellBaseName(command: string): string {
  return path.basename(command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
}

function isShCompatible(command: string): boolean {
  return SH_FAMILY.has(shellBaseName(command))
}

/**
 * Derive the argv flag shape for a chosen shell executable while preserving
 * historical semantics: sh-compatible shells get `-lc`/`-c`, cmd.exe gets
 * `/d /s /c`, and any other explicitly chosen shell gets sh-style flags
 * because overrides exist to provide a sh-compatible shell.
 */
function invocationFor(command: string, login: boolean, source: ShellSource): ResolvedShell {
  if (shellBaseName(command) === 'cmd') {
    return { command, args: ['/d', '/s', '/c'], kind: 'windows', source }
  }
  return { command, args: login ? ['-lc'] : ['-c'], kind: 'posix', source }
}

/**
 * Scan PATH for a sh-compatible shell executable. `sh.exe` is preferred over
 * `bash.exe` inside each entry because any `sh.exe` is sh-compatible while
 * `bash.exe` may be the WSL shim (entries under the Windows system directory
 * are skipped entirely for that reason).
 */
async function findShCompatibleShellOnPath(
  env: Record<string, string | undefined>,
  platform: string,
  pathExists: (candidate: string) => Promise<boolean>,
): Promise<string | undefined> {
  const pathValue = typeof env.PATH === 'string' ? env.PATH : ''
  if (!pathValue) return undefined
  const delimiter = platform === 'win32' ? ';' : ':'
  const systemRoot = typeof env.SystemRoot === 'string' && env.SystemRoot !== ''
    ? env.SystemRoot
    : (typeof env.WINDIR === 'string' && env.WINDIR !== '' ? env.WINDIR : undefined)
  const excludedRoot = systemRoot ? path.resolve(systemRoot).toLowerCase() : undefined
  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = rawEntry.trim()
    if (!entry) continue
    if (excludedRoot) {
      const resolvedEntry = path.resolve(entry).toLowerCase()
      const excludedBoundary = excludedRoot.endsWith(path.sep) ? excludedRoot : excludedRoot + path.sep
      if (resolvedEntry === excludedRoot || resolvedEntry.startsWith(excludedBoundary)) continue
    }
    for (const name of ['sh.exe', 'bash.exe']) {
      const candidate = path.join(entry, name)
      try {
        if (await pathExists(candidate)) return candidate
      } catch { /* a failing probe skips the candidate; PATH scanning is best-effort */ }
    }
  }
  return undefined
}

function posixSignals(script: string): string[] {
  return POSIX_ONLY_SIGNALS.filter(signal => signal.pattern.test(script)).map(signal => signal.reason)
}

function shortenScript(script: string): string {
  const oneLine = script.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

/**
 * Refuse to run a sh-style script under a cmd-grammar shell. Callers surface
 * this as a precise tool/doctor error; nothing is spawned and nothing is
 * silently mangled.
 */
function assertShellSupportsScript(script: string, decision: ResolvedShell, overrideActive: boolean): void {
  if (decision.kind !== 'windows') return
  const signals = posixSignals(script)
  if (signals.length === 0) return
  const howToFix = overrideActive
    ? 'TERMAGENT_SHELL is currently set to a cmd-grammar shell; set it to a sh-compatible executable (for example the Git for Windows sh.exe) instead.'
    : 'Set TERMAGENT_SHELL to a sh-compatible executable (for example the Git for Windows sh.exe) or add its directory to PATH, then retry.'
  throw new Error(
    `No sh-compatible shell is available on Windows and this command uses sh-only syntax (${signals.join(', ')}). ` +
    `Refusing to run it under ${decision.command} because that would silently misinterpret it: "${shortenScript(script)}". ${howToFix}`,
  )
}

/**
 * Resolve the shell invocation for one script. Never spawns a process.
 * Throws (win32 only, cmd.exe fallback / cmd override) when the script uses
 * sh-only grammar that cmd.exe cannot run; the error states exactly how to
 * provide a sh-compatible shell.
 *
 * Async because win32 PATH discovery probes the filesystem (`node:fs/promises`
 * `access`) without spawning. POSIX resolution performs no I/O.
 */
export async function resolveShell(input: ShellResolutionInput): Promise<ResolvedShell> {
  const login = input.login ?? true
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const pathExists = input.pathExists ?? ((candidate: string) => stat(candidate).then(() => true).catch(() => false))

  if (typeof input.shell === 'string' && input.shell.trim() !== '') {
    return invocationFor(input.shell.trim(), login, 'explicit-shell')
  }

  if (platform !== 'win32') {
    const shell = typeof env.SHELL === 'string' && env.SHELL.trim() !== '' ? env.SHELL.trim() : 'sh'
    return invocationFor(shell, login, env.SHELL && env.SHELL.trim() !== '' ? 'posix-shell-env' : 'posix-default-sh')
  }

  const override = typeof env.TERMAGENT_SHELL === 'string' ? env.TERMAGENT_SHELL.trim() : ''
  if (override !== '') {
    const decision = invocationFor(override, login, 'termagent-shell-override')
    assertShellSupportsScript(input.script, decision, true)
    return decision
  }

  const onPath = await findShCompatibleShellOnPath(env, platform, pathExists)
  if (onPath) return invocationFor(onPath, login, 'path-sh')

  const comspec = typeof env.COMSPEC === 'string' && env.COMSPEC.trim() !== '' ? env.COMSPEC.trim() : 'cmd.exe'
  const decision = invocationFor(comspec, login, 'comspec')
  assertShellSupportsScript(input.script, decision, false)
  return decision
}

export interface ShellSpawnPlan {
  command: string
  args: string[]
  /**
   * True when the caller MUST pass `windowsVerbatimArguments: true` to
   * spawn(). cmd.exe has no backslash escape, so Node's default arg quoting
   * (which rewrites inner quotes as \") corrupts the script: e.g.
   * `node -e "process.exit(5)"` degrades to bare `node -e`, which exits 0 on
   * EOF stdin — a false pass. Flag arguments never contain spaces, so the
   * verbatim single-space join reproduces the intended command line exactly.
   */
  windowsVerbatimArguments: boolean
}

export function spawnPlanFor(decision: ResolvedShell, script: string): ShellSpawnPlan {
  return {
    command: decision.command,
    args: [...decision.args, script],
    windowsVerbatimArguments: decision.kind === 'windows',
  }
}
