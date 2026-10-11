# P03-2 计划批准/拒绝决策契约（F-002）

- 文档状态：P03-2 / F-002 交付的决策用例契约（Core 层）；CLI 入口属 F-008。
  命令面经既有 `POST /v1/commands` 通用路由接线宣告
  （`packages/host/src/contract/lifecycle.ts` 的 `APPLICATION_COMMAND_CAPABILITIES`
  追加 `feature.plan.decide`，同 F-001 先例）。**F-007 接线定案（写回登记）**：
  线消息 `schemaVersion` 显式升 4 → 5（P02-2 能力集合变化升版纪律，同 P03-1 /
  F-009 先例；Host `CURRENT_SCHEMA_VERSION` 同步，旧 v4/v3/v2/v1 明确
  `unsupported_schema_version`）；决策查询（`features.approvals`）Host 路由定案为
  `GET /v1/features/:featureId/approvals`（Feature 唯一冻结子资源形态，其余嵌套
  多段形态 404）并同步握手查询能力清单；HostClient 公共方法 `decideFeaturePlan`
  （命令面，冻结信封/回执/有限重试）与 `getFeatureApprovals`（查询）接线，
  completed 回执内嵌结果与查询响应均有客户端线校验器
 （`validateFeaturePlanDecideResultWire`/`validateFeatureApprovalsResultWire`，复用
  公共协议校验与结构化错误）。
- 实现入口：`packages/core/src/application/feature-plan-decide.ts`（经 `shiploop-core`
  公共入口导出：`submitFeaturePlanDecide`、`PLAN_DECIDE_IMPACT`、
  `decideFeaturePlanOutcome` 与全部常量/类型；结构化错误 operation 固定为
  `feature.plan.decide`）。
- 上游契约：`docs/p03-1-plan-import-contract.md`（planDigest 语义——审批绑定摘要、
  不是 CAS 依据；§6.8 实质修订使旧摘要批准失效的 `decidePlanApprovalValidity`
  纯规则）、`docs/p03-2-task-strategy-edit-contract.md`（批准前 Task 策略副本
  CAS 编辑——批准不重读/不覆盖副本的先决契约）。
- 本文不是阶段验收报告；有效批准核验服务（供 P03-3/4 创建 Run/Attempt 复用的
  fail-closed 审批依据）属 F-003，startRun/执行授权属后续阶段。

## 1. 职责与命令面

对 P03-1 导入的 Feature 当前计划，可信主体经既有命令信封提交**绑定当前
planDigest 的批准或拒绝决策**（`feature.plan.decide`，能力位
`feature.plan.decide`，project scope，mutation=update）：

- 信封 `expectedRevision` 唯一权威来源是信封顶层，指向目标 Feature 聚合 revision
  （与 `feature.plan.revise`/Feature 纯标签编辑共用同一聚合 CAS 空间；
  同 revision 竞争决策/编辑经单语句条件 UPDATE 裁决仅一个生效）；
- payload 只含 `featureId`（目标 Feature 稳定 ID）、`planDigest`（提交时绑定的
  当前计划摘要，64 位小写 hex）、`decision`（`approve`/`reject`）与可选
  `reason`（适用原因，≤2000 Unicode 码点，全空白归一 null）；严格未知键拒绝
  ——`decisionActor`/`actorId`/`principalId`/`approval`/`status`/`planStatus`/
  `revision` 等服务端决定字段（含身份）不能经请求输入（payload 内出现即未知键，
  定位 `payload.<key>`）；
- **actor 唯一权威来源是可信主体装配**：记录的 `decision_actor` 恒为提交主体
  `TrustedPrincipal.principalId`，由命令用例定值；请求不能伪造身份（信封校验层
  即拒绝身份字段）。

## 2. 决策记录与存储（迁移 v7，版本接续 P03-1 v6）

- 迁移 v7 新增 `approvals` 表（core-design/11 §7 approvals 落定；v6 冻结时登记的
  张力关闭）：`subject_type`（先冻结仅 `feature_plan`，`subject_id` 即 Feature
  稳定 ID）、`subject_digest`（绑定提交时当前 planDigest，64 位小写 hex CHECK）、
  `status`（`pending`/`approved`/`rejected`/`superseded` 完整枚举先冻结，P03-2
  只写 approved/rejected）、`decision_actor`、`reason`、`decided_at`（UTC 毫秒）；
