/**
 * P03-9 / F-008 显式工作流 resume。
 *
 * 聚焦验收（真实临时 SQLite/Git/worktree 检查器，零模型调用）：
 * - 只对可继续的非终态 Run/Batch 重新授权；终态/取消/运行中/活动占用/证据失效/
 *   预算耗尽/worktree 缺失均不解除暂停、不唤醒、不启动 Runtime，并保留可查询原因；
 * - 同 commandId 重放返回原回执且不重复事件/唤醒；不同 commandId 竞争由目标
 *   revision 与恢复后状态拒绝；
 * - 解除暂停本身不创建 Attempt/Session/worktree、不重置累计计数；真正的新 Attempt
 *   仍由既有 claim/预算链路原子创建；
 * - 同 Task 在原 worktree 增量继续；已 passed 且证据有效的 Task 不重编码；
 * - 全 passed 进入收尾、仅人审缺失进入 approval 缺失步骤而非编码。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { TrustedPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { AttemptRecord } from '../../../packages/core/src/ports/attempt-store.ts';
import type { AppCapability, CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { git } from '../../helpers/git-repo.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';

type Fixture = Awaited<ReturnType<typeof openClaimFixture>>;
type TargetPayload = { readonly runId: string; readonly batchId: null } | { readonly runId: null; readonly batchId: string };

const stopVerifier = createWorkResourceStopVerifier({
  process: { recoverStop: async () => ({ confirmed: true }) },
  finalize: async () => true,
});

const lifecycle = (f: Fixture) =>
  createSqliteAttemptLifecycleStore(f.box.session, {
    workspaceAuthority: f.authority, nowUtcMs: () => NOW + 1, stopVerifier,
  });
const resources = (f: Fixture) =>
  createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });

const readRun = (f: Fixture, runId: string) =>
  f.box.session.database.prepare(
    'SELECT id, status, reason, revision, pause_requested_at, ended_at, attempts_created FROM runs WHERE id = ?',
  ).get(runId) as { id: string; status: string; reason: string | null; revision: number;
    pause_requested_at: number | null; ended_at: number | null; attempts_created: number };

const readBatch = (f: Fixture, batchId: string) =>
  f.box.session.database.prepare(
    'SELECT id, status, reason, revision, pause_requested_at, deadline_at, budget_revision, budget_snapshot, ' +
    'runs_created, attempts_created, runtime_starts FROM execution_batches WHERE id = ?',
  ).get(batchId) as { id: string; status: string; reason: string | null; revision: number;
    pause_requested_at: number | null; deadline_at: number; budget_revision: number; budget_snapshot: string;
    runs_created: number; attempts_created: number; runtime_starts: number };

const envelope = (f: Fixture, operation: 'execution.pause' | 'execution.resume', payload: TargetPayload,
  expectedRevision: number, commandId: string = randomUUID()) => ({
  schemaVersion: 5 as const, commandId, issuedAt: new Date(NOW).toISOString(),
  operation, scope: f.box.scope, expectedRevision, payload,
});

const submit = (f: Fixture, operation: 'execution.pause' | 'execution.resume', payload: TargetPayload,
  expectedRevision: number, commandId?: string) =>
  f.box.services.commands.submit(f.box.owner, envelope(f, operation, payload, expectedRevision, commandId));

function resultOf(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || !('result' in receipt)) {
    throw new Error(`Expected completed receipt, got ${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, unknown>;
}

const resumeEvents = (f: Fixture) =>
  f.box.session.database.prepare(
    "SELECT event_type, aggregate_type, aggregate_id, aggregate_revision FROM state_events " +
    "WHERE event_type IN ('execution.run.resumed', 'execution.batch.resumed') ORDER BY sequence",
  ).all() as { event_type: string; aggregate_type: string; aggregate_id: string; aggregate_revision: number }[];

async function pauseRun(f: Fixture): Promise<number> {
  const current = readRun(f, f.ids.runId);
  const receipt = await submit(f, 'execution.pause', { runId: f.ids.runId, batchId: null }, current.revision);
  expect(resultOf(receipt)).toMatchObject({ outcome: 'paused' });
  return readRun(f, f.ids.runId).revision;
}

function seedVerification(f: Fixture, attempt: AttemptRecord, taskId: string, codeDigest: string): string {
  f.box.session.database.prepare('UPDATE attempts SET code_ref = ? WHERE id = ?').run(`${taskId}-code`, attempt.id);
  const snapshot = JSON.parse((f.box.session.database.prepare(
    'SELECT input_snapshot FROM attempts WHERE id = ?').get(attempt.id) as { input_snapshot: string }).input_snapshot) as
    { approval: { checkPolicyDigest: string } };
  const batchId = `${attempt.id}-batch`;
  f.box.session.database.prepare(
    `INSERT INTO verification_batches (id, created_at, project_id, updated_at, feature_id, run_id, task_id,
       attempt_id, execution_version, operation, code_digest, policy_digest, environment_summary,
       check_snapshot, selection, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tests', ?, ?, '{}', '[{"checkKey":"tests"}]', '{}', 'passed', ?, ?)`,
  ).run(batchId, NOW, attempt.projectId, NOW, attempt.featureId, attempt.runId, taskId,
    attempt.id, attempt.executionVersion, codeDigest, snapshot.approval.checkPolicyDigest, NOW, NOW + 1);
  f.box.session.database.prepare(`INSERT INTO check_results
    (id, created_at, updated_at, project_id, batch_id, check_key, argv_json, timeout_ms,
     required, status, exit_code, timed_out, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, 'tests', '["tests"]', 1000, 1, 'passed', 0, 0, ?, ?)`)
    .run(`${attempt.id}-check`, NOW, NOW, attempt.projectId, batchId, NOW, NOW + 1);
  // F-012 的验证提交需要已有的 ready code artifact 和不可变 task_commit receipt。
  // 这里仍是零模型的本地夹具，只补齐受信提交链路所需的身份事实。
  const binding = createSqliteStateAccess(f.box.session).getRepositoryBinding(f.box.projectId);
  const head = git(['rev-parse', 'HEAD'], f.box.box.repoDirA, { home: f.box.box.homeDir }).trim();
  const tree = git(['rev-parse', 'HEAD^{tree}'], f.box.box.repoDirA, { home: f.box.box.homeDir }).trim();
  f.box.session.database.prepare(
    `INSERT INTO artifacts
      (id, created_at, project_id, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, storage_locator)
     VALUES (?, ?, ?, ?, 'code', 'ready', 'text/plain', ?, ?, 0, ?)
     ON CONFLICT(project_id, id) DO UPDATE SET status = 'ready', content_hash = excluded.content_hash,
       size_bytes = excluded.size_bytes, updated_at = excluded.updated_at`)
    .run(`${taskId}-code`, NOW, attempt.projectId, NOW, 'a'.repeat(64), 'a'.repeat(64), `code/${taskId}`);
  const operationId = `${attempt.id}-task-commit`;
  const verificationRefs = JSON.stringify([{ kind: 'verification_batch', id: batchId, digest: codeDigest }]);
  f.box.session.database.prepare(
    `INSERT INTO git_operations
      (id, created_at, updated_at, project_id, feature_id, run_id, attempt_id, execution_version,
       operation_type, repository_binding_id, repo_identity, worktree_path, expected_head, candidate_tree,
       code_digest, verification_refs, approval_refs, message, identity_name, identity_email,
       delivery_policy_digest, runtime_source, owner_id, host_instance_id, intent_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'task_commit', ?, ?, ?, ?, ?, ?, ?, '[]', 'Fixture task commit',
       'Fixture', 'fixture@example.com', ?, NULL, ?, ?, ?)`)
    .run(operationId, NOW, NOW, attempt.projectId, attempt.featureId, attempt.runId, attempt.id,
      attempt.executionVersion, binding.id, binding.repoIdentity, f.box.box.repoDirA, head, tree, codeDigest,
      verificationRefs, 'd'.repeat(64), attempt.owner, attempt.hostInstanceId, 'e'.repeat(64));
  f.box.session.database.prepare(
    `UPDATE git_operations SET status = 'succeeded', actual_commit = ?, actual_tree = ?, exit_code = 0,
       duration_ms = 1, receipt = ?, delivery_status = 'not_requested', settled_at = ?, updated_at = ? WHERE id = ?`)
    .run(head, tree, JSON.stringify({ status: 'succeeded', actualCommit: head, actualTree: tree }), NOW + 1, NOW + 1, operationId);
  return batchId;
}

async function claimAndPass(f: Fixture, index: number, taskId: string): Promise<AttemptRecord> {
  const attempt = f.store().claimTask({ ...f.input(index), claimKey: randomUUID() }).receipt.attempt;
  const identity = { projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
  const notification = { ...identity, taskId: attempt.taskId, runId: attempt.runId };
  f.box.session.transactWrite('launch', () => {
    createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
      projectId: attempt.projectId, batchId: f.ids.batchId, runId: attempt.runId, startKey: attempt.id,
    });
    resources(f).beginLaunchInTransaction(identity);
    resources(f).confirmLaunchInTransaction(identity, {
      launchId: '10000000-0000-4000-8000-000000000001', pid: 123, processGroupId: 123, startTime: 'start-1',
    });
  });
  lifecycle(f).apply({ ...notification, notificationId: 'started', kind: 'executing' });
  const token = await stopVerifier.verify(resources(f).read(identity));
  const completed = lifecycle(f).apply({ ...notification, notificationId: 'complete',
    kind: 'runtime_completed', exitCode: 0, evidenceRef: attempt.inputRef }, token);
  if (completed.status !== 'verifying') throw new Error(`fixture verification advance failed: ${JSON.stringify(completed)}`);
  const codeDigest = 'cd'.repeat(32);
  const verificationBatchId = seedVerification(f, attempt, taskId, codeDigest);
  const verification = lifecycle(f).submitVerification({
    projectId: attempt.projectId, attemptId: attempt.id, taskId, runId: attempt.runId,
    owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
    verificationBatchId, codeDigest, observationDigest: 'ef'.repeat(32), outcome: 'passed',
  }, token);
  if (verification.status !== 'succeeded') throw new Error(`fixture task pass failed: ${JSON.stringify(verification)}`);
  return attempt;
}

function insertManagedWorkspace(f: Fixture, attempt: AttemptRecord): string {
  const binding = createSqliteStateAccess(f.box.session).getRepositoryBinding(f.box.projectId);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.box.box.repoDirA, { home: f.box.box.homeDir }).trim();
  const head = f.box.box.gitHead('A');
  const id = randomUUID();
  f.box.session.database.prepare(
    `INSERT INTO managed_workspaces (id, created_at, project_id, revision, updated_at, feature_id,
       repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir,
       branch, base_commit, head_commit, code_digest, status, preparation_operation_id,
       owner_id, host_instance_id, execution_version, run_id, attempt_id)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retained', ?, ?, ?, ?, ?, ?)`,
  ).run(id, NOW, f.box.projectId, NOW, attempt.featureId, binding.id, binding.bindingRevision,
    binding.repoIdentity, binding.canonicalPath, binding.gitCommonDir ?? `${binding.canonicalPath}/.git`,
    branch, head, head, 'ab'.repeat(32), `prep-${id}`, attempt.owner, attempt.hostInstanceId,
    attempt.executionVersion, attempt.runId, attempt.id);
  return id;
}

function expectRejected(receipt: CommandReceipt, reason: string): void {
  expect(receipt.status).toBe('rejected');
  if (receipt.status !== 'rejected') throw new Error('unreachable');
  expect(receipt.operation).toBe('execution.resume');
  expect(receipt.error).toMatchObject({ code: 'conflict', details: { reason } });
}

describe('P03-9 / F-008 显式工作流 resume', () => {
  it('暂停中的 Run 重新授权后解除暂停、写事件/回执并唤醒；resume 本身不创建 Attempt/worktree', async () => {
    const f = await openClaimFixture();
    try {
      const batchBefore = readBatch(f, f.ids.batchId);
      const revision = await pauseRun(f);
      const attemptsBefore = (f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n;
      const workspacesBefore = (f.box.session.database.prepare('SELECT COUNT(*) AS n FROM managed_workspaces').get() as { n: number }).n;
      const signalsBefore = f.box.services.signals.length;

      const receipt = await submit(f, 'execution.resume', { runId: f.ids.runId, batchId: null }, revision);
      expect(resultOf(receipt)).toMatchObject({
        resumed: true, targetKind: 'run', runIds: [f.ids.runId], status: 'queued',
        resumeScope: 'coding', nextTaskIds: ['t-1'], runtimeStarts: 0, attemptsCreated: 0,
      });
      expect(readRun(f, f.ids.runId)).toMatchObject({ status: 'queued', reason: null, pause_requested_at: null });
      expect(readBatch(f, f.ids.batchId)).toMatchObject({ status: 'running', pause_requested_at: null });
      expect(resumeEvents(f)).toEqual([
        { event_type: 'execution.run.resumed', aggregate_type: 'run', aggregate_id: f.ids.runId, aggregate_revision: revision + 1 },
        { event_type: 'execution.batch.resumed', aggregate_type: 'execution_batch', aggregate_id: f.ids.batchId,
          aggregate_revision: readBatch(f, f.ids.batchId).revision },
      ]);
      expect((f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n)
        .toBe(attemptsBefore);
      expect((f.box.session.database.prepare('SELECT COUNT(*) AS n FROM managed_workspaces').get() as { n: number }).n)
        .toBe(workspacesBefore);
      expect(f.box.services.signals.length).toBe(signalsBefore + 1);
      const batchAfter = readBatch(f, f.ids.batchId);
      expect(batchAfter).toMatchObject({
        deadline_at: batchBefore.deadline_at, budget_revision: batchBefore.budget_revision,
        budget_snapshot: batchBefore.budget_snapshot, runs_created: batchBefore.runs_created,
        attempts_created: batchBefore.attempts_created, runtime_starts: batchBefore.runtime_starts,
      });

      // 真正的新 Attempt 仍由既有 claim 链路原子创建（预算预占/租约/计数）。
      const claimed = f.store().claimTask({ ...f.input(0), claimKey: randomUUID() });
      expect(claimed.replayed).toBe(false);
      expect(claimed.receipt.attempt.runId).toBe(f.ids.runId);
      expect(readBatch(f, f.ids.batchId).attempts_created).toBe(batchBefore.attempts_created + 1);
    } finally { f.box.close(); }
  });

  it('F-006 恢复现场留下的 paused/restart_recovery（无 pause 意图列）也可显式 resume', async () => {
    const f = await openClaimFixture();
    try {
      await pauseRun(f);
      f.box.session.database.prepare("UPDATE runs SET reason = 'restart_recovery', pause_requested_at = NULL WHERE id = ?")
        .run(f.ids.runId);
      const revision = readRun(f, f.ids.runId).revision;
      const receipt = await submit(f, 'execution.resume', { runId: f.ids.runId, batchId: null }, revision);
      expect(resultOf(receipt)).toMatchObject({ resumed: true, status: 'queued', resumeScope: 'coding' });
      expect(readRun(f, f.ids.runId)).toMatchObject({ status: 'queued', reason: null, pause_requested_at: null });
    } finally { f.box.close(); }
  });

  it('同 commandId 重放返回原回执且不重复事件/唤醒；不同 commandId 竞争被 revision/状态拒绝', async () => {
    const f = await openClaimFixture();
    try {
      const revision = await pauseRun(f);
      const commandId = randomUUID();
      const first = await submit(f, 'execution.resume', { runId: f.ids.runId, batchId: null }, revision, commandId);
      expect(first.status).toBe('completed');
      const runAfter = readRun(f, f.ids.runId);
      const eventsAfter = resumeEvents(f);
      const signalsAfter = f.box.services.signals.length;
      const receiptsAfter = (f.box.session.database.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }).n;

      const replay = await submit(f, 'execution.resume', { runId: f.ids.runId, batchId: null }, revision, commandId);
      expect(replay).toMatchObject({ commandId, status: 'completed', replayed: true, result: resultOf(first) });
      expect(readRun(f, f.ids.runId)).toEqual(runAfter);
      expect(resumeEvents(f)).toEqual(eventsAfter);
      expect(f.box.services.signals.length).toBe(signalsAfter);
      expect((f.box.session.database.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }).n)
        .toBe(receiptsAfter);

      const competing = await submit(f, 'execution.resume', { runId: f.ids.runId, batchId: null }, revision);
      expectRejected(competing, 'not_resumable');
      expect(readRun(f, f.ids.runId)).toEqual(runAfter);
      expect(resumeEvents(f)).toEqual(eventsAfter);
      expect(f.box.services.signals.length).toBe(signalsAfter);
    } finally { f.box.close(); }
  });

  it('终态取消与仍在运行的 Run 不复活、不解除暂停，也不产生 resume 事件/唤醒', async () => {
    const f = await openClaimFixture();
    try {
      const revision = await pauseRun(f);
      // F-002 的取消路径已由既有测试覆盖；这里直接构造取消终态，验证 resume 不复活。
      f.box.session.database.prepare("UPDATE runs SET status = 'cancelled', reason = 'user_cancel', ended_at = ? WHERE id = ?")
        .run(NOW, f.ids.runId);
      expect(readRun(f, f.ids.runId).status).toBe('cancelled');
      const eventsBefore = resumeEvents(f);
      const signalsBefore = f.box.services.signals.length;
      const receipt = await submit(f, 'execution.resume', { runId: f.ids.runId, batchId: null }, revision + 1);
      expectRejected(receipt, 'already_terminal');
      expect(readRun(f, f.ids.runId).status).toBe('cancelled');
      expect(resumeEvents(f)).toEqual(eventsBefore);
      expect(f.box.services.signals.length).toBe(signalsBefore);

      // 新运行中的 Run 不能被 resume 当作暂停目标。
      const fresh = await openClaimFixture();
      try {
        const running = await submit(fresh, 'execution.resume', { runId: fresh.ids.runId, batchId: null }, 1);
        expectRejected(running, 'not_resumable');
        expect(readRun(fresh, fresh.ids.runId).status).toBe('queued');
      } finally { fresh.box.close(); }
    } finally { f.box.close(); }
  });

  it('授权失效、预算耗尽与历史工作区缺失均拒绝且无 Runtime/新 Attempt/事件', async () => {
    const auth = await openClaimFixture();
    try {
      const revision = await pauseRun(auth);
      auth.box.session.database.prepare("UPDATE features SET plan_status = 'draft' WHERE id = ?").run(auth.box.featureId);
      const eventsBefore = resumeEvents(auth);
      const signalsBefore = auth.box.services.signals.length;
      const attemptsBefore = (auth.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n;
      const receipt = await submit(auth, 'execution.resume', { runId: auth.ids.runId, batchId: null }, revision);
      expectRejected(receipt, 'authorization_invalid');
      expect(readRun(auth, auth.ids.runId)).toMatchObject({ status: 'paused', pause_requested_at: NOW });
      expect(resumeEvents(auth)).toEqual(eventsBefore);
      expect(auth.box.services.signals.length).toBe(signalsBefore);
      expect((auth.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n)
        .toBe(attemptsBefore);
    } finally { auth.box.close(); }

    const budget = await openClaimFixture();
    try {
      const revision = await pauseRun(budget);
      const batch = readBatch(budget, budget.ids.batchId);
      budget.box.session.database.prepare('UPDATE execution_batches SET runtime_starts = 2 WHERE id = ?')
        .run(budget.ids.batchId);
      const eventsBefore = resumeEvents(budget);
      const signalsBefore = budget.box.services.signals.length;
      const receipt = await submit(budget, 'execution.resume', { runId: budget.ids.runId, batchId: null }, revision);
      expectRejected(receipt, 'budget_exhausted');
      expect(readRun(budget, budget.ids.runId)).toMatchObject({ status: 'paused', pause_requested_at: NOW });
      expect(readBatch(budget, budget.ids.batchId)).toMatchObject({
        runtime_starts: 2, budget_revision: batch.budget_revision, budget_snapshot: batch.budget_snapshot,
      });
      expect(resumeEvents(budget)).toEqual(eventsBefore);
      expect(budget.box.services.signals.length).toBe(signalsBefore);
    } finally { budget.box.close(); }

    const workspace = await openClaimFixture();
    try {
      const attempt = workspace.store().claimTask({ ...workspace.input(0), claimKey: randomUUID() }).receipt.attempt;
      workspace.box.session.database.prepare("UPDATE attempts SET status = 'failed', ended_at = ?, error_kind = 'runtime_error' WHERE id = ?")
        .run(NOW, attempt.id);
      workspace.box.session.database.prepare('DELETE FROM workspace_leases WHERE owner_id = ?').run(attempt.id);
      workspace.box.session.database.prepare("UPDATE tasks SET status = 'pending' WHERE id = ?").run(attempt.taskId);
      const revision = await pauseRun(workspace);
      const eventsBefore = resumeEvents(workspace);
      const signalsBefore = workspace.box.services.signals.length;
      const receipt = await submit(workspace, 'execution.resume', { runId: workspace.ids.runId, batchId: null }, revision);
      expectRejected(receipt, 'workspace_invalid');
      expect(readRun(workspace, workspace.ids.runId)).toMatchObject({ status: 'paused', pause_requested_at: NOW });
      expect(resumeEvents(workspace)).toEqual(eventsBefore);
      expect(workspace.box.services.signals.length).toBe(signalsBefore);
    } finally { workspace.box.close(); }
  });

  it('同 Task 原 worktree 增量继续：passed Task 不重编码，新 Attempt/预算由既有 claim 原子创建且累计计数不重置', async () => {
    const f = await openClaimFixture([[], []]);
    try {
      const passedAttempt = await claimAndPass(f, 0, 't-1');
      const workspaceId = insertManagedWorkspace(f, passedAttempt);
      const batchBefore = readBatch(f, f.ids.batchId);
      const revision = await pauseRun(f);
      const receipt = await submit(f, 'execution.resume', { runId: f.ids.runId, batchId: null }, revision);
      expect(resultOf(receipt)).toMatchObject({ resumeScope: 'coding', nextTaskIds: ['t-2'] });
      expect(f.box.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1')).toEqual({ status: 'passed' });
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?').get('t-1'))
        .toEqual({ n: 1 });
      expect(f.box.session.database.prepare('SELECT id, status FROM managed_workspaces WHERE feature_id = ?')
        .get(f.box.featureId)).toEqual({ id: workspaceId, status: 'retained' });

      const claimed = f.store().claimTask({ ...f.input(1), claimKey: randomUUID() });
      expect(claimed.receipt.attempt.taskId).toBe('t-2');
      expect(claimed.receipt.attempt.number).toBe(1);
      expect(readBatch(f, f.ids.batchId)).toMatchObject({
        runs_created: batchBefore.runs_created,
        attempts_created: batchBefore.attempts_created + 1,
        budget_revision: batchBefore.budget_revision,
        budget_snapshot: batchBefore.budget_snapshot,
        deadline_at: batchBefore.deadline_at,
      });
      expect(readRun(f, f.ids.runId).attempts_created).toBe(batchBefore.attempts_created + 1);
      expect(f.box.session.database.prepare('SELECT status FROM attempts WHERE id = ?').get(passedAttempt.id))
        .toEqual({ status: 'succeeded' });
    } finally { f.box.close(); }
  });

  it('全 passed 进入收尾、仅人审缺失进入 approval 缺失步骤；resume 不发起编码认领', async () => {
    const complete = await openClaimFixture();
    try {
      const passedAttempt = await claimAndPass(complete, 0, 't-1');
      insertManagedWorkspace(complete, passedAttempt);
      const revision = await pauseRun(complete);
      const attemptsBefore = (complete.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n;
      const receipt = await submit(complete, 'execution.resume', { runId: complete.ids.runId, batchId: null }, revision);
      expect(resultOf(receipt)).toMatchObject({ resumeScope: 'final_verification', nextTaskIds: [] });
      expect((complete.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n)
        .toBe(attemptsBefore);
    } finally { complete.box.close(); }

    const approval = await openClaimFixture();
    try {
      approval.box.session.database.prepare("UPDATE tasks SET manual_block = 1 WHERE id = 't-1'").run();
      const revision = await pauseRun(approval);
      const signalsBefore = approval.box.services.signals.length;
      const receipt = await submit(approval, 'execution.resume', { runId: approval.ids.runId, batchId: null }, revision);
      expect(resultOf(receipt)).toMatchObject({ resumeScope: 'approval', nextTaskIds: [] });
      expect(approval.box.services.signals.length).toBe(signalsBefore);
      expect((approval.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n)
        .toBe(0);
    } finally { approval.box.close(); }
  });

  it('无权限主体不能 resume；Batch 目标可解除 Batch 与 Run 暂停', async () => {
    const f = await openClaimFixture();
    try {
      const revision = await pauseRun(f);
      const viewer: TrustedPrincipal = Object.freeze({
        principalId: 'viewer', capabilities: new Set<AppCapability>(),
        projectScope: Object.freeze({ kind: 'all' }) as TrustedPrincipal['projectScope'],
      });
      await expect(f.box.services.commands.submit(viewer,
        envelope(f, 'execution.resume', { runId: f.ids.runId, batchId: null }, revision)))
        .rejects.toMatchObject({ code: 'forbidden', operation: 'execution.resume' });

      const batchRevision = await submit(f, 'execution.pause', { runId: null, batchId: f.ids.batchId }, 1)
        .then(receipt => expect(receipt.status).toBe('completed'))
        .then(() => readBatch(f, f.ids.batchId).revision);
      const resumed = await submit(f, 'execution.resume', { runId: null, batchId: f.ids.batchId }, batchRevision);
      expect(resultOf(resumed)).toMatchObject({
        targetKind: 'batch', runIds: [f.ids.runId], resumeScope: 'coding', status: 'running',
      });
      expect(readBatch(f, f.ids.batchId)).toMatchObject({ status: 'running', pause_requested_at: null });
      expect(readRun(f, f.ids.runId)).toMatchObject({ status: 'queued', pause_requested_at: null });
    } finally { f.box.close(); }
  });
});
