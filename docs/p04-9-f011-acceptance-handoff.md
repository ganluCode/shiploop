# P04-9 F-011：验收工具补充与单并发实施交接

日期：2026-10-22。范围：把 P04-9 持久派发补充项纳入既有 P04 验收清单、阶段入口与
报告映射；并交接已落地的单并发实现事实。本文是**工具与实施交接**，不是阶段验收通过、
不是 live 证据，也不解除负责人确认。

提交引用：`3bf8c228a30e811b8a3fe1ec50bbaec720ed61bb`（`F-011: 将 P04-9 纳入 P04 验收清单与入口报告映射`）。
本文件随后的小幅补记只追加此引用，不改代码；日志/退出码/耗时见 Harness
`verifications/F-011/runtime-logs/`。

## 1. 验收工具扩展

| 文件 | 变化 | 原有契约 |
| --- | --- | --- |
| `acceptance/p04.checklist.json` | 追加 P04-9 六项补充检查（`group=supplement`，`P04-P9-AC1`～`AC6`），位于 P04-VERT-MANUAL-BLOCK 之后、deferred 之前 | 原有十六项必需检查、断言、FR/T 映射、层次、执行类别与顺序逐字保留；deferred 仍为 2 项 |
| `scripts/acceptance/p04-config.ts` | 冻结 `SUPPLEMENT_ITEMS` 与 `P04_SUPPLEMENT_CHECK_IDS`；`P04ItemGroup` 增加 `supplement`；验收编号模式接受 `T\d{2}` 或 `P04-9-AC[1-6]` | 删除/改写原项、断言、重排、把 deferred 计入通过仍 `invalid_config` |
| `acceptance/p04.config.json` | `requiredChecks` 追加六项（冻结顺序）；`plan.scope/version` 更新为覆盖补充项 | 工具版本、Fake 身份、临时资源、预算与报告范围冻结不变 |
| `acceptance/p04.entry.json` | `schemaVersion=2`；新增 `requiredFeatures`（P04-1～P04-9）与 `supplement`（补充检查 → Task 索引映射） | 步骤顺序、工程门禁 argv、集成 runner、测试索引根不变；旧 `schemaVersion=1` 声明被拒绝 |
| `scripts/acceptance/p04-accept.ts` | 新增 `collectP04TrustedTests`：Feature 集合必须等于冻结声明，校验 v2 索引/路径/文件存在性，P04-9 必须有 `feature.json` 且 Task 列表与磁盘一致，测试文件按路径去重，补充检查映射必须指向已登记 Task；补充检查只写 Task 索引导航证据 | 索引损坏、空索引、越界路径、缺 runner、工作树脏/commit 漂移、目录复用、观察哈希不符仍 fail-closed |
| `test/index/phases/P04/features/P04-9/` | 新增 `feature.json`（F-001～F-011）与 `tasks/F-011.json` | 既有 F-001～F-010 索引不改；P04-9 合集只做去重范围声明 |
| `docs/p04-acceptance.md` | 新增配置声明的验收契约正文 | 不改 P04-8 历史报告与人工清单结论 |

### 报告语义（P04-9 六项）

- 报告必须逐项包含六个补充检查（`requiredChecks` 与清单摘要绑定）；缺项、失败、
  未执行、证据类别未覆盖或证据身份不匹配都只会得到 `not_run`/`fail`，阶段结论继续
  非零。旧清单 16 项报告因检查数量、顺序与清单摘要不匹配被拒绝重验。
- 离线入口只为补充检查落盘 `evidence/checks/<id>/extra/test-index-mapping.json`
  （artifact：checkId、验收编号、断言、Task ID/索引/文件），**不绑定命令退出为通过依据**。
  六项检查要求 `sqlite`（AC2/AC3/AC4 还含 `process`）等真实证据；本次入口没有 SQLite
  快照、竞争或恢复记录来源，因此保持 `not_run`，已有八项成功不能声称完整覆盖。
- 真正放行仍需人工发起 Phase 完整工程/集成、获准 live、负责人确认；本工具只保证
  缺证据时不会误报通过。

## 2. P04-9 六项验收的证据导航

| 检查 | 验收 | 主要 Task 索引 |
| --- | --- | --- |
| P04-P9-AC1-SINGLE-DISPATCH | 重复入队/唤醒只产生一个有效 Attempt | F-001, F-002, F-004 |
| P04-P9-AC2-SLOT-RACE | 两个消费者竞争额度 1 恰好一个有效槽位 | F-003, F-004 |
| P04-P9-AC3-RESTART-RESCAN | 丢失唤醒/重启/认领后崩溃可补扫，旧进程未确认停止不重跑 | F-005, F-007 |
| P04-P9-AC4-LATE-RESULT-CONTROL | 迟到结果不能覆盖/释放新 owner；暂停/取消不被补扫复活 | F-006, F-007 |
| P04-P9-AC5-QUOTA-REGRESSION | 额度 >1 拒绝；单 Feature 正常/返工/失败保留/resume/预算回归 | F-004, F-007, F-010 |
| P04-P9-AC6-QUERY-MIGRATION | 查询解释等待原因；迁移保留 Run/Attempt/Git 与通过证据 | F-008, F-009, F-010 |

