import { randomUUID } from 'node:crypto';
import { expect, test, afterEach } from 'vitest';
import { createQueryService } from '../../../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../../../packages/core/src/ports/path-service.ts';
import {
  deriveResultPendingActions,
  deriveResultBlockReasons,
} from '../../../packages/core/src/ports/result-diagnostics-query.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import {
  reportAttempt,
  reportArtifact,
  reportDatabaseSnapshot,
  reportOperation,
  reportSecondRun,
  reportSettlement,
  reportVerification,
  HASH,
} from '../../helpers/p03-10/report-fixture.ts';
import { openBudgetFixture, BUDGET, NOW, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

const fixtures: BudgetFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

function queries(f: BudgetFixture) {
  const store = createSqliteQueryStore(f.session);
  const stateStore = createSqliteStateStore(f.session);
  return createQueryService({
    projectReads: store, snapshots: store, eventReads: store, stateStore,
    configurationService: createConfigurationService({ stateStore, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) }),
    planReads: store, executionBudgetReads: store, scheduleReads: store, workspaceReads: store,
    workSessionReads: store, taskEvidenceReads: store, gitOperationReads: store,
    featureDeliveryReads: store, featureReportReads: store, executionControlReads: store,
    resultDiagnosticsReads: store,
    artifacts: createSqliteArtifactStore(f.session), artifactFiles: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
    dataRootIdentity: computeDataRootIdentity(f.box.dataRoot), nowUtcMs: () => NOW,
  });
}

/** 富场景：双 Run、返工 Attempt、人工阻塞、停止不确定、通知诊断、验证与 Git 引用。 */
async function richFixture() {
  const f = await openBudgetFixture(BUDGET, [1, 2, 3].map(n => ({
    id: `t-${n}`, title: `Task ${n}`, acceptance: { criteria: ['result diagnostics'] }, dependsOn: [],
  })));
  fixtures.push(f);
  const started = await f.start();
  const batchId = started.batchId;
  const run1 = started.runId!;
  const run2 = reportSecondRun(f, run1);
  const a1 = reportAttempt(f, { id: 'a-1', runId: run1, status: 'failed' });
  reportSettlement(f, a1);
  const a2 = reportAttempt(f, { id: 'a-2', runId: run2, number: 2, status: 'succeeded', previousAttemptId: a1.id });
  reportSettlement(f, a2, {
    identity: { projectId: f.projectId, attemptId: a2.id, taskId: 't-1', runId: run2, sessionId: a2.sessionId,
      executionVersion: 2, owner: 'owner-report', hostInstanceId: 'host-report' },
    execution: { result: { schemaVersion: 1, terminal: 'completed', reason: 'completed', exitCode: 0, signal: null, durationMs: 90,
      usage: { basis: 'reported', inputTokens: 30, outputTokens: 11, costUsdMicros: 5, coverage: 'reported', completeness: 'complete', accounting: 'incremental' }, lastEventSequence: 4 }, failure: null },
    recording: { complete: true, manifestRef: 'manifest-a2', failure: null, gaps: [], watermark: 4 },
  });
  const interrupted = reportAttempt(f, { id: 'a-interrupted', taskId: 't-2', runId: run1, status: 'interrupted' });
  f.session.database.prepare(`UPDATE attempts SET usage_summary = ? WHERE id = ?`)
    .run(JSON.stringify({ schemaVersion: 1, inputTokens: 5, outputTokens: null, costMicros: null, currency: null }), interrupted.id);
  reportArtifact(f, 'code-a-2');
  f.session.database.prepare('UPDATE attempts SET code_ref = ? WHERE id = ?').run('code-a-2', a2.id);
  reportVerification(f, a1, 'verify-final', 'FeatureVerification.full', 'passed');
  reportOperation(f, run2);
  f.session.database.prepare(`INSERT INTO task_approval_items (id, created_at, updated_at, project_id, feature_id, task_id,
    kind, description, responsible_party, plan_digest, artifact_refs, status, created_by)
    VALUES ('block-1', ?, ?, ?, ?, 't-2', 'block', 'needs owner decision', 'owner', ?, '[]', 'pending', 'owner')`)
    .run(NOW, NOW, f.projectId, f.featureId, HASH);
  f.session.database.prepare(`INSERT INTO execution_stop_operations (id, created_at, project_id, revision, updated_at,
    command_id, target_kind, target_id, batch_id, feature_id, run_id, reason, status, requested_at, settled_at,
    evidence_ref, stop_confirmed, forced, checked_at)
    VALUES ('stop-1', ?, ?, 1, ?, 'cmd-stop-1', 'run', ?, ?, NULL, ?, 'user_cancel', 'uncertain', ?, NULL, NULL, 0, NULL, NULL)`)
    .run(NOW, f.projectId, NOW, run1, batchId, run1, NOW);
  f.session.database.prepare(`INSERT INTO attempt_notification_diagnostics
    (id, project_id, attempt_id, notification_digest, reason, occurred_at)
    VALUES ('diag-1', ?, ?, ?, 'stale_execution_identity', ?)`)
    .run(f.projectId, a1.id, 'cd'.repeat(32), NOW);
  return { f, batchId, run1, run2, a1, a2, interrupted };
}

