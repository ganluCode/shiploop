/**
 * F-018 P02-2 整 Feature 真实 SQLite/HTTP/SSE/CLI 集成回归（契约 §14 映射）。
 *
 * 定位：本套件不改任何产品源码，把 F-002 ~ F-017 已交付的能力放进真实多进程
 * 场景做整链回归，并按 §14.1/§14.2 映射 FR-1/FR-2 正常与关键失败分支；脱敏
 * 证据映射、编号子集声明与 not_run 记录见
 * docs/acceptance/evidence-p02-2/f018-regression-evidence.md（文档守护核对）。
 *
 * 本文件新增的增量覆盖（既有单能力套件的分支映射见证据文档，此处不重复）：
 * - FR-1 真实 HTTP 同步屏障竞争：同 principal/commandId/摘要两路并发注册 →
 *   恰一个项目/一条事件/一行回执，双方拿到同一稳定回执（恰一方 replayed）；
 *   同 commandId/摘要并发 CAS 更新 →  revision 只增长一次；同 commandId 不同
 *   摘要并发 → 恰一方 200、另一方 409 conflict，失败方零副作用；
 * - FR-1 Host 重启窗口：真实 startHost 提交注册+全局配置 → 关闭 → 同一数据根
 *   重启新实例 → 重放原冻结信封仍得原回执（replayed:true、同 resultRef），
 *   业务行/事件/回执计数不变，项目/配置/回执/快照在新实例照常可查；
 * - FR-2 断线 + Host 重启期间写入：SSE 持游标订阅 → 收live事件 → 断开期间
 *   写入 → Host 关闭重启 → 新实例写入 → 原持久游标重连补读，事件序列与持久
 *   state_events 逐行一致（无缺口、eventId 不伪造）；
 * - 双 CLI 同一数据根：预热后多 CLI 并发接入同一唯一 Host（发现实例不变），
 *   CLI 退出后 Host 存活；host stop 后应用 CLI 自动拉起新实例，项目/配置/
 *   回执可查，跨重启重放注册命令零新增副作用；
 * - 真实 Host 拒绝矩阵：任意文件路径/伪 resultRef/非法 commandId/actorId
 *   提权字段/过期命令全部拒绝，业务行、仓库文件与事件零变化。
 *
 * 运行前提：macOS（flock）；真实临时数据根/Git 仓库/回环 HTTP；不读真实
 * 凭据、不调用模型、不修改开发仓库或用户 HOME；所有等待有界。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHost, connectToHost, type RunningHost } from '../../../packages/host/src/index.ts';
import type { CommandReceipt } from '../../../packages/core/src/index.ts';
import { DATABASE_FILE_NAME } from '../../../packages/core/src/ports/path-service.ts';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../../../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../../../packages/cli/src/host/execute.ts';
import {
  createCommandsTestFixture,
  createStartBarrier,
  connectSseLoopback,
  openStorageProbe,
  type CommandsTestFixture,
  type SseConnection,
  type SseFrame,
} from '../../helpers/p02-2/index.ts';
import {
  createIsolatedHostEnvironment,
  loopbackRequest,
  type IsolatedHostEnvironment,
  type LoopbackResponse,
} from '../../helpers/host/index.ts';
import { commitAll, initGitRepo } from '../../helpers/git-repo.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url),
);
/** 带能力目录的 TS 测试 Host 入口（生产入口目录为空，配置策略需此夹具）。 */
const CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('../../helpers/host/detached-host-entry-catalog.ts', import.meta.url),
);

const GLOBAL_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  policies: { verification: { requireChecksBeforeDone: true } },
} as const;

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

/* ------------------------------------------------------------------ *
 * 公共小工具（脱敏：token 只进 Authorization 头，不进断言文本）
 * ------------------------------------------------------------------ */

let fixture: CommandsTestFixture | undefined;
let environment: IsolatedHostEnvironment | undefined;
const runningHosts: RunningHost[] = [];

