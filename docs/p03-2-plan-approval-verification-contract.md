# P03-2 有效批准核验与失效处理契约（F-003）

- 文档状态：P03-2 / F-003 交付的有效批准核验契约（Core 层）。上游：
  `docs/p03-2-plan-approval-contract.md`（F-002 决策命令与 approvals 表）、
  `docs/p03-1-plan-import-contract.md`（planDigest 语义）。Host/CLI 接线属
  F-007/F-008；startRun/执行授权属后续阶段（本项不实现 startRun）。
- 实现入口：`packages/core/src/ports/plan-approval-verification.ts`（检查政策
  身份摘要 `computeFeatureCheckPolicyDigest` + 有效批准评估纯规则
  `evaluatePlanApprovalValidity` 与原因词汇 `PLAN_APPROVAL_VERIFICATION_REASONS`）、
  `packages/core/src/application/plan-approval-verification.ts`
  （`resolveCurrentCheckPolicyDigest` + `verifyFeaturePlanApprovalInTransaction`）。
  均经 `shiploop-core` 公共入口导出。

## 1. 审批覆盖的实质输入身份（与前序契约的兼容方式）

批准固定以下实质输入身份，任一变化令旧批准失去执行效力：

| 身份成分 | 载体 | 兼容方式 |
|---|---|---|
| 要求（标题/业务描述/requirementsRefs）、完整 acceptance、依赖边、complexity | `planDigest`（P03-1 冻结的确定性业务摘要） | **计算不变**：F-003 不改变 planDigest 的输入与算法，前序摘要与绑定关系保持有效 |
| 适用检查政策 | `approvals.check_policy_digest`（迁移 v8 显式绑定核验值） | 显式绑定而非纳入摘要：planDigest 不含配置内容，检查政策身份以**政策内容摘要**随决策记录持久化 |

检查政策身份的定案规则：

- 适用检查政策 = 当前有效 `policies.verification` 段（settings-schema v2；
  项目非空段整体覆盖全局段、空段继承全局的既有合并规则）；
- 摘要 = `computeFeatureCheckPolicyDigest`：SHA-256（领域前缀
  `shiploop:feature-plan-check-policy:v1` + 规范化 JSON，与 planDigest 同一
  稳定序列化规则 `stableStringify`）；双方均未配置 verification 段时锚定
  显式 null 形态（与任何实配政策可区分）；
- **不得仅依赖可变配置路径、通用配置 revision 或 labels 判定有效性**：
  摘要是政策内容的确定性函数——配置 revision 只作合并输入身份不进入摘要
  （同内容不同 revision 同摘要），labels 不在输入内（纯标签变化不失效），
  配置存储路径完全不参与；
- 策略段（defaultStrategy/modelMap/purposeStrategies/agentOverrides）不在
  检查政策身份内：项目默认 modelMap 变化不追溯 Task 策略（设计 02 §9），
  也不使批准失效；Task 实际策略修订（`task.strategy.update`，F-001）与需求/
  检查身份可区分——同样不使批准失效（策略副本按下一份执行输入的捕获规则
  处理，不借调整模型提升权限、重置预算或修改历史）。

## 2. 决策身份复合与迁移 v8

- 决策身份 = `(subject_digest（planDigest）, check_policy_digest)` 复合：
  同一主体同一身份至多一条决策（`approvals_subject_decision_unique` 重建为
  五列唯一索引）；检查政策变化后同一 planDigest 可**重新批准当前身份**
  （新行），旧行作为历史证据保留，永不改写；
- 迁移 v8：`ALTER TABLE approvals ADD COLUMN check_policy_digest`（可空，
  64 位小写 hex CHECK `approvals_check_policy_digest_sha256_check`）+
  唯一索引重建；不重建表、不改写既有行；v7 遗留行升级为 NULL——NULL 不
  等于任何当前身份（SQLite 唯一索引中 NULL 互不相等，不与新决策冲突），
  有效批准核验对 NULL 绑定 fail-closed（`check_policy_changed`，需重新批准）；
- `feature.plan.decide` 在同一写事务内从全局+项目当前配置合并计算当前
  检查政策摘要并随决策绑定（`PLAN_DECIDE_IMPACT.bindsCurrentCheckPolicyIdentity`）：
  政策变更与批准竞争时，决策绑定的是事务内当前身份——旧视图不得提交为当前有效依据；
  事务失败整组回滚（沿用 F-002 四注入点纪律），不出现
  计划已变但旧批准仍可执行的半成功；
- 决策 payload 不变（`checkPolicyDigest` 为服务端定值，不经请求输入；
  幂等/重放语义不变）。

## 3. 有效批准核验（fail-closed）

核验服务从**同一权威状态视图**校验项目归属、当前摘要、检查身份与当前
审批状态：

