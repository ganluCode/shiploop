/**
 * P05-1 / F-011 规划上下文/候选只读授权查询窄端口的 SQLite 装配（adapters 层）。
 *
 * 不变量（与 ports/planning-query.ts 同一契约）：
 * - 全部读取以 BEGIN DEFERRED 一致读事务执行；本模块无任何写原语——不创建
 *   Attempt、不扣预算、不写事件、不触发模型/恢复/导入或状态变更；
 * - 详情视图（上下文 + planning Task 快照 + Run 控制事实 + 有界 Attempt 摘要
 *   + Feature 当前身份）在单一读事务内取得，并发决策/应用/取消只能观察到
 *   完整前后状态；损坏行（非法枚举/摘要/JSON/绑定漂移）fail-closed 为
 *   StorageError corrupt，不作为有效记录返回；
 * - 跨项目/不存在目标统一 undefined（存在性折叠由应用层完成）；列表可见
 *   范围谓词下推 SQL（visibility 非法形状为可信装配编程错误 TypeError），
 *   稳定 id 升序键集分页，父级跨项目返回空页（不泄漏存在性）；
 * - Feature 身份事实中的 codingTaskCount 只统计 kind='coding'（planning Task
 *   不计入业务 Task 数量）；
 * - import 本模块无副作用，会话生命周期由调用方管理。
 */
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import { assertPrincipalVisibility } from '../../ports/queries.js';
import type { PlanListRequest, PlanRecordPage } from '../../ports/queries.js';
import { PLANNING_RUN_PURPOSE } from '../../ports/planning-candidates.js';
import { validatePlanningContextRecord } from '../../ports/planning-context.js';
import type { PlanningContextRecord } from '../../ports/planning-context.js';
import {
  PLANNING_QUERY_DETAIL_ATTEMPTS_MAX_COUNT,
} from '../../ports/planning-query.js';
import type {
  PlanningContextListRow,
  PlanningContextQueryView,
  PlanningQueryAttemptFacts,
  PlanningQueryFeatureFacts,
  PlanningQueryReadStore,
  PlanningQueryRunFacts,
} from '../../ports/planning-query.js';
import { ATTEMPT_EXECUTION_STAGES, ATTEMPT_STATUSES } from '../../ports/attempt-store.js';
import { EXECUTION_RUN_STATUSES } from '../../ports/execution-store.js';
import { FEATURE_PLAN_STATUSES } from '../../ports/plan-store.js';
import { validateStableId } from '../../ports/validation.js';
import { transactSqliteConsistentRead, visibilityCondition } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'PlanningQueryStore';

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

interface RunFactsSqlRow {
  readonly id: string;
  readonly batch_id: string;
  readonly purpose: string;
  readonly status: string;
  readonly reason: string | null;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly pause_requested_at: number | null | undefined;
  readonly attempts_created: number;
  readonly max_attempts_per_run: number;
  readonly run_time_limit_ms: number;
}

interface AttemptFactsSqlRow {
  readonly id: string;
  readonly number: number;
  readonly status: string;
  readonly execution_stage: string;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly exit_code: number | null;
  readonly duration_ms: number | null;
}

interface FeatureFactsSqlRow {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly plan_status: string;
  readonly plan_digest: string | null;
  readonly coding_task_count: number;
}

/** 列表联表行（扁平列 + Run 状态摘要；better-sqlite3 返回扁平对象）。 */
interface PlanningContextListSqlRow extends PlanningContextSqlRow {
  readonly run_status: string | null;
  readonly run_ended_at: number | null;
}

function member<T extends string>(value: string, values: readonly T[], field: string): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new StorageError('corrupt', `${OPERATION}.read`, `规划查询持久行列 ${field} 非法（${value}）`, {
      entity: { type: 'planning_context' },
      details: { reason: 'invalid_planning_query_column', field },
    });
  }
  return value as T;
}

/** 行 + 绑定 planning Task 快照 → 端口记录（与 planning-context-store 同一校验）。 */
function contextFromRow(
  db: import('better-sqlite3').Database,
  row: PlanningContextSqlRow,
): PlanningContextRecord {
  const operation = `${OPERATION}.contextFromRow`;
  const entity: StorageEntityRef = { type: 'planning_context', projectId: row.project_id, id: row.id };
  const taskRow = db
    .prepare<[string, string], { kind: string; status: string; execution_config: string; config_source: string; config_source_key: string | null }>(
      'SELECT kind, status, execution_config, config_source, config_source_key FROM tasks WHERE id = ? AND feature_id = ?',
    )
    .get(row.planning_task_id, row.feature_id);
  if (taskRow === undefined) {
    throw new StorageError('corrupt', operation, '绑定的 planning Task 缺失（绑定漂移）', {
      entity, details: { reason: 'planning_task_missing' },
    });
  }
  let executionConfigValue: unknown;
  try {
    executionConfigValue = JSON.parse(taskRow.execution_config) as unknown;
  } catch (error) {
    throw new StorageError('corrupt', operation, 'planning Task 持久 JSON 损坏', {
      entity, details: { reason: 'invalid_execution_config_json' }, ...(error === undefined ? {} : { cause: error }),
    });
  }
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
      throw new StorageError('corrupt', operation, '规划上下文持久行损坏（枚举/摘要/JSON/一致性校验失败）', {
        entity, details: { reason: 'invalid_planning_context_row' }, cause: error,
      });
    }
    throw error;
  }
}

