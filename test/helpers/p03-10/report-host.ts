import { createHostLifecycleServer, createHostStopController, createIdleActivityGate, connectToHost } from '../../../packages/host/src/index.ts';
import type { QueryService } from '../../../packages/core/src/application/query-service.ts';
import type { TrustedPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { mintHostCredential, publishLoopbackDiscovery } from '../host/discovery-fixture.ts';
import type { BudgetFixture } from '../p03-3/budget-fixture.ts';

/** Real Core SQLite and existing loopback transport; no scheduler or model. */
export async function openReportHost(f: BudgetFixture, options: {
  principal?: TrustedPrincipal;
  queries?: (query: QueryService) => QueryService;
} = {}) {
  const app = await f.box.openApplication();
  const query = options.queries?.(app.queryService) ?? app.queryService;
  const credential = mintHostCredential(f.box.dataRoot);
  const stop = createHostStopController({ activityGate: createIdleActivityGate(), getLifecycleState: () => 'ready',
    setLifecycleState: () => {}, prepareTeardown: async () => {}, releaseAfterTeardown: async () => {} });
  const server = createHostLifecycleServer({
    hostInstanceId: credential.hostInstanceId, dataRootIdentity: credential.dataRootIdentity,
    startedAt: new Date().toISOString(), pid: process.pid, authToken: credential.token,
    getLifecycleState: () => 'ready', getActivities: () => stop.getActivities(), stop,
    application: { principal: options.principal ?? f.owner, commandService: app.commandService,
      queryService: query, commandReceiptsService: app.commandReceiptsService,
      onboardingService: app.onboardingService, baselineQueryService: app.baselineQueryService,
      baselineExecutionService: app.baselineExecutionService, getLifecycleState: () => 'ready' },
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    publishLoopbackDiscovery({ canonicalRoot: f.box.dataRoot, port, ...credential });
    const client = await connectToHost({ canonicalRoot: f.box.dataRoot });
    return { app, client, port, token: credential.token,
      async close() {
        client.close();
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      },
    };
  } catch (error) {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    throw error;
  }
}
