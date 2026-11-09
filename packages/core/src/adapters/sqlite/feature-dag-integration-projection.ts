import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import type {
  FeatureIntegrationEvidence,
  FeatureIntegrationEvidenceStatus,
} from '../../ports/feature-dag.js';
import { featureDagEdgeEvidenceKey } from '../../ports/feature-dag.js';
import type { IntegrationPlanStatus } from '../../ports/integration-plan.js';
import type { PersistedIntegrationPlan } from '../../ports/integration-plan-store.js';
import { listIntegrationPlansByPhaseInTransaction } from './integration-plan-store.js';

/**
 * P07 DAG / F-004：integration plan → Feature DAG 集成证据的只读投影。
 *
 * Feature DAG 与 integration plan 保持两个独立领域事实；这里只在同一一致读视图内
 * 把已冻结的计划状态投影为边级/节点级证据，不写回任何一方，也不建立第二套状态机。
 * 代码成果只来自计划中冻结的交付 SHA/目标基线，不读分支名或当前 HEAD，也不按
 * Feature 完成先后推导。
 */
export interface FeatureDagEdgeRef {
  readonly featureId: string;
  readonly dependsOnId: string;
}

export interface FeatureDagIntegrationEvidenceView {
  /** 节点级证据：全部当前消费方的边级证据都通过才非空（fail-closed 聚合）。 */
  readonly nodeEvidence: ReadonlyMap<string, FeatureIntegrationEvidence | null>;
  /** 边级证据：key 为 featureId\u0000dependsOnId；null 表示权威计划缺失。 */
  readonly edgeEvidence: ReadonlyMap<string, FeatureIntegrationEvidence | null>;
}

const PLAN_STATUS_TO_EVIDENCE: Readonly<Record<IntegrationPlanStatus, FeatureIntegrationEvidenceStatus>> = {
  integration_passed: 'passed',
  dependency_passed: 'pending',
  stale: 'stale',
  blocked: 'blocked',
};

const DRIFT_STALE_REASON = 'dependency_edges_changed';

function corrupt(operation: string, reason: string, details: Readonly<Record<string, unknown>>): StorageError {
  return new StorageError('corrupt', operation, 'Feature DAG 集成证据投影遇到非法持久事实', {
    details: { reason, ...details },
  });
}

/** 同一后继存在多个计划时选择权威计划：最新 updated_at，再以 integrationId 稳定 tiebreak。 */
function authoritativePlanOf(plans: readonly PersistedIntegrationPlan[]): Map<string, PersistedIntegrationPlan> {
  const authoritative = new Map<string, PersistedIntegrationPlan>();
  for (const plan of plans) {
    const current = authoritative.get(plan.successorFeatureId);
    if (current === undefined
      || plan.updatedAtUtcMs > current.updatedAtUtcMs
      || (plan.updatedAtUtcMs === current.updatedAtUtcMs && plan.integrationId > current.integrationId)) {
      authoritative.set(plan.successorFeatureId, plan);
    }
  }
  return authoritative;
}

