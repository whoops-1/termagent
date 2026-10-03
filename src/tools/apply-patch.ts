import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { within } from '../util/fs.js'
import { renderTextDiff } from '../diff/render.js'
import * as Patch from '../patch.js'
import {
  convertLineEndings,
  createFileExclusive,
  decodeUtf8Text,
  encodeText,
  readMutationBytes,
  removeIfUnchanged,
  withFileMutationLock,
  writeIfUnchanged,
} from './file-mutation.js'
import type { ToolDefinition } from './types.js'

const MAX_PATCH_BYTES = 200_000
const MAX_DIFF_BYTES = 24_000

type PreparedChange = {
  type: 'add' | 'update' | 'delete'
  target: string
  resource: string
  beforeText: string
  afterText: string
  expectedHash?: string
  bytes: Uint8Array
}

function canonicalTarget(cwd: string, raw: string, scopePaths?: string[]) {
  const target = path.resolve(cwd, raw)
  if (!within(cwd, target)) throw new Error(`Path escapes project: ${raw}`)
  if (scopePaths?.length && !scopePaths.some(scope => within(path.resolve(cwd, scope), target))) {
    throw new Error(`Path is outside the agent workspace scope: ${raw}`)
  }
  return target
}

function resourceFor(cwd: string, target: string) {
  const relative = path.relative(cwd, target).replaceAll('\\', '/')
  return relative || path.basename(target)
}

function parsePatchText(patchText: string) {
  if (Buffer.byteLength(patchText, 'utf8') > MAX_PATCH_BYTES) {
    throw new Error(`Patch is too large (maximum ${MAX_PATCH_BYTES} bytes)`)
  }
  if (!patchText.trim()) throw new Error('patchText is required')
  const hunks = Patch.parse(patchText)
  if (hunks.length === 0) throw new Error('patch rejected: empty patch')
  const move = hunks.find(hunk => hunk.type === 'update' && hunk.movePath !== undefined)
  if (move) throw new Error('apply_patch moves are not supported yet')
  return hunks
}

async function statMaybe(target: string) {
  try { return await fs.stat(target) } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}

async function prepareChanges(patchText: string, ctx: Parameters<NonNullable<ToolDefinition['execute']>>[1]): Promise<PreparedChange[]> {
  const hunks = parsePatchText(patchText)
  const prepared: PreparedChange[] = []
  for (const hunk of hunks) {
    const target = canonicalTarget(ctx.cwd, hunk.path, ctx.scopePaths)
    const resource = resourceFor(ctx.cwd, target)
    const stat = await statMaybe(target)

    if (hunk.type === 'add') {
      if (stat) throw new Error(`Cannot add ${resource}: target already exists`)
      const { bom, text } = decodeUtf8Text(new TextEncoder().encode(hunk.contents))
      const afterText = text.endsWith('\n') || text === '' ? text : `${text}\n`
      prepared.push({
        type: 'add',
        target,
        resource,
        beforeText: '',
        afterText: afterText,
        bytes: encodeText(afterText, bom),
      })
      continue
    }

    if (!stat) throw new Error(`${hunk.type === 'update' ? 'Cannot update' : 'Cannot delete'} ${resource}: file does not exist`)
    if (!stat.isFile()) throw new Error(`${resource} is not a regular file`)

    const current = await readMutationBytes(target)
    const source = decodeUtf8Text(current.bytes)
    const originalWithBom = source.bom ? `\uFEFF${source.text}` : source.text

    if (hunk.type === 'delete') {
      prepared.push({
        type: 'delete',
        target,
        resource,
        beforeText: source.text,
        afterText: '',
        expectedHash: current.hash,
        bytes: new Uint8Array(),
      })
      continue
    }

    const derived = Patch.derive(target, hunk.chunks, originalWithBom)
    const afterText = convertLineEndings(derived.content, source.lineEnding)
    prepared.push({
      type: 'update',
      target,
      resource,
      beforeText: source.text,
      afterText,
      expectedHash: current.hash,
      bytes: encodeText(afterText, source.bom || derived.bom),
    })
  }
  return prepared
}