- 写事务内复用入口：`verifyFeaturePlanApprovalInTransaction(transaction,
  projectId, featureId)`（application 层；供 P03-3/4 在创建 Run/Attempt 的
  同一写事务内复用）——项目把关（缺失/不可见 forbidden）→ 计划快照
  （缺失 not_found、跨项目 ownership）→ 同事务读取全部决策记录
  （`listPlanApprovals`）与全局/项目当前配置 → 纯规则评估；只读评估，
  不写任何行；
- 查询面：`features.approvals` 结果新增 `validity` 块（Feature、全部决策
  记录、全局/项目当前配置与 taskCount 来自同一 DEFERRED 读事务），
  当前查询与核验共享同一纯规则与明确过期原因；
- 评估纯规则 `evaluatePlanApprovalValidity`（确定性顺序，fail-closed）：
  1. 无当前 planDigest → `no_plan`；零 Task → `no_tasks`；
  2. 当前身份（planDigest + 当前检查政策摘要）决策：rejected → `rejected`；
     approved 且 planStatus=approved → **valid（`approved`）**；approved 但
     planStatus≠approved（决策后计划被修订重置）→ `plan_changed`；
  3. 当前摘要（任意政策绑定）有 rejected 决策 → `rejected`（政策变化不
     赦免同摘要拒绝）；有 approved 决策但绑定非当前检查政策（含 v7 遗留
     NULL）→ `check_policy_changed`；
  4. planStatus=approved 但无当前身份 approved 决策 →
     `approval_state_inconsistent`（防御桶；正常命令通道不可达）；
  5. 存在旧摘要 approved 决策 → `plan_changed`；否则 → `not_approved`；
- 未批准、拒绝、过期（plan_changed/check_policy_changed）、不一致均
  valid=false 且携带明确原因；**批准有效仍不是启动授权**——核验不创建 Batch/Run/Attempt、
  不调用 Runtime/Git/检查进程。

## 4. 失效与证据保留

- 批准前后的实质要求/验收/依赖修改（`feature.plan.revise`，planDigest 变化）
  使旧批准失去执行效力：planStatus 回 draft（F-008/F-002 既有规则），旧决策
  行保留为历史证据，查询与核验返回 `plan_changed`；
- 适用检查政策修改（settings 更新）不回写任何 Feature/approvals 行：
  planStatus 与决策记录原样保留（证据），核验按当前身份重估返回
  `check_policy_changed`；重新批准当前身份（同一 planDigest + 新检查政策
  摘要）后才能通过核验；
- 纯标签 CAS 更新（`plan.labels.update`）不改变业务摘要、不使有效批准失效
  （labels 不在 planDigest 与检查政策摘要输入内）；
- 已知边界（沿用 F-002 定案）：修订回完全相同内容（planDigest 与检查政策
  均与既决策相同）时同身份重复决策仍 `approval_already_decided`——翻转
  任何既有决策必须先实质修订；检查政策回摆使精确匹配的旧决策重新成为
  当前决定（内容级身份相同，与 planDigest 纯内容函数语义一致）。

## 5. 与既有契约的差异记录

- `docs/p03-2-plan-approval-contract.md` §2 的唯一约束「同主体同摘要至多一条
  决策」自 v8 起精确化为「同主体同身份（planDigest + 检查政策摘要）至多一条」；
  §7 预留的「F-003 将扩展摘要覆盖面与核验服务」由本文档落定；
- `decisions[].current`（features.approvals）语义不变：仍按 planDigest 绑定
  区分当前/历史决定；有效批准的最终判定以 `validity` 块为准；
- 线协议不变（schemaVersion 仍为 4；决策 payload 无新键；Host 查询接线属
  F-007）；能力位不变（决策 `feature.plan.decide`、查询复用 `project.read`）。

## 10. F-009 集成回归写回登记

- `test/modules/planning/p03-2-integration-regression.test.ts`（正式构建 dist CLI + dist Host + 隔离
  真实 SQLite）以真实命令复核本契约的失效语义：检查政策内容变化 → HTTP
  `features.approvals` 查询 `validity.reason=check_policy_changed` 且新
  `execution.input.prepare` fail-closed；恢复同内容政策后按内容身份自动恢复有效
 （不依赖配置 revision）；实质修订（要求变化）→ `plan_changed` + planStatus 回
  draft，重批当前身份后恢复；纯标签编辑与不影响 Task 副本的 modelMap 更新不失效。
- 集成回归同时复核「未创建 Batch/Run/Attempt、未启动 Work」：库内无执行实体表、
  事件全部落在冻结白名单且无执行启动事件、命令白名单无 Work/Run/模型调用操作。
- 交接文档 `docs/p03-2-handoff.md` §3.1/§6 冻结本契约核验入口与失败词汇的
  P03-3/4 复用方式；`accept:p03` 与真实 Pi live 显式 not_run。
