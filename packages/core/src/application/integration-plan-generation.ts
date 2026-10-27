import { isStorageError, StorageError } from '../ports/errors.js';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import {
  createIntegrationPlan,
  deriveIntegrationPlanStatus,
  type IntegrationPlanInput,
  type IntegrationPlanObservation,
} from '../ports/integration-plan.js';
import type {
  IntegrationPlanAccess,
  PersistedIntegrationPlan,
} from '../ports/integration-plan-store.js';
import type { IntegrationInputRef, IntegrationPredecessorInput } from '../ports/integration-plan.js';
import { validateStableId } from '../ports/validation.js';

const OPERATION = 'IntegrationPlanGeneration';

/** 已批准 Batch 的不可变集成输入；不携带当前 branch HEAD。 */
export interface IntegrationBatchApproval {
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly successorFeatureId: string;
  readonly predecessorFeatureIds: readonly string[];
  readonly targetBaseline: string;
  readonly approvedInputs: readonly IntegrationInputRef[];
  readonly verificationScope: readonly string[];
  readonly strategySummary: Readonly<Record<string, unknown>>;
  /** 缺省时按 Feature 稳定 ID 升序；提供时必须恰好覆盖全部前置。 */
  readonly mergeOrder?: readonly string[];
}

/** 从持久 Batch 授权事实读取集成范围，不读取 branch HEAD。 */
export interface IntegrationBatchApprovalReader {
  readApprovedBatch(projectId: string, batchId: string): IntegrationBatchApproval | undefined;
}

/** 前置 Feature 的固定交付核对结果；Git 适配器在此端口外完成读取。 */
export interface IntegrationPredecessorEvidence {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly dependencyPassed: boolean;
  /** 不存在、未成功交付或过期证据必须返回 null/false，不能从当前 HEAD 推导。 */
  readonly delivery: IntegrationPredecessorInput['delivery'];
  readonly commitExists: boolean;
  readonly coveredInputIds: readonly string[];
  readonly ancestorVerified: boolean;
  readonly evidenceFresh: boolean;
}

export interface IntegrationPredecessorEvidenceReader {
  readEvidence(projectId: string, phaseId: string, featureId: string): IntegrationPredecessorEvidence | undefined;
}

export interface IntegrationPlanGenerationRequest {
  readonly projectId: string;
  readonly batchId: string;
  /** 可选调用方核对；缺省使用 Batch 已批准的 successor/target。 */
  readonly successorFeatureId?: string;
  readonly targetBaseline?: string;
}

export interface IntegrationPlanGenerationResult {
  readonly plan: PersistedIntegrationPlan;
  readonly created: boolean;
  readonly frozen: boolean;
  readonly reused: boolean;
}

export interface IntegrationPlanGenerationStatusResult {
  readonly plan: PersistedIntegrationPlan;
  readonly status: ReturnType<typeof deriveIntegrationPlanStatus>['status'];
  readonly blockReasons: ReturnType<typeof deriveIntegrationPlanStatus>['blockReasons'];
  readonly staleReasons: ReturnType<typeof deriveIntegrationPlanStatus>['staleReasons'];
}

export interface IntegrationPlanGenerationService {
  /** 只生成/冻结计划；不执行 merge、模型调用或 Batch 创建。 */
  generate(request: IntegrationPlanGenerationRequest): IntegrationPlanGenerationResult;
  /** 读取冻结快照并与显式观察值比较；漂移只报告，不改写快照。 */
  status(projectId: string, integrationId: string, observation?: IntegrationPlanObservation): IntegrationPlanGenerationStatusResult;
}

export interface IntegrationPlanGenerationDeps {
  readonly atomic: AtomicCommandStore;
  readonly plans: Pick<IntegrationPlanAccess, 'readIntegrationPlan'>;
  readonly batches: IntegrationBatchApprovalReader;
  readonly predecessors: IntegrationPredecessorEvidenceReader;
}

function asStableId(value: unknown, field: string): string {
  return validateStableId(value, { operation: `${OPERATION}.validate` }, field);
}

function failure(reason: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new StorageError('conflict', `${OPERATION}.generate`, '集成计划生成被拒绝', {
    entity: { type: 'integration_plan' }, details: { reason, ...details },
  });
}

function readRequiredBatch(
  reader: IntegrationBatchApprovalReader,
  projectId: string,
  batchId: string,
): IntegrationBatchApproval {
  const batch = reader.readApprovedBatch(projectId, batchId);
  if (batch === undefined) {
    throw new StorageError('not_found', `${OPERATION}.generate`, '获准 Batch 不存在或不可见', {
      entity: { type: 'execution_batch', id: batchId, projectId },
    });
  }
  if (batch.projectId !== projectId || batch.batchId !== batchId) failure('batch_identity_mismatch');
  if (batch.predecessorFeatureIds.length === 0) failure('dependency_not_passed', { reason: 'empty_predecessors' });
  return batch;
}

