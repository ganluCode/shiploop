import { currentSchemaVersion } from '../../../helpers/current-schema.ts';
/**
 * P03-3 / F-006 Batch/Run/Task 预算预占与代码尝试分类记账（真实临时 SQLite）。
 *
 * 覆盖（F-006 验收点，全部为真实持久状态断言）：
 * - 迁移 v11：tasks 追加 attempt_counter/code_attempts_used 计数列（默认 0、非负、
 *   code ≤ total 的 DDL 底线）与 task_attempt_reservations 预占账本表（受信 Core
 *   分类定值、(project,task,attempt_key) 幂等身份唯一、同项目复合外键链）；真实
 *   v10 库（含既有 tasks 行）升级保留数据；不提前建设 attempts 等完整执行表；
 * - 事务内预算原语：总 Attempt 预占一次调用同时增加 Batch 与 Run 累计计数及 Task
 *   双计数，只在现有写事务内可用（CommandTransaction 面接线）；归属（同项目
 *   Batch/Run/Task、Run 属 Batch、Task 在 Batch 单 Feature 范围）、有效控制状态
 *   与绝对 deadline 校验，负例零写入；
 * - 额度临界值（真实 SQLite）：Batch maxTotalAttempts、Run maxAttemptsPerRun、
 *   Run 时间上限、Task maxCodeAttempts 与 maxAttemptsPerTask 的 used==limit-1
 *   恰好放行 / used==limit 恰好拒绝（budget_exhausted）且计数不溢出；同事务
 *   组合写入故障整组回滚；重复预占身份去重（同身份重放返回同一记录不重复调账，
 *   跨 Run 复用身份 conflict）；
 * - 代码尝试分类记账：首次代码执行与代码修复消耗 code_attempts_used；受信 Core
 *   基础设施重分类原语只退还代码额度（总 Attempt、runtime_starts 与绝对时间不
 *   退还），重复分类幂等不重复调账；客户端/模型无任何自报入口（命令白名单/
 *   能力面不含，预占输入不含分类字段）；
 * - 持久性：取消、失败、数据库重开、同 Batch 新 Run、Task 换模型均不清计数、
 *   不改历史输入快照；剩余额度由持久状态断言；
 * - 范围边界：不实现 Task 拓扑选择、完整 Attempt 生命周期、owner/fencing 或进程
 *   执行（P03-4 在同事务接入真实 Attempt 创建）。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteExecutionAccess } from '../../../../packages/core/src/adapters/sqlite/execution-store.ts';
import type { TaskAttemptReservationRecord } from '../../../../packages/core/src/ports/execution-store.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { isStorageError } from '../../../../packages/core/src/ports/errors.ts';
import type { StorageError } from '../../../../packages/core/src/ports/errors.ts';
import { resolveTaskAttemptCaps } from '../../../../packages/core/src/ports/execution-budget.ts';
import {
  TASK_ATTEMPT_CLASSIFIED_BY_CORE,
  validateTaskAttemptReservationInput,
} from '../../../../packages/core/src/ports/execution-store.ts';
import { APP_CAPABILITIES, COMMAND_OPERATIONS } from '../../../../packages/core/src/ports/commands.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_900_000_000_000;
const HOUR_MS = 3_600_000;

/** 夹具默认预算：各维度都允许两次预占，便于单测收索单一维度。 */
const DEFAULT_BUDGET = {
  schemaVersion: 1,
  batch: {
    maxRuns: 2,
    maxTotalAttempts: 4,
    maxRuntimeStarts: 4,
    maxNoProgressRuns: 2,
    deadlineUtcMs: NOW + HOUR_MS,
  },
  run: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS },
};

const DEFAULT_TASK_EXEC_CONFIG = {
  schemaVersion: 2,
  runtime: 'pi',
  provider: 'anthropic',
  model: 'claude-sonnet',
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
  readonly runStartedAt?: number | null;
  readonly runMaxAttempts?: number;
  readonly runTimeLimitMs?: number;
  readonly budget?: typeof DEFAULT_BUDGET;
  readonly taskExecConfig?: Record<string, unknown>;
  readonly taskAttemptCounter?: number;
  readonly taskCodeAttemptsUsed?: number;
}

interface Harness {
  readonly session: SqliteStorageSession;
  readonly db: SqliteStorageSession['database'];
  readonly access: ReturnType<typeof createSqliteExecutionAccess>;
  readonly seed: GraphSeed;
  readonly setClock: (value: number) => void;
  readonly reserve: (input?: Record<string, unknown>) => TaskAttemptReservationRecord;
  readonly reclassify: (attemptKey: string, reason: string) => TaskAttemptReservationRecord;
  readonly counters: () => {
    attemptCounter: number;
    codeAttemptsUsed: number;
    taskRevision: number;
  };
  readonly batchCounters: () => {
    attemptsCreated: number;
    runtimeStarts: number;
    runsCreated: number;
    revision: number;
  };
  readonly runCounters: () => { attemptsCreated: number; revision: number };
  readonly reservationRows: () => readonly Record<string, unknown>[];
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
    "INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs) VALUES (?, ?, ?, 1, ?, ?, '特性一', 'running', 'approved', '[]', '[]')",
  ).run(featureId, NOW, projectId, NOW, phaseId);
  db.prepare(
    'INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, acceptance, requirements_refs, execution_config, config_source, attempt_counter, code_attempts_used) ' +
      "VALUES (?, ?, ?, 1, ?, ?, '任务一', 'pending', '{\"criteria\":[\"验收\"]}', '[]', ?, 'project_default', ?, ?)",
  ).run(
    taskId,
    NOW,
    projectId,
    NOW,
    featureId,
    JSON.stringify(options.taskExecConfig ?? DEFAULT_TASK_EXEC_CONFIG),
    options.taskAttemptCounter ?? 0,
    options.taskCodeAttemptsUsed ?? 0,
  );
  db.prepare(
    'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
      'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
      'runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 1, 0, 0, 0, ?)',
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
    options.runMaxAttempts ?? budget.run.maxAttemptsPerRun,
    options.runTimeLimitMs ?? budget.run.runTimeLimitMs,
    options.runStartedAt === undefined ? NOW : options.runStartedAt,
  );
  return { projectId, phaseId, featureId, taskId, batchId, runId };
}

