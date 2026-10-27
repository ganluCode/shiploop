import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { runBarrierChildren } from '../../helpers/p02-2/index.ts';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkScheduler } from '../../../packages/core/src/application/work-scheduler.ts';
import { createSqliteSchedulerStore } from '../../../packages/core/src/adapters/sqlite/scheduler-store.ts';
import { GIT_AGENT_REPAIR_HOLDS } from '../../../packages/core/src/ports/git-agent-repair-store.ts';
import type { ExecutionBudgetProposal } from '../../../packages/core/src/ports/execution-budget.ts';
import type { GitAgentRepairAuthorizationInput } from '../../../packages/core/src/ports/git-agent-repair.ts';
import { createSqliteFeatureResourceAccess } from '../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { recordVerifiedPass } from '../../helpers/p03-4/task-dag-state-fixture.ts';
import { createSqliteGitIntegrationJournal } from '../../../packages/core/src/adapters/sqlite/git-integration-journal.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createGitAgentRepairService } from '../../../packages/core/src/application/git-agent-repair.ts';
import { createSqliteGitAgentRepairStore } from '../../../packages/core/src/adapters/sqlite/git-agent-repair-store.ts';
import { computeGitAgentRepairBaselineDigest, createGitAgentRepairRequest } from '../../../packages/core/src/ports/git-agent-repair.ts';
import { openIntegrationFixture, digest } from '../../helpers/p05-7-integration-vertical.ts';
import { NOW, BUDGET } from '../../helpers/p03-3/budget-fixture.ts';

const fixtures: Awaited<ReturnType<typeof openIntegrationFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

async function fixture(budget?: ExecutionBudgetProposal, terminalSource = true, failureMode: 'receipt' | 'journal' = 'receipt') {
  const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
  const f = await openIntegrationFixture(budget ?? { batch, run: BUDGET.run });
  fixtures.push(f);
  const operation = f.operations.registerGitOperation(f.intent).operation;
  const failed = failureMode === 'receipt' ? f.operations.finalizeGitOperation({
    projectId: f.box.projectId, operationId: f.intent.operationId, expectedRevision: operation.revision,
    status: 'failed', actualCommit: null, actualTree: null, exitCode: 1, durationMs: 10,
    reasonCode: 'merge_conflict', deliveryStatus: 'not_requested', settledAtUtcMs: NOW + 1,
    recoveryState: 'preserved', workspacePreserved: true,
  }).operation : null;
  let evidenceId = f.intent.operationId;
  let evidence: unknown = failed?.receipt;
  if (failureMode === 'journal') {
    const observation = { outcome: 'blocked' as const, reason: 'merge_conflict', steps: [], workspace: {
      workspaceId: f.plan.integrationId, ownerId: f.intent.ownerId, ownerVersion: 1,
      path: f.intent.worktreePath, gitCommonDir: f.plan.target.gitCommonDir, repoIdentity: f.intent.repoIdentity,
      targetBase: f.intent.expectedHead, plan: f.plan, gitIdentity: f.intent.gitIdentity,
      status: 'blocked' as const, currentHead: f.intent.expectedHead, steps: [],
      facts: { head: f.intent.expectedHead, tree: 'a'.repeat(40), parents: [],
        statusPorcelain: 'UU src/conflict.ts', unresolvedPaths: ['src/conflict.ts'] },
    } };
    f.box.atomic.transact('persist-conflict', tx => createSqliteGitIntegrationJournal(f.box.session, { nowUtcMs: () => NOW + 1 })
      .append(tx, f.box.projectId, f.intent.operationId, operation.revision, observation));
    evidenceId = (f.box.session.database.prepare('SELECT id FROM git_integration_observations WHERE operation_id = ?')
      .get(f.intent.operationId) as { id: string }).id;
    evidence = observation;
  }
  const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
  if (terminalSource) f.box.session.database.prepare("UPDATE runs SET status = 'failed', ended_at = ? WHERE id = ?").run(NOW + 1, f.plan.runId);
  const request = createGitAgentRepairRequest({
    projectId: f.box.projectId, phaseId: f.plan.phaseId, parentBatchId: f.plan.batchId,
    featureId: f.box.featureId, runId: f.plan.runId, repairId: 'repair-1', commandId: 'repair-command-1',
    source: {
      projectId: f.box.projectId, phaseId: f.plan.phaseId, parentBatchId: f.plan.batchId,
      featureId: f.box.featureId, runId: f.plan.runId, integrationId: f.plan.integrationId,
      operationId: f.intent.operationId, operationType: 'integration', operationDigest: operation.intentDigest,
      failureKind: 'conflict', evidenceId, evidenceDigest: hash(evidence), inputDigest: f.plan.inputDigest,
    },
    target: { repoIdentity: f.plan.target.repoIdentity, baselineCommitSha: f.plan.target.baseCommit,
      baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: f.plan.target.repoIdentity, baselineCommitSha: f.plan.target.baseCommit }) },
    workspace: { workspaceId: f.plan.integrationId, workspaceDigest: hash({ repoIdentity: f.intent.repoIdentity,
      worktreePath: f.intent.worktreePath, inputDigest: f.plan.inputDigest, baselineCommitSha: f.intent.expectedHead }) },
    conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts'],
    intent: { intentId: 'requirements', digest: digest('c') }, verification: { strategyId: 'combined-tests', digest: digest('d') },
    budget: { remainingAttempts: 2, remainingTokens: 100, remainingRuntimeMs: 1000, deadlineUtcMs: NOW + 5000 },
  }, { nowUtcMs: NOW });
  let clock = NOW + 2;
  const store = () => createSqliteGitAgentRepairStore(f.box.session, { nowUtcMs: () => clock });
  const service = () => createGitAgentRepairService({ atomic: f.box.atomic, store: store() });
  return { ...f, request, service, store, setClock(value: number) { clock = value; } };
}

