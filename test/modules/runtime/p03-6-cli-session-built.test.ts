/**
 * P03-6 / F-013 Work Session 状态/证据与取消接受 CLI 正式构建入口验收
 *（`npm run build` 产物 `packages/cli/dist/bin.js`，与生产同一入口 + 显式
 * Fake 测试 Host + 真实执行数据）。
 *
 * 验收面（.dag_context.json F-013 第 4 条）：
 * - 从正式构建 CLI 入口验证状态、证据和取消接受输出（sessions/session/
 *   session-evidence/execution cancel --confirm）；
 * - 关键错误：非法 ID → 退出码 2、缺明确取消确认 → 退出码 2、不存在实体 →
 *   not_found 退出码 1；
 * - 帮助说明 Fake 测试专用、可信项目非强隔离、执行结束不代表验收以及本项
 *   尚无完整 Run 恢复。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME（沙箱 HOME/数据根）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { startFakeHost } from '../../../packages/host/src/testing.ts';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { createFakeRuntimeGate } from '../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openBindingFixture, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI_BIN = resolve(repoRoot, 'packages/cli/dist/bin.js');

const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const catalog = () =>
  createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;
let client: HostClient | undefined;
let releaseGates: (() => void)[] = [];

beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  expect(existsSync(CLI_BIN)).toBe(true);
}, 570_000);

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

afterAll(() => {
  releaseGates.forEach((release) => release());
  releaseGates = [];
});

interface WiredCase {
  readonly attemptId: string;
  readonly dataRoot: string;
  readonly homeDir: string;
  readonly workDir: string;
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
    homeDir: fixture.box.homeDir,
    workDir: fixture.box.root,
    projectId: fixture.projectId,
    runId: fixture.runId,
  };
}

interface CliOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 经正式构建入口执行 CLI（沙箱 HOME/TMPDIR；不继承开发机 SHIPLOOP_* 覆盖）。
 * 必须异步 spawn：测试进程内的 Host HTTP 服务依赖本进程事件循环。
 */
