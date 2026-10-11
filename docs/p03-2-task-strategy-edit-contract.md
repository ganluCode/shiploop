# P03-2 Task 策略副本授权 CAS 编辑契约（F-001）

- 文档状态：P03-2 / F-001 交付的命令用例契约（Core 层）；CLI 入口属 F-008。
  **F-007 接线定案（写回登记）**：HostClient 公共方法 `updateTaskStrategy` 经既有
  `POST /v1/commands` 通用路由接线（冻结信封/回执/有限重试），completed 回执
  内嵌结果经线校验器 `validateTaskStrategyUpdateResultWire` 复核；线消息
  schemaVersion 随 P03-2 能力集合变化显式升 v5（Host 握手能力清单手动接线
  宣告，不随 Core 支持面自动增长）。
- 实现入口：`packages/core/src/application/task-strategy-update.ts`（经 `shiploop-core`
  公共入口导出：`submitTaskStrategyUpdate` 与全部常量/类型；结构化错误 operation 固定
  为 `task.strategy.update`）。
- 上游契约：`docs/p03-1-task-strategy-selection.md`（F-003 副本/来源选择契约——其范围
  边界将「Task 策略编辑」留待本任务定案）、`docs/p03-1-plan-import-contract.md`
  §6.7/§6.8（可区分的元数据/实质编辑先例与活动执行输入保护纪律）。
- 本文不是阶段验收报告；真实 Run/Attempt 竞争 not_run（P03-2 无执行实体表，见 §5）。

## 1. 职责与命令面

在 P03-1 已创建的 Task 上，授权主体经既有命令信封提交**完整 executionConfig 副本**的
CAS 编辑（`task.strategy.update`，能力位 `task.strategy.write`，project scope，
mutation=update）：

- 信封 `expectedRevision` 唯一权威来源是信封顶层，指向**目标 Task 自身 revision**
  （与 `plan.labels.update` 在 Task 上的 CAS 空间一致；同 revision 竞争编辑/标签编辑
  经单语句条件 UPDATE 裁决仅一个生效）；
- payload 只含 `taskId`（目标 Task 稳定 ID）与 `executionConfig`（完整策略副本 JSON
  对象）；严格未知键拒绝——`configSource`/`configSourceKey`/`status`/`planStatus`/
  `approval`/`revision` 等服务端决定字段不能经请求输入（payload 内出现即未知键，
  定位 `payload.<key>`）；
- 深校验分层与计划导入/修订同一纪律：信封层只把关形态（taskId 稳定 ID、
  executionConfig 为 JSON 对象），完整策略语义与能力兼容在应用层编辑事务内复用
  F-003 `validateTaskExecutionConfig` 与 `validateRuntimeStrategyCapabilities`
  （见 §2/§3），不在 ports/commands.ts 重复。

## 2. 副本语义与来源（实际来源，非动态配置指针）

- 输入必须是**完整 schemaVersion=2 策略条目**（`runtime`/`provider`/`model` 必需，
  可选 `credentialRef`/`endpointRef` 引用字符串）：缺任一必需字段、孤立 model 覆盖
  （只给 model 不给 runtime/provider）、未知键、秘密正文字段（apiKey/token/password
  等）、非法引用（带凭据 URL）一律带字段定位拒绝（`payload.executionConfig.*`），
  **不从既有副本、当前默认配置或任何其他来源拼补字段，不回落其他厂商/模型**；
- 编辑成功后 `config_source` 定值为 **`task_edit`**、`config_source_key` 定值为
  **`taskEdit`**（F-001 定案；由服务端定值，不接受请求声明）——表达「显式授权 CAS
  编辑」这一实际来源，覆盖编辑前的创建时来源说明；来源仅供追踪解释，不是执行时
  动态引用（执行使用 Task 副本，不重新读取 modelMap）；
- **来源词汇扩展记录（与 F-003 契约的差异）**：F-003 创建时词汇
  `project_default`/`global_default`/`user_override`（`TASK_STRATEGY_CONFIG_SOURCES`
  常量不变）描述**创建时选择**；本任务追加 `task_edit` 描述**创建后的显式编辑**。
  `tasks.config_source` 列仅有非空 CHECK（迁移 v6），追加取值无需迁移。
- 批准前的可选 Task 覆盖（PRD FR-1「批准前可 CAS 修改副本」）复用本编辑规则，
  不存在第二条绕过 CAS 的写入通道；完整批准记录/决策流程属 P03-2 后续任务。

## 3. 能力兼容校验（复用可信目录，fail-closed）

- 兼容性判断只依赖组合根注入的只读能力目录（`RuntimeCapabilityCatalog`），复用
  `validateRuntimeStrategyCapabilities`（与配置命令同一目录、同一 reason 码：
  `unknown_runtime`/`incompatible_provider`/`unsupported_model`），不另立第二套；
- **目录未装配**：命令 `unsupported`（与配置命令同一纪律，不冒充能力）；
  **目录为空**（装配了空目录）：任何 runtime（含 Pi/Fake）都拒绝
  （`unknown_runtime`），未装配能力不得伪装为受支持；
