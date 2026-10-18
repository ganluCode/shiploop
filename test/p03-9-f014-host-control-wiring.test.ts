/**
 * P03-9 / F-014：Run/Batch 控制、retryFinal 与恢复诊断接入 Host/HostClient
 *（真实 Host + SQLite + Copilot 传输面，零模型）。
 *
 * 验收面（.dag_context.json F-014）：
 * 1. 复用既有命令/能力白名单/线契约；不新增 HTTP 服务、回执库或事件总线，
 *    客户端不操作 SQLite；
 * 2. 运行时校验 commandId/expectedRevision/目标归属/受限 payload，沿用
 *    时效/授权/事务内重核/幂等，拒绝任意 actor/权限/命令注入；
 * 3. 冻结能力/线消息形状不静默变形；旧/未知线版本明确拒绝，握手与
 *    HostClient 一致；
 * 4. 最终状态/证据经既有回执、查询与事件可观察；SSE 断开或 HostClient
 *    停止 follow 不取消后台执行；
 * 5. 真实 Host 传输测试覆盖正常控制、重复请求、revision 冲突、过期/
 *    越权/跨项目、观察断开与未知操作。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  connectToHost,
  isHostProtocolError,
  startHost,
  validateAppQueryResponse,
  type HostClient,
  type RunningHost,
} from '../packages/host/src/index.ts';
import { APP_OPERATIONS } from '../packages/host/src/contract/errors.ts';
import {
  APPLICATION_COMMAND_CAPABILITIES,
  APPLICATION_QUERY_CAPABILITIES,
} from '../packages/host/src/contract/lifecycle.ts';
import { COMMAND_OPERATIONS } from '../packages/core/src/ports/commands.ts';
import { EXECUTION_CONTROL_QUERY_OPERATIONS } from '../packages/core/src/protocol.ts';
import type { CommandReceipt } from '../packages/core/src/ports/commands.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import {
  historicalRunWorkKey,
  prepareEligibleFixture,
} from './helpers/p03-9/finalization-retry-fixture.ts';
import {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
} from './helpers/p02-2/principals.ts';
import { loopbackRequest } from './helpers/host/index.ts';

type Fixture = Awaited<ReturnType<typeof openClaimFixture>>;

const fixtures: Fixture[] = [];
const eligibleFixtures: Awaited<ReturnType<typeof prepareEligibleFixture>>[] = [];
const hosts: RunningHost[] = [];
const clients: HostClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0)) await host.close();
  for (const fixture of fixtures.splice(0)) fixture.box.close();
  for (const fixture of eligibleFixtures.splice(0)) fixture.box.close();
});

function readRun(f: Fixture) {
  return f.box.session.database
    .prepare('SELECT status, reason, revision FROM runs WHERE id = ?')
    .get(f.ids.runId) as { status: string; reason: string | null; revision: number };
}

function readBatchRevision(f: Fixture): number {
  return (
    f.box.session.database
      .prepare('SELECT revision FROM execution_batches WHERE id = ?')
      .get(f.ids.batchId) as { revision: number }
  ).revision;
}

function readEventCount(f: Fixture, eventType: string): number {
  return (
    f.box.session.database
      .prepare('SELECT COUNT(*) AS n FROM state_events WHERE event_type = ?')
      .get(eventType) as { n: number }
  ).n;
}

function readAuthToken(dataRoot: string): string {
  return readFileSync(join(dataRoot, 'host', 'auth.token'), 'utf8');
}

function completedResult(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || !('result' in receipt)) {
    throw new Error(`Expected completed receipt, got ${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, unknown>;
}

function receiptResultRef(receipt: CommandReceipt): string {
  if (!('resultRef' in receipt)) {
    throw new Error(`Expected receipt with resultRef, got ${JSON.stringify(receipt)}`);
  }
  return receipt.resultRef;
}

function rejectedReason(receipt: CommandReceipt): string {
  if (receipt.status !== 'rejected') {
    throw new Error(`Expected rejected receipt, got ${JSON.stringify(receipt)}`);
  }
  return String(receipt.error.details?.reason);
}

async function openHostedFixture() {
  const fixture = await openClaimFixture();
  fixtures.push(fixture);
  const host = await startHost({
    dataRoot: fixture.box.box.dataRoot,
    capabilityCatalog: fixture.box.box.capabilityCatalog,
    env: {},
  });
  hosts.push(host);
  const client = await connectToHost({ canonicalRoot: fixture.box.box.dataRoot });
  clients.push(client);
  const token = readAuthToken(fixture.box.box.dataRoot);
  return { fixture, host, client, token };
}

/** 等待一个真实 SSE 事件（有界；不依赖固定 sleep 轮询状态）。 */
async function waitForEvent(
  client: HostClient,
  projectId: string,
  predicate: (event: { type: string; aggregate: { type: string; id: string } }) => boolean,
): Promise<{ type: string; aggregate: { type: string; id: string } }> {
  const snapshot = await client.getSnapshot({ kind: 'project', projectId });
  let resolveEvent: ((event: { type: string; aggregate: { type: string; id: string } }) => void) | undefined;
  let rejectEvent: ((error: Error) => void) | undefined;
  const observed = new Promise<{ type: string; aggregate: { type: string; id: string } }>(
    (resolve, reject) => {
      resolveEvent = resolve;
      rejectEvent = reject;
    },
  );
  const captured: string[] = [];
  const subscription = await client.subscribeEvents({
    scope: { kind: 'project', projectId },
    cursor: snapshot.watermark.cursor,
    onEvent: (event) => {
      captured.push(event.type);
      if (predicate(event)) resolveEvent?.(event as never);
    },
  });
  const timer = setTimeout(
    () => rejectEvent?.(new Error(`等待 SSE 事件超时；已收到 ${captured.join(',') || '(none)'}`)),
    10_000,
  );
  timer.unref?.();
  try {
    return await observed;
  } finally {
    clearTimeout(timer);
    subscription.close();
  }
}

