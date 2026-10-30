/**
 * F-002 Work 公开正文发布编排。
 *
 * Runtime 只把已经公开的消息、工具参数/结果、stdout/stderr 和附件交给本模块。
 * 本模块先做有界 UTF-8 脱敏，再把字节流交给 F-011 ArtifactPublisher；SQLite
 * 侧只应保存返回的 ArtifactInputRef/WorkRecordingArtifactRef。这里不读取 SDK
 * 私有档案，也不从 logger 文本重建公开事件。
 */
import { createOutputRedactor } from './output-redaction.js';
import type { ArtifactPublisher, ArtifactPublishResult } from './artifact-publish.js';
import type { WorkRecordingArtifactRef, WorkRecordingMessageRole } from '../ports/work-recording.js';
import { WORK_RECORDING_MESSAGE_ROLES } from '../ports/work-recording.js';
import { validateWorkRecordingPublishLimits } from '../ports/work-recording.js';
import type { RequiredWorkRecordingPublishLimits, WorkRecordingPublishLimits } from '../ports/work-recording.js';
import {
  requireNonEmptyString,
  validateArtifactLocator,
  validateSha256Digest,
  validateStableId,
} from '../ports/validation.js';

// P07-2 / F-001：限制形状与硬上限上移到 ports/work-recording.ts（单一契约源）；
// 此处重导出保持既有导入路径兼容。
export type { WorkRecordingPublishLimits } from '../ports/work-recording.js';

export const WORK_RECORDING_BODY_KINDS = [
  'message', 'tool_input', 'tool_output', 'tool_started', 'tool_finished', 'error', 'stdout', 'stderr', 'final_result', 'attachment',
] as const;
export type WorkRecordingBodyKind = (typeof WORK_RECORDING_BODY_KINDS)[number];
export type WorkRecordingBodyStatus = 'complete' | 'truncated' | 'unavailable';
export type WorkRecordingPublicationCoverage = 'complete' | 'partial' | 'failed';

type ByteStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export interface WorkRecordingBodyInput {
  readonly projectId: string;
  readonly kind: WorkRecordingBodyKind;
  readonly mediaType: string;
  readonly locator: string;
  /** 必须是脱敏、截断后预期正文的 SHA-256；ArtifactPublisher 会再次核验。 */
  readonly expectedHash: string;
  readonly content: ByteStream;
  readonly signal?: AbortSignal;
}

export interface WorkRecordingAttachmentInput {
  readonly name?: string | null;
  readonly mediaType: string;
  readonly locator: string;
  /** 必须是脱敏、截断后预期正文的 SHA-256。 */
  readonly expectedHash: string;
  readonly content: ByteStream;
  readonly signal?: AbortSignal;
}

export interface WorkRecordingBodyPublication {
  readonly status: WorkRecordingBodyStatus;
  readonly ref: WorkRecordingArtifactRef | null;
  /** 从上游观察到的字节数；可能包含被上限丢弃的尾部。 */
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
  readonly redacted: boolean;
  /** 固定的、脱敏的缺口代码；不包含 cause/message/path/body。 */
  readonly gapReasons: readonly string[];
}

export interface WorkRecordingMessagePublicationInput {
  readonly projectId: string;
  readonly message: Omit<WorkRecordingBodyInput, 'projectId'> & { readonly role: WorkRecordingMessageRole };
  readonly attachments?: readonly WorkRecordingAttachmentInput[];
}

export interface WorkRecordingMessagePublication {
  readonly body: WorkRecordingBodyPublication;
  readonly attachments: readonly WorkRecordingBodyPublication[];
  readonly coverage: WorkRecordingPublicationCoverage;
  readonly missingReasons: readonly string[];
}

export interface WorkRecordingPublisher {
  publishBody(input: WorkRecordingBodyInput): Promise<WorkRecordingBodyPublication>;
  publishMessage(input: WorkRecordingMessagePublicationInput): Promise<WorkRecordingMessagePublication>;
}

