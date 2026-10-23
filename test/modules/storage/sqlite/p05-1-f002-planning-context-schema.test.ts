/**
 * P05-1 / F-002 迁移 v35：一次性规划上下文（真实临时 SQLite）。
 *
 * 覆盖（对应验收标准 2）：
 * - v35 只追加 planning_contexts（含唯一/部分唯一索引与写一次触发器），v1–v34
 *   SQL/checksum 冻结不变；不重建/修改既有表，不新建预算或队列表；
 * - 空库直接迁移到 v35：planning_contexts 存在且为空；
 * - v34 旧库（真实计划、审批、派发意图与 Attempt 数据）升级到 v35：既有数据
 *   逐字段可读（升级不自动创建规划上下文/Task）；
 * - 真实 SQLite 负例（直接 SQL 命中 DDL 约束）：跨项目/跨 Phase/跨 Feature 归属
 *   复合外键、重复候选/Run/活动规划归属唯一、非法状态枚举、摘要形状、候选形状
 *   与决策一致性 CHECK、身份不可变/候选写一次/决策写一次触发器——每项失败后
 *   行数不变。
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
const HASH_B = 'cd'.repeat(32);
/** v34 及之前迁移校验摘要的冻结聚合摘要（P05-1 / F-002 开工时计算，不因 v35 重算）。 */
const FROZEN_V34_CHECKSUM_HASH = 'aa0d328cbadd38b0fb3a83037e40d400a9107f7da65dd5d25d0d6100814cd784';

function hashOfChecksums(migrations: readonly { checksum: string }[]): string {
  return createHash('sha256').update(migrations.map((migration) => migration.checksum).join('\n')).digest('hex');
}

interface Fixture {
  readonly session: SqliteStorageSession;
  readonly projectId: string;
  readonly otherProjectId: string;
  readonly phaseId: string;
  readonly otherPhaseId: string;
  readonly featureId: string;
  readonly otherFeatureId: string;
  readonly runId: string;
  readonly otherFeatureRunId: string;
  readonly planningTaskId: string;
  readonly otherFeatureTaskId: string;
  readonly candidateId: string;
  readonly artifactId: string;
  readonly db: SqliteStorageSession['database'];
  /** 直接 SQL 插入一条最小合法规划上下文（status='open'，候选事实恒 NULL）。 */
  insertContext(overrides?: Record<string, unknown>, candidateId?: string): void;
  cleanup(): void;
}

