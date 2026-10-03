import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { within } from '../util/fs.js'
import { DEFAULT_DIRECTORY_PAGE, DEFAULT_GLOB_RESULTS, DEFAULT_SEARCH_RESULTS, globFiles, listDirectoryPage, searchText } from './filesystem-search.js'
import type { ToolDefinition } from './types.js'
import { FileReadStateCache, mergeReadRanges } from './file-state.js'
import { TaskManager } from '../tasks/manager.js'
import { startManagedShell, looksInteractiveLikely } from '../tasks/shell-command.js'
import { analyzeGitArgs } from './git-policy.js'
import { ToolOutputStore, parseToolOutputReference } from '../agent/tool-output-store.js'
import { buildRepositoryMap, formatRepositoryMap } from '../context/repository.js'
import { renderTextDiff } from '../diff/render.js'
import { applyPatchTool } from './apply-patch.js'
import {
  convertLineEndings,
  createFileExclusive,
  decodeUtf8Text,
  encodeText,
  hashBytes,
  normalizeLineEndings,
  readMutationBytes,
  stripUtf8Bom,
  withFileMutationLock,
  writeIfUnchanged,
} from './file-mutation.js'

const DEFAULT_READ_LIMIT = 2000
const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2000
const SAMPLE_BYTES = 4096
const BINARY_EXTENSIONS = new Set(['.zip','.tar','.gz','.bz2','.xz','.7z','.rar','.exe','.dll','.so','.dylib','.class','.jar','.war','.o','.a','.obj','.lib','.wasm','.pyc','.pyo','.bin','.dat','.doc','.docx','.xls','.xlsx','.ppt','.pptx'])

async function inspectTextFile(p: string) {
  const handle = await fs.open(p, 'r')
  try {
    const sample = Buffer.alloc(SAMPLE_BYTES)
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
    const bytes = sample.subarray(0, bytesRead)
    const ext = path.extname(p).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) throw new Error(`This tool cannot read binary files (${ext}). Use an appropriate binary analysis tool.`)
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) throw new Error('Unsupported text encoding: UTF-16 files must be converted to UTF-8 before using read_file.')
    if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) throw new Error('Unsupported text encoding: UTF-32 files must be converted to UTF-8 before using read_file.')
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) throw new Error('Unsupported text encoding: UTF-32 files must be converted to UTF-8 before using read_file.')
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('Unsupported text encoding: file is not valid UTF-8.') }
    if (bytes.some((value:number) => value === 0 || value < 9 || (value > 13 && value < 32))) {
      let control = 0
      for (const value of bytes) if (value === 0 || value < 9 || (value > 13 && value < 32)) control++
      if (bytes.length > 0 && control / bytes.length > 0.3) throw new Error('This tool cannot read the file as text because it appears to be binary.')
    }
  } finally { await handle.close() }
}

function requestedReadRange(startLine: unknown, endLine: unknown) {
  const start = Math.max(1, Math.floor(Number(startLine) || 1))
  const requestedEnd = endLine === undefined ? start + DEFAULT_READ_LIMIT - 1 : Math.floor(Number(endLine) || start)
  return { startLine: start, endLine: Math.min(start + MAX_READ_LINES - 1, Math.max(start, requestedEnd)) }
}

