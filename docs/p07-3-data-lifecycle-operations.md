# P07-3 数据生命周期操作说明（F-016）

适用版本：P07-3 分支 `feat/2026-10-29-21-59-22_p07-3`（F-016 提交，基线 `66e4ec5`）。
本文面向 owner/运维，说明公开备份、核验、确认恢复、归档、删除与保留政策的操作流程、
包格式与兼容边界、代码仓库保留项、错误/中断处理与未验证平台。命令均以仓库内
Node 22.19.0 / npm 10.9.3 为准；示例中的 `<dataRoot>` 是 Host 数据根绝对路径。

## 1. 公开备份与核验（经 Host/CLI）

```bash
# 创建备份（accepted + operationId；完成事实由持久操作日志与备份包目录给出）
app backup create --backup-id <backupId> --data-root <dataRoot> --json
app backup operation <operationId> --data-root <dataRoot> --json   # 轮询至 completed/failed
app backup get <backupId> --data-root <dataRoot> --json             # complete/incomplete/failed
app backup verify --backup-id <backupId> --manifest-digest <digest> --data-root <dataRoot> --json
```

- 命令面为 `data.backup.create` / `data.backup.verify`（global scope + `data.backup` 能力；
  受限主体 403）。accepted 后导出异步执行，同 commandId 重放返回原回执、不重复导出。
- 完成状态只读持久事实：`<dataRoot>/backups/operations/<operationId>.json` 与
  `<dataRoot>/backups/<backupId>/`；不要凭日志文字判断完成。
- fail-closed：包内任一必需制品引用缺失、内容漂移、记录覆盖不完整（`recording_incomplete`）
  或会话声明了不可导出的原生存储（`native_archive_unavailable`）时，**不发布包**，
  操作日志如实 `failed` + reasons，不留下半完整目录。带真实缺口（partial + missing_reasons）
  的记录同样拒绝发布完整包。
- 升级前备份：Host 启动发现旧 Schema 且存在业务数据时先做受验预升级包再迁移；
  备份 IO 失败、包体缺失或独立复验失败均阻断迁移并保持旧 Schema，writer lock 释放
  （见 F-007 场景与 `docs/p07-3-f007-host-upgrade.md`）。

## 2. 确认恢复（owner 离线维护入口）

恢复不经 HTTP（`data.backup.restore` 命令面 unsupported），只在持有目标根 writer lock 的
独立维护入口执行；不发现/启动 Host、不直接补库：

```bash
app restore verify   --data-root <targetRoot> --package <dataRoot>/backups/<backupId> --json
app restore prepare  --data-root <targetRoot> --package ... --operation-id <opId> --json
# 把输出的 confirmation 写入文件后：
app restore confirm  --data-root <targetRoot> --operation-id <opId> --confirmation-file <file> --json
```

- prepare 内部执行完整包核验（`backup_not_verified` 即拒绝：缺正文/篡改/高版本包都不例外），
  确认文档绑定 manifest/verification 摘要与目标根身份；目标必须为空（仅允许 host/锁/staging）。
- 发布后的目标根是隔离恢复根：首次打开即生成新的 Host 身份/凭据；恢复回执如实声明
  `execution: blocked_pending_current_repository_and_stop_checks`。恢复后的公开查询可以
  返回管理数据（项目/预算/记录事实逐表一致），但执行恢复被阻断
  （`restored_data_requires_current_facts`），维护门禁拒绝写入，不把“管理数据可用”
  报成“已恢复执行”。缺正文/篡改包拒绝完整恢复，原包不受影响。
- 中断窗口（copy/prepublish/publish）由 `restore-operation.json` 意图日志承接；未完成意图
  阻止任何 Host 连接与迁移，续跑按同一 operationId 幂等续核。

## 3. 归档、删除与保留政策

```bash
app project archive <projectId> --revision <rev> --data-root <dataRoot> --json     # 等待安全收尾
app project restore <projectId> --revision <rev> ... --json                        # 显式恢复
app project delete-preview <projectId> ... --json                                  # 只读有界预览
app project delete-confirm <projectId> --revision <rev> --preview-digest <d> --expires-at-ms <t> --confirm --json
app project delete-operation <operationId> ... --json                              # 最小受控查询
app retention evaluation --data-root <dataRoot> --json                             # 只读评估
app retention cleanup --data-root <dataRoot> --json                                # 显式清理（需已配置政策）
```

