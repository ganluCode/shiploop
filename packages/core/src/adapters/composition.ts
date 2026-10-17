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
export type { WorkRuntimeFactory, WorkRuntimeContext } from './work-execution.js';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { createConfigurationService } from '../application/configuration-service.js';
import type { ConfigurationService } from '../application/configuration-service.js';
import { createCommandReceiptsService } from '../application/command-receipts-service.js';
import type { CommandReceiptsService } from '../application/command-receipts-service.js';
import { createCommandService } from '../application/command-service.js';
import type { FeatureDeliveryFactory } from '../application/feature-delivery-commands.js';
export type { FeatureDeliveryFactory, FeatureDeliveryDependencies } from '../application/feature-delivery-commands.js';
import { assertVerificationReuseIdentity } from '../application/task-verification-continue.js';
import type { CommandService } from '../application/command-service.js';
import { createBaselineExecutionService } from '../application/baseline-execution.js';
import type { BaselineExecutionService } from '../application/baseline-execution.js';
import { createBaselineQueryService } from '../application/baseline-query-service.js';
import type { BaselineQueryService } from '../application/baseline-query-service.js';
import { createBaselineService } from '../application/baseline-service.js';
import type { BaselineService } from '../application/baseline-service.js';
import { createOnboardingService } from '../application/onboarding-service.js';
import type { OnboardingService } from '../application/onboarding-service.js';
import { createProjectService } from '../application/project-service.js';
import type { ProjectService } from '../application/project-service.js';
import { createQueryService } from '../application/query-service.js';
import type { QueryService } from '../application/query-service.js';
import { createExecutionInputService } from '../application/execution-input.js';
import { createContextBuilder } from '../application/context-build.js';
import type { ContextBudget } from '../application/context-build.js';
import { createArtifactPublisher } from '../application/artifact-publish.js';
import { createArtifactVerifier } from '../application/artifact-verify.js';
import { createWorkWorkspaceAuthority } from './fs/work-workspace.js';
import { createWorkspaceInspector } from './fs/workspace-inspector.js';
import { createFeatureWorktreePreparer } from './fs/feature-worktree-preparer.js';
import { createFeatureWorktreeCleaner } from './fs/feature-worktree-cleaner.js';
import { createFeatureWorktreeDiscarder } from './fs/feature-worktree-discarder.js';
import { createSqliteWorkResourceAccess } from './sqlite/work-resources.js';
import { createSqliteAttemptAccess } from './sqlite/attempt-store.js';
import { createSqliteAttemptLifecycleStore } from './sqlite/attempt-lifecycle-store.js';
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
import { createInputSourceFileReader } from './fs/input-source-files.js';

// F-009 standalone process adapter; baseline execution orchestration is not assembled yet.
export { createCommandProcessAdapter } from './process/command-process.js';

const OPERATION = 'CoreApplication.open';

/** 装配选项（边界为 unknown，经运行时校验；非法选项在任何 I/O 之前拒绝）。 */
export interface CoreApplicationOptions {
  /** Trusted static adapter assembly; never a settings/argv/env field. */
  readonly workRuntimeFactory?: WorkRuntimeFactory;
  /** Trusted delivery adapters; absent until explicitly assembled. */
  readonly featureDeliveryFactory?: FeatureDeliveryFactory;
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
  readonly executionStart: ExecutionStartPort;
  readonly commandReceiptsService: CommandReceiptsService;
  /** F-010：授权查询/一致读视图快照水位/分页事件读取（§7/§8/§9.3）。 */
  readonly queryService: QueryService;
  /** P02-3 / F-004：静态 inspect 与注册/健康分离的 overview 用例（§7.2/§7.3）。 */
  readonly onboardingService: OnboardingService;
  /** P02-3 / F-007：基线窄存储读取端口（迁移 v4 四表；写经原子命令事务）。 */
  readonly baselineStore: BaselineStore;
  /** P03-7 / F-005：Task Node 检查批次与逐项结果窄存储。 */
  readonly verificationStore: VerificationStore;
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
  'workRuntimeFactory',
  'featureDeliveryFactory',
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
  const capabilityCatalog = requireCapabilityCatalog(object.capabilityCatalog, context);
  if (object.workRuntimeFactory !== undefined && typeof object.workRuntimeFactory !== 'function') {
    throw validationError(context, 'workRuntimeFactory', 'trusted_factory_required');
  }
  if (object.featureDeliveryFactory !== undefined && typeof object.featureDeliveryFactory !== 'function') {
    throw validationError(context, 'featureDeliveryFactory', 'trusted_factory_required');
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
    const executionInputPrepare: ExecutionInputPreparePort = createExecutionInputPrepareService({
      views: createSqlitePlanAccess(session, nowUtcMs === undefined ? {} : { nowUtcMs }),
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
      views: createSqlitePlanAccess(session, nowUtcMs === undefined ? {} : { nowUtcMs }),
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
      preview: executionPreview,
      permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
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
    const taskClaims = createSqliteTaskClaimStore(session, {
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
    const workExecution = assembleWorkExecution({ session,
      application: { dataRoot: basePathService.dataRoot(), artifactStore, artifactFileStore, stateStore,
        configurationService, workWorkspaceAuthority, taskClaims, workspacePreparation, executionInputPrepare },
      capabilityCatalog, runtimeFactory: object.workRuntimeFactory as WorkRuntimeFactory | undefined, nowUtcMs, readReworkScene });
    // F-012：验证收尾/显式继续共用的生命周期窄存取（同一受信身份与事务面）。
    const attemptLifecycle = createSqliteAttemptLifecycleStore(session, {
      workspaceAuthority: workWorkspaceAuthority,
      stopVerifier: workspaceStopVerifier,
      ...(nowUtcMs === undefined ? {} : { nowUtcMs }),
    });
    const taskVerificationCompletion = createTaskVerificationCompletionService({
      attempts: createSqliteAttemptAccess(session),
      resources: workResources,
      stopVerifier: workspaceStopVerifier,
      verification: verificationStore,
      lifecycle: attemptLifecycle,
      publisher: workspacePublisher,
      ...(nowUtcMs === undefined ? {} : { nowMs: nowUtcMs }),
    });
    const featureDelivery = (object.featureDeliveryFactory as FeatureDeliveryFactory | undefined)?.({ atomicStore });
    if (object.featureDeliveryFactory !== undefined && featureDelivery === undefined) {
      throw validationError(context, 'featureDeliveryFactory', 'delivery_adapters_required');
    }
    const commandService = createCommandService({
      atomicStore,
      featureDelivery,
      repositoryInspector,
      // F-009：配置命令的能力目录复检复用同一可信装配目录。
      capabilityCatalog,
      baselineService,
      executionInputPrepare,
      executionPreview,
      executionStart,
      executionDispatchSignal: workExecution,
      executionCancel: workExecution,
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
          const scene = await readReworkScene(projectId, attempt.featureId);
          assertVerificationReuseIdentity(batch, scene?.codeDigest ?? null);
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
      artifacts: artifactStore,
      artifactFiles: artifactFileStore,
      stateStore,
      configurationService,
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
      executionInputPrepare,
      executionPreview,
      executionStart,
      runtimeRecovery,
      queryService,
      onboardingService,
      baselineStore,
      verificationStore,
      taskVerificationCompletion,
      baselineService,
      baselineExecutionService,
      baselineQueryService,
      workResources,
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
