import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ensureDir } from '../util/fs.js'
import { analyzeSource, type FileAnalysis, type SymbolInfo } from './symbols.js'
import { estimateTokens } from './budget.js'
import { IGNORED_DIRECTORIES } from '../tools/filesystem-search.js'

const DEFAULT_IGNORES = new Set([...IGNORED_DIRECTORIES, 'coverage', '.turbo', '.termagent'])
const TEXT_EXTENSIONS = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.json','.jsonc','.md','.mdx','.txt','.yml','.yaml','.toml','.ini','.env','.sh','.bash','.zsh','.py','.pyi','.go','.rs','.java','.kt','.kts','.c','.h','.cc','.cpp','.hpp','.cs','.php','.rb','.swift','.sql','.html','.css','.scss','.sass','.vue','.svelte','.xml','.gradle','.properties'])
const IMPORTANT_FILES = new Set(['package.json','tsconfig.json','vite.config.ts','vite.config.js','next.config.js','next.config.mjs','README.md','AGENTS.md','CLAUDE.md','TERMAGENT.md','Cargo.toml','pyproject.toml','go.mod','pom.xml','build.gradle','Makefile','.env.example'])
const CACHE_VERSION=3

type CachedEntry = RepoFile & { analysis:FileAnalysis }
type CachePayload = { version:number; root:string; files:CachedEntry[]; savedAt:number }

export type RepoFile = { path:string; size:number; mtime:number; ctime:number; ext:string; kind:'source'|'config'|'doc'|'test'|'other'; structural:number; symbols:SymbolInfo[] }
export type RepoEdge = { from:string; to:string; weight:number; symbols:string[] }
export type RepositoryMap = {
  root:string
  generatedAt:number
  files:RepoFile[]
  languages:Record<string,number>
  important:string[]
  gitStatus:string[]
  summary:string
  edges:RepoEdge[]
  cache:{ hit:number; miss:number; path:string }
}

function kindOf(rel:string, ext:string):RepoFile['kind'] {
  const p=rel.toLowerCase()
  if(/(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$/.test(p)) return 'test'
  if(['.md','.mdx','.txt'].includes(ext) || /(^|\/)(readme|changelog)(\.|$)/i.test(p)) return 'doc'
  if(['.json','.jsonc','.yml','.yaml','.toml','.ini','.env','.config'].includes(ext) || IMPORTANT_FILES.has(path.basename(rel))) return 'config'
  if(TEXT_EXTENSIONS.has(ext)) return 'source'
  return 'other'
}

async function command(cmd:string,args:string[],cwd:string,timeoutMs=4000):Promise<string|null>{
  return await new Promise<string|null>(resolve=>{
    const child=spawn(cmd,args,{cwd,stdio:['ignore','pipe','ignore']})
    let out=''; let done=false
    const finish=(value:string|null)=>{if(done)return;done=true;clearTimeout(timer);resolve(value)}
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(null)},timeoutMs)
    child.stdout.on('data',(b:any)=>out+=b.toString())
    child.on('error',()=>finish(null)); child.on('close',(code:number|null)=>finish(code===0?out:null))
  })
}

async function fallbackFiles(root:string):Promise<string[]> {
  const out:string[]=[]
  async function walk(dir:string){
    for(const ent of await fs.readdir(dir,{withFileTypes:true})){
      if(DEFAULT_IGNORES.has(ent.name)) continue
      const full=path.join(dir,ent.name); const rel=path.relative(root,full)
      if(ent.isDirectory() && !ent.isSymbolicLink()) await walk(full)
      else if(ent.isFile() && out.length<20000) out.push(rel)
    }
  }
  await walk(root); return out
}

function isIgnoredPath(rel:string):boolean { const parts=rel.split(/[\\/]+/).filter(Boolean); return parts.some(p=>DEFAULT_IGNORES.has(p)) }

