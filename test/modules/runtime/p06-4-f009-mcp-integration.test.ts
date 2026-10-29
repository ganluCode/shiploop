import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMcpStdioConnection, createMcpStdioConnectionManager } from '../../../packages/host/src/runtime/mcp-stdio.ts';
import { prepareMcpStartupPlan, type McpTrustedResourceResolver } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';
import { createFakeMcpServerCommand, waitForFakeMcpFile } from '../../helpers/mcp-stdio-fake-server.ts';
import { mcpWorkFixture } from '../../helpers/p06-4/pi-mcp-fixture.ts';
import { processRows } from '../../helpers/process-matrix.ts';

function scopedRequest(f: Awaited<ReturnType<typeof mcpWorkFixture>>, sessionId: string, invocationId: string, attemptId: string) {
  return {
    ...f.request,
    sessionId,
    invocationId,
    identity: { ...f.request.identity, attemptId },
    workAccess: { ...f.request.workAccess!, invocationId, attemptId },
  };
}

function resolverFor(f: Awaited<ReturnType<typeof mcpWorkFixture>>, options: {
  readonly toolName: string;
  readonly result?: string;
  readonly callMode?: 'normal' | 'error' | 'hang' | 'exit' | 'is_error';
  readonly ignoreTerminate?: boolean;
}): McpTrustedResourceResolver {
  const original = f.assembly.mcp!.resolver;
  return {
    async resolve(input) {
      const approved = await original.resolve(input);
      if (!approved) return null;
      const command = createFakeMcpServerCommand(f.box.path, {
        toolName: options.toolName,
        callMode: options.callMode,
        ignoreTerminate: options.ignoreTerminate,
        echoEnvironmentKey: options.result === undefined ? undefined : 'MCP_RESULT',
      });
      const environment: Record<string, string> = options.result === undefined ? {} : { MCP_RESULT: options.result };
      return {
        ...approved,
        ...command,
        allowedTools: [options.toolName],
        environment,
      };
    },
  };
}

async function openScopedConnection(f: Awaited<ReturnType<typeof mcpWorkFixture>>, input: {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly toolName: string;
  readonly result?: string;
  readonly callMode?: 'normal' | 'error' | 'hang' | 'exit' | 'is_error';
  readonly ignoreTerminate?: boolean;
  readonly signal?: AbortSignal;
  readonly processInspector?: Parameters<typeof createMcpStdioConnection>[0]['processInspector'];
}) {
  const request = scopedRequest(f, input.sessionId, input.invocationId, input.attemptId);
  const resolver = resolverFor(f, input);
  const plan = await prepareMcpStartupPlan(request, { resolver });
  const server = plan.servers[0]!;
  const connection = createMcpStdioConnection({
    ...f.assembly.mcp!, plan, server, signal: input.signal, processInspector: input.processInspector,
    handshakeTimeoutMs: 2_000, callTimeoutMs: 1_000, closeTimeoutMs: 500,
  });
  await connection.start();
  return { request, plan, connection, catalog: await connection.createToolCatalog() };
}

it('[case:two-session-resource-isolation] keeps two active sessions and rejects a copied binding without cross-session side effects', async () => {
  const a = await mcpWorkFixture();
  const b = await mcpWorkFixture();
  try {
    const [left, right] = await Promise.all([
      openScopedConnection(a, { sessionId: 'session-alpha', invocationId: 'invocation-alpha', attemptId: 'attempt-alpha', toolName: 'alpha' }),
      openScopedConnection(b, { sessionId: 'session-beta', invocationId: 'invocation-beta', attemptId: 'attempt-beta', toolName: 'beta' }),
    ]);
    expect(left.plan.sessionId).toBe('session-alpha');
    expect(right.plan.sessionId).toBe('session-beta');
    expect(left.catalog.tools.map(tool => tool.name)).toHaveLength(1);
    expect(right.catalog.tools.map(tool => tool.name)).toHaveLength(1);
    expect(left.catalog.tools[0]!.name).toContain('alpha');
    expect(right.catalog.tools[0]!.name).toContain('beta');
    expect(left.catalog.tools[0]!.name).not.toContain('beta');
    expect(right.catalog.tools[0]!.name).not.toContain('alpha');
    expect(a.registrations[0]).toMatchObject({ sessionId: 'session-alpha', invocationId: 'invocation-alpha' });
    expect(b.registrations[0]).toMatchObject({ sessionId: 'session-beta', invocationId: 'invocation-beta' });
    expect(a.registrations[0]!.processIdentity.pid).not.toBe(b.registrations[0]!.processIdentity.pid);
    expect((await processRows()).filter(row => [a.registrations[0]!.processIdentity.pid, b.registrations[0]!.processIdentity.pid].includes(row.pid))).toHaveLength(2);

    const binding = left.catalog.resolve('mcp_alpha')!;
    const forged = { ...binding, sessionId: 'session-beta' };
    await expect(left.catalog.dispatch(forged, {}, undefined, 'forged-call')).rejects.toMatchObject({ reason: 'invalid_mapping' });
    expect(existsSync(join(a.box.path, 'call.entered'))).toBe(false);
    expect(existsSync(join(b.box.path, 'call.entered'))).toBe(false);

    const [alpha, beta] = await Promise.all([
      left.catalog.tools[0]!.execute('alpha-call', {}),
      right.catalog.tools[0]!.execute('beta-call', {}),
    ]);
    expect(alpha).toMatchObject({ content: [{ type: 'text', text: 'fake result' }], isError: false });
    expect(beta).toMatchObject({ content: [{ type: 'text', text: 'fake result' }], isError: false });
    expect(JSON.parse(readFileSync(join(a.box.path, 'call.entered'), 'utf8')).params.name).toBe('alpha');
    expect(JSON.parse(readFileSync(join(b.box.path, 'call.entered'), 'utf8')).params.name).toBe('beta');
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
}, 20_000);

it('[case:cross-session-cancellation] closes a hanging session while a second session remains callable and owned', async () => {
  const a = await mcpWorkFixture();
  const b = await mcpWorkFixture();
  const cancelled = new AbortController();
  try {
    const [left, right] = await Promise.all([
      openScopedConnection(a, { sessionId: 'session-hanging', invocationId: 'invocation-hanging', attemptId: 'attempt-hanging', toolName: 'shared', callMode: 'hang', signal: cancelled.signal }),
      openScopedConnection(b, { sessionId: 'session-healthy', invocationId: 'invocation-healthy', attemptId: 'attempt-healthy', toolName: 'shared' }),
    ]);
    const pending = left.catalog.tools[0]!.execute('hanging-call', {}, undefined);
    await waitForFakeMcpFile(join(a.box.path, 'call.entered'));
    cancelled.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'call_cancelled' });
    expect(await left.connection.close()).toMatchObject({ confirmed: true });
    expect(a.registry.list(a.registrations[0]!)).toEqual([]);
    expect(b.registry.list(b.registrations[0]!)).toHaveLength(1);
    const healthy = await right.catalog.tools[0]!.execute('healthy-call', {});
    expect(healthy).toMatchObject({ content: [{ type: 'text', text: 'fake result' }], isError: false });
    expect(b.registry.list(b.registrations[0]!)).toHaveLength(1);
    expect((await processRows()).some(row => row.pid === b.registrations[0]!.processIdentity.pid)).toBe(true);
    expect(JSON.parse(readFileSync(join(b.box.path, 'call.entered'), 'utf8')).params.name).toBe('shared');
    await right.connection.close();
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
}, 20_000);

