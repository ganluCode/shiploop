import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitCommitFixture } from '../../helpers/controlled-git-commit.ts';
import { git } from '../../helpers/git-repo.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createControlledGitCommitService } from '../../../packages/core/src/application/controlled-git-commit.ts';
import { createGitCommitReconciliationService } from '../../../packages/core/src/application/git-commit-reconciliation.ts';
import { createIntegrationExecutionPlan, computeCoveredInputDigest } from '../../../packages/core/src/ports/integration-execution-plan.ts';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import type { GitCommitAuthorization } from '../../../packages/core/src/ports/controlled-git-commit.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function conflictFixture() {
  const f = await gitCommitFixture();
  const identity = ['-c', 'user.name=Confirmed User', '-c', 'user.email=confirmed@example.com'];
  const commit = (message: string) => git([...identity, 'commit', '-am', message], f.root);
  git(['add', 'source.ts'], f.root); commit('base source');
  const base = git(['rev-parse', 'HEAD'], f.root).trim();
  const branch = f.baseline.branch;
  git(['checkout', '-b', 'repair-input'], f.root);
  writeFileSync(join(f.root, 'source.ts'), 'theirs\n'); commit('input source');
  const input = git(['rev-parse', 'HEAD'], f.root).trim();
  git(['checkout', branch], f.root);
  writeFileSync(join(f.root, 'source.ts'), 'ours\n'); commit('target source');
  const parent = git(['rev-parse', 'HEAD'], f.root).trim();
  git(['checkout', '--detach', parent], f.root);
  // A real merge failure is the fixture's intended starting state.
  expect(() => git(['merge', '--no-ff', '--no-commit', 'repair-input'], f.root)).toThrow();
  const baseline = { ...f.baseline, branch: 'HEAD', baseCommit: base };
  await expect(createWorkspaceInspector({ authorizedRoots: [f.root],
    confirmProcessIdentity: async value => ({ launchId: value.launchId }) }).inspect(baseline)).rejects.toMatchObject({ reason: 'invalid_input' });
  const inspector = createWorkspaceInspector({ authorizedRoots: [f.root], integrationRepair: true,
    confirmProcessIdentity: async value => ({ launchId: value.launchId }) });
  const before = await inspector.inspect(baseline);
  expect(before.conflictMarkerPaths).toEqual(['source.ts']);
  expect(Buffer.from(before.statusPorcelainBase64, 'base64').toString()).toContain('UU source.ts');
  writeFileSync(join(f.root, 'source.ts'), 'resolved with both intentions\n');
  const verified = await inspector.inspect(baseline);
  expect(verified.conflictMarkerPaths).toEqual([]);
  const approvedInputs = [{ inputId: 'input-1', digest: digest('input') }];
  const plan = createIntegrationExecutionPlan({ projectId: f.box.projectId, phaseId: 'phase-1', batchId: 'batch-1',
    runId: f.authorization.intent.runId, successorFeatureId: f.box.featureId,
    target: { baseCommit: base, repoIdentity: baseline.repoIdentity, canonicalPath: f.root, gitCommonDir: baseline.gitCommonDir },
    predecessors: [{ projectId: f.box.projectId, phaseId: 'phase-1', batchId: 'batch-1', runId: f.authorization.intent.runId,
      featureId: 'input-feature', dependencyPassed: true, coveredInputIds: ['input-1'], delivery: { commitSha: input,
        repoIdentity: baseline.repoIdentity, inputDigest: computeCoveredInputDigest(approvedInputs), evidenceId: 'delivery-1', evidenceDigest: digest('delivery') } }],
    approvedInputs, mergeOrder: ['input-feature'], verificationScope: ['combined-check'], integrationResult: null });
  const refs = { planRef: { id: 'verification-plan', digest: digest('plan') }, resultRef: { id: 'verification-result', digest: digest('result') } };
  f.authorization = { ...f.authorization, baseline, intent: { ...f.authorization.intent, operationId: plan.integrationId,
    operationType: 'integration_commit', integrationPlan: plan, expectedHead: parent,
    codeDigest: verificationCodeIdentity(verified).codeDigest, verificationRefs: [{ kind: 'verification_result', ...refs.resultRef }, { kind: 'artifact', ...refs.planRef }],
    budgetSnapshot: { sourcePlanId: 'source-plan', gitAgentRepair: { repairId: 'repair-1', authorizationDigest: digest('auth'),
      sourceOperationId: digest('source-operation'), sourceInputDigest: digest('source-input'), parents: [parent, input], verification: refs } } } } satisfies GitCommitAuthorization;
  const deps = { ...f.deps, inspector };
  return { f, baseline, parent, input, plan, before, verified, service: createControlledGitCommitService(deps),
    reconciliation: createGitCommitReconciliationService({ ...deps, readVerificationInspection: () => verified }) };
}

describe('DAG F-011 real conflict controlled commit', () => {
  it('[case:repair-real-conflict-commit] Core stages resolved bytes and commits the exact two parents without changing Feature delivery', async () => {
    const { f, parent, input, plan, service } = await conflictFixture();
    const before = f.box.session.database.prepare('SELECT delivery_status, revision FROM features WHERE id = ?').get(f.box.featureId);
    const operation = await service.commit({ projectId: f.box.projectId, operationId: plan.integrationId });
    expect(operation).toMatchObject({ status: 'succeeded', deliveryStatus: 'not_requested', integrationResult: { integrationId: plan.integrationId, inputDigest: plan.inputDigest } });
    expect(git(['show', '-s', '--format=%P', 'HEAD'], f.root).trim().split(' ')).toEqual([parent, input]);
    expect(f.box.session.database.prepare('SELECT delivery_status, revision FROM features WHERE id = ?').get(f.box.featureId)).toEqual(before);
    expect(await service.commit({ projectId: f.box.projectId, operationId: plan.integrationId })).toEqual(operation);
  });
  it('[case:repair-real-lost-receipt] reconciliation observes the existing merge repair and never commits again', async () => {
    const { f, plan, service, reconciliation } = await conflictFixture();
    f.afterCommit(() => { throw new Error('receipt_interrupted'); });
    await expect(service.commit({ projectId: f.box.projectId, operationId: plan.integrationId })).rejects.toThrow('receipt_interrupted');
    const head = git(['rev-parse', 'HEAD'], f.root).trim();
    expect(f.store.getGitOperation(f.box.projectId, plan.integrationId).status).toBe('pending');
    const restored = await reconciliation.reconcile({ projectId: f.box.projectId, operationId: plan.integrationId });
    expect(restored).toMatchObject({ outcome: 'matched', operation: { status: 'succeeded', actualCommit: head, deliveryStatus: 'not_requested' } });
    expect(await service.commit({ projectId: f.box.projectId, operationId: plan.integrationId })).toEqual(restored.operation);
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(head);
  });
});
