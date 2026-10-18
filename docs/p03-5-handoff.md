# P03-5 Feature Worktree 与失败现场保留 — 集成回归与交接（P03-5 → P03-6/8/9 及 P03-10）

- 来源 Feature：P03-5（F-001 受控路径定位、F-002 持久化与原子回执、F-003 Git 元数据短锁、
  F-004 有界只读核验、F-005 首次准备、F-006 重复准备/中断恢复、F-007 失败保留、F-008 清理资格
  判定、F-009 非强制清理、F-010 人工丢弃预览/确认、F-011 组合根/Host 接线、F-012 CLI 操作面、
  F-013 真实资源集成回归与本文交接）。
- 交接对象：**P03-6**（FakeRuntime/执行接入）、**P03-8**（执行提交/交付）、**P03-9**（Run 控制
  与恢复）与 **P03-10**（阶段验收 `accept:p03` 提供方）。
- 输入文档版本：PRD `p03-workspace.md`（版本 0.3，2026-10-11，重规划待审阅，含 2026-10-13
  Runtime 恢复补充）、共同执行约束 `execution-contract.md`、恢复边界设计
  `core-design/14-runtime-recovery-and-durable.md`；实施契约为 `docs/p03-5-*.md` 七份
  （inspection / preparation-recovery / retention / cleanup-execution / discard /
  host-integration / cli-workspace-operations）。
- 基线与代码：P03-4 基线分支 `feat/2026-10-11-17-45-49_p03-4-task-dag`；各 Feature 提交
  F-001 `bb7b6a0`、F-002 `ca54895`、F-003 `a3ea588`、F-004 `a0f159b`、F-005 `f5a663e`、
  F-006 `fb32c75`、F-007 `ea6540c`、F-008 `383d208`、F-009 `b960b1e`、F-010 `6c0dff2`、
  F-011 `d11b8c7`、F-012 `fef03b4` + 契约快照修复 `192f323`；**F-013 交接提交即本文所在
  提交**（文档先于提交无法自引用完整 hash；精确 hash、验证命令/退出码与脱敏证据以 Feature
  工作区 `verifications/F-013/` 记录为准，未运行不计通过）。
- 本文只交接**已实现且已有真实测试**的公共面与失败边界；未实现/未运行能力显式标注
  `not_run`。**P03-5 不提供 `accept:p03`**（由 P03-10 提供），未运行真实 Pi SDK/模型。

## 1. 实现范围（逐 Feature）

| Feature | 交付 | 主要落点 |
|---|---|---|
| F-001 | PathService `feature_worktree_directory` 定位 + `deriveFeatureWorktreeRelativeDir` | `ports/path-service.ts`、`adapters/fs/path-service.ts` |
| F-002 | 受管 workspace 与 workspace_operations 持久读写、原子回执、owner/revision fencing | `ports/workspace.ts`、`adapters/sqlite/workspace.ts` |
| F-003 | `GitPublicMetadataLock` 短锁（共享 baseline claim、O_EXCL+fsync、fail-closed 现场核对） | `ports/git-public-metadata-lock.ts`、`adapters/fs/git-public-metadata-lock.ts` |
| F-004 | `WorkspaceInspector` 有界只读核验（登记/分支/HEAD/tracked/untracked/ignored 摘要） | `ports/workspace-inspector.ts`、`adapters/fs/workspace-inspector.ts` |
| F-005 | 首次准备：确认 baseCommit + 受管分支（`deriveManagedFeatureBranch` → `shiploop/feature/<sha256>`）+ 真实 worktree 创建 | `ports/workspace-preparation.ts`、`application/workspace-preparation.ts`、`adapters/fs/feature-worktree-preparer.ts`、`adapters/sqlite/workspace-preparation.ts` |
| F-006 | 重复准备核对复用、中断后补写原 operation（不重建目录/分支）、新 Attempt 关联 | 同上 + `docs/p03-5-workspace-preparation-recovery-contract.md` |
| F-007 | `WorkspaceRetention` 十类失败/中断原因保留；停止结论 not_started/confirmed/unknown → quarantined | `ports/workspace-retention.ts`、`application/workspace-retention.ts`、`adapters/sqlite/workspace-retention.ts` |
| F-008 | `decideWorkspaceCleanup` 纯判定（七门槛，默认保留） | `ports/workspace-cleanup.ts`、`application/workspace-cleanup-policy.ts` |
| F-009 | 获准安全成功后的非强制 `git worktree remove`（分支/审计保留，pending 恢复补写不重复删除） | `ports/workspace-cleaner.ts`、`application/workspace-cleaner.ts`、`adapters/sqlite/workspace-cleaner.ts`、`adapters/fs/feature-worktree-cleaner.ts` |
| F-010 | 独立人工丢弃 preview/confirm（破坏性范围绑定当前工作区与代码证据；迁移 v19 kind+`discard`） | `ports/workspace-discard.ts`、`application/workspace-discard.ts`、`adapters/sqlite/workspace-discard.ts`、`adapters/fs/feature-worktree-discarder.ts` |
| F-011 | 生产组合根装配 workspace 栈 + Host 授权/幂等通道（discard.preview 通用事务、discard 专属幂等通道） | `adapters/composition.ts`、`packages/host` |
| F-012 | CLI workspace list/get/operations/operation/discard-preview/discard + 结构化状态视图 | `packages/cli/src/app/*` |
| F-013 | 真实资源集成回归与本文交接（不新增产品行为/依赖/迁移） | `test/modules/workspace/p03-5-feature-integration.test.ts`、`test/modules/workspace/docs-p03-5-handoff.test.ts` |

