/**
 * P07-4 / F-009：通知与 delivery 发送状态 HostClient 契约测试（真实 loopback
 * Host + 真实临时 SQLite 项目；不调用模型、不启动 Runtime）。
 *
 * 覆盖：
 * - 默认装配可直接访问：真实 loopback HostClient 与 Core 查询返回值逐字节一致
 *  （列表/筛选/分页/详情审计），查询只读（全表快照前后不变）；
 * - 未认证/无效令牌 401、受限 Work 工具令牌不被查询面接受、跨项目折叠、
 *   坏输入 400（白名单/整数/实体冲突/状态词汇）、任意路径 404；
 * - 能力声明同步（APPLICATION_QUERY_CAPABILITIES / APP_OPERATIONS / 路由解析）
 *   且新增操作不自动扩大受限 Work 工具授权面；
 * - wire fail-closed：响应版本不符 unsupported_schema_version、形状/词汇/归属
 *   漂移 response_malformed。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { BUDGET, NOW, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/client/app-wire.ts';
import { resolveAppRoute } from '../../../packages/host/src/runtime/app-transport.ts';
import { APP_OPERATIONS } from '../../../packages/host/src/contract/errors.ts';
import { APPLICATION_QUERY_CAPABILITIES } from '../../../packages/host/src/contract/lifecycle.ts';
import { WORK_TOOL_OPERATION_SPECS } from 'shiploop-core/protocol';
import { createSqliteNotificationDeliveryStore } from '../../../packages/core/src/adapters/sqlite/notification-delivery-store.ts';

const fixtures: BudgetFixture[] = [];
const hosts: Awaited<ReturnType<typeof openReportHost>>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.close();
});

function seedEvent(f: BudgetFixture, sequenceBase: number, suffix: string): string {
  const eventId = randomUUID();
  f.session.database.prepare(
    'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(eventId, NOW, NOW, f.projectId, sequenceBase, 'task.terminal', 'task', `task-${suffix}`,
    JSON.stringify({ schemaVersion: 1, status: 'passed', resultCategory: 'passed', attemptId: `attempt-${suffix}`, runId: `run-${suffix}`, resultRef: null }), NOW);
  return eventId;
}

/** 三行通知：pending / delivered（带回执）/ retry_scheduled（带失败原因）；pending 最后创建避免被认领。 */
function seedNotifications(f: BudgetFixture) {
  const base = Number(f.session.database.prepare<[], { m: unknown }>('SELECT COALESCE(MAX(sequence), 0) AS m FROM state_events').get()!.m);
  const clock = { now: NOW };
  const store = createSqliteNotificationDeliveryStore({ session: f.session, nowUtcMs: () => clock.now });
  const delivered = store.createDelivery({ eventId: seedEvent(f, base + 2, 'two'), channelId: 'local-results',
    summary: { schemaVersion: 1, kind: 'task_terminal', taskId: 'task-two', status: 'failed', resultCategory: 'runtime_failed', attemptId: 'attempt-two', runId: 'run-two', resultRef: null } }).delivery;
  const claimed = store.claimDueDeliveries({ channelId: 'local-results', owner: 'worker-h', limit: 10 }).deliveries.find(d => d.deliveryId === delivered.deliveryId)!;
  clock.now = NOW + 5_000;
  store.recordDeliveryResult({ deliveryId: delivered.deliveryId, claimGeneration: claimed.claimGeneration, attempt: 1, outcome: 'succeeded', receipt: { channelId: 'local-results', deliveryId: delivered.deliveryId, attempt: 1 } });
  const retrying = store.createDelivery({ eventId: seedEvent(f, base + 3, 'three'), channelId: 'local-results',
    summary: { schemaVersion: 1, kind: 'task_terminal', taskId: 'task-three', status: 'passed', resultCategory: 'passed', attemptId: 'attempt-three', runId: 'run-three', resultRef: null } }).delivery;
  const claimedRetry = store.claimDueDeliveries({ channelId: 'local-results', owner: 'worker-h2', limit: 10 }).deliveries.find(d => d.deliveryId === retrying.deliveryId)!;
  clock.now = NOW + 6_000;
  store.recordDeliveryResult({ deliveryId: retrying.deliveryId, claimGeneration: claimedRetry.claimGeneration, attempt: 1, outcome: 'failed', failureReason: 'channel down', nextAttemptAt: NOW + 600_000 });
  const pending = store.createDelivery({ eventId: seedEvent(f, base + 1, 'one'), channelId: 'local-results',
    summary: { schemaVersion: 1, kind: 'task_terminal', taskId: 'task-one', status: 'passed', resultCategory: 'passed', attemptId: 'attempt-one', runId: 'run-one', resultRef: null } }).delivery;
  return { pending, delivered, retrying };
}

