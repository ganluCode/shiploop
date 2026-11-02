import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  P08_ACCEPT_USAGE,
  resolveP08Args,
  runP08Acceptance,
  validateP08TestReceipt,
} from '../../../scripts/acceptance/p08-accept.ts';

it('[case:p08-f007-args] 入口参数显式区分默认范围与 full regression，并拒绝重复或越界预算', () => {
  expect(resolveP08Args(['--full-regression', '--run-id', 'p08-test-1', '--step-timeout-ms', '1000'])).toMatchObject({
    fullRegression: true,
    runId: 'p08-test-1',
    stepTimeoutMs: 1000,
  });
  expect(P08_ACCEPT_USAGE).toContain('--full-regression');
  expect(() => resolveP08Args(['--full-regression', '--full-regression'])).toThrow('accept:p08:duplicate_argument');
  expect(() => resolveP08Args(['--step-timeout-ms', '0'])).toThrow('accept:p08:invalid_budget');
});

it('[case:p08-f007-receipt] receipt 必须覆盖选中文件且不存在失败断言', () => {
  const receipt = {
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    testResults: [
      { name: '/repo/test/modules/acceptance/one.test.ts', status: 'passed', assertionResults: [{ status: 'passed', title: 'one' }] },
      { name: '/repo/test/modules/acceptance/two.test.ts', status: 'passed', assertionResults: [{ status: 'passed', title: 'two' }] },
    ],
  };
  expect(() => validateP08TestReceipt(receipt, [
    'test/modules/acceptance/one.test.ts',
    'test/modules/acceptance/two.test.ts',
  ], '/repo')).not.toThrow();
  expect(() => validateP08TestReceipt({ ...receipt, success: false }, ['test/modules/acceptance/one.test.ts'], '/repo'))
    .toThrow('accept:p08:test_receipt_failed');
  expect(() => validateP08TestReceipt(receipt, ['test/modules/acceptance/three.test.ts'], '/repo'))
    .toThrow('accept:p08:missing_test_receipt');
});
it('[case:p08-f007-success-run] 成功执行确定性步骤后仍将 live 与人工缺口保留为 not_run，报告验证结果可读', async () => {
  const root = resolve(import.meta.dirname, '../../..');
  const reportRoot = mkdtempSync(join(tmpdir(), 'p08-f007-success-'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const probe = (command: string, args: readonly string[]): string => {
    if (command === 'git' && args[0] === 'rev-parse') return head;
    if (command === 'git' && args[0] === 'status') return '';
    if (command === 'git' && args[0] === 'merge-base') return '';
    if (command === 'node') return 'v22.19.0';
    if (command === 'npm') return '10.9.3';
    throw new Error(`unexpected probe ${command} ${args.join(' ')}`);
  };
  const prerequisites = {
    schemaVersion: 1,
    kind: 'shiploop.p08.prerequisite-baselines',
    approvedBy: 'owner-1',
    features: ['P08-1', 'P08-2', 'P08-3'].map(feature => ({
      feature, commit: head, delivered: true, interfacesSatisfied: true,
      deliveryEvidence: ['docs/p08-acceptance.md'], publicInterfaces: ['Core/Host/CLI'],
    })),
  } as const;
  const result = await runP08Acceptance({
    repoRoot: root,
    runId: 'p08-f007-success-run',
    reportRoot,
    stepTimeoutMs: 1_000,
    overallTimeoutMs: 10_000,
    testing: {
      probe,
      prerequisites,
      runProcess: async (_command, args) => {
        const receiptPath = args.find(arg => arg.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);
        const files = args.filter(arg => /^test\/modules\/.+\.test\.ts$/.test(arg));
        if (!receiptPath) throw new Error('missing receipt path');
        writeFileSync(receiptPath, JSON.stringify({
          success: true,
          numTotalTests: files.length,
          numPassedTests: files.length,
          testResults: files.map(file => ({ name: join(root, file), status: 'passed', assertionResults: [{ status: 'passed', title: file }] })),
        }));
        return {
          kind: 'exit' as const, exitCode: 0, signal: null, durationMs: 2, timedOut: false,
          stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
          stdoutBytes: 0, stderrBytes: 0, spawnError: null, stoppedVerified: true,
        };
      },
      install: () => ({
        report: { status: 'passed', cleanup: { status: 'completed' } },
        diagnosticsFile: null,
      } as any),
    },
  });
  expect(result.reportVerified).toBe(true);
  expect(result.report.conclusion).toBe('fail');
  expect(result.report.checks.find(check => check.id === 'P08-DETERMINISTIC-PHASE-REGRESSION')?.status).toBe('pass');
  expect(result.report.checks.find(check => check.id === 'P08-LIVE-TODO-EVIDENCE')?.status).toBe('not_run');
  expect(result.steps.map(step => step.id).slice(-1)).toEqual(['p08-manual-gate']);
});it('[case:p08-f007-failure-report] 测试失败停止后续步骤，仍发布结构化失败报告并保留 not_run 传播', async () => {
  const root = resolve(import.meta.dirname, '../../..');
  const reportRoot = mkdtempSync(join(tmpdir(), 'p08-f007-entry-'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const probe = (command: string, args: readonly string[]): string => {
    if (command === 'git' && args[0] === 'rev-parse') return head;
    if (command === 'git' && args[0] === 'status') return '';
    if (command === 'git' && args[0] === 'merge-base') return '';
    if (command === 'node') return 'v22.19.0';
    if (command === 'npm') return '10.9.3';
    throw new Error(`unexpected probe ${command} ${args.join(' ')}`);
  };
  const prerequisites = {
    schemaVersion: 1,
    kind: 'shiploop.p08.prerequisite-baselines',
    approvedBy: 'owner-1',
    features: ['P08-1', 'P08-2', 'P08-3'].map(feature => ({
      feature,
      commit: head,
      delivered: true,
      interfacesSatisfied: true,
      deliveryEvidence: ['docs/p08-acceptance.md'],
      publicInterfaces: ['Core/Host/CLI'],
    })),
  } as const;
  const result = await runP08Acceptance({
    repoRoot: root,
    runId: 'p08-f007-failure-report',
    reportRoot,
    stepTimeoutMs: 1_000,
    overallTimeoutMs: 10_000,
    testing: {
      probe,
      prerequisites,
      runProcess: async () => ({
        kind: 'exit' as const,
        exitCode: 9,
        signal: null,
        durationMs: 2,
        timedOut: false,
        stdout: '',
        stderr: 'fixture failure',
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        spawnError: null,
        stoppedVerified: true,
      }),
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.reportVerified).toBe(true);
  expect(result.steps.find(step => step.id === 'p08-deterministic-scope')?.status).toBe('fail');
  expect(result.steps.find(step => step.id === 'p08-installation')?.status).toBe('not_run');
  expect(result.steps.find(step => step.id === 'p08-live-import')?.status).toBe('not_run');
  expect(result.report.conclusion).toBe('fail');
});
