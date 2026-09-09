---
name: dsh-vault-config
description: "dsh 加密备份插件（@aiwayds/dsh-vault）使用与配置指南。凡涉及 dsh 配置备份、跨机器迁移、/vault backup/restore/list，或要配置 vault 段时先读本指南：settings.yaml 顶层 `vault:` 段（repo/machineDescription/rememberPassphrase）、首次备份 ask_user_question 向导（收集仓库/机器描述/口令记忆后代写配置）、口令三种来源（参数/env/钥匙串）、GitHub 凭据（GITHUB_TOKEN 或 gh 登录）、口令遗失不可解。触发词：vault、备份、恢复、迁移、快照、钥匙串、passphrase、dsh-backup。"
---

# dsh-vault 使用指南（加密备份 / 迁移）

> dsh 插件：把整个 dsh home 配置**整包加密**（scrypt + AES-256-GCM）备份到你自己的
> GitHub 私有仓库，一条命令在新机器上恢复配置并按 manifest 自动重装插件。跨机恢复即迁移。

## 配置入口（settings.yaml 顶层 `vault:` 段）

在 `~/.dsh/settings.yaml` 写顶层 `vault:` 段：

```yaml
vault:
  repo: ""                        # 形如 owner/name；空 = 默认私有仓 dsh-backup-<GitHub用户名>
  machineDescription: ""          # 写进快照 manifest 的机器描述，跨机挑快照时辨认用
  rememberPassphrase: false       # on 后下一次带口令的 backup 把口令存入 macOS 钥匙串，restore 免输
```

- 三个键都可用 `/vault set repo|machine-desc|remember-passphrase` 运行时写回（即时校验）；
  直接编辑 settings.yaml 同样有效。
- 口令来源优先级：命令参数 → `$DSH_VAULT_PASSPHRASE` → 钥匙串（remember-passphrase on 时）。
- GitHub 凭据：`$GITHUB_TOKEN` 或已登录的 `gh` CLI（`gh auth status` 检查）；登录本身不在
  插件职责内，缺凭据先解决这一步。

## 交互式配置向导（ask_user_question）

用户说"帮我配置备份 / 配置 vault / 首次备份"时，不要甩文档让对方自己读——先跑
`gh auth status` 确认凭据，然后用 `ask_user_question` 逐题收集：

1. **备份仓库**：默认 `dsh-backup-<GitHub用户名>` 私有仓（推荐，首次 backup 自动创建）
   ／自定义 `owner/name`（需 GitHub 上存在或可创建）。
2. **机器描述**：主机名（推荐）／自定义文案（跨机挑快照时辨认用）。
3. **记住口令**：on（macOS 钥匙串，restore 免输；非 macOS 不可用）／off（每次手动提供）。

收集完代写 `vault:` 段进 `~/.dsh/settings.yaml`，然后引导首次备份，注意两条红线：

- **口令由用户自定，且必须由用户自己执行 `/vault backup <口令>`**——命令参数
  `recordInput: false`，不落会话日志。不要让用户把口令打在普通对话里（会进 session 日志），
  也不要求 agent 代输口令。
- **口令遗失 = 快照永久不可解**，插件不做找回。备份完成时提醒用户自行保管。

## 命令速查

| 命令 | 作用 |
|------|------|
| `/vault backup [口令]` | 备份并推送（私有仓不存在自动创建；推送前加密自检） |
| `/vault list` | 表格列出 Vault 里所有机器的快照（标出本机） |
| `/vault restore [机器] [--yes] [口令]` | 不带机器名 = 列表；带机器名 = 恢复计划；加 `--yes` 执行 |
| `/vault config` | 查看当前设置、钥匙串状态、备份集概况 |
| `/vault set repo <owner/name>` | 覆盖 Vault 仓库名 |
| `/vault set machine-desc <描述>` | 设置机器描述 |
| `/vault set remember-passphrase on\|off` | 开关钥匙串记忆（off 顺带删除已存口令） |

## 典型流程

- **首次备份**：配置向导 → 用户执行 `/vault backup <口令>`。
- **跨机器迁移**：新机器装好 dsh + 本插件 → `/vault restore` 看快照列表 →
  `/vault restore <机器名>` 看恢复计划 → 加 `--yes` 执行（旧配置自动 stash 到
  `~/.dsh/vault/stash/`，留 3 份；插件按 manifest 自动重装各 profile 的依赖）。
- **恢复后重启 dsh 生效。**

## 排障 / 红线

1. **备份集边界**：settings.yaml、`.credentials.yaml`、APPEND_SYSTEM.md、`agents/`、
   各 profile 清单四件套、models-store.json **进**备份；sessions/、storages/、
   node_modules、cordis.yml、使用统计**不进**。
2. `/vault backup` 提示"需要口令" → 按三种来源之一给；非 macOS 平台
   remember-passphrase 不可用（`/vault config` 会显示钥匙串状态）。
3. manifest 在但 `snapshot.enc` 缺失 → 仓库被绕过插件动过，去 GitHub 核对。
4. **卸载遗留**（`dsh plugin remove` 都不会碰，需手动处理）：钥匙串 `dsh-vault` 条目、
   GitHub 私有仓 `dsh-backup-<用户名>`、`~/.dsh/vault/stash/`、settings.yaml 的 `vault:` 段。
