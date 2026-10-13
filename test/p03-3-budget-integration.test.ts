import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommandReceipt, PublicErrorShape } from '../packages/core/src/ports/commands.ts';
import { createIsolatedHostEnvironment } from './helpers/host/index.ts';
import { runBarrierChildren } from './helpers/p02-2/index.ts';
import { openBudgetFixture, NOW, type BudgetFixture } from './helpers/p03-3/budget-fixture.ts';

const childPath = fileURLToPath(new URL('./helpers/p03-3/budget-race-child.ts', import.meta.url));

interface RaceResult {
  receipt?: CommandReceipt;
  error?: PublicErrorShape;
  record?: Record<string, unknown>;
  signals: number;
}

async function race(h: BudgetFixture, configs: Record<string, unknown>[]): Promise<RaceResult[]> {
  const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-race-' });
  try {
    const outcomes = await runBarrierChildren(environment, {
      scriptPath: childPath,
      configs: configs.map(config => ({ dbPath: h.box.dbPath, ...config })),
      readyTimeoutMs: 10_000, resultTimeoutMs: 10_000,
    });
    expect(new Set(outcomes.map(outcome => outcome.pid)).size).toBe(configs.length);
    for (const outcome of outcomes) {
      expect(outcome.exit.code).toBe(0);
      expect(() => process.kill(outcome.pid, 0)).toThrow();
    }
    return outcomes.map(outcome => outcome.result as unknown as RaceResult);
  } finally { await environment.dispose(); }
}

async function boundedBusy(h: BudgetFixture, config: Record<string, unknown>) {
  const before = h.snapshot();
  h.session.database.exec('BEGIN IMMEDIATE');
  let results: RaceResult[];
  const started = Date.now();
  try {
    results = await race(h, [config]);
  } finally { h.session.database.exec('ROLLBACK'); }
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(results[0]).toMatchObject({ error: { code: 'resource_busy', details: { reason: 'storage_busy' } }, signals: 0 });
  expect(h.snapshot()).toEqual(before);
  persistedAfterReopen(h);
}

function persistedAfterReopen(h: BudgetFixture) {
  const before = h.snapshot();
  h.reopen();
  expect(h.snapshot()).toEqual(before);
  expect(h.session.database.pragma('foreign_key_check')).toEqual([]);
  expect(h.session.database.pragma('integrity_check', { simple: true })).toBe('ok');
}

function row(h: BudgetFixture, table: string, id: string) {
  return h.session.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
}

