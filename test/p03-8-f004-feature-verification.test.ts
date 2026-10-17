import { describe, expect, it } from 'vitest';
import { createFeatureVerificationCoordinator } from '../packages/core/src/application/feature-verification.js';
import type { FeatureVerificationOptions } from '../packages/core/src/application/feature-verification.js';
import type { FeatureVerificationExecutionInput, FeatureVerificationExecutionResult } from '../packages/core/src/ports/feature-verification.js';
import type { VerificationPlan } from '../packages/core/src/application/verification-plan.js';

const identity = {
  projectId: 'project-1', attemptId: 'attempt-1', owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1,
};
const processIdentity = { launchId: '00000000-0000-4000-8000-000000000001', pid: 42, processGroupId: 42, startTime: 't' };
const plan: VerificationPlan = {
  status: 'ready', mode: 'full_fallback', affectedModules: ['core'], coveredModules: ['core'],
  selectedCheckKeys: ['all-tests', 'build'],
  selectedChecks: [
    { checkKey: 'all-tests', scope: 'project', kind: 'command', argv: ['node', 'all-tests.js'], cwdRef: '.', environmentRef: null, timeout: 1000, required: true, requirementRefs: ['acceptance'] },
    { checkKey: 'build', scope: 'project', kind: 'command', argv: ['node', 'build.js'], cwdRef: '.', environmentRef: null, timeout: 1000, required: true, requirementRefs: ['acceptance'] },
  ],
  unselectedCheckKeys: [], reasonCode: 'candidate_missing', reason: 'feature full verification', candidateDigest: null, candidateRejection: { reason: 'candidate_missing', detail: 'unused' },
};

const passedResults = () => plan.selectedChecks.map(check => ({ checkKey: check.checkKey, status: 'passed' as const, resultId: `result-${check.checkKey}`, outputArtifactId: `artifact-${check.checkKey}` }));

function options(overrides: Partial<FeatureVerificationOptions> = {}): FeatureVerificationOptions {
  let inspection = 0;
  const base: FeatureVerificationOptions = {
    taskDag: { evaluate: () => ({ reason: 'all_passed', handoff: 'feature_final_verification' as const, projectId: 'project-1', runId: 'run-1', featureId: 'feature-1', diagnostic: null, readyTaskIds: [], tasks: [] }) },
    resources: { read: () => ({ identity, invocationId: 'invocation-1', processIdentity, leases: [{}, {}, {}] as never }) },
    stopVerifier: { verify: async () => Object.freeze({}), inspect: () => ({}) as never } as never,
    workspace: { inspect: async () => {
      inspection += 1;
      return {
        schemaVersion: 1, complete: true, evidenceId: `evidence-${inspection}`, startedAt: 'a', endedAt: 'b',
        repository: { headCommit: 'a'.repeat(40), branch: 'feature', canonicalPath: '/tmp/project', gitCommonDir: '/tmp/.git', repoIdentity: 'repo', baseCommit: 'b'.repeat(40) },
        registration: { path: '/tmp/project', headCommit: 'a'.repeat(40), branch: 'feature' }, statusPorcelainBase64: '', refsDigest: 'r', codeDigest: inspection === 1 ? 'c'.repeat(64) : 'c'.repeat(64), ignoredDigest: 'i',
        contents: { tracked: [{ path: 'src/a.ts', state: 'present', sizeBytes: 1, digest: 'd', mode: 33188, indexObject: null, indexMode: null, protection: 'tracked' }], untracked: [], ignored: [], directories: [] }, ignoredProtection: 'none_present', directoryProtection: 'none_present', observedFileCount: 1, observedBytes: 1, gitCalls: 1, boundary: 'trusted_project_not_os_sandbox',
      };
    } } as never,
    buildPlan: () => plan,
    withResource: async <T>(_resourceIdentity: unknown, callback: () => Promise<T>): Promise<T> => callback(),
    execute: { start: async (input: FeatureVerificationExecutionInput): Promise<FeatureVerificationExecutionResult> => ({ batchId: input.batchId, status: 'passed', results: passedResults() }) },
  };
  return { ...base, ...overrides };
}

const input = {
  projectId: 'project-1', featureId: 'feature-1', runId: 'run-1', batchId: 'feature-batch-1', operation: 'FeatureVerification.full', executionVersion: 1,
  resourceIdentity: identity, workspaceBaseline: {}, policy: {}, policyDigest: 'a'.repeat(64), environmentSummary: { node: '22' }, targets: ['all'],
};

describe('F-004 Feature verification coordinator', () => {
  it('runs a separate full plan only after the current DAG passed and stop was confirmed', async () => {
    const calls: string[] = [];
    const result = await createFeatureVerificationCoordinator(options({
      stopVerifier: { verify: async () => { calls.push('stop'); return Object.freeze({}); }, inspect: () => ({}) } as never,
      execute: { start: async (executionInput) => { calls.push('execute'); expect(executionInput.plan.mode).toBe('full_fallback'); return { batchId: executionInput.batchId, status: 'passed', results: passedResults() }; } },
    })).run(input);
    expect(result).toMatchObject({ status: 'passed', batchId: 'feature-batch-1', invalidated: false });
    expect(calls).toEqual(['stop', 'execute']);
  });

  it('does not start a feature batch when a required Task is not currently passed', async () => {
    let executed = false;
    const result = await createFeatureVerificationCoordinator(options({
      taskDag: { evaluate: () => ({ reason: 'dependency_pending', handoff: null, projectId: 'project-1', runId: 'run-1', featureId: 'feature-1', diagnostic: null, readyTaskIds: [], tasks: [] }) },
      execute: { start: async () => { executed = true; return { batchId: 'x', status: 'passed', results: [] }; } },
    })).run(input);
    expect(result).toMatchObject({ status: 'blocked', reason: 'tasks_not_passed', batchId: null });
    expect(executed).toBe(false);
  });

  it('invalidates the result when the worktree changes during final verification', async () => {
    let inspection = 0;
    const configured = options({
      workspace: { inspect: async () => {
        inspection += 1;
        const base = await options().workspace.inspect({});
        return { ...base, evidenceId: `e-${inspection}`, contents: { ...base.contents, tracked: [{ ...base.contents.tracked[0], digest: inspection === 1 ? 'd' : 'x' }] } };
      } } as never,
    });
    const result = await createFeatureVerificationCoordinator(configured).run(input);
    expect(result).toMatchObject({ status: 'invalid', invalidated: true, reason: 'source_changed' });
  });

  it('fails closed when a required check has no Artifact evidence', async () => {
    const result = await createFeatureVerificationCoordinator(options({
      execute: { start: async (executionInput) => ({
        batchId: executionInput.batchId, status: 'passed',
        results: passedResults().map((item, index) => index === 0 ? { ...item, outputArtifactId: null } : item),
      }) },
    })).run(input);
    expect(result).toMatchObject({ status: 'error', reason: 'evidence_incomplete', batchId: 'feature-batch-1' });
  });

  it('fails closed when the full plan is unavailable', async () => {
    let executed = false;
    const result = await createFeatureVerificationCoordinator(options({
      buildPlan: () => ({ ...plan, status: 'inconclusive', selectedChecks: [], selectedCheckKeys: [], reasonCode: 'fallback_unavailable', reason: 'missing full checks' }),
      execute: { start: async () => { executed = true; return { batchId: 'x', status: 'passed', results: [] }; } },
    })).run(input);
    expect(result).toMatchObject({ status: 'blocked', reason: 'full_plan_unavailable', batchId: null });
    expect(executed).toBe(false);
  });
});
