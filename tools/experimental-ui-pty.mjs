import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const demo = path.join(root, 'experimental/ui-v2/dist/preview/demo.js')

function stripTerminalControl(value) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[=>7-9]/g, '')
    .replace(/\r/g, '')
}

export function runPreview({ width, height = width <= 60 ? 20 : 24, theme = 'termagent', color = 'plain', scene = 'default' }) {
  const env = {
    ...process.env,
    TERM: color === 'plain' ? 'dumb' : 'xterm-256color',
    COLORTERM: color === 'truecolor' ? 'truecolor' : '',
    NO_COLOR: color === 'plain' ? '1' : undefined,
    TERMAGENT_UI_PREVIEW_WIDTH: String(width),
    TERMAGENT_UI_PREVIEW_THEME: theme,
    TERMAGENT_UI_PREVIEW_SCENE: scene,
  }
  const ptyCols = Math.max(96, width + 12)
  const command = `stty cols ${ptyCols} rows ${Math.max(10, height)}; node ${JSON.stringify(demo)}`
  const raw = execFileSync('script', ['-qfec', command, '/dev/null'], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  return stripTerminalControl(raw).replace(/\n+$/, '')
}

export function assertSnapshot(width, theme, scene = 'default') {
  const content = runPreview({ width, theme, scene })
  const suffix = scene === 'default' ? `${theme}-${width}` : `${theme}-${width}-${scene}`
  const snapshot = path.join(root, 'tests/experimental/snapshots', `${suffix}.txt`)
  return { content, snapshot }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const width = Number(process.argv[2] || 80)
  const theme = process.argv[3] || 'termagent'
  const { content } = assertSnapshot(width, theme)
  process.stdout.write(content + '\n')
}
