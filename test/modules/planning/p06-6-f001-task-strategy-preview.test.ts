import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { previewTaskStrategyReapplication } from '../../../packages/core/src/application/task-strategy-preview.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import type { TaskRecord } from '../../../packages/core/src/ports/plan-store.ts';
import type {
  TaskStrategyReapplicationReadStore,
  TaskStrategyReapplicationReadView,
} from '../../../packages/core/src/ports/task-strategy-preview.ts';
import type { SettingsPayload } from '../../../packages/core/src/ports/settings-schema.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';

const projectId = 'project-a';
const strategy = { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } as const;
const globalPayload = { schemaVersion: 2, strategies: { defaultStrategy: strategy } } as SettingsPayload;
const projectPayload = {
  schemaVersion: 2,
  strategies: { modelMap: { low: { ...strategy, model: 'claude-low' } } },
} as SettingsPayload;

let realFixture: CommandsTestFixture | undefined;
afterEach(() => {
  realFixture?.cleanup();
  realFixture = undefined;
});

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    projectId,
    featureId: 'feature-a',
    title: id,
    description: null,
    labels: [],
    status: 'pending',
    complexity: 'low',
    acceptance: { criteria: ['ok'] },
    requirementsRefs: [],
    executionConfig: { ...strategy, schemaVersion: 2, model: 'old-model' },
    configSource: 'global_default',
    configSourceKey: 'defaultStrategy',
    revision: 3,
    createdAtUtcMs: 1,
    updatedAtUtcMs: 1,
    ...overrides,
  };
}

function store(view: TaskStrategyReapplicationReadView): TaskStrategyReapplicationReadStore {
  let reads = 0;
  return {
    readTaskStrategyReapplicationView() {
      reads += 1;
      expect(reads).toBe(1);
      return view;
    },
  };
}

const catalog = createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-low', 'claude-sonnet'] }] },
]);

function baseView(tasks: readonly TaskRecord[]): TaskStrategyReapplicationReadView {
  return {
    projectExists: true,
    globalSettings: { revision: 7, payload: globalPayload },
    projectSettings: { revision: 4, payload: projectPayload },
    tasks: tasks.map((record) => ({
      task: record,
      ownership: 'same_project',
      execution: {
        hasExecutionHistory: false,
        hasActiveExecutionInputs: false,
        hasAuthorizedBatchScope: false,
      },
    })),
  };
}