function bareQueuedRun(f: BudgetFixture, fromRunId: string, id: string): string {
  const db = f.session.database;
  const row = db.prepare<[string], Record<string, string | number | null>>('SELECT * FROM runs WHERE id = ?').get(fromRunId)!;
  const next = { ...row, id, dispatch_ordinal: Number(row.dispatch_ordinal) + 10, status: 'queued', started_at: null, ended_at: null, reason: null };
  db.prepare(`INSERT INTO runs (${Object.keys(next).join(',')}) VALUES (${Object.keys(next).map(() => '?').join(',')})`).run(...Object.values(next));
  return id;
}

test('[case:derive-actions] pending actions and block reasons derive deterministically from persisted facts', () => {
  expect(deriveResultPendingActions({
    attemptStatus: 'failed', executionState: 'failed', runStatus: 'failed', stopStatus: null,
    manualBlockPending: false, taskStatus: 'running', featureStatus: 'running', featureDeliveryStatus: 'not_requested',
  })).toEqual(['rework_task', 'restart_run']);
  expect(deriveResultPendingActions({
    attemptStatus: 'interrupted', executionState: 'execution_uncertain', runStatus: 'running', stopStatus: 'uncertain',
    manualBlockPending: true, taskStatus: 'pending', featureStatus: 'running', featureDeliveryStatus: 'not_requested',
  })).toEqual(['review_manual_block', 'confirm_stop_uncertainty', 'rework_task']);
  // Runtime 完成、Task 未验收：不得互相冒充。
  expect(deriveResultPendingActions({
    attemptStatus: 'succeeded', executionState: 'succeeded', runStatus: 'succeeded', stopStatus: null,
    manualBlockPending: false, taskStatus: 'running', featureStatus: 'running', featureDeliveryStatus: 'not_requested',
  })).toEqual([]);
  // Task 通过、Feature 完成但交付未请求：交付轴动作独立呈现。
  expect(deriveResultPendingActions({
    attemptStatus: 'succeeded', executionState: 'succeeded', runStatus: 'succeeded', stopStatus: null,
    manualBlockPending: false, taskStatus: 'passed', featureStatus: 'completed', featureDeliveryStatus: 'not_requested',
  })).toEqual(['request_feature_delivery']);
  expect(deriveResultPendingActions({
    attemptStatus: 'succeeded', executionState: 'succeeded', runStatus: 'succeeded', stopStatus: null,
    manualBlockPending: false, taskStatus: 'passed', featureStatus: 'completed', featureDeliveryStatus: 'succeeded',
  })).toEqual([]);
  expect(deriveResultBlockReasons('scheduler_not_assembled',
    [{ operationId: 's', targetKind: 'run', targetId: 'r', status: 'stopping', reason: 'user_cancel', stopConfirmed: null, forced: null, evidenceRef: null, requestedAtUtcMs: NOW, settledAtUtcMs: null }],
    [{ id: 'd', projectId: 'p', attemptId: 'a', notificationDigest: 'cd'.repeat(32), reason: 'notification_id_reused', occurredAtUtcMs: NOW }],
    true)).toEqual(['manual_block_pending', 'notification:notification_id_reused', 'run:scheduler_not_assembled', 'stop:stopping']);
});

