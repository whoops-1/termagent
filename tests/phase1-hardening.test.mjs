import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, chmod, lstat, stat, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import { Agent } from '../dist/agent/agent.js'
import { SessionStore } from '../dist/session/store.js'
import { SnapshotStore } from '../dist/session/snapshot.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { builtinTools } from '../dist/tools/builtin.js'
import { startServer } from '../dist/server/http.js'

const execFileAsync = promisify(execFile)

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function makeRoots(prefix='termagent-hardening-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  const stateRoot = await mkdtemp(path.join(tmpdir(), `${prefix}state-`))
  return { root, stateRoot }
}

async function cleanupRoots({ root, stateRoot }) {
  await rm(root, { recursive: true, force: true })
  await rm(stateRoot, { recursive: true, force: true })
}

function makeAgent(provider, store) {
  const registry = new ToolRegistry(new PermissionGate('auto'))
  builtinTools({ timeout:5000, maxOutput:5000 }).forEach(tool => registry.add(tool))
  return new Agent(provider, registry, store, 4)
}

class WriterProvider {
  constructor(content, delayMs=0) { this.content = content; this.calls = 0; this.delayMs = delayMs }
  async *stream() {
    this.calls++
    if (this.calls === 1) {
      yield { type:'tool_call', call:{ id:`read-${this.calls}`, type:'function', function:{ name:'read_file', arguments:JSON.stringify({path:'phase1.txt'}) } } }
      yield { type:'done', finishReason:'tool_calls' }
    } else if (this.calls === 2) {
      yield { type:'tool_call', call:{ id:`write-${this.calls}`, type:'function', function:{ name:'write_file', arguments:JSON.stringify({path:'phase1.txt',content:this.content}) } } }
      yield { type:'done', finishReason:'tool_calls' }
    } else {
      if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs))
      yield { type:'text', delta:`wrote ${this.content}` }
      yield { type:'done', finishReason:'stop' }
    }
  }
}

class PartialFailureProvider {
  constructor() { this.calls = 0 }
  async *stream() {
    this.calls++
    if (this.calls === 1) {
      yield { type:'tool_call', call:{ id:'write-partial', type:'function', function:{ name:'write_file', arguments:JSON.stringify({path:'partial.txt',content:'partial'}) } } }
      yield { type:'done', finishReason:'tool_calls' }
      return
    }
    throw new Error('synthetic provider crash')
  }
}

class NoopProvider {
  async *stream() {
    yield { type:'text', delta:'done' }
    yield { type:'done', finishReason:'stop' }
  }
}

test('hardening: multi-turn undo/redo survives SessionStore recreation', async () => {
  const paths = await makeRoots()
  try {
    let store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root, 'mock')
    const messages = []
    await makeAgent(new WriterProvider('one'), store).run({sessionId:session.id, messages, cwd:paths.root, instructions:'test', prompt:'one'})
    await makeAgent(new WriterProvider('two'), store).run({sessionId:session.id, messages, cwd:paths.root, instructions:'test', prompt:'two'})
    assert.equal(await readFile(path.join(paths.root,'phase1.txt'),'utf8'),'two')

    store = new SessionStore(paths.stateRoot)
    const u2 = await store.undo(session.id, paths.root)
    assert.equal(u2.messages.filter(m => m.role==='user').at(-1).content, 'one')
    assert.equal(await readFile(path.join(paths.root,'phase1.txt'),'utf8'),'one')

    const u1 = await store.undo(session.id, paths.root)
    assert.equal(u1.messages.length, 0)
    await assert.rejects(readFile(path.join(paths.root,'phase1.txt'),'utf8'))

    const r1 = await store.redo(session.id, paths.root)
    assert.equal(r1.messages.filter(m => m.role==='user').at(-1).content, 'one')
    assert.equal(await readFile(path.join(paths.root,'phase1.txt'),'utf8'),'one')
    const r2 = await store.redo(session.id, paths.root)
    assert.equal(r2.messages.filter(m => m.role==='user').at(-1).content, 'two')
    assert.equal(await readFile(path.join(paths.root,'phase1.txt'),'utf8'),'two')
  } finally { await cleanupRoots(paths) }
})

