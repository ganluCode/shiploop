import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAcceptedReceipt, createCompletedReceipt, createRejectedReceipt,
  PublicError, validateCommandEnvelope, mapStorageError,
} from '../packages/core/src/ports/commands.ts';
import { createResultRef, decideCommandReplay, validateWireCommandReceipt, validatePersistableCommandReceipt, mapPersistedCommandReceipt } from '../packages/core/src/ports/command-receipts.ts';
import { createLocalOwnerPrincipal } from '../packages/core/src/ports/authorization.ts';
import { createCommandReceiptsService } from '../packages/core/src/application/command-receipts-service.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteCommandReceiptAccess } from '../packages/core/src/adapters/sqlite/command-receipts.ts';
import { StorageError } from '../packages/core/src/ports/errors.ts';
import { validateCommandReceiptWire } from '../packages/host/src/client/app-wire.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const NOW = 1_700_800_000_000;
const ISO = new Date(NOW).toISOString();
const DIGEST = 'ab'.repeat(32);

function workInput(projectId: string, batchId = randomUUID(), runId = randomUUID()) {
  return {
    commandId: randomUUID(), principalId: 'local-owner', operation: 'execution.start' as const,
    scope: { kind: 'project' as const, projectId }, requestDigest: DIGEST,
    issuedAt: ISO, completedAt: ISO, operationId: batchId, batchId, runId,
  };
}

function workReceipt(input: ReturnType<typeof workInput>) {
  return createAcceptedReceipt(input);
}

async function withDb(fn: (session: SqliteStorageSession) => Promise<void>, version?: number) {
  const sandbox = createTempSandbox('shiploop-f003-receipts-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  try {
    await migrateSqliteStorage(session, {
      nowUtcMs: () => NOW,
      ...(version === undefined ? {} : { migrations: SQLITE_MIGRATIONS.slice(0, version) }),
    });
    await fn(session);
  } finally {
    session.close();
    sandbox.cleanup();
  }
}

function seedPlan(session: SqliteStorageSession, projectId: string) {
  return createSqliteAtomicCommandStore(session).transact('test.seed', (tx) => {
    const phase = tx.insertPhase({ projectId, title: 'Phase', labels: [] });
    const feature = tx.insertFeature({
      projectId, phaseId: phase.id, title: 'Feature', planDigest: DIGEST,
      sourceRefs: [{ artifactId: 'source-artifact' }],
    });
    return { phaseId: phase.id, featureId: feature.id };
  });
}

function seedWork(session: SqliteStorageSession, projectId: string, batchId: string, runId: string,
  { phaseId, featureId } = seedPlan(session, projectId)) {
  const budget = JSON.stringify({
    schemaVersion: 1,
    batch: { maxRuns: 2, maxTotalAttempts: 6, maxRuntimeStarts: 6, maxNoProgressRuns: 2, deadlineUtcMs: NOW + 60_000 },
    run: { maxAttemptsPerRun: 3, runTimeLimitMs: 60_000 },
  });
  session.database.prepare(
    'INSERT INTO execution_batches (id, created_at, updated_at, project_id, phase_id, feature_id, ' +
    'scope_snapshot, config_snapshot, status, budget_snapshot, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(batchId, NOW, NOW, projectId, phaseId, featureId,
    JSON.stringify({ schemaVersion: 1, featureIds: [featureId], purpose: 'execute' }),
    '{"schemaVersion":2}', 'queued', budget, NOW + 60_000);
  session.database.prepare(
    'INSERT INTO runs (id, created_at, updated_at, project_id, batch_id, feature_id, purpose, input_snapshot, ' +
    'config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, run_time_limit_ms) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(runId, NOW, NOW, projectId, batchId, featureId, 'execute', '{"schemaVersion":1}',
    '{"schemaVersion":2}', 'queued', DIGEST, 'work-1', 1, 3, 60_000);
}

