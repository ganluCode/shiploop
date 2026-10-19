/**
 * P03-4 / F-008：Run 调度诊断与 Attempt/通知诊断审计查询接入 Host 传输与
 * HostClient（真实 startHost + 真实 HostClient + 真实临时 SQLite）。
 *
 * 验收面（.dag_context.json F-008）：
 * 1. 扩展现有 Host 查询分发、能力白名单与 HostClient：授权主体经
 *    GET /v1/runs/:runId/schedule、GET /v1/attempts、
 *    GET /v1/attempts/:attemptId/diagnostics 读取 F-007 的结构化结果；参数、
 *    分页（limit/plcur_v1_ 游标）与错误映射复用既有协议纪律，不另建 HTTP
 *    服务或认证体系。
 * 2. 真实本机集成：合法查询、未认证（401 不可区分）、跨项目 Run/Attempt 与
 *    不存在实体（逐字段相同的 not_found，不泄漏存在性）、无效参数
 *    （400 定位 query.<字段>）；错误体不含其他项目身份、制品正文或内部
 *    绝对路径。
 * 3. 只读接线：不新增客户端直接认领、直接提交 Runtime 结果或直改 SQLite
 *    的入口；既有 execution.start 幂等通道与调度器装配关系不变（本夹具未
 *    装配调度器，Run 保留 queued/resource_busy 等如实原因，不伪造已启动）。
 * 4. 查询重放零副作用（持久表逐字节一致）；既有命令回执与状态事件能关联
 *    本项读取的 Run/Attempt 写入身份。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HostProtocolError,
  isHostProtocolError,
  connectToHost,
  startHost,
  validateAppQueryResponse,
  validateAttemptDiagnosticsResultWire,
  validateAttemptListResultWire,
  validateRunScheduleStatusResultWire,
  type HostClient,
} from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { NOW, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { PLAN_LIST_CURSOR_PREFIX } from '../../../packages/core/src/ports/queries.ts';
import type { AttemptRecord } from '../../../packages/core/src/ports/attempt-store.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

/* ------------------------------------------------------------------ *
 * 夹具：真实执行数据（Batch/Run/Attempt/占用/诊断）+ 真实 Host + HostClient
 * ------------------------------------------------------------------ */

type ClaimFixture = Awaited<ReturnType<typeof openClaimFixture>>;

interface WiredSchedule {
  readonly fixture: ClaimFixture;
  readonly box: BudgetFixture;
  readonly host: RunningHost;
  readonly client: HostClient;
  readonly token: string;
  readonly projectId: string;
  readonly projectIdB: string;
  readonly batchId: string;
  readonly runId: string;
  readonly attempt: AttemptRecord;
  readonly startCommandId: string;
  readonly tablesBefore: Record<string, unknown[]>;
}

let activeHost: RunningHost | undefined;
let activeFixture: ClaimFixture | undefined;

afterEach(async () => {
  const host = activeHost;
  activeHost = undefined;
  if (host !== undefined) {
    // This fixture seeds synthetic process identities and never launches a process.
    // Explicitly retire its leases before the production stop gate checks persisted occupancy.
    activeFixture!.box.session.transactWrite('fixture.retireSyntheticOccupancy', () => {
      activeFixture!.box.session.database.prepare('DELETE FROM workspace_leases').run();
    });
    await host.close();
  }
  const fixture = activeFixture;
  activeFixture = undefined;
  if (fixture !== undefined) {
    fixture.box.close();
  }
});