function seedSecondRun(
  db: SqliteStorageSession['database'],
  seed: GraphSeed,
  ordinal: number,
  status = 'running',
  maxAttempts = 10,
): string {
  const runId = randomUUID();
  db.prepare(
    'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, run_time_limit_ms, attempts_created) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3_600_000, 0)',
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
    status,
    'e'.repeat(64),
    `${seed.featureId}:execute`,
    ordinal,
    maxAttempts,
  );
  return runId;
}

function reserveInput(seed: GraphSeed, attemptKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: seed.projectId,
    batchId: seed.batchId,
    runId: seed.runId,
    taskId: seed.taskId,
    attemptKey,
    ...extra,
  };
}

function reclassifyInput(seed: GraphSeed, attemptKey: string, reason: string): Record<string, unknown> {
  return { projectId: seed.projectId, taskId: seed.taskId, attemptKey, reason };
}

let openSandbox: { cleanup(): void } | undefined;
afterEach(() => {
  if (openSandbox !== undefined) {
    openSandbox.cleanup();
    openSandbox = undefined;
  }
});

async function openHarness(options: SeedOptions = {}, clockInitial: number = NOW, schemaVersion = SQLITE_MIGRATIONS.length): Promise<Harness> {
  const sandbox = createTempSandbox('shiploop-p033-f006-');
  openSandbox = sandbox;
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, schemaVersion) });
  let clock = clockInitial;
  const access = createSqliteExecutionAccess(session, { nowUtcMs: () => clock });
  const seed = seedGraph(session.database, options);
  const db = session.database;
  let closed = false;
  return {
    session,
    db,
    access,
    seed,
    setClock: (value: number) => {
      clock = value;
    },
    reserve: (input?: Record<string, unknown>) =>
      session.transactWrite('test.reserveTaskAttempt', () =>
        access.reserveTaskAttemptInTransaction(input ?? reserveInput(seed, 'attempt-1')),
      ),
    reclassify: (attemptKey: string, reason: string) =>
      session.transactWrite('test.reclassifyTaskAttempt', () =>
        access.reclassifyTaskAttemptAsInfrastructureInTransaction(reclassifyInput(seed, attemptKey, reason)),
      ),
    counters: () => {
      const row = db
        .prepare('SELECT attempt_counter, code_attempts_used, revision FROM tasks WHERE id = ?')
        .get(seed.taskId) as { attempt_counter: number; code_attempts_used: number; revision: number };
      return {
        attemptCounter: row.attempt_counter,
        codeAttemptsUsed: row.code_attempts_used,
        taskRevision: row.revision,
      };
    },
    batchCounters: () => {
      const row = db
        .prepare('SELECT attempts_created, runtime_starts, runs_created, revision FROM execution_batches WHERE id = ?')
        .get(seed.batchId) as { attempts_created: number; runtime_starts: number; runs_created: number; revision: number };
      return {
        attemptsCreated: row.attempts_created,
        runtimeStarts: row.runtime_starts,
        runsCreated: row.runs_created,
        revision: row.revision,
      };
    },
    runCounters: () => {
      const row = db
        .prepare('SELECT attempts_created, revision FROM runs WHERE id = ?')
        .get(seed.runId) as { attempts_created: number; revision: number };
      return { attemptsCreated: row.attempts_created, revision: row.revision };
    },
    reservationRows: () =>
      db.prepare('SELECT * FROM task_attempt_reservations ORDER BY created_at, id').all() as Record<string, unknown>[],
    close: () => {
      if (!closed) {
        session.close();
        closed = true;
      }
    },
  };
}

function captureError(action: () => unknown): StorageError {
  try {
    action();
  } catch (error) {
    if (isStorageError(error)) {
      return error as StorageError;
    }
    throw error;
  }
  throw new Error('预期抛出 StorageError，但调用成功');
}

function expectBudgetExhausted(
  error: StorageError,
  expected: ReadonlyArray<{ layer: string; dimension: string }>,
): void {
  expect(error.kind).toBe('conflict');
  expect(error.details).toMatchObject({ reason: 'budget_exhausted' });
  const reasons = ((error.details as { reasons?: { layer: string; dimension: string }[] }).reasons ?? []);
  expect(reasons).toEqual(expected.map((item) => expect.objectContaining(item)));
}

