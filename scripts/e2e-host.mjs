#!/usr/bin/env node
// Host-side end-to-end: drive the REAL /vault command handler against the
// REAL GitHub API, but with a sandboxed DSH_HOME so the user's config is
// never touched.
//
//   1. build a sandbox home (settings, credentials, agents, a tui profile
//      manifest carrying an absolute file: dep)
//   2. /vault backup with a scratch repo override (auto-creates it, private)
//   3. mutate the sandbox, /vault restore <machine> --yes → sandbox content
//      must be restored byte-for-byte, file: dep warning must appear
//   4. wrong passphrase must be rejected
//   5. best-effort cleanup: delete the two repo files (the token usually
//      lacks delete_repo, so the empty private repo is left behind)
//
// Env: DSH_VAULT_E2E_REPO (default fan56/dsh-vault-e2e-scratch), requires a
// usable GitHub token (GITHUB_TOKEN or logged-in gh CLI).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { vaultMachineName } from '../lib/paths.js'

const SCRATCH_REPO = process.env.DSH_VAULT_E2E_REPO ?? 'fan56/dsh-vault-e2e-scratch'
const PASSPHRASE = 'e2e-passphrase-☕️-correct-horse'

function fail(message, extra = '') {
  console.error(`e2e-host: FAIL — ${message}`)
  if (extra) console.error(extra)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Fake cordis context: enough for apply() to register /vault and for the
// handler to run; settings.mutate is recorded only.
// ---------------------------------------------------------------------------

const config = { repo: SCRATCH_REPO, machineDescription: 'e2e 沙箱', rememberPassphrase: false }
const scope = { get: () => config, watch: () => {} }
const ctx = {
  settings: { register: () => scope },
  get: (name) => (name === 'settings' ? { async mutate() {} } : undefined),
  logger: { info() {}, warn() {}, debug() {} },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') state.disposers.push(disposer)
    return disposer
  },
  provide() {},
  inject(names, callback) {
    for (const name of names) if (ctx[name] === undefined) return
    callback(Object.create(ctx))
  },
  commands: {
    register(definition) {
      state.definitions.push(definition)
      return () => {}
    },
  },
}
const state = { definitions: [], disposers: [] }
ctx.state = state

apply(ctx)
const handler = state.definitions.at(-1)?.handler
if (handler === undefined) fail('apply() did not register the vault command')
const run = async (input) => {
  const result = await handler({ rawInput: input, signal: undefined, commandId: 'vault', agent: {}, attachments: [] })
  console.log(`--- /vault ${input}\n${result.kind === 'success' ? '' : '[error] '}${result.text}\n`)
  return result
}

