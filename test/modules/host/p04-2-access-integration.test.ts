import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { startHost, createWorkToolClient } from '../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/host-startup.ts';
import { openWorkToolFixture } from '../../helpers/host/work-tool-fixture.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';

type Fixture = Awaited<ReturnType<typeof openWorkToolFixture>>;
async function fixture() {
  let host: RunningHost | undefined;
  let f: Fixture | undefined;
  const authority = {
    currentBinding: () => f?.currentBinding() ?? null,
    candidateContext: () => f!.candidateContext(),
  };
  try {
    f = await openWorkToolFixture({ restrictedPrincipal: true, beforeClaim: async claim => {
      host = await startHost({ dataRoot: claim.box.box.dataRoot, capabilityCatalog: claim.box.box.capabilityCatalog,
        env: {}, platform: 'darwin', workToolAuthority: authority });
      return host.hostInstanceId;
    } });
    if (!host) throw new Error('real Host must start before claiming the Attempt');
    const grant = host.workTools.issue(f.access, f.binding);
    const client = createWorkToolClient({ port: host.port, token: grant.token });
    // 夹具仅认领，不启动 Runtime/子进程；拆卸时释放其合成 lease，供真实 Host 停止核对。
    const releaseFixtureLease = () => f!.f.box.session.database.prepare('DELETE FROM workspace_leases WHERE owner_id=?')
      .run(f!.binding.identity.attemptId);
    return { f, host, grant, client, authority,
      async restart() {
        releaseFixtureLease();
        await host!.close();
        host = await startHost({ dataRoot: f!.f.box.box.dataRoot, capabilityCatalog: f!.f.box.box.capabilityCatalog,
          env: {}, platform: 'darwin', workToolAuthority: authority });
        return host;
      },
      async close() { releaseFixtureLease(); try { await host?.close(); } finally { f!.close(); } },
    };
  } catch (error) { try { await host?.close(); } finally { f?.close(); } throw error; }
}

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 }); });