test('hardening: failed provider turn still captures filesystem changes and can be undone', async () => {
  const paths = await makeRoots('termagent-failure-')
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root, 'mock')
    const messages = []
    await assert.rejects(
      makeAgent(new PartialFailureProvider(), store).run({sessionId:session.id, messages, cwd:paths.root, instructions:'test', prompt:'crash after write'}),
      /synthetic provider crash/
    )
    assert.equal(await readFile(path.join(paths.root,'partial.txt'),'utf8'),'partial')
    const result = await store.undo(session.id, paths.root)
    assert.equal(result.messages.length, 0)
    await assert.rejects(readFile(path.join(paths.root,'partial.txt'),'utf8'))
    await store.redo(session.id, paths.root)
    assert.equal(await readFile(path.join(paths.root,'partial.txt'),'utf8'),'partial')
  } finally { await cleanupRoots(paths) }
})

test('hardening: concurrent agent turns on one session are rejected instead of interleaving', async () => {
  const paths = await makeRoots('termagent-busy-')
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root, 'mock')
    const firstMessages = []
    const secondMessages = []
    const first = makeAgent(new WriterProvider('first', 120), store).run({sessionId:session.id, messages:firstMessages, cwd:paths.root, instructions:'test', prompt:'first'})
    await new Promise(r => setTimeout(r, 10))
    await assert.rejects(
      makeAgent(new WriterProvider('second'), store).run({sessionId:session.id, messages:secondMessages, cwd:paths.root, instructions:'test', prompt:'second'}),
      /Session is busy/
    )
    await first
    assert.equal(await readFile(path.join(paths.root,'phase1.txt'),'utf8'),'first')
    const loaded = await store.load(session.id)
    assert.equal(loaded.messages.filter(m => m.role==='user').length, 1)
    assert.equal(loaded.messages.find(m => m.role==='user')?.content, 'first')
  } finally { await cleanupRoots(paths) }
})

test('hardening: concurrent undo requests serialize and exactly one wins', async () => {
  const paths = await makeRoots('termagent-undo-race-')
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root, 'mock')
    const messages = []
    await makeAgent(new WriterProvider('race'), store).run({sessionId:session.id, messages, cwd:paths.root, instructions:'test', prompt:'race'})
    const results = await Promise.allSettled([
      store.undo(session.id, paths.root),
      store.undo(session.id, paths.root),
    ])
    assert.equal(results.filter(x => x.status==='fulfilled').length, 1)
    assert.equal(results.filter(x => x.status==='rejected').length, 1)
    assert.match(results.find(x => x.status==='rejected').reason.message, /Nothing to undo|Session is busy/)
    await assert.rejects(readFile(path.join(paths.root,'phase1.txt'),'utf8'))
  } finally { await cleanupRoots(paths) }
})

