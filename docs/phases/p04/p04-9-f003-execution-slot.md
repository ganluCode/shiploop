# P04-9 F-003 单执行槽位事务原语与资源职责

日期：2026-10-22。范围：`packages/core/src/ports/execution-slot.ts`（契约）、
`packages/core/src/adapters/sqlite/execution-slots.ts`（SQLite 短事务原语）、
`packages/core/src/index.ts`（契约导出）、测试夹具与索引。实现边界以
`input/p04-dispatch-foundation.md` §3.2 与 `core-design/15` §3 为准。

## 复用了什么，为什么不新建第二套状态

| 事实 | 来源 | 本任务处理 |
| --- | --- | --- |
| 槽位行形态、状态枚举、`held→released/quarantined` 转换、容量缺省 | F-001 `ports/execution-dispatch.ts` + 迁移 v33 | 直接复用校验器与表；不新增列/迁移 |
| Run 级认领身份（项目/Feature/Run/owner/Host/`claimVersion`）、活动唯一与租约上限 | `run_dispatch_claims`（v33）与 insert trigger | 获取时在同一事务内重核；槽位租约不得长于认领租约 |
| 三组 Attempt 租约、基线占用、Git 公共元数据短锁 | `workspace_leases`、`baseline_occupancy`、`git_operations`/Git 公共元数据锁 | 完全不改；槽位原语不写这些表，也不把槽位伪装成工作区租约 |
| Task/Attempt fencing | `attempts.execution_version` | 不读取、不比较；`claimVersion` 与 `executionVersion` 保持两个计数器 |
| 持久入队意图 | F-002 `run_dispatch_intents`（v34） | 不修改；槽位获取属消费侧准入，由 F-004 在认领事务内调用 |

槽位是「同时运行的 Run 消费者数量」的准入事实，不是资源排他锁：它既不替代
`global:execution`/项目 Work/工作区租约，也不替代基线占用或 Git 短锁。

## 身份、容量与状态

- 身份：`projectId + featureId + runId + claimId + claimVersion + ownerId +
  hostInstanceId`。获取不接受调用方自选 `slotIndex`、`state`、`executionVersion`
  等额外字段（未知字段直接校验失败），避免“点一下就能指定槽号/伪造版本”。
- 槽号：容量固定后，在 `[0, capacity)` 内取最小空闲槽号；`held` 与
  `quarantined` 都占用活动槽号，`released` 不占用。
- 幂等：同一认领身份重复获取返回同一行（同 id、同 revision、租约不变），不新增
  第二槽位；同一 Run 的活动槽位属于另一代认领/owner/Host 时拒绝。
- 容量：缺省 1。`createSqliteExecutionSlotAccess` 在装配期调用
  `validateExecutionSlotCapacity`：>1 返回 `capacity_unsupported`，0、负数、
  非整数、非数字一律验证失败；不会“接受配置后暗中串行”。生产并发政策 >1
  仍由既有 `assertSingleWorkConcurrencyAuthorization` 明确拒绝
  （`concurrency_not_supported`）。
- 状态：`held` → `released`（核对停止后的正常释放，终态）或 `quarantined`
  （待核对隔离）。隔离不能回到 `held`，`released` 不复活（DDL trigger）。
- 到期：`held` 且租约到期的槽位只允许 `expireInTransaction` 转
  `quarantined`（原因 `lease_expired_unverified`），保留原租约与槽号，继续占用
  量额；不删除、不缩短、不重新分配，也不把到期当成“已停止”。

## 固定准入与取锁顺序

1. 受信调用方已打开短写事务（`transactWrite`），进入槽位原语；
2. 校验身份/租约输入（未知字段、过期租约、伪造槽号拒绝）；
3. 事务内重核 Run 级认领行：项目/Feature/Run/代次/owner/Host、`held`、
   认领租约 ≥ 槽位租约；
