/**
 * F-010 授权查询响应形状与窄读取端口（ports 纯契约层）。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md §7（查询与分页）与 §8
 * （快照与水位）：
 * - §7.2 查询响应字段集冻结：projects.list → {schemaVersion:2, scope:
 *   'project-list', records, nextCursor, limit}；projects.get → {project,
 *   binding}（无绑定 binding:null）；projects.labelCounts → {labels}；
 *   settings.*.get → {scope, schemaVersion, revision, payload}；
 * - §8 快照内容（项目 + 绑定 + 项目当前配置 + 有效配置 + 水位 / 全局当前
 *   配置 + 水位）与 watermark 必须取自**同一 SQLite 一致读视图**——本模块的
 *   ConsistentSnapshotStore 窄端口一次性返回该视图的全部行与
 *   MAX(state_events.sequence)，禁止「多次独立读取后随手拼水位」；
 * - 授权可见范围（PrincipalScope，来自 authorization.ts）作为谓词下推到
 *   SQL：先收窄再分页/计数，禁止全库分页后内存过滤；
 * - 公开记录形状：项目/绑定的 UTC 毫秒时间在边界转为 ISO UTC 字符串
 *   （createdAt/updatedAt），内部 *UtcMs 字段不进入公开面；F-007/F-008 命令
 *   结果与 F-010 查询响应共用同一组转换函数，不另立第二套序列化规则。
 *
 * 纯度不变量：只做类型声明、纯转换与可信装配形状断言（编程错误抛
 * TypeError）；不读时钟/文件系统/网络/数据库，不导入 HTTP/SSE/ORM/Pi SDK，
 * 不接触适配器。真实 SQLite 读取实现在 adapters 层。
 */
import type { PrincipalScope } from './authorization.js';
import { WIRE_MESSAGE_SCHEMA_VERSION, isUuidV4 } from './commands.js';
import type { SettingsPayload, SettingsScope } from './settings-schema.js';
import type {
  GlobalSettingsRecord,
  ProjectLabelCount,
  ProjectPage,
  ProjectRecord,
  ProjectSettingsRecord,
  ProjectStatus,
  RepositoryBindingRecord,
} from './state-store.js';

/* ------------------------------------------------------------------ *
 * §7.2 公开记录形状与共享转换（命令结果与查询响应共用）
 * ------------------------------------------------------------------ */

