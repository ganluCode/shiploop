/**
 * P03-2 / F-004 执行必需输入的受控采集与校验读取（application 层编排）：
 * 将可变来源固定为同项目不可变正文引用，读取前做完整完整性核验。
 *
 * 设计依据：core-design/06（Attempt 固定输入引用和摘要，缺失必需输入明确
 * 失败，不能把可变化路径当作快照）、core-design/13 §2（InputManifest 记录
 * 选取与读取证据）、core-design/03 §4（发布 staging→校验→ready；文件 I/O
 * 不在数据库事务内）。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（ArtifactStore / InputSourceFileReader）与既有
 *   application 用例（ArtifactPublisher / ArtifactVerifier），不新建制品库、
 *   不做通用知识检索、不接触具体适配器与绝对路径；物理位置与路径安全完全
 *   由文件端口/适配器承担；
 * - 采集（captureRequiredInputs）：
 *   · 文件来源：经 InputSourceFileReader（获准根白名单 + realpath/no-follow）
 *     捕获实际字节（有界缓冲，逐块增量 SHA-256 与字节数、逐项时间预算检查），
 *     复用 ArtifactPublisher 发布为同项目不可变受管 Artifact；源文件绝对
 *     路径不进入引用与错误（origin 只保留获准根 ID + 相对路径）；
 *   · 制品来源：经 ArtifactStore 核验同项目归属（跨项目 ownership）与 ready
 *     状态（pending/failed 明确失败），引用身份字段（版本/hash/大小/locator/
 *     mediaType）一律取自权威索引记录，不信任请求方携带值、绝不修补 hash；
 *   · 所有项都是必需输入：任何一项失败整批明确失败（fail-fast），不静默
 *     省略；失败前已发布的制品保持不可变（本身就是可核对证据），不回滚；
 * - 校验读取（readRequiredInput）：复用 ArtifactVerifier.readVerifiedContent
 *   核验 ready 状态、预期摘要、字节数与受控位置（缺失抛 corrupt 而不是返回
 *   空内容）；随后核对请求方引用与权威核验结果一致（hash/size/locator 不一致
 *   即 mismatch 明确失败，不修补引用）；引用项目与请求项目不一致即
 *   ownership；读取结果按单项字节上限与读取时间预算约束（显式有限）；
 * - 预算显式有限：maxItems（引用数量）、maxItemBytes（单项字节）、
 *   maxTotalBytes（批量总字节）、captureTimeoutMs（采集逐项时间预算）、
 *   readTimeoutMs（读取时间预算）；时钟可注入以保证确定性测试；本用例只按
 *   artifactId 定点核验，不扫描全部历史（批量核对属 F-012 verifyProject）；
 * - 秘密纪律：输入项不允许内联正文/凭据字段（契约层 rejectUnknownKeys
 *   fail-closed）；凭据只以引用表达，不解析认证材料；错误消息与 details
 *   只含相对逻辑位置、摘要、字节数、限制值与脱敏错误码，绝不包含绝对路径
 *   或正文内容；
 * - 失败证据：发布失败由 ArtifactPublisher 保留 failed 索引与 staging 残留
 *   （本模块把 ArtifactPublishError 包为 code='publish' 并保留 cause 与
 *   artifactId）；文件 I/O 由发布/核对用例保证不在 SQLite 写事务内等待；
 * - 错误关联适用身份：ExecutionInputError 携带 projectId/taskId/artifactId/
 *   purpose（可得时）与 cause；
 * - import 本模块无副作用；createExecutionInputService 只校验依赖与限制，
 *   不执行任何 I/O。
 *
 * 本模块不实现：InputManifest/prompt 生成（F-005）、执行输入准备编排与
 * snapshot 制品组（F-006）、Host/CLI 接线（F-007/F-008）、强 OS 沙箱
 * （可信项目模式，见 ports/execution-input.ts 文件头说明）。
 */