export interface WorkRecordingPublisherDeps {
  readonly artifacts: ArtifactPublisher;
  readonly limits: WorkRecordingPublishLimits;
  /** 只用于公开文本流；值本身不进入错误或索引。 */
  readonly redactionValues?: readonly string[];
}

class WorkRecordingInputError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'WorkRecordingInputError';
    this.reason = reason;
  }
}

function isByteStream(value: unknown): value is ByteStream {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const object = Object(value) as { [Symbol.asyncIterator]?: unknown; [Symbol.iterator]?: unknown };
  return typeof object[Symbol.asyncIterator] === 'function' || typeof object[Symbol.iterator] === 'function';
}

function validateLimits(value: WorkRecordingPublishLimits): RequiredWorkRecordingPublishLimits {
  return validateWorkRecordingPublishLimits(value, { operation: 'WorkRecordingPublisher.create' }, 'limits');
}

function textual(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();
  return normalized.startsWith('text/') || normalized.includes('json') || normalized.includes('xml')
    || normalized.includes('javascript') || normalized.includes('x-www-form-urlencoded');
}

function safeGap(error: unknown): string {
  if (error instanceof WorkRecordingInputError) return error.reason;
  const code = error as { code?: unknown };
  switch (code.code) {
    case 'hash_mismatch': return 'body_hash_mismatch';
    case 'size_mismatch': return 'body_size_mismatch';
    case 'size_limit_exceeded': return 'body_limit';
    case 'cancelled': return 'cancelled';
    case 'timeout': return 'publication_timeout';
    case 'file': return 'publication_file_error';
    case 'storage': return 'publication_storage_error';
    case 'stream': return 'body_stream_error';
    default: return 'publication_failed';
  }
}

function artifactRef(result: ArtifactPublishResult): WorkRecordingArtifactRef {
  const artifact = result.artifact;
  if (artifact.status !== 'ready' || artifact.contentHash === null || artifact.sizeBytes === null) {
    throw new WorkRecordingInputError('artifact_not_ready');
  }
  return {
    artifactId: artifact.id,
    contentHash: artifact.contentHash,
    sizeBytes: artifact.sizeBytes,
    locator: artifact.locator,
  };
}

/**
 * 创建 Work 正文发布器。每个 publishBody 调用最多持有一个有界 chunk；
 * ArtifactPublisher 负责 pending/staging/hash/ready 失败证据，本模块不吞掉它。
 */
