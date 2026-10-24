/**
 * P04-9 / F-005：有界持久补扫与 Work 组合根接线。
 *
 * 验收面（.dag_context.json F-005）：
 * 1. 现有 WorkScheduler 从持久 Run/派发事实分页扫描（有界页数、稳定游标、
 *    有界唤醒集合）；重复/丢失唤醒不影响正确性，重建调度器无需旧内存信号。
 * 2. 消费前以现有 DAG 判断就绪 Task，只调用 F-004 受控认领与已提交回执消费者；
 *    不预先把全部 Task 入队，无槽消费者不启动 Runner。
 * 3. 同 Feature 多 Task 顺序执行复用同一 Run 消费者身份与槽位；前一 Task 安全
 *    结束后继续下一 Task，不重复占槽、不自锁，Runtime completed 不等于 passed。
 * 4. finalization-only / all_passed handoff 分流与幂等保留；仅收尾 Run 受槽位与
 *    资源准入控制但不建编码 Attempt、不启动 Runtime；缺装配保留可查询阻塞原因。
 * 5. Core/Host 启动、signalRunDispatched、scan/start/close 接同一持久派发链；
 *    恢复门控解除前不消费；关闭停止新认领并清理有界计时器。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkScheduler } from '../../../packages/core/src/application/work-scheduler.ts';
import { createTaskDagService, evaluateTaskDag } from '../../../packages/core/src/application/task-dag.ts';
import { createSqliteSchedulerStore } from '../../../packages/core/src/adapters/sqlite/scheduler-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { openFakeCoreApplication } from '../../../packages/core/src/adapters/testing.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { SchedulerRunRef } from '../../../packages/core/src/ports/work-scheduler.ts';
import { BINDING_NOW, openBindingFixture, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { seedApprovalWaitingVerification } from '../../helpers/p03-7/approval-continue-seed.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';

const fakeCatalog = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
]);

const fixtures: Array<BindingFixture | Awaited<ReturnType<typeof openClaimFixture>>> = [];
const cores: CoreApplication[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.workExecution.close();
    core.close();
  }
  for (const fixture of fixtures.splice(0)) {
    if ('box' in fixture && 'close' in fixture.box) fixture.box.close();
  }
});

/* ------------------------------------------------------------------ *
 * A. 真实 SQLite：派发事实与 Run 续跑的分页扫描
 * ------------------------------------------------------------------ */

/**
 * 追加一个同项目独立 Feature/Batch/Run（不新 Task），可选写入入队意图。
 * 只用于扫描分页：不启动、不认领。
 */
function seedDispatchRun(
  fixture: Awaited<ReturnType<typeof openClaimFixture>>,
  options: { readonly intent: boolean; readonly enqueuedAt: number; readonly createdAt: number },
): { projectId: string; runId: string; intentId: string | null } {
  const db = fixture.box.session.database;
  const phase = db.prepare('SELECT * FROM phases LIMIT 1').get() as Record<string, unknown>;
  const feature = db.prepare('SELECT * FROM features LIMIT 1').get() as Record<string, unknown>;
  const batch = db.prepare('SELECT * FROM execution_batches LIMIT 1').get() as Record<string, unknown>;
  const run = db.prepare('SELECT * FROM runs LIMIT 1').get() as Record<string, unknown>;
  const batchScope = JSON.parse(String(batch.scope_snapshot)) as Record<string, unknown>;
  const phaseId = randomUUID();
  const featureId = randomUUID();
  const batchId = randomUUID();
  const runId = randomUUID();
  const intentId = options.intent ? randomUUID() : null;
  fixture.box.session.transactWrite('F-005.seedDispatchRun', () => {
    const insert = (table: string, row: Record<string, unknown>) => {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map(key => row[key] as never));
    };
    insert('phases', { ...phase, id: phaseId, created_at: options.createdAt, updated_at: options.createdAt });
    insert('features', { ...feature, id: featureId, phase_id: phaseId, created_at: options.createdAt,
      updated_at: options.createdAt });
    insert('execution_batches', { ...batch, id: batchId, phase_id: phaseId, feature_id: featureId,
      scope_snapshot: JSON.stringify({ ...batchScope, featureIds: [featureId] }),
      created_at: options.createdAt, updated_at: options.createdAt });
    insert('runs', { ...run, id: runId, batch_id: batchId, feature_id: featureId,
      created_at: options.createdAt, updated_at: options.createdAt });
    if (intentId !== null) {
      insert('run_dispatch_intents', {
        id: intentId, created_at: options.enqueuedAt, project_id: run.project_id,
        updated_at: options.enqueuedAt, feature_id: featureId, batch_id: batchId, run_id: runId,
        source: 'start', authorization_digest: 'a'.repeat(64),
        enqueued_at: options.enqueuedAt, reason: null,
      });
    }
  });
  return { projectId: run.project_id as string, runId, intentId };
}

