import http from 'node:http'
import { URL } from 'node:url'
import crypto from 'node:crypto'
import type { Runtime } from './runtime.js'
import { VERSION } from '../version.js'

function json(res:any,status:number,data:any){const body=JSON.stringify(data);res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Length',Buffer.byteLength(body));res.end(body)}
function text(res:any,status:number,data:string,contentType='text/plain; charset=utf-8'){res.statusCode=status;res.setHeader('Content-Type',contentType);res.end(data)}
async function body(req:any){const chunks:any[]=[];for await(const c of req)chunks.push(Buffer.from(c));if(!chunks.length)return {};const raw=Buffer.concat(chunks).toString('utf8');try{return JSON.parse(raw)}catch{throw new Error('Invalid JSON body')}}
function authOk(req:any,token?:string){if(!token)return true;const h=req.headers.authorization||'';const x=req.headers['x-termagent-token'];return h===`Bearer ${token}`||x===token}
function sseHeaders(res:any){res.statusCode=200;res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.flushHeaders?.()}
function sse(res:any,event:string,data:any){res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)}
function errorStatus(error:unknown){return error instanceof Error && /^Session is busy:/.test(error.message)?409:500}

async function streamSessionEvents(runtime:Runtime,id:string,res:any,after:number){
  sseHeaders(res)
  let cursor=Math.max(0,Math.floor(after));
  let closed=false
  sse(res,'ready',{sessionId:id,offset:cursor})
  const heartbeat=setInterval(()=>{if(!closed)sse(res,'heartbeat',{ts:Date.now()})},15000)
  const poll=async()=>{
    if(closed)return
    try{
      const snapshot=await runtime.store.load(id)
      const events=snapshot.events
      if(cursor>events.length)cursor=events.length
      for(const event of events.slice(cursor)){sse(res,'event',{offset:cursor,event});cursor++}
      if(!closed)setTimeout(poll,250)
    }catch(error){
      if(!closed){sse(res,'error',{message:(error as Error).message});res.end();closed=true}
    }
  }
  const cleanup=()=>{closed=true;clearInterval(heartbeat)}
  res.on('close',cleanup)
  res.on('error',cleanup)
  void poll()
}

