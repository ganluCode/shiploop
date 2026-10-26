import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRestrictedPrincipal, type TestTrustedPrincipal } from '../../helpers/p02-2/principals.ts';
import { validateBatchDeliveryResultWire } from '../../../packages/host/src/client/app-wire.ts';
import { hostCapabilitiesForDelivery, validateHandshakeResponse, CURRENT_PROTOCOL_VERSION, CURRENT_SCHEMA_VERSION } from '../../../packages/host/src/contract/index.ts';
import { createEventStreamHub } from '../../../packages/host/src/runtime/sse-transport.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createBatchLeafFinalizationService } from '../../../packages/core/src/application/batch-leaf-finalization.ts';
import { createPhaseDeliveryApprovalService } from '../../../packages/core/src/application/phase-delivery-approval.ts';
import { createSqliteBatchFinalizationCandidateStore } from '../../../packages/core/src/adapters/sqlite/batch-finalization-candidate-store.ts';
import { createSqlitePhaseDeliveryApprovalStore } from '../../../packages/core/src/adapters/sqlite/phase-delivery-approval-store.ts';
import type { BatchDeliveryDependencies } from '../../../packages/core/src/application/batch-delivery-commands.ts';
import { openBudgetFixture, NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { createHostClientApplication } from '../../../packages/host/src/client/app-client.ts';
import { createHostLifecycleServer, createHostStopController, createIdleActivityGate } from '../../../packages/host/src/index.ts';

function deliveryServices(fixture: Awaited<ReturnType<typeof openBudgetFixture>>, controls: { manualBlock?: boolean; conflict?: boolean; integrations: number; entered?: () => void; wait?: Promise<void> }) : BatchDeliveryDependencies {
  const candidates = createSqliteBatchFinalizationCandidateStore(fixture.session, { nowUtcMs: () => NOW });
  const approvals = createSqlitePhaseDeliveryApprovalStore(fixture.session, { nowUtcMs: () => NOW });
  let lastCommand = '';
  const finalization = createBatchLeafFinalizationService({
    batches: { read(projectId, batchId) {
      const batch = fixture.atomic.transact('test.batch', tx => tx.getExecutionBatch(projectId, batchId));
      return { schemaVersion: 1, projectId, phaseId: batch.phaseId, batchId, revision: batch.revision,
        status: batch.status as 'succeeded', approved: true, featureIds: batch.scopeSnapshot.featureIds as string[], dependencies: [], targetBaseline: 'b'.repeat(40),
        approvedInputs: [{ inputId: 'input-1', digest: 'a'.repeat(64) }], verificationScope: ['combined'], strategySummary: { mode: 'deterministic' } };
    } },
    leaves: { read: (_project, featureId) => ({ featureId, featureStatus: 'completed', deliveryStatus: 'succeeded', revision: 4,
      commitSha: 'a'.repeat(40), repoIdentity: 'repo-1', coveredInputs: [{ inputId: 'input-1', digest: 'a'.repeat(64) }],
      evidenceId: 'leaf-evidence', evidenceDigest: 'a'.repeat(64), evidenceFresh: true, commitExists: true, branchHead: 'a'.repeat(40) }) },
    candidates,
    integrate: async () => {
      controls.integrations++;
      controls.entered?.(); await controls.wait;
      return controls.conflict ? { status: 'blocked', commitSha: null, treeSha: null, evidenceId: 'conflict-evidence', evidenceDigest: 'c'.repeat(64), reason: 'integration_conflict', workspacePreserved: true }
        : { status: 'succeeded', commitSha: 'd'.repeat(40), treeSha: 'e'.repeat(40), evidenceId: 'integration-evidence', evidenceDigest: 'd'.repeat(64), workspacePreserved: true };
    },
    verify: async () => ({ status: 'passed', evidenceId: 'verification-evidence', evidenceDigest: 'e'.repeat(64) }),
  });
  return {
    finalization: { ...finalization, run(request) { lastCommand = request.commandId; return finalization.run(request); } },
    approval: createPhaseDeliveryApprovalService({ approvals, nowUtcMs: () => NOW,
      snapshots: { read(projectId, phaseId, batchId) {
        const candidate = candidates.read(projectId, batchId, lastCommand); if (!candidate) return null;
        const batch = fixture.atomic.transact('test.batch', tx => tx.getExecutionBatch(projectId, batchId));
        return { candidate, batch: { projectId, phaseId, batchId, revision: batch.revision, status: batch.status as 'succeeded', approved: true,
          scopeDigest: candidate.scopeDigest, inputDigest: candidate.inputDigest, budgetSummary: { maxRuns: 2 }, stopSummary: { status: 'not_required' },
          codeSummary: { commit: candidate.integration?.commitSha }, planSummary: { approved: true }, manualBlock: controls.manualBlock ?? false } };
      } },
    }),
  };
}

async function startParallelBatch(fixture: Awaited<ReturnType<typeof openBudgetFixture>>) {
  const phase = fixture.session.database.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-1') as { revision: number };
  const imported = await fixture.submit('feature.plan.import', { phaseId: 'phase-1', plan: { schemaVersion: 1,
    feature: { title: 'Second leaf', description: null, labels: [], sourceRefs: [] }, tasks: [{ id: 'second-task', title: 'Second', acceptance: { criteria: ['ok'] }, dependsOn: [] }] } }, { scope: fixture.scope, expectedRevision: phase.revision });
  if (imported.status !== 'completed') throw new Error('import failed');
  const feature = (imported.result as { feature: { id: string; revision: number; planDigest: string } }).feature;
  await fixture.submit('feature.plan.decide', { featureId: feature.id, planDigest: feature.planDigest, decision: 'approve', reason: 'test' }, { scope: fixture.scope, expectedRevision: feature.revision });
  const featureIds = [fixture.featureId, feature.id];
  const preview = await fixture.services.preview.previewExecution(fixture.projectId, { featureIds, budget: { ...fixture.budget } });
  const started = await fixture.submit('execution.start', { featureIds, budget: fixture.budget, previewDigest: preview.previewDigest }, { scope: fixture.scope });
  if (started.status !== 'accepted' || started.schemaVersion !== 6) throw new Error('start failed');
  return { batchId: started.batchId, featureIds };
}

async function openFixture(delivery?: (fixture: Awaited<ReturnType<typeof openBudgetFixture>>) => BatchDeliveryDependencies,
  principalFor?: (fixture: Awaited<ReturnType<typeof openBudgetFixture>>) => TestTrustedPrincipal) {
  const fixture = await openBudgetFixture();
  const app = await fixture.box.openApplication({ nowUtcMs: () => NOW });
  const stop = createHostStopController({ activityGate: createIdleActivityGate(), getLifecycleState: () => 'ready', setLifecycleState() {}, prepareTeardown: async () => {}, releaseAfterTeardown: async () => {} });
  const commands = delivery ? createCommandService({ atomicStore: fixture.atomic, batchDelivery: delivery(fixture), nowUtcMs: () => NOW }) : fixture.services.commands;
  const principal = principalFor?.(fixture) ?? fixture.owner;
  const hub = createEventStreamHub({ queryService: app.queryService, principal, getLifecycleState: () => 'ready', pollIntervalMs: 10, heartbeatIntervalMs: 60_000 });
  const hostInstanceId = randomUUID();
  const server = createHostLifecycleServer({
    hostInstanceId, dataRootIdentity: 'a'.repeat(64), startedAt: new Date(NOW).toISOString(), pid: process.pid,
    authToken: 'fixture-token', getLifecycleState: () => 'ready', getActivities: () => stop.getActivities(), stop,
    application: { principal, commandService: commands, queryService: app.queryService,
      commandReceiptsService: app.commandReceiptsService, onboardingService: app.onboardingService,
      baselineQueryService: app.baselineQueryService, baselineExecutionService: app.baselineExecutionService,
      planningQueryService: app.planningQueryService, eventStreams: hub, getLifecycleState: () => 'ready' },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing port');
  const client = createHostClientApplication({ port: address.port, token: 'fixture-token', connectMs: 1000, appRequestMs: 2000,
    submitBudgetMs: 5000, assertOpen() {}, registerSubscription() {}, unregisterSubscription() {} });
  return { fixture, app, client, commands, hostInstanceId, hub, port: address.port, async close() {
    await hub.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await app.close(); fixture.close();
  } };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('event barrier timed out')), 5000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

describe('P05-9 F-006 Batch delivery public protocol', () => {
  it('[case:batch-delivery-host-query] transports the fixed Batch identity, revision and bounded read-only delivery view', async () => {
    const s = await openFixture();
    try {
      const started = await s.fixture.start();
      const before = s.fixture.snapshot();
      const result = await s.client.getBatchDelivery(s.fixture.projectId, started.batchId, { limit: 1 });
      expect(result).toMatchObject({ schemaVersion: 5, scope: 'batch-delivery', limit: 1,
        batch: { id: started.batchId, projectId: s.fixture.projectId, phaseId: 'phase-1', revision: expect.any(Number), featureIds: [s.fixture.featureId] },
        records: [{ featureId: s.fixture.featureId }], nextCursor: null });
      expect(await s.client.observeBatch(s.fixture.projectId, started.batchId, { limit: 1 })).toMatchObject({ delivery: result,
        control: { batch: { batchId: started.batchId } }, blockingChain: [{ featureId: s.fixture.featureId }] });
      expect(s.fixture.snapshot()).toEqual(before);
    } finally { await s.close(); }
  });
  it('[case:batch-finalize-approve-receipts] finalizes and approves bound evidence, replays receipts and rejects stale revisions and manual holds', async () => {
    const controls = { integrations: 0, manualBlock: false };
    const s = await openFixture(fixture => deliveryServices(fixture, controls));
    const options = { issuedAt: new Date(NOW).toISOString() };
    try {
      const started = await startParallelBatch(s.fixture);
      s.fixture.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(started.batchId);
      const input = { projectId: s.fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, expectedRevision: 1, commandId: randomUUID() };
      const finished = await s.client.finalizeBatch(input, options);
      expect(finished, JSON.stringify(finished)).toMatchObject({ status: 'completed', result: { status: 'ready_for_phase_approval', batchRevision: 1, candidateRevision: 3,
        featureIds: expect.arrayContaining(started.featureIds), integrationEvidenceId: 'integration-evidence', verificationEvidenceId: 'verification-evidence' } });
      expect(controls.integrations).toBe(1);
      expect(await s.client.finalizeBatch(input, options)).toEqual({ ...finished, replayed: true });
      expect(await s.client.getReceipt(input.commandId)).toEqual(finished);
      const result = (finished as { result: { candidateId: string; candidateRevision: number } }).result;
      const approve = { ...input, commandId: randomUUID(), candidateId: result.candidateId, expectedCandidateRevision: result.candidateRevision };
      const stale = await s.client.approvePhaseDelivery({ ...approve, expectedCandidateRevision: 2 }, options);
      expect(stale).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'stale_revision' } } });
      controls.manualBlock = true;
      const held = await s.client.approvePhaseDelivery({ ...approve, commandId: randomUUID() }, options);
      expect(held).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'manual_block' } } });
      controls.manualBlock = false;
      const snapshot = await s.client.getSnapshot({ kind: 'project', projectId: s.fixture.projectId });
      const events: unknown[] = [];
      let deliveryResolve!: () => void; let metadataResolve!: () => void;
      const deliveryEvent = new Promise<void>(resolve => { deliveryResolve = resolve; });
      const metadataEvent = new Promise<void>(resolve => { metadataResolve = resolve; });
      const subscription = await s.client.subscribeEvents({ scope: { kind: 'project', projectId: s.fixture.projectId }, cursor: snapshot.watermark.cursor,
        onEvent(event) { events.push(event); if (event.type === 'phase.delivery.approved') deliveryResolve(); if (event.type === 'project.metadata_updated') metadataResolve(); } });
      const approvalInput = { ...approve, commandId: randomUUID() };
      let approved;
      try {
        approved = await s.client.approvePhaseDelivery(approvalInput, options);
        expect(await s.client.getReceipt(approvalInput.commandId)).toEqual(approved);
        expect(await s.client.approvePhaseDelivery(approvalInput, options)).toEqual({ ...approved, replayed: true });
        await within(deliveryEvent);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'phase.delivery.approved', payload: { deliveryUpdated: true } })]));
        await s.hub.closeAll();
        const project = await s.client.getProject(s.fixture.projectId);
        await s.fixture.submit('project.metadata.update', { displayName: 'reconnected' }, { scope: s.fixture.scope, expectedRevision: project.project.revision });
        await within(metadataEvent);
        const beforeClose = s.fixture.snapshot();
        subscription.close(); expect(await subscription.ended).toEqual({ kind: 'aborted' });
        expect(s.fixture.snapshot()).toEqual(beforeClose);
      } finally { subscription.close(); }
      expect(approved).toMatchObject({ status: 'completed', result: { status: 'approved', candidateId: result.candidateId, summaryDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      const staleBatch = await s.client.finalizeBatch({ ...input, commandId: randomUUID(), expectedRevision: 99 }, options);
      expect(staleBatch).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'stale_revision' } } });
      expect(controls.integrations).toBe(1);
      expect(JSON.stringify([finished, approved])).not.toMatch(/strategySummary|budgetSummary|codeSummary|actorId|\/Users\/|fixture-token/);
    } finally { await s.close(); }
  });

  it('[case:batch-delivery-wire-fail-closed] rejects unknown fields, versions, states, identities, evidence and invalid paging from a peer', async () => {
    const s = await openFixture();
    try {
      const started = await s.fixture.start();
      const value = await s.client.getBatchDelivery(s.fixture.projectId, started.batchId, { limit: 1 });
      const mutations: ((v: any) => void)[] = [
        v => { v.schemaVersion = 999; }, v => { v.scope = 'feature-delivery'; }, v => { v.token = 'private'; },
        v => { v.batch.projectId = 'different'; }, v => { v.batch.id = 'different'; }, v => { v.batch.phaseId = ''; },
        v => { v.batch.revision = 0; }, v => { v.batch.status = 'completed'; }, v => { v.batch.featureIds = []; },
        v => { v.records[0].featureId = 'outside'; }, v => { v.records.push(v.records[0]); },
        v => { v.records[0].status = 'passed'; }, v => { v.records[0].evidenceRefs = ['/Users/operator/private.txt']; },
        v => { v.records[0].delivery.feature.featureId = 'outside'; }, v => { v.records[0].delivery.feature.revision = -1; },
        v => { v.records[0].delivery.run.batchId = 'outside'; }, v => { v.records[0].runs[0].featureId = 'outside'; },
        v => { v.summary.in_progress = -1; }, v => { v.readyCount = 99; }, v => { v.nextCursor = 'raw-path'; },
        v => { v.limit = 201; }, v => { v.records[0].reason = 'Bearer synthetic-secret'; },
      ];
      const original = s.app.queryService.getBatchDelivery;
      try {
        for (const mutate of mutations) {
          const changed = structuredClone(value); mutate(changed);
          s.app.queryService.getBatchDelivery = async () => changed;
          const error = await s.client.getBatchDelivery(s.fixture.projectId, started.batchId, { limit: 1 }).catch(error => error);
          expect(['response_malformed', 'unsupported_schema_version']).toContain(error.code);
          expect(JSON.stringify(error)).not.toMatch(/synthetic-secret|operator\/private/);
        }
      } finally { s.app.queryService.getBatchDelivery = original; }
      expect(validateBatchDeliveryResultWire(value)).toEqual(value);
    } finally { await s.close(); }
  });

  it('[case:batch-query-auth-pagination] enforces authentication, scope, exact parameters and Batch-bound cursors', async () => {
    const s = await openFixture();
    try {
      const started = await startParallelBatch(s.fixture);
      const first = await s.client.getBatchDelivery(s.fixture.projectId, started.batchId, { limit: 1 });
      expect(first.records).toHaveLength(1); expect(first.nextCursor).toMatch(/^plcur_v1_/);
      const second = await s.client.getBatchDelivery(s.fixture.projectId, started.batchId, { limit: 1, cursor: first.nextCursor! });
      expect(second.records).toHaveLength(1); expect(second.records[0].featureId).not.toBe(first.records[0].featureId); expect(second.nextCursor).toBeNull();
      await expect(s.client.getBatchDelivery(s.fixture.projectId, randomUUID(), { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input' });
      const path = `http://127.0.0.1:${s.port}/v1/batches/${started.batchId}/delivery?projectId=${s.fixture.projectId}`;
      for (const [suffix, authenticated, status] of [['', false, 401], ['&projectId=other', true, 400], ['&scope=global', true, 400], ['&limit=0', true, 400], ['&limit=201', true, 400], ['&path=/tmp/private', true, 400]] as const) {
        const response = await fetch(path + suffix, { headers: authenticated ? { Authorization: 'Bearer fixture-token' } : {} });
        expect(response.status).toBe(status); expect(await response.text()).not.toMatch(/fixture-token|\/tmp\/private/);
      }
      const registered = await s.fixture.submit('project.register', { repositoryPath: s.fixture.box.repoDirB, displayName: 'Other', description: null, labels: [] }, { scope: { kind: 'registration' } });
      if (registered.status !== 'completed') throw new Error('registration failed');
      const other = (registered.result as { project: { id: string } }).project.id;
      const foreign = await s.client.getBatchDelivery(other, started.batchId).catch(error => error);
      const missing = await s.client.getBatchDelivery(other, randomUUID()).catch(error => error);
      expect(foreign).toMatchObject({ code: 'not_found' }); expect(foreign.details).toEqual(missing.details);
      s.fixture.session.database.prepare("UPDATE runs SET reason = ? WHERE batch_id = ?").run('Bearer synthetic-private', started.batchId);
      await expect(s.client.getBatchDelivery(s.fixture.projectId, started.batchId)).rejects.toMatchObject({ code: 'corrupt_state' });
    } finally { await s.close(); }
  });

  it('[case:batch-capability-handshake] advertises only assembled Batch capabilities and refuses partial capability pairs', () => {
    const base = { schemaVersion: CURRENT_SCHEMA_VERSION, protocolVersion: CURRENT_PROTOCOL_VERSION, hostInstanceId: randomUUID(), dataRootIdentity: 'a'.repeat(64), lifecycleState: 'ready', startedAt: new Date(NOW).toISOString() };
    const expectation = { expectedHostInstanceId: base.hostInstanceId, expectedDataRootIdentity: base.dataRootIdentity };
    const absent = hostCapabilitiesForDelivery(false);
    expect(absent.application.commands).not.toContain('execution.batch.finalize'); expect(absent.application.queries).not.toContain('execution.batch.delivery.get');
    const capabilities = hostCapabilitiesForDelivery(false, true, true);
    expect(validateHandshakeResponse({ ...base, capabilities }, expectation)).toMatchObject({ capabilities });
    for (const mutate of [
      (v: any) => { v.application.commands = v.application.commands.filter((c: string) => c !== 'phase.delivery.approve'); },
      (v: any) => { v.application.queries = v.application.queries.filter((q: string) => q !== 'execution.batch.delivery.get'); },
      (v: any) => { v.application.queries.push('batch.arbitrary'); },
      (v: any) => { v.application.events.scopes = ['global']; },
      (v: any) => { v.application.events.route = '/wrong'; },
    ]) {
      const changed = structuredClone(capabilities); mutate(changed);
      expect(() => validateHandshakeResponse({ ...base, capabilities: changed }, expectation)).toThrow();
    }
  });

  it('[case:batch-capability-actual-assembly] derives handshake and routing from actual query assembly rather than method presence', async () => {
    const s = await openFixture();
    try {
      const handshake = async () => {
        const response = await fetch(`http://127.0.0.1:${s.port}/v1/host/handshake`, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 5, protocolVersion: 1, hostInstanceId: s.hostInstanceId, dataRootIdentity: 'a'.repeat(64) }) });
        expect(response.status).toBe(200); return response.json() as Promise<any>;
      };
      const assembled = await handshake();
      expect(assembled.capabilities.application.queries).toContain('execution.batch.delivery.get');
      expect(assembled.capabilities.application.commands).not.toContain('execution.batch.finalize');
      Object.defineProperty(s.app.queryService, 'batchDeliveryAvailable', { value: false });
      const absent = await handshake();
      expect(absent.capabilities.application.queries).not.toContain('execution.batch.delivery.get');
      await expect(s.client.getBatchDelivery(s.fixture.projectId, randomUUID())).rejects.toMatchObject({ code: 'unsupported' });
      expect(JSON.stringify([assembled, absent])).not.toMatch(/fixture-token|Bearer|\/Users\//);
    } finally { await s.close(); }
  });

  it('[case:batch-authorization-denied] refuses insufficient capability and invisible projects before invoking delivery', async () => {
    const controls = { integrations: 0 };
    const s = await openFixture(fixture => deliveryServices(fixture, controls), fixture => createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'allowlist', projectIds: [fixture.projectId] } }));
    try {
      const started = await s.fixture.start();
      const input = { projectId: s.fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, expectedRevision: 1 };
      await expect(s.client.finalizeBatch(input, { issuedAt: new Date(NOW).toISOString() })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(s.client.approvePhaseDelivery({ ...input, candidateId: 'candidate-1', expectedCandidateRevision: 3 }, { issuedAt: new Date(NOW).toISOString() })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(s.client.getBatchDelivery(randomUUID(), started.batchId)).rejects.toMatchObject({ code: 'forbidden' });
      expect(controls.integrations).toBe(0);
    } finally { await s.close(); }
  });

  it('[case:batch-delivery-stop-and-late-result] waits for in-flight delivery, deduplicates replay and rejects a result after Batch revision drift', async () => {
    let entered!: () => void; let release!: () => void;
    const barrier = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const controls = { integrations: 0, entered, wait };
    const s = await openFixture(fixture => deliveryServices(fixture, controls));
    try {
      const started = await startParallelBatch(s.fixture);
      s.fixture.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(started.batchId);
      const input = { projectId: s.fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, expectedRevision: 1, commandId: randomUUID() };
      const options = { issuedAt: new Date(NOW).toISOString() };
      const first = s.client.finalizeBatch(input, options);
      await within(barrier);
      const repeated = s.client.finalizeBatch(input, options);
      const activity = s.commands.deliveryActivity!;
      expect(activity.enterQuiesce()).toEqual({ accepted: 1 });
      expect(await activity.awaitQuiesce(0)).toEqual({ confirmed: false, pending: ['batch_delivery_in_progress'] });
      await expect(s.client.finalizeBatch({ ...input, commandId: randomUUID() }, options)).rejects.toMatchObject({ code: 'resource_busy' });
      s.fixture.session.database.prepare('UPDATE execution_batches SET revision = revision + 1 WHERE id = ?').run(started.batchId);
      release();
      for (const receipt of await Promise.all([first, repeated])) expect(receipt).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'stale_revision' } } });
      expect(controls.integrations).toBe(1);
      expect(await activity.awaitQuiesce(100)).toEqual({ confirmed: true, pending: [] });
      expect(s.fixture.session.database.prepare('SELECT workspace_preserved FROM phase_delivery_candidates WHERE batch_id = ?').get(started.batchId)).toMatchObject({ workspace_preserved: 1 });
    } finally { release(); await s.close(); }
  });

  it('[case:batch-command-response-binding] rejects a peer returning wrong identities, revisions, digests, evidence or state in completed receipts', async () => {
    const controls = { integrations: 0 };
    const s = await openFixture(fixture => deliveryServices(fixture, controls));
    try {
      const started = await startParallelBatch(s.fixture);
      s.fixture.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(started.batchId);
      const input = { projectId: s.fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, expectedRevision: 1, commandId: randomUUID() };
      const options = { issuedAt: new Date(NOW).toISOString() };
      const valid = await s.client.finalizeBatch(input, options);
      expect(valid.status).toBe('completed');
      const submit = s.commands.submit;
      try {
        for (const mutate of [
          (v: any) => { v.projectId = 'different'; }, (v: any) => { v.phaseId = 'different'; }, (v: any) => { v.batchId = 'different'; },
          (v: any) => { v.batchRevision = 2; }, (v: any) => { v.candidateRevision = 0; }, (v: any) => { v.inputDigest = 'not-a-digest'; },
          (v: any) => { v.integrationEvidenceId = '/Users/private'; }, (v: any) => { v.status = 'passed'; }, (v: any) => { v.body = 'private'; },
        ]) {
          const changed = structuredClone(valid) as any; mutate(changed.result);
          s.commands.submit = async () => changed;
          await expect(s.client.finalizeBatch(input, options)).rejects.toMatchObject({ code: 'response_malformed' });
        }
      } finally { s.commands.submit = submit; }
      expect(controls.integrations).toBe(1);
    } finally { await s.close(); }
  });

  it('[case:batch-stable-errors] distinguishes stale previews, exhausted budgets and integration conflicts without accepting them', async () => {
    const s = await openFixture();
    const options = { issuedAt: new Date(NOW).toISOString() };
    try {
      const stale = await s.client.startExecution({ projectId: s.fixture.projectId, featureIds: [s.fixture.featureId], budget: s.fixture.budget, previewDigest: 'f'.repeat(64) }, options);
      expect(stale).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'preview_stale' } } });
      const started = await startParallelBatch(s.fixture);
      s.fixture.session.database.prepare("UPDATE runs SET status = 'failed' WHERE batch_id = ?").run(started.batchId);
      const exhausted = await s.client.startExecution({ projectId: s.fixture.projectId, featureIds: started.featureIds, retryBatchId: started.batchId }, options);
      expect(exhausted).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'budget_exhausted' } } });
    } finally { await s.close(); }
    const controls = { integrations: 0, conflict: true };
    const conflicting = await openFixture(fixture => deliveryServices(fixture, controls));
    try {
      const started = await startParallelBatch(conflicting.fixture);
      conflicting.fixture.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(started.batchId);
      const receipt = await conflicting.client.finalizeBatch({ projectId: conflicting.fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, expectedRevision: 1 }, options);
      expect(receipt).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'integration_conflict' } } });
      expect(controls.integrations).toBe(1);
    } finally { await conflicting.close(); }
  });

  it('[case:batch-command-input-boundaries] rejects forged authority, wrong scope, foreign identity and command reuse before effects', async () => {
    const controls = { integrations: 0 };
    const s = await openFixture(fixture => deliveryServices(fixture, controls));
    const options = { issuedAt: new Date(NOW).toISOString() };
    try {
      const started = await s.fixture.start();
      const input = { projectId: s.fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, expectedRevision: 1, commandId: randomUUID() };
      for (const extra of [{ actorId: 'owner' }, { status: 'approved' }, { expectedRevision: 0 }]) {
        await expect(s.client.finalizeBatch({ ...input, ...extra } as any, options)).rejects.toMatchObject({ code: 'invalid_input' });
      }
      const foreign = await s.client.finalizeBatch({ ...input, batchId: randomUUID(), commandId: randomUUID() }, options);
      expect(foreign).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
      const mismatch = await s.client.finalizeBatch({ ...input, phaseId: 'other-phase' }, options);
      expect(mismatch).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
      await expect(s.client.finalizeBatch(input, options)).rejects.toMatchObject({ code: 'conflict' });
      for (const [scope, payload] of [[{ kind: 'global' }, { phaseId: 'phase-1', batchId: started.batchId }],
        [s.fixture.scope, { phaseId: 'phase-1', batchId: started.batchId, actorId: 'owner' }]] as const) {
        const response = await fetch(`http://127.0.0.1:${s.port}/v1/commands`, { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
          body: JSON.stringify(s.fixture.envelope('execution.batch.finalize', payload, { scope, expectedRevision: 1 })) });
        expect(response.status).toBe(400); expect(await response.text()).not.toContain('fixture-token');
      }
      expect(controls.integrations).toBe(0);
    } finally { await s.close(); }
  });

  it('[case:batch-delivery-commands-unavailable] refuses unassembled finalization and approval instead of claiming success', async () => {
    const s = await openFixture();
    try {
      const started = await s.fixture.start();
      const input = { projectId: s.fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, expectedRevision: 1 };
      await expect(s.client.finalizeBatch(input, { issuedAt: new Date(NOW).toISOString() })).rejects.toMatchObject({ code: 'unsupported' });
      await expect(s.client.approvePhaseDelivery({ ...input, candidateId: 'candidate-1', expectedCandidateRevision: 3 }, { issuedAt: new Date(NOW).toISOString() })).rejects.toMatchObject({ code: 'unsupported' });
    } finally { await s.close(); }
  });
});
