/**
 * F-011 制品流式发布编排（application 层）：pending 登记 → 事务外 staging
 * 流式写入与同步 → hash 核验 → 同文件系统不覆盖发布 → 短事务 CAS 标 ready。
 *
 * 设计依据：core-design/03 §4（注册 pending → 写同文件系统 staging → flush
 * 校验 hash 原子发布 → 标记 ready；文件流、fsync 与发布不在数据库事务内；
 * rename 原子性不等于断电耐久性）与 F-011 验收点。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（ArtifactStore / ArtifactFileStore）与 node 内置模块，
 *   不接触具体适配器、驱动或绝对路径；物理位置推导完全由文件端口承担；
 * - 严格顺序：registerArtifact（短事务 pending）→ openStagingWrite/逐块写入
 *   → finishStaging（fsync + 关闭）→ 核验实测 hash/size → publishStaging
 *   （hard link 不覆盖 + 目录同步）→ transitionArtifact（短事务 CAS ready）；
 * - 内容逐块增量计算 SHA-256 与字节数，配合背压（drain）写入，绝不将整个
 *   大流无限缓存在内存；限制显式有限：maxSizeBytes 超限即失败、timeoutMs
 *   为 staging 阶段时间预算（时钟可注入以保证确定性测试）、AbortSignal 支持
 *   取消（含等待下一块期间的有界中止）；
 * - 失败语义（不伪装成功、不自动删除未知文件）：
 *   · register 失败：无任何副作用，stage='register'；
 *   · staging/verify/publish 失败（超限、超时、取消、流错误、非字节块、
 *     hash 不匹配、写入/同步/发布失败）：索引经端口 CAS 标 failed 并保留
 *     阶段化失败原因，staging 残留保留供 F-012 核对；
 *   · commit 失败（正式文件已发布但 ready 提交失败，如 busy）：保留 pending
 *     索引与正式文件供恢复（failureRecord='kept_pending'），不标 failed、
 *     不删除任何文件；
 * - 抛出 ArtifactPublishError（stage/code/projectId/artifactId/details/cause）；
 *   消息与 details 只含相对逻辑位置、限制值与摘要级信息，不含绝对路径或
 *   正文内容；
 * - import 本模块无副作用；createArtifactPublisher 只校验依赖与限制，不执行
 *   任何 I/O。
 *
 * 本模块不实现：中断核对与损坏诊断（F-012）、制品删除/保留策略、Host/CLI
 * 命令；断电/真实磁盘满演练与其他平台验收不在本阶段（注入故障一律明确标注）。
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { isStorageError } from '../ports/errors.js';
import { ArtifactFileError, isArtifactFileError } from '../ports/artifact-files.js';
import type {
  ArtifactFileStore,
  ArtifactStagingFile,
  ArtifactStagingWrite,
} from '../ports/artifact-files.js';
import type { ArtifactRecord, ArtifactStore } from '../ports/artifact-store.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateArtifactLocator,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

/** 发布阶段：用于失败定位与 failed 记录的阶段化证据。 */
export type ArtifactPublishStage = 'register' | 'staging' | 'verify' | 'publish' | 'commit';

/** 发布失败类别。 */
export type ArtifactPublishFailureCode =
  /** 输入或内容块违反契约（含非 Uint8Array 块）。 */
  | 'validation'
  /** 实测字节数超过 maxSizeBytes。 */
  | 'size_limit_exceeded'
  /** staging 阶段超过 timeoutMs 时间预算。 */
  | 'timeout'
  /** AbortSignal 中止（含等待下一块期间）。 */
  | 'cancelled'
  /** 内容流生产方抛错。 */
  | 'stream'
  /** 实测 SHA-256 与登记的预期摘要不一致。 */
  | 'hash_mismatch'
  /** staging/发布回报的字节数与实测不一致（防御纵深，正常不应发生）。 */
  | 'size_mismatch'
  /** 存储端口错误（busy/conflict/not_found 等，见 cause）。 */
  | 'storage'
  /** 文件端口错误（写入/同步/发布失败等，见 cause）。 */
  | 'file';

