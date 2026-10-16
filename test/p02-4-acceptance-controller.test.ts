/**
 * P02-4 / F-011 `npm run accept:p02` 验收控制器回归（检查 `P02-PHASE-FIXTURE`
 * 与阶段退出语义，契约见 docs/p02-4-acceptance-contract.md §2.1/§2.5/§3.8）。
 *
 * 覆盖（F-011 验收第 4 条）：
 * - 成功：全部步骤退出 0 → exit 0、15 必需检查全 pass、预期负例携带冻结断言集合、
 *   报告/证据可整目录重验且不含个人绝对路径；
 * - 场景失败：步骤非零 → 映射检查 fail（不带断言）、后续未启动步骤 not_run；
 * - 准备失败：注入准备错误 → P02-PHASE-FIXTURE fail、其余检查 not_run/startup_failure、
 *   报告仍保留已取得证据；
 * - 超时：步骤超时 → not_run/timeout 且进程组被终止并核验停止；整体预算耗尽同样
 *   使步骤以有限预算超时（不悬挂）；
 * - 必需项未运行：启动失败/场景入口缺失/步骤计划未覆盖 → 明确 not_run 分类且
 *   exit 1（P02-PHASE-NOT-RUN 控制求值单元覆盖 missing_result 拒绝）；
 * - 证据损坏：写出后证据被破坏 → 重验失败、evidenceOk=false、exit 1；
 * - 报告写入错误：run-id 目录已存在 → exit 1 且诊断明确；
 * - 输出上限截断记录、连续两次运行互不覆盖、合成凭据统一脱敏、非法 run-id 拒绝。
 *
 * 注入仅控制验收工具故障（快速真实 node 子进程替代场景入口、注入事实/准备错误/
 * 证据损坏），不 mock 子进程、不递归运行完整 verify/accept:p02、不调用模型，
 * 也不以假数据库/Git/Host 代替产品行为（产品行为由 F-003~F-008 场景入口真实执行）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS,
  P02_ACCEPT_CONFIG_PATH,
  loadP02AcceptanceConfig,
  validateP02AcceptanceConfig,
} from '../scripts/acceptance/p02-config.ts';
import type { P02AcceptanceConfig } from '../scripts/acceptance/p02-config.ts';
import {
  P02AcceptError,
  P02_PENDING_CLEAN_REPLAY_ENTRY,
  buildP02ProductionSteps,
  collectP02EnvironmentFacts,
  evaluateP02NotRunControl,
  runP02Acceptance,
} from '../scripts/acceptance/p02-accept.ts';
import type {
  P02AcceptancePrepareContext,
  P02AcceptanceRunResult,
  P02AcceptanceStep,
  P02EnvironmentFacts,
} from '../scripts/acceptance/p02-accept.ts';
import {
  P02_REQUIRED_CHECKS,
  P02_REQUIRED_CHECK_IDS,
  aggregateP02CheckResults,
  validateP02AcceptanceReport,
  verifyP02ReportDirectory,
} from '../scripts/acceptance/p02-report.ts';
import type { P02AcceptanceReport, P02AggregatedCheck } from '../scripts/acceptance/p02-report.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CONFIG_PATH = resolve(REPO_ROOT, P02_ACCEPT_CONFIG_PATH);
const SYNTHETIC_SECRET = 'keychain://P02-4-TOP-SECRET-SENTINEL';
const FIXED_NOW = new Date(Date.UTC(2026, 9, 3, 1, 2, 3));

const trackedSandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of trackedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function newSandbox(): string {
  const sandbox = createTempSandbox('shiploop-p02-4-accept-', {
    outside: [REPO_ROOT, homedir()],
  });
  trackedSandboxes.push(sandbox.path);
  return sandbox.path;
}

function expectAcceptError(fn: () => unknown, kind: string): P02AcceptError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(P02AcceptError);
    expect((error as P02AcceptError).kind).toBe(kind);
    return error as P02AcceptError;
  }
  throw new Error(`应抛出 P02AcceptError(${kind})`);
}

/**
 * 测试配置：以仓库真实配置为底本（保持冻结检查/场景映射/前序基线不变），
 * 仅收紧预算与输出上限；mutate 允许用例按需调整。
 */