function runBuiltCli(wired: WiredCase, args: readonly string[]): Promise<CliOutcome> {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: wired.homeDir,
    TMPDIR: wired.workDir,
  };
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(
      process.execPath,
      [CLI_BIN, ...args, '--data-root', wired.dataRoot],
      { cwd: wired.workDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('built CLI timeout');
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        rejectSpawn(failure);
        return;
      }
      resolveSpawn({ status, stdout, stderr });
    });
  });
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function okResult(outcome: CliOutcome, command: string): Record<string, unknown> {
  expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
  const envelope = JSON.parse(outcome.stdout) as EnvelopeShape;
  expect(envelope.ok).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failedOutcome(outcome: CliOutcome, status: number, code: string): void {
  expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(status);
  const envelope = JSON.parse(outcome.stdout) as EnvelopeShape;
  expect(envelope.ok).toBe(false);
  expect(envelope.error?.code).toBe(code);
}

describe('F-013 状态/证据/取消接受 CLI 正式构建入口（dist/bin.js + Fake 测试 Host）', () => {
  it('状态与证据输出：sessions/session/session-evidence 经构建入口返回结构化结果', async () => {
    const wired = await openFakeCase({
      schemaVersion: 1,
      steps: [{ op: 'message', role: 'assistant', text: 'F-013 built' }],
      result: {
        terminal: 'completed',
        reason: null,
        exitCode: 0,
        signal: null,
        durationMs: 12,
        usage: { inputTokens: 3, outputTokens: 2, costUsdMicros: null },
      },
    });
    await expect
      .poll(
        () =>
          client!.getWorkSession(wired.projectId, wired.attemptId).then((d) => d.attempt.status),
        { timeout: 20_000 },
      )
      .toBe('verifying');

    const sessions = okResult(
      await runBuiltCli(wired, [
        'execution', 'sessions', '--project', wired.projectId, '--run', wired.runId, '--json',
      ]),
      'execution.sessions',
    );
    expect((sessions.records as readonly Record<string, unknown>[])[0]).toMatchObject({
      attemptId: wired.attemptId,
      runtime: 'fake',
      executionState: 'awaiting_verification',
    });

    const detail = okResult(
      await runBuiltCli(wired, [
        'execution', 'session', wired.attemptId, '--project', wired.projectId, '--json',
      ]),
      'execution.session',
    );
    expect(detail.identity).toMatchObject({ runId: wired.runId, taskId: 't-1', attemptId: wired.attemptId });
    expect(detail.runtime).toMatchObject({ id: 'fake' });
    expect(detail.stop).toMatchObject({ state: 'confirmed', confirmed: true });
    expect(detail.acceptance).toMatchObject({
      runtimeCompleted: true,
      stoppedConfirmed: true,
      verifierAssembled: false,
      taskAccepted: false,
      featureVerified: false,
    });
    expect((detail.runtimeResult as Record<string, unknown>).usage).toMatchObject({
      basis: 'synthetic',
      realConsumption: false,
    });

    const artifactId = (detail.identity as Record<string, unknown>).resultRef as string;
    const evidence = okResult(
      await runBuiltCli(wired, [
        'execution', 'session-evidence', wired.attemptId, '--project', wired.projectId,
        '--artifact', artifactId, '--json',
      ]),
      'execution.session-evidence',
    );
    expect(evidence.artifact).toMatchObject({ artifactId });
    expect(evidence.content).toContain('runtime-settlement');
  });

  it('取消接受输出：--confirm 显式取消；同一 --command-id 原信封重放', async () => {
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
          (fixture!.query(
            'SELECT status FROM sessions WHERE id = (SELECT session_id FROM attempts WHERE id = ?)',
            wired.attemptId,
          ) as { status: string }).status,
        { timeout: 20_000 },
      )
      .toBe('started');

    // 缺明确取消确认：退出码 2（不发取消请求）。
    failedOutcome(
      await runBuiltCli(wired, [
        'execution', 'cancel', wired.attemptId, '--project', wired.projectId, '--json',
      ]),
      2,
      'invalid_input',
    );

    const commandId = randomUUID();
    const cancelArgs = [
      'execution', 'cancel', wired.attemptId, '--project', wired.projectId,
      '--confirm', '--command-id', commandId, '--json',
    ];
    const first = okResult(await runBuiltCli(wired, cancelArgs), 'execution.cancel');
    expect(first.commandId).toBe(commandId);
    expect(first.cancel).toMatchObject({ accepted: true, stoppedConfirmed: false });
    expect(first.acceptance).toMatchObject({
      cancelAccepted: true,
      stoppedConfirmed: false,
      taskAccepted: false,
      featureVerified: false,
    });
    const replay = okResult(await runBuiltCli(wired, cancelArgs), 'execution.cancel');
    expect(replay).toMatchObject({ commandId, replayed: true });
    expect(fixture!.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });

    run.release();
    stopped.release();
    await expect
      .poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 20_000 })
      .toEqual([]);
    const settled = okResult(
      await runBuiltCli(wired, [
        'execution', 'session', wired.attemptId, '--project', wired.projectId, '--json',
      ]),
      'execution.session',
    );
    expect(settled.execution).toMatchObject({ attemptStatus: 'cancelled' });
    expect(settled.acceptance).toMatchObject({ cancelAccepted: true, stoppedConfirmed: true });
  });

  it('关键错误与帮助边界：非法 ID/不存在实体退出码；帮助说明四项边界', async () => {
    const wired = await openFakeCase({
      schemaVersion: 1,
      steps: [{ op: 'message', role: 'assistant', text: 'F-013 errors' }],
    });
    failedOutcome(
      await runBuiltCli(wired, [
        'execution', 'session', 'not-a-uuid', '--project', wired.projectId, '--json',
      ]),
      2,
      'invalid_input',
    );
    failedOutcome(
      await runBuiltCli(wired, [
        'execution', 'session', randomUUID(), '--project', wired.projectId, '--json',
      ]),
      1,
      'not_found',
    );

    const help = await runBuiltCli(wired, ['execution', 'cancel', '--help']);
    expect(help.status).toBe(0);
    for (const statement of [
      'Fake 测试专用',
      '可信项目模式不提供强 OS 隔离',
      '执行结束不代表验收',
      '本项尚无完整 Run 恢复',
    ]) {
      expect(help.stdout, statement).toContain(statement);
    }
  });
});
