/**
 * F-002 P02-3 静态接入与获准基线检查纯契约（ports 契约层：类型、常量、纯校验
 * 与纯摘要函数）。
 *
 * 协议依据：docs/p02-3-onboarding-contract.md
 * - §3.2 路由与 §6 命令 payload 白名单（baseline.preview/run/cancel）；
 * - §5.7 公开错误码：非法输入一律 invalid_input 并定位字段，未知能力 unsupported；
 * - §6.1 检查计划（checkKey 项目内唯一、非空 argv 数组、cwdRef 仓库内相对、
 *   environmentRef 为不透明允许列表引用、timeoutMs 有限区间、required 布尔）；
 * - §6.2/§6.3 授权摘要与代码身份（不可变授权的输入形态）；
 * - §7.1/§7.4 基线分页（默认 20、上限 100、游标为上一页最后 operationId）；
 * - §8 三轴状态模型（operation / check / reason 互相独立）与 §8.2 健康派生
 *   （not_run/空集/未执行必需项/证据缺口/停止未确认均不得折算为健康通过）。
 *
 * 纯度不变量：
 * - 只做结构校验与数据派生，不读时钟/文件系统/网络/数据库，不生成随机值，
 *   不导入 HTTP/SSE/ORM/Pi SDK，不启动或监督进程；校验失败天然零副作用，
 *   保证非法输入在文件/数据库/进程副作用之前被拒绝；
 * - 复用前序规则：ID/摘要/时间/元数据校验复用 commands.ts、validation.ts 与
 *   state-store.ts 的既有实现，错误形状复用 PublicError（field/reason 定位），
 *   不另立第二套；
 * - 客户端传入的 actorId/principal/principalId/capabilities/scope 等提权字段
 *   按非法输入拒绝，永不成为可信身份来源；明文秘密/环境值字段同样拒绝，
 *   错误体只保留 field/reason/receivedType，不回显输入原文。
 */
import { createHash } from 'node:crypto';
import { isPublicError, PublicError } from './commands.js';
import type { PublicErrorCode } from './commands.js';
import { isIsoUtcDateTime, isUuidV4 } from './commands.js';
import { stableCanonicalJson } from './command-receipts.js';
import { isStorageError } from './errors.js';
import type { PublicProjectRecord, PublicRepositoryBindingRecord } from './queries.js';
import { validateCreateProjectInput } from './state-store.js';
import { describeValueType, isPlainObject, validateStableId } from './validation.js';

/* ------------------------------------------------------------------ *
 * §3.2 / §6 命令、查询与能力身份（冻结集合）
 * ------------------------------------------------------------------ */

/** §6 P02-3 新增的三个基线命令（scope 一律 project）。 */
export const BASELINE_COMMAND_OPERATIONS = [
  'baseline.preview',
  'baseline.run',
  'baseline.cancel',
] as const;
export type BaselineCommandOperation = (typeof BASELINE_COMMAND_OPERATIONS)[number];

/** §3.2 P02-3 新增的查询操作身份（供 HostClient 与授权层共用）。 */
export const BASELINE_QUERY_OPERATIONS = [
  'projects.inspect',
  'projects.overview',
  'baselines.list',
  'baselines.get',
  'artifacts.get',
] as const;
export type BaselineQueryOperation = (typeof BASELINE_QUERY_OPERATIONS)[number];

/** §4.2 P02-3 新增的两项能力位（在 P02-2 九项之外）。 */
export const BASELINE_CAPABILITIES = ['baseline.read', 'baseline.run'] as const;
export type BaselineCapability = (typeof BASELINE_CAPABILITIES)[number];

/* ------------------------------------------------------------------ *
 * §13 资源上限（有限默认值，非用户可配）
 * ------------------------------------------------------------------ */

export const BASELINE_CHECKS_MIN = 1;
export const BASELINE_CHECKS_MAX = 64;
export const BASELINE_CHECK_TIMEOUT_MIN_MS = 1;
export const BASELINE_CHECK_TIMEOUT_MAX_MS = 3_600_000;
export const BASELINE_CHECK_TIMEOUT_DEFAULT_MS = 600_000;
/** 单检查输出采集上限（stdout+stderr 合并，8 MiB）。 */
export const BASELINE_CHECK_OUTPUT_MAX_BYTES = 8_388_608;
/** 单检查内联 tail 上限（baselines.get，16 KiB）。 */
export const BASELINE_CHECK_TAIL_MAX_BYTES = 16_384;
export const BASELINE_LIST_DEFAULT_LIMIT = 20;
export const BASELINE_LIST_MAX_LIMIT = 100;

/* ------------------------------------------------------------------ *
 * §8 三轴状态与原因码（冻结枚举）
 * ------------------------------------------------------------------ */

export const BASELINE_OPERATION_STATUSES = [
  'accepted',
  'running',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
  'not_run',
] as const;
export type BaselineOperationStatus = (typeof BASELINE_OPERATION_STATUSES)[number];

/** 终态操作状态（健康派生只取最近一次终态操作）。 */
export const BASELINE_TERMINAL_OPERATION_STATUSES = [
  'completed',
  'cancelled',
  'failed',
  'interrupted',
  'not_run',
] as const;

export function isTerminalBaselineOperationStatus(status: BaselineOperationStatus): boolean {
  return (BASELINE_TERMINAL_OPERATION_STATUSES as readonly string[]).includes(status);
}

export const BASELINE_CHECK_STATUSES = ['passed', 'failed', 'error', 'inconclusive', 'not_run'] as const;
export type BaselineCheckStatus = (typeof BASELINE_CHECK_STATUSES)[number];

export const BASELINE_REASON_CODES = [
  'missing_command',
  'unknown_script',
  'spawn_failed',
  'permission_denied',
  'timed_out',
  'cancelled',
  'stop_unconfirmed',
  'source_changed',
  'evidence_incomplete',
  'output_overflow',
  'restart_recovery',
  'authorization_rejected',
  'empty_check_set',
  'baseline_in_progress',
  'preview_stale',
] as const;
export type BaselineReasonCode = (typeof BASELINE_REASON_CODES)[number];

/** §8.2 取消资格原因：任一出现即不得判为 healthy（即使必需项全通过）。 */
export const BASELINE_DISQUALIFYING_REASONS: ReadonlySet<BaselineReasonCode> = Object.freeze(
  new Set<BaselineReasonCode>(['source_changed', 'evidence_incomplete', 'output_overflow']),
);

/** §8.3 reason → 检查业务状态的唯一映射；非检查级 reason 返回 null。 */
const CHECK_STATUS_BY_REASON: Readonly<Partial<Record<BaselineReasonCode, BaselineCheckStatus>>> =
  Object.freeze({
    missing_command: 'error',
    unknown_script: 'error',
    spawn_failed: 'error',
    permission_denied: 'error',
    timed_out: 'inconclusive',
    cancelled: 'inconclusive',
    stop_unconfirmed: 'inconclusive',
    source_changed: 'inconclusive',
    evidence_incomplete: 'inconclusive',
    output_overflow: 'inconclusive',
    restart_recovery: 'inconclusive',
    authorization_rejected: 'not_run',
    empty_check_set: 'not_run',
  });

/**
 * §8.3 由受控 reason 派生检查业务状态；`baseline_in_progress`/`preview_stale`
 * 是操作级（提交前拒绝）reason，不对应任何检查状态，返回 null。
 */
export function baselineCheckStatusForReason(reason: BaselineReasonCode): BaselineCheckStatus | null {
  return CHECK_STATUS_BY_REASON[reason] ?? null;
}

/* ------------------------------------------------------------------ *
 * §7.3 注册状态与健康状态（严格分开建模）
 * ------------------------------------------------------------------ */

export const PROJECT_REGISTRATION_STATUSES = ['registered', 'not_registered'] as const;
export type ProjectRegistrationStatus = (typeof PROJECT_REGISTRATION_STATUSES)[number];

export const PROJECT_HEALTH_STATUSES = ['healthy', 'unhealthy', 'not_run'] as const;
export type ProjectHealthStatus = (typeof PROJECT_HEALTH_STATUSES)[number];

