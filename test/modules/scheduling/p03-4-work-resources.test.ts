import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { computeBaselinePlanDigest } from '../../../packages/core/src/ports/baseline.ts';
import { describe, expect, it } from 'vitest';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteBaselineAccess } from '../../../packages/core/src/adapters/sqlite/baseline-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { recordVerifiedPass, publishPreparedInputFixture } from '../../helpers/p03-4/task-dag-state-fixture.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import type { WorkResourceStopVerifier } from '../../../packages/core/src/ports/work-resources.ts';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { runBarrierChildren } from '../../helpers/p02-2/index.ts';
import { BUDGET, openBudgetFixture, NOW } from '../../helpers/p03-3/budget-fixture.ts';

async function fixture(stopVerifier?: WorkResourceStopVerifier, sameFeaturePeer = false) {
  const tasks = ['t-1', ...(sameFeaturePeer ? ['t-peer'] : [])].map(id => ({ id, title: id, acceptance: { criteria: ['resource consistency'] }, dependsOn: [] as string[] }));
  const { maxCostTotal: _cost, maxTokenTotal: _tokens, ...batch } = BUDGET.batch;
  const box = await openBudgetFixture({ ...BUDGET, batch }, tasks);
  const ids = await box.start();
  const inputSnapshot = publishPreparedInputFixture(box, ids, 't-1');
  let now = NOW;
  const authority = createWorkWorkspaceAuthority({ authorizedRoots: [box.box.root] });
  const binding = createSqliteStateAccess(box.session).getRepositoryBinding(box.projectId);
  const path = realpathSync(box.box.repoDirA);
  const workspace = await authority.verify(binding, path);
  const identity = { projectId: box.projectId, attemptId: 't-1-attempt', owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1 };
  const access = createSqliteWorkResourceAccess(box.session, { workspaceAuthority: authority, nowUtcMs: () => now, ...(stopVerifier ? { stopVerifier } : {}) });
  const tx = <T>(fn: () => T) => box.session.transactWrite('test.work-resources', fn);
  // Launch tests need a committed Run/slot/Attempt association. Release only the
  // unstarted workspace group so the resource-acquisition cases retain their setup.
  createSqliteTaskClaimStore(box.session, { workspaceAuthority: authority, nowUtcMs: () => now }).claimTask({
    ...identity, attemptId: identity.attemptId, claimKey: 'resource-fixture-claim', runId: ids.runId,
    taskId: 't-1', expectedRevision: 1, executionVersion: 0, workspace, leaseUntilUtcMs: NOW + 1000, inputSnapshot,
  });
  tx(() => access.releaseUnstartedInTransaction(identity));
  if (sameFeaturePeer) {
    recordVerifiedPass(box, ids, 't-peer');
    box.session.database.prepare("UPDATE attempts SET status = 'preparing', execution_stage = 'preflight', started_at = NULL, ended_at = NULL WHERE id = 't-peer-attempt'").run();
    box.session.database.prepare("UPDATE tasks SET status = 'running' WHERE id = 't-peer'").run();
  }
  return { box, identity, authority, binding, path, workspace, access, tx, tick: () => { now += 1001; } };
}

