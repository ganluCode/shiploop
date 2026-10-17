# P03-8 / F-002 受控 Git 提交意图与操作回执契约（持久化、幂等与 CAS）

- 文档状态：P03-8 / F-002 交付的提交意图/回执持久化契约。上游 PRD：
  `input/p03-feature-delivery.md` FR-1 与 `core-design/07` §4“提交作为
  operation”、`core-design/11` §9（operations 的 intent/step/receipt 语义）。
- 实现入口：`packages/core/src/ports/git-operations.ts`（纯契约：记录形态、
  校验器、意图摘要、幂等判定）、
  `packages/core/src/adapters/sqlite/git-operations.ts`（真实 SQLite 适配器）、
  SQLite 迁移 **v26**（`adapters/sqlite/migrations.ts`）；原子命令端口新增
  `getGitOperation/registerGitOperation/finalizeGitOperation`。
- 本任务边界：**不执行 Git、不读文件系统、不等待审批**。F-003 在事务外执行
  受控提交，F-004 依据本表意图核对不确定副作用，F-008/F-009/F-010 接入命令
  与查询。本表不是“Git 已成功”的验收凭证，实际 commit/tree 必须由 F-003
  核对后写回。

## 1. 持久化结构（迁移 v26）

`git_operations` 单表保存 Feature 最终提交的完整意图与终态回执：

| 类别 | 列 | 语义 |
| --- | --- | --- |
| 身份 | `id`（= operationId）、`project_id`、`feature_id`、`run_id`、`attempt_id`（可空）、`execution_version` | 同项目 Feature/Run/适用 Attempt 关联；`attempt_id` 存在时由触发器核对同项目/Feature/Run 与 executionVersion |
| 操作 | `operation_type` | 本版本唯一 `feature_final_commit` |
| 仓库身份 | `repository_binding_id`、`repo_identity`、`worktree_path` | 同项目绑定 + 稳定仓库身份 + 规范化 worktree 路径（F-003 执行前再次核对 realpath） |
| 代码身份 | `expected_head`、`candidate_tree`、`code_digest` | 提交前固定的预期 HEAD、候选 tree 与候选源码摘要 |
| 依据 | `verification_refs`、`approval_refs`（JSON 数组）、`delivery_policy_digest` | 每条引用含 `kind/id/digest`；政策身份为 F-001 `computeDeliveryPolicyDigest` |
| 提交内容 | `message`、`identity_name`、`identity_email` | 用户明确配置并确认的 Git 身份（`confirmed === true`），不回落全局身份/官方邮箱 |
| 审计/归属 | `runtime_source`（可空 JSON）、`owner_id`、`host_instance_id`、`intent_digest` | runtime/provider/model 与 Git 身份分离；执行归属不携带凭据 |
| 生命周期 | `status`、`revision`、`created_at`、`updated_at` | 注册恒 `pending`/revision=1；终态写回 CAS revision+1 |
| 终态事实 | `actual_commit`、`actual_tree`、`exit_code`、`duration_ms`、`reason_code`、`receipt`、`delivery_status`、`settled_at` | 未知退出/耗时保持 `NULL`；回执为权威 JSON 快照 |
| 交付投影 | `features.delivery_status` | 迁移 v26 追加列，默认 `not_requested`；终态写回同事务更新 |

迁移只追加 v26：v1–v25 checksum 与历史行不变；不建通用 `operations` 表、
不建第二套项目/仓库/验证表。触发器提供防御纵深：

- `git_operations_insert_pending`：INSERT 只能 `pending`（未固定意图不能先有终态）；
- `git_operations_attempt_identity_check`：Attempt 关联必须同项目/Feature/Run/
  executionVersion；
- `git_operations_intent_immutable`：全部意图列与 `created_at` 不可 UPDATE；
- `git_operations_terminal_immutable`：终态后任何 UPDATE 拒绝（迟到/重复结果
  不能覆盖权威事实）。

## 2. 注册语义

输入（`GitOperationRegisterInput`）= 完整意图 + `expectedFeatureRevision`。
注册在单个 `BEGIN IMMEDIATE` 内：

