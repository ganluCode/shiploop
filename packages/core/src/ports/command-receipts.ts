/**
 * F-006 命令回执持久化契约（ports 纯契约层）：稳定请求摘要、resultRef 生成、
 * command_receipts 持久行列映射、重放判定与 CommandReceiptStore 窄端口。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md
 * - §5.2 requestDigest 冻结算法：stableCanonicalJson（键按 UTF-16 码点递归升序、
 *   无空白、数组保序）+ SHA-256 小写 hex；commandId 不进摘要（它是幂等键本身）；
 *   摘要由服务端从规范化信封重算，信封不携带 digest；认证秘密不进摘要输入；
 * - §5.3 回执：本版本全部为同步短事务命令，持久回执只有 completed/rejected
 *   （accepted 仅前向兼容枚举，任何代码路径不得持久化 accepted）；
 * - §5.5 幂等矩阵：同 principal + commandId + 同摘要 → 原回执（replayed:true）；
 *   同 commandId 不同摘要 → 409 conflict（details.reason='idempotency_key_reuse'）；
 *   不同 principal 使用同一 commandId 互相独立（复合唯一键 principal_id+command_id）；
 * - §5.6 resultRef：`v1.` + 43 字符 base64url（32 字节密码学随机），由提交事务
 *   生成并建唯一索引；不是数据库定位符、不是文件路径、不含 projectId/路径信息；
 * - §10 迁移 v3 command_receipts：project_id 可空 + scope CHECK（仅
 *   registration/global 允许 NULL，依据 §15.1），不建 operations 表。
 *
 * 纯度不变量：
 * - 只做确定性计算与数据映射：node:crypto SHA-256 与 node:buffer base64url 均为
 *   确定性纯函数；不读时钟/文件系统/网络/数据库，不自行生成随机值（resultRef
 *   的熵由调用方注入），不导入 HTTP/SSE/ORM/Pi SDK；
 * - stableCanonicalJson 与 P02-1 Host 契约（packages/host/src/contract/identifiers.ts）
 *   的 §10.3 算法逐字节一致——Host 与 HostClient 共用 Host 侧实现，Core 服务端
 *   重算使用本实现；两侧算法的等价性由固定摘要测试向量锁定（任一漂移立即失败）；
 * - 持久行列映射显式失败：结构损坏/未知操作/scope 不一致/持久化 accepted 一律
 *   corrupt_state（reason='corrupt_receipt_row'），不静默跳过、不伪造回执；
 * - 端口输入一律为 unknown 并经运行时校验（StorageError kind='validation'）；
 *   校验失败在任何 SQL 之前，不产生持久化副作用。
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  RECEIPT_OPERATION_SPECS,
  PUBLIC_ERROR_CODES,
  RECEIPT_RESULT_MAX_BYTES,
  RESULT_REF_PREFIX,
  WIRE_MESSAGE_SCHEMA_VERSION,
  WORK_ACCEPTED_SCHEMA_VERSION,
  WORK_ACCEPTED_OPERATION,
  PublicError,
  isIsoUtcDateTime,
  isUuidV4,
  isValidResultRef,
} from './commands.js';
import type {
  ReceiptOperation,
  AcceptedCommandReceipt,
  CommandReceipt,
  CommandScope,
  CommandScopeKind,
  CompletedCommandReceipt,
  PublicErrorCode,
  PublicErrorShape,
  RejectedCommandReceipt,
  ValidatedCommandEnvelope,
} from './commands.js';
import { StorageError } from './errors.js';
import {
  describeValueType,
  isPlainObject,
  rejectUnknownKeys,
  requirePlainObject,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * §5.2 稳定规范 JSON 与请求摘要
 * ------------------------------------------------------------------ */

/**
 * 稳定规范 JSON（与 P02-1 §10.3 stableCanonicalJson 同一算法）：
 * 对象键按 UTF-16 码点递归升序、无空白、数组保序；非有限数/bigint/函数/
 * symbol/非普通对象一律抛 TypeError，不静默把 NaN 序列化成 null。
 */