## 2. 集成回归组合（F-013 验收 1/4/7；真实临时 SQLite/Git，无 Mock Git/进程）

`test/modules/workspace/p03-5-feature-integration.test.ts`（2 用例，生产组合根 `openCoreApplication`）：

1. **全链路组合**：经实际前序入口（`project.register` → `settings.global.create` →
   `phase.create` → `feature.plan.import` → `feature.plan.decide` 批准 → `execution.preview` →
   `execution.start` 授权，全部为真实命令服务提交）→ 组合根 `taskClaims.claimTask` 认领 →
   `workspacePreparation.prepare` 首次准备 → 合法进展（tracked 提交 + untracked + ignored）→
   可信内部进展登记 → `preparation_failed` 生命周期终态 → 新认领 Attempt-2 `prepare` 重复恢复 →
   `workspaceRetention.retain`（`execution_error`）失败保留。断言：tracked/untracked/ignored
   字节逐字节一致；合法已提交进展不重置（HEAD=进展提交）；`managed_workspaces` 登记唯一、
   `workspace_operations` 4 项逐项可审计；源仓库 HEAD、既有 refs、index、脏文件不变；新增
   受管 ref 单独列出且仅为 `refs/heads/shiploop/feature/<sha256(projectId, featureId)>`；
   `attempts_created=2`、`runtime_starts=0`、`runtime_start_reservations` 为空、
   `usage_summary` 恒 null（不冒充已知费用）；准备证据 Artifact 记录
   `runtimeRecovery: 'not_evaluated'`；原生档案字节不变、不复制进 worktree。
2. **未知停止持久隔离**：Runtime 启动占用已登记且无停止回执时，伪造 SDK 原生检查点在场
   也**不改变**结论——`retain` 仍 `quarantined`（stop=unknown，SDK 检查点不能替代停止证据）；
   三组 `workspace_leases` 租约全部隔离；SQLite 与组合根重开后隔离持久化；重复 `prepare`
   拒绝（禁止未知停止后重跑、无双重写入者）；现场字节、原生档案与登记不变。

既有 Host/CLI 构建入口链路（F-011/F-012 交付，本轮复跑）：
`test/modules/workspace/p03-5-workspace-host-integration.test.ts`（真实 Host + loopback HTTP + 生产组合根：
认领→准备→保留→预览→确认丢弃纵向、pending 意图恢复、授权/幂等/版本纪律）与
`test/modules/workspace/p03-5-cli-workspace-built.test.ts`（`npm run build` 产物 `dist/bin.js` + 临时 Host：
状态读取、缺确认本地拒绝、伪造摘要服务端 conflict 拒绝、帮助边界声明）。普通测试无网络模型；
测试资源在证据落盘后由夹具有界清理，产品失败现场默认保留（retained/quarantined 均不删除）。

## 3. 负例矩阵复核（F-013 验收 2；复跑各职责已建立负例，均为真实资源测试）

