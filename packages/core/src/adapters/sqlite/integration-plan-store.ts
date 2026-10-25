import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import {
  createIntegrationPlan,
  type IntegrationInputRef,
  type IntegrationPlan,
  type IntegrationPlanInput,
  type IntegrationResult,
} from '../../ports/integration-plan.js';
import type {
  IntegrationPlanAccess,
  PersistedIntegrationPlan,
} from '../../ports/integration-plan-store.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead } from './state-store.js';

interface PlanRow {
  readonly id: string; readonly created_at: number; readonly project_id: string;
  readonly revision: number; readonly updated_at: number; readonly phase_id: string;
  readonly batch_id: string; readonly successor_feature_id: string; readonly target_baseline: string;
  readonly input_digest: string; readonly mode: string; readonly merge_order: string;
  readonly approved_inputs: string; readonly verification_scope: string; readonly strategy_summary: string;
  readonly integration_result: string | null; readonly status: string;
  readonly block_reasons: string; readonly stale_reasons: string; readonly frozen_at: number | null;
}

interface SnapshotRow {
  readonly id: string; readonly created_at: number; readonly project_id: string; readonly plan_id: string;
  readonly phase_id: string; readonly feature_id: string; readonly predecessor_ordinal: number;
  readonly dependency_passed: number; readonly delivery_commit: string | null;
  readonly delivery_evidence_id: string | null; readonly delivery_evidence_digest: string | null;
  readonly covered_input_ids: string; readonly ancestor_verified: number;
}

const OPERATION = 'IntegrationPlanStore';
const PLAN_COLUMNS = `id, created_at, project_id, revision, updated_at, phase_id, batch_id,
  successor_feature_id, target_baseline, input_digest, mode, merge_order, approved_inputs,
  verification_scope, strategy_summary, integration_result, status, block_reasons, stale_reasons, frozen_at`;

function entity(projectId: string, id?: string) {
  return { type: 'integration_plan' as const, projectId, ...(id === undefined ? {} : { id }) };
}

function assertTransaction(db: Database.Database, operation: string): void {
  if (!db.inTransaction) throw new TypeError(`${operation} 必须在调用方已打开的短写事务内执行`);
}

function parseJson<T>(value: string, field: string, projectId: string, id: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new StorageError('corrupt', `${OPERATION}.read`, `集成计划持久 JSON 损坏：${field}`, {
      entity: entity(projectId, id), details: { field }, cause,
    });
  }
}

function constraintKind(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
    && (error as unknown as { code: string }).code.startsWith('SQLITE_CONSTRAINT');
}

function inputFromRow(db: Database.Database, row: PlanRow, operation: string): IntegrationPlanInput {
  const snapshots = db.prepare<[string, string], SnapshotRow>(
    `SELECT id, created_at, project_id, plan_id, phase_id, feature_id, predecessor_ordinal,
      dependency_passed, delivery_commit, delivery_evidence_id, delivery_evidence_digest,
      covered_input_ids, ancestor_verified FROM integration_predecessor_snapshots
      WHERE project_id = ? AND plan_id = ? ORDER BY predecessor_ordinal`,
  ).all(row.project_id, row.id);
  try {
    const predecessors = snapshots.map((snapshot) => ({
      projectId: snapshot.project_id,
      phaseId: snapshot.phase_id,
      featureId: snapshot.feature_id,
      dependencyPassed: snapshot.dependency_passed === 1,
      delivery: snapshot.delivery_commit === null ? null : {
        commitSha: snapshot.delivery_commit,
        evidenceId: snapshot.delivery_evidence_id!,
        evidenceDigest: snapshot.delivery_evidence_digest!,
      },
      coveredInputIds: parseJson<string[]>(snapshot.covered_input_ids, 'covered_input_ids', row.project_id, row.id),
      ancestorVerified: snapshot.ancestor_verified === 1,
    }));
    return {
      projectId: row.project_id,
      phaseId: row.phase_id,
      batchId: row.batch_id,
      successorFeatureId: row.successor_feature_id,
      targetBaseline: row.target_baseline,
      predecessors,
      approvedInputs: parseJson<IntegrationInputRef[]>(row.approved_inputs, 'approved_inputs', row.project_id, row.id),
      mergeOrder: parseJson<string[]>(row.merge_order, 'merge_order', row.project_id, row.id),
      verificationScope: parseJson<string[]>(row.verification_scope, 'verification_scope', row.project_id, row.id),
      strategySummary: parseJson<Record<string, unknown>>(row.strategy_summary, 'strategy_summary', row.project_id, row.id),
      integrationResult: row.integration_result === null ? null : parseJson<IntegrationResult>(row.integration_result, 'integration_result', row.project_id, row.id),
    };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('corrupt', operation, '集成计划持久快照结构损坏', { entity: entity(row.project_id, row.id), cause: error });
  }
}