/** 认领 t-1 并推进到 executing，再注入三条旧 owner 迟到通知（只写诊断）。 */
function seedAttemptWithDiagnostics(fixture: ClaimFixture): AttemptRecord {
  const box = fixture.box;
  const attempt = fixture.store().claimTask(fixture.input()).receipt.attempt;
  const resourceIdentity = {
    projectId: attempt.projectId,
    attemptId: attempt.id,
    owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId,
    executionVersion: attempt.executionVersion,
  };
  box.session.transactWrite('launch', () => {
    createSqliteExecutionAccess(box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
      projectId: attempt.projectId,
      batchId: fixture.ids.batchId,
      runId: attempt.runId,
      startKey: attempt.id,
    });
    const resources = createSqliteWorkResourceAccess(box.session, {
      workspaceAuthority: fixture.authority,
      nowUtcMs: () => NOW,
    });
    resources.beginLaunchInTransaction(resourceIdentity);
    resources.confirmLaunchInTransaction(resourceIdentity, {
      launchId: '10000000-0000-4000-8000-0000000000f8',
      pid: 128,
      processGroupId: 128,
      startTime: 'start-f008',
    });
  });
  const lifecycle = createSqliteAttemptLifecycleStore(box.session, {
    workspaceAuthority: fixture.authority,
    nowUtcMs: () => NOW + 1,
  });
  const identity = { ...resourceIdentity, runId: attempt.runId, taskId: attempt.taskId };
  expect(lifecycle.apply({ ...identity, notificationId: 'started', kind: 'executing' }))
    .toMatchObject({ disposition: 'applied' });
  for (let index = 0; index < 3; index += 1) {
    expect(lifecycle.apply({
      ...identity,
      owner: 'stale-owner',
      notificationId: `late-${index}`,
      kind: 'runtime_completed',
      exitCode: 0,
      evidenceRef: attempt.inputRef,
    })).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
  }
  return attempt;
}

async function openWiredSchedule(): Promise<WiredSchedule> {
  const fixture = await openClaimFixture([[], ['t-1']]);
  activeFixture = fixture;
  const box = fixture.box;

  // 第二个项目：跨项目目标折叠（不泄漏存在性）的对照。
  const registeredB = await box.submit('project.register', {
    repositoryPath: box.box.repoDirB,
    displayName: 'F-008 Repo B',
    description: null,
    labels: [],
  }, { scope: { kind: 'registration' } });
  if (registeredB.status !== 'completed') {
    throw new Error(`夹具项目 B 注册失败：${JSON.stringify(registeredB)}`);
  }
  const projectIdB = (registeredB.result as { project: { id: string } }).project.id;

  const startRow = box.session.database
    .prepare("SELECT command_id FROM command_receipts WHERE operation = 'execution.start'")
    .get() as { command_id: string } | undefined;
  if (startRow === undefined) {
    throw new Error('夹具缺少 execution.start 回执');
  }

  const host = await startHost({
    dataRoot: box.box.dataRoot,
    capabilityCatalog: box.box.capabilityCatalog,
    env: {},
  });
  activeHost = host;
  const token = readFileSync(join(box.box.dataRoot, 'host', 'auth.token'), 'utf8');
  const client = await connectToHost({ canonicalRoot: box.box.dataRoot });
  // Seed a query fixture only after startup recovery; it is not a crashed old owner.
  const attempt = seedAttemptWithDiagnostics(fixture);
  const tablesBefore = fixture.snapshot();
  return {
    fixture,
    box,
    host,
    client,
    token,
    projectId: box.projectId,
    projectIdB,
    batchId: fixture.ids.batchId,
    runId: fixture.ids.runId,
    attempt,
    startCommandId: startRow.command_id,
    tablesBefore,
  };
}

function expectProtocolError(error: unknown, code: string): HostProtocolError {
  expect(isHostProtocolError(error)).toBe(true);
  const protocolError = error as HostProtocolError;
  expect(protocolError.code).toBe(code);
  return protocolError;
}

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('应当以错误拒绝，实际成功返回');
}

/** 错误公开面（存在性/归属不泄漏的逐字段比较基准）。 */
function errorBodyFace(body: unknown): unknown {
  const parsed = body as { error?: Record<string, unknown> };
  return {
    code: parsed.error?.code,
    operation: parsed.error?.operation,
    message: parsed.error?.message,
    details: parsed.error?.details,
  };
}

