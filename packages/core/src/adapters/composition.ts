/**
 * P01-3 / F-012 Core 装配公共入口（adapters 层组合根：把 SQLite/文件适配器接到
 * ports，并装配 application 用例；契约区不反向依赖本模块）。
 *
 * 设计依据：docs/p01-3-application-contract.md §7.4（组合根与公共入口）与
 * docs/p01-3-handoff.md §3（P01-3 需在 Core 内确定受控装配入口，例如明确的子路径
 * 导出，并保持 domain/application/ports/公共入口不反向依赖 adapters）；本模块经
 * `shiploop-core` 包清单的 `./assembly` 子路径导出，是 Node/Host 侧取得已装配
 * 端口与应用服务的唯一受控入口。
 *
 * 不变量：
 * - import 本模块无副作用：不打开数据库、不读文件系统、不读 os.homedir()、
 *   不加载凭据；只有调用 openCoreApplication 才接触受控数据根；
 * - 装配前完成全部选项运行时校验（含能力目录形态）：非法选项在任何 I/O 之前
 *   fail-closed（StorageError kind='validation'）；
 * - 数据根只由「显式 dataRoot」或「注入的 macOS 用户目录（默认 os.homedir()）」
 *   二选一解析；只创建数据根本身（mode 0700），不隐式创建项目/Run/Session 目录，
 *   不迁移源仓库；
 * - 打开状态库后先执行版本化迁移，再装配 StateStore/ArtifactStore/PathService；
 *   PathService 的项目存在性核验端口绑定到同一 StateStore（受权定位 fail-closed）；
 * - 返回面只含窄端口与用例接口（不暴露 SqliteStorageSession、better-sqlite3、
 *   Drizzle、Pi SDK 或 HTTP 类型）；close() 关闭状态库会话且幂等；
 * - Runtime 仅由可信函数显式注入；默认注册表为空，配置合法不代表可运行。
 *   使用 Runtime 时须先 await workExecution.close() 核验停止，再 close() 状态库。
 */
import { assembleWorkExecution, type WorkRuntimeFactory, type WorkExecution } from './work-execution.js';
import { createWorkStartupRecovery } from '../application/work-startup-recovery.js';
import { createPlanningStartupRecovery } from '../application/planning-recovery.js';
import { PublicError } from '../ports/commands.js';
import { createSqliteWorkStartupRecoveryStore } from './sqlite/work-startup-recovery.js';
import { createSqlitePlanningRecoveryStore } from './sqlite/planning-recovery.js';
import { createSqliteWorkRecoveryReconciliationStore } from './sqlite/work-recovery-reconciliation.js';
import { createWorkRecoveryReconciler } from '../application/work-recovery-reconciliation.js';
import { createWorkRecoveryContinuationService } from '../application/work-recovery-continuation.js';
import type { WorkRecoveryContinuationService } from '../application/work-recovery-continuation.js';
import { createRecoveryGitReader } from './fs/recovery-git-reader.js';
import { createGitCommitDriver } from './fs/git-commit-driver.js';
export type { WorkRuntimeFactory, WorkRuntimeContext, WorkFailureRoutingAssembly } from './work-execution.js';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { createConfigurationService } from '../application/configuration-service.js';
import type { ConfigurationService } from '../application/configuration-service.js';
import { createCommandReceiptsService } from '../application/command-receipts-service.js';
import type { CommandReceiptsService } from '../application/command-receipts-service.js';
import { createCommandService } from '../application/command-service.js';
import { createExecutionStopControl } from '../application/execution-stop-control.js';
import { createVerificationStopControl } from '../application/verification-stop-control.js';
import type { VerificationStopControl } from '../ports/verification-stop.js';
import type { ExecutionStopControlPort } from '../ports/execution-stop.js';
import type { RuntimeFallbackSwitchService } from '../ports/runtime-fallback-switch.js';
import type { BatchDeliveryFactory } from '../application/batch-delivery-commands.js';
export type { BatchDeliveryFactory, BatchDeliveryDependencies } from '../application/batch-delivery-commands.js';
import type { FeatureDeliveryFactory } from '../application/feature-delivery-commands.js';
export type { FeatureDeliveryFactory, FeatureDeliveryDependencies } from '../application/feature-delivery-commands.js';
import { assertVerificationReuseIdentity, validateTaskVerificationContinue } from '../application/task-verification-continue.js';
import type { CommandService } from '../application/command-service.js';
import { createBaselineExecutionService } from '../application/baseline-execution.js';
import type { BaselineExecutionService } from '../application/baseline-execution.js';
import { createBaselineQueryService } from '../application/baseline-query-service.js';
import type { BaselineQueryService } from '../application/baseline-query-service.js';
import { createBaselineService } from '../application/baseline-service.js';
import type { BaselineService } from '../application/baseline-service.js';
import { createOnboardingService } from '../application/onboarding-service.js';
import type { OnboardingService } from '../application/onboarding-service.js';
import { createProjectProfileService } from '../application/project-profile-service.js';
import type { ProjectProfileService } from '../application/project-profile-service.js';
import { createProjectService } from '../application/project-service.js';
import type { ProjectService } from '../application/project-service.js';
import { createSqliteBatchDeliveryQueryStore } from './sqlite/batch-delivery-query-store.js';
import { createQueryService } from '../application/query-service.js';
import type { QueryService } from '../application/query-service.js';
import { createKnowledgeQueryService } from '../application/knowledge-query-service.js';
import type { KnowledgeQueryService } from '../application/knowledge-query-service.js';
import { createPlanningQueryService } from '../application/planning-query.js';
import type { PlanningQueryService } from '../application/planning-query.js';
import { createExecutionInputService } from '../application/execution-input.js';
import { createContextBuilder } from '../application/context-build.js';
import type { ContextBudget } from '../application/context-build.js';
import { createArtifactPublisher } from '../application/artifact-publish.js';
import { createArtifactVerifier } from '../application/artifact-verify.js';
import { createWorkToolChannel } from '../application/work-tool-channel.js';
import { createPlanningCandidateDecisionPort } from '../application/planning-candidate-decision.js';
import { PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES } from '../ports/planning-candidates.js';
import type { WorkToolChannelDeps } from '../application/work-tool-channel.js';
import { createVerificationCandidateValidator } from '../application/verification-candidates.js';
import { createTestTargetResolver } from './fs/verification-target-resolver.js';
import { createWorkWorkspaceAuthority } from './fs/work-workspace.js';
import { createWorkspaceInspector } from './fs/workspace-inspector.js';
import { createFeatureWorktreePreparer } from './fs/feature-worktree-preparer.js';
import { createFeatureWorktreeCleaner } from './fs/feature-worktree-cleaner.js';
import { createFeatureWorktreeDiscarder } from './fs/feature-worktree-discarder.js';
import { createSqliteWorkResourceAccess } from './sqlite/work-resources.js';
import { createSqliteRuntimeFallbackSwitchService } from './sqlite/runtime-fallback-switch.js';
import { createSqliteAttemptAccess } from './sqlite/attempt-store.js';
import { createSqliteAttemptLifecycleStore } from './sqlite/attempt-lifecycle-store.js';
import { createSqliteTaskCommitter } from './sqlite/task-commit.js';
import { createSqliteTaskClaimStore } from './sqlite/task-claim-store.js';
import { createSqliteWorkspacePreparationStore } from './sqlite/workspace-preparation.js';
import { createSqliteWorkspaceRetentionStore } from './sqlite/workspace-retention.js';
import { createSqliteWorkspaceCleanerStore } from './sqlite/workspace-cleaner.js';
import { createSqliteWorkspaceDiscardStore } from './sqlite/workspace-discard.js';
import { createSqliteWorkspaceDiscardPreviewStore } from './sqlite/workspace-discard.js';
import { createSqliteWorkspaceAccess } from './sqlite/workspace.js';
import { createWorkResourceStopVerifier } from '../application/work-resource-stop.js';
import { createTaskVerificationCompletionService } from '../application/task-verification-completion.js';
import type { TaskVerificationCompletionService } from '../application/task-verification-completion.js';
import { createWorkspacePreparationService } from '../application/workspace-preparation.js';
import { createWorkspaceRetentionService } from '../application/workspace-retention.js';
import { createWorkspaceCleanerService } from '../application/workspace-cleaner.js';
import { createWorkspaceDiscardService } from '../application/workspace-discard.js';
import type { WorkspaceDiscardService } from '../application/workspace-discard.js';
import type { PreparationWorkspaceAuthority } from '../ports/workspace-preparation.js';
import type { WorkspacePreparationInput } from '../ports/workspace-preparation.js';
import { validateWorkspaceRetentionInput } from '../ports/workspace-retention.js';
import { validateWorkspaceCleanerInput } from '../ports/workspace-cleaner.js';
import {
  validateWorkspaceDiscardConfirmInput,
  validateWorkspaceDiscardPreviewInput,
} from '../ports/workspace-discard.js';
import type { WorkResourceAccess } from '../ports/work-resources.js';
import type { TaskClaimStore } from '../ports/task-claim.js';
import type { CommandProcessIdentity } from '../ports/command-process.js';
import type { WorkspaceOperationCommit } from '../ports/workspace.js';
import {
  DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET,
  DEFAULT_EXECUTION_INPUT_PREPARE_LIMITS,
  createExecutionInputPrepareService,
} from '../application/execution-input-prepare.js';
import type { ExecutionInputPreparePort } from '../application/execution-input-prepare.js';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../ports/execution-input-prepare.js';
import { createExecutionPreviewService } from '../application/execution-preview.js';
import type { ExecutionPreviewPort } from '../application/execution-preview.js';
import { createExecutionStartService } from '../application/execution-start.js';
import type { ExecutionStartPort } from '../ports/execution-start.js';
import { createPlanningStartService } from '../application/planning-start.js';
import type { PlanningStartPort } from '../ports/planning-start.js';
import { createPlanningInputPrepareService } from '../application/planning-input-prepare.js';
import type { PlanningInputPreparePort } from '../application/planning-input-prepare.js';
import { DEFAULT_PLANNING_INPUT_PREPARE_LIMITS } from '../application/planning-input-prepare.js';
import { createSqlitePlanningContextStore } from './sqlite/planning-context-store.js';
import { createExecutionResumeService } from '../application/execution-resume.js';
import type { ExecutionResumePort } from '../ports/execution-resume.js';
import { createFinalizationRetryPlanner } from '../application/finalization-retry.js';
import { createFinalizationRetryExecutionService } from '../application/finalization-retry-execution.js';
import type { FinalizationRetryExecutionPort } from '../ports/finalization-retry.js';
import type { FinalizationExecutionPort } from '../ports/finalization-execution.js';
import type { FinalizationCompletionPort } from '../ports/finalization-completion.js';
import { createSqliteExecutionResumeFactsReader } from './sqlite/execution-resume.js';
import { createSqliteTaskDagStore } from './sqlite/task-dag-store.js';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { BaselineEnvironmentDirectory } from '../ports/baseline.js';
import type { CommandReceiptStore } from '../ports/command-receipts.js';
import { StorageError } from '../ports/errors.js';
import { PathResolutionError, computeDataRootIdentity, deriveDefaultDataRoot } from '../ports/path-service.js';
import type { PathService } from '../ports/path-service.js';
import type { RepositoryInspector } from '../ports/repository-inspector.js';
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import { createRuntimeRecoveryService } from '../application/runtime-recovery.js';
import type { RuntimeRecoveryService } from '../application/runtime-recovery.js';
import { createStaticRuntimeRecoveryCatalog } from '../ports/runtime-recovery-catalog.js';
import type { RuntimeRecoveryCatalog } from '../ports/runtime-recovery-catalog.js';
import type { RuntimeRecoveryCapabilities } from '../ports/runtime-recovery.js';
import type { RuntimeRecoverySourceReader } from '../ports/runtime-recovery-source.js';
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import type { StateStore } from '../ports/state-store.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requirePlainObject,
  validateStableId,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import { createArtifactFileStore } from './fs/artifact-files.js';
