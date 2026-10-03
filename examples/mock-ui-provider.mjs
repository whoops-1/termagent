import http from 'node:http'

const port=Number(process.argv[2]||8789)
let turns=0
const sleep=ms=>new Promise(r=>setTimeout(r,ms))

const server=http.createServer((req,res)=>{
  if(req.url!=='/v1/chat/completions' || req.method!=='POST'){res.writeHead(404);return res.end('not found')}
  let body=''; req.on('data',c=>body+=c); req.on('end',async()=>{
    let parsed={}; try{parsed=JSON.parse(body)}catch{}
    const messages=parsed.messages||[]
    const last=messages.at(-1)||{}
    turns++
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'})
    const send=payload=>res.write(`data: ${JSON.stringify(payload)}\n\n`)
    if(last.role==='tool'){
      const parts=['The permission was granted. ','The command completed and ','the session stayed active.']
      for(const part of parts){ send({choices:[{delta:{content:part}}]}); await sleep(250) }
      send({choices:[{delta:{},finish_reason:'stop'}]})
      send({choices:[{delta:{},finish_reason:null}]})
      res.write('data: [DONE]\n\n'); res.end(); return
    }
    send({choices:[{delta:{reasoning_content:'I will inspect the requested context, then use the appropriate tool and verify its result.'}}]})
    await sleep(900)
    send({choices:[{delta:{reasoning_content:' The terminal UI should remain interactive while this turn is running.'}}]})
    await sleep(900)
    send({choices:[{delta:{tool_calls:[{index:0,id:'call-ui-bash',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'printf ui-permission-ok'})}}]}}]})
    send({choices:[{delta:{},finish_reason:'tool_calls'}]})
    send({choices:[{delta:{},finish_reason:null}]})
    res.write('data: [DONE]\n\n'); res.end()
  })
})
server.listen(port,'127.0.0.1',()=>console.log(`Mock UI provider listening on http://127.0.0.1:${port}/v1`))
process.once('SIGINT',()=>server.close(()=>process.exit(0)))