1. 校验输入（未知字段、非法 OID/摘要/身份/路径、未知操作类型、非正
   revision/version、重复证据引用一律拒绝；校验失败零写入）；
2. 同项目归属链：Project → RepositoryBinding（`project_id`/`repo_identity`）
   → Feature（`feature.revision === expectedFeatureRevision`）→ Run（同项目/
   同 Feature）→ 适用 Attempt（同项目/Feature/Run，且
   `execution_version` 相等）；
3. 同 operationId 已存在：意图摘要相同 → 幂等返回原记录（`created=false`，
   不重复写事件）；意图不同 → conflict（`details.reason='intent_conflict'`）；
   跨项目复用 → ownership；
4. 插入 `pending` 意图并写 `git.operation.registered`（payload 仅
   `operationId`；聚合 `git_operation`，revision=1）。

跨项目、跨 Feature/Run/Attempt、陈旧 Feature revision
（`reason='stale_revision'`）与陈旧 executionVersion
（`reason='stale_execution_version'`）均结构化拒绝。

## 3. 终态写回（CAS + 原子边界）

`finalizeGitOperation` 只接受 `expectedRevision` 匹配的 `pending` 意图，在
单个 `BEGIN IMMEDIATE` 内完成：

1. 校验终态输入；`succeeded` 要求 actual commit/tree 且
   `actualTree === candidateTree`；`no_change` 要求
   `actualCommit === expectedHead`；`unknown` 不携带 actual commit/tree、
   `deliveryStatus='pending'`；`failed` 可保留已发生的 commit 事实；
2. 条件 UPDATE（`id + project_id + revision + status='pending'`）写回
   status/actual commit/tree/exit/duration/reason/receipt/delivery_status/
   settled_at，revision+1；未命中即 conflict；
3. 同事务更新 `features.delivery_status`（不改变 Feature revision，避免把
   提交成功倒写成计划/审批身份变化）；
4. 同事务写 `git.operation.settled`（payload 仅 `operationId/status`；
   aggregate revision = 2）。

相同终态事实再次写回 → 幂等（`settled=false`，不写第二个事件）；不同事实
→ conflict（`reason='terminal_operation_conflict'`）。任一步失败（含事件写
失败）整组回滚：不会出现只有成功事件/回执而没有权威状态的记录。Git、文件
I/O、等待审批不进入该事务。

`unknown` 状态保留未知退出码/耗时为 `null`，不以 0 填充；F-004 可在核对后
以新事实补齐（本任务不实现核对扫描）。

## 4. 幂等、竞争与恢复边界

- operationId 是 Git 操作身份，不等于命令 `commandId`，也不替代
  Task/Attempt 的 fencing 身份；F-008 将分别关联命令回执与操作回执。
- 两条真实 SQLite 连接竞争注册/收尾：`BEGIN IMMEDIATE` 串行化；后到者读到
  同一意图/终态事实后幂等返回，只有一次事件与一次 revision 递增。
- 终态表只保存“已核对事实”；Git 成功不自动代表 Task/Feature 通过。
  F-003 仍须核对 HEAD/tree/源码摘要与当前审批；F-004 在回执丢失时按意图与
  真实 commit 核对，不重复 commit。
- 本表不实现通用恢复、Run 重开、push/PR/自动合并或 Host 命令。

## 5. 验证覆盖

`test/p03-8-f002-git-operation-store.test.ts`（18 用例）：

- 迁移 v26：版本/长度、v1–v25 checksum 冻结、空库与 P02 v5/v25 前序库升级、
  features.delivery_status 列、表/索引/触发器结构；
- 注册：全字段持久化、同意图幂等、不同意图/跨项目/陈旧 revision/陈旧
  executionVersion 拒绝、数据库级意图不可变；
- 终态：success/no_change/unknown 形状、未知退出/耗时保持 null、未注册
  operation 不得写终态、陈旧 expectedRevision 拒绝、同事实幂等/不同事实
  conflict、事件写失败整组回滚、两条真实连接竞争注册/收尾。

既有迁移版本断言（sqlite-schema-migrations、sqlite-migration-runner、
p03-3/p03-5/p03-6/p03-7 等）同步到 v26；不修改历史迁移 checksum。
