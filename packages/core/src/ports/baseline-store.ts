/**
 * F-007（P02-3）基线窄存储端口契约（ports 契约层：记录形态、写输入校验、
 * 持久行列映射、读取端口与原子事务原语接口）。
 *
 * 协议依据：docs/p02-3-onboarding-contract.md
 * - §6.2 不可变授权摘要（insert-only，无 update 路径）；planDigest/policyRevision
 *   = sha256(stableCanonicalJson(规范化检查计划))；
 * - §8.1/§8.3 三轴状态枚举（operation 8 态 / check 5 态 / 受控 reason）；
 * - §8.4 结果写回与收尾：逐项检查终态在独立事务写回；操作终态在全部检查
 *   收尾且进程确认停止后写回；
 * - §9.2/§9.3 事件白名单随迁移 v4 扩展（五类 baseline.* 事件，本模块的
 *   追加原语与 events.ts 的读取映射共用同一形状）；
 * - §10 迁移 v4 四表（baseline_authorizations/baseline_operations/
 *   baseline_check_results/baseline_occupancy；F-007 补充的 occupancy
 *   process_identity 与同项目复合外键见 schema.ts/migrations.ts 注释）；
 * - §13 全局单并发占用（第二个在途操作 → conflict reason='baseline_in_progress'）。
 *
 * 不变量：
 * - 校验先于任何 SQL：全部端口输入为 unknown，经本模块校验器后才进入持久化
 *   路径；校验失败零副作用（StorageError kind='validation'，details 定位字段）；
 * - 授权输入与终态证据不可变：授权只有插入与读取面；检查行种子（获准输入
 *   快照）revision=1，一次性 CAS 收尾（revision 1→2）后任何再收尾（任意
 *   expectedRevision）一律 conflict（迟到执行版本拒绝、终态证据不可覆盖）；
 *   操作终态不可覆盖；未产生的退出码为 null；
 * - 写原语只允许在原子命令事务（单 BEGIN IMMEDIATE）内调用：Git/进程/文件
 *   输出/人审都在事务外，事务内不执行文件流、SDK、Git、网络或长检查；
 * - 读取端口不泄漏驱动会话；持久行列损坏（非法状态/损坏 JSON）显式 corrupt，
 *   不作为有效记录返回；
 * - 时间为应用注入的 UTC 毫秒；稳定 ID（授权/操作/检查行/事件行）由适配器
 *   生成 UUID v4，其中操作 id 即公开 operationId。
 */
import { isUuidV4 } from './commands.js';
import { StorageError } from './errors.js';
import type { StorageEntityRef } from './errors.js';
import {
  BASELINE_AUTHORIZED_EVENT_TYPE,
  BASELINE_CANCELLED_EVENT_TYPE,
  BASELINE_CHECK_COMPLETED_EVENT_TYPE,
  BASELINE_COMPLETED_EVENT_TYPE,
  BASELINE_STARTED_EVENT_TYPE,
} from './events.js';
import {
  BASELINE_CHECK_STATUSES,
  BASELINE_OPERATION_STATUSES,
  BASELINE_REASON_CODES,
  BASELINE_TERMINAL_OPERATION_STATUSES,
  computeBaselinePlanDigest,
  validateBaselineCheckPlan,
  type BaselineCheckPlan,
  type BaselineCheckStatus,
  type BaselineOperationStatus,
  type BaselineReasonCode,
  type BaselineHealthReadStore,
  type ProjectHealthInput,
} from './baseline.js';
import { isPlainObject, validationError } from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 常量与记录形态（应用侧 camelCase；落库列名 snake_case 由适配器映射）
 * ------------------------------------------------------------------ */

/** 全局单并发占用的固定单行字面量（§10/§13；DDL 单例 CHECK 同源）。 */
export const BASELINE_OCCUPANCY_SINGLETON_ID = 'global';

/** P02-3 支持的操作 kind（§10：'baseline'；'init' 预留后续，不在本期写入）。 */
export const BASELINE_OPERATION_KINDS = ['baseline'] as const;
export type BaselineOperationKind = (typeof BASELINE_OPERATION_KINDS)[number];

/** 可恢复进程身份的序列化上限（字节；§13 有限默认值）。 */
export const BASELINE_PROCESS_IDENTITY_MAX_BYTES = 2_048;
/** 进程身份对象的键数上限与键名字符集（受控脱敏：不含值域外的自由文本）。 */
export const BASELINE_PROCESS_IDENTITY_MAX_KEYS = 16;

/** §6.2 不可变授权记录（读取面；plan 为已重新校验的规范化检查计划）。 */
export interface BaselineAuthorizationRecord {
  readonly id: string;
  readonly projectId: string;
  readonly repositoryBindingId: string;
  readonly headCommit: string | null;
  readonly workingTreeDigest: string;
  readonly hasUncommittedChanges: boolean;
  readonly policyRevision: string;
  readonly planDigest: string;
  readonly plan: BaselineCheckPlan;
  readonly authorizedBy: string;
  readonly authorizedAtUtcMs: number;
  readonly createdAtUtcMs: number;
}

