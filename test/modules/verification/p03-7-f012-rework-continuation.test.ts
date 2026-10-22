/**
 * P03-7 / F-012：有界增量返工与失败链（AttemptLifecycle.submitVerification 分支 +
 * ClaimTask 返工快照一致性）。
 *
 * 聚焦验收点：
 * 1. code_failure 且预算/审批/控制门通过 → Task 回到 pending、Run 恢复 running、
 *    占用释放，随后同一工作区凭证下可携带 F-011 返工快照认领新 Attempt；
 * 2. 预算耗尽 → Task failed、Run 暂停（code_attempts_exhausted）、依赖方被
 *    dependency_failed 阻断，失败链可查询；
 * 3. 停止证据未知 → 占用保持隔离（quarantined），DAG resource_busy 拒绝重跑；
 * 4. non_code_failure → 独立的基础设施暂停分支（infrastructure_error），
 *    与代码返工路径分离，code 预算退回；
 * 5. 人工阻塞门：manual_block 下 reworkable 失败后的 Task 不得被再次认领；
 * 6. 返工纪律：有历史 Attempt 必须有返工快照、无历史不得携带、身份不一致拒绝。
 */
import { describe, expect, it } from 'vitest';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { validateAttemptInputSnapshot } from '../../../packages/core/src/ports/attempt-store.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import type { PreparedExecutionInputGroup } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import type { AttemptRecord } from '../../../packages/core/src/ports/attempt-store.ts';

/* 与 p03-4-attempt-lifecycle.test.ts 相同的受控停止验证器：停止已确认。 */
const stopVerifier = createWorkResourceStopVerifier({
  process: { recoverStop: async () => ({ confirmed: true }) },
  finalize: async () => true,
});

type Fixture = Awaited<ReturnType<typeof openClaimFixture>>;

/** 认领拒绝的具体原因走 details.eligibility 通道（消息统一为 not_ready/resource_busy）。 */
const expectClaimRejected = (fn: () => unknown, eligibility: string) => {
  try { fn(); } catch (error) {
    const details = (error as { details?: { reason?: string; eligibility?: string } }).details;
    expect(details?.eligibility ?? details?.reason, `拒绝原因应为 ${eligibility}`).toBe(eligibility);
    return;
  }
  throw new Error(`预期认领被拒绝（${eligibility}），实际成功`);
};

const lifecycle = (f: Fixture) =>
  createSqliteAttemptLifecycleStore(f.box.session, {
    workspaceAuthority: f.authority, nowUtcMs: () => NOW + 1, stopVerifier,
  });

const resources = (f: Fixture) =>
  createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });

/** 认领 → 授权启动 → executing → runtime_completed；withStop=false 时不提供
 * 停止证据，apply 将占用保持隔离（quarantined）。返回最后一次 apply 时的占用状态。 */
async function advanceToVerifying(f: Fixture, index = 0, withStop = true) {
  const attempt: AttemptRecord = f.store().claimTask(f.input(index)).receipt.attempt;
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
  const token = withStop ? await stopVerifier.verify(resources(f).read(identity)) : undefined;
  const completed = withStop
    ? lifecycle(f).apply({ ...notification, notificationId: 'complete',
        kind: 'runtime_completed', exitCode: 0, evidenceRef: attempt.inputRef }, token)
    : lifecycle(f).apply({ ...notification, notificationId: 'complete',
        kind: 'runtime_completed', exitCode: 0, evidenceRef: attempt.inputRef });
  if (completed.status !== 'verifying') {
    throw new Error(`夹具推进失败：${JSON.stringify(completed)}`);
  }
  return { attempt, identity, notification, token };
}

const setCodeRef = (f: Fixture, attempt: AttemptRecord, codeRef: string) =>
  f.box.session.database.prepare('UPDATE attempts SET code_ref = ? WHERE id = ?').run(codeRef, attempt.id);