| 矩阵项 | 证据（测试文件 / 用例） |
|---|---|
| 错误目录/分支/HEAD | `p03-5-feature-worktree-paths.test.ts`（归属/越界/穿越）、`p03-5-workspace-preparation.test.ts`「refuses wrong_branch/detached/replaced reuse…」、「rechecks…unrecorded descendant HEAD without resetting files」 |
| 链接越界 | `p03-5-feature-worktree-paths.test.ts`（lstat+realpath 祖先链、悬空/环路 escape）、`p03-5-workspace-preparation.test.ts`「refuses symlink/foreign_repository reuse…」 |
| 旧进程仍写文件 | `p03-5-workspace-retention.test.ts`（macOS 真实父进程退出后子进程持续写入 → 不释放、隔离） |
| 遗留锁 | `p03-5-git-operation-lock.test.ts`（原生 .lock 现场、损坏/未知 claim fail-closed、不按 PID/TTL 接管） |
| baseline 双向占用 | `p03-5-git-operation-lock.test.ts`（共享 `shiploop-baseline.claim`、baseline guard 同锁注入）+ 前序 baseline 占用回归 |
| 竞争准备/CAS | `p03-5-workspace-preparation.test.ts`「serializes competing recovery and fences late results/quarantine…」、`p03-5-workspace-persistence.test.ts`、`p03-5-workspace-cleaner.test.ts`「清理与新认领互斥/旧身份 fencing」 |
| 创建后回执故障 | `p03-5-workspace-preparation.test.ts`「reconciles Git creation after a receipt transaction failure and database reopen without repeating Git add」、「recovers after_git/after_inspection/before_receipt interruption…」 |
| 删除后回执故障 | `p03-5-workspace-cleaner.test.ts`（pending 恢复补写不重复删除）、`p03-5-workspace-discard.test.ts`（崩溃恢复对账 recovered 不重复删除） |
| 未知停止后重跑/双重写入者 | `p03-5-workspace-retention.test.ts`（unknown → quarantined 持久化、重开拒绝）、`p03-5-feature-integration.test.ts` 用例 2 |

以上负例在完整门禁中复跑（§6），不重建 P03-9 完整控制恢复（Run 级 resume 不在本 Feature）。

## 4. 清理/丢弃真实 Git 证据（F-013 验收 3）

- **非强制删除成功**：`p03-5-workspace-cleaner.test.ts`——cleanable 决策 + 决策时授权摘要 +
  锁内复核后单次 `git worktree remove`（无 --force）；分支与审计/operation 行保留；源仓库
  HEAD/refs/index/脏内容逐项不变。
- **拒绝矩阵**：`p03-5-workspace-cleanup.test.ts`（36 表驱动用例）覆盖失败/partial/人审等待/
  提交失败/脏内容/tracked/untracked/未知或受保护 ignored/证据缺失过期逐项拒绝；
  `p03-5-workspace-cleaner.test.ts` 断言 Git 拒绝不降级为强制删除、停止不确定 → blocked+隔离。
- **人工丢弃**：`p03-5-workspace-discard.test.ts`（21 用例）——预览只读/确定性/有界截断；
  伪造摘要/过期预览/异主体重放拒绝；内容变化四类拒绝零删除；唯一单次 `--force` 由真实
  Git 执行且锁住 worktree 由 Git 拒绝。
- 成功证据使用明确受信夹具（真实临时 Git/SQLite + 可信内部回执）；**不依赖**后序 P03-8
  提交实现、不做生产手工改库、不把 Runtime 结束冒充通过（本 Feature 无 Runtime 启动，
  `runtime_starts` 恒 0）。

## 5. 验收索引映射（T08 工作区子集 / T29 Git 资源子集 / T36 保留现场）

「仅声明本项适用范围，不代表已通过」——以下为 P03-5 实际交付证据；范围外显式 not_run：

| 编号 | P03-5 交付子集 | 范围外（not_run） |
|---|---|---|
| T08 工作区子集 | 受控路径定位（F-001）、首次准备/重复恢复（F-005/F-006）、有界只读核验（F-004）、失败保留（F-007）、清理资格与非强制清理（F-008/F-009）、人工丢弃（F-010）、Host/CLI 面（F-011/F-012）、集成回归（F-013 §2/§3） | Runtime 实际在 worktree 内执行、Runner 启动/停止全链路（P03-6 起） |
| T29 Git 资源子集 | 短 Git 元数据锁与 baseline 协调（F-003）、锁顺序项目→工作区→短 Git 操作、创建/删除前后源仓库逐项保护断言（各准备/清理/丢弃测试） | 自动合并/push/PR（PRD 明确不包含）、P03-8 执行提交 |
| T36 保留现场 | 十类原因保留、unknown → quarantined 跨重开持久化、字节/refs/审计保留（F-007 + F-013 §2 用例 2） | 完整中断/恢复控制面（P03-9）、失败现场自动归因分析 |

## 6. 完整门禁与验证记录（真实命令/退出码）

- F-013 新增测试定向运行：`node scripts/run-tests.ts test/modules/workspace/p03-5-feature-integration.test.ts
  test/modules/workspace/docs-p03-5-handoff.test.ts` → exit 0（首轮集成断言真实失败后修正，失败日志保留在
  `tool-logs/f013-integration-first.log`，成功日志 `f013-integration-green.log`）。
- 完整 verify 门禁：`npm run verify`（预检 + `npm test` + `npm run typecheck` + `npm run build`
  含三包入口冒烟）→ exit 0；`npm test` 覆盖 **219 files / 4528 passed / 1 skipped（既有）**，
  `npm run typecheck` 与 `npm run build` 均 exit 0。原始日志 `tool-logs/f013-verify-final.log`。
- `npm run check:boundaries` → exit 0（185 production source files / 0 diagnostics）；
  `git diff --check` → exit 0。
