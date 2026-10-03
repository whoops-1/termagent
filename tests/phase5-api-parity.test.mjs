import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function req(base, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base)
    const payload = body == null ? '' : JSON.stringify(body)
    const r = http.request(u, { method, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

function gitInit(cwd) {
  const { spawnSync } = require('node:child_process')
}

test('phase 5: API exposes context, commands, abort alias, and interactive question responses', async () => {
  const { spawnSync } = await import('node:child_process')
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase5-api-'))
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase5-home-'))
  let modelServer
  let appServer
  const old = { HOME: process.env.HOME, BASE: process.env.TERMAGENT_BASE_URL, KEY: process.env.TERMAGENT_API_KEY, MODEL: process.env.TERMAGENT_MODEL, APPROVALS: process.env.TERMAGENT_APPROVALS }
  try {
    await mkdir(path.join(root, '.termagent'), { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd: root })
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
    spawnSync('git', ['config', 'user.name', 'TermAgent Tests'], { cwd: root })
    await writeFile(path.join(root, 'README.md'), '# phase5\n')
    spawnSync('git', ['add', '.'], { cwd: root }); spawnSync('git', ['commit', '-qm', 'init'], { cwd: root })
    await writeFile(path.join(root, '.termagent', 'config.json'), JSON.stringify({ provider: 'openai-compatible', model: 'mock', approvals: 'auto' }))

    let modelCalls = 0
    modelServer = http.createServer((request, response) => {
      let data = ''
      request.on('data', c => data += c)
      request.on('end', () => {
        modelCalls++
        const body = JSON.parse(data || '{}')
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (modelCalls === 1) {
          const args = JSON.stringify({ questions: [{ header: 'Choice', question: 'Pick a color', options: [{ label: 'blue', description: 'Blue' }, { label: 'green', description: 'Green' }], multi: false, custom: false }] })
          response.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'q1', function: { name: 'question', arguments: args } }] }, finish_reason: 'tool_calls' }] }) + '\n\n')
        } else {
          response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'answered' } }] }) + '\n\n')
          response.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
        }
        response.end()
      })
    })
    await new Promise(resolve => modelServer.listen(0, resolve))
    const modelPort = modelServer.address().port
    process.env.HOME = home
    process.env.TERMAGENT_BASE_URL = `http://127.0.0.1:${modelPort}`
    process.env.TERMAGENT_API_KEY = 'test'
    process.env.TERMAGENT_MODEL = 'mock'
    process.env.TERMAGENT_APPROVALS = 'auto'

    const { createRuntime } = await import('../dist/server/runtime.js')
    const { startServer } = await import('../dist/server/http.js')
    const runtime = await createRuntime(root)
    appServer = await startServer(runtime, { host: '127.0.0.1', port: 0, token: 'secret' })
    const base = `http://127.0.0.1:${appServer.address().port}`
    const headers = { authorization: 'Bearer secret' }

    let r = await req(base, 'GET', '/api/v1/commands', null, headers)
    assert.equal(r.status, 200); assert.match(r.body, /"checkpoint"/); assert.match(r.body, /"resume"/)
    r = await req(base, 'GET', '/api/v1/info', null, headers)
    assert.equal(r.status, 200); assert.match(r.body, /"context"/); assert.match(r.body, /"questions"/)
    r = await req(base, 'POST', '/api/v1/sessions', {}, headers)
    assert.equal(r.status, 201); const session = JSON.parse(r.body)
    r = await req(base, 'GET', `/api/v1/sessions/${session.id}/context`, null, headers)
    assert.equal(r.status, 200); const context = JSON.parse(r.body); assert.equal(context.sessionId, session.id); assert.ok('limit' in context)
    r = await req(base, 'POST', `/api/v1/sessions/${session.id}/abort`, {}, headers)
    assert.equal(r.status, 409)

    const questionResponse = new Promise((resolve, reject) => {
      const payload = JSON.stringify({ prompt: 'ask me', stream: true })
      const qreq = http.request(new URL(`/api/v1/sessions/${session.id}/prompt`, base), { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
        let carry = ''
        let full = ''
        res.setEncoding('utf8')
        res.on('data', async chunk => {
          full += chunk
          carry += chunk
          const frames = carry.split('\n\n')
          carry = frames.pop() || ''
          for (const frame of frames) {
            const event = frame.split('\n').find(x => x.startsWith('event:'))?.slice(6).trim()
            const dataLine = frame.split('\n').find(x => x.startsWith('data:'))?.slice(5).trim()
            if (event === 'question' && dataLine) {
              const question = JSON.parse(dataLine)
              try {
                await req(base, 'POST', `/api/v1/sessions/${session.id}/questions/${question.id}`, { answers: [['blue']] }, headers)
              } catch (error) { reject(error) }
            }
          }
        })
        res.on('end', () => resolve({ status: res.statusCode, body: full }))
      })
      qreq.on('error', reject)
      qreq.write(payload); qreq.end()
    })
    const stream = await questionResponse
    assert.equal(stream.status, 200)
    assert.match(stream.body, /event: question/)
    assert.match(stream.body, /event: done/)
    assert.match(stream.body, /answered/)

    await new Promise(resolve => appServer.close(resolve))
    await runtime.close()
  } finally {
    if (appServer?.listening) await new Promise(resolve => appServer.close(resolve))
    if (modelServer?.listening) await new Promise(resolve => modelServer.close(resolve))
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
