/**
 * P03-6 / F-001 异步 Runtime 会话测试（可控异步适配器 + 可信注册接线）。
 *
 * 验收依据：
 * - start 返回句柄后可查询状态和请求取消；result 只结算一次；
 * - events 结束、cancel accepted、result completed、stopped confirmed 是四个
 *   互相不等价的事实，任何一个都不推出其他；
 * - 未知公开事件保留受限诊断且流继续；序列倒退/超限/未知终态为 protocol 错误；
 * - 缺 Runtime、配置不兼容、权限/隔离无法落实分别拒绝；适配器未授权失败
 *   不冒充其他类别；
 * - 全过程无厂商 SDK、网络或凭据。
 */
import { recoveryRecordingForRequest } from '../../../packages/core/src/application/runtime-recovery-recording.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  validateRuntimeExecutionRequest,
  createRuntimeExecutionService,
  createStaticRuntimeCapabilityCatalog,
  createStaticRuntimeRegistry,
  isRuntimeError,
  RUNTIME_ADAPTER_CONTRACT_VERSION,
} from '../../../packages/core/src/index.ts';
import type { RuntimeError } from '../../../packages/core/src/index.ts';

const ts = '2026-10-15T00:00:00.000Z';
const digest = 'a'.repeat(64);

function inputRef(purpose: string) {
  return {
    projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
    version: 1, contentHash: digest, sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'application/json', origin: { kind: 'artifact' },
  };
}

function validRequest(limits = { timeoutMs: 60_000, maxEvents: 100, maxOutputBytes: 1_048_576 }) {
  return {
    schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1',
    executionVersion: 1, owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1', strategy: { runtime: 'fake', provider: 'provider', model: 'model' },
    prompt: inputRef('prompt'), inputManifest: inputRef('manifest'),
    cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: ['fs.write'], isolation: 'trusted_project' },
    limits, recovery: { mode: 'new' },
  };
}

/** 测试可控事件通道：push/end/fail 由测试显式驱动，无定时器。 */
function createEventChannel() {
  const buffered: unknown[] = [];
  let ended = false;
  let failure: unknown;
  const waiters: Array<() => void> = [];
  const notify = () => { for (const wake of waiters.splice(0)) wake(); };
  return {
    push(event: unknown) { buffered.push(event); notify(); },
    end() { ended = true; notify(); },
    fail(error: unknown) { failure = error; notify(); },
    iterable: {
      [Symbol.asyncIterator]() {
        let index = 0;
        const next = (): Promise<IteratorResult<unknown>> => {
          if (index < buffered.length) return Promise.resolve({ value: buffered[index++], done: false });
          if (failure !== undefined) return Promise.reject(failure);
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(() => { resolve(next()); }));
        };
        return { next };
      },
    },
  };
}

function createControllableAdapter() {
  const channel = createEventChannel();
  let settleResult!: (value: unknown) => void;
  let rejectResult!: (error: unknown) => void;
  let settleStopped!: (value: unknown) => void;
  const result = new Promise<unknown>((resolve, reject) => { settleResult = resolve; rejectResult = reject; });
  const stopped = new Promise<unknown>((resolve) => { settleStopped = resolve; });
  const cancelResponse: { current: unknown } = { current: { accepted: true, reason: null } };
  const cancel = vi.fn(async () => cancelResponse.current);
  const handle = { events: channel.iterable, result, stopped, cancel };
  const start = vi.fn(async (_request: unknown) => handle);
  return {
    adapter: { start },
    start,
    cancel,
    channel,
    settleResult: (value: unknown) => settleResult(value),
    rejectResult: (error: unknown) => rejectResult(error),
    settleStopped: (value: unknown) => settleStopped(value),
    cancelResponse,
  };
}

function descriptor() {
  return {
    schemaVersion: 1, runtimeId: 'fake', contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterVersion: '1.0', providers: [{ providerId: 'provider', models: ['model'] }],
    permissionGrants: ['fs.write'], isolationModes: ['trusted_project'],
  };
}

function harness(adapter: { start: unknown }) {
  const configuration = createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'fake', providers: [{ providerId: 'provider', models: ['model'] }] },
    { runtimeId: 'unregistered', providers: [{ providerId: 'provider' }] },
  ]);
  const registry = createStaticRuntimeRegistry([{ descriptor: descriptor(), adapter }], configuration);
  const service = createRuntimeExecutionService({ configuration, registry });
  return { configuration, registry, service };
}

function event(sequence: number, kind = 'message', payload: unknown = { messageId: `m-${sequence}`, role: 'assistant', preview: 'x' }) {
  return { schemaVersion: 1, eventId: `event-${sequence}`, kind, sequence, occurredAtUtc: ts, payload };
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const item of stream) seen.push(item);
  return seen;
}

async function expectRuntimeError(promise: Promise<unknown>, kind: string, reason?: string) {
  const error = await promise.then(
    () => { throw new Error(`expected ${kind} rejection, got fulfillment`); },
    (caught: unknown) => caught,
  );
  expect(isRuntimeError(error, kind as never), `expected RuntimeError(${kind}), got ${String(error)}`).toBe(true);
  if (reason !== undefined) expect((error as RuntimeError).reason).toBe(reason);
}

