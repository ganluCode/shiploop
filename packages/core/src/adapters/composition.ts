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
import { createProjectService } from '../application/project-service.js';
import type { ProjectService } from '../application/project-service.js';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import { StorageError } from '../ports/errors.js';
import { PathResolutionError, deriveDefaultDataRoot } from '../ports/path-service.js';
import type { PathService } from '../ports/path-service.js';
import type { RepositoryInspector } from '../ports/repository-inspector.js';
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
import { createPathService } from './fs/path-service.js';
import { createRepositoryInspector } from './fs/repository-inspector.js';
import type { RepositoryInspectorOptions } from './fs/repository-inspector.js';
import { createSqliteArtifactStore } from './sqlite/artifact-store.js';
import { migrateSqliteStorage } from './sqlite/migrator.js';
import { openSqliteStorageSession } from './sqlite/session.js';
import { createSqliteStateStore } from './sqlite/state-store.js';

const OPERATION = 'CoreApplication.open';

/** 装配选项（边界为 unknown，经运行时校验；非法选项在任何 I/O 之前拒绝）。 */
export interface CoreApplicationOptions {
  /** 显式授权数据根（绝对路径）；与 userHomeDir 二选一。 */
  readonly dataRoot?: string;
  /** 注入的 macOS 用户目录；用于解析默认根，与 dataRoot 二选一。 */
  readonly userHomeDir?: string;
  /** 可信装配注入的只读能力目录（F-008）；空目录 fail-closed。 */
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性时间。 */
  readonly nowUtcMs?: () => number;
  /** 仓库检查端口；未提供时按 repositoryInspectorOptions 装配真实 Git 实现。 */
  readonly repositoryInspector?: RepositoryInspector;
  /** 真实 Git 检查适配器选项（仅在未提供 repositoryInspector 时生效）。 */
  readonly repositoryInspectorOptions?: RepositoryInspectorOptions;
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
  /** 关闭状态库会话并释放文件句柄；幂等。 */
  close(): void;
}

const ALLOWED_OPTION_KEYS = [
  'dataRoot',
  'userHomeDir',
  'capabilityCatalog',
  'nowUtcMs',
  'repositoryInspector',
  'repositoryInspectorOptions',
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
    const pathService = basePathService.withProjectLookup(stateStore);
    const repositoryInspector =
      object.repositoryInspector === undefined
        ? createRepositoryInspector(
            object.repositoryInspectorOptions as RepositoryInspectorOptions | undefined,
          )
        : (object.repositoryInspector as unknown as RepositoryInspector);
    const projectService = createProjectService({ stateStore, repositoryInspector });
    const configurationService = createConfigurationService({ stateStore, capabilityCatalog });

    const application: CoreApplication = {
      dataRoot: basePathService.dataRoot(),
      pathService,
      stateStore,
      artifactStore,
      artifactFileStore,
      repositoryInspector,
      projectService,
      configurationService,
      close(): void {
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
