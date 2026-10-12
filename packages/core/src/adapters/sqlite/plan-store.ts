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
  validateInsertPlanApprovalInput,
  validatePlanEventAppend,
  validateReplaceFeaturePlanInput,
  validateUpdateFeaturePlanStatusInput,
  validateUpdatePlanEntityLabelsInput,
  validateUpdateTaskStrategyInput,
} from '../../ports/plan-store.js';
import type {
  FeaturePlanReplaceResult,
  FeaturePlanSnapshot,
  FeatureRecord,
  PhaseRecord,
  PlanApprovalRecord,
  TaskDependencyRecord,
  TaskRecord,
} from '../../ports/plan-store.js';
import type { PlanArtifactRef, PlanComplexity } from '../../ports/feature-plan.js';
import type { ArtifactInputRef } from '../../ports/artifact-store.js';
import { assertPrincipalVisibility } from '../../ports/queries.js';
import type {
  FeatureApprovalsView,
  FeaturePlanView,
  PlanListRequest,
  PlanRecordPage,
} from '../../ports/queries.js';
import type { ExecutionInputPreparationView } from '../../ports/execution-input-prepare.js';
import { ACTIVE_EXECUTION_STATUSES } from '../../ports/execution-preview.js';
import type { ExecutionPreviewResolvedInput, ExecutionPreviewView } from '../../ports/execution-preview.js';
import type { ProjectStatus } from '../../ports/state-store.js';
import { validateSha256Digest, validateStableId } from '../../ports/validation.js';
import { parseStoredSettingsPayload } from '../../ports/settings-schema.js';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead, visibilityCondition } from './state-store.js';

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

interface ApprovalSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly subject_digest: string;
  /** P03-2 / F-003 迁移 v8：决策绑定的适用检查政策身份摘要（v7 遗留为 NULL）。 */
  readonly check_policy_digest: string | null;
  readonly status: string;
  readonly decision_actor: string | null;
  readonly reason: string | null;
  readonly decided_at: number | null;
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
const SELECT_APPROVAL =
  'SELECT id, created_at, project_id, revision, updated_at, subject_type, subject_id, ' +
  'subject_digest, check_policy_digest, status, decision_actor, reason, decided_at FROM approvals';

/** F-007 纯标签编辑目标映射（冻结表名/SELECT；非用户输入，查询均绑定参数）。 */
const LABELS_EDIT_TARGET_SPECS: Readonly<
  Record<'phase' | 'feature' | 'task', { readonly table: string; readonly select: string }>
