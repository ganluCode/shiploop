import { describe, expect, it } from 'vitest';
import {
  createIntegrationPlan,
  deriveIntegrationPlanStatus,
  validateIntegrationPlanInput,
} from '../../../packages/core/src/ports/integration-plan.ts';
import type { IntegrationPlanInput } from '../../../packages/core/src/ports/integration-plan.ts';

const A_COMMIT = 'a'.repeat(40);
const B_COMMIT = 'b'.repeat(40);
const BASELINE = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const EVIDENCE_DIGEST = '1'.repeat(64);

function input(overrides: Partial<IntegrationPlanInput> = {}): IntegrationPlanInput {
  return {
    projectId: 'project-1',
    phaseId: 'phase-1',
    batchId: 'batch-1',
    successorFeatureId: 'feature-c',
    targetBaseline: BASELINE,
    predecessors: [
      {
        projectId: 'project-1',
        phaseId: 'phase-1',
        featureId: 'feature-a',
        dependencyPassed: true,
        delivery: { commitSha: A_COMMIT, evidenceId: 'delivery-a', evidenceDigest: EVIDENCE_DIGEST },
        coveredInputIds: ['input-a'],
        ancestorVerified: true,
      },
      {
        projectId: 'project-1',
        phaseId: 'phase-1',
        featureId: 'feature-b',
        dependencyPassed: true,
        delivery: { commitSha: B_COMMIT, evidenceId: 'delivery-b', evidenceDigest: '2'.repeat(64) },
        coveredInputIds: ['input-b'],
        ancestorVerified: true,
      },
    ],
    approvedInputs: [
      { inputId: 'input-a', digest: '3'.repeat(64) },
      { inputId: 'input-b', digest: '4'.repeat(64) },
    ],
    mergeOrder: ['feature-a', 'feature-b'],
    verificationScope: ['integration-tests', 'typecheck'],
    strategySummary: { conflictPolicy: 'deterministic-only', maxAttempts: 1 },
    integrationResult: null,
    ...overrides,
  };
}

describe('P05-6 F-001 integration plan contract', () => {
  it('[case:integration-identity-stable] 规范化计划生成稳定身份与整体输入摘要', () => {
    const first = createIntegrationPlan(input());
    const reversed = createIntegrationPlan({
      ...input(),
      predecessors: [...input().predecessors].reverse(),
      approvedInputs: [...input().approvedInputs].reverse(),
      verificationScope: ['typecheck', 'integration-tests'],
    });

    expect(first.integrationId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(reversed.integrationId).toBe(first.integrationId);
    expect(reversed.inputDigest).toBe(first.inputDigest);
    expect(createIntegrationPlan({ ...input(), targetBaseline: 'e'.repeat(40) }).integrationId)
      .not.toBe(first.integrationId);
    expect(createIntegrationPlan({ ...input(), strategySummary: { conflictPolicy: 'agent', maxAttempts: 1 } }).integrationId)
      .not.toBe(first.integrationId);
    expect(createIntegrationPlan({
      ...input(),
      approvedInputs: [{ inputId: 'input-a', digest: '3'.repeat(64) }, { inputId: 'input-b', digest: '5'.repeat(64) }],
    }).integrationId).not.toBe(first.integrationId);
  });

  it('[case:integration-coverage-and-status] 多前置必须完整覆盖，LLM 无冲突文字不能伪造集成通过', () => {
    const dependencyPassed = createIntegrationPlan(input());
    expect(dependencyPassed.status).toBe('dependency_passed');
    expect(dependencyPassed.coverage.complete).toBe(true);

    const incomplete = createIntegrationPlan({
      ...input(),
      predecessors: input().predecessors.map((item, index) => index === 1
        ? { ...item, coveredInputIds: [] }
        : item),
    });
    expect(incomplete.status).toBe('blocked');
    expect(incomplete.blockReasons).toContain('input_coverage_incomplete');

    const missingDelivery = createIntegrationPlan({
      ...input(),
      predecessors: input().predecessors.map((item, index) => index === 0
        ? { ...item, delivery: null }
        : item),
    });
    expect(missingDelivery.status).toBe('blocked');
    expect(missingDelivery.blockReasons).toContain('missing_delivery_evidence');

    const withTextOnly = createIntegrationPlan({
      ...input(),
      integrationResult: { commitSha: null, treeSha: null, verificationEvidence: null, llmNoConflictText: 'no conflicts' },
    });
    expect(withTextOnly.status).toBe('dependency_passed');

    const partialEvidence = createIntegrationPlan({
      ...input(),
      integrationResult: {
        commitSha: null,
        treeSha: null,
        verificationEvidence: { evidenceId: 'integration-check', evidenceDigest: '5'.repeat(64) },
        llmNoConflictText: null,
      },
    });
    expect(partialEvidence.status).toBe('blocked');
    expect(partialEvidence.blockReasons).toContain('integration_evidence_incomplete');

    const passed = createIntegrationPlan({
      ...input(),
      integrationResult: {
        commitSha: 'f'.repeat(40),
        treeSha: TREE,
        verificationEvidence: { evidenceId: 'integration-check', evidenceDigest: '5'.repeat(64) },
        llmNoConflictText: 'no conflicts',
      },
    });
    expect(passed.status).toBe('integration_passed');
  });

  it('[case:integration-validation-errors] 拒绝跨项目、空成果、非法顺序和重复前置身份', () => {
    expect(() => validateIntegrationPlanInput({
      ...input(),
      predecessors: input().predecessors.map((item, index) => index === 0
        ? { ...item, projectId: 'project-2' }
        : item),
    })).toThrowError(expect.objectContaining({ kind: 'validation', details: expect.objectContaining({ reason: 'cross_project' }) }));
    expect(() => validateIntegrationPlanInput({
      ...input(),
      predecessors: input().predecessors.map((item, index) => index === 0
        ? { ...item, delivery: { ...item.delivery!, commitSha: '' } }
        : item),
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateIntegrationPlanInput({ ...input(), mergeOrder: ['feature-b', 'feature-b'] }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateIntegrationPlanInput({
      ...input(),
      predecessors: [input().predecessors[0], { ...input().predecessors[0] }],
      mergeOrder: ['feature-a', 'feature-a'],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
  });

  it('[case:integration-stale-and-single-reuse] 单前置复用要求祖先核对，漂移使冻结证据失效', () => {
    const single = createIntegrationPlan({
      ...input(),
      predecessors: [input().predecessors[0]],
      approvedInputs: [{ inputId: 'input-a', digest: '3'.repeat(64) }],
      mergeOrder: ['feature-a'],
    });
    expect(single.mode).toBe('reuse_single_predecessor');
    expect(single.status).toBe('dependency_passed');
    expect(deriveIntegrationPlanStatus(single, { targetBaseline: 'e'.repeat(40) }).status).toBe('stale');
    expect(deriveIntegrationPlanStatus(single, { targetBaseline: BASELINE }).status).toBe('dependency_passed');
    expect(deriveIntegrationPlanStatus(single, {
      ...input(),
      predecessors: [input().predecessors[0]],
      approvedInputs: [{ inputId: 'input-a', digest: '9'.repeat(64) }],
      mergeOrder: ['feature-a'],
    }).status).toBe('stale');
    expect(() => validateIntegrationPlanInput({
      ...input(),
      predecessors: [{ ...input().predecessors[0], ancestorVerified: false }],
      approvedInputs: [{ inputId: 'input-a', digest: '3'.repeat(64) }],
      mergeOrder: ['feature-a'],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
  });
});
