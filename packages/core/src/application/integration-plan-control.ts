import { randomUUID } from 'node:crypto';
import { StorageError } from '../ports/errors.js';
import {
  deriveIntegrationPlanStatus,
  type IntegrationPlanObservation,
  type IntegrationResult,
} from '../ports/integration-plan.js';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import type { IntegrationPlanAccess, PersistedIntegrationPlan } from '../ports/integration-plan-store.js';
import { validatePositiveInteger, validateStableId } from '../ports/validation.js';

const OPERATION = 'IntegrationPlanControl';

type Owner = { readonly ownerId: string; readonly ownerVersion: number };

export interface IntegrationPlanControlDeps {
  readonly atomic: AtomicCommandStore;
  readonly plans: Pick<IntegrationPlanAccess, 'readIntegrationPlan'>;
}

export interface IntegrationPlanOperationRequest extends Owner {
  readonly projectId: string;
  readonly integrationId: string;
  readonly targetBaseline?: string;
  readonly inputDigest?: string;
}

export interface IntegrationPlanResultRequest extends IntegrationPlanOperationRequest {
  readonly operationId: string;
  readonly result: Omit<IntegrationResult, 'operationId' | 'ownerId' | 'ownerVersion' | 'operationStatus'>;
}

export interface IntegrationSuccessorStartRequest {
  readonly projectId: string;
  readonly successorFeatureId: string;
  readonly integrationId: string;
  readonly targetBaseline?: string;
  readonly inputDigest?: string;
}

export interface FixedIntegrationBaseline {
  readonly integrationId: string;
  readonly successorFeatureId: string;
  /** 后继 worktree 的唯一允许 base commit。 */
  readonly baseCommit: string;
  readonly treeSha: string;
  readonly targetBaseline: string;
  readonly inputDigest: string;
  readonly planRevision: number;
}

export interface IntegrationPlanControlService {
  begin(request: IntegrationPlanOperationRequest): { readonly plan: PersistedIntegrationPlan; readonly operationId: string; readonly reused: boolean };
  recordResult(request: IntegrationPlanResultRequest): { readonly plan: PersistedIntegrationPlan; readonly idempotent: boolean };
  interrupt(request: IntegrationPlanOperationRequest & { readonly operationId: string }): { readonly plan: PersistedIntegrationPlan; readonly idempotent: boolean };
  reconcile(request: IntegrationPlanResultRequest): { readonly plan: PersistedIntegrationPlan; readonly idempotent: boolean };
  refresh(request: IntegrationPlanOperationRequest): PersistedIntegrationPlan;
  assertSuccessorStart(request: IntegrationSuccessorStartRequest): FixedIntegrationBaseline;
}

function owner(raw: Owner): Owner {
  validateStableId(raw.ownerId, { operation: `${OPERATION}.validate` }, 'ownerId');
  validatePositiveInteger(raw.ownerVersion, { operation: `${OPERATION}.validate` }, 'ownerVersion');
  return raw;
}

function inputFromPlan(plan: PersistedIntegrationPlan, integrationResult: IntegrationResult | null) {
  return {
    projectId: plan.projectId, phaseId: plan.phaseId, batchId: plan.batchId,
    successorFeatureId: plan.successorFeatureId, targetBaseline: plan.targetBaseline,
    predecessors: plan.predecessors, approvedInputs: plan.approvedInputs, mergeOrder: plan.mergeOrder,
    verificationScope: plan.verificationScope, strategySummary: plan.strategySummary, integrationResult,
  };
}

function fail(reason: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new StorageError('conflict', `${OPERATION}.control`, '集成计划当前不可继续', {
    details: { reason, ...details },
  });
}

function readPlan(deps: IntegrationPlanControlDeps, projectId: string, integrationId: string): PersistedIntegrationPlan {
  const plan = deps.plans.readIntegrationPlan(projectId, integrationId);
  if (plan === undefined) {
    throw new StorageError('not_found', `${OPERATION}.read`, '集成计划不存在', {
      entity: { type: 'integration_plan', id: integrationId, projectId },
    });
  }
  return plan;
}

function observation(request: { readonly targetBaseline?: string; readonly inputDigest?: string; readonly integrationId: string }): IntegrationPlanObservation {
  return { targetBaseline: request.targetBaseline, inputDigest: request.inputDigest, integrationId: request.integrationId };
}