/** 种子：已定版 VerificationBatch（与 Attempt/快照身份对齐）。 */
const seedVerification = (f: Fixture, attempt: AttemptRecord, codeDigest: string,
  status: 'passed' | 'failed' | 'error' | 'inconclusive' = 'failed') => {
  const snapshot = JSON.parse((f.box.session.database.prepare(
    'SELECT input_snapshot FROM attempts WHERE id = ?').get(attempt.id) as { input_snapshot: string }).input_snapshot) as
    { approval: { checkPolicyDigest: string } };
  const batchId = `${attempt.id}-batch`;
  f.box.session.database.prepare(
    `INSERT INTO verification_batches (id, created_at, project_id, updated_at, feature_id, run_id, task_id,
       attempt_id, execution_version, operation, code_digest, policy_digest, environment_summary,
       check_snapshot, selection, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tests', ?, ?, '{}', '[{"checkKey":"tests"}]', '{}', ?, ?, ?)`)
    .run(batchId, NOW, attempt.projectId, NOW, attempt.featureId, attempt.runId, attempt.taskId,
      attempt.id, attempt.executionVersion, codeDigest, snapshot.approval.checkPolicyDigest, status, NOW, NOW + 1);
  return batchId;
};

const verificationInput = (f: Fixture, attempt: AttemptRecord, codeDigest: string,
  outcome: 'passed' | 'code_failure' | 'non_code_failure', batchId: string,
  observationDigest = 'ef'.repeat(32)) => ({
  projectId: attempt.projectId, attemptId: attempt.id, taskId: attempt.taskId, runId: attempt.runId,
  owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
  verificationBatchId: batchId, codeDigest, observationDigest, outcome,
});

const readTask = (f: Fixture, taskId: string) =>
  f.box.session.database.prepare(
    'SELECT status, revision, execution_version, attempt_counter, code_attempts_used, manual_block FROM tasks WHERE id = ?')
    .get(taskId) as Record<string, unknown>;

const readRun = (f: Fixture, runId: string) =>
  f.box.session.database.prepare('SELECT status, reason FROM runs WHERE id = ?')
    .get(runId) as { status: string; reason: string | null };

const leaseCount = (f: Fixture) =>
  (f.box.session.database.prepare('SELECT COUNT(*) AS n FROM workspace_leases').get() as { n: number }).n;

const leaseStates = (f: Fixture) =>
  (f.box.session.database.prepare('SELECT state FROM workspace_leases ORDER BY resource_key').all() as { state: string }[])
    .map(row => row.state);

/** F-011 返工快照（schemaVersion 2），基于既有准备制品组的稳定摘要。 */
const reworkSnapshot = (base: PreparedExecutionInputGroup, rework: Record<string, unknown>): PreparedExecutionInputGroup =>
  ({ ...base, schemaVersion: 2, rework }) as unknown as PreparedExecutionInputGroup;

const makeRework = (f: Fixture, attemptId: string, previousAttemptId: string): Record<string, unknown> => ({
  attemptId,
  previousAttemptId,
  previousTaskId: 't-1',
  scene: { worktreeId: 'wt-1', headCommit: 'b'.repeat(40), codeDigest: 'c'.repeat(64) },
  failureEvidenceRefs: [{
    projectId: f.box.projectId, artifactId: 't-1-code', kind: 'execution-input', purpose: 'failure',
    version: 1, contentHash: 'ab'.repeat(32), sizeBytes: 10, locator: 'inputs/t-1-code',
    mediaType: 'application/json', origin: { kind: 'artifact' },
  }],
  recovery: { selection: { mode: 'new' }, decision: { mode: 'new', reasons: ['explicit_new'] } },
});