/** §8.1 基线操作生命周期记录。 */
export interface BaselineOperationRecord {
  /** = operationId（公开操作身份）。 */
  readonly id: string;
  readonly projectId: string;
  readonly kind: BaselineOperationKind;
  readonly authorizationId: string | null;
  readonly status: BaselineOperationStatus;
  readonly reasonCode: BaselineReasonCode | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

/** §8 逐项检查记录：获准输入快照 +（一次性收尾的）终态证据。 */
export interface BaselineCheckResultRecord {
  readonly id: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly checkKey: string;
  readonly argv: readonly string[];
  readonly cwdRef: string | null;
  readonly environmentRef: string | null;
  readonly timeoutMs: number;
  readonly required: boolean;
  readonly status: BaselineCheckStatus;
  readonly reasonCode: BaselineReasonCode | null;
  /** 未产生的退出码为 null。 */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputArtifactId: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

/** §13 全局占用快照（holder 为 null 表示空闲）。 */
export interface BaselineOccupancySnapshot {
  readonly holderOperationId: string | null;
  readonly acquiredAtUtcMs: number | null;
  readonly heartbeatAtUtcMs: number | null;
  readonly processIdentity: Record<string, unknown> | null;
}

/** §7.4 操作分页结果（稳定键集：operationId 升序）。 */
export interface BaselineOperationPage {
  readonly records: readonly BaselineOperationRecord[];
  readonly nextCursor: string | null;
}

/* ------------------------------------------------------------------ *
 * 校验原语（错误形状与 state-store.ts 一致：StorageError + field/reason）
 * ------------------------------------------------------------------ */

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CHECK_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROCESS_IDENTITY_KEY_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/;
const SIGNAL_PATTERN = /^[A-Z][A-Z0-9_]{0,15}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function requireUtcMs(context: ValidationContext, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(context, field, '必须是 0..2^53-1 的 UTC 毫秒整数', value);
  }
  return value;
}

function optionalUtcMs(
  context: ValidationContext,
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireUtcMs(context, value, field);
}

function requireProjectId(context: ValidationContext, value: unknown, field: string): string {
  if (!isNonEmptyString(value) || value.length > 128 || !/^[^\s]+$/.test(value)) {
    throw validationError(context, field, '必须是稳定项目 ID', value);
  }
  return value;
}

function isReasonCodeValue(value: unknown): value is BaselineReasonCode {
  return typeof value === 'string' && (BASELINE_REASON_CODES as readonly string[]).includes(value);
}

function isSha256HexValue(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

function requireReasonCode(
  context: ValidationContext,
  value: unknown,
): BaselineReasonCode | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isReasonCodeValue(value)) {
    throw validationError(context, 'reasonCode', '必须是受控原因码或 null', value);
  }
  return value;
}

function isOperationStatusValue(value: unknown): value is BaselineOperationStatus {
  return typeof value === 'string' && (BASELINE_OPERATION_STATUSES as readonly string[]).includes(value);
}

function requireOperationStatus(
  context: ValidationContext,
  value: unknown,
): BaselineOperationStatus {
  if (!isOperationStatusValue(value)) {
    throw validationError(context, 'status', '必须是 §8.1 操作状态枚举', value);
  }
  return value;
}

function isCheckStatusValue(value: unknown): value is BaselineCheckStatus {
  return typeof value === 'string' && (BASELINE_CHECK_STATUSES as readonly string[]).includes(value);
}

function requireCheckStatus(context: ValidationContext, value: unknown): BaselineCheckStatus {
  if (!isCheckStatusValue(value)) {
    throw validationError(context, 'status', '必须是 §8.1 检查状态枚举', value);
  }
  return value;
}

function requireExactKeys(
  context: ValidationContext,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw validationError(context, key, '包含未知字段（端口契约不接受前向宽容字段）');
    }
  }
}

/** §6.2 授权插入输入（校验后形态）。 */
export interface ValidatedBaselineAuthorizationInsert {
  readonly projectId: string;
  readonly repositoryBindingId: string;
  readonly headCommit: string | null;
  readonly workingTreeDigest: string;
  readonly hasUncommittedChanges: boolean;
  readonly policyRevision: string;
  readonly planDigest: string;
  readonly plan: BaselineCheckPlan;
  readonly authorizedBy: string;
  readonly authorizedAtUtcMs: number;
}

/**
 * 校验授权插入输入（unknown → 规范化形态）：plan 经 §6.1 校验，planDigest 与
 * policyRevision 必须等于 sha256(stableCanonicalJson(plan))（完整获准输入摘要
 * 自洽）；授权为 insert-only，本模块不提供任何更新输入形态。
 */
