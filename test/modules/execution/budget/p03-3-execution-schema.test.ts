/**
 * P03-3 / F-002 单 Feature ExecutionBatch、Run 与预算修订记录迁移 + Drizzle Schema 回归
 * （真实临时 SQLite，非 mock）。
 *
 * 覆盖（F-002 验收点，全部为真实断言）：
 * - 迁移接续：从真实前序最新迁移（v8）继续追加 v9；历史 v1–v8 SQL/checksum 与开工冻结
 *   摘要一致；真实空库、带真实 P02 v5 数据（项目/配置/Artifact/回执/事件/基线行）的库、
 *   前序最新 v8 库（计划结构 + 审批数据）均可升级且既有数据逐字段保留；v9 失败整组
 *   回滚保持一致 v8，修复后可继续；高版本/checksum 漂移拒写继续有效；
 * - Batch/Run 形态：Batch 保存恰一个 Feature 的不可变范围（feature_id + scope_snapshot
 *   单成员数组）、输入配置依据（config_snapshot）、有限初始预算（budget_snapshot +
 *   budget_revision + deadline_at）与累计计数；Run 引用同项目 Batch 与 Feature 并保存
 *   purpose、workKey、dispatchOrdinal、输入快照、Run 上限（maxAttemptsPerRun/
 *   runTimeLimitMs）与时间依据（started_at/ended_at）；
 * - 真实 SQLite 负例（直接 SQL 命中 DDL 约束，不用 TypeScript 校验模拟数据库约束）：
 *   缺失父 Batch、跨项目引用、跨 Feature 范围引用、Batch phase 与 Feature 归属不一致、
 *   负计数、非法状态、非法 JSON/单成员范围、重复派发身份与重复修订身份均被拒绝且行数
 *   不变；同 Feature 恰一个有效活动 Run、同 Phase 恰一个有效活动 Batch——paused 与
 *   interrupted（归属待核对）计入活动集合，不被当成可绕过的终态，终态（succeeded/
 *   failed/cancelled）不参与活动唯一；
 * - 不可变内容校验（触发器 + 失败用例，设计 11 §10）：Batch 范围/配置快照与身份列、
 *   Run 输入/配置快照与派发身份、Run 时间依据（started_at 设定后不可改）均不可 UPDATE
 *   覆盖；batch_budget_revisions 行 UPDATE/DELETE 一律拒绝——初始与历史预算快照不可被
 *   当前预算更新覆盖（当前预算在 Batch 行上正常演进，历史版本逐行留存）；
 * - 范围边界：仅建立本项三表；不提前建设完整 Attempt、Session、Worktree（workspace_
 *   leases）或通知表，也不建计划/配置业务版本表。
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../../../../packages/core/src/ports/errors.ts';
import type { SettingsPayload } from '../../../../packages/core/src/ports/settings-schema.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage as migrateDeclaredSqliteStorage, SqliteMigrationError } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW_MS = 1_700_800_000_000;
const VALID_SHA256 = 'ab'.repeat(32);
/** 形态合法但不存在的稳定 ID（走外键失败而非格式校验路径）。 */
const MISSING_ID = 'missing-parent-0f8';
const V9_MIGRATIONS = SQLITE_MIGRATIONS.slice(0, 9);

// Historical F-002 contract: later migrations must not change this suite's target.
function migrateSqliteStorage(session: SqliteStorageSession,
  options: Parameters<typeof migrateDeclaredSqliteStorage>[1] = {}) {
  return migrateDeclaredSqliteStorage(session, { migrations: V9_MIGRATIONS, ...options });
}

/** F-002 Payload Schema 的最小合法配置（真实 P02 v5 库种子）。 */
const PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
  },
};

/**
 * 历史 v1–v8 迁移 SQL 的冻结 SHA-256（P03-3 / F-002 开工时计算）。
 * F-002 只允许追加 v9；任何对 v1–v8 内容的改动都会使本断言失败。
 */
const FROZEN_V1_TO_V8_CHECKSUMS: Readonly<Record<number, string>> = {
  1: 'd5c70af3fe49fc43eba42d92e65d1bb4f305360671942d76e3c5805369723aba',
  2: 'bd8a2aa9c77c53f4bc56bf38ce9077f3068d6c9d47ee905f774530e66f3bdcb5',
  3: 'd49e96aaa8d84d9d6c44e16a99e617b8d8b67fbbb801e3b9724827c7ec629d79',
  4: '12df77d50cacf7e12c88ed453897f8f988760b6860d13dddfb8e8f9a26e3a059',
  5: 'bbb3dd79d4944b7fd0b4cd87ba0aa475aba0932a68b74acf50e7b9f446fba8b3',
  6: '151afe9ef426abee7c58e8ccdc11ccb642da8ed3b253843253c18e2ab4bdd3d1',
  7: 'b17ba543d93a7c695e8db92b77fc264913ec33f8d7711324e880879d8d45b050',
  8: '5b6d7730e0f2afe39f00009bae8a026ea556abd3a222bae6208c2809f7f131cc',
};

/** v9 建立的本项必需三表（单 Feature 执行域最小集）。 */
const V9_TABLES = ['execution_batches', 'runs', 'batch_budget_revisions'] as const;

/** 仍不得提前建立的后续表（完整 Attempt/Session/Worktree/通知/业务版本表）。 */
const V9_FORBIDDEN_TABLES = [
  'attempts',
  'workspace_leases',
  'sessions',
  'chat_turns',
  'session_messages',
  'recording_manifests',
  'notification_channels',
  'notification_deliveries',
  'verification_batches',
  'check_definitions',
  'check_results',
  'operations',
  'feature_dependencies',
  'configuration_revisions',
  'plan_revisions',
  'plan_versions',
] as const;

