import { describe, expect, it } from 'vitest';
import {
  computePhaseDeliveryDagDigest,
  createPhaseDeliveryApprovalService,
  enumeratePhaseDeliveryLeaves,
  type PhaseDeliveryApprovalCandidateSnapshot,
  type PhaseDeliveryApprovalRecord,
  type PhaseDeliveryApprovalSnapshot,
  type PhaseDeliveryApprovalStore,
  type PhaseDeliveryScopeSnapshot,
} from '../../../packages/core/src/application/phase-delivery-approval.ts';
import type { BatchFinalizationLeafEvidence } from '../../../packages/core/src/application/batch-leaf-finalization.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

/**
 * F-012 冻结 Phase 范围夹具：
 * Phase DAG：feature-a → feature-c，feature-b 独立并行；
 * Phase 叶子 = { feature-b, feature-c }（无 Phase 内后继）。
 * feature-b 在 batch-1 交付，feature-c 在最终 batch-2 交付，
 * 候选叶子覆盖两个 Batch 的全部获准叶子。
 */
function scope(overrides: Partial<PhaseDeliveryScopeSnapshot> = {}): PhaseDeliveryScopeSnapshot {
  const featureIds = ['feature-a', 'feature-b', 'feature-c'];
  const dependencies = [{ featureId: 'feature-c', dependsOnId: 'feature-a' }];
  return {
    phase: { projectId: 'project-1', phaseId: 'phase-1', revision: 7, status: 'open' },
    dagDigest: computePhaseDeliveryDagDigest(featureIds, dependencies),
    featureIds,
    dependencies,
    batches: [
      { batchId: 'batch-1', revision: 2, status: 'succeeded', approved: true, featureIds: ['feature-a', 'feature-b'] },
      { batchId: 'batch-2', revision: 4, status: 'succeeded', approved: true, featureIds: ['feature-a', 'feature-c'] },
    ],
    approvedInputs: [{ inputId: 'input-1', digest: DIGEST('a') }],
    targetBaseline: SHA('b'),
    strategySummary: { mode: 'deterministic' },
    leaves: [leafEvidence('feature-b'), leafEvidence('feature-c')],
    ...overrides,
  };
}

function leafEvidence(featureId: string, overrides: Partial<BatchFinalizationLeafEvidence> = {}): BatchFinalizationLeafEvidence {
  const letter = featureId.endsWith('b') ? 'c' : 'd';
  return {
    featureId, featureStatus: 'completed', deliveryStatus: 'succeeded', revision: 2, commitSha: SHA(letter),
    repoIdentity: 'repo-1', coveredInputs: [{ inputId: 'input-1', digest: DIGEST('a') }],
    evidenceId: `evidence-${featureId}`, evidenceDigest: DIGEST(letter === 'c' ? 'e' : 'f'),
    evidenceFresh: true, commitExists: true, branchHead: SHA(letter),
    ...overrides,
  };
}

function candidate(overrides: Partial<PhaseDeliveryApprovalCandidateSnapshot> = {}): PhaseDeliveryApprovalCandidateSnapshot {
  return {
    schemaVersion: 1,
    revision: 3,
    candidateId: 'candidate-1',
    commandId: 'delivery-command-1',
    projectId: 'project-1',
    phaseId: 'phase-1',
    batchId: 'batch-2',
    batchRevision: 4,
    scopeDigest: DIGEST('s'),
    inputDigest: DIGEST('i'),
    targetBaseline: SHA('b'),
    approvedInputs: [{ inputId: 'input-1', digest: DIGEST('a') }],
    leafFeatureIds: ['feature-b', 'feature-c'],
    mergeOrder: ['feature-b', 'feature-c'],
    leaves: [
      { featureId: 'feature-b', revision: 2, commitSha: SHA('c'), repoIdentity: 'repo-1', coveredInputs: [{ inputId: 'input-1', digest: DIGEST('a') }], evidenceId: 'evidence-feature-b', evidenceDigest: DIGEST('e') },
      { featureId: 'feature-c', revision: 2, commitSha: SHA('d'), repoIdentity: 'repo-1', coveredInputs: [{ inputId: 'input-1', digest: DIGEST('a') }], evidenceId: 'evidence-feature-c', evidenceDigest: DIGEST('f') },
    ],
    verificationScope: ['combined-tests'],
    strategySummary: { mode: 'deterministic' },
    status: 'ready_for_phase_approval',
    integration: { status: 'succeeded', commitSha: SHA('g'), treeSha: SHA('t'), evidenceId: 'integration-evidence', evidenceDigest: DIGEST('g'), workspacePreserved: true },
    verification: { status: 'passed', evidenceId: 'verification-evidence', evidenceDigest: DIGEST('h') },
    workspacePreserved: true,
    ...overrides,
  };
}

