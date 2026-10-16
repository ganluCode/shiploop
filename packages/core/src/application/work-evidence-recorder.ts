/**
 * P03-6 / F-007 最小有界公开事件与结果证据采集器（application 层编排）。
 *
 * 设计依据：core-design/05 §5/§6（优先落盘后推进水位；Recorder 过慢或磁盘
 * 失败不能无限缓存；required 模式记录失败请求停止并阻止后继，保留缺失标记；
 * complete 只对已声明范围成立）、core-design/14 §6（稳定身份去重；水位只
 * 指向已持久内容；没有稳定身份标 partial；用量声明口径、历史基线分开、
 * 不重复加总）与 input/p03-fake-runtime.md FR-2。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（ArtifactPublisher 用例、WorkSessionStore）与
 *   application/output-redaction 的流式脱敏原语；不导入 adapters、SDK、
 *   文件或 SQLite 模块，不决定 Task 验收（无 passed 语义）；
 * - 事件与结果同时接收：result/stopped 类 Promise 立即挂载观察，事件流主
 *   循环消费——不先 await result 再读事件（有界通道可能填满死锁）；慢查询
 *   /UI 与采集无共享通道，采集只被发布/短事务界限；
 * - 采集方不是适配器信任方：逐条 classifyRuntimeEvent，事件归属凭
 *   eventIdentityPrefix（由可信装配按请求身份独立重算）核验，旧
 *   Attempt/Session 或外来事件仅留有界诊断，不进入当前记录水位；
 * - 稳定身份去重：eventId 首次见才计入有效事件与用量；同 eventId 全等重投
 *   丢弃计数，同 eventId 不同内容记 event_identity_conflict 缺口；
 * - 乱序只在声明有限窗口内处理：窗口内事件暂存按序落盘，超窗先到事件触发
 *   missing_sequences 缺口，窗口前到达的迟到事件不持久化
 *   （late_event_beyond_window）；缺序列、提前断流、未知公开事件与
 *   finalEventSequence 不匹配全部以缺口/核对字段表达，可核对；
 * - 有界分块持久化正文，再推进可读取水位：每块先经 Artifact 发布端口落盘
 *   并核验 hash，ready 后才以 activity 推进 Session recording_watermark；
 *   未持久内容绝不计入水位；缺口随水位同步（≤32 条、有界文本）；
 * - 脱敏先于持久化：每行事件正文经注入秘密值字面量脱敏后才写入分块；秘密
 *   值只作为字面量使用，不解析任何凭据引用正文；
 * - 尾部等待有界：一侧（事件流/结果）完结后等待另一侧最长 tailWaitMs，超
 *   时记 result_tail_timeout / events_tail_timeout 缺口并收尾，绝不无限
 *   等待事件流闭合；外部可经 AbortSignal 有界中止（记 recording_aborted
 *   缺口，已存证据保留）；
 * - required 记录失败（分块/清单发布失败、水位推进冲突、总量超限、受控停
 *   止）：尽力取消执行句柄（请求停止）、尽力在 Session 标 recording_failed
 *   缺口、尽力发布 coverage='failed' 的诚实清单（不生成虚假 ready/complete
 *   制品），随后抛 WorkEvidenceRecordingError（safeStopRequired=true）阻止
 *   后继执行；已发布的分块与已保存证据原样保留，不删除任何残留；
 * - 用量：事件观察按稳定 eventId 去重后计入，逐字段任一未知即 null 且
 *   complete=false；basis 如实汇总（synthetic/reported/mixed/none）；最终
 *   结果用量单列 finalReported，historicalBaseline 恒 null（v1 无恢复续
 *   接），notAdditive 恒 true——不建立真实缓存/费用汇总；
 * - import 本模块无副作用；createWorkEvidenceRecorder 只校验依赖与限制。
 *
 * 本模块不实现：Session 生命周期 ended/stopped 推进与 fenced 结算
 * （F-009/F-010）、清单读取 UI（F-011）、组合根接线（F-012）、完整供应商
 * SessionRecorder 与原生档案读取。
 */
import { createHash } from 'node:crypto';
import type {
  RuntimeEvent,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeHandle,
  RuntimeUsageReport,
} from '../ports/runtime-execution.js';
import {
  classifyRuntimeEvent,
  isRuntimeError,
  validateRuntimeExecutionRequest,
  validateRuntimeExecutionResult,
} from '../ports/runtime-execution.js';
import type { ArtifactPublisher } from './artifact-publish.js';
import type { ArtifactVerifier } from './artifact-verify.js';
import { createOutputRedactor, redactOutputText } from './output-redaction.js';
import {
  validateWorkEvidenceRecorderLimits,
  WORK_EVIDENCE_DIAGNOSTICS_MAX_COUNT,
  WORK_EVIDENCE_DIAGNOSTIC_MAX_LENGTH,
  WORK_EVIDENCE_EVENTS_KIND,
  WORK_EVIDENCE_EVENTS_MEDIA_TYPE,
  WORK_EVIDENCE_MANIFEST_KIND,
  WORK_EVIDENCE_MANIFEST_MEDIA_TYPE,
  WORK_EVIDENCE_SCHEMA_VERSION,
  WORK_EVIDENCE_SCOPE_COVERS,
  WORK_EVIDENCE_SCOPE_EXCLUDES,
} from '../ports/work-evidence-recorder.js';
import type {
  WorkEvidenceChunkRef,
  WorkEvidenceManifest,
  WorkEvidenceRecorderLimits,
  WorkEvidenceResultStatus,
  WorkEvidenceSequenceReconciliation,
  WorkEvidenceStats,
  WorkEvidenceUsageBasis,
} from '../ports/work-evidence-recorder.js';
import { RECORDING_GAPS_MAX_COUNT, RECORDING_GAP_MAX_LENGTH } from '../ports/work-session.js';
import type { WorkSessionStore } from '../ports/work-session.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

