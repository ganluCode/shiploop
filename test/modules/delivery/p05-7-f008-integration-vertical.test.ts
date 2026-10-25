import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitCommitDriver } from '../../../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createIntegrationGitRecoveryReader } from '../../../packages/core/src/adapters/fs/recovery-git-reader.ts';
import { createIntegrationGitWorkspace } from '../../../packages/core/src/adapters/fs/integration-git-workspace.ts';
import { createGitIntegrationReconciliationService } from '../../../packages/core/src/application/git-integration-reconciliation.ts';
import type { IntegrationWorkspaceAdapter } from '../../../packages/core/src/ports/integration-workspace.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteGitIntegrationJournal } from '../../../packages/core/src/adapters/sqlite/git-integration-journal.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import {
  createRealInputs,
  git,
  openIntegrationFixture,
  writeEvidence,
} from '../../helpers/p05-7-integration-vertical.ts';

function realWorkspace(): IntegrationWorkspaceAdapter {
  return createIntegrationGitWorkspace({ confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) });
}

async function reconcile(
  f: Awaited<ReturnType<typeof openIntegrationFixture>>,
  operationId: string,
) {
  const persisted = f.box.atomic.transact('f008-recovery-read-operation', tx =>
    tx.getGitOperation(f.box.projectId, operationId));
  const reader = createIntegrationGitRecoveryReader({
    driverFor: () => createGitCommitDriver({ confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) }),
  });
  return createGitIntegrationReconciliationService({
    atomic: f.box.atomic,
    reader,
    journal: createSqliteGitIntegrationJournal(f.box.session, { nowUtcMs: () => 1_900_000_100_010 }),
    readAuthorization: () => ({
      intent: persisted.intent,
      ownerVersion: persisted.intent.budgetSnapshot?.ownerVersion as number,
      approvalCurrent: true,
    }),
    verifyWriterStopped: async () => true,
    nowUtcMs: () => 1_900_000_100_010,
  });
}

