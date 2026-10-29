import { describe, expect, it } from 'vitest';
import { McpAbortError, McpConnectionClosedError, McpError, McpTimeoutError } from '@earendil-works/pi-mcp';
import {
  createMcpToolCatalog,
  MCP_CALL_LIMITS,
  type McpToolEndpoint,
} from '../../../packages/host/src/runtime/mcp-tool-catalog.ts';
import type { McpStartupPlan, McpStartupServerPlan } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';

const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const mapping = { resourceId: 'server-1', sourceRef: 'source-1', originalName: 'echo', piName: 'mcp_echo' };
const server: McpStartupServerPlan = {
  resourceId: 'server-1', sourceRef: 'source-1', sourceRevision: 'r1', version: null, contentDigest: null,
  environmentRefs: [], credentialRef: null, executable: '/usr/bin/true', argv: [], cwd: '/tmp', environment: {},
  allowedTools: ['echo'], approvalDigest: 'approved', tools: [mapping],
};
const plan: McpStartupPlan = {
  schemaVersion: 1, projectId: 'project-1', sessionId: 'session-1', attemptId: 'attempt-1', invocationId: 'invocation-1',
  executionVersion: 1, resourceSnapshotDigest: 'snapshot', servers: [server], tools: [mapping], gaps: [], digest: 'plan',
};

function endpoint(call: McpToolEndpoint['call']): McpToolEndpoint {
  return { server, discover: async () => [{ name: 'echo', description: 'Echo', inputSchema: schema }], call };
}

describe('P06-4 F-004 MCP dispatch', () => {
  it('[case:result-mapping-and-call-identity] maps supported MCP content and structuredContent to a Pi result', async () => {
    let context: unknown;
    const catalog = await createMcpToolCatalog({ plan, endpoints: [endpoint(async (_name, _args, _signal, callContext) => {
      context = callContext;
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { answer: 42 }, isError: false };
    })] });

    const result = await catalog.tools[0]!.execute('tool-call-7', { text: 'hello' }) as Record<string, unknown>;
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'ok' }], structuredContent: { answer: 42 }, details: { answer: 42 }, isError: false });
    expect(context).toMatchObject({ toolCallId: 'tool-call-7', projectId: 'project-1', sessionId: 'session-1', serverId: 'server-1', originalName: 'echo' });
  });

  it('[case:is-error-remains-tool-failure] keeps MCP isError as a Pi tool failure result', async () => {
    const catalog = await createMcpToolCatalog({ plan, endpoints: [endpoint(async () => ({
      content: [{ type: 'text', text: 'business failure' }], structuredContent: { code: 'denied' }, isError: true,
    }))] });
    await expect(catalog.tools[0]!.execute('call-error', { text: 'hello' })).resolves.toMatchObject({
      isError: true, structuredContent: { code: 'denied' }, content: [{ type: 'text', text: 'business failure' }],
    });
  });

  it.each([
    ['json-rpc-error', new McpError(-32603, 'private server error'), 'json_rpc_error'],
    ['timeout', new McpTimeoutError(10), 'call_timeout'],
    ['cancelled', new McpAbortError(), 'call_cancelled'],
    ['closed', new McpConnectionClosedError(), 'connection_closed'],
  ] as const)('[case:call-failure-%s] preserves a stable failure class and never retries', async (_name, thrown, reason) => {
    let calls = 0;
    const catalog = await createMcpToolCatalog({ plan, endpoints: [endpoint(async () => { calls++; throw thrown; })] });
    await expect(catalog.tools[0]!.execute('call-failure', { text: 'hello' })).rejects.toMatchObject({ reason });
    expect(calls).toBe(1);
  });

  it('[case:invalid-response-and-content] rejects malformed or unsupported MCP results before Pi conversion', async () => {
    for (const result of [
      { content: [{ type: 'text' }] },
      { content: [{ type: 'audio', data: 'x', mimeType: 'audio/wav' }] },
      { content: [{ type: 'text', text: 'ok' }], structuredContent: [] },
    ]) {
      const catalog = await createMcpToolCatalog({ plan, endpoints: [endpoint(async () => result)] });
      await expect(catalog.tools[0]!.execute('call-invalid', { text: 'hello' })).rejects.toMatchObject({
        reason: result.content[0]!.type === 'audio' ? 'unsupported_content' : 'invalid_response',
      });
    }
  });

  it('[case:bounded-concurrency-and-output] rejects a second pending call and overlarge results without replay', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const catalog = await createMcpToolCatalog({
      plan, maxConcurrentCalls: 1, endpoints: [endpoint(async () => {
        calls++;
        await pending;
        return { content: [{ type: 'text', text: 'ok' }] };
      })],
    });
    const first = catalog.tools[0]!.execute('first', { text: 'hello' });
    await expect(catalog.tools[0]!.execute('second', { text: 'hello' })).rejects.toMatchObject({ reason: 'concurrency_limit' });
    release();
    await first;
    expect(calls).toBe(1);

    const large = await createMcpToolCatalog({ plan, endpoints: [endpoint(async () => ({
      content: [{ type: 'text', text: 'x'.repeat(MCP_CALL_LIMITS.maxTextBytes + 1) }],
    }))] });
    await expect(large.tools[0]!.execute('large', { text: 'hello' })).rejects.toMatchObject({ reason: 'limit_exceeded' });
  });
});
