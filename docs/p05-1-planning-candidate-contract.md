# P05-1 一次性规划候选 — 请求、候选与摘要契约

- 对应任务：F-001（定义一次性规划候选契约，复用业务计划校验并区分规划、测试候选与审批摘要）。
- 文档状态：P05-1 / F-001 实施前置契约 + 交付的纯校验/摘要模块说明（F-002 起存储、命令、
  工具通道与批准应用的协议依据之一；**不是阶段验收报告**，也不是已接入命令面/存储面的
  能力声明）。后续 Task 改变这些事实时必须同步更新本文与文档守护测试
  （`test/modules/planning/docs-p05-1-planning-candidate-contract.test.ts`）。
- 输入依据：`input/p05-planning.md`（PRD p05-planning，FR-1~FR-3）、知识目录
  `architecture-redesign/core-design/02-domain-and-lifecycle.md` §2（规划不是无限执行队列）、
  §4（Task kind=planning/coding）、`core-design/08-host-api-and-cli.md` §5.1（受限 Agent
  调用通道）。知识目录是开发查阅路径（Harness 内），非本仓库内容、非运行时依赖。
- 与既有契约的关系：业务计划 v1 输入语义与 planDigest 以
  [p03-1-plan-import-contract.md](p03-1-plan-import-contract.md) 与
  `packages/core/src/ports/feature-plan.ts` 为准（本契约原样复用，不另建 Task DAG 校验器）；
  检查政策身份摘要 checkPolicyDigest 以 `ports/plan-approval-verification.ts`
  （computeFeatureCheckPolicyDigest）为准；测试候选协议以
  `ports/verification-candidates.ts`（TestCandidatePayload）为准。本文只在「一次性规划
  请求与规划候选」这个新输入面上定案，不修改上述既有契约。

---

## 1. 范围与非目标

本契约定义纯数据契约（ports 层 `packages/core/src/ports/planning-candidates.ts`）：
版本化规划请求、规划候选 payload、候选身份封装、定向 verification 意图、四类摘要与
审批依据评估纯规则。全部为纯函数：无 I/O、无时钟、无数据库、无模型调用。

非目标（由后续 Task 交付，本文不虚构已实现）：

- 规划启动命令、预算绑定与持久派发（F-003/F-005，已交付）；
- 批准决策命令与计划原子应用（后续 Task）；
- 不引入 PlanRevision、第二套 Runtime 或新的通用工作流引擎；
- 不扩展后续 Phase DAG/Batch 功能（Feature DAG 并发、代码集成属 P05 其他 Feature）。

已交付接线（F-006）：候选提交工具通道与受管 Artifact 发布经 Core Work 工具桥
（`planning.candidate.submit` 有界正文入口 → F-001 校验 → 受控暂存发布 →
planning_contexts 单候选绑定 + 持久回执）、Host 受限入口
（`/v1/work/tools` + WorkToolClient 复用，无新管理命令）与 Pi 自定义工具桥
（`PiTrustedAssembly.resolveSubmissionTools` → session 工厂 customTools 白名单；
内置工具保持禁用）贯通；单候选/稳定重放/双提交竞争/撤权重核语义见
`application/work-tool-channel.ts` 与 F-006 测试。
- 批准决策命令与计划原子应用（后续 Task）；
- 不引入 PlanRevision、第二套 Runtime 或新的通用工作流引擎；
- 不扩展后续 Phase DAG/Batch 功能（Feature DAG 并发、代码集成属 P05 其他 Feature）。

## 2. 一次性规划请求 v1（schemaVersion=1）

用户发起一次规划时的受信输入（经命令信封进入，非模型输出）。键白名单：

| 字段 | 规则 |
|---|---|
| `schemaVersion` | 必须为 `1`（`PLANNING_REQUEST_SCHEMA_VERSION`）；未知/更高版本拒绝 |
| `projectId` / `phaseId` / `featureId` | 稳定 ID（validateStableId）；绑定现有 Project/Phase/Feature，归属存在性由启动命令事务重核 |
| `requirementRefs` | 身份级制品引用（artifactId 必填、contentHash 可选 64 位小写十六进制）；去重排序，≤16（`PLANNING_REQUEST_REQUIREMENT_REFS_MAX_COUNT`）；复用 validatePlanArtifactRefs |
| `constraints` | 约束条目：非空字符串、trim 保留、去重、每条 ≤2000 码点、≤16 条（`PLANNING_REQUEST_CONSTRAINTS_MAX_COUNT`）；省略/null/[] 归一为空数组 |
| `acceptance` | 结构化验收 `{ criteria: string[] }`：≥1 条、≤32 条、每条 ≤2000 码点；复用 validatePlanAcceptance |
| `strategy` | 用户批准的规划策略：`{ approvalMode: 'manual', taskLimit: 1..100 \| null }`；v1 只支持显式人工决策 `manual`；taskLimit 省略/null → null（复用 PLAN_TASKS_MAX_COUNT 上限） |