describe('F-006 迁移 v11：Task 尝试计数列与预占账本表', () => {
  it('空库迁移至 v11 后 tasks 具备双计数列（默认 0）且账本表就绪，不提前建设完整执行表', async () => {
    const harness = await openHarness({}, NOW, 11);
    try {
      const columns = harness.db.prepare('PRAGMA table_xinfo(tasks)').all() as { name: string }[];
      const names = columns.map((column) => column.name);
      expect(names).toContain('attempt_counter');
      expect(names).toContain('code_attempts_used');
      const task = harness.db
        .prepare('SELECT attempt_counter, code_attempts_used FROM tasks WHERE id = ?')
        .get(harness.seed.taskId) as { attempt_counter: number; code_attempts_used: number };
      expect(task).toEqual({ attempt_counter: 0, code_attempts_used: 0 });
      expect(
        harness.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='task_attempt_reservations'").get(),
      ).toEqual({ n: 1 });
      for (const forbidden of ['attempts', 'workspace_leases', 'sessions', 'operations']) {
        expect(
          harness.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?").get(forbidden),
          `不得提前建设 ${forbidden} 表`,
        ).toEqual({ n: 0 });
      }
    } finally {
      harness.close();
    }
  });

  it('真实 v10 库（含既有 tasks 行）升级 v11 保留数据', async () => {
    const sandbox = createTempSandbox('shiploop-p033-f006-v10-');
    openSandbox = sandbox;
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 10) });
      const db = session.database;
      db.prepare(
        "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('proj-1', ?, 1, ?, '旧项目', 'active', '[]')",
      ).run(NOW, NOW);
      db.prepare(
        "INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES ('phase-1', ?, 'proj-1', 1, ?, '阶段', 'open', '[]')",
      ).run(NOW, NOW);
      db.prepare(
        "INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs) VALUES ('feature-1', ?, 'proj-1', 1, ?, 'phase-1', '特性', 'running', 'approved', '[]', '[]')",
      ).run(NOW, NOW);
      db.prepare(
        "INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, acceptance, requirements_refs, execution_config, config_source) VALUES ('task-1', ?, 'proj-1', 3, ?, 'feature-1', '旧任务', 'pending', '{}', '[]', '{}', 'project_default')",
      ).run(NOW, NOW);
      await migrateSqliteStorage(session);
      const task = db
        .prepare('SELECT revision, attempt_counter, code_attempts_used FROM tasks WHERE id = ?')
        .get('task-1') as { revision: number; attempt_counter: number; code_attempts_used: number };
      expect(task).toEqual({ revision: 3, attempt_counter: 0, code_attempts_used: 0 });
      const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
      // v10 数据经 v11（双计数列/账本表）升级保留；全量迁移止于当前冻结版本
      // （P03-7 / F-011 引入 v24）。
      expect(applied.at(-1)).toEqual({ version: currentSchemaVersion });
    } finally {
      session.close();
    }
  });

  it('DDL 底线：负计数、code > total 与账本非法分类/非受信主体/重复身份在 DDL 级拒绝', async () => {
    const harness = await openHarness();
    try {
      const db = harness.db;
      expect(() =>
        db.prepare(
          "INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, acceptance, requirements_refs, execution_config, config_source, attempt_counter, code_attempts_used) VALUES ('bad', ?, 'proj-1', 1, ?, 'feature-1', 'x', 'pending', '{}', '[]', '{}', 'project_default', -1, 0)",
        ).run(NOW, NOW),
      ).toThrowError(/CHECK constraint failed/);
      expect(() =>
        db.prepare(
          "INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, acceptance, requirements_refs, execution_config, config_source, attempt_counter, code_attempts_used) VALUES ('bad', ?, 'proj-1', 1, ?, 'feature-1', 'x', 'pending', '{}', '[]', '{}', 'project_default', 1, 2)",
        ).run(NOW, NOW),
      ).toThrowError(/CHECK constraint failed/);
      const insertReservation = (classification: string, classifiedBy: string, key: string) =>
        db
          .prepare(
            'INSERT INTO task_attempt_reservations (id, created_at, project_id, revision, updated_at, batch_id, run_id, task_id, attempt_key, classification, classified_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(randomUUID(), NOW, harness.seed.projectId, NOW, harness.seed.batchId, harness.seed.runId, harness.seed.taskId, key, classification, classifiedBy);
      expect(() => insertReservation('bogus', TASK_ATTEMPT_CLASSIFIED_BY_CORE, 'k-enum')).toThrowError(/CHECK constraint failed/);
      expect(() => insertReservation('code', 'model-self-report', 'k-who')).toThrowError(/CHECK constraint failed/);
      insertReservation('code', TASK_ATTEMPT_CLASSIFIED_BY_CORE, 'k-dup');
      expect(() => insertReservation('code', TASK_ATTEMPT_CLASSIFIED_BY_CORE, 'k-dup')).toThrowError(/UNIQUE constraint failed/);
      // 跨项目/缺失父行由同项目复合外键拒绝。
      expect(() =>
        db
          .prepare(
            'INSERT INTO task_attempt_reservations (id, created_at, project_id, revision, updated_at, batch_id, run_id, task_id, attempt_key, classification, classified_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(randomUUID(), NOW, harness.seed.projectId, NOW, harness.seed.batchId, harness.seed.runId, 'missing-task', 'k-x', 'code', TASK_ATTEMPT_CLASSIFIED_BY_CORE),
      ).toThrowError(/FOREIGN KEY constraint failed/);
    } finally {
      harness.close();
    }
  });
});

