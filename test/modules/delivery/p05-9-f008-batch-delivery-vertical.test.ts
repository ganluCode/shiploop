import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIntegrationGitWorkspace } from '../../../packages/core/src/adapters/fs/integration-git-workspace.ts';
import { createSqliteBatchFinalizationCandidateStore } from '../../../packages/core/src/adapters/sqlite/batch-finalization-candidate-store.ts';
import { createSqlitePhaseDeliveryApprovalStore } from '../../../packages/core/src/adapters/sqlite/phase-delivery-approval-store.ts';
import {
  createBatchLeafFinalizationService,
  type BatchFinalizationBatchSnapshot,
  type BatchFinalizationCandidate,
  type BatchFinalizationLeafEvidence,
} from '../../../packages/core/src/application/batch-leaf-finalization.ts';
import { createPhaseDeliveryApprovalService } from '../../../packages/core/src/application/phase-delivery-approval.ts';
import {
  createRealInputs,
  digest,
  git,
  openIntegrationFixture,
} from '../../helpers/p05-7-integration-vertical.ts';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

function snapshot(projectId: string, batchId: string, overrides: Partial<BatchFinalizationBatchSnapshot> = {}): BatchFinalizationBatchSnapshot {
  return {
    schemaVersion: 1,
    projectId,
    phaseId: 'phase-1',
    batchId,
    revision: 3,
    status: 'succeeded',
    approved: true,
    featureIds: ['feature-a', 'feature-b'],
    dependencies: [],
    targetBaseline: SHA('b'),
    approvedInputs: [
      { inputId: 'input-a', digest: DIGEST('a') },
      { inputId: 'input-b', digest: DIGEST('b') },
    ],
    verificationScope: ['combined-tests'],
    strategySummary: { mode: 'deterministic' },
    ...overrides,
  };
}

function leaf(
  featureId: string,
  letter: string,
  overrides: Partial<BatchFinalizationLeafEvidence> = {},
): BatchFinalizationLeafEvidence {
  return {
    featureId,
    featureStatus: 'completed',
    deliveryStatus: 'succeeded',
    revision: 4,
    commitSha: SHA(letter),
    repoIdentity: 'repo-1',
    coveredInputs: [{ inputId: `input-${letter}`, digest: DIGEST(letter) }],
    evidenceId: `delivery-${featureId}`,
    evidenceDigest: DIGEST(letter),
    evidenceFresh: true,
    commitExists: true,
    branchHead: SHA(letter),
    ...overrides,
  };
}

function markBatchSucceeded(f: Awaited<ReturnType<typeof openBudgetFixture>>, batchId: string, runId: string): void {
  f.session.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(runId);
  f.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(batchId);
}