export function applyPatchTool(): ToolDefinition {
  return {
    name: 'apply_patch',
    risk: 'write',
    readOnly: false,
    concurrency: 'unsafe',
    parallelSafe: false,
    description: 'Apply one validated patch containing add, update, and delete file operations. All targets are preflight-checked before the single edit permission approval. Operations apply sequentially; a later failure reports any earlier changes explicitly.',
    schema: {
      type: 'object',
      properties: {
        patchText: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_PATCH_BYTES,
          description: 'The full patch text that describes add, update, and delete operations.',
        },
      },
      required: ['patchText'],
      additionalProperties: false,
    },
    permission: {
      action: 'edit',
      resources: (args, ctx) => parsePatchText(String(args.patchText)).map(hunk => resourceFor(ctx.cwd, canonicalTarget(ctx.cwd, hunk.path, ctx.scopePaths))),
    },
    preflight: async (args, ctx) => {
      await prepareChanges(String(args.patchText), ctx)
    },
    async execute(args, ctx) {
      const prepared = await prepareChanges(String(args.patchText), ctx)
      const files = [] as Array<Record<string, unknown>>
      for (const change of prepared) {
        const diff = await renderTextDiff(change.resource, change.beforeText, change.afterText, { maxBytes: MAX_DIFF_BYTES })
        files.push({
          resource: change.resource,
          type: change.type,
          additions: diff.additions,
          deletions: diff.deletions,
          diff: diff.text,
        })
      }

      const applied: Array<Record<string, unknown>> = []
      let activeChange: PreparedChange | undefined
      try {
        for (const change of prepared) {
          activeChange = change
          if (change.type === 'add') {
            await fs.mkdir(path.dirname(change.target), { recursive: true })
            await createFileExclusive(change.target, change.bytes)
          } else if (change.type === 'update') {
            await withFileMutationLock(change.target, async () => {
              await writeIfUnchanged(change.target, change.expectedHash!, change.bytes)
            })
          } else {
            await withFileMutationLock(change.target, async () => {
              await removeIfUnchanged(change.target, change.expectedHash!)
            })
          }
          ctx.readFileState?.invalidate(change.target)
          applied.push({ type: change.type, resource: change.resource, target: change.target })
          activeChange = undefined
        }
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        if (applied.length === 0) throw new Error(`Unable to apply patch${activeChange ? ` at ${activeChange.resource}` : ''}: ${cause}`)
        throw new Error(`Patch partially applied before failing at ${activeChange?.resource || 'unknown target'}. Applied: ${applied.map(item => String(item.resource)).join(', ')}. ${cause}`)
      }

      const summary = applied.length
        ? ['Applied patch sequentially:', ...applied.map(item => `${item.type === 'add' ? 'A' : item.type === 'delete' ? 'D' : 'M'} ${item.resource}`)].join('\n')
        : 'Applied patch sequentially: no file changes.'
      const totalAdditions = files.reduce((sum, file) => sum + Number(file.additions || 0), 0)
      const totalDeletions = files.reduce((sum, file) => sum + Number(file.deletions || 0), 0)
      return {
        title: `apply_patch ${applied.length} file${applied.length === 1 ? '' : 's'}`,
        output: summary,
        metadata: {
          patch: {
            applied,
            partial: false,
            preflightValidated: true,
            fileCount: files.length,
            additions: totalAdditions,
            deletions: totalDeletions,
            files,
          },
          mutation: {
            operation: 'batch',
            files: prepared.map(change => ({
              path: change.resource,
              operation: change.type === 'add' ? 'create' : change.type === 'delete' ? 'delete' : 'update',
              beforeHash: change.type === 'add' ? null : change.expectedHash ?? null,
              afterHash: change.type === 'delete' ? undefined : crypto.createHash('sha256').update(change.bytes).digest('hex'),
              additions: files.find(file => file.resource === change.resource)?.additions,
              deletions: files.find(file => file.resource === change.resource)?.deletions,
            })),
          },
        },
      }
    },
  }
}
