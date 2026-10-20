import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateCommandEnvelope } from '../../../packages/core/src/ports/commands.ts';
import { validateWireCommandReceipt } from '../../../packages/core/src/ports/command-receipts.ts';
import { CODE_DIGEST, openWorkToolFixture as fixture } from '../../helpers/host/work-tool-fixture.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';

describe('Work 受限业务通道', () => {
  it('[case:submissions-replay] 当前 Work 提交候选/证据；持久回执重放且提交不代表通过', async () => {
    const f = await fixture();
    try {
      for (const operation of ['candidate.submit', 'evidence.submit']) {
        const artifactId = await f.publish(operation === 'candidate.submit' ? f.candidate() : { evidence: 'observed output' });
        const request = f.request(operation, { artifactId });
        const before = f.snapshot();
        const receipt = await f.bridge.invoke(request);
        expect(receipt).toMatchObject({ status: 'completed', operation, result: {
          identity: f.binding.identity, artifact: { artifactId }, verificationPassed: false,
        } });
        expect(validateWireCommandReceipt(receipt, 'test')).toEqual(receipt);
        expect(await f.bridge.invoke(request)).toEqual({ ...receipt, replayed: true });
        const after = f.snapshot();
        expect({ ...after, command_receipts: null }).toEqual({ ...before, command_receipts: null });
        // Durable receipt, not a process-local replay cache; current grant must still be valid.
        const second = f.channel.bind({ ...f.access, context: { ...f.access.context, grantId: randomUUID() } }, f.binding);
        expect(await second.invoke(request)).toEqual({ ...receipt, replayed: true });
        const collision = { ...request, payload: { ...request.payload, artifactId: await f.publish({ different: true }) } };
        const unchanged = f.snapshot();
        await expect(f.bridge.invoke(collision)).rejects.toMatchObject({ code: 'conflict' });
        expect(f.snapshot()).toEqual(unchanged);
      }
    } finally { f.close(); }
  });

  it('[case:deny-requests] 跨项目、跨 Attempt/Run、purpose、伪造主体和执行版本拒绝且无写入', async () => {
    const f = await fixture();
    try {
      const valid = f.request();
      const before = f.snapshot();
      for (const key of ['actorId', 'principal', 'role', 'capabilities']) {
        await expect(f.bridge.invoke({ ...valid, [key]: 'local-owner' })).rejects.toThrow();
        await expect(f.bridge.invoke({ ...valid, payload: { ...valid.payload, [key]: 'local-owner' } })).rejects.toThrow();
      }
      for (const payload of [
        { identity: { ...f.binding.identity, attemptId: 'other-attempt' } },
        { identity: { ...f.binding.identity, runId: 'other-run' } },
        { identity: { ...f.binding.identity, taskId: 'other-task' } },
        { identity: { ...f.binding.identity, purpose: 'chat' } },
        { invocationId: 'native-session-is-not-authority' }, { executionVersion: 99 },
      ]) await expect(f.bridge.invoke(f.request('task.read', payload))).rejects.toThrow();
      await expect(f.bridge.invoke({ ...valid, scope: { kind: 'project', projectId: randomUUID() } })).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:deny-management] 无审批、passed、预算、批次、锁、工作区、SQL 或文件入口，Host 命令白名单也未扩展', async () => {
    const f = await fixture();
    try {
      const before = f.snapshot();
      for (const op of ['feature.plan.decide', 'task.pass', 'execution.budget.revise', 'execution.start',
        'locks.update', 'workspace.release', 'sql.query', 'files.read', '__proto__', 'constructor']) {
        await expect(f.bridge.invoke(f.request(op))).rejects.toThrow();
      }
      for (const op of ['candidate.submit', 'evidence.submit', 'task.read']) expect(() => validateCommandEnvelope(f.request(op))).toThrow();
      await expect(f.bridge.invoke(f.request('task.read', { path: '/etc/passwd', sql: 'SELECT * FROM tasks' }))).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:deny-live-authority] 到期、恢复身份变化、撤权/不可见均重新核对，包含历史回执重放', async () => {
    const f = await fixture();
    try {
      const request = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      await f.bridge.invoke(request);
      const before = f.snapshot();
      for (const binding of [
        null,
        { ...f.binding, nowUtcMs: NOW + 1000 },
        { ...f.binding, invocationId: 'recovered-invocation' },
        { ...f.binding, executionVersion: 2 },
        { ...f.binding, hostInstanceId: 'recovered-host' },
        { ...f.binding, principal: { ...f.binding.principal, principalId: 'other-owner' } },
        { ...f.binding, principal: { ...f.binding.principal, capabilities: new Set<never>() } },
        { ...f.binding, principal: { ...f.binding.principal, projectScope: { kind: 'allowlist' as const, projectIds: [randomUUID()] } } },
      ]) {
        f.setCurrent(binding);
        await expect(f.bridge.invoke(request)).rejects.toThrow();
        await expect(f.bridge.invoke(f.request())).rejects.toThrow();
      }
      f.setCurrent(f.binding);
      f.bridge.revoke();
      await expect(f.bridge.invoke(request)).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:deny-lifecycle] 当前数据库 fence 和终态为权威，恢复不能沿用旧 Attempt', async () => {
    const f = await fixture();
    try {
      const db = f.f.box.session.database;
      const id = f.binding.identity.attemptId;
      for (const [table, target] of [['attempts', id], ['runs', f.binding.identity.runId], ['execution_batches', f.f.ids.batchId]]) {
        const active = table === 'attempts' ? 'executing' : 'running';
        db.prepare(`UPDATE ${table} SET status='succeeded' WHERE id=?`).run(target);
        const before = f.snapshot();
        await expect(f.bridge.invoke(f.request())).rejects.toThrow();
        expect(f.snapshot()).toEqual(before);
        db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(active, target);
      }
      expect(() => db.prepare("UPDATE attempts SET invocation_id='other' WHERE id=?").run(id)).toThrow(/immutable/);
      expect(() => db.prepare('UPDATE attempts SET execution_version=2 WHERE id=?').run(id)).toThrow(/immutable/);
      db.prepare('UPDATE tasks SET execution_version=2 WHERE id=?').run(f.binding.identity.taskId);
      const before = f.snapshot();
      await expect(f.bridge.invoke(f.request())).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:deny-operation-set] 仅 task.read 授权不能提交，声明不能重签同 grantId', async () => {
    const f = await fixture({ operations: ['task.read'] });
    try {
      const before = f.snapshot();
      expect(() => f.channel.bind(f.access, f.binding)).toThrow();
      await expect(f.bridge.invoke(f.request('evidence.submit', { artifactId: 'no-artifact' }))).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:candidate-rules] 复用真实候选校验，跨 Attempt、命令注入和不允许目标产生稳定拒绝回执', async () => {
    const f = await fixture();
    try {
      for (const change of [
        { attemptId: 'another-attempt' }, { executionVersion: 2 }, { codeDigest: 'cd'.repeat(32) },
        { command: 'arbitrary shell' },
        { modules: [{ moduleKey: 'core', targets: ['../outside'], reason: 'r' }] },
        { modules: [{ moduleKey: 'core', targets: ['packages/core/missing.test.ts'], reason: 'r' }] },
      ]) {
        const request = f.request('candidate.submit', { artifactId: await f.publish(f.candidate(change)) });
        const before = f.snapshot();
        const receipt = await f.bridge.invoke(request);
        expect(receipt).toMatchObject({ status: 'rejected', error: { code: 'invalid_input' } });
        expect(await f.bridge.invoke(request)).toEqual({ ...receipt, replayed: true });
        expect({ ...f.snapshot(), command_receipts: null }).toEqual({ ...before, command_receipts: null });
      }
    } finally { f.close(); }
  });

  it('[case:managed-artifacts] 他项目、非 ready 和不存在 Artifact 不会提交', async () => {
    const f = await fixture();
    try {
      const other = await f.f.box.services.commands.submit(f.binding.principal, f.f.box.envelope('project.register', {
        repositoryPath: f.f.box.box.repoDirB, displayName: 'other', description: null, labels: [],
      }, { scope: { kind: 'registration' } }));
      if (other.status !== 'completed') throw new Error('fixture project registration');
      const otherProject = (other.result as { project: { id: string } }).project.id;
      const foreign = await f.publish({ evidence: 'foreign' }, otherProject);
      const pending = await f.artifacts.registerArtifact({ projectId: f.binding.projectId, kind: 'evidence', mediaType: 'text/plain',
        expectedHash: CODE_DIGEST, locator: 'work/pending' });
      for (const artifactId of ['missing-artifact', foreign, pending.id]) {
        const before = f.snapshot();
        await expect(f.bridge.invoke(f.request('evidence.submit', { artifactId }))).rejects.toThrow();
        expect(f.snapshot()).toEqual(before);
      }
    } finally { f.close(); }
  });

  it('[case:inflight-revocation] 异步 Artifact 核对期间撤销，不产生提交回执', async () => {
    let revoke = () => {};
    const f = await fixture({ afterRead: async () => revoke() });
    try {
      revoke = () => f.bridge.revoke();
      const request = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      const before = f.snapshot();
      await expect(f.bridge.invoke(request)).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:inflight-expiry] 异步核对期间授权到期，提交无写入', async () => {
    let expire = () => {};
    const f = await fixture({ afterRead: async () => expire() });
    try {
      expire = () => f.setCurrent({ ...f.binding, nowUtcMs: NOW + 1000 });
      const request = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      const before = f.snapshot();
      await expect(f.bridge.invoke(request)).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:concurrent-submit] 并发同 commandId 最终事务复核，只创建一份回执', async () => {
    const f = await fixture();
    try {
      const request = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      const [a, b] = await Promise.all([f.bridge.invoke(request), f.bridge.invoke(request)]);
      expect({ ...a, replayed: null }).toEqual({ ...b, replayed: null });
      expect([a, b].filter(x => 'replayed' in x && x.replayed)).toHaveLength(1);
      const rows = f.f.box.session.database.prepare('SELECT * FROM command_receipts WHERE command_id=?').all(request.commandId);
      expect(rows).toHaveLength(1);
    } finally { f.close(); }
  });

  it('[case:command-timing] 过期或未来命令不产生业务/回执写入', async () => {
    const f = await fixture();
    try {
      const base = f.request('evidence.submit', { artifactId: await f.publish({ evidence: 1 }) });
      const before = f.snapshot();
      await expect(f.bridge.invoke({ ...base, issuedAt: new Date(NOW - 10000).toISOString(), expiresAt: new Date(NOW).toISOString() })).rejects.toThrow();
      await expect(f.bridge.invoke({ ...base, issuedAt: new Date(NOW + 9999999).toISOString() })).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:task-read] 可信桥接只返回当前 Task 的公开字段', async () => {
    const f = await fixture();
    try {
      const result = await f.bridge.invoke(f.request());
      expect(result).toMatchObject({ operation: 'task.read', task: { id: f.binding.identity.taskId } });
      expect(JSON.stringify(result)).not.toMatch(/inputSnapshot|executionConfig|locator|repositoryPath/);
    } finally { f.close(); }
  });
});
