/**
 * P03-3 / F-008 Run 结果幂等预算结算与连续无进展保护（真实临时 SQLite）。
 *
 * 覆盖（F-008 验收点，全部为真实持久状态断言；普通测试只调用受信 Core 内部
 * 结算原语——不经命令路由，不调用 Pi、网络或模型，不提前实现 Verifier、完整
 * 暂停/取消/恢复流程、Runner 或会话记录）：
 * - 迁移 v13：run_outcome_settlements 结算账本表（幂等结算身份
 *   UNIQUE(project_id,result_key)、生效进展证据部分唯一索引、同项目复合外键
 *   链、结算行不可变触发器、runs.ended_at 结算后不可重写触发器）；真实 v12
 *   库升级保留数据；SQLITE_MIGRATIONS 追加为 13、历史 SQL 不变；
 * - 一次性结算：受信 Core 内部结算入口同事务记录 Run 结果与 Batch 无进展
 *   计数；runs_created/attempts_created/runtime_starts 不因任何结果退还
 *   （无退额列、无退额原语）；重复结果（同 resultKey 重放）或旧 revision
 *   （runRevision CAS）不重复结算、不倒写终态（ended_at/status 不可重写）；
 * - 有效进展类型限定：progressEvidence 仅接受 new_valid_task_passed（同项目、
 *   Batch 单 Feature 范围内、tasks.status='passed' 的 Core 可核验领域事实）；
 *   运行成功文本、SDK 正常结束、心跳、日志、换模型与重放旧成功证据都不是
 *   合法进展（未知键/未知类型结构化拒绝；重放旧证据视为无进展不重置计数）；
 * - 无进展保护：有新有效领域进展才重置连续无进展数（→0）；无进展的结束 Run
 *   恰好 +1；到 maxNoProgressRuns 后同事务终态化 Batch（failed）并持久化
 *   budget_exhausted 原因，阻止同 Batch 新 Run（派发计数与纯预算判定双拒）；
 * - 时间依据不变：绝对 Batch deadline 与 Run 时间依据（started_at/ended_at）
 *   在重开、暂停与后续 Run 中保持不变；暂停不自动延期、结算不重新初始化
 *   预算快照；已成功 workKey 不因恢复扫描重新派发（判定输入稳定）。
 *
 * 领域证据夹具说明：测试中 Task 通过（tasks.status='passed'）由
 * trustedFixtureMarkTaskPassed 提供——它代表后续 Verifier 的受信 Core 写入
 * 路径（设计 07：passed 只能由核验产生，不能由模型自报）。夹具只提供领域
 * 事实，不用模型输出或人工改生产库充当验收通过；结算入口仍会在同事务内
 * 重新核验该事实（progress_evidence_not_verified fail-closed）。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import type { CommandTransaction } from '../packages/core/src/ports/atomic-commands.ts';
import { createSqliteExecutionAccess } from '../packages/core/src/adapters/sqlite/execution-store.ts';
import type { RunOutcomeSettlementRecord } from '../packages/core/src/ports/execution-store.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { evaluateBatchBudgetReservation } from '../packages/core/src/ports/execution-budget.js';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError } from '../packages/core/src/ports/errors.ts';
import { APP_CAPABILITIES, COMMAND_OPERATIONS } from '../packages/core/src/ports/commands.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const NOW = 1_900_000_000_000;
const HOUR_MS = 3_600_000;

/** 夹具默认预算：无进展维度允许两次，便于单测收索单一维度。 */
const DEFAULT_BUDGET = {
  schemaVersion: 1,
  batch: {
    maxRuns: 4,
    maxTotalAttempts: 8,
    maxRuntimeStarts: 4,
    maxNoProgressRuns: 2,
    deadlineUtcMs: NOW + HOUR_MS,
  },
  run: { maxAttemptsPerRun: 3, runTimeLimitMs: HOUR_MS },
};

interface GraphSeed {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly batchId: string;
  readonly runId: string;
}

interface SeedOptions {
  readonly batchStatus?: string;
  readonly runStatus?: string;
  readonly budget?: typeof DEFAULT_BUDGET;
  readonly noProgressRuns?: number;
  readonly taskStatus?: string;
}

interface BatchSnapshot {
  readonly runs_created: number;
  readonly attempts_created: number;
  readonly runtime_starts: number;
  readonly no_progress_runs: number;
  readonly revision: number;
  readonly status: string;
  readonly reason: string | null;
  readonly deadline_at: number;
  readonly budget_snapshot: string;
  readonly budget_revision: number;
}

interface RunSnapshot {
  readonly status: string;
  readonly revision: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly reason: string | null;
  readonly attempts_created: number;
}

interface Harness {
  readonly session: SqliteStorageSession;
  readonly db: SqliteStorageSession['database'];
  readonly access: ReturnType<typeof createSqliteExecutionAccess>;
  readonly seed: GraphSeed;
  readonly setClock: (value: number) => void;
  readonly settle: (input?: Record<string, unknown>) => RunOutcomeSettlementRecord;
  readonly batchSnapshot: () => BatchSnapshot;
  readonly runSnapshot: () => RunSnapshot;
  readonly settlementRows: () => readonly Record<string, unknown>[];
  readonly close: () => void;
}

