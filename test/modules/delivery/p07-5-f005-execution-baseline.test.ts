import { describe, expect, it } from 'vitest';
import { createIntegrationPlan } from '../../../packages/core/src/ports/integration-plan.ts';
import {
  resolveExecutionBaseline,
  type ExecutionBaselineResolutionInput,
} from '../../../packages/core/src/application/execution-baseline.ts';
import { createExecutionBaselineAuthority } from '../../../packages/core/src/application/execution-baseline-authority.ts';
import type { PersistedIntegrationPlan } from '../../../packages/core/src/ports/integration-plan-store.ts';


const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);

function request(overrides: Partial<ExecutionBaselineResolutionInput> = {}): ExecutionBaselineResolutionInput {
  return {
    projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-d',
    dependencyFeatureIds: [], currentHeadCommit: A, integrationPlans: [],
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}): PersistedIntegrationPlan {
  const created = createIntegrationPlan({
    projectId: 'project-a', phaseId: 'phase-a', batchId: 'batch-a', successorFeatureId: 'feature-d',
    targetBaseline: A,
    predecessors: [{ projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-a', dependencyPassed: true,
      delivery: { commitSha: B, evidenceId: 'delivery-a', evidenceDigest: DIGEST },
      coveredInputIds: ['input-a'], ancestorVerified: true }],
    approvedInputs: [{ inputId: 'input-a', digest: DIGEST }], mergeOrder: ['feature-a'],
    verificationScope: ['typecheck'], strategySummary: { conflictPolicy: 'deterministic-only' },
    integrationResult: null,
    ...overrides,
  });
  return { ...created, revision: 3, createdAtUtcMs: 1, updatedAtUtcMs: 3, frozenAtUtcMs: 2 };
}

describe('execution baseline authority', () => {
  it('[case:baseline-root-approved-snapshot] uses the approved execution snapshot for a root feature', () => {
    expect(resolveExecutionBaseline(request({
      approvedPlanningBaseline: { headCommit: B, repositoryBindingId: 'binding-a', repositoryBindingRevision: 2 },
    }))).toMatchObject({ baseCommit: B, source: 'planning_snapshot' });
  });

  it('[case:baseline-single-predecessor] uses the delivered predecessor SHA only with complete evidence', () => {
    const result = resolveExecutionBaseline(request({
      dependencyFeatureIds: ['feature-a'], integrationPlans: [plan()],
    }));
    expect(result).toMatchObject({ baseCommit: B, integrationId: expect.any(String), source: 'single_predecessor' });
    expect(result.treeSha).toBeNull();
  });

  it('[case:baseline-missing-predecessor] blocks a successor when the direct predecessor is absent', () => {
    expect(() => resolveExecutionBaseline(request({ dependencyFeatureIds: ['feature-a'] })))
      .toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'dependency_pending' }) }));
  });

  it('[case:baseline-multi-integration] requires the frozen combined result for multiple predecessors', () => {
    const base = plan({
      predecessors: [
        { projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-a', dependencyPassed: true,
          delivery: { commitSha: B, evidenceId: 'delivery-a', evidenceDigest: DIGEST }, coveredInputIds: ['input-a'], ancestorVerified: true },
        { projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-b', dependencyPassed: true,
          delivery: { commitSha: A, evidenceId: 'delivery-b', evidenceDigest: DIGEST }, coveredInputIds: ['input-a'], ancestorVerified: true },
      ],
      mergeOrder: ['feature-a', 'feature-b'],
      integrationResult: { commitSha: B, treeSha: TREE,
        verificationEvidence: { evidenceId: 'combined', evidenceDigest: DIGEST }, llmNoConflictText: null },
    });
    const pending = { ...base, status: 'dependency_passed' } as PersistedIntegrationPlan;
    expect(() => resolveExecutionBaseline(request({ dependencyFeatureIds: ['feature-a', 'feature-b'], integrationPlans: [pending] })))
      .toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'integration_pending' }) }));

    const passed = base as PersistedIntegrationPlan;
    expect(resolveExecutionBaseline(request({ dependencyFeatureIds: ['feature-a', 'feature-b'], integrationPlans: [passed] })))
      .toMatchObject({ baseCommit: B, treeSha: TREE, source: 'integration_result' });
  });

  it('[case:baseline-preparation-gate] workspace preparation accepts only the authority-selected fixed commit', () => {
    const authority = createExecutionBaselineAuthority();
    const fixed = plan();
    authority.assertPreparation({ projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-d',
      dependencyFeatureIds: ['feature-a'], baseCommit: B, integrationPlans: [fixed] });
    expect(() => authority.assertPreparation({ projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-d',
      dependencyFeatureIds: ['feature-a'], baseCommit: A, integrationPlans: [fixed] }))
      .toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'integration_stale' }) }));
  });
  it('[case:baseline-plan-stale] rejects a changed integration input identity', () => {
    const current = plan();
    expect(() => resolveExecutionBaseline(request({
      dependencyFeatureIds: ['feature-a'], integrationPlans: [current], expectedIntegrationId: 'integration-other',
    }))).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'integration_stale' }) }));
  });
});
