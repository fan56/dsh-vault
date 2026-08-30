# 备份集边界：配置与清单进，会话与产物不进

备份集包含：`settings.yaml`、`.credentials.yaml`、`APPEND_SYSTEM.md`、`agents/`、每个已存在 profile 的清单四件套（`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml`）、home 级 `cordis.patch.yml`（如存在）、`models-store.json`。一律排除：`sessions/`、`storages/`、一切 `node_modules`、`cordis.yml`（宿主启动时无条件重写，备份无意义）、`.anonymous-user-id`、`tui-command-usage.json`。

插件以 Profile Manifest 加版本 pin 进快照，restore 时执行 `dsh plugin --profile <name> install`（宿主对 pnpm 的薄转发）重装，不打包 node_modules。迁移的目标是「新机器一条命令拉平」，不是逐字节复制。tui 等非模板 profile 的 package.json 丢失会让宿主启动硬错，因此 profile 清单是快照的必选内容，不是可选项。

## Considered Options

- 全量打包 `~/.dsh`：被拒——会话日志隐私重、体积大、迁移后无意义；node_modules 可由 npm/pnpm 重装。
- 极简仅 settings + credentials：被拒——违背「一条命令拉平、无需手动配置」的目标。

## Consequences

- 快照中 `file:` 开头的本地路径依赖（如 `dsh-llm-proxy` 指向 `~/repo`）在目标机器上大概率无效；restore 时检测到即报告，由用户决定丢弃该依赖或改指新地址，否则 pnpm install 会失败。
- `storages/workspace.json` 含绝对路径，随排除不迁移——会话历史与工作区注册表不随迁。
- `.credentials.yaml` 恢复后必须立即 `chmod 600`，否则宿主硬错误拒绝读取。
- restore 顺序固定：写回 profile 清单四件套 → `dsh plugin --profile install` → settings.yaml → .credentials.yaml（chmod 600）→ APPEND_SYSTEM.md、agents/、home cordis.patch.yml → models-store.json。
