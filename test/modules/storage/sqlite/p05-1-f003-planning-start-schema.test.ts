/**
 * P05-1 / F-003 迁移 v36：planning.start 接受回执（receipt v7）持久列。
 *
 * 覆盖：
 * - v36 只重建 command_receipts（追加 planning_task_id/candidate_id 列、v7 关联
 *   CHECK 与 planning_contexts 复合外键），v1–v35 SQL/checksum 冻结不变；
 * - 空库直接迁移到 v36；v35 旧库（含既有 v5/v6 回执行）升级到 v36 后逐行保留、
 *   规划列为 NULL；
 * - 真实 SQLite 负例（直接 SQL 命中 DDL 约束）：v7 缺任一规划列、operation 非
 *   planning.start、operationId ≠ batchId、v5/v6 携带规划列、候选外键指向不
 *   存在的 planning_contexts 行——每项失败后行数不变。
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW_MS = 1_700_600_000_000;
const HASH = 'ab'.repeat(32);
/** v35 及之前迁移校验摘要的冻结聚合摘要（P05-1 / F-003 开工时计算，不因 v36 重算）。 */
const FROZEN_V35_CHECKSUM_HASH = '69d1aa9a8e04b9039924b821fa87606da280a1e33ed44b0ac5b6ecc2bdb91c28';

function hashOfChecksums(migrations: readonly { checksum: string }[]): string {
  return createHash('sha256').update(migrations.map((m) => m.checksum).join('\n')).digest('hex');
}

interface Fixture {
  readonly session: SqliteStorageSession;
  readonly projectId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
  readonly db: SqliteStorageSession['database'];
  /** 直接 SQL 写一条 v7 形态回执（可覆盖字段）。 */
  insertV7Receipt(overrides?: Record<string, unknown>): void;
  cleanup(): void;
}

/** 建立最小结构（项目/Phase/Feature/Batch/Run/planning Task/规划上下文）。 */
async function openFixture(fromV35 = false): Promise<Fixture> {
  const sandbox = createTempSandbox('shiploop-p05-1-f003-schema-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  try {
    await migrateSqliteStorage(session, {
      migrations: SQLITE_MIGRATIONS.slice(0, fromV35 ? 35 : 36),
      nowUtcMs: () => NOW_MS,
    });
  } catch (error) {
    session.close();
    sandbox.cleanup();
    throw error;
  }
  const db = session.database;
  const projectId = 'proj-p051-f3';
  const phaseId = 'phase-p051-f3';
  const featureId = 'feat-p051-f3';
  const batchId = 'batch-p051-f3';
  const runId = 'run-p051-plan-f3';
  const planningTaskId = 'task-p051-plan-f3';
  const candidateId = 'cand-p051-f3';

  db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status) VALUES (?, ?, 1, ?, ?, 'active')")
    .run(projectId, NOW_MS, NOW_MS, '项目 F-003');
  db.prepare('INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, ?, ?, ?, ?)')
    .run(phaseId, NOW_MS, projectId, NOW_MS, '阶段 F-003');
  db.prepare('INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, source_refs) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(featureId, NOW_MS, projectId, NOW_MS, phaseId, 'Feature F-003', '[]');
  db.prepare(
    "INSERT INTO execution_batches (id, created_at, project_id, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, deadline_at, runs_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, 1)",
  ).run(batchId, NOW_MS, projectId, NOW_MS, phaseId, featureId,
    JSON.stringify({ schemaVersion: 1, featureIds: [featureId] }),
    JSON.stringify({ schemaVersion: 1 }),
    JSON.stringify({ schemaVersion: 1, batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1, deadlineUtcMs: NOW_MS + 1000 }, run: { maxAttemptsPerRun: 1, runTimeLimitMs: 1000 } }),
    NOW_MS + 1000);
  db.prepare(
    "INSERT INTO tasks (id, created_at, project_id, updated_at, feature_id, title, acceptance, execution_config, config_source, config_source_key, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'project_default', 'purposeStrategies.planner', 'planning')",
  ).run(planningTaskId, NOW_MS, projectId, NOW_MS, featureId, '规划任务 F-003',
    JSON.stringify({ criteria: ['候选可审批'] }),
    JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }));
  db.prepare(
    "INSERT INTO runs (id, created_at, project_id, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, run_time_limit_ms) VALUES (?, ?, ?, ?, ?, ?, 'plan', ?, ?, 'queued', ?, ?, 1, 1, 3600000)",
  ).run(runId, NOW_MS, projectId, NOW_MS, batchId, featureId,
    JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 1 }), HASH, `work-${runId}`);
  db.prepare(
    "INSERT INTO planning_contexts (id, created_at, project_id, updated_at, phase_id, feature_id, run_id, planning_task_id, candidate_id, input_digest, target_revision, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open')",
  ).run(randomUUID(), NOW_MS, projectId, NOW_MS, phaseId, featureId, runId, planningTaskId, candidateId, HASH);

  const insertV7Receipt = (overrides: Record<string, unknown> = {}): void => {
    const row = {
      id: randomUUID(),
      created_at: NOW_MS,
      revision: 1,
      updated_at: NOW_MS,
      principal_id: 'local-owner',
      command_id: randomUUID(),
      scope_kind: 'project',
      project_id: projectId,
      operation: 'planning.start',
      request_digest: HASH,
      status: 'accepted',
      operation_id: batchId,
      receipt_version: 7,
      batch_id: batchId,
      run_id: runId,
      planning_task_id: planningTaskId,
      candidate_id: candidateId,
      result_json: null,
      result_ref: null,
      error_code: null,
      error_message: null,
      error_details: null,
      issued_at: NOW_MS,
      completed_at: NOW_MS,
      ...overrides,
    };
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO command_receipts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ).run(...keys.map((key) => (row as Record<string, unknown>)[key]));
  };

  return {
    session, db, projectId, featureId, batchId, runId, planningTaskId, candidateId,
    insertV7Receipt,
    cleanup() { session.close(); sandbox.cleanup(); },
  };
}