function seedGraph(db: SqliteStorageSession['database'], options: SeedOptions = {}): GraphSeed {
  const projectId = 'proj-1';
  const phaseId = 'phase-1';
  const featureId = 'feature-1';
  const taskId = 'task-1';
  const batchId = randomUUID();
  const runId = randomUUID();
  const budget = options.budget ?? DEFAULT_BUDGET;
  db.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES (?, ?, 1, ?, '示例项目', 'active', '[]')",
  ).run(projectId, NOW, NOW);
  db.prepare(
    "INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES (?, ?, ?, 1, ?, '阶段一', 'open', '[]')",
  ).run(phaseId, NOW, projectId, NOW);
  db.prepare(
    'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs) VALUES (?, ?, ?, 1, ?, ?, ' +
      "'特性一', 'running', 'approved', '[]', '[]')",
  ).run(featureId, NOW, projectId, NOW, phaseId);
  db.prepare(
    'INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, acceptance, requirements_refs, execution_config, config_source, attempt_counter, code_attempts_used) ' +
      "VALUES (?, ?, ?, 1, ?, ?, '任务一', ?, '{\"criteria\":[\"验收\"]}', '[]', ?, 'project_default', 0, 0)",
  ).run(
    taskId,
    NOW,
    projectId,
    NOW,
    featureId,
    options.taskStatus ?? 'pending',
    JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }),
  );
  db.prepare(
    'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
      'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
      'runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 1, 0, 0, ?, ?)',
  ).run(
    batchId,
    NOW,
    projectId,
    NOW,
    phaseId,
    featureId,
    JSON.stringify({ featureIds: [featureId] }),
    JSON.stringify({}),
    options.batchStatus ?? 'running',
    JSON.stringify(budget),
    options.noProgressRuns ?? 0,
    budget.batch.deadlineUtcMs,
  );
  db.prepare(
    'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
      'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, ' +
      'run_time_limit_ms, attempts_created, started_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?)',
  ).run(
    runId,
    NOW,
    projectId,
    NOW,
    batchId,
    featureId,
    'execute',
    JSON.stringify({ inputIdentity: 'input-v1' }),
    JSON.stringify({}),
    options.runStatus ?? 'running',
    'a'.repeat(64),
    `${featureId}:execute`,
    budget.run.maxAttemptsPerRun,
    budget.run.runTimeLimitMs,
    NOW,
  );
  return { projectId, phaseId, featureId, taskId, batchId, runId };
}

/** 同 Batch 同 workKey 的后续 Run（重试派发形态；默认 running）。 */
function seedNextRun(db: SqliteStorageSession['database'], seed: GraphSeed, ordinal: number): string {
  const runId = randomUUID();
  db.prepare(
    'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
      'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, ' +
      'run_time_limit_ms, attempts_created, started_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
  ).run(
    runId,
    NOW,
    seed.projectId,
    NOW,
    seed.batchId,
    seed.featureId,
    'execute',
    JSON.stringify({}),
    JSON.stringify({}),
    'running',
    'f'.repeat(64),
    `${seed.featureId}:execute`,
    ordinal,
    DEFAULT_BUDGET.run.maxAttemptsPerRun,
    DEFAULT_BUDGET.run.runTimeLimitMs,
    NOW,
  );
  return runId;
}

/**
 * 受信领域事实夹具：Task 通过（status='passed'）。代表后续 Verifier 的受信
 * Core 写入路径；测试不以此宣称验收通过——结算入口在同事务内重新核验。
 */
function trustedFixtureMarkTaskPassed(db: SqliteStorageSession['database'], projectId: string, taskId: string): void {
  db.prepare('UPDATE tasks SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ?')
    .run('passed', NOW + 1, taskId, projectId);
}

let openSandbox: { cleanup(): void } | undefined;
afterEach(() => {
  if (openSandbox !== undefined) {
    openSandbox.cleanup();
    openSandbox = undefined;
  }
});

async function openHarness(
  options: SeedOptions = {},
  clockInitial: number = NOW,
): Promise<Harness> {
  const sandbox = createTempSandbox('shiploop-p033-f008-');
  openSandbox = sandbox;
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  await migrateSqliteStorage(session);
  let clock = clockInitial;
  const access = createSqliteExecutionAccess(session, { nowUtcMs: () => clock });
  const seed = seedGraph(session.database, options);
  const db = session.database;
  return {
    session,
    db,
    access,
    seed,
    setClock: (value: number) => {
      clock = value;
    },
    settle: (input?: Record<string, unknown>) =>
      session.transactWrite('test.settleRunOutcome', () =>
        access.settleExecutionRunOutcomeInTransaction(
          {
            projectId: seed.projectId,
            batchId: seed.batchId,
            runId: seed.runId,
            resultKey: 'result-1',
            runRevision: 1,
            outcome: 'failed',
            reason: null,
            progressEvidence: null,
            ...input,
          },
        ),
      ),
    batchSnapshot: () =>
      db.prepare('SELECT * FROM execution_batches WHERE id = ?').get(seed.batchId) as unknown as BatchSnapshot,
    runSnapshot: () =>
      db.prepare('SELECT * FROM runs WHERE id = ?').get(seed.runId) as unknown as RunSnapshot,
    settlementRows: () =>
      db.prepare('SELECT * FROM run_outcome_settlements ORDER BY created_at, id').all() as Record<string, unknown>[],
    close: () => session.close(),
  };
}

function expectError(action: () => unknown) {
  return {
    toThrowError(check: (error: StorageError) => boolean): void {
      try {
        action();
      } catch (error) {
        if (!isStorageError(error)) throw error;
        expect(check(error)).toBe(true);
        return;
      }
      throw new Error('预期抛出 StorageError，但调用成功');
    },
  };
}

function expectConflict(error: unknown, reason: string): StorageError {
  expect(isStorageError(error, 'conflict'), `应為 conflict：${String(error)}`).toBe(true);
  const storageError = error as StorageError;
  expect((storageError.details as { reason?: string } | undefined)?.reason).toBe(reason);
  return storageError;
}

