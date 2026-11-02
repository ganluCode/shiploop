import { validateConfirmedTaskVerificationPolicy } from '../ports/task-verification-policy.js';
import type { VerificationPlan } from '../ports/verification-plan.js';

/** Select the whole approved Feature scope, not the project-wide fallback. */
export function buildFeatureCloseoutPlan(policy: unknown, featureCheckKeys?: readonly string[]): VerificationPlan {
  const unavailable: VerificationPlan = { status: 'inconclusive', mode: 'full_fallback', affectedModules: [], coveredModules: [],
    selectedCheckKeys: [], selectedChecks: [], unselectedCheckKeys: [], reasonCode: 'feature_scope_unavailable',
    reason: 'Explicit Feature check scope is required', candidateDigest: null, candidateRejection: null };
  try {
    const confirmed = validateConfirmedTaskVerificationPolicy(policy, { operation: 'FeatureCloseout.plan' });
    if (!confirmed.featureChecks?.length || !featureCheckKeys?.length) return unavailable;
    if (new Set(featureCheckKeys).size !== featureCheckKeys.length || featureCheckKeys.some(ref => !confirmed.featureChecks!.includes(ref))) return { ...unavailable, status: 'error' };
    const refs = confirmed.featureChecks.filter(ref => featureCheckKeys.includes(ref));
    const checks = refs.map(ref => confirmed.checkDefinitions!.find(check => check.checkKey === ref)!);
    return { ...unavailable, status: 'ready', reasonCode: 'feature_scope_configured', reason: 'Confirmed Feature-local check scope',
      selectedCheckKeys: refs, selectedChecks: checks.map(check => ({ ...check, argv: [...check.argv], requirementRefs: [...check.requirementRefs] })),
      unselectedCheckKeys: confirmed.checkDefinitions!.filter(check => !refs.includes(check.checkKey)).map(check => check.checkKey) };
  } catch { return { ...unavailable, status: 'error' }; }
}