/** 健康派生原因：受控 reason 之外仅新增 §7.3 的 no_baseline。 */
export type ProjectHealthReasonCode = BaselineReasonCode | 'no_baseline';

export type ProjectHealthApplicability = 'applicable' | 'inapplicable' | 'unknown';
export type ProjectHealthApplicabilityReason =
  | 'no_baseline'
  | 'authorization_missing'
  | 'binding_identity_missing'
  | 'binding_identity_changed'
  | 'code_identity_missing'
  | 'source_changed'
  | 'no_head'
  | 'dirty_scope_missing'
  | 'dirty_scope_changed'
  | 'environment_identity_missing'
  | 'environment_identity_changed'
  | 'command_identity_missing'
  | 'check_definition_changed';

export interface ProjectHealthHistory {
  readonly operation: BaselineOperationSummary;
  readonly checks: readonly BaselineCheckHealthInput[];
}

export interface ProjectHealthSummary {
  readonly status: ProjectHealthStatus;
  readonly lastBaselineOperationId: string | null;
  readonly lastCompletedAt: string | null;
  readonly reasonCode?: ProjectHealthReasonCode;
  /** 当前工作区是否仍与最近一次授权基线适用；历史通过不等于 applicable。 */
  readonly applicability?: ProjectHealthApplicability;
  readonly applicabilityReasons?: readonly ProjectHealthApplicabilityReason[];
  /** 最近一次终态基线的逐项历史结果，保留原状态，不参与当前重判。 */
  readonly lastBaseline?: ProjectHealthHistory;
}

/* ------------------------------------------------------------------ *
 * §7.2/§7.3 静态接入查询响应与窄读取端口
 * ------------------------------------------------------------------ */

/**
 * §7.2/§7.3 静态接入查询响应的线消息版本：P02-3 起新增查询携带
 * schemaVersion=3（§3.1 线消息 2 → 3；WIRE_MESSAGE_SCHEMA_VERSION 常量的
 * 全局切换由路由接线任务完成，本常量先固定新响应的契约值）。
 */
export const ONBOARDING_QUERY_SCHEMA_VERSION = 3 as const;

/** §7.2 projects.inspect 响应（只读仓库事实 + 适用既有项目身份）。 */
export interface ProjectInspectionResult {
  readonly schemaVersion: typeof ONBOARDING_QUERY_SCHEMA_VERSION;
  /** realpath 规范化后的仓库根（符号链接别名解析到同一值）。 */
  readonly canonicalPath: string;
  /** 稳定本地身份（gitdir-sha256:…）；同 remote 不同 clone 不合并。 */
  readonly repoIdentity: string;
  /** 实际 HEAD（无初始 commit 为 null；不猜 main、不自动 commit）。 */
  readonly headCommit: string | null;
  readonly hasInitialCommit: boolean;
  readonly hasUncommittedChanges: boolean;
  /** canonicalPath 已绑定到可见项目时的既有项目身份；未绑定为 null。 */
  readonly alreadyRegistered: { readonly projectId: string } | null;
  /** 读取装配时刻（ISO UTC；注入时钟）。 */
  readonly readAt: string;
}

/**
 * §7.3 overview 的当前配置存在性及其确认信息：未配置为显式
 * configured:false（与损坏严格区分）；已配置只回传确认信息
 * （revision/schemaVersion），不回传 payload 内容（payload 读取走
 * settings.project.get 的既有授权面）。
 */
export type ProjectSettingsPresence =
  | { readonly configured: false }
  | { readonly configured: true; readonly revision: number; readonly schemaVersion: number };

/** §7.3 projects.overview 响应：注册状态与健康状态严格分开。 */
export interface ProjectOverviewResult {
  readonly schemaVersion: typeof ONBOARDING_QUERY_SCHEMA_VERSION;
  readonly project: PublicProjectRecord;
  readonly binding: PublicRepositoryBindingRecord | null;
  readonly registration: { readonly status: ProjectRegistrationStatus };
  readonly settings: ProjectSettingsPresence;
  readonly health: ProjectHealthSummary;
  readonly readAt: string;
}

/**
 * §7.3 基线健康窄读取端口：overview 只经本端口取得最近一次终态基线操作
 * 与逐项检查输入（§8.2 派生原料），不直接触碰基线表。迁移 v4（F-007）
 * 落地前由组合根装配显式占位（operation:null/checks:[]，即「尚无检查」），
 * 绝不以注册成功或配置存在冒充健康通过。projectId 输入为 unknown，
 * 实现方在读取前校验稳定 ID 形态。
 */
export interface BaselineHealthReadStore {
  readProjectHealthInput(projectId: unknown, current?: BaselineHealthCurrentInput): ProjectHealthInput;
}

/* ------------------------------------------------------------------ *
 * §6.1 检查计划与 §6.2/§6.3 授权摘要（数据形态）
 * ------------------------------------------------------------------ */

export type BaselineCheckKind = 'command';

export interface BaselineCheck {
  readonly checkKey: string;
  readonly kind: BaselineCheckKind;
  readonly argv: readonly string[];
  readonly cwdRef?: string;
  readonly environmentRef?: string;
  readonly timeoutMs: number;
  readonly required: boolean;
}

export interface BaselineCheckPlan {
  readonly checks: readonly BaselineCheck[];
}

export interface BaselineCodeIdentity {
  readonly headCommit: string | null;
  readonly workingTreeDigest: string;
  readonly hasUncommittedChanges: boolean;
}

/** 脏工作区的可解释范围；unknown 表示历史记录或可信采集没有提供范围。 */
export type BaselineDirtyScopeStatus = 'clean' | 'tracked' | 'untracked' | 'mixed' | 'unknown';

export interface BaselineDirtyScope {
  readonly status: BaselineDirtyScopeStatus;
  readonly explanation: string;
}

/**
 * 获准环境的公开身份快照。只允许保存引用/版本、公开工具链摘要和覆盖说明；
 * 凭据值、完整 Host 环境和原始转储不属于此结构。
 */
export interface BaselineEnvironmentIdentity {
  readonly schemaVersion: 1;
  readonly environmentRef: string | null;
  readonly definitionRevision: string | null;
  readonly toolchain: Readonly<Record<string, string | null>>;
  readonly platform: {
    readonly os: string | null;
    readonly arch: string | null;
  };
  readonly allowedVariables: readonly string[];
  readonly coverage: readonly string[];
  readonly unknownFields: readonly string[];
}

export interface BaselinePreviewContext {
  readonly repositoryBindingId: string;
  readonly repositoryBindingRevision: number;
  readonly bindingRecordRevision: number;
  readonly dirtyScope: BaselineDirtyScope;
  readonly environmentIdentity: BaselineEnvironmentIdentity;
}

export type BaselineHistoricalMissingField =
  | 'repositoryBindingRevision'
  | 'dirtyScope'
  | 'environmentIdentity';

export interface BaselineAuthorizationSummary {
  readonly projectId: string;
  readonly repositoryBindingId: string;
  /** 新授权的绑定 CAS revision；旧记录缺失时省略，不能回填猜测值。 */
  readonly repositoryBindingRevision?: number;
  readonly codeIdentity: BaselineCodeIdentity;
  readonly dirtyScope?: BaselineDirtyScope;
  readonly environmentIdentity?: BaselineEnvironmentIdentity;
  /** 旧版本授权未持久化的身份字段；只描述缺口，不使用当前配置补写。 */
  readonly missingFields?: readonly BaselineHistoricalMissingField[];
  readonly policyRevision: string;
  readonly planDigest: string;
  readonly plan: BaselineCheckPlan;
  readonly authorizedBy: string;
  readonly authorizedAt: string;
}

export type BaselineDecision = 'authorize' | 'decline';

export interface BaselinePreviewPayload {
  readonly plan: BaselineCheckPlan;
}

export interface BaselineRunPayload {
  readonly decision: BaselineDecision;
  readonly plan: BaselineCheckPlan;
  readonly previewDigest: string;
}

export interface BaselineCancelPayload {
  readonly operationId: string;
}

export interface BaselineListQuery {
  readonly limit: number;
  readonly cursor?: string;
}

