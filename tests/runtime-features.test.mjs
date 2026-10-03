import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { TaskManager } from '../dist/tasks/manager.js'
import { backgroundTool } from '../dist/tools/background.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { ToolRegistry } from '../dist/tools/registry.js'

test('background task starts and persists exit state', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'termagent-task-'))
  class TestTaskManager extends TaskManager { spawnWorker(_id){ return 0 } }
  const manager=new TestTaskManager(path.join(dir,'tasks'), false);const reg=new ToolRegistry(new PermissionGate('auto'));reg.add(backgroundTool(manager))
  try{
    const r=await reg.execute('background',{command:'printf task-ok',cwd:dir},{sessionID:'test',agent:'test',cwd:dir,abort:new AbortController().signal})
    const id=r.output.match(/Started background task ([a-f0-9]{8,})/)?.[1]
    assert.ok(id,'background tool did not return a task id')
    const { runTaskWorker } = await import('../dist/tasks/worker.js')
    await runTaskWorker(id, manager)
    const done=await manager.get(id)
    assert.equal(done.status,'exited')
    assert.equal(done.exitCode,0)
    assert.match(done.output,/task-ok/)
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('CLI version reports the current release version', async()=>{
  const {spawn}=await import('node:child_process');const root=path.resolve('.')
  const out=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['dist/index.js','--version'],{cwd:root});let s='';p.stdout.on('data',b=>s+=b);p.on('error',reject);p.on('close',c=>c===0?resolve(s.trim()):reject(new Error(`exit ${c}`)))})
  assert.equal(out,'1.18.0')
})

