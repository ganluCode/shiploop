import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteWorkspaceAccess } from '../packages/core/src/adapters/sqlite/workspace.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createWorkWorkspaceAuthority } from '../packages/core/src/adapters/fs/work-workspace.ts';
import { createSqliteStateAccess } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteCommandReceiptAccess } from '../packages/core/src/adapters/sqlite/command-receipts.ts';
import { createCompletedReceipt } from '../packages/core/src/ports/commands.ts';
import { createResultRef } from '../packages/core/src/ports/command-receipts.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { openBudgetFixture, BUDGET, NOW } from './helpers/p03-3/budget-fixture.ts';
import { recordVerifiedPass } from './helpers/p03-4/task-dag-state-fixture.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const HASH = 'ab'.repeat(32), COMMIT = 'a'.repeat(40);
async function withTempSandboxAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-f002-');
  try { await fn(sandbox.path); } finally { sandbox.cleanup(); }
}
const UNKNOWN_RESULT = { evidenceRefs: [], errorRef: null, startedAtUtcMs: null, endedAtUtcMs: null, durationMs: null, exitCode: null, signal: null };
async function fixture() {
  const box = await openBudgetFixture(BUDGET);
  try {
    const ids = await box.start(); recordVerifiedPass(box, ids, 't-1');
    box.session.database.prepare("UPDATE attempts SET status = 'preparing', execution_stage = 'preflight', started_at = NULL, ended_at = NULL").run();
    box.session.database.prepare("UPDATE tasks SET status = 'running'").run();
    const binding = createSqliteStateAccess(box.session).getRepositoryBinding(box.projectId);
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [box.box.root] });
    const canonicalPath = realpathSync(box.box.repoDirA);
    const token = await authority.verify(binding, canonicalPath);
    const identity = { projectId: box.projectId, attemptId: 't-1-attempt', owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1 };
    const resources = createSqliteWorkResourceAccess(box.session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
    const tx = <T>(fn: () => T) => box.session.transactWrite('test.workspace', fn);
    tx(() => resources.acquireInTransaction(identity, token, NOW + 1000));
    const access = createSqliteWorkspaceAccess(box.session, { resources, nowUtcMs: () => NOW });
    const operationId = randomUUID(), workspaceId = randomUUID();
    const receipt = (step: string, digest = HASH, commandId = randomUUID()) => createCompletedReceipt({
      commandId, principalId: 'local-owner', operation: 'execution.start', scope: { kind: 'project' as const, projectId: box.projectId }, requestDigest: digest,
      issuedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW).toISOString(),
      result: { workspaceOperationId: operationId, workspaceId, step }, resultRef: createResultRef(randomBytes(32)),
    });
    const input = { operationId, workspaceId, featureId: box.featureId, kind: 'prepare', identity, executionStage: 'preflight', expectedWorkspaceRevision: null,
      baseline: { repositoryBindingId: binding.id, repositoryBindingRevision: binding.bindingRevision, repoIdentity: binding.repoIdentity,
        canonicalPath, gitCommonDir: binding.gitCommonDir!, branch: 'shiploop/feature/test', baseCommit: COMMIT }, receipt: receipt('intent') };
    const finish = (operationRevision = 1, workspaceRevision = 1) => ({ operationId, identity, expectedRevision: operationRevision,
      expectedWorkspaceRevision: workspaceRevision, status: 'succeeded', workspaceStatus: 'ready', headCommit: COMMIT, codeDigest: HASH,
      result: UNKNOWN_RESULT, receipt: receipt('result') });
    const counts = () => Object.fromEntries(['managed_workspaces', 'workspace_operations', 'command_receipts', 'state_events'].map(table => [table,
      (box.session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
    return { box, ids, binding, resources, authority, tx, access, input, finish, receipt, counts };
  } catch (error) { box.close(); throw error; }
}

describe('F-002 managed workspace persistence', () => {
  it('commits intent, existing receipt and event together; preserves baseline and unknown result fields across reopen', async () => {
    const f = await fixture();
    try {
      const begin = f.tx(() => f.access.beginInTransaction(f.input));
      expect(begin.operation.runId).toBe(f.ids.runId);
      expect(begin.workspace).toMatchObject({ ...f.input.baseline, preparationOperationId: f.input.operationId, headCommit: null, codeDigest: null, revision: 1 });
      const doneInput = f.finish(); const done = f.tx(() => f.access.finishInTransaction(doneInput));
      expect(done.operation.result).toEqual(UNKNOWN_RESULT);
      expect(done.workspace).toMatchObject({ status: 'ready', headCommit: COMMIT, codeDigest: HASH, revision: 2 });
      expect(createSqliteCommandReceiptAccess(f.box.session).findReceiptByCommandId('local-owner', doneInput.receipt.commandId)).toEqual(doneInput.receipt);
      f.box.reopen();
      const reopened = createSqliteWorkspaceAccess(f.box.session, { resources: createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW }), nowUtcMs: () => NOW });
      expect(reopened.readWorkspace(f.box.projectId, f.box.featureId)).toEqual(done.workspace);
      expect(reopened.readOperation(f.box.projectId, f.input.operationId)).toEqual(done.operation);
      expect(f.tx(() => reopened.beginInTransaction(f.input)).replay).toBe(true);
      expect(f.tx(() => reopened.finishInTransaction(doneInput)).replay).toBe(true);
    } finally { f.box.close(); }
  });

  it('replays the same command/digest; rejects altered digest, input or existing command ownership', async () => {
    const f = await fixture();
    try {
      const first = f.tx(() => f.access.beginInTransaction(f.input)); const before = f.counts();
      expect(f.tx(() => f.access.beginInTransaction(f.input))).toEqual({ ...first, replay: true });
      for (const input of [{ ...f.input, receipt: { ...f.input.receipt, requestDigest: 'cd'.repeat(32) } },
        { ...f.input, baseline: { ...f.input.baseline, baseCommit: 'b'.repeat(40) } }]) {
        expect(() => f.tx(() => f.access.beginInTransaction(input))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      }
      expect(f.counts()).toEqual(before);
    } finally { f.box.close(); }
  });

  it('rolls back failures at receipt/event insertion and caller abort, with no half-commit', async () => {
    const f = await fixture();
    try {
      const db = f.box.session.database; const before = f.counts();
      for (const table of ['command_receipts', 'state_events']) {
        db.exec(`CREATE TRIGGER fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
        expect(() => f.tx(() => f.access.beginInTransaction(f.input))).toThrow('injected');
        expect(f.counts()).toEqual(before); db.exec('DROP TRIGGER fault');
      }
      expect(() => f.tx(() => { f.access.beginInTransaction(f.input); throw new Error('caller abort'); })).toThrow('caller abort');
      expect(f.counts()).toEqual(before);
      f.tx(() => f.access.beginInTransaction(f.input)); const after = f.counts();
      db.exec("CREATE TRIGGER fault BEFORE INSERT ON state_events BEGIN SELECT RAISE(ABORT, 'injected'); END");
      expect(() => f.tx(() => f.access.finishInTransaction(f.finish()))).toThrow('injected');
      expect(f.counts()).toEqual(after);
      expect(f.access.readOperation(f.box.projectId, f.input.operationId)?.status).toBe('pending');
    } finally { f.box.close(); }
  });

  it('uses revision CAS and existing owner/host/version fencing for every write', async () => {
    const f = await fixture();
    try {
      expect(() => f.access.beginInTransaction(f.input)).toThrow(TypeError);
      for (const override of [{ owner: 'other' }, { hostInstanceId: 'other' }, { executionVersion: 2 }]) {
        expect(() => f.tx(() => f.access.beginInTransaction({ ...f.input, identity: { ...f.input.identity, ...override } }))).toThrow();
      }
      f.tx(() => f.access.beginInTransaction(f.input));
      for (const override of [{ expectedRevision: 2 }, { expectedWorkspaceRevision: 2 }, { identity: { ...f.input.identity, owner: 'other' } }]) {
        expect(() => f.tx(() => f.access.finishInTransaction({ ...f.finish(), ...override }))).toThrow();
      }
      f.tx(() => f.access.finishInTransaction(f.finish()));
      expect(() => f.tx(() => f.access.finishInTransaction(f.finish()))).toThrow(expect.objectContaining({ kind: 'conflict' }));
    } finally { f.box.close(); }
  });

  it('allows retain and cleanup intents/results while freezing initial baseline and input snapshots', async () => {
    const f = await fixture();
    try {
      const original = f.tx(() => f.access.beginInTransaction(f.input)).operation.inputSnapshot;
      f.tx(() => f.access.finishInTransaction(f.finish()));
      let revision = 2;
      for (const kind of ['retain', 'cleanup']) {
        const operationId = randomUUID();
        const command = { ...f.receipt('intent'), result: { workspaceOperationId: operationId, workspaceId: f.input.workspaceId, step: 'intent' } };
        f.tx(() => f.access.beginInTransaction({ ...f.input, operationId, kind, expectedWorkspaceRevision: revision, receipt: command, executionStage: 'cleanup' }));
        revision++;
        const finish = { ...f.finish(1, revision), operationId, workspaceStatus: kind === 'retain' ? 'retained' : 'cleaned',
          receipt: { ...f.receipt('result'), result: { workspaceOperationId: operationId, workspaceId: f.input.workspaceId, step: 'result' } } };
        f.tx(() => f.access.finishInTransaction(finish)); revision++;
      }
      expect(f.access.readWorkspace(f.box.projectId, f.box.featureId)?.baseCommit).toBe(COMMIT);
      expect(f.access.readOperation(f.box.projectId, f.input.operationId)?.inputSnapshot).toEqual(original);
      const db = f.box.session.database;
      expect(() => db.prepare('UPDATE managed_workspaces SET base_commit = ?').run('b'.repeat(40))).toThrow();
      expect(() => db.prepare("UPDATE workspace_operations SET input_snapshot = '{}' ").run()).toThrow();
    } finally { f.box.close(); }
  });

  it('refuses malformed JSON/state, credentials, traversal, foreign references, duplicate Feature/path and stale binding', async () => {
    const f = await fixture();
    try {
      for (const override of [{ baseline: { ...f.input.baseline, canonicalPath: '/a/../b' } },
        { baseline: { ...f.input.baseline, repositoryBindingRevision: 2 } }, { featureId: 'foreign' },
        { kind: 'unknown' }, { credential: 'secret' }]) {
        expect(() => f.tx(() => f.access.beginInTransaction({ ...f.input, ...override }))).toThrow();
      }
      f.tx(() => f.access.beginInTransaction(f.input));
      const db = f.box.session.database;
      for (const sql of ["UPDATE workspace_operations SET status = 'unknown'", "UPDATE workspace_operations SET result_json = '{'",
        "UPDATE workspace_operations SET owner_id = 'other'", 'UPDATE workspace_operations SET execution_version = 2',
        "UPDATE managed_workspaces SET status = 'unknown'", "UPDATE managed_workspaces SET project_id = 'foreign'",
        "UPDATE workspace_operations SET input_snapshot = '[]'"]) expect(() => db.exec(sql)).toThrow();
      const row = db.prepare('SELECT * FROM managed_workspaces').get() as Record<string, unknown>;
      const columns = Object.keys(row);
      for (const override of [{ owner_id: 'other' }, { host_instance_id: 'other' }, { execution_version: 2 }, { run_id: 'other' }, { feature_id: 'other' }]) {
        const candidate: Record<string, unknown> = { ...row, ...override, id: randomUUID() };
        expect(() => db.prepare(`INSERT INTO managed_workspaces (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map(key => candidate[key]))).toThrow('execution identity mismatch');
      }
      const operationRow = db.prepare('SELECT * FROM workspace_operations').get() as Record<string, unknown>;
      const operationColumns = Object.keys(operationRow);
      for (const override of [{ owner_id: 'other' }, { host_instance_id: 'other' }, { execution_version: 2 }, { run_id: 'other' }, { feature_id: 'other' }]) {
        const candidate: Record<string, unknown> = { ...operationRow, ...override, id: randomUUID() };
        expect(() => db.prepare(`INSERT INTO workspace_operations (${operationColumns.join(',')}) VALUES (${operationColumns.map(() => '?').join(',')})`)
          .run(...operationColumns.map(key => candidate[key]))).toThrow('execution identity mismatch');
      }
      expect(() => db.prepare(`INSERT INTO managed_workspaces (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(...columns.map(key => key === 'id' ? randomUUID() : row[key]))).toThrow();
      expect(() => f.tx(() => f.access.finishInTransaction({ ...f.finish(), result: { ...UNKNOWN_RESULT, token: 'secret' } }))).toThrow();
      expect(() => f.tx(() => f.access.finishInTransaction({ ...f.finish(), workspaceStatus: 'cleaned' }))).toThrow();
    } finally { f.box.close(); }
  });

  it('refuses quarantined and expired resource writes, and bounds project-scoped keyset pagination', async () => {
    const f = await fixture();
    try {
      f.tx(() => f.access.beginInTransaction(f.input));
      expect(f.access.listWorkspaces({ projectId: f.box.projectId, limit: 1 }).items).toHaveLength(1);
      expect(f.access.listOperations({ projectId: f.box.projectId, limit: 1 }).items).toHaveLength(1);
      for (const limit of [0, -1, 501, 1.5]) expect(() => f.access.listOperations({ projectId: f.box.projectId, limit })).toThrow();
      expect(f.access.listOperations({ projectId: randomUUID() }).items).toEqual([]);
      expect(() => f.access.readOperation(randomUUID(), f.input.operationId)).toThrow(expect.objectContaining({ kind: 'ownership' }));
      f.tx(() => f.resources.quarantineInTransaction(f.input.identity));
      expect(() => f.tx(() => f.access.finishInTransaction(f.finish()))).toThrow();
      const blocked = { ...f.finish(), status: 'blocked', workspaceStatus: 'quarantined' };
      expect(f.tx(() => f.access.finishInTransaction(blocked)).workspace.status).toBe('quarantined');
    } finally { f.box.close(); }
  });

  it('does not skip rows across pages and honors Feature filtering', async () => {
    const f = await fixture();
    try {
      f.tx(() => f.access.beginInTransaction(f.input));
      f.tx(() => f.access.finishInTransaction(f.finish()));
      f.tx(() => f.access.beginInTransaction({ ...f.input, operationId: randomUUID(), kind: 'retain', expectedWorkspaceRevision: 2, receipt: f.receipt('retain') }));
      const all = f.access.listOperations({ projectId: f.box.projectId }).items;
      const first = f.access.listOperations({ projectId: f.box.projectId, limit: 1 });
      const second = f.access.listOperations({ projectId: f.box.projectId, limit: 1, cursor: first.nextCursor });
      expect([...first.items, ...second.items]).toEqual(all);
      expect(second.nextCursor).toBeNull();
      expect(f.access.listOperations({ projectId: f.box.projectId, featureId: 'unrelated' }).items).toEqual([]);
    } finally { f.box.close(); }
  });

  it('rejects changed replay identities and a reused finish command digest without mutation', async () => {
    const f = await fixture();
    try {
      f.tx(() => f.access.beginInTransaction(f.input));
      const before = f.counts();
      for (const override of [{ operationId: randomUUID() }, { workspaceId: randomUUID() }]) {
        expect(() => f.tx(() => f.access.beginInTransaction({ ...f.input, ...override }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      }
      const done = f.finish();
      f.tx(() => createSqliteCommandReceiptAccess(f.box.session).saveReceiptInTransaction({ ...done.receipt, requestDigest: 'cd'.repeat(32) }));
      expect(() => f.tx(() => f.access.finishInTransaction(done))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.access.readOperation(f.box.projectId, f.input.operationId)?.status).toBe('pending');
      expect(f.counts().state_events).toBe(before.state_events);
      expect(() => f.tx(() => f.access.finishInTransaction({ ...done, status: 'blocked', workspaceStatus: 'quarantined', identity: { ...done.identity, attemptId: 'other' } }))).toThrow();
    } finally { f.box.close(); }
  });

  it('rejects mismatched repository metadata, workspace IDs and expired resources', async () => {
    const f = await fixture();
    try {
      for (const baseline of [{ ...f.input.baseline, repoIdentity: 'unrelated' }, { ...f.input.baseline, gitCommonDir: '/unrelated' }, { ...f.input.baseline, canonicalPath: '/unrelated' }]) {
        expect(() => f.tx(() => f.access.beginInTransaction({ ...f.input, baseline }))).toThrow();
      }
      f.tx(() => f.access.beginInTransaction(f.input));
      f.tx(() => f.access.finishInTransaction(f.finish()));
      expect(() => f.tx(() => f.access.beginInTransaction({ ...f.input, operationId: randomUUID(), workspaceId: randomUUID(), kind: 'retain', expectedWorkspaceRevision: 2, receipt: f.receipt('retain') }))).toThrow();
      const expired = createSqliteWorkspaceAccess(f.box.session, { resources: f.resources, nowUtcMs: () => NOW + 1001 });
      expect(() => f.tx(() => expired.beginInTransaction({ ...f.input, operationId: randomUUID(), kind: 'retain', expectedWorkspaceRevision: 2, receipt: f.receipt('retain') }))).toThrow();
    } finally { f.box.close(); }
  });

  it('keeps terminal results immutable when the same receipt is replayed', async () => {
    const f = await fixture();
    try {
      f.tx(() => f.access.beginInTransaction(f.input));
      const done = f.finish();
      f.tx(() => f.access.finishInTransaction(done));
      const expired = createSqliteWorkspaceAccess(f.box.session, { resources: f.resources, nowUtcMs: () => NOW + 1001 });
      expect(f.tx(() => expired.beginInTransaction(f.input)).replay).toBe(true);
      expect(f.tx(() => expired.finishInTransaction(done)).replay).toBe(true);
      expect(() => f.tx(() => f.access.finishInTransaction({ ...done, headCommit: 'b'.repeat(40) }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(() => f.tx(() => f.access.finishInTransaction({ ...done, result: { ...done.result, exitCode: 1 } }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
    } finally { f.box.close(); }
  });

  it('serializes competing connections without duplicate intents or success events', async () => {
    const f = await fixture(); const other = openSqliteStorageSession({ path: f.box.box.dbPath });
    try {
      const peer = createSqliteWorkspaceAccess(other, { resources: createSqliteWorkResourceAccess(other, { workspaceAuthority: f.authority, nowUtcMs: () => NOW }), nowUtcMs: () => NOW });
      f.tx(() => f.access.beginInTransaction(f.input));
      expect(other.transactWrite('peer', () => peer.beginInTransaction(f.input)).replay).toBe(true);
      expect(() => other.transactWrite('peer', () => peer.beginInTransaction({ ...f.input, operationId: randomUUID(), receipt: f.receipt('intent') }))).toThrow();
      expect(f.counts().managed_workspaces).toBe(1); expect(f.counts().workspace_operations).toBe(1);
      const page = peer.listOperations({ projectId: f.box.projectId, limit: 1 });
      expect(page.items).toHaveLength(1);
    } finally { other.close(); f.box.close(); }
  });
});

describe('F-002 append-only migration', () => {
  it.each([0, 5, 17])('upgrades v%s, preserves prior data/checksums and repeats idempotently', async version => {
    await withTempSandboxAsync(async root => {
      const session = openSqliteStorageSession({ path: join(root, 'db.sqlite') });
      try {
        if (version) await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, version) });
        if (version) session.database.prepare("INSERT INTO global_settings (id, created_at, updated_at, schema_version, payload) VALUES ('global', 1, 1, 2, '{}')").run();
        const previous = version ? session.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all() : [];
        await migrateSqliteStorage(session);
        expect(SQLITE_MIGRATIONS.at(-1)?.version).toBe(19);
        expect(session.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all().slice(0, version)).toEqual(previous);
        if (version) expect(session.database.prepare("SELECT payload FROM global_settings WHERE id = 'global'").get()).toEqual({ payload: '{}' });
        expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([]);
      } finally { session.close(); }
    });
  });
  it('rolls back a failed v18 migration and can upgrade after reopening', async () => {
    await withTempSandboxAsync(async root => {
      const path = join(root, 'db.sqlite'); let session = openSqliteStorageSession({ path });
      try {
        await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 17) });
        const sql = `${SQLITE_MIGRATIONS.find(migration => migration.version === 18)!.sql}\nSELECT * FROM nonexistent;`;
        await expect(migrateSqliteStorage(session, { backupPath: join(root, 'fault-backup'), migrations: [...SQLITE_MIGRATIONS.slice(0, 17),
          { version: 18, sql, checksum: createHash('sha256').update(sql).digest('hex') }] })).rejects.toMatchObject({ step: 'apply', version: 18 });
        expect(session.database.prepare("SELECT name FROM sqlite_master WHERE name = 'managed_workspaces'").get()).toBeUndefined();
        expect(session.database.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 17 });
        session.close(); session = openSqliteStorageSession({ path }); await migrateSqliteStorage(session, { backupPath: join(root, 'good-backup') });
      } finally { session.close(); }
    });
  });
});