it('[case:duplicate-start-and-close] reuses one real process for duplicate starts and makes close idempotent', async () => {
  const f = await mcpWorkFixture();
  try {
    const request = scopedRequest(f, 'session-dedup', 'invocation-dedup', 'attempt-dedup');
    const resolver = resolverFor(f, { toolName: 'echo' });
    const plan = await prepareMcpStartupPlan(request, { resolver });
    const server = plan.servers[0]!;
    const manager = createMcpStdioConnectionManager();
    const options = { ...f.assembly.mcp!, plan, server, handshakeTimeoutMs: 2_000, closeTimeoutMs: 500 };
    const [first, second] = await Promise.all([manager.start(options), manager.start(options)]);
    expect(first).toBe(second);
    expect(f.registrations).toHaveLength(1);
    expect((await processRows()).filter(row => row.pid === f.registrations[0]!.processIdentity.pid)).toHaveLength(1);
    const [closed, closedAgain] = await Promise.all([first.close(), first.close()]);
    expect(closed).toEqual(closedAgain);
    expect(closed.confirmed).toBe(true);
    expect(f.registry.list(f.registrations[0]!)).toEqual([]);
    expect(await manager.closeAll()).toEqual([closed]);
  } finally { await f.cleanup(); }
}, 20_000);

it.each([
  ['is-error', 'is_error' as const, 'normal' as const],
  ['server-exit', 'exit' as const, 'connection_closed' as const],
] as const)('[case:real-fault-%s] keeps result and process evidence consistent for a real server fault', async (_label, mode, expected) => {
  const f = await mcpWorkFixture();
  try {
    const opened = await openScopedConnection(f, { sessionId: `session-${mode}`, invocationId: `invocation-${mode}`, attemptId: `attempt-${mode}`, toolName: 'fault', callMode: mode });
    const result = opened.catalog.tools[0]!.execute(`${mode}-call`, {});
    if (mode === 'is_error') {
      await expect(result).resolves.toMatchObject({ isError: true, content: [{ type: 'text', text: 'fake result' }] });
    } else {
      await expect(result).rejects.toMatchObject({ reason: expected });
    }
    await opened.connection.close();
    expect(existsSync(join(f.box.path, 'call.entered'))).toBe(true);
    expect(f.registry.list(f.registrations[0]!)).toEqual([]);
    expect((await processRows()).some(row => row.pid === f.registrations[0]!.processIdentity.pid)).toBe(false);
  } finally { await f.cleanup(); }
}, 20_000);

it('[case:stop-evidence-missing] retains the real registration when process absence cannot be proven', async () => {
  const f = await mcpWorkFixture();
  try {
    const inspector = {
      identify: async (pid: number, launchId: string) => {
        const row = (await processRows()).find(candidate => candidate.pid === pid);
        if (!row) throw new Error('server disappeared');
        return { pid, processGroupId: row.processGroupId, startTime: row.startTime, launchId };
      },
      matches: async () => false,
      matchesGroup: async () => false,
      groupAbsent: async () => false,
    };
    const opened = await openScopedConnection(f, { sessionId: 'session-uncertain', invocationId: 'invocation-uncertain', attemptId: 'attempt-uncertain', toolName: 'uncertain', ignoreTerminate: true, processInspector: inspector });
    const stop = await opened.connection.close();
    expect(stop).toMatchObject({ confirmed: false, status: 'unconfirmed' });
    expect(f.registry.list(f.registrations[0]!)).toHaveLength(1);
    expect((await processRows()).some(row => row.pid === f.registrations[0]!.processIdentity.pid)).toBe(true);
  } finally { await f.cleanup(); }
}, 20_000);