function testConfig(mutate?: (raw: Record<string, unknown>) => void): P02AcceptanceConfig {
  const raw = JSON.parse(readFileSync(REAL_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
  raw.timeouts = { verifyMs: 60_000, scenarioMs: 60_000, overallMs: 300_000 };
  raw.maxCommandOutputBytes = 65_536;
  if (mutate !== undefined) {
    mutate(raw);
  }
  return validateP02AcceptanceConfig(raw);
}

function fakeFacts(): P02EnvironmentFacts {
  return {
    git: {
      commit: 'a'.repeat(40),
      worktree: 'clean',
      branch: 'feat/controller-test',
      codeSha256: 'b'.repeat(64),
    },
    platform: { system: 'TestOS', release: '1.0', arch: 'x64' },
    tools: {
      node: 'v22.19.0',
      npm: '10.9.3',
      git: 'git version 2.50.1',
      sqlite: '3.53.4',
      betterSqlite3: '13.0.3',
      drizzleOrm: '0.45.3',
    },
    schemaVersions: {
      settingsSchema: 2,
      settingsExportFormat: 1,
      sqliteMigrations: [1, 2, 3, 4, 5],
      applicationWireSchema: 4,
      eventEnvelopeSchema: 1,
    },
    planDigestSha256: 'c'.repeat(64),
  };
}

type StepBehavior = {
  readonly script?: string;
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly entryFile?: string;
};

/** 快速假步骤：真实 node 子进程（显式 argv），脚本行为可注入；与真实配置场景顺序一致。 */
function fakeSteps(behaviors: Record<string, StepBehavior> = {}): P02AcceptanceStep[] {
  const config = loadP02AcceptanceConfig(REAL_CONFIG_PATH);
  return config.scenarios.map((scenario) => {
    const behavior = behaviors[scenario.id] ?? {};
    return {
      stepId: scenario.id,
      label: `fake ${scenario.id}`,
      command: behavior.command ?? process.execPath,
      args: ['-e', behavior.script ?? 'process.exit(0)'],
      checkIds: [...scenario.checkIds],
      timeoutMs: behavior.timeoutMs ?? 30_000,
      ...(behavior.entryFile !== undefined ? { entryFile: behavior.entryFile } : {}),
    };
  });
}

async function runController(options: {
  readonly sandbox: string;
  readonly steps?: readonly P02AcceptanceStep[];
  readonly config?: P02AcceptanceConfig;
  readonly runIdSuffix?: string;
  readonly prepare?: (context: P02AcceptancePrepareContext) => void;
  readonly afterReportWrite?: (runDir: string) => void;
  readonly sensitiveValues?: readonly string[];
}): Promise<P02AcceptanceRunResult> {
  return runP02Acceptance({
    repoRoot: REPO_ROOT,
    config: options.config ?? testConfig(),
    overrides: { reportDir: join(options.sandbox, 'reports') },
    steps: options.steps ?? fakeSteps(),
    collectFacts: async () => fakeFacts(),
    nowUtc: () => FIXED_NOW,
    runIdSuffix: options.runIdSuffix ?? 'a1b2c3d4',
    ...(options.prepare !== undefined ? { prepare: options.prepare } : {}),
    ...(options.afterReportWrite !== undefined
      ? { afterReportWrite: options.afterReportWrite }
      : {}),
    ...(options.sensitiveValues !== undefined ? { sensitiveValues: options.sensitiveValues } : {}),
  });
}

function readReport(runDir: string): P02AcceptanceReport {
  return validateP02AcceptanceReport(
    JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf-8')),
  );
}

function findCheck(report: P02AcceptanceReport, checkId: string): P02AggregatedCheck {
  const check = report.checks.find((entry) => entry.id === checkId);
  expect(check, `缺少检查 ${checkId}`).toBeDefined();
  return check as P02AggregatedCheck;
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(child) : [child];
  });
}