async function competitor(f: Awaited<ReturnType<typeof fixture>>, separateProject: boolean) {
  let projectId = f.box.projectId;
  const done = async (operation: string, payload: unknown, extra: Record<string, unknown>) => {
    const receipt = await f.box.submit(operation, payload, extra);
    if (receipt.status !== 'completed') throw new Error(JSON.stringify(receipt));
    return receipt.result;
  };
  if (separateProject) {
    const result = await done('project.register', { repositoryPath: f.box.box.repoDirB, displayName: 'Competitor', description: null, labels: [] },
      { scope: { kind: 'registration' } });
    projectId = (result as { project: { id: string } }).project.id;
  }
  const scope = { kind: 'project', projectId };
  await done('phase.create', { id: 'phase-peer', title: 'Peer', description: null, labels: [] }, { scope });
  const result = await done('feature.plan.import', { phaseId: 'phase-peer', plan: { schemaVersion: 1,
    feature: { title: 'Peer', description: null, labels: [], sourceRefs: [] },
    tasks: [{ id: 't-peer', title: 'Peer', acceptance: { criteria: ['resource exclusivity'] }, dependsOn: [] }] } },
    { scope, expectedRevision: 1 });
  const featureId = (result as { feature: { id: string } }).feature.id;
  const feature = f.box.session.database.prepare('SELECT revision, plan_digest FROM features WHERE id = ?').get(featureId) as { revision: number; plan_digest: string };
  await done('feature.plan.decide', { featureId, planDigest: feature.plan_digest, decision: 'approve', reason: 'test' }, { scope, expectedRevision: feature.revision });
  const preview = await f.box.services.preview.previewExecution(projectId, { featureIds: [featureId], budget: BUDGET });
  if (preview.status !== 'ready') throw new Error(JSON.stringify(preview));
  const receipt = await f.box.submit('execution.start', { featureIds: [featureId], budget: BUDGET, previewDigest: preview.previewDigest }, { scope });
  if (receipt.status !== 'accepted' || !('runId' in receipt)) throw new Error(JSON.stringify(receipt));
  recordVerifiedPass({ ...f.box, projectId, featureId }, receipt, 't-peer');
  f.box.session.database.prepare("UPDATE attempts SET status = 'preparing', execution_stage = 'preflight', started_at = NULL, ended_at = NULL WHERE id = 't-peer-attempt'").run();
  f.box.session.database.prepare("UPDATE tasks SET status = 'running' WHERE id = 't-peer'").run();
  const identity = { ...f.identity, projectId, attemptId: 't-peer-attempt' };
  const binding = createSqliteStateAccess(f.box.session).getRepositoryBinding(projectId);
  const path = separateProject ? realpathSync(f.box.box.repoDirB) : f.path;
  return { identity, binding, path, workspace: await f.authority.verify(binding, path) };
}

function insertBaseline(f: Awaited<ReturnType<typeof fixture>>, session = f.box.session) {
  const baseline = createSqliteBaselineAccess(session, { nowUtcMs: () => NOW });
  return session.transactWrite('test.baseline', () => {
    const plan = { checks: [{ checkKey: 'test', kind: 'command' as const, argv: ['node', '--version'], timeoutMs: 1000, required: true }] };
    const planDigest = computeBaselinePlanDigest(plan);
    const authorization = baseline.insertBaselineAuthorizationInTransaction({ projectId: f.box.projectId,
      repositoryBindingId: f.binding.id, codeIdentity: { headCommit: 'a'.repeat(40), workingTreeDigest: 'ab'.repeat(32), hasUncommittedChanges: false },
      policyRevision: planDigest, planDigest, plan, authorizedBy: 'local-owner', authorizedAtUtcMs: NOW });
    return baseline.insertBaselineOperationInTransaction({ projectId: f.box.projectId, kind: 'baseline',
      authorizationId: authorization.id, status: 'accepted', reasonCode: null });
  });
}

