import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {interpolateCommandTemplate} from '../dist/agent/interpolation.js'
import {SessionStore} from '../dist/session/store.js'

test('command interpolation injects arguments, shell output and file references', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'termagent-v09-'))
  await writeFile(path.join(dir,'src.txt'),'hello from file')
  const out=await interpolateCommandTemplate('args=$ARGUMENTS first=$1 shell=!`printf shell-ok` file=@src.txt',['one','two'],dir)
  assert.match(out,/args=one two/); assert.match(out,/first=one/); assert.match(out,/shell-ok/); assert.match(out,/hello from file/)
})

test('checkpoint can be listed and restored without mutating session history', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'termagent-cp-')); const store=new SessionStore(dir)
  const s=await store.create(dir,'mock/model'); const messages=[{role:'system',content:'s'},{role:'user',content:'one'},{role:'assistant',content:'two'}]
  for(const m of messages) await store.append(s.id,{type:'message',ts:Date.now(),data:m})
  const cp=await store.checkpoint(s.id,messages,{label:'before-edit'})
  await store.append(s.id,{type:'message',ts:Date.now(),data:{role:'user',content:'after'}})
  const cps=await store.listCheckpoints(s.id); assert.equal(cps.length,1)
  const restored=await store.restoreCheckpoint(s.id,cp.id); assert.equal(restored.messages.length,3); assert.equal(restored.messages.at(-1).content,'two')
})
