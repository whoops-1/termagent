import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyPatchTool } from '../dist/tools/apply-patch.js'
import * as Patch from '../dist/patch.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { TaskManager } from '../dist/tasks/manager.js'
import { verifyTool } from '../dist/tools/verify.js'

async function tmp(){ return fs.mkdtemp(path.join(os.tmpdir(),'termagent-phase13l-')) }
function ctx(cwd,extra={}){ return {sessionID:'phase13l',agent:'build',cwd,abort:new AbortController().signal,...extra} }

const multiPatch = `*** Begin Patch
*** Add File: added.txt
+added line
*** Update File: first.txt
@@
-old first
+new first
*** Delete File: delete.txt
*** End Patch`

test('13L uses the established patch grammar and derives add/update/delete changes', () => {
  const parsed = Patch.parse(`*** Begin Patch\n*** Update File: x.txt\n@@\n- old   \n+new\n*** End Patch`)
  assert.equal(parsed.length,1)
  assert.equal(parsed[0].type,'update')
  const derived = Patch.derive('x.txt', parsed[0].chunks, 'old\n')
  assert.equal(derived.content, 'new\n')

  const changes = Patch.parse(multiPatch)
  assert.deepEqual(changes.map(x=>x.type),['add','update','delete'])
})

test('13L apply_patch preflight rejects invalid patches before any permission request', async () => {
  const root=await tmp()
  try {
    let prompts=0
    const gate=new PermissionGate('ask')
    gate.setRequester(async()=>{ prompts++; return 'once' })
    const registry=new ToolRegistry(gate).add(applyPatchTool())
    await assert.rejects(
      () => registry.execute('apply_patch',{patchText:'not a patch'},ctx(root)),
      /missing Begin\/End markers/,
    )
    assert.equal(prompts,0)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13L apply_patch asks once for a multi-file edit batch and applies add/update/delete sequentially', async () => {
  const root=await tmp()
  try {
    await fs.writeFile(path.join(root,'first.txt'),'old first\n','utf8')
    await fs.writeFile(path.join(root,'delete.txt'),'delete me\n','utf8')
    const prompts=[]
    const gate=new PermissionGate('ask')
    gate.setRequester(async request=>{ prompts.push(request); return 'once' })
    const registry=new ToolRegistry(gate).add(applyPatchTool())
    const result=await registry.execute('apply_patch',{patchText:multiPatch},ctx(root))
    assert.equal(prompts.length,1)
    assert.deepEqual(new Set(prompts[0].resources),new Set(['added.txt','first.txt','delete.txt']))
    assert.equal((await fs.readFile(path.join(root,'first.txt'),'utf8')),'new first\n')
    assert.equal((await fs.readFile(path.join(root,'added.txt'),'utf8')),'added line\n')
    await assert.rejects(()=>fs.stat(path.join(root,'delete.txt')),/ENOENT/)
    assert.equal(result.metadata.patch.partial,false)
    assert.equal(result.metadata.patch.fileCount,3)
    assert.match(result.output,/A added\.txt/)
    assert.match(result.output,/M first\.txt/)
    assert.match(result.output,/D delete\.txt/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13L apply_patch reports explicit partial application when a later sequential change fails', async () => {
  const root=await tmp()
  try {
    const patch=`*** Begin Patch\n*** Add File: duplicate.txt\n+first\n*** Add File: duplicate.txt\n+second\n*** End Patch`
    const gate=new PermissionGate('auto')
    const registry=new ToolRegistry(gate).add(applyPatchTool())
    await assert.rejects(
      () => registry.execute('apply_patch',{patchText:patch},ctx(root)),
      /Patch partially applied before failing at duplicate\.txt\. Applied: duplicate\.txt/,
    )
    assert.equal((await fs.readFile(path.join(root,'duplicate.txt'),'utf8')),'first\n')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13L permission batching sends one approval request for many resources', async () => {
  const gate=new PermissionGate('ask')
  const calls=[]
  gate.setRequester(async request=>{calls.push(request);return 'once'})
  const tool={name:'batch_edit',description:'batch',risk:'write',schema:{type:'object'},permission:{action:'edit',resources:()=>['a.ts','b.ts','c.ts']},async execute(){return {output:'ok'}}}
  const registry=new ToolRegistry(gate).add(tool)
  await registry.execute('batch_edit',{},ctx(process.cwd()))
  assert.equal(calls.length,1)
  assert.deepEqual(calls[0].resources,['a.ts','b.ts','c.ts'])
})

test('13L verify_project settles through the durable task infrastructure', async () => {
  const root=await tmp()
  try {
    const manager=new TaskManager(path.join(root,'tasks'),false,path.join(root,'sessions'))
    const tool=verifyTool(5000,4000,manager)
    const result=await tool.execute({command:'printf durable-verify'},ctx(root))
    const taskId=result.metadata.task.taskId
    const task=await manager.get(taskId)
    assert.equal(task.kind,'shell')
    assert.equal(task.status,'exited')
    assert.equal(task.termination,'completed')
    assert.match(result.output,/task=/)
    assert.match(result.output,/durable-verify/)
    assert.equal(result.metadata.ok,true)
    const history=await manager.history(taskId)
    assert.ok(history.some(event=>event.type==='completed'))
    assert.ok(history.some(event=>event.type==='state' && event.data?.status==='exited'))
    assert.equal(task.outputPath,result.metadata.task.outputPath)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13L verify_project preserves its legacy 124 timeout result while the durable task records the real termination', async () => {
  const root=await tmp()
  try {
    const manager=new TaskManager(path.join(root,'tasks'),false,path.join(root,'sessions'))
    const tool=verifyTool(50,4000,manager)
    const result=await tool.execute({command:'sleep 1'},ctx(root))
    assert.equal(result.metadata.ok,false)
    assert.equal(result.metadata.exitCode,124)
    assert.equal(result.metadata.status,'timeout')
    const task=await manager.get(result.metadata.task.taskId)
    assert.equal(task.status,'failed')
    assert.equal(task.termination,'timeout')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13L verify_project keeps scoped-worker arbitrary command restriction', async () => {
  const root=await tmp()
  try {
    const manager=new TaskManager(path.join(root,'tasks'),false,path.join(root,'sessions'))
    const tool=verifyTool(5000,4000,manager)
    await assert.rejects(
      () => tool.execute({command:'printf should-not-run'},ctx(root,{scopePaths:['src']})),
      /Explicit verification commands are disabled for scoped workers/,
    )
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13L repo_map remains a bounded complementary builtin rather than a second discovery system', async () => {
  const root=await tmp()
  try {
    await fs.writeFile(path.join(root,'package.json'),'{}','utf8')
    const { builtinTools } = await import('../dist/tools/builtin.js')
    const map=builtinTools({timeout:1000,maxOutput:1200}).find(tool=>tool.name==='repo_map')
    assert.ok(map)
    const out=await map.execute({tokens:256},ctx(root))
    assert.ok(out.output.length<=1200)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})
