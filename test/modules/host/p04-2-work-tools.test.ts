import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createHostLifecycleServer, createHostStopController, createIdleActivityGate,
  createHostWorkToolAccess, createWorkToolClient, startHost,
} from '../../../packages/host/src/index.ts';
import type { HostApplicationContext, LifecycleState } from '../../../packages/host/src/index.ts';
import { openWorkToolFixture } from '../../helpers/host/work-tool-fixture.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { createCommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

type Fixture = Awaited<ReturnType<typeof openWorkToolFixture>>;
async function serve(f: Fixture) {
  const workTools = createHostWorkToolAccess(f.channel);
  const grant = workTools.issue({ ...f.access, context: { ...f.access.context, grantId: randomUUID() } }, f.binding);
  const ownerToken = randomBytes(32).toString('hex');
  let lifecycle: LifecycleState = 'ready';
  const stop = createHostStopController({ activityGate: createIdleActivityGate(),
    getLifecycleState: () => lifecycle, setLifecycleState(next) { lifecycle = next; workTools.close(); },
    prepareTeardown: async () => {}, releaseAfterTeardown: async () => {} });
  // Any dispatch to owner services is a test failure. Restricted calls use the real composed Core channel.
  const ownerSubmit = vi.fn(() => { throw new Error('unexpected owner dispatch'); });
  const server = createHostLifecycleServer({ hostInstanceId: 'host-1', dataRootIdentity: 'ab'.repeat(32),
    startedAt: new Date().toISOString(), pid: process.pid, authToken: ownerToken,
    getLifecycleState: () => lifecycle, getActivities: () => stop.getActivities(), stop,
    application: { workTools, principal: f.binding.principal, commandService: { submit: ownerSubmit },
      getLifecycleState: () => lifecycle } as unknown as HostApplicationContext,
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('invalid test listener');
  const port = address.port, token = grant.token;
  const post = (body: unknown, path = '/v1/work/tools', credential: string | null = token, headers = {}) => loopbackRequest({
    port, method: 'POST', path, body, ...(credential === null ? {} : { token: credential }), headers,
  });
  return { token, ownerToken, port, post, grant, ownerSubmit, workTools,
    quiesce() { lifecycle = 'quiescing'; workTools.close(); },
    close: async () => { workTools.close(); await close(server); } };
}
async function close(server: Server) {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}
const fixture = () => openWorkToolFixture({ composed: true, restrictedPrincipal: true });

function assertSafe(text: string, f: Fixture, ...secrets: string[]) {
  for (const secret of [f.f.box.box.root, f.f.box.box.dataRoot, 'SYNTHETIC-SECRET', ...secrets]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/repositoryPath|locator|SELECT \*|stack|capabilities/);
}

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 }); });

