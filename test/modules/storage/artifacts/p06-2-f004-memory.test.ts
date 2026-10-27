import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteArtifactStore } from '../../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteMemoryStore } from '../../../../packages/core/src/adapters/sqlite/memory-store.ts';
import { createSqliteMemoryQueryStore } from '../../../../packages/core/src/adapters/sqlite/memory-query-store.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createArtifactPublisher } from '../../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../../packages/core/src/application/artifact-verify.ts';
import { createMemoryService } from '../../../../packages/core/src/application/memory-service.ts';
import { createMemoryQueryService } from '../../../../packages/core/src/application/memory-query-service.ts';
import { createLocalOwnerPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_701_000_000_000;
const owner = createLocalOwnerPrincipal();

async function withFixture(run: (fixture: {
  readonly root: string;
  readonly projectA: string;
  readonly projectB: string;
  readonly artifacts: ReturnType<typeof createSqliteArtifactStore>;
  readonly publisher: ReturnType<typeof createArtifactPublisher>;
  readonly verifier: ReturnType<typeof createArtifactVerifier>;
  readonly memoryStore: ReturnType<typeof createSqliteMemoryStore>;
  readonly memoryService: ReturnType<typeof createMemoryService>;
  readonly memoryQuery: ReturnType<typeof createMemoryQueryService>;
  readonly session: ReturnType<typeof openSqliteStorageSession>;
}) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p06-2-f004-');
  mkdirSync(join(sandbox.path, 'artifacts'), { recursive: true });
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  try {
    await migrateSqliteStorage(session);
    const state = createSqliteStateStore(session, { nowUtcMs: () => NOW });
    const projectA = await state.createProject({ displayName: 'memory-a' });
    const projectB = await state.createProject({ displayName: 'memory-b' });
    const artifacts = createSqliteArtifactStore(session, { nowUtcMs: () => NOW });
    const files = createArtifactFileStore({ dataRoot: sandbox.path });
    const publisher = createArtifactPublisher({
      artifacts,
      files,
      limits: { maxSizeBytes: 1_000_000, timeoutMs: 30_000 },
      nowMs: () => NOW,
    });
    const verifier = createArtifactVerifier({ artifacts, files, limits: { maxReadBytes: 1_000_000 }, nowMs: () => NOW });
    const memoryStore = createSqliteMemoryStore(session, { nowUtcMs: () => NOW });
    const memoryIndex = createSqliteMemoryQueryStore(session);
    const memoryService = createMemoryService({ memories: memoryStore, artifacts, verifier });
    const memoryQuery = createMemoryQueryService({ memories: memoryStore, memoryQuery: memoryIndex, verifier, artifacts });
    await run({ root: sandbox.path, projectA: projectA.id, projectB: projectB.id, artifacts, publisher, verifier, memoryStore, memoryService, memoryQuery, session });
  } finally {
    session.close();
    sandbox.cleanup();
  }
}

async function publishText(
  publisher: ReturnType<typeof createArtifactPublisher>,
  projectId: string,
  locator: string,
  text: string,
  kind = 'memory-source',
) {
  const body = Buffer.from(text);
  return (await publisher.publishArtifact({
    projectId,
    kind,
    mediaType: 'text/plain',
    expectedHash: createHash('sha256').update(body).digest('hex'),
    locator,
    content: [body],
  })).artifact;
}

describe('P06-2 F-004 controlled lightweight memory', () => {
  it('[case:memory-candidate-accept-search] creates a sourced candidate, requires explicit CAS acceptance, and searches accepted content only', async () => {
    await withFixture(async ({ projectA, projectB, publisher, memoryService, memoryQuery }) => {
      const source = await publishText(publisher, projectA, 'sources/decision.txt', 'source decision');
      const content = await publishText(publisher, projectA, 'memory/rule.txt', 'needle memory rule', 'memory-content');
      const candidate = await memoryService.createCandidate(owner, projectA, {
        recordKey: 'build.rule', version: 1, scope: 'build',
        contentRef: { artifactId: content.id, version: content.version, contentHash: content.contentHash, sizeBytes: content.sizeBytes },
        sourceRefs: [{ artifactId: source.id, version: source.version, contentHash: source.contentHash }],
      });
      expect(candidate.status).toBe('candidate');
      expect((await memoryQuery.search(owner, projectA, { keyword: 'needle' })).results).toHaveLength(0);
      const accepted = await memoryService.accept(owner, projectA, candidate.id, candidate.revision);
      expect(accepted.status).toBe('accepted');
      const result = await memoryQuery.search(owner, projectA, { keyword: 'needle' });
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ recordKey: 'build.rule', version: 1, scope: 'build', snippet: expect.stringContaining('needle'), sourceRefs: [{ projectId: projectA, artifactId: source.id }] });
      await expect(memoryQuery.search(owner, projectB, { keyword: 'needle' })).resolves.toMatchObject({ results: [], diagnostics: [{ code: 'no_results' }] });
    });
  });

  it('[case:memory-cas-source-and-budget-diagnostics] rejects direct accepted writes, stale CAS, invalid sources, and reports bounded failures', async () => {
    await withFixture(async ({ projectA, publisher, memoryService, memoryQuery, memoryStore }) => {
      const source = await publishText(publisher, projectA, 'sources/a.txt', 'source');
      const content = await publishText(publisher, projectA, 'memory/a.txt', 'needle body');
      await expect(memoryStore.createMemoryRecord({
        projectId: projectA, recordKey: 'direct', version: 1, scope: 'x', status: 'accepted',
        contentRef: { projectId: projectA, artifactId: content.id, version: content.version, contentHash: content.contentHash, sizeBytes: content.sizeBytes },
        sourceRefs: [{ projectId: projectA, artifactId: source.id, version: source.version, contentHash: source.contentHash }],
      })).rejects.toMatchObject({ kind: 'validation' });
      const candidate = await memoryService.createCandidate(owner, projectA, {
        recordKey: 'cas', version: 1, scope: 'x',
        contentRef: { artifactId: content.id, version: content.version, contentHash: content.contentHash, sizeBytes: content.sizeBytes },
        sourceRefs: [{ artifactId: source.id, version: source.version, contentHash: source.contentHash }],
      });
      await expect(memoryService.accept(owner, projectA, candidate.id, candidate.revision + 1)).rejects.toMatchObject({ kind: 'conflict' });
      await expect(memoryService.createCandidate(owner, projectA, {
        recordKey: 'bad-source', version: 1, scope: 'x',
        contentRef: { artifactId: content.id, version: content.version, contentHash: content.contentHash, sizeBytes: content.sizeBytes },
        sourceRefs: [],
      })).rejects.toMatchObject({ kind: 'validation' });
      const accepted = await memoryService.accept(owner, projectA, candidate.id, candidate.revision);
      const budget = await memoryQuery.search(owner, projectA, { keyword: 'needle', maxReadBytes: accepted.contentRef.sizeBytes - 1 });
      expect(budget.results).toHaveLength(0);
      expect(budget.diagnostics).toEqual([expect.objectContaining({ code: 'budget_exceeded', recordKey: 'cas' })]);
    });
  });

  it('[case:memory-reopen-integrity-and-revocation] preserves identity across reopen and excludes revoked or corrupted records', async () => {
    await withFixture(async ({ root, projectA, publisher, memoryService, memoryQuery, session }) => {
      const source = await publishText(publisher, projectA, 'sources/reopen.txt', 'source reopen');
      const content = await publishText(publisher, projectA, 'memory/reopen.txt', 'needle survives reopen');
      const candidate = await memoryService.createCandidate(owner, projectA, {
        recordKey: 'reopen', version: 1, scope: 'runtime',
        contentRef: { artifactId: content.id, version: content.version, contentHash: content.contentHash, sizeBytes: content.sizeBytes },
        sourceRefs: [{ artifactId: source.id, version: source.version, contentHash: source.contentHash }],
      });
      const accepted = await memoryService.accept(owner, projectA, candidate.id, candidate.revision);
      const before = await memoryQuery.search(owner, projectA, { keyword: 'needle' });
      expect(before.results[0]).toMatchObject({ id: accepted.id, contentHash: content.contentHash, sourceRefs: [{ artifactId: source.id, version: source.version, contentHash: source.contentHash }] });
      session.close();
      const reopened = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        const artifacts = createSqliteArtifactStore(reopened, { nowUtcMs: () => NOW });
        const files = createArtifactFileStore({ dataRoot: root });
        const verifier = createArtifactVerifier({ artifacts, files, limits: { maxReadBytes: 1_000_000 }, nowMs: () => NOW });
        const memories = createSqliteMemoryStore(reopened, { nowUtcMs: () => NOW });
        const reopenedQuery = createMemoryQueryService({ memories, memoryQuery: createSqliteMemoryQueryStore(reopened), verifier, artifacts });
        const after = await reopenedQuery.search(owner, projectA, { keyword: 'needle' });
        expect(after.results.map(({ id, recordKey, version, scope, contentHash, sourceRefs }) => ({ id, recordKey, version, scope, contentHash, sourceRefs })))
          .toEqual(before.results.map(({ id, recordKey, version, scope, contentHash, sourceRefs }) => ({ id, recordKey, version, scope, contentHash, sourceRefs })));
        await expect(memoryService.revoke(owner, projectA, accepted.id, accepted.revision)).rejects.toThrow();
        const row = await memories.getMemoryRecord(projectA, 'reopen', 1);
        expect(row.status).toBe('accepted');
        writeFileSync(join(root, 'projects', projectA, 'artifacts', content.id, 'content'), 'tampered');
        const corrupt = await reopenedQuery.search(owner, projectA, { keyword: 'needle' });
        expect(corrupt.results).toHaveLength(0);
        expect(corrupt.diagnostics).toEqual([expect.objectContaining({ code: 'corrupt_content' })]);
      } finally {
        reopened.close();
      }
    });
  });
});
