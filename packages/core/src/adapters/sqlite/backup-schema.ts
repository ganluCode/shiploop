import type Database from 'better-sqlite3';
import { inspectSqliteSchema } from './migrator.js';

/** Backup reads use the columns available since each table's introduction. A missing
 * post-version table is corruption; a pre-version table is intentionally absent.
 * Do not instantiate latest-schema stores against an old database. */
const BACKUP_READS: ReadonlyArray<readonly [string, number, readonly string[]]> = [
  ['projects', 1, ['id', 'status']],
  ['artifacts', 1, ['id', 'project_id', 'status', 'kind', 'expected_hash', 'content_hash', 'size_bytes', 'version', 'media_type']],
  ['repository_bindings', 1, ['id', 'project_id']],
  ['attempts', 14, ['project_id', 'input_ref', 'code_ref', 'diagnostic_ref']],
  ['managed_workspaces', 18, ['id', 'project_id']],
  ['sessions', 20, ['id', 'project_id', 'input_ref', 'result_ref', 'native_ref', 'recording_watermark', 'recording_gaps']],
  ['session_messages', 32, ['project_id', 'content_ref', 'source_refs', 'attachment_refs']],
  ['recording_manifests', 32, ['project_id', 'session_id', 'manifest_ref', 'watermark', 'coverage', 'missing_reasons', 'sdk_version', 'format_version', 'version']],
  ['capability_modules', 48, ['project_id', 'content_ref']],
  ['document_versions', 49, ['project_id', 'content_ref', 'source_refs']],
  ['memory_records', 49, ['project_id', 'content_ref', 'source_refs']],
];

export function assertBackupSchemaReadable(db: Database.Database): void {
  const { fromVersion } = inspectSqliteSchema(db);
  if (fromVersion < 1) throw new Error('backup_schema_uninitialized');
  for (const [table, introduced, fields] of BACKUP_READS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (fromVersion < introduced) {
      if (columns.length !== 0) throw new Error('backup_schema_unexpected_table');
      continue;
    }
    const names = new Set(columns.map(column => column.name));
    if (fields.some(field => !names.has(field))) throw new Error('backup_schema_read_unsupported');
  }
}
