/**
 * P01-4 / F-008 `npm run accept:p01` 验收控制器回归（检查 `P01-PHASE-FIXTURE`
 * 与阶段退出语义，契约见 docs/p01-4-acceptance-contract.md §2.1/§2.4/§3.4）。
 *
 * 覆盖：
 * - 执行配置运行时严格校验：未知 configVersion、非法/非正超时、试图移除/关闭/
 *   重排必需检查、未知字段、非法路径与非法基线 commit 一律拒绝；
 * - 控制器 fail-closed 语义（全部使用**真实有界子进程**，隔离临时夹具，不 mock
 *   子进程、不重复递归跑完整 verify）：全部通过 → exit 0 且报告可重验；步骤非零
 *   → 映射检查 fail 且未启动步骤 not_run；步骤超时 → not_run/timeout 并核验进程
 *   停止；启动失败 → not_run/startup_failure；注入准备错误 → P01-PHASE-FIXTURE
 *   fail、依赖检查 not_run、报告仍保留已取得证据；报告写入失败 → 非零且诊断明确；
 * - 输出大小上限与截断记录、连续两次运行互不覆盖证据、合成凭据对报告/摘要/
 *   证据附件统一脱敏、命令记录逻辑 argv/cwd（不写入个人绝对路径）；
 * - 生产接线守护：package.json accept:p01 脚本、生产步骤计划恰好覆盖全部非控制
 *   类必需检查、真实配置文件合法、真实环境事实采集可用。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  P01_ACCEPT_CONFIG_PATH,
  P01_CONTROL_CHECK_IDS,
  P01AcceptError,
  assertP01StepEntriesExist,
  buildP01ProductionSteps,
  collectP01EnvironmentFacts,
  loadP01AcceptanceConfig,
  runP01Acceptance,
  validateP01AcceptanceConfig,
} from '../scripts/acceptance/p01-accept.ts';
import type {
  P01AcceptanceConfig,
  P01AcceptancePrepareContext,
  P01AcceptanceRunResult,
  P01AcceptanceStep,
  P01EnvironmentFacts,
} from '../scripts/acceptance/p01-accept.ts';
import {
  P01_REQUIRED_CHECKS,
  P01_REQUIRED_CHECK_IDS,
  validateP01AcceptanceReport,
  verifyP01ReportDirectory,
} from '../scripts/acceptance/p01-report.ts';
import type { P01AcceptanceReport, P01AggregatedCheck } from '../scripts/acceptance/p01-report.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CONFIG_PATH = resolve(REPO_ROOT, P01_ACCEPT_CONFIG_PATH);
const CONTRACT_DOC = readFileSync(resolve(REPO_ROOT, 'docs/p01-4-acceptance-contract.md'), 'utf-8');
const SYNTHETIC_SECRET = 'keychain://P01-4-TOP-SECRET-SENTINEL';
const FIXED_NOW = new Date(Date.UTC(2026, 9, 3, 1, 2, 3));

const trackedSandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of trackedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function newSandbox(): string {
  const sandbox = createTempSandbox('shiploop-p01-4-accept-', {
    outside: [REPO_ROOT, homedir()],
  });
  trackedSandboxes.push(sandbox.path);
  return sandbox.path;
}

function expectAcceptError(fn: () => unknown, kind: string): P01AcceptError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(P01AcceptError);
    expect((error as P01AcceptError).kind).toBe(kind);
    return error as P01AcceptError;
  }
  throw new Error(`应抛出 P01AcceptError(${kind})`);
}

/** 合法测试配置（经严格校验）；overrides 浅合并顶层字段。 */
function testConfig(overrides: Record<string, unknown> = {}): P01AcceptanceConfig {
  return validateP01AcceptanceConfig({
    configVersion: 1,
    reportRoot: 'artifacts/acceptance/p01',
    requiredChecks: [...P01_REQUIRED_CHECK_IDS],
    timeouts: { verifyMs: 60_000, scenarioMs: 60_000, smokeMs: 60_000, overallMs: 300_000 },
    maxCommandOutputBytes: 65_536,
    plan: {
      phaseId: 'test-phase-p01',
      stepId: 'p01-acceptance',
      title: 'P01 持久化闭环验收（控制器回归）',
      scope: '控制器回归沙箱',
      version: '0.2',
      contractDoc: 'docs/p01-4-acceptance-contract.md',
    },
    priorBaselines: [
      { phase: 'p01-project-config', branch: 'feat/test-baseline', tipCommit: 'd'.repeat(40) },
    ],
    schemaVersions: { settingsSchema: 2, settingsExportFormat: 1, sqliteMigrations: [1, 2] },
    ...overrides,
  });
}

