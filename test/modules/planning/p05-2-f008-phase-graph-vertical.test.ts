import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import {
  connectToHost,
  startHost,
  type HostClient,
} from '../../../packages/host/src/index.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';

let box: CommandsTestFixture | undefined;
let host: Awaited<ReturnType<typeof startHost>> | undefined;
let client: HostClient | undefined;

beforeAll(() => execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: resolve('.'), timeout: 60_000 }));
afterEach(async () => {
  await client?.close();
  await host?.close();
  client = undefined;
  host = undefined;
  box?.cleanup();
  box = undefined;
});

function completed(receipt: Awaited<ReturnType<HostClient['submitCommand']>>) {
  expect(receipt.status, JSON.stringify(receipt)).toBe('completed');
  if (receipt.status !== 'completed') throw new Error('expected completed');
  return receipt;
}

async function importFeature(projectId: string, phaseId: string, title: string): Promise<string> {
  if (client === undefined) throw new Error('host client is not ready');
  const phase = (await client.getPhase(phaseId)).phase;
  const receipt = completed(await client.importFeaturePlan({
    projectId,
    phaseId,
    expectedRevision: phase.revision,
    plan: {
      schemaVersion: 1,
      feature: { title, description: null, labels: [], sourceRefs: [] },
      tasks: [{ id: `task-${title}`, title: 'Task', complexity: 'low', acceptance: { criteria: ['criterion'] } }],
    },
  }));
  return (receipt.result as { feature: { id: string } }).feature.id;
}

async function setup() {
  box = createCommandsTestFixture({ prefix: 'shiploop-p052-f008-' });
  host = await startHost({ dataRoot: box.dataRoot, capabilityCatalog: box.capabilityCatalog, env: {} });
  client = await connectToHost({ canonicalRoot: box.dataRoot });
  const token = readFileSync(join(box.dataRoot, 'host', 'auth.token'), 'utf8');
  const registered = completed(await client.submitCommand({
    operation: 'project.register',
    scope: { kind: 'registration' },
    payload: { repositoryPath: box.repoDirA, displayName: 'P05-2 vertical' },
  }));
  const projectId = (registered.result as { project: { id: string } }).project.id;
  completed(await client.submitCommand({
    operation: 'settings.global.create',
    scope: { kind: 'global' },
    payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } } },
  }));
  completed(await client.createPhase({ projectId, id: 'phase-a', title: 'Phase A', description: 'vertical', labels: ['p05'] }));

  const cli = async (args: string[], json = true) => {
    if (box === undefined) throw new Error('fixture is not ready');
    let stdout = '';
    let stderr = '';
    const result = await runAppCli({
      args: [...args, '--data-root', box.dataRoot, ...(json ? ['--json'] : [])],
      env: {},
      io: {
        stdout: text => { stdout += text; },
        stderr: text => { stderr += text; },
      },
    });
    const body = json ? JSON.parse(stdout) as Record<string, any> : undefined;
    if (json) expect(stdout.trim().split('\n')).toHaveLength(1);
    return { ...result, stdout, stderr, body };
  };

  async function restart(): Promise<void> {
    await client?.close();
    await host?.close();
    host = await startHost({ dataRoot: box!.dataRoot, capabilityCatalog: box!.capabilityCatalog, env: {} });
    client = await connectToHost({ canonicalRoot: box!.dataRoot });
  }

  return {
    get client(): HostClient {
      if (client === undefined) throw new Error('host client is not ready');
      return client;
    },
    box,
    projectId,
    token,
    cli,
    restart,
  };
}

function writeEdges(path: string, edges: readonly { featureId: string; dependsOnId: string }[]): void {
  writeFileSync(path, JSON.stringify({ edges }), 'utf8');
}

function graphSnapshot(s: Awaited<ReturnType<typeof setup>>) {
  const probe = s.box.openProbe();
  try {
    return probe.selectAll('SELECT id, revision, status FROM phases WHERE project_id = ? ORDER BY id', [s.projectId]);
  } finally {
    probe.close();
  }
}