function revised(request: ReturnType<typeof createGitAgentRepairRequest>, changes: Partial<GitAgentRepairAuthorizationInput>) {
  const { schemaVersion: _schema, authorizationDigest: _authorization, commandDigest: _command, ...body } = request;
  return createGitAgentRepairRequest({ ...body, ...changes }, { nowUtcMs: 0 });
}
function claimFor(f: Awaited<ReturnType<typeof fixture>>, attemptId = 'repair-attempt-1') {
  return { projectId: f.box.projectId, repairId: f.request.repairId, attemptId,
    ownerId: 'repair-owner', hostInstanceId: 'repair-host', authorizationVersion: 1 };
}
function output(status = 'failed', consumedTokens = 10, runtimeMs = 100, failureCode: string | null = null) {
  return { schemaVersion: 1, repairId: 'repair-1', status, changedPaths: status === 'modified' ? ['src/conflict.ts'] : [],
    usage: { consumedTokens, runtimeMs }, failureCode };
}
function runFor(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  return f.box.atomic.transact('read-repair-run', tx => tx.getExecutionRun(f.box.projectId, runId));
}
function batchFor(f: Awaited<ReturnType<typeof fixture>>) {
  return f.box.atomic.transact('read-parent-budget', tx => tx.getExecutionBatch(f.box.projectId, f.plan.batchId));
}