export function validateBaselineAuthorizationInsert(
  input: unknown,
  operation = 'BaselineStore.insertBaselineAuthorization',
): ValidatedBaselineAuthorizationInsert {
  const context: ValidationContext = { operation, entity: { type: 'baseline_authorization' } };
  if (!isPlainObject(input)) {
    throw validationError(context, 'input', '必须是对象', input);
  }
  requireExactKeys(context, input, [
    'projectId',
    'repositoryBindingId',
    'codeIdentity',
    'policyRevision',
    'planDigest',
    'plan',
    'authorizedBy',
    'authorizedAtUtcMs',
  ]);
  const projectId = requireProjectId(context, input.projectId, 'projectId');
  const repositoryBindingId = requireProjectId(context, input.repositoryBindingId, 'repositoryBindingId');
  if (!isPlainObject(input.codeIdentity)) {
    throw validationError(context, 'codeIdentity', '必须是代码身份对象', input.codeIdentity);
  }
  requireExactKeys(context, input.codeIdentity, ['headCommit', 'workingTreeDigest', 'hasUncommittedChanges']);
  if (input.codeIdentity.headCommit !== null && input.codeIdentity.headCommit !== undefined) {
    if (
      typeof input.codeIdentity.headCommit !== 'string' ||
      !GIT_COMMIT_PATTERN.test(input.codeIdentity.headCommit)
    ) {
      throw validationError(context, 'codeIdentity.headCommit', '必须是 40 位小写 hex commit 或 null', input.codeIdentity.headCommit);
    }
  }
  if (
    typeof input.codeIdentity.workingTreeDigest !== 'string' ||
    !SHA256_HEX_PATTERN.test(input.codeIdentity.workingTreeDigest)
  ) {
    throw validationError(context, 'codeIdentity.workingTreeDigest', '必须是 64 位小写 hex SHA-256', input.codeIdentity.workingTreeDigest);
  }
  if (typeof input.codeIdentity.hasUncommittedChanges !== 'boolean') {
    throw validationError(context, 'codeIdentity.hasUncommittedChanges', '必须是布尔值', input.codeIdentity.hasUncommittedChanges);
  }
  const plan = validateBaselineCheckPlan(input.plan, operation);
  const expectedDigest = computeBaselinePlanDigest(plan);
  if (!isSha256HexValue(input.planDigest) || input.planDigest !== expectedDigest) {
    throw validationError(
      context,
      'planDigest',
      '必须是 64 位小写 hex SHA-256 且与规范化检查计划的 planDigest 一致（完整获准输入摘要）',
      input.planDigest,
    );
  }
  if (!isSha256HexValue(input.policyRevision) || input.policyRevision !== expectedDigest) {
    throw validationError(
      context,
      'policyRevision',
      '必须是 64 位小写 hex SHA-256 且与规范化检查计划的 planDigest 一致（完整获准输入摘要）',
      input.policyRevision,
    );
  }
  if (!isNonEmptyString(input.authorizedBy) || input.authorizedBy.length > 128) {
    throw validationError(context, 'authorizedBy', '必须是非空 principalId（≤128）', input.authorizedBy);
  }
  return {
    projectId,
    repositoryBindingId,
    headCommit: input.codeIdentity.headCommit === null ? null : (input.codeIdentity.headCommit as string | null),
    workingTreeDigest: input.codeIdentity.workingTreeDigest,
    hasUncommittedChanges: input.codeIdentity.hasUncommittedChanges,
    policyRevision: input.policyRevision,
    planDigest: input.planDigest,
    plan,
    authorizedBy: input.authorizedBy,
    authorizedAtUtcMs: requireUtcMs(context, input.authorizedAtUtcMs, 'authorizedAtUtcMs'),
  };
}

/** §10 操作插入输入（校验后形态）。 */
export interface ValidatedBaselineOperationInsert {
  readonly projectId: string;
  readonly kind: BaselineOperationKind;
  readonly authorizationId: string | null;
  readonly status: BaselineOperationStatus;
  readonly reasonCode: BaselineReasonCode | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
}

/**
 * 校验操作插入输入：not_run 操作不携带授权引用（§10 decline/空集为 NULL）；
 * 授权引用形态必须是 UUID v4（存在性/归属由适配器在同一事务内核对）。
 */
export function validateBaselineOperationInsert(
  input: unknown,
  operation = 'BaselineStore.insertBaselineOperation',
): ValidatedBaselineOperationInsert {
  const context: ValidationContext = { operation, entity: { type: 'baseline_operation' } };
  if (!isPlainObject(input)) {
    throw validationError(context, 'input', '必须是对象', input);
  }
  requireExactKeys(context, input, [
    'projectId',
    'kind',
    'authorizationId',
    'status',
    'reasonCode',
    'startedAtUtcMs',
    'endedAtUtcMs',
  ]);
  const projectId = requireProjectId(context, input.projectId, 'projectId');
  if (input.kind !== 'baseline') {
    throw validationError(context, 'kind', "P02-3 只支持 kind='baseline'", input.kind);
  }
  const status = requireOperationStatus(context, input.status);
  let authorizationId: string | null = null;
  if (input.authorizationId !== null && input.authorizationId !== undefined) {
    if (typeof input.authorizationId !== 'string' || !isUuidV4(input.authorizationId)) {
      throw validationError(context, 'authorizationId', '必须是 UUID v4 或 null', input.authorizationId);
    }
    authorizationId = input.authorizationId;
  }
  if (status === 'not_run' && authorizationId !== null) {
    throw validationError(context, 'authorizationId', 'not_run 操作不携带授权引用（decline/空集为 NULL）');
  }
  return {
    projectId,
    kind: 'baseline',
    authorizationId,
    status,
    reasonCode: requireReasonCode(context, input.reasonCode),
    startedAtUtcMs: optionalUtcMs(context, input.startedAtUtcMs, 'startedAtUtcMs'),
    endedAtUtcMs: optionalUtcMs(context, input.endedAtUtcMs, 'endedAtUtcMs'),
  };
}

/** 一次性 CAS 收尾输入（校验后形态）。 */
export interface ValidatedBaselineCheckFinalization {
  readonly expectedRevision: number;
  readonly status: BaselineCheckStatus;
  readonly reasonCode: BaselineReasonCode | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputArtifactId: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
}

