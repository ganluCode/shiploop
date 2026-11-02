import type { FeatureCloseoutKey } from '../ports/feature-closeout.js';
import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import type { ControlledGitCommitService } from '../ports/controlled-git-commit.js';
import type { VerificationStore } from '../ports/verification-store.js';
import { FEATURE_VERIFICATION_OPERATION } from '../ports/feature-verification.js';
import { createFeatureFinalizationService, type FeatureFinalizationInput, type FeatureFinalizationApproval } from './feature-finalization.js';

/** Reuses the business finalization transaction; never repeats successful test commands. */
export function createFeatureCloseoutDelivery(options: {
  atomic: AtomicCommandStore;
  verification: Pick<VerificationStore, 'getVerificationBatch' | 'listCheckResults'>;
  commit: ControlledGitCommitService;
  prepare(key: FeatureCloseoutKey, evidenceRef: string): Promise<{
    inputDigest: string; input: FeatureFinalizationInput; codeDigest: string; policyDigest: string;
  }>;
  readApproval(input: FeatureFinalizationInput, codeDigest: string): Promise<FeatureFinalizationApproval>;
  verifyEvidence(projectId: string, batchId: string): Promise<boolean>;
}) {
  return {
    async complete(key: FeatureCloseoutKey, evidenceRef: string): Promise<'completed' | 'blocked' | 'reconcile_required'> {
      const prepared = await options.prepare(key, evidenceRef);
      const { input } = prepared;
      if (prepared.inputDigest !== key.inputDigest || input.projectId !== key.projectId
        || input.featureId !== key.featureId || input.runId !== key.runId) throw new Error('closeout_delivery_identity_changed');
      const finalization = createFeatureFinalizationService({ atomic: options.atomic, commit: options.commit,
        readApproval: ref => options.readApproval(ref, prepared.codeDigest),
        async verify() {
          const batch = options.verification.getVerificationBatch(key.projectId, evidenceRef);
          const results = options.verification.listCheckResults(key.projectId, evidenceRef);
          const valid = batch.projectId === key.projectId && batch.featureId === key.featureId && batch.runId === key.runId
            && batch.operation === FEATURE_VERIFICATION_OPERATION && batch.status === 'passed'
            && batch.codeDigest === prepared.codeDigest && batch.policyDigest === prepared.policyDigest
            && batch.checkSnapshot.length > 0 && results.length === batch.checkSnapshot.length
            && batch.checkSnapshot.every(check => {
              const matches = results.filter(result => result.checkKey === check.checkKey);
              return matches.length === 1 && matches[0].status === 'passed' && matches[0].outputArtifactId !== null;
            });
          if (!valid) return { passed: false, reason: 'feature_verification_identity_invalid' };
          const intact = await options.verifyEvidence(key.projectId, evidenceRef);
          return { passed: intact, reason: intact ? 'feature_verified' : 'feature_verification_evidence_invalid' };
        },
      });
      const result = await finalization.finalize(input);
      if (result.outcome === 'completed' && result.deliveryStatus === 'succeeded') return 'completed';
      return result.deliveryStatus === 'pending' ? 'reconcile_required' : 'blocked';
    },
  };
}