export interface ArtifactPublishErrorOptions {
  readonly projectId: string;
  readonly artifactId: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * 制品发布失败：携带阶段、类别与适用实体身份。消息与 details 只含相对逻辑
 * 位置、限制值与摘要级信息，不含绝对路径或正文内容；cause 保留原始端口错误
 * （StorageError/ArtifactFileError）供诊断。
 */
export class ArtifactPublishError extends Error {
  readonly stage: ArtifactPublishStage;
  readonly code: ArtifactPublishFailureCode;
  readonly projectId: string;
  readonly artifactId: string | null;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    stage: ArtifactPublishStage,
    code: ArtifactPublishFailureCode,
    message: string,
    options: ArtifactPublishErrorOptions,
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ArtifactPublishError';
    this.stage = stage;
    this.code = code;
    this.projectId = options.projectId;
    this.artifactId = options.artifactId;
    this.details = options.details;
  }
}

export function isArtifactPublishError(
  value: unknown,
  stage?: ArtifactPublishStage,
): value is ArtifactPublishError {
  return value instanceof ArtifactPublishError && (stage === undefined || value.stage === stage);
}

/** 发布限制：显式有限的大小与时间预算；取消由每次发布的 AbortSignal 承担。 */
export interface ArtifactPublishLimits {
  /** 正文最大字节数（≥1 整数；实测超限即失败）。 */
  readonly maxSizeBytes: number;
  /** staging 阶段时间预算毫秒（≥1 整数；超时即失败）。 */
  readonly timeoutMs: number;
}

/** 发布输入：content 为字节块流（同步或异步可迭代），逐块消费。 */
export interface PublishArtifactInput {
  readonly projectId: string;
  readonly kind: string;
  readonly mediaType: string;
  /** 登记时声明的预期 SHA-256 摘要；staging 完成后据以核验。 */
  readonly expectedHash: string;
  /** 受控逻辑 locator（POSIX 相对）；不参与物理路径推导。 */
  readonly locator: string;
  readonly version?: number;
  /** 字节块内容流；空迭代即空正文。 */
  readonly content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  /** 取消信号；中止使发布失败并保留 failed 记录与 staging 残留。 */
  readonly signal?: AbortSignal;
}

