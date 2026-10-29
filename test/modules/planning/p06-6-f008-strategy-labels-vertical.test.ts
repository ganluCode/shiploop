/**
 * P06-6 / F-008：Core/Host/CLI 纵向集成回归与策略/标签边界证据。
 *
 * 验收面（真实临时项目 + 真实 SQLite + 真实 Batch/Run/Attempt 记录 + loopback
 * HostClient + runAppCli）：
 * - 完整纵向场景：创建未启动 Task → 预览并确认默认策略重应用 → 更新四层标签
 *   （phase/feature/task/run）→ 按任一/全部筛选、分页与去重计数统计；
 * - 不变量：策略重应用只改变选中未启动 Task 的策略副本与 revision；标签编辑只
 *   改变目标实体元数据（labels/revision/updated_at）；既有 Batch scope、Run/Attempt
 *   输入快照与执行范围保持原值（执行授权范围不被元数据更新改变）；
 * - 失败路径（每条核对持久状态与副作用）：确认前拒绝（confirmed≠true）、预览过期
 *   （摘要/配置 revision/Task revision 漂移）、活动 Attempt 与既有 Batch 快照保护、
 *   Run 标签更新、标签 CAS 冲突、跨项目访问与查询只读性；
 * - CLI 端到端：task strategy-preview/strategy-reapply、execution runs 与
 *   project labels --entity run 经真实 Host 闭环，输出不含本地路径。
 *
 * 不调用真实模型；不读真实凭据；不修改开发仓库或用户 HOME。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  connectToHost,
  isHostProtocolError,
  startHost,
  type HostClient,
  type RunningHost,
  type TaskStrategyReapplicationInput,
  type TaskStrategyReapplicationPreviewWire,
} from '../../../packages/host/src/index.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { openClaimFixture, type ClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';

const PROJECT_SETTINGS = {
  schemaVersion: 2,
  strategies: { modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } } },
} as const;

const TASK_COLUMNS = 'id, revision, status, execution_config, config_source, config_source_key';
const BATCH_COLUMNS = 'id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, '
  + 'runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at';
const RUN_COLUMNS = 'id, revision, status, labels, input_snapshot, config_snapshot, scope_digest, '
  + 'work_key, dispatch_ordinal, attempts_created, reason, started_at, ended_at';
const ATTEMPT_COLUMNS = 'id, status, execution_version, input_snapshot, input_digest, lease_until';

interface VerticalSetup {
  readonly fixture: ClaimFixture;
  readonly host: RunningHost;
  readonly client: HostClient;
  readonly token: string;
  readonly db: ClaimFixture['box']['session']['database'];
  readonly projectId: string;
  readonly phaseId: string;
  readonly freshFeatureId: string;
  readonly freshTaskLowId: string;
  readonly freshTaskDefaultId: string;
  readonly protectedRunningTaskId: string;
  readonly protectedPendingTaskId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly runRevision: number;
  readonly otherProjectId: string;
  readonly otherProjectTaskId: string;
}

let activeFixture: ClaimFixture | undefined;
let activeHost: RunningHost | undefined;
let activeClient: HostClient | undefined;

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 });
});

afterEach(async () => {
  if (activeClient !== undefined) {
    activeClient.close();
    activeClient = undefined;
  }
  const host = activeHost;
  activeHost = undefined;
  if (host !== undefined && activeFixture !== undefined) {
    // 夹具注入合成进程身份且从不启动进程：在生产停止门核验持久占用前显式退役
    // 其租约（与 p03-4-schedule-host-wiring 同一夹具纪律）。
    activeFixture.box.session.transactWrite('fixture.retireSyntheticOccupancy', () => {
      activeFixture!.box.session.database.prepare('DELETE FROM workspace_leases').run();
    });
    await host.close();
  }
  if (activeFixture !== undefined) {
    activeFixture.box.close();
    activeFixture = undefined;
  }
});

async function rejectionOf(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('应当以错误拒绝，实际成功返回');
}

function expectProtocolError(error: unknown, code: string): void {
  expect(error, `expected HostProtocolError, got ${String(error)}`).toBeDefined();
  expect(isHostProtocolError(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

async function completedFixtureCommand(
  fixture: ClaimFixture,
  operation: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const receipt = await fixture.box.submit(operation, payload, extra);
  if (receipt.status !== 'completed' || receipt.result === null) {
    throw new Error(`fixture ${operation} 失败: ${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, any>;
}

async function setupVertical(): Promise<VerticalSetup> {
  // 两个既有 Task：t-1（认领后 running + 活动 Attempt）、t-2（pending 但属于
  // 已授权 Batch 范围）。Batch/Run 由真实 execution.start 创建，输入快照真实发布。
  const fixture = await openClaimFixture([[], []]);
  activeFixture = fixture;
  try {
    const claimed = fixture.store().claimTask(fixture.input(0));
    expect(claimed.replayed).toBe(false);
    expect(claimed.receipt.attempt.status).not.toBe('succeeded');
    // 认领将 Run revision 推至 2；后续标签 CAS 以 Host 启动后的实际 revision 为准。
    expect((fixture.box.session.database
      .prepare('SELECT revision FROM runs WHERE id = ?')
      .get(fixture.ids.runId) as { revision: number }).revision).toBe(2);

    // 第二 Feature：未启动 Task（无 Batch/Run/Attempt 历史）→ 可重应用；
    // 在项目设置建立之前导入，使 low 复杂度 Task 与 modelMap.low 候选产生真实差异。
    const imported = await completedFixtureCommand(fixture, 'feature.plan.import', {
      phaseId: 'phase-1',
      plan: {
        schemaVersion: 1,
        feature: { title: 'F-008 fresh feature', description: null, labels: [], sourceRefs: [] },
        tasks: [
          { id: 'task-fresh-default', title: 'Fresh default', acceptance: { criteria: ['fresh'] } },
          { id: 'task-fresh-low', title: 'Fresh low', complexity: 'low', acceptance: { criteria: ['fresh'] } },
        ],
      },
    }, { scope: fixture.box.scope, expectedRevision: 1 });
    await completedFixtureCommand(fixture, 'settings.project.create', PROJECT_SETTINGS, { scope: fixture.box.scope });

    // 第二项目（跨项目访问边界）。
    const otherProjectId = (await completedFixtureCommand(fixture, 'project.register', {
      repositoryPath: fixture.box.box.repoDirB, displayName: 'F-008 other', description: null, labels: [],
    }, { scope: { kind: 'registration' } })).project.id as string;
    await completedFixtureCommand(fixture, 'phase.create', {
      id: 'phase-b', title: 'other', description: null, labels: [],
    }, { scope: { kind: 'project', projectId: otherProjectId } });
    await completedFixtureCommand(fixture, 'feature.plan.import', {
      phaseId: 'phase-b',
      plan: {
        schemaVersion: 1,
        feature: { title: 'Other feature', description: null, labels: [], sourceRefs: [] },
        tasks: [{ id: 'task-other-project', title: 'other', acceptance: { criteria: ['x'] } }],
      },
    }, { scope: { kind: 'project', projectId: otherProjectId }, expectedRevision: 1 });

    const host = await startHost({
      dataRoot: fixture.box.box.dataRoot,
      capabilityCatalog: fixture.box.box.capabilityCatalog,
      env: {},
    });
    activeHost = host;
    const client = await connectToHost({ canonicalRoot: fixture.box.box.dataRoot });
    activeClient = client;
    // Host 启动恢复可能推进执行事实；快照基准以 Host 启动后的实际行为准。
    const runRevisionAfterHostStart = (fixture.box.session.database
      .prepare('SELECT revision FROM runs WHERE id = ?')
      .get(fixture.ids.runId) as { revision: number }).revision;
    return {
      fixture, host, client,
      db: fixture.box.session.database,
      token: readFileSync(join(fixture.box.box.dataRoot, 'host', 'auth.token'), 'utf8'),
      projectId: fixture.box.projectId,
      phaseId: 'phase-1',
      freshFeatureId: imported.feature.id as string,
      freshTaskDefaultId: 'task-fresh-default',
      freshTaskLowId: 'task-fresh-low',
      protectedRunningTaskId: 't-1',
      protectedPendingTaskId: 't-2',
      batchId: fixture.ids.batchId,
      runId: fixture.ids.runId,
      runRevision: runRevisionAfterHostStart,
      otherProjectId,
      otherProjectTaskId: 'task-other-project',
    };
  } catch (error) {
    const host = activeHost;
    activeHost = undefined;
    if (host !== undefined) await host.close();
    fixture.box.close();
    throw error;
  }
}

function confirmationOf(preview: TaskStrategyReapplicationPreviewWire): TaskStrategyReapplicationInput {
  return {
    confirmed: true,
    projectId: preview.identity.projectId,
    previewDigest: preview.identity.candidateDigest,
    globalSettingsRevision: preview.identity.globalSettingsRevision,
    projectSettingsRevision: preview.identity.projectSettingsRevision,
    selectedTaskIds: preview.identity.selectedTaskIds,
    expectedTaskRevisions: preview.identity.taskRevisions.map(entry => ({ taskId: entry.taskId, revision: entry.revision! })),
  };
}

function taskRows(s: VerticalSetup): Record<string, unknown>[] {
  return s.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY id`).all() as Record<string, unknown>[];
}

function batchRows(s: VerticalSetup): Record<string, unknown>[] {
  return s.db.prepare(`SELECT ${BATCH_COLUMNS} FROM execution_batches ORDER BY id`).all() as Record<string, unknown>[];
}

function runRows(s: VerticalSetup): Record<string, unknown>[] {
  return s.db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY id`).all() as Record<string, unknown>[];
}

function attemptRows(s: VerticalSetup): Record<string, unknown>[] {
  return s.db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts ORDER BY id`).all() as Record<string, unknown>[];
}

function eventCount(s: VerticalSetup, eventType: string): number {
  return (s.db.prepare('SELECT COUNT(*) AS count FROM state_events WHERE event_type = ?')
    .get(eventType) as { count: number } | undefined)?.count ?? 0;
}

describe('P06-6 / F-008 策略与四层标签纵向集成（真实 Host + Batch/Run/Attempt）', () => {
  it('[case:reapply-vertical-invariants] 预览确认重应用只改选中 Task 策略副本，执行快照保持原值', async () => {
    const s = await setupVertical();
    const tasksBefore = taskRows(s);
    const batchBefore = batchRows(s);
    const runsBefore = runRows(s);
    const attemptsBefore = attemptRows(s);
    expect(eventCount(s, 'task.strategy.updated')).toBe(0);

    const preview = await s.client.previewTaskStrategyReapplication(s.projectId, [s.freshTaskDefaultId, s.freshTaskLowId]);
    expect(preview.status).toBe('ready');
    expect(preview.identity.selectedTaskIds).toEqual([s.freshTaskDefaultId, s.freshTaskLowId]);
    const lowItem = preview.items.find(item => item.taskId === s.freshTaskLowId);
    const defaultItem = preview.items.find(item => item.taskId === s.freshTaskDefaultId);
    expect(lowItem).toMatchObject({
      eligible: true,
      candidate: { configSource: 'project_default', configSourceKey: 'modelMap.low' },
      diff: { changed: true, fields: ['model'] },
    });
    expect(defaultItem).toMatchObject({ eligible: true, diff: { changed: false } });
    // 预览只读：任何持久状态未变。
    expect(taskRows(s)).toEqual(tasksBefore);

    const commandId = randomUUID();
    const input = { ...confirmationOf(preview), commandId };
    const first = await s.client.reapplyTaskStrategy(input);
    expect(first).toMatchObject({ status: 'completed', operation: 'task.strategy.reapply' });
    if (first.status !== 'completed') throw new Error('重应用未完成');
    expect(first.result).toMatchObject({
      updatedCount: 2,
      updatedTaskIds: [s.freshTaskDefaultId, s.freshTaskLowId],
    });

    // 选中 Task：只有策略副本、来源与 revision 变化，状态仍是 pending。
    const after = taskRows(s);
    const freshLow = after.find(row => row.id === s.freshTaskLowId) as Record<string, unknown>;
    const freshDefault = after.find(row => row.id === s.freshTaskDefaultId) as Record<string, unknown>;
    expect(freshLow.revision).toBe(2);
    expect(freshLow.status).toBe('pending');
    expect(JSON.parse(String(freshLow.execution_config))).toMatchObject({
      runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2',
    });
    expect(freshLow).toMatchObject({ config_source: 'project_default', config_source_key: 'modelMap.low' });
    expect(freshDefault.revision).toBe(2);
    expect(JSON.parse(String(freshDefault.execution_config))).toMatchObject({ model: 'claude-sonnet' });
    expect(freshDefault).toMatchObject({ config_source: 'global_default', config_source_key: 'defaultStrategy' });
    // 受保护 Task（活动 Attempt / 既有 Batch 范围）策略与 revision 原值。
    for (const protectedId of [s.protectedPendingTaskId, s.protectedRunningTaskId]) {
      expect(after.find(row => row.id === protectedId)).toEqual(tasksBefore.find(row => row.id === protectedId));
    }
    // Batch 范围快照与 Run/Attempt 输入快照保持原值（执行授权范围不被改变）。
    expect(batchRows(s)).toEqual(batchBefore);
    expect(runRows(s)).toEqual(runsBefore);
    expect(attemptRows(s)).toEqual(attemptsBefore);
    expect(eventCount(s, 'task.strategy.updated')).toBe(2);
    // 同一 commandId 重放：返回原回执，不重复写入。
    const replay = await s.client.reapplyTaskStrategy(input, { issuedAt: first.issuedAt });
    expect(replay).toMatchObject({ status: 'completed', replayed: true, commandId });
    expect(taskRows(s)).toEqual(after);
    expect(eventCount(s, 'task.strategy.updated')).toBe(2);
  });

  it('[case:four-layer-labels-queries] 四层标签更新与 any/all 筛选、分页、统计；标签只改目标元数据', async () => {
    const s = await setupVertical();
    const batchBefore = batchRows(s);
    const attemptsBefore = attemptRows(s);
    const tasksBefore = taskRows(s);
    const runsBefore = runRows(s);

    // 四层标签更新：phase/feature/task 走 HostClient 公共方法；run 走
    // plan.labels.update 命令（F-005 契约；expectedRevision 为目标自身 revision）。
    const phaseEdit = await s.client.updatePlanLabels({
      projectId: s.projectId, entityType: 'phase', id: s.phaseId, expectedRevision: 1, labels: [' Alpha ', 'alpha', 'beta'],
    });
    expect(phaseEdit).toMatchObject({ status: 'completed' });
    if (phaseEdit.status !== 'completed') throw new Error('Phase 标签编辑未完成');
    expect(phaseEdit.result).toMatchObject({ entityType: 'phase', id: s.phaseId, labels: ['alpha', 'beta'], revision: 2 });
    const featureEdit = await s.client.updatePlanLabels({
      projectId: s.projectId, entityType: 'feature', id: s.freshFeatureId, expectedRevision: 1, labels: ['alpha'],
    });
    expect(featureEdit).toMatchObject({ status: 'completed' });
    const taskEdit = await s.client.updatePlanLabels({
      projectId: s.projectId, entityType: 'task', id: s.freshTaskLowId, expectedRevision: 1, labels: ['beta'],
    });
    expect(taskEdit).toMatchObject({ status: 'completed' });
    const runEdit = await s.client.submitCommand({
      operation: 'plan.labels.update',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: s.runRevision,
      payload: { entityType: 'run', id: s.runId, labels: [' Active ', 'active'] },
    });
    expect(runEdit).toMatchObject({ status: 'completed', operation: 'plan.labels.update' });
    if (runEdit.status !== 'completed') throw new Error('Run 标签编辑未完成');
    expect(runEdit.result).toMatchObject({ entityType: 'run', id: s.runId, labels: ['active'], revision: s.runRevision + 1 });

    // 标签编辑只改变目标实体元数据：Batch 范围/配置快照、Attempt 快照原值。
    expect(batchRows(s)).toEqual(batchBefore);
    expect(attemptRows(s)).toEqual(attemptsBefore);
    // Run 除 labels/revision 外的执行事实（输入/配置快照、范围摘要、工作键）原值。
    const runAfter = runRows(s).find(row => row.id === s.runId) as Record<string, unknown>;
    const runBefore = runsBefore.find(row => row.id === s.runId) as Record<string, unknown>;
    expect({ ...runAfter, labels: undefined, revision: undefined, updated_at: undefined })
      .toEqual({ ...runBefore, labels: undefined, revision: undefined, updated_at: undefined });
    expect(JSON.parse(String(runAfter.labels))).toEqual(['active']);
    // 被编辑 Task 只有 revision/labels 变化，策略副本原值；其余 Task 行原值。
    const tasksAfterLabels = taskRows(s);
    const editedRow = tasksAfterLabels.find(row => row.id === s.freshTaskLowId) as Record<string, unknown>;
    expect(editedRow.revision).toBe(2);
    expect(editedRow.execution_config)
      .toBe((tasksBefore.find(row => row.id === s.freshTaskLowId) as Record<string, unknown>).execution_config);
    for (const untouched of [s.freshTaskDefaultId, s.protectedPendingTaskId, s.protectedRunningTaskId]) {
      expect(tasksAfterLabels.find(row => row.id === untouched))
        .toEqual(tasksBefore.find(row => row.id === untouched));
    }

    // any/all 筛选（四层）。
    expect((await s.client.listPhases(s.projectId, { labels: ['beta', 'alpha'], match: 'all' })).records.map(r => r.id))
      .toEqual([s.phaseId]);
    expect((await s.client.listPhases(s.projectId, { labels: ['missing'] })).records).toEqual([]);
    expect((await s.client.listFeatures(s.projectId, s.phaseId, { labels: ['alpha'], match: 'any' })).records.map(r => r.id))
      .toEqual([s.freshFeatureId]);
    expect((await s.client.listTasks(s.projectId, s.freshFeatureId, { labels: ['beta'] })).records.map(r => r.id))
      .toEqual([s.freshTaskLowId]);
    const anyRuns = await s.client.listRuns(s.projectId, { labels: ['active', 'missing'], match: 'any' });
    expect(anyRuns.records.map(r => r.id)).toEqual([s.runId]);
    expect(anyRuns.records[0]).toMatchObject({ labels: ['active'], revision: s.runRevision + 1, batchId: s.batchId });
    expect((await s.client.listRuns(s.projectId, { labels: ['active', 'missing'], match: 'all' })).records)
      .toEqual([]);

    // 分页：Task 两页续读；Run 精确边界不宣传空页。
    const taskPage1 = await s.client.listTasks(s.projectId, s.freshFeatureId, { limit: 1 });
    expect(taskPage1.records.map(r => r.id)).toEqual([s.freshTaskDefaultId]);
    expect(taskPage1.nextCursor).toBeTypeOf('string');
    const taskPage2 = await s.client.listTasks(s.projectId, s.freshFeatureId, { limit: 1, cursor: taskPage1.nextCursor as string });
    expect(taskPage2.records.map(r => r.id)).toEqual([s.freshTaskLowId]);
    expect(taskPage2.nextCursor).toBeNull();
    const runBoundary = await s.client.listRuns(s.projectId, { limit: 1 });
    expect(runBoundary.records.map(r => r.id)).toEqual([s.runId]);
    expect(runBoundary.nextCursor).toBeNull();

    // 去重计数统计（四层）与列表筛选语义一致。
    expect(await s.client.getLabelCounts({ entity: 'phase', projectId: s.projectId }))
      .toEqual({ entity: 'phase', labels: [{ label: 'alpha', count: 1 }, { label: 'beta', count: 1 }] });
    expect(await s.client.getLabelCounts({ entity: 'feature', projectId: s.projectId, phaseId: s.phaseId }))
      .toEqual({ entity: 'feature', labels: [{ label: 'alpha', count: 1 }] });
    expect(await s.client.getLabelCounts({ entity: 'task', projectId: s.projectId, featureId: s.freshFeatureId }))
      .toEqual({ entity: 'task', labels: [{ label: 'beta', count: 1 }] });
    expect(await s.client.getLabelCounts({ entity: 'run', projectId: s.projectId }))
      .toEqual({ entity: 'run', labels: [{ label: 'active', count: 1 }] });
    expect(await s.client.getLabelCounts({ entity: 'run', projectId: s.projectId, labels: ['missing'] }))
      .toEqual({ entity: 'run', labels: [] });

    // 查询只读：整组查询前后事件水位不变。
    const before = await s.client.getSnapshot({ kind: 'project', projectId: s.projectId });
    await s.client.listPhases(s.projectId, { labels: ['alpha'] });
    await s.client.listTasks(s.projectId, s.freshFeatureId, { labels: ['beta'], limit: 1 });
    await s.client.listRuns(s.projectId, { labels: ['active'] });
    await s.client.getLabelCounts({ entity: 'run', projectId: s.projectId });
    const after = await s.client.getSnapshot({ kind: 'project', projectId: s.projectId });
    expect(after.watermark).toEqual(before.watermark);
    // 脱敏：四层编辑回执不泄漏本地路径。
    for (const receipt of [phaseEdit, featureEdit, taskEdit, runEdit]) {
      expect(JSON.stringify(receipt)).not.toMatch(/\/Users\//);
    }
  });

  it('[case:strategy-rejection-boundaries] 确认前拒绝、预览过期与快照保护均零副作用', async () => {
    const s = await setupVertical();
    const preview = await s.client.previewTaskStrategyReapplication(s.projectId, [s.freshTaskLowId]);
    expect(preview.status).toBe('ready');
    const input = confirmationOf(preview);

    // 确认前拒绝：confirmed=false 经真实 loopback 在信封校验拒绝，Task 零写入。
    const tasksBefore = taskRows(s);
    expectProtocolError(await rejectionOf(() =>
      s.client.reapplyTaskStrategy({ ...input, confirmed: false } as never)), 'invalid_input');
    const missingConfirm = await loopbackRequest({
      port: s.host.port, method: 'POST', path: '/v1/commands', token: s.token,
      body: {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
        operation: 'task.strategy.reapply', scope: { kind: 'project', projectId: s.projectId },
        payload: { ...input, projectId: undefined, confirmed: undefined, commandId: undefined },
      },
    });
    expect(missingConfirm.statusCode).toBe(400);
    expect(taskRows(s)).toEqual(tasksBefore);
    expect(eventCount(s, 'task.strategy.updated')).toBe(0);

    // 预览过期（摘要不匹配）：rejected conflict，零写入。
    const staleDigest = await s.client.reapplyTaskStrategy({ ...input, previewDigest: 'a'.repeat(64) });
    expect(staleDigest).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'preview_stale' } } });
    expect(taskRows(s)).toEqual(tasksBefore);

    // 预览过期（配置 revision 漂移）：更新项目设置后旧确认载荷整体失效。
    const settingsUpdate = await s.client.submitCommand({
      operation: 'settings.project.update',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 1,
      payload: PROJECT_SETTINGS,
    });
    expect(settingsUpdate.status).toBe('completed');
    const tasksAfterSettings = taskRows(s);
    const staleSettings = await s.client.reapplyTaskStrategy(input);
    expect(staleSettings).toMatchObject({ status: 'rejected', error: { details: { reason: 'preview_stale' } } });
    expect(taskRows(s)).toEqual(tasksAfterSettings);
    expect(eventCount(s, 'task.strategy.updated')).toBe(0);

    // 预览过期（Task revision 漂移）：纯标签编辑 bump revision 后旧预览失效。
    const refreshedPreview = await s.client.previewTaskStrategyReapplication(s.projectId, [s.freshTaskLowId]);
    expect(refreshedPreview.status).toBe('ready');
    const labelDrift = await s.client.updatePlanLabels({
      projectId: s.projectId, entityType: 'task', id: s.freshTaskLowId,
      expectedRevision: 1, labels: ['drift'],
    });
    expect(labelDrift.status).toBe('completed');
    const tasksAfterDrift = taskRows(s);
    const staleRevision = await s.client.reapplyTaskStrategy(confirmationOf(refreshedPreview));
    expect(staleRevision).toMatchObject({ status: 'rejected', error: { details: { reason: 'preview_stale' } } });
    expect(taskRows(s)).toEqual(tasksAfterDrift);
    expect(eventCount(s, 'task.strategy.updated')).toBe(0);

    // 活动 Attempt 保护：t-1 已认领（running + Attempt），预览阻塞并给出全部理由。
    const runningPreview = await s.client.previewTaskStrategyReapplication(s.projectId, [s.protectedRunningTaskId]);
    expect(runningPreview.status).toBe('blocked');
    expect(runningPreview.blockedReasons).toEqual(
      expect.arrayContaining(['task_started', 'execution_history', 'active_execution_inputs', 'authorized_batch_scope']));
    const runningConfirm = await s.client.reapplyTaskStrategy(confirmationOf(runningPreview));
    expect(runningConfirm).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });

    // 既有 Batch 快照保护：t-2 未启动但 Feature 已进入授权 Batch 范围。
    const scopedPreview = await s.client.previewTaskStrategyReapplication(s.projectId, [s.protectedPendingTaskId]);
    expect(scopedPreview.status).toBe('blocked');
    expect(scopedPreview.blockedReasons).toEqual(
      expect.arrayContaining(['execution_history', 'active_execution_inputs', 'authorized_batch_scope']));
    expect(scopedPreview.blockedReasons).not.toContain('task_started');
    const scopedConfirm = await s.client.reapplyTaskStrategy(confirmationOf(scopedPreview));
    expect(scopedConfirm).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    // 两次保护拒绝零写入：受保护 Task 行与策略事件原值。
    expect(taskRows(s)).toEqual(tasksAfterDrift);
    expect(eventCount(s, 'task.strategy.updated')).toBe(0);

    // 跨项目访问：目标 Task 属于另一项目 → 预览阻塞 cross_project；身份不泄漏
    // 目标 revision（null），拼不出可确认载荷；伪造 revision 的确认被服务端拒绝。
    const crossPreview = await s.client.previewTaskStrategyReapplication(s.projectId, [s.otherProjectTaskId]);
    expect(crossPreview.status).toBe('blocked');
    expect(crossPreview.blockedReasons).toContain('cross_project');
    expect(crossPreview.identity.taskRevisions[0]).toEqual({ taskId: s.otherProjectTaskId, revision: null });
    const fabricated = await s.client.reapplyTaskStrategy({
      ...input,
      selectedTaskIds: [s.otherProjectTaskId],
      expectedTaskRevisions: [{ taskId: s.otherProjectTaskId, revision: 1 }],
    });
    expect(fabricated).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    // 另一项目 Task 未被触碰。
    expect(s.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(s.otherProjectTaskId))
      .toMatchObject({ revision: 1, status: 'pending', config_source: 'global_default' });
    expect(taskRows(s)).toEqual(tasksAfterDrift);
  });

  it('[case:label-rejection-boundaries] 标签 CAS 冲突与跨项目拒绝零写入，查询只读', async () => {
    const s = await setupVertical();
    const tasksBefore = taskRows(s);
    const runsBefore = runRows(s);
    const batchBefore = batchRows(s);
    const eventsBefore = {
      phase: eventCount(s, 'phase.labels.updated'),
      feature: eventCount(s, 'feature.labels.updated'),
      task: eventCount(s, 'task.labels.updated'),
      run: eventCount(s, 'execution.run.labels.updated'),
    };

    // 标签 CAS 冲突：旧 expectedRevision 固化 rejected（conflict），不写事件。
    const taskConflict = await s.client.updatePlanLabels({
      projectId: s.projectId, entityType: 'task', id: s.freshTaskLowId,
      expectedRevision: 99, labels: ['never'],
    });
    expect(taskConflict).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    const runConflict = await s.client.submitCommand({
      operation: 'plan.labels.update',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 99,
      payload: { entityType: 'run', id: s.runId, labels: ['never'] },
    });
    expect(runConflict).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    expect(taskRows(s)).toEqual(tasksBefore);
    expect(runRows(s)).toEqual(runsBefore);

    // 跨项目标签编辑：目标属于另一项目 → forbidden（不泄漏存在性细节）。
    expectProtocolError(await rejectionOf(() => s.client.updatePlanLabels({
      projectId: s.projectId, entityType: 'task', id: s.otherProjectTaskId,
      expectedRevision: 1, labels: ['steal'],
    })), 'forbidden');
    expect(taskRows(s)).toEqual(tasksBefore);
    expect(batchRows(s)).toEqual(batchBefore);
    expect({
      phase: eventCount(s, 'phase.labels.updated'),
      feature: eventCount(s, 'feature.labels.updated'),
      task: eventCount(s, 'task.labels.updated'),
      run: eventCount(s, 'execution.run.labels.updated'),
    }).toEqual(eventsBefore);
    // 冲突/拒绝后正常路径仍可用：以正确 revision 的 Run 标签更新成功。
    const recovered = await s.client.submitCommand({
      operation: 'plan.labels.update',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: s.runRevision,
      payload: { entityType: 'run', id: s.runId, labels: ['after-conflict'] },
    });
    expect(recovered).toMatchObject({ status: 'completed' });
    if (recovered.status !== 'completed') throw new Error('冲突后恢复编辑未完成');
    expect(recovered.result).toMatchObject({ labels: ['after-conflict'], revision: s.runRevision + 1 });

    // 查询只读：四层查询与预览前后事件水位不变。
    const before = await s.client.getSnapshot({ kind: 'project', projectId: s.projectId });
    await s.client.listPhases(s.projectId, { labels: ['any'] });
    await s.client.listTasks(s.projectId, s.freshFeatureId, {});
    await s.client.listRuns(s.projectId, { limit: 1 });
    await s.client.getLabelCounts({ entity: 'task', projectId: s.projectId, featureId: s.freshFeatureId });
    await s.client.previewTaskStrategyReapplication(s.projectId, [s.freshTaskLowId]);
    const after = await s.client.getSnapshot({ kind: 'project', projectId: s.projectId });
    expect(after.watermark).toEqual(before.watermark);
  });

  it('[case:cli-vertical] CLI 策略预览/确认与标签查询经真实 Host 闭环，输出脱敏', async () => {
    const s = await setupVertical();
    let stdout = '';
    let stderr = '';
    const invokeCli = async (args: readonly string[]) => {
      stdout = '';
      stderr = '';
      const result = await runAppCli({
        args: [...args, '--data-root', s.fixture.box.box.dataRoot],
        env: {},
        io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
      });
      return result;
    };

    const previewRun = await invokeCli(['task', 'strategy-preview', '--project', s.projectId, '--task', s.freshTaskLowId, '--json']);
    expect(previewRun.exitCode, stderr).toBe(0);
    const preview = JSON.parse(stdout).result as TaskStrategyReapplicationPreviewWire;
    expect(preview.status).toBe('ready');
    expect(preview.changedCount).toBe(1);

    const { projectId: _p, confirmed: _c, commandId: _cmd, ...payload } = confirmationOf(preview);
    const confirmationPath = join(s.fixture.box.box.root, 'f008-confirmation.json');
    writeFileSync(confirmationPath, JSON.stringify(payload), 'utf8');
    const commandId = randomUUID();
    const reapplyArgs = ['task', 'strategy-reapply', '--project', s.projectId, '--input', confirmationPath, '--confirm', '--command-id', commandId] as const;
    const reapplyRun = await invokeCli([...reapplyArgs, '--json']);
    expect(reapplyRun.exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout).result).toMatchObject({
      status: 'completed',
      result: { taskRevisions: [{ taskId: s.freshTaskLowId, revision: 2 }] },
    });
    const tasksAfterReapply = taskRows(s);

    // 同一命令重放：返回原回执，零重复写入。
    const replayRun = await invokeCli([...reapplyArgs]);
    expect(replayRun.exitCode, stderr).toBe(0);
    expect(stdout).toContain(`task=${s.freshTaskLowId} revision=2`);
    expect(taskRows(s)).toEqual(tasksAfterReapply);

    // Run 列表与四层计数经 CLI 查询（只读）。
    const runsRun = await invokeCli(['execution', 'runs', '--project', s.projectId, '--json']);
    expect(runsRun.exitCode, stderr).toBe(0);
    const runsResult = JSON.parse(stdout).result as { records: { id: string }[] };
    expect(runsResult.records.map(record => record.id)).toEqual([s.runId]);
    const countsRun = await invokeCli(['project', 'labels', '--entity', 'run', '--project', s.projectId, '--json']);
    expect(countsRun.exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout).result).toEqual({ entity: 'run', labels: [] });

    // 输出脱敏：不含数据根/本地路径。
    expect(stdout + stderr).not.toContain(s.fixture.box.box.dataRoot);
    expect(stdout + stderr).not.toContain('/Users/');
  });
});
