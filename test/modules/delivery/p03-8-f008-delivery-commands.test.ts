import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHost, connectToHost, type RunningHost } from '../../../packages/host/src/index.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { validateCommandEnvelope } from '../../../packages/core/src/ports/commands.ts';
import { openBudgetFixture, NOW, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import type { FeatureDeliveryDependencies } from '../../../packages/core/src/application/feature-delivery-commands.ts';
import { hostCapabilitiesForDelivery, validateHandshakeResponse } from '../../../packages/host/src/contract/index.ts';

const CODE = 'ab'.repeat(32);

const operations = ['feature.verification.continue', 'git.operation.reconcile'] as const;
const boxes: BudgetFixture[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const box of boxes.splice(0)) box.close();
});

function envelope(projectId: string, featureId: string, runId: string, batchId: string, operationId: string, operation: string = operations[0]) {
  return { schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(),
    operation, scope: { kind: 'project', projectId }, expectedRevision: 1,
    payload: { featureId, runId, batchId, operationId } };
}

async function fixture() {
  const box = await openBudgetFixture(); boxes.push(box);
  const ids = await box.start();
  const db = box.session.database;
  db.prepare("UPDATE tasks SET status = 'passed', revision = revision + 1 WHERE id = ?").run(ids.taskId);
  db.prepare("UPDATE features SET status = 'running', revision = revision + 1 WHERE id = ?").run(box.featureId);
  db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
  db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
  const operationId = randomUUID();
  const input = envelope(box.projectId, box.featureId, ids.runId, ids.batchId, operationId);
  const revision = () => (db.prepare('SELECT revision FROM features WHERE id = ?').get(box.featureId) as { revision: number }).revision;
  input.expectedRevision = revision();
  const intent = () => ({ projectId: box.projectId, featureId: box.featureId, runId: ids.runId, operationId, codeDigest: CODE });
  const register = () => box.services.atomic.transact('f008.intent', transaction => {
    const binding = db.prepare('SELECT id, repo_identity FROM repository_bindings WHERE project_id = ?').get(box.projectId) as { id: string; repo_identity: string };
    return transaction.registerGitOperation({
      ...intent(), attemptId: null, executionVersion: 1, operationType: 'feature_final_commit',
      repositoryBindingId: binding.id, repoIdentity: binding.repo_identity, worktreePath: box.box.repoDirA,
      expectedHead: box.box.gitHead('A'), candidateTree: 'b'.repeat(40),
      verificationRefs: [{ kind: 'verification_batch', id: 'full-check', digest: CODE }], approvalRefs: [],
      message: 'delivery', gitIdentity: { name: 'Configured Git User', email: 'git@example.test', confirmed: true },
      deliveryPolicyDigest: 'cd'.repeat(32), runtimeSource: null, ownerId: 'core-owner', hostInstanceId: 'host',
      expectedFeatureRevision: revision(),
    }).operation;
  });
  const readOperation = () => box.services.atomic.transact('f008.read', t => t.getGitOperation(box.projectId, operationId));
  const commit = vi.fn(async () => {
    register();
    return box.services.atomic.transact('f008.commit', t => t.finalizeGitOperation({
      projectId: box.projectId, operationId, expectedRevision: 1, status: 'succeeded',
      actualCommit: 'c'.repeat(40), actualTree: 'b'.repeat(40), exitCode: 0, durationMs: 1,
      reasonCode: null, deliveryStatus: 'succeeded', settledAtUtcMs: NOW,
    }).operation);
  });
  const reconcile = vi.fn(async () => ({ outcome: 'not_executed' as const, reasonCode: 'commit_not_observed', operation: readOperation() }));
  const verify = vi.fn(async () => ({ passed: true, reason: 'full_verification_passed' }));
  const dependencies: FeatureDeliveryDependencies = { readIntent: intent, verify, commit: { commit }, reconciliation: { reconcile } };
  const service = () => createCommandService({ atomicStore: box.services.atomic, featureDelivery: dependencies, nowUtcMs: () => NOW });
  async function approval() {
    const planDigest = (db.prepare('SELECT plan_digest FROM features WHERE id = ?').get(box.featureId) as { plan_digest: string }).plan_digest;
    const item = box.services.atomic.transact('f008.approval', t => t.insertTaskApprovalItem({
      projectId: box.projectId, featureId: box.featureId, taskId: ids.taskId, kind: 'approval', description: 'final review',
      responsibleParty: 'owner', planDigest, codeDigest: CODE, artifactRefs: [], createdBy: box.owner.principalId,
    }).record);
    const result = await service().submit(box.owner, { ...input, commandId: randomUUID(), operation: 'task.approval.approve',
      expectedRevision: item.revision, payload: { taskId: ids.taskId, itemId: item.id, planDigest, codeDigest: CODE, artifactRefs: [], reason: 'reviewed' } });
    expect(result.status).toBe('completed');
  }
  return { box, ids, input, dependencies, service, verify, commit, reconcile, register, readOperation, revision, approval };
}

