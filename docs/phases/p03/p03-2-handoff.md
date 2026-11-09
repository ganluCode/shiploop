# P03-2 计划批准、Task 策略与固定执行输入 — 交接（P03-2 → P03-3/4 及 P03-10）

- 来源 Feature：P03-2（F-001 策略副本 CAS 编辑、F-002 计划批准/拒绝决策、F-003 有效批准
  核验与失效、F-004 执行必需输入采集、F-005 有版本 ContextBuilder、F-006 输入准备与
  不可变制品组、F-007 Host/HostClient 接线、F-008 CLI 入口、F-009 跨模块集成回归与本文
  交付门禁）。
- 交接对象：**P03-3/P03-4**（Run/Attempt 创建与执行授权消费本项交付的审批依据与固定
  输入制品组）与 **P03-10**（阶段验收 `accept:p03` 提供方）。
- 输入文档版本：PRD `p03-2-plan-approval-input.md`（Feature 工作区 feature.yaml 输入）、
  P03-1 交接 [p03-1-handoff.md](p03-1-handoff.md)（起步基线与复用边界）、实施契约
  [p03-2-task-strategy-edit-contract.md](p03-2-task-strategy-edit-contract.md)、
  [p03-2-plan-approval-contract.md](p03-2-plan-approval-contract.md)、
  [p03-2-plan-approval-verification-contract.md](p03-2-plan-approval-verification-contract.md)、
  [p03-2-execution-input-contract.md](p03-2-execution-input-contract.md)、
  [p03-2-context-build-contract.md](p03-2-context-build-contract.md)、
  [p03-2-execution-input-prepare-contract.md](p03-2-execution-input-prepare-contract.md)、
  操作说明 [p03-2-cli-approval-input-operations.md](p03-2-cli-approval-input-operations.md)。
- 基线与代码：P03-1 验收基线 commit `427c0a0`（F-011 交接提交）；P03-2 各 Feature 提交
  F-001 `a7a53ff`、F-002 `cbb310e`、F-003 `202d796`、F-004 `1e4baf8`、F-005 `f1defe7`、
  F-006 `3f77dd2`、F-007 `22ab867`（返工 `dffa406`）、F-008 `d16b842`；**F-009 交接提交即
  本文所在提交**（文档先于提交无法自引用完整 hash；精确 hash、验证命令/退出码与脱敏
  证据以 Feature 工作区 `verifications/F-009/` 记录为准，未运行不计通过）。
- 本文只交接**已实现且已有真实测试**的公共面、Schema 与失败边界；未实现/未运行能力
  显式标注 `not_run`。**P03-2 不提供 `accept:p03`**（由 P03-10 提供），也未运行真实
  Pi live，未创建 Batch/Run/Attempt，未启动 Work。

## 1. 实现范围（逐 Feature）

