# P08 DAG F-012：Phase 叶子集成汇总

日期：2026-11-10。分支 `fix/dag-integration-lifecycle`。来源 PRD FR-07。

## 交付内容

- `packages/core/src/application/phase-delivery-approval.ts`：新增冻结 `PhaseDeliveryScopeSnapshot`
  （Phase revision/status、`dagDigest`、featureIds/dependencies、获准 Batch 引用、Phase 级 approvedInputs、
  targetBaseline、strategySummary、每叶子当前交付证据）。Phase 最终交付入口按 Phase DAG 枚举全部
  获准叶子（`enumeratePhaseDeliveryLeaves`），要求候选叶子集合与 Phase 叶子集合完全一致，并逐叶子核对：
  - 所在 Batch 必须 approved + succeeded（`phase_leaf_outside_approved_batch`）；
  - 交付证据必须 completed/succeeded、commit 存在、证据新鲜、分支无漂移、无未解决冲突
    （`phase_leaf_not_delivered`）；
  - 候选冻结的 commit/evidence/repoIdentity 必须与当前证据一致（漂移拒绝）；
  - Phase 级 approvedInputs 必须被候选叶子完整覆盖且摘要一致（`phase_input_coverage_incomplete`）；
  - targetBaseline 漂移（`target_baseline_drift`）与策略漂移（`policy_drift`）拒绝；
  - `expectedPhaseRevision`/`expectedDagDigest` 可选 CAS（`phase_revision_stale`/`dag_revision_stale`）；
    快照缺失或内部损坏拒绝（`phase_scope_missing`/`phase_scope_invalid`）；archived Phase 拒绝。
  - summaryDigest 绑定全部 phaseScope 冻结事实，漂移后的重批准走既有 invalidate 路径。
- `packages/core/src/adapters/sqlite/phase-delivery-approval-store.ts` + 迁移 v71
  （`phase_delivery_approvals.phase_revision`/`dag_digest`，历史行 NULL）：命令通道（commandContext）写入时
  在同一事务内复核 Phase revision 与重算的 DAG 摘要，快照读取与落盘之间 Phase/DAG 被改写即拒绝。
- 请求/记录新增字段保持可选（`phaseRevision`/`dagDigest` 历史行为 null）；wire payload 的
  `expectedPhaseRevision`/`expectedDagDigest` 接线属 F-013。

## 复用与人工边界

- Phase 集成不新建 Git 实现：Phase 交付入口只消费 `BatchFinalizationCandidate`
  （deterministic integration / 受监督 GitAgent 修复管线的同一候选结构），共用其
  operation、worktree、锁、证据与恢复机制。
- Feature 验收完成、候选 ready_for_phase_approval、Batch 收尾都不自动批准 Phase，也不自动合并 main：
  `phases.delivery_status='approved'` 仅由显式人工批准（commandId/actorId + 批准记录 CAS）翻转；
  实战父分支与失败事实保持独立。

## 验证

- 单元：`test/modules/delivery/p08-dag-f012-phase-leaf-aggregation.test.ts` 12 项
  （叶子枚举/摘要、缺叶/外叶/未交付/未获准 Batch/输入缺口/baseline/策略漂移/冻结 CAS/漂移失效/人工 gate）；
  更新后的 `p05-9-f004-phase-delivery-approval.test.ts` 4 项。日志见
  `verifications/F-012/runtime-logs/`。
- 集成（本地已跑，另交 Nezha）：`p05-9-f004-phase-delivery-approval-sqlite.test.ts` 2 项
  （含命令通道 Phase revision/DAG 漂移拒绝与精确批准）、`p05-9-f006-batch-delivery-host.test.ts` 12 项、
  `p05-9-f008-batch-delivery-vertical.test.ts` 4 项。
- `npm run typecheck`、`npm run check:boundaries`（599 文件 0 诊断）通过。
- 真实并行叶子 Git 祖先、Host/进程与产品装配证据由 Phase 集成验收采集，本 Task 未执行全量或阶段验收。