function runFactsFromRow(row: RunFactsSqlRow, projectId: string): PlanningQueryRunFacts {
  const entity: StorageEntityRef = { type: 'run', projectId, id: row.id };
  if (row.purpose !== PLANNING_RUN_PURPOSE) {
    throw new StorageError('corrupt', `${OPERATION}.read`, `绑定 Run 的 purpose 不是 ${PLANNING_RUN_PURPOSE}`, {
      entity, details: { reason: 'run_purpose_mismatch' },
    });
  }
  return {
    id: row.id,
    batchId: row.batch_id,
    purpose: PLANNING_RUN_PURPOSE,
    status: member(row.status, EXECUTION_RUN_STATUSES, 'runs.status'),
    reason: row.reason,
    startedAtUtcMs: row.started_at,
    endedAtUtcMs: row.ended_at,
    pauseRequestedAtUtcMs: row.pause_requested_at ?? null,
    attemptsCreated: row.attempts_created,
    maxAttemptsPerRun: row.max_attempts_per_run,
    runTimeLimitMs: row.run_time_limit_ms,
  };
}

function attemptFactsFromRow(row: AttemptFactsSqlRow, projectId: string): PlanningQueryAttemptFacts {
  return {
    id: row.id,
    number: row.number,
    status: member(row.status, ATTEMPT_STATUSES, 'attempts.status'),
    executionStage: member(row.execution_stage, ATTEMPT_EXECUTION_STAGES, 'attempts.execution_stage'),
    startedAtUtcMs: row.started_at,
    endedAtUtcMs: row.ended_at,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
  };
}

export interface SqlitePlanningQueryStoreOptions {
  /** 未提供时使用真实时钟（仅影响无时间字段的读取，本模块不写时间）。 */
  readonly nowUtcMs?: () => number;
}