describe('F-012 submitVerification 结果分支', () => {
  it('机器检查通过但旧进程停止未知：保留隔离且不能 Task passed', async () => {
    const f = await openClaimFixture();
    const first = await advanceToVerifying(f, 0, false);
    const digest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, digest, 'passed');
    f.box.session.database.prepare(`INSERT INTO check_results
      (id, created_at, updated_at, project_id, batch_id, check_key, argv_json, timeout_ms,
       required, status, exit_code, timed_out, started_at, ended_at)
      VALUES ('passed-check', ?, ?, ?, ?, 'tests', '["tests"]', 1000, 1, 'passed', 0, 0, ?, ?)`)
      .run(NOW, NOW, first.attempt.projectId, batchId, NOW, NOW + 1);
    const result = lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, digest, 'passed', batchId));
    expect(result).toMatchObject({ disposition: 'ignored', stopConfirmed: false });
    expect(readTask(f, 't-1')).toMatchObject({ status: 'running' });
    expect(leaseStates(f)).not.toEqual([]);
    expect(leaseStates(f).every(state => state === 'quarantined')).toBe(true);
  });

  it('暂停中的 Run 不因代码失败收尾恢复执行，也不认领返工', async () => {
    const f = await openClaimFixture();
    const first = await advanceToVerifying(f);
    const codeDigest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, codeDigest);
    f.box.session.database.prepare("UPDATE runs SET status = 'pausing', reason = 'user_pause' WHERE id = ?")
      .run(first.attempt.runId);
    lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, codeDigest, 'code_failure', batchId), first.token);
    expect(readTask(f, 't-1')).toMatchObject({ status: 'pending' });
    expect(readRun(f, first.attempt.runId)).toEqual({ status: 'pausing', reason: 'user_pause' });
    expect(f.evaluate()).toMatchObject({ reason: 'run_control_blocked' });
  });

  it.each(['normal', 'quarantined'])('[case:rework-slot-%s] code_failure 且预算剩余 + 停止已确认：Task 回 pending、Run 恢复 running、占用释放，可携带返工快照认领新 Attempt', async slotState => {
    const f = await openClaimFixture();
    const first = await advanceToVerifying(f);
    const snapshot = f.input(0).inputSnapshot;
    const codeDigest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, codeDigest);

    const receipt = await lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, codeDigest, 'code_failure', batchId), first.token);

    /* 历史 Attempt 失败终态 + 失败链证据保留。 */
    expect(receipt).toMatchObject({ disposition: 'applied', attemptId: first.attempt.id, status: 'failed', stopConfirmed: true });
    const attemptRow = f.box.session.database.prepare(
      "SELECT status, error_kind, ended_at FROM attempts WHERE id = ?").get(first.attempt.id) as Record<string, unknown>;
    expect(attemptRow).toMatchObject({ status: 'failed', error_kind: 'code_failure' });
    expect(typeof attemptRow['ended_at']).toBe('number');
    expect((f.box.session.database.prepare(
      'SELECT COUNT(*) AS n FROM verification_batches WHERE attempt_id = ?').get(first.attempt.id) as { n: number }).n).toBe(1);

    /* Task 回 pending（可重调度）、Run 恢复 running、占用释放。 */
    expect(readTask(f, 't-1')).toMatchObject({ status: 'pending', code_attempts_used: 1 });
    expect(readRun(f, first.attempt.runId)).toEqual({ status: 'running', reason: null });
    expect(leaseCount(f)).toBe(0);
    expect(f.evaluate()).toMatchObject({ reason: 'ready', readyTaskIds: ['t-1'] });

    /* 同一工作区凭证 + 返工快照认领新 Attempt（既有调度入口）。 */
    const secondAttemptId = 'attempt-rw-1';
    const secondInput = {
      ...f.input(0), claimKey: 'claim-rw-1', attemptId: secondAttemptId,
      expectedRevision: readTask(f, 't-1')['revision'] as number, executionVersion: 1,
      inputSnapshot: reworkSnapshot(snapshot, makeRework(f, secondAttemptId, first.attempt.id)),
    };
    if (slotState === 'quarantined') {
      f.box.session.database.prepare("UPDATE execution_slot_claims SET state = 'quarantined', reason = 'uncertain'").run();
      const before = f.snapshot();
      expect(() => f.store().claimTask(secondInput)).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.snapshot()).toEqual(before);
      expect(f.box.session.database.prepare("SELECT count(*) AS n FROM execution_slot_claims WHERE state = 'quarantined'").get()).toEqual({ n: 1 });
      f.box.close();
      return;
    }
    const second = f.store().claimTask(secondInput);
    expect(second.receipt.dispatch).toMatchObject({ claimVersion: 1 });
    expect(f.box.session.database.prepare('SELECT count(*) AS n FROM run_dispatch_claims').get()).toEqual({ n: 1 });
    expect(f.box.session.database.prepare('SELECT count(*) AS n FROM execution_slot_claims').get()).toEqual({ n: 1 });
    expect(f.box.session.transactWrite('test.rework-launch', () => resources(f).beginLaunchInTransaction({
      ...first.identity, attemptId: secondAttemptId, executionVersion: 2,
    })).authorized).toBe(true);
    expect(second.receipt.attempt.id).toBe(secondAttemptId);
    expect(second.receipt.attempt.executionVersion).toBe(2);
    expect(readTask(f, 't-1')).toMatchObject({ status: 'running', attempt_counter: 2, code_attempts_used: 2 });
    const stored = JSON.parse((f.box.session.database.prepare(
      'SELECT input_snapshot FROM attempts WHERE id = ?').get(secondAttemptId) as { input_snapshot: string }).input_snapshot) as {
        schemaVersion: number; rework?: { previousAttemptId: string } };
    expect(stored.schemaVersion).toBe(2);
    expect(stored.rework?.previousAttemptId).toBe(first.attempt.id);
    /* 首条 Attempt 失败链不被新 Attempt 覆盖。 */
    expect((f.box.session.database.prepare(
      "SELECT COUNT(*) AS n FROM attempts WHERE task_id = 't-1'").get() as { n: number }).n).toBe(2);
  });

  it('code_failure 但停止证据未知：占用保持隔离，DAG resource_busy 拒绝重跑；补交有效停止证据后释放可重跑', async () => {
    const f = await openClaimFixture();
    /* 不提供停止证据：apply(runtime_completed) 将占用保持隔离。 */
    const first = await advanceToVerifying(f, 0, false);
    const snapshot = f.input(0).inputSnapshot;
    const codeDigest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, codeDigest);

    /* 提交时仍不提供停止证据令牌：旧 Runtime/Verifier 停止状态未知。 */
    const receipt = await lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, codeDigest, 'code_failure', batchId));

    expect(receipt).toMatchObject({ disposition: 'applied', status: 'failed', stopConfirmed: false });
    expect(readTask(f, 't-1')).toMatchObject({ status: 'pending' });
    expect(readRun(f, first.attempt.runId)).toEqual({ status: 'running', reason: null });
    /* 占用保持隔离：不得释放、不得重跑。 */
    expect(leaseStates(f)).toEqual(['quarantined', 'quarantined', 'quarantined']);
    const blocked = f.evaluate();
    expect(blocked.reason).toBe('resource_busy');
    expect(blocked.readyTaskIds).toEqual([]);
    expectClaimRejected(() => f.store().claimTask({
      ...f.input(0), claimKey: 'claim-rw-2', attemptId: 'attempt-rw-2',
      expectedRevision: readTask(f, 't-1')['revision'] as number, executionVersion: 1,
      inputSnapshot: reworkSnapshot(snapshot, makeRework(f, 'attempt-rw-2', first.attempt.id)),
    }), 'resource_busy');
  });

  it('AC3：apply 时停止未知而隔离，提交时携带基于当前隔离现场的受信停止证据 → 释放占用并放行返工认领', async () => {
    const f = await openClaimFixture();
    const first = await advanceToVerifying(f, 0, false);
    expect(leaseStates(f)).toEqual(['quarantined', 'quarantined', 'quarantined']);
    const snapshot = f.input(0).inputSnapshot;
    const codeDigest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, codeDigest);
    /* 验证提交前重新核对旧 Runtime/Verifier 停止证据（基于当前隔离现场）。 */
    const fresh = await stopVerifier.verify(resources(f).read(first.identity));

    const receipt = await lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, codeDigest, 'code_failure', batchId), fresh);

    expect(receipt).toMatchObject({ disposition: 'applied', status: 'failed', stopConfirmed: true });
    expect(leaseCount(f)).toBe(0);
    expect(f.evaluate()).toMatchObject({ reason: 'ready', readyTaskIds: ['t-1'] });
  });

  it('code_failure 且 code 预算耗尽：Task failed、Run 暂停 code_attempts_exhausted、依赖方被阻断、失败链可查询', async () => {
    const f = await openClaimFixture([[], ['t-1']]);
    const first = await advanceToVerifying(f);
    const codeDigest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, codeDigest);
    /* 模拟 maxCodeAttempts（默认 3）已用尽：本次失败为第三次代码失败。 */
    f.box.session.database.prepare('UPDATE tasks SET code_attempts_used = 3, attempt_counter = 3 WHERE id = ?').run('t-1');

    const receipt = await lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, codeDigest, 'code_failure', batchId), first.token);

    expect(receipt).toMatchObject({ disposition: 'applied', status: 'failed' });
    expect(readTask(f, 't-1')).toMatchObject({ status: 'failed' });
    expect(readRun(f, first.attempt.runId)).toEqual({ status: 'paused', reason: 'code_attempts_exhausted' });
    expect(leaseCount(f)).toBe(0);
    /* 失败链：Attempt 行、批次行、失败事件全部保留可查询。 */
    expect((f.box.session.database.prepare(
      "SELECT COUNT(*) AS n FROM attempts WHERE task_id = 't-1' AND status = 'failed' AND error_kind = 'code_failure'")
      .get() as { n: number }).n).toBe(1);
    expect((f.box.session.database.prepare(
      'SELECT COUNT(*) AS n FROM verification_batches').get() as { n: number }).n).toBe(1);
    const dagPaused = f.evaluate();
    /* Run 暂停（code_attempts_exhausted）在顶层原因上优先。 */
    expect(dagPaused.reason).toBe('run_control_blocked');
    expect(dagPaused.readyTaskIds).toEqual([]);
    /* 依赖方阻断：模拟控制面恢复 Run 后，Task failed 的依赖链仍然阻断后继。 */
    f.box.session.database.prepare("UPDATE runs SET status = 'running', reason = NULL WHERE id = ?")
      .run(first.attempt.runId);
    const dag = f.evaluate();
    expect(dag.reason).toBe('dependency_failed');
    expect(dag.readyTaskIds).toEqual([]);
    expect(dag.tasks.find(t => t.taskId === 't-2')?.reason).toBe('dependency_failed');
  });

  it('non_code_failure：独立基础设施暂停分支，Task 回 pending、占用隔离、code 预算退回、DAG run_control_blocked', async () => {
    const f = await openClaimFixture();
    /* 停止证据未知：apply 已将占用隔离。 */
    const first = await advanceToVerifying(f, 0, false);
    const snapshot = f.input(0).inputSnapshot;
    const codeDigest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, codeDigest, 'error');

    const receipt = await lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, codeDigest, 'non_code_failure', batchId), first.token);

    expect(receipt).toMatchObject({ disposition: 'applied', status: 'failed', stopConfirmed: false });
    expect(readTask(f, 't-1')).toMatchObject({ status: 'pending', code_attempts_used: 0 });
    expect(readRun(f, first.attempt.runId)).toEqual({ status: 'paused', reason: 'infrastructure_error' });
    /* 基础设施分支占用保持隔离，不进入代码返工路径。 */
    expect(leaseStates(f)).toEqual(['quarantined', 'quarantined', 'quarantined']);
    const dag = f.evaluate();
    expect(dag.reason).toBe('run_control_blocked');
    expect(dag.readyTaskIds).toEqual([]);
    expectClaimRejected(() => f.store().claimTask({
      ...f.input(0), claimKey: 'claim-rw-3', attemptId: 'attempt-rw-3',
      expectedRevision: readTask(f, 't-1')['revision'] as number, executionVersion: 1,
      inputSnapshot: reworkSnapshot(snapshot, makeRework(f, 'attempt-rw-3', first.attempt.id)),
    }), 'run_control_blocked');
  });

  it('人工阻塞门：reworkable 失败后 manual_block 的 Task 不得被再次认领', async () => {
    const f = await openClaimFixture();
    const first = await advanceToVerifying(f);
    const snapshot = f.input(0).inputSnapshot;
    const codeDigest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, codeDigest);
    await lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, codeDigest, 'code_failure', batchId), first.token);
    expect(readTask(f, 't-1')).toMatchObject({ status: 'pending' });

    f.box.session.database.prepare('UPDATE tasks SET manual_block = 1 WHERE id = ?').run('t-1');

    const dag = f.evaluate();
    expect(dag.reason).toBe('waiting_approval');
    expect(dag.readyTaskIds).toEqual([]);
    expectClaimRejected(() => f.store().claimTask({
      ...f.input(0), claimKey: 'claim-rw-4', attemptId: 'attempt-rw-4',
      expectedRevision: readTask(f, 't-1')['revision'] as number, executionVersion: 1,
      inputSnapshot: reworkSnapshot(snapshot, makeRework(f, 'attempt-rw-4', first.attempt.id)),
    }), 'waiting_approval');
    expect(readTask(f, 't-1')).toMatchObject({ status: 'pending', attempt_counter: 1 });
  });
});

