import http from 'node:http'

const port=Number(process.argv[2]||8787)
const server=http.createServer((req,res)=>{
  if(req.url!=='/v1/chat/completions' || req.method!=='POST'){res.writeHead(404);return res.end('not found')}
  let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
    let parsed={}; try{parsed=JSON.parse(body)}catch{}
    const messages=parsed.messages||[]
    const last=messages.at(-1)||{}
    const content=String(last.content||'')
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'})
    const chunks=[
      'TermAgent device smoke test passed. ',
      `I received ${content.length} characters. `,
      'The Node.js provider path is working.'
    ]
    for(const text of chunks){res.write(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\n`)}
    res.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
server.listen(port,'127.0.0.1',()=>console.log(`Mock provider listening on http://127.0.0.1:${port}/v1`))
process.once('SIGINT',()=>server.close(()=>process.exit(0)))
