import type { FeatureCloseoutKey } from '../ports/feature-closeout.js';
import { FeatureCloseoutPreparationError } from '../ports/feature-closeout.js';
import type { FeatureVerificationInput } from '../ports/feature-verification.js';
import { computeFeatureCheckPolicyDigest } from '../ports/plan-approval-verification.js';
import { validateConfirmedTaskVerificationPolicy } from '../ports/task-verification-policy.js';
import { createFeatureVerificationCoordinator, type FeatureVerificationOptions } from './feature-verification.js';
import { buildFeatureCloseoutPlan } from './feature-closeout-plan.js';

/** Connects first-time closeout to the existing fenced Verifier, never to retryFinal. */
export function createFeatureCloseoutVerifier(options: {
  coordinator: Omit<FeatureVerificationOptions, 'buildPlan'>;
  /** checkKeys must be the trusted union of this Feature's persisted Task checks. */
  prepare(key: FeatureCloseoutKey): Promise<{ inputDigest: string; checkKeys: readonly string[]; input: FeatureVerificationInput }>;
  verifyEvidence(projectId: string, batchId: string): Promise<boolean>;
}) {
  return {
    async verify(key: FeatureCloseoutKey): Promise<{ passed: boolean; evidenceRef: string; reason: string }> {
      const prepared = await options.prepare(key);
      const { input } = prepared;
      let policy;
      try { policy = validateConfirmedTaskVerificationPolicy(input.policy, { operation: 'FeatureCloseout.verify' }); }
      catch { throw new FeatureCloseoutPreparationError('feature_check_policy_invalid'); }
      if (prepared.inputDigest !== key.inputDigest || input.projectId !== key.projectId
        || input.runId !== key.runId || input.featureId !== key.featureId
        || computeFeatureCheckPolicyDigest(policy) !== input.policyDigest) {
        throw new FeatureCloseoutPreparationError('closeout_verification_identity_changed');
      }
      const plan = buildFeatureCloseoutPlan(input.policy, prepared.checkKeys);
      if (plan.status !== 'ready') throw new FeatureCloseoutPreparationError('feature_check_scope_missing');
      const coordinator = createFeatureVerificationCoordinator({ ...options.coordinator, buildPlan: () => plan });
      const result = await coordinator.run({ ...input, environmentSummary: { ...input.environmentSummary,
        featureCheckScope: { kind: 'feature-task-union', checkKeys: [...plan.selectedCheckKeys] } } });
      if (!result.batchId) throw new Error(`closeout_verification_${result.reason}`);
      const intact = await options.verifyEvidence(key.projectId, result.batchId);
      return { passed: intact && result.status === 'passed' && !result.invalidated,
        evidenceRef: result.batchId, reason: intact ? result.reason : 'verification_evidence_invalid' };
    },
  };
}
