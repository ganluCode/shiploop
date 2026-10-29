import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import {
  validateMemoryRecordInput,
  type KnowledgeArtifactRef,
  type KnowledgeSourceRef,
  type MemoryRecord,
  type MemoryRecordStatus,
  type MemoryStore,
} from '../../ports/knowledge.js';
import type { MemoryQueryFilter, MemoryQueryReadStore, MemoryQueryRow } from '../../ports/memory-query.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

interface MemoryRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly record_key: string;
  readonly version: number;
  readonly scope: string;
  readonly status: string;
  readonly content_ref: string;
  readonly content_hash: string;
  readonly source_refs: string;
  readonly retrieval_count: number;
}

interface ArtifactRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: string;
  readonly content_hash: string | null;
  readonly expected_hash: string;
  readonly size_bytes: number | null;
  readonly version: number;
  readonly storage_locator: string;
}

const STATUSES = new Set(['candidate', 'accepted', 'revoked']);

function parseSources(value: string, projectId: string, operation: string): KnowledgeSourceRef[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) {
    throw new StorageError('corrupt', operation, '记忆来源索引不是有效 JSON', { entity: { type: 'memory_record', projectId }, details: { reason: 'invalid_source_refs_json' }, cause });
  }
  try {
    return validateMemoryRecordInput({
      projectId, recordKey: 'placeholder', version: 1, scope: 'placeholder', status: 'candidate',
      contentRef: { projectId, artifactId: 'placeholder', version: 1, contentHash: 'ab'.repeat(32), sizeBytes: 0 },
      sourceRefs: parsed,
    }, operation).sourceRefs;
  } catch (cause) {
    throw new StorageError('corrupt', operation, '记忆来源索引形状非法', { entity: { type: 'memory_record', projectId }, details: { reason: 'invalid_source_refs_shape' }, cause });
  }
}

function artifactRef(row: ArtifactRow, projectId: string, operation: string): KnowledgeArtifactRef {
  if (row.project_id !== projectId) throw new StorageError('ownership', operation, '记忆正文制品不属于请求项目', { entity: { type: 'memory_record', projectId } });
  if (row.status !== 'ready' || row.content_hash === null || row.size_bytes === null || row.content_hash !== row.expected_hash) {
    throw new StorageError('corrupt', operation, '记忆正文制品身份不可用', { entity: { type: 'artifact', id: row.id, projectId }, details: { reason: 'artifact_identity_incomplete' } });
  }
  return { projectId, artifactId: row.id, version: row.version, contentHash: row.content_hash, sizeBytes: row.size_bytes };
}

function mapRow(row: MemoryRow, db: Database.Database, operation: string): MemoryRecord {
  if (!STATUSES.has(row.status) || !Number.isInteger(row.revision) || row.revision < 1 || !Number.isInteger(row.version) || row.version < 1 || !Number.isInteger(row.retrieval_count) || row.retrieval_count < 0) {
    throw new StorageError('corrupt', operation, '记忆索引字段损坏', { entity: { type: 'memory_record', id: row.id, projectId: row.project_id }, details: { reason: 'invalid_memory_shape' } });
  }
  const sourceRefs = parseSources(row.source_refs, row.project_id, operation);
  const artifact = db.prepare<[string], ArtifactRow>('SELECT id, project_id, status, content_hash, expected_hash, size_bytes, version, storage_locator FROM artifacts WHERE id = ?').get(row.content_ref) as ArtifactRow | undefined;
  if (artifact === undefined) throw new StorageError('corrupt', operation, '记忆正文制品不存在', { entity: { type: 'memory_record', id: row.id, projectId: row.project_id }, details: { reason: 'content_artifact_missing' } });
  const contentRef = artifactRef(artifact, row.project_id, operation);
  if (contentRef.contentHash !== row.content_hash) throw new StorageError('corrupt', operation, '记忆正文 hash 与制品不一致', { entity: { type: 'memory_record', id: row.id, projectId: row.project_id }, details: { reason: 'content_hash_mismatch' } });
  return {
    id: row.id, projectId: row.project_id, recordKey: row.record_key, version: row.version, scope: row.scope,
    status: row.status as MemoryRecordStatus, contentRef, contentHash: contentRef.contentHash, sourceRefs, retrievalCount: row.retrieval_count,
    revision: row.revision, createdAtUtcMs: row.created_at, updatedAtUtcMs: row.updated_at,
  };
}

