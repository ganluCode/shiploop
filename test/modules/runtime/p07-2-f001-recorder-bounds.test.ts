/**
 * P07-2 / F-001 统一 Recorder/Runner 有界记录策略、有效限制与结构化故障契约。
 *
 * 覆盖（验收标准）：
 * 1. 策略校验：默认兼容（与生产装配常量逐项一致）、拒绝非有限数/非安全整数/
 *    负数/非法零值/超硬上限/未知键，reorderWindow 零值语义保留，限制间关系
 *    （单事件≤单块≤累计、队列≥chunk、发布预算≤制品预算）在启动前校验；
 * 2. 有效限制与 project/Run/Attempt/invocation/executionVersion 关联落盘：旧
 *    Manifest（无 effectiveLimits）按已支持版本可读，未知版本拒绝；清单声明的
 *    recorder 限制必须与实际执行一致；运行时请求不能提高记录限制或把 required
 *    降为 best_effort；
 * 3. 可区分失败原因：输出超限、队列背压（runner_buffer_overflow）、写入超时、
 *    存储额度耗尽（ENOSPC/maxSizeBytes）、文件写入失败（短写/size_mismatch）与
 *    证据无法保存（连失败清单都发布失败 → evidence_unrecoverable）；
 * 4. 精确边界：恰好等于 maxTotalEvents/maxTotalBytes 通过，多一事件/一字节
 *    受控停止（required 安全停止需求 + 缺口 + 保留证据）。
 *
 * 实际适用范围：本策略只约束 Core 侧记录/发布路径的内存与磁盘计量；不限制
 * 授权工具对工作区的任意写入，不阻止同用户恶意进程（见 ports/work-recording-policy.ts）。
 */
import { describe, expect, it } from 'vitest';
import { openEvidenceFixture, DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';
import type { EvidenceFixture } from '../../helpers/p03-6/evidence-fixture.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createWorkEvidenceRecorder, isWorkEvidenceRecordingError } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import type { WorkEvidenceRecordingError } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { workRecordingFinalizationReserve } from '../../../packages/core/src/application/work-recording-budget.ts';
import { createWorkRecordingPublisher } from '../../../packages/core/src/application/work-recording-publish.ts';
import {
  DEFAULT_WORK_RECORDING_BOUND_POLICY,
  validateWorkRecordingBoundPolicy,
} from '../../../packages/core/src/ports/work-recording-policy.ts';
import {
  WORK_RECORDING_PUBLISH_MAX_BODY_BYTES_CAP,
  validateWorkRecordingPublishLimits,
} from '../../../packages/core/src/ports/work-recording.ts';
import {
  validateWorkEvidenceAssemblyRecordingLimits,
  validateWorkEvidenceEffectiveLimits,
  validateWorkEvidenceManifest,
  validateWorkEvidenceRecorderLimits,
  WORK_EVIDENCE_SCOPE_COVERS,
  WORK_EVIDENCE_SCOPE_EXCLUDES,
} from '../../../packages/core/src/ports/work-evidence-recorder.ts';
import type { WorkEvidenceManifest, WorkEvidenceRecorderLimits } from '../../../packages/core/src/ports/work-evidence-recorder.ts';
import { RuntimeError } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { RuntimeEvent, RuntimeExecutionResult, RuntimeHandle } from '../../../packages/core/src/ports/runtime-execution.ts';
import { ArtifactFileError } from '../../../packages/core/src/ports/artifact-files.ts';

const PUBLISH_LIMITS = DEFAULT_WORK_RECORDING_BOUND_POLICY.publish;

function manifestFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'work-evidence-manifest',
    identity: {
      projectId: 'p', featureId: 'f', runId: 'r', taskId: 't', attemptId: 'a',
      sessionId: 's', invocationId: 'i', executionVersion: 1, owner: 'o', hostInstanceId: 'h',
    },
    runtime: 'fake', adapterVersion: '1.0-fake',
    scope: { source: 'live', covers: [...WORK_EVIDENCE_SCOPE_COVERS], excludes: [...WORK_EVIDENCE_SCOPE_EXCLUDES] },
    redaction: { applied: true, secretValueCount: 0 },
    chunks: [],
    watermark: 0, finalEventSequence: 0, sequenceReconciliation: 'match',
    gaps: [],
    stats: {
      eventsReceived: 0, eventsPersisted: 0, duplicatesDropped: 0, unknownEvents: 0,
      foreignEvents: 0, lateEvents: 0, eventsOmitted: 0, bytesPersisted: 0,
    },
    usage: {
      basis: 'none',
      observations: { counted: 0, semantics: 'per_event_observation',
        totals: { inputTokens: null, outputTokens: null, costUsdMicros: null, complete: true } },
      finalReported: null, historicalBaseline: null, notAdditive: true,
    },
    result: null, resultStatus: 'settled', diagnostics: [], coverage: 'complete',
  };
}