describe('F-011 验收控制器（真实有界子进程 + 隔离夹具）', () => {
  it('全部步骤退出 0 时 exit 0，15 检查全 pass、负例带冻结断言、报告可重验且无个人路径', async () => {
    const sandbox = newSandbox();
    const result = await runController({ sandbox });
    expect(result.exitCode).toBe(0);
    expect(result.conclusion).toBe('pass');
    expect(result.counts).toEqual({ pass: 15, fail: 0, not_run: 0, total: 15 });
    expect(result.reportWritten).toBe(true);
    expect(result.evidenceOk).toBe(true);
    const runDir = result.runDir as string;
    expect(verifyP02ReportDirectory(runDir).ok).toBe(true);

    const report = readReport(runDir);
    expect(report.runId).toBe('20261003T010203Z-a1b2c3d4');
    expect(report.commands).toHaveLength(11);
    for (const command of report.commands) {
      expect(command.cwd).toBe('<repo>');
      expect(command.exitCode).toBe(0);
      expect(command.timedOut).toBeUndefined();
    }
    // 预期负例 pass 恰携带冻结断言集合（不多不少）。
    for (const definition of P02_REQUIRED_CHECKS) {
      const check = findCheck(report, definition.id);
      expect(check.status).toBe('pass');
      if (definition.expectedNegative) {
        expect(check.errorAssertion).toBe(
          definition.requiredAssertions.includes('error') ? true : null,
        );
        expect(check.zeroStartAssertion).toBe(
          definition.requiredAssertions.includes('zeroStart') ? true : null,
        );
        expect(check.persistentStateAssertion).toBe(
          definition.requiredAssertions.includes('persistentState') ? true : null,
        );
      }
    }
    // 证据引用全部在清单内；每个步骤一条命令日志、每个检查一份结果证据。
    const manifestPaths = new Set(report.evidence.map((entry) => entry.path));
    expect(report.evidence.filter((entry) => entry.path.startsWith('evidence/commands/'))).toHaveLength(11);
    for (const check of report.checks) {
      for (const ref of check.evidenceRefs) {
        expect(manifestPaths.has(ref)).toBe(true);
      }
      expect(existsSync(join(runDir, ...check.evidenceRefs[0]!.split('/')))).toBe(true);
    }
    // 报告/摘要/证据不包含仓库或个人绝对路径。
    const allText = walkFiles(runDir)
      .map((file) => readFileSync(file, 'utf-8'))
      .join('\n');
    expect(allText).not.toContain(REPO_ROOT);
    expect(allText).not.toContain(process.execPath);
    expect(allText).not.toContain(sandbox);
    expect(readFileSync(join(runDir, 'summary.md'), 'utf-8')).toContain(report.runId);
  });

  it('verify 步骤非零 → P02-ENG-VERIFY fail、未启动必需检查 not_run、证据保留且 exit 1', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      steps: fakeSteps({ verify: { script: 'process.exit(1)' } }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 0, fail: 1, not_run: 14, total: 15 });
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P02-ENG-VERIFY').status).toBe('fail');
    expect(findCheck(report, 'P02-FR1-UNIQUE-HOST').notRunReason).toBe('startup_failure');
    expect(findCheck(report, 'P02-ENG-CLEAN-REPLAY').notRunReason).toBe('startup_failure');
    // 夹具准备本身成功（准备阶段与场景执行分离），但控制器场景检查未运行。
    expect(findCheck(report, 'P02-PHASE-FIXTURE').notRunReason).toBe('startup_failure');
    // 失败步骤的命令日志作为已取得证据保留且可重验。
    const verifyLog = join(result.runDir as string, 'evidence/commands/01-verify.log');
    expect(existsSync(verifyLog)).toBe(true);
    expect(statSync(verifyLog).size).toBeGreaterThan(0);
    expect(verifyP02ReportDirectory(result.runDir as string).ok).toBe(true);
  });

  it('失败输出含多行凭据形状时省略受影响的输出流，仍写出可核验的失败报告', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      steps: fakeSteps({ verify: { script: 'console.log("safe diagnostic"); console.error(JSON.stringify({token:"synthetic-sensitive-value"},null,2)); console.error("Bearer synthetic-sensitive-header"); process.exit(1)' } }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.reportWritten).toBe(true);
    expect(result.evidenceOk).toBe(true);
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P02-ENG-VERIFY').status).toBe('fail');
    const log = readFileSync(join(result.runDir as string, 'evidence/commands/01-verify.log'), 'utf8');
    expect(log).toContain('safe diagnostic');
    expect(log).toContain('credential-shaped output redacted');
    expect(log).not.toContain('synthetic-sensitive-value');
    expect(log).not.toContain('synthetic-sensitive-header');
    expect(verifyP02ReportDirectory(result.runDir as string).ok).toBe(true);
  });

  it('中间场景步骤断言失败 → 映射检查 fail 不带断言、后续未启动 not_run', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      steps: fakeSteps({ idempotency: { script: 'process.exit(1)' } }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 4, fail: 2, not_run: 9, total: 15 });
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P02-ENG-VERIFY').status).toBe('pass');
    expect(findCheck(report, 'P02-FR1-BASELINE-OK').status).toBe('pass');
    for (const checkId of ['P02-FR2-DUPLICATE-INIT', 'P02-FR2-COMMAND-CONFLICT']) {
      const check = findCheck(report, checkId);
      expect(check.status).toBe('fail');
      expect(check.errorAssertion).toBeNull();
      expect(check.zeroStartAssertion).toBeNull();
      expect(check.persistentStateAssertion).toBeNull();
    }
    expect(findCheck(report, 'P02-FR2-SOURCE-PRESERVED').notRunReason).toBe('startup_failure');
    expect(findCheck(report, 'P02-ENG-CLEAN-REPLAY').notRunReason).toBe('startup_failure');
  });

  it('步骤超时 → 映射检查 not_run/timeout，进程组被终止并核验停止', async () => {
    const sandbox = newSandbox();
    const started = Date.now();
    const result = await runController({
      sandbox,
      steps: fakeSteps({
        restart: { script: 'setTimeout(() => process.exit(0), 60000)', timeoutMs: 800 },
      }),
    });
    const elapsed = Date.now() - started;
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 8, fail: 0, not_run: 7, total: 15 });
    // 子进程被真正终止：整个控制器耗时应远小于脚本的 60s 睡眠时间。
    expect(elapsed).toBeLessThan(30_000);
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P02-FR2-CLIENT-EXIT').notRunReason).toBe('timeout');
    expect(findCheck(report, 'P02-FR1-RESTART-QUERY').notRunReason).toBe('timeout');
    expect(findCheck(report, 'P02-FR2-BASELINE-FAILURE').notRunReason).toBe('startup_failure');
    const timedOutCommand = report.commands.find((command) => command.label === 'fake restart');
    expect(timedOutCommand?.timedOut).toBe(true);
    expect(timedOutCommand?.exitCode).toBeNull();
    expect(result.problems.filter((problem) => problem.includes('核验进程停止'))).toHaveLength(0);
  });

  it('整体预算耗尽 → 步骤以剩余预算超时（not_run/timeout），控制器不悬挂', async () => {
    const sandbox = newSandbox();
    const started = Date.now();
    const config = testConfig((raw) => {
      raw.timeouts = { verifyMs: 1_000, scenarioMs: 1_000, overallMs: 1_000 };
    });
    const result = await runController({
      sandbox,
      config,
      steps: fakeSteps({ verify: { script: 'setTimeout(() => process.exit(0), 60000)' } }),
    });
    const elapsed = Date.now() - started;
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 0, fail: 0, not_run: 15, total: 15 });
    // 步骤自身预算 30s，但整体预算 1s 先行耗尽：实际按剩余预算超时。
    expect(elapsed).toBeLessThan(20_000);
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P02-ENG-VERIFY').notRunReason).toBe('timeout');
    const timedOutCommand = report.commands[0];
    expect(timedOutCommand?.timedOut).toBe(true);
  });

  it('步骤启动失败（工具缺失）→ not_run/startup_failure 且 exit 1', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      steps: fakeSteps({
        verify: { command: join(sandbox, 'definitely-missing-tool-xyz') },
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 0, fail: 0, not_run: 15, total: 15 });
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P02-ENG-VERIFY').notRunReason).toBe('startup_failure');
    expect(findCheck(report, 'P02-FR2-BASELINE-FAILURE').notRunReason).toBe('startup_failure');
  });

  it('场景入口缺失（后继任务约定入口未交付）→ 该检查 not_run/startup_failure、已取得证据保留', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      steps: fakeSteps({
        'clean-replay': { entryFile: 'test/definitely-missing-entry.test.ts' },
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 14, fail: 0, not_run: 1, total: 15 });
    const runDir = result.runDir as string;
    const report = readReport(runDir);
    const cleanReplay = findCheck(report, 'P02-ENG-CLEAN-REPLAY');
    expect(cleanReplay.status).toBe('not_run');
    expect(cleanReplay.notRunReason).toBe('startup_failure');
    expect(cleanReplay.detail).toContain('场景入口不存在');
    // 前序步骤照常执行（入口缺失步骤未启动、不产生命令记录），命令日志作为已取得证据保留且可重验。
    expect(report.commands).toHaveLength(10);
    expect(existsSync(join(runDir, 'evidence/commands/10-acceptance-report.log'))).toBe(true);
    expect(existsSync(join(runDir, 'evidence/checks/P02-ENG-CLEAN-REPLAY.json'))).toBe(true);
    expect(verifyP02ReportDirectory(runDir).ok).toBe(true);
  });

  it('步骤计划未覆盖的必需检查 → 安全网明确 not_run/startup_failure 且计入 problems', async () => {
    const sandbox = newSandbox();
    const steps = fakeSteps().filter((step) => step.stepId !== 'clean-replay');
    const result = await runController({ sandbox, steps });
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 14, fail: 0, not_run: 1, total: 15 });
    const report = readReport(result.runDir as string);
    const cleanReplay = findCheck(report, 'P02-ENG-CLEAN-REPLAY');
    expect(cleanReplay.notRunReason).toBe('startup_failure');
    expect(cleanReplay.detail).toContain('步骤计划未提交该检查结果');
    expect(result.problems.some((problem) => problem.includes('P02-ENG-CLEAN-REPLAY'))).toBe(true);
  });

  it('注入准备错误 → P02-PHASE-FIXTURE fail、其余必需检查 not_run、报告保留证据且 exit 1', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      prepare: () => {
        throw new Error('注入的夹具准备失败');
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.reportWritten).toBe(true);
    expect(result.counts).toEqual({ pass: 0, fail: 1, not_run: 14, total: 15 });
    const runDir = result.runDir as string;
    const report = readReport(runDir);
    const fixtureCheck = findCheck(report, 'P02-PHASE-FIXTURE');
    expect(fixtureCheck.status).toBe('fail');
    expect(fixtureCheck.detail).toContain('注入的夹具准备失败');
    for (const check of report.checks) {
      if (check.id === 'P02-PHASE-FIXTURE') {
        continue;
      }
      expect(check.status).toBe('not_run');
      expect(check.notRunReason).toBe('startup_failure');
    }
    expect(report.commands).toHaveLength(0);
    // 已取得证据（配置/环境快照）保留且报告可重验。
    expect(existsSync(join(runDir, 'evidence/config.json'))).toBe(true);
    expect(existsSync(join(runDir, 'evidence/environment.json'))).toBe(true);
    expect(verifyP02ReportDirectory(runDir).ok).toBe(true);
  });

  it('报告写入失败（run-id 目录已存在）→ exit 1 且诊断明确', async () => {
    const sandbox = newSandbox();
    const reportDir = join(sandbox, 'reports');
    mkdirSync(join(reportDir, '20261003T010203Z-a1b2c3d4'), { recursive: true });
    const result = await runController({ sandbox });
    expect(result.exitCode).toBe(1);
    expect(result.reportWritten).toBe(false);
    expect(result.runDir).toBeNull();
    expect(result.problems.some((problem) => problem.includes('报告写入失败'))).toBe(true);
  });

  it('证据损坏（写出后被破坏）→ 重验失败、evidenceOk=false、exit 1', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      afterReportWrite: (runDir) => {
        writeFileSync(join(runDir, 'evidence/config.json'), 'corrupted-after-write');
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.reportWritten).toBe(true);
    expect(result.evidenceOk).toBe(false);
    // 检查本身全部通过，但证据核验失败使阶段非零（严格传播失败）。
    expect(result.conclusion).toBe('pass');
    expect(result.problems.some((problem) => problem.includes('证据损坏'))).toBe(true);
    const verification = verifyP02ReportDirectory(result.runDir as string);
    expect(verification.ok).toBe(false);
  });

  it('命令输出超出上限被截断并记录缺口，不影响通过判定', async () => {
    const sandbox = newSandbox();
    const config = testConfig((raw) => {
      raw.maxCommandOutputBytes = 4096;
    });
    const result = await runController({
      sandbox,
      config,
      steps: fakeSteps({
        'dual-cli': { script: `process.stdout.write('x'.repeat(300000))` },
      }),
    });
    expect(result.exitCode).toBe(0);
    const runDir = result.runDir as string;
    const log = readFileSync(join(runDir, 'evidence/commands/02-dual-cli.log'), 'utf-8');
    expect(log).toContain('output truncated');
    expect(log).toContain('300000');
    expect(statSync(join(runDir, 'evidence/commands/02-dual-cli.log')).size).toBeLessThan(20_000);
    const checkJson = JSON.parse(
      readFileSync(join(runDir, 'evidence/checks/P02-FR1-UNIQUE-HOST.json'), 'utf-8'),
    ) as { stdoutTruncated?: unknown };
    expect(checkJson.stdoutTruncated).toBe(true);
  });

  it('连续两次运行互不依赖、互不覆盖证据', async () => {
    const sandbox = newSandbox();
    const first = await runController({ sandbox, runIdSuffix: 'a1b2c3d4' });
    const firstReportText = readFileSync(join(first.runDir as string, 'report.json'), 'utf-8');
    const second = await runController({ sandbox, runIdSuffix: 'e5f6a7b8' });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.runDir).not.toBe(second.runDir);
    expect(existsSync(first.runDir as string)).toBe(true);
    expect(existsSync(second.runDir as string)).toBe(true);
    // 第一次运行的报告在第二次运行后逐字节不变。
    expect(readFileSync(join(first.runDir as string, 'report.json'), 'utf-8')).toBe(firstReportText);
    expect(verifyP02ReportDirectory(first.runDir as string).ok).toBe(true);
    expect(verifyP02ReportDirectory(second.runDir as string).ok).toBe(true);
  });

  it('合成凭据在报告/摘要/证据附件中统一脱敏，无任何泄漏', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      steps: fakeSteps({
        'auth-reject': { script: `process.stdout.write('token=${SYNTHETIC_SECRET}')` },
      }),
      sensitiveValues: [SYNTHETIC_SECRET],
    });
    expect(result.exitCode).toBe(0);
    const files = walkFiles(result.runDir as string);
    expect(files.length).toBeGreaterThan(0);
    const combined = files.map((file) => readFileSync(file, 'utf-8')).join('\n');
    expect(combined).not.toContain(SYNTHETIC_SECRET);
    expect(combined).toContain('[REDACTED:');
  });

  it('run-id 覆盖非法时拒绝（用法错误，不产生报告）', async () => {
    const sandbox = newSandbox();
    try {
      await runP02Acceptance({
        repoRoot: REPO_ROOT,
        config: testConfig(),
        overrides: { runId: '../escape', reportDir: join(sandbox, 'reports') },
        steps: fakeSteps(),
        collectFacts: async () => fakeFacts(),
      });
      throw new Error('应抛出 P02AcceptError(invalid_usage)');
    } catch (error) {
      expect(error).toBeInstanceOf(P02AcceptError);
      expect((error as P02AcceptError).kind).toBe('invalid_usage');
    }
    expect(existsSync(join(sandbox, 'reports'))).toBe(false);
  });

  it('not_run 控制求值：missing_result 聚合判 fail，完整提交判 pass', () => {
    const empty = aggregateP02CheckResults([]);
    const failing = evaluateP02NotRunControl(empty);
    expect(failing.status).toBe('fail');
    expect(failing.detail).toContain('P02-ENG-VERIFY');
    const complete = aggregateP02CheckResults(
      P02_REQUIRED_CHECK_IDS.map((checkId) => ({ checkId, status: 'pass' as const })),
    );
    const passing = evaluateP02NotRunControl(complete);
    expect(passing.status).toBe('pass');
  });
});

