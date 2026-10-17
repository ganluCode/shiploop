import type { VerificationPlan } from '../application/verification-plan.js';
import type { VerificationCodeIdentity } from './verification-aggregate.js';
import type { WorkResourceIdentity } from './work-resources.js';

export const FEATURE_VERIFICATION_OPERATION = 'FeatureVerification.full' as const;
export const FEATURE_VERIFICATION_STATUSES = ['passed', 'failed', 'error', 'inconclusive'] as const;
export type FeatureVerificationStatus = (typeof FEATURE_VERIFICATION_STATUSES)[number];
export type FeatureVerificationOutcomeStatus = FeatureVerificationStatus | 'blocked' | 'invalid';

export interface FeatureVerificationExecutionInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly operation: string;
  readonly executionVersion: number;
  readonly codeIdentity: VerificationCodeIdentity;
  readonly policyDigest: string;
  readonly environmentSummary: Readonly<Record<string, unknown>>;
  readonly plan: VerificationPlan;
  /** Stable full-suite targets supplied by the confirmed project policy. */
  readonly targets: readonly string[];
  /** The executor calls this immediately before finalizing the batch. */
  readonly assertCurrentIdentity?: () => Promise<boolean>;
}

export interface FeatureVerificationExecutionResult {
  readonly batchId: string;
  readonly status: FeatureVerificationStatus;
  readonly results: readonly {
    readonly checkKey: string;
    readonly status: string;
    readonly resultId: string;
    readonly outputArtifactId?: string | null;
  }[];
}

export interface FeatureVerificationExecutor {
  start(input: FeatureVerificationExecutionInput): Promise<FeatureVerificationExecutionResult>;
}

export interface FeatureTaskGate {
  evaluate(projectId: unknown, runId: unknown): {
    readonly projectId: string;
    readonly runId: string;
    readonly featureId: string;
    readonly reason: string;
    readonly handoff: 'feature_final_verification' | null;
  };
}

export interface FeatureVerificationInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly operation?: string;
  readonly executionVersion: number;
  readonly resourceIdentity: WorkResourceIdentity;
  readonly workspaceBaseline: unknown;
  readonly policy: unknown;
  readonly policyDigest: string;
  readonly environmentSummary: Readonly<Record<string, unknown>>;
  readonly environmentDigest?: string;
  readonly targets: readonly string[];
}

export interface FeatureVerificationResult {
  readonly status: FeatureVerificationOutcomeStatus;
  readonly batchId: string | null;
  readonly reason:
    | 'tasks_not_passed'
    | 'stop_unconfirmed'
    | 'workspace_unavailable'
    | 'full_plan_unavailable'
    | 'identity_changed'
    | 'source_changed'
    | 'execution_failed'
    | 'evidence_incomplete'
    | 'approval_waiting'
    | 'verified';
  readonly invalidated: boolean;
  readonly codeIdentity: VerificationCodeIdentity | null;
  readonly execution?: FeatureVerificationExecutionResult;
}
