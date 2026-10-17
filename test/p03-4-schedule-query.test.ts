/**
 * P03-4 / F-007：Run 调度原因、Task 派生就绪视图与 Attempt/占用审计读取
 * （Core 应用层直接调用，不经 HTTP；Host 接线属 F-008）。
 *
 * 验收面（.dag_context.json F-007）：
 * 1. 复用既有查询端口与分页规范，返回 Project/Feature/Run/Task/Attempt 关联
 *    身份、稳定候选顺序、逐任务 blocked 原因、Run 汇总原因、executionStage
 *    及占用 held/quarantined 状态。
 * 2. 状态来自 SQLite 与同一就绪判定规则（evaluateTaskDag），不从日志或内存
 *    队列推断；关闭并重开数据库后查询一致；ready/blocked 不落库为第二套
 *    可写 Task 状态。
 * 3. Attempt 与诊断列表有默认/最大分页限制与稳定游标；非法筛选/游标和跨
 *    项目归属拒绝（不泄漏存在性）；已知退出/耗时保留，未知值为空；不暴露
 *    凭据正文或未经授权的内部路径。
 * 4. 正常、准备失败、迟到诊断、等待人审、依赖失败、预算耗尽与隔离占用均
 *    有定向查询测试；查询本身不创建 Attempt、不扣预算、不续租、不启动工作。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BUDGET, NOW, openBudgetFixture } from './helpers/p03-3/budget-fixture.ts';
import type { BudgetFixture } from './helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../packages/core/src/adapters/sqlite/execution-store.ts';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createQueryService } from '../packages/core/src/application/query-service.ts';
import type { QueryService } from '../packages/core/src/application/query-service.ts';
import { computeDataRootIdentity } from '../packages/core/src/ports/path-service.ts';
import { isPublicError, WIRE_MESSAGE_SCHEMA_VERSION } from '../packages/core/src/ports/commands.ts';
import type { PublicError } from '../packages/core/src/ports/commands.ts';
import {
  PLAN_LIST_DEFAULT_LIMIT,
  PLAN_LIST_MAX_LIMIT,
  PLAN_LIST_CURSOR_PREFIX,
} from '../packages/core/src/ports/queries.ts';
import { EXECUTION_RUN_NOT_READY_REASON } from '../packages/core/src/ports/execution-start.ts';
import { createRestrictedPrincipal, scopeAllowlist } from './helpers/p02-2/principals.ts';
import type { AttemptRecord } from '../packages/core/src/ports/attempt-store.ts';
import type { PreparedExecutionInputGroup } from '../packages/core/src/ports/execution-input-prepare.ts';

/** 与生产装配同一入口：真实 SQLite 查询门面 + 授权 QueryService（固定时钟）。 */
function assembleQueries(box: BudgetFixture): QueryService {
  const queryStore = createSqliteQueryStore(box.session);
  const stateStore = createSqliteStateStore(box.session);
  return createQueryService({
    projectReads: queryStore,
    snapshots: queryStore,
    eventReads: queryStore,
    stateStore,
    configurationService: createConfigurationService({
      stateStore,
      capabilityCatalog: box.box.capabilityCatalog,
    }),
    planReads: queryStore,
    executionBudgetReads: queryStore,
    scheduleReads: queryStore,
    workspaceReads: queryStore,
    workSessionReads: queryStore,
    taskEvidenceReads: queryStore,
    artifacts: createSqliteArtifactStore(box.session),
    artifactFiles: createArtifactFileStore({ dataRoot: box.box.dataRoot }),
    dataRootIdentity: computeDataRootIdentity(box.box.dataRoot),
    nowUtcMs: () => NOW,
  });
}