function mergeOrderFor(batch: IntegrationBatchApproval): string[] {
  const ids = [...batch.predecessorFeatureIds];
  if (batch.mergeOrder !== undefined) return [...batch.mergeOrder];
  return ids.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function buildInput(
  batch: IntegrationBatchApproval,
  predecessors: readonly IntegrationPredecessorInput[],
): IntegrationPlanInput {
  const mergeOrder = mergeOrderFor(batch);
  return {
    projectId: batch.projectId,
    phaseId: batch.phaseId,
    batchId: batch.batchId,
    successorFeatureId: batch.successorFeatureId,
    targetBaseline: batch.targetBaseline,
    predecessors,
    approvedInputs: batch.approvedInputs,
    mergeOrder,
    verificationScope: batch.verificationScope,
    strategySummary: batch.strategySummary,
    integrationResult: null,
  };
}

export function createIntegrationPlanGenerationService(
  deps: IntegrationPlanGenerationDeps,
): IntegrationPlanGenerationService {
  if (deps === null || typeof deps !== 'object') throw new TypeError(`${OPERATION}.create: deps 必须是对象`);
  for (const name of ['atomic', 'plans', 'batches', 'predecessors'] as const) {
    if (deps[name] === null || deps[name] === undefined) throw new TypeError(`${OPERATION}.create: ${name} 依赖缺失`);
  }

  function generate(raw: IntegrationPlanGenerationRequest): IntegrationPlanGenerationResult {
    const projectId = asStableId(raw?.projectId, 'projectId');
    const batchId = asStableId(raw?.batchId, 'batchId');
    const batch = readRequiredBatch(deps.batches, projectId, batchId);
    if (raw.successorFeatureId !== undefined && raw.successorFeatureId !== batch.successorFeatureId) {
      failure('successor_identity_changed');
    }
    if (raw.targetBaseline !== undefined && raw.targetBaseline !== batch.targetBaseline) {
      failure('target_baseline_changed');
    }
    const mergeOrder = mergeOrderFor(batch);
    const featureIds = new Set(batch.predecessorFeatureIds);
    if (mergeOrder.length !== featureIds.size || new Set(mergeOrder).size !== mergeOrder.length
      || mergeOrder.some(featureId => !featureIds.has(featureId))) {
      failure('invalid_merge_order');
    }

    const evidenceByFeature = new Map<string, IntegrationPredecessorEvidence>();
    for (const featureId of mergeOrder) {
      const evidence = deps.predecessors.readEvidence(projectId, batch.phaseId, featureId);
      if (evidence === undefined) {
        evidenceByFeature.set(featureId, {
          projectId, phaseId: batch.phaseId, featureId, dependencyPassed: false,
          delivery: null, commitExists: false, coveredInputIds: [], ancestorVerified: false, evidenceFresh: false,
        });
      } else {
        if (evidence.projectId !== projectId || evidence.phaseId !== batch.phaseId || evidence.featureId !== featureId) {
          failure('predecessor_identity_mismatch', { featureId });
        }
        evidenceByFeature.set(featureId, evidence);
      }
    }

    const predecessors: IntegrationPredecessorInput[] = mergeOrder.map(featureId => {
      const evidence = evidenceByFeature.get(featureId)!;
      return {
        projectId, phaseId: batch.phaseId, featureId,
        dependencyPassed: evidence.dependencyPassed,
        delivery: evidence.evidenceFresh && evidence.commitExists ? evidence.delivery : null,
        coveredInputIds: evidence.coveredInputIds,
        ancestorVerified: evidence.ancestorVerified,
      };
    });
    if (predecessors.length === 1 && !predecessors[0]!.dependencyPassed) {
      failure('dependency_not_passed', { featureId: predecessors[0]!.featureId });
    }
    if (predecessors.length === 1 && predecessors[0]!.delivery === null) {
      failure('missing_delivery_evidence', { featureId: predecessors[0]!.featureId });
    }
    if (predecessors.length === 1 && !predecessors[0]!.ancestorVerified) {
      failure('ancestor_not_verified', { featureId: predecessors[0]!.featureId });
    }
    const input = buildInput(batch, predecessors);
    const generated = createIntegrationPlan(input);

    return deps.atomic.transact(`${OPERATION}.generate`, transaction => {
      let current: PersistedIntegrationPlan | undefined;
      try {
        current = transaction.getIntegrationPlan(projectId, generated.integrationId);
      } catch (error) {
        if (!isStorageError(error, 'not_found')) throw error;
      }
      if (current !== undefined) {
        if (current.inputDigest !== generated.inputDigest || current.targetBaseline !== generated.targetBaseline) {
          throw new StorageError('corrupt', `${OPERATION}.generate`, '已有集成计划身份与输入摘要不一致', {
            entity: { type: 'integration_plan', id: generated.integrationId, projectId },
          });
        }
        if (current.frozenAtUtcMs === null && current.status === 'dependency_passed') {
          const frozen = transaction.freezeIntegrationPlan({ projectId, integrationId: current.integrationId, expectedRevision: current.revision });
          return { plan: frozen, created: false, frozen: true, reused: true };
        }
        return { plan: current, created: false, frozen: current.frozenAtUtcMs !== null, reused: true };
      }
      const created = transaction.createIntegrationPlan(input);
      if (created.status !== 'dependency_passed') {
        return { plan: created, created: true, frozen: false, reused: false };
      }
      const frozen = transaction.freezeIntegrationPlan({
        projectId, integrationId: created.integrationId, expectedRevision: created.revision,
      });
      return { plan: frozen, created: true, frozen: true, reused: false };
    });
  }

  function status(projectIdInput: string, integrationIdInput: string, observation?: IntegrationPlanObservation): IntegrationPlanGenerationStatusResult {
    const projectId = asStableId(projectIdInput, 'projectId');
    const integrationId = asStableId(integrationIdInput, 'integrationId');
    const plan = deps.plans.readIntegrationPlan(projectId, integrationId);
    if (plan === undefined) {
      throw new StorageError('not_found', `${OPERATION}.status`, '集成计划不存在', {
        entity: { type: 'integration_plan', id: integrationId, projectId },
      });
    }
    const result = deriveIntegrationPlanStatus(plan, observation ?? null);
    return { plan, ...result };
  }

  return { generate, status };
}

export type { IntegrationPlanObservation };
