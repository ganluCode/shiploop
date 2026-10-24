import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import {
  connectToHost, startHost, validateAppQueryResponse, validateStateEventWire,
  createHostClientApplication, createHostLifecycleServer, createHostStopController, createIdleActivityGate,
  type HostClient,
} from '../../../packages/host/src/index.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { mapStateEvent } from '../../../packages/core/src/ports/events.ts';

let box: CommandsTestFixture;
const disposals: (() => Promise<unknown> | void)[] = [];
beforeAll(() => execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: resolve('.'), timeout: 60_000 }));
afterEach(async () => {
  for (const dispose of disposals.reverse()) await dispose();
  disposals.length = 0;
  box?.cleanup();
});
function completed(receipt: Awaited<ReturnType<HostClient['submitCommand']>>) {
  expect(receipt.status, JSON.stringify(receipt)).toBe('completed');
  if (receipt.status !== 'completed') throw new Error('expected completed');
  return receipt;
}
async function setup() {
  box = createCommandsTestFixture({ prefix: 'shiploop-p052-f007-' });
  const host = await startHost({ dataRoot: box.dataRoot, capabilityCatalog: box.capabilityCatalog, env: {} });
  disposals.push(() => host.close());
  const client = await connectToHost({ canonicalRoot: box.dataRoot });
  disposals.push(() => client.close());
  const token = readFileSync(join(box.dataRoot, 'host', 'auth.token'), 'utf8');
  const registered = completed(await client.submitCommand({ operation: 'project.register', scope: { kind: 'registration' },
    payload: { repositoryPath: box.repoDirA, displayName: 'Phase graph' } }));
  const projectId = (registered.result as { project: { id: string } }).project.id;
  completed(await client.submitCommand({ operation: 'settings.global.create', scope: { kind: 'global' },
    payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } } } }));
  for (const id of ['phase-a', 'phase-b']) completed(await client.createPhase({ projectId, id, title: id, description: 'original', labels: ['old'] }));
  const probe = box.openProbe();
  const snapshot = () => Object.fromEntries(['phases', 'features', 'feature_dependencies', 'execution_batches', 'runs', 'attempts', 'state_events'].map(table =>
    [table, probe.selectAll(`SELECT * FROM ${table} ORDER BY ${table === 'state_events' ? 'sequence' : 'id'}`)]));
  const cli = async (args: string[], json = true) => {
    let stdout = '', stderr = '';
    const result = await runAppCli({ args: [...args, '--data-root', box.dataRoot, ...(json ? ['--json'] : [])], env: {},
      io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } } });
    const envelope = json ? JSON.parse(stdout) : undefined;
    if (json) expect(stdout.trim().split('\n')).toHaveLength(1);
    return { ...result, stdout, stderr, body: envelope };
  };
  const feature = async (title: string) => {
    const phase = (await client.getPhase('phase-a')).phase;
    const result = completed(await client.importFeaturePlan({ projectId, phaseId: phase.id, expectedRevision: phase.revision,
      plan: { schemaVersion: 1, feature: { title, description: null, labels: [], sourceRefs: [] },
        tasks: [{ id: `task-${title}`, title: 'Task', complexity: 'low', acceptance: { criteria: ['criterion'] } }] } }));
    return (result.result as { feature: { id: string } }).feature.id;
  };
  return { client, host, token, projectId, probe, snapshot, cli, feature };
}

