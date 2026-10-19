import type { AttemptRecord } from './attempt-store.js';
import type { ArtifactRecord } from './artifact-store.js';
import type { FeatureDeliveryView, FeatureDeliveryRunRow, FeatureDeliveryVerificationView } from './feature-delivery-query.js';
import type { GitOperationRecord } from './git-operations.js';
import type { WorkSessionDetailView, PublicWorkSessionResultEvidence } from './work-session-query.js';
import type { WorkSessionRecord } from './work-session.js';

export const FEATURE_REPORT_GET_OPERATION = 'features.report.get' as const;

/** Every page and reused narrow read belongs to one storage read transaction.
 * Ready Artifact identities are frozen here; bodies are verified separately against
 * these immutable hashes. The event watermark is a reference, not a version for
 * native Runtime storage or proof that every historical metric was recorded.
 */
export interface FeatureExecutionReportView {
  readonly delivery: FeatureDeliveryView;
  readonly eventWatermark: number;
  readonly runs: readonly FeatureDeliveryRunRow[];
  readonly attempts: readonly WorkSessionDetailView[];
  readonly sessions: readonly { readonly attemptId: string; readonly session: WorkSessionRecord }[];
  readonly verifications: readonly FeatureDeliveryVerificationView[];
  readonly operations: readonly GitOperationRecord[];
  readonly artifactIds: readonly string[];
  readonly artifacts: readonly ArtifactRecord[];
}

export interface FeatureExecutionReportReadStore {
  readFeatureExecutionReportView(projectId: unknown, featureId: unknown): FeatureExecutionReportView | undefined;
}

export function featureReportAttemptArtifactIds(attempt: AttemptRecord): readonly string[] {
  return [...new Set([
    attempt.inputRef, attempt.codeRef, attempt.diagnosticRef,
    ...Object.values(attempt.inputSnapshot.group).map(ref => ref.artifactId),
    ...attempt.inputSnapshot.requiredInputs.map(ref => ref.artifactId),
    ...(attempt.inputSnapshot.rework?.failureEvidenceRefs ?? []).map(ref => ref.artifactId),
  ].filter((id): id is string => id != null))];
}

export interface FeatureReportResultEvidence {
  readonly evidence: PublicWorkSessionResultEvidence | null;
  readonly issue: 'result_evidence_missing' | 'result_evidence_invalid' | null;
}