function count(h: BudgetFixture, table: string) {
  return (h.session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('F-013 创建：真实跨进程 Run 竞争', () => {
  it('同时授权同 Feature：恰一个 accepted，Batch/Run/回执/事件/唤醒一致，重开不变', async () => {
    const h = await openBudgetFixture();
    try {
      const before = h.snapshot();
      const results = await race(h, [h.startEnvelope(), h.startEnvelope()].map(envelope => ({ mode: 'command', envelope })));
      const successes = results.filter(result => result.receipt?.status === 'accepted');
      expect(successes).toHaveLength(1);
      expect(successes[0]!.receipt).toMatchObject({ status: 'accepted', replayed: false });
      const loser = results.find(result => result !== successes[0])!;
      if (loser.receipt) {
        expect(loser.receipt).toMatchObject({ status: 'rejected', error: { details: { reason: 'preview_stale' } } });
      } else {
        expect(loser.error).toMatchObject({ code: 'conflict' });
      }
      const accepted = successes[0]!.receipt!;
      if (accepted.status !== 'accepted' || !('runId' in accepted)) throw new Error('expected Work accepted');
      expect(row(h, 'execution_batches', accepted.batchId)).toMatchObject({ runs_created: 1, attempts_created: 0, runtime_starts: 0 });
      expect(row(h, 'runs', accepted.runId)).toMatchObject({ batch_id: accepted.batchId, feature_id: h.featureId, status: 'queued' });
      expect(h.session.database.prepare('SELECT status, operation_id, batch_id, run_id FROM command_receipts WHERE command_id = ?')
        .get(accepted.commandId)).toEqual({ status: 'accepted', operation_id: accepted.batchId, batch_id: accepted.batchId, run_id: accepted.runId });
      expect(h.session.database.prepare('SELECT aggregate_id, event_type, payload FROM state_events WHERE aggregate_id = ?')
        .get(accepted.runId)).toEqual({ aggregate_id: accepted.runId, event_type: 'execution.run.dispatched', payload: '{"dispatched":true}' });
      expect(count(h, 'execution_batches')).toBe(1);
      expect(count(h, 'runs')).toBe(1);
      expect(count(h, 'command_receipts')).toBe((before.command_receipts as unknown[]).length + results.filter(result => result.receipt).length);
      expect(count(h, 'state_events')).toBe((before.state_events as unknown[]).length + 1);
      expect(results.map(result => result.signals).sort()).toEqual([0, 1]);
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 30_000);

  it('两个进程争抢父 Batch 最后一份 Run：一个 completed，另一活动冲突，只有一次派发', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      settle(h, seed, 'failed');
      const before = h.snapshot();
      const results = await race(h, [h.retryEnvelope(seed.batchId), h.retryEnvelope(seed.batchId)]
        .map(envelope => ({ mode: 'command', envelope })));
      expect(results.filter(result => result.receipt?.status === 'completed')).toHaveLength(1);
      expect(results.find(result => result.error)?.error).toMatchObject({ code: 'conflict', details: { reason: 'execution_in_progress' } });
      expect(row(h, 'execution_batches', seed.batchId)).toMatchObject({ runs_created: 2, no_progress_runs: 1 });
      expect(count(h, 'runs')).toBe(2);
      expect(count(h, 'command_receipts')).toBe((before.command_receipts as unknown[]).length + 1);
      expect(count(h, 'state_events')).toBe((before.state_events as unknown[]).length + 1);
      expect(results.map(result => result.signals).sort()).toEqual([0, 1]);
      persistedAfterReopen(h);
      const newRun = h.session.database.prepare("SELECT id FROM runs WHERE status = 'queued'").get() as { id: string };
      settle(h, { ...seed, runId: newRun.id }, 'failed');
      const exhausted = await h.services.commands.submit(h.owner, h.retryEnvelope(seed.batchId));
      expect(exhausted).toMatchObject({ status: 'rejected', error: { details: { reason: 'batch_not_active' } } });
      expect(count(h, 'runs')).toBe(2);
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 30_000);

  it.each(['execution_batches', 'batch_budget_revisions', 'runs', 'state_events', 'command_receipts'] as const)(
    '创建在 %s 写入前失败：无半 Batch/Run、accepted 或错误唤醒；可用同 commandId 重试', async table => {
      const h = await openBudgetFixture();
      try {
        const before = h.snapshot();
        const envelope = h.startEnvelope();
        injectFault(h, table);
        await expect(h.services.commands.submit(h.owner, envelope)).rejects.toMatchObject({
          code: table === 'state_events' || table === 'command_receipts' ? 'internal' : 'conflict',
        });
        expect(h.snapshot()).toEqual(before);
        expect(h.services.signals).toEqual([]);
        persistedAfterReopen(h);
        const receipt = await h.services.commands.submit(h.owner, envelope);
        expect(receipt.status).toBe('accepted');
        expect(h.services.signals).toHaveLength(1);
        const after = h.snapshot();
        expect(await h.services.commands.submit(h.owner, envelope)).toEqual({ ...receipt, replayed: true });
        expect(h.snapshot()).toEqual(after);
        expect(h.services.signals).toHaveLength(1);
        persistedAfterReopen(h);
      } finally { h.close(); }
    }, 15_000,
  );

  it('真实写锁 busy 有界返回，零回执/事件/唤醒；解锁后同命令只派发一次', async () => {
    const h = await openBudgetFixture();
    try {
      const envelope = h.startEnvelope();
      await boundedBusy(h, { mode: 'command', envelope });
      expect((await h.services.commands.submit(h.owner, envelope)).status).toBe('accepted');
      expect(h.services.signals).toHaveLength(1);
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 30_000);
});

type Seed = Awaited<ReturnType<BudgetFixture['start']>>;

function attempt(h: BudgetFixture, seed: Seed, attemptKey: string) {
  return h.services.atomic.transact('test.attempt', tx => tx.reserveTaskAttempt({ ...seed, attemptKey, maxAttemptsPerTask: null }));
}

function runtime(h: BudgetFixture, seed: Seed, startKey: string) {
  const { taskId: _taskId, ...input } = seed;
  return h.services.atomic.transact('test.runtime', tx => tx.reserveRuntimeStart({ ...input, startKey }));
}

function settlementInput(h: BudgetFixture, seed: Seed, outcome: 'failed' | 'succeeded' = 'failed') {
  return {
    projectId: seed.projectId, batchId: seed.batchId, runId: seed.runId,
    runRevision: row(h, 'runs', seed.runId).revision, resultKey: `${seed.runId}:result`,
    outcome, reason: null, progressEvidence: null,
  };
}

function settle(h: BudgetFixture, seed: Seed, outcome: 'failed' | 'succeeded') {
  const input = settlementInput(h, seed, outcome);
  return h.services.atomic.transact('test.settlement', tx => tx.settleExecutionRunOutcome(input));
}

// All identifiers are test-owned constants; TEMP triggers disappear when this connection closes.
function injectFault(h: BudgetFixture, table: string, operation: 'INSERT' | 'UPDATE' = 'INSERT') {
  h.session.database.exec(`CREATE TEMP TRIGGER f013_write_fault BEFORE ${operation} ON ${table}
    BEGIN SELECT RAISE(ABORT, 'f013 injected fault'); END`);
}

describe('F-013 总 Attempt：竞争与回滚', () => {
  it('写锁 busy 不消耗 Attempt：有界拒绝且解锁重开后只记一次', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      await boundedBusy(h, { mode: 'attempt', input: { ...seed, attemptKey: 'busy', maxAttemptsPerTask: null } });
      attempt(h, seed, 'busy');
      expect(row(h, 'tasks', seed.taskId)).toMatchObject({ attempt_counter: 1, code_attempts_used: 1 });
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 30_000);

  it('独立进程争抢最后一次总 Attempt：一个预占，Batch/Run/Task/账本同时且仅增加一次', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      attempt(h, seed, 'first');
      const before = h.snapshot();
      const results = await race(h, ['last-a', 'last-b'].map(attemptKey => ({
        mode: 'attempt', input: { ...seed, attemptKey, maxAttemptsPerTask: null },
      })));
      expect(results.filter(result => result.record)).toHaveLength(1);
      expect(results.find(result => result.error)?.error).toMatchObject({ code: 'conflict', details: { reason: 'budget_exhausted' } });
      expect(() => attempt(h, seed, 'after-limit')).toThrowError(expect.objectContaining({
        details: expect.objectContaining({ reasons: expect.arrayContaining([
          { layer: 'batch', dimension: 'maxTotalAttempts', limit: 2, used: 2 },
        ]) }),
      }));
      expect(results.map(result => result.signals)).toEqual([0, 0]);
      expect(row(h, 'execution_batches', seed.batchId)).toMatchObject({ attempts_created: 2 });
      expect(row(h, 'runs', seed.runId)).toMatchObject({ attempts_created: 2 });
      expect(row(h, 'tasks', seed.taskId)).toMatchObject({ attempt_counter: 2, code_attempts_used: 2 });
      expect(count(h, 'task_attempt_reservations')).toBe(2);
      expect(h.snapshot().command_receipts).toEqual(before.command_receipts);
      expect(h.snapshot().state_events).toEqual(before.state_events);
      persistedAfterReopen(h);
      const key = results.find(result => result.record)!.record!.attemptKey as string;
      const after = h.snapshot();
      expect(attempt(h, seed, key)).toEqual(results.find(result => result.record)!.record);
      expect(h.snapshot()).toEqual(after);
    } finally { h.close(); }
  }, 30_000);

  it.each([['runs', 'UPDATE'], ['tasks', 'UPDATE'], ['task_attempt_reservations', 'INSERT']] as const)(
    '预占在 %s %s 失败：前序计数整组回滚，重开后一致', async (table, operation) => {
      const h = await openBudgetFixture();
      try {
        const seed = await h.start();
        const before = h.snapshot();
        injectFault(h, table, operation);
        expect(() => attempt(h, seed, 'fault')).toThrow();
        expect(h.snapshot()).toEqual(before);
        persistedAfterReopen(h);
        expect(attempt(h, seed, 'fault').attemptKey).toBe('fault');
        expect(row(h, 'execution_batches', seed.batchId).attempts_created).toBe(1);
        persistedAfterReopen(h);
      } finally { h.close(); }
    }, 15_000,
  );
});

describe('F-013 启动：预占而非真实 Runtime', () => {
  it('写锁 busy 不消耗启动额度：有界拒绝且重开后只预占一次', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      await boundedBusy(h, { mode: 'runtime', input: { projectId: seed.projectId, batchId: seed.batchId, runId: seed.runId, startKey: 'busy' } });
      runtime(h, seed, 'busy');
      expect(row(h, 'execution_batches', seed.batchId).runtime_starts).toBe(1);
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 30_000);

  it('争抢最后一份启动额度：一个成功，重放及启动后失败均不退还、不伪造实际用量', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      runtime(h, seed, 'first-start');
      const before = h.snapshot();
      const results = await race(h, ['last-start-a', 'last-start-b'].map(startKey => ({
        mode: 'runtime', input: { projectId: seed.projectId, batchId: seed.batchId, runId: seed.runId, startKey },
      })));
      expect(results.filter(result => result.record)).toHaveLength(1);
      expect(results.find(result => result.error)?.error).toMatchObject({ code: 'conflict', details: { reason: 'budget_exhausted' } });
      expect(() => runtime(h, seed, 'after-limit')).toThrowError(expect.objectContaining({
        details: expect.objectContaining({ reasons: [
          { layer: 'batch', dimension: 'maxRuntimeStarts', limit: 2, used: 2 },
        ] }),
      }));
      expect(row(h, 'execution_batches', seed.batchId)).toMatchObject({ runtime_starts: 2, attempts_created: 0 });
      expect(count(h, 'runtime_start_reservations')).toBe(2);
      expect(h.snapshot().command_receipts).toEqual(before.command_receipts);
      expect(h.snapshot().state_events).toEqual(before.state_events);
      settle(h, seed, 'failed');
      persistedAfterReopen(h);
      const after = h.snapshot();
      expect(runtime(h, seed, results.find(result => result.record)!.record!.startKey as string))
        .toEqual(results.find(result => result.record)!.record);
      expect(h.snapshot()).toEqual(after);
      const app = await h.box.openApplication({ nowUtcMs: () => NOW });
      const status = await app.queryService.getExecutionBudgetStatus(h.owner, { projectId: seed.projectId, batchId: seed.batchId });
      expect(status.batch.usage).toEqual({ tokenUsed: null, costUsed: null });
      expect(status.batch.unconfirmedDimensions).toEqual(['maxTokenTotal', 'maxCostTotal']);
      expect(status.batch.dimensions.maxTokenTotal).toMatchObject({ used: null, remaining: null, exhausted: null });
      expect(status.batch.dimensions.maxCostTotal).toMatchObject({ used: null, remaining: null, exhausted: null });
      expect(status.batch.runtimeStartsReserved).toBe(2);
    } finally { h.close(); }
  }, 30_000);

  it('启动账本写入失败：runtime_starts 回滚，回执/事件不变，重开后可预占一次', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      const before = h.snapshot();
      injectFault(h, 'runtime_start_reservations');
      expect(() => runtime(h, seed, 'fault-start')).toThrow();
      expect(h.snapshot()).toEqual(before);
      persistedAfterReopen(h);
      runtime(h, seed, 'fault-start');
      expect(row(h, 'execution_batches', seed.batchId).runtime_starts).toBe(1);
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 15_000);
});

describe('F-013 结算：重放、成功重入与共享预算', () => {
  it('结算遇写锁：有界 busy、不倒写 Run；解锁重开后计一次无进展', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      await boundedBusy(h, { mode: 'settlement', input: settlementInput(h, seed) });
      settle(h, seed, 'failed');
      expect(row(h, 'execution_batches', seed.batchId).no_progress_runs).toBe(1);
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 30_000);

  it.each(['same', 'cas'] as const)('跨进程重复结果 %s：只有一条结算且 no_progress_runs 仅递增一次', async mode => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      attempt(h, seed, 'attempt');
      runtime(h, seed, 'start');
      const before = h.snapshot();
      const input = settlementInput(h, seed);
      const second = mode === 'same' ? input : { ...input, resultKey: 'other-result' };
      const results = await race(h, [input, second].map(value => ({ mode: 'settlement', input: value })));
      if (mode === 'same') {
        expect(results[0]!.record).toBeDefined();
        expect(results[1]!.record).toEqual(results[0]!.record);
      } else {
        expect(results.filter(result => result.record)).toHaveLength(1);
        expect(results.find(result => result.error)?.error).toMatchObject({ code: 'conflict', details: { reason: 'run_revision_stale' } });
      }
      expect(count(h, 'run_outcome_settlements')).toBe(1);
      expect(row(h, 'execution_batches', seed.batchId)).toMatchObject({ runs_created: 1, attempts_created: 1, runtime_starts: 1, no_progress_runs: 1 });
      expect(row(h, 'runs', seed.runId)).toMatchObject({ status: 'failed', ended_at: NOW });
      expect(h.snapshot().state_events).toEqual(before.state_events);
      expect(h.snapshot().command_receipts).toEqual(before.command_receipts);
      persistedAfterReopen(h);
      const after = h.snapshot();
      const winningInput = results[0]!.record ? input : second;
      expect(h.services.atomic.transact('test.replaySettlement', tx => tx.settleExecutionRunOutcome(winningInput)))
        .toEqual(results.find(result => result.record)!.record);
      expect(h.snapshot()).toEqual(after);
    } finally { h.close(); }
  }, 30_000);

  it.each([['execution_batches', 'UPDATE'], ['run_outcome_settlements', 'INSERT']] as const)(
    '结算在 %s %s 失败：Run 终态/结束时间与父计数均回滚', async (table, operation) => {
      const h = await openBudgetFixture();
      try {
        const seed = await h.start();
        const before = h.snapshot();
        injectFault(h, table, operation);
        expect(() => settle(h, seed, 'failed')).toThrow();
        expect(h.snapshot()).toEqual(before);
        persistedAfterReopen(h);
        settle(h, seed, 'failed');
        expect(row(h, 'execution_batches', seed.batchId).no_progress_runs).toBe(1);
        persistedAfterReopen(h);
      } finally { h.close(); }
    }, 15_000,
  );

  it('成功 workKey 重入不派发；历史计数与结算在数据库重开后保留', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      attempt(h, seed, 'success-attempt');
      runtime(h, seed, 'success-start');
      settle(h, seed, 'succeeded');
      persistedAfterReopen(h);
      const before = h.snapshot();
      const results = await race(h, [h.retryEnvelope(seed.batchId), h.retryEnvelope(seed.batchId)]
        .map(envelope => ({ mode: 'command', envelope })));
      for (const result of results) {
        expect(result).toMatchObject({ receipt: { status: 'rejected', error: { details: { reason: 'work_key_succeeded' } } }, signals: 0 });
      }
      expect(h.snapshot().runs).toEqual(before.runs);
      expect(h.snapshot().execution_batches).toEqual(before.execution_batches);
      expect(h.snapshot().state_events).toEqual(before.state_events);
      expect(count(h, 'command_receipts')).toBe((before.command_receipts as unknown[]).length + 2);
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 30_000);

  it('新 Run 共享父预算：换模型/提高 Task 策略不清计数、不改旧 Run 输入或期限', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      attempt(h, seed, 'old-attempt');
      runtime(h, seed, 'old-start');
      settle(h, seed, 'failed');
      const oldRun = row(h, 'runs', seed.runId);
      const oldBatch = row(h, 'execution_batches', seed.batchId);
      const strategy = await h.submit('task.strategy.update', {
        taskId: seed.taskId,
        executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2', maxCodeAttempts: 5 },
      }, { scope: h.scope, expectedRevision: row(h, 'tasks', seed.taskId).revision });
      expect(strategy.status).toBe('completed');
      expect(row(h, 'tasks', seed.taskId)).toMatchObject({ attempt_counter: 1, code_attempts_used: 1 });
      const retry = await h.services.commands.submit(h.owner, h.retryEnvelope(seed.batchId));
      expect(retry.status).toBe('completed');
      if (retry.status !== 'completed') throw new Error('retry must be completed');
      const second = { ...seed, runId: (retry.result as { runId: string }).runId };
      attempt(h, second, 'new-attempt');
      runtime(h, second, 'new-start');
      expect(row(h, 'execution_batches', seed.batchId)).toMatchObject({
        runs_created: 2, attempts_created: 2, runtime_starts: 2, no_progress_runs: 1,
        budget_snapshot: oldBatch.budget_snapshot, deadline_at: oldBatch.deadline_at,
      });
      expect(row(h, 'runs', seed.runId)).toEqual(oldRun);
      expect(row(h, 'runs', second.runId)).toMatchObject({ attempts_created: 1 });
      expect(row(h, 'tasks', seed.taskId)).toMatchObject({ attempt_counter: 2, code_attempts_used: 2 });
      const before = h.snapshot();
      expect(() => attempt(h, second, 'beyond-parent')).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'budget_exhausted' }) }));
      expect(() => runtime(h, second, 'beyond-parent-start')).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'budget_exhausted' }) }));
      expect(h.snapshot()).toEqual(before);
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 15_000);
});

