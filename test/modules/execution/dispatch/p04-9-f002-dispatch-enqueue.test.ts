/**
 * P04-9 / F-002：Run 持久入队接入启动、重试、resume 与仅收尾创建路径。
 *
 * 验收面（.dag_context.json F-002）：
 * 1. 已有授权事务生成的 Run 即持久执行意图：派发元数据与 Run/命令回执/脱敏事件
 *    同一短写事务登记；队列入口只在受信 Core 事务上下文，不是模型可自由写的命令。
 * 2. 重复命令与同 Run 重复入队返回原工作身份（零新增 Batch/Run/Attempt、零重复
 *    预算/事件）；同幂等身份异输入摘要冲突；显式重试的新 Run 不因共享 workKey 合并。
 * 3. 事务内重核 project/feature/run 归属、授权输入与控制状态；过期授权、跨项目、
 *    取消或终态工作被拒绝；入队写入失败整组回滚，累计额度不清零、不扩大。
 * 4. 唤醒只在成功提交后 best-effort 发出；丢失/抛错仍保留可补扫意图，事务失败不
 *    唤醒；入队本身不启动 Runner、不预扣 Attempt/Runtime 启动预算。
 * 5. 启动、同父 Batch 重试、显式 resume、仅收尾重试都产生或复用可核对意图；补扫
 *    候选不包含暂停中的 Run，不自动恢复。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeRunDispatchAuthorizationDigest,
  RUN_DISPATCH_INTENT_SCAN_MAX_LIMIT,
} from '../../../../packages/core/src/ports/execution-dispatch.ts';
import { isPublicError } from '../../../../packages/core/src/ports/commands.ts';
import type { CommandReceipt } from '../../../../packages/core/src/ports/commands.ts';
import type { CommandTransaction } from '../../../../packages/core/src/ports/atomic-commands.ts';
import { installWriteFault, WRITE_FAULT_POINTS } from '../../../helpers/p02-2/fault-injection.ts';
import { BUDGET, NOW, openBudgetFixture, type BudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';
import {
  prepareEligibleFixture,
  retryCommandsFor,
  retryPayload,
} from '../../../helpers/p03-9/finalization-retry-fixture.ts';

const fixtures: BudgetFixture[] = [];
const finalizationFixtures: Awaited<ReturnType<typeof prepareEligibleFixture>>[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  for (const f of finalizationFixtures.splice(0)) f.box.close();
});

interface IntentRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly updated_at: number;
  readonly feature_id: string;
  readonly batch_id: string;
  readonly run_id: string;
  readonly source: string;
  readonly authorization_digest: string;
  readonly enqueued_at: number;
  readonly reason: string | null;
}

function intentRows(f: BudgetFixture): IntentRow[] {
  return f.session.database
    .prepare('SELECT * FROM run_dispatch_intents ORDER BY enqueued_at, rowid')
    .all() as IntentRow[];
}

function runRow(f: BudgetFixture, runId: string) {
  return f.session.database
    .prepare('SELECT * FROM runs WHERE id = ?')
    .get(runId) as {
      id: string; project_id: string; batch_id: string; feature_id: string; purpose: string;
      scope_digest: string; work_key: string; dispatch_ordinal: number; status: string; revision: number;
      reason: string | null;
    };
}

function digestOf(f: BudgetFixture, runId: string): string {
  const run = runRow(f, runId);
  return computeRunDispatchAuthorizationDigest({
    projectId: run.project_id,
    featureId: run.feature_id,
    batchId: run.batch_id,
    runId: run.id,
    purpose: run.purpose,
    scopeDigest: run.scope_digest,
    workKey: run.work_key,
    dispatchOrdinal: run.dispatch_ordinal,
  });
}

function counts(f: BudgetFixture): Record<string, number> {
  const tables = [
    'execution_batches',
    'runs',
    'attempts',
    'run_dispatch_intents',
    'task_attempt_reservations',
    'runtime_start_reservations',
  ];
  return {
    ...Object.fromEntries(tables.map((table) => [
      table,
      (f.session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    ])),
    dispatched_events: dispatchedEvents(f),
    dispatch_receipts: dispatchReceipts(f),
  };
}

/** 只统计派发命令回执（夹具注册/配置回执不参与本任务的计数断言）。 */
function dispatchReceipts(f: BudgetFixture): number {
  return (f.session.database.prepare(
    "SELECT COUNT(*) AS n FROM command_receipts WHERE operation = 'execution.start'",
  ).get() as { n: number }).n;
}