/* ---------------- 纯校验：统一有界记录策略 ---------------- */

describe('P07-2 F-001 unified bound policy validation (pure)', () => {
  it('accepts the default policy and keeps it byte-compatible with the production assembly values', () => {
    const policy = validateWorkRecordingBoundPolicy(DEFAULT_WORK_RECORDING_BOUND_POLICY);
    expect(policy.recorder).toEqual({
      maxEventBodyBytes: 8_192, chunkMaxEvents: 32, chunkMaxBytes: 262_144,
      maxTotalEvents: 10_000, maxTotalBytes: 8_000_000, reorderWindow: 8, tailWaitMs: 2_000,
    });
    expect(policy.publish).toEqual({
      maxBodyBytes: 131_072, maxAttachmentBytes: 65_536, maxTotalBytes: 262_144,
      maxChunkBytes: 8_192, maxQueueBytes: 8_192, maxAttachments: 32,
    });
    expect(policy.artifactPublication).toEqual({ maxSizeBytes: 16_000_000, timeoutMs: 30_000 });
  });

  it('rejects non-finite, non-safe-integer, negative and zero inputs per field', () => {
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN, -1, 0, 2 ** 53, 1.5]) {
      expect(() => validateWorkRecordingPublishLimits({ ...PUBLISH_LIMITS, maxBodyBytes: value }))
        .toThrowError(/有限安全整数/);
      expect(() => validateWorkEvidenceRecorderLimits({ ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: value }))
        .toThrowError();
    }
    expect(() => validateWorkRecordingBoundPolicy({
      ...DEFAULT_WORK_RECORDING_BOUND_POLICY,
      artifactPublication: { maxSizeBytes: Number.POSITIVE_INFINITY, timeoutMs: 30_000 },
    })).toThrowError(/有限安全整数/);
  });

  it('enforces publish hard caps and rejects unknown keys', () => {
    expect(() => validateWorkRecordingPublishLimits({ ...PUBLISH_LIMITS, maxBodyBytes: WORK_RECORDING_PUBLISH_MAX_BODY_BYTES_CAP + 1 }))
      .toThrowError(/硬上限/);
    expect(() => validateWorkRecordingPublishLimits({ ...PUBLISH_LIMITS, extra: 1 }))
      .toThrowError(/未知键|未知字段|unknown/i);
    expect(() => createWorkRecordingPublisher({
      artifacts: { publishArtifact: async () => { throw new Error('unused'); } } as never,
      limits: { ...PUBLISH_LIMITS, maxQueueBytes: PUBLISH_LIMITS.maxChunkBytes + 1_048_576 },
    })).toThrowError();
    expect(() => validateWorkRecordingBoundPolicy({ ...DEFAULT_WORK_RECORDING_BOUND_POLICY, unknownKey: true }))
      .toThrowError(/未知键|未知字段|unknown/i);
  });

  it('preserves the reorderWindow zero semantics (0 = no reordering) while rejecting negatives', () => {
    const policy = validateWorkRecordingBoundPolicy({
      ...DEFAULT_WORK_RECORDING_BOUND_POLICY,
      recorder: { ...DEFAULT_WORK_RECORDING_BOUND_POLICY.recorder, reorderWindow: 0 },
    });
    expect(policy.recorder.reorderWindow).toBe(0);
    expect(() => validateWorkRecordingBoundPolicy({
      ...DEFAULT_WORK_RECORDING_BOUND_POLICY,
      recorder: { ...DEFAULT_WORK_RECORDING_BOUND_POLICY.recorder, reorderWindow: -1 },
    })).toThrowError();
  });

  it('validates cross-limit relationships before start', () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ['single event must fit one chunk', { recorder: { ...DEFAULT_WORK_RECORDING_BOUND_POLICY.recorder, maxEventBodyBytes: 9, chunkMaxBytes: 8 } }],
      ['one chunk must fit the total disk budget', { recorder: { ...DEFAULT_WORK_RECORDING_BOUND_POLICY.recorder, chunkMaxBytes: 9, maxTotalBytes: 8 } }],
      ['chunk event count must fit total events', { recorder: { ...DEFAULT_WORK_RECORDING_BOUND_POLICY.recorder, chunkMaxEvents: 11, maxTotalEvents: 10 } }],
      ['publish queue must not be smaller than a chunk', { publish: { ...PUBLISH_LIMITS, maxQueueBytes: PUBLISH_LIMITS.maxChunkBytes - 1 } }],
      ['single body must fit the per-message budget', { publish: { ...PUBLISH_LIMITS, maxBodyBytes: PUBLISH_LIMITS.maxTotalBytes + 1 } }],
      ['single attachment must fit the per-message budget', { publish: { ...PUBLISH_LIMITS, maxAttachmentBytes: PUBLISH_LIMITS.maxTotalBytes + 1 } }],
      ['recorder disk budget must fit the artifact publication budget', { artifactPublication: { maxSizeBytes: DEFAULT_WORK_RECORDING_BOUND_POLICY.recorder.maxTotalBytes - 1, timeoutMs: 30_000 } }],
      ['publish disk budget must fit the artifact publication budget', { artifactPublication: { maxSizeBytes: PUBLISH_LIMITS.maxTotalBytes - 1, timeoutMs: 30_000 } }],
    ];
    for (const [name, mutation] of cases) {
      expect(() => validateWorkRecordingBoundPolicy({
        ...DEFAULT_WORK_RECORDING_BOUND_POLICY, ...mutation,
      }), name).toThrowError(/不得|超过/);
    }
  });
});

