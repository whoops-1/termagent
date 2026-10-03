import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

async function load(name) { return await import(`../dist/${name}.js`) }

test('client SDK exposes the public package subpath contract', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile('package.json','utf8'))
  assert.equal(pkg.exports['./client'].import, './dist/client/index.js')
  assert.equal(pkg.exports['./client'].types, './dist/client/index.d.ts')
  const mod = await import('../dist/client/index.js')
  assert.equal(typeof mod.TermAgentClient, 'function')
  assert.equal(typeof mod.TermAgentError, 'function')
})

test('external editor preserves Unicode edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-editor-'))
  const home = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-editor-home-'))
  const script = path.join(root,'editor.cjs')
  const old = { HOME:process.env.HOME, VISUAL:process.env.VISUAL, EDITOR:process.env.EDITOR }
  try {
    await writeFile(script, "const fs=require('fs'); const p=process.argv.at(-1); fs.appendFileSync(p,'\\nedited ✓');")
    process.env.HOME=home
    process.env.VISUAL=`node "${script}"`
    delete process.env.EDITOR
    const { editExternally } = await load('cli/external-editor')
    const result=await editExternally('draft ✓',root,'.txt')
    assert.match(result.text,/edited ✓/)
  } finally {
    for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k]; else process.env[k]=v}
    await rm(root,{recursive:true,force:true}); await rm(home,{recursive:true,force:true})
  }
})

test('repository source contains no external project names', async () => {
  const forbidden = [
    ['O','p','e','n','C','o','d','e'].join(''),
    ['O','p','e','n','C','l','a','u','d','e'].join(''),
    ['o','p','e','n','c','o','d','e'].join(''),
    ['o','p','e','n','c','l','a','u','d','e'].join(''),
  ]
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const result = await run('grep',['-RInE',forbidden.join('|'),'--exclude-dir=node_modules','--exclude-dir=dist','--exclude-dir=docs','--exclude=*.md','--exclude=*.zip','--exclude=TermAgent-1.2-UPDATED-ROADMAP.md','src','tests','package.json','tsconfig.json'],{cwd:process.cwd(),maxBuffer:4*1024*1024}).catch(e=>e)
  if(result.code===0) assert.fail(`forbidden name found:\n${result.stdout}`)
  assert.equal(result.code,1)
})

test('queue writes remain complete under separate-process contention', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-queue-'))
  const home = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-queue-home-'))
  const helper = path.join(root,'enqueue.mjs')
  const oldHome = process.env.HOME
  try {
    await writeFile(helper, `import { PromptQueueStore } from ${JSON.stringify(path.resolve('dist/cli/prompt-queue.js'))}; const s=new PromptQueueStore(process.argv[2]); await s.enqueue(process.argv[3]);`)
    const jobs=[]
    for(let i=0;i<20;i++) jobs.push(new Promise((resolve,reject)=>{
      const p=spawn(process.execPath,[helper,root,`item-${i}`],{env:{...process.env,HOME:home},stdio:['ignore','ignore','pipe']})
      let stderr=''; p.stderr.on('data',d=>stderr+=d); p.on('close',code=>code===0?resolve():reject(new Error(stderr||`exit ${code}`)))
    }))
    await Promise.all(jobs)
    process.env.HOME=home
    const { PromptQueueStore } = await load('cli/prompt-queue')
    const state=await new PromptQueueStore(root).list()
    assert.equal(state.queue.length,20)
    assert.equal(new Set(state.queue).size,20)
  } finally {
    if(oldHome===undefined) delete process.env.HOME; else process.env.HOME=oldHome
    await rm(root,{recursive:true,force:true}); await rm(home,{recursive:true,force:true})
  }
})

test('cancelled task state cannot be overwritten by a late worker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-cancel-'))
  try {
    const { TaskManager } = await load('tasks/manager')
    const manager = new TaskManager(root, false)
    const task = await manager.createShell('printf never-ran', root)
    const cancelled = await manager.cancel(task.id)
    assert.equal(cancelled.status, 'cancelled')
    const { runTaskWorker } = await load('tasks/worker')
    await runTaskWorker(task.id, manager)
    assert.equal((await manager.get(task.id)).status, 'cancelled')
    const finished = await manager.finish(task.id,{status:'exited',exitCode:0,output:'late result'})
    assert.equal(finished.status,'cancelled')
  } finally {
    await rm(root,{recursive:true,force:true})
  }
})

test('diff byte bounds stay valid with Unicode and color enabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-diff-limit-'))
  try {
    const { spawnSync } = await import('node:child_process')
    spawnSync('git',['init','-q'],{cwd:root})
    spawnSync('git',['config','user.email','test@example.invalid'],{cwd:root})
    spawnSync('git',['config','user.name','Test'],{cwd:root})
    await writeFile(path.join(root,'unicode.txt'),'αβγδεζηθ\n')
    spawnSync('git',['add','.'],{cwd:root}); spawnSync('git',['commit','-qm','init'],{cwd:root})
    await writeFile(path.join(root,'unicode.txt'),'αβγδεζηθ\n'.repeat(20))
    const { renderGitDiff } = await load('diff/render')
    const result=await renderGitDiff(root,{color:true,maxBytes:160})
    assert.ok(Buffer.byteLength(result.text,'utf8')<=160)
    assert.ok(!result.text.includes('\uFFFD'))
  } finally { await rm(root,{recursive:true,force:true}) }
})