describe('F-001 start 返回句柄后可查询状态与请求取消', () => {
  it('[case:recovery-handoff-independent] preserves and validates recovery handoff without settling result, events or stop', async () => {
    const request = validateRuntimeExecutionRequest({ ...validRequest(), recovery: { mode: 'auto', kind: 'conversation' } });
    const facts = recoveryRecordingForRequest(request)!;
    for (const invalid of [false, true]) {
      const fake = createControllableAdapter();
      const { service } = harness({ start: async (request: unknown) => ({ ...await fake.adapter.start(request),
        recoveryRecording: Promise.resolve(invalid ? { ...facts, credentials: 'never allowed' } : facts) }) });
      const session = await service.start(request);
      if (invalid) await expect(session.recoveryRecording).rejects.toThrow();
      else await expect(session.recoveryRecording).resolves.toEqual(facts);
      expect(session.query()).toMatchObject({ eventsEnded: false, resultSettled: false, stopConfirmed: null });
    }
  });

  it('返回会话句柄，初始四项事实均未成立；适配器收到的是分离的已校验请求', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const request = validRequest();
    const session = await service.start(request);
    expect(session.invocationId).toBe('invocation-1');
    expect(session.query()).toEqual({
      invocationId: 'invocation-1', eventsEnded: false, resultSettled: false,
      cancelAccepted: false, stopConfirmed: null,
    });
    const received = fake.start.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(received).not.toBe(request);
    expect((received.strategy as { model: string }).model).toBe('model');
    (request.strategy as { model: string }).model = 'mutated';
    (request.permissions.grants as string[]).push('kernel');
    expect((received.strategy as { model: string }).model).toBe('model');
    expect((received.permissions as { grants: string[] }).grants).toEqual(['fs.write']);
  });
  it('cancel accepted 是独立回执：不结束事件、不结算 result、不确认停止', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const session = await service.start(validRequest());
    fake.cancelResponse.current = { accepted: true, reason: null };
    const receipt = await session.cancel();
    expect(receipt).toEqual({ accepted: true, reason: null });
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    const status = session.query();
    expect(status.cancelAccepted).toBe(true);
    expect(status.eventsEnded).toBe(false);
    expect(status.resultSettled).toBe(false);
    expect(status.stopConfirmed).toBeNull();
    // 取消接受后事件流仍可继续推进（回执不等价于事件结束）。
    fake.channel.push(event(1));
    fake.channel.end();
    await expect(collect(session.events)).resolves.toHaveLength(1);
    expect(session.query().eventsEnded).toBe(true);
    expect(session.query().stopConfirmed).toBeNull();
  });
});

describe('F-001 events 结束 / result completed / stopped confirmed 互不等价', () => {
  it('result 只结算一次且 completed 不推出 stopped', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const session = await service.start(validRequest());
    const result = {
      schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
      durationMs: 5, usage: null, lastEventSequence: 0,
    };
    fake.settleResult(result);
    expect(session.result).toBe(session.result);
    await expect(session.result).resolves.toMatchObject({ terminal: 'completed' });
    await expect(session.result).resolves.toMatchObject({ terminal: 'completed' });
    const status = session.query();
    expect(status.resultSettled).toBe(true);
    expect(status.stopConfirmed).toBeNull();
    expect(status.eventsEnded).toBe(false);
    expect(status.cancelAccepted).toBe(false);
  });
  it('stopped confirmed 独立成立：不推出 result 已结算或事件已结束', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const session = await service.start(validRequest());
    fake.settleStopped({ schemaVersion: 1, confirmed: true, checkedAtUtc: ts, detail: null });
    await expect(session.stopped).resolves.toMatchObject({ confirmed: true });
    const status = session.query();
    expect(status.stopConfirmed).toBe(true);
    expect(status.resultSettled).toBe(false);
    expect(status.eventsEnded).toBe(false);
  });
  it('停止证据 confirmed=false 如实呈现（不冒充已停止）', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const session = await service.start(validRequest());
    fake.settleStopped({ schemaVersion: 1, confirmed: false, checkedAtUtc: ts, detail: 'tool process still active' });
    await expect(session.stopped).resolves.toMatchObject({ confirmed: false });
    expect(session.query().stopConfirmed).toBe(false);
  });
});