export interface ValidatedProjectInitRequest {
  readonly repositoryPath: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly labels: string[];
}

/* ------------------------------------------------------------------ *
 * §7.4/§7.5 结果与摘要形态
 * ------------------------------------------------------------------ */

export interface BaselineCheckCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly error: number;
  readonly inconclusive: number;
  readonly notRun: number;
}

export interface BaselineCheckOutputRef {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly truncated: boolean;
}

export interface BaselineCheckResult {
  readonly checkKey: string;
  readonly argv: readonly string[];
  readonly cwdRef: string | null;
  readonly environmentRef: string | null;
  readonly timeoutMs: number;
  readonly required: boolean;
  readonly status: BaselineCheckStatus;
  readonly reasonCode?: BaselineReasonCode;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: BaselineCheckOutputRef | null;
  readonly tail: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
}

export interface BaselineOperationSummary {
  readonly operationId: string;
  readonly kind: 'baseline';
  readonly status: BaselineOperationStatus;
  readonly reasonCode?: BaselineReasonCode;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly summary: BaselineCheckCounts;
}

/**
 * P02-3 / F-014（§7.4）：baselines.list 查询响应（线消息 schemaVersion=3）。
 * 按 operationId 升序稳定键集分页；cursor 为上一页最后 operationId。
 */
export interface BaselineListResult {
  readonly schemaVersion: number;
  readonly projectId: string;
  readonly records: readonly BaselineOperationSummary[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

/** P02-3 / F-014（§7.5）：baselines.get 查询响应（授权摘要 + 逐项检查）。 */
export interface BaselineDetailResult {
  readonly schemaVersion: number;
  readonly operation: BaselineOperationSummary;
  readonly authorization: BaselineAuthorizationSummary | null;
  readonly checks: readonly BaselineCheckResult[];
}

/* ------------------------------------------------------------------ *
 * 校验原语（错误形状与 commands.ts 一致：PublicError + field/reason）
 * ------------------------------------------------------------------ */

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CHECK_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENVIRONMENT_REF_MAX_LENGTH = 256;

function fail(
  operation: string,
  code: PublicErrorCode,
  field: string,
  reason: string,
  received?: unknown,
  extraDetails?: Readonly<Record<string, unknown>>,
): never {
  throw new PublicError(code, operation, undefined, {
    details: {
      field,
      reason,
      ...(received !== undefined ? { receivedType: describeValueType(received) } : {}),
      ...(extraDetails ?? {}),
    },
  });
}

function requireObject(operation: string, value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(operation, 'invalid_input', field, '必须是 JSON 对象', value);
  }
  return value;
}

function exactKeys(
  operation: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPrefix = '',
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(operation, 'invalid_input', `${fieldPrefix}${key}`, '包含未知字段（版本契约不接受前向宽容字段）');
    }
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireField(operation: string, value: Record<string, unknown>, key: string, field: string): void {
  if (!hasOwn(value, key) || value[key] === undefined) {
    fail(operation, 'invalid_input', field, '缺少必填字段');
  }
}

/** 明文秘密/环境值字段名（规范化后精确匹配）：秘密不得进入请求体。 */
const SECRET_FIELD_TOKENS: ReadonlySet<string> = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'pin',
  'apikey',
  'accesskey',
  'secretkey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'privatekey',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'bearer',
  'env',
  'environment',
  'envvars',
  'environmentvariables',
]);

function normalizeKeyToken(key: string): string {
  return key.toLowerCase().replaceAll(/[_-]/g, '');
}

