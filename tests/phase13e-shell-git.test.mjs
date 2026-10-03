import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), 'termagent-13e-'))
const ctx = (cwd, abort = new AbortController()) => ({ sessionID: '13e-session', agent: 'build', cwd, abort: abort.signal })

async function loadBuiltin(root) {
  process.env.TERMAGENT_TASK_ROOT = path.join(root, 'tasks')
  const { builtinTools } = await import('../dist/tools/builtin.js')
  return builtinTools({ timeout: 120000, maxOutput: 2000 })
}

function getTool(tools, name) {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `missing ${name} tool`)
  return tool
}

async function waitForTask(manager, id, predicate, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const task = await manager.get(id)
    if (predicate(task)) return task
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for task ${id}`)
}

test('13E: foreground bash records durable output and completed termination', async () => {
  const root = await tmp()
  try {
    const tools = await loadBuiltin(root)
    const bash = getTool(tools, 'bash')
    const result = await bash.execute({ command: 'printf "shell-ok\\n"' }, ctx(root))
    assert.match(result.output, /shell-ok/)
    assert.equal(result.metadata.shell.status, 'completed')
    assert.equal(result.metadata.shell.background, false)
    const stored = await fs.readFile(result.metadata.shell.outputPath, 'utf8')
    assert.match(stored, /shell-ok/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13E: nonzero exits are distinguished from successful completion', async () => {
  const root = await tmp()
  try {
    const tools = await loadBuiltin(root)
    const bash = getTool(tools, 'bash')
    const result = await bash.execute({ command: 'exit 7' }, ctx(root))
    assert.equal(result.metadata.shell.status, 'nonzero')
    assert.equal(result.metadata.shell.exitCode, 7)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13E: timeout terminates a foreground process distinctly', async () => {
  const root = await tmp()
  try {
    const tools = await loadBuiltin(root)
    const bash = getTool(tools, 'bash')
    const result = await bash.execute({ command: 'sleep 1', timeout: 50 }, ctx(root))
    assert.equal(result.metadata.shell.status, 'timeout')
    assert.equal(result.metadata.shell.exitCode, 143)
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const task = await manager.get(result.metadata.shell.taskId)
    assert.equal(task.timeoutMs, 50)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13E: explicit background execution returns immediately and settles durably', async () => {
  const root = await tmp()
  try {
    const tools = await loadBuiltin(root)
    const bash = getTool(tools, 'bash')
    const started = Date.now()
    const result = await bash.execute({ command: 'sleep 0.08; printf "bg-ok\\n"', run_in_background: true }, ctx(root))
    assert.ok(Date.now() - started < 500)
    assert.equal(result.metadata.shell.background, true)
    const id = result.metadata.shell.taskId
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const done = await waitForTask(manager, id, (task) => task.status === 'exited' || task.status === 'failed')
    assert.equal(done.status, 'exited')
    assert.match(done.output, /bg-ok/)
    assert.ok(await fs.stat(done.outputPath))
    assert.ok((await manager.history(id)).some((event) => event.type === 'completed'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13E: long-running foreground bash auto-promotes after the configured budget', async () => {
  const root = await tmp()
  const previous = process.env.TERMAGENT_SHELL_AUTO_BACKGROUND_MS
  process.env.TERMAGENT_SHELL_AUTO_BACKGROUND_MS = '25'
  try {
    const tools = await loadBuiltin(root)
    const bash = getTool(tools, 'bash')
    const result = await bash.execute({ command: 'sleep 0.08; printf "promoted\\n"' }, ctx(root))
    assert.equal(result.metadata.shell.background, true)
    assert.match(result.output, /background/i)
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const done = await waitForTask(manager, result.metadata.shell.taskId, (task) => task.status === 'exited' || task.status === 'failed')
    assert.equal(done.status, 'exited')
    assert.match(done.output, /promoted/)
  } finally {
    if (previous === undefined) delete process.env.TERMAGENT_SHELL_AUTO_BACKGROUND_MS
    else process.env.TERMAGENT_SHELL_AUTO_BACKGROUND_MS = previous
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13E: abort cancels the shell and records cancelled termination', async () => {
  const root = await tmp()
  try {
    process.env.TERMAGENT_TASK_ROOT = path.join(root, 'tasks')
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const { startManagedShell } = await import('../dist/tasks/shell-command.js')
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const controller = new AbortController()
    const handle = await startManagedShell(manager, { shell: 'sh', command: 'sleep 10 & wait', cwd: root, timeout: 0, maxPreviewBytes: 1000, abort: controller.signal, detached: true })
    setTimeout(() => controller.abort(), 35)
    const result = await handle.result
    assert.equal(result.termination, 'cancelled')
    const task = await manager.get(handle.task.id)
    assert.equal(task.status, 'cancelled')
    assert.equal(task.termination, 'cancelled')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
test('13E: stderr-only commands remain visible in durable output', async () => {
  const root = await tmp()
  try {
    const tools = await loadBuiltin(root)
    const bash = getTool(tools, 'bash')
    const result = await bash.execute({ command: 'printf "stderr-only\\n" >&2' }, ctx(root))
    assert.equal(result.metadata.shell.status, 'completed')
    assert.match(result.output, /stderr-only/)
    assert.match(await fs.readFile(result.metadata.shell.outputPath, 'utf8'), /stderr-only/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13E: prompt-like output is flagged as likely interactive', async () => {
  const root = await tmp()
  try {
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const { startManagedShell } = await import('../dist/tasks/shell-command.js')
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const handle = await startManagedShell(manager, {
      shell: 'sh',
      command: "printf 'Continue? ' && sleep 5",
      cwd: root,
      timeout: 150,
      maxPreviewBytes: 1000,
      detached: true,
    })
    const result = await handle.result
    assert.equal(result.termination, 'timeout')
    assert.equal(result.interactiveLikely, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13E: cancellation removes the managed shell process', async () => {
  const root = await tmp()
  try {
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const { startManagedShell } = await import('../dist/tasks/shell-command.js')
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const controller = new AbortController()
    const handle = await startManagedShell(manager, {
      shell: 'sh',
      command: 'sleep 10 & wait',
      cwd: root,
      timeout: 0,
      maxPreviewBytes: 1000,
      abort: controller.signal,
      detached: true,
    })
    const taskId = handle.task.id
    setTimeout(() => controller.abort(), 35).unref?.()
    const result = await handle.result
    assert.equal(result.termination, 'cancelled')
    const task = await manager.get(taskId)
    assert.equal(task.status, 'cancelled')
    assert.equal(await new Promise(resolve => {
      try { process.kill(task.pid, 0); resolve(true) } catch { resolve(false) }
    }), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13E: git policy distinguishes safe, mutating, sensitive, and destructive arguments', async () => {
  const { analyzeGitArgs } = await import('../dist/tools/git-policy.js')
  assert.equal(analyzeGitArgs(['status']).risk, 'read-only')
  assert.equal(analyzeGitArgs(['commit', '-m', 'x']).risk, 'mutation')
  assert.equal(analyzeGitArgs(['config', 'user.name']).risk, 'sensitive')
  assert.equal(analyzeGitArgs(['push', '--force', 'origin', 'main']).risk, 'destructive')
  assert.equal(analyzeGitArgs(['reset', '--hard', 'HEAD']).destructive, true)
  assert.equal(analyzeGitArgs(['checkout', '--', 'src/a.ts']).affectedPaths[0], 'src/a.ts')
})

test('13E: git tool blocks destructive operations while allowing ordinary status', async () => {
  const root = await tmp()
  try {
    const tools = await loadBuiltin(root)
    const git = getTool(tools, 'git')
    await assert.rejects(() => git.execute({ args: ['reset', '--hard', 'HEAD'] }, ctx(root)), /destructive git/i)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
test('13E: excessive background output is terminated with an explicit output-limit state', async () => {
  const root = await tmp()
  try {
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const { startManagedShell } = await import('../dist/tasks/shell-command.js')
    const manager = new TaskManager(path.join(root, 'tasks'), false)
    const handle = await startManagedShell(manager, {
      shell: 'sh',
      command: "node -e \"process.stdout.write('x'.repeat(70000));setTimeout(()=>{},5000)\"", 
      cwd: root,
      timeout: 5000,
      maxPreviewBytes: 1000,
      outputLimitBytes: 65536,
      detached: true,
    })
    const result = await handle.result
    assert.equal(result.termination, 'output-limit')
    assert.ok(result.outputBytes > 65536)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13E: git arguments are shell-quoted so metacharacters remain literal', async () => {
  const root = await tmp()
  try {
    const tools = await loadBuiltin(root)
    const git = getTool(tools, 'git')
    const result = await git.execute({ args: ['status', '$(touch SHOULD_NOT_EXIST)'] }, ctx(root))
    assert.equal(result.metadata.git.operation, 'status')
    assert.equal(await fs.stat(path.join(root, 'SHOULD_NOT_EXIST')).then(() => true, () => false), false)
    assert.equal(result.metadata.git.status, 'nonzero')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
