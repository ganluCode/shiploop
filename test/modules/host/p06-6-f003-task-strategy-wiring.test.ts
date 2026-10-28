import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { connectToHost, startHost, type HostClient } from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

const GLOBAL_SETTINGS = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};

let fixture: CommandsTestFixture | undefined;
let host: RunningHost | undefined;
let client: HostClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await host?.close();
  host = undefined;
  fixture?.cleanup();
  fixture = undefined;
});

async function setup(): Promise<{ projectId: string; otherProjectId: string; taskId: string; otherTaskId: string }> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p066-f003-host-' });
  host = await startHost({ dataRoot: fixture.dataRoot, capabilityCatalog: fixture.capabilityCatalog, env: {} });
  client = await connectToHost({ canonicalRoot: fixture.dataRoot });
  const register = async (name: string, repositoryPath: string): Promise<string> => {
    const receipt = await client!.submitCommand({
      operation: 'project.register',
      scope: { kind: 'registration' },
      payload: { repositoryPath, displayName: name, description: null, labels: [] },
    });
    if (receipt.status !== 'completed') throw new Error('project registration failed');
    return (receipt.result as { project: { id: string } }).project.id;
  };
  const seed = async (projectId: string, taskId: string): Promise<void> => {
    const global = await client!.submitCommand({ operation: 'settings.global.create', scope: { kind: 'global' }, payload: GLOBAL_SETTINGS });
    if (global.status !== 'completed' && global.status !== 'rejected') throw new Error('global settings failed');
    const phase = await client!.createPhase({ projectId, id: `phase-${taskId}`, title: 'P06-6 phase', description: null, labels: [] });
    if (phase.status !== 'completed') throw new Error('phase failed');
    const imported = await client!.importFeaturePlan({
      projectId,
      phaseId: `phase-${taskId}`,
      expectedRevision: 1,
      plan: {
        schemaVersion: 1,
        feature: { title: 'P06-6 feature', description: null, labels: [], sourceRefs: [] },
        tasks: [{ id: taskId, title: 'P06-6 task', complexity: 'low', acceptance: { criteria: ['ok'] } }],
      },
    });
    if (imported.status !== 'completed') throw new Error('plan import failed');
  };
  const projectId = await register('P06-6 project', fixture.repoDirA);
  await seed(projectId, 'task-local');
  const otherProjectId = await register('P06-6 other project', fixture.repoDirB);
  await seed(otherProjectId, 'task-other');
  return { projectId, otherProjectId, taskId: 'task-local', otherTaskId: 'task-other' };
}

describe('P06-6 F-003 默认策略重应用 Host/HostClient 纵向', () => {
  it('[case:loopback-preview-confirm-replay] 真实预览、显式确认和 commandId 重放保持结构化身份', async () => {
    const { projectId, taskId } = await setup();
    const preview = await client!.previewTaskStrategyReapplication(projectId, [taskId]);
    expect(preview.scope).toBe('task-strategy-reapplication-preview');
    expect(preview.status).toBe('ready');
    expect(preview.identity.selectedTaskIds).toEqual([taskId]);
    expect(preview.items[0]).toMatchObject({ taskId, eligible: true, current: { configSource: 'global_default' } });
    expect(JSON.stringify(preview)).not.toMatch(/secret|credential|\/Users\//i);

    const commandId = '2c7d7e29-5b46-4cb9-ae4c-9d5f8c0d1f31';
    const input = {
      projectId,
      previewDigest: preview.identity.candidateDigest,
      globalSettingsRevision: preview.identity.globalSettingsRevision,
      projectSettingsRevision: preview.identity.projectSettingsRevision,
      selectedTaskIds: preview.identity.selectedTaskIds,
      expectedTaskRevisions: preview.identity.taskRevisions.map(entry => ({ taskId: entry.taskId, revision: entry.revision! })),
      commandId,
    };
    let first;
    try {
      first = await client!.reapplyTaskStrategy(input);
    } catch (error) {
      throw new Error(`reapply failed: ${JSON.stringify(error)}`);
    }
    expect(first.status).toBe('completed');
    if (first.status !== 'completed') throw new Error('reapply failed');
    expect(first.operation).toBe('task.strategy.reapply');
    expect(first.result).toMatchObject({ updatedCount: 1, updatedTaskIds: [taskId] });
    const replay = await client!.reapplyTaskStrategy(input, { issuedAt: first.issuedAt });
    expect(replay).toMatchObject({ status: 'completed', replayed: true, commandId });
    expect((first.result as { taskRevisions: readonly { revision: number }[] }).taskRevisions[0]?.revision).toBe(2);
  });

  it('[case:cross-project-and-query-boundary] 跨项目 Task 只返回受控阻塞，未知 query 字段在 Host 层拒绝', async () => {
    const { projectId, otherTaskId } = await setup();
    const preview = await client!.previewTaskStrategyReapplication(projectId, [otherTaskId]);
    expect(preview.status).toBe('blocked');
    expect(preview.items[0]?.reasons).toContain('cross_project');
    const token = readFileSync(join(fixture!.dataRoot, 'host', 'auth.token'), 'utf8');
    const response = await loopbackRequest({
      port: host!.port,
      method: 'GET',
      path: `/v1/task-strategy-reapplication?projectId=${projectId}&taskId=${otherTaskId}&unexpected=x`,
      token,
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).not.toContain(fixture!.dataRoot);
  });
});