- 完整输出、退出码与脱敏证据路径记录于 Feature 工作区 `tool-logs/f013-*.log` 与
  `verifications/F-013/`（本仓库文档不内联一次性绝对路径/run-id）。
- `accept:p03`：**not_run**（P03-10 提供）；真实 Pi SDK/付费模型：**not_run**；
  Windows/WSL/Linux：未验收。

## 7. 恢复边界（core-design/14；F-013 验收 7）

- 恢复来源与 worktree 身份**分别核验**：恢复决策核对目录身份、Git 登记、repoIdentity/
  common dir、规范路径、branch、HEAD（`feature-worktree-preparer` + 准备恢复契约）；原生
  会话/检查点不属于本 Feature 的恢复依据，准备证据恒记录 `runtimeRecovery: 'not_evaluated'`。
- SDK 检查点不能替代停止证据：停止结论只来自可信 verifier 的 confirmed / 未启动
  not_started；其余一律 unknown → quarantined（§2 用例 2 伪造检查点在场仍隔离）。
- 原生 SQLite 档案与 Core 主库分离：不共用连接、不复制仍打开的档案、不读取 SDK 私有表；
  两个 Attempt 不共写同一原生档案。Runner/SDK 层单写入者约束由后续 Runtime 适配落实，
  Core 侧约束为占用 fencing + 来源不可变。

## 8. P03-6/8/9 可复用公共面（不得重建第二套）

- **工作区定位/授权**：`PathService` `feature_worktree_directory` 与
  `workWorkspaceAuthority.verifyPreparation`（组合根装配，权标不可伪造）。
- **锁**：`GitPublicMetadataLock`（组合根共享实例；任何公共 Git 元数据变更必须经短锁，
  不持锁等待执行）。
- **准备/恢复**：`app.workspacePreparation.prepare`（幂等 operationId、checkpoint journal、
  停止核验 `verifyPreparationStop`、证据发布后再核验 HEAD/digest）；重复准备核对复用语义
  见 `docs/p03-5-workspace-preparation-recovery-contract.md`。
- **保留**：`app.workspaceRetention.retain`（十类原因、停止三分结论、隔离持久化）。
- **清理**：`decideWorkspaceCleanup` 纯判定 + `app.workspaceCleaner.clean`（非强制）；
  P03-8 交付成功后装配清理授权输入，不绕过资格判定。
- **丢弃**：`app.workspaceDiscard`（`workspace.discard.preview` / `workspace.discard` 命令面，
  预览摘要绑定 + 确认重核）；CLI `workspace` 命令组与结构化视图（completion 恒 false，
  不冒充交付）。
- **占用/认领**：P03-4 `workResources` 三组租约 + `taskClaims`；Attempt 生命周期通知
  `preparation_failed` 释放未启动占用。
- **查询**：`queryService` workspace 四查询（project.read 能力位、有界分页、受控游标）。

## 9. 已知缺口与契约冲突核对（不折算通过）

1. **Runtime 未接入**：无 Runner/SDK 启动、无 SessionRecorder；`runtime_starts` 恒 0，
   `usage_summary` 恒 null；Run 保持 queued + `scheduler_not_assembled`（P03-6 起装配）。
2. **清理授权来源未接**：`decideWorkspaceCleanup` 的 delivery/authorization 输入需 P03-8
   交付事实；当前未装配时保守保留（不自动清理）。
3. **生产能力目录为空**：与 P03-3 交接一致 fail-closed；本 Feature 测试使用显式受信目录。
4. **契约冲突**：F-006 实施中发现 SQLite 身份冻结触发器与恢复补写路径的张力，已按
   `docs/p03-5-workspace-preparation-recovery-contract.md` 定案（核对现场并补写原 operation，
   不改写历史迁移）；F-012 发现 `APP_CLI_COMMANDS` 冻结快照漏同步已修复（`192f323`）。
   无未决契约冲突。
5. P03-10 阶段验收（T08/T29/T36 全量、跨 Feature 场景）不在本 Feature 范围，本文不预支通过。

## 10. 交接纪律

- P03-6/8/9 起步基线 = F-013 交接提交（§开头记录方式）；开工前核对公共接口与真实测试，
  不把本文历史表述当现状。
- 不得重建：workspace 持久化/operation 体系、Git 短锁、检查器、准备/保留/清理/丢弃服务、
  Host 命令/查询通道（线消息版本纪律沿用）。
- 不得弱化：默认保留、unknown 不释放、非强制删除不降级、源仓库逐项保护、字节级证据、
  「不冒充 Runtime 通过」边界。
- 本文档事实与守护测试 `test/modules/workspace/docs-p03-5-handoff.test.ts` 同源；后续 Feature 改变这些事实时
  必须同步更新本文与守护。