/** 递归扫描对象键名：任何层级的秘密/环境值字段一律定位拒绝（只读键，不读值）。 */
function rejectSecretFields(operation: string, value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(operation, item, `${field}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    const childField = field.length > 0 ? `${field}.${key}` : key;
    if (SECRET_FIELD_TOKENS.has(normalizeKeyToken(key))) {
      fail(operation, 'invalid_input', childField, '不允许携带明文秘密或环境值字段（秘密不进入请求）');
    }
    rejectSecretFields(operation, value[key], childField);
  }
}

/** 客户端不得提供身份/权限/可见范围字段：可信身份只由 Host 装配注入。 */
const CLIENT_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'actorid',
  'actor',
  'principal',
  'principalid',
  'capabilities',
  'capability',
  'scope',
  'projectscope',
  'permissions',
  'roles',
]);

function rejectClientIdentityFields(
  operation: string,
  value: Record<string, unknown>,
  fieldPrefix: string,
): void {
  for (const key of Object.keys(value)) {
    if (CLIENT_IDENTITY_FIELDS.has(normalizeKeyToken(key))) {
      fail(
        operation,
        'invalid_input',
        `${fieldPrefix}${key}`,
        '不接受客户端提供的身份/权限/可见范围字段（可信身份只由 Host 装配注入）',
      );
    }
  }
}

function requireSha256(operation: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
    fail(operation, 'invalid_input', field, '必须是 64 位小写十六进制 SHA-256 摘要', value);
  }
  return value;
}

function requireOperationId(operation: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    fail(operation, 'invalid_input', field, '必须是 RFC 4122 UUID v4（操作身份）', value);
  }
  return value;
}

function requireProjectId(operation: string, value: unknown, field: string): string {
  try {
    return validateStableId(value, { operation }, field);
  } catch (error) {
    if (isStorageError(error, 'validation')) {
      fail(operation, 'invalid_input', field, '必须是稳定项目 ID', value);
    }
    throw error;
  }
}

function requireAbsolutePath(operation: string, value: unknown, field: string): string {
  if (typeof value !== 'string') {
    fail(operation, 'invalid_input', field, '必须是字符串（仓库根绝对路径）', value);
  }
  if (value.length === 0) {
    fail(operation, 'invalid_input', field, '不允许为空', value);
  }
  if (value.includes('\0')) {
    fail(operation, 'invalid_input', field, '不允许包含 NUL 字节', value);
  }
  if (!value.startsWith('/')) {
    fail(operation, 'invalid_input', field, '必须是绝对路径', value);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * §6.1 检查计划校验
 * ------------------------------------------------------------------ */

const CHECK_KEYS = ['checkKey', 'kind', 'argv', 'cwdRef', 'environmentRef', 'timeoutMs', 'required'] as const;

function requireCheckKey(operation: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || !CHECK_KEY_PATTERN.test(value)) {
    fail(
      operation,
      'invalid_input',
      field,
      '必须是 ^[a-z0-9][a-z0-9_-]{0,63}$（小写稳定检查标识）',
      value,
    );
  }
  return value;
}

function requireArgv(operation: string, value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(operation, 'invalid_input', field, '必须是非空字符串数组（argv，不使用 shell）', value);
  }
  const argv: string[] = [];
  for (const [index, item] of value.entries()) {
    const itemField = `${field}[${index}]`;
    if (typeof item !== 'string') {
      fail(operation, 'invalid_input', itemField, '参数必须是字符串', item);
    }
    if (item.trim().length === 0) {
      fail(operation, 'invalid_input', itemField, '参数不允许为空或全空白', item);
    }
    if (item.includes('\0')) {
      fail(operation, 'invalid_input', itemField, '参数不允许包含 NUL 字节', item);
    }
    argv.push(item);
  }
  return argv;
}

function requireCwdRef(operation: string, value: unknown, field: string): string {
  const reason = 'path_outside_repository';
  if (typeof value !== 'string' || value.length === 0) {
    fail(operation, 'invalid_input', field, '必须是非空字符串（仓库内相对子目录）', value, { reason });
  }
  if (value.includes('\0')) {
    fail(operation, 'invalid_input', field, '不允许包含 NUL 字节', value, { reason });
  }
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value) || value.includes('\\')) {
    fail(operation, 'invalid_input', field, '必须是 POSIX 相对路径（不接受绝对路径或反斜杠）', value, { reason });
  }
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      fail(operation, 'invalid_input', field, '不允许空段/./..（路径必须落在仓库内）', value, { reason });
    }
  }
  return value;
}

function requireEnvironmentRef(operation: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(operation, 'invalid_input', field, '必须是非空字符串（环境允许列表引用，不携带秘密值）', value);
  }
  if (value.length > ENVIRONMENT_REF_MAX_LENGTH) {
    fail(operation, 'invalid_input', field, `长度不得超过 ${ENVIRONMENT_REF_MAX_LENGTH}`, value);
  }
  if (value.includes('\0') || /[\0-\x1f\x7f]/.test(value)) {
    fail(operation, 'invalid_input', field, '不允许包含 NUL 或控制字符', value);
  }
  return value;
}

function requireTimeoutMs(operation: string, value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < BASELINE_CHECK_TIMEOUT_MIN_MS ||
    value > BASELINE_CHECK_TIMEOUT_MAX_MS
  ) {
    fail(
      operation,
      'invalid_input',
      field,
      `必须是 ${BASELINE_CHECK_TIMEOUT_MIN_MS}..${BASELINE_CHECK_TIMEOUT_MAX_MS} 的整数毫秒`,
      value,
      { reason: 'invalid_check_plan' },
    );
  }
  return value;
}

function requireBoolean(operation: string, value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    fail(operation, 'invalid_input', field, '必须是布尔值', value);
  }
  return value;
}

/**
 * §6.1 运行时校验外部检查计划（unknown → 规范化 BaselineCheckPlan）。纯函数：
 * 不做 I/O、不解析 shell、不读时钟。任何非法输入在文件/数据库/进程副作用之前
 * 以 invalid_input 定位拒绝；省略的 cwdRef/environmentRef 不产生 undefined 值键，
 * 保证规范 JSON 摘要稳定。
 */
export function validateBaselineCheckPlan(
  input: unknown,
  operation: string = 'baseline.preview',
): BaselineCheckPlan {
  const plan = requireObject(operation, input, 'plan');
  rejectSecretFields(operation, plan, 'plan');
  rejectClientIdentityFields(operation, plan, 'plan.');
  exactKeys(operation, plan, ['checks'], 'plan.');

  requireField(operation, plan, 'checks', 'plan.checks');
  const rawChecks = plan.checks;
  if (!Array.isArray(rawChecks)) {
    fail(operation, 'invalid_input', 'plan.checks', '必须是检查项数组', rawChecks);
  }
  if (rawChecks.length < BASELINE_CHECKS_MIN || rawChecks.length > BASELINE_CHECKS_MAX) {
    fail(
      operation,
      'invalid_input',
      'plan.checks',
      `检查项数量必须在 ${BASELINE_CHECKS_MIN}..${BASELINE_CHECKS_MAX} 之间`,
      rawChecks,
      { reason: 'invalid_check_plan' },
    );
  }

  const checks: BaselineCheck[] = [];
  const seenCheckKeys = new Set<string>();
  for (const [index, item] of rawChecks.entries()) {
    const field = `plan.checks[${index}]`;
    const object = requireObject(operation, item, field);
    rejectSecretFields(operation, object, field);
    exactKeys(operation, object, CHECK_KEYS, `${field}.`);

    requireField(operation, object, 'checkKey', `${field}.checkKey`);
    const checkKey = requireCheckKey(operation, object.checkKey, `${field}.checkKey`);
    if (seenCheckKeys.has(checkKey)) {
      fail(operation, 'invalid_input', `${field}.checkKey`, 'checkKey 在项目内必须唯一（重复检查 ID）', object.checkKey);
    }
    seenCheckKeys.add(checkKey);

    requireField(operation, object, 'kind', `${field}.kind`);
    if (object.kind !== 'command') {
      fail(operation, 'invalid_input', `${field}.kind`, "kind 必须是 'command'", object.kind);
    }

    requireField(operation, object, 'argv', `${field}.argv`);
    const argv = requireArgv(operation, object.argv, `${field}.argv`);

    requireField(operation, object, 'timeoutMs', `${field}.timeoutMs`);
    const timeoutMs = requireTimeoutMs(operation, object.timeoutMs, `${field}.timeoutMs`);

    requireField(operation, object, 'required', `${field}.required`);
    const required = requireBoolean(operation, object.required, `${field}.required`);

    const check: {
      checkKey: string;
      kind: BaselineCheckKind;
      argv: readonly string[];
      cwdRef?: string;
      environmentRef?: string;
      timeoutMs: number;
      required: boolean;
    } = { checkKey, kind: 'command', argv, timeoutMs, required };
    if (object.cwdRef !== undefined) {
      check.cwdRef = requireCwdRef(operation, object.cwdRef, `${field}.cwdRef`);
    }
    if (object.environmentRef !== undefined) {
      check.environmentRef = requireEnvironmentRef(operation, object.environmentRef, `${field}.environmentRef`);
    }
    checks.push(check);
  }
  return { checks };
}

/**
 * §6.2 规范化检查计划的确定性摘要（planDigest / policyRevision）：
 * sha256(stableCanonicalJson(plan))，键序无关、内容敏感。纯函数。
 */
export function computeBaselinePlanDigest(plan: BaselineCheckPlan): string {
  return createHash('sha256').update(stableCanonicalJson(plan), 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * §6 命令 payload 校验
 * ------------------------------------------------------------------ */

/** baseline.preview：`{plan}`（只读解析，不绑定授权）。 */
export function validateBaselinePreviewPayload(input: unknown): BaselinePreviewPayload {
  const operation = 'baseline.preview';
  const object = requireObject(operation, input, 'payload');
  rejectSecretFields(operation, object, 'payload');
  rejectClientIdentityFields(operation, object, 'payload.');
  exactKeys(operation, object, ['plan'], 'payload.');
  requireField(operation, object, 'plan', 'payload.plan');
  return { plan: validateBaselineCheckPlan(object.plan, operation) };
}

/** baseline.run：`{decision, plan, previewDigest}`（authorize/decline 二选一）。 */
export function validateBaselineRunPayload(input: unknown): BaselineRunPayload {
  const operation = 'baseline.run';
  const object = requireObject(operation, input, 'payload');
  rejectSecretFields(operation, object, 'payload');
  rejectClientIdentityFields(operation, object, 'payload.');
  exactKeys(operation, object, ['decision', 'plan', 'previewDigest'], 'payload.');

  requireField(operation, object, 'decision', 'payload.decision');
  const decision = object.decision;
  if (decision !== 'authorize' && decision !== 'decline') {
    fail(operation, 'invalid_input', 'payload.decision', "必须是 'authorize' 或 'decline'", decision);
  }

  requireField(operation, object, 'plan', 'payload.plan');
  const plan = validateBaselineCheckPlan(object.plan, operation);

  requireField(operation, object, 'previewDigest', 'payload.previewDigest');
  const previewDigest = requireSha256(operation, object.previewDigest, 'payload.previewDigest');

  return { decision, plan, previewDigest };
}

/** baseline.cancel：`{operationId}`（取消目标必须是稳定操作身份）。 */
export function validateBaselineCancelPayload(input: unknown): BaselineCancelPayload {
  const operation = 'baseline.cancel';
  const object = requireObject(operation, input, 'payload');
  rejectSecretFields(operation, object, 'payload');
  rejectClientIdentityFields(operation, object, 'payload.');
  exactKeys(operation, object, ['operationId'], 'payload.');
  requireField(operation, object, 'operationId', 'payload.operationId');
  return { operationId: requireOperationId(operation, object.operationId, 'payload.operationId') };
}

/* ------------------------------------------------------------------ *
 * §7.2 仓库路径与 project init 请求
 * ------------------------------------------------------------------ */

/** §3.2/§7.2 仓库根绝对路径（存在性/仓库形态由 RepositoryInspector 在事务外检查）。 */
export function validateRepositoryRootPath(input: unknown, operation: string = 'projects.inspect'): string {
  return requireAbsolutePath(operation, input, 'path');
}

/**
 * project init 请求：仓库根绝对路径 + 复用 P01 元数据校验（displayName/
 * description/labels）。字段定位统一为 payload.*，与命令信封一致。
 */
export function validateProjectInitRequest(input: unknown): ValidatedProjectInitRequest {
  const operation = 'project.init';
  const object = requireObject(operation, input, 'payload');
  rejectSecretFields(operation, object, 'payload');
  rejectClientIdentityFields(operation, object, 'payload.');
  exactKeys(operation, object, ['repositoryPath', 'displayName', 'description', 'labels'], 'payload.');

  requireField(operation, object, 'repositoryPath', 'payload.repositoryPath');
  const repositoryPath = requireAbsolutePath(operation, object.repositoryPath, 'payload.repositoryPath');

  try {
    const metadata = validateCreateProjectInput(
      { displayName: object.displayName, description: object.description, labels: object.labels },
      operation,
    );
    return {
      repositoryPath,
      displayName: metadata.displayName,
      description: metadata.description,
      labels: metadata.labels,
    };
  } catch (error) {
    if (isStorageError(error, 'validation')) {
      const rawField = error.details?.field;
      const field =
        typeof rawField !== 'string'
          ? 'payload'
          : rawField === 'input'
            ? 'payload'
            : rawField.startsWith('payload.')
              ? rawField
              : `payload.${rawField}`;
      fail(operation, 'invalid_input', field, '项目元数据非法', undefined, { reason: 'invalid_metadata' });
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * §6.2/§6.3 代码身份与授权摘要校验（持久/读取边界复用）
 * ------------------------------------------------------------------ */

export function validateBaselineCodeIdentity(
  input: unknown,
  operation: string = 'baseline.preview',
  field = 'codeIdentity',
): BaselineCodeIdentity {
  const object = requireObject(operation, input, field);
  exactKeys(operation, object, ['headCommit', 'workingTreeDigest', 'hasUncommittedChanges'], `${field}.`);

  requireField(operation, object, 'workingTreeDigest', `${field}.workingTreeDigest`);
  const workingTreeDigest = requireSha256(operation, object.workingTreeDigest, `${field}.workingTreeDigest`);

  requireField(operation, object, 'hasUncommittedChanges', `${field}.hasUncommittedChanges`);
  const hasUncommittedChanges = requireBoolean(
    operation,
    object.hasUncommittedChanges,
    `${field}.hasUncommittedChanges`,
  );

  let headCommit: string | null = null;
  if (object.headCommit !== undefined && object.headCommit !== null) {
    if (typeof object.headCommit !== 'string' || !GIT_COMMIT_PATTERN.test(object.headCommit)) {
      fail(operation, 'invalid_input', `${field}.headCommit`, '必须是 40 位小写十六进制 commit hash 或 null', object.headCommit);
    }
    headCommit = object.headCommit;
  }
  return { headCommit, workingTreeDigest, hasUncommittedChanges };
}

function requireBaselinePositiveInteger(
  operation: string,
  value: unknown,
  field: string,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail(operation, 'invalid_input', field, '必须是正整数', value);
  }
  return value;
}

export function validateBaselineDirtyScope(
  input: unknown,
  operation: string,
  field: string,
): BaselineDirtyScope {
  const object = requireObject(operation, input, field);
  exactKeys(operation, object, ['status', 'explanation'], `${field}.`);
  if (!(typeof object.status === 'string' && ['clean', 'tracked', 'untracked', 'mixed', 'unknown'].includes(object.status))) {
    fail(operation, 'invalid_input', `${field}.status`, '必须是受控脏范围状态', object.status);
  }
  if (typeof object.explanation !== 'string' || object.explanation.length > 512) {
    fail(operation, 'invalid_input', `${field}.explanation`, '必须是 ≤512 字符的范围说明', object.explanation);
  }
  return { status: object.status as BaselineDirtyScopeStatus, explanation: object.explanation };
}

export function validateBaselineEnvironmentIdentity(
  input: unknown,
  operation: string,
  field: string,
): BaselineEnvironmentIdentity {
  const object = requireObject(operation, input, field);
  exactKeys(operation, object, [
    'schemaVersion', 'environmentRef', 'definitionRevision', 'toolchain', 'platform',
    'allowedVariables', 'coverage', 'unknownFields',
  ], `${field}.`);
  if (object.schemaVersion !== 1) fail(operation, 'invalid_input', `${field}.schemaVersion`, '只支持环境身份 schemaVersion=1', object.schemaVersion);
  if (object.environmentRef !== null && typeof object.environmentRef !== 'string') {
    fail(operation, 'invalid_input', `${field}.environmentRef`, '必须是环境引用或 null', object.environmentRef);
  }
  if (object.definitionRevision !== null && typeof object.definitionRevision !== 'string') {
    fail(operation, 'invalid_input', `${field}.definitionRevision`, '必须是环境定义版本或 null', object.definitionRevision);
  }
  const toolchainObject = requireObject(operation, object.toolchain, `${field}.toolchain`);
  const toolchain: Record<string, string | null> = {};
  for (const [name, version] of Object.entries(toolchainObject)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name) || /token|secret|password|credential|key/i.test(name)) {
      fail(operation, 'invalid_input', `${field}.toolchain`, '工具链键名必须是公开身份且不得表示凭据', name);
    }
    if (version !== null && typeof version !== 'string') {
      fail(operation, 'invalid_input', `${field}.toolchain.${name}`, '工具链版本必须是字符串或 null', version);
    }
    toolchain[name] = version as string | null;
  }
  const platformObject = requireObject(operation, object.platform, `${field}.platform`);
  exactKeys(operation, platformObject, ['os', 'arch'], `${field}.platform.`);
  for (const name of ['os', 'arch'] as const) {
    if (platformObject[name] !== null && typeof platformObject[name] !== 'string') {
      fail(operation, 'invalid_input', `${field}.platform.${name}`, '平台字段必须是字符串或 null', platformObject[name]);
    }
  }
  const stringList = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length > 128)) {
      fail(operation, 'invalid_input', `${field}.${name}`, '必须是有界字符串数组', value);
    }
    return [...new Set(value as string[])];
  };
  return {
    schemaVersion: 1,
    environmentRef: object.environmentRef as string | null,
    definitionRevision: object.definitionRevision as string | null,
    toolchain,
    platform: { os: platformObject.os as string | null, arch: platformObject.arch as string | null },
    allowedVariables: stringList(object.allowedVariables, 'allowedVariables'),
    coverage: stringList(object.coverage, 'coverage'),
    unknownFields: stringList(object.unknownFields, 'unknownFields'),
  };
}

/** §6.2 不可变授权摘要：绑定项目/绑定/代码身份/计划摘要/规范化计划/授权人。 */
export function validateBaselineAuthorizationSummary(
  input: unknown,
  operation: string = 'baselines.get',
): BaselineAuthorizationSummary {
  const field = 'authorization';
  const object = requireObject(operation, input, field);
  exactKeys(
    operation,
    object,
    [
      'projectId',
      'repositoryBindingId',
      'repositoryBindingRevision',
      'codeIdentity',
      'dirtyScope',
      'environmentIdentity',
      'missingFields',
      'policyRevision',
      'planDigest',
      'plan',
      'authorizedBy',
      'authorizedAt',
    ],
    `${field}.`,
  );

  requireField(operation, object, 'projectId', `${field}.projectId`);
  const projectId = requireProjectId(operation, object.projectId, `${field}.projectId`);
  requireField(operation, object, 'repositoryBindingId', `${field}.repositoryBindingId`);
  const repositoryBindingId = requireProjectId(
    operation,
    object.repositoryBindingId,
    `${field}.repositoryBindingId`,
  );
  requireField(operation, object, 'codeIdentity', `${field}.codeIdentity`);
  const codeIdentity = validateBaselineCodeIdentity(
    object.codeIdentity,
    operation,
    `${field}.codeIdentity`,
  );
  const repositoryBindingRevision = object.repositoryBindingRevision === undefined
    ? undefined
    : requireBaselinePositiveInteger(operation, object.repositoryBindingRevision, `${field}.repositoryBindingRevision`);
  const dirtyScope = object.dirtyScope === undefined
    ? undefined
    : validateBaselineDirtyScope(object.dirtyScope, operation, `${field}.dirtyScope`);
  const environmentIdentity = object.environmentIdentity === undefined
    ? undefined
    : validateBaselineEnvironmentIdentity(object.environmentIdentity, operation, `${field}.environmentIdentity`);

  const missingFields = object.missingFields === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(object.missingFields)
        || object.missingFields.some((value) => !['repositoryBindingRevision', 'dirtyScope', 'environmentIdentity'].includes(String(value)))) {
        fail(operation, 'invalid_input', `${field}.missingFields`, '必须是受控历史字段缺口数组', object.missingFields);
      }
      return [...new Set(object.missingFields as string[])] as BaselineHistoricalMissingField[];
    })();

  requireField(operation, object, 'policyRevision', `${field}.policyRevision`);
  const policyRevision = requireSha256(operation, object.policyRevision, `${field}.policyRevision`);
  requireField(operation, object, 'planDigest', `${field}.planDigest`);
  const planDigest = requireSha256(operation, object.planDigest, `${field}.planDigest`);
  requireField(operation, object, 'plan', `${field}.plan`);
  const plan = validateBaselineCheckPlan(object.plan, operation);

  requireField(operation, object, 'authorizedBy', `${field}.authorizedBy`);
  const authorizedBy = object.authorizedBy;
  if (typeof authorizedBy !== 'string' || authorizedBy.trim().length === 0) {
    fail(operation, 'invalid_input', `${field}.authorizedBy`, '必须是非空字符串（principalId）', authorizedBy);
  }
  requireField(operation, object, 'authorizedAt', `${field}.authorizedAt`);
  if (!isIsoUtcDateTime(object.authorizedAt)) {
    fail(operation, 'invalid_input', `${field}.authorizedAt`, '必须是 ISO UTC 时间字符串', object.authorizedAt);
  }
  return {
    projectId,
    repositoryBindingId,
    ...(repositoryBindingRevision === undefined ? {} : { repositoryBindingRevision }),
    codeIdentity,
    ...(dirtyScope === undefined ? {} : { dirtyScope }),
    ...(environmentIdentity === undefined ? {} : { environmentIdentity }),
    ...(missingFields === undefined ? {} : { missingFields }),
    policyRevision,
    planDigest,
    plan,
    authorizedBy,
    authorizedAt: object.authorizedAt,
  };
}

/** §4.2 能力校验：P02-3 只承认 baseline.read/baseline.run，未知能力 unsupported。 */
export function validateBaselineCapability(
  input: unknown,
  operation: string = 'capabilities',
): BaselineCapability {
  if (typeof input !== 'string' || !(BASELINE_CAPABILITIES as readonly string[]).includes(input)) {
    fail(operation, 'unsupported', 'capability', '未知能力（P02-3 只提供 baseline.read/baseline.run）', input, {
      supportedCapabilities: [...BASELINE_CAPABILITIES],
    });
  }
  return input as BaselineCapability;
}

/* ------------------------------------------------------------------ *
 * §7.1/§7.4 分页校验
 * ------------------------------------------------------------------ */

/** baselines.list 查询参数：limit 1..100（默认 20），cursor 为上一页最后 operationId。 */
export function validateBaselineListQuery(input: unknown, operation: string = 'baselines.list'): BaselineListQuery {
  if (input === undefined) {
    return { limit: BASELINE_LIST_DEFAULT_LIMIT };
  }
  const object = requireObject(operation, input, 'query');
  exactKeys(operation, object, ['limit', 'cursor'], 'query.');

  let limit = BASELINE_LIST_DEFAULT_LIMIT;
  if (object.limit !== undefined) {
    if (
      typeof object.limit !== 'number' ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > BASELINE_LIST_MAX_LIMIT
    ) {
      fail(operation, 'invalid_input', 'query.limit', `必须是 1..${BASELINE_LIST_MAX_LIMIT} 的整数`, object.limit);
    }
    limit = object.limit;
  }
  if (object.cursor !== undefined) {
    return { limit, cursor: requireOperationId(operation, object.cursor, 'query.cursor') };
  }
  return { limit };
}

/* ------------------------------------------------------------------ *
 * §8 结果摘要与健康派生（纯函数）
 * ------------------------------------------------------------------ */

export interface BaselineHealthAuthorizationInput {
  readonly repositoryBindingId: string;
  readonly repositoryBindingRevision: number | null;
  readonly codeIdentity: BaselineCodeIdentity;
  readonly dirtyScope: BaselineDirtyScope | null;
  readonly environmentIdentity: BaselineEnvironmentIdentity | null;
  readonly plan: BaselineCheckPlan | null;
}

export interface BaselineHealthCurrentInput {
  readonly repositoryBindingId: string | null;
  readonly repositoryBindingRevision: number | null;
  readonly codeIdentity: BaselineCodeIdentity | null;
  readonly dirtyScope: BaselineDirtyScope | null;
  readonly environmentIdentity: BaselineEnvironmentIdentity | null;
  /** 当前已知检查计划；省略表示调用方无法提供命令配置事实。 */
  readonly plan?: BaselineCheckPlan | null;
}

export interface BaselineCheckHealthInput {
  readonly checkKey?: string;
  readonly status: BaselineCheckStatus;
  readonly required: boolean;
  readonly reasonCode?: BaselineReasonCode;
}

export interface BaselineOperationHealthInput {
  readonly operationId: string;
  readonly kind: 'baseline';
  readonly status: BaselineOperationStatus;
  readonly reasonCode?: BaselineReasonCode;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface BaselineOperationSummaryInput extends BaselineOperationHealthInput {
  readonly checks: readonly BaselineCheckHealthInput[];
}

export interface ProjectHealthInput {
  /** 最近一次**终态**基线操作；无终态操作时 null（非终态在途操作不参与派生）。 */
  readonly operation: BaselineOperationHealthInput | null;
  readonly checks: readonly BaselineCheckHealthInput[];
  /** 最近一次授权的不可变身份；旧记录缺失字段保留为 null。 */
  readonly authorization?: BaselineHealthAuthorizationInput | null;
  /** 当前只读绑定/Git/环境现场；省略表示调用方只要求历史投影。 */
  readonly current?: BaselineHealthCurrentInput;
}

/** §7.4/§7.5 逐项检查分桶计数（total/passed/failed/error/inconclusive/notRun）。 */
export function summarizeBaselineChecks(checks: readonly BaselineCheckHealthInput[]): BaselineCheckCounts {
  let passed = 0;
  let failed = 0;
  let error = 0;
  let inconclusive = 0;
  let notRun = 0;
  for (const check of checks) {
    switch (check.status) {
      case 'passed':
        passed += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'error':
        error += 1;
        break;
      case 'inconclusive':
        inconclusive += 1;
        break;
      case 'not_run':
        notRun += 1;
        break;
    }
  }
  return { total: checks.length, passed, failed, error, inconclusive, notRun };
}

/**
 * §8.2 由最近一次终态操作与逐项结果派生项目健康（注册状态与之严格独立）。
 * - 无终态操作 → not_run（no_baseline）；操作 not_run → not_run（不折算通过）；
 * - 非 completed 的终态操作（failed/cancelled/interrupted）→ unhealthy；
 * - completed 但空检查集 → unhealthy（empty_check_set，空集不判健康）；
 * - 任一取消资格原因（source_changed/evidence_incomplete/output_overflow）→ unhealthy；
 * - 任一 required 检查非 passed（含未执行的 not_run）→ unhealthy；
 * - 其余（所有 required 均 passed 且无取消资格原因）→ healthy。
 * 纯函数：只读入参，不做 I/O。
 */
export function deriveProjectHealth(input: ProjectHealthInput): ProjectHealthSummary {
  const { operation } = input;
  if (operation === null) {
    return {
      status: 'not_run',
      lastBaselineOperationId: null,
      lastCompletedAt: null,
      reasonCode: 'no_baseline',
    };
  }
  const identity = {
    lastBaselineOperationId: operation.operationId,
    lastCompletedAt: operation.endedAt ?? null,
  };
  const history: ProjectHealthHistory = {
    operation: summarizeBaselineOperation({
      ...operation,
      checks: input.checks,
    }),
    checks: input.checks.map((check) => ({ ...check })),
  };
  let result: ProjectHealthSummary;
  if (operation.status === 'not_run') {
    result = { status: 'not_run', ...identity, reasonCode: operation.reasonCode ?? 'empty_check_set', lastBaseline: history };
  } else if (operation.status !== 'completed') {
    result = { status: 'unhealthy', ...identity, reasonCode: operation.reasonCode, lastBaseline: history };
  } else if (input.checks.length === 0) {
    result = { status: 'unhealthy', ...identity, reasonCode: 'empty_check_set', lastBaseline: history };
  } else {
    const disqualifying = input.checks.find(
      (check) => check.reasonCode !== undefined && BASELINE_DISQUALIFYING_REASONS.has(check.reasonCode),
    );
    if (disqualifying !== undefined) {
      result = { status: 'unhealthy', ...identity, reasonCode: disqualifying.reasonCode, lastBaseline: history };
    } else {
      const failingRequired = input.checks.find((check) => check.required && check.status !== 'passed');
      result = failingRequired === undefined
        ? { status: 'healthy', ...identity, reasonCode: undefined, lastBaseline: history }
        : { status: 'unhealthy', ...identity, reasonCode: failingRequired.reasonCode, lastBaseline: history };
    }
  }

  // 没有当前快照时只返回历史事实；真实 overview 会传入只读 Git 事实，
  // 因而不能把历史成功误报为当前成功。
  if (input.current === undefined) return result;
  const reasons: ProjectHealthApplicabilityReason[] = [];
  const authorization = input.authorization;
  const current = input.current;
  if (authorization === undefined || authorization === null) {
    reasons.push('authorization_missing');
  } else {
    if (current.repositoryBindingId === null) reasons.push('binding_identity_changed');
    else if (authorization.repositoryBindingRevision === null) reasons.push('binding_identity_missing');
    else if (authorization.repositoryBindingId !== current.repositoryBindingId
      || authorization.repositoryBindingRevision !== current.repositoryBindingRevision) reasons.push('binding_identity_changed');

    if (current.codeIdentity === null || authorization.codeIdentity === null) reasons.push('code_identity_missing');
    else if (current.codeIdentity.headCommit === null) reasons.push('no_head');
    else if (authorization.codeIdentity.headCommit === null) reasons.push('code_identity_missing');
    else if (current.codeIdentity.headCommit !== authorization.codeIdentity.headCommit
      || current.codeIdentity.workingTreeDigest !== authorization.codeIdentity.workingTreeDigest
      || current.codeIdentity.hasUncommittedChanges !== authorization.codeIdentity.hasUncommittedChanges) reasons.push('source_changed');

    if (authorization.dirtyScope === null || current.dirtyScope === null) reasons.push('dirty_scope_missing');
    else if (authorization.dirtyScope.status !== current.dirtyScope.status) reasons.push('dirty_scope_changed');

    if (authorization.environmentIdentity === null || current.environmentIdentity === null) reasons.push('environment_identity_missing');
    else if (stableCanonicalJson(authorization.environmentIdentity) !== stableCanonicalJson(current.environmentIdentity)) reasons.push('environment_identity_changed');

    if (current.plan !== undefined) {
      if (authorization.plan === null || current.plan === null) reasons.push('command_identity_missing');
      else if (stableCanonicalJson(authorization.plan) !== stableCanonicalJson(current.plan)) reasons.push('check_definition_changed');
    }
  }
  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length === 0) {
    return { ...result, applicability: 'applicable', applicabilityReasons: [] };
  }
  const unknownReasons = new Set<ProjectHealthApplicabilityReason>([
    'authorization_missing', 'binding_identity_missing', 'code_identity_missing',
    'dirty_scope_missing', 'environment_identity_missing', 'command_identity_missing',
  ]);
  const applicability = uniqueReasons.some((reason) => !unknownReasons.has(reason))
    ? 'inapplicable'
    : 'unknown';
  return {
    ...result,
    status: result.status === 'healthy' ? 'unhealthy' : result.status,
    applicability,
    applicabilityReasons: uniqueReasons,
  };
}

/** §7.4 操作摘要：在终态/在途操作身份之上附加逐项计数。 */
export function summarizeBaselineOperation(input: BaselineOperationSummaryInput): BaselineOperationSummary {
  return {
    operationId: input.operationId,
    kind: input.kind,
    status: input.status,
    ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
    createdAt: input.createdAt,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    summary: summarizeBaselineChecks(input.checks),
  };
}

/* ------------------------------------------------------------------ *
 * §6.3 代码身份的工作区摘要（算法与排除表冻结；实现由 fs 适配器供料）
 * ------------------------------------------------------------------ */

/**
 * 工作区摘要的冻结排除目录名（§6.3：至少 .git/node_modules/dist/build/.cache；
 * 在任意层级按目录名排除）。适配器不跟随符号链接（防逃逸与不确定挂载点）；
 * 排除范围随预览结果记录（不假装只检查 commit）。
 */
export const BASELINE_WORKSPACE_EXCLUDED_DIR_NAMES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
] as const;

/** 工作区受管文件条目（适配器采集；path 为 POSIX 相对路径、无前导 ./）。 */
export interface BaselineWorkspaceFileEntry {
  readonly path: string;
  readonly sha256: string;
}

export interface BaselineWorkspaceDigestResult {
  readonly digest: string;
  readonly fileCount: number;
}

/**
 * 工作区摘要纯函数：对已采集条目按路径码点排序后做
 * sha256(stableCanonicalJson([[path, sha256], ...]))；确定性、内容敏感、
 * 覆盖 tracked/untracked（条目集合由适配器决定，含未跟踪源文件与配置）。
 * 重复路径 / 非法形态 → TypeError（适配器编程错误，不折算客户端错误）。
 */
export function computeBaselineWorkingTreeDigest(
  entries: readonly BaselineWorkspaceFileEntry[],
): BaselineWorkspaceDigestResult {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.startsWith('/') ||
      entry.path.includes('\0') ||
      entry.path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new TypeError('工作区条目 path 必须是非空 POSIX 相对路径（无空段/./..）');
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new TypeError('工作区条目 sha256 必须是 64 位小写十六进制');
    }
    if (seen.has(entry.path)) {
      throw new TypeError(`工作区条目路径重复：${entry.path}`);
    }
    seen.add(entry.path);
  }
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const material = stableCanonicalJson(sorted.map((entry) => [entry.path, entry.sha256]));
  return {
    digest: createHash('sha256').update(material, 'utf8').digest('hex'),
    fileCount: sorted.length,
  };
}

/**
 * §5.5/§6 previewDigest：绑定完整输入摘要 —— 计划（argv/cwd 引用/环境引用/
 * timeout/required，即检查政策）与代码身份（HEAD/工作区摘要/脏标记）任一
 * 实质变化都使旧摘要失效（preview_stale）。纯函数。
 */
export function computeBaselinePreviewDigest(
  plan: BaselineCheckPlan,
  codeIdentity: BaselineCodeIdentity,
  context?: BaselinePreviewContext,
): string {
  return createHash('sha256')
    .update(stableCanonicalJson(context === undefined ? { plan, codeIdentity } : { plan, codeIdentity, context }), 'utf8')
    .digest('hex');
}

/* ------------------------------------------------------------------ *
 * §6.3/§6.4 预览与授权核验的窄端口（fs 适配器 / 可信装配供料）
 * ------------------------------------------------------------------ */

/** §6.3 工作区摘要视图（预览结果记录排除范围与受管文件数）。 */
export interface BaselineWorkspaceSummary {
  readonly digest: string;
  readonly fileCount: number;
  readonly excludedDirNames: readonly string[];
}

/** cwd realpath 核验结果：inside=规范绝对路径；missing=不存在；outside=逃逸。 */
export type BaselineCwdResolution =
  | { readonly status: 'inside'; readonly canonicalPath: string }
  | { readonly status: 'missing' }
  | { readonly status: 'outside' };

/**
 * §6.3 工作区读取窄端口（fs 适配器实现）：
 * - readWorkspaceSummary：只读采集 tracked+untracked 受管文件与配置的确定性
 *   摘要（冻结排除表；不跟随符号链接；不执行任何脚本/安装）；
 * - resolveContainedCwd：把 cwdRef 解析为 realpath 规范 cwd 并核验落在仓库根
 *   realpath 之内（符号链接逃逸 → outside；不存在/非目录 → missing）；
 * - probeRelativeTarget：相对目标（如 ./scripts/tool.js）相对仓库内 cwd 的
 *   存在性探测（只探测存在性，不读内容、不执行；argv0 相对脚本警示用）。
 */
export interface BaselineWorkspaceReader {
  readWorkspaceSummary(canonicalRepositoryRoot: string): Promise<BaselineWorkspaceSummary>;
  resolveContainedCwd(
    canonicalRepositoryRoot: string,
    cwdRef: string | null,
  ): Promise<BaselineCwdResolution>;
  probeRelativeTarget(
    canonicalRepositoryRoot: string,
    cwdRef: string | null,
    relativeTarget: string,
  ): Promise<'exists' | 'missing' | 'outside'>;
}

/** §6.4 环境允许列表（只含变量名，永不携带值）。 */
export interface BaselineEnvironmentAllowlist {
  readonly allowedVariables: readonly string[];
  /** 可信装配定义的版本；缺失表示不可比较，不由运行时猜测。 */
  readonly definitionRevision?: string;
  readonly toolchain?: Readonly<Record<string, string | null>>;
  readonly platform?: { readonly os: string | null; readonly arch: string | null };
  readonly coverage?: readonly string[];
  readonly unknownFields?: readonly string[];
}

/**
 * §6.4 环境引用目录窄端口（可信装配注入；生产默认空目录 → 任何
 * environmentRef 都是未获准引用，fail-closed）。解析结果只含变量名；
 * 值的注入属执行域（F-009），本端口不接触任何环境值。
 */
export interface BaselineEnvironmentDirectory {
  resolveEnvironmentRef(environmentRef: string): BaselineEnvironmentAllowlist | null;
}

/**
 * 从获准检查计划和可信环境目录派生可比较的环境身份。它只记录引用、定义
 * 版本、公开工具链和覆盖范围，不读取环境值；overview 与授权执行共用同一算法。
 */
export function snapshotBaselineEnvironmentIdentity(
  plan: BaselineCheckPlan,
  directory: BaselineEnvironmentDirectory,
  platform: { readonly os: string | null; readonly arch: string | null } = {
    os: process.platform,
    arch: process.arch,
  },
): BaselineEnvironmentIdentity {
  const refs = [...new Set(plan.checks.map((check) => check.environmentRef).filter((ref): ref is string => ref !== undefined))];
  const definitions = refs.map((environmentRef) => ({
    environmentRef,
    definition: directory.resolveEnvironmentRef(environmentRef),
  }));
  const allowedVariables = new Set<string>(['PATH']);
  const toolchain: Record<string, string | null> = {};
  const unknownFields: string[] = [];
  const coverage: string[] = ['PATH'];
  for (const { environmentRef, definition } of definitions) {
    if (definition === null) {
      unknownFields.push(`environment:${environmentRef}`);
      continue;
    }
    for (const variable of normalizeBaselineAllowedVariables(definition)) allowedVariables.add(variable);
    coverage.push(`environmentRef:${environmentRef}`);
    for (const [name, version] of Object.entries(definition.toolchain ?? {})) {
      if (toolchain[name] !== undefined && toolchain[name] !== version) toolchain[name] = null;
      else toolchain[name] = version;
    }
    if (definition.definitionRevision === undefined) unknownFields.push(`environmentRevision:${environmentRef}`);
    for (const field of definition.unknownFields ?? []) unknownFields.push(field);
  }
  const revisions = definitions
    .map(({ definition }) => definition?.definitionRevision)
    .filter((value): value is string => value !== undefined);
  const definitionRevision = refs.length === 1 ? (revisions[0] ?? null) : null;
  if (refs.length > 1 && new Set(revisions).size > 1) unknownFields.push('environmentRevision:multiple');
  return {
    schemaVersion: 1,
    environmentRef: refs.length === 1 ? refs[0]! : null,
    definitionRevision,
    toolchain,
    platform,
    allowedVariables: [...allowedVariables].sort(),
    coverage: [...new Set(coverage)].sort(),
    unknownFields: [...new Set(unknownFields)].sort(),
  };
}

/** §6.4 最小默认环境：PATH（继承）+ 获准允许列表变量名。 */
export const BASELINE_MINIMAL_ENVIRONMENT_VARIABLES: ReadonlyArray<string> = Object.freeze(['PATH']);

const ENV_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 核验目录解析出的允许列表（可信装配数据 → 形态错误是编程错误 TypeError）：
 * 变量名必须是 POSIX 环境名、去重、不含 PATH 重复（PATH 恒由最小环境提供）。
 */
export function normalizeBaselineAllowedVariables(
  allowlist: BaselineEnvironmentAllowlist,
): readonly string[] {
  if (allowlist === null || typeof allowlist !== 'object' || !Array.isArray(allowlist.allowedVariables)) {
    throw new TypeError('环境允许列表必须是 { allowedVariables: string[] }');
  }
  const names: string[] = [];
  for (const raw of allowlist.allowedVariables) {
    if (typeof raw !== 'string' || !ENV_VARIABLE_NAME_PATTERN.test(raw)) {
      throw new TypeError(`环境允许列表变量名非法：${String(raw)}`);
    }
    if (!names.includes(raw)) {
      names.push(raw);
    }
  }
  return names.filter((name) => !BASELINE_MINIMAL_ENVIRONMENT_VARIABLES.includes(name));
}

/* ------------------------------------------------------------------ *
 * §6 预览结果形态（回执内嵌 result；非敏感：不含环境值/秘密/路径外信息）
 * ------------------------------------------------------------------ */

export const BASELINE_PREVIEW_WARNING_CODES = [
  'shell_metacharacters_in_argument',
  'argv0_relative_script_missing',
  'working_tree_dirty',
  'no_initial_commit',
] as const;
export type BaselinePreviewWarningCode = (typeof BASELINE_PREVIEW_WARNING_CODES)[number];

export interface BaselinePreviewWarning {
  readonly code: BaselinePreviewWarningCode;
  readonly checkKey?: string;
}

/** 预览逐项检查视图（实际 argv 原样展示；不改写、不解释）。 */
export interface BaselinePreviewCheckView {
  readonly checkKey: string;
  readonly kind: 'command';
  readonly argv: readonly string[];
  readonly cwdRef: string | null;
  /** realpath 规范化后的绝对 cwd（核验落在仓库根内）。 */
  readonly cwd: string;
  readonly environmentRef: string | null;
  /** 非敏感环境摘要：仅变量名（PATH + 获准允许列表），永不携带值。 */
  readonly allowedVariables: readonly string[];
  readonly timeoutMs: number;
  readonly required: boolean;
}

/** §6.3 预览附带的工作区摘要范围（不假装只检查 commit）。 */
export interface BaselinePreviewWorkspaceView {
  readonly excludedDirNames: readonly string[];
  readonly fileCount: number;
}

/** baseline.preview 回执 result（§6 冻结语义 + F-008 实施注记字段）。 */
export interface BaselinePreviewResult {
  readonly previewDigest: string;
  /** 检查政策修订（= planDigest = sha256(stableCanonicalJson(plan))）。 */
  readonly policyRevision: string;
  /** F-005 绑定快照；revision 变化会使旧预览不可授权。 */
  readonly repositoryBindingId: string;
  readonly repositoryBindingRevision: number;
  readonly bindingRecordRevision: number;
  readonly codeIdentity: BaselineCodeIdentity;
  readonly dirtyScope: BaselineDirtyScope;
  readonly environmentIdentity: BaselineEnvironmentIdentity;
  readonly workspace: BaselinePreviewWorkspaceView;
  readonly checks: readonly BaselinePreviewCheckView[];
  readonly warnings: readonly BaselinePreviewWarning[];
}

/** baseline.run 回执 result：decline → not_run 的可查询独立状态。 */
export interface BaselineDeclinedResult {
  readonly operationId: string;
  readonly status: 'not_run';
  readonly reasonCode: 'authorization_rejected';
}

// 保持 isPublicError 的显式引用，供消费方从本模块一并取得判别函数（无额外副作用）。
export { isPublicError };
