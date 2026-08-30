/**
 * dsh-vault — encrypted backup / restore / migration of the dsh home config
 * through a private GitHub repo, exposed as the `/vault` slash command.
 *
 * Shape follows the ecosystem conventions: a schemastery settings namespace
 * (`vault`), the command registered from the plugin itself through the shared
 * dsh-commands registry (optional peer, mounted via ctx.inject), zero npm
 * dependencies in the shipped artifact.
 *
 * @module dsh-vault
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
// Types only (erased at emit); dsh-commands is an optional peer, so hosts
// without it still load this plugin — see the guarded registration below.
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { resolveDshHome, vaultMachineName } from './paths.ts'
import { encryptBlob, decryptBlob, selfTest, VaultCryptoError } from './crypto.ts'
import {
  collectBackupSet,
  buildEnvelope,
  parseEnvelope,
  envelopeToFiles,
  type BackupFile,
} from './backupset.ts'
import { buildManifest, parseManifest } from './manifest.ts'
import {
  getGithubToken,
  resolveRepo,
  listMachines,
  putFile,
  getFile,
  sha256,
  GhClient,
  GitHubError,
} from './gh.ts'
import { buildPlan, executeRestore } from './restore.ts'
import {
  keychainSupported,
  getRememberedPassphrase,
  rememberPassphrase as keychainRemember,
  forgetPassphrase as keychainForget,
} from './keychain.ts'

export const name = 'dsh-vault'

/** The settings seam this plugin consumes (its own config namespace). */
export const inject = ['settings']

const OWN_NS = settingsNamespace('vault')

/** The `vault` settings namespace: user-editable in settings.yaml. */
const VaultConfig = z.object({
  /** Vault repo override as `owner/name`; empty = default dsh-backup-<login>. */
  repo: z.string().default(''),
  /** Human label recorded in the snapshot manifest. */
  machineDescription: z.string().default(''),
  /** Store the passphrase in the macOS keychain on backup; reuse on restore. */
  rememberPassphrase: z.boolean().default(false),
})

interface VaultConfigValue {
  repo: string
  machineDescription: string
  rememberPassphrase: boolean
}

/** The settings seam this plugin needs for /vault set. */
interface SettingsService {
  mutate(
    ns: ReturnType<typeof settingsNamespace>,
    ops: readonly { op: 'set' | 'unset'; path: string[]; value?: unknown }[],
    expectedRevision?: number,
  ): Promise<void>
}

function ownVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const PLUGIN_VERSION = ownVersion()

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

function formatKB(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}

const HELP = [
  'dsh-vault — 加密备份 / 恢复 / 迁移 dsh 配置（GitHub 私有仓库）',
  '  /vault backup [口令]            备份并推送（口令不落会话日志）',
  '  /vault restore [机器] [--yes] [口令]',
  '                                  不带机器名 = 列出 Vault 里所有机器的快照；跨机选择即迁移',
  '  /vault config                   查看当前设置',
  '  /vault set repo <owner/name> | set machine-desc <描述> | set remember-passphrase on|off',
  '',
  '口令来源：命令参数 → $DSH_VAULT_PASSPHRASE → 钥匙串（remember-passphrase on 时）。',
  'GitHub 凭据：$GITHUB_TOKEN 或已登录的 gh CLI；登录不在插件职责内。',
  '口令遗失 = 快照永久不可解，插件不做找回。',
].join('\n')

