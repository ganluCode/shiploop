import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIntegrationGitWorkspace } from '../../../packages/core/src/adapters/fs/integration-git-workspace.ts';
import { describe, expect, it } from 'vitest';
import { createDeterministicIntegrationService } from '../../../packages/core/src/application/deterministic-integration.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteGitIntegrationJournal } from '../../../packages/core/src/adapters/sqlite/git-integration-journal.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { createIntegrationExecutionPlan, computeCoveredInputDigest } from '../../../packages/core/src/ports/integration-execution-plan.ts';
import type { IntegrationWorkspaceAdapter, IntegrationWorkspaceHandle } from '../../../packages/core/src/ports/integration-workspace.ts';
import { normalizeFeatureResourceSet } from '../../../packages/core/src/ports/feature-resources.ts';
import { openBudgetFixture, NOW } from '../../helpers/p03-3/budget-fixture.ts';

const sha = (s: string) => s.repeat(40);
const digest = (s: string) => s.repeat(64);
function freezeSource(box: Awaited<ReturnType<typeof openBudgetFixture>>, plan: ReturnType<typeof createIntegrationExecutionPlan>) {
  const predecessorRevisions: Record<string, number> = {};
  for (const predecessor of plan.predecessors) {
    box.session.database.prepare(`INSERT OR IGNORE INTO features
      (id, created_at, project_id, updated_at, phase_id, title, status, plan_status, labels, source_refs, delivery_status)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', 'approved', '[]', '[]', 'succeeded')`)
      .run(predecessor.featureId, NOW, box.projectId, NOW, plan.phaseId, predecessor.featureId);
    predecessorRevisions[predecessor.featureId] = 1;
  }
  const frozen = box.atomic.transact('freeze-source', tx => {
    const source = tx.createIntegrationPlan({ projectId: plan.projectId, phaseId: plan.phaseId, batchId: plan.batchId,
      successorFeatureId: plan.successorFeatureId, targetBaseline: plan.target.baseCommit,
      predecessors: plan.predecessors.map(p => ({ projectId: p.projectId, phaseId: p.phaseId, featureId: p.featureId,
        dependencyPassed: p.dependencyPassed, coveredInputIds: p.coveredInputIds, ancestorVerified: true,
        delivery: { commitSha: p.delivery!.commitSha, evidenceId: p.delivery!.evidenceId, evidenceDigest: p.delivery!.evidenceDigest } })),
      approvedInputs: plan.approvedInputs, mergeOrder: plan.mergeOrder, verificationScope: plan.verificationScope,
      strategySummary: {}, integrationResult: null });
    return tx.freezeIntegrationPlan({ projectId: plan.projectId, integrationId: source.integrationId, expectedRevision: source.revision });
  });
  return { sourcePlanId: frozen.integrationId, sourcePlanRevision: frozen.revision, predecessorRevisions };
}

