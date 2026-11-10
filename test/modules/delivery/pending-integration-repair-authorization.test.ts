import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { openIntegrationFixture } from '../../helpers/p05-7-integration-vertical.ts';
import { BUDGET, NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { createIntegrationExecutionPlan } from '../../../packages/core/src/ports/integration-execution-plan.ts';
import { createGitAgentRepairRequest, computeGitAgentRepairBaselineDigest } from '../../../packages/core/src/ports/git-agent-repair.ts';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';
import { createSqliteFeatureResourceAccess } from '../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { createSqliteIntegrationRepairAuthorizations } from '../../../packages/core/src/adapters/sqlite/integration-repair-authorizations.ts';
import { createSqliteIntegrationRepairAttempts } from '../../../packages/core/src/adapters/sqlite/integration-repair-attempts.ts';
import { createIntegrationRepairConsumer, createIntegrationRepairFinalizationConsumer } from '../../../packages/core/src/application/integration-repair-consumer.ts';
import { createGitAgentCandidateFinalizationService } from '../../../packages/core/src/application/git-agent-candidate-finalization.ts';
import type { GitAgentRuntimeAdapter, GitAgentRuntimeRequest } from '../../../packages/core/src/ports/git-agent-runtime.ts';
import { createGitAgentRuntimeRequest } from '../../../packages/core/src/ports/git-agent-runtime.ts';
import { createSqliteGitAgentRepairStore } from '../../../packages/core/src/adapters/sqlite/git-agent-repair-store.ts';
import { executeFeatureRepair } from '../../../packages/core/src/adapters/sqlite/feature-repair.ts';
import { createIntegrationRepairContextService } from '../../../packages/core/src/adapters/integration-repair-context.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import type { WorkspaceInspection } from '../../../packages/core/src/ports/workspace-inspector.ts';
import { createIntegrationRepairRuntimeAuthority, integrationRepairCandidatePaths } from '../../../packages/core/src/adapters/integration-repair-runtime.ts';
import { createProductionPiGitAgentDriver } from '../../../packages/host/src/runtime/production-pi-git-agent.ts';
import { createPiRuntimeDescriptor } from '../../../packages/host/src/runtime/pi-adapter.ts';
import type { WorkRuntimeFactory } from '../../../packages/core/src/adapters/composition.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSqliteIntegrationRepairCandidates } from '../../../packages/core/src/adapters/sqlite/integration-repair-candidates.ts';
import { gitAgentIntegrationCommitPlan, gitAgentIntegrationCommitResult } from '../../../packages/core/src/ports/git-agent-integration-commit.ts';
import { gitOperationCommitMessage } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import type { GitCommitAuthorization } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import type { GitOperationRecord } from '../../../packages/core/src/ports/git-operations.ts';

const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
const repairLaunch = '96bd4415-efba-420a-82ec-875c2599659a';
const fixtures: Awaited<ReturnType<typeof openIntegrationFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

async function fixture(withStopEvidence = true, tokenGrant = 100, maxRuns = BUDGET.batch.maxRuns) {
  const { maxCostTotal: _cost, ...batch } = BUDGET.batch;
  const f = await openIntegrationFixture({ batch: { ...batch, maxRuns,
    maxTotalAttempts: Math.max(batch.maxTotalAttempts,maxRuns), maxRuntimeStarts: Math.max(batch.maxRuntimeStarts,maxRuns) }, run: BUDGET.run });
  fixtures.push(f);
  const db = f.box.session.database;
  const initial = f.box.atomic.transact('fixture.read', tx => tx.getExecutionRun(f.box.projectId, f.plan.runId));
  const binding = f.box.atomic.transact('fixture.binding', tx => tx.getRepositoryBinding(f.box.projectId));
  // Fixtures prepare historical facts directly; the production entry cannot mutate snapshots.
  db.prepare("UPDATE runs SET status='failed', ended_at=? WHERE id=?").run(NOW, initial.id);
  const material = { schemaVersion: 1, repositoryBindingId: binding.id, repositoryBindingRevision: binding.bindingRevision,
    repoIdentity: binding.repoIdentity, targetBaseline: f.plan.target.baseCommit, scopeFeatureIds: [f.box.featureId],
    dagDigest: hash('fixture-dag'), dependencies: [{ featureId: f.box.featureId, dependsOnId: 'predecessor-a', revision: 1 }] };
  const { workspaceBaseline: _baseline, ...snapshot } = initial.inputSnapshot;
  const run = f.box.atomic.transact('fixture.pending', tx => {
    tx.recordExecutionRunDispatch(f.box.projectId, initial.batchId);
    return tx.insertExecutionRun({ projectId: f.box.projectId, batchId: initial.batchId, featureId: f.box.featureId,
      runId: randomUUID(), purpose: initial.purpose, inputSnapshot: { ...snapshot,
        integrationAuthorization: { ...material, authorizationDigest: hash(material) } },
      configSnapshot: initial.configSnapshot, status: 'queued', scopeDigest: initial.scopeDigest,
      workKey: initial.workKey, dispatchOrdinal: 2, maxAttemptsPerRun: initial.maxAttemptsPerRun,
      runTimeLimitMs: initial.runTimeLimitMs, reason: null });
  });
  const { schemaVersion: _schema, integrationId: _id, inputDigest: _digest, status: _status, ...planBody } = f.plan;
  const plan = createIntegrationExecutionPlan({ ...planBody, runId: run.id,
    predecessors: f.plan.predecessors.map(p => ({ ...p, runId: run.id })) });
  const intent = { ...f.intent, runId: run.id, operationId: plan.integrationId, integrationPlan: plan, codeDigest: plan.inputDigest,
    budgetSnapshot: { ...f.intent.budgetSnapshot!, ...f.intent.budgetSnapshot } };
  const operation = f.operations.registerGitOperation(intent).operation;
  const failed = f.operations.finalizeGitOperation({ projectId: f.box.projectId, operationId: intent.operationId,
    expectedRevision: operation.revision, status: 'failed', actualCommit: null, actualTree: null,
    exitCode: 1, durationMs: 1, reasonCode: 'merge_conflict', deliveryStatus: 'not_requested', settledAtUtcMs: NOW + 1,
    recoveryState: 'preserved', workspacePreserved: true }).operation;
  const resources = createSqliteFeatureResourceAccess(f.box.session, { nowUtcMs: () => NOW + 2 });
  const resourceSet = { ...f.authorization.resourceSet, resources: f.authorization.resourceSet.resources.map(r => ({ ...r,
    key: r.kind === 'worktree_write_exclusive' ? `project:${f.box.projectId}:worktree:${plan.integrationId}` : r.key })) };
  f.box.session.transactWrite('fixture.claim', () => {
    resources.acquireInTransaction({ resourceSet, owner: { ownerId: intent.ownerId, ownerVersion: 1 }, leaseUntilUtcMs: NOW + 10000 });
    db.prepare(`INSERT INTO integration_execution_claims(project_id,operation_id,run_id,source_plan_id,owner_id,owner_version,intent,admission,created_at)
      VALUES(?,?,?,?,?,?,?,'owned',?)`).run(f.box.projectId, intent.operationId, run.id,
        intent.budgetSnapshot.sourcePlanId, intent.ownerId, 1, JSON.stringify(intent), NOW);
    if (withStopEvidence) db.prepare(`INSERT INTO integration_processes(project_id,operation_id,launch_id,process_identity,stopped,created_at)
      VALUES(?,?,?,'{}',1,?)`).run(f.box.projectId, intent.operationId, 'confirmed-writer', NOW);
  });
  const request = createGitAgentRepairRequest({ projectId: f.box.projectId, phaseId: plan.phaseId, parentBatchId: plan.batchId,
    featureId: f.box.featureId, runId: run.id, repairId: randomUUID(), commandId: randomUUID(),
    source: { projectId: f.box.projectId, phaseId: plan.phaseId, parentBatchId: plan.batchId, featureId: f.box.featureId,
      runId: run.id, integrationId: plan.integrationId, operationId: intent.operationId, operationType: 'integration',
      operationDigest: operation.intentDigest, inputDigest: plan.inputDigest, failureKind: 'conflict', evidenceId: intent.operationId,
      evidenceDigest: hash(failed.receipt) },
    target: { repoIdentity: intent.repoIdentity, baselineCommitSha: intent.expectedHead,
      baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: intent.repoIdentity, baselineCommitSha: intent.expectedHead }) },
    workspace: { workspaceId: plan.integrationId, workspaceDigest: hash({ repoIdentity: intent.repoIdentity,
      worktreePath: intent.worktreePath, inputDigest: plan.inputDigest, baselineCommitSha: intent.expectedHead }) },
    conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts'], intent: { intentId: 'intent', digest: hash('intent') },
    verification: { strategyId: 'combined-checks', digest: hash('checks') },
    budget: { remainingAttempts: 1, remainingTokens: tokenGrant, remainingRuntimeMs: 1000, deadlineUtcMs: NOW + 5000 } }, { nowUtcMs: NOW });
  let clock = NOW + 2;
  const service = () => createSqliteIntegrationRepairAuthorizations(f.box.session, { nowUtcMs: () => clock });
  const fence = { expectedRevision: 1, ownerId: intent.ownerId, ownerVersion: 1 };
  const authorize = (override = fence, value = request) => f.box.atomic.transact('fixture.authorize', tx => service().authorize(tx, value, override));
  const counts = () => db.prepare('SELECT runs_created,attempts_created,runtime_starts FROM execution_batches WHERE id=?').get(plan.batchId);
  return { f, db, run, plan, intent, failed, request, service, fence, authorize, counts, setClock(value: number) { clock = value; } };
}

