import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIntegrationGitRecoveryReader } from '../../../packages/core/src/adapters/fs/recovery-git-reader.ts';
import { createGitCommitDriver } from '../../../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createIntegrationGitWorkspace } from '../../../packages/core/src/adapters/fs/integration-git-workspace.ts';
import { createSqliteGitIntegrationJournal } from '../../../packages/core/src/adapters/sqlite/git-integration-journal.ts';
import { createGitIntegrationReconciliationService } from '../../../packages/core/src/application/git-integration-reconciliation.ts';
import { createIntegrationVerificationService } from '../../../packages/core/src/application/integration-verification.ts';
import {
  computeGitAgentRepairBaselineDigest,
  createGitAgentRepairRequest,
} from '../../../packages/core/src/ports/git-agent-repair.ts';
import { createGitAgentRuntimeRequest } from '../../../packages/core/src/ports/git-agent-runtime.ts';
import { createFakeGitAgentRuntime } from '../../../packages/core/src/adapters/fake-git-agent-runtime.ts';
import type { VerificationPlan } from '../../../packages/core/src/ports/verification-plan.ts';
import {
  createRealInputs,
  digest,
  git,
  openIntegrationFixture,
} from '../../helpers/p05-7-integration-vertical.ts';
import type { IntegrationWorkspaceAdapter } from '../../../packages/core/src/ports/integration-workspace.ts';

const verificationPlan: VerificationPlan = {
  status: 'ready',
  mode: 'full_fallback',
  affectedModules: ['core'],
  coveredModules: ['core'],
  selectedCheckKeys: ['combined'],
  selectedChecks: [{ checkKey: 'combined', scope: 'project', kind: 'command', argv: ['node', 'verify.js'],
    cwdRef: null, environmentRef: null, timeout: 1_000, required: true, requirementRefs: ['core'] }],
  unselectedCheckKeys: [],
  reasonCode: 'candidate_missing',
  reason: 'F-005 combined verification',
  candidateDigest: null,
  candidateRejection: { reason: 'candidate_missing', detail: 'combined' },
};

function realWorkspace() {
  return createIntegrationGitWorkspace({
    confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
  });
}

function cleanupWorktree(repo: string, path: string): void {
  if (!existsSync(path)) return;
  try { git(repo, 'worktree', 'remove', '--force', path); }
  catch { rmSync(path, { recursive: true, force: true }); }
}

