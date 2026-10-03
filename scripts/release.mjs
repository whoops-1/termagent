#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { TARGETS } from '../src/release/targets.mjs'

const exec = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = path.join(root, 'dist')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const defaultOut = path.join(root, 'release')
const files = [
  'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md',
]
const dirs = ['dist', 'docs']

function sha256File(file) {
  return readFile(file).then(buf => createHash('sha256').update(buf).digest('hex'))
}

async function assertBuild() {
  try { await stat(path.join(dist, 'index.js')) }
  catch { throw new Error('dist/index.js is missing; run `npm run build` before creating a release bundle') }
}

async function cleanDir(dir) { await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true }) }

async function copyTree(dest) {
  await cleanDir(dest)
  for (const file of files) await cp(path.join(root, file), path.join(dest, file))
  for (const dir of dirs) await cp(path.join(root, dir), path.join(dest, dir), { recursive: true })
  await mkdir(path.join(dest, 'scripts'), { recursive: true })
  await cp(path.join(root, 'scripts/device-smoke.mjs'), path.join(dest, 'scripts/device-smoke.mjs'))
  await writeFile(path.join(dest, 'TARGET-INFO.json'), JSON.stringify({
    product: pkg.name,
    version,
    runtime: pkg.engines,
    note: 'JavaScript release bundle; target identifies the tested runtime class and installer selection, not a native TermAgent binary.',
  }, null, 2) + '\n')
}

async function tarGz(sourceDir, archive) {
  await mkdir(path.dirname(archive), { recursive: true })
  const version = await exec('tar', ['--version']).then(result => result.stdout.split('\n')[0]).catch(() => '')
  if (!version.startsWith('tar (GNU tar)')) {
    throw new Error('deterministic release packaging requires GNU tar (release CI uses Ubuntu GNU tar)')
  }
  await exec('tar', [
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf', archive,
    '-C', sourceDir, '.',
  ])
}

async function bundleTarget(target, outRoot) {
  if (!TARGETS[target]) throw new Error(`Unknown target: ${target}`)
  await assertBuild()
    const bundleRoot = path.join(outRoot, `termagent-${version}-${target}`)
  await copyTree(bundleRoot)
  const info = JSON.parse(await readFile(path.join(bundleRoot, 'TARGET-INFO.json'), 'utf8'))
  info.target = { id: target, ...TARGETS[target] }
  await writeFile(path.join(bundleRoot, 'TARGET-INFO.json'), JSON.stringify(info, null, 2) + '\n')
  const archive = path.join(outRoot, `termagent-${version}-${target}.tar.gz`)
  await tarGz(bundleRoot, archive)
  await rm(bundleRoot, { recursive: true, force: true })
  return archive
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const targets = process.argv.slice(2).filter(arg => arg in TARGETS)
  const selected = targets.length ? [...new Set(targets)] : Object.keys(TARGETS)
  const out = process.env.TERMAGENT_RELEASE_DIR ? path.resolve(process.env.TERMAGENT_RELEASE_DIR) : defaultOut
  if (args.has('clean')) await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  if (args.has('manifest-only')) return writeManifest(out, selected)
  const archives = []
  for (const target of selected) archives.push(await bundleTarget(target, out))
  await writeManifest(out, selected)
  console.log(archives.join('\n'))
}

async function writeManifest(out, selected) {
  const entries = []
  const releaseFiles = await readdir(out)
  for (const name of releaseFiles.filter(name => name.endsWith('.tar.gz')).sort()) {
    const file = path.join(out, name)
    entries.push({ name, sha256: await sha256File(file), bytes: (await stat(file)).size })
  }
  const manifest = {
    schema: 1,
    product: pkg.name,
    version,
    generatedAt: new Date().toISOString(),
    runtime: pkg.engines,
    targets: Object.fromEntries(selected.map(target => [target, TARGETS[target]])),
    artifacts: entries,
  }
  await writeFile(path.join(out, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(path.join(out, 'SHA256SUMS'), entries.map(item => `${item.sha256}  ${item.name}`).join('\n') + (entries.length ? '\n' : ''))
}

await main()