function fakeFacts(): P01EnvironmentFacts {
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
    schemaVersions: { settingsSchema: 2, settingsExportFormat: 1, sqliteMigrations: [1, 2] },
    planDigestSha256: 'c'.repeat(64),
  };
}

/** 与生产计划一致的步骤 → 检查映射。 */
const STEP_MAPPING = [
  ['verify', ['P01-ENG-VERIFY']],
  ['scenario-closed-loop', ['P01-FR1-NORMAL', 'P01-FR1-REOPEN']],
  ['scenario-rollback-cas', ['P01-FR1-ROLLBACK', 'P01-FR2-ROLLBACK', 'P01-FR2-CAS']],
  ['scenario-artifact-negative', ['P01-FR2-ARTIFACT-MISSING', 'P01-FR2-ARTIFACT-RECOVERY']],
  ['scenario-config-tags', ['P01-FR2-CONFIG', 'P01-FR2-TAGS']],
  ['build-smoke', ['P01-ENG-BUILD-SMOKE']],
] as const;

type StepBehavior = {
  readonly script?: string;
  readonly command?: string;
  readonly timeoutMs?: number;
};

/** 快速假步骤：真实 node 子进程（显式 argv），脚本行为可注入。 */
function fakeSteps(behaviors: Record<string, StepBehavior> = {}): P01AcceptanceStep[] {
  return STEP_MAPPING.map(([stepId, checkIds]) => {
    const behavior = behaviors[stepId] ?? {};
    return {
      stepId,
      label: `fake ${stepId}`,
      command: behavior.command ?? process.execPath,
      args: ['-e', behavior.script ?? 'process.exit(0)'],
      checkIds: [...checkIds],
      timeoutMs: behavior.timeoutMs ?? 30_000,
    };
  });
}

async function runController(options: {
  readonly sandbox: string;
  readonly steps?: P01AcceptanceStep[];
  readonly config?: P01AcceptanceConfig;
  readonly runIdSuffix?: string;
  readonly prepare?: (context: P01AcceptancePrepareContext) => void;
  readonly sensitiveValues?: readonly string[];
}): Promise<P01AcceptanceRunResult> {
  return runP01Acceptance({
    repoRoot: REPO_ROOT,
    config: options.config ?? testConfig(),
    overrides: { reportDir: join(options.sandbox, 'reports') },
    steps: options.steps ?? fakeSteps(),
    collectFacts: async () => fakeFacts(),
    nowUtc: () => FIXED_NOW,
    runIdSuffix: options.runIdSuffix ?? 'a1b2c3d4',
    ...(options.prepare !== undefined ? { prepare: options.prepare } : {}),
    ...(options.sensitiveValues !== undefined ? { sensitiveValues: options.sensitiveValues } : {}),
  });
}

function readReport(runDir: string): P01AcceptanceReport {
  return validateP01AcceptanceReport(
    JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf-8')),
  );
}

function findCheck(report: P01AcceptanceReport, checkId: string): P01AggregatedCheck {
  const check = report.checks.find((entry) => entry.id === checkId);
  expect(check, `缺少检查 ${checkId}`).toBeDefined();
  return check as P01AggregatedCheck;
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(child) : [child];
  });
}

