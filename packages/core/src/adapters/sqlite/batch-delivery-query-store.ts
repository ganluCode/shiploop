import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import { FEATURE_STATUSES, TASK_STATUSES } from '../../ports/plan-store.js';
import { EXECUTION_RUN_STATUSES } from '../../ports/execution-store.js';
import { FEATURE_DELIVERY_STATUSES } from '../../ports/git-operations.js';
import { validateExecutionBudgetSnapshot } from '../../ports/execution-budget.js';
import { resolveApprovedBatchConcurrency } from '../../ports/feature-dispatch.js';
import { transactSqliteConsistentRead } from './state-store.js';
import { createSqliteFeatureDeliveryQueryStore } from './feature-delivery-query-store.js';
import { buildFeatureDeliveryDetailResult } from '../../ports/feature-delivery-query.js';

import type { SqliteStorageSession } from './session.js';
import {
  deriveBatchDeliveryItemStatus,
  BATCH_DELIVERY_STATUSES,
  type BatchDeliveryBudgetView,
  type BatchDeliveryFeatureRecord,
  type BatchDeliveryIntegrationRecord,
  type BatchDeliveryQueryReadStore,
  type BatchDeliveryQueryRequest,
  type BatchDeliveryRunView,
  type BatchDeliveryStopRecord,
  type BatchDeliveryView,
} from '../../ports/batch-delivery-query.js';

const OPERATION = 'BatchDeliveryQueryStore';
const BATCH_STATUSES = ['queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted'] as const;
const STOP_STATUSES = ['stopping', 'stopped', 'uncertain'] as const;
const INTEGRATION_STATUSES = ['dependency_passed', 'integration_passed', 'stale', 'blocked'] as const;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

interface BatchRow {
  readonly id: string; readonly project_id: string; readonly phase_id: string; readonly feature_id: string;
  readonly revision: number; readonly status: string; readonly scope_snapshot: string;
  readonly config_snapshot: string; readonly budget_snapshot: string;
  readonly runs_created: number; readonly attempts_created: number; readonly runtime_starts: number;
  readonly deadline_at: number;
}
interface MemberRow { readonly project_id: string; readonly batch_id: string; readonly phase_id: string; readonly feature_id: string; readonly member_ordinal: number; }
interface FeatureRow { readonly id: string; readonly project_id: string; readonly phase_id: string; readonly status: string; readonly delivery_status: string; }
interface RunRow { readonly id: string; readonly project_id: string; readonly feature_id: string; readonly status: string; readonly reason: string | null; readonly started_at: number | null; readonly ended_at: number | null; readonly created_at: number; }
interface StopRow { readonly id: string; readonly project_id: string; readonly target_kind: string; readonly target_id: string; readonly batch_id: string; readonly feature_id: string | null; readonly run_id: string | null; readonly reason: string; readonly status: string; readonly stop_confirmed: number | null; readonly forced: number | null; readonly evidence_ref: string | null; readonly requested_at: number; readonly settled_at: number | null; }
interface IntegrationRow { readonly id: string; readonly project_id: string; readonly phase_id: string; readonly batch_id: string; readonly successor_feature_id: string; readonly status: string; readonly block_reasons: string; readonly stale_reasons: string; readonly integration_result: string | null; }
interface ResourceRow { readonly feature_id: string; readonly waiting_reason: string | null; readonly state: string; }