function assertFresh(plan: PersistedIntegrationPlan, request: { readonly targetBaseline?: string; readonly inputDigest?: string; readonly integrationId: string }): void {
  const current = deriveIntegrationPlanStatus(plan, observation(request));
  if (current.status === 'stale') fail('integration_stale', { staleReasons: current.staleReasons });
}

function operationResult(
  result: Omit<IntegrationResult, 'operationId' | 'ownerId' | 'ownerVersion' | 'operationStatus'> | null,
  ownerInfo: Owner,
  operationStatus: 'pending' | 'succeeded' | 'unknown',
): IntegrationResult {
  return {
    ...(result ?? { commitSha: null, treeSha: null, verificationEvidence: null, llmNoConflictText: null }),
    operationId: undefined,
    ownerId: ownerInfo.ownerId,
    ownerVersion: ownerInfo.ownerVersion,
    operationStatus,
  };
}

export function createIntegrationPlanControlService(deps: IntegrationPlanControlDeps): IntegrationPlanControlService {
  if (deps === null || typeof deps !== 'object' || deps.atomic === undefined || deps.plans === undefined) {
    throw new TypeError(`${OPERATION}.create: atomic/plans 依赖缺失`);
  }

  function begin(raw: IntegrationPlanOperationRequest) {
    const projectId = validateStableId(raw.projectId, { operation: `${OPERATION}.begin` }, 'projectId');
    const integrationId = validateStableId(raw.integrationId, { operation: `${OPERATION}.begin` }, 'integrationId');
    const current = readPlan(deps, projectId, integrationId);
    const info = owner(raw);
    assertFresh(current, { ...raw, integrationId });
    if (current.frozenAtUtcMs === null) fail('plan_not_frozen');
    if (current.integrationResult?.operationId !== undefined && current.integrationResult.operationId !== null) {
      if (current.integrationResult.operationStatus === 'succeeded') return { plan: current, operationId: current.integrationResult.operationId, reused: true };
      fail(current.integrationResult.operationStatus === 'unknown' ? 'operation_result_unknown' : 'operation_in_progress', {
        operationId: current.integrationResult.operationId,
      });
    }
    if (current.status !== 'dependency_passed') fail(current.status === 'stale' ? 'integration_stale' : 'plan_blocked', { status: current.status });
    const operationId = randomUUID();
    const plan = deps.atomic.transact(`${OPERATION}.begin`, (tx: CommandTransaction) => {
      const latest = tx.getIntegrationPlan(projectId, integrationId);
      if (latest.revision !== current.revision) fail('revision_changed');
      return tx.updateIntegrationPlanResult({
        projectId, integrationId, expectedRevision: latest.revision, operationId,
        ownerId: info.ownerId, ownerVersion: info.ownerVersion,
        integrationResult: { ...operationResult(null, info, 'pending'), operationId },
      });
    });
    return { plan, operationId, reused: false };
  }

  function record(raw: IntegrationPlanResultRequest, reconcile = false) {
    const projectId = validateStableId(raw.projectId, { operation: `${OPERATION}.record` }, 'projectId');
    const integrationId = validateStableId(raw.integrationId, { operation: `${OPERATION}.record` }, 'integrationId');
    const operationId = validateStableId(raw.operationId, { operation: `${OPERATION}.record` }, 'operationId');
    const info = owner(raw);
    const current = readPlan(deps, projectId, integrationId);
    assertFresh(current, { ...raw, integrationId });
    const previous = current.integrationResult;
    if (previous?.operationId !== operationId) fail('operation_identity_mismatch', { operationId });
    if ((previous.ownerId !== undefined && previous.ownerId !== info.ownerId)
      || (previous.ownerVersion !== undefined && previous.ownerVersion !== info.ownerVersion)) {
      if (!(reconcile && previous.operationStatus === 'unknown')) fail('owner_fenced', { operationId });
    }
    if (previous.operationStatus === 'succeeded') {
      const expected = operationResult(raw.result, info, 'succeeded');
      if (JSON.stringify(previous) === JSON.stringify({ ...expected, operationId })) return { plan: current, idempotent: true };
      fail('operation_already_settled', { operationId });
    }
    const result = { ...raw.result, operationId, ownerId: info.ownerId, ownerVersion: info.ownerVersion,
      operationStatus: 'succeeded' as const };
    const plan = deps.atomic.transact(`${OPERATION}.${reconcile ? 'reconcile' : 'record'}`, (tx: CommandTransaction) => tx.updateIntegrationPlanResult({
      projectId, integrationId, expectedRevision: current.revision, operationId,
      ownerId: info.ownerId, ownerVersion: info.ownerVersion, reconcile,
      integrationResult: result,
    }));
    return { plan, idempotent: false };
  }

  function interrupt(raw: IntegrationPlanOperationRequest & { readonly operationId: string }) {
    const projectId = validateStableId(raw.projectId, { operation: `${OPERATION}.interrupt` }, 'projectId');
    const integrationId = validateStableId(raw.integrationId, { operation: `${OPERATION}.interrupt` }, 'integrationId');
    const operationId = validateStableId(raw.operationId, { operation: `${OPERATION}.interrupt` }, 'operationId');
    const info = owner(raw);
    const current = readPlan(deps, projectId, integrationId);
    if (current.integrationResult?.operationId !== operationId) fail('operation_identity_mismatch', { operationId });
    if (current.integrationResult?.operationStatus === 'unknown') return { plan: current, idempotent: true };
    const plan = deps.atomic.transact(`${OPERATION}.interrupt`, (tx: CommandTransaction) => tx.updateIntegrationPlanResult({
      projectId, integrationId, expectedRevision: current.revision, operationId,
      ownerId: info.ownerId, ownerVersion: info.ownerVersion,
      integrationResult: { ...operationResult(null, info, 'unknown'), operationId },
    }));
    return { plan, idempotent: false };
  }

  function refresh(raw: IntegrationPlanOperationRequest): PersistedIntegrationPlan {
    const projectId = validateStableId(raw.projectId, { operation: `${OPERATION}.refresh` }, 'projectId');
    const integrationId = validateStableId(raw.integrationId, { operation: `${OPERATION}.refresh` }, 'integrationId');
    const current = readPlan(deps, projectId, integrationId);
    const derived = deriveIntegrationPlanStatus(current, observation({ ...raw, integrationId }));
    if (derived.status === current.status && JSON.stringify(derived.blockReasons) === JSON.stringify(current.blockReasons)
      && JSON.stringify(derived.staleReasons) === JSON.stringify(current.staleReasons)) return current;
    const info = owner(raw);
    return deps.atomic.transact(`${OPERATION}.refresh`, (tx: CommandTransaction) => tx.updateIntegrationPlanStatus({
      projectId, integrationId, expectedRevision: current.revision, status: derived.status,
      blockReasons: derived.blockReasons, staleReasons: derived.staleReasons,
      ...(current.integrationResult?.operationId === undefined ? {} : { operationId: current.integrationResult.operationId, ownerId: info.ownerId, ownerVersion: info.ownerVersion }),
    }));
  }

  function assertSuccessorStart(raw: IntegrationSuccessorStartRequest): FixedIntegrationBaseline {
    const projectId = validateStableId(raw.projectId, { operation: `${OPERATION}.gate` }, 'projectId');
    const successorFeatureId = validateStableId(raw.successorFeatureId, { operation: `${OPERATION}.gate` }, 'successorFeatureId');
    const integrationId = validateStableId(raw.integrationId, { operation: `${OPERATION}.gate` }, 'integrationId');
    const plan = readPlan(deps, projectId, integrationId);
    if (plan.successorFeatureId !== successorFeatureId) fail('successor_identity_mismatch');
    const derived = deriveIntegrationPlanStatus(plan, observation(raw));
    if (derived.status !== 'integration_passed' || plan.status !== 'integration_passed') {
      fail(derived.status === 'stale' || plan.status === 'stale' ? 'integration_stale' : 'integration_not_passed', {
        status: derived.status, blockReasons: derived.blockReasons, staleReasons: derived.staleReasons,
      });
    }
    const result = plan.integrationResult;
    if (result === null || result.commitSha === null || result.treeSha === null || result.verificationEvidence === null
      || (result.operationStatus !== undefined && result.operationStatus !== null && result.operationStatus !== 'succeeded')) {
      fail('integration_evidence_incomplete');
    }
    return { integrationId, successorFeatureId, baseCommit: result.commitSha, treeSha: result.treeSha,
      targetBaseline: plan.targetBaseline, inputDigest: plan.inputDigest, planRevision: plan.revision };
  }

  return { begin, recordResult: raw => record(raw), interrupt, reconcile: raw => record(raw, true), refresh, assertSuccessorStart };
}

export type { IntegrationPlanObservation };