/* ---------------- 纯校验：有效限制与旧 Manifest 兼容 ---------------- */

describe('P07-2 F-001 effective limits manifest contract (pure)', () => {
  it('keeps legacy manifests without effectiveLimits readable and rejects unknown versions', () => {
    expect(() => validateWorkEvidenceManifest(manifestFixture())).not.toThrow();
    const legacy = manifestFixture() as { effectiveLimits?: unknown };
    expect(legacy.effectiveLimits).toBeUndefined();
    const withLimits = {
      ...manifestFixture(),
      effectiveLimits: {
        version: 2,
        recorder: DEFAULT_RECORDER_LIMITS,
        publish: PUBLISH_LIMITS,
        request: { timeoutMs: 60_000, maxEvents: 10, maxOutputBytes: 1000 },
      },
    };
    expect(() => validateWorkEvidenceManifest(withLimits)).toThrowError(/仅支持版本 1/);
  });

  it('validates the stored effective limits via the existing limit contracts', () => {
    const full = validateWorkEvidenceEffectiveLimits({
      version: 1,
      recorder: DEFAULT_RECORDER_LIMITS,
      publish: PUBLISH_LIMITS,
      request: { timeoutMs: 60_000, maxEvents: 10, maxOutputBytes: 1000, toolTimeoutMs: 30_000 },
    });
    expect(full.request.toolTimeoutMs).toBe(30_000);
    /* request 部分复用 RuntimeExecutionLimits 契约：toolTimeoutMs 不得大于 timeoutMs。 */
    expect(() => validateWorkEvidenceEffectiveLimits({
      version: 1, recorder: DEFAULT_RECORDER_LIMITS, publish: PUBLISH_LIMITS,
      request: { timeoutMs: 1_000, toolTimeoutMs: 2_000, maxEvents: 10, maxOutputBytes: 1000 },
    })).toThrowError();
    expect(() => validateWorkEvidenceEffectiveLimits({
      version: 1, recorder: DEFAULT_RECORDER_LIMITS, publish: PUBLISH_LIMITS,
      request: { timeoutMs: 1_000, maxEvents: 10, maxOutputBytes: 1000, extra: 1 },
    })).toThrowError();
    expect(() => validateWorkEvidenceAssemblyRecordingLimits({ version: 1, recorder: DEFAULT_RECORDER_LIMITS }))
      .toThrowError();
  });

  it('rejects a recorder whose declared effective limits differ from the enforced limits', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    try {
      expect(() => createWorkEvidenceRecorder({
        publisher: f.publisher, verifier: f.verifier, sessions: f.sessions,
        limits: DEFAULT_RECORDER_LIMITS,
        effectiveLimits: { version: 1, recorder: { ...DEFAULT_RECORDER_LIMITS, maxTotalEvents: 99_999 }, publish: PUBLISH_LIMITS },
      })).toThrowError(/不得声明与实际执行不同的限制/);
    } finally {
      f.close();
    }
  });
});

