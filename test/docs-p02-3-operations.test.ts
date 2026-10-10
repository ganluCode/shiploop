/**
 * F-019 文档核验：`docs/p02-3-operations.md` 的项目接入、基线授权与故障处理示例
 * 必须与真实 dist CLI（`runAppCli`/`runHostCli`，即 `packages/cli/dist/bin.js`
 * 同一路径）一致，`docs/p02-3-handoff.md` 必须指向真实 Schema、Core 窄服务、
 * Host 路由/能力、HostClient、CLI 退出码、受监督停止与恢复约束、测试/证据入口。
 *
 * 定位：F-019 只交付文档（+ 本守护）。为避免文档与实现漂移，本套件：
 * 1) 在真实临时仓库/数据根与真实 Host 上按文档顺序跑通示例纵向
 *    （init 预览/确认 → overview → 基线预览/授权/查询/证据/拒绝/取消 →
 *    host stop/重启后查询），断言文档注释记录的结构化语义；
 * 2) 把操作说明 §4 代码块中的每条 `node packages/cli/dist/bin.js …` 命令行
 *    逐字提取并经真实命令契约面（`parseAppCliArgs`/`parseHostCliArgs`、
 *    `baselineCliExitCode`、`parseBaselineCheckPlanText`）核对——文档示例与
 *    命令契约测试共用同一输入；
 * 3) 交叉核对文档记录的语义词、Schema 表、路由、HostClient 方法、退出码与
 *    安全边界，且引用的测试文件真实存在。
 *
 * 不新增业务实现、不扩大 P02-3 交付范围、不依赖预存 dist。
 * 运行前提：macOS（flock）；beforeAll 显式编译原生锁适配器。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppCliParseError,
  baselineCliExitCode,
  parseAppCliArgs,
  parseBaselineCheckPlanText,
  parseHostCliArgs,
} from '../packages/cli/src/index.ts';
import { runAppCli, type AppCliIo } from '../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../packages/cli/src/host/execute.ts';
import { createBaselineFixture, type BaselineFixture } from './helpers/p02-3/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPERATIONS_DOC_PATH = 'docs/p02-3-operations.md';
const HANDOFF_DOC_PATH = 'docs/p02-3-handoff.md';
const README_PATH = 'README.md';

const operationsDoc = readFileSync(resolve(REPO_ROOT, OPERATIONS_DOC_PATH), 'utf-8');
const handoffDoc = readFileSync(resolve(REPO_ROOT, HANDOFF_DOC_PATH), 'utf-8');
const readmeDoc = readFileSync(resolve(REPO_ROOT, README_PATH), 'utf-8');

const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
const DETACHED_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry.ts', import.meta.url),
);

let fixture: BaselineFixture;
let planDir: string;

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], {
    cwd: REPO_ROOT,
    timeout: 60_000,
  });
  fixture = createBaselineFixture({ prefix: 'shiploop-f019-docs-' });
  planDir = join(fixture.root, 'plans');
  mkdirSync(planDir, { recursive: true });
});

afterAll(async () => {
  try {
    const collected = collectIo();
    await runHostCli({
      args: ['host', 'stop', '--data-root', fixture.dataRoot('docs-operations'), '--json'],
      io: collected.io as HostCliIo,
      env: {},
    });
  } catch {
    // 尽力收尾；夹具 dispose 兜底回收。
  }
  await fixture.dispose();
});

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
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function launchOptions() {
  return {
    entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
    childEnv: fixture.childEnv(),
    pollIntervalMs: 50,
  };
}

async function runApp(args: readonly string[]): Promise<AppInvocation> {
  const collected = collectIo();
  const result = await runAppCli({
    args,
    io: collected.io,
    env: fixture.childEnv(),
    launch: launchOptions(),
  });
  return { exitCode: result.exitCode, stdout: collected.stdout(), stderr: collected.stderr() };
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; commandId?: string };
}

function parseEnvelope(invocation: AppInvocation): EnvelopeShape {
  expect(invocation.stdout.trim().split('\n'), invocation.stderr).toHaveLength(1);
  return JSON.parse(invocation.stdout) as EnvelopeShape;
}

function okResult(invocation: AppInvocation, command: string): Record<string, unknown> {
  expect(invocation.exitCode, invocation.stderr).toBe(0);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok, invocation.stderr).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function writePlan(name: string, checks: readonly Record<string, unknown>[]): string {
  const file = join(planDir, `${name}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify({ checks: [...checks] }), 'utf-8');
  return file;
}

/** 文档 §4 的示例检查（与操作说明 plan.json 一致：/bin/echo 输出非空正文）。 */
function echoCheck(): Record<string, unknown> {
  return {
    checkKey: 'echo-ok',
    kind: 'command',
    argv: ['/bin/echo', 'baseline ok'],
    timeoutMs: 60_000,
    required: true,
  };
}

