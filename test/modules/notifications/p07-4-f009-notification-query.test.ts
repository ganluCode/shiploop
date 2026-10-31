/**
 * P07-4 / F-009：本地通知与 delivery 发送状态只读查询（Core 应用层直接测试，
 * 真实临时 SQLite；不调用模型、不启动 Host）。
 *
 * 覆盖：
 * - 列表值核对：eventId/channelId/deliveryId/适用实体/脱敏摘要/本地回执/发送
 *   状态/累计次数/最近结果与原因/下次尝试时间与持久行一致；五类状态可区分；
 * - 实体（Task/Run/Feature）与状态筛选、键集分页不重复不遗漏；游标绑定项目
 *   与筛选范围（跨项目/跨筛选/伪造游标拒绝）；超界页长/未知键/冲突实体拒绝；
 * - 详情沿稳定 deliveryId 查询本地执行审计（每次尝试结果/原因/回执升序）；
 * - 越权/不可见折叠：无能力 forbidden；受限主体不可见项目与不存在目标统一
 *   not_found；损坏持久行（摘要 kind 超出冻结派生词汇）fail-closed corrupt；
 * - 查询零副作用：全部业务表（含 notification_* 与 state_events）查询前后
 *   逐行不变；受限查询不授予管理权限。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { createQueryService } from '../../../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../../../packages/core/src/ports/path-service.ts';
import { createSqliteNotificationDeliveryStore } from '../../../packages/core/src/adapters/sqlite/notification-delivery-store.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { BUDGET, NOW, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

const fixtures: BudgetFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

function queries(f: BudgetFixture) {
  const store = createSqliteQueryStore(f.session);
  const stateStore = createSqliteStateStore(f.session);
  return {
    store,
    queryService: createQueryService({
      projectReads: store, snapshots: store, eventReads: store, stateStore,
      configurationService: createConfigurationService({ stateStore, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) }),
      planReads: store, executionBudgetReads: store, scheduleReads: store, workspaceReads: store,
      workSessionReads: store, taskEvidenceReads: store, gitOperationReads: store,
      featureDeliveryReads: store, featureReportReads: store, executionControlReads: store,
      resultDiagnosticsReads: store, notificationReads: store,
      artifacts: createSqliteArtifactStore(f.session), artifactFiles: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
      dataRootIdentity: computeDataRootIdentity(f.box.dataRoot), nowUtcMs: () => NOW,
    }),
  };
}

type EventKind = 'task.terminal' | 'task.action_required' | 'execution.run.ended' | 'feature.finalized';

function seedEvent(f: BudgetFixture, kind: EventKind, sequence: number, entitySuffix: string): string {
  const eventId = randomUUID();
  const db = f.session.database;
  let aggregateType = 'task';
  let aggregateId = `task-${entitySuffix}`;
  let payload: Record<string, unknown>;
  switch (kind) {
    case 'task.terminal':
      payload = { schemaVersion: 1, status: 'passed', resultCategory: 'passed', attemptId: `attempt-${entitySuffix}`, runId: `run-${entitySuffix}`, resultRef: null };
      break;
    case 'task.action_required':
      payload = { schemaVersion: 1, action: 'manual_review', itemId: `item-${entitySuffix}`, reason: 'approval_required' };
      break;
    case 'execution.run.ended':
      aggregateType = 'run';
      aggregateId = `run-${entitySuffix}`;
      payload = { schemaVersion: 1, status: 'failed', resultCategory: 'failed', resultRef: null, batchId: `batch-${entitySuffix}`, featureId: `feature-${entitySuffix}` };
      break;
    default:
      aggregateType = 'feature';
      aggregateId = `feature-${entitySuffix}`;
      payload = { schemaVersion: 1, outcome: 'delivered', deliveryStatus: 'succeeded', reasonCode: 'none', runId: `run-${entitySuffix}`, batchId: `batch-${entitySuffix}`, operationId: null };
  }
  db.prepare(
    'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(eventId, NOW, NOW, f.projectId, sequence, kind, aggregateType, aggregateId, JSON.stringify(payload), NOW);
  return eventId;
}

/** 通知场景夹具：五类发送状态 + 第二项目隔离行（互不干扰的受控认领顺序）。 */
async function notificationFixture() {
  const f = await openBudgetFixture(BUDGET, [{ id: 't-1', title: 'Task 1', acceptance: { criteria: ['notifications'] }, dependsOn: [] }]);
  fixtures.push(f);
  const { store, queryService } = queries(f);
  const clock = { now: NOW };
  const writeStore = createSqliteNotificationDeliveryStore({ session: f.session, nowUtcMs: () => clock.now });
  const base = Number(f.session.database.prepare<[], { m: unknown }>('SELECT COALESCE(MAX(sequence), 0) AS m FROM state_events').get()!.m);

  // 先进事件（序列在夹具既有事件之后递增）；delivery 创建顺序控制认领隔离。
  const e1 = seedEvent(f, 'task.terminal', base + 1, 'one');
  const e2 = seedEvent(f, 'execution.run.ended', base + 2, 'two');
  const e3 = seedEvent(f, 'feature.finalized', base + 3, 'three');
  const e4 = seedEvent(f, 'task.action_required', base + 4, 'four');
  const e5 = seedEvent(f, 'task.terminal', base + 5, 'five');

  const delivered = writeStore.createDelivery({ eventId: e2, channelId: 'local-results', summary: { schemaVersion: 1, kind: 'run_ended', runId: 'run-two', status: 'failed', resultCategory: 'failed', resultRef: null, batchId: 'batch-two', featureId: 'feature-two' } }).delivery;
  const exhausted = writeStore.createDelivery({ eventId: e3, channelId: 'local-results', summary: { schemaVersion: 1, kind: 'feature_finalized', featureId: 'feature-three', outcome: 'delivered', deliveryStatus: 'succeeded', reasonCode: 'none', runId: 'run-three', batchId: 'batch-three', operationId: null } }).delivery;
  const retrying = writeStore.createDelivery({ eventId: e4, channelId: 'local-results', summary: { schemaVersion: 1, kind: 'task_action_required', taskId: 'task-four', action: 'manual_review', itemId: 'item-four', reason: 'approval_required' } }).delivery;
  const inFlight = writeStore.createDelivery({ eventId: e5, channelId: 'local-results', summary: { schemaVersion: 1, kind: 'task_terminal', taskId: 'task-five', status: 'failed', resultCategory: 'runtime_failed', attemptId: 'attempt-five', runId: 'run-five', resultRef: null } }).delivery;

  // 认领 #1：四个新建 delivery 全部到期（next_attempt_at = 创建时刻）。
  const firstClaim = writeStore.claimDueDeliveries({ channelId: 'local-results', owner: 'worker-a', limit: 10 }).deliveries;
  const claimOf = (id: string) => firstClaim.find(d => d.deliveryId === id)!;
  clock.now = NOW + 5_000;
  const deliveredFinal = writeStore.recordDeliveryResult({ deliveryId: delivered.deliveryId, claimGeneration: claimOf(delivered.deliveryId).claimGeneration, attempt: 1, outcome: 'succeeded', receipt: { channelId: 'local-results', deliveryId: delivered.deliveryId, attempt: 1 } });
  // retrying 的下次尝试放到远处（后续认领不会误伤）；exhausted 逐次退避到上限。
  writeStore.recordDeliveryResult({ deliveryId: retrying.deliveryId, claimGeneration: claimOf(retrying.deliveryId).claimGeneration, attempt: 1, outcome: 'failed', failureReason: 'timeout', nextAttemptAt: NOW + 600_000 });
  writeStore.recordDeliveryResult({ deliveryId: exhausted.deliveryId, claimGeneration: claimOf(exhausted.deliveryId).claimGeneration, attempt: 1, outcome: 'failed', failureReason: 'channel down 1', nextAttemptAt: NOW + 5_001 });
  for (let attempt = 2; attempt <= 4; attempt++) {
    clock.now = NOW + 5_000 + attempt * 1_000;
    const claimed = writeStore.claimDueDeliveries({ channelId: 'local-results', owner: `worker-e${attempt}`, limit: 10 }).deliveries.find(d => d.deliveryId === exhausted.deliveryId)!;
    if (attempt < 4) {
      writeStore.recordDeliveryResult({ deliveryId: exhausted.deliveryId, claimGeneration: claimed.claimGeneration, attempt, outcome: 'failed', failureReason: `channel down ${attempt}`, nextAttemptAt: NOW + 5_000 + attempt * 1_000 + 1 });
    } else {
      writeStore.recordDeliveryResult({ deliveryId: exhausted.deliveryId, claimGeneration: claimed.claimGeneration, attempt, outcome: 'failed', failureReason: `channel down ${attempt}` });
    }
  }
  const retryingFinal = writeStore.readDelivery({ deliveryId: retrying.deliveryId });

  // pending 最后创建（不再认领）。
  const pending = writeStore.createDelivery({ eventId: e1, channelId: 'local-results', summary: { schemaVersion: 1, kind: 'task_terminal', taskId: 'task-one', status: 'passed', resultCategory: 'passed', attemptId: 'attempt-one', runId: 'run-one', resultRef: null } }).delivery;

  // 第二项目（同库隔离）：不应出现在主项目任何列表/详情中。
  const otherProjectId = randomUUID();
  const otherEventId = randomUUID();
  f.session.database.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES (?, ?, 1, ?, 'Other', 'active', NULL, '[]')",
  ).run(otherProjectId, NOW, NOW);
  f.session.database.prepare(
    'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(otherEventId, NOW, NOW, otherProjectId, base + 9, 'task.terminal', 'task', 'task-other', JSON.stringify({ schemaVersion: 1, status: 'passed', resultCategory: 'passed', attemptId: 'attempt-other', runId: 'run-other', resultRef: null }), NOW);
  const otherDelivery = writeStore.createDelivery({ eventId: otherEventId, channelId: 'local-results', summary: { schemaVersion: 1, kind: 'task_terminal', taskId: 'task-other', status: 'passed', resultCategory: 'passed', attemptId: 'attempt-other', runId: 'run-other', resultRef: null } }).delivery;

  return {
    f, queryService, writeStore, store,
    rows: { pending, delivered: deliveredFinal, exhausted: writeStore.readDelivery({ deliveryId: exhausted.deliveryId }), retrying: retryingFinal, inFlight },
    deliveryIds: { pending: pending.deliveryId, delivered: delivered.deliveryId, exhausted: exhausted.deliveryId, retrying: retrying.deliveryId, inFlight: inFlight.deliveryId },
    eventIds: { pending: e1, delivered: e2, exhausted: e3, retrying: e4, inFlight: e5 },
    other: { projectId: otherProjectId, deliveryId: otherDelivery.deliveryId },
  };
}