/** 校验检查收尾输入：exitCode/signal 可为 null（未产生即 null）；制品引用为稳定 ID。 */
export function validateBaselineCheckFinalization(
  input: unknown,
  operation = 'BaselineStore.finalizeBaselineCheckResult',
): ValidatedBaselineCheckFinalization {
  const context: ValidationContext = { operation, entity: { type: 'baseline_check_result' } };
  if (!isPlainObject(input)) {
    throw validationError(context, 'input', '必须是对象', input);
  }
  requireExactKeys(context, input, [
    'expectedRevision',
    'status',
    'reasonCode',
    'exitCode',
    'signal',
    'timedOut',
    'outputArtifactId',
    'startedAtUtcMs',
    'endedAtUtcMs',
  ]);
  if (
    typeof input.expectedRevision !== 'number' ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw validationError(context, 'expectedRevision', '必须是 ≥1 的整数（CAS）', input.expectedRevision);
  }
  const status = requireCheckStatus(context, input.status);
  if (input.exitCode !== null && input.exitCode !== undefined) {
    if (
      typeof input.exitCode !== 'number' ||
      !Number.isSafeInteger(input.exitCode) ||
      input.exitCode < 0 ||
      input.exitCode > 2_147_483_647
    ) {
      throw validationError(context, 'exitCode', '必须是非负整数或 null（未产生为 null）', input.exitCode);
    }
  }
  if (input.signal !== null && input.signal !== undefined) {
    if (typeof input.signal !== 'string' || !SIGNAL_PATTERN.test(input.signal)) {
      throw validationError(context, 'signal', '必须是信号名（如 SIGTERM）或 null', input.signal);
    }
  }
  if (typeof input.timedOut !== 'boolean') {
    throw validationError(context, 'timedOut', '必须是布尔值', input.timedOut);
  }
  if (input.outputArtifactId !== null && input.outputArtifactId !== undefined) {
    if (typeof input.outputArtifactId !== 'string' || input.outputArtifactId.trim().length === 0) {
      throw validationError(context, 'outputArtifactId', '必须是稳定制品 ID 或 null', input.outputArtifactId);
    }
  }
  return {
    expectedRevision: input.expectedRevision,
    status,
    reasonCode: requireReasonCode(context, input.reasonCode),
    exitCode: input.exitCode === null || input.exitCode === undefined ? null : input.exitCode,
    signal: input.signal === null || input.signal === undefined ? null : input.signal,
    timedOut: input.timedOut,
    outputArtifactId:
      input.outputArtifactId === null || input.outputArtifactId === undefined
        ? null
        : input.outputArtifactId,
    startedAtUtcMs: optionalUtcMs(context, input.startedAtUtcMs, 'startedAtUtcMs'),
    endedAtUtcMs: optionalUtcMs(context, input.endedAtUtcMs, 'endedAtUtcMs'),
  };
}

/** 操作 CAS 更新输入（校验后形态；undefined 字段表示不变更）。 */
export interface ValidatedBaselineOperationUpdate {
  readonly expectedRevision: number;
  readonly status: BaselineOperationStatus;
  readonly reasonCode: BaselineReasonCode | null | undefined;
  readonly startedAtUtcMs: number | undefined;
  readonly endedAtUtcMs: number | undefined;
}

/** 校验操作 CAS 更新输入：status 必填；reasonCode 显式 null 表示清除。 */
export function validateBaselineOperationUpdate(
  input: unknown,
  operation = 'BaselineStore.updateBaselineOperation',
): ValidatedBaselineOperationUpdate {
  const context: ValidationContext = { operation, entity: { type: 'baseline_operation' } };
  if (!isPlainObject(input)) {
    throw validationError(context, 'input', '必须是对象', input);
  }
  requireExactKeys(context, input, ['expectedRevision', 'status', 'reasonCode', 'startedAtUtcMs', 'endedAtUtcMs']);
  if (
    typeof input.expectedRevision !== 'number' ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw validationError(context, 'expectedRevision', '必须是 ≥1 的整数（CAS）', input.expectedRevision);
  }
  const reasonCode =
    input.reasonCode === undefined ? undefined : requireReasonCode(context, input.reasonCode);
  return {
    expectedRevision: input.expectedRevision,
    status: requireOperationStatus(context, input.status),
    reasonCode,
    startedAtUtcMs:
      input.startedAtUtcMs === undefined ? undefined : requireUtcMs(context, input.startedAtUtcMs, 'startedAtUtcMs'),
    endedAtUtcMs:
      input.endedAtUtcMs === undefined ? undefined : requireUtcMs(context, input.endedAtUtcMs, 'endedAtUtcMs'),
  };
}

/**
 * 校验可恢复进程身份（unknown → 受控 JSON 对象或 null）：普通对象、键受控
 * 字符集、值为字符串/安全整数/布尔/null、序列化有界。进程身份由 Host 侧
 * 受监督进程装配写入（可信来源），本层只保证形态与边界，不解析语义。
 */
