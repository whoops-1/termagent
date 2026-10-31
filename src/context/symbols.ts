import path from 'node:path'

export type SymbolKind = 'function'|'class'|'interface'|'type'|'enum'|'variable'|'method'|'heading'
export type Reference = { name:string; line:number; kind:'import'|'call'|'usage' }
export type SymbolInfo = { name:string; kind:SymbolKind; line:number; signature:string }
export type FileAnalysis = {
  path:string
  language:'typescript'|'javascript'|'python'|'json'|'yaml'|'unknown'
  symbols:SymbolInfo[]
  references:Reference[]
  imports:{ name:string; source:string; imported?:string }[]
}

const JS_EXTS = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs'])
const PY_EXTS = new Set(['.py'])
const JSON_EXTS = new Set(['.json','.jsonc'])
const YAML_EXTS = new Set(['.yaml','.yml'])
const MAX_SYMBOLS_PER_FILE=1000
const MAX_REFERENCES_PER_FILE=4000
const MAX_IMPORTS_PER_FILE=400

function languageFor(file:string):FileAnalysis['language'] {
  const ext=path.extname(file).toLowerCase()
  if(JS_EXTS.has(ext)) return ext.startsWith('.ts') ? 'typescript' : 'javascript'
  if(PY_EXTS.has(ext)) return 'python'
  if(JSON_EXTS.has(ext)) return 'json'
  if(YAML_EXTS.has(ext)) return 'yaml'
  return 'unknown'
}

function cleanSignature(line:string):string {
  return line.trim().replace(/\s+/g,' ').slice(0,240)
}

function addSymbol(symbols:SymbolInfo[], seen:Set<string>, symbol:SymbolInfo){
  const key=`${symbol.kind}:${symbol.name}:${symbol.line}`
  if(!seen.has(key)){seen.add(key);symbols.push(symbol)}
}

