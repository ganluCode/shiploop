/**
 * P03-6 / F-005 FakeRuntime 可控故障与生命周期脚本测试。
 *
 * 验收依据（task_list F-005）：
 * - 通过测试专用门闩/受控时钟提供挂起、启动抛错、执行抛错、未知终态、事件
 *   重复/丢失/乱序、长正文、结果先到、事件先结束和 stopped 延迟/未确认
 *   场景，不依赖随机睡眠或真实模型；
 * - cancel accepted 可单独返回而不自动确认停止；result completed 后也可
 *   继续保持真实工具子进程活动；门闩释放后核验实际停止，不用预设布尔值
 *   冒充真实进程已退出；停止核验失败可通过监督边界故障注入表现为未知；
 * - 正常及异常路径最终结果唯一，取消与完成竞争遵循一次结算规则；result
 *   或事件迭代器抛错能被消费方观察；事件水位和缺口与脚本行为一致；
 * - 挂起/错误/退出场景保留已知用量、耗时、最后事件/工具活动及退出码或
 *   信号；无可知原因保持 null/unknown，超时不统一写零，合成用量保持
 *   synthetic 标记；
 * - 各故障以小型脚本和局部契约测试验证，关闭或取消能有界结束测试等待及
 *   事件通道；测试脚本不出现在默认生产 Runtime 列表，不暴露远端注入故障
 *   或任意命令入口；
 * - 恢复边界：Fake 分别覆盖 conversationResume/executionRecovery 能力
 *   差异、required 不降级、重复请求/事件与停止不确定；不冒充真实 SDK
 *   检查点验收（core-design/14-runtime-recovery-and-durable.md）。
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectFakeRuntimeGateRefs,
  createRuntimeExecutionService,
  createStaticRuntimeCapabilityCatalog,
  createStaticRuntimeRecoveryCatalog,
  createStaticRuntimeRegistry,
  decideRuntimeRecovery,
  validateFakeRuntimeScript,
} from '../packages/core/src/index.ts';
import type {
  RuntimeEvent,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeStopEvidence,
} from '../packages/core/src/index.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import { createFakeRuntime, createFakeRuntimeGate } from '../packages/core/src/adapters/fake-runtime.ts';
import type {
  FakeRuntimeAssembly,
  FakeRuntimeGateControl,
  FakeRuntimeHandle,
} from '../packages/core/src/adapters/fake-runtime.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import type { TempSandbox } from './helpers/temp-sandbox.ts';

const FIXED_NOW = Date.parse('2026-10-15T00:00:00.000Z');

function inputRef(purpose: string) {
  return {
    projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
    version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'application/json', origin: { kind: 'artifact' },
  } as const;
}

function fakeRequest(overrides: Record<string, unknown> = {}): RuntimeExecutionRequest {
  return {
    schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1',
    executionVersion: 3, owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1',
    strategy: { runtime: 'fake', provider: 'test-provider', model: 'fake-model' },
    prompt: inputRef('prompt'), inputManifest: inputRef('manifest'),
    cwd: { root: 'ws', relativePath: '.' },
    permissions: { grants: [], isolation: 'trusted_project' },
    limits: { timeoutMs: 60_000, maxEvents: 10_000, maxOutputBytes: 1_048_576 },
    recovery: { mode: 'new' },
    ...overrides,
  } as RuntimeExecutionRequest;
}

interface FakeSandbox {
  readonly sandbox: TempSandbox;
  readonly workspace: string;
}

function openSandbox(): FakeSandbox {
  const sandbox = createTempSandbox('shiploop-p036-f005-');
  return { sandbox, workspace: realpathSync(sandbox.path) };
}

function assembly(
  script: unknown,
  env: FakeSandbox,
  options: Record<string, unknown> = {},
): FakeRuntimeAssembly {
  return createFakeRuntime({
    script,
    workspaceRoots: { ws: env.workspace },
    providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
    nowUtcMs: () => FIXED_NOW,
    ...options,
  });
}

async function startHandle(
  script: unknown,
  env: FakeSandbox,
  options: Record<string, unknown> = {},
  request: RuntimeExecutionRequest = fakeRequest(),
): Promise<FakeRuntimeHandle> {
  return (await assembly(script, env, options).adapter.start(request)) as FakeRuntimeHandle;
}

/** 经可信注册表与执行服务的会话入口（会话层逐项校验适配器产出）。 */
async function startSession(script: unknown, env: FakeSandbox, options: Record<string, unknown> = {}) {
  const { descriptor, adapter } = assembly(script, env, options);
  const configuration = createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
  ]);
  const registry = createStaticRuntimeRegistry([{ descriptor, adapter }], configuration);
  const service = createRuntimeExecutionService({ configuration, registry });
  return service.start(fakeRequest());
}

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const seen: RuntimeEvent[] = [];
  for await (const item of stream) seen.push(item);
  return seen;
}

/** 确定性观察 Promise 是否已结算（有界短等待；不以此驱动正确性，只作观测）。 */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void Promise.resolve(promise).then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  return settled;
}