export function validateBaselineProcessIdentity(
  input: unknown,
  operation = 'BaselineStore.validateBaselineProcessIdentity',
): Record<string, unknown> | null {
  const context: ValidationContext = { operation, entity: { type: 'baseline_occupancy' } };
  if (input === undefined || input === null) {
    return null;
  }
  if (!isPlainObject(input)) {
    throw validationError(context, 'processIdentity', '必须是 JSON 对象或 null', input);
  }
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.length > BASELINE_PROCESS_IDENTITY_MAX_KEYS) {
    throw validationError(context, 'processIdentity', `键数必须在 1..${BASELINE_PROCESS_IDENTITY_MAX_KEYS}`);
  }
  for (const key of keys) {
    if (!PROCESS_IDENTITY_KEY_PATTERN.test(key)) {
      throw validationError(context, `processIdentity.${key}`, '键名必须匹配 ^[a-z][A-Za-z0-9_]{0,63}$');
    }
    const value = input[key];
    if (typeof value === 'string') {
      if (value.length > 512 || /[\0-\x1f\x7f]/.test(value)) {
        throw validationError(context, `processIdentity.${key}`, '字符串值 ≤512 且不含控制字符');
      }
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        throw validationError(context, `processIdentity.${key}`, '数值必须是安全整数');
      }
      continue;
    }
    if (typeof value === 'boolean' || value === null) {
      continue;
    }
    throw validationError(context, `processIdentity.${key}`, '值必须是字符串/安全整数/布尔/null（不嵌套）');
  }
  const serialized = JSON.stringify(input);
  if (serialized === undefined || serialized.length > BASELINE_PROCESS_IDENTITY_MAX_BYTES) {
    throw validationError(context, 'processIdentity', `序列化不得超过 ${BASELINE_PROCESS_IDENTITY_MAX_BYTES} 字节`);
  }
  return { ...input };
}

/** 占用获取输入（校验后形态）。 */
export interface ValidatedBaselineOccupancyAcquire {
  readonly operationId: string;
  readonly processIdentity: Record<string, unknown> | null;
}

/** 校验占用获取输入：operationId 必须是 UUID v4（存在性由 FK/事务核对）。 */
export function validateBaselineOccupancyAcquire(
  input: unknown,
  operation = 'BaselineStore.acquireBaselineOccupancy',
): ValidatedBaselineOccupancyAcquire {
  const context: ValidationContext = { operation, entity: { type: 'baseline_occupancy' } };
  if (!isPlainObject(input)) {
    throw validationError(context, 'input', '必须是对象', input);
  }
  requireExactKeys(context, input, ['operationId', 'processIdentity']);
  if (typeof input.operationId !== 'string' || !isUuidV4(input.operationId)) {
    throw validationError(context, 'operationId', '必须是 UUID v4（占用持有者操作）', input.operationId);
  }
  return {
    operationId: input.operationId,
    processIdentity: validateBaselineProcessIdentity(input.processIdentity, operation),
  };
}

/** §9.2 基线事件追加输入（判别联合；projectId/aggregateRevision 为公共字段）。 */
export type BaselineEventAppendInput =
  | {
      readonly projectId: string;
      readonly type: typeof BASELINE_AUTHORIZED_EVENT_TYPE;
      readonly operationId: string;
      readonly aggregateRevision: number;
      readonly planDigest: string;
      readonly checkCount: number;
    }
  | {
      readonly projectId: string;
      readonly type: typeof BASELINE_STARTED_EVENT_TYPE;
      readonly operationId: string;
      readonly aggregateRevision: number;
    }
  | {
      readonly projectId: string;
      readonly type: typeof BASELINE_CHECK_COMPLETED_EVENT_TYPE;
      readonly operationId: string;
      readonly aggregateRevision: number;
      readonly checkKey: string;
      readonly status: BaselineCheckStatus;
      readonly reasonCode?: BaselineReasonCode;
    }
  | {
      readonly projectId: string;
      readonly type: typeof BASELINE_COMPLETED_EVENT_TYPE;
      readonly operationId: string;
      readonly aggregateRevision: number;
      readonly status: BaselineOperationStatus;
      readonly reasonCode?: BaselineReasonCode;
      readonly summary: {
        readonly total: number;
        readonly passed: number;
        readonly failed: number;
        readonly error: number;
        readonly inconclusive: number;
        readonly notRun: number;
      };
    }
  | {
      readonly projectId: string;
      readonly type: typeof BASELINE_CANCELLED_EVENT_TYPE;
      readonly operationId: string;
      readonly aggregateRevision: number;
      readonly reasonCode?: BaselineReasonCode;
    };

/** 校验后的基线事件追加（payload 为与 events.ts 读取映射同形的受控对象）。 */
export interface ValidatedBaselineEventAppend {
  readonly projectId: string;
  readonly eventType: string;
  readonly aggregateRevision: number;
  readonly payload: Record<string, unknown>;
}

/**
 * 校验事件追加输入（unknown → 判别联合规范化 payload）：payload 只含 §9.2
 * 受控脱敏键（operationId/planDigest/checkCount/checkKey/status/reasonCode/
 * summary），不含 argv 原文、stderr 原文、路径或秘密；形状与 events.ts 的
 * mapStateEvent 读取映射逐键一致（往返由测试锁定）。
 */