/* ---------------- 真实采集：有效限制证据与运行时不可提限 ---------------- */

async function readManifest(f: EvidenceFixture, artifactId: string): Promise<WorkEvidenceManifest> {
  const verified = await f.verifier.readVerifiedContent(f.projectId, artifactId);
  return validateWorkEvidenceManifest(JSON.parse(Buffer.from(verified.content).toString('utf8')));
}

function craftedEvent(prefix: string, sequence: number, preview: string, text?: string): RuntimeEvent {
  return {
    schemaVersion: 1, sequence, eventId: `${prefix}${sequence}`, kind: 'message',
    occurredAtUtc: '2026-10-29T00:00:00.000Z',
    payload: { messageId: `m-${sequence}`, role: 'assistant', preview, ...(text === undefined ? {} : { text }) },
  } as unknown as RuntimeEvent;
}

function craftedResult(lastEventSequence: number): RuntimeExecutionResult {
  return {
    schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
    durationMs: 1, usage: null, lastEventSequence,
  } as RuntimeExecutionResult;
}

function craftedHandle(events: readonly RuntimeEvent[], options: { throwError?: Error; result?: RuntimeExecutionResult } = {}): RuntimeHandle {
  return {
    events: (async function* () {
      for (const event of events) yield event as unknown as never;
      if (options.throwError !== undefined) throw options.throwError;
    })(),
    result: Promise.resolve(options.result ?? craftedResult(events.length)),
    cancel: () => Promise.resolve({ accepted: true, reason: null }),
  } as unknown as RuntimeHandle;
}

/** 预计算记录器将序列化出的行字节（含结尾换行），用于精确字节边界。 */
function expectedLineBytes(event: RuntimeEvent): number {
  const payload = event.payload as { messageId: string; role: string; preview: string; text?: string };
  return Buffer.byteLength(`${JSON.stringify({
    v: 1, sequence: event.sequence, eventId: event.eventId, kind: event.kind,
    occurredAtUtc: event.occurredAtUtc,
    payload: { kind: event.kind, messageId: payload.messageId, role: payload.role, preview: payload.preview,
      ...(payload.text === undefined ? {} : { text: payload.text }) },
  })}\n`, 'utf8');
}

