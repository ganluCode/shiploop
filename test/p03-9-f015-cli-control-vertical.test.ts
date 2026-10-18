/**
 * P03-9 / F-015 CLI 纵向：runAppCli → HostClient → Host → Core（真实 SQLite/Git/
 * worktree/制品 + 显式 FakeRuntime 测试装配；零模型）。
 *
 * 验收面（.dag_context.json F-015 第 1/2/4 条的纵向部分）：
 * - pause/resume/Run 级 cancel/控制诊断/恢复诊断经 CLI 全链路工作：accepted/
 *   completed 输出不宣称已暂停/停止/完成；失败退出语义（revision 冲突=1、
 *   输入错误=2）；
 * - 重复 --command-id 同参数命中服务端摘要重放返回原回执；不同参数 conflict；
 * - retry-final 显式指定历史 Run：CLI 创建受限新 Run、零 Runtime 启动、旧 Run
 *   保持终态；
 * - events 观察退出（snapshot-only 与 follow 中断）不取消后台执行、不发送
 *   stop/cancel。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo } from '../packages/cli/src/app-execute.ts';
import { startFakeHost } from '../packages/host/src/testing.ts';
import { startHost } from '../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { RunningHost } from '../packages/host/src/runtime/index.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import {
  openBindingFixture,
  type BindingFixture,
} from './helpers/p03-6/input-binding-fixture.ts';
import {
  historicalRunWorkKey,
  prepareEligibleFixture,
} from './helpers/p03-9/finalization-retry-fixture.ts';


const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const catalog = () => createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);

interface CliOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: {
    ok: boolean;
    command: string | null;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
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

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;
const retryFixtures: Awaited<ReturnType<typeof prepareEligibleFixture>>[] = [];
const retryHosts: RunningHost[] = [];

afterEach(async () => {
  const running = host;
  host = undefined;
  if (running !== undefined) {
    /* Host 关闭等待基线停止确认（§10.7）：FakeRuntime 调度周期可能仍在处理，
     * 用例断言已完成，这里以有界重试等待 quiesce，不绕过、不吞错。 */
    let lastCloseError: unknown;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await running.close();
        lastCloseError = undefined;
        break;
      } catch (error) {
        lastCloseError = error;
        await delay(1_000);
      }
    }
    if (lastCloseError !== undefined) {
      throw lastCloseError;
    }
  }
  fixture?.close();
  fixture = undefined;
  for (const retryHost of retryHosts.splice(0)) {
    await retryHost.close();
  }
  for (const retryFixture of retryFixtures.splice(0)) {
    retryFixture.box.close();
  }
});