import { createBaselinePartialOutputReader } from './fs/baseline-partial-output.js';
import { createBaselineRepositoryGuard } from './fs/baseline-repository-guard.js';
import { createGitPublicMetadataLock } from './fs/git-public-metadata-lock.js';
import { createCommandProcessAdapter } from './process/command-process.js';
import { createBaselineWorkspaceReader } from './fs/baseline-workspace.js';
import { createPathService } from './fs/path-service.js';
import { createRepositoryInspector } from './fs/repository-inspector.js';
import type { RepositoryInspectorOptions } from './fs/repository-inspector.js';
import { createSqliteAtomicCommandStore } from './sqlite/atomic-commands.js';
import { createSqliteArtifactStore } from './sqlite/artifact-store.js';
import { createSqliteBaselineStore } from './sqlite/baseline-store.js';
import type { BaselineStore } from '../ports/baseline-store.js';
import { createSqliteVerificationStore } from './sqlite/verification-store.js';
import type { VerificationStore } from '../ports/verification-store.js';
import { createSqliteCommandReceiptStore } from './sqlite/command-receipts.js';
import { migrateSqliteStorage } from './sqlite/migrator.js';
import { createSqliteQueryStore } from './sqlite/query-store.js';
import { createSqlitePlanAccess } from './sqlite/plan-store.js';
import { openSqliteStorageSession } from './sqlite/session.js';
import { createSqliteStateStore } from './sqlite/state-store.js';
import { createSqliteProjectProfileStore } from './sqlite/project-profile-store.js';
import { createSqliteDocumentStore } from './sqlite/document-store.js';
import { createInputSourceFileReader } from './fs/input-source-files.js';
import { createSqliteIntegrationPlanStore } from './sqlite/integration-plan-store.js';
import { createIntegrationPlanGenerationService } from '../application/integration-plan-generation.js';
import type {
  IntegrationBatchApprovalReader,
  IntegrationPlanGenerationService,
  IntegrationPredecessorEvidenceReader,
} from '../application/integration-plan-generation.js';
import { createGitAgentRepairService, type GitAgentRepairService } from '../application/git-agent-repair.js';
import { createSqliteGitAgentRepairStore } from './sqlite/git-agent-repair-store.js';
import { createSqliteGitAgentRepairQueryStore } from './sqlite/git-agent-repair-query-store.js';
import { createIntegrationPlanControlService } from '../application/integration-plan-control.js';
import type { IntegrationPlanControlService } from '../application/integration-plan-control.js';
import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import type { IntegrationPlanAccess } from '../ports/integration-plan-store.js';

// F-009 standalone process adapter; baseline execution orchestration is not assembled yet.
export { createCommandProcessAdapter } from './process/command-process.js';

const OPERATION = 'CoreApplication.open';

/** 装配选项（边界为 unknown，经运行时校验；非法选项在任何 I/O 之前拒绝）。 */
export interface CoreApplicationOptions {
  /** Host sets this under the writer lock, before any trusted adapter factory runs. */
  readonly workStartupRecoveryRequired?: boolean;
  /** Trusted static adapter assembly; never a settings/argv/env field. */
  readonly workRuntimeFactory?: WorkRuntimeFactory;
  /** Trusted delivery adapters; absent until explicitly assembled. */
  readonly batchDeliveryFactory?: BatchDeliveryFactory;
  readonly featureDeliveryFactory?: FeatureDeliveryFactory;
  /** Trusted integration facts; absent means plan generation remains unavailable. */
  readonly integrationPlanFactory?: (deps: {
    readonly atomicStore: AtomicCommandStore;
    readonly planStore: IntegrationPlanAccess;
  }) => {
    readonly batches: IntegrationBatchApprovalReader;
    readonly predecessors: IntegrationPredecessorEvidenceReader;
  };
  /** P03-9 / F-011：受信 finalization-only Run 重验执行（未装配时调度保留 capability gap）。 */
  readonly finalizationExecution?: FinalizationExecutionPort;
  /** P03-9 / F-012：重验后最终审批/提交/完成消费者（不启动 Runtime）。 */
  readonly finalizationCompletion?: FinalizationCompletionPort;
  /**
   * P05-1 / F-007：planning 认领回执消费者受信覆盖（回执已在独立短事务提交后
   * 调用）。缺省时组合根在装配了 Runtime 工厂的情况下接入内部真实执行（复用
   * 标准 ExecutionService/受监督 Runner/Session/Recorder）；两者皆缺时调度器
   * 保留 planning_consumer capability gap，planning Run 保持 queued 且可查询原因。
   */
  readonly planningExecution?: {
    consumePlanningClaim(receipt: import('../ports/task-claim.js').TaskClaimReceipt,
      ref: { readonly projectId: string; readonly runId: string }): Promise<void>;
  };
  /** 显式授权数据根（绝对路径）；与 userHomeDir 二选一。 */
  readonly dataRoot?: string;
  /** 注入的 macOS 用户目录；用于解析默认根，与 dataRoot 二选一。 */
  readonly userHomeDir?: string;
  /** 可信装配注入的只读能力目录（F-008）；空目录 fail-closed。 */
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
  /** Optional trusted recovery evidence; no Runtime implementation is installed. */
  readonly runtimeRecoveryDescriptors?: readonly RuntimeRecoveryCapabilities[];
  /** Optional internal authority/source lookup; absence refuses source recovery. */
  readonly runtimeRecoverySources?: RuntimeRecoverySourceReader;
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性时间。 */
  readonly nowUtcMs?: () => number;
  /** 仓库检查端口；未提供时按 repositoryInspectorOptions 装配真实 Git 实现。 */
  readonly repositoryInspector?: RepositoryInspector;
  /** 真实 Git 检查适配器选项（仅在未提供 repositoryInspector 时生效）。 */
  readonly repositoryInspectorOptions?: RepositoryInspectorOptions;
  /**
   * P02-3 / F-008：环境允许列表目录（§6.4 可信装配注入；仅变量名，无值）。
   * 缺席时使用空目录（fail-closed：任何 environmentRef 都是未获准引用）。
   */
  readonly baselineEnvironmentDirectory?: BaselineEnvironmentDirectory;
  /**
   * P03-2 / F-006：执行输入采集的获准源文件根白名单（rootId → 授权根绝对
   * 路径；可信装配注入，缺省空名单——任何 file 来源都是未获准引用
   * unknown_root，制品来源不受影响）。预算面使用 Core 冻结缺省
   * （DEFAULT_EXECUTION_INPUT_PREPARE_LIMITS + F-004/F-005 限制契约）。
   */
  readonly inputSourceRoots?: Readonly<Record<string, string>>;
  /** 状态库单次 busy 等待预算（毫秒）；默认沿用适配器有限预算。 */
  readonly busyTimeoutMs?: number;
  /** 状态库 busy 重试次数（含首次）；默认沿用适配器有限预算。 */
  readonly busyRetryAttempts?: number;
}

