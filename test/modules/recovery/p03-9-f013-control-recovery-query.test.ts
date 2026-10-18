/**
 * P03-9 / F-013：Run/Batch 控制进度、恢复诊断与 finalization 收尾结果查询
 *（真实 SQLite + 真实 Host 纵向，非 mock）。
 *
 * 验收面（.dag_context.json F-013）：
 * 1. Run/Batch 查询返回 pausing/cancelling/paused/interrupted 的实际状态与
 *    原因、关联 Attempt/operation、停止/隔离证据引用和可用的显式后续动作，
 *    不以日志推断完成；
 * 2. 恢复与 retryFinal 查询显示来源、请求/实际恢复模式、finalization scope、
 *    累计预算及 Task/最终检查/审批/提交分轴结果；
 * 3. 查询按既有项目授权、分页/扫描和输出上限执行，证据读取走既有受控路径
 *    与脱敏 Artifact 通道；跨项目和无权限读取被拒绝；
 * 4. 映射测试验证未知用量/退出信息保持 unknown/null/缺失而非 0，历史
 *    Attempt/Run 可追溯，重复查询不产生执行、计数或副作用。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../../../packages/host/src/index.ts';
import { APP_OPERATIONS } from '../../../packages/host/src/contract/errors.ts';
import { APPLICATION_QUERY_CAPABILITIES } from '../../../packages/host/src/contract/lifecycle.ts';
import { EXECUTION_CONTROL_QUERY_OPERATIONS } from '../../../packages/core/src/protocol.ts';
import { createQueryService } from '../../../packages/core/src/application/query-service.ts';
import type { QueryService } from '../../../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../../../packages/core/src/ports/path-service.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { PublicError } from '../../../packages/core/src/ports/commands.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
} from '../../helpers/p02-2/principals.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

const HASH = 'ab'.repeat(32);
const owner = createLocalOwnerPrincipal();

type Fixture = Awaited<ReturnType<typeof openClaimFixture>>;

const fixtures: Fixture[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const fixture of fixtures.splice(0)) fixture.box.close();
});

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
    executionControlReads: queryStore,
    artifacts: createSqliteArtifactStore(session),
    artifactFiles: createArtifactFileStore({ dataRoot }),
    dataRootIdentity: computeDataRootIdentity(dataRoot),
    nowUtcMs: () => NOW,
  });
}

function completedResult(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || !('result' in receipt)) {
    throw new Error(`Expected a completed receipt, got ${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, unknown>;
}

/** control 信封（与 f001 pause 同一命令面形态）。 */
function controlEnvelope(
  f: Fixture,
  operation: 'execution.pause' | 'execution.resume',
  payload: Record<string, unknown>,
  expectedRevision: number,
) {
  return {
    schemaVersion: 5 as const,
    commandId: randomUUID(),
    issuedAt: new Date(NOW).toISOString(),
    operation,
    scope: f.box.scope,
    expectedRevision,
    payload,
  };
}

const readRunRevision = (f: Fixture) =>
  (f.box.session.database.prepare('SELECT revision FROM runs WHERE id = ?').get(f.ids.runId) as { revision: number }).revision;

const readBatchStatus = (f: Fixture, batchId: string) =>
  (f.box.session.database.prepare('SELECT status FROM execution_batches WHERE id = ?').get(batchId) as { status: string }).status;

/** 诊断引用必须指向真实 Artifact（attempts_diagnostic_fk）；先行发布受控行。 */
function publishDiagnosticArtifact(f: Fixture, artifactId: string) {
  f.box.session.database.prepare(
    `INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
      expected_hash, content_hash, size_bytes, storage_locator)
     VALUES (?, ?, ?, ?, 'execution-stop-diagnostic', 'ready', 'application/json', ?, ?, 2, 'diagnostics/x')`,
  ).run(artifactId, NOW, NOW, f.ids.projectId, HASH, HASH);
}

/** 事务原语：取消 Run（创建持久停止 operation，活动 Attempt 下进入 cancelling）。 */
function requestCancel(f: Fixture) {
  return f.box.services.atomic.transact('f013.request-cancel', transaction => transaction.requestExecutionCancel({
    projectId: f.ids.projectId,
    targetKind: 'run',
    targetId: f.ids.runId,
    expectedRevision: readRunRevision(f),
    commandId: randomUUID(),
  }));
}

