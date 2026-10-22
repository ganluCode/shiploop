/**
 * P04-9 / F-009 派发队列与执行槽位查询接入 Host 传输与 HostClient
 * （真实 startHost + 真实 HostClient + 真实临时 SQLite）。
 *
 * 验收面（.dag_context.json F-009）：
 * 1. 经现有受认证 Host 与 HostClient 窄查询通道读取 F-008 投影，结果与 Core
 *    派生规则同源（展示状态/阻塞原因用 `deriveRunDispatchDisplay` 复核），
 *    槽位摘要与认领/槽位持久行一致；Runtime 未启动即显示为未验证事实。
 * 2. 公共响应解码、操作/路由白名单同步更新；未知查询字段、非法分页/游标、
 *    未认证访问沿用既有协议（401 不可区分 / 400 定位 query.<字段> / 405 /
 *    404 unknown_operation）。
 * 3. 未开放任何新写入口：不接受 capacity/owner/version/release 等参数，不做
 *    SQL、归属改写或槽位释放；既有只读查询（schedule）不受影响。
 * 4. 只读：重复查询与全部负例前后持久表逐字节一致；跨项目占用只折叠为布尔
 *    摘要，不回显其他项目/Run/认领/owner/host 身份。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HostProtocolError,
  isHostProtocolError,
  connectToHost,
  startHost,
  validateAppQueryResponse,
  validateDispatchQueueListResultWire,
  type DispatchQueueListResult,
  type HostClient,
} from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openSlotFixture, type SlotFixture } from '../../helpers/p04-9/slot-fixture.ts';
import {
  deriveRunDispatchDisplay,
  type ExecutionSlotClaimRecord,
  type RunDispatchClaimRecord,
} from '../../../packages/core/src/ports/execution-dispatch.ts';
import { PLAN_LIST_CURSOR_PREFIX } from '../../../packages/core/src/ports/queries.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

/* ------------------------------------------------------------------ *
 * 夹具：真实临时 SQLite（两个已授权 Run）+ 真实 Host + HostClient
 * ------------------------------------------------------------------ */

const DISPATCH_TABLES = [
  'runs',
  'run_dispatch_claims',
  'execution_slot_claims',
  'run_dispatch_intents',
  'attempts',
  'tasks',
  'workspace_leases',
  'execution_batches',
  'runtime_start_reservations',
  'task_attempt_reservations',
  'state_events',
] as const;

interface WiredDispatch {
  readonly fixture: SlotFixture;
  readonly host: RunningHost;
  readonly client: HostClient;
  readonly token: string;
  readonly projectId: string;
  readonly projectIdB: string;
  readonly slotId: string;
  readonly tablesBefore: Record<string, unknown[]>;
}

let activeHost: RunningHost | undefined;
let activeFixture: SlotFixture | undefined;

function dbOf(fixture: SlotFixture) {
  return fixture.box.session.database;
}

function factsSnapshot(fixture: SlotFixture): Record<string, unknown[]> {
  return Object.fromEntries(
    DISPATCH_TABLES.map((table) => [
      table,
      dbOf(fixture).prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as unknown[],
    ]),
  );
}

/** 预置：Run A 持有认领 + 槽位；Run B 持有认领但无槽位（隔离/缺归属事实）。 */
function seedDispatchFacts(fixture: SlotFixture): { slotId: string } {
  const db = dbOf(fixture);
  const insertClaim = db.prepare(
    'INSERT INTO run_dispatch_claims (id, created_at, project_id, revision, updated_at, feature_id, run_id, ' +
      'claim_version, origin, owner_id, host_instance_id, acquired_at, lease_until, state) ' +
      "VALUES (?, ?, ?, 1, ?, ?, ?, 1, 'dispatch', ?, ?, ?, ?, 'held')",
  );
  fixture.box.session.transactWrite('fixture.f009.dispatch', () => {
    insertClaim.run(
      fixture.claimA, NOW, fixture.projectId, NOW, fixture.runA.featureId, fixture.runA.runId,
      'owner-a', 'host-a', NOW, NOW + 60_000,
    );
    insertClaim.run(
      fixture.claimB, NOW, fixture.projectId, NOW, fixture.runB.featureId, fixture.runB.runId,
      'owner-b', 'host-b', NOW, NOW + 60_000,
    );
  });
  const slotId = randomUUID();
  db.prepare(
    'INSERT INTO execution_slot_claims (id, created_at, project_id, revision, updated_at, slot_index, ' +
      'feature_id, run_id, claim_id, claim_version, owner_id, host_instance_id, acquired_at, lease_until, ' +
      "state, reason, released_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, 1, 'owner-a', 'host-a', ?, ?, 'held', NULL, NULL)",
  ).run(
    slotId, NOW, fixture.projectId, NOW, fixture.runA.featureId, fixture.runA.runId,
    fixture.claimA, NOW, NOW + 60_000,
  );
  return { slotId };
}