describe('P07-2 F-001 effective limits evidence and runtime bound integrity (real fixture)', () => {
  const assemblyLimits = { version: 1 as const, recorder: DEFAULT_RECORDER_LIMITS, publish: PUBLISH_LIMITS };

  it('records the effective limits bound to this attempt identity in the manifest', async () => {
    const f = await openEvidenceFixture({ script: messageScript(), effectiveLimits: assemblyLimits });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('complete');
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.effectiveLimits).toEqual({
        version: 1,
        recorder: DEFAULT_RECORDER_LIMITS,
        publish: PUBLISH_LIMITS,
        request: f.request.limits,
      });
      /* 身份绑定：有效限制随清单身份（project/Run/Attempt/invocation/executionVersion）落盘。 */
      expect(manifest.identity.attemptId).toBe(f.attemptId);
      expect(manifest.identity.invocationId).toBe(f.request.invocationId);
      expect(manifest.identity.executionVersion).toBe(f.request.executionVersion);
      expect(manifest.recordingMode).toBe('required');
    } finally {
      f.close();
    }
  });

  it('keeps manifests from legacy recorders readable (no effectiveLimits, still valid)', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.effectiveLimits).toBeUndefined();
    } finally {
      f.close();
    }
  });

  it('runtime requests cannot raise recorder bounds nor downgrade required recording', async () => {
    /* 请求侧限制远大于记录限制：记录仍在自身边界受控停止。 */
    const f = await openEvidenceFixture({
      script: messageScript(),
      limits: { maxTotalEvents: 2, tailWaitMs: 60 },
      effectiveLimits: { version: 1, recorder: { ...DEFAULT_RECORDER_LIMITS, maxTotalEvents: 2, tailWaitMs: 60 }, publish: PUBLISH_LIMITS },
    });
    try {
      const raisedRequest = { ...f.request, limits: { ...f.request.limits, maxEvents: 100_000 } };
      const events = [1, 2, 3].map(seq => craftedEvent(f.eventIdentityPrefix, seq, 'x'));
      const error = await f.recorder.record({
        request: raisedRequest, handle: craftedHandle(events), eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isWorkEvidenceRecordingError(error, 'total_event_limit_exceeded')).toBe(true);
      const recordingError = error as WorkEvidenceRecordingError;
      expect(recordingError.safeStopRequired).toBe(true);
      expect(recordingError.manifestArtifactId).not.toBeNull();
      const manifest = await readManifest(f, recordingError.manifestArtifactId as string);
      /* 清单如实声明两者：记录限制未被请求提高，模式未被降级。 */
      expect(manifest.recordingMode).toBe('required');
      expect(manifest.effectiveLimits?.recorder.maxTotalEvents).toBe(2);
      expect(manifest.effectiveLimits?.recorder.tailWaitMs).toBe(60);
      expect(manifest.effectiveLimits?.request.maxEvents).toBe(100_000);
      expect(manifest.coverage).toBe('failed');
    } finally {
      f.close();
    }
  });

  it('accepts exactly-at-limit totals (no off-by-one) and stops on one extra event', async () => {
    const atLimit = await openEvidenceFixture({ script: messageScript(), limits: { maxTotalEvents: 3, tailWaitMs: 60 } });
    try {
      const events = [1, 2, 3].map(seq => craftedEvent(atLimit.eventIdentityPrefix, seq, 'x'));
      const outcome = await atLimit.recorder.record({
        request: atLimit.request, handle: craftedHandle(events), eventIdentityPrefix: atLimit.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('complete');
      expect(outcome.stats.eventsPersisted).toBe(3);
    } finally {
      atLimit.close();
    }
    const overByOne = await openEvidenceFixture({ script: messageScript(), limits: { maxTotalEvents: 2, tailWaitMs: 60 } });
    try {
      const events = [1, 2, 3].map(seq => craftedEvent(overByOne.eventIdentityPrefix, seq, 'x'));
      const error = await overByOne.recorder.record({
        request: overByOne.request, handle: craftedHandle(events.slice(0, 3)), eventIdentityPrefix: overByOne.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isWorkEvidenceRecordingError(error, 'total_event_limit_exceeded')).toBe(true);
    } finally {
      overByOne.close();
    }
  });

  it('stops on one byte over the total disk budget and accepts the exact total', async () => {
    /* P07-2 / F-004 起 maxTotalBytes 是含公开正文/附件/Manifest 的累计磁盘额度：
     * 正文池 = maxTotalBytes − 收尾保留额度（min(chunkMaxBytes, floor(L/4))）。
     * 每个 fixture 的 eventId 含会话相关前缀：先打开 fixture，再按其自身前缀
     * 计算精确行字节，用白定义 recorder 的 maxTotalBytes 贴正文池边界。 */
    const limitForBodyCap = (cap: number): number => {
      const capOf = (limitBytes: number): number => limitBytes - workRecordingFinalizationReserve(limitBytes, DEFAULT_RECORDER_LIMITS.chunkMaxBytes);
      let limitBytes = Math.max(1, cap);
      while (capOf(limitBytes) < cap) limitBytes += 1;
      return limitBytes;
    };
    const exact = await openEvidenceFixture({ script: messageScript(), limits: { tailWaitMs: 60 } });
    try {
      /* 正文体积选大：收尾保留额度（≈ cap/3）能容纳覆盖清单。 */
      const events = [1, 2, 3].map(seq => craftedEvent(exact.eventIdentityPrefix, seq, `正文-${seq}`, `长正文-${seq}-${'x'.repeat(2400)}`));
      const totalBytes = events.reduce((sum, event) => sum + expectedLineBytes(event), 0);
      const recorder = createWorkEvidenceRecorder({
        publisher: exact.publisher, verifier: exact.verifier, sessions: exact.sessions,
        limits: { ...DEFAULT_RECORDER_LIMITS, maxTotalBytes: limitForBodyCap(totalBytes), tailWaitMs: 60 },
      });
      const outcome = await recorder.record({
        request: exact.request, handle: craftedHandle(events), eventIdentityPrefix: exact.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('complete');
      expect(outcome.stats.bytesPersisted).toBe(totalBytes);
      /* 累计申请 = 事件分块 + 覆盖清单，均计入同一额度。 */
      expect(outcome.storageBudget!.bodyClaimedBytes).toBe(totalBytes);
    } finally {
      exact.close();
    }
    const oneByteShort = await openEvidenceFixture({ script: messageScript(), limits: { tailWaitMs: 60 } });
    try {
      const events = [1, 2, 3].map(seq => craftedEvent(oneByteShort.eventIdentityPrefix, seq, `正文-${seq}`, `长正文-${seq}-${'x'.repeat(2400)}`));
      const totalBytes = events.reduce((sum, event) => sum + expectedLineBytes(event), 0);
      const recorder = createWorkEvidenceRecorder({
        publisher: oneByteShort.publisher, verifier: oneByteShort.verifier, sessions: oneByteShort.sessions,
        limits: { ...DEFAULT_RECORDER_LIMITS, maxTotalBytes: limitForBodyCap(totalBytes - 1), tailWaitMs: 60 },
      });
      const error = await recorder.record({
        request: oneByteShort.request, handle: craftedHandle(events), eventIdentityPrefix: oneByteShort.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isWorkEvidenceRecordingError(error, 'total_bytes_limit_exceeded')).toBe(true);
      expect((error as WorkEvidenceRecordingError).gaps).toContain('recording_failed:total_bytes_limit_exceeded');
    } finally {
      oneByteShort.close();
    }
  });
});

/* ---------------- 可区分失败原因（真实故障注入） ---------------- */

describe('P07-2 F-001 distinguishable recording failure reasons (real fault injection)', () => {
  it('classifies ENOSPC as storage exhaustion, not a generic publish failure', async () => {
    let injected = false;
    const f = await openEvidenceFixture({
      script: messageScript(),
      wrapFiles: (files) => ({
        ...files,
        async openStagingWrite(key: unknown) {
          if (!injected) {
            injected = true;
            throw new ArtifactFileError('io', 'test.inject', '注入磁盘满', { details: { code: 'ENOSPC' } });
          }
          return files.openStagingWrite(key);
        },
      }),
    });
    try {
      const error = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isWorkEvidenceRecordingError(error, 'event_storage_exhausted')).toBe(true);
      const recordingError = error as WorkEvidenceRecordingError;
      expect(recordingError.gaps).toContain('recording_failed:event_storage_exhausted');
      const session = f.sessions.getWorkSession(f.projectId, f.sessionId);
      expect(session.recordingGaps).toContain('recording_failed:event_storage_exhausted');
    } finally {
      f.close();
    }
  });

  it('classifies publication timeout via the artifact publication deadline', async () => {
    const f = await openEvidenceFixture({ script: messageScript(), limits: { tailWaitMs: 60 } });
    try {
      /* 逐次递增的假时钟：第一次 startedAtMs 后的预算检查必然超时（确定性，不依赖真实延迟）。 */
      let ticks = 0;
      const slowPublisher = createArtifactPublisher({
        artifacts: f.artifacts,
        files: createArtifactFileStore({ dataRoot: f.budget.box.dataRoot }),
        limits: { maxSizeBytes: 4_000_000, timeoutMs: 1 },
        nowMs: () => (ticks += 10),
      });
      const recorder = createWorkEvidenceRecorder({
        publisher: slowPublisher, verifier: f.verifier, sessions: f.sessions,
        limits: { ...DEFAULT_RECORDER_LIMITS, tailWaitMs: 60 },
      });
      const event = craftedEvent(f.eventIdentityPrefix, 1, 'x');
      const error = await recorder.record({
        request: f.request, handle: craftedHandle([event]), eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isWorkEvidenceRecordingError(error, 'event_write_timeout')).toBe(true);
      expect((error as WorkEvidenceRecordingError).gaps).toContain('recording_failed:event_write_timeout');
    } finally {
      f.close();
    }
  });

  it('classifies runner bounded-queue backpressure distinctly from stream failures', async () => {
    const f = await openEvidenceFixture({ script: messageScript(), limits: { tailWaitMs: 60 } });
    try {
      const error = await f.recorder.record({
        request: f.request,
        handle: craftedHandle([craftedEvent(f.eventIdentityPrefix, 1, 'x')], {
          throwError: new RuntimeError('protocol', 'runner_buffer_overflow'),
        }),
        eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isWorkEvidenceRecordingError(error, 'event_queue_backpressure')).toBe(true);
      const recordingError = error as WorkEvidenceRecordingError;
      expect(recordingError.gaps).toContain('recording_failed:event_queue_backpressure');
      const session = f.sessions.getWorkSession(f.projectId, f.sessionId);
      expect(session.recordingGaps).toContain('recording_failed:event_queue_backpressure');
    } finally {
      f.close();
    }
  });

  it('marks evidence unrecoverable when even the honest failure manifest cannot be saved', async () => {
    let writes = 0;
    const f = await openEvidenceFixture({
      script: messageScript(),
      wrapFiles: (files) => ({
        ...files,
        async openStagingWrite(key: unknown) {
          writes += 1;
          /* 分块正常落盘；第 3 次起的写入（成功清单与失败清单）一律失败。 */
          if (writes >= 3) throw new ArtifactFileError('io', 'test.inject', '注入写入失败');
          return files.openStagingWrite(key);
        },
      }),
    });
    try {
      const error = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isWorkEvidenceRecordingError(error, 'manifest_file_write_failed')).toBe(true);
      const recordingError = error as WorkEvidenceRecordingError;
      /* 连失败清单都无法保存：证据无法保存缺口可区分，且不虚构清单制品。 */
      expect(recordingError.manifestArtifactId).toBeNull();
      expect(recordingError.gaps).toContain('evidence_unrecoverable');
      const session = f.sessions.getWorkSession(f.projectId, f.sessionId);
      expect(session.recordingGaps).toContain('recording_failed:manifest_file_write_failed');
      expect(session.recordingGaps).toContain('evidence_unrecoverable');
    } finally {
      f.close();
    }
  });
});

function messageScript(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    steps: [
      { op: 'message', role: 'assistant', text: '开始执行' },
      { op: 'tool', name: 'read_file', exitCode: 0 },
      { op: 'usage', inputTokens: 10, outputTokens: 5, costUsdMicros: 100 },
      { op: 'message', role: 'assistant', text: '收尾摘要' },
      { op: 'usage', inputTokens: 4, outputTokens: 2, costUsdMicros: 40 },
    ],
    result: {
      terminal: 'completed', reason: null, exitCode: null, signal: null,
      durationMs: null, usage: { inputTokens: 14, outputTokens: 7, costUsdMicros: 140 },
    },
    ...overrides,
  };
}
