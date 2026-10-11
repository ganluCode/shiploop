/**
 * F-002 应用命令契约（ports 契约层：类型、常量、纯校验与纯映射函数）。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md
 * - §3.1 四个版本独立：线消息 schemaVersion=2（本模块）与发现版本 1、线协议
 *   版本 1、配置 payload schemaVersion=2 互不联动；
 * - §4.2 九项能力冻结清单与 local-owner；
 * - §5.1 命令信封三态 scope（registration/global/project）、expectedRevision
 *   唯一权威来源（仅更新类必填）、严格未知键拒绝；
 * - §5.3 回执 accepted/completed/rejected：P02-2 全部为同步短事务命令
 *   （只产生 completed/rejected）；P02-3 / F-008 起 baseline.run（authorize）
 *   首次启用 accepted 工厂（携带同事务写入的真实 operationId，不伪造）；
 * - §5.4 时效：issuedAt 必填（真实 ISO UTC）、偏差 ±60 000 ms、缺省 TTL
 *   60 000 ms、expiresAt 最大寿命 300 000 ms；时钟由调用方注入；
 * - §5.7 StorageError / RepositoryInspectionError / 未预期异常到稳定公开错误的
 *   唯一映射；details 只保留受控脱敏键；
 * - §6 六个命令与 payload 白名单，注册/元数据/配置校验复用 P01 既有校验器。
 *
 * 纯度不变量：
 * - 只做结构校验与数据映射，不读时钟文件系统/网络/数据库，不生成随机值
 *   （resultRef 生成在 F-006 的提交边界），不导入 HTTP/SSE/ORM/Pi SDK；
 * - 校验失败一律抛 PublicError（携带字段定位），错误不回显输入值、认证头、
 *   payload 原文或堆栈；客户端传入的 actorId/principal/capabilities/scope
 *   提权字段按未知键拒绝，永不成为可信身份来源。
 */
import { isStorageError, StorageError } from './errors.js';
import { validatePhaseFields } from './plan-store.js';
import { RepositoryInspectionError } from './repository-inspector.js';
import type { RepositoryInspectionErrorKind } from './repository-inspector.js';
import { validateSettingsPayload } from './settings-schema.js';
import type { SettingsPayload } from './settings-schema.js';
import { validateCreateProjectInput, validateUpdateProjectInput } from './state-store.js';
import { validateStableId } from './validation.js';

/* ------------------------------------------------------------------ *
 * 版本与路由级操作身份
 * ------------------------------------------------------------------ */

/**
 * 线消息结构版本（P02-3 / F-006 起为 3；独立于发现版本 1、线协议版本 1）。
 * 升版依据 docs/p02-3-onboarding-contract.md §3.1：握手能力视图（§11.3）自
 * F-006 起新增 projects.inspect/overview 查询，客户端对能力集合做精确相等
 * 核验，同版本号改集合违反「未知字段/集合一律拒绝」纪律，故显式 2 → 3。
 */
export const WIRE_MESSAGE_SCHEMA_VERSION = 3 as const;

/**
 * 命令提交路由的操作身份：信封结构/版本/操作名在定位到具体 §6 命令之前，
 * 公开错误以本常量作为 operation；定位后改用具体命令名（如 project.register）。
 */
export const COMMANDS_SUBMIT_OPERATION = 'commands.submit' as const;

/* ------------------------------------------------------------------ *
 * §4.2 能力冻结清单
 * ------------------------------------------------------------------ */

export const APP_CAPABILITIES = [
  'project.register',
  'project.read',
  'project.metadata.write',
  'settings.global.read',
  'settings.global.write',
  'settings.project.read',
  'settings.project.write',
  'receipts.read',
  'events.read',
  // P02-3（docs/p02-3-onboarding-contract.md §4.2）新增两项基线能力位。
  'baseline.read',
  'baseline.run',
  // P03-1 / F-004：计划域写入能力位（Phase 创建；后续 Phase/计划写命令
  // 能力命名随对应功能冻结，见 docs/p03-1-plan-import-contract.md §6）。
  'phase.write',
  // P03-1 / F-005：单 Feature 计划导入能力位（命名按契约 §6.1 示例定案）。
  'feature.plan.import',
] as const;

export type AppCapability = (typeof APP_CAPABILITIES)[number];

/** 生产装配固定本机主体字面量（绑定发生在 Host 可信装配层，不经请求传入）。 */
export const LOCAL_OWNER_PRINCIPAL_ID = 'local-owner';

/** local-owner 持有全部冻结能力（P02-2 九项 + P02-3 两项 + P03-1 / F-004 一项）；受限主体只允许由可信测试装配显式构造（F-004/F-005）。 */
export const LOCAL_OWNER_CAPABILITIES: ReadonlySet<AppCapability> = Object.freeze(
  new Set<AppCapability>(APP_CAPABILITIES),
);

/* ------------------------------------------------------------------ *
 * §6 命令白名单与操作描述
 * ------------------------------------------------------------------ */

export const COMMAND_OPERATIONS = [
  'project.register',
  'project.metadata.update',
  'settings.global.create',
  'settings.global.update',
  'settings.project.create',
  'settings.project.update',
  // P02-3 / F-008（docs/p02-3-onboarding-contract.md §6）：基线命令。preview/run
  // 随 F-008 落地；baseline.cancel 随 F-014（编排/停止核验 F-010/F-012 已具备）
  // 进入白名单，取消执行经应用层注入的取消端口完成，回执仍走同一幂等机制
  //（payload 深校验在应用服务层经 ports/baseline.ts 完成，避免本模块反向依赖）。
  'baseline.preview',
  'baseline.run',
  'baseline.cancel',
  // P03-1 / F-004：Phase 创建（project scope + phase.write；创建类命令，
  // 不携带 expectedRevision；关闭/重开/归档生命周期不在本版本）。
  'phase.create',
  // P03-1 / F-005：单 Feature 计划导入（project scope + feature.plan.import；
  // 信封 expectedRevision 为目标 Phase 聚合 CAS，见契约 §6.2 F-005 定案）。
  'feature.plan.import',
] as const;