/* ------------------------------------------------------------------ *
 * 错误与结果类型
 * ------------------------------------------------------------------ */

export type WorkEvidenceRecordingFailureReason =
  /** 采集输入/装配形状非法（调用方错误）。 */
  | 'validation'
  /** Session 缺失/归属不符/状态冲突，记录无法关联。 */
  | 'session_mismatch'
  /** 事件分块经 Artifact 发布端口落盘失败（含注入 ENOSPC/短写/hash 漂移）。 */
  | 'event_publish_failed'
  /** 覆盖清单发布失败。 */
  | 'manifest_publish_failed'
  /** Session 水位/缺口推进失败（CAS 冲突等）。 */
  | 'watermark_progress_failed'
  /** 接收事件总数超过 maxTotalEvents（受控停止）。 */
  | 'total_event_limit_exceeded'
  /** 持久化总字节超过 maxTotalBytes（受控停止）。 */
  | 'total_bytes_limit_exceeded'
  /** 外部 AbortSignal 中止（仍必须由外层核验安全停止）。 */
  | 'aborted';

export interface WorkEvidenceRecordingErrorOptions {
  readonly watermark: number | null;
  readonly gaps: readonly string[];
  readonly safeStopRequired: boolean;
  /** 尽力发布的诚实清单（coverage='failed'）制品 ID；未发布为 null。 */
  readonly manifestArtifactId?: string | null;
  readonly cause?: unknown;
}

/**
 * 记录失败：携带受限原因、当前水位与缺口快照；safeStopRequired=true 表示
 * required 模式下必须安全停止并阻止后继执行（F-010 停止路径消费）。
 */
export class WorkEvidenceRecordingError extends Error {
  readonly reason: WorkEvidenceRecordingFailureReason;
  readonly safeStopRequired: boolean;
  readonly watermark: number | null;
  readonly gaps: readonly string[];
  readonly manifestArtifactId: string | null;

  constructor(
    reason: WorkEvidenceRecordingFailureReason,
    message: string,
    options: WorkEvidenceRecordingErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorkEvidenceRecordingError';
    this.reason = reason;
    this.safeStopRequired = options.safeStopRequired;
    this.watermark = options.watermark;
    this.gaps = [...options.gaps];
    this.manifestArtifactId = options.manifestArtifactId ?? null;
  }
}

export function isWorkEvidenceRecordingError(
  value: unknown,
  reason?: WorkEvidenceRecordingFailureReason,
): value is WorkEvidenceRecordingError {
  return value instanceof WorkEvidenceRecordingError &&
    (reason === undefined || value.reason === reason);
}

export interface WorkEvidenceRecordingOutcome {
  /** complete：已声明范围无缺口且结果 settled；否则 partial（缺口见清单）。 */
  readonly status: 'complete' | 'partial';
  /** 覆盖清单 ready 制品 ID。 */
  readonly manifestArtifactId: string;
  /** 最终已持久水位（最后持久序列；无任何持久事件为 null）。 */
  readonly watermark: number | null;
  readonly gaps: readonly string[];
  readonly stats: WorkEvidenceStats;
  readonly result: RuntimeExecutionResult | null;
  readonly resultStatus: WorkEvidenceResultStatus;
  readonly sequenceReconciliation: WorkEvidenceSequenceReconciliation;
}

export interface WorkEvidenceRecorder {
  record(input: unknown): Promise<WorkEvidenceRecordingOutcome>;
}

export interface WorkEvidenceRecorderDeps {
  readonly publisher: ArtifactPublisher;
  readonly verifier: Pick<ArtifactVerifier, 'verifyArtifact'>;
  readonly sessions: WorkSessionStore;
  readonly limits: unknown;
  /** 注入的秘密值字面量（脱敏用）；只作字面量，不解析凭据引用正文。 */
  readonly secrets?: readonly string[];
  /** 单调时钟（默认 performance.now），仅用于尾部等待期限。 */
  readonly nowMs?: () => number;
}

/* ------------------------------------------------------------------ *
 * 内部实现
 * ------------------------------------------------------------------ */

const OPERATION = 'WorkEvidenceRecorder.record';

class RecordingFailure extends Error {
  readonly failureReason: WorkEvidenceRecordingFailureReason;
  readonly causeValue: unknown;
  constructor(reason: WorkEvidenceRecordingFailureReason, message: string, cause?: unknown) {
    super(message);
    this.name = 'RecordingFailure';
    this.failureReason = reason;
    this.causeValue = cause;
  }
}

/** 有界缺口收集：≤32 条、每条 ≤256 码点；溢出以 gaps_overflow 收尾。 */
function createGapSink(): { readonly list: readonly string[]; add(gap: string): void } {
  const gaps: string[] = [];
  return {
    get list() {
      return gaps;
    },
    add(gap: string): void {
      const clipped = gap.slice(0, RECORDING_GAP_MAX_LENGTH);
      if (gaps.length < RECORDING_GAPS_MAX_COUNT - 1) {
        gaps.push(clipped);
        return;
      }
      if (gaps.length === RECORDING_GAPS_MAX_COUNT - 1) {
        gaps.push('gaps_overflow');
      }
    },
  };
}

