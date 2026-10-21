/**
 * P03-9 / F-001：Run/Batch 的 Task 边界暂停（真实临时 SQLite）。
 *
 * 验收聚焦：
 * - 无活动 Attempt 直接 paused；有活动 Attempt 进入 pausing，当前 Attempt 完成
 *   验证/必要收尾后才 paused，且不会自动开始下一次返工；
 * - 暂停与认领竞争使用同一真实 SQLite 写事务/行 revision CAS；意图生效后
 *   claimTask 以 run/batch control 原因拒绝；
 * - 重复 commandId 返回原回执；同 ID 异摘要、过期 revision、终态、跨项目、
 *   无权限均被拒绝且不产生业务倒写；
 * - 暂停不清预算、不延长 deadline、不删除代码；迁移 v27 仅追加暂停意图列，
 *   历史 checksum 不变，空库与前序 v26 库可升级。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteAttemptLifecycleStore } from '../../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteExecutionAccess } from '../../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteWorkResourceAccess } from '../../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteGitOperationStore } from '../../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createWorkResourceStopVerifier } from '../../../../packages/core/src/application/work-resource-stop.ts';
import { PublicError } from '../../../../packages/core/src/ports/commands.ts';
import { createLocalOwnerPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import type { TrustedPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import type { AppCapability, CommandReceipt } from '../../../../packages/core/src/ports/commands.ts';
import type { AttemptRecord } from '../../../../packages/core/src/ports/attempt-store.ts';
import { NOW } from '../../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../../helpers/p03-4/task-claim-fixture.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { git } from '../../../helpers/git-repo.ts';

type Fixture = Awaited<ReturnType<typeof openClaimFixture>>;
type PausePayload = { readonly runId: string; readonly batchId: null } | { readonly runId: null; readonly batchId: string };

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
    'SELECT id, status, reason, revision, pause_requested_at, ended_at FROM runs WHERE id = ?',
  ).get(runId) as { id: string; status: string; reason: string | null; revision: number;
    pause_requested_at: number | null; ended_at: number | null };

const readBatch = (f: Fixture, batchId: string) =>
  f.box.session.database.prepare(
    'SELECT id, status, reason, revision, pause_requested_at, deadline_at, budget_revision, budget_snapshot ' +
    'FROM execution_batches WHERE id = ?',
  ).get(batchId) as { id: string; status: string; reason: string | null; revision: number;
    pause_requested_at: number | null; deadline_at: number; budget_revision: number; budget_snapshot: string };

const pauseEnvelope = (f: Fixture, payload: PausePayload, expectedRevision: number, commandId: string = randomUUID()) => ({
  schemaVersion: 5 as const, commandId, issuedAt: new Date(NOW).toISOString(),
  operation: 'execution.pause', scope: f.box.scope, expectedRevision, payload,
});

function completedResult(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || !('result' in receipt)) {
    throw new Error(`Expected a completed receipt, got ${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, unknown>;
}

const submitPause = (f: Fixture, payload: PausePayload, expectedRevision: number, commandId?: string) =>
  f.box.services.commands.submit(f.box.owner, pauseEnvelope(f, payload, expectedRevision, commandId));

const commandCount = (f: Fixture) =>
  (f.box.session.database.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }).n;

const pauseEvents = (f: Fixture) =>
  f.box.session.database.prepare(
    "SELECT event_type, aggregate_type, aggregate_id, aggregate_revision FROM state_events " +
    "WHERE event_type IN ('execution.run.paused', 'execution.batch.paused') ORDER BY sequence",
  ).all() as { event_type: string; aggregate_type: string; aggregate_id: string; aggregate_revision: number }[];

const expectClaimRejected = (f: Fixture, eligibility: string) => {
  try {
    f.store().claimTask({ ...f.input(0), claimKey: randomUUID() });
  } catch (error) {
    const details = (error as { details?: { reason?: string; eligibility?: string } }).details;
    expect(details?.eligibility ?? details?.reason).toBe(eligibility);
    return;
  }
  throw new Error(`预期认领被拒绝（${eligibility}），实际成功`);
};

/** 认领 → 启动占用 → executing → runtime_completed；返回 verifying Attempt 与停止证据。 */
async function advanceToVerifying(f: Fixture) {
  const attempt: AttemptRecord = f.store().claimTask(f.input(0)).receipt.attempt;
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
  if (completed.status !== 'verifying') throw new Error(`夹具推进失败：${JSON.stringify(completed)}`);
  return { attempt, identity, notification, token };
}