/** 只统计派发事件（夹具注册/配置等既有事件不参与本任务的计数断言）。 */
function dispatchedEvents(f: BudgetFixture): number {
  return (f.session.database.prepare(
    "SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'execution.run.dispatched'",
  ).get() as { n: number }).n;
}

function batchRow(f: BudgetFixture, batchId: string) {
  return f.session.database.prepare(
    'SELECT status, revision, runs_created, attempts_created, runtime_starts, budget_revision ' +
      'FROM execution_batches WHERE id = ?',
  ).get(batchId) as {
    status: string; revision: number; runs_created: number; attempts_created: number;
    runtime_starts: number; budget_revision: number;
  };
}

/** 在一次真实写事务里调用入队原语（与命令路径相同的受信事务上下文）。 */
function transactIntent<T>(f: BudgetFixture, body: (transaction: CommandTransaction) => T): T {
  return f.atomic.transact('p04-9-f002-test', body);
}

async function startFixture(options: {
  readonly dispatchSignal?: 'record' | 'throw';
  /** resume 需要可确认的预算维度：剥离未验证的 token/cost 上限。 */
  readonly withoutResourceLimits?: boolean;
} = {}): Promise<{
  readonly f: BudgetFixture;
  readonly ids: { readonly projectId: string; readonly batchId: string; readonly runId: string; readonly taskId: string };
  readonly signals: readonly { projectId: string; batchId: string; runId: string; featureId: string }[];
}> {
  const budget = options.withoutResourceLimits
    ? (() => {
        const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
        return { batch, run: BUDGET.run };
      })()
    : undefined;
  const f = await openBudgetFixture(budget, undefined, options);
  fixtures.push(f);
  const ids = await f.start();
  return { f, ids, signals: f.services.signals as unknown as readonly { projectId: string; batchId: string; runId: string; featureId: string }[] };
}