describe('F-001 事件流校验与受限诊断', () => {
  it('合法事件按序透传；未知公开事件保留受限诊断且不中断流', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const session = await service.start(validRequest());
    fake.channel.push(event(1));
    fake.channel.push({ ...event(2), kind: 'vendor_metric', payload: { tokens: 999 } });
    fake.channel.push(event(3, 'warning', { code: 'rate_limit_notice', message: 'near limit' }));
    fake.channel.end();
    const seen = await collect(session.events);
    expect(seen.map((item) => (item as { kind: string }).kind)).toEqual(['message', 'warning']);
    const diagnostics = session.diagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('vendor_metric');
    expect(session.query().eventsEnded).toBe(true);
  });
  it('序列倒退与超限是 protocol 错误；同一事件流只能消费一次', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const session = await service.start(validRequest());
    fake.channel.push(event(2));
    fake.channel.push(event(2));
    await expectRuntimeError(collect(session.events), 'protocol', 'sequence_not_monotonic');
    expect(() => session.events[Symbol.asyncIterator]()).toThrowError(
      expect.objectContaining({ kind: 'protocol' }));

    const limited = createControllableAdapter();
    const limitedService = harness(limited.adapter).service;
    const capped = await limitedService.start(validRequest({ timeoutMs: 60_000, maxEvents: 2, maxOutputBytes: 1024 }));
    limited.channel.push(event(1));
    limited.channel.push(event(2));
    limited.channel.push(event(3));
    limited.channel.end();
    await expectRuntimeError(collect(capped.events), 'protocol', 'event_limit_exceeded');
  });
  it('畸形事件（缺序列）是 protocol 错误而非未知事件诊断', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const session = await service.start(validRequest());
    fake.channel.push({ schemaVersion: 1, eventId: 'e-1', kind: 'message', occurredAtUtc: ts, payload: {} });
    await expectRuntimeError(collect(session.events), 'protocol');
  });
});

describe('F-001 结果/停止证据的适配器违约是 protocol 错误', () => {
  it('未知终态拒绝为 protocol 错误（不映射成 failed）', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const session = await service.start(validRequest());
    fake.settleResult({
      schemaVersion: 1, terminal: 'exploded', reason: null, exitCode: null, signal: null,
      durationMs: null, usage: null, lastEventSequence: null,
    });
    await expectRuntimeError(session.result, 'protocol', 'unknown_terminal');
    expect(session.query().resultSettled).toBe(false);
  });
  it('适配器 reject result、停止证据畸形与 cancel 回执畸形都是显式失败', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const session = await service.start(validRequest());
    fake.rejectResult(new Error('vendor exploded'));
    await expectRuntimeError(session.result, 'process');

    const bad = createControllableAdapter();
    const badSession = await harness(bad.adapter).service.start(validRequest());
    bad.settleStopped({ schemaVersion: 1, confirmed: 'yes', checkedAtUtc: ts, detail: null });
    await expectRuntimeError(badSession.stopped, 'protocol');
    bad.cancelResponse.current = { accepted: 'yes' };
    await expectRuntimeError(badSession.cancel(), 'protocol');
  });
});

describe('F-001 start 前拒绝路径（错误分类）', () => {
  it('配置目录未知 runtime/provider/model 是 configuration；已配置未注册是 missing_runtime', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const ghost = validRequest();
    ghost.strategy = { runtime: 'claude', provider: 'provider', model: 'model' };
    await expectRuntimeError(service.start(ghost), 'configuration', 'unknown_runtime');
    const unregistered = validRequest();
    unregistered.strategy = { runtime: 'unregistered', provider: 'provider', model: 'any' };
    await expectRuntimeError(service.start(unregistered), 'missing_runtime', 'runtime_not_registered');
    const badProvider = validRequest();
    badProvider.strategy = { runtime: 'fake', provider: 'other', model: 'model' };
    await expectRuntimeError(service.start(badProvider), 'configuration', 'incompatible_provider');
    const badModel = validRequest();
    badModel.strategy = { runtime: 'fake', provider: 'provider', model: 'other-model' };
    await expectRuntimeError(service.start(badModel), 'configuration', 'unsupported_model');
    expect(fake.start).not.toHaveBeenCalled();
  });
  it('必需权限/隔离能力无法落实是 permission 拒绝', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    const grant = validRequest();
    grant.permissions = { grants: ['fs.write', 'kernel'], isolation: 'trusted_project' };
    await expectRuntimeError(service.start(grant), 'permission', 'grant_not_enforceable');
    const isolation = validRequest();
    isolation.permissions = { grants: ['fs.write'], isolation: 'strong_sandbox' };
    await expectRuntimeError(service.start(isolation), 'permission', 'isolation_not_providable');
    expect(fake.start).not.toHaveBeenCalled();
  });
  it('适配器 start 抛未知异常归为 process；返回非法句柄归为 protocol', async () => {
    const failing = { start: vi.fn(async () => { throw new Error('spawn exploded'); }) };
    await expectRuntimeError(harness(failing).service.start(validRequest()), 'process', 'adapter_start_failed');
    const invalid = { start: vi.fn(async () => ({ result: Promise.resolve({}) })) };
    await expectRuntimeError(harness(invalid).service.start(validRequest()), 'protocol', 'invalid_handle');
  });
  it('请求结构非法仍是 validation 错误（先于任何适配器调用）', async () => {
    const fake = createControllableAdapter();
    const { service } = harness(fake.adapter);
    await expect(service.start({ schemaVersion: 99 })).rejects.toMatchObject({ kind: 'validation' });
    expect(fake.start).not.toHaveBeenCalled();
  });
});
