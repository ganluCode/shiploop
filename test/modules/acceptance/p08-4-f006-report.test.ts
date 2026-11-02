import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildP08AcceptanceReport,
  renderP08Summary,
  verifyP08ReportDirectory,
  writeP08AcceptanceReport,
  type P08ReportInput,
} from '../../../scripts/acceptance/p08-report.ts';
import { loadP08Checklist } from '../../../scripts/acceptance/p08-config.ts';

const HEAD = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const identity = { runId: 'p08-f006', testedCommit: HEAD, inputsDigest: DIGEST,
  toolchain: { node: '22.19.0', npm: '10.9.3', platform: 'darwin' } } as const;
const evidence = ['report', 'manifest', 'sha', 'command-exit', 'usage', 'cleanup', 'deterministic-regression', 'harness-boundary'];
const passed = (status: 'pass' | 'fail' | 'not_run' = 'pass') => ({ status, evidence });

function input(): P08ReportInput {
  const section = { status: 'pass' as const, evidence };
  return {
    identity,
    testScope: { schemaVersion: 1, policy: 'p08-impact-and-required-regressions', selected: ['test/modules/acceptance/example.test.ts'], selectedReasons: { 'test/modules/acceptance/example.test.ts': 'focused' },
      requiredRegressions: [], deferred: [], fullRegression: { enabled: false, status: 'not_run', command: ['npm', 'test'], reason: 'default' } },
    prerequisites: { status: 'pass', features: ['P08-1', 'P08-2', 'P08-3'].map(feature => ({ feature, status: 'pass', commit: HEAD, reportRef: `prior/${feature}.json`, evidenceRefs: [`prior/${feature}.json`] })) },
    installation: { status: 'pass', reportRefs: ['install/check.json'], cleanupConfirmed: true, evidence: ['install', 'artifact', 'manifest', 'sha', 'cleanup'] },
    taskLocal: section,
    featureGate: section,
    phaseIntegration: section,
    live: { todo: { status: 'pass', evidence: ['todo-live', 'report', 'manifest', 'sha', 'usage', 'manual'] }, existing: { status: 'pass', evidence: ['existing-live', 'report', 'manifest', 'sha', 'usage', 'manual'] } },
    manual: { status: 'pass', evidence: ['manual', 'command-exit', 'cleanup'] },
    productReports: [{ featureId: 'P08-2', path: 'products/todo.json' }],
    checks: loadP08Checklist().items.map(item => ({ checkId: item.id, status: item.group === 'deferred' ? 'not_run' as const : 'pass' as const, executionMode: item.execution === 'offline' ? 'fake' as const : item.execution === 'live' ? 'live' as const : item.execution === 'manual' ? 'manual' as const : 'postponed' as const, evidence: item.evidence })),
    knownGaps: ['full_history_not_run'],
  };
}

describe('P08-4 F-006 总报告聚合器', () => {
  it('[case:p08-f006-aggregate-counts] 从冻结清单重算状态、计数并保留各层证据', () => {
    const report = buildP08AcceptanceReport(input());
    expect(report).toMatchObject({ identity: { runId: 'p08-f006', testedCommit: HEAD, inputsDigest: DIGEST }, conclusion: 'pass', exitCode: 0 });
    expect(report.counts.pass).toBe(15);
    expect(report.counts.fail).toBe(0);
    expect(report.counts.not_run).toBe(0);
    expect(report.layers.map(layer => layer.id)).toEqual(['code-delivery', 'task-local', 'feature-gate', 'phase-integration', 'live', 'manual']);
    expect(renderP08Summary(report)).toContain('P08 acceptance');
  });

  it('[case:p08-f006-status-propagation] Live 缺失、清理未确认或产品身份漂移会形成 blocking issue', () => {
    const value = input() as any;
    value.live!.existing = { status: 'not_run', evidence: ['existing-live'] };
    value.installation = { ...value.installation, cleanupConfirmed: false };
    value.prerequisites.features[1]!.status = 'not_run';
    const report = buildP08AcceptanceReport(value);
    expect(report.conclusion).toBe('fail');
    expect(report.exitCode).toBe(1);
    expect(report.blockingIssues.some(issue => issue.includes('LIVE-EXISTING'))).toBe(true);
    expect(report.blockingIssues.some(issue => issue.includes('cleanup'))).toBe(true);
    expect(report.checks.find(check => check.id === 'P08-PREREQ-DELIVERY-REPORTS')?.status).toBe('not_run');
  });

  it('[case:p08-f006-directory-integrity] 发布目录可重放、篡改失败且重复 runId 不覆盖旧报告', () => {
    const root = mkdtempSync(join(tmpdir(), 'p08-f006-report-'));
    try {
      for (const file of ['prior/P08-1.json', 'prior/P08-2.json', 'prior/P08-3.json', 'install/check.json', 'products/todo.json']) {
        const target = join(root, file); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, '{}\n');
      }
      const result = writeP08AcceptanceReport({ reportRoot: root, sourceDirectory: root, input: input() });
      expect(result.verification.ok).toBe(true);
      const original = readFileSync(join(result.directory, 'report.json'));
      expect(verifyP08ReportDirectory(result.directory, identity).ok).toBe(true);
      writeFileSync(join(result.directory, 'report.json'), original.toString().replace('"conclusion": "pass"', '"conclusion": "fail"'));
      expect(verifyP08ReportDirectory(result.directory, identity).ok).toBe(false);
      expect(() => writeP08AcceptanceReport({ reportRoot: root, input: input() })).toThrow('run_exists');
      expect(readFileSync(join(result.directory, 'report.json')).toString()).toContain('"conclusion": "fail"');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