/** 有界诊断收集：≤32 条、每条 ≤200 码点，不透传未知 payload。 */
function createDiagnosticSink(): { readonly list: readonly string[]; add(entry: string): void } {
  const entries: string[] = [];
  return {
    get list() {
      return entries;
    },
    add(entry: string): void {
      if (entries.length < WORK_EVIDENCE_DIAGNOSTICS_MAX_COUNT - 1) {
        entries.push(entry.slice(0, WORK_EVIDENCE_DIAGNOSTIC_MAX_LENGTH));
      } else if (entries.length === WORK_EVIDENCE_DIAGNOSTICS_MAX_COUNT - 1) {
        entries.push('diagnostics_overflow');
      }
    },
  };
}

interface SeenEvent {
  readonly sequence: number;
  readonly lineDigest: string;
}

export function createWorkEvidenceRecorder(deps: WorkEvidenceRecorderDeps): WorkEvidenceRecorder {
  const context: ValidationContext = { operation: 'WorkEvidenceRecorder.create' };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 publisher/sessions/limits 装配依赖');
  }
  if (deps.publisher === null || typeof deps.publisher !== 'object' ||
      typeof (deps.publisher as ArtifactPublisher).publishArtifact !== 'function') {
    throw validationError(context, 'deps.publisher', '必须提供 ArtifactPublisher 用例');
  }
  if (typeof deps.verifier?.verifyArtifact !== 'function') {
    throw validationError(context, 'deps.verifier', '必须提供 Artifact 完整性核验端口');
  }
  if (deps.sessions === null || typeof deps.sessions !== 'object' ||
      typeof (deps.sessions as WorkSessionStore).applyWorkSessionProgress !== 'function' ||
      typeof (deps.sessions as WorkSessionStore).getWorkSession !== 'function') {
    throw validationError(context, 'deps.sessions', '必须提供 WorkSessionStore 端口实现');
  }
  const limits: WorkEvidenceRecorderLimits = validateWorkEvidenceRecorderLimits(deps.limits);
  const secrets = deps.secrets === undefined ? [] : deps.secrets.map((value, index) => {
    if (typeof value !== 'string') {
      throw validationError(context, `deps.secrets[${index}]`, '秘密值必须是字符串字面量', typeof value);
    }
    return value;
  });
  createOutputRedactor(secrets);
  const nowMs = deps.nowMs ?? (() => performance.now());
  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') return redactOutputText(value, secrets);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]));
    }
    return value;
  };

  return {
    async record(value: unknown): Promise<WorkEvidenceRecordingOutcome> {
      const input = validateRecordingInput(value);
      const { request, handle, eventIdentityPrefix, signal } = input;
      void Promise.resolve(handle.result).catch(() => undefined);
      void Promise.resolve(handle.stopped).catch(() => undefined);
      const attemptId = request.identity.purpose === 'work' ? request.identity.attemptId : null;
      if (attemptId === null) {
        throw validationError({ operation: OPERATION }, 'input.request.identity', 'work_identity_required');
      }
      const identity = {
        projectId: request.projectId,
        attemptId,
        owner: request.owner.principalId,
        hostInstanceId: request.owner.hostInstanceId,
        executionVersion: request.executionVersion,
      };

      /* Session 关联核验：必须存在、属于同一 Attempt、runtime 一致；水位/
       * 缺口由本采集器独占推进（单写入者前提，revision CAS 兜底）。 */
      let sessionRevision: number;
      let runtimeId: string;
      let adapterVersion: string;
      try {
        const session = deps.sessions.getWorkSession(request.projectId, request.sessionId);
        if (session.attemptId !== attemptId || session.runtime !== request.strategy.runtime) {
          throw new Error('Session 与执行请求身份不一致');
        }
        if (session.status !== 'started' || session.recordingWatermark !== null) {
          throw new Error('Session 必须已启动且尚未记录；已有证据不可重新计量');
        }
        sessionRevision = session.revision;
        runtimeId = session.runtime;
        adapterVersion = session.adapterVersion;
      } catch (error) {
        void Promise.resolve().then(() => handle.cancel()).catch(() => undefined);
        throw new WorkEvidenceRecordingError(
          'session_mismatch',
          `${OPERATION}: Session 关联核验失败`,
          { watermark: null, gaps: [], safeStopRequired: true, cause: error },
        );
      }

      const gaps = createGapSink();
      const diagnostics = createDiagnosticSink();
      const stats = {
        eventsReceived: 0, eventsPersisted: 0, duplicatesDropped: 0, unknownEvents: 0,
        foreignEvents: 0, lateEvents: 0, eventsOmitted: 0, bytesPersisted: 0,
      };
      const seen = new Map<string, SeenEvent>();
      const held = new Map<number, RuntimeEvent>();
      let nextExpected = 1;
      /* 已接受（含缓冲）序列水位；只有分块发布 ready 后才成为可读取水位。 */

      /** 已持久水位：只指向已落盘内容，Session recording_watermark 的唯一来源。 */
      let persistedWatermark: number | null = null;
      let chunkIndex = 0;
      let chunkLines: Buffer[] = [];
      let chunkEvents: RuntimeEvent[] = [];
      let chunkBytes = 0;
      let chunkFirstSequence: number | null = null;
      let chunkLastSequence: number | null = null;
      let chunkEventCount = 0;
      const chunks: WorkEvidenceChunkRef[] = [];
      /* 用量观察：稳定身份去重后计入；任一字段未知则该字段总量 null。 */
      let usageCounted = 0;
      const usageBases = new Set<'synthetic' | 'reported'>();
      const usageTotals = { inputTokens: 0, outputTokens: 0, costUsdMicros: 0 };
      const usageUnknown = { inputTokens: false, outputTokens: false, costUsdMicros: false };

      const recordUsage = (usage: RuntimeUsageReport): void => {
        usageCounted += 1;
        usageBases.add(usage.basis);
        const accumulate = (field: 'inputTokens' | 'outputTokens' | 'costUsdMicros'): void => {
          const amount = usage[field];
          if (amount === null) usageUnknown[field] = true;
          else usageTotals[field] += amount;
        };
        accumulate('inputTokens');
        accumulate('outputTokens');
        accumulate('costUsdMicros');
      };

      /** 推进 Session 水位（activity）：只指向已持久内容，缺口同步。 */
      const advanceWatermark = async (): Promise<void> => {
        try {
          const mutation = deps.sessions.applyWorkSessionProgress({
            ...identity,
            sessionId: request.sessionId,
            expectedRevision: sessionRevision,
            kind: 'activity',
            recordingWatermark: persistedWatermark,
            recordingGaps: [...gaps.list],
          });
          sessionRevision = mutation.session.revision;
        } catch (error) {
          throw new RecordingFailure('watermark_progress_failed', 'Session 记录水位推进失败', error);
        }
      };

      /** 有界分块持久化：先落盘核验 ready，再推进水位。 */
      const flushChunk = async (): Promise<void> => {
        if (chunkEventCount === 0) return;
        const content = Buffer.concat(chunkLines);
        const locator = `sessions/${request.sessionId}/event-log/${String(chunkIndex).padStart(6, '0')}.ndjson`;
        let published;
        try {
          published = await deps.publisher.publishArtifact({
            projectId: request.projectId,
            kind: WORK_EVIDENCE_EVENTS_KIND,
            mediaType: WORK_EVIDENCE_EVENTS_MEDIA_TYPE,
            expectedHash: createHash('sha256').update(content).digest('hex'),
            locator,
            content: [content],
          });
        } catch (error) {
          throw new RecordingFailure('event_publish_failed', '事件分块发布失败', error);
        }
        try {
          const report = await deps.verifier.verifyArtifact(request.projectId, published.artifact.id);
          if (report.kind !== 'verified_ready') throw new Error('事件正文完整性核验失败');
        } catch (error) {
          throw new RecordingFailure('event_publish_failed', '事件正文完整性核验失败', error);
        }
        stats.eventsPersisted += chunkEventCount;
        stats.bytesPersisted += chunkBytes;
        for (const event of chunkEvents) {
          if (event.payload.kind === 'usage') recordUsage(event.payload.usage);
        }
        persistedWatermark = chunkLastSequence;
        chunks.push({
          artifactId: published.artifact.id,
          contentHash: published.artifact.contentHash as string,
          sizeBytes: published.artifact.sizeBytes as number,
          locator,
          firstSequence: chunkFirstSequence as number,
          lastSequence: chunkLastSequence as number,
          eventCount: chunkEventCount,
        });
        chunkIndex += 1;
        chunkLines = [];
        chunkEvents = [];
        chunkBytes = 0;
        chunkFirstSequence = null;
        chunkLastSequence = null;
        chunkEventCount = 0;
        /* 分块 ready 后已接受水位才成为已持久水位，再推进可读取水位。 */

        await advanceWatermark();
      };

      /** 单事件持久化（序列化 → 脱敏 → 界限 → 入块）；用量只计实际持久事件。 */
      const persistEvent = async (event: RuntimeEvent): Promise<void> => {
        const rawLine = JSON.stringify({
          v: WORK_EVIDENCE_SCHEMA_VERSION,
          sequence: event.sequence,
          eventId: event.eventId,
          kind: event.kind,
          occurredAtUtc: event.occurredAtUtc,
          payload: redactValue(event.payload),
        });
        /* 脱敏先于持久化：整行（含预览/诊断文本）经秘密字面量脱敏。 */
        const line = Buffer.from(`${rawLine}\n`, 'utf8');
        if (line.byteLength > Math.min(limits.maxEventBodyBytes, limits.chunkMaxBytes)) {
          stats.eventsOmitted += 1;
          gaps.add(`event_body_too_large:${event.sequence}`);
          return;
        }
        if (stats.bytesPersisted + chunkBytes + line.byteLength > limits.maxTotalBytes) {
          throw new RecordingFailure('total_bytes_limit_exceeded', '持久化总字节超限（受控停止）');
        }
        if (chunkBytes + line.byteLength > limits.chunkMaxBytes) await flushChunk();
        chunkLines.push(line);
        chunkEvents.push(event);
        chunkBytes += line.byteLength;
        if (chunkFirstSequence === null) chunkFirstSequence = event.sequence;
        chunkLastSequence = event.sequence;
        chunkEventCount += 1;
      };

      /** 窗口内暂存按序落盘（nextExpected 连续命中时）。 */
      const drainHeld = async (): Promise<void> => {
        for (;;) {
          const event = held.get(nextExpected);
          if (event === undefined) return;
          held.delete(nextExpected);
          await persistEvent(event);
          nextExpected += 1;
          if (chunkEventCount >= limits.chunkMaxEvents || chunkBytes >= limits.chunkMaxBytes) {
            await flushChunk();
          }
        }
      };

      /** 声明 [from, to] 中未持有的序列为缺口，并落盘其中已暂存的事件。 */
      const declareMissingUpTo = async (toInclusive: number): Promise<void> => {
        /* 只访问有界窗口，不按缺口长度循环。 */
        for (const seq of [...held.keys()].filter((seq) => seq <= toInclusive).sort((a, b) => a - b)) {
          if (seq > nextExpected) gaps.add(seq - 1 === nextExpected
            ? `missing_sequences:${nextExpected}` : `missing_sequences:${nextExpected}-${seq - 1}`);
          const event = held.get(seq)!;
          held.delete(seq);
          await persistEvent(event);
          nextExpected = seq + 1;
          if (chunkEventCount >= limits.chunkMaxEvents || chunkBytes >= limits.chunkMaxBytes) await flushChunk();
        }
        if (nextExpected <= toInclusive) gaps.add(nextExpected === toInclusive
          ? `missing_sequences:${nextExpected}` : `missing_sequences:${nextExpected}-${toInclusive}`);
        nextExpected = toInclusive + 1;
      };

      /** 合法且归属本次执行的事件入口：去重 → 排序窗口 → 持久化。 */
      const acceptEvent = async (event: RuntimeEvent): Promise<void> => {
        const lineDigest = createHash('sha256').update(JSON.stringify([
          event.sequence, event.eventId, event.kind, event.occurredAtUtc, event.payload,
        ])).digest('hex');
        const prior = seen.get(event.eventId);
        if (prior !== undefined) {
          if (prior.sequence === event.sequence && prior.lineDigest === lineDigest) {
            /* 稳定身份全等重投：不重复产生有效事件/用量。 */
            stats.duplicatesDropped += 1;
            return;
          }
          stats.duplicatesDropped += 1;
          gaps.add(`event_identity_conflict:${event.sequence}`);
          return;
        }
        seen.set(event.eventId, { sequence: event.sequence, lineDigest });
        if (event.sequence < nextExpected) {
          /* 窗口前迟到：位置已在水位之后，不持久化。 */
          stats.lateEvents += 1;
          gaps.add(`late_event_beyond_window:${event.sequence}`);
          diagnostics.add(`late_event:${event.sequence}`);
          return;
        }
        if (event.sequence === nextExpected) {
          await persistEvent(event);
          nextExpected += 1;
          if (chunkEventCount >= limits.chunkMaxEvents || chunkBytes >= limits.chunkMaxBytes) {
            await flushChunk();
          }
          await drainHeld();
          return;
        }
        if (held.has(event.sequence)) {
          stats.duplicatesDropped += 1;
          gaps.add(`sequence_identity_conflict:${event.sequence}`);
          return;
        }
        if (event.sequence - nextExpected <= limits.reorderWindow) {
          held.set(event.sequence, event);
          return;
        }
        /* 超出声明乱序窗口：声明缺口并落盘（缺口计入水位）。 */
        await declareMissingUpTo(event.sequence - 1);
        await persistEvent(event);
        nextExpected = event.sequence + 1;
        if (chunkEventCount >= limits.chunkMaxEvents || chunkBytes >= limits.chunkMaxBytes) {
          await flushChunk();
        }
        await drainHeld();
      };

      /* ---------------- 并发挂载结果观察（不阻塞事件消费） ---------------- */
      let resultSettled = false;
      let resultValue: RuntimeExecutionResult | null = null;
      let resultFailure: string | null = null;
      /* 结果/失败在 Promise 回调内赋值：读取一律经函数，避免控制流收窄。 */
      const settledResult = (): RuntimeExecutionResult | null => resultValue;
      const settledResultFailure = (): string | null => resultFailure;
      let notifyResultSettled!: () => void;
      const resultSettledSignal = new Promise<void>((resolve) => { notifyResultSettled = resolve; });
      const resultWatch = Promise.resolve(handle.result).then(
        (raw) => {
          try {
            resultValue = validateRuntimeExecutionResult(raw);
          } catch (error) {
            resultFailure = isRuntimeError(error) ? error.reason : 'invalid_result';
          }
          resultSettled = true;
          notifyResultSettled();
        },
        (error: unknown) => {
          resultFailure = isRuntimeError(error) ? error.reason : 'adapter_result_failed';
          resultSettled = true;
          notifyResultSettled();
        },
      );
      resultWatch.catch(() => undefined);

      const abortError = (): RecordingFailure =>
        new RecordingFailure('aborted', '记录被外部信号中止');
      /* 单一中止 Promise：避免每次等待重复注册监听器；未观察时不得触发
       * unhandled rejection。 */
      let abortPromise: Promise<never> | null = null;
      let abortListener: (() => void) | null = null;
      if (signal !== undefined) {
        abortPromise = new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          abortListener = () => reject(abortError());
          signal.addEventListener('abort', abortListener, { once: true });
        });
        abortPromise.catch(() => undefined);
      }
      const abortable = <T>(promise: Promise<T>): Promise<T> =>
        abortPromise === null ? promise : Promise.race([promise, abortPromise]);
      /* 中止状态经函数读取：避免属性收窄使后续检查被折叠。 */
      const isAborted = (): boolean => signal?.aborted === true;
      /** 有界尾部等待：自尾部起点超过 tailWaitMs 即结算为 timeout 标记。 */
      const TAIL_TIMEOUT = Symbol('tail_timeout');
      const RESULT_SETTLED = Symbol('result_settled');
      let activeTailTimer: ReturnType<typeof setTimeout> | undefined;
      const withTailDeadline = <T>(promise: Promise<T>, timeout: symbol): Promise<T | symbol> => {
        return new Promise<T | symbol>((resolvePromise, rejectPromise) => {
          const remaining = limits.tailWaitMs - (nowMs() - tailStartedAtMs);
          const timer = setTimeout(() => resolvePromise(timeout), Math.max(1, remaining));
          activeTailTimer = timer;
          promise.then(
            (value) => { clearTimeout(timer); resolvePromise(value); },
            (error: unknown) => { clearTimeout(timer); rejectPromise(error instanceof Error ? error : new Error(String(error))); },
          );
        });
      };

      /* ---------------- 主流程：事件循环 + 有界尾部 + 收尾 ---------------- */
      let resultStatus: WorkEvidenceResultStatus = 'settled';
      let tailStartedAtMs = 0;
      const iterator = handle.events[Symbol.asyncIterator]();
      let pendingNext: Promise<IteratorResult<unknown>> | null = null;
      const nextEvent = (): Promise<IteratorResult<unknown>> => {
        if (pendingNext === null) pendingNext = iterator.next();
        return pendingNext;
      };
      const consumeNext = (): void => {
        pendingNext = null;
      };
      const abandonIterator = (): void => {
        if (pendingNext !== null) {
          pendingNext.catch(() => undefined);
          pendingNext = null;
        }
        try {
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
        } catch {
          /* 适配器迭代器无 return 或抛错：忽略，不覆盖既有流程。 */
        }
      };
      try {
        if (isAborted()) throw abortError();
        let eventsDone = false;
        while (!eventsDone) {
          if (isAborted()) throw abortError();
          let next: IteratorResult<unknown>;
          if (!resultSettled) {
            /* 结果未结算：事件等待可被结果结算唤醒（随后进入有界尾部）。 */
            const raced = await abortable(Promise.race([
              nextEvent(),
              resultSettledSignal.then(() => RESULT_SETTLED),
            ]));
            if (raced === RESULT_SETTLED) {
              tailStartedAtMs = nowMs();
              continue;
            }
            next = raced as IteratorResult<unknown>;
            consumeNext();
          } else {
            if (tailStartedAtMs === 0) tailStartedAtMs = nowMs();
            /* 结果已结算：事件结束等待有界（不无限等待事件流闭合）。 */
            const raced = await abortable(withTailDeadline(nextEvent(), TAIL_TIMEOUT));
            if (raced === TAIL_TIMEOUT) {
              gaps.add('events_tail_timeout');
              diagnostics.add('events_tail_timeout');
              abandonIterator();
              break;
            }
            next = raced as IteratorResult<unknown>;
            consumeNext();
          }
          if (next.done === true) {
            eventsDone = true;
            break;
          }
          stats.eventsReceived += 1;
          if (stats.eventsReceived > limits.maxTotalEvents) {
            throw new RecordingFailure('total_event_limit_exceeded', '接收事件总数超限（受控停止）');
          }
          const rawValue = next.value;
          const normalizedValue = (() => {
            if (rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
              const rawEvent = rawValue as Record<string, unknown>;
              const payload = rawEvent.payload;
              if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
                const fields = payload as Record<string, unknown>;
                // RuntimeSession returns the validated discriminated payload; raw
                // adapters use wire payloads. Only remove a matching discriminator.
                const { kind, ...body } = fields;
                if (kind === rawEvent.kind) {
                  return { ...rawEvent, payload: rawEvent.kind === 'usage' && Object.keys(body).length === 1 && 'usage' in body ? body.usage : body };
                }
                if (kind === undefined && rawEvent.kind === 'usage' && Object.keys(fields).length === 1 && 'usage' in fields) {
                  return { ...rawEvent, payload: fields.usage };
                }
              }
            }
            return rawValue;
          })();
          const classified = classifyRuntimeEvent(normalizedValue);
          if (classified.outcome === 'unknown') {
            stats.unknownEvents += 1;
            diagnostics.add(redactOutputText(`unknown_event:${classified.observedKind}`, secrets).replace(/[\u0000-\u001f\u007f]/g, '_'));
            continue;
          }
          if (classified.outcome === 'invalid') {
            gaps.add(`invalid_event:${classified.reason}`);
            diagnostics.add(`invalid_event:${classified.reason}`);
            continue;
          }
          const event = classified.event;
          if (!event.eventId.startsWith(eventIdentityPrefix)) {
            /* 旧 Attempt/Session 或外来事件：仅留有界诊断，不进当前水位。 */
            stats.foreignEvents += 1;
            diagnostics.add('foreign_event');
            continue;
          }
          await acceptEvent(event);
        }

        /* 流尾：暂存事件的前驱不会再到——声明缺口并按序落盘。 */
        if (held.size > 0) {
          const maxHeld = Math.max(...held.keys());
          await declareMissingUpTo(maxHeld);
        }
        await flushChunk();

        /* 事件先结束：等待结果的尾部有界。 */
        if (!resultSettled) {
          tailStartedAtMs = nowMs();
          const raced = await abortable(withTailDeadline(resultWatch, TAIL_TIMEOUT));
          if (raced === TAIL_TIMEOUT) {
            resultStatus = 'tail_timeout';
            gaps.add('result_tail_timeout');
            diagnostics.add('result_tail_timeout');
          }
        }
        if (isAborted()) throw abortError();
      } catch (error) {
        abandonIterator();
        return await failRecording(error);
      } finally {
        clearTimeout(activeTailTimer);
        if (abortListener !== null) signal?.removeEventListener('abort', abortListener);
      }

      const observedFailure = settledResultFailure();
      if (observedFailure !== null) {
        resultStatus = 'invalid';
        gaps.add(`result_invalid:${observedFailure}`);
        diagnostics.add(`result_invalid:${observedFailure}`);
        resultValue = null;
      }
      const finalResult = settledResult();

      /* 终态核对：finalEventSequence 与已持久水位。 */
      const finalEventSequence = finalResult === null ? null : finalResult.lastEventSequence;
      let sequenceReconciliation: WorkEvidenceSequenceReconciliation;
      if (finalEventSequence === null) {
        sequenceReconciliation = 'not_available';
      } else if (finalEventSequence === (persistedWatermark ?? 0)) {
        sequenceReconciliation = 'match';
      } else {
        sequenceReconciliation = 'mismatch';
        gaps.add(`final_sequence_mismatch:result=${finalEventSequence},recorded=${persistedWatermark}`);
      }
      if (stats.unknownEvents > 0) gaps.add(`unknown_events:${stats.unknownEvents}`);
      if (stats.foreignEvents > 0) gaps.add(`foreign_events:${stats.foreignEvents}`);

      /* 水位/缺口最终同步（持久内容不变，仅元数据收尾）。 */
      try {
        await advanceWatermark();
      } catch (error) {
        return await failRecording(error);
      }

      const usageBasis: WorkEvidenceUsageBasis = usageCounted === 0
        ? 'none'
        : usageBases.size === 1
          ? [...usageBases][0] as 'synthetic' | 'reported'
          : 'mixed';
      const manifest: WorkEvidenceManifest = {
        schemaVersion: WORK_EVIDENCE_SCHEMA_VERSION,
        kind: WORK_EVIDENCE_MANIFEST_KIND,
        identity: {
          projectId: request.projectId,
          featureId: request.featureId,
          runId: request.identity.purpose === 'work' ? request.identity.runId : '',
          taskId: request.identity.purpose === 'work' ? request.identity.taskId : '',
          attemptId,
          sessionId: request.sessionId,
          invocationId: request.invocationId,
          executionVersion: request.executionVersion,
          owner: request.owner.principalId,
          hostInstanceId: request.owner.hostInstanceId,
        },
        runtime: runtimeId,
        adapterVersion,
        scope: {
          source: 'live',
          covers: [...WORK_EVIDENCE_SCOPE_COVERS],
          excludes: [...WORK_EVIDENCE_SCOPE_EXCLUDES],
        },
        redaction: { applied: true, secretValueCount: secrets.length },
        chunks,
        watermark: persistedWatermark,
        finalEventSequence,
        sequenceReconciliation,
        gaps: [...gaps.list],
        stats: { ...stats },
        usage: {
          basis: usageBasis,
          observations: {
            counted: usageCounted,
            semantics: 'per_event_observation',
            totals: {
              inputTokens: usageUnknown.inputTokens ? null : usageTotals.inputTokens,
              outputTokens: usageUnknown.outputTokens ? null : usageTotals.outputTokens,
              costUsdMicros: usageUnknown.costUsdMicros ? null : usageTotals.costUsdMicros,
              complete: !usageUnknown.inputTokens && !usageUnknown.outputTokens &&
                !usageUnknown.costUsdMicros,
            },
          },
          finalReported: finalResult === null ? null : finalResult.usage,
          historicalBaseline: null,
          notAdditive: true,
        },
        result: finalResult === null ? null : {
          terminal: finalResult.terminal,
          reason: finalResult.reason,
          exitCode: finalResult.exitCode,
          signal: finalResult.signal,
          durationMs: finalResult.durationMs,
          usage: finalResult.usage,
          lastEventSequence: finalResult.lastEventSequence,
        },
        resultStatus,
        diagnostics: [...diagnostics.list],
        coverage: (gaps.list.length === 0 && resultStatus === 'settled' &&
          sequenceReconciliation !== 'mismatch') ? 'complete' : 'partial',
      };

      let manifestArtifactId: string;
      try {
        const body = Buffer.from(JSON.stringify(manifest), 'utf8');
        const published = await deps.publisher.publishArtifact({
          projectId: request.projectId,
          kind: WORK_EVIDENCE_MANIFEST_KIND,
          mediaType: WORK_EVIDENCE_MANIFEST_MEDIA_TYPE,
          expectedHash: createHash('sha256').update(body).digest('hex'),
          locator: `sessions/${request.sessionId}/evidence-manifest.json`,
          content: [body],
        });
        const integrity = await deps.verifier.verifyArtifact(request.projectId, published.artifact.id);
        if (integrity.kind !== 'verified_ready') throw new Error('覆盖清单完整性核验失败');
        manifestArtifactId = published.artifact.id;
      } catch (error) {
        return await failRecording(new RecordingFailure('manifest_publish_failed', '覆盖清单发布失败', error), manifest);
      }

      return {
        status: manifest.coverage === 'complete' ? 'complete' : 'partial',
        manifestArtifactId,
        watermark: persistedWatermark,
        gaps: [...gaps.list],
        stats: { ...stats },
        result: finalResult,
        resultStatus,
        sequenceReconciliation,
      };

      /* ---------------- required 失败统一出口 ---------------- */
      async function failRecording(error: unknown, manifestDraft?: WorkEvidenceManifest): Promise<never> {
        const failure = error instanceof RecordingFailure
          ? error
          : new RecordingFailure('validation', '采集输入非法', error);
        const aborted = failure.failureReason === 'aborted';
        {
          /* 取消接受不代表停止；等待有界，安全停止由调用方核验。 */
          try {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, Math.min(limits.tailWaitMs, 250));
              Promise.resolve().then(() => handle.cancel()).then(
                () => { clearTimeout(timer); resolve(); },
                () => { clearTimeout(timer); resolve(); },
              );
            });
          } catch {
            /* 取消本身失败不覆盖原始失败；停止核验由外层（F-010）承担。 */
          }
        }
        /* 尽力标缺口（recording_failed:<reason>，中止为 recording_failed:aborted），
         * 已保存证据与已发布分块原样保留。 */
        gaps.add(`recording_failed:${failure.failureReason}`);
        try {
          await advanceWatermark();
        } catch {
          /* 水位推进失败不覆盖原始失败；Session 保留最后一致状态。 */
        }
        /* 尽力发布诚实清单（coverage='failed'），不生成虚假 ready/complete。 */
        let failedManifestId: string | null = null;
        if (!aborted) {
          try {
            const draft = buildFailedManifest(manifestDraft);
            const body = Buffer.from(JSON.stringify(draft), 'utf8');
            const published = await deps.publisher.publishArtifact({
              projectId: request.projectId,
              kind: WORK_EVIDENCE_MANIFEST_KIND,
              mediaType: WORK_EVIDENCE_MANIFEST_MEDIA_TYPE,
              expectedHash: createHash('sha256').update(body).digest('hex'),
              locator: `sessions/${request.sessionId}/evidence-manifest.json`,
              content: [body],
            });
            const integrity = await deps.verifier.verifyArtifact(request.projectId, published.artifact.id);
            if (integrity.kind !== 'verified_ready') throw new Error('失败清单完整性核验失败');
            failedManifestId = published.artifact.id;
          } catch {
            /* 清单发布同样失败（如 ENOSPC）：只传播原始记录失败。 */
          }
        }
        throw new WorkEvidenceRecordingError(
          failure.failureReason,
          `${OPERATION}: ${failure.message}`,
          {
            watermark: persistedWatermark,
            gaps: [...gaps.list],
            safeStopRequired: !aborted,
            manifestArtifactId: failedManifestId,
            cause: failure.causeValue,
          },
        );
      }

      /** 失败路径诚实清单：沿用已采集事实，coverage 固定 failed。 */
      function buildFailedManifest(manifestDraft?: WorkEvidenceManifest): WorkEvidenceManifest {
        const usageBasis: WorkEvidenceUsageBasis = usageCounted === 0
          ? 'none'
          : usageBases.size === 1
            ? [...usageBases][0] as 'synthetic' | 'reported'
            : 'mixed';
        const base: WorkEvidenceManifest = manifestDraft ?? {
          schemaVersion: WORK_EVIDENCE_SCHEMA_VERSION,
          kind: WORK_EVIDENCE_MANIFEST_KIND,
          identity: {
            projectId: request.projectId,
            featureId: request.featureId,
            runId: request.identity.purpose === 'work' ? request.identity.runId : '',
            taskId: request.identity.purpose === 'work' ? request.identity.taskId : '',
            attemptId: attemptId as string,
            sessionId: request.sessionId,
            invocationId: request.invocationId,
            executionVersion: request.executionVersion,
            owner: request.owner.principalId,
            hostInstanceId: request.owner.hostInstanceId,
          },
          runtime: runtimeId,
          adapterVersion,
          scope: {
            source: 'live',
            covers: [...WORK_EVIDENCE_SCOPE_COVERS],
            excludes: [...WORK_EVIDENCE_SCOPE_EXCLUDES],
          },
          redaction: { applied: true, secretValueCount: secrets.length },
          chunks: [],
          watermark: null,
          finalEventSequence: null,
          sequenceReconciliation: 'not_available',
          gaps: [],
          stats: { ...stats },
          usage: {
            basis: usageBasis,
            observations: {
              counted: usageCounted,
              semantics: 'per_event_observation',
              totals: {
                inputTokens: usageUnknown.inputTokens ? null : usageTotals.inputTokens,
                outputTokens: usageUnknown.outputTokens ? null : usageTotals.outputTokens,
                costUsdMicros: usageUnknown.costUsdMicros ? null : usageTotals.costUsdMicros,
                complete: !usageUnknown.inputTokens && !usageUnknown.outputTokens &&
                  !usageUnknown.costUsdMicros,
              },
            },
            finalReported: null,
            historicalBaseline: null,
            notAdditive: true,
          },
          result: null,
          resultStatus: resultSettled ? (resultFailure === null ? 'settled' : 'invalid') : 'tail_timeout',
          diagnostics: [...diagnostics.list],
          coverage: 'failed',
        };
        return {
          ...base,
          chunks: [...chunks],
          watermark: persistedWatermark,
          gaps: [...gaps.list],
          stats: { ...stats },
          diagnostics: [...diagnostics.list],
          coverage: 'failed',
        };
      }
    },
  };
}