/** 建立最小计划/执行结构（项目×2、Phase×2、Feature×2、业务 Task×2、Batch、Run×2、Artifact）。 */
async function openFixture(v34 = false): Promise<Fixture> {
  const sandbox = createTempSandbox('shiploop-p05-1-f002-schema-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  try {
    await migrateSqliteStorage(session, {
      ...(v34 ? { migrations: SQLITE_MIGRATIONS.slice(0, 34) } : {}),
    });
  } catch (error) {
    session.close();
    sandbox.cleanup();
    throw error;
  }
  const db = session.database;
  const projectId = 'proj-p051-a';
  const otherProjectId = 'proj-p051-b';
  const phaseId = 'phase-p051-a';
  const otherPhaseId = 'phase-p051-b';
  const featureId = 'feat-p051-a';
  const otherFeatureId = 'feat-p051-b';
  const runId = 'run-p051-plan-1';
  const otherFeatureRunId = 'run-p051-plan-2';
  const planningTaskId = 'task-p051-plan-a';
  const otherFeatureTaskId = 'task-p051-plan-b';
  const candidateId = 'cand-p051-1';
  const artifactId = 'art-p051-candidate-1';
  const batchId = 'batch-p051-1';

  const insertProject = (id: string): void => {
    db.prepare('INSERT INTO projects (id, created_at, revision, updated_at, display_name, status) VALUES (?, ?, 1, ?, ?, ?)')
      .run(id, NOW_MS, NOW_MS, `项目 ${id}`, 'active');
  };
  const insertPhase = (id: string, project: string): void => {
    db.prepare('INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, ?, ?, ?, ?)')
      .run(id, NOW_MS, project, NOW_MS, `阶段 ${id}`);
  };
  const insertFeature = (id: string, project: string, phase: string): void => {
    db.prepare('INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, plan_digest, source_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, NOW_MS, project, NOW_MS, phase, `Feature ${id}`, HASH, '[]');
  };
  const insertPlanningTask = (id: string, project: string, feature: string): void => {
    db.prepare(
      'INSERT INTO tasks (id, created_at, project_id, updated_at, feature_id, title, acceptance, execution_config, config_source, config_source_key, kind) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'project_default', 'purposeStrategies.planner', 'planning')",
    ).run(id, NOW_MS, project, NOW_MS, feature, `规划任务 ${id}`, JSON.stringify({ criteria: ['候选通过校验'] }),
      JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'p', model: 'm' }));
  };
  const insertRun = (id: string, project: string, feature: string, batch: string, purpose: string): void => {
    db.prepare(
      'INSERT INTO runs (id, created_at, project_id, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, max_attempts_per_run, run_time_limit_ms) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 1, 3600000)",
    ).run(id, NOW_MS, project, NOW_MS, batch, feature, purpose,
      JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 2 }), HASH, `work-${id}`);
  };

  insertProject(projectId);
  insertProject(otherProjectId);
  insertPhase(phaseId, projectId);
  insertPhase(otherPhaseId, otherProjectId);
  insertFeature(featureId, projectId, phaseId);
  insertFeature(otherFeatureId, otherProjectId, otherPhaseId);
  insertPlanningTask(planningTaskId, projectId, featureId);
  insertPlanningTask(otherFeatureTaskId, otherProjectId, otherFeatureId);
  // 两个项目各一个 Batch；每个 Feature 一个规划用途 Run。
  db.prepare(
    'INSERT INTO execution_batches (id, created_at, project_id, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(batchId, NOW_MS, projectId, NOW_MS, phaseId, featureId,
    JSON.stringify({ schemaVersion: 1, featureIds: [featureId] }),
    JSON.stringify({ schemaVersion: 2 }), 'queued',
    JSON.stringify({ schemaVersion: 1, batch: { maxRuns: 1 }, run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 } }),
    NOW_MS + 3_600_000);
  db.prepare(
    'INSERT INTO execution_batches (id, created_at, project_id, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run('batch-p051-2', NOW_MS, otherProjectId, NOW_MS, otherPhaseId, otherFeatureId,
    JSON.stringify({ schemaVersion: 1, featureIds: [otherFeatureId] }),
    JSON.stringify({ schemaVersion: 2 }), 'queued',
    JSON.stringify({ schemaVersion: 1, batch: { maxRuns: 1 }, run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 } }),
    NOW_MS + 3_600_000);
  insertRun(runId, projectId, featureId, batchId, 'plan');
  insertRun(otherFeatureRunId, otherProjectId, otherFeatureId, 'batch-p051-2', 'plan');
  // 候选 Artifact（ready + 内容摘要）。
  db.prepare(
    'INSERT INTO artifacts (id, created_at, revision, updated_at, project_id, kind, status, media_type, expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(artifactId, NOW_MS, NOW_MS, projectId, 'plan-candidate', 'ready', 'application/json', HASH_B, HASH_B, 128, 'projects/x/artifacts/art-p051-candidate-1');

  const insertContext = (overrides: Record<string, unknown> = {}, candidate = candidateId): void => {
    const row = {
      id: randomUUID(),
      created_at: NOW_MS,
      project_id: projectId,
      updated_at: NOW_MS,
      phase_id: phaseId,
      feature_id: featureId,
      run_id: runId,
      planning_task_id: planningTaskId,
      candidate_id: candidate,
      input_digest: HASH,
      target_revision: 1,
      plan_digest: HASH,
      candidate_artifact_id: null,
      candidate_content_hash: null,
      candidate_digest: null,
      candidate_summary: null,
      status: 'open',
      decision: null,
      decision_reason: null,
      decided_at: null,
      applied_revision: null,
      applied_at: null,
      ...overrides,
    };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO planning_contexts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...(Object.values(row) as (string | number | null)[]));
  };

  const cleanup = (): void => {
    session.close();
    sandbox.cleanup();
  };
  return {
    session, db, projectId, otherProjectId, phaseId, otherPhaseId, featureId, otherFeatureId,
    runId, otherFeatureRunId, planningTaskId, otherFeatureTaskId, candidateId, artifactId,
    insertContext, cleanup,
  };
}