/** 事务原语：停止未确认结算（uncertain + 停止证据 Artifact 引用）。 */
function settleStopUncertain(f: Fixture, stopOperationId: string) {
  return f.box.services.atomic.transact('f013.settle-stop', transaction => transaction.settleExecutionStop({
    projectId: f.ids.projectId,
    stopOperationId,
    status: 'uncertain',
    evidenceRef: 'stop-evidence-artifact',
    stopConfirmed: false,
    forced: null,
    checkedAtUtcMs: NOW,
  }));
}

/** 事务原语：停止未确认时把活动 Attempt 标记 interrupted（诊断引用）。 */
function interruptAttempt(f: Fixture, attemptId: string, diagnosticRef: string) {
  return f.box.services.atomic.transact('f013.interrupt-attempt', transaction => transaction.interruptAttemptForStop({
    projectId: f.ids.projectId,
    attemptId,
    diagnosticRef,
    timestamp: NOW,
  }));
}

/** 事务原语：把 Attempt 租约隔离（quarantined）。 */
function quarantineLease(f: Fixture, attemptId: string, owner_: string, executionVersion: number) {
  f.box.session.transactWrite('f013.quarantine', () => {
    createSqliteWorkResourceAccess(f.box.session, {
      workspaceAuthority: f.authority,
      nowUtcMs: () => NOW,
    }).quarantineInTransaction({
      projectId: f.ids.projectId,
      attemptId,
      owner: owner_,
      hostInstanceId: 'host-1',
      executionVersion,
    });
  });
}