export function validateBaselineEventAppend(
  input: unknown,
  operation = 'BaselineStore.appendBaselineEvent',
): ValidatedBaselineEventAppend {
  const context: ValidationContext = { operation, entity: { type: 'baseline_operation' } };
  if (!isPlainObject(input)) {
    throw validationError(context, 'input', '必须是对象', input);
  }
  const projectId = requireProjectId(context, input.projectId, 'projectId');
  if (
    typeof input.aggregateRevision !== 'number' ||
    !Number.isSafeInteger(input.aggregateRevision) ||
    input.aggregateRevision < 1
  ) {
    throw validationError(context, 'aggregateRevision', '必须是 ≥1 的聚合并发计数', input.aggregateRevision);
  }
  const aggregateRevision = input.aggregateRevision;
  if (typeof input.operationId !== 'string' || !isUuidV4(input.operationId)) {
    throw validationError(context, 'operationId', '必须是 UUID v4', input.operationId);
  }
  const operationId = input.operationId;
  const reasonOf = (): BaselineReasonCode | undefined => {
    if (input.reasonCode === undefined) {
      return undefined;
    }
    if (!isReasonCodeValue(input.reasonCode)) {
      throw validationError(context, 'reasonCode', '必须是受控原因码', input.reasonCode);
    }
    return input.reasonCode;
  };
  switch (input.type) {
    case BASELINE_AUTHORIZED_EVENT_TYPE: {
      requireExactKeys(context, input, ['projectId', 'type', 'operationId', 'aggregateRevision', 'planDigest', 'checkCount']);
      if (typeof input.planDigest !== 'string' || !SHA256_HEX_PATTERN.test(input.planDigest)) {
        throw validationError(context, 'planDigest', '必须是 64 位小写 hex SHA-256', input.planDigest);
      }
      if (
        typeof input.checkCount !== 'number' ||
        !Number.isSafeInteger(input.checkCount) ||
        input.checkCount < 1 ||
        input.checkCount > 64
      ) {
        throw validationError(context, 'checkCount', '必须是 1..64 的整数', input.checkCount);
      }
      return {
        projectId,
        eventType: input.type,
        aggregateRevision,
        payload: { operationId, planDigest: input.planDigest, checkCount: input.checkCount },
      };
    }
    case BASELINE_STARTED_EVENT_TYPE: {
      requireExactKeys(context, input, ['projectId', 'type', 'operationId', 'aggregateRevision']);
      return { projectId, eventType: input.type, aggregateRevision, payload: { operationId } };
    }
    case BASELINE_CHECK_COMPLETED_EVENT_TYPE: {
      requireExactKeys(context, input, ['projectId', 'type', 'operationId', 'aggregateRevision', 'checkKey', 'status', 'reasonCode']);
      if (typeof input.checkKey !== 'string' || !CHECK_KEY_PATTERN.test(input.checkKey)) {
        throw validationError(context, 'checkKey', '必须是 ^[a-z0-9][a-z0-9_-]{0,63}$', input.checkKey);
      }
      const status = requireCheckStatus(context, input.status);
      const reasonCode = reasonOf();
      return {
        projectId,
        eventType: input.type,
        aggregateRevision,
        payload: {
          operationId,
          checkKey: input.checkKey,
          status,
          ...(reasonCode !== undefined ? { reasonCode } : {}),
        },
      };
    }
    case BASELINE_COMPLETED_EVENT_TYPE: {
      requireExactKeys(context, input, ['projectId', 'type', 'operationId', 'aggregateRevision', 'status', 'reasonCode', 'summary']);
      const status = requireOperationStatus(context, input.status);
      const summary = input.summary;
      if (!isPlainObject(summary)) {
        throw validationError(context, 'summary', '必须是检查计数对象', summary);
      }
      requireExactKeys(context, summary, ['total', 'passed', 'failed', 'error', 'inconclusive', 'notRun']);
      for (const key of ['total', 'passed', 'failed', 'error', 'inconclusive', 'notRun'] as const) {
        if (typeof summary[key] !== 'number' || !Number.isSafeInteger(summary[key]) || summary[key] < 0) {
          throw validationError(context, `summary.${key}`, '必须是非负安全整数', summary[key]);
        }
      }
      const reasonCode = reasonOf();
      return {
        projectId,
        eventType: input.type,
        aggregateRevision,
        payload: {
          operationId,
          status,
          ...(reasonCode !== undefined ? { reasonCode } : {}),
          summary: {
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
            error: summary.error,
            inconclusive: summary.inconclusive,
            notRun: summary.notRun,
          },
        },
      };
    }
    case BASELINE_CANCELLED_EVENT_TYPE: {
      requireExactKeys(context, input, ['projectId', 'type', 'operationId', 'aggregateRevision', 'reasonCode']);
      const reasonCode = reasonOf();
      return {
        projectId,
        eventType: input.type,
        aggregateRevision,
        payload: { operationId, ...(reasonCode !== undefined ? { reasonCode } : {}) },
      };
    }
    default:
      throw validationError(context, 'type', '必须是 §9.2 基线事件类型', input.type);
  }
}

/* ------------------------------------------------------------------ *
 * 持久行列映射（损坏显式 corrupt；由适配器把 snake_case 列映射后调用）
 * ------------------------------------------------------------------ */

function corrupt(operation: string, entity: StorageEntityRef, reason: string): never {
  throw new StorageError('corrupt', operation, `${operation}: 持久基线行列损坏（${reason}）`, {
    entity,
    details: { reason },
  });
}

function parseCorruptJson(text: string, operation: string, entity: StorageEntityRef, reason: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new StorageError('corrupt', operation, `${operation}: 持久 JSON 列损坏（${reason}）`, {
      entity,
      details: { reason },
      cause,
    });
  }
}

/* 行列标量类型守卫（损坏即 corrupt；保证严格模式下不携带 unknown 进入记录）。 */
function isNullableRowString(value: unknown): value is string | null {
  return value === null || value === undefined ? value === null : typeof value === 'string';
}

function isNullableRowNumber(value: unknown): value is number | null {
  return value === null || value === undefined ? value === null : typeof value === 'number';
}

function isRowOperationStatus(value: unknown): value is BaselineOperationStatus {
  return typeof value === 'string' && (BASELINE_OPERATION_STATUSES as readonly string[]).includes(value);
}

function isRowCheckStatus(value: unknown): value is BaselineCheckStatus {
  return typeof value === 'string' && (BASELINE_CHECK_STATUSES as readonly string[]).includes(value);
}