export type AppOperation = (typeof COMMAND_OPERATIONS)[number];

export type CommandScopeKind = 'registration' | 'global' | 'project';

export type CommandScope =
  | { readonly kind: 'registration' }
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string };

export type CommandMutation = 'create' | 'update';

export interface CommandOperationSpec {
  readonly scopeKind: CommandScopeKind;
  readonly mutation: CommandMutation;
  readonly capability: AppCapability;
}

/** 每个命令的 scope/变更类型/所需能力；未知操作不获得描述即 501 unsupported。 */
export const COMMAND_OPERATION_SPECS: Readonly<Record<AppOperation, CommandOperationSpec>> =
  Object.freeze({
    'project.register': { scopeKind: 'registration', mutation: 'create', capability: 'project.register' },
    'project.metadata.update': {
      scopeKind: 'project',
      mutation: 'update',
      capability: 'project.metadata.write',
    },
    'settings.global.create': {
      scopeKind: 'global',
      mutation: 'create',
      capability: 'settings.global.write',
    },
    'settings.global.update': {
      scopeKind: 'global',
      mutation: 'update',
      capability: 'settings.global.write',
    },
    'settings.project.create': {
      scopeKind: 'project',
      mutation: 'create',
      capability: 'settings.project.write',
    },
    'settings.project.update': {
      scopeKind: 'project',
      mutation: 'update',
      capability: 'settings.project.write',
    },
    // §4.3：基线命令一律 project scope + baseline.run 能力；创建语义
    // （expectedRevision 必须缺席——基线 CAS 纪律由 payload.previewDigest
    // 承载，见 §5.5 幂等矩阵与 §16 F-008 实施注记）。
    'baseline.preview': { scopeKind: 'project', mutation: 'create', capability: 'baseline.run' },
    'baseline.run': { scopeKind: 'project', mutation: 'create', capability: 'baseline.run' },
    // F-014：取消同样要求 baseline.run 能力 + 目标项目可见（§4.3），且归属
    // 核验（操作属于该可见项目）由应用层取消端口完成。
    'baseline.cancel': { scopeKind: 'project', mutation: 'create', capability: 'baseline.run' },
    // P03-1 / F-004：Phase 创建归属 Phase 聚合（docs/p03-1-plan-import-contract.md §6.1）。
    'phase.create': { scopeKind: 'project', mutation: 'create', capability: 'phase.write' },
    // P03-1 / F-005：计划导入在目标 Phase 聚合上追加成员（Feature 聚合本身为
    // 新建，服务端生成 revision=1，不建立第二 CAS 权威），信封 expectedRevision
    // 必填且指向 Phase 聚合当前 revision（docs/p03-1-plan-import-contract.md §6.2）。
    'feature.plan.import': {
      scopeKind: 'project',
      mutation: 'update',
      capability: 'feature.plan.import',
    },
  });

/* ------------------------------------------------------------------ *
 * §5.4 时效预算（有限契约值，非用户可配）
 * ------------------------------------------------------------------ */

/** issuedAt 与服务端时钟允许偏差（毫秒）。 */
export const COMMAND_CLOCK_SKEW_MS = 60_000;
/** expiresAt 缺席时的缺省有效期（自 issuedAt 起）。 */
export const COMMAND_DEFAULT_TTL_MS = 60_000;
/** expiresAt 相对 issuedAt 的最大寿命。 */
export const COMMAND_MAX_LIFESPAN_MS = 300_000;

/* ------------------------------------------------------------------ *
 * §5.7 公开结构化错误
 * ------------------------------------------------------------------ */

export const PUBLIC_ERROR_CODES = [
  'invalid_input',
  'unsupported_schema_version',
  'command_expired',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'resource_busy',
  'corrupt_state',
  'unsupported',
  'internal',
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

const HTTP_STATUS_BY_PUBLIC_CODE: Readonly<Record<PublicErrorCode, number>> = Object.freeze({
  invalid_input: 400,
  unsupported_schema_version: 400,
  command_expired: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  resource_busy: 409,
  corrupt_state: 500,
  unsupported: 501,
  internal: 500,
});

/**
 * §5.7 公开错误码的唯一 HTTP 状态映射（纯函数，无 I/O）。
 * Host 传输面（F-011）据此渲染错误响应与 rejected 回执的 HTTP 状态，
 * 不允许传输面另立第二份映射表。
 */
export function publicErrorHttpStatus(code: PublicErrorCode): number {
  return HTTP_STATUS_BY_PUBLIC_CODE[code];
}

const DEFAULT_MESSAGE_BY_PUBLIC_CODE: Readonly<Record<PublicErrorCode, string>> = Object.freeze({
  invalid_input: '请求未通过结构校验',
  unsupported_schema_version: '不支持的线消息 schema 版本',
  command_expired: '命令已过期',
  unauthorized: '认证失败',
  forbidden: '授权被拒绝',
  not_found: '资源不存在',
  conflict: '请求冲突',
  resource_busy: '资源占用中，请稍后重试',
  corrupt_state: '持久状态损坏或版本不受支持',
  unsupported: '请求的能力未实现',
  internal: '内部错误',
});

/** 错误序列化形状（进入回执 error 字段或错误响应体）：绝不含 stack/cause。 */
export interface PublicErrorShape {
  readonly code: PublicErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PublicErrorOptions {
  /** 受控诊断字段：只允许 field/reason/receivedType/revision/支持列表等非秘密值。 */
  readonly details?: Readonly<Record<string, unknown>>;
  /** 因果链仅保留在进程内，绝不进入 toErrorShape()。 */
  readonly cause?: unknown;
}

/**
 * 应用命令/查询面唯一公开错误类型。纯数据，无 I/O；Host 传输层（F-011）
 * 依据 httpStatus 渲染响应，但本类不导入任何 HTTP 类型。
 */
export class PublicError extends Error {
  readonly code: PublicErrorCode;
  readonly operation: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: PublicErrorCode,
    operation: string,
    message?: string,
    options: PublicErrorOptions = {},
  ) {
    const finalMessage = message ?? DEFAULT_MESSAGE_BY_PUBLIC_CODE[code];
    super(finalMessage, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PublicError';
    this.code = code;
    this.operation = operation;
    this.details = options.details;
  }

  get httpStatus(): number {
    return HTTP_STATUS_BY_PUBLIC_CODE[this.code];
  }

  /** 脱敏序列化：仅 code/message/details；堆栈、cause、输入原文永不出现。 */
  toErrorShape(): PublicErrorShape {
    const shape: PublicErrorShape = { code: this.code, message: this.message };
    if (this.details !== undefined) {
      (shape as { details?: Readonly<Record<string, unknown>> }).details = this.details;
    }
    return shape;
  }
}

export function isPublicError(value: unknown): value is PublicError;
export function isPublicError<C extends PublicErrorCode>(
  value: unknown,
  code: C,
): value is PublicError & { readonly code: C };
export function isPublicError(value: unknown, code?: PublicErrorCode): boolean {
  return value instanceof PublicError && (code === undefined || value.code === code);
}

/* ------------------------------------------------------------------ *
 * 信封校验
 * ------------------------------------------------------------------ */

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

export function isIsoUtcDateTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 基线命令信封层 payload 形态门槛：必须是 JSON 对象（深校验在应用层）。 */
function isPlainObjectPayload(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

/**
 * 基线 payload 的 undefined 键规范化：线上 JSON 不存在 undefined 值，本函数
 * 把进程内直接提交的对象归一到同一线上形态（丢弃值为 undefined 的键，递归
 * 数组/对象），保证 requestDigest 与后续校验对同一输入得到同一结果。
 */
function normalizeBaselinePayload<T extends Record<string, unknown>>(payload: T): unknown {
  function normalizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(normalizeValue);
    }
    if (isPlainObject(value)) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const item = value[key];
        if (item !== undefined) {
          result[key] = normalizeValue(item);
        }
      }
      return result;
    }
    return value;
  }
  return normalizeValue(payload);
}

function describeValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

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

/**
 * 注册命令 payload（校验后形态）：复用 P01 validateCreateProjectInput 的
 * displayName/description/labels 规范化；repositoryPath 在本层只做字符串类型
 * 把关，绝对路径/存在性/仓库形态由 RepositoryInspector 在写事务之外只读检查。
 */
export interface ValidatedProjectRegisterPayload {
  readonly repositoryPath: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly labels: string[];
}

/** 元数据编辑 payload：至少一个字段；expectedRevision 不允许出现在此处。 */
export interface ValidatedProjectMetadataPayload {
  readonly displayName?: string;
  readonly description?: string | null;
  readonly labels?: string[];
}

/**
 * P03-1 / F-004 Phase 创建 payload：复用计划字段规则（稳定 ID/标题/描述/标签）；
 * id 可缺省（服务端生成 UUID v4 稳定 ID），指定时为调用方稳定 ID；projectId 由
 * 信封 scope 携带，批准/执行结果/主体身份等字段一律未知键拒绝。
 */
export interface ValidatedPhaseCreatePayload {
  readonly id: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly labels: string[];
}

/**
 * P03-1 / F-005 计划导入 payload：phaseId 为目标 Phase 稳定 ID；plan 为单
 * Feature 草稿计划（结构深校验由应用层导入事务复用 F-001 纯校验器完成，
 * 事务内以真实库内解析重核归属/引用/CAS，见 application/feature-plan-import）。
 */
export interface ValidatedFeaturePlanImportPayload {
  readonly phaseId: string;
  readonly plan: unknown;
}

interface EnvelopeCommon {
  readonly schemaVersion: 3;
  readonly commandId: string;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
}

export type ValidatedCommandEnvelope =
  | (EnvelopeCommon & {
      readonly operation: 'project.register';
      readonly scope: { readonly kind: 'registration' };
      readonly expectedRevision: null;
      readonly payload: ValidatedProjectRegisterPayload;
    })
  | (EnvelopeCommon & {
      readonly operation: 'project.metadata.update';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: number;
      readonly payload: ValidatedProjectMetadataPayload;
    })
  | (EnvelopeCommon & {
      readonly operation: 'settings.global.create';
      readonly scope: { readonly kind: 'global' };
      readonly expectedRevision: null;
      readonly payload: SettingsPayload;
    })
  | (EnvelopeCommon & {
      readonly operation: 'settings.global.update';
      readonly scope: { readonly kind: 'global' };
      readonly expectedRevision: number;
      readonly payload: SettingsPayload;
    })
  | (EnvelopeCommon & {
      readonly operation: 'settings.project.create';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: null;
      readonly payload: SettingsPayload;
    })
  | (EnvelopeCommon & {
      readonly operation: 'settings.project.update';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: number;
      readonly payload: SettingsPayload;
    })
  // P02-3 / F-008：基线命令信封（payload 原样透传，深校验在应用层经
  // ports/baseline.ts 完成；.digest 计算对原样 payload 与规范化结果一致）。
  | (EnvelopeCommon & {
      readonly operation: 'baseline.preview';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: null;
      readonly payload: unknown;
    })
  | (EnvelopeCommon & {
      readonly operation: 'baseline.run';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: null;
      readonly payload: unknown;
    })
  | (EnvelopeCommon & {
      readonly operation: 'baseline.cancel';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: null;
      readonly payload: unknown;
    })
  // P03-1 / F-004：Phase 创建命令信封（创建类禁止携带 expectedRevision；
  // payload 只含业务字段，归属由 scope 携带）。
  | (EnvelopeCommon & {
      readonly operation: 'phase.create';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: null;
      readonly payload: ValidatedPhaseCreatePayload;
    })
  // P03-1 / F-005：计划导入命令信封（expectedRevision=目标 Phase 聚合 CAS；
  // plan 深校验在应用层导入事务内复用 validateFeaturePlanInput 完成，本层只
  // 把关 phaseId 形态与 plan 为 JSON 对象——与基线命令同一分层纪律）。
  | (EnvelopeCommon & {
      readonly operation: 'feature.plan.import';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: number;
      readonly payload: ValidatedFeaturePlanImportPayload;
    });

