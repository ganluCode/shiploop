/**
 * F-017 CLI 事件观察分支验收（契约 §9.4/§12.2/§12.3）——真实 `runAppCli` 执行层 +
 * 真实 HTTP 可编排对端（与 F-013 客户端分支测试同一夹具形态：真实发现/凭据/握手，
 * 应用路由响应由脚本编排）。
 *
 * 覆盖真实 Host 生产装配不可达的分支（生产可续读下界恒 0，§9.4 注入缝仅在受控
 * 装配）：
 * - 建连前 409 snapshot_required 与建连后 error 帧：明确输出 snapshot_required 记录、
 *   按契约重取快照并以新水位游标恢复，不默默丢历史事件；
 * - 连续 snapshot_required 超过有限重载预算 → exit 1（不无限循环）；
 * - stream_overflow 帧 → exit 4，终态记录含 snapshotRoute 与最后游标，不重取快照；
 * - 断线期间写入：自动重连以 Last-Event-ID 续读，重复事件按 eventId 去重；
 * - 重连预算耗尽 → exit 3（unreachable）；畸形事件帧 → exit 3（response_malformed）；
 * - snapshot-only 经可编排对端补读一页后退出（exit 0），观察到事件时重取快照；
 * - 观察预算注入校验在任何网络/发现之前拒绝（exit 2）。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../packages/cli/src/app-execute.ts';
import {
  CURRENT_HOST_CAPABILITIES,
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  HANDSHAKE_ROUTE,
} from '../packages/host/src/index.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
} from './helpers/host/index.ts';

/* ------------------------------------------------------------------ *
 * 可编排应用面对端（真实 node:http 回环监听；仅测试）
 * ------------------------------------------------------------------ */

type ScriptedResponse =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'drop' }
  | {
      kind: 'sse';
      frames: string[];
      /** keepOpen=true 时保持连接；closeAfterMs 后主动结束响应（模拟断线）。 */
      keepOpen?: boolean;
      closeAfterMs?: number;
    };

interface ScriptedObservation {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly lastEventId?: string;
}

interface ScriptedServer {
  readonly port: number;
  readonly requests: ScriptedObservation[];
  setScript(handler: (observation: ScriptedObservation) => ScriptedResponse): void;
  close(): Promise<void>;
}

async function startScriptedServer(identity: {
  hostInstanceId: string;
  dataRootIdentity: string;
}): Promise<ScriptedServer> {
  const observations: ScriptedObservation[] = [];
  let script: (observation: ScriptedObservation) => ScriptedResponse = () => ({
    kind: 'json',
    status: 404,
    body: { error: { code: 'unknown_operation', message: 'x' } },
  });
  let seq = 0;
  let closed = false;
  const pendingTimers = new Set<NodeJS.Timeout>();

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seq += 1;
    const url = request.url ?? '/';
    const queryIndex = url.indexOf('?');
    const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : url.slice(queryIndex + 1);
    const lastEventId = request.headers['last-event-id'];
    const observation: ScriptedObservation = {
      seq,
      method: request.method ?? '',
      path,
      query,
      ...(typeof lastEventId === 'string' ? { lastEventId } : {}),
    };
    observations.push(observation);

    if (path === HANDSHAKE_ROUTE) {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(
        JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          hostInstanceId: identity.hostInstanceId,
          dataRootIdentity: identity.dataRootIdentity,
          lifecycleState: 'ready',
          startedAt: new Date().toISOString(),
          capabilities: CURRENT_HOST_CAPABILITIES,
        }),
      );
      return;
    }

    void request.resume();
    const behavior = script(observation);
    if (behavior.kind === 'json') {
      response.writeHead(behavior.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(behavior.body));
      return;
    }
    if (behavior.kind === 'drop') {
      response.destroy();
      request.socket.destroy();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
    });
    // writeHead 只排队头部：零帧场景必须显式冲刷，否则客户端等不到响应头
    // （与生产 sse-transport 的 flushHeaders 同一纪律）。
    response.flushHeaders();
    for (const frame of behavior.frames) {
      response.write(frame);
    }
    if (behavior.keepOpen === true) {
      if (behavior.closeAfterMs !== undefined) {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          response.end();
        }, behavior.closeAfterMs);
        pendingTimers.add(timer);
      }
      return;
    }
    response.end();
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests: observations,
    setScript(handler) {
      script = handler;
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * 线协议构造（快照/事件/错误体）
 * ------------------------------------------------------------------ */

const OLD_CURSOR = 'evcur_v1_b2xkLXN0YWxl';
const NEW_CURSOR = 'evcur_v1_bmV3LXJlbG9hZA';
const FINAL_CURSOR = 'evcur_v1_ZmluYWwtcg';

function globalSnapshot(sequence: number, cursor: string): Record<string, unknown> {
  return {
    schemaVersion: 3,
    scope: { kind: 'global' },
    settings: null,
    watermark: { sequence, cursor },
    readAt: new Date().toISOString(),
  };
}

function globalUpdatedEvent(sequence: number, eventId: string = randomUUID()): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId,
    sequence,
    type: 'settings.global_updated',
    scope: { kind: 'global' },
    aggregate: { type: 'global_settings', id: 'global', revision: sequence },
    occurredAt: new Date().toISOString(),
    payload: { schemaVersion: 2, strategies: [], policies: ['executionLimits'] },
  };
}