function context(field?: string): ValidationContext { return { operation: OPERATION, ...(field === undefined ? {} : { details: { field } }) }; }
function corrupt(message: string, projectId?: string, id?: string): never {
  throw new StorageError('corrupt', OPERATION, message, {
    ...(projectId === undefined ? {} : { entity: { type: 'execution_batch', projectId, ...(id === undefined ? {} : { id }) } }),
  });
}
function id(value: unknown, field: string, projectId?: string): string {
  try { return validateStableId(value, { operation: OPERATION }, field); }
  catch (cause) { corrupt(`${field} 损坏`, projectId); }
}
function integer(value: unknown, field: string, allowZero = true): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) corrupt(`${field} 损坏`);
  return value;
}
function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}
function parseObject(value: string, field: string, projectId: string, batchId: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) corrupt(`${field} 必须是对象`, projectId, batchId);
    return parsed as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw new StorageError('corrupt', OPERATION, `${field} JSON 损坏`, { entity: { type: 'execution_batch', projectId, id: batchId }, cause });
  }
}
function parseArray(value: string, field: string, projectId: string, batchId: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) corrupt(`${field} 必须是数组`, projectId, batchId);
    return parsed;
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw new StorageError('corrupt', OPERATION, `${field} JSON 损坏`, { entity: { type: 'execution_batch', projectId, id: batchId }, cause });
  }
}
function nullableText(value: unknown, field: string, projectId: string, batchId: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) corrupt(`${field} 损坏`, projectId, batchId);
  return value;
}
function boundedReasons(value: string, field: string, projectId: string, batchId: string): string[] {
  return parseArray(value, field, projectId, batchId).map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) corrupt(`${field}[${index}] 损坏`, projectId, batchId);
    return entry;
  });
}
function budgetView(row: BatchRow, projectId: string, nowUtcMs: number): { readonly budget: BatchDeliveryBudgetView; readonly snapshot: ReturnType<typeof validateExecutionBudgetSnapshot> } {
  const snapshotObject = parseObject(row.budget_snapshot, 'budget_snapshot', projectId, row.id);
  let snapshot: ReturnType<typeof validateExecutionBudgetSnapshot>;
  try { snapshot = validateExecutionBudgetSnapshot(snapshotObject, { operation: OPERATION, entity: { type: 'execution_batch', id: row.id, projectId } }); }
  catch (cause) { throw new StorageError('corrupt', OPERATION, '预算快照损坏', { entity: { type: 'execution_batch', id: row.id, projectId }, cause }); }
  const batch = snapshot.batch;
  const reasons: string[] = [];
  if (row.runs_created >= batch.maxRuns) reasons.push('maxRuns');
  if (row.attempts_created >= batch.maxTotalAttempts) reasons.push('maxTotalAttempts');
  if (row.runtime_starts >= batch.maxRuntimeStarts) reasons.push('maxRuntimeStarts');
  if (row.deadline_at !== batch.deadlineUtcMs) corrupt('Batch deadline 与预算快照不一致', projectId, row.id);
  if (nowUtcMs >= batch.deadlineUtcMs) reasons.push('deadline');
  const exhausted = row.runs_created >= batch.maxRuns || row.attempts_created >= batch.maxTotalAttempts || row.runtime_starts >= batch.maxRuntimeStarts || nowUtcMs >= batch.deadlineUtcMs;
  return {
    snapshot,
    budget: {
      status: exhausted ? 'exhausted' : 'available',
      blockingReasons: reasons,
      runsCreated: integer(row.runs_created, 'runs_created'),
      attemptsCreated: integer(row.attempts_created, 'attempts_created'),
      runtimeStarts: integer(row.runtime_starts, 'runtime_starts'),
      deadlineAtUtcMs: integer(row.deadline_at, 'deadline_at', false),
      tokenUsed: null,
      costUsed: null,
    },
  };
}
function stopFromRow(row: StopRow, projectId: string, batchId: string): BatchDeliveryStopRecord {
  const operationId = id(row.id, 'stopOperationId', projectId);
  if (row.project_id !== projectId || row.batch_id !== batchId || !STOP_STATUSES.includes(row.status as typeof STOP_STATUSES[number])) corrupt('停止操作归属或状态损坏', projectId, batchId);
  if (!['run', 'batch', 'feature'].includes(row.target_kind) || id(row.target_id, 'targetId', projectId) !== row.target_id) corrupt('停止操作目标损坏', projectId, batchId);
  if (row.stop_confirmed !== null && row.stop_confirmed !== 0 && row.stop_confirmed !== 1) corrupt('stopConfirmed 损坏', projectId, batchId);
  if (row.forced !== null && row.forced !== 0 && row.forced !== 1) corrupt('forced 损坏', projectId, batchId);
  if (row.evidence_ref !== null && (row.evidence_ref.length === 0 || row.evidence_ref.length > 128)) corrupt('停止证据引用损坏', projectId, batchId);
  const requestedAtUtcMs = integer(row.requested_at, 'requested_at', false);
  const settledAtUtcMs = nullableInteger(row.settled_at, 'settled_at');
  if (settledAtUtcMs !== null && settledAtUtcMs < requestedAtUtcMs) corrupt('停止时间顺序损坏', projectId, batchId);
  return {
    operationId, targetKind: row.target_kind as BatchDeliveryStopRecord['targetKind'], targetId: row.target_id,
    status: row.status as BatchDeliveryStopRecord['status'], reason: row.reason,
    stopConfirmed: row.stop_confirmed === null ? null : row.stop_confirmed === 1,
    forced: row.forced === null ? null : row.forced === 1,
    evidenceRef: row.evidence_ref, requestedAtUtcMs, settledAtUtcMs,
  };
}
function integrationFromRow(row: IntegrationRow, projectId: string, batchId: string): BatchDeliveryIntegrationRecord {
  if (row.project_id !== projectId || row.batch_id !== batchId || !INTEGRATION_STATUSES.includes(row.status as typeof INTEGRATION_STATUSES[number])) corrupt('集成计划归属或状态损坏', projectId, batchId);
  const integrationResult = row.integration_result === null ? null : parseObject(row.integration_result, 'integration_result', projectId, batchId);
  let commitSha: string | null = null;
  let treeSha: string | null = null;
  let evidenceRef: string | null = null;
  if (integrationResult !== null) {
    for (const [field, target] of [['commitSha', 'commit'], ['treeSha', 'tree']] as const) {
      const value = integrationResult[field];
      if (value !== null && value !== undefined && (typeof value !== 'string' || !OID.test(value))) corrupt(`integration_result.${field} 损坏`, projectId, batchId);
      if (target === 'commit') commitSha = (value as string | null | undefined) ?? null;
      else treeSha = (value as string | null | undefined) ?? null;
    }
    const evidence = integrationResult.verificationEvidence;
    if (evidence !== null && evidence !== undefined) {
      if (typeof evidence !== 'object' || Array.isArray(evidence) || typeof (evidence as Record<string, unknown>).evidenceId !== 'string') corrupt('集成验证证据损坏', projectId, batchId);
      evidenceRef = id((evidence as Record<string, unknown>).evidenceId, 'evidenceRef', projectId);
    }
  }
  return {
    integrationId: id(row.id, 'integrationId', projectId), successorFeatureId: id(row.successor_feature_id, 'successorFeatureId', projectId),
    status: row.status as BatchDeliveryIntegrationRecord['status'], blockReasons: boundedReasons(row.block_reasons, 'blockReasons', projectId, batchId),
    staleReasons: boundedReasons(row.stale_reasons, 'staleReasons', projectId, batchId), commitSha, treeSha, evidenceRef,
  };
}