/**
 * 已装配的 Core 应用：窄端口 + 应用用例。不包含状态库会话/驱动句柄；
 * 生命周期由 close() 管理，重复调用安全。
 */
export interface CoreApplication {
  /** Trusted live authority only; same SQLite session for authorization, fences and receipts. */
  createWorkToolChannel(authority: Pick<WorkToolChannelDeps, 'currentBinding' | 'candidateContext'>): ReturnType<typeof createWorkToolChannel>;
  readonly workExecution: WorkExecution;
  /** 已 realpath 固定的授权数据根。 */
  readonly dataRoot: string;
  readonly pathService: PathService;
  readonly stateStore: StateStore;
  readonly artifactStore: ArtifactStore;
  readonly artifactFileStore: ArtifactFileStore;
  readonly repositoryInspector: RepositoryInspector;
  /** F-003：跨数据根、跨 Host 共用的 Git common-dir 短操作锁。 */
  readonly gitPublicMetadataLock: GitPublicMetadataLock;
  readonly projectService: ProjectService;
  readonly configurationService: ConfigurationService;
  /** P02-2 / F-006：持久命令回执窄端口与授权回执/结果读取服务。 */
  readonly commandReceiptStore: CommandReceiptStore;
  /** F-007：幂等原子命令（当前仅 metadata CAS；注册/配置后续接入）。 */
  readonly commandService: CommandService;
  /**
   * P03-2 / F-006：执行输入制品组准备端口（事务外准备 + 同步权限读取；
   * 命令面经 commandService 的 execution.input.prepare 接线同一能力）。
   */
  readonly executionInputPrepare: ExecutionInputPreparePort;
  /**
   * P03-3 / F-004：单 Feature 执行 prepare 预览端口（只读预览：固定单成员
   * 范围/完整输入身份 previewDigest/no_work 与阻塞原因；命令面经
   * commandService 的 execution.preview 接线同一能力）。
   */
  readonly executionPreview: ExecutionPreviewPort;
  /**
   * P03-3 / F-005：显式执行启动端口（事务外准备 + 短写事务内重核与原子提交；
   * 命令面经 commandService 的 execution.start 接线同一能力；提交后唤醒与
   * Scheduler/Runtime 装配属后续任务——本阶段 Run 保留 queued +
   * scheduler_not_assembled 可查询原因，runtime_starts 恒为 0）。
   */
  readonly runtimeRecovery: RuntimeRecoveryService;
  /** Trusted capability evidence catalog used by Work input binding decisions. */
  readonly runtimeRecoveryCatalog: RuntimeRecoveryCatalog;
  /** F-003：同 Task continuation 的不可变规划服务；只发布记录，不创建 Attempt/Runtime。 */
  readonly workRecoveryContinuation: WorkRecoveryContinuationService;
  readonly executionStart: ExecutionStartPort;
  /** P05-1 / F-003：一次性规划启动（事务外请求/预算校验 + 事务内原子提交；不启动模型）。 */
  readonly planningStart: PlanningStartPort;
  /**
   * P05-1 / F-004：规划输入准备（事务外视图捕获/采集/组装/发布 + 启动前
   * 事务外重核；无业务计划也能生成完整规划输入；供 planning Run 派发/
   * 认领（F-005+）消费，不创建执行实体、不启动 Runtime）。
   */
  readonly planningInputPrepare: PlanningInputPreparePort;
  /** P03-9 / F-008：显式工作流 resume（重新授权/现场核验/解除暂停；不启动 Runtime）。 */
  readonly executionResume: ExecutionResumePort;
  /** P03-9 / F-010：finalization-only retryFinal（新建受限 Run，不启动 Runtime）。 */
  readonly finalizationRetry: FinalizationRetryExecutionPort;
  readonly commandReceiptsService: CommandReceiptsService;
  /** F-010：授权查询/一致读视图快照水位/分页事件读取（§7/§8/§9.3）。 */
  readonly queryService: QueryService;
  /** F-003：项目隔离的有界文档关键词/身份检索与受控正文读取。 */
  readonly knowledgeQueryService: KnowledgeQueryService;
  /** P05-6: generation is exposed only with trusted Batch/delivery facts. */
  readonly integrationPlanGeneration?: IntegrationPlanGenerationService;
  /** P05-6: control and successor gating use the authoritative plan store. */
  readonly integrationPlanControl: IntegrationPlanControlService;
  /** Trusted Core repair orchestration; never exposed as a raw Runtime tool. */
  readonly gitAgentRepair: GitAgentRepairService;
  /**
   * P05-1 / F-011：规划上下文/候选只读授权查询（planning.contexts.list /
   * planning.context.get / planning.candidate.get；零写入、零事件、零恢复，
   * 候选正文经受管 Artifact 完整性核验读取）。
   */
  readonly planningQueryService: PlanningQueryService;
  /** P02-3 / F-004：静态 inspect 与注册/健康分离的 overview 用例（§7.2/§7.3）。 */
  readonly onboardingService: OnboardingService;
  /** P06-1：项目画像确认/版本化/CAS/模块匹配应用服务。 */
  readonly projectProfileService: ProjectProfileService;
  /** P02-3 / F-007：基线窄存储读取端口（迁移 v4 四表；写经原子命令事务）。 */
  readonly baselineStore: BaselineStore;
  /** P03-7 / F-005：Task Node 检查批次与逐项结果窄存储。 */
  readonly verificationStore: VerificationStore;
  /** P03-9 / F-003：Verifier 停止登记（可信验证装配按 Run/Batch/Attempt/operation 使用）。 */
  readonly verificationStops: VerificationStopControl;
  /** P03-9 / F-003：取消提交后的停止控制（Runtime/Verifier 共用同一有界停止端口）。 */
  readonly executionStopControl: ExecutionStopControlPort;
  /** P03-7 / F-012：受信 Task 验证收尾入口（只读重建机器观察、代码现场引用与
   * 预算结算的既有放行/返工状态机；不运行检查、不启动 Runtime）。 */
  readonly taskVerificationCompletion: TaskVerificationCompletionService;
  /** P02-3 / F-008：基线预览与明确授权用例（§6；经 commandService 提交）。 */
  readonly baselineService: BaselineService;
  /** F-012: explicit execution entry; Host routing is wired in F-014. */
  readonly baselineExecutionService: BaselineExecutionService;
  /** P02-3 / F-014：baselines.list / baselines.get / artifacts.get 只读查询（§7.4-§7.6）。 */
  readonly baselineQueryService: BaselineQueryService;
  /** P03-5 / F-011：工作区资源门禁（P03-4 durable 工作资源 + 可信停止核验）。 */
  readonly workResources: WorkResourceAccess;
  /** P03-5 / F-011：workspace 授权权标颁发（授权根=数据根 + 登记绑定规范源路径）。 */
  readonly workWorkspaceAuthority: PreparationWorkspaceAuthority;
  /** P03-5 / F-011：Task 认领窄端口（P03-4 认领契约；调度消费者装配属后续任务）。 */
  readonly taskClaims: TaskClaimStore;
  /** P04-3：停止核验后的备用 Runtime 原子切换（创建新 Attempt，不伪装代码返工）。 */
  readonly runtimeFallbackSwitch: RuntimeFallbackSwitchService;
  /** P03-5 / F-011：workspace 准备服务（F-005/F-006；按调用构造受界检查器/预备器）。 */
  readonly workspacePreparation: {
    prepare(raw: unknown): Promise<WorkspaceOperationCommit>;
  };
  /** P03-5 / F-011：失败现场保留服务（F-007；无文件系统变更，可信停止核验接线）。 */
  readonly workspaceRetention: {
    retain(raw: unknown): Promise<WorkspaceOperationCommit>;
  };
  /** P03-5 / F-011：受控清理执行（F-009；按调用构造受界检查器/清理器）。 */
  readonly workspaceCleaner: {
    clean(raw: unknown): Promise<WorkspaceOperationCommit>;
  };
  /** P03-5 / F-011：人工丢弃预览/确认（F-010；命令面经 commandService 接线同一能力）。 */
  readonly workspaceDiscard: WorkspaceDiscardService;
  /** 关闭状态库会话并释放文件句柄；幂等。 */
  close(): void;
}

const ALLOWED_OPTION_KEYS = [
  'workStartupRecoveryRequired',
  'workRuntimeFactory',
  'batchDeliveryFactory',
  'featureDeliveryFactory',
  'integrationPlanFactory',
  'finalizationExecution',
  'finalizationCompletion',
  'planningExecution',
  'dataRoot',
  'userHomeDir',
  'capabilityCatalog',
  'runtimeRecoveryDescriptors',
  'runtimeRecoverySources',
  'nowUtcMs',
  'repositoryInspector',
  'repositoryInspectorOptions',
  'baselineEnvironmentDirectory',
  'inputSourceRoots',
  'busyTimeoutMs',
  'busyRetryAttempts',
] as const;

