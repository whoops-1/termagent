import http from 'node:http'

const port=Number(process.argv[2]||8788)
let turns=0
const server=http.createServer((req,res)=>{
  if(req.url!=='/v1/chat/completions' || req.method!=='POST'){res.writeHead(404);return res.end('not found')}
  let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
    let parsed={}; try{parsed=JSON.parse(body)}catch{}
    const messages=parsed.messages||[]
    const last=messages.at(-1)||{}
    turns++
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'})
    const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    if (last.role === 'tool') {
      send({choices:[{delta:{content:'Permission was granted and the bash command completed successfully.'}}]})
      send({choices:[{delta:{},finish_reason:'stop'}]})
    } else if (turns === 1) {
      send({choices:[{delta:{tool_calls:[{index:0,id:'call_permission',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'printf permission-ok'})}}]}}]})
      send({choices:[{delta:{},finish_reason:'tool_calls'}]})
    } else {
      send({choices:[{delta:{content:'Smoke test complete.'}}]})
      send({choices:[{delta:{},finish_reason:'stop'}]})
    }
    send({choices:[{delta:{},finish_reason:null}]})
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
server.listen(port,'127.0.0.1',()=>console.log(`Mock permission provider listening on http://127.0.0.1:${port}/v1`))
process.once('SIGINT',()=>server.close(()=>process.exit(0)))
