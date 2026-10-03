import { ProviderStreamIdleError } from './errors.js'

export interface SseOptions {
  idleTimeoutMs?: number
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  safeToRetry: boolean,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const read = reader.read()
  if (timeoutMs <= 0 && !signal) return read

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const races: Promise<ReadableStreamReadResult<Uint8Array>>[] = [read]
    if (timeoutMs > 0) {
      races.push(new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderStreamIdleError(timeoutMs, safeToRetry)), timeoutMs)
      }))
    }
    if (signal) {
      races.push(new Promise<never>((_, reject) => {
        onAbort = () => {
          const error = new Error('Provider request aborted')
          ;(error as any).code = 'ABORT_ERR'
          reject(error)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }))
    }
    return await Promise.race(races)
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort && signal) signal.removeEventListener('abort', onAbort)
  }
}

export async function* sseLines(body:ReadableStream<Uint8Array>, signal?:AbortSignal, options:SseOptions={}):AsyncGenerator<string>{
  const reader=body.getReader(); const decoder=new TextDecoder(); let buffer=''; let emitted=false
  const idleTimeoutMs=Math.max(0,Math.floor(options.idleTimeoutMs??0))
  try {
    while(true){
      if(signal?.aborted) throw abortError()
      const {done,value}=await readWithIdleTimeout(reader,idleTimeoutMs,!emitted,signal)
      if(done)break
      if(!value?.length)continue
      buffer+=decoder.decode(value,{stream:true})
      const lines=buffer.split(/\r?\n/); buffer=lines.pop()||''
      for(const line of lines){ if(line.startsWith('data:')){const payload=line.slice(5).trim(); if(payload){emitted=true;yield payload}} }
    }
    buffer+=decoder.decode()
    if(buffer.startsWith('data:')){const payload=buffer.slice(5).trim();if(payload){emitted=true;yield payload}}
  } finally { try{await reader.cancel()}catch{} }
}

function abortError(){
  const error=new Error('Provider request aborted')
  ;(error as any).code='ABORT_ERR'
  return error
}
