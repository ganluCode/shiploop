/**
 * P03-6 / F-003 确定性 FakeRuntime 文件执行器与有界异步事件句柄测试。
 *
 * 验收依据（task_list F-003）：
 * - 可信测试入口注入有版本声明式脚本：读取获准输入、真实读写临时 workspace
 *   文件、关联消息/工具事件与结束结果；同脚本同输入产生可核对的同一操作
 *   顺序；无 SDK/网络/登录/模型；
 * - start 返回活动 handle 后脚本异步推进；事件缓冲按数量和字节有界并提供
 *   背压；同时消费事件与 result 的长流不死锁、不无限积累；取消解除等待中
 *   的脚本/队列；
 * - 事件带本次 Session/Attempt/执行代次的可核验关联、严格递增序列、UTC
 *   时间与稳定消息/工具标识；不同 Task 不共享可变状态；唯一结果不能设置
 *   Task passed；
 * - 真实文件覆盖正常改写、tracked/untracked 新进展与写入后失败（字节保留）；
 *   路径越界、符号链接越界、只读权限与输入缺失在相应操作前拒绝；Fake 不
 *   接触 Core 状态库，不宣称强 OS 沙箱；
 * - 脚本仅由可信测试装配以注入对象提供（不是模块/文件/shell）；脚本长度、
 *   操作数量、单次正文与总输出有界；模拟 token 一律 synthetic，未知
 *   usage/cost 为 null。
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createRuntimeExecutionService,
  createStaticRuntimeCapabilityCatalog,
  createStaticRuntimeRegistry,
  ExecutionInputBindingError,
  FAKE_RUNTIME_SCRIPT_MAX_STEPS,
  FAKE_RUNTIME_SCRIPT_TOTAL_BODY_MAX_BYTES,
  FAKE_RUNTIME_STEP_BODY_MAX_BYTES,
  validateFakeRuntimeScript,
} from '../../../packages/core/src/index.ts';
import type {
  BoundExecutionInputReader,
  RuntimeEvent,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
} from '../../../packages/core/src/index.ts';
import {
  createFakeRuntime,
  fakeRuntimeCorrelationToken,
} from '../../../packages/core/src/adapters/fake-runtime.ts';
import type { FakeRuntimeHandle } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import type { TempSandbox } from '../../helpers/temp-sandbox.ts';
import { assertGitAvailable, commitAll, git, initGitRepo } from '../../helpers/git-repo.ts';

const FIXED_NOW = Date.parse('2026-10-15T00:00:00.000Z');
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

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

/** 受限读取能力桩：只服务已绑定用途；缺失/未绑定按绑定契约拒绝。 */
function createStubReader(entries: Readonly<Record<string, string>>): BoundExecutionInputReader {
  return {
    list() {
      return Object.entries(entries).map(([purpose, content]) => ({
        purpose, artifactId: `artifact-${purpose}`, version: 1,
        contentHash: sha256(content), sizeBytes: Buffer.byteLength(content),
        locator: `inputs/${purpose}`, mediaType: 'text/plain',
      }));
    },
    async read(purpose: unknown) {
      if (typeof purpose !== 'string' || !(purpose in entries)) {
        throw new ExecutionInputBindingError('input', 'input_missing', '必需输入缺失');
      }
      const content = Buffer.from(entries[purpose], 'utf8');
      return {
        purpose, artifactId: `artifact-${purpose}`,
        contentHash: sha256(content), sizeBytes: content.byteLength, content,
      };
    },
  };
}

interface FakeSandbox {
  readonly sandbox: TempSandbox;
  readonly workspace: string;
  readonly outside: string;
}

function openSandbox(): FakeSandbox {
  const sandbox = createTempSandbox('shiploop-p036-f003-');
  const workspace = join(sandbox.path, 'workspace');
  const outside = join(sandbox.path, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  return { sandbox, workspace, outside };
}

function assembly(script: unknown, env: FakeSandbox, options: Record<string, unknown> = {}) {
  return createFakeRuntime({
    script,
    workspaceRoots: { ws: env.workspace },
    providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
    nowUtcMs: () => FIXED_NOW,
    ...options,
  });
}

async function startHandle(
  script: unknown, env: FakeSandbox, options: Record<string, unknown> = {},
  request: RuntimeExecutionRequest = fakeRequest(),
): Promise<FakeRuntimeHandle> {
  const { adapter } = assembly(script, env, options);
  return (await adapter.start(request)) as FakeRuntimeHandle;
}

async function collect(stream: AsyncIterable<RuntimeEvent>, perItemDelayMs = 0): Promise<RuntimeEvent[]> {
  const seen: RuntimeEvent[] = [];
  for await (const item of stream) {
    seen.push(item);
    if (perItemDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, perItemDelayMs));
  }
  return seen;
}

