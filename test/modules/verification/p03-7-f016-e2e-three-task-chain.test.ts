/**
 * P03-7 / F-016：跨模块接线端到端（验收点 1）。
 *
 * 从正式装配入口（openCoreApplication 组合 + workExecution 调度 + FakeRuntime
 * 测试装配）驱动 t-1→t-2→t-3 三 Task 依赖链：
 * 1. t-1 首次检查失败（真实 VerificationBatch 定版 + 受信验证收尾）：
 *    Task 回 pending、后继在有效通过前保持 blocked（不认领、不启动）；
 * 2. 第二次增量修复成功：同 worktree 返工认领新 Attempt（F-011/F-012 契约），
 *    首跑已写文件原样保留；机器通过且无人审阻塞时直接完成验证收尾；
 * 3. t-1 有效通过后依赖才解锁：t-2、t-3 依次被调度、执行、验证并 passed；
 *    全部通过后调度给出 all_passed/feature_final_verification 交接，但
 *    P03-7 不把 Run 标记 succeeded、不标记 Feature completed（P03-8 边界）。
 *
 * 普通测试纪律：无网络、无模型、无真实凭据；显式 FakeRuntime + 真实临时
 * SQLite/Git/worktree/文件 + 受监督进程（tool_command 真实 OS 进程身份，
 * 停止证据可核验）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBindingFixture, BINDING_NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import type { BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { seedApprovalWaitingVerification } from '../../helpers/p03-7/approval-continue-seed.ts';
import { openFakeCoreApplication } from '../../../packages/core/src/adapters/testing.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createSqliteVerificationStore } from '../../../packages/core/src/adapters/sqlite/verification-store.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { evaluateTaskDag } from '../../../packages/core/src/application/task-dag.ts';
import {
  RUNTIME_RESULT_SCHEMA_VERSION, RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION,
} from '../../../packages/core/src/ports/runtime-execution.ts';

const CODE_DIGEST = 'cd'.repeat(32);
const HEAD = 'b'.repeat(40);
const MARKER_PATH = 'src/marker.ts';
const MARKER_CONTENT = 'export const marker = 1;\n';

let fixture: BindingFixture | undefined;
let core: CoreApplication | undefined;
afterEach(async () => {
  if (core) { await core.workExecution.close(); core.close(); core = undefined; }
  fixture?.close(); fixture = undefined;
});

const query = (sql: string, ...params: unknown[]) => fixture!.query(sql, ...params) as Record<string, unknown>;
const taskRow = (taskId: string) =>
  query('SELECT status, code_attempts_used, attempt_counter FROM tasks WHERE id = ?', taskId);
const runtimeStarts = () =>
  (query('SELECT runtime_starts FROM execution_batches') as { runtime_starts: number }).runtime_starts;

/** 只读 DAG 评估（无副作用；不用调度 scan 以免覆写 Run 暂停原因）。 */
const evaluateDag = () => evaluateTaskDag(
  createSqliteTaskDagStore(fixture!.session).readTaskDagView(fixture!.projectId, fixture!.runId), BINDING_NOW);

/** 真实定版失败批次：一条必需检查 failed(exitCode=1)，输出证据为真实制品。 */
async function seedFailedBatch(attempt: { id: string; execution_version: number; input_snapshot: string },
  ordinal: number) {
  const snapshot = JSON.parse(attempt.input_snapshot) as { approval: { checkPolicyDigest: string } };
  const body = `FAIL ${MARKER_PATH}\n1 failed\n`;
  const output = await fixture!.publisher.publishArtifact({
    projectId: fixture!.projectId, kind: 'verification_output', mediaType: 'text/plain',
    expectedHash: createHash('sha256').update(body).digest('hex'),
    locator: `verification/${attempt.id}/tests-output.txt`,
    content: [Buffer.from(body, 'utf8')],
  });
  const verification = createSqliteVerificationStore(fixture!.session, { nowUtcMs: () => BINDING_NOW });
  const atomic = createSqliteAtomicCommandStore(fixture!.session, { nowUtcMs: () => BINDING_NOW });
  const batchId = `verification-f016-fail-${ordinal}`;
  await atomic.transact('F-016.seed-failed-verification', transaction => {
    verification.createVerificationBatchInTransaction(transaction, {
      batchId, projectId: fixture!.projectId, featureId: fixture!.featureId, runId: fixture!.runId,
      taskId: 't-1', attemptId: attempt.id, executionVersion: attempt.execution_version,
      operation: 'task.verify.checks', codeDigest: CODE_DIGEST,
      policyDigest: snapshot.approval.checkPolicyDigest,
      environmentSummary: { runner: 'node', nodeVersion: process.version, platform: process.platform },
      checkSnapshot: [{ checkKey: 'tests', scope: 'task', kind: 'command', argv: ['npm', 'test'],
        cwdRef: null, environmentRef: null, timeout: 60_000, required: true, requirementRefs: [] }],
      selection: { schemaVersion: 1, mode: 'candidates', reason: '受影响范围选择', selectedCheckKeys: ['tests'] },
      startedAtUtcMs: BINDING_NOW,
    });
    verification.saveCheckResultInTransaction(transaction, {
      resultId: `vres-f016-fail-${ordinal}`, projectId: fixture!.projectId, batchId, checkKey: 'tests',
      status: 'failed', exitCode: 1, signal: null, timedOut: false,
      outputArtifactId: output.artifact.id, outputTail: '1 failed',
      startedAtUtcMs: BINDING_NOW, endedAtUtcMs: BINDING_NOW + 1000,
    });
    verification.finalizeVerificationBatchInTransaction(transaction, {
      projectId: fixture!.projectId, batchId, expectedRevision: 1, status: 'failed',
    });
  });
  return { batchId, policyDigest: snapshot.approval.checkPolicyDigest };
}

