import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = path.resolve('.')

function temp(prefix) { return mkdtemp(path.join(os.tmpdir(), prefix)) }

async function runRelease(args, env = {}) {
  return exec(process.execPath, [path.join(root, 'scripts/release.mjs'), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 2 * 1024 * 1024,
  })
}

test('release target mapping covers the Termux ARMv7 contract', async () => {
  const { currentTarget, TARGETS } = await import('../src/release/targets.mjs')
  assert.equal(currentTarget({}, 'android', 'arm'), 'android-armv7')
  assert.equal(currentTarget({}, 'android', 'arm64'), 'android-arm64')
  assert.equal(currentTarget({}, 'linux', 'arm'), 'linux-armv7')
  assert.equal(currentTarget({}, 'linux', 'x64'), 'linux-x64')
  assert.equal(currentTarget({}, 'linux', 'arm64'), 'linux-arm64')
  assert.equal(TARGETS['android-armv7'].abi, 'armeabi-v7a')
  assert.equal(TARGETS['android-armv7'].triple, 'armv7a-linux-androideabi')
})

test('forced release target is validated rather than silently invented', async () => {
  const { currentTarget } = await import('../src/release/targets.mjs')
  assert.equal(currentTarget({ TERMAGENT_TARGET: 'android-armv7' }, 'linux', 'x64'), 'android-armv7')
  assert.throws(() => currentTarget({ TERMAGENT_TARGET: 'android-mips' }, 'linux', 'x64'), /Unsupported TERMAGENT_TARGET/)
})