export function stableCanonicalJson(value: unknown): string {
  return stringifyStable(value);
}

function stringifyStable(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('规范 JSON 不接受非有限数（NaN/Infinity）');
    }
    return JSON.stringify(value);
  }
  if (type === 'boolean') {
    return value === true ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyStable(item)).join(',')}]`;
  }
  if (type === 'object') {
    if (!isPlainObject(value)) {
      throw new TypeError('规范 JSON 只接受普通 JSON 对象');
    }
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stringifyStable(value[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`规范 JSON 不接受 ${type} 值`);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * §5.2 请求摘要：sha256(stableCanonicalJson({schemaVersion, operation, scope,
 * expectedRevision, issuedAt, expiresAt, payload}))。输入为已通过
 * validateCommandEnvelope 的规范化信封（expectedRevision/expiresAt 已归一化为
 * 值或 null，payload 已按操作白名单规范化）；commandId 与 principalId 不进摘要。
 *
 * 键顺序不同的等价 JSON 摘要相同；任一业务参数、revision、时间字段不同则摘要
 * 不同。信封含非 JSON 安全数据是调用方编程错误（TypeError），不折算公开错误。
 */
export function computeCommandRequestDigest(envelope: Pick<ValidatedCommandEnvelope, 'schemaVersion' | 'scope' | 'expectedRevision' | 'issuedAt' | 'expiresAt' | 'payload'> & { readonly operation: string }): string {
  return sha256Hex(
    stableCanonicalJson({
      schemaVersion: envelope.schemaVersion,
      operation: envelope.operation,
      scope: envelope.scope,
      expectedRevision: envelope.expectedRevision,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      payload: envelope.payload,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * §5.6 resultRef 生成（熵由提交边界注入）
 * ------------------------------------------------------------------ */

/** resultRef 的密码学随机熵字节数（base64url 后恰为 43 字符）。 */
export const RESULT_REF_ENTROPY_BYTES = 32;

/**
 * 从 32 字节熵构造不透明结果引用（`v1.` + 43 字符 base64url）。纯函数：
 * 熵由提交事务边界（crypto.randomBytes）注入，本函数不自行取随机数。
 * 熵长度不符是编程错误（TypeError），不生成弱引用。
 */
export function createResultRef(entropy: Uint8Array): string {
  if (!(entropy instanceof Uint8Array) || entropy.length !== RESULT_REF_ENTROPY_BYTES) {
    throw new TypeError(`resultRef 熵必须是 ${RESULT_REF_ENTROPY_BYTES} 字节`);
  }
  return RESULT_REF_PREFIX + Buffer.from(entropy).toString('base64url');
}

/* ------------------------------------------------------------------ *
 * 回执错误 details 受控键（§5.7 白名单，持久/读取两侧共用）
 * ------------------------------------------------------------------ */

/**
 * 持久化 rejected 回执 error.details 允许的键（与 F-002 §5.7 脱敏白名单一致）。
 * 读取时遇到白名单外键（可能携带值/秘密）一律 corrupt_state，不透传。
 */
export const RECEIPT_ERROR_DETAILS_KEYS = [
  'field',
  'reason',
  'receivedType',
  'expectedRevision',
  'actualRevision',
  'entityType',
] as const;

/* ------------------------------------------------------------------ *
 * §10 持久行列形态与映射
 * ------------------------------------------------------------------ */

/**
 * command_receipts 行列在应用侧的形态（由 SQLite 适配器把 snake_case 列映射到
 * 本形态并解析 JSON 列）。本模块只消费该形态，不接触任何数据库驱动。
 *
 * - `result`：`undefined` 表示 result_json 列为 NULL（JSON.parse 永不产生
 *   undefined，二者可区分）；completed 回执必须有定义；
 * - `errorDetails`：`null` 表示 error_details 列为 NULL，否则为已解析 JSON。
 */
export interface PersistedCommandReceiptRow {
  readonly principalId: string;
  readonly commandId: string;
  readonly scopeKind: string;
  readonly projectId: string | null;
  readonly operation: string;
  readonly requestDigest: string;
  readonly status: string;
  /** F-008 / §5.3：accepted 回执的同事务操作身份；其余状态为 null。 */
  readonly operationId: string | null;
  /** Missing only in pre-v10 pure mapping fixtures; legacy version defaults to v5. */
  readonly receiptVersion?: number;
  readonly batchId?: string | null;
  readonly runId?: string | null;
  readonly result: unknown;
  readonly resultRef: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly errorDetails: unknown;
  readonly issuedAtUtcMs: number;
  readonly completedAtUtcMs: number;
}

const PERSISTED_ROW_KEYS = [
  'principalId',
  'commandId',
  'scopeKind',
  'projectId',
  'operation',
  'requestDigest',
  'status',
  'operationId',
  'receiptVersion',
  'batchId',
  'runId',
  'result',
  'resultRef',
  'errorCode',
  'errorMessage',
  'errorDetails',
  'issuedAtUtcMs',
  'completedAtUtcMs',
] as const;

/** 行列映射的统一公开操作身份（内部读取路径名不进入公开错误）。 */
export const RECEIPT_READ_OPERATION = 'receipts.get';

function corrupt(operation: string, field?: string): never {
  throw new PublicError('corrupt_state', operation, undefined, {
    details: { reason: 'corrupt_receipt_row', ...(field !== undefined ? { field } : {}) },
  });
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

function isValidPrincipalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[\0-\x1f\x7f]/.test(value)
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 错误 message：脱敏固定文案（非空、≤200、无控制字符）。 */
function isValidErrorMessage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\0-\x1f\x7f]/.test(value)
  );
}

function isPublicErrorCode(value: unknown): value is PublicErrorCode {
  return (
    typeof value === 'string' && (PUBLIC_ERROR_CODES as readonly string[]).includes(value)
  );
}

function isValidErrorDetails(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!(RECEIPT_ERROR_DETAILS_KEYS as readonly string[]).includes(key)) {
      return false;
    }
  }
  return true;
}

/** completed 回执内嵌结果必须 JSON 安全且有界（与写入侧同一不变量）。 */
function isBoundedJsonResult(value: unknown): boolean {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return false;
  }
  return Buffer.byteLength(text, 'utf8') <= RECEIPT_RESULT_MAX_BYTES;
}

/**
 * 持久 command_receipts 行列 → §5.3 回执（单向、确定性、无 I/O）。
 * `replayed` 恒为 false（持久行是原始回执；重放标记由 §5.5 重放判定派生）。
 *
 * 任何不一致（结构损坏、未知操作、scope 与 operation/projectId 不匹配、
 * completed/rejected/accepted 交叉字段违反、摘要/时间/resultRef/operationId
 * 形态非法、错误 details 白名单外键）一律 corrupt_state（corrupt_receipt_row），
 * 错误不回显行列原文。
 */
export function mapPersistedCommandReceipt(
  row: unknown,
  operation: string = RECEIPT_READ_OPERATION,
): CommandReceipt {
  if (!isPlainObject(row)) {
    corrupt(operation);
  }
  for (const key of Object.keys(row)) {
    if (!(PERSISTED_ROW_KEYS as readonly string[]).includes(key)) {
      corrupt(operation);
    }
  }
  if (!isValidPrincipalId(row.principalId)) {
    corrupt(operation, 'principalId');
  }
  if (!isUuidV4(row.commandId)) {
    corrupt(operation, 'commandId');
  }
  if (
    row.scopeKind !== 'registration' &&
    row.scopeKind !== 'global' &&
    row.scopeKind !== 'project'
  ) {
    corrupt(operation, 'scope.kind');
  }
  const scopeKind = row.scopeKind as CommandScopeKind;
  if (scopeKind === 'project') {
    if (!isUuidV4(row.projectId)) {
      corrupt(operation, 'scope.projectId');
    }
  } else if (row.projectId !== null) {
    corrupt(operation, 'scope.projectId');
  }
  if (typeof row.operation !== 'string') {
    corrupt(operation, 'operation');
  }
  if (row.receiptVersion === WORK_ACCEPTED_SCHEMA_VERSION) {
    if (row.result !== undefined || row.resultRef !== null || row.errorCode !== null ||
        row.errorMessage !== null || row.errorDetails !== null ||
        !isSafeNonNegativeInteger(row.issuedAtUtcMs) || !isSafeNonNegativeInteger(row.completedAtUtcMs)) {
      corrupt(operation, 'association');
    }
    try {
      return validateReceiptShape({
        schemaVersion: row.receiptVersion, commandId: row.commandId, principalId: row.principalId,
        operation: row.operation, scope: { kind: row.scopeKind, projectId: row.projectId },
        requestDigest: row.requestDigest, status: row.status, operationId: row.operationId,
        batchId: row.batchId, runId: row.runId, issuedAt: new Date(row.issuedAtUtcMs).toISOString(),
        completedAt: new Date(row.completedAtUtcMs).toISOString(), replayed: false,
      }, operation, 'persisted');
    } catch {
      corrupt(operation, 'association');
    }
  }
  if ((row.receiptVersion !== undefined && row.receiptVersion !== WIRE_MESSAGE_SCHEMA_VERSION) ||
      row.batchId != null || row.runId != null) {
    corrupt(operation, 'association');
  }
  const spec = Object.hasOwn(RECEIPT_OPERATION_SPECS, row.operation) ? RECEIPT_OPERATION_SPECS[row.operation as ReceiptOperation] : undefined;
  if (spec === undefined) {
    corrupt(operation, 'operation');
  }
  if (spec.scopeKind !== scopeKind) {
    corrupt(operation, 'scope.kind');
  }
  const scope: CommandScope =
    scopeKind === 'project'
      ? { kind: 'project', projectId: row.projectId as string }
      : scopeKind === 'global'
        ? { kind: 'global' }
        : { kind: 'registration' };
  if (!isSha256Hex(row.requestDigest)) {
    corrupt(operation, 'requestDigest');
  }
  if (!isSafeNonNegativeInteger(row.issuedAtUtcMs) || !isSafeNonNegativeInteger(row.completedAtUtcMs)) {
    corrupt(operation, 'issuedAt');
  }

  const base = {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: row.commandId,
    principalId: row.principalId as string,
    operation: row.operation as ReceiptOperation,
    scope,
    requestDigest: row.requestDigest,
    issuedAt: new Date(row.issuedAtUtcMs).toISOString(),
    completedAt: new Date(row.completedAtUtcMs).toISOString(),
    replayed: false,
  } as const;

  if (row.status === 'completed') {
    if (row.result === undefined || !isBoundedJsonResult(row.result)) {
      corrupt(operation, 'result');
    }
    if (!isValidResultRef(row.resultRef)) {
      corrupt(operation, 'resultRef');
    }
    if (row.errorCode !== null || row.errorMessage !== null || row.errorDetails !== null) {
      corrupt(operation, 'error');
    }
    if (row.operationId !== null) {
      corrupt(operation, 'operationId');
    }
    const completed: CompletedCommandReceipt = {
      ...base,
      status: 'completed',
      result: row.result,
      resultRef: row.resultRef as string,
    };
    return completed;
  }
  if (row.status === 'accepted') {
    // §5.3（F-008 首次启用）：accepted 只携带同事务操作身份，不带 result/resultRef/error。
    if (row.result !== undefined || row.resultRef !== null) {
      corrupt(operation, 'result');
    }
    if (row.errorCode !== null || row.errorMessage !== null || row.errorDetails !== null) {
      corrupt(operation, 'error');
    }
    if (!isUuidV4(row.operationId)) {
      corrupt(operation, 'operationId');
    }
    const accepted: AcceptedCommandReceipt = {
      ...base,
      status: 'accepted',
      operationId: row.operationId as string,
    };
    return accepted;
  }
  if (row.status === 'rejected') {
    // 持久化 accepted 或其他未知状态：显式失败，不伪造（§5.3：本版本无 accepted 写路径）。
    if (row.result !== undefined || row.resultRef !== null) {
      corrupt(operation, 'result');
    }
    if (!isPublicErrorCode(row.errorCode)) {
      corrupt(operation, 'error.code');
    }
    if (!isValidErrorMessage(row.errorMessage)) {
      corrupt(operation, 'error.message');
    }
    if (row.errorDetails !== null && !isValidErrorDetails(row.errorDetails)) {
      corrupt(operation, 'error.details');
    }
    const error: PublicErrorShape = {
      code: row.errorCode,
      message: row.errorMessage as string,
      ...(row.errorDetails !== null
        ? { details: row.errorDetails as Record<string, unknown> }
        : {}),
    };
    const rejected: RejectedCommandReceipt = { ...base, status: 'rejected', error };
    return rejected;
  }
  corrupt(operation, 'status');
}

/* ------------------------------------------------------------------ *
 * 写入边界校验（端口输入一律 unknown）
 * ------------------------------------------------------------------ */

const RECEIPT_KEYS = [
  'schemaVersion',
  'commandId',
  'principalId',
  'operation',
  'scope',
  'requestDigest',
  'status',
  'operationId',
  'result',
  'resultRef',
  'error',
  'issuedAt',
  'completedAt',
  'replayed',
] as const;

const ERROR_SHAPE_KEYS = ['code', 'message', 'details'] as const;

function validateReceiptScope(
  value: unknown,
  specScopeKind: CommandScopeKind,
  context: ValidationContext,
): CommandScope {
  const object = requirePlainObject(value, context, 'receipt.scope');
  rejectUnknownKeys(object, ['kind', 'projectId'], context, 'receipt.scope');
  if (object.kind !== 'registration' && object.kind !== 'global' && object.kind !== 'project') {
    throw validationError(context, 'receipt.scope.kind', "必须是 'registration'、'global' 或 'project'");
  }
  if (object.kind !== specScopeKind) {
    throw validationError(context, 'receipt.scope.kind', 'scope 种类与操作不匹配');
  }
  if (object.kind === 'project') {
    if (!isUuidV4(object.projectId)) {
      throw validationError(context, 'receipt.scope.projectId', '必须是 RFC 4122 UUID v4（小写）');
    }
    return { kind: 'project', projectId: object.projectId };
  }
  if (Object.prototype.hasOwnProperty.call(object, 'projectId')) {
    throw validationError(context, 'receipt.scope.projectId', `${object.kind} scope 不允许携带 projectId`);
  }
  return { kind: object.kind };
}

/**
 * 回执形状共享校验（§5.3 不变量）：线上与持久化两侧共用的完整复核。
 * `replayedRule`：'persisted' 要求 replayed=false（重放标记不入库）；
 * 'wire' 只要求布尔（线上重放取回的回执 replayed=true 合法）。
 */
function validateReceiptShape(
  value: unknown,
  operation: string,
  replayedRule: 'persisted' | 'wire',
): CommandReceipt {
  const context: ValidationContext = { operation, entity: { type: 'command_receipt' } };
  const object = requirePlainObject(value, context, 'receipt');
  const isWork = object.schemaVersion === WORK_ACCEPTED_SCHEMA_VERSION;
  rejectUnknownKeys(object, isWork ? [...RECEIPT_KEYS, 'batchId', 'runId'] : RECEIPT_KEYS, context, 'receipt');

  if (!isWork && object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    throw validationError(context, 'receipt.schemaVersion', `必须是 ${WIRE_MESSAGE_SCHEMA_VERSION}`);
  }
  if (!isUuidV4(object.commandId)) {
    throw validationError(context, 'receipt.commandId', '必须是 RFC 4122 UUID v4（小写）');
  }
  if (!isValidPrincipalId(object.principalId)) {
    throw validationError(context, 'receipt.principalId', '必须是 1..128 字符、无控制字符的主体身份');
  }
  if (typeof object.operation !== 'string') {
    throw validationError(context, 'receipt.operation', '必须是命令名字符串');
  }
  const spec = Object.hasOwn(RECEIPT_OPERATION_SPECS, object.operation) ? RECEIPT_OPERATION_SPECS[object.operation as ReceiptOperation] : undefined;
  const scopeKind = isWork && object.operation === WORK_ACCEPTED_OPERATION ? 'project' : (!isWork ? spec?.scopeKind : undefined);
  if (scopeKind === undefined) {
    throw validationError(context, 'receipt.operation', '未知操作或版本不匹配');
  }
  const operation_ = object.operation as ReceiptOperation;
  const scope = validateReceiptScope(object.scope, scopeKind, context);
  if (!isSha256Hex(object.requestDigest)) {
    throw validationError(context, 'receipt.requestDigest', '必须是 64 位小写十六进制 SHA-256');
  }
  if (!isIsoUtcDateTime(object.issuedAt) || !isIsoUtcDateTime(object.completedAt)) {
    throw validationError(context, 'receipt.issuedAt', 'issuedAt/completedAt 必须是 ISO UTC 时间');
  }
  if (replayedRule === 'persisted') {
    if (object.replayed !== false) {
      throw validationError(context, 'receipt.replayed', '持久化回执 replayed 必须为 false（重放标记不入库）');
    }
  } else if (typeof object.replayed !== 'boolean') {
    throw validationError(context, 'receipt.replayed', '必须是布尔（线上派生标记）');
  }

  const base = {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: object.commandId,
    principalId: object.principalId as string,
    operation: operation_,
    scope,
    requestDigest: object.requestDigest,
    issuedAt: object.issuedAt,
    completedAt: object.completedAt,
    replayed: replayedRule === 'wire' ? (object.replayed as boolean) : false,
  } as const;

  if (isWork) {
    if (object.status !== 'accepted' || object.result !== undefined || object.resultRef !== undefined || object.error !== undefined) {
      throw validationError(context, 'receipt.status', 'Work v6 仅支持 accepted，且不携带结果或错误');
    }
    if (!isUuidV4(object.batchId) || !isUuidV4(object.runId) || object.operationId !== object.batchId) {
      throw validationError(context, 'receipt.association', 'Work accepted 必须携带 UUID Batch/Run 且 operationId = batchId');
    }
    return {
      ...base, schemaVersion: WORK_ACCEPTED_SCHEMA_VERSION, operation: WORK_ACCEPTED_OPERATION,
      status: 'accepted', operationId: object.batchId, batchId: object.batchId, runId: object.runId,
    };
  }

  if (object.status === 'completed') {
    if (object.error !== undefined) {
      throw validationError(context, 'receipt.error', 'completed 回执不允许携带 error');
    }
    if (object.operationId !== undefined) {
      throw validationError(context, 'receipt.operationId', 'completed 回执不允许携带 operationId');
    }
    if (!Object.prototype.hasOwnProperty.call(object, 'result')) {
      throw validationError(context, 'receipt.result', 'completed 回执必须携带 result');
    }
    if (!isBoundedJsonResult(object.result)) {
      throw validationError(
        context,
        'receipt.result',
        `result 必须 JSON 安全且序列化不超过 ${RECEIPT_RESULT_MAX_BYTES} 字节`,
      );
    }
    if (!isValidResultRef(object.resultRef)) {
      throw validationError(context, 'receipt.resultRef', '必须是 v1. 形态的不透明结果引用');
    }
    const completed: CompletedCommandReceipt = {
      ...base,
      status: 'completed',
      result: object.result,
      resultRef: object.resultRef,
    };
    return completed;
  }
  if (object.status === 'accepted') {
    // §5.3（F-008 首次启用）：accepted 只携带 operationId；不带 result/resultRef/error。
    if (object.result !== undefined || object.resultRef !== undefined || object.error !== undefined) {
      throw validationError(context, 'receipt.result', 'accepted 回执不允许携带 result/resultRef/error');
    }
    if (!isUuidV4(object.operationId)) {
      throw validationError(context, 'receipt.operationId', '必须是 RFC 4122 UUID v4（同事务操作身份）');
    }
    const accepted: AcceptedCommandReceipt = {
      ...base,
      status: 'accepted',
      operationId: object.operationId,
    };
    return accepted;
  }
  if (object.status === 'rejected') {
    if (object.result !== undefined || object.resultRef !== undefined) {
      throw validationError(context, 'receipt.result', 'rejected 回执不允许携带 result/resultRef');
    }
    const errorObject = requirePlainObject(object.error, context, 'receipt.error');
    rejectUnknownKeys(errorObject, ERROR_SHAPE_KEYS, context, 'receipt.error');
    if (!isPublicErrorCode(errorObject.code)) {
      throw validationError(context, 'receipt.error.code', '必须是公开错误码枚举内的值');
    }
    if (!isValidErrorMessage(errorObject.message)) {
      throw validationError(context, 'receipt.error.message', '必须是 1..200 字符、无控制字符的脱敏文案');
    }
    if (errorObject.details !== undefined && !isValidErrorDetails(errorObject.details)) {
      throw validationError(
        context,
        'receipt.error.details',
        '必须是普通对象且键在受控白名单内（field/reason/receivedType/expectedRevision/actualRevision/entityType）',
      );
    }
    const error: PublicErrorShape = {
      code: errorObject.code,
      message: errorObject.message as string,
      ...(errorObject.details !== undefined
        ? { details: errorObject.details as Record<string, unknown> }
        : {}),
    };
    const rejected: RejectedCommandReceipt = { ...base, status: 'rejected', error };
    return rejected;
  }
  throw validationError(
    context,
    'receipt.status',
    "必须是 'completed'、'rejected' 或 'accepted'（仅 baseline.run authorize 产生 accepted）",
    describeValueType(object.status),
  );
}

/**
 * 回执持久化输入校验（CommandReceiptStore.saveReceipt 的边界）：合法输入通常由
 * F-002 的 createCompletedReceipt/createRejectedReceipt 工厂产出，此处按 §5.3/§10
 * 不变量对 unknown 输入完整复核——校验失败抛 StorageError(kind='validation')，
 * 发生在任何 SQL 之前，不产生持久化副作用。
 *
 * `replayed` 是线上派生标记（不入库）：持久化输入必须 replayed=false，
 * 重放取回的回执再次入库属于调用方编程错误。accepted 包含既有 v5 baseline
 * 关联与显式 v6 Work Batch/Run 关联；命令提交能力不随回执扩展启用。
 */
export function validatePersistableCommandReceipt(
  value: unknown,
  operation: string,
): CommandReceipt {
  return validateReceiptShape(value, operation, 'persisted');
}

/**
 * 线上回执校验（F-013，§5.3/§11.2）：Host/HostClient 对接收到的回执 JSON 做
 * 完整运行时复核。与持久化校验同一组不变量，唯一差异是 `replayed` 只要求
 * 布尔（线上重放取回的回执 replayed=true 合法）。accepted 仅在携带同事务
 * operationId 且不带 result/resultRef/error 时合法；v6 Work 额外携带
 * batchId/runId 并要求 operationId = batchId，不放宽 v5 未知字段集合。
 *
 * 纯函数：不读时钟/文件系统/网络/数据库；校验失败抛
 * StorageError(kind='validation')（字段定位在 details.field），不回显输入值。
 */
export function validateWireCommandReceipt(
  value: unknown,
  operation: string,
): CommandReceipt {
  return validateReceiptShape(value, operation, 'wire');
}

/* ------------------------------------------------------------------ *
 * §5.5 重放判定（纯函数；F-007 在同一事务内先查回执再判定）
 * ------------------------------------------------------------------ */

export type CommandReplayDecision =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly receipt: CommandReceipt };

/**
 * 幂等重放判定：既有回执缺失 → new；摘要一致 → replay（返回 replayed:true 的
 * 原回执，不重新执行业务、不改写既有回执）；摘要不同 → 409 conflict
 * （details.reason='idempotency_key_reuse'），既有回执与业务对象不变。
 */
export function decideCommandReplay(
  existing: CommandReceipt | undefined,
  requestDigest: string,
  operation: string,
): CommandReplayDecision {
  if (existing === undefined) {
    return { kind: 'new' };
  }
  if (existing.requestDigest !== requestDigest) {
    throw new PublicError('conflict', operation, undefined, {
      details: { reason: 'idempotency_key_reuse' },
    });
  }
  return { kind: 'replay', receipt: { ...existing, replayed: true } };
}

/* ------------------------------------------------------------------ *
 * CommandReceiptStore 窄端口
 * ------------------------------------------------------------------ */

/**
 * 持久命令回执窄端口（§10）。实现者：F-006 SQLite 适配器。
 *
 * - 只暴露应用数据形态（CommandReceipt），不泄漏 better-sqlite3/Drizzle 会话；
 * - `saveReceipt` 输入为 unknown（边界运行时校验）；唯一约束冲突（同
 *   principal+commandId 或同 resultRef）返回 StorageError(kind='conflict')——
 *   正常命令流由 F-007 在同一事务内先查后写，本冲突是防御纵深而非控制流；
 * - 两个查找方法在缺失时返回 `undefined`（缺失是幂等核对的正常结果，不是
 *   异常）；跨身份读取由「按调用方 principalId 查询」结构性拒绝，端口不提供
 *   跨主体枚举能力；
 * - 读取到的持久行必经 mapPersistedCommandReceipt 复核，损坏行显式
 *   corrupt_state，不作为有效回执返回。
 */
export interface CommandReceiptStore {
  /** 持久化 completed/rejected 回执；校验失败/唯一冲突时无任何写入。 */
  saveReceipt(receipt: unknown): Promise<void>;
  /** 按 (principalId, commandId) 复合唯一键读取；缺失返回 undefined。 */
  findReceiptByCommandId(
    principalId: unknown,
    commandId: unknown,
  ): Promise<CommandReceipt | undefined>;
  /** 按不透明 resultRef 读取；缺失返回 undefined。 */
  findReceiptByResultRef(resultRef: unknown): Promise<CommandReceipt | undefined>;
}

/**
 * 注册回执的新建项目身份提取（§5.6：注册回执核验新建项目当前可见性）。
 * registration + completed 回执的结果按 §6 冻结形状携带 project.id；形状不符
 * 说明持久内容与写入侧契约不一致（corrupt_state），绝不跳过可见性核验。
 * rejected 注册回执没有项目实体（返回 null，仅归属核验）。
 */
export function registrationProjectIdOf(receipt: CommandReceipt, operation: string): string | null {
  if (receipt.scope.kind !== 'registration' || receipt.status !== 'completed') {
    return null;
  }
  const result = receipt.result;
  if (isPlainObject(result) && isPlainObject(result.project)) {
    const projectId = result.project.id;
    if (typeof projectId === 'string' && isUuidV4(projectId)) {
      return projectId;
    }
  }
  throw new PublicError('corrupt_state', operation, undefined, {
    details: { reason: 'corrupt_receipt_result' },
  });
}