async function openWiredDispatch(): Promise<WiredDispatch> {
  const fixture = await openSlotFixture();
  activeFixture = fixture;
  const box = fixture.box;
  // 夹具认领在 Host 启动截面会被启动核对隔离；本任务只测查询，先移除再由测试预置事实。
  box.session.transactWrite('fixture.f009.resetClaims', () => {
    dbOf(fixture).prepare('DELETE FROM run_dispatch_claims WHERE project_id = ?').run(fixture.projectId);
  });

  // 第二个项目：跨项目占用只披露布尔摘要的对照。
  const registeredB = await box.submit('project.register', {
    repositoryPath: box.box.repoDirB,
    displayName: 'F-009 Repo B',
    description: null,
    labels: [],
  }, { scope: { kind: 'registration' } });
  if (registeredB.status !== 'completed') {
    throw new Error(`夹具项目 B 注册失败：${JSON.stringify(registeredB)}`);
  }
  const projectIdB = (registeredB.result as { project: { id: string } }).project.id;

  const host = await startHost({
    dataRoot: box.box.dataRoot,
    capabilityCatalog: box.box.capabilityCatalog,
    env: {},
  });
  activeHost = host;
  const token = readFileSync(join(box.box.dataRoot, 'host', 'auth.token'), 'utf8');
  const client = await connectToHost({ canonicalRoot: box.box.dataRoot });
  // 启动核对完成后再预置派发事实（不是被核对的旧 owner）。
  const { slotId } = seedDispatchFacts(fixture);
  const tablesBefore = factsSnapshot(fixture);
  return {
    fixture,
    host,
    client,
    token,
    projectId: fixture.projectId,
    projectIdB,
    slotId,
    tablesBefore,
  };
}

function expectProtocolError(error: unknown, code: string): HostProtocolError {
  expect(isHostProtocolError(error)).toBe(true);
  const protocolError = error as HostProtocolError;
  expect(protocolError.code).toBe(code);
  return protocolError;
}

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('应当以错误拒绝，实际成功返回');
}

function errorBodyFace(body: unknown): unknown {
  const parsed = body as { error?: Record<string, unknown> };
  return {
    code: parsed.error?.code,
    operation: parsed.error?.operation,
    message: parsed.error?.message,
    details: parsed.error?.details,
  };
}

function claimRecordFromRow(row: Record<string, unknown>): RunDispatchClaimRecord {
  return {
    id: row.id as string,
    createdAtUtcMs: row.created_at as number,
    projectId: row.project_id as string,
    revision: row.revision as number,
    updatedAtUtcMs: row.updated_at as number,
    featureId: row.feature_id as string,
    runId: row.run_id as string,
    claimVersion: row.claim_version as number,
    origin: row.origin as RunDispatchClaimRecord['origin'],
    resumedFromClaimId: (row.resumed_from_claim_id as string | null) ?? null,
    resumedFromClaimVersion: (row.resumed_from_claim_version as number | null) ?? null,
    ownerId: row.owner_id as string,
    hostInstanceId: row.host_instance_id as string,
    acquiredAtUtcMs: row.acquired_at as number,
    leaseUntilUtcMs: row.lease_until as number,
    state: row.state as RunDispatchClaimRecord['state'],
    reason: (row.reason as string | null) ?? null,
    settledAtUtcMs: (row.settled_at as number | null) ?? null,
  };
}

function slotRecordFromRow(row: Record<string, unknown>): ExecutionSlotClaimRecord {
  return {
    id: row.id as string,
    createdAtUtcMs: row.created_at as number,
    projectId: row.project_id as string,
    revision: row.revision as number,
    updatedAtUtcMs: row.updated_at as number,
    slotIndex: row.slot_index as number,
    featureId: row.feature_id as string,
    runId: row.run_id as string,
    claimId: row.claim_id as string,
    claimVersion: row.claim_version as number,
    ownerId: row.owner_id as string,
    hostInstanceId: row.host_instance_id as string,
    acquiredAtUtcMs: row.acquired_at as number,
    leaseUntilUtcMs: row.lease_until as number,
    state: row.state as ExecutionSlotClaimRecord['state'],
    reason: (row.reason as string | null) ?? null,
    releasedAtUtcMs: (row.released_at as number | null) ?? null,
  };
}

