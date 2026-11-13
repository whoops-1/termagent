// 14I-B3 — centralized platform shell resolution (src/util/platform-shell.ts).
// Pure decision-matrix coverage: POSIX behavior byte-for-byte unchanged,
// win32 override → PATH discovery → COMSPEC fallback, and refusal to run
// sh-only scripts under a cmd-grammar shell. No process is ever spawned.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const { resolveShell, spawnPlanFor } = await import('../../dist/util/platform-shell.js')

const ALWAYS_TRUE = () => Promise.resolve(true)
const ALWAYS_FALSE = () => Promise.resolve(false)

test('14I-B3: POSIX keeps the historical $SHELL || sh with -lc exactly', async () => {
  const withShell = await resolveShell({ script: 'echo hi', env: { SHELL: '/bin/zsh' }, platform: 'linux', pathExists: ALWAYS_FALSE })
  assert.deepEqual({ command: withShell.command, args: withShell.args, kind: withShell.kind }, { command: '/bin/zsh', args: ['-lc'], kind: 'posix' })
  assert.equal(withShell.source, 'posix-shell-env')

  const withoutShell = await resolveShell({ script: 'echo hi', env: {}, platform: 'linux', pathExists: ALWAYS_FALSE })
  assert.deepEqual({ command: withoutShell.command, args: withoutShell.args, kind: withoutShell.kind }, { command: 'sh', args: ['-lc'], kind: 'posix' })
  assert.equal(withoutShell.source, 'posix-default-sh')
})

test('14I-B3: POSIX ignores TERMAGENT_SHELL to keep existing behavior stable', async () => {
  const decision = await resolveShell({ script: 'echo hi', env: { TERMAGENT_SHELL: 'C:\\tools\\sh.exe' }, platform: 'linux', pathExists: ALWAYS_FALSE })
  assert.equal(decision.command, 'sh')
  assert.equal(decision.kind, 'posix')
})

test('14I-B3: explicit caller shell owns the executable; flags follow its grammar family', async () => {
  const shFamily = await resolveShell({ script: 'echo hi', shell: 'bash', env: {}, platform: 'linux', pathExists: ALWAYS_FALSE })
  assert.deepEqual({ command: shFamily.command, args: shFamily.args, kind: shFamily.kind }, { command: 'bash', args: ['-lc'], kind: 'posix' })

  const cmd = await resolveShell({ script: 'echo hi', shell: 'cmd.exe', env: {}, platform: 'win32', pathExists: ALWAYS_FALSE })
  assert.deepEqual({ command: cmd.command, args: cmd.args, kind: cmd.kind }, { command: 'cmd.exe', args: ['/d', '/s', '/c'], kind: 'windows' })

  // login:false preserves the hook-runner's plain `-c` grammar.
  const noLogin = await resolveShell({ script: 'echo hi', shell: 'sh', login: false, env: {}, platform: 'linux', pathExists: ALWAYS_FALSE })
  assert.deepEqual(noLogin.args, ['-c'])
})