- 归档进入 `archiving` 后在收尾预算内轮询活动占用（活动 Batch/Run/Attempt、held/quarantined
  租约与认领、未确认停止、进行中的基线操作）；结算后完成归档（settled=true），超时回执如实
  settled=false + 阻塞计数。归档不删除任何文件，不触碰源 Git 仓库。
- 删除必须先归档；活动执行在预览中列出真实阻塞（`active_execution` 等）且 confirm 拒绝、
  不建立删除意图。确认 accepted ≠ 已删除；执行由可信删除执行器消费固定 manifest，
  按检查点幂等续核，回执丢失后重复执行返回同一完成事实、无重复副作用。
- 源代码仓库默认保留：删除只作用于受管制品正文、登记 staging、受管 worktree 与管理数据；
  源仓库/公共 Git 元数据/分支/独立备份不在删除范围，源路径不能被拼接成删除目标。
- 保留政策是唯一清理依据（未配置 → cleanup 拒绝 `retention_policy_not_configured`，不伪造执行）：
  `evidenceRetentionDays` / `backupRetentionDays` / `maxBackupCount` / `diskMinFreeBytes` /
  `diskMinFreePercent`（仅 global scope）。存在引用、身份不确定、磁盘观测未知、活动 operation
  的证据一律保守保留；最新一包备份始终保留；清理与备份互斥共享维护占用。清理在快照后
  复核新增引用（`reference_added_after_snapshot` 即保留），磁盘阈值触发不弱化任何保护。
- 受管 `backups/operations` 操作日志目录不是备份包：保留清点与磁盘观测均跳过该目录
  （F-016 修复；此前真实数据根上的清理会被误判 `backup_manifest_unreadable` 而全量保守）。

## 4. 包格式与兼容边界

- 备份包目录：`core.sqlite`（SQLite backup API 一致快照）+ `artifacts/<projectId>/<artifactId>`
  正文 + `manifest.json`（schemaVersion 1 / packageVersion 1）。manifest 登记 database 摘要与
  Schema 版本、逐文件 SHA-256/大小、recorder 水位/覆盖/缺口、nativeRecords、外部依赖
  （repository/worktree 均 `preserved` + `external_path_revalidation_required`，不可直接续跑）。
- 能力模块 `capability_modules.content_ref` 可为 `builtin:` 前缀的不透明内置引用（无包内正文），
  也可为制品稳定 ID；备份与删除清点只把制品稳定 ID 形态（`[A-Za-z0-9._-]`）当作制品引用
  核对（F-016 修复；此前 P06 画像项目的备份/删除会被误报 `unknown_required_reference`）。
- 兼容边界：未知 manifest/package schemaVersion、更高 Schema 版本的目标库均明确拒绝
  （`unsupported_version`），不猜测降级；迁移失败保留原包与原库，不覆盖唯一有效数据。
- 备份不能靠拷贝活跃单个 db 文件获得：包内数据库必须经 SQLite backup API 导出并附完整性检查。

## 5. 错误与中断处理速查

| 现象 | 处置 |
| --- | --- |
| 备份操作 failed + `incomplete` | 按 reasons 定位：必需引用缺失/内容漂移/记录不完整/原生归档不可导出；修复后用新 backupId 重做，不覆盖旧包 |
| restore prepare `backup_not_verified` | 包缺正文/被篡改/高版本；用原包重试，勿手工补文件 |
| 目标根 `target_not_empty` | 恢复目标是隔离发布：只允许空根（host/writer.lock/staging）；换新根 |
| 归档 settled=false | 按回执 blockers 结算活动执行/停止确认后重新归档（可查询 archiving 继续） |
| 删除 confirm conflict | 预览不可确认/摘要漂移/stale revision：重新 preview，不重放旧摘要 |
| 清理 `reference_added_after_snapshot` 保留 | 预期保护：新引用使旧候选失效；不强制删除 |
| 维护占用 `resource_busy`（storage_busy） | 备份/清理互斥：等当前维护收尾后重试，勿并开第二维护者 |

## 6. 未验证平台与边界

- 正式验收仅 macOS（darwin）；Windows/WSL/Linux 未验证，不在当前通过条件内。
- 原生存储归档导出/续跑能力未实现：会话声明 `native_ref` 即拒绝完整备份（诚实失败），
  恢复后原生历史按 manifest 版本/水位/缺口核对，不宣称可续跑。
- 远端备份、PG、自动接管未知进程、外部 Webhook/系统通知不在本 Feature 范围。

## 7. 本 Task 实测记录（F-016）

