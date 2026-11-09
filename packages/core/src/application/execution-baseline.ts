import { StorageError } from '../ports/errors.js';
import type { IntegrationPredecessorInput } from '../ports/integration-plan.js';
import type { PersistedIntegrationPlan } from '../ports/integration-plan-store.js';

export type ExecutionBaselineSource = 'execution_snapshot' | 'planning_snapshot' | 'single_predecessor' | 'integration_result';

export interface ExecutionBaselineIdentity {
  readonly baseCommit: string;
  readonly treeSha: string | null;
  readonly integrationId: string | null;
  readonly inputDigest: string | null;
  readonly planRevision: number | null;
  readonly source: ExecutionBaselineSource;
}

export interface ExecutionBaselineResolutionInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly dependencyFeatureIds: readonly string[];
  readonly currentHeadCommit: string | null;
  readonly integrationPlans: readonly PersistedIntegrationPlan[];
  readonly approvedPlanningBaseline?: {
    readonly headCommit: string;
    readonly repositoryBindingId: string | null;
    readonly repositoryBindingRevision: number | null;
  } | null;
  readonly expectedIntegrationId?: string;
}

function fail(reason: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new StorageError('conflict', 'ExecutionBaseline.resolve', '编码基线当前不可使用', {
    details: { reason, ...details },
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function authoritativePlan(input: ExecutionBaselineResolutionInput): PersistedIntegrationPlan | null {
  const candidates = input.integrationPlans.filter((plan) =>
    plan.projectId === input.projectId && plan.phaseId === input.phaseId && plan.successorFeatureId === input.featureId);
  let selected: PersistedIntegrationPlan | undefined;
  for (const candidate of candidates) {
    if (selected === undefined || candidate.updatedAtUtcMs > selected.updatedAtUtcMs
      || (candidate.updatedAtUtcMs === selected.updatedAtUtcMs && compare(candidate.integrationId, selected.integrationId) > 0)) {
      selected = candidate;
    }
  }
  return selected ?? null;
}

function assertPlanScope(plan: PersistedIntegrationPlan, input: ExecutionBaselineResolutionInput): void {
  if (plan.projectId !== input.projectId || plan.phaseId !== input.phaseId || plan.successorFeatureId !== input.featureId) {
    fail('integration_stale');
  }
  if (plan.frozenAtUtcMs === null) fail('integration_pending', { integrationId: plan.integrationId });
  if (input.expectedIntegrationId !== undefined && input.expectedIntegrationId !== plan.integrationId) {
    fail('integration_stale', { expectedIntegrationId: input.expectedIntegrationId, actualIntegrationId: plan.integrationId });
  }
  const expected = [...new Set(input.dependencyFeatureIds)].sort(compare);
  const actual = [...new Set(plan.predecessors.map((predecessor) => predecessor.featureId))].sort(compare);
  if (expected.length !== actual.length || expected.some((featureId, index) => featureId !== actual[index])) {
    fail('integration_stale', { integrationId: plan.integrationId });
  }
  if (!plan.coverage.complete) fail('integration_pending', { integrationId: plan.integrationId });
}

function predecessorEvidence(plan: PersistedIntegrationPlan, featureId: string): IntegrationPredecessorInput {
  const predecessor = plan.predecessors.find((candidate) => candidate.featureId === featureId);
  if (predecessor === undefined || !predecessor.dependencyPassed || !predecessor.ancestorVerified
    || predecessor.delivery === null || predecessor.coveredInputIds.length === 0) {
    fail('dependency_pending', { featureId });
  }
  return predecessor;
}

export function resolveExecutionBaseline(input: ExecutionBaselineResolutionInput): ExecutionBaselineIdentity {
  const dependencies = [...new Set(input.dependencyFeatureIds)].sort(compare);
  if (dependencies.length === 0) {
    if (input.approvedPlanningBaseline !== undefined && input.approvedPlanningBaseline !== null) {
      return {
        baseCommit: input.approvedPlanningBaseline.headCommit,
        treeSha: null,
        integrationId: null,
        inputDigest: null,
        planRevision: null,
        source: 'planning_snapshot',
      };
    }
    if (input.currentHeadCommit === null) fail('baseline_missing');
    return {
      baseCommit: input.currentHeadCommit,
      treeSha: null,
      integrationId: null,
      inputDigest: null,
      planRevision: null,
      source: 'execution_snapshot',
    };
  }

  const plan = authoritativePlan(input);
  if (plan === null) fail('dependency_pending', { featureIds: dependencies });
  assertPlanScope(plan, input);

  if (dependencies.length === 1) {
    const predecessor = predecessorEvidence(plan, dependencies[0]!);
    const result = plan.integrationResult;
    if (plan.status === 'integration_passed' && result !== null && result.commitSha !== null && result.treeSha !== null && result.verificationEvidence !== null) {
      return {
        baseCommit: result.commitSha,
        treeSha: result.treeSha,
        integrationId: plan.integrationId,
        inputDigest: plan.inputDigest,
        planRevision: plan.revision,
        source: 'integration_result',
      };
    }
    if (plan.status !== 'dependency_passed' || predecessor.delivery === null) {
      fail('integration_pending', { integrationId: plan.integrationId });
    }
    return {
      baseCommit: predecessor.delivery.commitSha,
      treeSha: null,
      integrationId: plan.integrationId,
      inputDigest: plan.inputDigest,
      planRevision: plan.revision,
      source: 'single_predecessor',
    };
  }

  if (plan.status !== 'integration_passed') fail('integration_pending', { integrationId: plan.integrationId });
  const result = plan.integrationResult;
  if (result === null || result.commitSha === null || result.treeSha === null || result.verificationEvidence === null
    || (result.operationStatus !== undefined && result.operationStatus !== null && result.operationStatus !== 'succeeded')) {
    fail('integration_pending', { integrationId: plan.integrationId });
  }
  for (const featureId of dependencies) predecessorEvidence(plan, featureId);
  return {
    baseCommit: result.commitSha,
    treeSha: result.treeSha,
    integrationId: plan.integrationId,
    inputDigest: plan.inputDigest,
    planRevision: plan.revision,
    source: 'integration_result',
  };
}

export function assertExecutionBaseline(
  expected: ExecutionBaselineIdentity,
  actual: ExecutionBaselineIdentity,
): void {
  if (expected.baseCommit !== actual.baseCommit || expected.treeSha !== actual.treeSha
    || expected.integrationId !== actual.integrationId || expected.inputDigest !== actual.inputDigest
    || expected.planRevision !== actual.planRevision || expected.source !== actual.source) {
    fail(actual.integrationId === null ? 'preview_stale' : 'integration_stale', {
      expectedBaseCommit: expected.baseCommit,
      actualBaseCommit: actual.baseCommit,
      integrationId: actual.integrationId,
    });
  }
}
