# P03-8 F-010：Feature 分轴结果查询契约

Feature 交付全景经既有授权查询面只读暴露。协议保持 protocolVersion 1 /
schemaVersion 5，握手在 v5 能力视图内追加一个查询宣告（接线后宣告，不漂移）。
能力位复用 `project.read`，不新增能力位；Host 不做业务授权，全部能力/可见性
判定在 Core 应用层。

| Operation | Route | Behavior |
| --- | --- | --- |
| `features.delivery.get` | `GET /v1/features/:featureId/delivery?projectId=` | 单 Feature 分轴结果：Task/最终检查/人工审批/交付四轴 + 可区分总体 outcome。 |

## 分轴内容

结果从持久 SQLite 一致读视图重建（`FeatureDeliveryQueryReadStore`，同一
`BEGIN DEFERRED` 读事务），绝不从日志或模型文本推断：

- **tasks**：全部必需 Task 当前有效结果（`status` + `effectivePassed`，恒等于
  持久 `status==='passed'`，机器绿色不折算）与历史引用（`latestAttemptId`，
  无 Attempt 为 null）、`firstPassedAt`、`manualBlock`；Task 数受计划导入上限
  （100）约束，总量有界。
- **verification**：最近独立 Feature VerificationBatch
  （`operation='FeatureVerification.full'`，与 F-004 执行器同一持久身份）及逐
  检查状态；选择/回退理由、代码/策略/环境身份、输出 Artifact/tail 引用复用
  F-013 公共形状；无批次为 `none`。缺失耗时/退出信息保持 null（不填 0）。
- **approval**：Feature 全部人审事项（(created_at,id) 升序，上限 128，超限
  置 `itemsTruncated`）与只读派生的当前绑定状态
  （`none/pending/approved/rejected/blocked/stale`；绑定规则与
  `evaluateFeatureFinalApproval` 同源：事项须绑定当前 planDigest 与当前最终
  检查代码身份，历史绑定事项保留展示但不构成当前授权）。
- **delivery**：持久 `deliveryStatus`（独立交付轴，不等同 Feature 业务状态）
  与 Feature 最近 Git operation 的 F-009 脱敏投影（待核对/回执缺失不显示
  为成功）。

## 总体 outcome（可区分结构化结果）

`outcome` 冻结词汇：`in_progress`、`tasks_failed`、
`final_verification_failed`（所有 Task passed 但最终失败）、
`awaiting_approval`（机器通过待人工批准）、`delivery_uncertain`（提交待核对）、
`delivery_failed`（提交失败）、`committed_but_blocked`（Git 已提交但当前审批
出现新阻塞/拒绝）、`evidence_incomplete`（完成/终态但必需证据缺失）、
`completed`。

- 失败阶段使用 Feature 级 `executionStage`
  （`task_execution/feature_verification/final_approval/git_delivery`；
  `completed` 恒 null，非 completed 恒非 null）。
- `reason` 优先取持久 Run 控制原因码，缺失时使用派生码；
  `identities` 携带 Feature/Run/Batch/verificationBatch/gitOperation 身份。
- `nextStep` 为显式下一步冻结词汇（`none/continue_execution/
  feature_verification_continue/feature_approval_decision/
  manual_block_resolution/git_operation_reconcile/rework_authorization`）：
  均为人工或授权命令动作，绝不暗示自动重跑编码；最终检查失败需要明确失效
  范围与返工授权（`rework_authorization`，不在本命令面内）。
- completed 不掩盖缺失证据或其他轴失败：Feature `completed` 但最终检查证据
  缺失/未通过、交付事实缺失或当前审批新阻塞时，outcome 绝不报告 completed。

## 错误与不变量

- 跨项目读取、无权限主体、不可见项目：`project.read` 缺失先行 `forbidden`；
  不可见与不存在/跨项目目标统一 `not_found`（同一形状，不回显归属或存在性）；
  未知键（含提权字段）与非法身份在任何 SQL 之前 `invalid_input`。
- 查询零写入、零事件、零续租，不触发 Git/Runtime/预算；重复读取不增加任何
  计数；真实 SQLite 重开后结果逐字节一致。
- 脱敏纪律：不投影 worktree 路径（开发机固定绝对路径）、`ownerId`/
  `hostInstanceId`（内部执行归属），不携带凭据、敏感环境值或原始堆栈。

局部验证在 `test/modules/delivery/p03-8-f010-feature-delivery-query.test.ts`（真实 SQLite +
真实 Host 纵向）；Feature 全量验收由 Nezha 独立执行。