import { createHash } from 'node:crypto';
import { isStorageError } from '../ports/errors.js';
import { isArtifactFileError } from '../ports/artifact-files.js';
import {
  EXECUTION_INPUT_ARTIFACT_KIND,
  EXECUTION_INPUT_DEFAULT_MEDIA_TYPE,
  EXECUTION_INPUT_LOCATOR_PREFIX,
  isInputSourceError,
  validateExecutionInputItem,
  validateExecutionInputRef,
} from '../ports/execution-input.js';
import type {
  ExecutionInputItem,
  ExecutionInputRef,
  InputSourceFileReader,
} from '../ports/execution-input.js';
import type { ArtifactRecord, ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactCorruption } from '../ports/artifact-store.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateStableId,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import { isArtifactPublishError } from './artifact-publish.js';
import type { ArtifactPublisher } from './artifact-publish.js';
import { isArtifactVerifyError } from './artifact-verify.js';
import type { ArtifactVerifier } from './artifact-verify.js';

/** 采集/读取失败类别。 */
export type ExecutionInputErrorCode =
  /** 输入或引用形态违反契约（含内联正文/未知键）。 */
  | 'validation'
  /** 必需源文件或目标制品缺失。 */
  | 'not_found'
  /** 跨项目引用或读取（引用项目与请求项目不一致）。 */
  | 'ownership'
  /** 制品引用不是 ready（pending/failed），不可用且不修补。 */
  | 'not_ready'
  /** 正文损坏（missing / size_mismatch / hash_mismatch），corruption 携带诊断。 */
  | 'corrupt'
  /** 受控源文件不可用（逃逸/非常规/权限/IO/读取期间变化），details.reason 携带脱敏类别。 */
  | 'source_unavailable'
  /** 引用数量/单项字节/总字节边界超限，details.limit 携带触界预算名。 */
  | 'limit_exceeded'
  /** 采集或读取超过时间预算，details.phase 携带阶段。 */
  | 'timeout'
  /** 请求方引用与权威核验结果不一致（疑似修补引用），拒绝放行。 */
  | 'mismatch'
  /** 制品发布失败（cause 为 ArtifactPublishError；索引保留 failed/pending 证据）。 */
  | 'publish'
  /** 存储端口错误（见 cause）。 */
  | 'storage'
  /** 文件端口错误（见 cause）。 */
  | 'file';

export interface ExecutionInputErrorOptions {
  readonly projectId?: string;
  readonly taskId?: string | null;
  readonly artifactId?: string | null;
  readonly purpose?: string;
  readonly corruption?: ArtifactCorruption;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * 执行输入采集/读取失败：携带类别与适用实体身份（项目/Task/Artifact/用途）。
 * 消息与 details 只含相对逻辑位置、摘要、字节数、限制值与脱敏错误码，
 * 不含绝对路径或正文内容；cause 保留原始错误供诊断。
 */
export class ExecutionInputError extends Error {
  readonly code: ExecutionInputErrorCode;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly artifactId: string | null;
  readonly purpose: string | null;
  readonly corruption: ArtifactCorruption | null;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ExecutionInputErrorCode, message: string, options: ExecutionInputErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ExecutionInputError';
    this.code = code;
    this.projectId = options.projectId ?? null;
    this.taskId = options.taskId ?? null;
    this.artifactId = options.artifactId ?? null;
    this.purpose = options.purpose ?? null;
    this.corruption = options.corruption ?? null;
    this.details = options.details;
  }
}

export function isExecutionInputError(
  value: unknown,
  code?: ExecutionInputErrorCode,
): value is ExecutionInputError {
  return value instanceof ExecutionInputError && (code === undefined || value.code === code);
}

/** 采集/读取预算：全部显式有限；时间预算用时钟可注入（确定性测试）。 */
export interface ExecutionInputLimits {
  /** 单次采集的最大引用数量（≥1）。 */
  readonly maxItems: number;
  /** 单项正文最大字节数（≥1；采集与读取都适用）。 */
  readonly maxItemBytes: number;
  /** 单次采集的总字节上限（≥1）。 */
  readonly maxTotalBytes: number;
  /** 单项文件来源采集时间预算毫秒（≥1；逐块检查）。 */
  readonly captureTimeoutMs: number;
  /** 单次读取时间预算毫秒（≥1）。 */
  readonly readTimeoutMs: number;
}