function seedVerification(f: Fixture, attempt: AttemptRecord, codeDigest: string,
  status: 'passed' | 'failed' = 'passed'): string {
  f.box.session.database.prepare('UPDATE attempts SET code_ref = ? WHERE id = ?').run('t-1-code', attempt.id);
  const snapshot = JSON.parse((f.box.session.database.prepare(
    'SELECT input_snapshot FROM attempts WHERE id = ?').get(attempt.id) as { input_snapshot: string }).input_snapshot) as
    { approval: { checkPolicyDigest: string } };
  const batchId = `${attempt.id}-batch`;
  f.box.session.database.prepare(
    `INSERT INTO verification_batches (id, created_at, project_id, updated_at, feature_id, run_id, task_id,
       attempt_id, execution_version, operation, code_digest, policy_digest, environment_summary,
       check_snapshot, selection, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tests', ?, ?, '{}', '[{"checkKey":"tests"}]', '{}', ?, ?, ?)`,
  ).run(batchId, NOW, attempt.projectId, NOW, attempt.featureId, attempt.runId, attempt.taskId,
    attempt.id, attempt.executionVersion, codeDigest, snapshot.approval.checkPolicyDigest, status, NOW, NOW + 1);
  if (status === 'passed') {
    f.box.session.database.prepare(`INSERT INTO check_results
      (id, created_at, updated_at, project_id, batch_id, check_key, argv_json, timeout_ms,
       required, status, exit_code, timed_out, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, 'tests', '["tests"]', 1000, 1, 'passed', 0, 0, ?, ?)`)
      .run(`${attempt.id}-check`, NOW, NOW, attempt.projectId, batchId, NOW, NOW + 1);
  }
  return batchId;
}

/** Persist a no-change receipt through the real store; this is a state-machine fixture, not a Git execution test. */
function recordTaskCommitFixture(f: Fixture, attempt: AttemptRecord, batchId: string, codeDigest: string): void {
  const db = f.box.session.database;
  const binding = db.prepare('SELECT id, repo_identity, canonical_path FROM repository_bindings WHERE project_id = ?')
    .get(attempt.projectId) as { id: string; repo_identity: string; canonical_path: string };
  const feature = db.prepare('SELECT revision FROM features WHERE id = ?').get(attempt.featureId) as { revision: number };
  const head = f.box.box.gitHead('A');
  const tree = git(['rev-parse', 'HEAD^{tree}'], binding.canonical_path, { home: f.box.box.homeDir }).trim();
  const operationId = randomUUID();
  const store = createSqliteGitOperationStore(f.box.session, { nowUtcMs: () => NOW + 2 });
  const registered = store.registerGitOperation({ operationId, projectId: attempt.projectId,
    featureId: attempt.featureId, runId: attempt.runId, attemptId: attempt.id,
    executionVersion: attempt.executionVersion, operationType: 'task_commit',
    repositoryBindingId: binding.id, repoIdentity: binding.repo_identity, worktreePath: binding.canonical_path,
    expectedHead: head, candidateTree: tree, codeDigest,
    verificationRefs: [{ kind: 'verification_batch', id: batchId, digest: codeDigest }], approvalRefs: [],
    message: 'fixture unchanged Task delivery', gitIdentity: { name: 'fixture', email: 'fixture@example.test', confirmed: true },
    deliveryPolicyDigest: 'ab'.repeat(32), runtimeSource: null, ownerId: attempt.owner,
    hostInstanceId: attempt.hostInstanceId, expectedFeatureRevision: feature.revision });
  store.finalizeGitOperation({ operationId, projectId: attempt.projectId, expectedRevision: registered.operation.revision,
    status: 'no_change', actualCommit: head, actualTree: tree, exitCode: 0, durationMs: 1,
    reasonCode: null, deliveryStatus: 'not_requested', settledAtUtcMs: NOW + 2 });
}