/** 公开项目记录：与 ProjectRecord 字段一一对应，时间字段为 ISO UTC。 */
export interface PublicProjectRecord {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly labels: readonly string[];
  readonly repositoryBindingId: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicProjectRecord(project: ProjectRecord): PublicProjectRecord {
  return {
    id: project.id,
    displayName: project.displayName,
    description: project.description,
    status: project.status,
    labels: [...project.labels],
    repositoryBindingId: project.repositoryBindingId,
    revision: project.revision,
    createdAt: new Date(project.createdAtUtcMs).toISOString(),
    updatedAt: new Date(project.updatedAtUtcMs).toISOString(),
  };
}

/** 公开仓库绑定记录：时间字段为 ISO UTC；canonicalPath 为已授权注册事实。 */
export interface PublicRepositoryBindingRecord {
  readonly id: string;
  readonly projectId: string;
  readonly canonicalPath: string;
  readonly gitCommonDir: string | null;
  readonly repoIdentity: string;
  readonly revision: number;
  readonly bindingRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicRepositoryBindingRecord(
  binding: RepositoryBindingRecord,
): PublicRepositoryBindingRecord {
  return {
    id: binding.id,
    projectId: binding.projectId,
    canonicalPath: binding.canonicalPath,
    gitCommonDir: binding.gitCommonDir,
    repoIdentity: binding.repoIdentity,
    revision: binding.revision,
    bindingRevision: binding.bindingRevision,
    createdAt: new Date(binding.createdAtUtcMs).toISOString(),
    updatedAt: new Date(binding.updatedAtUtcMs).toISOString(),
  };
}

/**
 * §7.2 settings.*.get 的当前值形状（也是 F-009 配置命令的固化结果形状）：
 * 只含 scope/schemaVersion/revision/payload，不含存储内部 id/时间戳。
 */
export interface PublicSettingsState {
  readonly scope: SettingsScope;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly payload: SettingsPayload;
}

export function toPublicSettingsState(
  scope: SettingsScope,
  record: GlobalSettingsRecord | ProjectSettingsRecord,
): PublicSettingsState {
  return {
    scope,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    payload: record.payload,
  };
}

/* ------------------------------------------------------------------ *
 * §7.2 查询响应形状（字段集冻结）
 * ------------------------------------------------------------------ */

/** projects.list → {schemaVersion:2, scope:'project-list', records, nextCursor, limit}。 */
export interface ProjectListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'project-list';
  readonly records: readonly PublicProjectRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

/** projects.get → {project, binding}；项目尚无绑定时 binding 为 null。 */
export interface ProjectDetailResult {
  readonly project: PublicProjectRecord;
  readonly binding: PublicRepositoryBindingRecord | null;
}

/** projects.binding.get → {binding}。 */
export interface ProjectBindingResult {
  readonly binding: PublicRepositoryBindingRecord;
}

/** projects.labelCounts → {labels}（仅可见项目去重计数）。 */
export interface ProjectLabelCountsResult {
  readonly labels: readonly ProjectLabelCount[];
}

/* ------------------------------------------------------------------ *
 * 窄读取端口：可见谓词下推的项目列表/计数
 * ------------------------------------------------------------------ */

/**
 * 可信装配形状断言：PrincipalScope 必须来自经 assertTrustedPrincipal 核验的
 * principal（application 层已把关）；此处复核是防御纵深——形状非法属于可信
 * 装配编程错误，抛 TypeError，绝不折算为面向客户端错误，绝不静默放宽为 all。
 */
export function assertPrincipalVisibility(value: unknown): asserts value is PrincipalScope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PrincipalScope 必须是对象（可信装配编程错误）');
  }
  const candidate = value as { readonly kind?: unknown; readonly projectIds?: unknown };
  if (candidate.kind === 'all') {
    if (Object.keys(value).length !== 1) {
      throw new TypeError("PrincipalScope kind='all' 不允许携带其他键");
    }
    return;
  }
  if (candidate.kind !== 'allowlist') {
    throw new TypeError("PrincipalScope.kind 必须是 'all' 或 'allowlist'");
  }
  if (Object.keys(value).length !== 2 || !Array.isArray(candidate.projectIds)) {
    throw new TypeError('PrincipalScope allowlist 必须且只携带 projectIds 数组');
  }
  if (candidate.projectIds.length === 0) {
    throw new TypeError('PrincipalScope allowlist 不允许为空（可见范围必须显式）');
  }
  const seen = new Set<string>();
  for (const projectId of candidate.projectIds) {
    if (!isUuidV4(projectId)) {
      throw new TypeError('PrincipalScope allowlist 项目必须是 UUID v4');
    }
    if (seen.has(projectId)) {
      throw new TypeError('PrincipalScope allowlist 不允许重复项目');
    }
    seen.add(projectId);
  }
}

/**
 * 授权项目列表/标签计数窄读取端口（§4.3/§7.1）：可见范围谓词随查询下推
 * （SQL WHERE），先收窄再分页/计数。filter 输入为 unknown，实现方在任何 SQL
 * 之前复用 P01 validateProjectListFilter 校验（非法 limit/cursor/未知键
 * 拒绝）；visibility 非法形状为编程错误（TypeError）。
 */
export interface AuthorizedProjectReadStore {
  listVisibleProjects(visibility: unknown, filter: unknown): ProjectPage;
  countVisibleProjectLabels(visibility: unknown): readonly ProjectLabelCount[];
}

/* ------------------------------------------------------------------ *
 * §8 一致读视图窄端口
 * ------------------------------------------------------------------ */

/**
 * 快照一致读视图：同一 SQLite 读事务内取得的全部内容行与
 * MAX(state_events.sequence)（空库 0）。project scope 视图 project 缺失即
 * StorageError(not_found)（由应用层折算 forbidden）；settings 未配置为 null
 * （与损坏严格区分，不降级成已配置）。
 */
export interface SnapshotView {
  /** project scope：项目当前状态；global scope：null。 */
  readonly project: ProjectRecord | null;
  /** project scope：仓库绑定（无绑定 null）；global scope：null。 */
  readonly binding: RepositoryBindingRecord | null;
  /** project scope：项目当前配置（未配置 null）；global scope：null。 */
  readonly projectSettings: ProjectSettingsRecord | null;
  /** 全局当前配置（未配置 null）；项目有效配置合并的全局来源依赖。 */
  readonly globalSettings: GlobalSettingsRecord | null;
  /** 同一读视图内的 MAX(state_events.sequence)（全局持久序列，空库 0）。 */
  readonly maxEventSequence: number;
}

/**
 * §8 一致读视图端口：实现方必须以单个 SQLite 读事务（DEFERRED）取得视图——
 * 视图内任何后续写入要么整体可见（其事件 sequence 已计入水位），要么整体
 * 不可见（sequence 严格大于水位），不存在中间形态。在读事务之外或嵌套于
 * 写事务内调用是编程错误（TypeError）。
 */
export interface ConsistentSnapshotStore {
  readProjectSnapshotView(projectId: unknown): SnapshotView;
  readGlobalSnapshotView(): SnapshotView;
}
