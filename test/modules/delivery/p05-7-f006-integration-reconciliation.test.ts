import { describe, expect, it, vi } from 'vitest';
import { createGitIntegrationReconciliationService } from '../../../packages/core/src/application/git-integration-reconciliation.ts';
import type { GitIntegrationRecoveryAuthorization } from '../../../packages/core/src/ports/git-integration-reconciliation.ts';
import type { IntegrationExecutionObservation } from '../../../packages/core/src/ports/git-integration-journal.ts';

const sha = (letter: string) => letter.repeat(40);
const digest = (letter: string) => letter.repeat(64);

function fixture() {
  const plan = {
    schemaVersion: 1, integrationId: digest('i'), projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', runId: 'run-1',
    successorFeatureId: 'successor', status: 'dependency_passed', inputDigest: digest('p'),
    target: { baseCommit: sha('b'), repoIdentity: 'repo-1', canonicalPath: '/repo', gitCommonDir: '/repo/.git' },
    predecessors: [{ projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', runId: 'run-1', featureId: 'feature-a',
      dependencyPassed: true, coveredInputIds: ['input-a'], delivery: { commitSha: sha('c'), repoIdentity: 'repo-1',
        inputDigest: digest('a'), evidenceId: 'evidence-a', evidenceDigest: digest('e') } }],
    approvedInputs: [{ inputId: 'input-a', digest: digest('a') }], mergeOrder: ['feature-a'], verificationScope: ['combined'], integrationResult: null,
  } as const;
  const intent = {
    operationId: plan.integrationId, projectId: 'project-1', featureId: 'successor', runId: 'run-1', attemptId: null, executionVersion: 1,
    operationType: 'integration' as const, repositoryBindingId: 'binding-1', repoIdentity: 'repo-1', worktreePath: '/integration',
    expectedHead: sha('b'), candidateTree: sha('b'), codeDigest: plan.inputDigest, verificationRefs: [], approvalRefs: [], message: 'integration',
    gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true as const }, deliveryPolicyDigest: digest('d'), runtimeSource: null,
    ownerId: 'owner-1', hostInstanceId: 'host-1', integrationPlan: plan, budgetSnapshot: { ownerVersion: 1 },
  } as any;
  const operation = { intent, intentDigest: digest('o'), status: 'pending', actualCommit: null, actualTree: null, exitCode: null,
    durationMs: null, reasonCode: null, receipt: null, deliveryStatus: null, settledAtUtcMs: null, integrationResult: null,
    recoveryState: 'none', workspacePreserved: false, revision: 4, createdAtUtcMs: 1, updatedAtUtcMs: 1 } as any;
  const step = { ordinal: 1, featureId: 'feature-a', inputSha: sha('c'), parentBefore: sha('b'), parents: [sha('b'), sha('c')],
    commitSha: sha('a'), treeSha: sha('e'), status: 'succeeded' as const };
  const workspace = { workspaceId: 'workspace-1', ownerId: 'owner-1', ownerVersion: 1, path: '/integration', gitCommonDir: '/repo/.git',
    repoIdentity: 'repo-1', targetBase: sha('b'), plan, gitIdentity: intent.gitIdentity, status: 'succeeded' as const, currentHead: sha('a'),
    steps: [step], facts: { head: sha('a'), tree: sha('e'), parents: [sha('b'), sha('c')], statusPorcelain: '', unresolvedPaths: [] } };
  const state = { operation, observation: null as IntegrationExecutionObservation | null };
  const append = vi.fn((_tx: unknown, _projectId: string, _operationId: string, _revision: number, observation: IntegrationExecutionObservation) => {
    state.observation = structuredClone(observation);
  });
  const atomic = { transact: vi.fn((_name: string, callback: (tx: unknown) => unknown) => callback({
    getGitOperation: () => state.operation,
  })) };
  let authorization: GitIntegrationRecoveryAuthorization = { intent, ownerVersion: 1, approvalCurrent: true };
  const reader: any = { inspect: vi.fn(async () => ({ workspace, steps: [step], target: {
    head: sha('b'), repoIdentity: 'repo-1', gitCommonDir: '/repo/.git', statusPorcelain: '',
  } })) };
  const service = createGitIntegrationReconciliationService({
    atomic: atomic as any, reader, journal: { read: () => state.observation, append } as any,
    readAuthorization: () => authorization, verifyWriterStopped: vi.fn(async () => true), nowUtcMs: () => 10,
  });
  return { service, state, append, reader, operation, workspace, get authorization() { return authorization; }, set authorization(value: GitIntegrationRecoveryAuthorization) { authorization = value; } };
}

