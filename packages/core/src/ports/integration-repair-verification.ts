import type { ArtifactInputRef } from './artifact-store.js';
import type { IntegrationVerificationEvidenceRef } from './integration-verification.js';

export interface IntegrationRepairVerificationRecord {
  readonly projectId: string;
  readonly repairId: string;
  readonly attemptId: string;
  readonly artifact: ArtifactInputRef;
  readonly planRef: IntegrationVerificationEvidenceRef;
  readonly resultRef: IntegrationVerificationEvidenceRef;
  readonly inputDigest: string;
  readonly status: 'passed';
}
