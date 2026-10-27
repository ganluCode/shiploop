import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseAppCliArgs, getAppCliHelp } from '../../../packages/cli/src/index.ts';

it('[case:phase-lifecycle-args] Phase 生命周期命令携带项目和显式 CAS，拒绝执行权限字段', () => {
  const projectId = randomUUID();
  for (const action of ['close', 'reopen', 'archive']) {
    expect(parseAppCliArgs(['phase', action, 'phase-a', '--project', projectId, '--revision', '2', '--json']))
      .toMatchObject({ commandId: `phase.${action}`, phaseId: 'phase-a', revision: 2, projectId, json: true });
    expect(() => parseAppCliArgs(['phase', action, 'phase-a', '--project', projectId])).toThrow();
    expect(() => parseAppCliArgs(['phase', action, 'phase-a', '--project', projectId, '--revision', '2', '--model', 'x'])).toThrow();
  }
});

it('[case:phase-graph-metadata-args] 更新保留省略字段，清空必须显式指定，查询只接受观察参数', () => {
  const project = ['--project', randomUUID()];
  expect(parseAppCliArgs(['phase', 'update', 'p', ...project, '--revision', '3', '--title', 'new']))
    .toMatchObject({ commandId: 'phase.update', title: 'new' });
  expect(parseAppCliArgs(['phase', 'update', 'p', ...project, '--revision', '3', '--clear-description', '--clear-labels']))
    .toMatchObject({ description: null, labels: [] });
  for (const flags of [[], ['--description', 'x', '--clear-description'], ['--label', 'x', '--clear-labels']]) {
    expect(() => parseAppCliArgs(['phase', 'update', 'p', ...project, '--revision', '3', ...flags])).toThrow();
  }
  expect(parseAppCliArgs(['phase', 'graph', 'p', ...project, '--limit', '2']))
    .toMatchObject({ commandId: 'phase.graph', limit: 2 });
  for (const flags of [['--revision', '3'], ['--approve'], ['--runtime', 'pi'], ['--merge']]) {
    expect(() => parseAppCliArgs(['phase', 'graph', 'p', ...project, ...flags])).toThrow();
  }
});

it('[case:feature-move-dag-args] 归属更新必须具备三方 revision，依赖更新使用显式文件和阶段 CAS', () => {
  const project = ['--project', randomUUID()];
  const args = ['feature', 'move', 'f', ...project, '--revision', '2', '--from-phase', 'p', '--to-phase', 'q', '--source-revision', '3', '--target-revision', '4'];
  expect(parseAppCliArgs(args)).toMatchObject({ commandId: 'feature.move', featureId: 'f', sourcePhaseId: 'p', targetPhaseId: 'q', sourcePhaseRevision: 3, targetPhaseRevision: 4 });
  expect(() => parseAppCliArgs(args.slice(0, -2))).toThrow();
  expect(() => parseAppCliArgs([...args.slice(0, -1), '0'])).toThrow();
  expect(parseAppCliArgs(['feature', 'dependencies', ...project, '--phase', 'p', '--revision', '2', '--input', 'edges.json']))
    .toMatchObject({ commandId: 'feature.dependencies', phaseId: 'p', revision: 2, inputFile: 'edges.json' });
  for (const id of ['phase.update', 'phase.close', 'phase.reopen', 'phase.archive', 'phase.graph', 'feature.move', 'feature.dependencies'] as const) {
    expect(getAppCliHelp(id)).toContain('usage: shiploop');
    expect(getAppCliHelp(id)).toContain('--json');
  }
});