- 代码：`feat/2026-10-29-21-59-22_p07-3` 分支 F-016 提交（基线 `66e4ec5`，Node 22.19.0）。
  生产修复三处：备份包必需引用核对跳过非制品形态的内置能力模块引用
  （`packages/core/src/adapters/sqlite/backup-package.ts`）；项目删除清点同一口径修复
  （`packages/core/src/adapters/sqlite/project-delete-inventory.ts`）；保留清点与磁盘观测
  跳过受管 `backups/operations` 日志目录（`packages/core/src/adapters/sqlite/evidence-retention.ts`、
  `packages/core/src/adapters/fs/disk-observation.ts`）。新增跨层场景
  `test/modules/lifecycle/p07-3-f016-backup-restore-integration.test.ts`（3 项）与
  `test/modules/lifecycle/p07-3-f016-lifecycle-fault-races.test.ts`（4 项），共享夹具
  `test/helpers/p07-3/lifecycle-app-fixture.ts`。
- 命令与退出码（全部经 `nezha.dag.test_command` 助手留存完整日志，目录
  `verifications/F-016/runtime-logs/`）：
  - 新增 lifecycle 2 文件：`node scripts/run-tests.ts <file>` 退出码 0（3 项 + 4 项通过）。
  - 受影响回归 14 文件：备份包/核验/删除预览/保留清理/保留评估（5 文件 23 项，退出码 0，
    192.4s）、离线恢复/备份 Host/CLI/保留评估 Host（5 文件 31 项，退出码 0，20.4s）、
    删除执行器/删除命令/生命周期/CLI 垂直（4 文件 40 项，退出码 0，498.5s）。
  - `npx tsc --noEmit` 通过；边界检查见下。
- Task 测试索引：`test/index/phases/P07/features/P07-3/tasks/F-016.json`；影响映射与
  T08/T15/T16 基础回归、P07-1/P07-2 复用点见第 8 节。
- 缺口（如实记录）：完整 `npm run verify`（含全仓 `npm test`）**not_run**；全仓历史回归
  **not_run**；Feature task_union、Phase 集成验收、live 验证与真实模型 **not_run**——
  由配置的独立门禁与人工发起，本地局部通过不替代。原生存储导出能力未实现（见第 6 节）。

## 8. 影响映射（T08/T15/T16 基础回归与 P07-1/P07-2 复用点）

| 场景 | 本 Task 新增 | 复用/基础回归（已在前序 Task 落地并登记于索引） |
| --- | --- | --- |
| T16 备份/恢复跨层（公开入口→隔离恢复→事实对照） | `[case:public-backup-restore-roundtrip]` | `p07-3-f003/f004/f005`（SQLite 备份/包/核验）、`p07-3-f006-offline-restore`、`p07-3-f014-backup-cli/host` |
| T16 缺正文/篡改/原生归档拒绝 | `[case:missing-or-tampered-package-rejects-restore]`、`[case:declared-native-archive-refuses-backup]` | `p07-3-f005-backup-verification`、`p07-3-f007-host-upgrade`（升级前备份失败阻断、高版本拒写） |
| T15 归档/删除边界 | `[case:active-blockers-and-archive-safe-closeout]`、`[case:delete-receipt-loss-idempotent]` | `p07-3-f008-project-lifecycle`（归档收尾等待）、`p07-3-f009/f010`（预览/确认）、`p07-3-f011-project-delete-executor`（含 `[case:legacy-modern-common-lock]` Git 公共锁竞争、三类中断续核）、`p07-3-f015-cli-vertical` |
| 保留政策与磁盘阈值 | `[case:cleanup-vs-new-reference-race]`、（清理互斥见维护竞争） | `p07-3-f012-retention-evaluation(+host)`、`p07-3-f013-evidence-retention`、`p07-3-f015-retention-cleanup-command` |
| 维护/派发屏障竞争 | `[case:maintenance-vs-dispatch-race]` | `p07-3-f002-maintenance-gate`（fencing/quiesce）、`p07-3-f013`（备份互斥） |
| P07-1 复用点 | — | Recorder 水位/缺口/恢复事实由 `p07-2-f006-recording-recovery`、`p07-2-f007/f008` 奠定；F-016 夹具按同一 sessions/manifests 表结构写入并核对 |
| P07-2 复用点 | — | `p07-2-f005-recording-supervision/process`（进程监督/停止核验语义被删除执行器与恢复门禁复用）；`p07-1` Git 回执/恢复（`p07-1-f007-git-receipt-recovery`、`p07-1-f010-recovery-closeout`）为删除执行器的续核口径来源 |
