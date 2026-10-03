import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { loadCustomAgents, loadCustomCommands, renderCommand } from '../dist/agent/custom.js'
import { TaskEventLog } from '../dist/tasks/events.js'

test('custom agents and commands load established style markdown definitions', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'termagent-custom-'))
  try {
    await mkdir(path.join(dir,'.termagent','agents'),{recursive:true})
    await mkdir(path.join(dir,'.termagent','commands'),{recursive:true})
    await writeFile(path.join(dir,'.termagent','agents','review.md'),'---\ndescription: Review code\nmode: subagent\npermission: edit: deny\n---\nReview carefully.')
    await writeFile(path.join(dir,'.termagent','commands','test.md'),'---\ndescription: Run tests\nagent: review\n---\nRun tests for $ARGUMENTS')
    const agents=await loadCustomAgents(dir); const commands=await loadCustomCommands(dir)
    assert.equal(agents[0].name,'review'); assert.equal(agents[0].mode,'subagent'); assert.match(agents[0].prompt,/Review carefully/)
    assert.equal(commands[0].name,'test'); assert.equal(renderCommand(commands[0],['auth']), 'Run tests for auth')
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('task event log persists ordered workflow state', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'termagent-events-')); const log=new TaskEventLog(dir)
  try { await log.append('abc','created',{prompt:'x'}); await log.append('abc','checkpoint',{step:2}); const events=await log.read('abc'); assert.equal(events.length,2); assert.deepEqual(events.map(e=>e.seq),[1,2]); assert.equal(events[1].data.step,2) }
  finally { await rm(dir,{recursive:true,force:true}) }
})