describe('P03-9 / F-014 能力白名单与线版本纪律', () => {
  it('命令/查询能力与操作清单同步；线消息版本未静默变形', async () => {
    for (const operation of ['execution.pause', 'execution.cancel', 'execution.resume', 'execution.retryFinal'] as const) {
      expect(COMMAND_OPERATIONS).toContain(operation);
      expect(APPLICATION_COMMAND_CAPABILITIES).toContain(operation);
    }
    for (const operation of EXECUTION_CONTROL_QUERY_OPERATIONS) {
      expect(APP_OPERATIONS).toContain(operation);
      expect(APPLICATION_QUERY_CAPABILITIES).toContain(operation);
    }
    // 本 Feature 未改变任何冻结线消息形状：仍是同一 v5，不猜测升版。
    expect(CURRENT_SCHEMA_VERSION).toBe(5);

    const { host, client, token } = await openHostedFixture();
    for (const operation of ['execution.pause', 'execution.cancel', 'execution.resume', 'execution.retryFinal']) {
      expect(client.handshake.capabilities.application.commands).toContain(operation);
    }
    for (const operation of EXECUTION_CONTROL_QUERY_OPERATIONS) {
      expect(client.handshake.capabilities.application.queries).toContain(operation);
    }
    const handshakeBody = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      hostInstanceId: host.hostInstanceId,
      dataRootIdentity: host.dataRootIdentity,
    };
    const current = await loopbackRequest({
      port: host.port,
      method: 'POST',
      path: '/v1/host/handshake',
      token,
      body: handshakeBody,
    });
    expect(current.statusCode).toBe(200);
    for (const schemaVersion of [4, 6]) {
      const oldOrUnknown = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token,
        body: { ...handshakeBody, schemaVersion },
      });
      expect(oldOrUnknown.statusCode).toBe(400);
      expect(
        (JSON.parse(oldOrUnknown.bodyText) as { error?: { code?: string } }).error?.code,
      ).toBe('unsupported_schema_version');
    }
  }, 60_000);
});

