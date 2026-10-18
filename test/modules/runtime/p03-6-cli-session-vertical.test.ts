/**
 * P03-6 / F-013 Work Session 状态/证据与取消接受 CLI 纵向（显式 Fake 测试
 * Host + 真实 SQLite + 真实执行数据；经 `runAppCli`，与 dist/bin.js 同一执行
 * 路径；命令只经过 Host）。
 *
 * 验收面（.dag_context.json F-013）：
 * - 按实际 Host 公共契约扩展现有状态/证据与本项活动取消的参数映射：输出显示
 *   Run/Task/Attempt/Session、实际 Runtime、执行阶段、错误原因、停止状态、
 *   覆盖缺口和制品引用；
 * - accepted、cancel accepted、Runtime completed、stopped confirmed 与
 *   Task/Feature 验收分别表达；未装配 Verifier 时明确等待能力，Synthetic
 *   token 不展示为真实消费，缺退出/耗时信息不填零；
 * - 非法 ID/分页、缺明确取消确认、能力缺失、Host 不可达及畸形响应使用既有
 *   可测退出码；取消响应丢失沿用回执查询和原信封，不额外启动工作；CLI 只访问
 *   Host，不读业务库或直接操作进程。
 *
 * 正式构建 CLI 入口验收见 `p03-6-cli-session-built.test.ts`。
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../../../packages/cli/src/app-execute.ts';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { startFakeHost } from '../../../packages/host/src/testing.ts';
import { createFakeRuntimeGate } from '../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openBindingFixture, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url),
);
const CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('../../helpers/host/detached-host-entry-catalog.ts', import.meta.url),
);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const catalog = () =>
  createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;
let client: HostClient | undefined;
let releaseGates: (() => void)[] = [];

afterEach(async () => {
  releaseGates.forEach((release) => release());
  releaseGates = [];
  client?.close();
  client = undefined;
  const running = host;
  host = undefined;
  if (running !== undefined) {
    await running.close();
  }
  const box = fixture;
  fixture = undefined;
  box?.close();
});

interface WiredCase {
  readonly attemptId: string;
  readonly dataRoot: string;
  readonly projectId: string;
  readonly runId: string;
}

async function openFakeCase(
  script: unknown,
  gates?: Record<string, ReturnType<typeof createFakeRuntimeGate>>,
): Promise<WiredCase> {
  fixture = await openBindingFixture();
  host = await startFakeHost({
    dataRoot: fixture.box.dataRoot,
    capabilityCatalog: catalog(),
    env: {},
    fake: { providers, script, ...(gates !== undefined ? { gates } : {}) },
  });
  client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
  await host.core.workExecution.scan();
  await expect
    .poll(() => fixture!.query('SELECT id FROM attempts') as { id: string } | undefined, {
      timeout: 20_000,
    })
    .toBeDefined();
  const attempt = fixture.query('SELECT id FROM attempts') as { id: string };
  return {
    attemptId: attempt.id,
    dataRoot: fixture.box.dataRoot,
    projectId: fixture.projectId,
    runId: fixture.runId,
  };
}

/* ------------------------------------------------------------------ *
 * runAppCli 驱动（收集 stdout/stderr；与 p03-3/p03-4 纵向同一纪律）
 * ------------------------------------------------------------------ */

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

interface AppInvocation {
  readonly result: AppCliRunResult;
  readonly stdout: string;
  readonly stderr: string;
}

async function runApp(dataRoot: string, args: readonly string[]): Promise<AppInvocation> {
  const collected = collectIo();
  const result = await runAppCli({
    args: [...args, '--data-root', dataRoot],
    io: collected.io,
    env: {},
    launch: {
      entryArgv: ['--import', REGISTER_HOOKS, CATALOG_HOST_ENTRY],
      pollIntervalMs: 50,
    },
  });
  return { result, stdout: collected.stdout(), stderr: collected.stderr() };
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; commandId?: string; details?: Record<string, unknown> };
}

