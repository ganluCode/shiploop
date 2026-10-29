import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createInputSourceFileReader } from '../../../../packages/core/src/adapters/fs/input-source-files.ts';
import { createSqliteArtifactStore } from '../../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteDocumentStore } from '../../../../packages/core/src/adapters/sqlite/document-store.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createArtifactPublisher } from '../../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier, isArtifactVerifyError } from '../../../../packages/core/src/application/artifact-verify.ts';
import { createDocumentService } from '../../../../packages/core/src/application/document-service.ts';
import { createLocalOwnerPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_701_000_000_000;
const owner = createLocalOwnerPrincipal();

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function withFixture(run: (fixture: {
  root: string;
  sourceRoot: string;
  projectA: string;
  projectB: string;
  service: ReturnType<typeof createDocumentService>;
  artifacts: ReturnType<typeof createSqliteArtifactStore>;
  session: ReturnType<typeof openSqliteStorageSession>;
}) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p06-2-f002-');
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
    const service = createDocumentService({ documents, artifacts, publisher, verifier, sources });
    await run({ root: sandbox.path, sourceRoot, projectA: projectA.id, projectB: projectB.id, service, artifacts, session });
  } finally {
    session.close();
    sandbox.cleanup();
  }
}

describe('P06-2 F-002 document publication and controlled reads', () => {
  it('[case:document-publish-replay-and-version] publishes an authorized file, replays the same version, and appends an immutable version', async () => {
    await withFixture(async ({ sourceRoot, projectA, service, artifacts }) => {
      const firstBody = '# First\napproved source';
      mkdirSync(join(sourceRoot, 'docs'), { recursive: true });
      writeFileSync(join(sourceRoot, 'docs', 'first.md'), firstBody);
      const first = await service.registerDocumentVersion(owner, projectA, {
        title: 'Guide', documentType: 'markdown',
        source: { kind: 'file', root: 'repo', relativePath: 'docs/first.md', mediaType: 'text/markdown' },
      });
      expect(first.version.status).toBe('published');
      expect(first.version.contentHash).toBe(hash(firstBody));
      expect(first.version.contentRef.sizeBytes).toBe(Buffer.byteLength(firstBody));

      const replay = await service.registerDocumentVersion(owner, projectA, {
        title: 'ignored on replay', documentType: 'markdown', documentId: first.document.id, version: 1,
        source: { kind: 'file', root: 'repo', relativePath: 'docs/first.md' },
      });
      expect(replay.version.id).toBe(first.version.id);
      expect(replay.version.contentRef.artifactId).toBe(first.version.contentRef.artifactId);

      const secondBody = '# Second\nnew immutable version';
      writeFileSync(join(sourceRoot, 'docs', 'second.md'), secondBody);
      const second = await service.registerDocumentVersion(owner, projectA, {
        title: 'Guide', documentType: 'markdown', documentId: first.document.id, version: 2,
        source: { kind: 'file', root: 'repo', relativePath: 'docs/second.md' },
      });
      expect(second.version.id).not.toBe(first.version.id);
      expect(second.version.contentHash).toBe(hash(secondBody));
      const old = await service.readDocument(owner, projectA, first.document.id, 1);
      expect(old.contentText).toBe(firstBody);
      const current = await service.readDocument(owner, projectA, first.document.id);
      expect(current.version.version).toBe(2);
      expect(current.contentText).toBe(secondBody);

      const sourceDocument = await service.registerDocumentVersion(owner, projectA, {
        title: 'Copied', documentType: 'markdown',
        source: { kind: 'artifact', artifactId: second.version.contentRef.artifactId },
      });
      expect(sourceDocument.version.contentRef.artifactId).not.toBe(second.version.contentRef.artifactId);
      expect(sourceDocument.version.sourceRefs[0]).toMatchObject({
        projectId: projectA, artifactId: second.version.contentRef.artifactId,
      });
      const sourceArtifact = await artifacts.getArtifact(projectA, second.version.contentRef.artifactId);
      expect(sourceArtifact.status).toBe('ready');
    });
  });

  it('[case:document-source-path-and-cross-project] rejects absolute/path traversal sources and cross-project reads', async () => {
    await withFixture(async ({ sourceRoot, projectA, projectB, service }) => {
      writeFileSync(join(sourceRoot, 'safe.md'), 'safe');
      await expect(service.registerDocumentVersion(owner, projectA, {
        title: 'Bad', documentType: 'markdown', source: { kind: 'file', root: 'repo', relativePath: '../outside.md' },
      })).rejects.toThrow();
      const published = await service.registerDocumentVersion(owner, projectA, {
        title: 'Safe', documentType: 'markdown', source: { kind: 'file', root: 'repo', relativePath: 'safe.md' },
      });
      await expect(service.readDocument(owner, projectB, published.document.id)).rejects.toThrow();
      await expect(service.readDocument(owner, projectA, '00000000-0000-4000-8000-000000000000')).rejects.toThrow();
    });
  });

  it('[case:document-integrity-diagnosis] reports missing or tampered controlled Artifact content without exposing paths or body', async () => {
    await withFixture(async ({ sourceRoot, root, projectA, service }) => {
      const secret = 'private body that must not be in errors';
      writeFileSync(join(sourceRoot, 'secret.md'), secret);
      const published = await service.registerDocumentVersion(owner, projectA, {
        title: 'Secret', documentType: 'markdown', source: { kind: 'file', root: 'repo', relativePath: 'secret.md' },
      });
      const contentPath = join(root, 'projects', projectA, 'artifacts', published.version.contentRef.artifactId, 'content');
      writeFileSync(contentPath, 'tampered');
      try {
        await service.readDocument(owner, projectA, published.document.id, 1);
        throw new Error('expected integrity failure');
      } catch (error) {
        expect(isArtifactVerifyError(error, 'corrupt')).toBe(true);
        expect(String(error)).not.toContain(root);
        expect(String(error)).not.toContain(secret);
      }
    });
  });
});