describe('F-008 迁移 v13：run_outcome_settlements 结算账本与时间依据保护', () => {
  it('v13 DDL 底线：表/两唯一索引/生效证据部分唯一索引/不可变触发器/外键链', async () => {
    const h = await openHarness();
    try {
      expect(SQLITE_MIGRATIONS.length).toBe(15);
      const indexes = (
        h.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_outcome_settlements'").all() as {
          name: string;
          sql: string | null;
        }[]
      ).filter((row) => row.sql !== null);
      const indexNames = indexes.map((row) => row.name).sort();
      expect(indexNames).toEqual(
        ['run_outcome_settlements_progress_evidence_unique', 'run_outcome_settlements_project_result_key_unique', 'run_outcome_settlements_run_id_unique'].sort(),
      );
      // 生效进展证据的部分唯一索引：只在 progress_type='new_valid_task_passed' 行上强制。
      const evidenceIndex = indexes.find((row) => row.name === 'run_outcome_settlements_progress_evidence_unique');
      expect(evidenceIndex?.sql).toContain("progress_type = 'new_valid_task_passed'");
      // 结算行不可变（证据行；UPDATE/DELETE 一律拒绝）。
      h.settle({ resultKey: 'ddl-probe' });
      const rowId = (h.settlementRows()[0] as { id: string }).id;
      expect(() =>
        h.db.prepare('UPDATE run_outcome_settlements SET reason = ? WHERE id = ?').run('tampered', rowId),
      ).toThrow(/immutable/);
      expect(() => h.db.prepare('DELETE FROM run_outcome_settlements WHERE id = ?').run(rowId)).toThrow(/immutable/);
      // runs.ended_at 结算后不可重写（时间依据保护；NULL→首次设定仍允许）。
      expect(() =>
        h.db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(NOW + 9_000, h.seed.runId),
      ).toThrow(/ended_at/);
      // DDL 底线负例：outcome 非结算终态、证据形态不完整、悬空 progress_task 外键。
      expect(() =>
        h.db.prepare(
          'INSERT INTO run_outcome_settlements (id, created_at, project_id, revision, updated_at, batch_id, run_id, result_key, outcome, progress_type, progress_task_id, run_ended_at, no_progress_runs_after) ' +
            "VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'running', 'none', NULL, ?, 0)",
        ).run(randomUUID(), NOW, h.seed.projectId, NOW, h.seed.batchId, h.seed.runId, 'ddl-1', NOW),
      ).toThrow(/constraint/i);
      expect(() =>
        h.db.prepare(
          'INSERT INTO run_outcome_settlements (id, created_at, project_id, revision, updated_at, batch_id, run_id, result_key, outcome, progress_type, progress_task_id, run_ended_at, no_progress_runs_after) ' +
            "VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'failed', 'new_valid_task_passed', NULL, ?, 0)",
        ).run(randomUUID(), NOW, h.seed.projectId, NOW, h.seed.batchId, h.seed.runId, 'ddl-2', NOW),
      ).toThrow(/constraint/i);
      expect(() =>
        h.db.prepare(
          'INSERT INTO run_outcome_settlements (id, created_at, project_id, revision, updated_at, batch_id, run_id, result_key, outcome, progress_type, progress_task_id, run_ended_at, no_progress_runs_after) ' +
            "VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'failed', 'new_valid_task_passed', 'task-missing', ?, 0)",
        ).run(randomUUID(), NOW, h.seed.projectId, NOW, h.seed.batchId, seedNextRun(h.db, h.seed, 2), 'ddl-3', NOW),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      h.close();
    }
  });

  it('真实 v12 库（含既有 batch/run/task/预占与启动账本行）升级 v13 保留数据', async () => {
    const sandbox = createTempSandbox('shiploop-p033-f008-v12-');
    openSandbox = sandbox;
    const dbPath = join(sandbox.path, 'state.db');
    const v12Migrations = SQLITE_MIGRATIONS.slice(0, 12);
    const seedSession = openSqliteStorageSession({ path: dbPath });
    let seeded: GraphSeed | undefined;
    let before: Record<string, unknown[]>;
    try {
      await migrateSqliteStorage(seedSession, { migrations: v12Migrations });
      seeded = seedGraph(seedSession.database);
      const graph = seeded;
      const access = createSqliteExecutionAccess(seedSession, { nowUtcMs: () => NOW + 1 });
      seedSession.transactWrite('test.seedTrustedV12Reservations', () => {
        access.reserveTaskAttemptInTransaction({
          projectId: graph.projectId, batchId: graph.batchId, runId: graph.runId,
          taskId: graph.taskId, attemptKey: 'v12-attempt', maxAttemptsPerTask: null,
        });
        access.reserveRuntimeStartInTransaction({
          projectId: graph.projectId, batchId: graph.batchId, runId: graph.runId, startKey: 'v12-start',
        });
      });
      seedSession.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = ?").run(graph.taskId);
      before = Object.fromEntries(['execution_batches', 'runs', 'task_attempt_reservations', 'runtime_start_reservations']
        .map((table) => [table, seedSession.database.prepare(`SELECT * FROM ${table}`).all()]));
    } finally {
      seedSession.close();
    }
    const graph = seeded!;

    const session = openSqliteStorageSession({ path: dbPath });
    try {
      const result = await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 13) });
      expect(result.appliedVersions).toEqual([13]);
      for (const [table, rows] of Object.entries(before!)) {
        expect(session.database.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
      }
      expect(session.database.prepare('SELECT first_passed_at FROM tasks WHERE id = ?').get(graph.taskId))
        .toEqual({ first_passed_at: NOW + 1 });
      const batch = session.database
        .prepare('SELECT no_progress_runs, runs_created, budget_snapshot FROM execution_batches WHERE id = ?')
        .get(graph.batchId) as { no_progress_runs: number; runs_created: number; budget_snapshot: string };
      expect(batch.no_progress_runs).toBe(0);
      expect(batch.runs_created).toBe(1);
      expect(JSON.parse(batch.budget_snapshot)).toEqual(DEFAULT_BUDGET);
      expect(
        (session.database.prepare('SELECT COUNT(*) AS n FROM run_outcome_settlements').get() as { n: number }).n,
      ).toBe(0);

      // 升级后结算入口可用。
      const access = createSqliteExecutionAccess(session, { nowUtcMs: () => NOW });
      const settled = session.transactWrite('test.settleAfterUpgrade', () =>
        access.settleExecutionRunOutcomeInTransaction({
          projectId: graph.projectId,
          batchId: graph.batchId,
          runId: graph.runId,
          resultKey: 'result-after-upgrade',
          runRevision: 2,
          outcome: 'failed',
          reason: null,
          progressEvidence: null,
        }),
      );
      expect(settled.resultKey).toBe('result-after-upgrade');
      expect(settled.noProgressRunsAfter).toBe(1);
    } finally {
      session.close();
    }
  });
});

