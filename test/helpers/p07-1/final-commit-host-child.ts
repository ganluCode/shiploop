// Trusted test consumer: real Host, Git driver and SQLite receipt, zero models.
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { startHost } from '../../../packages/host/src/index.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createGitCommitDriver } from '../../../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createFinalizationGitDelivery } from '../../../packages/core/src/application/finalization-git-delivery.ts';
import type { FinalizationCommitRequest } from '../../../packages/core/src/ports/finalization-completion.ts';
import { runBarrierChild } from '../host/child-runtime.ts';

await runBarrierChild({ watchdogMs: 150_000, scenario: { name: 'p07-final-commit', async onGo({ config, reportListening, closeRequested }) {
  const host = await startHost({ dataRoot: config.dataRoot as string, env: {},
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }] }]) });
  const session = openSqliteStorageSession({ path: config.dbPath as string });
  try {
    reportListening(host.port);
    const now = () => config.nowMs as number;
    const artifacts = createSqliteArtifactStore(session, { nowUtcMs: now });
    const files = createArtifactFileStore({ dataRoot: config.dataRoot as string });
    const realDriver = createGitCommitDriver({ confirmProcessIdentity: async identity => identity });
    const port = createFinalizationGitDelivery({
      operations: createSqliteGitOperationStore(session, { nowUtcMs: now }),
      publisher: createArtifactPublisher({ artifacts, files, nowMs: now, limits: { maxSizeBytes: 4 * 1024 * 1024, timeoutMs: 30_000 } }),
      artifacts: createArtifactVerifier({ artifacts, files, limits: { maxReadBytes: 4 * 1024 * 1024 } }),
      inspector: createWorkspaceInspector({ authorizedRoots: [config.fixtureRoot as string], confirmProcessIdentity: async identity => identity }),
      lock: createGitPublicMetadataLock(),
      driver: { open(baseline, assertCurrent) {
        const driver = realDriver.open(baseline, assertCurrent);
        return { ...driver, async commit(message, identity) {
          const result = await driver.commit(message, identity);
          // Exact failure boundary: commit process exited, no receipt transaction.
          process.send?.({ kind: 'feature_commit_landed', facts: await driver.facts() });
          await closeRequested;
          throw new Error('host_closed_before_receipt');
        } };
      } },
      transact: callback => session.transactWrite('p07.finalReceipt', callback),
      readFeatureRevision: (projectId, featureId) => (session.database.prepare('SELECT revision FROM features WHERE project_id = ? AND id = ?')
        .get(projectId, featureId) as { revision: number }).revision,
      nowMs: now,
    });
    const request = config.request as unknown as FinalizationCommitRequest;
    const result = config.reconcile === true ? await port.reconcile(request, request.operationId) : await port.commit(request);
    process.send?.({ kind: 'feature_result', result });
    await closeRequested;
  } finally { session.close(); await host.close(); }
} } });