describe('F-006 验收 1：事务内预算原语、归属/状态/deadline 校验', () => {
  it('总 Attempt 预占一次调用同时增加 Batch 与 Run 累计计数与 Task 双计数，账本行受信定值', async () => {
    const harness = await openHarness();
    try {
      const record = harness.reserve();
      expect(record).toMatchObject({
        projectId: harness.seed.projectId,
        batchId: harness.seed.batchId,
        runId: harness.seed.runId,
        taskId: harness.seed.taskId,
        attemptKey: 'attempt-1',
        classification: 'code',
        classifiedBy: TASK_ATTEMPT_CLASSIFIED_BY_CORE,
      });
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(harness.batchCounters().attemptsCreated).toBe(1);
      expect(harness.runCounters().attemptsCreated).toBe(1);
      expect(harness.counters()).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 1 });
      const rows = harness.reservationRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ attempt_key: 'attempt-1', classification: 'code', classified_by: 'core' });
    } finally {
      harness.close();
    }
  });

  it('预算原语只允许在现有写事务内调用，并接线至命令事务面', async () => {
    const harness = await openHarness();
    try {
      expect(() => harness.access.reserveTaskAttemptInTransaction(reserveInput(harness.seed, 'x'))).toThrowError(
        /只允许在写事务内使用/,
      );
      expect(() =>
        harness.access.reclassifyTaskAttemptAsInfrastructureInTransaction(reclassifyInput(harness.seed, 'x', 'r')),
      ).toThrowError(/只允许在写事务内使用/);
      const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => NOW });
      const record = store.transact('test.wiring', (transaction) => {
        expect(typeof transaction.reserveTaskAttempt).toBe('function');
        expect(typeof transaction.reclassifyTaskAttemptAsInfrastructure).toBe('function');
        expect(typeof transaction.getTaskAttemptReservation).toBe('function');
        expect(typeof transaction.getTaskExecutionCounters).toBe('function');
        expect(typeof transaction.getExecutionRun).toBe('function');
        return transaction.reserveTaskAttempt(reserveInput(harness.seed, 'tx-1'));
      });
      expect(record.attemptKey).toBe('tx-1');
      expect(harness.batchCounters().attemptsCreated).toBe(1);
    } finally {
      harness.close();
    }
  });

  it('归属校验：缺失/跨项目/范围外目标结构化拒绝且零写入', async () => {
    const harness = await openHarness();
    try {
      const seed = harness.seed;
      // 第二个 Batch + Run（同 Feature；Batch 终态避开活动唯一）。
      const otherBatch = randomUUID();
      const otherRun = randomUUID();
      harness.db
        .prepare(
          'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, 0, 0, ?)',
        )
        .run(
          otherBatch,
          NOW,
          seed.projectId,
          NOW,
          seed.phaseId,
          seed.featureId,
          JSON.stringify({ featureIds: [seed.featureId] }),
          JSON.stringify({}),
          'failed',
          JSON.stringify(DEFAULT_BUDGET),
          DEFAULT_BUDGET.batch.deadlineUtcMs,
        );
      harness.db
        .prepare(
          'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, run_time_limit_ms, attempts_created) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 2, 3_600_000, 0)',
        )
        .run(
          otherRun,
          NOW,
          seed.projectId,
          NOW,
          otherBatch,
          seed.featureId,
          'execute',
          JSON.stringify({}),
          JSON.stringify({}),
          'failed',
          'b'.repeat(64),
          `${seed.featureId}:execute:2`,
        );
      // 第二个 Feature + Task（不在 Batch 单 Feature 范围）。
      const otherFeature = 'feature-2';
      const otherTask = 'task-2';
      harness.db
        .prepare(
          "INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs) VALUES (?, ?, ?, 1, ?, ?, '特性二', 'running', 'approved', '[]', '[]')",
        )
        .run(otherFeature, NOW, seed.projectId, NOW, seed.phaseId);
      harness.db
        .prepare(
          "INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, acceptance, requirements_refs, execution_config, config_source, attempt_counter, code_attempts_used) VALUES (?, ?, ?, 1, ?, ?, '任务二', 'pending', '{}', '[]', ?, 'project_default', 0, 0)",
        )
        .run(otherTask, NOW, seed.projectId, NOW, otherFeature, JSON.stringify(DEFAULT_TASK_EXEC_CONFIG));

      const negativeCases: ReadonlyArray<[string, Record<string, unknown>, string]> = [
        ['Batch 缺失', { batchId: 'missing-batch-0f8' }, 'not_found'],
        ['Batch 跨项目', { projectId: 'proj-other' }, 'ownership'],
        ['Run 缺失', { runId: 'missing-run-0f8' }, 'not_found'],
        ['Run 不属于声明的 Batch', { batchId: seed.batchId, runId: otherRun }, 'ownership'],
        ['Run 跨项目', { projectId: 'proj-other', runId: seed.runId }, 'ownership'],
        ['Task 缺失', { taskId: 'missing-task-0f8' }, 'not_found'],
        ['Task 跨项目', { projectId: 'proj-other', taskId: seed.taskId }, 'ownership'],
        ['Task 不在 Batch 单 Feature 范围', { taskId: otherTask }, 'ownership'],
      ];
      let index = 0;
      for (const [label, override, kind] of negativeCases) {
        index += 1;
        const error = captureError(() => harness.reserve({ ...reserveInput(seed, `neg-${index}`), ...override }));
        expect(error.kind, label).toBe(kind);
      }
      expect(harness.batchCounters().attemptsCreated).toBe(0);
      expect(harness.runCounters().attemptsCreated).toBe(0);
      expect(harness.counters()).toMatchObject({ attemptCounter: 0, codeAttemptsUsed: 0 });
      expect(harness.reservationRows()).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it('有效控制状态：终态 Batch/Run 拒绝新预占（conflict）且零写入；活动集合内状态仍可预占', async () => {
    for (const [label, status] of [
      ['Batch', 'cancelled'],
      ['Batch', 'succeeded'],
      ['Run', 'failed'],
      ['Run', 'cancelled'],
    ] as const) {
      const isBatch = label === 'Batch';
      const harness = await openHarness(isBatch ? { batchStatus: status } : { runStatus: status });
      try {
        const error = captureError(() => harness.reserve());
        expect(error.kind, `${label} ${status}`).toBe('conflict');
        expect(error.details).toMatchObject(
          isBatch ? { reason: 'batch_not_active' } : { reason: 'run_not_active' },
        );
        expect(harness.batchCounters().attemptsCreated).toBe(0);
        expect(harness.counters().attemptCounter).toBe(0);
        expect(harness.reservationRows()).toHaveLength(0);
      } finally {
        harness.close();
      }
    }
    for (const status of ['pausing', 'paused', 'cancelling', 'interrupted'] as const) {
      const harness = await openHarness({ batchStatus: status, runStatus: status });
      try {
        const record = harness.reserve();
        expect(record.attemptKey).toBe('attempt-1');
        expect(harness.batchCounters().attemptsCreated).toBe(1);
      } finally {
        harness.close();
      }
    }
  });

  it('绝对 deadline：now == deadline 恰好耗尽（budget_exhausted），now == deadline-1 放行', async () => {
    const deadline = NOW + 10_000;
    const budget = { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, deadlineUtcMs: deadline } };
    const late = await openHarness({ budget }, deadline);
    try {
      const error = captureError(() => late.reserve());
      expectBudgetExhausted(error, [{ layer: 'batch', dimension: 'deadlineUtcMs' }]);
      expect(late.counters().attemptCounter).toBe(0);
      expect(late.batchCounters().attemptsCreated).toBe(0);
    } finally {
      late.close();
    }
    const early = await openHarness({ budget }, deadline - 1);
    try {
      expect(() => early.reserve()).not.toThrow();
      expect(early.counters().attemptCounter).toBe(1);
    } finally {
      early.close();
    }
  });

  it('同事务组合写入故障整组回滚：不允许先提交扣额再另事务创建 Attempt', async () => {
    const harness = await openHarness();
    try {
      expect(() =>
        harness.session.transactWrite('test.combined-failure', () => {
          harness.access.reserveTaskAttemptInTransaction(reserveInput(harness.seed, 'attempt-rollback'));
          // 同一事务内后续写入失败（模拟 P03-4 真实 Attempt 创建在同事务内的故障）。
          harness.db.prepare('INSERT INTO task_attempt_reservations (id) VALUES (NULL)').run();
        }),
      ).toThrowError();
      expect(harness.batchCounters().attemptsCreated).toBe(0);
      expect(harness.runCounters().attemptsCreated).toBe(0);
      expect(harness.counters()).toMatchObject({ attemptCounter: 0, codeAttemptsUsed: 0 });
      expect(harness.reservationRows()).toHaveLength(0);
    } finally {
      harness.close();
    }
  });
});