function sseEventFrame(event: Record<string, unknown>): string {
  return `id: ${String(event.eventId)}\nevent: state-event\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseErrorFrame(payload: Record<string, unknown>): string {
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
}

function snapshotRequiredBody(): Record<string, unknown> {
  return {
    error: {
      code: 'snapshot_required',
      message: '游标低于可续读下界',
      operation: 'events.subscribe',
      details: { reason: 'cursor_beyond_replay_lower_bound', snapshotRoute: '/v1/snapshot' },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 驱动 runAppCli（真实执行层；发现指向可编排对端）
 * ------------------------------------------------------------------ */

interface ObserveRecord {
  ok: boolean;
  command: string | null;
  result?: { kind?: string } & Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function parseRecords(stdout: string): ObserveRecord[] {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return [];
  }
  return trimmed.split('\n').map((line) => JSON.parse(line) as ObserveRecord);
}

function recordKinds(records: ObserveRecord[]): string[] {
  return records.map((record) =>
    record.ok ? String(record.result?.kind) : `error:${String(record.error?.code)}`,
  );
}

async function waitForCondition(check: () => boolean, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`条件在 ${budgetMs}ms 预算内未满足`);
    }
    await delay(50);
  }
}

describe('F-017 CLI 事件观察：snapshot_required/溢出/断线续读分支（可编排对端）', () => {
  let env: IsolatedHostEnvironment;
  let server: ScriptedServer;
  let dataRoot: string;

  beforeEach(async () => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f017-scripted-' });
    const root = env.dataRoot('app');
    dataRoot = root.canonicalRoot;
    const credential = env.mintHostCredential(dataRoot);
    server = await startScriptedServer({
      hostInstanceId: credential.hostInstanceId,
      dataRootIdentity: credential.dataRootIdentity,
    });
    env.publishLoopbackDiscovery({
      canonicalRoot: dataRoot,
      port: server.port,
      hostInstanceId: credential.hostInstanceId,
      store: credential.store,
      token: credential.token,
    });
  });

  afterEach(async () => {
    await server.close();
    await env.dispose();
  });

  interface StartedRun {
    readonly promise: Promise<{ result: AppCliRunResult; stdout: string; stderr: string }>;
    readonly stdout: () => string;
    readonly stderr: () => string;
  }

  function startObserve(
    args: readonly string[],
    options: {
      signal?: AbortSignal;
      observe?: { quietMs?: number; drainBudgetMs?: number; maxSnapshotReloads?: number };
    } = {},
  ): StartedRun {
    let stdout = '';
    let stderr = '';
    const io: AppCliIo = {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    };
    const promise = runAppCli({
      args: [...args, '--data-root', dataRoot, '--json'],
      io,
      env: env.childEnv(),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.observe !== undefined ? { observe: options.observe } : {}),
    }).then((result) => ({ result, stdout, stderr }));
    return { promise, stdout: () => stdout, stderr: () => stderr };
  }

  function eventsRequests(): ScriptedObservation[] {
    return server.requests.filter((request) => request.path === '/v1/events');
  }

  function snapshotRequests(): ScriptedObservation[] {
    return server.requests.filter((request) => request.path === '/v1/snapshot');
  }

  it('建连前 409 snapshot_required：输出明确记录、重取快照后以新水位游标恢复', async () => {
    const event = globalUpdatedEvent(8);
    server.setScript((obs) => {
      if (obs.path === '/v1/snapshot') {
        return { kind: 'json', status: 200, body: globalSnapshot(7, NEW_CURSOR) };
      }
      if (obs.query.includes(`cursor=${OLD_CURSOR}`)) {
        return { kind: 'json', status: 409, body: snapshotRequiredBody() };
      }
      return { kind: 'sse', frames: [sseEventFrame(event)], keepOpen: true };
    });

    const controller = new AbortController();
    const run = startObserve(['events', '--global', '--cursor', OLD_CURSOR], {
      signal: controller.signal,
    });
    await waitForCondition(() => run.stdout().includes('settings.global_updated'));
    controller.abort();
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(4);
    const records = parseRecords(invocation.stdout);
    expect(recordKinds(records)).toEqual([
      'snapshot_required',
      'snapshot',
      'event',
      'error:observation_interrupted',
    ]);
    // snapshot_required 记录含重取快照指引；恢复快照的水位是新游标。
    expect((records[0]?.result as Record<string, unknown>).snapshotRoute).toBe('/v1/snapshot');
    const reloaded = records[1]?.result?.snapshot as { watermark: { sequence: number } };
    expect(reloaded.watermark.sequence).toBe(7);
    const observed = records[2]?.result?.event as { eventId: string; sequence: number };
    expect(observed.eventId).toBe(event.eventId);
    expect(observed.sequence).toBe(8);

    // 请求序列：旧游标订阅被拒 → 重取快照 → 新水位游标重新订阅。
    const subscriptions = eventsRequests();
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]?.query).toContain(`cursor=${OLD_CURSOR}`);
    expect(subscriptions[1]?.query).toContain(`cursor=${NEW_CURSOR}`);
    expect(snapshotRequests()).toHaveLength(1);
  });

  it('建连后 snapshot_required error 帧：同样走重取快照恢复分支', async () => {
    const event = globalUpdatedEvent(9);
    server.setScript((obs) => {
      if (obs.path === '/v1/snapshot') {
        return { kind: 'json', status: 200, body: globalSnapshot(8, NEW_CURSOR) };
      }
      if (obs.query.includes(`cursor=${OLD_CURSOR}`)) {
        return {
          kind: 'sse',
          frames: [sseErrorFrame({ code: 'snapshot_required', snapshotRoute: '/v1/snapshot' })],
        };
      }
      return { kind: 'sse', frames: [sseEventFrame(event)], keepOpen: true };
    });

    const controller = new AbortController();
    const run = startObserve(['events', '--global', '--cursor', OLD_CURSOR], {
      signal: controller.signal,
    });
    await waitForCondition(() => run.stdout().includes('settings.global_updated'));
    controller.abort();
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(4);
    expect(recordKinds(parseRecords(invocation.stdout))).toEqual([
      'snapshot_required',
      'snapshot',
      'event',
      'error:observation_interrupted',
    ]);
    const subscriptions = eventsRequests();
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]?.query).toContain(`cursor=${NEW_CURSOR}`);
  });

  it('连续 snapshot_required 超过有限重载预算：exit 1，不无限循环', async () => {
    server.setScript((obs) => {
      if (obs.path === '/v1/snapshot') {
        return { kind: 'json', status: 200, body: globalSnapshot(7, NEW_CURSOR) };
      }
      return { kind: 'json', status: 409, body: snapshotRequiredBody() };
    });

    const run = startObserve(['events', '--global', '--cursor', OLD_CURSOR], {
      observe: { maxSnapshotReloads: 2 },
    });
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(1);
    const records = parseRecords(invocation.stdout);
    expect(recordKinds(records)).toEqual([
      'snapshot_required',
      'snapshot',
      'snapshot_required',
      'snapshot',
      'error:snapshot_required',
    ]);
    // 1 次初始订阅 + 2 次重载订阅，随后终止（预算有界）。
    expect(eventsRequests()).toHaveLength(3);
    expect(snapshotRequests()).toHaveLength(2);
  });

  it('stream_overflow 帧：exit 4，终态记录含 snapshotRoute 与最后游标，不重取快照', async () => {
    const event = globalUpdatedEvent(6);
    server.setScript(() => ({
      kind: 'sse',
      frames: [
        sseEventFrame(event),
        sseErrorFrame({ code: 'stream_overflow', snapshotRoute: '/v1/snapshot' }),
      ],
    }));

    const run = startObserve(['events', '--global', '--cursor', OLD_CURSOR]);
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(4);
    const records = parseRecords(invocation.stdout);
    expect(recordKinds(records)).toEqual(['event', 'error:stream_overflow']);
    const terminal = records.at(-1);
    expect(terminal?.error?.details?.snapshotRoute).toBe('/v1/snapshot');
    expect(terminal?.error?.details?.cursor).toBe(OLD_CURSOR);
    expect(terminal?.error?.details?.lastEventId).toBe(event.eventId);
    // 不默默重取快照/续读：只有 1 次订阅、0 次快照请求。
    expect(eventsRequests()).toHaveLength(1);
    expect(snapshotRequests()).toHaveLength(0);
  });

  it('断线期间写入：自动重连以 Last-Event-ID 续读，重复事件按 eventId 去重', async () => {
    const first = globalUpdatedEvent(6);
    const second = globalUpdatedEvent(7);
    server.setScript((obs) => {
      if (obs.lastEventId === undefined) {
        // 首次连接：投递 first 后 150ms 断线（模拟断线期间产生 second）。
        return {
          kind: 'sse',
          frames: [sseEventFrame(first)],
          keepOpen: true,
          closeAfterMs: 150,
        };
      }
      // 重连：重复投递 first（至少一次语义）+ 断线期间的 second。
      return {
        kind: 'sse',
        frames: [sseEventFrame(first), sseEventFrame(second)],
        keepOpen: true,
      };
    });

    const controller = new AbortController();
    const run = startObserve(['events', '--global', '--cursor', OLD_CURSOR], {
      signal: controller.signal,
    });
    await waitForCondition(() => run.stdout().includes(`"sequence":7`));
    controller.abort();
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(4);
    const eventRecords = parseRecords(invocation.stdout).filter(
      (record) => record.result?.kind === 'event',
    );
    // first 重复帧被去重：恰两条事件记录，序列 6、7 各一次。
    expect(eventRecords.map((record) => (record.result?.event as { sequence: number }).sequence)).toEqual([6, 7]);

    const subscriptions = eventsRequests();
    expect(subscriptions.length).toBeGreaterThanOrEqual(2);
    // 断线续读：Last-Event-ID 优先（首事件的 eventId），不带 cursor。
    expect(subscriptions[1]?.lastEventId).toBe(first.eventId);
    expect(subscriptions[1]?.query).not.toContain('cursor=');
  });

  it('重连预算耗尽：exit 3（unreachable），终态记录保留断开原因', async () => {
    server.setScript((obs) => {
      if (obs.lastEventId === undefined && eventsRequests().length <= 1) {
        return { kind: 'sse', frames: [], keepOpen: true, closeAfterMs: 100 };
      }
      return { kind: 'drop' };
    });

    const run = startObserve(['events', '--global', '--cursor', OLD_CURSOR]);
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(3);
    const records = parseRecords(invocation.stdout);
    const terminal = records.at(-1);
    expect(terminal?.ok).toBe(false);
    expect(terminal?.error?.code).toBe('unreachable');
    expect(terminal?.error?.details?.reason).toBe('reconnect_budget_exhausted');
    // 有限重连：1 次初始连接 + 5 次重连（F-013 冻结预算）。
    expect(eventsRequests()).toHaveLength(6);
  });

  it('畸形事件帧：exit 3（response_malformed），不投递也不重连', async () => {
    server.setScript(() => ({
      kind: 'sse',
      frames: ['event: state-event\ndata: {not-json\n\n'],
    }));

    const run = startObserve(['events', '--global', '--cursor', OLD_CURSOR]);
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(3);
    const records = parseRecords(invocation.stdout);
    const terminal = records.at(-1);
    expect(terminal?.error?.code).toBe('response_malformed');
    expect(terminal?.error?.details?.reason).toBe('event_data_invalid_json');
    expect(records.filter((record) => record.result?.kind === 'event')).toHaveLength(0);
    expect(eventsRequests()).toHaveLength(1);
  });

  it('snapshot-only 经可编排对端：补读一页后退出（exit 0），观察到事件时重取快照', async () => {
    const eventA = globalUpdatedEvent(4);
    const eventB = globalUpdatedEvent(5);
    let snapshotCalls = 0;
    server.setScript((obs) => {
      if (obs.path === '/v1/snapshot') {
        snapshotCalls += 1;
        return snapshotCalls === 1
          ? { kind: 'json', status: 200, body: globalSnapshot(3, NEW_CURSOR) }
          : { kind: 'json', status: 200, body: globalSnapshot(5, FINAL_CURSOR) };
      }
      return {
        kind: 'sse',
        frames: [sseEventFrame(eventA), sseEventFrame(eventB)],
        keepOpen: true,
      };
    });

    const run = startObserve(['events', '--global', '--snapshot-only'], {
      observe: { quietMs: 150 },
    });
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(0);
    const records = parseRecords(invocation.stdout);
    expect(recordKinds(records)).toEqual([
      'snapshot',
      'event',
      'event',
      'snapshot',
      'observation_end',
    ]);
    // 初始快照水位 3 → 订阅从水位游标恢复。
    expect(eventsRequests()).toHaveLength(1);
    expect(eventsRequests()[0]?.query).toContain(`cursor=${NEW_CURSOR}`);
    // 观察到事件后重取快照：投影与 Core 当前状态一致（水位推进到 5）。
    const finalSnapshot = records[3]?.result?.snapshot as { watermark: { sequence: number } };
    expect(finalSnapshot.watermark.sequence).toBe(5);
    expect(snapshotRequests()).toHaveLength(2);
    expect((records.at(-1)?.result as Record<string, unknown>).eventsObserved).toBe(2);
  });

  it('snapshot-only 无积压事件：快照记录 + observation_end，不重取快照', async () => {
    server.setScript((obs) => {
      if (obs.path === '/v1/snapshot') {
        return { kind: 'json', status: 200, body: globalSnapshot(3, NEW_CURSOR) };
      }
      return { kind: 'sse', frames: [], keepOpen: true };
    });

    const run = startObserve(['events', '--global', '--snapshot-only'], {
      observe: { quietMs: 150 },
    });
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(0);
    expect(recordKinds(parseRecords(invocation.stdout))).toEqual(['snapshot', 'observation_end']);
    expect(snapshotRequests()).toHaveLength(1);
  });

  it('观察预算注入非法：在任何发现/网络之前拒绝（exit 2，零请求）', async () => {
    const run = startObserve(['events', '--global', '--cursor', OLD_CURSOR], {
      observe: { quietMs: 1 },
    });
    const invocation = await run.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(2);
    expect(parseRecords(invocation.stdout)[0]?.error?.code).toBe('invalid_input');
    expect(server.requests).toHaveLength(0);
    // 零发现副作用（不启动 Host、不创建新数据根）。
    const freshRoot = join(env.sandboxRoot, 'never-created');
    const neverRun = runAppCli({
      args: ['events', '--global', '--data-root', freshRoot, '--json'],
      io: { stdout: () => undefined, stderr: () => undefined },
      env: env.childEnv(),
      observe: { quietMs: 0 },
    });
    expect((await neverRun).exitCode).toBe(2);
    expect(existsSync(freshRoot)).toBe(false);
  });
});