test('14I-B3: win32 TERMAGENT_SHELL override wins and sh-compatible overrides keep sh flags', async () => {
  const override = await resolveShell({
    script: 'echo hi', env: { TERMAGENT_SHELL: 'C:\\tools\\sh.exe', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    platform: 'win32', pathExists: ALWAYS_FALSE,
  })
  assert.equal(override.command, 'C:\\tools\\sh.exe')
  assert.deepEqual(override.args, ['-lc'])
  assert.equal(override.kind, 'posix')
  assert.equal(override.source, 'termagent-shell-override')
})

test('14I-B3: win32 cmd-grammar override refuses to mangle sh-only scripts', async () => {
  await assert.rejects(
    () => resolveShell({
      script: 'echo $HOME', env: { TERMAGENT_SHELL: 'cmd.exe', COMSPEC: 'cmd.exe' },
      platform: 'win32', pathExists: ALWAYS_FALSE,
    }),
    error => error instanceof Error
      && /No sh-compatible shell is available on Windows/.test(error.message)
      && /POSIX parameter\/variable expansion/.test(error.message)
      && /TERMAGENT_SHELL is currently set to a cmd-grammar shell/.test(error.message),
  )
})

test('14I-B3: win32 PATH discovery finds a sh-compatible shell and skips the system directory', async () => {
  const systemRoot = 'C:\\Windows'
  const found = await resolveShell({
    script: 'echo hi',
    env: { PATH: `${systemRoot}\\System32;C:\\tools`, SystemRoot: systemRoot },
    platform: 'win32',
    pathExists: candidate => Promise.resolve(candidate.startsWith('C:\\tools') || candidate.includes('System32')),
  })
  assert.equal(found.command, 'C:\\tools\\sh.exe', 'sh.exe is preferred inside its PATH entry')
  assert.equal(found.source, 'path-sh')
  assert.equal(found.kind, 'posix')
})

test('14I-B3: win32 without any sh-compatible shell falls back to COMSPEC for cmd-safe scripts', async () => {
  const plain = 'npm install -g @whoops-1/termagent'
  const decision = await resolveShell({
    script: plain, env: { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    platform: 'win32', pathExists: ALWAYS_FALSE,
  })
  assert.deepEqual({ command: decision.command, args: decision.args, kind: decision.kind }, { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c'], kind: 'windows' })
  assert.equal(decision.source, 'comspec')
})

test('14I-B3: win32 COMSPEC fallback refuses sh-only scripts with actionable remediation', async () => {
  await assert.rejects(
    () => resolveShell({
      script: 'export FOO=1 && echo $(date)', env: { PATH: '', COMSPEC: 'cmd.exe' },
      platform: 'win32', pathExists: ALWAYS_FALSE,
    }),
    error => error instanceof Error
      && /sh-only syntax/.test(error.message)
      && /Set TERMAGENT_SHELL to a sh-compatible executable/.test(error.message),
  )
})

test('14I-B3: every resolved decision is spawnable in the documented shape', async () => {
  for (const decision of [
    await resolveShell({ script: 'echo hi', env: {}, platform: 'linux', pathExists: ALWAYS_FALSE }),
    await resolveShell({ script: 'dir', env: { COMSPEC: 'cmd.exe' }, platform: 'win32', pathExists: ALWAYS_FALSE }),
  ]) {
    assert.equal(typeof decision.command, 'string')
    assert.ok(Array.isArray(decision.args))
    for (const arg of decision.args) assert.ok(arg.startsWith('-') || arg.startsWith('/'), `flag arguments only, got ${arg}`)
  }
})

test('14I-B3: spawnPlanFor appends the script and requires verbatim arguments only for cmd grammar', async () => {
  const windows = await resolveShell({ script: 'dir', env: { COMSPEC: 'cmd.exe' }, platform: 'win32', pathExists: ALWAYS_FALSE })
  assert.deepEqual(spawnPlanFor(windows, 'echo hi'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'echo hi'],
    windowsVerbatimArguments: true,
  })

  const posix = await resolveShell({ script: 'echo hi', env: { SHELL: '/bin/sh' }, platform: 'linux', pathExists: ALWAYS_FALSE })
  const posixPlan = spawnPlanFor(posix, 'echo hi')
  assert.equal(posixPlan.windowsVerbatimArguments, false, 'sh grammar is safe with Node default quoting')
  assert.deepEqual(posixPlan.args, ['-lc', 'echo hi'])
})

test('14I-B3: a quoted script reaches cmd.exe uncorrupted (false-pass regression)', { skip: process.platform !== 'win32' ? 'windows-only regression' : false }, async () => {
  const script = 'node -e "process.exit(5)"'
  const decision = await resolveShell({ script, env: { COMSPEC: 'cmd.exe' }, platform: 'win32', pathExists: ALWAYS_FALSE })
  const plan = spawnPlanFor(decision, script)
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { stdio: 'ignore', windowsVerbatimArguments: plan.windowsVerbatimArguments })
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
  assert.equal(exitCode, 5, 'cmd.exe must run the quoted script, not degrade it into a bare `node -e` that exits 0 on EOF stdin')
})
