import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireDaemonOwner, processStartIdentity, readDaemonOwner } from '../../dist/server/daemon-owner.js'

// NOTE: canonical home for daemon-owner tests would be tests/server/ per
// REPO-STRUCTURE.md; this file lives in tests/util/ because work stream
// 14I-S3 may only add tests under tests/util/ and tests/config/.

async function tempDir(prefix) { return fs.mkdtemp(path.join(os.tmpdir(), prefix)) }

test('processStartIdentity never throws and degrades to undefined without platform identity', async () => {
  // A pid that cannot exist never has readable identity data; the helper must
  // degrade instead of crashing.
  assert.strictEqual(await processStartIdentity(-4242), undefined)
  if (process.platform !== 'linux') {
    assert.strictEqual(await processStartIdentity(process.pid), undefined)
  }
})

test('daemon owner records pid plus timestamp metadata when platform identity is unavailable', async () => {
  const stateRoot = await tempDir('termagent-owner-identity-')
  const workspace = await tempDir('termagent-owner-workspace-')
  try {
    const lease = await acquireDaemonOwner(workspace, { stateRoot, mode: 'server' })
    try {
      const lock = JSON.parse(await fs.readFile(path.join(stateRoot, `${lease.workspaceId}.lock`), 'utf8'))
      assert.strictEqual(lock.pid, process.pid)
      if (lock.processStart === undefined) {
        // Degraded capture (win32, or linux without /proc data): the lock still
        // carries durable timestamp metadata and the lease keeps working.
        assert.ok(Number.isInteger(lock.processStartMs) && lock.processStartMs > 0)
      } else {
        assert.match(lock.processStart, /^\d+$/)
      }
      const info = await readDaemonOwner(workspace, { stateRoot })
      assert.ok(info)
      assert.strictEqual(info.pid, process.pid)
    } finally {
      await lease.release()
    }
    assert.strictEqual(await readDaemonOwner(workspace, { stateRoot }), undefined)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