function completed(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || !('result' in receipt)) {
    throw new Error(`expected completed receipt: ${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, unknown>;
}

describe('P04-9 / F-002 contract rules', () => {
  it('[case:intent-digest-stable] 授权身份摘要稳定且拒绝 workKey 等额外字段', () => {
    const identity = {
      projectId: 'project-1',
      featureId: 'feature-1',
      batchId: 'batch-1',
      runId: 'run-1',
      purpose: 'execute',
      scopeDigest: 'a'.repeat(64),
      workKey: 'b'.repeat(64),
      dispatchOrdinal: 1,
    };
    const digest = computeRunDispatchAuthorizationDigest(identity);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRunDispatchAuthorizationDigest({ ...identity })).toBe(digest);
    // 显式重试：新 Run / 新序号 → 新身份摘要（不因 workKey 相同而合并）。
    expect(computeRunDispatchAuthorizationDigest({ ...identity, runId: 'run-2', dispatchOrdinal: 2 }))
      .not.toBe(digest);
    expect(computeRunDispatchAuthorizationDigest({ ...identity, scopeDigest: 'c'.repeat(64) }))
      .not.toBe(digest);
    expect(() =>
      computeRunDispatchAuthorizationDigest({ ...identity, workKeyAlias: 'x' } as never),
    ).toThrow(/未知|unknown/i);
  });
});

describe('P04-9 / F-002 persistent enqueue on real SQLite', () => {
  it('[case:start-intent-atomic] 启动在同一短写事务登记意图，且不启动 Runner/不预扣额度', async () => {
    const { f, ids, signals } = await startFixture();
    const rows = intentRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: f.projectId,
      feature_id: f.featureId,
      batch_id: ids.batchId,
      run_id: ids.runId,
      source: 'start',
      authorization_digest: digestOf(f, ids.runId),
      enqueued_at: NOW,
      reason: null,
    });
    // Run/回执/脱敏事件一次；无 Attempt、无 Runtime/Attempt 预占。
    expect(counts(f)).toEqual({
      execution_batches: 1,
      runs: 1,
      attempts: 0,
      run_dispatch_intents: 1,
      dispatched_events: 1,
      dispatch_receipts: 1,
      task_attempt_reservations: 0,
      runtime_start_reservations: 0,
    });
    expect(batchRow(f, ids.batchId)).toMatchObject({
      status: 'queued',
      runs_created: 1,
      attempts_created: 0,
      runtime_starts: 0,
      budget_revision: 1,
    });
    // 唤醒在提交后发出一次，且指向已持久化的同一 Run/意图。
    expect(signals).toEqual([{
      projectId: f.projectId,
      batchId: ids.batchId,
      runId: ids.runId,
      featureId: f.featureId,
    }]);
    expect(runRow(f, ids.runId).status).toBe('queued');
  });

  it('[case:no-model-queue-write] 队列入口不是模型可自由写的命令操作', async () => {
    const { f } = await startFixture();
    const before = counts(f);
    const rejected = await f.submit('dispatch.enqueue', { runId: 'x' }, { scope: f.scope })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(rejected).not.toBeNull();
    expect(isPublicError(rejected)).toBe(true);
    expect(counts(f)).toEqual(before);
  });

  it('[case:idempotent-reenqueue] 同 Run 重复入队复用原身份；异摘要/额外字段拒绝', async () => {
    const { f, ids } = await startFixture();
    const [original] = intentRows(f);
    const before = counts(f);
    const digest = digestOf(f, ids.runId);
    const again = transactIntent(f, (transaction) => transaction.registerRunDispatchIntent({
      projectId: f.projectId,
      featureId: f.featureId,
      batchId: ids.batchId,
      runId: ids.runId,
      source: 'resume',
      authorizationDigest: digest,
      reason: null,
    }));
    expect(again.outcome).toBe('reused');
    expect(again.intent.id).toBe(original!.id);
    // 复用不重写来源/摘要/入队时间，也不新增事件或回执。
    const [after] = intentRows(f);
    expect(after).toEqual(original);
    expect(counts(f)).toEqual(before);

    // 同幂等身份异输入摘要 → 冲突。
    expect(() => transactIntent(f, (transaction) => transaction.registerRunDispatchIntent({
      projectId: f.projectId,
      featureId: f.featureId,
      batchId: ids.batchId,
      runId: ids.runId,
      source: 'resume',
      authorizationDigest: 'f'.repeat(64),
    }))).toThrow();
    // workKey 不是队列唯一键，不能作为入队字段塞入。
    expect(() => transactIntent(f, (transaction) => transaction.registerRunDispatchIntent({
      projectId: f.projectId,
      featureId: f.featureId,
      batchId: ids.batchId,
      runId: ids.runId,
      source: 'resume',
      authorizationDigest: digest,
      workKey: runRow(f, ids.runId).work_key,
    } as never))).toThrow();
    expect(intentRows(f)).toHaveLength(1);
  });

  it('[case:retry-distinct-intent] 显式重试的新 Run 有独立意图，不因共享 workKey 合并', async () => {
    const { f, ids } = await startFixture();
    f.session.database.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(ids.runId);
    const receipt = await f.submit(
      'execution.start',
      { featureIds: [f.featureId], retryBatchId: ids.batchId },
      { scope: f.scope },
    );
    const result = completed(receipt);
    const retryRunId = String(result.runId);
    expect(result.dispatchOrdinal).toBe(2);
    const rows = intentRows(f);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.source)).toEqual(['start', 'retry']);
    expect(rows.map((row) => row.run_id)).toEqual([ids.runId, retryRunId]);
    expect(rows[1]).toMatchObject({
      batch_id: ids.batchId,
      authorization_digest: digestOf(f, retryRunId),
      reason: null,
    });
    expect(result.dispatchIntentId).toBe(rows[1]!.id);
    // workKey 相同但派发身份不同：不合并、不重复扣额。
    expect(runRow(f, retryRunId).work_key).toBe(runRow(f, ids.runId).work_key);
    expect(counts(f)).toMatchObject({ runs: 2, run_dispatch_intents: 2, attempts: 0, dispatched_events: 2 });
    expect(batchRow(f, ids.batchId)).toMatchObject({
      runs_created: 2, attempts_created: 0, runtime_starts: 0, budget_revision: 1,
    });

    // 同命令完整重放：同一意图/回执，不再新增行。
    const replayed = await f.submit(
      'execution.start',
      { featureIds: [f.featureId], retryBatchId: ids.batchId },
      { scope: f.scope, commandId: (receipt as { commandId: string }).commandId },
    );
    expect((replayed as { replayed: boolean }).replayed).toBe(true);
    expect(completed(replayed).dispatchIntentId).toBe(rows[1]!.id);
    expect(intentRows(f)).toHaveLength(2);
  });

  it('[case:resume-reuses-intent] 显式 resume 复用原意图，暂停中不进入补扫候选', async () => {
    const { f, ids } = await startFixture({ withoutResourceLimits: true });
    const [original] = intentRows(f);
    const revision = runRow(f, ids.runId).revision;
    const paused = await f.submit(
      'execution.pause',
      { runId: ids.runId, batchId: null },
      { scope: f.scope, expectedRevision: revision },
    );
    expect(completed(paused)).toMatchObject({ outcome: 'paused' });
    expect(runRow(f, ids.runId).status).toBe('paused');
    // 暂停中的 Run 不是补扫候选（补扫不得自动恢复暂停意图）。
    const scanPaused = transactIntent(f, (transaction) =>
      transaction.listRunDispatchIntents({ projectId: f.projectId, limit: 10 }));
    expect(scanPaused).toEqual([]);

    const resumeReceipt = await f.submit(
      'execution.resume',
      { runId: ids.runId, batchId: null },
      { scope: f.scope, expectedRevision: runRow(f, ids.runId).revision },
    );
    const result = completed(resumeReceipt);
    expect(result.resumeScope).toBe('coding');
    expect(result.dispatchIntentIds).toEqual([original!.id]);
    const rows = intentRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(original);
    expect(runRow(f, ids.runId).status).toBe('queued');
    expect(counts(f)).toMatchObject({ attempts: 0, runtime_start_reservations: 0 });
    expect(batchRow(f, ids.batchId)).toMatchObject({ attempts_created: 0, runtime_starts: 0 });
    // resume 提交后唤醒仍指向同一 Run，意图可被补扫核对。
    const scan = transactIntent(f, (transaction) =>
      transaction.listRunDispatchIntents({ projectId: f.projectId, limit: 10 }));
    expect(scan).toHaveLength(1);
    expect(scan[0]).toMatchObject({ runId: ids.runId, runStatus: 'queued', activeClaimId: null });
  });

  it('[case:enqueue-guards] 事务内重核归属/授权输入/控制状态并拒绝过期或终态工作', async () => {
    const { f, ids } = await startFixture();
    const digest = digestOf(f, ids.runId);
    const baseInput = {
      projectId: f.projectId,
      featureId: f.featureId,
      batchId: ids.batchId,
      runId: ids.runId,
      source: 'resume' as const,
      authorizationDigest: digest,
    };
    // 跨项目 / 跨 Feature / 跨 Batch 归属：拒绝（不靠调用方自报身份）。
    expect(() => transactIntent(f, (transaction) => transaction.registerRunDispatchIntent({
      ...baseInput, projectId: randomUUID(),
    }))).toThrow();
    expect(() => transactIntent(f, (transaction) => transaction.registerRunDispatchIntent({
      ...baseInput, featureId: 'other-feature',
    }))).toThrow();
    expect(() => transactIntent(f, (transaction) => transaction.registerRunDispatchIntent({
      ...baseInput, batchId: randomUUID(),
    }))).toThrow();
    // 过期授权：摘要与当前 Run 的授权身份不一致。
    expect(() => transactIntent(f, (transaction) => transaction.registerRunDispatchIntent({
      ...baseInput, authorizationDigest: 'e'.repeat(64),
    }))).toThrow();

    // 无意图的旧 Run：终态/暂停中都不接受新的入队意图（不重开已结束/控制中的工作）。
    const dropIntent = () => f.session.database.prepare('DELETE FROM run_dispatch_intents WHERE run_id = ?').run(ids.runId);
    dropIntent();
    f.session.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(ids.runId);
    expect(() => transactIntent(f, (transaction) => transaction.registerRunDispatchIntent(baseInput))).toThrow();
    f.session.database.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(ids.runId);
    expect(() => transactIntent(f, (transaction) => transaction.registerRunDispatchIntent(baseInput))).toThrow();
    f.session.database.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(ids.runId);
    expect(() => transactIntent(f, (transaction) => transaction.registerRunDispatchIntent(baseInput))).toThrow();
    expect(intentRows(f)).toEqual([]);
    // 拒绝不创建任何 Attempt 或额度。
    expect(counts(f)).toMatchObject({ attempts: 0, task_attempt_reservations: 0, runtime_start_reservations: 0 });
  });

  it('[case:intent-write-failure-rollback] 入队写入失败整组回滚，累计额度不清零不扩大、不唤醒', async () => {
    const { f, ids, signals } = await startFixture();
    f.session.database.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(ids.runId);
    const before = counts(f);
    const batchBefore = batchRow(f, ids.batchId);
    const wakeBefore = signals.length;
    const fault = installWriteFault(f.session.database, {
      target: WRITE_FAULT_POINTS.runDispatchIntentsBeforeInsert,
    });
    try {
      const failed = await f.submit(
        'execution.start',
        { featureIds: [f.featureId], retryBatchId: ids.batchId },
        { scope: f.scope },
      ).then(() => null).catch((error: unknown) => error);
      expect(failed).not.toBeNull();
    } finally {
      fault.remove();
    }
    // Run 派发计数、Run、事件、回执、意图全部回滚；既有累计额度不变。
    expect(counts(f)).toEqual(before);
    expect(batchRow(f, ids.batchId)).toEqual(batchBefore);
    expect(intentRows(f)).toHaveLength(1);
    // 事务失败不唤醒。
    expect(signals).toHaveLength(wakeBefore);
  });

  it('[case:wake-best-effort] 唤醒抛错不回滚已提交意图，且入队仍可补扫', async () => {
    const { f, ids, signals } = await startFixture({ dispatchSignal: 'throw' });
    // 唤醒端口抛错被吞掉：命令仍提交成功，持久意图保留。
    expect(signals).toEqual([]);
    const rows = intentRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: ids.runId, source: 'start' });
    const scan = transactIntent(f, (transaction) =>
      transaction.listRunDispatchIntents({ projectId: f.projectId, limit: 10 }));
    expect(scan.map((entry) => entry.runId)).toEqual([ids.runId]);
    // 补扫上限有界（拒绝超过 100 的请求）。
    expect(() => transactIntent(f, (transaction) =>
      transaction.listRunDispatchIntents({ projectId: f.projectId, limit: RUN_DISPATCH_INTENT_SCAN_MAX_LIMIT + 1 })))
      .toThrow();
    expect(counts(f)).toMatchObject({ runs: 1, run_dispatch_intents: 1, attempts: 0 });
  });

  it('[case:finalization-intent] 仅收尾重试创建路径同事务登记独立意图并保留旧 Run', async () => {
    const f = await prepareEligibleFixture({ terminalStatus: 'failed' });
    finalizationFixtures.push(f);
    const commands = retryCommandsFor(f);
    const receipt = await commands.submit(randomUUID(), retryPayload(f));
    const result = completed(receipt);
    expect(result).toMatchObject({ retryFinal: true, dispatched: true, runtimeStarts: 0, attemptsCreated: 0 });
    const runId = String(result.runId);
    const row = intentRows(f.box).find((entry) => entry.run_id === runId);
    expect(row).toMatchObject({
      project_id: f.box.projectId,
      feature_id: f.box.featureId,
      batch_id: f.ids.batchId,
      source: 'finalization_retry',
      authorization_digest: digestOf(f.box, runId),
      reason: null,
    });
    expect(result.dispatchIntentId).toBe(row!.id);
    // 旧终态 Run 的意图保留，不被重写或删除；新 Run 有独立身份。
    const oldIntent = intentRows(f.box).find((entry) => entry.run_id === f.ids.runId);
    expect(oldIntent).toMatchObject({ source: 'start' });
    expect(commands.signals).toEqual([{
      projectId: f.box.projectId,
      batchId: f.ids.batchId,
      runId,
      featureId: f.box.featureId,
    }]);
    // 同命令重放：复用同一意图，不新增 Run/意图。
    const replayed = await commands.submit((receipt as { commandId: string }).commandId, retryPayload(f));
    expect(completed(replayed).dispatchIntentId).toBe(row!.id);
    expect(intentRows(f.box).filter((entry) => entry.source === 'finalization_retry')).toHaveLength(1);
    expect(commands.signals).toHaveLength(1);
  }, 120_000);
});
