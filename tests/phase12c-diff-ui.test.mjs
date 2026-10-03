import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { normalizeDiffMetadata, parseDiffDocument, renderDiffFile, renderDiffFiles } from '../dist/design-system/diff.js'
import { stripAnsi, widthOf } from '../dist/design-system/ansi.js'
import { THEMES } from '../dist/design-system/theme.js'
import { TerminalUI } from '../dist/cli/ui.js'

const theme = THEMES.termagent

function wait(ms = 20) { return new Promise(resolve => setTimeout(resolve, ms)) }

function captureOutput(columns = 90, rows = 28) {
  const writes = []
  const output = { columns, rows, write(chunk) { writes.push(String(chunk)); return true }, on() {}, off() {} }
  return { writes, output }
}

function assertRowsFit(rows, width) {
  for (const row of rows) assert.ok(widthOf(row) <= width, `row exceeded ${width}: ${stripAnsi(row)}`)
}

const patch = [
  'diff --git a/src/demo.ts b/src/demo.ts',
  'index 111..222 100644',
  '--- a/src/demo.ts',
  '+++ b/src/demo.ts',
  '@@ -1,4 +1,5 @@',
  ' import one',
  '-const before = 1',
  '+const before = 2',
  '+const extra = true',
  ' const after = 3',
].join('\n')

const patchTwo = [
  'diff --git a/src/other.ts b/src/other.ts',
  '--- a/src/other.ts',
  '+++ b/src/other.ts',
  '@@ -2,2 +2,2 @@',
  '-old line',
  '+new line',
].join('\n')

test('Phase 12C shared diff parser normalizes git patches into reusable file records', () => {
  const result = parseDiffDocument(`${patch}\n${patchTwo}`)
  assert.equal(result.files.length, 2)
  assert.equal(result.files[0].path, 'src/demo.ts')
  assert.equal(result.files[0].additions, 2)
  assert.equal(result.files[0].deletions, 1)
  assert.equal(result.files[1].path, 'src/other.ts')
  assert.equal(result.additions, 3)
  assert.equal(result.deletions, 2)
})

test('Phase 12C shared diff renderer is width-safe and supports unified and split layouts', () => {
  for (const width of [40, 56, 80, 120, 140]) {
    for (const view of ['unified', 'split']) {
      const rows = renderDiffFile({
        width,
        file: { path: 'src/demo.ts', patch, additions: 2, deletions: 1, status: 'modified' },
        theme,
        capability: 'plain',
        view,
        maxRows: 40,
      })
      assertRowsFit(rows, width)
      const plain = rows.map(stripAnsi).join('\n')
      assert.match(plain, /src\/demo\.ts/)
      if (width >= 80) {
        assert.match(plain, /before = 1/)
        assert.match(plain, /before = 2/)
        assert.match(plain, /extra = true/)
      }
      assert.match(plain, /[+\-]/)
      assert.match(plain, /1/) // line-number gutter exists in both layouts
    }
  }
})

test('Phase 12C shared diff metadata normalizer supports multi-file apply-patch snapshots', () => {
  const files = normalizeDiffMetadata({
    files: [
      { relativePath: 'src/demo.ts', diff: patch, additions: 2, deletions: 1, type: 'modify' },
      { relativePath: 'src/other.ts', diff: patchTwo, additions: 1, deletions: 1, type: 'modify' },
    ],
  })
  assert.equal(files.length, 2)
  assert.deepEqual(files.map(file => file.path), ['src/demo.ts', 'src/other.ts'])
  const rows = renderDiffFiles({ width: 80, files, theme, capability: 'plain', view: 'unified', maxRows: 80, gapRows: 0 })
  assertRowsFit(rows, 80)
  const plain = rows.map(stripAnsi).join('\n')
  assert.match(plain, /src\/demo\.ts/)
  assert.match(plain, /src\/other\.ts/)
})

