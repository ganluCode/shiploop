/**
 * P07-2 / F-004 一次记录的累计磁盘额度与磁盘写入失败的可信前缀。
 *
 * 覆盖（验收标准）：
 * 1. 同一记录的事件分块、公开消息/工具正文、附件与 Manifest 共享一个明确的
 *    累计磁盘额度；重复存储按各自写入计量；失败重试/切分块不重新获得额度；
 *    单次 publishBody 的局部上限不是会话总上限。
 * 2. 写入前申请额度、写入中核对实测字节；并发发布竞争同一额度不超售；失败、
 *    短写与 staging 残留的已写字节有可核对口径；保留有限收尾额度；额度不足
 *    时停止新增正文。
 * 3. 精确达到额度时正常提交已完整内容；下一字节/附件/块超限标明存储额度原因；
 *    required 不可成为完整成功；测试读取临时目录文件与索引核对实际字节、
 *    ready/hash 与水位，不只断言内存计数。
 * 4. 在真实临时文件发布链的打开、写入、同步/关闭与发布边界注入 ENOSPC、权限
 *    错误或短写；保留 ready 前缀与未完成残留；未完整落盘批次不推进水位；不
 *    覆盖代码、现有文件或旧 Manifest。
 * 5. 优先在收尾额度内发布失败 Manifest；Manifest 无法落盘时经现有 SQLite 元
 *    数据保存缺口、最后可信水位与空 manifestRef；数据库也无法写入时向监督层
 *    传播证据未持久化，不伪造引用、complete 或成功。
 *
 * 磁盘失败一律使用受控端口注入（ENOSPC/权限/短写），不耗尽宿主磁盘。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordingMode, WorkEvidenceRecorderDeps } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { createWorkEvidenceRecorder, isWorkEvidenceRecordingError } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import type { WorkEvidenceRecordingError } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import {
  createWorkRecordingStorageBudget,
  workRecordingFinalizationReserve,
} from '../../../packages/core/src/application/work-recording-budget.ts';
import type { WorkRecordingStorageBudgetUsage } from '../../../packages/core/src/application/work-recording-budget.ts';
import { createWorkRecordingPublisher } from '../../../packages/core/src/application/work-recording-publish.ts';
import { createWorkRecordingProjection } from '../../../packages/core/src/application/work-recording-projection.ts';
import { createSqliteWorkRecordingStore } from '../../../packages/core/src/adapters/sqlite/work-recording-store.ts';
import type { WorkRecordingStore } from '../../../packages/core/src/ports/work-recording-store.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import type { ArtifactFileStore } from '../../../packages/core/src/ports/artifact-files.ts';
import { ArtifactFileError } from '../../../packages/core/src/ports/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import type { ArtifactPublishResult, ArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';
import { openBindingFixture, BINDING_NOW as NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import type { RuntimeHandle } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { WorkEvidenceRecorderLimits } from '../../../packages/core/src/ports/work-evidence-recorder.ts';
import { Writable } from 'node:stream';

const OCCURRED = '2026-10-29T00:00:00.000Z';
const PUBLISH_LIMITS = { maxBodyBytes: 65_536, maxAttachmentBytes: 65_536, maxTotalBytes: 131_072, maxChunkBytes: 8192, maxQueueBytes: 8192 };

/* ------------------------------------------------------------------ *
 * 纯单元：累计磁盘额度账本
 * ------------------------------------------------------------------ */

