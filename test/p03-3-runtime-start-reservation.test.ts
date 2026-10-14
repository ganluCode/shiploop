/**
 * P03-3 / F-007 Runtime 启动额度预占边界（真实临时 SQLite）。
 *
 * 覆盖（F-007 验收点，全部为真实持久状态断言；普通测试仅记录受信启动边界
 * 调用——不调用 Pi、网络或模型，不提前实现 Runner、停止管理或会话记录）：
 * - 迁移 v12：runtime_start_reservations 启动预占账本表（幂等启动身份
 *   UNIQUE(project_id,start_key)、同项目复合外键链、无 token/cost 或
 *   sdk_started/outcome/进程列）；真实 v11 库升级保留数据；历史 v1..v11 不变；
 * - 受信启动边界：预占只能关联当前获准 Run（同项目 Batch/Run 归属 + Run 属于
 *   声明 Batch），一次调用原子递增父 Batch runtime_starts 并落账本行（同事务
 *   检查父 Batch 启动额度、绝对 deadline 与有效控制状态）；仅创建 Run、预览、
 *   准备输入或最终检查不增加 runtimeStarts（准备前失败总 Attempt 可保留但
 *   Runtime 启动数为零）；通过本边界预占后启动失败保守保留一次启动计数
 *   （无退额原语），不伪造 token/cost 或真实 SDK 已启动事实；
 * - 幂等与身份：同一启动身份重放只计一次（终态后重放仍幂等返回——计数上限
 *   不撤销已有执行身份）；跨 Run/过期身份 conflict start_key_reused；跨项目
 *   ownership；
 * - 额度与 deadline：maxRuntimeStarts used==limit-1 放行 / used==limit 恰好拒绝
 *   （budget_exhausted）且计数不溢出；deadline 到达返回 budget_exhausted 并作为
 *   必须受控停止的原因（不清空占用、不假称进程已停止）；竞争预占先到先得；
 * - 持久性：真实 SQLite 验证竞争预占、重放、回滚（组合事务故障整组回滚）与
 *   数据库重开一致性；命令/能力面无 runtime start 自报入口。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteExecutionAccess } from '../packages/core/src/adapters/sqlite/execution-store.ts';
import type { RuntimeStartReservationRecord } from '../packages/core/src/ports/execution-store.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError } from '../packages/core/src/ports/errors.ts';
import { APP_CAPABILITIES, COMMAND_OPERATIONS } from '../packages/core/src/ports/commands.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const NOW = 1_900_000_000_000;
const HOUR_MS = 3_600_000;

/** 夹具默认预算：启动维度允许两次预占，便于单测收索单一维度。 */
const DEFAULT_BUDGET = {
  schemaVersion: 1,
  batch: {
    maxRuns: 3,
    maxTotalAttempts: 6,
    maxRuntimeStarts: 2,
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
  readonly batchRuntimeStarts?: number;
  readonly batchAttemptsCreated?: number;
  readonly taskAttemptCounter?: number;
  readonly taskCodeAttemptsUsed?: number;
}

interface Harness {
  readonly session: SqliteStorageSession;
  readonly db: SqliteStorageSession['database'];
  readonly access: ReturnType<typeof createSqliteExecutionAccess>;
  readonly seed: GraphSeed;
  readonly setClock: (value: number) => void;
  readonly reserve: (input?: Record<string, unknown>) => RuntimeStartReservationRecord;
  readonly batchCounters: () => {
    runtimeStarts: number;
    attemptsCreated: number;
    runsCreated: number;
    noProgressRuns: number;
    revision: number;
  };
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
    JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }),
    options.taskAttemptCounter ?? 0,
    options.taskCodeAttemptsUsed ?? 0,
  );
  db.prepare(
    'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
      'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
      'runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, 0, ?)',
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
    options.batchAttemptsCreated ?? 0,
    options.batchRuntimeStarts ?? 0,
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

/** 第二个项目（跨项目负例）：独立 project/phase/feature/batch/run。 */
function seedSecondProject(db: SqliteStorageSession['database']): { batchId: string; runId: string } {
  const batchId = randomUUID();
  const runId = randomUUID();
  db.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('proj-2', ?, 1, ?, '另一项目', 'active', '[]')",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES ('phase-2', ?, 'proj-2', 1, ?, '阶段二', 'open', '[]')",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs) VALUES ('feature-2', ?, 'proj-2', 1, ?, 'phase-2', '特性二', 'running', 'approved', '[]', '[]')",
  ).run(NOW, NOW);
  db.prepare(
    'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
      "scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, " +
      'runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 1, 0, 0, 0, ?)',
  ).run(
    batchId,
    NOW,
    'proj-2',
    NOW,
    'phase-2',
    'feature-2',
    JSON.stringify({ featureIds: ['feature-2'] }),
    JSON.stringify({}),
    'running',
    JSON.stringify(DEFAULT_BUDGET),
    NOW + HOUR_MS,
  );
  db.prepare(
    'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
      'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, ' +
      'run_time_limit_ms, attempts_created, started_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 3, 3_600_000, 0, ?)',
  ).run(
    runId,
    NOW,
    'proj-2',
    NOW,
    batchId,
    'feature-2',
    'execute',
    JSON.stringify({}),
    JSON.stringify({}),
    'running',
    'b'.repeat(64),
    'feature-2:execute',
    NOW,
  );
  return { batchId, runId };
}

