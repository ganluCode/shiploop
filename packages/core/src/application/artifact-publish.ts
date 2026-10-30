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
 *   为打开 staging 至发布/核验完成的总时间预算；wall-clock 定时器在等待前
 *   生效，注入时钟保留可测预算检查。每次失败撤销内部 AbortSignal 的发布资格；
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

export type ArtifactPublishCleanupStatus = 'confirmed' | 'cleanup_unconfirmed';

export interface ArtifactPublishErrorOptions {
  readonly projectId: string;
  readonly artifactId: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  readonly cleanupStatus?: ArtifactPublishCleanupStatus;
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
  readonly cleanupStatus: ArtifactPublishCleanupStatus;

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
    this.cleanupStatus = options.cleanupStatus ?? 'confirmed';
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
  /** 打开 staging 至发布/核验完成的总预算毫秒（1..2^31-1）。 */
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

class PublishWaitControlError extends Error {
  readonly reason: 'timeout' | 'cancelled';

  constructor(reason: 'timeout' | 'cancelled') {
    super(reason);
    this.name = 'PublishWaitControlError';
    this.reason = reason;
  }
}

/** Arm cancellation and the timer before invoking an operation, including synchronous work. */
function waitWithDeadline<T>(
  operation: () => PromiseLike<T> | T,
  options: { readonly signal?: AbortSignal; readonly deadlineMs: number },
): Promise<T> {
  const { signal, deadlineMs } = options;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    };
    const onAbort = (): void => fail(signal?.reason instanceof PublishWaitControlError
      ? signal.reason : new PublishWaitControlError('cancelled'));
    if (signal?.aborted) { onAbort(); return; }
    if (Date.now() >= deadlineMs) { fail(new PublishWaitControlError('timeout')); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => fail(new PublishWaitControlError('timeout')), deadlineMs - Date.now());
    let pending: Promise<T>;
    try { pending = Promise.resolve(operation()); } catch (error) { fail(error); return; }
    pending.then(value => {
      if (settled) return;
      // A synchronous syscall may have blocked the timer; never accept its late result.
      if (signal?.aborted) { onAbort(); return; }
      if (Date.now() >= deadlineMs) { fail(new PublishWaitControlError('timeout')); return; }
      settled = true;
      clear();
      resolve(value);
    }, fail);
  });
}