function snapshotAll(f: BudgetFixture): Record<string, unknown[]> {
  const tables = f.session.database.prepare<[], { name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, f.session.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

test('[case:host-client-parity] 默认装配 HostClient 与 Core 逐字节一致（列表/筛选/分页/详情）且查询只读', async () => {
  const f = await openBudgetFixture(BUDGET, [{ id: 't-1', title: 'Task 1', acceptance: { criteria: ['notifications'] }, dependsOn: [] }]);
  fixtures.push(f);
  const seeded = seedNotifications(f);
  const h = await openReportHost(f);
  hosts.push(h);
  const before = snapshotAll(f);

  const expected = await h.app.queryService.listNotifications(f.owner, { projectId: f.projectId, limit: 200 });
  const result = await h.client.listNotifications(f.projectId, { limit: 200 });
  expect(result).toEqual(expected);
  expect(result.records.map(r => r.status).sort()).toEqual(['delivered', 'pending', 'retry_scheduled']);
  expect(result.records.find(r => r.deliveryId === seeded.delivered.deliveryId)).toMatchObject({
    status: 'delivered', attemptCount: 1, lastOutcome: 'succeeded', receipt: { channelId: 'local-results', deliveryId: seeded.delivered.deliveryId, attempt: 1 },
  });
  expect(result.records.find(r => r.deliveryId === seeded.retrying.deliveryId)).toMatchObject({
    status: 'retry_scheduled', lastOutcome: 'failed', lastFailureReason: 'channel down', nextAttemptAt: new Date(NOW + 600_000).toISOString(),
  });

  // 筛选与分页经真实 HTTP 与 Core 一致；nextCursor 翻页不重复不遗漏。
  const filtered = await h.client.listNotifications(f.projectId, { taskId: 'task-two' });
  expect(filtered.records.map(r => r.deliveryId)).toEqual([seeded.delivered.deliveryId]);
  expect(filtered).toEqual(await h.app.queryService.listNotifications(f.owner, { projectId: f.projectId, taskId: 'task-two' }));
  const statusScoped = await h.client.listNotifications(f.projectId, { status: 'retry_scheduled' });
  expect(statusScoped.records.map(r => r.deliveryId)).toEqual([seeded.retrying.deliveryId]);

  const collected: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await h.client.listNotifications(f.projectId, { limit: 1, ...(cursor === null ? {} : { cursor }) });
    collected.push(...page.records.map(r => r.deliveryId));
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  expect(collected).toEqual(expected.records.map(r => r.deliveryId));

  // 详情与执行审计一致；查询只读（全表快照前后不变，输出不泄漏数据根）。
  const detail = await h.client.getNotification(f.projectId, seeded.retrying.deliveryId);
  expect(detail).toEqual(await h.app.queryService.getNotificationDelivery(f.owner, { projectId: f.projectId, deliveryId: seeded.retrying.deliveryId }));
  expect(detail.attempts).toEqual([{ attempt: 1, outcome: 'failed', receipt: null, failureReason: 'channel down', occurredAt: new Date(NOW + 6_000).toISOString() }]);
  expect(JSON.stringify(result) + JSON.stringify(detail)).not.toContain(f.box.dataRoot);
  expect(snapshotAll(f)).toEqual(before);
});

test('[case:host-errors-and-capabilities] 认证/越权/坏输入拒绝；能力声明同步且不扩大受限工具面', async () => {
  const f = await openBudgetFixture(BUDGET, [{ id: 't-1', title: 'Task 1', acceptance: { criteria: ['notifications'] }, dependsOn: [] }]);
  fixtures.push(f);
  const seeded = seedNotifications(f);
  const restricted = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [f.projectId] } });
  const h = await openReportHost(f, { principal: restricted });
  hosts.push(h);
  const before = snapshotAll(f);

  // 受限主体不可见项目统一 forbidden（不区分存在性）；可见项目内不存在目标 not_found。
  await expect(h.client.listNotifications(randomUUID(), {})).rejects.toMatchObject({ code: 'forbidden' });
  await expect(h.client.getNotification(f.projectId, 'delivery-none')).rejects.toMatchObject({ code: 'not_found' });
  const noRead = createRestrictedPrincipal({ capabilities: ['events.read'], projectScope: { kind: 'all' } });
  await expect(h.app.queryService.listNotifications(noRead, { projectId: f.projectId })).rejects.toMatchObject({ code: 'forbidden' });

  // 坏输入经真实路由拒绝（白名单/整数/实体冲突/状态词汇；有效令牌观察 400）。
  for (const [suffix, status] of [
    ['', 200],
    ['&taskId=task-one&runId=run-one', 400],
    ['&status=sending', 400],
    ['&limit=abc', 400],
    ['&limit=999', 400],
    ['&claimOwner=worker-h', 400],
    ['&taskId=..%2Fsecret', 400],
    ['&taskId=task-one&status=pending', 200],
  ] as const) {
    const response = await loopbackRequest({ method: 'GET', port: h.port,
      path: `/v1/notifications?projectId=${f.projectId}${suffix}`,
      headers: { authorization: `Bearer ${h.token}` } });
    expect(response.statusCode, suffix).toBe(status);
    expect(response.bodyText).not.toContain(h.token);
    expect(response.bodyText).not.toContain(f.box.dataRoot);
  }
  // 详情路由：任意路径/多段形态 404；正常详情 200。
  const detailOk = await loopbackRequest({ method: 'GET', port: h.port,
    path: `/v1/notifications/${seeded.pending.deliveryId}?projectId=${f.projectId}`,
    headers: { authorization: `Bearer ${h.token}` } });
  expect(detailOk.statusCode).toBe(200);
  for (const path of ['/v1/notifications/../etc/passwd?projectId=x', `/v1/notifications/${seeded.pending.deliveryId}/extra?projectId=${f.projectId}`]) {
    const response = await loopbackRequest({ method: 'GET', port: h.port, path,
      headers: { authorization: `Bearer ${h.token}` } });
    expect(response.statusCode, path).toBe(404);
  }

  // 未认证：无效令牌与受限 Work 工具令牌均 401，不被查询面接受。
  for (const authorization of ['Bearer invalid-token', `Bearer ${'ab'.repeat(32)}`]) {
    const response = await loopbackRequest({ method: 'GET', port: h.port,
      path: `/v1/notifications?projectId=${f.projectId}`,
      headers: { authorization } });
    expect(response.statusCode).toBe(401);
  }

  // 能力声明与路由解析同步；新增操作不自动扩大受限 Work 工具授权面。
  expect(APP_OPERATIONS).toContain('notifications.list');
  expect(APP_OPERATIONS).toContain('notifications.get');
  expect(APPLICATION_QUERY_CAPABILITIES).toContain('notifications.list');
  expect(APPLICATION_QUERY_CAPABILITIES).toContain('notifications.get');
  expect(Object.keys(WORK_TOOL_OPERATION_SPECS)).not.toContain('notifications.list');
  expect(Object.keys(WORK_TOOL_OPERATION_SPECS)).not.toContain('notifications.get');
  expect(resolveAppRoute('/v1/notifications')).toMatchObject({ operation: 'notifications.list', method: 'GET' });
  expect(resolveAppRoute(`/v1/notifications/${seeded.pending.deliveryId}`)).toMatchObject({ operation: 'notifications.get', method: 'GET' });
  expect(resolveAppRoute('/v1/notifications/a/b')).toBeUndefined();
  expect(snapshotAll(f)).toEqual(before);
});