function snapshotAll(f: BudgetFixture): Record<string, unknown[]> {
  const tables = f.session.database.prepare<[], { name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, f.session.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

test('[case:list-values-and-statuses] 列表值与持久行一致，五类发送状态可区分且含实体/回执/原因/下次尝试', async () => {
  const box = await notificationFixture();
  const { f, queryService, deliveryIds, eventIds } = box;
  const before = snapshotAll(f);
  const page = await queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 200 });
  expect(page.scope).toBe('notifications');
  expect(page.filter).toEqual({});
  expect(page.records.map(r => r.deliveryId)).toEqual([
    deliveryIds.pending, deliveryIds.delivered, deliveryIds.exhausted, deliveryIds.retrying, deliveryIds.inFlight,
  ]);
  const byId = new Map(page.records.map(r => [r.deliveryId, r]));

  const pending = byId.get(deliveryIds.pending)!;
  expect(pending).toMatchObject({
    eventId: eventIds.pending, channelId: 'local-results', eventType: 'task.terminal',
    entity: { kind: 'task', id: 'task-one' }, status: 'pending', attemptCount: 0,
    lastOutcome: null, lastFailureReason: null, receipt: null,
    summary: { schemaVersion: 1, kind: 'task_terminal', taskId: 'task-one', status: 'passed', resultCategory: 'passed', attemptId: 'attempt-one', runId: 'run-one', resultRef: null },
  });
  expect(pending.nextAttemptAt).toBe(new Date(NOW + 9_000).toISOString());

  const delivered = byId.get(deliveryIds.delivered)!;
  expect(delivered).toMatchObject({
    entity: { kind: 'run', id: 'run-two' }, status: 'delivered', attemptCount: 1,
    lastOutcome: 'succeeded', lastFailureReason: null, nextAttemptAt: null,
    receipt: { channelId: 'local-results', deliveryId: deliveryIds.delivered, attempt: 1 },
  });

  const exhausted = byId.get(deliveryIds.exhausted)!;
  expect(exhausted).toMatchObject({
    entity: { kind: 'feature', id: 'feature-three' }, status: 'exhausted', attemptCount: 4,
    lastOutcome: 'failed', lastFailureReason: 'channel down 4', nextAttemptAt: null, receipt: null,
  });

  const retrying = byId.get(deliveryIds.retrying)!;
  expect(retrying).toMatchObject({
    entity: { kind: 'task', id: 'task-four' }, status: 'retry_scheduled', attemptCount: 1,
    lastOutcome: 'failed', lastFailureReason: 'timeout',
  });
  expect(retrying.nextAttemptAt).toBe(new Date(NOW + 600_000).toISOString());

  const inFlight = byId.get(deliveryIds.inFlight)!;
  expect(inFlight).toMatchObject({ status: 'in_flight', attemptCount: 1, lastOutcome: null, lastFailureReason: null, nextAttemptAt: null });

  // 五类状态在真实持久状态机下可区分。
  expect(new Set(page.records.map(r => r.status))).toEqual(new Set(['pending', 'delivered', 'exhausted', 'retry_scheduled', 'in_flight']));
  // 查询零副作用：全部业务表（含通知表/事件表）逐行不变。
  expect(snapshotAll(f)).toEqual(before);
});

