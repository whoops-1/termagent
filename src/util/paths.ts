import os from 'node:os'

/**
 * Resolve the user-level home directory across platforms.
 *
 * TermAgent historically assumed a POSIX `$HOME`. On Windows `$HOME` is usually
 * unset and the user profile lives in `USERPROFILE`, so every `HOME || cwd`
 * fallback silently redirected user-level state into the project directory.
 *
 * Precedence:
 *   1. `process.env.HOME` (POSIX; also honored by many Windows toolchains)
 *   2. `process.env.USERPROFILE` (Windows)
 *   3. `os.homedir()` (system fallback)
 *
 * Empty values fall through like the previous `||` chains did; callers keep
 * their own last-resort behavior after this resolver returns.
 */
export function resolveHomeDirectory(): string {
  const home = process.env.HOME
  if (typeof home === 'string' && home !== '') return home
  const userProfile = process.env.USERPROFILE
  if (typeof userProfile === 'string' && userProfile !== '') return userProfile
  return os.homedir()
}