describe('P03-9 / F-014 真实 Host 控制纵向', () => {
  it('pause/resume/cancel：回执、查询与事件一致；重复/冲突/跨项目不改状态', async () => {
    const { fixture, host, client, token } = await openHostedFixture();
    const projectId = fixture.ids.projectId;
    const runId = fixture.ids.runId;
    const batchId = fixture.ids.batchId;
    expect(readRun(fixture)).toMatchObject({ status: 'queued', revision: 1 });

    // 正常暂停：completed 回执 + 持久状态 + 事件可见；accepted 类输出不谎称完成。
    const pauseEvent = waitForEvent(
      client,
      projectId,
      event => event.type === 'execution.run.paused' && event.aggregate.id === runId,
    );
    const [pause, pauseEnvelope] = await Promise.all([
      client.pauseExecution({ projectId, runId, expectedRevision: 1 }),
      pauseEvent,
    ]);
    const pauseResult = completedResult(pause);
    expect(pauseResult).toMatchObject({
      outcome: 'paused',
      targetKind: 'run',
      targetId: runId,
      status: 'paused',
      changed: true,
    });
    expect(readRun(fixture)).toMatchObject({ status: 'paused', reason: 'user_pause', revision: 2 });
    expect(pauseEnvelope.type).toBe('execution.run.paused');

    const control = await client.getRunControl(projectId, runId);
    expect(control).toMatchObject({
      scope: 'run-control',
      run: { runId, batchId, status: 'paused', reason: 'user_pause' },
      batch: { batchId, status: 'queued' },
      nextActions: ['resume'],
    });
    expect(control.attempts.records).toEqual([]);

    // 重复 commandId + 原 issuedAt：原回执重放，不重复写事件/推进 revision。
    const eventsBeforeReplay = readEventCount(fixture, 'execution.run.paused');
    const replayed = await client.pauseExecution(
      { projectId, runId, expectedRevision: 1, commandId: pause.commandId },
      { commandId: pause.commandId, issuedAt: pause.issuedAt },
    );
    expect(replayed.replayed).toBe(true);
    expect(receiptResultRef(replayed)).toBe(receiptResultRef(pause));
    expect(readRun(fixture).revision).toBe(2);
    expect(readEventCount(fixture, 'execution.run.paused')).toBe(eventsBeforeReplay);

    // revision 冲突：稳定 rejected，无业务倒写。
    const stale = await client.pauseExecution({ projectId, runId, expectedRevision: 1 });
    expect(rejectedReason(stale)).toBe('stale_revision');
    expect(readRun(fixture).revision).toBe(2);

    // 取消暂停中的 Run：无活动 Attempt 时直接 cancelled；停止检查状态由同一
    // 回执/查询展示，事件通道同源可观察。
    const cancelEvent = waitForEvent(
      client,
      projectId,
      event =>
        event.aggregate.id === runId &&
        (event.type === 'execution.run.cancelling' || event.type === 'execution.run.cancelled'),
    );
    const [cancel, cancelEnvelope] = await Promise.all([
      client.cancelExecution({ projectId, runId, expectedRevision: 2 }),
      cancelEvent,
    ]);
    expect(completedResult(cancel)).toMatchObject({
      outcome: 'cancelled',
      targetKind: 'run',
      targetId: runId,
      status: 'cancelled',
      stopStatus: 'stopped',
    });
    expect(cancelEnvelope.type).toMatch(/execution\.run\.cancell?/);
    const cancelledControl = await client.getRunControl(projectId, runId);
    expect(cancelledControl.run.status).toBe('cancelled');
    expect(cancelledControl.stopOperations.length).toBeGreaterThan(0);
    expect(cancelledControl.nextActions).toEqual(['none']);

    // 恢复使用独立 Run：resume 会唤醒调度，避免与本 Run 的取消时序竞争。
    const resumed = await openHostedFixture();
    const resumeProjectId = resumed.fixture.ids.projectId;
    const resumeRunId = resumed.fixture.ids.runId;
    expect(
      (
        await resumed.client.pauseExecution({
          projectId: resumeProjectId,
          runId: resumeRunId,
          expectedRevision: 1,
        })
      ).status,
    ).toBe('completed');
    const resumeEvent = waitForEvent(
      resumed.client,
      resumeProjectId,
      event => event.type === 'execution.run.resumed' && event.aggregate.id === resumeRunId,
    );
    const [resume, resumeEnvelope] = await Promise.all([
      resumed.client.resumeExecution({
        projectId: resumeProjectId,
        runId: resumeRunId,
        expectedRevision: 2,
      }),
      resumeEvent,
    ]);
    expect(completedResult(resume)).toMatchObject({
      resumed: true,
      targetKind: 'run',
      targetId: resumeRunId,
      status: 'queued',
    });
    expect(resumeEnvelope.type).toBe('execution.run.resumed');
    expect(
      (await resumed.client.getRunControl(resumeProjectId, resumeRunId)).run.status,
    ).toBe('queued');

    // Batch 目标同一命令面和查询形态。
    const batch = await client.getBatchControl(projectId, batchId);
    expect(batch.scope).toBe('batch-control');
    expect(batch.runs.records.map(record => record.runId)).toContain(runId);
    const batchCancel = await client.cancelExecution({
      projectId,
      batchId,
      expectedRevision: readBatchRevision(fixture),
    });
    expect(batchCancel.status).toBe('completed');

    // 跨项目 scope：目标 Run 不属于该可见项目 → forbidden，不泄漏存在性。
    const registered = await client.submitCommand({
      operation: 'project.register',
      scope: { kind: 'registration' },
      payload: {
        repositoryPath: fixture.box.box.repoDirB,
        displayName: 'Other project',
        description: null,
        labels: [],
      },
    });
    expect(registered.status).toBe('completed');
    const otherProjectId = (completedResult(registered) as { project: { id: string } }).project.id;
    await expect(
      client.pauseExecution({ projectId: otherProjectId, runId, expectedRevision: readRun(fixture).revision }),
    ).rejects.toSatisfy(
      error => isHostProtocolError(error) && error.code === 'forbidden',
    );

    // 未认证传输请求：401，零业务写入。
    const unauthorized = await loopbackRequest({
      port: host.port,
      method: 'POST',
      path: '/v1/commands',
      body: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        commandId: randomUUID(),
        issuedAt: new Date().toISOString(),
        operation: 'execution.pause',
        scope: { kind: 'project', projectId },
        expectedRevision: readRun(fixture).revision,
        payload: { runId, batchId: null },
      },
    });
    expect(unauthorized.statusCode).toBe(401);

    // 过期命令：既有 command_expired 明确拒绝，不是伪造 accepted。
    const expired = await loopbackRequest({
      port: host.port,
      method: 'POST',
      path: '/v1/commands',
      token,
      body: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        commandId: randomUUID(),
        issuedAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:00:01.000Z',
        operation: 'execution.pause',
        scope: { kind: 'project', projectId },
        expectedRevision: readRun(fixture).revision,
        payload: { runId, batchId: null },
      },
    });
    expect(expired.statusCode).toBe(400);
    expect((JSON.parse(expired.bodyText) as { error?: { code?: string } }).error?.code).toBe(
      'command_expired',
    );

    // 未知操作：501 unsupported，不执行任意命令。
    const unknown = await loopbackRequest({
      port: host.port,
      method: 'POST',
      path: '/v1/commands',
      token,
      body: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        commandId: randomUUID(),
        issuedAt: new Date().toISOString(),
        operation: 'execution.arbitrary.inject',
        scope: { kind: 'project', projectId },
        expectedRevision: 1,
        payload: {},
      },
    });
    expect(unknown.statusCode).toBe(501);
    expect((JSON.parse(unknown.bodyText) as { error?: { code?: string } }).error?.code).toBe(
      'unsupported',
    );
  }, 60_000);

  it('受限主体不能暂停/恢复；任意 actor/权限字段与互斥目标在提交前拒绝', async () => {
    const { fixture, host, client } = await openHostedFixture();
    const revision = readRun(fixture).revision;
    const envelope = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      commandId: randomUUID(),
      issuedAt: new Date().toISOString(),
      operation: 'execution.pause',
      scope: { kind: 'project', projectId: fixture.ids.projectId },
      expectedRevision: revision,
      payload: { runId: fixture.ids.runId, batchId: null },
    };
    const restricted = createRestrictedPrincipal({
      capabilities: ['receipts.read'],
      projectScope: { kind: 'allowlist', projectIds: [fixture.ids.projectId] },
    });
    // 受限主体缺少 execution.start 能力：同一真实 Host 装配在事务前拒绝。
    await expect(host.core.commandService.submit(restricted, envelope as never)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(readRun(fixture)).toMatchObject({ status: 'queued', revision });

    // 客户端在任何网络请求前拒绝未知键（actor/permissions 注入）、缺失/互斥目标与非法 revision。
    await expect(
      client.pauseExecution({ projectId: fixture.ids.projectId, runId: fixture.ids.runId, expectedRevision: revision, actor: 'admin' } as never),
    ).rejects.toSatisfy(error => isHostProtocolError(error) && error.code === 'invalid_input');
    await expect(
      client.pauseExecution({ projectId: fixture.ids.projectId, expectedRevision: revision }),
    ).rejects.toSatisfy(error => isHostProtocolError(error) && error.code === 'invalid_input');
    await expect(
      client.pauseExecution({
        projectId: fixture.ids.projectId,
        runId: fixture.ids.runId,
        batchId: fixture.ids.batchId,
        expectedRevision: revision,
      }),
    ).rejects.toSatisfy(error => isHostProtocolError(error) && error.code === 'invalid_input');
    await expect(
      client.pauseExecution({ projectId: fixture.ids.projectId, runId: 'not-a-uuid', expectedRevision: revision }),
    ).rejects.toSatisfy(error => isHostProtocolError(error) && error.code === 'invalid_input');
    await expect(
      client.resumeExecution({ projectId: fixture.ids.projectId, runId: fixture.ids.runId, expectedRevision: 0 }),
    ).rejects.toSatisfy(error => isHostProtocolError(error) && error.code === 'invalid_input');
    await expect(
      client.retryFinalExecution({
        projectId: fixture.ids.projectId,
        featureId: fixture.box.featureId,
        historicalRunId: fixture.ids.runId,
        workKey: '',
      }),
    ).rejects.toSatisfy(error => isHostProtocolError(error) && error.code === 'invalid_input');
    expect(readRun(fixture)).toMatchObject({ status: 'queued', revision });
  }, 60_000);

  it('SSE 断开/HostClient 停止 follow 不取消后台执行，状态仍由查询/回执可见', async () => {
    const { fixture, client } = await openHostedFixture();
    const projectId = fixture.ids.projectId;
    const runId = fixture.ids.runId;
    const snapshot = await client.getSnapshot({ kind: 'project', projectId });
    const subscription = await client.subscribeEvents({
      scope: { kind: 'project', projectId },
      cursor: snapshot.watermark.cursor,
      onEvent: () => undefined,
    });
    subscription.close();

    const pause = await client.pauseExecution({ projectId, runId, expectedRevision: 1 });
    expect(completedResult(pause)).toMatchObject({ outcome: 'paused', status: 'paused' });
    // 关闭观察不产生 stop/cancel：运行仍为 paused，而不是 cancelled/interrupted。
    expect(readRun(fixture)).toMatchObject({ status: 'paused', reason: 'user_pause' });
    const control = await client.getRunControl(projectId, runId);
    expect(control.run.status).toBe('paused');
    expect(control.stopOperations).toEqual([]);
    expect(
      fixture.box.session.database
        .prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE operation = ?')
        .get('execution.cancel') as { n: number },
    ).toEqual({ n: 0 });
  }, 60_000);
});

