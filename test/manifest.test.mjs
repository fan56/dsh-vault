// Snapshot manifest: plaintext metadata next to the encrypted blob (ADR 0004).

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManifest, parseManifest } from '../lib/manifest.js'

const valid = buildManifest({
  machine: 'mac-studio',
  description: '工作室',
  createdAt: '2026-08-30T00:00:00.000Z',
  pluginVersion: '0.1.0',
  nodeVersion: 'v22.19.0',
  files: ['settings.yaml', 'profiles/tui/package.json'],
  profileNames: ['tui'],
  blobSize: 1234,
  blobSha256: 'a'.repeat(64),
})

test('build → JSON → parse round-trips', () => {
  const parsed = parseManifest(JSON.parse(JSON.stringify(valid)))
  assert.equal(parsed.machine, 'mac-studio')
  assert.equal(parsed.kind, 'dsh-vault-manifest')
  assert.deepEqual(parsed.files, valid.files)
})

test('rejects foreign kinds, bad versions, missing machine', () => {
  assert.throws(() => parseManifest({ kind: 'x', version: 1, machine: 'm', files: [] }), /kind/)
  assert.throws(() => parseManifest({ ...valid, version: 2 }), /版本/)
  assert.throws(() => parseManifest({ ...valid, machine: '' }), /machine/)
  assert.throws(() => parseManifest('nope'), /对象/)
})
