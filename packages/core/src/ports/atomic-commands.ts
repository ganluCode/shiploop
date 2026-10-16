/**
 * F-007 原子命令窄端口。同步事务上下文只含应用数据，不含驱动/HTTP/SDK。
 * 回调不得等待 Promise 或做 Git/文件/网络/能力发现；上下文仅在回调内有效。
 * 实现须以同一 BEGIN IMMEDIATE 包住回执重核、业务 CAS/事件和回执保存，
 * 任意写入异常整组回滚；busy 复用已有有限预算。
 * F-008 起新增 registerProject：项目/绑定/创建事件的原子创建原语。
 * P02-3 / F-007 起新增基线原语（§10 窄存储端口的事务面）：不可变授权插入、
 * 操作生命周期 CAS、检查种子与一次性 CAS 收尾、全局占用与 §9.2 事件追加；
 * Git/进程/文件输出/人审都在事务外，事务内不执行文件流/SDK/Git/网络/长检查。
 */
import type { CommandReceipt } from './commands.js';
import type { ArtifactInputRef } from './artifact-store.js';
import type {
  BaselineAuthorizationRecord,
  BaselineCheckResultRecord,
  BaselineOccupancySnapshot,
  BaselineOperationRecord,
} from './baseline-store.js';
import type {
  BatchBudgetRevisionRecord,
  BatchBudgetRevisionResult,
  ExecutionBatchRecord,
  RunRecord,
} from './execution-store.js';
import type {
  FeaturePlanReplaceResult,
  FeaturePlanSnapshot,
  FeatureRecord,
  PhaseRecord,
  PlanApprovalRecord,
  TaskDependencyRecord,
  TaskApprovalItemInsertResult,
  TaskApprovalItemRecord,
  TaskApprovalItemDecisionInput,
  TaskRecord,
} from './plan-store.js';
import type {
  GlobalSettingsRecord,
  ProjectRecord,
  RepositoryBindingRecord,
  ProjectSettingsRecord,
  ProjectWithRepositoryBindingResult,
} from './state-store.js';

