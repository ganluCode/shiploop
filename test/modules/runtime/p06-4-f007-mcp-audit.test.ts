import { McpAbortError, McpConnectionClosedError, McpError, McpTimeoutError } from '@earendil-works/pi-mcp';
import { describe, expect, it } from 'vitest';
import type { RuntimeEventPayload } from '../../../packages/core/src/ports/runtime-execution.ts';
import { createMcpRuntimeAudit } from '../../../packages/host/src/runtime/mcp-runtime-audit.ts';
import { createMcpToolCatalog, type McpToolEndpoint } from '../../../packages/host/src/runtime/mcp-tool-catalog.ts';
import type { McpStartupPlan, McpStartupServerPlan } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';

const SECRET = 'synthetic-resolved-mcp-credential';
const mapping = { resourceId: 'server-1', sourceRef: 'source-1', originalName: 'echo', piName: 'mcp_echo' };
const server: McpStartupServerPlan = { resourceId: 'server-1', sourceRef: 'source-1', sourceRevision: 'r1', version: null,
  contentDigest: null, environmentRefs: ['credential-env'], credentialRef: null, executable: '/usr/bin/true', argv: [], cwd: '/tmp',
  environment: { MCP_TOKEN: SECRET }, allowedTools: ['echo'], approvalDigest: 'approved', tools: [mapping] };
const auditPlan: McpStartupPlan = { schemaVersion: 1, projectId: 'project-1', sessionId: 'session-1', attemptId: 'attempt-1',
  invocationId: 'invocation-1', executionVersion: 7, resourceSnapshotDigest: 'snapshot', servers: [server], tools: [mapping], gaps: [], digest: 'plan' };

function setup(call: McpToolEndpoint['call'], extra: Partial<McpToolEndpoint> = {}) {
  const events: RuntimeEventPayload[] = [];
  let stops = 0;
  const audit = createMcpRuntimeAudit({ plan: auditPlan, publish: payload => { events.push(payload); return true; },
    requestStop: () => { stops++; } });
  return { events, audit, stops: () => stops, catalog: () => createMcpToolCatalog({ plan: auditPlan, audit, endpoints: [{ server,
    discover: async () => [{ name: 'echo', inputSchema: { type: 'object' } }], call, ...extra }] }) };
}

function body(payload: RuntimeEventPayload): Record<string, unknown> {
  if (payload.kind === 'tool_started') return JSON.parse(payload.input!);
  if (payload.kind === 'tool_finished') return JSON.parse(payload.output!);
  if (payload.kind === 'message') return JSON.parse(payload.text!);
  throw new Error('not a structured audit body');
}