it('[case:vertical-dag-readiness] 真实 Host/CLI 写入 A/B/C/D 图，完成前置仍等待集成证据且重复命令只生效一次', async () => {
  const s = await setup();
  const a = await importFeature(s.projectId, 'phase-a', 'A');
  const b = await importFeature(s.projectId, 'phase-a', 'B');
  const c = await importFeature(s.projectId, 'phase-a', 'C');
  const d = await importFeature(s.projectId, 'phase-a', 'D');
  const phase = (await s.client.getPhase('phase-a')).phase;
  const input = join(s.box.root, 'dag.json');
  writeEdges(input, [{ featureId: c, dependsOnId: a }, { featureId: c, dependsOnId: b }]);
  const commandId = randomUUID();
  const args = ['feature', 'dependencies', '--project', s.projectId, '--phase', 'phase-a', '--revision', String(phase.revision),
    '--input', input, '--command-id', commandId];
  const first = await s.cli(args);
  expect(first.exitCode, first.stdout).toBe(0);
  const afterFirst = graphSnapshot(s);
  const replay = await s.cli(args);
  expect(replay.exitCode, replay.stdout).toBe(0);
  expect(replay.body?.result?.replayed).toBe(true);
  expect(graphSnapshot(s)).toEqual(afterFirst);

  const initial = await s.client.getPhaseGraph(s.projectId, 'phase-a');
  expect(new Set(initial.features.map(feature => feature.title))).toEqual(new Set(['A', 'B', 'C', 'D']));
  expect(initial.dependencies.map(edge => [edge.featureId, edge.dependsOnId]).sort()).toEqual([[c, a], [c, b]].sort());
  expect(initial.readiness.find(item => item.featureId === c)).toMatchObject({
    dependencyCompleted: false,
    dependencyIntegrationReady: false,
    ready: false,
    reason: 'dependency_pending',
  });
  expect(initial.executableFeatureIds).toEqual([]);

  const arrangement = await s.box.openTransactionalHarness();
  try {
    arrangement.session.database.prepare("UPDATE features SET status = 'completed' WHERE id IN (?, ?)").run(a, b);
  } finally {
    arrangement.close();
  }
  const completedParents = await s.client.getPhaseGraph(s.projectId, 'phase-a');
  expect(completedParents.readiness.find(item => item.featureId === c)).toMatchObject({
    dependencyCompleted: true,
    dependencyCompletion: 'complete',
    dependencyIntegrationReady: false,
    ready: false,
    reason: 'integration_not_ready',
  });
  expect(completedParents.readiness.find(item => item.featureId === c)?.blockers).toContain('integration_not_ready');
  expect(completedParents.features.find(feature => feature.id === d)?.status).toBe('draft');
});

it('[case:vertical-dag-negative-restart] 环、跨项目、悬空引用、过期 CAS、失败前置和重启重放保持数据库与副作用不变', async () => {
  const s = await setup();
  const a = await importFeature(s.projectId, 'phase-a', 'A');
  const b = await importFeature(s.projectId, 'phase-a', 'B');
  const c = await importFeature(s.projectId, 'phase-a', 'C');
  const phase = (await s.client.getPhase('phase-a')).phase;
  const input = join(s.box.root, 'negative-dag.json');
  writeEdges(input, [{ featureId: c, dependsOnId: a }, { featureId: c, dependsOnId: b }]);
  const validCommand = ['feature', 'dependencies', '--project', s.projectId, '--phase', 'phase-a', '--revision', String(phase.revision), '--input', input,
    '--command-id', randomUUID()];
  expect((await s.cli(validCommand)).exitCode).toBe(0);
  const beforeFailures = graphSnapshot(s);

  writeEdges(input, [{ featureId: a, dependsOnId: b }, { featureId: b, dependsOnId: a }]);
  expect((await s.cli(['feature', 'dependencies', '--project', s.projectId, '--phase', 'phase-a', '--revision', String(phase.revision + 1), '--input', input])).exitCode).toBe(1);
  expect(graphSnapshot(s)).toEqual(beforeFailures);

  writeEdges(input, [{ featureId: c, dependsOnId: randomUUID() }]);
  expect((await s.cli(['feature', 'dependencies', '--project', s.projectId, '--phase', 'phase-a', '--revision', String(phase.revision + 1), '--input', input])).exitCode).toBe(1);
  expect(graphSnapshot(s)).toEqual(beforeFailures);

  const other = completed(await s.client.submitCommand({
    operation: 'project.register', scope: { kind: 'registration' },
    payload: { repositoryPath: s.box.repoDirB, displayName: 'Other project' },
  }));
  const otherProjectId = (other.result as { project: { id: string } }).project.id;
  completed(await s.client.createPhase({ projectId: otherProjectId, id: 'other-phase', title: 'Other', description: null, labels: [] }));
  const otherFeature = await importFeature(otherProjectId, 'other-phase', 'Other');
  writeEdges(input, [{ featureId: c, dependsOnId: otherFeature }]);
  expect((await s.cli(['feature', 'dependencies', '--project', s.projectId, '--phase', 'phase-a', '--revision', String(phase.revision + 1), '--input', input])).exitCode).toBe(1);
  expect(graphSnapshot(s)).toEqual(beforeFailures);

  const stale = await s.cli(['feature', 'dependencies', '--project', s.projectId, '--phase', 'phase-a', '--revision', String(phase.revision), '--input', input]);
  expect(stale.exitCode).toBe(1);
  expect(stale.body?.error?.code).toBe('conflict');
  expect(graphSnapshot(s)).toEqual(beforeFailures);

  const arrangement = await s.box.openTransactionalHarness();
  try {
    arrangement.session.database.prepare(
      'INSERT INTO execution_batches (id, created_at, project_id, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run('batch-c', 1_900_000_000_001, s.projectId, 1_900_000_000_001, 'phase-a', c,
      JSON.stringify({ schemaVersion: 1, featureIds: [c] }), JSON.stringify({ schemaVersion: 1 }), 'queued', JSON.stringify({ schemaVersion: 1 }), 1_900_100_000_000);
  } finally {
    arrangement.close();
  }
  writeEdges(input, []);
  const activeBatch = await s.cli(['feature', 'dependencies', '--project', s.projectId, '--phase', 'phase-a', '--revision', String(phase.revision + 1), '--input', input]);
  expect(activeBatch.exitCode).toBe(1);
  expect(graphSnapshot(s)).toEqual(beforeFailures);

  const failed = await s.box.openTransactionalHarness();
  try {
    failed.session.database.prepare("UPDATE features SET status = 'failed' WHERE id = ?").run(a);
  } finally {
    failed.close();
  }
  expect((await s.client.getPhaseGraph(s.projectId, 'phase-a')).readiness.find(item => item.featureId === c)).toMatchObject({
    dependencyCompletion: 'failed', reason: 'dependency_failed', ready: false,
  });
  await s.restart();
  const afterRestart = await s.client.getPhaseGraph(s.projectId, 'phase-a');
  expect(afterRestart.dependencies.map(edge => [edge.featureId, edge.dependsOnId]).sort()).toEqual([[c, a], [c, b]].sort());
  writeEdges(input, [{ featureId: c, dependsOnId: a }, { featureId: c, dependsOnId: b }]);
  const replay = await s.cli(validCommand);
  expect(replay.exitCode, replay.stdout).toBe(0);
  expect(replay.body?.result?.replayed).toBe(true);
});

