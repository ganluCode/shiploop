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
import {
  validatePhaseFields,
  validatePlanLabelsFields,
  validateFeaturePlanDecideFields,
} from './plan-store.js';
import type { PlanEntityType, FeaturePlanDecision } from './plan-store.js';
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
 * 线消息结构版本（P03-2 / F-007 起为 5；独立于发现版本 1、线协议版本 1）。
 * 升版依据 P02-2 能力集合变化升版纪律（与 P02-3 / F-006 的 2 → 3、P03-1 /
 * F-009 的 3 → 4 同一理由）：P03-2 的 Task 策略编辑/计划决策/执行输入准备三命令
 *（F-001/F-002/F-006 在 v4 内增量宣告）与 features.approvals 授权查询（F-007
 * 接线）进入握手能力集合，客户端对能力集合做精确相等核验，同版本号改集合
 * 违反「未知字段/集合一律拒绝」纪律，故显式 4 → 5；旧 v4/v3/v2/v1 客户端得到
 * 明确 unsupported_schema_version，不猜测降级。
 */
export const WIRE_MESSAGE_SCHEMA_VERSION = 5 as const;

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
  // P03-1 / F-007：Phase/Feature/Task 纯标签 CAS 编辑能力位（契约 §6.7 定案；
  // 标签是元数据，与计划业务批准语义分离）。
  'plan.labels.write',
  // P03-1 / F-008：未执行草稿的实质计划修订能力位（契约 §6.8 定案；与纯
  // 标签编辑可区分的契约，更新摘要并使旧摘要批准失效）。
  'feature.plan.revise',
  // P03-2 / F-001：Task 策略副本 CAS 编辑能力位（完整 executionConfig 副本
  // 授权编辑；与计划实质修订、纯标签编辑可区分的契约）。
  'task.strategy.write',
  // P03-2 / F-002：计划批准/拒绝决策能力位（绑定当前 planDigest 的决策记录；
  // 批准只确认现有计划，不是启动授权）。
  'feature.plan.decide',
  // P03-2 / F-006：执行输入制品组准备能力位（发布可验证的不可变
  // snapshot/manifest/prompt 并最终重核批准与 Task 输入身份；不创建运行实体）。
  'execution.input.prepare',
  // P03-3 / F-004：执行授权面能力位（与 baseline.preview/run 共享 baseline.run
  // 同一先例）：execution.preview 现在使用；execution.start 启动命令随后续
  // 控制器任务接线同一能力位。预算授权预览不宣称已具备 Runtime 执行能力。
  'execution.start',
  // P03-3 / F-009：批次预算显式修订能力位（增额/延期是新的明确用户授权：
  // 修订只调整当前批准预算，不自动启动或恢复 Run；模型提出的理由或客户端
  // 自声明批准不授予本能力）。
  'execution.budget.revise',
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
  // P03-1 / F-007：纯标签 CAS 编辑（project scope + plan.labels.write；
  // 信封 expectedRevision 为目标实体自身 revision，见契约 §6.7 F-007 定案）。
  'plan.labels.update',
  // P03-1 / F-008：未执行草稿的实质计划修订（project scope +
  // feature.plan.revise；信封 expectedRevision 为 Feature 聚合 revision，
  // 同一写事务内整体替换成员与边，见契约 §6.2/§6.8）。
  'feature.plan.revise',
  // P03-2 / F-001：Task 策略副本 CAS 编辑（project scope + task.strategy.write；
  // 信封 expectedRevision 为目标 Task 自身 revision，同一写事务内重核活动
  // 执行输入保护与能力兼容性）。
  'task.strategy.update',
  // P03-2 / F-002：计划批准/拒绝决策（project scope + feature.plan.decide；
  // 信封 expectedRevision 为 Feature 聚合 revision，同一写事务内记录决策、
  // 更新 planStatus、事件与回执；批准不是启动授权）。
  'feature.plan.decide',
  'task.approval.block',
  // P03-2 / F-006：执行输入制品组准备（project scope + execution.input.prepare；
  // 创建类命令不携带 expectedRevision；采集/组装/发布为事务外 I/O，最终重核、
  // 事件与回执同一短写事务）。
  'execution.input.prepare',
  // P03-3 / F-004：单 Feature 执行 prepare 预览（project scope +
  // execution.start；只读预览：固定单成员范围/完整输入身份 previewDigest/
  // no_work 与阻塞原因；不创建 Batch/Run、不扣预算、不调用 Runtime；预算深
  // 校验在应用层经 ports/execution-budget 完成）。
  'execution.preview',
  // P03-3 / F-005：显式执行启动（project scope + execution.start；创建类不
  // 携带 expectedRevision；payload 冻结 featureIds/budget/previewDigest/
  // retryBatchId?——事务外有界输入核验与只读预览重算，短写事务内重核项目
  // active/Phase 可执行/批准依据/预览身份/活动执行与预算并原子提交
  // Batch/Run/预算修订行/事件与 Work accepted v6 回执）。
  'execution.start',
  // P03-3 / F-009：批次预算显式修订（project scope + execution.budget.revise；
  // 更新类：信封 expectedRevision 为目标 Batch 当前 budget_revision CAS；
  // payload 冻结 batchId/budget/reason——仅增额或延期，短写事务内原子更新
  // 当前预算/追加不可变修订行/脱敏事件与 completed 回执；不自动启动或
  // 恢复 Run，不触碰累计计数与快照）。
  'execution.budget.revise',
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
    // P03-1 / F-007：纯标签 CAS 编辑（docs/p03-1-plan-import-contract.md §6.7）。
    // 信封 expectedRevision 指向目标实体（Phase/Feature/Task）自身 revision；
    // 与实质计划编辑（F-008）是可区分的契约，不是同一命令的两个模式。
    'plan.labels.update': {
      scopeKind: 'project',
      mutation: 'update',
      capability: 'plan.labels.write',
    },
    // P03-1 / F-008：实质计划修订（docs/p03-1-plan-import-contract.md §6.2 更新
    // 条款与 §6.8）。信封 expectedRevision 指向目标 Feature 聚合 revision；
    // 修订在聚合事务内整体替换成员与边（一次 CAS 一次递增）。
    'feature.plan.revise': {
      scopeKind: 'project',
      mutation: 'update',
      capability: 'feature.plan.revise',
    },
    // P03-2 / F-001：Task 策略副本 CAS 编辑（完整 executionConfig 副本授权
    // 编辑）。信封 expectedRevision 指向目标 Task 自身 revision；能力兼容
    // 校验复用可信目录（未装配/空目录 fail-closed）。
    'task.strategy.update': {
      scopeKind: 'project',
      mutation: 'update',
      capability: 'task.strategy.write',
    },
    // P03-4 / F-005：只加人工阻塞；expectedRevision 指向 Task 自身。
    'task.approval.block': { scopeKind: 'project', mutation: 'update', capability: 'feature.plan.decide' },
    // P03-2 / F-002：计划批准/拒绝决策（绑定当前 planDigest）。信封
    // expectedRevision 指向目标 Feature 聚合 revision；决策只记录与更新
    // planStatus，不启动执行、不创建执行实体。
    'feature.plan.decide': {
      scopeKind: 'project',
      mutation: 'update',
      capability: 'feature.plan.decide',
    },
    // P03-2 / F-006：执行输入制品组准备（创建类：不携带 expectedRevision，
    // 不 CAS 任何实体）。采集/组装/发布为事务外 I/O；最终同一写事务内重核
    // 批准/要求/检查政策/Task 策略/权限/制品身份并原子提交事件与回执。
    'execution.input.prepare': {
      scopeKind: 'project',
      mutation: 'create',
      capability: 'execution.input.prepare',
    },
    // P03-3 / F-004：单 Feature 执行 prepare 预览（创建类：不携带
    // expectedRevision；只读预览不 CAS 任何实体，回执承载预览结果）。
    'execution.preview': {
      scopeKind: 'project',
      mutation: 'create',
      capability: 'execution.start',
    },
    'execution.start': { scopeKind: 'project', mutation: 'create', capability: 'execution.start' },
    // P03-3 / F-009：批次预算显式修订（更新类：expectedRevision=目标 Batch
    // 当前 budget_revision；增额/延期是新的明确授权，与启动能力分离）。
    'execution.budget.revise': {
      scopeKind: 'project',
      mutation: 'update',
      capability: 'execution.budget.revise',
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

/**
 * P03-1 / F-007 纯标签 CAS 编辑 payload：entityType（phase/feature/task）+ 目标
 * 实体稳定 ID + 完整标签集合；严格未知键拒绝（需求/依赖/验收/状态/批准/标题/
 * revision 等一律不能经本编辑面进入，与实质计划编辑可区分）。
 */
export interface ValidatedPlanLabelsUpdatePayload {
  readonly entityType: PlanEntityType;
  readonly id: string;
  readonly labels: string[];
}

/**
 * P03-1 / F-008 实质计划修订 payload：featureId 为目标 Feature 稳定 ID；plan 为
 * 修订后的完整计划载荷（结构深校验由应用层修订事务复用 F-001 纯校验器完成，
 * 事务内以真实库内解析重核归属/引用/CAS/活动保护，见
 * application/feature-plan-revise）。严格未知键拒绝：planStatus/approval/
 * revision 等一律不能经请求输入（批准失效由服务端批准有效性规则决定）。
 */
export interface ValidatedFeaturePlanRevisePayload {
  readonly featureId: string;
  readonly plan: unknown;
}

/**
 * P03-2 / F-001 Task 策略副本 CAS 编辑 payload：taskId 为目标 Task 稳定 ID；
 * executionConfig 为完整策略副本 JSON 对象（schemaVersion=2 条目；结构深校验
 * 由应用层编辑事务复用 F-003 validateTaskExecutionConfig 完成，与计划导入/
 * 修订同一分层纪律）。严格未知键拒绝：configSource/configSourceKey/status/
 * planStatus/approval/revision 等服务端决定字段不能经请求输入（编辑后来源
 * 由服务端定值为 task_edit，不接受请求声明）。
 */
export interface ValidatedTaskStrategyUpdatePayload {
  readonly taskId: string;
  readonly executionConfig: Record<string, unknown>;
}

/**
 * P03-2 / F-002 计划批准/拒绝决策 payload：featureId 为目标 Feature 稳定 ID；
 * planDigest 为提交时绑定的当前计划摘要（失效即 fail-closed）；decision 为
 * approve/reject；reason 为可选适用原因。严格未知键拒绝：decisionActor/
 * principalId/approval/status/planStatus/revision 等服务端决定字段（含身份）
 * 一律不能经请求输入——actor 只能来自可信主体装配。
 */
export interface ValidatedFeaturePlanDecidePayload {
  readonly featureId: string;
  readonly planDigest: string;
  readonly decision: FeaturePlanDecision;
  readonly reason: string | null;
}

/**
 * P03-2 / F-006 执行输入准备 payload：featureId/taskId 为目标稳定 ID；items
 * 为必需输入采集清单（purpose + source；深校验在应用层复用
 * ports/execution-input 契约，携带用途身份的错误定位）。严格未知键拒绝：
 * snapshot/manifest/prompt/permissions/approval/decisionId 等服务端决定字段
 * 一律不能经请求输入。
 */
export interface ValidatedExecutionInputPreparePayload {
  readonly featureId: string;
  readonly taskId: string;
  /** 必需输入采集清单（可为空数组；逐项深校验在应用层）。 */
  readonly items: readonly Record<string, unknown>[];
}

/**
 * P03-3 / F-004 执行预览 payload：featureIds 为选中范围（稳定 ID 清单；本阶段
 * 形态上限 16 防无界数组，空范围 → no_work、多成员 → 应用层结构化拒绝，
 * 不静默截断）；budget 为完整有限预算提案（Batch + Run 两层；深校验在应用层
 * 复用 ports/execution-budget 权威校验器）。严格未知键拒绝：previewDigest/
 * summary/blocked 等服务端决定字段一律不能经请求输入。
 */
export interface ValidatedExecutionPreviewPayload {
  readonly featureIds: readonly string[];
  /** 完整预算提案（深校验在应用层；此处只保证 JSON 对象形态）。 */
  readonly budget: Record<string, unknown>;
}

/**
 * P03-3 / F-005 显式执行启动 payload：两种互斥形态。新授权形态 featureIds 固定
 * 单成员（空范围/多成员结构化拒绝——启动必须携带明确目标），budget 为完整
 * 有限预算提案（深校验在应用层复用 ports/execution-budget 权威校验器），
 * previewDigest 为用户确认的预览摘要（服务端重算比对，漂移 preview_stale）；
 * 同父 Batch 显式重试形态只携带 featureIds + retryBatchId（预算/预览摘要缺席：
 * 重试共享父预算，工作身份由 workKey 绑定，不携带新授权依据）。严格未知键
 * 拒绝：batchId/runId/status/runsCreated 等服务端决定字段一律不能经请求输入。
 */
export type ValidatedExecutionStartPayload =
  | {
      readonly featureIds: readonly string[];
      readonly budget: Record<string, unknown>;
      readonly previewDigest: string;
      readonly retryBatchId: null;
    }
  | {
      readonly featureIds: readonly string[];
      readonly budget: null;
      readonly previewDigest: null;
      readonly retryBatchId: string;
    };

/**
 * P03-3 / F-009 批次预算显式修订 payload：batchId 定位目标（归属与 CAS 在事务
 * 内重核），budget 为修订后的完整预算快照（深校验在应用层复用
 * ports/execution-budget 权威校验器——仅增额或延期），reason 为非空有界修订
 * 理由（审计）。严格未知键拒绝：approvedBy/principalId（身份由服务端绑定）、
 * revision/version（CAS 唯一权威在信封顶层 expectedRevision）、tokenUsed/
 * costUsed/status/runsCreated（用量与状态不是修订输入）、Task 上限字段
 * （Task maxCodeAttempts 显式调整只经 task.strategy.update 策略 CAS 通道）。
 */
export interface ValidatedExecutionBudgetRevisePayload {
  readonly batchId: string;
  /** 修订后的完整预算快照（深校验在应用层；此处只保证 JSON 对象形态）。 */
  readonly budget: Record<string, unknown>;
  readonly reason: string;
}

interface EnvelopeCommon {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
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
    })
  // P03-1 / F-007：纯标签 CAS 编辑命令信封（expectedRevision=目标实体自身
  // revision；payload 只含 entityType/id/labels，契约 §6.7）。
  | (EnvelopeCommon & {
      readonly operation: 'plan.labels.update';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: number;
      readonly payload: ValidatedPlanLabelsUpdatePayload;
    })
  // P03-1 / F-008：实质计划修订命令信封（expectedRevision=目标 Feature 聚合
  // revision；payload 只含 featureId/plan，契约 §6.2 更新条款与 §6.8）。
  | (EnvelopeCommon & {
      readonly operation: 'feature.plan.revise';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: number;
      readonly payload: ValidatedFeaturePlanRevisePayload;
    })
  // P03-2 / F-001：Task 策略副本 CAS 编辑命令信封（expectedRevision=目标
  // Task 自身 revision；payload 只含 taskId/executionConfig）。
  | (EnvelopeCommon & {
      readonly operation: 'task.strategy.update';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: number;
      readonly payload: ValidatedTaskStrategyUpdatePayload;
    })
  // P03-4 / F-005：人工阻塞命令（expectedRevision=目标 Task revision）。
  | (EnvelopeCommon & {
      readonly operation: 'task.approval.block';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: number;
      readonly payload: { readonly taskId: string; readonly planDigest: string };
    })
  // P03-2 / F-002：计划批准/拒绝决策命令信封（expectedRevision=目标 Feature）。
  | (EnvelopeCommon & {
      readonly operation: 'feature.plan.decide';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: number;
      readonly payload: ValidatedFeaturePlanDecidePayload;
    })
  // P03-2 / F-006：执行输入制品组准备命令信封（创建类禁止携带 expectedRevision；
  // payload 只含 featureId/taskId/items，items 深校验在应用层）。
  | (EnvelopeCommon & {
      readonly operation: 'execution.input.prepare';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: null;
      readonly payload: ValidatedExecutionInputPreparePayload;
    })
  // P03-3 / F-004：单 Feature 执行 prepare 预览命令信封（创建类禁止携带
  // expectedRevision；只读预览不 CAS 任何实体；payload 只含 featureIds/budget，
  // budget 深校验在应用层）。
  | (EnvelopeCommon & {
      readonly operation: 'execution.preview';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: null;
      readonly payload: ValidatedExecutionPreviewPayload;
    })
  // P03-3 / F-005：显式执行启动命令信封（创建类禁止携带 expectedRevision；
  // payload 冻结 featureIds/budget/previewDigest/retryBatchId?，预算深校验与
  // 预览重算在应用层；Batch/Run/事件与 Work accepted v6 回执同一短写事务）。
  | (EnvelopeCommon & {
      readonly operation: 'execution.start';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: null;
      readonly payload: ValidatedExecutionStartPayload;
    })
  // P03-3 / F-009：批次预算显式修订命令信封（更新类必须携带 expectedRevision
  // =目标 Batch 当前 budget_revision；payload 只含 batchId/budget/reason）。
  | (EnvelopeCommon & {
      readonly operation: 'execution.budget.revise';
      readonly scope: { readonly kind: 'project'; readonly projectId: string };
      readonly expectedRevision: number;
      readonly payload: ValidatedExecutionBudgetRevisePayload;
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
const PLAN_LABELS_UPDATE_PAYLOAD_KEYS = ['entityType', 'id', 'labels'] as const;
const FEATURE_PLAN_REVISE_PAYLOAD_KEYS = ['featureId', 'plan'] as const;
const TASK_STRATEGY_UPDATE_PAYLOAD_KEYS = ['taskId', 'executionConfig'] as const;
const FEATURE_PLAN_DECIDE_PAYLOAD_KEYS = ['featureId', 'planDigest', 'decision', 'reason'] as const;
const EXECUTION_INPUT_PREPARE_PAYLOAD_KEYS = ['featureId', 'taskId', 'items'] as const;
const EXECUTION_PREVIEW_PAYLOAD_KEYS = ['featureIds', 'budget'] as const;
/** 执行预览范围的形态上限（防无界数组；本阶段业务上限固定单成员）。 */
export const EXECUTION_PREVIEW_FEATURE_IDS_MAX = 16;

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

function validatePlanLabelsUpdatePayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedPlanLabelsUpdatePayload {
  const object = requireObject(operation, raw, 'payload');
  // 严格未知键拒绝：只接受标签编辑面（entityType/id/labels）；expectedRevision
  // 唯一权威来源是信封顶层；需求/依赖/状态等字段不属于本契约（payload 内出现
  // 即未知键，定位 payload.<key>）。
  exactKeys(operation, object, PLAN_LABELS_UPDATE_PAYLOAD_KEYS, 'payload.');
  try {
    return validatePlanLabelsFields(object, operation);
  } catch (error) {
    throw fromProjectValidatorError(error, operation);
  }
}

function validateFeaturePlanRevisePayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedFeaturePlanRevisePayload {
  const object = requireObject(operation, raw, 'payload');
  // 严格未知键拒绝：只接受修订面（featureId/plan）；expectedRevision 唯一
  // 权威来源是信封顶层（Feature 聚合 CAS）；planStatus/approval/status/
  // revision 等服务端决定字段一律不能经请求输入（payload 内出现即未知键）。
  exactKeys(operation, object, FEATURE_PLAN_REVISE_PAYLOAD_KEYS, 'payload.');
  if (!isPlainObjectPayload(object.plan)) {
    fail(operation, 'invalid_input', 'payload.plan', '必须是 JSON 对象', object.plan);
  }
  try {
    return {
      featureId: validateStableId(object.featureId, { operation }, 'payload.featureId'),
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

function validateTaskStrategyUpdatePayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedTaskStrategyUpdatePayload {
  const object = requireObject(operation, raw, 'payload');
  // 严格未知键拒绝：只接受策略编辑面（taskId/executionConfig）；expectedRevision
  // 唯一权威来源是信封顶层（Task 自身 CAS）；configSource/configSourceKey/status/
  // planStatus/approval/revision 等服务端决定字段一律不能经请求输入（payload 内
  // 出现即未知键，定位 payload.<key>）。
  exactKeys(operation, object, TASK_STRATEGY_UPDATE_PAYLOAD_KEYS, 'payload.');
  if (!isPlainObjectPayload(object.executionConfig)) {
    fail(operation, 'invalid_input', 'payload.executionConfig', '必须是 JSON 对象', object.executionConfig);
  }
  try {
    return {
      taskId: validateStableId(object.taskId, { operation }, 'payload.taskId'),
      executionConfig: object.executionConfig,
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

function validateFeaturePlanDecidePayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedFeaturePlanDecidePayload {
  const object = requireObject(operation, raw, 'payload');
  // 严格未知键拒绝：只接受决策面（featureId/planDigest/decision/reason）；
  // expectedRevision 唯一权威来源是信封顶层（Feature 聚合 CAS）；decisionActor/
  // principalId/approval/status/planStatus/revision 等服务端决定字段（含身份）
  // 一律不能经请求输入（payload 内出现即未知键，定位 payload.<key>）。
  exactKeys(operation, object, FEATURE_PLAN_DECIDE_PAYLOAD_KEYS, 'payload.');
  try {
    return validateFeaturePlanDecideFields(object, operation);
  } catch (error) {
    throw fromProjectValidatorError(error, operation);
  }
}

function validateExecutionInputPreparePayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedExecutionInputPreparePayload {
  const object = requireObject(operation, raw, 'payload');
  // 严格未知键拒绝：只接受准备面（featureId/taskId/items）；创建类命令不携带
  // expectedRevision；snapshot/manifest/prompt/permissions/approval 等服务端
  // 决定字段一律不能经请求输入（payload 内出现即未知键，定位 payload.<key>）。
  exactKeys(operation, object, EXECUTION_INPUT_PREPARE_PAYLOAD_KEYS, 'payload.');
  if (!Array.isArray(object.items)) {
    fail(operation, 'invalid_input', 'payload.items', '必须是必需输入采集项数组', object.items);
  }
  for (const [index, item] of (object.items as unknown[]).entries()) {
    if (!isPlainObjectPayload(item)) {
      fail(operation, 'invalid_input', `payload.items[${index}]`, '必须是 JSON 对象', item);
    }
  }
  try {
    return {
      featureId: validateStableId(object.featureId, { operation }, 'payload.featureId'),
      taskId: validateStableId(object.taskId, { operation }, 'payload.taskId'),
      items: object.items as Record<string, unknown>[],
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

function validateExecutionPreviewPayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedExecutionPreviewPayload {
  const object = requireObject(operation, raw, 'payload');
  // 严格未知键拒绝：只接受预览面（featureIds/budget）；创建类命令不携带
  // expectedRevision；previewDigest/summary/blocked/noWorkReason 等服务端决定
  // 字段一律不能经请求输入（payload 内出现即未知键，定位 payload.<key>）。
  exactKeys(operation, object, EXECUTION_PREVIEW_PAYLOAD_KEYS, 'payload.');
  if (!Array.isArray(object.featureIds)) {
    fail(operation, 'invalid_input', 'payload.featureIds', '必须是 Feature 稳定 ID 数组', object.featureIds);
  }
  const featureIds: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of (object.featureIds as unknown[]).entries()) {
    if (typeof candidate !== 'string') {
      fail(operation, 'invalid_input', `payload.featureIds[${index}]`, '必须是稳定 ID 字符串', candidate);
    }
    if (seen.has(candidate)) {
      fail(operation, 'invalid_input', `payload.featureIds[${index}]`, '范围成员重复', candidate, {
        reason: 'duplicate_feature_id',
      });
    }
    seen.add(candidate);
    featureIds.push(candidate);
  }
  if (featureIds.length > EXECUTION_PREVIEW_FEATURE_IDS_MAX) {
    fail(operation, 'invalid_input', 'payload.featureIds',
      `成员数不得超过 ${EXECUTION_PREVIEW_FEATURE_IDS_MAX}（形态上限；本阶段固定单成员）`,
      featureIds.length, { reason: 'limit_exceeded' });
  }
  if (!isPlainObjectPayload(object.budget)) {
    fail(operation, 'invalid_input', 'payload.budget', '必须是 JSON 对象（完整预算提案）', object.budget);
  }
  try {
    for (const [index, id] of featureIds.entries()) {
      featureIds[index] = validateStableId(id, { operation }, `payload.featureIds[${index}]`);
    }
  } catch (error) {
    if (isStorageError(error, 'validation')) {
      throw new PublicError('invalid_input', operation, undefined, {
        details: storageValidationDetails(error.details),
        cause: error,
      });
    }
    throw error;
  }
  return { featureIds, budget: object.budget as Record<string, unknown> };
}

const EXECUTION_START_PAYLOAD_KEYS = ['featureIds', 'budget', 'previewDigest', 'retryBatchId'] as const;
const EXECUTION_BUDGET_REVISE_PAYLOAD_KEYS = ['batchId', 'budget', 'reason'] as const;

/** previewDigest 形态：64 位小写十六进制 SHA-256（与预览结果同一摘要形态）。 */
function validateExecutionStartPreviewDigest(
  operation: AppOperation,
  value: unknown,
): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail(operation, 'invalid_input', 'payload.previewDigest',
      '必须是 64 位小写十六进制的预览摘要（用户确认的 execution.preview 结果）', value);
  }
  return value;
}

function validateExecutionStartPayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedExecutionStartPayload {
  const object = requireObject(operation, raw, 'payload');
  // 严格未知键拒绝：batchId/runId/status/runsCreated 等服务端决定字段不能经
  // 请求输入（身份由服务端派发并在同事务回执返回）。两种互斥形态：
  // - 新授权：{ featureIds, budget, previewDigest }（retryBatchId 可显式 null）；
  // - 同父 Batch 显式重试：{ featureIds, retryBatchId }（预算/预览摘要必须缺席
  //   ——重试共享父预算，工作身份由 workKey 绑定，不携带新授权依据）。
  const hasRetryBatchId =
    Object.prototype.hasOwnProperty.call(object, 'retryBatchId') &&
    object.retryBatchId !== undefined &&
    object.retryBatchId !== null;
  if (hasRetryBatchId) {
    exactKeys(operation, object, ['featureIds', 'retryBatchId'], 'payload.');
    if (typeof object.retryBatchId !== 'string' || !isUuidV4(object.retryBatchId)) {
      fail(operation, 'invalid_input', 'payload.retryBatchId', '必须是 UUID v4（同父 Batch 显式重试）', object.retryBatchId);
    }
    // 复用预览面的 featureIds 校验（合成 budget 占位；仅取回 featureIds）。
    const scope = validateExecutionPreviewPayload(operation, {
      featureIds: object.featureIds,
      budget: {},
    });
    return {
      featureIds: scope.featureIds,
      budget: null,
      previewDigest: null,
      retryBatchId: object.retryBatchId,
    };
  }
  exactKeys(operation, object, EXECUTION_START_PAYLOAD_KEYS, 'payload.');
  if (object.retryBatchId !== undefined && object.retryBatchId !== null) {
    fail(operation, 'invalid_input', 'payload.retryBatchId', '必须是 UUID v4 或缺席/null', object.retryBatchId);
  }
  const scopeIds = validateExecutionPreviewPayload(operation, {
    featureIds: object.featureIds,
    budget: object.budget,
  });
  const previewDigest = validateExecutionStartPreviewDigest(operation, object.previewDigest);
  return {
    featureIds: scopeIds.featureIds,
    budget: scopeIds.budget,
    previewDigest,
    retryBatchId: null,
  };
}

/**
 * P03-3 / F-009 预算修订 payload 校验：严格未知键拒绝（approvedBy/principalId/
 * revision/version/tokenUsed/costUsed/status/runsCreated/Task 上限字段都是未知
 * 键）；batchId 为 UUID v4（执行批次身份由服务端派发）；budget 为 JSON 对象
 * （仅增额或延期的深校验在应用层事务内）；reason 非空有界（≤512 字符）。
 */
function validateExecutionBudgetRevisePayload(
  operation: AppOperation,
  raw: unknown,
): ValidatedExecutionBudgetRevisePayload {
  const object = requireObject(operation, raw, 'payload');
  exactKeys(operation, object, EXECUTION_BUDGET_REVISE_PAYLOAD_KEYS, 'payload.');
  if (typeof object.batchId !== 'string' || !isUuidV4(object.batchId)) {
    fail(operation, 'invalid_input', 'payload.batchId', '必须是 UUID v4（目标执行批次）', object.batchId);
  }
  if (!isPlainObjectPayload(object.budget)) {
    fail(operation, 'invalid_input', 'payload.budget', '必须是 JSON 对象（修订后的完整预算快照）', object.budget);
  }
  if (
    typeof object.reason !== 'string' ||
    object.reason.trim().length === 0 ||
    object.reason.length > 512
  ) {
    fail(operation, 'invalid_input', 'payload.reason', '必须是非空说明（≤512 字符；显式授权理由）', object.reason);
  }
  return {
    batchId: object.batchId,
    budget: object.budget as Record<string, unknown>,
    reason: object.reason,
  };
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
    readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
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
  if (operation === 'plan.labels.update') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: expectedRevision as number,
      payload: validatePlanLabelsUpdatePayload(operation, object.payload),
    };
  }
  if (operation === 'feature.plan.revise') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: expectedRevision as number,
      payload: validateFeaturePlanRevisePayload(operation, object.payload),
    };
  }
  if (operation === 'task.strategy.update') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: expectedRevision as number,
      payload: validateTaskStrategyUpdatePayload(operation, object.payload),
    };
  }
  if (operation === 'task.approval.block') {
    if (scope.kind !== 'project') fail(operation, 'invalid_input', 'scope.kind', 'scope mismatch');
    if (!isPlainObject(object.payload)) fail(operation, 'invalid_input', 'payload', 'expected object');
    const payload = object.payload as Record<string, unknown>;
    if (Object.keys(payload).some(k => !['taskId', 'planDigest'].includes(k))
      || typeof payload.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(payload.planDigest)) {
      fail(operation, 'invalid_input', 'payload', 'invalid approval identity');
    }
    return { ...base, operation, scope: scope as { kind: 'project'; projectId: string }, expectedRevision: expectedRevision as number,
      payload: { taskId: validateStableId(payload.taskId, { operation }, 'taskId'), planDigest: payload.planDigest as string } };
  }
  if (operation === 'feature.plan.decide') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: expectedRevision as number,
      payload: validateFeaturePlanDecidePayload(operation, object.payload),
    };
  }
  if (operation === 'execution.input.prepare') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: null,
      payload: validateExecutionInputPreparePayload(operation, object.payload),
    };
  }
  if (operation === 'execution.preview') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: null,
      payload: validateExecutionPreviewPayload(operation, object.payload),
    };
  }
  if (operation === 'execution.start') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: null,
      payload: validateExecutionStartPayload(operation, object.payload),
    };
  }
  if (operation === 'execution.budget.revise') {
    if (scope.kind !== 'project') {
      fail(operation, 'invalid_input', 'scope.kind', 'scope 种类与操作不匹配');
    }
    return {
      ...base,
      operation,
      scope,
      expectedRevision: expectedRevision as number,
      payload: validateExecutionBudgetRevisePayload(operation, object.payload),
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
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
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

/** Receipt-only extension; command/envelope capabilities remain v5. */
export const WORK_ACCEPTED_SCHEMA_VERSION = 6 as const;
export const WORK_ACCEPTED_OPERATION = 'execution.start' as const;

/** Legacy accepted receipt: operationId references a real baseline operation. */
export interface BaselineAcceptedCommandReceipt extends ReceiptCommon {
  readonly status: 'accepted';
  readonly operationId: string;
}

/** Receipt-only v6 extension; this does not advertise a new command capability. */
export interface WorkAcceptedCommandReceipt extends Omit<ReceiptCommon, 'schemaVersion' | 'operation'> {
  readonly schemaVersion: typeof WORK_ACCEPTED_SCHEMA_VERSION;
  readonly operation: typeof WORK_ACCEPTED_OPERATION;
  readonly status: 'accepted';
  /** Work operation identity is the authorization Batch, never a synthetic baseline. */
  readonly operationId: string;
  readonly batchId: string;
  readonly runId: string;
}

export type AcceptedCommandReceipt = BaselineAcceptedCommandReceipt | WorkAcceptedCommandReceipt;

/** Persisted/wire union: legacy v5 receipts and explicit Work accepted v6 receipts. */
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

function assertReceiptIdentity(input: Omit<ReceiptInputBase, 'operation'> & {
  readonly operation: AppOperation | typeof WORK_ACCEPTED_OPERATION;
}, allowWork = false): void {
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
  // P03-3 / F-005 起 'execution.start' 进入 COMMAND_OPERATION_SPECS：scope
  // 判定统一从操作描述推导（Work accepted 专属 allowWork 分支退役；
  // completed/rejected 的 execution.start 与其他 v5 回执同一 project scope 纪律）。
  void allowWork;
  const scopeKind = COMMAND_OPERATION_SPECS[input.operation]?.scopeKind;
  if (scopeKind === undefined || scopeKind !== input.scope.kind) {
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
 * P03-3 / F-005：execution.start 的重试派发结果是合法 v5 completed 形态，
 * 但 Work 关联字段（batchId/runId）仍仅限 Work accepted v6——completed/
 * rejected 工厂携带即拒绝，防止关联身份经错误状态混入。
 */
function assertNoWorkAssociation(input: object, factory: string): void {
  if ('batchId' in input || 'runId' in input) {
    throw new TypeError(
      `${factory}: completed/rejected 不允许携带 Work 关联字段（Batch/Run 关联仅限 Work accepted v6）`,
    );
  }
}

export function createCompletedReceipt(input: CompletedReceiptInput): CompletedCommandReceipt {
  assertReceiptIdentity(input);
  assertNoWorkAssociation(input, 'createCompletedReceipt');
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
  assertNoWorkAssociation(input, 'createRejectedReceipt');
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
  /** v5 baseline accepted 操作：类型层排除 Work 操作 execution.start（P03-3 /
   * F-005 起 'execution.start' 进入命令白名单，但 Work accepted 仍只能经
   * WorkAcceptedReceiptInput 构造，避免重载歧义与 v5 形态混入）。 */
  readonly operation: Exclude<AppOperation, typeof WORK_ACCEPTED_OPERATION>;
  /** 同事务写入的 baseline_operations 行 id（公开 operationId）。 */
  readonly operationId: string;
}

export interface WorkAcceptedReceiptInput extends Omit<AcceptedReceiptInput, 'operation'> {
  readonly operation: typeof WORK_ACCEPTED_OPERATION;
  readonly batchId: string;
  readonly runId: string;
}

/** Existing factory; v5 baseline identity or explicit v6 Work Batch/Run identity. */
export function createAcceptedReceipt(input: AcceptedReceiptInput): BaselineAcceptedCommandReceipt;
export function createAcceptedReceipt(input: WorkAcceptedReceiptInput): WorkAcceptedCommandReceipt;
export function createAcceptedReceipt(input: AcceptedReceiptInput | WorkAcceptedReceiptInput): AcceptedCommandReceipt {
  assertReceiptIdentity(input, true);
  if (!isUuidV4(input.operationId)) {
    throw new TypeError('accepted 回执的 operationId 必须是 UUID v4');
  }
  const base = {
    commandId: input.commandId,
    principalId: input.principalId,
    scope: input.scope,
    requestDigest: input.requestDigest,
    status: 'accepted' as const,
    operationId: input.operationId,
    issuedAt: input.issuedAt,
    completedAt: input.completedAt,
    replayed: input.replayed ?? false,
  };
  // P03-3 / F-005 起 'execution.start' 进入 AppOperation 白名单：v5 baseline
  // accepted 的 operation 类型层排除 Work 操作，联合判别恢复互斥。
  if (input.operation === WORK_ACCEPTED_OPERATION) {
    if (!isUuidV4(input.batchId) || !isUuidV4(input.runId) || input.operationId !== input.batchId) {
      throw new TypeError('Work accepted requires UUID Batch/Run IDs and operationId = batchId');
    }
    return {
      ...base, schemaVersion: WORK_ACCEPTED_SCHEMA_VERSION, operation: input.operation,
      batchId: input.batchId, runId: input.runId,
    };
  }
  return { ...base, schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION, operation: input.operation };
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