function isRowReasonCode(value: unknown): value is BaselineReasonCode {
  return typeof value === 'string' && (BASELINE_REASON_CODES as readonly string[]).includes(value);
}

/**
 * 授权持久行列（适配器已把 plan_json 解析为 plan: unknown）→ 记录。
 * 非法结构/计划/摘要一律 corrupt，不作为有效授权返回。
 */
export function mapBaselineAuthorizationRow(row: unknown): BaselineAuthorizationRecord {
  const operation = 'BaselineStore.mapBaselineAuthorizationRow';
  const entity: StorageEntityRef = { type: 'baseline_authorization' };
  if (!isPlainObject(row)) {
    corrupt(operation, entity, 'not_an_object');
  }
  const digestShape = (value: unknown): value is string =>
    typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
  if (!digestShape(row.workingTreeDigest) || !digestShape(row.policyRevision) || !digestShape(row.planDigest)) {
    corrupt(operation, entity, 'invalid_digest');
  }
  if (
    typeof row.id !== 'string' ||
    typeof row.projectId !== 'string' ||
    typeof row.repositoryBindingId !== 'string' ||
    !isNullableRowString(row.headCommit) ||
    (row.headCommit !== null && !GIT_COMMIT_PATTERN.test(row.headCommit)) ||
    (row.hasUncommittedChanges !== 0 && row.hasUncommittedChanges !== 1) ||
    typeof row.authorizedBy !== 'string' ||
    typeof row.authorizedAtUtcMs !== 'number' ||
    typeof row.createdAtUtcMs !== 'number'
  ) {
    corrupt(operation, entity, 'invalid_row_shape');
  }
  let plan: BaselineCheckPlan;
  try {
    plan = validateBaselineCheckPlan(row.plan, operation);
  } catch {
    corrupt(operation, entity, 'invalid_plan');
  }
  return {
    id: row.id,
    projectId: row.projectId,
    repositoryBindingId: row.repositoryBindingId,
    headCommit: row.headCommit,
    workingTreeDigest: row.workingTreeDigest,
    hasUncommittedChanges: row.hasUncommittedChanges === 1,
    policyRevision: row.policyRevision,
    planDigest: row.planDigest,
    plan,
    authorizedBy: row.authorizedBy,
    authorizedAtUtcMs: row.authorizedAtUtcMs,
    createdAtUtcMs: row.createdAtUtcMs,
  };
}

/** 操作持久行列 → 记录（非法状态/原因码 corrupt）。 */
export function mapBaselineOperationRow(row: unknown): BaselineOperationRecord {
  const operation = 'BaselineStore.mapBaselineOperationRow';
  const entity: StorageEntityRef = { type: 'baseline_operation' };
  if (!isPlainObject(row)) {
    corrupt(operation, entity, 'not_an_object');
  }
  if (!isRowOperationStatus(row.status)) {
    corrupt(operation, entity, 'unknown_status');
  }
  if (row.reasonCode !== null && row.reasonCode !== undefined) {
    if (!isRowReasonCode(row.reasonCode)) {
      corrupt(operation, entity, 'unknown_reason_code');
    }
  }
  if (row.kind !== 'baseline') {
    corrupt(operation, entity, 'unknown_kind');
  }
  if (
    typeof row.id !== 'string' ||
    typeof row.projectId !== 'string' ||
    !isNullableRowString(row.authorizationId) ||
    !isNullableRowNumber(row.startedAtUtcMs) ||
    !isNullableRowNumber(row.endedAtUtcMs) ||
    typeof row.revision !== 'number' ||
    typeof row.createdAtUtcMs !== 'number' ||
    typeof row.updatedAtUtcMs !== 'number'
  ) {
    corrupt(operation, entity, 'invalid_row_shape');
  }
  return {
    id: row.id,
    projectId: row.projectId,
    kind: 'baseline',
    authorizationId: row.authorizationId,
    status: row.status,
    reasonCode: row.reasonCode === null || row.reasonCode === undefined ? null : row.reasonCode,
    startedAtUtcMs: row.startedAtUtcMs,
    endedAtUtcMs: row.endedAtUtcMs,
    revision: row.revision,
    createdAtUtcMs: row.createdAtUtcMs,
    updatedAtUtcMs: row.updatedAtUtcMs,
  };
}