describe('F-008 执行配置严格校验', () => {
  it('拒绝未知 configVersion', () => {
    expectAcceptError(() => testConfig({ configVersion: 2 }), 'invalid_config');
    expectAcceptError(() => testConfig({ configVersion: '1' }), 'invalid_config');
  });

  it('拒绝非法/非正超时', () => {
    expectAcceptError(
      () => testConfig({ timeouts: { verifyMs: 0, scenarioMs: 60_000, smokeMs: 60_000, overallMs: 300_000 } }),
      'invalid_config',
    );
    expectAcceptError(
      () =>
        testConfig({
          timeouts: { verifyMs: 60_000, scenarioMs: -5, smokeMs: 60_000, overallMs: 300_000 },
        }),
      'invalid_config',
    );
    expectAcceptError(
      () =>
        testConfig({
          timeouts: { verifyMs: 60_000, scenarioMs: 60_000, smokeMs: 60_000, overallMs: Number.POSITIVE_INFINITY },
        }),
      'invalid_config',
    );
  });

  it('拒绝试图移除/关闭/重排/捏造必需检查的配置', () => {
    const missing = P01_REQUIRED_CHECK_IDS.slice(1);
    expectAcceptError(() => testConfig({ requiredChecks: missing }), 'invalid_config');
    const reordered = [...P01_REQUIRED_CHECK_IDS].reverse();
    expectAcceptError(() => testConfig({ requiredChecks: reordered }), 'invalid_config');
    expectAcceptError(
      () => testConfig({ requiredChecks: [...P01_REQUIRED_CHECK_IDS.slice(0, 13), 'P01-FAKE-CHECK'] }),
      'invalid_config',
    );
  });

  it('拒绝未知字段、越界路径与非法基线 commit', () => {
    expectAcceptError(() => testConfig({ unexpectedField: true }), 'invalid_config');
    expectAcceptError(() => testConfig({ reportRoot: '../escape' }), 'invalid_config');
    expectAcceptError(() => testConfig({ reportRoot: '/abs/path' }), 'invalid_config');
    expectAcceptError(
      () =>
        testConfig({
          priorBaselines: [{ phase: 'p', branch: 'b', tipCommit: 'not-a-commit' }],
        }),
      'invalid_config',
    );
    expectAcceptError(
      () => testConfig({ schemaVersions: { settingsSchema: 2, settingsExportFormat: 1, sqliteMigrations: [2, 1] } }),
      'invalid_config',
    );
  });

  it('拒绝不可解析/不存在的配置文件', () => {
    const sandbox = newSandbox();
    expectAcceptError(
      () => loadP01AcceptanceConfig(join(sandbox, 'missing.json')),
      'invalid_config',
    );
  });

  it('仓库内真实执行配置合法且与冻结清单/契约一致', () => {
    const config = loadP01AcceptanceConfig(REAL_CONFIG_PATH);
    expect(config.requiredChecks).toEqual([...P01_REQUIRED_CHECK_IDS]);
    expect(existsSync(resolve(REPO_ROOT, config.plan.contractDoc))).toBe(true);
    for (const baseline of config.priorBaselines) {
      expect(CONTRACT_DOC).toContain(baseline.tipCommit);
    }
    expect(Object.values(config.timeouts).every((value) => Number.isFinite(value) && value > 0)).toBe(
      true,
    );
  });
});