/** 同 Batch 同 Feature 的另一 Run（跨 Run 复用身份负例）。 */
function seedSecondRun(db: SqliteStorageSession['database'], seed: GraphSeed, ordinal: number): string {
  const runId = randomUUID();
  db.prepare(
    'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
      'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, ' +
      'run_time_limit_ms, attempts_created, started_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, 3_600_000, 0, ?)',
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
    'e'.repeat(64),
    `${seed.featureId}:execute`,
    ordinal,
    NOW,
  );
  return runId;
}

function reserveInput(seed: GraphSeed, startKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: seed.projectId,
    batchId: seed.batchId,
    runId: seed.runId,
    startKey,
    ...extra,
  };
}

/** 同项目同 Feature 的终态 Batch + 活动 Run（Run 不属于声明 Batch 的归属负例）。 */
function seedRunInOtherBatch(db: SqliteStorageSession['database'], seed: GraphSeed): string {
  const batchId = randomUUID();
  const runId = randomUUID();
  db.prepare(
    'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
      'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
      'runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 1, 0, 0, 0, ?)',
  ).run(
    batchId,
    NOW,
    seed.projectId,
    NOW,
    seed.phaseId,
    seed.featureId,
    JSON.stringify({ featureIds: [seed.featureId] }),
    JSON.stringify({}),
    // 终态 Batch 不参与同 Phase 活动唯一；仅作归属核验目标存在。
    'cancelled',
    JSON.stringify(DEFAULT_BUDGET),
    NOW + HOUR_MS,
  );
  db.prepare(
    'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
      'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, ' +
      'run_time_limit_ms, attempts_created, started_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 3, 3_600_000, 0, ?)',
  ).run(
    runId,
    NOW,
    seed.projectId,
    NOW,
    batchId,
    seed.featureId,
    'execute',
    JSON.stringify({}),
    JSON.stringify({}),
    'interrupted',
    'c'.repeat(64),
    `${seed.featureId}:execute`,
    NOW,
  );
  return runId;
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
  schemaVersion = SQLITE_MIGRATIONS.length,
): Promise<Harness> {
  const sandbox = createTempSandbox('shiploop-p033-f007-');
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
      session.transactWrite('test.reserveRuntimeStart', () =>
        access.reserveRuntimeStartInTransaction(input ?? reserveInput(seed, 'start-1')),
      ),
    batchCounters: () => {
      const row = db
        .prepare(
          'SELECT runtime_starts, attempts_created, runs_created, no_progress_runs, revision FROM execution_batches WHERE id = ?',
        )
        .get(seed.batchId) as {
        runtime_starts: number;
        attempts_created: number;
        runs_created: number;
        no_progress_runs: number;
        revision: number;
      };
      return {
        runtimeStarts: row.runtime_starts,
        attemptsCreated: row.attempts_created,
        runsCreated: row.runs_created,
        noProgressRuns: row.no_progress_runs,
        revision: row.revision,
      };
    },
    reservationRows: () =>
      db.prepare('SELECT * FROM runtime_start_reservations ORDER BY created_at, id').all() as Record<string, unknown>[],
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
  expect(reasons).toHaveLength(expected.length);
  for (const [index, item] of expected.entries()) {
    expect(reasons[index]).toMatchObject(item);
  }
}

/* ------------------------------------------------------------------ *
 * 迁移 v12
 * ------------------------------------------------------------------ */

