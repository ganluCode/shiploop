/**
 * P03-7 / F-016：人审/放行与预算持久化跨模块集成（验收点 2 第二组 + 验收点 3）。
 *
 * 全部经正式装配入口（openCoreApplication 组合 + workExecution 调度 + 显式
 * FakeRuntime + 真实临时 SQLite/Git/worktree/受监督进程），直接断言权威状态、
 * 持久计数、命令回执与 Runtime 启动次数：
 *
 * 组一（人审与放行）：
 * - 机器绿色仍等待人审：Task 不 passed、Run paused(approval)、后继不解锁；
 * - 新阻塞与完成竞争：批准后新增阻塞使显式继续保持等待；解除不启动编码
 *   （runtime_starts/Attempt 计数不变）；
 * - 越权/过期批准拒绝；显式继续复用有效证据（零新增编码调用）。
 *
 * 组二（预算与失败链）：
 * - 三次含首次耗尽：第三次有效代码失败后 Task failed、Run 暂停
 *   code_attempts_exhausted、后继 blocked、runtime_starts=3；
 * - 重复与迟到结果不放行（invalid_transition，状态不变）；
 * - 新 Run（同 Batch 显式重试）不重置 Task 累计计数；
 * - 数据库重开后计数/失败链仍为权威状态；
 * - 基础设施错误不误扣代码额度（独立 infrastructure_error 分支，不自动返工）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { openBindingFixture, BINDING_NOW } from './helpers/p03-6/input-binding-fixture.ts';
import type { BindingFixture } from './helpers/p03-6/input-binding-fixture.ts';
import { seedApprovalWaitingVerification } from './helpers/p03-7/approval-continue-seed.ts';
import { openFakeCoreApplication } from '../packages/core/src/adapters/testing.ts';
import type { CoreApplication } from '../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createLocalOwnerPrincipal, createRestrictedPrincipal } from './helpers/p02-2/index.ts';
import type { CommandReceipt } from '../packages/core/src/ports/commands.ts';
import {
  RUNTIME_RESULT_SCHEMA_VERSION, RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION,
} from '../packages/core/src/ports/runtime-execution.ts';

const CODE_DIGEST = 'cd'.repeat(32);
const HEAD = 'b'.repeat(40);
const MARKER_PATH = 'src/marker.ts';

const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];

const owner = createLocalOwnerPrincipal();

let fixture: BindingFixture | undefined;
let core: CoreApplication | undefined;
afterEach(async () => {
  if (core) { await core!.workExecution.close(); core.close(); core = undefined; }
  fixture?.close(); fixture = undefined;
});

const query = (sql: string, ...params: unknown[]) => fixture!.query(sql, ...params) as Record<string, unknown>;
const taskRow = (taskId: string) =>
  query('SELECT status, code_attempts_used, attempt_counter FROM tasks WHERE id = ?', taskId);
const runtimeStarts = () =>
  (query('SELECT runtime_starts FROM execution_batches') as { runtime_starts: number }).runtime_starts;
const attemptCount = (taskId: string) =>
  (query('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', taskId) as { n: number }).n;
const verifyingAttempt = (taskId: string) =>
  query("SELECT id, owner_id, host_instance_id, execution_version, input_snapshot FROM attempts WHERE task_id = ? AND status = 'verifying'", taskId) as unknown as {
    id: string; owner_id: string; host_instance_id: string; execution_version: number; input_snapshot: string;
  };

function openCore(): Promise<CoreApplication> {
  return openFakeCoreApplication({
    dataRoot: fixture!.box.dataRoot,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]),
    nowUtcMs: () => BINDING_NOW,
    fake: {
      providers,
      commandProcess: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
      toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
      script: { schemaVersion: 1, steps: [
        { op: 'write_file', path: MARKER_PATH, content: 'export const marker = 1;\n' },
        { op: 'tool_command', name: 'probe' },
        { op: 'message', role: 'assistant', text: 'F-016' },
      ] },
    },
  });
}

async function openCase(): Promise<void> {
  fixture = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  core = await openCore();
}

/** 经正式命令通道提交（真实幂等回执/事件）。 */
const submit = (operation: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  core!.commandService.submit(owner, {
    schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(BINDING_NOW).toISOString(),
    operation, payload, scope: { kind: 'project', projectId: fixture!.projectId }, ...extra,
  } as never);

const completedResult = (receipt: CommandReceipt): Record<string, unknown> => {
  if (receipt.status !== 'completed') throw new Error(`命令未完成: ${JSON.stringify(receipt)}`);
  return receipt.result as Record<string, unknown>;
};

/** 真实定版失败批次（必需检查 failed，输出证据为真实制品）。 */
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
  const batchId = `verification-f016-${ordinal}`;
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
      resultId: `vres-f016-${ordinal}`, projectId: fixture!.projectId, batchId, checkKey: 'tests',
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

/** 调度执行 t-1 到 verifying，再用真实定版失败批次收尾。 */
async function runAndSettle(failures: Record<string, string>, ordinal: number) {
  const scan = await core!.workExecution.scan();
  expect(scan.runs).toMatchObject([{ claimed: true }]);
  await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
  const attempt = verifyingAttempt('t-1');
  const { batchId, policyDigest } = await seedFailedBatch(attempt, ordinal);
  const completion = await core!.taskVerificationCompletion.complete({
    identity: { projectId: fixture!.projectId, attemptId: attempt.id, owner: attempt.owner_id,
      hostInstanceId: attempt.host_instance_id, executionVersion: attempt.execution_version },
    taskId: 't-1', runId: fixture!.runId, verificationBatchId: batchId,
    observation: failedObservation(policyDigest),
    failures: failures as never,
  });
  return { attempt, batchId, policyDigest, completion };
}

describe('F-016 人审与放行集成（正式装配入口）', () => {
  it('机器绿仍等人审；新阻塞竞争保持等待；解除不启动编码；显式继续复用证据', async () => {
    await openCase();
    const first = await core!.workExecution.scan();
    expect(first.runs).toMatchObject([{ claimed: true }]);
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    const startsAfterRun = runtimeStarts();
    const attemptsAfterRun = attemptCount('t-1');

    /* 机器 passed + pending 事项 → 等待人审：Task 不 passed、Run paused(approval)。 */
    const seeded = await seedApprovalWaitingVerification({ fixture: fixture!, completion: core!.taskVerificationCompletion });
    expect(seeded.approvalItemId).toBeTruthy();
    expect(taskRow('t-1')).toMatchObject({ status: 'running', code_attempts_used: 1 });
    expect(query('SELECT status FROM attempts WHERE id = ?', seeded.attemptId)).toMatchObject({ status: 'verifying' });
    expect(query('SELECT status, reason FROM runs WHERE id = ?', fixture!.runId))
      .toEqual({ status: 'paused', reason: 'approval' });
    /* 后继不解锁：t-2 无 Attempt；Run 保持等待人审暂停（调度不会认领）。 */
    expect(attemptCount('t-2')).toBe(0);
    expect(query('SELECT status, reason FROM runs WHERE id = ?', fixture!.runId))
      .toEqual({ status: 'paused', reason: 'approval' });

    /* 越权主体：缺少 feature.plan.decide 能力 → forbidden。 */
    const restricted = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'all' } });
    await expect(core!.commandService.submit(restricted, {
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(BINDING_NOW).toISOString(),
      operation: 'task.approval.approve', scope: { kind: 'project', projectId: fixture!.projectId },
      expectedRevision: seeded.approvalItemRevision,
      payload: { taskId: 't-1', itemId: seeded.approvalItemId, planDigest: seeded.planDigest,
        codeDigest: seeded.codeDigest, artifactRefs: [], reason: '越权尝试' },
    } as never)).rejects.toMatchObject({ code: 'forbidden' });

    /* 过期/漂移摘要：codeDigest 不匹配 → conflict，不产生决定。 */
    await expect(submit('task.approval.approve', {
      taskId: 't-1', itemId: seeded.approvalItemId, planDigest: seeded.planDigest,
      codeDigest: 'ab'.repeat(32), artifactRefs: [], reason: '过期摘要',
    }, { expectedRevision: seeded.approvalItemRevision })).rejects.toMatchObject({ code: 'conflict' });
    expect(query('SELECT status FROM task_approval_items WHERE id = ?', seeded.approvalItemId))
      .toMatchObject({ status: 'pending' });

    /* 合法批准：零 Runtime 调用；同 commandId 重放同一回执。 */
    const approveCommandId = randomUUID();
    const approveEnvelope = {
      schemaVersion: 5, commandId: approveCommandId, issuedAt: new Date(BINDING_NOW).toISOString(),
      operation: 'task.approval.approve', scope: { kind: 'project', projectId: fixture!.projectId },
      expectedRevision: seeded.approvalItemRevision,
      payload: { taskId: 't-1', itemId: seeded.approvalItemId, planDigest: seeded.planDigest,
        codeDigest: seeded.codeDigest, artifactRefs: [], reason: '复核通过' },
    } as never;
    const approved = await core!.commandService.submit(owner, approveEnvelope);
    expect(completedResult(approved)).toMatchObject({ decision: 'approve' });
    const replayed = await core!.commandService.submit(owner, approveEnvelope);
    expect((replayed as { replayed?: boolean }).replayed).toBe(true);

    /* 新阻塞与完成竞争：批准后新增 block → manual_block；继续保持等待。 */
    const taskRevision = (query('SELECT revision FROM tasks WHERE id = ?', 't-1') as { revision: number }).revision;
    const blocked = completedResult(await submit('task.approval.block', {
      taskId: 't-1', planDigest: seeded.planDigest, kind: 'block',
      description: '交付前人工复核', responsibleParty: 'owner', codeDigest: seeded.codeDigest,
    }, { expectedRevision: taskRevision })) as {
      item: { id: string; revision: number };
    };
    expect(query('SELECT manual_block FROM tasks WHERE id = ?', 't-1')).toMatchObject({ manual_block: 1 });

    const continuePayload = {
      taskId: 't-1', attemptId: seeded.attemptId, verificationBatchId: seeded.batchId,
      codeDigest: seeded.codeDigest, observationDigest: seeded.observationDigest,
    };
    const blockedContinue = completedResult(await submit('task.verification.continue', continuePayload,
      { expectedRevision: (query('SELECT revision FROM tasks WHERE id = ?', 't-1') as { revision: number }).revision }));
    expect(blockedContinue).toMatchObject({ disposition: 'replayed', waitingFor: 'approval' });
    expect(taskRow('t-1')).toMatchObject({ status: 'running' });

    /* 解除阻塞：只持久化决定，不启动编码（Runtime/Attempt 计数不变）。 */
    const unblocked = completedResult(await submit('task.approval.unblock', {
      taskId: 't-1', itemId: blocked.item.id, planDigest: seeded.planDigest,
      codeDigest: seeded.codeDigest, artifactRefs: [], reason: '复核解除',
    }, { expectedRevision: blocked.item.revision }));
    expect(unblocked).toMatchObject({ decision: 'unblock' });
    expect(query('SELECT manual_block FROM tasks WHERE id = ?', 't-1')).toMatchObject({ manual_block: 0 });
    expect(runtimeStarts()).toBe(startsAfterRun);
    expect(attemptCount('t-1')).toBe(attemptsAfterRun);

    /* 显式继续复用有效证据：零新增编码调用，完成放行。 */
    const continueCommandId = randomUUID();
    const continueEnvelope = {
      schemaVersion: 5, commandId: continueCommandId, issuedAt: new Date(BINDING_NOW).toISOString(),
      operation: 'task.verification.continue', scope: { kind: 'project', projectId: fixture!.projectId },
      expectedRevision: (query('SELECT revision FROM tasks WHERE id = ?', 't-1') as { revision: number }).revision,
      payload: continuePayload,
    } as never;
    const continued = await core!.commandService.submit(owner, continueEnvelope);
    expect(completedResult(continued)).toMatchObject({
      disposition: 'applied', status: 'succeeded', runtimeCalled: false,
    });
    expect(runtimeStarts()).toBe(startsAfterRun);
    expect(attemptCount('t-1')).toBe(attemptsAfterRun);
    expect(taskRow('t-1')).toMatchObject({ status: 'passed', code_attempts_used: 1 });
    /* 等待人审期间不消耗代码返工额度；t-2 此时才解锁。 */
    const after = await core!.workExecution.scan();
    expect(after.runs).toMatchObject([{ claimed: true }]);
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    expect(query('SELECT task_id FROM attempts WHERE status = ?', 'verifying')).toMatchObject({ task_id: 't-2' });
    /* 同 commandId 重放继续：同一回执；不同 commandId 重复继续被状态栅栏拒绝。 */
    const continueReplay = await core!.commandService.submit(owner, continueEnvelope);
    expect((continueReplay as { replayed?: boolean }).replayed).toBe(true);
    await expect(core!.commandService.submit(owner, {
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(BINDING_NOW).toISOString(),
      operation: 'task.verification.continue', scope: { kind: 'project', projectId: fixture!.projectId },
      expectedRevision: (query('SELECT revision FROM tasks WHERE id = ?', 't-1') as { revision: number }).revision,
      payload: continuePayload,
    } as never)).rejects.toMatchObject({ code: 'conflict' });
  }, 60_000);
});