function sourceArtifacts(db: Database.Database, record: MemoryRecord): readonly string[] {
  return record.sourceRefs.map(source => {
    const row = db.prepare<[string], ArtifactRow>('SELECT id, project_id, status, content_hash, expected_hash, size_bytes, version, storage_locator FROM artifacts WHERE id = ?').get(source.artifactId) as ArtifactRow | undefined;
    // Source availability and identity are checked by the application query service so
    // a damaged source becomes a per-record diagnostic instead of aborting the index scan.
    return row?.project_id === record.projectId && row.status === 'ready' ? row.storage_locator : '';
  });
}

export interface SqliteMemoryStoreOptions { readonly nowUtcMs?: () => number; }

export function createSqliteMemoryStore(session: SqliteStorageSession, options: SqliteMemoryStoreOptions = {}): MemoryStore {
  if (session === null || typeof session !== 'object') throw new TypeError('createSqliteMemoryStore: session 必须是 SqliteStorageSession');
  const nowUtcMs = options.nowUtcMs ?? Date.now;
  const assertOpen = (operation: string) => { if (!session.isOpen()) throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`); };
  const projectId = (value: string, operation: string) => validateStableId(value, { operation, entity: { type: 'project', id: value } }, 'projectId');
  const requireProject = (db: Database.Database, id: string, operation: string) => {
    if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) === undefined) throw new StorageError('not_found', operation, '项目不存在', { entity: { type: 'project', id } });
  };
  const requireArtifact = (db: Database.Database, project: string, id: string, operation: string): ArtifactRow => {
    const row = db.prepare<[string], ArtifactRow>('SELECT id, project_id, status, content_hash, expected_hash, size_bytes, version, storage_locator FROM artifacts WHERE id = ?').get(validateStableId(id, { operation }, 'artifactId')) as ArtifactRow | undefined;
    if (row === undefined) throw new StorageError('not_found', operation, '制品不存在', { entity: { type: 'artifact', projectId: project } });
    const ref = artifactRef(row, project, operation);
    if (ref.artifactId !== id) throw new StorageError('ownership', operation, '制品归属不一致', { entity: { type: 'artifact', projectId: project } });
    return row;
  };
  const record = (db: Database.Database, id: string, project: string, operation: string): MemoryRecord => {
    const row = db.prepare<[string, string], MemoryRow>('SELECT * FROM memory_records WHERE id = ? AND project_id = ?').get(id, project) as MemoryRow | undefined;
    if (row === undefined) throw new StorageError('not_found', operation, '记忆记录不存在', { entity: { type: 'memory_record', projectId: project } });
    return mapRow(row, db, operation);
  };
  const audit = (db: Database.Database, project: string, id: string, revision: number, status: MemoryRecordStatus, timestamp: number) => {
    const next = (db.prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events').get()?.next ?? 1);
    db.prepare('INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), timestamp, timestamp, project, next, `memory.${status}`, 'memory_record', id, revision, JSON.stringify({ schemaVersion: 1, status }), timestamp);
  };
  return {
    async createMemoryRecord(input: unknown): Promise<MemoryRecord> {
      const operation = 'MemoryStore.createMemoryRecord';
      assertOpen(operation);
      const valid = validateMemoryRecordInput(input, operation);
      if (valid.status !== 'candidate') throw new StorageError('validation', operation, '记忆只能由受控服务先创建为 candidate', { details: { reason: 'accepted_write_requires_explicit_review' } });
      if (valid.sourceRefs.length === 0) throw new StorageError('validation', operation, '记忆候选必须带来源引用', { details: { reason: 'source_required' } });
      const id = randomUUID(); const now = nowUtcMs();
      return session.transactWrite(operation, db => {
        requireProject(db, valid.projectId, operation);
        const content = requireArtifact(db, valid.projectId, valid.contentRef.artifactId, operation);
        const contentIdentity = artifactRef(content, valid.projectId, operation);
        if (contentIdentity.version !== valid.contentRef.version || contentIdentity.contentHash !== valid.contentRef.contentHash || contentIdentity.sizeBytes !== valid.contentRef.sizeBytes) throw new StorageError('validation', operation, '记忆正文引用与制品身份不一致', { details: { reason: 'content_ref_mismatch' } });
        for (const source of valid.sourceRefs) {
          const sourceIdentity = artifactRef(requireArtifact(db, valid.projectId, source.artifactId, operation), valid.projectId, operation);
          if (sourceIdentity.version !== source.version || (source.contentHash !== undefined && sourceIdentity.contentHash !== source.contentHash)) throw new StorageError('validation', operation, '记忆来源引用与制品身份不一致', { details: { reason: 'source_ref_mismatch' } });
        }
        db.prepare('INSERT INTO memory_records (id, created_at, project_id, revision, updated_at, record_key, version, scope, status, content_ref, content_hash, source_refs, retrieval_count) VALUES (?, ?, ?, 1, ?, ?, ?, ?, \'candidate\', ?, ?, ?, 0)')
          .run(id, now, valid.projectId, now, valid.recordKey, valid.version, valid.scope, valid.contentRef.artifactId, valid.contentRef.contentHash, JSON.stringify(valid.sourceRefs));
        return record(db, id, valid.projectId, operation);
      });
    },
    async getMemoryRecord(rawProjectId: string, recordKey: string, version?: number): Promise<MemoryRecord> {
      const operation = 'MemoryStore.getMemoryRecord'; assertOpen(operation); const project = projectId(rawProjectId, operation);
      if (typeof recordKey !== 'string' || recordKey.length === 0) throw new StorageError('validation', operation, 'recordKey 无效');
      const row = version === undefined
        ? session.database.prepare<[string, string], MemoryRow>('SELECT * FROM memory_records WHERE project_id = ? AND record_key = ? ORDER BY version DESC LIMIT 1').get(project, recordKey) as MemoryRow | undefined
        : session.database.prepare<[string, string, number], MemoryRow>('SELECT * FROM memory_records WHERE project_id = ? AND record_key = ? AND version = ?').get(project, recordKey, version) as MemoryRow | undefined;
      if (row === undefined) throw new StorageError('not_found', operation, '记忆记录不存在', { entity: { type: 'memory_record', projectId: project } });
      return mapRow(row, session.database, operation);
    },
    async updateMemoryStatus(rawProjectId: string, id: string, expectedRevision: number, status: MemoryRecordStatus): Promise<MemoryRecord> {
      const operation = 'MemoryStore.updateMemoryStatus'; assertOpen(operation); const project = projectId(rawProjectId, operation);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new StorageError('validation', operation, 'expectedRevision 无效');
      if (status !== 'accepted' && status !== 'revoked') throw new StorageError('validation', operation, '只能显式接受或撤销记忆');
      return session.transactWrite(operation, db => {
        const current = record(db, id, project, operation);
        if (current.status === 'revoked' && status !== 'revoked') throw new StorageError('conflict', operation, '已撤销记忆不能重新接受', { details: { reason: 'revoked_immutable' } });
        const changed = db.prepare('UPDATE memory_records SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ?')
          .run(status, nowUtcMs(), id, project, expectedRevision);
        if (changed.changes !== 1) throw new StorageError('conflict', operation, '记忆状态 revision 冲突', { entity: { type: 'memory_record', projectId: project }, details: { reason: 'revision_conflict', expectedRevision, actualRevision: current.revision } });
        const next = record(db, id, project, operation); audit(db, project, id, next.revision, status, next.updatedAtUtcMs); return next;
      });
    },
  };
}

export function createSqliteMemoryQueryStore(session: SqliteStorageSession): MemoryQueryReadStore {
  if (session === null || typeof session !== 'object') throw new TypeError('createSqliteMemoryQueryStore: session 必须是 SqliteStorageSession');
  return {
    listAcceptedMemories(projectId, filter) {
      const operation = 'MemoryQueryStore.listAcceptedMemories';
      if (!session.isOpen()) throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
      const project = validateStableId(projectId, { operation }, 'projectId');
      if (!Number.isInteger(filter.limit) || filter.limit < 1 || !Number.isInteger(filter.maxCandidates) || filter.maxCandidates < 1) throw new StorageError('validation', operation, '记忆检索范围无效');
      const clauses = ['m.project_id = ?', "m.status = 'accepted'"]; const params: Array<string | number> = [project];
      if (filter.recordKey !== undefined) { clauses.push('m.record_key = ?'); params.push(filter.recordKey); }
      if (filter.version !== undefined) { clauses.push('m.version = ?'); params.push(filter.version); }
      if (filter.scope !== undefined) { clauses.push('m.scope = ?'); params.push(filter.scope); }
      params.push(Math.min(filter.maxCandidates + 1, 501));
      const rows = session.database.prepare<unknown[], MemoryRow & { readonly content_locator: string }>(`SELECT m.*, a.storage_locator AS content_locator FROM memory_records m JOIN artifacts a ON a.id = m.content_ref AND a.project_id = m.project_id WHERE ${clauses.join(' AND ')} ORDER BY m.record_key ASC, m.version ASC, m.id ASC LIMIT ?`).all(...params) as Array<MemoryRow & { readonly content_locator: string }>;
      return rows.map(row => {
        const memory = mapRow(row, session.database, operation);
        return { memory, contentLocator: row.content_locator, sourceLocators: sourceArtifacts(session.database, memory) } satisfies MemoryQueryRow;
      });
    },
  };
}