const ENVELOPE_KEYS = [
  'schemaVersion',
  'commandId',
  'operation',
  'scope',
  'expectedRevision',
  'issuedAt',
  'expiresAt',
  'payload',
] as const;

const REGISTER_PAYLOAD_KEYS = ['repositoryPath', 'displayName', 'description', 'labels'] as const;
const METADATA_PAYLOAD_KEYS = ['displayName', 'description', 'labels'] as const;
const PHASE_CREATE_PAYLOAD_KEYS = ['id', 'title', 'description', 'labels'] as const;
const FEATURE_PLAN_IMPORT_PAYLOAD_KEYS = ['phaseId', 'plan'] as const;

/**
 * P01 校验器抛 StorageError(validation)，其字段名面向端口输入（'input'、
 * 'displayName' 等）；命令面统一改写为 payload.* 定位，错误码经 §5.7 同一映射。
 */
function fromProjectValidatorError(error: unknown, operation: AppOperation): PublicError {
  if (!(error instanceof StorageError)) {
    throw error;
  }
  const mapped = mapStorageError(error, { operation });
  const field = mapped.details?.field;
  if (typeof field !== 'string') {
    return mapped;
  }
  const payloadField =
    field === 'input' ? 'payload' : field.startsWith('payload.') ? field : `payload.${field}`;
  const details = { ...(mapped.details ?? {}) };
  details.field = payloadField;
  return new PublicError(mapped.code, operation, mapped.message, { details });
}

function validateScope(
  operation: string,
  value: unknown,
  expected: CommandScopeKind,
): CommandScope {
  const object = requireObject(operation, value, 'scope');
  exactKeys(operation, object, ['kind', 'projectId'], 'scope.');
  const kind = object.kind;
  if (kind !== 'registration' && kind !== 'global' && kind !== 'project') {
    fail(operation, 'invalid_input', 'scope.kind', "必须是 'registration'、'global' 或 'project'", kind);
  }
  if (kind !== expected) {
    fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配', kind, {
      expectedScopeKind: expected,
    });
  }
  const hasProjectId = Object.prototype.hasOwnProperty.call(object, 'projectId');
  if (kind === 'project') {
    if (!hasProjectId) {
      fail(operation, 'invalid_input', 'scope.projectId', '项目 scope 必须携带 projectId');
    }
    try {
      return {
        kind: 'project',
        projectId: validateStableId(object.projectId, { operation }, 'scope.projectId'),
      };
    } catch (error) {
      if (isStorageError(error, 'validation')) {
        throw new PublicError('invalid_input', operation, undefined, {
          details: storageValidationDetails(error.details),
        });
      }
      throw error;
    }
  }
  if (hasProjectId) {
    fail(operation, 'invalid_input', 'scope.projectId', `${kind} scope 不允许携带 projectId`, object.projectId);
  }
  return { kind };
}

function validateTiming(
  operation: string,
  issuedAt: unknown,
  expiresAt: unknown,
): { issuedAt: string; expiresAt: string | null } {
  if (!isIsoUtcDateTime(issuedAt)) {
    fail(operation, 'invalid_input', 'issuedAt', '必须是以 Z 结尾的真实 ISO UTC 时间', issuedAt);
  }
  if (expiresAt === undefined) {
    return { issuedAt, expiresAt: null };
  }
  if (expiresAt === null || !isIsoUtcDateTime(expiresAt)) {
    fail(operation, 'invalid_input', 'expiresAt', '必须是 ISO UTC 时间字符串或省略', expiresAt);
  }
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= issuedMs) {
    fail(operation, 'invalid_input', 'expiresAt', '必须晚于 issuedAt');
  }
  if (expiresMs - issuedMs > COMMAND_MAX_LIFESPAN_MS) {
    fail(
      operation,
      'invalid_input',
      'expiresAt',
      `寿命不得超过 ${COMMAND_MAX_LIFESPAN_MS} ms`,
    );
  }
  return { issuedAt, expiresAt };
}

function validateRegisterPayload(operation: AppOperation, raw: unknown): ValidatedProjectRegisterPayload {
  const object = requireObject(operation, raw, 'payload');
  exactKeys(operation, object, REGISTER_PAYLOAD_KEYS, 'payload.');
  if (typeof object.repositoryPath !== 'string') {
    fail(operation, 'invalid_input', 'payload.repositoryPath', '必须是字符串（本地仓库路径）', object.repositoryPath);
  }
  try {
    const metadata = validateCreateProjectInput(
      {
        displayName: object.displayName,
        description: object.description,
        labels: object.labels,
      },
      operation,
    );
    return {
      repositoryPath: object.repositoryPath,
      displayName: metadata.displayName,
      description: metadata.description,
      labels: metadata.labels,
    };
  } catch (error) {
    throw fromProjectValidatorError(error, operation);
  }
}

function validateMetadataPayload(
  operation: AppOperation,
  raw: unknown,
  expectedRevision: number,
): ValidatedProjectMetadataPayload {
  const object = requireObject(operation, raw, 'payload');
  // expectedRevision 的唯一权威来源是信封顶层；payload 内出现即未知字段。
  exactKeys(operation, object, METADATA_PAYLOAD_KEYS, 'payload.');
  try {
    const validated = validateUpdateProjectInput(
      {
        expectedRevision,
        ...(object.displayName !== undefined ? { displayName: object.displayName } : {}),
        ...(object.description !== undefined ? { description: object.description } : {}),
        ...(object.labels !== undefined ? { labels: object.labels } : {}),
      },
      operation,
    );
    const result: {
      displayName?: string;
      description?: string | null;
      labels?: string[];
    } = {};
    if (validated.displayName !== undefined) {
      result.displayName = validated.displayName;
    }
    if (validated.description !== undefined) {
      result.description = validated.description;
    }
    if (validated.labels !== undefined) {
      result.labels = validated.labels;
    }
    return result satisfies ValidatedProjectMetadataPayload;
  } catch (error) {
    throw fromProjectValidatorError(error, operation);
  }
}

function validatePhaseCreatePayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedPhaseCreatePayload {
  const object = requireObject(operation, raw, 'payload');
  // 严格未知键拒绝：projectId 属于信封 scope；主体/批准/执行结果/状态/revision
  // 等字段不存在于 Phase 创建输入面（不建立第二条提权路径）。
  exactKeys(operation, object, PHASE_CREATE_PAYLOAD_KEYS, 'payload.');
  try {
    return validatePhaseFields(object, operation);
  } catch (error) {
    throw fromProjectValidatorError(error, operation);
  }
}

function validateFeaturePlanImportPayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedFeaturePlanImportPayload {
  const object = requireObject(operation, raw, 'payload');
  // 严格未知键拒绝：projectId 由信封 scope 携带；featureId 由服务端生成，
  // expectedRevision 唯一权威来源是信封顶层（payload 内出现即未知键）。
  exactKeys(operation, object, FEATURE_PLAN_IMPORT_PAYLOAD_KEYS, 'payload.');
  if (!isPlainObjectPayload(object.plan)) {
    fail(operation, 'invalid_input', 'payload.plan', '必须是 JSON 对象', object.plan);
  }
  try {
    return {
      phaseId: validateStableId(object.phaseId, { operation }, 'payload.phaseId'),
      plan: object.plan,
    };
  } catch (error) {
    if (isStorageError(error, 'validation')) {
      throw new PublicError('invalid_input', operation, undefined, {
        details: storageValidationDetails(error.details),
        cause: error,
      });
    }
    throw error;
  }
}

function validateSettingsCommandPayload(
  operation: AppOperation,
  raw: unknown,
  scopeKind: 'global' | 'project',
): SettingsPayload {
  requireObject(operation, raw, 'payload');
  try {
    return validateSettingsPayload(raw, {
      operation,
      entity: { type: scopeKind === 'global' ? 'global_settings' : 'project_settings' },
    });
  } catch (error) {
    if (isStorageError(error)) {
      throw mapStorageError(error, { operation });
    }
    throw error;
  }
}

/**
 * 运行时校验外部命令信封（unknown → 判别联合）。纯函数：不做 I/O、不读时钟
 * （时效相对服务端时钟的判定见 evaluateCommandTiming）、不修改输入。
 *
 * 失败抛 PublicError：结构/类型 → invalid_input（定位到字段）；schemaVersion≠2
 * → unsupported_schema_version；未知操作 → unsupported（details 只列六个实现者）。
 */
export function validateCommandEnvelope(input: unknown): ValidatedCommandEnvelope {
  // 结构/版本/操作名在定位到具体命令前，使用路由级操作身份。
  const submit = COMMANDS_SUBMIT_OPERATION;
  const object = requireObject(submit, input, 'envelope');
  exactKeys(submit, object, ENVELOPE_KEYS);

  for (const field of ['commandId', 'operation', 'scope', 'issuedAt', 'payload'] as const) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) {
      fail(submit, 'invalid_input', field, '缺少必填字段');
    }
  }
  if (!Object.prototype.hasOwnProperty.call(object, 'schemaVersion')) {
    fail(submit, 'invalid_input', 'schemaVersion', '缺少必填字段');
  }

  const schemaVersion = object.schemaVersion;
  if (typeof schemaVersion !== 'number') {
    fail(submit, 'invalid_input', 'schemaVersion', `必须是整数 ${WIRE_MESSAGE_SCHEMA_VERSION}`, schemaVersion);
  }
  // 任何非当前版本的数值版本（含小数）都是未知 schema，不猜测降级。
  if (!Number.isInteger(schemaVersion) || schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    fail(
      submit,
      'unsupported_schema_version',
      'schemaVersion',
      `本版本仅支持线消息 schemaVersion=${WIRE_MESSAGE_SCHEMA_VERSION}`,
      schemaVersion,
      {
        supportedVersion: WIRE_MESSAGE_SCHEMA_VERSION,
      },
    );
  }

  if (!isUuidV4(object.commandId)) {
    fail(submit, 'invalid_input', 'commandId', '必须是 RFC 4122 UUID v4（小写）', object.commandId);
  }
  const commandId = object.commandId;

  const operationName = object.operation;
  if (typeof operationName !== 'string') {
    fail(submit, 'invalid_input', 'operation', '必须是命令名字符串', operationName);
  }
  const spec = COMMAND_OPERATION_SPECS[operationName as AppOperation];
  if (spec === undefined) {
    fail(submit, 'unsupported', 'operation', '未知操作（Work/Chat 等能力本版本不提供）', operationName, {
      supportedOperations: [...COMMAND_OPERATIONS],
    });
  }
  const operation = operationName as AppOperation;

  const scope = validateScope(operation, object.scope, spec.scopeKind);

  const hasRevision = Object.prototype.hasOwnProperty.call(object, 'expectedRevision');
  let expectedRevision: number | null = null;
  if (spec.mutation === 'update') {
    if (!hasRevision || object.expectedRevision === undefined) {
      fail(operation, 'invalid_input', 'expectedRevision', '更新类命令必须提供 ≥1 的整数 CAS 期望修订号');
    }
    const revision = object.expectedRevision;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
      fail(operation, 'invalid_input', 'expectedRevision', '必须是 ≥1 的整数（CAS 期望修订号）', revision);
    }
    expectedRevision = revision;
  } else if (hasRevision && object.expectedRevision !== undefined) {
    fail(operation, 'invalid_input', 'expectedRevision', '创建/注册命令不允许携带 expectedRevision');
  }

  const timing = validateTiming(operation, object.issuedAt, object.expiresAt);

  const base: {
    readonly schemaVersion: 3;
    readonly commandId: string;
    readonly issuedAt: string;
    readonly expiresAt: string | null;
  } = {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId,
    issuedAt: timing.issuedAt,
    expiresAt: timing.expiresAt,
  };

  if (operation === 'project.register') {
    return {
      ...base,
      operation,
      scope: { kind: 'registration' },
      expectedRevision: null,
      payload: validateRegisterPayload(operation, object.payload),
    };
  }
  if (operation === 'project.metadata.update') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    const projectScope = scope;
    return {
      ...base,
      operation,
      scope: projectScope,
      expectedRevision: expectedRevision as number,
      payload: validateMetadataPayload(operation, object.payload, expectedRevision as number),
    };
  }
  if (operation === 'phase.create') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: null,
      payload: validatePhaseCreatePayload(operation, object.payload),
    };
  }
  if (operation === 'feature.plan.import') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: expectedRevision as number,
      payload: validateFeaturePlanImportPayload(operation, object.payload),
    };
  }
  if (operation === 'settings.global.create') {
    return {
      ...base,
      operation,
      scope: { kind: 'global' },
      expectedRevision: null,
      payload: validateSettingsCommandPayload(operation, object.payload, 'global'),
    };
  }
  if (operation === 'settings.global.update') {
    return {
      ...base,
      operation,
      scope: { kind: 'global' },
      expectedRevision: expectedRevision as number,
      payload: validateSettingsCommandPayload(operation, object.payload, 'global'),
    };
  }
  // P02-3 / F-008：基线命令 payload 深校验（检查计划/决策/摘要）由应用层经
  // ports/baseline.ts 完成（本模块不反向依赖）；信封层只要求 payload 为 JSON
  // 对象，保持与其它命令相同的“非法结构先于授权/时效/副作用拒绝”顺序。
  // F-014 起 baseline.cancel 同一处理（payload `{operationId}` 深校验在应用层）。
  if (operation === 'baseline.preview' || operation === 'baseline.run' || operation === 'baseline.cancel') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    if (!isPlainObjectPayload(object.payload)) {
      fail(operation, 'invalid_input', 'payload', '必须是 JSON 对象');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: null,
      payload: normalizeBaselinePayload(object.payload),
    } as ValidatedCommandEnvelope;
  }
  // settings.project.create / settings.project.update
  if (scope.kind !== 'project') {
    fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
  }
  const projectScope = scope;
  return {
    ...base,
    operation,
    scope: projectScope,
    expectedRevision,
    payload: validateSettingsCommandPayload(operation, object.payload, 'project'),
  } as Extract<ValidatedCommandEnvelope, { operation: 'settings.project.create' | 'settings.project.update' }>;
}

