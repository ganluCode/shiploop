import { expect, it, vi } from 'vitest';
import { createFeatureCloseoutVerifier } from '../../../packages/core/src/application/feature-closeout-verifier.ts';
import { computeFeatureCheckPolicyDigest } from '../../../packages/core/src/ports/plan-approval-verification.ts';
import type { FeatureVerificationOptions } from '../../../packages/core/src/application/feature-verification.ts';
import type { WorkspaceInspection } from '../../../packages/core/src/ports/workspace-inspector.ts';

const identity = { projectId: 'p', attemptId: 'attempt', owner: 'owner', hostInstanceId: 'host', executionVersion: 1 };
const key = { projectId: 'p', featureId: 'f', runId: 'r', inputDigest: 'a'.repeat(64) };
const check = (checkKey: string, scope: 'module' | 'project') => ({ checkKey, scope, kind: 'command' as const,
  argv: ['node', 'check.mjs', checkKey], cwdRef: null, environmentRef: null, timeout: 1000, required: true, requirementRefs: [] });
const policy = { checkDefinitions: [check('unit', 'module'), check('all', 'project')], fullFallback: { checkRefs: ['all'] }, featureChecks: ['unit'] };
const inspection: WorkspaceInspection = {
  schemaVersion: 1, complete: true, evidenceId: 'inspection', startedAt: 'a', endedAt: 'b',
  repository: { repositoryBindingId: 'binding', repositoryBindingRevision: 1, headCommit: 'a'.repeat(40), branch: 'feature', canonicalPath: '/tmp/project', gitCommonDir: '/tmp/project/.git', repoIdentity: 'repo', baseCommit: 'b'.repeat(40) },
  registration: { path: '/tmp/project', headCommit: 'a'.repeat(40), branch: 'feature' },
  statusPorcelainBase64: '', refsDigest: 'r', codeDigest: 'c'.repeat(64), ignoredDigest: 'i',
  contents: { tracked: [], untracked: [], ignored: [], directories: [] }, ignoredProtection: 'none_present', directoryProtection: 'none_present',
  observedFileCount: 0, observedBytes: 0, gitCalls: 1, boundary: 'trusted_project_not_os_sandbox',
};
function setup() {
  const execute = vi.fn(async (input: { batchId: string }) => ({ batchId: input.batchId, status: 'passed' as const,
    results: [{ checkKey: 'unit', status: 'passed', resultId: 'check-result', outputArtifactId: 'output' }] }));
  const coordinator: Omit<FeatureVerificationOptions, 'buildPlan'> = {
    taskDag: { evaluate: () => ({ projectId: 'p', featureId: 'f', runId: 'r', reason: 'all_passed', handoff: 'feature_final_verification' }) },
    resources: { read: () => ({ identity, invocationId: null, processIdentity: null, leases: [] }) },
    stopVerifier: { verify: async () => ({}), inspect: () => { throw new Error('unused'); } },
    workspace: { inspect: async () => inspection }, execute: { start: execute },
    withResource: async (_identity, run) => run(),
  };
  const input = { ...key, batchId: 'verification-batch', executionVersion: 1, resourceIdentity: identity,
    workspaceBaseline: {}, policy, policyDigest: computeFeatureCheckPolicyDigest(policy), environmentSummary: {}, targets: ['unit'] };
  const prepare = vi.fn(async () => ({ inputDigest: key.inputDigest, checkKeys: ['unit'], input }));
  const verifyEvidence = vi.fn(async () => true);
  return { coordinator, input, prepare, verifyEvidence, execute };
}

it('uses the existing fenced coordinator and validates the persistent outputs before accepting the batch', async () => {
  const t = setup();
  expect(await createFeatureCloseoutVerifier(t).verify(key)).toEqual({ passed: true, evidenceRef: 'verification-batch', reason: 'verified' });
  expect(t.execute.mock.calls[0][0]).toMatchObject({ plan: { selectedCheckKeys: ['unit'], unselectedCheckKeys: ['all'] } });
  expect(t.execute.mock.calls[0][0]).toMatchObject({ environmentSummary: { featureCheckScope: { kind: 'feature-task-union', checkKeys: ['unit'] } } });
  expect(t.verifyEvidence).toHaveBeenCalledWith('p', 'verification-batch');
  t.verifyEvidence.mockResolvedValue(false);
  expect(await createFeatureCloseoutVerifier(t).verify(key)).toMatchObject({ passed: false, reason: 'verification_evidence_invalid' });
});

it('rejects stale identity or missing Feature scope before starting a command', async () => {
  const t = setup();
  await expect(createFeatureCloseoutVerifier(t).verify({ ...key, inputDigest: 'b'.repeat(64) })).rejects.toThrow('identity_changed');
  const { featureChecks: _, ...old } = policy;
  t.input.policy = old as typeof policy;
  t.input.policyDigest = computeFeatureCheckPolicyDigest(old);
  await expect(createFeatureCloseoutVerifier(t).verify(key)).rejects.toThrow('feature_check_scope_missing');
  expect(t.execute).not.toHaveBeenCalled();
});

it('does not publish a passing batch when code changes during checks', async () => {
  const t = setup(); let reads = 0;
  const workspace: FeatureVerificationOptions['workspace'] = { inspect: async () => ({ ...inspection, contents: { ...inspection.contents,
    tracked: [{ path: 'src/a.ts', state: 'present', sizeBytes: 1, digest: ++reads === 1 ? 'c'.repeat(64) : 'd'.repeat(64),
      mode: 33188, indexObject: null, indexMode: null, protection: 'tracked' }] } }) };
  expect(await createFeatureCloseoutVerifier({ ...t, coordinator: { ...t.coordinator, workspace } }).verify(key)).toMatchObject({ passed: false, reason: 'source_changed' });
});
