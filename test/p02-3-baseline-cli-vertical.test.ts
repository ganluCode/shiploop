/**
 * F-016 基线 CLI 纵向接线验收（契约 §12.1/§12.2/§12.3、§5.3/§5.5、§6/§7/§8/§9.4）。
 *
 * 定位：把 F-015 的基线 CLI 纯面层与 F-014 的 HostClient 基线面在**实际 dist CLI**
 * （`npm run build` 产物 `packages/cli/dist/bin.js`，与生产同一入口）上完成纵向接线：
 * - 非源码 cwd、沙箱 HOME/TMPDIR、临时数据根与真实 Git 仓库变体；产品操作只经
 *   HostClient（CLI 不打开 SQLite/不读写制品路径）；
 * - 验收 1：preview → 显式 --confirm 启动 → 真实 operationId → --wait 终态后可取
 *   每项退出码、耗时、代码身份与制品引用；失败仍可通过 overview 查到已注册项目；
 * - 验收 2：--decline 持久 not_run（零启动、脚本哨兵为零）；相同 commandId 重试
 *   沿用原操作、不同参数 conflict；无 HEAD/脏工作区展示并确认实际范围，
 *   不自动 stash/reset/commit；
 * - 验收 3：有界 --wait/--follow 与独立查询/取消；Ctrl+C 只退出观察（退出码 4）
 *   并说明操作仍可能运行；另一客户端继续查状态/显式取消；cancel 回执不提前
 *   声称进程已停；
 * - 验收 4：基线结束、显式 host stop 并重启后，CLI 仍可查询原检查结果与证据。
 *
 * 另含受信注入的观察预算用例（进程内 runAppCli；观察超时只中断观察，退出码 4）
 * 与纯面层新增展示字段（耗时/代码身份）的最小断言。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo } from '../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../packages/cli/src/host/execute.ts';
import {
  buildBaselineOperationResult,
  formatBaselineOperationResult,
} from '../packages/cli/src/app/baseline.ts';
import type {
  BaselineCheckResultView,
  BaselineOperationView,
} from '../packages/cli/src/app/baseline.ts';
import {
  createBaselineFixture,
  type BaselineFixture,
} from './helpers/p02-3/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = resolve(repoRoot, 'packages/cli/dist/bin.js');
const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
const DETACHED_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry.ts', import.meta.url),
);

let fixture: BaselineFixture;
let cliCwd: string;
let planDir: string;
/** 进程内用例启动过 Host 的数据根（afterEach 受控停止，不遗留后台进程）。 */
const inProcessRoots: string[] = [];

/** 干净树下先构建真实 dist（CLI bin + Host dist/start.js 启动入口）。 */
beforeAll(() => {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  fixture = createBaselineFixture({ prefix: 'shiploop-f016-dist-' });
  cliCwd = join(fixture.root, 'cli-cwd');
  planDir = join(fixture.root, 'plans');
  mkdirSync(cliCwd, { recursive: true });
  mkdirSync(planDir, { recursive: true });
}, 570_000);

afterEach(async () => {
  // 进程内用例的 Host：受控停止（dist 用例的 Host 在文件收尾统一 stop）。
  for (const root of inProcessRoots) {
    const collected = collectIo();
    const outcome = await runHostCli({
      args: ['host', 'stop', '--data-root', root, '--json'],
      io: collected.io as HostCliIo,
      env: {},
    });
    expect(outcome.exitCode, collected.stderr()).toBe(0);
  }
  inProcessRoots.length = 0;
});

/** 文件收尾：停止 dist Host 并回收夹具（只回收自有资源）。 */
afterAll(async () => {
  if (!fixture) return;
  const before = okResult(runCli(['host', 'status', ...dataArgs(), '--json']), 'host.status');
  const stop = runCli(['host', 'stop', ...dataArgs(), '--json']);
  const result = okResult(stop, 'host.stop');
  expect(result.status).toBe('stopped');
  const status = runCli(['host', 'status', ...dataArgs(), '--json']);
  expect(status.status, status.stdout).not.toBe(0);
  expect(() => process.kill(before.pid as number, 0)).toThrowError(
    expect.objectContaining({ code: 'ESRCH' }),
  );
  await fixture.dispose();
});