/** 文档 §4 步骤 10 的挂起检查（plan-hang.json）。 */
function hangCheck(): Record<string, unknown> {
  return {
    checkKey: 'hang',
    kind: 'command',
    argv: ['/bin/sleep', '30'],
    timeoutMs: 3_600_000,
    required: true,
  };
}

/* ================================================================== *
 * 1) 操作说明 §4 示例纵向：真实临时仓库/数据根 + 真实 Host
 * ================================================================== */

describe('F-019 操作说明示例纵向（文档顺序可复跑）', () => {
  it('init 预览/确认 → overview → 基线预览/授权/查询/证据/拒绝/取消 → stop/重启后查询', async () => {
    const repo = fixture.repos.withHead;
    const root = fixture.dataRoot('docs-operations');
    const dataArgs = ['--data-root', root, '--json'];

    // 2) 静态预览（无 --confirm）：只读事实 + registration not_run，零副作用。
    const previewInit = await runApp(['project', 'init', repo, ...dataArgs]);
    const previewResult = okResult(previewInit, 'project.init');
    expect(previewResult.registration).toEqual({ status: 'not_run', reason: 'non_interactive' });
    expect((previewResult.preview as Record<string, unknown>).alreadyRegisteredProjectId).toBeNull();

    // 3) 显式确认注册：注册成功与健康 not_run 分轴展示。
    const confirmed = await runApp([
      'project', 'init', repo,
      '--name', '示例项目',
      '--confirm',
      ...dataArgs,
    ]);
    const initResult = okResult(confirmed, 'project.init');
    const registration = initResult.registration as { status: string; projectId: string };
    expect(['registered', 'already_registered']).toContain(registration.status);
    expect(registration.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(initResult.health).toEqual({
      status: 'not_run',
      lastBaselineOperationId: null,
      lastCompletedAt: null,
      reasonCode: 'no_baseline',
    });
    const projectId = registration.projectId;

    // 4) 概览：注册状态与健康状态严格分列。
    const overview = okResult(
      await runApp(['project', 'overview', projectId, ...dataArgs]),
      'project.overview',
    );
    expect((overview.registration as { status: string }).status).toBe('registered');
    expect((overview.health as { status: string }).status).toBe('not_run');

    // 5) 基线预览（只读；文档示例 plan.json 形状）。
    const passPlan = writePlan('passing', [echoCheck()]);
    const preview = okResult(
      await runApp(['baseline', 'preview', '--project', projectId, '--input', passPlan, ...dataArgs]),
      'baseline.preview',
    );
    expect(preview.projectId).toBe(projectId);
    expect(typeof preview.previewDigest).toBe('string');
    expect((preview.codeIdentity as Record<string, unknown>).hasUncommittedChanges).toBe(false);
    expect((preview.checks as Record<string, unknown>[])[0].argv).toEqual(['/bin/echo', 'baseline ok']);

    // 6) 显式授权并等待终态：completed + 全 required passed → 退出码 0。
    const run = await runApp([
      'baseline', 'run', '--project', projectId, '--input', passPlan,
      '--confirm', '--wait', ...dataArgs,
    ]);
    const runResult = okResult(run, 'baseline.run');
    expect(runResult.state).toBe('passed');
    expect(runResult.status).toBe('completed');
    const operationId = runResult.operationId as string;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);

    // 7) 查询历史与逐项结果（含输出制品引用）。
    const status = okResult(
      await runApp(['baseline', 'status', operationId, ...dataArgs]),
      'baseline.status',
    );
    expect(status.state).toBe('passed');
    expect(status.codeIdentity).not.toBeNull();
    const check = (status.checks as Record<string, unknown>[])[0];
    expect(check.status).toBe('passed');
    const artifactId = (check.output as { artifactId: string }).artifactId;
    expect(typeof artifactId).toBe('string');

    const list = okResult(
      await runApp(['baseline', 'list', '--project', projectId, ...dataArgs]),
      'baseline.list',
    );
    expect((list.records as Record<string, unknown>[]).map((record) => record.state)).toContain('passed');

    // 8) 输出证据（脱敏正文原样）。
    const evidence = okResult(
      await runApp(['baseline', 'evidence', artifactId, ...dataArgs]),
      'baseline.evidence',
    );
    expect(evidence.artifactId).toBe(artifactId);
    expect(evidence.content as string).toContain('baseline ok');

    // 9) 显式拒绝：持久 not_run（零启动，不折算通过），退出码 0。
    const declined = await runApp([
      'baseline', 'run', '--project', projectId, '--input', passPlan, '--decline', ...dataArgs,
    ]);
    const declineResult = okResult(declined, 'baseline.run');
    expect(declineResult.state).toBe('not_run');
    expect(declineResult.status).toBe('not_run');
    expect(declineResult.reasonCode).toBe('authorization_rejected');
    const declinedStatus = okResult(
      await runApp(['baseline', 'status', declineResult.operationId as string, ...dataArgs]),
      'baseline.status',
    );
    expect(declinedStatus.status).toBe('not_run');
    expect(declinedStatus.checks).toEqual([]);

    // 10) 显式取消在途操作（唯一取消途径；回执前完成停止核验）。
    const hangPlan = writePlan('hang', [hangCheck()]);
    const accepted = await runApp([
      'baseline', 'run', '--project', projectId, '--input', hangPlan, '--confirm', ...dataArgs,
    ]);
    const acceptedResult = okResult(accepted, 'baseline.run');
    expect(acceptedResult.status).toBe('accepted');
    expect(acceptedResult.state).toBe('accepted');
    const hangOperationId = acceptedResult.operationId as string;

    const cancel = await runApp(['baseline', 'cancel', hangOperationId, '--confirm', ...dataArgs]);
    const cancelResult = okResult(cancel, 'baseline.cancel');
    expect(cancelResult.state).toBe('cancelled');
    const cancelledStatus = okResult(
      await runApp(['baseline', 'status', hangOperationId, ...dataArgs]),
      'baseline.status',
    );
    expect(cancelledStatus.status).toBe('cancelled');

    // 11) 显式停止 Host（三证据），重启后注册、历史与证据仍可查询。
    const stopIo = collectIo();
    const stop = await runHostCli({
      args: ['host', 'stop', '--data-root', root, '--json'],
      io: stopIo.io as HostCliIo,
      env: {},
    });
    expect(stop.exitCode, stopIo.stderr()).toBe(0);

    const overviewAfter = okResult(
      await runApp(['project', 'overview', projectId, ...dataArgs]),
      'project.overview',
    );
    expect((overviewAfter.registration as { status: string }).status).toBe('registered');

    const statusAfter = okResult(
      await runApp(['baseline', 'status', operationId, ...dataArgs]),
      'baseline.status',
    );
    expect(statusAfter.state).toBe('passed');

    const evidenceAfter = okResult(
      await runApp(['baseline', 'evidence', artifactId, ...dataArgs]),
      'baseline.evidence',
    );
    expect(evidenceAfter.content).toEqual(evidence.content);
  }, 240_000);
});

