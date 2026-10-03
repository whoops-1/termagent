import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export async function interpolateCommandTemplate(template:string,args:string[],cwd:string,maxBytes=12000){
  let out=template.replaceAll('$ARGUMENTS',args.join(' '))
  args.forEach((a,i)=>{out=out.replaceAll(`$${i+1}`,a)})
  const shellRe=/!`([^`]+)`/g
  out=await replaceAsync(out,shellRe,async(cmd)=>{
    const result=await runShell(cmd,cwd,maxBytes)
    return truncate(result,maxBytes)
  })
  const fileRe=/(^|[\s=(])@((?:[^\s`]+))/g
  out=await replaceAsync(out,fileRe,async(prefix,ref)=>{
    if(ref.startsWith('@')) return prefix+ref
    const target=path.resolve(cwd,ref)
    if(!target.startsWith(path.resolve(cwd)+path.sep) && target!==path.resolve(cwd)) return prefix+`@${ref}`
    const st=await fs.stat(target).catch(()=>null)
    if(!st || !st.isFile()) return prefix+`@${ref}`
    const content=await fs.readFile(target,'utf8')
    return prefix + 'FILE ' + ref + ':\n```\n' + truncate(content,maxBytes) + '\n```'
  })
  return out
}
function runShell(cmd:string,cwd:string,maxBytes:number){return new Promise<string>((resolve,reject)=>{const child=spawn('sh',['-lc',cmd],{cwd,stdio:['ignore','pipe','pipe']});let out='';const collect=(chunk:any)=>{if(out.length<maxBytes*2)out+=String(chunk)};child.stdout?.on('data',collect);child.stderr?.on('data',collect);child.on('error',reject);child.on('close',(code:any)=>resolve((code?`exit ${code}\n`:'')+out.slice(0,maxBytes)))})}
async function replaceAsync(str:string,re:RegExp,fn:(...args:any[])=>Promise<string>){const matches=[...str.matchAll(re)];let result=str;for(let i=matches.length-1;i>=0;i--){const m=matches[i];const replacement=await fn(...m.slice(1));result=result.slice(0,m.index!)+replacement+result.slice(m.index!+m[0].length)}return result}
function truncate(s:string,n:number){return s.length<=n?s:s.slice(0,n)+`\n[truncated at ${n} bytes]`}