错误纪律：未知版本、未知字段（含 `expectedRevision` 等 CAS/执行语义字段）、非法结构
均返回 `StorageError(kind='validation')`，details 只含 field/reason/定位键/receivedType，
不回显输入正文。

## 3. 规划候选 payload v1（schemaVersion=1）

规划 Run 内模型经受限工具提交的**不可信输出**（独立封装，与测试候选协议互不混用）。
键白名单：

| 字段 | 规则 |
|---|---|
| `schemaVersion` | 必须为 `1`（`PLANNING_CANDIDATE_SCHEMA_VERSION`） |
| `projectId` / `featureId` / `runId` / `candidateId` | 稳定 ID；绑定发起规划的 Project/Feature、规划 Run 与稳定候选身份 |
| `plan` | **既有业务计划 v1 原样输入**（feature.plan.import/revise 的 v1 输入语义不变）；交给 validateFeaturePlanInput 校验与规范化 |
| `taskVerification` | 定向 verification 意图清单（见 §4）；省略 → 空 |
| `summary` | 审批摘要：非空、trim、≤2000 码点（`PLANNING_CANDIDATE_SUMMARY_MAX_CODE_POINTS`）；供人工决策阅读，不是批准依据 |

业务计划负例全部来自复用的 validateFeaturePlanInput（定位错误不变）：重复 ID
（`tasks[i].id` + 首现位置）、缺依赖/跨 Feature 依赖（`tasks[i].dependsOn[j]` +
`details.taskId/dependsOnTaskId`）、自依赖、重复依赖、环（`details.cycle` 节点路径）。
计划 payload 内的信封/聚合字段（expectedRevision、revision、时间戳、planStatus 等）
仍是未知键（CAS 唯一权威来源是命令信封）。

## 4. verification 引用边界（安全面）

`taskVerification[i]` 键白名单：`taskId` / `checkRefs` / `moduleRefs` / `impactScope`。

- `taskId`：必须是候选计划内任务；同一任务意图不重复；条目按 taskId 排序输出。
- `checkRefs`：受信检查引用，词法 `^[a-z][a-z0-9._-]{0,127}$`（与 task-verification-policy
  的 checkKey 同一形态），≤16（`PLANNING_TASK_CHECK_REFS_MAX_COUNT`）。
- `moduleRefs`：受信模块引用（稳定 ID 词法、≤256 字符），≤16
  （`PLANNING_TASK_MODULE_REFS_MAX_COUNT`）。
- `impactScope`：影响范围，仓库内相对目标词法（复用 verification-candidates 的
  validateCandidateTarget：拒绝绝对路径/`..`/反斜杠/前导 `-`/控制字符等），
  ≤32（`PLANNING_TASK_IMPACT_SCOPE_MAX_COUNT`）。

**模型不得提交执行语义**：`PLANNING_CANDIDATE_FORBIDDEN_EXECUTION_FIELDS` 冻结拒绝清单
——`argv`、`command`、`shell`、`environment`、`env`、`vendor`、`provider`、`model`、
`credentials`、`token`、`secret`、`passed`、`pass`、`approved`。候选携带其中任一字段
（payload 层或意图条目层）均因键白名单之外的未知字段被拒绝；命令/shell/环境/凭据只能
来自用户确认的受信检查定义（task-verification-policy），厂商/模型选择来自配置策略，
通过标志只能由人工决策写入。

存在性边界：未来由编码 Task 创建的测试文件**不要求在规划时已经存在**；impactScope 只做
词法校验。引用的检查/模块是否真实存在，在提交/批准/执行期结合当前 checkPolicyDigest
重核（validatePlanningCandidatePayload 提供可选 knownChecks/knownModules 上下文，上层
注入时未知引用按字段拒绝；未注入时只做词法校验，不假装查过）。

## 5. 身份与摘要区分（四层）

