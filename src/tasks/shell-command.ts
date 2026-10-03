import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { TaskManager, type TaskRecord } from './manager.js'
import { processGroupAlive, terminateProcessGroup, writeChildStdinWithTimeout } from '../util/child-process.js'

export type ShellTermination = 'completed'|'nonzero'|'timeout'|'cancelled'|'signal'|'output-limit'|'stdin-timeout'|'spawn-error'

export interface ShellResult {
  code:number
  signal:any
  termination:ShellTermination
  interrupted:boolean
  durationMs:number
  outputPath:string
  outputBytes:number
  outputPreview:string
  outputTruncated:boolean
  interactiveLikely:boolean
  backgrounded:boolean
}

export interface ManagedShellOptions {
  shell:string
  command:string
  cwd:string
  timeout:number
  maxPreviewBytes:number
  outputLimitBytes?:number
  autoBackgroundMs?:number
  abort?:AbortSignal
  detached?:boolean
  parentSessionId?:string
  scopePaths?:string[]
  background?:boolean
  coordinated?:boolean
  stdin?:string
  stdinTimeoutMs?:number
}

export const AUTO_BACKGROUND_DEFAULT_MS = 15_000
const OUTPUT_WATCHDOG_MS = 2_000
const KILL_GRACE_MS = 1_500
const INTERACTIVE_COMMANDS = new Set(['vi','vim','nvim','nano','emacs','less','more','top','htop','watch','ssh','sftp','telnet','ftp','mysql','psql','python','python3','node','irb','bash','sh','zsh','fish'])
const INTERACTIVE_FLAGS = /(?:^|\s)(?:-it|--interactive|--tty|--stdin|--prompt)(?:\s|$)/i
const PROMPT_OUTPUT = /(?:\(y\/n\)|\[y\/n\]|(?:do you|are you sure|continue|overwrite)\?.*$|press (?:enter|any key))/im

export function looksInteractiveLikely(command:string):boolean {
  const first = command.trim().split(/\s+/)[0]?.split('/').pop()?.toLowerCase() || ''
  return INTERACTIVE_COMMANDS.has(first) || INTERACTIVE_FLAGS.test(command)
}

async function readPreview(filePath:string,maxBytes:number):Promise<{text:string;truncated:boolean;bytes:number}> {
  try {
    const stat=await fs.stat(filePath)
    const bytes=stat.size
    if(bytes<=maxBytes){ return {text:await fs.readFile(filePath,'utf8'),truncated:false,bytes} }
    const marker='\n…[shell output truncated]…\n'
    const markerBytes=Buffer.byteLength(marker,'utf8')
    if(maxBytes<=markerBytes){
      const raw=await fs.readFile(filePath)
      return {text:raw.subarray(0,maxBytes).toString('utf8'),truncated:true,bytes}
    }
    const payloadBytes=maxBytes-markerBytes
    const headBytes=Math.floor(payloadBytes*0.55)
    const tailBytes=payloadBytes-headBytes
    const read=async(start:number,size:number)=>{
      const h=await fs.open(filePath,'r')
      try{const b=Buffer.alloc(size);const {bytesRead}=await h.read(b,0,size,start);return b.subarray(0,bytesRead)}
      finally{await h.close()}
    }
    const [headBuf,tailBuf]=await Promise.all([read(0,headBytes),read(Math.max(0,bytes-tailBytes),tailBytes)])
    const fit=(text:string,limit:number)=>{let out=text;while(Buffer.byteLength(out,'utf8')>limit)out=out.slice(0,-1);return out}
    const head=fit(headBuf.toString('utf8'),headBytes)
    const tail=fit(tailBuf.toString('utf8'),tailBytes)
    return {text:`${head}${marker}${tail}`,truncated:true,bytes}
  } catch { return {text:'',truncated:false,bytes:0} }
}

function killProcessTree(child:any,signal='SIGTERM') {
  if(!child.pid) return false
  if(process.platform!=='win32') {
    try { process.kill(-child.pid,signal); return true } catch {}
  }
  try { return child.kill(signal) }
  catch { return false }
}

function exitCode(code:number|null,signal:any){ return code!==null ? code : signal ? 128 + signalNumber(signal) : 1 }
function signalNumber(signal:string){ const signals:Record<string,number>={SIGHUP:1,SIGINT:2,SIGQUIT:3,SIGILL:4,SIGABRT:6,SIGFPE:8,SIGKILL:9,SIGSEGV:11,SIGPIPE:13,SIGALRM:14,SIGTERM:15,SIGCHLD:17,SIGCONT:18,SIGSTOP:19,SIGTSTP:20,SIGTTIN:21,SIGTTOU:22,SIGUSR1:10,SIGUSR2:12}; return signals[signal]||1 }