describe('F-006 验收 2：真实 SQLite 额度临界值与重复身份去重', () => {
  it('Batch maxTotalAttempts：used==limit-1 放行、used==limit 恰好拒绝且计数不溢出', async () => {
    const budget = { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, maxTotalAttempts: 2 } };
    const harness = await openHarness({ budget, runMaxAttempts: 4 });
    try {
      expect(() => harness.reserve(reserveInput(harness.seed, 'a1'))).not.toThrow();
      expect(() => harness.reserve(reserveInput(harness.seed, 'a2'))).not.toThrow();
      expect(harness.batchCounters().attemptsCreated).toBe(2);
      const error = captureError(() => harness.reserve(reserveInput(harness.seed, 'a3')));
      expectBudgetExhausted(error, [{ layer: 'batch', dimension: 'maxTotalAttempts' }]);
      // 拒绝后计数不溢出（保持在上限值）。
      expect(harness.batchCounters().attemptsCreated).toBe(2);
      expect(harness.runCounters().attemptsCreated).toBe(2);
      expect(harness.counters().attemptCounter).toBe(2);
      expect(harness.reservationRows()).toHaveLength(2);
    } finally {
      harness.close();
    }
  });

  it('Run maxAttemptsPerRun：临界拒绝（layer run）且零写入', async () => {
    const harness = await openHarness({
      runMaxAttempts: 1,
      budget: { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, maxTotalAttempts: 4 } },
    });
    try {
      expect(() => harness.reserve(reserveInput(harness.seed, 'a1'))).not.toThrow();
      const error = captureError(() => harness.reserve(reserveInput(harness.seed, 'a2')));
      expectBudgetExhausted(error, [{ layer: 'run', dimension: 'maxAttemptsPerRun' }]);
      expect(harness.runCounters().attemptsCreated).toBe(1);
      expect(harness.batchCounters().attemptsCreated).toBe(1);
      expect(harness.counters().attemptCounter).toBe(1);
    } finally {
      harness.close();
    }
  });

  it('Run 时间上限：elapsed == limit 恰好拒绝、elapsed == limit-1 放行', async () => {
    const runTimeLimitMs = 5_000;
    const startedAt = NOW;
    const late = await openHarness(
      { runTimeLimitMs, runStartedAt: startedAt, runMaxAttempts: 5 },
      startedAt + runTimeLimitMs,
    );
    try {
      const error = captureError(() => late.reserve());
      expectBudgetExhausted(error, [{ layer: 'run', dimension: 'runTimeLimitMs' }]);
      expect(late.counters().attemptCounter).toBe(0);
    } finally {
      late.close();
    }
    const early = await openHarness(
      { runTimeLimitMs, runStartedAt: startedAt, runMaxAttempts: 5 },
      startedAt + runTimeLimitMs - 1,
    );
    try {
      expect(() => early.reserve()).not.toThrow();
      expect(early.counters().attemptCounter).toBe(1);
    } finally {
      early.close();
    }
  });

  it('Task maxCodeAttempts：默认 3（含首次），配置值临界生效', async () => {
    // 默认上限：execution_config 未捕获 maxCodeAttempts。
    const harness = await openHarness({
      budget: { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, maxTotalAttempts: 10 } },
      runMaxAttempts: 10,
    });
    try {
      for (let index = 1; index <= 3; index += 1) {
        expect(() => harness.reserve(reserveInput(harness.seed, `a${index}`)), `第 ${index} 次代码尝试`).not.toThrow();
      }
      const error = captureError(() => harness.reserve(reserveInput(harness.seed, 'a4')));
      expectBudgetExhausted(error, [{ layer: 'task', dimension: 'maxCodeAttempts' }]);
      expect(harness.counters()).toMatchObject({ attemptCounter: 3, codeAttemptsUsed: 3 });
    } finally {
      harness.close();
    }
    // 配置上限 2：第三次拒绝。
    const configured = await openHarness({
      taskExecConfig: { ...DEFAULT_TASK_EXEC_CONFIG, maxCodeAttempts: 2 },
      budget: { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, maxTotalAttempts: 10 } },
      runMaxAttempts: 10,
    });
    try {
      expect(() => configured.reserve(reserveInput(configured.seed, 'a1'))).not.toThrow();
      expect(() => configured.reserve(reserveInput(configured.seed, 'a2'))).not.toThrow();
      const error = captureError(() => configured.reserve(reserveInput(configured.seed, 'a3')));
      expectBudgetExhausted(error, [{ layer: 'task', dimension: 'maxCodeAttempts' }]);
      expect(configured.counters().codeAttemptsUsed).toBe(2);
    } finally {
      configured.close();
    }
  });

  it('Task 总尝试上限 maxAttemptsPerTask：独立于代码额度且总 Attempt 不退还', async () => {
    const harness = await openHarness({
      budget: { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, maxTotalAttempts: 10 } },
      runMaxAttempts: 10,
    });
    try {
      // 总上限 2；第一次预占后重分类为基础设施失败（退还代码额度）。
      const maxAttemptsPerTask = 2;
      harness.reserve({ ...reserveInput(harness.seed, 'a1'), maxAttemptsPerTask });
      harness.reclassify('a1', 'SDK 协议错误');
      expect(harness.counters()).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 0 });
      // 第二次（代码额度已退还）仍受总上限约束。
      harness.reserve({ ...reserveInput(harness.seed, 'a2'), maxAttemptsPerTask });
      const error = captureError(() => harness.reserve({ ...reserveInput(harness.seed, 'a3'), maxAttemptsPerTask }));
      expectBudgetExhausted(error, [{ layer: 'task', dimension: 'maxAttemptsPerTask' }]);
      expect(harness.counters()).toMatchObject({ attemptCounter: 2, codeAttemptsUsed: 1 });
    } finally {
      harness.close();
    }
  });

  it('重复预占身份去重：同身份重放返回同一记录不重复调账；跨 Run 复用身份 conflict', async () => {
    const harness = await openHarness();
    try {
      const first = harness.reserve();
      const replay = harness.reserve();
      expect(replay.id).toBe(first.id);
      expect(harness.batchCounters().attemptsCreated).toBe(1);
      expect(harness.runCounters().attemptsCreated).toBe(1);
      expect(harness.counters()).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 1 });
      expect(harness.reservationRows()).toHaveLength(1);
      // 同 Batch 新 Run 复用同 attemptKey：身份不得跨 Run 重复预占（先按真实重试
      // 形态将旧 Run 置终态，避开同 Feature 活动 Run 唯一）。
      harness.db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run('failed', NOW + 1, harness.seed.runId);
      const secondRun = seedSecondRun(harness.db, harness.seed, 2, 'queued', 2);
      const error = captureError(() => harness.reserve({ ...reserveInput(harness.seed, 'attempt-1'), runId: secondRun }));
      expect(error.kind).toBe('conflict');
      expect(error.details).toMatchObject({ reason: 'attempt_key_reused' });
      expect(harness.reservationRows()).toHaveLength(1);
      expect(harness.counters().attemptCounter).toBe(1);
    } finally {
      harness.close();
    }
  });
});

