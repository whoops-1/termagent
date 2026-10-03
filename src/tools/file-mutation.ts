import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'

export type LineEnding = 'LF' | 'CRLF'

export type MutationBytes = {
  bytes: Uint8Array
  hash: string
  size: number
}

export type TextEncodingInfo = {
  bom: boolean
  text: string
  lineEnding: LineEnding
}

const locks = new Map<string, Promise<void>>()

/**
 * TermAgent adaptation of TermAgent's FileMutation keyed-mutex + conditional
 * write pattern. The lock is intentionally process-local: it serializes
 * cooperating TermAgent mutations without pretending it can lock arbitrary
 * external editors or processes on every filesystem supported by Node.
 */
export async function withFileMutationLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(filePath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = previous.then(() => current)
  locks.set(filePath, queued)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(filePath) === queued) locks.delete(filePath)
  }
}

export function hashBytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export function stripUtf8Bom(text: string): { bom: boolean; text: string } {
  const stripped = text.replace(/^\uFEFF+/, '')
  return { bom: stripped.length !== text.length, text: stripped }
}

export function detectLineEnding(text: string): LineEnding {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue
    if (i > 0 && text[i - 1] === '\r') crlf++
    else lf++
  }
  return crlf >= lf && crlf > 0 ? 'CRLF' : 'LF'
}

export function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

export function convertLineEndings(text: string, ending: LineEnding): string {
  const normalized = normalizeLineEndings(text)
  return ending === 'CRLF' ? normalized.replaceAll('\n', '\r\n') : normalized
}

export function decodeUtf8Text(bytes: Uint8Array): TextEncodingInfo {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = bom ? bytes.slice(3) : bytes
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const text = decoder.decode(body)
  return { bom, text, lineEnding: detectLineEnding(text) }
}

export async function readMutationBytes(filePath: string): Promise<MutationBytes> {
  const bytes = await fs.readFile(filePath)
  return { bytes, hash: hashBytes(bytes), size: bytes.length }
}

export function encodeText(text: string, bom: boolean): Uint8Array {
  const stripped = stripUtf8Bom(text).text
  const body = new TextEncoder().encode(stripped)
  return bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...body]) : body
}

export async function writeIfUnchanged(filePath: string, expectedHash: string, content: Uint8Array): Promise<MutationBytes> {
  const current = await readMutationBytes(filePath)
  if (current.hash !== expectedHash) {
    throw new Error(`File changed during mutation: ${filePath}`)
  }
  await fs.writeFile(filePath, content)
  return { bytes: content, hash: hashBytes(content), size: content.length }
}

export async function createFileExclusive(filePath: string, content: Uint8Array): Promise<MutationBytes> {
  await fs.writeFile(filePath, content, { flag: 'wx' })
  return { bytes: content, hash: hashBytes(content), size: content.length }
}
/** Conditional delete counterpart to TermAgent's FileMutation conditional write. */
export async function removeIfUnchanged(filePath: string, expectedHash: string): Promise<MutationBytes> {
  const current = await readMutationBytes(filePath)
  if (current.hash !== expectedHash) {
    throw new Error(`File changed during mutation: ${filePath}`)
  }
  await fs.rm(filePath)
  return current
}