- 合法 ≠ 可执行：编辑成功只表示副本结构与能力兼容校验通过，不声称 Runner/认证/
  模型执行能力可用（`assessSettingsConfiguration` 纪律不变）。

## 4. 影响面（TASK_STRATEGY_EDIT_IMPACT 纯规则冻结）

| 对象 | 影响 |
|---|---|
| 目标 Task | execution_config/config_source/config_source_key 整体替换，自身 revision +1 |
| 其他 Task / Feature | 不变（标题/验收/依赖/副本/来源/revision 均不触达） |
| planDigest / planStatus | 不变（摘要规范化白名单不含策略副本与来源；批准绑定不因本编辑失效） |
| 默认路由 | 不重读（项目 modelMap 更新与 Task complexity 更新均不触发/不追溯替换副本；既有 Task 副本只能经本命令显式替换） |
| 执行实体 | 不创建（无 Batch/Run/Attempt 写入；不调用 Runtime） |

## 5. 活动执行输入保护（同事务重核，沿用 F-008 端口纪律）

- 编辑与活动依据建立（未来 start/claim 写入 Run/Attempt）的竞争由「同一
  BEGIN IMMEDIATE 写事务内重核 + Task 自身 CAS」裁决：探测到 queued/running/
  paused/停止未知等活动依据即在任何业务写入之前固化 rejected 回执（conflict，
  `reason='active_execution_inputs'`，details 只含受控白名单键）；**暂停不视为
  安全停止**；
- 探测失败 **fail-closed**：异常传播整组回滚、零回执，绝不把查询失败默认为
  「无活动」；
- 生产默认探测 `NO_ACTIVE_TASK_EXECUTION_INPUTS_PROBE` 是**能力边界宣告**（P03-2
  存储无 Run/Attempt 表，迁移版本不变，本任务不建调度器或 Attempt 表模拟后序
  能力）；执行实体表引入时必须替换为同事务真实查询（fail-closed）；
- 证据边界（如实区分）：本保护由受控测试装配注入探测验证
  （`test/p03-2-task-strategy-edit-command.test.ts`），真实 Work/Run 竞争
  **not_run**（Work 调度与 Runtime 执行属后续阶段）。

## 6. 原子性、幂等与事件

- 成功编辑 = 策略替换 + `task.strategy.updated` 脱敏事件（payload 恒
  `{strategyUpdated:true}`，聚合为目标 Task 自身，aggregateRevision=编辑后 revision）
  + completed 回执，同一 BEGIN IMMEDIATE 原子提交；注入写入失败（tasks
  UPDATE/state_events INSERT/command_receipts INSERT 任一）整组回滚，无半条修改、
  不删除历史证据；
- 幂等沿用 P02 §5.5：同 commandId 同参数重放返回原回执且零新增写入/事件；异参
  复用 conflict（`idempotency_key_reuse`）；回执重放前重核当前权限；
- completed 回执结果有界：`{ task: <PublicTaskRecord> }`（策略副本与来源是编辑事实
  本身）；不回显秘密正文、不声称批准/可执行/执行结果。

## 7. 拒绝矩阵（明确拒绝，零业务写入）

| 情形 | 结果 |
|---|---|
| 缺 runtime/provider/model、孤立 model 覆盖 | invalid_input（`payload.executionConfig.*`），不跨来源补字段 |
| 未知 runtime / 不兼容 provider / 未确认 model | invalid_input（unknown_runtime/incompatible_provider/unsupported_model），不回落其他厂商 |
| 秘密正文字段 / 非法凭据引用（带凭据 URL） | 拒绝，错误**不回显**秘密正文 |
| payload 混入 configSource/status/planStatus/approval/revision 等 | invalid_input（`payload.<key>` 未知键） |
| 缺 `task.strategy.write` 能力 / 不可见项目 | forbidden（capability_denied/project_not_visible，不泄漏存在性） |
| 跨项目目标 / 不存在目标 | forbidden（ownership_denied）/ not_found（抛出，零回执零写入） |
| 陈旧 revision / 同 revision 竞争 | 固化 rejected（conflict，携带 expected/actual），零业务写入 |
| 活动执行依据（queued/running/paused/停止未知） | 固化 rejected（active_execution_inputs），零业务写入 |
| 目录未装配 / 空目录 | unsupported / unknown_runtime（fail-closed，不伪装支持 Pi/Fake） |

## 8. 存储原语（CommandTransaction 扩展）

- `getTask(projectId, taskId)`：事务内读取目标 Task（缺失 not_found、跨项目
  ownership 抛出，零写入）；
- `updateTaskStrategy(input)`：单语句条件 UPDATE 只触达目标 Task 的
  execution_config/config_source/config_source_key/revision/updated_at；输入经
  `ports/plan-store.ts` 的 `validateUpdateTaskStrategyInput`（严格未知键；副本只作
  「普通 JSON 对象且有界」形状门槛，语义校验在应用层，与创建/替换同一分层）；
- 事件白名单扩展：`PLAN_EVENT_TYPES`/`PUBLIC_STATE_EVENT_TYPES` 追加
  `task.strategy.updated`（aggregate_type='task'、project scope、payloadKind
  'taskStrategyUpdated'），与公开映射同源。
