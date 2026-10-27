import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const REPORT = join(ROOT, 'docs/p05-9-f008-delivery-report.md');
const FEATURE = join(ROOT, 'test/index/phases/P05/features/P05-9/feature.json');
const F008 = join(ROOT, 'test/index/phases/P05/features/P05-9/tasks/F-008.json');

function json(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('P05-9 F-008 delivery records', () => {
  it('[case:delivery-record-binds-commit-inputs-exit-and-not-run] keeps the report and trusted indexes tied to real evidence without auto-signing Phase delivery', () => {
    const report = readFileSync(REPORT, 'utf8');
    const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    expect(report).toMatch(/受测实现提交：`[0-9a-f]{40}`/);
    expect(report).not.toContain('__FINAL_COMMIT__');
    expect(report).toContain('leaf SHA');
    expect(report).toContain('退出码');
    expect(report).toContain('not_run');
    expect(report).toContain('main merge');
    expect(report).toContain('remote push');
    expect(report).toContain('人工批准');
    expect(currentCommit).toMatch(/^[0-9a-f]{40}$/);

    const feature = json(FEATURE);
    expect(feature.phase).toBe('P05');
    expect(feature.feature).toBe('P05-9');
    expect(feature.tasks.map((task: { task_id: string }) => task.task_id)).toEqual(
      ['F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006', 'F-007', 'F-008'],
    );
    const f008 = json(F008);
    expect(f008.task_id).toBe('F-008');
    expect(f008.projects[0].tests.some((test: { file: string }) => test.file.endsWith('p05-9-f008-batch-delivery-vertical.test.ts'))).toBe(true);
    for (const task of feature.tasks) expect(existsSync(join(ROOT, task.index)), task.index).toBe(true);
  });
});
