/**
 * P05-1 / F-002 规划上下文窄存储原语（adapters/sqlite 层）。
 *
 * 设计依据：ports/planning-context.ts（窄存储契约与状态机）、core-design/03 §3
 * （原子操作接口：创建上下文与 planning Task、发布候选绑定、记录决策各是**一个**
 * 原子事务原语，不拆成多个独立提交）、core-design/02 §2（plan Run 创建一个
 * planning Task；候选保存为制品；批准原子应用）。
 *
 * 形态与不变量：
 * - 写原语（create/publish/decide）必须位于写事务内（assertInTransaction）——
 *   规划启动命令（F-003）与决策命令（F-008）在同一原子命令事务内组合这些原语；
 * - 创建原语在同一事务内完成：核对 Feature 目标 revision/计划摘要与规划 Run 归属
 *   （Run.purpose=plan）→ 生成 planning Task（tasks.kind='planning'，携带冻结的
 *   用途策略副本）→ 插入 planning_contexts（status='open'，候选事实恒 NULL）→
 *   读回并按端口契约整体校验后返回；
 * - 发布原语绑定候选 Artifact/摘要（open → candidate_published）：重核 Artifact
 *   同项目、ready 且内容摘要一致；同身份重放复用原记录（outcome='reused'，稳定
 *   重放），异身份冲突；发布后候选绑定由 DDL 写一次触发器冻结；
 * - 决策原语记录人工批准/拒绝（candidate_published → applied/rejected）：批准必须
 *   携带原子应用后的 Feature revision（appliedRevision）；决策结果写一次，重放
 *   冲突（命令级幂等由既有 command_receipts 承担）；
 * - 读取原语在事务外使用一致读（transactSqliteConsistentRead）；行映射对损坏行
 *   （非法枚举/摘要/JSON、planning Task 绑定漂移、策略副本形状损坏）以
 *   kind='corrupt' fail-closed，不作为有效记录返回；
 * - 本模块不实现：规划启动命令/预算/派发（F-003/F-005）、Artifact 发布命令
 *   （F-006，本模块只记录发布事实）、批准决策命令与计划导入编排（F-008）。
 */
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead } from './state-store.js';
import { randomUUID } from 'node:crypto';
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import { PLANNING_RUN_PURPOSE, PLANNING_TASK_KIND } from '../../ports/planning-candidates.js';
import {
  assertPlanningContextTransition,
  validatePlanningCandidateDecisionInput,
  validatePlanningCandidatePublicationInput,
  validatePlanningContextCreateInput,
  validatePlanningContextRecord,
} from '../../ports/planning-context.js';
import type {
  PlanningCandidatePublicationInput,
  PlanningContextDecision,
  PlanningContextRecord,
  PlanningContextStatus,
} from '../../ports/planning-context.js';
import { validatePlanningStrategyCopy } from '../../ports/planning-context.js';
import { validatePlanningRequestBasis } from '../../ports/planning-input-prepare.js';
import type {
  PlanningFeatureView,
  PlanningInputPreparationView,
  PlanningRunView,
  PlanningTaskView,
} from '../../ports/planning-input-prepare.js';
import { validatePlanArtifactRefs } from '../../ports/feature-plan.js';
import { PLANNING_CONTEXT_REQUIREMENT_REFS_MAX_COUNT } from '../../ports/planning-context.js';
import { validateStableId } from '../../ports/validation.js';

/** 发布结果：published=首次绑定；reused=同身份重放复用原记录（零新增）。 */
export interface PlanningCandidatePublication {
  readonly context: PlanningContextRecord;
  readonly outcome: 'published' | 'reused';
}

interface PlanningContextSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly updated_at: number;
  readonly phase_id: string;
  readonly feature_id: string;
  readonly run_id: string;
  readonly planning_task_id: string;
  readonly candidate_id: string;
  readonly input_digest: string;
  readonly target_revision: number;
  readonly plan_digest: string | null;
  readonly candidate_artifact_id: string | null;
  readonly candidate_content_hash: string | null;
  readonly candidate_digest: string | null;
  readonly candidate_summary: string | null;
  readonly status: string;
  readonly decision: string | null;
  readonly decision_reason: string | null;
  readonly decided_at: number | null;
  readonly applied_revision: number | null;
  readonly applied_at: number | null;
}

