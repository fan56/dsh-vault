# dsh-vault

[dsh](https://github.com/deepseek-ai/deepseek-harness) 插件：把本机 dsh 配置**加密备份**到自己的 GitHub 私有仓库，在新机器上**一条命令拉平**——恢复配置、按清单重装插件，跨机恢复即迁移。

零 npm 依赖：加密只用 Node 内置 `crypto`（scrypt + AES-256-GCM），GitHub 传输走 REST。

## 命令

```
/vault backup [口令]              备份并推送（repo 不存在则自动创建 private）
/vault restore [机器] [--yes] [口令]
                                  不带机器名 = 列出 Vault 里所有机器的快照
                                  跨机选择 = 迁移；--yes 才真正执行
/vault config                     查看当前设置
/vault set repo <owner/name>      覆盖默认仓库名
/vault set machine-desc <描述>    机器描述（写进快照清单，跨机选择时辨认用）
/vault set remember-passphrase on|off
                                  on 时下一次带口令的 backup 把口令存入钥匙串
```

## 备份集

**进**：`settings.yaml`、`.credentials.yaml`（API keys）、`APPEND_SYSTEM.md`、`agents/`、每个 profile 的清单四件套（`package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `cordis.patch.yml`）、home 级 `cordis.patch.yml`、`models-store.json`。

**不进**：`sessions/`、`storages/`、一切 `node_modules`（按清单重装）、`cordis.yml`（宿主启动时无条件重写）、`.anonymous-user-id`、使用统计。

## 安全模型

- 快照在离开本机前**整包加密**：口令 → scrypt 派生密钥 → AES-256-GCM（vault format v1，头部自带 KDF 参数与版本号）。
- 私有仓库只是第一道门（token 泄露），加密才是数据门。**口令遗失 = 快照永久不可解**，插件不做找回。
- 口令三种给法：命令内联（`recordInput: false`，不落会话日志）→ `$DSH_VAULT_PASSPHRASE` 环境变量 → macOS 钥匙串（`remember-passphrase on` 时自动存取）。
- backup 前做加密自检（加密后立即解回核对），坏快照不会顶掉好快照；restore 前把当前配置暂存到 `~/.dsh/vault/stash/`（保留最近 3 份）。
- GitHub 凭据：复用 `$GITHUB_TOKEN` 或已登录的 `gh` CLI；**登录不在插件职责内**。

## Vault 布局

```
dsh-backup-<github用户名>/          ← private，可 /vault set repo 覆盖
└── machines/<hostname>/
    ├── snapshot.enc               ← 加密快照（每机只留最新，覆盖式）
    └── manifest.json              ← 明文元数据（机器/描述/时间/文件清单，无密钥材料）
```

## 已知限制

- profile 清单里的 `file:` 绝对路径依赖（如本地 link 的插件）在别的机器上无效，restore 会警告，需手工处理。
- `.env`、`storages/`（含机器绝对路径）不迁移；会话历史不迁移。
- 每机只留最新快照（刻意为之，见 ADR 0003）——想加历史是格式级变更。
- restore 的插件重装依赖 `dsh` CLI 与 `pnpm` 在 PATH 上。

## 开发

```bash
pnpm install && pnpm build && pnpm test   # 单测（18 个）
node scripts/smoke-boot.mjs               # 真宿主 boot 冒烟（scratch profile）
node scripts/e2e-host.mjs                 # 真 GitHub 回环（沙箱 home + scratch repo）
./e2e/run-e2e.sh                          # podman 容器 e2e（隔离 ~/.dsh）
```

设计文档：[CONTEXT.md](./CONTEXT.md)（术语表）与 [docs/adr/](./docs/adr/)（备份集边界、加密方案、覆盖式快照、单 repo 多机布局）。