/** 条件等待（确定性条件 + 有界超时；非随机睡眠）。 */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ------------------------------------------------------------------ *
 * C5 脚本契约校验（可信装配数据边界；拒绝模块/shell/任意文件来源）
 * ------------------------------------------------------------------ */

describe('F-003 脚本契约校验（版本化声明式数据，非代码）', () => {
  it('合法脚本校验通过且返回与输入分离的副本', () => {
    const script = {
      schemaVersion: 1,
      steps: [
        { op: 'read_input', purpose: 'requirements' },
        { op: 'write_file', path: 'src/a.ts', content: 'export const a = 1;\n' },
        { op: 'message', role: 'assistant', text: '开始执行' },
        { op: 'tool', name: 'lint', exitCode: 0 },
        { op: 'usage', inputTokens: 10, outputTokens: 5, costUsdMicros: null },
      ],
      result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 12, usage: null },
    };
    const validated = validateFakeRuntimeScript(script);
    expect(validated.steps).toHaveLength(5);
    expect(validated.result.terminal).toBe('completed');
    (script.steps[2] as { text: string }).text = '篡改';
    expect((validated.steps[2] as { text: string }).text).toBe('开始执行');
  });

  it('脚本必须是注入对象：字符串/模块说明符/函数/数组一律拒绝', () => {
    for (const bad of ['./evil.js', 'node -e x', () => ({}), [], null, 42]) {
      expect(() => validateFakeRuntimeScript(bad)).toThrowError(
        expect.objectContaining({ kind: 'validation' }));
    }
    // 步骤内携带函数值同样拒绝（数据边界不携带可执行代码）。
    expect(() => validateFakeRuntimeScript({
      schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: () => 'x' }],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
  });

  it('schemaVersion 非 1、未知操作、未知键与路径越界词法一律拒绝', () => {
    expect(() => validateFakeRuntimeScript({ schemaVersion: 2, steps: [] }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateFakeRuntimeScript({ schemaVersion: 1, steps: [{ op: 'shell', cmd: 'rm -rf' }] }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateFakeRuntimeScript({
      schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'x', extra: 1 }],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    for (const path of ['../escape.txt', '/abs/path', 'a\\b.txt', 'a/./b.txt']) {
      expect(() => validateFakeRuntimeScript({
        schemaVersion: 1, steps: [{ op: 'write_file', path, content: 'x' }],
      }), `路径 ${path} 必须拒绝`).toThrowError(expect.objectContaining({ kind: 'validation' }));
    }
  });

  it('脚本长度、操作数量、单次正文与总正文全部有界', () => {
    const steps = Array.from({ length: FAKE_RUNTIME_SCRIPT_MAX_STEPS + 1 },
      (_, index) => ({ op: 'message', role: 'assistant', text: `m${index}` }));
    expect(() => validateFakeRuntimeScript({ schemaVersion: 1, steps }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateFakeRuntimeScript({
      schemaVersion: 1,
      steps: [{ op: 'write_file', path: 'a.txt', content: 'x'.repeat(FAKE_RUNTIME_STEP_BODY_MAX_BYTES + 1) }],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    const half = 'y'.repeat(Math.floor(FAKE_RUNTIME_SCRIPT_TOTAL_BODY_MAX_BYTES / 2) + 1);
    expect(() => validateFakeRuntimeScript({
      schemaVersion: 1,
      steps: [
        { op: 'write_file', path: 'a.txt', content: half },
        { op: 'write_file', path: 'b.txt', content: half },
      ],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    // message 文本受事件预览上限约束。
    expect(() => validateFakeRuntimeScript({
      schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'z'.repeat(201) }],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
  });

  it('usage 只接受 null 或非负整数；result 终态/reason 受控；负值拒绝', () => {
    expect(() => validateFakeRuntimeScript({
      schemaVersion: 1, steps: [{ op: 'usage', inputTokens: -1, outputTokens: null, costUsdMicros: null }],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateFakeRuntimeScript({
      schemaVersion: 1, steps: [],
      result: { terminal: 'passed', reason: null, exitCode: null, signal: null, durationMs: null, usage: null },
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateFakeRuntimeScript({
      schemaVersion: 1, steps: [{ op: 'fail', reason: 'not a token!' }],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    // 合法：未知用量显式 null。
    const ok = validateFakeRuntimeScript({
      schemaVersion: 1, steps: [],
      result: {
        terminal: 'completed', reason: null, exitCode: null, signal: null, durationMs: null,
        usage: { inputTokens: null, outputTokens: null, costUsdMicros: null },
      },
    });
    expect(ok.result.usage).toEqual({ inputTokens: null, outputTokens: null, costUsdMicros: null });
  });
});

/* ------------------------------------------------------------------ *
 * C1 确定性脚本执行：读输入 / 写文件 / 关联事件 / 结束结果
 * ------------------------------------------------------------------ */

describe('F-003 确定性脚本执行与同序可核对', () => {
  it('脚本读取获准输入、真实写文件、发送关联消息/工具事件并结算唯一结果', async () => {
    const env = openSandbox();
    try {
      const script = {
        schemaVersion: 1,
        steps: [
          { op: 'read_input', purpose: 'requirements' },
          { op: 'write_file', path: 'out/result.txt', content: '第一版正文' },
          { op: 'message', role: 'assistant', text: '已写入结果文件' },
          { op: 'tool', name: 'check', exitCode: 0 },
          { op: 'usage', inputTokens: 12, outputTokens: 8, costUsdMicros: null },
        ],
        result: {
          terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: null,
          usage: { inputTokens: 12, outputTokens: 8, costUsdMicros: null },
        },
      };
      mkdirSync(join(env.workspace, 'out'));
      const handle = await startHandle(script, env, {
        reader: createStubReader({ requirements: '# 需求正文\n' }),
      });
      const [events, result] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>), handle.result,
      ]) as [RuntimeEvent[], RuntimeExecutionResult];
      // 真实文件字节。
      expect(readFileSync(join(env.workspace, 'out/result.txt'), 'utf8')).toBe('第一版正文');
      // 事件：消息 + 工具对 + usage（输入读取与文件写入记录在 op log，不占事件流）。
      expect(events.map((event) => event.kind)).toEqual([
        'message', 'tool_started', 'tool_finished', 'usage',
      ]);
      const usageEvent = events[3];
      expect(usageEvent?.payload).toEqual({
        basis: 'synthetic', inputTokens: 12, outputTokens: 8, costUsdMicros: null,
      });
      // 唯一结果：completed，synthetic 用量，绝不携带 Task 验收结论。
      expect(result.terminal).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.usage).toEqual({
        basis: 'synthetic', inputTokens: 12, outputTokens: 8, costUsdMicros: null,
      });
      expect(Object.keys(result).sort()).toEqual([
        'durationMs', 'exitCode', 'lastEventSequence', 'reason', 'schemaVersion', 'signal', 'terminal', 'usage',
      ]);
      expect(result.lastEventSequence).toBe(4);
      // op log：读取带摘要、写入带字节数，操作顺序可核对。
      const ops = handle.inspection.opLog();
      expect(ops.map((op) => `${op.op}:${op.target}:${op.outcome}`)).toEqual([
        'read_input:requirements:ok', 'write_file:out/result.txt:ok',
        'message:assistant:ok', 'tool:check:ok', 'usage:usage:ok',
      ]);
      expect(ops[0]?.digest).toBe(sha256('# 需求正文\n'));
      expect(ops[1]?.bytes).toBe(Buffer.byteLength('第一版正文'));
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('同脚本同输入两次执行产生完全一致的 op log、事件序列与文件内容', async () => {
    const script = {
      schemaVersion: 1,
      steps: [
        { op: 'read_input', purpose: 'spec' },
        { op: 'write_file', path: 'a.txt', content: 'alpha' },
        { op: 'message', role: 'assistant', text: 'done' },
        { op: 'tool', name: 'verify', exitCode: 1 },
      ],
      result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 7, usage: null },
    };
    const runs: Array<{ ops: unknown; events: unknown; result: unknown; file: string }> = [];
    for (let run = 0; run < 2; run += 1) {
      const env = openSandbox();
      try {
        const handle = await startHandle(script, env, { reader: createStubReader({ spec: '规格正文' }) });
        const [events, result] = await Promise.all([
          collect(handle.events as AsyncIterable<RuntimeEvent>), handle.result,
        ]);
        runs.push({
          ops: handle.inspection.opLog(), events, result,
          file: readFileSync(join(env.workspace, 'a.txt'), 'utf8'),
        });
      } finally {
        env.sandbox.cleanup();
      }
    }
    expect(runs[0]).toEqual(runs[1]);
  });

  it('未装配输入读取能力时 read_input 显式失败且后续步骤不执行', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'read_input', purpose: 'requirements' },
          { op: 'write_file', path: 'never.txt', content: 'x' },
        ],
      }, env);
      const result = await handle.result as RuntimeExecutionResult;
      expect(result.terminal).toBe('failed');
      expect(result.reason).toBe('input_reader_missing');
      expect(existsSync(join(env.workspace, 'never.txt'))).toBe(false);
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C2 有界异步事件通道：数量/字节上限、背压、取消解除等待
 * ------------------------------------------------------------------ */

describe('F-003 有界异步事件通道与背压', () => {
  const longScript = (count: number) => ({
    schemaVersion: 1,
    steps: Array.from({ length: count }, (_, index) => ({
      op: 'message', role: 'assistant', text: `消息 ${String(index).padStart(3, '0')} ${'长'.repeat(150)}`,
    })),
    result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: null, usage: null },
  });

  it('start 立即返回活动 handle，脚本随后异步推进', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'write_file', path: 'later.txt', content: '异步写入' }],
      }, env);
      // start 已返回，但脚本推进是异步的：result 是未结算 Promise，
      // 最终仍能完成且文件真实写入。
      let settled = false;
      void (handle.result as Promise<unknown>).then(() => { settled = true; });
      await Promise.resolve();
      const result = await handle.result as RuntimeExecutionResult;
      expect(result.terminal).toBe('completed');
      expect(settled).toBe(true);
      expect(readFileSync(join(env.workspace, 'later.txt'), 'utf8')).toBe('异步写入');
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('长流同时消费事件与 result 不死锁；缓冲数量与字节始终有界', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle(longScript(60), env, {
        buffer: { maxEvents: 4, maxBytes: 1_200 },
      });
      const [events, result] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>, 1), handle.result,
      ]) as [RuntimeEvent[], RuntimeExecutionResult];
      expect(events).toHaveLength(60);
      expect(result.terminal).toBe('completed');
      expect(result.lastEventSequence).toBe(60);
      const water = handle.inspection.highWater();
      expect(water.events).toBeGreaterThan(0);
      expect(water.events).toBeLessThanOrEqual(4);
      expect(water.bytes).toBeLessThanOrEqual(1_200);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('消费者停滞时脚本被背压阻塞；取消解除阻塞并结算 cancelled', async () => {
    const env = openSandbox();
    try {
      const handle = await startHandle(longScript(8), env, {
        buffer: { maxEvents: 2, maxBytes: 100_000 },
      });
      await waitFor(() => handle.inspection.opLog().length >= 2, '背压前两条事件入队');
      const stalled = handle.inspection.opLog().length;
      // 给脚本推进机会：无消费者时缓冲已满，op log 不再增长。
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(handle.inspection.opLog().length).toBe(stalled);
      // 消费一条后背压解除，脚本继续推进一步。
      const iterator = (handle.events as AsyncIterable<RuntimeEvent>)[Symbol.asyncIterator]();
      await iterator.next();
      await waitFor(() => handle.inspection.opLog().length >= stalled + 1, '消费后背压解除');
      // 取消解除仍等待中的脚本：result cancelled、事件流结束、停止确认。
      const receipt = await handle.cancel();
      expect(receipt).toEqual({ accepted: true, reason: null });
      const result = await handle.result as RuntimeExecutionResult;
      expect(result.terminal).toBe('cancelled');
      let remaining = 0;
      for (;;) {
        const item = await iterator.next();
        if (item.done === true) break;
        remaining += 1;
      }
      expect(remaining).toBeLessThanOrEqual(2);
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
      const finalLength = handle.inspection.opLog().length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(handle.inspection.opLog().length).toBe(finalLength);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('字节上限只允许少量事件时仍能逐步推进（不积累正文、不死锁）', async () => {
    const env = openSandbox();
    try {
      // ASCII 短文本：单条事件 JSON 约 200-250 字节，500 字节上限约容 2 条。
      const handle = await startHandle({
        schemaVersion: 1,
        steps: Array.from({ length: 6 }, (_, index) => ({
          op: 'message', role: 'assistant', text: `m${index} ${'x'.repeat(40)}`,
        })),
      }, env, { buffer: { maxEvents: 100, maxBytes: 500 } });
      const [events, result] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>, 2), handle.result,
      ]) as [RuntimeEvent[], RuntimeExecutionResult];
      expect(events).toHaveLength(6);
      expect(result.terminal).toBe('completed');
      expect(handle.inspection.highWater().bytes).toBeLessThanOrEqual(500);
      expect(handle.inspection.highWater().events).toBeLessThanOrEqual(2);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('请求输出上限在超限写入前拒绝（output_limit_exceeded）', async () => {
    const env = openSandbox();
    try {
      const request = fakeRequest({
        limits: { timeoutMs: 60_000, maxEvents: 1_000, maxOutputBytes: 64 },
      });
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: '占掉输出预算的事件正文' },
          { op: 'write_file', path: 'overflow.txt', content: 'x'.repeat(128) },
        ],
      }, env, {}, request);
      const result = await handle.result as RuntimeExecutionResult;
      expect(result.terminal).toBe('failed');
      expect(result.reason).toBe('output_limit_exceeded');
      expect(existsSync(join(env.workspace, 'overflow.txt'))).toBe(false);
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C3 事件关联、序列与 Task 隔离
 * ------------------------------------------------------------------ */

describe('F-003 事件关联与 Task 上下文隔离', () => {
  it('事件携带可核验的 Session/Attempt/执行代次关联、递增序列与 UTC 时间', async () => {
    const env = openSandbox();
    try {
      const request = fakeRequest();
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: 'hello' },
          { op: 'tool', name: 'build', exitCode: 0 },
        ],
      }, env, {}, request);
      const events = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      const token = fakeRuntimeCorrelationToken(request);
      expect(token).toMatch(/^[0-9a-f]{24}$/);
      const message = events[0];
      expect(message?.eventId).toBe(`evt.${token}.1`);
      expect(message?.payload).toMatchObject({ messageId: `msg.${token}.1` });
      expect(events[1]?.payload).toMatchObject({ toolCallId: `tool.${token}.1` });
      expect(events[2]?.payload).toMatchObject({ toolCallId: `tool.${token}.1` });
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      for (const event of events) {
        expect(event.occurredAtUtc).toBe(new Date(FIXED_NOW).toISOString());
      }
      // 关联对身份敏感：任一身份要素变化都改变 token。
      expect(fakeRuntimeCorrelationToken(fakeRequest({ sessionId: 'session-2' }))).not.toBe(token);
      expect(fakeRuntimeCorrelationToken(fakeRequest({ executionVersion: 4 }))).not.toBe(token);
      expect(fakeRuntimeCorrelationToken(fakeRequest({
        identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-2' },
      }))).not.toBe(token);
      expect(fakeRuntimeCorrelationToken(fakeRequest({ invocationId: 'invocation-2' }))).not.toBe(token);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('[case:task-event-isolation] 不同 Task 并发执行不共享 op log、输出缓冲或取消信号', async () => {
    const env = openSandbox();
    try {
      const { adapter } = assembly({
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: 'task message' },
          { op: 'write_file', path: 'shared-name.txt', content: '各自写入' },
        ],
      }, env, { buffer: { maxEvents: 1, maxBytes: 100_000 } });
      const requestA = fakeRequest({
        identity: { purpose: 'work', runId: 'run-1', taskId: 'task-a', attemptId: 'attempt-a' },
        invocationId: 'invocation-a',
      });
      const requestB = fakeRequest({
        sessionId: 'session-2',
        identity: { purpose: 'work', runId: 'run-1', taskId: 'task-b', attemptId: 'attempt-b' },
        invocationId: 'invocation-b',
      });
      const handleA = (await adapter.start(requestA)) as FakeRuntimeHandle;
      const handleB = (await adapter.start(requestB)) as FakeRuntimeHandle;
      // 背压让 A 停住（缓冲 1 条），取消 A；B 必须不受影响地完整完成。
      await waitFor(() => handleA.inspection.opLog().length >= 1, 'A 首条事件入队');
      await handleA.cancel();
      const [eventsB, resultB] = await Promise.all([
        collect(handleB.events as AsyncIterable<RuntimeEvent>), handleB.result,
      ]) as [RuntimeEvent[], RuntimeExecutionResult];
      expect(resultB.terminal).toBe('completed');
      expect(eventsB.length).toBeGreaterThanOrEqual(1);
      const tokenB = fakeRuntimeCorrelationToken(requestB);
      expect(eventsB.every((event) => event.eventId.startsWith(`evt.${tokenB}.`))).toBe(true);
      const resultA = await handleA.result as RuntimeExecutionResult;
      expect(resultA.terminal).toBe('cancelled');
      // op log 互不共享：A 的日志不含 B 的操作，身份互异。
      expect(handleA.inspection.opLog()).not.toBe(handleB.inspection.opLog());
      expect(fakeRuntimeCorrelationToken(requestA)).not.toBe(tokenB);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('经可信注册表与 RuntimeExecutionService 端到端：事件通过契约校验且结果唯一', async () => {
    const env = openSandbox();
    try {
      const { descriptor, adapter } = assembly({
        schemaVersion: 1,
        steps: [{ op: 'message', role: 'assistant', text: '端到端' }],
      }, env);
      const configuration = createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
      ]);
      const registry = createStaticRuntimeRegistry([{ descriptor, adapter }], configuration);
      const service = createRuntimeExecutionService({ configuration, registry });
      const session = await service.start(fakeRequest());
      const [events, result, stopped] = await Promise.all([
        collect(session.events), session.result, session.stopped,
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ role: 'assistant', preview: '端到端' });
      expect(result.terminal).toBe('completed');
      expect(stopped.confirmed).toBe(true);
      expect(session.query()).toMatchObject({
        eventsEnded: true, resultSettled: true, cancelAccepted: false, stopConfirmed: true,
      });
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C4 真实文件进展与操作前拒绝
 * ------------------------------------------------------------------ */

describe('F-003 真实文件进展与安全拒绝', () => {
  it('正常改写 tracked 文件并新建 untracked 文件（真实 Git 状态可核对）', async () => {
    assertGitAvailable();
    const env = openSandbox();
    try {
      initGitRepo(env.workspace);
      writeFileSync(join(env.workspace, 'tracked.txt'), '旧内容\n');
      commitAll(env.workspace, '初始提交');
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'write_file', path: 'tracked.txt', content: '新内容\n' },
          { op: 'write_file', path: 'untracked.txt', content: '新增文件\n' },
        ],
      }, env);
      const result = await handle.result as RuntimeExecutionResult;
      expect(result.terminal).toBe('completed');
      const status = git(['status', '--porcelain'], env.workspace);
      expect(status).toContain(' M tracked.txt');
      expect(status).toContain('?? untracked.txt');
      expect(readFileSync(join(env.workspace, 'tracked.txt'), 'utf8')).toBe('新内容\n');
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('写入后失败与取消后已写字节保留', async () => {
    const env = openSandbox();
    try {
      const failing = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'write_file', path: 'kept.txt', content: '失败前写入的字节' },
          { op: 'fail', reason: 'scripted_failure' },
        ],
      }, env);
      const failed = await failing.result as RuntimeExecutionResult;
      expect(failed.terminal).toBe('failed');
      expect(failed.reason).toBe('scripted_failure');
      expect(readFileSync(join(env.workspace, 'kept.txt'), 'utf8')).toBe('失败前写入的字节');
      const events = await collect(failing.events as AsyncIterable<RuntimeEvent>);
      expect(events.at(-1)?.payload).toMatchObject({ code: 'fake.op_failed' });

      const env2 = openSandbox();
      try {
        const cancelling = await startHandle({
          schemaVersion: 1,
          steps: [
            { op: 'write_file', path: 'kept.txt', content: '取消前写入的字节' },
            { op: 'message', role: 'assistant', text: 'm1' },
            { op: 'message', role: 'assistant', text: 'm2' },
            { op: 'message', role: 'assistant', text: 'm3' },
          ],
        }, env2, { buffer: { maxEvents: 1, maxBytes: 100_000 } });
        await waitFor(() => cancelling.inspection.opLog().some(
          (op) => op.op === 'write_file' && op.outcome === 'ok'), '取消前写入完成');
        await waitFor(() => cancelling.inspection.opLog().length >= 2, '背压阻塞在消息事件');
        await cancelling.cancel();
        const cancelled = await cancelling.result as RuntimeExecutionResult;
        expect(cancelled.terminal).toBe('cancelled');
        expect(readFileSync(join(env2.workspace, 'kept.txt'), 'utf8')).toBe('取消前写入的字节');
      } finally {
        env2.sandbox.cleanup();
      }
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('符号链接祖先越界与叶子符号链接在读写操作前拒绝', async () => {
    const env = openSandbox();
    try {
      writeFileSync(join(env.outside, 'secret.txt'), '沙箱外内容');
      symlinkSync(env.outside, join(env.workspace, 'linked-dir'), 'dir');
      symlinkSync(join(env.outside, 'secret.txt'), join(env.workspace, 'linked-file.txt'));
      const handle = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'write_file', path: 'linked-dir/escape.txt', content: '越界' }],
      }, env);
      const result = await handle.result as RuntimeExecutionResult;
      expect(result.terminal).toBe('failed');
      expect(result.reason).toBe('path_escape');
      expect(existsSync(join(env.outside, 'escape.txt'))).toBe(false);

      const reading = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'read_file', path: 'linked-file.txt' }],
      }, env);
      expect((await reading.result as RuntimeExecutionResult).reason).toBe('symlink_escape');

      const writing = await startHandle({
        schemaVersion: 1,
        steps: [{ op: 'write_file', path: 'linked-file.txt', content: '覆盖' }],
      }, env);
      expect((await writing.result as RuntimeExecutionResult).reason).toBe('symlink_escape');
      expect(readFileSync(join(env.outside, 'secret.txt'), 'utf8')).toBe('沙箱外内容');
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('只读文件在写入操作前拒绝且原字节保留', async () => {
    const env = openSandbox();
    try {
      const target = join(env.workspace, 'readonly.txt');
      writeFileSync(target, '只读原字节');
      chmodSync(target, 0o444);
      try {
        const handle = await startHandle({
          schemaVersion: 1,
          steps: [{ op: 'write_file', path: 'readonly.txt', content: '不应写入' }],
        }, env);
        const result = await handle.result as RuntimeExecutionResult;
        expect(result.terminal).toBe('failed');
        expect(result.reason).toBe('write_denied');
        expect(readFileSync(target, 'utf8')).toBe('只读原字节');
      } finally {
        chmodSync(target, 0o644);
      }
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('缺失文件 / 缺失父目录 / 缺失输入在相应操作前拒绝', async () => {
    const env = openSandbox();
    try {
      const missingFile = await startHandle({
        schemaVersion: 1, steps: [{ op: 'read_file', path: 'nope.txt' }],
      }, env);
      expect((await missingFile.result as RuntimeExecutionResult).reason).toBe('file_missing');

      const missingParent = await startHandle({
        schemaVersion: 1, steps: [{ op: 'write_file', path: 'no-dir/file.txt', content: 'x' }],
      }, env);
      expect((await missingParent.result as RuntimeExecutionResult).reason).toBe('parent_missing');

      const missingInput = await startHandle({
        schemaVersion: 1,
        steps: [
          { op: 'read_input', purpose: 'requirements' },
          { op: 'write_file', path: 'never.txt', content: 'x' },
        ],
      }, env, { reader: createStubReader({}) });
      const result = await missingInput.result as RuntimeExecutionResult;
      expect(result.reason).toBe('input_missing');
      expect(existsSync(join(env.workspace, 'never.txt'))).toBe(false);
      expect(missingInput.inspection.opLog().map((op) => op.outcome)).toEqual(['failed']);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('未知 cwd 根在 start 即拒绝；Fake 不接触 Core 状态库', async () => {
    const env = openSandbox();
    try {
      const { adapter } = assembly({ schemaVersion: 1, steps: [] }, env);
      await expect(adapter.start(fakeRequest({ cwd: { root: 'unknown-root', relativePath: '.' } })))
        .rejects.toMatchObject({ kind: 'configuration', reason: 'cwd_root_unknown' });
      // 结构纪律：适配器源码不导入状态库/ORM/网络（只读源码断言）。
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
      const source = await readFile(join(repoRoot, 'packages/core/src/adapters/fake-runtime.ts'), 'utf8');
      expect(source).not.toMatch(/better-sqlite3|drizzle|state-store|\.sqlite|node:net|node:http/);
    } finally {
      env.sandbox.cleanup();
    }
  });
});
