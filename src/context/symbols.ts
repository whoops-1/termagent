import path from 'node:path'

export type SymbolKind = 'function'|'class'|'interface'|'type'|'enum'|'variable'|'method'
export type Reference = { name:string; line:number; kind:'import'|'call'|'usage' }
export type SymbolInfo = { name:string; kind:SymbolKind; line:number; signature:string }
export type FileAnalysis = {
  path:string
  language:'typescript'|'javascript'|'python'|'unknown'
  symbols:SymbolInfo[]
  references:Reference[]
  imports:{ name:string; source:string; imported?:string }[]
}

const JS_EXTS = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs'])
const PY_EXTS = new Set(['.py'])
const MAX_SYMBOLS_PER_FILE=1000
const MAX_REFERENCES_PER_FILE=4000
const MAX_IMPORTS_PER_FILE=400

function languageFor(file:string):FileAnalysis['language'] {
  const ext=path.extname(file).toLowerCase()
  if(JS_EXTS.has(ext)) return ext.startsWith('.ts') ? 'typescript' : 'javascript'
  if(PY_EXTS.has(ext)) return 'python'
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

export function analyzeSource(file:string,text:string):FileAnalysis {
  const language=languageFor(file)
  if(language==='typescript'||language==='javascript'){const result=analyzeJavaScript(text);result.path=file;result.language=language;return result}
  if(language==='python'){const result=analyzePython(text);result.path=file;return result}
  return {path:file,language,symbols:[],references:[],imports:[]}
}

export function symbolLineMap(analysis:FileAnalysis):Map<number,SymbolInfo>{
  return new Map(analysis.symbols.map(s=>[s.line,s]))
}