/** 条件等待（确定性条件 + 有界超时；非随机睡眠）。 */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时: ${label}`);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
  }
}

/** 精确清理：只按本测试捕获的 pid 发信号，绝不触碰其他进程。 */
function killIfAlive(pid: number | undefined): void {
  if (pid === undefined || pid <= 1) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* 已退出 */ }
}

function nodeEval(script: string): readonly string[] {
  return [process.execPath, '--no-warnings', '-e', script];
}

const acknowledge = async (identity: { launchId: string }) => ({ launchId: identity.launchId });

/** 真实 CommandProcess 端口（收窄停止预算以保持测试有界快速）。 */
function realCommandProcess() {
  return createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 });
}

/* ------------------------------------------------------------------ *
 * C1 脚本契约：门闩/raise 步骤与 lifecycle 受控校验
 * ------------------------------------------------------------------ */

describe('F-005 脚本契约：生命周期故障词汇与纯数据边界', () => {
  it('await_gate/raise 步骤与 lifecycle 各节合法通过，返回值与输入分离', () => {
    const input = {
      schemaVersion: 1,
      steps: [
        { op: 'await_gate', name: 'hold-1' },
        { op: 'raise', reason: 'boom' },
      ],
      lifecycle: {
        events: { drop: [2], duplicate: [1], reorderAt: 4, endGate: 'events-gate' },
        result: { gate: 'result-gate', terminalOverride: 'mystery_state' },
        cancel: { acceptOnly: true },
        stopped: { gate: 'stop-gate', unconfirmed: true },
      },
    };
    const validated = validateFakeRuntimeScript(input);
    expect(validated.steps.map((step) => step.op)).toEqual(['await_gate', 'raise']);
    expect(validated.lifecycle).toEqual({
      events: { drop: [2], duplicate: [1], reorderAt: 4, endGate: 'events-gate' },
      result: { gate: 'result-gate', terminalOverride: 'mystery_state' },
      cancel: { acceptOnly: true },
      stopped: { gate: 'stop-gate', unconfirmed: true },
    });
    (input.lifecycle.events.drop as number[]).push(99);
    expect(validated.lifecycle?.events?.drop).toEqual([2]);
    // 无 lifecycle 的既有脚本形态继续合法（v1 增量扩展）。
    expect(validateFakeRuntimeScript({ schemaVersion: 1, steps: [] }).lifecycle).toBeUndefined();
  });

  it('lifecycle 未知键/非法序号/矛盾组合一律拒绝', () => {
    const attempt = (lifecycle: unknown) => () => validateFakeRuntimeScript({
      schemaVersion: 1, steps: [], lifecycle,
    });
    for (const bad of [
      { unknown: true },
      { events: { drop: [0] } },
      { events: { drop: [-1] } },
      { events: { drop: [1.5] } },
      { events: { drop: [100_001] } },
      { events: { drop: [1, 1] } },
      { events: { drop: Array.from({ length: 65 }, (_, index) => index + 1) } },
      { events: { drop: [2], duplicate: [2] } },
      { events: { drop: [3], reorderAt: 3 } },
      { events: { duplicate: [4], reorderAt: 4 } },
      { events: { reorderAt: 0 } },
      { events: { reorderAt: 1.5 } },
      { events: { endGate: 'not a gate!' } },
      { events: { unknownKey: 1 } },
      { result: { terminalOverride: 'completed' } },
      { result: { terminalOverride: 'not a token!' } },
      { result: { unknownKey: 1 } },
      { cancel: { acceptOnly: false } },
      { cancel: { unknownKey: 1 } },
      { stopped: { unconfirmed: false } },
      { stopped: { unknownKey: 1 } },
    ]) {
      expect(attempt(bad), `lifecycle ${JSON.stringify(bad)} 必须拒绝`)
        .toThrowError(expect.objectContaining({ kind: 'validation' }));
    }
  });

  it('脚本与 lifecycle 只能是纯数据：函数/模块说明符等可执行来源一律拒绝', () => {
    for (const bad of [
      { schemaVersion: 1, steps: [{ op: 'await_gate', name: () => undefined }] },
      { schemaVersion: 1, steps: [{ op: 'raise' }] },
      { schemaVersion: 1, steps: [], lifecycle: () => undefined },
      { schemaVersion: 1, steps: [], lifecycle: { result: { gate: './load-module.js' } } },
    ]) {
      expect(() => validateFakeRuntimeScript(bad))
        .toThrowError(expect.objectContaining({ kind: 'validation' }));
    }
  });

  it('collectFakeRuntimeGateRefs 汇总步骤与 lifecycle 引用的全部门闩名', () => {
    const validated = validateFakeRuntimeScript({
      schemaVersion: 1,
      steps: [{ op: 'await_gate', name: 'step-gate' }],
      lifecycle: {
        events: { endGate: 'events-gate' },
        result: { gate: 'step-gate' },
        stopped: { gate: 'stop-gate' },
      },
    });
    expect([...collectFakeRuntimeGateRefs(validated)].sort())
      .toEqual(['events-gate', 'step-gate', 'stop-gate']);
    expect(collectFakeRuntimeGateRefs(validateFakeRuntimeScript({ schemaVersion: 1, steps: [] })))
      .toEqual([]);
  });

  it('脚本引用未装配门闩、门闩缺 wait 或 startFailure 非法均在装配期 fail-fast', () => {
    const env = openSandbox();
    try {
      const gated = { schemaVersion: 1, steps: [{ op: 'await_gate', name: 'missing-gate' }] };
      expect(() => assembly(gated, env)).toThrowError(TypeError);
      expect(() => assembly(gated, env, { gates: { 'missing-gate': { released: false } } }))
        .toThrowError(TypeError);
      for (const startFailure of [
        { kind: 'not_a_kind', reason: 'x' },
        { kind: 'timeout', reason: 'not a reason!' },
        'timeout',
      ]) {
        expect(() => assembly({ schemaVersion: 1, steps: [] }, env, { startFailure }))
          .toThrowError(TypeError);
      }
      // 合法装配通过。
      expect(() => assembly(gated, env, { gates: { 'missing-gate': createFakeRuntimeGate() } }))
        .not.toThrow();
      expect(() => assembly({ schemaVersion: 1, steps: [] }, env, {
        startFailure: { kind: 'timeout', reason: 'injected_start_timeout' },
      })).not.toThrow();
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C2 挂起与门闩（受控时钟，无随机睡眠）
 * ------------------------------------------------------------------ */

describe('F-005 挂起与测试专用门闩', () => {
  it('await_gate 挂起：事件推进到门前、结果不结算；释放后有界完成', async () => {
    const env = openSandbox();
    const gate = createFakeRuntimeGate();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: 'before-gate' },
          { op: 'await_gate', name: 'hold' },
          { op: 'write_file', path: 'after.txt', content: 'gate-released' },
        ],
      }, env, { gates: { hold: gate } });
      const iterator = (handle.events as AsyncIterable<RuntimeEvent>)[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value?.kind).toBe('message');
      // 门闩持有期间：结果与停止证据均不结算，后续步骤不执行（受控挂起）。
      await waitFor(() => handle.inspection.opLog().length >= 1, '门闩前步骤完成');
      expect(await isSettled(handle.result as Promise<unknown>)).toBe(false);
      expect(await isSettled(handle.stopped as Promise<unknown>)).toBe(false);
      expect(existsSync(join(env.workspace, 'after.txt'))).toBe(false);
      gate.release();
      const [result, stopped] = await Promise.all([
        handle.result as Promise<RuntimeExecutionResult>,
        handle.stopped as Promise<RuntimeStopEvidence>,
      ]);
      for (;;) {
        const item = await iterator.next();
        if (item.done === true) break;
      }
      expect(result.terminal).toBe('completed');
      expect(stopped.confirmed).toBe(true);
      expect(readFileSync(join(env.workspace, 'after.txt'), 'utf8')).toBe('gate-released');
      const ops = handle.inspection.opLog();
      expect(ops.map((op) => `${op.op}:${op.outcome}`)).toEqual([
        'message:ok', 'await_gate:ok', 'write_file:ok',
      ]);
    } finally {
      gate.release();
      env.sandbox.cleanup();
    }
  });

  it('挂起中取消：有界结束等待与事件通道，结果唯一结算 cancelled', async () => {
    const env = openSandbox();
    const gate = createFakeRuntimeGate();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'await_gate', name: 'hold' },
          { op: 'write_file', path: 'never.txt', content: 'x' },
        ],
      }, env, { gates: { hold: gate } });
      await waitFor(() => handle.inspection.opLog().length === 0, '运行进入门闩等待');
      const receipt = await handle.cancel();
      expect(receipt).toEqual({ accepted: true, reason: null });
      const [events, result, stopped] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>),
        handle.result as Promise<RuntimeExecutionResult>,
        handle.stopped as Promise<RuntimeStopEvidence>,
      ]);
      expect(events).toEqual([]);
      expect(result).toMatchObject({
        terminal: 'cancelled', exitCode: null, signal: null, durationMs: null, usage: null,
      });
      expect(stopped.confirmed).toBe(true);
      expect(existsSync(join(env.workspace, 'never.txt'))).toBe(false);
      expect(handle.inspection.opLog().map((op) => `${op.op}:${op.outcome}:${op.reason}`))
        .toEqual(['await_gate:failed:cancelled']);
      // 取消后释放门闩不改变唯一结算。
      gate.release();
      expect(await (handle.result as Promise<RuntimeExecutionResult>)).toMatchObject({ terminal: 'cancelled' });
    } finally {
      gate.release();
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C3 启动抛错与执行抛错
 * ------------------------------------------------------------------ */

describe('F-005 启动与执行抛错注入', () => {
  it('启动抛错：start 按注入 kind/reason 拒绝，经会话服务原样透传且不产生事件', async () => {
    const env = openSandbox();
    try {
      const { adapter } = assembly({ schemaVersion: 1, steps: [] }, env, {
        startFailure: { kind: 'timeout', reason: 'injected_start_timeout' },
      });
      await expect(adapter.start(fakeRequest())).rejects.toMatchObject({
        name: 'RuntimeError', kind: 'timeout', reason: 'injected_start_timeout',
      });
      const configuration = createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
      ]);
      const { descriptor } = assembly({ schemaVersion: 1, steps: [] }, env, {
        startFailure: { kind: 'process', reason: 'injected_start_crash' },
      });
      const failingAdapter = assembly({ schemaVersion: 1, steps: [] }, env, {
        startFailure: { kind: 'process', reason: 'injected_start_crash' },
      }).adapter;
      const registry = createStaticRuntimeRegistry([{ descriptor, adapter: failingAdapter }], configuration);
      const service = createRuntimeExecutionService({ configuration, registry });
      await expect(service.start(fakeRequest())).rejects.toMatchObject({
        kind: 'process', reason: 'injected_start_crash',
      });
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('执行抛错（raise）：意外异常折算 internal_error，后续步骤不执行，已写字节保留', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'write_file', path: 'kept.txt', content: 'raise 前真实写入' },
          { op: 'raise', reason: 'boom' },
          { op: 'write_file', path: 'never.txt', content: 'x' },
        ],
      }, env);
      const [events, result, stopped] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>),
        handle.result as Promise<RuntimeExecutionResult>,
        handle.stopped as Promise<RuntimeStopEvidence>,
      ]);
      expect(result).toMatchObject({
        terminal: 'failed', reason: 'internal_error',
        exitCode: null, signal: null, durationMs: null, usage: null,
      });
      expect(stopped.confirmed).toBe(true);
      // 失败诊断如实入队，消费方可观察。
      expect(events.map((event) => event.kind)).toEqual(['diagnostic']);
      expect(events[0]?.payload).toMatchObject({ code: 'fake.op_failed' });
      expect(readFileSync(join(env.workspace, 'kept.txt'), 'utf8')).toBe('raise 前真实写入');
      expect(existsSync(join(env.workspace, 'never.txt'))).toBe(false);
      const ops = handle.inspection.opLog();
      expect(ops.map((op) => `${op.op}:${op.outcome}:${op.reason}`)).toEqual([
        'write_file:ok:null', 'raise:failed:boom',
      ]);
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C4 未知终态
 * ------------------------------------------------------------------ */

describe('F-005 未知终态注入', () => {
  it('terminalOverride 产出词汇外终态：原始句柄可观察，会话层拒绝 unknown_terminal', async () => {
    const env = openSandbox();
    try {
      const script = {
        schemaVersion: 1,
        steps: [{ op: 'message', role: 'assistant', text: 'done' }],
        lifecycle: { result: { terminalOverride: 'mystery_state' } },
      };
      // 原始句柄：结果产出词汇外终态（消费方可观察，不伪造合法值）。
      const raw = await startHandle(script, env);
      const rawResult = await (raw.result as Promise<RuntimeExecutionResult>);
      expect((rawResult as { terminal: string }).terminal).toBe('mystery_state');
      // 会话层：未知终态为 protocol 违约，result 拒绝而非折算 failed。
      const session = await startSession(script, env);
      const events = await collect(session.events);
      expect(events.map((event) => event.kind)).toEqual(['message']);
      await expect(session.result).rejects.toMatchObject({
        kind: 'protocol', reason: 'unknown_terminal',
      });
      expect(session.query()).toMatchObject({
        eventsEnded: true, resultSettled: false, stopConfirmed: true,
      });
      await expect(session.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C5 事件重复 / 丢失 / 乱序 / 长正文
 * ------------------------------------------------------------------ */

describe('F-005 事件流故障注入', () => {
  const threeMessages = {
    schemaVersion: 1,
    steps: [
      { op: 'message', role: 'assistant', text: 'one' },
      { op: 'message', role: 'assistant', text: 'two' },
      { op: 'message', role: 'assistant', text: 'three' },
    ],
  };

  it('事件重复：原始流原样重投（同 eventId/sequence），会话层抛错可被消费方观察', async () => {
    const env = openSandbox();
    try {
      const script = { ...threeMessages, lifecycle: { events: { duplicate: [1] } } };
      const handle = await startHandle(script, env);
      const raw = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      expect(raw.map((event) => event.sequence)).toEqual([1, 1, 2, 3]);
      expect(raw[0]?.eventId).toBe(raw[1]?.eventId);
      const result = await (handle.result as Promise<RuntimeExecutionResult>);
      expect(result.lastEventSequence).toBe(3);
      // 会话层：重复序列触发 protocol 错误，消费方在迭代中观察到抛错。
      const session = await startSession(script, env);
      const seen: number[] = [];
      await expect((async () => {
        for await (const event of session.events) seen.push(event.sequence);
      })()).rejects.toMatchObject({ kind: 'protocol', reason: 'sequence_not_monotonic' });
      expect(seen).toEqual([1]);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('事件丢失：序列照常推进形成缺口，水位与脚本行为一致', async () => {
    const env = openSandbox();
    try {
      const script = { ...threeMessages, lifecycle: { events: { drop: [2] } } };
      const handle = await startHandle(script, env);
      const raw = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      expect(raw.map((event) => event.sequence)).toEqual([1, 3]);
      const result = await (handle.result as Promise<RuntimeExecutionResult>);
      // 水位指向已生成的最后序列（含被丢弃的 2）：缺口对消费方可核对。
      expect(result.lastEventSequence).toBe(3);
      // 会话层：缺口单调可过（不伪造补齐），消费方按水位核对缺口。
      const session = await startSession(script, env);
      const events = await collect(session.events);
      expect(events.map((event) => event.sequence)).toEqual([1, 3]);
      const sessionResult = await session.result;
      expect(sessionResult.lastEventSequence).toBe(3);
      expect(session.query()).toMatchObject({ eventsEnded: true, resultSettled: true });
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('事件乱序：reorderAt 先投 n+1 再投 n，会话层抛错可被消费方观察', async () => {
    const env = openSandbox();
    try {
      const script = { ...threeMessages, lifecycle: { events: { reorderAt: 2 } } };
      const handle = await startHandle(script, env);
      const raw = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      expect(raw.map((event) => event.sequence)).toEqual([1, 3, 2]);
      const session = await startSession(script, env);
      const seen: number[] = [];
      await expect((async () => {
        for await (const event of session.events) seen.push(event.sequence);
      })()).rejects.toMatchObject({ kind: 'protocol', reason: 'sequence_not_monotonic' });
      expect(seen).toEqual([1, 3]);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('长正文：上限内 message/write_file 真实投递与写入，字节计入输出预算', async () => {
    const env = openSandbox();
    try {
      const longMessage = '长'.repeat(200);
      const longBody = 'b'.repeat(200_000);
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: longMessage },
          { op: 'write_file', path: 'long.bin', content: longBody },
        ],
      }, env);
      const [events, result] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>),
        handle.result as Promise<RuntimeExecutionResult>,
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ preview: longMessage });
      expect(result.terminal).toBe('completed');
      expect(readFileSync(join(env.workspace, 'long.bin'), 'utf8')).toBe(longBody);
      const ops = handle.inspection.opLog();
      expect(ops[1]).toMatchObject({ op: 'write_file', outcome: 'ok', bytes: 200_000 });
      // 输出预算收紧到正文之下：超限在写入前失败（长正文不截断不换成功）。
      const limited = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'write_file', path: 'long.bin', content: longBody }],
      }, env, {}, fakeRequest({ limits: { timeoutMs: 60_000, maxEvents: 10_000, maxOutputBytes: 100_000 } }));
      expect(await (limited.result as Promise<RuntimeExecutionResult>)).toMatchObject({
        terminal: 'failed', reason: 'output_limit_exceeded',
      });
      expect(existsSync(join(env.workspace, 'long.bin'))).toBe(true); // 前一次写入保留
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C6 结果先到 / 事件先结束（四项事实互相独立）
 * ------------------------------------------------------------------ */

describe('F-005 事件结束与结果结算独立操控', () => {
  it('结果先到：result 先于事件流结束结算，门闩释放后事件才有界收尾', async () => {
    const env = openSandbox();
    const gate = createFakeRuntimeGate();
    try {
      const script = {
        schemaVersion: 1,
        steps: [{ op: 'message', role: 'assistant', text: 'work-done' }],
        lifecycle: { events: { endGate: 'events-end' } },
      };
      const session = await startSession(script, env, { gates: { 'events-end': gate } });
      const iterator = session.events[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value?.kind).toBe('message');
      // 结果已结算、事件流尚未结束（结果先到不是协议错误）。
      const result = await session.result;
      expect(result.terminal).toBe('completed');
      await waitFor(() => session.query().resultSettled, '结果结算');
      expect(session.query()).toMatchObject({ eventsEnded: false, resultSettled: true });
      gate.release();
      for (;;) {
        const item = await iterator.next();
        if (item.done === true) break;
      }
      expect(session.query()).toMatchObject({ eventsEnded: true, resultSettled: true });
      await expect(session.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      gate.release();
      env.sandbox.cleanup();
    }
  });

  it('事件先结束：事件流先收尾而结果挂起门闩，释放后唯一结算', async () => {
    const env = openSandbox();
    const gate = createFakeRuntimeGate();
    try {
      const script = {
        schemaVersion: 1,
        steps: [{ op: 'message', role: 'assistant', text: 'work-done' }],
        lifecycle: { result: { gate: 'result-gate' } },
      };
      const session = await startSession(script, env, { gates: { 'result-gate': gate } });
      const events = await collect(session.events);
      expect(events.map((event) => event.kind)).toEqual(['message']);
      // 事件流已结束、结果尚未结算（事件先结束，二者互不推出）。
      expect(session.query()).toMatchObject({ eventsEnded: true, resultSettled: false });
      expect(await isSettled(session.result)).toBe(false);
      gate.release();
      const result = await session.result;
      expect(result.terminal).toBe('completed');
      expect(session.query()).toMatchObject({ eventsEnded: true, resultSettled: true });
      await expect(session.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      gate.release();
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C7 取消接受与停止证据独立；真实子进程活动核验
 * ------------------------------------------------------------------ */

describe('F-005 取消接受与停止证据独立性', () => {
  it('cancel acceptOnly：回执单独接受而不中断运行/不确认停止；门闩释放后有界完成', async () => {
    const env = openSandbox();
    const gate = createFakeRuntimeGate();
    const stopGate = createFakeRuntimeGate();
    try {
      const script = {
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: 'before' },
          { op: 'await_gate', name: 'hold' },
          { op: 'message', role: 'assistant', text: 'after' },
        ],
        lifecycle: { cancel: { acceptOnly: true }, stopped: { gate: 'stop-gate' } },
      };
      const session = await startSession(script, env, {
        gates: { hold: gate, 'stop-gate': stopGate },
      });
      const iterator = session.events[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.kind).toBe('message');
      // 第一次取消：仅接受，不自动确认停止、不中断运行。
      const receipt = await session.cancel();
      expect(receipt).toEqual({ accepted: true, reason: null });
      await waitFor(() => session.query().cancelAccepted, '取消回执登记');
      expect(session.query()).toMatchObject({
        cancelAccepted: true, resultSettled: false, stopConfirmed: null,
      });
      expect(await isSettled(session.stopped)).toBe(false);
      // 运行继续：释放挂起门闩后脚本推进到完成，停止证据仍等自己的门闩。
      gate.release();
      const result = await session.result;
      expect(result.terminal).toBe('completed');
      expect(await isSettled(session.stopped)).toBe(false);
      stopGate.release();
      await expect(session.stopped).resolves.toMatchObject({ confirmed: true });
      expect(session.query()).toMatchObject({ stopConfirmed: true });
      // 第二次取消走真实取消语义，幂等且不改变唯一结算。
      expect(await session.cancel()).toEqual({ accepted: true, reason: null });
      expect(await session.result).toMatchObject({ terminal: 'completed' });
      for (;;) {
        const item = await iterator.next();
        if (item.done === true) break;
      }
    } finally {
      gate.release();
      stopGate.release();
      env.sandbox.cleanup();
    }
  });

  it('result completed 后真实工具子进程仍活动；stopped 门闩释放后经真实核验才 confirmed', async () => {
    const env = openSandbox();
    const stopGate = createFakeRuntimeGate();
    let detached: number | undefined;
    try {
      const pidFile = join(env.workspace, 'detached.pid');
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'tool_command', name: 'spawn-detached' }],
        lifecycle: { stopped: { gate: 'stop-gate' } },
      }, env, {
        commandProcess: realCommandProcess(),
        commitCommandIdentity: acknowledge,
        toolCommands: {
          'spawn-detached': {
            argv: nodeEval(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['--no-warnings','-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref()`),
            timeoutMs: 10_000,
          },
        },
        gates: { 'stop-gate': stopGate },
      });
      const events = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      const result = await (handle.result as Promise<RuntimeExecutionResult>);
      expect(result.terminal).toBe('completed');
      expect(events.map((event) => event.kind)).toEqual(['tool_started', 'tool_finished']);
      // 结果完成后 detached 子进程仍真实活动（非受控组；如实存在的副作用）。
      await waitFor(() => existsSync(pidFile), '子进程登记 pid');
      detached = Number(readFileSync(pidFile, 'utf8'));
      expect(detached).toBeGreaterThan(1);
      expect(() => process.kill(detached as number, 0)).not.toThrow();
      // stopped 未结算：不以预设布尔冒充真实进程已退出。
      expect(await isSettled(handle.stopped as Promise<unknown>)).toBe(false);
      // 门闩释放后核验实际受控组状态：受控组真实缺席才 confirmed。
      stopGate.release();
      const stopped = await (handle.stopped as Promise<RuntimeStopEvidence>);
      expect(stopped.confirmed).toBe(true);
      const ops = handle.inspection.opLog();
      expect(ops[0]).toMatchObject({ op: 'tool_command', outcome: 'ok', exitCode: 0, stopConfirmed: true });
      // 真实清理：杀掉遗留子进程并核验实际死亡（不冒充）。
      process.kill(detached, 'SIGKILL');
      await waitFor(() => {
        try {
          process.kill(detached as number, 0);
          return false;
        } catch {
          return true;
        }
      }, '遗留子进程实际停止');
      detached = undefined;
    } finally {
      stopGate.release();
      killIfAlive(detached);
      env.sandbox.cleanup();
    }
  });

  it('停止核验失败注入：stopped 结算 confirmed=false 表现为未知，不冒充已停止', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'message', role: 'assistant', text: 'done' }],
        lifecycle: { stopped: { unconfirmed: true } },
      }, env);
      const [result, stopped] = await Promise.all([
        handle.result as Promise<RuntimeExecutionResult>,
        handle.stopped as Promise<RuntimeStopEvidence>,
      ]);
      expect(result.terminal).toBe('completed');
      expect(stopped.confirmed).toBe(false);
      expect(stopped.detail).toBe('stop_verification_fault');
      // 会话层如实呈现未确认（stopConfirmed=false，调用方必须保留占用）。
      const session = await startSession({
        schemaVersion: 1,
        steps: [],
        lifecycle: { stopped: { unconfirmed: true } },
      }, env);
      await collect(session.events);
      await session.result;
      await expect(session.stopped).resolves.toMatchObject({ confirmed: false });
      expect(session.query()).toMatchObject({ resultSettled: true, stopConfirmed: false });
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C8 结算唯一性与取消/完成竞争
 * ------------------------------------------------------------------ */

