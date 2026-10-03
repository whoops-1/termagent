import { promises as fs } from 'node:fs'
import path from 'node:path'
import { exists } from '../util/fs.js'

export type CustomAgent = { name:string; description:string; mode:'primary'|'subagent'|'all'; model?:string; prompt:string; permission?:Record<string,any>; hidden?:boolean; steps?:number; tools?:string[]; disallowedTools?:string[]; skills?:string[]; plugin?:{pluginId:string;pluginName:string;marketplace:string;version:string;installPath:string} }
export type CustomCommand = { name:string; description:string; agent?:string; model?:string; subtask?:boolean; template:string; allowedTools?:string[]; argumentHint?:string; plugin?:{pluginId:string;pluginName:string;marketplace:string;version:string;installPath:string} }

export function parseFrontmatterText(text:string){
  if(!text.startsWith('---')) return {meta:{},body:text}
  const end=text.indexOf('\n---',3); if(end<0) return {meta:{},body:text}
  const raw=text.slice(4,end).split(/\r?\n/); const meta:Record<string,any>={}
  for(const line of raw){const m=line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/); if(!m) continue; let v=m[2].trim(); if((v.startsWith('\"')&&v.endsWith('\"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1); const key=m[1]; if(v.startsWith('[')&&v.endsWith(']')){try{const parsed=JSON.parse(v); if(Array.isArray(parsed)){meta[key]=parsed; continue}}catch{} const items=v.slice(1,-1).split(',').map(item=>item.trim().replace(/^(['"])(.*)\1$/,'$2')).filter(Boolean); if(items.length>0){meta[key]=items; continue}} if(v==='true')meta[key]=true; else if(v==='false')meta[key]=false; else if(/^\d+$/.test(v))meta[key]=Number(v); else meta[key]=v}
  return {meta,body:text.slice(end+4).trim()}
}
async function scan(dir:string, suffix:string){const out:string[]=[];if(!(await exists(dir)))return out;for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await scan(p,suffix));else if(e.name.endsWith(suffix))out.push(p)}return out}
function unique<T>(xs:T[]){return [...new Set(xs)]}
export async function loadCustomAgents(cwd:string):Promise<CustomAgent[]>{
 const home=process.env.HOME||cwd; const dirs=unique([path.join(cwd,'.termagent','agents'),path.join(cwd,'.termagent','agent'),path.join(home,'.termagent','agents'),path.join(home,'.termagent','agent')]);
 const files=(await Promise.all(dirs.map(d=>scan(d,'.md')))).flat(); const out:CustomAgent[]=[]
 for(const f of files){const parsed=parseFrontmatterText(await fs.readFile(f,'utf8'));const name=path.basename(f,'.md');out.push({name,description:String(parsed.meta.description||name),mode:(parsed.meta.mode==='primary'||parsed.meta.mode==='all')?parsed.meta.mode:'subagent',model:parsed.meta.model,prompt:parsed.body,permission:parsed.meta.permission,hidden:Boolean(parsed.meta.hidden),steps:parsed.meta.steps})}
 return out
}
export async function loadCustomCommands(cwd:string):Promise<CustomCommand[]>{
 const home=process.env.HOME||cwd; const dirs=unique([path.join(cwd,'.termagent','commands'),path.join(cwd,'.termagent','command'),path.join(home,'.termagent','commands'),path.join(home,'.termagent','command')]);
 const files=(await Promise.all(dirs.map(d=>scan(d,'.md')))).flat(); const out:CustomCommand[]=[]
 for(const f of files){const parsed=parseFrontmatterText(await fs.readFile(f,'utf8'));const name=path.basename(f,'.md');out.push({name,description:String(parsed.meta.description||name),agent:parsed.meta.agent,model:parsed.meta.model,subtask:Boolean(parsed.meta.subtask),template:parsed.body})}
 return out
}
export function renderCommand(command:CustomCommand,args:string[]){let out=command.template.replaceAll('$ARGUMENTS',args.join(' '));args.forEach((a,i)=>{out=out.replaceAll(`$${i+1}`,a)});return out}