describe('F-005 持久派发事实的有界分页扫描', () => {
  it('按稳定游标分页合并入队意图与 Run 续跑事实，覆盖全部候选且不重复', async () => {
    const fixture = await openClaimFixture();
    fixtures.push(fixture);
    const seeded = seedDispatchRun(fixture, { intent: true, enqueuedAt: NOW + 3_000, createdAt: NOW + 1_000 });
    const legacy = seedDispatchRun(fixture, { intent: false, enqueuedAt: NOW, createdAt: NOW + 2_000 });
    const store = createSqliteSchedulerStore(fixture.box.session, { nowUtcMs: () => NOW });

    const page1 = store.listActiveRuns({ after: null, limit: 2 });
    expect(page1.runs).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    // 入队意图按 `enqueued_at` 排序：既有 Run 的意图先于后登记意图。
    expect(page1.runs).toEqual([
      { projectId: fixture.ids.projectId, runId: fixture.ids.runId },
      { projectId: seeded.projectId, runId: seeded.runId },
    ]);

    const page2 = store.listActiveRuns({ after: page1.nextCursor ?? null, limit: 2 });
    expect(page2.runs).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.runs[0]).toEqual({ projectId: legacy.projectId, runId: legacy.runId });
    const all = [...page1.runs, ...page2.runs].map(ref => ref.runId);
    expect(new Set(all).size).toBe(3);

    // 稳定游标：同一游标重放返回同一页，插入新 Run 不回退。
    const replay = store.listActiveRuns({ after: page1.nextCursor ?? null, limit: 2 });
    expect(replay.runs).toEqual(page2.runs);
    expect(replay.nextCursor).toBeNull();
  });

  it('入队意图优先于续跑型 Run，且重建调度器后无旧信号仍发现未派发 queued Run', async () => {
    const fixture = await openClaimFixture();
    fixtures.push(fixture);

    const consumeClaim = vi.fn(async () => undefined);
    const claimTask = vi.fn(fixture.store().claimTask);
    const build = () => createWorkScheduler({
      store: createSqliteSchedulerStore(fixture.box.session, { nowUtcMs: () => NOW }),
      dag: createTaskDagService({ store: createSqliteTaskDagStore(fixture.box.session), nowMs: () => NOW }),
      claims: { claimTask },
      prepareClaim: async ({ taskId }) => fixture.input(Number(taskId.slice(2)) - 1),
      consumeClaim,
    });
    // 旧调度器关闭且从未被唤醒；新实例只依赖 SQLite 事实。
    const stale = build();
    await stale.close();
    const rebuilt = build();
    try {
      const result = await rebuilt.scan();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toMatchObject({ runId: fixture.ids.runId, claimed: true });
      expect(claimTask).toHaveBeenCalledTimes(1);
      expect(consumeClaim).toHaveBeenCalledTimes(1);
      expect(fixture.box.session.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 1 });
      // 重复扫描/重复唤醒不产生第二个 Attempt（租约与 DAG 仍由认领事务复核）。
      rebuilt.wake(fixture.ids.projectId, fixture.ids.runId);
      await rebuilt.scan();
      expect(claimTask).toHaveBeenCalledTimes(1);
      expect(consumeClaim).toHaveBeenCalledTimes(1);
      expect(fixture.box.session.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 1 });
    } finally {
      await rebuilt.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * B. 组合根：同 Run 多 Task 串行与单槽复用
 * ------------------------------------------------------------------ */

function row(fixture: BindingFixture, sql: string, ...params: unknown[]): Record<string, unknown> {
  return fixture.query(sql, ...params) as Record<string, unknown>;
}

function count(fixture: BindingFixture, sql: string, ...params: unknown[]): number {
  return (row(fixture, sql, ...params) as { n: number }).n;
}

async function waitIdle(core: CoreApplication): Promise<void> {
  await expect.poll(() => core.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
}

describe('F-005 Work 组合根的同 Run 串行派发', () => {
  it('两个依赖 Task 复用同一 Run 认领/槽位，Runtime 完成不等于 passed，收尾 handoff 不新建 Attempt', async () => {
    const fixture = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true,
      deliveryPolicy: { commitMode: 'task_and_feature',
        gitIdentity: { name: 'Test Owner', email: 'owner@example.test', confirmed: true } } });
    fixtures.push(fixture);
    const core = await openFakeCoreApplication({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: fakeCatalog(),
      nowUtcMs: () => BINDING_NOW,
      fake: {
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        // 真实受监督进程身份：Task 提交前的停止核验可证明（不伪造已停止）。
        commandProcess: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
        toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
        script: { schemaVersion: 1, steps: [
          { op: 'message', role: 'assistant', text: 'F-005 串行派发' },
          { op: 'tool_command', name: 'probe' },
        ] },
      },
    });
    cores.push(core);

    const first = await core.workExecution.scan();
    expect(first).toMatchObject({ closed: false, bounded: false, pages: 1 });
    expect(first.runs).toMatchObject([{ claimed: true, reason: 'ready' }]);
    await waitIdle(core);
    // Runtime 正常结束只把 Attempt 推进到 verifying；Task 仍是 running，绝不自动 passed。
    expect(row(fixture, 'SELECT status, attempt_counter FROM tasks WHERE id = ?', 't-1'))
      .toEqual({ status: 'running', attempt_counter: 1 });
    expect(row(fixture, 'SELECT status FROM attempts WHERE task_id = ?', 't-1')).toEqual({ status: 'verifying' });
    // Runtime 正常结束把 Run 转入可验证暂停（verification_not_assembled），
    // 仍不是 succeeded，也没有把 Task 标 passed。
    expect(row(fixture, 'SELECT status, reason FROM runs WHERE id = ?', fixture.runId))
      .toEqual({ status: 'paused', reason: 'verification_not_assembled' });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);
    const claimId = (row(fixture, 'SELECT id, claim_version FROM run_dispatch_claims') as {
      id: string; claim_version: number;
    });
    const slot = row(fixture, 'SELECT id, claim_id, claim_version, state, slot_index FROM execution_slot_claims');
    expect(slot).toMatchObject({ claim_id: claimId.id, claim_version: claimId.claim_version, state: 'held', slot_index: 0 });

    // t-1 有效通过后才解锁 t-2；继续扫描必须复用同一 Run 消费者与槽位。
    await seedApprovalWaitingVerification({
      fixture, completion: core.taskVerificationCompletion, taskId: 't-1', approvalItem: false,
    });
    expect(row(fixture, 'SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'passed' });
    const second = await core.workExecution.scan();
    expect(second.runs).toMatchObject([{ claimed: true }]);
    await waitIdle(core);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(2);
    expect(row(fixture, 'SELECT status, attempt_counter FROM tasks WHERE id = ?', 't-2'))
      .toEqual({ status: 'running', attempt_counter: 1 });
    expect((row(fixture, 'SELECT runtime_starts FROM execution_batches') as { runtime_starts: number }).runtime_starts)
      .toBe(2);
    // 一个 Run 只有一代认领和一个活动槽位：不重复占槽、不换消费者、不自锁。
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM run_dispatch_claims')).toBe(1);
    expect(row(fixture, 'SELECT id, claim_version, state FROM run_dispatch_claims'))
      .toEqual({ id: claimId.id, claim_version: claimId.claim_version, state: 'held' });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM execution_slot_claims')).toBe(1);
    expect(row(fixture, 'SELECT id, claim_id, claim_version, state FROM execution_slot_claims'))
      .toEqual({ id: slot.id, claim_id: claimId.id, claim_version: claimId.claim_version, state: 'held' });

    // 重复扫描在 t-2 未验证前不会创建第二个 Attempt（DAG 仍是 resource_busy）。
    const third = await core.workExecution.scan();
    expect(third.runs.every(entry => entry.claimed === false)).toBe(true);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(2);

    await seedApprovalWaitingVerification({
      fixture, completion: core.taskVerificationCompletion, taskId: 't-2', approvalItem: false,
    });
    const final = await core.workExecution.scan();
    // 未装配最终验证消费者：保留可查询阻塞原因，不新建 Attempt，也不把 Run 标成功。
    expect(final.runs).toMatchObject([{ reason: 'scheduler_capability_missing', claimed: false,
      capabilityGaps: ['feature_final_verification_consumer'] }]);
    expect(row(fixture, 'SELECT status FROM runs WHERE id = ?', fixture.runId)).toEqual({ status: 'running' });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(2);
    expect(row(fixture, 'SELECT status FROM features WHERE id = ?', fixture.featureId)).toEqual({ status: 'draft' });
    const dag = evaluateTaskDag(createSqliteTaskDagStore(fixture.session).readTaskDagView(
      fixture.projectId, fixture.runId), BINDING_NOW);
    expect(dag.reason).toBe('all_passed');

    // 关闭停止新认领并清理计时器/唤醒，不再产生执行。
    const closed = await core.workExecution.close();
    expect(closed.closed).toBe(true);
    expect(closed.pendingAttemptIds).toEqual([]);
    expect(await core.workExecution.scan()).toMatchObject({ closed: true, pages: 0, runs: [] });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(2);
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * C. finalization-only 分流、准入与缺装配原因
 * ------------------------------------------------------------------ */

interface FakeRun {
  readonly projectId: string; readonly id: string; readonly featureId: string;
  readonly status: 'queued'; readonly inputSnapshot: Record<string, unknown>;
}

function finalizationScheduler(options: {
  readonly admission?: { check(ref: SchedulerRunRef): string | null };
  readonly finalization?: { execute(handoff: { readonly projectId: string; readonly runId: string }): Promise<{ recordHandoff: boolean }> };
  readonly finalizationCompletion?: { execute(handoff: unknown): Promise<unknown> };
}) {
  const run: FakeRun = {
    projectId: 'p-1', id: 'r-1', featureId: 'f-1', status: 'queued',
    inputSnapshot: { schemaVersion: 1, finalization: { schemaVersion: 1, kind: 'finalization-only' } },
  };
  const recordRunReason = vi.fn();
  const recordFinalVerificationHandoff = vi.fn(() => true);
  const isFinalVerificationHandoffClaimed = vi.fn(() => false);
  const dag = { evaluate: vi.fn(() => { throw new Error('finalization-only must not evaluate the coding DAG'); }) };
  const claims = { claimTask: vi.fn(() => { throw new Error('finalization-only must not claim a coding Attempt'); }) };
  const prepareClaim = vi.fn(async () => { throw new Error('finalization-only must not prepare a claim'); });
  const consumeClaim = vi.fn(async () => undefined);
  const scheduler = createWorkScheduler({
    store: {
      listActiveRuns: () => ({ runs: [{ projectId: run.projectId, runId: run.id }], hasMore: false,
        nextCursor: null }),
      listBatchCandidates: () => ({ candidates: [], hasMore: false, nextCursor: null }),
      readRun: () => run as never,
      recordRunReason,
      isFinalVerificationHandoffClaimed,
      recordFinalVerificationHandoff,
    },
    dag: dag as never,
    claims: claims as never,
    prepareClaim,
    consumeClaim,
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    ...(options.finalization === undefined ? {} : { finalization: options.finalization }),
    ...(options.finalizationCompletion === undefined ? {} : { finalizationCompletion: options.finalizationCompletion }),
  });
  return { scheduler, run, recordRunReason, recordFinalVerificationHandoff, dag, claims,
    prepareClaim, consumeClaim };
}

describe('F-005 finalization-only 分流与准入', () => {
  it('缺收尾消费者时只持久化可查询阻塞原因，不评估 DAG、不认领、不启动 Runtime', async () => {
    const f = finalizationScheduler({});
    try {
      const result = await f.scheduler.scan();
      expect(result.runs).toMatchObject([{ reason: 'scheduler_capability_missing', claimed: false,
        capabilityGaps: ['feature_finalization_consumer'] }]);
      expect(f.recordRunReason).toHaveBeenCalledWith('p-1', 'r-1', 'scheduler_capability_missing');
      expect(f.dag.evaluate).not.toHaveBeenCalled();
      expect(f.claims.claimTask).not.toHaveBeenCalled();
      expect(f.prepareClaim).not.toHaveBeenCalled();
      expect(f.consumeClaim).not.toHaveBeenCalled();
    } finally {
      await f.scheduler.close();
    }
  });

  it('受槽位/资源准入控制：忙时保留原因且不执行，空闲后只收尾一次并保持 handoff 幂等', async () => {
    let blocked: string | null = 'execution_slot_unavailable';
    const execute = vi.fn(async () => ({ recordHandoff: true }));
    const f = finalizationScheduler({
      admission: { check: () => blocked },
      finalization: { execute },
    });
    try {
      const busy = await f.scheduler.scan();
      expect(busy.runs).toMatchObject([{ reason: 'resource_busy', claimed: false }]);
      expect(f.recordRunReason).toHaveBeenCalledWith('p-1', 'r-1', 'execution_slot_unavailable');
      expect(execute).not.toHaveBeenCalled();

      blocked = null;
      const first = await f.scheduler.scan();
      expect(first.runs[0]).toMatchObject({ reason: 'all_passed', claimed: false,
        handoff: { handoffKey: 'r-1:feature_final_verification' } });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(f.recordFinalVerificationHandoff).toHaveBeenCalledTimes(1);
      // 不创建编码 Attempt、不启动 Runtime 的同一分流由 DAG/claim 未被调用证明。
      expect(f.dag.evaluate).not.toHaveBeenCalled();
      expect(f.claims.claimTask).not.toHaveBeenCalled();
      expect(f.consumeClaim).not.toHaveBeenCalled();
    } finally {
      await f.scheduler.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * D. 启动恢复门控与 close 生命周期
 * ------------------------------------------------------------------ */

describe('F-005 启动门控与关闭', () => {
  it('恢复门控解除前不消费，解除后从持久 queued Run 补扫，关闭后不再认领', async () => {
    const fixture = await openBindingFixture();
    fixtures.push(fixture);
    const core = await openFakeCoreApplication({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: fakeCatalog(),
      workStartupRecoveryRequired: true,
      nowUtcMs: () => BINDING_NOW,
      fake: {
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        script: { schemaVersion: 1, steps: [] },
      },
    });
    cores.push(core);
    expect(core.workExecution.recoveryState().status).toBe('recovering');
    expect(await core.workExecution.scan()).toMatchObject({ pages: 0, runs: [] });
    core.workExecution.signalRunDispatched({ projectId: fixture.projectId, runId: fixture.runId });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(0);

    await core.workExecution.recover();
    expect(core.workExecution.recoveryState()).toEqual({ status: 'complete', reason: null });
    const after = await core.workExecution.scan();
    expect(after.runs).toMatchObject([{ claimed: true }]);
    await waitIdle(core);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);

    const closed = await core.workExecution.close();
    expect(closed.closed).toBe(true);
    core.workExecution.signalRunDispatched({ projectId: fixture.projectId, runId: fixture.runId });
    expect(await core.workExecution.scan()).toMatchObject({ closed: true, pages: 0, runs: [] });
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);
  }, 120_000);
});
