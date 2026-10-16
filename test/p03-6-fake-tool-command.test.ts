/**
 * P03-6 / F-004 FakeRuntime 受控真实工具命令步骤测试。
 *
 * 验收依据（task_list F-004）：
 * - 工具步骤仅以名称引用可信装配批准的命令定义，以 argv、受控 cwd、白名单
 *   环境及有限输入/输出/工具超时启动既有 CommandProcess；脚本不携带可执行
 *   命令（不提取模型或用户脚本中的 shell 命令），不新建进程监督系统；
 * - launchId/PID/PGID/OS 启动身份经 Core 回调提交到当前 Attempt/占用后才
 *   放行命令；身份提交失败命令不执行；Runtime 本身不打开 SQLite；工具输出
 *   和结果并行有界消费；
 * - 真实临时命令验证成功、非零退出、缺命令、权限拒绝、输出溢出及工具超时，
 *   记录 toolCallId、退出码/信号、实际原因、已知输出和最后活动；工具错误
 *   不冒充 Runtime 或 Task 验收通过；
 * - Runtime stopped 只有文件步骤结束且所有登记受控工具进程组已核验停止才
 *   confirmed；父退子活、身份核验失败与进程监督丢失均不报告已停止；
 * - 真实受控父子进程验证正常取消与身份匹配后的既有升级终止路径，保留已写
 *   代码；测试以有限等待和 finally 精确清理受管进程，不误杀无关进程、不强
 *   制删除产品工作区。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPublishedPid } from './helpers/pid-file.ts';
import {
  createRuntimeExecutionService,
  createStaticRuntimeCapabilityCatalog,
  createStaticRuntimeRegistry,
  validateFakeRuntimeScript,
  validateRuntimeEvent,
} from '../packages/core/src/index.ts';
import type {
  CommandProcessIdentity,
  RuntimeEvent,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeStopEvidence,
} from '../packages/core/src/index.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import { createFakeRuntime, fakeRuntimeCorrelationToken } from '../packages/core/src/adapters/fake-runtime.ts';
import type {
  FakeRuntimeAssembly,
  FakeRuntimeHandle,
  FakeRuntimeToolCommandDefinition,
} from '../packages/core/src/adapters/fake-runtime.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import type { TempSandbox } from './helpers/temp-sandbox.ts';

const FIXED_NOW = Date.parse('2026-10-15T00:00:00.000Z');
const FIXED_ISO = new Date(FIXED_NOW).toISOString();
const sha256 = (value: string | Buffer | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

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
  const sandbox = createTempSandbox('shiploop-p036-f004-');
  return { sandbox, workspace: realpathSync(sandbox.path) };
}

/** 真实 CommandProcess 端口（收窄停止预算以保持测试有界快速）。 */
function realCommandProcess() {
  return createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 });
}

const acknowledge = async (identity: CommandProcessIdentity) => ({ launchId: identity.launchId });

function toolAssembly(
  script: unknown,
  env: FakeSandbox,
  toolCommands: Readonly<Record<string, FakeRuntimeToolCommandDefinition>>,
  options: Record<string, unknown> = {},
): FakeRuntimeAssembly {
  return createFakeRuntime({
    script,
    workspaceRoots: { ws: env.workspace },
    providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
    nowUtcMs: () => FIXED_NOW,
    commandProcess: realCommandProcess(),
    commitCommandIdentity: acknowledge,
    toolCommands,
    ...options,
  });
}

async function startToolHandle(
  script: unknown,
  env: FakeSandbox,
  toolCommands: Readonly<Record<string, FakeRuntimeToolCommandDefinition>>,
  options: Record<string, unknown> = {},
  request: RuntimeExecutionRequest = fakeRequest(),
): Promise<FakeRuntimeHandle> {
  const { adapter } = toolAssembly(script, env, toolCommands, options);
  return (await adapter.start(request)) as FakeRuntimeHandle;
}

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const seen: RuntimeEvent[] = [];
  for await (const item of stream) seen.push(item);
  return seen;
}

