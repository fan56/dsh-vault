// Optional "remember passphrase" storage: macOS Keychain via the `security`
// CLI (zero npm deps, ADR 0002). Remembered passphrases never leave the
// machine; non-macOS platforms simply have no remember support.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const SERVICE = 'dsh-vault'
const ACCOUNT = 'dsh-vault'

export function keychainSupported(): boolean {
  return process.platform === 'darwin'
}

/** Returns the remembered passphrase, or undefined when none is stored. */
export async function getRememberedPassphrase(): Promise<string | undefined> {
  if (!keychainSupported()) return undefined
  try {
    const { stdout } = await execFileP('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { timeout: 5000 })
    const value = stdout.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** Store (or overwrite) the remembered passphrase. */
export async function rememberPassphrase(passphrase: string): Promise<void> {
  if (!keychainSupported()) {
    throw new Error('记住口令目前仅支持 macOS 钥匙串')
  }
  await execFileP('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-U', '-w', passphrase], { timeout: 5000 })
}

/** Best-effort removal of the remembered passphrase. */
export async function forgetPassphrase(): Promise<void> {
  if (!keychainSupported()) return
  try {
    await execFileP('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], { timeout: 5000 })
  } catch {
    // nothing stored — fine
  }
}
