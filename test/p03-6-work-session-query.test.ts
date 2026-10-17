/**
 * P03-6 / F-011：Work Session、Runtime 结果、停止证据与最小诊断制品的授权
 * 只读查询（Core 应用层直接调用，不经 HTTP；Host/CLI 接线属 F-012/F-013）。
 *
 * 验收面（.dag_context.json F-011）：
 * 1. 按 Run/Task/Attempt 读取 Session、实际 Runtime、executionStage、输入身份、
 *    最后活动、结果、停止状态、占用及证据引用；结果来自持久状态，重开数据库
 *    仍一致，不以 logger 或内存句柄作为权威。
 * 2. 列表和制品读取沿用既有有界分页、可见范围、hash/size 核验及错误映射；
 *    未知字段为 null，synthetic 用量显式标记，执行完成/等待验证/执行不确定
 *    分别展示，不混入 Chat 列表。
 * 3. 正常、启动失败、已结束待验证、取消、超时、记录缺口、旧结果诊断和隔离
 *    场景有映射测试；跨项目、非法游标、越权和损坏制品拒绝，读取不泄漏秘密
 *    或未授权内部路径。
 * 4. 查询和证据读取不扣预算、不续租、不触发取消或执行，也不接受任意文件
 *    路径；复用既有 Artifact 读取能力，不重建记录查询系统。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExecutionService } from '../packages/core/src/application/execution-service.ts';
import { createRuntimeExecutionService } from '../packages/core/src/application/runtime-execution.ts';
import { createRuntimeSettlementService } from '../packages/core/src/application/runtime-settlement.ts';
import { createWorkEvidenceRecorder } from '../packages/core/src/application/work-evidence-recorder.ts';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createQueryService } from '../packages/core/src/application/query-service.ts';
import type { QueryService } from '../packages/core/src/application/query-service.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteWorkSessionStore } from '../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createSqliteAttemptAccess } from '../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createFakeRuntime, fakeRuntimeCorrelationToken } from '../packages/core/src/adapters/fake-runtime.ts';
import type { FakeRuntimeOptions } from '../packages/core/src/adapters/fake-runtime.ts';
import { createStaticRuntimeRegistry } from '../packages/core/src/ports/runtime-registry.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { RuntimeError } from '../packages/core/src/ports/runtime-execution.ts';
import { computeDataRootIdentity } from '../packages/core/src/ports/path-service.ts';
import { isPublicError } from '../packages/core/src/ports/commands.ts';
import type { PublicError } from '../packages/core/src/ports/commands.ts';
import {
  deriveWorkSessionQueryState,
  isWorkSessionEvidenceLocator,
  validateWorkSessionListSelector,
  validateWorkSessionResultEvidence,
} from '../packages/core/src/ports/work-session-query.ts';
import { openBindingFixture, BINDING_NOW } from './helpers/p03-6/input-binding-fixture.ts';
import type { BindingFixture } from './helpers/p03-6/input-binding-fixture.ts';
import { openBudgetFixture } from './helpers/p03-3/budget-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from './helpers/p03-6/evidence-fixture.ts';
import { fixture as openStoppingFixture } from './helpers/p03-6/stopping-fixture.ts';
import { createLocalOwnerPrincipal, createRestrictedPrincipal, scopeAllowlist } from './helpers/p02-2/principals.ts';

const owner = createLocalOwnerPrincipal();

/** 与生产装配同一入口：真实 SQLite 查询门面 + 授权 QueryService（固定时钟）。 */
function assembleQueries(session: SqliteStorageSession, dataRoot: string, capabilityCatalog: unknown): QueryService {
  const queryStore = createSqliteQueryStore(session);
  const stateStore = createSqliteStateStore(session);
  return createQueryService({
    projectReads: queryStore,
    snapshots: queryStore,
    eventReads: queryStore,
    stateStore,
    configurationService: createConfigurationService({
      stateStore,
      capabilityCatalog: capabilityCatalog as never,
    }),
    planReads: queryStore,
    executionBudgetReads: queryStore,
    scheduleReads: queryStore,
    workspaceReads: queryStore,
    workSessionReads: queryStore,
    taskEvidenceReads: queryStore,
    gitOperationReads: queryStore,
    artifacts: createSqliteArtifactStore(session),
    artifactFiles: createArtifactFileStore({ dataRoot }),
    dataRootIdentity: computeDataRootIdentity(dataRoot),
    nowUtcMs: () => BINDING_NOW,
  });
}

