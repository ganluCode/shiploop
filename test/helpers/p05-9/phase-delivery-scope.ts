import { computePhaseDeliveryDagDigest } from '../../../packages/core/src/application/phase-delivery-approval.ts';
import type { PhaseDeliveryScopeDependency, PhaseDeliveryScopeSnapshot } from '../../../packages/core/src/application/phase-delivery-approval.ts';
import type { BatchFinalizationInputRef, BatchFinalizationLeafEvidence } from '../../../packages/core/src/application/batch-leaf-finalization.ts';

/**
 * P05-9 / P08 DAG F-012 测试共享的冻结 Phase 范围夹具。
 * 构造与候选冻结事实一致的 PhaseDeliveryScopeSnapshot；
 * dagDigest 始终由 featureIds/dependencies 实际计算，不手写。
 */
export interface PhaseDeliveryScopeFixtureOptions {
  readonly projectId: string;
  readonly phaseId: string;
  readonly phaseRevision: number;
  readonly featureIds: readonly string[];
  readonly dependencies?: readonly PhaseDeliveryScopeDependency[];
  readonly batches: readonly { batchId: string; revision: number; featureIds: readonly string[]; status?: 'succeeded' | 'failed' | 'running'; approved?: boolean }[];
  readonly approvedInputs: readonly BatchFinalizationInputRef[];
  readonly targetBaseline: string;
  readonly strategySummary?: Readonly<Record<string, unknown>>;
  readonly leaves: readonly BatchFinalizationLeafEvidence[];
}

export function buildPhaseDeliveryScope(options: PhaseDeliveryScopeFixtureOptions): PhaseDeliveryScopeSnapshot {
  const dependencies = (options.dependencies ?? []).map(edge => ({ featureId: edge.featureId, dependsOnId: edge.dependsOnId }));
  return {
    phase: { projectId: options.projectId, phaseId: options.phaseId, revision: options.phaseRevision, status: 'open' },
    dagDigest: computePhaseDeliveryDagDigest(options.featureIds, dependencies),
    featureIds: [...options.featureIds],
    dependencies,
    batches: options.batches.map(batch => ({
      batchId: batch.batchId, revision: batch.revision, status: batch.status ?? 'succeeded',
      approved: batch.approved ?? true, featureIds: [...batch.featureIds],
    })),
    approvedInputs: options.approvedInputs.map(input => ({ inputId: input.inputId, digest: input.digest })),
    targetBaseline: options.targetBaseline,
    strategySummary: structuredClone(options.strategySummary ?? { mode: 'deterministic' }),
    leaves: options.leaves.map(leaf => ({ ...leaf, coveredInputs: leaf.coveredInputs.map(input => ({ ...input })) })),
  };
}

/** 构造与候选冻结叶子一致的 Phase 叶子证据：commit 存在、证据新鲜、分支无漂移。 */
export function phaseScopeLeaf(featureId: string, facts: {
  readonly commitSha: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly coveredInputs: readonly BatchFinalizationInputRef[];
  readonly repoIdentity?: string;
  readonly revision?: number;
}): BatchFinalizationLeafEvidence {
  return {
    featureId, featureStatus: 'completed', deliveryStatus: 'succeeded', revision: facts.revision ?? 2,
    commitSha: facts.commitSha, repoIdentity: facts.repoIdentity ?? 'repo-1',
    coveredInputs: facts.coveredInputs.map(input => ({ inputId: input.inputId, digest: input.digest })),
    evidenceId: facts.evidenceId, evidenceDigest: facts.evidenceDigest,
    evidenceFresh: true, commitExists: true, branchHead: facts.commitSha,
  };
}