function snapshot(candidateValue = candidate(), scopeValue = scope()): PhaseDeliveryApprovalSnapshot {
  return {
    candidate: candidateValue,
    batch: {
      projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-2', revision: 4,
      status: 'succeeded' as const, approved: true,
      scopeDigest: DIGEST('s'), inputDigest: DIGEST('i'),
      budgetSummary: { budgetRevision: 2, maxAttempts: 4, attemptsUsed: 2, deadlineAt: 1_900_000_000_000 },
      stopSummary: { status: 'confirmed' as const, digest: DIGEST('q') },
      codeSummary: { targetBaseline: SHA('b'), integrationCommit: SHA('g'), treeSha: SHA('t') },
      planSummary: { planDigest: DIGEST('p'), featureIds: ['feature-b', 'feature-c'] },
      manualBlock: false,
    },
    phaseScope: scopeValue,
  };
}

function store() {
  let record: PhaseDeliveryApprovalRecord | null = null;
  const calls = { create: 0, invalidate: 0 };
  const value: PhaseDeliveryApprovalStore = {
    read: () => record,
    create: input => { calls.create += 1; record = input; return input; },
    invalidate: (approval, reason) => { calls.invalidate += 1; record = { ...approval, status: 'invalidated', invalidationReason: reason }; return record; },
  };
  return { value, calls, get record() { return record; } };
}

const REQUEST = {
  projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-2', candidateId: 'candidate-1',
  commandId: 'approve-command-1', actorId: 'owner-1', expectedBatchRevision: 4, expectedCandidateRevision: 3,
} as const;

