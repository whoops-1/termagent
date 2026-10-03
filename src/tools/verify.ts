import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import crypto from 'node:crypto'
import { TaskManager } from '../tasks/manager.js'
import { startManagedShell } from '../tasks/shell-command.js'
import type { ToolDefinition } from './types.js'

export type VerificationStatus = 'passed'|'failed'|'timeout'|'cancelled'|'no_command'

function commandFingerprint(command:string){return crypto.createHash('sha256').update(command).digest('hex')}

export function verifyTool(timeout=120000,maxOutput=20000,manager=new TaskManager()):ToolDefinition{
  return {
    name:'verify_project',
    risk:'shell',
    description:'Detect and run the project verification command using the durable task runner. Prefer tests, then package checks, then a safe project-specific build/typecheck. Scoped workers must use automatic project verification and cannot supply an arbitrary shell command.',
    schema:{type:'object',properties:{command:{type:'string'},timeoutMs:{type:'integer',minimum:1},force:{type:'boolean'}},required:[],additionalProperties:false},
    async execute(a,c){
      if(c.scopePaths?.length&&a.command) throw new Error('Explicit verification commands are disabled for scoped workers; use automatic project verification.')
      const cmd=a.command||await detect(c.cwd)
      if(!cmd) return {output:'No safe verification command detected. Inspect project files and choose an explicit command.',metadata:{status:'no_command',ok:false,verification:{status:'no_command',ok:false,settled:true,facts:[]}}}
      const timeoutMs=Math.min(Math.max(1,Number(a.timeoutMs||timeout)),300000)
      const handle=await startManagedShell(manager,{shell:process.env.SHELL||'sh',command:cmd,cwd:c.cwd,timeout:timeoutMs,maxPreviewBytes:Math.max(1,maxOutput),outputLimitBytes:64*1024*1024,abort:c.abort,detached:true,parentSessionId:c.sessionID,scopePaths:c.scopePaths})
      const result=await handle.result
      const task=await manager.get(handle.task.id)
      const exitCode=result.termination==='timeout' ? 124 : result.code
      const status:VerificationStatus = result.termination==='timeout' ? 'timeout' : result.termination==='cancelled' ? 'cancelled' : exitCode===0 ? 'passed' : 'failed'
      const fingerprint=commandFingerprint(cmd)
      const output=`exit=${exitCode}${result.signal?` signal=${result.signal}`:''}\ntask=${handle.task.id}\n${result.outputPreview}`
      return {
        title:cmd,
        output,
        metadata:{
          status,
          ok:result.code===0,
          exitCode,
          signal:result.signal||undefined,
          command:cmd,
          task:{
            taskId:handle.task.id,
            kind:task.kind,
            status:task.status,
            termination:task.termination,
            outputPath:task.outputPath,
            outputBytes:task.outputBytes,
            outputTruncated:task.outputTruncated,
            background:task.backgrounded||task.background||false,
          },
          verification:{
            status,
            ok:status==='passed',
            settled:true,
            commandFingerprint:fingerprint,
            exitCode,
            signal:result.signal||undefined,
            termination:result.termination,
            facts:[`verify:${status}:${fingerprint}`],
          },
        },
      }
    },
  }
}

async function detect(cwd:string){
  try{const p=JSON.parse(await fs.readFile(path.join(cwd,'package.json'),'utf8'));const s=p.scripts||{};if(s.test && s.test !== 'echo "Error: no test specified"' && !/^\s*exit\s+1/.test(s.test)) return 'npm test';if(s.check)return 'npm run check';if(s.build)return 'npm run build';if(s.typecheck)return 'npm run typecheck'}catch{}
  try{await fs.access(path.join(cwd,'Makefile'));return 'make test'}catch{}
  try{await fs.access(path.join(cwd,'pyproject.toml'));return 'python -m pytest'}catch{}
  try{await fs.access(path.join(cwd,'Cargo.toml'));return 'cargo test'}catch{}
  try{await fs.access(path.join(cwd,'go.mod'));return 'go test ./...'}catch{}
  return ''
}