const controlSnapshot = (f: Fixture) => Object.fromEntries([
  'runs', 'execution_batches', 'attempts', 'workspace_leases', 'execution_stop_operations',
  'state_events', 'command_receipts', 'task_attempt_reservations',
].map(table => [table, f.box.session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));

describe('P03-9 / F-013 Run 控制进度查询', () => {
  it('paused Run：持久状态与暂停意图可见，无占用时显式 resume 动作可用', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const receipt = await f.box.services.commands.submit(
      owner,
      controlEnvelope(f, 'execution.pause', { runId: f.ids.runId, batchId: null }, readRunRevision(f)),
    );
    expect(receipt.status).toBe('completed');
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    const result = await queries.getRunControl(owner, { projectId: f.ids.projectId, runId: f.ids.runId });
    expect(result.scope).toBe('run-control');
    expect(result.run).toMatchObject({
      runId: f.ids.runId,
      batchId: f.ids.batchId,
      status: 'paused',
      reason: 'user_pause',
    });
    expect(result.run.pauseRequestedAt).not.toBeNull();
    expect(result.batch).toMatchObject({ batchId: f.ids.batchId, status: readBatchStatus(f, f.ids.batchId) });
    expect(result.attempts).toEqual({ records: [], truncated: false });
    expect(result.stopOperations).toEqual([]);
    expect(result.leases).toEqual([]);
    expect(result.nextActions).toEqual(['resume']);
    // 查询不内联快照正文或绝对路径（脱敏 Artifact 通道之外的正文不出现）。
    expect(JSON.stringify(result)).not.toContain('/tmp');
  });

  it('pausing Run（活动 Attempt）：等待收尾动作明确，未知用量/退出保持 null 不为 0', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const claim = f.store().claimTask(f.input(0));
    const attempt = claim.receipt.attempt;
    const receipt = await f.box.services.commands.submit(
      owner,
      controlEnvelope(f, 'execution.pause', { runId: f.ids.runId, batchId: null }, readRunRevision(f)),
    );
    expect(receipt.status).toBe('completed');
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    const result = await queries.getRunControl(owner, { projectId: f.ids.projectId, runId: f.ids.runId });
    expect(result.run.status).toBe('pausing');
    expect(result.attempts.records).toHaveLength(1);
    expect(result.attempts.records[0]).toMatchObject({
      attemptId: attempt.id,
      taskId: 't-1',
      status: 'preparing',
      executionStage: 'preflight',
    });
    // 未知即 null：未启动、未结束、无耗时、无退出码、无用量。
    expect(result.attempts.records[0]!.startedAt).toBeNull();
    expect(result.attempts.records[0]!.endedAt).toBeNull();
    expect(result.attempts.records[0]!.durationMs).toBeNull();
    expect(result.attempts.records[0]!.exitCode).toBeNull();
    expect(result.attempts.records[0]!.usage).toBeNull();
    expect(result.attempts.records[0]!.diagnosticRef).toBeNull();
    expect(result.nextActions).toEqual(['await_attempt_settlement']);
    expect(result.leases.length).toBeGreaterThan(0);
    expect(result.leases).toEqual(
      expect.arrayContaining([expect.objectContaining({ attemptId: attempt.id, state: 'held' })]),
    );
  });

  it('cancelling Run + uncertain 停止：证据引用、隔离租约与 stop_reconcile 动作', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const attempt = f.store().claimTask(f.input(0)).receipt.attempt;
    publishDiagnosticArtifact(f, 'interrupt-diagnostic-artifact');
    const cancel = requestCancel(f);
    expect(cancel.outcome).toBe('cancelling');
    expect(cancel.stopOperationId).not.toBeNull();
    expect(interruptAttempt(f, attempt.id, 'interrupt-diagnostic-artifact')).toBe(true);
    quarantineLease(f, attempt.id, attempt.owner, attempt.executionVersion);
    const settled = settleStopUncertain(f, cancel.stopOperationId!);
    expect(settled.status).toBe('uncertain');

    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    const result = await queries.getRunControl(owner, { projectId: f.ids.projectId, runId: f.ids.runId });
    expect(result.run.status).toBe('cancelling');
    expect(result.attempts.records[0]).toMatchObject({
      attemptId: attempt.id,
      status: 'interrupted',
      diagnosticRef: 'interrupt-diagnostic-artifact',
    });
    expect(result.stopOperations).toHaveLength(1);
    expect(result.stopOperations[0]).toMatchObject({
      operationId: cancel.stopOperationId,
      targetKind: 'run',
      targetId: f.ids.runId,
      status: 'uncertain',
      stopConfirmed: false,
      // 无法判定强制升级：保持 null，不以 false 冒充。
      forced: null,
      evidenceRef: 'stop-evidence-artifact',
    });
    // uncertain 不是终态结算：无 settledAt，但有核验时刻（checkedAt）。
    expect(result.stopOperations[0]!.settledAt).toBeNull();
    expect(result.stopOperations[0]!.checkedAt).not.toBeNull();
    expect(result.leases.length).toBeGreaterThan(0);
    expect(result.leases).toEqual(
      expect.arrayContaining([expect.objectContaining({ attemptId: attempt.id, state: 'quarantined' })]),
    );
    expect(result.nextActions).toEqual(['await_stop_settlement', 'stop_reconcile']);
    // 停止/隔离证据只暴露受控 Artifact 引用，不内联正文或路径。
    expect(JSON.stringify(result)).not.toContain('exitCode":0');
  });

  it('Batch 控制查询：子 Run/Attempt 简报、累计计数与显式后续动作', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    await f.box.services.commands.submit(
      owner,
      controlEnvelope(f, 'execution.pause', { runId: f.ids.runId, batchId: null }, readRunRevision(f)),
    );
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    const result = await queries.getBatchControl(owner, { projectId: f.ids.projectId, batchId: f.ids.batchId });
    expect(result.scope).toBe('batch-control');
    expect(result.batch).toMatchObject({
      batchId: f.ids.batchId,
      status: readBatchStatus(f, f.ids.batchId),
      counters: { runsCreated: 1, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
    });
    expect(result.runs.records).toHaveLength(1);
    expect(result.runs.records[0]).toMatchObject({ runId: f.ids.runId, status: 'paused', reason: 'user_pause' });
    expect(result.attempts.records).toEqual([]);
    expect(result.nextActions).toEqual(['resume']);
  });
});

