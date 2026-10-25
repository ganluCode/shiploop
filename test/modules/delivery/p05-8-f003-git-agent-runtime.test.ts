import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeGitAgentRepairBaselineDigest,
  createGitAgentRepairRequest,
  createGitAgentRuntimeRequest,
  superviseGitAgentRuntime,
  validateGitAgentRuntimeRequest,
  type GitAgentRepairAuthorizationInput,
} from '../../../packages/core/src/index.ts';
import { createFakeGitAgentRuntime, createGitAgentRuntimeGate } from '../../../packages/core/src/adapters/fake-git-agent-runtime.ts';
import { createPiGitAgentRuntimeAdapter } from '../../../packages/host/src/runtime/pi-git-agent-adapter.ts';

const DIGEST = (letter: string) => letter.repeat(64);
const SHA = 'a'.repeat(40);
const roots: string[] = [];

function authorization(): GitAgentRepairAuthorizationInput {
  return {
    projectId: 'project-1', phaseId: 'phase-1', parentBatchId: 'batch-1', featureId: 'feature-1', runId: 'run-1', repairId: 'repair-1', commandId: 'command-1',
    source: {
      projectId: 'project-1', phaseId: 'phase-1', parentBatchId: 'batch-1', featureId: 'feature-1', runId: 'run-1', integrationId: 'integration-1', operationId: 'operation-1', operationType: 'integration', operationDigest: DIGEST('1'), failureKind: 'conflict', evidenceId: 'evidence-1', evidenceDigest: DIGEST('2'), inputDigest: DIGEST('3'),
    },
    target: { repoIdentity: 'repo-1', baselineCommitSha: SHA, baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: 'repo-1', baselineCommitSha: SHA }) },
    workspace: { workspaceId: 'workspace-1', workspaceDigest: DIGEST('4') },
    conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts', 'test/fix.test.ts'],
    intent: { intentId: 'intent-1', digest: DIGEST('5') }, verification: { strategyId: 'verification-1', digest: DIGEST('6') },
    budget: { remainingAttempts: 1, remainingTokens: 10_000, remainingRuntimeMs: 10_000, deadlineUtcMs: 4_000_000_000_000 },
  };
}
function request(options: { readonly attemptId?: string; readonly invocationId?: string } = {}) {
  const auth = createGitAgentRepairRequest(authorization(), { nowUtcMs: 1_000 });
  return createGitAgentRuntimeRequest({ authorization: auth, claim: { projectId: auth.projectId, repairId: auth.repairId, attemptId: options.attemptId ?? 'attempt-1', ownerId: 'owner-1', hostInstanceId: 'host-1', authorizationVersion: 1 }, invocationId: options.invocationId ?? 'invocation-1', executionVersion: 1 });
}
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shiploop-git-agent-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('P05-8 F-003 GitAgent Runtime', () => {
  it('[case:git-agent-runtime-freezes-authorized-context-and-rejects-cross-attempt]', () => {
    const value = request();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.authorization)).toBe(true);
    expect(() => validateGitAgentRuntimeRequest({ ...value, execution: { ...value.execution, attemptId: 'attempt-2' } })).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'request_digest_mismatch' }) }));
    expect(() => createGitAgentRuntimeRequest({ authorization: value.authorization, claim: { projectId: 'project-2', repairId: 'repair-1', attemptId: 'attempt-1', ownerId: 'owner-1', hostInstanceId: 'host-1', authorizationVersion: 1 }, invocationId: 'invocation-1', executionVersion: 1 })).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'claim_identity_mismatch' }) }));
  });

  it('[case:fake-runtime-writes-only-authorized-candidate-and-no-change-is-deterministic]', async () => {
    const root = workspace();
    const adapter = createFakeGitAgentRuntime({ workspaceRoots: { 'workspace-1': root }, script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'src/conflict.ts', content: 'resolved' }, { op: 'verification', outputDigest: DIGEST('7'), exitCode: 0 }, { op: 'usage', consumedTokens: 12, runtimeMs: 34 }] } });
    const first = await adapter.start(request());
    const result = await first.result;
    expect(result.terminal).toBe('completed');
    expect(result.changedPaths).toEqual(['src/conflict.ts']);
    expect(result.usage).toEqual({ consumedTokens: 12, runtimeMs: 34 });
    expect(readFileSync(join(root, 'src/conflict.ts'), 'utf8')).toBe('resolved');

    const unchanged = createFakeGitAgentRuntime({ workspaceRoots: { 'workspace-1': root }, script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'src/conflict.ts', content: 'resolved' }] } });
    const second = await (await unchanged.start(request({ invocationId: 'invocation-2' }))).result;
    expect(second.terminal).toBe('no_change');
    expect(second.changedPaths).toEqual([]);
  });

  it('[case:fake-runtime-rejects-invalid-out-of-scope-and-protected-files]', async () => {
    const root = workspace();
    const invalid = createFakeGitAgentRuntime({ workspaceRoots: { 'workspace-1': root }, script: { schemaVersion: 1, steps: [{ op: 'fail', classification: 'invalid', code: 'invalid_repair' }] } });
    expect((await (await invalid.start(request())).result).terminal).toBe('invalid');
    const escaped = createFakeGitAgentRuntime({ workspaceRoots: { 'workspace-1': root }, script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'metadata/state.json', content: 'bad' }] } });
    const escapedResult = await (await escaped.start(request())).result;
    expect(escapedResult.failure).toEqual({ classification: 'out_of_scope', code: 'protected_path' });
    expect(escapedResult.changedPaths).toEqual([]);
  });

  it('[case:supervision-distinguishes-cancel-timeout-process-exit-and-unconfirmed-stop]', async () => {
    const root = workspace();
    const gate = createGitAgentRuntimeGate();
    const cancelling = createFakeGitAgentRuntime({ workspaceRoots: { 'workspace-1': root }, gates: { hold: gate }, script: { schemaVersion: 1, steps: [{ op: 'await_gate', name: 'hold' }] } });
    const cancelHandle = await cancelling.start(request({ invocationId: 'cancel' }));
    await cancelHandle.cancel();
    expect((await cancelHandle.result).terminal).toBe('cancelled');

    const timed = createFakeGitAgentRuntime({ workspaceRoots: { 'workspace-1': root }, gates: { hold: createGitAgentRuntimeGate() }, maxRuntimeMs: 1_000, script: { schemaVersion: 1, steps: [{ op: 'await_gate', name: 'hold' }] } });
    const timedOut = await superviseGitAgentRuntime(timed, request({ invocationId: 'timeout' }), { timeoutMs: 20, stopWaitMs: 100 });
    expect(timedOut.control).toBe('timed_out');
    expect(timedOut.result.terminal).toBe('cancelled');

    const processExit = createFakeGitAgentRuntime({ workspaceRoots: { 'workspace-1': root }, script: { schemaVersion: 1, steps: [{ op: 'process_exit', code: 'runner_exited' }] } });
    const exited = await superviseGitAgentRuntime(processExit, request({ invocationId: 'process' }));
    expect(exited.result.terminal).toBe('failed');
    expect(exited.result.failure?.code).toBe('runner_exited');

    const uncertain = createFakeGitAgentRuntime({ workspaceRoots: { 'workspace-1': root }, script: { schemaVersion: 1, stopUnconfirmed: true, steps: [{ op: 'no_change' }] } });
    const stoppedUnknown = await superviseGitAgentRuntime(uncertain, request({ invocationId: 'uncertain' }));
    expect(stoppedUnknown.isolated).toBe(true);
    expect(stoppedUnknown.candidateDelivered).toBe(false);
  });

  it('[case:pi-candidate-receives-validated-envelope-without-core-capability]', async () => {
    let received: unknown;
    const base = createFakeGitAgentRuntime({ workspaceRoots: { 'workspace-1': workspace() }, script: { schemaVersion: 1, steps: [{ op: 'no_change' }] } });
    const adapter = createPiGitAgentRuntimeAdapter({ driver: { start: async value => { received = value; return base.start(value); } } });
    await (await adapter.start(request())).result;
    expect(received).toMatchObject({ authorization: { repairId: 'repair-1', target: { baselineCommitSha: SHA }, verification: { strategyId: 'verification-1' } }, execution: { attemptId: 'attempt-1' } });
  });
});
