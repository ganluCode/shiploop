import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  P08_REQUIRED_REGRESSIONS,
  collectP08TrustedTests,
  digestP08TestScope,
  selectP08TestScope,
} from '../../../scripts/acceptance/p08-test-scope.ts';
import {
  P08_ENTRY_STEP_ORDER,
  buildP08ExecutionPlan,
  propagateP08StepStatuses,
} from '../../../scripts/acceptance/p08-plan.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

it('[case:p08-f003-index-complete-and-deduplicated] 校验 P08 可信索引并去重 P08 与 P07 候选文件', () => {
  const trusted = collectP08TrustedTests(ROOT);
  expect(trusted.files.length).toBeGreaterThan(20);
  expect(new Set(trusted.files).size).toBe(trusted.files.length);
  expect(trusted.files).toEqual([...trusted.files].sort());
  expect(trusted.files).toContain('test/modules/acceptance/p08-4-f001-acceptance-contract.test.ts');
  expect(trusted.files).toContain('test/modules/acceptance/p08-3-f004-existing-demo-lifecycle.test.ts');
  expect(trusted.inputs.some(file => file.endsWith('/P08-1/feature.json'))).toBe(true);
  expect(trusted.integrationFiles).toContain('test/modules/acceptance/p08-3-f004-existing-demo-lifecycle.test.ts');
  expect(trusted.files.every(file => file.startsWith('test/modules/'))).toBe(true);
});

it('[case:p08-f003-scope-partition] 默认范围选择受影响文件并逐项记录 deferred/not_run，全量模式只显式开启完整并集', () => {
  const required = P08_REQUIRED_REGRESSIONS.map(item => item.file);
  const trusted = [...required, 'test/modules/acceptance/p08-4-f003-scope.test.ts', 'test/modules/legacy/old-regression.test.ts'];
  const phase = selectP08TestScope(trusted);
  expect(phase.policy).toBe('p08-impact-and-required-regressions');
  expect(phase.selected).toEqual([
    'test/modules/acceptance/p08-4-f003-scope.test.ts',
    ...required.sort(),
  ].sort());
  expect(phase.deferred).toEqual([expect.objectContaining({
    file: 'test/modules/legacy/old-regression.test.ts',
    status: 'not_run',
    reason: expect.stringContaining('P08 影响边界'),
  })]);
  expect(phase.fullRegression).toMatchObject({ enabled: false, status: 'not_run', command: ['npm', 'test'] });

  const full = selectP08TestScope(trusted, true);
  expect(full.policy).toBe('full-trusted-union');
  expect(full.selected).toEqual([...new Set(trusted)].sort());
  expect(full.deferred).toEqual([]);
  expect(full.fullRegression).toMatchObject({ enabled: true, status: 'selected', command: ['npm', 'test'] });
  expect(digestP08TestScope(full)).not.toBe(digestP08TestScope(phase));
});

it('[case:p08-f003-plan-order-and-failure-propagation] 文件稳定分批恰好执行一次，前序失败使后续步骤保持 not_run', () => {
  const files = [
    'test/modules/acceptance/p08-4-f003-scope.test.ts',
    ...P08_REQUIRED_REGRESSIONS.map(item => item.file),
  ];
  const plan = buildP08ExecutionPlan(files, false);
  expect(plan.map(step => step.id)).toEqual([
    'p08-prerequisites', 'p08-source-identity', 'p08-deterministic-scope',
    'p08-installation', 'p08-phase-integration', 'p08-live-import', 'p08-report', 'p08-manual-gate',
  ]);
  expect(plan.flatMap(step => step.tests)).toEqual([...files].sort());
  expect(new Set(plan.flatMap(step => step.tests)).size).toBe(files.length);
  expect(plan.every(step => !step.args.includes('scripts/acceptance/p08-accept.ts'))).toBe(true);
  expect(plan.at(-1)?.id).toBe(P08_ENTRY_STEP_ORDER.at(-1));

  const result = propagateP08StepStatuses(plan, {
    'p08-prerequisites': { status: 'pass', exitCode: 0 },
    'p08-source-identity': { status: 'fail', exitCode: 1, reason: 'identity_mismatch' },
  });
  expect(result.map(step => step.status)).toEqual(['pass', 'fail', 'not_run', 'not_run', 'not_run', 'not_run', 'not_run', 'not_run']);
  expect(result.slice(2).every(step => step.reason === 'halted_by_prior_failure')).toBe(true);

  const full = buildP08ExecutionPlan(files, true);
  expect(full.filter(step => step.tests.length)).toHaveLength(1);
  expect(full.find(step => step.tests.length)?.args).toEqual(['test']);
});
