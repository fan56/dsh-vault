// dsh home resolution + hostname sanitization shared by all vault modules.

import { hostname as osHostname, homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the dsh home directory the same way the host does for the common
 * cases: explicit $DSH_HOME wins, otherwise ~/.dsh. The host also supports a
 * settings-level override, which this plugin cannot read before boot — good
 * enough for the backup set, which lives in the home either way.
 */
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  if (env !== undefined && env !== '') return env
  return join(homedir(), '.dsh')
}

/**
 * The machine's directory name inside the vault. Sanitized to the character
 * set GitHub content paths are comfortable with; two machines whose hostnames
 * sanitize to the same directory will stomp each other (ADR 0004 consequence).
 */
export function vaultMachineName(): string {
  return osHostname().replace(/[^A-Za-z0-9._-]/g, '-') || 'unknown-host'
}