afterEach(async () => {
  while (runningHosts.length > 0) {
    const host = runningHosts.pop();
    if (host !== undefined) {
      await host.close();
    }
  }
  await environment?.dispose();
  environment = undefined;
  if (fixture !== undefined) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
    fixture = undefined;
  }
});

/** 真实 startHost（生产装配，local-owner），登记受管关闭与 token 脱敏。 */
async function startRealHost(box: CommandsTestFixture): Promise<{ host: RunningHost; token: string }> {
  const host = await startHost({
    dataRoot: box.dataRoot,
    capabilityCatalog: box.capabilityCatalog,
    env: {},
  });
  runningHosts.push(host);
  const token = readFileSync(join(box.dataRoot, 'host', 'auth.token'), 'utf8');
  box.evidence.registerSecret(token);
  return { host, token };
}

interface CommandEnvelope {
  readonly schemaVersion: 5;
  readonly commandId: string;
  readonly operation: string;
  readonly scope: Record<string, unknown>;
  readonly expectedRevision?: number;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly payload: Record<string, unknown>;
}

function commandEnvelope(partial: {
  commandId?: string;
  operation: string;
  scope: Record<string, unknown>;
  expectedRevision?: number;
  issuedAt?: string;
  expiresAt?: string;
  payload: Record<string, unknown>;
}): CommandEnvelope {
  return {
    schemaVersion: 5,
    commandId: partial.commandId ?? randomUUID(),
    operation: partial.operation,
    scope: partial.scope,
    ...(partial.expectedRevision !== undefined ? { expectedRevision: partial.expectedRevision } : {}),
    issuedAt: partial.issuedAt ?? new Date().toISOString(),
    ...(partial.expiresAt !== undefined ? { expiresAt: partial.expiresAt } : {}),
    payload: partial.payload,
  };
}

function receiptOf(response: LoopbackResponse): CommandReceipt {
  const body = response.json() as CommandReceipt;
  if (body === null || typeof body !== 'object' || typeof body.commandId !== 'string') {
    throw new Error('响应不是回执形状');
  }
  return body;
}

function errorOf(response: LoopbackResponse): { code: string } {
  const body = response.json() as { error?: { code?: unknown } };
  if (typeof body.error?.code !== 'string') {
    throw new Error('响应不是结构化错误体');
  }
  return body.error as { code: string };
}

/** 有界收集业务事件帧（心跳为注释不入帧；超时即失败，不静默少收）。 */
async function collectEventFrames(
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
      throw new Error(`collectEventFrames 超时：已收 ${frames.length}/${count}`);
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
  return frames.filter((frame) => frame.event === 'state-event');
}

function parseEventFrame(frame: SseFrame): {
  eventId: string;
  sequence: number;
  type: string;
  aggregate: { type: string; id: string; revision: number };
} {
  const data = JSON.parse(frame.data) as Record<string, unknown>;
  if (data.schemaVersion !== 1) {
    throw new Error('事件封套 schemaVersion 不是 1');
  }
  return data as ReturnType<typeof parseEventFrame>;
}

/* ------------------------------------------------------------------ *
 * A. FR-1 真实 HTTP 幂等竞争（同步屏障）
 * ------------------------------------------------------------------ */