describe('F-008 一次性结算与计数不退还', () => {
  it.each(['failed', 'succeeded', 'cancelled'] as const)('%s 无进展结束 Run：计数恰好 +1，Run/Attempt/Runtime 消耗不退还', async (outcome) => {
    const h = await openHarness();
    try {
      // 先经 F-006/F-007 受信边界预占一次 Attempt 与一次 Runtime 启动（Run revision → 2）。
      h.session.transactWrite('test.reserveAttempt', () =>
        h.access.reserveTaskAttemptInTransaction({
          projectId: h.seed.projectId,
          batchId: h.seed.batchId,
          runId: h.seed.runId,
          taskId: h.seed.taskId,
          attemptKey: 'attempt-1',
          maxAttemptsPerTask: null,
        }),
      );
      h.session.transactWrite('test.reserveStart', () =>
        h.access.reserveRuntimeStartInTransaction({
          projectId: h.seed.projectId,
          batchId: h.seed.batchId,
          runId: h.seed.runId,
          startKey: 'start-1',
        }),
      );
      const before = h.batchSnapshot();
      expect(before.attempts_created).toBe(1);
      expect(before.runtime_starts).toBe(1);
      expect(before.runs_created).toBe(1);

      h.setClock(NOW + 5_000);
      const settled = h.settle({ runRevision: 2, outcome });
      expect(settled.outcome).toBe(outcome);
      expect(settled.noProgressRunsAfter).toBe(1);
      expect(settled.progressType).toBe('none');

      const after = h.batchSnapshot();
      expect(after.no_progress_runs).toBe(1);
      expect(after.runs_created).toBe(1);
      expect(after.attempts_created).toBe(1);
      expect(after.runtime_starts).toBe(1);
      expect(after.status).toBe('running');

      const run = h.runSnapshot();
      expect(run.status).toBe(outcome);
      expect(run.ended_at).toBe(NOW + 5_000);
      expect(run.revision).toBe(3);
      expect(run.started_at).toBe(NOW);
      expect(h.settlementRows()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('有新有效领域进展才重置：受信夹具 Task passed + 证据 → no_progress_runs 归零、Batch 保持活动', async () => {
    const h = await openHarness();
    try {
      // 第一次无进展结算（Run 1 → failed；no_progress_runs=1）。
      h.settle({ resultKey: 'result-1' });
      expect(h.batchSnapshot().no_progress_runs).toBe(1);

      // 后续 Run（重试派发形态）。
      const secondRunId = seedNextRun(h.db, h.seed, 2);
      trustedFixtureMarkTaskPassed(h.db, h.seed.projectId, h.seed.taskId);
      h.setClock(NOW + 1);
      const settled = h.settle({
        runId: secondRunId,
        resultKey: 'result-2',
        outcome: 'failed',
        progressEvidence: { type: 'new_valid_task_passed', taskId: h.seed.taskId },
      });
      expect(settled.progressType).toBe('new_valid_task_passed');
      expect(settled.noProgressRunsAfter).toBe(0);
      expect(h.batchSnapshot().no_progress_runs).toBe(0);
      expect(h.batchSnapshot().status).toBe('running');
    } finally {
      h.close();
    }
  });

  it('证据核验失败（Task 非 passed）→ conflict progress_evidence_not_verified，零写入', async () => {
    const h = await openHarness({ taskStatus: 'failed' });
    try {
      const before = h.batchSnapshot();
      expectError(() =>
        h.settle({ progressEvidence: { type: 'new_valid_task_passed', taskId: h.seed.taskId } }),
      ).toThrowError((error: unknown) => {
        expectConflict(error, 'progress_evidence_not_verified');
        return true;
      });
      expect(h.batchSnapshot()).toEqual(before);
      expect(h.runSnapshot().status).toBe('running');
      expect(h.settlementRows()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('晚于结算时钟的通过事实不能冒充本 Run 已发生的进展', async () => {
    const h = await openHarness();
    try {
      trustedFixtureMarkTaskPassed(h.db, h.seed.projectId, h.seed.taskId);
      const settled = h.settle({ progressEvidence: { type: 'new_valid_task_passed', taskId: h.seed.taskId } });
      expect(settled.progressType).toBe('none');
      expect(settled.noProgressRunsAfter).toBe(1);
    } finally { h.close(); }
  });

  it('Run 前已通过的 Task 即使随后编辑元数据，也不是新领域事实', async () => {
    const h = await openHarness({ taskStatus: 'passed', noProgressRuns: 1 });
    try {
      h.db.prepare('UPDATE tasks SET labels = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
        .run('["edited"]', NOW + 20, h.seed.taskId);
      const settled = h.settle({
        progressEvidence: { type: 'new_valid_task_passed', taskId: h.seed.taskId },
      });
      expect(settled.progressType).toBe('none');
      expect(settled.noProgressRunsAfter).toBe(2);
      expect(h.batchSnapshot().reason).toBe('budget_exhausted');
      expect(h.db.prepare('SELECT first_passed_at FROM tasks WHERE id = ?').get(h.seed.taskId))
        .toEqual({ first_passed_at: NOW });
      expect(() => h.db.prepare('UPDATE tasks SET first_passed_at = ? WHERE id = ?').run(NOW + 30, h.seed.taskId))
        .toThrow(/immutable/);
    } finally {
      h.close();
    }
  });

  it('重放旧成功证据不重置：第二 Run 提交同 taskId 证据 → 视为无进展 +1（progress_type=none 持久）', async () => {
    const h = await openHarness();
    try {
      trustedFixtureMarkTaskPassed(h.db, h.seed.projectId, h.seed.taskId);
      h.setClock(NOW + 1);
      const first = h.settle({
        outcome: 'succeeded',
        progressEvidence: { type: 'new_valid_task_passed', taskId: h.seed.taskId },
      });
      expect(first.noProgressRunsAfter).toBe(0);

      const secondRunId = seedNextRun(h.db, h.seed, 2);
      const second = h.settle({
        runId: secondRunId,
        resultKey: 'result-2',
        outcome: 'failed',
        progressEvidence: { type: 'new_valid_task_passed', taskId: h.seed.taskId },
      });
      expect(second.progressType).toBe('none');
      expect(second.noProgressRunsAfter).toBe(1);
      expect(h.batchSnapshot().no_progress_runs).toBe(1);
      // 生效证据只在第一条结算行上持久（部分唯一索引）。
      const effective = h
        .settlementRows()
        .filter((row) => row.progress_type === 'new_valid_task_passed');
      expect(effective).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('运行成功文本/SDK 正常结束/心跳/日志/换模型不是进展：输入面结构化拒绝（未知类型与未知键）', async () => {
    const h = await openHarness();
    try {
      for (const type of ['sdk_finished', 'run_output', 'heartbeat', 'log_lines', 'model_switched']) {
        expectError(() =>
          h.settle({ progressEvidence: { type, taskId: h.seed.taskId } }),
        ).toThrowError((error: unknown) => {
          expect(isStorageError(error, 'validation')).toBe(true);
          return true;
        });
      }
      for (const extra of [
        { tokenUsed: 1 },
        { sdkEnded: true },
        { outputText: 'run succeeded' },
        { logs: [] },
        { modelChanged: 'claude-opus' },
        { progress: true },
      ]) {
        expectError(() => h.settle(extra)).toThrowError((error: unknown) => {
          expect(isStorageError(error, 'validation')).toBe(true);
          return true;
        });
      }
      expect(h.settlementRows()).toHaveLength(0);
      expect(h.runSnapshot().status).toBe('running');
    } finally {
      h.close();
    }
  });
});

describe('F-008 幂等、旧 revision 与不倒写终态', () => {
  it('同 resultKey 重放：返回既有记录；计数/终态/ended_at 不变（重复结果不重复结算）', async () => {
    const h = await openHarness();
    try {
      h.setClock(NOW + 1_000);
      const first = h.settle({ resultKey: 'result-1' });
      const batchAfterFirst = h.batchSnapshot();
      const runAfterFirst = h.runSnapshot();
      expect(runAfterFirst.ended_at).toBe(NOW + 1_000);

      h.setClock(NOW + 60_000);
      // 重放即使携带过期 revision 也幂等返回既有记录（不因 CAS 报错）。
      const replay = h.settle({ resultKey: 'result-1', runRevision: 99, outcome: 'cancelled' });
      expect(replay.id).toBe(first.id);
      expect(replay.outcome).toBe('failed');
      expect(h.batchSnapshot()).toEqual(batchAfterFirst);
      expect(h.runSnapshot()).toEqual(runAfterFirst);
      expect(h.settlementRows()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('旧 revision：runRevision 过期 → conflict run_revision_stale，零写入（先到者权威）', async () => {
    const h = await openHarness();
    try {
      // 一次 Attempt 预占把 Run revision 推进到 2。
      h.session.transactWrite('test.reserveAttempt', () =>
        h.access.reserveTaskAttemptInTransaction({
          projectId: h.seed.projectId,
          batchId: h.seed.batchId,
          runId: h.seed.runId,
          taskId: h.seed.taskId,
          attemptKey: 'attempt-1',
          maxAttemptsPerTask: null,
        }),
      );
      const before = h.batchSnapshot();
      expectError(() => h.settle({ runRevision: 1 })).toThrowError((error: unknown) => {
        const storageError = expectConflict(error, 'run_revision_stale');
        expect((storageError.details as { expected?: number; actual?: number }).expected).toBe(1);
        expect((storageError.details as { expected?: number; actual?: number }).actual).toBe(2);
        return true;
      });
      expect(h.batchSnapshot()).toEqual(before);
      expect(h.runSnapshot().status).toBe('running');
      expect(h.settlementRows()).toHaveLength(0);
      // 正确 revision 可结算。
      h.settle({ runRevision: 2 });
      expect(h.runSnapshot().status).toBe('failed');
    } finally {
      h.close();
    }
  });

  it('已终态 Run 的新 resultKey → conflict run_already_settled：status/ended_at/revision 不倒写', async () => {
    const h = await openHarness();
    try {
      h.setClock(NOW + 1_000);
      h.settle({ resultKey: 'result-1' });
      const settledRun = h.runSnapshot();
      expectError(() =>
        h.settle({ resultKey: 'result-9', outcome: 'succeeded', runRevision: settledRun.revision }),
      ).toThrowError((error: unknown) => {
        expectConflict(error, 'run_already_settled');
        return true;
      });
      expect(h.runSnapshot()).toEqual(settledRun);
      expect(h.settlementRows()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('resultKey 绑定其他 Run → conflict result_key_reused（结算身份属于其 Run）', async () => {
    const h = await openHarness();
    try {
      h.settle({ resultKey: 'result-1' });
      const secondRunId = seedNextRun(h.db, h.seed, 2);
      expectError(() => h.settle({ runId: secondRunId, resultKey: 'result-1' })).toThrowError((error: unknown) => {
        expectConflict(error, 'result_key_reused');
        return true;
      });
      expect(h.settlementRows()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('结算与读取只在有效 CommandTransaction 中可用，逃逸上下文在另一事务中也不能复用', async () => {
    const h = await openHarness();
    try {
      const store = createSqliteAtomicCommandStore(h.session, { nowUtcMs: () => NOW });
      let escaped: CommandTransaction;
      const input = {
        projectId: h.seed.projectId, batchId: h.seed.batchId, runId: h.seed.runId,
        resultKey: 'trusted-result', runRevision: 1, outcome: 'failed', reason: null, progressEvidence: null,
      };
      const settled = store.transact('test.trustedCoreResult', (tx) => {
        escaped = tx;
        expect(tx.getRunOutcomeSettlement(h.seed.projectId, h.seed.runId, 'trusted-result')).toBeNull();
        const row = tx.settleExecutionRunOutcome(input);
        expect(tx.getRunOutcomeSettlement(h.seed.projectId, h.seed.runId, 'trusted-result')).toEqual(row);
        return row;
      });
      expect(() => escaped!.settleExecutionRunOutcome(input)).toThrow();
      store.transact('test.escapedContextRejected', () => {
        expect(() => escaped!.getRunOutcomeSettlement(h.seed.projectId, h.seed.runId, 'trusted-result')).toThrow();
      });
      expect(h.settlementRows()).toHaveLength(1);
      expect(settled.noProgressRunsAfter).toBe(1);
    } finally { h.close(); }
  });

  it('组合事务故障：结算后同事务抛错 → 整组回滚（Run 终态/计数/结算行零残留）', async () => {
    const h = await openHarness();
    try {
      const before = h.batchSnapshot();
      expect(() =>
        h.session.transactWrite('test.combinedFailure', () => {
          h.access.settleExecutionRunOutcomeInTransaction({
            projectId: h.seed.projectId,
            batchId: h.seed.batchId,
            runId: h.seed.runId,
            resultKey: 'result-1',
            runRevision: 1,
            outcome: 'failed',
            reason: null,
            progressEvidence: null,
          });
          throw new Error('组合事务后续写入失败');
        }),
      ).toThrow(/组合事务后续写入失败/);
      expect(h.batchSnapshot()).toEqual(before);
      expect(h.runSnapshot().status).toBe('running');
      expect(h.settlementRows()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});

describe('F-008 maxNoProgressRuns 上限与阻止同 Batch 新 Run', () => {
  it('无进展到达上限：Batch 恰好终态化 failed 并持久化 budget_exhausted 原因；结算行记录终值', async () => {
    const h = await openHarness();
    try {
      h.settle({ resultKey: 'result-1' });
      // 未达上限（1 < max=2）：Batch 保持活动。
      expect(h.batchSnapshot().status).toBe('running');
      expect(h.batchSnapshot().reason).toBeNull();

      const secondRunId = seedNextRun(h.db, h.seed, 2);
      const settled = h.settle({ runId: secondRunId, resultKey: 'result-2' });
      expect(settled.noProgressRunsAfter).toBe(2);
      const batch = h.batchSnapshot();
      expect(batch.no_progress_runs).toBe(2);
      expect(batch.status).toBe('failed');
      expect(batch.reason).toBe('budget_exhausted');
    } finally {
      h.close();
    }
  });

  it('到达上限后阻止同 Batch 新 Run：派发计数原语 conflict；纯预算判定 noProgressRuns 维度耗尽', async () => {
    const h = await openHarness();
    try {
      h.settle({ resultKey: 'result-1' });
      const secondRunId = seedNextRun(h.db, h.seed, 2);
      h.settle({ runId: secondRunId, resultKey: 'result-2' });
      const batch = h.batchSnapshot();
      expect(batch.status).toBe('failed');

      // 1) 派发计数原语：终态 Batch 不接受新派发。
      expectError(() =>
        h.session.transactWrite('test.dispatchAfterExhausted', () =>
          h.access.recordExecutionRunDispatchInTransaction(h.seed.projectId, h.seed.batchId),
        ),
      ).toThrowError((error: unknown) => {
        expectConflict(error, 'batch_not_active');
        return true;
      });
      // 2) 纯预算判定：noProgressRuns >= maxNoProgressRuns 维度耗尽（防御纵深——
      //    即使 Batch 状态被其他路径改回活动，预算判定仍拒绝）。
      const budget = JSON.parse(batch.budget_snapshot) as typeof DEFAULT_BUDGET;
      const decision = evaluateBatchBudgetReservation(
        budget.batch,
        { runsCreated: batch.runs_created, attemptsCreated: batch.attempts_created, runtimeStarts: batch.runtime_starts, noProgressRuns: batch.no_progress_runs },
        NOW + 1,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.map((reason) => reason.dimension)).toContain('maxNoProgressRuns');
    } finally {
      h.close();
    }
  });

  it('临界值：maxNoProgressRuns=1 时单次无进展即终态化；计数不溢出', async () => {
    const h = await openHarness({
      budget: {
        schemaVersion: 1,
        batch: { ...DEFAULT_BUDGET.batch, maxNoProgressRuns: 1 },
        run: DEFAULT_BUDGET.run,
      },
    });
    try {
      const settled = h.settle();
      expect(settled.noProgressRunsAfter).toBe(1);
      const batch = h.batchSnapshot();
      expect(batch.no_progress_runs).toBe(1);
      expect(batch.status).toBe('failed');
      expect(batch.reason).toBe('budget_exhausted');
    } finally {
      h.close();
    }
  });
});

describe('F-008 时间依据不变与恢复边界（重开/暂停/后续 Run）', () => {
  it('结算不修改时间与预算依据：deadline_at/budget_snapshot/budget_revision 逐字节不变；started_at 不变', async () => {
    const h = await openHarness();
    try {
      const before = h.batchSnapshot();
      h.setClock(NOW + 120_000);
      h.settle();
      const after = h.batchSnapshot();
      expect(after.deadline_at).toBe(before.deadline_at);
      expect(after.budget_snapshot).toBe(before.budget_snapshot);
      expect(after.budget_revision).toBe(before.budget_revision);
      expect(h.runSnapshot().started_at).toBe(NOW);
      expect(h.runSnapshot().ended_at).toBe(NOW + 120_000);
    } finally {
      h.close();
    }
  });

  it('暂停不自动延期：paused Batch/Run 结算后 deadline 与预算快照逐字节不变（恢复不重新初始化预算的存储面）', async () => {
    const h = await openHarness({ batchStatus: 'paused', runStatus: 'paused' });
    try {
      const before = h.batchSnapshot();
      h.settle({ outcome: 'cancelled' });
      const after = h.batchSnapshot();
      expect(after.deadline_at).toBe(before.deadline_at);
      expect(after.budget_snapshot).toBe(before.budget_snapshot);
      expect(after.budget_revision).toBe(before.budget_revision);
      expect(h.runSnapshot().status).toBe('cancelled');
      expect(h.runSnapshot().started_at).toBe(NOW);
    } finally {
      h.close();
    }
  });

  it.each([-1, 0, 1])('绝对 deadline 边界偏移 %i ms：拒绝新启动但允许结算已有 Run，不自动延期', async (offset) => {
    const h = await openHarness();
    try {
      const before = h.batchSnapshot();
      h.setClock(NOW + HOUR_MS + offset);
      const reserve = () => h.session.transactWrite('test.deadlineStart', () =>
        h.access.reserveRuntimeStartInTransaction({
          projectId: h.seed.projectId, batchId: h.seed.batchId, runId: h.seed.runId, startKey: 'boundary-start',
        }));
      if (offset < 0) reserve();
      else expectError(reserve).toThrowError((error) => {
        expectConflict(error, 'budget_exhausted');
        return true;
      });
      const result = h.settle();
      expect(result.runEndedAtUtcMs).toBe(NOW + HOUR_MS + offset);
      expect(h.batchSnapshot()).toMatchObject({
        deadline_at: before.deadline_at, budget_snapshot: before.budget_snapshot,
        budget_revision: before.budget_revision, runtime_starts: offset < 0 ? 1 : 0,
      });
    } finally { h.close(); }
  });

  it.each([-1, 0, 1])('暂停 Run 的时间上限偏移 %i ms：仍按原 started_at 计算，暂停不延长预算', async (offset) => {
    const budget = { ...DEFAULT_BUDGET, run: { ...DEFAULT_BUDGET.run, runTimeLimitMs: 1_000 } };
    const h = await openHarness({ budget, runStatus: 'paused' });
    try {
      h.setClock(NOW + 1_000 + offset);
      const reserve = () => h.session.transactWrite('test.pausedRunTimeLimit', () =>
        h.access.reserveTaskAttemptInTransaction({
          projectId: h.seed.projectId, batchId: h.seed.batchId, runId: h.seed.runId,
          taskId: h.seed.taskId, attemptKey: 'boundary-attempt', maxAttemptsPerTask: null,
        }));
      if (offset < 0) reserve();
      else expectError(reserve).toThrowError((error) => {
        const conflict = expectConflict(error, 'budget_exhausted');
        expect(JSON.stringify(conflict.details)).toContain('runTimeLimitMs');
        return true;
      });
      h.settle({ runRevision: h.runSnapshot().revision });
      expect(h.runSnapshot().started_at).toBe(NOW);
      expect(h.batchSnapshot().deadline_at).toBe(DEFAULT_BUDGET.batch.deadlineUtcMs);
    } finally { h.close(); }
  });

  it('数据库重开一致：结算结果逐字节保留；已成功 workKey 的判定输入（同 workKey succeeded Run）稳定', async () => {
    const sandbox = createTempSandbox('shiploop-p033-f008-reopen-');
    openSandbox = sandbox;
    const dbPath = join(sandbox.path, 'state.db');
    const seedSession = openSqliteStorageSession({ path: dbPath });
    let seed: GraphSeed | undefined;
    let before: Record<string, unknown[]>;
    try {
      await migrateSqliteStorage(seedSession);
      const access = createSqliteExecutionAccess(seedSession, { nowUtcMs: () => NOW });
      seed = seedGraph(seedSession.database);
      seedSession.transactWrite('test.settleSucceeded', () =>
        access.settleExecutionRunOutcomeInTransaction({
          projectId: seed!.projectId,
          batchId: seed!.batchId,
          runId: seed!.runId,
          resultKey: 'result-1',
          runRevision: 1,
          outcome: 'succeeded',
          reason: null,
          progressEvidence: null,
        }),
      );
      before = Object.fromEntries(['runs', 'execution_batches', 'batch_budget_revisions', 'run_outcome_settlements']
        .map((table) => [table, seedSession.database.prepare(`SELECT * FROM ${table}`).all()]));
    } finally {
      seedSession.close();
    }
    const graph = seed!;

    // 重开：Run 终态、ended_at、结算行与 Batch 计数逐字节一致。
    const session = openSqliteStorageSession({ path: dbPath });
    try {
      await migrateSqliteStorage(session);
      for (const [table, rows] of Object.entries(before!)) {
        expect(session.database.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
      }
      const access = createSqliteExecutionAccess(session, { nowUtcMs: () => NOW });
      const reopened = session.transactWrite('test.reopen', () => {
        const runs = access.listExecutionRunsForWorkKeyInTransaction(graph.projectId, graph.batchId, `${graph.featureId}:execute`);
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('succeeded');
        // 已成功 workKey 不因恢复扫描重新派发：判定输入稳定（execution-start 的
        // work_key_succeeded 以同 workKey succeeded Run 为权威依据）。
        return access.getRunOutcomeSettlementInTransaction(graph.projectId, graph.runId, 'result-1');
      });
      expect(reopened?.outcome).toBe('succeeded');
      const batch = session.database
        .prepare('SELECT no_progress_runs, status, deadline_at, budget_snapshot FROM execution_batches WHERE id = ?')
        .get(graph.batchId) as { no_progress_runs: number; status: string; deadline_at: number; budget_snapshot: string };
      expect(batch.no_progress_runs).toBe(1);
      expect(batch.status).toBe('running');
      expect(batch.deadline_at).toBe(DEFAULT_BUDGET.batch.deadlineUtcMs);
      expect(JSON.parse(batch.budget_snapshot)).toEqual(DEFAULT_BUDGET);
    } finally {
      session.close();
    }
  });
});

describe('F-008 归属与命令面边界', () => {
  it('归属负例：Batch/Run 缺失 not_found、跨项目 ownership、Run 不属于声明 Batch、Task 跨 Feature ownership', async () => {
    const h = await openHarness();
    try {
      expectError(() => h.settle({ batchId: randomUUID() })).toThrowError((error: unknown) => {
        expect(isStorageError(error, 'not_found')).toBe(true);
        return true;
      });
      expectError(() => h.settle({ runId: randomUUID() })).toThrowError((error: unknown) => {
        expect(isStorageError(error, 'not_found')).toBe(true);
        return true;
      });
      expectError(() => h.settle({ projectId: 'proj-other' })).toThrowError((error: unknown) => {
        expect(isStorageError(error, 'ownership')).toBe(true);
        return true;
      });
      // 其他 Batch 的 Run（Run 不属于声明 Batch）。
      const otherBatchId = randomUUID();
      h.db.prepare(
        'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
          'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
          'runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 1, 0, 0, 0, ?)',
      ).run(
        otherBatchId,
        NOW,
        h.seed.projectId,
        NOW,
        h.seed.phaseId,
        h.seed.featureId,
        JSON.stringify({ featureIds: [h.seed.featureId] }),
        JSON.stringify({}),
        'succeeded',
        JSON.stringify(DEFAULT_BUDGET),
        DEFAULT_BUDGET.batch.deadlineUtcMs,
      );
      expectError(() => h.settle({ batchId: otherBatchId })).toThrowError((error: unknown) => {
        expect(isStorageError(error, 'ownership')).toBe(true);
        return true;
      });
      // 其他 Feature 的 Task 作为进展证据（范围外）。
      h.db.prepare(
        'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs) VALUES (?, ?, ?, 1, ?, ?, ' +
          "'特性二', 'running', 'approved', '[]', '[]')",
      ).run('feature-other', NOW, h.seed.projectId, NOW, h.seed.phaseId);
      h.db.prepare(
        "INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, acceptance, requirements_refs, execution_config, config_source, attempt_counter, code_attempts_used) " +
          "VALUES ('task-other', ?, ?, 1, ?, 'feature-other', '他特性任务', 'passed', '{}', '[]', ?, 'project_default', 0, 0)",
      ).run(NOW, h.seed.projectId, NOW, JSON.stringify({ schemaVersion: 2 }));
      expectError(() =>
        h.settle({ progressEvidence: { type: 'new_valid_task_passed', taskId: 'task-other' } }),
      ).toThrowError((error: unknown) => {
        expect(isStorageError(error, 'ownership')).toBe(true);
        return true;
      });
      expect(h.settlementRows()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it.each([
    { resultKey: '' }, { resultKey: '   ' }, { resultKey: 'x'.repeat(129) },
    { runRevision: 0 }, { runRevision: 1.5 }, { runRevision: Number.MAX_SAFE_INTEGER + 1 },
    { outcome: 'running' }, { reason: undefined }, { reason: ' ' }, { reason: 'x'.repeat(513) },
    { progressEvidence: { type: 'new_valid_task_passed', taskId: '' } },
    { progressEvidence: { type: 'new_valid_task_passed', taskId: 'task-1', verified: true } },
  ])('非法结算身份、CAS 或证据输入拒绝且零写入：%j', async (input) => {
    const h = await openHarness();
    try {
      const before = h.batchSnapshot();
      const run = h.runSnapshot();
      expectError(() => h.settle(input)).toThrowError((error) => {
        expect(isStorageError(error, 'validation')).toBe(true);
        return true;
      });
      expect(h.batchSnapshot()).toEqual(before);
      expect(h.runSnapshot()).toEqual(run);
      expect(h.settlementRows()).toHaveLength(0);
    } finally { h.close(); }
  });

  it('命令/能力面无结算自报入口：COMMAND_OPERATIONS 与 APP_CAPABILITIES 无 settle/outcome/progress 词汇', async () => {
    const h = await openHarness();
    try {
      const operations = COMMAND_OPERATIONS as readonly string[];
      const capabilities = APP_CAPABILITIES as readonly string[];
      for (const surface of [...operations, ...capabilities]) {
        expect(surface.toLowerCase()).not.toMatch(/settle|outcome|progress/);
      }
    } finally {
      h.close();
    }
  });
});