/* ------------------------------------------------------------------ *
 * §5.4 时效判定（时钟由调用方注入）
 * ------------------------------------------------------------------ */

export type CommandTimingVerdict =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'clock_skew' };

/**
 * 相对注入的服务端当前毫秒时间判定信封时效：
 * - issuedAt 超前 now 超过 ±COMMAND_CLOCK_SKEW_MS → clock_skew（调用方按
 *   invalid_input 拒绝，定位 issuedAt）；
 * - now 严格晚于有效期（expiresAt 或 issuedAt+COMMAND_DEFAULT_TTL_MS）→ expired
 *   （新 commandId 按 command_expired 拒绝且不写回执；既有回执仍可取回，见 F-007）；
 * - 其余 fresh。
 */
export function evaluateCommandTiming(
  envelope: Pick<ValidatedCommandEnvelope, 'issuedAt' | 'expiresAt'>,
  nowMs: number,
): CommandTimingVerdict {
  const issuedMs = Date.parse(envelope.issuedAt);
  if (issuedMs - nowMs > COMMAND_CLOCK_SKEW_MS) {
    return { kind: 'clock_skew' };
  }
  const effectiveExpiryMs =
    envelope.expiresAt !== null
      ? Date.parse(envelope.expiresAt)
      : issuedMs + COMMAND_DEFAULT_TTL_MS;
  if (nowMs >= effectiveExpiryMs) {
    return { kind: 'expired' };
  }
  return { kind: 'fresh' };
}

/* ------------------------------------------------------------------ *
 * §5.6 resultRef
 * ------------------------------------------------------------------ */

export const RESULT_REF_PREFIX = 'v1.';
const RESULT_REF_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;

/** resultRef：v1. + 43 字符 base64url；不是路径、不含 projectId（生成在 F-006）。 */
export function isValidResultRef(value: unknown): value is string {
  return typeof value === 'string' && RESULT_REF_PATTERN.test(value);
}

