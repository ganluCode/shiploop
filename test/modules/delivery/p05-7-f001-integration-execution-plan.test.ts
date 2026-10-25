import { describe, expect, it } from 'vitest';
import {
  createIntegrationExecutionPlan,
  computeCoveredInputDigest,
  validateIntegrationExecutionPlanInput,
} from '../../../packages/core/src/ports/integration-execution-plan.ts';
import type { IntegrationExecutionPlanInput } from '../../../packages/core/src/ports/integration-execution-plan.ts';

const A_COMMIT = 'a'.repeat(40);
const B_COMMIT = 'b'.repeat(40);
const TARGET = 'c'.repeat(40);
const REPO_IDENTITY = 'repo:local:123';
const EVIDENCE_DIGEST = '1'.repeat(64);
const INPUT_A_DIGEST = '3'.repeat(64);
const INPUT_B_DIGEST = '4'.repeat(64);
const DELIVERY_A_INPUT_DIGEST = computeCoveredInputDigest([{ inputId: 'input-a', digest: INPUT_A_DIGEST }]);
const DELIVERY_B_INPUT_DIGEST = computeCoveredInputDigest([{ inputId: 'input-b', digest: INPUT_B_DIGEST }]);

function input(overrides: Partial<IntegrationExecutionPlanInput> = {}): IntegrationExecutionPlanInput {
  return {
    projectId: 'project-1',
    phaseId: 'phase-1',
    batchId: 'batch-1',
    runId: 'run-1',
    successorFeatureId: 'feature-c',
    target: {
      baseCommit: TARGET,
      repoIdentity: REPO_IDENTITY,
      canonicalPath: '/tmp/shiploop/repository',
      gitCommonDir: '/tmp/shiploop/repository/.git',
    },
    predecessors: [
      {
        projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', runId: 'run-1', featureId: 'feature-a',
        dependencyPassed: true,
        delivery: {
          commitSha: A_COMMIT, repoIdentity: REPO_IDENTITY, inputDigest: DELIVERY_A_INPUT_DIGEST,
          evidenceId: 'delivery-a', evidenceDigest: EVIDENCE_DIGEST,
        },
        coveredInputIds: ['input-a'],
      },
      {
        projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', runId: 'run-1', featureId: 'feature-b',
        dependencyPassed: true,
        delivery: {
          commitSha: B_COMMIT, repoIdentity: REPO_IDENTITY, inputDigest: DELIVERY_B_INPUT_DIGEST,
          evidenceId: 'delivery-b', evidenceDigest: '2'.repeat(64),
        },
        coveredInputIds: ['input-b'],
      },
    ],
    approvedInputs: [
      { inputId: 'input-a', digest: INPUT_A_DIGEST },
      { inputId: 'input-b', digest: INPUT_B_DIGEST },
    ],
    mergeOrder: ['feature-a', 'feature-b'],
    verificationScope: ['test/modules/delivery/combined.test.ts', 'typecheck'],
    integrationResult: null,
    ...overrides,
  };
}

describe('P05-7 F-001 integration execution plan contract', () => {
  it('[case:execution-plan-freezes-identities] freezes ownership, target, predecessor commits and stable input digest', () => {
    const first = createIntegrationExecutionPlan(input());
    const reorderedRawPredecessors = createIntegrationExecutionPlan({
      ...input(),
      predecessors: [...input().predecessors].reverse(),
    });
    expect(first.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(reorderedRawPredecessors.inputDigest).toBe(first.inputDigest);
    expect(createIntegrationExecutionPlan({
      ...input(), mergeOrder: ['feature-b', 'feature-a'],
    }).inputDigest).not.toBe(first.inputDigest);
    expect(createIntegrationExecutionPlan({
      ...input(), predecessors: input().predecessors.map((item, index) => index === 0
        ? { ...item, delivery: { ...item.delivery!, commitSha: 'd'.repeat(40) } } : item),
    }).inputDigest).not.toBe(first.inputDigest);
    expect(first.status).toBe('dependency_passed');
    expect(first.integrationResult).toBeNull();
  });

  it('[case:execution-plan-rejects-stale-delivery] rejects cross-scope, missing and stale predecessor evidence', () => {
    const plan = createIntegrationExecutionPlan(input());
    const deliveryDigest = plan.predecessors[0]!.delivery!.inputDigest;
    const valid = createIntegrationExecutionPlan({
      ...input(),
      predecessors: input().predecessors.map((item, index) => index === 0
        ? { ...item, delivery: { ...item.delivery!, inputDigest: deliveryDigest } } : item),
    });
    expect(valid.predecessors[0]!.delivery!.inputDigest).toBe(deliveryDigest);
    expect(() => createIntegrationExecutionPlan({
      ...input(),
      predecessors: input().predecessors.map((item, index) => index === 0
        ? { ...item, runId: 'run-2' } : item),
    })).toThrowError(expect.objectContaining({ kind: 'validation', details: expect.objectContaining({ reason: 'cross_run' }) }));
    expect(() => createIntegrationExecutionPlan({
      ...input(),
      predecessors: input().predecessors.map((item, index) => index === 0
        ? { ...item, delivery: null } : item),
    })).toThrowError(expect.objectContaining({ kind: 'validation', details: expect.objectContaining({ reason: 'missing_delivery_evidence' }) }));
    expect(() => createIntegrationExecutionPlan({
      ...input(),
      predecessors: input().predecessors.map((item, index) => index === 0
        ? { ...item, delivery: { ...item.delivery!, inputDigest: 'f'.repeat(64) } } : item),
    })).toThrowError(expect.objectContaining({ kind: 'validation', details: expect.objectContaining({ reason: 'input_digest_mismatch' }) }));
  });

  it('[case:execution-plan-separates-integration-result] only complete matching result can pass integration', () => {
    const base = createIntegrationExecutionPlan(input());
    const result = createIntegrationExecutionPlan({
      ...input(),
      predecessors: base.predecessors,
      integrationResult: {
        commitSha: 'e'.repeat(40), treeSha: 'f'.repeat(40), inputDigest: base.inputDigest,
        verificationEvidence: { evidenceId: 'combined-check', evidenceDigest: '5'.repeat(64) },
      },
    });
    expect(result.status).toBe('integration_passed');
    expect(result.target.baseCommit).toBe(TARGET);
    expect(result.predecessors.map(item => item.delivery!.commitSha)).toEqual([A_COMMIT, B_COMMIT]);
    expect(() => createIntegrationExecutionPlan({
      ...input(), integrationResult: {
        commitSha: 'e'.repeat(40), treeSha: null, inputDigest: base.inputDigest,
        verificationEvidence: null,
      },
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
  });

  it('[case:execution-plan-rejects-boundary-inputs] rejects empty, duplicate, invalid SHA, path and unknown fields', () => {
    expect(() => validateIntegrationExecutionPlanInput({ ...input(), predecessors: [] }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateIntegrationExecutionPlanInput({
      ...input(), target: { ...input().target, baseCommit: 'main' },
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateIntegrationExecutionPlanInput({
      ...input(), target: { ...input().target, canonicalPath: '/tmp/../repo' },
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateIntegrationExecutionPlanInput({
      ...input(), approvedInputs: [input().approvedInputs[0], input().approvedInputs[0]],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateIntegrationExecutionPlanInput({ ...input(), branch: 'feature/c' }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
  });
});
