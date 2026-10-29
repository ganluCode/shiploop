import { randomBytes, randomUUID } from 'node:crypto';
import { renameSync, realpathSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostLifecycleServer, createHostStopController, createIdleActivityGate } from '../../../packages/host/src/index.ts';
import { createHostClientApplication } from '../../../packages/host/src/client/app-client.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

const TOKEN = randomBytes(32).toString('hex');
const INSTANCE = randomUUID();
const ROOT_IDENTITY = 'ab'.repeat(32);
const FIXTURE_NOW = new Date(1_900_000_000_000).toISOString();

let fixture: CommandsTestFixture | undefined;
let app: Awaited<ReturnType<CommandsTestFixture['openApplication']>> | undefined;
let server: Server | undefined;

async function setup() {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f009-move-host-' });
  app = await fixture.openApplication();
  const inspected = await app.repositoryInspector.inspect(fixture.repoDirA);
  const project = await app.stateStore.createProjectWithRepositoryBinding(
    { displayName: '移动 Host 项目' },
    { canonicalPath: inspected.canonicalPath, gitCommonDir: inspected.gitCommonDir, repoIdentity: inspected.repoIdentity },
  );
  let lifecycle: 'ready' = 'ready';
  const stop = createHostStopController({
    activityGate: createIdleActivityGate(),
    getLifecycleState: () => lifecycle,
    setLifecycleState: () => {},
    prepareTeardown: () => Promise.resolve(),
    releaseAfterTeardown: () => Promise.resolve(),
  });
  server = createHostLifecycleServer({
    hostInstanceId: INSTANCE,
    dataRootIdentity: ROOT_IDENTITY,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    authToken: TOKEN,
    getLifecycleState: () => lifecycle,
    getActivities: () => stop.getActivities(),
    stop,
    application: {
      principal: fixture.localOwner(),
      commandService: app.commandService,
      queryService: app.queryService,
      commandReceiptsService: app.commandReceiptsService,
      onboardingService: app.onboardingService,
      baselineQueryService: app.baselineQueryService,
      baselineExecutionService: app.baselineExecutionService,
      planningQueryService: app.planningQueryService,
      repositoryMoveService: app.repositoryMoveService,
      getLifecycleState: () => lifecycle,
    },
  });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('missing loopback address');
  const client = createHostClientApplication({
    port: address.port, token: TOKEN, connectMs: 1000, appRequestMs: 1000, submitBudgetMs: 3000,
    assertOpen: () => {}, registerSubscription: () => {}, unregisterSubscription: () => {},
  });
  return { projectId: project.project.id, oldPath: inspected.canonicalPath, client, port: address.port };
}

afterEach(async () => {
  server?.closeAllConnections();
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  app?.close();
  app = undefined;
  fixture?.cleanup();
  fixture = undefined;
});

describe('P06-5 F-009 仓库移动 Host/HostClient 接线', () => {
  it('loopback preview is read-only and confirmation returns the original project with a new binding', async () => {
    const f = await setup();
    const moved = join(fixture!.repoDirA, '..', 'repo-a-moved');
    renameSync(f.oldPath, moved);
    const preview = await f.client.previewRepositoryMove({ projectId: f.projectId, repositoryPath: moved });
    expect(preview.projectId).toBe(f.projectId);
    expect(preview.oldBinding.canonicalPath).toBe(f.oldPath);
    expect(preview.newRepository.canonicalPath).toBe(realpathSync(moved));
    expect((await app!.stateStore.getRepositoryBinding(f.projectId)).canonicalPath).toBe(f.oldPath);

    const receipt = await f.client.confirmRepositoryMove({ projectId: f.projectId, preview, decision: 'confirm', issuedAt: FIXTURE_NOW });
    expect(receipt.status).toBe('completed');
    if (receipt.status !== 'completed') throw new Error('expected completed receipt');
    const result = receipt.result as { project: { id: string }; binding: { canonicalPath: string } };
    expect(result.project.id).toBe(f.projectId);
    expect(result.binding.canonicalPath).toBe(realpathSync(moved));
    expect((await app!.stateStore.getRepositoryBinding(f.projectId)).canonicalPath).toBe(realpathSync(moved));
  });

  it('rejects cancellation before any binding write', async () => {
    const f = await setup();
    const moved = join(fixture!.repoDirA, '..', 'repo-a-moved');
    renameSync(f.oldPath, moved);
    const preview = await f.client.previewRepositoryMove({ projectId: f.projectId, repositoryPath: moved });
    const response = await loopbackRequest({
      port: f.port, method: 'POST', token: TOKEN,
      path: `/v1/projects/${f.projectId}/repository-move/confirm`,
      body: { projectId: f.projectId, preview, decision: 'cancel', commandId: randomUUID(), issuedAt: FIXTURE_NOW },
    });
    expect(response.statusCode).toBe(400);
    expect((await app!.stateStore.getRepositoryBinding(f.projectId)).canonicalPath).toBe(f.oldPath);
  });
});