async function runApp(
  args: readonly string[],
  options: {
    readonly dataRoot: string;
    readonly homeDir?: string;
    readonly signal?: AbortSignal;
  },
): Promise<CliOutcome> {
  const collected = collectIo();
  const result = await runAppCli({
    args: [...args, '--data-root', options.dataRoot],
    env: {},
    io: collected.io,
    ...(options.homeDir !== undefined ? { userHomeDir: options.homeDir } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  let envelope = result.envelope as CliOutcome['envelope'] | undefined;
  if (envelope === undefined) {
    try {
      envelope = JSON.parse(collected.stdout()) as CliOutcome['envelope'];
    } catch {
      /* 人类模式（非 --json）stdout 是视图文本，不是 JSON 信封。 */
      envelope = undefined;
    }
  }
  return {
    exitCode: result.exitCode,
    stdout: collected.stdout(),
    stderr: collected.stderr(),
    envelope: envelope ?? ({ ok: false } as CliOutcome['envelope']),
  };
}

function okResult(outcome: CliOutcome, command: string): Record<string, unknown> {
  expect(outcome.exitCode, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
  expect(outcome.envelope.ok).toBe(true);
  expect(outcome.envelope.command).toBe(command);
  return outcome.envelope.result as Record<string, unknown>;
}

function failureOf(outcome: CliOutcome): { code: string; details?: Record<string, unknown> } {
  expect(outcome.envelope.ok, outcome.stdout).toBe(false);
  expect(outcome.envelope.error, outcome.stdout).toBeDefined();
  return { code: outcome.envelope.error!.code, details: outcome.envelope.error!.details };
}

async function openCase(): Promise<{ projectId: string; runId: string; dataRoot: string }> {
  fixture = await openBindingFixture();
  host = await startFakeHost({
    dataRoot: fixture.box.dataRoot,
    capabilityCatalog: catalog(),
    env: {},
    fake: {
      providers,
      /* tool_command 步骤产生真实 OS 进程身份（与既有 P03-6/7 夹具同一纪律）。 */
      commandProcess: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
      toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
      script: {
        schemaVersion: 1,
        steps: [
          { op: 'tool_command', name: 'probe' },
          { op: 'message', role: 'assistant', text: 'F-015' },
        ],
      },
    },
  });
  return {
    projectId: fixture.projectId,
    runId: fixture.runId,
    dataRoot: fixture.box.dataRoot,
  };
}

interface ProbeSession {
  database: {
    prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown };
  };
}

function readRun(
  session: ProbeSession,
  runId: string,
): { status: string; reason: string | null; revision: number } {
  return session.database
    .prepare('SELECT status, reason, revision FROM runs WHERE id = ?')
    .get(runId) as { status: string; reason: string | null; revision: number };
}

function readCancelReceiptCount(session: ProbeSession): number {
  return (
    session.database
      .prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE operation = ?')
      .get('execution.cancel') as { n: number }
  ).n;
}

function authToken(dataRoot: string): string {
  return readFileSync(join(dataRoot, 'host', 'auth.token'), 'utf8');
}

describe('F-015 CLI 纵向：pause/cancel/诊断、重复命令与 follow 退出不取消', () => {
  it('pause → 诊断 → 幂等重复 → Run 级 cancel 全链路；accepted 语义不宣称终态', async () => {
    const { projectId, runId, dataRoot } = await openCase();

    /* 输入错误在任何 I/O 之前拒绝（退出码 2）。 */
    const badInput = await runApp(
      ['execution', 'pause', '--project', projectId, '--run', runId, '--run', runId, '--revision', '1', '--json'],
      { dataRoot },
    );
    expect(badInput.exitCode).toBe(2);
    expect(failureOf(badInput).code).toBe('invalid_input');

    /* pause：completed 回执投影，不宣称验收/完成（冻结 commandId 供重放）。 */
    const explicitId = randomUUID();
    const paused = await runApp(
      ['execution', 'pause', '--project', projectId, '--run', runId, '--revision', '1',
        '--command-id', explicitId, '--json'],
      { dataRoot },
    );
    const pausedResult = okResult(paused, 'execution.pause');
    expect(pausedResult).toMatchObject({
      operation: 'execution.pause',
      outcome: 'paused',
      status: 'paused',
      targetKind: 'run',
      targetId: runId,
      finalState: true,
      replayed: false,
      commandId: explicitId,
    });
    expect(readRun(fixture!.session, runId)).toMatchObject({ status: 'paused', reason: 'user_pause' });

    /* 人类行模式失败（stale revision）：退出码 1，诊断到 stderr，不折算成功。 */
    const stalePause = await runApp(
      ['execution', 'pause', '--project', projectId, '--run', runId, '--revision', '999'],
      { dataRoot },
    );
    expect(stalePause.exitCode).toBe(1);
    expect(stalePause.stderr).toMatch(/stale_revision|conflict/);
    expect(stalePause.stdout).not.toMatch(/验收通过|业务完成/);

    /* 控制诊断：nextActions 指向 resume。 */
    const control = await runApp(
      ['execution', 'control', runId, '--project', projectId, '--json'],
      { dataRoot },
    );
    const controlResult = okResult(control, 'execution.control');
    expect(controlResult).toMatchObject({
      operation: 'execution.run.control.get',
      targetKind: 'run',
      targetId: runId,
      status: 'paused',
    });
    expect(controlResult.nextActions).toContain('resume');
    expect((controlResult.nextActionNotes as unknown[]).length).toBeGreaterThanOrEqual(1);

    /* 显式 --command-id 同参数重复提交 → 服务端摘要重放返回原回执（replayed）。 */
    const replayedPause = await runApp(
      ['execution', 'pause', '--project', projectId, '--run', runId, '--revision', '1',
        '--command-id', explicitId, '--json'],
      { dataRoot },
    );
    expect(okResult(replayedPause, 'execution.pause')).toMatchObject({
      outcome: 'paused',
      replayed: true,
      commandId: explicitId,
    });

    /* 同一 commandId 换不同参数 → conflict。 */
    const conflictReplay = await runApp(
      ['execution', 'pause', '--project', projectId, '--run', runId, '--revision', '2',
        '--command-id', explicitId, '--json'],
      { dataRoot },
    );
    expect(conflictReplay.exitCode).toBe(1);
    expect(failureOf(conflictReplay).code).toBe('conflict');

    /* events 观察退出（snapshot-only）不取消后台执行、不发送 stop/cancel。 */
    const observe = await runApp(
      ['events', '--project', projectId, '--snapshot-only', '--json'],
      { dataRoot },
    );
    expect(observe.exitCode).toBe(0);
    expect(readCancelReceiptCount(fixture!.session)).toBe(0);

    /* Run 级 cancel（paused run，无活动）：--confirm 必须；创建持久停止 operation。 */
    const missingConfirm = await runApp(
      ['execution', 'cancel', '--project', projectId, '--run', runId,
        '--revision', String(readRun(fixture!.session, runId).revision)],
      { dataRoot },
    );
    expect(missingConfirm.exitCode).toBe(2);

    const cancel = await runApp(
      ['execution', 'cancel', '--project', projectId, '--run', runId,
        '--revision', String(readRun(fixture!.session, runId).revision), '--confirm', '--json'],
      { dataRoot },
    );
    const cancelResult = okResult(cancel, 'execution.cancel');
    expect(cancelResult).toMatchObject({
      operation: 'execution.cancel',
      targetKind: 'run',
      targetId: runId,
    });
    expect(String(cancelResult.outcome)).toMatch(/cancelled|cancelling/);
    expect(cancelResult.stopOperationId).not.toBeNull();
    /* 输出显式否定式边界：不宣称已停止确认/验收完成。 */
    expect(String(cancelResult.note)).toMatch(/不等于验收通过|不代表/);

    /* cancel 后诊断展示停止 operation（未知字段保持 unknown）；等待停止结算。 */
    let controlAfter: CliOutcome | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      controlAfter = await runApp(
        ['execution', 'control', runId, '--project', projectId],
        { dataRoot },
      );
      expect(controlAfter.exitCode).toBe(0);
      if (!/await_stop_settlement/.test(controlAfter.stdout)) break;
      await delay(250);
    }
    expect(controlAfter!.stdout).toMatch(/stop=|nextActions=/);
  }, 90_000);

  it('follow 观察被中断（Abort）只结束观察：不发 stop/cancel，Host 与 Run 状态不变', async () => {
    const { projectId, runId, dataRoot } = await openCase();
    const paused = await runApp(
      ['execution', 'pause', '--project', projectId, '--run', runId, '--revision', '1', '--json'],
      { dataRoot },
    );
    okResult(paused, 'execution.pause');

    /* follow（默认）观察：有限等待后注入 Abort（Ctrl+C 语义）。 */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    timer.unref?.();
    const followed = await runApp(['events', '--project', projectId, '--json'], {
      dataRoot,
      signal: controller.signal,
    });
    /* 观察中断退出码 4（第五档），不代表命令失败或取消。 */
    expect(followed.exitCode).toBe(4);
    expect(followed.envelope.ok).toBe(false);
    expect(followed.envelope.error?.code).toBe('observation_interrupted');

    /* Host 未停止、已提交命令未取消：Run 仍 paused，无 execution.cancel 回执。 */
    expect(readRun(fixture!.session, runId)).toMatchObject({ status: 'paused', reason: 'user_pause' });
    expect(readCancelReceiptCount(fixture!.session)).toBe(0);

    /* 独立 CLI 查询仍可见同一状态。 */
    const control = await runApp(
      ['execution', 'control', runId, '--project', projectId, '--json'],
      { dataRoot },
    );
    expect(okResult(control, 'execution.control').status).toBe('paused');
  }, 90_000);

  it('resume：工作流显式继续；恢复模式不经命令注入；recovery 查询可见', async () => {
    const { projectId, runId, dataRoot } = await openCase();
    const paused = await runApp(
      ['execution', 'pause', '--project', projectId, '--run', runId, '--revision', '1', '--json'],
      { dataRoot },
    );
    okResult(paused, 'execution.pause');

    /* resume：工作流继续（revision 动态读取）。 */
    const resume = await runApp(
      ['execution', 'resume', '--project', projectId, '--run', runId,
        '--revision', String(readRun(fixture!.session, runId).revision), '--json'],
      { dataRoot },
    );
    const resumeResult = okResult(resume, 'execution.resume');
    expect(resumeResult).toMatchObject({
      operation: 'execution.resume',
      outcome: 'resumed',
      runtimeStarts: 0,
      attemptsCreated: 0,
      featureId: fixture!.featureId,
    });
    expect(String(resumeResult.note)).toMatch(/工作流 resume|任务策略/);
    const resumedRun = readRun(fixture!.session, runId);
    expect(resumedRun.status).not.toBe('paused');

    /* 恢复诊断：续接记录（requested auto/new/required vs decided resume/new）可查询。 */
    const recovery = await runApp(
      ['execution', 'recovery', runId, '--project', projectId, '--json'],
      { dataRoot },
    );
    const recoveryResult = okResult(recovery, 'execution.recovery');
    expect(recoveryResult).toMatchObject({
      operation: 'execution.run.recovery.get',
      runId,
      featureId: fixture!.featureId,
    });
    expect(recoveryResult.budget).toMatchObject({ usage: { tokenUsed: null, costUsed: null } });

    /* 等待被唤醒的工作到达稳定态（FakeRuntime 调度周期；有界轮询），
     * 使 Host 关闭的 quiesce 能在预算内确认（清理不绕过停止确认）。 */
    let stable = 0;
    let lastStatus = '';
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const current = readRun(fixture!.session, runId).status;
      if (current === lastStatus && !['queued', 'running', 'pausing', 'cancelling'].includes(current)) {
        stable += 1;
        if (stable >= 3) break;
      } else {
        stable = 0;
      }
      lastStatus = current;
      await delay(500);
    }
    expect(['paused', 'failed', 'succeeded', 'cancelled', 'interrupted']).toContain(lastStatus);
  }, 120_000);
});

describe('F-015 CLI 纵向：retry-final 仅收尾重试与恢复诊断', () => {
  it('显式历史 Run 重试创建受限新 Run；零 Runtime 启动；旧 Run 保持终态', async () => {
    const prepared = await prepareEligibleFixture();
    retryFixtures.push(prepared);
    const started = await startHost({
      dataRoot: prepared.box.box.dataRoot,
      capabilityCatalog: prepared.box.box.capabilityCatalog,
      env: {},
    });
    retryHosts.push(started);
    const dataRoot = prepared.box.box.dataRoot;
    const projectId = prepared.box.projectId;
    const oldRunId = prepared.ids.runId;
    const workKey = historicalRunWorkKey(prepared, oldRunId);

    /* 恢复诊断：旧 Run 失败终态、非 finalization、预算用量未知。 */
    const oldRecovery = await runApp(
      ['execution', 'recovery', oldRunId, '--project', projectId, '--json'],
      { dataRoot },
    );
    const oldRecoveryResult = okResult(oldRecovery, 'execution.recovery');
    expect(oldRecoveryResult).toMatchObject({
      operation: 'execution.run.recovery.get',
      runId: oldRunId,
      status: 'failed',
      finalizationPresent: false,
    });
    expect(oldRecoveryResult.budget).toMatchObject({
      usage: { tokenUsed: null, costUsed: null },
    });

    /* retry-final：显式历史 Run + workKey（冻结 commandId 供人类模式重放）。 */
    const retryCommandId = randomUUID();
    const retry = await runApp(
      ['execution', 'retry-final', prepared.box.featureId, '--project', projectId,
        '--historical-run', oldRunId, '--work-key', workKey, '--command-id', retryCommandId, '--json'],
      { dataRoot },
    );
    const retryResult = okResult(retry, 'execution.retry-final');
    expect(retryResult).toMatchObject({
      operation: 'execution.retryFinal',
      retryFinal: true,
      historicalRunId: oldRunId,
      runtimeStarts: 0,
      attemptsCreated: 0,
    });
    const newRunId = retryResult.newRunId as string;
    expect(newRunId).toBeTruthy();
    expect(newRunId).not.toBe(oldRunId);

    /* 人类行标注零 Runtime 启动与收尾步骤（显式 --command-id 幂等重放同一命令）。 */
    const retryHuman = await runApp(
      ['execution', 'retry-final', prepared.box.featureId, '--project', projectId,
        '--historical-run', oldRunId, '--work-key', workKey, '--command-id', retryCommandId],
      { dataRoot },
    );
    expect(retryHuman.exitCode).toBe(0);
    expect(retryHuman.stdout).toContain('runtimeStarts=0');
    expect(retryHuman.stdout).toMatch(/replayed/);

    /* 旧 Run 保持终态；新 Run 可诊断。 */
    expect(readRun(prepared.box.session, oldRunId).status).toBe('failed');
    const newRecovery = await runApp(
      ['execution', 'recovery', newRunId, '--project', projectId, '--json'],
      { dataRoot },
    );
    const newRecoveryResult = okResult(newRecovery, 'execution.recovery');
    expect(newRecoveryResult).toMatchObject({ runId: newRunId, finalizationPresent: true });

    /* 非法历史 Run：提交前 UUID 校验拒绝（退出码 2）。 */
    const badRun = await runApp(
      ['execution', 'retry-final', prepared.box.featureId, '--project', projectId,
        '--historical-run', 'not-a-uuid', '--work-key', workKey],
      { dataRoot },
    );
    expect(badRun.exitCode).toBe(2);
  }, 120_000);
});
