import type { IntegrationRepairAuthorizationRecord } from './integration-repair-authorization.js';
import type { ProductionGitAgentBinding } from './git-agent-production.js';
import type { WorkspaceBaseline } from './workspace.js';
import type { WorkspaceInspection } from './workspace-inspector.js';
import type { ArtifactInputRef } from './artifact-store.js';
import type { VerificationPlan } from './verification-plan.js';

/** Supplied by the trusted Core transaction reader, never a model or command payload. */
export interface IntegrationRepairContextFacts {
  readonly authorization: IntegrationRepairAuthorizationRecord;
  readonly baseline: WorkspaceBaseline;
  readonly expectedHead: string;
  readonly strategy: ProductionGitAgentBinding['strategy'];
  readonly locale: ProductionGitAgentBinding['locale'];
  readonly maxRequests: number;
  readonly policyDigest: string;
  readonly verificationPlan: VerificationPlan;
  readonly evidence: string;
}

export interface PreparedIntegrationRepairContext {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly repairId: string;
  readonly authorizationDigest: string;
  readonly factsDigest: string;
  readonly baseline: WorkspaceBaseline;
  readonly before: WorkspaceInspection;
  readonly binding: Omit<ProductionGitAgentBinding, 'requestDigest'>;
  readonly verificationPlan: VerificationPlan;
}

export interface IntegrationRepairContextReceipt {
  readonly projectId: string;
  readonly repairId: string;
  readonly authorizationDigest: string;
  readonly factsDigest: string;
  readonly artifact: ArtifactInputRef;
}