const SELECT_PLANNING_CONTEXT =
  'SELECT id, created_at, project_id, updated_at, phase_id, feature_id, run_id, planning_task_id, ' +
  'candidate_id, input_digest, target_revision, plan_digest, candidate_artifact_id, ' +
  'candidate_content_hash, candidate_digest, candidate_summary, status, decision, decision_reason, ' +
  'decided_at, applied_revision, applied_at FROM planning_contexts';

export interface SqlitePlanningContextStore {
  /** 创建规划上下文与 planning Task（同一写事务内；见模块契约）。 */
  createPlanningContextInTransaction(input: unknown): PlanningContextRecord;
  /** 按候选身份读取（一致读；不存在返回 null）。 */
  getPlanningContextByCandidate(projectId: unknown, candidateId: unknown): PlanningContextRecord | null;
  /** 按规划 Run 读取（一致读；不存在返回 null）。 */
  getPlanningContextByRun(projectId: unknown, runId: unknown): PlanningContextRecord | null;
  /**
   * P05-1 / F-003：同 Feature 活动规划上下文（open/candidate_published；
   * 写事务内读取——规划启动命令重核重复规划；无则 null）。
   */
  getActivePlanningContextForFeatureInTransaction(projectId: unknown, featureId: unknown): PlanningContextRecord | null;
  /**
   * P05-1 / F-004：规划输入准备一致读视图（同一 DEFERRED 读事务内取得规划
   * 上下文 + planning Task 业务字段 + Feature 当前身份 + 规划 Run 冻结请求
   * 快照；无则 undefined；损坏行 corrupt fail-closed）。
   */
  readPlanningInputPreparationView(projectId: string, runId: string): PlanningInputPreparationView | undefined;
  /** 绑定候选 Artifact/摘要（open → candidate_published；同身份重放复用）。 */
  publishPlanningCandidateInTransaction(input: unknown): PlanningCandidatePublication;
  /** 记录人工决策（candidate_published → applied/rejected；写一次）。 */
  decidePlanningCandidateInTransaction(input: unknown): PlanningContextRecord;
}

export interface SqlitePlanningContextStoreOptions {
  readonly nowUtcMs?: () => number;
}