test('[case:entity-status-filters] 实体与状态筛选按冻结摘要键精确匹配且可组合', async () => {
  const box = await notificationFixture();
  const { f, queryService, deliveryIds } = box;
  const taskPage = await queryService.listNotifications(f.owner, { projectId: f.projectId, taskId: 'task-one' });
  expect(taskPage.records.map(r => r.deliveryId)).toEqual([deliveryIds.pending]);
  expect(taskPage.filter).toEqual({ entity: { kind: 'task', id: 'task-one' } });

  const runPage = await queryService.listNotifications(f.owner, { projectId: f.projectId, runId: 'run-two' });
  expect(runPage.records.map(r => r.deliveryId)).toEqual([deliveryIds.delivered]);

  const featurePage = await queryService.listNotifications(f.owner, { projectId: f.projectId, featureId: 'feature-three' });
  expect(featurePage.records.map(r => r.deliveryId)).toEqual([deliveryIds.exhausted]);

  const statusPage = await queryService.listNotifications(f.owner, { projectId: f.projectId, status: 'retry_scheduled' });
  expect(statusPage.records.map(r => r.deliveryId)).toEqual([deliveryIds.retrying]);

  const combined = await queryService.listNotifications(f.owner, { projectId: f.projectId, status: 'pending', taskId: 'task-one' });
  expect(combined.records.map(r => r.deliveryId)).toEqual([deliveryIds.pending]);
  // 非订阅实体键（不存在的任务）→ 空页（不泄漏存在性）。
  const empty = await queryService.listNotifications(f.owner, { projectId: f.projectId, taskId: 'task-none' });
  expect(empty.records).toEqual([]);
  // 同现实体键/未知状态在读取前拒绝。
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, taskId: 'task-one', runId: 'run-two' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, status: 'sending' })).rejects.toMatchObject({ code: 'invalid_input', details: { field: 'status' } });
});

