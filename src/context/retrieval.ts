import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { RepositoryMap, RepoFile } from './repository.js'
import { estimateTokens } from './budget.js'

const STOP=new Set('the a an and or to of in on for with from into is are was were be this that it as at by fix add update make use how why what where which does do can could should would about please project code file files'.split(' '))
const MAX_FILE_BYTES=16_000
const DEFAULT_TOTAL_TOKENS=7_000

function byteLength(text:string):number{return Buffer.byteLength(text,'utf8')}
function truncateUtf8(text:string,maxBytes:number):string{
  if(maxBytes<=0)return ''
  if(byteLength(text)<=maxBytes)return text
  let out='';let used=0
  for(const ch of text){const n=byteLength(ch);if(used+n>maxBytes)break;out+=ch;used+=n}
  return out
}

type SearchHit={path:string;lines:number[]}
type Candidate={file:RepoFile;score:number;hitLines:number[];contentHits:number;symbolHits:number}

function tokens(input:string):string[]{
  return input.toLowerCase().replace(/[^a-z0-9_./:-]+/g,' ').split(/\s+/).filter(t=>t.length>1&&!STOP.has(t)).slice(0,100)
}

function lexicalScore(file:RepoFile,queryTokens:string[]):number{
  const p=file.path.toLowerCase();const base=path.basename(p).toLowerCase();let s=0
  for(const t of queryTokens){
    if(p===t||base===t)s+=16
    else if(base.includes(t))s+=10
    else if(p.includes(t))s+=6
  }
  if(file.kind==='source')s+=2;if(file.kind==='test'&&queryTokens.some(t=>['test','bug','fix','error','fail'].includes(t)))s+=2;if(file.kind==='config')s+=1
  if(file.structural)s+=Math.min(5,file.structural*5)
  if(/^readme\.md$|^package\.json$|^tsconfig\.json$/.test(base))s+=2
  return s
}

function symbolScore(file:RepoFile,queryTokens:string[]):{score:number;hits:number[]}{
  let score=0;const hits:number[]=[]
  for(const symbol of file.symbols){const n=symbol.name.toLowerCase();for(const q of queryTokens){if(n===q){score+=24;hits.push(symbol.line)}else if(n.includes(q)||q.includes(n)){score+=11;hits.push(symbol.line)}}}
  return {score,hits:[...new Set(hits)].sort((a,b)=>a-b)}
}

function escapeRegex(input:string):string{return input.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}

async function lexicalSearch(root:string,queryTokens:string[]):Promise<SearchHit[]> {
  if(!queryTokens.length) return []
  const pattern=queryTokens.slice(0,24).map(escapeRegex).join('|')
  return await new Promise<SearchHit[]>(resolve=>{
    const child=spawn('rg',['-n','-i','--hidden','--no-heading','--color','never','-m','8','-g','!.git/**','-g','!node_modules/**','-g','!dist/**','-g','!build/**',pattern,'.'],{cwd:root,stdio:['ignore','pipe','ignore']})
    let out='';let done=false
    const finish=(hits:SearchHit[])=>{if(done)return;done=true;clearTimeout(timer);resolve(hits)}
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish([])},5000)
    child.stdout.on('data',(b:any)=>{out+=b.toString();if(out.length>180_000){child.kill('SIGTERM')}})
    child.on('error',()=>finish([]));child.on('close',(code:number|null)=>{
      if(code!==0&&code!==1){finish([]);return}
      const map=new Map<string,Set<number>>()
      for(const line of out.split(/\r?\n/)){
        const m=line.match(/^(.+?):(\d+):(.*)$/)
        if(!m)continue
        const rel=m[1].replace(/^\.\//,'');const n=Number(m[2]);const set=map.get(rel)||new Set<number>();set.add(n);map.set(rel,set)
      }
      finish([...map.entries()].slice(0,160).map(([p,lines])=>({path:p,lines:[...lines].sort((a,b)=>a-b)})))
    })
  })
}

function lineHits(text:string,queryTokens:string[]):number[]{const lines=text.split(/\r?\n/);const hits:number[]=[];for(let i=0;i<lines.length;i++){const lower=lines[i].toLowerCase();let matched=0;for(const t of queryTokens)if(lower.includes(t))matched++;if(matched)hits.push(i+1)}return hits}