afterEach(async () => {
  const host = activeHost;
  activeHost = undefined;
  const fixture = activeFixture;
  activeFixture = undefined;
  if (fixture !== undefined) {
    // 本夹具不启动 Runner：退役测试预置的假派发事实，不用它绕过生产停止核对。
    try {
      fixture.box.session.transactWrite('fixture.f009.cleanup', () => {
        const db = dbOf(fixture);
        db.prepare('DELETE FROM execution_slot_claims WHERE project_id = ?').run(fixture.projectId);
        db.prepare('DELETE FROM run_dispatch_claims WHERE project_id = ?').run(fixture.projectId);
      });
    } catch {
      // 数据库可能已随 close 关闭；清理失败只影响后续断言，不掩盖主测试结果。
    }
  }
  if (host !== undefined) {
    await host.close();
  }
  if (fixture !== undefined) {
    fixture.close();
  }
});

/* ------------------------------------------------------------------ *
 * A. 真实 Host + HostClient 纵向：投影同源、槽位摘要与只读
 * ------------------------------------------------------------------ */

describe('F-009 派发查询 HostClient 纵向（真实 Host + SQLite）', () => {
  it('握手宣告查询能力；读取 F-008 投影与 Core 派生规则/持久行同源；重复查询零副作用', async () => {
    const s = await openWiredDispatch();
    try {
      expect(s.client.handshake.capabilities.application.queries).toContain(
        'execution.dispatch.list',
      );

      const page = await s.client.listExecutionDispatchQueue(s.projectId);
      expect(page.schemaVersion).toBe(5);
      expect(page.scope).toBe('dispatch-queue');
      expect(page.limit).toBe(50);
      expect(page.records.map((record) => record.runId).sort()).toEqual(
        [s.fixture.runA.runId, s.fixture.runB.runId].sort(),
      );

      // 槽位摘要来自持久事实：容量 1，A 持有唯一槽位，全局无余量。
      expect(page.slots).toEqual({
        capacity: 1,
        activeCount: 1,
        availableCount: 0,
        quarantinedCount: 0,
        projectActiveCount: 1,
        otherProjectActive: false,
      });
      const db = dbOf(s.fixture);
      const slotRow = db
        .prepare('SELECT * FROM execution_slot_claims WHERE id = ?')
        .get(s.slotId) as Record<string, unknown>;
      const recordA = page.records.find((record) => record.runId === s.fixture.runA.runId);
      const recordB = page.records.find((record) => record.runId === s.fixture.runB.runId);
      if (recordA === undefined || recordB === undefined) {
        throw new Error('expected two dispatch records');
      }

      // 派生状态/阻塞原因与 Core 同一规则函数一致（不是 Host 另写一套判断）。
      const claimARow = db
        .prepare('SELECT * FROM run_dispatch_claims WHERE id = ?')
        .get(s.fixture.claimA) as Record<string, unknown>;
      const claimBRow = db
        .prepare('SELECT * FROM run_dispatch_claims WHERE id = ?')
        .get(s.fixture.claimB) as Record<string, unknown>;
      const expectedA = deriveRunDispatchDisplay({
        runStatus: 'queued',
        claim: claimRecordFromRow(claimARow),
        slot: slotRecordFromRow(slotRow),
        activeAttempt: null,
        slotCapacityAvailable: page.slots.availableCount > 0,
        nowUtcMs: Date.now(),
      });
      const expectedB = deriveRunDispatchDisplay({
        runStatus: 'queued',
        claim: claimRecordFromRow(claimBRow),
        slot: null,
        activeAttempt: null,
        slotCapacityAvailable: page.slots.availableCount > 0,
        nowUtcMs: Date.now(),
      });
      expect({ state: recordA.state, blockingReason: recordA.blockingReason }).toEqual(expectedA);
      expect({ state: recordB.state, blockingReason: recordB.blockingReason }).toEqual(expectedB);
      expect(recordA.state).toBe('claimed');
      expect(recordB).toMatchObject({
        state: 'blocked',
        blockingReason: 'slot_ownership_missing',
        slot: null,
      });

      // 认领/槽位/派发事实身份与持久行逐一对应。
      expect(recordA.claim).toMatchObject({
        claimId: s.fixture.claimA,
        claimVersion: 1,
        origin: 'dispatch',
        ownerId: 'owner-a',
        hostInstanceId: 'host-a',
        state: 'held',
        settledAt: null,
      });
      expect(recordA.slot).toMatchObject({
        slotId: s.slotId,
        slotIndex: 1,
        claimId: s.fixture.claimA,
        ownerId: 'owner-a',
        state: 'held',
        releasedAt: null,
      });
      expect(recordA).toMatchObject({
        projectId: s.projectId,
        featureId: s.fixture.runA.featureId,
        runStatus: 'queued',
        dispatchOrdinal: 1,
        activeAttempt: null,
        latestAttempt: null,
        attemptCount: 0,
        startedAt: null,
        endedAt: null,
      });
      expect(recordB.claim).toMatchObject({ claimId: s.fixture.claimB, ownerId: 'owner-b' });

      // 分页：limit 命中时返回受控游标，下一段仍同源。
      const firstPage = await s.client.listExecutionDispatchQueue(s.projectId, { limit: 1 });
      expect(firstPage.records).toHaveLength(1);
      expect(firstPage.nextCursor?.startsWith(PLAN_LIST_CURSOR_PREFIX)).toBe(true);
      const secondPage = await s.client.listExecutionDispatchQueue(s.projectId, {
        limit: 1,
        cursor: firstPage.nextCursor!,
      });
      const expectedSecond =
        firstPage.records[0]?.runId === s.fixture.runA.runId
          ? s.fixture.runB.runId
          : s.fixture.runA.runId;
      expect(secondPage.records.map((record) => record.runId)).toEqual([expectedSecond]);

      // 既有只读查询仍可用（同一授权装配，不受新操作影响）。
      const schedule = await s.client.getRunScheduleStatus(s.projectId, s.fixture.runA.runId);
      expect(schedule.run.id).toBe(s.fixture.runA.runId);

      // 重复查询零写入：全部持久表逐字节一致。
      const replay = await s.client.listExecutionDispatchQueue(s.projectId);
      expect(replay).toEqual(page);
      expect(factsSnapshot(s.fixture)).toEqual(s.tablesBefore);
    } finally {
      s.client.close();
    }
  });

  it('跨项目只返回空页 + 布尔占用摘要，不回显其他项目身份；跨项目游标 invalid_cursor', async () => {
    const s = await openWiredDispatch();
    try {
      const pageA = await s.client.listExecutionDispatchQueue(s.projectId, { limit: 1 });
      const pageB = await s.client.listExecutionDispatchQueue(s.projectIdB);
      expect(pageB.records).toEqual([]);
      expect(pageB.slots).toMatchObject({ otherProjectActive: true, projectActiveCount: 0 });
      const serialized = JSON.stringify(pageB);
      for (const secret of [
        s.projectId,
        s.fixture.runA.runId,
        s.fixture.runA.featureId,
        s.fixture.claimA,
        s.slotId,
        'owner-a',
        'host-a',
      ]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain(s.fixture.box.box.dataRoot);

      const replayed = expectProtocolError(
        await rejectionOf(() =>
          s.client.listExecutionDispatchQueue(s.projectIdB, { cursor: pageA.nextCursor! }),
        ),
        'invalid_input',
      );
      expect(replayed.details).toMatchObject({ reason: 'invalid_cursor' });
      expect(factsSnapshot(s.fixture)).toEqual(s.tablesBefore);
    } finally {
      s.client.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * B. HTTP 传输面负例（真实 Host，原始回环请求）
 * ------------------------------------------------------------------ */

describe('F-009 派发查询 HTTP 负例（真实 Host）', () => {
  it('未认证/伪造凭据一律 401 且响应体不可区分', async () => {
    const s = await openWiredDispatch();
    try {
      const path = `/v1/dispatch-queue?projectId=${s.projectId}`;
      const missing = await loopbackRequest({ port: s.host.port, method: 'GET', path });
      const wrong = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path,
        token: '0'.repeat(64),
      });
      for (const response of [missing, wrong]) {
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: { code: 'unauthorized', operation: 'execution.dispatch.list' },
        });
      }
      expect(missing.bodyText).toBe(wrong.bodyText);
    } finally {
      s.client.close();
    }
  });

  it('未知/重复/缺失参数与可写意图一律 400，不接受容量/归属/释放入口', async () => {
    const s = await openWiredDispatch();
    try {
      const base = `/v1/dispatch-queue?projectId=${s.projectId}`;
      const badCases: Array<{ path: string; reason: string; field?: string }> = [
        { path: `${base}&foo=1`, reason: 'unknown_query_parameter', field: 'query.foo' },
        { path: `${base}&limit=2&limit=3`, reason: 'duplicate_query_parameter', field: 'query.limit' },
        { path: `${base}&limit=1.5`, reason: 'invalid_integer', field: 'query.limit' },
        { path: `${base}&limit=abc`, reason: 'invalid_integer', field: 'query.limit' },
        { path: '/v1/dispatch-queue', reason: 'missing_project_id', field: 'query.projectId' },
        { path: `${base}&cursor=1`, reason: 'invalid_cursor' },
      ];
      // 任何新增控制面都不存在：容量、owner/version 与槽位释放只能经既有受控命令。
      for (const key of ['capacity', 'owner', 'version', 'release', 'slotId', 'state']) {
        badCases.push({ path: `${base}&${key}=x`, reason: 'unknown_query_parameter', field: `query.${key}` });
      }
      for (const testCase of badCases) {
        const response = await loopbackRequest({
          port: s.host.port,
          method: 'GET',
          path: testCase.path,
          token: s.token,
        });
        expect(response.statusCode).toBe(400);
        const body = response.json() as { error: Record<string, unknown> };
        expect(body.error.code).toBe('invalid_input');
        expect((body.error.details as Record<string, unknown>).reason).toBe(testCase.reason);
        if (testCase.field !== undefined) {
          expect((body.error.details as Record<string, unknown>).field).toBe(testCase.field);
        }
      }
      for (const limit of [0, 201]) {
        const response = await loopbackRequest({
          port: s.host.port,
          method: 'GET',
          path: `${base}&limit=${limit}`,
          token: s.token,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: 'invalid_input' } });
      }
      // 未冻结路由形态 404；集合根只允许 GET（没有新的写入口）。
      for (const path of ['/v1/dispatch-queue/extra', `/v1/dispatch-queue/${s.fixture.runA.runId}`]) {
        const response = await loopbackRequest({
          port: s.host.port,
          method: 'GET',
          path,
          token: s.token,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'unknown_operation' } });
      }
      const post = await loopbackRequest({
        port: s.host.port,
        method: 'POST',
        path: '/v1/dispatch-queue',
        token: s.token,
        body: {},
      });
      expect(post.statusCode).toBe(405);
      const withBody = await loopbackRequest({
        port: s.host.port,
        method: 'GET',
        path: base,
        token: s.token,
        body: {},
      });
      expect(withBody.statusCode).toBe(400);
      // 全部负例零业务副作用。
      expect(factsSnapshot(s.fixture)).toEqual(s.tablesBefore);
    } finally {
      s.client.close();
    }
  });

  it('客户端零网络输入把关：非法身份/分页在发请求前 invalid_input', async () => {
    const s = await openWiredDispatch();
    try {
      const cases: Array<() => Promise<unknown>> = [
        () => s.client.listExecutionDispatchQueue('bad id!'),
        () => s.client.listExecutionDispatchQueue(s.projectId, { limit: 0 }),
        () => s.client.listExecutionDispatchQueue(s.projectId, { limit: 201 }),
        () => s.client.listExecutionDispatchQueue(s.projectId, { cursor: 'garbage' }),
      ];
      for (const run of cases) {
        expectProtocolError(await rejectionOf(run), 'invalid_input');
      }
      expect(factsSnapshot(s.fixture)).toEqual(s.tablesBefore);
    } finally {
      s.client.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C. 线校验器（纯函数）：冻结形状接受与畸形/越界拒绝
 * ------------------------------------------------------------------ */

const ISO = '2030-03-25T07:00:00.000Z';

function canonicalDispatchQueue(): Record<string, unknown> {
  return {
    schemaVersion: 5,
    scope: 'dispatch-queue',
    slots: {
      capacity: 1,
      activeCount: 1,
      availableCount: 0,
      quarantinedCount: 1,
      projectActiveCount: 1,
      otherProjectActive: true,
    },
    records: [
      {
        runId: 'run-1',
        projectId: 'proj-1',
        featureId: 'feat-1',
        runStatus: 'queued',
        runReason: null,
        dispatchOrdinal: 1,
        state: 'blocked',
        blockingReason: 'claim_quarantined',
        claim: {
          claimId: 'claim-1',
          claimVersion: 1,
          origin: 'dispatch',
          resumedFromClaimId: null,
          resumedFromClaimVersion: null,
          ownerId: 'owner-1',
          hostInstanceId: 'host-1',
          state: 'quarantined',
          acquiredAt: ISO,
          leaseUntil: ISO,
          settledAt: ISO,
          reason: 'manual_verification',
        },
        slot: {
          slotId: 'slot-1',
          slotIndex: 1,
          claimId: 'claim-1',
          claimVersion: 1,
          ownerId: 'owner-1',
          hostInstanceId: 'host-1',
          state: 'quarantined',
          acquiredAt: ISO,
          leaseUntil: ISO,
          releasedAt: null,
          reason: 'manual_verification',
        },
        activeAttempt: null,
        latestAttempt: null,
        attemptCount: 0,
        createdAt: ISO,
        startedAt: null,
        endedAt: null,
        pauseRequestedAt: null,
      },
    ],
    nextCursor: null,
    limit: 50,
  };
}

describe('F-009 派发查询线校验器（纯函数）', () => {
  it('接受冻结形状并原样返回（含槽位摘要与 null 未知纪律）', () => {
    const value = canonicalDispatchQueue();
    expect(validateDispatchQueueListResultWire(value)).toEqual(value);
    expect(validateAppQueryResponse('execution.dispatch.list', value)).toEqual(value);
  });

  it('schemaVersion 不符单独分类 unsupported_schema_version', () => {
    const value = canonicalDispatchQueue();
    value.schemaVersion = 99;
    expect(() => validateDispatchQueueListResultWire(value)).toThrowError(
      expect.objectContaining({ code: 'unsupported_schema_version' }),
    );
  });

  it.each([
    ['未知顶层键', (value: any) => { value.extra = true; }],
    ['scope 不符', (value: any) => { value.scope = 'run-schedule'; }],
    ['槽位容量非正整数', (value: any) => { value.slots.capacity = 0; }],
    ['跨项目摘要伪造成对象', (value: any) => { value.slots.otherProjectActive = { projectId: 'proj-2' }; }],
    ['可编辑状态字段', (value: any) => { value.slots.ownerId = 'owner-1'; }],
    ['Run 状态越出冻结词汇', (value: any) => { value.records[0].runStatus = 'passed'; }],
    ['展示状态越出冻结词汇', (value: any) => { value.records[0].state = 'done'; }],
    ['阻塞原因越出冻结词汇', (value: any) => { value.records[0].blockingReason = 'capacity_2'; }],
    ['认领状态越出冻结词汇', (value: any) => { value.records[0].claim.state = 'held_by_cli'; }],
    ['槽位携带路径字段', (value: any) => { value.records[0].slot.path = '/tmp/x'; }],
    ['槽位序号为负', (value: any) => { value.records[0].slot.slotIndex = -1; }],
    ['时间非 ISO UTC', (value: any) => { value.records[0].createdAt = 'yesterday'; }],
    ['Attempt 摘要携带快照正文', (value: any) => {
      value.records[0].latestAttempt = { id: 'att-1', inputSnapshot: { secret: true } };
    }],
    ['游标前缀不符', (value: any) => { value.nextCursor = 'evcur_v1_x'; }],
    ['limit 非正整数', (value: any) => { value.limit = 0; }],
  ])('拒绝：%s（不泄漏响应内容）', (_name, mutate) => {
    const value = canonicalDispatchQueue();
    mutate(value);
    expect(() => validateDispatchQueueListResultWire(value)).toThrowError(
      expect.objectContaining({ code: 'response_malformed' }),
    );
  });

  it('解码结果可被查询视图消费（与 Core 公开形状一致）', () => {
    const decoded = validateAppQueryResponse(
      'execution.dispatch.list',
      canonicalDispatchQueue(),
    ) as DispatchQueueListResult;
    expect(decoded.records[0]).toMatchObject({
      runId: 'run-1',
      state: 'blocked',
      blockingReason: 'claim_quarantined',
    });
    expect(decoded.slots.quarantinedCount).toBe(1);
  });
});
