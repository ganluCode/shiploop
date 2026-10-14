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
 * - 结构合法 ≠ 可执行：本入口不装配 Runner/认证/模型执行能力，配置合法不代表
 *   可运行（见 ports/runtime-capabilities 的 assessSettingsConfiguration）。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { createConfigurationService } from '../application/configuration-service.js';
import type { ConfigurationService } from '../application/configuration-service.js';
import { createCommandReceiptsService } from '../application/command-receipts-service.js';
import type { CommandReceiptsService } from '../application/command-receipts-service.js';
import { createCommandService } from '../application/command-service.js';
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
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import { createArtifactFileStore } from './fs/artifact-files.js';
import { createBaselinePartialOutputReader } from './fs/baseline-partial-output.js';
import { createBaselineRepositoryGuard } from './fs/baseline-repository-guard.js';
import { createCommandProcessAdapter } from './process/command-process.js';
import { createBaselineWorkspaceReader } from './fs/baseline-workspace.js';
import { createPathService } from './fs/path-service.js';
import { createRepositoryInspector } from './fs/repository-inspector.js';
import type { RepositoryInspectorOptions } from './fs/repository-inspector.js';
import { createSqliteAtomicCommandStore } from './sqlite/atomic-commands.js';
import { createSqliteArtifactStore } from './sqlite/artifact-store.js';
import { createSqliteBaselineStore } from './sqlite/baseline-store.js';
import type { BaselineStore } from '../ports/baseline-store.js';
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
  /** 已 realpath 固定的授权数据根。 */
  readonly dataRoot: string;
  readonly pathService: PathService;
  readonly stateStore: StateStore;
  readonly artifactStore: ArtifactStore;
  readonly artifactFileStore: ArtifactFileStore;
  readonly repositoryInspector: RepositoryInspector;
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
  /** P02-3 / F-008：基线预览与明确授权用例（§6；经 commandService 提交）。 */
  readonly baselineService: BaselineService;
  /** F-012: explicit execution entry; Host routing is wired in F-014. */
  readonly baselineExecutionService: BaselineExecutionService;
  /** P02-3 / F-014：baselines.list / baselines.get / artifacts.get 只读查询（§7.4-§7.6）。 */
  readonly baselineQueryService: BaselineQueryService;
  /** 关闭状态库会话并释放文件句柄；幂等。 */
  close(): void;
}

const ALLOWED_OPTION_KEYS = [
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
    const commandService = createCommandService({
      atomicStore,
      repositoryInspector,
      // F-009：配置命令的能力目录复检复用同一可信装配目录。
      capabilityCatalog,
      baselineService,
      executionInputPrepare,
      executionPreview,
      executionStart,
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

    const baselineExecutionService = createBaselineExecutionService({
      commands: commandService, atomicStore, baselines: baselineStore, state: stateStore,
      inspector: repositoryInspector, workspace: createBaselineWorkspaceReader(),
      processes: createCommandProcessAdapter(), artifacts: artifactStore, files: artifactFileStore,
      repositoryGuard: createBaselineRepositoryGuard(),
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
      dataRoot: basePathService.dataRoot(),
      pathService,
      stateStore,
      artifactStore,
      artifactFileStore,
      repositoryInspector,
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
      baselineService,
      baselineExecutionService,
      baselineQueryService,
      close(): void {
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
