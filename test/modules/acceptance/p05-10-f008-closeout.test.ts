import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { collectP05PhaseScenarioTests, collectP05TrustedTests, resolveP05Args } from '../../../scripts/acceptance/p05-accept.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

function jsonFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...jsonFiles(path));
    else if (entry.name.endsWith('.json')) result.push(path);
  }
  return result;
}

it('[case:p05-f008-entry-wiring] package entry loads the frozen offline contract and keeps full regression explicit', () => {
  const packageJson = json(join(ROOT, 'package.json'));
  const config = json(join(ROOT, 'acceptance/p05.config.json'));
  const entry = json(join(ROOT, 'acceptance/p05.entry.json'));

  expect(packageJson.scripts['accept:p05']).toBe('node scripts/acceptance/p05-accept.ts');
  expect(config.reportRoot).toBe('artifacts/acceptance/p05');
  expect(config.executionPolicy.offline).toEqual({ runtime: 'fake-or-scripted', network: 'denied', llmCalls: false });
  expect(config.fullRegression).toMatchObject({ defaultEnabled: false, optInFlag: '--full-regression', command: ['npm', 'test'] });
  expect(entry.defaultExecution).toEqual({ mode: 'offline', network: 'denied', llmCalls: false, fullRegression: false });
  expect(resolveP05Args([]).fullRegression).toBeUndefined();
  expect(resolveP05Args(['--full-regression']).fullRegression).toBe(true);
});

it('[case:p05-f008-trusted-index-files] indexes every required Feature by complete test files and keeps the union deduplicated', () => {
  const scenarios = collectP05PhaseScenarioTests(ROOT);
  expect(scenarios).toEqual([
    'test/modules/acceptance/p05-10-f002-fixture.test.ts',
    'test/modules/acceptance/p05-10-f003-normal-flow.test.ts',
    'test/modules/acceptance/p05-10-f004-fault-matrix.test.ts',
    'test/modules/acceptance/p05-10-f005-git-integration.test.ts',
    'test/modules/acceptance/p05-10-f006-combined-faults.test.ts',
    'test/modules/acceptance/p05-10-f007-phase-entry.test.ts',
    'test/modules/acceptance/p05-10-f008-closeout.test.ts',
    'test/modules/acceptance/p05-10-f009-closeout.test.ts',
  ]);
  expect(scenarios).toEqual([...new Set(scenarios)]);
  const selection = collectP05TrustedTests(ROOT);
  expect(selection.features).toHaveLength(9);
  expect(selection.files).toEqual([...new Set(selection.files)].sort());
  expect(selection.files.every(file => /^test\/modules\/.*\.test\.(ts|js)$/.test(file))).toBe(true);

  const indexRoot = join(ROOT, 'test/index/phases/P05/features');
  for (const file of jsonFiles(indexRoot)) {
    const parsed = json(file);
    for (const project of parsed.projects ?? []) {
      for (const test of project.tests ?? []) {
        expect(test.all, `${file}: ${test.file}`).toBe(true);
        expect(test.cases, `${file}: ${test.file}`).toBeUndefined();
      }
    }
  }
});

it('[case:p05-f008-manual-live-separation] documents temporary A/B/C resources and preserves offline/live/manual boundaries', () => {
  const entry = json(join(ROOT, 'acceptance/p05.entry.json'));
  const contract = readFileSync(join(ROOT, 'docs/p05-acceptance.md'), 'utf8');
  const walkthrough = readFileSync(join(ROOT, 'docs/acceptance/p05-owner-walkthrough.md'), 'utf8');

  expect(entry.explicitOptions.fullRegression).toBe('--full-regression');
  for (const token of [
    'macOS', '临时项目', 'A/B/C', '资源竞争', 'Git 冲突', '修复失败', '预算耗尽',
    '清理', 'git rev-parse HEAD', 'offline', 'live', 'manual', 'not_run', 'pending',
  ]) expect(`${contract}\n${walkthrough}`).toContain(token);
  expect(walkthrough).not.toMatch(/\/Users\//);
  expect(walkthrough).not.toMatch(/\/home\//);
  expect(walkthrough).not.toMatch(/[A-Za-z]:\\\\/);
});