describe('P05-10 F-005 controlled Git integration and bounded GitAgent acceptance', { timeout: 120_000 }, () => {
  it('[case:f005-fixed-order-and-verification] freezes independent SHAs, merges in order, and persists verified integration facts', async () => {
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f);
      const beforeTargetHead = git(real.repo, 'rev-parse', 'HEAD');
      const beforeRefs = git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
      const integrated = await f.service(realWorkspace()).start(f.request);
      expect(integrated.outcome).toBe('pending_verification');
      expect(integrated.steps.map(step => step.inputSha)).toEqual(real.shas);
      expect(integrated.steps.map(step => step.parentBefore)).toEqual([
        real.base,
        integrated.steps[0]!.commitSha,
      ]);
      expect(integrated.workspace?.facts.statusPorcelain).toBe('');
      expect(readFileSync(join(real.path, 'a.txt'), 'utf8')).toBe('a\n');
      expect(readFileSync(join(real.path, 'b.txt'), 'utf8')).toBe('b\n');

      const verification = createIntegrationVerificationService({
        atomic: f.box.atomic,
        journal: createSqliteGitIntegrationJournal(f.box.session, { nowUtcMs: () => 1_900_000_100_010 }),
        executor: {
          start: async input => ({
            status: 'passed' as const,
            stopped: true,
            commitSha: input.workspace.currentHead,
            treeSha: input.workspace.facts.tree,
            inputDigest: input.inputDigest,
            targetBase: input.targetBaseline,
            verificationPlan: { id: 'f005-plan-evidence', digest: digest('a') },
            verificationResult: { id: 'f005-result-evidence', digest: digest('b') },
          }),
        },
        readAuthorization: () => true,
        nowUtcMs: () => 1_900_000_100_010,
      });
      const verified = await verification.run({
        projectId: f.box.projectId,
        operationId: real.plan.integrationId,
        ownerId: f.intent.ownerId,
        ownerVersion: 1,
        verificationPlan,
        targets: ['combined'],
      });
      expect(verified).toMatchObject({ outcome: 'passed', reason: 'verified' });
      expect(verified.integration?.integrationResult).toMatchObject({
        commitSha: integrated.workspace?.currentHead,
        treeSha: integrated.workspace?.facts.tree,
        verificationEvidence: { evidenceId: 'f005-result-evidence' },
      });
      expect(f.operations.getGitOperation(f.box.projectId, real.plan.integrationId)).toMatchObject({ status: 'succeeded' });
      expect(git(real.repo, 'rev-parse', 'HEAD')).toBe(beforeTargetHead);
      expect(git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(beforeRefs);
    } finally {
      if (real) cleanupWorktree(real.repo, real.path);
      f.close();
    }
  });

  it('[case:f005-conflict-retains-scoped-facts] blocks unresolved conflict without choosing a side, force pushing, or deleting the workspace', async () => {
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f, true);
      const targetBefore = git(real.repo, 'rev-parse', 'HEAD');
      const refsBefore = git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
      const result = await f.service(realWorkspace()).start(f.request);
      expect(result).toMatchObject({ outcome: 'blocked', reason: 'merge_conflict' });
      expect(result.workspace?.facts.unresolvedPaths).toContain('shared.txt');
      expect(readFileSync(join(real.path, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
      expect(git(real.path, 'ls-files', '-u')).not.toBe('');
      expect(git(real.repo, 'rev-parse', 'HEAD')).toBe(targetBefore);
      expect(git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);
      for (const sha of real.shas) expect(git(real.repo, 'cat-file', '-t', sha)).toBe('commit');
      expect(existsSync(real.path)).toBe(true);
      expect(f.operations.getGitOperation(f.box.projectId, real.plan.integrationId)).toMatchObject({ status: 'pending' });
    } finally {
      if (real) cleanupWorktree(real.repo, real.path);
      f.close();
    }
  });

  it('[case:f005-git-agent-bounded-authorization] sends only explicit repair scope and budget to a no-model runtime', async () => {
    const f = await openIntegrationFixture();
    try {
      const workspace = join(f.box.box.root, 'git-agent-workspace');
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src', 'conflict.ts'), 'before\n');
      const auth = createGitAgentRepairRequest({
        projectId: f.box.projectId,
        phaseId: f.plan.phaseId,
        parentBatchId: f.plan.batchId,
        featureId: f.box.featureId,
        runId: f.plan.runId,
        repairId: 'f005-repair',
        commandId: 'f005-command',
        source: {
          projectId: f.box.projectId, phaseId: f.plan.phaseId, parentBatchId: f.plan.batchId,
          featureId: f.box.featureId, runId: f.plan.runId, integrationId: f.plan.integrationId,
          operationId: f.plan.integrationId, operationType: 'integration', operationDigest: digest('a'),
          failureKind: 'conflict', evidenceId: 'f005-conflict', evidenceDigest: digest('b'), inputDigest: f.plan.inputDigest,
        },
        target: { repoIdentity: f.plan.target.repoIdentity, baselineCommitSha: f.plan.target.baseCommit,
          baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: f.plan.target.repoIdentity, baselineCommitSha: f.plan.target.baseCommit }) },
        workspace: { workspaceId: 'f005-workspace', workspaceDigest: digest('c') },
        conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts'],
        intent: { intentId: 'f005-intent', digest: digest('d') },
        verification: { strategyId: 'f005-checks', digest: digest('e') },
        budget: { remainingAttempts: 1, remainingTokens: 20, remainingRuntimeMs: 1_000, deadlineUtcMs: 1_900_000_105_000 },
      }, { nowUtcMs: 1_900_000_100_000 });
      const request = createGitAgentRuntimeRequest({
        authorization: auth,
        claim: { projectId: f.box.projectId, repairId: auth.repairId, attemptId: 'f005-attempt', ownerId: 'f005-owner', hostInstanceId: 'f005-host', authorizationVersion: 1 },
        invocationId: 'f005-invocation', executionVersion: 1,
      });
      const beforeRows = f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_operations').get();
      const runtime = createFakeGitAgentRuntime({
        workspaceRoots: { 'f005-workspace': workspace },
        script: { schemaVersion: 1, steps: [
          { op: 'write_file', path: 'src/conflict.ts', content: 'resolved\n' },
          { op: 'verification', outputDigest: digest('f'), exitCode: 0 },
          { op: 'usage', consumedTokens: 7, runtimeMs: 12 },
        ] },
      });
      const handle = await runtime.start(request);
      const result = await handle.result;
      expect(result.terminal).toBe('completed');
      expect(result.changedPaths).toEqual(['src/conflict.ts']);
      expect(result.verification.exitCode).toBe(0);
      expect(result).not.toHaveProperty('passed');
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_operations').get()).toEqual(beforeRows);
      expect(readFileSync(join(workspace, 'src', 'conflict.ts'), 'utf8')).toBe('resolved\n');

      const forbidden = createFakeGitAgentRuntime({
        workspaceRoots: { 'f005-workspace': workspace },
        script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'state.db', content: 'forbidden' }] },
      });
      const forbiddenResult = await (await forbidden.start(request)).result;
      expect(forbiddenResult.terminal).toBe('failed');
      expect(forbiddenResult.failure?.code).toBe('protected_path');
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_operations').get()).toEqual(beforeRows);
    } finally { f.close(); }
  });

  it('[case:f005-verification-failure-stays-blocked] rechecks the candidate after the authorized stage and preserves failed evidence', async () => {
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f);
      const integrated = await f.service(realWorkspace()).start(f.request);
      const verification = createIntegrationVerificationService({
        atomic: f.box.atomic,
        journal: createSqliteGitIntegrationJournal(f.box.session, { nowUtcMs: () => 1_900_000_100_010 }),
        executor: { start: async input => ({
          status: 'failed' as const, stopped: true, commitSha: input.workspace.currentHead,
          treeSha: input.workspace.facts.tree, inputDigest: input.inputDigest, targetBase: input.targetBaseline,
          verificationPlan: { id: 'f005-failed-plan', digest: digest('a') },
          verificationResult: { id: 'f005-failed-result', digest: digest('b') },
        }) },
        readAuthorization: () => true,
      });
      const failed = await verification.run({ projectId: f.box.projectId, operationId: real.plan.integrationId,
        ownerId: f.intent.ownerId, ownerVersion: 1, verificationPlan, targets: ['combined'] });
      expect(integrated.outcome).toBe('pending_verification');
      expect(failed).toMatchObject({ outcome: 'failed', reason: 'verification_failed' });
      expect(failed.integration?.status).toBe('blocked');
      expect(failed.integration?.blockReasons).toContain('verification_failed');
      expect(f.operations.getGitOperation(f.box.projectId, real.plan.integrationId)).toMatchObject({ status: 'failed' });
      expect(existsSync(real.path)).toBe(true);
      expect(git(real.path, 'status', '--porcelain')).toBe('');
    } finally {
      if (real) cleanupWorktree(real.repo, real.path);
      f.close();
    }
  });

  it('[case:f005-interruption-reconciles-real-head] reconciles a lost response from real Git facts before allowing reuse', async () => {
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f);
      const actual = realWorkspace();
      const interrupted: IntegrationWorkspaceAdapter = {
        ...actual,
        async merge(handle) {
          await actual.merge(handle);
          throw new Error('f005-lost-response');
        },
      };
      await expect(f.service(interrupted).start(f.request)).rejects.toThrow('f005-lost-response');
      const observedHead = git(real.path, 'rev-parse', 'HEAD');
      f.box.reopen();
      const persisted = f.box.atomic.transact('f005-read-operation', tx => tx.getGitOperation(f.box.projectId, real!.plan.integrationId));
      const recovery = createGitIntegrationReconciliationService({
        atomic: f.box.atomic,
        journal: createSqliteGitIntegrationJournal(f.box.session, { nowUtcMs: () => 1_900_000_100_010 }),
        reader: createIntegrationGitRecoveryReader({
          driverFor: () => createGitCommitDriver({ confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) }),
        }),
        readAuthorization: () => ({ intent: persisted.intent, ownerVersion: 1, approvalCurrent: true }),
        verifyWriterStopped: async () => true,
      });
      const first = await recovery.reconcile({ projectId: f.box.projectId, operationId: real.plan.integrationId });
      const second = await recovery.reconcile({ projectId: f.box.projectId, operationId: real.plan.integrationId });
      expect(first.outcome).toBe('matched');
      expect(first.observation?.workspace?.currentHead).toBe(observedHead);
      expect(first.observation?.outcome).toBe('pending_verification');
      expect(second).toEqual(first);
      expect(git(real.path, 'rev-parse', 'HEAD')).toBe(observedHead);
      expect(f.box.atomic.transact('f005-read-reconciled-operation', tx => tx.getGitOperation(f.box.projectId, real!.plan.integrationId).status)).toBe('pending');
    } finally {
      if (real) cleanupWorktree(real.repo, real.path);
      f.close();
    }
  });

  it('[case:f005-baseline-drift-rejects-reuse] rejects a changed target baseline before creating an integration workspace', async () => {
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f);
      writeFileSync(join(real.repo, 'drift.txt'), 'drift\n');
      git(real.repo, 'add', 'drift.txt');
      git(real.repo, 'commit', '-m', 'external baseline drift');
      const result = await f.service(realWorkspace()).start(f.request);
      expect(result).toMatchObject({ outcome: 'blocked', reason: 'target_head_drift' });
      expect(existsSync(real.path)).toBe(false);
      expect(f.operations.getGitOperation(f.box.projectId, real.plan.integrationId)).toMatchObject({ status: 'pending' });
      expect(git(real.repo, 'status', '--porcelain')).toBe('');
    } finally {
      if (real) cleanupWorktree(real.repo, real.path);
      f.close();
    }
  });
});
