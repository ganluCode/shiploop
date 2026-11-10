import type { GitAgentRepairRequest } from './git-agent-repair.js';

/** Internal admission under an existing integration owner; never creates a Run. */
export interface IntegrationRepairFence {
  readonly expectedRevision: number;
  readonly ownerId: string;
  readonly ownerVersion: number;
}

export interface IntegrationRepairAuthorizationReceipt {
  readonly projectId: string;
  readonly repairId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly authorizationDigest: string;
  readonly ownerId: string;
  readonly ownerVersion: number;
  readonly admittedRevision: number;
}

export interface IntegrationRepairAuthorizationRecord {
  readonly request: GitAgentRepairRequest;
  readonly fence: IntegrationRepairFence;
  readonly receipt: IntegrationRepairAuthorizationReceipt;
}
