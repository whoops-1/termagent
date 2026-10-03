import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Agent } from '../dist/agent/agent.js'
import { SessionStore } from '../dist/session/store.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { builtinTools } from '../dist/tools/builtin.js'

class WriterProvider {
  constructor(content) { this.content = content; this.calls = 0 }
  async *stream() {
    this.calls++
    if (this.calls === 1) {
      yield { type:'tool_call', call:{ id:'write-1', type:'function', function:{ name:'write_file', arguments:JSON.stringify({path:'phase1.txt',content:this.content}) } } }
      yield { type:'done', finishReason:'tool_calls' }
    } else {
      yield { type:'text', delta:`wrote ${this.content}` }
      yield { type:'done', finishReason:'stop' }
    }
  }
}

function makeAgent(provider, store) {
  const registry = new ToolRegistry(new PermissionGate('auto'))
  builtinTools({ timeout:5000, maxOutput:5000 }).forEach(t => registry.add(t))
  return new Agent(provider, registry, store, 4)
}

test('phase 1 undo restores files and hides the reverted turn, redo restores both', async()=>{
  const root = await mkdtemp(path.join(tmpdir(),'termagent-phase1-'))
  const stateRoot = await mkdtemp(path.join(tmpdir(),'termagent-phase1-state-'))
  const store = new SessionStore(stateRoot)
  const session = await store.create(root,'mock')
  const messages = []

  const first = new WriterProvider('one')
  await makeAgent(first,store).run({sessionId:session.id,messages,cwd:root,instructions:'test',prompt:'write one'})
  assert.equal(await readFile(path.join(root,'phase1.txt'),'utf8'),'one')

  const undone = await store.undo(session.id,root)
  assert.equal(undone.messages.length,0)
  await assert.rejects(readFile(path.join(root,'phase1.txt'),'utf8'))

  const redone = await store.redo(session.id,root)
  assert.equal(redone.messages.length,4)
  assert.equal(await readFile(path.join(root,'phase1.txt'),'utf8'),'one')

  await rm(root,{recursive:true,force:true})
  await rm(stateRoot,{recursive:true,force:true})
})

test('phase 1 refuses undo when the working tree changed after the agent turn', async()=>{
  const root = await mkdtemp(path.join(tmpdir(),'termagent-phase1-drift-'))
  const stateRoot = await mkdtemp(path.join(tmpdir(),'termagent-phase1-state-'))
  const store = new SessionStore(stateRoot)
  const session = await store.create(root,'mock')
  const messages = []
  await makeAgent(new WriterProvider('agent'),store).run({sessionId:session.id,messages,cwd:root,instructions:'test',prompt:'write'})
  await writeFile(path.join(root,'phase1.txt'),'manual change')
  await assert.rejects(store.undo(session.id,root),/Working tree changed/)
  assert.equal(await readFile(path.join(root,'phase1.txt'),'utf8'),'manual change')
  await rm(root,{recursive:true,force:true})
  await rm(stateRoot,{recursive:true,force:true})
})

test('phase 1 starts a new branch after undo and clears redo history', async()=>{
  const root = await mkdtemp(path.join(tmpdir(),'termagent-phase1-branch-'))
  const stateRoot = await mkdtemp(path.join(tmpdir(),'termagent-phase1-state-'))
  const store = new SessionStore(stateRoot)
  const session = await store.create(root,'mock')
  const messages = []
  await makeAgent(new WriterProvider('one'),store).run({sessionId:session.id,messages,cwd:root,instructions:'test',prompt:'first'})
  await store.undo(session.id,root)
  await makeAgent(new WriterProvider('two'),store).run({sessionId:session.id,messages:[],cwd:root,instructions:'test',prompt:'second'})
  await assert.rejects(store.redo(session.id,root),/Nothing to redo/)
  assert.equal(await readFile(path.join(root,'phase1.txt'),'utf8'),'two')
  const loaded = await store.load(session.id)
  assert.equal(loaded.messages.filter(m=>m.role==='user').at(-1).content,'second')
  await rm(root,{recursive:true,force:true})
  await rm(stateRoot,{recursive:true,force:true})
})