async function readLinesWithRanges(p: string, ranges: Array<{startLine:number;endLine:number}>, signal: AbortSignal) {
  const wanted = mergeReadRanges(ranges)
  if (!wanted.length) return { totalLines: 0, lines: [] as Array<{line:number;text:string}>, contentHash: hashBytes(Buffer.alloc(0)), bom: false, lineEnding: 'LF' as const, truncatedLineCount: 0 }
  const stream = createReadStream(p, { signal })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const digest = crypto.createHash('sha256')
  let carry = ''
  let lineNumber = 0
  let crlfCount = 0
  let lfCount = 0
  let truncatedLineCount = 0
  let firstChunk = true
  let bom = false
  const lines: Array<{line:number;text:string}> = []
  const isWanted = (n:number) => wanted.some(r => n >= r.startLine && n <= r.endLine)
  const consume = (raw:string) => {
    const isCrlf = raw.endsWith('\r')
    const text = isCrlf ? raw.slice(0,-1) : raw
    if (isCrlf) crlfCount++
    else lfCount++
    lineNumber += 1
    if (!isWanted(lineNumber)) return
    if (text.length > MAX_LINE_LENGTH) {
      truncatedLineCount++
      lines.push({ line: lineNumber, text: `${text.slice(0, MAX_LINE_LENGTH)} …[line truncated]` })
    } else {
      lines.push({ line: lineNumber, text })
    }
  }
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    digest.update(buffer)
    let text = decoder.decode(buffer, { stream: true })
    if (firstChunk) {
      firstChunk = false
      bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      if (text.startsWith('\uFEFF')) text = text.slice(1)
    }
    carry += text
    let index = carry.indexOf('\n')
    while (index >= 0) {
      consume(carry.slice(0,index))
      carry = carry.slice(index+1)
      index = carry.indexOf('\n')
    }
  }
  const tail = decoder.decode()
  if (tail) carry += tail
  if (carry.length > 0) consume(carry)
  return {
    totalLines: lineNumber,
    lines,
    contentHash: digest.digest('hex'),
    bom,
    lineEnding: crlfCount > lfCount ? 'CRLF' as const : 'LF' as const,
    truncatedLineCount,
  }
}

function formatBoundedLines(lines: Array<{line:number;text:string}>) {
  const rendered = lines.map(item => `${item.line}: ${item.text}`)
  const byteLength = (items: string[]) => Buffer.byteLength(items.join('\n'), 'utf8')
  if (byteLength(rendered) <= MAX_READ_BYTES) return { content: rendered.join('\n'), truncated: false, kept: lines }

  const head: Array<{line:number;text:string}> = []
  let headBytes = 0
  for (const item of lines) {
    const row = `${item.line}: ${item.text}`
    const next = headBytes + Buffer.byteLength(row, 'utf8') + (head.length ? 1 : 0)
    if (next > Math.floor(MAX_READ_BYTES * 0.62)) break
    head.push(item); headBytes = next
  }
  const tail: Array<{line:number;text:string}> = []
  let tailBytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const item = lines[i]!
    const row = `${item.line}: ${item.text}`
    const next = tailBytes + Buffer.byteLength(row, 'utf8') + (tail.length ? 1 : 0)
    if (next > Math.floor(MAX_READ_BYTES * 0.34)) break
    tail.unshift(item); tailBytes = next
  }
  const kept = [...head, ...tail.filter(item => !head.some(h => h.line === item.line))]
  return { content: `${head.map(item=>`${item.line}: ${item.text}`).join('\n')}\n…[middle truncated; read a smaller range to continue]…\n${tail.map(item=>`${item.line}: ${item.text}`).join('\n')}`, truncated: true, kept }
}

function countOccurrences(text: string, search: string) {
  let count=0
  let offset=0
  while ((offset=text.indexOf(search,offset))!==-1) { count++; offset+=search.length }
  return count
}

function countTextLines(text: string) {
  const normalized = normalizeLineEndings(text)
  if (!normalized) return 0
  return normalized.endsWith('\n') ? normalized.split('\n').length - 1 : normalized.split('\n').length
}

