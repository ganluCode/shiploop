import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createP05AcceptanceFixture } from '../../helpers/p05-10/index.ts';
import { BUDGET, NOW, openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createIntegrationVerificationService } from '../../../packages/core/src/application/integration-verification.ts';
import { createSqliteGitIntegrationJournal } from '../../../packages/core/src/adapters/sqlite/git-integration-journal.ts';
import { createIntegrationGitWorkspace } from '../../../packages/core/src/adapters/fs/integration-git-workspace.ts';
import type { VerificationPlan } from '../../../packages/core/src/ports/verification-plan.ts';
import {
  createRealInputs,
  digest,
  git,
  openIntegrationFixture,
} from '../../helpers/p05-7-integration-vertical.ts';

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
  reason: 'F-006 combined verification',
  candidateDigest: null,
  candidateRejection: { reason: 'candidate_missing', detail: 'combined' },
};

async function saveEvidence(
  fixture: ReturnType<typeof createP05AcceptanceFixture>,
  scenarioId: string,
  input: unknown,
  stateSnapshot: Readonly<Record<string, unknown>>,
): Promise<void> {
  const scenario = fixture.createScenario(scenarioId);
  const run = await scenario.runFakeRuntime({
    script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'offline-evidence.txt', content: `${scenarioId}\n` }] },
  });
  expect(run.result.terminal).toBe('completed');
  await scenario.cleanup();
  const evidence = scenario.recordEvidence({
    input,
    command: ['node', 'scripts/run-tests.ts', 'test/modules/acceptance/p05-10-f006-combined-faults.test.ts'],
    exitCode: 0,
    stateSnapshot,
    usageSource: run.usageSource,
  });
  expect(evidence.status).toBe('pass');
  expect(scenario.writeEvidence(evidence)).toContain(`${scenarioId}.json`);
}

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

