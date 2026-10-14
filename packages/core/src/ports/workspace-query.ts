/**
 * P03-5 / F-011 工作区状态只读查询端口（ports 契约层，纯类型 + 确定性计算 +
 * 运行时校验，无 I/O）。
 *
 * 依据 docs/p03-5-workspace-host-integration-contract.md §4：
 * - 四个查询操作身份冻结于 WORKSPACE_QUERY_OPERATIONS；Host 握手能力清单
 *   与本清单同步（只宣告真实接线）；
 * - 公开投影绝不携带绝对路径（canonicalPath/gitCommonDir）与内部仓库身份
 *   哈希（repoIdentity）；operation 回执投影只含 commandId/resultRef/
 *   status/reason 白名单字段（reason 缺失为 null，不回显正文）；
 * - 列表分页有界（默认 100、上限 500）；`wscur_v1_` 不透明游标绑定数据根
 *   身份指纹 + scope（kind/projectId/featureId），跨根/跨项目/跨 Feature/
 *   跨 kind/畸形一律 invalid_cursor，绝不当从零读取。
 */
import { createHash } from 'node:crypto';
import { PublicError, WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import type { ManagedWorkspaceRecord, WorkspaceOperationRecord, WorkspaceOperationResult } from './workspace.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateStableId,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const WORKSPACES_LIST_OPERATION = 'workspaces.list' as const;
export const WORKSPACES_GET_OPERATION = 'workspaces.get' as const;
export const WORKSPACE_OPERATIONS_LIST_OPERATION = 'workspace.operations.list' as const;
export const WORKSPACE_OPERATIONS_GET_OPERATION = 'workspace.operations.get' as const;
export const WORKSPACE_QUERY_OPERATIONS = [
  WORKSPACES_LIST_OPERATION,
  WORKSPACES_GET_OPERATION,
  WORKSPACE_OPERATIONS_LIST_OPERATION,
  WORKSPACE_OPERATIONS_GET_OPERATION,
] as const;
export type WorkspaceQueryOperation = (typeof WORKSPACE_QUERY_OPERATIONS)[number];

export const WORKSPACE_LIST_DEFAULT_LIMIT = 100;
export const WORKSPACE_LIST_MAX_LIMIT = 500;
export const WORKSPACE_LIST_CURSOR_PREFIX = 'wscur_v1_';
const WORKSPACE_LIST_CURSOR_VERSION = 1;
const WORKSPACE_ROOT_FINGERPRINT_LENGTH = 16;
const WORKSPACE_CURSOR_STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/* ------------------------------------------------------------------ *
 * 存储读取视图（adapters 实现；一致读事务内组装）
 * ------------------------------------------------------------------ */

/** operation 当前回执的白名单投影（reason 从持久回执结果解析，缺失为 null）。 */
export interface WorkspaceOperationReceiptView {
  readonly commandId: string;
  readonly resultRef: string | null;
  readonly status: 'completed' | 'rejected';
  readonly reason: string | null;
}

export interface WorkspaceOperationView {
  readonly operation: WorkspaceOperationRecord;
  /** pending operation 指向意图回执；终态指向结果回执；缺失是存储损坏（适配器 fail-closed）。 */
  readonly receipt: WorkspaceOperationReceiptView;
}

/** workspaces.get 详情视图：工作区 + 准备 operation + 最新 operation。 */
export interface WorkspaceDetailView {
  readonly workspace: ManagedWorkspaceRecord;
  readonly preparation: WorkspaceOperationView | null;
  readonly latest: WorkspaceOperationView | null;
}

export interface WorkspaceQueryListRequest {
  /** 键集排他下界（上一页末条 id；null 从头开始）。 */
  readonly afterId: string | null;
  readonly limit: number;
}

export interface WorkspaceQueryPage<T> {
  readonly records: readonly T[];
  /** 用满 limit 时为本页末条 id（供游标签发）；否则 null（页末明确）。 */
  readonly nextId: string | null;
}

/**
 * 只读窄端口：跨项目/不存在目标折叠为 undefined（存在性折叠由应用层完成）；
 * 持久行/回执损坏 fail-closed（StorageError corrupt）；全部读取在调用方的
 * 一致读事务内完成（适配器自行开启 BEGIN DEFERRED）。
 */
export interface WorkspaceQueryReadStore {
  readWorkspaceDetail(projectId: unknown, featureId: unknown): WorkspaceDetailView | undefined;
  readWorkspaceOperationView(projectId: unknown, operationId: unknown): WorkspaceOperationView | undefined;
  listWorkspaceRecords(
    projectId: unknown,
    featureId: unknown,
    request: WorkspaceQueryListRequest,
  ): WorkspaceQueryPage<ManagedWorkspaceRecord>;
  listWorkspaceOperationViews(
    projectId: unknown,
    featureId: unknown,
    request: WorkspaceQueryListRequest,
  ): WorkspaceQueryPage<WorkspaceOperationView>;
}

/* ------------------------------------------------------------------ *
 * 公开记录投影（脱敏：剔除绝对路径与内部身份哈希；时间转 ISO UTC）
 * ------------------------------------------------------------------ */

function isoUtc(utcMs: number): string {
  return new Date(utcMs).toISOString();
}

function isoOrNull(utcMs: number | null): string | null {
  return utcMs === null ? null : isoUtc(utcMs);
}

export interface PublicWorkspaceRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly preparationOperationId: string;
  readonly status: ManagedWorkspaceRecord['status'];
  readonly revision: number;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string | null;
  readonly codeDigest: string | null;
  readonly repositoryBindingId: string;
  readonly repositoryBindingRevision: number;
  readonly ownerId: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicWorkspaceRecord(record: ManagedWorkspaceRecord): PublicWorkspaceRecord {
  return {
    id: record.id,
    projectId: record.projectId,
    featureId: record.featureId,
    runId: record.runId,
    attemptId: record.attemptId,
    preparationOperationId: record.preparationOperationId,
    status: record.status,
    revision: record.revision,
    branch: record.branch,
    baseCommit: record.baseCommit,
    headCommit: record.headCommit,
    codeDigest: record.codeDigest,
    repositoryBindingId: record.repositoryBindingId,
    repositoryBindingRevision: record.repositoryBindingRevision,
    ownerId: record.ownerId,
    hostInstanceId: record.hostInstanceId,
    executionVersion: record.executionVersion,
    createdAt: isoUtc(record.createdAtUtcMs),
    updatedAt: isoUtc(record.updatedAtUtcMs),
  };
}

export interface PublicWorkspaceOperationResult {
  readonly evidenceRefs: readonly string[];
  readonly errorRef: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

function toPublicOperationResult(result: WorkspaceOperationResult): PublicWorkspaceOperationResult {
  return {
    evidenceRefs: [...result.evidenceRefs],
    errorRef: result.errorRef,
    startedAt: isoOrNull(result.startedAtUtcMs),
    endedAt: isoOrNull(result.endedAtUtcMs),
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
  };
}

export interface PublicWorkspaceOperationRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly kind: WorkspaceOperationRecord['kind'];
  readonly executionStage: WorkspaceOperationRecord['executionStage'];
  readonly status: WorkspaceOperationRecord['status'];
  readonly revision: number;
  readonly principalId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly result: PublicWorkspaceOperationResult | null;
  readonly receipt: WorkspaceOperationReceiptView;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicWorkspaceOperationRecord(view: WorkspaceOperationView): PublicWorkspaceOperationRecord {
  const { operation, receipt } = view;
  return {
    id: operation.id,
    projectId: operation.projectId,
    featureId: operation.featureId,
    workspaceId: operation.workspaceId,
    runId: operation.runId,
    attemptId: operation.identity.attemptId,
    kind: operation.kind,
    executionStage: operation.executionStage,
    status: operation.status,
    revision: operation.revision,
    principalId: operation.principalId,
    commandId: operation.commandId,
    requestDigest: operation.requestDigest,
    result: operation.result === null ? null : toPublicOperationResult(operation.result),
    receipt,
    createdAt: isoUtc(operation.createdAtUtcMs),
    updatedAt: isoUtc(operation.updatedAtUtcMs),
  };
}

/* ------------------------------------------------------------------ *
 * 查询结果信封
 * ------------------------------------------------------------------ */

export interface WorkspaceListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'workspace-list';
  readonly records: readonly PublicWorkspaceRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface WorkspaceDetailResult {
  readonly workspace: PublicWorkspaceRecord;
  readonly preparationOperation: PublicWorkspaceOperationRecord | null;
  readonly latestOperation: PublicWorkspaceOperationRecord | null;
}

export interface WorkspaceOperationListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'workspace-operation-list';
  readonly records: readonly PublicWorkspaceOperationRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface WorkspaceOperationDetailResult {
  readonly operation: PublicWorkspaceOperationRecord;
}

/* ------------------------------------------------------------------ *
 * 列表过滤器校验（应用层调用；取值规则单一权威）
 * ------------------------------------------------------------------ */

export interface ValidatedWorkspaceListFilter {
  readonly featureId: string | null;
  readonly limit: number;
  readonly cursor?: string;
}

/** 列表输入校验：projectId 由调用层单独校验；featureId 可选；limit 默认 100、上限 500。 */
export function validateWorkspaceListFilter(input: unknown, operation: string): ValidatedWorkspaceListFilter {
  const context: ValidationContext = { operation };
  const raw = requirePlainObject(input, context, 'input');
  rejectUnknownKeys(raw, ['projectId', 'featureId', 'limit', 'cursor'], context, 'input');
  let featureId: string | null = null;
  if (raw.featureId !== undefined && raw.featureId !== null) {
    featureId = validateStableId(raw.featureId, context, 'featureId');
  }
  let limit = WORKSPACE_LIST_DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    limit = validatePositiveInteger(raw.limit, context, 'limit');
    if (limit > WORKSPACE_LIST_MAX_LIMIT) {
      throw new PublicError('invalid_input', operation, undefined, {
        details: { field: 'limit', reason: 'limit_out_of_range' },
      });
    }
  }
  let cursor: string | undefined;
  if (raw.cursor !== undefined) {
    if (typeof raw.cursor !== 'string' || raw.cursor.length === 0 || raw.cursor.length > 512) {
      throw new PublicError('invalid_input', operation, undefined, {
        details: { field: 'cursor', reason: 'invalid_cursor' },
      });
    }
    cursor = raw.cursor;
  }
  return { featureId, limit, ...(cursor === undefined ? {} : { cursor }) };
}

/* ------------------------------------------------------------------ *
 * 受控游标（wscur_v1_<base64url JSON>；绑定数据根指纹 + scope 指纹）
 * ------------------------------------------------------------------ */

export type WorkspaceListScope =
  | { readonly kind: 'workspaces'; readonly projectId: string; readonly featureId: string | null }
  | { readonly kind: 'workspace-operations'; readonly projectId: string; readonly featureId: string | null };

/** 游标签发/解析绑定：数据根身份 + 列表 scope（只允许可信装配构造）。 */
export interface WorkspaceListCursorBinding {
  readonly rootIdentity: string;
  readonly scope: WorkspaceListScope;
}

function invalidInput(operation: string, field: string, reason: string): never {
  throw new PublicError('invalid_input', operation, undefined, { details: { field, reason } });
}

export function createWorkspaceListCursorBinding(
  input: unknown,
  operation: string = 'WorkspaceListCursor.createBinding',
): WorkspaceListCursorBinding {
  if (!isPlainObject(input)) {
    invalidInput(operation, 'binding', '必须是对象');
  }
  const raw = input as Record<string, unknown>;
  rejectUnknownKeys(raw, ['rootIdentity', 'scope'], { operation }, 'binding');
  if (typeof raw.rootIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(raw.rootIdentity)) {
    invalidInput(operation, 'rootIdentity', '必须是 64 位小写十六进制数据根身份');
  }
  if (!isPlainObject(raw.scope)) {
    invalidInput(operation, 'scope', '必须是对象');
  }
  const scope = raw.scope as Record<string, unknown>;
  rejectUnknownKeys(scope, ['kind', 'projectId', 'featureId'], { operation }, 'scope');
  if (scope.kind !== 'workspaces' && scope.kind !== 'workspace-operations') {
    invalidInput(operation, 'scope.kind', '不支持的工作区列表 scope');
  }
  const context: ValidationContext = { operation };
  return {
    rootIdentity: raw.rootIdentity,
    scope: {
      kind: scope.kind,
      projectId: validateStableId(scope.projectId, context, 'scope.projectId'),
      featureId:
        scope.featureId === null || scope.featureId === undefined
          ? null
          : validateStableId(scope.featureId, context, 'scope.featureId'),
    },
  };
}

function scopeFingerprint(binding: WorkspaceListCursorBinding): string {
  const { scope } = binding;
  return createHash('sha256')
    .update(
      `shiploop:workspace-list-scope:v1:${scope.kind}:${scope.projectId}:${scope.featureId ?? '-'}`,
      'utf8',
    )
    .digest('hex');
}

/** 签发不透明续读游标（服务端内部调用）：lastId 必须是合法稳定 ID。 */
export function encodeWorkspaceListCursor(lastId: string, binding: WorkspaceListCursorBinding): string {
  const trusted = createWorkspaceListCursorBinding(binding, 'WorkspaceListCursor.encode');
  if (typeof lastId !== 'string' || !WORKSPACE_CURSOR_STABLE_ID_PATTERN.test(lastId)) {
    throw new TypeError('encodeWorkspaceListCursor: lastId 必须是合法稳定 ID（服务端内部调用）');
  }
  const payload = JSON.stringify({
    v: WORKSPACE_LIST_CURSOR_VERSION,
    id: lastId,
    root: trusted.rootIdentity.slice(0, WORKSPACE_ROOT_FINGERPRINT_LENGTH),
    sk: scopeFingerprint(trusted),
  });
  return `${WORKSPACE_LIST_CURSOR_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export interface DecodedWorkspaceListCursor {
  readonly version: typeof WORKSPACE_LIST_CURSOR_VERSION;
  readonly lastId: string;
}

/**
 * 解析并核验客户端回传游标：无法解码/非规范 base64url/未知键/未知版本/
 * root 或 scope 指纹不符（跨根/跨项目/跨 Feature/跨 kind）一律
 * invalid_input(invalid_cursor)，绝不当从零读取；未来游标合法（由存储层
 * 键集下界自然处理）。
 */
export function decodeWorkspaceListCursor(
  cursor: unknown,
  binding: WorkspaceListCursorBinding,
  operation: string = 'WorkspaceListCursor.decode',
): DecodedWorkspaceListCursor {
  const trusted = createWorkspaceListCursorBinding(binding, operation);
  const invalid = (): never => invalidInput(operation, 'cursor', 'invalid_cursor');
  if (typeof cursor !== 'string' || !cursor.startsWith(WORKSPACE_LIST_CURSOR_PREFIX)) {
    invalid();
  }
  const body = (cursor as string).slice(WORKSPACE_LIST_CURSOR_PREFIX.length);
  if (body.length === 0 || !/^[A-Za-z0-9_-]+$/.test(body)) {
    invalid();
  }
  const bytes = Buffer.from(body, 'base64url');
  if (Buffer.from(bytes).toString('base64url') !== body) {
    invalid();
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    invalid();
  }
  if (!isPlainObject(parsed)) {
    invalid();
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (key !== 'v' && key !== 'id' && key !== 'root' && key !== 'sk') {
      invalid();
    }
  }
  const value = parsed as Record<string, unknown>;
  if (value.v !== WORKSPACE_LIST_CURSOR_VERSION) {
    invalid();
  }
  if (typeof value.id !== 'string' || !WORKSPACE_CURSOR_STABLE_ID_PATTERN.test(value.id)) {
    invalid();
  }
  if (value.root !== trusted.rootIdentity.slice(0, WORKSPACE_ROOT_FINGERPRINT_LENGTH)) {
    invalid();
  }
  if (value.sk !== scopeFingerprint(trusted)) {
    invalid();
  }
  return { version: WORKSPACE_LIST_CURSOR_VERSION, lastId: value.id as string };
}
