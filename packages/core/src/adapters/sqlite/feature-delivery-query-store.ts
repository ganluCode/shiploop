/**
 * P03-8 / F-010 Feature 分轴结果查询只读窄端口的 SQLite 装配（adapters 层）。
 *
 * 不变量（与 ports/feature-delivery-query.ts 同一契约）：
 * - 全部读取以 BEGIN DEFERRED 一致读事务执行；本模块无任何写原语——不改
 *   Feature/Run/Batch/Task/审批/Git 状态、不写事件、不触发 Git 或执行；
 * - 跨项目/不存在目标统一 undefined（存在性折叠由应用层完成，绝不区分
 *   「不存在」与「属于其他项目」）；持久行损坏 fail-closed（StorageError
 *   corrupt），不把损坏内容泄漏进错误或折算成空结果；
 * - 独立 Feature VerificationBatch 以 operation='FeatureVerification.full'
 *   识别（与 F-004 执行器同一持久身份），取最近一批并随读逐检查结果；
 *   Git operation 取 Feature 最近一条；人审事项 (created_at,id) 升序有界
 *   读取（超限置 approvalItemsTruncated）；Task 轴按稳定 taskId 升序，各
 *   Task 历史引用取最大 number 的 Attempt（无 Attempt 为 null）；
 * - import 本模块无副作用，会话生命周期由调用方管理。
 */
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import {
  FEATURE_PLAN_STATUSES,
  FEATURE_STATUSES,
  TASK_STATUSES,
} from '../../ports/plan-store.js';
import { FEATURE_DELIVERY_STATUSES } from '../../ports/git-operations.js';
import { EXECUTION_RUN_STATUSES } from '../../ports/execution-store.js';
import type {
  FeatureDeliveryBatchRow,
  FeatureDeliveryFeatureRow,
  FeatureDeliveryQueryReadStore,
  FeatureDeliveryRunRow,
  FeatureDeliveryTaskRow,
  FeatureDeliveryView,
} from '../../ports/feature-delivery-query.js';
import { FEATURE_DELIVERY_APPROVAL_ITEMS_MAX_COUNT } from '../../ports/feature-delivery-query.js';
import { FEATURE_VERIFICATION_OPERATION } from '../../ports/feature-verification.js';
import type { GitOperationRecord } from '../../ports/git-operations.js';
import {
  GIT_OPERATION_COLUMNS,
  gitOperationRecordFromRow,
  type GitOperationRow,
} from './git-operations.js';
import {
  checkResultRecordFromRow,
  verificationBatchRecordFromRow,
  CHECK_RESULT_COLUMNS,
  VERIFICATION_BATCH_COLUMNS,
  type CheckResultRow,
  type VerificationBatchRow,
} from './verification-store.js';
import {
  taskApprovalItemFromRow,
  type TaskApprovalItemSqlRow,
} from './plan-store.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'FeatureDeliveryQueryStore';

/** 人审事项列（与 plan-store TaskApprovalItemSqlRow 逐列对应）。 */
const APPROVAL_ITEM_COLUMNS = `id, created_at, project_id, feature_id, task_id, revision, updated_at, kind,
  description, responsible_party, plan_digest, code_digest, artifact_refs, status, created_by, decision,
  decision_actor, decision_reason, decision_code_digest, decision_artifact_refs, decided_at`;

function stableId(operation: string, value: unknown, field: string): string {
  const context: ValidationContext = { operation };
  return validateStableId(value, context, field);
}

function corrupt(operation: string, message: string, projectId: string, featureId: string): StorageError {
  return new StorageError('corrupt', operation, message, {
    entity: { type: 'feature', id: featureId, projectId },
  });
}

function memberOf<T extends string>(
  operation: string,
  value: unknown,
  allowed: readonly T[],
  field: string,
  projectId: string,
  featureId: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw corrupt(operation, `${field} 损坏`, projectId, featureId);
  }
  return value as T;
}

function requireRevision(
  operation: string,
  value: unknown,
  projectId: string,
  featureId: string,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw corrupt(operation, 'revision 损坏', projectId, featureId);
  }
  return value;
}

function requireTimestamp(
  operation: string,
  value: unknown,
  field: string,
  projectId: string,
  featureId: string,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(operation, `${field} 损坏`, projectId, featureId);
  }
  return value;
}

function nullableTimestamp(
  operation: string,
  value: unknown,
  field: string,
  projectId: string,
  featureId: string,
): number | null {
  if (value === null) return null;
  return requireTimestamp(operation, value, field, projectId, featureId);
}