describe('F-005 一次结算规则与竞争', () => {
  it('结果门闩等待期间取消：取消胜出唯一结算 cancelled，门闩释放后不覆盖', async () => {
    const env = openSandbox();
    const gate = createFakeRuntimeGate();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'message', role: 'assistant', text: 'work' }],
        lifecycle: { result: { gate: 'result-gate' } },
      }, env, { gates: { 'result-gate': gate } });
      await waitFor(() => handle.inspection.opLog().length >= 1, '步骤完成待结果门闩');
      const receipt = await handle.cancel();
      expect(receipt).toEqual({ accepted: true, reason: null });
      const result = await (handle.result as Promise<RuntimeExecutionResult>);
      expect(result.terminal).toBe('cancelled');
      gate.release();
      // 一次结算：迟到结果不生效。
      expect(await (handle.result as Promise<RuntimeExecutionResult>)).toMatchObject({ terminal: 'cancelled' });
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      gate.release();
      env.sandbox.cleanup();
    }
  });

  it('先完成后取消：结果保持 completed，取消回执幂等接受', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'message', role: 'assistant', text: 'work' }],
      }, env);
      const result = await (handle.result as Promise<RuntimeExecutionResult>);
      expect(result.terminal).toBe('completed');
      expect(await handle.cancel()).toEqual({ accepted: true, reason: null });
      expect(await (handle.result as Promise<RuntimeExecutionResult>)).toMatchObject({ terminal: 'completed' });
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C9 已知指标保留（unknown 不填零、usage 恒 synthetic）
 * ------------------------------------------------------------------ */

