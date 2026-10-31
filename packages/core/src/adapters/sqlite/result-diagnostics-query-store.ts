/**
 * P07-4 / F-001 结果诊断分页只读窄端口的 SQLite 装配（adapters 层）。
 *
 * 不变量（与 ports/result-diagnostics-query.ts 同一契约）：
 * - 整页组装位于单一 BEGIN DEFERRED 一致读事务（复用
 *   transactSqliteConsistentRead）；本模块无任何写原语——不创建 Attempt、
 *   不扣预算、不续租、不写事件、不触发取消或执行；
 * - 复用既有行映射与校验（attemptFromRow / workSessionRecordFromRow /
 *   verificationBatchRecordFromRow / checkResultRecordFromRow /
 *   gitOperationRecordFromRow / artifactFromRow / 通知诊断校验），不建立
 *   第二套规则；损坏持久行 fail-closed（StorageError corrupt）；
 * - 跨项目/不存在父级统一 undefined（存在性折叠由应用层完成）；行内归属
 *   与父级不一致是 corrupt（防御纵深），绝不静默跳过；
 * - 键集分页：复合排序键（Attempt number, Attempt id）排他下界、稳定排序；
 * - 证据索引只按受控 locator 前缀（sessions/<id>/ 与 attempts/<id>/）精确
 *   匹配（substr 等值，不用 LIKE 通配），绝不接受任意路径；
 * - import 本模块无副作用，会话生命周期由调用方管理。
 */
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import type { ExecutionBatchStatus, ExecutionRunStatus } from '../../ports/execution-store.js';
import { EXECUTION_BATCH_STATUSES } from '../../ports/execution-store.js';
import { TASK_STATUSES, FEATURE_STATUSES } from '../../ports/plan-store.js';
import type { TaskStatus, FeatureStatus } from '../../ports/plan-store.js';
import { FEATURE_DELIVERY_STATUSES } from '../../ports/git-operations.js';
import type { FeatureDeliveryStatus } from '../../ports/git-operations.js';
import { validateAttemptNotificationDiagnosticRecord } from '../../ports/execution-schedule-query.js';
import type { ExecutionListRequest } from '../../ports/execution-schedule-query.js';
import { WORK_SESSION_DETAIL_DIAGNOSTICS_MAX_COUNT, WORK_SESSION_DETAIL_EVIDENCE_MAX_COUNT } from '../../ports/work-session-query.js';
import {
  RESULT_DIAGNOSTICS_STOP_OPERATIONS_MAX_COUNT,
  RESULT_DIAGNOSTICS_VERIFICATION_CHECKS_MAX_COUNT,
  RESULT_DIAGNOSTICS_GIT_OPERATIONS_MAX_COUNT,
} from '../../ports/result-diagnostics-query.js';
import type {
  BatchDeliveryStopRecord,
} from '../../ports/batch-delivery-query.js';
import type {
  ResultDiagnosticsPage,
  ResultDiagnosticsParent,
  ResultDiagnosticsQueryReadStore,
  ResultDiagnosticsRow,
  ResultDiagnosticsScope,
} from '../../ports/result-diagnostics-query.js';
import { attemptFromRow } from './attempt-store.js';
import type { AttemptRow } from './attempt-store.js';
import { artifactFromRow } from './artifact-store.js';
import type { ArtifactRow } from './artifact-store.js';
import { SESSION_COLUMNS, workSessionRecordFromRow } from './work-session-store.js';
import type { SessionRow } from './work-session-store.js';
import { VERIFICATION_BATCH_COLUMNS, CHECK_RESULT_COLUMNS, verificationBatchRecordFromRow, checkResultRecordFromRow } from './verification-store.js';
import type { VerificationBatchRow, CheckResultRow } from './verification-store.js';
import { GIT_OPERATION_COLUMNS, gitOperationRecordFromRow } from './git-operations.js';
import type { GitOperationRow } from './git-operations.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'ResultDiagnosticsQueryStore';
const RUN_STATUSES = EXECUTION_BATCH_STATUSES;
const STOP_STATUSES = ['stopping', 'stopped', 'uncertain'] as const;