/* ------------------------------------------------------------------ *
 * A. 真实 Host + HostClient 纵向：合法查询与只读/身份关联
 * ------------------------------------------------------------------ */

describe('F-008 调度/审计查询 HostClient 纵向（真实 Host + SQLite）', () => {
  it('握手宣告三项查询能力；调度/Attempt/诊断分页读取与既有回执、事件身份关联；重放零副作用', async () => {
    const s = await openWiredSchedule();
    try {
      // 能力白名单：三项查询真实接线并通过握手双向核验。
      expect(s.client.handshake.capabilities.application.queries).toEqual(
        expect.arrayContaining([
          'execution.run.schedule',
          'execution.attempts.list',
          'execution.attempt.diagnostics',
        ]),
      );

      // 1) execution.run.schedule：Run 身份 + 派生就绪评估 + 占用审计。
      const schedule = await s.client.getRunScheduleStatus(s.projectId, s.runId);
      expect(schedule.schemaVersion).toBe(5);
      expect(schedule.scope).toBe('run-schedule');
      expect(schedule.run).toMatchObject({
        id: s.runId,
        projectId: s.projectId,
        batchId: s.batchId,
        featureId: s.box.featureId,
        purpose: 'execute',
        status: 'queued',
        startedAt: null,
        endedAt: null,
      });
      // 本装配未接线调度器消费者：认领持有占用，如实 resource_busy，不伪造 ready。
      expect(schedule.schedule.reason).toBe('resource_busy');
      expect(schedule.schedule.readyTaskIds).toEqual([]);
      expect(schedule.tasks.map((task) => task.taskId)).toEqual(['t-1', 't-2']);
      expect(schedule.tasks[0]).toMatchObject({
        status: 'running',
        reason: 'resource_busy',
        latestAttempt: {
          id: s.attempt.id,
          number: 1,
          status: 'executing',
          executionStage: 'runtime',
        },
      });
      expect(schedule.tasks[1]).toMatchObject({ status: 'pending', reason: 'dependency_pending' });
      expect(schedule.occupancy).toHaveLength(3);
      expect(schedule.occupancy.map((lease) => lease.resourceKind)).toEqual([
        'global',
        'project',
        'workspace',
      ]);
      for (const lease of schedule.occupancy) {
        expect(lease).toMatchObject({
          attemptId: s.attempt.id,
          runId: s.runId,
          state: 'held',
          processIdentity: true,
        });
      }
      expect(schedule.occupancy[0]?.resourceKey).toBe('global:execution');
      expect(schedule.occupancy[2]?.resourceKey).toMatch(/^workspace:[0-9a-f]{64}$/);

      // 2) execution.attempts.list：已知阶段/身份保留，未知为 null，无快照正文。
      const attempts = await s.client.listExecutionAttempts(s.projectId, 't-1');
      expect(attempts.scope).toBe('attempt-list');
      expect(attempts.records).toHaveLength(1);
      expect(attempts.records[0]).toMatchObject({
        id: s.attempt.id,
        projectId: s.projectId,
        runId: s.runId,
        taskId: 't-1',
        number: 1,
        status: 'executing',
        executionStage: 'runtime',
        exitCode: null,
        durationMs: null,
        usageSummary: null,
      });
      expect(attempts.records[0]?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(attempts.records[0]).not.toHaveProperty('inputSnapshot');
      expect(attempts.nextCursor).toBeNull();
      const emptyPage = await s.client.listExecutionAttempts(s.projectId, 't-2');
      expect(emptyPage).toMatchObject({ records: [], nextCursor: null });

      // 3) execution.attempt.diagnostics：有界分页 + 受控游标链（重放顺序稳定）。
      const page1 = await s.client.listAttemptDiagnostics(s.projectId, s.attempt.id, { limit: 2 });
      expect(page1.scope).toBe('attempt-diagnostic-list');
      expect(page1.records).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.nextCursor!.startsWith(PLAN_LIST_CURSOR_PREFIX)).toBe(true);
      const page2 = await s.client.listAttemptDiagnostics(s.projectId, s.attempt.id, {
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.records).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      const diagnosticIds = [...page1.records, ...page2.records].map((record) => record.id);
      expect(new Set(diagnosticIds).size).toBe(3);
      for (const record of [...page1.records, ...page2.records]) {
        expect(record).toMatchObject({
          projectId: s.projectId,
          attemptId: s.attempt.id,
          reason: 'stale_execution_identity',
        });
        expect(record.notificationDigest).toMatch(/^[0-9a-f]{64}$/);
      }
      // 跨 Task 重放游标：invalid_cursor（绝不当从零读取）。
      const replayError = expectProtocolError(
        await rejectionOf(() =>
          s.client.listExecutionAttempts(s.projectId, 't-2', { cursor: page1.nextCursor! })
        ),
        'invalid_input',
      );
      expect(replayError.details).toMatchObject({ reason: 'invalid_cursor' });

      // 4) 公开面脱敏：不含制品正文、其他路径或数据根。
      const serialized = JSON.stringify({ schedule, attempts, page1, page2 });
      expect(serialized).not.toContain(s.box.box.repoDirA);
      expect(serialized).not.toContain(s.box.box.dataRoot);
      expect(serialized).not.toContain(s.box.box.root);

      // 5) 既有命令回执/状态事件与本项读取的写入身份关联：
      // execution.start 的 accepted 回执经既有 receipts.get 通道可读，runId/
      // batchId 与调度查询一致；run.dispatched 事件聚合即本 Run。
      const receipt = await s.client.getReceipt(s.startCommandId);
      expect(receipt.status).toBe('accepted');
      if (receipt.status !== 'accepted' || !('runId' in receipt)) {
        throw new Error('expected Work accepted receipt');
      }
      expect(receipt.operation).toBe('execution.start');
      expect(receipt.runId).toBe(schedule.run.id);
      expect(receipt.batchId).toBe(schedule.run.batchId);
      const dispatched = s.box.session.database
        .prepare("SELECT aggregate_id FROM state_events WHERE event_type = 'execution.run.dispatched'")
        .all() as { aggregate_id: string }[];
      expect(dispatched.map((row) => row.aggregate_id)).toContain(s.runId);
      const claimed = s.box.session.database
        .prepare("SELECT aggregate_id FROM state_events WHERE event_type = 'task.claimed'")
        .all() as { aggregate_id: string }[];
      expect(claimed.map((row) => row.aggregate_id)).toContain('t-1');
      // 既有快照查询（同一数据根、同一授权装配）仍可用且水位覆盖上述事件。
      const snapshot = await s.client.getSnapshot({ kind: 'project', projectId: s.projectId });
      expect(snapshot.scope).toEqual({ kind: 'project', projectId: s.projectId });
      expect(snapshot.watermark.cursor.startsWith('evcur_v1_')).toBe(true);

      // 6) 查询重放零副作用：全部查询后持久表与查询前逐字节一致。
      expect(s.fixture.snapshot()).toEqual(s.tablesBefore);
    } finally {
      s.client.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * B. HTTP 传输面负例（真实 Host，原始回环请求）
 * ------------------------------------------------------------------ */

describe('F-008 调度/审计查询 HTTP 负例（真实 Host）', () => {
  it('未认证/伪造凭据一律 401 且响应体不可区分', async () => {
    const s = await openWiredSchedule();
    try {
      const path = `/v1/runs/${s.runId}/schedule?projectId=${s.projectId}`;
      const missing = await loopbackRequest({ port: s.host.port, method: 'GET', path });
      const wrong = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path,
        token: '0'.repeat(64),
      });
      for (const response of [missing, wrong]) {
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: { code: 'unauthorized', operation: 'execution.run.schedule' },
        });
      }
      expect(missing.bodyText).toBe(wrong.bodyText);
      const attempts401 = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path: `/v1/attempts?projectId=${s.projectId}&taskId=t-1`,
      });
      expect(attempts401.statusCode).toBe(401);
    } finally {
      s.client.close();
    }
  });

  it('未知/重复/缺失参数与非分页取值一律 400 且定位 query.<字段>，不触碰业务状态', async () => {
    const s = await openWiredSchedule();
    try {
      const base = `/v1/attempts?projectId=${s.projectId}&taskId=t-1`;
      const badCases: Array<{ path: string; reason: string; field?: string }> = [
        { path: `${base}&foo=1`, reason: 'unknown_query_parameter', field: 'query.foo' },
        { path: `${base}&limit=2&limit=3`, reason: 'duplicate_query_parameter', field: 'query.limit' },
        { path: `${base}&limit=1.5`, reason: 'invalid_integer', field: 'query.limit' },
        { path: `${base}&limit=abc`, reason: 'invalid_integer', field: 'query.limit' },
        { path: `/v1/attempts?taskId=t-1`, reason: 'missing_project_id', field: 'query.projectId' },
        { path: `/v1/attempts?projectId=${s.projectId}`, reason: 'missing_task_id', field: 'query.taskId' },
        { path: `/v1/runs/${s.runId}/schedule`, reason: 'missing_project_id', field: 'query.projectId' },
        { path: `/v1/attempts/${s.attempt.id}/diagnostics`, reason: 'missing_project_id', field: 'query.projectId' },
        { path: `/v1/attempts/${s.attempt.id}/diagnostics?projectId=${s.projectId}&cursor=1`, reason: 'invalid_cursor' },
      ];
      for (const testCase of badCases) {
        const response = await loopbackRequest({
          port: s.host.port,
          method: 'GET',
          path: testCase.path,
          token: s.token,
        });
        expect(response.statusCode).toBe(400);
        const body = response.json() as { error: Record<string, unknown> };
        expect(body.error.code).toBe('invalid_input');
        expect((body.error.details as Record<string, unknown>).reason).toBe(testCase.reason);
        if (testCase.field !== undefined) {
          expect((body.error.details as Record<string, unknown>).field).toBe(testCase.field);
        }
      }
      // limit 范围（1..200）由 Core 复核：0/201 同样 400 invalid_input。
      for (const limit of [0, 201]) {
        const response = await loopbackRequest({
          port: s.host.port,
          method: 'GET',
          path: `${base}&limit=${limit}`,
          token: s.token,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: 'invalid_input' } });
      }
      // 未冻结的路由形态一律 404 unknown_operation；集合根只允许 GET。
      for (const path of [
        `/v1/runs/${s.runId}`,
        `/v1/attempts/${s.attempt.id}`,
        `/v1/attempts/${s.attempt.id}/diagnostics/extra`,
        `/v1/runs/${s.runId}/schedule/extra`,
      ]) {
        const response = await loopbackRequest({
          port: s.host.port,
          method: 'GET',
          path,
          token: s.token,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'unknown_operation' } });
      }
      const post = await loopbackRequest({
        port: s.host.port,
        method: 'POST',
        path: '/v1/attempts',
        token: s.token,
        body: {},
      });
      expect(post.statusCode).toBe(405);
      // GET 带体 400（协议纪律沿用）。
      const withBody = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path: base,
        token: s.token,
        body: {},
      });
      expect(withBody.statusCode).toBe(400);
      // 全程负例零业务副作用。
      expect(s.fixture.snapshot()).toEqual(s.tablesBefore);
    } finally {
      s.client.close();
    }
  });

  it('跨项目与不存在实体折叠为逐字段相同的 not_found，错误体不泄漏身份/路径', async () => {
    const s = await openWiredSchedule();
    try {
      const foreignRun = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path: `/v1/runs/${s.runId}/schedule?projectId=${s.projectIdB}`,
        token: s.token,
      });
      const missingRun = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path: `/v1/runs/${randomUUID()}/schedule?projectId=${s.projectIdB}`,
        token: s.token,
      });
      expect(foreignRun.statusCode).toBe(404);
      expect(missingRun.statusCode).toBe(404);
      expect(errorBodyFace(foreignRun.json())).toEqual(errorBodyFace(missingRun.json()));
      expect(foreignRun.json()).toMatchObject({
        error: {
          code: 'not_found',
          operation: 'execution.run.schedule',
          details: { reason: 'execution_entity_not_found' },
        },
      });

      const foreignAttempts = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path: `/v1/attempts?projectId=${s.projectIdB}&taskId=t-1`,
        token: s.token,
      });
      const missingAttempts = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path: `/v1/attempts?projectId=${s.projectIdB}&taskId=no-such-task`,
        token: s.token,
      });
      expect(foreignAttempts.statusCode).toBe(404);
      expect(errorBodyFace(foreignAttempts.json())).toEqual(errorBodyFace(missingAttempts.json()));

      const foreignDiagnostics = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path: `/v1/attempts/${s.attempt.id}/diagnostics?projectId=${s.projectIdB}`,
        token: s.token,
      });
      const missingDiagnostics = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path: `/v1/attempts/${randomUUID()}/diagnostics?projectId=${s.projectIdB}`,
        token: s.token,
      });
      expect(foreignDiagnostics.statusCode).toBe(404);
      expect(errorBodyFace(foreignDiagnostics.json())).toEqual(
        errorBodyFace(missingDiagnostics.json()),
      );

      // 错误体脱敏：不回显其他项目身份、Run/Attempt 身份、制品正文或绝对路径。
      const combined = [
        foreignRun,
        missingRun,
        foreignAttempts,
        missingAttempts,
        foreignDiagnostics,
        missingDiagnostics,
      ]
        .map((response) => response.bodyText)
        .join('\n');
      expect(combined).not.toContain(s.projectIdB);
      expect(combined).not.toContain(s.projectId);
      expect(combined).not.toContain(s.runId);
      expect(combined).not.toContain(s.attempt.id);
      expect(combined).not.toContain(s.box.box.repoDirA);
      expect(combined).not.toContain(s.box.box.dataRoot);
      expect(combined).not.toContain(s.box.box.root);

      // HostClient 错误映射：跨项目目标同样 not_found（不折算 forbidden/存在性）。
      const clientError = expectProtocolError(
        await rejectionOf(() => s.client.getRunScheduleStatus(s.projectIdB, s.runId)),
        'not_found',
      );
      expect(clientError.details).toMatchObject({ reason: 'execution_entity_not_found' });
      expectProtocolError(
        await rejectionOf(() => s.client.listExecutionAttempts(s.projectIdB, 't-1')),
        'not_found',
      );
      expectProtocolError(
        await rejectionOf(() => s.client.listAttemptDiagnostics(s.projectIdB, s.attempt.id)),
        'not_found',
      );
      expect(s.fixture.snapshot()).toEqual(s.tablesBefore);
    } finally {
      s.client.close();
    }
  });

  it('客户端零网络输入把关：非法身份/游标在发请求前 invalid_input', async () => {
    const s = await openWiredSchedule();
    try {
      const cases: Array<() => Promise<unknown>> = [
        () => s.client.getRunScheduleStatus('bad id!', s.runId),
        () => s.client.getRunScheduleStatus(s.projectId, 'bad id!'),
        () => s.client.listExecutionAttempts(s.projectId, 'bad id!'),
        () => s.client.listExecutionAttempts(s.projectId, 't-1', { limit: 0 }),
        () => s.client.listExecutionAttempts(s.projectId, 't-1', { limit: 201 }),
        () => s.client.listExecutionAttempts(s.projectId, 't-1', { cursor: 'garbage' }),
        () => s.client.listAttemptDiagnostics(s.projectId, 'bad id!'),
        () => s.client.listAttemptDiagnostics(s.projectId, s.attempt.id, { cursor: 'evcur_v1_x' }),
      ];
      for (const run of cases) {
        expectProtocolError(await rejectionOf(run), 'invalid_input');
      }
      expect(s.fixture.snapshot()).toEqual(s.tablesBefore);
    } finally {
      s.client.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C. 线校验器（纯函数）：冻结形状接受与畸形/越界拒绝
 * ------------------------------------------------------------------ */

const ISO = '2030-03-25T07:00:00.000Z';

function canonicalAttemptRecord(): Record<string, unknown> {
  return {
    id: 'att-1',
    projectId: 'proj-1',
    featureId: 'feat-1',
    runId: 'run-1',
    taskId: 't-1',
    number: 2,
    owner: 'owner-1',
    hostInstanceId: 'host-1',
    executionVersion: 1,
    leaseUntil: ISO,
    status: 'executing',
    executionStage: 'runtime',
    inputDigest: 'a'.repeat(64),
    inputRef: 'artifact-1',
    sessionId: null,
    invocationId: null,
    codeRef: null,
    errorKind: null,
    diagnosticRef: null,
    startedAt: ISO,
    endedAt: null,
    durationMs: null,
    exitCode: null,
    usageSummary: {
      schemaVersion: 1,
      inputTokens: 12,
      outputTokens: null,
      costMicros: null,
      currency: null,
    },
    revision: 3,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function canonicalRunSchedule(): Record<string, unknown> {
  return {
    schemaVersion: 5,
    scope: 'run-schedule',
    run: {
      id: 'run-1',
      projectId: 'proj-1',
      batchId: 'batch-1',
      featureId: 'feat-1',
      purpose: 'execute',
      workKey: 'b'.repeat(64),
      dispatchOrdinal: 1,
      status: 'queued',
      reason: null,
      startedAt: null,
      endedAt: null,
      createdAt: ISO,
    },
    schedule: { reason: 'ready', diagnostic: null, readyTaskIds: ['t-1'], handoff: null },
    tasks: [
      {
        taskId: 't-1',
        status: 'pending',
        reason: 'ready',
        dependencyIds: [],
        executionVersion: 0,
        manualBlock: false,
        latestAttempt: null,
      },
    ],
    occupancy: [
      {
        id: 'lease-1',
        attemptId: 'att-1',
        runId: 'run-1',
        resourceKind: 'workspace',
        resourceKey: `workspace:${'c'.repeat(64)}`,
        state: 'quarantined',
        leaseUntil: ISO,
        processIdentity: false,
      },
    ],
  };
}

function canonicalAttemptList(): Record<string, unknown> {
  return {
    schemaVersion: 5,
    scope: 'attempt-list',
    records: [canonicalAttemptRecord()],
    nextCursor: null,
    limit: 50,
  };
}

function canonicalDiagnostics(): Record<string, unknown> {
  return {
    schemaVersion: 5,
    scope: 'attempt-diagnostic-list',
    records: [
      {
        id: 'diag-1',
        projectId: 'proj-1',
        attemptId: 'att-1',
        notificationDigest: 'd'.repeat(64),
        reason: 'stale_execution_identity',
        occurredAt: ISO,
      },
    ],
    nextCursor: null,
    limit: 50,
  };
}

describe('F-008 调度/审计查询线校验器（纯函数）', () => {
  it('接受三种冻结形状并原样返回（含 null 未知纪律与占用审计）', () => {
    const schedule = canonicalRunSchedule();
    expect(validateRunScheduleStatusResultWire(schedule)).toEqual(schedule);
    const attempts = canonicalAttemptList();
    expect(validateAttemptListResultWire(attempts)).toEqual(attempts);
    const diagnostics = canonicalDiagnostics();
    expect(validateAttemptDiagnosticsResultWire(diagnostics)).toEqual(diagnostics);
    expect(validateAppQueryResponse('execution.run.schedule', schedule)).toEqual(schedule);
    expect(validateAppQueryResponse('execution.attempts.list', attempts)).toEqual(attempts);
    expect(
      validateAppQueryResponse('execution.attempt.diagnostics', diagnostics),
    ).toEqual(diagnostics);
  });

  it.each([
    ['未知顶层键', (value: any) => { value.extra = true; }],
    ['scope 不符', (value: any) => { value.scope = 'attempt-list'; }],
    ['Run 状态越出冻结词汇', (value: any) => { value.run.status = 'passed'; }],
    ['workKey 非摘要', (value: any) => { value.run.workKey = 'not-a-digest'; }],
    ['调度原因越出冻结词汇', (value: any) => { value.schedule.reason = 'done'; }],
    ['handoff 伪称', (value: any) => { value.schedule.handoff = 'auto_verified'; }],
    ['Task 携带策略正文', (value: any) => { value.tasks[0].executionConfig = { model: 'x' }; }],
    ['latestAttempt 阶段越出词汇', (value: any) => {
      value.tasks[0].latestAttempt = {
        id: 'att-1', number: 1, status: 'executing', executionStage: 'accepted',
        exitCode: null, durationMs: null, startedAt: ISO, endedAt: null, errorKind: null,
      };
    }],
    ['占用状态越出词汇', (value: any) => { value.occupancy[0].state = 'released'; }],
    ['占用携带路径字段', (value: any) => { value.occupancy[0].path = '/tmp/x'; }],
    ['processIdentity 泄漏身份正文', (value: any) => { value.occupancy[0].processIdentity = { pid: 1 }; }],
  ])('run.schedule 拒绝：%s（不泄漏响应内容）', (_name, mutate) => {
    const value = canonicalRunSchedule();
    mutate(value);
    expect(() => validateRunScheduleStatusResultWire(value)).toThrowError(
      expect.objectContaining({ code: 'response_malformed' }),
    );
  });

  it('run.schedule schemaVersion 不符单独分类 unsupported_schema_version', () => {
    const value = canonicalRunSchedule();
    value.schemaVersion = 99;
    expect(() => validateRunScheduleStatusResultWire(value)).toThrowError(
      expect.objectContaining({ code: 'unsupported_schema_version' }),
    );
  });

  it.each([
    ['Attempt 携带快照正文', (value: any) => { value.records[0].inputSnapshot = { secret: true }; }],
    ['Attempt 状态越出词汇', (value: any) => { value.records[0].status = 'passed'; }],
    ['inputDigest 非摘要', (value: any) => { value.records[0].inputDigest = 'x'; }],
    ['用量未知维度填零冒充', (value: any) => { value.records[0].usageSummary.inputTokens = -1; }],
    ['用量形状缺键', (value: any) => { delete value.records[0].usageSummary.currency; }],
    ['耗时为负数', (value: any) => { value.records[0].durationMs = -5; }],
    ['游标前缀不符', (value: any) => { value.nextCursor = 'evcur_v1_x'; }],
    ['limit 非正整数', (value: any) => { value.limit = 0; }],
  ])('attempts.list 拒绝：%s', (_name, mutate) => {
    const value = canonicalAttemptList();
    mutate(value);
    expect(() => validateAttemptListResultWire(value)).toThrowError(
      expect.objectContaining({ code: 'response_malformed' }),
    );
  });

  it.each([
    ['诊断原因越出冻结词汇', (value: any) => { value.records[0].reason = 'policy_violation'; }],
    ['诊断携带原通知正文', (value: any) => { value.records[0].message = 'late result body'; }],
    ['notificationDigest 非摘要', (value: any) => { value.records[0].notificationDigest = 'z'; }],
    ['occurredAt 非 ISO UTC', (value: any) => { value.records[0].occurredAt = 'yesterday'; }],
    ['scope 不符', (value: any) => { value.scope = 'attempt-list'; }],
  ])('attempt.diagnostics 拒绝：%s', (_name, mutate) => {
    const value = canonicalDiagnostics();
    mutate(value);
    expect(() => validateAttemptDiagnosticsResultWire(value)).toThrowError(
      expect.objectContaining({ code: 'response_malformed' }),
    );
  });
});