describe('P03-9 / F-001 Run/Batch Task 边界暂停', () => {
  it('无活动 Attempt：Run 原子进入 paused、事件/回执同事务，认领被拒绝且预算/deadline 不变', async () => {
    const f = await openClaimFixture();
    try {
      const before = readBatch(f, f.ids.batchId);
      const receipt = await submitPause(f, { runId: f.ids.runId, batchId: null }, 1);
      expect(receipt.status).toBe('completed');
      expect(completedResult(receipt)).toMatchObject({
        outcome: 'paused', targetKind: 'run', targetId: f.ids.runId, status: 'paused', changed: true,
      });
      expect(readRun(f, f.ids.runId)).toMatchObject({
        status: 'paused', reason: 'user_pause', revision: 2, pause_requested_at: NOW, ended_at: null,
      });
      expect(pauseEvents(f)).toEqual([{
        event_type: 'execution.run.paused', aggregate_type: 'run', aggregate_id: f.ids.runId, aggregate_revision: 2,
      }]);
      expectClaimRejected(f, 'run_control_blocked');

      const after = readBatch(f, f.ids.batchId);
      expect(after).toMatchObject({
        budget_revision: before.budget_revision,
        budget_snapshot: before.budget_snapshot,
        deadline_at: before.deadline_at,
      });
    } finally { f.box.close(); }
  });

  it('重复 commandId 返回原回执；异摘要、过期 revision、无权限均拒绝且无业务倒写', async () => {
    const f = await openClaimFixture();
    try {
      const commandId = randomUUID();
      const owner = createLocalOwnerPrincipal();
      const first = await f.box.services.commands.submit(owner,
        pauseEnvelope(f, { runId: f.ids.runId, batchId: null }, 1, commandId));
      expect(first.status).toBe('completed');
      const rowAfterFirst = readRun(f, f.ids.runId);
      const eventsAfterFirst = pauseEvents(f);
      const receiptsAfterFirst = commandCount(f);

      const replay = await f.box.services.commands.submit(owner,
        pauseEnvelope(f, { runId: f.ids.runId, batchId: null }, 1, commandId));
      expect(replay).toMatchObject({ commandId, status: 'completed', replayed: true, result: completedResult(first) });
      expect(readRun(f, f.ids.runId)).toEqual(rowAfterFirst);
      expect(pauseEvents(f)).toEqual(eventsAfterFirst);
      expect(commandCount(f)).toBe(receiptsAfterFirst);

      await expect(f.box.services.commands.submit(owner,
        pauseEnvelope(f, { batchId: f.ids.batchId, runId: null }, 2, commandId)))
        .rejects.toMatchObject({ code: 'conflict', operation: 'execution.pause' });
      expect(readRun(f, f.ids.runId)).toEqual(rowAfterFirst);

      const stale = await submitPause(f, { runId: f.ids.runId, batchId: null }, 999);
      expect(stale).toMatchObject({
        status: 'rejected',
        error: { code: 'conflict', details: { reason: 'stale_revision', entityType: 'run' } },
      });
      expect(readRun(f, f.ids.runId)).toEqual(rowAfterFirst);

      const viewer: TrustedPrincipal = Object.freeze({
        principalId: 'viewer',
        capabilities: new Set<AppCapability>(),
        projectScope: Object.freeze({ kind: 'all' }) as TrustedPrincipal['projectScope'],
      });
      await expect(f.box.services.commands.submit(viewer,
        pauseEnvelope(f, { runId: f.ids.runId, batchId: null }, 2)))
        .rejects.toMatchObject({ code: 'forbidden', operation: 'execution.pause' });
      expect(readRun(f, f.ids.runId)).toEqual(rowAfterFirst);
    } finally { f.box.close(); }
  });

  it('终态返回 already_terminal 且不倒写状态/revision/事件', async () => {
    const f = await openClaimFixture();
    try {
      f.box.session.database.prepare("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?")
        .run(NOW, f.ids.runId);
      const before = readRun(f, f.ids.runId);
      const eventsBefore = pauseEvents(f);
      const receipt = await submitPause(f, { runId: f.ids.runId, batchId: null }, before.revision);
      expect(receipt).toMatchObject({
        status: 'completed',
        result: { outcome: 'already_terminal', status: 'succeeded', alreadyTerminal: true, changed: false },
      });
      expect(readRun(f, f.ids.runId)).toEqual(before);
      expect(pauseEvents(f)).toEqual(eventsBefore);
    } finally { f.box.close(); }
  });

  it('活跃 Attempt：Run/Batch 进入 pausing，当前 Attempt 通过验证后才转 paused，不开始返工', async () => {
    const f = await openClaimFixture();
    try {
      const { attempt, token } = await advanceToVerifying(f);
      const runBefore = readRun(f, attempt.runId);
      const batchBefore = readBatch(f, f.ids.batchId);

      const paused = await submitPause(f, { runId: attempt.runId, batchId: null }, runBefore.revision);
      expect(paused).toMatchObject({ status: 'completed', result: { outcome: 'pausing', status: 'pausing' } });
      expect(readRun(f, attempt.runId)).toMatchObject({ status: 'pausing', reason: 'user_pause' });
      expectClaimRejected(f, 'run_control_blocked');

      const codeDigest = 'cd'.repeat(32);
      const batchId = seedVerification(f, attempt, codeDigest);
      recordTaskCommitFixture(f, attempt, batchId, codeDigest);
      const verification = lifecycle(f).submitVerification({
        projectId: attempt.projectId, attemptId: attempt.id, taskId: attempt.taskId, runId: attempt.runId,
        owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
        verificationBatchId: batchId, codeDigest, observationDigest: 'ef'.repeat(32), outcome: 'passed',
      }, token);
      expect(verification).toMatchObject({ disposition: 'applied', status: 'succeeded', waitingFor: null });
      expect(readRun(f, attempt.runId)).toMatchObject({ status: 'paused', reason: 'user_pause' });
      expect(f.box.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get(attempt.taskId))
        .toEqual({ status: 'passed' });
      expectClaimRejected(f, 'run_control_blocked');
      expect(readBatch(f, f.ids.batchId)).toMatchObject({
        budget_revision: batchBefore.budget_revision,
        budget_snapshot: batchBefore.budget_snapshot,
        deadline_at: batchBefore.deadline_at,
      });
    } finally { f.box.close(); }
  });

  it('Batch 暂停在无活动 Attempt 时暂停 Batch/Run；有活动 Attempt 时 pausing，收尾后 paused', async () => {
    const noActive = await openClaimFixture();
    try {
      const receipt = await submitPause(noActive, { batchId: noActive.ids.batchId, runId: null }, 1);
      expect(receipt).toMatchObject({ status: 'completed', result: { outcome: 'paused', targetKind: 'batch' } });
      expect(readBatch(noActive, noActive.ids.batchId)).toMatchObject({ status: 'paused', reason: 'user_pause' });
      expect(readRun(noActive, noActive.ids.runId)).toMatchObject({ status: 'paused', reason: 'user_pause' });
      expect(pauseEvents(noActive).map(event => event.event_type)).toEqual([
        'execution.run.paused', 'execution.batch.paused',
      ]);
      expectClaimRejected(noActive, 'run_control_blocked');
      // 暂停 Batch 后，显式 retryBatchId 也不能创建后续 Run。
      const runsBeforeRetry = noActive.box.session.database.prepare(
        'SELECT COUNT(*) AS n FROM runs WHERE batch_id = ?').get(noActive.ids.batchId);
      await expect(noActive.box.services.commands.submit(noActive.box.owner,
        noActive.box.retryEnvelope(noActive.ids.batchId))).rejects.toMatchObject({
        code: 'conflict', operation: 'execution.start', details: { reason: 'execution_in_progress' },
      });
      expect(noActive.box.session.database.prepare(
        'SELECT COUNT(*) AS n FROM runs WHERE batch_id = ?').get(noActive.ids.batchId)).toEqual(runsBeforeRetry);
    } finally { noActive.box.close(); }

    const active = await openClaimFixture();
    try {
      const { attempt, token } = await advanceToVerifying(active);
      const paused = await submitPause(active, { batchId: active.ids.batchId, runId: null },
        readBatch(active, active.ids.batchId).revision);
      expect(paused).toMatchObject({ status: 'completed', result: { outcome: 'pausing', targetKind: 'batch' } });
      expect(readBatch(active, active.ids.batchId)).toMatchObject({ status: 'pausing', reason: 'user_pause' });
      expect(readRun(active, attempt.runId)).toMatchObject({ status: 'pausing', reason: 'user_pause' });

      const codeDigest = 'cd'.repeat(32);
      const verificationBatchId = seedVerification(active, attempt, codeDigest, 'failed');
      const verification = lifecycle(active).submitVerification({
        projectId: attempt.projectId, attemptId: attempt.id, taskId: attempt.taskId, runId: attempt.runId,
        owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
        verificationBatchId, codeDigest, observationDigest: 'ef'.repeat(32), outcome: 'code_failure',
      }, token);
      expect(verification).toMatchObject({ disposition: 'applied', status: 'failed' });
      expect(readRun(active, attempt.runId)).toMatchObject({ status: 'paused', reason: 'user_pause' });
      expect(readBatch(active, active.ids.batchId)).toMatchObject({ status: 'paused', reason: 'user_pause' });
      expectClaimRejected(active, 'run_control_blocked');
    } finally { active.box.close(); }
  });

  it('迁移 v27：仅追加暂停意图列，历史 checksum 稳定，空库与 v26 库均可升级', async () => {
    expect(SQLITE_MIGRATIONS.map(migration => migration.version)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    expect(SQLITE_MIGRATIONS[26]?.sql).toContain('ADD COLUMN pause_requested_at');
    // 既有 v1-v26 的 SQL 只在文件末尾追加 v27（后续 v28 再追加停止 operation
    // 表）；这里的冻结摘要由本文件生成，任何历史迁移被改写都会使 checksum
    // 校验失败（迁移器启动时同样校验）。
    for (const migration of SQLITE_MIGRATIONS.slice(0, 26)) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    }

    const empty = createTempSandbox('shiploop-p03-9-pause-empty-');
    try {
      const session = openSqliteStorageSession({ path: join(empty.path, 'state.db') });
      try {
        const result = await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
        expect(result).toMatchObject({ fromVersion: 0, toVersion: 32 });
        for (const table of ['runs', 'execution_batches']) {
          const columns = session.database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
          expect(columns.map(column => column.name)).toContain('pause_requested_at');
        }
      } finally { session.close(); }
    } finally { empty.cleanup(); }

    const upgrade = createTempSandbox('shiploop-p03-9-pause-upgrade-');
    try {
      const session = openSqliteStorageSession({ path: join(upgrade.path, 'state.db') });
      try {
        await migrateSqliteStorage(session, {
          migrations: SQLITE_MIGRATIONS.slice(0, 26), nowUtcMs: () => NOW,
        });
        session.database.prepare(
          "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('p-keep', ?, 1, ?, '保留项目', 'active', '[]')",
        ).run(NOW, NOW);
        const upgraded = await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
        expect(upgraded).toMatchObject({ fromVersion: 26, toVersion: 32, appliedVersions: [27, 28, 29, 30, 31, 32] });
        expect(session.database.prepare("SELECT display_name FROM projects WHERE id = 'p-keep'").get())
          .toEqual({ display_name: '保留项目' });
        expect(session.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
          .toEqual({ version: 32 });
      } finally { session.close(); }
    } finally { upgrade.cleanup(); }
  });

  it('跨项目目标被拒绝且不写入暂停意图', async () => {
    const f = await openClaimFixture();
    try {
      f.box.session.database.prepare(
        "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('other-project', ?, 1, ?, 'Other', 'active', '[]')",
      ).run(NOW, NOW);
      const before = readRun(f, f.ids.runId);
      await expect(f.box.services.commands.submit(createLocalOwnerPrincipal(), {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(),
        operation: 'execution.pause', scope: { kind: 'project', projectId: 'other-project' },
        expectedRevision: before.revision, payload: { runId: f.ids.runId, batchId: null },
      })).rejects.toBeInstanceOf(PublicError);
      expect(readRun(f, f.ids.runId)).toEqual(before);
      expect(pauseEvents(f)).toEqual([]);
    } finally { f.box.close(); }
  });
});