async function excerpt(root:string,file:RepoFile,hits:number[],budgetBytes:number):Promise<string>{
  try{
    if(file.size>2_000_000||['.png','.jpg','.jpeg','.gif','.webp','.pdf'].includes(file.ext))return ''
    const text=(await fs.readFile(path.join(root,file.path),'utf8')).slice(0,MAX_FILE_BYTES*4);const lines=text.split(/\r?\n/);const centers=[...hits].slice(0,8);if(!centers.length)centers.push(1)
    const ranges:{start:number;end:number}[]=[]
    for(const c of centers){const start=Math.max(1,c-18),end=Math.min(lines.length,c+34);const prior=ranges.at(-1);if(prior&&start<=prior.end+2)prior.end=Math.max(prior.end,end);else ranges.push({start,end})}
    let out=''
    for(const r of ranges){const block=lines.slice(r.start-1,r.end).map((line:string,i:number)=>`${r.start+i}: ${line}`).join('\n');const next=out?`${out}\n…\n${block}`:block;if(byteLength(next)>budgetBytes)break;out=next}
    if(!out&&lines.length)out=truncateUtf8(lines.slice(0,Math.max(1,Math.floor(budgetBytes/32))).map((line:string,i:number)=>`${i+1}: ${line}`).join('\n'),budgetBytes)
    return out.slice(0,budgetBytes)
  }catch{return ''}
}

export type RetrievalOptions={maxFiles?:number;maxBytes?:number;maxTokens?:number;focusFiles?:string[];focusSymbols?:string[]}

export async function retrieveContext(map:RepositoryMap,query:string,opts:RetrievalOptions={}):Promise<string>{
  const maxFiles=Math.max(1,opts.maxFiles??6)
  const tokenBudget=Math.max(300,opts.maxTokens??(opts.maxBytes?Math.floor(opts.maxBytes/4):DEFAULT_TOTAL_TOKENS))
  const byteBudget=Math.max(300,Math.min(opts.maxBytes??tokenBudget*4,tokenBudget*4))
  const qs=tokens(query);const focusFiles=new Set((opts.focusFiles||[]).map(x=>x.toLowerCase()));const focusSymbols=new Set((opts.focusSymbols||[]).map(x=>x.toLowerCase()))
  const contentHits=await lexicalSearch(map.root,qs)
  const contentMap=new Map(contentHits.map(h=>[h.path,h]))
  const scored:Candidate[]=map.files.map(file=>{
    const lexical=lexicalScore(file,qs);const sym=symbolScore(file,qs);const hit=contentMap.get(file.path);let boost=hit?(10+Math.min(18,hit.lines.length*2)):0;let focus=0
    if(focusFiles.has(file.path.toLowerCase()))focus+=40
    if(sym.hits.some(h=>focusSymbols.has(file.symbols.find(s=>s.line===h)?.name.toLowerCase()||'')))focus+=32
    return {file,score:lexical+sym.score+boost+focus+file.structural*4,hitLines:[...sym.hits,...(hit?.lines||[])],contentHits:hit?.lines.length||0,symbolHits:sym.hits.length}
  }).filter(x=>x.score>0||focusFiles.has(x.file.path.toLowerCase()))
  scored.sort((a,b)=>b.score-a.score||b.file.structural-a.file.structural||a.file.path.localeCompare(b.file.path))
  const chosen=scored.slice(0,Math.max(maxFiles*4,24))
  const graphBoost=new Map<string,number>()
  for(const item of chosen.slice(0,maxFiles))for(const edge of map.edges.filter(e=>e.from===item.file.path||e.to===item.file.path)){graphBoost.set(edge.from,(graphBoost.get(edge.from)||0)+edge.weight);graphBoost.set(edge.to,(graphBoost.get(edge.to)||0)+edge.weight)}
  chosen.sort((a,b)=>(b.score+(graphBoost.get(b.file.path)||0)*0.8)-(a.score+(graphBoost.get(a.file.path)||0)*0.8)||b.file.structural-a.file.structural||a.file.path.localeCompare(b.file.path))
  const sections:string[]=[];let usedBytes=0
  for(const item of chosen){
    if(sections.length>=maxFiles||usedBytes>=byteBudget)break
    const raw=await fs.readFile(path.join(map.root,item.file.path),'utf8').catch(()=>null);if(raw===null)continue
    const hits=[...new Set([...item.hitLines,...lineHits(raw,qs)])].sort((a,b)=>a-b);const remain=Math.max(180,byteBudget-usedBytes-96);const body=await excerpt(map.root,item.file,[...hits].slice(0,8),Math.min(MAX_FILE_BYTES,remain));if(!body)continue
    const why=item.symbolHits?`symbol match; `:''
    const label=`${why}${item.contentHits?'content match; ':''}structural ${item.file.structural.toFixed(2)}`
    const section=`### ${item.file.path} (${label.trim()})\n${body}`
    const prospective=`Relevant repository context (lexical + structural retrieval; verify with tools):\n\n${[...sections,section].join('\n\n')}`
    if(estimateTokens(prospective)>tokenBudget||byteLength(prospective)>byteBudget){if(sections.length)break;sections.push(truncateUtf8(section,Math.max(100,byteBudget-90)));usedBytes=byteBudget;break}
    sections.push(section);usedBytes=prospective.length
  }
  if(!sections.length)return ''
  return truncateUtf8(`Relevant repository context (lexical + structural retrieval; verify with tools):\n\n${sections.join('\n\n')}`,byteBudget)
}
