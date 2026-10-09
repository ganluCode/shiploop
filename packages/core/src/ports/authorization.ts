/**
 * F-005 可信 principal 授权契约（ports 纯契约层：类型、常量与纯判定函数）。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md §4：
 * - §4.1 principal 的唯一可信来源是 Host 可信装配（生产固定 local-owner）或
 *   F-004 可信测试装配（受限主体）；本模块只接收显式传入的结构，绝不从
 *   HTTP 请求、argv、env 或请求体取身份，产品代码不存在创建/提权主体的
 *   网络入口（受限主体字面量不得出现在本包源码，由夹具自测扫描固定）；
 * - §4.2 TrustedPrincipal = principalId + capabilities(ReadonlySet) +
 *   projectScope(all | 非空 UUID v4 allowlist)；local-owner 持全部九项能力；
 * - §4.3 操作授权矩阵：命令按 COMMAND_OPERATION_SPECS 能力 + 项目可见性；
 *   全局配置/全局事件独立授权（settings.global.read/write，项目能力不蕴含）；
 *   项目配置读取 = project.read 或 settings.project.read；回执/结果只读本
 *   principal（他人/不可见实体一律 not_found，不区分不存在与无权）；事件
 *   订阅 = events.read + 范围对应读能力，越权在发送任何正文前拒绝；
 * - §4 不变量：授权判定在 Core 应用层执行（Host 只做认证与可信身份传递，
 *   直接调用同样拒绝）；请求中的 projectId 只是目标选择，不扩大 projectScope；
 *   命令重放与历史回执读取重新核验当前身份/权限；列表/计数/分页的可见谓词
 *   以 PrincipalScope 描述符下推（先收窄再分页，禁止全库分页后内存过滤）；
 *   全局事件（project_id IS NULL）不泄漏给项目级主体；拒绝响应不回显不可见
 *   项目的名称/路径/配置/repoIdentity（details 只放受控 reason/entityType）。
 *
 * 纯度不变量：只做数据判定，不读时钟/文件系统/网络/数据库，不生成随机值，
 * 不导入 HTTP/SSE/ORM/Pi SDK；授权失败抛 PublicError（forbidden/not_found），
 * 拒绝是纯判定，不触碰任何业务状态（失败时项目/配置/事件不变由调用方事务
 * 边界与本模块纯度共同保证）；principal 形状非法属于可信装配编程错误，抛
 * TypeError 而非面向客户端的 PublicError。
 */
import {
  APP_CAPABILITIES,
  COMMAND_OPERATION_SPECS,
  LOCAL_OWNER_CAPABILITIES,
  LOCAL_OWNER_PRINCIPAL_ID,
  PublicError,
  isUuidV4,
  type AppCapability,
  type AppOperation,
  type CommandScope,
  type ValidatedCommandEnvelope,
} from './commands.js';
import { isStorageError } from './errors.js';
import type { PublicEventScope } from './events.js';

/* ------------------------------------------------------------------ *
 * §4.2 principal 结构
 * ------------------------------------------------------------------ */

export type PrincipalScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'allowlist'; readonly projectIds: readonly string[] };

/**
 * 可信主体：由 Host 可信装配（生产）或 F-004 可信测试装配（受限主体）构造，
 * 经 Core 应用层边界显式传入；结构与契约 §4.2 及 F-004 测试夹具逐字段兼容。
 */
export interface TrustedPrincipal {
  readonly principalId: string;
  readonly capabilities: ReadonlySet<AppCapability>;
  readonly projectScope: PrincipalScope;
}

/* ------------------------------------------------------------------ *
 * §3.2 / §11.3 查询与事件操作身份（PublicError.operation 与路由共用）
 * ------------------------------------------------------------------ */

export const QUERY_OPERATIONS = [
  'projects.list',
  'projects.get',
  'projects.binding.get',
  'projects.labelCounts',
  'settings.global.get',
  'settings.global.export',
  'settings.project.get',
  'settings.project.effective',
  'settings.project.export',
  'receipts.get',
  'results.resolve',
  'snapshot.get',
] as const;

export type QueryOperation = (typeof QUERY_OPERATIONS)[number];

/** SSE 订阅操作身份（拒绝在发送任何事件正文之前产生）。 */
export const EVENTS_SUBSCRIBE_OPERATION = 'events.subscribe' as const;

/* ------------------------------------------------------------------ *
 * 可信装配边界：principal 形状断言（编程错误 → TypeError）
 * ------------------------------------------------------------------ */

