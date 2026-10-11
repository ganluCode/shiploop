/**
 * P03-1 / F-002 计划结构 SQLite 适配器（adapters 层）：phases/features/tasks/
 * task_dependencies 的同会话同步插入原语，供原子命令事务在同一 BEGIN IMMEDIATE
 * 内组合使用（ports/plan-store.ts 契约）。
 *
 * 不变量：
 * - 写原语只允许在写事务内调用（唯一事务由原子命令事务拥有）；事务内不执行
 *   文件流、SDK、Git、网络或长检查；
 * - 输入一律 unknown，先经 ports 校验器再持久化：校验失败发生在任何 SQL 之前，
 *   真实库中没有半条记录；
 * - 归属核验在同一事务内以绑定参数查询完成：项目/父级缺失 → not_found；
 *   跨项目父级、跨 Feature 依赖 → ownership；DDL 外键/复合外键作为防御纵深兜底
 *   （SQLITE_CONSTRAINT 映射为结构化错误，不泄漏 SQL 原文）；
 * - 重复身份/重复边以事务内存在性检查给出结构化 conflict（写入被串行化，无
 *   check-then-insert 竞争窗口），唯一索引兜底；
 * - 环检测在事务内加载同 Feature 既有边 + 新边后 DFS 复核（DDL 无法表达环约束）；
 * - Phase/Feature 稳定 ID 由适配器生成 UUID v4；Task 保留计划作者稳定 ID；
 *   时间为注入的 UTC 毫秒，创建 revision=1；JSON 列只写入经校验的结构化 JSON；
 * - 读取映射对持久 JSON 重新解析，损坏 JSON 以 kind='corrupt' 拒绝，不作为
 *   有效记录返回；不泄漏驱动会话或 ORM 类型。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import {
  assertNoDependencyCycle,
  validateCreateFeatureInput,
  validateCreatePhaseInput,
  validateCreateTaskDependencyInput,
  validateCreateTaskInput,
} from '../../ports/plan-store.js';
import type {
  FeatureRecord,
  PhaseRecord,
  TaskDependencyRecord,
  TaskRecord,
} from '../../ports/plan-store.js';
import type { PlanArtifactRef, PlanComplexity } from '../../ports/feature-plan.js';
import type { SqliteStorageSession } from './session.js';

export interface SqlitePlanStoreOptions {
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性时间。 */
  readonly nowUtcMs?: () => number;
}

interface PhaseSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly title: string;
  readonly status: string;
  readonly description: string | null;
  readonly labels: string;
}

interface FeatureSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly phase_id: string;
  readonly title: string;
  readonly status: string;
  readonly plan_status: string;
  readonly description: string | null;
  readonly labels: string;
  readonly source_refs: string;
  readonly plan_digest: string | null;
}

interface TaskSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly feature_id: string;
  readonly title: string;
  readonly status: string;
  readonly complexity: string | null;
  readonly description: string | null;
  readonly labels: string;
  readonly acceptance: string;
  readonly requirements_refs: string;
  readonly execution_config: string;
  readonly config_source: string;
  readonly config_source_key: string | null;
}

interface TaskDependencySqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly feature_id: string;
  readonly task_id: string;
  readonly depends_on_id: string;
}

const SELECT_PHASE =
  'SELECT id, created_at, project_id, revision, updated_at, title, status, description, labels FROM phases';
const SELECT_FEATURE =
  'SELECT id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, ' +
  'description, labels, source_refs, plan_digest FROM features';
const SELECT_TASK =
  'SELECT id, created_at, project_id, revision, updated_at, feature_id, title, status, complexity, ' +
  'description, labels, acceptance, requirements_refs, execution_config, config_source, config_source_key FROM tasks';
const SELECT_TASK_DEPENDENCY =
  'SELECT id, created_at, project_id, feature_id, task_id, depends_on_id FROM task_dependencies';

function isSqliteConstraintError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    ((error as { code?: unknown }).code as string).startsWith('SQLITE_CONSTRAINT')
  );
}

