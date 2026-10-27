import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import {
  validateDocumentInput,
  validateDocumentVersionInput,
  validateMemoryRecordInput,
} from '../../../../packages/core/src/ports/knowledge.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_700_500_000_000;
const HASH = 'ab'.repeat(32);

async function migrated(root: string) {
  const session = openSqliteStorageSession({ path: join(root, 'state.db') });
  await migrateSqliteStorage(session);
  session.database.exec(`
    INSERT INTO projects (id, created_at, updated_at, display_name) VALUES
      ('project-a', ${NOW}, ${NOW}, 'A'),
      ('project-b', ${NOW}, ${NOW}, 'B');
  `);
  return session;
}

async function withSandbox(fn: (root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p06-2-f001-');
  try {
    await fn(sandbox.path);
  } finally {
    sandbox.cleanup();
  }
}

describe('P06-2 F-001 knowledge contracts and schema', () => {
  it('[case:knowledge-migration-v49] appends the knowledge migration and preserves prior checksums', async () => {
    await withSandbox(async (root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        const before = SQLITE_MIGRATIONS.slice(0, -1);
        await migrateSqliteStorage(session, { migrations: before });
        const oldRows = session.database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
        await migrateSqliteStorage(session);
        expect(SQLITE_MIGRATIONS.at(-1)?.version).toBe(49);
        expect(session.database.prepare('SELECT version, checksum FROM schema_migrations WHERE version < 49 ORDER BY version').all()).toEqual(oldRows);
        expect(session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('documents', 'document_versions', 'memory_records') ORDER BY name").all()).toEqual([
          { name: 'document_versions' }, { name: 'documents' }, { name: 'memory_records' },
        ]);
      } finally {
        session.close();
      }
    });
  });

  it('[case:knowledge-same-project-fk] enforces same-project document/version/artifact references and immutable versions', async () => {
    await withSandbox(async (root) => {
      const session = await migrated(root);
      try {
        session.database.prepare("INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, media_type, expected_hash, version, storage_locator) VALUES ('artifact-a', ?, 'project-a', ?, 'document', 'text/plain', ?, 1, 'documents/artifact-a')").run(NOW, NOW, HASH);
        session.database.prepare("INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, media_type, expected_hash, version, storage_locator) VALUES ('artifact-b', ?, 'project-b', ?, 'document', 'text/plain', ?, 1, 'documents/artifact-b')").run(NOW, NOW, HASH);
        session.database.prepare("INSERT INTO documents (id, created_at, project_id, updated_at, title, document_type) VALUES ('doc-a', ?, 'project-a', ?, 'Doc', 'wiki')").run(NOW, NOW);
        session.database.prepare("INSERT INTO document_versions (id, created_at, project_id, updated_at, document_id, version, status, content_ref, content_hash, source_refs, review_status) VALUES ('doc-a-v1', ?, 'project-a', ?, 'doc-a', 1, 'published', 'artifact-a', ?, '[]', 'approved')").run(NOW, NOW, HASH);
        expect(() => session.database.prepare("INSERT INTO document_versions (id, created_at, project_id, updated_at, document_id, version, status, content_ref, content_hash, source_refs, review_status) VALUES ('bad', ?, 'project-b', ?, 'doc-a', 1, 'draft', 'artifact-b', ?, '[]', 'pending')").run(NOW, NOW, HASH)).toThrow();
        expect(() => session.database.prepare("UPDATE document_versions SET content_hash = ? WHERE id = 'doc-a-v1'").run('cd'.repeat(32))).toThrow(/immutable/);
        expect(() => session.database.prepare("DELETE FROM document_versions WHERE id = 'doc-a-v1'").run()).toThrow(/retained|immutable/);
        session.database.prepare("UPDATE documents SET effective_version_id = 'doc-a-v1' WHERE id = 'doc-a'").run();
        expect(() => session.database.prepare("UPDATE documents SET effective_version_id = 'missing' WHERE id = 'doc-a'").run()).toThrow();
      } finally {
        session.close();
      }
    });
  });

  it('[case:knowledge-memory-constraints] enforces memory status, JSON, digest, version and non-negative count checks', async () => {
    await withSandbox(async (root) => {
      const session = await migrated(root);
      try {
        session.database.prepare("INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, media_type, expected_hash, version, storage_locator) VALUES ('artifact-a', ?, 'project-a', ?, 'memory', 'text/plain', ?, 1, 'memory/artifact-a')").run(NOW, NOW, HASH);
        session.database.prepare("INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, media_type, expected_hash, version, storage_locator) VALUES ('artifact-b', ?, 'project-b', ?, 'memory', 'text/plain', ?, 1, 'memory/artifact-b')").run(NOW, NOW, HASH);
        const insert = session.database.prepare("INSERT INTO memory_records (id, created_at, project_id, updated_at, record_key, version, scope, status, content_ref, content_hash, source_refs, retrieval_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        insert.run('memory-a', NOW, 'project-a', NOW, 'rule', 1, 'project', 'candidate', 'artifact-a', HASH, '[]', 0);
        expect(() => insert.run('memory-bad-count', NOW, 'project-a', NOW, 'bad', 1, 'project', 'candidate', 'artifact-a', HASH, '[]', -1)).toThrow();
        expect(() => insert.run('memory-bad-status', NOW, 'project-a', NOW, 'bad-status', 1, 'project', 'unknown', 'artifact-a', HASH, '[]', 0)).toThrow();
        expect(() => insert.run('memory-bad-json', NOW, 'project-a', NOW, 'bad-json', 1, 'project', 'candidate', 'artifact-a', HASH, '{', 0)).toThrow();
        expect(() => insert.run('memory-cross-project', NOW, 'project-a', NOW, 'cross', 1, 'project', 'accepted', 'artifact-b', HASH, '[]', 0)).toThrow();
      } finally {
        session.close();
      }
    });
  });

  it('[case:knowledge-port-ownership] rejects cross-project and malformed knowledge references before persistence', () => {
    expect(validateDocumentInput({ projectId: 'project-a', title: 'Doc', documentType: 'wiki' })).toMatchObject({ projectId: 'project-a' });
    expect(() => validateDocumentInput({ projectId: 'project-a', title: '', documentType: 'wiki' })).toThrow();
    expect(validateDocumentVersionInput({
      projectId: 'project-a', documentId: 'doc-a', version: 1, status: 'draft',
      contentRef: { projectId: 'project-a', artifactId: 'artifact-a', version: 1, contentHash: HASH, sizeBytes: 1 },
      sourceRefs: [{ projectId: 'project-a', artifactId: 'source-a', version: 1 }], contentHash: HASH,
      reviewStatus: 'pending',
    })).toMatchObject({ projectId: 'project-a', version: 1 });
    expect(() => validateDocumentVersionInput({
      projectId: 'project-a', documentId: 'doc-a', version: 1, status: 'draft',
      contentRef: { projectId: 'project-b', artifactId: 'artifact-b', version: 1, contentHash: HASH, sizeBytes: 1 },
      sourceRefs: [], contentHash: HASH, reviewStatus: 'pending',
    })).toThrow();
    expect(() => validateMemoryRecordInput({
      projectId: 'project-a', recordKey: 'rule', version: 1, scope: 'project', status: 'candidate',
      contentRef: { projectId: 'project-b', artifactId: 'artifact-b', version: 1, contentHash: HASH, sizeBytes: 1 },
      sourceRefs: [],
    })).toThrow();
  });
});