- **不创建计划或配置历史版本表**（`plan_revisions`/`configuration_revisions`/
  `feature_revisions` 属 PRD §5 明确不建设范围）：历史由决策记录行承载——同一
  Feature 的多条决策按 `subject_digest` 区分**当前决定与历史决定**（实质修订改变
  摘要后旧决策自然成为历史，不改写旧行）；
- 约束（DDL 兑现 + 存储原语先行核验的双层纪律）：
  - 项目归属：`project_id → projects` 外键 + `(project_id, subject_id) →
    features(project_id, id)` 同项目复合外键（跨项目审批主体 DDL 级拒绝）；
  - 已决定形态：`approved`/`rejected` 必须携带 `decision_actor` 与 `decided_at`
    （`pending` 不得携带）——「不把拒绝显示为已批准」在行级即有形态约束；
  - **重复竞争决策**：`UNIQUE(project_id, subject_type, subject_id, subject_digest)`
    ——同一主体同一摘要至多一条决策（两个竞争决定最多一个生效
    的 DDL 兜底；命令层以 Feature 聚合 CAS 先行裁决）；
  - CAS 纪律：`revision ≥ 1`（决策插入恒为 1；pending→decided/superseded 更新
    原语随后续功能扩展）；
- 存储原语（`ports/plan-store.ts` 契约 + SQLite 适配器，同一写事务内原子生效）：
  `findPlanApproval`（同主体同摘要既有决策重核）、`insertPlanApproval`
  （insert-only；缺失 not_found、跨项目 ownership、同主体同摘要已有决策
  conflict）、`updateFeaturePlanStatus`（Feature `plan_status`/`revision`/
  `updated_at` 单语句条件 UPDATE CAS；缺失 not_found、跨项目 ownership、旧
  revision conflict）。

## 3. 决策语义（批准只确认现有计划，不启动执行）

- **决策绑定提交时当前 planDigest**：请求摘要与库内当前摘要不一致（含库内摘要
  为空）即固化 rejected（`plan_digest_mismatch`）——失效摘要 fail-closed；
- **重复竞争决策 fail-closed**：同主体同摘要已有决策（事务内重核 + DDL 唯一
  索引兜底）即固化 rejected（`approval_already_decided`）；翻转任何既有决策都
  必须先实质修订（新摘要新决策），两个竞争决定最多一个生效；
- **空任务不可执行计划**（零 Task 草稿）不可被批准或拒绝（`no_tasks`，与
  `FEATURE_NOT_EXECUTABLE_REASONS` 同一词汇）；
- approve → 决策记录 `approved`、Feature `plan_status='approved'`（当前计划可
  作为**后续显式执行授权**的依据；批准本身不是启动授权，不创建 Batch/Run/
  Attempt、不调用 Runtime、不启动 Git 或检查进程）；reject → 决策记录
  `rejected`、`plan_status` 落 `draft`（`FEATURE_PLAN_STATUSES` 无 rejected 值；
  拒绝不提供该依据——拒绝事实由决策记录承载，**不把拒绝显示为已批准**）；
- **批准保留所有既有 Task ID、依赖边、完整策略副本与来源**：写入面只有决策
  记录插入与 Feature `plan_status`/`revision` 更新，绝不重建 Task、不按当前默认
  配置覆盖副本（批准前经 `task.strategy.update` 的编辑原样保留；
  planDigest/Task 行/依赖边逐字段不变）；
- `PLAN_DECIDE_IMPACT` 纯规则冻结影响面（与 `PLAN_REVISE_IMPACT`/
  `TASK_STRATEGY_EDIT_IMPACT` 可区分）；`decideFeaturePlanOutcome` 纯映射
  approve/reject → 记录状态与 plan_status。

## 4. 事务、事件与回执（同一短写事务）

- 全部重核与写入在**同一 BEGIN IMMEDIATE 短写事务**内：项目把关（缺失/不可见
  统一 forbidden，不泄漏存在性）→ 计划快照（缺失 not_found、跨项目 ownership →
  forbidden）→ 摘要绑定/空任务/重复决策/聚合 CAS 顺序重核（任何业务写入之前
  固化 rejected）→ Feature 条件 UPDATE（CAS 裁决竞争窗口）→ 决策记录插入 →
  事件 → 回执；
