/**
 * P03-7 / F-013：有限返工链授权只读查询（失败链分页）。
 *
 * 验收面（.dag_context.json F-013）：
 * 1. 显示历次 Attempt 与失败引用、已用/剩余代码资格、总预算阻止原因、Run
 *    暂停原因和后继 blocked 原因；未知退出或耗时保持 null/unknown；
 * 2. 不将基础设施错误或等待人审显示为代码额度消耗（资格只取持久计数与
 *    结算账本，不折算 Attempt 行数）；
 * 3. 有界分页、跨 Task/非法游标 invalid_cursor、越权/跨项目/未知目标不泄漏；
 *    查询零写入、返回内容与真实持久状态相符。
 */
import { describe, expect, it } from 'vitest';
import { createQueryService } from '../packages/core/src/application/query-service.ts';
import type { QueryService } from '../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteExecutionAccess } from '../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqlitePlanAccess } from '../packages/core/src/adapters/sqlite/plan-store.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createWorkResourceStopVerifier } from '../packages/core/src/application/work-resource-stop.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../packages/core/src/ports/path-service.ts';
import { isPublicError } from '../packages/core/src/ports/commands.ts';
import type { AttemptRecord } from '../packages/core/src/ports/attempt-store.ts';
import type { PreparedExecutionInputGroup } from '../packages/core/src/ports/execution-input-prepare.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { openClaimFixture as openClaim } from './helpers/p03-4/task-claim-fixture.ts';
import {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
  scopeAllowlist,
} from './helpers/p02-2/principals.ts';

const owner = createLocalOwnerPrincipal();
const CODE_DIGEST = 'cd'.repeat(32);

/* 与 p03-7-f012-rework-continuation.test.ts 相同的受控停止验证器：停止已确认。 */
const stopVerifier = createWorkResourceStopVerifier({
  process: { recoverStop: async () => ({ confirmed: true }) },
  finalize: async () => true,
});

type Fixture = Awaited<ReturnType<typeof openClaim>>;

const lifecycle = (f: Fixture) =>
  createSqliteAttemptLifecycleStore(f.box.session, {
    workspaceAuthority: f.authority, nowUtcMs: () => NOW + 1, stopVerifier,
  });

const resources = (f: Fixture) =>
  createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });

/** 与生产装配同一入口：真实 SQLite 查询门面 + 授权 QueryService（夹具时钟）。 */
function assembleQueries(session: SqliteStorageSession, dataRoot: string): QueryService {
  const queryStore = createSqliteQueryStore(session);
  const stateStore = createSqliteStateStore(session);
  return createQueryService({
    projectReads: queryStore,
    snapshots: queryStore,
    eventReads: queryStore,
    stateStore,
    configurationService: createConfigurationService({
      stateStore,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
    }),
    planReads: queryStore,
    executionBudgetReads: queryStore,
    scheduleReads: queryStore,
    workspaceReads: queryStore,
    workSessionReads: queryStore,
    taskEvidenceReads: queryStore,
    artifacts: createSqliteArtifactStore(session),
    artifactFiles: createArtifactFileStore({ dataRoot }),
    dataRootIdentity: computeDataRootIdentity(dataRoot),
    nowUtcMs: () => NOW,
  });
}

/** 认领 → 授权启动 → executing → runtime_completed（verifying）。 */
async function advanceToVerifying(f: Fixture, index = 0, withStop = true) {
  const attempt: AttemptRecord = f.store().claimTask(f.input(index)).receipt.attempt;
  const identity = {
    projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
  };
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
  if (completed.status !== 'verifying') throw new Error(`夹具推进失败：${JSON.stringify(completed)}`);
  return { attempt, identity, notification, token };
}

const setRefs = (f: Fixture, attempt: AttemptRecord) => {
  f.box.session.database.prepare('UPDATE attempts SET code_ref = ?, diagnostic_ref = ? WHERE id = ?')
    .run('t-1-code', 't-1-code', attempt.id);
};

/** 已定版 VerificationBatch 种子（驱动 submitVerification；返工链查询不读批次正文）。 */
const seedVerification = (f: Fixture, attempt: AttemptRecord, status: 'failed' | 'error' = 'failed') => {
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
      attempt.id, attempt.executionVersion, CODE_DIGEST, snapshot.approval.checkPolicyDigest, status, NOW, NOW + 1);
  return batchId;
};

const verificationInput = (f: Fixture, attempt: AttemptRecord,
  outcome: 'code_failure' | 'non_code_failure', batchId: string) => ({
  projectId: attempt.projectId, attemptId: attempt.id, taskId: attempt.taskId, runId: attempt.runId,
  owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
  verificationBatchId: batchId, codeDigest: CODE_DIGEST, observationDigest: 'ef'.repeat(32), outcome,
});

