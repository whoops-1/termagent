#!/usr/bin/env node
import process from 'node:process'
import { start } from './cli/repl.js'
import { VERSION } from './version.js'
import { doctor } from './doctor.js'

const args=process.argv.slice(2)
const value=(flag:string)=>{const i=args.indexOf(flag);return i>=0?args[i+1]:undefined}
const resume=value('--resume')
if(args.includes('--version')){console.log(VERSION);process.exit(0)}
if(args.includes('--doctor')){try{const report=await doctor(process.cwd());if(args.includes('--json')){console.log(JSON.stringify(report,null,2))}else{for(const group of ['environment','configuration','migration','marketplaces','plugins','skills','storage']){const rows=report.checks.filter(item=>item.group===group);if(!rows.length)continue;console.log(`\n${group.toUpperCase()}`);for(const item of rows){console.log(`${item.status==='ok'?'✓':item.status==='warn'?'!':'✗'} ${item.label}: ${item.value}${item.detail?` · ${item.detail}`:''}`);if(item.remediation)console.log(`  → ${item.remediation}`)}} console.log(`\ndoctor: ${report.counts.ok} ok · ${report.counts.warn} warnings · ${report.counts.error} errors`)} process.exit(report.ok?0:1)}catch(e){console.error(e instanceof Error ? e.stack || e.message : String(e));process.exit(1)} }
if(args.includes('--help')){console.log('termagent [--resume <id>] [--doctor [--json]] [--serve] [--host <host>] [--port <port>] [--token <token>] [--task-worker <id>] [--version]\n\nInteractive: raw terminal editor with multiline input, history, paste, completion, and keyboard shortcuts\nServer: lightweight HTTP/SSE API on localhost') ;process.exit(0)}
if(args.includes('--task-worker')){const id=value('--task-worker');import('./tasks/worker.js').then(m=>m.runTaskWorker(id!)).catch(e=>{console.error(e?.stack||e);process.exitCode=1})}
else if(args.includes('--serve')){import('./server/index.js').then(m=>m.serve(process.cwd(),{host:value('--host')||process.env.TERMAGENT_SERVER_HOST||'127.0.0.1',port:Number(value('--port')||process.env.TERMAGENT_SERVER_PORT||4096),token:value('--token')||process.env.TERMAGENT_SERVER_TOKEN})).catch(e=>{console.error(e?.stack||e);process.exit(1)})}
else start(process.cwd(),resume).catch(e=>{console.error(e?.stack||e);process.exit(1)})
