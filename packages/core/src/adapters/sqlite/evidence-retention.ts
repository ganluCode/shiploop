import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SqliteStorageSession } from './session.js';
import type { MaintenanceLease, MaintenanceWriteGate } from '../../ports/data-maintenance.js';
import type { DiskUsageObserver } from '../../ports/retention-evaluation.js';
import type { RetentionPolicyV2 } from '../../ports/settings-schema.js';
import type {
  RetentionCleanupCandidate, RetentionCleanupSnapshot, RetentionCleanupStore, RetentionObjectIdentity,
  RetentionReference,
} from '../../ports/evidence-retention.js';
import { deriveArtifactFinalRelativePath } from '../../ports/artifact-files.js';
import { StorageError } from '../../ports/errors.js';

const OPERATION = 'retention.cleanup';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX = /^[0-9a-f]{64}$/;
type Row = Record<string, unknown>;

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function validId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new StorageError('validation', OPERATION, `${field} 非法`);
  return value;
}
function tableExists(session: SqliteStorageSession, name: string): boolean {
  return session.database.prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}
function columns(session: SqliteStorageSession, table: string): string[] {
  return (session.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
}
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}
function collectArtifactIds(value: unknown, known: ReadonlySet<string>, output: Set<string>): boolean {
  if (Array.isArray(value)) return value.reduce((ok, item) => collectArtifactIds(item, known, output) && ok, true);
  if (value === null || typeof value !== 'object') return value === undefined;
  let valid = true;
  for (const [key, child] of Object.entries(value as Row)) {
    if ((key === 'artifactId' || key === 'artifact_id' || key.endsWith('_artifact_id')) && typeof child === 'string' && known.has(child)) output.add(child);
    else if (key.endsWith('Ref') || key.endsWith('_ref')) {
      if (typeof child === 'string' && known.has(child)) output.add(child);
      else if (child !== null && child !== undefined && typeof child !== 'string') valid = collectArtifactIds(child, known, output) && valid;
    } else if (typeof child === 'object' && child !== null) valid = collectArtifactIds(child, known, output) && valid;
  }
  return valid;
}
function sourceKind(table: string): RetentionReference['sourceKind'] {
  const lower = table.toLowerCase();
  if (lower.includes('verification') || lower.includes('check')) return 'verification-output';
  if (lower.includes('recording') || lower.includes('session')) return 'recorder';
  if (lower.includes('attempt') || lower.includes('run')) return 'execution-input';
  if (lower.includes('document')) return 'document-version';
  if (lower.includes('git') || lower.includes('delivery')) return 'delivery-input';
  if (lower.includes('operation')) return 'operation';
  return 'unknown';
}
function safeObjectPath(root: string, relativePath: string): string {
  const absolute = resolve(root, ...relativePath.split('/'));
  if (absolute !== root && !absolute.startsWith(root + sep)) throw new StorageError('ownership', OPERATION, '受管文件越出数据根');
  return absolute;
}

export interface SqliteRetentionCleanupStoreOptions {
  readonly session: SqliteStorageSession;
  readonly dataRoot: string;
  readonly backupRoot?: string;
  readonly maintenanceGate: MaintenanceWriteGate;
  readonly owner?: string;
  readonly hostInstanceId?: string;
  readonly nowUtcMs?: () => number;
  readonly disk?: DiskUsageObserver;
}

