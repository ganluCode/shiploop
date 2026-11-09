import { describe, expect, it, vi } from 'vitest';
import { createGitAgentCandidateFinalizationService, gitAgentRepairCommitOperationId,
  type GitAgentCandidateFinalizationDependencies } from '../../../packages/core/src/application/git-agent-candidate-finalization.ts';
import type { GitAgentRepairView } from '../../../packages/core/src/ports/git-agent-repair-store.ts';
import type { WorkspaceInspection } from '../../../packages/core/src/ports/workspace-inspector.ts';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
function fixture() {
  const baseline = { repositoryBindingId: 'binding-1', repositoryBindingRevision: 1, repoIdentity: 'repo-1',
    canonicalPath: '/managed/integration', gitCommonDir: '/managed/repo/.git', branch: 'integration', baseCommit: sha };
  const view = { request: { projectId: 'project-1', repairId: 'repair-1', target: { repoIdentity: 'repo-1', baselineCommitSha: sha },
    writablePaths: ['src/a.ts'], source: { inputDigest: digest } }, blockedReason: null,
    attempts: [{ id: 'attempt-1', stoppedAtUtcMs: 2, output: { schemaVersion: 1, repairId: 'repair-1', status: 'modified',
      changedPaths: ['src/a.ts'], usage: { consumedTokens: 1, runtimeMs: 1 }, failureCode: null } }] } as unknown as GitAgentRepairView;
  const inspection = { complete: true, repository: { ...baseline, headCommit: sha },
    statusPorcelainBase64: Buffer.from(' M src/a.ts\0').toString('base64'),
    contents: { tracked: [{ path: 'src/a.ts', state: 'present', digest, mode: 420 }], untracked: [], ignored: [], directories: [] },
  } as unknown as WorkspaceInspection;
  const facts = { head: sha, tree: sha, parents: [], message: 'base', author: { name: 'User', email: 'user@example.com' }, committer: { name: 'User', email: 'user@example.com' } };
  const hold = vi.fn(); const commit = vi.fn(async () => ({ status: 'pending', reasonCode: null })); const verify = vi.fn(async () => ({ outcome: 'passed' as const,
    evidence: { kind: 'verification_result' as const, id: 'result-1', digest }, reason: null, hold: null }));
  const deps = { repair: { read: () => view, hold }, inspector: { inspect: vi.fn(async () => inspection) },
    driver: { open: () => ({ facts: async () => facts, isAncestor: async () => true }) }, readBaseline: () => baseline,
    readAuthorization: vi.fn(() => ({ intent: { operationId: gitAgentRepairCommitOperationId('repair-1'), projectId: 'project-1', operationType: 'feature_final_commit', repoIdentity: 'repo-1', expectedHead: sha, worktreePath: baseline.canonicalPath,
      verificationRefs: [{ kind: 'verification_result', id: 'result-1', digest }] }, baseline, allowedPaths: ['src/a.ts'], verificationPassed: true, approvalCurrent: true, commitAuthorized: true })), verify, commit: { commit }, operations: { getGitOperation: vi.fn(() => null) },
  } as unknown as GitAgentCandidateFinalizationDependencies;
  return { view, inspection, facts, deps, hold, commit, verify, request: { projectId: 'project-1', repairId: 'repair-1', attemptId: 'attempt-1' } };
}

describe('DAG F-011 candidate safety', () => {
  it('[case:candidate-bytes-change-during-verification] rejects changed bytes at the same path before authorizing a commit', async () => {
    const f = fixture();
    vi.mocked(f.deps.inspector.inspect).mockResolvedValueOnce(f.inspection).mockResolvedValueOnce({ ...f.inspection,
      contents: { ...f.inspection.contents, tracked: f.inspection.contents.tracked.map(entry => ({ ...entry, digest: 'c'.repeat(64) })) } });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.request)).toMatchObject({ outcome: 'blocked', reason: 'candidate_changed_during_verification', successorUnlocked: false });
    expect(f.deps.readAuthorization).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it('[case:candidate-stop-unconfirmed-hold] a missing stop fact persists isolation before inspection', async () => {
    const f = fixture(); Object.assign(f.view.attempts[0]!, { stoppedAtUtcMs: null });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.request)).toMatchObject({ outcome: 'blocked', reason: 'candidate_not_stopped' });
    expect(f.hold).toHaveBeenCalledWith('project-1', 'repair-1', 'stop_unconfirmed'); expect(f.deps.inspector.inspect).not.toHaveBeenCalled();
  });
  it('[case:candidate-inspection-error-hold] inspection failure cannot escape as an unstructured success or leak a path', async () => {
    const f = fixture(); vi.mocked(f.deps.inspector.inspect).mockRejectedValue(new Error('/private/credential-body'));
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.request)).toMatchObject({ outcome: 'blocked', reason: 'candidate_verification_unavailable', successorUnlocked: false });
    expect(f.hold).toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it.each(['rename', 'delete'] as const)('[case:candidate-high-risk-%s] preserves high risk workspace changes', async kind => {
    const f = fixture(); Object.assign(f.inspection, { statusPorcelainBase64: Buffer.from(kind === 'rename' ? 'R  src/a.ts\0src/old.ts\0' : ' D src/a.ts\0').toString('base64') });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.request)).toMatchObject({ outcome: 'blocked', successorUnlocked: false });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it('[case:candidate-failed-output-cannot-claim-modified] a contradictory failureCode blocks a modified runtime output', async () => {
    const f = fixture(); Object.assign(f.view.attempts[0]!.output!, { failureCode: 'process_exited' });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.request)).toMatchObject({ outcome: 'blocked', reason: 'runtime_not_successful' });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it('[case:candidate-replay-preserves-human-hold] an existing succeeded operation cannot bypass a later human hold', async () => {
    const f = fixture(); Object.assign(f.view, { blockedReason: 'requirements_tradeoff' });
    vi.mocked(f.deps.operations.getGitOperation).mockReturnValue({ status: 'succeeded', actualCommit: sha, actualTree: sha,
      intent: { operationId: gitAgentRepairCommitOperationId('repair-1'), message: 'repair', expectedHead: sha, gitIdentity: f.facts.author } } as never);
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.request)).toMatchObject({ outcome: 'blocked', reason: 'requirements_tradeoff', successorUnlocked: false });
    expect(f.commit).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  });
});
