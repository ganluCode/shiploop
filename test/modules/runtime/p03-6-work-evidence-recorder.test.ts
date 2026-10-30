/**
 * P03-6 / F-007 最小有界公开事件与结果证据采集器测试（真实 SQLite + 真实
 * Artifact 文件 + 真实 FakeRuntime 执行，无 mock 框架/网络/SDK）。
 *
 * 覆盖（F-007 验收标准）：
 * 1. 经现有 Artifact 发布/完整性端口采集 Fake 公开事件、工具事件、最终结果
 *    与最小诊断；有界分块先落盘 ready 再推进 Session 可读取水位；清单记录
 *    关联身份、适配版本、范围、截断/脱敏、最后序列与缺失原因；
 * 2. 事件与结果同时接收（结果先到/事件先结束均不死锁，窄缓冲背压）；单事
 *    件、分块、总字节/数量与尾部等待有界，超限明确标注或受控停止；
 * 3. 重复序列不重复产生有效事件/用量；乱序只在声明有限窗口内处理；缺序列、
 *    提前断流、未知公开事件与 finalEventSequence 不匹配均可核对；旧
 *    Attempt/Session 消息仅留有界诊断，不进当前记录水位；
 * 4. 真实文件/SQLite 覆盖大事件、注入 ENOSPC 与短写发布失败、正文损坏核对；
 *    required 记录失败发出安全停止需求并标缺口，不生成虚假 ready/complete
 *    制品，已保存证据保留；
 * 5. 清单仅声明 Fake 可见公开范围（固定 covers/excludes 词汇）；秘密样例在
 *    持久化前脱敏；synthetic 用量与未知字段分开，不建立真实缓存/费用汇总；
 * 6. 恢复边界：事件重放按稳定 eventId 去重；用量声明 per_event 口径、历史
 *    基线 null、notAdditive；无稳定身份（外来/未知）记录 partial，不重复计量。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openEvidenceFixture, DEFAULT_RECORDER_LIMITS, EVIDENCE_NOW } from '../../helpers/p03-6/evidence-fixture.ts';
import type { EvidenceFixture } from '../../helpers/p03-6/evidence-fixture.ts';
import { createFakeRuntimeGate } from '../../../packages/core/src/adapters/fake-runtime.ts';
import type { FakeRuntimeHandle } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { ArtifactFileError } from '../../../packages/core/src/ports/artifact-files.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import {
  isWorkEvidenceRecordingError,
} from '../../../packages/core/src/application/work-evidence-recorder.ts';
import {
  validateWorkEvidenceEventLine,
  validateWorkEvidenceManifest,
  validateWorkEvidenceRecorderLimits,
  WORK_EVIDENCE_EVENTS_KIND,
  WORK_EVIDENCE_MANIFEST_KIND,
  WORK_EVIDENCE_SCOPE_COVERS,
  WORK_EVIDENCE_SCOPE_EXCLUDES,
} from '../../../packages/core/src/ports/work-evidence-recorder.ts';
import type { WorkEvidenceManifest } from '../../../packages/core/src/ports/work-evidence-recorder.ts';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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

async function readManifest(f: EvidenceFixture, artifactId: string): Promise<WorkEvidenceManifest> {
  const verified = await f.verifier.readVerifiedContent(f.projectId, artifactId);
  return validateWorkEvidenceManifest(JSON.parse(Buffer.from(verified.content).toString('utf8')));
}

async function readChunkLines(f: EvidenceFixture, artifactId: string) {
  const verified = await f.verifier.readVerifiedContent(f.projectId, artifactId);
  const text = Buffer.from(verified.content).toString('utf8');
  return text.split('\n').filter((line) => line.length > 0)
    .map((line) => validateWorkEvidenceEventLine(JSON.parse(line)));
}

describe('P03-6 F-007 recorder port contract (pure validation)', () => {
  it('validates limits with hard caps and unknown-key rejection', () => {
    const limits = validateWorkEvidenceRecorderLimits(DEFAULT_RECORDER_LIMITS);
    expect(limits.chunkMaxEvents).toBe(4);
    expect(() => validateWorkEvidenceRecorderLimits({ ...DEFAULT_RECORDER_LIMITS, extra: 1 }))
      .toThrowError(/未知键|未知字段|unknown/i);
    expect(() => validateWorkEvidenceRecorderLimits({ ...DEFAULT_RECORDER_LIMITS, maxEventBodyBytes: 0 }))
      .toThrowError();
    expect(() => validateWorkEvidenceRecorderLimits({ ...DEFAULT_RECORDER_LIMITS, chunkMaxBytes: 2_000_000 }))
      .toThrowError(/硬上限/);
    expect(() => validateWorkEvidenceRecorderLimits({ ...DEFAULT_RECORDER_LIMITS, reorderWindow: 99 }))
      .toThrowError(/硬上限/);
    expect(() => validateWorkEvidenceRecorderLimits({ ...DEFAULT_RECORDER_LIMITS, tailWaitMs: 0 }))
      .toThrowError();
  });

  it('validates event lines via the F-001 event contract', () => {
    const line = validateWorkEvidenceEventLine({
      v: 1, sequence: 2, eventId: 'evt.abc.2', kind: 'message',
      occurredAtUtc: '2026-10-15T00:00:00.000Z',
      payload: { kind: 'message', messageId: 'msg.abc.1', role: 'assistant', preview: '正文' },
    });
    expect(line.sequence).toBe(2);
    expect(() => validateWorkEvidenceEventLine({
      v: 2, sequence: 2, eventId: 'evt.abc.2', kind: 'message',
      occurredAtUtc: '2026-10-15T00:00:00.000Z',
      payload: { kind: 'message', messageId: 'm', role: 'assistant', preview: 'x' },
    })).toThrowError();
    expect(() => validateWorkEvidenceEventLine({
      v: 1, sequence: 2, eventId: 'evt.abc.2', kind: 'message',
      occurredAtUtc: '2026-10-15T00:00:00.000Z',
      payload: { kind: 'message', messageId: 'm', role: 'bogus', preview: 'x' },
    })).toThrowError();
  });

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
      redaction: { applied: true, secretValueCount: 1 },
      chunks: [],
      watermark: 3, finalEventSequence: 3, sequenceReconciliation: 'match',
      gaps: [],
      stats: {
        eventsReceived: 3, eventsPersisted: 3, duplicatesDropped: 0, unknownEvents: 0,
        foreignEvents: 0, lateEvents: 0, eventsOmitted: 0, bytesPersisted: 300,
      },
      usage: {
        basis: 'synthetic',
        observations: {
          counted: 1, semantics: 'per_event_observation',
          totals: { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, complete: true },
        },
        finalReported: null, historicalBaseline: null, notAdditive: true,
      },
      result: null,
      resultStatus: 'settled',
      diagnostics: [],
      coverage: 'complete',
    };
  }

  it('validates manifests fail-closed and refuses overstated coverage', () => {
    const valid = validateWorkEvidenceManifest(manifestFixture());
    expect(valid.coverage).toBe('complete');
    expect(() => validateWorkEvidenceManifest({ ...manifestFixture(), extra: true })).toThrowError();
    /* 范围缩减或夸大一律拒绝。 */
    const narrowed = manifestFixture();
    narrowed['scope'] = { source: 'live', covers: ['public_events'], excludes: [...WORK_EVIDENCE_SCOPE_EXCLUDES] };
    expect(() => validateWorkEvidenceManifest(narrowed)).toThrowError();
    const overstated = manifestFixture();
    overstated['scope'] = { source: 'live', covers: [...WORK_EVIDENCE_SCOPE_COVERS], excludes: [] };
    expect(() => validateWorkEvidenceManifest(overstated)).toThrowError();
    /* complete 只对无缺口已声明范围成立。 */
    expect(() => validateWorkEvidenceManifest({ ...manifestFixture(), gaps: ['missing_sequences:2'] }))
      .toThrowError();
    /* 恢复边界：历史基线 v1 恒 null；用量绝不重复加总。 */
    const baseline = manifestFixture();
    (baseline['usage'] as Record<string, unknown>)['historicalBaseline'] = { inputTokens: 1 };
    expect(() => validateWorkEvidenceManifest(baseline)).toThrowError();
    const additive = manifestFixture();
    (additive['usage'] as Record<string, unknown>)['notAdditive'] = false;
    expect(() => validateWorkEvidenceManifest(additive)).toThrowError();
  });
});