/* ================================================================== *
 * 2) 命令契约：文档示例命令行与纯契约面一致
 * ================================================================== */

/** 提取操作说明 §4 代码块中的 `node packages/cli/dist/bin.js …` 逻辑命令行。 */
function documentedInvocations(): string[][] {
  const section = operationsDoc.slice(
    operationsDoc.indexOf('## 4.'),
    operationsDoc.indexOf('## 5.'),
  );
  const block = /```sh\n([\s\S]*?)```/.exec(section);
  expect(block, '操作说明 §4 必须包含 sh 代码块').not.toBeNull();
  const lines = (block as RegExpExecArray)[1].split('\n');
  const invocations: string[][] = [];
  let pending: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.length === 0) continue;
    const candidate: string = pending === null ? trimmed : `${pending} ${trimmed}`;
    pending = null;
    if (!candidate.startsWith('node packages/cli/dist/bin.js')) {
      expect(candidate.endsWith('\\'), `续行标记只允许出现在 CLI 命令行上：${candidate}`).toBe(false);
      continue;
    }
    if (candidate.endsWith('\\')) {
      pending = candidate.slice(0, -1).trim();
      continue;
    }
    invocations.push(tokenize(candidate.slice('node packages/cli/dist/bin.js'.length).trim()));
  }
  expect(pending, '文档命令行不得以悬挂续行结尾').toBeNull();
  return invocations;
}