function safePath(cwd: string, p: string, scopePaths?: string[]) { const target = path.resolve(cwd, p); if (!within(cwd, target)) throw new Error(`Path escapes project: ${p}`); if(scopePaths?.length){ const allowed=scopePaths.some(scope=>within(path.resolve(cwd,scope),target)); if(!allowed) throw new Error(`Path is outside the agent workspace scope: ${p}`) } return target }
async function run(cmd: string, args: string[], cwd: string, timeout: number, max: number, signal?: AbortSignal) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore','pipe','pipe'], signal })
    let out = ''; let err = ''
    const add = (s: string) => { if (out.length < max) out += s.slice(0, max-out.length) }
    child.stdout.on('data', (b:any) => add(b.toString()))
    child.stderr.on('data', (b:any) => { if (err.length < max) err += b.toString().slice(0, max-err.length) })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Command timed out after ${timeout}ms`)) }, timeout)
    child.on('error', reject)
    child.on('close', (code:any) => { clearTimeout(timer); resolve(`exit=${code}\n${out}${err ? `\n[stderr]\n${err}` : ''}`) })
  })
}

export function builtinTools(opts: { timeout: number; maxOutput: number; toolOutputMaxLines?: number; toolOutputMaxBytes?: number; toolOutputRetentionDays?: number }): ToolDefinition[] {
  const toolOutputStore = new ToolOutputStore({maxLines:opts.toolOutputMaxLines,maxBytes:opts.toolOutputMaxBytes,retentionDays:opts.toolOutputRetentionDays})
  const read: ToolDefinition = {
    name:'read_file',
    risk:'read',
    parallelSafe:true,
    description:'Read a UTF-8 text file by 1-based line range, or page through a directory listing. Large file reads and directory listings are bounded and return continuation metadata; repeated unchanged file ranges use the session read-state cache.',
    schema:{type:'object',properties:{path:{type:'string'},startLine:{type:'integer',minimum:1,description:'1-based text line to start reading from.'},endLine:{type:'integer',minimum:1,description:'1-based text line to stop at. Maximum window is 2000 lines.'},offset:{type:'integer',minimum:1,description:'1-based directory entry offset when path is a directory.'},limit:{type:'integer',minimum:1,description:'Maximum directory entries to return when path is a directory.'}},required:['path']},
    async execute(a,c){
      const requestedPath=String(a.path||'')
      const toolOutputRef=parseToolOutputReference(requestedPath)
      if(toolOutputRef){
        const page=await toolOutputStore.read(requestedPath,{startLine:a.startLine,endLine:a.endLine})
        const lines=page.text.split('\n').map((line,i)=>`${page.startLine+i}: ${line}`)
        const output=lines.join('\n') || '(empty tool output)'
        return {title:requestedPath,output:`${output}${page.truncated?`\n[continue with startLine=${page.endLine+1}]`:''}`,metadata:{toolOutput:{reference:requestedPath,path:page.path,metadata:page.metadata,totalLines:page.totalLines,lineStart:page.startLine,lineEnd:page.endLine,truncated:page.truncated}}}
      }
      const p=safePath(c.cwd,a.path,c.scopePaths)
      const stats=await fs.stat(p)
      if (stats.isDirectory()) {
        const offset=Number.isFinite(Number(a.offset)) && Number(a.offset)>0 ? Math.floor(Number(a.offset)) : 1
        const limit=Number.isFinite(Number(a.limit)) && Number(a.limit)>0 ? Math.min(Math.floor(Number(a.limit)),DEFAULT_DIRECTORY_PAGE) : DEFAULT_DIRECTORY_PAGE
        const page=await listDirectoryPage(p,{offset,limit},c.abort)
        const output=page.entries.length ? page.entries.map(entry=>entry.name).join('\n') : 'No entries'
        const rendered=page.truncated ? `${output}\n\n[Directory listing truncated. Use offset=${page.nextOffset} to continue.]` : output
        return {title:p,output:rendered,metadata:{directory:{path:p,offset,limit,entries:page.entries.length,totalEntries:page.totalEntries,truncated:page.truncated,nextOffset:page.nextOffset}}}
      }
      if (!stats.isFile()) throw new Error(`Path is not a regular file: ${a.path}`)

      const requested=requestedReadRange(a.startLine,a.endLine)
      const cache=c.readFileState
      const cacheLookup=cache?.lookup(p,requested,{mtimeMs:stats.mtimeMs,size:stats.size})
      if (cacheLookup?.status==='unchanged') {
        return {title:p,output:`File unchanged since last read. Cached range ${requested.startLine}-${requested.endLine} remains valid; refer to the existing tool result instead of re-reading.`,metadata:{cache:'unchanged',canonicalPath:p,mtimeMs:stats.mtimeMs,size:stats.size,contentHash:cacheLookup.state.contentHash,lineStart:requested.startLine,lineEnd:Math.min(requested.endLine,cacheLookup.state.totalLines),totalLines:cacheLookup.state.totalLines,truncated:false,nextLine:requested.endLine<cacheLookup.state.totalLines?requested.endLine+1:undefined,coveredRanges:cacheLookup.covered,readState:cache?.stats()}}
      }
      if (cacheLookup?.status==='rehydrated' && cacheLookup.content!==undefined) {
        const start=requested.startLine
        const end=Math.min(requested.endLine,cacheLookup.state.totalLines)
        cache?.markContextCoverage(p,requested,true)
        return {title:p,output:cacheLookup.content.split(/\n/).map((line:string,i:number)=>`${start+i}: ${line}`).join('\n'),metadata:{cache:'rehydrated',canonicalPath:p,mtimeMs:stats.mtimeMs,size:stats.size,contentHash:cacheLookup.state.contentHash,lineStart:start,lineEnd:end,totalLines:cacheLookup.state.totalLines,truncated:false,nextLine:end<cacheLookup.state.totalLines?end+1:undefined,coveredRanges:cacheLookup.covered,readState:cache?.stats()}}
      }
      if (cacheLookup?.status==='already-covered') {
        const end=Math.min(requested.endLine,cacheLookup.state.totalLines)
        return {title:p,output:`Requested range ${requested.startLine}-${end} is already covered by existing read evidence. Use the previous read result instead of re-reading it.`,metadata:{cache:'already-covered',canonicalPath:p,mtimeMs:stats.mtimeMs,size:stats.size,contentHash:cacheLookup.state.contentHash,lineStart:requested.startLine,lineEnd:end,totalLines:cacheLookup.state.totalLines,truncated:false,nextLine:end<cacheLookup.state.totalLines?end+1:undefined,coveredRanges:cacheLookup.covered,readState:cache?.stats()}}
      }

      // Only inspect/decode the file when actual content access is still
      // required. Cache hits have already established the file version through
      // stat(), so repeating the text/binary sample read would defeat the
      // pre-execution semantic gate with unnecessary filesystem I/O.
      await inspectTextFile(p)

      let ranges=cacheLookup?.uncovered?.length ? cacheLookup.uncovered : [requested]
      const read=await readLinesWithRanges(p,ranges,c.abort)
      const bounded=formatBoundedLines(read.lines)
      const actualRequested={startLine:requested.startLine,endLine:Math.min(requested.endLine,read.totalLines)}
      const actualLines=bounded.kept.map(item=>item.line)
      const returnedRanges=mergeReadRanges(bounded.kept.map(item=>({startLine:item.line,endLine:item.line})))
      const returnedText = returnedRanges.map(r => {
        const items=read.lines.filter(item=>item.line>=r.startLine&&item.line<=r.endLine)
        return {
          startLine:r.startLine,
          endLine:r.endLine,
          content:items.map(item=>item.text).join('\n'),
          complete:items.every(item => !item.text.endsWith(' …[line truncated]')),
        }
      })
      if (cache) {
        cache.record(
          p,
          {mtimeMs:stats.mtimeMs,size:stats.size,totalLines:read.totalLines,contentHash:read.contentHash,bom:read.bom,lineEnding:read.lineEnding},
          actualRequested,
          returnedText,
          {lineCount:actualLines.length,truncated:bounded.truncated || read.truncatedLineCount > 0},
        )
      }

      const startLine=actualLines[0] ?? requested.startLine
      const endLine=actualLines.at(-1) ?? Math.min(requested.endLine,read.totalLines)
      const nextLine=endLine < read.totalLines ? endLine+1 : undefined
      const cacheStatus=cacheLookup?.status==='overlap' ? 'overlap' : 'miss'
      const overlapNote=cacheStatus==='overlap' ? `\n[cache: skipped previously read lines; existing coverage ${cacheLookup?.covered.map(r=>`${r.startLine}-${r.endLine}`).join(', ')}]` : ''
      const continuation=bounded.truncated || nextLine!==undefined ? `\n[continue with startLine=${nextLine ?? endLine+1}]` : ''
      const output=`${bounded.content}${overlapNote}${continuation}`
      return {title:p,output,metadata:{cache:cacheStatus,canonicalPath:p,mtimeMs:stats.mtimeMs,size:stats.size,contentHash:read.contentHash,lineStart:startLine,lineEnd:endLine,totalLines:read.totalLines,truncated:bounded.truncated,nextLine,coveredRanges:mergeReadRanges([...(cacheLookup?.covered||[]),...returnedRanges]),returnedRanges,requestedRange:requested,readState:cache?.stats()}}
    }
  }
  const write: ToolDefinition = {
    name:'write_file',
    risk:'write',
    description:'Create or overwrite a UTF-8 text file inside the project. Existing files must be freshly and completely read before replacement.',
    schema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']},
    async execute(a,c){
      const p=safePath(c.cwd,a.path,c.scopePaths)
      const desired=String(a.content??'')
      return await withFileMutationLock(p, async () => {
        let current: Uint8Array | undefined
        try { current=(await readMutationBytes(p)).bytes } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error
        }

        const existed=current !== undefined
        const now=existed ? await fs.stat(p) : undefined
        const state=c.readFileState
        if (existed) {
          if (!state || !state.hasCompleteRead(p)) {
            throw new Error('File has not been fully read yet. Read the existing file completely before writing to it.')
          }
          if (!now || !state.hasFreshFullRead(p,{mtimeMs:now.mtimeMs,size:now.size})) {
            throw new Error('File has been modified since it was read. Read it again before attempting to write to it.')
          }
          const currentMeta=decodeUtf8Text(current!)
          const stateMeta=state.mutationState(p)
          if (!stateMeta?.contentHash || hashBytes(current!) !== stateMeta.contentHash) {
            throw new Error('File has been modified since it was read. Read it again before attempting to write to it.')
          }
          const stripped=stripUtf8Bom(desired).text
          const nextText=convertLineEndings(stripped,currentMeta.lineEnding)
          const finalBytes=encodeText(nextText,currentMeta.bom)
          const after=await writeIfUnchanged(p,stateMeta.contentHash,finalBytes)
          const beforeText=currentMeta.text
          const diff=await renderTextDiff(path.relative(c.cwd,p)||path.basename(p),beforeText,nextText,{maxBytes:24000})
          const finalStat=await fs.stat(p)
          state.seedFullContent(p,{mtimeMs:finalStat.mtimeMs,size:after.size,totalLines:countTextLines(nextText),contentHash:after.hash,bom:currentMeta.bom,lineEnding:currentMeta.lineEnding},nextText,true)
          return {title:p,output:`wrote ${after.size} bytes`,metadata:{diff:diff.text,fileDiff:{path:path.relative(c.cwd,p)||path.basename(p),additions:diff.additions,deletions:diff.deletions},mutation:{path:p,operation:'update',existed:true,replacements:0,beforeHash:stateMeta.contentHash,afterHash:after.hash,beforeBytes:current!.length,afterBytes:after.size,lineEnding:currentMeta.lineEnding,bomPreserved:currentMeta.bom,writeGuard:'write-if-unchanged'}}}
        }

        await fs.mkdir(path.dirname(p),{recursive:true})
        const incoming=stripUtf8Bom(desired)
        const finalBytes=encodeText(incoming.text,incoming.bom)
        const after=await createFileExclusive(p,finalBytes)
        const finalStat=await fs.stat(p)
        const meta=decodeUtf8Text(finalBytes)
        state?.seedFullContent(p,{mtimeMs:finalStat.mtimeMs,size:after.size,totalLines:countTextLines(meta.text),contentHash:after.hash,bom:meta.bom,lineEnding:meta.lineEnding},meta.text,true)
        return {title:p,output:`wrote ${after.size} bytes`,metadata:{diff:'',fileDiff:{path:path.relative(c.cwd,p)||path.basename(p),additions:countTextLines(meta.text),deletions:0},mutation:{path:p,operation:'create',existed:false,replacements:0,beforeHash:null,afterHash:after.hash,beforeBytes:0,afterBytes:after.size,lineEnding:meta.lineEnding,bomPreserved:meta.bom,writeGuard:'create-exclusive'}}}
      })
    }
  }
  const edit: ToolDefinition = {
    name:'edit_file',
    risk:'write',
    description:'Replace an exact text occurrence in a freshly read file. Default behavior requires exactly one match; set all=true to replace every exact match.',
    schema:{type:'object',properties:{path:{type:'string'},oldText:{type:'string'},newText:{type:'string'},all:{type:'boolean'}},required:['path','oldText','newText']},
    async execute(a,c){
      const p=safePath(c.cwd,a.path,c.scopePaths)
      const oldText=String(a.oldText??'')
      const newText=String(a.newText??'')
      const replaceAll=Boolean(a.all)
      if (!oldText) throw new Error('oldText must not be empty. Use write_file to create or replace a complete file.')
      if (oldText===newText) throw new Error('No changes to apply: oldText and newText are identical.')

      return await withFileMutationLock(p, async () => {
        const current=await readMutationBytes(p)
        const stats=await fs.stat(p)
        const state=c.readFileState
        if (!state || !state.hasCompleteRead(p)) {
          throw new Error('File has not been fully read yet. Read the existing file completely before editing it.')
        }
        if (!state.hasFreshFullRead(p,{mtimeMs:stats.mtimeMs,size:stats.size})) {
          throw new Error('File has been modified since it was read. Read it again before attempting to edit it.')
        }
        const stateMeta=state.mutationState(p)
        if (!stateMeta?.contentHash || current.hash !== stateMeta.contentHash) {
          throw new Error('File has been modified since it was read. Read it again before attempting to edit it.')
        }

        const source=decodeUtf8Text(current.bytes)
        const oldNormalized=normalizeLineEndings(oldText)
        const newNormalized=normalizeLineEndings(newText)
        const oldForMatch=convertLineEndings(oldNormalized,source.lineEnding)
        const newForWrite=convertLineEndings(newNormalized,source.lineEnding)
        const count=countOccurrences(source.text,oldForMatch)
        if (count===0) throw new Error('Could not find oldText in the file. It must match exactly, including whitespace and indentation.')
        if (!replaceAll && count!==1) throw new Error(`Found ${count} matches of oldText. Provide more surrounding context or set all=true to replace all occurrences.`)

        const next=replaceAll ? source.text.split(oldForMatch).join(newForWrite) : source.text.replace(oldForMatch,newForWrite)
        const finalBytes=encodeText(next,source.bom)
        const after=await writeIfUnchanged(p,stateMeta.contentHash,finalBytes)
        const diff=await renderTextDiff(path.relative(c.cwd,p)||path.basename(p),source.text,next,{maxBytes:24000})
        const finalStat=await fs.stat(p)
        state.seedFullContent(p,{mtimeMs:finalStat.mtimeMs,size:after.size,totalLines:countTextLines(next),contentHash:after.hash,bom:source.bom,lineEnding:source.lineEnding},next,false)
        return {title:p,output:`edited ${count} occurrence(s)`,metadata:{diff:diff.text,fileDiff:{path:path.relative(c.cwd,p)||path.basename(p),additions:diff.additions,deletions:diff.deletions},mutation:{path:p,operation:'edit',existed:true,replacements:count,beforeHash:stateMeta.contentHash,afterHash:after.hash,beforeBytes:current.size,afterBytes:after.size,lineEnding:source.lineEnding,bomPreserved:source.bom,replaceAll:replaceAll,writeGuard:'write-if-unchanged'}}}
      })
    }
  }
  const grep: ToolDefinition = {
    name:'grep', risk:'read', parallelSafe:true,
    description:'Search project text with a regular-expression pattern. Uses ripgrep when available and a deterministic Node fallback otherwise.',
    schema:{type:'object',properties:{pattern:{type:'string'},path:{type:'string'},glob:{type:'string'},include:{type:'string'},maxResults:{type:'integer',minimum:1},offset:{type:'integer',minimum:0}},required:['pattern']},
    async execute(a,c){
      const base=safePath(c.cwd,a.path||'.',c.scopePaths)
      const include=typeof a.include==='string' ? a.include : (typeof a.glob==='string' ? a.glob : undefined)
      const result=await searchText({pattern:String(a.pattern),root:base,include,limit:a.maxResults ?? DEFAULT_SEARCH_RESULTS,offset:a.offset ?? 0,timeout:opts.timeout,signal:c.abort})
      const rows=result.matches.map(m=>`${path.relative(c.cwd,m.path)||path.basename(m.path)}:${m.line}:${m.text}`)
      let output=rows.length ? rows.join('\n') : 'No matches'
      if (result.truncated) output += `\n\n[Results truncated. Use offset to continue.]`
      if (Buffer.byteLength(output,'utf8')>opts.maxOutput) output=Buffer.from(output,'utf8').subarray(0,opts.maxOutput).toString('utf8')+'\n\n[Output truncated.]'
      return {title:String(a.pattern),output,metadata:{search:{pattern:String(a.pattern),path:base,discoveredFiles:result.matches.map(match=>match.path),symbols:[],include,engine:result.engine,matches:result.matches.length,totalMatches:result.totalMatches,offset:Number(a.offset)||0,limit:Number(a.maxResults)||DEFAULT_SEARCH_RESULTS,truncated:result.truncated,nextOffset:result.truncated?(Number(a.offset)||0)+result.matches.length:undefined}}}
    }
  }
  const glob: ToolDefinition = {
    name:'glob', risk:'read', parallelSafe:true,
    description:'Find files by glob pattern using a shared bounded filesystem search service.',
    schema:{type:'object',properties:{pattern:{type:'string'},path:{type:'string'},maxResults:{type:'integer',minimum:1},offset:{type:'integer',minimum:0}},required:['pattern']},
    async execute(a,c){
      const base=safePath(c.cwd,a.path||'.',c.scopePaths)
      const result=await globFiles({pattern:String(a.pattern),root:base,limit:a.maxResults ?? DEFAULT_GLOB_RESULTS,offset:a.offset ?? 0,timeout:opts.timeout,signal:c.abort})
      const files=result.files.map(file=>path.relative(c.cwd,file)||path.basename(file))
      let output=files.length ? files.join('\n') : 'No matches'
      if (result.truncated) output += `\n\n[Results truncated. Use offset to continue.]`
      if (Buffer.byteLength(output,'utf8')>opts.maxOutput) output=Buffer.from(output,'utf8').subarray(0,opts.maxOutput).toString('utf8')+'\n\n[Output truncated.]'
      return {title:String(a.pattern),output,metadata:{glob:{pattern:String(a.pattern),path:base,discoveredFiles:result.files,engine:result.engine,files:result.files.length,totalFiles:result.totalFiles,offset:Number(a.offset)||0,limit:Number(a.maxResults)||DEFAULT_GLOB_RESULTS,truncated:result.truncated,nextOffset:result.truncated?(Number(a.offset)||0)+result.files.length:undefined}}}
    }
  }
  const taskManager = new TaskManager()
  const shellPreview = (value:string) => value.replace(/\n{3,}/g,'\n\n').trim()
  const shellQuote = (value:string) => `'${value.replaceAll("'","'\"'\"'")}'`
  const bash: ToolDefinition = {
    name:'bash', risk:'shell',
    description:'Run a shell command in the project. Long-running commands may be promoted to a durable background task after 15 seconds; set run_in_background=true to background immediately.',
    schema:{type:'object',properties:{command:{type:'string'},timeout:{type:'integer',minimum:0,description:'Maximum foreground runtime in milliseconds.'},run_in_background:{type:'boolean',description:'Run immediately as a durable background task and return a task id.'}},required:['command']},
    async execute(a,c){
      const command=String(a.command??'').trim()
      if(!command) throw new Error('bash command must not be empty')
      const explicitBackground=Boolean(a.run_in_background)
      const timeout=Number.isFinite(Number(a.timeout))&&Number(a.timeout)>=0 ? Math.floor(Number(a.timeout)) : opts.timeout
      const handle=await startManagedShell(taskManager,{shell:process.env.SHELL||'sh',command,cwd:c.cwd,timeout:explicitBackground?0:timeout,maxPreviewBytes:opts.maxOutput,outputLimitBytes:64*1024*1024,autoBackgroundMs:explicitBackground?undefined:(Number.isFinite(Number(process.env.TERMAGENT_SHELL_AUTO_BACKGROUND_MS)) ? Math.max(1,Math.floor(Number(process.env.TERMAGENT_SHELL_AUTO_BACKGROUND_MS))) : 15_000),abort:c.abort,detached:true,parentSessionId:c.sessionID,scopePaths:c.scopePaths,background:explicitBackground})
      if(explicitBackground){
        await handle.background()
        const current=await taskManager.get(handle.task.id)
        return {title:`background task ${handle.task.id}`,output:`Started background task ${handle.task.id}. Use task_status with id ${handle.task.id} to observe it. Full output: ${current.outputPath}`,metadata:{shell:{taskId:handle.task.id,status:'running',background:true,outputPath:current.outputPath,interactiveLikely:looksInteractiveLikely(command)}}}
      }
      const result=await handle.result
      const label=result.backgrounded ? `Command moved to background as task ${handle.task.id}.` : `Command ${result.termination}.`
      return {title:result.backgrounded?`background task ${handle.task.id}`:command,output:`${label}${result.outputPreview ? `\n${shellPreview(result.outputPreview)}` : ''}${result.outputTruncated ? `\n[Full output: ${result.outputPath}]` : ''}`,metadata:{shell:{taskId:handle.task.id,command,status:result.termination,exitCode:result.code,signal:result.signal,durationMs:result.durationMs,outputPath:result.outputPath,outputBytes:result.outputBytes,outputTruncated:result.outputTruncated,background:result.backgrounded,interactiveLikely:result.interactiveLikely}}}
    }
  }
  const git: ToolDefinition = {
    name:'git', risk:'shell',
    description:'Run a Git subcommand in the project with argument-aware safety classification and durable command output.',
    schema:{type:'object',properties:{args:{type:'array',items:{type:'string'}}},required:['args']},
    async execute(a,c){
      const args=(a.args||[]).map(String)
      const analysis=analyzeGitArgs(args)
      if(analysis.destructive) throw new Error(`Potentially destructive git command blocked: ${analysis.summary}. Arguments: ${args.join(' ')}`)
      const command=['git',...args].map(x=>shellQuote(String(x))).join(' ')
      const handle=await startManagedShell(taskManager,{shell:process.env.SHELL||'sh',command,cwd:c.cwd,timeout:opts.timeout,maxPreviewBytes:opts.maxOutput,outputLimitBytes:64*1024*1024,autoBackgroundMs:(Number.isFinite(Number(process.env.TERMAGENT_SHELL_AUTO_BACKGROUND_MS)) ? Math.max(1,Math.floor(Number(process.env.TERMAGENT_SHELL_AUTO_BACKGROUND_MS))) : 15_000),abort:c.abort,detached:true,parentSessionId:c.sessionID,scopePaths:c.scopePaths})
      const result=await handle.result
      return {title:`git ${analysis.operation}`,output:`${result.backgrounded?`Git command moved to background as task ${handle.task.id}.`:`git ${analysis.operation} ${result.termination}.`}${result.outputPreview?`\n${shellPreview(result.outputPreview)}`:''}`,metadata:{git:{...analysis,taskId:handle.task.id,status:result.termination,exitCode:result.code,signal:result.signal,outputPath:result.outputPath,outputBytes:result.outputBytes,outputTruncated:result.outputTruncated,background:result.backgrounded}}}
    }
  }
  const repoMap: ToolDefinition = { name:'repo_map', risk:'read', parallelSafe:true, description:'Show a token-bounded structural map of the repository. Use focusFiles or focusSymbols for a specific area.', schema:{type:'object',properties:{tokens:{type:'integer',minimum:256},focusFiles:{type:'array',items:{type:'string'}},focusSymbols:{type:'array',items:{type:'string'}}}}, async execute(a,c){ const map=await buildRepositoryMap(c.cwd); const tokens=Math.max(256,Math.min(Number(a.tokens)||2048,8192)); const output= formatRepositoryMap(map,180,tokens,{focusFiles:Array.isArray(a.focusFiles)?a.focusFiles.map(String):[],focusSymbols:Array.isArray(a.focusSymbols)?a.focusSymbols.map(String):[]}); return {title:'Repository map',output:output.slice(0,opts.maxOutput),metadata:{repositoryMap:{files:map.files.map(file=>path.resolve(c.cwd,file.path)),symbols:map.files.flatMap(file=>file.symbols.map(symbol=>symbol.name)).slice(0,512)}}} } }
  const applyPatch = applyPatchTool()
  return [read,write,edit,applyPatch,grep,glob,bash,git,repoMap]
}
