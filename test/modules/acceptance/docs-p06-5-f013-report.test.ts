import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const reportPath = resolve(repoRoot, 'docs/p06-5-f013-brownfield-integration.md');
const featureIndexPath = resolve(repoRoot, 'test/index/phases/P06/features/P06-5/feature.json');
const taskIndexPath = resolve(repoRoot, 'test/index/phases/P06/features/P06-5/tasks/F-013.json');

describe('P06-5 F-013 delivery evidence documents', () => {
  it('[case:report-boundaries] records evidence, commands, explicit confirmation, and unrun gates', () => {
    const report = readFileSync(reportPath, 'utf8');
    for (const token of [
      'FR-1', 'FR-2', 'T15', '受测工具链', '退出码：0', 'not_run', 'npm run verify',
      '显式项目', 'preview_stale', 'incomparable', '原生 Runtime 恢复分离',
    ]) {
      expect(report).toContain(token);
    }
  });

  it('[case:index-references-report] keeps the feature index and report as repository files', () => {
    const featureIndex = readFileSync(featureIndexPath, 'utf8');
    const index = readFileSync(taskIndexPath, 'utf8');
    expect(featureIndex).toContain('P06-5');
    expect(featureIndex).toContain('F-013');
    expect(index).toContain('F-013');
    expect(index).toContain('test/modules/onboarding/p06-5-f013-brownfield-integration.test.ts');
    expect(index).toContain('test/modules/acceptance/docs-p06-5-f013-report.test.ts');
  });
});