/** 有效活动状态集合（设计 11 §10 条件唯一；paused/interrupted 不是可绕过的终态）。 */
const ACTIVE_STATUSES = ['queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted'] as const;
/** 不可重开的历史终态（设计 02 §3）。 */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

type CoreDatabase = SqliteStorageSession['database'];

function listUserTables(db: CoreDatabase): string[] {
  return (
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

/** v9 之前的全部业务表行快照（升级前后逐字段比对）。 */
const PRE_V9_SNAPSHOT_TABLES = [
  'projects',
  'repository_bindings',
  'global_settings',
  'project_settings',
  'artifacts',
  'command_receipts',
  'state_events',
  'baseline_authorizations',
  'baseline_operations',
  'baseline_check_results',
  'baseline_occupancy',
  'phases',
  'features',
  'tasks',
  'task_dependencies',
  'approvals',
] as const;

function snapshotTables(db: CoreDatabase): Record<string, unknown[]> {
  const existing = new Set(listUserTables(db));
  const snapshot: Record<string, unknown[]> = {};
  for (const table of PRE_V9_SNAPSHOT_TABLES) {
    if (existing.has(table)) {
      snapshot[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
  }
  return snapshot;
}

/** 断言升级前快照的每张表逐字段保留（升级新增表不在快照内，另行断言）。 */
function expectTablesPreserved(after: Record<string, unknown[]>, before: Record<string, unknown[]>): void {
  for (const [table, rows] of Object.entries(before)) {
    expect(after[table], `${table} 既有行必须逐字段保留`).toEqual(rows);
  }
}

/** 在真实临时库上打开会话（不迁移；由调用方决定迁移版本）。 */
function openSession(
  dbPath: string,
  startMs = NOW_MS,
): { session: SqliteStorageSession; tick: () => number } {
  let tick = startMs;
  const session = openSqliteStorageSession({ path: dbPath });
  return {
    session,
    tick: () => {
      const value = tick;
      tick += 1_000;
      return value;
    },
  };
}

/** 经真实端口建立 P02 v5 既有数据（项目/绑定/配置/元数据事件 + Artifact/回执/基线行）。 */
async function seedP02V5DataAsync(
  session: SqliteStorageSession,
  tick: () => number,
): Promise<{ projectId: string }> {
  const state = createSqliteStateStore(session, { nowUtcMs: tick });
  const project = await state.createProjectWithRepositoryBinding(
    { displayName: 'P02 项目', labels: ['p02'] },
    { canonicalPath: `/tmp/shiploop-f002-v5-${randomUUID()}/repo-a`, repoIdentity: 'repo-identity-a' },
  );
  await state.createGlobalSettings({ payload: PAYLOAD });
  await state.createProjectSettings(project.project.id, { payload: PAYLOAD });
  await state.updateProject(project.project.id, { expectedRevision: 1, description: '升级前说明' });
  const db = session.database;
  // Artifact 与命令回执按 v5 DDL 真实落行。
  db.prepare(
    'INSERT INTO artifacts (id, created_at, revision, updated_at, project_id, kind, status, media_type, ' +
      'expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('art-p033-1', NOW_MS, NOW_MS, project.project.id, 'requirements', 'ready', 'application/json', VALID_SHA256, VALID_SHA256, 42, 'projects/x/artifacts/art-p033-1');
  // P02-3 基线作用域行（v4/v5 真实数据）。
  db.prepare(
    'INSERT INTO baseline_authorizations (id, created_at, project_id, repository_binding_id, head_commit, ' +
      'working_tree_digest, has_uncommitted_changes, policy_revision, plan_digest, plan_json, authorized_by, authorized_at) ' +
      'VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?)',
  ).run('auth-p033-1', NOW_MS, project.project.id, project.binding.id, VALID_SHA256, VALID_SHA256, VALID_SHA256, JSON.stringify({ checks: [] }), 'local-owner', NOW_MS);
  db.prepare(
    'INSERT INTO baseline_operations (id, created_at, updated_at, revision, project_id, kind, authorization_id, status, started_at, ended_at) ' +
      "VALUES (?, ?, ?, 1, ?, 'baseline', ?, 'completed', ?, ?)",
  ).run('op-p033-1', NOW_MS, NOW_MS, project.project.id, 'auth-p033-1', NOW_MS, NOW_MS);
  db.prepare(
    'INSERT INTO baseline_check_results (id, created_at, updated_at, revision, project_id, operation_id, check_key, ' +
      'argv_json, cwd_ref, environment_ref, timeout_ms, required, status, timed_out, started_at, ended_at) ' +
      "VALUES (?, ?, ?, 1, ?, ?, 'unit-tests', ?, 'packages/core', 'minimal', 600000, 1, 'passed', 0, ?, ?)",
  ).run('check-p033-1', NOW_MS, NOW_MS, project.project.id, 'op-p033-1', JSON.stringify(['node', '--test']), NOW_MS, NOW_MS);
  db.prepare(
    'INSERT INTO baseline_occupancy (id, holder_operation_id, acquired_at, heartbeat_at, process_identity) ' +
      'VALUES (?, NULL, NULL, NULL, NULL)',
  ).run('global');
  // completed 与 accepted（v5）回执各一条。
  db.prepare(
    'INSERT INTO command_receipts (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, ' +
      'project_id, operation, request_digest, status, operation_id, result_json, result_ref, issued_at, completed_at) ' +
      'VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
  ).run('receipt-p033-1', NOW_MS, NOW_MS, 'local-owner', 'cmd-p033-1', 'project', project.project.id, 'project.register', VALID_SHA256, 'completed', '{"ok":true}', 'ref-p033-1', NOW_MS, NOW_MS);
  db.prepare(
    'INSERT INTO command_receipts (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, ' +
      'project_id, operation, request_digest, status, operation_id, result_json, result_ref, issued_at, completed_at) ' +
      "VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, NULL, NULL, ?, ?)",
  ).run('receipt-p033-2', NOW_MS, NOW_MS, 'local-owner', 'cmd-p033-2', 'project', project.project.id, 'baseline.execute', VALID_SHA256, 'op-p033-1', NOW_MS, NOW_MS);
  return { projectId: project.project.id };
}

/** 历史 v9 夹具仅使用当时的列，不依赖要求最新 schema 的生产适配器。 */
function seedPlanStructure(
  session: SqliteStorageSession,
  projectId: string,
  title = 'P03 执行阶段',
  idPrefix = 't',
): { phaseId: string; featureId: string } {
  return session.transactWrite('test.seed.execution.structure.v9', (db) => {
    const phaseId = randomUUID();
    const featureId = randomUUID();
    db.prepare('INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, ?, ?, ?, ?)')
      .run(phaseId, NOW_MS, projectId, NOW_MS, title);
    db.prepare('INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, plan_digest, source_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(featureId, NOW_MS, projectId, NOW_MS, phaseId, 'Feature 执行', VALID_SHA256, JSON.stringify([{ artifactId: 'art-p033-1' }]));
    for (const suffix of ['a', 'b', 'c']) {
      db.prepare('INSERT INTO tasks (id, created_at, project_id, updated_at, feature_id, title, acceptance, complexity, execution_config, config_source, config_source_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`${idPrefix}-${suffix}`, NOW_MS, projectId, NOW_MS, featureId, `任务 ${idPrefix}-${suffix}`,
          JSON.stringify({ criteria: ['验收一'] }), 'low', JSON.stringify({
          schemaVersion: 2,
          strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
          }), 'project_default', 'defaultStrategy');
    }
    db.prepare('INSERT INTO task_dependencies (id, created_at, updated_at, project_id, feature_id, task_id, depends_on_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), NOW_MS, NOW_MS, projectId, featureId, `${idPrefix}-b`, `${idPrefix}-a`);
    return { phaseId, featureId };
  });
}

interface BatchRowInit {
  readonly id?: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly status?: string;
  readonly reason?: string | null;
  readonly budgetRevision?: number;
  readonly budgetSnapshot?: string;
  readonly scopeSnapshot?: string;
  readonly configSnapshot?: string;
  readonly runsCreated?: number;
  readonly attemptsCreated?: number;
  readonly runtimeStarts?: number;
  readonly noProgressRuns?: number;
  readonly deadlineAt?: number;
}

/** 单 Feature 范围的合法 Batch 行（scope_snapshot 恰含一个成员）。 */
function insertBatch(db: CoreDatabase, init: BatchRowInit): string {
  const id = init.id ?? randomUUID();
  db.prepare(
    'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
      'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
      'runtime_starts, no_progress_runs, deadline_at, reason) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    NOW_MS,
    init.projectId,
    NOW_MS,
    init.phaseId,
    init.featureId,
    init.scopeSnapshot ??
      JSON.stringify({ schemaVersion: 1, featureIds: [init.featureId], purpose: 'execute' }),
    init.configSnapshot ?? JSON.stringify({ schemaVersion: 2, strategyKey: 'defaultStrategy' }),
    init.status ?? 'queued',
    init.budgetRevision ?? 1,
    init.budgetSnapshot ??
      JSON.stringify({
        schemaVersion: 1,
        batch: {
          maxRuns: 2,
          maxTotalAttempts: 6,
          maxRuntimeStarts: 6,
          maxNoProgressRuns: 2,
          deadlineUtcMs: init.deadlineAt ?? NOW_MS + 86_400_000,
        },
        run: { maxAttemptsPerRun: 3, runTimeLimitMs: 3_600_000 },
      }),
    init.runsCreated ?? 0,
    init.attemptsCreated ?? 0,
    init.runtimeStarts ?? 0,
    init.noProgressRuns ?? 0,
    init.deadlineAt ?? NOW_MS + 86_400_000,
    init.reason ?? null,
  );
  return id;
}

interface RunRowInit {
  readonly id?: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly status?: string;
  readonly workKey?: string;
  readonly dispatchOrdinal?: number;
  readonly purpose?: string;
  readonly inputSnapshot?: string;
  readonly configSnapshot?: string;
  readonly scopeDigest?: string;
  readonly maxAttemptsPerRun?: number;
  readonly runTimeLimitMs?: number;
  readonly attemptsCreated?: number;
  readonly startedAt?: number | null;
  readonly endedAt?: number | null;
}

function insertRun(db: CoreDatabase, init: RunRowInit): string {
  const id = init.id ?? randomUUID();
  db.prepare(
    'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
      'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, ' +
      'run_time_limit_ms, attempts_created, reason, started_at, ended_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
  ).run(
    id,
    NOW_MS,
    init.projectId,
    NOW_MS,
    init.batchId,
    init.featureId,
    init.purpose ?? 'execute',
    init.inputSnapshot ??
      JSON.stringify({ schemaVersion: 1, tasks: ['t-a', 't-b', 't-c'], acceptance: ['验收一'] }),
    init.configSnapshot ?? JSON.stringify({ schemaVersion: 2, strategyKey: 'defaultStrategy' }),
    init.status ?? 'queued',
    init.scopeDigest ?? VALID_SHA256,
    init.workKey ?? 'work-1',
    init.dispatchOrdinal ?? 1,
    init.maxAttemptsPerRun ?? 3,
    init.runTimeLimitMs ?? 3_600_000,
    init.attemptsCreated ?? 0,
    init.startedAt ?? null,
    init.endedAt ?? null,
  );
  return id;
}

interface BudgetRevisionRowInit {
  readonly id?: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly version: number;
  readonly budgetSnapshot?: string;
  readonly deadlineAt?: number;
  readonly approvedBy?: string;
  readonly reason?: string;
}

function insertBudgetRevision(db: CoreDatabase, init: BudgetRevisionRowInit): string {
  const id = init.id ?? randomUUID();
  db.prepare(
    'INSERT INTO batch_budget_revisions (id, created_at, project_id, revision, updated_at, batch_id, version, ' +
      'budget_snapshot, deadline_at, approved_by, reason) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    NOW_MS,
    init.projectId,
    NOW_MS,
    init.batchId,
    init.version,
    init.budgetSnapshot ??
      JSON.stringify({
        schemaVersion: 1,
        batch: {
          maxRuns: 2,
          maxTotalAttempts: 6,
          maxRuntimeStarts: 6,
          maxNoProgressRuns: 2,
          deadlineUtcMs: init.deadlineAt ?? NOW_MS + 86_400_000,
        },
        run: { maxAttemptsPerRun: 3, runTimeLimitMs: 3_600_000 },
      }),
    init.deadlineAt ?? NOW_MS + 86_400_000,
    init.approvedBy ?? 'local-owner',
    init.reason ?? '初始授权',
  );
  return id;
}

/** 组装迁移后的真实执行域夹具：两个项目、计划结构与一个合法 Batch。 */
async function withExecutionHarness(
  fn: (harness: {
    readonly session: SqliteStorageSession;
    readonly projectA: string;
    readonly projectB: string;
    readonly phaseId: string;
    readonly featureId: string;
    readonly batchId: string;
  }) => Promise<void>,
): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p03-3-f002-');
  try {
    const { session, tick } = openSession(join(sandbox.path, 'state.db'));
    try {
      await migrateSqliteStorage(session, { nowUtcMs: tick });
      const state = createSqliteStateStore(session, { nowUtcMs: tick });
      const projectA = await state.createProject({ displayName: '项目 A', labels: ['alpha'] });
      const projectB = await state.createProject({ displayName: '项目 B', labels: ['beta'] });
      const { phaseId, featureId } = seedPlanStructure(session, projectA.id);
      const batchId = insertBatch(session.database, {
        projectId: projectA.id,
        phaseId,
        featureId,
      });
      await fn({ session, projectA: projectA.id, projectB: projectB.id, phaseId, featureId, batchId });
    } finally {
      session.close();
    }
  } finally {
    sandbox.cleanup();
  }
}

/* ------------------------------------------------------------------ *
 * 迁移 v9：空库 / 真实 P02 v5 库 / 前序最新 v8 库升级、失败回滚与拒写
 * ------------------------------------------------------------------ */

describe('F-002 迁移 v9：单 Feature 执行三表', () => {
  it('历史 v1–v8 SQL/checksum 与开工冻结摘要一致，v9 为唯一新增追加版本', () => {
    expect(V9_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const [version, frozen] of Object.entries(FROZEN_V1_TO_V8_CHECKSUMS)) {
      const migration = SQLITE_MIGRATIONS[Number(version) - 1];
      expect(migration?.version, `v${version} 版本号`).toBe(Number(version));
      expect(migration?.checksum, `v${version} checksum 不得改动`).toBe(frozen);
      expect(migration?.checksum).toBe(sha256Hex(migration?.sql ?? ''));
    }
    const v9 = SQLITE_MIGRATIONS[8];
    expect(v9?.version).toBe(9);
    expect(v9?.checksum).toBe(sha256Hex(v9?.sql ?? ''));
    for (const table of V9_TABLES) {
      expect(v9?.sql, `v9 必须建立 ${table}`).toMatch(new RegExp(`CREATE TABLE ${table} \\(`));
    }
    // 不可变内容校验触发器（设计 11 §10「不可变内容校验须有失败用例」的 DDL 承载）。
    expect(v9?.sql).toContain('CREATE TRIGGER execution_batches_immutable_columns_update');
    expect(v9?.sql).toContain('CREATE TRIGGER runs_immutable_columns_update');
    expect(v9?.sql).toContain('CREATE TRIGGER batch_budget_revisions_immutable_update');
    expect(v9?.sql).toContain('CREATE TRIGGER batch_budget_revisions_immutable_delete');
    for (const forbidden of V9_FORBIDDEN_TABLES) {
      expect(v9?.sql, `v9 不得建立 ${forbidden}`).not.toContain(`CREATE TABLE ${forbidden}`);
    }
  });

  it('真实空库迁移到 v9：三表建立且为空，不提前建立 Attempt/Session/Worktree/通知表', async () => {
    const sandbox = createTempSandbox('shiploop-p03-3-f002-empty-');
    try {
      const { session, tick } = openSession(join(sandbox.path, 'state.db'));
      try {
        const result = await migrateSqliteStorage(session, { nowUtcMs: tick });
        expect(result.fromVersion).toBe(0);
        expect(result.toVersion).toBe(9);
        expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const tables = listUserTables(session.database);
        for (const table of V9_TABLES) {
          expect(tables).toContain(table);
          expect(session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
        for (const forbidden of V9_FORBIDDEN_TABLES) {
          expect(tables, `不得生成后续表 ${forbidden}`).not.toContain(forbidden);
        }
        // 不建计划/配置业务版本表（设计 11 §3/§5 明确不建设范围）。
        expect(tables.filter((name) => name.includes('version') || name.includes('revision'))).toEqual([
          'batch_budget_revisions',
        ]);
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('真实 P02 v5 库（项目/配置/Artifact/回执/事件/基线行）升级到 v9：既有数据逐字段保留', async () => {
    const sandbox = createTempSandbox('shiploop-p03-3-f002-v5-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const { session, tick } = openSession(dbPath);
      try {
        await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 5), nowUtcMs: tick });
        const { projectId } = await seedP02V5DataAsync(session, tick);
        const eventsBefore = session.database
          .prepare<[], { max: number }>('SELECT MAX(sequence) AS max FROM state_events')
          .get();
        expect(eventsBefore?.max).toBeGreaterThan(0);
        const before = snapshotTables(session.database);

        const result = await migrateSqliteStorage(session, { nowUtcMs: tick });
        expect(result.fromVersion).toBe(5);
        expect(result.toVersion).toBe(9);
        expect(result.appliedVersions).toEqual([6, 7, 8, 9]);
        expectTablesPreserved(snapshotTables(session.database), before);
        // 迁移记录：v1–v8 checksum 原样，v9 为新记录。
        const rows = session.database
          .prepare<[], { version: number; checksum: string }>(
            'SELECT version, checksum FROM schema_migrations ORDER BY version',
          )
          .all();
        expect(rows).toHaveLength(9);
        for (const [version, frozen] of Object.entries(FROZEN_V1_TO_V8_CHECKSUMS)) {
          expect(rows[Number(version) - 1]?.checksum).toBe(frozen);
        }
        expect(rows[8]?.checksum).toBe(SQLITE_MIGRATIONS[8]?.checksum);
        // 重开再核对：数据仍在、三表为空且结构可写（合法 Batch/Run/预算修订行成功）。
        session.close();
        const reopened = openSqliteStorageSession({ path: dbPath });
        try {
          expectTablesPreserved(snapshotTables(reopened.database), before);
          const plan = seedPlanStructure(
            reopened,
            projectId,
          );
          const batchId = insertBatch(reopened.database, {
            projectId,
            phaseId: plan.phaseId,
            featureId: plan.featureId,
          });
          insertRun(reopened.database, {
            projectId,
            batchId,
            featureId: plan.featureId,
            startedAt: NOW_MS,
          });
          insertBudgetRevision(reopened.database, { projectId, batchId, version: 1 });
          expect(reopened.database.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
        } finally {
          reopened.close();
        }
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('前序最新 v8 库（计划结构与审批数据）升级到 v9：既有数据保留，三表可写', async () => {
    const sandbox = createTempSandbox('shiploop-p03-3-f002-v8-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const { session, tick } = openSession(dbPath);
      try {
        await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 8), nowUtcMs: tick });
        const state = createSqliteStateStore(session, { nowUtcMs: tick });
        const project = await state.createProject({ displayName: '前序项目', labels: [] });
        const { phaseId, featureId } = seedPlanStructure(session, project.id);
        session.database
          .prepare(
            'INSERT INTO approvals (id, created_at, project_id, revision, updated_at, subject_type, subject_id, ' +
              "subject_digest, check_policy_digest, status, decision_actor, reason, decided_at) VALUES (?, ?, ?, 1, ?, 'feature_plan', ?, ?, ?, 'approved', 'local-owner', '前序批准', ?)",
          )
          .run('ap-p033-1', NOW_MS, project.id, NOW_MS, featureId, VALID_SHA256, VALID_SHA256, NOW_MS);
        const before = snapshotTables(session.database);

        const result = await migrateSqliteStorage(session, { nowUtcMs: tick });
        expect(result.fromVersion).toBe(8);
        expect(result.toVersion).toBe(9);
        expect(result.appliedVersions).toEqual([9]);
        expectTablesPreserved(snapshotTables(session.database), before);
        // 升级后执行域三表可写（同项目 Batch → Run → 预算修订完整链）。
        const batchId = insertBatch(session.database, {
          projectId: project.id,
          phaseId,
          featureId,
        });
        insertRun(session.database, { projectId: project.id, batchId, featureId, startedAt: NOW_MS });
        insertBudgetRevision(session.database, { projectId: project.id, batchId, version: 1 });
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM batch_budget_revisions').get()).toEqual({ n: 1 });
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('v9 迁移失败整组回滚：库保持一致 v8（无半张表/半条触发器），修复后升级成功且不伪装', async () => {
    const sandbox = createTempSandbox('shiploop-p03-3-f002-rollback-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const { session, tick } = openSession(dbPath);
      try {
        const v8 = SQLITE_MIGRATIONS.slice(0, 8);
        await migrateSqliteStorage(session, { migrations: v8, nowUtcMs: tick });
        const state = createSqliteStateStore(session, { nowUtcMs: tick });
        await state.createProject({ displayName: '回滚项目' });
        // 故障 v9：先建一张合法表再跟非法语句（探针表与记录必须整体消失）。
        const badSql =
          'CREATE TABLE f9_bad_probe (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE execution_batches (id TEXT PRIMARY KEY NOT NULL); THIS IS NOT VALID SQL;';
        const badV9 = { version: 9, sql: badSql, checksum: sha256Hex(badSql) };
        let caught: unknown;
        try {
          await migrateSqliteStorage(session, { migrations: [...v8, badV9], nowUtcMs: tick });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(SqliteMigrationError);
        expect((caught as SqliteMigrationError).step).toBe('apply');
        expect((caught as SqliteMigrationError).version).toBe(9);
        const tables = listUserTables(session.database);
        expect(tables).not.toContain('f9_bad_probe');
        expect(tables).not.toContain('execution_batches');
        const triggers = session.database
          .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'")
          .all();
        expect(triggers).toEqual([]);
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
        const versions = session.database
          .prepare<[], { version: number }>('SELECT version FROM schema_migrations ORDER BY version')
          .all();
        expect(versions).toHaveLength(8);
        // 修复后（真实清单）从一致 v8 继续升级成功。
        const retry = await migrateSqliteStorage(session, { nowUtcMs: tick });
        expect(retry.appliedVersions).toEqual([9]);
        expect(listUserTables(session.database)).toEqual(expect.arrayContaining([...V9_TABLES]));
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('高版本与 checksum 漂移拒写在 v9 清单下继续有效', async () => {
    const sandbox = createTempSandbox('shiploop-p03-3-f002-reject-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const { session } = openSession(dbPath);
      try {
        await migrateSqliteStorage(session);
        // 高版本：插入 v10 探针记录（超出支持范围）。
        session.database
          .prepare('INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, ?, ?, ?, ?)')
          .run('migration-v10', 1, 10, VALID_SHA256, 1);
        session.close();
        const highVersion = openSqliteStorageSession({ path: dbPath });
        let high: unknown;
        try {
          await migrateSqliteStorage(highVersion);
        } catch (error) {
          high = error;
        } finally {
          highVersion.close();
        }
        expect(isStorageError(high, 'unsupported_version'), `实际 ${String(high)}`).toBe(true);

        // checksum 漂移：篡改 v3 记录后拒写。
        const driftPath = join(sandbox.path, 'drift.db');
        const drift = openSqliteStorageSession({ path: driftPath });
        try {
          await migrateSqliteStorage(drift);
          drift.database
            .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 3')
            .run('cd'.repeat(32));
        } finally {
          drift.close();
        }
        const drifted = openSqliteStorageSession({ path: driftPath });
        let driftError: unknown;
        try {
          await migrateSqliteStorage(drifted);
        } catch (error) {
          driftError = error;
        } finally {
          drifted.close();
        }
        expect(isStorageError(driftError, 'corrupt'), `实际 ${String(driftError)}`).toBe(true);
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 真实 SQLite 负例：直接 SQL 命中 DDL 约束（不是 TypeScript 校验模拟）
 * ------------------------------------------------------------------ */

describe('F-002 执行域 DDL 约束负例（真实 SQLite）', () => {
  it('缺失父 Batch、跨项目引用与跨 Feature 范围引用由外键/复合外键拒绝，行数不变', async () => {
    await withExecutionHarness(async ({ session, projectA, projectB, featureId, batchId }) => {
      const db = session.database;
      const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;

      // 缺失父 Batch：runs 引用不存在的 batch_id。
      expect(() => insertRun(db, { projectId: projectA, batchId: MISSING_ID, featureId })).toThrow(
        FOREIGN_KEY_FAILED,
      );
      // 缺失父 Batch：预算修订记录。
      expect(() => insertBudgetRevision(db, { projectId: projectA, batchId: MISSING_ID, version: 1 })).toThrow(
        FOREIGN_KEY_FAILED,
      );
      // 第二个 Phase/Feature（无活动 Batch/Run 占用，隔离唯一索引干扰）。
      const second = seedPlanStructure(
        session,
        projectA,
        '第二阶段',
        's2',
      );
      // 跨项目引用：Batch 声明项目 B 但引用项目 A 的 Phase/Feature。
      expect(() =>
        insertBatch(db, { projectId: projectB, phaseId: second.phaseId, featureId: second.featureId }),
      ).toThrow(FOREIGN_KEY_FAILED);
      // 跨项目引用：Run 声明项目 B 但引用项目 A 的 Batch/Feature。
      expect(() => insertRun(db, { projectId: projectB, batchId, featureId })).toThrow(FOREIGN_KEY_FAILED);
      // 跨项目引用：预算修订记录声明项目 B 但引用项目 A 的 Batch。
      expect(() => insertBudgetRevision(db, { projectId: projectB, batchId, version: 1 })).toThrow(
        FOREIGN_KEY_FAILED,
      );
      // 单 Feature 范围：Run 的 Feature 必须是父 Batch 的同一 Feature。
      expect(() => insertRun(db, { projectId: projectA, batchId, featureId: second.featureId })).toThrow(
        FOREIGN_KEY_FAILED,
      );
      // Batch 的 phase_id 必须是其 Feature 的真实 Phase（直接 SQL 伪造归属被拒绝）。
      expect(() => insertBatch(db, { projectId: projectA, phaseId: second.phaseId, featureId })).toThrow(
        FOREIGN_KEY_FAILED,
      );

      expect(db.prepare('SELECT COUNT(*) AS n FROM execution_batches').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM batch_budget_revisions').get()).toEqual({ n: 0 });
    });
  });

  it('负计数、非法状态、非法 JSON/单成员范围由 CHECK 拒绝，行数不变', async () => {
    await withExecutionHarness(async ({ session, projectA }) => {
      const db = session.database;
      const CHECK_FAILED = /CHECK constraint failed/;
      // 探针 Phase/Feature（无活动 Batch 占用，隔离唯一索引干扰，命中确定约束）。
      const probe = seedPlanStructure(
        session,
        projectA,
        '探针阶段',
        'p1',
      );
      const { phaseId, featureId } = probe;

      // 负计数与非法时间/修订号。
      expect(
        () => insertBatch(db, { projectId: projectA, phaseId, featureId, runsCreated: -1 }),
        'runs_created 负计数必须拒绝',
      ).toThrow(CHECK_FAILED);
      expect(
        () => insertBatch(db, { projectId: projectA, phaseId, featureId, attemptsCreated: -1 }),
        'attempts_created 负计数必须拒绝',
      ).toThrow(CHECK_FAILED);
      expect(
        () => insertBatch(db, { projectId: projectA, phaseId, featureId, runtimeStarts: -1 }),
        'runtime_starts 负计数必须拒绝',
      ).toThrow(CHECK_FAILED);
      expect(
        () => insertBatch(db, { projectId: projectA, phaseId, featureId, noProgressRuns: -1 }),
        'no_progress_runs 负计数必须拒绝',
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertBatch(db, { projectId: projectA, phaseId, featureId, deadlineAt: 0 }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertBatch(db, { projectId: projectA, phaseId, featureId, budgetRevision: 0 }),
      ).toThrow(CHECK_FAILED);
      // 非法状态（枚举 CHECK）。
      expect(() =>
        insertBatch(db, { projectId: projectA, phaseId, featureId, status: 'bogus' }),
      ).toThrow(CHECK_FAILED);
      // 非法 JSON 与非单成员范围。
      for (const scope of ['not-json', '{"not":"array"}', '{"featureIds":[]}', '{"featureIds":["a","b"]}', '{}']) {
        expect(
          () => insertBatch(db, { projectId: projectA, phaseId, featureId, scopeSnapshot: scope }),
          `scope_snapshot=${scope} 必须拒绝`,
        ).toThrow(CHECK_FAILED);
      }
      expect(() =>
        insertBatch(db, { projectId: projectA, phaseId, featureId, configSnapshot: '"text"' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertBatch(db, { projectId: projectA, phaseId, featureId, budgetSnapshot: '[]' }),
      ).toThrow(CHECK_FAILED);

      const batchId = insertBatch(db, { projectId: projectA, phaseId, featureId, id: 'batch-check-1' });
      // Run 侧：负计数/非法上限/非法状态/非法摘要/空身份。
      expect(() =>
        insertRun(db, { projectId: projectA, batchId, featureId, status: 'bogus', workKey: 'w-x1' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertRun(db, { projectId: projectA, batchId, featureId, attemptsCreated: -1, workKey: 'w-x2' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertRun(db, { projectId: projectA, batchId, featureId, maxAttemptsPerRun: 0, workKey: 'w-x3' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertRun(db, { projectId: projectA, batchId, featureId, runTimeLimitMs: 0, workKey: 'w-x4' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertRun(db, { projectId: projectA, batchId, featureId, scopeDigest: 'ZZ', workKey: 'w-x5' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertRun(db, { projectId: projectA, batchId, featureId, workKey: '' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertRun(db, { projectId: projectA, batchId, featureId, inputSnapshot: '[]', workKey: 'w-x6' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertRun(db, { projectId: projectA, batchId, featureId, dispatchOrdinal: 0, workKey: 'w-x7' }),
      ).toThrow(CHECK_FAILED);

      // 重复派发身份：UNIQUE(batch_id, work_key, dispatch_ordinal)（终态行隔离活动唯一干扰）。
      insertRun(db, {
        projectId: projectA,
        batchId,
        featureId,
        workKey: 'w-1',
        dispatchOrdinal: 1,
        status: 'failed',
        id: 'run-dup-1',
      });
      expect(() =>
        insertRun(db, { projectId: projectA, batchId, featureId, workKey: 'w-1', dispatchOrdinal: 1, status: 'failed' }),
      ).toThrow(/UNIQUE constraint failed: runs\.batch_id, runs\.work_key, runs\.dispatch_ordinal/);
      // 同 workKey 递增 dispatchOrdinal 是合法重试派发。
      insertRun(db, {
        projectId: projectA,
        batchId,
        featureId,
        workKey: 'w-1',
        dispatchOrdinal: 2,
        status: 'failed',
        id: 'run-dup-2',
      });

      // 预算修订：重复修订身份与非法字段。
      insertBudgetRevision(db, { projectId: projectA, batchId, version: 1, id: 'rev-1' });
      expect(() =>
        insertBudgetRevision(db, { projectId: projectA, batchId, version: 1 }),
      ).toThrow(/UNIQUE constraint failed: batch_budget_revisions\.batch_id, batch_budget_revisions\.version/);
      expect(() =>
        insertBudgetRevision(db, { projectId: projectA, batchId, version: 0 }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertBudgetRevision(db, { projectId: projectA, batchId, version: 2, approvedBy: '' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertBudgetRevision(db, { projectId: projectA, batchId, version: 2, reason: '' }),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        insertBudgetRevision(db, { projectId: projectA, batchId, version: 2, deadlineAt: 0 }),
      ).toThrow(CHECK_FAILED);

      expect(db.prepare('SELECT COUNT(*) AS n FROM execution_batches').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM batch_budget_revisions').get()).toEqual({ n: 1 });
    });
  });

  it('同 Feature 恰一个有效活动 Run、同 Phase 恰一个有效活动 Batch；paused/interrupted 不可绕过，终态不参与', async () => {
    await withExecutionHarness(async ({ session, projectA, phaseId, featureId, batchId }) => {
      const db = session.database;
      for (const status of ACTIVE_STATUSES) {
        const runId = `run-active-${status}`;
        insertRun(db, { projectId: projectA, batchId, featureId, status, workKey: `w-${status}`, id: runId });
        // 同 Feature 第二个有效活动 Run（同 Batch、不同 workKey）被拒绝。
        expect(() =>
          insertRun(db, { projectId: projectA, batchId, featureId, status: 'running', workKey: `w-${status}-2` }),
          `status=${status} 的活动 Run 必须唯一`,
        ).toThrow(/UNIQUE constraint failed: runs\.feature_id/);
        db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
      }
      // 终态 Run 不参与活动唯一：succeeded/failed/cancelled 后可派发新活动 Run。
      for (const status of TERMINAL_STATUSES) {
        insertRun(db, {
          projectId: projectA,
          batchId,
          featureId,
          status,
          workKey: `w-term-${status}`,
          id: `run-term-${status}`,
          dispatchOrdinal: 3,
        });
      }
      insertRun(db, {
        projectId: projectA,
        batchId,
        featureId,
        status: 'running',
        workKey: 'w-after-terminal',
        dispatchOrdinal: 4,
        id: 'run-after-terminal',
      });

      // 同 Phase 活动 Batch 唯一：现有 Batch（queued）阻止同 Phase 第二个活动 Batch。
      for (const status of ACTIVE_STATUSES) {
        db.prepare('UPDATE execution_batches SET status = ? WHERE id = ?').run(status, batchId);
        expect(() =>
          insertBatch(db, { projectId: projectA, phaseId, featureId, id: `batch-active-${status}` }),
          `status=${status} 的活动 Batch 必须唯一`,
        ).toThrow(/UNIQUE constraint failed: execution_batches\.phase_id/);
      }
      // 终态 Batch 后同 Phase 可开始新 Batch；不同 Phase 并行不受影响。
      db.prepare('UPDATE execution_batches SET status = ? WHERE id = ?').run('succeeded', batchId);
      insertBatch(db, { projectId: projectA, phaseId, featureId, id: 'batch-after-terminal' });
      const third = seedPlanStructure(
        session,
        projectA,
        '第三阶段',
        's3',
      );
      db.prepare('UPDATE execution_batches SET status = ? WHERE id = ?').run('running', 'batch-after-terminal');
      insertBatch(db, {
        projectId: projectA,
        phaseId: third.phaseId,
        featureId: third.featureId,
        id: 'batch-other-phase',
      });
    });
  });

  it('不可变内容校验：范围/配置/输入快照、派发身份与预算修订历史不可被覆盖', async () => {
    await withExecutionHarness(async ({ session, projectA, phaseId, featureId, batchId }) => {
      const db = session.database;

      // Batch 身份与不可变范围/输入配置依据不可 UPDATE 覆盖。
      for (const assignment of [
        'scope_snapshot = \'{"featureIds":["x"]}\'',
        'config_snapshot = \'{"tampered":true}\'',
        'feature_id = \'other-feature\'',
        'phase_id = \'other-phase\'',
        'project_id = \'other-project\'',
        'created_at = 1',
        "id = 'other-batch'",
      ]) {
        expect(
          () => db.prepare(`UPDATE execution_batches SET ${assignment} WHERE id = ?`).run(batchId),
          `execution_batches.${assignment} 必须拒绝`,
        ).toThrow(/immutable/);
      }
      // 当前预算与控制状态在 Batch 行上正常演进（F-009 修订路径）。
      db.prepare(
        'UPDATE execution_batches SET budget_revision = 2, budget_snapshot = ?, deadline_at = ?, status = ?, runs_created = 1, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify({ schemaVersion: 1 }), NOW_MS + 200_000, 'running', NOW_MS + 1, batchId);

      // Run 输入快照与派发身份不可覆盖；结果与控制字段可更新。
      const runId = insertRun(db, {
        projectId: projectA,
        batchId,
        featureId,
        workKey: 'w-immutable',
        startedAt: NOW_MS,
        id: 'run-immutable-1',
      });
      for (const assignment of [
        "input_snapshot = '[]'",
        'config_snapshot = \'{"tampered":true}\'',
        "work_key = 'other-work'",
        'dispatch_ordinal = 99',
        'max_attempts_per_run = 99',
        'run_time_limit_ms = 99',
        'batch_id = \'other-batch\'',
        'feature_id = \'other-feature\'',
        'scope_digest = \'' + 'cd'.repeat(32) + '\'',
        'started_at = 1',
      ]) {
        expect(
          () => db.prepare(`UPDATE runs SET ${assignment} WHERE id = ?`).run(runId),
          `runs.${assignment} 必须拒绝`,
        ).toThrow(/immutable/);
      }
      db.prepare('UPDATE runs SET status = ?, attempts_created = 1, ended_at = ?, updated_at = ? WHERE id = ?').run(
        'succeeded',
        NOW_MS + 2,
        NOW_MS + 2,
        runId,
      );
      // started_at 为时间依据：NULL 时可首次设定，设定后不可改写（含改回 NULL）。
      const run2 = insertRun(db, {
        projectId: projectA,
        batchId,
        featureId,
        workKey: 'w-immutable-2',
        dispatchOrdinal: 2,
        id: 'run-immutable-2',
      });
      db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(NOW_MS + 5, run2);
      expect(() => db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(NOW_MS + 6, run2)).toThrow(
        /immutable/,
      );
      expect(() => db.prepare('UPDATE runs SET started_at = NULL WHERE id = ?').run(run2)).toThrow(
        /immutable/,
      );

      // 初始与历史预算快照不可被当前预算更新覆盖：修订行 UPDATE/DELETE 一律拒绝。
      const rev1 = insertBudgetRevision(db, {
        projectId: projectA,
        batchId,
        version: 1,
        id: 'rev-immutable-1',
        reason: '初始授权',
      });
      const rowBefore = db.prepare('SELECT * FROM batch_budget_revisions WHERE id = ?').get(rev1);
      expect(() =>
        db.prepare('UPDATE batch_budget_revisions SET budget_snapshot = ? WHERE id = ?').run('{"tampered":true}', rev1),
      ).toThrow(/immutable/);
      expect(() =>
        db.prepare('UPDATE batch_budget_revisions SET reason = ? WHERE id = ?').run('改写理由', rev1),
      ).toThrow(/immutable/);
      expect(() => db.prepare('DELETE FROM batch_budget_revisions WHERE id = ?').run(rev1)).toThrow(
        /immutable/,
      );
      // 当前预算更新（Batch 行 + 新版本修订行）不覆盖初始/历史快照。
      db.prepare(
        'UPDATE execution_batches SET budget_revision = 2, budget_snapshot = ?, deadline_at = ?, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify({ schemaVersion: 1, revised: true }), NOW_MS + 300_000, NOW_MS + 3, batchId);
      insertBudgetRevision(db, {
        projectId: projectA,
        batchId,
        version: 2,
        id: 'rev-immutable-2',
        budgetSnapshot: JSON.stringify({ schemaVersion: 1, revised: true }),
        deadlineAt: NOW_MS + 300_000,
        reason: '增额延期',
      });
      expect(db.prepare('SELECT * FROM batch_budget_revisions WHERE id = ?').get(rev1)).toEqual(rowBefore);
      expect(db.prepare('SELECT COUNT(*) AS n FROM batch_budget_revisions').get()).toEqual({ n: 2 });
    });
  });
});