const reworkSnapshot = (base: PreparedExecutionInputGroup, rework: Record<string, unknown>): PreparedExecutionInputGroup =>
  ({ ...base, schemaVersion: 2, rework }) as unknown as PreparedExecutionInputGroup;

const makeRework = (f: Fixture, attemptId: string, previousAttemptId: string): Record<string, unknown> => ({
  attemptId,
  previousAttemptId,
  previousTaskId: 't-1',
  scene: { worktreeId: 'wt-1', headCommit: 'b'.repeat(40), codeDigest: CODE_DIGEST },
  failureEvidenceRefs: [{
    projectId: f.box.projectId, artifactId: 't-1-code', kind: 'execution-input', purpose: 'failure',
    version: 1, contentHash: 'ab'.repeat(32), sizeBytes: 10, locator: 'inputs/t-1-code',
    mediaType: 'application/json', origin: { kind: 'artifact' },
  }],
  recovery: { selection: { mode: 'new' }, decision: { mode: 'new', reasons: ['explicit_new'] } },
});

/** 两次代码失败（第二次前模拟代码额度用尽）→ Task failed、Run 暂停、后继阻断。 */
async function openExhaustedChainFixture() {
  const f = await openClaim([[], ['t-1']]);
  const first = await advanceToVerifying(f);
  setRefs(f, first.attempt);
  const batch1 = seedVerification(f, first.attempt);
  await lifecycle(f).submitVerification(
    verificationInput(f, first.attempt, 'code_failure', batch1), first.token);

  const snapshot = f.input(0).inputSnapshot;
  const secondId = 'attempt-rw-2';
  const taskRevision = (f.box.session.database.prepare(
    'SELECT revision AS r FROM tasks WHERE id = ?').get('t-1') as { r: number }).r;
  const second: AttemptRecord = f.store().claimTask({
    ...f.input(0), claimKey: 'claim-rw-1', attemptId: secondId,
    expectedRevision: taskRevision, executionVersion: 1,
    inputSnapshot: reworkSnapshot(snapshot, makeRework(f, secondId, first.attempt.id)),
  }).receipt.attempt;
  const identity = {
    projectId: second.projectId, attemptId: second.id, owner: second.owner,
    hostInstanceId: second.hostInstanceId, executionVersion: second.executionVersion,
  };
  const notification = { ...identity, taskId: second.taskId, runId: second.runId };
  f.box.session.transactWrite('launch-2', () => {
    createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
      projectId: second.projectId, batchId: f.ids.batchId, runId: second.runId, startKey: second.id,
    });
    resources(f).beginLaunchInTransaction(identity);
    resources(f).confirmLaunchInTransaction(identity, {
      launchId: '10000000-0000-4000-8000-000000000002', pid: 124, processGroupId: 124, startTime: 'start-2',
    });
  });
  lifecycle(f).apply({ ...notification, notificationId: 'started-2', kind: 'executing' });
  const token = await stopVerifier.verify(resources(f).read(identity));
  lifecycle(f).apply({ ...notification, notificationId: 'complete-2',
    kind: 'runtime_completed', exitCode: 0, evidenceRef: second.inputRef }, token);
  setRefs(f, second);
  const batch2 = seedVerification(f, second);
  /* 模拟 maxCodeAttempts（默认 3）已用尽：本次失败为第三次代码失败。 */
  f.box.session.database.prepare('UPDATE tasks SET code_attempts_used = 3, attempt_counter = 3 WHERE id = ?').run('t-1');
  await lifecycle(f).submitVerification(verificationInput(f, second, 'code_failure', batch2), token);
  return { f, first, second };
}

async function expectPublicError(
  fn: () => unknown,
  expected: { readonly code?: string; readonly operation?: string; readonly reason?: string },
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (!isPublicError(error)) throw error;
    expect({ code: error.code, operation: error.operation, reason: error.details?.reason }).toMatchObject(expected);
    return;
  }
  throw new Error(`预期公开错误 ${JSON.stringify(expected)}，实际成功`);
}