// ---------------------------------------------------------------------------
// Sandbox home
// ---------------------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'dsh-vault-e2e-'))
const settingsYaml = 'ui-theme:\n  preference: dark\nllm-pi-ai:\n  providers: {}\n'
const credentialsYaml = 'version: 1\nrefs:\n  E2E_FAKE_KEY: not-a-real-key\n'
mkdirSync(join(home, 'agents'), { recursive: true })
mkdirSync(join(home, 'profiles', 'tui'), { recursive: true })
writeFileSync(join(home, 'settings.yaml'), settingsYaml)
writeFileSync(join(home, '.credentials.yaml'), credentialsYaml, { mode: 0o600 })
writeFileSync(join(home, 'APPEND_SYSTEM.md'), '# e2e\n')
writeFileSync(join(home, 'agents', 'e2e-agent.md'), 'test agent\n')
writeFileSync(join(home, 'profiles', 'tui', 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { '@aiwayds/dsh-llm-proxy': 'file:/Users/someone/repo/dsh-llm-proxy' },
}))
writeFileSync(join(home, 'profiles', 'tui', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
writeFileSync(join(home, 'profiles', 'tui', 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\n')
process.env.DSH_HOME = home
process.env.DSH_VAULT_PASSPHRASE = PASSPHRASE

const machine = vaultMachineName()

// Probe whether the scratch repo already exists (it survives runs — the gh
// token usually lacks delete_repo), so the auto-create assertion matches.
const token = process.env.GITHUB_TOKEN ?? spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout?.trim()
let repoExists = false
if (token) {
  const probe = await fetch(`https://api.github.com/repos/${SCRATCH_REPO}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-vault-e2e' },
  })
  repoExists = probe.ok
}

try {
  // 1 — backup (auto-creates the private scratch repo when absent)
  const backup = await run('backup')
  if (backup.kind !== 'success' || !backup.text.includes('snapshot.enc')) {
    fail('backup did not succeed', backup.text)
  }
  if (backup.text.includes('自动创建') === repoExists) {
    fail(`auto-create note wrong (repo pre-existed: ${repoExists})`, backup.text)
  }

  // 2 — list shows the machine (and the table renderer)
  const list = await run(`list`)
  if (list.kind !== 'success' || !list.text.includes(machine)) {
    fail(`list does not show machine ${machine}`, list.text)
  }
  if (!list.text.includes('机器') || !list.text.includes('快照时间')) {
    fail('list is not rendered as the snapshot table', list.text)
  }
  const listViaRestore = await run('restore')
  if (listViaRestore.kind !== 'success' || !listViaRestore.text.includes(machine)) {
    fail(`restore list does not show machine ${machine}`, listViaRestore.text)
  }

  // 3 — plan preview is gated behind --yes
  const plan = await run(`restore ${machine}`)
  if (plan.kind !== 'success' || !plan.text.includes('--yes')) {
    fail('restore without --yes must show a plan and stay gated', plan.text)
  }

  // 4 — mutate the sandbox, then restore must overwrite it back
  writeFileSync(join(home, 'settings.yaml'), 'ui-theme:\n  preference: CORRUPTED\n')
  rmSync(join(home, 'agents', 'e2e-agent.md'))
  const restore = await run(`restore ${machine} --yes`)
  if (restore.kind !== 'success') fail('restore --yes failed', restore.text)
  if (!restore.text.includes('file:')) fail('restore must warn about the absolute file: dep', restore.text)
  if (readFileSync(join(home, 'settings.yaml'), 'utf8') !== settingsYaml) fail('settings.yaml was not restored')
  if (readFileSync(join(home, '.credentials.yaml'), 'utf8') !== credentialsYaml) fail('.credentials.yaml was not restored')
  if (!statSync(join(home, '.credentials.yaml')).mode.toString(8).endsWith('600')) fail('.credentials.yaml not 0600 after restore')
  if (readFileSync(join(home, 'agents', 'e2e-agent.md'), 'utf8') !== 'test agent\n') fail('agents/e2e-agent.md was not restored')
  if (!restore.text.includes('stash')) fail('restore must report the local stash dir', restore.text)

  // 5 — wrong passphrase is rejected, sandbox untouched
  writeFileSync(join(home, 'settings.yaml'), 'ui-theme:\n  preference: SECOND-MUTATION\n')
  const wrong = await run(`restore ${machine} --yes wrong-passphrase`)
  if (wrong.kind !== 'error' || !wrong.text.includes('口令错误')) fail('wrong passphrase must be rejected', wrong.text)
  if (readFileSync(join(home, 'settings.yaml'), 'utf8') !== 'ui-theme:\n  preference: SECOND-MUTATION\n') {
    fail('failed decrypt must not touch the local home')
  }

  console.log(`e2e-host: PASS — backup/list/plan/restore/wrong-passphrase all behaved against ${SCRATCH_REPO}`)
} finally {
  // Best-effort cleanup: remove the two files so no test blob lingers.
  // The gh token usually lacks delete_repo, so the empty private repo stays;
  // report it instead of pretending it was deleted.
  if (token) {
    const del = async (path) => {
      const base = 'https://api.github.com'
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-vault-e2e',
        'Content-Type': 'application/json',
      }
      const get = await fetch(`${base}/repos/${SCRATCH_REPO}/contents/${path}`, { headers })
      if (!get.ok) return
      const { sha } = await get.json()
      await fetch(`${base}/repos/${SCRATCH_REPO}/contents/${path}`, {
        method: 'DELETE', headers,
        body: JSON.stringify({ message: 'e2e cleanup', sha }),
      })
    }
    await del(`machines/${machine}/snapshot.enc`).catch(() => {})
    await del(`machines/${machine}/manifest.json`).catch(() => {})
    console.log(`e2e-host: cleanup — test files removed from ${SCRATCH_REPO} (empty private repo left behind; token lacks delete_repo)`)
  }
  rmSync(home, { recursive: true, force: true })
}
