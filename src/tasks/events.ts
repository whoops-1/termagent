import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDir } from '../util/fs.js'

export type TaskEvent={seq:number;ts:number;type:string;data:any}
export class TaskEventLog{
 private queues=new Map<string,Promise<void>>()
 constructor(private root:string){ }
 private file(id:string){return path.join(this.root,`${id}.events.jsonl`)}
 private lockFile(id:string){return path.join(this.root,`.${id}.events.lock`)}
 private async acquireLock(id:string){
  await ensureDir(this.root)
  const lockPath=this.lockFile(id), token=crypto.randomBytes(12).toString('hex')
  const payload=JSON.stringify({pid:process.pid,token,started:Date.now()})+'\n'
  for(let attempt=0;attempt<40;attempt++){
    try{
      const handle=await fs.open(lockPath,'wx')
      try{await handle.writeFile(payload,'utf8')}finally{await handle.close()}
      return {lockPath,token}
    }catch(error){
      if((error as {code?:string}).code!=='EEXIST')throw error
      let owner:any
      try{owner=JSON.parse(await fs.readFile(lockPath,'utf8'))}catch(error){
        if((error as {code?:string}).code==='ENOENT')continue
        const info=await fs.stat(lockPath).catch(()=>undefined)
        if(info&&Date.now()-info.mtimeMs<5000){await new Promise(r=>setTimeout(r,10));continue}
        await fs.rm(lockPath,{force:true});continue
      }
      const pid=Number(owner?.pid)
      if(Number.isInteger(pid)&&pid>0){
        try{process.kill(pid,0);await new Promise(r=>setTimeout(r,10));continue}catch(error){if((error as {code?:string}).code!=='ESRCH')throw error}
      }
      await fs.rm(lockPath,{force:true})
    }
  }
  throw new Error(`Unable to acquire task event lock: ${id}`)
 }
 private async releaseLock(lock:{lockPath:string;token:string}){
  try{
    const owner=JSON.parse(await fs.readFile(lock.lockPath,'utf8'))
    if(owner?.pid===process.pid&&owner?.token===lock.token)await fs.rm(lock.lockPath,{force:true})
  }catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
 }
 async append(id:string,type:string,data:any){
  const previous=this.queues.get(id)||Promise.resolve(); let result=0
  const next=previous.then(async()=>{
    const lock=await this.acquireLock(id)
    try{
      await ensureDir(this.root)
      let seq=1
      try{
        const text=await fs.readFile(this.file(id),'utf8'); const lines=text.split('\n').filter(Boolean); if(lines.length)seq=Number(JSON.parse(lines[lines.length-1]).seq||0)+1
      }catch{}
      result=seq
      await fs.appendFile(this.file(id),JSON.stringify({seq,ts:Date.now(),type,data})+'\n')
    }finally{await this.releaseLock(lock)}
  })
  this.queues.set(id,next.catch(()=>{})); await next; return result
 }
 async read(id:string){try{return (await fs.readFile(this.file(id),'utf8')).split('\n').filter(Boolean).map((x:string)=>JSON.parse(x) as TaskEvent)}catch{return []}}
}