/** 极简 shell 风格分词：空白分隔、双引号保留内容（示例中无转义/单引号参数）。 */
function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of commandLine) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  expect(quoted, `引号不配对：${commandLine}`).toBe(false);
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function bindPlaceholders(tokens: readonly string[]): string[] {
  const bindings: Record<string, string> = {
    $REPO: join(fixture.root, 'doc-repo'),
    $ROOT: join(fixture.root, 'doc-data'),
    $PROJECT_ID: randomUUID(),
    $OPERATION_ID: randomUUID(),
    $ARTIFACT_ID: randomUUID(),
  };
  return tokens.map((token) => {
    let bound = token;
    for (const [placeholder, value] of Object.entries(bindings)) {
      bound = bound.split(placeholder).join(value);
    }
    return bound;
  });
}

describe('F-019 文档示例命令契约（纯面层，无 I/O）', () => {
  it('操作说明 §4 每条 dist CLI 命令行都被真实解析面接受，命令集与文档一致', () => {
    const invocations = documentedInvocations();
    expect(invocations.length).toBeGreaterThanOrEqual(12);

    const seenCommands = new Set<string>();
    for (const invocation of invocations) {
      const bound = bindPlaceholders(invocation);
      const [group, subcommand] = bound;
      seenCommands.add(`${group} ${subcommand}`);
      if (group === 'host') {
        expect(() => parseHostCliArgs(bound, {}), JSON.stringify(bound)).not.toThrow();
      } else {
        const parsed = parseAppCliArgs(bound, {}, { cwd: fixture.root });
        expect('commandId' in parsed, JSON.stringify(bound)).toBe(true);
        expect('commandId' in parsed ? parsed.commandId : null).toBe(`${group}.${subcommand}`);
      }
    }

    // 文档示例覆盖的命令面与契约 §12.1 一致（不缺不多）。
    expect([...seenCommands].sort()).toEqual([
      'baseline cancel',
      'baseline evidence',
      'baseline list',
      'baseline preview',
      'baseline run',
      'baseline status',
      'host stop',
      'project init',
      'project overview',
    ]);
  });

  it('文档记录的退出码语义与 baselineCliExitCode/解析纪律一致', () => {
    // 查询/取消成功 → 0；run accepted（未等待）→ 0；decline 记录 not_run → 0。
    expect(baselineCliExitCode({ command: 'status' })).toBe(0);
    expect(baselineCliExitCode({ command: 'cancel', state: 'cancelled' })).toBe(0);
    expect(baselineCliExitCode({ command: 'run', state: 'accepted' })).toBe(0);
    expect(baselineCliExitCode({ command: 'run', decision: 'decline', state: 'not_run' })).toBe(0);
    // --wait 仅当 completed 且全 required passed → 0；其余终态 → 1。
    expect(baselineCliExitCode({ command: 'run', decision: 'authorize', waited: true, state: 'passed' })).toBe(0);
    expect(baselineCliExitCode({ command: 'run', decision: 'authorize', waited: true, state: 'failed' })).toBe(1);
    expect(baselineCliExitCode({ command: 'run', decision: 'authorize', waited: true, state: 'timeout' })).toBe(1);
    expect(baselineCliExitCode({ command: 'run', decision: 'authorize', waited: true, state: 'stop_unconfirmed' })).toBe(1);
    expect(baselineCliExitCode({ command: 'run', decision: 'authorize', waited: true, state: 'cancelled' })).toBe(1);
    expect(baselineCliExitCode({ command: 'run', decision: 'authorize', waited: true, state: 'not_run' })).toBe(1);

    // --confirm 与 --decline 互斥且必居其一（缺席/同时 → 输入错误，退出码 2）。
    const projectId = randomUUID();
    for (const extra of [[], ['--confirm', '--decline']]) {
      expect(() =>
        parseAppCliArgs(
          ['baseline', 'run', '--project', projectId, '--input', '/tmp/plan.json', ...extra],
          {},
          { cwd: fixture.root },
        ),
      ).toThrow(AppCliParseError);
    }
  });

  it('文档 §3 检查计划示例与校验契约一致（范围外拒绝）', () => {
    // 逐字提取文档 §3 的 json 代码块（计划示例与契约测试共用同一输入）。
    const section = operationsDoc.slice(
      operationsDoc.indexOf('## 3.'),
      operationsDoc.indexOf('## 4.'),
    );
    const block = /```json\n([\s\S]*?)```/.exec(section);
    expect(block, '操作说明 §3 必须包含检查计划 json 示例').not.toBeNull();
    const documentedPlan = (block as RegExpExecArray)[1];
    expect(documentedPlan).toContain('"checkKey": "unit"');
    const plan = parseBaselineCheckPlanText(documentedPlan, {});
    expect(plan.checks).toHaveLength(1);
    expect(plan.checks[0]?.argv).toEqual(['node', '--test', 'test/unit.test.js']);
    expect(plan.checks[0]?.cwdRef).toBe('packages/demo');

    // 越界 timeout 与非法 checkKey 由契约拒绝（invalid_input）。
    for (const badPlan of [
      '{"checks":[{"checkKey":"x","kind":"command","argv":["/bin/true"],"timeoutMs":0,"required":true}]}',
      '{"checks":[{"checkKey":"x","kind":"command","argv":["/bin/true"],"timeoutMs":3600001,"required":true}]}',
      '{"checks":[{"checkKey":"Bad Key","kind":"command","argv":["/bin/true"],"timeoutMs":60000,"required":true}]}',
      '{"checks":[]}',
    ]) {
      try {
        parseBaselineCheckPlanText(badPlan, {});
        throw new Error(`plan should be rejected: ${badPlan}`);
      } catch (error) {
        expect(error, badPlan).toBeInstanceOf(AppCliParseError);
        expect((error as AppCliParseError).code).toBe('invalid_input');
      }
    }
  });
});