describe('F-008 Feature delivery commands', () => {
  it.each(operations)('%s uses the existing v5 envelope and rejects absent trusted dependencies', async operation => {
    const box = await openBudgetFixture(); boxes.push(box);
    const ids = await box.start();
    const input = envelope(box.projectId, box.featureId, ids.runId, ids.batchId, randomUUID(), operation);
    expect(validateCommandEnvelope(input)).toMatchObject({ operation, expectedRevision: 1 });
    const service = createCommandService({ atomicStore: box.services.atomic, nowUtcMs: () => NOW });
    await expect(service.submit(box.owner, input)).rejects.toMatchObject({ code: 'unsupported', operation });
  });

  it('reuses approval decisions, finalizes once and replays durable command receipts after restart/expiry', async () => {
    const f = await fixture(); await f.approval();
    f.input.expectedRevision = f.revision();
    const service = f.service();
    const [first, concurrent] = await Promise.all([service.submit(f.box.owner, f.input), service.submit(f.box.owner, f.input)]);
    expect(first).toMatchObject({ schemaVersion: 5, status: 'completed', replayed: false,
      result: { outcome: 'completed', deliveryStatus: 'succeeded', gitOperationId: f.input.payload.operationId, runtimeCalled: false } });
    expect(concurrent).toMatchObject({ ...first, replayed: true });
    expect(f.verify).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1);
    const operation = f.readOperation();
    expect(operation.intent.operationId).toBe(f.input.payload.operationId);
    expect(operation.intent.gitIdentity.name).toBe('Configured Git User');
    expect(first.principalId).toBe('local-owner');
    expect(first.commandId).not.toBe(operation.intent.operationId);
    f.box.reopen();
    const restarted = createCommandService({ atomicStore: f.box.services.atomic, nowUtcMs: () => NOW + 86_400_000 });
    expect(await restarted.submit(f.box.owner, f.input)).toMatchObject({ ...first, replayed: true });
    await expect(restarted.submit(f.box.owner, { ...f.input, payload: { ...f.input.payload, runId: 'different' } })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps waiting for final approval and accepts a new explicit command after the existing approval channel', async () => {
    const f = await fixture(); const service = f.service();
    expect(await service.submit(f.box.owner, f.input)).toMatchObject({ status: 'completed', result: { outcome: 'awaiting_approval' } });
    expect(f.commit).not.toHaveBeenCalled();
    await f.approval();
    expect(f.commit).not.toHaveBeenCalled();
    const resumed = await service.submit(f.box.owner, { ...f.input, commandId: randomUUID(), expectedRevision: f.revision() });
    expect(resumed).toMatchObject({ status: 'completed', result: { outcome: 'completed' } });
    expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it('serializes different commands for the same Feature and rejects in-flight ID parameter conflicts', async () => {
    const f = await fixture(); await f.approval();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    f.verify.mockImplementationOnce(async () => { await waiting; return { passed: true, reason: 'passed' }; });
    const service = f.service();
    const first = service.submit(f.box.owner, f.input);
    await expect(service.submit(f.box.owner, { ...f.input, expectedRevision: f.input.expectedRevision + 1 })).rejects.toMatchObject({ code: 'conflict' });
    const other = service.submit(f.box.owner, { ...f.input, commandId: randomUUID() });
    const caught = other.catch(error => error);
    release(); await first;
    expect(await caught).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    expect(f.verify).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it('reconciles only existing same-owner operations, never replays an uncertain commit', async () => {
    const f = await fixture(); f.register(); const service = f.service();
    expect(await service.submit(f.box.owner, f.input)).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'reconciliation_required' } } });
    f.box.session.database.prepare('UPDATE execution_batches SET deadline_at = ? WHERE id = ?').run(NOW - 1, f.ids.batchId);
    const input = { ...f.input, operation: operations[1], commandId: randomUUID() };
    const [one, two] = await Promise.all([service.submit(f.box.owner, input), service.submit(f.box.owner, input)]);
    expect(one).toMatchObject({ status: 'completed', result: { outcome: 'not_executed', gitOperationId: input.payload.operationId } });
    expect(two).toMatchObject({ ...one, replayed: true });
    expect(await f.service().submit(f.box.owner, input)).toMatchObject({ ...one, replayed: true });
    expect(f.reconcile).toHaveBeenCalledTimes(1); expect(f.commit).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  });

  it('rejects permissions, project visibility, association, revision and timing before any external work', async () => {
    const f = await fixture(); const service = f.service();
    const registered = await f.box.submit('project.register', {
      repositoryPath: f.box.box.repoDirB, displayName: 'Other project', description: null, labels: [],
    }, { scope: { kind: 'registration' } });
    if (registered.status !== 'completed') throw new Error('second project fixture failed');
    const otherProjectId = (registered.result as { project: { id: string } }).project.id;
    const denied = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'all' } });
    await expect(service.submit(denied, f.input)).rejects.toMatchObject({ code: 'forbidden' });
    const hidden = createRestrictedPrincipal({ capabilities: ['execution.start'], projectScope: { kind: 'allowlist', projectIds: [randomUUID()] } });
    await expect(service.submit(hidden, f.input)).rejects.toMatchObject({ code: 'forbidden' });
    for (const input of [
      { ...f.input, expectedRevision: f.input.expectedRevision + 1 },
      { ...f.input, payload: { ...f.input.payload, runId: 'other-run' } },
      { ...f.input, payload: { ...f.input.payload, batchId: 'other-batch' } },
      { ...f.input, payload: { ...f.input.payload, featureId: 'other-feature' } },
      { ...f.input, scope: { kind: 'project', projectId: otherProjectId } },
      { ...f.input, operation: operations[1] },
    ]) expect(await service.submit(f.box.owner, { ...input, commandId: randomUUID() })).toMatchObject({ status: 'rejected' });
    await expect(service.submit(f.box.owner, { ...f.input, scope: { kind: 'project', projectId: randomUUID() } })).rejects.toMatchObject({ code: 'not_found' });
    for (const input of [
      { ...f.input, expiresAt: new Date(NOW - 1).toISOString(), issuedAt: new Date(NOW - 2).toISOString() },
      { ...f.input, issuedAt: new Date(NOW + 86_400_000).toISOString() },
    ]) await expect(service.submit(f.box.owner, input)).rejects.toHaveProperty('code');
    expect(f.verify).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled(); expect(f.reconcile).not.toHaveBeenCalled();
  });

  it('rejects wrong trusted intent ownership and deadlines durably before checks or Git', async () => {
    const f = await fixture();
    const service = createCommandService({ atomicStore: f.box.services.atomic, nowUtcMs: () => NOW,
      featureDelivery: { ...f.dependencies, readIntent: input => ({
        projectId: input.projectId, featureId: 'other-feature', runId: input.runId, operationId: input.operationId!, codeDigest: CODE,
      }) } });
    const first = await service.submit(f.box.owner, f.input);
    expect(first).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
    expect(await f.service().submit(f.box.owner, f.input)).toMatchObject({ ...first, replayed: true });
    f.box.session.database.prepare('UPDATE execution_batches SET deadline_at = ? WHERE id = ?').run(NOW - 1, f.ids.batchId);
    expect(await f.service().submit(f.box.owner, { ...f.input, commandId: randomUUID() })).toMatchObject({
      status: 'rejected', error: { code: 'conflict', details: { reason: 'deadline_exceeded' } },
    });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled(); expect(f.reconcile).not.toHaveBeenCalled();
  });

  it('holds Host quiesce until admitted delivery work settles and rejects new delivery commands', async () => {
    const f = await fixture(); await f.approval();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.verify.mockImplementationOnce(async () => { await barrier; return { passed: true, reason: 'passed' }; });
    const service = f.service();
    const pending = service.submit(f.box.owner, f.input);
    const activity = service.deliveryActivity!;
    try {
      expect(activity.enterQuiesce()).toEqual({ accepted: 1 });
      expect(await activity.awaitQuiesce(0)).toMatchObject({ confirmed: false, pending: ['feature_delivery_in_progress'] });
      await expect(service.submit(f.box.owner, { ...f.input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'resource_busy' });
    } finally { release(); }
    await pending;
    expect(await activity.awaitQuiesce(50)).toEqual({ confirmed: true, pending: [] });
    expect(await service.submit(f.box.owner, f.input)).toMatchObject({ replayed: true });
  });

  it.each([false, true])('real Host advertises delivery only with trusted assembly (%s), authenticates before any adapter call', async available => {
    const f = await fixture(); f.register();
    const host = await startHost({ dataRoot: f.box.box.dataRoot, capabilityCatalog: f.box.box.capabilityCatalog,
      env: {}, ...(available ? { featureDeliveryFactory: () => f.dependencies } : {}) });
    hosts.push(host);
    const client = await connectToHost({ canonicalRoot: f.box.box.dataRoot });
    try {
      expect(client.handshake.schemaVersion).toBe(5);
      expect(client.handshake.capabilities.application.commands.includes(operations[1])).toBe(available);
    } finally { client.close(); }
    const token = readFileSync(join(f.box.box.dataRoot, 'host', 'auth.token'), 'utf8');
    const input = { ...f.input, operation: operations[1], issuedAt: new Date().toISOString() };
    const post = (body: unknown, authorized = true) => loopbackRequest({ port: host.port, method: 'POST', path: '/v1/commands',
      headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body });
    expect((await post(input, false)).statusCode).toBe(401);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect((await post({ ...input, actor: 'local-owner' })).statusCode).toBe(400);
    expect((await post({ ...input, operation: 'git.push' })).statusCode).toBe(501);
    const first = await post(input);
    expect(first.statusCode).toBe(available ? 200 : 501);
    if (available) {
      expect(first.json()).toMatchObject({ status: 'completed', result: { outcome: 'not_executed' } });
      expect((await post(input)).json()).toMatchObject({ replayed: true });
    }
    expect(f.reconcile).toHaveBeenCalledTimes(available ? 1 : 0);
    expect(f.verify).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });

  it('deeply validates wire fields and rejects actor overrides, publishing and incompatible schema versions', () => {
    const input = envelope(randomUUID(), 'f', 'r', 'b', randomUUID());
    for (const invalid of [
      { ...input, actor: 'local-owner' }, { ...input, principalId: 'local-owner' },
      { ...input, payload: { ...input.payload, gitIdentity: { name: 'owner', email: 'owner@example.test' } } },
      { ...input, payload: { ...input.payload, actor: 'local-owner' } },
      { ...input, payload: { ...input.payload, operationId: 'not-an-uuid' } },
      { ...input, payload: { ...input.payload, runId: { id: 'r' } } },
      { ...input, expectedRevision: null }, { ...input, expectedRevision: 0 },
      { ...input, schemaVersion: 6 }, { ...input, schemaVersion: 4 },
      ...['git.push', 'git.pr.create', 'git.merge', 'feature.autoMerge'].map(operation => ({ ...input, operation })),
    ]) expect(() => validateCommandEnvelope(invalid)).toThrow();
    expect(validateCommandEnvelope(input).schemaVersion).toBe(5);
  });

  it('keeps the existing v5 handshake compatible with both real capability views and rejects fabricated capabilities', () => {
    const input = { schemaVersion: 5, protocolVersion: 1, hostInstanceId: randomUUID(), dataRootIdentity: 'a'.repeat(64),
      lifecycleState: 'ready', startedAt: new Date(NOW).toISOString(), capabilities: hostCapabilitiesForDelivery(false) };
    const expected = { expectedHostInstanceId: input.hostInstanceId, expectedDataRootIdentity: input.dataRootIdentity };
    expect(input.capabilities.application.commands).not.toContain(operations[0]);
    for (const available of [false, true]) {
      const capabilities = hostCapabilitiesForDelivery(available);
      expect(validateHandshakeResponse({ ...input, capabilities }, expected).schemaVersion).toBe(5);
    }
    const capabilities = structuredClone(hostCapabilitiesForDelivery(true));
    (capabilities.application.commands as string[]).push('git.push');
    expect(() => validateHandshakeResponse({ ...input, capabilities }, expected)).toThrow();
    expect(() => validateHandshakeResponse({ ...input, capabilities: {
      ...input.capabilities, application: { ...input.capabilities.application,
        commands: [...input.capabilities.application.commands, operations[0]] },
    } }, expected)).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'capability_mismatch' }) }));
    expect(() => validateHandshakeResponse({ ...input, schemaVersion: 6 }, expected)).toThrow();
  });
});
