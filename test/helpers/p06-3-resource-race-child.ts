import { readChildConfig, runBarrierChild } from './host/child-runtime.ts';
import { createSqliteProjectResourceStore } from '../../packages/core/src/adapters/sqlite/project-resource-store.ts';
import { openSqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';
import { createProjectResourceService } from '../../packages/core/src/application/project-resource-service.ts';
import { createLocalProjectResourceCandidateSourceReader } from '../../packages/core/src/adapters/fs/project-resource-candidates.ts';
import { createLocalOwnerPrincipal } from '../../packages/core/src/ports/authorization.ts';

const config = readChildConfig();
void runBarrierChild({ scenario: { name: 'project-resource-cas', onGo: async () => {
  const session = openSqliteStorageSession({ path: String(config.dbPath), busyTimeoutMs: 2_000 });
  try {
    const source = config.source as { projectId: string; sourceId: string; path: string };
    const service = createProjectResourceService({ store: createSqliteProjectResourceStore(session),
      sources: { getSource: (projectId, sourceId) => projectId === source.projectId && sourceId === source.sourceId ? source : null },
      sourceReader: createLocalProjectResourceCandidateSourceReader() });
    const result = await service.importCandidate(createLocalOwnerPrincipal(), String(config.projectId), Number(config.expectedRevision), config.request);
    process.send?.({ kind: 'race-result', ok: true, revision: result.revision, digest: result.digest });
  } catch (error) {
    const structured = error as { kind?: string; details?: { reason?: string } };
    process.send?.({ kind: 'race-result', ok: false, errorKind: structured.kind, reason: structured.details?.reason });
  } finally { session.close(); }
} }, goTimeoutMs: 15_000, watchdogMs: 30_000 });