async function listFiles(root:string):Promise<string[]> {
  const git=await command('git',['ls-files','-z','--cached','--others','--exclude-standard','--recurse-submodules'],root,6000)
  if(git) return [...new Set(git.split('\0').filter(Boolean).filter(x=>!isIgnoredPath(x)))].slice(0,20000)
  const rgArgs=['--files','--hidden','--null']
  for(const ignored of DEFAULT_IGNORES) rgArgs.push('-g',`!${ignored}/**`)
  const rg=await command('rg',rgArgs,root,6000)
  if(rg) return [...new Set(rg.split('\0').filter(Boolean).filter(x=>!isIgnoredPath(x)))].slice(0,20000)
  return fallbackFiles(root)
}

async function gitStatus(root:string):Promise<string[]> {
  const out=await command('git',['status','--short'],root,3000)
  return out ? out.split(/\r?\n/).filter(Boolean).slice(0,80) : []
}

function cachePath(root:string):string {
  const digest=crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0,40)
  return path.join(process.env.HOME||process.cwd(),'.termagent','repomap-cache',`${digest}.json`)
}

async function readCache(file:string):Promise<CachePayload|undefined>{try{return JSON.parse(await fs.readFile(file,'utf8')) as CachePayload}catch{return undefined}}

async function writeCache(file:string,payload:CachePayload){await ensureDir(path.dirname(file));const tmp=`${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;await fs.writeFile(tmp,JSON.stringify(payload),'utf8');await fs.rename(tmp,file)}

function resolveImport(from:string,source:string,available:Set<string>):string|undefined {
  if(!source.startsWith('.')) return undefined
  const base=path.posix.normalize(path.posix.join(path.posix.dirname(from),source)).replace(/^\.\//,'')
  const direct=[base]
  const ext=path.posix.extname(base)
  if(!ext) direct.push(...['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py'].map(x=>base+x))
  else direct.push(base.replace(ext,'' )+'.ts',base.replace(ext,'')+'.js',base.replace(ext,'')+'.py')
  for(const item of [...direct,...['index.ts','index.tsx','index.js','index.jsx','index.mjs','index.cjs','index.py'].map(x=>path.posix.join(base,x))]) if(available.has(item)) return item
  return undefined
}

function resolvePythonImport(from:string,source:string,available:Set<string>):string|undefined {
  const dots=(source.match(/^\.+/)||[''])[0].length; const raw=source.slice(dots)
  const fromDir=path.posix.dirname(from).split('/').filter(Boolean)
  const baseParts=fromDir.slice(0,Math.max(0,fromDir.length-(dots-1))).concat(raw.split('.').filter(Boolean))
  const base=baseParts.join('/')
  const candidates=[`${base}.py`,path.posix.join(base,'__init__.py')]
  if(!raw)candidates.unshift(path.posix.join(fromDir.slice(0,Math.max(0,fromDir.length-(dots-1))).join('/'),'__init__.py'))
  for(const candidate of candidates) if(available.has(candidate)) return candidate
  return undefined
}

function buildEdges(files:CachedEntry[]):RepoEdge[] {
  const available=new Set(files.map(f=>f.path))
  const definitions=new Map<string,{file:string;kind:SymbolInfo['kind']}[]>()
  for(const f of files) for(const s of f.analysis.symbols){const list=definitions.get(s.name)||[];list.push({file:f.path,kind:s.kind});definitions.set(s.name,list)}
  const counts=new Map<string,{count:number;names:Set<string>}>()
  const importTargets=new Map<string,Map<string,string[]>>()
  for(const f of files){
    const names=new Map<string,string[]>()
    for(const imp of f.analysis.imports){
      const target=f.analysis.language==='python'?resolvePythonImport(f.path,imp.source,available):resolveImport(f.path,imp.source,available)
      if(!target)continue
      const list=names.get(imp.name)||[];if(!list.some(x=>x===target))list.push(target);names.set(imp.name,list)
      const key=`${f.path}=>${target}`;const entry=counts.get(key)||{count:0,names:new Set<string>()};entry.count++;entry.names.add(imp.name);counts.set(key,entry)
    }
    importTargets.set(f.path,names)
  }
  for(const f of files){
    const imports=importTargets.get(f.path)||new Map<string,string[]>()
    for(const ref of f.analysis.references.filter(r=>r.kind!=='import')){
      const targets=imports.get(ref.name)||[]
      for(const target of targets){
        const importedName=(f.analysis.imports.find(imp=>imp.name===ref.name&&importTargets.get(f.path)?.get(imp.name)?.includes(target))?.imported)||ref.name
        const defs=(definitions.get(importedName)||[]).filter(d=>d.file===target)
        if(defs.length||importedName==='default'||importedName==='*'){
          const key=`${f.path}=>${target}`;const entry=counts.get(key)||{count:0,names:new Set<string>()};entry.count+=0.35;entry.names.add(ref.name);counts.set(key,entry)
        }
      }
    }
  }
  const N=Math.max(1,files.length);const df=new Map<string,number>()
  for(const f of files){const names=new Set(f.analysis.references.map(r=>r.name));for(const name of names)df.set(name,(df.get(name)||0)+1)}
  const edges:RepoEdge[]=[]
  for(const [key,value] of counts){const [from,to]=key.split('=>');const names=[...value.names];let weight=value.count;for(const name of names){const idf=Math.log((N+1)/((df.get(name)||0)+1))+1;weight+=Math.max(0,value.count/names.length)*idf*0.75}edges.push({from,to,weight,symbols:names.slice(0,12)})}
  return edges
}

function structuralRank(paths:string[],edges:RepoEdge[]):Map<string,number>{
  const n=paths.length;const score=new Map(paths.map(p=>[p,1/Math.max(1,n)]));const outgoing=new Map<string,RepoEdge[]>();for(const e of edges){const a=outgoing.get(e.from)||[];a.push(e);outgoing.set(e.from,a)}
  for(let iter=0;iter<24;iter++){
    const next=new Map(paths.map(p=>[p,0.15/Math.max(1,n)]))
    for(const from of paths){const es=outgoing.get(from)||[];const total=es.reduce((s,e)=>s+e.weight,0);if(!total)continue;const base=score.get(from)||0;for(const e of es)next.set(e.to,(next.get(e.to)||0)+0.85*base*(e.weight/total))}
    for(const p of paths)score.set(p,next.get(p)||0)
  }
  const max=Math.max(...score.values(),1e-9)
  for(const p of paths)score.set(p,(score.get(p)||0)/max)
  return score
}

export async function invalidateRepositoryCache(root:string){await fs.rm(cachePath(root),{force:true})}

export async function buildRepositoryMap(root:string):Promise<RepositoryMap> {
  const cwd=path.resolve(root);const paths=await listFiles(cwd);const available=new Set(paths);const cacheFile=cachePath(cwd);const old=await readCache(cacheFile);const oldFiles=new Map((old?.version===CACHE_VERSION&&old.root===cwd?old.files:[]).map(f=>[f.path,f]))
  const files:CachedEntry[]=[];let hit=0,miss=0
  for(const rel of paths){
    const full=path.join(cwd,rel)
    try{
      const st=await fs.stat(full);if(!st.isFile())continue
      const ext=path.extname(rel).toLowerCase();const kind=kindOf(rel,ext);const prev=oldFiles.get(rel)
      if(prev&&prev.size===st.size&&Math.abs(prev.mtime-st.mtimeMs)<0.01&&Math.abs((prev.ctime??-1)-st.ctimeMs)<0.01&&prev.ext===ext&&prev.kind===kind&&prev.analysis){files.push(prev);hit++;continue}
      miss++
      let analysis:FileAnalysis={path:rel,language:'unknown',symbols:[],references:[],imports:[]}
      if(TEXT_EXTENSIONS.has(ext)){const data=await fs.readFile(full,'utf8');if(data.length<=2_000_000)analysis=analyzeSource(rel,data)}
      files.push({path:rel,size:st.size,mtime:st.mtimeMs,ctime:st.ctimeMs,ext,kind,structural:0,symbols:analysis.symbols,analysis})
    }catch{}
  }
  files.sort((a,b)=>a.path.localeCompare(b.path));const edges=buildEdges(files);const ranks=structuralRank(files.map(f=>f.path),edges);for(const f of files)f.structural=ranks.get(f.path)||0
  const languages:Record<string,number>={};const important:string[]=[]
  for(const f of files){if(f.kind==='source'||f.kind==='test')languages[f.ext||'<no extension>']=(languages[f.ext||'<no extension>']||0)+1;if(IMPORTANT_FILES.has(path.basename(f.path))||IMPORTANT_FILES.has(f.path))important.push(f.path)}
  const status=await gitStatus(cwd);const topLang=Object.entries(languages).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ');const symbolCount=files.reduce((n,f)=>n+f.symbols.length,0)
  const summary=`${files.length} searchable files; ${symbolCount} symbols; ${edges.length} reference edges; ${topLang||'no recognized source files'}; ${status.length} git changes`
  const payload:CachePayload={version:CACHE_VERSION,root:cwd,files:files.map(f=>({...f,analysis:f.analysis})),savedAt:Date.now()};await writeCache(cacheFile,payload).catch(()=>{})
  return {root:cwd,generatedAt:Date.now(),files:files.map(f=>({path:f.path,size:f.size,mtime:f.mtime,ctime:f.ctime,ext:f.ext,kind:f.kind,structural:f.structural,symbols:f.symbols})),languages,important:[...new Set(important)].sort(),gitStatus:status,summary,edges,cache:{hit,miss,path:cacheFile}}
}

export function formatRepositoryMap(map:RepositoryMap,maxPaths=140,maxTokens=2600,options:{focusFiles?:string[];focusSymbols?:string[]}={}):string {
  const focusFiles=new Set((options.focusFiles||[]).map(x=>x.toLowerCase()))
  const focusSymbols=new Set((options.focusSymbols||[]).map(x=>x.toLowerCase()))
  const selected=map.files.slice().sort((a,b)=>{
    const boost=(f:RepoFile)=>{
      let value=0
      if(focusFiles.has(f.path.toLowerCase()))value+=1000
      if(f.symbols.some(s=>focusSymbols.has(s.name.toLowerCase())))value+=700
      return value
    }
    return (boost(b)+b.structural*100)-(boost(a)+a.structural*100)||a.path.localeCompare(b.path)
  });const out:string[]=[];let used=0
  const push=(text:string)=>{const cost=estimateTokens(text);if(used+cost>maxTokens)return false;out.push(text);used+=cost;return true}
  push(`Repository: ${map.root}`);push(`Summary: ${map.summary}`);push(`Index cache: ${map.cache.hit} reused, ${map.cache.miss} parsed`)
  if(map.gitStatus.length)push(`Git changes:\n${map.gitStatus.map(x=>`- ${x}`).join('\n')}`)
  if(map.important.length)push(`Important files:\n${map.important.slice(0,30).map(x=>`- ${x}`).join('\n')}`)
  const lines:string[]=[]
  for(const f of selected){if(lines.length>=maxPaths)break;const sig=f.symbols.slice(0,6).map(s=>`${s.kind} ${s.name} @${s.line}`).join(', ');lines.push(`- ${f.path}${f.structural>0.2?` [struct:${f.structural.toFixed(2)}]`:''}${sig?` :: ${sig}`:''}`)}
  push(`Structural file map (${Math.min(lines.length,maxPaths)}/${map.files.length}):\n${lines.join('\n')}`)
  return out.join('\n\n')
}
