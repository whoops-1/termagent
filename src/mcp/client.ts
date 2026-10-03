import { spawn } from 'node:child_process'
import type { MCPServer } from '../config/config.js'
import type { ToolDefinition, ToolProvenance } from '../tools/types.js'

export class MCPClient{
 private child?:any;private next=1;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:any)=>void}>();private buffer=''
 constructor(public name:string,private cfg:MCPServer,private cwd:string,private provenance?:ToolProvenance){}
 async connect(){
  this.child=spawn(this.cfg.command,this.cfg.args||[],{cwd:this.cwd,env:{...process.env,...this.cfg.env},stdio:['pipe','pipe','pipe']})
  this.child.stdout.on('data',(b:any)=>this.onData(b.toString())); this.child.on('exit',()=>{for(const p of this.pending.values())p.reject(new Error(`MCP server ${this.name} exited`));this.pending.clear()})
  await this.request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'termagent',version:'0.2.0'}});this.notify('notifications/initialized',{});return this
 }
 private onData(s:string){this.buffer+=s;let lines=this.buffer.split(/\r?\n/);this.buffer=lines.pop()||'';for(const line of lines){if(!line.trim())continue;try{const j=JSON.parse(line);const p=this.pending.get(j.id);if(!p)continue;this.pending.delete(j.id);if(j.error)p.reject(new Error(j.error.message||'MCP error'));else p.resolve(j.result)}catch{}}}
 private request(method:string,params:any):Promise<any>{return new Promise((resolve,reject)=>{const id=this.next++;this.pending.set(id,{resolve,reject});this.child?.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})}
 private notify(method:string,params:any){this.child?.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n')}
 async tools():Promise<ToolDefinition[]>{const r=await this.request('tools/list',{});return (r.tools||[]).map((t:any)=>({name:`mcp_${this.name}_${t.name}`,risk:'read',description:`MCP ${this.name}: ${t.description||t.name}`,schema:t.inputSchema||{type:'object',properties:{}},provenance:this.provenance||{kind:'mcp',server:this.name},execute:async(args:any)=>{const x=await this.request('tools/call',{name:t.name,arguments:args});return {output:(x.content||[]).map((c:any)=>c.text||JSON.stringify(c)).join('\n'),metadata:{mcpServer:this.name,tool:t.name,provenance:this.provenance}}}}))}
 async close(){try{this.child?.kill('SIGTERM')}catch{}}
}
export async function connectMCP(servers:Record<string,MCPServer>,cwd:string){const clients:MCPClient[]=[];const tools:ToolDefinition[]=[];for(const [name,raw] of Object.entries(servers||{})){try{const cfg=raw as any;const provenance=cfg?.pluginId?{kind:'mcp' as const,server:cfg.serverName||name,pluginId:String(cfg.pluginId),pluginName:String(cfg.pluginName||''),marketplace:String(cfg.marketplace||'')} : {kind:'mcp' as const,server:name};const clean={command:String(cfg.command),args:Array.isArray(cfg.args)?cfg.args.map(String):undefined,env:cfg.env&&typeof cfg.env==='object'?Object.fromEntries(Object.entries(cfg.env).map(([k,v])=>[k,String(v)])):undefined};const c=await new MCPClient(name,clean,cwd,provenance).connect();clients.push(c);tools.push(...await c.tools())}catch(e){console.error(`[mcp:${name}] ${(e as Error).message}`)}}return {clients,tools}}
