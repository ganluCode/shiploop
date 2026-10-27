import { existsSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteFeatureDagStore } from '../../../packages/core/src/adapters/sqlite/feature-dag-store.ts';
import { createSqliteBatchFinalizationCandidateStore } from '../../../packages/core/src/adapters/sqlite/batch-finalization-candidate-store.ts';
import {
  createBatchLeafFinalizationService,
  type BatchFinalizationBatchSnapshot,
  type BatchFinalizationLeafEvidence,
} from '../../../packages/core/src/application/batch-leaf-finalization.ts';
import { createFeatureDagService } from '../../../packages/core/src/ports/feature-dag.ts';
import { createIntegrationGitWorkspace } from '../../../packages/core/src/adapters/fs/integration-git-workspace.ts';
import {
  createRealInputs,
  digest,
  git,
  openIntegrationFixture,
} from '../../helpers/p05-7-integration-vertical.ts';
import { BUDGET, openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

type BudgetFixture = Awaited<ReturnType<typeof openBudgetFixture>>;
type FixtureReceipt = Awaited<ReturnType<BudgetFixture['submit']>>;
type AcceptedBatchReceipt = Extract<FixtureReceipt, { readonly status: 'accepted' }> & { readonly batchId: string };
type ImportedFeature = { readonly id: string };

function acceptedBatch(receipt: FixtureReceipt): AcceptedBatchReceipt {
  expect(receipt.status, JSON.stringify(receipt)).toBe('accepted');
  if (receipt.status !== 'accepted' || !('batchId' in receipt)) throw new Error(`expected Batch receipt: ${JSON.stringify(receipt)}`);
  return receipt as AcceptedBatchReceipt;
}

async function addApprovedFeature(fixture: BudgetFixture, title: string): Promise<ImportedFeature> {
  const db = fixture.session.database;
  const phase = db.prepare<[string], { revision: number }>('SELECT revision FROM phases WHERE id = ?').get('phase-1');
  if (phase === undefined) throw new Error('phase fixture missing');
  const imported = await fixture.submit('feature.plan.import', {
    phaseId: 'phase-1',
    plan: {
      schemaVersion: 1,
      feature: { title, description: null, labels: [], sourceRefs: [] },
      tasks: [{ id: `${title}-task`, title, acceptance: { criteria: ['P05-10 normal flow'] }, dependsOn: [] }],
    },
  }, { scope: fixture.scope, expectedRevision: phase.revision });
  expect(imported.status, JSON.stringify(imported)).toBe('completed');
  if (imported.status !== 'completed') throw new Error('feature import was not completed');
  const featureId = (imported.result as { feature: { id: string } }).feature.id;
  const row = db.prepare<[string], { plan_digest: string; revision: number }>(
    'SELECT plan_digest, revision FROM features WHERE id = ?',
  ).get(featureId);
  if (row === undefined) throw new Error('imported feature missing');
  const approved = await fixture.submit('feature.plan.decide', {
    featureId,
    planDigest: row.plan_digest,
    decision: 'approve',
    reason: 'F-003 normal flow',
  }, { scope: fixture.scope, expectedRevision: row.revision });
  expect(approved.status, JSON.stringify(approved)).toBe('completed');
  return { id: featureId };
}

function addFeatureDependency(fixture: BudgetFixture, featureId: string, dependsOnId: string, id: string): void {
  fixture.session.database.prepare(
    'INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) ' +
      "VALUES (?, ?, ?, 1, ?, 'phase-1', ?, ?, NULL)",
  ).run(id, 1_900_000_100_000, fixture.projectId, 1_900_000_100_000, featureId, dependsOnId);
}

function previewMembers(preview: Awaited<ReturnType<BudgetFixture['services']['preview']['previewExecution']>>): readonly string[] {
  if (!('memberFeatureIds' in preview.scope)) throw new Error('expected a fixed P05 Batch scope');
  return preview.scope.memberFeatureIds;
}

function cleanupWorktree(repo: string, path: string): void {
  if (!existsSync(path)) return;
  try {
    git(repo, 'worktree', 'remove', '--force', path);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}

function markBatchSucceeded(fixture: Awaited<ReturnType<typeof openIntegrationFixture>>, batchId: string, runId: string): void {
  fixture.box.session.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(runId);
  fixture.box.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(batchId);
}

function leaf(featureId: string, commitSha: string, inputId: string, inputDigest: string, repoIdentity: string): BatchFinalizationLeafEvidence {
  return {
    featureId,
    featureStatus: 'completed',
    deliveryStatus: 'succeeded',
    revision: 4,
    commitSha,
    repoIdentity,
    coveredInputs: [{ inputId, digest: inputDigest }],
    evidenceId: `delivery-${featureId}`,
    evidenceDigest: digest(featureId === 'predecessor-a' ? 'd' : 'e'),
    evidenceFresh: true,
    commitExists: true,
    branchHead: commitSha,
  };
}

describe('P05-10 F-003 normal planning, dependency and fixed Batch flow', { timeout: 120_000 }, () => {
  it('[case:p05-f003-dag-fixed-batch-and-append] keeps C blocked before integration and requires a new Batch for an appended Feature', async () => {
    const fixture = await openBudgetFixture({
      ...BUDGET,
      batch: { ...BUDGET.batch, maxRuns: 3, maxTotalAttempts: 3, maxRuntimeStarts: 3 },
    });
    try {
      const featureA = fixture.featureId;
      const featureB = await addApprovedFeature(fixture, 'feature-b');
      const featureC = await addApprovedFeature(fixture, 'feature-c');
      addFeatureDependency(fixture, featureC.id, featureA, 'edge-c-a');
      addFeatureDependency(fixture, featureC.id, featureB.id, 'edge-c-b');

      const dag = createFeatureDagService({ store: createSqliteFeatureDagStore(fixture.session) });
      const beforeParentsComplete = dag.evaluate(fixture.projectId, 'phase-1');
      expect(beforeParentsComplete.readiness.find(item => item.featureId === featureC.id)).toMatchObject({
        dependencyCompletion: 'pending',
        dependencyIntegrationReady: false,
        ready: false,
        reason: 'dependency_pending',
      });

      fixture.session.database.prepare("UPDATE features SET status = 'completed' WHERE id IN (?, ?)").run(featureA, featureB.id);
      const afterParentsComplete = dag.evaluate(fixture.projectId, 'phase-1');
      expect(afterParentsComplete.readiness.find(item => item.featureId === featureC.id)).toMatchObject({
        dependencyCompletion: 'complete',
        dependencyIntegrationReady: false,
        ready: false,
        reason: 'integration_not_ready',
      });

      const firstPreview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [featureA, featureB.id],
        budget: { ...fixture.budget },
      });
      expect(firstPreview.status).toBe('ready');
      const firstMembers = previewMembers(firstPreview);
      expect(firstMembers).toEqual([featureA, featureB.id].sort());
      const started = acceptedBatch(await fixture.submit('execution.start', {
        featureIds: firstMembers,
        budget: { ...fixture.budget },
        previewDigest: firstPreview.previewDigest,
      }, { scope: fixture.scope }));

      const oldBatchFacts = fixture.session.database.prepare<[string], Record<string, unknown>>(
        'SELECT scope_snapshot, config_snapshot, budget_snapshot, deadline_at FROM execution_batches WHERE id = ?',
      ).get(started.batchId);
      expect(oldBatchFacts).toBeDefined();

      const featureD = await addApprovedFeature(fixture, 'feature-d');
      const activePreview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [featureA, featureB.id, featureD.id],
        budget: { ...fixture.budget },
      });
      expect(activePreview.status).toBe('blocked');
      expect(activePreview.blocked).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'active_batch_in_phase', batchId: started.batchId }),
      ]));
      expect(fixture.session.database.prepare<[string], { count: number }>(
        'SELECT COUNT(*) AS count FROM execution_batches WHERE project_id = ?',
      ).get(fixture.projectId)).toEqual({ count: 1 });

      fixture.session.database.prepare("UPDATE runs SET status = 'failed', reason = 'normal-flow-range-closed' WHERE batch_id = ?").run(started.batchId);
      fixture.session.database.prepare("UPDATE execution_batches SET status = 'failed', reason = 'normal-flow-range-closed' WHERE id = ?").run(started.batchId);
      const secondPreview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [featureA, featureB.id, featureD.id],
        budget: { ...fixture.budget, batch: { ...fixture.budget.batch, maxRuns: 4, maxTotalAttempts: 4, maxRuntimeStarts: 4 } },
      });
      expect(secondPreview.status).toBe('ready');
      const second = acceptedBatch(await fixture.submit('execution.start', {
        featureIds: previewMembers(secondPreview),
        budget: { ...fixture.budget, batch: { ...fixture.budget.batch, maxRuns: 4, maxTotalAttempts: 4, maxRuntimeStarts: 4 } },
        previewDigest: secondPreview.previewDigest,
      }, { scope: fixture.scope }));
      expect(second.batchId).not.toBe(started.batchId);
      expect(fixture.session.database.prepare<[string], Record<string, unknown>>(
        'SELECT scope_snapshot, config_snapshot, budget_snapshot, deadline_at FROM execution_batches WHERE id = ?',
      ).get(started.batchId)).toEqual(oldBatchFacts);
      expect(fixture.session.database.prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM execution_batches WHERE status IN ('queued', 'running', 'pausing', 'cancelling', 'paused', 'interrupted')",
      ).get()).toEqual({ count: 1 });
      expect(fixture.session.database.prepare<[string], { feature_id: string }>(
        'SELECT feature_id FROM execution_batch_members WHERE batch_id = ? ORDER BY member_ordinal',
      ).all(started.batchId)).toEqual(firstMembers.map(featureId => ({ feature_id: featureId })));
      expect(fixture.session.database.prepare<[string], { feature_id: string }>(
        'SELECT feature_id FROM execution_batch_members WHERE batch_id = ? ORDER BY member_ordinal',
      ).all(second.batchId)).toEqual(expect.arrayContaining([
        { feature_id: featureA }, { feature_id: featureB.id }, { feature_id: featureD.id },
      ]));
    } finally {
      fixture.close();
    }
  });

  it('[case:p05-f003-fixed-leaves-and-integration-evidence] preserves two independent Git results and only unlocks the successor after integration verification', async () => {
    const fixture = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(fixture);
      markBatchSucceeded(fixture, fixture.plan.batchId, fixture.plan.runId);
      const candidates = createSqliteBatchFinalizationCandidateStore(fixture.box.session, { nowUtcMs: () => 1_900_000_200_000 });
      const batch: BatchFinalizationBatchSnapshot = {
        schemaVersion: 1,
        projectId: fixture.box.projectId,
        phaseId: 'phase-1',
        batchId: fixture.plan.batchId,
        revision: 3,
        status: 'succeeded',
        approved: true,
        featureIds: ['predecessor-a', 'predecessor-b'],
        dependencies: [],
        targetBaseline: real.base,
        approvedInputs: real.inputs,
        verificationScope: ['combined-tests'],
        strategySummary: { mode: 'deterministic', mergeOrder: ['predecessor-a', 'predecessor-b'] },
      };
      let integratedCandidate: { leafFeatureIds: readonly string[]; targetBaseline: string } | undefined;
      const finalization = createBatchLeafFinalizationService({
        batches: { read: () => batch },
        leaves: { read: (_project, featureId) => featureId === 'predecessor-a'
          ? leaf(featureId, real!.shas[0]!, 'input-a', digest('a'), fixture.plan.target.repoIdentity)
          : leaf(featureId, real!.shas[1]!, 'input-b', digest('b'), fixture.plan.target.repoIdentity) },
        candidates,
        integrate: async candidate => {
          integratedCandidate = { leafFeatureIds: candidate.leafFeatureIds, targetBaseline: candidate.targetBaseline };
          expect(candidate.leaves.map(item => item.commitSha)).toEqual(real!.shas);
          fixture.box.session.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(fixture.plan.runId);
          fixture.box.session.database.prepare("UPDATE execution_batches SET status = 'running' WHERE id = ?").run(fixture.plan.batchId);
          const integrated = await fixture.service(createIntegrationGitWorkspace({
            confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
          })).start(fixture.request);
          expect(integrated.outcome).toBe('pending_verification');
          const commitSha = integrated.workspace?.currentHead;
          expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
          const treeSha = git(real!.path, 'rev-parse', 'HEAD^{tree}');
          markBatchSucceeded(fixture, fixture.plan.batchId, fixture.plan.runId);
          return {
            status: 'succeeded' as const,
            commitSha: commitSha!,
            treeSha,
            evidenceId: 'f003-git-integration',
            evidenceDigest: digest('f'),
            workspacePreserved: true,
          };
        },
        verify: async (candidate, integration) => {
          expect(candidate.targetBaseline).toBe(real!.base);
          expect(integration.commitSha).toMatch(/^[0-9a-f]{40}$/);
          return { status: 'passed' as const, evidenceId: 'f003-combined-verification', evidenceDigest: digest('c') };
        },
      });

      const result = await finalization.run({ projectId: fixture.box.projectId, batchId: fixture.plan.batchId, commandId: 'f003-normal-leaves' });
      expect(result.status, JSON.stringify(result)).toBe('ready_for_phase_approval');
      expect(integratedCandidate).toEqual({
        leafFeatureIds: ['predecessor-a', 'predecessor-b'],
        targetBaseline: real.base,
      });
      expect(result.candidate?.leaves.map(item => item.commitSha)).toEqual(real.shas);
      expect(result.candidate?.integration?.status).toBe('succeeded');
      expect(result.candidate?.verification?.status).toBe('passed');
    } finally {
      if (real) cleanupWorktree(real.repo, real.path);
      fixture.close();
    }
  });
});
