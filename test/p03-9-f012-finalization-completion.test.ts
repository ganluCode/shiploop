/**
 * P03-9 / F-012 finalization-only Run 审批继续、Git operation 复用与完成 CAS。
 *
 * 真实临时 Git/SQLite/Artifact；不启动 Runtime、不调用模型。验证：
 * - 最终检查后审批缺失只进入等待，批准命令不提交，显式 resume 后才继续；
 * - 已发生/无差异提交按真实 Git 事实复用，不重复提交；
 * - 提交失败、回执丢失、hook 改源码、外部 HEAD 漂移均不得完成或 reset；
 * - 只有全部轴满足才 CAS 完成 Run/Batch/Feature。
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteAttemptAccess } from '../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteExecutionResumeFactsReader } from '../packages/core/src/adapters/sqlite/execution-resume.ts';
import { createSqliteGitOperationStore } from '../packages/core/src/adapters/sqlite/git-operations.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import { createGitCommitDriver } from '../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createGitPublicMetadataLock } from '../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createWorkspaceInspector } from '../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createFinalizationCompletionService } from '../packages/core/src/application/finalization-completion.ts';
import { createFinalizationExecutionService } from '../packages/core/src/application/finalization-execution.ts';
import { createFinalizationGitDelivery } from '../packages/core/src/application/finalization-git-delivery.ts';
import type { FinalizationVerifier } from '../packages/core/src/ports/finalization-execution.ts';
import type { CommandReceipt } from '../packages/core/src/ports/commands.ts';
import type { WorkspaceBaseline } from '../packages/core/src/ports/workspace.ts';
import { BUDGET, NOW } from './helpers/p03-3/budget-fixture.ts';
import { git } from './helpers/git-repo.ts';
import {
  openFinalizationFixture,
  plannerFor,
  prepareEligibleFixture,
  retryCommandsFor,
  retryPayload,
  row,
  tableRows,
  type EligibleFinalizationFixture,
} from './helpers/p03-9/finalization-retry-fixture.ts';

const confirm = async (identity: { launchId: string }) => ({ launchId: identity.launchId });
const GIT_IDENTITY = { name: 'Confirmed User', email: 'confirmed@example.test', confirmed: true as const };
const DELIVERY_POLICY = 'cd'.repeat(32);
const MESSAGE = 'Deliver final verified Feature';

function retryBudget(maxRuns = 4) {
  return {
    ...BUDGET,
    batch: {
      ...BUDGET.batch,
      maxRuns,
      maxTotalAttempts: Math.max(maxRuns, BUDGET.run.maxAttemptsPerRun),
      maxRuntimeStarts: Math.max(maxRuns, BUDGET.run.maxAttemptsPerRun),
      maxNoProgressRuns: Math.max(maxRuns, 1),
    },
  };
}

async function createFinalizationRun(f: EligibleFinalizationFixture): Promise<string> {
  const receipt = await retryCommandsFor(f).submit(randomUUID(), retryPayload(f));
  if (receipt.status !== 'completed' || receipt.result === null || typeof receipt.result !== 'object'
    || typeof (receipt.result as { runId?: unknown }).runId !== 'string') {
    throw new Error(`retryFinal failed: ${JSON.stringify(receipt)}`);
  }
  return (receipt.result as { runId: string }).runId;
}

function noChecksVerifier(): FinalizationVerifier {
  return {
    async revalidateTask() {
      throw new Error('F-012 must not rerun valid checks');
    },
    async verifyFeature() {
      throw new Error('F-012 must not rerun valid checks');
    },
  };
}

function finalizationExecutionFor(f: EligibleFinalizationFixture) {
  return createFinalizationExecutionService({
    facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: () => NOW }),
    planner: plannerFor(f),
    atomic: createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW }),
    verification: createSqliteVerificationStore(f.box.session, { nowUtcMs: () => NOW }),
    artifacts: f.verifier,
    verifier: noChecksVerifier(),
    nowMs: () => NOW,
  });
}

async function verifyFinalization(f: EligibleFinalizationFixture, runId: string): Promise<void> {
  const result = await finalizationExecutionFor(f).execute({ projectId: f.box.projectId, runId });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'verification_passed', runtimeStarts: 0, newAttempts: 0 });
}

function baselineFor(f: EligibleFinalizationFixture): WorkspaceBaseline {
  const repository = f.inspection.repository;
  return {
    repositoryBindingId: repository.repositoryBindingId,
    repositoryBindingRevision: repository.repositoryBindingRevision,
    repoIdentity: repository.repoIdentity,
    canonicalPath: repository.canonicalPath,
    gitCommonDir: repository.gitCommonDir,
    branch: repository.branch,
    baseCommit: repository.baseCommit,
  };
}

/**
 * Fixture-only: bind the existing valid Task/Feature evidence to the current
 * worktree after a deliberate source change, so the test can exercise a real
 * finalization commit without re-running Node checks. F-011 real revalidation is
 * covered separately; here we only need a genuine staged delta.
 */