export interface CommandTransaction {
  findReceipt(principalId: string, commandId: string): CommandReceipt | undefined;
  getProject(projectId: string): ProjectRecord;
  /** F-012: binding revision recheck without filesystem I/O. */
  getRepositoryBinding(projectId: string): RepositoryBindingRecord;
  /** 复用 P01 CAS + 单条 metadata_updated 事件，不开启内层事务。 */
  updateProjectMetadata(projectId: string, input: unknown): ProjectRecord;
  /**
   * F-008：项目 + 仓库绑定原子创建（canonicalPath 幂等复用 P01 规则）。
   * 新建（registered）时同事务追加唯一一条 project.registered 创建事件；
   * already_exists 不写事件、不覆盖既有名称/标签。绑定输入由事务外只读
   * 仓库检查产出；注册成功不表示基线健康或执行就绪。
   */
  registerProject(project: unknown, binding: unknown): ProjectWithRepositoryBindingResult;
  /** F-009：事务内读取全局当前配置（项目配置一致性依赖的权威重核）；未配置返回 null。 */
  getGlobalSettingsOrNull(): GlobalSettingsRecord | null;
  /** F-009：事务内读取项目当前配置；未配置返回 null（项目缺失由 getProject 先行把关）。 */
  getProjectSettingsOrNull(projectId: string): ProjectSettingsRecord | null;
  /**
   * F-009：全局配置 insert-only 首建（P01 同一 SQL/校验），新建成功时同事务追加
   * 唯一一条 settings.global_created 创建事件（P01 直接服务首建不写，契约 §15.3）。
   */
  createGlobalSettings(input: unknown): GlobalSettingsRecord;
  /**
   * F-009：全局配置 expectedRevision CAS 更新；与 P01 同一写入路径，同事务写既有
   * settings.global_updated 事件（不重复写）。
   */
  updateGlobalSettings(input: unknown): GlobalSettingsRecord;
  /**
   * F-009：项目配置 insert-only 首建；输入可携带 consistency.globalRevision（由调用方
   * 事务外一致性视图推导），在同一事务内核对（stale_dependency 拒绝）；新建成功时
   * 同事务追加唯一一条 settings.project_created 创建事件。
   */
  createProjectSettings(projectId: string, input: unknown): ProjectSettingsRecord;
  /** F-009：项目配置 CAS 更新 + consistency 核对 + 既有 settings.project_updated 事件。 */
  updateProjectSettings(projectId: string, input: unknown): ProjectSettingsRecord;
  /* ---------------------------------------------------------------- *
   * P02-3 / F-007 基线原语（§10 窄存储端口；同一事务内原子生效）
   * ---------------------------------------------------------------- */
  /** §6.2 不可变授权插入（insert-only；无任何更新原语）。 */
  insertBaselineAuthorization(input: unknown): BaselineAuthorizationRecord;
  /** §10 操作生命周期行插入（初始状态；后续经 updateBaselineOperation CAS）。 */
  insertBaselineOperation(input: unknown): BaselineOperationRecord;
  /** 按规范化计划为操作种子逐项检查行（获准输入快照；初始 not_run/退出码 null）。 */
  insertBaselineCheckResults(operationId: string, plan: unknown): readonly BaselineCheckResultRecord[];
  /** 一次性 CAS 收尾单检查（迟到执行版本/已收尾证据均 conflict）。 */
  finalizeBaselineCheckResult(
    operationId: string,
    checkKey: string,
    input: unknown,
  ): BaselineCheckResultRecord;
  /** 操作 CAS 更新（非终态→任意；终态不可覆盖；迟到版本 conflict）。 */
  updateBaselineOperation(operationId: string, input: unknown): BaselineOperationRecord;
  /** §13 全局占用获取（同持有者幂等；另一在途操作 conflict baseline_in_progress）。 */
  acquireBaselineOccupancy(input: unknown): BaselineOccupancySnapshot;
  /** 占用心跳 + 可恢复进程身份更新（仅持有者）。 */
  heartbeatBaselineOccupancy(
    operationId: string,
    processIdentity?: unknown,
  ): BaselineOccupancySnapshot;
  /** 释放占用（仅持有者；清空持有者/时刻/进程身份）。 */
  releaseBaselineOccupancy(operationId: string): BaselineOccupancySnapshot;
  /** §9.2 基线事件追加（payload 只含受控脱敏键；与公开白名单同形）。 */
  appendBaselineEvent(input: unknown): void;
  /** §13 全局占用只读快照（同事务内重核基线在途/隔离占用；持久行是权威）。 */
  readBaselineOccupancy(): BaselineOccupancySnapshot;
  /* ---------------------------------------------------------------- *
   * P03-1 / F-002 计划结构原语（迁移 v6 四表；同一事务内原子生效）
   *
   * 输入一律 unknown，经 ports/plan-store.ts 校验器后才进入持久化；归属
   * （同项目/同 Feature）在同一事务内核验，环检测在事务内 DFS 复核；
   * Phase/Feature 创建恒为 open/draft(+plan_status=draft)，Task 保留计划
   * 作者稳定 ID 且状态恒为 pending；事件/回执写入由后续命令用例
   * （F-004/F-005）在其自身事务内组合，不在本原语内预支。
   * ---------------------------------------------------------------- */
  /** 创建 open Phase（适配器生成 UUID v4 与 UTC 毫秒；revision=1）。 */
  insertPhase(input: unknown): PhaseRecord;
  /**
   * P03-1 / F-007：纯标签 CAS 编辑（Phase/Feature/Task）。单语句条件 UPDATE
   * 只触达目标实体 labels/revision/updated_at：expectedRevision 为实体自身
   * revision，不匹配 conflict（携带 expected/actual）；目标缺失 not_found、
   * 跨项目 ownership（抛出零写入）；不改计划内容/策略/planDigest/planStatus，
   * 不向父子实体传播。
   */
  updatePlanEntityLabels(input: unknown): PhaseRecord | FeatureRecord | TaskRecord;
  /** 创建 draft Feature（含最小 plan_status=draft、可选 planDigest 与来源引用）。 */
  insertFeature(input: unknown): FeatureRecord;
  /** 创建 pending Task（保存完整验收/引用/complexity/executionConfig 及来源）。 */
  insertTask(input: unknown): TaskRecord;
  /** 插入同 Feature 依赖边（自依赖/重复边/跨 Feature/环均结构化拒绝）。 */
  insertTaskDependency(input: unknown): TaskDependencyRecord;
  /**
   * F-004：计划域脱敏事件追加（phase.created；payload 恒 {created:true}）。由命令
   * 用例在同一事务内与业务行/回执组合（F-002 不预支进插入原语）；F-005 起随
   * 对应功能扩展白名单。
   */
  appendPlanEvent(input: unknown): void;
  /* ---------------------------------------------------------------- *
   * P03-1 / F-005 计划导入事务内重核原语（只读；同一 BEGIN IMMEDIATE 内）
   *
   * 导入用例在提交前以这些原语重核父 Phase（归属/open/CAS）、既有任务身份
   * （重复业务 ID/跨 Feature 依赖解析）与需求-验收引用制品身份（复用
   * ArtifactStore.getArtifactInputRef 同一契约语义：缺失 not_found、跨项目
   * ownership、非 ready/缺内容身份 conflict）；文件完整性 I/O 不在事务内。
   * ---------------------------------------------------------------- */
  /** 读取目标 Phase（同项目；缺失 not_found、跨项目 ownership）。 */
  getPhase(projectId: string, phaseId: string): PhaseRecord;
  /** 读取同项目 ready 制品的有效输入引用（与 ArtifactStore 同一契约语义）。 */
  getArtifactInputRef(projectId: string, artifactId: string): ArtifactInputRef;
  /** 既有任务 → 所属 Feature 的解析（仅返回存在的行；跨 Feature 依赖定位用）。 */
  getTaskFeatureLinks(taskIds: readonly string[]): ReadonlyMap<string, string>;
  /**
   * P03-1 / F-008：修订事务内读取 Feature 计划快照（Feature+全部 Task+全部
   * 边；缺失 not_found、跨项目 ownership 抛出，零写入）。
   */
  getFeaturePlan(projectId: string, featureId: string): FeaturePlanSnapshot;
  /**
   * P03-1 / F-008：实质计划修订整体替换——既有成员按稳定 ID 保留身份与既有
   * 策略副本（不因当前默认配置或 complexity 编辑自动更换 executionConfig），
   * 仅新成员携带创建策略副本；被移除成员与旧边删除，新边插入；Feature 聚合
   * 一次 CAS 一次递增（expectedRevision 不匹配 conflict）；新成员 ID 与库内
   * 任何既有任务冲突 conflict；最终边集合事务内 DFS 复核无环。
   */
  replaceFeaturePlan(input: unknown): FeaturePlanReplaceResult;
  /**
   * P03-2 / F-001：读取目标 Task（同项目；缺失 not_found、跨项目 ownership
   * 抛出，零写入），供策略编辑事务内重核归属/revision 与活动保护目标。
   */
  getTask(projectId: string, taskId: string): TaskRecord;
  blockTaskApproval(input: { readonly projectId: string; readonly taskId: string; readonly expectedRevision: number }): number;
  /** F-007：运行期人审事项与 Task/Feature/Run 状态在同一事务内追加。 */
  insertTaskApprovalItem(input: unknown): TaskApprovalItemInsertResult;
  /** F-007：完成事务重新读取同 Task 的运行期事项。 */
  listTaskApprovalItems(projectId: string, taskId: string): readonly TaskApprovalItemRecord[];
  /** F-008：按事项 revision CAS 写入批准/拒绝/解除阻塞决定；不触碰 Run/Attempt/Runtime。 */
  decideTaskApprovalItem(input: TaskApprovalItemDecisionInput): TaskApprovalItemRecord;
  /**
   * P03-2 / F-001：Task 策略副本 CAS 编辑。单语句条件 UPDATE 只触达目标
   * Task 的 execution_config/config_source/config_source_key/revision/
   * updated_at：expectedRevision 为 Task 自身 revision，不匹配或条件 UPDATE
   * 未命中均 conflict（携带 expected/actual）；目标缺失 not_found、跨项目
   * ownership（抛出零写入）；不改标题/验收/依赖/planDigest/planStatus，
   * 不影响其他 Task。
   */
  updateTaskStrategy(input: unknown): TaskRecord;
  /**
   * P03-2 / F-002：按主体身份查既设计划决策（只读；同一事务内重核「重复竞争
   * 决策」用）。subjectType 冻结 feature_plan（subjectId 即 Feature 稳定 ID）；
   * F-003 起决策身份 = (subjectDigest, checkPolicyDigest) 复合——同一主体同一
   * 身份至多一条决策（DDL 唯一索引兜底），未决策返回 undefined。
   */
  findPlanApproval(
    projectId: string,
    featureId: string,
    subjectDigest: string,
    checkPolicyDigest: string,
  ): PlanApprovalRecord | undefined;
  /**
   * P03-2 / F-003：列出目标 Feature 的全部计划决策记录（含历史；同一事务内
   * 读取，供有效批准核验在写事务内复用同一权威视图）。缺失/跨项目 Feature
   * 由调用方先行 getFeaturePlan 把关；本原语只按 (projectId, featureId) 读取。
   */
  listPlanApprovals(projectId: string, featureId: string): readonly PlanApprovalRecord[];
  /**
   * P03-2 / F-002：插入已决定（approved/rejected）计划决策记录（insert-only；
   * id/revision/时间戳由适配器定值，decisionActor 由命令用例以可信主体
   * principalId 定值，checkPolicyDigest 由命令用例从事务内当前有效配置计算
   * 定值）；目标 Feature 缺失 not_found、跨项目 ownership、同主体同身份已有
   * 决策 conflict（零写入）。
   */
  insertPlanApproval(input: unknown): PlanApprovalRecord;
  /**
   * P03-2 / F-002：Feature 计划审批状态 CAS 更新。单语句条件 UPDATE 只触达
   * 目标 Feature 的 plan_status/revision/updated_at：expectedRevision 为
   * Feature 聚合 revision，不匹配或未命中均 conflict（携带 expected/actual）；
   * 目标缺失 not_found、跨项目 ownership（抛出零写入）；不改计划内容/摘要/
   * 标题/Task，与决策记录/事件/回执同一事务提交。
   */
  updateFeaturePlanStatus(input: unknown): FeatureRecord;
  /* ---------------------------------------------------------------- *
   * P03-3 / F-005 执行域原语（迁移 v9 三表；同一 BEGIN IMMEDIATE 内原子生效）
   *
   * 输入一律 unknown，经 ports/execution-store.ts 校验器后才进入持久化；归属
   * （同项目/同范围）与活动唯一在同一事务内核验，迁移 v9 复合外键/条件唯一
   * 索引/不可变触发器作为防御纵深；快照只保存身份级内容（摘要/版本/引用），
   * 绝不内联制品正文或绝对路径。
   * ---------------------------------------------------------------- */
  /** 创建单 Feature 执行批次（初始 queued、runsCreated ≥1、同 Phase 活动唯一）。 */
  insertExecutionBatch(input: unknown): ExecutionBatchRecord;
  /** 插入批次预算修订行（初始 version=1 随 Batch 同事务落行；插后不可变）。 */
  insertBatchBudgetRevision(input: unknown): BatchBudgetRevisionRecord;
  /**
   * P03-3 / F-009 批次预算显式修订（同一写事务内原子生效）：CAS 于当前
   * budget_revision、仅限活动 Batch、仅增额或延期（携带累计用量的降额防御），
   * 单条件 UPDATE 更新当前预算并追加不可变修订行；任一步失败整组回滚。
   */
  reviseBatchBudget(input: unknown): BatchBudgetRevisionResult;
  /** 读取目标 Batch（同项目；缺失 not_found、跨项目 ownership 抛出，零写入）。 */
  getExecutionBatch(projectId: string, batchId: string): ExecutionBatchRecord;
  /** 同 Batch 同 workKey 的全部 Run（按 dispatchOrdinal 升序；重派发判定输入）。 */
  listExecutionRunsForWorkKey(
    projectId: string,
    batchId: string,
    workKey: string,
  ): readonly RunRecord[];
  /** 同 Feature 当前活动 Run（条件唯一索引同源活动集；无则 null）。 */
  getActiveExecutionRun(projectId: string, featureId: string): RunRecord | null;
  /** 同 Phase 当前活动 Batch（条件唯一索引同源活动集；无则 null）。 */
  getActivePhaseExecutionBatch(projectId: string, phaseId: string): ExecutionBatchRecord | null;
  /** 派发计数原子递增（runs_created+1；仅非终态 Batch 命中，终态 conflict）。 */
  recordExecutionRunDispatch(projectId: string, batchId: string): ExecutionBatchRecord;
  /** 创建执行 Run（派发身份/上限冻结；同 Feature 活动 Run 唯一兜底）。 */
  insertExecutionRun(input: unknown): RunRecord;
  /** 执行域脱敏事件追加（execution.run.dispatched/execution.budget.revised；与公开白名单同形）。 */
  appendExecutionEvent(input: unknown): void;
  /* ---------------------------------------------------------------- *
   * P03-3 / F-006 Task 尝试预算预占与分类记账（迁移 v11；受信 Core 内部原语，
   * 不经命令面暴露；P03-4 在同一事务内接入真实 Attempt 创建）
   * ---------------------------------------------------------------- */
  /**
   * 总 Attempt 预占：同事务校验归属/控制状态/deadline 与三层额度后，一次调用
   * 同时递增 Batch 与 Run 累计计数与 Task 双计数并落幂等身份账本行；同身份重放
   * 返回既有记录；任一层耗尽 conflict budget_exhausted 且零写入。
   */
  reserveTaskAttempt(input: unknown): import('./execution-store.js').TaskAttemptReservationRecord;
  /**
   * 受信 Core 基础设施重分类（单向 code→infrastructure，幂等）：仅退还代码额度；
   * 总 Attempt、已预占 Runtime 启动与绝对时间不退还。
   */
  reclassifyTaskAttemptAsInfrastructure(
    input: unknown,
  ): import('./execution-store.js').TaskAttemptReservationRecord;
  /** 同项目同 Task 同预占身份的账本行（无则 null）。 */
  getTaskAttemptReservation(
    projectId: string,
    taskId: string,
    attemptKey: string,
  ): import('./execution-store.js').TaskAttemptReservationRecord | null;
  /** Task 预算双计数持久读取（剩余额度断言与调度决策输入）。 */
  getTaskExecutionCounters(
    projectId: string,
    taskId: string,
  ): import('./execution-store.js').TaskExecutionCountersRecord;
  /** 读取目标 Run（含累计计数与冻结快照；缺失 not_found、跨项目 ownership）。 */
  getExecutionRun(projectId: string, runId: string): RunRecord;
  /* ---------------------------------------------------------------- *
   * P03-3 / F-007 Runtime 启动额度预占（迁移 v12；受信 Core 内部原语，
   * 不经命令面暴露；SDK 启动前的受信边界）
   * ---------------------------------------------------------------- */
  /**
   * Runtime 启动预占：同事务校验同项目 Batch/Run 归属、有效控制状态与父 Batch
   * 的 maxRuntimeStarts/绝对 deadline 后，一次调用原子递增
   * execution_batches.runtime_starts 并落幂等启动身份账本行；同身份重放返回既有
   * 记录不重复计数；额度耗尽/deadline 到达 conflict budget_exhausted 且零写入；
   * 启动失败保守保留计数（无退额原语）。
   */
  reserveRuntimeStart(input: unknown): import('./execution-store.js').RuntimeStartReservationRecord;
  /** 同项目同 Run 同启动身份的账本行（无则 null；剩余额度由持久计数回答）。 */
  getRuntimeStartReservation(
    projectId: string,
    runId: string,
    startKey: string,
  ): import('./execution-store.js').RuntimeStartReservationRecord | null;
  /** F-008：受信 Core 内部 Run 终态 CAS 与无进展计数的原子幂等结算；不经命令路由暴露。 */
  settleExecutionRunOutcome(input: unknown): import('./execution-store.js').RunOutcomeSettlementRecord;
  /** 同项目同 Run 同结算身份的不可变结果账本（无则 null）。 */
  getRunOutcomeSettlement(
    projectId: string,
    runId: string,
    resultKey: string,
  ): import('./execution-store.js').RunOutcomeSettlementRecord | null;
  saveReceipt(receipt: unknown): void;
}

export interface AtomicCommandStore {
  /** 仅预检时效使用；不能替代事务内的权威重读。 */
  findReceipt(principalId: string, commandId: string): CommandReceipt | undefined;
  /**
   * F-009：配置命令一致性视图的事务外只读来源（全局当前配置快照；未配置返回
   * null）。读取到的 revision 作为 consistency.globalRevision 前置条件随写入
   * 传入，由同一写事务内核对；在写事务内调用是编程错误（事务内请用
   * CommandTransaction.getGlobalSettingsOrNull）。
   */
  getGlobalSettingsOrNull(): GlobalSettingsRecord | null;
  transact<T>(operation: string, submit: (transaction: CommandTransaction) => T): T;
}