function successResult(invocation: AppInvocation, command: string): Record<string, unknown> {
  expect(invocation.result.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(0);
  const envelope = JSON.parse(invocation.stdout) as EnvelopeShape;
  expect(envelope.ok, invocation.stderr).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failureOf(invocation: AppInvocation, exitCode: number, code: string): void {
  expect(invocation.result.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(exitCode);
  const envelope = JSON.parse(invocation.stdout) as EnvelopeShape;
  expect(envelope.ok).toBe(false);
  expect(envelope.error?.code).toBe(code);
}

/* ------------------------------------------------------------------ *
 * A. 状态/证据输出（完成执行 → 等待验证；证据正文可读）
 * ------------------------------------------------------------------ */

describe('F-013 状态/证据 CLI 纵向（Fake 测试 Host）', () => {
  it('sessions/session/session-evidence 输出 Runtime 结果、停止证据、缺口与制品引用', async () => {
    const wired = await openFakeCase({
      schemaVersion: 1,
      steps: [{ op: 'message', role: 'assistant', text: 'F-013 done' }],
      result: {
        terminal: 'completed',
        reason: null,
        exitCode: 0,
        signal: null,
        durationMs: 12,
        usage: { inputTokens: 10, outputTokens: 5, costUsdMicros: null },
      },
    });
    await expect
      .poll(() => (client!.getWorkSession(wired.projectId, wired.attemptId) as Promise<{ attempt: { status: string } }>).then((d) => d.attempt.status), { timeout: 20_000 })
      .toBe('verifying');

    const list = successResult(
      await runApp(wired.dataRoot, [
        'execution', 'sessions', '--project', wired.projectId, '--run', wired.runId, '--json',
      ]),
      'execution.sessions',
    );
    expect(list.operation).toBe('execution.sessions.list');
    const records = list.records as readonly Record<string, unknown>[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: wired.runId,
      taskId: 't-1',
      attemptId: wired.attemptId,
      runtime: 'fake',
      executionState: 'awaiting_verification',
    });
    const byTask = successResult(
      await runApp(wired.dataRoot, [
        'execution', 'sessions', '--project', wired.projectId, '--task', 't-1', '--json',
      ]),
      'execution.sessions',
    );
    expect((byTask.records as readonly Record<string, unknown>[])[0]).toMatchObject({
      attemptId: wired.attemptId,
    });

    const detail = successResult(
      await runApp(wired.dataRoot, [
        'execution', 'session', wired.attemptId, '--project', wired.projectId, '--json',
      ]),
      'execution.session',
    );
    expect(detail.identity).toMatchObject({
      runId: wired.runId,
      taskId: 't-1',
      attemptId: wired.attemptId,
    });
    expect((detail.identity as Record<string, unknown>).sessionId).toEqual(expect.any(String));
    expect((detail.identity as Record<string, unknown>).resultRef).toEqual(expect.any(String));
    expect(detail.runtime).toMatchObject({ id: 'fake' });
    expect(detail.execution).toMatchObject({ executionStage: 'verification', attemptStatus: 'verifying' });
    expect(detail.stop).toMatchObject({ state: 'confirmed', confirmed: true });
    expect(detail.recording).toMatchObject({ complete: true });
    expect((detail.evidence as readonly Record<string, unknown>[]).length).toBeGreaterThan(0);
    // 五类表达互不折算：执行完成 ≠ 验收；未装配 Verifier 明确等待能力。
    expect(detail.acceptance).toMatchObject({
      runtimeCompleted: true,
      stoppedConfirmed: true,
      awaitingVerification: true,
      verifierAssembled: false,
      taskAccepted: false,
      featureVerified: false,
    });
    // Synthetic 用量不展示为真实消费。
    const usage = (detail.runtimeResult as Record<string, unknown>).usage as Record<string, unknown>;
    expect(usage).toMatchObject({ basis: 'synthetic', realConsumption: false });

    const human = await runApp(wired.dataRoot, [
      'execution', 'session', wired.attemptId, '--project', wired.projectId,
    ]);
    expect(human.result.exitCode).toBe(0);
    expect(human.stdout).toContain('runtime=fake');
    expect(human.stdout).toContain('taskAccepted=false');
    expect(human.stdout).toContain('执行结束不代表验收');

    const artifactId = (detail.identity as Record<string, unknown>).resultRef as string;
    const evidence = successResult(
      await runApp(wired.dataRoot, [
        'execution', 'session-evidence', wired.attemptId, '--project', wired.projectId,
        '--artifact', artifactId, '--json',
      ]),
      'execution.session-evidence',
    );
    expect(evidence.artifact).toMatchObject({ artifactId });
    expect(evidence.content).toContain('runtime-settlement');
    expect(evidence.contentEncoding).toBe('utf8');
  });

  it('非法 ID/分页与缺明确取消确认用既有退出码；不存在实体折叠 not_found', async () => {
    const wired = await openFakeCase({
      schemaVersion: 1,
      steps: [{ op: 'message', role: 'assistant', text: 'F-013' }],
    });
    failureOf(
      await runApp(wired.dataRoot, [
        'execution', 'session', 'not-a-uuid', '--project', wired.projectId, '--json',
      ]),
      2,
      'invalid_input',
    );
    failureOf(
      await runApp(wired.dataRoot, [
        'execution', 'sessions', '--project', wired.projectId, '--run', wired.runId,
        '--limit', '0', '--json',
      ]),
      2,
      'invalid_input',
    );
    failureOf(
      await runApp(wired.dataRoot, [
        'execution', 'cancel', wired.attemptId, '--project', wired.projectId, '--json',
      ]),
      2,
      'invalid_input',
    );
    failureOf(
      await runApp(wired.dataRoot, [
        'execution', 'session', randomUUID(), '--project', wired.projectId, '--json',
      ]),
      1,
      'not_found',
    );
    failureOf(
      await runApp(wired.dataRoot, [
        'execution', 'session-evidence', wired.attemptId, '--project', wired.projectId,
        '--artifact', 'no-such-artifact', '--json',
      ]),
      1,
      'not_found',
    );
  });
});

/* ------------------------------------------------------------------ *
 * B. 取消接受输出（cancel accepted ≠ stopped confirmed；原信封重放）
 * ------------------------------------------------------------------ */

describe('F-013 取消接受 CLI 纵向（Fake 测试 Host）', () => {
  it('cancel accepted 与停止确认分开表达；响应丢失沿用回执查询与原信封', async () => {
    const run = createFakeRuntimeGate();
    const stopped = createFakeRuntimeGate();
    releaseGates.push(run.release, stopped.release);
    const wired = await openFakeCase(
      {
        schemaVersion: 1,
        steps: [{ op: 'await_gate', name: 'run' }],
        lifecycle: { cancel: { acceptOnly: true }, stopped: { gate: 'stopped' } },
      },
      { run, stopped },
    );
    await expect
      .poll(
        () =>
          (fixture!.query('SELECT status FROM sessions WHERE id = (SELECT session_id FROM attempts WHERE id = ?)', wired.attemptId) as { status: string }).status,
        { timeout: 20_000 },
      )
      .toBe('started');

    const commandId = randomUUID();
    const cancelArgs = [
      'execution', 'cancel', wired.attemptId, '--project', wired.projectId,
      '--confirm', '--command-id', commandId, '--json',
    ];
    const first = successResult(
      await runApp(wired.dataRoot, cancelArgs),
      'execution.cancel',
    );
    expect(first.identity).toMatchObject({ attemptId: wired.attemptId });
    expect(first.commandId).toBe(commandId);
    expect(first.replayed).toBe(false);
    expect(first.submission).toMatchObject({ accepted: true, status: 'completed' });
    expect(first.cancel).toMatchObject({ accepted: true, stoppedConfirmed: false });
    expect(first.acceptance).toMatchObject({
      commandAccepted: true,
      cancelAccepted: true,
      stoppedConfirmed: false,
      taskAccepted: false,
      featureVerified: false,
      verifierAssembled: false,
    });

    // 取消响应丢失：沿用回执查询（原信封）即可读到取消受理，不额外启动工作。
    const receipt = successResult(
      await runApp(wired.dataRoot, ['receipt', 'get', commandId, '--json']),
      'receipt.get',
    );
    expect(receipt).toMatchObject({
      commandId,
      status: 'completed',
      result: { attemptId: wired.attemptId, cancellationRequested: true },
    });
    const replay = successResult(
      await runApp(wired.dataRoot, cancelArgs),
      'execution.cancel',
    );
    expect(replay).toMatchObject({ commandId, replayed: true });
    expect(replay.cancel).toMatchObject({ accepted: true, stoppedConfirmed: false });
    expect(fixture!.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(fixture!.query('SELECT runtime_starts FROM execution_batches')).toMatchObject({
      runtime_starts: 1,
    });

    // 停止确认只能由 session 的 stop 证据给出（释放停止门闩后核验）。
    run.release();
    stopped.release();
    await expect
      .poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 20_000 })
      .toEqual([]);
    const settled = successResult(
      await runApp(wired.dataRoot, [
        'execution', 'session', wired.attemptId, '--project', wired.projectId, '--json',
      ]),
      'execution.session',
    );
    expect(settled.execution).toMatchObject({ attemptStatus: 'cancelled' });
    expect(settled.control).toMatchObject({ reason: 'user_cancelled', cancelAccepted: true });
    expect(settled.acceptance).toMatchObject({
      cancelAccepted: true,
      stoppedConfirmed: true,
      taskAccepted: false,
      featureVerified: false,
    });
    expect((settled.stop as Record<string, unknown>).state).toBe('confirmed');
  });

  it('丢失响应后用同一信封补交不产生第二次取消副作用', async () => {
    const run = createFakeRuntimeGate();
    const stopped = createFakeRuntimeGate();
    releaseGates.push(run.release, stopped.release);
    const wired = await openFakeCase(
      {
        schemaVersion: 1,
        steps: [{ op: 'await_gate', name: 'run' }],
        lifecycle: { cancel: { acceptOnly: true }, stopped: { gate: 'stopped' } },
      },
      { run, stopped },
    );
    await expect
      .poll(
        () =>
          (fixture!.query('SELECT status FROM sessions WHERE id = (SELECT session_id FROM attempts WHERE id = ?)', wired.attemptId) as { status: string }).status,
        { timeout: 20_000 },
      )
      .toBe('started');

    // 模拟取消响应丢失：服务端已提交，客户端丢弃响应（原信封留在服务端）。
    const commandId = randomUUID();
    const envelope = {
      schemaVersion: 5,
      commandId,
      issuedAt: new Date().toISOString(),
      operation: 'execution.attempt.cancel',
      scope: { kind: 'project', projectId: wired.projectId },
      payload: { attemptId: wired.attemptId },
    };
    const auth = readFileSync(resolve(wired.dataRoot, 'host/auth.token'), 'utf8');
    await new Promise<void>((resolveDrop, rejectDrop) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: host!.port,
          method: 'POST',
          path: '/v1/commands',
          headers: {
            Authorization: `Bearer ${auth.trim()}`,
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          res.destroy();
          resolveDrop();
        },
      );
      req.on('error', rejectDrop);
      req.end(JSON.stringify(envelope));
    });

    // CLI 沿用回执查询与原信封：同一 --command-id 重放命中服务端摘要重放。
    const replay = successResult(
      await runApp(wired.dataRoot, [
        'execution', 'cancel', wired.attemptId, '--project', wired.projectId,
        '--confirm', '--command-id', commandId, '--json',
      ]),
      'execution.cancel',
    );
    expect(replay).toMatchObject({ commandId, replayed: true });
    expect(replay.cancel).toMatchObject({ accepted: true, stoppedConfirmed: false });
    expect(fixture!.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(fixture!.query('SELECT runtime_starts FROM execution_batches')).toMatchObject({
      runtime_starts: 1,
    });
  });
});