describe('F-003 persistent Work resource gates', () => {
  it('atomically owns global, project and canonical workspace resources; rollback leaves no partial gates', async () => {
    const f = await fixture();
    try {
      expect(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000)).toThrow();
      expect(() => f.tx(() => { f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000); throw new Error('rollback'); })).toThrow('rollback');
      expect(f.access.read(f.identity).leases).toEqual([]);
      const result = f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000));
      expect(result.leases.map(l => l.resourceKind)).toEqual(['global', 'project', 'workspace']);
      expect(result.leases[0]?.resourceKey).toBe('global:execution');
      expect(f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000))).toEqual(result);
    } finally { f.box.close(); }
  });

  it('normalizes symlink aliases and refuses traversal, unauthorized realpath, foreign repositories and forged keys', async () => {
    const f = await fixture();
    try {
      const alias = join(f.box.box.root, 'alias');
      symlinkSync(f.path, alias);
      const alternative = await f.authority.verify(f.binding, alias);
      f.tx(() => f.access.acquireInTransaction(f.identity, alternative, NOW + 1000));
      expect(f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000)).leases).toHaveLength(3);
      await expect(f.authority.verify(f.binding, `${f.path}/../repo-a`)).rejects.toThrow();
      await expect(f.authority.verify(f.binding, f.box.box.repoDirB)).rejects.toThrow();
      const narrow = createWorkWorkspaceAuthority({ authorizedRoots: [f.path] });
      const outside = join(f.box.box.root, 'outside'); mkdirSync(outside);
      symlinkSync(outside, join(f.path, 'escape'));
      await expect(narrow.verify(f.binding, join(f.path, 'escape'))).rejects.toThrow();
      expect(() => f.tx(() => f.access.acquireInTransaction(f.identity, { resourceKey: 'mine' }, NOW + 1000))).toThrow();
      expect(() => f.tx(() => f.access.acquireInTransaction({ ...f.identity, projectId: 'other' }, f.workspace, NOW + 1000))).toThrow();
    } finally { f.box.close(); }
  });

  it('rechecks binding revision in the write transaction after filesystem verification', async () => {
    const f = await fixture();
    try {
      f.box.session.database.prepare('UPDATE repository_bindings SET revision = revision + 1').run();
      expect(() => f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.access.read(f.identity).leases).toEqual([]);
    } finally { f.box.close(); }
  });

  it('[case:baseline-work-both-orders] coordinates baseline and Work in both orders across SQLite connections, including stop-uncertain baseline', async () => {
    const f = await fixture();
    const other = openSqliteStorageSession({ path: f.box.box.dbPath });
    try {
      const baseline = createSqliteBaselineAccess(other, { nowUtcMs: () => NOW });
      const operation = insertBaseline(f, other);
      f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000));
      expect(() => other.transactWrite('test.baseline', () => baseline.acquireBaselineOccupancyInTransaction({ operationId: operation.id }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      f.tx(() => f.access.quarantineInTransaction(f.identity));
      expect(() => other.transactWrite('test.baseline', () => baseline.acquireBaselineOccupancyInTransaction({ operationId: operation.id }))).toThrow();
      f.tx(() => f.access.releaseUnstartedInTransaction(f.identity));
      other.transactWrite('test.baseline', () => baseline.acquireBaselineOccupancyInTransaction({ operationId: operation.id }));
      expect(() => f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      other.transactWrite('test.baseline-uncertain', () => baseline.updateBaselineOperationInTransaction(operation.id,
        { expectedRevision: operation.revision, status: 'failed', reasonCode: 'stop_unconfirmed' }));
      expect(() => f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000))).toThrow();
      other.transactWrite('test.baseline-release', () => baseline.releaseBaselineOccupancyInTransaction(operation.id));
      expect(f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000)).leases).toHaveLength(3);
    } finally { other.close(); f.box.close(); }
  });

  it('fences every mutation and quarantines expired leases without renewing or freeing them across reopen', async () => {
    const f = await fixture();
    try {
      f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000));
      for (const bad of [{ owner: 'stale' }, { hostInstanceId: 'old-host' }, { executionVersion: 2 }]) {
        const identity = { ...f.identity, ...bad };
        expect(() => f.tx(() => f.access.renewInTransaction(identity, NOW + 2000))).toThrow();
        expect(() => f.tx(() => f.access.quarantineInTransaction(identity))).toThrow();
        expect(() => f.tx(() => f.access.releaseUnstartedInTransaction(identity))).toThrow();
      }
      f.tick();
      const expired = f.tx(() => f.access.renewInTransaction(f.identity, NOW + 3000));
      expect(expired.leases.every(l => l.state === 'quarantined' && l.leaseUntilUtcMs === NOW + 1000)).toBe(true);
      expect(() => f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 3000))).toThrow();
      expect(f.tx(() => f.access.beginLaunchInTransaction(f.identity)).authorized).toBe(false);
      f.box.reopen();
      const reopened = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 2000 });
      expect(reopened.read(f.identity).leases.every(l => l.state === 'quarantined')).toBe(true);
    } finally { f.box.close(); }
  });

  it.each(['task', 'feature', 'project'])('allows exactly one winner across real competing connections (%s)', async scope => {
    const f = await fixture(undefined, scope === 'task');
    const environment = createIsolatedHostEnvironment();
    try {
      const peer = scope === 'task'
        ? { ...f, identity: { ...f.identity, attemptId: 't-peer-attempt' } }
        : await competitor(f, scope === 'project');
      const results = await runBarrierChildren(environment, {
        scriptPath: fileURLToPath(new URL('../../helpers/p03-4/work-resource-race-child.ts', import.meta.url)),
        configs: [f, peer].map(entry => ({ dbPath: f.box.box.dbPath, identity: entry.identity, path: entry.path,
          root: f.box.box.root, now: NOW, until: NOW + 1000 })),
      });
      expect(results.filter(r => r.result.ok === true)).toHaveLength(1);
      expect(results.filter(r => r.result.errorKind === 'conflict')).toHaveLength(1);
      expect(f.box.session.database.prepare('SELECT count(*) AS count FROM workspace_leases').get()).toEqual({ count: 3 });
      const winner = results[0]!.result.ok ? f.identity : peer.identity;
      expect(f.access.read(winner).leases).toHaveLength(3);
    } finally { await environment.dispose(); f.box.close(); }
  });

  it('[case:baseline-work-race] admits exactly one baseline or Work winner in a real cross-process race', async () => {
    const f = await fixture();
    const environment = createIsolatedHostEnvironment();
    try {
      const operation = insertBaseline(f);
      const shared = { dbPath: f.box.box.dbPath, identity: f.identity, path: f.path, root: f.box.box.root, now: NOW, until: NOW + 1000 };
      const results = await runBarrierChildren(environment, {
        scriptPath: fileURLToPath(new URL('../../helpers/p03-4/work-resource-race-child.ts', import.meta.url)),
        configs: [shared, { ...shared, baselineOperationId: operation.id }],
      });
      expect(results.filter(r => r.result.ok === true)).toHaveLength(1);
      expect(results.filter(r => r.result.errorKind === 'conflict')).toHaveLength(1);
      const workWon = results[0]!.result.ok === true;
      expect(f.access.read(f.identity).leases).toHaveLength(workWon ? 3 : 0);
      expect(createSqliteBaselineAccess(f.box.session).readBaselineOccupancy().holderOperationId).toBe(workWon ? null : operation.id);
    } finally { await environment.dispose(); f.box.close(); }
  });

  it('requires durable launch authorization and never accepts unverified stop, runtime return or PID absence as release', async () => {
    let confirmed = false, finalized = false;
    const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => ({ confirmed }) },
      finalize: async () => finalized });
    const f = await fixture(verifier);
    const processIdentity = { launchId: randomUUID(), pid: 10000, processGroupId: 10000, startTime: 'known-supervisor-start' };
    try {
      f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000));
      expect(() => f.tx(() => f.access.confirmLaunchInTransaction(f.identity, processIdentity))).toThrow();
      expect(f.tx(() => f.access.beginLaunchInTransaction(f.identity)).authorized).toBe(true);
      expect(() => f.tx(() => f.access.beginLaunchInTransaction(f.identity))).toThrow();
      expect(() => f.tx(() => f.access.releaseUnstartedInTransaction(f.identity))).toThrow();
      f.tx(() => f.access.confirmLaunchInTransaction(f.identity, processIdentity));
      f.tick();
      expect(f.tx(() => f.access.expireInTransaction())).toBe(1);
      expect(f.tx(() => f.access.expireInTransaction())).toBe(0);
      expect(() => f.tx(() => f.access.releaseStoppedInTransaction(f.identity, { confirmed: true, pidAbsent: true, finalized: true }))).toThrow();
      expect(await verifier.verify(f.access.read(f.identity))).toBeNull();
      confirmed = true;
      expect(await verifier.verify(f.access.read(f.identity))).toBeNull();
      finalized = true;
      const token = await verifier.verify(f.access.read(f.identity));
      for (const bad of [{ owner: 'stale' }, { hostInstanceId: 'stale-host' }, { executionVersion: 2 }]) {
        expect(() => f.tx(() => f.access.releaseStoppedInTransaction({ ...f.identity, ...bad }, token))).toThrow();
      }
      f.tx(() => f.access.releaseStoppedInTransaction(f.identity, token));
      expect(f.access.read(f.identity).leases).toEqual([]);
      expect(() => f.tx(() => f.access.releaseStoppedInTransaction(f.identity, token))).toThrow();
    } finally { f.box.close(); }
  });

  it('rejects stop evidence when occupancy revision or state changes during external finalization', async () => {
    const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => ({ confirmed: true }) }, finalize: async () => true });
    const f = await fixture(verifier);
    try {
      f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000));
      f.tx(() => f.access.beginLaunchInTransaction(f.identity));
      f.tx(() => f.access.confirmLaunchInTransaction(f.identity, { launchId: randomUUID(), pid: 5000, processGroupId: 5000, startTime: 'start' }));
      const token = await verifier.verify(f.access.read(f.identity));
      f.tx(() => f.access.renewInTransaction(f.identity, NOW + 2000));
      expect(() => f.tx(() => f.access.releaseStoppedInTransaction(f.identity, token))).toThrow();
      const renewedToken = await verifier.verify(f.access.read(f.identity));
      f.tx(() => f.access.quarantineInTransaction(f.identity));
      expect(() => f.tx(() => f.access.releaseStoppedInTransaction(f.identity, renewedToken))).toThrow();
      expect(() => f.tx(() => f.access.releaseStoppedInTransaction(f.identity, verifier.inspect(renewedToken)))).toThrow();
      const currentToken = await verifier.verify(f.access.read(f.identity));
      f.tx(() => f.access.releaseStoppedInTransaction(f.identity, currentToken));
    } finally { f.box.close(); }
  });

  it('persists a late supervisor identity but refuses workload release after expiry between launch authorization and registration', async () => {
    const f = await fixture();
    try {
      f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000));
      f.tx(() => f.access.beginLaunchInTransaction(f.identity));
      f.tick();
      const identity = { launchId: randomUUID(), pid: 7000, processGroupId: 7000, startTime: 'supervisor-start' };
      expect(f.tx(() => f.access.confirmLaunchInTransaction(f.identity, identity)).authorized).toBe(false);
      const persisted = f.access.read(f.identity);
      expect(persisted.leases.every(lease => lease.state === 'quarantined')).toBe(true);
      expect(persisted.processIdentity).toEqual(identity);
      expect(() => f.tx(() => f.access.releaseUnstartedInTransaction(f.identity))).toThrow();
      expect(f.tx(() => f.access.renewInTransaction(f.identity, NOW + 3000))).toEqual(persisted);
    } finally { f.box.close(); }
  });

  it('quarantines expired occupancy even if task fencing advances and refuses corrupt partial ownership groups', async () => {
    const f = await fixture();
    try {
      f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000));
      f.box.session.database.prepare("UPDATE tasks SET execution_version = 2 WHERE id = 't-1'").run();
      f.tick();
      expect(f.tx(() => f.access.expireInTransaction())).toBe(1);
      expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
      expect(() => f.tx(() => f.access.releaseUnstartedInTransaction(f.identity))).toThrow();
      f.box.session.database.prepare("UPDATE tasks SET execution_version = 1 WHERE id = 't-1'").run();
      f.box.session.database.prepare("DELETE FROM workspace_leases WHERE resource_kind = 'project'").run();
      expect(() => f.tx(() => f.access.releaseUnstartedInTransaction(f.identity))).toThrow(expect.objectContaining({ kind: 'corrupt' }));
      expect(f.box.session.database.prepare('SELECT count(*) AS count FROM workspace_leases').get()).toEqual({ count: 2 });
    } finally { f.box.close(); }
  });

  it.skipIf(process.platform !== 'darwin')('retains expired gates while a real supervised child writes; releases only after confirmed stop and cleanup', async () => {
    const processPort = createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 2000 });
    let f: Awaited<ReturnType<typeof fixture>>;
    let finalized = false;
    const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async identity => {
      expect(f.box.session.database.inTransaction).toBe(false);
      return processPort.recoverStop!(identity);
    } }, finalize: async () => {
      expect(f.box.session.database.inTransaction).toBe(false);
      finalized = true; return true;
    } });
    f = await fixture(verifier);
    const peer = await competitor(f, false);
    const sentinel = join(f.box.box.root, 'writer');
    let handle: Awaited<ReturnType<typeof processPort.start>> | undefined;
    try {
      f.tx(() => f.access.acquireInTransaction(f.identity, f.workspace, NOW + 1000));
      f.tx(() => f.access.beginLaunchInTransaction(f.identity));
      handle = await processPort.start({ argv: [process.execPath, '-e',
        `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(sentinel)},'x'),20);`],
        cwd: f.path, environment: {}, timeoutMs: 10000, maxInputBytes: 1024, maxOutputBytes: 1024 }, async identity => {
        const registration = f.tx(() => f.access.confirmLaunchInTransaction(f.identity, identity));
        if (!registration.authorized) throw new Error('Lease no longer authorizes workload');
        return { launchId: identity.launchId };
      });
      await expect.poll(() => { try { return statSync(sentinel).size; } catch { return 0; } }, { timeout: 3000 }).toBeGreaterThan(0);
      f.tick(); f.tx(() => f.access.expireInTransaction());
      const before = statSync(sentinel).size;
      await delay(100);
      expect(statSync(sentinel).size).toBeGreaterThan(before);
      expect(() => f.tx(() => f.access.acquireInTransaction(peer.identity, peer.workspace, NOW + 3000))).toThrow();
      expect(() => f.tx(() => f.access.releaseUnstartedInTransaction(f.identity))).toThrow();
      const token = await verifier.verify(f.access.read(f.identity));
      expect(token).not.toBeNull(); expect(finalized).toBe(true);
      const stoppedSize = statSync(sentinel).size; await delay(100);
      expect(statSync(sentinel).size).toBe(stoppedSize);
      f.tx(() => f.access.releaseStoppedInTransaction(f.identity, token));
      expect(f.tx(() => f.access.acquireInTransaction(peer.identity, peer.workspace, NOW + 3000)).leases).toHaveLength(3);
    } finally {
      if (handle) { await handle.cancel(); expect((await handle.stopped).confirmed).toBe(true); }
      f.box.close();
    }
  }, 15000);
});