it('[case:lifecycle-cli-idempotency] CLI 修改/关闭/重开/归档经 Host 保留字段与历史，重试不重复修订', async () => {
  const s = await setup();
  const project = ['--project', s.projectId];
  const commandId = randomUUID();
  const args = ['phase', 'update', 'phase-a', ...project, '--revision', '1', '--title', '更新标题', '--command-id', commandId];
  const first = await s.cli(args);
  expect(first.exitCode, first.stdout).toBe(0);
  expect(first.body.result.result.phase).toMatchObject({ title: '更新标题', description: 'original', labels: ['old'], revision: 2 });
  const snapshot = s.snapshot();
  const replay = await s.cli(args);
  expect(replay.exitCode, replay.stdout).toBe(0);
  expect(replay.body.result).toEqual({ ...first.body.result, replayed: true });
  expect(s.snapshot()).toEqual(snapshot);
  const conflict = await s.cli([...args.slice(0, -2), '--command-id', commandId, '--description', 'changed']);
  expect(conflict.exitCode).toBe(1);
  expect(conflict.body.error.code).toBe('conflict');
  expect(s.snapshot()).toEqual(snapshot);
  const clear = await s.cli(['phase', 'update', 'phase-a', ...project, '--revision', '2', '--clear-description', '--clear-labels']);
  expect(clear.exitCode, clear.stdout).toBe(0);
  expect(clear.body.result.result.phase).toMatchObject({ title: '更新标题', description: null, labels: [] });
  const invalid = await s.cli(['phase', 'archive', 'phase-a', ...project, '--revision', '3']);
  expect(invalid.exitCode).toBe(1);
  let revision = 3;
  for (const [action, status] of [['close', 'closed'], ['reopen', 'open'], ['close', 'closed'], ['archive', 'archived']]) {
    const result = await s.cli(['phase', action!, 'phase-a', ...project, '--revision', String(revision++)]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.body.result.result.phase.status).toBe(status);
  }
  const events = s.probe.stateEvents().filter(row => row.event_type.startsWith('phase.') && row.event_type !== 'phase.created');
  expect(events).toHaveLength(6);
  for (const row of events) {
    const event = mapStateEvent({ id: row.id, sequence: row.sequence, projectId: row.project_id,
      eventType: row.event_type, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
      aggregateRevision: row.aggregate_revision, payload: JSON.parse(row.payload), occurredAtUtcMs: row.occurred_at } as never);
    expect(validateStateEventWire(event)).toEqual(event);
    expect(() => validateStateEventWire({ ...event, payload: { ...event.payload, approved: true } })).toThrow();
  }
  expect(readFileSync(join(box.repoDirA, 'README.md'), 'utf8')).toBeTruthy();
  expect(s.probe.selectAll('SELECT * FROM runs')).toEqual([]);
});