function requireCapabilityCatalog(
  value: unknown,
  context: ValidationContext,
): RuntimeCapabilityCatalog {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { resolve?: unknown }).resolve !== 'function'
  ) {
    throw validationError(
      context,
      'capabilityCatalog',
      '必须提供 RuntimeCapabilityCatalog 端口实现（可信装配注入的只读能力目录）',
    );
  }
  return value as RuntimeCapabilityCatalog;
}

function requireAbsoluteRoot(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(context, field, '必须是非空绝对路径字符串');
  }
  if (value.includes('\0')) {
    throw validationError(context, field, '不允许包含 NUL 字节');
  }
  if (!isAbsolute(value)) {
    throw validationError(context, field, '必须是 POSIX 绝对路径');
  }
  return value;
}

/** 解析候选数据根（不做任何 I/O）：显式根或由注入用户目录推导的默认根。 */
function resolveRootCandidate(options: Record<string, unknown>, context: ValidationContext): string {
  const dataRoot = options.dataRoot;
  const userHomeDir = options.userHomeDir;
  if (dataRoot !== undefined && userHomeDir !== undefined) {
    throw validationError(context, 'dataRoot', 'dataRoot 与 userHomeDir 只能提供其一（根来源歧义）');
  }
  if (dataRoot !== undefined) {
    return requireAbsoluteRoot(dataRoot, context, 'dataRoot');
  }
  const home =
    userHomeDir === undefined ? homedir() : requireAbsoluteRoot(userHomeDir, context, 'userHomeDir');
  return deriveDefaultDataRoot(home, OPERATION);
}

/** 只创建数据根本身（mode 0700）；不创建任何项目/Run/Session 目录。 */
function ensureDataRootDirectory(root: string): void {
  if (existsSync(root)) {
    return;
  }
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new PathResolutionError('io', OPERATION, `${OPERATION}: 无法创建数据根目录`, {
      details: { reason: 'data_root_create_failed' },
      cause: error,
    });
  }
}

/**
 * 打开并装配 Core 应用：
 * 1. 选项运行时校验（能力目录/根来源）→ 2. 解析并创建数据根 →
 * 3. 打开状态库并执行版本化迁移 → 4. 装配 StateStore/ArtifactStore/PathService/
 * ProjectService/ConfigurationService → 5. 返回生命周期 facade。
 *
 * 任一步失败都关闭已打开的状态库会话（不遗留半开句柄），并原样抛出结构化错误。
 */