describe('F-007 迁移 v12：Runtime 启动预占账本表', () => {
  it('空库迁移至 v12 后账本表就绪（幂等身份/外键链），不提前建设会话记录或 Runner 表', async () => {
    const h = await openHarness({}, NOW, 12);
    try {
      const columns = h.db
        .prepare('SELECT name FROM pragma_table_info(?)')
        .all('runtime_start_reservations')
        .map((row) => (row as { name: string }).name);
      expect(columns).toEqual([
        'id',
        'created_at',
        'project_id',
        'revision',
        'updated_at',
        'batch_id',
        'run_id',
        'start_key',
      ]);
      // 账本行只是预占证据：无 token/cost 用量列、无 sdk_started/outcome/进程列。
      expect(columns).not.toContain('token_used');
      expect(columns).not.toContain('cost_used');
      expect(columns).not.toContain('sdk_started');
      expect(columns).not.toContain('outcome');
      const indexes = h.db
        .prepare('SELECT name, "unique" FROM pragma_index_list(?)')
        .all('runtime_start_reservations') as { name: string; unique: number }[];
      expect(indexes).toContainEqual({ name: 'runtime_start_reservations_project_start_key_unique', unique: 1 });
      const tables = h.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => (row as { name: string }).name);
      // 不提前实现 Runner、停止管理或会话记录。
      for (const forbidden of ['sessions', 'chat_turns', 'session_messages', 'recording_manifests', 'workspace_leases', 'attempts']) {
        expect(tables, `不得提前建设 ${forbidden}`).not.toContain(forbidden);
      }
      // state_events 不加 runtime 启动事件类型（派发事件语义仍为派发）。
      const trigger = h.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'runtime_start_reservations'")
        .all();
      expect(trigger).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('真实 v11 库（含既有 batch/run/task/预占账本行）升级 v12 保留数据，历史 v1..v11 不变', async () => {
    const sandbox = createTempSandbox('shiploop-p033-f007-v11-');
    openSandbox = sandbox;
    const dbPath = join(sandbox.path, 'state.db');
    const v11Migrations = SQLITE_MIGRATIONS.slice(0, 11);
    const seedSession = openSqliteStorageSession({ path: dbPath });
    let seeded: GraphSeed | undefined;
    try {
      await migrateSqliteStorage(seedSession, { migrations: v11Migrations });
      seeded = seedGraph(seedSession.database, { batchRuntimeStarts: 1 });
      // 既有 F-006 预占账本行（升级前后逐字节保留）。
      seedSession.database
        .prepare(
          'INSERT INTO task_attempt_reservations (id, created_at, project_id, revision, updated_at, batch_id, run_id, task_id, attempt_key, classification, classified_by, reason) ' +
            "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'code', 'core', NULL)",
        )
        .run(
          randomUUID(),
          NOW,
          seeded.projectId,
          NOW,
          seeded.batchId,
          seeded.runId,
          seeded.taskId,
          'attempt-1',
        );
    } finally {
      seedSession.close();
    }
    const graph = seeded!;

    // 同一库用全量迁移重开：v12 追加应用，既有数据保留。
    const session = openSqliteStorageSession({ path: dbPath });
    try {
      const result = await migrateSqliteStorage(session);
      expect(result.appliedVersions).toEqual([12, 13, 14, 15, 16, 17]);
      const batch = session.database
        .prepare('SELECT runtime_starts, attempts_created, budget_snapshot FROM execution_batches WHERE id = ?')
        .get(graph.batchId) as { runtime_starts: number; attempts_created: number; budget_snapshot: string };
      expect(batch.runtime_starts).toBe(1);
      expect(batch.attempts_created).toBe(0);
      expect(JSON.parse(batch.budget_snapshot)).toEqual(DEFAULT_BUDGET);
      const attemptsLedger = session.database
        .prepare('SELECT COUNT(*) AS n FROM task_attempt_reservations')
        .get() as { n: number };
      expect(attemptsLedger.n).toBe(1);
      const startsLedger = session.database
        .prepare('SELECT COUNT(*) AS n FROM runtime_start_reservations')
        .get() as { n: number };
      expect(startsLedger.n).toBe(0);

      // 升级后新边界可用：预占叠加在既有计数上（2/2 达到上限）。
      const access = createSqliteExecutionAccess(session, { nowUtcMs: () => NOW });
      const reserved = session.transactWrite('test.reserve', () =>
        access.reserveRuntimeStartInTransaction({
          projectId: graph.projectId,
          batchId: graph.batchId,
          runId: graph.runId,
          startKey: 'start-after-upgrade',
        }),
      );
      expect(reserved.startKey).toBe('start-after-upgrade');
      const after = session.database
        .prepare('SELECT runtime_starts FROM execution_batches WHERE id = ?')
        .get(graph.batchId) as { runtime_starts: number };
      expect(after.runtime_starts).toBe(2);
    } finally {
      session.close();
    }
    // 历史迁移不被改写：版本连续且 v12 为唯一新增追加。
    expect(SQLITE_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });

  it('DDL 底线：重复启动身份、空 start_key 与跨项目外键在 DDL 级拒绝', async () => {
    const h = await openHarness();
    try {
      h.reserve();
      const insert = h.db.prepare(
        'INSERT INTO runtime_start_reservations (id, created_at, project_id, revision, updated_at, batch_id, run_id, start_key) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
      );
      expect(() =>
        insert.run(randomUUID(), NOW, h.seed.projectId, NOW, h.seed.batchId, h.seed.runId, 'start-1'),
      ).toThrowError(/UNIQUE/);
      expect(() =>
        insert.run(randomUUID(), NOW, h.seed.projectId, NOW, h.seed.batchId, h.seed.runId, ''),
      ).toThrowError(/CHECK/);
      expect(() =>
        insert.run(randomUUID(), NOW, 'proj-2', NOW, h.seed.batchId, h.seed.runId, 'start-2'),
      ).toThrowError(/FOREIGN KEY/);
      expect(h.batchCounters().runtimeStarts).toBe(1);
      expect(h.reservationRows()).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 验收 1：受信启动边界（关联当前获准 Run，原子检查额度/时间/控制状态）
 * ------------------------------------------------------------------ */

describe('F-007 验收 1：受信启动边界调用与归属/控制状态校验', () => {
  it('预占一次只递增父 Batch runtime_starts 并落账本行，其他累计计数不变', async () => {
    const h = await openHarness();
    try {
      const before = h.batchCounters();
      const record = h.reserve();
      const after = h.batchCounters();
      expect(after.runtimeStarts).toBe(before.runtimeStarts + 1);
      expect(after.attemptsCreated).toBe(before.attemptsCreated);
      expect(after.runsCreated).toBe(before.runsCreated);
      expect(after.noProgressRuns).toBe(before.noProgressRuns);
      expect(after.revision).toBe(before.revision + 1);
      expect(record).toMatchObject({
        projectId: h.seed.projectId,
        batchId: h.seed.batchId,
        runId: h.seed.runId,
        startKey: 'start-1',
        revision: 1,
      });
      expect(record.createdAtUtcMs).toBe(NOW);
      expect(h.reservationRows()).toEqual([
        expect.objectContaining({
          project_id: h.seed.projectId,
          batch_id: h.seed.batchId,
          run_id: h.seed.runId,
          start_key: 'start-1',
        }),
      ]);
    } finally {
      h.close();
    }
  });

  it('预算原语只允许在现有写事务内调用，并接线至命令事务面', async () => {
    const h = await openHarness();
    try {
      expect(() => h.access.reserveRuntimeStartInTransaction(reserveInput(h.seed, 'start-1'))).toThrowError(
        /只允许在写事务内使用/,
      );
      expect(() => h.access.getRuntimeStartReservationInTransaction(h.seed.projectId, h.seed.runId, 'start-1')).toThrowError(
        /只允许在写事务内使用/,
      );
      const store = createSqliteAtomicCommandStore(h.session, { nowUtcMs: () => NOW });
      const record = store.transact('test.txReserve', (tx) =>
        tx.reserveRuntimeStart(reserveInput(h.seed, 'start-tx')),
      );
      const readBack = store.transact('test.txRead', (tx) =>
        tx.getRuntimeStartReservation(h.seed.projectId, h.seed.runId, 'start-tx'),
      );
      expect(readBack).toEqual(record);
      expect(h.batchCounters().runtimeStarts).toBe(1);
    } finally {
      h.close();
    }
  });

  it('归属校验：缺失/跨项目/Run 不属于声明 Batch 结构化拒绝且零写入', async () => {
    const h = await openHarness();
    try {
      const other = seedSecondProject(h.db);
      // 旧 Run 置终态后同 Feature 才允许新活动 Run（避开条件唯一索引）；
      // 归属负例均在控制状态检查之前拒绝，终态不影响断言结论。
      h.db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run('failed', NOW + 1, h.seed.runId);
      const runInOtherBatch = seedRunInOtherBatch(h.db, h.seed);
      const missingBatch = captureError(() =>
        h.reserve({ projectId: h.seed.projectId, batchId: randomUUID(), runId: h.seed.runId, startKey: 'start-x' }),
      );
      expect(missingBatch.kind).toBe('not_found');
      const missingRun = captureError(() =>
        h.reserve({ projectId: h.seed.projectId, batchId: h.seed.batchId, runId: randomUUID(), startKey: 'start-x' }),
      );
      expect(missingRun.kind).toBe('not_found');
      const crossProject = captureError(() =>
        h.reserve({ projectId: 'proj-2', batchId: h.seed.batchId, runId: h.seed.runId, startKey: 'start-x' }),
      );
      expect(crossProject.kind).toBe('ownership');
      const crossProjectRun = captureError(() =>
        h.reserve({ projectId: h.seed.projectId, batchId: other.batchId, runId: other.runId, startKey: 'start-x' }),
      );
      expect(crossProjectRun.kind).toBe('ownership');
      const runOutsideBatch = captureError(() =>
        h.reserve({ projectId: h.seed.projectId, batchId: h.seed.batchId, runId: runInOtherBatch, startKey: 'start-x' }),
      );
      expect(runOutsideBatch.kind).toBe('ownership');
      expect(h.batchCounters().runtimeStarts).toBe(0);
      expect(h.reservationRows()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('有效控制状态：终态 Batch/Run 拒绝新预占且零写入；活动集合内状态仍可预占', async () => {
    const terminalBatch = await openHarness({ batchStatus: 'cancelled' });
    try {
      const error = captureError(() => terminalBatch.reserve());
      expect(error.kind).toBe('conflict');
      expect(error.details).toMatchObject({ reason: 'batch_not_active', status: 'cancelled' });
      expect(terminalBatch.batchCounters().runtimeStarts).toBe(0);
    } finally {
      terminalBatch.close();
    }
    for (const runStatus of ['failed', 'cancelled', 'succeeded']) {
      const h = await openHarness({ runStatus });
      try {
        const error = captureError(() => h.reserve());
        expect(error.kind).toBe('conflict');
        expect(error.details).toMatchObject({ reason: 'run_not_active', status: runStatus });
        expect(h.batchCounters().runtimeStarts).toBe(0);
      } finally {
        h.close();
      }
    }
    // paused/interrupted 属活动集（不是可绕过的终态）：仍接受预占。
    for (const status of ['paused', 'interrupted', 'pausing', 'queued']) {
      const h = await openHarness({ runStatus: status });
      try {
        expect(h.reserve().startKey).toBe('start-1');
        expect(h.batchCounters().runtimeStarts).toBe(1);
      } finally {
        h.close();
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 验收 2：区分准备失败、启动失败和实际用量
 * ------------------------------------------------------------------ */

describe('F-007 验收 2：区分准备失败、启动失败和实际用量', () => {
  it('仅创建 Run/派发计数/Attempt 预占/事件追加不增加 runtimeStarts；准备前失败保留总 Attempt 但启动数为零', async () => {
    // 准备前失败现场：总 Attempt 已保留（Task 双计数与 Batch attempts_created>0），
    // 但从未经过启动边界——runtime_starts 必须为零。
    const h = await openHarness({ batchAttemptsCreated: 2, taskAttemptCounter: 2, taskCodeAttemptsUsed: 2 });
    try {
      const counters = h.batchCounters();
      expect(counters.attemptsCreated).toBe(2);
      expect(counters.runtimeStarts).toBe(0);
      const task = h.db
        .prepare('SELECT attempt_counter, code_attempts_used FROM tasks WHERE id = ?')
        .get(h.seed.taskId) as { attempt_counter: number; code_attempts_used: number };
      expect(task.attempt_counter).toBe(2);
      expect(task.code_attempts_used).toBe(2);

      // 创建路径（F-005/F-006 原语面）不触碰 runtime_starts：派发计数与 Attempt 预占。
      h.session.transactWrite('test.dispatch', () => {
        h.access.recordExecutionRunDispatchInTransaction(h.seed.projectId, h.seed.batchId);
      });
      h.session.transactWrite('test.attemptReserve', () => {
        h.access.reserveTaskAttemptInTransaction({
          projectId: h.seed.projectId,
          batchId: h.seed.batchId,
          runId: h.seed.runId,
          taskId: h.seed.taskId,
          attemptKey: 'attempt-3',
          maxAttemptsPerTask: null,
        });
      });
      h.session.transactWrite('test.event', () => {
        h.access.appendExecutionEventInTransaction({
          projectId: h.seed.projectId,
          eventType: 'execution.run.dispatched',
          aggregateType: 'run',
          aggregateId: h.seed.runId,
          aggregateRevision: 1,
          payload: { dispatched: true },
        });
      });
      const after = h.batchCounters();
      expect(after.runsCreated).toBe(counters.runsCreated + 1);
      expect(after.attemptsCreated).toBe(3);
      expect(after.runtimeStarts).toBe(0);
      expect(h.reservationRows()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('同一启动身份重放只计一次：同身份重放返回同一记录不重复计数（终态后仍幂等）', async () => {
    const h = await openHarness();
    try {
      const first = h.reserve();
      const replay = h.reserve();
      expect(replay.id).toBe(first.id);
      expect(replay.createdAtUtcMs).toBe(first.createdAtUtcMs);
      expect(h.batchCounters().runtimeStarts).toBe(1);
      expect(h.reservationRows()).toHaveLength(1);

      // Run 进入终态（启动失败现场）后重放同身份：仍幂等返回既有记录——
      // 计数上限与终态不撤销已有执行身份。
      h.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('failed', h.seed.runId);
      const replayAfterTerminal = h.reserve();
      expect(replayAfterTerminal.id).toBe(first.id);
      expect(h.batchCounters().runtimeStarts).toBe(1);
    } finally {
      h.close();
    }
  });

  it('跨 Run/过期身份拒绝：同一启动身份绑定其他 Run 时 conflict，不产生新计数', async () => {
    const h = await openHarness();
    try {
      h.reserve();
      // 真实重试形态：旧 Run 置终态后同 Feature 才允许新活动 Run（避开条件唯一索引）。
      h.db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run('failed', NOW + 1, h.seed.runId);
      const secondRun = seedSecondRun(h.db, h.seed, 2);
      const error = captureError(() =>
        h.reserve({ projectId: h.seed.projectId, batchId: h.seed.batchId, runId: secondRun, startKey: 'start-1' }),
      );
      expect(error.kind).toBe('conflict');
      expect(error.details).toMatchObject({ reason: 'start_key_reused' });
      expect(h.batchCounters().runtimeStarts).toBe(1);
      expect(h.reservationRows()).toHaveLength(1);
      expect((h.reservationRows()[0] as { run_id: string }).run_id).toBe(h.seed.runId);
    } finally {
      h.close();
    }
  });

  it('通过本边界预占后启动失败保守保留一次启动计数：无退额原语、不伪造用量或已启动事实', async () => {
    const sandbox = createTempSandbox('shiploop-p033-f007-failure-');
    openSandbox = sandbox;
    const dbPath = join(sandbox.path, 'state.db');
    const session = openSqliteStorageSession({ path: dbPath });
    let graph: GraphSeed;
    try {
      await migrateSqliteStorage(session);
      graph = seedGraph(session.database);
      const access = createSqliteExecutionAccess(session, { nowUtcMs: () => NOW });
      session.transactWrite('test.reserve', () => {
        access.reserveRuntimeStartInTransaction(reserveInput(graph, 'start-1'));
      });
      // 启动失败现场：Run 置终态、会话关闭重开——计数保守保留。
      session.database.prepare('UPDATE runs SET status = ? WHERE id = ?').run('failed', graph.runId);
      session.close();
    } finally {
      session.close();
    }
    const reopened = openSqliteStorageSession({ path: dbPath });
    try {
      await migrateSqliteStorage(reopened);
      const access = createSqliteExecutionAccess(reopened, { nowUtcMs: () => NOW });
      const counters = reopened.database
        .prepare('SELECT runtime_starts FROM execution_batches WHERE id = ?')
        .get(graph!.batchId) as { runtime_starts: number };
      expect(counters.runtime_starts).toBe(1);
      // 无退额路径：重放身份只返回既有事实，不减少计数。
      const replay = reopened.transactWrite('test.replayAfterFailure', () =>
        access.reserveRuntimeStartInTransaction(reserveInput(graph!, 'start-1')),
      );
      expect(replay.startKey).toBe('start-1');
      expect(
        (reopened.database
          .prepare('SELECT runtime_starts FROM execution_batches WHERE id = ?')
          .get(graph!.batchId) as { runtime_starts: number }).runtime_starts,
      ).toBe(1);
      // 账本行无用量/已启动字段：预占不伪造 token/cost 或 SDK 已启动事实。
      const row = reopened.database
        .prepare('SELECT * FROM runtime_start_reservations')
        .get() as Record<string, unknown>;
      expect(Object.keys(row).sort()).toEqual([
        'batch_id',
        'created_at',
        'id',
        'project_id',
        'revision',
        'run_id',
        'start_key',
        'updated_at',
      ]);
    } finally {
      reopened.close();
    }
    // 命令事务面没有任何退额原语（启动失败不盲目退还）。
    const keysSession = openSqliteStorageSession({ path: join(sandbox.path, 'keys.db') });
    try {
      const store = createSqliteAtomicCommandStore(keysSession);
      const txKeys = store.transact('test.keys', (tx) => Object.keys(tx).sort());
      // 无任何 Runtime 启动退额原语（releaseBaselineOccupancy 是基线占用面，与此无关）。
      expect(txKeys.filter((key) => /runtime/i.test(key))).toEqual([
        'getRuntimeStartReservation',
        'reserveRuntimeStart',
      ]);
    } finally {
      keysSession.close();
    }
  });

  it('输入校验负例（零 SQL）：用量/已启动/结果字段是未知键，startKey 空/超长拒绝', async () => {
    const h = await openHarness();
    try {
      for (const [field, extra] of [
        ['tokenUsed', { tokenUsed: 1 }],
        ['costUsed', { costUsed: 0.5 }],
        ['sdkStarted', { sdkStarted: true }],
        ['outcome', { outcome: 'failed' }],
        ['runner', { runner: 'pi' }],
        ['classification', { classification: 'code' }],
      ] as const) {
        const error = captureError(() => h.reserve(reserveInput(h.seed, 'start-1', extra)));
        expect(error.kind).toBe('validation');
        expect(error.message).toContain(`包含未知字段 ${field}`);
      }
      for (const startKey of ['', '   ', 'x'.repeat(129)]) {
        const error = captureError(() => h.reserve(reserveInput(h.seed, startKey)));
        expect(error.kind).toBe('validation');
      }
      expect(h.batchCounters().runtimeStarts).toBe(0);
      expect(h.reservationRows()).toEqual([]);
    } finally {
      h.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 验收 3：启动额度与 deadline（budget_exhausted 判定）
 * ------------------------------------------------------------------ */

describe('F-007 验收 3：budget_exhausted 判定与竞争预占', () => {
  it('maxRuntimeStarts：used==limit-1 放行、used==limit 恰好拒绝且计数不溢出', async () => {
    // 默认上限 2：已用 1（恰余一次）。
    const h = await openHarness({ batchRuntimeStarts: 1 });
    try {
      expect(h.reserve().startKey).toBe('start-1');
      expect(h.batchCounters().runtimeStarts).toBe(2);
      const error = captureError(() => h.reserve(reserveInput(h.seed, 'start-2')));
      expectBudgetExhausted(error, [{ layer: 'batch', dimension: 'maxRuntimeStarts' }]);
      const reason = ((error.details as { reasons: { limit: number; used: number }[] }).reasons)[0]!;
      expect(reason.limit).toBe(2);
      expect(reason.used).toBe(2);
      expect(h.batchCounters().runtimeStarts).toBe(2);
      expect(h.reservationRows()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('deadline：now == deadline 恰好拒绝（受控停止原因）、now == deadline-1 放行；不清占用、不假称进程停止', async () => {
    const budget = {
      ...DEFAULT_BUDGET,
      batch: { ...DEFAULT_BUDGET.batch, maxRuntimeStarts: 5, deadlineUtcMs: NOW + 1_000 },
    };
    const h = await openHarness({ budget });
    try {
      h.reserve();
      h.setClock(NOW + 999);
      expect(h.reserve(reserveInput(h.seed, 'start-2')).startKey).toBe('start-2');
      h.setClock(NOW + 1_000);
      const error = captureError(() => h.reserve(reserveInput(h.seed, 'start-3')));
      expectBudgetExhausted(error, [{ layer: 'batch', dimension: 'deadlineUtcMs' }]);
      const reason = ((error.details as { reasons: { limit: number; used: number }[] }).reasons)[0]!;
      expect(reason.limit).toBe(NOW + 1_000);
      expect(reason.used).toBe(NOW + 1_000);
      // deadline 拒绝不清空占用：既有计数与账本行保留，Run 状态未被假改为已停止。
      expect(h.batchCounters().runtimeStarts).toBe(2);
      expect(h.reservationRows()).toHaveLength(2);
      const runStatus = h.db.prepare('SELECT status FROM runs WHERE id = ?').get(h.seed.runId) as { status: string };
      expect(runStatus.status).toBe('running');
    } finally {
      h.close();
    }
  });

  it('竞争预占（真实 SQLite）：maxRuntimeStarts=1 时两个身份竞争，先到先得且计数不溢出', async () => {
    const budget = {
      ...DEFAULT_BUDGET,
      batch: { ...DEFAULT_BUDGET.batch, maxRuntimeStarts: 1 },
    };
    const h = await openHarness({ budget });
    try {
      // 两个写事务顺序竞争最后一个名额（BEGIN IMMEDIATE 串行化写者）。
      const winner = h.reserve(reserveInput(h.seed, 'competitor-a'));
      expect(winner.startKey).toBe('competitor-a');
      const loser = captureError(() => h.reserve(reserveInput(h.seed, 'competitor-b')));
      expectBudgetExhausted(loser, [{ layer: 'batch', dimension: 'maxRuntimeStarts' }]);
      expect(h.batchCounters().runtimeStarts).toBe(1);
      expect(h.reservationRows().map((row) => row.start_key)).toEqual(['competitor-a']);
      // 竞争失败者不占用身份：耗尽后重放胜者身份仍幂等（不撤销已有执行身份）。
      const replay = h.reserve(reserveInput(h.seed, 'competitor-a'));
      expect(replay.startKey).toBe('competitor-a');
      expect(h.batchCounters().runtimeStarts).toBe(1);
    } finally {
      h.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 验收 4：回滚与重开一致性（真实 SQLite）
 * ------------------------------------------------------------------ */

describe('F-007 验收 4：回滚与重开一致性', () => {
  it('同事务组合写入故障整组回滚：runtime_starts 与账本行都不落库', async () => {
    const h = await openHarness();
    try {
      expect(() =>
        h.session.transactWrite('test.rollbackGroup', () => {
          h.access.reserveRuntimeStartInTransaction(reserveInput(h.seed, 'start-1'));
          h.access.reserveRuntimeStartInTransaction(reserveInput(h.seed, 'start-2'));
          throw new Error('组合事务后续写入失败');
        }),
      ).toThrowError('组合事务后续写入失败');
      expect(h.batchCounters().runtimeStarts).toBe(0);
      expect(h.reservationRows()).toEqual([]);
      // 回滚后同身份可重新预占（无半提交残留）。
      expect(h.reserve(reserveInput(h.seed, 'start-1')).startKey).toBe('start-1');
      expect(h.batchCounters().runtimeStarts).toBe(1);
    } finally {
      h.close();
    }
  });

  it('数据库关闭重开：计数、账本、幂等重放与历史输入快照一致', async () => {
    const sandbox = createTempSandbox('shiploop-p033-f007-reopen-');
    openSandbox = sandbox;
    const dbPath = join(sandbox.path, 'state.db');
    const session = openSqliteStorageSession({ path: dbPath });
    let graph: GraphSeed;
    let before: { runtime_starts: number; budget_snapshot: string; scope_snapshot: string };
    try {
      await migrateSqliteStorage(session);
      graph = seedGraph(session.database);
      const access = createSqliteExecutionAccess(session, { nowUtcMs: () => NOW });
      session.transactWrite('test.first', () => {
        access.reserveRuntimeStartInTransaction(reserveInput(graph, 'start-1'));
      });
      before = session.database
        .prepare('SELECT runtime_starts, budget_snapshot, scope_snapshot FROM execution_batches WHERE id = ?')
        .get(graph.batchId) as { runtime_starts: number; budget_snapshot: string; scope_snapshot: string };
    } finally {
      session.close();
    }
    // 重开（全新会话；迁移幂等不重复应用）。
    const second = openSqliteStorageSession({ path: dbPath });
    try {
      const result = await migrateSqliteStorage(second);
      expect(result.appliedVersions).toEqual([]);
      const after = second.database
        .prepare('SELECT runtime_starts, budget_snapshot, scope_snapshot FROM execution_batches WHERE id = ?')
        .get(graph!.batchId) as { runtime_starts: number; budget_snapshot: string; scope_snapshot: string };
      expect(after.runtime_starts).toBe(1);
      expect(after.budget_snapshot).toBe(before!.budget_snapshot);
      expect(after.scope_snapshot).toBe(before!.scope_snapshot);
      const access = createSqliteExecutionAccess(second, { nowUtcMs: () => NOW });
      const replay = second.transactWrite('test.replayReopened', () =>
        access.reserveRuntimeStartInTransaction(reserveInput(graph!, 'start-1')),
      );
      expect(replay.startKey).toBe('start-1');
      expect(
        (second.database
          .prepare('SELECT runtime_starts FROM execution_batches WHERE id = ?')
          .get(graph!.batchId) as { runtime_starts: number }).runtime_starts,
      ).toBe(1);
      const fetched = second.transactWrite('test.get', () =>
        access.getRuntimeStartReservationInTransaction(graph!.projectId, graph!.runId, 'start-1'),
      );
      expect(fetched).toEqual(replay);
      expect(
        second.transactWrite('test.getMissing', () =>
          access.getRuntimeStartReservationInTransaction(graph!.projectId, graph!.runId, 'missing')),
      ).toBeNull();
    } finally {
      second.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 验收 5：命令面边界（无自报入口）
 * ------------------------------------------------------------------ */

describe('F-007 验收 5：命令面边界', () => {
  it('客户端或模型不能自报：命令/能力面无 runtime start/reserve 操作', () => {
    expect(COMMAND_OPERATIONS.filter((operation) => /runtime.?start|reserve/i.test(operation))).toEqual([]);
    expect(APP_CAPABILITIES.filter((capability) => /runtime.?start|reserve/i.test(capability))).toEqual([]);
    // 预占输入不含用量/结果字段（验收 2 输入负例已断言），账本无用量列（迁移用例已断言）。
  });
});