test('release builder creates target bundle and checksum manifest', async () => {
  const out = await temp('termagent-release-')
  try {
    await runRelease(['android-armv7', 'linux-x64'], { TERMAGENT_RELEASE_DIR: out })
    const archive = path.join(out, 'termagent-1.18.0-android-armv7.tar.gz')
    assert.ok((await stat(archive)).size > 0)
    const sums = await readFile(path.join(out, 'SHA256SUMS'), 'utf8')
    assert.match(sums, /termagent-1\.18\.0-android-armv7\.tar\.gz/)
    assert.match(sums, /termagent-1\.18\.0-linux-x64\.tar\.gz/)
    const manifest = JSON.parse(await readFile(path.join(out, 'release-manifest.json'), 'utf8'))
    assert.deepEqual(Object.keys(manifest.targets), ['android-armv7', 'linux-x64'])
    assert.equal(manifest.artifacts.length, 2)
    assert.ok(manifest.artifacts.every(item => /^[0-9a-f]{64}$/.test(item.sha256)))
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('release bundle contains no node_modules and has the production entrypoint', async () => {
  const out = await temp('termagent-release-bundle-')
  const extract = await temp('termagent-release-extract-')
  try {
    await runRelease(['android-armv7'], { TERMAGENT_RELEASE_DIR: out })
    const archive = path.join(out, 'termagent-1.18.0-android-armv7.tar.gz')
    await exec('tar', ['-xzf', archive, '-C', extract])
    assert.ok((await stat(path.join(extract, 'dist/index.js'))).size > 0)
    assert.ok((await stat(path.join(extract, 'TARGET-INFO.json'))).size > 0)
    assert.ok((await stat(path.join(extract, 'scripts/device-smoke.mjs'))).size > 0)
    await assert.rejects(stat(path.join(extract, 'node_modules')))
    const info = JSON.parse(await readFile(path.join(extract, 'TARGET-INFO.json'), 'utf8'))
    assert.equal(info.target.id, 'android-armv7')
    assert.equal(info.target.abi, 'armeabi-v7a')
  } finally {
    await rm(out, { recursive: true, force: true })
    await rm(extract, { recursive: true, force: true })
  }
})
test('release archives are byte-stable across repeated builds', async () => {
  const first = await temp('termagent-release-stable-a-')
  const second = await temp('termagent-release-stable-b-')
  try {
    await runRelease(['linux-x64'], { TERMAGENT_RELEASE_DIR: first })
    await runRelease(['linux-x64'], { TERMAGENT_RELEASE_DIR: second })
    const a = await readFile(path.join(first, 'termagent-1.18.0-linux-x64.tar.gz'))
    const b = await readFile(path.join(second, 'termagent-1.18.0-linux-x64.tar.gz'))
    assert.deepEqual(a, b)
  } finally {
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})
test('installer selects the Android ARMv7 bundle when the target is forced', async () => {
  const release = await temp('termagent-installer-android-release-')
  const prefix = await temp('termagent-installer-android-prefix-')
  try {
    await runRelease(['android-armv7'], { TERMAGENT_RELEASE_DIR: release })
    const result = await exec('sh', ['scripts/install.sh'], {
      cwd: root,
      env: {
        ...process.env,
        TERMAGENT_VERSION: '1.18.0',
        TERMAGENT_RELEASE_BASE_URL: `file://${release}/`,
        TERMAGENT_TARGET: 'android-armv7',
        PREFIX: prefix,
      },
      maxBuffer: 1024 * 1024,
    })
    assert.match(result.stdout, /1\.18\.0/)
    const installed = await readFile(path.join(prefix, 'lib', 'termagent', 'TARGET-INFO.json'), 'utf8')
    assert.match(installed, /"id": "android-armv7"/)
  } finally {
    await rm(release, { recursive: true, force: true })
    await rm(prefix, { recursive: true, force: true })
  }
})

test('installer accepts a local verified prebuilt bundle', async () => {
  const release = await temp('termagent-installer-release-')
  const prefix = await temp('termagent-installer-prefix-')
  try {
    await runRelease(['linux-x64'], { TERMAGENT_RELEASE_DIR: release })
    const result = await exec('sh', ['scripts/install.sh'], {
      cwd: root,
      env: {
        ...process.env,
        TERMAGENT_VERSION: '1.18.0',
        TERMAGENT_RELEASE_BASE_URL: `file://${release}/`,
        TERMAGENT_TARGET: 'linux-x64',
        PREFIX: prefix,
      },
      maxBuffer: 1024 * 1024,
    })
    assert.match(result.stdout, /checksum verified/)
    assert.equal(await readFile(path.join(prefix, 'lib', 'termagent', 'dist', 'index.js'), 'utf8') !== '', true)
    assert.ok((await stat(path.join(prefix, 'bin', 'termagent-device-smoke'))).size > 0)
  } finally {
    await rm(release, { recursive: true, force: true })
    await rm(prefix, { recursive: true, force: true })
  }
})

test('installer documents prebuilt-first and source fallback paths', async () => {
  const installer = await readFile(path.join(root, 'scripts/install.sh'), 'utf8')
  assert.match(installer, /trying prebuilt bundle/)
  assert.match(installer, /checksum verified/)
  assert.match(installer, /build_source\(\)/)
  assert.match(installer, /npm exec --yes --package "typescript@5\.8\.3"/)
})

test('installer refuses an unqualified custom release base URL', async () => {
  const release = await temp('termagent-installer-base-')
  const prefix = await temp('termagent-installer-prefix-')
  try {
    const result = await exec('sh', ['scripts/install.sh'], {
      cwd: root,
      env: {
        ...process.env,
        TERMAGENT_RELEASE_BASE_URL: `file://${release}/`,
        TERMAGENT_REPO: '',
        TERMAGENT_VERSION: '',
        PREFIX: prefix,
      },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).catch(error => ({ error }))
    assert.notEqual(result.error, undefined)
    assert.match(result.error.stderr, /TERMAGENT_VERSION is required/) 
  } finally {
    await rm(release, { recursive: true, force: true })
    await rm(prefix, { recursive: true, force: true })
  }
})

test('physical device smoke script enforces Termux ARM targets unless explicitly rehearsed elsewhere', async () => {
  const script = await readFile(path.join(root, 'scripts/device-smoke.mjs'), 'utf8')
  assert.match(script, /TERMUX_VERSION/)
  assert.match(script, /android-armv7/)
  assert.match(script, /nativeAddons/)
  assert.match(script, /dist\/index\.js/)
})