it('[case:integration-repair-reuses-pending-run] freezes authorization under existing integration ownership without a hidden Run or coding workspace', async () => {
  const x = await fixture();
  const before = x.counts();
  const snapshot = x.db.prepare('SELECT input_snapshot FROM runs WHERE id=?').get(x.run.id);
  const receipt = x.authorize();
  expect(receipt).toMatchObject({ projectId: x.f.box.projectId, runId: x.run.id, repairId: x.request.repairId,
    operationId: x.intent.operationId, authorizationDigest: x.request.authorizationDigest, ownerId: x.intent.ownerId, ownerVersion: 1 });
  expect(x.authorize()).toEqual(receipt);
  expect(x.counts()).toEqual(before);
  expect(x.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 2 });
  for (const table of ['git_agent_repairs', 'attempts', 'managed_workspaces', 'run_execution_baselines']) {
    expect(x.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect(x.db.prepare('SELECT input_snapshot FROM runs WHERE id=?').get(x.run.id)).toEqual(snapshot);
  expect(x.f.operations.getGitOperation(x.f.box.projectId, x.intent.operationId)).toEqual(x.failed);
  expect(x.db.prepare("SELECT DISTINCT state FROM feature_resource_leases").all()).toEqual([{ state: 'held' }]);
  await x.f.box.reopen();
  x.setClock(NOW + 20000);
  expect(x.authorize()).toEqual(receipt);
  expect(x.f.box.atomic.transact('read', tx => x.service().read(tx, x.f.box.projectId, x.request.repairId)).request).toEqual(x.request);
});

it.each(['revision', 'owner', 'quarantined', 'unknown_process', 'no_stop_evidence', 'coding_started', 'expired'])(
  '[case:integration-repair-rejects-%s] refuses unsafe authorization without changing Run or resource facts', async reason => {
    const x = await fixture(reason !== 'no_stop_evidence');
    let fence = x.fence;
    if (reason === 'revision') fence = { ...fence, expectedRevision: 2 };
    if (reason === 'owner') fence = { ...fence, ownerId: 'other-owner' };
    if (reason === 'quarantined') x.db.prepare("UPDATE integration_execution_claims SET admission='quarantined' WHERE operation_id=?").run(x.intent.operationId);
    if (reason === 'unknown_process') x.db.prepare("INSERT INTO integration_processes VALUES(?,?,?,'{}',0,?)")
      .run(x.f.box.projectId, x.intent.operationId, 'unknown-writer', NOW);
    if (reason === 'coding_started') x.db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(NOW, x.run.id);
    if (reason === 'expired') x.setClock(NOW + 20000);
    const counts = x.counts();
    const expected = reason === 'revision' || reason === 'owner' || reason === 'quarantined' ? 'integration_owner_or_revision_changed'
      : reason === 'unknown_process' || reason === 'no_stop_evidence' ? 'integration_stop_unconfirmed'
      : reason === 'coding_started' ? 'pending_member_required' : 'budget_exhausted';
    expect(() => x.authorize(fence)).toThrow(expect.objectContaining({ details: { reason: expected } }));
    expect(x.db.prepare('SELECT count(*) AS n FROM integration_repair_authorizations').get()).toEqual({ n: 0 });
    expect(x.counts()).toEqual(counts);
  },
);

it('[case:integration-repair-idempotency-conflict] command and owner cannot change on replay', async () => {
  const x = await fixture();
  const receipt = x.authorize();
  const { schemaVersion: _s, authorizationDigest: _a, commandDigest: _c, ...body } = x.request;
  const different = createGitAgentRepairRequest({ ...body, writablePaths: [...body.writablePaths, 'extra.ts'] }, { nowUtcMs: NOW });
  expect(() => x.authorize(x.fence, different)).toThrow(expect.objectContaining({ details: { reason: 'command_digest_conflict' } }));
  expect(() => x.authorize({ ...x.fence, ownerVersion: 2 })).toThrow(expect.objectContaining({ details: { reason: 'command_digest_conflict' } }));
  const alias = createGitAgentRepairRequest({ ...body, commandId: randomUUID() }, { nowUtcMs: NOW });
  expect(() => x.authorize(x.fence, alias)).toThrow(expect.objectContaining({ details: { reason: 'repair_identity_conflict' } }));
  expect(x.authorize()).toEqual(receipt);
  expect(x.db.prepare('SELECT count(*) AS n FROM integration_repair_authorizations').get()).toEqual({ n: 1 });
  expect(() => x.db.prepare("UPDATE integration_repair_authorizations SET request='{}'").run()).toThrow(/immutable/);
  expect(() => x.db.prepare('DELETE FROM integration_repair_authorizations').run()).toThrow(/retained/);
  expect(x.db.pragma('foreign_key_check')).toEqual([]);
});

it('[case:integration-repair-trusted-recheck-rolls-back] failed assembly recheck cannot leave a receipt', async () => {
  const x = await fixture();
  expect(() => x.f.box.atomic.transact('reject-current', tx => x.service().authorize(tx, x.request, x.fence, () => {
    throw new Error('approval changed');
  }))).toThrow('approval changed');
  expect(x.db.prepare('SELECT count(*) AS n FROM integration_repair_authorizations').get()).toEqual({ n: 0 });
  expect(x.db.prepare('SELECT revision FROM integration_execution_claims WHERE operation_id=?').get(x.intent.operationId)).toEqual({ revision: 1 });
});

it('[case:integration-repair-project-scope] evidence cannot be read through another project', async () => {
  const x = await fixture();
  x.authorize();
  expect(() => x.f.box.atomic.transact('cross-project-read', tx => x.service().read(tx, 'different-project', x.request.repairId)))
    .toThrow(expect.objectContaining({ kind: 'not_found' }));
});

async function consumerFixture(tokenGrant = 100, maxRuns = BUDGET.batch.maxRuns) {
  const x = await fixture(true, tokenGrant, maxRuns);
  x.authorize();
  const attempts = createSqliteIntegrationRepairAttempts(x.f.box.session, { nowUtcMs: () => NOW + 2 });
  const identity = { projectId: x.request.projectId, repairId: x.request.repairId, attemptId: randomUUID(),
    ownerId: x.intent.ownerId, hostInstanceId: x.intent.hostInstanceId, executionVersion: 1 };
  const transact = <T>(fn: (tx: Parameters<Parameters<typeof x.f.box.atomic.transact>[1]>[0]) => T) => x.f.box.atomic.transact('test.consumer', fn);
  let starts = 0, candidates = 0;
  const runtime: GitAgentRuntimeAdapter = { async start(request: GitAgentRuntimeRequest) {
    starts++;
    expect(x.db.inTransaction).toBe(false);
    expect(transact(tx => attempts.read(tx, identity)).runtimeRequest).toEqual(request);
    transact(tx => attempts.confirmProcess(tx, identity, { launchId: repairLaunch, pid: 12345, processGroupId: 12345, startTime: 'test-start' }));
    return { result: Promise.resolve({ schemaVersion: 1, repairId: x.request.repairId, execution: request.execution,
      terminal: 'completed', changedPaths: ['src/conflict.ts'], verification: { strategyId: request.authorization.verification.strategyId,
        strategyDigest: request.authorization.verification.digest, outputDigest: null, exitCode: null },
      usage: { consumedTokens: 10, runtimeMs: 10 }, failure: null, stop: { confirmed: true, detail: null } }),
      stopped: Promise.resolve({ confirmed: true, detail: null }), cancel: async () => ({ accepted: true, reason: null }) };
  } };
  const store = {
    claim: () => transact(tx => attempts.claim(tx, identity)),
    read: () => transact(tx => attempts.read(tx, identity)),
    bind: (request: GitAgentRuntimeRequest) => transact(tx => attempts.bind(tx, identity, request)),
    settle: (output: unknown, stopped: boolean) => transact(tx => attempts.settle(tx, identity, output, stopped)),
  };
  const consumer = (adapter = runtime) => createIntegrationRepairConsumer({ store, runtime: adapter,
    assertCurrent: async () => {}, onCandidate: async () => { candidates++; }, nowUtcMs: () => NOW + 2 });
  return { ...x, attempts, identity, transact, runtime, store, consumer, starts: () => starts, candidates: () => candidates };
}

it('[case:integration-repair-durable-consume] commits one admission before Runtime and replays candidate without another start', async () => {
  const x = await consumerFixture();
  expect(await x.consumer().consume()).toMatchObject({ outcome: 'candidate', replayed: false });
  expect(await x.consumer().consume()).toMatchObject({ outcome: 'candidate', replayed: true });
  expect(x.starts()).toBe(1);
  expect(x.candidates()).toBe(2);
  expect(x.counts()).toMatchObject({ runs_created: 2, attempts_created: 1, runtime_starts: 1 });
  expect(x.store.read()).toMatchObject({ stoppedAtUtcMs: NOW + 2, output: { status: 'modified', usage: { consumedTokens: 10 } } });
  expect(x.db.prepare('SELECT status,started_at FROM runs WHERE id=?').get(x.run.id)).toEqual({ status: 'queued', started_at: null });
  expect(x.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
  expect(x.f.operations.getGitOperation(x.request.projectId, x.intent.operationId)).toEqual(x.failed);
});

it('[case:integration-repair-candidate-view] maps the original queued Run and stopped Attempt into the existing finalizer view without writing execution state', async () => {
  const x = await consumerFixture();
  await x.consumer().consume();
  const before = x.counts();
  const candidates = createSqliteIntegrationRepairCandidates(x.f.box.session,{claim:x.identity,nowUtcMs:()=>NOW+3});
  const view = candidates.read(x.request.projectId,x.request.repairId);
  expect(view).toMatchObject({request:x.request,receipt:{runId:x.run.id,authorizationDigest:x.request.authorizationDigest},
    authorizationVersion:1,blockedReason:null,attempts:[{id:x.identity.attemptId,runId:x.run.id,stoppedAtUtcMs:NOW+2,output:{status:'modified'}}]});
  expect(view.attempts[0].dispatch).toEqual(x.store.read().dispatch);
  expect(x.counts()).toEqual(before);
  expect(x.f.operations.getGitOperation(x.request.projectId,x.intent.operationId)).toEqual(x.failed);
});

it('[case:integration-repair-candidate-hold] persists the first finalizer hold across readers and never clears or overwrites it', async () => {
  const x = await consumerFixture();
  await x.consumer().consume();
  const open = () => createSqliteIntegrationRepairCandidates(x.f.box.session,{claim:x.identity,nowUtcMs:()=>NOW+3});
  open().hold(x.request.projectId,x.request.repairId,'out_of_scope');
  open().hold(x.request.projectId,x.request.repairId,'identity_or_lock');
  expect(open().read(x.request.projectId,x.request.repairId).blockedReason).toBe('out_of_scope');
  expect(()=>open().read(randomUUID(),x.request.repairId)).toThrow();
  expect(()=>open().hold(x.request.projectId,x.request.repairId,'not-a-hold' as never)).toThrow();
  expect(()=>x.db.prepare('DELETE FROM integration_repair_candidate_holds').run()).toThrow(/retained/);
  expect(()=>x.db.prepare("UPDATE integration_repair_candidate_holds SET reason='identity_or_lock'").run()).toThrow(/immutable/);
  expect(x.db.prepare('SELECT status,started_at FROM runs WHERE id=?').get(x.run.id)).toEqual({status:'queued',started_at:null});
});

it('[case:integration-repair-finalizer-unknown-stop] a durable but unobserved writer is not handed to the finalizer or restarted', async () => {
  const x = await consumerFixture();
  x.store.claim();
  const finalize = vi.fn();
  const consumer = createIntegrationRepairFinalizationConsumer({store:x.store,runtime:x.runtime,
    assertCurrent:async()=>{},candidates:{finalize},nowUtcMs:()=>NOW+2});
  expect(await consumer.consume()).toMatchObject({outcome:'blocked',reason:'stop_unconfirmed',successorUnlocked:false});
  expect(finalize).not.toHaveBeenCalled();expect(x.starts()).toBe(0);
  expect(x.db.prepare('SELECT state FROM execution_slot_claims').all()).toEqual([{state:'held'}]);
});

it('[case:integration-repair-crash-no-restart] durable unobserved admission is held without another model or candidate', async () => {
  const x = await consumerFixture();
  x.store.claim();
  expect(await x.consumer().consume()).toMatchObject({ outcome: 'blocked', reason: 'stop_unconfirmed' });
  expect(x.starts()).toBe(0);
  expect(x.candidates()).toBe(0);
  expect(x.counts()).toMatchObject({ runtime_starts: 1 });
});

it('[case:integration-repair-unknown-stop-no-candidate] retains unconfirmed writer and its full reservation', async () => {
  const x = await consumerFixture();
  const original = x.runtime.start;
  const runtime: GitAgentRuntimeAdapter = { start: async request => ({ ...await original(request), stopped: Promise.resolve({ confirmed: false, detail: 'unknown' }) }) };
  expect(await x.consumer(runtime).consume()).toMatchObject({ outcome: 'blocked', reason: 'stop_unconfirmed' });
  expect(x.candidates()).toBe(0);
  expect(x.store.read().stoppedAtUtcMs).toBeNull();
  expect(x.store.read().maxTokens).toBe(100);
  expect(() => x.db.prepare("UPDATE execution_slot_claims SET state='released',released_at=?").run(NOW + 3)).toThrow(/stop unconfirmed/);
  expect(() => x.db.prepare("UPDATE feature_resource_leases SET state='released',released_at=?").run(NOW + 3)).toThrow(/stop unconfirmed/);
  expect(await x.consumer().consume()).toMatchObject({ outcome: 'blocked', reason: 'stop_unconfirmed' });
  expect(x.starts()).toBe(1);
});

it('[case:integration-repair-stop-evidence] confirmed runtime stop marks only the repair launch, retaining source failure', async () => {
  const x = await consumerFixture();
  await x.consumer().consume();
  expect(x.db.prepare('SELECT launch_id,stopped FROM integration_processes WHERE launch_id=?').get(repairLaunch))
    .toEqual({ launch_id: repairLaunch, stopped: 1 });
  const reopened = () => createSqliteIntegrationRepairAttempts(x.f.box.session, { nowUtcMs: () => NOW + 3 });
  await x.f.box.reopen();
  expect(x.transact(tx => reopened().read(tx, x.identity))).toMatchObject({ output: { status: 'modified' }, stoppedAtUtcMs: NOW + 2 });
});

it('[case:integration-repair-bind-full-grant] Runtime cannot enlarge writable paths while retaining the admitted budget', async () => {
  const x = await consumerFixture();
  const admission = x.store.claim().attempt;
  const { schemaVersion: _s, authorizationDigest: _a, commandDigest: _c, ...body } = admission.request;
  const authorization = createGitAgentRepairRequest({ ...body, writablePaths: [...body.writablePaths, 'extra.ts'],
    budget: { remainingAttempts: 1, remainingTokens: admission.maxTokens, remainingRuntimeMs: admission.maxRuntimeMs,
      deadlineUtcMs: admission.deadlineUtcMs } }, { nowUtcMs: NOW });
  const request = createGitAgentRuntimeRequest({ authorization, claim: { ...x.identity, authorizationVersion: 1 },
    invocationId: 'invocation', executionVersion: x.identity.executionVersion });
  expect(() => x.store.bind(request)).toThrow(expect.objectContaining({ details: { reason: 'runtime_request_identity_mismatch' } }));
  expect(x.store.read().runtimeRequest).toBeNull();
});

it('[case:integration-repair-concurrent-consume] competing consumers start only one Runtime', async () => {
  const x = await consumerFixture();
  const results = await Promise.all([x.consumer().consume(), x.consumer().consume()]);
  expect(results.filter(r => r.outcome === 'candidate')).toHaveLength(1);
  expect(x.starts()).toBe(1);
  expect(x.counts()).toMatchObject({ attempts_created: 1, runtime_starts: 1 });
});

it('[case:integration-repair-expired-bind] request binding after deadline refuses launch', async () => {
  const x = await consumerFixture();
  x.store.claim();
  const lateStore = createSqliteIntegrationRepairAttempts(x.f.box.session, { nowUtcMs: () => NOW + 20000 });
  const request = createGitAgentRuntimeRequest({ authorization: x.request, claim: { ...x.identity, authorizationVersion: 1 },
    invocationId: 'late-invocation', executionVersion: x.identity.executionVersion });
  expect(() => x.transact(tx => lateStore.bind(tx, x.identity, request))).toThrow();
  expect(x.store.read().runtimeRequest).toBeNull();
});

it('[case:integration-repair-timeout-replay] late successful Runtime output after timeout cannot become a replayed candidate', async () => {
  const x = await consumerFixture();
  vi.useFakeTimers();
  try {
    const original = x.runtime.start;
    const runtime: GitAgentRuntimeAdapter = { async start(request) {
      const handle = await original(request);
      const result = new Promise<Awaited<typeof handle.result>>(resolve => {
        setTimeout(() => { void handle.result.then(resolve); }, 1100);
      });
      return { ...handle, result };
    } };
    const pending = x.consumer(runtime).consume();
    await vi.advanceTimersByTimeAsync(1300);
    expect(await pending).toMatchObject({ outcome: 'blocked' });
    expect(x.store.read()).toMatchObject({ output: { status: 'failed', failureCode: 'deadline_exceeded' } });
    expect(await x.consumer().consume()).toMatchObject({ outcome: 'blocked', reason: 'deadline_exceeded' });
    expect(x.starts()).toBe(1);
    expect(x.candidates()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('[case:integration-repair-old-owner-rejected] stale owner cannot settle a stopped candidate', async () => {
  const x = await consumerFixture();
  await x.consumer().consume();
  const output = x.store.read().output;
  expect(() => x.transact(tx => x.attempts.settle(tx, { ...x.identity, ownerId: 'stale-owner' }, output, true)))
    .toThrow(expect.objectContaining({ details: { reason: 'attempt_owner_changed' } }));
});

it('[case:integration-repair-shared-parent-token-budget] legacy GitAgent sees an outstanding integration repair reservation', async () => {
  const x = await consumerFixture(1000, 3);
  x.store.claim();
  const legacy = createSqliteGitAgentRepairStore(x.f.box.session, { nowUtcMs: () => NOW + 3 });
  expect(x.transact(tx => legacy.authorize(tx, x.request))).toMatchObject({ runId: null, blockedReason: 'budget_exhausted' });
});

it('[case:integration-repair-feature-budget] Feature repair cannot spend Tokens already reserved by integration repair', async () => {
  const x = await consumerFixture(1000, 3);
  x.store.claim();
  const before = x.counts();
  let published = 0, started = 0;
  await expect(executeFeatureRepair({ session: x.f.box.session, dataRoot: x.f.box.box.dataRoot,
    projectId: x.request.projectId, featureId: x.request.featureId, runId: x.run.id, ordinal: 1, inputDigest: hash('input'),
    ownerId: x.identity.ownerId, hostInstanceId: x.identity.hostInstanceId, cwd: x.intent.worktreePath,
    policy: { status: 'ready', strategy: {runtime:'pi',provider:'p',model:'m'}, maxRepairs: 1, policyDigest: hash('policy') },
    parentDeadline: NOW + 5000, failures: {}, checkScope: {}, signal: new AbortController().signal,
    now: () => NOW + 3, assertCurrent() {}, capabilityCatalog: x.f.box.box.capabilityCatalog,
    publisher: { async publishArtifact() { published++; throw new Error('unexpected publication'); } },
    runtimeFactory() { started++; throw new Error('unexpected Runtime'); },
  })).rejects.toThrow('feature_repair_parent_token_budget');
  expect(published).toBe(0); expect(started).toBe(0);
  expect(x.counts()).toEqual(before);
  expect(x.db.prepare('SELECT count(*) AS n FROM feature_repair_attempts').get()).toEqual({ n: 0 });
});

it.each(['run','batch'] as const)('[case:integration-repair-pause-%s] pause remains pausing while an integration repair has no confirmed stop', async targetKind => {
  const x = await consumerFixture();
  x.store.claim();
  const result = x.transact(tx => {
    const target = targetKind === 'run' ? tx.getExecutionRun(x.request.projectId,x.run.id)
      : tx.getExecutionBatch(x.request.projectId,x.request.parentBatchId);
    return tx.requestExecutionPause({projectId:x.request.projectId,targetKind,targetId:target.id,expectedRevision:target.revision});
  });
  expect(result.status).toBe('pausing');
  expect(x.db.prepare('SELECT status FROM runs WHERE id=?').get(x.run.id)).toEqual({status:'pausing'});
  expect(x.db.prepare('SELECT state FROM execution_slot_claims').all()).toEqual([{state:'held'}]);
});

async function contextFixture() {
  const x = await fixture();
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const artifacts = createSqliteArtifactStore(x.f.box.session);
  const files = createArtifactFileStore({dataRoot:x.f.box.box.dataRoot});
  const publisher = createArtifactPublisher({ artifacts,files,limits:{maxSizeBytes:4000000,timeoutMs:30000} });
  const intent = 'Preserve the approved predecessor changes';
  const published = await publisher.publishArtifact({projectId:x.request.projectId,kind:'repair-intent',mediaType:'text/plain',
    locator:'repair-intent.txt',expectedHash:sha(intent),content:[Buffer.from(intent)]});
  const {schemaVersion:_s,authorizationDigest:_a,commandDigest:_c,...body} = x.request;
  const request = createGitAgentRepairRequest({...body,intent:{intentId:published.artifact.id,digest:sha(intent)}},{nowUtcMs:NOW});
  x.authorize(x.fence,request);
  const baseline = {repositoryBindingId:x.intent.repositoryBindingId,repositoryBindingRevision:1,repoIdentity:x.intent.repoIdentity,
    canonicalPath:x.intent.worktreePath,gitCommonDir:x.plan.target.gitCommonDir!,branch:'HEAD',baseCommit:x.intent.expectedHead};
  const entry = {path:'src/conflict.ts',state:'present' as const,sizeBytes:20,digest:hash('before'),mode:420,indexObject:'a'.repeat(40),indexMode:'100644',protection:'tracked' as const};
  let before: WorkspaceInspection = {schemaVersion:1,complete:true,evidenceId:'before',startedAt:new Date(NOW).toISOString(),endedAt:new Date(NOW).toISOString(),
    repository:{...baseline,headCommit:baseline.baseCommit},registration:{path:baseline.canonicalPath,headCommit:baseline.baseCommit,branch:'HEAD'},
    statusPorcelainBase64:Buffer.from('UU src/conflict.ts\0').toString('base64'),refsDigest:hash('refs'),codeDigest:hash('code'),ignoredDigest:hash('ignored'),
    contents:{tracked:[entry],untracked:[],ignored:[],directories:[]},conflictMarkerPaths:['src/conflict.ts'],ignoredProtection:'none_present',directoryProtection:'none_present',
    observedFileCount:1,observedBytes:20,gitCalls:1,boundary:'trusted_project_not_os_sandbox'};
  let model = 'model';
  let reads = 0;
  const service = () => createIntegrationRepairContextService({ session:x.f.box.session,dataRoot:x.f.box.box.root,artifacts,files,publisher,
    capabilityCatalog:createStaticRuntimeCapabilityCatalog([{runtimeId:'pi',providers:[{providerId:'p',models:['model','changed']}]}]),
    inspector:{async inspect(){expect(x.f.box.session.database.inTransaction).toBe(false);reads++;return structuredClone(before);}},
    facts(tx,projectId,repairId) {
      const authorization = x.service().read(tx,projectId,repairId);
      return {authorization,baseline,expectedHead:baseline.baseCommit,strategy:{runtime:'pi',provider:'p',model,credentialRef:'credential://pi/p'},locale:'zh-CN',maxRequests:80,
        verificationPlan:{status:'ready',mode:'full_fallback',affectedModules:[],coveredModules:[],selectedCheckKeys:[],selectedChecks:[],unselectedCheckKeys:[],reasonCode:'feature_scope_configured',reason:'fixture',candidateDigest:null,candidateRejection:null},
        policyDigest:hash({model}),evidence:stableStringify(x.failed.receipt)};
    },nowUtcMs:()=>NOW+2,
  });
  return {...x,request,files,artifacts,publisher,service,baseline,reads:()=>reads,
    changeModel(){model='changed';},changeWorkspace(){before={...before,codeDigest:hash('changed')};}};
}

it('[case:integration-repair-context-persist] prepares immutable context and pre-repair inspection before any Attempt', async () => {
  const x = await contextFixture();
  const receipt = await x.service().prepare(x.request.projectId,x.request.repairId);
  const context = await x.service().read(x.request.projectId,x.request.repairId);
  expect(context.binding).toMatchObject({strategy:{provider:'p',model:'model'},locale:'zh-CN',maxRequests:80});
  expect(context.verificationPlan).toMatchObject({status:'ready',reasonCode:'feature_scope_configured'});
  expect(context.before.repository.canonicalPath).toBe(x.baseline.canonicalPath);
  expect(context.authorizationDigest).toBe(x.request.authorizationDigest);
  expect(await x.service().prepare(x.request.projectId,x.request.repairId)).toEqual(receipt);
  expect(x.reads()).toBe(1);
  expect(x.db.prepare('SELECT count(*) AS n FROM integration_repair_attempts').get()).toEqual({n:0});
  expect(x.counts()).toMatchObject({attempts_created:0,runtime_starts:0});
  expect(() => x.db.prepare("UPDATE integration_repair_contexts SET facts_digest=?").run(hash('other'))).toThrow(/immutable/);
});

it('[case:integration-repair-context-policy-drift] changed model cannot silently reuse a frozen context', async () => {
  const x = await contextFixture();
  await x.service().prepare(x.request.projectId,x.request.repairId);
  x.changeModel();
  await expect(x.service().prepare(x.request.projectId,x.request.repairId)).rejects.toMatchObject({details:{reason:'repair_context_changed'}});
});

it('[case:integration-repair-context-corruption] corrupted context bytes are never used as a pre-repair snapshot', async () => {
  const x = await contextFixture();
  const receipt = await x.service().prepare(x.request.projectId,x.request.repairId);
  const path = x.files.resolvePlacement({projectId:x.request.projectId,artifactId:receipt.artifact.artifactId}).finalRelativePath;
  writeFileSync(join(x.f.box.box.dataRoot,path),'{}');
  await expect(x.service().read(x.request.projectId,x.request.repairId)).rejects.toMatchObject({details:{reason:'repair_artifact_changed'}});
});

it('[case:integration-repair-context-late] context cannot be captured after a repair Attempt has been admitted', async () => {
  const x = await contextFixture();
  const attempts = createSqliteIntegrationRepairAttempts(x.f.box.session,{nowUtcMs:()=>NOW+2});
  x.f.box.atomic.transact('test.admit-before-context',tx=>attempts.claim(tx,{projectId:x.request.projectId,repairId:x.request.repairId,
    attemptId:randomUUID(),ownerId:x.intent.ownerId,hostInstanceId:x.intent.hostInstanceId,executionVersion:1}));
  await expect(x.service().prepare(x.request.projectId,x.request.repairId)).rejects.toMatchObject({details:{reason:'repair_inspection_too_late'}});
  expect(x.reads()).toBe(0);
});

it.each(['refs','outside','mode','index','deleted'] as const)('[case:integration-repair-candidate-%s] rejects protected workspace changes', async change => {
  const x = await contextFixture();
  await x.service().prepare(x.request.projectId,x.request.repairId);
  const {before} = await x.service().read(x.request.projectId,x.request.repairId);
  let after = structuredClone(before);
  if (change === 'refs') after = {...after,refsDigest:hash('unexpected-ref')};
  if (change === 'outside') after = {...after,contents:{...after.contents,
    untracked:[{...after.contents.tracked[0],path:'outside.ts',protection:'preserve'}]}};
  if (change === 'mode' || change === 'index') after = {...after,contents:{...after.contents,
    tracked:after.contents.tracked.map(entry=>({...entry,...(change === 'mode' ? {mode:493} : {indexObject:'b'.repeat(40)})}))}};
  if (change === 'deleted') after = {...after,contents:{...after.contents,tracked:[]}};
  expect(() => integrationRepairCandidatePaths(before,after,['src/conflict.ts'])).toThrow();
});

it.each(['success','policy-drift','verification-failure','finalizer-success','publication-failure'] as const)('[case:integration-repair-production-authority-consume-%s] production Pi bridge uses frozen context and returns only a stopped candidate', async scenario => {
  const x = await contextFixture();
  const contexts = x.service();
  await contexts.prepare(x.request.projectId,x.request.repairId);
  const frozen = await contexts.read(x.request.projectId,x.request.repairId);
  let actualInspection = structuredClone(frozen.before);
  const claim = {projectId:x.request.projectId,repairId:x.request.repairId,attemptId:randomUUID(),ownerId:x.intent.ownerId,
    hostInstanceId:x.intent.hostInstanceId,executionVersion:1};
  const attempts = createSqliteIntegrationRepairAttempts(x.f.box.session,{nowUtcMs:()=>NOW+2});
  const tx = <T>(call:(transaction:Parameters<Parameters<typeof x.f.box.atomic.transact>[1]>[0])=>T) => x.f.box.atomic.transact('test.production-authority',call);
  const authority = createIntegrationRepairRuntimeAuthority({atomic:x.f.box.atomic,claim,contexts,attempts,publisher:x.publisher,
    inspector:{async inspect(){expect(x.db.inTransaction).toBe(false);return actualInspection;}}});
  const descriptor = createPiRuntimeDescriptor({providers:[{providerId:'p',models:['model']}],permissionGrants:[],isolationModes:['trusted_project']});
  const catalog = createStaticRuntimeCapabilityCatalog([descriptor]);
  let launches = 0, candidates = 0;
  const runtimeFactory: WorkRuntimeFactory = context => ({entries:[{descriptor,adapter:{async start(request: RuntimeExecutionRequest){
    launches++;
    const input = await context.reader(request)!.read('manifest');
    expect(JSON.parse(Buffer.from(input.content).toString()).productionLimits).toMatchObject({maxRequests:80,tokenLimit:100});
    await context.commitCommandIdentity({launchId:randomUUID(),pid:12345,processGroupId:12345,startTime:'test-os-start'},request);
    expect(tx(transaction=>attempts.read(transaction,claim)).processIdentity).not.toBeNull();
    actualInspection = {...actualInspection,codeDigest:hash('candidate'),contents:{...actualInspection.contents,
      tracked:actualInspection.contents.tracked.map(entry=>({...entry,digest:hash('candidate'),sizeBytes:30}))},conflictMarkerPaths:[]};
    return {events:(async function*(){})(),result:Promise.resolve({schemaVersion:1,terminal:'completed',reason:null,exitCode:0,signal:null,
      durationMs:10,usage:{basis:'reported',inputTokens:2,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0,
        cacheReadIncludedInInput:false,cacheWriteIncludedInInput:false,costUsdMicros:null},lastEventSequence:null}),
      stopped:Promise.resolve({schemaVersion:1,confirmed:true,checkedAtUtc:new Date(NOW+2).toISOString(),detail:null}),
      cancel:async()=>({accepted:true,reason:null})};
  }}}],eventIdentityPrefix:()=> 'test-repair'});
  const runtime = createProductionPiGitAgentDriver({runtimeFactory,capabilityCatalog:catalog,authority,nowUtcMs:()=>NOW+2});
  const consumerDeps = {runtime,nowUtcMs:()=>NOW+2,
    assertCurrent:async()=>{await contexts.assertCurrent(claim.projectId,claim.repairId);},
    store:{claim:()=>tx(transaction=>{contexts.assertCurrentInTransaction(transaction,claim.projectId,claim.repairId);return attempts.claim(transaction,claim);}),
      read:()=>tx(transaction=>attempts.read(transaction,claim)),
      bind:(request:GitAgentRuntimeRequest)=>tx(transaction=>attempts.bind(transaction,claim,request)),
      settle:(output:unknown,stopped:boolean)=>tx(transaction=>attempts.settle(transaction,claim,output,stopped))},
  };
  const consumer = createIntegrationRepairConsumer({...consumerDeps,
    onCandidate:async(output)=>{expect(output).toMatchObject({status:'modified',changedPaths:['src/conflict.ts']});candidates++;}});
  if (scenario === 'finalizer-success' || scenario === 'publication-failure') {
    // Git execution and publication are explicit fakes here; the separate real-Git suite covers the commit driver.
    const candidateStore = createSqliteIntegrationRepairCandidates(x.f.box.session,{claim,nowUtcMs:()=>NOW+3});
    const planRef = {kind:'artifact' as const,id:'core-verification-plan',digest:hash('core-plan')};
    const resultRef = {kind:'verification_result' as const,id:'core-verification-result',digest:hash('core-result')};
    const verify = vi.fn(async()=>({outcome:'passed' as const,evidence:resultRef,planEvidence:planRef,reason:null,hold:null}));
    let authorization: GitCommitAuthorization;
    let committed: GitOperationRecord | undefined;
    const person = {name:x.intent.gitIdentity.name,email:x.intent.gitIdentity.email};
    const commit = vi.fn(async()=>{
      const created = x.f.operations.registerGitOperation({...authorization.intent,candidateTree:'c'.repeat(40)}).operation;
      committed = x.f.operations.finalizeGitOperation({projectId:claim.projectId,operationId:created.intent.operationId,
        expectedRevision:created.revision,status:'succeeded',actualCommit:'d'.repeat(40),actualTree:'c'.repeat(40),
        exitCode:0,durationMs:1,reasonCode:null,deliveryStatus:'not_requested',settledAtUtcMs:NOW+4,
        integrationResult:gitAgentIntegrationCommitResult(created.intent,'d'.repeat(40),'c'.repeat(40))}).operation;
      actualInspection = {...actualInspection,repository:{...actualInspection.repository,headCommit:committed.actualCommit!},statusPorcelainBase64:''};
      return committed;
    });
    const publish = vi.fn(async()=>scenario === 'finalizer-success');
    const finalizer = createGitAgentCandidateFinalizationService({repair:candidateStore,inspector:{async inspect(){return actualInspection;}},
      driver:{open:()=>({facts:async()=>committed ? {head:committed.actualCommit!,tree:committed.actualTree!,
        parents:(committed.intent.budgetSnapshot!.gitAgentRepair as {parents:string[]}).parents,
        message:gitOperationCommitMessage(committed.intent.message,committed.intent.operationId),author:person,committer:person}
        : {head:frozen.before.repository.headCommit,tree:x.intent.candidateTree,parents:[],message:'base',author:person,committer:person},
        isAncestor:async()=>true})} as never,
      readBaseline:()=>frozen.baseline,readAuthorization:context=>{
        const plan = gitAgentIntegrationCommitPlan(context.repair,x.plan);
        authorization = {intent:{...x.intent,operationId:context.operationId,operationType:'integration_commit',integrationPlan:plan,
          expectedHead:context.facts.head,codeDigest:context.inspection.codeDigest,verificationRefs:[planRef,resultRef],
          budgetSnapshot:{...x.intent.budgetSnapshot,gitAgentRepair:{repairId:claim.repairId,
            authorizationDigest:x.request.authorizationDigest,sourceOperationId:x.request.source.operationId,
            sourceInputDigest:x.request.source.inputDigest,parents:[context.facts.head,x.plan.predecessors[0].delivery!.commitSha],
            verification:{planRef:{id:planRef.id,digest:planRef.digest},resultRef:{id:resultRef.id,digest:resultRef.digest}}}}},
          baseline:frozen.baseline,resourceIdentity:{projectId:claim.projectId,attemptId:claim.attemptId,owner:claim.ownerId,
            hostInstanceId:claim.hostInstanceId,executionVersion:claim.executionVersion},allowedPaths:['src/conflict.ts'],
          verificationPassed:true,approvalCurrent:true,commitAuthorized:true};
        return authorization;
      },verify,commit:{commit},operations:x.f.operations,
      integration:{readContext:()=>({source:x.failed,before:frozen.before}),assertCurrent:()=>true,publish}});
    const finalizing = createIntegrationRepairFinalizationConsumer({...consumerDeps,candidates:finalizer});
    const expected = scenario === 'finalizer-success' ? {outcome:'committed',reason:null,successorUnlocked:true}
      : {outcome:'blocked',reason:'integration_not_verified',successorUnlocked:false};
    expect(await finalizing.consume()).toMatchObject({...expected,replayed:false});
    expect(await finalizing.consume()).toMatchObject({...expected,replayed:true});
    expect(launches).toBe(1);expect(verify).toHaveBeenCalledOnce();expect(commit).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(committed!.intent.runId).toBe(x.run.id);
    expect(committed!.intent.operationId).not.toBe(x.request.source.operationId);
    expect(x.f.operations.getGitOperation(claim.projectId,x.request.source.operationId)).toEqual(x.failed);
    // A mocked publisher is NOT evidence of actual successor baseline binding.
    expect(x.db.prepare('SELECT count(*) AS n FROM run_execution_baselines').get()).toEqual({n:0});
    return;
  }
  if (scenario === 'verification-failure') {
    const candidateStore = createSqliteIntegrationRepairCandidates(x.f.box.session,{claim,nowUtcMs:()=>NOW+3});
    const verify = vi.fn(async()=>({outcome:'failed' as const,evidence:null,reason:'verification_failed',hold:null}));
    const commit = vi.fn(), publish = vi.fn();
    const finalizer = createGitAgentCandidateFinalizationService({repair:candidateStore,inspector:{async inspect(){return actualInspection;}},
      driver:{open:()=>({facts:async()=>({head:frozen.before.repository.headCommit,tree:x.intent.candidateTree,parents:[],
        message:'base',author:{name:'User',email:'user@example.com'},committer:{name:'User',email:'user@example.com'}}),
        isAncestor:async()=>true})} as never,
      readBaseline:()=>frozen.baseline,readAuthorization:vi.fn(),verify,commit:{commit},operations:x.f.operations,
      integration:{readContext:()=>({source:x.failed,before:frozen.before}),assertCurrent:()=>true,publish}});
    const finalizing = createIntegrationRepairFinalizationConsumer({...consumerDeps,candidates:finalizer});
    expect(await finalizing.consume()).toMatchObject({outcome:'blocked',reason:'verification_failed',successorUnlocked:false,replayed:false});
    expect(await finalizing.consume()).toMatchObject({outcome:'blocked',reason:'invalid_runtime_output',successorUnlocked:false,replayed:true});
    expect(launches).toBe(1);expect(verify).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
    expect(candidateStore.read(claim.projectId,claim.repairId).blockedReason).toBe('invalid_runtime_output');
    expect(x.db.prepare('SELECT count(*) AS n FROM run_execution_baselines').get()).toEqual({n:0});
    expect(x.f.operations.getGitOperation(x.request.projectId,x.request.source.operationId)).toEqual(x.failed);
    return;
  }
  if (scenario === 'policy-drift') {
    x.changeModel();
    await expect(consumer.consume()).rejects.toMatchObject({details:{reason:'repair_context_changed'}});
    expect(launches).toBe(0);
    expect(x.db.prepare('SELECT count(*) AS n FROM integration_repair_attempts').get()).toEqual({n:0});
    expect(x.counts()).toMatchObject({attempts_created:0,runtime_starts:0});
    return;
  }
  expect(await consumer.consume()).toMatchObject({outcome:'candidate',replayed:false});
  expect(await consumer.consume()).toMatchObject({outcome:'candidate',replayed:true});
  expect(launches).toBe(1);expect(candidates).toBe(2);
  expect((await contexts.read(claim.projectId,claim.repairId)).before).toEqual(frozen.before);
  expect(x.db.prepare('SELECT count(*) AS n FROM artifacts WHERE kind=?').get('integration-repair-runtime-result')).toEqual({n:1});
  expect(x.db.prepare('SELECT count(*) AS n FROM run_execution_baselines').get()).toEqual({n:0});
  actualInspection = structuredClone(frozen.before);
  const settled = tx(transaction=>attempts.read(transaction,claim));
  await expect(authority.resolve(settled.runtimeRequest!)).rejects.toMatchObject({details:{reason:'runtime_start_not_current'}});
});
