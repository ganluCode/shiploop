import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createCommandService, type CommandService } from '../../../packages/core/src/application/command-service.ts';
import { previewTaskStrategyReapplication } from '../../../packages/core/src/application/task-strategy-preview.ts';
import type { ActiveExecutionInputState } from '../../../packages/core/src/application/feature-plan-revise.ts';

import { createCommandsTestFixture, installWriteFault, WRITE_FAULT_POINTS, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const GLOBAL_SETTINGS = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};
const PROJECT_SETTINGS = {
  schemaVersion: 2,
  strategies: { modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } } },
};

let fixture: CommandsTestFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

async function setup(options: { readonly activeTaskId?: string } = {}): Promise<{
  readonly box: CommandsTestFixture;
  readonly service: CommandService;
  readonly harness: Awaited<ReturnType<CommandsTestFixture['openTransactionalHarness']>>;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
}> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p066-f002-reapply-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  const service = createCommandService({
    atomicStore: createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => NOW }),
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    ...(options.activeTaskId === undefined ? {} : {
      taskStrategyEditGuards: {
        activeTaskExecutionInputs: ({ taskId }: { readonly taskId: string }): ActiveExecutionInputState =>
          taskId === options.activeTaskId
            ? { active: true, evidence: { kind: 'running' } }
            : { active: false },
      },
    }),
    nowUtcMs: () => NOW,
  });
  const owner = box.localOwner();
  const submit = (operation: string, payload: Record<string, unknown>, scope: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    service.submit(owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation,
      scope,
      issuedAt: NOW_ISO,
      payload,
      ...extra,
    });
  const registered = await submit('project.register', {
    repositoryPath: box.repoDirA,
    displayName: 'Reapply project',
    description: null,
    labels: [],
  }, { kind: 'registration' });
  if (registered.status !== 'completed' || registered.result === null) throw new Error('项目注册失败');
  const projectId = (registered.result as { readonly project: { readonly id: string } }).project.id;
  expect((await submit('settings.global.create', GLOBAL_SETTINGS, { kind: 'global' })).status).toBe('completed');
  expect((await submit('settings.project.create', PROJECT_SETTINGS, { kind: 'project', projectId })).status).toBe('completed');
  expect((await submit('phase.create', {
    id: 'phase-reapply', title: 'Reapply phase', description: null, labels: [],
  }, { kind: 'project', projectId })).status).toBe('completed');
  const imported = await submit('feature.plan.import', {
    phaseId: 'phase-reapply',
    plan: {
      schemaVersion: 1,
      feature: { title: 'Reapply feature' },
      tasks: [
        { id: 'task-low', title: 'Low task', complexity: 'low', acceptance: { criteria: ['ok'] } },
        { id: 'task-default', title: 'Default task', acceptance: { criteria: ['ok'] } },
      ],
    },
  }, { kind: 'project', projectId }, { expectedRevision: 1 });
  expect(imported.status).toBe('completed');
  return { box, service, harness, owner, projectId };
}

function confirmationPayload(preview: ReturnType<typeof previewTaskStrategyReapplication>) {
  return {
    confirmed: true,
    previewDigest: preview.identity.candidateDigest,
    globalSettingsRevision: preview.identity.globalSettingsRevision,
    projectSettingsRevision: preview.identity.projectSettingsRevision,
    selectedTaskIds: preview.identity.selectedTaskIds,
    expectedTaskRevisions: preview.identity.taskRevisions.map(({ taskId, revision }) => ({ taskId, revision })),
  };
}

