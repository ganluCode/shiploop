import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMcpStdioConnection,
  type McpStdioConnection,
  type McpStdioProcessRegistration,
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

afterEach(async () => {
  for (const connection of connections.splice(0).reverse()) {
    const result = await connection.close();
    if (!result.confirmed && connection.processRegistration) {
      const group = connection.processRegistration.processIdentity.processGroupId;
      await until(async () => !(await processRows()).some(row => row.processGroupId === group), 'F-005 cleanup');
    }
  }
  for (const box of boxes.splice(0).reverse()) box.cleanup();
});

function box(): string {
  const created = createTempSandbox('shiploop-mcp-f005-');
  boxes.push(created);
  return created.path;
}

function plan(root: string, options: FakeMcpServerOptions = {}): McpStartupPlan {
  const command = createFakeMcpServerCommand(root, options);
  const server: McpStartupServerPlan = {
    resourceId: RESOURCE, sourceRef: SOURCE, sourceRevision: 'rev-1', version: '1.0.0', contentDigest: DIGEST,
    environmentRefs: [], credentialRef: null, executable: command.executable, argv: command.argv, cwd: root,
    environment: {}, allowedTools: ['echo'], approvalDigest: 'b'.repeat(64),
    tools: [{ resourceId: RESOURCE, sourceRef: SOURCE, originalName: 'echo', piName: 'mcp_echo' }],
  };
  return { schemaVersion: 1, projectId: PROJECT, sessionId: 'session-f005', attemptId: 'attempt-f005',
    invocationId: 'invocation-f005', executionVersion: 1, resourceSnapshotDigest: DIGEST,
    servers: [server], tools: server.tools, gaps: [], digest: 'c'.repeat(64) };
}

function registrar() {
  const values: McpStdioProcessRegistration[] = [];
  return { values, register: async (value: McpStdioProcessRegistration) => {
    values.push(value);
    return { launchId: value.processIdentity.launchId };
  } };
}

function connection(options: Parameters<typeof createMcpStdioConnection>[0]): McpStdioConnection {
  const result = createMcpStdioConnection(options);
  connections.push(result);
  return result;
}

async function startCall(root: string, options: FakeMcpServerOptions = {}, extra: Partial<Parameters<typeof createMcpStdioConnection>[0]> = {}) {
  const recorded = registrar();
  const c = connection({ plan: plan(root, options), registerProcess: recorded.register, closeTimeoutMs: 100, ...extra });
  await c.start();
  const catalog = await c.createToolCatalog();
  await waitForFakeMcpFile(join(root, 'tools.list'));
  return { c, catalog, recorded };
}

describe('P06-4 F-005 MCP absolute deadlines and cleanup', () => {
  it('[case:call-absolute-timeout-closes-owned-group] a hanging call times out once and closes the server group', async () => {
    const root = box();
    const { c, catalog, recorded } = await startCall(root, { callMode: 'hang' }, { callTimeoutMs: 150 });
    const pending = catalog.tools[0]!.execute('timeout-call', { });
    await waitForFakeMcpFile(join(root, 'call.entered'));
    const before = statSync(join(root, 'call.entered')).size;
    await expect(pending).rejects.toMatchObject({ reason: 'call_timeout' });
    expect(statSync(join(root, 'call.entered')).size).toBe(before);
    expect(c.state).toBe('failed');
    expect((await c.close()).confirmed).toBe(true);
    expect((await c.close()).confirmed).toBe(true);
    expect((await processRows()).some(row => row.processGroupId === recorded.values[0]!.processIdentity.processGroupId)).toBe(false);
  });

  it('[case:call-abort-closes-owned-group] caller cancellation interrupts MCP and proves owned process cleanup', async () => {
    const root = box();
    const { c, catalog, recorded } = await startCall(root, { callMode: 'hang' }, { callTimeoutMs: 2_000 });
    const controller = new AbortController();
    const pending = catalog.tools[0]!.execute('cancel-call', {}, controller.signal);
    await waitForFakeMcpFile(join(root, 'call.entered'));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'call_cancelled' });
    expect((await c.close()).confirmed).toBe(true);
    expect((await processRows()).some(row => row.processGroupId === recorded.values[0]!.processIdentity.processGroupId)).toBe(false);
  });

  it('[case:session-cancel-aborts-pending-call] session cancellation aborts a pending MCP call and closes its group', async () => {
    const root = box();
    const controller = new AbortController();
    const { c, catalog, recorded } = await startCall(root, { callMode: 'hang' }, {
      callTimeoutMs: 2_000, signal: controller.signal,
    });
    const pending = catalog.tools[0]!.execute('session-cancel', {});
    await waitForFakeMcpFile(join(root, 'call.entered'));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'call_cancelled' });
    expect((await c.close()).confirmed).toBe(true);
    expect((await processRows()).some(row => row.processGroupId === recorded.values[0]!.processIdentity.processGroupId)).toBe(false);
  });

  it('[case:leader-exit-cleans-descendant-group] a server leader exit still cleans its surviving controlled descendant', async () => {
    const root = box();
    const { c, recorded } = await startCall(root, { spawnChild: true, parentExitAfterInitializeMs: 250 });
    const childPid = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
    expect(childPid).toBeGreaterThan(1);
    expect((await processRows()).some(row => row.pid === childPid)).toBe(true);
    await until(() => c.state === 'failed', 'server leader exit');
    expect(c.error?.code).toBe('server_exited');
    expect((await c.close()).confirmed).toBe(true);
    expect((await processRows()).some(row => row.processGroupId === recorded.values[0]!.processIdentity.processGroupId)).toBe(false);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('[case:ignored-terminate-escalates] close escalates an MCP server that ignores SIGTERM and stops writing', async () => {
    const root = box();
    const { c, recorded } = await startCall(root, { ignoreTerminate: true });
    const sentinel = join(root, 'terminate.entered');
    await c.close();
    expect((await c.close()).confirmed).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
    expect((await processRows()).some(row => row.processGroupId === recorded.values[0]!.processIdentity.processGroupId)).toBe(false);
  });
});