describe('P03-9 / F-014 retryFinal 与恢复诊断纵向', () => {
  it('历史终态 Run 显式 retryFinal 创建受限新 Run；旧 Run 保持终态且恢复查询展示 scope/分轴/预算', async () => {
    const fixture = await prepareEligibleFixture();
    eligibleFixtures.push(fixture);
    const host = await startHost({
      dataRoot: fixture.box.box.dataRoot,
      capabilityCatalog: fixture.box.box.capabilityCatalog,
      env: {},
    });
    hosts.push(host);
    const client = await connectToHost({ canonicalRoot: fixture.box.box.dataRoot });
    clients.push(client);
    const projectId = fixture.box.projectId;
    const oldRunId = fixture.ids.runId;
    const workKey = historicalRunWorkKey(fixture, oldRunId);

    const oldRecovery = await client.getRunRecovery(projectId, oldRunId);
    expect(oldRecovery).toMatchObject({
      scope: 'run-recovery',
      run: { runId: oldRunId, status: 'failed' },
      finalization: { present: false, scope: null },
    });
    expect(oldRecovery.budget.usage).toEqual({ tokenUsed: null, costUsed: null });
    expect(oldRecovery.budget.limits.schemaVersion).toBe(1);

    const retry = await client.retryFinalExecution({
      projectId,
      featureId: fixture.box.featureId,
      historicalRunId: oldRunId,
      workKey,
    });
    const result = completedResult(retry);
    expect(result).toMatchObject({
      retryFinal: true,
      dispatched: true,
      featureId: fixture.box.featureId,
      historicalRunId: oldRunId,
      workKey,
      status: 'queued',
      runtimeStarts: 0,
      attemptsCreated: 0,
    });
    const newRunId = String(result.runId);

    // 旧 Run/证据保持终态；新 Run 的恢复查询展示受限 scope 与零编码承诺。
    expect(
      fixture.box.session.database.prepare('SELECT status FROM runs WHERE id = ?').get(oldRunId),
    ).toEqual({ status: 'failed' });
    const recovery = await client.getRunRecovery(projectId, newRunId);
    expect(recovery).toMatchObject({
      scope: 'run-recovery',
      run: { runId: newRunId, status: 'queued' },
      finalization: {
        present: true,
        scope: {
          kind: 'finalization-only',
          historicalRunId: oldRunId,
          codingTaskIds: [],
          runtimeStarts: 0,
          newAttempts: 0,
        },
      },
      recovery: { attemptsScanned: 0 },
    } as never);
    expect(recovery.finalization.scope?.missingSteps.length).toBeGreaterThan(0);
    expect(recovery.finalization.axes.tasks.allPassed).toBe(true);
    expect(recovery.budget.counters.runtimeStarts).toBe(1);

    // 同一 commandId 重放不重复创建 Run。
    const replayed = await client.retryFinalExecution(
      {
        projectId,
        featureId: fixture.box.featureId,
        historicalRunId: oldRunId,
        workKey,
        commandId: retry.commandId,
      },
      { commandId: retry.commandId, issuedAt: retry.issuedAt },
    );
    expect(replayed.replayed).toBe(true);
    expect(receiptResultRef(replayed)).toBe(receiptResultRef(retry));
    expect(
      (
        fixture.box.session.database
          .prepare('SELECT COUNT(*) AS n FROM runs WHERE batch_id = ?')
          .get(fixture.ids.batchId) as { n: number }
      ).n,
    ).toBe(2);
  }, 120_000);
});