| 摘要 | 领域前缀/来源 | 覆盖语义 | 变化效果 |
|---|---|---|---|
| Artifact `contentHash` | 制品存储（不可变内容） | 候选 Artifact 正文内容 | 正文变化即变化；候选批准不直接绑定它（绑定 candidateDigest） |
| `candidateDigest` | `shiploop:planning-candidate:v1` | 候选全部语义：绑定身份（projectId/featureId/runId/candidateId）+ planDigest + taskVerification + summary | verification、计划内容、摘要或绑定身份任一变化即变化；**批准绑定此摘要** |
| `planDigest` | 既有业务摘要（P03-1） | 计划业务内容（要求/验收/依赖/复杂度/引用） | 只有计划业务内容变化才变化；批准候选不等于批准该摘要之外的执行 |
| `checkPolicyDigest` | `shiploop:feature-plan-check-policy:v1` | 当前适用检查政策内容 | 政策变化使旧候选批准依据失效（check_policy_changed） |
| `inputDigest` | `shiploop:planning-request:v1` | 规划请求语义（绑定实体/需求制品/约束/验收/策略） | 输入身份变化使旧候选批准依据失效（input_changed） |

审批依据评估（`evaluatePlanningCandidateApprovalBasis`，纯比较）：verification
（candidate_changed）→ 输入身份（input_changed）→ 目标计划身份（plan_changed）→
检查政策身份（check_policy_changed）任一变化即失效，原因词汇冻结于
`PLANNING_CANDIDATE_BASIS_REASONS`；全部一致为 basis_intact。

## 6. Run / Task / Runtime 身份

- `Run.purpose=plan`（`PLANNING_RUN_PURPOSE`）：与编码执行 `purpose='execute'`
  （EXECUTION_RUN_PURPOSE）可区分；规划 Run 不进入编码 DAG 调度。
- `Task.kind=planning`（`PLANNING_TASK_KIND`）：规划任务不在交付图中。
- `Runtime identity.purpose=work`（`PLANNING_RUNTIME_IDENTITY_PURPOSE`）：规划 Run 复用
  Work 通道执行（runtime-execution 的 work 身份要求不变），不引入第二套 Runtime。

`candidateId` 是稳定候选身份：在规划启动时生成并随 Run 持久绑定；候选身份封装
（`PlanningCandidateIdentity`）在生成前允许无 Artifact 引用（artifactRef=null），候选
Artifact 发布后补充为身份级制品引用。

## 7. 实施边界（后续 Task 的冻结约束）

1. **单候选**：每个规划 Run 仅发布一个可审批候选；重复 commandId 复用原结果，不重复
   发布。
2. **人工决策**：首版显式人工决策（strategy.approvalMode 恒为 'manual'）；模型不能自批
   通过，通过标志不是候选输入面。
3. **拒绝不重写**：拒绝保留原因并结束，不重写已成功（候选已生成并校验通过）的规划 Run；
   可再次发起新规划。
4. **批准才原子应用**：批准绑定 candidateDigest，在同一短写事务内原子应用计划（复用
   feature.plan.import/revise 既有导入能力），**不自动编码**、不自动创建编码 Run/Batch。
5. **操作身份区分**：既有 `candidate.submit`（WORK_TOOL_OPERATION_SPECS）仍表示测试候选；
   规划提交使用独立且受限的操作身份 `planning.candidate.submit`
   （PLANNING_CANDIDATE_SUBMIT_OPERATION；F-001 冻结常量，F-006 完成工具通道接线：
   有界 JSON 正文入口，载荷不接受 artifactId/文件路径，正文上限
   PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES）。
6. **空草稿首次规划**：首次规划复用空 Task 草稿 Feature 的既有导入能力，不要求先有有效
   交付计划（executable=false 的草稿可被规划）；也不扩展后续 Phase DAG/Batch 功能。
7. **执行期核验**：实际测试目标存在性、路径安全与影响范围核验继续在执行期完成
   （复用 P03-7 verification-candidates 的解析与 recheck），规划时不伪造已核验声明。

## 8. 模块与测试

- 模块：`packages/core/src/ports/planning-candidates.ts`（纯校验与纯摘要）。
- 测试：`test/modules/planning/p05-1-f001-planning-candidate-validation.test.ts`（请求/
  候选/身份封装校验、执行语义字段拒绝、DAG 负例复用定位）、
  `test/modules/planning/p05-1-f001-planning-candidate-digest.test.ts`（摘要规范化稳定性、
  四类摘要区分、业务计划 v1 兼容、测试候选协议不混用、审批依据评估）、
  `test/modules/planning/docs-p05-1-planning-candidate-contract.test.ts`（本文档守护）。
- Task 索引：`test/index/phases/P05/features/P05-1/tasks/F-001.json`（引用完整真实测试
  文件，不按名称过滤）。