test('hardening: snapshot preserves binary data, symlinks, executable mode, and Git index isolation', async () => {
  const paths = await makeRoots('termagent-files-')
  try {
    await git(paths.root, ['init', '-q'])
    await writeFile(path.join(paths.root,'tracked.txt'),'staged')
    await git(paths.root, ['add','tracked.txt'])
    const beforeIndex = await git(paths.root, ['diff','--cached','--name-status'])

    await writeFile(path.join(paths.root,'binary.bin'), Buffer.from([0,1,2,3,255,0,17]))
    await mkdir(path.join(paths.root,'payload'))
    await writeFile(path.join(paths.root,'payload','run.sh'),'#!/bin/sh\necho hi\n')
    await chmod(path.join(paths.root,'payload','run.sh'),0o755)
    await symlink('../binary.bin', path.join(paths.root,'payload','link.bin'))

    const store = new SnapshotStore({root:paths.root, storeRoot:path.join(paths.stateRoot,'snapshots')})
    const snap = await store.create('files')

    await writeFile(path.join(paths.root,'binary.bin'), Buffer.from([9,9,9]))
    await rm(path.join(paths.root,'payload','link.bin'))
    await chmod(path.join(paths.root,'payload','run.sh'),0o644)
    await writeFile(path.join(paths.root,'extra.txt'),'extra')
    await store.restore(snap)

    assert.deepEqual([...await readFile(path.join(paths.root,'binary.bin'))], [0,1,2,3,255,0,17])
    assert.equal((await lstat(path.join(paths.root,'payload','link.bin'))).isSymbolicLink(), true)
    assert.equal(await readlink(path.join(paths.root,'payload','link.bin')), '../binary.bin')
    assert.equal((await stat(path.join(paths.root,'payload','run.sh'))).mode & 0o777, 0o755)
    await assert.rejects(stat(path.join(paths.root,'extra.txt')))

    const afterIndex = await git(paths.root, ['diff','--cached','--name-status'])
    assert.equal(afterIndex, beforeIndex)
  } finally { await cleanupRoots(paths) }
})
test('hardening: snapshot creation succeeds when fixed ignored directories exist', async () => {
  const paths = await makeRoots('termagent-snapshot-ignored-dirs-')
  try {
    const store = new SnapshotStore({root:paths.root, storeRoot:path.join(paths.stateRoot,'snapshots')})
    await writeFile(path.join(paths.root,'.gitignore'),'dist/\n.termagent/\n')
    await mkdir(path.join(paths.root,'dist'))
    await mkdir(path.join(paths.root,'.termagent'))
    await writeFile(path.join(paths.root,'dist','bundle.js'),'generated')
    await writeFile(path.join(paths.root,'.termagent','state'),'internal')
    await writeFile(path.join(paths.root,'source.txt'),'source')

    const snapshot = await store.create('ignored-dirs')
    assert.match(snapshot, /^[0-9a-f]{40}$/)
    assert.equal(await store.exists(snapshot), true)

    await writeFile(path.join(paths.root,'source.txt'),'changed')
    await writeFile(path.join(paths.root,'new.txt'),'remove')
    await store.restore(snapshot)

    assert.equal(await readFile(path.join(paths.root,'source.txt'),'utf8'),'source')
    assert.equal(await readFile(path.join(paths.root,'dist','bundle.js'),'utf8'),'generated')
    assert.equal(await readFile(path.join(paths.root,'.termagent','state'),'utf8'),'internal')
    await assert.rejects(stat(path.join(paths.root,'new.txt')))
  } finally { await cleanupRoots(paths) }
})

test('hardening: restore never deletes existing gitignored user files', async () => {
  const paths = await makeRoots('termagent-ignore-preserve-')
  try {
    const store = new SnapshotStore({root:paths.root, storeRoot:path.join(paths.stateRoot,'snapshots')})
    await writeFile(path.join(paths.root,'.gitignore'),'secret.txt\n')
    await writeFile(path.join(paths.root,'secret.txt'),'KEEP-ME')
    const snap = await store.create('ignored-preserve')
    await writeFile(path.join(paths.root,'regular.txt'),'remove-me')
    await store.restore(snap)
    assert.equal(await readFile(path.join(paths.root,'secret.txt'),'utf8'),'KEEP-ME')
    await assert.rejects(stat(path.join(paths.root,'regular.txt')))
  } finally { await cleanupRoots(paths) }
})
test('hardening: HTTP undo/redo endpoints restore the transactional turn', async () => {
  const paths = await makeRoots('termagent-http-undo-')
  let server
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root,'mock')
    const messages = []
    const turn = await store.beginTurn(session.id,paths.root,messages,'http-turn')
    await writeFile(path.join(paths.root,'http.txt'),'api-state')
    const message={role:'user',content:'http-turn'}
    messages.push(message)
    await store.appendMessage(session.id,message,turn.id)
    await store.commitTurn(session.id,paths.root,turn,messages)

    const runtime={
      cwd:paths.root, store,
      getProvider:()=>({id:'mock',model:'mock'}), customAgents:[],
      tasks:{list:async()=>[],get:async()=>null,history:async()=>[],cancel:async()=>({})},
      mcp:{clients:[]}, runPrompt:async()=>''
    }
    server=await startServer(runtime,{host:'127.0.0.1',port:0})
    const port=server.address().port
    const base=`http://127.0.0.1:${port}/api/v1/sessions/${encodeURIComponent(session.id)}`

    const undo=await fetch(`${base}/undo`,{method:'POST'})
    assert.equal(undo.status,200)
    const undoBody=await undo.json()
    assert.equal(undoBody.messages.length,0)
    await assert.rejects(readFile(path.join(paths.root,'http.txt'),'utf8'))

    const redo=await fetch(`${base}/redo`,{method:'POST'})
    assert.equal(redo.status,200)
    const redoBody=await redo.json()
    assert.equal(redoBody.messages.filter(m=>m.role==='user').length,1)
    assert.equal(await readFile(path.join(paths.root,'http.txt'),'utf8'),'api-state')
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve))
    await cleanupRoots(paths)
  }
})