/** 路径参数等外部输入的 resultRef 校验；非法值字段级拒绝，不做任何文件解析。 */
export function validateResultRef(value: unknown, operation: string): string {
  if (!isValidResultRef(value)) {
    fail(operation, 'invalid_input', 'resultRef', '必须是 v1. 形态的不透明结果引用', value);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * §5.3 回执
 * ------------------------------------------------------------------ */

export const RECEIPT_STATUSES = ['accepted', 'completed', 'rejected'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** completed 回执内嵌结果的序列化字节上限（§13）。 */
export const RECEIPT_RESULT_MAX_BYTES = 16_384;

interface ReceiptCommon {
  readonly schemaVersion: 3;
  readonly commandId: string;
  readonly principalId: string;
  readonly operation: AppOperation;
  readonly scope: CommandScope;
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
  readonly replayed: boolean;
}

export interface CompletedCommandReceipt extends ReceiptCommon {
  readonly status: 'completed';
  readonly result: unknown;
  readonly resultRef: string;
}

export interface RejectedCommandReceipt extends ReceiptCommon {
  readonly status: 'rejected';
  readonly error: PublicErrorShape;
}

/**
 * P02-3 / F-008（§5.3 首次启用 accepted）：baseline.run（authorize）提交事务内
 * 持久化的异步回执；operationId 指向同事务写入的 baseline_operations 行，
 * 不携带 result/resultRef（结果尚未产生，§5.6）。
 */
export interface AcceptedCommandReceipt extends ReceiptCommon {
  readonly status: 'accepted';
  readonly operationId: string;
}

/** 持久/在线回执判别联合：accepted 仅由 baseline.run authorize 产生。 */
export type CommandReceipt = CompletedCommandReceipt | RejectedCommandReceipt | AcceptedCommandReceipt;

interface ReceiptInputBase {
  readonly commandId: string;
  readonly principalId: string;
  readonly operation: AppOperation;
  readonly scope: CommandScope;
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
  readonly replayed?: boolean;
}

function assertReceiptIdentity(input: ReceiptInputBase): void {
  if (!isUuidV4(input.commandId)) {
    throw new TypeError('回执身份字段不合法：commandId 必须是 UUID v4');
  }
  if (typeof input.principalId !== 'string' || input.principalId.trim().length === 0) {
    throw new TypeError('principalId 必须是非空字符串');
  }
  if (!isSha256Hex(input.requestDigest)) {
    throw new TypeError('requestDigest 必须是 64 位小写十六进制 SHA-256');
  }
  if (!isIsoUtcDateTime(input.issuedAt) || !isIsoUtcDateTime(input.completedAt)) {
    throw new TypeError('issuedAt/completedAt 必须是 ISO UTC 时间');
  }
  const spec = COMMAND_OPERATION_SPECS[input.operation];
  if (spec.scopeKind !== input.scope.kind) {
    throw new TypeError(`scope 与操作 ${input.operation} 不匹配`);
  }
  if (input.scope.kind === 'project') {
    try {
      validateStableId(input.scope.projectId, { operation: input.operation }, 'scope.projectId');
    } catch {
      throw new TypeError('project scope 的 projectId 形态非法');
    }
  }
}

/** 结果必须 JSON 安全且序列化不超过 RECEIPT_RESULT_MAX_BYTES（服务端不变量）。 */
function assertBoundedResult(result: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(result);
  } catch (cause) {
    throw new TypeError('回执 result 必须是 JSON 安全数据', { cause });
  }
  if (new TextEncoder().encode(text).length > RECEIPT_RESULT_MAX_BYTES) {
    throw new TypeError(`回执 result 序列化不得超过 ${RECEIPT_RESULT_MAX_BYTES} 字节`);
  }
}

export interface CompletedReceiptInput extends ReceiptInputBase {
  readonly result: unknown;
  readonly resultRef: string;
}

/**
 * 构造 completed 回执（同步短事务命令提交即完成）。输入全部来自服务端可信
 * 提交边界，非法不变量是编程错误（TypeError），不构造成面向客户端的错误体。
 */
export function createCompletedReceipt(input: CompletedReceiptInput): CompletedCommandReceipt {
  assertReceiptIdentity(input);
  if (!isValidResultRef(input.resultRef)) {
    throw new TypeError('resultRef 形态非法');
  }
  assertBoundedResult(input.result);
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: input.commandId,
    principalId: input.principalId,
    operation: input.operation,
    scope: input.scope,
    requestDigest: input.requestDigest,
    status: 'completed',
    result: input.result,
    resultRef: input.resultRef,
    issuedAt: input.issuedAt,
    completedAt: input.completedAt,
    replayed: input.replayed ?? false,
  };
}

export interface RejectedReceiptInput extends ReceiptInputBase {
  readonly error: PublicError;
}

/** 构造 rejected 回执：错误以脱敏 shape 固化，堆栈/cause 不进入回执。 */
export function createRejectedReceipt(input: RejectedReceiptInput): RejectedCommandReceipt {
  assertReceiptIdentity(input);
  if (!(input.error instanceof PublicError)) {
    throw new TypeError('rejected 回执必须携带 PublicError');
  }
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: input.commandId,
    principalId: input.principalId,
    operation: input.operation,
    scope: input.scope,
    requestDigest: input.requestDigest,
    status: 'rejected',
    error: input.error.toErrorShape(),
    issuedAt: input.issuedAt,
    completedAt: input.completedAt,
    replayed: input.replayed ?? false,
  };
}

export interface AcceptedReceiptInput extends ReceiptInputBase {
  /** 同事务写入的 baseline_operations 行 id（公开 operationId）。 */
  readonly operationId: string;
}

/**
 * 构造 accepted 回执（§5.3 首次启用；仅 baseline.run authorize 提交事务）。
 * operationId 必须指向同事务已写入的操作行；不携带 result/resultRef。
 */
export function createAcceptedReceipt(input: AcceptedReceiptInput): AcceptedCommandReceipt {
  assertReceiptIdentity(input);
  if (!isUuidV4(input.operationId)) {
    throw new TypeError('accepted 回执的 operationId 必须是 UUID v4');
  }
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: input.commandId,
    principalId: input.principalId,
    operation: input.operation,
    scope: input.scope,
    requestDigest: input.requestDigest,
    status: 'accepted',
    operationId: input.operationId,
    issuedAt: input.issuedAt,
    completedAt: input.completedAt,
    replayed: input.replayed ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * §5.7 内部错误 → 公开错误纯映射
 * ------------------------------------------------------------------ */

export interface ErrorMappingContext {
  /** 对外操作身份（如 project.register）；内部方法名不进入公开错误。 */
  readonly operation: string;
}

/**
 * P01 校验器的 reason 既有 snake_case 受控码（stale_dependency），也有不含输入值的
 * 中文固定文案（「必须是字符串」）。两者都不携带秘密/路径/原文，统一要求：非空、
 * ≤200 字符、无控制字符。携带输入值或超长的 reason 一律剔除。
 */
function safeReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\0-\x1f\x7f]/.test(value)
  );
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value);
}

