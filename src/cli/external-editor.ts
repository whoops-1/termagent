import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

export type ExternalEditorResult = { text: string; file: string; editor: string }

function editorCommand() {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi')
}

function splitCommand(command: string): string[] {
  const out:string[]=[]; let current=''; let quote:string|undefined; let escaped=false
  for(const ch of command.trim()){
    if(escaped){current+=ch;escaped=false;continue}
    if(ch==='\\' && quote!=='single'){escaped=true;continue}
    if((ch==='"'||ch==="'") ){
      if(!quote){quote=ch;continue}
      if(quote===ch){quote=undefined;continue}
    }
    if(!quote && /\s/.test(ch)){if(current){out.push(current);current=''};continue}
    current+=ch
  }
  if(escaped) current+='\\'
  if(quote) throw new Error('Editor command contains an unmatched quote')
  if(current) out.push(current)
  return out
}

export async function editExternally(initial: string, cwd: string, extension = '.txt'): Promise<ExternalEditorResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-editor-'))
  const name = `draft-${crypto.randomBytes(5).toString('hex')}${extension.startsWith('.') ? extension : `.${extension}`}`
  const file = path.join(dir, name)
  await fs.writeFile(file, initial, { encoding: 'utf8', mode: 0o600 })
  const editor = editorCommand()
  const command=splitCommand(editor)
  if(!command.length) throw new Error('Editor command is empty')
  const child = spawnSync(command[0]!, [...command.slice(1), file], { cwd, stdio: 'inherit', shell: false, env: process.env })
  try {
    if (child.error) throw new Error(`Failed to launch editor ${editor}: ${child.error.message}`)
    if (child.status !== 0) throw new Error(`Editor exited with status ${child.status ?? 'unknown'}`)
    return { text: await fs.readFile(file, 'utf8'), file, editor }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function markdownConversation(messages: Array<{ role: string; content?: string | null; reasoning?: string }>, meta?: { id?: string; cwd?: string; model?: string }) {
  const lines = [
    '# TermAgent Session',
    '',
    meta?.id ? `- Session: \`${meta.id}\`` : '',
    meta?.cwd ? `- Working directory: \`${meta.cwd}\`` : '',
    meta?.model ? `- Model: \`${meta.model}\`` : '',
    '',
  ].filter(Boolean)
  for (const message of messages) {
    const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role === 'tool' ? 'Tool' : 'System'
    lines.push(`## ${role}`)
    lines.push('')
    if (message.reasoning) {
      lines.push('<details>')
      lines.push('<summary>Reasoning</summary>')
      lines.push('')
      lines.push(message.reasoning)
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }
    lines.push(message.content ?? '')
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}

export async function exportConversation(markdown: string, cwd: string): Promise<ExternalEditorResult> {
  return await editExternally(markdown, cwd, '.md')
}