export function projectFeatureDagIntegrationEvidence(input: {
  readonly featureIds: readonly string[];
  readonly plans: readonly PersistedIntegrationPlan[];
  readonly edges: readonly FeatureDagEdgeRef[];
}): FeatureDagIntegrationEvidenceView {
  const parentsOf = new Map<string, string[]>();
  const consumersOf = new Map<string, string[]>();
  const addParent = (featureId: string, dependsOnId: string): void => {
    const parents = parentsOf.get(featureId) ?? [];
    parents.push(dependsOnId);
    parentsOf.set(featureId, parents);
    const consumers = consumersOf.get(dependsOnId) ?? [];
    consumers.push(featureId);
    consumersOf.set(dependsOnId, consumers);
  };
  for (const edge of input.edges) addParent(edge.featureId, edge.dependsOnId);

  const authoritative = authoritativePlanOf(input.plans);
  const edgeEvidence = new Map<string, FeatureIntegrationEvidence | null>();
  for (const edge of input.edges) {
    edgeEvidence.set(featureDagEdgeEvidenceKey(edge.featureId, edge.dependsOnId), null);
  }
  for (const [successorId, parents] of parentsOf) {
    const plan = authoritative.get(successorId);
    if (plan === undefined) continue;
    const planPredecessors = new Set(plan.predecessors.map((predecessor) => predecessor.featureId));
    const drifted = planPredecessors.size !== parents.length
      || parents.some((parentId) => !planPredecessors.has(parentId));
    const status: FeatureIntegrationEvidenceStatus = drifted ? 'drift' : PLAN_STATUS_TO_EVIDENCE[plan.status];
    for (const predecessorId of parents) {
      const snapshot = plan.predecessors.find((predecessor) => predecessor.featureId === predecessorId);
      edgeEvidence.set(featureDagEdgeEvidenceKey(successorId, predecessorId), {
        integrationId: plan.integrationId,
        targetBaseline: plan.targetBaseline,
        planRevision: plan.revision,
        status,
        ...(snapshot?.delivery === null || snapshot?.delivery === undefined ? {} : {
          commitSha: snapshot.delivery.commitSha,
          evidenceDigest: snapshot.delivery.evidenceDigest,
        }),
        ...(status === 'stale' ? { staleReasons: [...plan.staleReasons] } : {}),
        ...(status === 'drift' ? { staleReasons: [DRIFT_STALE_REASON] } : {}),
        ...(status === 'blocked' ? { blockReasons: [...plan.blockReasons] } : {}),
      });
    }
  }

  const nodeEvidence = new Map<string, FeatureIntegrationEvidence | null>();
  for (const featureId of input.featureIds) {
    const consumers = consumersOf.get(featureId) ?? [];
    const evidences = consumers.map((consumerId) =>
      edgeEvidence.get(featureDagEdgeEvidenceKey(consumerId, featureId)) ?? null);
    const allPassed = consumers.length > 0
      && evidences.every((evidence) => evidence !== null && (evidence.status ?? 'passed') === 'passed');
    if (!allPassed) {
      nodeEvidence.set(featureId, null);
      continue;
    }
    const commitShas = new Set(evidences.map((evidence) => evidence?.commitSha));
    const evidenceDigests = new Set(evidences.map((evidence) => evidence?.evidenceDigest));
    if (commitShas.size !== 1 || evidenceDigests.size !== 1) {
      throw corrupt(
        'FeatureDagIntegrationProjection.project',
        'conflicting_delivery_evidence',
        { featureId, commitShas: [...commitShas], evidenceDigests: [...evidenceDigests] },
      );
    }
    const single = consumers.length === 1 ? evidences[0]! : undefined;
    nodeEvidence.set(featureId, {
      commitSha: [...commitShas][0],
      evidenceDigest: [...evidenceDigests][0],
      status: 'passed',
      ...(single === undefined ? {} : {
        integrationId: single.integrationId,
        targetBaseline: single.targetBaseline,
        planRevision: single.planRevision,
      }),
    });
  }
  return { nodeEvidence, edgeEvidence };
}

/**
 * 在调用方已打开的一致读事务内读取同 Phase 的权威计划并投影 DAG 集成证据。
 * 跨项目/跨 Phase/指向未知 Feature 的计划事实在此 fail-closed，不静默丢弃。
 */
export function readFeatureDagIntegrationEvidenceInView(
  db: Database.Database,
  input: {
    readonly projectId: string;
    readonly phaseId: string;
    readonly operation: string;
    readonly featureIds: ReadonlySet<string>;
    readonly edges: readonly FeatureDagEdgeRef[];
  },
): FeatureDagIntegrationEvidenceView {
  const plans = listIntegrationPlansByPhaseInTransaction(db, input.projectId, input.phaseId, `${input.operation}.plans`);
  for (const plan of plans) {
    if (plan.projectId !== input.projectId || plan.phaseId !== input.phaseId) {
      throw corrupt(input.operation, 'cross_scope_integration_plan', { integrationId: plan.integrationId });
    }
    if (!input.featureIds.has(plan.successorFeatureId)) {
      throw corrupt(input.operation, 'invalid_integration_plan_projection', { integrationId: plan.integrationId });
    }
    for (const predecessor of plan.predecessors) {
      if (!input.featureIds.has(predecessor.featureId)) {
        throw corrupt(input.operation, 'invalid_integration_plan_projection', {
          integrationId: plan.integrationId, featureId: predecessor.featureId,
        });
      }
    }
  }
  return projectFeatureDagIntegrationEvidence({
    featureIds: [...input.featureIds],
    plans,
    edges: input.edges,
  });
}