/* ================================================================== *
 * 3) 文档事实交叉核对（语义、Schema、路由、交接面、安全边界）
 * ================================================================== */

describe('F-019 操作/交接文档事实核对', () => {
  it('操作说明记录接入、基线授权与故障处理语义，且只声明已实现能力', () => {
    // 命令面与真实构建入口。
    for (const token of [
      'packages/cli/dist/bin.js',
      'node packages/cli/dist/bin.js',
      'npm run build',
      'project init',
      'project overview',
      'baseline preview',
      'baseline run',
      'baseline list',
      'baseline status',
      'baseline cancel',
      'baseline evidence',
      'host stop',
      '--data-root',
      '--confirm',
      '--decline',
      '--input',
      '--wait',
      '--follow',
      '--json',
    ]) {
      expect(operationsDoc, token).toContain(token);
    }

    // 注册与健康独立；失败不撤销注册；已知失败不是验收豁免。
    for (const token of [
      'not_run',
      'no_baseline',
      '不撤销项目注册',
      '豁免',
    ]) {
      expect(operationsDoc, token).toContain(token);
    }

    // 拒绝/缺命令/未知脚本、失败/超时/取消/停止未确认、输出缺口、过期授权、观察退出。
    for (const token of [
      'authorization_rejected',
      'missing_command',
      'unknown_script',
      'spawn_failed',
      'timed_out',
      'cancelled',
      'stop_unconfirmed',
      'source_changed',
      'evidence_incomplete',
      'output_overflow',
      'restart_recovery',
      'preview_stale',
      'expiresAt',
      'observation_interrupted',
      'baseline_in_progress',
      'truncated',
    ]) {
      expect(operationsDoc, token).toContain(token);
    }

    // 观察退出语义与退出码档位。
    for (const token of ['退出码 0', '退出码 1', '退出码 2', '退出码 4']) {
      expect(operationsDoc, token).toContain(token);
    }
    expect(operationsDoc).toContain('操作未被取消');

    // 不自动安装/修复仓库。
    expect(operationsDoc).toContain('不自动安装');
    expect(operationsDoc).toContain('不自动修复');

    // 安全边界。
    for (const token of ['macOS', '可信', '强文件/进程沙箱', 'accept:p02']) {
      expect(operationsDoc, token).toContain(token);
    }

    // 引用的测试入口真实存在。
    for (const testPath of [
      'test/p02-3-init-overview-vertical.test.ts',
      'test/p02-3-baseline-cli-vertical.test.ts',
      'test/p02-3-integration-regression.test.ts',
      'test/docs-p02-3-operations.test.ts',
    ]) {
      expect(operationsDoc, testPath).toContain(testPath);
      expect(existsSync(resolve(REPO_ROOT, testPath)), testPath).toBe(true);
    }

    // 产物不含开发机/Harness 固定路径或凭据。
    expect(operationsDoc).not.toContain('/Users/ganlu');
    expect(operationsDoc).not.toContain('/workspace/');
    expect(operationsDoc).not.toMatch(/[0-9a-f]{64}/);
    expect(operationsDoc).not.toMatch(/Bearer\s+[0-9a-zA-Z]{16,}/);
  });

  it('交接文档指向真实 Schema/窄服务/路由/HostClient/退出码/停止恢复/测试入口', () => {
    // Schema（迁移 v1..v4 表）。
    for (const table of [
      'projects',
      'repository_bindings',
      'state_events',
      'command_receipts',
      'baseline_authorizations',
      'baseline_operations',
      'baseline_check_results',
      'baseline_occupancy',
      'artifacts',
    ]) {
      expect(handoffDoc, table).toContain(table);
    }
    expect(handoffDoc).toMatch(/v4/);

    // Core 窄服务与端口。
    for (const surface of [
      'shiploop-core/assembly',
      'openCoreApplication',
      'onboardingService',
      'baselineService',
      'baselineExecutionService',
      'baselineQueryService',
      'baselineStore',
      'CommandProcessPort',
      'createBaselineEvidenceCollector',
      'commandService.submit',
    ]) {
      expect(handoffDoc, surface).toContain(surface);
    }

    // Host 路由与 HostClient。
    for (const route of [
      'GET /v1/projects/inspect',
      'GET /v1/projects/:projectId/overview',
      'POST /v1/commands',
      'GET /v1/projects/:projectId/baselines',
      'GET /v1/baselines/:operationId',
      'GET /v1/artifacts/:artifactId/content',
    ]) {
      expect(handoffDoc, route).toContain(route);
    }
    for (const method of [
      'inspectRepository',
      'getProjectOverview',
      'previewBaseline',
      'runBaseline',
      'cancelBaseline',
      'listBaselines',
      'getBaseline',
      'readArtifactContent',
    ]) {
      expect(handoffDoc, method).toContain(method);
    }

    // CLI 退出码五档。
    for (const token of ['退出码 0', '退出码 1', '退出码 2', '退出码 3', '退出码 4', 'observation_interrupted']) {
      expect(handoffDoc, token).toContain(token);
    }

    // 受监督停止与恢复约束。
    for (const token of [
      'SIGTERM',
      'SIGKILL',
      'stop_unconfirmed',
      'restart_recovery',
      'quiesce',
      '单并发',
      'recover',
    ]) {
      expect(handoffDoc, token).toContain(token);
    }

    // 测试/证据入口真实存在；双客户端演示交接。
    for (const path of [
      'test/p02-3-baseline-cli-vertical.test.ts',
      'test/p02-3-integration-regression.test.ts',
      'test/helpers/p02-3/',
      'test/helpers/p02-2/storage-probe.ts',
      'baseline evidence',
    ]) {
      expect(handoffDoc, path).toContain(path);
    }
    expect(handoffDoc).toContain('双客户端');
    expect(existsSync(resolve(REPO_ROOT, 'test/helpers/p02-2/storage-probe.ts'))).toBe(true);

    // 阶段边界与安全边界如实交接。
    for (const token of ['accept:p02', 'not_run', 'macOS', '强文件/进程沙箱', 'Work', 'Pi SDK']) {
      expect(handoffDoc, token).toContain(token);
    }

    // README 记录交付入口与文档。
    expect(readmeDoc).toContain('docs/p02-3-operations.md');
    expect(readmeDoc).toContain('docs/p02-3-handoff.md');

    // 交接文档与 README 不含开发机路径或真实凭据样例。
    expect(handoffDoc).not.toContain('/Users/ganlu');
    expect(handoffDoc).not.toMatch(/[0-9a-f]{64}/);
    expect(readmeDoc).not.toContain('/Users/ganlu');
  });
});
