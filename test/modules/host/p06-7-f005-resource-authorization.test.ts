import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { expect, it } from 'vitest';
import { createHostLifecycleServer, createHostStopController, createIdleActivityGate, createHostWorkToolAccess,
  createWorkToolClient, type HostApplicationContext } from '../../../packages/host/src/index.ts';
import { openWorkToolFixture } from '../../helpers/host/work-tool-fixture.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { saveResourceEvidence } from '../../helpers/p06-7/resource-scenario.ts';

it('[case:p06-f005-interface-authorization] real restricted HTTP channel rechecks expiry/revocation/restart and cannot reach owner approval or state mutation', async () => {
  const f = await openWorkToolFixture({ composed: true, restrictedPrincipal: true, operations: ['task.read'] });
  const ownerToken = randomBytes(32).toString('hex');
  const servers: Server[] = [];
  const accesses: ReturnType<typeof createHostWorkToolAccess>[] = [];
  let ownerCalls = 0;
  async function serve() {
    const workTools = createHostWorkToolAccess(f.channel);
    accesses.push(workTools);
    const stop = createHostStopController({ activityGate: createIdleActivityGate(), getLifecycleState: () => 'ready',
      setLifecycleState: () => {}, prepareTeardown: async () => {}, releaseAfterTeardown: async () => {} });
    const server = createHostLifecycleServer({ hostInstanceId: 'host-1', dataRootIdentity: 'ab'.repeat(32),
      startedAt: new Date().toISOString(), pid: process.pid, authToken: ownerToken,
      getLifecycleState: () => 'ready', getActivities: () => stop.getActivities(), stop,
      application: { workTools, principal: f.binding.principal, commandService: { submit: () => { ownerCalls++; throw new Error('unexpected owner dispatch'); } },
        getLifecycleState: () => 'ready' } as unknown as HostApplicationContext });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('invalid listener');
    const grant = workTools.issue({ ...f.access, context: { ...f.access.context, grantId: randomUUID() } }, f.binding);
    return { port: address.port, token: grant.token, grant, workTools };
  }
  try {
    const host = await serve();
    const client = createWorkToolClient(host);
    const before = f.snapshot();
    const allowed = await client.invoke(f.request());
    expect(allowed).toMatchObject({ operation: 'task.read', task: { id: f.binding.identity.taskId } });
    const denied: { name: string; code: string }[] = [];
    const reject = async (name: string, pending: Promise<unknown>, code: string) => {
      const error = await pending.then(() => null, failure => failure);
      expect(error).toMatchObject({ code });
      expect(JSON.stringify(error)).not.toContain(host.token);
      expect(JSON.stringify(error)).not.toContain(ownerToken);
      expect(f.snapshot()).toEqual(before);
      denied.push({ name, code });
    };
    await reject('owner-token', createWorkToolClient({ ...host, token: ownerToken }).invoke(f.request()), 'unauthorized');
    for (const operation of ['approval.decide', 'task.pass', 'sql.query']) await reject(operation, client.invoke(f.request(operation)), 'unsupported');
    await reject('forged-principal', client.invoke({ ...f.request(), principal: { principalId: 'local-owner' } }), 'invalid_input');
    await reject('cross-project', client.invoke({ ...f.request(), scope: { kind: 'project', projectId: randomUUID() } }), 'forbidden');
    f.setCurrent({ ...f.binding, nowUtcMs: NOW + 1000 });
    await reject('expired', client.invoke(f.request()), 'forbidden');
    f.setCurrent(f.binding);
    host.grant.revoke();
    await reject('revoked', client.invoke(f.request()), 'unauthorized');
    host.workTools.close();
    const rebuilt = await serve();
    await reject('old-token-after-rebuild', createWorkToolClient({ port: rebuilt.port, token: host.token }).invoke(f.request()), 'unauthorized');
    expect(await createWorkToolClient(rebuilt).invoke(f.request())).toEqual(allowed);
    expect(f.snapshot()).toEqual(before);
    expect(ownerCalls).toBe(0);
    saveResourceEvidence('interface-authorization', { scope: 'real HTTP and composed Core with temporary SQLite/Git',
      allowed: { operation: 'task.read', taskId: f.binding.identity.taskId }, denied, stateUnchanged: true,
      ownerDispatches: ownerCalls, credentialsRecorded: false, strongOsSandbox: false });
  } finally {
    for (const access of accesses) access.close();
    for (const server of servers) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    f.close();
  }
}, 20_000);
