import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildRepositoryMap, formatRepositoryMap } from '../dist/context/repository.js'
import { retrieveContext } from '../dist/context/retrieval.js'

test('repository map discovers project structure and git changes', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-context-'))
  await mkdir(path.join(root,'src'))
  await mkdir(path.join(root,'node_modules','ignored'),{recursive:true})
  await writeFile(path.join(root,'package.json'),'{}')
  await writeFile(path.join(root,'src','auth.ts'),'export function login(token) { return token }\n')
  await writeFile(path.join(root,'node_modules','ignored','x.js'),'ignored')
  const map=await buildRepositoryMap(root)
  assert.ok(map.files.some(f=>f.path==='src/auth.ts'))
  assert.ok(!map.files.some(f=>f.path.includes('node_modules')))
  assert.ok(map.important.includes('package.json'))
  assert.match(formatRepositoryMap(map),/src\/auth\.ts/)
  await rm(root,{recursive:true,force:true})
})

test('retrieval ranks relevant files and returns bounded excerpts', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-retrieval-'))
  await mkdir(path.join(root,'src'))
  await writeFile(path.join(root,'src','auth.ts'),'export function authenticateUser(token:string) { return token.length > 0 }\n')
  await writeFile(path.join(root,'src','math.ts'),'export function add(a:number,b:number) { return a+b }\n')
  const map=await buildRepositoryMap(root)
  const ctx=await retrieveContext(map,'fix authenticateUser token validation',{maxFiles:2,maxBytes:1000})
  assert.match(ctx,/src\/auth\.ts/)
  assert.ok(ctx.length<=1200)
  await rm(root,{recursive:true,force:true})
})