async function bindEvidenceToCurrentSource(f: EligibleFinalizationFixture, content: string): Promise<void> {
  writeFileSync(join(f.box.box.repoDirA, 'src/a.ts'), content);
  const inspector = createWorkspaceInspector({
    authorizedRoots: [f.box.box.root, f.box.box.repoDirA],
    confirmProcessIdentity: confirm,
  });
  const inspection = await inspector.inspect(baselineFor(f));
  const db = f.box.session.database;
  const environment = JSON.stringify({ workspace: { headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest } });
  const batches = db.prepare('SELECT * FROM verification_batches').all() as Record<string, unknown>[];
  for (const batch of batches) {
    const id = `rebound-${randomUUID()}`;
    db.prepare(`INSERT INTO verification_batches
      (id, created_at, updated_at, revision, project_id, feature_id, run_id, task_id, attempt_id,
       execution_version, operation, code_digest, policy_digest, environment_summary, check_snapshot,
       selection, status, started_at, ended_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'passed', ?, ?)`).run(
      id, NOW + 1, NOW + 1, batch.project_id, batch.feature_id, batch.run_id, batch.task_id, batch.attempt_id,
      batch.execution_version, batch.operation, inspection.codeDigest, batch.policy_digest, environment,
      batch.check_snapshot, batch.selection, batch.started_at, batch.ended_at,
    );
    const checks = db.prepare('SELECT * FROM check_results WHERE batch_id = ?').all(batch.id as string) as Record<string, unknown>[];
    for (const check of checks) {
      db.prepare(`INSERT INTO check_results
        (id, created_at, updated_at, revision, project_id, batch_id, check_key, argv_json, cwd_ref,
         environment_ref, timeout_ms, required, status, exit_code, signal, timed_out,
         output_artifact_id, output_digest, output_tail, started_at, ended_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `rebound-${randomUUID()}`, NOW + 1, NOW + 1, check.project_id, id, check.check_key, check.argv_json,
        check.cwd_ref, check.environment_ref, check.timeout_ms, check.required, check.status, check.exit_code,
        check.signal, check.timed_out, check.output_artifact_id, check.output_digest, check.output_tail,
        check.started_at, check.ended_at,
      );
    }
  }
  db.prepare(`INSERT INTO task_approval_items
    (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
     responsible_party, plan_digest, code_digest, artifact_refs, status, created_by,
     decision, decision_actor, decision_reason, decision_code_digest, decision_artifact_refs, decided_at)
    VALUES (?, ?, ?, ?, 't-1', 1, ?, 'approval', 'final review rebound', 'owner', ?, ?, '[]', 'approved', 'owner',
      'approve', 'reviewer-1', 'approved current source', ?, '[]', ?)`).run(
    `approval-${randomUUID()}`, NOW + 1, f.box.projectId, f.box.featureId, NOW + 1,
    row<{ plan_digest: string }>(f, 'SELECT plan_digest FROM features WHERE id = ?', f.box.featureId)!.plan_digest,
    inspection.codeDigest, inspection.codeDigest, NOW + 1,
  );
}

function gitDeliveryFor(f: EligibleFinalizationFixture, nowMs: () => number = () => NOW) {
  const operations = createSqliteGitOperationStore(f.box.session, { nowUtcMs: nowMs });
  const inspector = createWorkspaceInspector({
    authorizedRoots: [f.box.box.root, f.box.box.repoDirA],
    confirmProcessIdentity: confirm,
  });
  return {
    operations,
    delivery: createFinalizationGitDelivery({
      operations,
      inspector,
      driver: createGitCommitDriver({ confirmProcessIdentity: confirm }),
      lock: createGitPublicMetadataLock(),
      transact: callback => f.box.session.transactWrite('F012.git', callback),
      readFeatureRevision: (projectId, featureId) => {
        const feature = row<{ revision: number }>(f,
          'SELECT revision FROM features WHERE project_id = ? AND id = ?', projectId, featureId);
        if (feature === undefined) throw new Error('feature missing');
        return feature.revision;
      },
      nowMs,
    }),
  };
}

function completionFor(
  f: EligibleFinalizationFixture,
  options: { readonly delivery?: ReturnType<typeof gitDeliveryFor>['delivery']; readonly nowMs?: () => number } = {},
) {
  return createFinalizationCompletionService({
    facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: () => NOW }),
    planner: plannerFor(f),
    atomic: createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW }),
    delivery: options.delivery ?? gitDeliveryFor(f).delivery,
    attempts: createSqliteAttemptAccess(f.box.session),
    readDeliveryConfig: () => ({ message: MESSAGE, gitIdentity: GIT_IDENTITY, deliveryPolicyDigest: DELIVERY_POLICY }),
    nowMs: options.nowMs ?? (() => NOW),
  });
}

function counts(f: EligibleFinalizationFixture) {
  return {
    runs: row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM runs')!.n,
    attempts: row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM attempts')!.n,
    runtimeStarts: row<{ n: number }>(f, 'SELECT runtime_starts AS n FROM execution_batches WHERE id = ?', f.ids.batchId)!.n,
    commits: Number(git(['rev-list', '--count', 'HEAD'], f.box.box.repoDirA, { home: f.box.box.homeDir }).trim()),
  };
}

function receiptResult(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || receipt.result === null || typeof receipt.result !== 'object') {
    throw new Error(`expected completed receipt: ${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, unknown>;
}

function approvePendingItem(f: EligibleFinalizationFixture): Promise<CommandReceipt> {
  const item = row<{ id: string; revision: number; plan_digest: string; code_digest: string }>(f,
    'SELECT id, revision, plan_digest, code_digest FROM task_approval_items WHERE status = ? LIMIT 1', 'pending');
  if (item === undefined) throw new Error('pending approval item missing');
  return f.box.submit('task.approval.approve', {
    taskId: 't-1', itemId: item.id, planDigest: item.plan_digest, codeDigest: item.code_digest,
    artifactRefs: [], reason: 'human approval released',
  }, { scope: f.box.scope, expectedRevision: item.revision });
}

async function resumeRun(f: EligibleFinalizationFixture, runId: string): Promise<void> {
  const run = row<{ revision: number }>(f, 'SELECT revision FROM runs WHERE id = ?', runId)!;
  const receipt = await f.box.submit('execution.resume', { runId, batchId: null },
    { scope: f.box.scope, expectedRevision: run.revision });
  receiptResult(receipt);
}

function hook(f: EligibleFinalizationFixture, body: string): void {
  const dir = join(f.inspection.repository.gitCommonDir, 'hooks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pre-commit');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function removeHook(f: EligibleFinalizationFixture): void {
  rmSync(join(f.inspection.repository.gitCommonDir, 'hooks', 'pre-commit'), { force: true });
}

describe('P03-9 / F-012 finalization completion', () => {
  it('无差异时记录 no_change 并 CAS 完成 Feature，不启动 Runtime、不新增提交', async () => {
    const f = await prepareEligibleFixture({ taskCount: 1, budget: retryBudget() });
    try {
      const runId = await createFinalizationRun(f);
      await verifyFinalization(f, runId);
      const before = counts(f);
      const result = await completionFor(f).execute({ projectId: f.box.projectId, runId });
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'no_change',
        reason: 'delivery_no_change',
        runStatus: 'succeeded',
        featureStatus: 'completed',
        deliveryStatus: 'succeeded',
        runtimeStarts: 0,
        newAttempts: 0,
      });
      expect(result.commit).toMatchObject({ status: 'no_change', deliveryStatus: 'succeeded', required: true });
      expect(counts(f)).toMatchObject({ runs: before.runs, attempts: before.attempts, runtimeStarts: before.runtimeStarts, commits: before.commits });
      expect(row(f, 'SELECT status, delivery_status FROM features WHERE id = ?', f.box.featureId))
        .toMatchObject({ status: 'completed', delivery_status: 'succeeded' });
      expect(row(f, 'SELECT status FROM runs WHERE id = ?', runId)).toMatchObject({ status: 'succeeded' });
    } finally { f.box.close(); }
  }, 60_000);

  it('审批缺失保持等待；批准命令只更新审批，显式 resume 后才提交并完成', async () => {
    const f = await prepareEligibleFixture({ taskCount: 1, budget: retryBudget(), approvalStatus: 'pending' });
    try {
      const runId = await createFinalizationRun(f);
      await verifyFinalization(f, runId);
      const before = counts(f);
      const waiting = await completionFor(f).execute({ projectId: f.box.projectId, runId });
      expect(waiting, JSON.stringify(waiting)).toMatchObject({
        status: 'awaiting_approval',
        runStatus: 'paused',
        featureStatus: 'awaiting_approval',
        runtimeStarts: 0,
        newAttempts: 0,
      });
      expect(row(f, 'SELECT COUNT(*) AS n FROM git_operations')!.n).toBe(0);
      expect(counts(f).commits).toBe(before.commits);

      const approved = await approvePendingItem(f);
      expect(approved.status).toBe('completed');
      expect(row(f, 'SELECT status FROM runs WHERE id = ?', runId)).toMatchObject({ status: 'paused' });
      expect(row(f, 'SELECT COUNT(*) AS n FROM git_operations')!.n).toBe(0);
      expect(counts(f).commits).toBe(before.commits);

      await resumeRun(f, runId);
      expect(row(f, 'SELECT status FROM runs WHERE id = ?', runId)).toMatchObject({ status: 'queued' });
      const completed = await completionFor(f).execute({ projectId: f.box.projectId, runId });
      expect(completed, JSON.stringify(completed)).toMatchObject({
        status: 'no_change',
        runStatus: 'succeeded',
        featureStatus: 'completed',
        deliveryStatus: 'succeeded',
        runtimeStarts: 0,
        newAttempts: 0,
      });
      expect(counts(f)).toMatchObject({ attempts: before.attempts, runtimeStarts: before.runtimeStarts });
    } finally { f.box.close(); }
  }, 60_000);

  it('提交失败不触发 Runtime；新 finalization Run 只重试失败提交并完成', async () => {
    const f = await prepareEligibleFixture({ taskCount: 1, budget: retryBudget() });
    try {
      await bindEvidenceToCurrentSource(f, 'export const project = "commit-failure";\n');
      const firstRun = await createFinalizationRun(f);
      await verifyFinalization(f, firstRun);
      const before = counts(f);
      hook(f, 'exit 1');
      const failed = await completionFor(f).execute({ projectId: f.box.projectId, runId: firstRun });
      expect(failed, JSON.stringify(failed)).toMatchObject({ status: 'commit_failed', runStatus: 'failed' });
      expect(row(f, 'SELECT status FROM features WHERE id = ?', f.box.featureId)).toMatchObject({ status: 'partial' });
      expect(counts(f)).toMatchObject({ runs: before.runs, attempts: before.attempts, runtimeStarts: before.runtimeStarts, commits: before.commits });
      expect(existsSync(f.box.box.repoDirA)).toBe(true);

      removeHook(f);
      const secondRun = await createFinalizationRun(f);
      await verifyFinalization(f, secondRun);
      const retried = await completionFor(f).execute({ projectId: f.box.projectId, runId: secondRun });
      expect(retried, JSON.stringify(retried)).toMatchObject({
        status: 'completed', runStatus: 'succeeded', featureStatus: 'completed', deliveryStatus: 'succeeded',
        runtimeStarts: 0, newAttempts: 0,
      });
      expect(tableRows<{ status: string }>(f, 'SELECT status FROM git_operations ORDER BY rowid'))
        .toEqual([{ status: 'failed' }, { status: 'succeeded' }]);
      expect(counts(f).commits).toBe(before.commits + 1);
      expect(counts(f).attempts).toBe(before.attempts);
    } finally { f.box.close(); }
  }, 180_000);

  it('提交成功但回执丢失：不重复提交，只按真实 Git 事实核对并复用', async () => {
    const f = await prepareEligibleFixture({ taskCount: 1, budget: retryBudget() });
    try {
      await bindEvidenceToCurrentSource(f, 'export const project = "finalization-delivery";\n');
      const firstRun = await createFinalizationRun(f);
      await verifyFinalization(f, firstRun);
      const before = counts(f);
      f.box.session.database.exec(`CREATE TRIGGER receipt_fault BEFORE UPDATE ON git_operations
        WHEN NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'injected receipt fault'); END`);
      const lost = await completionFor(f).execute({ projectId: f.box.projectId, runId: firstRun });
      expect(lost, JSON.stringify(lost)).toMatchObject({ status: 'reconcile_required', runStatus: 'failed' });
      expect(counts(f).commits).toBe(before.commits + 1);
      f.box.session.database.exec('DROP TRIGGER receipt_fault');
      expect(row(f, 'SELECT status FROM git_operations ORDER BY rowid DESC LIMIT 1')).toMatchObject({ status: 'pending' });
      const probe = await plannerFor(f).prepare({
        projectId: f.box.projectId, featureId: f.box.featureId, historicalRunId: f.ids.runId,
        workKey: retryPayload(f).workKey,
      });
      expect(probe, JSON.stringify(probe)).toMatchObject({ status: 'eligible', plan: { revalidateTasks: [], finalVerification: { required: false } } });

      const retryRun = await createFinalizationRun(f);
      await verifyFinalization(f, retryRun);
      const reconciled = await completionFor(f).execute({ projectId: f.box.projectId, runId: retryRun });
      expect(reconciled, JSON.stringify(reconciled)).toMatchObject({
        status: 'completed', runStatus: 'succeeded', featureStatus: 'completed', deliveryStatus: 'succeeded',
        runtimeStarts: 0, newAttempts: 0,
      });
      expect(reconciled.commit).toMatchObject({ reused: true, status: 'succeeded' });
      expect(counts(f).commits).toBe(before.commits + 1);
      expect(counts(f).attempts).toBe(before.attempts);
    } finally { f.box.close(); }
  }, 90_000);

  it('hook 修改源码时等待重验/诊断，不 reset 代码、不标记 completed', async () => {
    const f = await prepareEligibleFixture({ taskCount: 1, budget: retryBudget() });
    try {
      await bindEvidenceToCurrentSource(f, 'export const project = "hook-source";\n');
      const runId = await createFinalizationRun(f);
      await verifyFinalization(f, runId);
      hook(f, 'printf "hook changed source\\n" > src/a.ts');
      const result = await completionFor(f).execute({ projectId: f.box.projectId, runId });
      expect(result.status).not.toBe('completed');
      expect(result.status).not.toBe('no_change');
      expect(row(f, 'SELECT status FROM features WHERE id = ?', f.box.featureId)).not.toMatchObject({ status: 'completed' });
      expect(readFileSync(join(f.box.box.repoDirA, 'src/a.ts'), 'utf8')).toContain('hook changed source');
    } finally { f.box.close(); }
  }, 60_000);

  it('提交后取消竞争或旧回执不得覆盖当前终态', async () => {
    const f = await prepareEligibleFixture({ taskCount: 1, budget: retryBudget() });
    try {
      await bindEvidenceToCurrentSource(f, 'export const project = "cancel-race";\n');
      const runId = await createFinalizationRun(f);
      await verifyFinalization(f, runId);
      const real = gitDeliveryFor(f).delivery;
      const cancelling = {
        readOperation: real.readOperation,
        verifyOperation: real.verifyOperation,
        reconcile: real.reconcile,
        async commit(request: Parameters<typeof real.commit>[0]) {
          const operation = await real.commit(request);
          f.box.session.database.prepare("UPDATE runs SET status = 'cancelling', revision = revision + 1 WHERE id = ?").run(runId);
          return operation;
        },
      };
      const first = await completionFor(f, { delivery: cancelling }).execute({ projectId: f.box.projectId, runId });
      expect(first.status).toBe('control_interrupted');
      expect(row(f, 'SELECT status FROM runs WHERE id = ?', runId)).toMatchObject({ status: 'cancelling' });
      expect(row(f, 'SELECT status FROM features WHERE id = ?', f.box.featureId)).not.toMatchObject({ status: 'completed' });
      const second = await completionFor(f).execute({ projectId: f.box.projectId, runId });
      expect(second.status).toBe('control_interrupted');
      expect(row(f, 'SELECT status FROM runs WHERE id = ?', runId)).toMatchObject({ status: 'cancelling' });
      expect(row(f, 'SELECT status FROM features WHERE id = ?', f.box.featureId)).not.toMatchObject({ status: 'completed' });
    } finally { f.box.close(); }
  }, 60_000);

  it('外部 HEAD 漂移时不得完成', async () => {
    const f = await prepareEligibleFixture({ taskCount: 1, budget: retryBudget() });
    try {
      const runId = await createFinalizationRun(f);
      await verifyFinalization(f, runId);
      git(['-c', 'user.name=External', '-c', 'user.email=external@example.test', 'commit', '--allow-empty', '-m', 'external drift'],
        f.box.box.repoDirA, { home: f.box.box.homeDir });
      const result = await completionFor(f).execute({ projectId: f.box.projectId, runId });
      expect(result.status).toBe('invalidated');
      expect(row(f, 'SELECT status FROM features WHERE id = ?', f.box.featureId)).not.toMatchObject({ status: 'completed' });
    } finally { f.box.close(); }
  }, 60_000);

  it('非 finalization Run 不执行审批/提交', async () => {
    const f = await openFinalizationFixture({ taskCount: 1 });
    try {
      const run = row<{ id: string }>(f, 'SELECT id FROM runs LIMIT 1')!;
      const delivery = {
        readOperation: vi.fn(),
        verifyOperation: vi.fn(),
        commit: vi.fn(),
        reconcile: vi.fn(),
      };
      const result = await createFinalizationCompletionService({
        facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: () => NOW }),
        planner: { prepare: vi.fn() },
        atomic: createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW }),
        delivery,
        attempts: createSqliteAttemptAccess(f.box.session),
        nowMs: () => NOW,
      }).execute({ projectId: f.box.projectId, runId: run.id });
      expect(result.status).toBe('not_finalization_run');
      expect(delivery.commit).not.toHaveBeenCalled();
      expect(delivery.reconcile).not.toHaveBeenCalled();
    } finally { f.box.close(); }
  }, 60_000);
});