function removeWorktree(repo: string, path: string): void {
  if (!existsSync(path)) return;
  try { git(repo, 'worktree', 'remove', '--force', path); }
  catch { rmSync(path, { recursive: true, force: true }); }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('P05-9 F-008 Batch delivery vertical acceptance', { timeout: 120_000 }, () => {
  it('[case:vertical-leaves-approval-and-fixed-next-range] freezes two real Git leaves, verifies a controlled process, approves the exact SQLite summary, and keeps the old scope closed', async () => {
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f);
      const base = real.base;
      const initialHead = git(real.repo, 'rev-parse', 'HEAD');
      const initialRefs = git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
      markBatchSucceeded(f.box, f.plan.batchId, f.plan.runId);
      const candidates = createSqliteBatchFinalizationCandidateStore(f.box.session, { nowUtcMs: () => 1_900_000_200_000 });
      const marker = join(f.box.box.root, 'f008-verification.marker');
      let verificationCandidate: BatchFinalizationCandidate | null = null;
      let nextRangeStarted = false;
      const finalization = createBatchLeafFinalizationService({
        batches: { read: () => snapshot(f.box.projectId, f.plan.batchId, { targetBaseline: base, featureIds: ['predecessor-a', 'predecessor-b'], approvedInputs: real!.inputs }) },
        leaves: { read: (_project, featureId) => leaf(featureId, featureId === 'predecessor-a' ? 'a' : 'b', {
          commitSha: real!.shas[featureId === 'predecessor-a' ? 0 : 1],
          branchHead: real!.shas[featureId === 'predecessor-a' ? 0 : 1],
          repoIdentity: f.plan.target.repoIdentity,
        }) },
        candidates,
        integrate: async candidate => {
          // A later range is deliberately not started until this candidate has a fixed integration result.
          expect(candidate.integration).toBeNull();
          f.box.session.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(f.plan.runId);
          f.box.session.database.prepare("UPDATE execution_batches SET status = 'running' WHERE id = ?").run(f.plan.batchId);
          const integrated = await f.service(createIntegrationGitWorkspace({
            confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
          })).start(f.request);
          expect(integrated.outcome).toBe('pending_verification');
          const commitSha = integrated.workspace?.currentHead;
          expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
          const treeSha = git(real!.path, 'rev-parse', 'HEAD^{tree}');
          f.box.session.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(f.plan.runId);
          f.box.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(f.plan.batchId);
          return {
            status: 'succeeded' as const,
            commitSha: commitSha!,
            treeSha,
            evidenceId: 'real-git-integration',
            evidenceDigest: DIGEST('e'),
            workspacePreserved: true,
          };
        },
        verify: async (candidate, integration) => {
          verificationCandidate = candidate;
          expect(integration.commitSha).toMatch(/^[0-9a-f]{40}$/);
          const childResult = spawnSync(process.execPath, ['-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'verified\\n');`], {
            cwd: real!.path,
            encoding: 'utf8',
            stdio: 'pipe',
          });
          expect(childResult.status, childResult.stderr).toBe(0);
          expect(readFileSync(marker, 'utf8')).toBe('verified\n');
          nextRangeStarted = true;
          return { status: 'passed' as const, evidenceId: 'real-process-verification', evidenceDigest: sha256File(marker) };
        },
      });

      const result = await finalization.run({ projectId: f.box.projectId, batchId: f.plan.batchId, commandId: 'f008-real-delivery' });
      expect(result.status).toBe('ready_for_phase_approval');
      expect(nextRangeStarted).toBe(true);
      expect(verificationCandidate?.integration?.commitSha).toMatch(/^[0-9a-f]{40}$/);
      const candidate = candidates.read(f.box.projectId, f.plan.batchId, 'f008-real-delivery')!;
      expect(candidate.leafFeatureIds).toEqual(['predecessor-a', 'predecessor-b']);
      expect(candidate.targetBaseline).toBe(base);
      expect(candidate.workspacePreserved).toBe(true);

      const approvals = createSqlitePhaseDeliveryApprovalStore(f.box.session, { nowUtcMs: () => 1_900_000_300_000 });
      const approvalService = createPhaseDeliveryApprovalService({
        approvals,
        snapshots: { read: () => ({
          candidate,
          batch: {
            projectId: f.box.projectId,
            phaseId: 'phase-1',
            batchId: f.plan.batchId,
            revision: 3,
            status: 'succeeded',
            approved: true,
            scopeDigest: candidate.scopeDigest,
            inputDigest: candidate.inputDigest,
            budgetSummary: { budgetRevision: 1, attemptsUsed: 1, deadlineAt: 1_900_000_000_000 },
            stopSummary: { status: 'confirmed', digest: DIGEST('q') },
            codeSummary: { targetBaseline: base, integrationCommit: candidate.integration!.commitSha, treeSha: candidate.integration!.treeSha },
            planSummary: { planDigest: DIGEST('p'), featureIds: candidate.leafFeatureIds },
            manualBlock: false,
          },
        }) },
      });
      const approved = await approvalService.approve({
        projectId: f.box.projectId,
        phaseId: 'phase-1',
        batchId: f.plan.batchId,
        candidateId: candidate.candidateId,
        commandId: 'f008-phase-approval',
        actorId: 'owner-1',
        expectedBatchRevision: 3,
        expectedCandidateRevision: candidate.revision,
      });
      expect(approved.status).toBe('approved');
      expect(approved.approval?.leafCommitShas).toEqual(candidate.leaves.map(item => item.commitSha));
      expect(f.box.session.database.prepare('SELECT delivery_status, delivery_candidate_id, delivery_batch_id FROM phases WHERE id = ?').get('phase-1')).toMatchObject({
        delivery_status: 'approved', delivery_candidate_id: candidate.candidateId, delivery_batch_id: f.plan.batchId,
      });
      expect(f.box.session.database.prepare('SELECT status FROM phase_delivery_candidates WHERE id = ?').get(candidate.candidateId)).toEqual({ status: 'ready_for_phase_approval' });
      expect(git(real.repo, 'rev-parse', 'HEAD')).toBe(initialHead);
      expect(git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(initialRefs);
      expect(git(real.repo, 'remote')).toBe('');
      const evidenceDir = process.env.SHIPLOOP_F008_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(join(evidenceDir, 'vertical-delivery.json'), JSON.stringify({
          schemaVersion: 1,
          taskId: 'F-008',
          testedCommit: git(process.cwd(), 'rev-parse', 'HEAD'),
          input: { targetBaseline: base, leafCommitShas: real.shas },
          commands: [
            { argv: ['git', 'worktree', 'add', '--detach'], exitCode: 0 },
            { argv: [process.execPath, '-e', 'controlled verification process'], exitCode: 0 },
          ],
          sqlite: {
            candidateId: candidate.candidateId,
            candidateStatus: 'ready_for_phase_approval',
            approvalStatus: 'approved',
            phaseDeliveryStatus: 'approved',
          },
          sideEffects: { targetHeadBefore: initialHead, targetHeadAfter: git(real.repo, 'rev-parse', 'HEAD'), remoteRefsChanged: false, nextRangeStarted },
          notRun: ['main merge', 'remote push', 'live provider/model', 'Phase full acceptance'],
          manualBlock: '负责人批准仍是独立门槛；本地脚本通过不能覆盖人工阻塞',
        }, null, 2) + '\\n', { mode: 0o600 });
      }
    } finally {
      if (real) removeWorktree(real.repo, real.path);
      f.close();
    }
  });

  it('[case:vertical-failed-leaf-and-conflict-manual-block] leaves failed or conflicting parallel work blocked in durable SQLite without creating an approval candidate', async () => {
    const f = await openBudgetFixture();
    try {
      const candidates = createSqliteBatchFinalizationCandidateStore(f.session, { nowUtcMs: () => 1_900_000_210_000 });
      const failed = createBatchLeafFinalizationService({
        batches: { read: () => snapshot(f.projectId, 'batch-failed') },
        leaves: { read: (_project, featureId) => featureId === 'feature-a' ? leaf(featureId, 'a', { featureStatus: 'failed', deliveryStatus: 'failed' }) : leaf(featureId, 'b') },
        candidates,
      });
      const blocked = await failed.prepare({ projectId: f.projectId, batchId: 'batch-failed', commandId: 'f008-failed-leaf' });
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockReasons).toEqual(expect.arrayContaining(['feature_failed:feature-a', 'delivery_not_succeeded:feature-a']));
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM phase_delivery_candidates').get()).toEqual({ count: 0 });

      const conflict = createBatchLeafFinalizationService({
        batches: { read: () => snapshot(f.projectId, 'batch-conflict') },
        leaves: { read: (_project, featureId) => leaf(featureId, featureId === 'feature-a' ? 'a' : 'b', { conflictReason: featureId === 'feature-a' ? 'merge_conflict' : null }) },
        candidates,
      });
      const manual = await conflict.prepare({ projectId: f.projectId, batchId: 'batch-conflict', commandId: 'f008-manual-block' });
      expect(manual).toMatchObject({ status: 'blocked', candidate: null });
      expect(manual.blockReasons).toContain('unresolved_conflict:feature-a');
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM phase_delivery_candidates').get()).toEqual({ count: 0 });
    } finally { f.close(); }
  });

  it('[case:vertical-integration-interruption-and-authorized-repair-failure] retains reconciliation and verification failure facts, process exit codes, and preserved workspace evidence', async () => {
    const f = await openBudgetFixture();
    try {
      const started = await f.start();
      markBatchSucceeded(f, started.batchId, started.runId);
      const candidates = createSqliteBatchFinalizationCandidateStore(f.session, { nowUtcMs: () => 1_900_000_220_000 });
      const leaves = { read: (_project: string, featureId: string) => leaf(featureId, featureId === 'feature-a' ? 'a' : 'b') };
      const interruptionMarker = join(f.box.root, 'f008-interrupted.marker');
      const interrupted = createBatchLeafFinalizationService({
        batches: { read: () => snapshot(f.projectId, started.batchId) }, leaves, candidates,
        integrate: async () => {
          execFileSync(process.execPath, ['-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(interruptionMarker)}, 'started\\n');`], { cwd: f.box.root });
          throw new Error('controlled integration interruption');
        },
        verify: async () => { throw new Error('verification must not start after an unknown integration'); },
      });
      const recovery = await interrupted.run({ projectId: f.projectId, batchId: started.batchId, commandId: 'f008-interrupted' });
      expect(recovery.status).toBe('reconciliation_required');
      expect(recovery.candidate?.workspacePreserved).toBe(true);
      expect(readFileSync(interruptionMarker, 'utf8')).toBe('started\n');
      expect(f.session.database.prepare('SELECT status, workspace_preserved FROM phase_delivery_candidates WHERE command_id = ?').get('f008-interrupted')).toEqual({ status: 'reconciliation_required', workspace_preserved: 1 });

      const repairMarker = join(f.box.root, 'f008-repair.marker');
      const repairLeaves = { read: (_project: string, featureId: string) => leaf(featureId, featureId === 'feature-a' ? 'c' : 'd', {
        coveredInputs: [{ inputId: featureId === 'feature-a' ? 'input-c' : 'input-d', digest: featureId === 'feature-a' ? DIGEST('c') : DIGEST('d') }],
      }) };
      const repaired = createBatchLeafFinalizationService({
        batches: { read: () => snapshot(f.projectId, started.batchId, {
          targetBaseline: SHA('c'),
          approvedInputs: [{ inputId: 'input-c', digest: DIGEST('c') }, { inputId: 'input-d', digest: DIGEST('d') }],
          strategySummary: { mode: 'deterministic', repair: true },
        }) }, leaves: repairLeaves, candidates,
        integrate: async () => {
          execFileSync(process.execPath, ['-e', `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(repairMarker)}, 'integration\\n');`], { cwd: f.box.root });
          return { status: 'succeeded' as const, commitSha: SHA('d'), treeSha: SHA('e'), evidenceId: 'repair-integration', evidenceDigest: DIGEST('e'), workspacePreserved: true };
        },
        verify: async () => {
          const failed = spawnSync(process.execPath, ['-e', 'process.exit(7)'], { cwd: f.box.root, encoding: 'utf8' });
          expect(failed.status).toBe(7);
          return { status: 'failed' as const, evidenceId: 'repair-verification-failed', evidenceDigest: DIGEST('f'), reason: 'verification_exit_7' };
        },
      });
      const failedRepair = await repaired.run({ projectId: f.projectId, batchId: started.batchId, commandId: 'f008-repair-failed' });
      expect(failedRepair.status).toBe('blocked');
      expect(failedRepair.candidate?.verification).toMatchObject({ status: 'failed', reason: 'verification_exit_7' });
      expect(readFileSync(repairMarker, 'utf8')).toBe('integration\n');
      expect(f.session.database.prepare('SELECT status FROM phase_delivery_candidates WHERE command_id = ?').get('f008-repair-failed')).toEqual({ status: 'blocked' });
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM phase_delivery_approvals').get()).toEqual({ count: 0 });
    } finally { f.close(); }
  });

  it('[case:vertical-fixed-scope-no-common-successor] keeps a running range immutable and refuses a leaf set with no two parallel leaves', async () => {
    const f = await openBudgetFixture();
    try {
      const candidates = createSqliteBatchFinalizationCandidateStore(f.session, { nowUtcMs: () => 1_900_000_230_000 });
      let readIds: string[] = [];
      const service = createBatchLeafFinalizationService({
        batches: { read: () => snapshot(f.projectId, 'batch-fixed', {
          featureIds: ['feature-a', 'feature-b', 'feature-c'],
          dependencies: [
            { featureId: 'feature-c', dependsOnId: 'feature-a' },
            { featureId: 'feature-c', dependsOnId: 'feature-b' },
          ],
        }) },
        leaves: { read: (_project, featureId) => { readIds.push(featureId); return leaf(featureId, 'a'); } },
        candidates,
      });
      const result = await service.prepare({ projectId: f.projectId, batchId: 'batch-fixed', commandId: 'f008-fixed-scope' });
      expect(result.status).toBe('blocked');
      expect(result.blockReasons).toContain('no_parallel_leaf_set');
      expect(readIds).toEqual(['feature-c']);
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM phase_delivery_candidates').get()).toEqual({ count: 0 });
    } finally { f.close(); }
  });
});