describe('P06-6 F-001 默认策略重新应用预览', () => {
  it('[case:preview-candidate-identity] 计算完整候选、差异和稳定身份，重复读取不写入', () => {
    const input = { projectId, taskIds: ['task-a'] };
    const first = previewTaskStrategyReapplication(input, {
      reads: store(baseView([task('task-a')])),
      capabilityCatalog: catalog,
    });
    const second = previewTaskStrategyReapplication(input, {
      reads: store(baseView([task('task-a')])),
      capabilityCatalog: catalog,
    });

    expect(first).toEqual(second);
    expect(first.status).toBe('ready');
    expect(first.identity).toMatchObject({
      projectId,
      globalSettingsRevision: 7,
      projectSettingsRevision: 4,
      selectedTaskIds: ['task-a'],
      taskRevisions: [{ taskId: 'task-a', revision: 3 }],
    });
    expect(first.items[0]).toMatchObject({
      eligible: true,
      candidate: {
        executionConfig: { runtime: 'pi', provider: 'anthropic', model: 'claude-low', schemaVersion: 2 },
        configSource: 'project_default',
        configSourceKey: 'modelMap.low',
      },
      diff: { changed: true, fields: ['model'] },
    });
    expect(JSON.stringify(first)).not.toContain('/Users/');
  });

  it('[case:preview-excludes-execution-inputs] rejects started, historical, active and Batch-fixed Tasks with reasons', () => {
    const records = [
      task('started', { status: 'running' }),
      task('history'),
      task('active'),
      task('batch'),
    ];
    const view = baseView(records).tasks.map((entry) => ({
      ...entry,
      execution: entry.task?.id === 'history'
        ? { ...entry.execution, hasExecutionHistory: true }
        : entry.task?.id === 'active'
          ? { ...entry.execution, hasActiveExecutionInputs: true }
          : entry.task?.id === 'batch'
            ? { ...entry.execution, hasAuthorizedBatchScope: true }
            : entry.execution,
    }));
    const result = previewTaskStrategyReapplication(
      { projectId, taskIds: records.map((record) => record.id) },
      { reads: store({ ...baseView([]), tasks: view }), capabilityCatalog: catalog },
    );
    expect(result.status).toBe('blocked');
    expect(result.items.map((item) => [item.taskId, item.reasons])).toEqual([
      ['active', ['active_execution_inputs']],
      ['batch', ['authorized_batch_scope']],
      ['history', ['execution_history']],
      ['started', ['task_started']],
    ]);
  });

  it('[case:preview-fail-closed] missing configuration and unsupported capability never fall back to old or other strategies', () => {
    const missing = previewTaskStrategyReapplication(
      { projectId, taskIds: ['task-a'] },
      {
        reads: store({
          projectExists: true,
          globalSettings: null,
          projectSettings: null,
          tasks: baseView([task('task-a')]).tasks,
        }),
        capabilityCatalog: catalog,
      },
    );
    expect(missing.items[0]).toMatchObject({ eligible: false, candidate: null, reasons: ['configuration_missing'] });

    const unsupported = previewTaskStrategyReapplication(
      { projectId, taskIds: ['task-a'] },
      {
        reads: store(baseView([task('task-a')])),
        capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
      },
    );
    expect(unsupported.items[0]).toMatchObject({ eligible: false, candidate: null, reasons: ['unknown_runtime'] });
  });
  it('[case:preview-sqlite-read-only] 真实 SQLite 一致读预览不改变 Task、事件或执行事实', async () => {
    realFixture = createCommandsTestFixture({ prefix: 'shiploop-p066-f001-preview-' });
    const box = realFixture;
    const app = await box.openApplication();
    const harness = await box.openTransactionalHarness();
    const owner = box.localOwner();
    const submit = (operation: string, scope: unknown, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      app.commandService.submit(owner, {
        schemaVersion: 5,
        commandId: randomUUID(),
        operation,
        scope,
        issuedAt: new Date(1_900_000_000_000).toISOString(),
        payload,
        ...extra,
      });
    const registered = await submit('project.register', { kind: 'registration' }, {
      repositoryPath: box.repoDirA,
      displayName: 'Preview project',
      description: null,
      labels: [],
    });
    if (registered.status !== 'completed' || registered.result === null) throw new Error('项目注册失败');
    const registeredResult = registered.result as { readonly project: { readonly id: string } };
    const realProjectId = registeredResult.project.id;
    await submit('settings.global.create', { kind: 'global' }, globalPayload as unknown as Record<string, unknown>);
    await submit('settings.project.create', { kind: 'project', projectId: realProjectId }, {
      schemaVersion: 2,
      strategies: { modelMap: { low: { ...strategy, model: 'claude-sonnet-2' } } },
    });
    await submit('phase.create', { kind: 'project', projectId: realProjectId }, {
      id: 'phase-preview', title: 'Preview phase', description: null, labels: [],
    });
    const imported = await submit(
      'feature.plan.import',
      { kind: 'project', projectId: realProjectId },
      {
        phaseId: 'phase-preview',
        plan: {
          schemaVersion: 1,
          feature: { title: 'Preview feature' },
          tasks: [{ id: 'task-preview', title: 'Preview task', complexity: 'low', acceptance: { criteria: ['ok'] } }],
        },
      },
      { expectedRevision: 1 },
    );
    expect(imported.status).toBe('completed');

    const probe = box.openProbe();
    const beforeCounts = probe.counts();
    const beforeTask = probe.selectOne<Record<string, unknown>>(
      'SELECT id, revision, execution_config, config_source, config_source_key FROM tasks WHERE id = ?',
      ['task-preview'],
    );
    const result = previewTaskStrategyReapplication(
      { projectId: realProjectId, taskIds: ['task-preview'] },
      {
        reads: createSqliteQueryStore(harness.session),
        capabilityCatalog: box.capabilityCatalog,
      },
    );
    expect(result.status).toBe('ready');
    expect(result.items[0]?.candidate?.executionConfig.model).toBe('claude-sonnet-2');
    expect(probe.counts()).toEqual(beforeCounts);
    expect(probe.selectOne<Record<string, unknown>>(
      'SELECT id, revision, execution_config, config_source, config_source_key FROM tasks WHERE id = ?',
      ['task-preview'],
    )).toEqual(beforeTask);
  });
  it('[case:preview-cross-project-redaction] 跨项目目标只返回受控拒绝原因，不泄漏 Task 归属或策略摘要', () => {
    const other = task('task-other', { projectId: 'project-b', featureId: 'feature-b', revision: 9 });
    const result = previewTaskStrategyReapplication(
      { projectId, taskIds: ['task-other'] },
      {
        reads: store({
          projectExists: true,
          globalSettings: { revision: 7, payload: globalPayload },
          projectSettings: { revision: 4, payload: projectPayload },
          tasks: [{
            task: other,
            ownership: 'other_project',
            execution: {
              hasExecutionHistory: false,
              hasActiveExecutionInputs: false,
              hasAuthorizedBatchScope: false,
            },
          }],
        }),
        capabilityCatalog: catalog,
      },
    );
    expect(result.items[0]).toEqual({
      taskId: 'task-other',
      featureId: null,
      taskRevision: null,
      complexity: null,
      current: { configSource: null, configSourceKey: null, digest: null },
      candidate: null,
      diff: null,
      eligible: false,
      reasons: ['cross_project'],
    });
  });
});