function analyzeJavaScript(text:string):FileAnalysis {
  const symbols:SymbolInfo[]=[]; const references:Reference[]=[]; const imports:{name:string;source:string;imported?:string}[]=[]; const seen=new Set<string>()
  const lines=text.split(/\r?\n/)
  const addImport=(name:string,source:string,imported:string)=>{if(!name)return;imports.push({name,source,imported});references.push({name,line:currentImportLine,kind:'import'})}
  let currentImportLine=0
  const exportRe=/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
  const declRe=/^\s*(?:(?:export|declare|abstract|public|private|protected|static|async)\s+)*(function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
  const varRe=/^\s*(?:(?:export|const|let|var)\s+)([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
  for(let i=0;i<lines.length;i++){
    const line=lines[i]; currentImportLine=i+1
    const sideEffect=line.match(/^\s*import\s*["']([^"']+)["']/)
    if(sideEffect){addImport('*',sideEffect[1],'*');continue}
    const im=line.match(/^\s*import\s+(.+?)\s+from\s*["']([^"']+)["']/)
    if(im){
      const clause=im[1].trim().replace(/^type\s+/,''); const source=im[2]
      if(clause.startsWith('{')&&clause.endsWith('}')){
        for(const item of clause.slice(1,-1).split(',')){const parts=item.trim().replace(/^type\s+/,'').split(/\s+as\s+/).map(x=>x.trim());const imported=parts[0];const name=parts.at(-1)||'';if(/^[$A-Za-z_][\w$]*$/.test(name))addImport(name,source,imported)}
      } else if(clause.startsWith('*')){
        const m=clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);if(m)addImport(m[1],source,'*')
      } else {
        const comma=clause.indexOf(',')
        const first=(comma<0?clause:clause.slice(0,comma)).trim()
        if(/^[A-Za-z_$][\w$]*$/.test(first))addImport(first,source,'default')
        if(comma>=0){const rest=clause.slice(comma+1).trim();if(rest.startsWith('{')&&rest.endsWith('}'))for(const item of rest.slice(1,-1).split(',')){const parts=item.trim().replace(/^type\s+/,'').split(/\s+as\s+/).map(x=>x.trim());const imported=parts[0];const name=parts.at(-1)||'';if(/^[$A-Za-z_][\w$]*$/.test(name))addImport(name,source,imported)}
        }
      }
      continue
    }
    const req=line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/)
    if(req){addImport(req[1],req[2],'*');continue}
    const destructReq=line.match(/^\s*(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/)
    if(destructReq){for(const item of destructReq[1].split(',')){const parts=item.trim().split(/\s*:\s*/).map(x=>x.trim());const imported=parts[0];const name=parts.at(-1)||'';if(/^[$A-Za-z_][\w$]*$/.test(name)&&/^[$A-Za-z_][\w$]*$/.test(imported))addImport(name,destructReq[2],imported)}continue}
    const ex=line.match(exportRe); const decl=line.match(declRe)
    if(ex) addSymbol(symbols,seen,{name:ex[1],kind:(line.match(/\b(class|interface|type|enum|function)\b/)?.[1] as SymbolKind)||'function',line:i+1,signature:cleanSignature(line)})
    else if(decl) addSymbol(symbols,seen,{name:decl[2],kind:decl[1] as SymbolKind,line:i+1,signature:cleanSignature(line)})
    const vr=line.match(varRe); if(vr) addSymbol(symbols,seen,{name:vr[1],kind:'function',line:i+1,signature:cleanSignature(line)})
    const method=line.match(/^\s*(?:public|private|protected|static|async|get|set)?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/)
    if(method && !['if','for','while','switch','catch','function'].includes(method[1])) addSymbol(symbols,seen,{name:method[1],kind:'method',line:i+1,signature:cleanSignature(line)})
  }
  const symbolNames=new Set([...symbols.map(s=>s.name),...imports.map(i=>i.name)])
  if(symbolNames.size){
    const usageRe=/\b[A-Za-z_$][\w$]*\b/g
    for(let i=0;i<lines.length;i++){
      for(const m of lines[i].matchAll(usageRe)){
        const name=m[0]; if(!symbolNames.has(name)) continue
        if(symbols.some(s=>s.name===name&&s.line===i+1)) continue
        if(imports.some(imp=>imp.name===name&&references.some(r=>r.name===name&&r.line===i+1&&r.kind==='import'))) continue
        references.push({name,line:i+1,kind:lines[i].includes(`${name}(`)?'call':'usage'})
      }
    }
  }
  for(const m of text.matchAll(/^\s*export\s+\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["']/gm)){
    for(const item of m[1].split(',')){const parts=item.trim().replace(/^type\s+/,'').split(/\s+as\s+/).map(x=>x.trim()); const imported=parts[0]; const name=parts.at(-1); if(name&&imported){imports.push({name,source:m[2],imported});}}
  }
  return {path:'',language:languageFor('.ts'),symbols:symbols.slice(0,MAX_SYMBOLS_PER_FILE),references:references.slice(0,MAX_REFERENCES_PER_FILE),imports:imports.slice(0,MAX_IMPORTS_PER_FILE)}
}

function analyzePython(text:string):FileAnalysis {
  const symbols:SymbolInfo[]=[]; const references:Reference[]=[]; const imports:{name:string;source:string;imported?:string}[]=[]; const seen=new Set<string>()
  const lines=text.split(/\r?\n/)
  const defRe=/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*)$/
  const classRe=/^\s*class\s+([A-Za-z_]\w*)\b(.*)$/
  const fromRe=/^\s*from\s+([.A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?\s*import\s+(.+)$/
  const importRe=/^\s*import\s+(.+)$/
  for(let i=0;i<lines.length;i++){
    const line=lines[i]
    const d=line.match(defRe); if(d)addSymbol(symbols,seen,{name:d[1],kind:'function',line:i+1,signature:cleanSignature(line)})
    const c=line.match(classRe); if(c)addSymbol(symbols,seen,{name:c[1],kind:'class',line:i+1,signature:cleanSignature(line)})
    const fr=line.match(fromRe)
    if(fr){const source=fr[1]||'.';for(const part of fr[2].split(',')){const raw=part.trim().split(/\s+as\s+/);const name=raw.at(-1)!.trim();if(name&&/^\w+$/.test(name)){imports.push({name,source,imported:raw[0]});references.push({name,line:i+1,kind:'import'})}}}
    const ir=line.match(importRe); if(ir){for(const part of ir[1].split(',')){const raw=part.trim().split(/\s+as\s+/);const name=(raw.at(-1)||raw[0]).trim().split('.')[0];if(name)imports.push({name,source:raw[0].trim(),imported:raw[0].trim()})}}
  }
  const symbolNames=new Set(symbols.map(s=>s.name))
  if(symbolNames.size){
    const usageRe=/\b[A-Za-z_]\w*\b/g
    for(let i=0;i<lines.length;i++)for(const m of lines[i].matchAll(usageRe)){const name=m[0];if(!symbolNames.has(name))continue;if(symbols.some(s=>s.name===name&&s.line===i+1))continue;references.push({name,line:i+1,kind:lines[i].includes(`${name}(`)?'call':'usage'})}
  }
  return {path:'',language:'python',symbols:symbols.slice(0,MAX_SYMBOLS_PER_FILE),references:references.slice(0,MAX_REFERENCES_PER_FILE),imports:imports.slice(0,MAX_IMPORTS_PER_FILE)}
}

function stripJsonComments(text:string):string {
  const out:string[]=[]; let i=0; const n=text.length; let inStr=false; let esc=false
  while(i<n){
    const ch=text[i]
    if(inStr){
      out.push(ch)
      if(esc)esc=false
      else if(ch==='\\')esc=true
      else if(ch==='"')inStr=false
      i++; continue
    }
    if(ch==='"'){inStr=true;out.push(ch);i++;continue}
    if(ch==='/'&&text[i+1]==='/'){while(i<n&&text[i]!=='\n')i++;continue}
    if(ch==='/'&&text[i+1]==='*'){i+=2;while(i+1<n&&!(text[i]==='*'&&text[i+1]==='/'))i++;i+=2;continue}
    out.push(ch);i++
  }
  return out.join('')
}

function lineIndexForOffset(lineOffsets:number[],offset:number):number {
  let lo=0,hi=lineOffsets.length-1
  while(lo<hi){const mid=(lo+hi+1)>>1;if(lineOffsets[mid]!<=offset)lo=mid;else hi=mid-1}
  return lo
}

function analyzeJson(text:string):FileAnalysis {
  const clean=stripJsonComments(text)
  const lineOffsets:number[]=[];let offset=0
  for(const line of clean.split('\n')){lineOffsets.push(offset);offset+=line.length+1}
  const symbols:SymbolInfo[]=[];const seen=new Set<string>()
  let depth=0;let i=0;const n=clean.length;let inStr=false;let esc=false
  while(i<n){
    const ch=clean[i]
    if(inStr){
      if(esc)esc=false
      else if(ch==='\\')esc=true
      else if(ch==='"')inStr=false
      i++;continue
    }
    if(ch==='"'){
      let j=i+1;let key='';let e=false
      while(j<n){const c=clean[j];if(e){key+=c;e=false}else if(c==='\\')e=true;else if(c==='"')break;else key+=c;j++}
      let k=j+1;while(k<n&&/\s/.test(clean[k]))k++
      if(clean[k]===':'&&depth===1&&key&&!seen.has(key)){
        seen.add(key)
        symbols.push({name:key,kind:'variable',line:lineIndexForOffset(lineOffsets,i)+1,signature:cleanSignature(`${key}:`)})
      }
      i=j+1;continue
    }
    if(ch==='{'||ch==='[')depth++
    else if(ch==='}'||ch===']')depth--
    i++
  }
  return {path:'',language:'json',symbols:symbols.slice(0,MAX_SYMBOLS_PER_FILE),references:[],imports:[]}
}

function analyzeYaml(text:string):FileAnalysis {
  const symbols:SymbolInfo[]=[];const seen=new Set<string>()
  const lines=text.split(/\r?\n/)
  const keyRe=/^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s|$)/
  for(let i=0;i<lines.length;i++){
    const line=lines[i]
    if(!line.trim()||line.startsWith(' '))continue
    if(line.startsWith('-')||line.startsWith('?')||line.startsWith('---')||line.startsWith('...'))continue
    const m=line.match(keyRe)
    if(m&&!seen.has(m[1]!)){seen.add(m[1]!);symbols.push({name:m[1]!,kind:'variable',line:i+1,signature:cleanSignature(`${m[1]}:`)})}
  }
  return {path:'',language:'yaml',symbols:symbols.slice(0,MAX_SYMBOLS_PER_FILE),references:[],imports:[]}
}

function analyzeMarkdown(text:string):FileAnalysis {
  const symbols:SymbolInfo[]=[]; const seen=new Set<string>()
  const lines=text.split(/\r?\n/)
  const headingRe=/^(#{1,6})\s+(.+?)\s*#*\s*$/
  for(let i=0;i<lines.length;i++){
    const line=lines[i]
    const heading=line.match(headingRe)
    if(!heading) continue
    const raw=heading[2]!.trim()
    const name=raw.replace(/[*_`]/g,'').replace(/\s+/g,' ')
    if(!name) continue
    addSymbol(symbols,seen,{name,kind:'heading',line:i+1,signature:cleanSignature(`# ${name}`)})
  }
  return {path:'',language:'unknown',symbols:symbols.slice(0,MAX_SYMBOLS_PER_FILE),references:[],imports:[]}
}

export function analyzeSource(file:string,text:string):FileAnalysis {
  const language=languageFor(file)
  if(language==='typescript'||language==='javascript'){const result=analyzeJavaScript(text);result.path=file;result.language=language;return result}
  if(language==='python'){const result=analyzePython(text);result.path=file;return result}
  if(language==='json'){const result=analyzeJson(text);result.path=file;return result}
  if(language==='yaml'){const result=analyzeYaml(text);result.path=file;return result}
  const ext=path.extname(file).toLowerCase()
  if(ext==='.md'||ext==='.mdx'){const result=analyzeMarkdown(text);result.path=file;return result}
  return {path:file,language,symbols:[],references:[],imports:[]}
}

export function symbolLineMap(analysis:FileAnalysis):Map<number,SymbolInfo>{
  return new Map(analysis.symbols.map(s=>[s.line,s]))
}
