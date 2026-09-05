# Changelog

## 0.3.1

### Changed

- README（en/zh）新增「卸载」一节：`dsh plugin remove` 命令、宿主自动清理范围（bundles 条目 + patch 层），以及四样卸载后仍留存的物件——钥匙串条目 `dsh-vault`（先 `/vault set remember-passphrase off` 或事后在钥匙串访问删除）、GitHub 私有仓库 `dsh-backup-<用户名>`、`~/.dsh/vault/stash/` 暂存（含 `.credentials.yaml`，`rm -r ~/.dsh/vault` 清除）、settings.yaml 的 `vault:` 段。
- boot 冒烟（`scripts/smoke-boot.mjs`）新增卸载环节：boot 证明之后执行 `dsh plugin --profile smoke remove`，并断言组合树已回到 stock 形态（再次 `--dump-config` 中插件 id 消失）。

## 0.3.0

### Changed

- **BREAKING — 只跟随 dsh RC/stable 线，alpha 线退役**：README 宣布本插件仅支持 rc/stable 宿主线，不再支持 alpha 线。
- **dsh host floor `>= 0.1.2-rc.1`**：peerDependencies 下限全部迁到 0.1.2-rc.1，devDependencies 闭包精确钉版 0.1.2-rc.1（原 0.1.2-alpha.4）。
- CI 与发版工作流安装 dsh CLI 改为运行时解析 `latest`（stable）/`next`（rc）dist-tag 中更新者（plain semver compare，stable 0.1.2+ 上线 `latest` 即自动胜出），不再读已退役的 `@alpha`。
- **BREAKING — dsh host floor `>= 0.1.2-alpha.3`, rc-line support dropped**: all pins move to the 0.1.2-alpha.3 host closure（peers cordis ^4.0.2、dsh-commands / dsh-settings >=0.1.2-alpha.3、schemastery ^3.18.2；devDependencies 精确钉版）。
- dsh-settings 0.1.2-alpha.3 移除了 `settingsNamespace()` 运行时助手：`vault` 命名空间改为普通字面量（类型级品牌校验 `SettingsNamespaceInput` + 宿主侧运行时校验）；通过 type-only side-effect import 保留 dsh-settings 对 cordis 的 ctx.settings 增强。

### Added

- CI 的 dsh CLI 安装改走滚动 `@alpha` dist-tag（latest 仍指向被放弃的 rc 线），并新增 `scripts/link-dsh-closure.mjs` 把 `node_modules/@deepseek-ai/*` 指到已装宿主的闭包，typecheck / 单测 / smoke 与宿主完全同源。

## 0.1.0

首个版本。

- `/vault backup [口令]`：打包备份集（settings、credentials、agents、profile 清单四件套、home 级 patch、models-store），scrypt + AES-256-GCM 整包加密后推送到 GitHub 私有仓库（默认 `dsh-backup-<github用户名>`，不存在则自动创建），按 hostname 分目录，只保留最新快照。
- `/vault restore [机器] --yes [口令]`：列出 Vault 中所有机器的快照（读明文 manifest，免解密），跨机选择即迁移；解密 → 本地暂存当前配置 → 覆盖写回 → 按 profile 清单执行 `dsh plugin --profile <name> install` 重装插件。
- `/vault config` / `/vault set repo|machine-desc|remember-passphrase <值>`：查看与修改设置（settings.yaml 的 `vault` 命名空间）。
- 口令来源三通道：命令内联（`recordInput: false` 不落会话日志）、`DSH_VAULT_PASSPHRASE` 环境变量、macOS 钥匙串（`remember-passphrase on` 时 backup 自动存入）。
- 零 npm 依赖：加密只用 Node 内置 `crypto`，GitHub 传输走 REST + `gh auth token`/`GITHUB_TOKEN`（GitHub 登录不在插件职责内）。
