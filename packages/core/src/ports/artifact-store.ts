/**
 * F-002 最小 ArtifactStore 窄契约（ports 契约层）：制品索引与有效输入引用。
 *
 * 设计依据：core-design/03 §4（pending 登记 → staging → 校验 → ready；
 * ready 文件缺失为 corrupt）与 core-design/11 §8（artifacts 字段字典）。
 *
 * 契约要点：
 * - SQLite 只保存索引（预期摘要、实际 hash、字节 size、逻辑 locator、状态），
 *   大正文永不进库；locator 为受控逻辑位置，不是任意用户绝对路径；
 * - 状态机 pending→ready / pending→failed；ready/failed 为索引级终态，
 *   内容身份（hash/size/version/locator）一经 ready 不接受普通更新覆盖，
 *   正文变更必须创建新制品；
 * - 只有同项目且核验通过的 ready 制品可取得有效输入引用（ArtifactInputRef）；
 *   跨项目访问返回 ownership 错误，不能仅凭全局 artifactId 放行；
 * - 损坏诊断（ArtifactCorruption：missing / hash_mismatch / size_mismatch）的
 *   检测由 F-012 的中断核对实现，本契约只固定其表达形态；
 * - 本 Feature 不持久化 retention_class：设计 11 列为必填，但保留类别取值
 *   尚未有设计结论（“当前不编造默认容量”），该字段随保留策略设计一并加入。
 */
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateArtifactLocator,
  validateExpectedRevision,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export type ArtifactStatus = 'pending' | 'ready' | 'failed';

/** 损坏诊断类别：正文缺失、摘要被篡改、大小不符。 */
export type ArtifactCorruptionKind = 'missing' | 'hash_mismatch' | 'size_mismatch';