test('hardening: invalid snapshot ids never reach Git', async () => {
  const paths = await makeRoots('termagent-invalid-snapshot-')
  try {
    const store = new SnapshotStore({root:paths.root, storeRoot:path.join(paths.stateRoot,'snapshots')})
    await assert.rejects(store.restore('--reset'), /Invalid snapshot id/)
    assert.equal(await store.exists('../not-a-snapshot'), false)
  } finally { await cleanupRoots(paths) }
})
test('hardening: separate processes serialize first snapshot initialization', async () => {
  const paths = await makeRoots('termagent-crossproc-snapshot-')
  const script = path.join(path.dirname(paths.stateRoot), 'termagent-crossproc-snapshot-child.mjs')
  const snapshotRoot = path.join(path.dirname(paths.stateRoot), 'snapshots', 'shared')
  try {
    await writeFile(path.join(paths.root,'seed.txt'),'seed')
    await writeFile(script, `import { SnapshotStore } from ${JSON.stringify(path.resolve('dist/session/snapshot.js'))}; const s=new SnapshotStore({root:process.argv[2],storeRoot:process.argv[3]}); console.log(await s.create('cross-process'));`)
    const run = () => new Promise(resolve => {
      const child = spawn(process.execPath, [script, paths.root, snapshotRoot], {stdio:['ignore','pipe','pipe']})
      let out='', err=''
      child.stdout.on('data', b => out += b)
      child.stderr.on('data', b => err += b)
      child.on('close', code => resolve({code,out:out.trim(),err:err.trim()}))
    })
    const results = await Promise.all(Array.from({length:40}, run))
    assert.ok(results.every(x => x.code === 0), JSON.stringify(results))
    const ids = results.map(x=>x.out).filter(Boolean)
    assert.equal(ids.length,40)
    assert.ok(ids.every(x=>/^[0-9a-f]{40}$/.test(x)))
    const store = new SnapshotStore({root:paths.root,storeRoot:snapshotRoot})
    assert.equal(await store.exists(ids[0]),true)
  } finally { await cleanupRoots(paths); await rm(script,{force:true}) }
})

test('hardening: separate processes cannot run the same session turn concurrently', async () => {
  const paths = await makeRoots('termagent-crossproc-session-')
  const script = path.join(path.dirname(paths.stateRoot), 'termagent-crossproc-session-child.mjs')
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root,'mock')
    await writeFile(script, `import { SessionStore } from ${JSON.stringify(path.resolve('dist/session/store.js'))}; const s=new SessionStore(process.argv[2]); try { const t=await s.beginTurn(process.argv[3],process.argv[4],[],'cross'); console.log('BEGIN',t.id); await new Promise(r=>setTimeout(r,300)); await s.commitTurn(process.argv[3],process.argv[4],t,[]); console.log('COMMIT',t.id); } catch(e){ console.error('ERR',e.message); process.exitCode=2 }`)
    const run = () => new Promise(resolve => {
      const child = spawn(process.execPath,[script,paths.stateRoot,session.id,paths.root],{stdio:['ignore','pipe','pipe']})
      let out='',err=''; child.stdout.on('data',b=>out+=b); child.stderr.on('data',b=>err+=b); child.on('close',code=>resolve({code,out,err}))
    })
    const first = run()
    await new Promise(r=>setTimeout(r,50))
    const contenders = [first, ...Array.from({length:7}, () => run())]
    const results = await Promise.all(contenders)
    assert.equal(results.filter(x=>x.code===0).length,1)
    assert.equal(results.filter(x=>x.code===2).length,7)
    assert.ok(results.filter(x=>x.code===2).every(x=>/Session is busy/.test(x.err)))
    assert.equal((await store.load(session.id)).events.filter(e=>e.type==='turn').filter(e=>e.data?.status==='committed').length,1)
  } finally { await cleanupRoots(paths); await rm(script,{force:true}) }
})