async function fixture() {
  const box = await openBudgetFixture();
  const ids = await box.start();
  const binding = box.atomic.transact('fixture', tx => tx.getRepositoryBinding(box.projectId));
  const feature = box.atomic.transact('fixture', tx => tx.getFeaturePlan(box.projectId, box.featureId).feature);
  const approvedInputs = [{ inputId: 'input-a', digest: digest('a') }];
  const plan = createIntegrationExecutionPlan({ projectId: box.projectId, phaseId: feature.phaseId,
    batchId: ids.batchId, runId: ids.runId, successorFeatureId: box.featureId,
    target: { baseCommit: sha('b'), repoIdentity: binding.repoIdentity,
      canonicalPath: binding.canonicalPath, gitCommonDir: binding.gitCommonDir },
    approvedInputs, mergeOrder: ['predecessor-a'], verificationScope: ['combined-tests'], integrationResult: null,
    predecessors: [{ projectId: box.projectId, phaseId: feature.phaseId, batchId: ids.batchId,
      runId: ids.runId, featureId: 'predecessor-a', dependencyPassed: true, coveredInputIds: ['input-a'],
      delivery: { commitSha: sha('c'), repoIdentity: binding.repoIdentity,
        inputDigest: computeCoveredInputDigest(approvedInputs), evidenceId: 'delivery-a', evidenceDigest: digest('d') } }],
  });
  const intent = { operationId: plan.integrationId, projectId: box.projectId, featureId: box.featureId,
    runId: ids.runId, attemptId: null, executionVersion: 1, operationType: 'integration' as const,
    repositoryBindingId: binding.id, repoIdentity: binding.repoIdentity, worktreePath: `${box.box.root}/integration`,
    expectedHead: plan.target.baseCommit, candidateTree: plan.target.baseCommit, codeDigest: plan.inputDigest,
    verificationRefs: [], approvalRefs: [], message: 'integration',
    gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true as const },
    deliveryPolicyDigest: digest('e'), runtimeSource: null, ownerId: 'owner-1', hostInstanceId: 'host-1',
    integrationPlan: plan, budgetSnapshot: { ownerVersion: 1, ...freezeSource(box, plan) }, expectedFeatureRevision: feature.revision };
  const resourceSet = normalizeFeatureResourceSet({ projectId: box.projectId,
    resources: [{ projectId: box.projectId, kind: 'feature_code_shared', key: 'feature-code' },
      { projectId: box.projectId, kind: 'worktree_write_exclusive', key: `worktree:${plan.integrationId}` }] });
  let authorization = { intent, approvalCurrent: true, budgetAllowed: true, ownerVersion: 1,
    resourceSet, leases: resourceSet.resources.map(resource => ({ id: randomUUID(), projectId: box.projectId,
      resource, ownerId: intent.ownerId, ownerVersion: 1, revision: 1, acquiredAtUtcMs: NOW,
      leaseUntilUtcMs: NOW + 100_000, state: 'held' as const, waitingReason: null, releasedAtUtcMs: null })),
    writerIdentity: { launchId: 'old-writer' } };
  const request = { projectId: box.projectId, operationId: plan.integrationId, commandId: randomUUID(),
    expectedFeatureRevision: feature.revision, inputDigest: plan.inputDigest };
  const journal = createSqliteGitIntegrationJournal(box.session, { nowUtcMs: () => NOW + 1 });
  const operations = createSqliteGitOperationStore(box.session);
  const calls: string[] = [];
  let stopped = true;
  const workspace: IntegrationWorkspaceAdapter = {
    async prepare(input) {
      expect(box.session.database.inTransaction).toBe(false);
      expect(operations.getGitOperation(box.projectId, plan.integrationId).status).toBe('pending');
      calls.push('prepare');
      input.beforeWrite?.();
      const handle: IntegrationWorkspaceHandle = { workspaceId: 'workspace-1', ownerId: intent.ownerId,
        ownerVersion: 1, path: intent.worktreePath, gitCommonDir: plan.target.gitCommonDir,
        repoIdentity: plan.target.repoIdentity, targetBase: plan.target.baseCommit, plan, gitIdentity: intent.gitIdentity,
        status: 'ready', currentHead: sha('b'), steps: [],
        facts: { head: sha('b'), tree: sha('f'), parents: [], statusPorcelain: '', unresolvedPaths: [] } };
      return { status: 'ready', reason: null, workspace: handle, details: {} };
    },
    async merge(handle) {
      expect(box.session.database.inTransaction).toBe(false);
      calls.push('merge');
      const steps = [{ ordinal: 1, featureId: 'predecessor-a', inputSha: sha('c'), parentBefore: sha('b'),
        parents: [sha('b'), sha('c')], commitSha: sha('1'), treeSha: sha('2'), status: 'succeeded' as const }];
      return { status: 'succeeded', reason: null, details: {}, steps,
        workspace: { ...handle, steps, status: 'succeeded', currentHead: sha('1'), facts: {
          head: sha('1'), tree: sha('2'), parents: [sha('b'), sha('c')], statusPorcelain: '', unresolvedPaths: [] } } };
    },
    async cleanup() { throw new Error('must retain candidate'); },
  };
  const makeService = (adapter = workspace) => createDeterministicIntegrationService({ atomic: box.atomic,
    journal: createSqliteGitIntegrationJournal(box.session, { nowUtcMs: () => NOW + 1 }),
    workspace: adapter, readAuthorization: () => structuredClone(authorization),
    verifyWriterStopped: async () => { expect(box.session.database.inTransaction).toBe(false); return stopped; }, nowUtcMs: () => NOW + 1 });
  return { box, plan, intent, request, journal, operations, workspace, calls, makeService,
    get authorization() { return authorization; }, set authorization(value) { authorization = value; },
    setStopped(value: boolean) { stopped = value; } };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  } }).trim();
}
function realGit(f: Awaited<ReturnType<typeof fixture>>, conflict = false) {
  const repo = f.plan.target.canonicalPath;
  const base = git(repo, 'rev-parse', 'HEAD');
  const shas = ['a', 'b'].map(letter => {
    const path = join(f.box.box.root, `predecessor-${letter}`);
    git(repo, 'worktree', 'add', '--detach', path, base);
    writeFileSync(join(path, conflict ? 'shared.txt' : `${letter}.txt`), `${letter}\n`);
    git(path, 'add', '.');
    git(path, 'commit', '-m', `independent ${letter}`);
    const commit = git(path, 'rev-parse', 'HEAD');
    git(repo, 'worktree', 'remove', path);
    return commit;
  });
  const approvedInputs = ['a', 'b'].map(letter => ({ inputId: `input-${letter}`, digest: digest(letter) }));
  const { schemaVersion: _schema, integrationId: _id, inputDigest: _digest, status: _status, ...input } = f.plan;
  const plan = createIntegrationExecutionPlan({ ...input, target: { ...input.target, baseCommit: base }, approvedInputs,
    mergeOrder: ['predecessor-a', 'predecessor-b'], predecessors: shas.map((commitSha, i) => ({
      ...input.predecessors[0]!, featureId: `predecessor-${i === 0 ? 'a' : 'b'}`, coveredInputIds: [approvedInputs[i]!.inputId],
      delivery: { ...input.predecessors[0]!.delivery!, commitSha, inputDigest: computeCoveredInputDigest([approvedInputs[i]!]) },
    })) });
  f.authorization.intent = { ...f.intent, operationId: plan.integrationId, integrationPlan: plan,
    expectedHead: base, candidateTree: base, codeDigest: plan.inputDigest,
    budgetSnapshot: { ownerVersion: 1, ...freezeSource(f.box, plan) } };
  const resourceSet = normalizeFeatureResourceSet({ projectId: f.box.projectId,
    resources: [{ projectId: f.box.projectId, kind: 'feature_code_shared', key: 'feature-code' },
      { projectId: f.box.projectId, kind: 'worktree_write_exclusive', key: `worktree:${plan.integrationId}` }] });
  f.authorization.resourceSet = resourceSet;
  f.authorization.leases = resourceSet.resources.map(resource => ({ ...f.authorization.leases[0]!, id: randomUUID(), resource }));
  const request = { ...f.request, operationId: plan.integrationId, inputDigest: plan.inputDigest };
  const adapter = createIntegrationGitWorkspace({ confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) });
  return { repo, base, shas, plan, request, adapter, path: f.intent.worktreePath };
}