/** 核对（F-012）发现的不一致证据；只含摘要级信息，不含正文内容。 */
export interface ArtifactCorruption {
  readonly kind: ArtifactCorruptionKind;
  readonly detectedAtUtcMs: number;
  readonly expectedHash?: string;
  readonly actualHash?: string;
  readonly expectedSizeBytes?: number;
  readonly actualSizeBytes?: number;
  readonly detail: string;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly projectId: string;
  /** 制品类别（如 verification-report / session-log）；取值由生产方约定。 */
  readonly kind: string;
  readonly mediaType: string;
  readonly status: ArtifactStatus;
  /** 登记时声明的预期 SHA-256 摘要；ready 前核验的依据。 */
  readonly expectedHash: string;
  /** 发布时实测 SHA-256；ready 后必填且不可改。 */
  readonly contentHash: string | null;
  /** 发布时实测字节数；ready 后必填且不可改。 */
  readonly sizeBytes: number | null;
  /** 受控逻辑位置（POSIX 相对），物理路径由授权数据根推导。 */
  readonly locator: string;
  /** 内容版本（≥1，默认 1）。 */
  readonly version: number;
  /** failed 时保留的原因与阶段证据；其余状态为 null。 */
  readonly failureReason: string | null;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

export interface RegisterArtifactInput {
  readonly projectId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly expectedHash: string;
  readonly locator: string;
  readonly version?: number;
}

export interface ValidatedRegisterArtifactInput {
  readonly projectId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly expectedHash: string;
  readonly locator: string;
  readonly version: number;
}

export function validateRegisterArtifactInput(
  value: unknown,
  operation: string,
): ValidatedRegisterArtifactInput {
  const context: ValidationContext = { operation, entity: { type: 'artifact' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(
    object,
    ['projectId', 'kind', 'mediaType', 'expectedHash', 'locator', 'version'],
    context,
    'input',
  );
  const projectId = validateStableId(object.projectId, context, 'projectId');
  return {
    projectId,
    kind: requireNonEmptyString(object.kind, context, 'kind'),
    mediaType: requireNonEmptyString(object.mediaType, context, 'mediaType'),
    expectedHash: validateSha256Digest(object.expectedHash, context, 'expectedHash'),
    locator: validateArtifactLocator(object.locator, context, 'locator'),
    version:
      object.version === undefined ? 1 : validatePositiveInteger(object.version, context, 'version'),
  };
}

export type ArtifactTransitionOutcome =
  | { readonly status: 'ready'; readonly actualHash: string; readonly sizeBytes: number }
  | { readonly status: 'failed'; readonly reason: string };

export interface TransitionArtifactInput {
  readonly expectedRevision: number;
  readonly outcome: ArtifactTransitionOutcome;
}

export function validateTransitionArtifactInput(
  value: unknown,
  operation: string,
): TransitionArtifactInput {
  const context: ValidationContext = { operation, entity: { type: 'artifact' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['expectedRevision', 'outcome'], context, 'input');
  const expectedRevision = validateExpectedRevision(object.expectedRevision, context);
  const outcome = requirePlainObject(object.outcome, context, 'outcome');
  if (outcome.status === 'ready') {
    rejectUnknownKeys(outcome, ['status', 'actualHash', 'sizeBytes'], context, 'outcome');
    return {
      expectedRevision,
      outcome: {
        status: 'ready',
        actualHash: validateSha256Digest(outcome.actualHash, context, 'outcome.actualHash'),
        sizeBytes: validateNonNegativeInteger(outcome.sizeBytes, context, 'outcome.sizeBytes'),
      },
    };
  }
  if (outcome.status === 'failed') {
    rejectUnknownKeys(outcome, ['status', 'reason'], context, 'outcome');
    return {
      expectedRevision,
      outcome: {
        status: 'failed',
        reason: requireNonEmptyString(outcome.reason, context, 'outcome.reason'),
      },
    };
  }
  throw validationError(context, 'outcome.status', '必须是 ready 或 failed 转换', outcome.status);
}

/** 有效输入引用：仅同项目 ready 制品可取得；内容是身份摘要，不是正文本身。 */
export interface ArtifactInputRef {
  readonly artifactId: string;
  readonly projectId: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly version: number;
}

/**
 * 最小 ArtifactStore 端口：制品索引的登记、状态转换与有效引用查询。
 * 文件级 staging/发布由 F-010/F-011 的制品文件适配器承担，不属于本端口。
 * 实现者：F-009 起的 SQLite 适配器；语义基线见 test/storage-contracts.test.ts。
 */
export interface ArtifactStore {
  /** 登记 pending 索引；缺失项目返回 not_found，非法元数据返回 validation。 */
  registerArtifact(input: unknown): Promise<ArtifactRecord>;
  /** 跨项目请求返回 ownership 而非放行；不存在返回 not_found。 */
  getArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord>;
  /**
   * pending→ready/failed 的 CAS 状态转换；ready 转换要求实测 hash 与登记
   * 预期摘要一致并携带实际 size；过期 revision 或终态重复转换返回 conflict。
   */
  transitionArtifact(projectId: string, artifactId: string, input: unknown): Promise<ArtifactRecord>;
  /** 仅同项目 ready 制品返回有效输入引用；pending/failed 返回 conflict。 */
  getArtifactInputRef(projectId: string, artifactId: string): Promise<ArtifactInputRef>;
  /**
   * 有界分页列出项目制品索引（按稳定 id 排序，游标为上一页最后一条 id）。
   * 项目不存在返回 not_found；分页参数非法返回 validation。为中断核对与
   * 批量恢复（F-012）提供只读入口，不参与任何写路径。
   */
  listArtifacts(projectId: string, options?: unknown): Promise<ArtifactListPage>;
}

/** 制品列表分页默认/最大每批条目数（与制品文件扫描上限对齐）。 */
export const ARTIFACT_LIST_DEFAULT_LIMIT = 64;
export const ARTIFACT_LIST_MAX_LIMIT = 256;

/** 制品索引分页页：游标为下一页起始（上一页最后一条 id），无更多为 null。 */
export interface ArtifactListPage {
  readonly records: readonly ArtifactRecord[];
  readonly nextCursor: string | null;
}

export function validateArtifactListOptions(
  value: unknown,
  operation: string,
): { limit: number; cursor?: string } {
  const context: ValidationContext = { operation };
  if (value === undefined) {
    return { limit: ARTIFACT_LIST_DEFAULT_LIMIT };
  }
  const object = requirePlainObject(value, context, 'options');
  rejectUnknownKeys(object, ['limit', 'cursor'], context, 'options');
  let limit = ARTIFACT_LIST_DEFAULT_LIMIT;
  if (object.limit !== undefined) {
    if (
      typeof object.limit !== 'number' ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > ARTIFACT_LIST_MAX_LIMIT
    ) {
      throw validationError(
        context,
        'options.limit',
        `必须是 1..${ARTIFACT_LIST_MAX_LIMIT} 的整数（每批读取上限）`,
        object.limit,
      );
    }
    limit = object.limit;
  }
  if (object.cursor !== undefined) {
    if (
      typeof object.cursor !== 'string' ||
      object.cursor.length === 0 ||
      object.cursor.includes('/') ||
      object.cursor.includes('\0')
    ) {
      throw validationError(context, 'options.cursor', '必须是上一页返回的制品 id 游标', object.cursor);
    }
    return { limit, cursor: object.cursor };
  }
  return { limit };
}