test('hardening: a dead turn owner is recoverable after process termination', async () => {
  const paths = await makeRoots('termagent-crossproc-recover-')
  const script = path.join(path.dirname(paths.stateRoot), 'termagent-crossproc-recover-child.mjs')
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root,'mock')
    await writeFile(script, `import { SessionStore } from ${JSON.stringify(path.resolve('dist/session/store.js'))}; const s=new SessionStore(process.argv[2]); const t=await s.beginTurn(process.argv[3],process.argv[4],[],'die'); console.log(t.id); setInterval(()=>{},1000);`)
    const child=spawn(process.execPath,[script,paths.stateRoot,session.id,paths.root],{stdio:['ignore','pipe','pipe']})
    await new Promise((resolve,reject)=>{let done=false; const onData=b=>{if(String(b).trim()){done=true;resolve()}}; child.stdout.on('data',onData); child.on('error',reject); setTimeout(()=>{if(!done) reject(new Error('child did not acquire turn'))},5000)})
    child.kill('SIGKILL')
    await new Promise(resolve=>child.on('close',resolve))
    const next = await store.beginTurn(session.id,paths.root,[],'recover')
    await store.commitTurn(session.id,paths.root,next,[])
    assert.equal((await store.load(session.id)).events.filter(e=>e.type==='turn'&&e.data?.status==='committed').length,1)
  } finally { await cleanupRoots(paths); await rm(script,{force:true}) }
})

test('hardening: manual edits to a newly ignored pre-existing file are detected and never clobbered', async () => {
  const paths = await makeRoots('termagent-ignore-drift-')
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root, 'mock')
    const messages = []
    await writeFile(path.join(paths.root,'secret.txt'),'original')
    const turn = await store.beginTurn(session.id, paths.root, messages, 'turn')
    await writeFile(path.join(paths.root,'.gitignore'),'secret.txt\n')
    await writeFile(path.join(paths.root,'secret.txt'),'agent-change')
    const user = {role:'user',content:'turn'}
    messages.push(user)
    await store.appendMessage(session.id,user,turn.id)
    await store.commitTurn(session.id, paths.root, turn, messages)

    await writeFile(path.join(paths.root,'secret.txt'),'MANUAL-CHANGE')
    await assert.rejects(store.undo(session.id, paths.root), /Working tree changed/)
    assert.equal(await readFile(path.join(paths.root,'secret.txt'),'utf8'),'MANUAL-CHANGE')
  } finally { await cleanupRoots(paths) }
})

test('hardening: multiple SnapshotStore instances sharing one store root initialize safely', async () => {
  const paths = await makeRoots('termagent-snapshot-multi-')
  try {
    const a = new SnapshotStore({root:paths.root, storeRoot:path.join(paths.stateRoot,'snapshots')})
    const b = new SnapshotStore({root:paths.root, storeRoot:path.join(paths.stateRoot,'snapshots')})
    await writeFile(path.join(paths.root,'seed.txt'),'seed')
    const ids = await Promise.all(Array.from({length:30}, (_,i) => (i % 2 ? a : b).create(`parallel-${i}`)))
    assert.equal(ids.length,30)
    assert.ok(ids.every(id => /^[0-9a-f]{40}$/.test(id)))
    assert.equal(await a.exists(ids[0]),true)
  } finally { await cleanupRoots(paths) }
})

test('hardening: wrong working directory is rejected before undo can mutate anything', async () => {
  const paths = await makeRoots('termagent-cwd-')
  const other = await mkdtemp(path.join(tmpdir(),'termagent-other-'))
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root, 'mock')
    const messages = []
    await makeAgent(new WriterProvider('safe'), store).run({sessionId:session.id, messages, cwd:paths.root, instructions:'test', prompt:'write'})
    await assert.rejects(store.undo(session.id, other), /belongs to/)
    assert.equal(await readFile(path.join(paths.root,'phase1.txt'),'utf8'),'safe')
  } finally { await cleanupRoots(paths); await rm(other,{recursive:true,force:true}) }
})

