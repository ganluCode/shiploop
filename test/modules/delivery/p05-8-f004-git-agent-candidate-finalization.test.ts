import { createHash } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitAgentCandidateFinalizationService, gitAgentRepairCommitOperationId } from '../../../packages/core/src/application/git-agent-candidate-finalization.ts';
import { createControlledGitCommitService } from '../../../packages/core/src/application/controlled-git-commit.ts';
import { createGitCommitReconciliationService } from '../../../packages/core/src/application/git-commit-reconciliation.ts';
import type { GitCommitAuthorization } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import type { GitAgentRepairView } from '../../../packages/core/src/ports/git-agent-repair-store.ts';
import { gitCommitFixture } from '../../helpers/controlled-git-commit.ts';
import { git } from '../../helpers/git-repo.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(status: 'modified' | 'no_change' = 'modified') {
  const f = await gitCommitFixture();
  cleanups.push(() => f.box.close());
  const repairId = 'repair-1';
  const operationId = gitAgentRepairCommitOperationId(repairId);
  const request = {
    projectId: f.box.projectId, repairId, target: { repoIdentity: f.baseline.repoIdentity, baselineCommitSha: f.baseline.baseCommit },
    writablePaths: ['source.ts'], verification: { strategyId: 'combined-checks', digest: digest('strategy') },
  } as never;
  const output = { schemaVersion: 1 as const, repairId, status, changedPaths: status === 'modified' ? ['source.ts'] : [],
    usage: { consumedTokens: 3, runtimeMs: 4 }, failureCode: null };
  const view = {
    receipt: { repairId, parentBatchId: 'batch-1', runId: 'run-1', authorizationDigest: digest('authorization'), blockedReason: null },
    request, authorizationVersion: 1, blockedReason: null,
    attempts: [{ id: 'attempt-1', repairId, projectId: f.box.projectId, runId: 'run-1', ownerId: 'owner-1', hostInstanceId: 'host-1',
      authorizationVersion: 1, dispatch: {} as never, startedAtUtcMs: 1, deadlineUtcMs: Date.now() + 10_000, maxTokens: 10, maxRuntimeMs: 10_000,
      output, stoppedAtUtcMs: 2 }],
  } as unknown as GitAgentRepairView;
  let authorization = { ...f.authorization, intent: { ...f.authorization.intent, operationId,
    operationType: 'feature_final_commit' as const, verificationRefs: [{ kind: 'verification_result' as const, id: 'verification-1', digest: digest('verification') }],
    expectedHead: f.baseline.baseCommit }, allowedPaths: output.changedPaths, verificationPassed: true, approvalCurrent: true, commitAuthorized: true } as GitCommitAuthorization;

  f.authorization = authorization;
  const held: string[] = [];
  let lastInspection: Awaited<ReturnType<typeof f.inspector.inspect>> | null = null;
  const service = createGitAgentCandidateFinalizationService({
    repair: { read: () => view, hold: (_projectId, _repairId, reason) => { held.push(reason); return view; } },
    inspector: f.inspector,
    driver: f.deps.driver,
    readBaseline: () => f.baseline,
    readAuthorization: () => f.authorization,
    verify: async input => {
      lastInspection = input.inspection;
      expect(input.request.repairId).toBe(repairId);
      return { outcome: 'passed', evidence: { kind: 'verification_result', id: 'verification-1', digest: digest('verification') }, reason: null, hold: null };
    },
    commit: createControlledGitCommitService(f.deps),
    operations: f.store,
    reconciliation: createGitCommitReconciliationService({ ...f.deps, readVerificationInspection: () => lastInspection }),
  });
  return { f, service, operationId, authorization, setAuthorization(value: GitCommitAuthorization) { authorization = value; }, held };
}