/** 与 F-009 结算测试同一装配：真实 SQLite/Git/Artifact + FakeRuntime 执行链。 */
async function settlementFixture(options: Partial<FakeRuntimeOptions> = {}) {
  const f = await openBindingFixture({ secondTask: true });
  const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => BINDING_NOW });
  const lifecycle = createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW });
  const settlement = createRuntimeSettlementService({
    lifecycle, publisher: f.publisher, attempts: createSqliteAttemptAccess(f.session),
    dag: createSqliteTaskDagStore(f.session),
  });
  const fake = createFakeRuntime({
    script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'retained.txt', content: 'progress' }] },
    workspaceRoots: { 'workspace-root': f.box.root },
    providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
    adapterVersion: 'fake-1.0.0', nowUtcMs: () => BINDING_NOW, ...options,
  });
  const configuration = createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
  ]);
  const runtime = createRuntimeExecutionService({
    configuration,
    registry: createStaticRuntimeRegistry([{ descriptor: fake.descriptor, adapter: fake.adapter }], configuration),
  });
  const service = createExecutionService({
    atomic: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => BINDING_NOW }),
    resources: f.createResources(), sessions, inputBinding: f.bindingService, runtime,
    dag: createSqliteTaskDagStore(f.session), attempts: createSqliteAttemptAccess(f.session),
    recorder: createWorkEvidenceRecorder({ publisher: f.publisher, verifier: f.verifier, sessions, limits: DEFAULT_RECORDER_LIMITS }),
    eventIdentityPrefix: (request) => `evt.${fakeRuntimeCorrelationToken(request)}.`,
    nowUtcMs: () => BINDING_NOW, settlement,
  });
  const claim = f.claimTask('t-1');
  const attemptId = claim.receipt.attempt.id;
  const start = () => service.start(f.bindingInput(claim));
  const executeAndSettle = async () => {
    const started = await start();
    const [result, recording, stopped] = await Promise.all([
      started.context.result, started.context.recording, started.context.stopped,
    ]);
    const receipt = await settlement.settle({ request: started.context.request, result, recording, stopped });
    return { started, receipt };
  };
  const queries = () => assembleQueries(f.session, f.box.dataRoot, f.box.capabilityCatalog);
  return { ...f, sessions, lifecycle, settlement, service, claim, attemptId, start, executeAndSettle, queries };
}

type SettlementFixture = Awaited<ReturnType<typeof settlementFixture>>;