| Feature | 交付 | 主要落点 |
|---|---|---|
| F-001 | `task.strategy.update` 完整 executionConfig 副本授权 CAS 编辑与来源追踪（不重读默认路由、活动执行输入保护同事务重核） | `packages/core/src/application/task-strategy-update.ts` |
| F-002 | 绑定当前 planDigest 的批准/拒绝决策记录（迁移 v7 approvals 表；批准不是启动授权；回归 `test/modules/planning/p03-2-plan-approval-command.test.ts`） | `application/feature-plan-decide.ts`、`adapters/sqlite/migrations.ts` |
| F-003 | 复合决策身份（planDigest + 适用检查政策内容摘要，迁移 v8 `approvals.check_policy_digest`）、`evaluatePlanApprovalValidity` 纯规则与 `verifyFeaturePlanApprovalInTransaction` 同事务复用入口、`features.approvals` 查询 | `application/plan-approval-verification.ts`、`application/query-service.ts` |
| F-004 | 执行必需输入受控采集与校验读取（文件源捕获实际字节发布不可变制品；制品源归属/ready/身份核验；获准根白名单 + realpath/no-follow） | `application/execution-input.ts`、`adapters/fs/input-source-files.ts` |
| F-005 | 有版本 ContextBuilder：固定指导与动态输入分离，有界 prompt/inputManifest/完整 Task 输入内容与确定性摘要（labels 只入 meta 不参与摘要） | `application/context-build.ts`、`ports/context-build.ts` |
| F-006 | 输入准备三阶段编排（DEFERRED 一致视图捕获 + fail-fast 批准核验 → 事务外采集/组装/发布/逐字节复验 → 最终写事务身份重核 + `execution.input.prepared` 事件 + completed 回执原子提交）；snapshot/manifest/prompt 不可变制品组 | `application/execution-input-prepare.ts`、`ports/execution-input-prepare.ts` |
| F-007 | Host/HostClient 接线（线消息显式升 v5；`decideFeaturePlan`/`updateTaskStrategy`/`prepareExecutionInput` + `GET /v1/features/:id/approvals` 授权查询 + 四个线校验器；受控制品组读取边界；回归 `test/modules/planning/p03-2-host-wiring.test.ts`） | `packages/host/src/runtime/app-transport.ts`、`client/app-client.ts` |
| F-008 | CLI `feature approve|reject`、`task strategy`、`task prepare`、`task inputs`（沿用既有参数/输出/退出码约定；秘密与身份字段连接前拒绝；回归 `test/modules/planning/p03-2-cli-args.test.ts`/`test/modules/planning/p03-2-cli-vertical.test.ts`/`test/modules/planning/p03-2-cli-built.test.ts`） | `packages/cli/src/app/*` |
| F-009 | 正式构建产物跨模块集成回归（本文 §5/§7 证据来源）与交付门禁 | `test/modules/planning/p03-2-integration-regression.test.ts`、本文 |

## 2. SQLite Schema（迁移 v8，冻结事实）

- v7 追加 `approvals` 决策表（subject_type=feature_plan 冻结、复合同项目外键、同主体
  同摘要 UNIQUE、已决定形态 CHECK）；v8 追加 `approvals.check_policy_digest`（可空
  64hex CHECK + 五列唯一索引重建；v7 遗留 NULL 绑定 fail-closed 需重批，不重建表、
  不改写既有行）。v1–v6 SQL/checksum 未改动（迁移守卫同步 [1..8]）。
- **未建表**（不得提前）：Batch、Run、Attempt、Work、配置/计划历史版本表、
  Feature DAG 派发表。F-009 集成回归以只读探针核验库内不存在任何
  batch/run/attempt/work 表（验收 1 的「未创建执行实体」证据）。

## 3. P03-3/4 必须复用的绑定面（不得重建）

### 3.1 有效批准核验（创建 Run/Attempt 的同一写事务内复用）

- 入口：`verifyFeaturePlanApprovalInTransaction(transaction, projectId, featureId)`
 （F-003 为 P03-3/4 预留的同事务复用入口）；纯规则
  `evaluatePlanApprovalValidity` 可独立测试。
- 复合身份 = 当前 `planDigest` + **适用检查政策内容摘要**（`resolveCurrentCheckPolicyDigest`
  从视图内全局/项目当前配置合并计算；不依赖可变配置路径、通用配置 revision 或 labels）。
- 失败词汇（冻结）：`no_plan`/`no_tasks`/`not_approved`/`rejected`/`plan_changed`/
  `check_policy_changed`/`approval_state_inconsistent`。实质要求/验收/依赖/检查政策变化
  令旧批准失效且保留旧决策证据；重新批准当前身份后恢复。纯标签编辑、不影响 Task 副本
  的默认 modelMap 更新不失效（内容身份，非裸 revision）。
- 查询面：`GET /v1/features/:featureId/approvals`（`features.approvals`，能力位
  `project.read`；同一 DEFERRED 读视图，`currentDecision`/`decisions`/`validity`）。

### 3.2 Task 策略副本与 revision

- `task.strategy.update`（`task.strategy.write`）：信封 expectedRevision 为目标 Task
  自身 revision 的单语句 CAS；整体替换完整 executionConfig 副本，来源服务端定值
  `task_edit`（`configSourceKey=taskEdit`）。批准前的可选覆盖走同一命令，无第二条通道。
