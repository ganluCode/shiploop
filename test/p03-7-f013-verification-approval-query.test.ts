/**
 * P03-7 / F-013：Task 机器证据与独立人审事项的授权只读查询（验证与审批查询）。
 *
 * 验收面（.dag_context.json F-013）：
 * 1. 经授权查询取得 Task 当前机器结论、VerificationBatch/CheckResult、选择/
 *    回退理由、代码身份、输出 Artifact/tail，以及独立人审事项、责任主体、绑定
 *    摘要和决定；机器 passed 不展示为有效 Task passed；
 * 2. 沿用有界分页、项目可见性和稳定错误协议；越权、跨项目、非法游标及损坏
 *    证据不泄漏内容；查询不修改状态或触发 Runtime；
 * 3. 返回内容与真实持久状态相符（同一 SQLite 一致读视图逐字段核对）。
 */
import { describe, expect, it } from 'vitest';
import { createQueryService } from '../packages/core/src/application/query-service.ts';
import type { QueryService } from '../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { createSqlitePlanAccess } from '../packages/core/src/adapters/sqlite/plan-store.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { computeDataRootIdentity } from '../packages/core/src/ports/path-service.ts';
import { isPublicError } from '../packages/core/src/ports/commands.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import {
  openBindingFixture,
  BINDING_NOW,
  type BindingFixture,
} from './helpers/p03-6/input-binding-fixture.ts';
import type { ClaimedAttempt } from './helpers/p03-6/input-binding-fixture.ts';
import {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
  scopeAllowlist,
} from './helpers/p02-2/principals.ts';

const owner = createLocalOwnerPrincipal();
const CODE_DIGEST = 'cd'.repeat(32);
const POLICY_DIGEST = 'ef'.repeat(32);

/** 与生产装配同一入口：真实 SQLite 查询门面 + 授权 QueryService（固定时钟）。 */
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
    gitOperationReads: queryStore,
    featureDeliveryReads: queryStore,
    artifacts: createSqliteArtifactStore(session),
    artifactFiles: createArtifactFileStore({ dataRoot }),
    dataRootIdentity: computeDataRootIdentity(dataRoot),
    nowUtcMs: () => BINDING_NOW,
  });
}

/** 认领 t-1 后以真实 VerificationStore 播种已定版机器证据（passed 批次）。 */
async function openEvidenceFixture() {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  const claim = f.claimTask('t-1');
  const attempt: ClaimedAttempt['receipt']['attempt'] = claim.receipt.attempt;
  const verification = createSqliteVerificationStore(f.session, { nowUtcMs: () => BINDING_NOW });
  const batchId = `batch-${attempt.id}`;
  const resultId = `result-${attempt.id}`;
  verification.createVerificationBatch({
    batchId,
    projectId: f.projectId,
    featureId: f.featureId,
    runId: f.runId,
    taskId: 't-1',
    attemptId: attempt.id,
    executionVersion: attempt.executionVersion,
    operation: 'task.checks',
    codeDigest: CODE_DIGEST,
    policyDigest: POLICY_DIGEST,
    environmentSummary: { runner: 'node', nodeVersion: '22.19.0' },
    checkSnapshot: [
      {
        checkKey: 'unit',
        scope: 'task',
        kind: 'command',
        argv: ['node', '--test'],
        cwdRef: 'workspace-root',
        environmentRef: null,
        timeout: 60_000,
        required: true,
        requirementRefs: [],
      },
    ],
    selection: {
      schemaVersion: 1,
      mode: 'candidates',
      reason: 'candidates_cover_affected_modules',
      selectedCheckKeys: ['unit'],
    },
    startedAtUtcMs: BINDING_NOW,
  });
  verification.saveCheckResult({
    resultId,
    projectId: f.projectId,
    batchId,
    checkKey: 'unit',
    status: 'passed',
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputArtifactId: attempt.inputRef,
    outputTail: 'ok 1 test',
    startedAtUtcMs: BINDING_NOW,
    endedAtUtcMs: BINDING_NOW + 10,
  });
  verification.finalizeVerificationBatch({
    projectId: f.projectId,
    batchId,
    expectedRevision: 1,
    status: 'passed',
    endedAtUtcMs: BINDING_NOW + 10,
  });
  return { f, claim, attempt, batchId, resultId };
}