export function createSqlitePlanningQueryStore(
  session: SqliteStorageSession,
  _options: SqlitePlanningQueryStoreOptions = {},
): PlanningQueryReadStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqlitePlanningQueryStore: session 必须是 SqliteStorageSession');
  }
  void _options;

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
    }
  }

  function readPlanningContextView(
    projectId: unknown,
    candidateId: unknown,
  ): PlanningContextQueryView | undefined {
    const operation = `${OPERATION}.readPlanningContextView`;
    assertOpen(operation);
    const context: import('../../ports/validation.js').ValidationContext = {
      operation,
      entity: { type: 'planning_context' },
    };
    const validProjectId = validateStableId(projectId, context, 'projectId');
    const validCandidateId = validateStableId(candidateId, context, 'candidateId');
    return transactSqliteConsistentRead(session, operation, (db) => {
      const row = db
        .prepare<[string, string], PlanningContextSqlRow>(
          `${SELECT_PLANNING_CONTEXT} WHERE project_id = ? AND candidate_id = ?`,
        )
        .get(validProjectId, validCandidateId);
      if (row === undefined) {
        return undefined;
      }
      const planningContext = contextFromRow(db, row);

      const runRow = db
        .prepare<[string, string], RunFactsSqlRow>(
          'SELECT id, batch_id, purpose, status, reason, started_at, ended_at, pause_requested_at, ' +
            'attempts_created, max_attempts_per_run, run_time_limit_ms FROM runs WHERE project_id = ? AND id = ?',
        )
        .get(validProjectId, row.run_id);
      if (runRow === undefined) {
        throw new StorageError('corrupt', operation, '规划上下文绑定的 Run 缺失', {
          entity: { type: 'planning_context', projectId: validProjectId, id: row.id },
          details: { reason: 'run_missing' },
        });
      }
      const run = runFactsFromRow(runRow, validProjectId);

      const attemptRows = db
        .prepare<[string, string, string, number], AttemptFactsSqlRow>(
          'SELECT id, number, status, execution_stage, started_at, ended_at, exit_code, duration_ms ' +
            'FROM attempts WHERE project_id = ? AND run_id = ? AND task_id = ? ORDER BY number DESC, id DESC ' +
            'LIMIT ?',
        )
        .all(validProjectId, row.run_id, row.planning_task_id, PLANNING_QUERY_DETAIL_ATTEMPTS_MAX_COUNT + 1);
      const attemptsTruncated = attemptRows.length > PLANNING_QUERY_DETAIL_ATTEMPTS_MAX_COUNT;
      const attempts = (attemptsTruncated
        ? attemptRows.slice(0, PLANNING_QUERY_DETAIL_ATTEMPTS_MAX_COUNT)
        : attemptRows
      )
        .map((attemptRow) => attemptFactsFromRow(attemptRow, validProjectId))
        .reverse();

      const featureRow = db
        .prepare<[string, string], FeatureFactsSqlRow>(
          'SELECT id, revision, status, plan_status, plan_digest, ' +
            "(SELECT COUNT(*) FROM tasks t WHERE t.feature_id = features.id AND t.project_id = features.project_id AND t.kind = 'coding') AS coding_task_count " +
            'FROM features WHERE project_id = ? AND id = ?',
        )
        .get(validProjectId, row.feature_id);
      if (featureRow === undefined) {
        throw new StorageError('corrupt', operation, '规划上下文绑定的 Feature 缺失', {
          entity: { type: 'planning_context', projectId: validProjectId, id: row.id },
          details: { reason: 'feature_missing' },
        });
      }
      const feature: PlanningQueryFeatureFacts = {
        id: featureRow.id,
        revision: featureRow.revision,
        status: featureRow.status,
        planStatus: member(featureRow.plan_status, FEATURE_PLAN_STATUSES, 'features.plan_status'),
        planDigest: featureRow.plan_digest,
        codingTaskCount: featureRow.coding_task_count,
      };

      return { context: planningContext, run, attempts, attemptsTruncated, feature };
    });
  }

  function listPlanningContextRecords(
    visibility: unknown,
    projectId: unknown,
    featureId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<PlanningContextListRow> {
    const operation = `${OPERATION}.listPlanningContexts`;
    assertOpen(operation);
    // 可见范围形状非法 = 可信装配编程错误（TypeError），不折算客户端错误。
    assertPrincipalVisibility(visibility);
    if (
      request === null ||
      typeof request !== 'object' ||
      (request.afterId !== null && (typeof request.afterId !== 'string' || request.afterId.length === 0)) ||
      typeof request.limit !== 'number' ||
      !Number.isInteger(request.limit) ||
      request.limit < 1
    ) {
      throw new TypeError(
        `${operation}: request 必须是 {afterId: string|null, limit: ≥1 整数}（已校验分页形态）`,
      );
    }
    const context: import('../../ports/validation.js').ValidationContext = {
      operation,
      entity: { type: 'planning_context' },
    };
    const validProjectId = validateStableId(projectId, context, 'projectId');
    const validFeatureId =
      featureId === null || featureId === undefined
        ? null
        : validateStableId(featureId, context, 'featureId');
    return transactSqliteConsistentRead(session, operation, (db) => {
      // 可见范围谓词下推 SQL（allowlist 不含目标项目 → 空页，不泄漏存在性）。
      const conditions = ['c.id > ?', 'c.project_id = ?'];
      const params: unknown[] = [request.afterId ?? '', validProjectId];
      if (validFeatureId !== null) {
        conditions.push('c.feature_id = ?');
        params.push(validFeatureId);
      }
      const visible = visibilityCondition(visibility, 'c.project_id');
      if (visible.condition !== undefined) {
        conditions.push(visible.condition);
        params.push(...visible.params);
      }
      params.push(request.limit + 1);
      const rows = db
        .prepare<unknown[], PlanningContextListSqlRow>(
          'SELECT c.id, c.created_at, c.project_id, c.updated_at, c.phase_id, c.feature_id, c.run_id, ' +
            'c.planning_task_id, c.candidate_id, c.input_digest, c.target_revision, c.plan_digest, ' +
            'c.candidate_artifact_id, c.candidate_content_hash, c.candidate_digest, c.candidate_summary, ' +
            'c.status, c.decision, c.decision_reason, c.decided_at, c.applied_revision, c.applied_at, ' +
            'r.status AS run_status, r.ended_at AS run_ended_at ' +
            'FROM planning_contexts c LEFT JOIN runs r ON r.id = c.run_id AND r.project_id = c.project_id ' +
            `WHERE ${conditions.join(' AND ')} ORDER BY c.id LIMIT ?`,
        )
        .all(...params);
      const hasMore = rows.length > request.limit;
      const pageRows = hasMore ? rows.slice(0, request.limit) : rows;
      return {
        records: pageRows.map((row) => ({
          context: contextFromRow(db, {
            id: row.id,
            created_at: row.created_at,
            project_id: row.project_id,
            updated_at: row.updated_at,
            phase_id: row.phase_id,
            feature_id: row.feature_id,
            run_id: row.run_id,
            planning_task_id: row.planning_task_id,
            candidate_id: row.candidate_id,
            input_digest: row.input_digest,
            target_revision: row.target_revision,
            plan_digest: row.plan_digest,
            candidate_artifact_id: row.candidate_artifact_id,
            candidate_content_hash: row.candidate_content_hash,
            candidate_digest: row.candidate_digest,
            candidate_summary: row.candidate_summary,
            status: row.status,
            decision: row.decision,
            decision_reason: row.decision_reason,
            decided_at: row.decided_at,
            applied_revision: row.applied_revision,
            applied_at: row.applied_at,
          }),
          runStatus: row.run_status === null ? null : member(row.run_status, EXECUTION_RUN_STATUSES, 'runs.status'),
          runEndedAtUtcMs: row.run_ended_at,
        })),
        nextId: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
      };
    });
  }

  return { readPlanningContextView, listPlanningContextRecords };
}