describe('Host Work 受限入口', () => {
  it('[case:work-query] 可信绑定的当前 Task 可通过窄 Host 入口查询', async () => {
    const f = await fixture(); const host = await serve(f);
    try {
      const before = f.snapshot();
      const response = await host.post(f.request());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ operation: 'task.read', task: { id: f.binding.identity.taskId } });
      expect(response.headers['cache-control']).toBe('no-store');
      assertSafe(response.bodyText, f, host.token, host.ownerToken);
      expect(await createWorkToolClient(host).invoke(f.request())).toEqual(response.json());
      expect(f.snapshot()).toEqual(before);
      expect(host.ownerSubmit).not.toHaveBeenCalled();
    } finally { await host.close(); f.close(); }
  });

  it('[case:submit-replay-conflict] 候选/证据提交并发幂等，摘要冲突拒绝；候选拒绝仍可查原稳定回执', async () => {
    const f = await fixture(); const host = await serve(f);
    try {
      const client = createWorkToolClient(host);
      for (const operation of ['candidate.submit', 'evidence.submit']) {
        const artifactId = await f.publish(operation === 'candidate.submit' ? f.candidate() : { evidence: 1 });
        const request = f.request(operation, { artifactId });
        const before = f.snapshot();
        const responses = await Promise.all([client.invoke(request), client.invoke(request)]);
        for (const receipt of responses) expect(receipt).toMatchObject({ principalId: 'work-agent', status: 'completed', result: { verificationPassed: false } });
        expect(responses.filter(r => 'replayed' in r && r.replayed)).toHaveLength(1);
        const first = responses.find(r => 'replayed' in r && !r.replayed)!;
        expect(await client.invoke(request)).toEqual({ ...first, replayed: true });
        expect({ ...f.snapshot(), command_receipts: null }).toEqual({ ...before, command_receipts: null });
        expect(f.f.box.session.database.prepare('SELECT * FROM command_receipts WHERE command_id=?').all(request.commandId)).toHaveLength(1);
        const conflict = { ...request, payload: { ...request.payload, artifactId: await f.publish({ changed: true }) } };
        const unchanged = f.snapshot();
        await expect(client.invoke(conflict)).rejects.toMatchObject({ code: 'conflict' });
        expect(f.snapshot()).toEqual(unchanged);
      }
      const invalid = f.request('candidate.submit', { artifactId: await f.publish(f.candidate({ attemptId: 'different' })) });
      const rejected = await client.invoke(invalid);
      expect(rejected).toMatchObject({ status: 'rejected', error: { code: 'invalid_input' } });
      expect(await client.invoke(invalid)).toEqual({ ...rejected, replayed: true });
      expect(host.ownerSubmit).not.toHaveBeenCalled();
    } finally { await host.close(); f.close(); }
  });

  it('[case:deny-scopes-and-forgery] 跨项目/Run/Attempt、伪造主体或权限在写入前拒绝，响应不回显输入', async () => {
    const f = await fixture(); const host = await serve(f);
    try {
      const base = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      const before = f.snapshot();
      const requests: unknown[] = [
        { ...base, scope: { kind: 'project', projectId: randomUUID() } },
        ...['runId', 'attemptId', 'taskId', 'purpose'].map(key => ({ ...base, payload: { ...base.payload, identity: { ...f.binding.identity, [key]: 'SYNTHETIC-SECRET' } } })),
        { ...base, payload: { ...base.payload, invocationId: 'native-session' } },
        { ...base, payload: { ...base.payload, executionVersion: 99 } },
      ];
      for (const key of ['actorId', 'principal', 'principalId', 'role', 'capabilities', 'SYNTHETIC-SECRET']) {
        requests.push({ ...base, [key]: 'SYNTHETIC-SECRET' }, { ...base, payload: { ...base.payload, [key]: 'SYNTHETIC-SECRET' } });
      }
      for (const request of requests) {
        const response = await host.post(request);
        expect([400, 403]).toContain(response.statusCode);
        assertSafe(response.bodyText, f, host.token, host.ownerToken);
        expect(f.snapshot()).toEqual(before);
      }
    } finally { await host.close(); f.close(); }
  });

  it('[case:deny-management-and-owner-routes] 未知、SQL、文件、管理操作受控拒绝；受限凭据不能进入 owner 或生命周期接口', async () => {
    const f = await fixture(); const host = await serve(f);
    try {
      const before = f.snapshot();
      for (const op of ['unknown.SYNTHETIC-SECRET', 'sql.query', 'files.read', 'task.pass', 'feature.plan.decide',
        'execution.budget.revise', 'execution.start', 'workspace.release', 'locks.update']) {
        const response = await host.post(f.request(op));
        expect(response.statusCode).toBe(501);
        expect(response.json()).toMatchObject({ error: { code: 'unsupported', operation: 'work.tools.invoke' } });
        assertSafe(response.bodyText, f, host.token);
      }
      for (const payload of [{ path: f.f.box.box.dbPath }, { sql: 'SELECT * FROM tasks' }, { actorId: 'local-owner' }]) {
        expect((await host.post(f.request('task.read', payload))).statusCode).toBe(400);
      }
      const ownerCommand = f.f.box.envelope('project.register', { repositoryPath: f.f.box.box.repoDirB, displayName: 'forbidden' }, { scope: { kind: 'registration' } });
      expect((await host.post(ownerCommand, '/v1/commands')).statusCode).toBe(401);
      for (const path of ['/v1/projects', '/v1/receipts/' + randomUUID(), '/v1/host/status']) {
        expect((await loopbackRequest({ port: host.port, method: 'GET', path, token: host.token })).statusCode).toBe(401);
      }
      expect((await host.post({}, '/v1/host/stop')).statusCode).not.toBe(200);
      expect(f.snapshot()).toEqual(before);
      expect(host.ownerSubmit).not.toHaveBeenCalled();
    } finally { await host.close(); f.close(); }
  });

  it('[case:deny-live-authority] 过期、撤销、恢复身份/主体变化、不可见和权限撤销不能查询或重放已提交命令', async () => {
    const f = await fixture(); const host = await serve(f);
    try {
      const request = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      expect((await host.post(request)).statusCode).toBe(200);
      const before = f.snapshot();
      for (const binding of [null, { ...f.binding, nowUtcMs: NOW + 1000 },
        { ...f.binding, invocationId: 'resumed' }, { ...f.binding, hostInstanceId: 'other-host' },
        { ...f.binding, executionVersion: 2 }, { ...f.binding, identity: { ...f.binding.identity, attemptId: 'new-attempt' } },
        { ...f.binding, principal: { ...f.binding.principal, principalId: 'local-owner' } },
        { ...f.binding, principal: { ...f.binding.principal, capabilities: new Set<never>() } },
        { ...f.binding, principal: { ...f.binding.principal, projectScope: { kind: 'allowlist' as const, projectIds: [randomUUID()] } } },
      ]) {
        f.setCurrent(binding);
        for (const body of [request, f.request()]) {
          const response = await host.post(body);
          expect(response.statusCode).toBe(403);
          assertSafe(response.bodyText, f, host.token, host.ownerToken);
        }
        expect(f.snapshot()).toEqual(before);
      }
      f.setCurrent(f.binding); host.grant.revoke();
      await expect(createWorkToolClient(host).invoke(request)).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.snapshot()).toEqual(before);
    } finally { await host.close(); f.close(); }
  });

  it('[case:terminal-and-fence] 数据库终态、lease 和 fence 变化后，在提交前拒绝', async () => {
    const f = await fixture(); const host = await serve(f);
    try {
      const db = f.f.box.session.database;
      const request = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      for (const [table, id, active, terminal] of [['attempts', f.binding.identity.attemptId, 'executing', 'succeeded'], ['runs', f.binding.identity.runId, 'running', 'succeeded'],
        ['tasks', f.binding.identity.taskId, 'running', 'passed'], ['execution_batches', f.f.ids.batchId, 'running', 'succeeded']]) {
        db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(terminal, id);
        const before = f.snapshot();
        expect((await host.post(request)).statusCode).toBe(403);
        expect(f.snapshot()).toEqual(before);
        db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(active, id);
      }
      db.prepare('UPDATE attempts SET lease_until=? WHERE id=?').run(NOW + 1, f.binding.identity.attemptId);
      f.setCurrent({ ...f.binding, nowUtcMs: NOW + 2 });
      const expiredLease = f.snapshot();
      expect((await host.post(request)).statusCode).toBe(403);
      expect(f.snapshot()).toEqual(expiredLease);
      db.prepare('UPDATE attempts SET lease_until=? WHERE id=?').run(NOW + 1000, f.binding.identity.attemptId);
      f.setCurrent({ ...f.binding, nowUtcMs: NOW + 999 });
      db.prepare('UPDATE tasks SET execution_version=2 WHERE id=?').run(f.binding.identity.taskId);
      const before = f.snapshot();
      expect((await host.post(request)).statusCode).toBe(403);
      expect(f.snapshot()).toEqual(before);
    } finally { await host.close(); f.close(); }
  });

  it('[case:inflight-quiesce] Host 停止时撤销异步读制品中的授权，提交前再核验并保持数据库不变', async () => {
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = await openWorkToolFixture({ restrictedPrincipal: true, afterRead: async () => { entered(); await held; } });
    const host = await serve(f);
    try {
      const request = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      const before = f.snapshot();
      const response = host.post(request);
      await Promise.race([reading, response.then(() => { throw new Error('request ended before artifact read'); })]);
      host.quiesce(); release();
      expect((await response).statusCode).toBe(403);
      expect(f.snapshot()).toEqual(before);
    } finally { release(); await host.close(); f.close(); }
  });

  it('[case:auth-no-fallback] 缺失/错误/owner 凭据、Host/Origin 不符拒绝，窄客户端只发受限请求且不会启动其他 Host', async () => {
    const f = await fixture(); const host = await serve(f);
    try {
      const before = f.snapshot();
      for (const token of [null, randomBytes(32).toString('hex'), host.ownerToken]) {
        const response = await host.post(f.request(), '/v1/work/tools', token);
        expect(response.statusCode).toBe(401);
        assertSafe(response.bodyText, f, host.token, host.ownerToken);
      }
      for (const headers of [{ Origin: 'https://example.com' }, { Host: 'localhost' }]) {
        expect((await host.post(f.request(), '/v1/work/tools', host.token, headers)).statusCode).toBe(401);
      }
      expect((await host.post(f.request(), '/v1/work/tools?principal=local-owner')).statusCode).toBe(400);
      await expect(createWorkToolClient({ port: host.port, token: host.ownerToken }).invoke(f.request())).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(createWorkToolClient(host).invoke(f.request('sql.query'))).rejects.toMatchObject({ code: 'unsupported' });
      expect(host.ownerSubmit).not.toHaveBeenCalled();
      expect(f.snapshot()).toEqual(before);
      host.quiesce();
      await expect(createWorkToolClient(host).invoke(f.request())).rejects.toMatchObject({ code: 'unauthorized' });
    } finally { await host.close(); f.close(); }
  });

  it('[case:restart-reissue] 新 Host 注册表拒绝旧凭据，仅可信重新签发可恢复访问和稳定回执', async () => {
    const f = await fixture(); const first = await serve(f);
    let second: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      const request = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      const receipt = (await first.post(request)).json();
      await first.close();
      second = await serve(f);
      const before = f.snapshot();
      expect((await second.post(request, '/v1/work/tools', first.token)).statusCode).toBe(401);
      expect((await second.post(request)).json()).toEqual({ ...(receipt as object), replayed: true });
      expect(f.snapshot()).toEqual(before);
    } finally { if (second) await second.close(); else await first.close(); f.close(); }
  });

  it('[case:startup-host-binding] 可信回调仍须绑定实际 Host 实例，旧 Host 声明不能在新实例签发', async () => {
    const f = await openWorkToolFixture();
    const box = createCommandsTestFixture({ prefix: 'shiploop-work-host-binding-' });
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const currentBinding = vi.fn(() => f.binding);
      host = await startHost({ dataRoot: box.dataRoot, capabilityCatalog: box.capabilityCatalog,
        env: {}, workToolAuthority: { currentBinding, candidateContext: () => { throw new Error('unexpected candidate lookup'); } } });
      expect(host.hostInstanceId).not.toBe(f.binding.hostInstanceId);
      expect(() => host!.workTools.issue({ ...f.access, context: { ...f.access.context, grantId: randomUUID() } }, f.binding)).toThrow();
      expect(currentBinding).toHaveBeenCalledOnce();
    } finally { await host?.close(); f.close(); box.cleanup(); }
  });

  it('[case:startup-wiring] startHost 装配受限面，默认无授权，重启不会加载或接受旧凭据', async () => {
    const box = createCommandsTestFixture({ prefix: 'shiploop-work-host-' });
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const options = { dataRoot: box.dataRoot, capabilityCatalog: box.capabilityCatalog, env: {}, platform: 'darwin' };
      host = await startHost(options);
      const token = randomBytes(32).toString('hex');
      expect((await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/work/tools', token, body: {} })).statusCode).toBe(401);
      await host.close();
      host = await startHost(options);
      expect((await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/work/tools', token, body: {} })).statusCode).toBe(401);
      expect(() => host!.workTools.issue({}, {} as never)).toThrow('authority unavailable');
    } finally { await host?.close(); box.cleanup(); }
  });
});