export function createSqliteRetentionCleanupStore(options: SqliteRetentionCleanupStoreOptions): RetentionCleanupStore {
  if (!isAbsolute(options.dataRoot) || options.dataRoot.includes('\0')) throw new TypeError('dataRoot 必须是绝对路径');
  const dataRoot = resolve(options.dataRoot);
  if (!existsSync(dataRoot)) throw new StorageError('not_found', OPERATION, '受管数据根不存在');
  const backupRoot = resolve(options.backupRoot ?? join(dataRoot, 'backups'));
  const now = options.nowUtcMs ?? Date.now;
  const owner = validId(options.owner ?? 'retention-cleanup', 'owner');
  const hostInstanceId = validId(options.hostInstanceId ?? 'core', 'hostInstanceId');
  let lease: MaintenanceLease | undefined;
  let activePolicy: RetentionPolicyV2 = {};

  function artifactRows(): Row[] {
    return tableExists(options.session, 'artifacts')
      ? options.session.database.prepare('SELECT * FROM artifacts ORDER BY project_id, id').all() as Row[] : [];
  }
  function readSnapshotSync(policy: RetentionPolicyV2, at: number): RetentionCleanupSnapshot {
    const rows = artifactRows();
    const known = new Set(rows.map(row => String(row.id)));
    const refs: RetentionReference[] = [];
    const unknownReasons: string[] = [];
    const refColumns = new Set(['input_ref', 'code_ref', 'diagnostic_ref', 'result_ref', 'content_ref', 'manifest_ref', 'output_artifact_id', 'candidate_artifact_id', 'native_ref', 'checkpoint_ref']);
    const tables = (options.session.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(row => row.name);
    for (const table of tables) {
      if (table === 'artifacts' || table === 'schema_migrations') continue;
      const tableColumns = columns(options.session, table);
      const rowsForTable = options.session.database.prepare(`SELECT * FROM ${table}`).all() as Row[];
      for (const row of rowsForTable) {
        const found = new Set<string>();
        for (const column of tableColumns) {
          const value = row[column];
          const isJsonField = column.endsWith('_json') || column.endsWith('_refs') || column.endsWith('_snapshot') || column.endsWith('_ref') || refColumns.has(column);
          if (!isJsonField) continue;
          if (typeof value === 'string' && (column.endsWith('_json') || column.endsWith('_refs') || column.endsWith('_snapshot'))) {
            const parsed = parseJson(value);
            if (parsed === undefined) { unknownReasons.push(`invalid_reference_json:${table}.${column}`); continue; }
            collectArtifactIds(parsed, known, found);
          } else if (typeof value === 'string' && known.has(value)) found.add(value);
        }
        for (const artifactId of found) refs.push({ sourceKind: sourceKind(table), sourceId: String(row.id ?? table), objectKind: 'artifact', objectId: artifactId, reason: `${table}_reference` });
        if (table.includes('operation') && typeof row.status === 'string' && !['completed', 'succeeded', 'failed', 'cancelled', 'rejected'].includes(row.status)) {
          unknownReasons.push(`pending_operation:${table}:${String(row.id ?? 'unknown')}`);
        }
      }
    }
    const objects: RetentionObjectIdentity[] = rows.map(row => {
      const projectId = validId(row.project_id, 'artifact.project_id');
      const artifactId = validId(row.id, 'artifact.id');
      const fileRelativePath = deriveArtifactFinalRelativePath({ projectId, artifactId });
      let fileIdentity: RetentionObjectIdentity['fileIdentity'];
      try {
        const stat = lstatSync(safeObjectPath(dataRoot, fileRelativePath));
        if (stat.isFile() && !stat.isSymbolicLink()) fileIdentity = { dev: stat.dev, ino: stat.ino, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
      } catch { /* missing/invalid bodies become an explicit unknown below */ }
      return {
        kind: 'artifact', id: artifactId, projectId, revision: Number(row.revision), createdAtUtcMs: Number(row.created_at), updatedAtUtcMs: Number(row.updated_at),
        bytes: row.size_bytes === null ? 0 : Number(row.size_bytes), fileRelativePath, ...(fileIdentity === undefined ? {} : { fileIdentity }),
        digest: row.content_hash === null ? undefined : String(row.content_hash), metadata: { status: row.status, kind: row.kind, version: row.version, fileIdentityRequired: true },
      };
    });


    const backups: RetentionObjectIdentity[] = [];
    if (existsSync(backupRoot)) {
      for (const entry of readdirSync(backupRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !ID.test(entry.name) || entry.name.startsWith('.')) continue;
        const manifestPath = join(backupRoot, entry.name, 'manifest.json');
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Row;
          const createdAt = Date.parse(String(manifest.createdAtUtc));
          if (!Number.isFinite(createdAt)) throw new Error('backup_created_at_invalid');
          const bytes = Array.isArray(manifest.files) ? (manifest.files as Row[]).reduce((sum, file) => sum + Number(file.sizeBytes ?? 0), 0) : 0;
          backups.push({ kind: 'backup', id: entry.name, revision: 1, createdAtUtcMs: createdAt, updatedAtUtcMs: createdAt, bytes, fileRelativePath: relative(dataRoot, join(backupRoot, entry.name)), digest: digest(manifest) });
        } catch { unknownReasons.push(`backup_manifest_unreadable:${entry.name}`); }
      }
    }
    const revision = digest({ artifacts: rows.map(row => [row.id, row.revision, row.updated_at, row.content_hash, row.size_bytes]), refs, backups: backups.map(item => [item.id, item.digest]), policy });
    return { schemaVersion: 1, generatedAtUtcMs: at, policy, revision, objects, references: refs, unknownReasons: [...new Set(unknownReasons)], backups };
  }

  async function readSnapshot(policy: RetentionPolicyV2, at: number): Promise<RetentionCleanupSnapshot> {
    const snapshot = readSnapshotSync(policy, at);
    if (options.disk === undefined) return snapshot;
    let observation;
    try { observation = await options.disk.observe(); }
    catch { return { ...snapshot, unknownReasons: [...snapshot.unknownReasons, 'disk_observation_unknown'] }; }
    const hasUnknown = observation.status !== 'observed'
      || typeof observation.availableBytes !== 'number' || typeof observation.totalBytes !== 'number';
    const bytesTriggered = policy.diskMinFreeBytes !== undefined && observation.availableBytes !== undefined
      && observation.availableBytes < policy.diskMinFreeBytes;
    const percent = observation.totalBytes === undefined || observation.totalBytes <= 0 || observation.availableBytes === undefined
      ? undefined : (observation.availableBytes / observation.totalBytes) * 100;
    const percentTriggered = policy.diskMinFreePercent !== undefined && percent !== undefined
      && percent < policy.diskMinFreePercent;
    const reasons = hasUnknown && (policy.diskMinFreeBytes !== undefined || policy.diskMinFreePercent !== undefined)
      ? [...snapshot.unknownReasons, 'disk_observation_unknown'] : snapshot.unknownReasons;
    // A triggered threshold authorizes evaluation of eligible objects; it never
    // weakens reference, identity, or unique-backup protection.
    void bytesTriggered; void percentTriggered;
    return { ...snapshot, unknownReasons: [...new Set(reasons)] };
  }
  async function beginOperation(input: { readonly operationId: string; readonly policy: RetentionPolicyV2; readonly snapshot: RetentionCleanupSnapshot; readonly nowUtcMs: number }): Promise<void> {
    const operationId = validId(input.operationId, 'operationId');
    activePolicy = input.policy;
    const existing = options.session.database.prepare('SELECT status FROM retention_operations WHERE id = ?').get(operationId) as { status: string } | undefined;
    if (existing !== undefined) return;
    // v55 maintenance_occupancy is shared with backup and referenced by v56 guards;
    // cleanup uses that existing exclusive category without rebuilding the table.
    lease = options.maintenanceGate.acquire({ operation: 'backup', operationId, owner, hostInstanceId, nowUtcMs: input.nowUtcMs });
    options.session.transactWrite(OPERATION, db => {
      db.prepare(`INSERT INTO retention_operations (id, revision, created_at, updated_at, operation_kind, status, policy_digest, snapshot_revision, input_json) VALUES (?, 1, ?, ?, 'cleanup', 'running', ?, ?, ?)`)
        .run(operationId, input.nowUtcMs, input.nowUtcMs, digest(input.policy), input.snapshot.revision, JSON.stringify({ schemaVersion: 1, policy: input.policy }));
      const all = [...input.snapshot.objects, ...input.snapshot.backups];
      const insert = db.prepare('INSERT INTO retention_operation_items (operation_id, item_index, object_kind, object_id, object_revision, status, bytes, identity_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      all.forEach((item, index) => insert.run(operationId, index, item.kind, item.id, item.revision, 'pending', item.bytes, JSON.stringify(item)));
    });
  }
  async function readOperation(operationId: string) {
    const row = options.session.database.prepare('SELECT status, snapshot_revision, next_index, items_deleted, bytes_deleted FROM retention_operations WHERE id = ?').get(validId(operationId, 'operationId')) as Row | undefined;
    if (row === undefined) throw new StorageError('not_found', OPERATION, '清理操作不存在');
    return { status: String(row.status), snapshotRevision: String(row.snapshot_revision), nextIndex: Number(row.next_index), itemsDeleted: Number(row.items_deleted), bytesDeleted: Number(row.bytes_deleted) };
  }
  function referenceExists(objectId: string): boolean {
    const snapshot = readSnapshotSync(activePolicy, now());
    return snapshot.references.some(reference => reference.objectId === objectId);
  }
  async function recheckCandidate(candidate: RetentionCleanupCandidate, at: number) {
    const object = candidate.object;
    if (object.kind === 'artifact') {
      const row = options.session.database.prepare('SELECT revision, updated_at, content_hash, size_bytes, project_id FROM artifacts WHERE id = ?').get(object.id) as Row | undefined;
      if (row === undefined) return { allowed: false, reason: 'object_missing', candidate };
      if (Number(row.revision) !== object.revision || Number(row.updated_at) !== object.updatedAtUtcMs || Number(row.size_bytes ?? 0) !== object.bytes) return { allowed: false, reason: 'object_revision_changed', candidate };
      if (referenceExists(object.id)) return { allowed: false, reason: 'reference_added_after_snapshot', candidate };
      if (candidate.expectedSnapshotRevision !== readSnapshotSync(activePolicy, at).revision) return { allowed: false, reason: 'snapshot_revision_changed', candidate };
      const file = safeObjectPath(dataRoot, object.fileRelativePath ?? '');
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile() || object.fileIdentity === undefined
          || stat.dev !== object.fileIdentity.dev || stat.ino !== object.fileIdentity.ino
          || stat.size !== object.fileIdentity.sizeBytes || stat.mtimeMs !== object.fileIdentity.mtimeMs) {
          return { allowed: false, reason: 'file_identity_changed', candidate };
        }
      } catch { return { allowed: false, reason: 'file_identity_unavailable', candidate }; }
      return { allowed: true, candidate };
    }
    if (object.kind === 'backup') {
      const path = safeObjectPath(dataRoot, object.fileRelativePath ?? '');
      if (!existsSync(path)) return { allowed: false, reason: 'backup_missing', candidate };
      const manifestPath = join(path, 'manifest.json');
      try { if (digest(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== object.digest) return { allowed: false, reason: 'backup_manifest_changed', candidate }; }
      catch { return { allowed: false, reason: 'backup_manifest_unreadable', candidate }; }
      return { allowed: true, candidate };
    }
    return { allowed: false, reason: 'unsupported_object_kind', candidate };
  }
  async function deleteCandidate(candidate: RetentionCleanupCandidate) {
    const object = candidate.object;
    const operationId = options.session.database.prepare('SELECT id FROM retention_operations WHERE status = \'running\' ORDER BY updated_at DESC LIMIT 1').get() as { id: string } | undefined;
    if (operationId === undefined) throw new StorageError('conflict', OPERATION, '清理操作未运行');
    if (object.kind === 'artifact') {
      const file = safeObjectPath(dataRoot, object.fileRelativePath ?? '');
      options.session.transactWrite(OPERATION, db => {
        const row = db.prepare('SELECT project_id, revision FROM artifacts WHERE id = ?').get(object.id) as Row | undefined;
        if (row === undefined || Number(row.revision) !== object.revision) throw new StorageError('conflict', OPERATION, '制品修订已变化');
        db.prepare('DELETE FROM artifacts WHERE id = ? AND revision = ?').run(object.id, object.revision);
      });
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== object.bytes) throw new Error('file_identity_changed');
        unlinkSync(file);
      } catch (error) {
        options.session.transactWrite(OPERATION, db => db.prepare('UPDATE retention_operation_items SET status = \'isolated\', reason = ? WHERE operation_id = ? AND object_id = ?').run(error instanceof Error ? error.message : 'file_delete_failed', operationId.id, object.id));
        return { deleted: true, bytesDeleted: object.bytes, reason: 'artifact_row_deleted_file_isolated' };
      }
      options.session.transactWrite(OPERATION, db => db.prepare('UPDATE retention_operation_items SET status = \'deleted\' WHERE operation_id = ? AND object_id = ?').run(operationId.id, object.id));
      return { deleted: true, bytesDeleted: object.bytes };
    }
    if (object.kind === 'backup') {
      const path = safeObjectPath(dataRoot, object.fileRelativePath ?? '');
      rmSync(path, { recursive: true, force: false });
      options.session.transactWrite(OPERATION, db => db.prepare('UPDATE retention_operation_items SET status = \'deleted\' WHERE operation_id = ? AND object_id = ?').run(operationId.id, object.id));
      return { deleted: true, bytesDeleted: object.bytes };
    }
    return { deleted: false, bytesDeleted: 0, reason: 'unsupported_object_kind' };
  }
  async function finishOperation(input: { readonly operationId: string; readonly status: string; readonly nextIndex: number; readonly itemsDeleted: number; readonly bytesDeleted: number; readonly reason?: string; readonly nowUtcMs: number }): Promise<void> {
    options.session.transactWrite(OPERATION, db => db.prepare('UPDATE retention_operations SET revision = revision + 1, updated_at = ?, status = ?, next_index = ?, items_examined = ?, items_deleted = ?, bytes_deleted = ?, last_error = ? WHERE id = ?').run(input.nowUtcMs, input.status, input.nextIndex, input.nextIndex, input.itemsDeleted, input.bytesDeleted, input.reason ?? null, input.operationId));
    if (lease !== undefined) {
      const confirmed = input.status === 'completed' || input.status === 'partial';
      options.maintenanceGate.release({ ...lease, confirmed, ...(confirmed ? {} : { reason: 'cleanup_unconfirmed' }) });
      lease = undefined;
    }
  }
  return { readSnapshot: async (policy, at) => readSnapshot(policy, at), beginOperation, readOperation, recheckCandidate, deleteCandidate, finishOperation };
}