describe('P03-9 / F-014 线响应校验', () => {
  it('控制/恢复响应未知键、未知版本和未知动作被 response_malformed 拒绝', async () => {
    const { fixture, client } = await openHostedFixture();
    const control = await client.getRunControl(fixture.ids.projectId, fixture.ids.runId);
    expect(validateAppQueryResponse('execution.run.control.get', control)).toEqual(control);
    const withSecret = JSON.parse(JSON.stringify(control)) as Record<string, unknown>;
    withSecret['hostInstanceId'] = 'leak';
    expect(() => validateAppQueryResponse('execution.run.control.get', withSecret)).toThrow();
    const unknownVersion = { ...control, schemaVersion: 999 };
    expect(() => validateAppQueryResponse('execution.run.control.get', unknownVersion)).toThrow();
    const unknownAction = JSON.parse(JSON.stringify(control)) as { nextActions: string[] };
    unknownAction.nextActions = ['auto_resume'];
    expect(() => validateAppQueryResponse('execution.run.control.get', unknownAction)).toThrow();

    const recovery = await client.getRunRecovery(fixture.ids.projectId, fixture.ids.runId);
    expect(validateAppQueryResponse('execution.run.recovery.get', recovery)).toEqual(recovery);
    const fakeFinalization = JSON.parse(JSON.stringify(recovery)) as {
      finalization: { present: boolean; scope: unknown };
    };
    fakeFinalization.finalization.present = true;
    expect(() => validateAppQueryResponse('execution.run.recovery.get', fakeFinalization)).toThrow();
    const zeroUsage = JSON.parse(JSON.stringify(recovery)) as {
      budget: { usage: { tokenUsed: number | null } };
    };
    zeroUsage.budget.usage.tokenUsed = 0;
    expect(() => validateAppQueryResponse('execution.run.recovery.get', zeroUsage)).toThrow();

    const batch = await client.getBatchControl(fixture.ids.projectId, fixture.ids.batchId);
    expect(validateAppQueryResponse('execution.batch.control.get', batch)).toEqual(batch);
  }, 60_000);

  it('错误形状稳定：不存在目标不泄漏路径或正文', async () => {
    const { fixture, client } = await openHostedFixture();
    try {
      await client.getRunControl(fixture.ids.projectId, 'missing-run');
      throw new Error('预期 not_found');
    } catch (error) {
      expect(isHostProtocolError(error)).toBe(true);
      const publicError = error as { code: string; details?: unknown };
      expect(publicError.code).toBe('not_found');
      expect(JSON.stringify(publicError.details)).not.toContain('/');
    }
  }, 60_000);
});