describe('P05-10 F-006 combined fault matrix', { timeout: 120_000 }, () => {
  it('[case:f006-input-drift-invalidates-preview] 输入漂移使旧预览失效且不创建 Batch/Run 或 Git 副作用', async () => {
    const evidence = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f006-drift-' });
    const scenario = evidence.createScenario('input-drift');
    const box = await openBudgetFixture(BUDGET);
    try {
      const preview = await box.services.preview.previewExecution(box.projectId, {
        featureIds: [box.featureId], budget: { ...box.budget },
      });
      expect(preview.status).toBe('ready');
      const before = {
        batches: box.session.database.prepare('SELECT COUNT(*) AS count FROM execution_batches').get(),
        runs: box.session.database.prepare('SELECT COUNT(*) AS count FROM runs').get(),
        events: box.session.database.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'execution.run.dispatched'").get(),
        targetHead: git(box.box.repoDirA, 'rev-parse', 'HEAD'),
        head: scenario.gitFacts().head,
      };

      writeFileSync(join(box.box.repoDirA, 'late-input-change.txt'), 'drift\n', 'utf8');
      const stale = await box.submit('execution.start', {
        featureIds: [box.featureId], budget: { ...box.budget }, previewDigest: preview.previewDigest,
      }, { scope: box.scope });

      expect(stale).toMatchObject({ status: 'rejected', operation: 'execution.start' });
      if (stale.status !== 'rejected') throw new Error('expected stale execution.start rejection');
      expect(stale.error.details?.reason).toBe('preview_stale');
      expect(box.session.database.prepare('SELECT COUNT(*) AS count FROM execution_batches').get()).toEqual(before.batches);
      expect(box.session.database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual(before.runs);
      expect(box.session.database.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'execution.run.dispatched'").get()).toEqual(before.events);
      expect(git(box.box.repoDirA, 'rev-parse', 'HEAD')).toBe(before.targetHead);
      expect(scenario.gitFacts().head).toBe(before.head);
      expect(scenario.gitFacts().status).toBe('');

      await scenario.cleanup();
      const saved = scenario.writeEvidence(scenario.recordEvidence({
        input: { featureId: box.featureId, previewDigest: preview.previewDigest, drift: 'late-input-change.txt' },
        command: ['node', 'scripts/run-tests.ts', 'test/modules/acceptance/p05-10-f006-combined-faults.test.ts'],
        exitCode: 0,
        stateSnapshot: {
          featureId: box.featureId,
          batchId: null,
          runId: null,
          attemptId: null,
          rejection: stale.error.details?.reason,
          core: { batches: before.batches, runs: before.runs, events: before.events },
        },
      }));
      expect(saved).toContain('input-drift.json');
    } finally {
      box.close();
      await evidence.dispose();
    }
  });

  it('[case:f006-budget-cancel-recovery-keeps-scope] 预算耗尽后的恢复拒绝新动作，并保留同一 Batch/Run 的累计事实', async () => {
    const evidence = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f006-budget-' });
    const f = await openClaimFixture();
    try {
      const currentRun = f.box.session.database.prepare('SELECT revision FROM runs WHERE id = ?').get(f.ids.runId) as { revision: number };
      const paused = await f.box.submit('execution.pause', { runId: f.ids.runId, batchId: null }, {
        scope: f.box.scope, expectedRevision: currentRun.revision,
      });
      expect(paused).toMatchObject({ status: 'completed' });
      const pausedRun = f.box.session.database.prepare('SELECT revision FROM runs WHERE id = ?').get(f.ids.runId) as { revision: number };
      f.box.session.database.prepare('UPDATE execution_batches SET runtime_starts = ? WHERE id = ?').run(BUDGET.batch.maxRuntimeStarts, f.ids.batchId);
      const before = {
        batches: f.box.session.database.prepare('SELECT * FROM execution_batches WHERE id = ?').get(f.ids.batchId),
        runs: f.box.session.database.prepare('SELECT * FROM runs WHERE id = ?').get(f.ids.runId),
        attempts: f.box.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get(),
        events: f.box.session.database.prepare('SELECT COUNT(*) AS count FROM state_events').get(),
        git: f.box.box.repoDirA,
      };

      const resume = await f.box.submit('execution.resume', { runId: f.ids.runId, batchId: null }, {
        scope: f.box.scope, expectedRevision: pausedRun.revision,
      });
      expect(resume).toMatchObject({ status: 'rejected', operation: 'execution.resume' });
      if (resume.status !== 'rejected') throw new Error('expected budget-exhausted resume rejection');
      expect(resume.error.details?.reason).toBe('budget_exhausted');
      expect(f.box.session.database.prepare('SELECT * FROM execution_batches WHERE id = ?').get(f.ids.batchId)).toEqual(before.batches);
      expect(f.box.session.database.prepare('SELECT * FROM runs WHERE id = ?').get(f.ids.runId)).toEqual(before.runs);
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual(before.attempts);
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM state_events').get()).toEqual(before.events);
      expect(git(before.git, 'status', '--porcelain=v1')).toBe('');

      await saveEvidence(evidence, 'budget-recovery',
        { batchId: f.ids.batchId, runId: f.ids.runId, operation: 'execution.resume', reason: 'budget_exhausted' },
        {
          featureId: f.box.featureId,
          batchId: f.ids.batchId,
          runId: f.ids.runId,
          attemptId: null,
          rejection: resume.error.details?.reason,
          core: { batch: before.batches, run: before.runs, attempts: before.attempts, events: before.events },
        });
    } finally {
      f.box.close();
      await evidence.dispose();
    }
  });

  it('[case:f006-event-replay-after-restart] 进程重启后的重复 Runtime 事件只产生一次状态变化并保留工作区隔离事实', async () => {
    const evidence = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f006-replay-' });
    const f = await openClaimFixture([[], ['t-1']]);
    try {
      const attempt = f.store().claimTask(f.input()).receipt.attempt;
      const identity = {
        projectId: attempt.projectId, attemptId: attempt.id, taskId: attempt.taskId,
        runId: attempt.runId, owner: attempt.owner, hostInstanceId: attempt.hostInstanceId,
        executionVersion: attempt.executionVersion,
      };
      const resourceIdentity = {
        projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
        hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
      };
      const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
      f.box.session.transactWrite('f006-runtime-start', () => {
        createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
          projectId: attempt.projectId, batchId: f.ids.batchId, runId: attempt.runId, startKey: attempt.id,
        });
        resources.beginLaunchInTransaction(resourceIdentity);
        resources.confirmLaunchInTransaction(resourceIdentity, {
          launchId: '10000000-0000-4000-8000-000000000006', pid: 6006, processGroupId: 6006, startTime: 'f006-start',
        });
      });
      const firstLifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 1 });
      expect(firstLifecycle.apply({ ...identity, notificationId: 'f006-executing', kind: 'executing' })).toMatchObject({ disposition: 'applied', status: 'executing' });
      const completed = { ...identity, notificationId: 'f006-completed', kind: 'runtime_completed' as const, exitCode: 0, evidenceRef: attempt.inputRef };
      expect(firstLifecycle.apply(completed)).toMatchObject({ disposition: 'applied', status: 'verifying', resultSaved: true });
      const before = {
        attempt: f.box.session.database.prepare('SELECT status, ended_at FROM attempts WHERE id = ?').get(attempt.id),
        run: f.box.session.database.prepare('SELECT status, attempts_created FROM runs WHERE id = ?').get(attempt.runId),
        leases: f.box.session.database.prepare('SELECT state FROM workspace_leases WHERE owner_id = ? ORDER BY id').all(attempt.id),
        events: f.box.session.database.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.attempt.updated'").get(),
      };

      f.box.reopen();
      const replay = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 1 }).apply(completed);
      expect(replay).toMatchObject({ disposition: 'replayed', status: 'verifying' });
      expect(f.box.session.database.prepare('SELECT status, ended_at FROM attempts WHERE id = ?').get(attempt.id)).toEqual(before.attempt);
      expect(f.box.session.database.prepare('SELECT status, attempts_created FROM runs WHERE id = ?').get(attempt.runId)).toEqual(before.run);
      expect(f.box.session.database.prepare('SELECT state FROM workspace_leases WHERE owner_id = ? ORDER BY id').all(attempt.id)).toEqual(before.leases);
      expect(f.box.session.database.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.attempt.updated'").get()).toEqual(before.events);

      await saveEvidence(evidence, 'event-replay',
        { attemptId: attempt.id, notificationId: completed.notificationId, restart: true },
        {
          featureId: attempt.featureId,
          batchId: f.ids.batchId,
          runId: attempt.runId,
          attemptId: attempt.id,
          event: { first: 'applied', replay: replay.disposition },
          core: before,
        });
    } finally {
      f.box.close();
      await evidence.dispose();
    }
  });

  it('[case:f006-verification-failure-retains-integration-facts] 集成验证失败保留工作区/Git 事实、失败证据和归属，不静默标记通过', async () => {
    const evidence = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f006-integration-' });
    const f = await openIntegrationFixture();
    let real: ReturnType<typeof createRealInputs> | undefined;
    try {
      real = createRealInputs(f);
      const integrated = await f.service(realWorkspace()).start(f.request);
      expect(integrated.outcome).toBe('pending_verification');
      const verification = createIntegrationVerificationService({
        atomic: f.box.atomic,
        journal: createSqliteGitIntegrationJournal(f.box.session, { nowUtcMs: () => NOW + 1 }),
        executor: { start: async input => {
          const output = {
            status: 'failed' as const, stopped: true, commitSha: input.workspace.currentHead,
            treeSha: input.workspace.facts.tree, inputDigest: input.inputDigest, targetBase: input.targetBaseline,
            verificationPlan: { id: 'f006-failed-plan', digest: digest('f') },
            verificationResult: { id: 'f006-failed-result', digest: digest('c') },
          };
          return output;
        } },
        readAuthorization: () => true,
        nowUtcMs: () => NOW + 1,
      });
      const failed = await verification.run({
        projectId: f.box.projectId, operationId: real.plan.integrationId, ownerId: f.intent.ownerId,
        ownerVersion: 1, verificationPlan, targets: ['combined'],
      });
      expect(failed).toMatchObject({ outcome: 'failed', reason: 'verification_failed' });
      expect(failed.integration?.status).toBe('blocked');
      expect(failed.integration?.blockReasons).toContain('verification_failed');
      expect(f.operations.getGitOperation(f.box.projectId, real.plan.integrationId)).toMatchObject({ status: 'failed' });
      expect(existsSync(real.path)).toBe(true);
      expect(git(real.path, 'status', '--porcelain=v1')).toBe('');
      expect(git(f.plan.target.canonicalPath, 'rev-parse', 'HEAD')).toBe(real.base);

      await saveEvidence(evidence, 'integration-failure',
        { integrationId: real.plan.integrationId, inputDigest: real.plan.inputDigest, verification: 'failed' },
        {
          featureId: f.box.featureId,
          batchId: f.plan.batchId,
          runId: f.plan.runId,
          attemptId: null,
          integration: { status: failed.integration?.status, reason: failed.reason },
          git: { workspace: real.path, candidate: integrated.workspace?.currentHead, target: f.plan.target.baseCommit },
        });
    } finally {
      if (real) cleanupWorktree(f.plan.target.canonicalPath, real.path);
      f.close();
      await evidence.dispose();
    }
  });

  it('[case:f006-live-is-not-run] 需要真实模型或人工确认的路径明确记录 not_run，不折算为离线通过', async () => {
    const evidence = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f006-not-run-' });
    const scenario = evidence.createScenario('live-not-run');
    try {
      await scenario.cleanup();
      const record = scenario.recordEvidence({
        input: { scenario: 'live-git-agent', network: 'denied', llmCalls: false },
        command: ['node', 'scripts/acceptance/p05-accept.ts', '--live'],
        exitCode: null,
        status: 'not_run',
        usageSource: 'not_run',
        notRunReason: '真实模型与负责人确认未授权',
        stateSnapshot: { featureId: null, batchId: null, runId: null, attemptId: null, status: 'not_run' },
      });
      expect(record).toMatchObject({ status: 'not_run', exitCode: null, notRunReason: '真实模型与负责人确认未授权' });
      expect(scenario.writeEvidence(record)).toContain('live-not-run.json');
    } finally {
      await evidence.dispose();
    }
  });
});