describe('F-012 ClaimTask 返工快照一致性', () => {
  it('有历史 Attempt 但缺少返工快照：fail-closed 拒绝', async () => {
    const f = await openClaimFixture();
    const first = await advanceToVerifying(f);
    const snapshot = f.input(0).inputSnapshot;
    const codeDigest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, codeDigest);
    await lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, codeDigest, 'code_failure', batchId), first.token);

    expectClaimRejected(() => f.store().claimTask({
      ...f.input(0), claimKey: 'claim-rw-5',
      expectedRevision: readTask(f, 't-1')['revision'] as number, executionVersion: 1,
      inputSnapshot: { ...snapshot },
    }), 'rework_input_required');
  });

  it('无历史 Attempt 携带返工快照：拒绝；返工身份不一致：拒绝', async () => {
    const f = await openClaimFixture();
    const snapshot = f.input(0).inputSnapshot;
    /* 无历史：rework_without_history。 */
    expectClaimRejected(() => f.store().claimTask({
      ...f.input(0), attemptId: 'attempt-rw-x', executionVersion: 0,
      inputSnapshot: reworkSnapshot(snapshot, makeRework(f, 'attempt-rw-x', 'attempt-none')),
    }), 'rework_without_history');

    /* 制造历史：完整失败一次。 */
    const first = await advanceToVerifying(f);
    const codeDigest = 'cd'.repeat(32);
    setCodeRef(f, first.attempt, 't-1-code');
    const batchId = seedVerification(f, first.attempt, codeDigest);
    await lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, codeDigest, 'code_failure', batchId), first.token);

    /* attemptId 缺失：rework_attempt_identity_mismatch。 */
    expectClaimRejected(() => f.store().claimTask({
      ...f.input(0), claimKey: 'claim-rw-6',
      expectedRevision: readTask(f, 't-1')['revision'] as number, executionVersion: 1,
      inputSnapshot: reworkSnapshot(snapshot, makeRework(f, 'attempt-rw-6', first.attempt.id)),
    }), 'rework_attempt_identity_mismatch');
    /* previousAttemptId 不是最近终态 Attempt：rework_previous_attempt_mismatch。 */
    expectClaimRejected(() => f.store().claimTask({
      ...f.input(0), claimKey: 'claim-rw-7', attemptId: 'attempt-rw-7',
      expectedRevision: readTask(f, 't-1')['revision'] as number, executionVersion: 1,
      inputSnapshot: reworkSnapshot(snapshot, makeRework(f, 'attempt-rw-7', 'attempt-not-latest')),
    }), 'rework_previous_attempt_mismatch');
    /* 非法认领全部无回执。 */
    expect((f.box.session.database.prepare(
      'SELECT COUNT(*) AS n FROM task_claim_receipts').get() as { n: number }).n).toBe(1);
  });
});

