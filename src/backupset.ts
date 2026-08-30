// Backup set collection and restore write-back (ADR 0001).
//
// The backup set is hand-written, machine-portable config: settings,
// credentials, agents, per-profile manifests, home patch, models store.
// Everything the host regenerates (node_modules, cordis.yml) or that is
// machine-bound (sessions, storages, anonymous id) is excluded by omission —
// collect() simply never looks at it.

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Top-level dsh-home files in the backup set (all optional). */
const TOP_FILES = [
  'settings.yaml',
  '.credentials.yaml',
  'APPEND_SYSTEM.md',
  'models-store.json',
  'cordis.patch.yml',
] as const

/** Per-profile manifest files (ADR 0001: the reinstall anchor). */
const PROFILE_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
] as const

const AGENTS_MAX_DEPTH = 4

export interface BackupFile {
  /** Path relative to the dsh home, forward slashes. */
  path: string
  mode: number
  data: Buffer
}

export interface CollectedBackupSet {
  files: BackupFile[]
  /** Profile directories that contributed manifest files. */
  profileNames: string[]
}

function collectAgents(dir: string, rel: string, depth: number, out: BackupFile[]): void {
  if (depth > AGENTS_MAX_DEPTH) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue
    const abs = join(dir, entry)
    const relPath = rel === '' ? entry : `${rel}/${entry}`
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      collectAgents(abs, relPath, depth + 1, out)
    } else if (st.isFile()) {
      out.push({ path: relPath, mode: st.mode & 0o777, data: readFileSync(abs) })
    }
  }
}