映射是范围声明，不是通过证明。各 Task 的实际日志、退出码与未运行边界见对应交接
文档（`docs/p04-9-f00*.md`）和 Harness `verifications/<task>/`。

## 3. 实际持久结构（迁移 v33/v34）

沿用 `runs` 的 queued/控制/终态与不可变授权快照作为唯一业务状态，不新建第二套
Run/Task/预算状态机，也不按 Task 数量复制队列行。

| 表（迁移） | 关键字段与约束 | 职责 |
| --- | --- | --- |
| `run_dispatch_claims`（v33） | `project_id + feature_id + run_id + claim_version`，`origin ∈ {dispatch,resume}`，`resumed_from_claim_id/version`，`owner_id`、`host_instance_id`、`acquired_at/lease_until`、`state ∈ {held,released,quarantined}`、`reason`、`settled_at`；`UNIQUE(project,run,claim_version)`、活动认领 `UNIQUE(project,run) WHERE state IN ('held','quarantined')` | Run 级消费身份与代次；首代必须 `dispatch/v1`，resume 必须引用上一代已 `released` 的 `claim_version-1`；身份列与状态转换由 trigger 冻结 |
| `execution_slot_claims`（v33） | `slot_index`、`claim_id/claim_version`、`owner_id/host_instance_id`、租约、`state ∈ {held,quarantined,released}`；活动槽 `UNIQUE(slot_index)`、活动 `UNIQUE(project,run)` | 同时执行数量准入；insert trigger 重核认领身份/租约，`claim` 释放要求槽位先释放 |
| `run_dispatch_intents`（v34） | `UNIQUE(project,run)`；`source ∈ {start,retry,resume,finalization_retry}`、`authorization_digest`（64 位小写 hex）、`enqueued_at`、`reason` | 持久派发意图与有界补扫顺序；insert trigger 重核项目 active、Run queued、Batch 未终态与归属，身份列仅插入 |

身份与转换：

- Run 级 `claimVersion` 与 Task/Attempt 的 `executionVersion` 是两个独立计数器；
  `work_key` 仍只是逻辑工作去重键，不是队列唯一键。新 Run 天然有独立派发身份。
- 重复入队/重复唤醒复用同一 `run_dispatch_intents` 行与同一活动认领；重复 Task
  使用同一 owner/Host 复用认领与槽位，新 Attempt 独立累计既有计数。
- 租约到期只允许 `held → quarantined`（`lease_expired_unverified`）并继续占用；
  不自动回收、不缩短租约、不重新分配写入者。
- 显式 resume 只在旧认领已 `released`（停止已核对）后追加下一代；迟到 owner/
  version 不能续租、释放新持有者或唤醒错误后继。

## 4. 四类资源职责与固定准入顺序

| 资源 | 职责 | 不能替代 |
| --- | --- | --- |
| 执行槽位（`execution_slot_claims`） | 同时运行的 Run 消费者数量（生产额度 1） | 授权、Task 依赖、预算、工作区排他、Git 短锁 |
| `global:execution` + 项目 Work 门控 | 项目内规划/编码互斥与 Work 独占 | Feature 级并发（P05 才开放） |
| 工作区租约（workspace/baseline 三组租约） | 同一工作区唯一写入者 | 槽位额度、验收通过判定 |
| Git 公共元数据短锁 | 分支/引用等公共元数据串行 | 长事务、模型或测试等待 |

固定顺序（不变）：Task 版本 CAS → Attempt → 预算预占 → `global:execution` →
项目 Work → workspace → 事件/回执；Run 认领、槽位、Task 围栏、Attempt、预算预占、
三组租约、事件与回执在同一事务内提交或整组回滚。槽位原语只在短写事务内做同步
SQL，不执行进程/网络/文件准备/长测试；Git 短锁内不等待模型。

容量：`validateExecutionSlotCapacity` 缺省 1，>1 返回 `capacity_unsupported`，0/
负数/非整数/非数字校验失败；生产策略 `assertSingleWorkConcurrencyAuthorization`
对 >1 显式拒绝（`concurrency_not_supported`），不表面接受后暗中串行。

## 5. 迁移、恢复限制与回执兼容

- v33/v34 只新增上述三表、索引与 trigger；不改 v1–v32 任何 SQL/checksum，不自动
  入队、认领、唤醒、启动 Runner，也不释放或隔离既有 `workspace_leases`。
