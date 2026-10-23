/**
 * P05-1 / F-002 规划上下文窄存储原语与 planning Task 隔离（真实临时 SQLite）。
 *
 * 覆盖（对应验收标准 1/3/4/5）：
 * - 创建：同一写事务内创建 planning Task（tasks.kind='planning'，冻结 planner
 *   用途策略副本）与规划上下文（绑定 Project/Phase/Feature/规划 Run/candidateId/
 *   inputDigest/目标 revision/计划摘要；候选未生成时无伪造内容摘要）；
 * - 隔离：planning Task 排除于业务计划视图/执行预览编码范围与业务 Task 列表；
 *   计划修订（应用候选路径）不删除 planning Task、保留其身份；业务 Task 与
 *   planning Task 身份冲突即拒绝（不覆盖）；
 * - 重开数据库后关联与副本一致；默认配置变化不追溯改写已冻结副本；
 * - 发布/决策状态机：发布绑定 ready Artifact；同身份重放复用、异身份冲突；
 *   批准必须携带应用后 revision；拒绝保留原因；非法迁移/重复决策 conflict；
 * - 失败矩阵：目标依据不一致、Run 用途/归属不符、跨项目 ownership、唯一冲突、
 *   事务回滚无半条记录、损坏持久 JSON 明确 corrupt 报错。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqlitePlanningContextStore } from '../../../packages/core/src/adapters/sqlite/planning-context-store.ts';
import { createSqlitePlanAccess } from '../../../packages/core/src/adapters/sqlite/plan-store.ts';
import { selectPlanningPurposeStrategy } from '../../../packages/core/src/application/task-strategy-selection.ts';
import { PLANNING_TASK_KIND } from '../../../packages/core/src/ports/planning-candidates.ts';
import type { PlanningContextRecord } from '../../../packages/core/src/ports/planning-context.ts';
import { StorageError, isStorageError } from '../../../packages/core/src/ports/errors.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW_MS = 1_700_600_000_000;
const HASH = 'ab'.repeat(32);
const HASH_B = 'cd'.repeat(32);
const GLOBAL_PAYLOAD_V1 = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
    purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus' } },
  },
};

interface Fixture {
  readonly session: SqliteStorageSession;
  readonly dbPath: string;
  readonly projectId: string;
  readonly otherProjectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly feature2Id: string;
  readonly feature2PhaseId: string;
  readonly feature2RunId: string;
  readonly featureRevision: number;
  readonly featurePlanDigest: string;
  readonly runId: string;
  readonly otherProjectRunId: string;
  readonly executeRunId: string;
  readonly artifactId: string;
  readonly candidateId: string;
  readonly strategy: ReturnType<typeof selectPlanningPurposeStrategy>;
  createInput(overrides?: Record<string, unknown>, candidate?: string): Record<string, unknown>;
  create(candidateId?: string, overrides?: Record<string, unknown>): PlanningContextRecord;
  readonly store: ReturnType<typeof createSqlitePlanningContextStore>;
  readonly plans: ReturnType<typeof createSqlitePlanAccess>;
  reopen(): void;
  cleanup(): void;
}

async function openFixture(): Promise<Fixture> {
  const sandbox = createTempSandbox('shiploop-p05-1-f002-store-');
  const dbPath = join(sandbox.path, 'state.db');
  let session = openSqliteStorageSession({ path: dbPath });
  try {
    await migrateSqliteStorage(session, { nowUtcMs: () => NOW_MS });
  } catch (error) {
    session.close();
    sandbox.cleanup();
    throw error;
  }
  const db = session.database;
  const projectId = 'proj-p051-s';
  const otherProjectId = 'proj-p051-t';
  const phaseId = 'phase-p051-s';
  const featureId = 'feat-p051-s';
  /** 同项目第二个 Feature：供同 Feature 活动规划唯一以外的创建/回滚用例。 */
  const feature2Id = 'feat-p051-s2';
  const feature2RunId = 'run-p051-b-1';
  const runId = 'run-p051-s-1';
  const otherProjectRunId = 'run-p051-t-1';
  const executeRunId = 'run-p051-s-exec';
  const artifactId = 'art-p051-s-1';
  const candidateId = 'cand-p051-s-1';

  db.prepare('INSERT INTO projects (id, created_at, revision, updated_at, display_name, status) VALUES (?, ?, 1, ?, ?, ?)')
    .run(projectId, NOW_MS, NOW_MS, '规划项目', 'active');
  db.prepare('INSERT INTO projects (id, created_at, revision, updated_at, display_name, status) VALUES (?, ?, 1, ?, ?, ?)')
    .run(otherProjectId, NOW_MS, NOW_MS, '另一项目', 'active');
  db.prepare('INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, ?, ?, ?, ?)')
    .run(phaseId, NOW_MS, projectId, NOW_MS, '阶段');
  db.prepare('INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, plan_digest, source_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(featureId, NOW_MS, projectId, NOW_MS, phaseId, 'Feature', HASH, '[]');
  // 既有业务 Task（coding）：修订保留/移除划分只作用于 coding 成员。
  db.prepare(
    'INSERT INTO tasks (id, created_at, project_id, updated_at, feature_id, title, acceptance, execution_config, config_source, config_source_key, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('biz-1', NOW_MS, projectId, NOW_MS, featureId, '业务任务一', JSON.stringify({ criteria: ['验收一'] }),
    JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }),
    'project_default', 'defaultStrategy', 'coding');

  const insertBatch = (id: string, project: string, phase: string, feature: string): void => {
    db.prepare(
      'INSERT INTO execution_batches (id, created_at, project_id, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(id, NOW_MS, project, NOW_MS, phase, feature,
      JSON.stringify({ schemaVersion: 1, featureIds: [feature] }), JSON.stringify({ schemaVersion: 2 }), 'queued',
      JSON.stringify({ schemaVersion: 1, batch: { maxRuns: 2 }, run: { maxAttemptsPerRun: 2, runTimeLimitMs: 3_600_000 } }),
      NOW_MS + 3_600_000);
  };
  insertBatch('batch-p051-s', projectId, phaseId, featureId);
  // 同项目第二个 Phase+Feature（execution_batches 每 Phase 唯一）：供同 Feature
  // 活动规划唯一以外的创建/回滚用例。
  db.prepare('INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, ?, ?, ?, ?)')
    .run('phase-p051-s2', NOW_MS, projectId, NOW_MS, '阶段二');
  db.prepare('INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, source_refs) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(feature2Id, NOW_MS, projectId, NOW_MS, 'phase-p051-s2', 'Feature 二', '[]');
  insertBatch('batch-p051-s2', projectId, 'phase-p051-s2', feature2Id);
  db.prepare('INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, ?, ?, ?, ?)')
    .run('phase-p051-t', NOW_MS, otherProjectId, NOW_MS, '另一阶段');
  db.prepare('INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, source_refs) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('feat-p051-t', NOW_MS, otherProjectId, NOW_MS, 'phase-p051-t', '另一Feature', '[]');
  insertBatch('batch-p051-t', otherProjectId, 'phase-p051-t', 'feat-p051-t');
  const insertRun = (id: string, project: string, feature: string, batch: string, purpose: string, status = 'queued'): void => {
    db.prepare(
      'INSERT INTO runs (id, created_at, project_id, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, max_attempts_per_run, run_time_limit_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 3600000)',
    ).run(id, NOW_MS, project, NOW_MS, batch, feature, purpose,
      JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 2 }), status, HASH, `work-${id}`);
  };
  insertRun(runId, projectId, featureId, 'batch-p051-s', 'plan');
  insertRun(executeRunId, projectId, featureId, 'batch-p051-s', 'execute', 'failed');
  insertRun(feature2RunId, projectId, feature2Id, 'batch-p051-s2', 'plan');
  insertRun(otherProjectRunId, otherProjectId, 'feat-p051-t', 'batch-p051-t', 'plan');
  // 候选 Artifact（ready）。
  db.prepare(
    'INSERT INTO artifacts (id, created_at, revision, updated_at, project_id, kind, status, media_type, expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(artifactId, NOW_MS, NOW_MS, projectId, 'plan-candidate', 'ready', 'application/json', HASH_B, HASH_B, 256, 'projects/x/artifacts/art-p051-s-1');
  // 全局配置（planner 用途策略来源；重开后用于默认配置变化非追溯验证）。
  db.prepare('INSERT INTO global_settings (id, created_at, updated_at, revision, schema_version, payload) VALUES (?, ?, ?, 1, 2, ?)')
    .run('global', NOW_MS, NOW_MS, JSON.stringify(GLOBAL_PAYLOAD_V1));

  const featureRow = db.prepare('SELECT revision, plan_digest FROM features WHERE id = ?').get(featureId) as { revision: number; plan_digest: string };
  const strategy = selectPlanningPurposeStrategy({
    global: { scopeRevision: 1, payload: GLOBAL_PAYLOAD_V1 },
  });

  const makeStore = () => createSqlitePlanningContextStore(session, { nowUtcMs: () => NOW_MS });
  const makePlans = () => createSqlitePlanAccess(session, { nowUtcMs: () => NOW_MS });
  let store = makeStore();
  let plans = makePlans();

  const createInput = (overrides: Record<string, unknown> = {}, candidate = candidateId): Record<string, unknown> => ({
    projectId,
    phaseId,
    featureId,
    runId,
    candidateId: candidate,
    inputDigest: HASH,
    targetRevision: featureRow.revision,
    planDigest: featureRow.plan_digest,
    planningTask: {
      title: '一次性规划',
      description: '生成候选计划',
      acceptance: { criteria: ['候选通过结构校验'] },
      requirementsRefs: [],
    },
    strategy: strategy.strategy,
    strategySource: { configSource: strategy.configSource, configSourceKey: strategy.configSourceKey },
    ...overrides,
  });

  const create = (candidate = candidateId, overrides: Record<string, unknown> = {}) =>
    session.transactWrite('test.planning.create', () =>
      store.createPlanningContextInTransaction(createInput(overrides, candidate)));

  const cleanup = (): void => {
    session.close();
    sandbox.cleanup();
  };
  const reopen = (): void => {
    session.close();
    session = openSqliteStorageSession({ path: dbPath });
    store = makeStore();
    plans = makePlans();
  };

  return {
    get session() { return session; },
    get store() { return store; },
    get plans() { return plans; },
    dbPath, projectId, otherProjectId, phaseId, featureId, feature2Id, feature2PhaseId: 'phase-p051-s2', feature2RunId,
    featureRevision: featureRow.revision, featurePlanDigest: featureRow.plan_digest as string,
    runId, otherProjectRunId, executeRunId, artifactId, candidateId, strategy,
    createInput, create, reopen, cleanup,
  };
}

