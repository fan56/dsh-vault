// Snapshot manifest: the PLAINTEXT metadata stored next to the encrypted
// snapshot. It must never contain key material — restore's machine picker
// reads it without the passphrase (ADR 0004).

export const MANIFEST_KIND = 'dsh-vault-manifest'

export interface SnapshotManifest {
  kind: typeof MANIFEST_KIND
  version: 1
  /** Sanitized hostname — the machine's directory name in the vault. */
  machine: string
  /** Optional human label from `/vault set machine-desc`. */
  description: string
  createdAt: string
  pluginVersion: string
  nodeVersion: string
  /** Backup-set paths contained in the snapshot. */
  files: string[]
  /** Profile names whose manifests are included (reinstalled on restore). */
  profileNames: string[]
  blobSize: number
  blobSha256: string
}

export function buildManifest(input: Omit<SnapshotManifest, 'kind' | 'version'>): SnapshotManifest {
  return { kind: MANIFEST_KIND, version: 1, ...input }
}

export function parseManifest(raw: unknown): SnapshotManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('manifest 不是对象')
  }
  const m = raw as Record<string, unknown>
  if (m.kind !== MANIFEST_KIND) throw new Error('manifest kind 不符')
  if (m.version !== 1) throw new Error(`manifest 版本 ${String(m.version)} 不受支持`)
  if (typeof m.machine !== 'string' || m.machine === '') throw new Error('manifest 缺少 machine')
  if (!Array.isArray(m.files)) throw new Error('manifest 缺少 files')
  return raw as unknown as SnapshotManifest
}