it('[case:dag-move-graph-cli] CLI 归属与整体 DAG 更新重放，分页图查询展示独立就绪轴且零副作用', async () => {
  const s = await setup();
  const a = await s.feature('A'), b = await s.feature('B'), c = await s.feature('C'), d = await s.feature('D');
  const p = ['--project', s.projectId];
  const phaseA = (await s.client.getPhase('phase-a')).phase;
  const phaseB = (await s.client.getPhase('phase-b')).phase;
  const moveId = randomUUID();
  const move = ['feature', 'move', d, ...p, '--revision', '1', '--from-phase', 'phase-a', '--to-phase', 'phase-b',
    '--source-revision', String(phaseA.revision), '--target-revision', String(phaseB.revision), '--command-id', moveId];
  expect((await s.cli(move)).exitCode).toBe(0);
  const afterMove = s.snapshot();
  expect((await s.cli(move)).body.result.replayed).toBe(true);
  expect(s.snapshot()).toEqual(afterMove);
  const input = join(box.root, 'edges.json');
  writeFileSync(input, JSON.stringify({ edges: [{ featureId: c, dependsOnId: a }, { featureId: c, dependsOnId: b }] }));
  const dagId = randomUUID();
  const update = ['feature', 'dependencies', ...p, '--phase', 'phase-a', '--revision', String(phaseA.revision + 1), '--input', input, '--command-id', dagId];
  completed(await s.client.updateFeatureDag({ projectId: s.projectId, phaseId: 'phase-a', expectedRevision: phaseA.revision + 1,
    edges: [{ featureId: c, dependsOnId: a }, { featureId: c, dependsOnId: b }], commandId: dagId }));
  const saved = await s.cli(update);
  expect(saved.exitCode, saved.stdout).toBe(0);
  const graphSnapshot = s.snapshot();
  expect((await s.cli(update)).body.result.replayed).toBe(true);
  const graph = await s.client.getPhaseGraph(s.projectId, 'phase-a');
  expect(graph.dependencies.map(edge => [edge.featureId, edge.dependsOnId]).sort()).toEqual([[c, a], [c, b]].sort());
  expect(graph.readiness.find(item => item.featureId === c)).toMatchObject({ dependencyCompleted: false, integrationReady: false,
    dependencyIntegrationReady: false, ready: false, blockers: ['plan_not_approved', 'dependency_pending', 'code_baseline_missing'] });
  const page = await s.cli(['phase', 'graph', 'phase-a', ...p, '--limit', '1']);
  expect(page.exitCode, page.stdout).toBe(0);
  expect(page.body.result.features).toHaveLength(1);
  expect(page.body.result.dependencies).toHaveLength(2);
  const next = await s.client.getPhaseGraph(s.projectId, 'phase-a', { limit: 1, cursor: page.body.result.nextCursor });
  expect(next.features[0]!.id).not.toBe(page.body.result.features[0].id);
  const human = await s.cli(['phase', 'graph', 'phase-a', ...p], false);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain('dependency=pending');
  expect(human.stdout).toContain('integration=false');
  expect(human.stdout).toContain('blockers=');
  await expect(s.client.getPhaseGraph(s.projectId, 'phase-b', { cursor: page.body.result.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(s.snapshot()).toEqual(graphSnapshot);
  writeFileSync(input, JSON.stringify({ edges: [{ featureId: a, dependsOnId: a }] }));
  expect((await s.cli(['feature', 'dependencies', ...p, '--phase', 'phase-a', '--revision', String(graph.phase.revision), '--input', input])).exitCode).toBe(1);
  expect(s.snapshot()).toEqual(graphSnapshot);
  const seed = await box.openTransactionalHarness();
  try {
    seed.session.database.prepare("UPDATE features SET status = 'completed' WHERE id IN (?, ?)").run(a, b);
  } finally { seed.close(); }
  const integrated = await s.client.getPhaseGraph(s.projectId, 'phase-a');
  expect(integrated.readiness.find(item => item.featureId === c)).toMatchObject({ dependencyCompleted: true,
    dependencyCompletion: 'complete', dependencyIntegrationReady: false, ready: false, reason: 'integration_not_ready' });
  for (const mutate of [
    (value: typeof graph) => ({ ...value, schemaVersion: 99 }),
    (value: typeof graph) => ({ ...value, model: 'forbidden' }),
    (value: typeof graph) => ({ ...value, phase: { ...value.phase, status: 'completed' } }),
    (value: typeof graph) => ({ ...value, dependencies: value.dependencies.map(edge => ({ ...edge, projectId: randomUUID() })) }),
    (value: typeof graph) => ({ ...value, readiness: value.readiness.map(item => ({ ...item, blockers: ['made_up'] })) }),
    (value: typeof graph) => ({ ...value, executableFeatureIds: [c] }),
  ]) expect(() => validateAppQueryResponse('phases.graph.get', mutate(graph))).toThrow();
});

it('[case:http-validation-scope] HTTP 拒绝认证、schema、未知字段、跨项目和伪造主体且零业务写入', async () => {
  const s = await setup();
  const envelope = { schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(), operation: 'phase.close',
    scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 1, payload: { phaseId: 'phase-a' } };
  const snapshot = s.snapshot();
  const post = (body: unknown, token: string | undefined = s.token) => loopbackRequest({ port: s.host.port, path: '/v1/commands', method: 'POST', body, token });
  for (const body of [{ ...envelope, schemaVersion: 99 }, { ...envelope, principalId: 'local-owner' },
    { ...envelope, payload: { phaseId: 'phase-a', approved: true } },
    { ...envelope, operation: 'feature.dag.update', payload: { phaseId: 'phase-a', edges: [{ featureId: 'x', dependsOnId: 'y', runtime: 'pi' }] } }]) {
    const response = await post(body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty('error.code');
  }
  expect((await post(envelope, 'invalid')).statusCode).toBe(401);
  const cross = await post({ ...envelope, scope: { kind: 'project', projectId: randomUUID() } });
  expect(cross.statusCode).toBe(403);
  for (const query of ['model=x', 'principal=local-owner', 'projectId=x', 'limit=0']) {
    const response = await loopbackRequest({ port: s.host.port, method: 'GET', path: `/v1/phases/phase-a/graph?projectId=${s.projectId}&${query}`, token: s.token });
    expect(response.statusCode).toBe(400);
  }
  expect((await loopbackRequest({ port: s.host.port, method: 'GET', path: `/v1/phases/phase-a/graph?projectId=${s.projectId}` })).statusCode).toBe(401);
  expect(s.snapshot()).toEqual(snapshot);
});

it('[case:restricted-project-authority] Host 可信受限主体不能越权查询或修改 Phase', async () => {
  box = createCommandsTestFixture({ prefix: 'shiploop-p052-f007-auth-' });
  const app = await box.openApplication();
  disposals.push(() => app.close());
  const principal = box.restrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [randomUUID()] } });
  const stop = createHostStopController({ activityGate: createIdleActivityGate(), getLifecycleState: () => 'ready', setLifecycleState: () => {}, prepareTeardown: async () => {}, releaseAfterTeardown: async () => {} });
  const token = randomUUID();
  const server = createHostLifecycleServer({ hostInstanceId: randomUUID(), dataRootIdentity: 'a'.repeat(64), startedAt: new Date().toISOString(), pid: process.pid,
    authToken: token, getLifecycleState: () => 'ready', getActivities: () => stop.getActivities(), stop,
    application: { principal, commandService: app.commandService, queryService: app.queryService,
      commandReceiptsService: app.commandReceiptsService, onboardingService: app.onboardingService,
      baselineQueryService: app.baselineQueryService, baselineExecutionService: app.baselineExecutionService,
      planningQueryService: app.planningQueryService, getLifecycleState: () => 'ready' } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  disposals.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const projectId = randomUUID();
  const before = box.openProbe().counts();
  const response = await loopbackRequest({ port: address.port, token, method: 'GET', path: `/v1/phases/phase-a/graph?projectId=${projectId}` });
  expect(response.statusCode).toBe(403);
  const write = await loopbackRequest({ port: address.port, token, method: 'POST', path: '/v1/commands',
    body: { schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(), operation: 'phase.close',
      scope: { kind: 'project', projectId }, expectedRevision: 1, payload: { phaseId: 'phase-a' } } });
  expect(write.statusCode).toBe(403);
  expect(box.openProbe().counts()).toEqual(before);
});

it('[case:disconnect-receipt-replay] 客户端丢弃响应后按同一命令身份找回回执，重复提交只写一次', async () => {
  const s = await setup();
  const envelope = { schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
    operation: 'phase.metadata.update', scope: { kind: 'project', projectId: s.projectId },
    expectedRevision: 1, payload: { phaseId: 'phase-a', title: 'response dropped' } };
  await new Promise<void>((resolveRequest, rejectRequest) => {
    const req = request({ hostname: '127.0.0.1', port: s.host.port, path: '/v1/commands', method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' } }, response => {
      response.destroy();
      if (response.statusCode === 200) resolveRequest();
      else rejectRequest(new Error(`unexpected HTTP status ${response.statusCode}`));
    });
    req.once('error', rejectRequest);
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.end(JSON.stringify(envelope));
  });
  const receipt = completed(await s.client.getReceipt(envelope.commandId));
  const before = s.snapshot();
  const replay = await s.client.updatePhaseMetadata({ projectId: s.projectId, phaseId: 'phase-a', title: 'response dropped', expectedRevision: 1 },
    { commandId: envelope.commandId, issuedAt: envelope.issuedAt });
  expect(replay).toEqual({ ...receipt, replayed: true });
  expect(s.snapshot()).toEqual(before);
  expect((await s.client.getPhase('phase-a')).phase.revision).toBe(2);
});

it('[case:graph-response-scope] HostClient 拒绝错误项目/阶段及未知响应版本，协议失败不重试查询', async () => {
  const s = await setup();
  const graph = await s.client.getPhaseGraph(s.projectId, 'phase-a');
  let body: unknown = graph;
  let queries = 0;
  const server = createServer((_request, response) => {
    queries++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  disposals.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const client = createHostClientApplication({ port: address.port, token: randomUUID(), connectMs: 500,
    appRequestMs: 1000, submitBudgetMs: 1000, assertOpen: () => {}, registerSubscription: () => {}, unregisterSubscription: () => {} });
  for (const phase of [{ ...graph.phase, projectId: randomUUID() }, { ...graph.phase, id: 'wrong-phase' }]) {
    body = { ...graph, phase };
    await expect(client.getPhaseGraph(s.projectId, 'phase-a')).rejects.toMatchObject({ code: 'response_malformed' });
  }
  body = { ...graph, schemaVersion: 999 };
  await expect(client.getPhaseGraph(s.projectId, 'phase-a')).rejects.toMatchObject({ code: 'unsupported_schema_version' });
  expect(queries).toBe(3);
});
