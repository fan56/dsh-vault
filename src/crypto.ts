// Vault snapshot encryption (ADR 0002): passphrase → scrypt key → AES-256-GCM
// over the whole backup envelope. Blob layout ("vault format v1"):
//
//   bytes 0..7    magic "DSHVAULT"
//   byte  8       format version (1)
//   bytes 9..12   scrypt N   (uint32 BE)
//   bytes 13..16  scrypt r   (uint32 BE)
//   bytes 17..20  scrypt p   (uint32 BE)
//   bytes 21..52  salt       (32 bytes)
//   bytes 53..64  nonce      (12 bytes)
//   bytes 65..    ciphertext + 16-byte GCM tag
//
// Zero npm dependencies — Node's built-in crypto only.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const MAGIC = Buffer.from('DSHVAULT', 'ascii')
export const FORMAT_VERSION = 1
const HEADER_LEN = 8 + 1 + 4 + 4 + 4 + 32 + 12 // 65
const KEY_LEN = 32
const SALT_LEN = 32
const NONCE_LEN = 12
const TAG_LEN = 16

export const DEFAULT_SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const

// scrypt memory is 128·N·r bytes; give the KDF generous headroom over the
// default so N can be raised in the future without hitting maxmem errors.
const MAXMEM = 128 * (1 << 17) * 8

export class VaultCryptoError extends Error {}

export function encryptBlob(passphrase: string, plaintext: Buffer, scrypt = DEFAULT_SCRYPT): Buffer {
  if (passphrase.length === 0) throw new VaultCryptoError('口令不能为空')
  const salt = randomBytes(SALT_LEN)
  const nonce = randomBytes(NONCE_LEN)
  const key = scryptSync(passphrase, salt, KEY_LEN, { N: scrypt.N, r: scrypt.r, p: scrypt.p, maxmem: MAXMEM })
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const header = Buffer.alloc(21)
  MAGIC.copy(header, 0)
  header.writeUInt8(FORMAT_VERSION, 8)
  header.writeUInt32BE(scrypt.N, 9)
  header.writeUInt32BE(scrypt.r, 13)
  header.writeUInt32BE(scrypt.p, 17)
  return Buffer.concat([header, salt, nonce, ciphertext, cipher.getAuthTag()])
}

export function decryptBlob(passphrase: string, blob: Buffer): Buffer {
  if (blob.length < HEADER_LEN + TAG_LEN || !blob.subarray(0, 8).equals(MAGIC)) {
    throw new VaultCryptoError('不是有效的 dsh-vault 快照（magic 不符）')
  }
  const version = blob.readUInt8(8)
  if (version !== FORMAT_VERSION) {
    throw new VaultCryptoError(`快照格式版本 ${version} 不受支持（本插件读版本 ${FORMAT_VERSION}）`)
  }
  const N = blob.readUInt32BE(9)
  const r = blob.readUInt32BE(13)
  const p = blob.readUInt32BE(17)
  const salt = blob.subarray(21, 53)
  const nonce = blob.subarray(53, 65)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const ciphertext = blob.subarray(HEADER_LEN, blob.length - TAG_LEN)
  let key: Buffer
  try {
    key = scryptSync(passphrase, salt, KEY_LEN, { N, r, p, maxmem: MAXMEM })
  } catch {
    throw new VaultCryptoError('快照的 KDF 参数无法在本机执行（内存不足）')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // GCM auth failure — wrong passphrase is by far the most common cause.
    throw new VaultCryptoError('解密失败：口令错误或快照已损坏')
  }
  return plaintext
}

/**
 * Backup-side self check (ADR 0003 consequence): decrypt what we just
 * encrypted so a corrupt/unusable snapshot never replaces the last good one.
 */
export function selfTest(passphrase: string, blob: Buffer, original: Buffer): boolean {
  try {
    return decryptBlob(passphrase, blob).equals(original)
  } catch {
    return false
  }
}
