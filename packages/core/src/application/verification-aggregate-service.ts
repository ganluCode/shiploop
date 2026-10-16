import type { VerificationStore } from '../ports/verification-store.js';
import type { WorkspaceInspector, WorkspaceInspection } from '../ports/workspace-inspector.js';
import {
  verificationCodeIdentity,
  type MachineVerificationInput,
  type MachineVerificationResult,
  type VerificationCodeIdentity,
  type VerificationRuntimeFacts,
} from '../ports/verification-aggregate.js';
import { aggregateMachineVerification } from './verification-aggregate.js';

export async function captureVerificationIdentity(input: {
  readonly inspector: WorkspaceInspector;
  readonly baseline: unknown;
  readonly executionDigest?: string;
  readonly environmentDigest?: string;
  readonly reproducibleOutputPaths?: readonly string[];
}): Promise<{ readonly inspection: WorkspaceInspection; readonly identity: VerificationCodeIdentity }> {
  const inspection = await input.inspector.inspect(input.baseline);
  return {
    inspection,
    identity: verificationCodeIdentity(inspection,
      { executionDigest: input.executionDigest, environmentDigest: input.environmentDigest },
      { reproducibleOutputPaths: input.reproducibleOutputPaths }),
  };
}

export interface StoredVerificationAggregationInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly runtime: VerificationRuntimeFacts;
  readonly workspaceHeld: boolean;
  readonly beforeIdentity: VerificationCodeIdentity;
  readonly afterIdentity: VerificationCodeIdentity;
  readonly testCounts?: Readonly<Record<string, number>>;
  readonly baseline?: MachineVerificationInput['baseline'];
  readonly humanReview?: unknown;
  readonly diagnostic?: boolean;
}

/** Read one immutable batch and its evidence through the existing port. */
export function aggregateStoredVerification(
  verification: VerificationStore,
  input: StoredVerificationAggregationInput,
): MachineVerificationResult {
  const batch = verification.getVerificationBatch(input.projectId, input.batchId);
  const results = verification.listCheckResults(input.projectId, input.batchId);
  const evidence: Record<string, { readonly status: 'complete' | 'none' | 'incomplete'; readonly reference?: string }> = {};
  for (const check of results) {
    try {
      const observed = verification.readCheckResultEvidence(input.projectId, check.id);
      evidence[check.checkKey] = observed.status === 'complete'
        ? { status: 'complete', reference: observed.artifactId }
        : { status: observed.status };
    } catch {
      evidence[check.checkKey] = { status: 'incomplete' };
    }
  }
  const plan = {
    status: batch.status === 'passed' ? 'ready' as const : 'inconclusive' as const,
    selectedChecks: batch.checkSnapshot
      .filter((check) => batch.selection.selectedCheckKeys.includes(check.checkKey))
      .map((check) => ({ checkKey: check.checkKey, required: check.required })),
    requiredCheckKeys: batch.checkSnapshot.filter((check) => check.required).map((check) => check.checkKey),
  };
  return aggregateMachineVerification({
    ...input,
    expectedCodeDigest: batch.codeDigest,
    expectedExecutionDigest: batch.policyDigest,
    plan, results, evidence,
  });
}

export { aggregateMachineVerification };
