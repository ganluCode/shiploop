# P03-3 执行预览契约（F-004：单 Feature prepare 预览、固定授权范围与完整输入身份）

状态：已实现（F-004 范围：只读预览；start 启动命令/preview_stale 事务重核已在 F-005
落地（见 [p03-3-execution-start-contract.md](p03-3-execution-start-contract.md)）；
预算预占随 F-006/F-007、HostClient/CLI 入口随后续接线任务——F-011/F-012 已落地：
HostClient `previewExecution` 与 `shiploop execution preview`（见
`docs/p03-3-cli-execution-operations.md`））。
权威实现：`packages/core/src/ports/execution-preview.ts`（契约、状态/原因词汇与
previewDigest 纯函数）、`packages/core/src/application/execution-preview.ts`（预览编排）、
`packages/core/src/adapters/sqlite/plan-store.ts`（`readExecutionPreviewView` 一致读视图）、
`packages/core/src/ports/commands.ts` + `application/command-service.ts`（`execution.preview`
命令面）、`packages/core/src/adapters/composition.ts`（组合根装配）、
`packages/host/src/contract/lifecycle.ts`（Host 通用命令路由接线宣告，v5 内增量）。
守护测试：`test/p03-3-execution-preview.test.ts`、`test/commands-contract.test.ts`、
`test/docs-p03-3-execution-preview-contract.test.ts`。

## 1. 命令面与授权

- 操作 `execution.preview`（`COMMAND_OPERATIONS` 白名单；project scope；创建类不携带
  expectedRevision——只读预览不 CAS 任何实体）；能力位 `execution.start`
  （`APP_CAPABILITIES`；与后续 F-005 启动命令共享同一授权面，参照
  baseline.preview/baseline.run 共享 `baseline.run` 的先例）。
- payload 冻结为 `{ featureIds: string[], budget: object }`：`featureIds` 为稳定 ID
  清单（形态上限 16 防无界数组；成员重复 `duplicate_feature_id` 拒绝）；`budget`
  深校验在应用层复用 `ports/execution-budget` 权威校验器（Batch+Run 两层 +
  跨层一致性 + 参考时钟 deadline 检查；失败 `invalid_input` reason=`invalid_budget`
  并携带字段定位）。previewDigest/summary/blocked 等服务端决定字段作为未知键拒绝。
- 授权先于仓库或制品 I/O：能力/scope/预算/范围校验全部通过后才可能触发
  `RepositoryInspector.inspect` 与工作区读取；`blocked` 结果不做仓库 I/O（见 §4 顺序）。
- 幂等：同 commandId 重放复用原回执（同参数）；异参 conflict。预览唯一持久副作用是
  命令回执本身（completed 回执承载预览结果，与 baseline.preview 同一纪律）。

## 2. 范围语义（固定单成员）

- `scope.featureIds` 恰含目标 Feature（与迁移 v9 `execution_batches.scope_snapshot`
  CHECK 的单成员形态同源）。预览**不自动加入**其他 Feature、依赖节点或 Phase 后续
  新增成员：Phase 中新增其他 Feature 不改变既有预览的 scope 与 previewDigest。
- 空范围（`featureIds: []`）→ `no_work`（`empty_scope`），零 I/O、零执行实体；
  多成员（≥2）→ `invalid_input` reason=`multi_feature_scope_unsupported`（本阶段
  不支持多 Feature 跑批，不静默截断）。

## 3. 状态与原因词汇（冻结）

- 状态：`ready` / `no_work` / `blocked`。`runtimeExecution` 恒 `false`：预算授权
  预览不宣称已具备 Runtime 执行能力（不安装依赖、不探测真实模型、不加载未选
  全局资源、不执行仓库脚本）。
- `no_work` 原因：`empty_scope`（空范围）；`no_pending_tasks`（范围内无待执行
  工作）。待执行工作 = Task status ∈ `['pending','failed']`
  （`EXECUTION_PREVIEW_PENDING_WORK_TASK_STATUSES`；failed 属显式返工候选；
  passed/skipped/cancelled 视为无待执行工作）。