describe('P05-1 F-002 migration v35 planning contexts', () => {
  it('[case:migration-appends-v35] v35 只追加规划上下文结构，历史迁移与校验摘要冻结', () => {
    expect(SQLITE_MIGRATIONS).toHaveLength(36);
    expect(SQLITE_MIGRATIONS[33]?.version).toBe(34);
    expect(SQLITE_MIGRATIONS[34]?.version).toBe(35);
    // Frozen from the predecessor source, not recomputed from the new descriptor.
    expect(hashOfChecksums(SQLITE_MIGRATIONS.slice(0, 34))).toBe(FROZEN_V34_CHECKSUM_HASH);
    const sql = SQLITE_MIGRATIONS[34]?.sql ?? '';
    expect(sql).toContain('CREATE TABLE planning_contexts');
    expect(sql).toContain('planning_contexts_candidate_unique');
    expect(sql).toContain('planning_contexts_run_unique');
    expect(sql).toContain('planning_contexts_feature_active_unique');
    expect(sql).toContain('planning_contexts_identity_immutable');
    expect(sql).toContain('planning_contexts_candidate_write_once');
    expect(sql).toContain('planning_contexts_decision_write_once');
    // 不重建/修改既有表，不新建 Task/预算/队列状态机。
    expect(sql).not.toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/CREATE TABLE (tasks|task_attempt_reservations|runs|attempts|run_dispatch_intents|run_dispatch_claims|execution_batches)/);
  });

  it('[case:empty-db-v35] 空库直接迁移到 v35：planning_contexts 存在且为空', async () => {
    const sandbox = createTempSandbox('shiploop-p05-1-f002-empty-');
    try {
      const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        const result = await migrateSqliteStorage(session);
        expect(result.toVersion).toBe(36);
        expect(
          session.database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'planning_contexts'").get(),
        ).toEqual({ n: 1 });
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get()).toEqual({ n: 0 });
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:v34-upgrade-preserves-data] v34 旧库升级到 v35：既有计划/审批/派发/Attempt 数据逐字段可读', async () => {
    const f = await openFixture(true);
    try {
      // v34 库既有业务数据：业务 Task、审批决策、派发意图与 Attempt。
      f.db.prepare(
        'INSERT INTO tasks (id, created_at, project_id, updated_at, feature_id, title, acceptance, complexity, execution_config, config_source, config_source_key, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('task-p051-code-1', NOW_MS, f.projectId, NOW_MS, f.featureId, '业务任务',
        JSON.stringify({ criteria: ['验收'] }), 'low',
        JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }),
        'project_default', 'defaultStrategy', 'coding');
      f.db.prepare(
        'INSERT INTO approvals (id, created_at, project_id, updated_at, subject_type, subject_id, subject_digest, check_policy_digest, status, decision_actor, reason, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('approval-p051-1', NOW_MS, f.projectId, NOW_MS, 'feature_plan', f.featureId, HASH, HASH_B, 'approved', 'local-owner', 'test approval', NOW_MS);
      f.db.prepare(
        'INSERT INTO run_dispatch_intents (id, created_at, project_id, updated_at, feature_id, batch_id, run_id, source, authorization_digest, enqueued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('intent-p051-1', NOW_MS, f.projectId, NOW_MS, f.featureId, 'batch-p051-1', f.runId, 'start', HASH_B, NOW_MS);
      const attemptSnapshot = JSON.stringify({
        schemaVersion: 1, projectId: f.projectId, featureId: f.featureId, taskId: 'task-p051-code-1',
        digests: { snapshotDigest: HASH },
        group: {
          snapshot: {
            artifactId: f.artifactId, version: 1, contentHash: HASH_B, sizeBytes: 128,
            locator: 'projects/x/artifacts/art-p051-candidate-1', mediaType: 'application/json',
          },
        },
        requiredInputs: [],
      });
      f.db.prepare(
        'INSERT INTO attempts (id, created_at, project_id, updated_at, feature_id, run_id, task_id, number, owner_id, host_instance_id, execution_version, lease_until, status, input_snapshot, input_digest, input_ref, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?, 0)',
      ).run('attempt-p051-1', NOW_MS, f.projectId, NOW_MS, f.featureId, f.runId, 'task-p051-code-1', 'owner-1', 'host-1', NOW_MS, 'succeeded', attemptSnapshot, HASH, f.artifactId);

      // 升级到 v35。
      const result = await migrateSqliteStorage(f.session);
      expect(result.fromVersion).toBe(34);
      expect(result.toVersion).toBe(36);
      // 既有数据逐字段可读；升级不自动创建规划上下文。
      expect(f.db.prepare('SELECT id, kind, config_source_key FROM tasks WHERE id = ?').get('task-p051-code-1'))
        .toEqual({ id: 'task-p051-code-1', kind: 'coding', config_source_key: 'defaultStrategy' });
      expect(f.db.prepare('SELECT status, decision_actor, subject_digest FROM approvals WHERE id = ?').get('approval-p051-1'))
        .toEqual({ status: 'approved', decision_actor: 'local-owner', subject_digest: HASH });
      expect(f.db.prepare('SELECT run_id, source FROM run_dispatch_intents WHERE id = ?').get('intent-p051-1'))
        .toEqual({ run_id: f.runId, source: 'start' });
      expect(f.db.prepare('SELECT status, input_ref, exit_code FROM attempts WHERE id = ?').get('attempt-p051-1'))
        .toEqual({ status: 'succeeded', input_ref: f.artifactId, exit_code: 0 });
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get()).toEqual({ n: 0 });
    } finally {
      f.cleanup();
    }
  });

  it('[case:ownership-fks] 跨项目/跨 Phase/跨 Feature 归属由复合外键真实拒绝', async () => {
    const f = await openFixture();
    try {
      const count = (): number => (f.db.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get() as { n: number }).n;
      f.insertContext();
      expect(count()).toBe(1);
      // 跨项目：project_id 指向另一项目（Phase/Feature/Run/Task 归属同时错位）。
      expect(() => f.insertContext({ project_id: f.otherProjectId }, 'cand-x-1')).toThrow(/FOREIGN KEY|constraint/i);
      // 跨项目 Phase（同项目但 Phase 属于其他项目在 FK 层由 (project_id, phase_id) 冻结）。
      expect(() => f.insertContext({ phase_id: f.otherPhaseId }, 'cand-x-2')).toThrow(/FOREIGN KEY|constraint/i);
      // Feature 不属于声明的 (project, phase)。
      expect(() => f.insertContext({ feature_id: f.otherFeatureId }, 'cand-x-3')).toThrow(/FOREIGN KEY|constraint/i);
      // Run 不属于声明 Feature。
      expect(() => f.insertContext({ run_id: f.otherFeatureRunId }, 'cand-x-4')).toThrow(/FOREIGN KEY|constraint/i);
      // planning Task 不属于声明 Feature。
      expect(() => f.insertContext({ planning_task_id: f.otherFeatureTaskId }, 'cand-x-5')).toThrow(/FOREIGN KEY|constraint/i);
      // 候选 Artifact 跨项目引用：上下文属于项目 B，Artifact 属于项目 A（FK 拒绝）。
      expect(() => f.insertContext({
        project_id: f.otherProjectId, phase_id: f.otherPhaseId, feature_id: f.otherFeatureId,
        run_id: f.otherFeatureRunId, planning_task_id: f.otherFeatureTaskId,
        candidate_artifact_id: f.artifactId, candidate_content_hash: HASH_B, candidate_digest: HASH_B,
        candidate_summary: '候选', status: 'candidate_published',
      }, 'cand-x-6')).toThrow(/FOREIGN KEY|constraint/i);
      // 同项目 Artifact 引用但 open 状态携带候选字段：候选形状 CHECK 拒绝（未生成时无伪造摘要）。
      expect(() => f.insertContext({ candidate_artifact_id: f.artifactId }, 'cand-x-7')).toThrow(/CHECK|constraint/i);
      expect(count()).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it('[case:unique-identity] 重复候选/同 Run 第二上下文/同 Feature 第二活动规划均被唯一索引拒绝', async () => {
    const f = await openFixture();
    try {
      f.insertContext();
      // 同项目同 candidateId 重复（单候选身份唯一）。
      expect(() => f.insertContext({}, f.candidateId)).toThrow(/UNIQUE|constraint/i);
      // 同 Run 第二个上下文（一 Run 一上下文）。
      expect(() => f.insertContext({}, 'cand-p051-2')).toThrow(/UNIQUE|constraint/i);
      // 同 Feature 第二个活动规划（即使换了 Run/候选）：重复规划归属唯一。
      // （runs_active_feature_unique 限制同 Feature 只有一个活动 Run，先让首个 Run 终态。）
      f.db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(f.runId);
      f.db.prepare('INSERT INTO runs (id, created_at, project_id, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, max_attempts_per_run, run_time_limit_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 3600000)')
        .run('run-p051-plan-1b', NOW_MS, f.projectId, NOW_MS, 'batch-p051-1', f.featureId, 'plan', JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 2 }), 'queued', HASH, 'work-run-p051-plan-1b');
      expect(() => f.insertContext({ run_id: 'run-p051-plan-1b' }, 'cand-p051-3')).toThrow(/UNIQUE|constraint/i);
      // 首个上下文终态（applied）后，同 Feature 允许发起新规划（部分唯一索引放行）。
      f.db.prepare(
        "UPDATE planning_contexts SET status = 'applied', candidate_artifact_id = ?, candidate_content_hash = ?, candidate_digest = ?, candidate_summary = '已应用', decision = 'approved', decided_at = ?, applied_revision = 2, applied_at = ?, updated_at = ? WHERE candidate_id = ?",
      ).run(f.artifactId, HASH_B, HASH_B, NOW_MS + 1, NOW_MS + 1, NOW_MS + 1, f.candidateId);
      expect(() => f.insertContext({ run_id: 'run-p051-plan-1b' }, 'cand-p051-4')).not.toThrow();
      expect((f.db.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get() as { n: number }).n).toBe(2);
    } finally {
      f.cleanup();
    }
  });

  it('[case:status-and-shape-checks] 非法状态/摘要/候选形状/决策一致性由 CHECK 拒绝', async () => {
    const f = await openFixture();
    try {
      const count = (): number => (f.db.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get() as { n: number }).n;
      // 非法状态枚举。
      expect(() => f.insertContext({ status: 'draft' }, 'cand-s-1')).toThrow(/CHECK|constraint/i);
      expect(() => f.insertContext({ status: 'published' }, 'cand-s-2')).toThrow(/CHECK|constraint/i);
      // 非法摘要形状。
      expect(() => f.insertContext({ input_digest: 'XYZ' }, 'cand-s-3')).toThrow(/CHECK|constraint/i);
      expect(() => f.insertContext({ plan_digest: 'ab' }, 'cand-s-4')).toThrow(/CHECK|constraint/i);
      expect(() => f.insertContext({ target_revision: 0 }, 'cand-s-5')).toThrow(/CHECK|constraint/i);
      // open 携带候选事实（未生成时不得伪造内容摘要）。
      expect(() => f.insertContext({ candidate_digest: HASH_B }, 'cand-s-6')).toThrow(/CHECK|constraint/i);
      expect(() => f.insertContext({ candidate_summary: '伪造' }, 'cand-s-7')).toThrow(/CHECK|constraint/i);
      // candidate_published 候选事实不齐备。
      expect(() => f.insertContext({ status: 'candidate_published', candidate_digest: HASH_B }, 'cand-s-8')).toThrow(/CHECK|constraint/i);
      expect(() => f.insertContext({ status: 'candidate_published', candidate_artifact_id: f.artifactId, candidate_content_hash: HASH_B, candidate_digest: HASH_B, candidate_summary: '' }, 'cand-s-9')).toThrow(/CHECK|constraint/i);
      // 决策一致性：approved 必须有应用关联；rejected 不得有；open 不得有决策。
      expect(() => f.insertContext({
        status: 'candidate_published', candidate_artifact_id: f.artifactId, candidate_content_hash: HASH_B,
        candidate_digest: HASH_B, candidate_summary: '候选', decision: 'approved', decided_at: NOW_MS,
      }, 'cand-s-10')).toThrow(/CHECK|constraint/i);
      expect(() => f.insertContext({
        status: 'candidate_published', candidate_artifact_id: f.artifactId, candidate_content_hash: HASH_B,
        candidate_digest: HASH_B, candidate_summary: '候选', decision: 'rejected', decided_at: NOW_MS,
        applied_revision: 2,
      }, 'cand-s-11')).toThrow(/CHECK|constraint/i);
      expect(() => f.insertContext({ decision: 'approved', decided_at: NOW_MS }, 'cand-s-12')).toThrow(/CHECK|constraint/i);
      // 空白决策原因。
      expect(() => f.insertContext({ decision_reason: '' }, 'cand-s-13')).toThrow(/CHECK|constraint/i);
      expect(count()).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it('[case:write-once-triggers] 身份不可变与候选/决策写一次由触发器拒绝', async () => {
    const f = await openFixture();
    try {
      f.insertContext();
      const byCandidate = f.db.prepare('SELECT id FROM planning_contexts WHERE candidate_id = ?').get(f.candidateId) as { id: string };
      // 身份列不可变（candidateId/inputDigest/targetRevision/planDigest/绑定关系）。
      expect(() => f.db.prepare('UPDATE planning_contexts SET candidate_id = ? WHERE id = ?').run('cand-mut-1', byCandidate.id)).toThrow(/immutable/i);
      expect(() => f.db.prepare('UPDATE planning_contexts SET input_digest = ? WHERE id = ?').run(HASH_B, byCandidate.id)).toThrow(/immutable/i);
      expect(() => f.db.prepare('UPDATE planning_contexts SET target_revision = 5 WHERE id = ?').run(byCandidate.id)).toThrow(/immutable/i);
      expect(() => f.db.prepare('UPDATE planning_contexts SET plan_digest = NULL WHERE id = ?').run(byCandidate.id)).toThrow(/immutable/i);
      expect(() => f.db.prepare('UPDATE planning_contexts SET run_id = ? WHERE id = ?').run(f.otherFeatureRunId, byCandidate.id)).toThrow(/immutable/i);
      // updated_at 不得回退。
      expect(() => f.db.prepare('UPDATE planning_contexts SET updated_at = ? WHERE id = ?').run(NOW_MS - 1, byCandidate.id)).toThrow(/immutable/i);
      // 发布（合法迁移：候选 NULL → 值）后，候选绑定不可再改或清除。
      f.db.prepare(
        "UPDATE planning_contexts SET status = 'candidate_published', candidate_artifact_id = ?, candidate_content_hash = ?, candidate_digest = ?, candidate_summary = ?, updated_at = ? WHERE id = ?",
      ).run(f.artifactId, HASH_B, HASH_B, '候选摘要', NOW_MS + 1, byCandidate.id);
      expect(() => f.db.prepare('UPDATE planning_contexts SET candidate_summary = ? WHERE id = ?').run('改写摘要', byCandidate.id)).toThrow(/write-once/i);
      expect(() => f.db.prepare('UPDATE planning_contexts SET candidate_digest = ? WHERE id = ?').run(HASH, byCandidate.id)).toThrow(/write-once/i);
      expect(() => f.db.prepare('UPDATE planning_contexts SET candidate_summary = NULL WHERE id = ?').run(byCandidate.id)).toThrow(/write-once/i);
      // 决策写入后不可改写。
      f.db.prepare(
        "UPDATE planning_contexts SET status = 'rejected', decision = 'rejected', decision_reason = '范围不符', decided_at = ?, updated_at = ? WHERE id = ?",
      ).run(NOW_MS + 2, NOW_MS + 2, byCandidate.id);
      // 改写决策先被写一次触发器拦截（BEFORE UPDATE 先于 CHECK）。
      expect(() => f.db.prepare("UPDATE planning_contexts SET decision = 'approved' WHERE id = ?").run(byCandidate.id)).toThrow(/write-once|CHECK|constraint/i);
      f.db.prepare('UPDATE planning_contexts SET updated_at = ? WHERE id = ?').run(NOW_MS + 3, byCandidate.id);
      expect(() => f.db.prepare('UPDATE planning_contexts SET decision_reason = ? WHERE id = ?').run('改写原因', byCandidate.id)).toThrow(/write-once/i);
      expect(() => f.db.prepare('UPDATE planning_contexts SET decided_at = NULL WHERE id = ?').run(byCandidate.id)).toThrow(/write-once/i);
    } finally {
      f.cleanup();
    }
  });
});