describe('P05-7 F-004 deterministic integration application', () => {
  it('[case:integration-pending-candidate-replay] persists intent before I/O and replays a candidate without unlocking successor', async () => {
    const f = await fixture();
    try {
      const result = await f.makeService().start(f.request);
      expect(result.outcome).toBe('pending_verification');
      expect(result.workspace?.facts.head).toBe(sha('1'));
      expect(result.steps[0]?.parents).toEqual([sha('b'), sha('c')]);
      expect(f.operations.getGitOperation(f.box.projectId, f.plan.integrationId)).toMatchObject({ status: 'pending', receipt: null });
      f.box.reopen();
      const replay = await f.makeService().start(f.request);
      const another = await f.makeService().start({ ...f.request, commandId: randomUUID() });
      expect(replay).toEqual(result);
      expect(another).toEqual(result);
      expect(f.calls).toEqual(['prepare', 'merge']);
      const source = f.box.atomic.transact('read-source', tx => tx.getIntegrationPlan(f.box.projectId, f.intent.budgetSnapshot.sourcePlanId));
      expect(source.status).not.toBe('integration_passed');
      expect(source.integrationResult).toMatchObject({ operationId: f.plan.integrationId, operationStatus: 'pending', verificationEvidence: null });
      expect(f.box.atomic.transact('read', tx => tx.getFeaturePlan(f.box.projectId, f.box.featureId).feature).status).not.toBe('completed');
    } finally { f.box.close(); }
  });

  it.each(['approval', 'budget', 'revision', 'repo', 'owner', 'occupancy', 'conflicting-lease', 'expired-lease', 'digest', 'writer'] as const)(
    '[case:integration-admission-%s] rejects invalid admission without external Git I/O', async reason => {
      const f = await fixture();
      try {
        if (reason === 'approval') f.authorization.approvalCurrent = false;
        if (reason === 'budget') f.authorization.budgetAllowed = false;
        if (reason === 'revision') f.request.expectedFeatureRevision++;
        if (reason === 'repo') f.authorization.intent.repositoryBindingId = 'wrong-binding';
        if (reason === 'owner') f.authorization.ownerVersion++;
        if (reason === 'occupancy') f.authorization.leases = [];
        if (reason === 'conflicting-lease') f.authorization.leases.push({ ...f.authorization.leases[1]!, id: randomUUID(), ownerId: 'another-owner' });
        if (reason === 'expired-lease') f.authorization.leases[0]!.leaseUntilUtcMs = NOW;
        if (reason === 'digest') f.request.inputDigest = digest('f');
        if (reason === 'writer') f.setStopped(false);
        await expect(f.makeService().start(f.request)).rejects.toBeDefined();
        expect(f.calls).toEqual([]);
        expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_operations').get()).toEqual({ count: 0 });
      } finally { f.box.close(); }
    });

  it.each(['plan', 'predecessor'] as const)('[case:integration-persisted-%s-revision] rejects changed frozen business facts in Core', async target => {
    const f = await fixture();
    try {
      if (target === 'plan') f.box.session.database.prepare('UPDATE integration_plans SET revision = revision + 1 WHERE id = ?')
        .run(f.intent.budgetSnapshot.sourcePlanId);
      else f.box.session.database.prepare('UPDATE features SET revision = revision + 1 WHERE id = ?').run('predecessor-a');
      await expect(f.makeService().start(f.request)).rejects.toMatchObject({ details: {
        reason: target === 'plan' ? 'frozen_plan_changed' : 'predecessor_changed',
      } });
      expect(f.calls).toEqual([]);
    } finally { f.box.close(); }
  });

  it('[case:integration-unconfirmed-io-blocks-replay] persists an unknown stop observation without releasing or retrying the workspace', async () => {
    const f = await fixture();
    try {
      const adapter: IntegrationWorkspaceAdapter = { ...f.workspace, async prepare(input) {
        await f.workspace.prepare(input);
        return { status: 'unknown', reason: 'stop_unconfirmed', workspace: null, details: {} };
      } };
      const result = await f.makeService(adapter).start(f.request);
      expect(result).toMatchObject({ outcome: 'unknown', reason: 'stop_unconfirmed' });
      expect(await f.makeService(adapter).start(f.request)).toEqual(result);
      expect(f.calls).toEqual(['prepare']);
      expect(f.operations.getGitOperation(f.box.projectId, f.plan.integrationId).status).toBe('pending');
    } finally { f.box.close(); }
  });

  it('[case:integration-journal-corrupt-fail-closed] rejects reordered parents and corrupted stored observations', async () => {
    const f = await fixture();
    try {
      const result = await f.makeService().start(f.request);
      const invalid = structuredClone(result);
      (invalid.steps[0]!.parents as string[]).reverse();
      expect(() => f.box.atomic.transact('invalid-facts', tx => f.journal.append(tx, f.box.projectId, f.plan.integrationId, 1, invalid))).toThrow();
      f.box.session.database.exec('DROP TRIGGER git_integration_observations_immutable');
      f.box.session.database.prepare("UPDATE git_integration_observations SET observation = '{}'").run();
      await expect(f.makeService().start(f.request)).rejects.toMatchObject({ kind: 'corrupt' });
      expect(f.calls).toEqual(['prepare', 'merge']);
    } finally { f.box.close(); }
  });

  it('[case:integration-persisted-budget-exhausted] rechecks the actual cumulative Batch budget in the intent transaction', async () => {
    const f = await fixture();
    try {
      f.box.session.database.prepare('UPDATE execution_batches SET runtime_starts = ? WHERE id = ?')
        .run(f.box.budget.batch.maxRuntimeStarts, f.plan.batchId);
      await expect(f.makeService().start(f.request)).rejects.toMatchObject({ details: { reason: 'budget_exhausted' } });
      expect(f.calls).toEqual([]);
    } finally { f.box.close(); }
  });

  it('[case:integration-refuses-reused-command-and-intent] rejects a changed intent or reused command digest without repeating Git', async () => {
    const f = await fixture();
    try {
      await f.makeService().start(f.request);
      f.authorization.intent.message = 'changed intent';
      await expect(f.makeService().start({ ...f.request, commandId: randomUUID() }))
        .rejects.toMatchObject({ details: { reason: 'intent_conflict' } });
      f.authorization.intent.message = 'integration';
      expect(() => f.box.atomic.transact('claim-conflict', tx => f.journal.claim(tx, f.request, digest('f'))))
        .toThrow(expect.objectContaining({ details: { reason: 'idempotency_key_reuse' } }));
      expect(f.calls).toEqual(['prepare', 'merge']);
    } finally { f.box.close(); }
  });

  it('[case:integration-concurrent-call-no-replay] a competing service cannot start the same pending operation', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const adapter: IntegrationWorkspaceAdapter = { ...f.workspace, async prepare(input) {
      const result = await f.workspace.prepare(input);
      entered();
      await barrier;
      return result;
    } };
    const second = openSqliteStorageSession({ path: f.box.box.dbPath });
    const competitor = createDeterministicIntegrationService({ atomic: createSqliteAtomicCommandStore(second),
      journal: createSqliteGitIntegrationJournal(second), workspace: f.workspace,
      readAuthorization: () => structuredClone(f.authorization), verifyWriterStopped: async () => true, nowUtcMs: () => NOW + 1 });
    const first = f.makeService(adapter).start(f.request);
    try {
      await ready;
      await expect(competitor.start({ ...f.request, commandId: randomUUID() }))
        .rejects.toMatchObject({ details: { reason: 'reconciliation_required' } });
      release();
      expect((await first).outcome).toBe('pending_verification');
      expect(f.calls).toEqual(['prepare', 'merge']);
    } finally { release(); await first.catch(() => {}); second.close(); f.box.close(); }
  });

  it('[case:integration-uncertain-side-effect-retained] a lost merge response leaves intent for reconciliation and never repeats Git', async () => {
    const f = await fixture();
    try {
      const adapter: IntegrationWorkspaceAdapter = { ...f.workspace, async merge(handle) {
        await f.workspace.merge(handle);
        throw new Error('lost response after commit');
      } };
      await expect(f.makeService(adapter).start(f.request)).rejects.toThrow('lost response after commit');
      await expect(f.makeService().start(f.request)).rejects.toMatchObject({ details: { reason: 'reconciliation_required' } });
      expect(f.calls).toEqual(['prepare', 'merge']);
      expect(f.operations.getGitOperation(f.box.projectId, f.plan.integrationId).status).toBe('pending');
    } finally { f.box.close(); }
  });

  it('[case:integration-authority-drift-before-write] rechecks authority at the external-write boundary and rejects late facts', async () => {
    const f = await fixture();
    try {
      const adapter: IntegrationWorkspaceAdapter = { ...f.workspace, async prepare(input) {
        f.authorization.ownerVersion++;
        input.beforeWrite!();
        return f.workspace.prepare(input);
      } };
      await expect(f.makeService(adapter).start(f.request)).rejects.toMatchObject({ details: { reason: 'owner_fenced' } });
      expect(f.calls).toEqual([]);
      expect(f.operations.getGitOperation(f.box.projectId, f.plan.integrationId).status).toBe('pending');
    } finally { f.box.close(); }
  });

  it('[case:integration-real-git-ordered-pending] merges real A/B in frozen order and durably preserves each parent/tree without changing main', async () => {
    const f = await fixture();
    try {
      const real = realGit(f);
      const beforeRefs = git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
      const result = await f.makeService(real.adapter).start(real.request);
      expect(result.outcome).toBe('pending_verification');
      expect(result.steps.map(step => step.inputSha)).toEqual(real.shas);
      expect(result.steps[0]!.parentBefore).toBe(real.base);
      expect(result.steps[1]!.parentBefore).toBe(result.steps[0]!.commitSha);
      expect(result.steps.every(step => git(real.path, 'show', '-s', '--format=%T', step.commitSha) === step.treeSha)).toBe(true);
      expect(readFileSync(join(real.path, 'a.txt'), 'utf8')).toBe('a\n');
      expect(readFileSync(join(real.path, 'b.txt'), 'utf8')).toBe('b\n');
      expect(git(real.repo, 'rev-parse', 'HEAD')).toBe(real.base);
      expect(git(real.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(beforeRefs);
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_integration_observations').get()).toEqual({ count: 3 });
      const beforeCount = git(real.path, 'rev-list', '--count', 'HEAD');
      f.box.reopen();
      expect(await f.makeService(real.adapter).start(real.request)).toEqual(result);
      expect(git(real.path, 'rev-list', '--count', 'HEAD')).toBe(beforeCount);
      expect(existsSync(real.path)).toBe(true);
    } finally { f.box.close(); }
  });

  it.each(['conflict', 'baseline', 'dirty'] as const)('[case:integration-real-git-%s] blocks and preserves independent predecessor commits', async failure => {
    const f = await fixture();
    try {
      const real = realGit(f, failure === 'conflict');
      if (failure === 'baseline') {
        writeFileSync(join(real.repo, 'drift.txt'), 'drift\n');
        git(real.repo, 'add', '.');
        git(real.repo, 'commit', '-m', 'target changed');
      }
      if (failure === 'dirty') writeFileSync(join(real.repo, 'dirty.txt'), 'dirty\n');
      const result = await f.makeService(real.adapter).start(real.request);
      expect(result.outcome).toBe('blocked');
      expect(result.reason).toBe(failure === 'conflict' ? 'merge_conflict' : failure === 'baseline' ? 'target_head_drift' : 'source_dirty');
      for (const commit of real.shas) expect(git(real.repo, 'cat-file', '-t', commit)).toBe('commit');
      if (failure === 'conflict') {
        expect(result.steps).toHaveLength(1);
        expect(git(real.path, 'ls-files', '-u')).not.toBe('');
        expect(readFileSync(join(real.path, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
      }
      expect(await f.makeService(real.adapter).start(real.request)).toEqual(result);
      expect(f.operations.getGitOperation(f.box.projectId, real.plan.integrationId).status).toBe('pending');
    } finally { f.box.close(); }
  });

  it('[case:integration-real-git-owner-drift-between-inputs] fences authority changed after a durable first merge before the next mutation', async () => {
    const f = await fixture();
    try {
      const real = realGit(f);
      const adapter: IntegrationWorkspaceAdapter = { ...real.adapter, prepare(input) {
        return real.adapter.prepare({ ...input, onStep(handle) {
          input.onStep!(handle);
          f.authorization.approvalCurrent = false;
        } });
      } };
      await expect(f.makeService(adapter).start(real.request)).rejects.toMatchObject({ details: { reason: 'approval_not_current' } });
      const checkpoint = f.box.atomic.transact('read-checkpoint', tx => f.journal.read(tx, f.box.projectId, real.plan.integrationId));
      expect(checkpoint?.steps).toHaveLength(1);
      expect(git(real.path, 'rev-parse', 'HEAD')).toBe(checkpoint!.steps[0]!.commitSha);
      expect(git(real.path, 'status', '--porcelain')).toBe('');
      expect(git(real.repo, 'rev-parse', 'HEAD')).toBe(real.base);
    } finally { f.box.close(); }
  });

  it('[case:integration-journal-rollback-and-fencing] command, intent and observation writes roll back together and reject stale facts', async () => {
    const f = await fixture();
    try {
      expect(() => f.box.atomic.transact('rollback', tx => {
        tx.registerGitOperation(f.intent);
        f.journal.claim(tx, f.request, digest('f'));
        throw new Error('injected receipt failure');
      })).toThrow('injected receipt failure');
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_operations').get()).toEqual({ count: 0 });
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM git_integration_commands').get()).toEqual({ count: 0 });
      const result = await f.makeService().start(f.request);
      expect(() => f.box.atomic.transact('stale', tx => f.journal.append(tx, f.box.projectId, f.plan.integrationId, 99, result)))
        .toThrow(expect.objectContaining({ details: { reason: 'operation_fenced' } }));
      expect(() => f.box.session.database.prepare('DELETE FROM git_integration_observations').run()).toThrow('integration observation is retained');
      expect(() => f.box.session.database.prepare("UPDATE git_integration_commands SET request_digest = ?").run(digest('a')))
        .toThrow('integration command is immutable');
    } finally { f.box.close(); }
  });
});