export async function openCoreApplication(options: unknown): Promise<CoreApplication> {
  const context: ValidationContext = { operation: OPERATION };
  const object = requirePlainObject(options, context, 'options');
  rejectUnknownKeys(object, ALLOWED_OPTION_KEYS, context, 'options');
  if (object.workStartupRecoveryRequired !== undefined && typeof object.workStartupRecoveryRequired !== 'boolean') {
    throw validationError(context, 'workStartupRecoveryRequired', 'Expected boolean');
  }
  const capabilityCatalog = requireCapabilityCatalog(object.capabilityCatalog, context);
  if (object.workRuntimeFactory !== undefined && typeof object.workRuntimeFactory !== 'function') {
    throw validationError(context, 'workRuntimeFactory', 'trusted_factory_required');
  }
  if (object.batchDeliveryFactory !== undefined && typeof object.batchDeliveryFactory !== 'function') {
    throw validationError(context, 'batchDeliveryFactory', 'trusted_factory_required');
  }
  if (object.featureDeliveryFactory !== undefined && typeof object.featureDeliveryFactory !== 'function') {
    throw validationError(context, 'featureDeliveryFactory', 'trusted_factory_required');
  }
  if (object.integrationPlanFactory !== undefined && typeof object.integrationPlanFactory !== 'function') {
    throw validationError(context, 'integrationPlanFactory', 'trusted_factory_required');
  }
  if (object.finalizationExecution !== undefined && (
    object.finalizationExecution === null || typeof object.finalizationExecution !== 'object'
    || typeof (object.finalizationExecution as FinalizationExecutionPort).execute !== 'function'
  )) {
    throw validationError(context, 'finalizationExecution', 'trusted_execution_port_required');
  }
  if (object.finalizationCompletion !== undefined && (
    object.finalizationCompletion === null || typeof object.finalizationCompletion !== 'object'
    || typeof (object.finalizationCompletion as FinalizationCompletionPort).execute !== 'function'
  )) {
    throw validationError(context, 'finalizationCompletion', 'trusted_execution_port_required');
  }
  const recoveryCatalog = createStaticRuntimeRecoveryCatalog(object.runtimeRecoveryDescriptors ?? [], capabilityCatalog);
  if (object.runtimeRecoverySources !== undefined && (
    object.runtimeRecoverySources === null || typeof object.runtimeRecoverySources !== 'object' ||
    typeof (object.runtimeRecoverySources as RuntimeRecoverySourceReader).readCurrent !== 'function' ||
    typeof (object.runtimeRecoverySources as RuntimeRecoverySourceReader).readSource !== 'function'
  )) {
    throw validationError(context, 'runtimeRecoverySources', 'source_reader_required');
  }

  if (object.nowUtcMs !== undefined && typeof object.nowUtcMs !== 'function') {
    throw validationError(context, 'nowUtcMs', '必须是返回 UTC 毫秒的函数');
  }
  if (object.repositoryInspector !== undefined && !isPlainObject(object.repositoryInspector)) {
    throw validationError(context, 'repositoryInspector', '必须是 RepositoryInspector 端口实现');
  }
  if (
    object.repositoryInspector !== undefined &&
    typeof (object.repositoryInspector as { inspect?: unknown }).inspect !== 'function'
  ) {
    throw validationError(context, 'repositoryInspector', '必须提供 inspect(unknown) 方法');
  }
  if (object.repositoryInspectorOptions !== undefined && !isPlainObject(object.repositoryInspectorOptions)) {
    throw validationError(context, 'repositoryInspectorOptions', '必须是对象');
  }
  if (
    object.baselineEnvironmentDirectory !== undefined &&
    (object.baselineEnvironmentDirectory === null ||
      typeof object.baselineEnvironmentDirectory !== 'object' ||
      typeof (object.baselineEnvironmentDirectory as { resolveEnvironmentRef?: unknown })
        .resolveEnvironmentRef !== 'function')
  ) {
    throw validationError(
      context,
      'baselineEnvironmentDirectory',
      '必须提供 resolveEnvironmentRef 方法的环境允许列表目录',
    );
  }

  const rootCandidate = resolveRootCandidate(object, context);
  ensureDataRootDirectory(rootCandidate);

  const basePathService = createPathService({ dataRoot: rootCandidate });

  const session = openSqliteStorageSession({
    path: basePathService.databaseFilePath(),
    ...(object.busyTimeoutMs !== undefined ? { busyTimeoutMs: object.busyTimeoutMs as number } : {}),
    ...(object.busyRetryAttempts !== undefined
      ? { busyRetryAttempts: object.busyRetryAttempts as number }
      : {}),
  });

  try {
    await migrateSqliteStorage(session);

    const nowUtcMs = object.nowUtcMs as (() => number) | undefined;
    const stateStore = createSqliteStateStore(
      session,
      nowUtcMs === undefined ? {} : { nowUtcMs },
    );
    const artifactStore = createSqliteArtifactStore(
      session,
      nowUtcMs === undefined ? {} : { nowUtcMs },
    );
    const artifactFileStore = createArtifactFileStore({ dataRoot: basePathService.dataRoot() });
    const runtimeRecovery = createRuntimeRecoveryService({
      configuration: capabilityCatalog,
      capabilities: recoveryCatalog,
      sources: object.runtimeRecoverySources as RuntimeRecoverySourceReader | undefined,
      artifacts: artifactStore,
      verifier: createArtifactVerifier({ artifacts: artifactStore, files: artifactFileStore,
        limits: { maxReadBytes: 16_000_000 } }),
    });
    // P03-5 / F-001：查询门面提前装配，PathService 的 Feature 归属核验与
    // QueryService 共用同一 PlanStore 读取面（createSqliteQueryStore）。
    const queryStore = createSqliteQueryStore(session);
    const documentStore = createSqliteDocumentStore(session, nowUtcMs === undefined ? {} : { nowUtcMs });
    const knowledgeQueryService = createKnowledgeQueryService({
      documents: documentStore,
      documentQuery: queryStore,
      verifier: createArtifactVerifier({ artifacts: artifactStore, files: artifactFileStore, limits: { maxReadBytes: 16_000_000 } }),
    });
    const pathService = basePathService
      .withProjectLookup(stateStore)
      .withFeatureLookup(queryStore);
    const repositoryInspector =
      object.repositoryInspector === undefined
        ? createRepositoryInspector(
            object.repositoryInspectorOptions as RepositoryInspectorOptions | undefined,
          )
        : (object.repositoryInspector as unknown as RepositoryInspector);
    const projectService = createProjectService({ stateStore, repositoryInspector });
    const configurationService = createConfigurationService({ stateStore, capabilityCatalog });
    const commandReceiptStore = createSqliteCommandReceiptStore(
      session,
      nowUtcMs === undefined ? {} : { nowUtcMs },
    );
    const commandReceiptsService = createCommandReceiptsService({
      receiptStore: commandReceiptStore,
    });

    // P02-3 / F-008：基线预览与明确授权用例（§6：规范 cwd、最小环境引用与
    // 代码身份绑定不可变检查输入；环境目录缺席 = 空目录 fail-closed）。
    const baselineService = createBaselineService({
      repositoryInspector,
      workspaceReader: createBaselineWorkspaceReader(),
      environmentDirectory:
        object.baselineEnvironmentDirectory === undefined
          ? { resolveEnvironmentRef: () => null }
          : (object.baselineEnvironmentDirectory as BaselineEnvironmentDirectory),
      stateStore,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });

    const atomicStore = createSqliteAtomicCommandStore(session, nowUtcMs === undefined ? {} : { nowUtcMs });
    const verificationStore = createSqliteVerificationStore(session, nowUtcMs === undefined ? {} : { nowUtcMs });
    // P03-2 / F-006：执行输入准备服务（视图捕获 + 事务外采集/组装/发布 +
    // 正文复验；命令服务在同一装配内接线，最终重核/事件/回执在命令短写事务内）。
    // 获准源文件根白名单由可信装配注入（缺省空名单 fail-closed）；预算面使用
    // Core 冻结缺省（F-004 采集限制/F-005 组装预算/发布与复验限制同一契约）。
    const projectProfileStore = createSqliteProjectProfileStore(
      session,
      nowUtcMs === undefined ? {} : { nowUtcMs },
    );
    const projectProfileService = createProjectProfileService({
      store: projectProfileStore,
      projectLookup: {
        projectExists: projectId => session.database.prepare('SELECT 1 AS found FROM projects WHERE id = ?').get(projectId) !== undefined,
      },
    });
    const executionInputPrepare: ExecutionInputPreparePort = createExecutionInputPrepareService({
      views: createSqlitePlanAccess(session, { ...(nowUtcMs === undefined ? {} : { nowUtcMs }), profileStore: projectProfileStore }),
      inputs: createExecutionInputService({
        artifacts: artifactStore,
        publisher: createArtifactPublisher({
          artifacts: artifactStore,
          files: artifactFileStore,
          limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 },
        }),
        verifier: createArtifactVerifier({
          artifacts: artifactStore,
          files: artifactFileStore,
          limits: { maxReadBytes: 16_000_000 },
        }),
        sources: createInputSourceFileReader({
          roots: { ...(object.inputSourceRoots as Record<string, string> | undefined) },
        }),
        limits: {
          maxItems: 64,
          maxItemBytes: 4_000_000,
          maxTotalBytes: 16_000_000,
          captureTimeoutMs: 60_000,
          readTimeoutMs: 60_000,
        },
        ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
      }),
      builder: createContextBuilder({
        budget: DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET,
      }),
      publisher: createArtifactPublisher({
        artifacts: artifactStore,
        files: artifactFileStore,
        limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 },
      }),
      verifier: createArtifactVerifier({
        artifacts: artifactStore,
        files: artifactFileStore,
        limits: { maxReadBytes: 2_000_000 },
      }),
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
      limits: DEFAULT_EXECUTION_INPUT_PREPARE_LIMITS,
      ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    // P02-3 / F-014：baseline.cancel 的取消执行端口晚绑定到 baselineExecutionService
    // （构造环：execution 依赖 commandService.submit 做授权提交；闭包只在命令执行
    // 时解引用，装配完成后才可达）。
    let baselineExecutionServiceRef: BaselineExecutionService | undefined;
    // P03-3 / F-004：单 Feature 执行 prepare 预览服务（只读预览：一致读视图 +
    // 受控仓库检查；授权与纯校验先于仓库/制品 I/O；不创建执行实体、不扣预算；
    // 权限面沿用 P03-2 生产缺省空集边界宣告，运行时授权面随后续阶段引入时
    // 替换为真实权威读取并保持同一重核契约）。
    const executionPreview: ExecutionPreviewPort = createExecutionPreviewService({
      views: createSqlitePlanAccess(session, { ...(nowUtcMs === undefined ? {} : { nowUtcMs }), profileStore: projectProfileStore }),
      inspector: repositoryInspector,
      workspace: createBaselineWorkspaceReader(),
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
      ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    // P03-3 / F-005：显式执行启动服务（ExecutionController：事务外预算/范围/
    // 预览重算 + 短写事务内重核与原子提交 Batch/Run/事件/回执；提交后唤醒与
    // Scheduler/Runtime 装配属后续任务——不装配唤醒端口，Run 保留 queued +
    // scheduler_not_assembled 可查询原因，不伪造已启动）。
    const executionStart: ExecutionStartPort = createExecutionStartService({
      assertCanDispatch() {
        if (startupRecovery.blocked()) throw new PublicError('resource_busy', 'execution.start', undefined,
          { details: { reason: 'startup_recovery' } });
      },
      preview: executionPreview,
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
      ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    // P05-1 / F-003：一次性规划启动服务（ExecutionController 同一纪律：事务外
    // 请求/预算纯校验 + 短写事务内重核与原子提交；不装配模型调用，accepted
    // 不代表规划完成）。
    const planningStart: PlanningStartPort = createPlanningStartService({
      assertCanDispatch() {
        if (startupRecovery.blocked()) throw new PublicError('resource_busy', 'planning.start', undefined,
          { details: { reason: 'startup_recovery' } });
      },
      ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    // P03-5 / F-011：workspace 栈装配（docs/p03-5-workspace-host-integration-contract.md §2）。
    // 授权根=数据根 + 登记绑定规范源路径（后者由 work-workspace authority 在每次
    // 核验时 realpath + repoIdentity/gitCommonDir 复核）；worktree 目标恒在数据根内。
    const workWorkspaceAuthority = createWorkWorkspaceAuthority({
      authorizedRoots: [basePathService.dataRoot()],
      preparationPaths: pathService,
    });
    const workspaceCommandProcess = createCommandProcessAdapter();
    if (typeof workspaceCommandProcess.recoverStop !== 'function') {
      throw new StorageError('corrupt', OPERATION, 'recoverStop 未装配（生产进程适配器必须提供整组缺席证明）');
    }
    const recoverWorkspaceStop = workspaceCommandProcess.recoverStop;
    const verifyWorkspaceStop = (identity: CommandProcessIdentity) =>
      recoverWorkspaceStop(identity);
    const workspaceStopVerifier = createWorkResourceStopVerifier({
      process: workspaceCommandProcess,
      // 真实可信停止证据是整组缺席证明（recoverStop）；无额外外部收尾步骤。
      finalize: async () => true,
    });
    const workResources = createSqliteWorkResourceAccess(session, {
      workspaceAuthority: workWorkspaceAuthority,
      stopVerifier: workspaceStopVerifier,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    const runtimeFallbackSwitch = createSqliteRuntimeFallbackSwitchService(session, {
      workspaceAuthority: workWorkspaceAuthority,
      stopVerifier: workspaceStopVerifier,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    const workspacePublisher = createArtifactPublisher({
      artifacts: artifactStore,
      files: artifactFileStore,
      limits: { maxSizeBytes: 4 * 1024 * 1024, timeoutMs: 30_000 },
    });
    /** workspace_evidence 证据发布：绝不在 SQLite 事务内调用（装配不变量断言）。 */
    const publishWorkspaceEvidence = async (
      projectId: string,
      operationId: string,
      evidence: Readonly<Record<string, unknown>>,
    ): Promise<string> => {
      if (session.database.inTransaction) {
        throw new TypeError('workspace 证据发布不得在 SQLite 事务内（装配不变量）');
      }
      const body = Buffer.from(JSON.stringify(evidence));
      const published = await workspacePublisher.publishArtifact({
        projectId,
        kind: 'workspace_evidence',
        mediaType: 'application/json',
        expectedHash: createHash('sha256').update(body).digest('hex'),
        locator: `evidence/${operationId}.json`,
        content: [body],
      });
      return published.artifact.id;
    };
    /** 进程身份确认：先持久提交身份证据（evidence/<launchId>.json）再放行变更性 argv。 */
    const confirmWorkspaceProcessIdentity = (projectId: string) =>
      async (identity: CommandProcessIdentity): Promise<CommandProcessIdentity> => {
        await publishWorkspaceEvidence(projectId, identity.launchId, {
          schemaVersion: 1,
          processIdentity: identity,
        });
        return identity;
      };
    const workspaceGitLock = createGitPublicMetadataLock();
    const recoveryInspectorForCall = async (projectId: string) => {
      const binding = await stateStore.getRepositoryBinding(projectId);
      return createWorkspaceInspector({
        authorizedRoots: [basePathService.dataRoot(), binding.canonicalPath],
        confirmProcessIdentity: confirmWorkspaceProcessIdentity(projectId),
      });
    };
    const startupReconciler = createWorkRecoveryReconciler({
      store: createSqliteWorkRecoveryReconciliationStore(session, { resources: workResources, nowUtcMs }),
      inspect: async (projectId, baseline) => (await recoveryInspectorForCall(projectId)).inspect(baseline),
      git: createRecoveryGitReader({
        driverFor: projectId => createGitCommitDriver({
          confirmProcessIdentity: confirmWorkspaceProcessIdentity(projectId),
        }),
      }),
      artifacts: createArtifactVerifier({
        artifacts: artifactStore,
        files: artifactFileStore,
        limits: { maxReadBytes: 4 * 1024 * 1024 },
      }),
      stopVerifier: workspaceStopVerifier,
      publishEvidence: (projectId, evidence) => publishWorkspaceEvidence(projectId, randomUUID(), { ...evidence }),
      nowUtcMs,
    });
    const startupRecovery = createWorkStartupRecovery({
      store: createSqliteWorkStartupRecoveryStore(session, { nowUtcMs }),
      process: workspaceCommandProcess,
      nowUtcMs,
      publishEvidence: (projectId, evidence) => publishWorkspaceEvidence(projectId, randomUUID(), { ...evidence }),
      reconcile: evidence => startupReconciler.reconcile(evidence),
      /* P05-1 / F-010：规划窗口恢复（fence 后、通用逐个核对前；受信制品核验
       * + 幂等补完；证据不足保留 blocked/interrupted 与诊断）。 */
      planning: createPlanningStartupRecovery({
        store: createSqlitePlanningRecoveryStore(session, { nowUtcMs }),
        verifier: createArtifactVerifier({ artifacts: artifactStore, files: artifactFileStore,
          limits: { maxReadBytes: 2 * 1024 * 1024 } }),
        ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
      }),
    });
    if (object.workStartupRecoveryRequired === true) startupRecovery.enter();
    const taskClaims = createSqliteTaskClaimStore(session, {
      assertCanClaim() {
        if (startupRecovery.blocked()) throw new StorageError('conflict', 'TaskClaim.claimTask',
          'Work startup recovery is incomplete', { details: { reason: 'startup_recovery' } });
      },
      workspaceAuthority: workWorkspaceAuthority,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    const workspacePreparationStore = createSqliteWorkspacePreparationStore(session, {
      resources: workResources,
      workspaceAuthority: workWorkspaceAuthority,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    const workspaceRetentionStore = createSqliteWorkspaceRetentionStore(session, {
      resources: workResources,
      workspaceAuthority: workWorkspaceAuthority,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    const workspaceCleanerStore = createSqliteWorkspaceCleanerStore(session, {
      resources: workResources,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    const workspaceDiscardStore = createSqliteWorkspaceDiscardStore(session, {
      resources: workResources,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    /** 按调用构造受界检查器：数据根 + 该次调用项目登记绑定的规范源路径。 */
    const workspaceInspectorForCall = async (projectId: string) => {
      const binding = await stateStore.getRepositoryBinding(projectId);
      return createWorkspaceInspector({
        authorizedRoots: [basePathService.dataRoot(), binding.canonicalPath],
        confirmProcessIdentity: confirmWorkspaceProcessIdentity(projectId),
      });
    };
    // P03-9 / F-008：显式 resume 的重新授权与现场核验。facts 读取在同一只读事务
    // 内取目标 Run/Batch、工作区与占用；inspector 按项目登记绑定构造受界检查器。
    // 生产装配注入启动恢复门控，恢复未完成时提交事务内拒绝解除暂停。
    const executionResume: ExecutionResumePort = createExecutionResumeService({
      facts: createSqliteExecutionResumeFactsReader(session, {
        ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
      }),
      dag: createSqliteTaskDagStore(session),
      attempts: createSqliteAttemptAccess(session),
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
      async inspectorFor(projectId: string) {
        return workspaceInspectorForCall(projectId);
      },
      assertCanResume() {
        if (startupRecovery.blocked()) throw new PublicError('resource_busy', 'execution.resume', undefined,
          { details: { reason: 'startup_recovery' } });
      },
      ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    // P03-9 / F-010：retryFinal 先复用 F-009 只读资格/范围（真实证据按文件
    // 完整性核验），再在命令短事务内重开可继续父 Batch、扣减 Run 名额并
    // 创建 finalization-only Run。生产装配不在事务外启动 Runtime/Attempt。
    const finalizationRetryPlanner = createFinalizationRetryPlanner({
      facts: createSqliteExecutionResumeFactsReader(session, {
        ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
      }),
      dag: createSqliteTaskDagStore(session),
      taskEvidence: queryStore,
      featureDelivery: queryStore,
      artifacts: createArtifactVerifier({
        artifacts: artifactStore,
        files: artifactFileStore,
        limits: { maxReadBytes: 16_000_000 },
      }),
      async inspectorFor(projectId: string) {
        return workspaceInspectorForCall(projectId);
      },
    });
    const finalizationRetry: FinalizationRetryExecutionPort = createFinalizationRetryExecutionService({
      planner: finalizationRetryPlanner,
      facts: createSqliteExecutionResumeFactsReader(session, {
        ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
      }),
      ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    const workspacePreparation = {
      async prepare(raw: unknown): Promise<WorkspaceOperationCommit> {
        // 服务入口立即复核完整输入；此处只最小提取 projectId 以装配受界检查器。
        const input = raw as WorkspacePreparationInput;
        const projectId = validateStableId(
          (input?.identity as { projectId?: unknown } | undefined)?.projectId,
          { operation: 'Workspace.prepare' },
          'identity.projectId',
        );
        const inspector = await workspaceInspectorForCall(projectId);
        const confirm = confirmWorkspaceProcessIdentity(projectId);
        return createWorkspacePreparationService({
          store: workspacePreparationStore,
          authority: workWorkspaceAuthority,
          resources: workResources,
          gitLock: workspaceGitLock,
          preparer: createFeatureWorktreePreparer({ inspector, confirmProcessIdentity: confirm }),
          verifyPreparationStop: verifyWorkspaceStop,
          publishEvidence: publishWorkspaceEvidence,
        }).prepare(input);
      },
    };
    const workspaceRetentionService = createWorkspaceRetentionService({
      store: workspaceRetentionStore,
      stopVerifier: workspaceStopVerifier,
      publishEvidence: publishWorkspaceEvidence,
    });
    const workspaceRetention = {
      retain(raw: unknown): Promise<WorkspaceOperationCommit> {
        return workspaceRetentionService.retain(validateWorkspaceRetentionInput(raw));
      },
    };
    const workspaceCleaner = {
      async clean(raw: unknown): Promise<WorkspaceOperationCommit> {
        const input = validateWorkspaceCleanerInput(raw);
        const inspector = await workspaceInspectorForCall(input.identity.projectId);
        return createWorkspaceCleanerService({
          store: workspaceCleanerStore,
          gitLock: workspaceGitLock,
          cleaner: createFeatureWorktreeCleaner({
            inspector,
            confirmProcessIdentity: confirmWorkspaceProcessIdentity(input.identity.projectId),
          }),
          verifyCleanupStop: verifyWorkspaceStop,
          publishEvidence: publishWorkspaceEvidence,
        }).clean(input);
      },
    };
    const workspaceDiscardPreviewStore = createSqliteWorkspaceDiscardPreviewStore(session, {
      resources: workResources,
    });
    const workspaceDiscard: WorkspaceDiscardService = {
      async preview(raw: unknown) {
        const input = validateWorkspaceDiscardPreviewInput(raw);
        const inspector = await workspaceInspectorForCall(input.projectId);
        return createWorkspaceDiscardService({
          previewStore: workspaceDiscardPreviewStore,
          store: workspaceDiscardStore,
          inspector,
          gitLock: workspaceGitLock,
          discarder: createFeatureWorktreeDiscarder({
            inspector,
            confirmProcessIdentity: confirmWorkspaceProcessIdentity(input.projectId),
          }),
          verifyDiscardStop: verifyWorkspaceStop,
          publishEvidence: publishWorkspaceEvidence,
          ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
        }).preview(input);
      },
      async confirm(raw: unknown) {
        const input = validateWorkspaceDiscardConfirmInput(raw);
        const inspector = await workspaceInspectorForCall(input.projectId);
        return createWorkspaceDiscardService({
          previewStore: workspaceDiscardPreviewStore,
          store: workspaceDiscardStore,
          inspector,
          gitLock: workspaceGitLock,
          discarder: createFeatureWorktreeDiscarder({
            inspector,
            confirmProcessIdentity: confirmWorkspaceProcessIdentity(input.projectId),
          }),
          verifyDiscardStop: verifyWorkspaceStop,
          publishEvidence: publishWorkspaceEvidence,
          ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
        }).confirm(input);
      },
    };
    // F-012：受信返工现场读取——同 Feature 受管 worktree 的当前身份经既有受界
    // 检查器核对（Git 现场/文件内容）；无工作区返回 null（首次认领路径）。
    const readReworkScene = async (projectId: string, featureId: string) => {
      const managed = createSqliteWorkspaceAccess(session, { resources: workResources,
        ...(nowUtcMs === undefined ? {} : { nowUtcMs }) })
        .readWorkspace(projectId, featureId);
      if (managed === null || managed.gitCommonDir === null) return null;
      const inspector = await workspaceInspectorForCall(projectId);
      const inspection = await inspector.inspect({
        repositoryBindingId: managed.repositoryBindingId,
        repositoryBindingRevision: managed.repositoryBindingRevision,
        repoIdentity: managed.repoIdentity,
        canonicalPath: managed.canonicalPath,
        gitCommonDir: managed.gitCommonDir,
        branch: managed.branch,
        baseCommit: managed.baseCommit,
      });
      return { worktreeId: managed.id, headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest };
    };
    // P05-1 / F-004：规划输入准备服务（复用输入采集/Artifact 发布/复验/权限面
    // 与受管工作区现场读取；代码基线 = 既有 readReworkScene 同一受管 worktree
    // 现场身份，只读，不改变开发仓库分支/worktree）。全程写事务外；供
    // planning Run 派发/认领（F-005+）在提交或启动前调用。
    const planningInputPrepare: PlanningInputPreparePort = createPlanningInputPrepareService({
      views: createSqlitePlanningContextStore(session, nowUtcMs === undefined ? {} : { nowUtcMs }),
      inputs: createExecutionInputService({
        artifacts: artifactStore,
        publisher: createArtifactPublisher({
          artifacts: artifactStore,
          files: artifactFileStore,
          limits: { maxSizeBytes: 16_000_000, timeoutMs: 60_000 },
        }),
        verifier: createArtifactVerifier({
          artifacts: artifactStore,
          files: artifactFileStore,
          limits: { maxReadBytes: 16_000_000 },
        }),
        sources: createInputSourceFileReader({
          roots: { ...(object.inputSourceRoots as Record<string, string> | undefined) },
        }),
        limits: {
          maxItems: 64,
          maxItemBytes: 4_000_000,
          maxTotalBytes: 16_000_000,
          captureTimeoutMs: 60_000,
          readTimeoutMs: 60_000,
        },
        ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
      }),
      artifacts: artifactStore,
      publisher: createArtifactPublisher({
        artifacts: artifactStore,
        files: artifactFileStore,
        limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 },
      }),
      verifier: createArtifactVerifier({
        artifacts: artifactStore,
        files: artifactFileStore,
        limits: { maxReadBytes: 2_000_000 },
      }),
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
      readCodeBaseline: (input) => readReworkScene(input.projectId, input.featureId),
      limits: DEFAULT_PLANNING_INPUT_PREPARE_LIMITS,
      ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    const workRecoveryContinuation = createWorkRecoveryContinuationService({
      attempts: createSqliteAttemptAccess(session), artifacts: artifactStore,
      verifier: createArtifactVerifier({ artifacts: artifactStore, files: artifactFileStore, limits: { maxReadBytes: 16_000_000 } }),
      publisher: createArtifactPublisher({ artifacts: artifactStore, files: artifactFileStore,
        limits: { maxSizeBytes: 2_000_000, timeoutMs: 60_000 } }),
      recoveryCatalog: recoveryCatalog, ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    const workExecution = assembleWorkExecution({ session,
      application: { dataRoot: basePathService.dataRoot(), artifactStore, artifactFileStore, stateStore,
        configurationService, workWorkspaceAuthority, taskClaims, workspacePreparation, executionInputPrepare,
        planningInputPrepare, runtimeRecovery, runtimeRecoveryCatalog: recoveryCatalog, workRecoveryContinuation },
      capabilityCatalog, runtimeFactory: object.workRuntimeFactory as WorkRuntimeFactory | undefined, nowUtcMs, readReworkScene, startupRecovery,
      ...(object.finalizationExecution === undefined ? {} : {
        finalizationExecution: object.finalizationExecution as FinalizationExecutionPort,
      }),
      ...(object.finalizationCompletion === undefined ? {} : {
        finalizationCompletion: object.finalizationCompletion as FinalizationCompletionPort,
      }),
      ...(object.planningExecution === undefined ? {} : {
        planningExecution: object.planningExecution as NonNullable<Parameters<typeof assembleWorkExecution>[0]['planningExecution']>,
      }) });
    // P03-9 / F-003：Verifier 停止登记与取消提交后的停止控制。Runtime 停止复用
    // WorkExecution.cancel 的既有受监督命令路径；Verifier 使用同一 CommandProcess
    // AbortSignal 停止路径。证据经既有 Artifact 发布，不写供应商私有存储。
    const verificationStops = createVerificationStopControl();
    const executionStopControl = createExecutionStopControl({
      atomic: atomicStore,
      attempts: createSqliteAttemptAccess(session),
      resources: workResources,
      stopRuntime: identity => workExecution.cancel(identity),
      verifiers: verificationStops,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
      async publishEvidence(projectId, operationId, evidence) {
        const body = Buffer.from(JSON.stringify(evidence));
        const published = await workspacePublisher.publishArtifact({
          projectId, kind: 'execution_stop_evidence', mediaType: 'application/json',
          expectedHash: createHash('sha256').update(body).digest('hex'),
          locator: `stops/${operationId}.json`, content: [body],
        });
        return published.artifact.id;
      },
    });
    // F-012：验证收尾/显式继续共用的生命周期窄存取（同一受信身份与事务面）。
    const attemptLifecycle = createSqliteAttemptLifecycleStore(session, {
      workspaceAuthority: workWorkspaceAuthority,
      stopVerifier: workspaceStopVerifier,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    const commitTask = createSqliteTaskCommitter({ session, resources: workResources, stopVerifier: workspaceStopVerifier,
      publisher: workspacePublisher, files: artifactFileStore, stopControl: verificationStops,
      inspectorFor: workspaceInspectorForCall,
      driverFor: (projectId, signal, observeStop) => createGitCommitDriver({ signal, observeStop,
        confirmProcessIdentity: confirmWorkspaceProcessIdentity(projectId) }),
      lock: workspaceGitLock, ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }) });
    const taskVerificationCompletion = createTaskVerificationCompletionService({
      attempts: createSqliteAttemptAccess(session),
      resources: workResources,
      stopVerifier: workspaceStopVerifier,
      verification: verificationStore,
      lifecycle: attemptLifecycle,
      publisher: workspacePublisher,
      commitTask: input => commitTask({ ...input, codeDigest: input.observation.afterIdentity.codeDigest,
        expectedHead: input.observation.afterIdentity.headCommit }),
      ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    const batchDelivery = (object.batchDeliveryFactory as BatchDeliveryFactory | undefined)?.({ atomicStore });
    if (object.batchDeliveryFactory !== undefined && batchDelivery === undefined) throw validationError(context, 'batchDeliveryFactory', 'delivery_adapters_required');
    const featureDelivery = (object.featureDeliveryFactory as FeatureDeliveryFactory | undefined)?.({ atomicStore });
    if (object.featureDeliveryFactory !== undefined && featureDelivery === undefined) {
      throw validationError(context, 'featureDeliveryFactory', 'delivery_adapters_required');
    }
    const integrationPlanStore = createSqliteIntegrationPlanStore(session, nowUtcMs === undefined ? {} : { nowUtcMs });
    const integrationPlanFacts = (object.integrationPlanFactory as CoreApplicationOptions['integrationPlanFactory'] | undefined)?.({
      atomicStore,
      planStore: integrationPlanStore,
    });
    if (object.integrationPlanFactory !== undefined && (
      integrationPlanFacts === undefined || integrationPlanFacts.batches === undefined || integrationPlanFacts.predecessors === undefined
    )) {
      throw validationError(context, 'integrationPlanFactory', 'integration_fact_adapters_required');
    }
    const gitAgentRepair = createGitAgentRepairService({ atomic: atomicStore,
      store: createSqliteGitAgentRepairStore(session, nowUtcMs === undefined ? {} : { nowUtcMs }) });
    const integrationPlanControl = createIntegrationPlanControlService({ atomic: atomicStore, plans: integrationPlanStore });
    const integrationPlanGeneration = integrationPlanFacts === undefined ? undefined : createIntegrationPlanGenerationService({
      atomic: atomicStore,
      plans: integrationPlanStore,
      batches: integrationPlanFacts.batches,
      predecessors: integrationPlanFacts.predecessors,
    });
    const commandService = createCommandService({
      atomicStore,
      batchDelivery,
      featureDelivery,
      repositoryInspector,
      projectProfileService,
      // F-009：配置命令的能力目录复检复用同一可信装配目录。
      capabilityCatalog,
      baselineService,
      executionInputPrepare,
      executionPreview,
      executionStart,
      planningStart,
      planningCandidateDecision: createPlanningCandidateDecisionPort({
        atomicStore,
        verifier: createArtifactVerifier({
          artifacts: artifactStore,
          files: artifactFileStore,
          limits: { maxReadBytes: PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES },
        }),
      }),
      executionResume,
      finalizationRetry,
      executionDispatchSignal: workExecution,
      executionCancel: workExecution,
      executionStopControl,
      workspaceDiscard,
      taskVerificationContinue: {
        async verifyCurrentEvidence(envelope) {
          const projectId = envelope.scope.projectId;
          const payload = envelope.payload;
          const attempt = createSqliteAttemptAccess(session).getAttempt(projectId, payload.attemptId);
          const batch = verificationStore.getVerificationBatch(projectId, payload.verificationBatchId);
          const stale = () => new StorageError('conflict', 'task.verification.continue',
            'Verification evidence requires a fresh check', { details: { reason: 'verification_evidence_stale' } });
          if (attempt.taskId !== payload.taskId || batch.taskId !== payload.taskId
            || batch.attemptId !== attempt.id || batch.featureId !== attempt.featureId
            || batch.codeDigest !== payload.codeDigest || batch.status !== 'passed'
            || batch.checkSnapshot.some(check => check.environmentRef !== null)) throw stale();
          // Environment identity is checked here; the Task committer verifies the
          // original code/HEAD artifact and current bytes (also after a lost receipt).
          assertVerificationReuseIdentity(batch, batch.codeDigest);
          const verifier = createArtifactVerifier({ artifacts: artifactStore, files: artifactFileStore,
            limits: { maxReadBytes: 16_000_000 } });
          const checks = verificationStore.listCheckResults(projectId, batch.id);
          if (checks.length === 0 || checks.some(check => check.status !== 'passed')) throw stale();
          const ids = new Set<string>();
          for (const check of checks) {
            const evidence = verificationStore.readCheckResultEvidence(projectId, check.id);
            if (evidence.status !== 'complete') throw stale();
            ids.add(evidence.artifactId);
          }
          if (attempt.codeRef === null || attempt.diagnosticRef === null) throw stale();
          ids.add(attempt.codeRef);
          ids.add(attempt.diagnosticRef);
          for (const id of ids) {
            const record = await artifactStore.getArtifact(projectId, id);
            if (record.status !== 'ready') throw stale();
            if ((await verifier.verifyArtifact(projectId, id)).kind !== 'verified_ready') throw stale();
          }
          const codeFile = await artifactFileStore.openFinalRead({ projectId, artifactId: attempt.codeRef });
          const chunks: Buffer[] = [];
          let codeSize = 0;
          for await (const chunk of codeFile.stream) {
            codeSize += chunk.length;
            if (codeSize > 65_536) throw stale();
            chunks.push(Buffer.from(chunk));
          }
          const codeIdentity = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { headCommit: string; codeDigest: string };
          if (codeIdentity.codeDigest !== batch.codeDigest) throw stale();
          await commitTask({ identity: { projectId, attemptId: attempt.id, owner: attempt.owner,
            hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion },
            taskId: attempt.taskId, runId: attempt.runId, verificationBatchId: batch.id, codeDigest: batch.codeDigest,
            expectedHead: codeIdentity.headCommit, retryFailed: true,
            assertCurrent: tx => { validateTaskVerificationContinue(envelope, tx, {
              attempts: createSqliteAttemptAccess(session), verification: verificationStore }); } });
          return workspaceStopVerifier.verify(workResources.read({ projectId, attemptId: attempt.id,
            owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion }));
        },
        attempts: createSqliteAttemptAccess(session),
        verification: verificationStore,
        lifecycle: attemptLifecycle,
      },
      baselineCancel: {
        cancel: (principal, projectId, operationId) => {
          if (baselineExecutionServiceRef === undefined) {
            throw new StorageError('corrupt', OPERATION, 'baseline.cancel 端口在装配完成前被调用');
          }
          return baselineExecutionServiceRef.cancel(principal, projectId, operationId);
        },
      },
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    // F-010：授权查询/快照/事件读取窄端口装配；游标绑定的数据根身份由
    // realpath 固定的数据根派生（与 Host 握手身份同一算法，不来自请求数据）。
    // queryStore 已在 PathService 装配处创建（P03-5 / F-001 共用同一读取面）。
    const queryService = createQueryService({
      projectReads: queryStore,
      snapshots: queryStore,
      eventReads: queryStore,
      planReads: queryStore,
      executionBudgetReads: queryStore,
      scheduleReads: queryStore,
      workspaceReads: queryStore,
      workSessionReads: queryStore,
      taskEvidenceReads: queryStore,
      gitOperationReads: queryStore,
      gitAgentRepairReads: createSqliteGitAgentRepairQueryStore(session),      featureReportReads: queryStore,
      featureDeliveryReads: queryStore,
      batchDeliveryReads: createSqliteBatchDeliveryQueryStore(session, { nowUtcMs }),
      integrationPlanReads: queryStore,
      executionControlReads: queryStore,
      artifacts: artifactStore,
      artifactFiles: artifactFileStore,
      stateStore,
      configurationService,
      dataRootIdentity: computeDataRootIdentity(basePathService.dataRoot()),
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });

    // P05-1 / F-011：规划上下文/候选只读授权查询（复用同一 queryStore 窄端口
    // 与既有预算/制品设施；候选正文与 F-006 提交入口同一完整性界）。
    const planningQueryService = createPlanningQueryService({
      planningReads: queryStore,
      executionBudgetReads: queryStore,
      artifacts: artifactStore,
      artifactFiles: artifactFileStore,
      dataRootIdentity: computeDataRootIdentity(basePathService.dataRoot()),
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });

    // P02-3 / F-004：静态 inspect 与 overview 用例。绑定查找复用同一查询门面；
    // F-007 起基线健康读接入迁移 v4 的真实窄端口（空库 = 尚无检查 →
    // not_run/no_baseline，不以注册成功或配置存在冒充健康通过）。
    const baselineStore = createSqliteBaselineStore(
      session,
      nowUtcMs === undefined ? {} : { nowUtcMs },
    );
    const onboardingService = createOnboardingService({
      repositoryInspector,
      stateStore,
      configurationService,
      bindingReads: queryStore,
      baselineReads: baselineStore,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });

    const gitPublicMetadataLock = createGitPublicMetadataLock();
    const baselineExecutionService = createBaselineExecutionService({
      commands: commandService, atomicStore, baselines: baselineStore, state: stateStore,
      inspector: repositoryInspector, workspace: createBaselineWorkspaceReader(),
      processes: createCommandProcessAdapter(), artifacts: artifactStore, files: artifactFileStore,
      repositoryGuard: createBaselineRepositoryGuard({ lock: gitPublicMetadataLock }),
      recoverPartialOutput: createBaselinePartialOutputReader(basePathService.dataRoot()),
      environmentDirectory: (object.baselineEnvironmentDirectory as BaselineEnvironmentDirectory | undefined) ?? { resolveEnvironmentRef: () => null },
      resolveEnvironment: names => Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    baselineExecutionServiceRef = baselineExecutionService;

    // P02-3 / F-014：基线查询服务（baselines.list/baselines.get/artifacts.get，
    // §7.4-§7.6）；读取面复用同一 baselineStore/artifacts/files，完整性核验读取
    // 由查询服务内部的有界 verifier 承担。
    const baselineQueryService = createBaselineQueryService({
      baselines: baselineStore,
      artifacts: artifactStore,
      files: artifactFileStore,
    });

    const application: CoreApplication = {
      createWorkToolChannel(authority) {
        const attempts = createSqliteAttemptAccess(session);
        const verifier = createArtifactVerifier({ artifacts: artifactStore, files: artifactFileStore,
          limits: { maxReadBytes: 16_000_000 } });
        return createWorkToolChannel({ ...authority, atomicStore, attempts, dag: createSqliteTaskDagStore(session), verifier,
          candidates: createVerificationCandidateValidator({ attempts, verifier, resolver: createTestTargetResolver() }),
          // P05-1 / F-006：规划候选受管发布（受控暂存 → ready；正文上限与通道入口一致）。
          planning: { publisher: createArtifactPublisher({ artifacts: artifactStore, files: artifactFileStore,
            limits: { maxSizeBytes: PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES, timeoutMs: 60_000 },
            ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }) }) } });
      },
      workExecution,
      dataRoot: basePathService.dataRoot(),
      pathService,
      stateStore,
      artifactStore,
      artifactFileStore,
      repositoryInspector,
      gitPublicMetadataLock,
      projectService,
      configurationService,
      commandReceiptStore,
      commandReceiptsService,
      commandService,
      integrationPlanGeneration,
      integrationPlanControl,
      gitAgentRepair,
      executionInputPrepare,
      executionPreview,
      executionStart,
      planningStart,
      planningInputPrepare,
      executionResume,
      finalizationRetry,
      runtimeRecovery,
      runtimeRecoveryCatalog: recoveryCatalog,
      workRecoveryContinuation,
      queryService,
      knowledgeQueryService,
      planningQueryService,
      onboardingService,
      projectProfileService,
      baselineStore,
      verificationStore,
      verificationStops,
      executionStopControl,
      taskVerificationCompletion,
      baselineService,
      baselineExecutionService,
      baselineQueryService,
      workResources,
      runtimeFallbackSwitch,
      workWorkspaceAuthority,
      taskClaims,
      workspacePreparation,
      workspaceRetention,
      workspaceCleaner,
      workspaceDiscard,
      close(): void {
        if (object.workRuntimeFactory !== undefined && !workExecution.isClosed()) throw new StorageError('conflict', 'CoreApplication.close', 'Work 执行须先完成关闭核验');
        if (baselineExecutionService.activeOperationIds().length > 0) throw new StorageError('conflict', 'CoreApplication.close', '基线执行尚未收尾');
        session.close();
      },
    };
    return application;
  } catch (error) {
    try {
      session.close();
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new StorageError('corrupt', OPERATION, `${OPERATION}: 装配失败`, { cause: error });
  }
}
