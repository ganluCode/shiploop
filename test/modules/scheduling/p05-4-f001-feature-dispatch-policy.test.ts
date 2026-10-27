import { describe, expect, it } from 'vitest';
import {
  FEATURE_DISPATCH_CONCURRENCY_DEFAULT,
  FEATURE_DISPATCH_CONCURRENCY_MAX,
  createFeatureDispatchAdmission,
  deriveFeatureDispatchBatchPolicy,
  snapshotFeatureDispatchBatch,
  evaluateFeatureDispatchCandidate,
  validateFeatureDispatchCandidateIdentity,
  validateFeatureDispatchBatchSnapshot,
  type FeatureDispatchCheckResult,
} from '../../../packages/core/src/ports/feature-dispatch.ts';

const NOW = 1_900_000_200_000;
const BUDGET = {
  maxTotalAttempts: 8,
  maxRuntimeStarts: 8,
  attemptsCreated: 0,
  runtimeStarts: 0,
  deadlineUtcMs: NOW + 60_000,
};

function batch(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    batchId: 'batch-1',
    phaseId: 'phase-1',
    status: 'queued',
    scope: { featureIds: ['feature-a', 'feature-b'] },
    authorization: { status: 'approved', digest: 'a'.repeat(64) },
    concurrency: {},
    budget: BUDGET,
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    phaseId: 'phase-1',
    batchId: 'batch-1',
    featureId: 'feature-a',
    runId: 'run-a',
    ...overrides,
  };
}