/** 当前 verifying Attempt 行（每 Task 至多一个）。 */
const verifyingAttempt = (taskId: string) =>
  query("SELECT id, owner_id, host_instance_id, execution_version, input_snapshot FROM attempts WHERE task_id = ? AND status = 'verifying'", taskId) as unknown as {
    id: string; owner_id: string; host_instance_id: string; execution_version: number; input_snapshot: string;
  };

const failedObservation = (policyDigest: string) => ({
  runtime: {
    result: { schemaVersion: RUNTIME_RESULT_SCHEMA_VERSION, terminal: 'completed', reason: null,
      exitCode: 0, signal: null, durationMs: 10, usage: null, lastEventSequence: null },
    stopped: { schemaVersion: RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION, confirmed: true,
      checkedAtUtc: new Date(BINDING_NOW).toISOString(), detail: null },
  },
  workspaceHeld: true,
  beforeIdentity: { headCommit: HEAD, codeDigest: CODE_DIGEST, executionDigest: policyDigest },
  afterIdentity: { headCommit: HEAD, codeDigest: CODE_DIGEST, executionDigest: policyDigest },
  testCounts: { tests: 1 },
});

describe('F-016 三 Task 链端到端（正式装配入口）', () => {
  it('首次检查失败 → 同 worktree 增量修复成功 → 依赖仅在有效通过后解锁', async () => {
    fixture = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true, thirdTaskChained: true,
      deliveryPolicy: { commitMode: 'task_and_feature',
        gitIdentity: { name: 'Test Owner', email: 'owner@example.test', confirmed: true } },
    });
    core = await openFakeCoreApplication({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
      ]),
      nowUtcMs: () => BINDING_NOW,
      fake: {
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        /* tool_command 产生真实 OS 进程身份：停止证据（整组缺席普查）可证明。 */
        commandProcess: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
        toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
        script: { schemaVersion: 1, steps: [
          { op: 'write_file', path: MARKER_PATH, content: MARKER_CONTENT },
          { op: 'tool_command', name: 'probe' },
          { op: 'message', role: 'assistant', text: 'F-016 链式执行' },
        ] },
      },
    });

    /* ---- 第一轮：t-1 认领并执行（首次尝试）。 ---- */
    const first = await core.workExecution.scan();
    expect(first.runs).toMatchObject([{ claimed: true }]);
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    const attempt1 = verifyingAttempt('t-1');
    const worktreePath =
      (query('SELECT canonical_path FROM managed_workspaces') as { canonical_path: string }).canonical_path;
    expect(readFileSync(join(worktreePath, MARKER_PATH), 'utf8')).toBe(MARKER_CONTENT);
    expect(runtimeStarts()).toBe(1);
    expect(taskRow('t-1')).toMatchObject({ status: 'running', code_attempts_used: 1, attempt_counter: 1 });

    /* 依赖在 t-1 有效通过前不解锁：t-2/t-3 无 Attempt、状态保持 pending。 */
    expect(query('SELECT COUNT(*) AS n FROM attempts WHERE task_id IN (?, ?)', 't-2', 't-3'))
      .toMatchObject({ n: 0 });
    expect(query('SELECT status FROM tasks WHERE id = ?', 't-2')).toMatchObject({ status: 'pending' });
    expect(query('SELECT status FROM tasks WHERE id = ?', 't-3')).toMatchObject({ status: 'pending' });

    /* ---- 首次检查失败（真实定版批次 + 受信收尾）→ code_failure。 ---- */
    const { batchId, policyDigest } = await seedFailedBatch(attempt1, 1);
    const failure = await core.taskVerificationCompletion.complete({
      identity: { projectId: fixture.projectId, attemptId: attempt1.id, owner: attempt1.owner_id,
        hostInstanceId: attempt1.host_instance_id, executionVersion: attempt1.execution_version },
      taskId: 't-1', runId: fixture.runId, verificationBatchId: batchId,
      observation: failedObservation(policyDigest),
      failures: { tests: 'code' },
    });
    expect(failure.outcome).toBe('code_failure');
    expect(failure.receipt).toMatchObject({ disposition: 'applied', status: 'failed' });
    expect(taskRow('t-1')).toMatchObject({ status: 'pending', code_attempts_used: 1 });
    expect(query('SELECT status, reason FROM runs WHERE id = ?', fixture.runId))
      .toEqual({ status: 'running', reason: null });
    /* t-1 未有效通过：只读 DAG 评估仅 t-1 可认领，t-2/t-3 仍 dependency_pending。 */
    const dagAfterFailure = evaluateDag();
    expect(dagAfterFailure.readyTaskIds).toEqual(['t-1']);
    const dagReasons = new Map(dagAfterFailure.tasks.map(task => [task.taskId, task.reason]));
    expect(dagReasons.get('t-2')).toBe('dependency_pending');
    expect(dagReasons.get('t-3')).toBe('dependency_pending');

    /* ---- 第二次增量修复：同 worktree 返工认领新 Attempt。 ---- */
    const second = await core.workExecution.scan();
    expect(second.runs).toMatchObject([{ claimed: true }]);
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    expect((query('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', 't-1') as { n: number }).n).toBe(2);
    const attempt2 = verifyingAttempt('t-1');
    expect(attempt2.id).not.toBe(attempt1.id);
    expect(attempt2.execution_version).toBe(2);
    /* 同一受管 worktree：首跑写入的文件在返工启动后原样可见。 */
    expect((query('SELECT canonical_path FROM managed_workspaces') as { canonical_path: string }).canonical_path)
      .toBe(worktreePath);
    expect(readFileSync(join(worktreePath, MARKER_PATH), 'utf8')).toBe(MARKER_CONTENT);
    expect(runtimeStarts()).toBe(2);
    expect(taskRow('t-1')).toMatchObject({ status: 'running', code_attempts_used: 2, attempt_counter: 2 });

    /* ---- 修复成功：真实定版 passed 批次 + 受信收尾直接放行（无人审阻塞）。 ---- */
    const passed = await seedApprovalWaitingVerification({
      fixture: fixture!, completion: core.taskVerificationCompletion,
      taskId: 't-1', approvalItem: false,
    });
    expect(passed.taskId).toBe('t-1');
    expect(taskRow('t-1')).toMatchObject({ status: 'passed', code_attempts_used: 2, attempt_counter: 2 });
    expect(query('SELECT status FROM attempts WHERE id = ?', attempt2.id)).toMatchObject({ status: 'succeeded' });
    expect(query('SELECT status, reason FROM runs WHERE id = ?', fixture.runId))
      .toEqual({ status: 'running', reason: null });

    /* ---- t-1 有效通过后依赖才解锁：t-2 被调度执行。 ---- */
    const third = await core.workExecution.scan();
    expect(third.runs).toMatchObject([{ claimed: true }]);
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    const attemptT2 = verifyingAttempt('t-2');
    expect(attemptT2.id).not.toBe(attempt2.id);
    expect(runtimeStarts()).toBe(3);
    /* t-3 仍被 t-2 阻塞。 */
    expect(query('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', 't-3')).toMatchObject({ n: 0 });
    await seedApprovalWaitingVerification({
      fixture: fixture!, completion: core.taskVerificationCompletion, taskId: 't-2', approvalItem: false,
    });
    expect(taskRow('t-2')).toMatchObject({ status: 'passed', code_attempts_used: 1, attempt_counter: 1 });

    /* ---- t-3 解锁并完成：链尾收口。 ---- */
    const fourth = await core.workExecution.scan();
    expect(fourth.runs).toMatchObject([{ claimed: true }]);
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    expect(runtimeStarts()).toBe(4);
    await seedApprovalWaitingVerification({
      fixture: fixture!, completion: core.taskVerificationCompletion, taskId: 't-3', approvalItem: false,
    });
    expect(taskRow('t-3')).toMatchObject({ status: 'passed', code_attempts_used: 1, attempt_counter: 1 });

    /* 全部通过：调度给出最终验证交接缺口（P03-8 才装配 final verification
     * 消费者）；P03-7 不标 Run succeeded/Feature completed。 */
    const final = await core.workExecution.scan();
    expect(final.runs).toMatchObject([{ reason: 'scheduler_capability_missing', claimed: false }]);
    expect(query('SELECT status FROM runs WHERE id = ?', fixture.runId)).toMatchObject({ status: 'running' });
    /* Feature 不被冒称完成（P03-8 最终交付边界）。 */
    expect(query('SELECT status FROM features WHERE id = ?', fixture.featureId)).toMatchObject({ status: 'draft' });
    /* 首跑与返工的全部文件证据仍保留（不清空重写）。 */
    expect(readFileSync(join(worktreePath, MARKER_PATH), 'utf8')).toBe(MARKER_CONTENT);
    /* 受管进程停止核验：关闭后无未决 Attempt，关闭确认。 */
    const closed = await core.workExecution.close();
    expect(closed).toMatchObject({ closed: true, pendingAttemptIds: [] });
  // 三次真实受控 Git 提交及四个进程生命周期，预算不能沿用无提交的旧夹具。
  }, 180_000);
});