describe('P07-2 F-004 累计磁盘额度账本（纯单元）', () => {
  it('[case:budget-claim-settle] 写入前申请、写入中核对实测字节、失败不退还、超售防御', () => {
    const budget = createWorkRecordingStorageBudget({ limitBytes: 1000, finalizationReserveBytes: 200 });
    /* 正文额度 = 1000 − 200 = 800：精确达界通过，下一字节拒绝。 */
    expect(budget.claim('body', 800)).toBe(800);
    expect(budget.claim('body', 1)).toBe(0);
    expect(budget.claimExact('body', 1)).toBe(false);
    /* 写入完成：核对实测字节（ready 尺寸）；账目 written/failed/inFlight 可核对。 */
    budget.settle('body', 800, 800, false);
    let usage = budget.usage();
    expect(usage).toMatchObject({ limitBytes: 1000, finalizationReserveBytes: 200, claimedBytes: 800, writtenBytes: 800, failedWriteBytes: 0, inFlightBytes: 0, availableBodyBytes: 0 });
    /* 失败重试不重新获得额度：收尾额度内再申请，失败结算后也不退还正文额度。 */
    expect(budget.claim('finalization', 200)).toBe(200);
    budget.settle('finalization', 200, 0, true);
    usage = budget.usage();
    expect(usage.failedWriteBytes).toBe(200);
    expect(usage.availableFinalizationBytes).toBe(0);
    expect(budget.claim('body', 1)).toBe(0);
    expect(budget.claim('finalization', 1)).toBe(0);
  });

  it('[case:budget-streaming-partial-grant] 流式部分授予只发放可用前缀，claimExact 全有或全无', () => {
    const budget = createWorkRecordingStorageBudget({ limitBytes: 100, finalizationReserveBytes: 20 });
    expect(budget.claim('body', 60)).toBe(60);
    /* 只剩 20：流式申请 50 授予 20；全有或全无申请 50 拒绝且不消耗。 */
    expect(budget.claim('body', 50)).toBe(20);
    expect(budget.claimExact('body', 1)).toBe(false);
    const usage = budget.usage();
    expect(usage.claimedBytes).toBe(80);
    expect(usage.availableBodyBytes).toBe(0);
    /* 收尾额度仍可用（正文未侵占保留额度）。 */
    expect(budget.claimExact('finalization', 20)).toBe(true);
    expect(budget.claim('finalization', 1)).toBe(0);
  });

  it('[case:budget-concurrent-no-oversell] 并发发布交错竞争同一额度不超售', () => {
    const budget = createWorkRecordingStorageBudget({ limitBytes: 1000, finalizationReserveBytes: 250 });
    /* 两个“发布者”交错申请：总额度 750 被瓜分后不超售。 */
    const grants: number[] = [];
    let a = 0;
    let b = 0;
    for (let round = 0; round < 100; round += 1) {
      const ga = budget.claim('body', 10);
      a += ga;
      const gb = budget.claim('body', 10);
      b += gb;
      if (ga + gb === 0) break;
    }
    grants.push(a, b);
    expect(a + b).toBe(750);
    const usage = budget.usage();
    expect(usage.claimedBytes).toBe(750);
    expect(usage.availableBodyBytes).toBe(0);
    /* 各自按实测字节结算：一成一败，账目分开可核对。 */
    budget.settle('body', a, a, false);
    budget.settle('body', b, 0, true);
    expect(budget.usage()).toMatchObject({ writtenBytes: a, failedWriteBytes: b, inFlightBytes: 0 });
  });

  it('[case:budget-oversold-guard] 实测字节超过申请时如实记为超售并继续扣减', () => {
    const budget = createWorkRecordingStorageBudget({ limitBytes: 100, finalizationReserveBytes: 10 });
    budget.claim('body', 60);
    budget.settle('body', 60, 70, false);
    const usage = budget.usage();
    expect(usage.oversoldBytes).toBe(10);
    expect(usage.claimedBytes).toBe(70);
    expect(usage.availableBodyBytes).toBe(100 - 10 - 70);
  });

  it('[case:budget-reserve-derivation] 收尾保留额度有限且不超过总额度', () => {
    expect(workRecordingFinalizationReserve(8_000_000, 262_144)).toBe(262_144);
    expect(workRecordingFinalizationReserve(1000, 262_144)).toBe(250);
    expect(workRecordingFinalizationReserve(3, 262_144)).toBe(0);
    expect(() => createWorkRecordingStorageBudget({ limitBytes: 0, finalizationReserveBytes: 0 })).toThrow();
    expect(() => createWorkRecordingStorageBudget({ limitBytes: 100, finalizationReserveBytes: 101 })).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 发布器会话级额度（不新增局部上限语义）
 * ------------------------------------------------------------------ */

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function fakeArtifactPublisher(): { publisher: ArtifactPublisher; published: string[] } {
  const published: string[] = [];
  return {
    published,
    publisher: {
      async publishArtifact(input: unknown): Promise<ArtifactPublishResult> {
        const value = input as { expectedHash: string; projectId: string; kind: string; mediaType: string; locator: string; content: AsyncIterable<Uint8Array> };
        const chunks: Uint8Array[] = [];
        for await (const chunk of value.content) chunks.push(chunk);
        const content = Buffer.concat(chunks);
        published.push(content.toString('utf8'));
        return {
          artifact: {
            id: `artifact-${published.length}`, projectId: value.projectId, kind: value.kind, mediaType: value.mediaType,
            status: 'ready', expectedHash: value.expectedHash, contentHash: digestOf(content.toString('utf8')),
            sizeBytes: content.byteLength, locator: value.locator, version: 1, failureReason: null, revision: 2,
            createdAtUtcMs: 1, updatedAtUtcMs: 1,
          },
          finalRelativePath: `artifacts/${published.length}`,
        };
      },
    },
  };
}

describe('P07-2 F-004 发布器会话级累计额度', () => {
  it('[case:publisher-shared-quota] 多条消息共享会话额度：截断/拒绝标记 session_storage_quota，局部上限仍独立生效', async () => {
    const fake = fakeArtifactPublisher();
    const publisher = createWorkRecordingPublisher({ artifacts: fake.publisher, limits: PUBLISH_LIMITS });
    const budget = createWorkRecordingStorageBudget({ limitBytes: 260, finalizationReserveBytes: 60 });
    /* 第一条消息正文 120B：完整发布并计量。 */
    const first = await publisher.publishBody({
      projectId: 'project-1', kind: 'message', mediaType: 'text/plain',
      locator: 'work/sessions/s1/messages/1/body', expectedHash: digestOf('a'.repeat(120)),
      content: [Buffer.from('a'.repeat(120))], budget,
    });
    expect(first.status).toBe('complete');
    expect(first.retainedBytes).toBe(120);
    /* 第二条消息剩余正文额度 80：截断到 80 并标记存储额度原因。 */
    const second = await publisher.publishBody({
      projectId: 'project-1', kind: 'message', mediaType: 'text/plain',
      locator: 'work/sessions/s1/messages/2/body', expectedHash: digestOf('b'.repeat(80)),
      content: [Buffer.from('b'.repeat(200))], budget,
    });
    expect(second.status).toBe('truncated');
    expect(second.retainedBytes).toBe(80);
    expect(second.gapReasons).toContain('session_storage_quota');
    expect(fake.published[1]).toBe('b'.repeat(80));
    /* 第三条消息一点额度都没有：不发布空正文，直接不可用。 */
    const third = await publisher.publishBody({
      projectId: 'project-1', kind: 'message', mediaType: 'text/plain',
      locator: 'work/sessions/s1/messages/3/body', expectedHash: digestOf('c'),
      content: [Buffer.from('c')], budget,
    });
    expect(third.status).toBe('unavailable');
    expect(third.ref).toBeNull();
    expect(third.gapReasons).toContain('session_storage_quota');
    expect(fake.published).toHaveLength(2);
    /* 局部上限仍独立生效（会话额度富余时单正文超局部上限截断）。 */
    const roomy = createWorkRecordingPublisher({ artifacts: fake.publisher, limits: { ...PUBLISH_LIMITS, maxBodyBytes: 5 } });
    const local = await roomy.publishBody({
      projectId: 'project-1', kind: 'stdout', mediaType: 'text/plain',
      locator: 'work/sessions/s1/stdout', expectedHash: digestOf('01234'),
      content: [Buffer.from('0123456789')],
      budget: createWorkRecordingStorageBudget({ limitBytes: 4096, finalizationReserveBytes: 16 }),
    });
    expect(local.status).toBe('truncated');
    expect(local.gapReasons).toContain('body_limit');
    expect(local.gapReasons).not.toContain('session_storage_quota');
  });

  it('[case:publisher-failed-write-no-refund] 失败写入消耗额度且不退还，后续发布按剩余额度执行', async () => {
    let calls = 0;
    const failing: ArtifactPublisher = {
      async publishArtifact(input: unknown): Promise<ArtifactPublishResult> {
        calls += 1;
        /* 先消费内容流（真实发布链会先接收字节），再注入发布失败。 */
        const value = input as { projectId: string; kind: string; mediaType: string; expectedHash: string;
          locator: string; content: AsyncIterable<Uint8Array> };
        const chunks: Uint8Array[] = [];
        for await (const chunk of value.content) chunks.push(chunk);
        const content = Buffer.concat(chunks);
        if (calls === 1) throw new Error('injected publication failure');
        return {
          artifact: {
            id: `artifact-${calls}`, projectId: value.projectId, kind: value.kind, mediaType: value.mediaType,
            status: 'ready', expectedHash: value.expectedHash, contentHash: digestOf(content.toString('utf8')),
            sizeBytes: content.byteLength, locator: value.locator, version: 1, failureReason: null, revision: 2,
            createdAtUtcMs: 1, updatedAtUtcMs: 1,
          },
          finalRelativePath: `artifacts/${calls}`,
        };
      },
    };
    const publisher = createWorkRecordingPublisher({ artifacts: failing, limits: PUBLISH_LIMITS });
    const budget = createWorkRecordingStorageBudget({ limitBytes: 200, finalizationReserveBytes: 0 });
    const failed = await publisher.publishBody({
      projectId: 'project-1', kind: 'message', mediaType: 'text/plain',
      locator: 'work/sessions/s1/messages/1/body', expectedHash: digestOf('y'.repeat(100)),
      content: [Buffer.from('y'.repeat(100))], budget,
    });
    expect(failed.status).toBe('unavailable');
    expect(budget.usage().failedWriteBytes).toBe(100);
    expect(budget.usage().availableBodyBytes).toBe(100);
    /* 失败的 100B 不因重试归还：后续正文只剩 100。 */
    const next = await publisher.publishBody({
      projectId: 'project-1', kind: 'message', mediaType: 'text/plain',
      locator: 'work/sessions/s1/messages/2/body', expectedHash: digestOf('z'.repeat(100)),
      content: [Buffer.from('z'.repeat(150))], budget,
    });
    expect(next.status).toBe('truncated');
    expect(next.retainedBytes).toBe(100);
    expect(budget.usage().writtenBytes).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * 真实记录链（recorder + projection + SQLite + 临时文件）
 * ------------------------------------------------------------------ */

interface BudgetFixtureOptions {
  readonly mode?: RecordingMode;
  readonly recorderLimits?: Partial<WorkEvidenceRecorderLimits>;
  readonly wrapFiles?: (files: ArtifactFileStore) => ArtifactFileStore;
  readonly wrapRecordingStore?: (store: WorkRecordingStore) => WorkRecordingStore;
  /** 缺省 true：接公开正文投影（消息/工具正文也计量）。 */
  readonly withProjection?: boolean;
}

interface BudgetFixture {
  readonly projectId: string;
  readonly sessionId: string;
  readonly request: import('../../../packages/core/src/ports/runtime-execution.ts').RuntimeExecutionRequest;
  readonly sessions: ReturnType<typeof createSqliteWorkSessionStore>;
  readonly store: WorkRecordingStore;
  readonly recorder: ReturnType<typeof createWorkEvidenceRecorder>;
  readonly verifier: ReturnType<typeof createArtifactVerifier>;
  readonly limits: WorkEvidenceRecorderLimits;
  readonly dataRoot: string;
  readonly query: (sql: string, ...params: unknown[]) => unknown;
  readonly all: (sql: string, ...params: unknown[]) => unknown[];
  close(): void;
}

async function openBudgetFixture(options: BudgetFixtureOptions = {}): Promise<BudgetFixture> {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  try {
    const launch = f.claimAndLaunch('t-1');
    const { request } = await f.bindingService.bind(f.bindingInput(launch));
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
    const identity = { projectId: f.projectId, sessionId: request.sessionId, attemptId: launch.receipt.attempt.id,
      owner: request.owner.principalId, hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion };
    const created = sessions.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'budget-f004' });
    sessions.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });
    const rawStore = createSqliteWorkRecordingStore(f.session, { nowUtcMs: () => NOW });
    const store = options.wrapRecordingStore === undefined ? rawStore : options.wrapRecordingStore(rawStore);
    const rawFiles = createArtifactFileStore({ dataRoot: f.box.dataRoot });
    const files = options.wrapFiles === undefined ? rawFiles : options.wrapFiles(rawFiles);
    const publisher = createArtifactPublisher({ artifacts: f.artifacts, files, limits: { maxSizeBytes: 4_000_000, timeoutMs: 5_000 }, nowMs: () => NOW });
    const verifier = createArtifactVerifier({ artifacts: f.artifacts, files: rawFiles, limits: { maxReadBytes: 4_000_000 }, nowMs: () => NOW });
    const limits: WorkEvidenceRecorderLimits = { ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: 2, tailWaitMs: 200, ...options.recorderLimits };
    const deps: WorkEvidenceRecorderDeps = {
      publisher, verifier, sessions, recordingMode: options.mode ?? 'required', limits,
      ...(options.withProjection === false ? {} : {
        recording: { publisher: createWorkRecordingPublisher({ artifacts: publisher, limits: PUBLISH_LIMITS }), store, nowUtcMs: () => NOW },
      }),
    };
    return {
      projectId: f.projectId, sessionId: request.sessionId, request, sessions, store,
      recorder: createWorkEvidenceRecorder(deps), verifier, limits, dataRoot: f.box.dataRoot,
      query: (sql, ...params) => f.session.database.prepare(sql).get(...params as never[]),
      all: (sql, ...params) => f.session.database.prepare(sql).all(...params as never[]),
      close: () => f.close(),
    };
  } catch (error) {
    f.close();
    throw error;
  }
}

function messageEvent(prefix: string, sequence: number, text: string): Record<string, unknown> {
  return { schemaVersion: 1, eventId: `${prefix}${sequence}`, sequence, kind: 'message', occurredAtUtc: OCCURRED,
    payload: { messageId: `m-${sequence}`, role: 'assistant', preview: `消息-${sequence}`, text } };
}

function craftedHandle(events: readonly Record<string, unknown>[], options: { lastEventSequence?: number } = {}): RuntimeHandle {
  const last = options.lastEventSequence ?? events.length;
  return {
    events: { async *[Symbol.asyncIterator]() { yield* events as never[]; } },
    result: Promise.resolve({ schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
      durationMs: 1, usage: null, lastEventSequence: last }),
    stopped: Promise.resolve({ schemaVersion: 1, confirmed: true, checkedAtUtc: OCCURRED, detail: null }),
    cancel: async () => ({ accepted: true, reason: null }),
  } as unknown as RuntimeHandle;
}

/** 记录器将序列化出的 ndjson 行字节（含结尾换行；payload 为验证后的公开形状，含 kind）。 */
function lineBytes(event: Record<string, unknown>): number {
  const payload = { kind: event.kind, ...(event.payload as Record<string, unknown>) };
  return Buffer.byteLength(`${JSON.stringify({
    v: 1, sequence: event.sequence, eventId: event.eventId, kind: event.kind, occurredAtUtc: event.occurredAtUtc,
    payload,
  })}\n`, 'utf8');
}

/** 投影将序列化出的公开正文字节（同一验证后的 payload 形状）。 */
function bodyBytes(event: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify({ kind: event.kind, ...(event.payload as Record<string, unknown>) }), 'utf8');
}

/** 正文总额度恰好等于 cap 的最小总额度（保留额度 = min(chunkMaxBytes, floor(L/4))）。 */
function limitForBodyCap(cap: number, chunkMaxBytes: number): number {
  const capOf = (limitBytes: number): number => limitBytes - workRecordingFinalizationReserve(limitBytes, chunkMaxBytes);
  let limitBytes = Math.max(1, cap);
  while (capOf(limitBytes) < cap) limitBytes += 1;
  if (capOf(limitBytes) !== cap) throw new Error(`cap ${cap} 不可达`);
  return limitBytes;
}

function recordingError(error: unknown): WorkEvidenceRecordingError {
  if (!isWorkEvidenceRecordingError(error)) throw new Error(`期望 WorkEvidenceRecordingError，得到 ${String(error)}`);
  return error;
}

interface RecordingArtifactRow {
  readonly id: string; readonly kind: string; readonly status: string;
  readonly content_hash: string | null; readonly size_bytes: number | null; readonly storage_locator: string;
}

/** 真实磁盘核对：本记录相关 ready 制品的文件字节与 sha256、与索引行一致。 */
function verifyRecordingFilesOnDisk(f: BudgetFixture, usage: WorkRecordingStorageBudgetUsage): RecordingArtifactRow[] {
  const rows = f.all('SELECT id, kind, status, content_hash, size_bytes, storage_locator FROM artifacts WHERE kind IN (\'message\', \'work-evidence-events\', \'work-evidence-manifest\')') as RecordingArtifactRow[];
  let readyBytes = 0;
  for (const row of rows.filter(candidate => candidate.status === 'ready')) {
    const path = join(f.dataRoot, 'projects', f.projectId, 'artifacts', row.id, 'content');
    const stat = statSync(path);
    expect(stat.size, `${row.kind} ${row.id} 文件字节与索引一致`).toBe(row.size_bytes);
    expect(createHash('sha256').update(readFileSync(path)).digest('hex'), `${row.kind} ${row.id} 文件 hash 与索引一致`).toBe(row.content_hash);
    readyBytes += stat.size;
  }
  expect(readyBytes, '磁盘 ready 字节 == 账目 writtenBytes').toBe(usage.writtenBytes);
  expect(usage.claimedBytes, '累计申请 == 已写 + 失败 + 在途').toBe(usage.writtenBytes + usage.failedWriteBytes + usage.inFlightBytes);
  expect(usage.claimedBytes).toBeLessThanOrEqual(usage.limitBytes);
  return rows;
}

describe('P07-2 F-004 真实记录链累计额度', () => {
  it('[case:cumulative-disk-scope] 事件分块+公开正文+Manifest 共享额度，与磁盘实测一致', async () => {
    const f = await openBudgetFixture();
    try {
      const events = [1, 2, 3, 4].map(seq => messageEvent('evt.budget.', seq, `正文-${seq}-${'x'.repeat(200)}`));
      const outcome = await f.recorder.record({ request: f.request, handle: craftedHandle(events), eventIdentityPrefix: 'evt.budget.' });
      expect(outcome.status).toBe('complete');
      const usage = outcome.storageBudget;
      expect(usage).toBeDefined();
      const rows = verifyRecordingFilesOnDisk(f, usage!);
      /* 正文（message 正文 + 事件分块）与 Manifest 都计入了同一累计额度。 */
      expect(rows.filter(row => row.status === 'ready' && row.kind === 'message')).toHaveLength(4);
      expect(rows.filter(row => row.status === 'ready' && row.kind === 'work-evidence-events')).toHaveLength(2);
      expect(rows.filter(row => row.status === 'ready' && row.kind === 'work-evidence-manifest')).toHaveLength(1);
      const bodyKinds = rows.filter(row => row.status === 'ready' && row.kind !== 'work-evidence-manifest')
        .reduce((sum, row) => sum + (row.size_bytes ?? 0), 0);
      expect(usage!.writtenBytes).toBeGreaterThan(bodyKinds);
      /* 清单诊断携带可核对的额度账目（清单自身的收尾字节在其后申请）。 */
      const manifest = JSON.parse(Buffer.from((await f.verifier.readVerifiedContent(f.projectId, outcome.manifestArtifactId)).content).toString('utf8')) as { diagnostics: string[] };
      const budgetLine = manifest.diagnostics.find(entry => entry.startsWith('storage_budget:'));
      expect(budgetLine).toBeDefined();
      const lineClaimed = Number((budgetLine!.match(/claimed=(\d+)/) ?? [])[1]);
      const manifestRow = f.query('SELECT size_bytes FROM artifacts WHERE id = ?', outcome.manifestArtifactId) as { size_bytes: number };
      expect(lineClaimed + manifestRow.size_bytes).toBe(usage!.claimedBytes);
      /* 水位与索引一致。 */
      expect(f.query('SELECT recording_watermark AS w FROM sessions WHERE id = ?', f.sessionId)).toEqual({ w: 4 });
      const indexed = f.store.getLatestManifest(f.projectId, f.sessionId);
      expect(indexed).toMatchObject({ coverage: 'complete', watermark: 4, finalized: true });
    } finally {
      f.close();
    }
  });

  it('[case:exact-body-cap] 精确达到正文额度正常提交完整内容；下一字节标明存储额度原因且 required 不完整成功', async () => {
    const events = [1, 2].map(seq => messageEvent('evt.budget.', seq, `正文-${seq}-${'y'.repeat(2400)}`));
    const cap = lineBytes(events[0]!) + lineBytes(events[1]!) + bodyBytes(events[0]!) + bodyBytes(events[1]!);
    const chunkMaxBytes = 8192;
    const limitBytes = limitForBodyCap(cap, chunkMaxBytes);
    /* 精确达界：两条正文 + 两个消息体恰好用满正文额度，正常提交完整内容。 */
    const exact = await openBudgetFixture({ recorderLimits: { maxEventBodyBytes: 4096, chunkMaxBytes, maxTotalBytes: limitBytes } });
    try {
      const outcome = await exact.recorder.record({ request: exact.request, handle: craftedHandle(events), eventIdentityPrefix: 'evt.budget.' });
      expect(outcome.status).toBe('complete');
      expect(outcome.watermark).toBe(2);
      /* 全部正文（行 + 消息体）恰好等于正文额度；Manifest 由收尾额度支付。 */
      expect(outcome.storageBudget!.bodyClaimedBytes).toBe(cap);
      const manifestRow = exact.query('SELECT size_bytes FROM artifacts WHERE id = ?', outcome.manifestArtifactId) as { size_bytes: number };
      expect(outcome.storageBudget!.claimedBytes).toBe(cap + manifestRow.size_bytes);
      verifyRecordingFilesOnDisk(exact, outcome.storageBudget!);
    } finally {
      exact.close();
    }
    /* 下一字节：正文额度少 1，第 2 个消息体无法全额申请 → 存储额度原因。 */
    const over = await openBudgetFixture({ recorderLimits: { maxEventBodyBytes: 4096, chunkMaxBytes, maxTotalBytes: limitForBodyCap(cap - 1, chunkMaxBytes) } });
    try {
      const error = recordingError(await over.recorder.record({ request: over.request, handle: craftedHandle(events), eventIdentityPrefix: 'evt.budget.' }).then(() => null as never, (cause: unknown) => cause));
      expect(error.reason).toBe('event_publish_failed');
      expect(error.gaps).toContain('session_storage_quota');
      expect(error.gaps).toContain('recording_failed:event_publish_failed');
      expect(error.safeStopRequired).toBe(true);
      /* 第 1 个消息体已 ready（保留前缀）；未完整落盘批次不推进水位。 */
      const session = over.sessions.getWorkSession(over.projectId, over.sessionId);
      expect(session.recordingWatermark).toBeNull();
      expect(over.all('SELECT COUNT(*) AS n FROM session_messages')).toEqual([{ n: 0 }]);
      const usage = error.storageBudget!;
      expect(usage.writtenBytes).toBeGreaterThan(0);
      verifyRecordingFilesOnDisk(over, usage);
    } finally {
      over.close();
    }
  });

  it('[case:quota-stop-mid-recording] 额度不足时停止新增正文：已完整批次保留，后续批次不再写入', async () => {
    const events = [1, 2, 3, 4].map(seq => messageEvent('evt.budget.', seq, `正文-${seq}-${'z'.repeat(1100)}`));
    const firstBatch = lineBytes(events[0]!) + lineBytes(events[1]!) + bodyBytes(events[0]!) + bodyBytes(events[1]!);
    const secondLines = lineBytes(events[2]!) + lineBytes(events[3]!);
    const cap = firstBatch + secondLines + Math.floor(bodyBytes(events[2]!) / 2);
    const chunkMaxBytes = 8192;
    const f = await openBudgetFixture({ recorderLimits: { maxEventBodyBytes: 4096, chunkMaxBytes, maxTotalBytes: limitForBodyCap(cap, chunkMaxBytes) } });
    try {
      const error = recordingError(await f.recorder.record({ request: f.request, handle: craftedHandle(events), eventIdentityPrefix: 'evt.budget.' }).then(() => null as never, (cause: unknown) => cause));
      expect(error.gaps).toContain('session_storage_quota');
      /* 第一批次完整落盘并推进水位；第二批次未完整落盘不推进。 */
      expect(error.watermark).toBe(2);
      expect(f.query('SELECT recording_watermark AS w FROM sessions WHERE id = ?', f.sessionId)).toEqual({ w: 2 });
      expect(f.all('SELECT sequence FROM session_messages ORDER BY sequence').map(row => (row as { sequence: number }).sequence)).toEqual([1, 2]);
      const indexed = f.store.getLatestManifest(f.projectId, f.sessionId);
      expect(indexed!.coverage).toBe('failed');
      expect(indexed!.watermark).toBe(2);
      /* 失败清单在收尾额度内发布，保留可信前缀与缺口。 */
      expect(error.manifestArtifactId).not.toBeNull();
      verifyRecordingFilesOnDisk(f, error.storageBudget!);
    } finally {
      f.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 真实发布链故障注入（打开/写入/同步关闭/发布边界；短写）
 * ------------------------------------------------------------------ */

type FaultBoundary = 'open-enospc' | 'write-error' | 'finish-permission' | 'publish-error' | 'short-write';

/** 在第 N 次发布（openStagingWrite 序号）对应的真实发布链注入一次受控故障。 */
function injectFileFault(raw: ArtifactFileStore, boundary: FaultBoundary, failOpenOrdinal: number): ArtifactFileStore {
  let openOrdinal = 0;
  let targetRelativePath: string | null = null;
  return {
    ...raw,
    async openStagingWrite(key: never, control?: never) {
      openOrdinal += 1;
      const target = await raw.openStagingWrite(key, control);
      if (openOrdinal !== failOpenOrdinal) return target;
      targetRelativePath = target.relativePath;
      if (boundary === 'open-enospc') {
        void Promise.resolve(target.stream.destroy()).catch(() => undefined);
        throw new ArtifactFileError('io', 'test.inject', '注入磁盘满', { details: { code: 'ENOSPC' } });
      }
      if (boundary === 'write-error') {
        const stream = new Writable({
          write(chunk, _encoding, callback) {
            queueMicrotask(() => callback(new ArtifactFileError('io', 'test.inject', '注入写入失败')));
          },
          final(callback) { target.stream.end(callback); },
        });
        /* 发布器停止后迟到的错误回调不再无人接收。 */
        stream.on('error', () => undefined);
        return { relativePath: target.relativePath, stream } as typeof target;
      }
      return target;
    },
    async finishStaging(write: never, control?: never) {
      const staged = await raw.finishStaging(write, control);
      const isTarget = targetRelativePath !== null && (write as unknown as { relativePath?: string }).relativePath === targetRelativePath;
      if (isTarget && boundary === 'finish-permission') {
        throw new ArtifactFileError('permission', 'test.inject', '注入同步关闭权限错误');
      }
      if (isTarget && boundary === 'short-write') {
        return { ...staged, sizeBytes: Math.max(0, staged.sizeBytes - 3) };
      }
      return staged;
    },
    async publishStaging(staged: never, key: never, control?: never) {
      if (boundary === 'publish-error' && targetRelativePath !== null
        && (staged as unknown as { relativePath?: string }).relativePath === targetRelativePath) {
        throw new ArtifactFileError('io', 'test.inject', '注入发布边界失败');
      }
      return raw.publishStaging(staged, key, control);
    },
  } as ArtifactFileStore;
}

describe('P07-2 F-004 真实发布链故障注入', () => {
  const cases: readonly { readonly boundary: FaultBoundary; readonly reason: string }[] = [
    { boundary: 'open-enospc', reason: 'event_storage_exhausted' },
    { boundary: 'write-error', reason: 'event_file_write_failed' },
    { boundary: 'finish-permission', reason: 'event_file_write_failed' },
    { boundary: 'publish-error', reason: 'event_file_write_failed' },
    { boundary: 'short-write', reason: 'event_file_write_failed' },
  ];

  for (const { boundary, reason } of cases) {
    it(`[case:fault-${boundary}] 保留 ready 前缀与残留，未完整落盘批次不推进水位，不覆盖现有文件`, async () => {
      /* 第 3 次发布 = 第一批事件分块 ndjson：前两个消息体已 ready。 */
      const f = await openBudgetFixture({ wrapFiles: files => injectFileFault(files, boundary, 3) });
      try {
        const events = [1, 2, 3, 4].map(seq => messageEvent('evt.budget.', seq, `正文-${seq}`));
        const error = recordingError(await f.recorder.record({ request: f.request, handle: craftedHandle(events), eventIdentityPrefix: 'evt.budget.' }).then(() => null as never, (cause: unknown) => cause));
        expect(error.reason).toBe(reason);
        expect(error.gaps).toContain(`recording_failed:${reason}`);
        /* 未完整落盘批次不推进水位；消息索引保持为空。 */
        expect(f.query('SELECT recording_watermark AS w FROM sessions WHERE id = ?', f.sessionId)).toEqual({ w: null });
        expect(f.all('SELECT COUNT(*) AS n FROM session_messages')).toEqual([{ n: 0 }]);
        /* 已 ready 的消息体保留且可核验（前缀证据不被清理或覆盖）。 */
        const readyBodies = f.all('SELECT id, content_hash FROM artifacts WHERE kind = \'message\' AND status = \'ready\'') as { id: string; content_hash: string }[];
        expect(readyBodies).toHaveLength(2);
        for (const row of readyBodies) {
          const verified = await f.verifier.verifyArtifact(f.projectId, row.id);
          expect(verified.kind).toBe('verified_ready');
        }
        /* 失败制品保留阶段化证据（staging 残留或写入失败原因），不删除。 */
        const failed = f.all('SELECT kind, status FROM artifacts WHERE status = \'failed\'') as { kind: string }[];
        expect(failed.length).toBeGreaterThanOrEqual(1);
        /* 失败清单落盘并入库；旧 Manifest/现有文件不被覆盖。 */
        expect(error.manifestArtifactId).not.toBeNull();
        const manifests = f.all('SELECT id FROM artifacts WHERE kind = \'work-evidence-manifest\' AND status = \'ready\'') as { id: string }[];
        expect(manifests.map(row => row.id)).toEqual([error.manifestArtifactId]);
        const indexed = f.store.getLatestManifest(f.projectId, f.sessionId);
        expect(indexed!.coverage).toBe('failed');
        expect(indexed!.manifestRef!.artifactId).toBe(error.manifestArtifactId);
        verifyRecordingFilesOnDisk(f, error.storageBudget!);
      } finally {
        f.close();
      }
    });
  }

  it('[case:repeated-faults-bounded] 重复故障有界：失败制品/诊断有限增加，不无限写入', async () => {
    let opens = 0;
    const f = await openBudgetFixture({
      wrapFiles: files => ({
        ...files,
        async openStagingWrite(key: never, control?: never) {
          opens += 1;
          if (opens > 1) throw new ArtifactFileError('io', 'test.inject', '持续注入磁盘满', { details: { code: 'ENOSPC' } });
          return files.openStagingWrite(key, control);
        },
      } as ArtifactFileStore),
    });
    try {
      const events = [1, 2, 3, 4].map(seq => messageEvent('evt.budget.', seq, `正文-${seq}`));
      const error = recordingError(await f.recorder.record({ request: f.request, handle: craftedHandle(events), eventIdentityPrefix: 'evt.budget.' }).then(() => null as never, (cause: unknown) => cause));
      /* 连失败清单都无法落盘：经 SQLite 元数据保存缺口、最后可信水位与空 manifestRef。 */
      expect(error.manifestArtifactId).toBeNull();
      expect(error.gaps).toContain('evidence_unrecoverable');
      const indexed = f.store.getLatestManifest(f.projectId, f.sessionId);
      expect(indexed).not.toBeNull();
      expect(indexed!.manifestRef).toBeNull();
      expect(indexed!.coverage).toBe('failed');
      expect(indexed!.missingReasons).toContain('evidence_unrecoverable');
      /* 失败制品有限：消息体尝试 + 清单尝试，不随事件数无限增加。 */
      const failed = f.all('SELECT COUNT(*) AS n FROM artifacts WHERE status = \'failed\'') as { n: number }[];
      expect(failed[0]!.n).toBeLessThanOrEqual(3);
      expect(opens).toBeLessThanOrEqual(3);
      const usage = error.storageBudget!;
      /* 第 1 个消息体已 ready（保留前缀证据），其余写入全部失败计入失败口径。 */
      expect(usage.writtenBytes).toBeGreaterThan(0);
      verifyRecordingFilesOnDisk(f, usage);
    } finally {
      f.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 收尾回退链（收尾额度 / SQLite 元数据 / 监督层传播）
 * ------------------------------------------------------------------ */

describe('P07-2 F-004 收尾回退链', () => {
  it('[case:manifest-budget-sqlite-fallback] 收尾额度不足以保存清单时经 SQLite 保存缺口、水位与空 manifestRef', async () => {
    /* 小额度：正文恰好用满正文额度，收尾保留额度小于清单体积。 */
    const events = [1, 2].map(seq => messageEvent('evt.budget.', seq, `正文-${seq}`));
    const cap = lineBytes(events[0]!) + lineBytes(events[1]!) + bodyBytes(events[0]!) + bodyBytes(events[1]!);
    const f = await openBudgetFixture({ recorderLimits: { maxEventBodyBytes: 512, chunkMaxBytes: 1024, maxTotalBytes: limitForBodyCap(cap, 1024) } });
    try {
      const error = recordingError(await f.recorder.record({ request: f.request, handle: craftedHandle(events), eventIdentityPrefix: 'evt.budget.' }).then(() => null as never, (cause: unknown) => cause));
      /* 正文内容已完整落盘并推进水位；Manifest 无法落盘不伪造成功。 */
      expect(error.gaps).toContain('recording_failed:manifest_storage_exhausted');
      expect(error.gaps).toContain('evidence_unrecoverable');
      expect(error.manifestArtifactId).toBeNull();
      expect(f.query('SELECT recording_watermark AS w FROM sessions WHERE id = ?', f.sessionId)).toEqual({ w: 2 });
      expect(f.all('SELECT COUNT(*) AS n FROM artifacts WHERE kind = \'work-evidence-manifest\'')).toEqual([{ n: 0 }]);
      const indexed = f.store.getLatestManifest(f.projectId, f.sessionId);
      expect(indexed).not.toBeNull();
      expect(indexed!.manifestRef).toBeNull();
      expect(indexed!.watermark).toBe(2);
      expect(indexed!.coverage).toBe('failed');
      expect(indexed!.missingReasons).toContain('recording_failed:manifest_storage_exhausted');
      verifyRecordingFilesOnDisk(f, error.storageBudget!);
    } finally {
      f.close();
    }
  });

  it('[case:metadata-also-unpersisted] 数据库也无法写入时向监督层传播证据未持久化', async () => {
    let commits = 0;
    const f = await openBudgetFixture({
      wrapRecordingStore: store => ({
        getLatestManifest: (projectId: string, sessionId: string) => store.getLatestManifest(projectId, sessionId),
        commitRecording(input: never) {
          commits += 1;
          /* 第一批提交成功（水位 2 可信），其后元数据写入持续失败。 */
          if (commits > 1) throw new Error('injected sqlite unavailable');
          return store.commitRecording(input);
        },
      }),
    });
    try {
      const events = [1, 2, 3, 4].map(seq => messageEvent('evt.budget.', seq, `正文-${seq}`));
      const error = recordingError(await f.recorder.record({ request: f.request, handle: craftedHandle(events), eventIdentityPrefix: 'evt.budget.' }).then(() => null as never, (cause: unknown) => cause));
      /* 监督层可见：证据未持久化缺口随错误传播，required 安全停止。 */
      expect(error.gaps).toContain('evidence_metadata_unpersisted');
      expect(error.safeStopRequired).toBe(true);
      /* 不伪造引用/成功：入库清单停留在最后可信状态。 */
      const indexed = f.store.getLatestManifest(f.projectId, f.sessionId);
      expect(indexed!.watermark).toBe(2);
      expect(indexed!.finalized).toBe(false);
    } finally {
      f.close();
    }
  });

  it('[case:reserve-protects-closeout] 正文用满主体额度后失败清单仍可在收尾额度内发布', async () => {
    const events = [1, 2].map(seq => messageEvent('evt.budget.', seq, `正文-${seq}-${'w'.repeat(2400)}`));
    const cap = lineBytes(events[0]!) + lineBytes(events[1]!) + bodyBytes(events[0]!) + bodyBytes(events[1]!);
    const chunkMaxBytes = 8192;
    const f = await openBudgetFixture({ recorderLimits: { maxEventBodyBytes: 4096, chunkMaxBytes, maxTotalBytes: limitForBodyCap(cap, chunkMaxBytes) } });
    try {
      /* 正文恰好用满额度；结果声明的终态序列与实际不符 → required 范围不完整。 */
      const error = recordingError(await f.recorder.record({
        request: f.request, handle: craftedHandle(events, { lastEventSequence: 3 }), eventIdentityPrefix: 'evt.budget.',
      }).then(() => null as never, (cause: unknown) => cause));
      expect(error.reason).toBe('recording_scope_incomplete');
      expect(error.manifestArtifactId).not.toBeNull();
      const usage = error.storageBudget!;
      expect(usage.writtenBytes).toBeGreaterThan(cap);
      /* 失败清单字节在收尾额度内支付且真实落盘。 */
      const manifestRow = f.query('SELECT size_bytes FROM artifacts WHERE id = ?', error.manifestArtifactId) as { size_bytes: number };
      expect(manifestRow.size_bytes).toBe(usage.claimedBytes - cap);
      verifyRecordingFilesOnDisk(f, usage);
    } finally {
      f.close();
    }
  });
});
