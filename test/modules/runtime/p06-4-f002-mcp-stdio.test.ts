import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMcpStdioConnection, createMcpStdioConnectionManager, startMcpStdioConnections,
  type McpStdioConnection, type McpStdioProcessRegistration,
} from '../../../packages/host/src/runtime/mcp-stdio.ts';
import type { McpStartupPlan, McpStartupServerPlan } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';
import { createTempSandbox, type TempSandbox } from '../../helpers/temp-sandbox.ts';
import { processRows, until } from '../../helpers/process-matrix.ts';
import { createFakeMcpServerCommand, waitForFakeMcpFile, type FakeMcpServerOptions } from '../../helpers/mcp-stdio-fake-server.ts';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const RESOURCE = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);
const boxes: TempSandbox[] = [];
const connections: McpStdioConnection[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const c of connections.splice(0).reverse()) expect((await c.close()).confirmed).toBe(true);
  // Retain sandboxes if owned process cleanup cannot be proved.
  for (const box of boxes.splice(0).reverse()) box.cleanup();
});
function box(): string {
  const created = createTempSandbox('shiploop-mcp-stdio-');
  boxes.push(created);
  return created.path;
}
function plan(root: string, sessionId = 'session-1', options: FakeMcpServerOptions = {}): McpStartupPlan {
  const command = createFakeMcpServerCommand(root, options);
  const server: McpStartupServerPlan = {
    resourceId: RESOURCE, sourceRef: SOURCE, sourceRevision: 'rev-1', version: '1.0.0', contentDigest: DIGEST,
    environmentRefs: [], credentialRef: null, executable: command.executable, argv: command.argv, cwd: root,
    environment: {}, allowedTools: ['echo'], approvalDigest: 'b'.repeat(64),
    tools: [{ resourceId: RESOURCE, sourceRef: SOURCE, originalName: 'echo', piName: 'mcp_echo' }],
  };
  return { schemaVersion: 1, projectId: PROJECT, sessionId, attemptId: `attempt-${sessionId}`, invocationId: 'invocation-1',
    executionVersion: 1, resourceSnapshotDigest: DIGEST, servers: [server], tools: server.tools, gaps: [], digest: 'c'.repeat(64) };
}
function registrar() {
  const values: McpStdioProcessRegistration[] = [];
  return { values, register: async (value: McpStdioProcessRegistration) => {
    values.push(value); return { launchId: value.processIdentity.launchId };
  } };
}
function connection(options: Parameters<typeof createMcpStdioConnection>[0]) {
  const result = createMcpStdioConnection(options);
  connections.push(result);
  return result;
}
async function expectGroupGone(registration: McpStdioProcessRegistration): Promise<void> {
  expect((await processRows()).filter(row => row.processGroupId === registration.processIdentity.processGroupId)).toEqual([]);
}