function removeWorktree(repo: string, path: string): void {
  try {
    git(repo, 'worktree', 'remove', '--force', path);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}

describe('P05-7 F-008 real SQLite/Git vertical acceptance matrix', () => {
  it('[case:f008-real-fixed-integration-produces-successor-input] integrates independent A/B and prepares C only from the observed integration commit', async () => {
    const f = await openIntegrationFixture();
    try {
      const real = createRealInputs(f);
      const beforeRefs = git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
      const result = await f.service(realWorkspace()).start(f.request);
      expect(result.outcome).toBe('pending_verification');
      expect(result.steps.map(step => step.inputSha)).toEqual(real.shas);
      expect(result.steps[0]?.parentBefore).toBe(real.base);
      expect(result.steps[1]?.parentBefore).toBe(result.steps[0]?.commitSha);
      expect(readFileSync(join(real.path, 'a.txt'), 'utf8')).toBe('a\n');
      expect(readFileSync(join(real.path, 'b.txt'), 'utf8')).toBe('b\n');
      expect(git(real.repo, 'rev-parse', 'HEAD')).toBe(real.base);
      expect(git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(beforeRefs);

      const integrationCommit = result.workspace?.currentHead;
      expect(integrationCommit).toMatch(/^[0-9a-f]{40}$/);
      const successorPath = join(f.box.box.root, 'successor-c');
      git(real.repo, 'worktree', 'add', '--detach', successorPath, integrationCommit!);
      try {
        expect(readFileSync(join(successorPath, 'a.txt'), 'utf8')).toBe('a\n');
        expect(readFileSync(join(successorPath, 'b.txt'), 'utf8')).toBe('b\n');
        expect(git(successorPath, 'rev-parse', 'HEAD')).toBe(integrationCommit);
      } finally {
        removeWorktree(real.repo, successorPath);
      }

      const evidencePath = join(f.box.box.root, 'evidence', 'f008-clean.json');
      writeEvidence(evidencePath, {
        scenario: 'fixed-input-clean-integration',
        repo: real.repo,
        targetBase: real.base,
        inputShas: real.shas,
        commandResults: [
          { argv: ['worktree', 'add', '--detach'], exitCode: 0 },
          { argv: ['merge', '--no-ff', '--no-commit'], exitCode: 0 },
          { argv: ['commit', '--no-gpg-sign'], exitCode: 0 },
        ],
        sqlite: {
          operationStatus: f.operations.getGitOperation(f.box.projectId, real.plan.integrationId).status,
          observationCount: f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_integration_observations').get(),
        },
        evidencePath,
      });
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
        repo: string; targetBase: string; inputShas: string[]; evidencePath: string;
      };
      expect(evidence.repo).toBe(real.repo);
      expect(evidence.targetBase).toBe(real.base);
      expect(evidence.inputShas).toEqual(real.shas);
      expect(evidence.evidencePath).toBe(evidencePath);
      expect(existsSync(evidencePath)).toBe(true);
    } finally {
      f.close();
    }
  }, 90_000);

  it.each([
    ['conflict', 'merge_conflict'],
    ['dirty', 'source_dirty'],
    ['target-drift', 'target_head_drift'],
    ['input-sha-drift', 'frozen_plan_changed'],
  ] as const)('[case:f008-real-block-%s] blocks and preserves Git/SQLite facts for %s', async (failure, expectedReason) => {
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f, failure === 'conflict');
      if (failure === 'dirty') {
        writeFileSync(join(real.repo, 'uncommitted.txt'), 'dirty\n');
      } else if (failure === 'target-drift') {
        writeFileSync(join(real.repo, 'drift.txt'), 'drift\n');
        git(real.repo, 'add', '.');
        git(real.repo, 'commit', '-m', 'target drift');
      } else if (failure === 'input-sha-drift') {
        f.authorization.intent = {
          ...f.authorization.intent,
          integrationPlan: {
            ...f.authorization.intent.integrationPlan!,
            predecessors: f.authorization.intent.integrationPlan!.predecessors.map(predecessor => ({
              ...predecessor,
              delivery: { ...predecessor.delivery!, commitSha: 'f'.repeat(40) },
            })),
          },
        };
      }
      if (failure === 'target-drift' || failure === 'dirty' || failure === 'conflict') {
        const result = await f.service(realWorkspace()).start(f.request);
        expect(result.outcome).toBe('blocked');
        expect(result.reason).toBe(expectedReason);
      } else {
        await expect(f.service(realWorkspace()).start(f.request)).rejects.toMatchObject({ kind: 'validation' });
      }
      if (failure === 'input-sha-drift') {
        expect(() => f.operations.getGitOperation(f.box.projectId, real!.plan.integrationId))
          .toThrow(expect.objectContaining({ kind: 'not_found' }));
        expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM state_events WHERE aggregate_id = ?')
          .get(real.plan.integrationId)).toEqual({ count: 0 });
        expect(existsSync(real.path)).toBe(false);
        return;
      }
      const operation = f.operations.getGitOperation(f.box.projectId, real!.plan.integrationId);
      expect(operation.status).toBe('pending');
      expect(operation.actualCommit).toBeNull();
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM state_events WHERE aggregate_id = ?')
        .get(real.plan.integrationId)).toEqual({ count: 1 });
      if (failure === 'conflict') {
        expect(git(real.path, 'ls-files', '-u')).not.toBe('');
        expect(readFileSync(join(real.path, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
      } else {
        expect(existsSync(real.path)).toBe(false);
      }
    } finally {
      if (real && existsSync(real.path)) removeWorktree(real.repo, real.path);
      f.close();
    }
  });

  it('[case:f008-real-process-and-lock-block] records unconfirmed writer and native Git lock as blocking facts without starting Git', async () => {
    const f = await openIntegrationFixture();
    try {
      const real = createRealInputs(f);
      f.setStopped(false);
      await expect(f.service(realWorkspace()).start(f.request)).rejects.toMatchObject({
        details: { reason: 'previous_writer_stop_unconfirmed' },
      });
      expect(f.calls).toEqual([]);
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_operations').get()).toEqual({ count: 0 });

      f.setStopped(true);
      const lockPath = join(real.repo, '.git', 'index.lock');
      writeFileSync(lockPath, 'held\n');
      const blocked = await f.service(realWorkspace()).start(f.request);
      expect(blocked.outcome).toBe('blocked');
      expect(blocked.reason).toBe('git_lock_present');
      expect(existsSync(lockPath)).toBe(true);
      expect(f.operations.getGitOperation(f.box.projectId, real.plan.integrationId).status).toBe('pending');
      rmSync(lockPath);
    } finally {
      f.close();
    }
  }, 90_000);

  it('[case:f008-real-recovery-reuses-commit-after-restart] reconstructs a post-commit observation after SQLite restart and makes duplicate recovery idempotent', async () => {
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f);
      const actual = realWorkspace();
      const crashAfterCommit: IntegrationWorkspaceAdapter = {
        ...actual,
        async merge(handle) {
          await actual.merge(handle);
          throw new Error('injected lost response after commit');
        },
      };
      await expect(f.service(crashAfterCommit).start(f.request)).rejects.toThrow('injected lost response after commit');
      const finalHead = git(real.path, 'rev-parse', 'HEAD');
      const operationCount = f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_integration_observations').get();
      expect(operationCount).toEqual({ count: 2 });
      f.box.reopen();
      const recovery = await reconcile(f, real.plan.integrationId);
      const first = await recovery.reconcile({ projectId: f.box.projectId, operationId: real.plan.integrationId });
      const second = await recovery.reconcile({ projectId: f.box.projectId, operationId: real.plan.integrationId });
      expect(first.outcome).toBe('matched');
      expect(first.reasonCode).toBeNull();
      expect(first.observation?.outcome).toBe('pending_verification');
      expect(first.observation?.workspace?.currentHead).toBe(finalHead);
      expect(second).toEqual(first);
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_integration_observations').get()).toEqual({ count: 3 });
      expect(git(real.path, 'rev-parse', 'HEAD')).toBe(finalHead);
      expect(f.box.atomic.transact('f008-read-recovered-operation', tx =>
        tx.getGitOperation(f.box.projectId, real!.plan.integrationId)).status).toBe('pending');
    } finally {
      if (real && existsSync(real.path)) removeWorktree(real.repo, real.path);
      f.close();
    }
  }, 90_000);

  it('[case:f008-real-recovery-before-merge-is-pending] preserves a prepared but unmodified worktree as pending and does not invent a commit', async () => {
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f);
      const actual = realWorkspace();
      const crashBeforeMerge: IntegrationWorkspaceAdapter = {
        ...actual,
        async prepare(input) {
          await actual.prepare(input);
          throw new Error('injected interruption before merge');
        },
      };
      await expect(f.service(crashBeforeMerge).start(f.request)).rejects.toThrow('injected interruption before merge');
      f.box.reopen();
      const recovery = await reconcile(f, real.plan.integrationId);
      const first = await recovery.reconcile({ projectId: f.box.projectId, operationId: real.plan.integrationId });
      const second = await recovery.reconcile({ projectId: f.box.projectId, operationId: real.plan.integrationId });
      expect(first).toMatchObject({ outcome: 'pending', reasonCode: 'no_side_effect_observed' });
      expect(second).toEqual(first);
      expect(first.observation).toBeNull();
      expect(git(real.path, 'rev-parse', 'HEAD')).toBe(real.base);
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_integration_observations').get()).toEqual({ count: 0 });
    } finally {
      if (real && existsSync(real.path)) removeWorktree(real.repo, real.path);
      f.close();
    }
  }, 90_000);

  it('[case:f008-real-cross-project-and-boundary-guards] rejects a late owner and leaves the persisted integration operation fenced', async () => {
    const f = await openIntegrationFixture();
    try {
      const real = createRealInputs(f);
      f.authorization.approvalCurrent = false;
      await expect(f.service(realWorkspace()).start(f.request)).rejects.toMatchObject({
        details: { reason: 'approval_not_current' },
      });
      expect(f.calls).toEqual([]);
      expect(() => f.operations.getGitOperation(f.box.projectId, real.plan.integrationId))
        .toThrow(expect.objectContaining({ kind: 'not_found' }));
      expect(() => f.operations.getGitOperation('other-project', real.plan.integrationId)).toThrow(expect.objectContaining({ kind: 'not_found' }));
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_integration_commands').get()).toEqual({ count: 0 });
    } finally {
      f.close();
    }
  }, 90_000);
});