- 默认路由不追溯：modelMap/complexity 更新不回写既有副本（F-009 集成回归经
  `config update` + `task get` 复核）。
- 内容身份：`computeExecutionStrategyCopyDigest`（executionConfig+来源；纯标签编辑只
  递增 revision 不改变内容身份——最终重核不误报）。

### 3.3 不可变输入制品组与摘要绑定

- `execution.input.prepare`（`execution.input.prepare` 能力位，创建类无 expectedRevision）
  返回 `PreparedExecutionInputGroup`：snapshot/manifest/prompt 三正文为同项目不可变
  制品（locator `execution-input-groups/<taskId>/<part>`，version/hash/size 取权威索引），
  正文物理位置 `<dataRoot>/projects/<projectId>/artifacts/<artifactId>/content`。
- 绑定身份（P03-3/4 写入 Run/Attempt 时必须整体携带）：`approval.planDigest` +
  `approval.checkPolicyDigest` + 三正文 `contentHash` + `requiredInputs[].contentHash`
  + 策略副本内容摘要 + 权限面内容摘要（`computeExecutionPermissionsDigest`）。
- **历史回执重放 ≠ 满足当前前置条件**：绑定前必须在创建 Run/Attempt 的同一写事务内
  重核（F-006 定案；F-009 集成回归以检查政策/要求改变后新准备 fail-closed 复核）。
- 失败/漂移语义（冻结词汇，`EXECUTION_INPUT_PREPARE_FAILURE_REASONS`）：
  `plan_changed`/F-003 审批词汇/`task_strategy_changed`/`permissions_changed`/
  `task_not_in_plan`/`artifact_not_ready`/`artifact_missing`/`missing`/`changed`。
- 输入正文读取：只按获准制品组内 Artifact 身份经 `readVerifiedContent` 有界校验读取
 （逐字节复验；篡改 → `corrupt`）。**Host `artifacts.get` 仅暴露 P02-3 基线输出成员**
 （防枚举边界），P03-2 未新增通用制品正文读取面。

### 3.4 预算与装配边界

- Core 冻结缺省：`DEFAULT_EXECUTION_INPUT_PREPARE_LIMITS`（maxRequiredItems=16）、
  `DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET`（maxPromptBytes=400 000、
  maxRequiredSnapshotBytes=300 000、maxHistoryEntries=50 等，token 恒标 estimation）、
  F-004 采集限制（maxItems=64、maxItemBytes=4 000 000、maxTotalBytes=16 000 000）。
- `openCoreApplication` 装配：`inputSourceRoots` 获准源文件根白名单由可信装配注入，
  **缺省空名单**（生产 Host 当前未注入——任何 file 来源 fail-closed `unknown_root`，
  F-009 集成回归复核；正向文件采集证据在 Core 测试装配
  `test/modules/planning/p03-2-execution-input.test.ts`/`test/modules/planning/p03-2-execution-input-prepare.test.ts`）；
  权限读取器缺省 `TRUSTED_PROJECT_PERMISSIONS_READER`（显式空集边界宣告）。

## 4. Host/CLI 线面（冻结事实）

- 线消息 schemaVersion **5**（F-007 显式升版；旧版本明确 `unsupported_schema_version`）。
- 新命令：`feature.plan.decide`/`task.strategy.update`/`execution.input.prepare`（经
  `POST /v1/commands` 冻结信封/回执/有限重试）；新查询：
  `GET /v1/features/:featureId/approvals`（唯一冻结 Feature 子资源形态）。
- CLI：`feature approve|reject <featureId> --project --digest --revision [--reason]
  [--command-id]`、`task strategy <taskId> --project --revision --input`、
  `task prepare <taskId> --project --feature --input`、`task inputs <commandId>`；结构化
  输出含实际计划身份/审批状态/策略与来源/制品组 version/hash/用途与执行边界视图
  （`started:false, capability:"unknown", runnable:false`——不宣称执行）。
- 退出约定：参数/结构失败 2（`invalid_input`），业务拒绝 1（`not_found`/`forbidden`/
  `conflict` 等，具体原因在 `details.reason`）。

## 5. F-009 集成回归覆盖（正式构建产物链路）