describe('P03-9 / F-013 恢复与 retryFinal 诊断查询', () => {
  /**
   * 在真实迁移库上插入 finalization-only 失败终态 Run（受控 SQL 构造；runs
   * 的 input_snapshot 不可变列只能随 INSERT 写入，不触碰既有 Run）。
   */
  function seedFinalizationRun(f: Fixture, scope: Record<string, unknown>): string {
    const runId = 'run-finalization-only';
    const input = JSON.stringify({
      schemaVersion: 1,
      previewDigest: HASH,
      workKey: 'work-key-finalization',
      planDigest: HASH,
      pendingTaskIds: [],
      inputs: [],
      workspaceBaseline: null,
      finalization: scope,
    });
    f.box.session.database.prepare(
      `INSERT INTO runs (id, created_at, updated_at, project_id, batch_id, feature_id, purpose, input_snapshot,
        config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run,
        run_time_limit_ms, attempts_created, reason, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, 'execute', ?, '{}', 'failed', ?, 'work-key-finalization', 2, 2, ?, 0,
        'finalization_commit_failed', ?, ?)`,
    ).run(runId, NOW, NOW, f.ids.projectId, f.ids.batchId, f.box.featureId, input, HASH,
      3_600_000, NOW, NOW + 5);
    return runId;
  }

  const finalizationScope = () => ({
    schemaVersion: 1,
    kind: 'finalization-only',
    retryPlanDigest: HASH,
    historicalRunId: 'historical-run-1',
    historicalBatchId: 'historical-batch-1',
    historicalRunStatus: 'failed',
    historicalRunDispatchOrdinal: 1,
    planDigest: HASH,
    checkPolicyDigest: HASH,
    headCommit: 'c'.repeat(40),
    codeDigest: HASH,
    workspaceId: 'ws-final',
    workspaceRevision: 3,
    retainedTaskIds: ['t-1'],
    revalidateTasks: [],
    finalVerification: { required: false, checkKeys: [] },
    approval: { required: true, valid: false, approvalItemId: null, reason: 'approval_pending' },
    commit: { required: true, reconcileRequired: false, deliveryStatus: 'failed', operationId: null, reason: 'hook rejected' },
    missingSteps: ['commit'],
    codingTaskIds: [],
    runtimeStarts: 0,
    newAttempts: 0,
  });

  it('finalization-only Run：来源、缺失步骤、零编码承诺、累计预算与分轴事实', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const finalRunId = seedFinalizationRun(f, finalizationScope());
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    const result = await queries.getRunRecovery(owner, { projectId: f.ids.projectId, runId: finalRunId });
    expect(result.scope).toBe('run-recovery');
    expect(result.run).toMatchObject({
      runId: finalRunId,
      batchId: f.ids.batchId,
      workKey: 'work-key-finalization',
      dispatchOrdinal: 2,
      status: 'failed',
      reason: 'finalization_commit_failed',
      startedAt: new Date(NOW).toISOString(),
      endedAt: new Date(NOW + 5).toISOString(),
    });
    expect(result.finalization.present).toBe(true);
    expect(result.finalization.scope).toMatchObject({
      kind: 'finalization-only',
      historicalRunId: 'historical-run-1',
      historicalBatchId: 'historical-batch-1',
      missingSteps: ['commit'],
      codingTaskIds: [],
      runtimeStarts: 0,
      newAttempts: 0,
      approval: { required: true, valid: false },
      commit: { deliveryStatus: 'failed' },
    });
    // 分轴结果复用 P03-8 F-010 公共形状：Task/最终检查/审批/提交四轴。
    expect(result.finalization.axes).toMatchObject({
      tasks: { total: 1 },
      verification: { status: expect.any(String) },
      approval: { status: expect.any(String) },
      delivery: { status: expect.any(String) },
    });
    // 累计预算来自父 Batch 持久事实；用量未知恒 null，不以 0 冒充。
    expect(result.budget).toMatchObject({
      batchId: f.ids.batchId,
      budgetRevision: 1,
      counters: { runsCreated: 1, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
      usage: { tokenUsed: null, costUsed: null },
    });
    expect(result.budget.limits).toMatchObject({ schemaVersion: 1 });
    expect(result.recovery.records).toEqual([]);
    expect(result.recovery.attemptsScanned).toBe(0);
  });

  it('普通 Work Run：finalization 不冒充存在；请求/实际恢复模式按 F-007 记录展示', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    // 历史 Attempt（number 1，interrupted，无 recovery）+ 续接 Attempt（number 2，new 模式）。
    const historyInput = f.input(0);
    const first = f.store().claimTask(historyInput).receipt.attempt;
    // 历史 Attempt 先进入非活动状态（同 Task 活动 Attempt 唯一索引）。
    f.box.session.database.prepare(
      "UPDATE attempts SET status = 'interrupted', ended_at = ? WHERE id = ?",
    ).run(NOW + 1, first.id);
    const continuationSnapshot = {
      ...JSON.parse(JSON.stringify(historyInput.inputSnapshot)) as Record<string, unknown>,
      schemaVersion: 3,
      recovery: {
        schemaVersion: 1,
        kind: 'work-recovery-continuation',
        projectId: f.ids.projectId,
        featureId: f.box.featureId,
        taskId: 't-1',
        nextAttemptId: 'attempt-continuation',
        sourceAttemptId: null,
        sourceSessionId: null,
        selection: { mode: 'new' },
        decision: { mode: 'new', reasons: ['previous_native_archive_unusable'] },
        source: null,
        policy: {
          executionConfig: {},
          configSource: 'project_default',
          configSourceKey: null,
          permissionsDigest: HASH,
          checkPolicyDigest: HASH,
          taskRevision: 1,
        },
        workspace: {
          workspaceId: 'ws-recovery',
          repositoryIdentity: 'repo-identity',
          branch: 'main',
          headCommit: 'b'.repeat(40),
          codeDigest: HASH,
        },
        reconciliationEvidence: null,
        requiredInputs: [],
        handoff: null,
        recordedAtUtcMs: NOW,
      },
    };
    f.box.session.database.prepare(
      `INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
        number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
       VALUES (?, ?, ?, ?, ?, ?, 't-1', 2, 'owner-1', 'host-1', 1, ?, ?, ?, ?)`,
    ).run('attempt-continuation', NOW + 2, NOW + 2, f.ids.projectId, f.box.featureId, f.ids.runId,
      NOW + 2000, JSON.stringify(continuationSnapshot), HASH, 't-1-snapshot');

    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    const plain = await queries.getRunRecovery(owner, { projectId: f.ids.projectId, runId: f.ids.runId });
    expect(plain.finalization.present).toBe(false);
    expect(plain.finalization.scope).toBeNull();
    // 历史 Attempt 可追溯：两个 Attempt 都在续接扫描内，但只有带记录者进入 records。
    expect(plain.recovery.attemptsScanned).toBe(2);
    expect(plain.recovery.records).toHaveLength(1);
    expect(plain.recovery.records[0]).toMatchObject({
      attemptId: 'attempt-continuation',
      taskId: 't-1',
      attemptNumber: 2,
      sourceAttemptId: null,
      sourceSessionId: null,
      requested: { mode: 'new', kind: null, nativeArchiveRef: null },
      decided: { mode: 'new', reasons: ['previous_native_archive_unusable'] },
      handoff: null,
    });
    expect(plain.recovery.records[0]!.recordedAt).not.toBeNull();
    expect(first.id).not.toBe('attempt-continuation');
  });

  it('损坏 finalization scope fail-closed（corrupt_state），不折算普通 Run', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    seedFinalizationRun(f, { kind: 'finalization-only', unexpected: true });
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    await expect(
      queries.getRunRecovery(owner, { projectId: f.ids.projectId, runId: 'run-finalization-only' }),
    ).rejects.toMatchObject({ code: 'corrupt_state' });
  });
});