interface RunFactsRow {
  readonly id: string;
  readonly project_id: string;
  readonly batch_id: string;
  readonly status: string;
  readonly reason: string | null;
}
interface PlanFactsRow {
  readonly task_status: string;
  readonly feature_status: string;
  readonly delivery_status: string;
}
interface StopRow {
  readonly id: string; readonly project_id: string; readonly target_kind: string; readonly target_id: string;
  readonly batch_id: string; readonly feature_id: string | null; readonly run_id: string | null;
  readonly reason: string; readonly status: string; readonly stop_confirmed: number | null;
  readonly forced: number | null; readonly evidence_ref: string | null;
  readonly requested_at: number; readonly settled_at: number | null;
}
interface DiagnosticRow {
  readonly id: string; readonly project_id: string; readonly attempt_id: string;
  readonly notification_digest: string; readonly reason: string; readonly occurred_at: number;
}

function corrupt(message: string, entity?: StorageEntityRef): never {
  throw new StorageError('corrupt', OPERATION, message, { ...(entity === undefined ? {} : { entity }) });
}
function idOf(value: unknown, field: string): string {
  try {
    return validateStableId(value, { operation: OPERATION }, field);
  } catch {
    return corrupt(`${field} 损坏`);
  }
}
function stopFromRow(row: StopRow, projectId: string): BatchDeliveryStopRecord {
  const operationId = idOf(row.id, 'stopOperationId');
  if (row.project_id !== projectId || !STOP_STATUSES.includes(row.status as typeof STOP_STATUSES[number])) {
    corrupt('停止操作归属或状态损坏', { type: 'execution_batch', projectId, id: row.id });
  }
  if (!['run', 'batch', 'feature'].includes(row.target_kind) || idOf(row.target_id, 'targetId') !== row.target_id) {
    corrupt('停止操作目标损坏', { type: 'execution_batch', projectId, id: row.id });
  }
  if (row.stop_confirmed !== null && row.stop_confirmed !== 0 && row.stop_confirmed !== 1) corrupt('stopConfirmed 损坏');
  if (row.forced !== null && row.forced !== 0 && row.forced !== 1) corrupt('forced 损坏');
  if (row.evidence_ref !== null && (row.evidence_ref.length === 0 || row.evidence_ref.length > 128)) corrupt('停止证据引用损坏');
  const requestedAtUtcMs = row.requested_at;
  const settledAtUtcMs = row.settled_at;
  if (typeof requestedAtUtcMs !== 'number' || !Number.isSafeInteger(requestedAtUtcMs) || requestedAtUtcMs < 1
    || (settledAtUtcMs !== null && (typeof settledAtUtcMs !== 'number' || !Number.isSafeInteger(settledAtUtcMs) || settledAtUtcMs < requestedAtUtcMs))) {
    corrupt('停止时间顺序损坏', { type: 'execution_batch', projectId, id: row.id });
  }
  return {
    operationId,
    targetKind: row.target_kind as BatchDeliveryStopRecord['targetKind'],
    targetId: row.target_id,
    status: row.status as BatchDeliveryStopRecord['status'],
    reason: row.reason,
    stopConfirmed: row.stop_confirmed === null ? null : row.stop_confirmed === 1,
    forced: row.forced === null ? null : row.forced === 1,
    evidenceRef: row.evidence_ref,
    requestedAtUtcMs,
    settledAtUtcMs,
  };
}
function diagnosticFromRow(row: DiagnosticRow) {
  try {
    return validateAttemptNotificationDiagnosticRecord({
      id: row.id,
      projectId: row.project_id,
      attemptId: row.attempt_id,
      notificationDigest: row.notification_digest,
      reason: row.reason,
      occurredAtUtcMs: row.occurred_at,
    });
  } catch {
    return corrupt('通知诊断行损坏', { type: 'attempt', id: row.attempt_id, projectId: row.project_id });
  }
}
/** SQLite 装配：只读一致视图 + 键集分页；不创建 Attempt、不续租、不写事件。 */
export function createSqliteResultDiagnosticsQueryStore(
  session: SqliteStorageSession,
): ResultDiagnosticsQueryReadStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqliteResultDiagnosticsQueryStore: session 必须是 SqliteStorageSession');
  }
  const db = session.database;

  function assertRequest(request: ExecutionListRequest): void {
    if (request === null || typeof request !== 'object' || !Number.isSafeInteger(request.limit)
      || request.limit < 1 || (request.after !== null && (typeof request.after !== 'object'
        || !Number.isSafeInteger(request.after.sort) || request.after.sort < 0
        || typeof request.after.id !== 'string' || request.after.id.length === 0))) {
      throw new TypeError(`${OPERATION}: 非法 ExecutionListRequest（可信装配编程错误）`);
    }
  }

  function readRow(attemptId: string, projectId: string): ResultDiagnosticsRow {
    const attemptRow = db.prepare<[string], AttemptRow>('SELECT * FROM attempts WHERE id = ?').get(attemptId);
    if (attemptRow === undefined || attemptRow.project_id !== projectId) {
      corrupt('页内 Attempt 在同事务内消失', { type: 'attempt', projectId, id: attemptId });
    }
    const attempt = attemptFromRow(attemptRow);
    const sessionRow = db.prepare<[string], SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE attempt_id = ? AND kind = 'work'`).get(attemptId);
    if (sessionRow !== undefined && (sessionRow.project_id !== projectId || sessionRow.attempt_id !== attemptId)) {
      corrupt('Work Session 归属不一致', { type: 'work_session', projectId, id: sessionRow.id });
    }
    const workSession = sessionRow === undefined ? null : workSessionRecordFromRow(sessionRow);
    const runRow = db.prepare<[string, string], RunFactsRow>(
      'SELECT id, project_id, batch_id, status, reason FROM runs WHERE id = ? AND project_id = ?').get(attempt.runId, projectId);
    if (runRow === undefined || runRow.id !== attempt.runId || !RUN_STATUSES.includes(runRow.status as typeof RUN_STATUSES[number])) {
      corrupt('Run 归属或状态损坏', { type: 'run', projectId, id: attempt.runId });
    }
    const planRow = db.prepare<[string, string], PlanFactsRow>(
      `SELECT t.status AS task_status, f.status AS feature_status, f.delivery_status
       FROM tasks t JOIN features f ON f.id = t.feature_id AND f.project_id = t.project_id
       WHERE t.id = ? AND t.project_id = ?`).get(attempt.taskId, projectId);
    if (planRow === undefined || !TASK_STATUSES.includes(planRow.task_status as TaskStatus)
      || !FEATURE_STATUSES.includes(planRow.feature_status as FeatureStatus)
      || !FEATURE_DELIVERY_STATUSES.includes(planRow.delivery_status as FeatureDeliveryStatus)) {
      corrupt('Task/Feature 持久状态损坏', { type: 'task', projectId, id: attempt.taskId });
    }
    const manualBlockPending = db.prepare<[string, string], { count: number }>(
      `SELECT count(*) AS count FROM task_approval_items
       WHERE project_id = ? AND task_id = ? AND kind = 'block' AND status = 'pending'`).get(projectId, attempt.taskId)!.count > 0;

    const diagnosticRows = db.prepare<[string, string, number], DiagnosticRow>(
      `SELECT id, project_id, attempt_id, notification_digest, reason, occurred_at
       FROM attempt_notification_diagnostics WHERE project_id = ? AND attempt_id = ?
       ORDER BY occurred_at, id LIMIT ?`).all(projectId, attemptId, RESULT_DIAGNOSTICS_STOP_OPERATIONS_MAX_COUNT + 1);
    const diagnosticsTruncated = diagnosticRows.length > RESULT_DIAGNOSTICS_STOP_OPERATIONS_MAX_COUNT;
    const diagnostics = diagnosticRows.slice(0, RESULT_DIAGNOSTICS_STOP_OPERATIONS_MAX_COUNT).map(diagnosticFromRow);

    const stopRows = db.prepare<[string, string, string, number], StopRow>(
      `SELECT * FROM execution_stop_operations WHERE project_id = ?
       AND (run_id = ? OR (target_kind = 'batch' AND batch_id = ?))
       ORDER BY id LIMIT ?`).all(projectId, attempt.runId, runRow.batch_id, RESULT_DIAGNOSTICS_STOP_OPERATIONS_MAX_COUNT + 1);
    const stopOperationsTruncated = stopRows.length > RESULT_DIAGNOSTICS_STOP_OPERATIONS_MAX_COUNT;
    const stopOperations = stopRows.slice(0, RESULT_DIAGNOSTICS_STOP_OPERATIONS_MAX_COUNT).map(row => stopFromRow(row, projectId));

    const verificationRow = db.prepare<[string, string], VerificationBatchRow>(
      `SELECT ${VERIFICATION_BATCH_COLUMNS} FROM verification_batches
       WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(projectId, attempt.taskId);
    let verification: ResultDiagnosticsRow['verification'] = null;
    let verificationChecksTruncated = false;
    if (verificationRow !== undefined) {
      const batch = verificationBatchRecordFromRow(verificationRow);
      const checkRows = db.prepare<[string, string, number], CheckResultRow>(
        `SELECT ${CHECK_RESULT_COLUMNS} FROM check_results WHERE project_id = ? AND batch_id = ? ORDER BY id LIMIT ?`)
        .all(projectId, batch.id, RESULT_DIAGNOSTICS_VERIFICATION_CHECKS_MAX_COUNT + 1);
      verificationChecksTruncated = checkRows.length > RESULT_DIAGNOSTICS_VERIFICATION_CHECKS_MAX_COUNT;
      verification = {
        batchId: batch.id,
        operation: batch.operation,
        status: batch.status,
        endedAtUtcMs: batch.endedAtUtcMs,
        checks: checkRows.slice(0, RESULT_DIAGNOSTICS_VERIFICATION_CHECKS_MAX_COUNT).map(row => {
          const record = checkResultRecordFromRow(row);
          return { checkKey: record.checkKey, status: record.status, outputArtifactId: record.outputArtifactId };
        }),
      };
    }

    const gitRows = db.prepare<[string, string, number], GitOperationRow>(
      `SELECT ${GIT_OPERATION_COLUMNS} FROM git_operations WHERE project_id = ? AND run_id = ? ORDER BY id LIMIT ?`)
      .all(projectId, attempt.runId, RESULT_DIAGNOSTICS_GIT_OPERATIONS_MAX_COUNT + 1);
    const gitOperationsTruncated = gitRows.length > RESULT_DIAGNOSTICS_GIT_OPERATIONS_MAX_COUNT;
    const gitOperations = gitRows.slice(0, RESULT_DIAGNOSTICS_GIT_OPERATIONS_MAX_COUNT).map(row => {
      const record = gitOperationRecordFromRow(row, OPERATION);
      return { operationId: record.intent.operationId, operationType: record.intent.operationType, status: record.status };
    });

    const prefixes = workSession === null
      ? [`attempts/${attemptId}/`]
      : [`sessions/${workSession.id}/`, `attempts/${attemptId}/`];
    const prefixCondition = prefixes.map(prefix => `substr(storage_locator, 1, ${prefix.length}) = ?`).join(' OR ');
    const evidenceRows = db.prepare<unknown[], ArtifactRow>(
      `SELECT * FROM artifacts WHERE project_id = ? AND (${prefixCondition}) ORDER BY storage_locator, id LIMIT ?`)
      .all(projectId, ...prefixes, WORK_SESSION_DETAIL_EVIDENCE_MAX_COUNT + 1);
    const evidenceTruncated = evidenceRows.length > WORK_SESSION_DETAIL_EVIDENCE_MAX_COUNT;
    const evidenceContext: ValidationContext = { operation: OPERATION, entity: { type: 'artifact', projectId } };
    const evidence = evidenceRows.slice(0, WORK_SESSION_DETAIL_EVIDENCE_MAX_COUNT).map(row => artifactFromRow(row, evidenceContext));

    return {
      attempt,
      session: workSession,
      run: { runId: runRow.id, batchId: runRow.batch_id, runStatus: runRow.status as ExecutionRunStatus, runReason: runRow.reason },
      plan: {
        taskStatus: planRow.task_status as TaskStatus,
        featureStatus: planRow.feature_status as FeatureStatus,
        featureDeliveryStatus: planRow.delivery_status as FeatureDeliveryStatus,
        manualBlockPending,
      },
      diagnostics,
      diagnosticsTruncated,
      stopOperations,
      stopOperationsTruncated,
      verification,
      verificationChecksTruncated,
      gitOperations,
      gitOperationsTruncated,
      evidence,
      evidenceTruncated,
    };
  }

  return {
    readResultDiagnosticsPage(project, parentInput, request) {
      const projectId = validateStableId(project, { operation: OPERATION }, 'projectId');
      const parent: ResultDiagnosticsParent = parentInput;
      assertRequest(request);
      if (!session.isOpen()) throw new StorageError('corrupt', OPERATION, 'Storage session is closed');
      const assemble = (): ResultDiagnosticsPage | undefined => {
        let scope: ResultDiagnosticsScope;
        let attemptFilter: { readonly clause: string; readonly params: readonly unknown[] };
        if (parent.kind === 'batch') {
          const row = db.prepare<[string], { id: string; project_id: string; status: string }>(
            'SELECT id, project_id, status FROM execution_batches WHERE id = ?').get(parent.batchId);
          if (row === undefined || row.project_id !== projectId) return undefined;
          if (!EXECUTION_BATCH_STATUSES.includes(row.status as ExecutionBatchStatus)) {
            corrupt('Batch 状态损坏', { type: 'execution_batch', projectId, id: row.id });
          }
          scope = { kind: 'batch', batchId: row.id, batchStatus: row.status as ExecutionBatchStatus };
          attemptFilter = {
            clause: 'a.run_id IN (SELECT r.id FROM runs r WHERE r.project_id = a.project_id AND r.batch_id = ?)',
            params: [row.id],
          };
        } else if (parent.kind === 'run') {
          const row = db.prepare<[string], RunFactsRow>(
            'SELECT id, project_id, batch_id, status, reason FROM runs WHERE id = ?').get(parent.runId);
          if (row === undefined || row.project_id !== projectId) return undefined;
          if (!RUN_STATUSES.includes(row.status as typeof RUN_STATUSES[number])) {
            corrupt('Run 状态损坏', { type: 'run', projectId, id: row.id });
          }
          scope = { kind: 'run', runId: row.id, batchId: row.batch_id, runStatus: row.status as ExecutionRunStatus, runReason: row.reason };
          attemptFilter = { clause: 'a.run_id = ?', params: [row.id] };
        } else if (parent.kind === 'attempt') {
          const row = db.prepare<[string], { id: string; project_id: string; run_id: string }>(
            'SELECT id, project_id, run_id FROM attempts WHERE id = ?').get(parent.attemptId);
          if (row === undefined || row.project_id !== projectId) return undefined;
          const runRow = db.prepare<[string, string], { batch_id: string }>(
            'SELECT batch_id FROM runs WHERE id = ? AND project_id = ?').get(row.run_id, projectId);
          if (runRow === undefined) corrupt('Attempt 引用的 Run 缺失', { type: 'run', projectId, id: row.run_id });
          scope = { kind: 'attempt', attemptId: row.id, runId: row.run_id, batchId: runRow.batch_id };
          attemptFilter = { clause: 'a.id = ?', params: [row.id] };
        } else {
          const row = db.prepare<[string], { id: string; project_id: string; attempt_id: string | null; kind: string }>(
            "SELECT id, project_id, attempt_id, kind FROM sessions WHERE id = ? AND kind = 'work'").get(parent.sessionId);
          if (row === undefined || row.project_id !== projectId || row.attempt_id === null) return undefined;
          const attemptRow = db.prepare<[string], { id: string; project_id: string; run_id: string }>(
            'SELECT id, project_id, run_id FROM attempts WHERE id = ?').get(row.attempt_id);
          if (attemptRow === undefined || attemptRow.project_id !== projectId) return undefined;
          const runRow = db.prepare<[string, string], { batch_id: string }>(
            'SELECT batch_id FROM runs WHERE id = ? AND project_id = ?').get(attemptRow.run_id, projectId);
          if (runRow === undefined) corrupt('Session 引用的 Run 缺失', { type: 'run', projectId, id: attemptRow.run_id });
          scope = { kind: 'session', sessionId: row.id, attemptId: attemptRow.id, runId: attemptRow.run_id, batchId: runRow.batch_id };
          attemptFilter = { clause: 'a.id = ?', params: [attemptRow.id] };
        }
        const pageRows = db.prepare<unknown[], { id: string; number: number }>(
          `SELECT a.id, a.number FROM attempts a WHERE a.project_id = ? AND ${attemptFilter.clause}
           AND (a.number > ? OR (a.number = ? AND a.id > ?)) ORDER BY a.number, a.id LIMIT ?`)
          .all(projectId, ...attemptFilter.params,
            request.after?.sort ?? -1, request.after?.sort ?? -1, request.after?.id ?? '', request.limit + 1);
        const kept = pageRows.length > request.limit ? pageRows.slice(0, request.limit) : pageRows;
        const records = kept.map(row => readRow(row.id, projectId));
        const last = kept[kept.length - 1];
        const eventWatermark = db.prepare<[string], { value: number }>(
          'SELECT COALESCE(MAX(sequence), 0) AS value FROM state_events WHERE project_id = ?').get(projectId)!.value;
        return {
          scope,
          records,
          nextKey: pageRows.length > request.limit && last !== undefined ? { sort: last.number, id: last.id } : null,
          eventWatermark,
        };
      };
      return db.inTransaction ? assemble() : transactSqliteConsistentRead(session, OPERATION, assemble);
    },
  };
}
