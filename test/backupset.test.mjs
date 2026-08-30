// Backup set boundary (ADR 0001): what's collected, what's excluded by
// omission; envelope round-trip; restore write-back (0600 credentials);
// file: dependency detection; stash pruning.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectBackupSet,
  buildEnvelope,
  parseEnvelope,
  envelopeToFiles,
  writeBackupSet,
  findLocalPathDeps,
  stashCurrentBackupSet,
} from '../lib/backupset.js'

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-vault-home-'))
  writeFileSync(join(home, 'settings.yaml'), 'ui-theme:\n  preference: dark\n')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  K: v\n', { mode: 0o600 })
  writeFileSync(join(home, 'APPEND_SYSTEM.md'), '# extra\n')
  writeFileSync(join(home, 'models-store.json'), '{}\n')
  writeFileSync(join(home, 'cordis.patch.yml'), '[]\n')
  // Regenerated / machine-bound stuff that must NEVER be collected:
  writeFileSync(join(home, 'cordis.yml'), '[]\n')
  writeFileSync(join(home, '.anonymous-user-id'), 'uuid\n')
  writeFileSync(join(home, 'tui-command-usage.json'), '{}\n')
  mkdirSync(join(home, 'sessions'))
  writeFileSync(join(home, 'sessions', 's1.jsonl'), '{}\n')
  mkdirSync(join(home, 'storages'))
  writeFileSync(join(home, 'storages', 'workspace.json'), '{}\n')
  // agents tree
  mkdirSync(join(home, 'agents', 'sub'), { recursive: true })
  writeFileSync(join(home, 'agents', 'oldfox.md'), 'a\n')
  writeFileSync(join(home, 'agents', 'sub', 'workhorse.md'), 'b\n')
  // profiles: two with manifests, one bare dir, plus the node_modules farm
  const tui = join(home, 'profiles', 'tui')
  mkdirSync(join(tui, 'node_modules'), { recursive: true })
  writeFileSync(join(tui, 'package.json'), JSON.stringify({ name: 'tui', dependencies: {} }))
  writeFileSync(join(tui, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(tui, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(tui, 'node_modules', 'junk.js'), 'x')
  const headless = join(home, 'profiles', 'headless')
  mkdirSync(headless, { recursive: true })
  writeFileSync(join(headless, 'package.json'), JSON.stringify({ name: 'headless', dependencies: {} }))
  mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'node_modules', 'farm.js'), 'x')
  mkdirSync(join(home, 'profiles', 'empty'), { recursive: true })
  return home
}

test('collect takes portable config and never the regenerable/machine-bound', () => {
  const home = makeFakeHome()
  try {
    const { files, profileNames } = collectBackupSet(home)
    const paths = files.map((f) => f.path)
    for (const expected of [
      'settings.yaml',
      '.credentials.yaml',
      'APPEND_SYSTEM.md',
      'models-store.json',
      'cordis.patch.yml',
      'agents/oldfox.md',
      'agents/sub/workhorse.md',
      'profiles/tui/package.json',
      'profiles/tui/pnpm-lock.yaml',
      'profiles/tui/pnpm-workspace.yaml',
      'profiles/headless/package.json',
    ]) {
      assert.ok(paths.includes(expected), `missing ${expected}`)
    }
    for (const forbidden of paths) {
      assert.ok(!forbidden.includes('node_modules'), `node_modules leaked: ${forbidden}`)
      assert.ok(!forbidden.startsWith('sessions/'), `sessions leaked: ${forbidden}`)
      assert.ok(!forbidden.startsWith('storages/'), `storages leaked: ${forbidden}`)
      assert.notEqual(forbidden, 'cordis.yml')
      assert.notEqual(forbidden, '.anonymous-user-id')
      assert.notEqual(forbidden, 'tui-command-usage.json')
    }
    assert.deepEqual(profileNames.sort(), ['headless', 'tui'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('envelope round-trips through build → parse → files', () => {
  const home = makeFakeHome()
  try {
    const { files } = collectBackupSet(home)
    const buf = buildEnvelope(files, '2026-08-30T00:00:00.000Z')
    const envelope = parseEnvelope(buf)
    assert.equal(envelope.kind, 'dsh-vault-backup')
    assert.equal(envelope.createdAt, '2026-08-30T00:00:00.000Z')
    const restored = envelopeToFiles(envelope)
    assert.equal(restored.length, files.length)
    for (let i = 0; i < files.length; i++) {
      assert.equal(restored[i].path, files[i].path)
      assert.ok(restored[i].data.equals(files[i].data))
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseEnvelope rejects foreign payloads', () => {
  assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify({ kind: 'other', version: 1, files: [] }))), /kind/)
  assert.throws(() => parseEnvelope(Buffer.from('not json')), /JSON/)
})

test('writeBackupSet restores files; credentials land at 0600', () => {
  const home = makeFakeHome()
  try {
    const { files } = collectBackupSet(home)
    const target = mkdtempSync(join(tmpdir(), 'dsh-vault-restore-'))
    try {
      const written = writeBackupSet(target, files)
      assert.equal(written.length, files.length)
      assert.ok(existsSync(join(target, 'settings.yaml')))
      assert.ok(existsSync(join(target, 'agents', 'sub', 'workhorse.md')))
      assert.ok(existsSync(join(target, 'profiles', 'tui', 'pnpm-lock.yaml')))
      const credMode = statSync(join(target, '.credentials.yaml')).mode & 0o777
      assert.equal(credMode, 0o600, '.credentials.yaml must restore to 0600')
      const settingsMode = statSync(join(target, 'settings.yaml')).mode & 0o777
      assert.ok(settingsMode > 0, 'settings.yaml has a mode')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('findLocalPathDeps flags absolute file: specs only', () => {
  const files = [
    {
      path: 'profiles/tui/package.json',
      mode: 0o644,
      data: Buffer.from(JSON.stringify({
        dependencies: {
          '@aiwayds/dsh-llm-proxy': 'file:/Users/qingguee/repo/dsh-llm-proxy',
          '@aiwayds/dsh-vault': '^0.1.0',
        },
      })),
    },
    {
      path: 'profiles/headless/package.json',
      mode: 0o644,
      data: Buffer.from(JSON.stringify({ dependencies: { clean: '^1.0.0' } })),
    },
  ]
  const problems = findLocalPathDeps(files)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].profile, 'tui')
  assert.deepEqual(problems[0].deps, ['file:/Users/qingguee/repo/dsh-llm-proxy'])
})

test('stashCurrentBackupSet snapshots the home and prunes to the last 3', () => {
  const home = makeFakeHome()
  try {
    const first = stashCurrentBackupSet(home)
    assert.ok(first !== undefined && first.includes(join('vault', 'stash')), 'stash dir created')
    assert.ok(existsSync(join(first, 'settings.yaml')))
    for (let i = 0; i < 5; i++) {
      stashCurrentBackupSet(home)
    }
    const entries = readdirSync(join(home, 'vault', 'stash'))
    assert.equal(entries.length, 3, 'stash pruned to 3')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
