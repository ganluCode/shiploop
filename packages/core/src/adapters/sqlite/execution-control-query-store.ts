/**
 * P03-9 / F-013 Run/Batch 控制进度、恢复诊断与 finalization 收尾结果只读查询
 * 的 SQLite 装配（adapters 层）。
 *
 * 不变量（与 ports/execution-control-query.ts 同一契约）：
 * - 全部读取以 BEGIN DEFERRED 一致读事务执行；本模块无任何写原语——不改
 *   Run/Batch/Attempt/租约/停止 operation 状态、不写事件、不触发执行；
 * - 跨项目/不存在目标统一 undefined（存在性折叠由应用层完成，绝不区分
 *   「不存在」与「属于其他项目」）；持久行/JSON 损坏 fail-closed
 *  （StorageError corrupt），不把损坏内容折算成空结果；
 * - Attempt 行经既有 attemptFromRow 校验（含 input_snapshot.recovery 的
 *   F-007 记录校验）；finalization scope 经 ports 校验，损坏折算 corrupt；
 * - 分轴事实复用 F-010(P03-8) FeatureDeliveryQueryReadStore（同一会话、
 *   同一读事务，不另立第二套事实源）；列表有界扫描（上限+1 检测截断）；
 * - import 本模块无副作用，会话生命周期由调用方管理。
 */
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import type { AttemptRow } from './attempt-store.js';
import { attemptFromRow, leaseFromRow, type LeaseRow } from './attempt-store.js';
import {
  createSqliteExecutionAccess,
} from './execution-store.js';
import { GIT_OPERATION_COLUMNS, gitOperationRecordFromRow } from './git-operations.js';
import type {
  ExecutionBatchControlView,
  ExecutionControlLeaseEntry,
  ExecutionControlQueryReadStore,
  ExecutionRunControlView,
  ExecutionRunRecoveryContinuationEntry,
  ExecutionRunRecoveryObservationEntry,
  ExecutionRunRecoveryStartupView,
  ExecutionRunRecoveryView,
  ExecutionResourceListPage,
  ExecutionResourceListRequest,
  ExecutionResourceListSelector,
  ExecutionResourceQueryRow,
} from '../../ports/execution-control-query.js';
import {
  EXECUTION_CONTROL_ATTEMPTS_MAX,
  EXECUTION_CONTROL_RUNS_MAX,
  EXECUTION_CONTROL_STOP_OPERATIONS_MAX,
  EXECUTION_RECOVERY_CONTINUATIONS_MAX,
  EXECUTION_RECOVERY_GIT_OPERATIONS_MAX,
  EXECUTION_RECOVERY_OBSERVATIONS_MAX,
  validateRunFinalizationScope,
} from '../../ports/execution-control-query.js';
import type {
  ExecutionBatchRecord,
  ExecutionStopOperationRecord,
  RunRecord,
} from '../../ports/execution-store.js';
import type { FeatureDeliveryQueryReadStore, FeatureDeliveryView } from '../../ports/feature-delivery-query.js';
import { createSqliteFeatureDeliveryQueryStore } from './feature-delivery-query-store.js';
import { createSqliteFeatureResourceAccess } from './feature-resources.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'ExecutionControlQueryStore';

function stableId(operation: string, value: unknown, field: string): string {
  const context: ValidationContext = { operation };
  return validateStableId(value, context, field);
}

function corrupt(operation: string, message: string, projectId: string, targetId: string): StorageError {
  return new StorageError('corrupt', operation, message, {
    entity: { type: 'run', id: targetId, projectId },
  });
}

interface RunSqlRow {
  readonly id: string;
  readonly project_id: string;
}