interface CliOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function dataArgs(): string[] {
  return ['--data-root', fixture.dataRoot()];
}

function runCli(
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
): CliOutcome {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: options.cwd ?? cliCwd,
    env: fixture.childEnv(),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 90_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; commandId?: string; details?: Record<string, unknown> };
}

function parseEnvelopeLines(stdout: string): EnvelopeShape[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EnvelopeShape);
}

function singleEnvelope(outcome: CliOutcome): EnvelopeShape {
  const lines = parseEnvelopeLines(outcome.stdout);
  expect(lines, outcome.stderr).toHaveLength(1);
  return lines[0] as EnvelopeShape;
}

function okResult(outcome: CliOutcome, command: string): Record<string, unknown> {
  expect(outcome.status, outcome.stderr).toBe(0);
  const envelope = singleEnvelope(outcome);
  expect(envelope.ok, outcome.stderr).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failureOf(outcome: CliOutcome, exitCode: number, code: string): NonNullable<EnvelopeShape['error']> {
  expect(outcome.status, outcome.stderr).toBe(exitCode);
  const envelope = singleEnvelope(outcome);
  expect(envelope.ok).toBe(false);
  expect(envelope.error?.code, outcome.stderr).toBe(code);
  return envelope.error as NonNullable<EnvelopeShape['error']>;
}

function registerRepo(repoPath: string, name: string): string {
  const outcome = runCli([
    'project',
    'init',
    repoPath,
    '--confirm',
    '--name',
    name,
    ...dataArgs(),
    '--json',
  ]);
  const result = okResult(outcome, 'project.init');
  const registration = result.registration as { projectId: string; status: string };
  expect(['registered', 'already_registered']).toContain(registration.status);
  return registration.projectId;
}

/** 无副作用检查：只向 stdout 写标识，不落任何文件。 */
function printCheck(checkKey: string, marker: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkKey,
    kind: 'command',
    argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(marker)})`],
    timeoutMs: 60_000,
    required: true,
    ...extra,
  };
}

function failingCheck(checkKey: string, exitCode: number): Record<string, unknown> {
  return {
    checkKey,
    kind: 'command',
    argv: [process.execPath, '-e', `process.exit(${exitCode})`],
    timeoutMs: 60_000,
    required: true,
  };
}

function hangingCheck(checkKey: string, timeoutMs: number): Record<string, unknown> {
  return {
    checkKey,
    kind: 'command',
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 300000)'],
    timeoutMs,
    required: true,
  };
}

function writePlan(name: string, checks: readonly Record<string, unknown>[]): string {
  const file = join(planDir, `${name}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify({ checks: checks.map((check) => ({ ...check })) }));
  return file;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env: fixture.childEnv(),
    encoding: 'utf8',
  });
}

function overviewOf(projectId: string): Record<string, unknown> {
  const result = okResult(
    runCli(['project', 'overview', projectId, ...dataArgs(), '--json']),
    'project.overview',
  );
  return result;
}

function statusOf(operationId: string): Record<string, unknown> {
  const result = okResult(
    runCli(['baseline', 'status', operationId, ...dataArgs(), '--json']),
    'baseline.status',
  );
  return result;
}

/* ================================================================== *
 * 验收 1/2/3/4：实际 dist CLI 纵向闭环
 * ================================================================== */