test('[case:pagination-cursor-binding] 键集分页不重复不遗漏；游标绑定项目与筛选范围', async () => {
  const box = await notificationFixture();
  const { f, queryService, deliveryIds } = box;
  const collected: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const result = await queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 2, ...(cursor === null ? {} : { cursor }) });
    expect(result.limit).toBe(2);
    collected.push(...result.records.map(r => r.deliveryId));
    cursor = result.nextCursor;
    if (cursor === null) break;
  }
  expect(cursor).toBeNull();
  expect(collected).toEqual([deliveryIds.pending, deliveryIds.delivered, deliveryIds.exhausted, deliveryIds.retrying, deliveryIds.inFlight]);

  // 游标跨筛选/跨项目/伪造重放一律 invalid_input(invalid_cursor)，绝不从零读取。
  const scoped = await queryService.listNotifications(f.owner, { projectId: f.projectId, status: 'pending', limit: 1 });
  expect(scoped.nextCursor).toBeNull();
  const first = await queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 2 });
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, taskId: 'task-one', cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, status: 'pending', cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
  await expect(queryService.listNotifications(f.owner, { projectId: box.other.projectId, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, cursor: 'plcur_v1_forge' })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
  // 超界页长/未知键在读取前拒绝。
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 0 })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 201 })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, claimOwner: 'x' } as never)).rejects.toMatchObject({ code: 'invalid_input' });
});