describe('P06-4 F-007 MCP structured audit', () => {
  it('[case:correlated-redacted-deduplicated-call] records a single start/end with execution identity and redacts before Pi/native persistence', async () => {
    let calls = 0;
    const f = setup(async () => { calls++; return { content: [{ type: 'text', text: SECRET }], structuredContent: { [SECRET]: SECRET } }; });
    const catalog = await f.catalog();
    const first = await catalog.tools[0]!.execute('call-1', { credential: SECRET });
    expect(await catalog.tools[0]!.execute('call-1', { credential: SECRET })).toEqual(first);
    expect(calls).toBe(1);
    expect(f.events.map(event => event.kind)).toEqual(['tool_started', 'tool_finished']);
    expect(body(f.events[0]!)).toMatchObject({ schemaVersion: 1, projectId: 'project-1', sessionId: 'session-1',
      serverId: 'server-1', invocationId: 'invocation-1', toolCallId: 'call-1', executionVersion: 7, phase: 'started' });
    expect(body(f.events[1]!)).toMatchObject({ phase: 'finished', reason: null, coverage: 'complete' });
    expect(JSON.stringify([f.events, first])).not.toContain(SECRET);
    expect(Object.isFrozen(first)).toBe(true);
    await expect(catalog.tools[0]!.execute('call-1', { changed: true })).rejects.toMatchObject({ reason: 'audit_identity_conflict' });
    expect(calls).toBe(1);
  });

  it.each([
    ['protocol', { code: 'protocol_error' }, 'response_lost'], ['rpc', new McpError(-32603, SECRET), 'json_rpc_error'],
    ['timeout', new McpTimeoutError(1), 'call_timeout'], ['cancel', new McpAbortError(), 'call_cancelled'],
    ['exit', new McpConnectionClosedError(), 'connection_closed'], ['exception', new Error(SECRET), 'call_failed'],
  ] as const)('[case:terminal-%s] retains a safe reason and never repeats a failed side effect', async (_name, error, reason) => {
    let calls = 0; const f = setup(async () => { calls++; throw error; }); const catalog = await f.catalog();
    for (let i = 0; i < 2; i++) await expect(catalog.tools[0]!.execute('failed-call', {})).rejects.toMatchObject({ reason });
    expect(calls).toBe(1); expect(f.events.map(event => event.kind)).toEqual(['tool_started', 'tool_finished']);
    expect(body(f.events[1]!)).toMatchObject({ reason, toolCallId: 'failed-call', executionVersion: 7 });
    expect(JSON.stringify(f.events)).not.toContain(SECRET);
  });

  it('[case:denied-and-is-error] audits authorization rejection and MCP isError without converting either into Runtime success', async () => {
    let calls = 0; const denied = setup(async () => { calls++; return {}; }, { authorize: () => { throw new Error(SECRET); } });
    const catalog = await denied.catalog(); await expect(catalog.tools[0]!.execute('denied', {})).rejects.toMatchObject({ reason: 'unauthorized_call' });
    expect(body(denied.events[1]!)).toMatchObject({ reason: 'unauthorized_call' }); expect(calls).toBe(0);
    const failedTool = setup(async () => ({ content: [{ type: 'text', text: SECRET }], isError: true })); const other = await failedTool.catalog();
    await expect(other.tools[0]!.execute('is-error', {})).resolves.toMatchObject({ isError: true });
    expect(body(failedTool.events[1]!)).toMatchObject({ reason: 'mcp_tool_error', content: { isError: true } });
    expect(JSON.stringify([denied.events, failedTool.events])).not.toContain(SECRET);
  });

  it('[case:bounded-result-gap-and-successor-block] retains omission coverage and requests stop for a long result', async () => {
    const f = setup(async () => ({ content: [{ type: 'text', text: 'x'.repeat(6000) }] })); const catalog = await f.catalog();
    await catalog.tools[0]!.execute('long', {}); expect(f.stops()).toBe(1);
    expect(f.events.map(event => event.kind)).toEqual(['tool_started', 'diagnostic', 'tool_finished']);
    expect(body(f.events[2]!)).toMatchObject({ coverage: 'partial', gap: 'mcp_content_omitted', content: null });
    expect(f.events.every(event => Buffer.byteLength(JSON.stringify(event)) < 8192)).toBe(true);
    await expect(catalog.tools[0]!.execute('next', {})).rejects.toMatchObject({ reason: 'audit_unavailable' });
  });

  it('[case:audit-admission-failure] rejects a broken Recorder channel before side effects and never echoes its exception', async () => {
    for (const publish of [() => false, () => { throw new Error(SECRET); }]) {
      let stops = 0, calls = 0; const audit = createMcpRuntimeAudit({ plan: auditPlan, publish, requestStop: () => { stops++; } });
      const catalog = await createMcpToolCatalog({ plan: auditPlan, audit, endpoints: [{ server,
        discover: async () => [{ name: 'echo', inputSchema: { type: 'object' } }], call: async () => { calls++; return {}; } }] });
      await expect(catalog.tools[0]!.execute('blocked', {})).rejects.toMatchObject({ reason: 'audit_unavailable', message: 'MCP audit audit_unavailable' });
      await expect(catalog.tools[0]!.execute('later', {})).rejects.toMatchObject({ reason: 'audit_unavailable' }); expect(stops).toBe(1); expect(calls).toBe(0);
    }
  });

  it('[case:cached-result-preserves-authorization] refuses a copied binding even when its invocation id has a cached result', async () => {
    let calls = 0;
    const f = setup(async () => { calls++; return { content: [{ type: 'text', text: 'ok' }] }; });
    const catalog = await f.catalog();
    await catalog.tools[0]!.execute('cached', {});
    await expect(catalog.dispatch({ ...catalog.resolve('mcp_echo')! }, {}, undefined, 'cached'))
      .rejects.toMatchObject({ reason: 'audit_identity_conflict' });
    expect(calls).toBe(1);
    expect(f.events.filter(event => event.kind === 'tool_finished')).toHaveLength(1);
    expect(f.stops()).toBe(1);
  });

  it('[case:argument-fields-are-not-lifecycle-evidence] accepts legitimate arguments named stderr or evidence', async () => {
    const f = setup(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const catalog = await f.catalog();
    await catalog.tools[0]!.execute('ordinary-fields', { stderr: { truncated: true }, evidence: 'user-value' });
    expect(f.stops()).toBe(0);
    expect(body(f.events[0]!)).toMatchObject({ coverage: 'complete', content: { evidence: 'user-value' } });
  });

  it('[case:missing-native-identity-blocks-call] reports a coverage gap without inventing a call id or performing a side effect', async () => {
    let calls = 0;
    const f = setup(async () => { calls++; return {}; });
    const catalog = await f.catalog();
    await expect(catalog.dispatch(catalog.resolve('mcp_echo')!, {})).rejects.toMatchObject({ reason: 'audit_identity_missing' });
    expect(f.stops()).toBe(1);
    expect(calls).toBe(0);
    expect(f.events.map(event => event.kind)).toEqual(['diagnostic', 'message']);
    expect(body(f.events[1]!)).toMatchObject({ coverage: 'partial', toolCallId: null, reason: 'audit_identity_missing' });
  });

  it('[case:identity-scope-and-no-fabricated-call] rejects another generation and does not invent tool ids for lifecycle events', () => {
    const f = setup(async () => ({})); f.audit.lifecycle('server-1', 'starting', null); f.audit.lifecycle('server-1', 'starting', null);
    expect(f.events).toHaveLength(1); expect(body(f.events[0]!)).toMatchObject({ toolCallId: null, toolName: null, phase: 'starting' });
    expect(() => f.audit.assertPlan({ ...auditPlan, executionVersion: 8 })).toThrow('audit_identity_conflict'); expect(f.stops()).toBe(1);
  });
});