test('[case:locate-and-axes] batch/run/attempt/session selectors locate entries with separated completion axes', async () => {
  const { f, batchId, run1, run2, a1, a2, interrupted } = await richFixture();
  const q = queries(f);
  const before = reportDatabaseSnapshot(f);
  const batchPage = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, batchId });
  expect(batchPage.parent).toEqual({ kind: 'batch', batchId });
  expect(batchPage.parentFacts).toMatchObject({ kind: 'batch', batchId });
  expect(['queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted'])
    .toContain((batchPage.parentFacts as { batchStatus: string }).batchStatus);
  expect(batchPage.records.map(r => r.attemptId)).toEqual(['a-1', 'a-interrupted', 'a-2']);
  expect(batchPage.eventWatermark).toBeGreaterThan(0);

  const failed = batchPage.records.find(r => r.attemptId === a1.id)!;
  expect(failed.runtime).toMatchObject({ attemptStatus: 'failed', state: 'failed', resultKnown: true, exitCode: 1 });
  expect(failed.task).toMatchObject({ taskStatus: 'pending', manualBlockPending: false, verification: { batchId: 'verify-final', status: 'passed' } });
  expect(failed.feature).toEqual({ featureStatus: 'draft', deliveryStatus: 'not_requested' });
  expect(failed.pendingActions).toContain('rework_task');
  expect(failed.blockReasons).toEqual(['notification:stale_execution_identity', 'stop:uncertain']);
  expect(failed.usage).toMatchObject({ basis: 'synthetic', inputTokens: 23, outputTokens: null, coverage: 'unknown' });
  expect(failed.issues).toContain('usage_partial');
  expect(failed.recording).toMatchObject({ complete: false, gaps: ['historical_tail_missing'], watermark: 3 });
  expect(failed.issues).toContain('recording_partial');
  expect(failed.resultArtifactId).toBe(`${a1.id}-result`);
  expect(failed.gitOperationRefs).toEqual([]);

  const reworked = batchPage.records.find(r => r.attemptId === a2.id)!;
  expect(reworked.rework).toEqual({ previousAttemptId: a1.id });
  expect(reworked.codeRef).toBe('code-a-2');
  expect(reworked.diagnosticRef).toBeNull();
  expect(reworked.recording).toMatchObject({ complete: true, gaps: [], watermark: 4, manifestRef: 'manifest-a2' });
  expect(reworked.usage).toMatchObject({ basis: 'reported', inputTokens: 30, outputTokens: 11, costMicros: 5, coverage: 'reported' });
  expect(reworked.gitOperationRefs).toEqual([{ operationId: 'op-report', operationType: 'feature_final_commit', status: 'pending' }]);
  expect(reworked.checkRefs).toEqual([{ batchId: 'verify-final', operation: 'FeatureVerification.full', status: 'passed', endedAt: new Date(NOW + 20).toISOString() }]);
  // Runtime 成功但 Task 验收轴与 Feature 交付轴各自独立，不互相推导。
  expect(reworked.runtime.attemptStatus).toBe('succeeded');
  expect(reworked.task.taskStatus).toBe('pending');
  expect(reworked.feature.deliveryStatus).toBe('not_requested');
  expect(reworked.pendingActions).toEqual([]);

  const blocked = batchPage.records.find(r => r.attemptId === interrupted.id)!;
  expect(blocked.runtime.state).toBe('execution_uncertain');
  expect(blocked.task.manualBlockPending).toBe(true);
  expect(blocked.pendingActions).toEqual(['review_manual_block', 'confirm_stop_uncertainty', 'rework_task', 'restart_run']);
  expect(blocked.blockReasons).toContain('manual_block_pending');
  expect(blocked.blockReasons).toContain('stop:uncertain');
  expect(blocked.issues).toContain('runtime_result_unknown');

  const runPage = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run2 });
  expect(runPage.parentFacts).toMatchObject({ kind: 'run', runId: run2, batchId, runStatus: 'succeeded', runReason: null });
  expect(runPage.records.map(r => r.attemptId)).toEqual([a2.id]);

  const attemptPage = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: a1.id });
  expect(attemptPage.parentFacts).toMatchObject({ kind: 'attempt', attemptId: a1.id, runId: run1, batchId });
  expect(attemptPage.records.map(r => r.attemptId)).toEqual([a1.id]);

  const sessionPage = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, workSessionId: `${a2.id}-session` });
  expect(sessionPage.parentFacts).toMatchObject({ kind: 'session', sessionId: `${a2.id}-session`, attemptId: a2.id, runId: run2, batchId });
  expect(sessionPage.records.map(r => r.attemptId)).toEqual([a2.id]);
  // 查询只读：业务行/预算/回执/事件在查询前后完全一致。
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:pagination-and-cursors] stable keyset pages cover all rows exactly once and reject cross-scope cursors', async () => {
  const { f, run1 } = await richFixture();
  for (let n = 1; n <= 4; n++) {
    reportAttempt(f, { id: `p-00${n}`, taskId: 't-3', runId: run1, number: n, status: 'cancelled', session: false });
  }
  const q = queries(f);
  const before = reportDatabaseSnapshot(f);
  const collected: string[] = [];
  let cursor: string | null = null;
  const expected = ['a-1', 'a-interrupted', 'p-001', 'p-002', 'p-003', 'p-004'];
  for (let page = 0; page < 4; page++) {
    const result = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run1, limit: 2, ...(cursor === null ? {} : { cursor }) });
    expect(result.limit).toBe(2);
    collected.push(...result.records.map(r => r.attemptId));
    cursor = result.nextCursor;
    if (cursor === null) break;
  }
  expect(collected).toEqual(expected);
  expect(cursor).toBeNull();
  // 游标跨父级（Run→Batch）与跨范围（Run→其他选择器）一律 invalid_cursor。
  const first = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run1, limit: 2 });
  expect(first.nextCursor).not.toBeNull();
  const sameBatch = f.session.database.prepare<[string], { batch_id: string }>(
    'SELECT batch_id FROM runs WHERE project_id = ? LIMIT 1').get(f.projectId)!.batch_id;
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, batchId: sameBatch, limit: 2, cursor: first.nextCursor! }))
    .rejects.toMatchObject({ code: 'invalid_input', details: { field: 'cursor', reason: 'invalid_cursor' } });
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: 'a-1', cursor: first.nextCursor! }))
    .rejects.toMatchObject({ code: 'invalid_input', details: { field: 'cursor', reason: 'invalid_cursor' } });
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run1, cursor: 'plcur_v1_broken' }))
    .rejects.toMatchObject({ code: 'invalid_input', details: { field: 'cursor', reason: 'invalid_cursor' } });
  // 非法页长与默认页长。
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run1, limit: 0 })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run1, limit: 201 })).rejects.toMatchObject({ code: 'invalid_input' });
  const defaulted = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run1 });
  expect(defaulted.limit).toBe(50);
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:errors-and-authorization] authorization, entity folding and input validation use existing public rules', async () => {
  const { f, batchId, run1 } = await richFixture();
  const q = queries(f);
  const before = reportDatabaseSnapshot(f);
  const noRead = createRestrictedPrincipal({ capabilities: ['events.read'], projectScope: { kind: 'all' } });
  const hidden = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [randomUUID()] } });
  await expect(q.listResultDiagnostics(noRead, { projectId: f.projectId, batchId })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(q.listResultDiagnostics(hidden, { projectId: f.projectId, runId: run1 })).rejects.toMatchObject({ code: 'forbidden' });
  // 不存在/跨项目目标折叠 not_found（不区分存在性）。
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, batchId: 'no-such-batch' })).rejects.toMatchObject({ code: 'not_found', details: { reason: 'execution_entity_not_found' } });
  await expect(q.listResultDiagnostics(f.owner, { projectId: randomUUID(), runId: run1 })).rejects.toMatchObject({ code: 'not_found' });
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: 'no-such-attempt' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, workSessionId: 'no-such-session' })).rejects.toMatchObject({ code: 'not_found' });
  // 选择器：缺父级/多父级/非法身份均为 invalid_input。
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, batchId, runId: run1 })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, batchId: '../etc/passwd' })).rejects.toMatchObject({ code: 'invalid_input' });
  // 拒绝伪造主体或任意路径字段（未知键白名单拒绝）。
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, batchId, principalId: 'local-owner' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(q.listResultDiagnostics(f.owner, { projectId: f.projectId, batchId, path: '/etc/passwd' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});

test('[case:usage-and-readview] unknown tokens stay null with coverage marked and pages aggregate once', async () => {
  const { f, batchId, run1, a1, a2 } = await richFixture();
  const emptyRun = bareQueuedRun(f, run1, 'run-empty');
  const q = queries(f);
  const before = reportDatabaseSnapshot(f);
  const batchPage = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, batchId });
  // a-interrupted 只有 Attempt 汇总回退（部分覆盖）；a-1 输出未知 → 页级聚合保持 null 并标注覆盖。
  const interruptedUsage = batchPage.records.find(r => r.attemptId === 'a-interrupted')!.usage;
  expect(interruptedUsage).toMatchObject({ basis: 'synthetic', coverage: 'partial', inputTokens: 5, outputTokens: null });
  expect(batchPage.usage.coverage).toBe('unknown');
  expect(batchPage.usage.inputTokens).toBe(53);
  expect(batchPage.usage.outputTokens).toBeNull();
  expect(batchPage.usage.countedObservations).toBe(2);
  // 单 Attempt 范围：全部观察已知 → 汇总可计算且只计一次。
  const attemptPage = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, attemptId: a2.id });
  expect(attemptPage.usage).toMatchObject({ basis: 'reported', coverage: 'reported', accounting: 'incremental', countedObservations: 1, inputTokens: 30, outputTokens: 11, costMicros: 5 });
  // 空结果：存在但无 Attempt 的 Run 返回结构化空页。
  const empty = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: emptyRun });
  expect(empty.records).toEqual([]);
  expect(empty.nextCursor).toBeNull();
  expect(empty.usage).toMatchObject({ basis: 'none', coverage: 'unknown', countedObservations: 0 });
  expect(empty.eventWatermark).toBeGreaterThan(0);
  // 重开后同一查询结果一致（一致读视图，不依赖内存状态）。
  const firstRun = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run1, limit: 2 });
  expect(reportDatabaseSnapshot(f)).toEqual(before);
  f.reopen();
  const afterReopen = await queries(f).listResultDiagnostics(f.owner, { projectId: f.projectId, runId: run1, limit: 2 });
  expect(afterReopen).toEqual(firstRun);
  expect(batchPage.records.find(r => r.attemptId === a1.id)!.usage.inputTokens).toBe(23);
});

test('[case:undelivered] passed tasks with pending delivery stay distinguishable from runtime completion', async () => {
  const { f, batchId, a2 } = await richFixture();
  const db = f.session.database;
  db.prepare("UPDATE tasks SET status = 'passed' WHERE id = 't-1'").run();
  db.prepare("UPDATE tasks SET status = 'failed' WHERE id = 't-2'").run();
  db.prepare("UPDATE features SET status = 'completed' WHERE id = ?").run(f.featureId);
  const q = queries(f);
  const before = reportDatabaseSnapshot(f);
  const page = await q.listResultDiagnostics(f.owner, { projectId: f.projectId, batchId });
  const delivered = page.records.find(r => r.attemptId === a2.id)!;
  // Runtime 完成 + Task 验收通过，但 Feature 交付未请求：三轴各说各话。
  expect(delivered.runtime.attemptStatus).toBe('succeeded');
  expect(delivered.task).toMatchObject({ taskStatus: 'passed', verification: { status: 'passed' } });
  expect(delivered.feature).toMatchObject({ featureStatus: 'completed', deliveryStatus: 'not_requested' });
  expect(delivered.pendingActions).toEqual(['request_feature_delivery']);
  expect(reportDatabaseSnapshot(f)).toEqual(before);
});