describe('P08 DAG F-012 Phase 叶子集成汇总', () => {
  it('[case:phase-leaf-enumeration-is-dag-derived] Phase 叶子枚举与 DAG 摘要由冻结依赖结构决定', () => {
    const featureIds = ['feature-c', 'feature-a', 'feature-b', 'feature-d'];
    const dependencies = [
      { featureId: 'feature-c', dependsOnId: 'feature-a' },
      { featureId: 'feature-d', dependsOnId: 'feature-c' },
    ];
    expect(enumeratePhaseDeliveryLeaves(featureIds, dependencies)).toEqual(['feature-b', 'feature-d']);
    expect(computePhaseDeliveryDagDigest(featureIds, dependencies))
      .toBe(computePhaseDeliveryDagDigest([...featureIds].reverse(), [...dependencies].reverse()));
    expect(computePhaseDeliveryDagDigest(featureIds, dependencies))
      .not.toBe(computePhaseDeliveryDagDigest(featureIds, [...dependencies, { featureId: 'feature-d', dependsOnId: 'feature-b' }]));
    expect(enumeratePhaseDeliveryLeaves(['feature-x'], [])).toEqual(['feature-x']);
  });

  it('[case:phase-leaf-aggregation-approves-full-leaf-set] 全部获准叶子覆盖时批准并绑定 Phase revision 与 DAG 摘要', async () => {
    const persistence = store();
    const service = createPhaseDeliveryApprovalService({ snapshots: { read: () => snapshot() }, approvals: persistence.value });
    const result = await service.approve({ ...REQUEST, expectedPhaseRevision: 7, expectedDagDigest: scope().dagDigest });
    expect(result.status).toBe('approved');
    expect(result.approval).toMatchObject({
      phaseRevision: 7, dagDigest: scope().dagDigest,
      leafCommitShas: [SHA('c'), SHA('d')],
      integrationCommitSha: SHA('g'), integrationTreeSha: SHA('t'),
      status: 'approved',
    });
    expect(persistence.calls.create).toBe(1);
  });

  it('[case:phase-leaf-aggregation-rejects-missing-leaf] Phase 新增已交付叶子而候选未覆盖时拒绝', async () => {
    const persistence = store();
    const driftScope = scope({
      featureIds: ['feature-a', 'feature-b', 'feature-c', 'feature-e'],
      batches: [...scope().batches, { batchId: 'batch-3', revision: 1, status: 'succeeded', approved: true, featureIds: ['feature-e'] }],
      leaves: [...scope().leaves, leafEvidence('feature-e', { commitSha: SHA('e'), evidenceId: 'evidence-feature-e', evidenceDigest: DIGEST('e'), branchHead: SHA('e') })],
    });
    const service = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot(candidate(), { ...driftScope, dagDigest: computePhaseDeliveryDagDigest(driftScope.featureIds, driftScope.dependencies) }) },
      approvals: persistence.value,
    });
    const result = await service.approve(REQUEST);
    expect(result).toMatchObject({ status: 'rejected', reason: 'phase_leaf_missing' });
    expect(persistence.calls.create).toBe(0);
  });

  it('[case:phase-leaf-aggregation-rejects-foreign-leaf] 候选携带非 Phase 叶子时拒绝', async () => {
    const persistence = store();
    const foreign = candidate({
      leafFeatureIds: ['feature-b', 'feature-c', 'feature-x'],
      mergeOrder: ['feature-b', 'feature-c', 'feature-x'],
      leaves: [...candidate().leaves, { featureId: 'feature-x', revision: 1, commitSha: SHA('x'), repoIdentity: 'repo-1', coveredInputs: [], evidenceId: 'evidence-x', evidenceDigest: DIGEST('x') }],
    });
    const service = createPhaseDeliveryApprovalService({ snapshots: { read: () => snapshot(foreign) }, approvals: persistence.value });
    const result = await service.approve(REQUEST);
    expect(result).toMatchObject({ status: 'rejected', reason: 'phase_leaf_foreign' });
  });

  it('[case:phase-leaf-aggregation-rejects-unapproved-batch-leaf] 叶子交付所在 Batch 未获准或不成功时拒绝', async () => {
    for (const override of [{ approved: false }, { status: 'running' as const }] as const) {
      const persistence = store();
      const batches = scope().batches.map(batch => batch.batchId === 'batch-1' ? { ...batch, ...override } : batch);
      const service = createPhaseDeliveryApprovalService({
        snapshots: { read: () => snapshot(candidate(), { ...scope(), batches }) },
        approvals: persistence.value,
      });
      const result = await service.approve(REQUEST);
      expect(result).toMatchObject({ status: 'rejected', reason: 'phase_leaf_outside_approved_batch' });
      expect(persistence.calls.create).toBe(0);
    }
  });

  it('[case:phase-leaf-aggregation-rejects-stale-leaf-evidence] 叶子证据过期、分支漂移或交付未完成时拒绝', async () => {
    const cases: readonly [string, Partial<BatchFinalizationLeafEvidence>][] = [
      ['stale-evidence', { evidenceFresh: false }],
      ['branch-drift', { branchHead: SHA('z') }],
      ['delivery-pending', { deliveryStatus: 'pending', commitSha: null, evidenceId: null, evidenceDigest: null }],
      ['feature-not-completed', { featureStatus: 'partial' }],
      ['unresolved-conflict', { conflictReason: 'merge_conflict' }],
    ];
    for (const [, override] of cases) {
      const persistence = store();
      const leaves = scope().leaves.map(leaf => leaf.featureId === 'feature-b' ? { ...leaf, ...override } : leaf);
      const service = createPhaseDeliveryApprovalService({
        snapshots: { read: () => snapshot(candidate(), { ...scope(), leaves }) },
        approvals: persistence.value,
      });
      const result = await service.approve(REQUEST);
      expect(result).toMatchObject({ status: 'rejected', reason: 'phase_leaf_not_delivered' });
      expect(persistence.calls.create).toBe(0);
    }
  });

  it('[case:phase-leaf-aggregation-rejects-frozen-leaf-drift] 候选冻结叶子与当前 Phase 证据不一致时拒绝', async () => {
    const persistence = store();
    const leaves = scope().leaves.map(leaf => leaf.featureId === 'feature-b' ? { ...leaf, commitSha: SHA('y'), branchHead: SHA('y') } : leaf);
    const service = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot(candidate(), { ...scope(), leaves }) },
      approvals: persistence.value,
    });
    const result = await service.approve(REQUEST);
    expect(result).toMatchObject({ status: 'rejected', reason: 'phase_leaf_not_delivered' });
  });

  it('[case:phase-leaf-aggregation-rejects-baseline-and-policy-drift] 目标 baseline 或策略漂移时拒绝', async () => {
    const baselinePersistence = store();
    const baselineService = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot(candidate(), { ...scope(), targetBaseline: SHA('z') }) },
      approvals: baselinePersistence.value,
    });
    expect(await baselineService.approve(REQUEST)).toMatchObject({ status: 'rejected', reason: 'target_baseline_drift' });

    const policyPersistence = store();
    const policyService = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot(candidate(), { ...scope(), strategySummary: { mode: 'git-agent' } }) },
      approvals: policyPersistence.value,
    });
    expect(await policyService.approve(REQUEST)).toMatchObject({ status: 'rejected', reason: 'policy_drift' });
    expect(policyPersistence.calls.create).toBe(0);
  });

  it('[case:phase-leaf-aggregation-rejects-input-coverage-gap] Phase 获准输入未被候选叶子完整覆盖时拒绝', async () => {
    for (const makeSnapshot of [
      () => snapshot(candidate(), { ...scope(), approvedInputs: [...scope().approvedInputs, { inputId: 'input-2', digest: DIGEST('b') }] }),
      () => snapshot(candidate({
        leaves: candidate().leaves.map(leaf => leaf.featureId === 'feature-b' ? { ...leaf, coveredInputs: [{ inputId: 'input-1', digest: DIGEST('z') }] } : leaf),
      })),
    ]) {
      const persistence = store();
      const service = createPhaseDeliveryApprovalService({ snapshots: { read: makeSnapshot }, approvals: persistence.value });
      expect(await service.approve(REQUEST)).toMatchObject({ status: 'rejected', reason: 'phase_input_coverage_incomplete' });
      expect(persistence.calls.create).toBe(0);
    }
  });

  it('[case:phase-leaf-aggregation-frozen-revision-cas] 冻结 Phase/DAG revision 期望不匹配或范围损坏时拒绝', async () => {
    const stale = store();
    const staleService = createPhaseDeliveryApprovalService({ snapshots: { read: () => snapshot() }, approvals: stale.value });
    expect(await staleService.approve({ ...REQUEST, expectedPhaseRevision: 6 })).toMatchObject({ status: 'rejected', reason: 'phase_revision_stale' });
    expect(await staleService.approve({ ...REQUEST, expectedDagDigest: DIGEST('a') })).toMatchObject({ status: 'rejected', reason: 'dag_revision_stale' });
    await expect(staleService.approve({ ...REQUEST, expectedDagDigest: 'not-hex' })).rejects.toThrow(/expectedDagDigest/);

    const corrupted = store();
    const corruptedService = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot(candidate(), { ...scope(), dagDigest: DIGEST('z') }) },
      approvals: corrupted.value,
    });
    expect(await corruptedService.approve(REQUEST)).toMatchObject({ status: 'rejected', reason: 'phase_scope_invalid' });

    const missing = store();
    const missingService = createPhaseDeliveryApprovalService({
      snapshots: { read: () => ({ ...snapshot(), phaseScope: undefined }) as unknown as PhaseDeliveryApprovalSnapshot },
      approvals: missing.value,
    });
    expect(await missingService.approve(REQUEST)).toMatchObject({ status: 'rejected', reason: 'phase_scope_missing' });

    const archived = store();
    const archivedScope = scope({ phase: { projectId: 'project-1', phaseId: 'phase-1', revision: 7, status: 'archived' } });
    const archivedService = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot(candidate(), archivedScope) }, approvals: archived.value,
    });
    expect(await archivedService.approve(REQUEST)).toMatchObject({ status: 'rejected', reason: 'phase_archived' });
    expect(stale.calls.create + corrupted.calls.create + missing.calls.create + archived.calls.create).toBe(0);
  });

  it('[case:phase-leaf-aggregation-invalidates-approval-on-drift] 批准后 Phase 事实漂移使既有批准失效', async () => {
    let current = snapshot();
    const persistence = store();
    const service = createPhaseDeliveryApprovalService({ snapshots: { read: () => current }, approvals: persistence.value });
    const approved = await service.approve({ ...REQUEST, expectedPhaseRevision: 7 });
    expect(approved.status).toBe('approved');

    const driftedScope = scope({ phase: { projectId: 'project-1', phaseId: 'phase-1', revision: 8, status: 'open' } });
    current = snapshot(candidate(), driftedScope);
    const drifted = await service.approve({ ...REQUEST, commandId: 'approve-command-2', expectedPhaseRevision: 7 });
    expect(drifted).toMatchObject({ status: 'rejected', reason: 'phase_revision_stale' });
    expect(persistence.calls.invalidate).toBe(1);
    expect(persistence.record).toMatchObject({ status: 'invalidated', invalidationReason: 'phase_revision_stale' });

    const staleLeaf = scope({ leaves: scope().leaves.map(leaf => leaf.featureId === 'feature-c' ? { ...leaf, evidenceFresh: false } : leaf) });
    const reapproved = store();
    let world = snapshot();
    const second = createPhaseDeliveryApprovalService({ snapshots: { read: () => world }, approvals: reapproved.value });
    await second.approve(REQUEST);
    world = snapshot(candidate(), staleLeaf);
    const after = await second.approve({ ...REQUEST, commandId: 'approve-command-3' });
    expect(after).toMatchObject({ status: 'rejected', reason: 'phase_leaf_not_delivered' });
    expect(reapproved.record).toMatchObject({ status: 'invalidated', invalidationReason: 'phase_leaf_not_delivered' });
  });

  it('[case:phase-leaf-aggregation-manual-gate] Feature 完成或候选就绪本身不构成 Phase 交付', async () => {
    const persistence = store();
    const blockedScope = snapshot();
    const blockedBatch = { ...blockedScope.batch, manualBlock: true };
    const manualService = createPhaseDeliveryApprovalService({
      snapshots: { read: () => ({ ...blockedScope, batch: blockedBatch }) }, approvals: persistence.value,
    });
    expect(await manualService.approve(REQUEST)).toMatchObject({ status: 'rejected', reason: 'manual_block' });

    const unapprovedBatchStore = store();
    const unapprovedService = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot(candidate(), { ...scope(), batches: scope().batches.map(batch => ({ ...batch, approved: false })) }) },
      approvals: unapprovedBatchStore.value,
    });
    expect(await unapprovedService.approve(REQUEST)).toMatchObject({ status: 'rejected', reason: 'phase_leaf_outside_approved_batch' });

    const integrationMissingStore = store();
    const integrationMissing = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot(candidate({ integration: { status: 'unknown', commitSha: null, treeSha: null, evidenceId: null, evidenceDigest: null, workspacePreserved: true } })) },
      approvals: integrationMissingStore.value,
    });
    expect(await integrationMissing.approve(REQUEST)).toMatchObject({ status: 'rejected', reason: 'integration_not_verified' });

    expect(persistence.calls.create + unapprovedBatchStore.calls.create + integrationMissingStore.calls.create).toBe(0);
  });
});