describe('P05-7 F-006 integration reconciliation', () => {
  it('[case:integration-commit-reused-on-recovery] reuses an exact final commit and CAS-writes one pending-verification observation', async () => {
    const f = fixture();
    const first = await f.service.reconcile({ projectId: 'project-1', operationId: f.operation.intent.operationId });
    expect(first).toMatchObject({ outcome: 'matched', reasonCode: null, operation: { status: 'pending' }, observation: { outcome: 'pending_verification' } });
    const second = await f.service.reconcile({ projectId: 'project-1', operationId: f.operation.intent.operationId });
    expect(second).toEqual(first);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.reader.inspect).toHaveBeenCalledTimes(2);
  });

  it('[case:integration-no-side-effect-stays-pending] does not invent a merge when the workspace is absent', async () => {
    const f = fixture();
    f.reader.inspect.mockResolvedValue({ workspace: null, steps: [], target: {
      head: sha('b'), repoIdentity: 'repo-1', gitCommonDir: '/repo/.git', statusPorcelain: '',
    } });
    const result = await f.service.reconcile({ projectId: 'project-1', operationId: f.operation.intent.operationId });
    expect(result).toMatchObject({ outcome: 'pending', reasonCode: 'commit_not_observed', operation: { status: 'pending' } });
    expect(f.append).not.toHaveBeenCalled();
  });

  it('[case:integration-fencing-and-stop-uncertainty] preserves the pending operation for an old writer or changed owner', async () => {
    const f = fixture();
    const verify = vi.fn(async () => false);
    const blocked = createGitIntegrationReconciliationService({
      atomic: { transact: vi.fn((_name: string, callback: (tx: unknown) => unknown) => callback({ getGitOperation: () => f.state.operation })) } as any,
      reader: f.reader, journal: { read: () => f.state.observation, append: f.append } as any,
      readAuthorization: () => f.authorization, verifyWriterStopped: verify,
    });
    await expect(blocked.reconcile({ projectId: 'project-1', operationId: f.operation.intent.operationId })).resolves.toMatchObject({ outcome: 'unknown', reasonCode: 'previous_writer_stop_unconfirmed' });
    expect(f.reader.inspect).not.toHaveBeenCalled();

    f.authorization = { ...f.authorization, ownerVersion: 2 };
    await expect(f.service.reconcile({ projectId: 'project-1', operationId: f.operation.intent.operationId })).resolves.toMatchObject({ outcome: 'blocked', reasonCode: 'authorization_changed' });
    expect(f.append).not.toHaveBeenCalled();
  });

  it('[case:integration-target-drift-retains-claim] blocks a target drift without adopting the current HEAD or releasing anything', async () => {
    const f = fixture();
    f.reader.inspect.mockResolvedValue({ workspace: f.workspace, steps: f.workspace.steps, target: {
      head: sha('z'), repoIdentity: 'repo-1', gitCommonDir: '/repo/.git', statusPorcelain: '',
    } });
    const result = await f.service.reconcile({ projectId: 'project-1', operationId: f.operation.intent.operationId });
    expect(result).toMatchObject({ outcome: 'blocked', reasonCode: 'target_head_drift', operation: { status: 'pending' } });
    expect(f.append).not.toHaveBeenCalled();
  });
});