/** 停止 operation 行（与 execution-store 同名列；只读映射，不导出写面）。 */
interface StopOperationRow {
  readonly id: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly command_id: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly batch_id: string;
  readonly feature_id: string | null;
  readonly run_id: string | null;
  readonly reason: string;
  readonly status: string;
  readonly requested_at: number;
  readonly settled_at: number | null;
  readonly evidence_ref: string | null;
  readonly stop_confirmed: number | null;
  readonly forced: number | null;
  readonly checked_at: number | null;
}

interface LeaseRowWithAttempt extends LeaseRow {
  readonly attempt_id: string;
}

export function createSqliteExecutionControlQueryStore(
  session: SqliteStorageSession,
  deliveryReads?: FeatureDeliveryQueryReadStore,
): ExecutionControlQueryReadStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqliteExecutionControlQueryStore: session 必须是 SqliteStorageSession');
  }
  const execution = createSqliteExecutionAccess(session);
  const featureResources = createSqliteFeatureResourceAccess(session);
  const delivery: FeatureDeliveryQueryReadStore =
    deliveryReads ?? createSqliteFeatureDeliveryQueryStore(session);

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new StorageError('corrupt', operation, 'Storage session is closed');
    }
  }

  function read<T>(operation: string, fn: () => T): T {
    assertOpen(operation);
    return session.database.inTransaction ? fn() : transactSqliteConsistentRead(session, operation, fn);
  }

  function runFromRow(operation: string, row: RunSqlRow, projectId: string): RunRecord {
    try {
      return execution.getExecutionRunInTransaction(projectId, row.id);
    } catch (error) {
      throw corrupt(operation, `run 行损坏: ${(error as Error).message}`, projectId, row.id);
    }
  }

  function batchFromRow(operation: string, batchId: string, projectId: string): ExecutionBatchRecord {
    let record: ExecutionBatchRecord | undefined;
    try {
      record = execution.getExecutionBatchInTransaction(projectId, batchId);
    } catch (error) {
      // Run 存在但父 Batch 不可读（跨项目/缺失）属于持久不一致，fail-closed。
      throw corrupt(operation, `batch 行损坏: ${(error as Error).message}`, projectId, batchId);
    }
    if (record === undefined) {
      throw corrupt(operation, 'batch 行损坏', projectId, batchId);
    }
    return record;
  }

  function stopOperationFromRow(row: StopOperationRow): ExecutionStopOperationRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      revision: row.revision,
      commandId: row.command_id,
      targetKind: row.target_kind as 'run' | 'batch' | 'feature',
      targetId: row.target_id,
      batchId: row.batch_id,
      featureId: row.feature_id,
      runId: row.run_id,
      reason: row.reason,
      status: row.status as 'stopping' | 'stopped' | 'uncertain',
      requestedAtUtcMs: row.requested_at,
      settledAtUtcMs: row.settled_at,
      createdAtUtcMs: row.created_at,
      updatedAtUtcMs: row.updated_at,
      evidenceRef: row.evidence_ref,
      stopConfirmed: row.stop_confirmed === null ? null : row.stop_confirmed === 1,
      forced: row.forced === null ? null : row.forced === 1,
      checkedAtUtcMs: row.checked_at,
    };
  }

  /** 目标关联停止 operation：run 级（run_id）+ batch 级目标（target_id=batch）。 */
  function listStopOperations(projectId: string, batchId: string, runId: string | null): readonly ExecutionStopOperationRecord[] {
    const rows = runId === null
      ? session.database
          .prepare<[string, string, number], StopOperationRow>(
            `SELECT * FROM execution_stop_operations
             WHERE project_id = ? AND target_kind = 'batch' AND target_id = ?
             ORDER BY requested_at, id LIMIT ?`,
          )
          .all(projectId, batchId, EXECUTION_CONTROL_STOP_OPERATIONS_MAX)
      : session.database
          .prepare<[string, string, string, number], StopOperationRow>(
            `SELECT * FROM execution_stop_operations
             WHERE project_id = ? AND (run_id = ? OR (target_kind = 'batch' AND target_id = ?))
             ORDER BY requested_at, id LIMIT ?`,
          )
          .all(projectId, runId, batchId, EXECUTION_CONTROL_STOP_OPERATIONS_MAX);
    return rows.map(stopOperationFromRow);
  }

  /** 目标 Attempt 的未释放租约（含 held/quarantined；稳定 (owner,resource_key) 序）。 */
  function listLeases(projectId: string, attemptIds: readonly string[]): readonly ExecutionControlLeaseEntry[] {
    const entries: ExecutionControlLeaseEntry[] = [];
    for (const attemptId of attemptIds) {
      const rows = session.database
        .prepare<[string, string], LeaseRowWithAttempt>(
          `SELECT leases.*, owner.id AS attempt_id FROM workspace_leases AS leases
           JOIN attempts AS owner ON owner.project_id = leases.project_id AND owner.id = leases.owner_id
           WHERE leases.project_id = ? AND leases.owner_id = ?
           ORDER BY leases.resource_key, leases.id`,
        )
        .all(projectId, attemptId);
      for (const row of rows) {
        const { attempt_id: _attemptId, ...leaseRow } = row;
        entries.push({ lease: leaseFromRow(leaseRow), attemptId });
      }
    }
    return entries;
  }

  function listRunAttempts(
    projectId: string,
    runId: string,
    operation: string,
    limit: number,
  ): { attempts: ReturnType<typeof attemptFromRow>[]; truncated: boolean; scanned: number } {
    const rows = session.database
      .prepare<[string, string, number], AttemptRow>(
        'SELECT * FROM attempts WHERE project_id = ? AND run_id = ? ORDER BY task_id, number, id LIMIT ?',
      )
      .all(projectId, runId, limit + 1);
    const truncated = rows.length > limit;
    const visible = truncated ? rows.slice(0, limit) : rows;
    const attempts = visible.map((row) => {
      try {
        return attemptFromRow(row);
      } catch (error) {
        throw corrupt(operation, `attempt 行损坏: ${(error as Error).message}`, projectId, row.id);
      }
    });
    return { attempts, truncated, scanned: rows.length };
  }

  function listFeatureResources(
    projectId: string,
    request: ExecutionResourceListRequest,
    selector: ExecutionResourceListSelector | undefined,
    operation: string,
  ): ExecutionResourceListPage {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 200) {
      throw new StorageError('validation', operation, '资源查询分页上限非法', {
        details: { field: 'limit', reason: 'invalid_limit' },
      });
    }
    const leases = featureResources.listProjectInTransaction(projectId);
    const rows: ExecutionResourceQueryRow[] = [];
    for (const lease of leases) {
      const owner = session.database.prepare<[string, string, number], {
        readonly feature_id: string;
        readonly run_id: string;
        readonly batch_id: string;
        readonly run_feature_id: string;
      }>(
        `SELECT claims.feature_id, claims.run_id, runs.batch_id, runs.feature_id AS run_feature_id
         FROM run_dispatch_claims AS claims
         JOIN runs ON runs.project_id = claims.project_id AND runs.id = claims.run_id
         WHERE claims.project_id = ? AND claims.id = ? AND claims.claim_version = ?`,
      ).get(projectId, lease.ownerId, lease.ownerVersion);
      if (owner === undefined || owner.feature_id !== owner.run_feature_id) {
        throw corrupt(operation, '资源租约缺少一致的派发归属', projectId, lease.id);
      }
      if (selector?.featureId !== undefined && owner.feature_id !== selector.featureId) continue;
      if (selector?.batchId !== undefined && owner.batch_id !== selector.batchId) continue;
      rows.push({
        lease,
        featureId: owner.feature_id,
        batchId: owner.batch_id,
        runId: owner.run_id,
      });
    }
    rows.sort((a, b) => a.lease.acquiredAtUtcMs - b.lease.acquiredAtUtcMs || a.lease.id.localeCompare(b.lease.id));
    const after = request.after;
    const visible = after === null
      ? rows
      : rows.filter((row) => row.lease.acquiredAtUtcMs > after.sort ||
          (row.lease.acquiredAtUtcMs === after.sort && row.lease.id > after.id));
    const truncated = visible.length > request.limit;
    const records = (truncated ? visible.slice(0, request.limit) : visible);
    const last = records[records.length - 1];
    return {
      records,
      nextKey: truncated && last !== undefined
        ? { sort: last.lease.acquiredAtUtcMs, id: last.lease.id }
        : null,
    };
  }

  /* ------------------------------------------------------------ *
   * P07-1 / F-009：启动恢复诊断（同一一致读内组装；只读，零写入）。   *
   * ------------------------------------------------------------ */

  function recoveryObservationFromRow(
    operation: string,
    projectId: string,
    runId: string,
    row: { readonly attempt_id: string | null; readonly payload: string; readonly occurred_at: number },
  ): ExecutionRunRecoveryObservationEntry {
    const message = '恢复观察事件损坏';
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch (error) {
      throw corrupt(operation, `${message}: ${(error as Error).message}`, projectId, runId);
    }
    // 未知 schemaVersion/kind/phase fail-closed：不猜测降级解释。
    if (payload.schemaVersion !== 1 || payload.kind !== 'work-startup-recovery'
      || (payload.phase !== 'observed' && payload.phase !== 'recorded' && payload.phase !== 'reprobed')
      || payload.attemptId !== row.attempt_id || payload.projectId !== projectId || payload.runId !== runId
      || typeof payload.stopConfirmed !== 'boolean' || typeof payload.observedAtUtcMs !== 'number'
      || !Array.isArray(payload.gaps) || payload.gaps.length > 64
      || payload.gaps.some((gap) => typeof gap !== 'string' || gap.length === 0 || gap.length > 128)
      || (payload.evidenceRef !== null && payload.evidenceRef !== undefined && typeof payload.evidenceRef !== 'string')
      || (payload.observationRevision !== undefined
        && (typeof payload.observationRevision !== 'number' || !Number.isSafeInteger(payload.observationRevision)
          || payload.observationRevision < 1))) {
      throw corrupt(operation, `${message}: 未知观察结构或版本`, projectId, runId);
    }
    const processIdentityRecorded = payload.processIdentity !== null && payload.processIdentity !== undefined;
    const verificationProcesses = Array.isArray(payload.verificationProcesses) ? payload.verificationProcesses.length : 0;
    return {
      attemptId: payload.attemptId as string,
      taskId: '',
      attemptNumber: 0,
      attemptStatus: 'interrupted',
      executionStage: typeof payload.executionStage === 'string' ? payload.executionStage : '',
      phase: payload.phase as 'observed' | 'recorded' | 'reprobed',
      observationRevision: payload.observationRevision === undefined ? 1 : payload.observationRevision as number,
      observedAtUtcMs: row.occurred_at,
      evidenceRef: (payload.evidenceRef as string | null | undefined) ?? null,
      gaps: payload.gaps as readonly string[],
      stopConfirmed: payload.stopConfirmed as boolean,
      processIdentityRecorded,
      verificationProcessesCount: verificationProcesses,
    };
  }

  /** 各 interrupted Attempt 的最新持久恢复观察（work.recovery.updated 最新 sequence）。 */
  function listRecoveryObservations(
    operation: string,
    projectId: string,
    runId: string,
    attempts: readonly ReturnType<typeof attemptFromRow>[],
  ): { observations: readonly ExecutionRunRecoveryObservationEntry[]; truncated: boolean } {
    const attemptIds = attempts.map((attempt) => attempt.id);
    if (attemptIds.length === 0) return { observations: [], truncated: false };
    const placeholders = attemptIds.map(() => '?').join(',');
    const rows = session.database
      .prepare<[string, ...string[]], { readonly attempt_id: string | null; readonly payload: string; readonly occurred_at: number }>(
        `SELECT e.attempt_id, e.payload, e.occurred_at FROM state_events e
         WHERE e.project_id = ? AND e.event_type IN ('work.recovery.updated', 'work.recovery.blocked')
           AND json_extract(e.payload, '$.phase') IN ('observed', 'recorded', 'reprobed')
           AND e.attempt_id IN (${placeholders})
           AND e.sequence = (SELECT MAX(latest.sequence) FROM state_events latest
             WHERE latest.attempt_id = e.attempt_id
               AND latest.event_type IN ('work.recovery.updated', 'work.recovery.blocked')
               AND json_extract(latest.payload, '$.phase') IN ('observed', 'recorded', 'reprobed'))
         ORDER BY e.attempt_id`,
      )
      .all(projectId, ...attemptIds) as { readonly attempt_id: string | null; readonly payload: string; readonly occurred_at: number }[];
    const bounded = rows.slice(0, EXECUTION_RECOVERY_OBSERVATIONS_MAX + 1);
    const truncated = bounded.length > EXECUTION_RECOVERY_OBSERVATIONS_MAX;
    const visible = truncated ? bounded.slice(0, EXECUTION_RECOVERY_OBSERVATIONS_MAX) : bounded;
    // taskId/attemptNumber 不在观察事件内：从同一一致读的 Attempt 行补齐身份投影。
    const observations = visible.map((row) => {
      const entry = recoveryObservationFromRow(operation, projectId, runId, row);
      const attempt = attempts.find((candidate) => candidate.id === entry.attemptId);
      if (attempt === undefined) {
        throw corrupt(operation, '恢复观察与 Attempt 身份不一致', projectId, runId);
      }
      return { ...entry, taskId: attempt.taskId, attemptNumber: attempt.number };
    });
    return { observations, truncated };
  }

  function readRunRecoveryStartupView(
    operation: string,
    projectId: string,
    runId: string,
    featureId: string,
    batchId: string,
    attempts: readonly ReturnType<typeof attemptFromRow>[],
    attemptsTruncated: boolean,
  ): ExecutionRunRecoveryStartupView {
    const interrupted = attempts.filter((attempt) => attempt.status === 'interrupted');
    const interruptedTruncated = attemptsTruncated && interrupted.length === attempts.length;
    const active = attempts.filter((attempt) => ['preparing', 'executing', 'verifying'].includes(attempt.status));
    const { observations, truncated: observationTruncated } = listRecoveryObservations(
      operation, projectId, runId, interrupted,
    );
    const leases = listLeases(projectId, attempts.map((attempt) => attempt.id));
    const workspaceRow = session.database
      .prepare<[string, string], { id: string; status: string; revision: number; attempt_id: string | null }>(
        'SELECT id, status, revision, attempt_id FROM managed_workspaces WHERE project_id = ? AND feature_id = ?',
      )
      .get(projectId, featureId);
    if (workspaceRow !== undefined && !['preparing', 'ready', 'retained', 'quarantined', 'cleanup_pending', 'cleaned']
      .includes(workspaceRow.status)) {
      throw corrupt(operation, `受管工作区状态损坏: ${workspaceRow.status}`, projectId, runId);
    }
    const gitRows = session.database
      .prepare<[string, string, number]>(
        `SELECT ${GIT_OPERATION_COLUMNS} FROM git_operations
         WHERE project_id = ? AND run_id = ? AND status = 'pending' ORDER BY id LIMIT ?`,
      )
      .all(projectId, runId, EXECUTION_RECOVERY_GIT_OPERATIONS_MAX);
    let pendingGitOperations;
    try {
      pendingGitOperations = gitRows.map((row) => gitOperationRecordFromRow(row as Parameters<typeof gitOperationRecordFromRow>[0]));
    } catch (error) {
      throw corrupt(operation, `pending Git 回执行损坏: ${(error as Error).message}`, projectId, runId);
    }
    // 观察阶段取最落后者：无观察 → pending；observed < recorded < reprobed。
    const phaseOrder = { pending: 0, observed: 1, recorded: 2, reprobed: 3 } as const;
    let phase: ExecutionRunRecoveryStartupView['phase'] = 'none';
    if (interrupted.length > 0) {
      const observedPhases = new Map(observations.map((observation) => [observation.attemptId, observation.phase]));
      if (interrupted.every((attempt) => observedPhases.has(attempt.id))) {
        phase = interrupted.reduce<'pending' | 'observed' | 'recorded' | 'reprobed'>(
          (least, attempt) => {
            const current = observedPhases.get(attempt.id)!;
            return phaseOrder[current] < phaseOrder[least] ? current : least;
          },
          'reprobed',
        );
      } else {
        phase = 'pending';
      }
    }
    return {
      phase,
      interruptedAttempts: interrupted,
      interruptedTruncated,
      activeAttempts: active,
      observations,
      observationTruncated,
      leases,
      workspace: workspaceRow === undefined ? null : {
        id: workspaceRow.id,
        status: workspaceRow.status,
        revision: workspaceRow.revision,
        attemptId: workspaceRow.attempt_id,
      },
      pendingGitOperations,
      stopOperations: listStopOperations(projectId, batchId, runId),
    };
  }

  function readRunRow(operation: string, projectId: string, runId: string): RunRecord | undefined {
    try {
      return execution.getExecutionRunInTransaction(projectId, runId);
    } catch (error) {
      // 跨项目/不存在统一折叠为 undefined（不区分存在性，不泄漏归属）。
      if (
        error instanceof StorageError &&
        (error.kind === 'not_found' || error.kind === 'ownership')
      ) {
        return undefined;
      }
      throw error;
    }
  }

  return {
    listFeatureResourceRecords(project: unknown, request, selector) {
      const operation = `${OPERATION}.listFeatureResourceRecords`;
      const projectId = stableId(operation, project, 'projectId');
      if (selector?.featureId !== undefined) stableId(operation, selector.featureId, 'featureId');
      if (selector?.batchId !== undefined) stableId(operation, selector.batchId, 'batchId');
      return read(operation, () => listFeatureResources(projectId, request, selector, operation));
    },

    readRunControlView(project: unknown, run: unknown): ExecutionRunControlView | undefined {
      const operation = `${OPERATION}.readRunControlView`;
      const projectId = stableId(operation, project, 'projectId');
      const runId = stableId(operation, run, 'runId');
      return read(operation, () => {
        const runRecord = readRunRow(operation, projectId, runId);
        if (runRecord === undefined) return undefined;
        const batch = batchFromRow(operation, runRecord.batchId, projectId);
        const scanned = listRunAttempts(projectId, runId, operation, EXECUTION_CONTROL_ATTEMPTS_MAX);
        return {
          run: runRecord,
          batch,
          attempts: scanned.attempts,
          attemptsTruncated: scanned.truncated,
          stopOperations: listStopOperations(projectId, runRecord.batchId, runId),
          leases: listLeases(projectId, scanned.attempts.map((attempt) => attempt.id)),
        };
      });
    },

    readBatchControlView(project: unknown, batch: unknown): ExecutionBatchControlView | undefined {
      const operation = `${OPERATION}.readBatchControlView`;
      const projectId = stableId(operation, project, 'projectId');
      const batchId = stableId(operation, batch, 'batchId');
      return read(operation, () => {
        let batchRecord: ExecutionBatchRecord | undefined;
        try {
          batchRecord = execution.getExecutionBatchInTransaction(projectId, batchId);
        } catch (error) {
          // 跨项目/不存在统一折叠为 undefined（不区分存在性，不泄漏归属）。
          if (
            error instanceof StorageError &&
            (error.kind === 'not_found' || error.kind === 'ownership')
          ) {
            return undefined;
          }
          throw error;
        }
        if (batchRecord === undefined) return undefined;
        const runRows = session.database
          .prepare<[string, string, number], RunSqlRow>(
            'SELECT id, project_id FROM runs WHERE project_id = ? AND batch_id = ? ORDER BY dispatch_ordinal, id LIMIT ?',
          )
          .all(projectId, batchId, EXECUTION_CONTROL_RUNS_MAX + 1);
        const runsTruncated = runRows.length > EXECUTION_CONTROL_RUNS_MAX;
        const runs = runRows
          .slice(0, EXECUTION_CONTROL_RUNS_MAX)
          .map((row) => runFromRow(operation, row, projectId));
        const attemptRows = session.database
          .prepare<[string, string, number], AttemptRow>(
            `SELECT attempts.* FROM attempts
             JOIN runs ON runs.project_id = attempts.project_id AND runs.id = attempts.run_id
             WHERE attempts.project_id = ? AND runs.batch_id = ?
             ORDER BY attempts.task_id, attempts.number, attempts.id LIMIT ?`,
          )
          .all(projectId, batchId, EXECUTION_CONTROL_ATTEMPTS_MAX + 1);
        const attemptsTruncated = attemptRows.length > EXECUTION_CONTROL_ATTEMPTS_MAX;
        const attempts = attemptRows.slice(0, EXECUTION_CONTROL_ATTEMPTS_MAX).map((row) => {
          try {
            return attemptFromRow(row);
          } catch (error) {
            throw corrupt(operation, `attempt 行损坏: ${(error as Error).message}`, projectId, row.id);
          }
        });
        return {
          batch: batchRecord,
          runs,
          runsTruncated,
          attempts,
          attemptsTruncated,
          stopOperations: listStopOperations(projectId, batchId, null),
          leases: listLeases(projectId, attempts.map((attempt) => attempt.id)),
        };
      });
    },

    readRunRecoveryView(project: unknown, run: unknown): ExecutionRunRecoveryView | undefined {
      const operation = `${OPERATION}.readRunRecoveryView`;
      const projectId = stableId(operation, project, 'projectId');
      const runId = stableId(operation, run, 'runId');
      return read(operation, () => {
        const runRecord = readRunRow(operation, projectId, runId);
        if (runRecord === undefined) return undefined;
        const batch = batchFromRow(operation, runRecord.batchId, projectId);
        let finalization;
        try {
          finalization = validateRunFinalizationScope(runRecord.inputSnapshot['finalization']);
        } catch (error) {
          throw corrupt(operation, `finalization scope 损坏: ${(error as Error).message}`, projectId, runId);
        }
        const scanned = listRunAttempts(
          projectId,
          runId,
          operation,
          EXECUTION_RECOVERY_CONTINUATIONS_MAX,
        );
        const continuations: ExecutionRunRecoveryContinuationEntry[] = [];
        for (const attempt of scanned.attempts) {
          const recovery = attempt.inputSnapshot.recovery;
          if (recovery !== undefined) {
            continuations.push({ attempt, recovery });
          }
        }
        let deliveryView: FeatureDeliveryView | undefined;
        try {
          deliveryView = delivery.readFeatureDeliveryView(projectId, runRecord.featureId);
        } catch (error) {
          throw corrupt(operation, `分轴事实损坏: ${(error as Error).message}`, projectId, runId);
        }
        if (deliveryView === undefined) {
          throw corrupt(operation, 'feature 分轴视图缺失', projectId, runId);
        }
        return {
          run: runRecord,
          batch,
          finalization,
          continuations,
          continuationsTruncated: scanned.truncated,
          attemptsScanned: scanned.scanned,
          delivery: deliveryView,
          startup: readRunRecoveryStartupView(
            operation, projectId, runId, runRecord.featureId, batch.id, scanned.attempts, scanned.truncated,
          ),
        };
      });
    },
  };
}
