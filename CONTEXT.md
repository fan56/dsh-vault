# dsh-vault

通过 GitHub 私有仓库对 dsh 用户配置做加密备份、恢复与跨机迁移的独立 dsh 插件。

## Language

**Vault（保险库）**:
存放所有备份的 GitHub 私有仓库，挂在用户自己的账号下，可被同一用户的多台机器共用。
_Avoid_: backup repo、远端仓库

**Machine（机器）**:
Vault 中以 hostname 划分的目录单元。每台机器的快照只写进自己的目录，互不覆盖。

**Backup Set（备份集）**:
一次备份所覆盖的本地配置文件集合。dsh 会话数据、可再生的缓存与产物、本机身份不属于备份集。
_Avoid_: 配置、全量

**Snapshot（快照）**:
某台机器在某一时刻对整个备份集加密后的产物。每台机器只保留最新一份，新快照覆盖旧快照。
_Avoid_: 版本、历史

**Snapshot Manifest（快照清单）**:
与快照同存的明文元数据：机器名、机器描述、时间、dsh 版本、备份集内容摘要。不含任何密钥材料，是 restore 选择器的数据源。
_Avoid_: 裸用 manifest（与 Profile Manifest 混淆）

**Passphrase（口令）**:
由用户持有、用于派生快照加密密钥的口令。插件不生成、不托管、不找回；遗忘即快照永久不可解。
_Avoid_: 密码、密钥

**Profile Manifest（profile 清单）**:
决定某个 profile 安装哪些插件及其版本 pin 的声明文件。快照携带 Profile Manifest 而非插件本体；restore 凭清单重装插件。
_Avoid_: 插件列表、依赖清单

**Restore（恢复）**:
用选定机器的快照覆盖本机备份集对应文件、并按 Profile Manifest 重装插件的操作。可选任意机器的快照，不限于本机。
_Avoid_: 回滚、同步

**Migration（迁移）**:
不是独立能力，而是在新机器上执行一次指向他机快照的 Restore。
_Avoid_: migrate 命令