export function createSqliteBatchDeliveryQueryStore(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {},
): BatchDeliveryQueryReadStore {
  if (session === null || typeof session !== 'object') throw new TypeError('createSqliteBatchDeliveryQueryStore: session 必须是 SqliteStorageSession');
  const nowUtcMs = options.nowUtcMs ?? Date.now;
  const featureDelivery = createSqliteFeatureDeliveryQueryStore(session);
  return {
    readBatchDeliveryView(project: unknown, batch: unknown, request: BatchDeliveryQueryRequest): BatchDeliveryView | undefined {
      const projectId = id(project, 'projectId');
      const batchId = id(batch, 'batchId', projectId);
      if (request === null || typeof request !== 'object' || (request.afterId !== null && typeof request.afterId !== 'string') || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 200) {
        throw new StorageError('validation', OPERATION, '分页请求非法', { details: { field: 'request', reason: 'invalid_pagination' } });
      }
      if (request.afterId !== null) id(request.afterId, 'afterId', projectId);
      const assemble = (): BatchDeliveryView | undefined => {
        const now = integer(nowUtcMs(), 'nowUtcMs');
        const row = session.database.prepare<[string, string], BatchRow>('SELECT id, project_id, phase_id, feature_id, revision, status, scope_snapshot, config_snapshot, budget_snapshot, runs_created, attempts_created, runtime_starts, deadline_at FROM execution_batches WHERE project_id = ? AND id = ?').get(projectId, batchId);
        if (row === undefined) {
          const other = session.database.prepare<[string], { project_id: string }>('SELECT project_id FROM execution_batches WHERE id = ?').get(batchId);
          if (other !== undefined && other.project_id !== projectId) return undefined;
          return undefined;
        }
        if (!BATCH_STATUSES.includes(row.status as typeof BATCH_STATUSES[number])) corrupt('Batch 状态损坏', projectId, batchId);
        integer(row.revision, 'revision', false); id(row.phase_id, 'phaseId', projectId); id(row.feature_id, 'featureId', projectId);
        const scope = parseObject(row.scope_snapshot, 'scope_snapshot', projectId, batchId);
        if (!Array.isArray(scope.featureIds) || scope.featureIds.length === 0 || scope.featureIds.length > 1000) corrupt('固定 Batch 范围损坏', projectId, batchId);
        const scopeFeatureIds = scope.featureIds.map((value, index) => id(value, `scope.featureIds[${index}]`, projectId));
        if (!scopeFeatureIds.includes(row.feature_id)) corrupt('Batch 兼容 Feature 不在固定范围内', projectId, batchId);
        const memberRows = session.database.prepare<[string, string], MemberRow>('SELECT project_id, batch_id, phase_id, feature_id, member_ordinal FROM execution_batch_members WHERE project_id = ? AND batch_id = ? ORDER BY member_ordinal, feature_id').all(projectId, batchId);
        const members = memberRows.length === 0 ? scopeFeatureIds.map((featureId, index) => ({ project_id: projectId, batch_id: batchId, phase_id: row.phase_id, feature_id: featureId, member_ordinal: index + 1 })) : memberRows;
        const ordinals = new Set<number>();
        for (const member of members) {
          if (!Number.isSafeInteger(member.member_ordinal) || member.member_ordinal < 1 || ordinals.has(member.member_ordinal)) corrupt('Batch 成员顺序损坏', projectId, batchId);
          ordinals.add(member.member_ordinal);
        }
        const featureIds = members.map(member => {
          if (member.project_id !== projectId || member.batch_id !== batchId || member.phase_id !== row.phase_id) corrupt('Batch 成员归属损坏', projectId, batchId);
          return id(member.feature_id, 'featureId', projectId);
        });
        if (new Set(featureIds).size !== featureIds.length || featureIds.length !== scopeFeatureIds.length || featureIds.some(featureId => !scopeFeatureIds.includes(featureId))) corrupt('Batch 成员与固定范围不一致', projectId, batchId);
        const features = session.database.prepare<unknown[], FeatureRow>('SELECT id, project_id, phase_id, status, delivery_status FROM features WHERE project_id = ? AND phase_id = ? AND id IN (' + featureIds.map(() => '?').join(',') + ')').all(projectId, row.phase_id, ...featureIds);
        const featureMap = new Map(features.map(feature => [feature.id, feature]));
        if (featureMap.size !== featureIds.length) corrupt('Batch 成员 Feature 缺失或归属损坏', projectId, batchId);
        for (const feature of features) {
          if (!FEATURE_STATUSES.includes(feature.status as typeof FEATURE_STATUSES[number]) || !FEATURE_DELIVERY_STATUSES.includes(feature.delivery_status as typeof FEATURE_DELIVERY_STATUSES[number])) corrupt('Feature 状态损坏', projectId, feature.id);
        }
        const { budget: batchBudget } = budgetView(row, projectId, now);
        const config = parseObject(row.config_snapshot, 'config_snapshot', projectId, batchId);
        let maxConcurrentFeatures: number;
        try { maxConcurrentFeatures = resolveApprovedBatchConcurrency(config); }
        catch (cause) { throw new StorageError('corrupt', OPERATION, '并发快照损坏', { entity: { type: 'execution_batch', projectId, id: batchId }, cause }); }
        const concurrency = (config.concurrency && typeof config.concurrency === 'object' && !Array.isArray(config.concurrency)) ? config.concurrency as Record<string, unknown> : {};
        const concurrencySource = typeof concurrency.source === 'string' ? concurrency.source : null;
        const runs = session.database.prepare<[string, string], RunRow>('SELECT id, project_id, feature_id, status, reason, started_at, ended_at, created_at FROM runs WHERE project_id = ? AND batch_id = ? ORDER BY feature_id, created_at, id').all(projectId, batchId).map(run => {
          if (!featureMap.has(run.feature_id) || !EXECUTION_RUN_STATUSES.includes(run.status as typeof EXECUTION_RUN_STATUSES[number])) corrupt('Run 归属或状态损坏', projectId, batchId);
          const startedAtUtcMs = nullableInteger(run.started_at, 'started_at');
          const endedAtUtcMs = nullableInteger(run.ended_at, 'ended_at');
          if (startedAtUtcMs !== null && endedAtUtcMs !== null && endedAtUtcMs < startedAtUtcMs) corrupt('Run 时间顺序损坏', projectId, run.id);
          return { runId: id(run.id, 'runId', projectId), featureId: run.feature_id, status: run.status as BatchDeliveryRunView['status'], reason: nullableText(run.reason, 'run.reason', projectId, batchId), startedAtUtcMs, endedAtUtcMs, durationMs: startedAtUtcMs !== null && endedAtUtcMs !== null ? endedAtUtcMs - startedAtUtcMs : null };
        });
        const stopRows = session.database.prepare<[string, string], StopRow>("SELECT id, project_id, target_kind, target_id, batch_id, feature_id, run_id, reason, status, stop_confirmed, forced, evidence_ref, requested_at, settled_at FROM execution_stop_operations WHERE project_id = ? AND batch_id = ? ORDER BY requested_at, id LIMIT 201").all(projectId, batchId);
        const stopOperations = stopRows.map(stop => stopFromRow(stop, projectId, batchId));
        const stopsByFeature = new Map<string, BatchDeliveryStopRecord[]>();
        for (const stop of stopOperations) {
          const featureId = stop.targetKind === 'feature' ? stop.targetId : stop.targetKind === 'run' ? runs.find(run => run.runId === stop.targetId)?.featureId : null;
          if (featureId !== null && featureId !== undefined) stopsByFeature.set(featureId, [...(stopsByFeature.get(featureId) ?? []), stop]);
        }
        const integrationRows = session.database.prepare<[string, string], IntegrationRow>('SELECT id, project_id, phase_id, batch_id, successor_feature_id, status, block_reasons, stale_reasons, integration_result FROM integration_plans WHERE project_id = ? AND batch_id = ? ORDER BY id').all(projectId, batchId);
        const integrations = integrationRows.map(integration => integrationFromRow(integration, projectId, batchId));
        const integrationsByFeature = new Map<string, BatchDeliveryIntegrationRecord[]>();
        for (const integration of integrations) integrationsByFeature.set(integration.successorFeatureId, [...(integrationsByFeature.get(integration.successorFeatureId) ?? []), integration]);
        const failedPredecessors = new Map<string, string[]>();
        const dependencyRows = session.database.prepare<[string, string], { feature_id: string; depends_on_id: string }>('SELECT feature_id, depends_on_id FROM feature_dependencies WHERE project_id = ? AND phase_id = ? ORDER BY feature_id, depends_on_id').all(projectId, row.phase_id);
        for (const dependency of dependencyRows) {
          const predecessor = featureMap.get(dependency.depends_on_id);
          if (featureMap.has(dependency.feature_id) && predecessor !== undefined && ['failed', 'partial'].includes(predecessor.status)) failedPredecessors.set(dependency.feature_id, [...(failedPredecessors.get(dependency.feature_id) ?? []), dependency.depends_on_id]);
        }
        const resourceRows = session.database.prepare<[string, string], ResourceRow>(`SELECT runs.feature_id, leases.waiting_reason, leases.state FROM feature_resource_leases leases JOIN run_dispatch_claims claims ON claims.project_id = leases.project_id AND claims.id = leases.owner_id AND claims.claim_version = leases.owner_version JOIN runs ON runs.project_id = claims.project_id AND runs.id = claims.run_id WHERE leases.project_id = ? AND runs.batch_id = ? AND leases.state IN ('held', 'quarantined')`).all(projectId, batchId);
        const resourceWaitingFeatures = new Set(resourceRows.filter(resource => resource.waiting_reason !== null || resource.state === 'quarantined').map(resource => resource.feature_id));
        const allRecords = featureIds.map(featureId => {
          const feature = featureMap.get(featureId)!;
          const deliveryView = featureDelivery.readFeatureDeliveryView(projectId, featureId);
          if (deliveryView === undefined) corrupt('Feature 分轴视图缺失', projectId, featureId);
          const delivery = buildFeatureDeliveryDetailResult(deliveryView!);
          const featureRuns = runs.filter(run => run.featureId === featureId);
          const featureStops = stopsByFeature.get(featureId) ?? [];
          const featureIntegrations = integrationsByFeature.get(featureId) ?? [];
          const taskStatuses = delivery.axes.tasks.records.map(task => task.status);
          const approvalStatus = delivery.axes.approval.items.some(item => item.status === 'pending') ? 'pending' : delivery.axes.approval.items.length === 0 ? 'none' : 'approved';
          const integrationBlocked = featureIntegrations.some(integration => integration.status === 'blocked' || integration.status === 'stale');
          const latestRun = featureRuns[featureRuns.length - 1]?.status ?? null;
          const applicableStops = [...featureStops, ...stopOperations.filter(stop => stop.targetKind === 'batch')];
          const latestStop = applicableStops[applicableStops.length - 1]?.status ?? null;
          const status = row.status === 'cancelled' ? 'cancelled' : deriveBatchDeliveryItemStatus({ featureStatus: feature.status as BatchDeliveryFeatureRecord['featureStatus'], deliveryStatus: feature.delivery_status as BatchDeliveryFeatureRecord['deliveryStatus'], taskStatuses, runStatus: latestRun, approvalStatus, integrationBlocked, stopStatus: latestStop, budgetExhausted: batchBudget.status === 'exhausted', manualBlock: delivery.axes.tasks.records.some(task => task.manualBlock) });
          const blockingReasons = [...(failedPredecessors.get(featureId) ?? []).map(predecessor => `failed_predecessor:${predecessor}`), ...featureIntegrations.flatMap(integration => [...integration.blockReasons, ...integration.staleReasons]), ...applicableStops.filter(stop => stop.status !== 'stopped').map(stop => `stop:${stop.status}`), ...batchBudget.blockingReasons];
          const evidenceRefs = new Set<string>();
          for (const reference of [delivery.outcome.identities.runId, delivery.outcome.identities.batchId, delivery.outcome.identities.verificationBatchId, delivery.outcome.identities.gitOperationId]) if (reference !== null) evidenceRefs.add(reference);
          for (const integration of featureIntegrations) { evidenceRefs.add(integration.integrationId); if (integration.evidenceRef !== null) evidenceRefs.add(integration.evidenceRef); }
          for (const stop of applicableStops) if (stop.evidenceRef !== null) evidenceRefs.add(stop.evidenceRef);
          return { featureId, featureStatus: feature.status as BatchDeliveryFeatureRecord['featureStatus'], deliveryStatus: feature.delivery_status as BatchDeliveryFeatureRecord['deliveryStatus'], status, reason: blockingReasons[0] ?? (status === 'completed' ? 'completed' : status), failurePredecessors: failedPredecessors.get(featureId) ?? [], blockingReasons, delivery, runs: featureRuns, integrations: featureIntegrations, stopOperations: applicableStops, budget: batchBudget, evidenceRefs: [...evidenceRefs].sort() } satisfies BatchDeliveryFeatureRecord;
        });
        const after = request.afterId;
        const afterIndex = after === null ? -1 : featureIds.indexOf(after);
        const visible = after === null ? allRecords : afterIndex < 0 ? [] : allRecords.slice(afterIndex + 1);
        const page = visible.slice(0, request.limit);
        const nextId = visible.length > request.limit ? page[page.length - 1]?.featureId ?? null : null;
        const summary = Object.fromEntries(BATCH_DELIVERY_STATUSES.map(status => [status, allRecords.filter(record => record.status === status).length])) as Record<BatchDeliveryFeatureRecord['status'], number>;
        const activeRunIds = new Set(runs.filter(run => ['running', 'pausing', 'cancelling'].includes(run.status)).map(run => run.runId));
        return {
          batch: { id: batchId, projectId, phaseId: row.phase_id, status: row.status as BatchDeliveryView['batch']['status'], revision: integer(row.revision, 'revision', false), featureIds, maxConcurrentFeatures, concurrencySource, deadlineAtUtcMs: integer(row.deadline_at, 'deadline_at', false), budget: batchBudget },
          records: page, nextId, summary, currentRunningCount: activeRunIds.size, readyCount: runs.filter(run => run.status === 'queued').length, resourceWaitingCount: resourceWaitingFeatures.size, stopOperations, integrations,
        };
      };
      return session.database.inTransaction ? assemble() : transactSqliteConsistentRead(session, OPERATION, assemble);
    },
  };
}