interface ValidatedRecordingInput {
  readonly request: RuntimeExecutionRequest;
  readonly handle: RuntimeHandle;
  readonly eventIdentityPrefix: string;
  readonly signal?: AbortSignal;
}

function validateRecordingInput(value: unknown): ValidatedRecordingInput {
  const context: ValidationContext = { operation: OPERATION };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['request', 'handle', 'eventIdentityPrefix', 'signal'], context, 'input');
  const request = validateRuntimeExecutionRequest(object.request);
  const handle = object.handle as Partial<RuntimeHandle> | null | undefined;
  if (handle === null || typeof handle !== 'object' ||
      typeof (handle?.events as AsyncIterable<unknown> | undefined)?.[Symbol.asyncIterator] !== 'function' ||
      typeof (handle?.result as Promise<unknown> | undefined)?.then !== 'function' ||
      typeof handle?.cancel !== 'function') {
    throw validationError(context, 'input.handle', '必须是 RuntimeHandle 形状（events/result/cancel）');
  }
  const prefix = object.eventIdentityPrefix;
  if (typeof prefix !== 'string' || prefix.length === 0 || prefix.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix)) {
    throw validationError(context, 'input.eventIdentityPrefix', '必须是有界事件身份前缀 token', typeof prefix);
  }
  if (object.signal !== undefined && !(object.signal instanceof AbortSignal)) {
    throw validationError(context, 'input.signal', '必须是 AbortSignal', typeof object.signal);
  }
  return {
    request,
    handle: handle as RuntimeHandle,
    eventIdentityPrefix: prefix,
    ...(object.signal !== undefined ? { signal: object.signal as AbortSignal } : {}),
  };
}