describe('P03-9 / F-013 授权、脱敏与副作用', () => {
  it('无权限 forbidden；未知/跨项目目标统一 not_found 不泄漏存在性', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    const restricted = createRestrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: { kind: 'allowlist', projectIds: ['00000000-0000-4000-8000-000000000000'] },
    });
    await expect(
      queries.getRunControl(restricted, { projectId: f.ids.projectId, runId: f.ids.runId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      queries.getBatchControl(restricted, { projectId: f.ids.projectId, batchId: f.ids.batchId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      queries.getRunRecovery(restricted, { projectId: f.ids.projectId, runId: f.ids.runId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      queries.getRunControl(owner, { projectId: f.ids.projectId, runId: 'missing-run' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      queries.getBatchControl(owner, { projectId: f.ids.projectId, batchId: 'missing-batch' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      queries.getRunRecovery(owner, { projectId: f.ids.projectId, runId: 'missing-run' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // 同库第二项目：跨项目目标折叠为 not_found（不区分存在性）。
    const registered = completedResult(await f.box.services.commands.submit(owner, {
      schemaVersion: 5 as const,
      commandId: randomUUID(),
      issuedAt: new Date(NOW).toISOString(),
      operation: 'project.register',
      scope: { kind: 'registration' },
      payload: { repositoryPath: f.box.box.repoDirB, displayName: 'Other project', description: null, labels: [] },
    }));
    const otherProjectId = (registered as { project: { id: string } }).project.id;
    await expect(
      queries.getRunControl(owner, { projectId: otherProjectId, runId: f.ids.runId }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // 非法身份在任何读取之前 invalid_input。
    await expect(
      queries.getRunControl(owner, { projectId: f.ids.projectId, runId: '../escape' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('重复查询零副作用：执行/计数/事件/回执快照逐字节一致', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const attempt = f.store().claimTask(f.input(0)).receipt.attempt;
    publishDiagnosticArtifact(f, 'interrupt-diagnostic-artifact');
    requestCancel(f);
    interruptAttempt(f, attempt.id, 'interrupt-diagnostic-artifact');
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    await queries.getRunControl(owner, { projectId: f.ids.projectId, runId: f.ids.runId });
    await queries.getBatchControl(owner, { projectId: f.ids.projectId, batchId: f.ids.batchId });
    await queries.getRunRecovery(owner, { projectId: f.ids.projectId, runId: f.ids.runId });
    const before = controlSnapshot(f);
    await queries.getRunControl(owner, { projectId: f.ids.projectId, runId: f.ids.runId });
    await queries.getRunRecovery(owner, { projectId: f.ids.projectId, runId: f.ids.runId });
    expect(controlSnapshot(f)).toEqual(before);
  });
});

describe('P03-9 / F-013 Host 查询接线（真实 Host 纵向）', () => {
  it('操作清单与能力宣告同步；GET 路由分发与错误协议稳定', async () => {
    for (const operation of EXECUTION_CONTROL_QUERY_OPERATIONS) {
      expect(APP_OPERATIONS).toContain(operation);
      expect(APPLICATION_QUERY_CAPABILITIES).toContain(operation);
    }
    expect(new Set(APP_OPERATIONS).size).toBe(APP_OPERATIONS.length);

    const f = await openClaimFixture();
    fixtures.push(f);
    await f.box.services.commands.submit(
      owner,
      controlEnvelope(f, 'execution.pause', { runId: f.ids.runId, batchId: null }, readRunRevision(f)),
    );
    const host = await startHost({
      dataRoot: f.box.box.dataRoot,
      capabilityCatalog: f.box.box.capabilityCatalog,
      env: {},
    });
    hosts.push(host);
    const token = readFileSync(join(f.box.box.dataRoot, 'host', 'auth.token'), 'utf8');
    const base = `/v1/runs/${encodeURIComponent(f.ids.runId)}/control?projectId=${encodeURIComponent(f.ids.projectId)}`;
    // 未认证 401；未知查询参数 400。
    expect((await loopbackRequest({ port: host.port, method: 'GET', path: base })).statusCode).toBe(401);
    expect(
      (
        await loopbackRequest({
          port: host.port,
          method: 'GET',
          path: `${base}&bogus=1`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(400);
    const authorized = await loopbackRequest({
      port: host.port,
      method: 'GET',
      path: base,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.statusCode).toBe(200);
    const body = JSON.parse(authorized.bodyText) as { scope: string; run: { status: string; reason: string }; nextActions: string[] };
    expect(body).toMatchObject({ scope: 'run-control', run: { status: 'paused', reason: 'user_pause' }, nextActions: ['resume'] });
    // Batch control 路由同一形态。
    const batchResponse = await loopbackRequest({
      port: host.port,
      method: 'GET',
      path: `/v1/batches/${encodeURIComponent(f.ids.batchId)}/control?projectId=${encodeURIComponent(f.ids.projectId)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(batchResponse.statusCode).toBe(200);
    expect((JSON.parse(batchResponse.bodyText) as { scope: string }).scope).toBe('batch-control');
    // 跨项目/不存在统一 not_found。
    const missing = await loopbackRequest({
      port: host.port,
      method: 'GET',
      path: `/v1/runs/missing-run/control?projectId=${encodeURIComponent(f.ids.projectId)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
    expect((JSON.parse(missing.bodyText) as { code?: string }).code ?? 'not_found').toBe('not_found');
    // 未匹配形态 404 unknown_operation。
    const unknown = await loopbackRequest({
      port: host.port,
      method: 'GET',
      path: `/v1/runs/${encodeURIComponent(f.ids.runId)}/unknown-sub`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unknown.statusCode).toBe(404);
  }, 60_000);
});

describe('P03-9 / F-013 映射纪律', () => {
  it('PublicError 形状稳定：错误不回显路径或实体正文', async () => {
    const f = await openClaimFixture();
    fixtures.push(f);
    const queries = assembleQueries(f.box.session, f.box.box.dataRoot);
    try {
      await queries.getRunControl(owner, { projectId: f.ids.projectId, runId: 'missing-run' });
      throw new Error('预期 not_found');
    } catch (error) {
      expect(error).toBeInstanceOf(PublicError);
      const publicError = error as PublicError;
      expect(publicError.code).toBe('not_found');
      expect(JSON.stringify(publicError.details)).not.toContain('/');
    }
  });
});
