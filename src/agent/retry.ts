export type RetryInfo={attempt:number;delay:number;message:string}

function numeric(value:unknown){const n=Number(value);return Number.isFinite(n)?n:undefined}

export function retryDelay(attempt:number,retryAfter?:number,random=Math.random()){
  if(retryAfter!==undefined && retryAfter>=0) return Math.min(Math.ceil(retryAfter),15000)
  const jitter=Math.max(0,Math.min(1,random))
  return Math.min(500*Math.pow(2,attempt-1),15000)+Math.floor(jitter*100)
}

export function isRetryableError(e:unknown){
  if((e as any)?.code==='ABORT_ERR' || (e as any)?.name==='AbortError') return false
  if((e as any)?.safeToRetry===false) return false
  const m=String((e as any)?.message||e).toLowerCase()
  const status=Number((e as any)?.status||0)
  return status===408||status===409||status===425||status===429||status>=500||/timeout|timed out|overloaded|temporar|rate.?limit|econnreset|fetch failed|socket|empty model response|service unavailable|resource exhausted/i.test(m)
}

async function wait(delay:number,signal?:AbortSignal){
  if(delay<=0)return
  if(signal?.aborted){const e=new Error('Retry cancelled');(e as any).code='ABORT_ERR';throw e}
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(done,delay)
    const onAbort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);const e=new Error('Retry cancelled');(e as any).code='ABORT_ERR';reject(e)}
    function done(){signal?.removeEventListener('abort',onAbort);resolve()}
    signal?.addEventListener('abort',onAbort,{once:true})
  })
}

export async function withRetry<T>(fn:()=>Promise<T>,opts:{max?:number;onRetry?:(x:RetryInfo)=>void;signal?:AbortSignal;random?:()=>number}={}):Promise<T>{
  const max=opts.max??4;let last:any
  for(let attempt=1;attempt<=max+1;attempt++){
    if(opts.signal?.aborted){const e=new Error('Retry cancelled');(e as any).code='ABORT_ERR';throw e}
    try{return await fn()}
    catch(e){
      last=e
      if(attempt>max||!isRetryableError(e))throw e
      const retryAfter=numeric((e as any)?.retryAfterMs) ?? numeric((e as any)?.retryAfter)
      const d=retryDelay(attempt,retryAfter,opts.random?.()??Math.random())
      opts.onRetry?.({attempt,delay:d,message:String((e as any)?.message||e)})
      await wait(d,opts.signal)
    }
  }
  throw last
}