describe('P05-1 F-002 planning context store', () => {
  it('[case:create-binds-context-and-task] 创建在同一事务内绑定 planning Task 与用途策略副本', async () => {
    const f = await openFixture();
    try {
      const created = f.create();
      expect(created.status).toBe('open');
      expect(created.candidateId).toBe(f.candidateId);
      expect(created.runId).toBe(f.runId);
      expect(created.inputDigest).toBe(HASH);
      expect(created.targetRevision).toBe(f.featureRevision);
      expect(created.planDigest).toBe(f.featurePlanDigest);
      // 未生成候选：无伪造内容摘要。
      expect(created.candidateArtifactRef).toBeNull();
      expect(created.candidateDigest).toBeNull();
      expect(created.candidateSummary).toBeNull();
      expect(created.decision).toBeNull();
      expect(created.appliedRevision).toBeNull();
      // planning Task 快照：kind=planning + 冻结策略副本与来源。
      expect(created.planningTask.kind).toBe(PLANNING_TASK_KIND);
      expect(created.planningTask.executionConfig).toEqual(f.strategy.strategy);
      expect(created.planningTask.configSource).toBe('global_default');
      expect(created.planningTask.configSourceKey).toBe('purposeStrategies.planner');
      // 持久行核对：planning Task 行真实存在且不覆盖业务 Task。
      const taskRow = f.session.database
        .prepare('SELECT kind, status, execution_config, config_source, config_source_key FROM tasks WHERE id = ?')
        .get(created.planningTaskId) as Record<string, unknown>;
      expect(taskRow['kind']).toBe('planning');
      expect(taskRow['status']).toBe('pending');
      expect(JSON.parse(taskRow['execution_config'] as string)).toEqual(f.strategy.strategy);
      // 与业务 Task 身份不冲突。
      expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ? AND kind = ?').all(f.featureId, 'coding')).toEqual([{ n: 1 }]);
    } finally {
      f.cleanup();
    }
  });

  it('[case:reopen-consistency] 重开数据库后关联与策略副本一致；默认配置变化不追溯改写副本', async () => {
    const f = await openFixture();
    try {
      const created = f.create();
      // 默认配置变化（planner 模型改变）+ 重开数据库。
      f.session.database.prepare('UPDATE global_settings SET payload = ? WHERE id = ?').run(
        JSON.stringify({
          schemaVersion: 2,
          strategies: { purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus-2' } } },
        }),
        'global',
      );
      f.reopen();
      const byCandidate = f.store.getPlanningContextByCandidate(f.projectId, f.candidateId);
      const byRun = f.store.getPlanningContextByRun(f.projectId, f.runId);
      expect(byCandidate).not.toBeNull();
      expect(byRun).not.toBeNull();
      expect(byRun).toEqual(created);
      // 副本仍为创建时冻结的 planner 条目，未被新默认配置改写。
      expect(byCandidate?.planningTask.executionConfig).toEqual(f.strategy.strategy);
      expect(byCandidate?.planningTask.executionConfig.model).toBe('claude-opus');
      // 查询面：不存在的候选/Run 返回 null。
      expect(f.store.getPlanningContextByCandidate(f.projectId, 'cand-missing-1')).toBeNull();
      expect(f.store.getPlanningContextByRun(f.projectId, f.executeRunId)).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it('[case:planning-task-isolation] planning Task 排除于业务计划视图/预览范围/Task 列表；修订不删除 planning Task', async () => {
    const f = await openFixture();
    try {
      const created = f.create();
      // 业务计划视图与执行输入/预览视图只含 coding 成员。
      const planView = f.plans.readFeaturePlanView(f.featureId);
      expect(planView?.tasks.map((task) => task.id)).toEqual(['biz-1']);
      const prepView = f.plans.readExecutionInputPreparationView(f.projectId, f.featureId);
      expect(prepView?.tasks.map((task) => task.id)).toEqual(['biz-1']);
      const previewView = f.plans.readExecutionPreviewView(f.projectId, f.featureId);
      expect(previewView?.tasks.map((task) => task.id)).toEqual(['biz-1']);
      const taskPage = f.plans.listTaskRecords({ kind: 'all' }, f.projectId, f.featureId, { afterId: null, limit: 50 });
      expect(taskPage.records.map((task) => task.id)).toEqual(['biz-1']);

      // 计划修订（应用候选的导入路径）：planning Task 不参与成员划分且不被删除。
      const revision = (f.session.database.prepare('SELECT revision FROM features WHERE id = ?').get(f.featureId) as { revision: number }).revision;
      const replaced = f.session.transactWrite('test.plan.replace', () =>
        f.plans.replaceFeaturePlanInTransaction({
          projectId: f.projectId,
          featureId: f.featureId,
          expectedRevision: revision,
          feature: {
            title: 'Feature', description: null, labels: [], sourceRefs: [],
            planDigest: HASH_B, planStatus: 'pending_approval',
          },
          tasks: [
            {
              id: 'biz-1', title: '业务任务一（修订）', description: null, labels: [], complexity: 'low',
              acceptance: { criteria: ['验收一'] }, requirementsRefs: [],
              executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
              configSource: 'project_default', configSourceKey: 'defaultStrategy',
            },
            {
              id: 'biz-2', title: '业务任务二', description: null, labels: [], complexity: null,
              acceptance: { criteria: ['验收二'] }, requirementsRefs: [],
              executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
              configSource: 'project_default', configSourceKey: 'defaultStrategy',
            },
          ],
          dependencies: [{ taskId: 'biz-2', dependsOnId: 'biz-1' }],
        }));
      expect(replaced.removedTaskIds).toEqual([]);
      expect(replaced.keptTaskIds).toEqual(['biz-1']);
      expect(replaced.createdTaskIds).toEqual(['biz-2']);
      // 替换结果与业务视图只含 coding 成员；planning Task 行保留。
      expect(replaced.tasks.map((task) => task.id).sort()).toEqual(['biz-1', 'biz-2']);
      const planningRow = f.session.database
        .prepare('SELECT kind FROM tasks WHERE id = ?').get(created.planningTaskId) as { kind: string };
      expect(planningRow.kind).toBe('planning');
      expect(f.plans.readFeaturePlanView(f.featureId)?.tasks.map((task) => task.id)).toEqual(['biz-1', 'biz-2']);

      // 业务 Task 与 planning Task 身份冲突即拒绝（不覆盖）。
      const revisionAfter = (f.session.database.prepare('SELECT revision FROM features WHERE id = ?').get(f.featureId) as { revision: number }).revision;
      expect(() =>
        f.session.transactWrite('test.plan.replace.clash', () =>
          f.plans.replaceFeaturePlanInTransaction({
            projectId: f.projectId,
            featureId: f.featureId,
            expectedRevision: revisionAfter,
            feature: { title: 'Feature', description: null, labels: [], sourceRefs: [], planDigest: HASH_B, planStatus: 'pending_approval' },
            tasks: [
              {
                id: created.planningTaskId, title: '冒充规划任务', description: null, labels: [], complexity: null,
                acceptance: { criteria: ['x'] }, requirementsRefs: [],
                executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
                configSource: 'project_default', configSourceKey: 'defaultStrategy',
              },
            ],
            dependencies: [],
          })),
      ).toThrow(StorageError);
      // planning Task 行未被改写。
      expect((f.session.database.prepare('SELECT kind, title FROM tasks WHERE id = ?').get(created.planningTaskId) as { kind: string; title: string }).title).toBe('一次性规划');
    } finally {
      f.cleanup();
    }
  });

  it('[case:create-guards] 目标依据/Run 用途/归属不符与非法输入明确失败', async () => {
    const f = await openFixture();
    try {
      const expectStorageError = (run: () => unknown, kind: string): void => {
        try {
          run();
          expect.unreachable(`expected ${kind} error`);
        } catch (error) {
          expect(isStorageError(error)).toBe(true);
          expect((error as StorageError).kind).toBe(kind);
        }
      };
      // 目标 revision 不一致。
      expectStorageError(() => f.create('cand-g-1', { targetRevision: f.featureRevision + 5 }), 'conflict');
      // 目标计划摘要不一致。
      expectStorageError(() => f.create('cand-g-2', { planDigest: HASH_B }), 'conflict');
      // Feature 不属于声明 Phase。
      expectStorageError(() => f.create('cand-g-3', { phaseId: 'phase-p051-t' }), 'conflict');
      // Run 用途不是 plan。
      expectStorageError(() => f.create('cand-g-4', { runId: f.executeRunId }), 'conflict');
      // 跨项目 Run。
      expectStorageError(() => f.create('cand-g-5', { runId: f.otherProjectRunId }), 'ownership');
      // Feature 缺失。
      expectStorageError(() => f.create('cand-g-6', { featureId: 'feat-missing-1' }), 'not_found');
      // 非法输入：摘要形状 / 策略副本不完整 / 未知键。
      expectStorageError(() => f.create('cand-g-7', { inputDigest: 'zz' }), 'validation');
      expectStorageError(() => f.create('cand-g-8', { strategy: { schemaVersion: 2, runtime: 'pi' } }), 'validation');
      expectStorageError(() => f.create('cand-g-9', { model: 'claude-x' }), 'validation');
      // 策略来源未知词汇。
      expectStorageError(() => f.create('cand-g-10', { strategySource: { configSource: 'user_override', configSourceKey: 'userOverride' } }), 'validation');
      // 写原语必须在写事务内调用。
      expect(() => f.store.createPlanningContextInTransaction(f.createInput())).toThrow(TypeError);
      // 以上全部失败后无任何半条记录。
      expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get()).toEqual({ n: 0 });
      expect(f.session.database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'planning'").get()).toEqual({ n: 0 });
    } finally {
      f.cleanup();
    }
  });

  it('[case:transaction-rollback] 创建中途失败整组回滚（无孤儿 planning Task/上下文）', async () => {
    const f = await openFixture();
    try {
      f.create();
      const tasksBefore = (f.session.database.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
      // 同候选重复创建：planning Task 插入成功后上下文唯一约束失败 → 整个事务回滚。
      expect(() => f.create()).toThrow(StorageError);
      expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: tasksBefore });
      expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get()).toEqual({ n: 1 });
      // 事务内显式失败同样回滚（调用方组合更多原语时的同一保障；用另一 Feature
      // 避开同 Feature 活动规划唯一）。
      expect(() =>
        f.session.transactWrite('test.planning.rollback', () => {
          f.store.createPlanningContextInTransaction({
            ...f.createInput({}, 'cand-rb-1'), featureId: f.feature2Id, phaseId: f.feature2PhaseId, runId: f.feature2RunId, planDigest: null,
          });
          throw new Error('caller failure');
        }),
      ).toThrow('caller failure');
      expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: tasksBefore });
      expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get()).toEqual({ n: 1 });
    } finally {
      f.cleanup();
    }
  });

  it('[case:publish-and-decide] 发布绑定与人工决策状态机（重放/非法迁移）', async () => {
    const f = await openFixture();
    try {
      const created = f.create();
      const publish = (overrides: Record<string, unknown> = {}) =>
        f.session.transactWrite('test.planning.publish', () =>
          f.store.publishPlanningCandidateInTransaction({
            projectId: f.projectId, candidateId: f.candidateId, candidateDigest: HASH_B,
            artifactId: f.artifactId, contentHash: HASH_B, summary: '候选计划摘要',
            ...overrides,
          }));
      const decide = (overrides: Record<string, unknown> = {}) =>
        f.session.transactWrite('test.planning.decide', () =>
          f.store.decidePlanningCandidateInTransaction({
            projectId: f.projectId, candidateId: f.candidateId, decision: 'rejected',
            reason: '范围不符', appliedRevision: null, ...overrides,
          }));

      // 未发布不得决策。
      expect(() => decide()).toThrow(StorageError);
      // Artifact 未就绪/摘要不符拒绝。
      f.session.database.prepare("UPDATE artifacts SET status = 'pending' WHERE id = ?").run(f.artifactId);
      expect(() => publish()).toThrow(StorageError);
      f.session.database.prepare("UPDATE artifacts SET status = 'ready', content_hash = ? WHERE id = ?").run(HASH, f.artifactId);
      expect(() => publish()).toThrow(StorageError);
      f.session.database.prepare('UPDATE artifacts SET content_hash = ? WHERE id = ?').run(HASH_B, f.artifactId);

      // 发布成功：候选事实齐备、状态迁移。
      const published = publish();
      expect(published.outcome).toBe('published');
      expect(published.context.status).toBe('candidate_published');
      expect(published.context.candidateArtifactRef).toEqual({ artifactId: f.artifactId, contentHash: HASH_B });
      expect(published.context.candidateDigest).toBe(HASH_B);
      expect(published.context.candidateSummary).toBe('候选计划摘要');
      // 同身份重放复用（稳定重放），不产生第二行/不改写。
      expect(publish()).toMatchObject({ outcome: 'reused' });
      // 异身份重放冲突（单候选）。
      expect(() => publish({ summary: '另一个摘要' })).toThrow(StorageError);
      expect(() => publish({ candidateDigest: HASH })).toThrow(StorageError);

      // 决策：拒绝保留原因；批准必须携带应用后 revision。
      expect(() => decide({ decision: 'approved', reason: null, appliedRevision: null })).toThrow(StorageError);
      const rejected = decide();
      expect(rejected.status).toBe('rejected');
      expect(rejected.decision).toBe('rejected');
      expect(rejected.decisionReason).toBe('范围不符');
      expect(rejected.appliedRevision).toBeNull();
      expect(rejected.appliedAtUtcMs).toBeNull();
      // 终态不可再决策/再发布。
      expect(() => decide({ decision: 'approved', appliedRevision: 3 })).toThrow(StorageError);
      expect(() => publish()).toThrow(StorageError);
      // 决策后重开数据库：决策与候选关联仍一致。
      f.reopen();
      const afterReopen = f.store.getPlanningContextByCandidate(f.projectId, f.candidateId);
      expect(afterReopen?.status).toBe('rejected');
      expect(afterReopen?.candidateDigest).toBe(HASH_B);
      expect(afterReopen?.decisionReason).toBe('范围不符');

      // 批准路径：新规划（先终态旧 Run 释放活动 Run 唯一）→ 发布 → 批准应用关联。
      f.session.database.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(f.runId);
      f.session.database.prepare(
        'INSERT INTO runs (id, created_at, project_id, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, max_attempts_per_run, run_time_limit_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 3600000)',
      ).run('run-p051-s-2', NOW_MS, f.projectId, NOW_MS, 'batch-p051-s', f.featureId, 'plan',
        JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 2 }), 'queued', HASH, 'work-run-p051-s-2');
      const approvedContext = f.session.transactWrite('test.planning.create.2', () =>
        f.store.createPlanningContextInTransaction({
          ...f.createInput({}, 'cand-p051-s-2'), runId: 'run-p051-s-2',
        }));
      // 首个上下文已 rejected（非活动），同 Feature 新规划归属唯一放行。
      expect(approvedContext.status).toBe('open');
      f.session.transactWrite('test.planning.publish.2', () =>
        f.store.publishPlanningCandidateInTransaction({
          projectId: f.projectId, candidateId: 'cand-p051-s-2', candidateDigest: HASH_B,
          artifactId: f.artifactId, contentHash: HASH_B, summary: '第二个候选',
        }));
      const applied = f.session.transactWrite('test.planning.decide.2', () =>
        f.store.decidePlanningCandidateInTransaction({
          projectId: f.projectId, candidateId: 'cand-p051-s-2', decision: 'approved',
          reason: null, appliedRevision: 2,
        }));
      expect(applied.status).toBe('applied');
      expect(applied.decision).toBe('approved');
      expect(applied.appliedRevision).toBe(2);
      expect(applied.appliedAtUtcMs).not.toBeNull();
      expect(applied.decidedAtUtcMs).not.toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it('[case:corrupt-persisted-json] 损坏持久 JSON/枚举明确 corrupt 报错（不返回伪记录）', async () => {
    const f = await openFixture();
    try {
      const created = f.create();
      // 策略副本 JSON 合法但语义损坏（缺 provider/model）。
      f.session.database.prepare('UPDATE tasks SET execution_config = ? WHERE id = ?')
        .run(JSON.stringify({ schemaVersion: 2, runtime: 'pi' }), created.planningTaskId);
      expect(() => f.store.getPlanningContextByCandidate(f.projectId, f.candidateId)).toThrow(StorageError);
      try {
        f.store.getPlanningContextByCandidate(f.projectId, f.candidateId);
      } catch (error) {
        expect(isStorageError(error)).toBe(true);
        expect((error as StorageError).kind).toBe('corrupt');
      }
      // 恢复合法副本后改为绑定 Task kind 漂移。
      f.session.database.prepare('UPDATE tasks SET execution_config = ? WHERE id = ?')
        .run(JSON.stringify(f.strategy.strategy), created.planningTaskId);
      f.session.database.prepare("UPDATE tasks SET kind = 'coding' WHERE id = ?").run(created.planningTaskId);
      expect(() => f.store.getPlanningContextByRun(f.projectId, f.runId)).toThrow(StorageError);
    } finally {
      f.cleanup();
    }
  });

  it('[case:ids-are-unique-per-create] planning Task/上下文身份由存储生成且不与业务 Task 冲突', async () => {
    const f = await openFixture();
    try {
      const first = f.create();
      // 另一 Feature 上的第二次创建（同 Feature 活动唯一不妨碍其他 Feature）。
      const second = f.session.transactWrite('test.planning.create.3', () =>
        f.store.createPlanningContextInTransaction({
          ...f.createInput({}, 'cand-p051-s-3'), featureId: f.feature2Id, phaseId: f.feature2PhaseId, runId: f.feature2RunId, planDigest: null,
        }));
      expect(second.planningTaskId).not.toBe(first.planningTaskId);
      expect(second.id).not.toBe(first.id);
      expect(second.candidateId).not.toBe(first.candidateId);
    } finally {
      f.cleanup();
    }
  });
});
