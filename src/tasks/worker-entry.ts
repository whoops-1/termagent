#!/usr/bin/env node
import { TaskManager } from './manager.js'
import { runTaskWorker } from './worker.js'
const id=process.argv[2]
if(!id){console.error('Missing task id');process.exit(2)}
const fail=async(e:any)=>{
  try {
    const manager=new TaskManager()
    const result=await manager.finish(id,{status:'failed',exitCode:1,output:`\nWORKER ERROR: ${e?.stack||e}`.slice(-20000)})
    if(result.status==='failed') await manager.event(id,'failed',{error:String(e?.message||e),worker:true})
  } catch {}
  console.error(e?.stack||e)
  process.exitCode=1
}
process.on('uncaughtException',(e:any)=>{void fail(e)})
process.on('unhandledRejection',(e:any)=>{void fail(e)})
runTaskWorker(id).then(()=>process.exit(0)).catch(e=>{void fail(e)})
