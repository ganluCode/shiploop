/** Internal database snapshot fence. File/Git inspection stays outside write transactions. */
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { stableStringify } from '../../ports/feature-plan.js';

export function quoteSqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function projectDeleteOwnershipPredicate(table: string): string {
  return table === 'command_receipts' ? "COALESCE(project_id, CASE WHEN scope_kind = 'registration' AND status = 'completed' THEN json_extract(result_json, '$.project.id') END) = ?" : 'project_id = ?';
}

export function computeProjectDeleteDatabaseDigest(db: Database, projectId: string): string {
  const hash = createHash('sha256');
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string; sql: string }[];
  for (const { name, sql } of tables) {
    // Keep schema and reference changes in the fence, including unknown new tables.
    hash.update(stableStringify([name, sql]));
    const quoted = quoteSqliteIdentifier(name);
    const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string; pk: number }[];
    const hasProject = columns.some(column => column.name === 'project_id');
    if (!hasProject && name !== 'projects' && name !== 'verification_processes') continue;
    const order = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => quoteSqliteIdentifier(column.name)).join(',') || 'rowid';
    const where = name === 'projects' ? 'id = ?'
      : name === 'verification_processes' ? 'batch_id IN (SELECT id FROM verification_batches WHERE project_id = ?)'
      : projectDeleteOwnershipPredicate(name);
    const exclude = name === 'command_receipts' ? " AND operation <> 'project.delete.preview'" : '';
    for (const row of db.prepare(`SELECT * FROM ${quoted} WHERE ${where}${exclude} ORDER BY ${order}`).iterate(projectId)) {
      hash.update(stableStringify(row));
    }
    // JSON/non-FK artifact references may originate in other projects. Hash only
    // reference columns, streaming rows rather than retaining business bodies.
    const refs = columns.filter(column => /^(input_ref|code_ref|diagnostic_ref|result_ref|content_ref|manifest_ref|output_artifact_id|candidate_artifact_id|source_refs|attachment_refs)$/.test(column.name));
    if (hasProject && name !== 'command_receipts' && refs.length > 0) {
      for (const row of db.prepare(`SELECT project_id, ${refs.map(c => quoteSqliteIdentifier(c.name)).join(',')} FROM ${quoted} ORDER BY ${order}`).iterate()) {
        hash.update(stableStringify(row));
      }
    }
  }
  return hash.digest('hex');
}
