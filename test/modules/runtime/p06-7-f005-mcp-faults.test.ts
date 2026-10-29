import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMcpStdioConnection } from '../../../packages/host/src/runtime/mcp-stdio.ts';
import { prepareMcpStartupPlan } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';
import { mcpWorkFixture } from '../../helpers/p06-4/pi-mcp-fixture.ts';
import { waitForFakeMcpFile, type FakeMcpServerOptions } from '../../helpers/mcp-stdio-fake-server.ts';
import { processRows } from '../../helpers/process-matrix.ts';
import { saveResourceEvidence as evidence } from '../../helpers/p06-7/resource-scenario.ts';

it('[case:p06-f005-late-response] rejects a real response sent after cancellation without replaying the already issued call', async () => {
  const f = await mcpWorkFixture({ server: { callMode: 'late_on_cancel', spawnChild: true } });
  const cancelled = new AbortController();
  const plan = await prepareMcpStartupPlan(f.request, { resolver: f.assembly.mcp!.resolver });
  const connection = createMcpStdioConnection({ ...f.assembly.mcp!, plan, handshakeTimeoutMs: 2000, callTimeoutMs: 2000, closeTimeoutMs: 500 });
  try {
    const ready = await connection.start();
    expect(ready).toMatchObject({ protocolVersion: '2025-11-25', capabilities: { tools: {} } });
    const catalog = await connection.createToolCatalog();
    const call = catalog.tools[0]!.execute('cancelled-side-effect', {}, cancelled.signal)
      .then(result => ({ result, error: null }), error => ({ result: null, error }));
    await waitForFakeMcpFile(join(f.box.path, 'call.entered'));
    cancelled.abort();
    expect(await call).toMatchObject({ result: null, error: { reason: 'call_cancelled' } });
    await waitForFakeMcpFile(join(f.box.path, 'late.response'));
    expect(JSON.parse(readFileSync(join(f.box.path, 'call.entered'), 'utf8')).count).toBe(1);
    expect(JSON.parse(readFileSync(join(f.box.path, 'late.response'), 'utf8')).requestId)
      .toBe(JSON.parse(readFileSync(join(f.box.path, 'call.entered'), 'utf8')).id);
    const stop = await connection.close();
    expect(stop.confirmed).toBe(true);
    expect(f.registry.list(f.registrations[0]!)).toEqual([]);
    const rows = await processRows();
    expect(rows.some(row => row.processGroupId === f.registrations[0]!.processIdentity.processGroupId)).toBe(false);
    expect(rows.some(row => row.pid === Number(readFileSync(join(f.box.path, 'child.pid'), 'utf8')))).toBe(false);
    expect(existsSync(join(f.box.path, 'exit.json'))).toBe(true);
    evidence('late-response', { plan: { projectId: plan.projectId, sessionId: plan.sessionId, invocationId: plan.invocationId,
      tools: plan.tools, digest: plan.digest }, registration: f.registrations[0], stop,
      actualCall: JSON.parse(readFileSync(join(f.box.path, 'call.entered'), 'utf8')),
      lateResponse: JSON.parse(readFileSync(join(f.box.path, 'late.response'), 'utf8')), error: 'call_cancelled', calls: 1 });
  } finally { await connection.close(); await f.cleanup(); }
}, 15_000);

it.each([
  ['handshake-timeout', { mode: 'hang_initialize' }, 'handshake_timeout', undefined],
  ['protocol', { mode: 'invalid_protocol' }, 'incompatible_protocol', undefined],
  ['malformed-schema', { discoveryFile: 'tools.json' }, 'tool_discovery_failed', 'unsupported_schema'],
] as const)('[case:p06-f005-startup-%s] retains a stable startup failure and proves all acquired processes stopped', async (name, server, code, discoveryReason) => {
  const f = await mcpWorkFixture({ server: { ...server, spawnChild: true } });
  const plan = await prepareMcpStartupPlan(f.request, { resolver: f.assembly.mcp!.resolver });
  const connection = createMcpStdioConnection({ ...f.assembly.mcp!, plan,
    handshakeTimeoutMs: 200, callTimeoutMs: 500, closeTimeoutMs: 200 });
  try {
    if (name === 'malformed-schema') writeFileSync(join(f.box.path, 'tools.json'), JSON.stringify([
      { name: 'echo', inputSchema: { type: 'object', properties: { value: { $ref: 'file:///forbidden' } } } },
    ]));
    const failure = await connection.start().then(() => null, error => error);
    expect(failure).toMatchObject({ code, ...(discoveryReason ? { discoveryReason } : {}) });
    expect(f.registrations).toHaveLength(1);
    const stop = await connection.close();
    expect(stop.confirmed).toBe(true);
    expect(f.registry.list(f.registrations[0]!)).toEqual([]);
    expect((await processRows()).some(row => row.processGroupId === f.registrations[0]!.processIdentity.processGroupId)).toBe(false);
    expect(existsSync(join(f.box.path, 'call.entered'))).toBe(false);
    evidence(`startup-${name}`, { projectId: plan.projectId, sessionId: plan.sessionId, invocationId: plan.invocationId,
      error: { code: failure.code, discoveryReason: failure.discoveryReason ?? null }, registration: f.registrations[0], stop, calls: 0 });
  } finally { await connection.close(); await f.cleanup(); }
}, 15_000);

it.each([
  ['server-exit', 'exit', 'connection_closed'],
  ['call-timeout', 'hang', 'call_timeout'],
  ['output-limit', 'large_output', 'limit_exceeded'],
] as const)('[case:p06-f005-call-%s] fails a real call once, preserves its side-effect count and cleans descendants', async (name, callMode, reason) => {
  const f = await mcpWorkFixture({ server: { callMode: callMode satisfies FakeMcpServerOptions['callMode'], spawnChild: true } });
  const plan = await prepareMcpStartupPlan(f.request, { resolver: f.assembly.mcp!.resolver });
  const connection = createMcpStdioConnection({ ...f.assembly.mcp!, plan,
    handshakeTimeoutMs: 2000, callTimeoutMs: 200, closeTimeoutMs: 200, maxMessageBytes: 4 * 1024 * 1024 });
  try {
    await connection.start();
    const catalog = await connection.createToolCatalog();
    await expect(catalog.tools[0]!.execute('side-effect-once', {})).rejects.toMatchObject({ reason });
    const actualCall = JSON.parse(readFileSync(join(f.box.path, 'call.entered'), 'utf8'));
    expect(actualCall).toMatchObject({ count: 1, params: { name: 'echo' } });
    const stop = await connection.close();
    expect(stop.confirmed).toBe(true);
    expect(f.registry.list(f.registrations[0]!)).toEqual([]);
    expect((await processRows()).some(row => row.processGroupId === f.registrations[0]!.processIdentity.processGroupId)).toBe(false);
    evidence(`call-${name}`, { projectId: plan.projectId, sessionId: plan.sessionId, invocationId: plan.invocationId,
      error: reason, actualCall, registration: f.registrations[0], stop, exactlyOnceClaimed: false });
  } finally { await connection.close(); await f.cleanup(); }
}, 15_000);