/** 检查持久行列（argv 已解析为 unknown）→ 记录（非法 JSON 数组/状态 corrupt）。 */
export function mapBaselineCheckResultRow(row: unknown): BaselineCheckResultRecord {
  const operation = 'BaselineStore.mapBaselineCheckResultRow';
  const entity: StorageEntityRef = { type: 'baseline_check_result' };
  if (!isPlainObject(row)) {
    corrupt(operation, entity, 'not_an_object');
  }
  if (!isRowCheckStatus(row.status)) {
    corrupt(operation, entity, 'unknown_status');
  }
  if (row.reasonCode !== null && row.reasonCode !== undefined) {
    if (!isRowReasonCode(row.reasonCode)) {
      corrupt(operation, entity, 'unknown_reason_code');
    }
  }
  if (!Array.isArray(row.argv) || row.argv.some((item) => typeof item !== 'string')) {
    corrupt(operation, entity, 'invalid_argv_json');
  }
  if (
    typeof row.id !== 'string' ||
    typeof row.projectId !== 'string' ||
    typeof row.operationId !== 'string' ||
    typeof row.checkKey !== 'string' ||
    !isNullableRowString(row.cwdRef) ||
    !isNullableRowString(row.environmentRef) ||
    typeof row.timeoutMs !== 'number' ||
    (row.required !== 0 && row.required !== 1) ||
    !isNullableRowNumber(row.exitCode) ||
    !isNullableRowString(row.signal) ||
    (row.timedOut !== 0 && row.timedOut !== 1) ||
    !isNullableRowString(row.outputArtifactId) ||
    !isNullableRowNumber(row.startedAtUtcMs) ||
    !isNullableRowNumber(row.endedAtUtcMs) ||
    typeof row.revision !== 'number' ||
    typeof row.createdAtUtcMs !== 'number' ||
    typeof row.updatedAtUtcMs !== 'number'
  ) {
    corrupt(operation, entity, 'invalid_row_shape');
  }
  return {
    id: row.id,
    projectId: row.projectId,
    operationId: row.operationId,
    checkKey: row.checkKey,
    argv: [...row.argv],
    cwdRef: row.cwdRef,
    environmentRef: row.environmentRef,
    timeoutMs: row.timeoutMs,
    required: row.required === 1,
    status: row.status,
    reasonCode: row.reasonCode === null || row.reasonCode === undefined ? null : row.reasonCode,
    exitCode: row.exitCode,
    signal: row.signal,
    timedOut: row.timedOut === 1,
    outputArtifactId: row.outputArtifactId,
    startedAtUtcMs: row.startedAtUtcMs,
    endedAtUtcMs: row.endedAtUtcMs,
    revision: row.revision,
    createdAtUtcMs: row.createdAtUtcMs,
    updatedAtUtcMs: row.updatedAtUtcMs,
  };
}

/** 占用持久行列 → 快照（进程身份 JSON 损坏 corrupt）。 */
export function mapBaselineOccupancyRow(row: unknown): BaselineOccupancySnapshot {
  const operation = 'BaselineStore.mapBaselineOccupancyRow';
  const entity: StorageEntityRef = { type: 'baseline_occupancy' };
  if (!isPlainObject(row)) {
    corrupt(operation, entity, 'not_an_object');
  }
  let processIdentity: Record<string, unknown> | null = null;
  if (row.processIdentity !== null && row.processIdentity !== undefined) {
    if (!isPlainObject(row.processIdentity)) {
      corrupt(operation, entity, 'invalid_process_identity');
    }
    processIdentity = row.processIdentity;
  }
  if (
    !isNullableRowString(row.holderOperationId) ||
    !isNullableRowNumber(row.acquiredAtUtcMs) ||
    !isNullableRowNumber(row.heartbeatAtUtcMs)
  ) {
    corrupt(operation, entity, 'invalid_row_shape');
  }
  return {
    holderOperationId: row.holderOperationId,
    acquiredAtUtcMs: row.acquiredAtUtcMs,
    heartbeatAtUtcMs: row.heartbeatAtUtcMs,
    processIdentity,
  };
}

/** 读取持久 JSON 文本的共享助手（适配器侧复用同一损坏语义）。 */
export function parseBaselineJsonColumn(
  text: string,
  operation: string,
  reason: string,
): unknown {
  return parseCorruptJson(text, operation, { type: 'baseline_operation' }, reason);
}

/** 终态判定（端口公开导出，供适配器/服务共用同一冻结集合）。 */
export function isTerminalBaselineOperation(status: BaselineOperationStatus): boolean {
  return (BASELINE_TERMINAL_OPERATION_STATUSES as readonly string[]).includes(status);
}

/* ------------------------------------------------------------------ *
 * 读取窄端口（不泄漏驱动会话；写原语在原子命令事务上下文）
 * ------------------------------------------------------------------ */

/**
 * F-007 基线窄存储读取端口：操作/授权/检查/占用的只读面与 overview 健康派生
 * 输入（实现 BaselineHealthReadStore，组合根据此装配 §7.3 overview）。
 * 写入只经原子命令事务原语（ports/atomic-commands.ts 的 CommandTransaction
 * 扩展），本端口不提供事务外写入。
 */
export interface BaselineStore extends BaselineHealthReadStore {
  /** Restart inventory; includes terminal holders with unconfirmed stop. */
  listRecoverableBaselineOperations(): readonly BaselineOperationRecord[];
  /** 按 operationId 读取操作；缺失返回 undefined；非法身份为 validation 错误。 */
  getBaselineOperation(operationId: unknown): BaselineOperationRecord | undefined;
  /** §7.4 项目操作分页（operationId 升序键集；query 经 validateBaselineListQuery）。 */
  listBaselineOperations(projectId: unknown, query: unknown): BaselineOperationPage;
  /** 单次操作的逐项检查记录（按 checkKey 升序）；操作不存在为 not_found。 */
  listBaselineCheckResults(operationId: unknown): readonly BaselineCheckResultRecord[];
  /** 按授权 ID 读取不可变授权；缺失返回 undefined。 */
  getBaselineAuthorization(authorizationId: unknown): BaselineAuthorizationRecord | undefined;
  /**
   * P02-3 / F-014（§7.6）：按制品身份反查检查输出制品的所属项目与操作
   * （仅命中 baseline_check_results.output_artifact_id；未命中返回 undefined）。
   */
  findBaselineOutputArtifact(artifactId: unknown):
    | { readonly projectId: string; readonly operationId: string }
    | undefined;
  /** §13 全局占用快照（空闲为 holder:null）。 */
  readBaselineOccupancy(): BaselineOccupancySnapshot;
}