export function apply(ctx: Context): void {
  const scope = ctx.settings.register(OWN_NS, VaultConfig)

  ctx.inject(['commands'], (cmdCtx) => {
    const commands = (cmdCtx as {
      commands?: { register(definition: CommandDefinition): () => void }
    }).commands
    if (commands?.register === undefined) return
    cmdCtx.effect(() => {
      const definition: CommandDefinition = {
        name: 'vault',
        // recordInput stays off: the raw input may carry the passphrase.
        recordInput: false,
        description: '加密备份 / 恢复 / 迁移 dsh 配置到 GitHub 私有仓库（backup | restore | config | set）',
        input: { hint: '[backup [口令] | restore [机器] [--yes] [口令] | config | set <key> <value>]' },
        handler: (invocation) => handle(invocation),
      }
      return commands.register(definition)
    }, 'dsh-vault: /vault')
  })

  const handle = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const raw = invocation.rawInput.trim()
    const [action = '', ...rest] = raw.split(/\s+/)
    try {
      switch (action) {
        case '':
          return ok(HELP)
        case 'backup':
          return await doBackup(rest.join(' '), invocation.signal)
        case 'restore':
          return await doRestore(rest, invocation.signal)
        case 'config':
          return await doConfig()
        case 'set':
          return await doSet(rest)
        default:
          return fail(`未知子动作 “${action}”。\n\n${HELP}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(`vault ${action} 失败：${message}`)
    }
  }

  // -----------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------

  const cfgNow = (): VaultConfigValue => scope.get() as unknown as VaultConfigValue

  const makeClient = async (): Promise<GhClient> => {
    const token = await getGithubToken()
    return new GhClient(token, PLUGIN_VERSION)
  }

  /**
   * Passphrase resolution order: inline argument → $DSH_VAULT_PASSPHRASE →
   * keychain (only when rememberPassphrase is on and the platform supports
   * it). Inline arguments never hit the session log (recordInput: false).
   */
  const resolvePassphrase = async (
    inline: string,
    cfg: VaultConfigValue,
  ): Promise<{ passphrase: string; source: string } | { error: string }> => {
    if (inline !== '') return { passphrase: inline, source: '命令参数' }
    const env = process.env.DSH_VAULT_PASSPHRASE?.trim()
    if (env !== undefined && env !== '') return { passphrase: env, source: '环境变量' }
    if (cfg.rememberPassphrase && keychainSupported()) {
      const remembered = await getRememberedPassphrase()
      if (remembered !== undefined) return { passphrase: remembered, source: '钥匙串' }
    }
    return {
      error: [
        '需要口令（快照是加密的）。三种给法：',
        '  1. 直接跟在命令后面：/vault backup <口令>（不落会话日志）',
        '  2. 环境变量 DSH_VAULT_PASSPHRASE',
        '  3. /vault set remember-passphrase on 之后完成一次带口令的 backup（存入 macOS 钥匙串）',
      ].join('\n'),
    }
  }

  // -----------------------------------------------------------------------
  // /vault backup
  // -----------------------------------------------------------------------

  const doBackup = async (passphraseInline: string, signal: AbortSignal | undefined): Promise<CommandResult> => {
    const cfg = cfgNow()
    const resolved = await resolvePassphrase(passphraseInline, cfg)
    if ('error' in resolved) return fail(resolved.error)
    const { passphrase, source } = resolved

    const home = resolveDshHome()
    const { files, profileNames } = collectBackupSet(home)
    if (files.length === 0) {
      return fail(`备份集为空（${home} 下没有可备份的配置）—— 检查 DSH_HOME 是否指向正确目录`)
    }

    const envelope = buildEnvelope(files)
    const blob = encryptBlob(passphrase, envelope)
    if (!selfTest(passphrase, blob, envelope)) {
      return fail('加密自检失败（加密后无法解回）—— 已中止，未推送任何数据')
    }

    const client = await makeClient()
    const { fullName, created } = await resolveRepo(client, cfg.repo, true)
    const machine = vaultMachineName()
    const manifest = buildManifest({
      machine,
      description: cfg.machineDescription,
      createdAt: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      nodeVersion: process.version,
      files: files.map((f) => f.path),
      profileNames,
      blobSize: blob.length,
      blobSha256: sha256(blob),
    })

    await putFile(client, fullName, `machines/${machine}/snapshot.enc`, blob, `dsh-vault backup ${machine}`, signal)
    await putFile(
      client,
      fullName,
      `machines/${machine}/manifest.json`,
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      `dsh-vault manifest ${machine}`,
      signal,
    )

    if (cfg.rememberPassphrase && keychainSupported()) {
      try {
        await keychainRemember(passphrase)
      } catch { /* best effort */ }
    }

    const lines = [
      `✅ 已备份 → ${fullName}（machines/${machine}/snapshot.enc，${formatKB(blob.length)}，${files.length} 个文件）`,
    ]
    if (created) lines.push('   （private 仓库不存在，已自动创建）')
    if (profileNames.length > 0) lines.push(`   profile：${profileNames.join('、')}（restore 时将自动重装插件）`)
    lines.push(`   口令来源：${source}；口令遗失即快照不可解，请自行保管。`)
    return ok(lines.join('\n'))
  }

  // -----------------------------------------------------------------------
  // /vault restore
  // -----------------------------------------------------------------------

  const doRestore = async (tokens: string[], signal: AbortSignal | undefined): Promise<CommandResult> => {
    const cfg = cfgNow()
    const yes = tokens.includes('--yes')
    const positional = tokens.filter((t) => t !== '--yes')
    const machine = positional[0]
    const inlinePassphrase = positional.slice(1).join(' ')

    const client = await makeClient()
    const { fullName } = await resolveRepo(client, cfg.repo, false)
    const machines = await listMachines(client, fullName, signal)

    if (machine === undefined) {
      if (machines.length === 0) {
        return ok(`Vault ${fullName} 里还没有任何机器的快照 —— 先在源机器上 /vault backup。`)
      }
      const lines = [`Vault ${fullName} 中的快照：`]
      for (const m of machines) {
        const man = m.manifest
        const desc = man?.description !== undefined && man.description !== '' ? man.description : '—'
        const when = man?.createdAt ?? '未知时间'
        const size = man !== undefined ? formatKB(man.blobSize) : '?'
        const count = man?.files.length ?? '?'
        lines.push(`  • ${m.machine} — ${desc} — ${when} — ${count} 文件 / ${size}`)
      }
      lines.push('→ /vault restore <机器名> 查看恢复计划；加 --yes 执行（跨机选择即迁移）。')
      return ok(lines.join('\n'))
    }

    const target = machines.find((m) => m.machine === machine)
    if (target === undefined) {
      const known = machines.map((m) => m.machine).join('、') || '（空）'
      return fail(`Vault ${fullName} 里没有 “${machine}” 的快照。现有的：${known}`)
    }
    if (target.manifest === undefined) {
      return fail(`machines/${machine}/manifest.json 缺失或损坏 —— 该目录可能不是本插件写入的。`)
    }

    const blobPath = `machines/${machine}/snapshot.enc`
    if (!yes) {
      const man = target.manifest
      const lines = [
        `恢复计划（来自 ${fullName}）：`,
        `  机器：${man.machine}${man.description !== '' ? `（${man.description}）` : ''}`,
        `  快照时间：${man.createdAt}（dsh-vault ${man.pluginVersion}）`,
        `  将覆盖 ${man.files.length} 个文件（${man.profileNames.length} 个 profile：${man.profileNames.join('、') || '无'}）`,
        `  本机 ${resolveDshHome()} 中被覆盖的文件会先暂存到 ~/.dsh/vault/stash/`,
        `→ 确认执行：/vault restore ${machine} --yes [口令]`,
      ]
      return ok(lines.join('\n'))
    }

    const resolved = await resolvePassphrase(inlinePassphrase, cfg)
    if ('error' in resolved) return fail(resolved.error)

    const blob = await getFile(client, fullName, blobPath, signal)
    if (blob === undefined) return fail(`快照文件 ${blobPath} 不存在（manifest 在但快照丢了）—— Vault 可能被动过。`)

    let envelope
    try {
      envelope = parseEnvelope(decryptBlob(resolved.passphrase, blob))
    } catch (error) {
      if (error instanceof VaultCryptoError) return fail(error.message)
      throw error
    }
    const files: BackupFile[] = envelopeToFiles(envelope)
    const plan = buildPlan(target.manifest, files)

    const outcome = executeRestore(resolveDshHome(), files, target.manifest.profileNames)

    const lines = [
      `✅ 已恢复 ${machine} 的快照（${target.manifest.createdAt}）→ ${resolveDshHome()}`,
      `   覆盖 ${outcome.written.length} 个文件；旧配置暂存于 ${outcome.stashDir ?? '（无可暂存内容）'}`,
    ]
    const badDeps = plan.localPathDeps
    for (const problem of badDeps) {
      lines.push(`   ⚠ ${problem.profile} 带本地路径依赖（本机多半无效）：${problem.deps.join('、')}`)
    }
    if (outcome.installs.length > 0) {
      lines.push('   插件重装：')
      for (const install of outcome.installs) {
        const mark = install.ok ? '✅' : '❌'
        const tail = install.ok ? '' : ` — ${install.output.split('\n').at(-1) ?? ''}`
        lines.push(`     ${mark} ${install.profile}${tail}`)
      }
    }
    lines.push(`   口令来源：${resolved.source}。重启 dsh 生效。`)
    return ok(lines.join('\n'))
  }

  // -----------------------------------------------------------------------
  // /vault config
  // -----------------------------------------------------------------------

  const doConfig = async (): Promise<CommandResult> => {
    const cfg = cfgNow()
    const home = resolveDshHome()
    const local = collectBackupSet(home)
    const keychainState = !keychainSupported()
      ? '不可用（非 macOS）'
      : (await getRememberedPassphrase()) !== undefined
        ? '已存有口令'
        : '空'
    return ok([
      `dsh-vault ${PLUGIN_VERSION}`,
      `  dsh home：   ${home}`,
      `  Vault 仓库： ${cfg.repo !== '' ? cfg.repo : `（默认）dsh-backup-<github用户名>`}`,
      `  本机目录：   ${vaultMachineName()}${cfg.machineDescription !== '' ? `（${cfg.machineDescription}）` : ''}`,
      `  记住口令：   ${cfg.rememberPassphrase ? 'on' : 'off'}（钥匙串：${keychainState}）`,
      `  本地备份集： ${local.files.length} 个文件${local.profileNames.length > 0 ? `，profile：${local.profileNames.join('、')}` : ''}`,
      `  排除：sessions/、storages/、node_modules、cordis.yml、匿名 id、使用统计`,
    ].join('\n'))
  }

  // -----------------------------------------------------------------------
  // /vault set
  // -----------------------------------------------------------------------

  const doSet = async (tokens: string[]): Promise<CommandResult> => {
    const [key = '', ...valueParts] = tokens
    const value = valueParts.join(' ').trim()
    const settings = ctx.get('settings') as SettingsService | undefined
    if (settings === undefined) return fail('settings 服务不可用，无法写入配置')

    switch (key) {
      case 'repo': {
        if (value !== '' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) {
          return fail('repo 需要形如 owner/name，或留空恢复默认 dsh-backup-<github用户名>')
        }
        await settings.mutate(OWN_NS, [{ op: 'set', path: ['repo'], value }])
        return ok(value === '' ? '✅ vault.repo 已恢复默认（dsh-backup-<github用户名>）' : `✅ vault.repo = ${value}`)
      }
      case 'machine-desc':
      case 'description': {
        await settings.mutate(OWN_NS, [{ op: 'set', path: ['machineDescription'], value }])
        return ok(value === '' ? '✅ vault.machineDescription 已清空' : `✅ vault.machineDescription = ${value}`)
      }
      case 'remember-passphrase': {
        const on = value === 'on' || value === 'true'
        const off = value === 'off' || value === 'false'
        if (!on && !off) return fail('用法：/vault set remember-passphrase on|off（on 时下一次带口令的 backup 会把口令存入钥匙串）')
        await settings.mutate(OWN_NS, [{ op: 'set', path: ['rememberPassphrase'], value: on }])
        if (!on) await keychainForget()
        return ok(on
          ? '✅ remember-passphrase on —— 下一次 /vault backup <口令> 会把口令存入钥匙串（仅本机）'
          : '✅ remember-passphrase off —— 钥匙串中的口令（如有）已删除')
      }
      case '':
        return fail(`用法：/vault set <repo | machine-desc | remember-passphrase> <值>\n\n${HELP}`)
      default:
        return fail(`未知设置项 “${key}”。可选：repo、machine-desc、remember-passphrase`)
    }
  }
}
