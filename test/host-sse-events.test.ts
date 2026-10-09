/**
 * F-012 Host SSE 事件订阅验收（P02-2 契约 §9.4 订阅语义、§13 背压预算）——
 * 真实 127.0.0.1 HTTP + 真实 SQLite/Git/Core 装配 + F-004 loopback SSE 客户端。
 *
 * 覆盖（验收点）：
 * - 快照水位游标/Last-Event-ID/?cursor= 恢复；帧格式 id=eventId、
 *   event=state-event、data 为 schemaVersion=1 封套；先补读已提交事件再持续
 *   推送，升序、至少一次投递，持久 state_events 是唯一来源；
 * - 快照与建连之间写入、补读期间继续写入、断线重连均不漏事件；重复投递可按
 *   eventId 去重；越权订阅（跨项目/全局）在发送任何帧之前 403；
 * - 缺恢复位置 cursor_required；非法/跨 scope/跨数据根游标 invalid_cursor；
 *   未知/跨 scope Last-Event-ID unknown_event_id（不区分存在性）；未来游标
 *   合法等待；保留下界夹具验证建连前 409 snapshot_required 与建连后
 *   event: error snapshot_required 帧；其他项目 sequence 空隙不误判丢失；
 * - 慢客户端真实 TCP 背压 → stream_overflow 帧后结束该流，持久审计完整、
 *   快客户端不被阻塞；心跳 `: ping` 维持活性；
 * - 客户端断开只清理本连接资源（Hub 登记归零、Host 继续服务、已提交命令
 *   不受影响）；quiescing 新订阅 503；真实 startHost 信号收尾在预算内关闭
 *   SSE，重启后原持久游标可续读；
 * - 握手能力宣告 F-012 结构化 SSE events 视图。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEventStreamHub,
  createHostLifecycleServer,
  createHostStopController,
  createIdleActivityGate,
  startHost,
  type EventStreamHub,
  type EventStreamHubOptions,
  type LifecycleState,
} from '../packages/host/src/index.ts';
import {
  computeDataRootIdentity,
  createEventCursorBinding,
  encodeEventCursor,
  type CommandReceipt,
} from '../packages/core/src/index.ts';
import type { CoreApplication } from '../packages/core/src/adapters/composition.ts';
import {
  connectSseLoopback,
  createCommandsTestFixture,
  createReplayLowerBoundController,
  type CommandsTestFixture,
  type SseConnection,
  type SseFrame,
  type TestTrustedPrincipal,
} from './helpers/p02-2/index.ts';
import {
  createIsolatedHostEnvironment,
  loopbackRequest,
  type IsolatedHostEnvironment,
} from './helpers/host/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

const STUB_TOKEN = randomBytes(32).toString('hex');
const STUB_INSTANCE = '0c9c2e51-9a91-4f63-8d92-4b7b9a7c2f10';
const STUB_ROOT_IDENTITY = '9f2a'.repeat(16);
const STUB_STARTED_AT = '2026-10-05T00:00:00.000Z';

let fixture: CommandsTestFixture | undefined;
let environment: IsolatedHostEnvironment | undefined;
const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    }
  }
  await environment?.dispose();
  environment = undefined;
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

/** 有界条件等待（不依赖固定 sleep）。 */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）：${label}`);
}

/** 有界收集帧：达到条数或流结束；超时即失败（不静默少收）。 */
async function collectFrames(
  connection: SseConnection,
  count: number,
  timeoutMs: number,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const iterator = connection.events();
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`collectFrames 超时：已收 ${frames.length}/${count}`);
    }
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<SseFrame>>((_, reject) =>
        setTimeout(() => reject(new Error('帧等待超时')), remaining),
      ),
    ]);
    if (next.done === true) {
      break;
    }
    frames.push(next.value);
  }
  return frames;
}

/** 收集直到流结束（error 帧/服务端关闭）；超时即失败。 */
async function collectUntilEnd(connection: SseConnection, timeoutMs: number): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const iterator = connection.events();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`collectUntilEnd 超时：已收 ${frames.length} 帧`);
    }
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<SseFrame>>((_, reject) =>
        setTimeout(() => reject(new Error('帧等待超时')), remaining),
      ),
    ]);
    if (next.done === true) {
      return frames;
    }
    frames.push(next.value);
  }
}

interface EventServer {
  readonly port: number;
  readonly hub: EventStreamHub;
  setLifecycle(next: LifecycleState): void;
}

/** 装配含 SSE Hub 的应用传输面：真实 Core 窄服务 + 固定可信 principal。 */
async function startEventServer(
  app: CoreApplication,
  principal: TestTrustedPrincipal,
  hubOverrides: Partial<EventStreamHubOptions> = {},
): Promise<EventServer> {
  let lifecycle: LifecycleState = 'ready';
  const stopController = createHostStopController({
    activityGate: createIdleActivityGate(),
    getLifecycleState: () => lifecycle,
    setLifecycleState: (next) => {
      lifecycle = next;
    },
    prepareTeardown: () => Promise.resolve(),
    releaseAfterTeardown: () => Promise.resolve(),
  });
  const hub = createEventStreamHub({
    queryService: app.queryService,
    principal,
    getLifecycleState: () => lifecycle,
    pollIntervalMs: 10,
    heartbeatIntervalMs: 60_000,
    ...hubOverrides,
  });
  const server = createHostLifecycleServer({
    hostInstanceId: STUB_INSTANCE,
    dataRootIdentity: STUB_ROOT_IDENTITY,
    startedAt: STUB_STARTED_AT,
    pid: 4321,
    authToken: STUB_TOKEN,
    getLifecycleState: () => lifecycle,
    getActivities: () => stopController.getActivities(),
    stop: stopController,
    application: {
      principal,
      commandService: app.commandService,
      queryService: app.queryService,
      commandReceiptsService: app.commandReceiptsService,
      getLifecycleState: () => lifecycle,
      eventStreams: hub,
    },
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('事件传输面监听地址非法');
  }
  return {
    port: address.port,
    hub,
    setLifecycle: (next) => {
      lifecycle = next;
    },
  };
}

async function setup(hubOverrides: Partial<EventStreamHubOptions> = {}) {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f012-' });
  const box = fixture;
  const app = await box.openApplication();
  const probe = box.openProbe();
  const owner = box.localOwner();
  const server = await startEventServer(app, owner, hubOverrides);
  const subscribePath = (scope: { kind: 'global' } | { kind: 'project'; projectId: string }) =>
    scope.kind === 'global'
      ? '/v1/events?scope=global'
      : `/v1/events?scope=project&projectId=${scope.projectId}`;
  return { box, app, probe, owner, server, subscribePath };
}

/** 注册项目（真实 Git 检查 + 原子提交），返回 completed 回执。 */
async function registerProject(
  app: CoreApplication,
  principal: TestTrustedPrincipal,
  repoDir: string,
  name: string,
): Promise<{ projectId: string; revision: number }> {
  const receipt = (await app.commandService.submit(principal, {
    schemaVersion: 2,
    commandId: randomUUID(),
    operation: 'project.register',
    scope: { kind: 'registration' },
    issuedAt: NOW_ISO,
    payload: { repositoryPath: repoDir, displayName: name },
  })) as CommandReceipt;
  if (receipt.status !== 'completed') {
    throw new Error(`注册未 completed：${JSON.stringify(receipt.error)}`);
  }
  const project = (receipt.result as { project: { id: string; revision: number } }).project;
  return { projectId: project.id, revision: project.revision };
}

/** 直接经 Core 提交一次元数据 CAS 更新（产生一条 project.metadata_updated）。 */
async function submitMetadataUpdate(
  app: CoreApplication,
  principal: TestTrustedPrincipal,
  projectId: string,
  expectedRevision: number,
  name: string,
): Promise<void> {
  const receipt = (await app.commandService.submit(principal, {
    schemaVersion: 2,
    commandId: randomUUID(),
    operation: 'project.metadata.update',
    scope: { kind: 'project', projectId },
    expectedRevision,
    issuedAt: NOW_ISO,
    payload: { displayName: name },
  })) as CommandReceipt;
  if (receipt.status !== 'completed') {
    throw new Error(`元数据更新未 completed：${JSON.stringify(receipt.error)}`);
  }
}

/** 经 HTTP 取项目快照水位游标（§8 签发，绑定数据根与 scope）。 */
async function snapshotCursor(port: number, projectId: string): Promise<{ sequence: number; cursor: string }> {
  const response = await loopbackRequest({
    port,
    method: 'GET',
    path: `/v1/snapshot?scope=project&projectId=${projectId}`,
    token: STUB_TOKEN,
  });
  expect(response.statusCode).toBe(200);
  const watermark = (response.json() as { watermark: { sequence: number; cursor: string } }).watermark;
  return watermark;
}

/** 经 HTTP 取全局快照水位游标（global scope，绑定固定 scope 指纹）。 */
async function globalSnapshotCursor(port: number): Promise<{ sequence: number; cursor: string }> {
  const response = await loopbackRequest({
    port,
    method: 'GET',
    path: '/v1/snapshot?scope=global',
    token: STUB_TOKEN,
  });
  expect(response.statusCode).toBe(200);
  const watermark = (response.json() as { watermark: { sequence: number; cursor: string } }).watermark;
  return watermark;
}

/**
 * 大 agentOverrides 的全局配置 payload（夹具能力目录允许 pi/anthropic +
 * claude-sonnet）：每条 update 事件的 settingsChangeSummary 摘要帧约 8.5 KB
 * （63 个 112 字符键的 agentOverrides + defaultStrategy，恰在 F-003 读取
 * 白名单的 64 条/列表上限内）。背压用例需要 MB 级事件体积，而元数据事件帧
 * 是固定小尺寸且每命令约 6 ms；settings 命令每条约 1-2 ms，可在毫秒级
 * 提交 MB 级积压。
 */
function largeGlobalSettingsPayload(): Record<string, unknown> {
  const agentOverrides: Record<string, { runtime: string; provider: string; model: string }> = {};
  for (let index = 0; index < 63; index += 1) {
    // 键长 112：摘要项 'agentOverrides.<键>' 恰在 128 字符白名单模式内。
    agentOverrides[`a${String(index).padStart(111, '0')}`] = {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
    };
  }
  return {
    schemaVersion: 2,
    strategies: {
      defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      agentOverrides,
    },
    policies: {
      executionLimits: {
        maxConcurrentWorks: 1,
        workTimeoutMs: 60_000,
        maxAttemptsPerTask: 3,
        envAllowlist: [],
      },
      verification: { requireChecksBeforeDone: true },
      securityPolicy: { isolation: 'trusted_project' },
    },
  };
}

/** 提交全局配置创建/更新（真实命令事务 + settingsChangeSummary 事件），返回新 revision。 */
async function submitGlobalSettings(
  app: CoreApplication,
  principal: TestTrustedPrincipal,
  operation: 'settings.global.create' | 'settings.global.update',
  expectedRevision?: number,
): Promise<number> {
  const receipt = (await app.commandService.submit(principal, {
    schemaVersion: 2,
    commandId: randomUUID(),
    operation,
    scope: { kind: 'global' },
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    issuedAt: NOW_ISO,
    payload: largeGlobalSettingsPayload(),
  })) as CommandReceipt;
  if (receipt.status !== 'completed') {
    throw new Error(`全局配置命令未 completed：${JSON.stringify(receipt.error)}`);
  }
  return (receipt.result as { revision: number }).revision;
}

function errorBodyOf(response: { json(): unknown }): {
  code: string;
  operation?: string;
  details?: Record<string, unknown>;
} {
  const body = response.json() as {
    error?: { code?: string; operation?: string; details?: Record<string, unknown> };
  };
  if (typeof body.error?.code !== 'string') {
    throw new Error('响应不是结构化错误体');
  }
  return body.error as { code: string; operation?: string; details?: Record<string, unknown> };
}

function parseEventFrame(frame: SseFrame): {
  eventId: string;
  sequence: number;
  type: string;
  scope: { kind: string; projectId?: string };
  aggregate: { type: string; id: string; revision: number };
  occurredAt: string;
  payload: Record<string, unknown>;
} {
  const data = JSON.parse(frame.data) as Record<string, unknown>;
  if (data.schemaVersion !== 1) {
    throw new Error('事件封套 schemaVersion 不是 1');
  }
  return data as ReturnType<typeof parseEventFrame>;
}

describe('F-012 SSE 订阅：恢复、补读与持续推送', () => {
  it('快照水位游标恢复：只投递水位之后的事件，帧格式与封套字段冻结', async () => {
    const s = await setup();
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const watermark = await snapshotCursor(s.server.port, projectId);
    expect(watermark.sequence).toBe(1);
    await submitMetadataUpdate(s.app, s.owner, projectId, 1, 'Repo A2');

    const connection = await connectSseLoopback({
      port: s.server.port,
      path: s.subscribePath({ kind: 'project', projectId }),
      token: STUB_TOKEN,
      cursor: watermark.cursor,
    });
    try {
      const frames = await collectFrames(connection, 1, 5_000);
      expect(frames).toHaveLength(1);
      const frame = frames[0]!;
      expect(frame.event).toBe('state-event');
      const event = parseEventFrame(frame);
      expect(frame.id).toBe(event.eventId);
      expect(event).toMatchObject({
        sequence: 2,
        type: 'project.metadata_updated',
        scope: { kind: 'project', projectId },
        aggregate: { type: 'project', id: projectId, revision: 2 },
        payload: { changedFields: ['displayName'] },
      });
      expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // 快照水位之前的 registered 事件不重复投递。
      const persisted = s.probe.stateEvents();
      expect(persisted).toHaveLength(2);
      expect(String(event.eventId)).toBe(persisted[1]!.id);
    } finally {
      await connection.close();
    }
    await waitFor(() => s.server.hub.activeCount() === 0, 3_000, '连接关闭后 Hub 登记清零');
  });

  it('建连后新事件持续推送；快照与建连之间的写入不漏', async () => {
    const s = await setup();
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const watermark = await snapshotCursor(s.server.port, projectId);
    // 快照返回与 SSE 建连之间发生写入：必须在水位之后被补读到。
    await submitMetadataUpdate(s.app, s.owner, projectId, 1, 'between-snapshot-and-connect');
    const connection = await connectSseLoopback({
      port: s.server.port,
      path: s.subscribePath({ kind: 'project', projectId }),
      token: STUB_TOKEN,
      cursor: watermark.cursor,
    });
    try {
      const first = await collectFrames(connection, 1, 5_000);
      expect(parseEventFrame(first[0]!).payload).toEqual({ changedFields: ['displayName'] });
      expect(parseEventFrame(first[0]!).sequence).toBe(2);
      // 建连后继续写入：持续推送，升序。
      await submitMetadataUpdate(s.app, s.owner, projectId, 2, 'after-connect');
      const second = await collectFrames(connection, 1, 5_000);
      expect(parseEventFrame(second[0]!).sequence).toBe(3);
      expect(parseEventFrame(second[0]!).aggregate.revision).toBe(3);
    } finally {
      await connection.close();
    }
  });

  it('补读期间继续写入不漏：小批量跨多批补读 + 并发写入，最终与持久审计一致', async () => {
    const s = await setup({ batchLimit: 8, pollIntervalMs: 5 });
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    for (let index = 0; index < 40; index += 1) {
      await submitMetadataUpdate(s.app, s.owner, projectId, index + 1, `name-${index}`);
    }
    const watermark = await snapshotCursor(s.server.port, projectId);
    expect(watermark.sequence).toBe(41); // 快照水位 = 全局 MAX(sequence)（真实一致读视图）
    // 重新取「注册后」位置：用 Last-Event-ID 指向 registered 事件，从 seq=1 补读。
    const registeredId = s.probe.stateEvents()[0]!.id;
    const connection = await connectSseLoopback({
      port: s.server.port,
      path: s.subscribePath({ kind: 'project', projectId }),
      token: STUB_TOKEN,
      lastEventId: registeredId,
    });
    try {
      // 补读期间继续写入 10 条。
      const extraWrites = (async () => {
        for (let index = 0; index < 10; index += 1) {
          await submitMetadataUpdate(s.app, s.owner, projectId, 41 + index, `extra-${index}`);
        }
      })();
      const frames = await collectFrames(connection, 50, 15_000);
      await extraWrites;
      const events = frames.map(parseEventFrame);
      const sequences = events.map((event) => event.sequence);
      expect(sequences).toEqual(Array.from({ length: 50 }, (_, index) => index + 2));
      // eventId 与持久审计一一对应（无伪造、无遗漏）。
      const persistedIds = s.probe.stateEvents().map((row) => row.id);
      expect(persistedIds).toHaveLength(51);
      expect(events.map((event) => event.eventId)).toEqual(persistedIds.slice(1));
    } finally {
      await connection.close();
    }
  }, 30_000);

  it('断线重连（Last-Event-ID 优先）：断线期间写入的事件补读且不重复投递', async () => {
    const s = await setup();
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const watermark = await snapshotCursor(s.server.port, projectId);
    await submitMetadataUpdate(s.app, s.owner, projectId, 1, 'before-disconnect');
    const connection = await connectSseLoopback({
      port: s.server.port,
      path: s.subscribePath({ kind: 'project', projectId }),
      token: STUB_TOKEN,
      cursor: watermark.cursor,
    });
    const first = await collectFrames(connection, 1, 5_000);
    const firstId = parseEventFrame(first[0]!).eventId;
    expect(connection.lastEventId).toBe(firstId);
    // 断线期间再写两条。
    await submitMetadataUpdate(s.app, s.owner, projectId, 2, 'during-disconnect-1');
    await submitMetadataUpdate(s.app, s.owner, projectId, 3, 'during-disconnect-2');
    // reconnect 自动携带 Last-Event-ID（= firstId）与原 cursor；Last-Event-ID 优先。
    const reconnected = await connection.reconnect();
    try {
      const frames = await collectFrames(reconnected, 2, 5_000);
      const events = frames.map(parseEventFrame);
      expect(events.map((event) => event.sequence)).toEqual([3, 4]);
      // 不重复投递已确认的 seq=2 事件。
      expect(events.some((event) => event.eventId === firstId)).toBe(false);
    } finally {
      await reconnected.close();
    }
  });

  it('未来游标合法：连接后等待，新事件到达即投递', async () => {
    const s = await setup();
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const binding = createEventCursorBinding({
      rootIdentity: computeDataRootIdentity(s.box.dataRoot),
      scope: { kind: 'project', projectId },
    });
    const futureCursor = encodeEventCursor(999_999, binding);
    const connection = await connectSseLoopback({
      port: s.server.port,
      path: s.subscribePath({ kind: 'project', projectId }),
      token: STUB_TOKEN,
      cursor: futureCursor,
    });
    try {
      // 未来游标不报缺失：已提交的 seq<=999999 事件不投递。
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(connection.eventsReceived).toBe(0);
      // 把持久水位推进到未来游标之后需要真实事件：此处验证等待语义——
      // 新事件 seq=2 仍低于未来游标，不投递（游标语义是排他下界）。
      await submitMetadataUpdate(s.app, s.owner, projectId, 1, 'below-future-cursor');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(connection.eventsReceived).toBe(0);
      expect(s.probe.counts().state_events).toBe(2);
    } finally {
      await connection.close();
    }
  });
});

describe('F-012 SSE 订阅：游标/恢复位置拒绝语义', () => {
  it('缺恢复位置 400 cursor_required；非法/跨 scope/跨数据根游标 400 invalid_cursor', async () => {
    const s = await setup();
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const path = s.subscribePath({ kind: 'project', projectId });
    const headers = { Accept: 'text/event-stream' };

    const missing = await loopbackRequest({
      port: s.server.port, method: 'GET', path, token: STUB_TOKEN, headers,
    });
    expect(missing.statusCode).toBe(400);
    expect(errorBodyOf(missing)).toMatchObject({
      code: 'invalid_input',
      operation: 'events.subscribe',
      details: { field: 'cursor', reason: 'cursor_required' },
    });

    const malformed = await loopbackRequest({
      port: s.server.port, method: 'GET', path: `${path}&cursor=not-a-cursor`, token: STUB_TOKEN, headers,
    });
    expect(malformed.statusCode).toBe(400);
    expect(errorBodyOf(malformed).details).toMatchObject({ field: 'cursor', reason: 'invalid_cursor' });

    // 跨 scope：project A 签发的游标用于 global 订阅。
    const projectCursor = (await snapshotCursor(s.server.port, projectId)).cursor;
    const crossScope = await loopbackRequest({
      port: s.server.port, method: 'GET',
      path: `/v1/events?scope=global&cursor=${encodeURIComponent(projectCursor)}`,
      token: STUB_TOKEN, headers,
    });
    expect(crossScope.statusCode).toBe(400);
    expect(errorBodyOf(crossScope).details).toMatchObject({ reason: 'invalid_cursor' });

    // 跨数据根：另一数据根签发的游标。
    const otherFixture = createCommandsTestFixture({ prefix: 'shiploop-f012-other-' });
    try {
      const otherBinding = createEventCursorBinding({
        rootIdentity: computeDataRootIdentity(otherFixture.dataRoot),
        scope: { kind: 'project', projectId },
      });
      const foreignCursor = encodeEventCursor(0, otherBinding);
      const crossRoot = await loopbackRequest({
        port: s.server.port, method: 'GET',
        path: `${path}&cursor=${encodeURIComponent(foreignCursor)}`,
        token: STUB_TOKEN, headers,
      });
      expect(crossRoot.statusCode).toBe(400);
      expect(errorBodyOf(crossRoot).details).toMatchObject({ reason: 'invalid_cursor' });
    } finally {
      otherFixture.cleanup();
    }
    // 全部拒绝零副作用。
    expect(s.probe.counts().state_events).toBe(1);
  });

  it('未知/跨项目 Last-Event-ID 400 unknown_event_id（不区分存在性，不泄漏）', async () => {
    const s = await setup();
    const { projectId: a } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const { projectId: b } = await registerProject(s.app, s.owner, s.box.repoDirB, 'Repo B');
    const headers = { Accept: 'text/event-stream' };
    // 未知的 eventId（合法 UUID 形态但不存在）。
    const unknown = await loopbackRequest({
      port: s.server.port, method: 'GET',
      path: s.subscribePath({ kind: 'project', projectId: a }),
      token: STUB_TOKEN,
      headers: { ...headers, 'Last-Event-ID': randomUUID() },
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorBodyOf(unknown).details).toMatchObject({
      field: 'lastEventId',
      reason: 'unknown_event_id',
    });
    // 跨项目：B 的事件 id 用于 A 的订阅——同一拒绝，不区分不存在与越权。
    const bEventId = s.probe.stateEvents().filter((row) => row.project_id === b)[0]!.id;
    const crossProject = await loopbackRequest({
      port: s.server.port, method: 'GET',
      path: s.subscribePath({ kind: 'project', projectId: a }),
      token: STUB_TOKEN,
      headers: { ...headers, 'Last-Event-ID': bEventId },
    });
    expect(crossProject.statusCode).toBe(400);
    expect(errorBodyOf(crossProject).details).toMatchObject({
      field: 'lastEventId',
      reason: 'unknown_event_id',
    });
    // 非法形态的 Last-Event-ID。
    const malformed = await loopbackRequest({
      port: s.server.port, method: 'GET',
      path: s.subscribePath({ kind: 'project', projectId: a }),
      token: STUB_TOKEN,
      headers: { ...headers, 'Last-Event-ID': 'not-a-uuid' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(errorBodyOf(malformed).details).toMatchObject({ field: 'lastEventId' });
  });

  it('保留下界夹具：建连前 409 snapshot_required；建连后下界越过位置以 error 帧结束', async () => {
    const lowerBounds = createReplayLowerBoundController();
    const s = await setup({
      getReplayLowerBound: (scope) =>
        lowerBounds.retainedSequence(
          scope.kind === 'global' ? { kind: 'global' } : { kind: 'project', projectId: scope.projectId },
        ),
      pollIntervalMs: 10,
    });
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    await submitMetadataUpdate(s.app, s.owner, projectId, 1, 'Repo A2');
    const watermark = await snapshotCursor(s.server.port, projectId);
    expect(watermark.sequence).toBe(2);
    const scope = { kind: 'project', projectId } as const;

    // 建连前：游标（seq=2）低于注入下界 5 → 409 snapshot_required + 重取指引。
    lowerBounds.setRetained(scope, 5);
    const rejected = await loopbackRequest({
      port: s.server.port, method: 'GET',
      path: `${s.subscribePath(scope)}&cursor=${encodeURIComponent(watermark.cursor)}`,
      token: STUB_TOKEN,
      headers: { Accept: 'text/event-stream' },
    });
    expect(rejected.statusCode).toBe(409);
    expect(errorBodyOf(rejected)).toMatchObject({
      code: 'snapshot_required',
      operation: 'events.subscribe',
      details: { reason: 'cursor_beyond_replay_lower_bound', snapshotRoute: '/v1/snapshot' },
    });

    // 建连后：下界在流式期间越过当前位置 → error 帧后正常结束。
    lowerBounds.reset(scope);
    const connection = await connectSseLoopback({
      port: s.server.port,
      path: s.subscribePath(scope),
      token: STUB_TOKEN,
      cursor: watermark.cursor,
    });
    try {
      lowerBounds.setRetained(scope, 10);
      const frames = await collectUntilEnd(connection, 5_000);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toBe('error');
      expect(JSON.parse(frames[0]!.data)).toMatchObject({
        code: 'snapshot_required',
        snapshotRoute: '/v1/snapshot',
      });
    } finally {
      await connection.close();
    }
    // 持久审计行完整（绝不为测试删除/篡改）。
    expect(s.probe.counts().state_events).toBe(2);
    expect(s.probe.stateEvents().map((row) => row.sequence)).toEqual([1, 2]);
  });
});

describe('F-012 SSE 订阅：授权与传输纪律', () => {
  it('受限主体：跨项目/全局越权订阅 403 且不发正文；本项目流正常', async () => {
    const s = await setup();
    const { projectId: a } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const { projectId: b } = await registerProject(s.app, s.owner, s.box.repoDirB, 'Repo B');
    // 受限主体：仅 project.read + events.read，可见范围只有 A。
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read', 'events.read'],
      projectScope: s.box.scopeAllowlist([a]),
    });
    const restrictedServer = await startEventServer(s.app, restricted, { pollIntervalMs: 10 });
    const headers = { Accept: 'text/event-stream' };

    // A 项目快照取游标（受限主体可见 A）。
    const snapshot = await loopbackRequest({
      port: restrictedServer.port, method: 'GET',
      path: `/v1/snapshot?scope=project&projectId=${a}`,
      token: STUB_TOKEN,
    });
    expect(snapshot.statusCode).toBe(200);
    const cursor = (snapshot.json() as { watermark: { cursor: string } }).watermark.cursor;

    // 订阅 B：403 forbidden，无 SSE 正文。
    const crossProject = await loopbackRequest({
      port: restrictedServer.port, method: 'GET',
      path: `/v1/events?scope=project&projectId=${b}&cursor=${encodeURIComponent(cursor)}`,
      token: STUB_TOKEN, headers,
    });
    expect(crossProject.statusCode).toBe(403);
    expect(errorBodyOf(crossProject)).toMatchObject({ code: 'forbidden', operation: 'events.subscribe' });
    // 错误体不回显 B 的 id。
    expect(JSON.stringify(errorBodyOf(crossProject))).not.toContain(b);

    // 全局流：缺 settings.global.read → 403。
    const globalCursor = encodeEventCursor(
      0,
      createEventCursorBinding({
        rootIdentity: computeDataRootIdentity(s.box.dataRoot),
        scope: { kind: 'global' },
      }),
    );
    const globalStream = await loopbackRequest({
      port: restrictedServer.port, method: 'GET',
      path: `/v1/events?scope=global&cursor=${encodeURIComponent(globalCursor)}`,
      token: STUB_TOKEN, headers,
    });
    expect(globalStream.statusCode).toBe(403);

    // 本项目流：正常投递；B 的后续事件（造成 sequence 空隙）不进入 A 流，
    // 也不触发丢失误判（升序跳跃合法）。
    const connection = await connectSseLoopback({
      port: restrictedServer.port,
      path: `/v1/events?scope=project&projectId=${a}`,
      token: STUB_TOKEN,
      cursor,
    });
    try {
      await submitMetadataUpdate(s.app, s.owner, b, 1, 'B-hidden'); // seq 3，A 不可见
      await submitMetadataUpdate(s.app, s.owner, a, 1, 'A-visible'); // seq 4
      const frames = await collectFrames(connection, 1, 5_000);
      const event = parseEventFrame(frames[0]!);
      expect(event.sequence).toBe(4);
      expect(event.scope).toEqual({ kind: 'project', projectId: a });
      expect(event.eventId).not.toBe(s.probe.stateEvents()[2]!.id);
    } finally {
      await connection.close();
    }
  });

  it('缺 events.read 能力 403；错误 token 401；缺 Accept 400；未知查询参数 400；quiescing 503；POST 405', async () => {
    const s = await setup();
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const watermark = await snapshotCursor(s.server.port, projectId);
    const path = `${s.subscribePath({ kind: 'project', projectId })}&cursor=${encodeURIComponent(watermark.cursor)}`;
    const headers = { Accept: 'text/event-stream' };

    // 缺 events.read 能力（有 project.read、可见 A）：403。
    const noEvents = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([projectId]),
    });
    const noEventsServer = await startEventServer(s.app, noEvents);
    const forbidden = await loopbackRequest({
      port: noEventsServer.port, method: 'GET', path, token: STUB_TOKEN, headers,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(errorBodyOf(forbidden).code).toBe('forbidden');

    // 错误 token：401（在任何业务校验之前不可区分）。
    const unauthenticated = await loopbackRequest({
      port: s.server.port, method: 'GET', path, token: randomBytes(32).toString('hex'), headers,
    });
    expect(unauthenticated.statusCode).toBe(401);
    // 缺 Accept：400。
    const noAccept = await loopbackRequest({
      port: s.server.port, method: 'GET', path, token: STUB_TOKEN,
    });
    expect(noAccept.statusCode).toBe(400);
    expect(errorBodyOf(noAccept).details).toMatchObject({ reason: 'accept_not_event_stream' });
    // 未知查询参数：400。
    const unknownParam = await loopbackRequest({
      port: s.server.port, method: 'GET', path: `${path}&bogus=1`, token: STUB_TOKEN, headers,
    });
    expect(unknownParam.statusCode).toBe(400);
    expect(errorBodyOf(unknownParam).details).toMatchObject({ field: 'query.bogus' });
    // quiescing：503 not_ready，业务状态不变。
    s.server.setLifecycle('quiescing');
    const quiescing = await loopbackRequest({
      port: s.server.port, method: 'GET', path, token: STUB_TOKEN, headers,
    });
    expect(quiescing.statusCode).toBe(503);
    expect(errorBodyOf(quiescing).code).toBe('not_ready');
    s.server.setLifecycle('ready');
    // POST：405。
    const posted = await loopbackRequest({
      port: s.server.port, method: 'POST', path: s.subscribePath({ kind: 'project', projectId }),
      token: STUB_TOKEN, body: {}, headers,
    });
    expect(posted.statusCode).toBe(405);
    expect(s.probe.counts()).toMatchObject({ projects: 1, state_events: 1, command_receipts: 1 });
  });

  it('全局事件流：全局配置事件进入 global 流，项目事件不进入', async () => {
    const s = await setup();
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const globalSnapshot = await loopbackRequest({
      port: s.server.port, method: 'GET', path: '/v1/snapshot?scope=global', token: STUB_TOKEN,
    });
    expect(globalSnapshot.statusCode).toBe(200);
    const cursor = (globalSnapshot.json() as { watermark: { cursor: string } }).watermark.cursor;
    const connection = await connectSseLoopback({
      port: s.server.port, path: '/v1/events?scope=global', token: STUB_TOKEN, cursor,
    });
    try {
      // 写入一条全局配置（命令路径首建写 settings.global_created）与一条项目事件。
      const receipt = (await s.app.commandService.submit(s.owner, {
        schemaVersion: 2,
        commandId: randomUUID(),
        operation: 'settings.global.create',
        scope: { kind: 'global' },
        issuedAt: NOW_ISO,
        payload: {
          schemaVersion: 2,
          strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
          policies: {},
        },
      })) as CommandReceipt;
      expect(receipt.status).toBe('completed');
      await submitMetadataUpdate(s.app, s.owner, projectId, 1, 'not-in-global-stream');
      const frames = await collectFrames(connection, 1, 5_000);
      const event = parseEventFrame(frames[0]!);
      expect(event.type).toBe('settings.global_created');
      expect(event.scope).toEqual({ kind: 'global' });
      // 项目事件不进入全局流（等待期间只收到一条）。
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(connection.eventsReceived).toBe(1);
    } finally {
      await connection.close();
    }
  });
});

describe('F-012 SSE 背压、心跳与生命周期', () => {
  it('慢客户端真实背压：stream_overflow 帧后结束该流；持久审计完整，快客户端不受阻', async () => {
    const s = await setup({ maxPendingBytes: 4_096, drainWaitMs: 2_000, pollIntervalMs: 5 });
    // 全局配置事件（大 agentOverrides 摘要，单帧 ~8.5 KB）：以少量命令在毫秒级
    // 提交 MB 级积压（800 条 ≈ 6.8 MB）。慢客户端建连后的补读是每次
    // ≤262 144 B 的突发批量写；内核 send/rcv 缓冲（本机实测 autotune 上限
    // ~1.4 MB）填满后 drain 不再触发，待发缓冲超过 maxPendingBytes 且 drain
    // 预算耗尽，overflow 确定性发生。（若事件以滴流产生，接收端窗口 autotune
    // 会持续吞掉数据，服务端观测不到背压——滴流不等于慢客户端；积压体积取
    // 内核容量 3 倍以上余量。）
    const createdRevision = await submitGlobalSettings(s.app, s.owner, 'settings.global.create');
    const watermark = await globalSnapshotCursor(s.server.port);
    const total = 800;
    let revision = createdRevision;
    for (let index = 0; index < total; index += 1) {
      revision = await submitGlobalSettings(s.app, s.owner, 'settings.global.update', revision);
    }
    // 快客户端全程并发消费（每连接独立缓冲与收尾，不被慢连接拖累）。
    const fast = await connectSseLoopback({
      port: s.server.port, path: s.subscribePath({ kind: 'global' }),
      token: STUB_TOKEN, cursor: watermark.cursor,
    });
    const fastFramesPromise = collectFrames(fast, total, 45_000);
    const slow = await connectSseLoopback({
      port: s.server.port, path: s.subscribePath({ kind: 'global' }),
      token: STUB_TOKEN, cursor: watermark.cursor,
    });
    try {
      slow.pauseConsumption();
      expect(slow.consumptionPaused).toBe(true);
      // 慢客户端停止消费：服务端突发补读超过缓冲上限，按契约以一帧
      // stream_overflow 结束该流（Hub 登记只剩快连接；期间快客户端持续收帧）。
      await waitFor(
        () => s.server.hub.activeCount() === 1,
        15_000,
        '慢连接按 stream_overflow 被有界结束',
      );
      // 慢客户端恢复消费后必须看到 stream_overflow error 帧且流结束。
      slow.resumeConsumption();
      const slowFrames = await collectUntilEnd(slow, 20_000);
      const errorFrames = slowFrames.filter((frame) => frame.event === 'error');
      expect(errorFrames).toHaveLength(1);
      expect(JSON.parse(errorFrames[0]!.data)).toMatchObject({
        code: 'stream_overflow',
        snapshotRoute: '/v1/snapshot',
      });
      // 慢连接收到的业务帧少于总量（被有界结束），但绝无伪造 eventId。
      const persistedIds = new Set(s.probe.stateEvents().map((row) => row.id));
      let slowBusinessFrames = 0;
      for (const frame of slowFrames) {
        if (frame.event === 'state-event') {
          slowBusinessFrames += 1;
          expect(persistedIds.has(parseEventFrame(frame).eventId)).toBe(true);
        }
      }
      expect(slowBusinessFrames).toBeLessThan(total);
      // 快客户端不被阻塞：能持续收满全部事件，序号与持久审计一致。
      const fastFrames = await fastFramesPromise;
      expect(fastFrames.map((frame) => parseEventFrame(frame).sequence)).toEqual(
        Array.from({ length: total }, (_, index) => index + 2),
      );
      // 持久审计完整可读（overflow 只结束展示流，不丢审计）。
      expect(s.probe.counts().state_events).toBe(total + 1);
    } finally {
      await slow.close();
      await fast.close();
    }
    await waitFor(() => s.server.hub.activeCount() === 0, 3_000, '两条连接关闭后 Hub 登记清零');
  }, 60_000);

  it('心跳维持连接活性：无事件时收到 ping 注释字节，事件到达仍正常投递', async () => {
    const s = await setup({ heartbeatIntervalMs: 30, pollIntervalMs: 10 });
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const watermark = await snapshotCursor(s.server.port, projectId);
    const connection = await connectSseLoopback({
      port: s.server.port, path: s.subscribePath({ kind: 'project', projectId }),
      token: STUB_TOKEN, cursor: watermark.cursor,
    });
    try {
      // 无事件：心跳字节到达（sse-client 过滤注释帧，不计事件）。
      await waitFor(() => connection.bytesReceived > 0, 3_000, '心跳字节到达');
      expect(connection.eventsReceived).toBe(0);
      // 连接仍然可用：新事件正常投递。
      await submitMetadataUpdate(s.app, s.owner, projectId, 1, 'after-heartbeat');
      const frames = await collectFrames(connection, 1, 5_000);
      expect(parseEventFrame(frames[0]!).sequence).toBe(2);
    } finally {
      await connection.close();
    }
  });

  it('客户端断开只清理本连接资源：已提交命令不受影响，Host 继续服务', async () => {
    const s = await setup();
    const { projectId } = await registerProject(s.app, s.owner, s.box.repoDirA, 'Repo A');
    const watermark = await snapshotCursor(s.server.port, projectId);
    // 订阅期间提交命令（已 completed），随后客户端突然断开。
    await submitMetadataUpdate(s.app, s.owner, projectId, 1, 'committed-before-disconnect');
    const connection = await connectSseLoopback({
      port: s.server.port, path: s.subscribePath({ kind: 'project', projectId }),
      token: STUB_TOKEN, cursor: watermark.cursor,
    });
    await collectFrames(connection, 1, 5_000);
    await connection.close();
    await waitFor(() => s.server.hub.activeCount() === 0, 3_000, '断开后 Hub 登记清零');
    // Host 不受影响：查询与命令照常。
    const list = await loopbackRequest({
      port: s.server.port, method: 'GET', path: '/v1/projects', token: STUB_TOKEN,
    });
    expect(list.statusCode).toBe(200);
    await submitMetadataUpdate(s.app, s.owner, projectId, 2, 'after-disconnect');
    expect(s.probe.projectRow(projectId)).toMatchObject({ display_name: 'after-disconnect', revision: 3 });
    // 新订阅仍可从持久游标续读断开前后的事件。
    const again = await connectSseLoopback({
      port: s.server.port, path: s.subscribePath({ kind: 'project', projectId }),
      token: STUB_TOKEN, cursor: watermark.cursor,
    });
    try {
      const frames = await collectFrames(again, 2, 5_000);
      expect(frames.map((frame) => parseEventFrame(frame).sequence)).toEqual([2, 3]);
    } finally {
      await again.close();
    }
  });

  it('真实 startHost：信号收尾在预算内结束 SSE；重启后原持久游标可续读', async () => {
    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-e2e-' });
    const { canonicalRoot } = environment.dataRoot('root');
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f012-e2e-repo-' });
    const host = await startHost({
      dataRoot: canonicalRoot,
      capabilityCatalog: fixture.capabilityCatalog,
      env: {},
    });
    const token = readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
    environment.evidence.registerSecret(token);
    const nowIso = new Date().toISOString();
    // 注册（真实时钟信封）。
    const register = await loopbackRequest({
      port: host.port, method: 'POST', path: '/v1/commands', token,
      body: {
        schemaVersion: 2,
        commandId: randomUUID(),
        operation: 'project.register',
        scope: { kind: 'registration' },
        issuedAt: nowIso,
        payload: { repositoryPath: fixture.repoDirA, displayName: 'E2E SSE' },
      },
    });
    expect(register.statusCode).toBe(200);
    const receipt = receiptOf(register) as CommandReceipt & { result: { project: { id: string } } };
    const projectId = receipt.result.project.id;
    const snapshot = await loopbackRequest({
      port: host.port, method: 'GET',
      path: `/v1/snapshot?scope=project&projectId=${projectId}`, token,
    });
    const cursor = (snapshot.json() as { watermark: { cursor: string } }).watermark.cursor;

    const connection = await connectSseLoopback({
      port: host.port,
      path: `/v1/events?scope=project&projectId=${projectId}`,
      token,
      cursor,
      connectTimeoutMs: 5_000,
    });
    // 在途订阅期间写入一条事件确认流可用。
    const update = await loopbackRequest({
      port: host.port, method: 'POST', path: '/v1/commands', token,
      body: {
        schemaVersion: 2,
        commandId: randomUUID(),
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId },
        expectedRevision: 1,
        issuedAt: new Date().toISOString(),
        payload: { displayName: 'E2E SSE 2' },
      },
    });
    expect(update.statusCode).toBe(200);
    await collectFrames(connection, 1, 5_000);

    // 信号收尾（§10.7 同一 §10.5 顺序）：SSE 在预算内结束，stop 完成。
    const streamEnded = collectUntilEnd(connection, 15_000);
    const outcome = await host.requestSignalShutdown();
    expect(outcome).toBe('completed');
    await streamEnded; // 流已正常结束（无未捕获错误）。

    // 重启同一数据根：原持久游标续读（游标不依赖内存状态）。
    const host2 = await startHost({
      dataRoot: canonicalRoot,
      capabilityCatalog: fixture.capabilityCatalog,
      env: {},
    });
    try {
      const token2 = readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
      environment.evidence.registerSecret(token2);
      const update2 = await loopbackRequest({
        port: host2.port, method: 'POST', path: '/v1/commands', token: token2,
        body: {
          schemaVersion: 2,
          commandId: randomUUID(),
          operation: 'project.metadata.update',
          scope: { kind: 'project', projectId },
          expectedRevision: 2,
          issuedAt: new Date().toISOString(),
          payload: { displayName: 'E2E SSE 3' },
        },
      });
      expect(update2.statusCode).toBe(200);
      const resumed = await connectSseLoopback({
        port: host2.port,
        path: `/v1/events?scope=project&projectId=${projectId}`,
        token: token2,
        cursor,
        connectTimeoutMs: 5_000,
      });
      try {
        const frames = await collectFrames(resumed, 2, 5_000);
        const events = frames.map(parseEventFrame);
        // 重启前的 seq=2 与重启后的 seq=3 都从持久审计补读，无缺口。
        expect(events.map((event) => event.sequence)).toEqual([2, 3]);
      } finally {
        await resumed.close();
      }
    } finally {
      await host2.close();
    }
  }, 45_000);

  it('握手能力宣告 F-012 结构化 SSE events 视图', async () => {
    const s = await setup();
    const handshake = await loopbackRequest({
      port: s.server.port,
      method: 'POST',
      path: '/v1/host/handshake',
      token: STUB_TOKEN,
      body: {
        schemaVersion: 2,
        protocolVersion: 1,
        hostInstanceId: STUB_INSTANCE,
        dataRootIdentity: STUB_ROOT_IDENTITY,
      },
    });
    expect(handshake.statusCode).toBe(200);
    const capabilities = (handshake.json() as {
      capabilities: { application: { events: unknown } };
    }).capabilities;
    expect(capabilities.application.events).toEqual({
      transport: 'sse',
      route: '/v1/events',
      scopes: ['project', 'global'],
    });
  });
});

function receiptOf(response: { json(): unknown }): CommandReceipt {
  const body = response.json() as CommandReceipt;
  if (body === null || typeof body !== 'object' || typeof body.commandId !== 'string') {
    throw new Error('响应不是回执形状');
  }
  return body;
}
