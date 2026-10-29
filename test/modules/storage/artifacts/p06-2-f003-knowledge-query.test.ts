import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createInputSourceFileReader } from '../../../../packages/core/src/adapters/fs/input-source-files.ts';
import { createSqliteArtifactStore } from '../../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteDocumentStore } from '../../../../packages/core/src/adapters/sqlite/document-store.ts';
import { createSqliteQueryStore } from '../../../../packages/core/src/adapters/sqlite/query-store.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createArtifactPublisher } from '../../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../../packages/core/src/application/artifact-verify.ts';
import { createKnowledgeQueryService } from '../../../../packages/core/src/application/knowledge-query-service.ts';
import { createDocumentService } from '../../../../packages/core/src/application/document-service.ts';
import { createLocalOwnerPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import { isPublicError } from '../../../../packages/core/src/ports/commands.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_701_000_000_000;
const owner = createLocalOwnerPrincipal();

async function withFixture(run: (fixture: {
  root: string;
  sourceRoot: string;
  projectA: string;
  projectB: string;
  documents: ReturnType<typeof createSqliteDocumentStore>;
  documentService: ReturnType<typeof createDocumentService>;
  query: ReturnType<typeof createKnowledgeQueryService>;
  session: ReturnType<typeof openSqliteStorageSession>;
}) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p06-2-f003-');
  const sourceRoot = join(sandbox.path, 'authorized-source');
  mkdirSync(sourceRoot, { recursive: true });
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  try {
    await migrateSqliteStorage(session);
    const state = createSqliteStateStore(session, { nowUtcMs: () => NOW });
    const projectA = await state.createProject({ displayName: 'docs-a' });
    const projectB = await state.createProject({ displayName: 'docs-b' });
    const artifacts = createSqliteArtifactStore(session, { nowUtcMs: () => NOW });
    const files = createArtifactFileStore({ dataRoot: sandbox.path });
    const publisher = createArtifactPublisher({ artifacts, files, limits: { maxSizeBytes: 1_000_000, timeoutMs: 30_000 }, nowMs: () => NOW });
    const verifier = createArtifactVerifier({ artifacts, files, limits: { maxReadBytes: 1_000_000 }, nowMs: () => NOW });
    const sources = createInputSourceFileReader({ roots: { repo: sourceRoot } });
    const documents = createSqliteDocumentStore(session, { nowUtcMs: () => NOW });
    const documentQuery = createSqliteQueryStore(session);
    const documentService = createDocumentService({ documents, artifacts, publisher, verifier, sources });
    const query = createKnowledgeQueryService({ documents, documentQuery, verifier });
    await run({ root: sandbox.path, sourceRoot, projectA: projectA.id, projectB: projectB.id, documents, documentService, query, session });
  } finally {
    session.close();
    sandbox.cleanup();
  }
}

describe('P06-2 F-003 bounded document knowledge queries', () => {
  it('[case:knowledge-search-stable-and-bounded] searches by keyword with stable identity, snippets, positions, and explicit budget', async () => {
    await withFixture(async ({ sourceRoot, projectA, documentService, query }) => {
      const bodyA = '# Alpha\nneedle appears in the first guide.\n';
      const bodyB = '# Beta\nneedle appears in the second guide.\n';
      mkdirSync(join(sourceRoot, 'nested'), { recursive: true });
      writeFileSync(join(sourceRoot, 'a.md'), bodyA);
      writeFileSync(join(sourceRoot, 'nested', 'b.md'), bodyB);
      await documentService.registerDocumentVersion(owner, projectA, {
        title: 'Alpha guide', documentType: 'markdown',
        source: { kind: 'file', root: 'repo', relativePath: 'a.md', mediaType: 'text/markdown' },
      });
      await documentService.registerDocumentVersion(owner, projectA, {
        title: 'Beta guide', documentType: 'markdown',
        source: { kind: 'file', root: 'repo', relativePath: 'nested/b.md', mediaType: 'text/markdown' },
      });
      const result = await query.search(owner, projectA, { keyword: 'needle', limit: 10, snippetMaxChars: 80, maxReadBytes: 1_000 });
      expect(result.budget).toMatchObject({ limit: 10, snippetMaxChars: 80, maxReadBytes: 1_000 });
      expect(result.results).toHaveLength(2);
      const resultIds = result.results.map(item => item.documentId);
      expect(resultIds).toEqual([...resultIds].sort());
      expect(result.results[0]).toMatchObject({
        version: 1,
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        sourceRefs: [],
        query: { keyword: 'needle' },
      });
      expect(result.results[0].snippet).toContain('needle');
      expect(result.results[0].position).toMatchObject({ start: expect.any(Number), line: 2 });
      const read = await query.read(owner, projectA, result.results[0].documentId, result.results[0].version);
      expect(read.contentText).toContain('needle');
      expect(read.contentHash).toBe(result.results[0].contentHash);
    });
  });

  it('[case:knowledge-read-integrity-and-reopen] verifies content on read and keeps identities stable after reopening SQLite', async () => {
    await withFixture(async ({ sourceRoot, root, projectA, documentService, query, session }) => {
      const body = '# Reopen\nneedle survives a database restart.\n';
      const sourcePath = join(sourceRoot, 'reopen.md');
      writeFileSync(sourcePath, body);
      const published = await documentService.registerDocumentVersion(owner, projectA, {
        title: 'Reopen guide', documentType: 'markdown',
        source: { kind: 'file', root: 'repo', relativePath: 'reopen.md' },
      });
      const before = await query.search(owner, projectA, { keyword: 'needle' });
      session.close();
      const reopened = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        const artifacts = createSqliteArtifactStore(reopened, { nowUtcMs: () => NOW });
        const files = createArtifactFileStore({ dataRoot: root });
        const verifier = createArtifactVerifier({ artifacts, files, limits: { maxReadBytes: 1_000_000 }, nowMs: () => NOW });
        const documents = createSqliteDocumentStore(reopened, { nowUtcMs: () => NOW });
        const reopenedQuery = createKnowledgeQueryService({ documents, documentQuery: createSqliteQueryStore(reopened), verifier });
        const after = await reopenedQuery.search(owner, projectA, { keyword: 'needle' });
        expect(after.results.map(item => ({ id: item.documentId, version: item.version, hash: item.contentHash, source: item.sourceRefs })))
          .toEqual(before.results.map(item => ({ id: item.documentId, version: item.version, hash: item.contentHash, source: item.sourceRefs })));
        expect(after.results[0].documentId).toBe(published.document.id);
      } finally {
        reopened.close();
      }
    });
  });

  it('[case:knowledge-read-corrupt-body] returns a structured integrity error without exposing the body or path', async () => {
    await withFixture(async ({ root, projectA, documentService, query }) => {
      const secret = 'secret text must not appear in diagnostics';
      writeFileSync(join(root, 'authorized-source', 'secret.md'), secret);
      const published = await documentService.registerDocumentVersion(owner, projectA, {
        title: 'Secret guide', documentType: 'markdown',
        source: { kind: 'file', root: 'repo', relativePath: 'secret.md' },
      });
      writeFileSync(join(root, 'projects', projectA, 'artifacts', published.version.contentRef.artifactId, 'content'), 'tampered');
      try {
        await query.read(owner, projectA, published.document.id, 1);
        throw new Error('expected structured integrity failure');
      } catch (error) {
        expect(isPublicError(error, 'corrupt_state')).toBe(true);
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain(root);
      }
    });
  });

  it('[case:knowledge-search-isolated-and-budget-diagnostic] rejects forged project access and reports an exhausted read budget', async () => {
    await withFixture(async ({ sourceRoot, projectA, projectB, documentService, query }) => {
      writeFileSync(join(sourceRoot, 'doc.md'), 'needle in a document that exceeds the query budget');
      const published = await documentService.registerDocumentVersion(owner, projectA, {
        title: 'Budget guide', documentType: 'markdown',
        source: { kind: 'file', root: 'repo', relativePath: 'doc.md' },
      });
      await expect(query.search(owner, projectA, { documentId: published.document.id, version: 1, maxReadBytes: 1 })).resolves.toMatchObject({
        results: [],
        diagnostics: [{ code: 'budget_exceeded' }],
      });
      const result = await query.search(owner, projectB, { documentId: published.document.id, version: 1 });
      expect(result.results).toEqual([]);
      expect(result.diagnostics[0]).toMatchObject({ code: 'no_results' });
    });
  });
});