function recordFromRow(db: Database.Database, row: PlanRow, operation = `${OPERATION}.read`): PersistedIntegrationPlan {
  const input = inputFromRow(db, row, operation);
  let derived: IntegrationPlan;
  try {
    derived = createIntegrationPlan(input);
  } catch (cause) {
    throw new StorageError('corrupt', operation, '集成计划持久快照未通过端口校验', { entity: entity(row.project_id, row.id), cause });
  }
  const blockReasons = parseJson<IntegrationPlan['blockReasons']>(row.block_reasons, 'block_reasons', row.project_id, row.id);
  const staleReasons = parseJson<IntegrationPlan['staleReasons']>(row.stale_reasons, 'stale_reasons', row.project_id, row.id);
  return {
    ...derived,
    integrationId: row.id,
    inputDigest: row.input_digest,
    mode: row.mode as IntegrationPlan['mode'],
    status: row.status as IntegrationPlan['status'],
    blockReasons,
    staleReasons,
    revision: row.revision,
    createdAtUtcMs: row.created_at,
    updatedAtUtcMs: row.updated_at,
    frozenAtUtcMs: row.frozen_at,
  };
}

function validateRevision(value: unknown, operation: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new StorageError('validation', operation, 'expectedRevision 必须是正整数');
  }
  return value as number;
}

function validateOwnership(db: Database.Database, input: IntegrationPlanInput, operation: string): void {
  const project = db.prepare<[string], { id: string }>('SELECT id FROM projects WHERE id = ?').get(input.projectId);
  if (project === undefined) throw new StorageError('not_found', operation, 'Project 不存在', { entity: { type: 'project', id: input.projectId } });
  const phase = db.prepare<[string], { project_id: string }>('SELECT project_id FROM phases WHERE id = ?').get(input.phaseId);
  if (phase === undefined) throw new StorageError('not_found', operation, 'Phase 不存在', { entity: { type: 'phase', id: input.phaseId, projectId: input.projectId } });
  if (phase.project_id !== input.projectId) throw new StorageError('ownership', operation, 'Phase 不属于请求项目', { entity: { type: 'phase', id: input.phaseId, projectId: input.projectId } });
  const batch = db.prepare<[string], { project_id: string; phase_id: string }>('SELECT project_id, phase_id FROM execution_batches WHERE id = ?').get(input.batchId);
  if (batch === undefined) throw new StorageError('not_found', operation, 'Batch 不存在', { entity: { type: 'execution_batch', id: input.batchId, projectId: input.projectId } });
  if (batch.project_id !== input.projectId || batch.phase_id !== input.phaseId) throw new StorageError('ownership', operation, 'Batch 不属于请求项目或 Phase', { entity: { type: 'execution_batch', id: input.batchId, projectId: input.projectId } });
  const successor = db.prepare<[string], { project_id: string; phase_id: string }>('SELECT project_id, phase_id FROM features WHERE id = ?').get(input.successorFeatureId);
  if (successor === undefined) throw new StorageError('not_found', operation, '后继 Feature 不存在', { entity: { type: 'feature', id: input.successorFeatureId, projectId: input.projectId } });
  if (successor.project_id !== input.projectId || successor.phase_id !== input.phaseId) throw new StorageError('ownership', operation, '后继 Feature 不属于请求项目或 Phase', { entity: { type: 'feature', id: input.successorFeatureId, projectId: input.projectId } });
  for (const predecessor of input.predecessors) {
    const row = db.prepare<[string], { project_id: string; phase_id: string }>('SELECT project_id, phase_id FROM features WHERE id = ?').get(predecessor.featureId);
    if (row === undefined) throw new StorageError('not_found', operation, '前置 Feature 不存在', { entity: { type: 'feature', id: predecessor.featureId, projectId: input.projectId } });
    if (row.project_id !== input.projectId || row.phase_id !== input.phaseId) throw new StorageError('ownership', operation, '前置成果跨项目或 Phase', { entity: { type: 'feature', id: predecessor.featureId, projectId: input.projectId } });
  }
}