describe('F-011 生产接线守护（不运行完整 verify/accept:p02）', () => {
  it('package.json 声明 accept:p02 指向本地控制器脚本（无 npx）', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    expect(manifest.scripts?.['accept:p02']).toBe('node scripts/acceptance/p02-accept.ts');
    expect(existsSync(resolve(REPO_ROOT, 'scripts/acceptance/p02-accept.ts'))).toBe(true);
  });

  it('生产步骤计划与版本化配置一致：11 步骤恰好覆盖全部 15 必需检查（顺序冻结）', () => {
    const config = loadP02AcceptanceConfig(REAL_CONFIG_PATH);
    const steps = buildP02ProductionSteps(config);
    expect(steps.map((step) => step.stepId)).toEqual(config.scenarios.map((s) => s.id));
    expect(steps.flatMap((step) => step.checkIds)).toEqual([...P02_REQUIRED_CHECK_IDS]);
    const verifyStep = steps[0];
    expect(verifyStep?.checkIds).toEqual(['P02-ENG-VERIFY']);
    expect(verifyStep?.args.slice(-2)).toEqual(['run', 'verify']);
    expect(verifyStep?.timeoutMs).toBe(config.timeouts.verifyMs);
    expect(verifyStep?.env?.SHIPLOOP_TEST_RUN_TIMEOUT_MS).toBe(String(config.timeouts.verifyMs));
    expect(verifyStep?.env?.SHIPLOOP_VERIFY_STEP_TIMEOUT_MS).toBe(String(config.timeouts.verifyMs));
    for (const [index, step] of steps.slice(1).entries()) {
      const scenario = config.scenarios[index + 1] as { kind: string; entry: string };
      expect(scenario.kind).toBe('test');
      expect(step.command).toBe(process.execPath);
      expect(step.args).toEqual(['scripts/run-tests.ts', scenario.entry]);
      expect(step.entryFile).toBe(scenario.entry);
      expect(step.timeoutMs).toBe(config.timeouts.scenarioMs);
      expect(step.env?.SHIPLOOP_TEST_RUN_TIMEOUT_MS).toBe(String(config.timeouts.scenarioMs));
    }
    expect(steps.every((step) => Number.isFinite(step.timeoutMs) && step.timeoutMs > 0)).toBe(true);
  });

  it('生产场景入口真实存在（仅 F-012 约定入口未交付时允许缺席）', () => {
    const config = loadP02AcceptanceConfig(REAL_CONFIG_PATH);
    for (const step of buildP02ProductionSteps(config)) {
      if (step.entryFile === undefined) {
        continue;
      }
      if (existsSync(resolve(REPO_ROOT, step.entryFile))) {
        continue;
      }
      // 唯一允许缺席的是 F-012 的约定入口；其余入口缺失视为接线错误。
      expect(step.entryFile).toBe(P02_PENDING_CLEAN_REPLAY_ENTRY);
      expect(step.checkIds).toEqual(['P02-ENG-CLEAN-REPLAY']);
    }
  });

  it('预算覆盖接线：verify 覆盖透传 SHIPLOOP_VERIFY_STEP_TIMEOUT_MS，场景步骤断言使用覆盖值', () => {
    const config = loadP02AcceptanceConfig(REAL_CONFIG_PATH);
    const steps = buildP02ProductionSteps(config, { stepTimeoutMs: 12_345, verifyTimeoutMs: 23_456 });
    expect(steps[0]?.timeoutMs).toBe(23_456);
    expect(steps[0]?.env?.[P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS]).toBe('23456');
    for (const step of steps.slice(1)) {
      expect(step.timeoutMs).toBe(12_345);
      expect(step.env?.SHIPLOOP_TEST_RUN_TIMEOUT_MS).toBe('12345');
    }
  });

  it('CLI 前提检查入口：--help 退出 0 输出用法；未知参数退出 1 零副作用', () => {
    const help = spawnSync(process.execPath, ['scripts/acceptance/p02-accept.ts', '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('usage:');
    expect(help.stdout).toContain('--run-id');
    const bad = spawnSync(process.execPath, ['scripts/acceptance/p02-accept.ts', '--definitely-unknown'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('FAIL');
  });

  it('真实环境事实采集返回合法版本/摘要/P02 Schema 交叉核对结果', async () => {
    const config = loadP02AcceptanceConfig(REAL_CONFIG_PATH);
    const facts = await collectP02EnvironmentFacts(REPO_ROOT, config);
    expect(facts.git.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(['clean', 'dirty']).toContain(facts.git.worktree);
    expect(facts.git.codeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.tools.node).toBe('v22.19.0');
    expect(facts.tools.npm).toBe('10.9.3');
    expect(facts.tools.git).toMatch(/^git version /);
    expect(facts.tools.sqlite).toMatch(/^\d+\.\d+\.\d+$/);
    expect(facts.tools.betterSqlite3).toBe('13.0.3');
    expect(facts.tools.drizzleOrm).toBe('0.45.3');
    expect(facts.schemaVersions).toEqual(config.schemaVersions);
    expect(facts.schemaVersions.applicationWireSchema).toBe(5);
    expect(facts.schemaVersions.eventEnvelopeSchema).toBe(1);
    expect(facts.planDigestSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