describe('F-005 已知指标保留', () => {
  it('错误路径：usage 事件与 failed 结果保留 synthetic 计数；未知指标为显式 null', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'usage', inputTokens: 12, outputTokens: 34, costUsdMicros: 56 },
          { op: 'fail', reason: 'scripted_failure' },
        ],
      }, env);
      const [events, result] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>),
        handle.result as Promise<RuntimeExecutionResult>,
      ]);
      const usage = events.find((event) => event.kind === 'usage');
      expect(usage?.payload).toEqual({
        basis: 'synthetic', inputTokens: 12, outputTokens: 34, costUsdMicros: 56,
      });
      expect(result).toMatchObject({
        terminal: 'failed', reason: 'scripted_failure',
        exitCode: null, signal: null, durationMs: null,
        usage: { basis: 'synthetic', inputTokens: 12, outputTokens: 34, costUsdMicros: 56 },
      });
      // 水位指向实际最后事件（usage + 失败诊断），不统一归零。
      expect(result.lastEventSequence).toBe(events[events.length - 1]?.sequence);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('超时终态声明：已知耗时/用量按声明保留，退出码未知保持 null，basis 恒 synthetic', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'message', role: 'assistant', text: 'partial' }],
        result: {
          terminal: 'timed_out', reason: 'deadline_exceeded', exitCode: null, signal: null,
          durationMs: 1_234, usage: { inputTokens: 5, outputTokens: null, costUsdMicros: null },
        },
      }, env);
      const [events, result] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>),
        handle.result as Promise<RuntimeExecutionResult>,
      ]);
      expect(events).toHaveLength(1);
      expect(result).toEqual({
        schemaVersion: 1, terminal: 'timed_out', reason: 'deadline_exceeded',
        exitCode: null, signal: null, durationMs: 1_234,
        usage: { basis: 'synthetic', inputTokens: 5, outputTokens: null, costUsdMicros: null },
        lastEventSequence: 1,
      });
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C10 恢复能力差异、required 不降级、重复请求与诚实声明
 * ------------------------------------------------------------------ */