describe('P05-8 F-002 durable GitAgent orchestration', () => {
  it('[case:repair-run-idempotent] one authorization creates one Run in the original fixed Batch', async () => {
    const f = await fixture();
    const first = f.service().authorize(f.request);
    const replay = f.service().authorize(f.request);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ repairId: 'repair-1', parentBatchId: f.plan.batchId });
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM execution_batches').get()).toEqual({ n: 1 });
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 2 });
    expect(f.box.atomic.transact('read-repair-run', tx => tx.getExecutionRun(f.box.projectId, first.runId!)))
      .toMatchObject({ batchId: f.plan.batchId, purpose: 'git_agent_repair' });
    expect(() => f.service().authorize({ ...f.request, authorizationDigest: digest('a') }))
      .toThrow(expect.objectContaining({ kind: 'validation' }));
  });

  it('[case:repair-command-conflicts] aliases reuse the receipt; changed authorization or repair identity conflicts', async () => {
    const f = await fixture();
    const first = f.service().authorize(f.request);
    expect(f.service().authorize(revised(f.request, { commandId: 'alias-command' }))).toEqual(first);
    expect(() => f.service().authorize(revised(f.request, { writablePaths: ['src/conflict.ts', 'src/extra.ts'] })))
      .toThrow(expect.objectContaining({ kind: 'conflict' }));
    expect(() => f.service().authorize(revised(f.request, { repairId: 'another-repair' })))
      .toThrow(expect.objectContaining({ kind: 'conflict' }));
    expect(() => f.service().authorize(revised(f.request, { repairId: 'another-repair', commandId: 'another-command' })))
      .toThrow(expect.objectContaining({ kind: 'conflict' }));
    f.setClock(f.request.budget.deadlineUtcMs + 1);
    expect(f.service().authorize(f.request)).toEqual(first);
    expect(batchFor(f).runsCreated).toBe(2);
  });

  it('[case:repair-admission-and-retry] durable Attempt admission charges shared counters once and never replays a start', async () => {
    const f = await fixture();
    const receipt = f.service().authorize(f.request);
    const identity = claimFor(f);
    const first = f.service().claim(identity);
    expect(first).toMatchObject({ maxTokens: 100, maxRuntimeMs: 1000, authorizationVersion: 1 });
    expect(f.box.session.database.prepare('SELECT resource_key FROM feature_resource_leases WHERE resource_key = ?')
      .get(`project:${f.box.projectId}:worktree:${f.plan.integrationId}`)).toBeDefined();
    expect(f.service().claim(identity)).toBeNull();
    expect(f.service().claim(claimFor(f, 'competing-attempt'))).toBeNull();
    expect(batchFor(f)).toMatchObject({ runsCreated: 2, attemptsCreated: 1, runtimeStarts: 1 });
    expect(runFor(f, receipt.runId!).configSnapshot).toMatchObject({ childAgents: false });
    expect(f.service().settle(identity, output(), { stopped: true }).attempts[0]?.output).toEqual(output());
    const retry = f.service().claim(claimFor(f, 'repair-attempt-2'));
    expect(retry).toMatchObject({ maxTokens: 90, maxRuntimeMs: 900 });
    expect(batchFor(f)).toMatchObject({ runsCreated: 2, attemptsCreated: 2, runtimeStarts: 2 });
    f.service().settle(claimFor(f, 'repair-attempt-2'), output(), { stopped: true });
    expect(f.service().read(f.box.projectId, f.request.repairId).blockedReason).toBe('budget_exhausted');
    expect(f.service().claim(claimFor(f, 'repair-attempt-3'))).toBeNull();
    expect(batchFor(f).attemptsCreated).toBe(2);
    expect(f.box.session.database.prepare('SELECT DISTINCT status FROM tasks WHERE feature_id = ?').all(f.box.featureId))
      .toEqual([{ status: 'pending' }]);
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    expect(f.operations.getGitOperation(f.box.projectId, f.intent.operationId).status).toBe('failed');
  });

  it('[case:repair-persistent-restart] reopening SQLite reconstructs fixed input, owner, budgets and in-flight admission', async () => {
    const f = await fixture();
    const receipt = f.service().authorize(f.request);
    const identity = claimFor(f);
    f.service().claim(identity);
    const before = f.service().read(f.box.projectId, f.request.repairId);
    await f.box.reopen();
    expect(f.service().read(f.box.projectId, f.request.repairId)).toEqual(before);
    expect(f.service().authorize(f.request)).toEqual(receipt);
    expect(f.service().claim(identity)).toBeNull();
    expect(f.service().claim(claimFor(f, 'new-after-crash'))).toBeNull();
    expect(batchFor(f)).toMatchObject({ attemptsCreated: 1, runtimeStarts: 1 });
  });

  it('[case:repair-cancel-retains-writer] cancellation stays pending until verified stop and late output cannot revive Run or integration', async () => {
    const f = await fixture();
    const receipt = f.service().authorize(f.request);
    const identity = claimFor(f);
    const attempt = f.service().claim(identity)!;
    const cancel = f.box.atomic.transact('cancel-repair', tx => tx.requestExecutionCancel({
      projectId: f.box.projectId, targetKind: 'run', targetId: receipt.runId!,
      expectedRevision: tx.getExecutionRun(f.box.projectId, receipt.runId!).revision, commandId: 'cancel-repair',
    }));
    expect(cancel.outcome).toBe('cancelling');
    expect(() => f.box.session.transactWrite('unsafe-release', db => db.prepare("UPDATE run_dispatch_claims SET state = 'released', settled_at = ? WHERE id = ?")
      .run(NOW + 4, attempt.dispatch.claimId))).toThrow();
    expect(f.service().claim(claimFor(f, 'after-cancel'))).toBeNull();
    f.service().settle(identity, output('modified'), { stopped: true });
    expect(runFor(f, receipt.runId!).status).toBe('cancelling');
    expect(f.operations.getGitOperation(f.box.projectId, f.intent.operationId).status).toBe('failed');
    expect(f.box.session.database.prepare("SELECT state FROM execution_slot_claims WHERE id = ?").get(attempt.dispatch.slotId)).toEqual({ state: 'held' });
  });

  it('[case:repair-owner-fencing] wrong owner/authorization version and contradictory late result have zero writes', async () => {
    const f = await fixture();
    f.service().authorize(f.request);
    const identity = claimFor(f);
    f.service().claim(identity);
    const before = f.service().read(f.box.projectId, f.request.repairId);
    expect(() => f.service().settle({ ...identity, ownerId: 'old-owner' }, output(), { stopped: true }))
      .toThrow(expect.objectContaining({ kind: 'conflict' }));
    expect(() => f.service().settle({ ...identity, authorizationVersion: 2 }, output(), { stopped: true }))
      .toThrow(expect.objectContaining({ kind: 'conflict' }));
    expect(f.service().read(f.box.projectId, f.request.repairId)).toEqual(before);
    const settled = f.service().settle(identity, output(), { stopped: true });
    expect(f.service().settle(identity, output(), { stopped: true })).toEqual(settled);
    expect(() => f.service().settle(identity, output('modified'), { stopped: true }))
      .toThrow(expect.objectContaining({ kind: 'conflict' }));
    expect(batchFor(f)).toMatchObject({ attemptsCreated: 1, runtimeStarts: 1 });
  });

  it('[case:repair-pause-keeps-input-and-budget] pause waits for the admitted writer, then retains usage and original deadline', async () => {
    const f = await fixture();
    const receipt = f.service().authorize(f.request);
    const identity = claimFor(f);
    f.service().claim(identity);
    f.box.atomic.transact('pause-parent', tx => tx.requestExecutionPause({ projectId: f.box.projectId,
      targetKind: 'batch', targetId: f.plan.batchId, expectedRevision: tx.getExecutionBatch(f.box.projectId, f.plan.batchId).revision }));
    expect(batchFor(f).status).toBe('pausing');
    expect(runFor(f, receipt.runId!).status).toBe('pausing');
    expect(f.service().claim(claimFor(f, 'paused-attempt'))).toBeNull();
    const settled = f.service().settle(identity, output(), { stopped: true });
    expect(settled.blockedReason).toBeNull();
    expect(batchFor(f)).toMatchObject({ status: 'paused', attemptsCreated: 1, runtimeStarts: 1,
      deadlineAtUtcMs: BUDGET.batch.deadlineUtcMs });
    expect(settled.request).toEqual(f.request);
  });

  it.each(GIT_AGENT_REPAIR_HOLDS)('[case:repair-human-hold-%s] hold survives successful output and reauthorization', async reason => {
    const f = await fixture();
    f.service().authorize(f.request);
    const identity = claimFor(f);
    f.service().claim(identity);
    f.service().hold(f.box.projectId, f.request.repairId, reason);
    f.service().settle(identity, output('modified'), { stopped: true });
    f.service().authorize(f.request);
    expect(f.service().read(f.box.projectId, f.request.repairId).blockedReason).toBe(reason);
    expect(f.service().claim(claimFor(f, 'model-cleared-hold'))).toBeNull();
    expect(() => f.box.session.database.prepare('UPDATE git_agent_repairs SET blocked_reason = NULL WHERE repair_id = ?').run(f.request.repairId))
      .toThrow();
  });

  it('[case:repair-exhausted-before-dispatch] expired authorization persists exhaustion without a Run or Runtime start', async () => {
    const f = await fixture();
    f.setClock(f.request.budget.deadlineUtcMs);
    expect(f.service().authorize(f.request)).toMatchObject({ runId: null, blockedReason: 'budget_exhausted' });
    expect(f.service().claim(claimFor(f))).toBeNull();
    expect(batchFor(f)).toMatchObject({ runsCreated: 1, attemptsCreated: 0, runtimeStarts: 0 });
  });

  it('[case:repair-runtime-token-budget] cumulative tokens across retries cannot exceed the original grant', async () => {
    const f = await fixture();
    f.service().authorize(f.request);
    f.service().claim(claimFor(f));
    f.service().settle(claimFor(f), output('failed', 100), { stopped: true });
    expect(f.service().claim(claimFor(f, 'token-reset'))).toBeNull();
    expect(f.service().read(f.box.projectId, f.request.repairId).blockedReason).toBe('budget_exhausted');
    expect(batchFor(f).runtimeStarts).toBe(1);
  });

  it('[case:repair-runtime-time-budget] elapsed time and restored deadline bound retries even with zero reported time', async () => {
    const f = await fixture();
    f.service().authorize(f.request);
    f.service().claim(claimFor(f));
    f.setClock(NOW + 1002);
    f.service().settle(claimFor(f), output('failed', 1, 0), { stopped: true });
    expect(f.service().claim(claimFor(f, 'time-reset'))).toBeNull();
    expect(f.service().read(f.box.projectId, f.request.repairId).blockedReason).toBe('budget_exhausted');
  });

  it('[case:repair-unknown-stop-retained] unconfirmed stop persists output but does not permit retry or resource release', async () => {
    const f = await fixture();
    f.service().authorize(f.request);
    f.service().claim(claimFor(f));
    const result = f.service().settle(claimFor(f), output(), { stopped: false });
    expect(result).toMatchObject({ blockedReason: 'stop_unconfirmed', attempts: [{ stoppedAtUtcMs: null }] });
    expect(f.service().claim(claimFor(f, 'unsafe-recovery'))).toBeNull();
    await f.box.reopen();
    expect(f.service().read(f.box.projectId, f.request.repairId)).toEqual(result);
  });

  it('[case:repair-admission-rollback] slot failure rolls back claims, resources and counters and leaves a human hold', async () => {
    const f = await fixture();
    f.service().authorize(f.request);
    f.box.session.database.exec("CREATE TRIGGER reject_repair_slot BEFORE INSERT ON execution_slot_claims BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END");
    // SQLite constraint errors become structured admission conflicts in the existing slot adapter.
    expect(f.service().claim(claimFor(f))).toBeNull();
    expect(batchFor(f)).toMatchObject({ attemptsCreated: 0, runtimeStarts: 0 });
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM run_dispatch_claims').get()).toEqual({ n: 0 });
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM feature_resource_leases').get()).toEqual({ n: 0 });
    expect(f.service().read(f.box.projectId, f.request.repairId).blockedReason).toBe('identity_or_lock');
  });

  it('[case:repair-scheduler-isolation] persistent compensation routes repairs before coding DAG and records missing consumer', async () => {
    const f = await fixture();
    const receipt = f.service().authorize(f.request);
    const dag = { evaluate: vi.fn(() => { throw new Error('repair must never evaluate coding DAG'); }) };
    const store = createSqliteSchedulerStore(f.box.session);
    const scheduler = createWorkScheduler({ store, dag });
    const result = await scheduler.scan();
    expect(result.runs.find(r => r.runId === receipt.runId)).toMatchObject({ capabilityGaps: ['git_agent_repair_consumer'], claimed: false });
    expect(dag.evaluate).not.toHaveBeenCalled();
    await scheduler.close();
    const consume = vi.fn(async () => { f.service().claim(claimFor(f)); });
    const next = createWorkScheduler({ store, dag, gitAgentRepair: { consume } });
    await next.scan();
    expect(consume).toHaveBeenCalledOnce();
    expect(dag.evaluate).not.toHaveBeenCalled();
    await next.close();
  });

  it.each([true, false])('[case:repair-coding-usage-%s] known coding consumption reduces parent token quota and unknown consumption blocks', async known => {
    const { maxCostTotal: _cost, ...batch } = BUDGET.batch;
    const f = await fixture({ batch: { ...batch, maxTokenTotal: 50 }, run: BUDGET.run });
    recordVerifiedPass(f.box, { batchId: f.plan.batchId, runId: f.plan.runId }, 't-1');
    if (known) f.box.session.database.prepare('UPDATE attempts SET usage_summary = ? WHERE id = ?').run(JSON.stringify({
      schemaVersion: 1, inputTokens: 10, outputTokens: 20, costMicros: null, currency: null,
    }), 't-1-attempt');
    const receipt = f.service().authorize(f.request);
    if (known) expect(f.service().claim(claimFor(f))).toMatchObject({ maxTokens: 20 });
    else expect(receipt).toMatchObject({ runId: null, blockedReason: 'budget_exhausted' });
    expect(f.box.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1')).toEqual({ status: 'passed' });
  });

  it('[case:repair-integration-worktree-occupied] a different owner of the integration workspace blocks repair without partial claims', async () => {
    const f = await fixture();
    f.service().authorize(f.request);
    f.box.atomic.transact('occupy-integration-workspace', () => {
      const resources = createSqliteFeatureResourceAccess(f.box.session, { nowUtcMs: () => NOW + 2 });
      resources.acquireInTransaction({ resourceSet: resources.normalize({ projectId: f.box.projectId,
        resources: [{ projectId: f.box.projectId, kind: 'worktree_write_exclusive', key: `worktree:${f.plan.integrationId}` }] }),
        owner: { ownerId: 'unconfirmed-old-owner', ownerVersion: 1 }, leaseUntilUtcMs: NOW + 100_000 });
    });
    expect(f.service().claim(claimFor(f))).toBeNull();
    expect(f.service().read(f.box.projectId, f.request.repairId).blockedReason).toBe('identity_or_lock');
    expect(batchFor(f)).toMatchObject({ attemptsCreated: 0, runtimeStarts: 0 });
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM run_dispatch_claims').get()).toEqual({ n: 0 });
    expect(f.box.session.database.prepare('SELECT owner_id, state FROM feature_resource_leases').all())
      .toEqual([{ owner_id: 'unconfirmed-old-owner', state: 'held' }]);
  });

  it('[case:repair-persisted-conflict-journal] a pending integration authorizes repair only through its persisted conflict observation', async () => {
    const f = await fixture(undefined, true, 'journal');
    expect(f.operations.getGitOperation(f.box.projectId, f.intent.operationId).status).toBe('pending');
    const receipt = f.service().authorize(f.request);
    expect(receipt.runId).not.toBeNull();
    expect(f.service().claim(claimFor(f))).not.toBeNull();
    expect(f.operations.getGitOperation(f.box.projectId, f.intent.operationId)).toMatchObject({ status: 'pending', integrationResult: null });
  });

  it('[case:repair-core-assembly] production Core assembly exposes the same durable receipt without starting Runtime', async () => {
    const f = await fixture();
    const core = await openCoreApplication({ dataRoot: f.box.box.dataRoot, capabilityCatalog: f.box.box.capabilityCatalog, nowUtcMs: () => NOW + 2 });
    try {
      const receipt = core.gitAgentRepair.authorize(f.request);
      expect(f.service().authorize(f.request)).toEqual(receipt);
      expect(core.gitAgentRepair.read(f.box.projectId, f.request.repairId).request).toEqual(f.request);
      expect(batchFor(f)).toMatchObject({ runsCreated: 2, attemptsCreated: 0, runtimeStarts: 0 });
    } finally { await core.workExecution.close(); core.close(); }
  });

  it('[case:repair-risk-before-run] an authorized high-risk request persists a hold without a repair Run', async () => {
    const f = await fixture();
    const receipt = f.service().authorize(f.request, 'high_risk_delete');
    expect(receipt).toMatchObject({ runId: null, blockedReason: 'high_risk_delete' });
    expect(f.service().authorize(f.request)).toEqual(receipt);
    expect(batchFor(f).runsCreated).toBe(1);
  });

  it('[case:repair-process-race] two SQLite processes create one Run and admit only one repair writer', async () => {
    const f = await fixture();
    const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-repair-race-' });
    const scriptPath = fileURLToPath(new URL('../../helpers/p05-8-repair-race-child.ts', import.meta.url));
    try {
      const authorizations = await runBarrierChildren(environment, { scriptPath,
        configs: [1, 2].map(() => ({ dbPath: f.box.box.dbPath, now: NOW + 2, mode: 'authorize', request: f.request })),
        readyTimeoutMs: 10_000, resultTimeoutMs: 10_000 });
      expect(authorizations.every(child => child.exit.code === 0)).toBe(true);
      expect(authorizations[0]!.result.record).toEqual(authorizations[1]!.result.record);
      expect(batchFor(f).runsCreated).toBe(2);
      const admissions = await runBarrierChildren(environment, { scriptPath,
        configs: [1, 2].map(n => ({ dbPath: f.box.box.dbPath, now: NOW + 2, mode: 'claim', input: claimFor(f, `racing-attempt-${n}`) })),
        readyTimeoutMs: 10_000, resultTimeoutMs: 10_000 });
      expect(admissions.every(child => child.exit.code === 0)).toBe(true);
      expect(admissions.filter(child => child.result.record !== null)).toHaveLength(1);
      for (const child of [...authorizations, ...admissions]) expect(() => process.kill(child.pid, 0)).toThrow();
      expect(batchFor(f)).toMatchObject({ attemptsCreated: 1, runtimeStarts: 1 });
      expect(f.box.session.database.pragma('foreign_key_check')).toEqual([]);
    } finally { await environment.dispose(); }
  });

  it('[case:repair-parent-token-cumulative] parent token ceiling includes prior repair consumption and limits the next admission', async () => {
    const { maxCostTotal: _cost, ...batch } = BUDGET.batch;
    const f = await fixture({ batch: { ...batch, maxTokenTotal: 15 }, run: BUDGET.run });
    f.service().authorize(f.request);
    expect(f.service().claim(claimFor(f))).toMatchObject({ maxTokens: 15 });
    f.service().settle(claimFor(f), output('failed', 10), { stopped: true });
    expect(f.service().claim(claimFor(f, 'parent-token-retry'))).toMatchObject({ maxTokens: 5 });
    f.service().settle(claimFor(f, 'parent-token-retry'), output('failed', 5), { stopped: true });
    expect(f.service().read(f.box.projectId, f.request.repairId).blockedReason).toBe('budget_exhausted');
    expect(batchFor(f).budgetSnapshot.batch.maxTokenTotal).toBe(15);
  });

  it('[case:repair-parent-start-budget] source Runtime starts reduce repair availability without increasing the parent cap', async () => {
    const f = await fixture();
    f.box.session.database.prepare('UPDATE execution_batches SET runtime_starts = 1 WHERE id = ?').run(f.plan.batchId);
    f.service().authorize(f.request);
    f.service().claim(claimFor(f));
    f.service().settle(claimFor(f), output(), { stopped: true });
    expect(f.service().claim(claimFor(f, 'fallback-reset'))).toBeNull();
    expect(batchFor(f)).toMatchObject({ runtimeStarts: 2, attemptsCreated: 1 });
    expect(batchFor(f).budgetSnapshot.batch.maxRuntimeStarts).toBe(2);
    expect(f.service().read(f.box.projectId, f.request.repairId).blockedReason).toBe('budget_exhausted');
  });

  it('[case:repair-parent-run-budget] exhausted parent Run budget persists a hold without creating a hidden Batch', async () => {
    const f = await fixture();
    f.box.session.database.prepare('UPDATE execution_batches SET runs_created = ? WHERE id = ?').run(BUDGET.batch.maxRuns, f.plan.batchId);
    const receipt = f.service().authorize(f.request);
    expect(receipt).toMatchObject({ runId: null, blockedReason: 'budget_exhausted' });
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM execution_batches').get()).toEqual({ n: 1 });
  });

  it('[case:repair-unconfirmed-parent-cost] configured cost cap with unknown usage cannot authorize a repair', async () => {
    const f = await fixture(BUDGET);
    expect(f.service().authorize(f.request)).toMatchObject({ runId: null, blockedReason: 'budget_exhausted' });
    expect(batchFor(f).runsCreated).toBe(1);
  });

  it('[case:repair-deadline-before-claim] expiration after authorization prevents any Attempt or Runtime admission', async () => {
    const f = await fixture();
    f.service().authorize(f.request);
    f.setClock(f.request.budget.deadlineUtcMs);
    expect(f.service().claim(claimFor(f))).toBeNull();
    expect(f.service().read(f.box.projectId, f.request.repairId).blockedReason).toBe('budget_exhausted');
    expect(batchFor(f)).toMatchObject({ attemptsCreated: 0, runtimeStarts: 0 });
  });

  it('[case:repair-invalid-result-retained] out-of-scope output cannot become stop proof or unlock successor', async () => {
    const f = await fixture();
    f.service().authorize(f.request);
    f.service().claim(claimFor(f));
    const result = f.service().settle(claimFor(f), { ...output('modified'), changedPaths: ['outside.ts'], passed: true }, { stopped: true });
    expect(result).toMatchObject({ blockedReason: 'invalid_runtime_output', attempts: [{ stoppedAtUtcMs: null, output: null }] });
    expect(f.service().claim(claimFor(f, 'after-invalid-output'))).toBeNull();
    expect(f.operations.getGitOperation(f.box.projectId, f.intent.operationId)).toMatchObject({ status: 'failed', integrationResult: null });
  });

  it('[case:repair-failure-evidence] forged failure proof, workspace drift and unconfirmed owner are refused before Run creation', async () => {
    const f = await fixture(undefined, false);
    expect(() => f.service().authorize(revised(f.request, { source: { ...f.request.source, evidenceDigest: digest('a') } })))
      .toThrow(expect.objectContaining({ details: { reason: 'failure_evidence_mismatch' } }));
    expect(() => f.service().authorize(revised(f.request, { workspace: { ...f.request.workspace, workspaceDigest: digest('a') } })))
      .toThrow(expect.objectContaining({ details: { reason: 'workspace_identity_mismatch' } }));
    f.box.session.database.prepare("UPDATE runs SET status = 'interrupted' WHERE id = ?").run(f.plan.runId);
    expect(f.service().authorize(f.request)).toMatchObject({ runId: null, blockedReason: 'identity_or_lock' });
    expect(batchFor(f)).toMatchObject({ runsCreated: 1, attemptsCreated: 0, runtimeStarts: 0 });
  });

  it('[case:repair-authorization-version] budget revision changes cannot enlarge an already frozen repair authorization', async () => {
    const f = await fixture();
    f.service().authorize(f.request);
    f.box.atomic.transact('revise-parent', tx => tx.reviseBatchBudget({ projectId: f.box.projectId, batchId: f.plan.batchId,
      expectedBudgetRevision: 1, budgetSnapshot: { ...batchForOutside(tx, f.box.projectId, f.plan.batchId).budgetSnapshot,
        batch: { ...batchForOutside(tx, f.box.projectId, f.plan.batchId).budgetSnapshot.batch, maxRuntimeStarts: 3 } },
      reason: 'explicit parent revision', approvedBy: 'owner' }));
    expect(f.service().claim(claimFor(f))).toBeNull();
    expect(f.service().read(f.box.projectId, f.request.repairId)).toMatchObject({ authorizationVersion: 1, blockedReason: 'identity_or_lock', request: f.request });
  });
});

function batchForOutside(tx: import('../../../packages/core/src/ports/atomic-commands.ts').CommandTransaction, projectId: string, batchId: string) {
  return tx.getExecutionBatch(projectId, batchId);
}