describe('F-006 验收 3：代码尝试分类记账（受信 Core 分类）', () => {
  it('基础设施重分类只退还代码额度：总 Attempt、runtime_starts 与绝对时间不退还', async () => {
    const harness = await openHarness();
    try {
      harness.reserve();
      harness.setClock(NOW + 1_000);
      const batchBefore = harness.batchCounters();
      const record = harness.reclassify('attempt-1', 'SDK 协议错误（受信 Core 分类）');
      expect(record.classification).toBe('infrastructure');
      expect(record.reason).toBe('SDK 协议错误（受信 Core 分类）');
      expect(harness.counters()).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 0 });
      expect(harness.batchCounters()).toMatchObject({
        attemptsCreated: batchBefore.attemptsCreated,
        runtimeStarts: batchBefore.runtimeStarts,
        runsCreated: batchBefore.runsCreated,
      });
      expect(harness.runCounters().attemptsCreated).toBe(1);
      const rows = harness.reservationRows();
      expect(rows[0]).toMatchObject({ classification: 'infrastructure', reason: 'SDK 协议错误（受信 Core 分类）' });
    } finally {
      harness.close();
    }
  });

  it('重复分类不重复调账：幂等返回当前记录，计数不再变化', async () => {
    const harness = await openHarness();
    try {
      harness.reserve();
      harness.reclassify('attempt-1', '第一次分类');
      expect(harness.counters()).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 0 });
      const second = harness.reclassify('attempt-1', '第二次分类');
      expect(second.classification).toBe('infrastructure');
      expect(harness.counters()).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 0 });
      // code_attempts_used 不会减为负。
      expect(harness.db.prepare('SELECT code_attempts_used AS c FROM tasks WHERE id = ?').get(harness.seed.taskId)).toEqual({ c: 0 });
    } finally {
      harness.close();
    }
  });

  it('重分类后代码额度可继续使用（基础设施失败可不计代码额度）', async () => {
    const harness = await openHarness({
      taskExecConfig: { ...DEFAULT_TASK_EXEC_CONFIG, maxCodeAttempts: 2 },
      budget: { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, maxTotalAttempts: 10 } },
      runMaxAttempts: 10,
    });
    try {
      harness.reserve(reserveInput(harness.seed, 'a1'));
      harness.reserve(reserveInput(harness.seed, 'a2'));
      const exhausted = captureError(() => harness.reserve(reserveInput(harness.seed, 'a3')));
      expectBudgetExhausted(exhausted, [{ layer: 'task', dimension: 'maxCodeAttempts' }]);
      harness.reclassify('a2', '认证失败');
      expect(() => harness.reserve(reserveInput(harness.seed, 'a3'))).not.toThrow();
      expect(harness.counters()).toMatchObject({ attemptCounter: 3, codeAttemptsUsed: 2 });
    } finally {
      harness.close();
    }
  });

  it('重分类归属/缺失负例：缺失账本 not_found、跨项目 ownership、非法输入零写入', async () => {
    const harness = await openHarness();
    try {
      harness.reserve();
      const missing = captureError(() => harness.reclassify('missing-key', 'r'));
      expect(missing.kind).toBe('not_found');
      const crossProject = captureError(() =>
        harness.session.transactWrite('test.reclassify-cross', () =>
          harness.access.reclassifyTaskAttemptAsInfrastructureInTransaction({
            ...reclassifyInput(harness.seed, 'attempt-1', 'r'),
            projectId: 'proj-other',
          }),
        ),
      );
      expect(crossProject.kind).toBe('ownership');
      expect(() =>
        harness.session.transactWrite('test.reclassify-invalid', () =>
          harness.access.reclassifyTaskAttemptAsInfrastructureInTransaction(reclassifyInput(harness.seed, 'attempt-1', '  ')),
        ),
      ).toThrowError(/reason/);
      expect(harness.counters()).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 1 });
    } finally {
      harness.close();
    }
  });

  it('客户端或模型不能自报：命令/能力面无预占与分类操作，预占输入不含分类字段', async () => {
    expect(COMMAND_OPERATIONS.filter((operation) => /attempt|reserve|reclassify/i.test(operation))).toEqual(['execution.attempt.cancel']);
    expect(APP_CAPABILITIES.filter((capability) => /attempt|reserve|reclassify/i.test(capability))).toEqual([]);
    const base = { projectId: 'proj-1', batchId: 'batch-1', runId: 'run-1', taskId: 'task-1' };
    const input = validateTaskAttemptReservationInput({ ...base, attemptKey: 'a1' }, 'Test.validate');
    expect(input.attemptKey).toBe('a1');
    expect(input.maxAttemptsPerTask).toBeNull();
    // 分类不是预占请求字段（分类只能由受信 Core 走重分类原语）；owner/lease 等执行字段拒绝。
    expect(() =>
      validateTaskAttemptReservationInput({ ...base, attemptKey: 'a1', classification: 'infrastructure' }, 'Test.validate'),
    ).toThrowError(/未知字段/);
    expect(() => validateTaskAttemptReservationInput({ owner: 'model-1' }, 'Test.validate')).toThrowError(/未知字段/);
  });
});