describe('F-018 FR-1：真实 HTTP 同步屏障命令竞争（契约 §5.5/§14.1）', () => {
  it('同 principal/commandId/摘要并发注册：恰一个项目/一条事件/一行回执，双方同一稳定回执', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f018-race-' });
    const box = fixture;
    const { host, token } = await startRealHost(box);
    const probe = box.openProbe();
    const post = (body: unknown) =>
      loopbackRequest({ port: host.port, method: 'POST', path: '/v1/commands', token, body });

    const envelope = commandEnvelope({
      operation: 'project.register',
      scope: { kind: 'registration' },
      payload: { repositoryPath: box.repoDirA, displayName: 'Race A', labels: ['race'] },
    });
    const barrier = createStartBarrier(2);
    const [first, second] = await Promise.all([
      barrier.arrive().then(() => post(envelope)),
      barrier.arrive().then(() => post(envelope)),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const receipts = [receiptOf(first), receiptOf(second)];
    // 双方拿到同一稳定回执（同 commandId/resultRef），恰一方为原提交。
    expect(new Set(receipts.map((receipt) => receipt.commandId)).size).toBe(1);
    const resultRefs = receipts.map((receipt) =>
      receipt.status === 'completed' ? receipt.resultRef : 'non-completed',
    );
    expect(new Set(resultRefs).size).toBe(1);
    expect(
      receipts.map((receipt) => receipt.replayed).sort((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
    // 真实持久四件套：恰一次副作用。
    expect(probe.counts()).toMatchObject({
      projects: 1,
      repository_bindings: 1,
      state_events: 1,
      command_receipts: 1,
    });

    // 竞争后的顺序重放仍复用原回执，零新增副作用。
    const replay = await post(envelope);
    expect(replay.statusCode).toBe(200);
    expect(receiptOf(replay).replayed).toBe(true);
    expect(probe.counts()).toMatchObject({
      projects: 1,
      repository_bindings: 1,
      state_events: 1,
      command_receipts: 1,
    });
    probe.close();
  }, 60_000);

  it('同 commandId/摘要并发 CAS 只增长一次 revision；同 commandId 不同摘要并发恰一方 conflict', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f018-cas-' });
    const box = fixture;
    const { host, token } = await startRealHost(box);
    const probe = box.openProbe();
    const post = (body: unknown) =>
      loopbackRequest({ port: host.port, method: 'POST', path: '/v1/commands', token, body });

    const register = await post(
      commandEnvelope({
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: { repositoryPath: box.repoDirA, displayName: 'CAS Base' },
      }),
    );
    expect(register.statusCode).toBe(200);
    const registerReceipt = receiptOf(register);
    if (registerReceipt.status !== 'completed') throw new Error('expected completed');
    const projectId = (registerReceipt.result as { project: { id: string } }).project.id;

    // 两路相同冻结信封并发 CAS（revision 1 → 2 只发生一次）。
    const casEnvelope = commandEnvelope({
      operation: 'project.metadata.update',
      scope: { kind: 'project', projectId },
      expectedRevision: 1,
      payload: { displayName: 'CAS Winner' },
    });
    const casBarrier = createStartBarrier(2);
    const [casA, casB] = await Promise.all([
      casBarrier.arrive().then(() => post(casEnvelope)),
      casBarrier.arrive().then(() => post(casEnvelope)),
    ]);
    expect(casA.statusCode).toBe(200);
    expect(casB.statusCode).toBe(200);
    expect(probe.projectRow(projectId)).toMatchObject({ display_name: 'CAS Winner', revision: 2 });
    expect(probe.counts()).toMatchObject({ state_events: 2, command_receipts: 2 });

    // 同 commandId 不同摘要并发：恰一方 200 生效，另一方 409 conflict 且零副作用。
    const conflictId = randomUUID();
    const envelopeOne = commandEnvelope({
      commandId: conflictId,
      operation: 'project.metadata.update',
      scope: { kind: 'project', projectId },
      expectedRevision: 2,
      payload: { displayName: 'Branch One' },
    });
    const envelopeTwo = commandEnvelope({
      commandId: conflictId,
      operation: 'project.metadata.update',
      scope: { kind: 'project', projectId },
      expectedRevision: 2,
      payload: { displayName: 'Branch Two' },
    });
    const conflictBarrier = createStartBarrier(2);
    const outcomes = await Promise.all([
      conflictBarrier.arrive().then(() => post(envelopeOne)).then((r) => ({ response: r, name: 'Branch One' })),
      conflictBarrier.arrive().then(() => post(envelopeTwo)).then((r) => ({ response: r, name: 'Branch Two' })),
    ]);
    const byStatus = outcomes.map((outcome) => outcome.response.statusCode).sort();
    expect(byStatus).toEqual([200, 409]);
    const winner = outcomes.find((outcome) => outcome.response.statusCode === 200);
    const loser = outcomes.find((outcome) => outcome.response.statusCode === 409);
    expect(errorOf(loser!.response).code).toBe('conflict');
    // 业务行只被胜者修改一次；事件/回执各只多一条（胜者的提交）。
    expect(probe.projectRow(projectId)).toMatchObject({ display_name: winner!.name, revision: 3 });
    expect(probe.counts()).toMatchObject({ state_events: 3, command_receipts: 3 });
    probe.close();
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * B. FR-1 Host 重启窗口：回执复用与持久数据可查
 * ------------------------------------------------------------------ */

describe('F-018 FR-1：Host 关闭重启后复用原回执（契约 §5.5 崩溃窗口）', () => {
  it('重启后重放原冻结信封得同一回执；项目/配置/回执/快照在新实例可查且无副作用', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f018-restart-' });
    const box = fixture;
    const first = await startRealHost(box);
    const probe = box.openProbe();
    const post = (port: number, token: string, body: unknown) =>
      loopbackRequest({ port, method: 'POST', path: '/v1/commands', token, body });

    const registerEnvelope = commandEnvelope({
      operation: 'project.register',
      scope: { kind: 'registration' },
      payload: { repositoryPath: box.repoDirA, displayName: 'Restart A', labels: ['restart'] },
    });
    const settingsEnvelope = commandEnvelope({
      operation: 'settings.global.create',
      scope: { kind: 'global' },
      payload: { ...GLOBAL_PAYLOAD },
    });
    const registerReceipt = receiptOf(
      await post(first.host.port, first.token, registerEnvelope),
    );
    const settingsReceipt = receiptOf(
      await post(first.host.port, first.token, settingsEnvelope),
    );
    expect(registerReceipt.status).toBe('completed');
    expect(settingsReceipt.status).toBe('completed');
    if (registerReceipt.status !== 'completed' || settingsReceipt.status !== 'completed') {
      throw new Error('expected completed');
    }
    const projectId = (registerReceipt.result as { project: { id: string } }).project.id;
    const countsBefore = probe.counts();
    expect(countsBefore).toMatchObject({
      projects: 1,
      global_settings: 1,
      state_events: 2,
      command_receipts: 2,
    });

    // 关闭并重启同一数据根（新实例）。
    const firstInstanceId = first.host.hostInstanceId;
    await first.host.close();
    runningHosts.splice(runningHosts.indexOf(first.host), 1);
    const second = await startRealHost(box);
    expect(second.host.hostInstanceId).not.toBe(firstInstanceId);

    // 重放原冻结信封（同 commandId + 同 issuedAt）：复用原回执，零新增副作用。
    const replayedRegister = receiptOf(
      await post(second.host.port, second.token, registerEnvelope),
    );
    const replayedSettings = receiptOf(
      await post(second.host.port, second.token, settingsEnvelope),
    );
    expect(replayedRegister).toMatchObject({
      commandId: registerEnvelope.commandId,
      status: 'completed',
      replayed: true,
    });
    expect(replayedSettings).toMatchObject({
      commandId: settingsEnvelope.commandId,
      status: 'completed',
      replayed: true,
    });
    if (replayedRegister.status === 'completed' && registerReceipt.status === 'completed') {
      expect(replayedRegister.resultRef).toBe(registerReceipt.resultRef);
      expect(replayedRegister.result).toEqual(registerReceipt.result);
    }
    expect(probe.counts()).toEqual(countsBefore);

    // 新实例上项目/配置/回执/快照照常可读，内容与持久状态一致。
    const get = (path: string) =>
      loopbackRequest({ port: second.host.port, method: 'GET', path, token: second.token });
    const receiptView = await get(`/v1/receipts/${registerEnvelope.commandId}`);
    expect(receiptView.statusCode).toBe(200);
    expect(receiptOf(receiptView).commandId).toBe(registerEnvelope.commandId);
    const list = await get('/v1/projects');
    expect((list.json() as { records: { id: string }[] }).records.map((r) => r.id)).toEqual([
      projectId,
    ]);
    const detail = await get(`/v1/projects/${projectId}`);
    expect((detail.json() as { project: { revision: number } }).project.revision).toBe(1);
    const globalSettings = await get('/v1/settings/global');
    expect(globalSettings.statusCode).toBe(200);
    expect((globalSettings.json() as { revision: number }).revision).toBe(1);
    const snapshot = await get('/v1/snapshot?scope=global');
    expect(snapshot.statusCode).toBe(200);
    expect(
      (snapshot.json() as { watermark: { sequence: number } }).watermark.sequence,
    ).toBe(2);
    probe.close();
  }, 90_000);
});

/* ------------------------------------------------------------------ *
 * C. FR-2 断线 + Host 重启期间写入的持久游标续读
 * ------------------------------------------------------------------ */

describe('F-018 FR-2：断线/重启期间写入，原持久游标续读与审计逐行一致（契约 §8/§9.4）', () => {
  it('live 投递 → 断线期间写入 → Host 重启 → 新实例写入 → 原游标补读无缺口', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f018-sse-' });
    const box = fixture;
    const first = await startRealHost(box);
    const probe = box.openProbe();
    const post = (port: number, token: string, body: unknown) =>
      loopbackRequest({ port, method: 'POST', path: '/v1/commands', token, body });
    const subscribePath = (projectId: string) =>
      `/v1/events?scope=project&projectId=${projectId}`;

    // 注册（seq 1）并取快照水位游标。
    const register = await post(
      first.host.port,
      first.token,
      commandEnvelope({
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: { repositoryPath: box.repoDirA, displayName: 'SSE Base' },
      }),
    );
    expect(register.statusCode).toBe(200);
    const registerReceipt = receiptOf(register);
    if (registerReceipt.status !== 'completed') throw new Error('expected completed');
    const projectId = (registerReceipt.result as { project: { id: string } }).project.id;
    const snapshot = await loopbackRequest({
      port: first.host.port,
      method: 'GET',
      path: `/v1/snapshot?scope=project&projectId=${projectId}`,
      token: first.token,
    });
    const cursor = (snapshot.json() as { watermark: { cursor: string } }).watermark.cursor;

    const update = (
      port: number,
      token: string,
      revision: number,
      displayName: string,
    ) =>
      post(
        port,
        token,
        commandEnvelope({
          operation: 'project.metadata.update',
          scope: { kind: 'project', projectId },
          expectedRevision: revision,
          payload: { displayName },
        }),
      );

    // 持游标订阅 → live 收到 seq 2。
    const live = await connectSseLoopback({
      port: first.host.port,
      path: subscribePath(projectId),
      token: first.token,
      cursor,
      connectTimeoutMs: 5_000,
    });
    expect((await update(first.host.port, first.token, 1, 'Live Update')).statusCode).toBe(200);
    const liveFrames = await collectEventFrames(live, 1, 5_000);
    expect(liveFrames.map((frame) => parseEventFrame(frame).sequence)).toEqual([2]);
    await live.close();

    // 断线期间写入 seq 3；随后 Host 关闭重启，新实例写入 seq 4。
    expect((await update(first.host.port, first.token, 2, 'Offline Update')).statusCode).toBe(200);
    await first.host.close();
    runningHosts.splice(runningHosts.indexOf(first.host), 1);
    const second = await startRealHost(box);
    expect((await update(second.host.port, second.token, 3, 'After Restart')).statusCode).toBe(200);

    // 原持久游标在新实例补读：seq 2/3/4 升序到达，与持久审计逐行一致。
    const resumed = await connectSseLoopback({
      port: second.host.port,
      path: subscribePath(projectId),
      token: second.token,
      cursor,
      connectTimeoutMs: 5_000,
    });
    try {
      const frames = await collectEventFrames(resumed, 3, 8_000);
      const events = frames.map(parseEventFrame);
      expect(events.map((event) => event.sequence)).toEqual([2, 3, 4]);
      const rows = probe.stateEvents();
      expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
      for (const [index, event] of events.entries()) {
        const row = rows[index + 1]!;
        expect(event.eventId).toBe(row.id);
        expect(event.type).toBe(row.event_type);
        expect(event.aggregate.id).toBe(row.aggregate_id);
        expect(event.aggregate.revision).toBe(row.aggregate_revision);
      }
      // SSE id 与 eventId 按契约关联（重连去重键）。
      expect(frames.every((frame) => frame.id === parseEventFrame(frame).eventId)).toBe(true);
    } finally {
      await resumed.close();
    }
    probe.close();
  }, 90_000);
});

/* ------------------------------------------------------------------ *
 * D. 双 CLI 同一数据根：唯一 Host、停止/重启后业务可查
 * ------------------------------------------------------------------ */

interface AppInvocation {
  readonly result: AppCliRunResult;
  readonly stdout: string;
  readonly stderr: string;
}

function collectIo(): { io: AppCliIo; stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function parseEnvelope(invocation: AppInvocation): {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string };
} {
  expect(invocation.stdout.trim().split('\n'), 'stdout 只能包含一个 JSON 对象').toHaveLength(1);
  return JSON.parse(invocation.stdout) as { ok: boolean; command: string | null };
}

function readDiscovery(canonicalRoot: string): { hostInstanceId: string; pid: number } {
  const record = JSON.parse(
    readFileSync(join(canonicalRoot, 'host', 'discovery.json'), 'utf8'),
  ) as { hostInstanceId: string; pid: number };
  return record;
}

async function stopHostBestEffort(canonicalRoot: string): Promise<void> {
  const collected = collectIo();
  try {
    const stopped = await runHostCli({
      args: ['host', 'stop', '--data-root', canonicalRoot, '--json'],
      io: collected.io as HostCliIo,
      env: {},
    });
    if (stopped.exitCode === 0) {
      return;
    }
  } catch {
    // 继续兜底。
  }
  try {
    const client = await connectToHost({ canonicalRoot });
    await client.stop().catch(() => undefined);
    client.close();
  } catch {
    // 尽力而为：无实例或已停止。
  }
}

describe('F-018 双 CLI 同一数据根：唯一 Host、CLI 退出不停 Host、停止/重启后业务可查', () => {
  it('并发 CLI 接入同一实例；host stop 后应用 CLI 拉起新实例，项目/配置/回执一致且重放零副作用', async () => {
    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f018-cli-' });
    const env = environment;
    const root = env.dataRoot('app').canonicalRoot;
    const home = env.childEnv().HOME as string;
    const repoA = join(env.sandboxRoot, 'repo-a');
    const repoB = join(env.sandboxRoot, 'repo-b');
    for (const [dir, name] of [
      [repoA, 'A'],
      [repoB, 'B'],
    ] as const) {
      initGitRepo(dir);
      writeFileSync(join(dir, 'README.md'), `# Repo ${name}\n`, 'utf8');
      commitAll(dir, `init ${name}`, { home });
    }

    const runApp = async (
      args: readonly string[],
    ): Promise<AppInvocation> => {
      const collected = collectIo();
      const result = await runAppCli({
        args,
        io: collected.io,
        env: env.childEnv(),
        launch: {
          entryArgv: ['--import', REGISTER_HOOKS, CATALOG_HOST_ENTRY],
          childEnv: env.childEnv(),
          pollIntervalMs: 50,
        },
      });
      return { result, stdout: collected.stdout(), stderr: collected.stderr() };
    };

    try {
      // 预热：第一个 CLI 拉起唯一 Host。
      const commandIdA = randomUUID();
      const registerA = await runApp([
        'project', 'register', repoA, '--name', 'Alpha',
        '--command-id', commandIdA, '--data-root', root, '--json',
      ]);
      expect(registerA.result.exitCode, registerA.stderr).toBe(0);
      const projectIdA = ((
        parseEnvelope(registerA).result as { result: { project: { id: string } } }
      ).result.project.id);
      const discoveryBefore = readDiscovery(root);

      // 双 CLI 并发接入同一数据根（注册 B / 列表 / 全局快照观察）。
      const [registerB, list, observe] = await Promise.all([
        runApp([
          'project', 'register', repoB, '--name', 'Beta',
          '--data-root', root, '--json',
        ]),
        runApp(['project', 'list', '--data-root', root, '--json']),
        runApp(['events', '--global', '--snapshot-only', '--data-root', root, '--json']),
      ]);
      expect(registerB.result.exitCode, registerB.stderr).toBe(0);
      expect(list.result.exitCode, list.stderr).toBe(0);
      expect(observe.result.exitCode, observe.stderr).toBe(0);
      // 唯一 Host：发现实例未变（并发 CLI 都接入既有实例，无第二写入者）。
      expect(readDiscovery(root)).toEqual(discoveryBefore);
      const probe = openStorageProbe(join(root, DATABASE_FILE_NAME));
      try {
        expect(probe.counts()).toMatchObject({ projects: 2, state_events: 2, command_receipts: 2 });
      } finally {
        probe.close();
      }

      // CLI 退出后 Host 仍存活：独立 CLI 可继续查询两个项目。
      const listAfter = await runApp(['project', 'list', '--data-root', root, '--json']);
      expect(listAfter.result.exitCode, listAfter.stderr).toBe(0);
      expect(
        (parseEnvelope(listAfter).result as { records: unknown[] }).records,
      ).toHaveLength(2);
      expect(readDiscovery(root)).toEqual(discoveryBefore);

      // 全局配置（经 CLI 输入文件；仅作请求输入）。
      const inputPath = join(env.sandboxRoot, 'global-settings.json');
      writeFileSync(inputPath, JSON.stringify(GLOBAL_PAYLOAD), 'utf8');
      const createSettings = await runApp([
        'config', 'create', '--scope', 'global', '--input', inputPath,
        '--data-root', root, '--json',
      ]);
      expect(createSettings.result.exitCode, createSettings.stderr).toBe(0);

      // 安全停止：host stop 三证据收尾；应用 CLI 再访问时拉起新实例。
      const collected = collectIo();
      const stopped = await runHostCli({
        args: ['host', 'stop', '--data-root', root, '--json'],
        io: collected.io as HostCliIo,
        env: {},
      });
      expect(stopped.exitCode, collected.stderr()).toBe(0);

      const getAfter = await runApp(['project', 'get', projectIdA, '--data-root', root, '--json']);
      expect(getAfter.result.exitCode, getAfter.stderr).toBe(0);
      const restartedDiscovery = readDiscovery(root);
      expect(restartedDiscovery.hostInstanceId).not.toBe(discoveryBefore.hostInstanceId);
      expect(
        (parseEnvelope(getAfter).result as { project: { displayName: string; revision: number } })
          .project,
      ).toMatchObject({ displayName: 'Alpha', revision: 1 });

      // 重启后配置与回执仍可读；跨重启重放注册命令零新增副作用。
      const settingsAfter = await runApp(['config', 'get', '--scope', 'global', '--data-root', root, '--json']);
      expect(settingsAfter.result.exitCode, settingsAfter.stderr).toBe(0);
      expect(
        (parseEnvelope(settingsAfter).result as { revision: number; payload: unknown }),
      ).toMatchObject({ revision: 1, payload: GLOBAL_PAYLOAD });
      const receiptAfter = await runApp(['receipt', 'get', commandIdA, '--data-root', root, '--json']);
      expect(receiptAfter.result.exitCode, receiptAfter.stderr).toBe(0);
      expect(
        (parseEnvelope(receiptAfter).result as { status: string; commandId: string }),
      ).toMatchObject({ status: 'completed', commandId: commandIdA });

      const replayA = await runApp([
        'project', 'register', repoA, '--name', 'Alpha',
        '--command-id', commandIdA, '--data-root', root, '--json',
      ]);
      expect(replayA.result.exitCode, replayA.stderr).toBe(0);
      const probeAfter = openStorageProbe(join(root, DATABASE_FILE_NAME));
      try {
        expect(probeAfter.counts()).toMatchObject({
          projects: 2,
          global_settings: 1,
          state_events: 3,
          command_receipts: 3,
        });
      } finally {
        probeAfter.close();
      }
      // stderr 不含认证材料（64 位十六进制 token 形状）。
      for (const invocation of [registerA, registerB, listAfter, settingsAfter, receiptAfter, replayA]) {
        expect(invocation.stderr).not.toMatch(/[0-9a-f]{64}/);
      }
    } finally {
      await stopHostBestEffort(root);
    }
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * E. 真实 Host 拒绝矩阵：任意路径/伪引用/提权字段/过期命令
 * ------------------------------------------------------------------ */

describe('F-018 真实 Host 拒绝矩阵（契约 §5.4/§5.7/§7；T10 子集）', () => {
  it('任意文件路径/伪 resultRef/非法 commandId/actorId 提权/过期命令拒绝，业务与文件零变化', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f018-deny-' });
    const box = fixture;
    const { host, token } = await startRealHost(box);
    const probe = box.openProbe();
    const get = (path: string) =>
      loopbackRequest({ port: host.port, method: 'GET', path, token });
    const post = (body: unknown) =>
      loopbackRequest({ port: host.port, method: 'POST', path: '/v1/commands', token, body });

    const register = await post(
      commandEnvelope({
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: { repositoryPath: box.repoDirA, displayName: 'Deny Base' },
      }),
    );
    expect(register.statusCode).toBe(200);
    const countsBefore = probe.counts();
    const repoReadmeBefore = readFileSync(join(box.repoDirA, 'README.md'), 'utf8');

    // 任意文件读取：伪 resultRef 路径穿越 / 非法 commandId / 表外文件路由。
    const traversal = await get('/v1/results/..%2F..%2Fetc%2Fpasswd');
    expect(traversal.statusCode).toBe(400);
    expect(errorOf(traversal).code).toBe('invalid_input');
    expect(traversal.bodyText).not.toContain('root:');
    expect((await get('/v1/receipts/not-a-command-id')).statusCode).toBe(400);
    const fileRoute = await get('/v1/files?path=%2Fetc%2Fpasswd');
    expect(fileRoute.statusCode).toBe(404);
    expect(fileRoute.bodyText).not.toContain('root:');

    // actorId/principal 提权字段不能进入 payload（身份绝非请求数据）。
    const escalation = await post(
      commandEnvelope({
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: {
          repositoryPath: box.repoDirB,
          displayName: 'Escalation',
          actorId: 'local-owner',
          principal: 'local-owner',
        },
      }),
    );
    expect(escalation.statusCode).toBe(400);
    expect(errorOf(escalation).code).toBe('invalid_input');

    // 过期新命令不启动业务变更、不积回执。
    const expired = await post(
      commandEnvelope({
        operation: 'project.register',
        scope: { kind: 'registration' },
        issuedAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        payload: { repositoryPath: box.repoDirB, displayName: 'Expired' },
      }),
    );
    expect(expired.statusCode).toBe(400);
    expect(errorOf(expired).code).toBe('command_expired');

    // 业务行、仓库文件与事件零变化。
    expect(probe.counts()).toEqual(countsBefore);
    expect(readFileSync(join(box.repoDirA, 'README.md'), 'utf8')).toBe(repoReadmeBefore);
    probe.close();
  }, 60_000);
});
