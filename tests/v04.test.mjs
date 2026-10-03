import test from 'node:test'
import assert from 'node:assert/strict'
import { compactMessages, estimateTokens } from '../dist/agent/compaction.js'
import { SessionStore } from '../dist/session/store.js'
import { ProviderRouter } from '../dist/providers/router.js'
import { withRetry } from '../dist/agent/retry.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('compaction keeps system and recent messages under budget',()=>{const ms=[{role:'system',content:'sys'},...Array.from({length:20},(_,i)=>({role:'user',content:'x'.repeat(300)+i}))];const c=compactMessages(ms,500);assert.ok(estimateTokens(c.messages)<=500);assert.ok(c.removed>0);assert.equal(c.messages[0].role,'system')})
test('session fork copies history without sharing file',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ta-'));const s=new SessionStore(dir);const a=await s.create(dir,'m');await s.append(a.id,{type:'message',ts:1,data:{role:'user',content:'one'}});await s.append(a.id,{type:'message',ts:2,data:{role:'assistant',content:'two'}});const b=await s.fork(a.id,1);const x=await s.load(b.id);assert.equal(x.messages.length,1);assert.equal(x.meta.parentId,a.id)})
test('provider router falls back after provider failure',async()=>{const bad={id:'bad',model:'x',async *stream(){throw new Error('down')}};const good={id:'good',model:'y',async *stream(){yield {type:'text',delta:'ok'};yield {type:'done'}}};const r=new ProviderRouter([bad,good]);let out='';for await(const e of r.stream([],[],new AbortController().signal))if(e.type==='text')out+=e.delta;assert.equal(out,'ok')})
test('retry retries transient errors and succeeds',async()=>{let n=0;const out=await withRetry(async()=>{n++;if(n<3){const e=new Error('temporary failure');e.status=503;throw e}return 42},{max:3});assert.equal(out,42);assert.equal(n,3)})