test('hardening: a second SessionStore instance cannot start a concurrent turn for the same session', async () => {
  const paths = await makeRoots('termagent-cross-store-')
  try {
    const firstStore = new SessionStore(paths.stateRoot)
    const secondStore = new SessionStore(paths.stateRoot)
    const session = await firstStore.create(paths.root, 'mock')
    const firstMessages = []
    const secondMessages = []
    const first = makeAgent(new WriterProvider('first', 100), firstStore).run({sessionId:session.id, messages:firstMessages, cwd:paths.root, instructions:'test', prompt:'first'})
    await new Promise(r => setTimeout(r, 10))
    await assert.rejects(makeAgent(new WriterProvider('second'), secondStore).run({sessionId:session.id, messages:secondMessages, cwd:paths.root, instructions:'test', prompt:'second'}), /Session is busy/)
    await first
  } finally { await cleanupRoots(paths) }
})
test('hardening: restore refuses an ignored file that blocks a snapshot directory before mutating anything', async () => {
  const paths = await makeRoots('termagent-ignore-conflict-')
  try {
    const store = new SnapshotStore({root:paths.root, storeRoot:path.join(paths.stateRoot,'snapshots')})
    await mkdir(path.join(paths.root,'dir'))
    await writeFile(path.join(paths.root,'dir','file.txt'),'snapshot')
    const snap = await store.create('conflict')

    await rm(path.join(paths.root,'dir'),{recursive:true,force:true})
    await writeFile(path.join(paths.root,'.gitignore'),'dir\n')
    await writeFile(path.join(paths.root,'dir'),'user-data')
    await writeFile(path.join(paths.root,'untouched.txt'),'keep')

    await assert.rejects(store.restore(snap), /ignored path.*blocks snapshot path/)
    assert.equal(await readFile(path.join(paths.root,'dir'),'utf8'),'user-data')
    assert.equal(await readFile(path.join(paths.root,'untouched.txt'),'utf8'),'keep')
  } finally { await cleanupRoots(paths) }
})

test('hardening: a truncated final session-log line is ignored, but corruption in the middle is fatal', async () => {
  const paths = await makeRoots('termagent-log-recovery-')
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root,'mock')
    await store.appendMessage(session.id,{role:'user',content:'one'})
    const file = store.file(session.id)
    const original = await readFile(file,'utf8')
    await writeFile(file, original + '{"type":"message"', 'utf8')
    const recovered = await store.load(session.id)
    assert.equal(recovered.messages.length,1)

    await writeFile(file, original.split('\n')[0] + '\n{not-json\n' + original, 'utf8')
    await assert.rejects(store.load(session.id), /Corrupt session log at line/)
  } finally { await cleanupRoots(paths) }
})

test('hardening: 12 consecutive undo/redo cycles return to the exact final state', async () => {
  const paths = await makeRoots('termagent-cycles-')
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root, 'mock')
    const messages = []
    for (let i=0;i<12;i++) {
      await makeAgent(new WriterProvider(`value-${i}`), store).run({sessionId:session.id, messages, cwd:paths.root, instructions:'test', prompt:`turn-${i}`})
      assert.equal(await readFile(path.join(paths.root,'phase1.txt'),'utf8'),`value-${i}`)
    }
    for (let i=0;i<12;i++) await store.undo(session.id, paths.root)
    await assert.rejects(readFile(path.join(paths.root,'phase1.txt'),'utf8'))
    for (let i=0;i<12;i++) await store.redo(session.id, paths.root)
    assert.equal(await readFile(path.join(paths.root,'phase1.txt'),'utf8'),'value-11')
    const loaded = await store.load(session.id)
    assert.equal(loaded.messages.filter(m => m.role==='user').length,12)
  } finally { await cleanupRoots(paths) }
})

test('hardening: anchored snapshots survive aggressive Git garbage collection', async () => {
  const paths = await makeRoots('termagent-gc-')
  try {
    const store = new SnapshotStore({root:paths.root,storeRoot:path.join(paths.stateRoot,'snapshots')})
    await writeFile(path.join(paths.root,'gc.txt'),'survive')
    const snap = await store.create('gc-recorded')
    await writeFile(path.join(paths.root,'gc.txt'),'changed')
    await git(paths.root, ['--git-dir', path.join(paths.stateRoot,'snapshots','git'), 'gc', '--prune=now'])
    assert.equal(await store.exists(snap), true)
    await store.restore(snap)
    assert.equal(await readFile(path.join(paths.root,'gc.txt'),'utf8'),'survive')

    await store.cleanup(new Set())
    assert.equal(await store.exists(snap), false)
    await assert.rejects(async()=>store.restore(snap), /Snapshot not found/)
  } finally { await cleanupRoots(paths) }
})