function expectConstraintRejected(attempt: () => unknown): void {
  let caught: unknown;
  try {
    attempt();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const code = (caught as { code?: unknown }).code;
  expect(typeof code === 'string' && (code as string).startsWith('SQLITE_CONSTRAINT')).toBe(true);
}

describe('P05-1 / F-003 迁移 v36：planning.start 接受回执持久列', () => {
  it('[case:v36-append-only-frozen-prior-checksums] v36 只追加，v1–v35 checksum 冻结不变', () => {
    expect(SQLITE_MIGRATIONS.slice(0, 36)).toHaveLength(36);
    expect(SQLITE_MIGRATIONS[35]?.version).toBe(36);
    expect(hashOfChecksums(SQLITE_MIGRATIONS.slice(0, 35))).toBe(FROZEN_V35_CHECKSUM_HASH);
    const v36 = SQLITE_MIGRATIONS[35]!;
    expect(v36.checksum).toBe(createHash('sha256').update(v36.sql).digest('hex'));
    // 不触碰派发/预算/规划上下文表，只重建 command_receipts。
    const touched = new Set(
      [...v36.sql.matchAll(/(?:CREATE TABLE|DROP TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX|CREATE TRIGGER)\s+(?:IF NOT EXISTS\s+)?([a-z_0-9]+)/gi)].map((m) => m[1]),
    );
    expect([...touched].every((name) => name.startsWith('command_receipts'))).toBe(true);
  });

  it('[case:v36-fresh-and-upgrade] 空库直达 v36；v35 旧库升级保留既有回执行且规划列为 NULL', async () => {
    const fresh = await openFixture(false);
    try {
      expect(fresh.db.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 36 });
      expect(fresh.db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toEqual({ n: 0 });
      const columns = fresh.db.prepare("SELECT name FROM pragma_table_info('command_receipts') WHERE name IN ('planning_task_id', 'candidate_id')").all() as { name: string }[];
      expect(columns.map((c) => c.name).sort()).toEqual(['candidate_id', 'planning_task_id']);
    } finally { fresh.cleanup(); }

    const legacy = await openFixture(true);
    try {
      // v35 旧库写入一条既有 v5 completed 回执（planning 列尚不存在）。
      legacy.db.prepare(
        "INSERT INTO command_receipts (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, receipt_version, result_json, result_ref, issued_at, completed_at) VALUES (?, ?, 1, ?, 'local-owner', ?, 'project', ?, 'phase.create', ?, 'completed', 5, '{}', ?, ?, ?)",
      ).run(randomUUID(), NOW_MS, NOW_MS, randomUUID(), legacy.projectId, HASH, `v1.${'a'.repeat(43)}`, NOW_MS, NOW_MS);
      await migrateSqliteStorage(legacy.session, { migrations: SQLITE_MIGRATIONS.slice(0, 36), nowUtcMs: () => NOW_MS });
      expect(legacy.db.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 36 });
      const rows = legacy.db.prepare('SELECT planning_task_id, candidate_id, receipt_version, result_json FROM command_receipts').all() as { planning_task_id: string | null; candidate_id: string | null; receipt_version: number; result_json: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ planning_task_id: null, candidate_id: null, receipt_version: 5, result_json: '{}' });
    } finally { legacy.cleanup(); }
  });

  it('[case:receipt-v7-shape-checks] v7 关联 CHECK：缺规划列/错误 operation/operationId 漂移一律拒绝', async () => {
    const fixture = await openFixture(false);
    try {
      const count = () => (fixture.db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }).n;
      const base = count();
      expectConstraintRejected(() => fixture.insertV7Receipt({ candidate_id: null }));
      expectConstraintRejected(() => fixture.insertV7Receipt({ planning_task_id: null }));
      expectConstraintRejected(() => fixture.insertV7Receipt({ operation: 'execution.start' }));
      expectConstraintRejected(() => fixture.insertV7Receipt({ operation_id: randomUUID() }));
      expectConstraintRejected(() => fixture.insertV7Receipt({ status: 'completed', result_json: '{}', result_ref: `v1.${'b'.repeat(43)}` }));
      expect(count()).toBe(base);
      // v5 携带规划列同样被关联 CHECK 拒绝。
      expectConstraintRejected(() => fixture.insertV7Receipt({ receipt_version: 5, operation: 'phase.create', batch_id: null, run_id: null, operation_id: null }));
      fixture.insertV7Receipt();
      expect(count()).toBe(base + 1);
    } finally { fixture.cleanup(); }
  });

  it('[case:receipt-v7-planning-fk] 候选外键指向不存在的 planning_contexts 行被拒绝', async () => {
    const fixture = await openFixture(false);
    try {
      expectConstraintRejected(() => fixture.insertV7Receipt({ candidate_id: 'cand-not-exist' }));
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toEqual({ n: 0 });
    } finally { fixture.cleanup(); }
  });
});
