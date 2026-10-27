import type { IntegrationWorkspaceHandle } from './integration-workspace.js';
import type { VerificationPlan } from './verification-plan.js';
import type { PersistedIntegrationPlan } from './integration-plan-store.js';
import type { GitOperationRecord } from './git-operations.js';

export const INTEGRATION_VERIFICATION_STATUSES = ['passed', 'failed', 'error', 'inconclusive'] as const;
export type IntegrationVerificationStatus = typeof INTEGRATION_VERIFICATION_STATUSES[number];

export interface IntegrationVerificationEvidenceRef {
  readonly id: string;
  readonly digest: string;
}

/** 受信验证器的结果只引用已持久化的计划和结果，不携带模型文本或本地路径。 */
export interface IntegrationVerificationExecutionResult {
  readonly status: IntegrationVerificationStatus;
  readonly stopped: boolean;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly inputDigest: string;
  readonly targetBase: string;
  readonly verificationPlan: IntegrationVerificationEvidenceRef;
  readonly verificationResult: IntegrationVerificationEvidenceRef;
}

export interface IntegrationVerificationExecutionInput {
  readonly projectId: string;
  readonly operationId: string;
  readonly sourcePlanId: string;
  readonly targetBaseline: string;
  readonly inputDigest: string;
  readonly workspace: IntegrationWorkspaceHandle;
  readonly plan: VerificationPlan;
  readonly targets: readonly string[];
}

/** 外部验证器可以启动受控进程，但不能写 Core 状态或自行解锁后继。 */
export interface IntegrationVerificationExecutor {
  start(input: IntegrationVerificationExecutionInput): Promise<IntegrationVerificationExecutionResult>;
}

export interface IntegrationVerificationRequest {
  readonly projectId: string;
  readonly operationId: string;
  readonly ownerId: string;
  readonly ownerVersion: number;
  readonly verificationPlan: VerificationPlan;
  readonly targets: readonly string[];
}

export type IntegrationVerificationOutcome = 'passed' | 'failed' | 'blocked' | 'unknown';

export interface IntegrationVerificationResult {
  readonly outcome: IntegrationVerificationOutcome;
  readonly reason:
    | 'candidate_missing'
    | 'candidate_not_ready'
    | 'authorization_not_current'
    | 'verification_plan_unavailable'
    | 'verification_evidence_incomplete'
    | 'input_digest_mismatch'
    | 'verification_stop_unconfirmed'
    | 'verification_failed'
    | 'source_changed'
    | 'settlement_conflict'
    | 'verified';
  readonly integration: PersistedIntegrationPlan | null;
  readonly operation: GitOperationRecord | null;
}

export interface IntegrationVerificationAuthorization {
  readonly current: boolean;
}

export interface IntegrationVerificationService {
  run(request: IntegrationVerificationRequest): Promise<IntegrationVerificationResult>;
}
