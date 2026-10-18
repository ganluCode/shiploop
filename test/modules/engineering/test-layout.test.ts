import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file: string) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));

describe('模块测试目录与执行索引', () => {
  it('[case:no-flat-tests] 新测试不再堆到 test 根目录', () => {
    expect(readdirSync(resolve(root, 'test')).filter(name => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name))).toEqual([]);
  });

  it('[case:old-paths-preserved] 原测试均有模块映射，不删除历史测试入口对应的实现', () => {
    const mapping = read('test/index/path-mapping.json').mapping as Record<string, string>;
    expect(Object.keys(mapping).length).toBeGreaterThan(0);
    for (const [old, current] of Object.entries(mapping)) {
      expect(current.startsWith('test/modules/')).toBe(true);
      expect(existsSync(resolve(root, current)), current).toBe(true);
      expect(existsSync(resolve(root, old)), old).toBe(false);
    }
  });

  it('[case:task-index-integrity] Task 索引唯一且只引用仓库真实模块文件', () => {
    const feature = read('test/index/phases/P03/features/P03-9/feature.json');
    const ids = new Set<string>();
    expect(feature.tasks.length).toBeGreaterThan(0);
    for (const entry of feature.tasks as { task_id: string; index: string }[]) {
      expect(ids.has(entry.task_id)).toBe(false);
      ids.add(entry.task_id);
      const index = read(entry.index);
      expect(index.schema_version).toBe(2);
      expect(index.task_id).toBe(entry.task_id);
      for (const project of index.projects as { id: string; tests: { file: string; all?: boolean; cases?: string[] }[] }[]) {
        expect(project.id).toBe('shiploop');
        expect(project.tests.length).toBeGreaterThan(0);
        for (const selected of project.tests) {
          expect(selected.file.startsWith('test/modules/')).toBe(true);
          expect(realpathSync(resolve(root, selected.file)).startsWith(realpathSync(root) + sep)).toBe(true);
          expect(Boolean(selected.all) !== Boolean(selected.cases?.length)).toBe(true);
        }
      }
    }
  });

  it('[case:phase-is-manual] Phase 全量检查是人工发起，不由局部门禁冒充', () => {
    const phase = read('test/index/phases/P03/phase.json');
    expect(phase.acceptance.trigger).toBe('manual');
    expect(phase.acceptance.command).toEqual(['npm', 'run', 'verify']);
    expect(existsSync(resolve(root, phase.acceptance.known_failure_evidence))).toBe(true);
  });
});