/** 同会话同步原语集合：供原子命令事务复用，绝不嵌套 Promise/事务。 */
export interface SqlitePlanAccess {
  insertPhaseInTransaction(input: unknown): PhaseRecord;
  insertFeatureInTransaction(input: unknown): FeatureRecord;
  insertTaskInTransaction(input: unknown): TaskRecord;
  insertTaskDependencyInTransaction(input: unknown): TaskDependencyRecord;
}

export function createSqlitePlanAccess(
  session: SqliteStorageSession,
  options: SqlitePlanStoreOptions = {},
): SqlitePlanAccess {
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
    }
  }

  function assertInTransaction(operation: string): void {
    if (!session.database.inTransaction) {
      throw new TypeError(`${operation}: 计划结构写原语必须位于写事务内（原子命令事务拥有唯一事务）`);
    }
  }

  function notFound(operation: string, entity: StorageEntityRef, message: string): StorageError {
    return new StorageError('not_found', operation, `${operation}: ${message}`, { entity });
  }

  function ownership(operation: string, entity: StorageEntityRef, message: string): StorageError {
    return new StorageError('ownership', operation, `${operation}: ${message}`, { entity });
  }

  function conflict(
    operation: string,
    message: string,
    entity: StorageEntityRef,
    details: Record<string, unknown>,
  ): StorageError {
    return new StorageError('conflict', operation, `${operation}: ${message}`, { entity, details });
  }

  function parseJsonColumn(text: string, operation: string, reason: string): unknown {
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new StorageError('corrupt', operation, `${operation}: 计划结构持久 JSON 列损坏`, {
        details: { reason },
        cause,
      });
    }
  }

  function parseLabels(text: string, operation: string): string[] {
    const parsed = parseJsonColumn(text, operation, 'invalid_labels_json');
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new StorageError('corrupt', operation, `${operation}: labels 列不是字符串数组`, {
        details: { reason: 'invalid_labels_json' },
      });
    }
    return parsed as string[];
  }

  function parseArtifactRefs(text: string, operation: string, reason: string): PlanArtifactRef[] {
    const parsed = parseJsonColumn(text, operation, reason);
    if (!Array.isArray(parsed)) {
      throw new StorageError('corrupt', operation, `${operation}: 引用列不是 JSON 数组`, {
        details: { reason },
      });
    }
    return parsed as PlanArtifactRef[];
  }

  /** 防御纵深：端口核验未命中时由 DDL（FK/复合外键/CHECK）兜底拒写，映射为结构化错误。 */
  function mapConstraintError(
    error: unknown,
    operation: string,
    entity: StorageEntityRef,
    kind: 'phase' | 'feature' | 'task' | 'task_dependency',
  ): StorageError {
    const code = isSqliteConstraintError(error) ? error.code : '';
    if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
      return conflict(operation, '重复身份或重复依赖边（唯一约束拒绝）', entity, {
        reason: `${kind}_already_exists`,
      });
    }
    return new StorageError('validation', operation, `${operation}: 输入违反存储约束（外键/CHECK 兜底）`, {
      entity,
      details: { reason: `${kind}_constraint_rejected`, sqliteCode: code },
      cause: error,
    });
  }

  /** 事务内项目存在性核验（绑定参数；缺失 → not_found）。 */
  function assertProjectExists(
    db: Database.Database,
    operation: string,
    projectId: string,
    entity: StorageEntityRef,
  ): void {
    const row = db
      .prepare<[string], { id: string }>('SELECT id FROM projects WHERE id = ?')
      .get(projectId);
    if (row === undefined) {
      throw notFound(operation, entity, `项目 ${projectId} 不存在`);
    }
  }

  function phaseFromRow(row: PhaseSqlRow): PhaseRecord {
    const operation = 'PlanStore.readPhase';
    if (row.status !== 'open' && row.status !== 'closed' && row.status !== 'archived') {
      throw new StorageError('corrupt', operation, 'phases.status 列不是合法枚举值', {
        entity: { type: 'phase', id: row.id },
        details: { reason: 'invalid_status' },
      });
    }
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      labels: parseLabels(row.labels, operation),
      status: row.status,
      revision: row.revision,
      createdAtUtcMs: row.created_at,
      updatedAtUtcMs: row.updated_at,
    };
  }

  function featureFromRow(row: FeatureSqlRow): FeatureRecord {
    const operation = 'PlanStore.readFeature';
    const featureStatuses = [
      'draft',
      'ready',
      'running',
      'awaiting_approval',
      'completed',
      'partial',
      'failed',
    ] as const;
    const planStatuses = ['draft', 'pending_approval', 'approved'] as const;
    if (!featureStatuses.includes(row.status as (typeof featureStatuses)[number])) {
      throw new StorageError('corrupt', operation, 'features.status 列不是合法枚举值', {
        entity: { type: 'feature', id: row.id },
        details: { reason: 'invalid_status' },
      });
    }
    if (!planStatuses.includes(row.plan_status as (typeof planStatuses)[number])) {
      throw new StorageError('corrupt', operation, 'features.plan_status 列不是合法枚举值', {
        entity: { type: 'feature', id: row.id },
        details: { reason: 'invalid_plan_status' },
      });
    }
    return {
      id: row.id,
      projectId: row.project_id,
      phaseId: row.phase_id,
      title: row.title,
      description: row.description,
      labels: parseLabels(row.labels, operation),
      status: row.status as (typeof featureStatuses)[number],
      planStatus: row.plan_status as (typeof planStatuses)[number],
      planDigest: row.plan_digest,
      sourceRefs: parseArtifactRefs(row.source_refs, operation, 'invalid_source_refs_json'),
      revision: row.revision,
      createdAtUtcMs: row.created_at,
      updatedAtUtcMs: row.updated_at,
    };
  }

  function taskFromRow(row: TaskSqlRow): TaskRecord {
    const operation = 'PlanStore.readTask';
    const taskStatuses = [
      'pending',
      'running',
      'passed',
      'failed',
      'skipped',
      'cancelled',
    ] as const;
    const complexityValues = ['low', 'medium', 'high'] as const;
    if (!taskStatuses.includes(row.status as (typeof taskStatuses)[number])) {
      throw new StorageError('corrupt', operation, 'tasks.status 列不是合法枚举值', {
        entity: { type: 'task', id: row.id },
        details: { reason: 'invalid_status' },
      });
    }
    if (
      row.complexity !== null &&
      !complexityValues.includes(row.complexity as (typeof complexityValues)[number])
    ) {
      throw new StorageError('corrupt', operation, 'tasks.complexity 列不是合法枚举值', {
        entity: { type: 'task', id: row.id },
        details: { reason: 'invalid_complexity' },
      });
    }
    const acceptance = parseJsonColumn(row.acceptance, operation, 'invalid_acceptance_json');
    if (
      typeof acceptance !== 'object' ||
      acceptance === null ||
      !Array.isArray((acceptance as { criteria?: unknown }).criteria) ||
      (acceptance as { criteria: unknown[] }).criteria.some((item) => typeof item !== 'string')
    ) {
      throw new StorageError('corrupt', operation, 'tasks.acceptance 列不是结构化验收对象', {
        entity: { type: 'task', id: row.id },
        details: { reason: 'invalid_acceptance_json' },
      });
    }
    const executionConfig = parseJsonColumn(row.execution_config, operation, 'invalid_execution_config_json');
    if (typeof executionConfig !== 'object' || executionConfig === null || Array.isArray(executionConfig)) {
      throw new StorageError('corrupt', operation, 'tasks.execution_config 列不是 JSON 对象', {
        entity: { type: 'task', id: row.id },
        details: { reason: 'invalid_execution_config_json' },
      });
    }
    return {
      id: row.id,
      projectId: row.project_id,
      featureId: row.feature_id,
      title: row.title,
      description: row.description,
      labels: parseLabels(row.labels, operation),
      status: row.status as (typeof taskStatuses)[number],
      complexity: row.complexity as PlanComplexity | null,
      acceptance: acceptance as { criteria: string[] },
      requirementsRefs: parseArtifactRefs(row.requirements_refs, operation, 'invalid_requirements_refs_json'),
      executionConfig: executionConfig as Record<string, unknown>,
      configSource: row.config_source,
      configSourceKey: row.config_source_key,
      revision: row.revision,
      createdAtUtcMs: row.created_at,
      updatedAtUtcMs: row.updated_at,
    };
  }

  function taskDependencyFromRow(row: TaskDependencySqlRow): TaskDependencyRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      featureId: row.feature_id,
      taskId: row.task_id,
      dependsOnId: row.depends_on_id,
      createdAtUtcMs: row.created_at,
    };
  }

  function insertPhaseInTransaction(input: unknown): PhaseRecord {
    const operation = 'PlanStore.insertPhase';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateCreatePhaseInput(input, operation);
    const entity: StorageEntityRef = { type: 'phase', projectId: valid.projectId };
    const db = session.database;
    assertProjectExists(db, operation, valid.projectId, entity);
    const timestamp = nowUtcMs();
    const id = randomUUID();
    let row: PhaseSqlRow | undefined;
    try {
      db.prepare(
        'INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels) ' +
          "VALUES (?, ?, ?, 1, ?, ?, 'open', ?, ?)",
      ).run(id, timestamp, valid.projectId, timestamp, valid.title, valid.description, JSON.stringify(valid.labels));
      row = db.prepare<[string], PhaseSqlRow>(`${SELECT_PHASE} WHERE id = ?`).get(id);
    } catch (error) {
      throw mapConstraintError(error, operation, entity, 'phase');
    }
    return phaseFromRow(row!);
  }

  function insertFeatureInTransaction(input: unknown): FeatureRecord {
    const operation = 'PlanStore.insertFeature';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateCreateFeatureInput(input, operation);
    const entity: StorageEntityRef = { type: 'feature', projectId: valid.projectId };
    const db = session.database;
    assertProjectExists(db, operation, valid.projectId, entity);
    const phase = db
      .prepare<[string], { project_id: string }>('SELECT project_id FROM phases WHERE id = ?')
      .get(valid.phaseId);
    if (phase === undefined) {
      throw notFound(operation, entity, `Phase ${valid.phaseId} 不存在`);
    }
    if (phase.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Phase 不属于声明的项目（跨项目父级被拒绝）');
    }
    const timestamp = nowUtcMs();
    const id = randomUUID();
    let row: FeatureSqlRow | undefined;
    try {
      db.prepare(
        'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, ' +
          "plan_status, description, labels, source_refs, plan_digest) VALUES (?, ?, ?, 1, ?, ?, ?, 'draft', 'draft', ?, ?, ?, ?)",
      ).run(
        id,
        timestamp,
        valid.projectId,
        timestamp,
        valid.phaseId,
        valid.title,
        valid.description,
        JSON.stringify(valid.labels),
        JSON.stringify(valid.sourceRefs),
        valid.planDigest,
      );
      row = db.prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`).get(id);
    } catch (error) {
      throw mapConstraintError(error, operation, entity, 'feature');
    }
    return featureFromRow(row!);
  }

  function insertTaskInTransaction(input: unknown): TaskRecord {
    const operation = 'PlanStore.insertTask';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateCreateTaskInput(input, operation);
    const entity: StorageEntityRef = { type: 'task', projectId: valid.projectId, id: valid.id };
    const db = session.database;
    assertProjectExists(db, operation, valid.projectId, entity);
    const feature = db
      .prepare<[string], { project_id: string }>('SELECT project_id FROM features WHERE id = ?')
      .get(valid.featureId);
    if (feature === undefined) {
      throw notFound(operation, entity, `Feature ${valid.featureId} 不存在`);
    }
    if (feature.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Feature 不属于声明的项目（跨项目父级被拒绝）');
    }
    // 重复任务身份：事务内存在性检查（写入串行化，无竞争窗口）。
    const existing = db.prepare<[string], { id: string }>('SELECT id FROM tasks WHERE id = ?').get(valid.id);
    if (existing !== undefined) {
      throw conflict(operation, `任务 ${valid.id} 已存在（重复身份拒绝，不覆盖）`, entity, {
        reason: 'task_already_exists',
        taskId: valid.id,
      });
    }
    const timestamp = nowUtcMs();
    let row: TaskSqlRow | undefined;
    try {
      db.prepare(
        'INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, ' +
          'complexity, description, labels, acceptance, requirements_refs, execution_config, config_source, config_source_key) ' +
          "VALUES (?, ?, ?, 1, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        valid.id,
        timestamp,
        valid.projectId,
        timestamp,
        valid.featureId,
        valid.title,
        valid.complexity,
        valid.description,
        JSON.stringify(valid.labels),
        JSON.stringify(valid.acceptance),
        JSON.stringify(valid.requirementsRefs),
        JSON.stringify(valid.executionConfig),
        valid.configSource,
        valid.configSourceKey,
      );
      row = db.prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE id = ?`).get(valid.id);
    } catch (error) {
      throw mapConstraintError(error, operation, entity, 'task');
    }
    return taskFromRow(row!);
  }

  function insertTaskDependencyInTransaction(input: unknown): TaskDependencyRecord {
    const operation = 'PlanStore.insertTaskDependency';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateCreateTaskDependencyInput(input, operation);
    const entity: StorageEntityRef = { type: 'task_dependency', projectId: valid.projectId };
    const db = session.database;
    assertProjectExists(db, operation, valid.projectId, entity);
    const feature = db
      .prepare<[string], { project_id: string }>('SELECT project_id FROM features WHERE id = ?')
      .get(valid.featureId);
    if (feature === undefined) {
      throw notFound(operation, entity, `Feature ${valid.featureId} 不存在`);
    }
    if (feature.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Feature 不属于声明的项目（跨项目引用被拒绝）');
    }
    // 两端任务核验：存在 + 同 Feature（跨 Feature 依赖结构化拒绝；DDL 复合外键兜底）。
    for (const [field, taskId] of [
      ['taskId', valid.taskId],
      ['dependsOnId', valid.dependsOnId],
    ] as const) {
      const task = db
        .prepare<[string], { feature_id: string }>('SELECT feature_id FROM tasks WHERE id = ?')
        .get(taskId);
      if (task === undefined) {
        throw notFound(operation, { type: 'task', id: taskId, projectId: valid.projectId }, `任务 ${taskId} 不存在`);
      }
      if (task.feature_id !== valid.featureId) {
        throw ownership(operation, entity, `${field} 指向的任务不属于声明的 Feature（跨 Feature 依赖被拒绝）`);
      }
    }
    // 重复边：事务内存在性检查（唯一索引兜底）。
    const existingEdge = db
      .prepare<[string, string, string], { id: string }>(
        'SELECT id FROM task_dependencies WHERE feature_id = ? AND task_id = ? AND depends_on_id = ?',
      )
      .get(valid.featureId, valid.taskId, valid.dependsOnId);
    if (existingEdge !== undefined) {
      throw conflict(operation, '依赖边已存在（重复边拒绝）', entity, {
        reason: 'task_dependency_already_exists',
        taskId: valid.taskId,
        dependsOnTaskId: valid.dependsOnId,
      });
    }
    // 环检测：同 Feature 既有边 + 新边后 DFS 复核（应用层校验；DDL 无法表达）。
    const edges = db
      .prepare<[string], { task_id: string; depends_on_id: string }>(
        'SELECT task_id, depends_on_id FROM task_dependencies WHERE feature_id = ?',
      )
      .all(valid.featureId) as { task_id: string; depends_on_id: string }[];
    assertNoDependencyCycle(
      [
        ...edges.map((edge) => ({ taskId: edge.task_id, dependsOnId: edge.depends_on_id })),
        { taskId: valid.taskId, dependsOnId: valid.dependsOnId },
      ],
      operation,
      entity,
    );
    const timestamp = nowUtcMs();
    const id = randomUUID();
    let row: TaskDependencySqlRow | undefined;
    try {
      db.prepare(
        'INSERT INTO task_dependencies (id, created_at, revision, updated_at, project_id, feature_id, task_id, depends_on_id) ' +
          'VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
      ).run(id, timestamp, timestamp, valid.projectId, valid.featureId, valid.taskId, valid.dependsOnId);
      row = db.prepare<[string], TaskDependencySqlRow>(`${SELECT_TASK_DEPENDENCY} WHERE id = ?`).get(id);
    } catch (error) {
      throw mapConstraintError(error, operation, entity, 'task_dependency');
    }
    return taskDependencyFromRow(row!);
  }

  return {
    insertPhaseInTransaction,
    insertFeatureInTransaction,
    insertTaskInTransaction,
    insertTaskDependencyInTransaction,
  };
}
