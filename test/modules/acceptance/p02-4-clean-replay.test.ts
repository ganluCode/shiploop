/**
 * F-012 P02-ENG-CLEAN-REPLAY：干净快照连续复跑验收入口（复用
 * `scripts/acceptance/clean-snapshot-replay.ts` 的快照/脱敏/有界子进程积木，
 * P02 语义由 `scripts/acceptance/p02-clean-replay.ts` 承载）。
 *
 * 本入口按三种形态运行，均无 skip、无 mock、fail-closed：
 * 1. **完整复跑形态**（`scripts/run-tests.ts` 显式列出本文件且无复跑深度护栏；
 *    运行预算需按 `SHIPLOOP_TEST_RUN_TIMEOUT_MS` 显式拉长，见 run-tests.ts）：
 *    临时源码副本 `npm ci`/`npm run build` → 正式 CLI/Host 从非源码 cwd 冒烟
 *    （数据根/HOME/TMPDIR/Git 仓库全部隔离）→ 该环境连续两次 `npm run accept:p02`
 *    真实执行并各自退出 0 → 逐项报告/证据 hash/size 重验、运行独立性、进程/锁/
 *    哨兵清理与构建路径/依赖扫描断言。耗时数分钟。
 * 2. **深度护栏形态**（`SHIPLOOP_CLEAN_REPLAY_DEPTH` ≥ 1 且被显式列出本文件，即
 *    嵌套 accept:p02 内的同名场景步骤）：只做护栏环境与快照产物核验并明确记录「完整复跑由 depth=0
 *    外层执行」，绝不递归再跑两次 accept:p02（否则无穷递归）。
 * 3. **默认收集形态**（`npm test` 全量收集）：复跑工具冻结步骤、深度护栏、报告
 *    解析与真实接线（配置/检查清单/入口/发射器）断言；完整复跑属显式验收动作，
 *    与 P01 先例（`test/modules/acceptance/p01-4-delivery.test.ts` 不在 npm test 内递归复跑）一致。
 *
 * 判定只依据真实退出码、报告逐项状态、证据 sha256/size 重验与进程/文件核验，
 * 不以「命令已运行」或日志文本代替结果。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  P02_CLEAN_REPLAY_ENTRY,
  P02_CLEAN_REPLAY_OUT_DIR,
  P02_REPLAY_DEPTH_ENV,
  P02_REPLAY_STEPS,
  parseP02AcceptReportSummary,
  parseReplayDepth,
  replayChildEnv,
  runP02CleanReplay,
} from '../../../scripts/acceptance/p02-clean-replay.ts';
import { P02_REQUIRED_CHECKS } from '../../../scripts/acceptance/p02-report.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DRIVER_PATH = 'scripts/acceptance/p02-clean-replay.ts';
const REPLAY_TOOL_PATH = 'scripts/acceptance/clean-snapshot-replay.ts';
const RUN_TESTS_PATH = 'scripts/run-tests.ts';
const CONFIG_PATH = 'acceptance/p02.config.json';

const driverSource = readFileSync(resolve(REPO_ROOT, DRIVER_PATH), 'utf-8');
const runTestsSource = readFileSync(resolve(REPO_ROOT, RUN_TESTS_PATH), 'utf-8');
const config = JSON.parse(readFileSync(resolve(REPO_ROOT, CONFIG_PATH), 'utf-8')) as {
  scenarios: readonly { id: string; kind: string; entry: string; checkIds: readonly string[] }[];
};

/** 完整复跑形态由显式入口启动（run-tests 发射器导出显式过滤器清单）。 */
function explicitFilters(): readonly string[] {
  const raw = process.env.SHIPLOOP_TEST_EXPLICIT_FILTERS;
  if (raw === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

const replayDepth = parseReplayDepth(process.env[P02_REPLAY_DEPTH_ENV]);
const explicitEntryRun = explicitFilters().some(
  (filter) => P02_CLEAN_REPLAY_ENTRY.includes(filter) || filter.includes('p02-4-clean-replay'),
);
const fullReplayMode = replayDepth === 0 && explicitEntryRun;

/* ------------------------------------------------------------------ *
 * 契约与接线（所有形态共用；快速、确定）
 * ------------------------------------------------------------------ */

describe('F-012 干净快照复跑工具契约与接线', () => {
  it('P02 复跑步骤冻结：npm ci/build → public import 冒烟 → 非源码 cwd dist 冒烟 → 连续两次 accept:p02', () => {
    expect(P02_REPLAY_STEPS.map((step) => step.id)).toEqual([
      'npm-ci',
      'build',
      'public-import-smoke',
      'dist-smoke',
      'accept-p02-1',
      'accept-p02-2',
    ]);
    for (const step of P02_REPLAY_STEPS) {
      expect(step.timeoutMs).toBeGreaterThan(0);
      expect(Number.isFinite(step.timeoutMs)).toBe(true);
      expect(step.label.length).toBeGreaterThan(0);
    }
    const acceptSteps = P02_REPLAY_STEPS.filter((step) => step.isAcceptRun === true);
    expect(acceptSteps.map((step) => step.id)).toEqual(['accept-p02-1', 'accept-p02-2']);
    for (const step of acceptSteps) {
      expect(step.npmArgs).toEqual(['run', 'accept:p02']);
    }
    // npm ci 必须先于构建，且两次 accept:p02 位于所有准备步骤之后（串行、不并发复用）。
    const order = P02_REPLAY_STEPS.map((step) => step.id);
    expect(order.indexOf('npm-ci')).toBeLessThan(order.indexOf('build'));
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('dist-smoke'));
    expect(order.indexOf('dist-smoke')).toBeLessThan(order.indexOf('accept-p02-1'));
    expect(order.indexOf('accept-p02-1')).toBeLessThan(order.indexOf('accept-p02-2'));
  });

  it('复跑深度护栏环境变量冻结且解析 fail-closed', () => {
    expect(P02_REPLAY_DEPTH_ENV).toBe('SHIPLOOP_CLEAN_REPLAY_DEPTH');
    expect(parseReplayDepth(undefined)).toBe(0);
    expect(parseReplayDepth('0')).toBe(0);
    expect(parseReplayDepth('2')).toBe(2);
    for (const bad of ['', 'x', '-1', '1.5', ' 1', '01', '999999999999999999']) {
      expect(() => parseReplayDepth(bad), `应拒绝深度值：${bad}`).toThrow();
    }
    const childEnv = replayChildEnv({ PATH: '/usr/bin' }, 1);
    expect(childEnv[P02_REPLAY_DEPTH_ENV]).toBe('1');
    expect(childEnv.PATH).toBe('/usr/bin');
  });

  it('accept:p02 REPORT 行解析严格按前缀；非报告输出返回 null', () => {
    const stdout =
      'accept:p02: STEP [1/11] RUN npm run verify\n' +
      'accept:p02: REPORT <SNAPSHOT-ROOT>/artifacts/acceptance/p02/20261011T012342Z-e5e85c2b' +
      '（conclusion=pass，pass=15 fail=0 not_run=0）\n' +
      'accept:p02: PASS exit 0\n';
    expect(parseP02AcceptReportSummary(stdout)).toEqual({
      runDir: '<SNAPSHOT-ROOT>/artifacts/acceptance/p02/20261011T012342Z-e5e85c2b',
      conclusion: 'pass',
      pass: 15,
      fail: 0,
      notRun: 0,
    });
    expect(parseP02AcceptReportSummary('accept:p02: FAIL exit 1\n')).toBeNull();
    expect(parseP02AcceptReportSummary('accept:p01: REPORT /x（conclusion=pass，pass=1 fail=0 not_run=0）')).toBeNull();
  });

  it('复跑工具真实复用干净快照积木，且不拼接 Shell 字符串', () => {
    expect(existsSync(resolve(REPO_ROOT, REPLAY_TOOL_PATH))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, DRIVER_PATH))).toBe(true);
    expect(driverSource).toContain(`from './${REPLAY_TOOL_PATH.split('/').at(-1)}'`);
    for (const token of ['createCleanSnapshot', 'sanitizeEvidenceText', 'verifyP02ReportDirectory', 'scanBuildArtifacts']) {
      expect(driverSource, `复跑工具应复用积木：${token}`).toContain(token);
    }
    expect(driverSource).not.toContain('shell: true');
    expect(driverSource).not.toContain('execSync');
  });

  it('入口/配置/检查清单/发射器接线一致（P02-ENG-CLEAN-REPLAY ↔ 本文件）', () => {
    expect(P02_CLEAN_REPLAY_ENTRY).toBe('test/modules/acceptance/p02-4-clean-replay.test.ts');
    expect(existsSync(resolve(REPO_ROOT, P02_CLEAN_REPLAY_ENTRY))).toBe(true);
    const definition = P02_REQUIRED_CHECKS.find((entry) => entry.id === 'P02-ENG-CLEAN-REPLAY');
    expect(definition?.testEntry).toBe(P02_CLEAN_REPLAY_ENTRY);
    expect(definition?.expectedNegative).toBe(false);
    const scenario = config.scenarios.find((entry) => entry.id === 'clean-replay');
    expect(scenario).toEqual({
      id: 'clean-replay',
      kind: 'test',
      entry: P02_CLEAN_REPLAY_ENTRY,
      checkIds: ['P02-ENG-CLEAN-REPLAY'],
    });
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.['accept:p02']).toBe('node scripts/acceptance/p02-accept.ts');
    // run-tests 发射器必须把显式测试过滤器导出给子进程，本入口据此区分
    // 「显式验收运行」与「npm test 默认收集」（缺一即完整复跑永不触发）。
    expect(runTestsSource).toContain('SHIPLOOP_TEST_EXPLICIT_FILTERS');
    // 证据输出目录冻结在 docs/acceptance 下（P01 evidence-p01-4 同约定）。
    expect(P02_CLEAN_REPLAY_OUT_DIR).toBe('docs/acceptance/evidence-p02-4-clean-replay');
    expect(P02_CLEAN_REPLAY_OUT_DIR.startsWith('docs/acceptance/')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 深度护栏形态（嵌套 accept:p02 内的同名场景步骤）
 * ------------------------------------------------------------------ */

if (replayDepth > 0 && explicitEntryRun) {
  describe('F-012 复跑深度护栏（嵌套 accept:p02 内不递归）', () => {
    it('记录深度护栏并核验快照构建产物在位；完整复跑由 depth=0 外层执行', () => {
      const recorded = parseReplayDepth(process.env[P02_REPLAY_DEPTH_ENV]);
      expect(recorded).toBeGreaterThanOrEqual(1);
      // 嵌套运行发生在已 npm ci/build 的干净快照内：正式入口产物必须在位。
      expect(existsSync(join(REPO_ROOT, 'packages/cli/dist/bin.js'))).toBe(true);
      expect(existsSync(join(REPO_ROOT, 'packages/host/dist/start.js'))).toBe(true);
      process.stdout.write(
        `P02-ENG-CLEAN-REPLAY inner: depth=${recorded} 防递归护栏生效；` +
          '完整干净快照复跑（连续两次 accept:p02）由 depth=0 的外层验收执行并断言。\n',
      );
    });
  });
}

/* ------------------------------------------------------------------ *
 * 完整复跑形态（显式入口运行；真实临时源码快照 + 连续两次 accept:p02）
 * ------------------------------------------------------------------ */

if (fullReplayMode) {
  describe('F-012 干净快照连续复跑（P02-ENG-CLEAN-REPLAY）', () => {
    const cleanups: Array<() => void> = [];
    afterAll(() => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    });

    it(
      '临时源码副本 npm ci/build 后连续两次 accept:p02 均退出 0，运行独立、证据可重验、无残留',
      // vitest 兜底预算 = 冻结步骤预算之和（P02_REPLAY_STEPS 合计 4 440s）+收尾余量；
      // 每一步另有 runBounded 有界超时，超预算即失败而非无限等待。
      { timeout: 4_800_000 },
      async () => {
        // 形态自检：显式过滤器必须点名本入口（否则验收动作被静默降级）。
        expect(
          explicitFilters().some((filter) => filter.includes('p02-4-clean-replay')),
          `显式过滤器应包含本入口：${JSON.stringify(explicitFilters())}`,
        ).toBe(true);

        const logLines: string[] = [];
        const outcome = await runP02CleanReplay({
          root: REPO_ROOT,
          log: (message) => {
            logLines.push(message);
            process.stdout.write(`${message}\n`);
          },
        });
        cleanups.push(() => {
          // 诊断摘要保留在测试输出（控制器步骤日志会作为阶段证据收集）。
          process.stdout.write(`clean-replay 诊断：${JSON.stringify({ problems: outcome.problems })}\n`);
        });

        // 总判定（fail-closed：任一子项不成立即非零）。
        expect(outcome.problems, `复跑问题清单应为空：${JSON.stringify(outcome.problems)}`).toEqual([]);
        expect(outcome.ok).toBe(true);

        /* ---- 验收 1：干净快照 npm ci/build + 正式 CLI/Host 非源码 cwd + 隔离 ---- */
        const byId = new Map(outcome.steps.map((step) => [step.id, step]));
        expect(byId.get('npm-ci')?.exitCode).toBe(0);
        expect(byId.get('build')?.exitCode).toBe(0);
        expect(byId.get('public-import-smoke')?.exitCode).toBe(0);
        expect(byId.get('dist-smoke')?.exitCode).toBe(0);
        for (const step of outcome.steps) {
          expect(step.timedOut, `步骤 ${step.id} 不应超时`).toBe(false);
        }
        const smoke = outcome.smoke;
        // cwd 非源码（不在快照/受测仓库内），数据根/HOME/临时目录/Git 仓库全部隔离在临时根下。
        expect(smoke.cwdLogical.startsWith('<TMPDIR>')).toBe(true);
        expect(smoke.cwdLogical.startsWith('<SNAPSHOT-ROOT>')).toBe(false);
        expect(smoke.cwdLogical.startsWith('<REPO-ROOT>')).toBe(false);
        expect(smoke.homeLogical.startsWith('<TMPDIR>')).toBe(true);
        expect(smoke.dataRootLogical.startsWith('<TMPDIR>')).toBe(true);
        expect(smoke.repoLogical.startsWith('<TMPDIR>')).toBe(true);
        // 确实运行的是快照内构建出的正式 dist 入口。
        expect(smoke.commands.every((command) => command.exitCode === 0)).toBe(true);
        expect(smoke.cliEntryLogical).toBe('<SNAPSHOT-ROOT>/packages/cli/dist/bin.js');
        // 唯一 Host、注册与停止三证据（进程退出/释锁/发现移除）。
        expect(smoke.listenAddress).toBe('127.0.0.1');
        expect(smoke.port).toBeGreaterThan(0);
        expect(smoke.startedOutcome).toBe('started');
        expect(smoke.hostInstanceId).toBeTruthy();
        expect(smoke.statusInstanceId).toBe(smoke.hostInstanceId);
        expect(smoke.registrationStatus).toBe('registered');
        expect(smoke.projectId).toBeTruthy();
        expect(smoke.stopEvidence).toEqual({
          processExit: 'confirmed',
          lock: 'acquirable',
          discovery: 'removed',
        });

        /* ---- 验收 2：该环境连续两次 accept:p02 均退出 0 且运行独立 ---- */
        expect(outcome.acceptRuns).toHaveLength(2);
        for (const [index, run] of outcome.acceptRuns.entries()) {
          const label = `accept:p02 第 ${index + 1} 次`;
          expect(run.exitCode, `${label} 退出码`).toBe(0);
          expect(run.timedOut, `${label} 不应超时`).toBe(false);
          expect(run.runId, `${label} run-id`).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
          expect(run.conclusion, `${label} 结论`).toBe('pass');
          expect(run.counts, `${label} 计数`).toEqual({ pass: 15, fail: 0, notRun: 0 });
          const statusById = new Map(run.checkStatuses.map((check) => [check.id, check.status]));
          // 每次运行都独立完成唯一 Host、注册、授权基线与重启查询。
          for (const checkId of [
            'P02-FR1-UNIQUE-HOST',
            'P02-FR1-SHARED-STATE',
            'P02-FR1-BASELINE-OK',
            'P02-FR1-RESTART-QUERY',
          ]) {
            expect(statusById.get(checkId), `${label} ${checkId}`).toBe('pass');
          }
          expect(statusById.get('P02-ENG-CLEAN-REPLAY')).toBe('pass');
          expect(run.runDirLogical.startsWith('<SNAPSHOT-ROOT>/artifacts/acceptance/p02/')).toBe(true);
          expect(run.reportVerified, `${label} 报告重验：${JSON.stringify(run.reportProblems)}`).toBe(true);
          expect(run.reportProblems).toEqual([]);
          expect(run.evidenceDigests.length).toBeGreaterThan(0);
          for (const digest of run.evidenceDigests) {
            expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(digest.sizeBytes).toBeGreaterThanOrEqual(0);
          }
          // 每次运行的临时资源独立（TMPDIR 隔离，第二次不可能复用上次项目/数据库/发现文件）。
          expect(run.tempRootLogical.startsWith('<TMPDIR>')).toBe(true);
        }
        const [run1, run2] = outcome.acceptRuns;
        expect(outcome.independence.distinctRunIds).toBe(true);
        expect(run1!.runId).not.toBe(run2!.runId);
        expect(outcome.independence.distinctRunDirs).toBe(true);
        expect(run1!.runDirLogical).not.toBe(run2!.runDirLogical);
        expect(outcome.independence.distinctTempRoots).toBe(true);
        expect(run1!.tempRootLogical).not.toBe(run2!.tempRootLogical);
        expect(outcome.independence.noCrossRunIdReference).toBe(true);

        /* ---- 验收 3：证据 hash/size 可重验、第一份证据未被覆盖、清理干净 ---- */
        expect(outcome.independence.firstEvidenceUnchanged).toBe(true);
        expect(outcome.cleanup.processesRemaining).toEqual([]);
        expect(outcome.cleanup.discoveryFilesRemaining).toEqual([]);
        expect(outcome.cleanup.sentinelsRemaining).toEqual([]);
        expect(outcome.cleanup.continuedWrites).toEqual([]);
        expect(outcome.cleanup.observationWindowMs).toBeGreaterThan(0);
        // 证据导出先于临时资源清理，且不含个人/Harness/Nezha 绝对路径。
        expect(outcome.evidencePaths.length).toBeGreaterThan(0);
        expect(outcome.evidenceLeakHits).toEqual([]);

        /* ---- 验收 4：构建路径/依赖扫描 + public import 无进程/网络副作用 ---- */
        expect(outcome.buildScan.ok).toBe(true);
        expect(outcome.buildScan.findings).toEqual([]);
        expect(outcome.buildScan.fileCount).toBeGreaterThan(0);

        // 收尾：临时快照根必须已删除（不依赖、不遗留本机残留状态）。
        expect(outcome.cleanup.tempRootRemoved).toBe(true);
      },
    );
  });
}
