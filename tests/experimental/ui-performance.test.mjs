import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const root = path.resolve('experimental/ui-v2/dist/design-system')
const markdown = await import(path.join(root, 'markdown.js'))
const transcript = await import(path.join(root, 'transcript.js'))
const activity = await import(path.join(root, 'activity.js'))
const theme = await import(path.join(root, 'theme.js'))
const ansi = await import(path.join(root, 'ansi.js'))

function buildLongResponse(lines = 900) {
  const chunks = [
    '# Long response performance fixture',
    '',
    'This fixture intentionally mixes headings, lists, inline code and fenced code so the renderer exercises more than the plain-text fast path.',
    '',
    '```ts',
    'export function fibonacci(n: number): number {',
    '  if (n <= 1) return n',
    '  return fibonacci(n - 1) + fibonacci(n - 2)',
    '}',
    '```',
    '',
    '| Feature | State |',
    '| --- | --- |',
    '| Markdown | Ready |',
    '| Tables | Ready |',
    '',
  ]
  for (let i = 0; i < lines; i++) {
    chunks.push(`- item ${i + 1}: the renderer should keep this response width-safe while retaining semantic formatting and readable wrapping.`)
  }
  return chunks.join('\n')
}

test('long Markdown responses render within a practical interactive budget', () => {
  const t = theme.getTheme('termagent')
  const source = buildLongResponse()
  const started = performance.now()
  const rows = markdown.renderMarkdown(source, { width: 80, theme: t, capability: 'truecolor' })
  const elapsed = performance.now() - started

  assert.ok(rows.length > 900)
  assert.ok(rows.every(row => ansi.widthOf(row) <= 80))
  // This is intentionally a generous interactive ceiling, not a microbenchmark.
  assert.ok(elapsed < 1500, `long-response renderer took ${elapsed.toFixed(1)}ms`)
})

test('active streaming presentation survives deterministic width changes', () => {
  const t = theme.getTheme('termagent')
  const response = buildLongResponse(180)
  const widths = [80, 60, 40, 72, 50]

  for (const [index, width] of widths.entries()) {
    const prefix = response.slice(0, Math.floor(response.length * ((index + 2) / (widths.length + 2))))
    const rows = markdown.renderMarkdown(prefix, { width, theme: t, capability: 'truecolor' })
    const status = activity.renderActivity({
      width,
      phase: 'writing',
      label: 'Writing response',
      elapsedSeconds: index + 1,
      frame: index,
      theme: t,
      capability: 'truecolor',
    })
    const assistant = transcript.renderAssistantTurn({
      text: prefix.slice(-Math.min(prefix.length, 600)),
      reasoning: 'Streaming response in a resized viewport.',
      width,
      theme: t,
      capability: 'truecolor',
    })

    for (const row of [...rows, status, ...assistant]) {
      assert.ok(ansi.widthOf(row) <= width, `row overflowed ${width}: ${ansi.stripAnsi(row)}`)
    }
    assert.match(ansi.stripAnsi(status), /Writing response/)
  }
})