- `blocked` 原因（确定性顺序：批准 → 项目 → Phase → 活动 Run（按 id 升序）→
  活动 Batch → 基线占用 → 必需输入（按 artifactId 升序）；全部列出，不静默取舍）：
  - `plan_approval`（reason = P03-2 有效批准核验词汇：not_approved/rejected/
    plan_changed/check_policy_changed/no_plan/no_tasks/approval_state_inconsistent）；
  - `project_not_active`（status 携带当前项目状态）；
  - `phase_not_executable`（status；open 之外均不可执行）；
  - `active_run`（runId/status；活动集与迁移 v9 条件唯一索引同源，含
    paused/interrupted——不是可绕过的终态）；
  - `active_batch_in_phase`（batchId/featureId/status；同 Phase 单活动 Batch 纪律）；
  - `baseline_occupancy`（holderOperationId；在途或停止未确认保留的隔离占用均
    以持有者可见）；
  - `required_input_unavailable`（artifactId + detail：not_found/not_ready/
    content_mismatch——计划声明的 contentHash 与权威索引当前内容不一致）。
- 结构化拒绝（PublicError，不是 blocked 状态）：跨项目 Feature
  `forbidden/ownership_denied`；目标缺失 `not_found/feature_not_found`；非法预算
  `invalid_input/invalid_budget`；有效并发 > 1 `invalid_input/concurrency_not_supported`
  （保存政策 ≠ 执行支持，F-001 并发政策）；仓库绑定缺失 `conflict/binding_missing`；
  repoIdentity 漂移 `conflict/binding_identity_mismatch`（以真实只读检查为准，
  不以绑定行冒充当前仓库）；端口未装配 `unsupported`。

## 4. 编排顺序（授权与纯校验先于 I/O；blocked 不做仓库 I/O）

1. 预算深校验（纯；参考时钟 deadline）→ 非法即拒（零 I/O）；
2. 范围形态（纯）：空 → no_work（零 I/O）；多成员 → 拒；
3. 一致读视图（单一 DEFERRED 读事务）：项目状态、绑定最小面、Phase、Feature、
   全部 Task/依赖边/决策记录、全局与项目当前配置、必需输入解析、同 Feature
   活动 Run、同 Phase 活动 Batch、基线占用（不存在新旧混合状态）；
4. 有效并发核验（mergeEffectiveSettings → resolveEffectiveMaxConcurrentWorks；
   >1 即拒）；
5. 待执行工作判定 → no_work（no_pending_tasks）；
6. 阻塞原因收集（§3 词汇）→ 非空即 blocked（**不做仓库 I/O**）；
7. 仅当无阻塞：绑定身份核验（realpath/repoIdentity 复用 RepositoryInspector 受控
   端口）+ 工作区摘要（复用 BaselineWorkspaceReader：tracked+untracked 受管文件
   确定性摘要，不执行脚本/不安装/不探测模型）；
8. 组装摘要与 previewDigest，返回 ready。

## 5. previewDigest（完整输入身份）

`SHA-256('shiploop:execution-preview:v1\n' + canonical)`（`canonical` 为稳定规范化
JSON，键排序；任务/权限/输入按身份键稳定排序）。成分：

| 成分 | 来源 | 实质变化 |
|---|---|---|
| 需求 | `planDigest`（P03-1 冻结业务摘要；labels 明确排除） | 要求/验收/依赖/引用变化 |
| 代码 | HEAD + 工作区摘要 + 脏标记（受控检查端口） | 提交/工作区内容变化 |
| Task 策略 | 逐 Task `computeExecutionStrategyCopyDigest`（副本内容身份，非 revision） | 策略编辑 |
| 检查政策 | `computeFeatureCheckPolicyDigest`（当前有效 verification 段） | 政策内容变化 |
| 权限 | 逐 Task `computeExecutionPermissionsDigest`（可信装配读取器） | 授权面变化 |
| 必需输入 | Feature sourceRefs + Task requirementsRefs 的权威索引解析身份（artifactId+version+contentHash） | 制品内容/版本变化 |
| 预算 | Batch+Run 两层提案 | 预算调整 |