describe('F-006 验收 4：取消/失败/重开/新 Run/换模型不清计数，快照不变', () => {
  it('Run 取消与失败后计数保持；成功代码尝试不退次数', async () => {
    const harness = await openHarness({
      taskExecConfig: { ...DEFAULT_TASK_EXEC_CONFIG, maxCodeAttempts: 2 },
      budget: { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, maxTotalAttempts: 10 } },
      runMaxAttempts: 10,
    });
    try {
      harness.reserve(reserveInput(harness.seed, 'a1'));
      // Run 终态（取消/失败）：没有任何退额路径，计数保持。
      harness.db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run('cancelled', NOW + 1, harness.seed.runId);
      expect(harness.counters()).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 1 });
      harness.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('failed', harness.seed.runId);
      expect(harness.counters()).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 1 });
      expect(harness.batchCounters().attemptsCreated).toBe(1);
      // 第二次代码预占在新 Run 上继续消耗（成功尝试不退次数），直至耗尽。
      const secondRun = seedSecondRun(harness.db, harness.seed, 2);
      harness.reserve({ ...reserveInput(harness.seed, 'a2'), runId: secondRun });
      expect(harness.counters()).toMatchObject({ attemptCounter: 2, codeAttemptsUsed: 2 });
      const error = captureError(() => harness.reserve({ ...reserveInput(harness.seed, 'a3'), runId: secondRun }));
      expectBudgetExhausted(error, [{ layer: 'task', dimension: 'maxCodeAttempts' }]);
    } finally {
      harness.close();
    }
  });

  it('数据库关闭重开：计数、账本与历史输入快照逐字节不变，剩余额度一致', async () => {
    const sandbox = createTempSandbox('shiploop-p033-f006-reopen-');
    openSandbox = sandbox;
    const path = join(sandbox.path, 'state.db');
    const session = openSqliteStorageSession({ path });
    await migrateSqliteStorage(session);
    const seed = seedGraph(session.database, {
      taskExecConfig: { ...DEFAULT_TASK_EXEC_CONFIG, maxCodeAttempts: 3 },
      budget: { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, maxTotalAttempts: 10 } },
      runMaxAttempts: 10,
    });
    const access = createSqliteExecutionAccess(session, { nowUtcMs: () => NOW });
    session.transactWrite('test.reserve', () => access.reserveTaskAttemptInTransaction(reserveInput(seed, 'a1')));
    session.transactWrite('test.reserve', () => access.reserveTaskAttemptInTransaction(reserveInput(seed, 'a2')));
    const before = {
      task: session.database.prepare('SELECT * FROM tasks WHERE id = ?').get(seed.taskId) as Record<string, unknown>,
      batch: session.database.prepare('SELECT * FROM execution_batches WHERE id = ?').get(seed.batchId) as Record<string, unknown>,
      run: session.database.prepare('SELECT * FROM runs WHERE id = ?').get(seed.runId) as Record<string, unknown>,
      reservations: session.database.prepare('SELECT * FROM task_attempt_reservations ORDER BY id').all() as Record<string, unknown>[],
    };
    session.close();
    const reopened = openSqliteStorageSession({ path });
    try {
      expect(reopened.database.prepare('SELECT * FROM tasks WHERE id = ?').get(seed.taskId)).toEqual(before.task);
      expect(reopened.database.prepare('SELECT * FROM execution_batches WHERE id = ?').get(seed.batchId)).toEqual(before.batch);
      expect(reopened.database.prepare('SELECT * FROM runs WHERE id = ?').get(seed.runId)).toEqual(before.run);
      expect(reopened.database.prepare('SELECT * FROM task_attempt_reservations ORDER BY id').all()).toEqual(before.reservations);
      // 剩余额度由持久状态断言（caps 与持久计数合并计算）。
      const reopenedAccess = createSqliteExecutionAccess(reopened, { nowUtcMs: () => NOW });
      const persisted = reopened.transactWrite('test.read', () =>
        reopenedAccess.getTaskExecutionCountersInTransaction(seed.projectId, seed.taskId),
      );
      expect(persisted).toMatchObject({ attemptCounter: 2, codeAttemptsUsed: 2 });
      const caps = resolveTaskAttemptCaps({ maxCodeAttempts: 3 }, { operation: 'Test' });
      expect(caps.effectiveMaxCodeAttempts - persisted.codeAttemptsUsed).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it('同 Batch 新 Run 与 Task 换模型不清 Task 累计额度，历史输入快照不变', async () => {
    const harness = await openHarness({
      budget: { ...DEFAULT_BUDGET, batch: { ...DEFAULT_BUDGET.batch, maxTotalAttempts: 10, maxRuns: 3 } },
      runMaxAttempts: 10,
    });
    try {
      harness.reserve(reserveInput(harness.seed, 'a1'));
      const runSnapshotBefore = harness.db.prepare('SELECT input_snapshot, config_snapshot FROM runs WHERE id = ?').get(harness.seed.runId);
      const batchSnapshotBefore = harness.db.prepare('SELECT scope_snapshot, config_snapshot FROM execution_batches WHERE id = ?').get(harness.seed.batchId);
      // 同 Batch 新 Run（重试派发：旧 Run 先置终态，避开同 Feature 活动 Run 唯一）。
      harness.db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run('failed', NOW + 1, harness.seed.runId);
      const secondRun = seedSecondRun(harness.db, harness.seed, 2);
      harness.reserve({ ...reserveInput(harness.seed, 'a2'), runId: secondRun });
      expect(harness.counters()).toMatchObject({ attemptCounter: 2, codeAttemptsUsed: 2 });
      // Task 换模型（策略 CAS 通道整体替换 execution_config）。
      harness.db
        .prepare('UPDATE tasks SET execution_config = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...DEFAULT_TASK_EXEC_CONFIG, model: 'claude-opus' }), NOW + 2, harness.seed.taskId);
      expect(harness.counters()).toMatchObject({ attemptCounter: 2, codeAttemptsUsed: 2 });
      expect(harness.db.prepare('SELECT input_snapshot, config_snapshot FROM runs WHERE id = ?').get(harness.seed.runId)).toEqual(runSnapshotBefore);
      expect(harness.db.prepare('SELECT scope_snapshot, config_snapshot FROM execution_batches WHERE id = ?').get(harness.seed.batchId)).toEqual(batchSnapshotBefore);
      // 换模型后新预占继续受剩余额度约束（不清零）。
      harness.reserve({ ...reserveInput(harness.seed, 'a3'), runId: secondRun });
      const error = captureError(() => harness.reserve({ ...reserveInput(harness.seed, 'a4'), runId: secondRun }));
      expectBudgetExhausted(error, [{ layer: 'task', dimension: 'maxCodeAttempts' }]);
    } finally {
      harness.close();
    }
  });
});

describe('F-006 验收 5：范围边界与输入校验', () => {
  it('输入校验负例（零 SQL）：attemptKey 空/空白/超长、maxAttemptsPerTask 越界、未知键', async () => {
    const harness = await openHarness();
    try {
      const cases: ReadonlyArray<Record<string, unknown>> = [
        { ...reserveInput(harness.seed, 'a1'), attemptKey: '' },
        { ...reserveInput(harness.seed, 'a1'), attemptKey: '   ' },
        { ...reserveInput(harness.seed, 'a1'), attemptKey: 'x'.repeat(129) },
        { ...reserveInput(harness.seed, 'a1'), maxAttemptsPerTask: 0 },
        { ...reserveInput(harness.seed, 'a1'), maxAttemptsPerTask: 101 },
        { ...reserveInput(harness.seed, 'a1'), maxAttemptsPerTask: 1.5 },
        { ...reserveInput(harness.seed, 'a1'), leaseUntil: NOW + 1_000 },
      ];
      for (const input of cases) {
        expect(() => harness.reserve(input)).toThrowError();
      }
      expect(harness.reservationRows()).toHaveLength(0);
      expect(harness.counters().attemptCounter).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('读取原语：账本读取与 Task 计数读取（not_found/ownership/持久断言）', async () => {
    const harness = await openHarness();
    try {
      harness.reserve();
      const reservation = harness.session.transactWrite('test.read', () =>
        harness.access.getTaskAttemptReservationInTransaction(harness.seed.projectId, harness.seed.taskId, 'attempt-1'),
      );
      expect(reservation).toMatchObject({ attemptKey: 'attempt-1', classification: 'code' });
      expect(
        harness.session.transactWrite('test.read-missing', () =>
          harness.access.getTaskAttemptReservationInTransaction(harness.seed.projectId, harness.seed.taskId, 'missing'),
        ),
      ).toBeNull();
      const counters = harness.session.transactWrite('test.read-counters', () =>
        harness.access.getTaskExecutionCountersInTransaction(harness.seed.projectId, harness.seed.taskId),
      );
      expect(counters).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 1 });
      const missingTask = captureError(() =>
        harness.session.transactWrite('test.read-missing-task', () =>
          harness.access.getTaskExecutionCountersInTransaction(harness.seed.projectId, 'missing-task-0f8'),
        ),
      );
      expect(missingTask.kind).toBe('not_found');
      const crossProject = captureError(() =>
        harness.session.transactWrite('test.read-cross', () =>
          harness.access.getTaskExecutionCountersInTransaction('proj-other', harness.seed.taskId),
        ),
      );
      expect(crossProject.kind).toBe('ownership');
      const run = harness.session.transactWrite('test.read-run', () =>
        harness.access.getExecutionRunInTransaction(harness.seed.projectId, harness.seed.runId),
      );
      expect(run.attemptsCreated).toBe(1);
      expect(run.inputSnapshot).toEqual({ inputIdentity: 'input-v1' });
    } finally {
      harness.close();
    }
  });

  it('execution_config 中 maxCodeAttempts 漂移 fail-closed（corrupt），不作为有效预算', async () => {
    const harness = await openHarness();
    try {
      harness.db
        .prepare('UPDATE tasks SET execution_config = ? WHERE id = ?')
        .run(JSON.stringify({ ...DEFAULT_TASK_EXEC_CONFIG, maxCodeAttempts: 'three' }), harness.seed.taskId);
      const error = captureError(() => harness.reserve());
      expect(error.kind).toBe('corrupt');
      expect(harness.counters().attemptCounter).toBe(0);
    } finally {
      harness.close();
    }
  });
});