describe('P06-6 F-002 默认策略重新应用确认', () => {
  it('[case:reapply-success-replay] 在真实 SQLite 中批量 CAS 更新，事件和回执脱敏且重放不重复写入', async () => {
    const { box, service, harness, owner, projectId } = await setup();
    const query = createSqliteQueryStore(harness.session);
    const preview = previewTaskStrategyReapplication(
      { projectId, taskIds: ['task-low', 'task-default'] },
      { reads: query, capabilityCatalog: box.capabilityCatalog },
    );
    expect(preview.status).toBe('ready');
    const envelope = {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'task.strategy.reapply',
      scope: { kind: 'project', projectId },
      issuedAt: NOW_ISO,
      payload: confirmationPayload(preview),
    };
    const probe = box.openProbe();
    const beforeEvents = probe.selectOne<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.strategy.updated'",
    )?.count ?? 0;
    const first = await service.submit(owner, envelope);
    expect(first.status).toBe('completed');
    if (first.status !== 'completed') throw new Error('批量确认未完成');
    expect(first.result).toMatchObject({ updatedCount: 2, updatedTaskIds: ['task-default', 'task-low'] });
    expect(JSON.stringify(first)).not.toMatch(/credential|secret|\/Users\//i);
    const afterFirst = {
      low: probe.selectOne<Record<string, unknown>>('SELECT revision, execution_config, config_source, config_source_key FROM tasks WHERE id = ?', ['task-low']),
      default: probe.selectOne<Record<string, unknown>>('SELECT revision, execution_config, config_source, config_source_key FROM tasks WHERE id = ?', ['task-default']),
      events: probe.selectOne<{ readonly count: number }>("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.strategy.updated'")?.count ?? 0,
    };
    expect(afterFirst.low?.revision).toBe(2);
    expect(afterFirst.default?.revision).toBe(2);
    expect(afterFirst.events - beforeEvents).toBe(2);

    const replay = await service.submit(owner, envelope);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(probe.selectOne<Record<string, unknown>>('SELECT revision, execution_config, config_source, config_source_key FROM tasks WHERE id = ?', ['task-low'])).toEqual(afterFirst.low);
    expect(probe.selectOne<Record<string, unknown>>('SELECT revision, execution_config, config_source, config_source_key FROM tasks WHERE id = ?', ['task-default'])).toEqual(afterFirst.default);
    expect(probe.selectOne<{ readonly count: number }>("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.strategy.updated'")?.count).toBe(afterFirst.events);
  });

  it('[case:reapply-stale-config-zero-write] 配置 revision 变化使确认摘要过期，整组零写入', async () => {
    const { box, service, harness, owner, projectId } = await setup();
    const query = createSqliteQueryStore(harness.session);
    const preview = previewTaskStrategyReapplication(
      { projectId, taskIds: ['task-low', 'task-default'] },
      { reads: query, capabilityCatalog: box.capabilityCatalog },
    );
    const probe = box.openProbe();
    const before = probe.selectAll<Record<string, unknown>>(
      "SELECT id, revision, execution_config, config_source, config_source_key FROM tasks WHERE id IN ('task-low', 'task-default') ORDER BY id",
    );
    const update = await service.submit(owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'settings.project.update',
      scope: { kind: 'project', projectId },
      expectedRevision: preview.identity.projectSettingsRevision,
      issuedAt: NOW_ISO,
      payload: {
        schemaVersion: 2,
        strategies: { modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } } },
      },
    });
    expect(update.status).toBe('completed');
    const stale = await service.submit(owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'task.strategy.reapply',
      scope: { kind: 'project', projectId },
      issuedAt: NOW_ISO,
      payload: confirmationPayload(preview),
    });
    expect(stale.status).toBe('rejected');
    if (stale.status !== 'rejected') throw new Error('过期确认未被拒绝');
    expect(stale.error?.details?.reason).toBe('preview_stale');
    expect(probe.selectAll<Record<string, unknown>>(
      "SELECT id, revision, execution_config, config_source, config_source_key FROM tasks WHERE id IN ('task-low', 'task-default') ORDER BY id",
    )).toEqual(before);
    expect(probe.selectOne<{ readonly count: number }>("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.strategy.updated'")?.count).toBe(0);
  });

  it('[case:reapply-active-input-zero-write] 活动执行输入在同一确认事务内阻断整组更新', async () => {
    const { box, service, harness, owner, projectId } = await setup({ activeTaskId: 'task-default' });
    const query = createSqliteQueryStore(harness.session);
    const preview = previewTaskStrategyReapplication(
      { projectId, taskIds: ['task-low', 'task-default'] },
      { reads: query, capabilityCatalog: box.capabilityCatalog },
    );
    const probe = box.openProbe();
    const before = probe.selectAll<Record<string, unknown>>(
      "SELECT id, revision, execution_config FROM tasks WHERE id IN ('task-low', 'task-default') ORDER BY id",
    );
    const receipt = await service.submit(owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'task.strategy.reapply',
      scope: { kind: 'project', projectId },
      issuedAt: NOW_ISO,
      payload: confirmationPayload(preview),
    });
    expect(receipt.status).toBe('rejected');
    if (receipt.status !== 'rejected') throw new Error('活动输入未被拒绝');
    expect(receipt.error.details?.reason).toBe('active_execution_inputs');
    expect(probe.selectAll<Record<string, unknown>>(
      "SELECT id, revision, execution_config FROM tasks WHERE id IN ('task-low', 'task-default') ORDER BY id",
    )).toEqual(before);
  });

  it('[case:reapply-write-fault-rollback] Task 写入故障使已开始的批量写入整体回滚', async () => {
    const { box, service, harness, owner, projectId } = await setup();
    const query = createSqliteQueryStore(harness.session);
    const preview = previewTaskStrategyReapplication(
      { projectId, taskIds: ['task-low', 'task-default'] },
      { reads: query, capabilityCatalog: box.capabilityCatalog },
    );
    const probe = box.openProbe();
    const before = probe.selectAll<Record<string, unknown>>(
      "SELECT id, revision, execution_config, config_source, config_source_key FROM tasks WHERE id IN ('task-low', 'task-default') ORDER BY id",
    );
    const fault = installWriteFault(harness.session.database, { target: WRITE_FAULT_POINTS.tasksBeforeUpdate });
    try {
      await expect(service.submit(owner, {
        schemaVersion: 5,
        commandId: randomUUID(),
        operation: 'task.strategy.reapply',
        scope: { kind: 'project', projectId },
        issuedAt: NOW_ISO,
        payload: confirmationPayload(preview),
      })).rejects.toBeDefined();
    } finally {
      fault.remove();
    }
    expect(probe.selectAll<Record<string, unknown>>(
      "SELECT id, revision, execution_config, config_source, config_source_key FROM tasks WHERE id IN ('task-low', 'task-default') ORDER BY id",
    )).toEqual(before);
    expect(probe.selectOne<{ readonly count: number }>("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.strategy.updated'")?.count).toBe(0);
  });

  it('[case:reapply-explicit-confirmation] 缺少显式确认或目标 revision 时在协议层拒绝', async () => {
    const { service, owner, projectId } = await setup();
    const base = {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'task.strategy.reapply',
      scope: { kind: 'project', projectId },
      issuedAt: NOW_ISO,
    };
    await expect(service.submit(owner, {
      ...base,
      payload: {
        confirmed: false,
        previewDigest: '0'.repeat(64),
        globalSettingsRevision: 1,
        projectSettingsRevision: 1,
        selectedTaskIds: ['task-low'],
        expectedTaskRevisions: [{ taskId: 'task-low', revision: 1 }],
      },
    })).rejects.toMatchObject({ code: 'invalid_input', operation: 'task.strategy.reapply' });
    await expect(service.submit(owner, {
      ...base,
      commandId: randomUUID(),
      payload: {
        confirmed: true,
        previewDigest: '0'.repeat(64),
        globalSettingsRevision: 1,
        projectSettingsRevision: 1,
        selectedTaskIds: ['task-low'],
        expectedTaskRevisions: [],
      },
    })).rejects.toMatchObject({ code: 'invalid_input', operation: 'task.strategy.reapply' });
  });
});