async function scheduleFixture(edges = [[], ['t-1'], ['t-2']] as string[][]) {
  const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
  const box = await openBudgetFixture({ ...BUDGET, batch }, edges.map((dependsOn, i) => ({
    id: `t-${i + 1}`, title: `Task ${i + 1}`, acceptance: { criteria: ['schedule query'] }, dependsOn,
  })));
  const ids = await box.start();
  return { box, ids, queries: () => assembleQueries(box) };
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

/** 直接向 t-1 追加历史 Attempt（持久夹具事实；不经过任何生产认领通道）。 */
function insertHistoricalAttempt(
  box: BudgetFixture,
  ids: { readonly projectId: string; readonly runId: string },
  snapshot: PreparedExecutionInputGroup,
  number: number,
  overrides: { readonly exitCode?: number | null; readonly durationMs?: number | null; readonly status?: string } = {},
): void {
  box.session.database.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
    number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest,
    input_ref, status, execution_stage, started_at, ended_at, duration_ms, exit_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner-1', 'host-1', 1, ?, ?, ?, ?, ?, 'runtime', ?, ?, ?, ?)`)
    .run(`audit-${snapshot.taskId}-attempt-${number}`, NOW, NOW, ids.projectId, box.featureId, ids.runId, snapshot.taskId,
      number, NOW + 1000, JSON.stringify(snapshot), snapshot.digests.snapshotDigest,
      snapshot.group.snapshot.artifactId, overrides.status ?? 'failed', NOW, NOW,
      overrides.durationMs ?? null, overrides.exitCode ?? null);
}

/** 篡改受控游标载荷（保持前缀/版本/绑定指纹不变，仅替换 id 字段）。 */
function tamperCursorId(cursor: string, id: string): string {
  const body = cursor.slice(PLAN_LIST_CURSOR_PREFIX.length);
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  payload.id = id;
  return `${PLAN_LIST_CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

describe('P03-4 / F-007 Run schedule & attempt audit queries', () => {
  it('returns the ready view with stable candidate order, read-only and reopen-consistent', async () => {
    const f = await scheduleFixture();
    try {
      const before = f.box.snapshot();
      const queries = f.queries();
      const result = await queries.getRunScheduleStatus(f.box.owner, {
        projectId: f.ids.projectId,
        runId: f.ids.runId,
      });
      expect(result.schemaVersion).toBe(WIRE_MESSAGE_SCHEMA_VERSION);
      expect(result.scope).toBe('run-schedule');
      expect(result.run).toMatchObject({
        id: f.ids.runId,
        projectId: f.ids.projectId,
        batchId: f.ids.batchId,
        featureId: f.box.featureId,
        purpose: 'execute',
        status: 'queued',
        // 本夹具未装配调度器且不产生持久控制原因（如实为 null，不伪造缺口）。
        reason: null,
        startedAt: null,
        endedAt: null,
      });
      expect(result.run.workKey).toMatch(/^[0-9a-f]{64}$/);
      // 稳定候选顺序 = 拓扑序；逐任务 blocked 原因与 Run 汇总原因同源。
      expect(result.schedule).toEqual({ reason: 'ready', diagnostic: null, readyTaskIds: ['t-1'], handoff: null });
      expect(result.tasks.map((task) => [task.taskId, task.reason])).toEqual([
        ['t-1', 'ready'],
        ['t-2', 'dependency_pending'],
        ['t-3', 'dependency_pending'],
      ]);
      expect(result.tasks[0]).toMatchObject({
        status: 'pending',
        executionVersion: 0,
        manualBlock: false,
        dependencyIds: [],
        latestAttempt: null,
      });
      expect(result.tasks[1]?.dependencyIds).toEqual(['t-1']);
      expect(result.tasks[2]?.dependencyIds).toEqual(['t-2']);
      expect(result.occupancy).toEqual([]);
      const attempts = await queries.listExecutionAttempts(f.box.owner, {
        projectId: f.ids.projectId,
        taskId: 't-1',
      });
      expect(attempts).toMatchObject({
        scope: 'attempt-list',
        records: [],
        nextCursor: null,
        limit: PLAN_LIST_DEFAULT_LIMIT,
      });
      // 查询零写入：不创建 Attempt、不扣预算、不续租、不发事件。
      expect(f.box.snapshot()).toEqual(before);
      // 关闭并重开数据库后查询一致（状态来自 SQLite，不是内存队列）。
      f.box.reopen();
      const reopened = await f.queries().getRunScheduleStatus(f.box.owner, {
        projectId: f.ids.projectId,
        runId: f.ids.runId,
      });
      expect(reopened).toEqual(result);
    } finally {
      f.box.close();
    }
  });

  it('retains a preparation failure with stage/errorKind and never fabricates exit data', async () => {
    const f = await openClaimFixture([[], ['t-1']]);
    try {
      const attempt = f.store().claimTask(f.input()).receipt.attempt;
      const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, {
        workspaceAuthority: f.authority,
        nowUtcMs: () => NOW + 1,
      });
      lifecycle.apply({
        projectId: attempt.projectId,
        runId: attempt.runId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
        owner: attempt.owner,
        hostInstanceId: attempt.hostInstanceId,
        executionVersion: attempt.executionVersion,
        notificationId: 'prep-failed',
        kind: 'preparation_failed',
        errorKind: 'configuration',
        evidenceRef: attempt.inputRef,
      });
      const before = f.snapshot();
      const queries = assembleQueries(f.box);
      const page = await queries.listExecutionAttempts(f.box.owner, {
        projectId: f.ids.projectId,
        taskId: 't-1',
      });
      expect(page.records).toHaveLength(1);
      expect(page.records[0]).toMatchObject({
        id: attempt.id,
        projectId: f.ids.projectId,
        featureId: f.box.featureId,
        runId: f.ids.runId,
        taskId: 't-1',
        number: 1,
        owner: 'owner-1',
        hostInstanceId: 'host-1',
        executionVersion: 1,
        status: 'failed',
        executionStage: 'preflight',
        errorKind: 'configuration',
        diagnosticRef: attempt.inputRef,
        exitCode: null,
        durationMs: null,
        startedAt: null,
        // 准备失败在应用时刻终结：endedAt 保留已知事实，startedAt 未知为空。
        endedAt: new Date(NOW + 1).toISOString(),
        codeRef: null,
        sessionId: null,
        invocationId: null,
        usageSummary: null,
      });
      expect(page.nextCursor).toBeNull();
      const schedule = await queries.getRunScheduleStatus(f.box.owner, {
        projectId: f.ids.projectId,
        runId: f.ids.runId,
      });
      expect(schedule.schedule.reason).toBe('dependency_failed');
      expect(schedule.tasks.find((task) => task.taskId === 't-1')).toMatchObject({
        reason: 'dependency_failed',
        status: 'failed',
        latestAttempt: {
          id: attempt.id,
          number: 1,
          status: 'failed',
          executionStage: 'preflight',
          exitCode: null,
          durationMs: null,
        },
      });
      // 明确未启动的准备失败已安全释放：无 held/quarantined 占用。
      expect(schedule.occupancy).toEqual([]);
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.box.close();
    }
  });

  it('lists late-notification diagnostics with bounded stable pagination', async () => {
    const f = await openClaimFixture([[], ['t-1']]);
    try {
      const attempt = f.store().claimTask(f.input()).receipt.attempt;
      const resourceIdentity = {
        projectId: attempt.projectId,
        attemptId: attempt.id,
        owner: attempt.owner,
        hostInstanceId: attempt.hostInstanceId,
        executionVersion: attempt.executionVersion,
      };
      f.box.session.transactWrite('launch', () => {
        createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
          projectId: attempt.projectId,
          batchId: f.ids.batchId,
          runId: attempt.runId,
          startKey: attempt.id,
        });
        const resources = createSqliteWorkResourceAccess(f.box.session, {
          workspaceAuthority: f.authority,
          nowUtcMs: () => NOW,
        });
        resources.beginLaunchInTransaction(resourceIdentity);
        resources.confirmLaunchInTransaction(resourceIdentity, {
          launchId: '10000000-0000-4000-8000-000000000001',
          pid: 123,
          processGroupId: 123,
          startTime: 'start-1',
        });
      });
      const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, {
        workspaceAuthority: f.authority,
        nowUtcMs: () => NOW + 1,
      });
      const identity = { ...resourceIdentity, runId: attempt.runId, taskId: attempt.taskId };
      expect(lifecycle.apply({ ...identity, notificationId: 'started', kind: 'executing' }))
        .toMatchObject({ disposition: 'applied' });
      // 五条迟到/越权通知（旧 owner）：只写诊断，不写业务状态。
      for (let i = 0; i < 5; i += 1) {
        expect(lifecycle.apply({
          ...identity,
          owner: 'other-owner',
          notificationId: `late-${i}`,
          kind: 'runtime_completed',
          exitCode: 0,
          evidenceRef: attempt.inputRef,
        })).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
      }
      const before = f.snapshot();
      const queries = assembleQueries(f.box);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 3; page += 1) {
        const result: Awaited<ReturnType<QueryService['listAttemptDiagnostics']>> =
          await queries.listAttemptDiagnostics(f.box.owner, {
            projectId: f.ids.projectId,
            attemptId: attempt.id,
            limit: 2,
            ...(cursor === null ? {} : { cursor }),
          });
        expect(result.scope).toBe('attempt-diagnostic-list');
        expect(result.limit).toBe(2);
        for (const record of result.records) {
          expect(record).toMatchObject({
            projectId: f.ids.projectId,
            attemptId: attempt.id,
            reason: 'stale_execution_identity',
            occurredAt: new Date(NOW + 1).toISOString(),
          });
          expect(record.notificationDigest).toMatch(/^[0-9a-f]{64}$/);
          seen.push(record.id);
        }
        cursor = result.nextCursor;
        if (cursor === null) break;
      }
      expect(cursor).toBeNull();
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      // 重读全程：同一游标链产出同一顺序（稳定分页）。
      const again: string[] = [];
      let againCursor: string | null = null;
      do {
        const result: Awaited<ReturnType<QueryService['listAttemptDiagnostics']>> =
          await queries.listAttemptDiagnostics(f.box.owner, {
            projectId: f.ids.projectId,
            attemptId: attempt.id,
            limit: 2,
            ...(againCursor === null ? {} : { cursor: againCursor }),
          });
        again.push(...result.records.map((record) => record.id));
        againCursor = result.nextCursor;
      } while (againCursor !== null);
      expect(again).toEqual(seen);
      // 诊断查询不追加诊断、不改业务事实。
      expect(f.snapshot()).toEqual(before);
      expect(f.box.session.database.prepare('SELECT count(*) AS n FROM attempt_notification_diagnostics').get())
        .toEqual({ n: 5 });
    } finally {
      f.box.close();
    }
  });

  it('reports waiting for human review, dependency failure and budget exhaustion from the same readiness rule', async () => {
    const f = await scheduleFixture();
    try {
      const db = f.box.session.database;
      const queries = f.queries();
      const input = { projectId: f.ids.projectId, runId: f.ids.runId };
      db.prepare("UPDATE tasks SET manual_block = 1 WHERE id = 't-1'").run();
      const blocked = await queries.getRunScheduleStatus(f.box.owner, input);
      expect(blocked.schedule.reason).toBe('waiting_approval');
      expect(blocked.schedule.readyTaskIds).toEqual([]);
      expect(blocked.tasks.map((task) => [task.taskId, task.reason])).toEqual([
        ['t-1', 'waiting_approval'],
        ['t-2', 'waiting_approval'],
        // 人审阻塞只直接影响直接后继；更下游按依赖未完成派生。
        ['t-3', 'dependency_pending'],
      ]);
      expect(blocked.tasks[0]?.manualBlock).toBe(true);

      db.prepare("UPDATE tasks SET manual_block = 0, status = 'failed' WHERE id = 't-1'").run();
      const failed = await queries.getRunScheduleStatus(f.box.owner, input);
      expect(failed.schedule.reason).toBe('dependency_failed');
      expect(failed.tasks.map((task) => [task.taskId, task.reason])).toEqual([
        ['t-1', 'dependency_failed'],
        ['t-2', 'dependency_failed'],
        // 失败只经直接依赖边传播；更下游按依赖未完成派生。
        ['t-3', 'dependency_pending'],
      ]);

      const g = await scheduleFixture();
      try {
        g.box.session.database.prepare('UPDATE execution_batches SET attempts_created = 2').run();
        const exhausted = await g.queries().getRunScheduleStatus(g.box.owner, {
          projectId: g.ids.projectId,
          runId: g.ids.runId,
        });
        expect(exhausted.schedule.reason).toBe('budget_exhausted');
        // 预算判定先于认领但后于依赖判定：只有依赖已满足的候选定位到预算。
        expect(exhausted.tasks.map((task) => [task.taskId, task.reason])).toEqual([
          ['t-1', 'budget_exhausted'],
          ['t-2', 'dependency_pending'],
          ['t-3', 'dependency_pending'],
        ]);
        expect(exhausted.schedule.readyTaskIds).toEqual([]);
      } finally {
        g.box.close();
      }
    } finally {
      f.box.close();
    }
  });

  it('audits held and quarantined occupancy without releasing or renewing it', async () => {
    const f = await openClaimFixture([[], ['t-1']]);
    try {
      const attempt = f.store().claimTask(f.input()).receipt.attempt;
      const resourceIdentity = {
        projectId: attempt.projectId,
        attemptId: attempt.id,
        owner: attempt.owner,
        hostInstanceId: attempt.hostInstanceId,
        executionVersion: attempt.executionVersion,
      };
      const queries = assembleQueries(f.box);
      const input = { projectId: f.ids.projectId, runId: f.ids.runId };
      const held = await queries.getRunScheduleStatus(f.box.owner, input);
      expect(held.schedule.reason).toBe('resource_busy');
      expect(held.occupancy).toHaveLength(3);
      expect(held.occupancy.map((lease) => lease.resourceKind)).toEqual(['global', 'project', 'workspace']);
      for (const lease of held.occupancy) {
        expect(lease).toMatchObject({
          attemptId: attempt.id,
          runId: f.ids.runId,
          state: 'held',
          leaseUntil: new Date(NOW + 1000).toISOString(),
          processIdentity: false,
        });
      }
      expect(held.occupancy[0]?.resourceKey).toBe('global:execution');
      expect(held.occupancy[1]?.resourceKey).toBe(`project:${f.ids.projectId}:work`);
      expect(held.occupancy[2]?.resourceKey).toMatch(/^workspace:[0-9a-f]{64}$/);
      expect(held.tasks.find((task) => task.taskId === 't-1')).toMatchObject({
        reason: 'resource_busy',
        status: 'running',
        latestAttempt: { id: attempt.id, number: 1, status: 'preparing', executionStage: 'preflight' },
      });

      // 隔离占用：过期/不确定只保留 quarantined，查询不释放、不续租。
      const before = f.snapshot();
      f.box.session.transactWrite('quarantine', () => {
        createSqliteWorkResourceAccess(f.box.session, {
          workspaceAuthority: f.authority,
          nowUtcMs: () => NOW,
        }).quarantineInTransaction(resourceIdentity);
      });
      const quarantined = await queries.getRunScheduleStatus(f.box.owner, input);
      expect(quarantined.schedule.reason).toBe('resource_busy');
      expect(quarantined.occupancy).toHaveLength(3);
      expect(quarantined.occupancy.every((lease) => lease.state === 'quarantined')).toBe(true);
      expect(f.snapshot()).not.toEqual(before);
      const afterQuery = f.snapshot();
      await queries.getRunScheduleStatus(f.box.owner, input);
      await queries.listExecutionAttempts(f.box.owner, { projectId: f.ids.projectId, taskId: 't-1' });
      expect(f.snapshot()).toEqual(afterQuery);
    } finally {
      f.box.close();
    }
  });

  it('paginates attempts with default/max limits and a bound stable cursor', async () => {
    const f = await openClaimFixture([[], []]);
    try {
      // 夹具已为两个 Task 发布准备好的输入制品组；直接复用其持久快照。
      const prepared = [f.input(0).inputSnapshot, f.input(1).inputSnapshot];
      insertHistoricalAttempt(f.box, f.ids, prepared[0]!, 1, { exitCode: 1, durationMs: 120 });
      insertHistoricalAttempt(f.box, f.ids, prepared[0]!, 2, { exitCode: 0, durationMs: 95 });
      insertHistoricalAttempt(f.box, f.ids, prepared[0]!, 3, { exitCode: null, durationMs: null });
      insertHistoricalAttempt(f.box, f.ids, prepared[0]!, 4, { exitCode: 2, durationMs: 41 });
      insertHistoricalAttempt(f.box, f.ids, prepared[0]!, 5, { exitCode: 0, durationMs: 38 });
      insertHistoricalAttempt(f.box, f.ids, prepared[1]!, 1, { exitCode: 0, durationMs: 10 });
      const queries = assembleQueries(f.box);
      const owner = f.box.owner;

      const all = await queries.listExecutionAttempts(owner, { projectId: f.ids.projectId, taskId: 't-1' });
      expect(all.limit).toBe(PLAN_LIST_DEFAULT_LIMIT);
      expect(all.records.map((record) => record.number)).toEqual([1, 2, 3, 4, 5]);
      expect(all.nextCursor).toBeNull();
      // 已知退出/耗时保留；未知值为空（不填零）。
      expect(all.records[0]).toMatchObject({ exitCode: 1, durationMs: 120 });
      expect(all.records[2]).toMatchObject({ exitCode: null, durationMs: null });
      expect(all.records[0]).not.toHaveProperty('inputSnapshot');

      const page1 = await queries.listExecutionAttempts(owner, {
        projectId: f.ids.projectId,
        taskId: 't-1',
        limit: 2,
      });
      expect(page1.records.map((record) => record.number)).toEqual([1, 2]);
      expect(page1.limit).toBe(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await queries.listExecutionAttempts(owner, {
        projectId: f.ids.projectId,
        taskId: 't-1',
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.records.map((record) => record.number)).toEqual([3, 4]);
      const page3 = await queries.listExecutionAttempts(owner, {
        projectId: f.ids.projectId,
        taskId: 't-1',
        limit: 2,
        cursor: page2.nextCursor!,
      });
      expect(page3.records.map((record) => record.number)).toEqual([5]);
      expect(page3.nextCursor).toBeNull();

      // 非法分页：越界/非整数/非数字 limit 与未知键一律 invalid_input。
      for (const limit of [0, PLAN_LIST_MAX_LIMIT + 1, 1.5, '2']) {
        await expectPublicError(
          () => queries.listExecutionAttempts(owner, { projectId: f.ids.projectId, taskId: 't-1', limit }),
          { code: 'invalid_input', operation: 'execution.attempts.list' },
        );
      }
      await expectPublicError(
        () => queries.listExecutionAttempts(owner, {
          projectId: f.ids.projectId,
          taskId: 't-1',
          filter: {},
        }),
        { code: 'invalid_input', operation: 'execution.attempts.list' },
      );
      // 非法游标：坏前缀/跨 Task 重放/篡改载荷一律 invalid_cursor，绝不当从零读取。
      await expectPublicError(
        () => queries.listExecutionAttempts(owner, {
          projectId: f.ids.projectId,
          taskId: 't-1',
          cursor: 'garbage',
        }),
        { code: 'invalid_input', operation: 'execution.attempts.list', reason: 'invalid_cursor' },
      );
      await expectPublicError(
        () => queries.listExecutionAttempts(owner, {
          projectId: f.ids.projectId,
          taskId: 't-2',
          cursor: page1.nextCursor!,
        }),
        { code: 'invalid_input', operation: 'execution.attempts.list', reason: 'invalid_cursor' },
      );
      await expectPublicError(
        () => queries.listExecutionAttempts(owner, {
          projectId: f.ids.projectId,
          taskId: 't-1',
          cursor: tamperCursorId(page1.nextCursor!, 'xyz'),
        }),
        { code: 'invalid_input', operation: 'execution.attempts.list', reason: 'invalid_cursor' },
      );
      await expectPublicError(
        () => queries.listExecutionAttempts(owner, {
          projectId: f.ids.projectId,
          taskId: 't-1',
          cursor: tamperCursorId(page1.nextCursor!, 'x_1'),
        }),
        { code: 'invalid_input', operation: 'execution.attempts.list', reason: 'invalid_cursor' },
      );
      // 诊断列表同样复用默认/最大分页规范。
      await expectPublicError(
        () => queries.listAttemptDiagnostics(owner, {
          projectId: f.ids.projectId,
          attemptId: 'audit-t-1-attempt-1',
          limit: 0,
        }),
        { code: 'invalid_input', operation: 'execution.attempt.diagnostics' },
      );
      const diagnostics = await queries.listAttemptDiagnostics(owner, {
        projectId: f.ids.projectId,
        attemptId: 'audit-t-1-attempt-1',
      });
      expect(diagnostics).toMatchObject({
        scope: 'attempt-diagnostic-list',
        records: [],
        nextCursor: null,
        limit: PLAN_LIST_DEFAULT_LIMIT,
      });
    } finally {
      f.box.close();
    }
  });

  it('rejects cross-project ownership and invisible projects without leaking existence', async () => {
    const f = await openClaimFixture([[]]);
    try {
      const attempt = f.store().claimTask(f.input()).receipt.attempt;
      const registeredB = await f.box.submit('project.register', {
        repositoryPath: f.box.box.repoDirB,
        displayName: 'Repo B',
        description: null,
        labels: [],
      }, { scope: { kind: 'registration' } });
      if (registeredB.status !== 'completed') throw new Error('fixture project B registration failed');
      const projectB = ((registeredB.result as { project: { id: string } }).project.id);
      const queries = assembleQueries(f.box);
      const owner = f.box.owner;

      // 跨项目目标与不存在目标：逐字段相同的 not_found（不区分存在性、不回显归属）。
      const foreignRun = await expectPublicError(
        () => queries.getRunScheduleStatus(owner, { projectId: projectB, runId: f.ids.runId }),
        { code: 'not_found', operation: 'execution.run.schedule', reason: 'execution_entity_not_found' },
      );
      const missingRun = await expectPublicError(
        () => queries.getRunScheduleStatus(owner, { projectId: projectB, runId: randomUUID() }),
        { code: 'not_found', operation: 'execution.run.schedule', reason: 'execution_entity_not_found' },
      );
      expect(errorFace(foreignRun)).toEqual(errorFace(missingRun));

      const foreignTask = await expectPublicError(
        () => queries.listExecutionAttempts(owner, { projectId: projectB, taskId: 't-1' }),
        { code: 'not_found', operation: 'execution.attempts.list', reason: 'execution_entity_not_found' },
      );
      const missingTask = await expectPublicError(
        () => queries.listExecutionAttempts(owner, { projectId: projectB, taskId: 'no-such-task' }),
        { code: 'not_found', operation: 'execution.attempts.list', reason: 'execution_entity_not_found' },
      );
      expect(errorFace(foreignTask)).toEqual(errorFace(missingTask));

      const foreignAttempt = await expectPublicError(
        () => queries.listAttemptDiagnostics(owner, { projectId: projectB, attemptId: attempt.id }),
        { code: 'not_found', operation: 'execution.attempt.diagnostics', reason: 'execution_entity_not_found' },
      );
      const missingAttempt = await expectPublicError(
        () => queries.listAttemptDiagnostics(owner, { projectId: projectB, attemptId: randomUUID() }),
        { code: 'not_found', operation: 'execution.attempt.diagnostics', reason: 'execution_entity_not_found' },
      );
      expect(errorFace(foreignAttempt)).toEqual(errorFace(missingAttempt));

      // 受限主体：不可见项目与不存在项目对调用方同一 forbidden（授权先于读取）。
      const restricted = createRestrictedPrincipal({
        capabilities: ['project.read'],
        projectScope: scopeAllowlist([projectB]),
      });
      await expectPublicError(
        () => queries.getRunScheduleStatus(restricted, { projectId: f.ids.projectId, runId: f.ids.runId }),
        { code: 'forbidden', operation: 'execution.run.schedule' },
      );
      await expectPublicError(
        () => queries.listExecutionAttempts(restricted, { projectId: f.ids.projectId, taskId: 't-1' }),
        { code: 'forbidden', operation: 'execution.attempts.list' },
      );
      // 无 project.read 能力：先行 forbidden，不读任何行。
      const incapable = createRestrictedPrincipal({ capabilities: [], projectScope: scopeAllowlist([f.ids.projectId]) });
      await expectPublicError(
        () => queries.getRunScheduleStatus(incapable, { projectId: f.ids.projectId, runId: f.ids.runId }),
        { code: 'forbidden', operation: 'execution.run.schedule' },
      );
      // 非法输入在任何读取之前拒绝；非法 principal 是可信装配编程错误。
      await expectPublicError(
        () => queries.getRunScheduleStatus(owner, { projectId: f.ids.projectId, runId: 'bad id!' }),
        { code: 'invalid_input', operation: 'execution.run.schedule' },
      );
      await expectPublicError(
        () => queries.getRunScheduleStatus(owner, { projectId: f.ids.projectId }),
        { code: 'invalid_input', operation: 'execution.run.schedule' },
      );
      await expect(queries.getRunScheduleStatus({ principalId: 'x' }, {
        projectId: f.ids.projectId,
        runId: f.ids.runId,
      })).rejects.toBeInstanceOf(TypeError);
    } finally {
      f.box.close();
    }
  });

  it('never exposes snapshot bodies, credentials or unauthorized internal paths', async () => {
    const f = await openClaimFixture([[], ['t-1']]);
    try {
      const attempt = f.store().claimTask(f.input()).receipt.attempt;
      const queries = assembleQueries(f.box);
      const schedule = await queries.getRunScheduleStatus(f.box.owner, {
        projectId: f.ids.projectId,
        runId: f.ids.runId,
      });
      const attempts = await queries.listExecutionAttempts(f.box.owner, {
        projectId: f.ids.projectId,
        taskId: 't-1',
      });
      const diagnostics = await queries.listAttemptDiagnostics(f.box.owner, {
        projectId: f.ids.projectId,
        attemptId: attempt.id,
      });
      const serialized = JSON.stringify({ schedule, attempts, diagnostics });
      expect(serialized).not.toContain(f.box.box.repoDirA);
      expect(serialized).not.toContain(f.box.box.dataRoot);
      expect(serialized).not.toContain(f.box.box.root);
      expect(schedule.run).not.toHaveProperty('inputSnapshot');
      expect(schedule.run).not.toHaveProperty('configSnapshot');
      expect(schedule.run).not.toHaveProperty('scopeSnapshot');
      expect(attempts.records[0]).not.toHaveProperty('inputSnapshot');
      for (const task of schedule.tasks) {
        expect(task).not.toHaveProperty('executionConfig');
      }
    } finally {
      f.box.close();
    }
  });

  it('degrades a corrupt persisted graph to invalid_graph without hiding the Run', async () => {
    const f = await scheduleFixture();
    try {
      const db = f.box.session.database;
      db.exec('DROP TRIGGER execution_batches_immutable_columns_update; PRAGMA ignore_check_constraints = ON');
      db.prepare("UPDATE execution_batches SET scope_snapshot = '{'").run();
      const result = await f.queries().getRunScheduleStatus(f.box.owner, {
        projectId: f.ids.projectId,
        runId: f.ids.runId,
      });
      expect(result.run.id).toBe(f.ids.runId);
      expect(result.schedule).toEqual({
        reason: 'invalid_graph',
        diagnostic: 'corrupt_persisted_view',
        readyTaskIds: [],
        handoff: null,
      });
      expect(result.tasks).toEqual([]);
    } finally {
      f.box.close();
    }
  });
});