describe('F-003 Work accepted receipts', () => {
  it('uses the existing factory and read/replay channels with explicit v6 identities', async () => {
    await withDb(async (session) => {
      const project = await createSqliteStateStore(session).createProject({ displayName: 'Project' });
      const input = workInput(project.id);
      const receipt = workReceipt(input);
      expect(receipt).toEqual({ ...input, schemaVersion: 6, status: 'accepted', replayed: false });
      const access = createSqliteCommandReceiptAccess(session);
      const plan = seedPlan(session, project.id);
      session.transactWrite('test.accept', () => {
        seedWork(session, project.id, input.batchId, input.runId, plan);
        access.saveReceiptInTransaction(receipt);
      });
      const service = createCommandReceiptsService({ receiptStore: access.store });
      expect(await service.getReceipt(createLocalOwnerPrincipal(), input.commandId)).toEqual(receipt);
      expect(await access.store.findReceiptByCommandId('other-owner', input.commandId)).toBeUndefined();
      const stored = await access.store.findReceiptByCommandId('local-owner', input.commandId);
      expect(decideCommandReplay(stored, DIGEST, 'execution.start')).toMatchObject({
        kind: 'replay', receipt: { ...receipt, replayed: true },
      });
      expect(() => decideCommandReplay(stored, 'cd'.repeat(32), 'execution.start')).toThrow(PublicError);
      expect(validateWireCommandReceipt({ ...receipt, replayed: true }, 'receipts.get')).toEqual({ ...receipt, replayed: true });
      expect(session.database.prepare('SELECT count(*) AS n FROM baseline_operations').get()).toEqual({ n: 0 });
    });
  });

  it('rejects dangling and cross-project associations with structured errors', async () => {
    await withDb(async (session) => {
      const state = createSqliteStateStore(session);
      const a = await state.createProject({ displayName: 'A' });
      const b = await state.createProject({ displayName: 'B' });
      const input = workInput(a.id);
      seedWork(session, a.id, input.batchId, input.runId);
      const access = createSqliteCommandReceiptAccess(session);
      for (const bad of [
        { ...input, batchId: randomUUID() }, { ...input, runId: randomUUID() },
        { ...input, scope: { kind: 'project', projectId: b.id } },
      ]) {
        const value = { ...bad, operationId: bad.batchId, schemaVersion: 6, status: 'accepted', replayed: false };
        await expect(access.store.saveReceipt(value)).rejects.toMatchObject({
          kind: 'validation', details: { field: 'receipt.association' },
        });
      }
      expect(session.database.prepare('SELECT count(*) AS n FROM command_receipts').get()).toEqual({ n: 0 });
    });
  });

  it('rolls back Batch/Run and accepted together; preserves principal/command uniqueness', async () => {
    await withDb(async (session) => {
      const project = await createSqliteStateStore(session).createProject({ displayName: 'Project' });
      const input = workInput(project.id);
      const access = createSqliteCommandReceiptAccess(session);
      const receipt = workReceipt(input);
      const plan = seedPlan(session, project.id);
      expect(() => session.transactWrite('test.rollback', () => {
        seedWork(session, project.id, input.batchId, input.runId, plan);
        access.saveReceiptInTransaction(receipt);
        throw new Error('injected transaction failure');
      })).toThrow('injected transaction failure');
      for (const table of ['execution_batches', 'runs', 'command_receipts']) {
        expect(session.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      seedWork(session, project.id, input.batchId, input.runId);
      await access.store.saveReceipt(receipt);
      await expect(access.store.saveReceipt(receipt)).rejects.toMatchObject({ kind: 'conflict' });
      expect(session.database.prepare('SELECT count(*) AS n FROM command_receipts').get()).toEqual({ n: 1 });
    });
  });

  it('rejects same-version expansion and unsupported execution.start submissions', () => {
    const receipt = workReceipt(workInput(randomUUID()));
    for (const bad of [
      { ...receipt, schemaVersion: 5 }, { ...receipt, batchId: undefined },
      { ...receipt, runId: 'not-a-uuid' }, { ...receipt, operationId: randomUUID() },
      { ...receipt, scope: { kind: 'global' } }, { ...receipt, unexpected: true },
      { ...receipt, result: {} }, { ...receipt, status: 'completed' },
    ]) expect(() => validateWireCommandReceipt(bad, 'receipts.get')).toThrow();
    expect(() => validateCommandEnvelope({
      schemaVersion: 5, commandId: randomUUID(), operation: 'execution.start',
      scope: { kind: 'project', projectId: randomUUID() }, issuedAt: ISO, payload: {},
    })).toThrow(PublicError);
  });

  it('Work factory refuses malformed identity; completed/rejected factories remain v5-only', () => {
    const input = workInput(randomUUID());
    for (const value of [{ ...input, operationId: randomUUID() }, { ...input, runId: 'missing' },
      { ...input, requestDigest: 'invalid' }, { ...input, scope: { kind: 'global' } },
      { ...input, principalId: '' }]) {
      expect(() => Reflect.apply(createAcceptedReceipt, undefined, [value])).toThrow(TypeError);
    }
    expect(() => Reflect.apply(createCompletedReceipt, undefined, [{
      ...input, result: { ok: true }, resultRef: createResultRef(new Uint8Array(32)),
    }])).toThrow(TypeError);
    expect(() => Reflect.apply(createRejectedReceipt, undefined, [{
      ...input, error: new PublicError('conflict', 'execution.start'),
    }])).toThrow(TypeError);
    expect(() => validatePersistableCommandReceipt({ ...workReceipt(input), replayed: true }, 'receipts.save')).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    );
  });

  it('persisted v6 mapping fails closed for corrupt versions, association or identity', () => {
    const receipt = workReceipt(workInput(randomUUID()));
    const row = {
      receiptVersion: 6, principalId: receipt.principalId, commandId: receipt.commandId,
      scopeKind: receipt.scope.kind, projectId: receipt.scope.kind === 'project' ? receipt.scope.projectId : null,
      operation: receipt.operation, requestDigest: receipt.requestDigest, status: receipt.status,
      operationId: receipt.operationId, batchId: receipt.batchId, runId: receipt.runId,
      result: undefined, resultRef: null, errorCode: null, errorMessage: null, errorDetails: null,
      issuedAtUtcMs: Date.parse(ISO), completedAtUtcMs: Date.parse(ISO),
    };
    expect(mapPersistedCommandReceipt(row)).toEqual(receipt);
    for (const value of [{ ...row, receiptVersion: 5 }, { ...row, receiptVersion: 7 },
      { ...row, batchId: null }, { ...row, runId: 'invalid' }, { ...row, operationId: randomUUID() },
      { ...row, scopeKind: 'global' }, { ...row, projectId: null }, { ...row, status: 'completed' },
      { ...row, result: {} }, { ...row, errorMessage: 'secret' }, { ...row, requestDigest: 'bad' },
      { ...row, issuedAtUtcMs: Number.MAX_SAFE_INTEGER }, { ...row, completedAtUtcMs: -1 }]) {
      expect(() => mapPersistedCommandReceipt(value)).toThrow(expect.objectContaining({ code: 'corrupt_state' }));
    }
  });

  it('HostClient accepts only the explicit v6 Work shape and checks response identity', () => {
    const receipt = workReceipt(workInput(randomUUID()));
    expect(validateCommandReceiptWire(receipt, {
      expectedCommandId: receipt.commandId, expectedRequestDigest: DIGEST,
      expectedOperation: 'execution.start',
    })).toEqual(receipt);
    for (const value of [{ ...receipt, schemaVersion: 5 }, { ...receipt, runId: undefined },
      { ...receipt, resultRef: 'secret-path' }]) {
      expect(() => validateCommandReceiptWire(value)).toThrow(expect.objectContaining({ code: 'response_malformed' }));
    }
    for (const value of [{ ...receipt, schemaVersion: 7 }, { ...receipt, operation: 'baseline.run' },
      { ...receipt, status: 'completed' }]) {
      expect(() => validateCommandReceiptWire(value)).toThrow(expect.objectContaining({ code: 'unsupported_schema_version' }));
    }
    for (const expected of [{ expectedCommandId: randomUUID() }, { expectedOperation: 'baseline.run' },
      { expectedRequestDigest: 'cd'.repeat(32) }]) {
      expect(() => validateCommandReceiptWire(receipt, expected)).toThrow(
        expect.objectContaining({ code: 'response_malformed' }),
      );
    }
  });

  it('raw SQLite rejects association changes, parent deletion and mismatched same-project Batch/Run', async () => {
    await withDb(async (session) => {
      const state = createSqliteStateStore(session);
      const a = await state.createProject({ displayName: 'A' });
      const b = await state.createProject({ displayName: 'B' });
      const first = workInput(a.id);
      const second = workInput(a.id);
      seedWork(session, a.id, first.batchId, first.runId);
      seedWork(session, a.id, second.batchId, second.runId);
      const access = createSqliteCommandReceiptAccess(session);
      await access.store.saveReceipt(workReceipt(first));
      for (const [sql, args] of [
        ['project_id = ?', [b.id]], ['run_id = ?', [randomUUID()]],
        ['batch_id = ?, operation_id = ?', [second.batchId, second.batchId]],
        ['operation_id = ?', [randomUUID()]], ['receipt_version = ?', [5]],
        ['receipt_version = ?', [7]], ['run_id = NULL', []], ['batch_id = NULL', []],
        ["operation = 'baseline.run'", []], ["scope_kind = 'global', project_id = NULL", []],
      ] as const) {
        expect(() => session.database.prepare(`UPDATE command_receipts SET ${sql} WHERE command_id = ?`)
          .run(...args, first.commandId)).toThrow();
      }
      for (const [table, id] of [['runs', first.runId], ['execution_batches', first.batchId]] as const) {
        expect(() => session.database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)).toThrow();
      }
      await expect(access.store.saveReceipt(workReceipt({ ...second, runId: first.runId }))).rejects.toMatchObject({
        kind: 'validation', details: { field: 'receipt.association' },
      });
      expect(await access.store.findReceiptByCommandId('local-owner', first.commandId)).toEqual(workReceipt(first));
      expect(session.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
  });

  it('maps association validation and duplicate identities to bounded public errors', () => {
    const storage = new StorageError('validation', 'internal.sql', 'secret SQL', {
      details: { field: 'receipt.association', reason: 'invalid_association', path: '/private/secret' },
    });
    expect(mapStorageError(storage, { operation: 'execution.start' }).toErrorShape()).toEqual({
      code: 'invalid_input', message: expect.any(String),
      details: { field: 'receipt.association', reason: 'invalid_association' },
    });
    const duplicate = new StorageError('conflict', 'internal.sql', 'secret SQL', {
      details: { reason: 'duplicate_command_id' },
    });
    expect(mapStorageError(duplicate, { operation: 'execution.start' }).toErrorShape()).toMatchObject({
      code: 'conflict', details: { reason: 'duplicate_command_id' },
    });
  });

  it('v10 rollback preserves v9 receipts and allows a verified retry; historical checksums stay frozen', async () => {
    expect(SQLITE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
    expect(SQLITE_MIGRATIONS[8]?.checksum).toBe('f1439930aac135ac710910e340023e591e121e5020a73503fe9d1e5d84698053');
    await withDb(async (session) => {
      const v10 = SQLITE_MIGRATIONS[9]!;
      const sql = `${v10.sql}\nTHIS IS INVALID SQL;`;
      await expect(migrateSqliteStorage(session, {
        migrations: [...SQLITE_MIGRATIONS.slice(0, 9), {
          version: 10, sql, checksum: createHash('sha256').update(sql).digest('hex'),
        }],
      })).rejects.toMatchObject({ step: 'apply', version: 10 });
      expect(session.database.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 9 });
      expect(session.database.prepare("SELECT name FROM sqlite_master WHERE name IN ('command_receipts_v10', 'runs_receipt_identity_unique')").all()).toEqual([]);
      expect(session.database.prepare('PRAGMA table_xinfo(command_receipts)').all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'receipt_version' })]),
      );
      const result = await migrateSqliteStorage(session);
      // P03-3 / F-006 起 v11（Task 尝试计数列与预占账本表）随修复后重试一并应用。
      expect(result.appliedVersions).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
      expect(session.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    }, 9);
  });

  it.each([5, 9])('upgrades real v%s baseline receipts without changing identity or replay', async (version) => {
    await withDb(async (session) => {
      const project = await createSqliteStateStore(session).createProject({ displayName: 'Legacy' });
      const operationId = randomUUID();
      session.database.prepare(
        "INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status) VALUES (?, ?, ?, ?, 'baseline', 'accepted')",
      ).run(operationId, NOW, NOW, project.id);
      const identity = { commandId: randomUUID(), principalId: 'local-owner', operation: 'baseline.run' as const,
        scope: { kind: 'project' as const, projectId: project.id }, requestDigest: DIGEST, issuedAt: ISO, completedAt: ISO };
      const receipts = [
        createAcceptedReceipt({ ...identity, operationId }),
        createCompletedReceipt({ ...identity, commandId: randomUUID(), result: { ok: true }, resultRef: createResultRef(new Uint8Array(32)) }),
        createRejectedReceipt({ ...identity, commandId: randomUUID(), error: new PublicError('conflict', 'baseline.run') }),
      ];
      // Seed historical columns directly: the current adapter targets the latest schema.
      for (const receipt of receipts) session.database.prepare(
        'INSERT INTO command_receipts (id, created_at, updated_at, principal_id, command_id, scope_kind, project_id, operation, ' +
        'request_digest, status, operation_id, result_json, result_ref, error_code, error_message, issued_at, completed_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(randomUUID(), NOW, NOW, receipt.principalId, receipt.commandId, 'project', project.id, receipt.operation, DIGEST,
        receipt.status, receipt.status === 'accepted' ? receipt.operationId : null,
        receipt.status === 'completed' ? JSON.stringify(receipt.result) : null,
        receipt.status === 'completed' ? receipt.resultRef : null,
        receipt.status === 'rejected' ? receipt.error.code : null,
        receipt.status === 'rejected' ? receipt.error.message : null, NOW, NOW);
      const rows = session.database.prepare('SELECT * FROM command_receipts ORDER BY command_id').all();
      await migrateSqliteStorage(session);
      const access = createSqliteCommandReceiptAccess(session);
      for (const receipt of receipts) {
        const stored = await access.store.findReceiptByCommandId('local-owner', receipt.commandId);
        expect(stored).toEqual(receipt);
        expect(decideCommandReplay(stored, DIGEST, 'baseline.run')).toMatchObject({
          kind: 'replay', receipt: { ...receipt, replayed: true },
        });
      }
      expect(session.database.prepare('SELECT * FROM command_receipts ORDER BY command_id').all()).toMatchObject(rows);
    }, version);
  });
});
