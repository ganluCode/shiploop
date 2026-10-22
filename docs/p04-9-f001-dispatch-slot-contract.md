# P04-9 F-001 Run 级持久派发与单执行槽位契约

日期：2026-10-22。范围：迁移 v33、`packages/core/src/ports/execution-dispatch.ts`
契约与测试索引。本任务只交付契约、持久结构与旧库升级；入队/补扫事务（F-002）、
槽位竞争原语（F-003）、与 Task 原子认领和 Runtime 启动衔接（F-004）仍按后续 Task 实现。

## 复用了什么，以及为什么不能只复用旧结构

| 事实 | 来源 | 本任务处理 |
| --- | --- | --- |
| Run 生命周期（queued/running/pausing/paused/cancelling/cancelled/succeeded/failed/interrupted） | `runs.status`（P03-3 v9） | 直接复用；新增结构不保存第二套 Run 状态，也不按 Task 数量复制行 |
| 授权输入、预算上限、dispatchOrdinal、workKey | `runs.input_snapshot/config_snapshot/max_attempts_per_run/run_time_limit_ms/scope_digest` | 直接复用；v33 不修改 `runs` 的任何列，迁移前后逐行一致 |
| 命令幂等 | `command_receipts` 的 commandId/requestDigest（P02-2） | 不动；派发没有新回执表 |
| Task/Attempt 认领与 fencing | `attempts.execution_version` + `workspace_leases`（P03-4） | 不动；Run 认领代次与 Attempt 版本是不同计数器 |
| 工作区/项目/全局占用与 Git 短锁 | `workspace_leases`、`git_operations`、Git 公共元数据锁 | 不动；v33 不释放、隔离或改写既有租约 |

必须新增结构（不能塞进既有表）的具体原因：

1. `runs` 行是 Run 的业务身份，没有“同一 Run 的第 N 代消费者”概念。把 owner/
   host/认领版本写进 `runs` 会覆盖历史代次，无法表达“旧 owner 迟到结果不能释放新
   owner”与 resume 血缘，且会让 Run 更新与 Attempt fencing 混成一套计数器。
2. 同一 Run 内的多次 resume 需要不可变、可审计的代次链（谁在何时以哪一代认领），
   这是 `runs.revision`（CAS 计数）无法表达的事实。
3. 槽位归属必须绑定项目/Run/owner/host/认领版本，并在租约到期后保留
   `quarantined` 供核对；`workspace_leases` 的 `owner_kind` 恒为 attempt（DDL CHECK），
   按 Attempt 分配且语义是资源排他，直接复用会把“并行额度”冒充成“工作区/项目资源
   锁”，违反 PRD §3.2 的职责区分。
4. `work_key` 是跨重试的逻辑工作身份，不是队列唯一键；因此 v33 不引入 `work_key`
   列，队列身份由 `(project_id, run_id)` 表达，显式重试的新 Run 天然有独立身份。

## 身份、代次与合法转换

- 派发身份：`DispatchWorkIdentity = { projectId, featureId, runId }`，即“同项目、
  同 Feature 的已授权 Run”。重复入队复用该 Run；`deriveDispatchWorkIdentity` 显式
  拒绝 `workKey` 等额外字段。
- `run_dispatch_claims.claim_version`：Run 级认领代次，从 1 起。首代必须是
  `origin='dispatch'` 且无血缘；后续代必须是 `origin='resume'`、version=上一代+1，
  并引用上一代 `(id, version)`（CHECK + lineage trigger）。
- resume 只能接在**已释放**（停止已核对）的上一代之后；`held`/`quarantined` 仍占用
  活动身份，不能用新一代绕过核对。resume 只追加认领代次，不重开终态 Attempt、
  不改写旧认领行、不清理预算或证据。
- `execution_slot_claims` 绑定 `(project, run, claim_id, claim_version, owner, host)`；
  `slot_index` 与 Run 各有一个“活动唯一”部分唯一索引：一槽一持有者、一 Run 一活动
  槽位（不按 Task 数量重复分配）。槽位租约不得超过认领租约。
- 合法状态转换（trigger 强制）：`held→held/released/quarantined`、
  `quarantined→quarantined/released`，`released` 为终态；隔离不能直接回到 `held`。
  身份列（project/feature/run/claim_version/origin/血缘/owner/host/acquired_at/
  slot_index）UPDATE 一律拒绝；活动认领存在未释放槽位时不得把认领标成 `released`。
- 终态 Run（succeeded/failed/cancelled）不得插入新认领；`pausing/cancelling` 也不
  产生新代次；既有活动认领/槽位不会因为 Run 进入终态被自动释放。