describe('P05-4 F-001 Feature dispatch policy port', () => {
  it('[case:approved-batch-concurrency-snapshot] 从批准 Batch 快照读取并发上限，缺省为 1', () => {
    expect(FEATURE_DISPATCH_CONCURRENCY_DEFAULT).toBe(1);
    expect(validateFeatureDispatchBatchSnapshot(batch()).concurrency).toEqual({
      maxConcurrentFeatures: 1,
    });
    expect(validateFeatureDispatchBatchSnapshot(batch({
      concurrency: { maxConcurrentFeatures: 4, source: 'approved_batch' },
    })).concurrency).toEqual({ maxConcurrentFeatures: 4, source: 'approved_batch' });
    const legacyBatch = snapshotFeatureDispatchBatch({
      id: 'batch-legacy',
      projectId: 'project-1',
      phaseId: 'phase-1',
      status: 'queued',
      scopeSnapshot: { featureIds: ['feature-a', 'feature-b'] },
      configSnapshot: { approval: { planDigest: 'b'.repeat(64) }, concurrency: { maxConcurrentWorks: 2 } },
      budgetSnapshot: { batch: { maxTotalAttempts: 8, maxRuntimeStarts: 8 } },
      attemptsCreated: 0,
      runtimeStarts: 0,
      deadlineAtUtcMs: NOW + 60_000,
    });
    expect(legacyBatch).toMatchObject({
      batchId: 'batch-legacy',
      concurrency: { maxConcurrentFeatures: 2 },
      authorization: { status: 'approved' },
    });
    expect(deriveFeatureDispatchBatchPolicy({
      id: 'batch-legacy',
      projectId: 'project-1',
      phaseId: 'phase-1',
      status: 'queued',
      scopeSnapshot: { featureIds: ['feature-a'] },
      configSnapshot: { approval: { planDigest: 'b'.repeat(64) } },
      budgetSnapshot: { batch: { maxTotalAttempts: 8, maxRuntimeStarts: 8 } },
      attemptsCreated: 0,
      runtimeStarts: 0,
      deadlineAtUtcMs: NOW + 60_000,
    }, NOW).maxConcurrentFeatures).toBe(1);
    expect(deriveFeatureDispatchBatchPolicy(batch({
      concurrency: { maxConcurrentWorks: 3 },
    }), NOW).maxConcurrentFeatures).toBe(3);
    expect(FEATURE_DISPATCH_CONCURRENCY_MAX).toBeGreaterThan(1);
  });

  it('[case:concurrency-and-authorization-fail-closed] 非法并发、缺失授权和超上限返回稳定原因', () => {
    expect(() => validateFeatureDispatchBatchSnapshot(batch({
      concurrency: { maxConcurrentFeatures: 0 },
    }))).toThrow();
    expect(() => validateFeatureDispatchBatchSnapshot(batch({
      concurrency: { maxConcurrentFeatures: FEATURE_DISPATCH_CONCURRENCY_MAX + 1 },
    }))).toThrow();
    expect(() => validateFeatureDispatchBatchSnapshot(batch({ authorization: null }))).toThrow();
    expect(() => validateFeatureDispatchBatchSnapshot(batch({
      authorization: { status: 'pending', digest: 'a'.repeat(64) },
    }))).toThrow();

    for (const value of [
      batch({ concurrency: { maxConcurrentFeatures: 0 } }),
      batch({ concurrency: { maxConcurrentFeatures: FEATURE_DISPATCH_CONCURRENCY_MAX + 1 } }),
      batch({ authorization: null }),
    ]) {
      try {
        validateFeatureDispatchBatchSnapshot(value);
      } catch (error) {
        expect(error).toMatchObject({ details: { reason: expect.any(String) } });
      }
    }
  });

  it('[case:identity-and-fencing-are-independent] 候选身份包含固定 Batch，claimVersion 与 executionVersion 不进入并发计数', () => {
    expect(validateFeatureDispatchCandidateIdentity({ ...candidate(), claimVersion: 7, executionVersion: 3 })).toEqual(candidate());
    expect(() => validateFeatureDispatchCandidateIdentity({ ...candidate(), projectId: 'project-2' })).not.toThrow();
    expect(() => validateFeatureDispatchCandidateIdentity({ ...candidate(), batchId: '' })).toThrow();
    expect(() => validateFeatureDispatchBatchSnapshot(batch({
      scope: { featureIds: ['feature-a'] },
    }))).not.toThrow();
  });

  it('[case:candidate-readiness-all-gates] 依赖、授权、预算/deadline、代码前置必须全部由受信端口确认', () => {
    const policy = deriveFeatureDispatchBatchPolicy(batch(), NOW);
    const identity = validateFeatureDispatchCandidateIdentity(candidate());
    const ready = evaluateFeatureDispatchCandidate({
      policy,
      identity,
      dependency: { ready: true, reason: null },
      authorization: { valid: true, reason: null },
      budget: { allowed: true, reason: null },
      code: { ready: true, reason: null },
    });
    expect(ready).toMatchObject({ eligible: true, reason: null, attemptMayBeCreated: true });

    for (const gate of ['dependency', 'authorization', 'budget', 'code'] as const) {
      const checks: {
        dependency: FeatureDispatchCheckResult;
        authorization: FeatureDispatchCheckResult;
        budget: FeatureDispatchCheckResult;
        code: FeatureDispatchCheckResult;
      } = {
        dependency: { ready: true, reason: null },
        authorization: { valid: true, reason: null },
        budget: { allowed: true, reason: null },
        code: { ready: true, reason: null },
      };
      if (gate === 'dependency') checks.dependency = { ready: false, reason: 'dependency_pending' };
      if (gate === 'authorization') checks.authorization = { valid: false, reason: 'authorization_invalid' };
      if (gate === 'budget') checks.budget = { allowed: false, reason: 'budget_exhausted' };
      if (gate === 'code') checks.code = { ready: false, reason: 'code_prerequisite_missing' };
      const blocked = evaluateFeatureDispatchCandidate({ policy, identity, ...checks });
      expect(blocked.eligible).toBe(false);
      expect(blocked.attemptMayBeCreated).toBe(false);
      expect(blocked.reason).toBeTruthy();
    }
  });

  it('[case:narrow-admission-port-no-side-effects] 等待候选只读准入，不创建 Attempt/Runtime/预算副作用', () => {
    const calls: string[] = [];
    const admission = createFeatureDispatchAdmission({
      readBatch: () => {
        calls.push('batch');
        return batch();
      },
      checkDependencies: () => {
        calls.push('dependency');
        return { ready: false, reason: 'dependency_pending' };
      },
      checkAuthorization: () => {
        calls.push('authorization');
        return { valid: true, reason: null };
      },
      checkBudget: () => {
        calls.push('budget');
        return { allowed: true, reason: null };
      },
      checkCodePrerequisites: () => {
        calls.push('code');
        return { ready: true, reason: null };
      },
      nowUtcMs: () => NOW,
    });
    const result = admission.check(candidate());
    expect(result).toMatchObject({ eligible: false, attemptMayBeCreated: false, reason: 'dependency_not_ready' });
    expect(calls).toEqual(['batch', 'dependency']);
  });
});
