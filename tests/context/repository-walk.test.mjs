// Regression tests for the repository-map fallback walker
// (dist/context/repository.js `fallbackFiles`). These reproduce the Windows
// launch crash where walking a home directory hit EPERM on an unreadable
// directory and crashed the whole CLI via buildRepositoryMap -> listFiles.
// The walker must skip unreadable directories, never crash, and honor the
// ignore list + depth bound. Tests import dist/ directly.
import test from 'node:test'
import assert from 'node:assert/strict'

// A tiny in-memory directory tree the injected reader serves.
// Keys are absolute dir paths; values are dirent-shaped objects.
function fakeReaddir(tree) {
  return (dir) => {
    const entries = tree.get(dir)
    if (!entries) {
      const error = new Error(`EPERM: operation not permitted, scandir '${dir}'`)
      error.code = 'EPERM'
      return Promise.reject(error)
    }
    return Promise.resolve(entries)
  }
}

function dir(name) {
  return { name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
}

function file(name) {
  return { name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }
}

function symlink(name, targetIsDir) {
  return { name, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true, targetIsDir }
}

test('fallback walker skips unreadable (EPERM) directories instead of crashing', async () => {
  const { fallbackFiles } = await import('../../dist/context/repository.js')
  const root = 'C:\\Users\\tester'
  const locked = 'C:\\Users\\tester\\AppData\\Local\\Temp\\hermes_kernel_0r_dj8ya'
  const tree = new Map([
    [root, [dir('docs'), dir('AppData'), file('README.md')]],
    ['C:\\Users\\tester\\docs', [file('guide.md')]],
    // AppData itself is now on the ignore list; even if a reader still serves
    // it, its locked Temp child would previously crash the walk.
    ['C:\\Users\\tester\\AppData\\Local\\Temp', [dir(locked)]],
    [locked, []],
  ])
  const readdir = fakeReaddir(tree)
  // Before the fix, the EPERM rejection from `locked` propagated out of walk()
  // and crashed the CLI. Now it must resolve with the reachable files only.
  const files = await fallbackFiles(root, { readdir })
  assert.deepEqual(files.sort(), ['docs\\guide.md', 'README.md'].sort())
})

test('fallback walker honors the depth bound on pathological trees', async () => {
  const { fallbackFiles } = await import('../../dist/context/repository.js')
  const root = '\\root'
  const tree = new Map()
  // Build a 10-level deep chain; depth cap of 3 must stop the walk early.
  let path = root
  tree.set(root, [dir('l1')])
  for (let i = 1; i <= 10; i++) {
    const next = `${path}\\l${i}`
    tree.set(next, i === 10 ? [file('deep.txt')] : [dir(`l${i + 1}`)])
    path = next
  }
  const readdir = fakeReaddir(tree)
  const files = await fallbackFiles(root, { readdir, maxDepth: 3 })
  assert.equal(files.length, 0, 'walk stops before reaching the level-10 file')
})

test('fallback walker ignores AppData/Library and never follows symlinked directories', async () => {
  const { fallbackFiles, DEFAULT_IGNORES } = await import('../../dist/context/repository.js')
  assert.equal(DEFAULT_IGNORES.has('AppData'), true, 'AppData on the ignore list for home-dir launches')
  assert.equal(DEFAULT_IGNORES.has('Library'), true, 'Library on the ignore list for macOS-style trees')
  const root = '\\home'
  const tree = new Map([
    [root, [dir('AppData'), dir('Library'), dir('project'), symlink('junction', true)]],
    ['\\home\\AppData', [file('secret.txt')]],
    ['\\home\\Library', [file('prefs.txt')]],
    ['\\home\\project', [file('index.ts')]],
  ])
  // The junction points back at root (a loop); it must not be followed.
  tree.set('\\home\\junction', tree.get(root))
  const readdir = fakeReaddir(tree)
  const files = await fallbackFiles(root, { readdir })
  assert.deepEqual(files.sort(), ['project\\index.ts'])
})