纯标签编辑与默认 modelMap 更新不改变 previewDigest（与 P03-2 逐身份同一纪律；
策略按副本使用不重读路由）。摘要不含时间成分：相同输入跨请求恒一致；
`generatedAtUtcMs` 独立返回。

## 6. 结果形态与边界

- 结果 `{schemaVersion:1, projectId, scope:{featureIds}, status, noWorkReason,
  blocked[], previewDigest|null, summary|null, runtimeExecution:false,
  generatedAtUtcMs}`；ready 时 summary 携带批准复合身份（planDigest+
  checkPolicyDigest+decisionId）、计划摘要、代码身份、逐 Task 策略/权限摘要、
  必需输入解析身份、预算与并发政策；no_work/blocked 时 previewDigest 与 summary
  为 null（不可作为启动授权依据）。
- 结果内嵌有界（≤ RECEIPT_RESULT_MAX_BYTES=16 KiB，超限 `preview_result_too_large`
  拒绝，不截断冒充）；正文/凭据/绝对路径永不出现（错误与结果只含身份键、摘要、
  受控原因与有界计数）。
- 预览不创建 Batch/Run/Attempt、不扣预算、不写业务事件（回执除外）、不修改任何
  计划实体行（Feature/Task revision 不变）；「预览不是批准记录或永久占用，不保证
  稍后仍可运行」——启动事务（F-005）重核全部前置条件与预览身份，实质变化
  返回 preview_stale。
- 权限面沿用 P03-2 生产缺省空集边界宣告（TRUSTED_PROJECT_PERMISSIONS_READER）；
  运行时授权面随后续阶段引入时替换为真实权威读取并保持同一身份纪律。

## 7. 与设计文档的对齐登记

- core-design/08 §9（跑批前的执行预览）：确定性计算、不调用模型决定调度、返回
  预览内容与摘要、不预先创建 Run/Attempt、空范围 no_work 不建空批次、范围外新增
  不吸收——F-004 按单 Feature 子集实现；`prepareExecution` 的 Phase 级范围、
  候选顺序与已通过可复用项展示属 P05 多 Feature 扩展，不在本阶段。
- core-design/04 §6（ExecutionController/单 Feature）：范围恰一个 Feature不自动
  扩大；活动 Run/活动 Batch 唯一由迁移 v9 条件唯一索引承担，预览提前以可理解
  原因呈现（启动仍以 DDL/事务为权威）。
- core-design/09 T31（preview_stale/no_work 不静默扩大范围）：no_work 词汇落地；
  preview_stale 判定已随 F-005 启动事务实现（本任务提供身份基线 previewDigest）。
- 与 F-005 的接续：同 Feature 存在活动 Batch（含重试窗口中的父 Batch）时新授权
  预览必报 active_batch_in_phase blocked；同父 Batch 显式重试不重算预览，工作
  身份由 workKey 绑定（见启动契约 §1/§4）。

## 8. 验证记录（F-004，attempt 1）

- `test/p03-3-execution-preview.test.ts`（38 用例，真实临时 Git/SQLite/制品资源）：
  ready 预览与固定范围、no_work（空范围/无待执行工作/failed 属待执行）、阻塞原因
  逐项与多原因并列、结构化拒绝矩阵（跨项目/多成员/非法预算五类/并发>1/绑定漂移/
  绑定缺失/端口未装配）、授权先于仓库 I/O（inspector 零调用观测）、身份变化矩阵
  （策略/需求修订+重批/检查政策+重批/预算/权限/代码提交改变摘要；纯标签与
  modelMap 不变）、预览边界（不执行脚本、git 状态干净、结果有界脱敏）、组合根
  装配与命令面接线、幂等重放与异参 conflict。
- 受影响回归：commands-contract（能力/操作白名单冻结面）、host-lifecycle-contract
  （Host 接线宣告与 Core 白名单一致性）、docs 守护、core-assembly/typecheck/build/
  boundaries 详见 progress.md 与 tool-logs。