export async function startServer(runtime:Runtime,opts:{host:string;port:number;token?:string}):Promise<any>{
  const pendingQuestions=new Map<string,{sessionId:string;requestId:string;questions:any[];resolve:(response:{status:'replied'|'rejected'|'cancelled';answers:string[][]})=>void;reject:(error:Error)=>void}>()
  const server=http.createServer(async(req:any,res:any)=>{
    try{
      if(!authOk(req,opts.token)){res.setHeader('WWW-Authenticate','Bearer');return json(res,401,{error:'Unauthorized'})}
      const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`); const parts=u.pathname.split('/').filter(Boolean)
      if(req.method==='GET'&&u.pathname==='/health')return json(res,200,{ok:true,name:'termagent',version:VERSION,node:process.version,platform:process.platform,arch:process.arch})
      if(req.method==='GET'&&u.pathname==='/api/v1/info')return json(res,200,{name:'termagent',version:VERSION,cwd:runtime.cwd,provider:runtime.getProvider().id,model:runtime.getProvider().model,features:['sessions','streaming','events','tools','tasks','agents','skills','mcp','client-sdk','commands','compaction','questions','context']})
      if(req.method==='GET'&&u.pathname==='/api/v1/commands')return json(res,200,{commands:[
        'help','model','models','variants','provider','agent','agents','commands','plan','build','explore','sessions','resume','fork','branch','skills','doctor','permissions','compact','thinking','details','undo','redo','diff','repomap','history','editor','export','stash','queue','vim','tasks','task-log','checkpoints','checkpoint','restore','cancel','auto','clear','quit','exit',
        ...runtime.customCommands.map((c:any)=>({name:c.name,description:c.description}))
      ]})
      if(req.method==='GET'&&u.pathname==='/api/v1/sessions')return json(res,200,{sessions:await runtime.store.list()})
      if(req.method==='POST'&&u.pathname==='/api/v1/sessions'){
        const b=await body(req); if(b.cwd && String(b.cwd)!==runtime.cwd)return json(res,400,{error:`Server is scoped to ${runtime.cwd}; start another server for a different project`}); const meta=await runtime.store.create(runtime.cwd,String(b.model||runtime.getProvider().model||''));return json(res,201,meta)
      }
      if(parts[0]==='api'&&parts[1]==='v1'&&parts[2]==='sessions'&&parts[3]){
        const id=decodeURIComponent(parts[3]);
        if(req.method==='GET'&&parts.length===4){const x=await runtime.store.load(id);return json(res,200,{meta:x.meta,messages:x.messages,events:x.events})}
        if(req.method==='GET'&&parts[4]==='messages'){const q=Math.max(0,Number(u.searchParams.get('after')||0));const x=await runtime.store.load(id);return json(res,200,{messages:x.messages.slice(q),offset:q,total:x.messages.length})}
        if(req.method==='GET'&&parts[4]==='events'&&parts[5]==='stream')return streamSessionEvents(runtime,id,res,Number(u.searchParams.get('after')||0))
        if(req.method==='GET'&&parts[4]==='events'){const q=Math.max(0,Number(u.searchParams.get('after')||0));const x=await runtime.store.load(id);return json(res,200,{events:x.events.slice(q),offset:q,total:x.events.length})}
        if(req.method==='GET'&&parts[4]==='status'){const x=await runtime.store.load(id);return json(res,200,{sessionId:id,running:runtime.isRunning(id),messageCount:x.messages.length,updated:x.meta?.updated})}
        if(req.method==='GET'&&parts[4]==='diff'){const diff=await (await import('../diff/render.js')).renderGitDiff(runtime.cwd,{staged:u.searchParams.get('staged')==='1',color:false,maxBytes:runtime.cfg.maxOutputBytes});return json(res,200,diff)}
        if(req.method==='POST'&&(parts[4]==='interrupt'||parts[4]==='abort')){const interrupted=runtime.interrupt(id);return json(res,interrupted?202:409,{sessionId:id,interrupted})}
        if(req.method==='GET'&&parts[4]==='context')return json(res,200,await runtime.contextSnapshot(id))
        if(req.method==='GET'&&parts[4]==='checkpoints')return json(res,200,{checkpoints:await runtime.store.listCheckpoints(id)})
        if(req.method==='POST'&&parts[4]==='checkpoints'&&parts[5]&&parts[6]==='restore')return json(res,200,await runtime.store.restoreCheckpoint(id,decodeURIComponent(parts[5])))
        if(req.method==='POST'&&parts[4]==='checkpoints'&&parts[5]&&parts[6]==='branch'){const b=await body(req);return json(res,201,await runtime.store.forkFromCheckpoint(id,decodeURIComponent(parts[5]),{restoreWorkspace:Boolean(b.restoreWorkspace)}))}
        if(req.method==='POST'&&parts[4]==='undo'){const result=await runtime.store.undo(id,runtime.cwd);return json(res,200,{turn:result.turn,messages:result.messages})}
        if(req.method==='POST'&&parts[4]==='redo'){const result=await runtime.store.redo(id,runtime.cwd);return json(res,200,{turn:result.turn,messages:result.messages})}
        if(req.method==='POST'&&parts[4]==='compact'){return json(res,200,await runtime.compactSession(id))}
        if(req.method==='POST'&&parts[4]==='fork'){const b=await body(req);return json(res,201,await runtime.store.fork(id,Number.isFinite(Number(b.at))?Number(b.at):undefined))}
        if(req.method==='POST'&&parts[4]==='checkpoint'){const x=await runtime.store.load(id);return json(res,201,await runtime.store.checkpoint(id,x.messages,{label:String((await body(req)).label||'api')}))}
        if(req.method==='POST'&&parts[4]==='questions'&&parts[5]){
          const key=`${id}:${decodeURIComponent(parts[5])}`
          const pending=pendingQuestions.get(key)
          if(!pending)return json(res,404,{error:'Question request not found or already answered'})
          const b=await body(req)
          const status=(b.status||'replied') as 'replied'|'rejected'|'cancelled'
          if(!['replied','rejected','cancelled'].includes(status))return json(res,400,{error:'invalid question status'})
          const answers=Array.isArray(b.answers)?b.answers.map((a:any)=>Array.isArray(a)?a.map(String):[String(a)]):[]
          if(status==='replied'&&!Array.isArray(b.answers))return json(res,400,{error:'answers must be an array of string arrays'})
          pendingQuestions.delete(key); pending.resolve({status,answers}); return json(res,200,{ok:true,requestId:pending.requestId,status})
        }
        if(req.method==='POST'&&parts[4]==='prompt'){
          const b=await body(req); const prompt=String(b.prompt||''); if(!prompt)return json(res,400,{error:'prompt is required'})
          const x=await runtime.store.load(id); const messages=x.messages
          const wantStream=b.stream!==false
          if(!wantStream){const custom=typeof b.agent==='string'?runtime.customAgents.find((a:any)=>a.name===b.agent):undefined; const result=await runtime.runPrompt(id,messages,prompt,{mode:b.mode,autonomous:Boolean(b.autonomous),customAgent:custom,onTool:()=>{},onToolResult:()=>{}});return json(res,200,{sessionId:id,text:result})}
          sseHeaders(res); const heartbeat=setInterval(()=>res.write(': ping\n\n'),15000); let done=false; const controller=new AbortController()
          req.on('aborted',()=>{done=true;controller.abort()})
          try{
            const custom=typeof b.agent==='string'?runtime.customAgents.find((a:any)=>a.name===b.agent):undefined; const requestQuestion=async(questions:any[],signal?:AbortSignal)=>{const qid=`que_${crypto.createHash('sha256').update(`${id}\0${JSON.stringify(questions)}`).digest('hex').slice(0,24)}`;const key=`${id}:${qid}`;const enriched=questions.map((q:any,i:number)=>({...q,id:q.id||`q_${i+1}`}));sse(res,'question',{id:qid,questions:enriched});const response=await new Promise<{status:'replied'|'rejected'|'cancelled';answers:string[][]}>((resolve,reject)=>{pendingQuestions.set(key,{sessionId:id,requestId:qid,questions:enriched,resolve,reject});const onAbort=()=>{pendingQuestions.delete(key);resolve({status:'cancelled',answers:[]});};signal?.addEventListener('abort',onAbort,{once:true})});return response}; const result=await runtime.runPrompt(id,messages,prompt,{mode:b.mode,autonomous:Boolean(b.autonomous),customAgent:custom,signal:controller.signal,onReasoning:s=>{if(!done)sse(res,'reasoning',{delta:s})},onText:s=>{if(!done)sse(res,'text',{delta:s})},onTool:(name,args)=>{if(!done)sse(res,'tool_start',{name,args})},onToolResult:(name,out)=>{if(!done)sse(res,'tool_end',{name,output:out})},onStatus:s=>{if(!done)sse(res,'status',{message:s})},onQuestion:requestQuestion})
            if(!done)sse(res,'done',{sessionId:id,text:result})
          }catch(e){if(!done)sse(res,'error',{message:(e as Error).message})}finally{clearInterval(heartbeat);res.end()}
          return
        }
      }
      if(req.method==='GET'&&u.pathname==='/api/v1/tasks')return json(res,200,{tasks:await runtime.tasks.list()})
      if(parts[0]==='api'&&parts[1]==='v1'&&parts[2]==='tasks'&&parts[3]){
        const id=decodeURIComponent(parts[3]);
        if(req.method==='GET'&&parts.length===4)return json(res,200,await runtime.tasks.get(id))
        if(req.method==='GET'&&parts[4]==='events')return json(res,200,{events:await runtime.tasks.history(id)})
        if(req.method==='POST'&&parts[4]==='cancel')return json(res,200,await runtime.tasks.cancel(id))
      }
      if(req.method==='GET'&&u.pathname==='/api/v1/tools')return json(res,200,{tools:runtime.registry.list().map((t:any)=>({name:t.name,description:t.description,risk:t.risk,schema:t.schema}))})
      if(req.method==='GET'&&u.pathname==='/api/v1/models'){const profiles=Object.entries(runtime.cfg.providers||{}).map(([name,p]:any)=>({name,provider:p.provider,model:p.model,baseUrl:p.baseUrl,variants:Object.keys(p.variants||{}).map((v:string)=>({name:v,...p.variants[v]}))}));return json(res,200,{active:{provider:runtime.getProvider().id,model:runtime.getProvider().model},profiles,routing:runtime.cfg.routing||{},smartRouting:runtime.cfg.smartRouting||{enabled:false}})}
      if(req.method==='GET'&&u.pathname==='/api/v1/agents')return json(res,200,{builtin:['build','plan','explore'],custom:runtime.customAgents})
      if(req.method==='GET'&&u.pathname==='/api/v1/skills')return json(res,200,{skills:runtime.skills.map(s=>({name:s.name,description:s.description}))})
      return json(res,404,{error:'Not found'})
    }catch(e){return json(res,errorStatus(e),{error:(e as Error).message})}
  })
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(opts.port,opts.host,()=>resolve())})
  return server
}