describe('F-016 预算与失败链集成（正式装配入口）', () => {
  it('三次含首次耗尽：Task failed、后继 blocked；重复/迟到结果不放行', async () => {
    await openCase();

    /* 第一、二次代码失败：Task 回 pending、同 worktree 返工认领。 */
    const first = await runAndSettle({ tests: 'code' }, 1);
    expect(first.completion.outcome).toBe('code_failure');
    expect(first.completion.receipt).toMatchObject({ disposition: 'applied' });
    expect(taskRow('t-1')).toMatchObject({ status: 'pending', code_attempts_used: 1 });
    const second = await runAndSettle({ tests: 'code' }, 2);
    expect(second.completion.receipt).toMatchObject({ disposition: 'applied' });
    expect(taskRow('t-1')).toMatchObject({ status: 'pending', code_attempts_used: 2 });
    expect(attemptCount('t-1')).toBe(2);
    expect(attemptCount('t-2')).toBe(0);

    /* 第三次有效代码失败：额度耗尽 → Task failed、Run 暂停、后继 blocked。 */
    const third = await runAndSettle({ tests: 'code' }, 3);
    expect(third.completion.outcome).toBe('code_failure');
    expect(third.completion.receipt).toMatchObject({ disposition: 'applied' });
    expect(taskRow('t-1')).toMatchObject({ status: 'failed', code_attempts_used: 3, attempt_counter: 3 });
    expect(query('SELECT status, reason FROM runs WHERE id = ?', fixture!.runId))
      .toEqual({ status: 'paused', reason: 'code_attempts_exhausted' });
    expect(attemptCount('t-2')).toBe(0);
    expect(attemptCount('t-1')).toBe(3);
    /* Runtime 启动次数与权威持久计数直接断言。 */
    expect(runtimeStarts()).toBe(3);
    expect((query('SELECT attempts_created, runtime_starts FROM execution_batches') as {
      attempts_created: number; runtime_starts: number }).attempts_created).toBe(3);
    /* 耗尽后调度不再认领。 */
    const exhaustedScan = await core!.workExecution.scan();
    expect(exhaustedScan.runs).toMatchObject([{ claimed: false }]);

    /* 重复结果：对已终态 Attempt 再提交同批次 → invalid_transition，状态不变。 */
    const duplicate = await core!.taskVerificationCompletion.complete({
      identity: { projectId: fixture!.projectId, attemptId: third.attempt.id, owner: third.attempt.owner_id,
        hostInstanceId: third.attempt.host_instance_id, executionVersion: third.attempt.execution_version },
      taskId: 't-1', runId: fixture!.runId, verificationBatchId: third.batchId,
      observation: failedObservation(third.policyDigest),
      failures: { tests: 'code' },
    });
    expect(duplicate.receipt).toMatchObject({ disposition: 'ignored', reason: 'invalid_transition' });
    /* 迟到结果：对更早的第二次 Attempt 提交 → 旧 fencing 身份拒绝，不放行不重算。 */
    const late = await core!.taskVerificationCompletion.complete({
      identity: { projectId: fixture!.projectId, attemptId: second.attempt.id, owner: second.attempt.owner_id,
        hostInstanceId: second.attempt.host_instance_id, executionVersion: second.attempt.execution_version },
      taskId: 't-1', runId: fixture!.runId, verificationBatchId: second.batchId,
      observation: failedObservation(second.policyDigest),
      failures: { tests: 'code' },
    });
    expect(late.receipt).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
    expect(taskRow('t-1')).toMatchObject({ status: 'failed', code_attempts_used: 3 });
    expect(attemptCount('t-2')).toBe(0);

    /* 新 Run 尝试：失败链未决时旧 Run 仍为活动状态，控制层拒绝同 Feature
     * 再派发（execution_in_progress）—— 不提供经新 Run 绕过暂停、重置
     * Task 累计计数的入口；计数保持不变。 */
    const batchId = (query('SELECT id FROM execution_batches') as { id: string }).id;
    await expect(submit('execution.start', { featureIds: [fixture!.featureId], retryBatchId: batchId }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'execution_in_progress' } });
    expect(taskRow('t-1')).toMatchObject({ status: 'failed', code_attempts_used: 3, attempt_counter: 3 });
    expect(runtimeStarts()).toBe(3);
    expect(attemptCount('t-1')).toBe(3);
    expect(attemptCount('t-2')).toBe(0);

    /* 数据库重开：持久计数与失败链仍为权威状态；重开后调度仍不认领。 */
    const closed = await core!.workExecution.close();
    expect(closed).toMatchObject({ closed: true, pendingAttemptIds: [] });
    core!.close();
    core = await openCore();
    expect(taskRow('t-1')).toMatchObject({ status: 'failed', code_attempts_used: 3, attempt_counter: 3 });
    expect(runtimeStarts()).toBe(3);
    /* 暂停原因可能已被后续调度诊断覆写为 run_control_blocked（既有核心行为，
     * F-012/F-014 已记录）；权威事实是 Run 保持非终态暂停且不再认领。 */
    const runAfterReopen = query('SELECT status, reason FROM runs WHERE id = ?', fixture!.runId) as {
      status: string; reason: string | null;
    };
    expect(runAfterReopen.status).toBe('paused');
    expect(['code_attempts_exhausted', 'run_control_blocked']).toContain(runAfterReopen.reason);
    const reopenedScan = await core!.workExecution.scan();
    expect(reopenedScan.runs).toMatchObject([{ claimed: false }]);
  }, 90_000);

  it('基础设施错误不误扣代码额度：独立暂停分支，不自动进入代码返工循环', async () => {
    await openCase();

    /* 超时类失败不是确定性代码失败：non_code_failure 分支。 */
    const settled = await runAndSettle({ tests: 'timeout' }, 1);
    expect(settled.completion.outcome).toBe('non_code_failure');
    expect(settled.completion.reason).toBe('failure_not_code');
    expect(settled.completion.receipt).toMatchObject({ disposition: 'applied', status: 'failed' });
    /* Task 回 pending，但 Run 暂停 infrastructure_error：不自动返工。 */
    expect(taskRow('t-1')).toMatchObject({ status: 'pending' });
    expect(query('SELECT status, reason FROM runs WHERE id = ?', fixture!.runId))
      .toEqual({ status: 'paused', reason: 'infrastructure_error' });
    /* 代码额度退回：不因基础设施错误消耗代码返工次数。 */
    expect(taskRow('t-1')).toMatchObject({ code_attempts_used: 0 });
    expect(attemptCount('t-1')).toBe(1);
    expect(runtimeStarts()).toBe(1);
    expect(attemptCount('t-2')).toBe(0);
    /* 调度不自动重跑（run_control_blocked）；旧执行停止未知不能返工的更细粒度
     * 隔离语义由 F-012 专项测试覆盖，此处断言控制门不发起返工。 */
    const scan = await core!.workExecution.scan();
    expect(scan.runs).toMatchObject([{ claimed: false }]);
    expect(attemptCount('t-1')).toBe(1);
  }, 60_000);
});
