import { expect, it } from 'vitest';
import { buildFeatureCloseoutPlan } from '../../../packages/core/src/application/feature-closeout-plan.ts';
import { validateConfirmedTaskVerificationPolicy } from '../../../packages/core/src/ports/task-verification-policy.ts';
import { validateSettingsPayload } from '../../../packages/core/src/ports/settings-schema.ts';
import { computeFeatureCheckPolicyDigest } from '../../../packages/core/src/ports/plan-approval-verification.ts';

const check = (checkKey: string, scope: 'module' | 'project') => ({ checkKey, scope, kind: 'command' as const,
  argv: ['node', 'check.mjs', checkKey], cwdRef: null, environmentRef: null, timeout: 1000,
  required: true, requirementRefs: [] });
const policy = { checkDefinitions: [check('unit-a', 'module'), check('unit-b', 'module'), check('all', 'project')],
  fullFallback: { checkRefs: ['all'] }, featureChecks: ['unit-b', 'unit-a'] };

it('uses only the explicitly approved Feature checks, in their approved order', () => {
  const plan = buildFeatureCloseoutPlan(policy, ['unit-a', 'unit-b']);
  expect(plan.status).toBe('ready');
  expect(plan.selectedCheckKeys).toEqual(['unit-b', 'unit-a']);
  expect(plan.unselectedCheckKeys).toEqual(['all']);
  expect(plan.selectedChecks.map(x => x.argv)).toEqual([['node', 'check.mjs', 'unit-b'], ['node', 'check.mjs', 'unit-a']]);
});

it('never falls back to project tests when Feature scope is absent or invalid', () => {
  const { featureChecks: _, ...old } = policy;
  expect(buildFeatureCloseoutPlan(old)).toMatchObject({ status: 'inconclusive', selectedChecks: [] });
  for (const refs of [[], ['unknown'], ['unit-a', 'unit-a'], ['all']]) {
    expect(() => validateConfirmedTaskVerificationPolicy({ ...policy, featureChecks: refs }, { operation: 'test' })).toThrow();
    expect(buildFeatureCloseoutPlan({ ...policy, featureChecks: refs }, ['unit-a']).selectedChecks).toEqual([]);
  }
});

it('does not run unrelated eligible checks or use the entire allowed list as an implicit scope', () => {
  expect(buildFeatureCloseoutPlan(policy).selectedChecks).toEqual([]);
  expect(buildFeatureCloseoutPlan(policy, ['unit-a']).selectedCheckKeys).toEqual(['unit-a']);
  expect(buildFeatureCloseoutPlan(policy, ['all']).selectedChecks).toEqual([]);
  expect(buildFeatureCloseoutPlan(policy, ['unit-a', 'unit-a']).selectedChecks).toEqual([]);
});

it('retains Feature scope through settings validation and binds it to the approval digest', () => {
  const payload = validateSettingsPayload({ schemaVersion: 2, policies: { verification: policy } }, { operation: 'test' });
  expect(payload).toMatchObject({ policies: { verification: { featureChecks: ['unit-b', 'unit-a'] } } });
  const { featureChecks: _, ...old } = policy;
  expect(computeFeatureCheckPolicyDigest(policy)).not.toBe(computeFeatureCheckPolicyDigest(old));
});