> = Object.freeze({
  phase: Object.freeze({ table: 'phases', select: SELECT_PHASE }),
  feature: Object.freeze({ table: 'features', select: SELECT_FEATURE }),
  task: Object.freeze({ table: 'tasks', select: SELECT_TASK }),
});

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
  /**
   * P03-1 / F-007：纯标签 CAS 编辑（单语句条件 UPDATE；缺失 not_found、
   * 跨项目 ownership、revision 不匹配 conflict）。
   */
  updatePlanEntityLabelsInTransaction(input: unknown): PhaseRecord | FeatureRecord | TaskRecord;
  /** F-004：计划域事件追加（脱敏 payload；与业务行/回执同一事务组合）。 */
  appendPlanEventInTransaction(input: unknown): void;
  /** F-005：同项目读取目标 Phase（缺失 not_found、跨项目 ownership）。 */
  getPhaseInTransaction(projectId: string, phaseId: string): PhaseRecord;
  /** F-005：同项目 ready 制品有效输入引用（与 ArtifactStore 同一契约语义）。 */
  getArtifactInputRefInTransaction(projectId: string, artifactId: string): ArtifactInputRef;
  /** F-005：既有任务 → 所属 Feature 解析（仅返回存在行）。 */
  getTaskFeatureLinksInTransaction(taskIds: readonly string[]): ReadonlyMap<string, string>;
  /** F-008：修订事务内读取 Feature 计划快照（缺失 not_found、跨项目 ownership）。 */
  getFeaturePlanInTransaction(projectId: string, featureId: string): FeaturePlanSnapshot;
  /**
   * P03-2 / F-001：策略编辑事务内读取目标 Task（缺失 not_found、跨项目
   * ownership 抛出，零写入）。
   */
  getTaskInTransaction(projectId: string, taskId: string): TaskRecord;
  /**
   * P03-2 / F-001：Task 策略副本 CAS 编辑（单语句条件 UPDATE；缺失 not_found、
   * 跨项目 ownership、revision 不匹配 conflict）。
   */
  updateTaskStrategyInTransaction(input: unknown): TaskRecord;
  /**
   * P03-2 / F-002：按主体身份查既设计划决策（只读；subjectType 冻结
   * feature_plan；F-003 起决策身份 = (subjectDigest, checkPolicyDigest) 复合，
   * 同主体同身份至多一条决策，未决策返回 undefined）。
   */
  findPlanApprovalInTransaction(
    projectId: string,
    featureId: string,
    subjectDigest: string,
    checkPolicyDigest: string,
  ): PlanApprovalRecord | undefined;
  /**
   * P03-2 / F-003：列出目标 Feature 的全部计划决策记录（事务内只读；稳定
   * 排序 decided_at → id；供有效批准核验在写事务内复用同一权威视图）。
   */
  listPlanApprovalsInTransaction(
    projectId: string,
    featureId: string,
  ): readonly PlanApprovalRecord[];
  /**
   * P03-2 / F-002：插入已决定（approved/rejected）计划决策记录（insert-only；
   * 缺失 not_found、跨项目 ownership、同主体同身份已有决策 conflict）。
   */
  insertPlanApprovalInTransaction(input: unknown): PlanApprovalRecord;
  /**
   * P03-2 / F-002：Feature 计划审批状态 CAS 更新（单语句条件 UPDATE 只触达
   * plan_status/revision/updated_at；缺失 not_found、跨项目 ownership、
   * revision 不匹配 conflict）。
   */
  updateFeaturePlanStatusInTransaction(input: unknown): FeatureRecord;
  /**
   * P03-1 / F-008：实质计划修订整体替换（同一写事务内原子生效）。既有成员
   * 按稳定 ID 保留身份与策略副本，新成员携带创建策略副本，被移除成员与
   * 全部旧边删除；Feature 聚合一次 CAS 一次递增。
   */
  replaceFeaturePlanInTransaction(input: unknown): FeaturePlanReplaceResult;
  /**
   * F-006 查询读取：单行详情（未命中 undefined；不在写事务内调用）。
   * 可见性折叠由应用层统一处理，本层不区分不存在与跨项目。
   */
  readPhaseRecord(phaseId: unknown): PhaseRecord | undefined;
  readTaskRecord(taskId: unknown): TaskRecord | undefined;
  /** F-006：Feature + 全部 Task + 全部依赖边（单一 DEFERRED 读事务一致视图）。 */
  readFeaturePlanView(featureId: unknown): FeaturePlanView | undefined;
  /** P03-2 / F-002：Feature + 全部计划决策记录（单一 DEFERRED 读事务一致视图）。 */
  readFeatureApprovalsView(featureId: unknown): FeatureApprovalsView | undefined;
  /**
   * P03-2 / F-006：执行输入准备一致读视图（Feature + 全部 Task + 全部依赖边 +
   * 全部决策记录 + 全局/项目当前配置；单一 DEFERRED 读事务内取得）。目标
   * Feature 缺失返回 undefined；跨项目抛 StorageError(ownership)（与写事务内
   * getFeaturePlan 同一判定）；嵌套于写事务内调用是编程错误（TypeError）。
   */
  readExecutionInputPreparationView(
    projectId: string,
    featureId: string,
  ): ExecutionInputPreparationView | undefined;
  /**
   * P03-3 / F-004：执行预览一致读视图（项目状态/绑定/Phase/Feature/全部
   * Task/依赖边/决策记录/全局与项目配置/必需输入解析/同 Feature 活动 Run/
   * 同 Phase 活动 Batch/基线占用；单一 DEFERRED 读事务内取得）。目标
   * Feature 缺失返回 undefined；跨项目抛 StorageError(ownership)；嵌套于
   * 写事务内调用是编程错误（TypeError）。
   */
  readExecutionPreviewView(projectId: string, featureId: string): ExecutionPreviewView | undefined;
  /** F-006 层级列表：可见范围谓词下推 + 稳定 id 升序键集分页（先收窄再分页）。 */
  listPhaseRecords(
    visibility: unknown,
    projectId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<PhaseRecord>;
  listFeatureRecords(
    visibility: unknown,
    projectId: unknown,
    phaseId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<FeatureRecord>;
  listTaskRecords(
    visibility: unknown,
    projectId: unknown,
    featureId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<TaskRecord>;
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

  /** 防御纵深：端口核验未命中时由 DDL（FK/复合外键/CHECK）兜底拒写，映射为结构化错误；
   * 触发器 ABORT（仅测试故障注入/库外装置产生）与非约束异常原样抛出，公开映射为 internal。 */
  function mapConstraintError(
    error: unknown,
    operation: string,
    entity: StorageEntityRef,
    kind: 'phase' | 'feature' | 'task' | 'task_dependency' | 'approval',
  ): StorageError {
    const code = isSqliteConstraintError(error) ? error.code : '';
    if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
      return conflict(operation, '重复身份或重复依赖边（唯一约束拒绝）', entity, {
        reason: `${kind}_already_exists`,
      });
    }
    if (
      code === 'SQLITE_CONSTRAINT_CHECK' ||
      code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
      code === 'SQLITE_CONSTRAINT_NOTNULL'
    ) {
      return new StorageError('validation', operation, `${operation}: 输入违反存储约束（外键/CHECK 兜底）`, {
        entity,
        details: { reason: `${kind}_constraint_rejected`, sqliteCode: code },
        cause: error,
      });
    }
    throw error;
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

  /**
   * P03-2 / F-002：approvals 行 → PlanApprovalRecord（枚举/形态损坏 corrupt 拒绝，
   * 不作为有效记录返回；与 features/tasks 读取映射同一纪律）。
   */
  function approvalFromRow(row: ApprovalSqlRow): PlanApprovalRecord {
    const operation = 'PlanStore.readApproval';
    if (
      !(
        row.subject_type === 'feature_plan' &&
        (row.status === 'pending' ||
          row.status === 'approved' ||
          row.status === 'rejected' ||
          row.status === 'superseded')
      )
    ) {
      throw new StorageError('corrupt', operation, 'approvals 行不是合法枚举值', {
        entity: { type: 'feature', projectId: row.project_id, id: row.subject_id },
        details: { reason: 'invalid_approval_status' },
      });
    }
    return {
      id: row.id,
      projectId: row.project_id,
      subjectType: row.subject_type as PlanApprovalRecord['subjectType'],
      subjectId: row.subject_id,
      subjectDigest: row.subject_digest,
      checkPolicyDigest: row.check_policy_digest,
      status: row.status as PlanApprovalRecord['status'],
      decisionActor: row.decision_actor,
      reason: row.reason,
      decidedAtUtcMs: row.decided_at,
      revision: row.revision,
      createdAtUtcMs: row.created_at,
      updatedAtUtcMs: row.updated_at,
    };
  }

  function insertPhaseInTransaction(input: unknown): PhaseRecord {
    const operation = 'PlanStore.insertPhase';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateCreatePhaseInput(input, operation);
    const entity: StorageEntityRef = {
      type: 'phase',
      projectId: valid.projectId,
      ...(valid.id !== null ? { id: valid.id } : {}),
    };
    const db = session.database;
    assertProjectExists(db, operation, valid.projectId, entity);
    // 稳定 ID：调用方可指定（validateStableId）；缺省由适配器生成 UUID v4（F-002 定案）。
    const id = valid.id ?? randomUUID();
    // 重复身份：事务内存在性检查（写入串行化，无竞争窗口；唯一索引兜底）。
    const existing = db.prepare<[string], { id: string }>('SELECT id FROM phases WHERE id = ?').get(id);
    if (existing !== undefined) {
      throw conflict(operation, `Phase ${id} 已存在（重复业务 ID 拒绝，不覆盖）`, entity, {
        reason: 'phase_already_exists',
        phaseId: id,
      });
    }
    const timestamp = nowUtcMs();
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

  /**
   * F-004：计划域事件追加（事务内使用；调用方保证业务行已在本事务内成功）。
   * payload 只含受控脱敏形状（ports/plan-store.ts 校验器同源）；插入失败整组回滚。
   */
  function appendPlanEventInTransaction(input: unknown): void {
    const operation = 'PlanStore.appendPlanEvent';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validatePlanEventAppend(input, operation);
    const db = session.database;
    const timestamp = nowUtcMs();
    const nextSequence = db
      .prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events')
      .get();
    db.prepare(
      'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) ' +
        'VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      timestamp,
      timestamp,
      valid.projectId,
      nextSequence?.next ?? 1,
      valid.eventType,
      valid.aggregateType,
      valid.aggregateId,
      valid.aggregateRevision,
      JSON.stringify(valid.payload),
      timestamp,
    );
  }

  /**
   * F-005：同项目读取目标 Phase（导入事务内归属重核；缺失 not_found、
   * 跨项目 ownership，与插入原语同一判定）。
   */
  function getPhaseInTransaction(projectId: string, phaseId: string): PhaseRecord {
    const operation = 'PlanStore.getPhase';
    assertOpen(operation);
    assertInTransaction(operation);
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const validPhaseId = validateStableId(phaseId, { operation }, 'phaseId');
    const entity: StorageEntityRef = { type: 'phase', projectId: validProjectId, id: validPhaseId };
    const row = session.database
      .prepare<[string], PhaseSqlRow>(`${SELECT_PHASE} WHERE id = ?`)
      .get(validPhaseId);
    if (row === undefined) {
      throw notFound(operation, entity, `Phase ${validPhaseId} 不存在`);
    }
    if (row.project_id !== validProjectId) {
      throw ownership(operation, entity, 'Phase 不属于声明的项目（跨项目父级被拒绝）');
    }
    return phaseFromRow(row);
  }

  /**
   * P03-1 / F-007：纯标签 CAS 编辑（事务内）。单语句条件 UPDATE 只触达
   * labels/revision/updated_at（不改标题/描述/状态/策略/摘要/引用/依赖，不向
   * 父子实体传播）；目标缺失 not_found、跨项目 ownership（抛出零写入）；
   * expectedRevision 为实体自身 revision，不匹配或条件 UPDATE 未命中均
   * conflict（details 携带 expectedRevision/actualRevision）。
   */
  function updatePlanEntityLabelsInTransaction(
    input: unknown,
  ): PhaseRecord | FeatureRecord | TaskRecord {
    const operation = 'PlanStore.updatePlanEntityLabels';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateUpdatePlanEntityLabelsInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = {
      type: valid.entityType,
      projectId: valid.projectId,
      id: valid.id,
    };
    // 表名/SELECT 来自冻结映射（非用户输入）；全部查询使用绑定参数。
    const spec = LABELS_EDIT_TARGET_SPECS[valid.entityType];
    const row = db
      .prepare<[string], { project_id: string; revision: number }>(`${spec.select} WHERE id = ?`)
      .get(valid.id);
    if (row === undefined) {
      throw notFound(operation, entity, `${valid.entityType} ${valid.id} 不存在`);
    }
    if (row.project_id !== valid.projectId) {
      throw ownership(operation, entity, '目标实体不属于声明的项目（跨项目目标被拒绝）');
    }
    const casConflict = (): StorageError =>
      conflict(operation, '标签编辑 CAS 不匹配（旧 revision 拒绝）', entity, {
        reason: 'conflict',
        expectedRevision: valid.expectedRevision,
        actualRevision: row.revision,
      });
    if (row.revision !== valid.expectedRevision) {
      throw casConflict();
    }
    const timestamp = nowUtcMs();
    // 单语句条件 UPDATE（而非先读后无条件覆盖）：同 revision 竞争编辑仅一个生效。
    const updated = db
      .prepare(
        `UPDATE ${spec.table} SET labels = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
      )
      .run(JSON.stringify(valid.labels), timestamp, valid.id, valid.expectedRevision);
    if (updated.changes !== 1) {
      throw casConflict();
    }
    const reread = (): unknown =>
      db.prepare<[string], unknown>(`${spec.select} WHERE id = ?`).get(valid.id);
    switch (valid.entityType) {
      case 'phase':
        return phaseFromRow(reread() as PhaseSqlRow);
      case 'feature':
        return featureFromRow(reread() as FeatureSqlRow);
      case 'task':
        return taskFromRow(reread() as TaskSqlRow);
    }
  }

  /**
   * F-005：导入事务内引用身份重核——与 ArtifactStore.getArtifactInputRef 同一
   * 契约语义（adapters/sqlite/artifact-store.ts 同一判定：缺失 not_found、跨
   * 项目 ownership（即使 ready 也不放行）、非 ready 或缺 hash/size 证据
   * conflict）。索引级身份重核不含文件 I/O（文件完整性核对不在写事务内）。
   */
  function getArtifactInputRefInTransaction(projectId: string, artifactId: string): ArtifactInputRef {
    const operation = 'PlanStore.getArtifactInputRef';
    assertOpen(operation);
    assertInTransaction(operation);
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const validArtifactId = validateStableId(artifactId, { operation }, 'artifactId');
    const entity: StorageEntityRef = {
      type: 'artifact',
      projectId: validProjectId,
      id: validArtifactId,
    };
    const row = session.database
      .prepare<[string], { id: string; project_id: string; status: string; content_hash: string | null; size_bytes: number | null; storage_locator: string; version: number }>(
        'SELECT id, project_id, status, content_hash, size_bytes, storage_locator, version FROM artifacts WHERE id = ?',
      )
      .get(validArtifactId);
    if (row === undefined) {
      throw notFound(operation, entity, `制品 ${validArtifactId} 不存在`);
    }
    if (row.project_id !== validProjectId) {
      throw ownership(operation, entity, '制品不属于请求项目，禁止跨项目访问（即使制品 ready）');
    }
    if (row.status !== 'ready' || row.content_hash === null || row.size_bytes === null) {
      throw conflict(operation, `制品状态 ${row.status} 不能取得有效输入引用（仅核验通过的 ready 制品可用）`, entity, {
        status: row.status,
      });
    }
    return {
      artifactId: row.id,
      projectId: row.project_id,
      contentHash: row.content_hash,
      sizeBytes: row.size_bytes,
      locator: row.storage_locator,
      version: row.version,
    };
  }

  /**
   * F-005：既有任务 → 所属 Feature 解析（重复业务 ID 预检与跨 Feature 依赖定位；
   * 输入稳定 ID 逐项校验，仅返回存在的行）。
   */
  function getTaskFeatureLinksInTransaction(taskIds: readonly string[]): ReadonlyMap<string, string> {
    const operation = 'PlanStore.getTaskFeatureLinks';
    assertOpen(operation);
    assertInTransaction(operation);
    const links = new Map<string, string>();
    const seen = new Set<string>();
    for (const taskId of taskIds) {
      const validTaskId = validateStableId(taskId, { operation }, 'taskIds');
      if (seen.has(validTaskId)) {
        continue;
      }
      seen.add(validTaskId);
      const row = session.database
        .prepare<[string], { id: string; feature_id: string }>(
          'SELECT id, feature_id FROM tasks WHERE id = ?',
        )
        .get(validTaskId);
      if (row !== undefined) {
        links.set(row.id, row.feature_id);
      }
    }
    return links;
  }

  /**
   * P03-2 / F-001：读取目标 Task（同项目；缺失 not_found、跨项目 ownership
   * 抛出，零写入），供策略编辑事务内重核归属/revision。
   */
  function getTaskInTransaction(projectId: string, taskId: string): TaskRecord {
    const operation = 'PlanStore.getTask';
    assertOpen(operation);
    assertInTransaction(operation);
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const validTaskId = validateStableId(taskId, { operation }, 'taskId');
    const entity: StorageEntityRef = { type: 'task', projectId: validProjectId, id: validTaskId };
    const row = session.database
      .prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE id = ?`)
      .get(validTaskId);
    if (row === undefined) {
      throw notFound(operation, entity, `Task ${validTaskId} 不存在`);
    }
    if (row.project_id !== validProjectId) {
      throw ownership(operation, entity, 'Task 不属于声明的项目（跨项目目标被拒绝）');
    }
    return taskFromRow(row);
  }

  /**
   * P03-2 / F-001：Task 策略副本 CAS 编辑（事务内）。单语句条件 UPDATE 只
   * 触达 execution_config/config_source/config_source_key/revision/updated_at
   * （不改标题/验收/依赖/planDigest/planStatus，不影响其他 Task）；目标缺失
   * not_found、跨项目 ownership（抛出零写入）；expectedRevision 为 Task 自身
   * revision，不匹配或条件 UPDATE 未命中均 conflict（details 携带
   * expectedRevision/actualRevision）。
   */
  function updateTaskStrategyInTransaction(input: unknown): TaskRecord {
    const operation = 'PlanStore.updateTaskStrategy';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateUpdateTaskStrategyInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = {
      type: 'task',
      projectId: valid.projectId,
      id: valid.taskId,
    };
    const row = db
      .prepare<[string], { project_id: string; revision: number }>(
        `${SELECT_TASK} WHERE id = ?`,
      )
      .get(valid.taskId);
    if (row === undefined) {
      throw notFound(operation, entity, `Task ${valid.taskId} 不存在`);
    }
    if (row.project_id !== valid.projectId) {
      throw ownership(operation, entity, '目标 Task 不属于声明的项目（跨项目目标被拒绝）');
    }
    const casConflict = (): StorageError =>
      conflict(operation, '策略编辑 CAS 不匹配（旧 revision 拒绝）', entity, {
        reason: 'conflict',
        expectedRevision: valid.expectedRevision,
        actualRevision: row.revision,
      });
    if (row.revision !== valid.expectedRevision) {
      throw casConflict();
    }
    const timestamp = nowUtcMs();
    // 单语句条件 UPDATE（而非先读后无条件覆盖）：同 revision 竞争编辑仅一个生效。
    const updated = db
      .prepare(
        'UPDATE tasks SET execution_config = ?, config_source = ?, config_source_key = ?, ' +
          'revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?',
      )
      .run(
        JSON.stringify(valid.executionConfig),
        valid.configSource,
        valid.configSourceKey,
        timestamp,
        valid.taskId,
        valid.expectedRevision,
      );
    if (updated.changes !== 1) {
      throw casConflict();
    }
    const reread = db.prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE id = ?`).get(valid.taskId);
    return taskFromRow(reread as TaskSqlRow);
  }

  /**
   * P03-2 / F-002：按主体摘要查既设计划决策（只读；subjectType 冻结
   * feature_plan，subjectId 即 Feature 稳定 ID；同主体同摘要至多一条决策）。
   */
  function findPlanApprovalInTransaction(
    projectId: string,
    featureId: string,
    subjectDigest: string,
    checkPolicyDigest: string,
  ): PlanApprovalRecord | undefined {
    const operation = 'PlanStore.findPlanApproval';
    assertOpen(operation);
    assertInTransaction(operation);
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const validFeatureId = validateStableId(featureId, { operation }, 'featureId');
    const validDigest = validateSha256Digest(subjectDigest, { operation }, 'subjectDigest');
    // P03-2 / F-003：决策身份 = 计划摘要 + 检查政策摘要复合。
    const validCheckPolicyDigest = validateSha256Digest(checkPolicyDigest, { operation }, 'checkPolicyDigest');
    const row = session.database
      .prepare<[string, string, string, string], ApprovalSqlRow>(
        `${SELECT_APPROVAL} WHERE project_id = ? AND subject_type = 'feature_plan' AND subject_id = ? AND subject_digest = ? AND check_policy_digest = ?`,
      )
      .get(validProjectId, validFeatureId, validDigest, validCheckPolicyDigest);
    return row === undefined ? undefined : approvalFromRow(row);
  }

  /**
   * P03-2 / F-003：列出目标 Feature 的全部计划决策记录（事务内只读；稳定
   * 排序 decided_at → id；供有效批准核验在写事务内复用同一权威视图）。
   */
  function listPlanApprovalsInTransaction(
    projectId: string,
    featureId: string,
  ): readonly PlanApprovalRecord[] {
    const operation = 'PlanStore.listPlanApprovals';
    assertOpen(operation);
    assertInTransaction(operation);
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const validFeatureId = validateStableId(featureId, { operation }, 'featureId');
    const rows = session.database
      .prepare<[string, string], ApprovalSqlRow>(
        `${SELECT_APPROVAL} WHERE project_id = ? AND subject_type = 'feature_plan' AND subject_id = ? ORDER BY decided_at, id`,
      )
      .all(validProjectId, validFeatureId) as ApprovalSqlRow[];
    return rows.map((row) => approvalFromRow(row));
  }

  /**
   * P03-2 / F-002：插入已决定（approved/rejected）计划决策记录（事务内）。
   * 目标 Feature 缺失 not_found、跨项目 ownership；同主体同身份（计划摘要 +
   * 检查政策摘要复合，F-003）已有决策 conflict（重复竞争决策 fail-closed；
   * DDL 唯一索引兜底）；id/revision=1/时间戳由适配器定值（UUID v4 + 注入
   * UTC 毫秒）。
   */
  function insertPlanApprovalInTransaction(input: unknown): PlanApprovalRecord {
    const operation = 'PlanStore.insertPlanApproval';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateInsertPlanApprovalInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = {
      type: 'feature',
      projectId: valid.projectId,
      id: valid.subjectId,
    };
    const featureRow = db
      .prepare<[string], { project_id: string }>(
        'SELECT project_id FROM features WHERE id = ?',
      )
      .get(valid.subjectId);
    if (featureRow === undefined) {
      throw notFound(operation, entity, `Feature ${valid.subjectId} 不存在`);
    }
    if (featureRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, '决策主体不属于声明的项目（跨项目目标被拒绝）');
    }
    const existing = db
      .prepare<[string, string, string, string], { id: string }>(
        "SELECT id FROM approvals WHERE project_id = ? AND subject_type = 'feature_plan' AND subject_id = ? AND subject_digest = ? AND check_policy_digest = ?",
      )
      .get(valid.projectId, valid.subjectId, valid.subjectDigest, valid.checkPolicyDigest);
    if (existing !== undefined) {
      throw conflict(
        operation,
        '同一计划身份（摘要 + 检查政策）已有决策记录（重复竞争决策拒绝，不覆盖）',
        entity,
        { reason: 'approval_already_decided' },
      );
    }
    const timestamp = nowUtcMs();
    const id = randomUUID();
    try {
      db.prepare(
        'INSERT INTO approvals (id, created_at, project_id, revision, updated_at, subject_type, ' +
          'subject_id, subject_digest, check_policy_digest, status, decision_actor, reason, decided_at) ' +
          'VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        timestamp,
        valid.projectId,
        timestamp,
        valid.subjectType,
        valid.subjectId,
        valid.subjectDigest,
        valid.checkPolicyDigest,
        valid.status,
        valid.decisionActor,
        valid.reason,
        valid.decidedAtUtcMs,
      );
    } catch (error) {
      throw mapConstraintError(error, operation, entity, 'approval');
    }
    const reread = db.prepare<[string], ApprovalSqlRow>(`${SELECT_APPROVAL} WHERE id = ?`).get(id);
    return approvalFromRow(reread as ApprovalSqlRow);
  }

  /**
   * P03-2 / F-002：Feature 计划审批状态 CAS 更新（事务内）。单语句条件 UPDATE
   * 只触达 plan_status/revision/updated_at（不改计划内容/摘要/标题/Task）；
   * 目标缺失 not_found、跨项目 ownership（抛出零写入）；expectedRevision 为
   * Feature 聚合 revision，不匹配或条件 UPDATE 未命中均 conflict（携带
   * expected/actual）。
   */
  function updateFeaturePlanStatusInTransaction(input: unknown): FeatureRecord {
    const operation = 'PlanStore.updateFeaturePlanStatus';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateUpdateFeaturePlanStatusInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = {
      type: 'feature',
      projectId: valid.projectId,
      id: valid.featureId,
    };
    const row = db
      .prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`)
      .get(valid.featureId);
    if (row === undefined) {
      throw notFound(operation, entity, `Feature ${valid.featureId} 不存在`);
    }
    if (row.project_id !== valid.projectId) {
      throw ownership(operation, entity, '目标 Feature 不属于声明的项目（跨项目目标被拒绝）');
    }
    const casConflict = (): StorageError =>
      conflict(operation, '计划审批状态更新 CAS 不匹配（旧 revision 拒绝）', entity, {
        reason: 'conflict',
        expectedRevision: valid.expectedRevision,
        actualRevision: row.revision,
        entityType: 'feature',
      });
    if (row.revision !== valid.expectedRevision) {
      throw casConflict();
    }
    const timestamp = nowUtcMs();
    // 单语句条件 UPDATE：同 revision 竞争决策/编辑仅一个生效。
    const updated = db
      .prepare(
        'UPDATE features SET plan_status = ?, revision = revision + 1, updated_at = ? ' +
          'WHERE id = ? AND revision = ?',
      )
      .run(valid.planStatus, timestamp, valid.featureId, valid.expectedRevision);
    if (updated.changes !== 1) {
      throw casConflict();
    }
    const reread = db
      .prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`)
      .get(valid.featureId);
    return featureFromRow(reread as FeatureSqlRow);
  }

  /**
   * F-008：修订事务内读取 Feature 计划快照（Feature + 全部 Task + 全部边；
   * 缺失 not_found、跨项目 ownership，与插入/标签编辑原语同一判定）。
   */
  function getFeaturePlanInTransaction(projectId: string, featureId: string): FeaturePlanSnapshot {
    const operation = 'PlanStore.getFeaturePlan';
    assertOpen(operation);
    assertInTransaction(operation);
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const validFeatureId = validateStableId(featureId, { operation }, 'featureId');
    const entity: StorageEntityRef = { type: 'feature', projectId: validProjectId, id: validFeatureId };
    const db = session.database;
    const featureRow = db
      .prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`)
      .get(validFeatureId);
    if (featureRow === undefined) {
      throw notFound(operation, entity, `Feature ${validFeatureId} 不存在`);
    }
    if (featureRow.project_id !== validProjectId) {
      throw ownership(operation, entity, 'Feature 不属于声明的项目（跨项目目标被拒绝）');
    }
    const taskRows = db
      .prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE feature_id = ? ORDER BY id`)
      .all(validFeatureId) as TaskSqlRow[];
    const dependencyRows = db
      .prepare<[string], TaskDependencySqlRow>(`${SELECT_TASK_DEPENDENCY} WHERE feature_id = ? ORDER BY task_id, depends_on_id`)
      .all(validFeatureId) as TaskDependencySqlRow[];
    return {
      feature: featureFromRow(featureRow),
      tasks: taskRows.map(taskFromRow),
      dependencies: dependencyRows.map(taskDependencyFromRow),
    };
  }

  /**
   * P03-1 / F-008：实质计划修订整体替换（同一写事务内）。写入顺序：Feature
   * 聚合 CAS 条件 UPDATE（一次 CAS 一次递增，先于成员写入）→ 删除全部旧边 →
   * 删除被移除成员 → 保留成员业务内容 UPDATE（策略副本/状态/创建时间不变，
   * revision 递增一次）→ 新建成员 INSERT（创建策略副本，pending，revision=1）→
   * 新边 INSERT。保留/新建由库内既有成员身仈权威划分；新成员 ID 与库内任何
   * 既有任务冲突即 conflict；最终边集合 DFS 复核无环（防御纵深）。
   */
  function replaceFeaturePlanInTransaction(input: unknown): FeaturePlanReplaceResult {
    const operation = 'PlanStore.replaceFeaturePlan';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateReplaceFeaturePlanInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = {
      type: 'feature',
      projectId: valid.projectId,
      id: valid.featureId,
    };
    const featureRow = db
      .prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`)
      .get(valid.featureId);
    if (featureRow === undefined) {
      throw notFound(operation, entity, `Feature ${valid.featureId} 不存在`);
    }
    if (featureRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Feature 不属于声明的项目（跨项目目标被拒绝）');
    }
    // 库内既有成员身份（同事务读取，串行化无竞争窗口）。
    const existingRows = db
      .prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE feature_id = ? ORDER BY id`)
      .all(valid.featureId) as TaskSqlRow[];
    const existingIds = new Set(existingRows.map((row) => row.id));
    const finalIds = new Set(valid.tasks.map((task) => task.id));
    // 新成员 ID 全局唯一性：与库内任何其他 Feature 任务冲突即拒绝（不覆盖）。
    for (const task of valid.tasks) {
      if (existingIds.has(task.id)) {
        continue;
      }
      const clash = db
        .prepare<[string], { feature_id: string }>('SELECT feature_id FROM tasks WHERE id = ?')
        .get(task.id);
      if (clash !== undefined) {
        throw conflict(
          operation,
          `任务 ${task.id} 已存在（重复身份拒绝，不覆盖）`,
          { type: 'task', projectId: valid.projectId, id: task.id },
          { reason: 'task_already_exists', taskId: task.id },
        );
      }
    }
    // 最终边集合环检测（防御纵深；应用层纯校验已先行）。
    assertNoDependencyCycle(valid.dependencies, operation, entity);

    const keptTasks = valid.tasks.filter((task) => existingIds.has(task.id));
    const createdTasks = valid.tasks.filter((task) => !existingIds.has(task.id));
    const removedTaskIds = existingRows
      .filter((row) => !finalIds.has(row.id))
      .map((row) => row.id);

    // Feature 聚合 CAS：先比对再单语句条件 UPDATE（防御纵深，事务内串行化）。
    const casConflict = (): StorageError =>
      conflict(operation, '计划修订 CAS 不匹配（旧 revision 拒绝）', entity, {
        reason: 'conflict',
        expectedRevision: valid.expectedRevision,
        actualRevision: featureRow.revision,
        entityType: 'feature',
      });
    if (featureRow.revision !== valid.expectedRevision) {
      throw casConflict();
    }
    const timestamp = nowUtcMs();
    /** 防御纵深：DDL 约束违规映射为结构化错误（按写入目标表选择 kind，不泄漏 SQL 原文）。 */
    const guarded = <R>(kind: 'feature' | 'task' | 'task_dependency', run: () => R): R => {
      try {
        return run();
      } catch (error) {
        if (error instanceof StorageError) {
          throw error;
        }
        throw mapConstraintError(error, operation, entity, kind);
      }
    };
    guarded('feature', () => {
      const updatedFeature = db
        .prepare(
          'UPDATE features SET title = ?, description = ?, labels = ?, source_refs = ?, plan_digest = ?, ' +
            'plan_status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?',
        )
        .run(
          valid.feature.title,
          valid.feature.description,
          JSON.stringify(valid.feature.labels),
          JSON.stringify(valid.feature.sourceRefs),
          valid.feature.planDigest,
          valid.feature.planStatus,
          timestamp,
          valid.featureId,
          valid.expectedRevision,
        );
      if (updatedFeature.changes !== 1) {
        throw casConflict();
      }
    });

    // 旧边整体删除（边插后不可变；修订在聚合事务内整体替换）。
    guarded('task_dependency', () => {
      db.prepare<[string]>('DELETE FROM task_dependencies WHERE feature_id = ?').run(valid.featureId);
    });
    // 被移除成员删除（历史证据由事件流承载，不伪造成员“从未存在”）。
    for (const removedId of removedTaskIds) {
      guarded('task', () => {
        db.prepare<[string, string]>('DELETE FROM tasks WHERE feature_id = ? AND id = ?').run(
          valid.featureId,
          removedId,
        );
      });
    }
    // 保留成员：业务内容整体替换（含标签），策略副本/状态/创建时间不变，
    // revision 递增一次（聚合级整体替换的一部分，与 Feature 聚合同组生效）。
    for (const task of keptTasks) {
      guarded('task', () => {
        const updatedTask = db
          .prepare(
            'UPDATE tasks SET title = ?, description = ?, labels = ?, complexity = ?, acceptance = ?, ' +
              'requirements_refs = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND feature_id = ?',
          )
          .run(
            task.title,
            task.description,
            JSON.stringify(task.labels),
            task.complexity,
            JSON.stringify(task.acceptance),
            JSON.stringify(task.requirementsRefs),
            timestamp,
            task.id,
            valid.featureId,
          );
        if (updatedTask.changes !== 1) {
          throw new StorageError(
            'corrupt',
            operation,
            `${operation}: 保留成员 ${task.id} 在替换中缺失（防御纵深拒绝）`,
            {
              entity: { type: 'task', id: task.id, projectId: valid.projectId },
              details: { reason: 'kept_member_missing' },
            },
          );
        }
      });
    }
    // 新建成员：创建策略副本 + pending + revision=1（状态恒为创建初值）。
    for (const task of createdTasks) {
      guarded('task', () => {
        db.prepare(
          'INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, ' +
            'complexity, description, labels, acceptance, requirements_refs, execution_config, config_source, config_source_key) ' +
            "VALUES (?, ?, ?, 1, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          task.id,
          timestamp,
          valid.projectId,
          timestamp,
          valid.featureId,
          task.title,
          task.complexity,
          task.description,
          JSON.stringify(task.labels),
          JSON.stringify(task.acceptance),
          JSON.stringify(task.requirementsRefs),
          JSON.stringify(task.executionConfig),
          task.configSource,
          task.configSourceKey,
        );
      });
    }
    // 新边插入（端点已在端口校验内限定为最终成员集合）。
    for (const edge of valid.dependencies) {
      guarded('task_dependency', () => {
        db.prepare(
          'INSERT INTO task_dependencies (id, created_at, revision, updated_at, project_id, feature_id, task_id, depends_on_id) ' +
            'VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
        ).run(
          randomUUID(),
          timestamp,
          timestamp,
          valid.projectId,
          valid.featureId,
          edge.taskId,
          edge.dependsOnId,
        );
      });
    }

    const feature = featureFromRow(
      db.prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`).get(valid.featureId)!,
    );
    const tasks = (
      db.prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE feature_id = ? ORDER BY id`).all(valid.featureId) as TaskSqlRow[]
    ).map(taskFromRow);
    return {
      feature,
      tasks,
      keptTaskIds: keptTasks.map((task) => task.id),
      createdTaskIds: createdTasks.map((task) => task.id),
      removedTaskIds,
    };
  }

  /* ------------------ F-006 查询读取（非事务写路径） ------------------ */

  /** 查询读取：写事务内调用是编程错误（查询面绝不并入写事务/不产生副作用）。 */
  function assertNotInTransaction(operation: string): void {
    if (session.database.inTransaction) {
      throw new TypeError(`${operation}: 计划查询读取不得嵌套在写事务内（编程错误）`);
    }
  }

  /** 查询读取的稳定 ID 入口校验（未知输入 → validation；不读 SQL）。 */
  function planReadId(
    operation: string,
    value: unknown,
    field: string,
    entityType: StorageEntityRef['type'],
  ): string {
    return validateStableId(value, { operation, entity: { type: entityType } }, field);
  }

  function assertPlanListRequest(request: PlanListRequest): void {
    if (
      request === null ||
      typeof request !== 'object' ||
      (request.afterId !== null &&
        (typeof request.afterId !== 'string' || request.afterId.length === 0)) ||
      typeof request.limit !== 'number' ||
      !Number.isInteger(request.limit) ||
      request.limit < 1
    ) {
      throw new TypeError('PlanStore.list: request 必须是 {afterId: string|null, limit: ≥1 整数}（已校验分页形态）');
    }
  }

  /**
   * 层级列表 SELECT：可见范围谓词（project_id）随查询下推，与父级过滤、
   * 键集下界（id > afterId）同一条 WHERE，再 ORDER BY id LIMIT n+1——先收窄
   * 再分页；父级跨项目/不存在/空父级统一空页，不泄漏存在性。
   */
  function listPlanRows<T>(
    operation: string,
    visibility: unknown,
    select: string,
    projectId: unknown,
    parent: { readonly column: string; readonly value: unknown; readonly entityType: StorageEntityRef['type'] } | null,
    request: PlanListRequest,
    mapRow: (row: unknown) => T,
  ): PlanRecordPage<T> {
    assertOpen(operation);
    assertNotInTransaction(operation);
    // 可见范围形状非法 = 可信装配编程错误（TypeError），不折算客户端错误。
    assertPrincipalVisibility(visibility);
    assertPlanListRequest(request);
    const validProjectId = planReadId(operation, projectId, 'projectId', 'project');
    const conditions = ['id > ?', 'project_id = ?'];
    const params: unknown[] = [request.afterId ?? '', validProjectId];
    if (parent !== null) {
      const validParentId = planReadId(operation, parent.value, parent.column, parent.entityType);
      conditions.push(`${parent.column} = ?`);
      params.push(validParentId);
    }
    const visible = visibilityCondition(visibility, 'project_id');
    if (visible.condition !== undefined) {
      conditions.push(visible.condition);
      params.push(...visible.params);
    }
    params.push(request.limit + 1);
    const rows = session.database
      .prepare<unknown[], unknown>(
        `${select} WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ?`,
      )
      .all(...params);
    const hasMore = rows.length > request.limit;
    const pageRows = hasMore ? rows.slice(0, request.limit) : rows;
    return {
      records: pageRows.map(mapRow),
      nextId: hasMore ? ((pageRows[pageRows.length - 1] as { id?: string } | undefined)?.id ?? null) : null,
    };
  }

  function readPhaseRecord(phaseId: unknown): PhaseRecord | undefined {
    const operation = 'PlanStore.readPhase';
    assertOpen(operation);
    assertNotInTransaction(operation);
    const id = planReadId(operation, phaseId, 'phaseId', 'phase');
    const row = session.database
      .prepare<[string], PhaseSqlRow>(`${SELECT_PHASE} WHERE id = ?`)
      .get(id);
    return row === undefined ? undefined : phaseFromRow(row);
  }

  function readTaskRecord(taskId: unknown): TaskRecord | undefined {
    const operation = 'PlanStore.readTask';
    assertOpen(operation);
    assertNotInTransaction(operation);
    const id = planReadId(operation, taskId, 'taskId', 'task');
    const row = session.database
      .prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE id = ?`)
      .get(id);
    return row === undefined ? undefined : taskFromRow(row);
  }

  /**
   * F-006：Feature 计划详情 + 完整同 Feature Task DAG 的一致读视图（单一
   * BEGIN DEFERRED 读事务）。并发修订只能观察到完整修订前或修订后：视图内
   * Feature 行、全部 Task 行与全部依赖边来自同一快照，不存在新 Task 配旧边/
   * 旧摘要的混合状态；嵌套于写事务内调用是编程错误（TypeError）。
   */
  function readFeaturePlanView(featureId: unknown): FeaturePlanView | undefined {
    const operation = 'PlanStore.readFeaturePlanView';
    const id = planReadId(operation, featureId, 'featureId', 'feature');
    return transactSqliteConsistentRead(session, operation, (db) => {
      const featureRow = db
        .prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`)
        .get(id);
      if (featureRow === undefined) {
        return undefined;
      }
      const taskRows = db
        .prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE feature_id = ? ORDER BY id`)
        .all(id) as TaskSqlRow[];
      const dependencyRows = db
        .prepare<[string], TaskDependencySqlRow>(
          `${SELECT_TASK_DEPENDENCY} WHERE feature_id = ? ORDER BY task_id, depends_on_id`,
        )
        .all(id) as TaskDependencySqlRow[];
      return {
        feature: featureFromRow(featureRow),
        tasks: taskRows.map((row) => taskFromRow(row)),
        dependencies: dependencyRows.map((row) => taskDependencyFromRow(row)),
      };
    });
  }

  /**
   * P03-2 / F-002：Feature + 全部决策记录的一致读视图（单一 DEFERRED 读事务）；
   * 排序稳定（decided_at → id）；未命中返回 undefined（可见性折叠由应用层
   * 统一为 not_found）。
   */
  function readFeatureApprovalsView(featureId: unknown): FeatureApprovalsView | undefined {
    const operation = 'PlanStore.readFeatureApprovalsView';
    const id = planReadId(operation, featureId, 'featureId', 'feature');
    return transactSqliteConsistentRead(session, operation, (db) => {
      const featureRow = db
        .prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`)
        .get(id);
      if (featureRow === undefined) {
        return undefined;
      }
      const feature = featureFromRow(featureRow);
      const approvalRows = db
        .prepare<[string], ApprovalSqlRow>(
          `${SELECT_APPROVAL} WHERE subject_type = 'feature_plan' AND subject_id = ? ORDER BY decided_at, id`,
        )
        .all(id) as ApprovalSqlRow[];
      // P03-2 / F-003：全局与项目当前配置来自同一 DEFERRED 读视图（供有效
      // 批准核验在同一权威视图内计算当前适用检查政策身份）；持久 payload
      // 重新经结构校验，损坏 corrupt 拒绝（fail-closed）。
      const globalRow = db
        .prepare<[string], { revision: number; payload: string }>(
          'SELECT revision, payload FROM global_settings WHERE id = ?',
        )
        .get('global');
      const projectRow = db
        .prepare<[string], { revision: number; payload: string }>(
          'SELECT revision, payload FROM project_settings WHERE project_id = ?',
        )
        .get(feature.projectId);
      return {
        feature,
        approvals: approvalRows.map((row) => approvalFromRow(row)),
        taskCount:
          db
            .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ?')
            .get(id)?.n ?? 0,
        settings: {
          global:
            globalRow === undefined
              ? null
              : {
                  scopeRevision: globalRow.revision,
                  payload: parseStoredSettingsPayload(globalRow.payload, {
                    operation,
                    entity: { type: 'global_settings', id: 'global' },
                  }),
                },
          project:
            projectRow === undefined
              ? null
              : {
                  scopeRevision: projectRow.revision,
                  payload: parseStoredSettingsPayload(projectRow.payload, {
                    operation,
                    entity: { type: 'project_settings', projectId: feature.projectId },
                  }),
                },
        },
      };
    });
  }

  /**
   * P03-2 / F-006：执行输入准备一致读视图（单一 DEFERRED 读事务）：Feature +
   * 全部 Task + 全部依赖边 + 全部决策记录 + 全局/项目当前配置在同一快照内
   * 取得（并发修订/决策/配置变化只能观察到完整前后状态）。跨项目抛
   * ownership；嵌套写事务 TypeError（transactSqliteConsistentRead 把关）。
   */
  function readExecutionInputPreparationView(
    projectId: string,
    featureId: string,
  ): ExecutionInputPreparationView | undefined {
    const operation = 'PlanStore.readExecutionInputPreparationView';
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const validFeatureId = validateStableId(featureId, { operation }, 'featureId');
    const entity: StorageEntityRef = { type: 'feature', projectId: validProjectId, id: validFeatureId };
    return transactSqliteConsistentRead(session, operation, (db) => {
      const featureRow = db
        .prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`)
        .get(validFeatureId);
      if (featureRow === undefined) {
        return undefined;
      }
      if (featureRow.project_id !== validProjectId) {
        throw ownership(operation, entity, 'Feature 不属于声明的项目（跨项目目标被拒绝）');
      }
      const taskRows = db
        .prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE feature_id = ? ORDER BY id`)
        .all(validFeatureId) as TaskSqlRow[];
      const dependencyRows = db
        .prepare<[string], TaskDependencySqlRow>(
          `${SELECT_TASK_DEPENDENCY} WHERE feature_id = ? ORDER BY task_id, depends_on_id`,
        )
        .all(validFeatureId) as TaskDependencySqlRow[];
      const approvalRows = db
        .prepare<[string], ApprovalSqlRow>(
          `${SELECT_APPROVAL} WHERE subject_type = 'feature_plan' AND subject_id = ? ORDER BY decided_at, id`,
        )
        .all(validFeatureId) as ApprovalSqlRow[];
      // 全局与项目当前配置来自同一 DEFERRED 读视图（检查政策身份的权威输入）；
      // 持久 payload 重新经结构校验，损坏 corrupt 拒绝（fail-closed）。
      const globalRow = db
        .prepare<[string], { revision: number; payload: string }>(
          'SELECT revision, payload FROM global_settings WHERE id = ?',
        )
        .get('global');
      const projectRow = db
        .prepare<[string], { revision: number; payload: string }>(
          'SELECT revision, payload FROM project_settings WHERE project_id = ?',
        )
        .get(validProjectId);
      return {
        feature: featureFromRow(featureRow),
        tasks: taskRows.map((row) => taskFromRow(row)),
        dependencies: dependencyRows.map((row) => taskDependencyFromRow(row)),
        approvals: approvalRows.map((row) => approvalFromRow(row)),
        settings: {
          global:
            globalRow === undefined
              ? null
              : {
                  scopeRevision: globalRow.revision,
                  payload: parseStoredSettingsPayload(globalRow.payload, {
                    operation,
                    entity: { type: 'global_settings', id: 'global' },
                  }),
                },
          project:
            projectRow === undefined
              ? null
              : {
                  scopeRevision: projectRow.revision,
                  payload: parseStoredSettingsPayload(projectRow.payload, {
                    operation,
                    entity: { type: 'project_settings', projectId: validProjectId },
                  }),
                },
        },
      };
    });
  }

  function readExecutionPreviewView(
    projectId: string,
    featureId: string,
  ): ExecutionPreviewView | undefined {
    const operation = 'PlanStore.readExecutionPreviewView';
    const validProjectId = validateStableId(projectId, { operation }, 'projectId');
    const validFeatureId = validateStableId(featureId, { operation }, 'featureId');
    const entity: StorageEntityRef = { type: 'feature', projectId: validProjectId, id: validFeatureId };
    const activeStatusList = ACTIVE_EXECUTION_STATUSES as readonly string[];
    const activePlaceholders = activeStatusList.map(() => '?').join(', ');
    return transactSqliteConsistentRead(session, operation, (db) => {
      const featureRow = db
        .prepare<[string], FeatureSqlRow>(`${SELECT_FEATURE} WHERE id = ?`)
        .get(validFeatureId);
      if (featureRow === undefined) {
        return undefined;
      }
      if (featureRow.project_id !== validProjectId) {
        throw ownership(operation, entity, 'Feature 不属于声明的项目（跨项目目标被拒绝）');
      }
      // Phase 行来自同一读视图（Feature 复合外键保证归属一致）。
      const phaseRow = db
        .prepare<[string], PhaseSqlRow>(`${SELECT_PHASE} WHERE id = ?`)
        .get(featureRow.phase_id) as PhaseSqlRow | undefined;
      if (phaseRow === undefined) {
        throw new StorageError(
          'corrupt',
          operation,
          `${operation}: Feature 所属 Phase 缺失（外部键漂移）`,
          { entity: { type: 'phase', projectId: validProjectId, id: featureRow.phase_id } },
        );
      }
      // 项目最小只读面（状态）与绑定最小只读面（身份）。状态值经枚举核验，
      // 损坏行 fail-closed（不作为有效视图返回）。
      const projectRow = db
        .prepare<[string], { id: string; status: string }>(
          'SELECT id, status FROM projects WHERE id = ?',
        )
        .get(validProjectId) as { id: string; status: string } | undefined;
      if (projectRow === undefined) {
        throw notFound(operation, { type: 'project', id: validProjectId }, `项目 ${validProjectId} 不存在`);
      }
      const projectStatuses = ['active', 'archiving', 'archived', 'deleting'] as const;
      if (!(projectStatuses as readonly string[]).includes(projectRow.status)) {
        throw new StorageError(
          'corrupt',
          operation,
          `${operation}: 项目状态非法（${projectRow.status}）`,
          { entity: { type: 'project', id: validProjectId }, details: { reason: 'invalid_status' } },
        );
      }
      const bindingRow = db
        .prepare<[string], { canonical_path: string; repo_identity: string }>(
          'SELECT canonical_path, repo_identity FROM repository_bindings WHERE project_id = ?',
        )
        .get(validProjectId) as { canonical_path: string; repo_identity: string } | undefined;

      const taskRows = db
        .prepare<[string], TaskSqlRow>(`${SELECT_TASK} WHERE feature_id = ? ORDER BY id`)
        .all(validFeatureId) as TaskSqlRow[];
      const dependencyRows = db
        .prepare<[string], TaskDependencySqlRow>(
          `${SELECT_TASK_DEPENDENCY} WHERE feature_id = ? ORDER BY task_id, depends_on_id`,
        )
        .all(validFeatureId) as TaskDependencySqlRow[];
      const approvalRows = db
        .prepare<[string], ApprovalSqlRow>(
          `${SELECT_APPROVAL} WHERE subject_type = 'feature_plan' AND subject_id = ? ORDER BY decided_at, id`,
        )
        .all(validFeatureId) as ApprovalSqlRow[];
      const globalRow = db
        .prepare<[string], { revision: number; payload: string }>(
          'SELECT revision, payload FROM global_settings WHERE id = ?',
        )
        .get('global');
      const projectSettingsRow = db
        .prepare<[string], { revision: number; payload: string }>(
          'SELECT revision, payload FROM project_settings WHERE project_id = ?',
        )
        .get(validProjectId);

      // 必需不可变输入引用解析（Feature sourceRefs + Task requirementsRefs 去重；
      // 同一读事务内查权威制品索引，正文永不内联）。
      const feature = featureFromRow(featureRow);
      const tasks = taskRows.map((row) => taskFromRow(row));
      const refMap = new Map<string, ExecutionPreviewResolvedInput>();
      const collectRefs = (refs: readonly PlanArtifactRef[]): void => {
        for (const ref of refs) {
          const key = `${ref.artifactId}\u0000${ref.contentHash ?? ''}`;
          if (!refMap.has(key)) {
            refMap.set(key, {
              artifactId: ref.artifactId,
              declaredContentHash: ref.contentHash ?? null,
              resolved: null,
              unavailableReason: null,
            });
          }
        }
      };
      collectRefs(feature.sourceRefs);
      for (const task of tasks) {
        collectRefs(task.requirementsRefs);
      }
      const resolvedInputs: ExecutionPreviewResolvedInput[] = Array.from(refMap.values())
        .map((input) => {
          const artifactRow = db
            .prepare<[string, string], { version: number; content_hash: string | null; size_bytes: number | null; status: string }>(
              'SELECT version, content_hash, size_bytes, status FROM artifacts WHERE project_id = ? AND id = ?',
            )
            .get(validProjectId, input.artifactId) as
            | { version: number; content_hash: string | null; size_bytes: number | null; status: string }
            | undefined;
          if (artifactRow === undefined) {
            return { ...input, resolved: null, unavailableReason: 'not_found' as const };
          }
          if (
            artifactRow.status !== 'ready' ||
            artifactRow.content_hash === null ||
            artifactRow.size_bytes === null
          ) {
            return { ...input, resolved: null, unavailableReason: 'not_ready' as const };
          }
          return {
            ...input,
            resolved: {
              version: artifactRow.version,
              contentHash: artifactRow.content_hash,
              sizeBytes: artifactRow.size_bytes,
            },
            unavailableReason: null,
          };
        });

      // 活动执行（与迁移 v9 条件唯一部分索引同源的活动集）与基线占用。
      const activeRuns = (
        db
          .prepare<unknown[], { id: string; status: string }>(
            `SELECT id, status FROM runs WHERE project_id = ? AND feature_id = ? AND status IN (${activePlaceholders}) ORDER BY id`,
          )
          .all(validProjectId, validFeatureId, ...activeStatusList) as { id: string; status: string }[]
      ).map((row) => ({ id: row.id, status: row.status }));
      const activeBatchRow = db
        .prepare<unknown[], { id: string; feature_id: string; status: string }>(
          `SELECT id, feature_id, status FROM execution_batches WHERE project_id = ? AND phase_id = ? AND status IN (${activePlaceholders}) ORDER BY id LIMIT 1`,
        )
        .all(validProjectId, featureRow.phase_id, ...activeStatusList)[0] as
        | { id: string; feature_id: string; status: string }
        | undefined;
      const occupancyRow = db
        .prepare<[], { holder_operation_id: string | null }>(
          "SELECT holder_operation_id FROM baseline_occupancy WHERE id = 'global'",
        )
        .get() as { holder_operation_id: string | null } | undefined;

      return {
        project: { id: projectRow.id, status: projectRow.status as ProjectStatus },
        binding:
          bindingRow === undefined
            ? null
            : { canonicalPath: bindingRow.canonical_path, repoIdentity: bindingRow.repo_identity },
        phase: phaseFromRow(phaseRow),
        feature,
        tasks,
        dependencies: dependencyRows.map((row) => taskDependencyFromRow(row)),
        approvals: approvalRows.map((row) => approvalFromRow(row)),
        settings: {
          global:
            globalRow === undefined
              ? null
              : {
                  scopeRevision: globalRow.revision,
                  payload: parseStoredSettingsPayload(globalRow.payload, {
                    operation,
                    entity: { type: 'global_settings', id: 'global' },
                  }),
                },
          project:
            projectSettingsRow === undefined
              ? null
              : {
                  scopeRevision: projectSettingsRow.revision,
                  payload: parseStoredSettingsPayload(projectSettingsRow.payload, {
                    operation,
                    entity: { type: 'project_settings', projectId: validProjectId },
                  }),
                },
        },
        resolvedInputs,
        activeRuns,
        activePhaseBatch:
          activeBatchRow === undefined
            ? null
            : { id: activeBatchRow.id, featureId: activeBatchRow.feature_id, status: activeBatchRow.status },
        baselineOccupancy: {
          holderOperationId: occupancyRow === undefined ? null : occupancyRow.holder_operation_id,
        },
      };
    });
  }

  function listPhaseRecords(
    visibility: unknown,
    projectId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<PhaseRecord> {
    return listPlanRows('PlanStore.listPhases', visibility, SELECT_PHASE, projectId, null, request, (row) =>
      phaseFromRow(row as PhaseSqlRow),
    );
  }

  function listFeatureRecords(
    visibility: unknown,
    projectId: unknown,
    phaseId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<FeatureRecord> {
    return listPlanRows(
      'PlanStore.listFeatures',
      visibility,
      SELECT_FEATURE,
      projectId,
      { column: 'phase_id', value: phaseId, entityType: 'phase' },
      request,
      (row) => featureFromRow(row as FeatureSqlRow),
    );
  }

  function listTaskRecords(
    visibility: unknown,
    projectId: unknown,
    featureId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<TaskRecord> {
    return listPlanRows(
      'PlanStore.listTasks',
      visibility,
      SELECT_TASK,
      projectId,
      { column: 'feature_id', value: featureId, entityType: 'feature' },
      request,
      (row) => taskFromRow(row as TaskSqlRow),
    );
  }

  return {
    insertPhaseInTransaction,
    insertFeatureInTransaction,
    insertTaskInTransaction,
    insertTaskDependencyInTransaction,
    updatePlanEntityLabelsInTransaction,
    appendPlanEventInTransaction,
    getPhaseInTransaction,
    getArtifactInputRefInTransaction,
    getTaskFeatureLinksInTransaction,
    getFeaturePlanInTransaction,
    replaceFeaturePlanInTransaction,
    getTaskInTransaction,
    updateTaskStrategyInTransaction,
    findPlanApprovalInTransaction,
    insertPlanApprovalInTransaction,
    updateFeaturePlanStatusInTransaction,
    listPlanApprovalsInTransaction,
    readPhaseRecord,
    readTaskRecord,
    readFeaturePlanView,
    readFeatureApprovalsView,
    readExecutionInputPreparationView,
    readExecutionPreviewView,
    listPhaseRecords,
    listFeatureRecords,
    listTaskRecords,
  };
}
