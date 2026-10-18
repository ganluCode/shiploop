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
import type {
  ExecutionBatchControlView,
  ExecutionControlLeaseEntry,
  ExecutionControlQueryReadStore,
  ExecutionRunControlView,
  ExecutionRunRecoveryContinuationEntry,
  ExecutionRunRecoveryView,
} from '../../ports/execution-control-query.js';
import {
  EXECUTION_CONTROL_ATTEMPTS_MAX,
  EXECUTION_CONTROL_RUNS_MAX,
  EXECUTION_CONTROL_STOP_OPERATIONS_MAX,
  EXECUTION_RECOVERY_CONTINUATIONS_MAX,
  validateRunFinalizationScope,
} from '../../ports/execution-control-query.js';
import type {
  ExecutionBatchRecord,
  ExecutionStopOperationRecord,
  RunRecord,
} from '../../ports/execution-store.js';
import type { FeatureDeliveryQueryReadStore, FeatureDeliveryView } from '../../ports/feature-delivery-query.js';
import { createSqliteFeatureDeliveryQueryStore } from './feature-delivery-query-store.js';
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
      targetKind: row.target_kind as 'run' | 'batch',
      targetId: row.target_id,
      batchId: row.batch_id,
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
        };
      });
    },
  };
}