4. 读取该 Run 的活动槽位：同身份复用；异身份/隔离/到期 fail-closed；
5. 统计活动槽位并与容量比较，取最小空闲槽号；
6. 插入槽位行，`(slot_index)`/`(project, run)` 活动唯一索引兜底并发；冲突方
   得到 `execution_slot_unavailable` 并由调用方整组回滚。

既有资源顺序不变（Task 认领事务内：Task 版本 CAS → Attempt → 预算预占 →
`global:execution` → 项目 Work → workspace → 事件/回执）。F-004 可在同一事务内
在预算预占前后调用本原语；槽位行本身不参与该顺序的资源排他。事务与 Git 短锁内
只做同步 SQL，不执行进程、网络、文件准备或测试。

## 安全释放条件

- 释放/续租/隔离必须提供完整身份；行按 `project_id + id + 认领 + 代次 + owner +
  Host + revision` CAS，旧 owner/version 或伪造 id 不改写当前行；
- 续租不得缩短租约，且租约不得长于认领租约；到期续租返回 `quarantined`，
  调用方必须把非 `held` 视为不再授权（该转换随事务提交，不会因回滚丢失隔离事实）；
- 正常释放只对仍有效的 `held` 槽位开放；到期或已隔离一律拒绝。隔离的最终释放
  需要后续受信停止/副作用核对流程（F-006/F-007），本任务不提供无证据释放入口；
- 重复释放同一身份幂等返回原记录（不重复提升 revision）。

## 验证证据（本地定向）

完整 stdout/stderr 与真实退出码在 Feature workspace
`verifications/F-003/runtime-logs/`（`*.log` + `.log.exitcode`/`.log.json`）。

| 检查 | 文件 | 结果 |
| --- | --- | --- |
| Task 索引整套（3 文件 = 槽位原语 + 三组租约/项目工作区排他 + Git 短锁） | `test/index/phases/P04/features/P04-9/tasks/F-003.json` | exit 0，3 files / 30 passed（`test-h426cao2.log` 及 sidecar） |
| 槽位原语（跨连接容量竞争、跨进程竞争、幂等/身份围栏、到期隔离、容量拒绝、资源职责分离、事务纪律） | `test/modules/scheduling/p04-9-f003-execution-slot.test.ts` | exit 0，8 passed（`test-okjnbvaq.log`） |
| 三组租约、项目/Feature/Task 竞争、基线与工作区排他兼容 | `test/modules/scheduling/p03-4-work-resources.test.ts` | exit 0（与下一文件合计 22 passed，`test-iqu8ikpq.log`） |
| Git 公共元数据短锁、linked worktree、跨进程竞争兼容 | `test/modules/workspace/p03-5-git-operation-lock.test.ts` | exit 0（同上） |
| TypeScript | `npm run typecheck`（`tsc -p tsconfig.json`） | exit 0 |
| 依赖边界 | `npm run check:boundaries` | exit 0，335 个生产文件 0 diagnostics |

仓库索引：`test/index/phases/P04/features/P04-9/tasks/F-003.json`（schema_version 2，
3 个文件 `all: true`）。Harness 交接 `verifications/F-003/test-selection.json`
只引用该索引。

### 既有失败（与本任务无关，未纳入本任务范围）

本地定向时发现 `test/modules/scheduling/p03-4-task-dag.test.ts` 与
`test/modules/scheduling/p03-4-task-claim.test.ts` 各 1 项失败：硬编码的
`migrateSqliteStorage(...).appliedVersions` 仍停在 v30/v31，而 F-001/F-002 已把
迁移推进到 v34。该失败在 F-003 开工基线（`852d715`）即存在，与本任务的槽位原语
无关；两个文件未被 P04-9 索引引用（只出现在 P04-4 F-005 索引），故未纳入本任务
选择，也未被改写。建议由引入 v33/v34 的 Task 或 P04-4 维护该版本断言。

本任务不声称 Feature/Phase 通过：更广回归、独立验证与人工阶段放行由 Nezha/负责人执行。
