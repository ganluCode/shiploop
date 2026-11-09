import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openF007Fixture } from '../../helpers/planning/p05-1-f007-fixture.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';

it('keeps editable PRDs outside Git and automatically reuses or publishes immutable document versions', async () => {
  const f = await openF007Fixture({ prefix: 'managed-documents-' });
  try {
    const owner = createLocalOwnerPrincipal();
    const docs = f.core.managedDocuments;
    const location = await docs.locations(owner, f.projectId);
    expect(location.workingDirectory).not.toContain(f.box.repoDirA);
    await docs.writeDraft(owner, f.projectId, { path: 'prd/example.md', content: '# PRD\nversion one' });
    createSqliteAtomicCommandStore(f.session).transact('test.bind-documents', tx =>
      tx.bindFeatureDocuments!(f.projectId, f.featureId, [{ path: 'prd/example.md', role: 'prd' }]));
    const first = await docs.capture(owner, f.projectId, f.featureId);
    const second = await docs.capture(owner, f.projectId, f.featureId);
    expect(second.documents[0]).toEqual(first.documents[0]);
    expect(first.documents[0].version).toBe(1);
    expect(readFileSync(join(location.workingDirectory, 'prd/example.md'), 'utf8')).toContain('version one');
    await docs.writeDraft(owner, f.projectId, { path: 'prd/example.md', content: '# PRD\nversion two', expectedHash: first.documents[0].sha256 });
    const third = await docs.capture(owner, f.projectId, f.featureId);
    expect(third.documents[0].version).toBe(2);
    expect(third.documents[0].documentId).toBe(first.documents[0].documentId);
    expect(first.documents[0].content).toContain('version one');
    const verified = await createArtifactVerifier({ artifacts: f.core.artifactStore, files: f.core.artifactFileStore,
      limits: { maxReadBytes: 2097152 } }).readVerifiedContent(f.projectId, first.context.artifactId);
    expect(JSON.parse(new TextDecoder().decode(verified.content)).documents[0].content).toContain('version one');
    await expect(docs.writeDraft(owner, f.projectId, { path: '../escape.md', content: 'bad' })).rejects.toThrow();
    await expect(docs.writeDraft(owner, f.projectId, { path: 'prd/example.md', content: 'overwrite' })).rejects.toThrow();
    const racing = await Promise.allSettled([
      docs.writeDraft(owner, f.projectId, { path: 'prd/example.md', content: '# writer A', expectedHash: third.documents[0].sha256 }),
      docs.writeDraft(owner, f.projectId, { path: 'prd/example.md', content: '# writer B', expectedHash: third.documents[0].sha256 }),
    ]);
    expect(racing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(racing.filter(result => result.status === 'rejected')).toHaveLength(1);
  } finally { await f.close(); }
}, 60000);
