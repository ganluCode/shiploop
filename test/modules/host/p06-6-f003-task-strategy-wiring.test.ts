import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { connectToHost, createHostClientApplication, startHost, type HostClient, type TaskStrategyReapplicationInput, type TaskStrategyReapplicationPreviewWire } from '../../../packages/host/src/index.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from '../../../packages/core/src/protocol.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 });
});

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
  const global = await client.submitCommand({ operation: 'settings.global.create', scope: { kind: 'global' }, payload: GLOBAL_SETTINGS });
  expect(global.status).toBe('completed');
  const seed = async (projectId: string, taskId: string): Promise<void> => {
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

function confirmation(preview: TaskStrategyReapplicationPreviewWire): TaskStrategyReapplicationInput {
  return {
    confirmed: true, projectId: preview.identity.projectId,
    previewDigest: preview.identity.candidateDigest,
    globalSettingsRevision: preview.identity.globalSettingsRevision,
    projectSettingsRevision: preview.identity.projectSettingsRevision,
    selectedTaskIds: preview.identity.selectedTaskIds,
    expectedTaskRevisions: preview.identity.taskRevisions.map(entry => ({ taskId: entry.taskId, revision: entry.revision! })),
  };
}

function taskRows() {
  return fixture!.openProbe().selectAll<Record<string, unknown>>(
    'SELECT id, project_id, revision, execution_config, config_source, config_source_key FROM tasks ORDER BY id',
  );
}

async function invokeCli(args: string[]) {
  let stdout = '';
  let stderr = '';
  const result = await runAppCli({
    args: [...args, '--data-root', fixture!.dataRoot], env: {},
    io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
  });
  return { result, stdout, stderr };
}

function confirmationFile(input: TaskStrategyReapplicationInput): string {
  const { projectId: _project, confirmed: _confirmed, commandId: _command, ...payload } = input;
  const path = join(fixture!.root, 'confirmation.json');
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return path;
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
      confirmed: true as const,
      projectId,
      previewDigest: preview.identity.candidateDigest,
      globalSettingsRevision: preview.identity.globalSettingsRevision,
      projectSettingsRevision: preview.identity.projectSettingsRevision,
      selectedTaskIds: preview.identity.selectedTaskIds,
      expectedTaskRevisions: preview.identity.taskRevisions.map(entry => ({ taskId: entry.taskId, revision: entry.revision! })),
      commandId,
    };
    const first = await client!.reapplyTaskStrategy(input);
    expect(first.status).toBe('completed');
    if (first.status !== 'completed') throw new Error('reapply failed');
    expect(first.operation).toBe('task.strategy.reapply');
    expect(first.result).toMatchObject({ updatedCount: 1, updatedTaskIds: [taskId] });
    const replay = await client!.reapplyTaskStrategy(input, { issuedAt: first.issuedAt });
    expect(replay).toMatchObject({ status: 'completed', replayed: true, commandId });
    expect((first.result as { taskRevisions: readonly { revision: number }[] }).taskRevisions[0]?.revision).toBe(2);
    const persisted = await client!.getTask(taskId);
    expect(persisted.task.revision).toBe(2);
    expect((await client!.listTasks(projectId, persisted.task.featureId)).records.map(task => task.id)).toEqual([taskId]);
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

  it('[case:strict-reapply-envelope] 未知字段、缺确认、错误身份及旧摘要均拒绝且 Task 零写入', async () => {
    const { projectId, taskId, otherProjectId, otherTaskId } = await setup();
    const before = taskRows();
    const countsBefore = fixture!.openProbe().counts();
    const preview = await client!.previewTaskStrategyReapplication(projectId, [taskId]);
    expect(taskRows()).toEqual(before);
    expect(fixture!.openProbe().counts()).toEqual(countsBefore);
    const input = confirmation(preview);
    const token = readFileSync(join(fixture!.dataRoot, 'host', 'auth.token'), 'utf8');
    const { projectId: _project, commandId: _command, ...payload } = input;
    for (const invalid of [
      { ...payload, confirmed: false },
      { ...payload, confirmed: undefined },
      { ...payload, unexpected: '/Users/secret' },
      { ...payload, expectedTaskRevisions: [{ taskId, revision: 1, secret: 'do-not-echo' }] },
      { ...payload, selectedTaskIds: ['../invalid'] },
      { ...payload, expectedTaskRevisions: [] },
    ]) {
      const response = await loopbackRequest({
        port: host!.port, method: 'POST', path: '/v1/commands', token,
        body: { schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION, commandId: randomUUID(), issuedAt: new Date().toISOString(),
          operation: 'task.strategy.reapply', scope: { kind: 'project', projectId }, payload: invalid },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).not.toMatch(/do-not-echo|\/Users\/secret/);
    }
    await expect(client!.reapplyTaskStrategy({ ...input, expectedTaskRevisions: [{ taskId, revision: 1, extra: true }] } as unknown as TaskStrategyReapplicationInput))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(client!.reapplyTaskStrategy({ ...input, confirmed: undefined } as unknown as TaskStrategyReapplicationInput))
      .rejects.toMatchObject({ code: 'invalid_input' });
    for (const stale of [
      { ...input, previewDigest: 'a'.repeat(64) },
      { ...input, projectId: otherProjectId },
      { ...input, selectedTaskIds: [otherTaskId], expectedTaskRevisions: [{ taskId: otherTaskId, revision: 1 }] },
      { ...input, expectedTaskRevisions: [{ taskId, revision: 2 }] },
    ]) {
      const receipt = await client!.reapplyTaskStrategy(stale);
      expect(receipt).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    }
    expect(taskRows()).toEqual(before);
    expect(fixture!.openProbe().selectOne<{ count: number }>("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.strategy.updated'")?.count).toBe(0);
    const missing = await client!.previewTaskStrategyReapplication(projectId, ['missing-task']);
    expect(missing).toMatchObject({ status: 'blocked', blockedReasons: ['task_not_found'] });
    await expect(client!.previewTaskStrategyReapplication('../invalid', [taskId])).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('[case:cli-reapply-output] CLI JSON/文本显示完整审阅信息，重放零写入，异参/旧摘要返回非零退出码', async () => {
    const { projectId, taskId } = await setup();
    expect((await client!.submitCommand({ operation: 'settings.global.update', scope: { kind: 'global' }, expectedRevision: 1,
      payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } } } })).status).toBe('completed');
    const previewCall = await invokeCli(['task', 'strategy-preview', '--project', projectId, '--task', taskId, '--json']);
    expect(previewCall.result.exitCode, previewCall.stderr).toBe(0);
    const preview = JSON.parse(previewCall.stdout).result as TaskStrategyReapplicationPreviewWire;
    expect(preview.changedCount).toBe(1);
    expect(preview.items[0]?.diff?.fields).toEqual(['model']);
    const human = await invokeCli(['task', 'strategy-preview', '--project', projectId, '--task', taskId]);
    expect(human.result.exitCode).toBe(0);
    for (const value of [taskId, preview.items[0]!.current.digest!, preview.items[0]!.candidate!.digest, 'global_default', 'changed=1']) expect(human.stdout).toContain(value);
    const input = confirmation(preview);
    const path = confirmationFile(input);
    const commandId = randomUUID();
    const args = ['task', 'strategy-reapply', '--project', projectId, '--input', path, '--confirm', '--command-id', commandId];
    const first = await invokeCli([...args, '--json']);
    expect(first.result.exitCode, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).result).toMatchObject({ status: 'completed', operation: 'task.strategy.reapply', result: { taskRevisions: [{ taskId, revision: 2 }] } });
    const rows = taskRows();
    const replay = await invokeCli(args);
    expect(replay.result.exitCode, replay.stderr).toBe(0);
    expect(replay.stdout).toContain(`task=${taskId} revision=2`);
    expect(replay.stdout).toContain('replayed=true');
    expect(taskRows()).toEqual(rows);
    confirmationFile({ ...input, previewDigest: 'a'.repeat(64) });
    const conflict = await invokeCli([...args, '--json']);
    expect(conflict.result.exitCode).not.toBe(0);
    expect(JSON.parse(conflict.stdout)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const stale = await invokeCli(['task', 'strategy-reapply', '--project', projectId, '--input', path, '--confirm', '--json']);
    expect(stale.result.exitCode).not.toBe(0);
    expect(JSON.parse(stale.stdout)).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason: 'preview_stale' } } });
    const noConfirm = await invokeCli(['task', 'strategy-reapply', '--project', projectId, '--input', path, '--json']);
    expect(noConfirm.result.exitCode).toBe(2);
    writeFileSync(path, JSON.stringify({ ...input, unknown: '/Users/secret' }), 'utf8');
    const unknown = await invokeCli(['task', 'strategy-reapply', '--project', projectId, '--input', path, '--confirm', '--json']);
    expect(unknown.result.exitCode).toBe(2);
    const output = [previewCall, human, first, replay, conflict, stale, noConfirm, unknown].map(call => call.stdout + call.stderr).join('\n');
    expect(output).not.toContain(fixture!.root);
    expect(output).not.toContain('/Users/secret');
    expect(output).not.toContain('executionConfig');
    expect(taskRows()).toEqual(rows);
  });

  it('[case:lost-response-receipt] 真实确认响应丢失后先查询回执，不重复 POST 或更新 Task', async () => {
    const { projectId, taskId } = await setup();
    const preview = await client!.previewTaskStrategyReapplication(projectId, [taskId]);
    const token = readFileSync(join(fixture!.dataRoot, 'host', 'auth.token'), 'utf8');
    let posts = 0;
    let receiptGets = 0;
    const proxy = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const upstream = await loopbackRequest({ port: host!.port, method: request.method as 'GET' | 'POST', path: request.url!, token,
          ...(bodyText.length === 0 ? {} : { rawBody: bodyText }) });
        if (request.method === 'POST') {
          posts += 1;
          expect(upstream.statusCode).toBe(200);
          response.destroy();
          return;
        }
        if (request.url!.startsWith('/v1/receipts/')) receiptGets += 1;
        response.writeHead(upstream.statusCode, { 'content-type': 'application/json' });
        response.end(upstream.bodyText);
      })().catch(() => { response.writeHead(500); response.end(); });
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const address = proxy.address();
      if (address === null || typeof address === 'string') throw new Error('proxy address missing');
      const recovering = createHostClientApplication({ port: address.port, token, connectMs: 200, appRequestMs: 2000, submitBudgetMs: 5000,
        assertOpen() {}, registerSubscription() {}, unregisterSubscription() {} });
      const receipt = await recovering.reapplyTaskStrategy(confirmation(preview));
      expect(receipt).toMatchObject({ status: 'completed', replayed: false });
      // GET 返回原持久回执；只有重新提交同一信封才标记 replayed=true。
      expect(posts).toBe(1);
      expect(receiptGets).toBe(1);
      expect((await client!.getTask(taskId)).task.revision).toBe(2);
      expect(fixture!.openProbe().selectOne<{ count: number }>("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.strategy.updated'")?.count).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    }
  });
});