test('[case:detail-audit-chain] 详情沿稳定 deliveryId 查询执行审计；不存在/跨项目统一折叠 not_found', async () => {
  const box = await notificationFixture();
  const { f, queryService, deliveryIds } = box;
  const before = snapshotAll(f);
  const exhausted = await queryService.getNotificationDelivery(f.owner, { projectId: f.projectId, deliveryId: deliveryIds.exhausted });
  expect(exhausted.scope).toBe('notification');
  expect(exhausted.delivery).toMatchObject({ deliveryId: deliveryIds.exhausted, status: 'exhausted', attemptCount: 4, lastOutcome: 'failed', lastFailureReason: 'channel down 4' });
  expect(exhausted.attempts.map(a => [a.attempt, a.outcome, a.failureReason])).toEqual([
    [1, 'failed', 'channel down 1'], [2, 'failed', 'channel down 2'], [3, 'failed', 'channel down 3'], [4, 'failed', 'channel down 4'],
  ]);
  expect(exhausted.attempts.every(a => a.receipt === null)).toBe(true);

  const delivered = await queryService.getNotificationDelivery(f.owner, { projectId: f.projectId, deliveryId: deliveryIds.delivered });
  expect(delivered.attempts).toEqual([{ attempt: 1, outcome: 'succeeded', receipt: { channelId: 'local-results', deliveryId: deliveryIds.delivered, attempt: 1 }, failureReason: null, occurredAt: new Date(NOW + 5_000).toISOString() }]);

  const pending = await queryService.getNotificationDelivery(f.owner, { projectId: f.projectId, deliveryId: deliveryIds.pending });
  expect(pending.attempts).toEqual([]);

  // 不存在 / 跨项目 / 非法 ID。
  await expect(queryService.getNotificationDelivery(f.owner, { projectId: f.projectId, deliveryId: 'delivery-none' })).rejects.toMatchObject({ code: 'not_found', details: { reason: 'notification_delivery_not_found' } });
  await expect(queryService.getNotificationDelivery(f.owner, { projectId: f.projectId, deliveryId: box.other.deliveryId })).rejects.toMatchObject({ code: 'not_found' });
  await expect(queryService.getNotificationDelivery(f.owner, { projectId: f.projectId, deliveryId: '../etc/passwd' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(snapshotAll(f)).toEqual(before);
});

test('[case:authorization-fold] 无能力 forbidden；受限主体不可见/不存在统一折叠；跨项目行不可见', async () => {
  const box = await notificationFixture();
  const { f, queryService, deliveryIds } = box;
  const noCapability = createRestrictedPrincipal({ capabilities: ['project.metadata.write'], projectScope: { kind: 'all' } });
  await expect(queryService.listNotifications(noCapability, { projectId: f.projectId })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(queryService.getNotificationDelivery(noCapability, { projectId: f.projectId, deliveryId: deliveryIds.pending })).rejects.toMatchObject({ code: 'forbidden' });

  const otherProjectOnly = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [box.other.projectId] } });
  // 不可见项目统一 forbidden（与既有查询纪律一致，不区分存在性以外的信息）。
  await expect(queryService.listNotifications(otherProjectOnly, { projectId: f.projectId })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(queryService.getNotificationDelivery(otherProjectOnly, { projectId: f.projectId, deliveryId: deliveryIds.pending })).rejects.toMatchObject({ code: 'forbidden' });
  // 不存在项目（无父级实体可折叠）与 git.repairs 同一纪律：空页，不泄漏存在性。
  const ghostProject = await queryService.listNotifications(f.owner, { projectId: randomUUID() });
  expect(ghostProject.records).toEqual([]);
  // 受限主体对自己的可见项目仍可查询（不扩大，也不额外授予写管理面）。
  const own = await queryService.listNotifications(otherProjectOnly, { projectId: box.other.projectId });
  expect(own.records.map(r => r.deliveryId)).toEqual([box.other.deliveryId]);
  // local-owner 可见全部项目但不串项目：主项目列表不含第二项目行。
  const ownerAll = await queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 200 });
  expect(ownerAll.records.some(r => r.deliveryId === box.other.deliveryId)).toBe(false);
});

test('[case:corrupt-rows] 摘要超出冻结派生词汇的持久行 fail-closed corrupt_state', async () => {
  const box = await notificationFixture();
  const { f, queryService, deliveryIds } = box;
  f.session.database.prepare('UPDATE notification_deliveries SET summary_json = ? WHERE id = ?')
    .run(JSON.stringify({ schemaVersion: 1, kind: 'mystery', x: 1 }), deliveryIds.pending);
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 200 })).rejects.toMatchObject({ code: 'corrupt_state' });
  await expect(queryService.getNotificationDelivery(f.owner, { projectId: f.projectId, deliveryId: deliveryIds.pending })).rejects.toMatchObject({ code: 'corrupt_state' });
  // 实体 ID 缺失同样 fail-closed。
  f.session.database.prepare('UPDATE notification_deliveries SET summary_json = ? WHERE id = ?')
    .run(JSON.stringify({ schemaVersion: 1, kind: 'task_terminal', status: 'passed' }), deliveryIds.pending);
  await expect(queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 200 })).rejects.toMatchObject({ code: 'corrupt_state' });
});