describe('P05-8 F-004 GitAgent candidate finalization', () => {
  it('[case:git-agent-candidate-verified-commit] Core verifies the real candidate and creates one controlled operation', async () => {
    const f = await fixture();
    writeFileSync(join(f.f.root, 'source.ts'), 'candidate repair\n');
    await f.f.recapture();
    const first = await f.service.finalize({ projectId: f.f.box.projectId, repairId: 'repair-1', attemptId: 'attempt-1' });
    expect(first).toMatchObject({ outcome: 'committed', operation: { status: 'succeeded', deliveryStatus: 'succeeded' } });
    expect(git(['rev-parse', 'HEAD^'], f.f.root).trim()).toBe(f.f.baseline.baseCommit);
    expect(git(['rev-list', '--count', 'HEAD'], f.f.root).trim()).toBe('2');
    const second = await f.service.finalize({ projectId: f.f.box.projectId, repairId: 'repair-1', attemptId: 'attempt-1' });
    expect(second).toEqual(first);
    expect(git(['rev-list', '--count', 'HEAD'], f.f.root).trim()).toBe('2');
    expect(f.held).toEqual([]);
  });

  it('[case:git-agent-candidate-scope-is-rechecked] a changed path outside the Runtime result is retained and never committed', async () => {
    const f = await fixture();
    writeFileSync(join(f.f.root, 'README.md'), 'out of scope\n');
    const result = await f.service.finalize({ projectId: f.f.box.projectId, repairId: 'repair-1', attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'candidate_scope_mismatch' });
    expect(git(['rev-parse', 'HEAD'], f.f.root).trim()).toBe(f.f.baseline.baseCommit);
    expect(f.f.box.session.database.prepare('SELECT COUNT(*) AS n FROM git_operations WHERE id = ?').get(f.operationId)).toEqual({ n: 0 });
    expect(f.held).toEqual(['out_of_scope']);
  });

  it('[case:git-agent-candidate-verification-is-core-owned] a failed fixed verification blocks the candidate without Git writes', async () => {
    const f = await fixture();
    writeFileSync(join(f.f.root, 'source.ts'), 'candidate repair\n');
    f.service = createGitAgentCandidateFinalizationService({
      repair: { read: () => ({
        ...({} as GitAgentRepairView), request: { repairId: 'repair-1', projectId: f.f.box.projectId, target: { repoIdentity: f.f.baseline.repoIdentity, baselineCommitSha: f.f.baseline.baseCommit }, writablePaths: ['source.ts'], verification: { strategyId: 'combined-checks', digest: digest('strategy') } },
        blockedReason: null, attempts: [{ id: 'attempt-1', output: { schemaVersion: 1, repairId: 'repair-1', status: 'modified', changedPaths: ['source.ts'], usage: { consumedTokens: 1, runtimeMs: 1 }, failureCode: null }, stoppedAtUtcMs: 2 }],
      } as unknown as GitAgentRepairView), hold: (_p, _r, reason) => { f.held.push(reason); return {} as never; } },
      inspector: f.f.inspector, driver: f.f.deps.driver, readBaseline: () => f.f.baseline, readAuthorization: () => f.authorization,
      verify: async () => ({ outcome: 'failed', evidence: { kind: 'verification_result', id: 'verification-1', digest: digest('verification') }, reason: 'verification_failed', hold: null }),
      commit: createControlledGitCommitService(f.f.deps), operations: f.f.store,
    });
    const result = await f.service.finalize({ projectId: f.f.box.projectId, repairId: 'repair-1', attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'verification_failed' });
    expect(git(['rev-parse', 'HEAD'], f.f.root).trim()).toBe(f.f.baseline.baseCommit);
    expect(f.f.box.session.database.prepare('SELECT COUNT(*) AS n FROM git_operations WHERE id = ?').get(f.operationId)).toEqual({ n: 0 });
  });

  it('[case:git-agent-candidate-high-risk-delete] deletion is retained for human review before any operation intent is created', async () => {
    const f = await fixture();
    unlinkSync(join(f.f.root, 'source.ts'));
    await f.f.recapture();
    const result = await f.service.finalize({ projectId: f.f.box.projectId, repairId: 'repair-1', attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'high_risk_delete' });
    expect(f.held).toEqual(['high_risk_delete']);
    expect(f.f.box.session.database.prepare('SELECT COUNT(*) AS n FROM git_operations WHERE id = ?').get(f.operationId)).toEqual({ n: 0 });
  });

  it('[case:git-agent-candidate-head-drift] target head drift blocks the candidate without resetting the workspace', async () => {
    const f = await fixture();
    writeFileSync(join(f.f.root, 'source.ts'), 'candidate repair\n');
    await f.f.recapture();
    git(['-c', 'user.name=External User', '-c', 'user.email=external@example.com', 'commit', '--allow-empty', '-m', 'external progress'], f.f.root);
    const result = await f.service.finalize({ projectId: f.f.box.projectId, repairId: 'repair-1', attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'head_drift' });
    expect(f.held).toEqual(['identity_or_lock']);
    expect(git(['rev-list', '--count', 'HEAD'], f.f.root).trim()).toBe('2');
  });

  it('[case:git-agent-candidate-pending-is-reconciled] an interrupted commit remains pending and is never replayed blindly', async () => {
    const f = await fixture();
    writeFileSync(join(f.f.root, 'source.ts'), 'candidate repair\n');
    await f.f.recapture();
    f.f.beforeCommit(() => { throw new Error('commit_interrupted'); });
    const first = await f.service.finalize({ projectId: f.f.box.projectId, repairId: 'repair-1', attemptId: 'attempt-1' });
    expect(first).toMatchObject({ outcome: 'pending', operation: { status: 'pending' } });
    const second = await f.service.finalize({ projectId: f.f.box.projectId, repairId: 'repair-1', attemptId: 'attempt-1' });
    expect(second).toMatchObject({ outcome: 'pending', operation: { status: 'pending' } });
    expect(git(['rev-list', '--count', 'HEAD'], f.f.root).trim()).toBe('1');
  });

  it('[case:git-agent-candidate-no-change-does-not-unlock] no_change is a recorded terminal fact but never a successful delivery', async () => {
    const f = await fixture('no_change');
    unlinkSync(join(f.f.root, 'source.ts'));
    await f.f.recapture([]);
    const result = await f.service.finalize({ projectId: f.f.box.projectId, repairId: 'repair-1', attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'no_change', operation: { status: 'no_change', deliveryStatus: 'succeeded' }, successorUnlocked: false });
    expect(git(['rev-list', '--count', 'HEAD'], f.f.root).trim()).toBe('1');
  });
});
