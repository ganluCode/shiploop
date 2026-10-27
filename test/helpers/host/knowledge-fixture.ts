import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createLocalOwnerPrincipal, createStaticRuntimeCapabilityCatalog, createDocumentService, createArtifactPublisher, createArtifactVerifier, type TrustedPrincipal } from '../../../packages/core/src/index.ts';
import { createSqliteDocumentStore } from '../../../packages/core/src/adapters/sqlite/document-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { connectToHost, startHost, createHostLifecycleServer, createHostStopController, createIdleActivityGate, type RunningHost } from '../../../packages/host/src/index.ts';
import type { HostApplicationContext } from '../../../packages/host/src/runtime/app-transport.ts';
import { createHostClientApplication } from '../../../packages/host/src/client/app-client.ts';
import { createBaselineFixture } from '../p02-3/index.ts';

const owner = createLocalOwnerPrincipal();
const catalog = createStaticRuntimeCapabilityCatalog([]);

export async function withKnowledgeHost(run: (f: Awaited<ReturnType<typeof openKnowledgeHost>>) => Promise<void>) {
  const f = await openKnowledgeHost();
  try { await run(f); } finally { await f.close(); }
}

async function openKnowledgeHost() {
  const box = createBaselineFixture({ prefix: 'shiploop-knowledge-host-' });
  const root = box.dataRoot();
  let host: RunningHost | undefined;
  const servers: Server[] = [];
  let session: ReturnType<typeof openSqliteStorageSession> | undefined;
  const clients: { close(): void }[] = [];
  try {
    host = await startHost({ dataRoot: root, capabilityCatalog: catalog, env: {} });
    let client = await connectToHost({ canonicalRoot: root });
    clients.push(client);
    const core = host.core;
    const project = await core.stateStore.createProject({ displayName: 'Knowledge' });
    const other = await core.stateStore.createProject({ displayName: 'Other' });
    session = openSqliteStorageSession({ path: core.pathService.databaseFilePath() });
    const publisher = createArtifactPublisher({ artifacts: core.artifactStore, files: core.artifactFileStore, limits: { maxSizeBytes: 1_000_000, timeoutMs: 10_000 } });
    const publish = async (locator: string, body: string) => {
      const bytes = Buffer.from(body);
      return (await publisher.publishArtifact({ projectId: project.id, kind: 'document-source', locator, mediaType: 'text/plain', expectedHash: createHash('sha256').update(bytes).digest('hex'), content: [bytes] })).artifact;
    };
    const body = '# Guide\nneedle 知识 content';
    const source = await publish('docs/guide.md', body);
    const service = createDocumentService({ documents: createSqliteDocumentStore(session), artifacts: core.artifactStore, publisher,
      verifier: createArtifactVerifier({ artifacts: core.artifactStore, files: core.artifactFileStore, limits: { maxReadBytes: 1_000_000 } }),
      sources: { openSourceRead: async () => { throw new Error('unused'); } } });
    const published = await service.registerDocumentVersion(owner, project.id, { title: 'Guide', documentType: 'markdown', source: { kind: 'artifact', artifactId: source.id }, sourceRefs: [{ artifactId: source.id, version: source.version, contentHash: source.contentHash }] });
    const memoryContent = await publish('memory/build.txt', 'needle 记忆 build command');
    const candidate = await core.memoryService.createCandidate(owner, project.id, {
      recordKey: 'build.rule', version: 1, scope: 'build',
      contentRef: { artifactId: memoryContent.id, version: memoryContent.version, contentHash: memoryContent.contentHash, sizeBytes: memoryContent.sizeBytes },
      sourceRefs: [{ artifactId: source.id, version: source.version, contentHash: source.contentHash }],
    });
    await core.memoryService.accept(owner, project.id, candidate.id, candidate.revision);
    const snapshot = () => Object.fromEntries((session!.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map(({ name }) => [name, session!.database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
    const close = async () => {
      clients.forEach(c => c.close());
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      }
      session?.close();
      await host?.close();
      await box.dispose();
    };
    return {
      root, body, projectId: project.id, otherProjectId: other.id, published, source, memoryContent, snapshot,
      get host() { return host!; }, get client() { return client; },
      async restart() {
        client.close();
        await host!.close();
        host = await startHost({ dataRoot: root, capabilityCatalog: catalog, env: {} });
        client = await connectToHost({ canonicalRoot: root });
        clients.push(client);
      },
      async scoped(principal: TrustedPrincipal, overrides: Partial<HostApplicationContext> = {}) {
        const token = randomUUID();
        const stop = createHostStopController({ activityGate: createIdleActivityGate(), getLifecycleState: () => 'ready', setLifecycleState: () => {}, prepareTeardown: async () => {}, releaseAfterTeardown: async () => {} });
        const hostInstanceId = randomUUID();
        const dataRootIdentity = 'ab'.repeat(32);
        const server = createHostLifecycleServer({ hostInstanceId, dataRootIdentity, startedAt: new Date().toISOString(), pid: process.pid,
          authToken: token, getLifecycleState: () => 'ready', getActivities: () => stop.getActivities(), stop,
          application: { principal, commandService: core.commandService, queryService: core.queryService, commandReceiptsService: core.commandReceiptsService,
            onboardingService: core.onboardingService, baselineQueryService: core.baselineQueryService, baselineExecutionService: core.baselineExecutionService,
            planningQueryService: core.planningQueryService, knowledgeQueryService: core.knowledgeQueryService, memoryQueryService: core.memoryQueryService, getLifecycleState: () => 'ready', ...overrides } });
        servers.push(server);
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const address = server.address();
        if (address === null || typeof address !== 'object') throw new Error('missing loopback address');
        const appClient = createHostClientApplication({ port: address.port, token, connectMs: 1000, appRequestMs: 1000, submitBudgetMs: 2000, assertOpen: () => {}, registerSubscription: () => {}, unregisterSubscription: () => {} });
        return { client: appClient, port: address.port, token, hostInstanceId, dataRootIdentity };
      },
      close,
    };
  } catch (error) {
    clients.forEach(c => c.close());
    session?.close();
    await host?.close();
    await box.dispose();
    throw error;
  }
}