export function createWorkRecordingPublisher(deps: WorkRecordingPublisherDeps): WorkRecordingPublisher {
  if (deps === null || typeof deps !== 'object' || deps.artifacts === null || typeof deps.artifacts !== 'object') {
    throw new TypeError('WorkRecordingPublisher: artifacts is required');
  }
  const limits = validateLimits(deps.limits);
  if (limits.maxQueueBytes < limits.maxChunkBytes) {
    throw new RangeError('WorkRecordingPublisher: maxQueueBytes must be >= maxChunkBytes');
  }
  const redactionValues = deps.redactionValues ?? [];
  // 预算校验在装配时完成，避免运行中把秘密预算错误当成正文缺口。
  createOutputRedactor(redactionValues);
  let queuedBytes = 0;

  async function publishBodyInternal(
    input: WorkRecordingBodyInput,
    total: { retained: number },
    attachment: boolean,
  ): Promise<WorkRecordingBodyPublication> {
    const operation = 'WorkRecordingPublisher.publishBody';
    let projectId: string;
    let kind: WorkRecordingBodyKind;
    let mediaType: string;
    let locator: string;
    let expectedHash: string;
    try {
      projectId = validateStableId(input.projectId, { operation }, 'projectId');
      kind = input.kind;
      if (!(WORK_RECORDING_BODY_KINDS as readonly string[]).includes(kind)) throw new WorkRecordingInputError('invalid_body_kind');
      mediaType = requireNonEmptyString(input.mediaType, { operation }, 'mediaType');
      locator = validateArtifactLocator(input.locator, { operation }, 'locator');
      expectedHash = validateSha256Digest(input.expectedHash, { operation }, 'expectedHash');
      if (!isByteStream(input.content)) throw new WorkRecordingInputError('invalid_content_stream');
      if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new WorkRecordingInputError('invalid_signal');
    } catch (error) {
      return { status: 'unavailable', ref: null, observedBytes: 0, retainedBytes: 0, truncated: false, redacted: false, gapReasons: [safeGap(error)] };
    }

    const limit = attachment ? limits.maxAttachmentBytes : limits.maxBodyBytes;
    const remaining = Math.max(0, limits.maxTotalBytes - total.retained);
    if (remaining === 0) {
      return { status: 'unavailable', ref: null, observedBytes: 0, retainedBytes: 0, truncated: false, redacted: false, gapReasons: ['total_volume_limit'] };
    }
    const retainedLimit = Math.min(limit, remaining);
    let observedBytes = 0;
    let retainedBytes = 0;
    let truncated = false;
    let redacted = false;
    const useRedaction = textual(mediaType) && redactionValues.length > 0;
    const decoder = useRedaction ? new TextDecoder('utf-8') : undefined;
    const redactor = useRedaction ? createOutputRedactor(redactionValues) : undefined;

    async function* boundedContent(): AsyncGenerator<Uint8Array> {
      const source = input.content as AsyncIterable<Uint8Array>;
      const iterable = typeof (source as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
        ? source
        : (async function* (): AsyncGenerator<Uint8Array> { yield* input.content as Iterable<Uint8Array>; })();
      for await (const raw of iterable) {
        if (!(raw instanceof Uint8Array)) throw new WorkRecordingInputError('invalid_byte_chunk');
        observedBytes += raw.byteLength;
        if (raw.byteLength > limits.maxChunkBytes) throw new WorkRecordingInputError('chunk_limit');
        const decoded = decoder?.decode(raw, { stream: true });
        const transformed = redactor && decoded !== undefined ? redactor.feed(decoded) : undefined;
        if (transformed !== undefined && transformed !== decoded) redacted = true;
        const output = transformed === undefined ? raw : new TextEncoder().encode(transformed);
        if (output.byteLength === 0) continue;
        let offset = 0;
        while (offset < output.byteLength) {
          const available = retainedLimit - retainedBytes;
          if (available <= 0) {
            truncated = true;
            return;
          }
          const take = Math.min(available, limits.maxChunkBytes, output.byteLength - offset);
          const chunk = output.slice(offset, offset + take);
          offset += take;
          retainedBytes += chunk.byteLength;
          total.retained += chunk.byteLength;
          if (offset < output.byteLength) truncated = true;
          if (queuedBytes + chunk.byteLength > limits.maxQueueBytes) throw new WorkRecordingInputError('queue_limit');
          queuedBytes += chunk.byteLength;
          try { yield chunk; } finally { queuedBytes -= chunk.byteLength; }
          if (truncated) return;
        }
      }
      if (decoder && redactor) {
        const flushText = decoder.decode();
        const transformedTail = redactor.feed(flushText) + redactor.end();
        if (transformedTail.includes('[REDACTED]') && !flushText.includes('[REDACTED]')) redacted = true;
        if (transformedTail.length > 0) {
          const output = new TextEncoder().encode(transformedTail);
          const available = retainedLimit - retainedBytes;
          if (output.byteLength > available) {
            const chunk = output.slice(0, Math.max(0, available));
            if (chunk.byteLength > 0) {
              retainedBytes += chunk.byteLength;
              total.retained += chunk.byteLength;
              queuedBytes += chunk.byteLength;
              try { yield chunk; } finally { queuedBytes -= chunk.byteLength; }
            }
            truncated = true;
          } else if (output.byteLength > 0) {
            retainedBytes += output.byteLength;
            total.retained += output.byteLength;
            queuedBytes += output.byteLength;
            try { yield output; } finally { queuedBytes -= output.byteLength; }
          }
        }
      }
    }

    try {
      const result = await deps.artifacts.publishArtifact({
        projectId, kind, mediaType, expectedHash, locator,
        content: boundedContent(), signal: input.signal,
      });
      const ref = artifactRef(result);
      if (ref.contentHash !== expectedHash) {
        return { status: 'unavailable', ref: null, observedBytes, retainedBytes, truncated, redacted, gapReasons: ['body_hash_mismatch'] };
      }
      if (ref.sizeBytes !== retainedBytes) {
        return { status: 'unavailable', ref: null, observedBytes, retainedBytes, truncated, redacted, gapReasons: ['body_size_mismatch'] };
      }
      return {
        status: truncated ? 'truncated' : 'complete', ref, observedBytes, retainedBytes,
        truncated, redacted, gapReasons: truncated ? ['body_limit'] : [],
      };
    } catch (error) {
      return {
        status: 'unavailable', ref: null, observedBytes, retainedBytes, truncated, redacted,
        gapReasons: [safeGap(error)],
      };
    }
  }

  async function publishBody(input: WorkRecordingBodyInput): Promise<WorkRecordingBodyPublication> {
    return publishBodyInternal(input, { retained: 0 }, false);
  }

  async function publishMessage(input: WorkRecordingMessagePublicationInput): Promise<WorkRecordingMessagePublication> {
    if (input === null || typeof input !== 'object' || input.message === null || typeof input.message !== 'object') {
      return {
        body: { status: 'unavailable', ref: null, observedBytes: 0, retainedBytes: 0, truncated: false, redacted: false, gapReasons: ['invalid_message'] },
        attachments: [], coverage: 'failed', missingReasons: ['invalid_message'],
      };
    }
    if (!(WORK_RECORDING_MESSAGE_ROLES as readonly string[]).includes(input.message.role)) {
      return {
        body: { status: 'unavailable', ref: null, observedBytes: 0, retainedBytes: 0, truncated: false, redacted: false, gapReasons: ['invalid_message_role'] },
        attachments: [], coverage: 'failed', missingReasons: ['invalid_message_role'],
      };
    }
    const total = { retained: 0 };
    const missingReasons: string[] = [];
    const body = await publishBodyInternal({ ...input.message, projectId: input.projectId }, total, false);
    missingReasons.push(...body.gapReasons);
    const rawAttachments = input.attachments ?? [];
    const attachmentLimit = limits.maxAttachments;
    const attachments: WorkRecordingBodyPublication[] = [];
    if (rawAttachments.length > attachmentLimit) missingReasons.push('attachment_count_limit');
    if (body.status === 'unavailable') {
      for (let index = 0; index < Math.min(rawAttachments.length, attachmentLimit); index += 1) {
        attachments.push({ status: 'unavailable', ref: null, observedBytes: 0, retainedBytes: 0, truncated: false, redacted: false, gapReasons: ['body_unavailable'] });
      }
    } else {
      for (const attachment of rawAttachments.slice(0, attachmentLimit)) {
        const result = await publishBodyInternal({ ...attachment, projectId: input.projectId, kind: 'attachment' }, total, true);
        attachments.push(result);
        missingReasons.push(...result.gapReasons);
      }
    }
    const uniqueReasons = [...new Set(missingReasons)];
    const hasUnavailable = body.status === 'unavailable' || attachments.some((entry) => entry.status === 'unavailable');
    const hasPartial = body.status === 'truncated' || attachments.some((entry) => entry.status === 'truncated') || uniqueReasons.length > 0;
    return {
      body,
      attachments,
      coverage: hasUnavailable ? 'failed' : hasPartial ? 'partial' : 'complete',
      missingReasons: uniqueReasons,
    };
  }

  return { publishBody, publishMessage };
}