describe('F-013 修订：跨进程 CAS 与审计回滚', () => {
  it('修订遇写锁：有界 busy、无新授权；同 commandId 解锁后修订一次', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      const envelope = h.revisionEnvelope(seed.batchId);
      await boundedBusy(h, { mode: 'command', envelope });
      expect((await h.services.commands.submit(h.owner, envelope)).status).toBe('completed');
      expect(row(h, 'execution_batches', seed.batchId).budget_revision).toBe(2);
      expect(h.services.signals).toEqual([]);
      persistedAfterReopen(h);
    } finally { h.close(); }
  }, 30_000);

  it('两个独立进程使用同 budget_revision：一个修订成功、一个 stale；审计/回执一致且不唤醒', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      attempt(h, seed, 'before-revise');
      runtime(h, seed, 'before-revise-start');
      const before = h.snapshot();
      const envelopes = [h.revisionEnvelope(seed.batchId), h.revisionEnvelope(seed.batchId)];
      const results = await race(h, envelopes.map(envelope => ({ mode: 'command', envelope })));
      expect(results.filter(result => result.receipt?.status === 'completed')).toHaveLength(1);
      expect(results.find(result => result.receipt?.status === 'rejected')?.receipt).toMatchObject({ error: { details: { reason: 'budget_revision_stale' } } });
      expect(results.map(result => result.signals)).toEqual([0, 0]);
      expect(row(h, 'execution_batches', seed.batchId)).toMatchObject({ budget_revision: 2, runs_created: 1, attempts_created: 1, runtime_starts: 1 });
      expect(h.snapshot().runs).toEqual(before.runs);
      expect(h.snapshot().tasks).toEqual(before.tasks);
      expect(count(h, 'batch_budget_revisions')).toBe(2);
      expect(count(h, 'command_receipts')).toBe((before.command_receipts as unknown[]).length + 2);
      expect(count(h, 'state_events')).toBe((before.state_events as unknown[]).length + 1);
      const history = h.session.database.prepare('SELECT version, approved_by, reason FROM batch_budget_revisions ORDER BY version').all();
      expect(history).toMatchObject([{ version: 1 }, { version: 2, approved_by: 'local-owner', reason: 'explicit increase' }]);
      persistedAfterReopen(h);
      const winner = results.findIndex(result => result.receipt?.status === 'completed');
      const after = h.snapshot();
      expect(await h.services.commands.submit(h.owner, envelopes[winner]!)).toEqual({ ...results[winner]!.receipt, replayed: true });
      expect(h.snapshot()).toEqual(after);
    } finally { h.close(); }
  }, 30_000);

  it.each(['batch_budget_revisions', 'state_events', 'command_receipts'] as const)(
    '修订在 %s 写入失败：预算、版本、历史、回执及事件整组回滚', async table => {
      const h = await openBudgetFixture();
      try {
        const seed = await h.start();
        const before = h.snapshot();
        const envelope = h.revisionEnvelope(seed.batchId);
        injectFault(h, table);
        await expect(h.services.commands.submit(h.owner, envelope)).rejects.toMatchObject({
          code: table === 'batch_budget_revisions' ? 'conflict' : 'internal',
        });
        expect(h.snapshot()).toEqual(before);
        persistedAfterReopen(h);
        expect((await h.services.commands.submit(h.owner, envelope)).status).toBe('completed');
        expect(row(h, 'execution_batches', seed.batchId).budget_revision).toBe(2);
        expect(h.services.signals).toEqual([]);
        persistedAfterReopen(h);
      } finally { h.close(); }
    }, 15_000,
  );
});