describe('F-007 真实 Host/Core 访问边界', () => {
  it('[case:work-cannot-register-resource-source] valid Work credentials cannot use owner source registration', async () => {
    const h = await fixture();
    try {
      const before = h.f.snapshot();
      const response = await loopbackRequest({ port: h.host.port, method: 'POST',
        path: `/v1/projects/${h.f.binding.projectId}/resources/sources`, token: h.grant.token,
        body: { action: 'register', manifestPath: '/private/unapproved.json', expectedRevision: 0,
          projectId: h.f.binding.projectId, sourceId: randomUUID() } });
      expect(response.statusCode).toBe(401);
      expect(h.f.snapshot()).toEqual(before);
      expect(await h.client.invoke(h.f.request())).toMatchObject({ operation: 'task.read' });
      h.grant.revoke();
      await expect(h.client.invoke(h.f.request())).rejects.toMatchObject({ code: 'unauthorized' });
    } finally { await h.close(); }
  });
  it('[case:real-host-allow-idempotency] 当前授权查询和候选/证据提交成功，同摘要重放、异摘要冲突且不改变业务状态', async () => {
    const h = await fixture(); const { f, client } = h;
    try {
      const beforeRead = f.snapshot();
      expect(await client.invoke(f.request())).toMatchObject({ operation: 'task.read', task: { id: f.binding.identity.taskId } });
      expect(f.snapshot()).toEqual(beforeRead);
      for (const operation of ['candidate.submit', 'evidence.submit']) {
        const artifactId = await f.publish(operation === 'candidate.submit' ? f.candidate() : { evidence: 'controlled' });
        const command = f.request(operation, { artifactId });
        const before = f.snapshot();
        const receipts = await Promise.all([client.invoke(command), client.invoke(command)]);
        expect(receipts).toEqual(expect.arrayContaining([
          expect.objectContaining({ status: 'completed', principalId: 'work-agent', replayed: false }),
          expect.objectContaining({ status: 'completed', principalId: 'work-agent', replayed: true }),
        ]));
        for (const receipt of receipts) expect(receipt).toMatchObject({ result: { verificationPassed: false } });
        expect({ ...f.snapshot(), command_receipts: null }).toEqual({ ...before, command_receipts: null });
        expect(f.f.box.session.database.prepare('SELECT * FROM command_receipts WHERE command_id=?').all(command.commandId)).toHaveLength(1);
        const stable = f.snapshot();
        await expect(client.invoke({ ...command, payload: { ...command.payload, artifactId: randomUUID() } })).rejects.toMatchObject({ code: 'conflict' });
        expect(f.snapshot()).toEqual(stable);
      }
    } finally { await h.close(); }
  });

  it('[case:real-host-deny-authority] 跨项目、伪造、审批/改状态、到期、撤销和恢复不匹配均拒绝且数据库不变', async () => {
    const h = await fixture(); const { f, client } = h;
    const secret = ['synthetic', randomUUID(), randomUUID()].join('-');
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    try {
      const command = f.request('evidence.submit', { artifactId: await f.publish({ evidence: true }) });
      expect(await client.invoke(command)).toMatchObject({ status: 'completed' });
      const before = f.snapshot();
      for (const request of [
        { ...command, scope: { kind: 'project', projectId: randomUUID() } },
        { ...command, principalId: secret },
        { ...command, payload: { ...command.payload, actorId: secret } },
        f.request('feature.plan.decide'), f.request('task.pass'),
        f.request('task.read', { identity: { ...f.binding.identity, attemptId: randomUUID() } }),
      ]) {
        const response = await loopbackRequest({ port: h.host.port, method: 'POST', path: '/v1/work/tools', token: h.grant.token, body: request });
        expect([400, 403, 501]).toContain(response.statusCode);
        for (const privateValue of [secret, h.grant.token, f.f.box.box.dataRoot]) {
          expect(response.bodyText.includes(privateValue)).toBe(false);
        }
        expect(f.snapshot()).toEqual(before);
      }
      for (const current of [null, { ...f.binding, nowUtcMs: NOW + 1000 },
        { ...f.binding, invocationId: 'recovered' }, { ...f.binding, executionVersion: 2 },
        { ...f.binding, hostInstanceId: randomUUID() },
        { ...f.binding, principal: { ...f.binding.principal, principalId: 'local-owner' } },
      ]) {
        f.setCurrent(current);
        for (const request of [command, f.request()]) await expect(client.invoke(request)).rejects.toMatchObject({ code: 'forbidden' });
        expect(f.snapshot()).toEqual(before);
      }
      f.setCurrent(f.binding); h.grant.revoke();
      await expect(client.invoke(command)).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.snapshot()).toEqual(before);
      expect(JSON.stringify(logs.map(log => log.mock.calls)).includes(secret)).toBe(false);
    } finally { logs.forEach(log => log.mockRestore()); await h.close(); }
  });

  it('[case:real-host-restart-no-owner] 同数据根重启后旧 token 和旧 Host 绑定失效，不能回退 owner', async () => {
    const h = await fixture(); const { f } = h;
    try {
      const command = f.request('evidence.submit', { artifactId: await f.publish({ evidence: true }) });
      expect(await h.client.invoke(command)).toMatchObject({ status: 'completed' });
      const restarted = await h.restart();
      expect(restarted.hostInstanceId).not.toBe(h.host.hostInstanceId);
      const before = f.snapshot(); // 启动恢复可写入核对证据；拒绝请求必须保持恢复后的状态。
      const oldClient = createWorkToolClient({ port: restarted.port, token: h.grant.token });
      for (const request of [command, f.request()]) await expect(oldClient.invoke(request)).rejects.toMatchObject({ code: 'unauthorized' });
      expect(() => restarted.workTools.issue({ ...f.access, context: { ...f.access.context, grantId: randomUUID() } }, f.binding))
        .toThrow(expect.objectContaining({ code: 'forbidden' }));
      for (const token of [h.grant.token]) {
        const response = await loopbackRequest({ port: restarted.port, method: 'GET', path: '/v1/projects', token });
        expect(response.statusCode).toBe(401);
      }
      expect(f.snapshot()).toEqual(before);
    } finally { await h.close(); }
  });
});
