import type { ChatMessage } from '../session/store.js'

export type ClientOptions = { baseUrl: string; token?: string; fetch?: typeof fetch }
export type PromptOptions = { stream?: boolean; mode?: string; autonomous?: boolean; agent?: string }
export type SessionEvent = { type: string; ts: number; data: any }

export class TermAgentError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'TermAgentError' }
}

export class TermAgentClient {
  private readonly root: string
  private readonly auth?: string
  private readonly http: typeof fetch
  constructor(options: ClientOptions) {
    this.root = options.baseUrl.replace(/\/$/, '')
    this.auth = options.token
    this.http = options.fetch || fetch
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (this.auth) headers.set('authorization', `Bearer ${this.auth}`)
    const response = await this.http(`${this.root}${pathname}`, { ...init, headers })
    const raw = await response.text()
    let data: any = raw
    try { data = raw ? JSON.parse(raw) : undefined } catch {}
    if (!response.ok) throw new TermAgentError(String(data?.error || response.statusText || 'Request failed'), response.status)
    return data as T
  }

  info() { return this.request<any>('/api/v1/info') }
  health() { return this.request<any>('/health') }
  listSessions() { return this.request<any>('/api/v1/sessions') }
  createSession(cwd?: string, model?: string) { return this.request<any>('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) }), headers: { 'content-type': 'application/json' } }) }
  getSession(id: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}`) }
  getMessages(id: string, after = 0) { return this.request<{ messages: ChatMessage[] }>(`/api/v1/sessions/${encodeURIComponent(id)}/messages?after=${Math.max(0, Math.floor(after))}`) }
  getEvents(id: string, after = 0) { return this.request<{ events: SessionEvent[] }>(`/api/v1/sessions/${encodeURIComponent(id)}/events?after=${Math.max(0, Math.floor(after))}`) }
  async *streamEvents(id: string, after = 0, options: { signal?: AbortSignal } = {}): AsyncGenerator<{ event: string; data: any }> {
    const headers = new Headers({ accept: 'text/event-stream' })
    if (this.auth) headers.set('authorization', `Bearer ${this.auth}`)
    const response = await this.http(`${this.root}/api/v1/sessions/${encodeURIComponent(id)}/events/stream?after=${Math.max(0, Math.floor(after))}`, { headers, signal: options.signal })
    if (!response.ok) {
      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {}
      throw new TermAgentError(String(data?.error || text || response.statusText), response.status)
    }
    if (!response.body) throw new Error('Server returned no event stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let carry = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        carry += decoder.decode(value, { stream: true })
        const frames = carry.split('\n\n')
        carry = frames.pop() || ''
        for (const frame of frames) {
        let event = 'message'
        const dataLines: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (!dataLines.length) continue
        let data: any = dataLines.join('\n')
        try { data = JSON.parse(data) } catch {}
        yield { event, data }
        }
      }
      carry += decoder.decode()
      if (carry.trim()) {
        let event = 'message'; const dataLines:string[]=[]
        for(const line of carry.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('data:'))dataLines.push(line.slice(5).trim())}
        if(dataLines.length){let data:any=dataLines.join('\n');try{data=JSON.parse(data)}catch{};yield {event,data}}
      }
    } finally {
      await reader.cancel().catch(()=>{})
    }
  }
  getSessionStatus(id: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/status`) }
  getContext(id: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/context`) }
  undo(id: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/undo`, { method: 'POST' }) }
  redo(id: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/redo`, { method: 'POST' }) }
  fork(id: string, at?: number) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/fork`, { method: 'POST', body: JSON.stringify({ at }), headers: { 'content-type': 'application/json' } }) }
  diff(id: string, options: { staged?: boolean } = {}) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/diff?staged=${options.staged ? '1' : '0'}`) }
  interrupt(id: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/interrupt`, { method: 'POST' }) }
  abort(id: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/abort`, { method: 'POST' }) }
  answerQuestion(id: string, questionId: string, answers: string[][]) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}`, { method: 'POST', body: JSON.stringify({ answers }), headers: { 'content-type': 'application/json' } }) }
  listTasks() { return this.request<any>('/api/v1/tasks') }
  getTask(id: string) { return this.request<any>(`/api/v1/tasks/${encodeURIComponent(id)}`) }
  getTaskEvents(id: string) { return this.request<any>(`/api/v1/tasks/${encodeURIComponent(id)}/events`) }
  cancelTask(id: string) { return this.request<any>(`/api/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }) }
  listAgents() { return this.request<any>('/api/v1/agents') }
  listSkills() { return this.request<any>('/api/v1/skills') }
  listTools() { return this.request<any>('/api/v1/tools') }
  listModels() { return this.request<any>('/api/v1/models') }
  listCommands() { return this.request<any>('/api/v1/commands') }
  compact(id: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/compact`, { method: 'POST' }) }

  async prompt(id: string, prompt: string, options: PromptOptions = {}) {
    return await this.request<any>(`/api/v1/sessions/${encodeURIComponent(id)}/prompt`, { method: 'POST', body: JSON.stringify({ prompt, ...options, stream: false }), headers: { 'content-type': 'application/json' } })
  }

  async *streamPrompt(id: string, prompt: string, options: Omit<PromptOptions, 'stream'> = {}, streamOptions: { signal?: AbortSignal } = {}) : AsyncGenerator<{ event: string; data: any }> {
    const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' })
    if (this.auth) headers.set('authorization', `Bearer ${this.auth}`)
    const response = await this.http(`${this.root}/api/v1/sessions/${encodeURIComponent(id)}/prompt`, { method: 'POST', headers, body: JSON.stringify({ prompt, ...options, stream: true }), signal: streamOptions.signal })
    if (!response.ok) {
      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {}
      throw new TermAgentError(String(data?.error || text || response.statusText), response.status)
    }
    if (!response.body) throw new Error('Server returned no event stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let carry = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        carry += decoder.decode(value, { stream: true })
        const frames = carry.split('\n\n')
        carry = frames.pop() || ''
        for (const frame of frames) {
        let event = 'message'
        const dataLines: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (!dataLines.length) continue
        let data: any = dataLines.join('\n')
        try { data = JSON.parse(data) } catch {}
        yield { event, data }
        }
      }
      carry += decoder.decode()
      if(carry.trim()){let event='message';const dataLines:string[]=[];for(const line of carry.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('data:'))dataLines.push(line.slice(5).trim())}if(dataLines.length){let data:any=dataLines.join('\n');try{data=JSON.parse(data)}catch{};yield {event,data}}}
    } finally {
      await reader.cancel().catch(()=>{})
    }
  }
}