describe('P03-6 F-007 bounded evidence recorder (real SQLite + files + Fake)', () => {
  it('collects events/result with chunked artifacts, then advances the session watermark', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('complete');
      expect(outcome.gaps).toEqual([]);
      expect(outcome.sequenceReconciliation).toBe('match');
      expect(outcome.result?.terminal).toBe('completed');
      expect(outcome.watermark).toBe(6);

      /* 分块：6 事件 / chunkMaxEvents 4 → 两块，逐块 ready 且水位只指向持久内容。 */
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.chunks).toHaveLength(2);
      expect(manifest.chunks[0]).toMatchObject({ firstSequence: 1, lastSequence: 4, eventCount: 4 });
      expect(manifest.chunks[1]).toMatchObject({ firstSequence: 5, lastSequence: 6, eventCount: 2 });
      for (const chunk of manifest.chunks) {
        const index = await f.artifacts.getArtifact(f.projectId, chunk.artifactId);
        expect(index.status).toBe('ready');
        expect(index.kind).toBe(WORK_EVIDENCE_EVENTS_KIND);
        const lines = await readChunkLines(f, chunk.artifactId);
        expect(lines.map((line) => line.sequence)).toEqual(
          Array.from({ length: chunk.eventCount }, (_, offset) => chunk.firstSequence + offset),
        );
        if (chunk.firstSequence === 1) {
          expect(lines[1]?.kind).toBe('tool_started');
          expect(lines[2]?.kind).toBe('tool_finished');
        }
      }
      /* 关联身份、适配版本、范围与脱敏标记。 */
      expect(manifest.identity).toMatchObject({
        projectId: f.projectId, featureId: f.featureId, runId: f.runId, taskId: f.taskId,
        attemptId: f.attemptId, sessionId: f.sessionId, invocationId: 'invocation-1',
        executionVersion: 1, owner: 'owner-1', hostInstanceId: 'host-1',
      });
      expect(manifest.runtime).toBe('fake');
      expect(manifest.adapterVersion).toBe('1.0-fake');
      expect(manifest.scope.excludes).toEqual([...WORK_EVIDENCE_SCOPE_EXCLUDES]);
      expect(manifest.scope.covers).toEqual([...WORK_EVIDENCE_SCOPE_COVERS]);
      /* 用量：事件观察去重计入（synthetic），最终结果单列，不重复加总。 */
      expect(manifest.usage.basis).toBe('synthetic');
      expect(manifest.usage.observations).toMatchObject({
        counted: 2, semantics: 'per_event_observation',
        totals: { inputTokens: 14, outputTokens: 7, costUsdMicros: 140, complete: true },
      });
      expect(manifest.usage.finalReported).toMatchObject({ basis: 'synthetic', inputTokens: 14 });
      expect(manifest.usage.historicalBaseline).toBeNull();
      expect(manifest.usage.notAdditive).toBe(true);
      expect(manifest.result).toMatchObject({ terminal: 'completed', lastEventSequence: 6 });
      /* Session 水位与缺口元数据。 */
      const session = f.sessions.getWorkSession(f.projectId, f.sessionId);
      expect(session.recordingWatermark).toBe(6);
      expect(session.recordingGaps).toEqual([]);
      /* 清单制品本身 ready 且经完整性端口可读取。 */
      const manifestIndex = await f.artifacts.getArtifact(f.projectId, outcome.manifestArtifactId);
      expect(manifestIndex.kind).toBe(WORK_EVIDENCE_MANIFEST_KIND);
      expect(manifestIndex.status).toBe('ready');
    } finally {
      f.close();
    }
  });

  it('is deterministic: identical script and clock produce identical chunk bytes', async () => {
    const first = await openEvidenceFixture({ script: messageScript() });
    const second = await openEvidenceFixture({ script: messageScript() });
    try {
      const a = await first.recorder.record({
        request: first.request, handle: first.handle, eventIdentityPrefix: first.eventIdentityPrefix,
      });
      const b = await second.recorder.record({
        request: second.request, handle: second.handle, eventIdentityPrefix: second.eventIdentityPrefix,
      });
      const manifestA = await readManifest(first, a.manifestArtifactId);
      const manifestB = await readManifest(second, b.manifestArtifactId);
      expect(manifestA.chunks.map((c) => c.contentHash)).toEqual(manifestB.chunks.map((c) => c.contentHash));
      const linesA = await readChunkLines(first, manifestA.chunks[0]!.artifactId);
      const linesB = await readChunkLines(second, manifestB.chunks[0]!.artifactId);
      expect(linesA).toEqual(linesB);
    } finally {
      first.close();
      second.close();
    }
  });

  it('consumes events and results concurrently under a narrow Fake buffer (backpressure, no deadlock)', async () => {
    const f = await openEvidenceFixture({
      script: messageScript(),
      fakeBuffer: { maxEvents: 2, maxBytes: 4096 },
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('complete');
      expect(f.handle.inspection.highWater().events).toBeLessThanOrEqual(2);
    } finally {
      f.close();
    }
  });

  it('deduplicates replayed events by stable identity without double-counting usage', async () => {
    const f = await openEvidenceFixture({
      script: messageScript({ lifecycle: { events: { duplicate: [2, 4] } } }),
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('complete');
      expect(outcome.stats.eventsReceived).toBe(8);
      expect(outcome.stats.eventsPersisted).toBe(6);
      expect(outcome.stats.duplicatesDropped).toBe(2);
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      /* 用量事件（序列 4）重投不重复计量。 */
      expect(manifest.usage.observations.counted).toBe(2);
      expect(manifest.usage.observations.totals).toMatchObject({ inputTokens: 14, complete: true });
      const lines = await readChunkLines(f, manifest.chunks[0]!.artifactId);
      expect(lines.map((line) => line.sequence)).toEqual([1, 2, 3, 4]);
      expect(outcome.watermark).toBe(6);
    } finally {
      f.close();
    }
  });

  it('marks dropped sequences as checkable gaps while the watermark keeps advancing', async () => {
    const f = await openEvidenceFixture({
      script: messageScript({ lifecycle: { events: { drop: [2] } } }),
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('partial');
      expect(outcome.gaps).toContain('missing_sequences:2');
      expect(outcome.watermark).toBe(6);
      expect(outcome.sequenceReconciliation).toBe('match');
      const session = f.sessions.getWorkSession(f.projectId, f.sessionId);
      expect(session.recordingWatermark).toBe(6);
      expect(session.recordingGaps).toContain('missing_sequences:2');
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.coverage).toBe('partial');
      const lines = [
        await readChunkLines(f, manifest.chunks[0]!.artifactId),
        await readChunkLines(f, manifest.chunks[1]!.artifactId),
      ].flat();
      expect(lines.map((line) => line.sequence)).toEqual([1, 3, 4, 5, 6]);
    } finally {
      f.close();
    }
  });

  it('repairs adjacent reorder within the declared window', async () => {
    const f = await openEvidenceFixture({
      script: messageScript({ lifecycle: { events: { reorderAt: 2 } } }),
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('complete');
      expect(outcome.stats.eventsPersisted).toBe(6);
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      const lines = [
        await readChunkLines(f, manifest.chunks[0]!.artifactId),
        await readChunkLines(f, manifest.chunks[1]!.artifactId),
      ].flat();
      expect(lines.map((line) => line.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      f.close();
    }
  });

  it('refuses reorder beyond the declared window: gap plus bounded late diagnostic', async () => {
    const f = await openEvidenceFixture({
      script: messageScript({ lifecycle: { events: { reorderAt: 2 } } }),
      limits: { reorderWindow: 0 },
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('partial');
      expect(outcome.gaps).toContain('missing_sequences:2');
      expect(outcome.gaps).toContain('late_event_beyond_window:2');
      expect(outcome.stats.lateEvents).toBe(1);
      expect(outcome.stats.eventsPersisted).toBe(5);
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.diagnostics).toContain('late_event:2');
    } finally {
      f.close();
    }
  });

  it('keeps unknown public events as bounded diagnostics with a checkable gap', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    const injected = (async function* () {
      yield {
        schemaVersion: 1, eventId: `${f.eventIdentityPrefix}x`, kind: 'provider_internal_trace',
        sequence: 99, occurredAtUtc: new Date(EVIDENCE_NOW).toISOString(), payload: { privateTrace: 'UNEXPOSED_TRACE_BODY' },
      };
      for await (const event of f.handle.events) yield event;
    })();
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: { ...f.handle, events: injected }, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('partial');
      expect(outcome.stats.unknownEvents).toBe(1);
      expect(outcome.gaps).toContain('unknown_events:1');
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.diagnostics).toContain('unknown_event:provider_internal_trace');
      /* 未知 payload 不透传进正文。 */
      expect(JSON.stringify(manifest)).not.toContain('UNEXPOSED_TRACE_BODY');
    } finally {
      f.close();
    }
  });

  it('[case:foreign-recording] keeps foreign (old attempt/session) events out of the current watermark', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    const foreign = {
      schemaVersion: 1, eventId: 'evt.0000oldsession0000old0.1', kind: 'message', sequence: 1,
      occurredAtUtc: new Date(EVIDENCE_NOW).toISOString(),
      payload: { messageId: 'msg.old.1', role: 'assistant', preview: '旧 Attempt 消息' },
    };
    const injected = (async function* () {
      yield foreign;
      for await (const event of f.handle.events) yield event;
    })();
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: { ...f.handle, events: injected }, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('partial');
      expect(outcome.stats.foreignEvents).toBe(1);
      expect(outcome.gaps).toContain('foreign_events:1');
      expect(outcome.watermark).toBe(6);
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      const lines = [
        await readChunkLines(f, manifest.chunks[0]!.artifactId),
        await readChunkLines(f, manifest.chunks[1]!.artifactId),
      ].flat();
      /* 外来事件不进入当前记录。 */
      expect(lines.every((line) => line.eventId.startsWith(f.eventIdentityPrefix))).toBe(true);
      expect(lines).toHaveLength(6);
    } finally {
      f.close();
    }
  });

  it('flags finalEventSequence mismatch as checkable partial coverage', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    const wrapped = {
      ...f.handle,
      result: f.handle.result.then((raw) => ({
        ...(raw as object), lastEventSequence: 11,
      })),
    };
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: wrapped, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('partial');
      expect(outcome.sequenceReconciliation).toBe('mismatch');
      expect(outcome.gaps).toContain('final_sequence_mismatch:result=11,recorded=6');
    } finally {
      f.close();
    }
  });

  it('records invalid (unknown terminal) results as gaps without fabricating failure', async () => {
    const f = await openEvidenceFixture({
      script: messageScript({ lifecycle: { result: { terminalOverride: 'bogus_terminal' } } }),
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('partial');
      expect(outcome.resultStatus).toBe('invalid');
      expect(outcome.result).toBeNull();
      expect(outcome.gaps).toContain('result_invalid:unknown_terminal');
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.result).toBeNull();
      expect(manifest.coverage).toBe('partial');
    } finally {
      f.close();
    }
  });

  it('bounds the result tail wait when events end first (no indefinite wait)', async () => {
    const gate = createFakeRuntimeGate();
    const f = await openEvidenceFixture({
      script: messageScript({ lifecycle: { result: { gate: 'hold' } } }),
      gates: { hold: gate },
      limits: { tailWaitMs: 60 },
    });
    try {
      const started = Date.now();
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(outcome.status).toBe('partial');
      expect(outcome.resultStatus).toBe('tail_timeout');
      expect(outcome.gaps).toContain('result_tail_timeout');
      /* 事件证据完整持久化，结果未知如实记录。 */
      expect(outcome.watermark).toBe(6);
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.result).toBeNull();
      expect(manifest.usage.finalReported).toBeNull();
      gate.release();
    } finally {
      f.close();
    }
  });

  it('bounds the events tail wait when the result settles first (stream never closed)', async () => {
    const gate = createFakeRuntimeGate();
    const f = await openEvidenceFixture({
      script: messageScript({ lifecycle: { events: { endGate: 'hold' } } }),
      gates: { hold: gate },
      limits: { tailWaitMs: 60 },
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('partial');
      expect(outcome.gaps).toContain('events_tail_timeout');
      expect(outcome.resultStatus).toBe('settled');
      expect(outcome.result?.terminal).toBe('completed');
      gate.release();
    } finally {
      f.close();
    }
  });

  it('redacts secret literals before persistence and reports redaction in the manifest', async () => {
    const secret = 'sk-test-secret-1234567890';
    const f = await openEvidenceFixture({
      script: messageScript({
        steps: [{ op: 'message', role: 'assistant', text: `令牌是 ${secret} 请保密` }],
      }),
      secrets: [secret],
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('complete');
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.redaction).toEqual({ applied: true, secretValueCount: 1 });
      const verified = await f.verifier.readVerifiedContent(f.projectId, manifest.chunks[0]!.artifactId);
      const text = Buffer.from(verified.content).toString('utf8');
      expect(text).not.toContain(secret);
      expect(text).toContain('[REDACTED]');
    } finally {
      f.close();
    }
  });

  it('separates known synthetic usage from unknown fields without fabricating totals', async () => {
    const f = await openEvidenceFixture({
      script: messageScript({
        steps: [
          { op: 'usage', inputTokens: 10, outputTokens: 5, costUsdMicros: 100 },
          { op: 'usage', inputTokens: null, outputTokens: 2, costUsdMicros: null },
        ],
        result: {
          terminal: 'completed', reason: null, exitCode: null, signal: null, durationMs: null, usage: null,
        },
      }),
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.usage.basis).toBe('synthetic');
      expect(manifest.usage.observations.counted).toBe(2);
      /* 任一观察未知 → 该字段总量 null 且 complete=false，绝不填 0。 */
      expect(manifest.usage.observations.totals).toEqual({
        inputTokens: null, outputTokens: 7, costUsdMicros: null, complete: false,
      });
      expect(manifest.usage.finalReported).toBeNull();
    } finally {
      f.close();
    }
  });

  it('marks oversized single events as omitted gaps instead of truncating content', async () => {
    const f = await openEvidenceFixture({
      script: messageScript(),
      limits: { maxEventBodyBytes: 64 },
    });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('partial');
      expect(outcome.stats.eventsOmitted).toBeGreaterThan(0);
      expect(outcome.gaps.some((gap) => gap.startsWith('event_body_too_large:'))).toBe(true);
    } finally {
      f.close();
    }
  });

  it('stops in a controlled manner when total limits are exceeded: safe stop demand, gap, retained evidence', async () => {
    const f = await openEvidenceFixture({
      script: messageScript(),
      limits: { maxTotalEvents: 3 },
    });
    let cancelRequested = false;
    try {
      const error = await f.recorder.record({
        request: f.request, handle: { ...f.handle, cancel: () => {
          cancelRequested = true;
          return f.handle.cancel();
        } }, eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isWorkEvidenceRecordingError(error, 'total_event_limit_exceeded')).toBe(true);
      const recordingError = error as import("../../../packages/core/src/application/work-evidence-recorder.ts").WorkEvidenceRecordingError;
      expect(recordingError.safeStopRequired).toBe(true);
      /* 取消请求与已结算结果独立，不伪造 cancelled。 */
      expect(cancelRequested).toBe(true);
      /* 缺口标在 Session 上；已保存证据保留，无虚假 complete 清单。 */
      const session = f.sessions.getWorkSession(f.projectId, f.sessionId);
      expect(session.recordingGaps).toContain('recording_failed:total_event_limit_exceeded');
      expect(recordingError.manifestArtifactId).not.toBeNull();
      const manifest = await readManifest(f, recordingError.manifestArtifactId as string);
      expect(manifest.coverage).toBe('failed');
    } finally {
      f.close();
    }
  });

  it('fails required recording on injected ENOSPC and never fabricates a complete manifest', async () => {
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
      /* P07-2：ENOSPC 现在可区分为存储额度耗尽，不再是泛化发布失败。 */
      expect(isWorkEvidenceRecordingError(error, 'event_storage_exhausted')).toBe(true);
      const recordingError = error as import("../../../packages/core/src/application/work-evidence-recorder.ts").WorkEvidenceRecordingError;
      expect(recordingError.safeStopRequired).toBe(true);
      /* 诚实失败清单（coverage='failed'），无 ready/complete 假象。 */
      expect(recordingError.manifestArtifactId).not.toBeNull();
      const manifest = await readManifest(f, recordingError.manifestArtifactId as string);
      expect(manifest.coverage).toBe('failed');
      /* 失败分块索引保留为 failed，清单不引用未持久内容。 */
      const all = await f.artifacts.listArtifacts(f.projectId);
      const eventChunks = all.records.filter((record) => record.kind === WORK_EVIDENCE_EVENTS_KIND);
      expect(eventChunks.length).toBeGreaterThan(0);
      expect(eventChunks.every((record) => record.status === 'failed')).toBe(true);
      expect(manifest.chunks).toEqual([]);
      const session = f.sessions.getWorkSession(f.projectId, f.sessionId);
      expect(session.recordingGaps).toContain('recording_failed:event_storage_exhausted');
      expect(session.recordingWatermark).toBeNull();
    } finally {
      f.close();
    }
  });

  it('fails required recording on short-write (staged size mismatch)', async () => {
    let injected = false;
    const f = await openEvidenceFixture({
      script: messageScript(),
      wrapFiles: (files) => ({
        ...files,
        async finishStaging(write: Parameters<typeof files.finishStaging>[0]) {
          const staged = await files.finishStaging(write);
          if (!injected) {
            injected = true;
            return { ...staged, sizeBytes: staged.sizeBytes + 7 };
          }
          return staged;
        },
      }),
    });
    try {
      const error = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      /* P07-2：短写（size_mismatch）现在可区分为文件写入失败。 */
      expect(isWorkEvidenceRecordingError(error, 'event_file_write_failed')).toBe(true);
      const recordingError = error as import("../../../packages/core/src/application/work-evidence-recorder.ts").WorkEvidenceRecordingError;
      expect(isWorkEvidenceRecordingError(recordingError) && recordingError.safeStopRequired).toBe(true);
      const manifest = await readManifest(f, recordingError.manifestArtifactId as string);
      expect(manifest.coverage).toBe('failed');
    } finally {
      f.close();
    }
  });

  it('detects persisted body corruption through the existing integrity port', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    try {
      const outcome = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      });
      expect(outcome.status).toBe('complete');
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      const chunk = manifest.chunks[0]!;
      const absolute = join(
        f.budget.box.dataRoot,
        deriveArtifactFinalRelativePath({ projectId: f.projectId, artifactId: chunk.artifactId }),
      );
      const original = readFileSync(absolute);
      writeFileSync(absolute, Buffer.concat([Buffer.from('tampered'), original.subarray(8)]));
      /* 完整性端口：篡改后有效读取必须 corrupt 拒绝，不得返回正文。 */
      await expect(f.verifier.readVerifiedContent(f.projectId, chunk.artifactId)).rejects.toThrowError();
      const report = await f.verifier.verifyArtifact(f.projectId, chunk.artifactId);
      expect(report.kind).toBe('corrupt');
    } finally {
      f.close();
    }
  });

  it('rejects recording against a session bound to another attempt (fail-closed)', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    try {
      const foreign = {
        ...f.request,
        identity: { purpose: 'work', runId: f.runId, taskId: f.taskId, attemptId: 'attempt-elsewhere' },
      };
      const error = await f.recorder.record({
        request: foreign, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isWorkEvidenceRecordingError(error, 'session_mismatch')).toBe(true);
    } finally {
      f.close();
    }
  });

  it('aborts bounded via AbortSignal: retained evidence, gap marked, no stop demand', async () => {
    const gate = createFakeRuntimeGate();
    const controller = new AbortController();
    const f = await openEvidenceFixture({
      script: messageScript({
        steps: [
          { op: 'message', role: 'assistant', text: '先行事件' },
          { op: 'await_gate', name: 'hold' },
          { op: 'message', role: 'assistant', text: '不会到达' },
        ],
      }),
      gates: { hold: gate },
    });
    try {
      const timer = setTimeout(() => controller.abort(), 40);
      const error = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
        signal: controller.signal,
      }).then(() => null, (cause: unknown) => cause);
      clearTimeout(timer);
      expect(isWorkEvidenceRecordingError(error, 'aborted')).toBe(true);
      const recordingError = error as import("../../../packages/core/src/application/work-evidence-recorder.ts").WorkEvidenceRecordingError;
      expect(recordingError.safeStopRequired).toBe(false);
      const session = f.sessions.getWorkSession(f.projectId, f.sessionId);
      expect(session.recordingGaps).toContain('recording_failed:aborted');
      gate.release();
    } finally {
      f.close();
    }
  });

  it('keeps recorder free of adapter/SDK/database dependencies (source structure)', () => {
    const application = readFileSync(
      join(repoRoot, 'packages/core/src/application/work-evidence-recorder.ts'), 'utf8',
    );
    expect(application).not.toMatch(/from\s+['"][^'"]*adapters\//);
    expect(application).not.toMatch(/node:(fs|sqlite|http|net|child_process)/);
    expect(application).not.toMatch(/better-sqlite3|drizzle/);
    /* 无 Task 验收语义：不出现 passed 赋值/属性（注释中的说明性提及除外）。 */
    expect(application).not.toMatch(/\bpassed\s*[:=]/);
    const contract = readFileSync(
      join(repoRoot, 'packages/core/src/ports/work-evidence-recorder.ts'), 'utf8',
    );
    expect(contract).not.toMatch(/node:(fs|sqlite|http|net|child_process|crypto)/);
    expect(contract).not.toMatch(/better-sqlite3|drizzle/);
  });

  it('never exceeds chunk byte bounds and advances watermarks only after ready integrity checks', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    try {
      const checked = new Set<string>();
      const recorder = createWorkEvidenceRecorder({
        publisher: f.publisher,
        verifier: {
          async verifyArtifact(projectId, artifactId) {
            const report = await f.verifier.verifyArtifact(projectId, artifactId);
            checked.add(artifactId);
            return report;
          },
        },
        sessions: {
          ...f.sessions,
          applyWorkSessionProgress(input) {
            const progress = input as { recordingWatermark?: number | null };
            if (progress.recordingWatermark != null) {
              const rows = f.budget.session.database.prepare(
                "SELECT id, status FROM artifacts WHERE kind = 'work-evidence-events'",
              ).all() as { id: string; status: string }[];
              expect(rows.length).toBeGreaterThan(0);
              expect(rows.every((row) => row.status === 'ready' && checked.has(row.id))).toBe(true);
            }
            return f.sessions.applyWorkSessionProgress(input);
          },
        },
        limits: { ...DEFAULT_RECORDER_LIMITS, chunkMaxBytes: 500 },
      });
      const outcome = await recorder.record({ request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix });
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      expect(manifest.chunks.length).toBeGreaterThan(2);
      expect(manifest.chunks.every((chunk) => chunk.sizeBytes <= 500)).toBe(true);
      expect(manifest.stats.eventsPersisted).toBe(6);
    } finally { f.close(); }
  });

  it('keeps the watermark at the last stored event when the final large event is omitted', async () => {
    const f = await openEvidenceFixture({
      script: messageScript({ steps: [
        { op: 'message', role: 'assistant', text: 'small' },
        { op: 'message', role: 'assistant', text: 'x'.repeat(180) },
      ] }),
      limits: { maxEventBodyBytes: 320 },
    });
    try {
      const outcome = await f.recorder.record({ request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix });
      expect(outcome.status).toBe('partial');
      expect(outcome.watermark).toBe(1);
      expect(outcome.sequenceReconciliation).toBe('mismatch');
      expect(f.sessions.getWorkSession(f.projectId, f.sessionId).recordingWatermark).toBe(1);
    } finally { f.close(); }
  });

  it('rejects corruption introduced during publication before advancing the watermark', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    try {
      const recorder = createWorkEvidenceRecorder({
        publisher: {
          async publishArtifact(input) {
            const published = await f.publisher.publishArtifact(input);
            if (published.artifact.kind === WORK_EVIDENCE_EVENTS_KIND) {
              writeFileSync(join(f.budget.box.dataRoot, published.finalRelativePath), 'corrupt');
            }
            return published;
          },
        },
        verifier: f.verifier, sessions: f.sessions, limits: DEFAULT_RECORDER_LIMITS,
      });
      const error = await recorder.record({ request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix })
        .then(() => null, (error: unknown) => error);
      expect(isWorkEvidenceRecordingError(error, 'event_publish_failed')).toBe(true);
      expect(f.sessions.getWorkSession(f.projectId, f.sessionId).recordingWatermark).toBeNull();
      if (!isWorkEvidenceRecordingError(error)) throw error;
      expect(error.safeStopRequired).toBe(true);
      const manifest = await readManifest(f, error.manifestArtifactId!);
      expect(manifest.coverage).toBe('failed');
      expect(manifest.chunks).toEqual([]);
      expect(manifest.stats.eventsPersisted).toBe(0);
    } finally { f.close(); }
  });

  it('retains the first verified chunk when the second publication fails and cancellation hangs', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    try {
      let count = 0;
      const recorder = createWorkEvidenceRecorder({
        publisher: {
          async publishArtifact(input) {
            if ((input as { kind: string }).kind === WORK_EVIDENCE_EVENTS_KIND && ++count === 2) {
              throw new Error('injected publication failure');
            }
            return f.publisher.publishArtifact(input);
          },
        },
        verifier: f.verifier, sessions: f.sessions, limits: DEFAULT_RECORDER_LIMITS,
      });
      const error = await recorder.record({ request: f.request,
        handle: { ...f.handle, cancel: () => new Promise(() => {}) }, eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (error: unknown) => error);
      if (!isWorkEvidenceRecordingError(error)) throw new Error('expected recording failure');
      expect(error.safeStopRequired).toBe(true);
      expect(error.watermark).toBe(4);
      const manifest = await readManifest(f, error.manifestArtifactId!);
      expect(manifest.coverage).toBe('failed');
      expect(manifest.chunks).toHaveLength(1);
      expect(manifest.stats.eventsPersisted).toBe(4);
      expect(await readChunkLines(f, manifest.chunks[0]!.artifactId)).toHaveLength(4);
    } finally { f.close(); }
  }, 5000);

  it('redacts escaped literals and authorization headers without breaking NDJSON', async () => {
    const secret = 'secret"quoted\\value';
    const f = await openEvidenceFixture({ script: messageScript({ steps: [
      { op: 'message', role: 'assistant', text: `${secret}\nAuthorization: Bearer sensitive-header` },
    ] }), secrets: [secret] });
    try {
      const outcome = await f.recorder.record({ request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix });
      const manifest = await readManifest(f, outcome.manifestArtifactId);
      const lines = await readChunkLines(f, manifest.chunks[0]!.artifactId);
      expect(JSON.stringify(lines)).not.toContain('quoted');
      expect(JSON.stringify(lines)).not.toContain('sensitive-header');
      expect(lines[0]!.payload.kind).toBe('message');
    } finally { f.close(); }
  });

  it('exposes the recorder contract through the package entry', async () => {
    const entry = await import("../../../packages/core/src/index.ts");
    expect(typeof entry.createWorkEvidenceRecorder).toBe('function');
    expect(typeof entry.validateWorkEvidenceManifest).toBe('function');
    expect(entry.WORK_EVIDENCE_MANIFEST_KIND).toBe('work-evidence-manifest');
  });

  it('rejects invalid assembly and input shapes before any side effect', async () => {
    const f = await openEvidenceFixture({ script: messageScript() });
    try {
      expect(() => createWorkEvidenceRecorder({
        publisher: f.publisher, verifier: f.verifier, sessions: f.sessions, limits: { ...DEFAULT_RECORDER_LIMITS, tailWaitMs: 0 },
      })).toThrowError();
      const bad = await f.recorder.record({
        request: { ...f.request, limits: { timeoutMs: 60_000, maxEvents: 0, maxOutputBytes: 100 } },
        handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix,
      }).then(() => null, (cause: unknown) => cause);
      expect(isStorageError(bad, 'validation')).toBe(true);
      const badPrefix = await f.recorder.record({
        request: f.request, handle: f.handle, eventIdentityPrefix: 'bad prefix!',
      }).then(() => null, (cause: unknown) => cause);
      expect(isStorageError(badPrefix, 'validation')).toBe(true);
    } finally {
      f.close();
    }
  });
});