/** StorageError details 只允许这五类受控键通过，其余（sql/path/raw 等）剔除。 */
function storageValidationDetails(details: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (details === undefined) {
    return out;
  }
  if (typeof details.field === 'string' && details.field.length > 0) {
    out.field = details.field;
  }
  if (safeReason(details.reason)) {
    out.reason = details.reason;
  }
  if (typeof details.receivedType === 'string') {
    out.receivedType = details.receivedType;
  }
  return out;
}

function revisionDetails(details: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (details !== undefined) {
    if (safeReason(details.reason)) {
      out.reason = details.reason;
    }
    if (safeInteger(details.expectedRevision)) {
      out.expectedRevision = details.expectedRevision;
    }
    if (safeInteger(details.actualRevision)) {
      out.actualRevision = details.actualRevision;
    }
  }
  if (out.reason === undefined) {
    out.reason = 'conflict';
  }
  return out;
}

function withEntityType(
  details: Record<string, unknown>,
  entity: { readonly type?: string } | undefined,
): Record<string, unknown> {
  if (entity !== undefined && typeof entity.type === 'string') {
    return { ...details, entityType: entity.type };
  }
  return details;
}

/**
 * StorageError → 公开错误（§5.7 表）。保留操作身份由 context 提供，实体仅保留
 * 类型（不保留 id/projectId，避免经错误体泄漏存在性）；内部方法名、消息原文、
 * SQL、路径与持久 JSON 原文一律丢弃。
 */
export function mapStorageError(error: StorageError, context: ErrorMappingContext): PublicError {
  const { operation } = context;
  switch (error.kind) {
    case 'validation':
      return new PublicError('invalid_input', operation, undefined, {
        details: storageValidationDetails(error.details),
        cause: error,
      });
    case 'not_found':
      return new PublicError('not_found', operation, undefined, {
        details: withEntityType({}, error.entity),
        cause: error,
      });
    case 'conflict':
      return new PublicError('conflict', operation, undefined, {
        details: withEntityType(revisionDetails(error.details), error.entity),
        cause: error,
      });
    case 'ownership':
      return new PublicError('forbidden', operation, undefined, {
        details: withEntityType({ reason: 'ownership_denied' }, error.entity),
        cause: error,
      });
    case 'busy':
      return new PublicError('resource_busy', operation, undefined, {
        details: withEntityType({ reason: 'storage_busy' }, error.entity),
        cause: error,
      });
    case 'unsupported_version':
      return new PublicError('corrupt_state', operation, undefined, {
        details: { reason: 'unsupported_version' },
        cause: error,
      });
    case 'corrupt':
      return new PublicError('corrupt_state', operation, undefined, {
        details: {
          ...(safeReason(error.details?.reason) ? { reason: error.details?.reason } : { reason: 'corrupt_state' }),
        },
        cause: error,
      });
    default: {
      // 穷尽性保护：未来新增 kind 不允许静默折算。
      const exhaustive: never = error.kind;
      throw new TypeError(`未覆盖的 StorageErrorKind: ${String(exhaustive)}`);
    }
  }
}

/** 仓库检查错误 kind → 公开码/受控 reason（§5.7，F-002 表驱动定稿）。 */
const REPOSITORY_ERROR_MAPPING: Readonly<
  Record<
    RepositoryInspectionErrorKind,
    { readonly code: PublicErrorCode; readonly reason: string }
  >
> = Object.freeze({
  // 输入形态/路径不存在/非目录/非仓库：客户可修正的 400，reason 为受控码，不回显路径。
  invalid_input: { code: 'invalid_input', reason: 'repository_invalid_input' },
  not_found: { code: 'invalid_input', reason: 'repository_path_not_found' },
  not_a_directory: { code: 'invalid_input', reason: 'repository_not_a_directory' },
  not_a_repository: { code: 'invalid_input', reason: 'repository_not_a_repository' },
  // 瞬时资源条件：409，客户端可在新命令中重试。
  timeout: { code: 'resource_busy', reason: 'repository_timeout' },
  io: { code: 'resource_busy', reason: 'repository_io' },
  // 环境类缺陷（Git 缺失/权限拒绝）：500，不伪装成客户输入错误。
  unavailable: { code: 'internal', reason: 'git_unavailable' },
  permission: { code: 'internal', reason: 'repository_permission' },
});

/**
 * RepositoryInspectionError → 公开错误。invalid_input 种类保留其受控 snake_case
 * reason（path_not_absolute 等），其余种类使用上表固定 reason；exitCode/signal/
 * stderr/路径全部不进入公开错误。
 */
export function mapRepositoryInspectionError(
  error: RepositoryInspectionError,
  context: ErrorMappingContext,
): PublicError {
  const mapping = REPOSITORY_ERROR_MAPPING[error.kind];
  let reason = mapping.reason;
  if (error.kind === 'invalid_input' && safeReason(error.details?.reason)) {
    reason = error.details?.reason as string;
  }
  return new PublicError(mapping.code, context.operation, undefined, {
    details: { reason },
    cause: error,
  });
}

/** 未预期异常 → internal(500)：固定脱敏文案，cause 仅进程内保留；本函数绝不抛出。 */
export function mapUnexpectedError(error: unknown, context: ErrorMappingContext): PublicError {
  return new PublicError('internal', context.operation, undefined, { cause: error });
}

/**
 * 应用边界统一映射：已是 PublicError 原样传递；StorageError/仓库检查错误按
 * §5.7 分类；其余全部折算 internal（不向客户端泄漏内部错误类型）。
 */
export function mapToPublicError(error: unknown, context: ErrorMappingContext): PublicError {
  if (error instanceof PublicError) {
    return error;
  }
  if (error instanceof StorageError) {
    return mapStorageError(error, context);
  }
  if (error instanceof RepositoryInspectionError) {
    return mapRepositoryInspectionError(error, context);
  }
  return mapUnexpectedError(error, context);
}
