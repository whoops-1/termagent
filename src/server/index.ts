import { createRuntime } from './runtime.js'
import { startServer } from './http.js'

export async function serve(cwd:string,opts:{host:string;port:number;token?:string}){
  const runtime=await createRuntime(cwd)
  const server=await startServer(runtime,opts)
  const address=server.address(); const actualPort=typeof address==='object'&&address?address.port:opts.port
  console.log(`TermAgent server listening on http://${opts.host}:${actualPort}`)
  console.log(`Health: http://${opts.host}:${actualPort}/health`)
  const close=async()=>{server.close();await runtime.close()}
  process.once('SIGINT',()=>{void close().finally(()=>process.exit(0))})
  process.once('SIGTERM',()=>{void close().finally(()=>process.exit(0))})
  return server
}