- 展示状态不是持久字段：`deriveRunDispatchDisplay` 从 Run 状态 + 认领 + 槽位 + 活动
  Attempt 派生 `queued / waiting_slot / claimed / running / blocked / pausing /
  paused / cancelling / interrupted / succeeded / failed / cancelled`，并给出有界
  阻塞原因（`execution_slot_unavailable`、`claim_quarantined`、
  `claim_lease_expired_unverified`、`slot_ownership_missing`、`slot_identity_mismatch`、
  `claim_attempt_identity_mismatch`、`run_paused` 等）。租约到期只呈现为待核对，
  从不自动转成“已停止”。

## 与 Task/Attempt 的关联

`assertDispatchClaimOwnsAttempt` 只校验：同一项目/Feature/Run、同 owner/host、
Attempt 在该代认领取得之后创建、Attempt `execution_version ≥ 1`。它**不**比较
`executionVersion` 与 `claimVersion`：前者按 Task 递增、后者按 Run 消费者递增，
两者既不相等也不同步。旧代次的迟到 Attempt 因 owner/host/时间不匹配被拒绝。

## 迁移 v33 与兼容

- 迁移只新增 `run_dispatch_claims`、`execution_slot_claims` 两张表、索引、约束与
  trigger；v1–v32 的 SQL 与 checksum 不变（测试内冻结 32 个历史 checksum 的摘要）。
- 单槽容量在契约中固定为 1：`validateExecutionSlotCapacity` 缺省 1，大于 1、
  0、负数、非整数全部 fail-closed（`capacity_unsupported`），不表面接受后暗中串行。
- 旧库升级：既有 Run/Attempt/预算预占/批次预算修订/审批/命令回执/Git operation/
  工作区租约/state_events 逐表逐行保持身份与内容；旧 `queued` Run 仍是 `queued`，
  且没有迁移生成的认领行，可由后续有界补扫发现；既有 `held`/`quarantined` 租约
  原样保留，不被当作已停止、清空或自动恢复。
- 迁移失败整组回滚（DDL 与迁移记录都不半提交），高版本库拒绝写入且不做任何变更。

## 验证证据（本地定向）

完整 stdout/stderr 与真实退出码保存在 Feature workspace 的
`verifications/F-001/runtime-logs/`（`*.log` + `.log.exitcode` / `.log.json`）。

| 检查 | 文件 | 结果 |
| --- | --- | --- |
| 新契约（身份/代次/转换/展示/容量） | `test/modules/scheduling/p04-9-dispatch-slot-contract.test.ts` | exit 0，8 passed（`test-6_cdqr90.log`） |
| 真实 SQLite 约束、升级、回滚、高版本 | `test/modules/storage/sqlite/p04-9-dispatch-slot-schema.test.ts` | exit 0，6 passed（同上） |
| Drizzle 与迁移逐列/索引/CHECK/FK 对齐 + 全表约束矩阵 | `test/modules/storage/sqlite/sqlite-schema-migrations.test.ts` | exit 0，65 passed |
| 迁移执行器（空库/升级/备份/回滚/高版本） | `test/modules/storage/sqlite/sqlite-migration-runner.test.ts` | exit 0，32 passed |
| P03-4 Attempt/Workspace schema 与升级链 | `test/modules/scheduling/p03-4-attempt-schema.test.ts` | exit 0，33 passed（含受影响断言更新） |
| 版本钉住断言维护 | `test/modules/runtime/p03-6-work-session.test.ts`、`test/modules/storage/sqlite/p04-5-work-recording.test.ts` | exit 0，32 passed |
| 索引整套（7 文件，Task-local 最终证据） | `test/index/phases/P04/features/P04-9/tasks/F-001.json` | exit 0，7 files / 144 passed（`test-7gmlkeqd.log` 及 sidecar） |
| TypeScript | `npm run typecheck` | exit 0 |
| 依赖边界 | `npm run check:boundaries` | exit 0，332 个生产文件 0 diagnostics |

本轮为让“当前最新版本”断言跟随新迁移做了必要维护：p03-6/p04-5 的 32→最新版本、
p03-4 的迁移序列改为按清单长度派生、migration-runner 的空库表清单补齐 v32/v33
新表。历史 checksum、v1–v32 SQL 与既有失败断言（见
`docs/testing/known-full-regressions.md`）未被改写。

## 测试索引与确定性预检

仓库内索引：`test/index/phases/P04/features/P04-9/tasks/F-001.json`
（schema_version 2，`task_id=F-001`，`all: true` 显式文件，无 cases 选择）。
Harness 交接：`verifications/F-001/test-selection.json` 只引用该索引。

预检（不跑测试，仅结构与路径）结果：

- JSON 可解析；`schema_version=2`、`task_id=F-001`、`projects[0].id=shiploop`；
- 7 个 `tests[].file` 全部存在且匹配 `test/modules/**/*.test.ts`，均为仓库相对路径；
- 每项只有 `all: true`（无 `cases`，符合 `Boolean(all) !== Boolean(cases.length)`）；
- 索引内文件全部在本地定向执行通过；未执行全量、阶段验收或 live。

本任务不声称 Feature/Phase 通过：更广回归、独立验证与人工阶段放行由 Nezha/负责人执行。