export function createSqlitePlanningContextStore(
  session: SqliteStorageSession,
  options: SqlitePlanningContextStoreOptions = {},
): SqlitePlanningContextStore {
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
    }
  }

  function assertInTransaction(operation: string): void {
    if (!session.database.inTransaction) {
      throw new TypeError(`${operation}: 规划上下文写原语必须位于写事务内（原子命令事务拥有唯一事务）`);
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

  function corrupt(operation: string, entity: StorageEntityRef, message: string, reason: string, cause?: unknown): StorageError {
    return new StorageError('corrupt', operation, `${operation}: ${message}`, { entity, details: { reason }, ...(cause === undefined ? {} : { cause }) });
  }

  function parseJsonColumn(text: string, operation: string, reason: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw corrupt(operation, { type: 'planning_context' }, 'planning Task 持久 JSON 损坏', reason, error);
    }
  }

  function isSqliteConstraintError(error: unknown): error is Error & { code: string } {
    return (
      error instanceof Error &&
      typeof (error as Error & { code?: unknown }).code === 'string' &&
      (error as Error & { code: string }).code.startsWith('SQLITE_CONSTRAINT')
    );
  }

  /** 行 + 绑定 planning Task 快照 → 端口记录（损坏行 fail-closed）。 */
  function contextFromRow(row: PlanningContextSqlRow, operation: string): PlanningContextRecord {
    const entity: StorageEntityRef = { type: 'planning_context', projectId: row.project_id, id: row.id };
    const db = session.database;
    const taskRow = db
      .prepare<[string, string], { kind: string; status: string; execution_config: string; config_source: string; config_source_key: string | null }>(
        'SELECT kind, status, execution_config, config_source, config_source_key FROM tasks WHERE id = ? AND feature_id = ?',
      )
      .get(row.planning_task_id, row.feature_id);
    if (taskRow === undefined) {
      throw corrupt(operation, entity, '绑定的 planning Task 缺失（绑定漂移）', 'planning_task_missing');
    }
    if (taskRow.kind !== PLANNING_TASK_KIND) {
      throw corrupt(operation, entity, `绑定 Task 的 kind 不是 ${PLANNING_TASK_KIND}`, 'planning_task_kind_mismatch');
    }
    const executionConfigValue = parseJsonColumn(taskRow.execution_config, operation, 'invalid_execution_config_json');
    const candidateArtifactRef =
      row.candidate_artifact_id === null || row.candidate_content_hash === null
        ? null
        : { artifactId: row.candidate_artifact_id, contentHash: row.candidate_content_hash };
    try {
      return validatePlanningContextRecord(
        {
          id: row.id,
          createdAtUtcMs: row.created_at,
          projectId: row.project_id,
          updatedAtUtcMs: row.updated_at,
          phaseId: row.phase_id,
          featureId: row.feature_id,
          runId: row.run_id,
          planningTaskId: row.planning_task_id,
          candidateId: row.candidate_id,
          inputDigest: row.input_digest,
          targetRevision: row.target_revision,
          planDigest: row.plan_digest,
          status: row.status,
          candidateArtifactRef,
          candidateDigest: row.candidate_digest,
          candidateSummary: row.candidate_summary,
          decision: row.decision,
          decisionReason: row.decision_reason,
          decidedAtUtcMs: row.decided_at,
          appliedRevision: row.applied_revision,
          appliedAtUtcMs: row.applied_at,
          planningTask: {
            id: row.planning_task_id,
            kind: taskRow.kind,
            status: taskRow.status,
            executionConfig: executionConfigValue,
            configSource: taskRow.config_source,
            configSourceKey: taskRow.config_source_key,
          },
        },
        operation,
      );
    } catch (error) {
      if (error instanceof StorageError && error.kind === 'validation') {
        throw corrupt(operation, entity, '规划上下文持久行损坏（枚举/摘要/JSON/一致性校验失败）', 'invalid_planning_context_row', error);
      }
      throw error;
    }
  }

  function getContextByCandidateRow(projectId: string, candidateId: string, operation: string): PlanningContextRecord | null {
    const row = session.database
      .prepare<[string, string], PlanningContextSqlRow>(
        `${SELECT_PLANNING_CONTEXT} WHERE project_id = ? AND candidate_id = ?`,
      )
      .get(projectId, candidateId);
    return row === undefined ? null : contextFromRow(row, operation);
  }

  function consistentRead<T>(operation: string, read: () => T): T {
    return session.database.inTransaction
      ? read()
      : transactSqliteConsistentRead(session, operation, read);
  }

  /* ------------------ 创建：上下文 + planning Task（同一事务） ------------------ */

  function createPlanningContextInTransaction(input: unknown): PlanningContextRecord {
    const operation = 'PlanningContextStore.create';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validatePlanningContextCreateInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = { type: 'planning_context', projectId: valid.projectId, id: valid.candidateId };

    // 1) Feature 目标依据核对：同项目、同 Phase、当前 revision 与计划摘要必须与
    //    声明一致（应用候选时的 CAS 依据在创建时即冻结为可核对事实）。
    const featureRow = db
      .prepare<[string], { project_id: string; phase_id: string; revision: number; plan_digest: string | null }>(
        'SELECT project_id, phase_id, revision, plan_digest FROM features WHERE id = ?',
      )
      .get(valid.featureId);
    if (featureRow === undefined) {
      throw notFound(operation, { type: 'feature', projectId: valid.projectId, id: valid.featureId }, `Feature ${valid.featureId} 不存在`);
    }
    if (featureRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Feature 不属于声明的项目（跨项目目标被拒绝）');
    }
    if (featureRow.phase_id !== valid.phaseId) {
      throw conflict(operation, 'Feature 不属于声明的 Phase（归属不一致拒绝）', entity, { reason: 'phase_mismatch', featurePhaseId: featureRow.phase_id });
    }
    if (featureRow.revision !== valid.targetRevision || featureRow.plan_digest !== valid.planDigest) {
      throw conflict(
        operation,
        '规划目标依据与 Feature 当前状态不一致（targetRevision/planDigest 必须冻结当前事实）',
        entity,
        { reason: 'target_basis_mismatch', expectedRevision: valid.targetRevision, actualRevision: featureRow.revision },
      );
    }

    // 2) 规划 Run 核对：同项目、同 Feature 且用途为 plan（Run.purpose）。
    const runRow = db
      .prepare<[string], { project_id: string; feature_id: string; purpose: string }>(
        'SELECT project_id, feature_id, purpose FROM runs WHERE id = ?',
      )
      .get(valid.runId);
    if (runRow === undefined) {
      throw notFound(operation, { type: 'run', projectId: valid.projectId, id: valid.runId }, `Run ${valid.runId} 不存在`);
    }
    if (runRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Run 不属于声明的项目（跨项目目标被拒绝）');
    }
    if (runRow.feature_id !== valid.featureId) {
      throw conflict(operation, 'Run 不属于声明的 Feature（规划 Run 归属不一致拒绝）', entity, { reason: 'run_feature_mismatch', runFeatureId: runRow.feature_id });
    }
    if (runRow.purpose !== PLANNING_RUN_PURPOSE) {
      throw conflict(
        operation,
        `Run 用途必须是 ${PLANNING_RUN_PURPOSE}（规划 Run），实际 ${runRow.purpose}`,
        entity,
        { reason: 'run_purpose_mismatch', runPurpose: runRow.purpose },
      );
    }

    // 3) planning Task（tasks.kind='planning'）：存储生成全局唯一身份，与业务 Task
    //    冲突即拒绝（不覆盖）；策略副本冻结进 execution_config。
    const timestamp = nowUtcMs();
    const planningTaskId = randomUUID();
    try {
      db.prepare(
        'INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, ' +
          'complexity, description, labels, acceptance, requirements_refs, execution_config, config_source, config_source_key, kind) ' +
          "VALUES (?, ?, ?, 1, ?, ?, ?, 'pending', NULL, ?, '[]', ?, ?, ?, ?, ?, 'planning')",
      ).run(
        planningTaskId,
        timestamp,
        valid.projectId,
        timestamp,
        valid.featureId,
        valid.planningTask.title,
        valid.planningTask.description,
        JSON.stringify(valid.planningTask.acceptance),
        JSON.stringify(valid.planningTask.requirementsRefs),
        JSON.stringify(valid.strategy),
        valid.strategySource.configSource,
        valid.strategySource.configSourceKey,
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw conflict(
          operation,
          `planning Task 身份 ${planningTaskId} 与既有任务冲突（不覆盖；业务 Task 与规划 Task 身份互斥）`,
          { type: 'task', projectId: valid.projectId, id: planningTaskId },
          { reason: 'planning_task_identity_clash', taskId: planningTaskId },
        );
      }
      throw error;
    }

    // 4) 规划上下文行（status='open'，候选/决策事实恒 NULL）。
    const contextId = randomUUID();
    try {
      db.prepare(
        'INSERT INTO planning_contexts (id, created_at, project_id, updated_at, phase_id, feature_id, run_id, ' +
          'planning_task_id, candidate_id, input_digest, target_revision, plan_digest, candidate_artifact_id, ' +
          'candidate_content_hash, candidate_digest, candidate_summary, status, decision, decision_reason, ' +
          "decided_at, applied_revision, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'open', NULL, NULL, NULL, NULL, NULL)",
      ).run(
        contextId,
        timestamp,
        valid.projectId,
        timestamp,
        valid.phaseId,
        valid.featureId,
        valid.runId,
        planningTaskId,
        valid.candidateId,
        valid.inputDigest,
        valid.targetRevision,
        valid.planDigest,
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        const raced = getContextByCandidateRow(valid.projectId, valid.candidateId, operation);
        throw conflict(
          operation,
          raced === null
            ? '规划上下文写入被 DDL 约束拒绝（归属/重复规划/唯一身份）'
            : `候选 ${valid.candidateId} 已有规划上下文（重复规划归属拒绝）`,
          entity,
          { reason: raced === null ? 'constraint_rejected' : 'candidate_already_bound', candidateId: valid.candidateId },
        );
      }
      throw error;
    }

    const created = getContextByCandidateRow(valid.projectId, valid.candidateId, operation);
    if (created === null) {
      throw corrupt(operation, entity, '规划上下文刚写入却无法读回', 'created_row_missing');
    }
    return created;
  }

  /* ------------------ 读取（一致读；损坏行 fail-closed） ------------------ */

  function getActivePlanningContextForFeatureInTransaction(projectId: unknown, featureId: unknown): PlanningContextRecord | null {
    const operation = 'PlanningContextStore.getActiveForFeature';
    assertOpen(operation);
    assertInTransaction(operation);
    const validProjectId = validateStableId(projectId, { operation, entity: { type: 'planning_context' } }, 'projectId');
    const validFeatureId = validateStableId(featureId, { operation, entity: { type: 'feature' } }, 'featureId');
    const row = session.database
      .prepare<[string, string], PlanningContextSqlRow>(
        `${SELECT_PLANNING_CONTEXT} WHERE project_id = ? AND feature_id = ? AND status IN ('open', 'candidate_published') ORDER BY id LIMIT 1`,
      )
      .get(validProjectId, validFeatureId);
    return row === undefined ? null : contextFromRow(row, operation);
  }

  function getPlanningContextByCandidate(projectId: unknown, candidateId: unknown): PlanningContextRecord | null {
    const operation = 'PlanningContextStore.getByCandidate';
    assertOpen(operation);
    const validProjectId = validateStableId(projectId, { operation, entity: { type: 'planning_context' } }, 'projectId');
    const validCandidateId = validateStableId(candidateId, { operation, entity: { type: 'planning_context' } }, 'candidateId');
    return consistentRead(operation, () => getContextByCandidateRow(validProjectId, validCandidateId, operation));
  }

  function getPlanningContextByRun(projectId: unknown, runId: unknown): PlanningContextRecord | null {
    const operation = 'PlanningContextStore.getByRun';
    assertOpen(operation);
    const validProjectId = validateStableId(projectId, { operation, entity: { type: 'planning_context' } }, 'projectId');
    const validRunId = validateStableId(runId, { operation, entity: { type: 'run' } }, 'runId');
    return consistentRead(operation, () => {
      const row = session.database
        .prepare<[string, string], PlanningContextSqlRow>(`${SELECT_PLANNING_CONTEXT} WHERE project_id = ? AND run_id = ?`)
        .get(validProjectId, validRunId);
      return row === undefined ? null : contextFromRow(row, operation);
    });
  }

  /* ------------------ P05-1 / F-004 规划输入准备一致读视图 ------------------ */

  /**
   * 规划输入准备视图（单一 DEFERRED 读事务内取得全部成分；并发决策/应用/
   * 计划变化只能观察到完整前后状态）。目标 Run 无规划上下文返回 undefined；
   * 跨项目 ownership；损坏行/非法快照 corrupt fail-closed。无业务计划
   * （plan_digest NULL）也是完整视图。
   */
  function readPlanningInputPreparationView(projectId: string, runId: string): PlanningInputPreparationView | undefined {
    const operation = 'PlanningContextStore.readPlanningInputPreparationView';
    assertOpen(operation);
    const validProjectId = validateStableId(projectId, { operation, entity: { type: 'planning_context' } }, 'projectId');
    const validRunId = validateStableId(runId, { operation, entity: { type: 'run' } }, 'runId');
    return consistentRead(operation, () => {
      const row = session.database
        .prepare<[string, string], PlanningContextSqlRow>(`${SELECT_PLANNING_CONTEXT} WHERE project_id = ? AND run_id = ?`)
        .get(validProjectId, validRunId);
      if (row === undefined) {
        return undefined;
      }
      const context = contextFromRow(row, operation);

      // planning Task 完整业务字段（同一读事务；与上下文绑定校验）。
      const taskRow = session.database
        .prepare<[string, string], {
          id: string; kind: string; status: string; title: string; description: string | null;
          acceptance: string; requirements_refs: string; execution_config: string;
          config_source: string; config_source_key: string | null;
        }>(
          'SELECT id, kind, status, title, description, acceptance, requirements_refs, execution_config, config_source, config_source_key ' +
            'FROM tasks WHERE id = ? AND feature_id = ?',
        )
        .get(row.planning_task_id, row.feature_id);
      if (taskRow === undefined) {
        throw corrupt(operation, { type: 'planning_context', projectId: row.project_id, id: row.id }, '绑定的 planning Task 缺失（绑定漂移）', 'planning_task_missing');
      }
      if (taskRow.kind !== PLANNING_TASK_KIND) {
        throw corrupt(operation, { type: 'planning_context', projectId: row.project_id, id: row.id }, `绑定 Task 的 kind 不是 ${PLANNING_TASK_KIND}`, 'planning_task_kind_mismatch');
      }
      const taskEntity: StorageEntityRef = { type: 'task', projectId: row.project_id, id: taskRow.id };
      const taskAcceptanceValue = parseJsonColumn(taskRow.acceptance, operation, 'invalid_acceptance_json') as { criteria?: unknown };
      if (
        taskAcceptanceValue === null || typeof taskAcceptanceValue !== 'object' ||
        !Array.isArray(taskAcceptanceValue.criteria) ||
        taskAcceptanceValue.criteria.some((item) => typeof item !== 'string' || item.length === 0)
      ) {
        throw corrupt(operation, taskEntity, 'planning Task 验收持久 JSON 损坏', 'invalid_acceptance_json');
      }
      const taskRefsValue = parseJsonColumn(taskRow.requirements_refs, operation, 'invalid_requirements_refs_json');
      const taskRequirementRefs = validatePlanArtifactRefs(
        taskRefsValue,
        { operation, entity: taskEntity },
        'requirementsRefs',
        PLANNING_CONTEXT_REQUIREMENT_REFS_MAX_COUNT,
      );
      const strategyCopy = validatePlanningStrategyCopy(
        parseJsonColumn(taskRow.execution_config, operation, 'invalid_execution_config_json'),
        operation,
      );
      const planningTask: PlanningTaskView = {
        id: taskRow.id,
        kind: PLANNING_TASK_KIND,
        status: taskRow.status,
        title: taskRow.title,
        description: taskRow.description,
        acceptance: { criteria: [...(taskAcceptanceValue.criteria as readonly string[])] },
        requirementsRefs: taskRequirementRefs,
        executionConfig: strategyCopy,
        configSource: taskRow.config_source,
        configSourceKey: taskRow.config_source_key,
      };

      // Feature 当前身份（同一读事务；plan_digest NULL 是首次草稿的如实记录）。
      const featureRow = session.database
        .prepare<[string], { id: string; revision: number; plan_digest: string | null; plan_status: string; status: string }>(
          'SELECT id, revision, plan_digest, plan_status, status FROM features WHERE id = ?',
        )
        .get(row.feature_id);
      if (featureRow === undefined) {
        throw corrupt(operation, { type: 'planning_context', projectId: row.project_id, id: row.id }, '规划上下文绑定的 Feature 缺失', 'feature_missing');
      }
      const feature: PlanningFeatureView = {
        id: featureRow.id,
        revision: featureRow.revision,
        planDigest: featureRow.plan_digest,
        planStatus: featureRow.plan_status,
        status: featureRow.status,
      };

      // 规划 Run 冻结身份（inputSnapshot 读取侧重校验；损坏 corrupt）。
      const runRow = session.database
        .prepare<[string], { id: string; purpose: string; status: string; input_snapshot: string }>(
          'SELECT id, purpose, status, input_snapshot FROM runs WHERE id = ?',
        )
        .get(row.run_id);
      if (runRow === undefined) {
        throw corrupt(operation, { type: 'planning_context', projectId: row.project_id, id: row.id }, '规划上下文绑定的 Run 缺失', 'run_missing');
      }
      if (runRow.purpose !== PLANNING_RUN_PURPOSE) {
        throw corrupt(operation, { type: 'run', projectId: row.project_id, id: runRow.id }, '绑定 Run 的 purpose 不是 plan', 'run_purpose_mismatch');
      }
      let basis;
      try {
        basis = validatePlanningRequestBasis(
          parseJsonColumn(runRow.input_snapshot, operation, 'invalid_input_snapshot_json'),
          operation,
        );
      } catch (error) {
        if (error instanceof StorageError && error.kind === 'validation') {
          throw corrupt(operation, { type: 'run', projectId: row.project_id, id: runRow.id }, '规划 Run 冻结请求快照损坏（读取侧校验失败）', 'invalid_input_snapshot', error);
        }
        throw error;
      }
      const run: PlanningRunView = {
        id: runRow.id,
        purpose: PLANNING_RUN_PURPOSE,
        status: runRow.status,
        inputSnapshot: basis,
      };

      return { context, planningTask, feature, run };
    });
  }

  /* ------------------ 发布候选绑定（open → candidate_published） ------------------ */

  function publishPlanningCandidateInTransaction(input: unknown): PlanningCandidatePublication {
    const operation = 'PlanningContextStore.publish';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validatePlanningCandidatePublicationInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = { type: 'planning_context', projectId: valid.projectId, id: valid.candidateId };

    const existing = getContextByCandidateRow(valid.projectId, valid.candidateId, operation);
    if (existing === null) {
      throw notFound(operation, entity, `候选 ${valid.candidateId} 没有规划上下文`);
    }
    if (existing.status === 'candidate_published' || existing.status === 'applied' || existing.status === 'rejected') {
      // 已发布：同身份重放复用（稳定重放），异身份冲突（单候选，不可发布第二个）。
      const sameIdentity =
        existing.candidateDigest === valid.candidateDigest &&
        existing.candidateArtifactRef !== null &&
        existing.candidateArtifactRef.artifactId === valid.artifactId &&
        existing.candidateArtifactRef.contentHash === valid.contentHash &&
        existing.candidateSummary === valid.summary;
      if (!sameIdentity) {
        throw conflict(
          operation,
          `候选 ${valid.candidateId} 已绑定发布事实（单候选；不同身份不得二次发布）`,
          entity,
          { reason: 'candidate_already_published', status: existing.status },
        );
      }
      if (existing.status !== 'candidate_published') {
        throw conflict(
          operation,
          `候选 ${valid.candidateId} 已决策（${existing.status}），发布重放不可改写决策`,
          entity,
          { reason: 'already_decided', status: existing.status },
        );
      }
      return { context: existing, outcome: 'reused' };
    }
    if (existing.status !== 'open') {
      throw conflict(
        operation,
        `规划上下文状态 ${existing.status} 不接受候选发布（终态/取消不可发布）`,
        entity,
        { reason: 'context_not_open', status: existing.status },
      );
    }

    // 候选 Artifact 核对：同项目、ready 且内容摘要一致（正文由既有 Artifact 设施持有）。
    const artifactRow = db
      .prepare<[string], { project_id: string; status: string; content_hash: string | null }>(
        'SELECT project_id, status, content_hash FROM artifacts WHERE id = ?',
      )
      .get(valid.artifactId);
    if (artifactRow === undefined) {
      throw notFound(operation, { type: 'artifact', projectId: valid.projectId, id: valid.artifactId }, `候选 Artifact ${valid.artifactId} 不存在`);
    }
    if (artifactRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, '候选 Artifact 不属于声明的项目（跨项目目标被拒绝）');
    }
    if (artifactRow.status !== 'ready' || artifactRow.content_hash !== valid.contentHash) {
      throw conflict(
        operation,
        '候选 Artifact 未就绪或内容摘要不一致（发布绑定要求 ready 且 contentHash 一致）',
        entity,
        { reason: 'artifact_not_ready', artifactStatus: artifactRow.status },
      );
    }

    const timestamp = nowUtcMs();
    const updated = db
      .prepare(
        "UPDATE planning_contexts SET status = 'candidate_published', candidate_artifact_id = ?, " +
          'candidate_content_hash = ?, candidate_digest = ?, candidate_summary = ?, updated_at = ? ' +
          "WHERE id = ? AND status = 'open'",
      )
      .run(valid.artifactId, valid.contentHash, valid.candidateDigest, valid.summary, timestamp, existing.id);
    if (updated.changes !== 1) {
      throw conflict(operation, '候选发布被并发状态迁移抢先（条件更新未命中）', entity, { reason: 'publish_race' });
    }
    const published = getContextByCandidateRow(valid.projectId, valid.candidateId, operation);
    if (published === null) {
      throw corrupt(operation, entity, '规划上下文刚更新却无法读回', 'published_row_missing');
    }
    return { context: published, outcome: 'published' };
  }

  /* ------------------ 人工决策（candidate_published → applied/rejected） ------------------ */

  function decidePlanningCandidateInTransaction(input: unknown): PlanningContextRecord {
    const operation = 'PlanningContextStore.decide';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validatePlanningCandidateDecisionInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = { type: 'planning_context', projectId: valid.projectId, id: valid.candidateId };

    const existing = getContextByCandidateRow(valid.projectId, valid.candidateId, operation);
    if (existing === null) {
      throw notFound(operation, entity, `候选 ${valid.candidateId} 没有规划上下文`);
    }
    const target: PlanningContextStatus = valid.decision === 'approved' ? 'applied' : 'rejected';
    if (existing.status === target) {
      throw conflict(operation, `候选 ${valid.candidateId} 已决策为 ${target}（决策写一次，重放由命令幂等承担）`, entity, { reason: 'already_decided', status: existing.status });
    }
    assertPlanningContextTransition(existing.status, target, operation);

    const timestamp = nowUtcMs();
    const updated = db
      .prepare(
        'UPDATE planning_contexts SET status = ?, decision = ?, decision_reason = ?, decided_at = ?, ' +
          'applied_revision = ?, applied_at = ?, updated_at = ? WHERE id = ? AND status = ?',
      ).run(
        target,
        valid.decision,
        valid.reason,
        timestamp,
        valid.appliedRevision,
        valid.appliedRevision === null ? null : timestamp,
        timestamp,
        existing.id,
        existing.status,
      );
    if (updated.changes !== 1) {
      throw conflict(operation, '候选决策被并发状态迁移抢先（条件更新未命中）', entity, { reason: 'decide_race' });
    }
    const decided = getContextByCandidateRow(valid.projectId, valid.candidateId, operation);
    if (decided === null) {
      throw corrupt(operation, entity, '规划上下文刚更新却无法读回', 'decided_row_missing');
    }
    return decided;
  }

  return {
    createPlanningContextInTransaction,
    getPlanningContextByCandidate,
    getPlanningContextByRun,
    getActivePlanningContextForFeatureInTransaction,
    readPlanningInputPreparationView,
    publishPlanningCandidateInTransaction,
    decidePlanningCandidateInTransaction,
  };
}