/** 采集请求：全部 items 都是必需输入；taskId 可选（错误关联用）。 */
export interface CaptureRequiredInputsRequest {
  readonly projectId: string;
  readonly taskId?: string;
  readonly items: readonly unknown[];
}

/** 采集结果：固定引用集（顺序与请求一致）与总字节数。 */
export interface ExecutionInputCapture {
  readonly projectId: string;
  readonly taskId: string | null;
  readonly refs: readonly ExecutionInputRef[];
  readonly totalBytes: number;
  readonly capturedAtUtcMs: number;
}

/** 校验读取结果：经一致性核对的引用与核验通过的正文字节。 */
export interface ExecutionInputContent {
  readonly ref: ExecutionInputRef;
  readonly content: Uint8Array;
}

export interface ExecutionInputServiceDeps {
  readonly artifacts: ArtifactStore;
  readonly publisher: ArtifactPublisher;
  readonly verifier: ArtifactVerifier;
  readonly sources: InputSourceFileReader;
  readonly limits: ExecutionInputLimits;
  /** 时间预算用时钟（默认 Date.now）；测试注入以获得确定性。 */
  readonly nowMs?: () => number;
}

/**
 * 执行必需输入采集与校验读取窄用例。
 */
export interface ExecutionInputService {
  /** 受控采集：必需输入逐项固定为同项目不可变引用；任何失败整批明确失败。 */
  captureRequiredInputs(input: unknown): Promise<ExecutionInputCapture>;
  /** 校验读取：完整性核验 + 引用一致性核对通过后返回正文字节。 */
  readRequiredInput(projectId: string, ref: unknown): Promise<ExecutionInputContent>;
}

function validateLimits(value: unknown, operation: string): ExecutionInputLimits {
  const context: ValidationContext = { operation };
  const object = requirePlainObject(value, context, 'limits');
  rejectUnknownKeys(
    object,
    ['maxItems', 'maxItemBytes', 'maxTotalBytes', 'captureTimeoutMs', 'readTimeoutMs'],
    context,
    'limits',
  );
  return {
    maxItems: validatePositiveInteger(object.maxItems, context, 'limits.maxItems'),
    maxItemBytes: validatePositiveInteger(object.maxItemBytes, context, 'limits.maxItemBytes'),
    maxTotalBytes: validatePositiveInteger(object.maxTotalBytes, context, 'limits.maxTotalBytes'),
    captureTimeoutMs: validatePositiveInteger(object.captureTimeoutMs, context, 'limits.captureTimeoutMs'),
    readTimeoutMs: validatePositiveInteger(object.readTimeoutMs, context, 'limits.readTimeoutMs'),
  };
}

/**
 * 装配执行必需输入采集/读取用例。只校验依赖形态与限制，不执行任何 I/O；
 * import 本模块无副作用。
 */
