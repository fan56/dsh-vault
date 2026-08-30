// /vault command registration + sub-action dispatch (network-free paths):
// config, set validation and settings.mutate wiring, help, passphrase
// guidance. Backup/restore network flows are covered by the host e2e.

import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

let failed = 0
let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

const defaultConfig = {
  repo: '',
  machineDescription: '',
  rememberPassphrase: false,
}

function createFakeContext({ config = defaultConfig } = {}) {
  const state = {
    definitions: [],
    mutations: [],
  }
  const scope = {
    get: () => config,
    watch: () => {},
  }
  const settingsService = {
    async mutate(ns, ops) {
      state.mutations.push({ ns, ops })
    },
  }
  const ctx = {
    settings: { register: () => scope },
    get: (name) => (name === 'settings' ? settingsService : undefined),
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') state.effectDisposers ??= []
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
  ctx.state = state
  return { ctx, state }
}

const handler = (ctx) => ctx.state.definitions.at(-1)?.handler

async function run(ctx, input) {
  const result = await handler(ctx)({ rawInput: input, signal: undefined, commandId: 'vault', agent: {}, attachments: [] })
  assert.ok(result, 'handler returned a result')
  assert.ok(typeof result.text === 'string' && result.text.length > 0, 'result carries text')
  return result
}

await check('registers exactly one vault command with recordInput off', async () => {
  const { ctx, state } = createFakeContext()
  apply(ctx)
  assert.equal(state.definitions.length, 1)
  assert.equal(state.definitions[0].name, 'vault')
  assert.equal(state.definitions[0].recordInput, false)
  assert.ok(state.definitions[0].input?.hint.includes('backup'))
})

await check('bare /vault prints help', async () => {
  const { ctx } = createFakeContext()
  apply(ctx)
  const result = await run(ctx, '')
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('/vault backup'))
  assert.ok(result.text.includes('/vault restore'))
})

await check('config lists resolved settings without network', async () => {
  const { ctx } = createFakeContext()
  apply(ctx)
  const result = await run(ctx, 'config')
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('dsh-backup-<github用户名>'), 'default repo formula shown')
  assert.ok(result.text.includes('本机目录'))
})

await check('set repo validates owner/name shape', async () => {
  const { ctx } = createFakeContext()
  apply(ctx)
  const bad = await run(ctx, 'set repo not-a-repo')
  assert.equal(bad.kind, 'error')
  assert.ok(bad.text.includes('owner/name'))
})

await check('set repo writes through settings.mutate', async () => {
  const { ctx, state } = createFakeContext()
  apply(ctx)
  const result = await run(ctx, 'set repo fan56/dsh-backup-x')
  assert.equal(result.kind, 'success')
  assert.equal(state.mutations.length, 1)
  assert.deepEqual(state.mutations[0].ops, [{ op: 'set', path: ['repo'], value: 'fan56/dsh-backup-x' }])
})

await check('set remember-passphrase on/off mutates boolean and forgets on off', async () => {
  const { ctx, state } = createFakeContext()
  apply(ctx)
  const on = await run(ctx, 'set remember-passphrase on')
  assert.equal(on.kind, 'success')
  assert.deepEqual(state.mutations.at(-1).ops, [{ op: 'set', path: ['rememberPassphrase'], value: true }])
  const off = await run(ctx, 'set remember-passphrase off')
  assert.equal(off.kind, 'success')
  assert.deepEqual(state.mutations.at(-1).ops, [{ op: 'set', path: ['rememberPassphrase'], value: false }])
  const junk = await run(ctx, 'set remember-passphrase maybe')
  assert.equal(junk.kind, 'error')
})

await check('backup without any passphrase source gives guidance, never touches network', async () => {
  const savedEnv = process.env.DSH_VAULT_PASSPHRASE
  delete process.env.DSH_VAULT_PASSPHRASE
  try {
    const { ctx } = createFakeContext()
    apply(ctx)
    const result = await run(ctx, 'backup')
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('需要口令'), 'explains the three passphrase channels')
    assert.ok(result.text.includes('DSH_VAULT_PASSPHRASE'))
  } finally {
    if (savedEnv !== undefined) process.env.DSH_VAULT_PASSPHRASE = savedEnv
  }
})

await check('unknown sub-action is an error carrying help', async () => {
  const { ctx } = createFakeContext()
  apply(ctx)
  const result = await run(ctx, 'frobnicate')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('未知子动作'))
})

console.log(`\ncommand.test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