it('[case:phase-append-archive-retention] 活动 Batch 固定旧范围，追加 D 后关闭/重开/归档及重启查询保留源仓库、任务、Batch 和成果', async () => {
  const s = await setup();
  const a = await importFeature(s.projectId, 'phase-a', 'A');
  const b = await importFeature(s.projectId, 'phase-a', 'B');
  const c = await importFeature(s.projectId, 'phase-a', 'C');
  const phaseBeforeD = (await s.client.getPhase('phase-a')).phase;
  const arrangement = await s.box.openTransactionalHarness();
  try {
    arrangement.session.database.prepare("UPDATE features SET status = 'completed' WHERE id IN (?, ?)").run(a, b);
    arrangement.session.database.prepare(
      'INSERT INTO execution_batches (id, created_at, project_id, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run('batch-c', 1_900_000_000_002, s.projectId, 1_900_000_000_002, 'phase-a', c,
      JSON.stringify({ schemaVersion: 1, featureIds: [c] }), JSON.stringify({ schemaVersion: 1 }), 'queued', JSON.stringify({ schemaVersion: 1 }), 1_900_100_000_000);
  } finally {
    arrangement.close();
  }
  const d = await importFeature(s.projectId, 'phase-a', 'D');
  const appended = await s.client.getPhaseGraph(s.projectId, 'phase-a');
  expect(appended.features.map(feature => feature.id)).toEqual([a, b, c, d].sort());
  expect(appended.readiness.find(item => item.featureId === c)?.blockers).toContain('active_batch_scope');
  expect(appended.readiness.find(item => item.featureId === d)?.blockers).not.toContain('active_batch_scope');
  expect(appended.phase.revision).toBe(phaseBeforeD.revision);

  const blockedClose = await s.client.closePhase({ projectId: s.projectId, phaseId: 'phase-a', expectedRevision: appended.phase.revision });
  expect(blockedClose).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
  const finish = await s.box.openTransactionalHarness();
  try {
    finish.session.database.prepare("UPDATE execution_batches SET status = 'cancelled' WHERE id = 'batch-c'").run();
  } finally {
    finish.close();
  }
  let revision = appended.phase.revision;
  for (const [operation, status] of [['phase.close', 'closed'], ['phase.reopen', 'open'], ['phase.close', 'closed'], ['phase.archive', 'archived']] as const) {
    const result = await s.client.submitCommand({
      operation,
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: revision,
      payload: { phaseId: 'phase-a' },
    });
    expect(result).toMatchObject({ status: 'completed', result: { phase: { status } } });
    revision += 1;
  }
  const archived = await s.client.getPhaseGraph(s.projectId, 'phase-a');
  expect(archived.phase.status).toBe('archived');
  expect(new Set(archived.features.map(feature => feature.title))).toEqual(new Set(['A', 'B', 'C', 'D']));
  expect(readFileSync(join(s.box.repoDirA, 'README.md'), 'utf8')).toContain('项目 A');
  const probe = s.box.openProbe();
  try {
    expect(probe.selectAll('SELECT id FROM tasks ORDER BY id')).toHaveLength(4);
    expect(probe.selectAll('SELECT id, status FROM execution_batches')).toEqual([{ id: 'batch-c', status: 'cancelled' }]);
  } finally {
    probe.close();
  }

  await s.restart();
  expect((await s.client.getPhase('phase-a')).phase.status).toBe('archived');
  expect((await s.client.getPhaseGraph(s.projectId, 'phase-a')).features).toHaveLength(4);
});
