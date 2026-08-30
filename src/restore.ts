// Restore execution (ADR 0001 restore order): stash the current backup set,
// write snapshot files back (profile manifests first), then reinstall each
// snapshot profile via the host's own `dsh plugin --profile install` (a thin
// pnpm forward) — the "one command pulls a new machine flat" promise.

import { spawnSync } from 'node:child_process'
import { writeBackupSet, stashCurrentBackupSet, findLocalPathDeps, type BackupFile } from './backupset.ts'
import type { SnapshotManifest } from './manifest.ts'

export interface RestorePlan {
  machine: string
  manifest: SnapshotManifest
  /** `file:` deps in snapshot profile manifests that will not resolve here. */
  localPathDeps: { profile: string; deps: string[] }[]
}

export function buildPlan(manifest: SnapshotManifest, files: BackupFile[]): RestorePlan {
  return {
    machine: manifest.machine,
    manifest,
    localPathDeps: findLocalPathDeps(files),
  }
}

export interface RestoreOutcome {
  written: string[]
  stashDir?: string
  installs: { profile: string; ok: boolean; output: string }[]
}

export function executeRestore(home: string, files: BackupFile[], profileNames: string[]): RestoreOutcome {
  const stashDir = stashCurrentBackupSet(home)
  const written = writeBackupSet(home, files)
  const installs = reinstallProfiles(profileNames)
  return { written, stashDir, installs }
}

/**
 * Reinstall plugins for every profile carried in the snapshot. Skipped with
 * a warning when the dsh CLI is not on PATH (the user can run the install
 * manually); each install gets a generous timeout because pnpm may hit the
 * network.
 */
export function reinstallProfiles(profileNames: string[]): { profile: string; ok: boolean; output: string }[] {
  const results: { profile: string; ok: boolean; output: string }[] = []
  for (const profile of profileNames) {
    try {
      const run = spawnSync('dsh', ['plugin', '--profile', profile, 'install'], {
        encoding: 'utf8',
        timeout: 15 * 60_000,
      })
      if (run.error !== undefined) {
        results.push({ profile, ok: false, output: String(run.error) })
        continue
      }
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
      results.push({ profile, ok: run.status === 0, output: output.slice(-2000) })
    } catch (error) {
      results.push({ profile, ok: false, output: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