test('[case:host-wire-fail-closed] 响应版本/形状/词汇/归属漂移 fail-closed', async () => {
  const f = await openBudgetFixture(BUDGET, [{ id: 't-1', title: 'Task 1', acceptance: { criteria: ['notifications'] }, dependsOn: [] }]);
  fixtures.push(f);
  const seeded = seedNotifications(f);
  const h = await openReportHost(f);
  hosts.push(h);
  const page = await h.client.listNotifications(f.projectId, { limit: 200 });
  const detail = await h.client.getNotification(f.projectId, seeded.delivered.deliveryId);

  // 未知响应版本 → unsupported_schema_version。
  expect(() => validateAppQueryResponse('notifications.list', { ...page, schemaVersion: 99 })).toThrowError(/版本/);
  expect(() => validateAppQueryResponse('notifications.get', { ...detail, schemaVersion: 99 })).toThrowError(/版本/);

  // 形状/词汇/游标/计数漂移 → response_malformed。
  expect(() => validateAppQueryResponse('notifications.list', { ...page, scope: 'notification-list' })).toThrowError(/线协议/);
  expect(() => validateAppQueryResponse('notifications.list', { ...page, records: page.records.map(r => ({ ...r, status: 'sending' })) })).toThrowError(/线协议/);
  expect(() => validateAppQueryResponse('notifications.list', { ...page, nextCursor: 'not-a-cursor' })).toThrowError(/线协议/);
  expect(() => validateAppQueryResponse('notifications.list', { ...page, limit: 1 })).toThrowError(/线协议/);
  expect(() => validateAppQueryResponse('notifications.get', { ...detail, delivery: { ...detail.delivery, channelId: 'webhook' } })).toThrowError(/线协议/);
  expect(() => validateAppQueryResponse('notifications.get', { ...detail, delivery: { ...detail.delivery, entity: { kind: 'batch', id: 'b-1' } } })).toThrowError(/线协议/);
  // 审计链与最近结果轴不一致 → fail-closed（空审计链不得携带最近结果；漂移失败）。
  expect(() => validateAppQueryResponse('notifications.get', { ...detail, attempts: [] })).toThrowError(/线协议/);
});