/** 经既有计划写入端口播种人审事项（与命令通道同一事务语义）。 */
function addApprovalItem(
  f: BindingFixture,
  input: {
    readonly kind: 'block' | 'approval';
    readonly description: string;
    readonly responsibleParty: string;
    readonly planDigest: string;
    readonly codeDigest: string | null;
  },
): { readonly id: string; readonly revision: number } {
  const plan = createSqlitePlanAccess(f.session, { nowUtcMs: () => BINDING_NOW });
  f.session.transactWrite('seed-task-approval-item', () =>
    plan.insertTaskApprovalItemInTransaction({
      projectId: f.projectId,
      featureId: f.featureId,
      taskId: 't-1',
      kind: input.kind,
      description: input.description,
      responsibleParty: input.responsibleParty,
      planDigest: input.planDigest,
      codeDigest: input.codeDigest,
      artifactRefs: [],
      createdBy: 'owner-1',
    }),
  );
  return f.query(
    'SELECT id, revision FROM task_approval_items WHERE project_id = ? AND task_id = ? AND description = ?',
    f.projectId,
    't-1',
    input.description,
  ) as { id: string; revision: number };
}

function decideApprovalItem(
  f: BindingFixture,
  itemId: string,
  expectedRevision: number,
  input: {
    readonly decision: 'approve' | 'reject' | 'unblock';
    readonly planDigest: string;
    readonly codeDigest: string;
    readonly reason: string | null;
    readonly decisionActor: string;
  },
): void {
  const plan = createSqlitePlanAccess(f.session, { nowUtcMs: () => BINDING_NOW });
  f.session.transactWrite('decide-task-approval-item', () =>
    plan.decideTaskApprovalItemInTransaction({
      projectId: f.projectId,
      taskId: 't-1',
      itemId,
      expectedRevision,
      decision: input.decision,
      planDigest: input.planDigest,
      codeDigest: input.codeDigest,
      artifactRefs: [],
      reason: input.reason,
      decisionActor: input.decisionActor,
    }),
  );
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

describe('F-013 Task 机器证据查询', () => {
  it('批次/检查/选择理由/代码身份/输出 Artifact/tail 与持久状态一致，机器 passed 不展示为有效 Task passed', async () => {
    const { f, attempt, batchId, resultId } = await openEvidenceFixture();
    const queries = assembleQueries(f.session, f.box.dataRoot);
    const result = await queries.getTaskVerification(owner, {
      projectId: f.projectId,
      taskId: 't-1',
    });

    /* 机器结论只反映机器事实；有效 Task passed 只绑定持久 Task 状态。 */
    expect(result.scope).toBe('task-verification');
    expect(result.machine).toMatchObject({
      status: 'passed',
      reason: 'checks_passed',
      outcome: null,
      attemptId: attempt.id,
      batchId,
      codeDigest: CODE_DIGEST,
      policyDigest: POLICY_DIGEST,
    });
    expect(result.machine.codeRef).toBe(
      (f.query('SELECT code_ref AS r FROM attempts WHERE id = ?', attempt.id) as { r: string | null }).r,
    );
    expect(result.task.taskId).toBe('t-1');
    expect(result.task.status).toBe((f.query('SELECT status FROM tasks WHERE id = ?', 't-1') as { status: string }).status);
    expect(result.task.effectivePassed).toBe(false);

    /* VerificationBatch/CheckResult、选择/回退理由、代码身份与输出引用。 */
    expect(result.batches).toHaveLength(1);
    const batch = result.batches[0]!;
    expect(batch).toMatchObject({
      id: batchId,
      attemptId: attempt.id,
      codeDigest: CODE_DIGEST,
      policyDigest: POLICY_DIGEST,
      status: 'passed',
      environmentSummary: { runner: 'node', nodeVersion: '22.19.0' },
    });
    expect(batch.selection).toEqual({
      mode: 'candidates',
      reason: 'candidates_cover_affected_modules',
      selectedCheckKeys: ['unit'],
    });
    expect(batch.checks).toHaveLength(1);
    expect(batch.checks[0]).toMatchObject({
      id: resultId,
      checkKey: 'unit',
      required: true,
      status: 'passed',
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputArtifactId: attempt.inputRef,
      outputDigest: (f.query('SELECT content_hash AS h FROM artifacts WHERE id = ?', attempt.inputRef) as { h: string }).h,
      outputTail: 'ok 1 test',
    });
    expect(result.batchesTruncated).toBe(false);

    /* 与真实持久状态逐字段相符（同一 SQLite 权威行）。 */
    expect(f.query('SELECT status, code_digest FROM verification_batches WHERE id = ?', batchId)).toEqual({
      status: 'passed',
      code_digest: CODE_DIGEST,
    });
    expect(
      f.query('SELECT status, exit_code, output_artifact_id, output_tail FROM check_results WHERE id = ?', resultId),
    ).toEqual({ status: 'passed', exit_code: 0, output_artifact_id: attempt.inputRef, output_tail: 'ok 1 test' });
    f.close();
  });

  it('查询零写入、零事件：前后持久快照完全一致', async () => {
    const { f } = await openEvidenceFixture();
    const queries = assembleQueries(f.session, f.box.dataRoot);
    const snapshot = () =>
      (['tasks', 'attempts', 'verification_batches', 'check_results', 'task_approval_items', 'state_events'] as const)
        .map((table) => [table, f.query(`SELECT * FROM ${table} ORDER BY id`)])
        .map(([table, rows]) => `${table}:${JSON.stringify(rows)}`)
        .join('\n');
    const before = snapshot();
    await queries.getTaskVerification(owner, { projectId: f.projectId, taskId: 't-1' });
    await queries.listTaskApprovalItems(owner, { projectId: f.projectId, taskId: 't-1' });
    expect(snapshot()).toBe(before);
    f.close();
  });
});

describe('F-013 独立人审事项查询', () => {
  it('事项、责任主体、绑定摘要和决定独立展示，不与机器结论混为一谈', async () => {
    const { f } = await openEvidenceFixture();
    const planDigest = (
      f.query('SELECT plan_digest AS p FROM features WHERE id = ?', f.featureId) as { p: string }
    ).p;
    const decided = addApprovalItem(f, {
      kind: 'approval',
      description: '确认检查定义与回退策略',
      responsibleParty: 'release-manager',
      planDigest,
      codeDigest: CODE_DIGEST,
    });
    addApprovalItem(f, {
      kind: 'block',
      description: '等待安全复核',
      responsibleParty: 'security-reviewer',
      planDigest,
      codeDigest: null,
    });
    decideApprovalItem(f, decided.id, decided.revision, {
      decision: 'approve',
      planDigest,
      codeDigest: CODE_DIGEST,
      reason: '已确认检查定义',
      decisionActor: 'release-manager',
    });

    const queries = assembleQueries(f.session, f.box.dataRoot);
    const items = await queries.listTaskApprovalItems(owner, {
      projectId: f.projectId,
      taskId: 't-1',
    });
    expect(items.scope).toBe('task-approval-item-list');
    expect(items.records).toHaveLength(2);
    const approval = items.records.find((record) => record.kind === 'approval')!;
    expect(approval).toMatchObject({
      responsibleParty: 'release-manager',
      status: 'approved',
      decision: 'approve',
      decisionActor: 'release-manager',
      decisionReason: '已确认检查定义',
      planDigest,
      codeDigest: CODE_DIGEST,
    });
    expect(approval.decidedAt).toBeTypeOf('string');
    const block = items.records.find((record) => record.kind === 'block')!;
    expect(block).toMatchObject({
      responsibleParty: 'security-reviewer',
      status: 'pending',
      decision: null,
      decisionActor: null,
      decidedAt: null,
      planDigest,
    });

    /* 机器证据与人审事项分开展示：机器节不携带人审字段。 */
    const detail = await queries.getTaskVerification(owner, { projectId: f.projectId, taskId: 't-1' });
    expect(Object.keys(detail.machine).sort()).toEqual(
      ['attemptId', 'batchId', 'codeDigest', 'codeRef', 'observationDigest', 'outcome', 'policyDigest', 'reason', 'status'],
    );
    expect(detail.machine.status).toBe('passed');
    expect(detail.task.effectivePassed).toBe(false);
    f.close();
  });

  it('有界分页 + 稳定错误协议：跨 Task 游标/越权/跨项目/未知 Task 不泄漏内容', async () => {
    const { f } = await openEvidenceFixture();
    const planDigest = (
      f.query('SELECT plan_digest AS p FROM features WHERE id = ?', f.featureId) as { p: string }
    ).p;
    for (const description of ['事项 A', '事项 B']) {
      addApprovalItem(f, {
        kind: 'block',
        description,
        responsibleParty: 'release-manager',
        planDigest,
        codeDigest: null,
      });
    }
    const queries = assembleQueries(f.session, f.box.dataRoot);

    /* 有界分页：limit=1 两页取回全部，页末 nextCursor 为 null。 */
    const page1 = await queries.listTaskApprovalItems(owner, {
      projectId: f.projectId,
      taskId: 't-1',
      limit: 1,
    });
    expect(page1.records).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await queries.listTaskApprovalItems(owner, {
      projectId: f.projectId,
      taskId: 't-1',
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.records).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(page1.records[0]!.id).not.toBe(page2.records[0]!.id);

    /* 跨 Task 游标重放一律 invalid_cursor，绝不当作从零读取。 */
    await expectPublicError(
      () => queries.listTaskApprovalItems(owner, { projectId: f.projectId, taskId: 't-2', cursor: page1.nextCursor! }),
      { code: 'invalid_input', operation: 'execution.task.approvals.list', reason: 'invalid_cursor' },
    );

    /* 越权主体 forbidden；跨项目/未知目标统一 not_found（不泄漏存在性）。 */
    const restricted = createRestrictedPrincipal({ capabilities: [], projectScope: scopeAllowlist([f.projectId]) });
    await expectPublicError(
      () => queries.getTaskVerification(restricted, { projectId: f.projectId, taskId: 't-1' }),
      { code: 'forbidden', operation: 'execution.task.verification.get' },
    );
    await expectPublicError(
      () => queries.getTaskVerification(owner, { projectId: 'p-other', taskId: 't-1' }),
      { code: 'not_found', operation: 'execution.task.verification.get' },
    );
    await expectPublicError(
      () => queries.getTaskVerification(owner, { projectId: f.projectId, taskId: 't-404' }),
      { code: 'not_found', operation: 'execution.task.verification.get' },
    );

    /* 非法游标形态 invalid_input(invalid_cursor)。 */
    await expectPublicError(
      () => queries.listTaskApprovalItems(owner, { projectId: f.projectId, taskId: 't-1', cursor: 'plcur_v1_bad' }),
      { code: 'invalid_input', operation: 'execution.task.approvals.list', reason: 'invalid_cursor' },
    );
    f.close();
  });

  it('损坏持久证据 fail-closed 为 corrupt_state，不泄漏原始内容', async () => {
    const { f, attempt } = await openEvidenceFixture();
    /* 已定版验证批次是不可变证据行（迁移触发器拒绝改写）；损坏只可能出现在
     * 可变结算账本——此处验证读取面 fail-closed 为 corrupt_state。 */
    expect(() =>
      f.session.transactWrite('corrupt-batch', () => {
        f.session.database
          .prepare('UPDATE verification_batches SET selection = ? WHERE id = ?')
          .run('{"schemaVersion":1', `batch-${attempt.id}`);
      }),
    ).toThrow(/immutable/);
    f.session.transactWrite('corrupt-settlement', () => {
      f.session.database
        .prepare("UPDATE task_attempt_reservations SET reason = ? WHERE attempt_key = ?")
        .run('verification-budget:v1:{"outcome":', attempt.id);
    });
    const queries = assembleQueries(f.session, f.box.dataRoot);
    await expectPublicError(
      () => queries.getTaskVerification(owner, { projectId: f.projectId, taskId: 't-1' }),
      { code: 'corrupt_state', operation: 'execution.task.verification.get' },
    );
    f.close();
  });
});