function planInput(record: PersistedIntegrationPlan, result: IntegrationResult | null): IntegrationPlanInput {
  return {
    projectId: record.projectId, phaseId: record.phaseId, batchId: record.batchId,
    successorFeatureId: record.successorFeatureId, targetBaseline: record.targetBaseline,
    predecessors: record.predecessors, approvedInputs: record.approvedInputs,
    mergeOrder: record.mergeOrder, verificationScope: record.verificationScope,
    strategySummary: record.strategySummary, integrationResult: result,
  };
}

export function createSqliteIntegrationPlanAccess(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {},
): IntegrationPlanAccess {
  const db = session.database;
  const now = options.nowUtcMs ?? Date.now;
  const readRow = (projectId: string, integrationId: string): PlanRow | undefined =>
    db.prepare<[string, string], PlanRow>(`SELECT ${PLAN_COLUMNS} FROM integration_plans WHERE project_id = ? AND id = ?`).get(projectId, integrationId);

  function getInTransaction(projectIdInput: string, integrationIdInput: string): PersistedIntegrationPlan {
    const operation = `${OPERATION}.getIntegrationPlan`;
    assertTransaction(db, operation);
    const projectId = validateStableId(projectIdInput, { operation }, 'projectId');
    const integrationId = validateStableId(integrationIdInput, { operation }, 'integrationId');
    const row = readRow(projectId, integrationId);
    if (row === undefined) {
      const other = db.prepare<[string], { project_id: string }>('SELECT project_id FROM integration_plans WHERE id = ?').get(integrationId);
      if (other !== undefined && other.project_id !== projectId) throw new StorageError('ownership', operation, '集成计划不属于请求项目', { entity: entity(projectId, integrationId) });
      throw new StorageError('not_found', operation, '集成计划不存在', { entity: entity(projectId, integrationId) });
    }
    return recordFromRow(db, row, operation);
  }

  function createInTransaction(raw: unknown): PersistedIntegrationPlan {
    const operation = `${OPERATION}.create`;
    assertTransaction(db, operation);
    const plan = createIntegrationPlan(raw);
    validateOwnership(db, plan, operation);
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new StorageError('validation', operation, '时钟必须返回正安全整数');
    try {
      db.prepare(`INSERT INTO integration_plans
        (id, created_at, project_id, revision, updated_at, phase_id, batch_id, successor_feature_id,
         target_baseline, input_digest, mode, merge_order, approved_inputs, verification_scope,
         strategy_summary, integration_result, status, block_reasons, stale_reasons, frozen_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        plan.integrationId, timestamp, plan.projectId, timestamp, plan.phaseId, plan.batchId,
        plan.successorFeatureId, plan.targetBaseline, plan.inputDigest, plan.mode,
        JSON.stringify(plan.mergeOrder), JSON.stringify(plan.approvedInputs), JSON.stringify(plan.verificationScope),
        JSON.stringify(plan.strategySummary), plan.integrationResult === null ? null : JSON.stringify(plan.integrationResult),
        plan.status, JSON.stringify(plan.blockReasons), JSON.stringify(plan.staleReasons),
      );
      const insert = db.prepare(`INSERT INTO integration_predecessor_snapshots
        (id, created_at, project_id, plan_id, phase_id, feature_id, predecessor_ordinal,
         dependency_passed, delivery_commit, delivery_evidence_id, delivery_evidence_digest,
         covered_input_ids, ancestor_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      plan.predecessors.forEach((predecessor, index) => insert.run(
        randomUUID(), timestamp, plan.projectId, plan.integrationId, plan.phaseId, predecessor.featureId, index + 1,
        predecessor.dependencyPassed ? 1 : 0, predecessor.delivery?.commitSha ?? null,
        predecessor.delivery?.evidenceId ?? null, predecessor.delivery?.evidenceDigest ?? null,
        JSON.stringify(predecessor.coveredInputIds), predecessor.ancestorVerified ? 1 : 0,
      ));
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (constraintKind(error)) throw new StorageError('conflict', operation, '集成计划身份已存在或归属约束冲突', { entity: entity(plan.projectId, plan.integrationId), cause: error });
      throw error;
    }
    return getInTransaction(plan.projectId, plan.integrationId);
  }

  function freezeInTransaction(raw: unknown): PersistedIntegrationPlan {
    const operation = `${OPERATION}.freeze`;
    assertTransaction(db, operation);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new StorageError('validation', operation, 'freeze 输入必须是对象');
    const value = raw as Record<string, unknown>;
    const projectId = validateStableId(value.projectId, { operation }, 'projectId');
    const integrationId = validateStableId(value.integrationId, { operation }, 'integrationId');
    const expectedRevision = validateRevision(value.expectedRevision, operation);
    const current = getInTransaction(projectId, integrationId);
    if (current.frozenAtUtcMs !== null) {
      if (current.revision !== expectedRevision) throw new StorageError('conflict', operation, '集成计划 revision 已变化', { entity: entity(projectId, integrationId), details: { expectedRevision, actualRevision: current.revision } });
      return current;
    }
    const timestamp = now();
    const changed = db.prepare('UPDATE integration_plans SET frozen_at = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ? AND frozen_at IS NULL').run(timestamp, timestamp, projectId, integrationId, expectedRevision);
    if (changed.changes !== 1) throw new StorageError('conflict', operation, '集成计划冻结 CAS 未命中', { entity: entity(projectId, integrationId), details: { expectedRevision, actualRevision: current.revision } });
    return getInTransaction(projectId, integrationId);
  }

  function updateResultInTransaction(raw: unknown): PersistedIntegrationPlan {
    const operation = `${OPERATION}.updateResult`;
    assertTransaction(db, operation);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new StorageError('validation', operation, 'result update 输入必须是对象');
    const value = raw as Record<string, unknown>;
    const projectId = validateStableId(value.projectId, { operation }, 'projectId');
    const integrationId = validateStableId(value.integrationId, { operation }, 'integrationId');
    const expectedRevision = validateRevision(value.expectedRevision, operation);
    const current = getInTransaction(projectId, integrationId);
    if (current.frozenAtUtcMs === null) throw new StorageError('conflict', operation, '集成计划必须先冻结才能写入结果', { entity: entity(projectId, integrationId) });
    const result = value.integrationResult as IntegrationResult | null;
    const next = createIntegrationPlan(planInput(current, result));
    const changed = db.prepare(`UPDATE integration_plans SET integration_result = ?, status = ?, block_reasons = ?, stale_reasons = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ?`).run(
      result === null ? null : JSON.stringify(next.integrationResult), next.status, JSON.stringify(next.blockReasons), JSON.stringify(next.staleReasons), now(), projectId, integrationId, expectedRevision,
    );
    if (changed.changes !== 1) throw new StorageError('conflict', operation, '集成结果 revision CAS 未命中', { entity: entity(projectId, integrationId), details: { expectedRevision, actualRevision: current.revision } });
    return getInTransaction(projectId, integrationId);
  }

  return {
    createIntegrationPlanInTransaction: createInTransaction,
    freezeIntegrationPlanInTransaction: freezeInTransaction,
    updateIntegrationPlanResultInTransaction: updateResultInTransaction,
    getIntegrationPlanInTransaction: getInTransaction,
    readIntegrationPlan(projectIdInput, integrationIdInput) {
      const operation = `${OPERATION}.read`;
      if (db.inTransaction) throw new TypeError(`${operation} 不能嵌套在写事务内`);
      const projectId = validateStableId(projectIdInput, { operation }, 'projectId');
      const integrationId = validateStableId(integrationIdInput, { operation }, 'integrationId');
      return transactSqliteConsistentRead(session, operation, () => {
        const row = readRow(projectId, integrationId);
        return row === undefined ? undefined : recordFromRow(db, row, operation);
      });
    },
  };
}

export function createSqliteIntegrationPlanStore(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {},
): IntegrationPlanAccess {
  const access = createSqliteIntegrationPlanAccess(session, options);
  return access;
}