function nullableReason(
  operation: string,
  value: unknown,
  projectId: string,
  featureId: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw corrupt(operation, 'reason 损坏', projectId, featureId);
  }
  return value;
}

interface FeatureSqlRow {
  status: string;
  delivery_status: string;
  plan_status: string;
  plan_digest: string | null;
  revision: number;
  updated_at: number;
}

interface TaskSqlRow {
  id: string;
  status: string;
  manual_block: number;
  first_passed_at: number | null;
  latest_attempt_id: string | null;
}

interface RunSqlRow {
  id: string;
  batch_id: string;
  status: string;
  reason: string | null;
  started_at: number | null;
  ended_at: number | null;
}

interface BatchSqlRow {
  id: string;
  status: string;
  reason: string | null;
}

/** SQLite 装配：只读一致视图；查询零写入、零事件、零执行触发。 */
export function createSqliteFeatureDeliveryQueryStore(
  session: SqliteStorageSession,
): FeatureDeliveryQueryReadStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqliteFeatureDeliveryQueryStore: session 必须是 SqliteStorageSession');
  }

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new StorageError('corrupt', operation, 'Storage session is closed');
    }
  }

  function readFeatureRow(
    operation: string,
    projectId: string,
    featureId: string,
  ): FeatureDeliveryFeatureRow | undefined {
    const row = session.database
      .prepare<[string, string], FeatureSqlRow>(
        `SELECT status, delivery_status, plan_status, plan_digest, revision, updated_at
         FROM features WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, featureId);
    if (row === undefined) return undefined;
    return {
      projectId,
      featureId,
      status: memberOf(operation, row.status, FEATURE_STATUSES, 'Feature 状态', projectId, featureId),
      deliveryStatus: memberOf(
        operation, row.delivery_status, FEATURE_DELIVERY_STATUSES, 'Feature deliveryStatus', projectId, featureId,
      ),
      planStatus: memberOf(
        operation, row.plan_status, FEATURE_PLAN_STATUSES, 'Feature planStatus', projectId, featureId,
      ),
      planDigest: row.plan_digest,
      revision: requireRevision(operation, row.revision, projectId, featureId),
      updatedAtUtcMs: requireTimestamp(operation, row.updated_at, 'updated_at', projectId, featureId),
    };
  }

  function readTaskRows(
    operation: string,
    projectId: string,
    featureId: string,
  ): readonly FeatureDeliveryTaskRow[] {
    const rows = session.database
      .prepare<[string, string], TaskSqlRow>(
        `SELECT t.id, t.status, t.manual_block, t.first_passed_at,
           (SELECT a.id FROM attempts a
             WHERE a.project_id = t.project_id AND a.task_id = t.id
             ORDER BY a.number DESC, a.id DESC LIMIT 1) AS latest_attempt_id
         FROM tasks t WHERE t.project_id = ? AND t.feature_id = ? ORDER BY t.id`,
      )
      .all(projectId, featureId);
    return rows.map((row) => {
      if (row.manual_block !== 0 && row.manual_block !== 1) {
        throw corrupt(operation, 'Task manualBlock 损坏', projectId, featureId);
      }
      if (row.latest_attempt_id !== null) stableId(operation, row.latest_attempt_id, 'latestAttemptId');
      return {
        taskId: row.id,
        status: memberOf(operation, row.status, TASK_STATUSES, 'Task 状态', projectId, featureId),
        manualBlock: row.manual_block === 1,
        firstPassedAtUtcMs: nullableTimestamp(
          operation, row.first_passed_at, 'first_passed_at', projectId, featureId,
        ),
        latestAttemptId: row.latest_attempt_id,
      };
    });
  }

  function readLatestRun(
    operation: string,
    projectId: string,
    featureId: string,
  ): FeatureDeliveryRunRow | null {
    const row = session.database
      .prepare<[string, string], RunSqlRow>(
        `SELECT id, batch_id, status, reason, started_at, ended_at
         FROM runs WHERE project_id = ? AND feature_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId, featureId);
    if (row === undefined) return null;
    return {
      id: stableId(operation, row.id, 'runId'),
      batchId: stableId(operation, row.batch_id, 'batchId'),
      status: memberOf(operation, row.status, EXECUTION_RUN_STATUSES, 'Run 状态', projectId, featureId),
      reason: nullableReason(operation, row.reason, projectId, featureId),
      startedAtUtcMs: nullableTimestamp(operation, row.started_at, 'started_at', projectId, featureId),
      endedAtUtcMs: nullableTimestamp(operation, row.ended_at, 'ended_at', projectId, featureId),
    };
  }

  function readBatch(
    operation: string,
    projectId: string,
    featureId: string,
    batchId: string,
  ): FeatureDeliveryBatchRow | null {
    const row = session.database
      .prepare<[string, string], BatchSqlRow>(
        `SELECT id, status, reason FROM execution_batches WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, batchId);
    if (row === undefined) {
      throw corrupt(operation, 'Run 所属 Batch 缺失', projectId, featureId);
    }
    return {
      id: stableId(operation, row.id, 'batchId'),
      status: memberOf(operation, row.status, EXECUTION_RUN_STATUSES, 'Batch 状态', projectId, featureId),
      reason: nullableReason(operation, row.reason, projectId, featureId),
    };
  }

  function readVerification(operation: string, projectId: string, featureId: string) {
    const batchRow = session.database
      .prepare<[string, string, string], VerificationBatchRow>(
        `SELECT ${VERIFICATION_BATCH_COLUMNS} FROM verification_batches
         WHERE project_id = ? AND feature_id = ? AND operation = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId, featureId, FEATURE_VERIFICATION_OPERATION);
    if (batchRow === undefined) return null;
    const batch = verificationBatchRecordFromRow(batchRow);
    if (batch.projectId !== projectId || batch.featureId !== featureId) {
      throw corrupt(operation, '验证批次归属损坏', projectId, featureId);
    }
    const checks = session.database
      .prepare<[string, string], CheckResultRow>(
        `SELECT ${CHECK_RESULT_COLUMNS} FROM check_results WHERE project_id = ? AND batch_id = ?
         ORDER BY created_at, id`,
      )
      .all(projectId, batch.id)
      .map(checkResultRecordFromRow);
    return { batch, checks };
  }

  function readLatestGitOperation(
    operation: string,
    projectId: string,
    featureId: string,
  ): GitOperationRecord | null {
    const row = session.database
      .prepare<[string, string], GitOperationRow>(
        `SELECT ${GIT_OPERATION_COLUMNS} FROM git_operations
         WHERE project_id = ? AND feature_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId, featureId);
    if (row === undefined) return null;
    const record = gitOperationRecordFromRow(row, operation);
    if (record.intent.projectId !== projectId || record.intent.featureId !== featureId) {
      throw corrupt(operation, 'Git 操作归属损坏', projectId, featureId);
    }
    return record;
  }

  function readApprovalItems(operation: string, projectId: string, featureId: string) {
    const rows = session.database
      .prepare<[string, string, number], TaskApprovalItemSqlRow>(
        `SELECT ${APPROVAL_ITEM_COLUMNS} FROM task_approval_items
         WHERE project_id = ? AND feature_id = ?
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(projectId, featureId, FEATURE_DELIVERY_APPROVAL_ITEMS_MAX_COUNT + 1);
    const truncated = rows.length > FEATURE_DELIVERY_APPROVAL_ITEMS_MAX_COUNT;
    const items = rows
      .slice(0, FEATURE_DELIVERY_APPROVAL_ITEMS_MAX_COUNT)
      .map((row) => {
        const item = taskApprovalItemFromRow(row);
        if (item.projectId !== projectId || item.featureId !== featureId) {
          throw corrupt(operation, '人审事项归属损坏', projectId, featureId);
        }
        return item;
      });
    return { items, truncated };
  }

  return {
    readFeatureDeliveryView(project: unknown, feature: unknown): FeatureDeliveryView | undefined {
      const operation = `${OPERATION}.readFeatureDeliveryView`;
      assertOpen(operation);
      const projectId = stableId(operation, project, 'projectId');
      const featureId = stableId(operation, feature, 'featureId');
      const assemble = (): FeatureDeliveryView | undefined => {
        const featureRow = readFeatureRow(operation, projectId, featureId);
        if (featureRow === undefined) return undefined;
        const run = readLatestRun(operation, projectId, featureId);
        const approval = readApprovalItems(operation, projectId, featureId);
        return {
          feature: featureRow,
          tasks: readTaskRows(operation, projectId, featureId),
          run,
          batch: run === null ? null : readBatch(operation, projectId, featureId, run.batchId),
          verification: readVerification(operation, projectId, featureId),
          gitOperation: readLatestGitOperation(operation, projectId, featureId),
          approvalItems: approval.items,
          approvalItemsTruncated: approval.truncated,
        };
      };
      return session.database.inTransaction
        ? assemble()
        : transactSqliteConsistentRead(session, operation, assemble);
    },
  };
}