describe('P06-4 F-002 stdio MCP lifecycle', () => {
  it('[case:real-handshake-and-process-registration] commits the OS identity before initialize and waits for tools/list', async () => {
    const root = box(), recorded = registrar();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const registering = new Promise<void>(resolve => { arrived = resolve; });
    const c = connection({ plan: plan(root, 'session-1', { holdInitialize: true }), handshakeTimeoutMs: 2_000,
      registerProcess: async value => {
        await recorded.register(value); arrived(); await gate;
        return { launchId: value.processIdentity.launchId };
      } });
    expect(c.state).toBe('not_started');
    const pending = c.start();
    expect(c.start()).toBe(pending);
    await registering;
    expect(c.state).toBe('starting');
    expect(existsSync(join(root, 'initialize.entered'))).toBe(false);
    const row = (await processRows()).find(row => row.pid === recorded.values[0]!.processIdentity.pid);
    const { launchId: _launchId, ...osIdentity } = recorded.values[0]!.processIdentity;
    expect(row).toMatchObject(osIdentity);
    release();
    await waitForFakeMcpFile(join(root, 'initialize.entered'));
    expect(c.state).toBe('starting');
    expect(existsSync(join(root, 'tools.list'))).toBe(false);
    writeFileSync(join(root, 'initialize.release'), 'release');
    const result = await pending;
    expect(c.state).toBe('available');
    expect(result.tools.map(tool => tool.name)).toEqual(['echo']);
    expect(Object.isFrozen(result.tools[0]!.inputSchema)).toBe(true);
    expect(recorded.values).toHaveLength(1);
    expect(recorded.values[0]).toMatchObject({ projectId: PROJECT, sessionId: 'session-1', serverId: RESOURCE,
      invocationId: 'invocation-1', planDigest: 'c'.repeat(64) });
    const closing = c.close();
    expect(c.close()).toBe(closing);
    expect((await closing).confirmed).toBe(true);
    expect(c.state).toBe('closed');
    await expectGroupGone(recorded.values[0]!);
    await waitForFakeMcpFile(join(root, 'exit.json'));
  });

  it('[case:session-isolation-and-start-idempotency] reuses one result and gives other sessions their own processes and tool snapshots', async () => {
    const firstRoot = box(), secondRoot = box(), recorded = registrar();
    const manager = createMcpStdioConnectionManager();
    cleanups.push(() => manager.closeAll());
    const firstPlan = plan(firstRoot);
    const first = manager.start({ plan: firstPlan, registerProcess: recorded.register });
    expect(manager.start({ plan: firstPlan, registerProcess: recorded.register })).toBe(first);
    const c1 = await first;
    const c2 = await manager.start({ plan: plan(secondRoot, 'session-2', { toolName: 'other' }), registerProcess: recorded.register });
    expect(manager.get(PROJECT, 'session-1', RESOURCE, 'invocation-1')).toBe(c1);
    expect(c2).not.toBe(c1);
    expect((await c1.start()).tools.map(t => t.name)).toEqual(['echo']);
    expect((await c2.start()).tools.map(t => t.name)).toEqual(['other']);
    expect(recorded.values).toHaveLength(2);
    expect(recorded.values[0]!.processIdentity.pid).not.toBe(recorded.values[1]!.processIdentity.pid);
    await c1.close();
    expect(c2.state).toBe('available');
    expect((await c2.start()).tools.map(t => t.name)).toEqual(['other']);
  });

  it('[case:plan-conflict-and-failed-start-are-sticky] rejects changed envelopes and retains failed admissions', async () => {
    const recorded = registrar(), manager = createMcpStdioConnectionManager();
    cleanups.push(() => manager.closeAll());
    const original = plan(box());
    await manager.start({ plan: original, registerProcess: recorded.register });
    for (const changed of [{ ...original, digest: 'd'.repeat(64) },
      { ...original, servers: [{ ...original.servers[0]!, argv: ['changed'] }] }]) {
      await expect(manager.start({ plan: changed, registerProcess: recorded.register })).rejects.toMatchObject({ code: 'startup_plan_conflict' });
    }
    const badBase = plan(box(), 'bad');
    const bad = { ...badBase, servers: [{ ...badBase.servers[0]!, executable: '/definitely/missing/mcp-server' }] };
    const failed = manager.start({ plan: bad, registerProcess: recorded.register });
    await expect(failed).rejects.toMatchObject({ code: 'missing_executable' });
    expect(manager.start({ plan: bad, registerProcess: recorded.register })).toBe(failed);
    expect(recorded.values).toHaveLength(1);
  });

  it.each(['hang_initialize', 'hang_list'] as const)('[case:deadline-%s] rolls back a hanging handshake within a finite budget', async mode => {
    const root = box(), recorded = registrar();
    const c = connection({ plan: plan(root, mode, { mode }), registerProcess: recorded.register,
      handshakeTimeoutMs: 300, closeTimeoutMs: 100 });
    await expect(c.start()).rejects.toMatchObject({ code: 'handshake_timeout' });
    expect(c.state).toBe('failed');
    expect(recorded.values).toHaveLength(1);
    await expectGroupGone(recorded.values[0]!);
  });

  it.each([
    ['invalid_protocol', 'incompatible_protocol'], ['missing_tools_capability', 'incompatible_capabilities'],
    ['stdout_noise', 'protocol_error'], ['large_output', 'protocol_error'], ['list_error', 'protocol_error'],
    ['exit_initialize', 'process_exited_during_start'],
  ] as const)('[case:startup-%s] rejects startup with %s without claiming available', async (mode, code) => {
    const root = box(), recorded = registrar();
    const c = connection({ plan: plan(root, mode, { mode }), registerProcess: recorded.register,
      handshakeTimeoutMs: 1_500, closeTimeoutMs: 100 });
    await expect(c.start()).rejects.toMatchObject({ code });
    expect(c.state).toBe('failed');
    expect((await c.close()).confirmed).toBe(true);
  });

  it.each(['reject', 'wrong_ack', 'hang'] as const)('[case:registration-%s] never sends initialize when registration fails', async mode => {
    const root = box();
    const c = connection({ plan: plan(root), handshakeTimeoutMs: 300, closeTimeoutMs: 100,
      registerProcess: async () => {
        if (mode === 'reject') throw new Error('private registration path');
        if (mode === 'hang') return new Promise(() => {});
        return { launchId: 'wrong' };
      } });
    await expect(c.start()).rejects.toMatchObject({ code: mode === 'hang' ? 'handshake_timeout' : 'process_registration_failed' });
    expect(c.processRegistration).not.toBeNull();
    expect(existsSync(join(root, 'initialize.entered'))).toBe(false);
    expect(c.error?.message).not.toContain('private');
    await expectGroupGone(c.processRegistration!);
  });

  it('[case:partial-construction-rollback] stops an earlier server if a later executable cannot start', async () => {
    const root = box(), recorded = registrar(), first = plan(root);
    const other = { ...first.servers[0]!, resourceId: '44444444-4444-4444-8444-444444444444', executable: '/missing/mcp' };
    await expect(startMcpStdioConnections({ plan: { ...first, servers: [first.servers[0]!, other] },
      registerProcess: recorded.register, closeTimeoutMs: 100 })).rejects.toMatchObject({ code: 'missing_executable' });
    expect(recorded.values).toHaveLength(1);
    await expectGroupGone(recorded.values[0]!);
  });

  it('[case:unconfirmed-stop-retains-evidence] preserves ownership and unknown stop status on a failed census', async () => {
    const root = box(), recorded = registrar();
    const c = createMcpStdioConnection({ plan: plan(root), registerProcess: recorded.register, closeTimeoutMs: 100,
      processInspector: {
        async identify(pid, launchId) {
          const row = (await processRows()).find(row => row.pid === pid)!;
          return { launchId, pid, processGroupId: row.processGroupId, startTime: row.startTime };
        }, matches: async () => false, groupAbsent: async () => { throw new Error('census unavailable'); },
      } });
    await c.start();
    const result = await c.close();
    expect(result).toMatchObject({ confirmed: false, status: 'unconfirmed', processIdentity: c.processRegistration!.processIdentity });
    expect(await c.close()).toBe(result);
    expect(c.stopEvidence).toBe(result);
    expect(c.state).toBe('failed');
    expect(c.error?.code).toBe('cleanup_unconfirmed');
    // A real independent census proves fixture cleanup without changing the fault-injected evidence.
    await expectGroupGone(c.processRegistration!);
    expect(c.processRegistration).toEqual(recorded.values[0]);
  });

  it('[case:identity-construction-failure] stops the owned child after a partial identity failure', async () => {
    const root = box();
    const c = connection({ plan: plan(root, 'identity-failure', { mode: 'hang_initialize' }), closeTimeoutMs: 100,
      registerProcess: registrar().register, processInspector: {
        identify: async () => { throw new Error('OS identity unavailable'); }, matches: async () => false,
        groupAbsent: async pgid => !(await processRows()).some(row => row.processGroupId === pgid),
      } });
    await expect(c.start()).rejects.toMatchObject({ code: 'process_registration_failed' });
    expect((await c.close()).confirmed).toBe(true);
  });

  it('[case:rollback-controlled-descendant] stops a real controlled child when initialization hangs', async () => {
    const root = box(), recorded = registrar();
    const c = connection({ plan: plan(root, 'child-rollback', { mode: 'hang_initialize', spawnChild: true }),
      registerProcess: recorded.register, handshakeTimeoutMs: 500, closeTimeoutMs: 150 });
    await expect(c.start()).rejects.toMatchObject({ code: 'handshake_timeout' });
    const childPid = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
    expect(childPid).toBeGreaterThan(1);
    expect((await processRows()).some(row => row.pid === childPid)).toBe(false);
    await expectGroupGone(recorded.values[0]!);
  });

  it('[case:close-during-registration] fences a late registration acknowledgment after close', async () => {
    const root = box();
    let entered!: () => void, release!: () => void;
    const registering = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const c = connection({ plan: plan(root), registerProcess: async value => {
      entered(); await gate; return { launchId: value.processIdentity.launchId };
    }, closeTimeoutMs: 100 });
    const pending = c.start();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'closed' });
    await registering;
    await c.close();
    release();
    await rejected;
    expect(existsSync(join(root, 'initialize.entered'))).toBe(false);
    expect(c.state).toBe('failed');
    await expectGroupGone(c.processRegistration!);
  });

  it('[case:server-exit-after-ready] fails an available connection when its server exits', async () => {
    const root = box(), recorded = registrar();
    const c = connection({ plan: plan(root), registerProcess: recorded.register, closeTimeoutMs: 100 });
    await c.start();
    process.kill(recorded.values[0]!.processIdentity.pid, 'SIGTERM');
    await until(() => c.state === 'failed', 'connection notices exit');
    expect(c.error?.code).toBe('server_exited');
    expect((await c.close()).confirmed).toBe(true);
  });

  it('[case:bounded-stderr-and-input-snapshot] contains diagnostic output and snapshots launch inputs before an await', async () => {
    const root = box(), p = plan(root, 'stderr', { stderrBytes: 500_000 }), recorded = registrar();
    const c = connection({ plan: p, server: p.servers[0], registerProcess: async value => {
      (p.servers[0]!.environment as Record<string, string>).PRIVATE_SENTINEL = 'changed-after-start';
      return recorded.register(value);
    }, maxStderrBytes: 128 });
    const result = await c.start();
    expect(JSON.stringify(result)).not.toContain('private-diagnostic');
    expect(c.server.environment).toEqual({});
    expect(c.error).toBeNull();
  });
});