const PRINCIPAL_ID_MAX_LENGTH = 128;
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>(APP_CAPABILITIES);

function failShape(reason: string): never {
  throw new TypeError(`TrustedPrincipal 形状非法（可信装配编程错误）：${reason}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPrincipalId(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    failShape('principalId 必须是字符串');
  }
  if (value.length === 0 || value.length > PRINCIPAL_ID_MAX_LENGTH) {
    failShape(`principalId 长度必须在 1..${PRINCIPAL_ID_MAX_LENGTH}`);
  }
  if (value.trim() !== value || /[\0-\x1f\x7f]/.test(value)) {
    failShape('principalId 不允许前后空白或控制字符');
  }
}

function assertCapabilitySet(value: unknown): asserts value is ReadonlySet<AppCapability> {
  if (value === null || typeof value !== 'object') {
    failShape('capabilities 必须是只读集合');
  }
  const candidate = value as {
    has?: unknown;
    size?: unknown;
    [Symbol.iterator]?: unknown;
  };
  if (
    typeof candidate.has !== 'function' ||
    typeof candidate.size !== 'number' ||
    typeof candidate[Symbol.iterator] !== 'function'
  ) {
    failShape('capabilities 必须具备 has/size/迭代器（ReadonlySet 形态）');
  }
  const entries = [...(value as Iterable<unknown>)];
  if (entries.length !== candidate.size) {
    failShape('capabilities.size 与迭代条目数不一致（伪造集合）');
  }
  if (entries.length > APP_CAPABILITIES.length) {
    failShape(`capabilities 超出冻结能力清单（${APP_CAPABILITIES.length} 项）`);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !KNOWN_CAPABILITIES.has(entry)) {
      failShape(`未知能力 ${String(entry)}`);
    }
    if (seen.has(entry)) {
      failShape(`能力重复：${entry}`);
    }
    seen.add(entry);
  }
}

function assertProjectScope(value: unknown): asserts value is PrincipalScope {
  if (!isPlainObject(value)) {
    failShape('projectScope 必须是对象');
  }
  const keys = Object.keys(value).sort();
  if (value.kind === 'all') {
    if (keys.length !== 1) {
      failShape("projectScope.kind='all' 不允许携带其他键");
    }
    return;
  }
  if (value.kind !== 'allowlist') {
    failShape("projectScope.kind 必须是 'all' 或 'allowlist'");
  }
  if (keys.length !== 2 || !keys.includes('projectIds')) {
    failShape('allowlist scope 必须且只携带 projectIds');
  }
  const projectIds = value.projectIds;
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    failShape('allowlist.projectIds 必须是非空数组（可见范围必须显式）');
  }
  const seen = new Set<string>();
  for (const projectId of projectIds) {
    if (!isUuidV4(projectId)) {
      failShape('allowlist.projectIds 必须是 UUID v4');
    }
    if (seen.has(projectId)) {
      failShape('allowlist.projectIds 不允许重复');
    }
    seen.add(projectId);
  }
}

/**
 * Core 应用层边界校验可信装配传入的 principal。形状非法 = 可信装配编程
 * 错误（TypeError），绝不折算成面向客户端的错误；本函数不修改输入。
 */
export function assertTrustedPrincipal(value: unknown): asserts value is TrustedPrincipal {
  if (!isPlainObject(value)) {
    failShape('必须是普通对象');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || !keys.includes('principalId') || !keys.includes('capabilities')) {
    failShape('必须且只携带 principalId / capabilities / projectScope');
  }
  assertPrincipalId(value.principalId);
  assertCapabilitySet(value.capabilities);
  assertProjectScope(value.projectScope);
}

/* ------------------------------------------------------------------ *
 * 生产装配：local-owner（Host 可信装配层使用；F-011 接线）
 * ------------------------------------------------------------------ */

/**
 * 把能力集包装成真正只读：Object.freeze 对 Set 内部槽无效，用 Proxy 拒绝
 * add/delete/clear；读取（has/size/迭代）原样委托给目标集合。
 */
function freezeCapabilities(capabilities: ReadonlySet<AppCapability>): ReadonlySet<AppCapability> {
  const deny = (): never => {
    throw new TypeError('principal.capabilities 是冻结只读集合');
  };
  return new Proxy(capabilities as Set<AppCapability>, {
    get(target, property) {
      if (property === 'add' || property === 'delete' || property === 'clear') {
        return deny;
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * 生产固定本机主体：全部九项能力 + 可见范围 all。仅 Host 可信装配层调用；
 * 每次返回独立冻结对象，调用方无法经返回值污染共享状态。
 */
export function createLocalOwnerPrincipal(): TrustedPrincipal {
  return Object.freeze({
    principalId: LOCAL_OWNER_PRINCIPAL_ID,
    capabilities: freezeCapabilities(new Set<AppCapability>(LOCAL_OWNER_CAPABILITIES)),
    projectScope: Object.freeze({ kind: 'all' }) as PrincipalScope,
  });
}

/* ------------------------------------------------------------------ *
 * 受控拒绝（details 只放 reason/entityType，不回显 projectId/principalId）
 * ------------------------------------------------------------------ */

function capabilityDenied(operation: string): never {
  throw new PublicError('forbidden', operation, undefined, {
    details: { reason: 'capability_denied' },
  });
}

function projectNotVisible(operation: string): never {
  throw new PublicError('forbidden', operation, undefined, {
    details: { reason: 'project_not_visible', entityType: 'project' },
  });
}

/** 回执/结果引用越权与不存在不可区分：统一 404，不回显归属或实体身份。 */
function receiptNotFound(operation: string): never {
  throw new PublicError('not_found', operation, undefined, {
    details: { reason: 'receipt_not_found' },
  });
}

/* ------------------------------------------------------------------ *
 * 能力与可见性原语
 * ------------------------------------------------------------------ */

export function hasCapability(principal: TrustedPrincipal, capability: AppCapability): boolean {
  assertTrustedPrincipal(principal);
  return principal.capabilities.has(capability);
}

/** 项目可见性：all → 全部可见；allowlist → 仅名单内（projectId 只是目标选择）。 */
export function isProjectVisible(principal: TrustedPrincipal, projectId: string): boolean {
  assertTrustedPrincipal(principal);
  const scope = principal.projectScope;
  return scope.kind === 'all' || scope.projectIds.includes(projectId);
}

/**
 * 可见范围谓词描述符：查询端口在 SQL 谓词中下推（先收窄再分页/计数），
 * 禁止「全库分页后内存过滤」；返回值即 §4.2 的 PrincipalScope 形态。
 */
export function principalProjectVisibility(principal: TrustedPrincipal): PrincipalScope {
  assertTrustedPrincipal(principal);
  return principal.projectScope;
}

export function requireCapability(
  principal: TrustedPrincipal,
  capability: AppCapability,
  operation: string,
): void {
  if (!hasCapability(principal, capability)) {
    capabilityDenied(operation);
  }
}

/** 多选一能力（如项目配置读 = project.read 或 settings.project.read）。 */
export function requireAnyCapability(
  principal: TrustedPrincipal,
  capabilities: readonly AppCapability[],
  operation: string,
): void {
  assertTrustedPrincipal(principal);
  for (const capability of capabilities) {
    if (principal.capabilities.has(capability)) {
      return;
    }
  }
  capabilityDenied(operation);
}

/**
 * 目标项目可见性：不可见统一 forbidden（与「不存在」不可区分，避免
 * projectId 探测；存在性折算见 mapProjectLookupError）。不回显 projectId。
 */
export function requireProjectVisible(
  principal: TrustedPrincipal,
  projectId: string,
  operation: string,
): void {
  if (!isProjectVisible(principal, projectId)) {
    projectNotVisible(operation);
  }
}

/**
 * 把「项目不存在」折算为与「不可见」完全相同的 forbidden（§4.3 矩阵：
 * 项目命令与项目查询对调用方不区分不存在/不可见）。仅折算项目实体的
 * not_found；配置缺失等其他实体的 not_found 与其余错误原样抛出。
 */
export function mapProjectLookupError(error: unknown, operation: string): never {
  if (isStorageError(error, 'not_found') && error.entity?.type === 'project') {
    projectNotVisible(operation);
  }
  if (error instanceof PublicError && error.code === 'not_found') {
    const entityType = error.details?.entityType;
    if (entityType === undefined || entityType === 'project') {
      projectNotVisible(operation);
    }
  }
  throw error;
}

/* ------------------------------------------------------------------ *
 * §4.3 命令授权
 * ------------------------------------------------------------------ */

/**
 * 命令授权（§4.3 命令行）：能力来自 COMMAND_OPERATION_SPECS（信封/P02-2
 * 契约 §6 冻结），project scope 额外要求目标项目在可见范围；注册命令只有
 * 注册能力检查，既有项目可见性由调用方在 canonicalPath 命中后用
 * requireProjectVisible 把关（不可见 → forbidden，不泄漏存在性）。
 */
export function authorizeCommand(
  principal: TrustedPrincipal,
  envelope: ValidatedCommandEnvelope,
): void {
  assertTrustedPrincipal(principal);
  const spec = COMMAND_OPERATION_SPECS[envelope.operation];
  requireCapability(principal, spec.capability, envelope.operation);
  if (envelope.scope.kind === 'project') {
    requireProjectVisible(principal, envelope.scope.projectId, envelope.operation);
  }
}

/* ------------------------------------------------------------------ *
 * §4.3 查询授权
 * ------------------------------------------------------------------ */

/** 项目列表：project.read + 返回下推 SQL 的可见谓词（先收窄再分页）。 */
export function authorizeProjectsList(
  principal: TrustedPrincipal,
  operation: string = 'projects.list',
): PrincipalScope {
  requireCapability(principal, 'project.read', operation);
  return principalProjectVisibility(principal);
}

/** 标签计数：与列表同一可见范围，只统计可见项目。 */
export function authorizeProjectLabelCounts(
  principal: TrustedPrincipal,
  operation: string = 'projects.labelCounts',
): PrincipalScope {
  requireCapability(principal, 'project.read', operation);
  return principalProjectVisibility(principal);
}

/** projects.get / projects.binding.get：project.read + 目标可见。 */
export function authorizeProjectRead(
  principal: TrustedPrincipal,
  projectId: string,
  operation: string = 'projects.get',
): void {
  requireCapability(principal, 'project.read', operation);
  requireProjectVisible(principal, projectId, operation);
}

/** 全局配置读取/导出：仅 settings.global.read（写能力不蕴含读）。 */
export function authorizeGlobalSettingsRead(
  principal: TrustedPrincipal,
  operation: string = 'settings.global.get',
): void {
  requireCapability(principal, 'settings.global.read', operation);
}

/**
 * 项目配置读取（get/effective/export 与项目快照）：project.read 或
 * settings.project.read + 目标可见。effective 的全局值合并由查询服务在
 * 服务端完成，本授权不授予全局原文读取。
 */
export function authorizeProjectSettingsRead(
  principal: TrustedPrincipal,
  projectId: string,
  operation: string = 'settings.project.get',
): void {
  requireAnyCapability(principal, ['project.read', 'settings.project.read'], operation);
  requireProjectVisible(principal, projectId, operation);
}

/** 快照授权（§8）：全局 = settings.global.read；项目 = 项目设置读规则。 */
export function authorizeSnapshot(
  principal: TrustedPrincipal,
  scope: PublicEventScope,
  operation: string = 'snapshot.get',
): void {
  if (scope.kind === 'global') {
    authorizeGlobalSettingsRead(principal, operation);
    return;
  }
  authorizeProjectSettingsRead(principal, scope.projectId, operation);
}

/* ------------------------------------------------------------------ *
 * P02-3 §4.3 静态接入授权（docs/p02-3-onboarding-contract.md）
 * ------------------------------------------------------------------ */

/**
 * projects.inspect（§7.2/§15.1）：注册前只读仓库检查要求 project.register
 * 能力（不新增能力位），**不**要求项目可见范围（尚无项目）；canonicalPath
 * 命中既有绑定后的可见性把关由调用方用 requireProjectVisible 完成
 * （不可见 → forbidden，不泄漏存在性）。
 */
export function authorizeRepositoryInspect(
  principal: TrustedPrincipal,
  operation: string = 'projects.inspect',
): void {
  requireCapability(principal, 'project.register', operation);
}

/**
 * projects.overview（§7.3）：baseline.read 能力 + 目标项目可见；
 * 不可见/未知对调用方统一 forbidden（存在性折算见 mapProjectLookupError）。
 */
export function authorizeProjectOverview(
  principal: TrustedPrincipal,
  projectId: string,
  operation: string = 'projects.overview',
): void {
  requireCapability(principal, 'baseline.read', operation);
  requireProjectVisible(principal, projectId, operation);
}

/* ------------------------------------------------------------------ *
 * §4.3 回执 / 结果引用 / 命令重放授权
 * ------------------------------------------------------------------ */

/** 回执读取归属核验：receipts.read 能力 + 只读本 principal（越权 not_found）。 */
export function authorizeReceiptRead(
  principal: TrustedPrincipal,
  receiptPrincipalId: string,
  operation: string = 'receipts.get',
): void {
  requireCapability(principal, 'receipts.read', operation);
  if (receiptPrincipalId !== principal.principalId) {
    receiptNotFound(operation);
  }
}

/**
 * 回执目标实体当前可见性（§5.6）：project scope 目标不可见 → not_found；
 * 注册回执核验新建项目当前可见性（registrationProjectId 为 null 表示创建
 * 前即被拒绝的回执，无项目实体，仅归属核验）；global scope 无项目实体。
 */
export function authorizeReceiptScopeVisibility(
  principal: TrustedPrincipal,
  scope: CommandScope,
  registrationProjectId: string | null,
  operation: string,
): void {
  assertTrustedPrincipal(principal);
  if (scope.kind === 'project') {
    if (!isProjectVisible(principal, scope.projectId)) {
      receiptNotFound(operation);
    }
    return;
  }
  if (scope.kind === 'registration') {
    if (registrationProjectId !== null && !isProjectVisible(principal, registrationProjectId)) {
      receiptNotFound(operation);
    }
    return;
  }
  // global：归属核验已足，无项目实体可泄漏。
}

/** 回执授权目标（持久回执行的应用侧最小形态；F-006 读取端口映射）。 */
export interface ReceiptAuthorizationTarget {
  readonly principalId: string;
  readonly operation: AppOperation;
  readonly scope: CommandScope;
}

/**
 * results.resolve（§5.6）：引用按回执行解析，核验调用方是回执拥有者且
 * 目标实体当前仍可见；伪造/不可见/未知引用一律 not_found。
 */
export function authorizeResultResolution(
  principal: TrustedPrincipal,
  receipt: { readonly principalId: string; readonly scope: CommandScope },
  registrationProjectId: string | null,
  operation: string = 'results.resolve',
): void {
  authorizeReceiptRead(principal, receipt.principalId, operation);
  authorizeReceiptScopeVisibility(principal, receipt.scope, registrationProjectId, operation);
}

/**
 * 命令重放核验（§4 不变量 3）：既有 commandId 不绕过授权——按回执原操作
 * 重新核验当前能力（能力被收回 → forbidden）、归属与目标实体当前可见性
 * （不可见 → not_found）；不重算摘要/不执行业务（那是 F-007 事务边界）。
 */
export function authorizeCommandReplay(
  principal: TrustedPrincipal,
  receipt: ReceiptAuthorizationTarget,
  registrationProjectId: string | null,
  operation: string,
): void {
  assertTrustedPrincipal(principal);
  requireCapability(principal, COMMAND_OPERATION_SPECS[receipt.operation].capability, operation);
  if (receipt.principalId !== principal.principalId) {
    receiptNotFound(operation);
  }
  authorizeReceiptScopeVisibility(principal, receipt.scope, registrationProjectId, operation);
}

/* ------------------------------------------------------------------ *
 * §4.3 事件订阅授权与可见过滤
 * ------------------------------------------------------------------ */

/**
 * events.subscribe：events.read + 范围对应读能力——项目流要求 project.read
 * 或 settings.project.read 且目标项目可见；全局流要求 settings.global.read
 * （项目能力不蕴含全局）。任何拒绝都在发送事件正文之前产生。
 */
export function authorizeEventSubscription(
  principal: TrustedPrincipal,
  scope: PublicEventScope,
  operation: string = EVENTS_SUBSCRIBE_OPERATION,
): void {
  requireCapability(principal, 'events.read', operation);
  if (scope.kind === 'global') {
    requireCapability(principal, 'settings.global.read', operation);
    return;
  }
  requireAnyCapability(principal, ['project.read', 'settings.project.read'], operation);
  requireProjectVisible(principal, scope.projectId, operation);
}

/**
 * 订阅scope 的行级可见过滤器（F-012 补读/推送共用）：项目流只放行该项目
 * 行，全局流只放行 project_id IS NULL 行——全局事件永不进入项目级主体的
 * 流，其他项目的 sequence 空隙不是丢失。
 */
export function createEventVisibilityFilter(
  scope: PublicEventScope,
): (row: { readonly projectId: string | null }) => boolean {
  if (scope.kind === 'global') {
    return (row) => row.projectId === null;
  }
  const projectId = scope.projectId;
  return (row) => row.projectId === projectId;
}