describe('F-013 有限返工链分页', () => {
  it('历次 Attempt/失败引用/代码资格/预算阻止原因/Run 暂停原因/后继 blocked 原因与持久状态相符', async () => {
    const { f, first, second } = await openExhaustedChainFixture();
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    const chain = await queries.listTaskReworkChain(owner, {
      projectId: f.box.projectId, taskId: 't-1', limit: 10,
    });

    expect(chain.scope).toBe('task-rework-chain');
    expect(chain.records.map((record) => record.id)).toEqual([first.attempt.id, second.id]);
    /* 未知退出/耗时保持 null（不以 0 冒充）：首条 Attempt 现场中断后无结算耗时。 */
    f.box.session.transactWrite('clear-unknown-metrics', () => {
      f.box.session.database.prepare(
        'UPDATE attempts SET duration_ms = NULL, exit_code = NULL WHERE id = ?').run(first.attempt.id);
    });
    const refreshed = await queries.listTaskReworkChain(owner, {
      projectId: f.box.projectId, taskId: 't-1', limit: 10,
    });
    const firstRecord = refreshed.records.find((record) => record.id === first.attempt.id)!;
    expect(firstRecord.durationMs).toBeNull();
    expect(firstRecord.exitCode).toBeNull();
    for (const record of refreshed.records) {
      expect(record).toMatchObject({
        status: 'failed',
        executionStage: 'verification',
        errorKind: 'code_failure',
        codeRef: 't-1-code',
        diagnosticRef: 't-1-code',
        codeAccounting: {
          classification: 'code',
          outcome: 'code_failure',
          observationDigest: 'ef'.repeat(32),
          countsAsCodeAttempt: true,
        },
      });
      /* 返回内容与真实持久状态逐字段相符。 */
      const row = f.box.session.database.prepare(
        'SELECT exit_code AS e, duration_ms AS d, error_kind AS k FROM attempts WHERE id = ?').get(record.id) as
        { e: number | null; d: number | null; k: string | null };
      expect({ exitCode: record.exitCode, durationMs: record.durationMs, errorKind: record.errorKind })
        .toEqual({ exitCode: row.e, durationMs: row.d, errorKind: row.k });
    }

    /* 代码资格已用/剩余只取持久计数与策略副本上限（缺省含首次共三次）。 */
    expect(chain.summary.codeEligibility).toEqual({ used: 3, limit: 3, remaining: 0, rule: 'code_cap_default' });
    /* 总 Attempt 上限未配置保持 null，不虚构额度；已用取持久累计计数。 */
    expect(chain.summary.attempts).toEqual({ used: 3, limit: null, remaining: null });
    /* Run 暂停原因原样展示（与持久行一致）。 */
    expect(chain.summary.run).toMatchObject({ status: 'paused', reason: 'code_attempts_exhausted' });
    expect(f.box.session.database.prepare(
      'SELECT status, reason FROM runs WHERE id = ?').get(f.ids.runId))
      .toEqual({ status: 'paused', reason: 'code_attempts_exhausted' });
    /* 总预算阻止原因含 Task 代码资格耗尽（与 execution.budget.get 同一判定）。 */
    expect(
      chain.summary.budgetBlockReasons.some((entry) => entry.layer === 'task' && entry.reason === 'code_attempts_exhausted'),
    ).toBe(true);
    /* 后继 blocked 原因（t-2 依赖 t-1）来自同一 evaluateTaskDag 派生：
     * Run 暂停期间顶层控制原因优先，恢复 Run 后依赖链阻断原因可见。 */
    expect(chain.summary.blockedSuccessors).toEqual([
      { taskId: 't-2', status: 'pending', reason: 'run_control_blocked' },
    ]);
    f.box.session.transactWrite('resume-run', () => {
      f.box.session.database.prepare("UPDATE runs SET status = 'running', reason = NULL WHERE id = ?")
        .run(f.ids.runId);
    });
    const resumed = await queries.listTaskReworkChain(owner, {
      projectId: f.box.projectId, taskId: 't-1', limit: 10,
    });
    expect(resumed.summary.blockedSuccessors).toEqual([
      { taskId: 't-2', status: 'pending', reason: 'dependency_failed' },
    ]);

    /* 与真实持久状态相符。 */
    expect(f.box.session.database.prepare(
      'SELECT code_attempts_used AS used, attempt_counter AS total FROM tasks WHERE id = ?').get('t-1'))
      .toEqual({ used: 3, total: 3 });
    expect(resumed.summary.run).toMatchObject({ status: 'running', reason: null });
    f.box.close();
  });

  it('有界分页 + 游标纪律：limit=1 两页、跨 Task/非法游标 invalid_cursor、越权与未知目标不泄漏', async () => {
    const { f } = await openExhaustedChainFixture();
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);

    const page1 = await queries.listTaskReworkChain(owner, {
      projectId: f.box.projectId, taskId: 't-1', limit: 1,
    });
    expect(page1.records).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await queries.listTaskReworkChain(owner, {
      projectId: f.box.projectId, taskId: 't-1', limit: 1, cursor: page1.nextCursor!,
    });
    expect(page2.records).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(page1.records[0]!.number).toBe(1);
    expect(page2.records[0]!.number).toBe(2);

    /* 跨 Task 游标重放一律 invalid_cursor（不泄漏也不从零读取）。 */
    await expectPublicError(
      () => queries.listTaskReworkChain(owner, {
        projectId: f.box.projectId, taskId: 't-2', cursor: page1.nextCursor!,
      }),
      { code: 'invalid_input', operation: 'execution.task.rework-chain.list', reason: 'invalid_cursor' },
    );
    await expectPublicError(
      () => queries.listTaskReworkChain(owner, {
        projectId: f.box.projectId, taskId: 't-1', cursor: 'plcur_v1_%7B%7D',
      }),
      { code: 'invalid_input', operation: 'execution.task.rework-chain.list', reason: 'invalid_cursor' },
    );

    /* 越权 forbidden；跨项目/未知目标统一 not_found。 */
    const restricted = createRestrictedPrincipal({ capabilities: [], projectScope: scopeAllowlist([f.box.projectId]) });
    await expectPublicError(
      () => queries.listTaskReworkChain(restricted, { projectId: f.box.projectId, taskId: 't-1' }),
      { code: 'forbidden', operation: 'execution.task.rework-chain.list' },
    );
    await expectPublicError(
      () => queries.listTaskReworkChain(owner, { projectId: 'p-other', taskId: 't-1' }),
      { code: 'not_found', operation: 'execution.task.rework-chain.list' },
    );
    await expectPublicError(
      () => queries.listTaskReworkChain(owner, { projectId: f.box.projectId, taskId: 't-404' }),
      { code: 'not_found', operation: 'execution.task.rework-chain.list' },
    );
    f.box.close();
  });

  it('基础设施错误与等待人审不显示为代码额度消耗；查询零写入', async () => {
    const f = await openClaim();
    const first = await advanceToVerifying(f, 0, false);
    setRefs(f, first.attempt);
    const batchId = seedVerification(f, first.attempt, 'error');
    await lifecycle(f).submitVerification(
      verificationInput(f, first.attempt, 'non_code_failure', batchId), first.token);

    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    const snapshot = () =>
      (['tasks', 'attempts', 'task_attempt_reservations', 'runs', 'task_approval_items', 'state_events'] as const)
        .map((table) => `${table}:${JSON.stringify(f.box.session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all())}`)
        .join('\n');

    /* 查询零写入：前后持久快照完全一致。 */
    const before = snapshot();
    const chain = await queries.listTaskReworkChain(owner, {
      projectId: f.box.projectId, taskId: 't-1', limit: 10,
    });
    expect(snapshot()).toBe(before);

    /* 基础设施失败：独立记账分类，不折算为代码额度消耗。 */
    expect(chain.records).toHaveLength(1);
    expect(chain.records[0]).toMatchObject({
      errorKind: 'non_code_failure',
      codeAccounting: { classification: 'infrastructure', outcome: 'non_code_failure', countsAsCodeAttempt: false },
    });
    expect(chain.summary.run).toMatchObject({ status: 'paused', reason: 'infrastructure_error' });
    /* 资格只取持久计数（基础设施重分类已退还），不折算 Attempt 行数。 */
    const counters = f.box.session.database.prepare(
      'SELECT code_attempts_used AS used FROM tasks WHERE id = ?').get('t-1') as { used: number };
    expect(chain.summary.codeEligibility.used).toBe(counters.used);
    expect(counters.used).toBe(0);

    /* 等待人审（人工事项）不创建编码 Attempt、不改变代码资格显示。 */
    const plan = createSqlitePlanAccess(f.box.session, { nowUtcMs: () => NOW });
    const featureId = (f.box.session.database.prepare(
      'SELECT feature_id AS f FROM runs WHERE id = ?').get(f.ids.runId) as { f: string }).f;
    const planDigest = (f.box.session.database.prepare(
      'SELECT plan_digest AS p FROM features WHERE id = ?').get(featureId) as { p: string }).p;
    f.box.session.transactWrite('seed-approval', () =>
      plan.insertTaskApprovalItemInTransaction({
        projectId: f.box.projectId, featureId, taskId: 't-1', kind: 'block',
        description: '等待人工复核', responsibleParty: 'release-manager',
        planDigest, codeDigest: null, artifactRefs: [], createdBy: 'owner-1',
      }),
    );
    const afterApproval = await queries.listTaskReworkChain(owner, {
      projectId: f.box.projectId, taskId: 't-1', limit: 10,
    });
    expect(afterApproval.summary.codeEligibility.used).toBe(counters.used);
    expect(afterApproval.records).toHaveLength(1);
    f.box.close();
  });
});