export function collectBackupSet(home: string): CollectedBackupSet {
  const files: BackupFile[] = []
  for (const name of TOP_FILES) {
    const abs = join(home, name)
    if (!existsSync(abs)) continue
    const st = statSync(abs)
    if (!st.isFile()) continue
    files.push({ path: name, mode: st.mode & 0o777, data: readFileSync(abs) })
  }

  const agentsDir = join(home, 'agents')
  if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
    collectAgents(agentsDir, 'agents', 0, files)
  }

  const profileNames: string[] = []
  const profilesDir = join(home, 'profiles')
  if (existsSync(profilesDir) && statSync(profilesDir).isDirectory()) {
    for (const entry of readdirSync(profilesDir)) {
      if (entry === 'node_modules') continue
      const profileDir = join(profilesDir, entry)
      let st
      try {
        st = statSync(profileDir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      let contributed = false
      for (const name of PROFILE_FILES) {
        const abs = join(profileDir, name)
        if (!existsSync(abs)) continue
        const fst = statSync(abs)
        if (!fst.isFile()) continue
        files.push({ path: `profiles/${entry}/${name}`, mode: fst.mode & 0o777, data: readFileSync(abs) })
        contributed = true
      }
      if (contributed) profileNames.push(entry)
    }
  }

  return { files, profileNames }
}

// ---------------------------------------------------------------------------
// Envelope: the plaintext JSON structure that gets encrypted into the blob.
// Base64 file data keeps the envelope pure JSON — config-scale payloads make
// the ~33% overhead irrelevant, and no tar/streaming code is needed.
// ---------------------------------------------------------------------------

export const ENVELOPE_KIND = 'dsh-vault-backup'

export interface BackupEnvelope {
  kind: typeof ENVELOPE_KIND
  version: 1
  createdAt: string
  files: { path: string; mode: number; data: string }[]
}

export function buildEnvelope(files: BackupFile[], createdAt = new Date().toISOString()): Buffer {
  const envelope: BackupEnvelope = {
    kind: ENVELOPE_KIND,
    version: 1,
    createdAt,
    files: files.map((f) => ({ path: f.path, mode: f.mode, data: f.data.toString('base64') })),
  }
  return Buffer.from(JSON.stringify(envelope), 'utf8')
}

export function parseEnvelope(buf: Buffer): BackupEnvelope {
  let raw: unknown
  try {
    raw = JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error('快照内容不是合法 JSON —— 口令可能对了，但快照已损坏')
  }
  const e = raw as Record<string, unknown>
  if (e.kind !== ENVELOPE_KIND || e.version !== 1) {
    throw new Error('快照 envelope kind/version 不符 —— 不是本插件写入的备份')
  }
  if (!Array.isArray(e.files)) throw new Error('快照 envelope 缺少 files')
  return raw as unknown as BackupEnvelope
}

export function envelopeToFiles(envelope: BackupEnvelope): BackupFile[] {
  return envelope.files.map((f) => ({ path: f.path, mode: f.mode, data: Buffer.from(f.data, 'base64') }))
}

// ---------------------------------------------------------------------------
// Restore write-back.
// ---------------------------------------------------------------------------

/** `.credentials.yaml` must be 0600 — the host hard-errors on wider perms. */
function restoreMode(path: string, savedMode: number): number {
  if (path === '.credentials.yaml') return 0o600
  return (savedMode & 0o777) || 0o644
}

/**
 * Write snapshot files back into the dsh home. Profile manifests sort first
 * (ADR 0001 restore order) so a following `dsh plugin --profile install` can
 * run against them.
 */
export function writeBackupSet(home: string, files: BackupFile[]): string[] {
  const written: string[] = []
  const sorted = [...files].sort((a, b) => weight(a.path) - weight(b.path))
  for (const file of sorted) {
    const target = join(home, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
    chmodSync(target, restoreMode(file.path, file.mode))
    written.push(file.path)
  }
  return written
}

function weight(path: string): number {
  return path.startsWith('profiles/') ? 0 : 1
}

/**
 * Detect `file:` dependencies in profile manifests that point at absolute
 * local paths — they will not resolve on another machine (ADR 0001
 * consequence) and must be surfaced before pnpm install runs.
 */
export function findLocalPathDeps(files: BackupFile[]): { profile: string; deps: string[] }[] {
  const problems: { profile: string; deps: string[] }[] = []
  for (const file of files) {
    const match = /^profiles\/([^/]+)\/package\.json$/.exec(file.path)
    if (match === null) continue
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    try {
      pkg = JSON.parse(file.data.toString('utf8'))
    } catch {
      continue
    }
    const deps = new Set<string>()
    const specs = [
      ...Object.values(pkg.dependencies ?? {}),
      ...Object.values(pkg.devDependencies ?? {}),
    ]
    for (const spec of specs) {
      if (typeof spec === 'string' && /^file:(\/|\.\.)/.test(spec)) deps.add(spec)
    }
    if (deps.size > 0) problems.push({ profile: match[1], deps: [...deps] })
  }
  return problems
}

/**
 * Best-effort stash of the CURRENT backup set before an overwrite, so the
 * "latest-only" snapshot model still has one local undo step (ADR 0003
 * consequence). Returns the stash directory, or undefined when nothing needed
 * stashing or the stash failed (restore proceeds regardless).
 */
export function stashCurrentBackupSet(home: string): string | undefined {
  try {
    const current = collectBackupSet(home)
    if (current.files.length === 0) return undefined
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const stashDir = join(home, 'vault', 'stash', stamp)
    for (const file of current.files) {
      const target = join(stashDir, ...file.path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.data)
      chmodSync(target, restoreMode(file.path, file.mode))
    }
    pruneStashes(join(home, 'vault', 'stash'), 3)
    return stashDir
  } catch {
    return undefined
  }
}

function pruneStashes(stashRoot: string, keep: number): void {
  let entries: string[]
  try {
    entries = readdirSync(stashRoot).sort()
  } catch {
    return
  }
  const doomed = entries.slice(0, Math.max(0, entries.length - keep))
  for (const name of doomed) {
    // Only ever delete entries that look like our own stamps.
    if (!/^\d{4}-\d{2}-\d{2}T/.test(name)) continue
    try {
      removeDir(join(stashRoot, name))
    } catch { /* best effort */ }
  }
}

function removeDir(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) removeDir(abs)
    else unlinkSync(abs)
  }
  rmdirSync(dir)
}
