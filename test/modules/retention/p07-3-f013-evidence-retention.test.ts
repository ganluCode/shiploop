import { describe, expect, it } from 'vitest';
import { createRetentionCleanupService } from '../../../packages/core/src/application/evidence-retention.ts';
import type { RetentionPolicyV2 } from '../../../packages/core/src/ports/settings-schema.ts';
import type { RetentionCleanupSnapshot, RetentionCleanupStore } from '../../../packages/core/src/ports/evidence-retention.ts';
import { createSqliteRetentionCleanupStore } from '../../../packages/core/src/adapters/sqlite/evidence-retention.ts';
import { createSqliteMaintenanceWriteGate } from '../../../packages/core/src/adapters/sqlite/data-maintenance.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW = 1_900_000_000_000;
const policy: RetentionPolicyV2 = { evidenceRetentionDays: 10, backupRetentionDays: 10, maxBackupCount: 2 };
const artifact = (id: string, days: number, bytes = 10) => ({
  kind: 'artifact' as const, id, projectId: 'p1', revision: 1, createdAtUtcMs: NOW - days * 86_400_000,
  updatedAtUtcMs: NOW - days * 86_400_000, bytes, fileRelativePath: `projects/p1/artifacts/${id}/content`,
});
const backup = (id: string, days: number, bytes = 20) => ({
  kind: 'backup' as const, id, revision: 1, createdAtUtcMs: NOW - days * 86_400_000,
  updatedAtUtcMs: NOW - days * 86_400_000, bytes,
});

function storeOf(snapshot: RetentionCleanupSnapshot): RetentionCleanupStore & { deleted: string[] } {
  const deleted: string[] = [];
  let operation = { status: 'planned', snapshotRevision: snapshot.revision, nextIndex: 0, itemsDeleted: 0, bytesDeleted: 0 };
  return {
    deleted,
    readSnapshot: async () => snapshot,
    beginOperation: async () => { operation = { ...operation, status: 'running' }; },
    readOperation: async () => operation,
    recheckCandidate: async candidate => ({ allowed: candidate.referenceCount === 0, reason: candidate.referenceCount === 0 ? undefined : 'referenced', candidate }),
    deleteCandidate: async candidate => { deleted.push(candidate.object.id); return { deleted: true, bytesDeleted: candidate.object.bytes }; },
    finishOperation: async input => { operation = { ...operation, status: input.status, nextIndex: input.nextIndex, itemsDeleted: input.itemsDeleted, bytesDeleted: input.bytesDeleted }; },
  };
}

describe('P07-3 F-013 evidence retention', () => {
  it('[case:reference-protection-and-bounded-rotation] protects referenced evidence and keeps newest backup', async () => {
    const store = storeOf({
      schemaVersion: 1, generatedAtUtcMs: NOW, policy, revision: 'r1',
      objects: [artifact('old-unreferenced', 30), artifact('old-referenced', 30)],
      references: [{ sourceKind: 'verification-output', sourceId: 'check-1', objectKind: 'artifact', objectId: 'old-referenced', reason: 'verification_output' }],
      unknownReasons: [], backups: [backup('newest', 1), backup('old', 30), backup('older', 40)],
    });
    const service = createRetentionCleanupService({ store, nowUtcMs: () => NOW });
    const evaluation = await service.evaluate({ policy });
    expect(evaluation.candidates.map(item => item.object.id)).toContain('old-unreferenced');
    expect(evaluation.retained.find(item => item.object.id === 'old-referenced')?.reasons).toContain('verification_output');
    expect(evaluation.backupCandidates.map(item => item.object.id)).toEqual(['old', 'older']);

    const result = await service.execute({ operationId: 'retention-1', policy, limits: { maxItems: 1, maxBytes: 10 } });
    expect(result.status).toBe('partial');
    expect(store.deleted).toEqual(['old-unreferenced']);
    expect(result.retained.some(item => item.object.id === 'old-referenced')).toBe(true);
  });

  it('[case:sqlite-progress-and-real-file-cleanup] persists the cleanup operation and removes only an unreferenced expired artifact', async () => {
    const sandbox = createTempSandbox('shiploop-p07-3-f013-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'core.sqlite') });
    try {
      await migrateSqliteStorage(session);
      const body = new TextEncoder().encode('expired evidence');
      const artifactPath = join(sandbox.path, 'projects', 'p1', 'artifacts', 'a1', 'content');
      mkdirSync(join(artifactPath, '..'), { recursive: true });
      writeFileSync(artifactPath, body);
      session.transactWrite('fixture.seed', db => {
        db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('p1', ?, 1, ?, 'P1', 'active', '[]')").run(NOW - 40 * 86_400_000, NOW - 40 * 86_400_000);
        db.prepare("INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason) VALUES ('a1', ?, 'p1', 1, ?, 'recording', 'ready', 'text/plain', ?, ?, ?, 1, 'recording/a1', NULL)").run(NOW - 40 * 86_400_000, NOW - 40 * 86_400_000, 'a'.repeat(64), 'a'.repeat(64), body.byteLength);
      });
      const store = createSqliteRetentionCleanupStore({ session, dataRoot: sandbox.path, maintenanceGate: createSqliteMaintenanceWriteGate(session), nowUtcMs: () => NOW });
      const service = createRetentionCleanupService({ store, nowUtcMs: () => NOW });
      const result = await service.execute({ operationId: 'cleanup-1', policy: { evidenceRetentionDays: 10 }, limits: { maxItems: 10, maxBytes: 1000 } });
      expect(result.status).toBe('completed');
      expect(result.itemsDeleted).toBe(1);
      expect(existsSync(artifactPath)).toBe(false);
      expect(session.database.prepare("SELECT id FROM artifacts WHERE id = 'a1'").get()).toBeUndefined();
      expect(session.database.prepare("SELECT status, items_deleted FROM retention_operations WHERE id = 'cleanup-1'").get()).toEqual({ status: 'completed', items_deleted: 1 });
      expect(session.database.prepare("SELECT status FROM retention_operation_items WHERE operation_id = 'cleanup-1' AND object_id = 'a1'").get()).toEqual({ status: 'deleted' });
    } finally {
      session.close();
      sandbox.cleanup();
    }
  });
});
