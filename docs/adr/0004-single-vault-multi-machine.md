# 单 Vault、机器分目录、默认名 dsh-backup-<username>

所有机器共用一个 GitHub 私有仓库，默认名 `dsh-backup-<github用户名>`（用户可通过 `/vault set` 覆盖），首次 backup 时不存在则自动创建（gh CLI token 的 `repo` scope 够用）。机器之间以 hostname 目录隔离（`machines/<hostname>/`）；restore 默认指向本机 hostname 的快照，也可显式选择 Vault 中任意机器的快照——跨机 Restore 即 Migration。数据传输走 gh API（Contents API），不 git clone。

GitHub 凭据不归本插件管：复用已登录的 gh CLI，兜底 `GITHUB_TOKEN` 环境变量，绝不实现任何登录/OAuth 流程（GitHub 登录明确不在 scope）。

## Considered Options

- 每机一个仓库：隔离彻底但仓库越攒越多，管理成本高。
- 不分机器互相覆盖：两台机器交替备份会互相冲掉，直接排除。

## Consequences

- 两台机器 hostname 相同会让目录互踩：快照清单里记录机器描述与首次备份时间，检测到 hostname 已存在但机器描述不同时提示确认或改名。
- 快照清单是明文的（只有元数据、无密钥材料），这是 restore 选择器免解密列出所有机器的前提。