test('Phase 12C TerminalUI renders write/edit diffs inline in the main transcript', async () => {
  const { writes, output } = captureOutput(90, 30)
  const ui = new TerminalUI({ title: 'inline-diff', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    ui.startTool('edit_file', { path: 'src/demo.ts' })
    ui.endTool('edit_file', 'edited 1 occurrence', {
      diff: patch,
      fileDiff: { path: 'src/demo.ts', additions: 2, deletions: 1 },
    })
    await wait()
    const plain = stripAnsi(writes.at(-1) || '')
    assert.match(plain, /edit_file/)
    assert.match(plain, /src\/demo\.ts/)
    assert.match(plain, /- const before = 1/)
    assert.match(plain, /\+ const before = 2/)
    assert.match(plain, /\+ const extra = true/)
    assert.doesNotMatch(plain, /diff --git/)
    assert.doesNotMatch(plain, /index 111/)
  } finally {
    ui.leave()
  }
})

test('Phase 12C TerminalUI renders multi-file apply-patch diffs inline', async () => {
  const { writes, output } = captureOutput(100, 34)
  const ui = new TerminalUI({ title: 'apply-patch', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    ui.startTool('apply_patch', { files: ['src/demo.ts', 'src/other.ts'] })
    ui.endTool('apply_patch', 'patched 2 files', {
      files: [
        { relativePath: 'src/demo.ts', diff: patch, additions: 2, deletions: 1 },
        { relativePath: 'src/other.ts', diff: patchTwo, additions: 1, deletions: 1 },
      ],
    })
    await wait()
    const plain = stripAnsi(writes.at(-1) || '')
    assert.match(plain, /src\/demo\.ts/)
    assert.match(plain, /src\/other\.ts/)
    assert.match(plain, /- old line/)
    assert.match(plain, /\+ new line/)
  } finally {
    ui.leave()
  }
})

test('Phase 12C Ctrl+O uses the shared renderer and supports list navigation and detail scrolling', async () => {
  const { writes, output } = captureOutput(100, 32)
  const ui = new TerminalUI({ title: 'diff-inspector', model: 'mock', provider: 'openai-compatible', mode: 'build', cwd: process.cwd(), output })
  try {
    ui.enter()
    ui.openWorkingTreeDiff({
      text: `${patch}\n${patchTwo}`,
      files: [
        { path: 'src/demo.ts', additions: 2, deletions: 1 },
        { path: 'src/other.ts', additions: 1, deletions: 1 },
      ],
      additions: 3,
      deletions: 2,
    }, 'Working tree')
    await wait()
    assert.equal(ui['inspector']?.selected, 0)
    ui['onInspectorData']?.('\x1b[B')
    await wait()
    assert.equal(ui['inspector']?.selected, 1)
    ui['onInspectorData']?.('\r')
    await wait()
    assert.equal(ui['inspector']?.view, 'detail')
    assert.match(stripAnsi(writes.at(-1) || ''), /src\/other\.ts/)
    const longPatch = [
      '--- a/src/other.ts',
      '+++ b/src/other.ts',
      '@@ -1,80 +1,80 @@',
      ...Array.from({ length: 78 }, (_, i) => ` line-${i + 1}`),
      '-old line',
      '+new line',
    ].join('\n')
    ui['inspector'].files[1].patch = longPatch
    ui['inspector'].selected = 1
    ui['inspector'].scroll = 0
    ui['onInspectorData']?.('j'.repeat(12))
    await wait()
    assert.ok((ui['inspector']?.scroll ?? 0) > 0)
    const detail = stripAnsi(writes.at(-1) || '')
    assert.match(detail, /more rows|new line|line-78/)
  } finally {
    ui.leave()
  }
})

test('Phase 12C diff geometry is identical across plain, ANSI16, ANSI256, and truecolor', () => {
  for (const capability of ['plain', 'ansi16', 'ansi256', 'truecolor']) {
    for (const width of [40, 56, 80, 120, 140]) {
      for (const view of ['unified', 'split']) {
        const rows = renderDiffFile({
          width,
          file: { path: 'src/demo.ts', patch, additions: 2, deletions: 1 },
          theme,
          capability,
          view,
          maxRows: 20,
        })
        assertRowsFit(rows, width)
        assert.equal(rows.length, renderDiffFile({
          width,
          file: { path: 'src/demo.ts', patch, additions: 2, deletions: 1 },
          theme,
          capability: 'plain',
          view,
          maxRows: 20,
        }).length)
      }
    }
  }
})

test('Phase 12C diff parser tolerates CRLF patches and preserves hunk line numbers', () => {
  const crlf = patch.replaceAll('\n', '\r\n')
  const parsed = parseDiffDocument(crlf)
  assert.equal(parsed.files.length, 1)
  const rows = renderDiffFile({ width: 80, file: parsed.files[0], theme, capability: 'plain', view: 'unified', maxRows: 20 })
  assert.match(stripAnsi(rows.join('\n')), /1\s+1\s+import one/)
})

test('Phase 12C multi-file renderer obeys one global row budget', () => {
  const files = normalizeDiffMetadata({ files: [
    { relativePath: 'a.ts', diff: patch, additions: 2, deletions: 1 },
    { relativePath: 'b.ts', diff: patchTwo, additions: 1, deletions: 1 },
  ] })
  const rows = renderDiffFiles({ width: 80, files, theme, capability: 'plain', view: 'unified', maxRows: 7, gapRows: 1 })
  assert.equal(rows.length, 7)
  assert.match(stripAnsi(rows.at(-1) || ''), /more file changes|diff truncated/)
  assertRowsFit(rows, 80)
})

test('Phase 12C shared diff renderer adds syntax-aware tokens without breaking row backgrounds', () => {
  const rows = renderDiffFile({
    width: 80,
    file: { path: 'src/demo.ts', patch, additions: 2, deletions: 1 },
    theme,
    capability: 'ansi256',
    view: 'unified',
    maxRows: 20,
  })
  const colored = rows.join('')
  assert.match(colored, /\x1b\[38;5;/)
  assert.ok(colored.includes('const'))
  assertRowsFit(rows, 80)
})

test('Phase 12C diff renderer respects maxRows including its truncation marker', () => {
  const longPatch = [
    '--- a/src/demo.ts',
    '+++ b/src/demo.ts',
    '@@ -1,40 +1,40 @@',
    ...Array.from({ length: 40 }, (_, i) => ` line ${i + 1}`),
  ].join('\n')
  const rows = renderDiffFile({
    width: 70,
    file: { path: 'src/demo.ts', patch: longPatch, additions: 0, deletions: 0, truncated: true },
    theme,
    capability: 'plain',
    view: 'unified',
    maxRows: 8,
  })
  assert.equal(rows.length, 8)
  assert.match(stripAnsi(rows.at(-1) || ''), /diff truncated/)
})

test('Phase 12C shared diff renderer exposes binary, large, and untracked states', () => {
  const cases = [
    { file: { path: 'assets/logo.png', patch: 'Binary files a/assets/logo.png and b/assets/logo.png differ', additions: 0, deletions: 0, binary: true }, expected: 'Binary file' },
    { file: { path: 'src/huge.ts', patch: '', additions: 0, deletions: 0, large: true }, expected: 'Large file' },
    { file: { path: 'src/new.ts', patch: '', additions: 0, deletions: 0, status: 'untracked' }, expected: 'Untracked file' },
  ]
  for (const item of cases) {
    const rows = renderDiffFile({ width: 70, file: item.file, theme, capability: 'plain', view: 'unified', maxRows: 8 })
    assert.match(stripAnsi(rows.join('\n')), new RegExp(item.expected))
    assertRowsFit(rows, 70)
  }
})

test('Phase 12C permission diff preview uses the same shared renderer geometry', async () => {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input

  const writes = []
  const output = new EventEmitter()
  output.columns = 100
  output.rows = 32
  output.write = (chunk) => { writes.push(String(chunk)); return true }

  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const os = await import('node:os')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-phase12c-perm-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/demo.ts'), 'const before = 1\n', 'utf8')

  const ui = new TerminalUI({
    title: 'permission-diff',
    model: 'mock',
    provider: 'openai-compatible',
    mode: 'build',
    cwd: root,
    output,
    input,
  })
  const tool = { name: 'edit_file', description: 'edit', risk: 'write', schema: { type: 'object' } }
  try {
    ui.enter()
    const pending = ui.requestPermission({ tool, args: { path: 'src/demo.ts', oldText: 'before = 1', newText: 'before = 2' } })
    await wait(50)
    const screen = stripAnsi(writes.join(''))
    assert.match(screen, /Permission required/)
    assert.match(screen, /changes/)
    assert.match(screen, /src\/demo\.ts/)
    assert.match(screen, /-.*const before = 1/)
    assert.match(screen, /\+.*const before = 2/)
    assert.match(screen, /Allow once/)
    input.emit('data', 'n')
    assert.equal(await pending, 'deny')
  } finally {
    ui.leave()
    await fs.rm(root, { recursive: true, force: true })
  }
})
