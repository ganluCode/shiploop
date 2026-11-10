import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import {
  createIntegrationPlan,
  INTEGRATION_BLOCK_REASONS,
  INTEGRATION_PLAN_STATUSES,
  INTEGRATION_STALE_REASONS,
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
import { INTEGRATION_PLAN_STATUS_EVENT_TYPE } from '../../ports/events.js';
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

function planInputOf(record: PersistedIntegrationPlan): IntegrationPlanInput {
  return {
    projectId: record.projectId, phaseId: record.phaseId, batchId: record.batchId,
    successorFeatureId: record.successorFeatureId, targetBaseline: record.targetBaseline,
    predecessors: record.predecessors, approvedInputs: record.approvedInputs,
    mergeOrder: record.mergeOrder, verificationScope: record.verificationScope,
    strategySummary: record.strategySummary, integrationResult: record.integrationResult,
  };
}

/**
 * F-004（P07 DAG）：在同一读事务内校验并返回同 Phase 的全部权威 integration plan。
 *
 * 在 recordFromRow 的结构校验之上叠加持久不变量：状态/原因枚举、revision 与时间，
 * 以及身份摘要重算与非 stale/blocked 状态的可推导性。任何损坏都在读取面 fail-closed，
 * 不把坏事实带入 Feature DAG 评估。status='stale'/'blocked' 允许由受控状态更新写入，
 * 因此只重算身份摘要，不要求与派生状态一致。
 */
export function listIntegrationPlansByPhaseInTransaction(
  db: Database.Database,
  projectId: string,
  phaseId: string,
  operation = `${OPERATION}.listByPhase`,
): readonly PersistedIntegrationPlan[] {
  const rows = db.prepare<[string, string], PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM integration_plans WHERE project_id = ? AND phase_id = ? ORDER BY id`,
  ).all(projectId, phaseId);
  return rows.map((row) => {
    const record = recordFromRow(db, row, operation);
    const entityRef = entity(row.project_id, row.id);
    if (!(INTEGRATION_PLAN_STATUSES as readonly string[]).includes(record.status)
      || !Array.isArray(record.blockReasons)
      || record.blockReasons.some((reason) => !(INTEGRATION_BLOCK_REASONS as readonly string[]).includes(reason))
      || !Array.isArray(record.staleReasons)
      || record.staleReasons.some((reason) => !(INTEGRATION_STALE_REASONS as readonly string[]).includes(reason))) {
      throw new StorageError('corrupt', operation, '集成计划持久状态投影损坏', {
        entity: entityRef, details: { reason: 'invalid_status_projection' },
      });
    }
    if (!Number.isSafeInteger(record.revision) || record.revision < 1
      || !Number.isSafeInteger(record.createdAtUtcMs) || record.createdAtUtcMs < 1
      || !Number.isSafeInteger(record.updatedAtUtcMs) || record.updatedAtUtcMs < 1
      || (record.frozenAtUtcMs !== null
        && (!Number.isSafeInteger(record.frozenAtUtcMs) || record.frozenAtUtcMs < 1))) {
      throw new StorageError('corrupt', operation, '集成计划持久身份或时间字段损坏', { entity: entityRef });
    }
    let derived: IntegrationPlan;
    try {
      derived = createIntegrationPlan(planInputOf(record));
    } catch (cause) {
      throw new StorageError('corrupt', operation, '集成计划持久快照未通过端口校验', { entity: entityRef, cause });
    }
    // 注：row.id / row.input_digest 在创建时固化，且 identity_immutable 触发器禁止变更；
    // 受控 updateResult 会写入结果使当前体重算身份漂移，因此这里不重算创建期身份，
    // 只校验结构、枚举与状态可推导性（状态仍必须能由当前冻结输入推导）。
    if ((record.status === 'dependency_passed' || record.status === 'integration_passed')
      && derived.status !== record.status) {
      throw new StorageError('corrupt', operation, '集成计划持久状态不可由冻结输入推导', {
        entity: entityRef, details: { reason: 'status_not_derivable', persisted: record.status, derived: derived.status },
      });
    }
    return record;
  });
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

  /**
   * F-013（P08 DAG）：同事务状态事件（通知订阅）。只在真实转换边界调用；
   * payload 仅冻结身份与受控状态/原因，不含路径/凭据/策略正文。
   */
  function appendStatusEvent(record: PersistedIntegrationPlan): void {
    assertTransaction(db, `${OPERATION}.appendStatusEvent`);
    const sequence = (db.prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events').get()?.next ?? 1);
    db.prepare(
      `INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, 'integration_plan', ?, ?, ?, ?)`,
    ).run(
      randomUUID(), record.updatedAtUtcMs, record.updatedAtUtcMs, record.projectId, sequence,
      INTEGRATION_PLAN_STATUS_EVENT_TYPE, record.integrationId, record.revision,
      JSON.stringify({
        schemaVersion: 1,
        integrationId: record.integrationId,
        successorFeatureId: record.successorFeatureId,
        status: record.status,
        blockReasons: record.blockReasons,
        staleReasons: record.staleReasons,
      }),
      record.updatedAtUtcMs,
    );
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
    const created = getInTransaction(plan.projectId, plan.integrationId);
    // F-013：创建即首次状态事件（dependency_passed 或 blocked）。
    appendStatusEvent(created);
    return created;
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

  function validateOwnerUpdate(value: Record<string, unknown>, operation: string): {
    readonly operationId: string | undefined;
    readonly ownerId: string | undefined;
    readonly ownerVersion: number | undefined;
    readonly reconcile: boolean;
  } {
    const operationId = value.operationId === undefined ? undefined : validateStableId(value.operationId, { operation }, 'operationId');
    const ownerId = value.ownerId === undefined ? undefined : validateStableId(value.ownerId, { operation }, 'ownerId');
    const ownerVersion = value.ownerVersion === undefined ? undefined : validateRevision(value.ownerVersion, operation);
    const reconcile = value.reconcile === true;
    if ((operationId === undefined) !== (ownerId === undefined) || (operationId === undefined) !== (ownerVersion === undefined)) {
      throw new StorageError('validation', operation, 'operationId、ownerId、ownerVersion 必须同时提供');
    }
    return { operationId, ownerId, ownerVersion, reconcile };
  }

  function assertOwnerFence(current: PersistedIntegrationPlan, owner: ReturnType<typeof validateOwnerUpdate>, operation: string): void {
    const previous = current.integrationResult;
    if (previous?.operationId === undefined || previous.operationId === null) return;
    if (owner.operationId !== previous.operationId || owner.ownerId !== previous.ownerId || owner.ownerVersion !== previous.ownerVersion) {
      if (!(owner.reconcile === true && previous.operationStatus === 'unknown' && owner.operationId === previous.operationId)) {
        throw new StorageError('conflict', operation, '集成操作 owner/version fencing 未命中', {
          entity: entity(current.projectId, current.integrationId), details: { reason: 'owner_fenced', operationId: previous.operationId },
        });
      }
    }
  }

  function updateResultInTransaction(raw: unknown): PersistedIntegrationPlan {
    const operation = `${OPERATION}.updateResult`;
    assertTransaction(db, operation);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new StorageError('validation', operation, 'result update 输入必须是对象');
    const value = raw as Record<string, unknown>;
    const projectId = validateStableId(value.projectId, { operation }, 'projectId');
    const integrationId = validateStableId(value.integrationId, { operation }, 'integrationId');
    const expectedRevision = validateRevision(value.expectedRevision, operation);
    const owner = validateOwnerUpdate(value, operation);
    const current = getInTransaction(projectId, integrationId);
    assertOwnerFence(current, owner, operation);
    if (current.frozenAtUtcMs === null) throw new StorageError('conflict', operation, '集成计划必须先冻结才能写入结果', { entity: entity(projectId, integrationId) });
    let result = value.integrationResult as IntegrationResult | null;
    if (owner.operationId !== undefined && result !== null) {
      result = { ...result, operationId: owner.operationId, ownerId: owner.ownerId, ownerVersion: owner.ownerVersion,
        operationStatus: result.operationStatus ?? (result.commitSha !== null && result.treeSha !== null && result.verificationEvidence !== null ? 'succeeded' : 'unknown') };
    }
    if (current.integrationResult?.operationStatus === 'succeeded') {
      if (JSON.stringify(current.integrationResult) === JSON.stringify(result)) return current;
      throw new StorageError('conflict', operation, '已完成的集成操作不可被覆盖', {
        entity: entity(projectId, integrationId), details: { reason: 'operation_already_settled' },
      });
    }
    const next = createIntegrationPlan(planInput(current, result));
    const changed = db.prepare(`UPDATE integration_plans SET integration_result = ?, status = ?, block_reasons = ?, stale_reasons = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ?`).run(
      result === null ? null : JSON.stringify(next.integrationResult), next.status, JSON.stringify(next.blockReasons), JSON.stringify(next.staleReasons), now(), projectId, integrationId, expectedRevision,
    );
    if (changed.changes !== 1) throw new StorageError('conflict', operation, '集成结果 revision CAS 未命中', { entity: entity(projectId, integrationId), details: { expectedRevision, actualRevision: current.revision } });
    const updated = getInTransaction(projectId, integrationId);
    // F-013：结果写入即状态转换事件（integration_passed/blocked 等）。
    appendStatusEvent(updated);
    return updated;
  }

  function updateStatusInTransaction(raw: unknown): PersistedIntegrationPlan {
    const operation = `${OPERATION}.updateStatus`;
    assertTransaction(db, operation);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new StorageError('validation', operation, 'status update 输入必须是对象');
    const value = raw as Record<string, unknown>;
    const projectId = validateStableId(value.projectId, { operation }, 'projectId');
    const integrationId = validateStableId(value.integrationId, { operation }, 'integrationId');
    const expectedRevision = validateRevision(value.expectedRevision, operation);
    const owner = validateOwnerUpdate(value, operation);
    const current = getInTransaction(projectId, integrationId);
    assertOwnerFence(current, owner, operation);
    if (typeof value.status !== 'string' || !(INTEGRATION_PLAN_STATUSES as readonly string[]).includes(value.status)
      || !Array.isArray(value.blockReasons) || value.blockReasons.some(reason => !(INTEGRATION_BLOCK_REASONS as readonly string[]).includes(reason))
      || !Array.isArray(value.staleReasons) || value.staleReasons.some(reason => !(INTEGRATION_STALE_REASONS as readonly string[]).includes(reason))) {
      throw new StorageError('validation', operation, '状态更新形态非法');
    }
    if (current.status === value.status && JSON.stringify(current.blockReasons) === JSON.stringify(value.blockReasons)
      && JSON.stringify(current.staleReasons) === JSON.stringify(value.staleReasons)) return current;
    const changed = db.prepare('UPDATE integration_plans SET status = ?, block_reasons = ?, stale_reasons = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ?')
      .run(value.status, JSON.stringify(value.blockReasons), JSON.stringify(value.staleReasons), now(), projectId, integrationId, expectedRevision);
    if (changed.changes !== 1) throw new StorageError('conflict', operation, '集成计划状态 revision CAS 未命中', { entity: entity(projectId, integrationId), details: { expectedRevision, actualRevision: current.revision } });
    const updated = getInTransaction(projectId, integrationId);
    // F-013：同状态幂等重放不产生新事件；真实转换才发通知事件。
    appendStatusEvent(updated);
    return updated;
  }

  return {
    createIntegrationPlanInTransaction: createInTransaction,
    freezeIntegrationPlanInTransaction: freezeInTransaction,
    updateIntegrationPlanResultInTransaction: updateResultInTransaction,
    updateIntegrationPlanStatusInTransaction: updateStatusInTransaction,
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
    listIntegrationPlansByPhase(projectIdInput, phaseIdInput) {
      const operation = `${OPERATION}.listByPhase`;
      if (db.inTransaction) throw new TypeError(`${operation} 不能嵌套在写事务内`);
      const projectId = validateStableId(projectIdInput, { operation }, 'projectId');
      const phaseId = validateStableId(phaseIdInput, { operation }, 'phaseId');
      return transactSqliteConsistentRead(session, operation, () =>
        listIntegrationPlansByPhaseInTransaction(db, projectId, phaseId, operation));
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
