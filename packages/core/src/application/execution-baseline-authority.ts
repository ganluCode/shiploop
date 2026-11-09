import type { PersistedIntegrationPlan } from '../ports/integration-plan-store.js';
import {
  assertExecutionBaseline,
  resolveExecutionBaseline,
  type ExecutionBaselineIdentity,
  type ExecutionBaselineResolutionInput,
} from './execution-baseline.js';

export interface ExecutionBaselineAuthority {
  resolve(input: ExecutionBaselineResolutionInput): ExecutionBaselineIdentity;
  assertPreparation(input: {
    readonly projectId: string;
    readonly phaseId: string;
    readonly featureId: string;
    readonly dependencyFeatureIds: readonly string[];
    readonly baseCommit: string;
    readonly integrationPlans: readonly PersistedIntegrationPlan[];
  }): void;
}

/**
 * Single authority used by preview, start and workspace preparation. The adapter
 * supplies the same transaction snapshot to each call; this object owns only
 * the selection and identity comparison rules.
 */
export function createExecutionBaselineAuthority(options: {
  readonly approvedPlanningBaseline?: (projectId: string, featureId: string) => {
    readonly headCommit: string;
    readonly repositoryBindingId: string | null;
    readonly repositoryBindingRevision: number | null;
  } | null;
} = {}): ExecutionBaselineAuthority {
  return {
    resolve(input) {
      return resolveExecutionBaseline({
        ...input,
        approvedPlanningBaseline: input.approvedPlanningBaseline ?? options.approvedPlanningBaseline?.(input.projectId, input.featureId) ?? null,
      });
    },
    assertPreparation(input) {
      const actual = resolveExecutionBaseline({
        projectId: input.projectId,
        phaseId: input.phaseId,
        featureId: input.featureId,
        dependencyFeatureIds: input.dependencyFeatureIds,
        currentHeadCommit: input.baseCommit,
        integrationPlans: input.integrationPlans,
      });
      const expected: ExecutionBaselineIdentity = {
        ...actual,
        baseCommit: input.baseCommit,
      };
      assertExecutionBaseline(expected, actual);
    },
  };
}