`test/modules/planning/p03-2-integration-regression.test.ts`（3 用例，真实 `dist/bin.js` 子进程 + dist
产物 Host + 隔离真实 SQLite + 只读探针审计）：

1. **主线**：三 Task 导入 → 查看策略（modelMap/default 副本）→ 批准前可选覆盖
  （task_edit）→ 指定摘要批准 → 准备输入 → `host stop`（三证据 + pid 退出）→ 重开后
   读取复验（查询/回执/制品正文逐字节一致/审批 HTTP 查询有效）；断言 Task 数量与 ID
   不变、库内无 batch/run/attempt/work 表、事件全部落在 `PUBLIC_STATE_EVENT_TYPES`
   冻结白名单且无执行启动事件、命令白名单无 Work/Run/模型调用操作（未调用真实模型、
   未启动 Work 的三方核验）。
2. **漂移矩阵**：modelMap 更新不追溯（`task get` 副本不变 + 新准备可绑定）；非活动
   Task 副本编辑后新输入摘要改变、旧制品组逐字节不变、历史回执保留原身份；检查政策
   改变 → `check_policy_changed`（HTTP 审批查询 + 新准备 fail-closed），恢复同内容政策
   后按内容身份自动恢复；纯标签编辑不失效；实质修订（要求改变）→ `plan_changed` +
   planStatus 回 draft，重批当前身份后恢复。
3. **历史增长与 fail-closed**：40 份大段报告制品 + 8 次标签 CAS 后，新准备的
   snapshot/manifest/prompt 摘要与正文**逐字节不变**（报告标记零泄漏、prompt ≤
   400 000B、acceptance 逐项完整可读、三次准备摘要一致）；必需输入缺失
  （`required_input_not_found`）/越界（file 来源 `unknown_root`；词法穿越结构层拒绝）/
   超预算（制品索引声明超 `maxItemBytes` → `limit_exceeded`）/跨项目
  （`ownership_denied`）/秘密字段（CLI 连接前拒绝）全部 fail-closed 且输出零泄漏；
   篡改后回执身份不被修复或掩盖、新准备发布新制品组不覆盖旧正文（失败证据保留）。

## 6. 验收索引映射（T24 / T25 输入子集 / T26 审批子集 / T37）

「仅声明本项适用范围，不代表已通过；不宣称后序执行或会话能力通过」——以下为 P03-2
实际交付证据；标注 not_run 的部分不在 P03-2 范围，不得折算通过：

| 编号 | 必测行为 | P03-2 交付子集 | 范围外（not_run） |
|---|---|---|---|
| T24 | Task 策略复制、默认更新不追溯、用户覆盖及重新应用默认预览 | 副本/不追溯/用户覆盖：`test/modules/planning/p03-2-task-strategy-edit-command.test.ts`、F-009 集成回归主线+漂移矩阵（modelMap 更新不追溯、task_edit 覆盖、modelMap.low 选择 `test/modules/planning/p03-1-task-strategy-selection.test.ts`） | 「重新应用默认预览」命令面未实现（无该入口，不伪装支持） |
| T25（输入子集） | 活动 Attempt 禁止改策略、返工换模型不清预算、快照脱敏与不可变 | 快照脱敏与不可变：F-009 集成回归（旧正文逐字节不变、凭据只有引用、篡改证据保留）+ `test/modules/planning/p03-2-execution-input-prepare.test.ts`（策略编辑后新快照旧正文不变、逐字节复验） | 活动 Attempt 禁止改策略的真实竞争（无 Run/Attempt；沿用 F-001 测试装配探测端口证据）；返工换模型不清预算（无预算记账，P03-3/4） |
| T26（审批子集） | 当前配置 CAS 冲突、计划修改禁止越过活动执行、过期审批失效 | 过期审批失效：F-009 集成回归漂移矩阵（`check_policy_changed`/`plan_changed`/纯标签不失效/重批恢复）+ `test/modules/planning/p03-2-plan-approval-verification.test.ts` 全矩阵；配置 CAS：`test/modules/cli/app-cli-config-execute.test.ts` + 集成回归顺带 | 计划修改越过**真实**活动执行的竞争（无 Run/Attempt；测试装配证据 `test/modules/planning/p03-1-plan-revise-command.test.ts`） |
| T37 | 稳定指导与动态文件输入分离，不因历史增长膨胀提示词 | F-009 集成回归增长用例（历史正文零内联：报告标记不进入任何正文、三摘要逐字节不变、acceptance 全量可读、必需输入缺失拒绝）+ `test/modules/planning/p03-2-context-build.test.ts`（历史索引有界/省略标注/预算超限结构化失败） | 缓存收益不以静态测试宣称；真实执行期历史（无 Run 历史，生产 prepare 的 historyIndex 恒为空——有界性经确定性不变断言与 Core 预算测试覆盖） |

