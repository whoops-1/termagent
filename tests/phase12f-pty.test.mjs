import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)

function run(scene, width, height) {
  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1', COLORTERM: '' }
  const command = `stty cols ${width} rows ${height}; node ${JSON.stringify(path.join(root, 'tools/phase12f-production-pty.mjs'))} ${scene}`
  const raw = execFileSync('script', ['-qfec', command, '/dev/null'], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[=>7-9]/g, '')
    .replace(/\r/g, '')
}

for (const [scene, width, height] of [
  ['startup', 40, 20], ['startup', 56, 20], ['startup', 80, 24],
  ['transcript', 40, 20], ['transcript', 80, 24],
  ['picker', 40, 20], ['picker', 80, 24],
  ['inline-diff', 56, 20], ['inline-diff', 80, 24],
  ['diff-inspector', 40, 20], ['diff-inspector', 120, 30],
  ['permission', 48, 20], ['permission', 80, 24],
  ['question', 40, 20], ['question', 80, 24],
]) {
  test(`production PTY ${scene} at ${width}x${height} renders safely`, () => {
    const output = run(scene, width, height)
    assert.match(output, /__TERMAGENT_12F_PTY_OK__/)
    const marker = scene === 'permission' ? 'PTY_PERMISSION_MARKER'
      : scene === 'question' ? 'PTY_QUESTION_MARKER'
        : scene === 'picker' ? 'PTY picker marker'
          : scene === 'transcript' ? 'PTY transcript identity marker'
            : scene === 'inline-diff' ? 'PTY diff marker'
              : scene === 'diff-inspector' ? 'Working tree changes'
                : 'TermAgent'
    assert.match(output, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
}