/** 条件等待（确定性条件 + 有界超时；非随机睡眠）。 */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 精确清理：只按本测试捕获的 pid 发信号，绝不触碰其他进程。 */
function killIfAlive(pid: number | undefined): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* 已退出 */ }
}

function nodeEval(script: string): readonly string[] {
  return [process.execPath, '--no-warnings', '-e', script];
}

/* ------------------------------------------------------------------ *
 * C1 脚本契约与可信装配边界
 * ------------------------------------------------------------------ */

describe('F-004 脚本契约与可信装配边界', () => {
  it('tool_command 步骤只携带批准命令名称；argv/环境等可执行内容一律拒绝', () => {
    const ok = validateFakeRuntimeScript({
      schemaVersion: 1, steps: [{ op: 'tool_command', name: 'run-checks' }],
    });
    expect(ok.steps[0]).toEqual({ op: 'tool_command', name: 'run-checks' });
    // 脚本携带任何可执行内容（argv/shell/env/未知键）都在校验边界拒绝。
    for (const step of [
      { op: 'tool_command', name: 'x', argv: ['rm', '-rf'] },
      { op: 'tool_command', name: 'x', command: 'rm -rf ~' },
      { op: 'tool_command', name: 'x', environment: { PATH: '/evil' } },
      { op: 'tool_command', name: '不是合法 token!' },
      { op: 'tool_command' },
    ]) {
      expect(() => validateFakeRuntimeScript({ schemaVersion: 1, steps: [step] }))
        .toThrowError(expect.objectContaining({ kind: 'validation' }));
    }
  });

  it('脚本含 tool_command 时缺少进程端口/身份回调/批准定义在装配期 fail-fast', () => {
    const env = openSandbox();
    try {
      const script = { schemaVersion: 1, steps: [{ op: 'tool_command', name: 'echo' }] };
      const definition = { argv: nodeEval('process.stdout.write("x")'), timeoutMs: 5_000 };
      const base = {
        script,
        workspaceRoots: { ws: env.workspace },
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      };
      // 缺 CommandProcess 端口。
      expect(() => createFakeRuntime({
        ...base, commitCommandIdentity: acknowledge, toolCommands: { echo: definition },
      })).toThrowError(TypeError);
      // 缺 Core 身份提交回调。
      expect(() => createFakeRuntime({
        ...base, commandProcess: realCommandProcess(), toolCommands: { echo: definition },
      })).toThrowError(TypeError);
      // 引用未批准命令名。
      expect(() => createFakeRuntime({
        ...base, commandProcess: realCommandProcess(), commitCommandIdentity: acknowledge,
        toolCommands: { other: definition },
      })).toThrowError(TypeError);
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('批准命令定义逐项校验：argv/环境/stdin/超时与输入输出上限全部有界', () => {
    const env = openSandbox();
    try {
      const script = { schemaVersion: 1, steps: [{ op: 'tool_command', name: 'cmd' }] };
      const attempt = (definition: unknown) => () => createFakeRuntime({
        script,
        workspaceRoots: { ws: env.workspace },
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        commandProcess: realCommandProcess(),
        commitCommandIdentity: acknowledge,
        toolCommands: { cmd: definition as FakeRuntimeToolCommandDefinition },
      });
      for (const bad of [
        { argv: [], timeoutMs: 1_000 },
        { argv: [''], timeoutMs: 1_000 },
        { argv: ['a\0b'], timeoutMs: 1_000 },
        { argv: Array.from({ length: 257 }, () => 'a'), timeoutMs: 1_000 },
        { argv: nodeEval('1'), timeoutMs: 0 },
        { argv: nodeEval('1'), timeoutMs: 3_600_001 },
        { argv: nodeEval('1'), timeoutMs: 1_000, maxInputBytes: 65_537 },
        { argv: nodeEval('1'), timeoutMs: 1_000, maxOutputBytes: 0 },
        { argv: nodeEval('1'), timeoutMs: 1_000, maxOutputBytes: 8_388_609 },
        { argv: nodeEval('1'), timeoutMs: 1_000, environment: { 'BAD KEY': 'x' } },
        { argv: nodeEval('1'), timeoutMs: 1_000, environment: { OK: 'va\0l' } },
        { argv: nodeEval('1'), timeoutMs: 1_000, stdin: 'not-bytes' },
      ]) {
        expect(attempt(bad), `定义 ${JSON.stringify(bad)} 必须拒绝`).toThrowError(TypeError);
      }
      // 合法定义通过（有限超时与收窄上限）。
      expect(attempt({
        argv: nodeEval('1'), timeoutMs: 1_000, maxInputBytes: 1_024, maxOutputBytes: 4_096,
        environment: { APPROVED: 'yes' }, stdin: new Uint8Array([1, 2, 3]),
      })).not.toThrow();
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('批准定义在装配时快照：调用方事后篡改 argv/环境/stdin 不影响执行', async () => {
    const env = openSandbox();
    try {
      const argv = [...nodeEval('process.stdout.write(process.env.APPROVED + ":" + new TextDecoder().decode(require("fs").readFileSync(0)))')];
      const environment: Record<string, string> = { APPROVED: 'original' };
      const stdin = new TextEncoder().encode('trusted');
      const handle = await startToolHandle({
        schemaVersion: 1, steps: [{ op: 'tool_command', name: 'snap' }],
      }, env, { snap: { argv, environment, stdin, timeoutMs: 5_000 } });
      argv[2] = 'process.stdout.write("unauthorized")';
      environment.APPROVED = 'changed';
      stdin[0] = 88;
      const events = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      const finished = events.find((event) => event.kind === 'tool_finished');
      expect(finished?.payload).toMatchObject({ exitCode: 0 });
      // digest 证明执行的是快照输入（original:trusted），不是篡改后的内容。
      const ops = handle.inspection.opLog();
      expect(ops[0]?.digest).toBe(sha256('original:trusted'));
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('tool_finished 扩展字段校验：reason/outputBytes/lastActivityAtUtc 可携带且受控', () => {
    const base = {
      schemaVersion: 1, eventId: 'evt.x.1', kind: 'tool_finished', sequence: 1,
      occurredAtUtc: FIXED_ISO,
      payload: { toolCallId: 'call-1', exitCode: 0, signal: null },
    };
    // 旧三键 payload 继续合法。
    expect(validateRuntimeEvent(base).kind).toBe('tool_finished');
    const extended = validateRuntimeEvent({
      ...base,
      payload: {
        ...base.payload, reason: 'timed_out', outputBytes: 128, lastActivityAtUtc: FIXED_ISO,
      },
    });
    expect(extended.payload).toMatchObject({ reason: 'timed_out', outputBytes: 128 });
    for (const payload of [
      { ...base.payload, reason: 'not a reason!' },
      { ...base.payload, outputBytes: -1 },
      { ...base.payload, outputBytes: 1.5 },
      { ...base.payload, lastActivityAtUtc: 'not-a-date' },
      { ...base.payload, unknownKey: 1 },
    ]) {
      expect(() => validateRuntimeEvent({ ...base, payload })).toThrowError(
        expect.objectContaining({ kind: 'protocol' }));
    }
  });
});

/* ------------------------------------------------------------------ *
 * C2 身份提交放行（launchId/PID/PGID/OS 启动身份 → Core 回调 → 才放行）
 * ------------------------------------------------------------------ */

describe('F-004 进程身份提交放行', () => {
  it('身份经 Core 回调提交后才放行命令；提交期间命令不产生任何副作用', async () => {
    const env = openSandbox();
    try {
      const sentinel = join(env.workspace, 'released.txt');
      const request = fakeRequest();
      let observedIdentity: CommandProcessIdentity | undefined;
      let observedContext: { toolCallId: string; attemptId: string | undefined } | undefined;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const handle = await startToolHandle({
        schemaVersion: 1,
        steps: [
          { op: 'tool_command', name: 'write-sentinel' },
          { op: 'message', role: 'assistant', text: 'after-tool' },
        ],
      }, env, {
        'write-sentinel': {
          argv: nodeEval(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`),
          timeoutMs: 10_000,
        },
      }, {
        commitCommandIdentity: async (identity: CommandProcessIdentity, context: unknown) => {
          observedIdentity = identity;
          observedContext = context as { toolCallId: string; attemptId: string | undefined };
          await gate;
          return { launchId: identity.launchId };
        },
      }, request);
      // 提交挂起期间：命令未放行，sentinel 不存在，事件流尚无 tool_started。
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(sentinel)).toBe(false);
      expect(observedIdentity).toBeDefined();
      expect(observedIdentity?.launchId).toMatch(/^[0-9a-f-]{36}$/);
      expect(observedIdentity?.pid).toBeGreaterThan(1);
      expect(observedIdentity?.processGroupId).toBe(observedIdentity?.pid);
      expect(observedIdentity?.startTime).toBeTruthy();
      // 回调上下文关联当前 Attempt 与本次 toolCallId（可独立重算核验）。
      const token = fakeRuntimeCorrelationToken(request);
      expect(observedContext).toEqual({ toolCallId: `tool.${token}.1`, invocationId: 'invocation-1', attemptId: 'attempt-1' });
      release();
      const [events, result] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>), handle.result,
      ]) as [RuntimeEvent[], RuntimeExecutionResult];
      expect(result.terminal).toBe('completed');
      expect(readFileSync(sentinel, 'utf8')).toBe('ran');
      expect(events.map((event) => event.kind)).toEqual(['tool_started', 'tool_finished', 'message']);
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      env.sandbox.cleanup();
    }
  });

  it.each(['reject', 'wrong_launch'] as const)('身份提交失败（%s）命令不执行且运行受控失败', async (mode) => {
    const env = openSandbox();
    try {
      const sentinel = join(env.workspace, 'forbidden.txt');
      let supervisorPid = 0;
      const handle = await startToolHandle({
        schemaVersion: 1,
        steps: [
          { op: 'tool_command', name: 'write-sentinel' },
          { op: 'write_file', path: 'never.txt', content: 'x' },
        ],
      }, env, {
        'write-sentinel': {
          argv: nodeEval(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`),
          timeoutMs: 10_000,
        },
      }, {
        commitCommandIdentity: async (identity: CommandProcessIdentity) => {
          supervisorPid = identity.pid;
          if (mode === 'reject') throw new Error('injected commit failure');
          return { launchId: `${identity.launchId}-wrong` };
        },
      });
      const result = await handle.result as RuntimeExecutionResult;
      expect(result.terminal).toBe('failed');
      expect(result.reason).toBe('tool_identity_commit_failed');
      // 命令从未放行；后续步骤不执行。
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(join(env.workspace, 'never.txt'))).toBe(false);
      const events = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      expect(events.some((event) => event.kind === 'tool_started')).toBe(false);
      const ops = handle.inspection.opLog();
      expect(ops.map((op) => `${op.op}:${op.outcome}:${op.reason}`)).toEqual([
        'tool_command:failed:tool_identity_commit_failed',
      ]);
      // 监督进程已被既有 CommandProcess 清理并核验缺席：stopped 仍 confirmed。
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
      expect(() => process.kill(supervisorPid, 0)).toThrow();
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C3 真实工具结果记录（成功/非零/缺命令/权限/溢出/超时）
 * ------------------------------------------------------------------ */

describe('F-004 真实工具结果记录', () => {
  it('成功命令：toolCallId 关联、退出码/信号、已知输出与最后活动如实记录', async () => {
    const env = openSandbox();
    try {
      const request = fakeRequest();
      const handle = await startToolHandle({
        schemaVersion: 1, steps: [{ op: 'tool_command', name: 'echo' }],
      }, env, {
        echo: { argv: nodeEval('process.stdout.write("tool-out-42")'), timeoutMs: 5_000 },
      }, {}, request);
      const [events, result, stopped] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>),
        handle.result as Promise<RuntimeExecutionResult>,
        handle.stopped as Promise<RuntimeStopEvidence>,
      ]);
      const token = fakeRuntimeCorrelationToken(request);
      expect(events.map((event) => event.kind)).toEqual(['tool_started', 'tool_finished']);
      expect(events[0]?.payload).toEqual({ toolCallId: `tool.${token}.1`, toolName: 'echo' });
      expect(events[1]?.payload).toEqual({
        toolCallId: `tool.${token}.1`,
        exitCode: 0,
        signal: null,
        reason: null,
        outputBytes: Buffer.byteLength('tool-out-42'),
        lastActivityAtUtc: FIXED_ISO,
      });
      expect(result.terminal).toBe('completed');
      expect(result.lastEventSequence).toBe(2);
      expect(stopped).toMatchObject({ confirmed: true, detail: null });
      const ops = handle.inspection.opLog();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        op: 'tool_command', target: 'echo', outcome: 'ok', reason: null,
        bytes: Buffer.byteLength('tool-out-42'), digest: sha256('tool-out-42'),
        toolCallId: `tool.${token}.1`, exitCode: 0, signal: null,
        lastActivityAtUtc: FIXED_ISO, droppedOutputBytes: 0, stopConfirmed: true,
      });
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('非零退出如实记录且脚本继续执行；工具错误不冒充 Runtime/Task 验收', async () => {
    const env = openSandbox();
    try {
      const handle = await startToolHandle({
        schemaVersion: 1,
        steps: [
          { op: 'tool_command', name: 'exit7' },
          { op: 'write_file', path: 'after.txt', content: '失败后保留进展' },
        ],
        result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: null, usage: null },
      }, env, {
        exit7: { argv: nodeEval('process.exit(7)'), timeoutMs: 5_000 },
      });
      const [events, result] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>),
        handle.result as Promise<RuntimeExecutionResult>,
      ]);
      // 事件如实携带工具真实退出码；op log 记 failed。
      const finished = events.find((event) => event.kind === 'tool_finished');
      expect(finished?.payload).toMatchObject({ exitCode: 7, signal: null, reason: null });
      expect(handle.inspection.opLog()[0]).toMatchObject({ outcome: 'failed', exitCode: 7 });
      // 结果终态来自脚本声明（Fake 无 passed 词汇）；后续步骤照常真实写入。
      expect(result.terminal).toBe('completed');
      expect(readFileSync(join(env.workspace, 'after.txt'), 'utf8')).toBe('失败后保留进展');
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('缺命令与权限拒绝记录实际原因，不折算为成功', async () => {
    const env = openSandbox();
    try {
      const forbidden = join(env.workspace, 'not-executable');
      writeFileSync(forbidden, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
      const handle = await startToolHandle({
        schemaVersion: 1,
        steps: [
          { op: 'tool_command', name: 'missing' },
          { op: 'tool_command', name: 'denied' },
        ],
      }, env, {
        missing: { argv: [join(env.workspace, 'no-such-command')], timeoutMs: 5_000 },
        denied: { argv: [forbidden], timeoutMs: 5_000 },
      });
      const events = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      const finishes = events.filter((event) => event.kind === 'tool_finished');
      expect(finishes.map((event) => event.payload)).toEqual([
        expect.objectContaining({ toolCallId: expect.stringContaining('tool.'), exitCode: null, signal: null, reason: 'missing_command' }),
        expect.objectContaining({ exitCode: null, signal: null, reason: 'permission_denied' }),
      ]);
      const ops = handle.inspection.opLog();
      expect(ops.map((op) => `${op.target}:${op.outcome}:${op.reason}`)).toEqual([
        'missing:failed:missing_command', 'denied:failed:permission_denied',
      ]);
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('输出溢出：保留字节有界、记录丢弃量与实际原因', async () => {
    const env = openSandbox();
    try {
      const handle = await startToolHandle({
        schemaVersion: 1, steps: [{ op: 'tool_command', name: 'flood' }],
      }, env, {
        flood: {
          argv: nodeEval('process.stdout.write("x".repeat(200_000))'),
          timeoutMs: 10_000, maxOutputBytes: 4_096,
        },
      });
      const events = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      const finished = events.find((event) => event.kind === 'tool_finished');
      expect(finished?.payload).toMatchObject({ reason: 'output_overflow', outputBytes: 4_096 });
      const op = handle.inspection.opLog()[0];
      expect(op).toMatchObject({ outcome: 'failed', reason: 'output_overflow', bytes: 4_096 });
      expect(op?.droppedOutputBytes).toBeGreaterThan(0);
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('工具超时：有限工具预算内终止并记录 timed_out 与停止确认', async () => {
    const env = openSandbox();
    try {
      const startedAt = Date.now();
      const handle = await startToolHandle({
        schemaVersion: 1, steps: [{ op: 'tool_command', name: 'hang' }],
      }, env, {
        hang: { argv: nodeEval('setInterval(() => {}, 1_000)'), timeoutMs: 300 },
      });
      const [events, result, stopped] = await Promise.all([
        collect(handle.events as AsyncIterable<RuntimeEvent>),
        handle.result as Promise<RuntimeExecutionResult>,
        handle.stopped as Promise<RuntimeStopEvidence>,
      ]);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      const finished = events.find((event) => event.kind === 'tool_finished');
      expect(finished?.payload).toMatchObject({
        exitCode: null, reason: 'timed_out', lastActivityAtUtc: null,
      });
      expect(result).toMatchObject({ terminal: 'timed_out', reason: 'tool_timeout' });
      expect(stopped.confirmed).toBe(true);
      expect(handle.inspection.opLog()[0]).toMatchObject({
        outcome: 'failed', reason: 'timed_out', bytes: 0, digest: null, stopConfirmed: true,
      });
    } finally {
      env.sandbox.cleanup();
    }
  });

  it('白名单环境、受控 cwd 与有限 stdin 如实传达；工具输出与结果并行有界消费', async () => {
    const env = openSandbox();
    try {
      const probe = join(env.workspace, 'probe.json');
      const handle = await startToolHandle({
        schemaVersion: 1,
        steps: [
          { op: 'tool_command', name: 'probe' },
          { op: 'tool_command', name: 'bulk' },
        ],
      }, env, {
        probe: {
          argv: nodeEval(`let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(probe)},JSON.stringify({cwd:process.cwd(),env:process.env,input:s}))})`),
          environment: { APPROVED: 'yes' },
          stdin: new TextEncoder().encode('bounded-input'),
          timeoutMs: 5_000,
        },
        // 输出超过 CommandProcess 内部缓冲（64 KiB）但低于上限：并行消费不溢出。
        bulk: {
          argv: nodeEval('process.stdout.write("y".repeat(200_000))'),
          timeoutMs: 10_000, maxOutputBytes: 512_000,
        },
      });
      const events = await collect(handle.events as AsyncIterable<RuntimeEvent>);
      const finishes = events.filter((event) => event.kind === 'tool_finished');
      expect(finishes[0]?.payload).toMatchObject({ exitCode: 0, reason: null });
      expect(finishes[1]?.payload).toMatchObject({
        exitCode: 0, reason: null, outputBytes: 200_000,
      });
      const observed = JSON.parse(readFileSync(probe, 'utf8')) as {
        cwd: string; env: Record<string, string>; input: string;
      };
      const { __CF_USER_TEXT_ENCODING: localeMetadata, ...environment } = observed.env;
      if (localeMetadata !== undefined) expect(localeMetadata).toMatch(/^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/i);
      expect(environment).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', APPROVED: 'yes' });
      expect(observed.cwd).toBe(env.workspace);
      expect(observed.input).toBe('bounded-input');
      await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    } finally {
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C4 停止证据聚合：父退子活 / 监督丢失不报告已停止
 * ------------------------------------------------------------------ */

describe('F-004 Runtime 停止证据与受控进程组核验', () => {
  it('父进程退出但子进程仍活跃：结果与停止证据均不结算，取消后升级终止才 confirmed', async () => {
    const env = openSandbox();
    let descendant: number | undefined;
    try {
      const pidFile = join(env.workspace, 'child.pid');
      const handle = await startToolHandle({
        schemaVersion: 1, steps: [{ op: 'tool_command', name: 'orphan' }],
      }, env, {
        orphan: {
          argv: nodeEval(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['--no-warnings','-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref()`),
          timeoutMs: 30_000,
        },
      });
      const iterator = (handle.events as AsyncIterable<RuntimeEvent>)[Symbol.asyncIterator]();
      const started = await iterator.next();
      expect(started.value?.kind).toBe('tool_started');
      await waitFor(() => readPublishedPid(pidFile) !== undefined, '子进程登记有效 pid');
      descendant = readPublishedPid(pidFile);
      expect(descendant).toBeGreaterThan(1);
      // 给运行循环充分推进机会：父进程已退出但子进程活跃时，结果与停止证据
      // 都不得结算（不报告已停止，也不把工具冒充完成）。
      await new Promise((resolve) => setTimeout(resolve, 300));
      let resultSettled = false;
      let stoppedSettled = false;
      void (handle.result as Promise<unknown>).then(() => { resultSettled = true; });
      void (handle.stopped as Promise<unknown>).then(() => { stoppedSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(resultSettled).toBe(false);
      expect(stoppedSettled).toBe(false);
      expect(() => process.kill(descendant as number, 0)).not.toThrow();
      // 取消走既有身份匹配升级终止：整个受控组核验缺席后才 confirmed。
      await handle.cancel();
      const [result, stopped] = await Promise.all([
        handle.result as Promise<RuntimeExecutionResult>,
        handle.stopped as Promise<RuntimeStopEvidence>,
      ]);
      for (;;) {
        const item = await iterator.next();
        if (item.done === true) break;
      }
      expect(result.terminal).toBe('cancelled');
      expect(stopped.confirmed).toBe(true);
      await waitFor(() => {
        try {
          process.kill(descendant as number, 0);
          return false;
        } catch {
          return true;
        }
      }, '受控组停止核验');
      descendant = undefined; // 已核验死亡，finally 不再触碰。
    } finally {
      killIfAlive(descendant);
      env.sandbox.cleanup();
    }
  });

  it('进程监督丢失：supervisor 被杀而受控命令仍活跃时不报告已停止', async () => {
    const env = openSandbox();
    let supervisor: CommandProcessIdentity | undefined;
    let commandPid: number | undefined;
    try {
      const pidFile = join(env.workspace, 'tool.pid');
      const handle = await startToolHandle({
        schemaVersion: 1, steps: [{ op: 'tool_command', name: 'watched' }],
      }, env, {
        watched: {
          argv: nodeEval(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`),
          timeoutMs: 30_000,
        },
      }, {
        commitCommandIdentity: async (identity: CommandProcessIdentity) => {
          supervisor = identity;
          return { launchId: identity.launchId };
        },
      });
      const iterator = (handle.events as AsyncIterable<RuntimeEvent>)[Symbol.asyncIterator]();
      const started = await iterator.next();
      expect(started.value?.kind).toBe('tool_started');
      // 监督者真实失联（SIGKILL），受控命令进程仍活跃在同组。
      await waitFor(() => readPublishedPid(pidFile) !== undefined, '工具命令写入有效 pid');
      commandPid = readPublishedPid(pidFile);
      process.kill((supervisor as CommandProcessIdentity).pid, 'SIGKILL');
      const [result, stopped] = await Promise.all([
        handle.result as Promise<RuntimeExecutionResult>,
        handle.stopped as Promise<RuntimeStopEvidence>,
      ]);
      for (;;) {
        const item = await iterator.next();
        if (item.done === true) break;
      }
      expect(result.terminal).toBe('completed');
      expect(stopped.confirmed).toBe(false);
      const op = handle.inspection.opLog()[0];
      expect(op).toMatchObject({ outcome: 'failed', reason: 'supervisor_lost', stopConfirmed: false });
      expect(stopped.detail).toContain(String(op?.toolCallId));
      expect(() => process.kill(commandPid as number, 0)).not.toThrow();
    } finally {
      killIfAlive(commandPid);
      if (commandPid !== undefined) {
        await waitFor(() => {
          try {
            process.kill(commandPid as number, 0);
            return false;
          } catch {
            return true;
          }
        }, '失联工具进程清理');
      }
      env.sandbox.cleanup();
    }
  });

  it('正常取消走既有身份匹配升级终止路径：受控父子同组核验停止，已写代码保留', async () => {
    const env = openSandbox();
    let descendant: number | undefined;
    try {
      const pidFile = join(env.workspace, 'child.pid');
      const handle = await startToolHandle({
        schemaVersion: 1,
        steps: [
          { op: 'write_file', path: 'kept.txt', content: '取消前写入的字节' },
          { op: 'tool_command', name: 'family' },
        ],
      }, env, {
        family: {
          argv: nodeEval(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['--no-warnings','-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`),
          timeoutMs: 30_000,
        },
      });
      const iterator = (handle.events as AsyncIterable<RuntimeEvent>)[Symbol.asyncIterator]();
      const started = await iterator.next();
      expect(started.value?.kind).toBe('tool_started');
      await waitFor(() => readPublishedPid(pidFile) !== undefined, '子进程登记有效 pid');
      descendant = readPublishedPid(pidFile);
      expect(() => process.kill(descendant as number, 0)).not.toThrow();
      const receipt = await handle.cancel();
      expect(receipt).toEqual({ accepted: true, reason: null });
      const [result, stopped] = await Promise.all([
        handle.result as Promise<RuntimeExecutionResult>,
        handle.stopped as Promise<RuntimeStopEvidence>,
      ]);
      for (;;) {
        const item = await iterator.next();
        if (item.done === true) break;
      }
      expect(result.terminal).toBe('cancelled');
      // 身份匹配后的既有升级终止：整个受控组核验缺席才 confirmed。
      expect(stopped.confirmed).toBe(true);
      await waitFor(() => {
        try {
          process.kill(descendant as number, 0);
          return false;
        } catch {
          return true;
        }
      }, '受控父子进程组停止');
      // 已写代码保留（取消不清除文件进展）。
      expect(readFileSync(join(env.workspace, 'kept.txt'), 'utf8')).toBe('取消前写入的字节');
      descendant = undefined; // 已核验死亡，finally 不再触碰。
    } finally {
      killIfAlive(descendant);
      env.sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C5 结构纪律与端到端会话
 * ------------------------------------------------------------------ */

describe('F-004 结构纪律与端到端会话', () => {
  it('FakeRuntime 复用注入的 CommandProcess 端口：不新建进程监督、不打开 SQLite', async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const source = await readFile(join(repoRoot, 'packages/core/src/adapters/fake-runtime.ts'), 'utf8');
    expect(source).not.toMatch(/node:child_process|adapters\/process|better-sqlite3|drizzle|state-store|\.sqlite|node:net|node:http/);
    const scriptSource = await readFile(join(repoRoot, 'packages/core/src/ports/fake-runtime-script.ts'), 'utf8');
    expect(scriptSource).not.toMatch(/node:fs|node:child_process|better-sqlite3/);
  });

  it('经可信注册表与 RuntimeExecutionService 端到端：扩展工具事件通过会话校验', async () => {
    const env = openSandbox();
    try {
      const { descriptor, adapter } = toolAssembly({
        schemaVersion: 1, steps: [{ op: 'tool_command', name: 'echo' }],
      }, env, {
        echo: { argv: nodeEval('process.stdout.write("e2e")'), timeoutMs: 5_000 },
      });
      const configuration = createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
      ]);
      const registry = createStaticRuntimeRegistry([{ descriptor, adapter }], configuration);
      const service = createRuntimeExecutionService({ configuration, registry });
      const session = await service.start(fakeRequest());
      const [events, result, stopped] = await Promise.all([
        collect(session.events), session.result, session.stopped,
      ]);
      expect(events.map((event) => event.kind)).toEqual(['tool_started', 'tool_finished']);
      expect(events[1]?.payload).toMatchObject({
        exitCode: 0, reason: null, outputBytes: Buffer.byteLength('e2e'), lastActivityAtUtc: FIXED_ISO,
      });
      expect(result.terminal).toBe('completed');
      expect(stopped.confirmed).toBe(true);
      expect(session.query()).toMatchObject({
        eventsEnded: true, resultSettled: true, cancelAccepted: false, stopConfirmed: true,
      });
      expect(session.diagnostics()).toEqual([]);
    } finally {
      env.sandbox.cleanup();
    }
  });
});