test('hardening: file/directory type changes are restored in both directions', async () => {
  const paths = await makeRoots('termagent-typeflip-')
  try {
    const store = new SnapshotStore({root:paths.root,storeRoot:path.join(paths.stateRoot,'snapshots')})
    await writeFile(path.join(paths.root,'thing'),'file')
    const fileSnap = await store.create('file')
    await rm(path.join(paths.root,'thing'))
    await mkdir(path.join(paths.root,'thing'))
    await writeFile(path.join(paths.root,'thing','nested'),'dir')
    await store.restore(fileSnap)
    assert.equal((await stat(path.join(paths.root,'thing'))).isFile(), true)
    assert.equal(await readFile(path.join(paths.root,'thing'),'utf8'),'file')

    await rm(path.join(paths.root,'thing'))
    await mkdir(path.join(paths.root,'thing'))
    await writeFile(path.join(paths.root,'thing','nested'),'dir')
    const dirSnap = await store.create('dir')
    await rm(path.join(paths.root,'thing'),{recursive:true,force:true})
    await writeFile(path.join(paths.root,'thing'),'file-again')
    await store.restore(dirSnap)
    assert.equal((await stat(path.join(paths.root,'thing'))).isDirectory(), true)
    assert.equal(await readFile(path.join(paths.root,'thing','nested'),'utf8'),'dir')
    await assert.rejects(readFile(path.join(paths.root,'thing'),'utf8'))
  } finally { await cleanupRoots(paths) }
})

test('hardening: NUL-safe snapshot parsing handles newline and unicode filenames', async () => {
  const paths = await makeRoots('termagent-paths-')
  try {
    const store = new SnapshotStore({root:paths.root,storeRoot:path.join(paths.stateRoot,'snapshots')})
    const weird = 'line\nbreak-☃.txt'
    await writeFile(path.join(paths.root,weird),'payload')
    const snap = await store.create('paths')
    await rm(path.join(paths.root,weird))
    await store.restore(snap)
    assert.equal(await readFile(path.join(paths.root,weird),'utf8'),'payload')
  } finally { await cleanupRoots(paths) }
})

test('hardening: branching prunes unreachable redo snapshots but keeps active history', async () => {
  const paths = await makeRoots('termagent-branch-gc-')
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root,'mock')
    const messages = []
    await makeAgent(new WriterProvider('one'), store).run({sessionId:session.id,messages,cwd:paths.root,instructions:'test',prompt:'one'})
    await makeAgent(new WriterProvider('two'), store).run({sessionId:session.id,messages,cwd:paths.root,instructions:'test',prompt:'two'})
    const loaded = await store.load(session.id)
    const turns = loaded.events.filter(e=>e.type==='turn'&&e.data?.status==='committed').map(e=>e.data)
    const second = turns.at(-1)
    await store.undo(session.id,paths.root)
    assert.ok(await git(paths.root,['--git-dir',path.join(path.dirname(paths.stateRoot),'snapshots',session.id,'git'),'show-ref']))
    await makeAgent(new WriterProvider('three'), store).run({sessionId:session.id,messages:await store.load(session.id).then(x=>x.messages),cwd:paths.root,instructions:'test',prompt:'three'})
    const snapRepo = path.join(path.dirname(paths.stateRoot),'snapshots',session.id,'git')
    const refs = await git(paths.root,['--git-dir',snapRepo,'for-each-ref','--format=%(refname)','refs/termagent/snapshots'])
    assert.doesNotMatch(refs, new RegExp(second.afterSnapshot))
    const now = await store.load(session.id)
    const committedTurns = now.events.filter(e=>e.type==='turn'&&e.data?.status==='committed').map(e=>e.data)
    const activeTurns = [committedTurns[0], committedTurns.at(-1)]
    for (const turn of activeTurns) {
      assert.match(refs, new RegExp(turn.beforeSnapshot))
      assert.match(refs, new RegExp(turn.afterSnapshot))
      assert.match(refs, new RegExp(turn.afterProtectedSnapshot))
    }
  } finally { await cleanupRoots(paths) }
})
test('hardening: empty directory cannot block a file restore', async () => {
  const paths = await makeRoots('termagent-empty-dir-file-')
  try {
    const store = new SnapshotStore({root:paths.root, storeRoot:path.join(paths.stateRoot,'snapshots')})
    await writeFile(path.join(paths.root,'swap.txt'),'file-state')
    const snap = await store.create('file-state')
    await rm(path.join(paths.root,'swap.txt'))
    await mkdir(path.join(paths.root,'swap.txt'))
    await store.restore(snap)
    assert.equal(await readFile(path.join(paths.root,'swap.txt'),'utf8'),'file-state')
  } finally { await cleanupRoots(paths) }
})

