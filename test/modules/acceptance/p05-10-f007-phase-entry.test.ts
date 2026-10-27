import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { resolveP05Args, collectP05TrustedTests, runP05Acceptance } from '../../../scripts/acceptance/p05-accept.ts';
import { aggregateP05CheckResults, loadP05Checklist } from '../../../scripts/acceptance/p05-config.ts';
import { runP05StepSequence, type P05StepSpec } from '../../../scripts/acceptance/p05-steps.ts';
import type { P02BoundedRunOutcome } from '../../../scripts/acceptance/p02-accept.ts';
import { BUDGET, openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { writeP05ProductCapture } from '../../../scripts/acceptance/p05-product-evidence.ts';
import { selectP05TestScope, P05_REQUIRED_REGRESSIONS } from '../../../scripts/acceptance/p05-test-scope.ts';
import { verifyP05ReportDirectory } from '../../../scripts/acceptance/p05-report.ts';

const ROOT = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const pass: P02BoundedRunOutcome = {
  kind: 'exit', exitCode: 0, signal: null, durationMs: 2, timedOut: false,
  stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
  stdoutTruncated: false, stderrTruncated: false, spawnError: null, stoppedVerified: true,
};

it('writes an offline report with manual/live pending instead of binding manual checks to mock steps', async () => {
  const reportRoot = mkdtempSync(join(tmpdir(), 'shiploop-p05-offline-report-'));
  tempDirs.push(reportRoot);
  const commands: string[][] = [];
  const result = await runP05Acceptance({
    repoRoot: ROOT, reportRoot, runId: 'offline-report-regression',
    runProcess: async (command, args) => {
      commands.push([command, ...args]);
      return { ...pass };
    },
    exec: (command, args) => command === 'git' && args[0] === 'status' ? '' :
      execFileSync(command === 'node' ? process.execPath : command, [...args], { cwd: ROOT, encoding: 'utf8' }).trim(),
  });
  expect(result.reportWritten).toBe(true);
  expect(result.phaseAccepted).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(commands[0]).toContain('scripts/run-tests.ts');
  expect(commands[1]).toContain('test/modules/acceptance/p05-10-f002-fixture.test.ts');
  expect(commands[1]).not.toContain('test/modules/planning/p05-1-f011-planning-query.test.ts');
  expect(commands[0]).not.toContain('test/modules/workspace/p03-5-workspace-discard.test.ts');
  expect(commands[0]).toContain('test/modules/delivery/p03-8-f004-git-commit-reconciliation.test.ts');
  expect(commands[2]).toContain('test/modules/acceptance/p05-product-report.test.ts');
  // A green child exit cannot invent a product report it never exported.
  expect(result.problems.some(problem => problem.includes('产品报告证据缺失'))).toBe(true);
  const scope = JSON.parse(readFileSync(join(reportRoot, 'runs/offline-report-regression/test-scope.json'), 'utf8'));
  expect(scope.deferred.map((row: { file: string }) => row.file)).toContain('test/modules/workspace/p03-5-workspace-discard.test.ts');
  const all = collectP05TrustedTests(ROOT).files;
  expect([...scope.selected, ...scope.deferred.map((row: { file: string }) => row.file)].sort()).toEqual(all);
  expect(all.filter(file => file.includes('p05-')).every(file => scope.selected.includes(file))).toBe(true);
});

it('[case:p05-entry-options-and-bounded-steps] parses explicit full regression and preserves a failed prefix', async () => {
  expect(resolveP05Args(['--full-regression']).fullRegression).toBe(true);
  expect(resolveP05Args([]).fullRegression).toBeUndefined();

  const root = mkdtempSync(join(tmpdir(), 'shiploop-p05-f007-'));
  tempDirs.push(root);
  const steps: P05StepSpec[] = [
    { id: 'trusted', command: process.execPath, args: ['-e', ''], cwd: root },
    { id: 'affected', command: process.execPath, args: ['-e', ''], cwd: root },
    { id: 'smoke', command: process.execPath, args: ['-e', ''], cwd: root },
  ];
  let calls = 0;
  const result = await runP05StepSequence(steps, {
    evidenceDir: join(root, 'run'),
    identity: { runId: 'p05-f007-test', commit: 'a'.repeat(40), inputsDigest: 'b'.repeat(64) },
    stepTimeoutMs: 1_000,
    overallTimeoutMs: 5_000,
    maxOutputBytes: 4_096,
    runProcess: async () => ({ ...pass, exitCode: ++calls === 2 ? 23 : 0 }),
  });
  expect(result.exitCode).toBe(1);
  expect(result.steps.map(step => [step.stepId, step.status, step.exitCode])).toEqual([
    ['trusted', 'pass', 0],
    ['affected', 'fail', 23],
    ['smoke', 'not_run', null],
  ]);
});

it('preserves the actual run-bound product capture through cleanup and report hashing', async () => {
  const reportRoot = mkdtempSync(join(tmpdir(), 'shiploop-p05-product-entry-'));
  tempDirs.push(reportRoot);
  const result = await runP05Acceptance({
    repoRoot: ROOT, reportRoot, runId: 'actual-product-export',
    exec: (command, args) => command === 'git' && args[0] === 'status' ? '' :
      execFileSync(command === 'node' ? process.execPath : command, [...args], { cwd: ROOT, encoding: 'utf8' }).trim(),
    runProcess: async (_command, args, options) => {
      if (args.includes('test/modules/acceptance/p05-product-report.test.ts')) {
        const f = await openBudgetFixture(BUDGET);
        let host: Awaited<ReturnType<typeof openReportHost>> | undefined;
        try {
          await f.start();
          host = await openReportHost(f);
          const report = await host.client.getFeatureReport(f.projectId, f.featureId);
          const identity = JSON.parse(options.env!.SHIPLOOP_P05_REPORT_IDENTITY!);
          writeP05ProductCapture(join(options.env!.SHIPLOOP_P05_PRODUCT_REPORT_DIR!, 'feature-report.json'), {
            schemaVersion: 1, source: 'features.report.get', mode: 'offline-fixture', identity,
            projectId: f.projectId, featureId: f.featureId, report,
          }, identity);
        } finally { await host?.close(); await f.close(); }
      }
      return { ...pass };
    },
  });
  // Mocked test exits do not supply the other SQLite/Git scenario evidence.
  expect(result.problems.some(problem => /产品报告|产品 Feature 执行报告/.test(problem))).toBe(false);
  expect(result.phaseAccepted).toBe(false);
  const report = JSON.parse(readFileSync(join(result.runDir!, 'report.json'), 'utf8'));
  expect(report.productReports).toHaveLength(1);
  expect(report.cleanup.confirmed).toBe(true);
  const product = JSON.parse(readFileSync(join(result.runDir!, report.productReports[0].evidenceRef), 'utf8'));
  expect(product.identity.runId).toBe('actual-product-export');
  expect(product.report.runs.length).toBeGreaterThan(0);
  expect(verifyP05ReportDirectory(result.runDir!).ok).toBe(true);
});

it('fails closed when required history disappears and keeps the full union opt-in', () => {
  const all = collectP05TrustedTests(ROOT).files;
  expect(() => selectP05TestScope(all.filter(file => file !== P05_REQUIRED_REGRESSIONS[0]))).toThrow('missing');
  expect(selectP05TestScope(all, true)).toMatchObject({ selected: all, deferred: [] });
});

it('[case:p05-status-preserves-live-and-manual-gates] keeps missing live and manual evidence from becoming pass', () => {
  const checklist = loadP05Checklist(join(ROOT, 'acceptance/p05.checklist.json'));
  const offline = checklist.items.find(item => item.execution === 'offline')!;
  const live = checklist.items.find(item => item.execution === 'live')!;
  const manual = checklist.items.find(item => item.execution === 'manual')!;
  const result = aggregateP05CheckResults(checklist, [
    { checkId: offline.id, status: 'pass', executionMode: 'fake', evidence: [...offline.evidence] },
    { checkId: live.id, status: 'pass', executionMode: 'fake', evidence: [...live.evidence] },
    { checkId: manual.id, status: 'pass', executionMode: 'manual', manualStatus: 'pending', evidence: [...manual.evidence] },
  ]);
  expect(result.checks.find(check => check.id === offline.id)?.status).toBe('pass');
  expect(result.checks.find(check => check.id === live.id)?.status).toBe('fail');
  expect(result.checks.find(check => check.id === manual.id)?.status).toBe('fail');
  expect(result.conclusion).toBe('fail');
});

it('[case:p05-trusted-index-is-complete] discovers every required Feature and deduplicates its existing test files', () => {
  const selection = collectP05TrustedTests(ROOT);
  expect(selection.features.map(feature => feature.feature)).toEqual([
    'P05-1', 'P05-2', 'P05-3', 'P05-4', 'P05-5', 'P05-6', 'P05-7', 'P05-8', 'P05-9',
  ]);
  expect(selection.files.length).toBe(new Set(selection.files).size);
  expect(selection.features.find(feature => feature.feature === 'P05-5')?.files).toContain(
    'test/modules/scheduling/p05-5-f008-cross-layer.test.ts',
  );
});