describe('F-008 验收控制器（真实有界子进程 + 隔离夹具）', () => {
  it('全部步骤退出 0 时 exit 0，报告与证据可重验且不含个人绝对路径', async () => {
    const sandbox = newSandbox();
    const result = await runController({ sandbox });
    expect(result.exitCode).toBe(0);
    expect(result.conclusion).toBe('pass');
    expect(result.counts).toEqual({ pass: 14, fail: 0, not_run: 0, total: 14 });
    expect(result.reportWritten).toBe(true);
    expect(result.evidenceOk).toBe(true);
    const runDir = result.runDir as string;
    expect(verifyP01ReportDirectory(runDir).ok).toBe(true);

    const report = readReport(runDir);
    expect(report.runId).toBe('20261003T010203Z-a1b2c3d4');
    expect(report.commands).toHaveLength(6);
    for (const command of report.commands) {
      expect(command.cwd).toBe('<repo>');
      expect(command.exitCode).toBe(0);
      expect(command.timedOut).toBeUndefined();
    }
    // 预期负例携带错误+副作用双断言。
    for (const definition of P01_REQUIRED_CHECKS) {
      const check = findCheck(report, definition.id);
      expect(check.status).toBe('pass');
      if (definition.expectedNegative) {
        expect(check.errorAssertion).toBe(true);
        expect(check.sideEffectAssertion).toBe(true);
      }
    }
    // 证据引用全部在清单内；每个步骤一条命令日志。
    const manifestPaths = new Set(report.evidence.map((entry) => entry.path));
    expect(report.evidence.filter((entry) => entry.path.startsWith('evidence/commands/'))).toHaveLength(6);
    for (const check of report.checks) {
      for (const ref of check.evidenceRefs) {
        expect(manifestPaths.has(ref)).toBe(true);
      }
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

  it('verify 步骤非零 → 该检查 fail、未启动必需步骤 not_run、证据保留且 exit 1', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      steps: fakeSteps({ verify: { script: 'process.exit(1)' } }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 3, fail: 1, not_run: 10, total: 14 });
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P01-ENG-VERIFY').status).toBe('fail');
    expect(findCheck(report, 'P01-FR1-NORMAL').notRunReason).toBe('startup_failure');
    expect(findCheck(report, 'P01-ENG-BUILD-SMOKE').notRunReason).toBe('startup_failure');
    expect(findCheck(report, 'P01-PHASE-FIXTURE').status).toBe('pass');
    expect(findCheck(report, 'P01-PHASE-NOT-RUN').status).toBe('pass');
    expect(findCheck(report, 'P01-PHASE-REPORT').status).toBe('pass');
    // 失败步骤的命令日志作为已取得证据保留且可重验。
    const verifyLog = join(result.runDir as string, 'evidence/commands/01-verify.log');
    expect(existsSync(verifyLog)).toBe(true);
    expect(statSync(verifyLog).size).toBeGreaterThan(0);
    expect(verifyP01ReportDirectory(result.runDir as string).ok).toBe(true);
  });

  it('中间场景步骤断言失败 → 映射检查 fail、后续未启动 not_run、负例不带双断言', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      steps: fakeSteps({ 'scenario-rollback-cas': { script: 'process.exit(1)' } }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 6, fail: 3, not_run: 5, total: 14 });
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P01-ENG-VERIFY').status).toBe('pass');
    expect(findCheck(report, 'P01-FR1-NORMAL').status).toBe('pass');
    for (const checkId of ['P01-FR1-ROLLBACK', 'P01-FR2-ROLLBACK', 'P01-FR2-CAS']) {
      const check = findCheck(report, checkId);
      expect(check.status).toBe('fail');
      expect(check.errorAssertion).toBeNull();
      expect(check.sideEffectAssertion).toBeNull();
    }
    expect(findCheck(report, 'P01-FR2-CONFIG').notRunReason).toBe('startup_failure');
    expect(findCheck(report, 'P01-ENG-BUILD-SMOKE').notRunReason).toBe('startup_failure');
  });

  it('步骤超时 → 映射检查 not_run/timeout，进程组被终止并核验停止', async () => {
    const sandbox = newSandbox();
    const started = Date.now();
    const result = await runController({
      sandbox,
      steps: fakeSteps({
        'scenario-closed-loop': {
          script: 'setTimeout(() => process.exit(0), 60000)',
          timeoutMs: 800,
        },
      }),
    });
    const elapsed = Date.now() - started;
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 4, fail: 0, not_run: 10, total: 14 });
    // 子进程被真正终止：整个控制器耗时应远小于脚本的 60s 睡眠时间。
    expect(elapsed).toBeLessThan(30_000);
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P01-FR1-NORMAL').notRunReason).toBe('timeout');
    expect(findCheck(report, 'P01-FR1-REOPEN').notRunReason).toBe('timeout');
    expect(findCheck(report, 'P01-FR1-ROLLBACK').notRunReason).toBe('startup_failure');
    const timedOutCommand = report.commands.find((command) => command.label === 'fake scenario-closed-loop');
    expect(timedOutCommand?.timedOut).toBe(true);
    expect(timedOutCommand?.exitCode).toBeNull();
    expect(result.problems.filter((problem) => problem.includes('核验进程停止'))).toHaveLength(0);
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
    expect(result.counts).toEqual({ pass: 3, fail: 0, not_run: 11, total: 14 });
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P01-ENG-VERIFY').notRunReason).toBe('startup_failure');
    expect(findCheck(report, 'P01-FR2-TAGS').notRunReason).toBe('startup_failure');
  });

  it('注入准备错误 → P01-PHASE-FIXTURE fail、其余必需检查 not_run、报告保留证据且 exit 1', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      prepare: () => {
        throw new Error('注入的夹具准备失败');
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.reportWritten).toBe(true);
    expect(result.counts).toEqual({ pass: 0, fail: 1, not_run: 13, total: 14 });
    const runDir = result.runDir as string;
    const report = readReport(runDir);
    const fixtureCheck = findCheck(report, 'P01-PHASE-FIXTURE');
    expect(fixtureCheck.status).toBe('fail');
    expect(fixtureCheck.detail).toContain('注入的夹具准备失败');
    for (const check of report.checks) {
      if (check.id === 'P01-PHASE-FIXTURE') {
        continue;
      }
      expect(check.status).toBe('not_run');
      expect(check.notRunReason).toBe('startup_failure');
    }
    // 已取得证据（配置/环境快照）保留且报告可重验。
    expect(existsSync(join(runDir, 'evidence/config.json'))).toBe(true);
    expect(existsSync(join(runDir, 'evidence/environment.json'))).toBe(true);
    expect(verifyP01ReportDirectory(runDir).ok).toBe(true);
  });

  it('步骤入口缺失 → 准备失败（P01-PHASE-FIXTURE fail），不启动任何步骤', async () => {
    const sandbox = newSandbox();
    const steps = fakeSteps();
    const broken = steps.map((step) =>
      step.stepId === 'scenario-config-tags'
        ? { ...step, args: ['scripts/definitely-missing-entry.ts'] }
        : step,
    );
    const result = await runController({ sandbox, steps: broken });
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ pass: 0, fail: 1, not_run: 13, total: 14 });
    const report = readReport(result.runDir as string);
    expect(findCheck(report, 'P01-PHASE-FIXTURE').status).toBe('fail');
    expect(findCheck(report, 'P01-PHASE-FIXTURE').detail).toContain('入口不存在');
    expect(report.commands).toHaveLength(0);
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

  it('命令输出超出上限被截断并记录缺口，不影响通过判定', async () => {
    const sandbox = newSandbox();
    const config = testConfig({ maxCommandOutputBytes: 4096 });
    const result = await runController({
      sandbox,
      config,
      steps: fakeSteps({
        'scenario-closed-loop': { script: `process.stdout.write('x'.repeat(300000))` },
      }),
    });
    expect(result.exitCode).toBe(0);
    const runDir = result.runDir as string;
    const log = readFileSync(join(runDir, 'evidence/commands/02-scenario-closed-loop.log'), 'utf-8');
    expect(log).toContain('output truncated');
    expect(log).toContain('300000');
    expect(statSync(join(runDir, 'evidence/commands/02-scenario-closed-loop.log')).size).toBeLessThan(20_000);
    const checkJson = JSON.parse(
      readFileSync(join(runDir, 'evidence/checks/P01-FR1-NORMAL.json'), 'utf-8'),
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
    expect(verifyP01ReportDirectory(first.runDir as string).ok).toBe(true);
    expect(verifyP01ReportDirectory(second.runDir as string).ok).toBe(true);
  });

  it('合成凭据在报告/摘要/证据附件中统一脱敏，无任何泄漏', async () => {
    const sandbox = newSandbox();
    const result = await runController({
      sandbox,
      steps: fakeSteps({
        'scenario-closed-loop': { script: `process.stdout.write('token=${SYNTHETIC_SECRET}')` },
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
      await runP01Acceptance({
        repoRoot: REPO_ROOT,
        config: testConfig(),
        overrides: { runId: '../escape', reportDir: join(sandbox, 'reports') },
        steps: fakeSteps(),
        collectFacts: async () => fakeFacts(),
      });
      throw new Error('应抛出 P01AcceptError(invalid_usage)');
    } catch (error) {
      expect(error).toBeInstanceOf(P01AcceptError);
      expect((error as P01AcceptError).kind).toBe('invalid_usage');
    }
    expect(existsSync(join(sandbox, 'reports'))).toBe(false);
  });
});

describe('F-008 生产接线守护（不运行完整 verify）', () => {
  it('package.json 声明 accept:p01 指向本地控制器脚本（无 npx）', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    expect(manifest.scripts?.['accept:p01']).toBe('node scripts/acceptance/p01-accept.ts');
    expect(existsSync(resolve(REPO_ROOT, 'scripts/acceptance/p01-accept.ts'))).toBe(true);
  });

  it('生产步骤计划恰好覆盖全部非控制类必需检查各一次，且入口真实存在', () => {
    const config = loadP01AcceptanceConfig(REAL_CONFIG_PATH);
    const steps = buildP01ProductionSteps(config);
    const mapped = steps.flatMap((step) => step.checkIds);
    const expected = P01_REQUIRED_CHECK_IDS.filter((id) => !P01_CONTROL_CHECK_IDS.includes(id));
    expect([...mapped].sort()).toEqual([...expected].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(steps[0]?.checkIds).toEqual(['P01-ENG-VERIFY']);
    expect(steps.every((step) => step.timeoutMs > 0 && Number.isFinite(step.timeoutMs))).toBe(true);
    expect(() => assertP01StepEntriesExist(steps, REPO_ROOT)).not.toThrow();
    // 步骤计划引用契约约定的四个必需场景测试文件。
    const scenarioFiles = steps
      .filter((step) => step.stepId.startsWith('scenario-'))
      .map((step) => step.args[1]);
    expect(scenarioFiles).toEqual([
      'test/p01-4-persistence-closed-loop.test.ts',
      'test/p01-4-sqlite-rollback-and-cas.test.ts',
      'test/p01-4-artifact-negative.test.ts',
      'test/p01-4-config-and-tags.test.ts',
    ]);
  });

  it('真实环境事实采集返回合法版本/摘要/Schema 交叉核对结果', async () => {
    const config = loadP01AcceptanceConfig(REAL_CONFIG_PATH);
    const facts = await collectP01EnvironmentFacts(REPO_ROOT, config);
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
    expect(facts.planDigestSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