describe('F-016 基线 CLI 纵向（实际 dist CLI + 临时仓库/数据根 + HostClient）', () => {
  it('验收1：preview→显式确认启动→--wait 终态（退出码/耗时/代码身份/制品引用）；失败仍可 overview 查询', () => {
    const repos = fixture.repos;
    const projectId = registerRepo(repos.withHead, 'demo-head');
    const planFile = writePlan('passing', [printCheck('smoke', 'evidence-body-42')]);

    // 人类预览：展示项目、argv（JSON 数组原样）、代码范围与政策摘要。
    const previewHuman = runCli(['baseline', 'preview', '--project', projectId, '--input', planFile, ...dataArgs()]);
    expect(previewHuman.status, previewHuman.stderr).toBe(0);
    expect(previewHuman.stdout).toContain('previewDigest=');
    expect(previewHuman.stdout).toContain('smoke（kind=command');
    expect(previewHuman.stdout).toContain(process.execPath);
    expect(previewHuman.stdout).toContain(`HEAD=${repos.headOf('withHead')}`);

    // JSON 预览：结构化预览事实（只读，不执行）。
    const preview = okResult(
      runCli(['baseline', 'preview', '--project', projectId, '--input', planFile, ...dataArgs(), '--json']),
      'baseline.preview',
    );
    expect(preview.projectId).toBe(projectId);
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.policyRevision).toMatch(/^[0-9a-f]{64}$/);
    expect((preview.codeIdentity as { headCommit: string }).headCommit).toBe(repos.headOf('withHead'));
    expect((preview.codeIdentity as { hasUncommittedChanges: boolean }).hasUncommittedChanges).toBe(false);
    expect((preview.checks as { argv: string[] }[])[0]?.argv).toEqual([
      process.execPath,
      '-e',
      'process.stdout.write("evidence-body-42")',
    ]);

    // 显式确认启动 → --wait 终态：真实 operationId + 逐项退出码/耗时/代码身份/制品引用。
    const run = okResult(
      runCli([
        'baseline',
        'run',
        '--project',
        projectId,
        '--input',
        planFile,
        '--confirm',
        '--wait',
        ...dataArgs(),
        '--json',
      ]),
      'baseline.run',
    );
    expect(run.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(run.state).toBe('passed');
    expect(run.status).toBe('completed');
    const identity = run.codeIdentity as { headCommit: string; workingTreeDigest: string };
    expect(identity.headCommit).toBe(repos.headOf('withHead'));
    expect(identity.workingTreeDigest).toMatch(/^[0-9a-f]{64}$/);
    const check = (run.checks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(check.status).toBe('passed');
    expect(check.exitCode).toBe(0);
    expect(check.durationMs as number).toBeGreaterThanOrEqual(0);
    const output = check.output as { artifactId: string; byteSize: number };
    expect(output.artifactId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(output.byteSize).toBeGreaterThan(0);

    // 独立查询：status 仍给出耗时/代码身份/制品引用。
    const operationId = run.operationId as string;
    const detail = statusOf(operationId);
    expect(detail.state).toBe('passed');
    expect((detail.codeIdentity as { headCommit: string }).headCommit).toBe(repos.headOf('withHead'));
    const detailCheck = (detail.checks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(detailCheck.durationMs as number).toBeGreaterThanOrEqual(0);
    expect((detailCheck.output as { artifactId: string }).artifactId).toBe(output.artifactId);

    // 证据正文经 artifacts.get 读取（有界、已脱敏）。
    const evidence = okResult(
      runCli(['baseline', 'evidence', output.artifactId, ...dataArgs(), '--json']),
      'baseline.evidence',
    );
    expect(evidence.artifactId).toBe(output.artifactId);
    expect(evidence.content as string).toContain('evidence-body-42');

    // 失败运行：--wait 非「completed 且全 required passed」→ 退出码 1；注册不撤销。
    const failPlan = writePlan('failing', [failingCheck('boom', 3)]);
    const failed = runCli([
      'baseline',
      'run',
      '--project',
      projectId,
      '--input',
      failPlan,
      '--confirm',
      '--wait',
      ...dataArgs(),
      '--json',
    ]);
    expect(failed.status, failed.stderr).toBe(1);
    const failedEnvelope = singleEnvelope(failed);
    expect(failedEnvelope.ok).toBe(true);
    const failedResult = failedEnvelope.result as Record<string, unknown>;
    expect(failedResult.state).toBe('failed');
    expect((failedResult.checks as Record<string, unknown>[])[0]).toMatchObject({
      status: 'failed',
      exitCode: 3,
    });

    const overview = overviewOf(projectId);
    expect((overview.registration as { status: string }).status).toBe('registered');
    expect((overview.health as { status: string }).status).toBe('unhealthy');
  }, 180_000);

  it('验收2：--decline 持久 not_run（零启动/零哨兵）；commandId 重放沿用原操作、不同参数冲突；无 HEAD/脏工作区展示且不动工作区', () => {
    const repos = fixture.repos;
    const projectId = registerRepo(repos.withHead, 'demo-decline');

    // 拒绝授权：脚本哨兵绝不出现、检查零启动。
    const sentinel = join(fixture.root, `sentinel-${randomUUID().slice(0, 8)}`);
    const sentinelPlan = writePlan('declined', [
      {
        checkKey: 'sentinel',
        kind: 'command',
        argv: [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'started')`,
        ],
        timeoutMs: 60_000,
        required: true,
      },
    ]);
    const declined = okResult(
      runCli([
        'baseline',
        'run',
        '--project',
        projectId,
        '--input',
        sentinelPlan,
        '--decline',
        ...dataArgs(),
        '--json',
      ]),
      'baseline.run',
    );
    expect(declined.state).toBe('not_run');
    const declinedId = declined.operationId as string;

    // 持久 not_run：零启动（checks 空、未开始）且哨兵为零。
    const declinedDetail = statusOf(declinedId);
    expect(declinedDetail.status).toBe('not_run');
    expect(declinedDetail.state).toBe('not_run');
    expect(declinedDetail.checks).toEqual([]);
    expect(declinedDetail.startedAt).toBeNull();
    expect(existsSync(sentinel)).toBe(false);

    // 人类输出显式区分 not_run（不折算成功）。
    const declinedHuman = runCli([
      'baseline',
      'run',
      '--project',
      projectId,
      '--input',
      sentinelPlan,
      '--decline',
      ...dataArgs(),
    ]);
    expect(declinedHuman.status, declinedHuman.stderr).toBe(0);
    expect(declinedHuman.stdout).toMatch(/not_run（未执行/);
    expect(existsSync(sentinel)).toBe(false);

    // 相同 commandId 重试沿用原操作（重放原回执）；不同参数 → conflict。
    const commandId = randomUUID();
    const planFile = writePlan('replay', [printCheck('replay-ok', 'replay-body')]);
    const first = okResult(
      runCli([
        'baseline',
        'run',
        '--project',
        projectId,
        '--input',
        planFile,
        '--confirm',
        '--command-id',
        commandId,
        '--wait',
        ...dataArgs(),
        '--json',
      ]),
      'baseline.run',
    );
    const replay = okResult(
      runCli([
        'baseline',
        'run',
        '--project',
        projectId,
        '--input',
        planFile,
        '--confirm',
        '--command-id',
        commandId,
        '--wait',
        ...dataArgs(),
        '--json',
      ]),
      'baseline.run',
    );
    expect(replay.operationId).toBe(first.operationId);

    const otherPlan = writePlan('replay-conflict', [printCheck('other-ok', 'other-body')]);
    const conflicted = runCli([
      'baseline',
      'run',
      '--project',
      projectId,
      '--input',
      otherPlan,
      '--confirm',
      '--command-id',
      commandId,
      ...dataArgs(),
      '--json',
    ]);
    const conflictError = failureOf(conflicted, 1, 'conflict');
    expect(conflictError.commandId).toBe(commandId);

    // 无 HEAD 仓库：展示「无 HEAD」事实与警告，确认后仍按当前工作区运行；不猜分支。
    const noHeadProject = registerRepo(repos.noInitialCommit, 'demo-no-head');
    const noHeadPlan = writePlan('no-head', [printCheck('no-head-ok', 'no-head-body')]);
    const noHeadPreview = runCli([
      'baseline',
      'preview',
      '--project',
      noHeadProject,
      '--input',
      noHeadPlan,
      ...dataArgs(),
    ]);
    expect(noHeadPreview.status, noHeadPreview.stderr).toBe(0);
    expect(noHeadPreview.stdout).toMatch(/null（无 HEAD；不猜测分支、不自动提交）/);
    expect(noHeadPreview.stdout).toContain('no_initial_commit');
    const noHeadBefore = {
      status: git(repos.noInitialCommit, ['status', '--porcelain']),
      stash: git(repos.noInitialCommit, ['stash', 'list']),
    };
    const noHeadRun = okResult(
      runCli([
        'baseline',
        'run',
        '--project',
        noHeadProject,
        '--input',
        noHeadPlan,
        '--confirm',
        '--wait',
        ...dataArgs(),
        '--json',
      ]),
      'baseline.run',
    );
    expect(noHeadRun.state).toBe('passed');
    expect((noHeadRun.codeIdentity as { headCommit: string | null }).headCommit).toBeNull();
    expect(() => git(repos.noInitialCommit, ['rev-parse', 'HEAD'])).toThrow();
    expect(git(repos.noInitialCommit, ['status', '--porcelain'])).toBe(noHeadBefore.status);
    expect(git(repos.noInitialCommit, ['stash', 'list'])).toBe(noHeadBefore.stash);

    // 脏工作区：展示并确认实际范围（uncommitted），不 stash/reset/commit。
    const dirtyProject = registerRepo(repos.dirty, 'demo-dirty');
    const dirtyPlan = writePlan('dirty', [printCheck('dirty-ok', 'dirty-body')]);
    const dirtyBefore = {
      status: git(repos.dirty, ['status', '--porcelain']),
      tracked: readFileSync(repos.dirtyTrackedFile, 'utf8'),
      stash: git(repos.dirty, ['stash', 'list']),
    };
    const dirtyPreview = runCli([
      'baseline',
      'preview',
      '--project',
      dirtyProject,
      '--input',
      dirtyPlan,
      ...dataArgs(),
    ]);
    expect(dirtyPreview.status, dirtyPreview.stderr).toBe(0);
    expect(dirtyPreview.stdout).toMatch(/有未提交改动（原样保留，不 stash\/reset）/);
    expect(dirtyPreview.stdout).toContain('working_tree_dirty');

    // run 人类输出同样展示实际范围与独立授权提示（确认注册不隐含确认基线）。
    const dirtyRunHuman = runCli([
      'baseline',
      'run',
      '--project',
      dirtyProject,
      '--input',
      dirtyPlan,
      '--confirm',
      '--wait',
      ...dataArgs(),
    ]);
    expect(dirtyRunHuman.status, dirtyRunHuman.stderr).toBe(0);
    expect(dirtyRunHuman.stdout).toMatch(/有未提交改动（原样保留，不 stash\/reset）/);
    expect(dirtyRunHuman.stderr).toMatch(/不隐含确认基线/);

    expect(git(repos.dirty, ['status', '--porcelain'])).toBe(dirtyBefore.status);
    expect(readFileSync(repos.dirtyTrackedFile, 'utf8')).toBe(dirtyBefore.tracked);
    expect(git(repos.dirty, ['stash', 'list'])).toBe(dirtyBefore.stash);
  }, 180_000);

  it('验收3：Ctrl+C 只退出观察并说明仍可能运行；另一客户端查状态/显式取消；cancel 不提前声称进程已停', async () => {
    const repos = fixture.repos;
    const projectId = registerRepo(repos.withHead, 'demo-observe');
    const hangPlan = writePlan('hang', [hangingCheck('hang', 300_000)]);

    // --follow 为记录流（NDJSON）；Ctrl+C（SIGINT）只结束本次观察（退出码 4）。
    const child = spawn(
      process.execPath,
      [
        CLI_BIN,
        'baseline',
        'run',
        '--project',
        projectId,
        '--input',
        hangPlan,
        '--confirm',
        '--follow',
        '--json',
        ...dataArgs(),
      ],
      { cwd: cliCwd, env: fixture.childEnv() },
    );
    let childStdout = '';
    let childStderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      childStdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      childStderr += chunk.toString('utf8');
    });

    // 等到 accepted 记录（真实 operationId）再中断观察。
    const operationId = await waitFor(() => {
      const lines = parseEnvelopeLines(childStdout);
      for (const line of lines) {
        const result = line.result as { kind?: string; operation?: { operationId?: unknown } } | undefined;
        if (result?.kind === 'accepted' && typeof result.operation?.operationId === 'string') {
          return result.operation.operationId;
        }
      }
      return undefined;
    }, 30_000);

    child.kill('SIGINT');
    const exit = await waitForExit(child, 30_000);
    expect(exit.code, childStderr).toBe(4);
    // 退出观察必须说明操作仍可能运行且未取消（显式取消另有命令）。
    expect(`${childStdout}${childStderr}`).toMatch(/仍可能运行|未取消/);

    const streamLines = parseEnvelopeLines(childStdout);
    const interrupted = streamLines.find((line) => line.ok === false);
    expect(interrupted?.error?.code).toBe('observation_interrupted');
    expect(interrupted?.error?.details?.operationId).toBe(operationId);

    // 另一个客户端（独立 CLI 进程）可继续查状态：操作确实仍在运行。
    const inflight = statusOf(operationId);
    expect(['accepted', 'running']).toContain(inflight.status);
    expect(['accepted', 'active']).toContain(inflight.state);

    // 显式取消（唯一取消途径）：回执状态驱动展示，绝不提前声称已停止/通过。
    const cancel = runCli(['baseline', 'cancel', operationId, '--confirm', ...dataArgs(), '--json']);
    expect(cancel.status, cancel.stderr).toBe(0);
    const cancelResult = okResult(cancel, 'baseline.cancel');
    expect(cancelResult.operationId).toBe(operationId);
    expect(['cancelling', 'cancelled', 'failed', 'not_run']).toContain(cancelResult.status);
    if (cancelResult.status === 'cancelling') {
      expect(cancelResult.state).toBe('active');
    }
    if (cancelResult.status === 'cancelled') {
      expect(cancelResult.state).toBe('cancelled');
    }
    expect(cancel.stdout).not.toContain('"passed"');
    expect(cancel.stdout).not.toContain('completed（');

    // 取消后（停止核验完成后）查询到明确终态；在途期间绝不冒充完成。
    const final = await waitFor(() => {
      const detail = statusOf(operationId);
      return detail.state === 'active' ? undefined : detail;
    }, 30_000);
    expect(final.state).toBe('cancelled');
    expect(final.status).toBe('cancelled');

    // 有界 --wait：检查按计划超时收尾后等待即结束（timeout 状态显式区分）。
    const timeoutPlan = writePlan('timeout', [hangingCheck('slow', 1_500)]);
    const timedOut = runCli([
      'baseline',
      'run',
      '--project',
      projectId,
      '--input',
      timeoutPlan,
      '--confirm',
      '--wait',
      ...dataArgs(),
      '--json',
    ]);
    expect(timedOut.status, timedOut.stderr).toBe(1);
    const timedOutResult = singleEnvelope(timedOut).result as Record<string, unknown>;
    expect(timedOutResult.state).toBe('timeout');
    expect((timedOutResult.checks as Record<string, unknown>[])[0]).toMatchObject({
      timedOut: true,
    });
  }, 180_000);

  it('验收4：显式 host stop 并重启后仍可查询原检查结果与证据；拒绝记录持久 not_run', async () => {
    const repos = fixture.repos;
    const projectId = registerRepo(repos.withHead, 'demo-persist');
    const planFile = writePlan('persist', [printCheck('persist-ok', 'persist-body-7')]);

    // 拒绝记录先行（与后续终态拉开确定序：健康派生按结束时间取最近终态）。
    const declinedPlan = writePlan('persist-declined', [printCheck('never', 'never-body')]);
    const declined = okResult(
      runCli([
        'baseline',
        'run',
        '--project',
        projectId,
        '--input',
        declinedPlan,
        '--decline',
        ...dataArgs(),
        '--json',
      ]),
      'baseline.run',
    );
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 30));

    const run = okResult(
      runCli([
        'baseline',
        'run',
        '--project',
        projectId,
        '--input',
        planFile,
        '--confirm',
        '--wait',
        ...dataArgs(),
        '--json',
      ]),
      'baseline.run',
    );
    const operationId = run.operationId as string;
    const artifactId = ((run.checks as Record<string, unknown>[])[0] as {
      output: { artifactId: string };
    }).output.artifactId;
    const evidenceBefore = okResult(
      runCli(['baseline', 'evidence', artifactId, ...dataArgs(), '--json']),
      'baseline.evidence',
    );
    expect(evidenceBefore.content as string).toContain('persist-body-7');

    // 显式 stop（产品命令）后重启：业务命令经 ensureHostRunning 受控重启同一单例。
    const stop = runCli(['host', 'stop', ...dataArgs(), '--json']);
    expect(stop.status, stop.stderr).toBe(0);

    const detail = statusOf(operationId);
    expect(detail.state).toBe('passed');
    const detailCheck = (detail.checks as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect((detailCheck.output as { artifactId: string }).artifactId).toBe(artifactId);

    const evidenceAfter = okResult(
      runCli(['baseline', 'evidence', artifactId, ...dataArgs(), '--json']),
      'baseline.evidence',
    );
    expect(evidenceAfter.content).toEqual(evidenceBefore.content);

    const declinedAfter = statusOf(declined.operationId as string);
    expect(declinedAfter.status).toBe('not_run');
    expect(declinedAfter.checks).toEqual([]);

    const overview = overviewOf(projectId);
    expect((overview.registration as { status: string }).status).toBe('registered');
    expect((overview.health as { status: string }).status).toBe('healthy');
    expect((overview.health as { lastBaselineOperationId?: string }).lastBaselineOperationId).toBe(
      operationId,
    );
  }, 180_000);
});

/* ================================================================== *
 * 受信观察预算（进程内注入）：观察超时只中断观察（退出码 4）
 * ================================================================== */

describe('F-016 有界观察预算（runAppCli 受信注入）', () => {
  it('--wait 观察预算耗尽 → observation_interrupted（退出码 4），操作不被取消', async () => {
    const repos = fixture.repos;
    const root = fixture.dataRoot('observe-budget');
    const io = collectIo();
    const launch = {
      entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
      childEnv: fixture.childEnv(),
      pollIntervalMs: 50,
    };
    const init = await runAppCli({
      args: [
        'project',
        'init',
        repos.withHead,
        '--confirm',
        '--name',
        'observe-budget',
        '--data-root',
        root,
        '--json',
      ],
      io: io.io,
      launch,
    });
    expect(init.exitCode, io.stderr()).toBe(0);
    const projectId = (
      JSON.parse(io.stdout()) as {
        result: { registration: { projectId: string } };
      }
    ).result.registration.projectId;

    inProcessRoots.push(root);
    const planFile = writePlan('observe-budget', [hangingCheck('budget-hang', 300_000)]);
    const runIo = collectIo();
    const run = await runAppCli({
      args: [
        'baseline',
        'run',
        '--project',
        projectId,
        '--input',
        planFile,
        '--confirm',
        '--wait',
        '--data-root',
        root,
        '--json',
      ],
      io: runIo.io,
      launch,
      baselineObserve: { totalBudgetMs: 600, pollIntervalMs: 50 },
    });
    expect(run.exitCode, runIo.stderr()).toBe(4);
    const envelope = JSON.parse(runIo.stdout()) as {
      ok: boolean;
      error?: { code: string; details?: { operationId?: string } };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('observation_interrupted');
    const operationId = envelope.error?.details?.operationId;
    expect(typeof operationId).toBe('string');
    expect(runIo.stderr()).toMatch(/仍可能运行|未取消/);

    // 中断只结束观察：操作仍在途，可被显式取消（取消后回收，避免遗留挂起检查）。
    const statusIo = collectIo();
    await runAppCli({
      args: ['baseline', 'status', operationId as string, '--data-root', root, '--json'],
      io: statusIo.io,
      launch,
    });
    expect(statusIo.stdout()).toContain('"status"');

    const cancelIo = collectIo();
    const cancel = await runAppCli({
      args: ['baseline', 'cancel', operationId as string, '--confirm', '--data-root', root, '--json'],
      io: cancelIo.io,
      launch,
    });
    expect(cancel.exitCode, cancelIo.stderr()).toBe(0);
    const cancelEnvelope = JSON.parse(cancelIo.stdout()) as {
      result: { operationId: string; status: string };
    };
    expect(cancelEnvelope.result.operationId).toBe(operationId);
    expect(['cancelling', 'cancelled']).toContain(cancelEnvelope.result.status);
  }, 120_000);
});

/* ================================================================== *
 * 纯面层新增展示字段（耗时/代码身份）
 * ================================================================== */

describe('F-016 status/--wait 结果展示字段（纯面层）', () => {
  it('操作结果携带代码身份与逐项耗时；人类摘要展示两者且不折算 not_run', () => {
    const operation: BaselineOperationView = {
      operationId: '7d7a5c1e-0f3b-4a2c-9f10-1234567890ab',
      kind: 'baseline',
      status: 'completed',
      createdAt: '2026-10-10T00:00:00.000Z',
      startedAt: '2026-10-10T00:00:01.000Z',
      endedAt: '2026-10-10T00:00:02.000Z',
      summary: { total: 1, passed: 1, failed: 0, error: 0, inconclusive: 0, notRun: 0 },
    };
    const check: BaselineCheckResultView = {
      checkKey: 'smoke',
      argv: [process.execPath, '-e', 'process.stdout.write("x")'],
      cwdRef: null,
      environmentRef: null,
      timeoutMs: 60_000,
      required: true,
      status: 'passed',
      exitCode: 0,
      signal: null,
      timedOut: false,
      output: { artifactId: '3f6a5c1e-0f3b-4a2c-9f10-1234567890ab', byteSize: 1, truncated: false },
      tail: 'x',
      startedAt: '2026-10-10T00:00:01.000Z',
      endedAt: '2026-10-10T00:00:02.000Z',
      durationMs: 1000,
    };
    const result = buildBaselineOperationResult(operation, [check], {
      headCommit: 'a'.repeat(40),
      workingTreeDigest: 'b'.repeat(64),
      hasUncommittedChanges: true,
    });
    expect(result.state).toBe('passed');
    expect(result.codeIdentity).toEqual({
      headCommit: 'a'.repeat(40),
      workingTreeDigest: 'b'.repeat(64),
      hasUncommittedChanges: true,
    });
    expect(result.checks[0]?.durationMs).toBe(1000);
    const text = formatBaselineOperationResult(result);
    expect(text).toContain('durationMs=1000');
    expect(text).toContain('有未提交改动（原样保留，不 stash/reset）');

    // 无授权（拒绝记录）时代码身份为 null，仍可展示。
    const notRun = buildBaselineOperationResult(
      { ...operation, status: 'not_run', reasonCode: 'authorization_rejected' },
      [],
    );
    expect(notRun.codeIdentity).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 辅助（有界等待；绝不无界轮询）
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

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error('waitFor 等待超时（有界）');
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error('子进程退出等待超时（有界）'));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
  });
}
