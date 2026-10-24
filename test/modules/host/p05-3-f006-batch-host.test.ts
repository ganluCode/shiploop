import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openBudgetFixture, NOW, BUDGET } from '../../helpers/p03-3/budget-fixture.ts';
import { createRestrictedPrincipal, type TestTrustedPrincipal } from '../../helpers/p02-2/principals.ts';
import { createHostClientApplication } from '../../../packages/host/src/client/app-client.ts';
import { validateExecutionBudgetStatusResultWire, validateExecutionPreviewResultWire } from '../../../packages/host/src/client/app-wire.ts';
import { createHostLifecycleServer, createHostStopController, createIdleActivityGate } from '../../../packages/host/src/index.ts';

async function openFixture(principalFor?: (fixture: Awaited<ReturnType<typeof openBudgetFixture>>) => TestTrustedPrincipal) {
  const fixture = await openBudgetFixture({ ...BUDGET, batch: { ...BUDGET.batch, maxRuns: 4, maxTotalAttempts: 4, maxRuntimeStarts: 4 } });
  const app = await fixture.box.openApplication({ nowUtcMs: () => NOW });
  const stop = createHostStopController({ activityGate: createIdleActivityGate(), getLifecycleState: () => 'ready', setLifecycleState() {}, prepareTeardown: async () => {}, releaseAfterTeardown: async () => {} });
  const server = createHostLifecycleServer({
    hostInstanceId: randomUUID(), dataRootIdentity: 'a'.repeat(64), startedAt: new Date(NOW).toISOString(), pid: process.pid,
    authToken: 'fixture-token', getLifecycleState: () => 'ready', getActivities: () => stop.getActivities(), stop,
    application: { principal: principalFor?.(fixture) ?? fixture.owner, commandService: fixture.services.commands, queryService: app.queryService,
      commandReceiptsService: app.commandReceiptsService, onboardingService: app.onboardingService,
      baselineQueryService: app.baselineQueryService, baselineExecutionService: app.baselineExecutionService,
      planningQueryService: app.planningQueryService, getLifecycleState: () => 'ready' },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing port');
  const client = createHostClientApplication({ port: address.port, token: 'fixture-token', connectMs: 1000, appRequestMs: 2000,
    submitBudgetMs: 5000, assertOpen() {}, registerSubscription() {}, unregisterSubscription() {} });
  return { fixture, client, app, port: address.port, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await app.close(); fixture.close();
  } };
}

async function addFeature(fixture: Awaited<ReturnType<typeof openBudgetFixture>>, title: string) {
  const phase = fixture.session.database.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-1') as { revision: number };
  const imported = await fixture.submit('feature.plan.import', { phaseId: 'phase-1', plan: { schemaVersion: 1,
    feature: { title, description: null, labels: [], sourceRefs: [] },
    tasks: [{ id: `${title}-task`, title, acceptance: { criteria: ['ok'] }, dependsOn: [] }] } }, { scope: fixture.scope, expectedRevision: phase.revision });
  if (imported.status !== 'completed') throw new Error('import failed');
  const feature = (imported.result as { feature: { id: string; revision: number; planDigest: string } }).feature;
  const approved = await fixture.submit('feature.plan.decide', { featureId: feature.id, planDigest: feature.planDigest, decision: 'approve', reason: 'fixture' }, { scope: fixture.scope, expectedRevision: feature.revision });
  if (approved.status !== 'completed') throw new Error('approve failed');
  return feature.id;
}

const options = { issuedAt: new Date(NOW).toISOString() };

describe('P05-3 F-006 Batch Host contract', () => {
  it('[case:fixed-batch-receipt-query] preserves every initial Run on replay and queries only the frozen members', async () => {
    const s = await openFixture();
    try {
      const second = await addFeature(s.fixture, 'second');
      const ids = [s.fixture.featureId, second];
      const preview = await s.fixture.services.preview.previewExecution(s.fixture.projectId, { featureIds: ids, budget: { ...s.fixture.budget } });
      const commandId = randomUUID();
      const started = await s.client.startExecution({ projectId: s.fixture.projectId, featureIds: ids, budget: s.fixture.budget, previewDigest: preview.previewDigest!, commandId }, options);
      expect(started).toMatchObject({ status: 'accepted', runIds: expect.any(Array) });
      if (started.status !== 'accepted' || started.schemaVersion !== 6) throw new Error('missing start');
      expect(started.runIds).toHaveLength(2);
      expect(await s.client.getReceipt(commandId)).toEqual(started);
      const replay = await s.client.startExecution({ projectId: s.fixture.projectId, featureIds: ids, budget: s.fixture.budget, previewDigest: preview.previewDigest!, commandId }, options);
      expect(replay).toEqual({ ...started, replayed: true });
      await addFeature(s.fixture, 'later');
      const budget = await s.client.getExecutionBudgetStatus(s.fixture.projectId, started.batchId);
      expect(budget.batch.featureIds).toEqual(expect.arrayContaining(ids));
      expect(budget.batch.featureIds).toHaveLength(2);
      expect(budget.batch.deadlineAtUtcMs).toBe(s.fixture.budget.batch.deadlineUtcMs);
      expect(budget.batch.dimensions.maxRuns.used).toBe(2);
      expect(budget.batch.runtimeStartsReserved).toBe(0);
      expect(budget.runs.map(run => run.id).sort()).toEqual([...started.runIds!].sort());
      expect(budget.tasks.map(task => task.taskId).sort()).toEqual(['second-task', 't-1']);
      expect(budget.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ featureId: second })]));
      for (const mutate of [
        (value: any) => { value.batch.featureIds = [ids[0], ids[0]]; },
        (value: any) => { value.batch.featureIds = []; },
        (value: any) => { value.runs[0].featureId = 'outside'; },
        (value: any) => { value.runs.push(value.runs[0]); },
        (value: any) => { delete value.tasks[0].featureId; },
        (value: any) => { value.tasks[0].featureId = 'outside'; },
        (value: any) => { value.tasks.push(value.tasks[0]); },
      ]) {
        const malformed = structuredClone(budget); mutate(malformed);
        expect(() => validateExecutionBudgetStatusResultWire(malformed)).toThrow();
      }
      const control = await s.client.getBatchControl(s.fixture.projectId, started.batchId);
      expect(control.batch).toMatchObject({ featureIds: expect.arrayContaining(ids), phaseId: 'phase-1', counters: { runsCreated: 2 } });
      const before = s.fixture.snapshot();
      expect(await s.client.getExecutionBudgetStatus(s.fixture.projectId, started.batchId)).toEqual(budget);
      expect(s.fixture.snapshot()).toEqual(before);
      s.fixture.session.database.prepare("UPDATE runs SET status = 'failed' WHERE batch_id = ?").run(started.batchId);
      const retried = await s.client.startExecution({ projectId: s.fixture.projectId, featureIds: ids, retryBatchId: started.batchId }, options);
      expect(retried).toMatchObject({ status: 'completed', result: { runIds: expect.any(Array), batchId: started.batchId, runsCreated: 4 } });
      expect(await s.client.getReceipt(commandId)).toEqual(started);
      const afterRetry = await s.client.getExecutionBudgetStatus(s.fixture.projectId, started.batchId);
      expect(afterRetry.batch.featureIds).toEqual(budget.batch.featureIds);
      expect(afterRetry.batch.dimensions.maxRuns.used).toBe(4);
      expect(afterRetry.batch.deadlineAtUtcMs).toBe(budget.batch.deadlineAtUtcMs);
      expect(afterRetry.runs).toHaveLength(4);
      expect(afterRetry.tasks.map(task => task.taskId).sort()).toEqual(['second-task', 't-1']);
      const registered = await s.fixture.submit('project.register', { repositoryPath: s.fixture.box.repoDirB, displayName: 'B', description: null, labels: [] }, { scope: { kind: 'registration' } });
      if (registered.status !== 'completed') throw new Error('missing project');
      const otherProject = (registered.result as { project: { id: string } }).project.id;
      const errors = [];
      for (const batchId of [started.batchId, randomUUID()]) errors.push(await s.client.getExecutionBudgetStatus(otherProject, batchId).catch(error => error));
      expect(errors[0]).toMatchObject({ code: 'not_found' });
      expect(errors[0].message).toBe(errors[1].message);
      expect(errors[0].details).toEqual(errors[1].details);
    } finally { await s.close(); }
  });

  it('[case:batch-boundary-errors] rejects mixed/unknown selectors, bad budgets, foreign identities and changed command content without side effects', async () => {
    const s = await openFixture();
    try {
      const before = s.fixture.snapshot();
      for (const input of [
        { phaseId: 'phase-1', featureIds: [s.fixture.featureId] },
        { featureIds: [s.fixture.featureId, s.fixture.featureId] },
        { featureIds: Array.from({ length: 17 }, (_, i) => `feature-${i}`) },
        { featureIds: [s.fixture.featureId], expectedRevision: 1 },
        { phaseId: 'phase-1', actorId: 'owner' },
      ]) await expect(s.client.previewExecution({ projectId: s.fixture.projectId, budget: s.fixture.budget, ...input } as any, options)).rejects.toMatchObject({ code: 'invalid_input' });
      for (const payload of [
        { phaseId: 'phase-1', featureIds: [s.fixture.featureId], budget: s.fixture.budget },
        { featureIds: [s.fixture.featureId], budget: s.fixture.budget, principalId: 'owner' },
      ]) {
        const response = await fetch(`http://127.0.0.1:${s.port}/v1/commands`, { method: 'POST',
          headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
          body: JSON.stringify(s.fixture.envelope('execution.preview', payload, { scope: s.fixture.scope })) });
        expect(response.status).toBe(400);
        await response.text();
      }
      const invalidBudget = { ...s.fixture.budget, batch: { ...s.fixture.budget.batch, maxRuns: -1 } };
      await expect(s.client.previewExecution({ projectId: s.fixture.projectId, phaseId: 'phase-1', budget: invalidBudget }, options)).rejects.toMatchObject({ code: 'invalid_input' });
      expect(s.fixture.snapshot()).toEqual(before);
      const id = randomUUID();
      await s.client.previewExecution({ projectId: s.fixture.projectId, featureIds: [s.fixture.featureId], budget: s.fixture.budget, commandId: id }, options);
      await expect(s.client.previewExecution({ projectId: s.fixture.projectId, featureIds: [], budget: s.fixture.budget, commandId: id }, options)).rejects.toMatchObject({ code: 'conflict' });
      const stale = await s.client.startExecution({ projectId: s.fixture.projectId, featureIds: [s.fixture.featureId], budget: s.fixture.budget, previewDigest: 'f'.repeat(64) }, options);
      expect(stale).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'preview_stale' } } });
      await expect(s.client.previewExecution({ projectId: randomUUID(), featureIds: [s.fixture.featureId], budget: s.fixture.budget }, options)).rejects.toMatchObject({ code: 'forbidden' });
    } finally { await s.close(); }
  });

  it('[case:query-authorization-pagination] preserves capability checks, invisible-project folding and budget pagination boundaries', async () => {
    const s = await openFixture(fixture => createRestrictedPrincipal({ capabilities: ['execution.start', 'project.read'], projectScope: { kind: 'allowlist', projectIds: [fixture.projectId] } }));
    try {
      const initial = await s.fixture.start();
      const page = await s.client.listBatchBudgetRevisions(s.fixture.projectId, initial.batchId, { limit: 1 });
      expect(page).toMatchObject({ limit: 1, records: [expect.objectContaining({ version: 1 })], nextCursor: null });
      for (const limit of [0, -1, 1001]) await expect(s.client.listBatchBudgetRevisions(s.fixture.projectId, initial.batchId, { limit })).rejects.toMatchObject({ code: 'invalid_input' });
      const invisible = randomUUID();
      const errors = [];
      for (const batchId of [initial.batchId, randomUUID()]) errors.push(await s.client.getExecutionBudgetStatus(invisible, batchId).catch(error => error));
      const baseUrl = `http://127.0.0.1:${s.port}/v1/batches/${initial.batchId}/budget?projectId=${s.fixture.projectId}`;
      const unauthenticated = await fetch(baseUrl);
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.text();
      for (const extra of ['&unknown=true', '&projectId=other', '&limit=1']) {
        const response = await fetch(`${baseUrl}${extra}`, { headers: { Authorization: 'Bearer fixture-token' } });
        expect(response.status).toBe(400);
        await response.text();
      }
      expect(errors[0]).toMatchObject({ code: 'forbidden' });
      expect(errors[0].details).toEqual(errors[1].details);
    } finally { await s.close(); }
    const denied = await openFixture(fixture => createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [fixture.projectId] } }));
    try {
      await expect(denied.client.previewExecution({ projectId: denied.fixture.projectId, phaseId: 'phase-1', budget: denied.fixture.budget }, options)).rejects.toMatchObject({ code: 'forbidden' });
    } finally { await denied.close(); }
  });

  it('[case:phase-preview] transports Phase selector and the complete multi-member preview', async () => {
    const s = await openFixture();
    try {
      const second = await addFeature(s.fixture, 'second');
      const receipt = await s.client.previewExecution({ projectId: s.fixture.projectId, phaseId: 'phase-1', budget: s.fixture.budget }, options);
      expect(receipt.status).toBe('completed');
      if (receipt.status !== 'completed') throw new Error('missing preview');
      expect(validateExecutionPreviewResultWire(receipt.result)).toMatchObject({ status: 'ready', scope: {
        phaseId: 'phase-1', memberFeatureIds: expect.arrayContaining([s.fixture.featureId, second]), phaseRevision: expect.any(Number),
      }, summary: { members: expect.any(Array), tasks: expect.arrayContaining([expect.objectContaining({ featureId: second })]) } });
    } finally { await s.close(); }
  });
});