export interface ValidatedPublishArtifactInput {
  readonly projectId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly expectedHash: string;
  readonly locator: string;
  readonly version: number;
  readonly content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export function validatePublishArtifactInput(
  value: unknown,
  operation: string,
): ValidatedPublishArtifactInput {
  const context: ValidationContext = { operation, entity: { type: 'artifact' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(
    object,
    ['projectId', 'kind', 'mediaType', 'expectedHash', 'locator', 'version', 'content', 'signal'],
    context,
    'input',
  );
  const projectId = validateStableId(object.projectId, context, 'projectId');
  const content = object.content;
  const isByteStream =
    typeof content !== 'string' &&
    content !== null &&
    (typeof content === 'object' || typeof content === 'function') &&
    (Symbol.asyncIterator in Object(content) || Symbol.iterator in Object(content));
  if (!isByteStream) {
    throw validationError(
      context,
      'content',
      '必须是 Uint8Array 块的可迭代/异步可迭代内容流',
      typeof content,
    );
  }
  if (object.signal !== undefined && !(object.signal instanceof AbortSignal)) {
    throw validationError(context, 'signal', '必须是 AbortSignal', typeof object.signal);
  }
  return {
    projectId,
    kind: requireNonEmptyString(object.kind, context, 'kind'),
    mediaType: requireNonEmptyString(object.mediaType, context, 'mediaType'),
    expectedHash: validateSha256Digest(object.expectedHash, context, 'expectedHash'),
    locator: validateArtifactLocator(object.locator, context, 'locator'),
    version:
      object.version === undefined ? 1 : validatePositiveInteger(object.version, context, 'version'),
    content: content as AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    ...(object.signal !== undefined ? { signal: object.signal as AbortSignal } : {}),
  };
}

/** 发布结果：ready 索引记录（revision 已递增）与正式文件受控相对位置。 */
export interface ArtifactPublishResult {
  readonly artifact: ArtifactRecord;
  /** 正式文件受控根内相对位置（POSIX 分隔）。 */
  readonly finalRelativePath: string;
}

/**
 * 制品流式发布窄用例：组合 ArtifactStore（索引）与 ArtifactFileStore（正文），
 * 对外只暴露 publishArtifact。
 */
export interface ArtifactPublisher {
  publishArtifact(input: unknown): Promise<ArtifactPublishResult>;
}

export interface ArtifactPublisherDeps {
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  readonly limits: ArtifactPublishLimits;
  /** staging 时间预算用时钟（默认 Date.now）；测试注入以获得确定性。 */
  readonly nowMs?: () => number;
}

function validateLimits(limits: unknown, operation: string): ArtifactPublishLimits {
  const context: ValidationContext = { operation };
  const object = requirePlainObject(limits, context, 'limits');
  rejectUnknownKeys(object, ['maxSizeBytes', 'timeoutMs'], context, 'limits');
  return {
    maxSizeBytes: validatePositiveInteger(object.maxSizeBytes, context, 'limits.maxSizeBytes'),
    timeoutMs: validatePositiveInteger(object.timeoutMs, context, 'limits.timeoutMs'),
  };
}

/**
 * 装配制品流式发布用例。只校验依赖形态与限制，不执行任何 I/O；
 * import 本模块无副作用。
 */
export function createArtifactPublisher(deps: ArtifactPublisherDeps): ArtifactPublisher {
  const operation = 'ArtifactPublisher.publishArtifact';
  const context: ValidationContext = { operation: 'ArtifactPublisher.create' };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 artifacts/files/limits 装配依赖');
  }
  if (deps.artifacts === null || typeof deps.artifacts !== 'object') {
    throw validationError(context, 'deps.artifacts', '必须提供 ArtifactStore 端口实现');
  }
  if (deps.files === null || typeof deps.files !== 'object') {
    throw validationError(context, 'deps.files', '必须提供 ArtifactFileStore 端口实现');
  }
  const limits = validateLimits(deps.limits, 'ArtifactPublisher.create');
  const nowMs = deps.nowMs ?? Date.now;
  const { artifacts, files } = deps;

  /** 失败原因：阶段化、脱敏（只有相对位置/限制值/摘要），供 failed 记录保留。 */
  function failureReason(
    stage: ArtifactPublishStage,
    code: ArtifactPublishFailureCode,
    evidence: readonly string[],
  ): string {
    return [`stage=${stage}`, `code=${code}`, ...evidence].join('; ');
  }

  /** 索引标 failed（尽力而为）：返回记录结果供错误 details 表达。 */
  async function markFailed(
    record: ArtifactRecord,
    reason: string,
  ): Promise<'failed_recorded' | 'failed_unrecorded'> {
    try {
      await artifacts.transitionArtifact(record.projectId, record.id, {
        expectedRevision: record.revision,
        outcome: { status: 'failed', reason },
      });
      return 'failed_recorded';
    } catch {
      // 标 failed 本身失败（如 busy）不覆盖原始失败；残留状态仍可核对。
      return 'failed_unrecorded';
    }
  }

  /**
   * staging 失败后的清理：停止写入并关闭句柄，残留文件保留供 F-012 核对，
   * 绝不自动删除未知状态的文件。finishStaging 在流已结束/出错时负责关闭 fd。
   */
  async function closeStagingKeepResidue(write: ArtifactStagingWrite): Promise<void> {
    try {
      write.stream.end();
    } catch {
      // 流已销毁：忽略，继续关闭流程。
    }
    try {
      await files.finishStaging(write);
    } catch {
      // 流错误时适配器已关闭 fd；残留保留，清理失败不覆盖原始错误。
    }
  }

  function toPublishError(
    stage: ArtifactPublishStage,
    code: ArtifactPublishFailureCode,
    message: string,
    record: ArtifactRecord | null,
    projectId: string,
    cause: unknown,
    extraDetails: Readonly<Record<string, unknown>> = {},
  ): ArtifactPublishError {
    return new ArtifactPublishError(stage, code, message, {
      projectId,
      artifactId: record?.id ?? null,
      details: { ...extraDetails, ...(record !== null ? { artifactId: record.id } : {}) },
      cause,
    });
  }

  function codeOfPortError(cause: unknown): ArtifactPublishFailureCode {
    if (isStorageError(cause, 'validation')) {
      return 'validation';
    }
    if (isStorageError(cause)) {
      return 'storage';
    }
    if (isArtifactFileError(cause)) {
      return 'file';
    }
    return 'storage';
  }

  /** 端口错误脱敏摘要（错误类别 + 脱敏 code，不含路径/SQL 原文）。 */
  function portErrorEvidence(cause: unknown): string {
    if (isStorageError(cause)) {
      return `storage=${cause.kind}`;
    }
    if (isArtifactFileError(cause)) {
      const code = (cause.details?.['code'] as string | undefined) ?? cause.kind;
      return `fs=${code}`;
    }
    return 'cause=unknown';
  }

  return {
    async publishArtifact(input: unknown): Promise<ArtifactPublishResult> {
      const valid = validatePublishArtifactInput(input, operation);
      const projectId = valid.projectId;

      // 预先中止：任何副作用之前取消。
      if (valid.signal?.aborted === true) {
        throw new ArtifactPublishError(
          'staging',
          'cancelled',
          `${operation}: 发布前信号已中止，未产生任何副作用`,
          { projectId, artifactId: null },
        );
      }

      // 阶段 1：短事务登记 pending 索引。
      let record: ArtifactRecord;
      try {
        record = await artifacts.registerArtifact({
          projectId,
          kind: valid.kind,
          mediaType: valid.mediaType,
          expectedHash: valid.expectedHash,
          locator: valid.locator,
          version: valid.version,
        });
      } catch (cause) {
        throw toPublishError(
          'register',
          codeOfPortError(cause),
          `${operation}: pending 登记失败（${portErrorEvidence(cause)}）`,
          null,
          projectId,
          cause,
        );
      }

      /** staging/verify/publish 阶段失败：标 failed、保留残留、抛出阶段化错误。 */
      async function failAfterRegister(
        stage: 'staging' | 'verify' | 'publish',
        code: ArtifactPublishFailureCode,
        message: string,
        cause: unknown,
        evidence: readonly string[],
        extraDetails: Readonly<Record<string, unknown>> = {},
      ): Promise<never> {
        const reason = failureReason(stage, code, evidence);
        const recording = await markFailed(record, reason);
        throw toPublishError(stage, code, message, record, projectId, cause, {
          ...extraDetails,
          failureRecord: recording,
        });
      }

      const key = { projectId: record.projectId, artifactId: record.id, locator: record.locator };

      // 阶段 2：staging 流式写入（数据库事务外；增量 hash/size；背压写入）。
      let write: ArtifactStagingWrite;
      try {
        write = await files.openStagingWrite(key);
      } catch (cause) {
        return failAfterRegister(
          'staging',
          codeOfPortError(cause),
          `${operation}: staging 打开失败（${portErrorEvidence(cause)}）`,
          cause,
          [portErrorEvidence(cause)],
        );
      }
      const stagingRelativePath = write.relativePath;

      const hash = createHash('sha256');
      let sizeBytes = 0;
      const startedAtMs = nowMs();
      const signal = valid.signal;
      let onAbort: (() => void) | undefined;
      const abortPromise =
        signal === undefined
          ? undefined
          : new Promise<never>((_resolve, reject) => {
              onAbort = () => {
                reject(
                  new ArtifactPublishError('staging', 'cancelled', `${operation}: 发布被取消`, {
                    projectId,
                    artifactId: record.id,
                    details: { artifactId: record.id, stagingRelativePath },
                  }),
                );
              };
              signal.addEventListener('abort', onAbort, { once: true });
            });

      const iterator =
        Symbol.asyncIterator in Object(valid.content)
          ? (valid.content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
          : (valid.content as Iterable<Uint8Array>)[Symbol.iterator]();

      /** staging 阶段统一失败出口：关闭句柄、保留残留、标 failed、抛出。 */
      async function failStaging(
        code: ArtifactPublishFailureCode,
        message: string,
        cause: unknown,
        evidence: readonly string[],
      ): Promise<never> {
        if (onAbort !== undefined && signal !== undefined) {
          signal.removeEventListener('abort', onAbort);
        }
        // 释放内容流生产方（不等待可能悬挂的 next；可信生产方尽力清理）。
        if (typeof iterator.return === 'function') {
          void Promise.resolve()
            .then(() => iterator.return?.())
            .catch(() => {});
        }
        await closeStagingKeepResidue(write);
        return failAfterRegister(stage, code, message, cause, evidence, { stagingRelativePath });
      }
      const stage: 'staging' = 'staging';

      for (;;) {
        if (signal?.aborted === true) {
          return await failStaging(
            'cancelled',
            `${operation}: 发布被取消`,
            undefined,
            ['code=cancelled', `staging=${stagingRelativePath}（残留保留）`],
          );
        }
        if (nowMs() - startedAtMs > limits.timeoutMs) {
          return await failStaging(
            'timeout',
            `${operation}: staging 超过时间预算 ${limits.timeoutMs}ms`,
            undefined,
            [
              `timeoutMs=${limits.timeoutMs}`,
              `writtenBytes=${sizeBytes}`,
              `staging=${stagingRelativePath}（残留保留）`,
            ],
          );
        }
        let next: IteratorResult<Uint8Array>;
        try {
          next =
            abortPromise === undefined
              ? await iterator.next()
              : await Promise.race([Promise.resolve(iterator.next()), abortPromise]);
        } catch (cause) {
          if (isArtifactPublishError(cause, 'staging') && cause.code === 'cancelled') {
            return await failStaging('cancelled', cause.message, undefined, [
              'code=cancelled',
              `staging=${stagingRelativePath}（残留保留）`,
            ]);
          }
          return await failStaging(
            'stream',
            `${operation}: 内容流生产方失败`,
            cause,
            [
              'code=stream',
              `writtenBytes=${sizeBytes}`,
              `staging=${stagingRelativePath}（残留保留）`,
            ],
          );
        }
        if (next.done === true) {
          break;
        }
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array)) {
          return await failStaging(
            'validation',
            `${operation}: 内容块必须是 Uint8Array`,
            undefined,
            ['code=validation', 'field=content.chunk', `staging=${stagingRelativePath}（残留保留）`],
          );
        }
        sizeBytes += chunk.byteLength;
        if (sizeBytes > limits.maxSizeBytes) {
          return await failStaging(
            'size_limit_exceeded',
            `${operation}: 正文超过大小限制 ${limits.maxSizeBytes} 字节`,
            undefined,
            [
              `maxSizeBytes=${limits.maxSizeBytes}`,
              `actualBytes>${limits.maxSizeBytes}`,
              `staging=${stagingRelativePath}（残留保留）`,
            ],
          );
        }
        hash.update(chunk);
        try {
          const canContinue = write.stream.write(chunk);
          if (!canContinue) {
            // 背压：等待 drain；流错误时 events.once 以该错误拒绝。
            await once(write.stream, 'drain');
          }
        } catch (cause) {
          const codeText =
            (cause as NodeJS.ErrnoException | null)?.code ?? 'stream_write_failed';
          return await failStaging(
            'file',
            `${operation}: staging 写入失败（${String(codeText)}）`,
            cause,
            [`fs=${String(codeText)}`, `staging=${stagingRelativePath}（残留保留）`],
          );
        }
      }
      if (onAbort !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }

      // staging 收尾：结束流、fsync、关闭（失败保留残留）。
      let staged: ArtifactStagingFile;
      try {
        write.stream.end();
        staged = await files.finishStaging(write);
      } catch (cause) {
        return failAfterRegister(
          'staging',
          codeOfPortError(cause),
          `${operation}: staging 同步/关闭失败（${portErrorEvidence(cause)}）`,
          cause,
          [portErrorEvidence(cause), `staging=${stagingRelativePath}（残留保留）`],
          { stagingRelativePath },
        );
      }
      if (staged.sizeBytes !== sizeBytes) {
        // 防御纵深：适配器回报字节数与实测不一致，绝不放行。
        return failAfterRegister(
          'verify',
          'size_mismatch',
          `${operation}: staging 字节数与实测不一致`,
          undefined,
          [
            `measuredBytes=${sizeBytes}`,
            `stagedBytes=${staged.sizeBytes}`,
            `staging=${stagingRelativePath}（残留保留）`,
          ],
          { stagingRelativePath },
        );
      }

      // 阶段 3：核验实测摘要与登记预期一致（不匹配不发布）。
      const actualHash = hash.digest('hex');
      if (actualHash !== record.expectedHash) {
        return failAfterRegister(
          'verify',
          'hash_mismatch',
          `${operation}: 实测摘要与登记预期摘要不一致，拒绝发布`,
          undefined,
          [
            `expectedHash=${record.expectedHash}`,
            `actualHash=${actualHash}`,
            `staging=${stagingRelativePath}（残留保留）`,
          ],
          { stagingRelativePath, expectedHash: record.expectedHash, actualHash },
        );
      }

      // 阶段 4：同文件系统不覆盖发布（数据库事务外）。
      let published;
      try {
        published = await files.publishStaging(staged, key);
      } catch (cause) {
        return failAfterRegister(
          'publish',
          codeOfPortError(cause),
          `${operation}: 正式发布失败（${portErrorEvidence(cause)}）`,
          cause,
          [portErrorEvidence(cause), `staging=${stagingRelativePath}（残留保留）`],
          { stagingRelativePath },
        );
      }
      if (published.sizeBytes !== sizeBytes) {
        // 正式文件已存在但不可信：保持 pending 供 F-012 核对，不标 failed。
        throw toPublishError(
          'publish',
          'size_mismatch',
          `${operation}: 发布字节数与实测不一致，保持 pending 供核对`,
          record,
          projectId,
          undefined,
          {
            finalRelativePath: published.relativePath,
            failureRecord: 'kept_pending',
          },
        );
      }

      // 阶段 5：短事务 CAS 标 ready。失败时正式文件与 pending 索引都保留
      // 供恢复（F-012 的中断核对按“pending + 正式文件存在”路径处理）。
      try {
        const ready = await artifacts.transitionArtifact(record.projectId, record.id, {
          expectedRevision: record.revision,
          outcome: { status: 'ready', actualHash, sizeBytes },
        });
        return { artifact: ready, finalRelativePath: published.relativePath };
      } catch (cause) {
        throw toPublishError(
          'commit',
          codeOfPortError(cause),
          `${operation}: ready 提交失败（${portErrorEvidence(cause)}），正式文件与 pending 索引保留供恢复`,
          record,
          projectId,
          cause,
          { finalRelativePath: published.relativePath, failureRecord: 'kept_pending' },
        );
      }
    },
  };
}