/** 只读断言用的持久表快照（查询前后必须逐字节一致）。 */
function businessSnapshot(session: SqliteStorageSession): unknown {
  return [
    'attempts', 'sessions', 'workspace_leases', 'execution_batches', 'runs',
    'state_events', 'artifacts', 'attempt_notification_diagnostics', 'execution_batches',
  ].map((table) => session.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

async function expectPublicError(
  run: () => Promise<unknown>,
  expected: { readonly code: string; readonly operation: string; readonly reason?: string },
): Promise<PublicError> {
  const error = (await run().then(
    (value) => {
      throw new Error(`expected PublicError(${expected.code}), got ${JSON.stringify(value)}`);
    },
    (thrown: unknown) => thrown,
  )) as PublicError;
  expect(isPublicError(error)).toBe(true);
  expect(error).toMatchObject({ code: expected.code, operation: expected.operation });
  if (expected.reason !== undefined) {
    expect(error.details?.reason).toBe(expected.reason);
  }
  return error;
}

/** 错误公开面（存在性/归属不泄漏的比较基准）。 */
function errorFace(error: PublicError): Record<string, unknown> {
  return { code: error.code, operation: error.operation, message: error.message, details: error.details };
}

const RICH_SCRIPT = {
  schemaVersion: 1,
  steps: [
    { op: 'message', role: 'assistant', text: 'hello runtime' },
    { op: 'usage', inputTokens: 17, outputTokens: null, costUsdMicros: null },
    { op: 'write_file', path: 'retained.txt', content: 'progress' },
  ],
} as const;

describe('P03-6 / F-011 Work Session query surface', () => {
  it('正常完成+停止：列表/详情/证据读取一致，重开数据库相同，查询零副作用', async () => {
    const f = await settlementFixture({ script: RICH_SCRIPT });
    try {
      const { receipt } = await f.executeAndSettle();
      expect(receipt).toMatchObject({ disposition: 'applied', status: 'verifying', stopConfirmed: true });
      const before = businessSnapshot(f.session);
      const queries = f.queries();

      // 按 Run 与按 Task 列表：同一行；另一 Task 为空页。
      const byRun = await queries.listWorkSessions(owner, { projectId: f.projectId, runId: f.runId });
      expect(byRun.scope).toBe('work-session-list');
      expect(byRun.records).toHaveLength(1);
      expect(byRun.nextCursor).toBeNull();
      const row = byRun.records[0]!;
      expect(row).toMatchObject({
        projectId: f.projectId, runId: f.runId, taskId: 't-1', attemptId: f.attemptId,
        status: 'stopped', executionStage: 'verification', executionState: 'awaiting_verification',
        runtime: 'fake', adapterVersion: 'fake-1.0.0', recordingGapCount: 0,
      });
      expect(row.resultRef).toEqual(expect.any(String));
      expect(row.stoppedAt).toEqual(expect.any(String));
      const byTask = await queries.listWorkSessions(owner, { projectId: f.projectId, taskId: 't-1' });
      expect(byTask.records).toEqual(byRun.records);
      const emptyTask = await queries.listWorkSessions(owner, { projectId: f.projectId, taskId: 't-2' });
      expect(emptyTask.records).toEqual([]);

      // 详情：Session/执行/输入/停止/占用/证据引用均来自持久一致读视图。
      const detail = await queries.getWorkSession(owner, { projectId: f.projectId, attemptId: f.attemptId });
      expect(detail.scope).toBe('work-session');
      expect(detail.executionState).toBe('awaiting_verification');
      expect(detail.session).toMatchObject({
        status: 'stopped', kind: 'work', runtime: 'fake', executionStage: 'verification',
        recordingGaps: [],
      });
      expect(detail.attempt).toMatchObject({
        id: f.attemptId, status: 'verifying', executionStage: 'verification',
        invocationId: expect.any(String), errorKind: null,
      });
      // synthetic 用量显式标记：结果证据的 result.usage 未知保持 null（不填
      // 0/不冒充供应商报告）；synthetic 观察总量在清单证据中显式标记 basis。
      expect(detail.attempt.usageSummary).toBeNull();
      expect(detail.resultEvidence).toMatchObject({
        kind: 'runtime-settlement',
        result: { terminal: 'completed', usage: null },
        failure: null,
        recording: { complete: true, manifestRef: expect.any(String), gaps: [] },
        stop: { evidence: { confirmed: true }, failure: null },
      });
      expect(detail.occupancy).toHaveLength(3);
      for (const lease of detail.occupancy) {
        expect(lease).toMatchObject({ attemptId: f.attemptId, runId: f.runId, state: 'held' });
        expect(typeof lease.processIdentity).toBe('boolean');
        expect(lease.resourceKey.startsWith('/')).toBe(false);
      }
      const evidenceKinds = detail.evidence.map((entry) => entry.kind).sort();
      expect(evidenceKinds).toEqual(['runtime-settlement', 'work-evidence-events', 'work-evidence-manifest']);
      for (const entry of detail.evidence) {
        expect(entry).toMatchObject({ status: 'ready', contentHash: expect.any(String) });
        expect(JSON.stringify(entry)).not.toContain(f.box.dataRoot);
      }
      expect(detail.diagnostics).toEqual([]);
      // 公开面不携带原生 Session 身份与受控逻辑 locator。
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain('providerSessionId');
      expect(serialized).not.toContain('sessions/session-');
      expect(serialized).not.toContain(f.box.dataRoot);

      // 证据正文读取：hash/size 核验后的真实内容。
      const sessionId = detail.session!.id;
      const settlementRef = detail.session!.resultRef!;
      const settlementBody = await queries.readWorkSessionEvidence(owner, {
        projectId: f.projectId, attemptId: f.attemptId, artifactId: settlementRef,
      });
      expect(JSON.parse(Buffer.from(settlementBody.content).toString('utf8'))).toMatchObject({
        kind: 'runtime-settlement', execution: { result: { terminal: 'completed' } },
      });
      const manifestRef = detail.resultEvidence!.recording.manifestRef!;
      const manifestBody = await queries.readWorkSessionEvidence(owner, {
        projectId: f.projectId, attemptId: f.attemptId, artifactId: manifestRef,
      });
      expect(JSON.parse(Buffer.from(manifestBody.content).toString('utf8'))).toMatchObject({
        kind: 'work-evidence-manifest', identity: { sessionId },
        usage: { basis: 'synthetic', observations: { totals: { inputTokens: 17 } }, notAdditive: true },
        coverage: 'complete',
      });
      const chunkRef = detail.evidence.find((entry) => entry.kind === 'work-evidence-events')!;
      const chunkBody = await queries.readWorkSessionEvidence(owner, {
        projectId: f.projectId, attemptId: f.attemptId, artifactId: chunkRef.artifactId,
      });
      const firstLine = Buffer.from(chunkBody.content).toString('utf8').split('\n')[0]!;
      expect(JSON.parse(firstLine)).toMatchObject({ kind: 'message' });

      // 重开数据库：查询结果逐字节一致（持久状态是唯一权威）。
      const expectedList = JSON.stringify(byRun);
      const expectedDetail = JSON.stringify(detail);
      // 查询零副作用：预算/租约/事件/制品表逐字节一致。
      expect(businessSnapshot(f.session)).toEqual(before);
      f.session.close();
      const reopened = openSqliteStorageSession({ path: f.session.path });
      try {
        const reQueries = assembleQueries(reopened, f.box.dataRoot, f.box.capabilityCatalog);
        const reList = await reQueries.listWorkSessions(owner, { projectId: f.projectId, runId: f.runId });
        const reDetail = await reQueries.getWorkSession(owner, { projectId: f.projectId, attemptId: f.attemptId });
        expect(JSON.stringify(reList)).toBe(expectedList);
        expect(JSON.stringify(reDetail)).toBe(expectedDetail);
      } finally {
        reopened.close();
      }
    } finally {
      f.close();
    }
  });

  it('启动失败：未启动拒绝证据可查，Session 明确为 null', async () => {
    const f = await settlementFixture();
    try {
      const rejected = await f.settlement.rejectLaunch!({
        identity: {
          projectId: f.projectId, attemptId: f.attemptId,
          owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1,
        },
        taskId: 't-1', runId: f.runId,
        error: new RuntimeError('permission', 'grant_missing'),
      });
      expect(rejected.receipt).toMatchObject({ disposition: 'applied', status: 'failed' });
      const queries = f.queries();
      // 启动前拒绝没有顶层 Session：列表为空，详情 session 为 null。
      const list = await queries.listWorkSessions(owner, { projectId: f.projectId, taskId: 't-1' });
      expect(list.records).toEqual([]);
      const detail = await queries.getWorkSession(owner, { projectId: f.projectId, attemptId: f.attemptId });
      expect(detail.session).toBeNull();
      expect(detail.executionState).toBe('failed');
      expect(detail.attempt).toMatchObject({ status: 'failed', executionStage: 'preflight' });
      expect(detail.resultEvidence).toMatchObject({
        kind: 'runtime-not-started',
        result: null,
        failure: { kind: 'permission', reason: 'grant_missing' },
        recording: { complete: false, gaps: ['runtime_not_started'] },
        stop: { evidence: null },
      });
      expect(detail.evidence).toHaveLength(1);
      expect(detail.evidence[0]).toMatchObject({ kind: 'runtime-settlement', status: 'ready' });
      const body = await queries.readWorkSessionEvidence(owner, {
        projectId: f.projectId, attemptId: f.attemptId, artifactId: rejected.evidenceRef,
      });
      expect(JSON.parse(Buffer.from(body.content).toString('utf8'))).toMatchObject({
        kind: 'runtime-not-started', failure: { kind: 'permission' },
      });
    } finally {
      f.close();
    }
  });

  it('已结束待验证：停止未确认时占用隔离保留，不冒充安全停止', async () => {
    const f = await settlementFixture({ script: RICH_SCRIPT });
    try {
      const started = await f.start();
      const [result, recording] = await Promise.all([started.context.result, started.context.recording]);
      const receipt = await f.settlement.settle({
        request: started.context.request, result, recording, stopped: null,
      });
      expect(receipt).toMatchObject({ status: 'verifying', waitingFor: 'execution_uncertain', stopConfirmed: false });
      const detail = await f.queries().getWorkSession(owner, { projectId: f.projectId, attemptId: f.attemptId });
      expect(detail.executionState).toBe('awaiting_verification');
      expect(detail.session).toMatchObject({ status: 'ended', stoppedAt: null });
      expect(detail.resultEvidence).toMatchObject({
        kind: 'runtime-settlement',
        result: { terminal: 'completed' },
        stop: { evidence: null },
      });
      // 隔离场景：停止未知 → 占用 quarantined，不释放、不冒充安全关闭。
      expect(detail.occupancy).toHaveLength(3);
      for (const lease of detail.occupancy) {
        expect(lease.state).toBe('quarantined');
      }
    } finally {
      f.close();
    }
  });

  it('记录缺口：事件丢失如实展示，不伪造完整记录', async () => {
    const f = await settlementFixture({
      script: {
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: 'one' },
          { op: 'message', role: 'assistant', text: 'two' },
          { op: 'message', role: 'assistant', text: 'three' },
        ],
        lifecycle: { events: { drop: [2] } },
      },
    });
    try {
      const { receipt } = await f.executeAndSettle();
      expect(receipt).toMatchObject({ status: 'verifying', waitingFor: 'recording_required' });
      const detail = await f.queries().getWorkSession(owner, { projectId: f.projectId, attemptId: f.attemptId });
      expect(detail.session!.recordingGaps).not.toBeNull();
      expect(detail.session!.recordingGaps!.length).toBeGreaterThan(0);
      expect(detail.resultEvidence!.recording.complete).toBe(false);
      expect(detail.resultEvidence!.recording.gaps.length).toBeGreaterThan(0);
      expect(detail.resultEvidence!.recording.watermark).not.toBeNull();
      // 清单如实标注 partial（不冒充完整覆盖）。
      const manifestRef = detail.resultEvidence!.recording.manifestRef!;
      const manifestBody = await f.queries().readWorkSessionEvidence(owner, {
        projectId: f.projectId, attemptId: f.attemptId, artifactId: manifestRef,
      });
      expect(JSON.parse(Buffer.from(manifestBody.content).toString('utf8'))).toMatchObject({
        coverage: 'partial',
      });
    } finally {
      f.close();
    }
  });

  it('旧结果诊断：迟到/越权通知按固定原因展示', async () => {
    const f = await settlementFixture({ script: RICH_SCRIPT });
    try {
      await f.executeAndSettle();
      const session = f.sessions.getAttemptWorkSession(f.projectId, f.attemptId)!;
      // 旧身份采集入口核验：触发真实 stale_execution_identity 诊断行。
      const current = f.sessions.checkWorkSessionFence({
        projectId: f.projectId, attemptId: f.attemptId,
        owner: 'stale-owner', hostInstanceId: 'host-1', executionVersion: 1,
        sessionId: session.id,
      });
      expect(current).toBe(false);
      const detail = await f.queries().getWorkSession(owner, { projectId: f.projectId, attemptId: f.attemptId });
      expect(detail.diagnostics).toHaveLength(1);
      expect(detail.diagnostics[0]).toMatchObject({
        attemptId: f.attemptId, reason: 'stale_execution_identity',
        notificationDigest: expect.any(String),
      });
      // 诊断不泄漏原通知的身份正文。
      expect(JSON.stringify(detail.diagnostics)).not.toContain('stale-owner');
    } finally {
      f.close();
    }
  });

  it('取消：取消接受与已停止分别展示，不混淆为执行成功', async () => {
    const f = await openStoppingFixture();
    try {
      const { context } = await f.start();
      const outcome = await f.service.cancel(f.identity);
      expect(outcome).toMatchObject({ stopConfirmed: true, persisted: true });
      void context;
      const queries = assembleQueries(f.session, f.box.dataRoot, f.box.capabilityCatalog);
      const detail = await queries.getWorkSession(owner, {
        projectId: f.projectId, attemptId: f.identity.attemptId,
      });
      expect(detail.executionState).toBe('cancelled');
      expect(detail.attempt).toMatchObject({ status: 'cancelled', errorKind: null });
      expect(detail.session).toMatchObject({ status: 'stopped' });
      expect(detail.resultEvidence).toMatchObject({
        kind: 'runtime-settlement',
        result: { terminal: 'cancelled' },
        control: { reason: 'user_cancelled', cancel: 'accepted' },
        stop: { evidence: { confirmed: true } },
      });
      const list = await queries.listWorkSessions(owner, { projectId: f.projectId, runId: f.runId });
      expect(list.records[0]).toMatchObject({ executionState: 'cancelled', status: 'stopped' });
    } finally {
      await f.dispose();
    }
  });

  it('超时：runtime_timeout 控制事实如实展示为失败', async () => {
    const f = await openStoppingFixture();
    try {
      const { context } = await f.start({
        limits: { timeoutMs: 1_000, maxEvents: 100, maxOutputBytes: 1_048_576 },
      });
      const completion = await context.completion;
      expect(completion).toMatchObject({ persisted: true, stopConfirmed: true });
      const queries = assembleQueries(f.session, f.box.dataRoot, f.box.capabilityCatalog);
      const detail = await queries.getWorkSession(owner, {
        projectId: f.projectId, attemptId: f.identity.attemptId,
      });
      expect(detail.executionState).toBe('failed');
      expect(detail.attempt).toMatchObject({ status: 'failed' });
      expect(detail.resultEvidence).toMatchObject({
        kind: 'runtime-settlement',
        control: { reason: 'runtime_timeout' },
        stop: { evidence: { confirmed: true } },
      });
    } finally {
      await f.dispose();
    }
  });

  it('执行不确定：停止未核验 → interrupted + 占用隔离，与等待验证分开', async () => {
    const f = await openStoppingFixture({
      script: { schemaVersion: 1, steps: [{ op: 'await_gate', name: 'hang' }], lifecycle: { stopped: { unconfirmed: true } } },
    });
    try {
      const { context } = await f.start();
      await f.service.cancel(f.identity);
      const completion = await context.completion;
      expect(completion).toMatchObject({ persisted: true, stopConfirmed: false });
      const queries = assembleQueries(f.session, f.box.dataRoot, f.box.capabilityCatalog);
      const detail = await queries.getWorkSession(owner, {
        projectId: f.projectId, attemptId: f.identity.attemptId,
      });
      expect(detail.executionState).toBe('execution_uncertain');
      expect(detail.attempt).toMatchObject({ status: 'interrupted' });
      expect(detail.session!.status).not.toBe('stopped');
      expect(detail.resultEvidence).toMatchObject({
        control: { reason: 'user_cancelled' },
        stop: { evidence: { confirmed: false } },
      });
      expect(detail.occupancy.length).toBeGreaterThan(0);
      for (const lease of detail.occupancy) {
        expect(lease.state).toBe('quarantined');
      }
    } finally {
      await f.dispose();
    }
  });

  it('Chat Session 不混入 Work Session 列表', async () => {
    const f = await settlementFixture({ script: RICH_SCRIPT });
    try {
      await f.executeAndSettle();
      // 持久一条 Chat Session（DDL 形状：kind=chat 且 attempt_id 为 NULL）。
      f.session.database.prepare(`INSERT INTO sessions (id, created_at, updated_at, revision, project_id,
        attempt_id, parent_session_id, kind, title, purpose, runtime, adapter_version, provider_session_id,
        status, execution_stage, input_ref, result_ref, last_activity_at, started_at, ended_at, stopped_at,
        native_ref, recording_watermark, recording_gaps)
        VALUES ('chat-session-1', ?, ?, 1, ?, NULL, NULL, 'chat', NULL, 'conversation', 'fake', 'fake-1.0.0',
        NULL, 'reserved', 'preflight', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL)`)
        .run(BINDING_NOW, BINDING_NOW, f.projectId, f.requirementArtifactId, BINDING_NOW);
      const byRun = await f.queries().listWorkSessions(owner, { projectId: f.projectId, runId: f.runId });
      expect(byRun.records).toHaveLength(1);
      expect(byRun.records[0]!.sessionId).not.toBe('chat-session-1');
      const byTask = await f.queries().listWorkSessions(owner, { projectId: f.projectId, taskId: 't-1' });
      expect(byTask.records).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it('跨项目/不可见/无能力主体：存在性折叠，不泄漏归属', async () => {
    const f = await settlementFixture({ script: RICH_SCRIPT });
    const other = await openBudgetFixture();
    try {
      await f.executeAndSettle();
      const queries = f.queries();
      // 无 project.read 能力：三个操作均 forbidden（先于任何读取）。
      const incapable = createRestrictedPrincipal({ capabilities: [], projectScope: scopeAllowlist([f.projectId]) });
      await expectPublicError(
        () => queries.listWorkSessions(incapable, { projectId: f.projectId, runId: f.runId }),
        { code: 'forbidden', operation: 'execution.sessions.list' },
      );
      await expectPublicError(
        () => queries.getWorkSession(incapable, { projectId: f.projectId, attemptId: f.attemptId }),
        { code: 'forbidden', operation: 'execution.session.get' },
      );
      await expectPublicError(
        () => queries.readWorkSessionEvidence(incapable, { projectId: f.projectId, attemptId: f.attemptId, artifactId: 'x' }),
        { code: 'forbidden', operation: 'execution.session.evidence.get' },
      );
      // 受限主体不可见该项目：同样 forbidden（与不存在项目同一纪律）。
      const invisible = createRestrictedPrincipal({
        capabilities: ['project.read'], projectScope: scopeAllowlist([other.projectId]),
      });
      await expectPublicError(
        () => queries.getWorkSession(invisible, { projectId: f.projectId, attemptId: f.attemptId }),
        { code: 'forbidden', operation: 'execution.session.get' },
      );
      // 他项目 Attempt 与不存在 Attempt 的公开错误面逐字段一致（不区分存在性）。
      const crossProject = await expectPublicError(
        () => queries.getWorkSession(owner, { projectId: other.projectId, attemptId: f.attemptId }),
        { code: 'not_found', operation: 'execution.session.get', reason: 'execution_entity_not_found' },
      );
      const missing = await expectPublicError(
        () => queries.getWorkSession(owner, { projectId: f.projectId, attemptId: 'attempt-missing' }),
        { code: 'not_found', operation: 'execution.session.get', reason: 'execution_entity_not_found' },
      );
      expect(errorFace(crossProject)).toEqual(errorFace(missing));
      // 跨项目 Run/Task 同样折叠。
      await expectPublicError(
        () => queries.listWorkSessions(owner, { projectId: other.projectId, runId: f.runId }),
        { code: 'not_found', operation: 'execution.sessions.list' },
      );
      await expectPublicError(
        () => queries.listWorkSessions(owner, { projectId: other.projectId, taskId: 't-1' }),
        { code: 'not_found', operation: 'execution.sessions.list' },
      );
    } finally {
      f.close();
      other.close();
    }
  });

  it('非法选择器/分页/游标与跨父级游标重放一律拒绝', async () => {
    const f = await settlementFixture({ script: RICH_SCRIPT });
    try {
      await f.executeAndSettle();
      const queries = f.queries();
      // runId 与 taskId 必须恰好其一。
      await expectPublicError(
        () => queries.listWorkSessions(owner, { projectId: f.projectId }),
        { code: 'invalid_input', operation: 'execution.sessions.list', reason: 'parent_required' },
      );
      await expectPublicError(
        () => queries.listWorkSessions(owner, { projectId: f.projectId, runId: f.runId, taskId: 't-1' }),
        { code: 'invalid_input', operation: 'execution.sessions.list', reason: 'parent_conflict' },
      );
      await expectPublicError(
        () => queries.listWorkSessions(owner, { projectId: f.projectId, runId: f.runId, bogus: 1 }),
        { code: 'invalid_input', operation: 'execution.sessions.list' },
      );
      // limit 边界：默认 50，上限 200。
      await expectPublicError(
        () => queries.listWorkSessions(owner, { projectId: f.projectId, runId: f.runId, limit: 0 }),
        { code: 'invalid_input', operation: 'execution.sessions.list' },
      );
      await expectPublicError(
        () => queries.listWorkSessions(owner, { projectId: f.projectId, runId: f.runId, limit: 201 }),
        { code: 'invalid_input', operation: 'execution.sessions.list' },
      );
      // 畸形游标：不当作从零读取。
      await expectPublicError(
        () => queries.listWorkSessions(owner, { projectId: f.projectId, runId: f.runId, cursor: 'garbage' }),
        { code: 'invalid_input', operation: 'execution.sessions.list', reason: 'invalid_cursor' },
      );
      // 跨父级重放：绑定其他父级的合法游标必然 invalid_cursor。
      const { createPlanListCursorBinding, encodePlanListCursor } = await import('../packages/core/src/ports/queries.ts');
      const foreignBinding = createPlanListCursorBinding({
        rootIdentity: computeDataRootIdentity(f.box.dataRoot),
        scope: { kind: 'task-work-sessions', projectId: f.projectId, taskId: 't-2' },
      });
      const foreignCursor = encodePlanListCursor('1_session-1', foreignBinding);
      await expectPublicError(
        () => queries.listWorkSessions(owner, { projectId: f.projectId, runId: f.runId, cursor: foreignCursor }),
        { code: 'invalid_input', operation: 'execution.sessions.list', reason: 'invalid_cursor' },
      );
    } finally {
      f.close();
    }
  });

  it('损坏制品 fail-closed：详情与证据读取均 corrupt_state', async () => {
    const f = await settlementFixture({ script: RICH_SCRIPT });
    try {
      await f.executeAndSettle();
      const queries = f.queries();
      const detail = await queries.getWorkSession(owner, { projectId: f.projectId, attemptId: f.attemptId });
      const settlementRef = detail.session!.resultRef!;
      // 篡改制品正文（hash/size 核验必然失败）。
      const artifact = await f.artifacts.getArtifact(f.projectId, settlementRef);
      const files = createArtifactFileStore({ dataRoot: f.box.dataRoot });
      const placement = files.resolvePlacement({
        projectId: f.projectId, artifactId: settlementRef, locator: artifact.locator,
      });
      writeFileSync(join(f.box.dataRoot, placement.finalRelativePath), Buffer.from('corrupted-body'), );
      await expectPublicError(
        () => queries.getWorkSession(owner, { projectId: f.projectId, attemptId: f.attemptId }),
        { code: 'corrupt_state', operation: 'execution.session.get', reason: 'evidence_incomplete' },
      );
      await expectPublicError(
        () => queries.readWorkSessionEvidence(owner, { projectId: f.projectId, attemptId: f.attemptId, artifactId: settlementRef }),
        { code: 'corrupt_state', operation: 'execution.session.evidence.get', reason: 'evidence_incomplete' },
      );
    } finally {
      f.close();
    }
  });

  it('证据读取拒绝非成员制品与任意路径形态', async () => {
    const f = await settlementFixture({ script: RICH_SCRIPT });
    try {
      await f.executeAndSettle();
      const queries = f.queries();
      // 同项目但非本 Session/Attempt 受控前缀的制品：not_found（防枚举）。
      const nonMember = await expectPublicError(
        () => queries.readWorkSessionEvidence(owner, {
          projectId: f.projectId, attemptId: f.attemptId, artifactId: f.requirementArtifactId,
        }),
        { code: 'not_found', operation: 'execution.session.evidence.get', reason: 'execution_entity_not_found' },
      );
      const missing = await expectPublicError(
        () => queries.readWorkSessionEvidence(owner, {
          projectId: f.projectId, attemptId: f.attemptId, artifactId: 'artifact-missing',
        }),
        { code: 'not_found', operation: 'execution.session.evidence.get', reason: 'execution_entity_not_found' },
      );
      expect(errorFace(nonMember)).toEqual(errorFace(missing));
      // 任意路径形态绝不接受：artifactId 必须是稳定 ID。
      await expectPublicError(
        () => queries.readWorkSessionEvidence(owner, {
          projectId: f.projectId, attemptId: f.attemptId, artifactId: '../../etc/passwd',
        }),
        { code: 'invalid_input', operation: 'execution.session.evidence.get' },
      );
      await expectPublicError(
        () => queries.readWorkSessionEvidence(owner, {
          projectId: f.projectId, attemptId: f.attemptId, artifactId: 'x', path: '/tmp/evil',
        }),
        { code: 'invalid_input', operation: 'execution.session.evidence.get' },
      );
      // 输入制品（inputs/ 前缀）同样不是 Session 证据成员。
      await expectPublicError(
        () => queries.readWorkSessionEvidence(owner, {
          projectId: f.projectId, attemptId: f.attemptId, artifactId: 'snapshot-1',
        }),
        { code: 'not_found', operation: 'execution.session.evidence.get' },
      );
    } finally {
      f.close();
    }
  });

  it('纯契约：选择器校验、展示分类派生、证据校验与 locator 成员资格', () => {
    // 选择器：恰好一个父级。
    expect(validateWorkSessionListSelector({ projectId: 'p', runId: 'r' }, 'op')).toEqual({
      parent: { kind: 'run', runId: 'r' },
    });
    expect(validateWorkSessionListSelector({ projectId: 'p', taskId: 't' }, 'op')).toEqual({
      parent: { kind: 'task', taskId: 't' },
    });
    expect(() => validateWorkSessionListSelector({ projectId: 'p' }, 'op')).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'parent_required' }) }),
    );
    expect(() => validateWorkSessionListSelector({ projectId: 'p', runId: 'r', taskId: 't' }, 'op')).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'parent_conflict' }) }),
    );
    // 展示分类：执行完成等待验证与执行不确定分开；取消不是停止确认。
    expect(deriveWorkSessionQueryState({ status: 'verifying' }, { status: 'ended' })).toBe('awaiting_verification');
    expect(deriveWorkSessionQueryState({ status: 'interrupted' }, { status: 'ended' })).toBe('execution_uncertain');
    expect(deriveWorkSessionQueryState({ status: 'cancelled' }, { status: 'stopped' })).toBe('cancelled');
    expect(deriveWorkSessionQueryState({ status: 'executing' }, { status: 'started' })).toBe('running');
    expect(deriveWorkSessionQueryState({ status: 'executing' }, { status: 'ended' })).toBe('settling');
    expect(deriveWorkSessionQueryState({ status: 'preparing' }, null)).toBe('preparing');
    expect(deriveWorkSessionQueryState({ status: 'succeeded' }, { status: 'stopped' })).toBe('succeeded');
    expect(deriveWorkSessionQueryState({ status: 'failed' }, { status: 'ended' })).toBe('failed');
    // locator 成员资格：精确前缀，不接受任意路径或其他 Session。
    expect(isWorkSessionEvidenceLocator('sessions/s-1/runtime-settlement.json', 's-1', 'a-1')).toBe(true);
    expect(isWorkSessionEvidenceLocator('attempts/a-1/launch-rejection.json', 's-1', 'a-1')).toBe(true);
    expect(isWorkSessionEvidenceLocator('sessions/s-2/runtime-settlement.json', 's-1', 'a-1')).toBe(false);
    expect(isWorkSessionEvidenceLocator('inputs/snapshot-1', 's-1', 'a-1')).toBe(false);
    expect(isWorkSessionEvidenceLocator('attempts/a-1/launch-rejection.json', null, 'a-1')).toBe(true);
    expect(isWorkSessionEvidenceLocator('sessions/s-1x/evil.json', 's-1', 'a-1')).toBe(false);
    // 证据校验：版本/类别/词汇外终态拒绝；synthetic basis 原样保留。
    const base = {
      schemaVersion: 1, kind: 'runtime-settlement',
      identity: { projectId: 'p' },
      execution: {
        result: {
          schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
          durationMs: 5, usage: { basis: 'synthetic', inputTokens: 17, outputTokens: null, costUsdMicros: null },
          lastEventSequence: 3,
        },
        failure: null,
      },
      recording: { complete: true, manifestRef: 'm-1', failure: null, gaps: [], watermark: 3 },
      stop: { evidence: null, failure: null },
    };
    const valid = validateWorkSessionResultEvidence(base);
    expect(valid).toMatchObject({ kind: 'runtime-settlement', result: { usage: { basis: 'synthetic' } } });
    expect(() => validateWorkSessionResultEvidence({ ...base, schemaVersion: 2 })).toThrow();
    expect(() => validateWorkSessionResultEvidence({ ...base, kind: 'unknown-kind' })).toThrow();
    expect(() => validateWorkSessionResultEvidence({
      ...base, execution: { result: { ...base.execution.result, terminal: 'melted' }, failure: null },
    })).toThrow();
    expect(() => validateWorkSessionResultEvidence({
      ...base, execution: { result: { ...base.execution.result, usage: { basis: 'real', inputTokens: 1, outputTokens: null, costUsdMicros: null } }, failure: null },
    })).toThrow();
    const rejection = validateWorkSessionResultEvidence({
      schemaVersion: 1, kind: 'runtime-not-started', identity: { projectId: 'p' },
      taskId: 't-1', runId: 'r-1', failure: { kind: 'permission', reason: 'grant_missing' },
      recording: { complete: false, gaps: ['runtime_not_started'] },
    });
    expect(rejection).toMatchObject({ kind: 'runtime-not-started', failure: { kind: 'permission' } });
    expect(() => validateWorkSessionResultEvidence({
      schemaVersion: 1, kind: 'runtime-not-started', identity: { projectId: 'p' },
      taskId: 't-1', runId: 'r-1', failure: null, recording: { complete: false, gaps: [] },
    })).toThrow();
  });
});