- 旧 queued Run 仍按 `runs.status` 可被后续补扫；P04-8（v32）数据升级后 Run/
  Attempt/Git 记录与通过证据经生产查询端口保持可读（索引 F-010 的
  `upgrade-preserves-p04-8-data`/`upgrade-query` 用例覆盖）。
- 回执：`TaskClaimReceipt.dispatch = {claimId, claimVersion, slotId}` 存在既有不可变
  回执中，与 Attempt ID/executionVersion 关联；历史无 `dispatch` 的回执仍可读取，
  但**不能授权新的 Runtime 启动**。启动入口 `beginLaunchInTransaction` 在事务内重核
  Run/Batch 控制、授权意图摘要、DAG/审批、权限、持久回执与槽位。
- 恢复限制：租约到期或信号丢失都不证明旧执行已停止；未核对进程/副作用前保持
  `quarantined`/占用，不重复派发；恢复沿用父预算、绝对 deadline 与已完成证据；
  不承诺模型/工具副作用恰好一次。暂停阻止新认领，取消停止当前执行并保留现场，
  补扫不会复活暂停/取消/终态。

## 6. 本地位阶与未运行范围

- 本地实际运行（Harness `verifications/F-011/runtime-logs/`）：
  - RED：`test-ltkcq36v.log`，exit=1，576 ms；当时 4 个用例中 2 项失败（缺 P04-9 Feature 索引）。
  - 新测试 GREEN：`test-aozt_v9i.log`，exit=0，596 ms，`p04-9-acceptance-supplement.test.ts` 5/5。
  - 受影响回归首轮 2 失败：`test-kviuco0g.log`，exit=1，7784 ms，暴露补充绑定数量与入口夹具缺口；修正后最终合并运行 `test-sauycijp.log`，exit=0，7173 ms，5 文件 43 项通过
    （新验收工具测试 + `p04-8-checklist-report` / `p04-8-phase-entry` / `p04-8-integration-report` /
    `p04-8-delivery`）。
- 仅登记交 Nezha 独立验证：`test/index/phases/P04/features/P04-9/tasks/F-011.json`
  与 `P04-9/feature.json` 即上述范围；本 Task 不重复运行更大的 P04-9 业务合集。
- 未运行且不能声称：Phase 完整工程/集成（`accept:p04` 真实执行）、`npm run verify`、
  全仓测试、真实 live/模型、负责人确认。`accept:p04` 的离线两步与本工具的自测是
  不同层次；本工具自测不构成阶段验收证据。
- 已知基线缺口（此前任务记录，本次未复验、未清障）：Host `execution.stop.manual`
  命令能力未同步导致 `host-lifecycle-contract` 1 项失败；P04-8 交付报告记录的
  typecheck 基线错误。它们仍属 Phase 完整工程门禁的人工门槛。

## 7. 公共设计待同步位置（只读映射）

Harness `workspace/project/knowledge/architecture-redesign/` 是只读来源，本 Task 不越权
改写。按实际实现，以下位置仍待同步（不代表已验收能力）：

| 设计文档 | 待同步内容 |
| --- | --- |
| `core-design/04-scheduling-and-recovery.md` §1 调度输入与顺序、§3 认领与 fencing、§8 默认单并发 | Run 级认领代次、槽位与 `global:execution`/项目 Work/工作区/Git 短锁的四类职责与固定准入顺序；额度 1 的拒绝语义 |
| `core-design/11-database-model.md` §5 执行与资源 | `run_dispatch_intents`、`run_dispatch_claims`、`execution_slot_claims` 的字段、索引、trigger 与 v33/v34 关系 |
| `core-design/12-end-to-end-flows.md` §8.1 Batch/Run 派发、§9 单 Attempt 时序、§14 崩溃与恢复 | 入队意图 → 有界补扫 → 认领/槽位 → Task claim/Attempt 的时序；丢失唤醒、认领后崩溃、迟到结果分支 |
| `core-design/15-feature-concurrency-and-integration.md` §2/§3/§6 | 实现状态标注（P04-9 已落地但未阶段验收）、配额 1 与 P05 边界；不得把设计意图写成已通过 |

P05 才开放 Feature DAG 并发、受控集成、共享项目编码门禁与 GitAgent；本期生产额度
固定 1，Task 并发、任意分支自动合并、AI Review/PR 平台仍不在范围。

## 8. 剩余阻塞点

- P04 未放行：Phase 完整工程/集成、live、负责人确认三项 `not_run`/`pending`。
- P04-9 六项补充检查在报告中保持 `not_run`，需要独立核对的 SQLite/竞争/恢复证据。
- 上述基线缺口未在本 Task 修复，不能由工具局部通过清除。
