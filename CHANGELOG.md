# Changelog

## 0.1.0

首个版本。

- `/vault backup [口令]`：打包备份集（settings、credentials、agents、profile 清单四件套、home 级 patch、models-store），scrypt + AES-256-GCM 整包加密后推送到 GitHub 私有仓库（默认 `dsh-backup-<github用户名>`，不存在则自动创建），按 hostname 分目录，只保留最新快照。
- `/vault restore [机器] --yes [口令]`：列出 Vault 中所有机器的快照（读明文 manifest，免解密），跨机选择即迁移；解密 → 本地暂存当前配置 → 覆盖写回 → 按 profile 清单执行 `dsh plugin --profile <name> install` 重装插件。
- `/vault config` / `/vault set repo|machine-desc|remember-passphrase <值>`：查看与修改设置（settings.yaml 的 `vault` 命名空间）。
- 口令来源三通道：命令内联（`recordInput: false` 不落会话日志）、`DSH_VAULT_PASSPHRASE` 环境变量、macOS 钥匙串（`remember-passphrase on` 时 backup 自动存入）。
- 零 npm 依赖：加密只用 Node 内置 `crypto`，GitHub 传输走 REST + `gh auth token`/`GITHUB_TOKEN`（GitHub 登录不在插件职责内）。