- 事件：`feature.plan.approved`（payload 恒 `{approved:true}`）与
  `feature.plan.rejected`（payload 恒 `{rejected:true}`）两类可区分（聚合为
  目标 Feature 自身，aggregateRevision=决策后聚合 revision）；不携带计划正文/
  决策人身份/原因/执行语义；进入计划域事件白名单与公开事件白名单；
- 回执：completed 结果有界（Feature 公共记录 + `decision` + 决策记录公共形状
  含 `current:true`），不携带策略副本正文、不声称已启动执行；持久化故障
  （Feature 更新/决策记录插入/事件/回执注入点）**整组回滚**，不留下半条有效
  批准（批准状态/事件/成功回执同时不存在）；
- 幂等沿用 P02 §5.5：同 principal + commandId + 同摘要 → 原回执
  （`replayed:true`，零新增写入）；异参复用 → conflict
  （`idempotency_key_reuse`）；**重放重核当前权限**（能力被撤销的同主体重放被
  forbidden 拒绝，不返回原回执）。

## 5. 决策查询（`features.approvals`，Core 查询面）

- QueryService 新增 `getFeatureApprovals(principal, featureId)`（操作身份
  `features.approvals`，能力位复用 `project.read`，与计划域六查询同一纪律）：
  返回 `{feature, currentDecision, decisions}`——Feature 与全部决策记录来自
  同一 DEFERRED 一致读视图；`decisions[].current` 标记是否绑定当前 planDigest
  （当前决定 vs 历史决定；同摘要至多一条），`feature.planStatus` 是权威审批
  状态（拒绝后绝非 `approved`）；不可见/不存在统一 not_found（不区分存在性）；
- Host 传输路由/线协议/HostClient 接线与握手查询清单同步**已由 F-007 交付**
 （路由/升版/线校验器见上文写回登记）；CLI 入口属 F-008。

## 6. 迁移接续与版本兼容（沿用既有纪律）

- 迁移版本接续 P03-1 实际最新迁移（v6）+1 = **v7**；不改历史 checksum；空库、
  P02 v5 库与前序库升级均保留既有数据、事件水位（MAX(state_events.sequence)）
  与历史 checksum（F-005 执行器既有核验，见 `test/sqlite-migration-runner.test.ts`）；
- 公共命令白名单变化：`APP_CAPABILITIES`/`COMMAND_OPERATIONS`/
  `COMMAND_OPERATION_SPECS` 追加 `feature.plan.decide`（能力位与操作同名）；
  事件白名单追加 `feature.plan.approved`/`feature.plan.rejected`；Host
  `APPLICATION_COMMAND_CAPABILITIES` 接线宣告同步（v4 内增量，同 F-001 先例）；
  local-owner 持全部冻结能力（17 项）；
- 能力边界宣告：P03-2 存储无 Batch/Run/Attempt 表（迁移 v6/v7 均未建执行域表）；
  真实活动 Run 与决策的竞争 not_run（无执行实体表，不创建调度器模拟后序能力），
  start/claim 引入后必须遵守同一写事务与聚合 CAS 契约重核。

## 7. 与既有契约的差异记录

- `decidePlanApprovalValidity`（P03-1 / F-008 纯规则）语义不变：实质修订使旧
  摘要批准不可继续生效（planStatus 回 draft）；本任务不改该规则，批准只能经
  `feature.plan.decide` 对**当前摘要**重新决策达成；
- `features.plan_status='pending_approval'` 仍是冻结枚举值，P03-2 不写入该值
  （无「提交审批」两段流；决策命令从 draft/approved 直达 approved/draft）；
- F-003（有效批准核验与失效处理）将扩展摘要覆盖面（要求/验收/依赖/检查政策）
  与核验服务；本任务的决策记录与查询是其输入面，不提前实现核验。
- F-003 已交付（写回登记）：决策身份自迁移 v8 起精确化为复合身份
  `（subject_digest, check_policy_digest）`——§2 的「同一主体同一摘要至多一条
  决策」在五列唯一索引下指同一主体同一**身份**至多一条；适用检查政策以显式
  绑定核验值（`approvals.check_policy_digest`）覆盖，planDigest 计算不变（与
  P03-1 摘要契约兼容）；`features.approvals` 新增 `validity` 块（fail-closed
  有效批准评估与明确过期原因）。详见
  `docs/p03-2-plan-approval-verification-contract.md`。