export function createExecutionInputService(deps: ExecutionInputServiceDeps): ExecutionInputService {
  const operation = 'ExecutionInputService';
  const context: ValidationContext = { operation: `${operation}.create` };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 artifacts/publisher/verifier/sources/limits 装配依赖');
  }
  for (const [field, value] of [
    ['artifacts', deps.artifacts],
    ['publisher', deps.publisher],
    ['verifier', deps.verifier],
    ['sources', deps.sources],
  ] as const) {
    if (value === null || typeof value !== 'object') {
      throw validationError(context, `deps.${field}`, `必须提供 ${field} 端口/用例实现`);
    }
  }
  const limits = validateLimits(deps.limits, `${operation}.create`);
  const nowMs = deps.nowMs ?? Date.now;
  const { artifacts, publisher, verifier, sources } = deps;

  interface CallIdentity {
    readonly projectId: string | null;
    readonly taskId: string | null;
    readonly purpose: string | null;
  }

  function errorOf(
    code: ExecutionInputErrorCode,
    message: string,
    identity: CallIdentity & { artifactId?: string | null },
    cause?: unknown,
    options: { corruption?: ArtifactCorruption; details?: Readonly<Record<string, unknown>> } = {},
  ): ExecutionInputError {
    return new ExecutionInputError(code, message, {
      ...(identity.projectId !== null ? { projectId: identity.projectId } : {}),
      taskId: identity.taskId,
      ...(identity.artifactId !== undefined && identity.artifactId !== null
        ? { artifactId: identity.artifactId }
        : {}),
      ...(identity.purpose !== null ? { purpose: identity.purpose } : {}),
      ...(options.corruption !== undefined ? { corruption: options.corruption } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  /** 存储/文件端口错误类别映射（保留 cause 供诊断）。 */
  function portErrorCode(cause: unknown): ExecutionInputErrorCode {
    if (isStorageError(cause, 'validation')) {
      return 'validation';
    }
    if (isStorageError(cause, 'not_found')) {
      return 'not_found';
    }
    if (isStorageError(cause, 'ownership')) {
      return 'ownership';
    }
    if (isStorageError(cause, 'conflict')) {
      return 'not_ready';
    }
    if (isStorageError(cause)) {
      return 'storage';
    }
    if (isArtifactFileError(cause)) {
      return 'file';
    }
    return 'storage';
  }

  /** 采集请求整体验证（数量边界先行；逐项校验在采集循环内以携带用途身份）。 */
  function validateCaptureRequest(
    input: unknown,
  ): { projectId: string; taskId: string | null; items: readonly unknown[] } {
    const op = `${operation}.captureRequiredInputs`;
    let object: Record<string, unknown>;
    try {
      object = requirePlainObject(input, { operation: op }, 'input');
      rejectUnknownKeys(object, ['projectId', 'taskId', 'items'], { operation: op }, 'input');
    } catch (cause) {
      throw errorOf('validation', (cause as Error).message, { projectId: null, taskId: null, purpose: null }, cause);
    }
    const identity: { projectId: string | null; taskId: string | null; purpose: string | null } = {
      projectId: typeof object.projectId === 'string' ? object.projectId : null,
      taskId: typeof object.taskId === 'string' ? object.taskId : null,
      purpose: null,
    };
    let projectId: string;
    let taskId: string | null = null;
    try {
      projectId = validateStableId(object.projectId, { operation: op }, 'input.projectId');
      if (object.taskId !== undefined) {
        taskId = validateStableId(object.taskId, { operation: op }, 'input.taskId');
      }
    } catch (cause) {
      throw errorOf('validation', (cause as Error).message, identity, cause);
    }
    identity.taskId = taskId;
    const items = object.items;
    if (!Array.isArray(items)) {
      throw errorOf('validation', `${op}: items 必须是必需输入项数组`, identity);
    }
    if (items.length === 0) {
      throw errorOf(
        'validation',
        `${op}: 必需输入集为空——缺失必需输入必须显式声明，不允许静默省略`,
        identity,
        undefined,
        { details: { reason: 'empty_items' } },
      );
    }
    if (items.length > limits.maxItems) {
      throw errorOf(
        'limit_exceeded',
        `${op}: 引用数量 ${items.length} 超过上限 ${limits.maxItems}（拒绝无界采集）`,
        identity,
        undefined,
        { details: { limit: 'maxItems', maxItems: limits.maxItems, actualItems: items.length } },
      );
    }
    const seen = new Set<string>();
    for (const raw of items) {
      const purpose =
        typeof raw === 'object' && raw !== null
          ? (raw as { purpose?: unknown }).purpose
          : undefined;
      if (typeof purpose === 'string') {
        if (seen.has(purpose)) {
          throw errorOf(
            'validation',
            `${op}: 用途 "${purpose}" 重复（用途标识必需输入，重复拒绝）`,
            { ...identity, purpose },
            undefined,
            { details: { reason: 'duplicate_purpose', purpose } },
          );
        }
        seen.add(purpose);
      }
    }
    return { projectId, taskId, items };
  }

  /** 制品来源采集：归属与 ready 核验；身份字段一律取自权威索引记录。 */
  async function captureArtifactSource(
    projectId: string,
    taskId: string | null,
    item: ExecutionInputItem & { source: { kind: 'artifact' } },
  ): Promise<ExecutionInputRef> {
    const op = `${operation}.captureRequiredInputs`;
    const identity = { projectId, taskId, purpose: item.purpose, artifactId: item.source.artifactId };
    let record: ArtifactRecord;
    try {
      record = await artifacts.getArtifact(projectId, item.source.artifactId);
    } catch (cause) {
      throw errorOf(
        portErrorCode(cause),
        `${op}: 读取制品索引失败（用途 "${item.purpose}"）`,
        identity,
        cause,
      );
    }
    if (record.status !== 'ready') {
      throw errorOf(
        'not_ready',
        `${op}: 制品状态 ${record.status} 不能作为必需输入引用（仅 ready 可用；不修补、不伪装可用）`,
        identity,
        undefined,
        { details: { status: record.status } },
      );
    }
    if (record.contentHash === null || record.sizeBytes === null) {
      // 防御纵深：不信任持久层——ready 行缺少 hash/size 证据一律拒绝放行。
      throw errorOf(
        'corrupt',
        `${op}: ready 行缺少 hash/size 证据，拒绝引用`,
        identity,
        undefined,
        { details: { reason: 'index_missing_evidence' } },
      );
    }
    if (record.sizeBytes > limits.maxItemBytes) {
      throw errorOf(
        'limit_exceeded',
        `${op}: 引用正文 ${record.sizeBytes} 字节超过单项上限 ${limits.maxItemBytes}`,
        identity,
        undefined,
        { details: { limit: 'maxItemBytes', maxItemBytes: limits.maxItemBytes, actualBytes: record.sizeBytes } },
      );
    }
    return {
      projectId: record.projectId,
      artifactId: record.id,
      kind: record.kind,
      purpose: item.purpose,
      version: record.version,
      contentHash: record.contentHash,
      sizeBytes: record.sizeBytes,
      locator: record.locator,
      mediaType: record.mediaType,
      origin: { kind: 'artifact' },
    };
  }

  /** 文件来源采集：有界捕获实际字节（逐块 hash/size/时间预算）并发布为不可变制品。 */
  async function captureFileSource(
    projectId: string,
    taskId: string | null,
    item: ExecutionInputItem & { source: { kind: 'file' } },
  ): Promise<ExecutionInputRef> {
    const op = `${operation}.captureRequiredInputs`;
    const identity = { projectId, taskId, purpose: item.purpose };
    let content;
    try {
      content = await sources.openSourceRead({
        root: item.source.root,
        relativePath: item.source.relativePath,
      });
    } catch (cause) {
      if (isInputSourceError(cause)) {
        const code: ExecutionInputErrorCode = cause.kind === 'not_found' ? 'not_found' : 'source_unavailable';
        throw errorOf(
          code,
          `${op}: 必需输入源文件不可用（用途 "${item.purpose}"；${cause.kind}），缺失必需输入明确失败`,
          identity,
          cause,
          { details: { reason: cause.kind, root: item.source.root, relativePath: item.source.relativePath } },
        );
      }
      if (isStorageError(cause, 'validation')) {
        throw errorOf('validation', (cause as Error).message, identity, cause);
      }
      throw errorOf('source_unavailable', `${op}: 打开源文件失败`, identity, cause, {
        details: { reason: 'unknown', root: item.source.root, relativePath: item.source.relativePath },
      });
    }

    // 有界捕获：逐块增量 SHA-256 与字节数；超限/超时即销毁流并明确失败。
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    const startedAtMs = nowMs();
    try {
      for await (const chunk of content.stream) {
        const data = chunk as Buffer;
        sizeBytes += data.byteLength;
        if (sizeBytes > limits.maxItemBytes) {
          throw errorOf(
            'limit_exceeded',
            `${op}: 源文件超过单项上限 ${limits.maxItemBytes} 字节（拒绝无界捕获）`,
            identity,
            undefined,
            { details: { limit: 'maxItemBytes', maxItemBytes: limits.maxItemBytes, root: item.source.root, relativePath: item.source.relativePath } },
          );
        }
        if (nowMs() - startedAtMs > limits.captureTimeoutMs) {
          throw errorOf(
            'timeout',
            `${op}: 采集超过时间预算 ${limits.captureTimeoutMs}ms（拒绝无限等待）`,
            identity,
            undefined,
            { details: { phase: 'capture', captureTimeoutMs: limits.captureTimeoutMs, root: item.source.root, relativePath: item.source.relativePath } },
          );
        }
        hash.update(data);
        chunks.push(data);
      }
    } catch (cause) {
      content.stream.destroy();
      if (cause instanceof ExecutionInputError) {
        throw cause;
      }
      throw errorOf('source_unavailable', `${op}: 读取源文件失败`, identity, cause, {
        details: { reason: 'stream_read_failed', root: item.source.root, relativePath: item.source.relativePath },
      });
    }
    if (sizeBytes !== content.sizeBytes) {
      // 读取期间源文件变化（stat 与实测不一致）：明确失败，不捕获不确定正文。
      throw errorOf('source_unavailable', `${op}: 读取期间源文件字节数变化，拒绝捕获不确定正文`, identity, undefined, {
        details: {
          reason: 'source_changed_during_read',
          statBytes: content.sizeBytes,
          measuredBytes: sizeBytes,
          root: item.source.root,
          relativePath: item.source.relativePath,
        },
      });
    }

    const body = Buffer.concat(chunks);
    const expectedHash = hash.digest('hex');
    const mediaType = item.source.mediaType ?? EXECUTION_INPUT_DEFAULT_MEDIA_TYPE;
    let published;
    try {
      published = await publisher.publishArtifact({
        projectId,
        kind: EXECUTION_INPUT_ARTIFACT_KIND,
        mediaType,
        expectedHash,
        locator: `${EXECUTION_INPUT_LOCATOR_PREFIX}/${item.purpose}`,
        content: [body],
      });
    } catch (cause) {
      if (isArtifactPublishError(cause)) {
        throw errorOf(
          'publish',
          `${op}: 必需输入发布失败（阶段 ${cause.stage}；索引保留可诊断证据，引用不可用）`,
          { ...identity, artifactId: cause.artifactId },
          cause,
          { details: { publishStage: cause.stage, publishCode: cause.code, failureRecord: cause.details?.['failureRecord'] } },
        );
      }
      throw errorOf('publish', `${op}: 必需输入发布失败`, identity, cause);
    }
    const record = published.artifact;
    return {
      projectId: record.projectId,
      artifactId: record.id,
      kind: record.kind,
      purpose: item.purpose,
      version: record.version,
      contentHash: record.contentHash ?? expectedHash,
      sizeBytes: record.sizeBytes ?? sizeBytes,
      locator: record.locator,
      mediaType: record.mediaType,
      origin: { kind: 'file', root: item.source.root, relativePath: item.source.relativePath },
    };
  }

  return {
    async captureRequiredInputs(input: unknown): Promise<ExecutionInputCapture> {
      const op = `${operation}.captureRequiredInputs`;
      const request = validateCaptureRequest(input);
      const refs: ExecutionInputRef[] = [];
      let totalBytes = 0;
      for (const raw of request.items) {
        let item: ExecutionInputItem;
        const purpose =
          typeof raw === 'object' && raw !== null
            ? (raw as { purpose?: unknown }).purpose
            : undefined;
        const itemIdentity = {
          projectId: request.projectId,
          taskId: request.taskId,
          purpose: typeof purpose === 'string' ? purpose : null,
        };
        try {
          item = validateExecutionInputItem(raw, op);
        } catch (cause) {
          throw errorOf('validation', (cause as Error).message, itemIdentity, cause);
        }
        const ref =
          item.source.kind === 'artifact'
            ? await captureArtifactSource(request.projectId, request.taskId, item as ExecutionInputItem & { source: { kind: 'artifact' } })
            : await captureFileSource(request.projectId, request.taskId, item as ExecutionInputItem & { source: { kind: 'file' } });
        totalBytes += ref.sizeBytes;
        if (totalBytes > limits.maxTotalBytes) {
          throw errorOf(
            'limit_exceeded',
            `${op}: 采集总字节超过上限 ${limits.maxTotalBytes}（拒绝无界采集）`,
            itemIdentity,
            undefined,
            { details: { limit: 'maxTotalBytes', maxTotalBytes: limits.maxTotalBytes, actualBytes: totalBytes } },
          );
        }
        refs.push(ref);
      }
      return {
        projectId: request.projectId,
        taskId: request.taskId,
        refs,
        totalBytes,
        capturedAtUtcMs: nowMs(),
      };
    },

    async readRequiredInput(projectId: string, ref: unknown): Promise<ExecutionInputContent> {
      const op = `${operation}.readRequiredInput`;
      let validProjectId: string;
      try {
        validProjectId = validateStableId(projectId, { operation: op }, 'projectId');
      } catch (cause) {
        throw errorOf('validation', (cause as Error).message, { projectId: null, taskId: null, purpose: null }, cause);
      }
      let valid: ExecutionInputRef;
      try {
        valid = validateExecutionInputRef(ref, op);
      } catch (cause) {
        throw errorOf('validation', (cause as Error).message, { projectId: validProjectId, taskId: null, purpose: null }, cause);
      }
      const identity = {
        projectId: valid.projectId,
        taskId: null,
        purpose: valid.purpose,
        artifactId: valid.artifactId,
      };
      if (valid.projectId !== validProjectId) {
        throw errorOf(
          'ownership',
          `${op}: 引用归属项目与请求项目不一致（跨项目引用拒绝）`,
          identity,
          undefined,
          { details: { reason: 'cross_project_reference' } },
        );
      }
      if (valid.sizeBytes > limits.maxItemBytes) {
        throw errorOf(
          'limit_exceeded',
          `${op}: 引用正文 ${valid.sizeBytes} 字节超过单项上限 ${limits.maxItemBytes}（拒绝无界缓存）`,
          identity,
          undefined,
          { details: { limit: 'maxItemBytes', maxItemBytes: limits.maxItemBytes, actualBytes: valid.sizeBytes } },
        );
      }
      const startedAtMs = nowMs();
      let verified;
      try {
        verified = await verifier.readVerifiedContent(valid.projectId, valid.artifactId);
      } catch (cause) {
        if (isArtifactVerifyError(cause)) {
          const mapped: ExecutionInputErrorCode =
            cause.code === 'conflict'
              ? 'not_ready'
              : cause.code === 'size_limit_exceeded'
                ? 'limit_exceeded'
                : cause.code;
          throw errorOf(
            mapped,
            `${op}: ${cause.message}`,
            identity,
            cause,
            {
              ...(cause.corruption !== null ? { corruption: cause.corruption } : {}),
              details: {
                ...(cause.details ?? {}),
                ...(cause.code === 'conflict' ? { status: (cause.details?.['status'] as string | undefined) ?? 'unknown' } : {}),
                ...(cause.code === 'size_limit_exceeded' ? { limit: 'maxReadBytes' } : {}),
              },
            },
          );
        }
        throw errorOf(portErrorCode(cause), `${op}: 完整性核验读取失败`, identity, cause);
      }
      if (nowMs() - startedAtMs > limits.readTimeoutMs) {
        throw errorOf(
          'timeout',
          `${op}: 读取超过时间预算 ${limits.readTimeoutMs}ms（核验通过但超预算，内容丢弃）`,
          identity,
          undefined,
          { details: { phase: 'read', readTimeoutMs: limits.readTimeoutMs } },
        );
      }
      // 引用一致性核对：请求方引用必须与权威核验结果一致；不一致即疑似修补，
      // 明确失败，绝不采用引用携带值放行。
      const mismatches: string[] = [];
      if (valid.contentHash !== verified.contentHash) {
        mismatches.push('contentHash');
      }
      if (valid.sizeBytes !== verified.sizeBytes) {
        mismatches.push('sizeBytes');
      }
      if (valid.locator !== verified.locator) {
        mismatches.push('locator');
      }
      if (mismatches.length > 0) {
        throw errorOf(
          'mismatch',
          `${op}: 引用与权威核验结果不一致（${mismatches.join('/')}；疑似修补引用，拒绝放行）`,
          identity,
          undefined,
          {
            details: {
              reason: 'reference_mismatch',
              fields: mismatches,
              expectedHash: valid.contentHash,
              actualHash: verified.contentHash,
            },
          },
        );
      }
      return { ref: valid, content: verified.content };
    },
  };
}