describe('F-012 AttemptInputSnapshot 返工校验（schemaVersion 2）', () => {
  it('接受 v2 返工快照；拒绝 v1 携带返工与跨 Task 返工引用', () => {
    const snapshot = {
      schemaVersion: 1, projectId: 'p-1', featureId: 'f-1', taskId: 't-1',
      group: {
        snapshot: { artifactId: 's-1', version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, locator: 'x/s', mediaType: 'application/json' },
        manifest: { artifactId: 'm-1', version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, locator: 'x/m', mediaType: 'application/json' },
        prompt: { artifactId: 'p-1', version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, locator: 'x/p', mediaType: 'application/json' },
      },
      requiredInputs: [],
      digests: { snapshotDigest: 'a'.repeat(64), manifestDigest: 'a'.repeat(64), promptDigest: 'a'.repeat(64),
        strategyCopyDigest: 'a'.repeat(64), permissionsDigest: 'a'.repeat(64) },
      approval: {
        planDigest: 'a'.repeat(64), checkPolicyDigest: 'a'.repeat(64),
        decisionId: null, featureRevision: 1,
      },
      taskRevision: 1, promptBytes: 10,
      tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' }, preparedAtUtcMs: 1,
    };
    const rework = {
      attemptId: 'a-2', previousAttemptId: 'a-1', previousTaskId: 't-1',
      scene: { worktreeId: 'wt-1', headCommit: 'b'.repeat(40), codeDigest: 'c'.repeat(64) },
      failureEvidenceRefs: [{
        projectId: 'p-1', artifactId: 'ev-1', kind: 'execution-input', purpose: 'failure',
        version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, locator: 'ev/1',
        mediaType: 'application/json', origin: { kind: 'artifact' },
      }],
      recovery: { selection: { mode: 'new' }, decision: { mode: 'new', reasons: ['explicit_new'] } },
    };
    /* v2 + 合法返工：接受并返回快照组。 */
    const accepted = validateAttemptInputSnapshot({ ...snapshot, schemaVersion: 2, rework });
    expect(accepted.schemaVersion).toBe(2);
    expect((accepted as { rework?: { previousAttemptId: string } }).rework?.previousAttemptId).toBe('a-1');
    /* v1 + 返工：拒绝（返工快照仅限 schemaVersion 2）。 */
    expect(() => validateAttemptInputSnapshot({ ...snapshot, schemaVersion: 1, rework }))
      .toThrow(/rework_requires_context_v2/);
    /* 跨 Task 引用：拒绝。 */
    expect(() => validateAttemptInputSnapshot({
      ...snapshot, schemaVersion: 2, rework: { ...rework, previousTaskId: 't-9' },
    })).toThrow(/invalid_rework|cross_task/);
    /* 未知字段（绕过注入面）：拒绝。 */
    expect(() => validateAttemptInputSnapshot({ ...snapshot, schemaVersion: 2, rework, forged: true }))
      .toThrow(/未知字段|unknown/i);
  });
});