## 7. 完整门禁与验证记录（真实命令/退出码）

- `npm run verify`（预检 + `npm test` + `npm run typecheck` + `npm run build` 含三包
  入口冒烟）：exit 0；`npm test` 计数与逐用例输出见 Feature 工作区日志。
- `npm run check:boundaries`：exit 0（0 诊断）。
- F-009 集成回归：3 用例 passed（正式构建产物 + 隔离真实 SQLite）。
- `accept:p03`：**not_run**（P03-10 提供）；真实 Pi live：**not_run**；Windows/WSL/
  Linux：未验收。
- 单次运行的完整输出、退出码与脱敏证据路径记录于 Feature 工作区 `tool-logs/F-009-*.log`
  与 `verifications/F-009/`（本仓库文档不内联一次性 run-id/绝对路径）。

## 8. 已知缺口（不折算通过）

1. **生产 Host 未装配 `inputSourceRoots`**：file 来源一律 `unknown_root` fail-closed
  （这是获准根白名单缺省边界，不是缺陷；正向文件采集在 Core 测试装配验证）。P03-3/4
   若需文件源输入，由可信装配显式注入白名单，不得在请求侧接受任意路径。
2. **执行输入正文无 Host 通用读取面**：`artifacts.get` 仅限 P02-3 基线输出成员（防
   枚举）；篡改 → `corrupt` 的运行时核验失败语义在 Core `readVerifiedContent` 层覆盖
  （`test/modules/planning/p03-2-execution-input-prepare.test.ts`「重开真实库后…正文篡改明确 corrupt」）。
   绑定前逐字节复验属 P03-3/4 startRun 同事务职责。
3. **ContextBuilder 级 `limit_exceeded`（必需内容 > 300 000B）无法经 Host/CLI 触达**：
   请求面有界（`MAX_APP_BODY_BYTES`=65 536），集成层超预算以制品索引声明超
   `maxItemBytes` 复核；Core 层预算失败由 `test/modules/planning/p03-2-context-build.test.ts`/
   `test/modules/planning/p03-2-execution-input-prepare.test.ts` 覆盖。
4. **Run/Attempt/Work/Runtime 未实现**：本项所有「未启动执行」断言基于表/事件/命令面
   三方核验；真实活动竞争、预算记账、停止核验属后续阶段。
5. **能力目录装配**：生产 Host 入口目录为空（fail-closed，纯生产构建无法装配策略配置
  ——P03-1 已记录缺口沿用）；F-009 集成回归以受信测试目录装配，不是产品能力放宽。
6. `verifyProject` 项目级中断核对（F-012 契约预留）不在 P03-2 范围。

## 9. 交接纪律

- P03-3/4 起步基线 = F-009 交接提交；开工前核对公共接口与真实测试，不把本文历史表述
  当现状。
- 不得重建：命令信封/回执/事件体系、审批复合身份与核验入口、策略副本 CAS、输入采集
  与制品组发布、ContextBuilder 预算契约、线消息 v5 语义。
- 不得弱化：fail-closed 探测、防枚举 not_found/forbidden、脱敏事件与错误、幂等/CAS
  纪律、「批准不是启动授权」「历史回执重放不代表满足当前前置条件」边界。
- 本文档事实与守护测试 `test/modules/planning/docs-p03-2-handoff.test.ts` 同源；后续 Feature 改变这些
  事实时必须同步更新本文与守护。