export interface ManagedShellHandle {
  task:TaskRecord
  result:Promise<ShellResult>
  background():Promise<void>
}

export async function startManagedShell(manager:TaskManager,options:ManagedShellOptions,existingTask?:TaskRecord):Promise<ManagedShellHandle> {
  const task=existingTask || await manager.createShell(options.command,options.cwd,options.parentSessionId,options.scopePaths,{background:options.background,coordinated:options.coordinated,timeoutMs:options.timeout})
  if (task.timeoutMs !== options.timeout) { await manager.update(task.id,{timeoutMs:options.timeout}) }
  const outputPath=task.outputPath || manager.outputPath(task.id)
  await fs.mkdir(path.dirname(outputPath),{recursive:true})
  const handle=await fs.open(outputPath,'w')
  const child=spawn(options.shell,['-lc',options.command],{
    cwd:options.cwd,
    detached:options.detached ?? process.platform!=='win32',
    stdio:[options.stdin === undefined ? 'ignore' : 'pipe',handle.fd,handle.fd],
    env:process.env,
  })
  if(!child.pid){ await handle.close(); await manager.finish(task.id,{status:'failed',exitCode:1,termination:'spawn-error'}); throw new Error('Shell process did not provide a PID') }

  let backgrounded=false
  let timedOut=false
  let cancelled=false
  let outputLimit=false
  let stdinTimedOut=false
  let settled=false
  let resolveResult:(value:ShellResult)=>void=()=>{}
  const result=new Promise<ShellResult>(resolve=>{resolveResult=resolve})
  const started=Date.now()
  const timeoutMs=Math.max(0,options.timeout)
  const outputLimitBytes=Math.max(64*1024,options.outputLimitBytes??64*1024*1024)
  let timeoutId:ReturnType<typeof setTimeout>|undefined
  let autoBgId:ReturnType<typeof setTimeout>|undefined
  let watchdogId:ReturnType<typeof setInterval>|undefined
  let abortHandler:(()=>void)|undefined

  const finish=async(code:number|null,signal:any,error?:Error)=>{
    if(settled) return
    settled=true
    if(timeoutId) clearTimeout(timeoutId)
    if(autoBgId) clearTimeout(autoBgId)
    if(watchdogId) clearInterval(watchdogId)
    if(abortHandler) options.abort?.removeEventListener('abort',abortHandler)
    if (child.pid && !backgrounded && !cancelled && !timedOut && !outputLimit && !stdinTimedOut) {
      const lingering = processGroupAlive(child.pid)
      if (lingering) {
        const cleanup = await terminateProcessGroup(child.pid, { graceMs: KILL_GRACE_MS, pollMs: 30 })
        await manager.event(task.id, 'descendant_cleanup', cleanup).catch(()=>{})
      }
    }
    await handle.close().catch(()=>{})
    const preview=await readPreview(outputPath,Math.max(1,options.maxPreviewBytes))
    const termination:ShellTermination=error ? 'spawn-error' : timedOut ? 'timeout' : cancelled ? 'cancelled' : outputLimit ? 'output-limit' : stdinTimedOut ? 'stdin-timeout' : signal ? 'signal' : (code===0 ? 'completed' : 'nonzero')
    const finalCode=error ? 1 : exitCode(code,signal)
    const finalStatus=termination==='completed' ? 'exited' : termination==='cancelled' ? 'cancelled' : 'failed'
    // Persist the terminal event before exposing the terminal task status.
    // Callers polling TaskManager use status as the settlement boundary; if the
    // state were written first, a cleanup could race the final event append.
    await manager.event(task.id,termination==='completed'?'completed':'finished',{exitCode:finalCode,signal:signal||undefined,termination,outputPath,outputBytes:preview.bytes,backgrounded}).catch(()=>{})
    await manager.finish(task.id,{status:finalStatus,exitCode:finalCode,signal:signal||undefined,termination,output:preview.text,outputPath,outputBytes:preview.bytes,outputTruncated:preview.truncated,backgrounded,timeoutMs:options.timeout}).catch(()=>{})
    resolveResult({code:finalCode,signal,termination,interrupted:termination==='cancelled'||termination==='timeout'||termination==='signal'||termination==='stdin-timeout',durationMs:Date.now()-started,outputPath,outputBytes:preview.bytes,outputPreview:preview.text,outputTruncated:preview.truncated,interactiveLikely:looksInteractiveLikely(options.command)||PROMPT_OUTPUT.test(preview.text),backgrounded})
  }

  // Attach process listeners immediately after spawn. A fast command may exit
  // before task metadata/persistence awaits complete, so listener registration
  // must never happen after an async state transition.
  child.once('error',(error:any)=>{ void finish(1,null,error) })
  child.once('exit',(code:any,signal:any)=>{ void finish(code,signal) })

  if (!existingTask) await manager.claimWorker(task.id,child.pid).catch(()=>false)
  await manager.recordProcessIdentity(task.id,child.pid,`${options.shell} -lc ${options.command}`,options.cwd).catch(()=>{})

  if (options.stdin !== undefined) {
    try {
      await writeChildStdinWithTimeout(child, options.stdin, { timeoutMs: options.stdinTimeoutMs ?? 1000 })
      child.stdin?.end()
    } catch (error) {
      stdinTimedOut=true
      void terminateProcessGroup(child.pid, { graceMs: KILL_GRACE_MS, pollMs: 30 }).catch(()=>{ killProcessTree(child,'SIGTERM') })
      await manager.event(task.id, 'stdin_timeout', { timeoutMs: options.stdinTimeoutMs ?? 1000, error: error instanceof Error ? error.message : String(error) }).catch(()=>{})
    }
  }

  if (settled) {
    return {task:await manager.get(task.id),result,background:async()=>{}}
  }

  abortHandler=()=>{
    cancelled=true
    void terminateProcessGroup(child.pid, { graceMs: KILL_GRACE_MS, pollMs: 30 }).catch(()=>{ killProcessTree(child,'SIGTERM') })
  }
  if(options.abort){ if(options.abort.aborted) abortHandler(); else options.abort.addEventListener('abort',abortHandler,{once:true}) }

  if(timeoutMs>0){ timeoutId=setTimeout(()=>{ if(settled)return; timedOut=true; void terminateProcessGroup(child.pid, { graceMs: KILL_GRACE_MS, pollMs: 30 }).catch(()=>{ killProcessTree(child,'SIGTERM') }) },timeoutMs); (timeoutId as any).unref?.() }
  if(options.outputLimitBytes){ watchdogId=setInterval(()=>{ void fs.stat(outputPath).then((stat:any)=>{if(!settled&&stat.size>outputLimitBytes){outputLimit=true;killProcessTree(child,'SIGKILL')}}).catch(()=>{}) },Math.min(500, OUTPUT_WATCHDOG_MS)); (watchdogId as any).unref?.() }
  if(options.autoBackgroundMs && options.autoBackgroundMs>0){
    autoBgId=setTimeout(async()=>{
      if(settled||backgrounded) return
      backgrounded=true
      if(timeoutId){clearTimeout(timeoutId);timeoutId=undefined}
      await manager.update(task.id,{backgrounded:true}).catch(()=>{})
      await manager.event(task.id,'backgrounded',{reason:'auto-timeout',afterMs:options.autoBackgroundMs,outputPath}).catch(()=>{})
      const preview=await readPreview(outputPath,Math.max(1,options.maxPreviewBytes))
      resolveResult({code:0,signal:null,termination:'completed',interrupted:false,durationMs:Date.now()-started,outputPath,outputBytes:preview.bytes,outputPreview:preview.text,outputTruncated:preview.truncated,interactiveLikely:looksInteractiveLikely(options.command)||PROMPT_OUTPUT.test(preview.text),backgrounded:true})
      resolveResult=()=>{}
    },options.autoBackgroundMs); (autoBgId as any).unref?.()
  }

  return {task:await manager.get(task.id),result,background:async()=>{
    if(settled) return
    backgrounded=true
    if(timeoutId){clearTimeout(timeoutId);timeoutId=undefined}
    if(autoBgId){clearTimeout(autoBgId);autoBgId=undefined}
    await manager.update(task.id,{backgrounded:true})
    await manager.event(task.id,'backgrounded',{reason:'explicit',outputPath})
  }}
}

export async function runManagedShellTask(manager:TaskManager,task:TaskRecord,shell=process.env.SHELL||'sh',timeout=120_000,maxPreviewBytes=20_000,abort?:AbortSignal):Promise<ShellResult> {
  const handle=await startManagedShell(manager,{shell,command:task.command||'',cwd:task.cwd,timeout,maxPreviewBytes,outputLimitBytes:64*1024*1024,abort,detached:true},task)
  return handle.result
}