describe('F-005 恢复边界（core-design/14）', () => {
  const configuration = () => createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
  ]);

  const capabilities = (executionRecovery: 'verified' | 'unsupported' | 'unverified') => ({
    schemaVersion: 1, runtimeId: 'fake', adapterVersion: '1.0', sdkVersion: null,
    nativeFormats: [{ format: 'fake-native', versions: ['1'] }],
    limits: [],
    capabilities: {
      nativeHistory: { status: 'verified' as const, evidenceRef: 'ev-1', limits: [] },
      conversationResume: { status: 'verified' as const, evidenceRef: 'ev-1', limits: [] },
      executionRecovery: executionRecovery === 'verified'
        ? { status: 'verified' as const, evidenceRef: 'ev-1', limits: [] }
        : { status: executionRecovery, limits: [] },
      modelSwitchOnResume: { status: 'unsupported' as const, limits: [] },
      nativeFork: { status: 'verified' as const, evidenceRef: 'ev-1', limits: [] },
    },
  });

  const recoverySource = (kind: 'conversation' | 'checkpoint') => ({
    schemaVersion: 1, purpose: 'work' as const,
    sourceTaskId: 'task-1', sourceAttemptId: 'attempt-0',
    kind, ...(kind === 'checkpoint' ? { checkpointRef: 'artifact-checkpoint' } : {}),
    sourceProjectId: 'project-1', sourceSessionId: 'session-1',
    runtime: 'fake', provider: 'test-provider', model: 'fake-model',
    providerSessionId: 'provider-session-1', nativeArchiveRef: 'artifact-archive',
    nativeFormat: 'fake-native', nativeFormatVersion: '1', sourceDigest: 'b'.repeat(64),
  });

  const recoveryRequest = (recovery: unknown) => ({
    schemaVersion: 1, projectId: 'project-1', sessionId: 'session-1', executionVersion: 4,
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-9',
    strategy: { runtime: 'fake', provider: 'test-provider', model: 'fake-model' },
    recovery,
  });

  it('conversationResume 与 executionRecovery 分别核验：required 不降级', () => {
    const catalog = createStaticRuntimeRecoveryCatalog([capabilities('unsupported')], configuration());
    const descriptor = catalog.resolve('fake');
    // 仅对话续接 verified：required+conversation 可续接。
    expect(decideRuntimeRecovery(
      recoveryRequest({ mode: 'required', kind: 'conversation', source: recoverySource('conversation') }),
      descriptor,
    )).toEqual({ mode: 'resume', kind: 'conversation', reasons: [] });
    // required+checkpoint：executionRecovery unsupported 明确拒绝，不降级为对话续接。
    const rejected = decideRuntimeRecovery(
      recoveryRequest({ mode: 'required', kind: 'checkpoint', source: recoverySource('checkpoint') }),
      descriptor,
    );
    expect(rejected.mode).toBe('rejected');
    expect(rejected.reasons).toContain('executionRecovery:unsupported');
    // auto+checkpoint：按授权政策降级 new 并记录原因。
    const downgraded = decideRuntimeRecovery(
      recoveryRequest({ mode: 'auto', kind: 'checkpoint', source: recoverySource('checkpoint') }),
      descriptor,
    );
    expect(downgraded.mode).toBe('new');
    expect(downgraded.reasons).toContain('executionRecovery:unsupported');
  });

  it('executionRecovery verified 时 required+checkpoint 决策 resume/checkpoint；unverified fail-closed', () => {
    const verifiedCatalog = createStaticRuntimeRecoveryCatalog([capabilities('verified')], configuration());
    expect(decideRuntimeRecovery(
      recoveryRequest({ mode: 'required', kind: 'checkpoint', source: recoverySource('checkpoint') }),
      verifiedCatalog.resolve('fake'),
    )).toEqual({ mode: 'resume', kind: 'checkpoint', reasons: [] });
    const unverifiedCatalog = createStaticRuntimeRecoveryCatalog([capabilities('unverified')], configuration());
    const rejected = decideRuntimeRecovery(
      recoveryRequest({ mode: 'required', kind: 'checkpoint', source: recoverySource('checkpoint') }),
      unverifiedCatalog.resolve('fake'),
    );
    expect(rejected.mode).toBe('rejected');
    expect(rejected.reasons).toContain('executionRecovery:unverified');
  });

  it('非 new 恢复请求：Fake 如实声明确定性全新执行，不冒充 SDK 检查点验收', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'write_file', path: 'fresh.txt', content: 'fresh-run' }],
      }, env, {}, fakeRequest({
        recovery: { mode: 'auto', kind: 'conversation', source: recoverySource('conversation') },
      }));
      const [events, result] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>),
        handle.result as Promise<RuntimeExecutionResult>,
      ]);
      // 首个事件如实声明：确定性全新执行，无原生检查点/对话状态续接。
      expect(events[0]).toMatchObject({ kind: 'diagnostic', sequence: 1 });
      expect(events[0]?.payload).toMatchObject({ code: 'fake_fresh_execution' });
      expect(result.terminal).toBe('completed');
      expect(readFileSync(join(env.workspace, 'fresh.txt'), 'utf8')).toBe('fresh-run');
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('重复请求：同一请求两次 start 各自全新执行且事件身份稳定全等（Core 去重材料）', async () => {
    const env = openSandbox();
    try {
      const request = fakeRequest();
      const script = {
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: 'same-input' },
          { op: 'usage', inputTokens: 7, outputTokens: 8, costUsdMicros: null },
        ],
      };
      const first = await startHandle(script, env, {}, request);
      const second = await startHandle(script, env, {}, request);
      const [firstEvents, secondEvents] = await Promise.all([
        collect(first.events as AsyncIterable<RuntimeEvent>),
        collect(second.events as AsyncIterable<RuntimeEvent>),
      ]);
      // Fake 不合并重复请求（各自全新执行），但事件身份由请求身份派生、
      // 逐字段全等：Core/Recorder 可按稳定身份去重。
      expect(secondEvents).toEqual(firstEvents);
      expect(secondEvents[0]?.eventId).toBe(firstEvents[0]?.eventId);
      expect(second.inspection.opLog()).toEqual(first.inspection.opLog());
      const [firstResult, secondResult] = await Promise.all([
        first.result as Promise<RuntimeExecutionResult>,
        second.result as Promise<RuntimeExecutionResult>,
      ]);
      expect(secondResult).toEqual(firstResult);
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C11 结构纪律：测试专用装配不进入默认生产 Runtime 列表
 * ------------------------------------------------------------------ */

describe('F-005 结构纪律', () => {
  it('组合根不装配 FakeRuntime；适配器无远端注入故障/任意命令入口', async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const composition = await readFile(join(repoRoot, 'packages/core/src/adapters/composition.ts'), 'utf8');
    // 默认生产组合根不注册测试专用 Fake（无默认生产 Runtime 列表含 fake）。
    expect(composition).not.toMatch(/fake-runtime|createFakeRuntime/);
    const source = await readFile(join(repoRoot, 'packages/core/src/adapters/fake-runtime.ts'), 'utf8');
    // 无远端故障注入入口、无任意命令/模块加载、不接触业务库。
    expect(source).not.toMatch(/node:http|node:net|node:child_process|better-sqlite3|drizzle|node:vm/);
    expect(source).not.toMatch(/\beval\(|new Function/);
    const scriptSource = await readFile(join(repoRoot, 'packages/core/src/ports/fake-runtime-script.ts'), 'utf8');
    expect(scriptSource).not.toMatch(/node:fs|node:child_process|node:http|node:net/);
  });
});
