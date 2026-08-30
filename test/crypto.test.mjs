// vault format v1: passphrase → scrypt → AES-256-GCM, header round-trip,
// tamper and wrong-passphrase rejection.

import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptBlob, decryptBlob, selfTest, DEFAULT_SCRYPT } from '../lib/crypto.js'

const MAGIC = Buffer.from('DSHVAULT', 'ascii')

test('encrypt → decrypt round-trips arbitrary bytes', () => {
  const passphrase = 'correct horse battery staple'
  const plaintext = Buffer.from('settings.yaml 内容 ☕️\n'.repeat(37) + Math.random())
  const blob = encryptBlob(passphrase, plaintext)
  assert.deepEqual(decryptBlob(passphrase, blob), plaintext)
})

test('wrong passphrase is rejected with a friendly error (GCM auth)', () => {
  const blob = encryptBlob('right', Buffer.from('secret'))
  assert.throws(() => decryptBlob('wrong', blob), /口令错误或快照已损坏/)
})

test('tampered ciphertext fails auth', () => {
  const blob = encryptBlob('p', Buffer.from('payload'))
  blob[blob.length - 20] ^= 0xff
  assert.throws(() => decryptBlob('p', blob), /口令错误或快照已损坏/)
})

test('non-vault input is rejected by magic check', () => {
  assert.throws(() => decryptBlob('p', Buffer.from('hello world, not a vault blob at all')), /magic/)
})

test('unsupported format version is rejected', () => {
  const blob = encryptBlob('p', Buffer.from('x'))
  blob[8] = 99
  assert.throws(() => decryptBlob('p', blob), /格式版本/)
})

test('header carries magic, version and scrypt params', () => {
  const blob = encryptBlob('p', Buffer.from('x'))
  assert.ok(blob.subarray(0, 8).equals(MAGIC))
  assert.equal(blob.readUInt8(8), 1)
  assert.equal(blob.readUInt32BE(9), DEFAULT_SCRYPT.N)
  assert.equal(blob.readUInt32BE(13), DEFAULT_SCRYPT.r)
  assert.equal(blob.readUInt32BE(17), DEFAULT_SCRYPT.p)
})

test('empty passphrase is refused at encryption time', () => {
  assert.throws(() => encryptBlob('', Buffer.from('x')), /口令不能为空/)
})

test('selfTest passes for matching and fails for mismatched pairs', () => {
  const plaintext = Buffer.from('abc')
  const blob = encryptBlob('p', plaintext)
  assert.equal(selfTest('p', blob, plaintext), true)
  assert.equal(selfTest('p', blob, Buffer.from('other')), false)
  assert.equal(selfTest('wrong', blob, plaintext), false)
})

test('each encryption uses a fresh salt/nonce (no repeated blobs)', () => {
  const a = encryptBlob('p', Buffer.from('x'))
  const b = encryptBlob('p', Buffer.from('x'))
  assert.ok(!a.equals(b))
})