test('hardening: ignored directory is preserved when snapshot needs children inside it', async () => {
  const paths = await makeRoots('termagent-ignored-dir-parent-')
  try {
    const store = new SnapshotStore({root:paths.root, storeRoot:path.join(paths.stateRoot,'snapshots')})
    await mkdir(path.join(paths.root,'cache'))
    await writeFile(path.join(paths.root,'.gitignore'),'cache/\n')
    await writeFile(path.join(paths.root,'.gitignore'),'cache/keep.txt\n')
    await writeFile(path.join(paths.root,'cache','keep.txt'),'user-data')
    await mkdir(path.join(paths.root,'src'))
    await writeFile(path.join(paths.root,'src','app.txt'),'app')
    // The snapshot contains cache/required.txt, while cache/keep.txt is
    // already user-ignored and therefore not part of the snapshot.
    await writeFile(path.join(paths.root,'cache','required.txt'),'required')
    const snap = await store.create('with-cache-child')
    await writeFile(path.join(paths.root,'.gitignore'),'cache/\n')
    await rm(path.join(paths.root,'cache','required.txt'))
    await writeFile(path.join(paths.root,'cache','keep.txt'),'user-change')
    await store.restore(snap)
    assert.equal(await readFile(path.join(paths.root,'cache','required.txt'),'utf8'),'required')
    assert.equal(await readFile(path.join(paths.root,'cache','keep.txt'),'utf8'),'user-change')
  } finally { await cleanupRoots(paths) }
})

test('hardening: Git maintenance failure never turns snapshot cleanup into a functional failure', async () => {
  const paths = await makeRoots('termagent-gc-failure-')
  const wrapper = path.join(paths.stateRoot, 'git-wrapper.sh')
  try {
    const storeRoot = path.join(paths.stateRoot,'snapshots')
    const store = new SnapshotStore({root:paths.root, storeRoot})
    await writeFile(path.join(paths.root,'maintenance.txt'),'state')
    const snap = await store.create('maintenance')
    const realGit = (await execFileAsync('sh',['-lc','command -v git'])).stdout.trim()
    await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "gc" ]; then echo synthetic-gc-failure >&2; exit 17; fi\nexec ${JSON.stringify(realGit)} "$@"\n`)
    await chmod(wrapper, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${paths.stateRoot}:${previousPath || ''}`
    try {
      await store.cleanup(new Set([snap]))
    } finally {
      process.env.PATH = previousPath
    }
    assert.equal(await store.exists(snap), true)
  } finally { await cleanupRoots(paths) }
})

test('hardening: HTTP undo/redo reports session contention as a conflict', async () => {
  const paths = await makeRoots('termagent-http-busy-')
  let server
  try {
    const store = new SessionStore(paths.stateRoot)
    const session = await store.create(paths.root,'mock')
    const turn = await store.beginTurn(session.id, paths.root, [], 'busy')
    const runtime={
      cwd:paths.root, store,
      getProvider:()=>({id:'mock',model:'mock'}), customAgents:[],
      tasks:{list:async()=>[],get:async()=>null,history:async()=>[],cancel:async()=>({})},
      mcp:{clients:[]}, runPrompt:async()=>''
    }
    server=await startServer(runtime,{host:'127.0.0.1',port:0})
    const port=server.address().port
    const base=`http://127.0.0.1:${port}/api/v1/sessions/${encodeURIComponent(session.id)}`
    const [undo,redo] = await Promise.all([
      fetch(`${base}/undo`,{method:'POST'}),
      fetch(`${base}/redo`,{method:'POST'})
    ])
    assert.equal(undo.status,409)
    assert.equal(redo.status,409)
    assert.match(await undo.text(),/Session is busy/)
    assert.match(await redo.text(),/Session is busy/)
    await store.commitTurn(session.id,paths.root,turn,[])
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve))
    await cleanupRoots(paths)
  }
})
