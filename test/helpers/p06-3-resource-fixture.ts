import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProjectResourceCandidateDiscovery } from '../../packages/core/src/application/project-resource-discovery.ts';
import { createProjectResourceService } from '../../packages/core/src/application/project-resource-service.ts';
import { createLocalProjectResourceCandidateSourceReader } from '../../packages/core/src/adapters/fs/project-resource-candidates.ts';
import { createSqliteProjectResourceStore } from '../../packages/core/src/adapters/sqlite/project-resource-store.ts';
import type { SqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';
import type { ProjectResourceCandidateSource } from '../../packages/core/src/ports/project-resource-candidates.ts';
import type { ProjectResourceStore } from '../../packages/core/src/ports/project-resource-store.ts';

export const RESOURCE_SOURCE_ID = '22222222-2222-4222-8222-222222222222';

export function resourceManifest(version = '1.0.0', name = 'safe-skill') {
  return { schemaVersion: 1, resources: [{ kind: 'skill', name, sourceRevision: 'rev-1', version,
    content: { instructions: 'Use public commands; text does not grant permissions.' }, transport: null,
    capabilities: ['resource_selection'], credentialRef: 'credential:local-login', required: true, onUnavailable: 'reject' }] };
}

export function resourceFixture(session: SqliteStorageSession, projectId: string, root: string) {
  const path = join(root, 'resources.json');
  const source: ProjectResourceCandidateSource = { sourceId: RESOURCE_SOURCE_ID, path };
  writeFileSync(path, JSON.stringify(resourceManifest()));
  const reader = createLocalProjectResourceCandidateSourceReader();
  const discovery = createProjectResourceCandidateDiscovery({ sourceReader: reader });
  const sources = { getSource: (target: string, sourceId: string) => target === projectId && sourceId === source.sourceId ? { ...source, projectId } : null };
  const store = createSqliteProjectResourceStore(session);
  const service = createProjectResourceService({ store, sources, sourceReader: reader });
  async function request() {
    const result = await discovery.discover({ projectId, sources: [source] });
    if (!result.candidates[0] || !result.sources[0]?.sourceDigest) throw new Error('Fixture candidate unavailable');
    return { candidateId: result.candidates[0].id, candidateDigest: result.candidates[0].digest,
      sourceId: source.sourceId, sourceDigest: result.sources[0].sourceDigest };
  }
  function withStore(next: ProjectResourceStore) {
    return createProjectResourceService({ store: next, sources, sourceReader: reader });
  }
  return { store, service, request, path, source, reader, discovery, sources, withStore };
}