function validateLimits(limits: unknown, operation: string): ArtifactPublishLimits {
  const context: ValidationContext = { operation };
  const object = requirePlainObject(limits, context, 'limits');
  rejectUnknownKeys(object, ['maxSizeBytes', 'timeoutMs'], context, 'limits');
  const maxSizeBytes = validatePositiveInteger(object.maxSizeBytes, context, 'limits.maxSizeBytes');
  const timeoutMs = validatePositiveInteger(object.timeoutMs, context, 'limits.timeoutMs');
  if (!Number.isSafeInteger(maxSizeBytes)) {
    throw validationError(context, 'limits.maxSizeBytes', '必须是有限安全整数');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
    throw validationError(context, 'limits.timeoutMs', '必须是 1..2147483647 的有限安全整数（定时器范围）');
  }
  return { maxSizeBytes, timeoutMs };
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
      await waitWithDeadline(() => artifacts.transitionArtifact(record.projectId, record.id, {
        expectedRevision: record.revision,
        outcome: { status: 'failed', reason },
      }), { deadlineMs: Date.now() + Math.min(1000, limits.timeoutMs) });
      return 'failed_recorded';
    } catch {
      // 标 failed 本身失败（如 busy）不覆盖原始失败；残留状态仍可核对。
      return 'failed_unrecorded';
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
    cleanupStatus: ArtifactPublishCleanupStatus = 'confirmed',
  ): ArtifactPublishError {
    return new ArtifactPublishError(stage, code, message, {
      projectId,
      artifactId: record?.id ?? null,
      details: { ...extraDetails, cleanupStatus, ...(record !== null ? { artifactId: record.id } : {}) },
      cause,
      cleanupStatus,
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

      const key = { projectId: record.projectId, artifactId: record.id, locator: record.locator };
      const startedAtMs = nowMs();
      const deadlineMs = Date.now() + limits.timeoutMs;
      const controller = new AbortController();
      const signal = controller.signal;
      const cancel = (): void => controller.abort(new PublishWaitControlError('cancelled'));
      valid.signal?.addEventListener('abort', cancel, { once: true });
      if (valid.signal?.aborted) cancel();
      const timer = setTimeout(() => controller.abort(new PublishWaitControlError('timeout')), limits.timeoutMs);
      const control = { signal, deadlineMs };
      const inFlight = new Map<Promise<unknown>, string>();
      let stage: ArtifactPublishStage = 'staging';
      let write: ArtifactStagingWrite | undefined;
      let iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array> | undefined;
      let producerDone = false;
      let sizeBytes = 0;
      let published: Awaited<ReturnType<ArtifactFileStore['publishStaging']>> | undefined;
      const hash = createHash('sha256');
      // Capture stream errors between waits, without leaking body/path text into diagnostics.
      let streamError: unknown;
      const onStreamError = (error: unknown): void => { streamError = error; };

      function assertActive(checkInjectedClock = true): void {
        if (!signal.aborted && ((checkInjectedClock && nowMs() - startedAtMs >= limits.timeoutMs) || Date.now() >= deadlineMs)) {
          controller.abort(new PublishWaitControlError('timeout'));
        }
        if (signal.aborted) throw signal.reason;
      }
      function track<T>(operation: () => PromiseLike<T> | T, label: string): Promise<T> {
        const pending = Promise.resolve().then(operation);
        inFlight.set(pending, label);
        void pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
        return pending;
      }
      async function wait<T>(operation: () => PromiseLike<T> | T, label: string): Promise<T> {
        assertActive();
        const result = await waitWithDeadline(() => track(() => {
          assertActive(false);
          return operation();
        }, label), control);
        assertActive();
        return result;
      }
      function writeChunk(chunk: Uint8Array, target: ArtifactStagingWrite): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          let callbackDone = false;
          let drained = false;
          let written = false;
          let settled = false;
          const clear = (): void => {
            target.stream.removeListener('drain', onDrain);
            target.stream.removeListener('error', onError);
            target.stream.removeListener('close', onClose);
            signal.removeEventListener('abort', onAbort);
          };
          const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            clear();
            reject(error);
          };
          const complete = (): void => {
            if (settled || !written || !callbackDone || !drained) return;
            settled = true;
            clear();
            resolve();
          };
          const onDrain = (): void => { drained = true; complete(); };
          const onError = (error: unknown): void => fail(error);
          const onClose = (): void => fail(new ArtifactFileError('io', operation, 'staging 在写入确认前关闭'));
          const onAbort = (): void => fail(signal.reason);
          target.stream.on('drain', onDrain);
          target.stream.on('error', onError);
          target.stream.on('close', onClose);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) { onAbort(); return; }
          try {
            const accepted = target.stream.write(chunk, (error?: Error | null) => {
              if (error) { fail(error); return; }
              callbackDone = true;
              complete();
            });
            drained ||= accepted;
            written = true;
            complete();
          } catch (error) { fail(error); }
        });
      }

      async function cleanup(): Promise<{ status: ArtifactPublishCleanupStatus; pendingOperations: string[] }> {
        // Revoke the old operation before releasing any barrier or beginning cleanup.
        if (!signal.aborted) controller.abort(new Error('artifact_publication_revoked'));
        const cleanupDeadline = Date.now() + Math.max(10, Math.min(250, limits.timeoutMs));
        const checks: Promise<boolean>[] = [];
        if (!producerDone && iterator !== undefined) {
          if (typeof iterator.return === 'function') {
            checks.push(track(() => iterator!.return!(), 'producer.return').then(() => true, () => false));
          } else if ([...inFlight.values()].includes('producer.next')) {
            checks.push(Promise.resolve(false));
          }
        }
        if (write !== undefined) {
          const target = write;
          if (files.abortStaging !== undefined) {
            checks.push(track(() => files.abortStaging!(target), 'staging.close').then(result => result.confirmed, () => false));
          } else {
            // Legacy/uninterruptible adapters cannot prove their file descriptor has stopped.
            try { target.stream.destroy(); } catch { /* Residue remains. */ }
            checks.push(Promise.resolve(false));
          }
        }
        const pending = [...inFlight.keys()];
        let confirmed = false;
        try {
          const results = await waitWithDeadline(() => Promise.all([
            ...checks,
            ...pending.map(promise => promise.then(() => true, () => true)),
          ]), { deadlineMs: cleanupDeadline });
          confirmed = results.every(Boolean);
        } catch { /* A held next/finish/publish is explicitly unconfirmed. */ }
        return { status: confirmed ? 'confirmed' : 'cleanup_unconfirmed',
          pendingOperations: [...new Set(inFlight.values())] };
      }

      try {
        // Pending is already durable. All file/producer waits start outside SQLite transactions.
        write = await wait(() => {
          const opened = files.openStagingWrite(key, control);
          // Even a legacy adapter that opens after timeout must have its late handle stopped.
          void opened.then(late => {
            write ??= late;
            if (signal.aborted) {
              if (files.abortStaging) void files.abortStaging(late).catch(() => {});
              else late.stream.destroy();
            }
          }).catch(() => {});
          return opened;
        }, 'staging.open');
        write.stream.on('error', onStreamError);
        iterator = Symbol.asyncIterator in Object(valid.content)
          ? (valid.content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
          : (valid.content as Iterable<Uint8Array>)[Symbol.iterator]();
        for (;;) {
          let next: IteratorResult<Uint8Array>;
          try { next = await wait(() => iterator!.next(), 'producer.next'); }
          catch (cause) {
            if (cause instanceof PublishWaitControlError) throw cause;
            throw toPublishError('staging', 'stream', 'ArtifactPublisher: 内容流生产方失败', record, projectId, cause);
          }
          if (next.done) { producerDone = true; break; }
          const chunk: unknown = next.value;
          if (!(chunk instanceof Uint8Array)) {
            throw toPublishError('staging', 'validation', 'ArtifactPublisher: 内容块必须是 Uint8Array', record, projectId, undefined);
          }
          if (sizeBytes + chunk.byteLength > limits.maxSizeBytes) {
            throw toPublishError('staging', 'size_limit_exceeded', 'ArtifactPublisher: 正文超过大小限制', record, projectId, undefined);
          }
          hash.update(chunk);
          await wait(() => writeChunk(chunk, write!), 'staging.write');
          sizeBytes += chunk.byteLength;
          if (streamError !== undefined) throw streamError;
        }
        const staged = await wait(() => {
          write!.stream.end();
          return files.finishStaging(write!, control);
        }, 'staging.finish');
        stage = 'verify';
        assertActive();
        if (staged.sizeBytes !== sizeBytes) {
          throw toPublishError(stage, 'size_mismatch', 'ArtifactPublisher: staging 字节数与实测不一致', record, projectId, undefined);
        }
        const actualHash = hash.digest('hex');
        if (actualHash !== record.expectedHash) {
          throw toPublishError(stage, 'hash_mismatch', 'ArtifactPublisher: 实测摘要不符，拒绝发布', record, projectId, undefined,
            { expectedHash: record.expectedHash, actualHash });
        }
        stage = 'publish';
        published = await wait(() => files.publishStaging(staged, key, control), 'staging.publish');
        if (published.sizeBytes !== sizeBytes) {
          throw toPublishError(stage, 'size_mismatch', 'ArtifactPublisher: 发布字节数不符，保持 pending 供核对', record, projectId, undefined,
            { finalRelativePath: published.relativePath, failureRecord: 'kept_pending' });
        }
        assertActive();
        stage = 'commit';
        // SQLite performs this CAS synchronously in a short transaction. Do not race an
        // uninterruptible ready mutation: a timeout must never leave a background commit.
        const ready = await artifacts.transitionArtifact(record.projectId, record.id, {
          expectedRevision: record.revision,
          outcome: { status: 'ready', actualHash, sizeBytes },
        });
        return { artifact: ready, finalRelativePath: published.relativePath };
      } catch (cause) {
        if (stage === 'commit' || (isArtifactPublishError(cause) && cause.details?.['failureRecord'] === 'kept_pending')) {
          throw isArtifactPublishError(cause) ? cause : toPublishError(stage, codeOfPortError(cause),
            'ArtifactPublisher: ready 提交失败，正式文件与 pending 索引保留供恢复', record, projectId, cause,
            { finalRelativePath: published?.relativePath, failureRecord: 'kept_pending' });
        }
        // A real stream/file error remains the primary failure even if closing also fails.
        const code = cause instanceof PublishWaitControlError ? cause.reason
          : isArtifactPublishError(cause) ? cause.code : 'file';
        const cleanupResult = await cleanup();
        const details = { ...(isArtifactPublishError(cause) ? cause.details : {}),
          stagingRelativePath: write?.relativePath,
          finalRelativePath: files.resolvePlacement(key).finalRelativePath,
          writtenBytes: sizeBytes, timeoutMs: limits.timeoutMs, maxSizeBytes: limits.maxSizeBytes,
          cleanupStatus: cleanupResult.status, pendingOperations: cleanupResult.pendingOperations };
        const evidence = [
          'timeoutMs=' + limits.timeoutMs, 'maxSizeBytes=' + limits.maxSizeBytes,
          'writtenBytes=' + sizeBytes, 'cleanupStatus=' + cleanupResult.status,
          ...(write ? ['staging=' + write.relativePath + '（残留保留）'] : []),
          ...(isArtifactPublishError(cause) && cause.code === 'hash_mismatch'
            ? ['expectedHash=' + cause.details?.['expectedHash'], 'actualHash=' + cause.details?.['actualHash']] : []),
          portErrorEvidence(isArtifactPublishError(cause) ? cause.cause : cause),
        ];
        const recording = await markFailed(record, failureReason(stage, code, evidence));
        throw toPublishError(stage, code, isArtifactPublishError(cause) ? cause.message : 'ArtifactPublisher: 发布失败（' + code + '）',
          record, projectId, isArtifactPublishError(cause) ? cause.cause : cause,
          { ...details, failureRecord: recording }, cleanupResult.status);
      } finally {
        clearTimeout(timer);
        valid.signal?.removeEventListener('abort', cancel);
        write?.stream.removeListener('error', onStreamError);
      }
    },
  };
}
