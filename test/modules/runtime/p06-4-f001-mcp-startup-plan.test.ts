import { describe, expect, it } from 'vitest';
import type { RuntimeExecutionRequest, RuntimeWorkAccessSnapshot } from '../../../packages/core/src/ports/runtime-execution.ts';
import {
  buildMcpStartupPlan,
  prepareMcpStartupPlan,
  type McpApprovedServerDefinition,
  type McpStartupPlanReason,
} from '../../../packages/host/src/runtime/mcp-startup-plan.ts';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const RESOURCE = '22222222-2222-4222-8222-222222222222';
const SKILL = '66666666-6666-4666-8666-666666666666';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);
const IDENTITY = { purpose: 'work' as const, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' };

function snapshot(): RuntimeWorkAccessSnapshot {
  return {
    schemaVersion: 1, projectId: PROJECT, runId: IDENTITY.runId, taskId: IDENTITY.taskId,
    attemptId: IDENTITY.attemptId, invocationId: 'invocation-1', executionVersion: 3,
    owner: { principalId: 'local-owner', hostInstanceId: 'host-1' },
    strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    permissions: { grants: [], isolation: 'trusted_project' }, grantId: 'grant-1', policyDigest: DIGEST,
    authentication: { status: 'ready', digest: DIGEST, sourceRef: SOURCE, kind: 'local_login' },
    resources: { digest: DIGEST, selectionRevision: 4, selectionDigest: DIGEST, loadManifestDigest: DIGEST, entries: [{
      id: RESOURCE, kind: 'mcp', name: 'local tools', sourceRef: SOURCE, sourceRevision: 'rev-1',
      version: '1.0.0', contentDigest: DIGEST, required: true, onUnavailable: 'reject', status: 'available',
      capabilities: ['mcp_stdio'], transport: 'stdio',
    }, {
      id: SKILL, kind: 'skill', name: 'approved skill', sourceRef: SOURCE, sourceRevision: 'rev-1',
      version: '1.0.0', contentDigest: DIGEST, required: false, onUnavailable: 'omit', status: 'available',
      capabilities: ['resource_selection'], transport: null,
    }] },
  };
}

function request(workAccess = snapshot()): RuntimeExecutionRequest {
  return {
    schemaVersion: 1, projectId: PROJECT, featureId: 'feature-1', sessionId: 'session-1', executionVersion: 3,
    owner: workAccess.owner, identity: IDENTITY, invocationId: 'invocation-1', strategy: workAccess.strategy,
    prompt: {} as RuntimeExecutionRequest['prompt'], inputManifest: {} as RuntimeExecutionRequest['inputManifest'],
    cwd: { root: 'workspace', relativePath: '.' }, permissions: workAccess.permissions,
    limits: { timeoutMs: 10_000, maxEvents: 100, maxOutputBytes: 100_000 }, recovery: { mode: 'new' }, workAccess,
  };
}

function approved(overrides: Partial<McpApprovedServerDefinition> = {}): McpApprovedServerDefinition {
  return {
    resourceId: RESOURCE, sourceRef: SOURCE, sourceRevision: 'rev-1', version: '1.0.0', contentDigest: DIGEST,
    environmentRefs: ['44444444-4444-4444-8444-444444444444'], credentialRef: 'credential:mcp-local',
    executable: '/tmp/shiploop-mcp', argv: ['--stdio'], cwd: '/tmp/shiploop-project',
    environment: { MCP_MODE: 'stdio' }, allowedTools: ['read-file', 'write-file'], ...overrides,
  };
}

function expectReason(action: () => unknown, reason: McpStartupPlanReason): void {
  expect(action).toThrowError(expect.objectContaining({ reason }));
}

describe('P06-4 F-001 MCP startup plan', () => {
  it('[case:approved-stdio-plan] only emits a bound stdio server and deterministic tool mappings', () => {
    const plan = buildMcpStartupPlan({ request: request(), approvedServers: [approved()] });
    expect(plan.projectId).toBe(PROJECT);
    expect(plan.sessionId).toBe('session-1');
    expect(plan.resourceSnapshotDigest).toBe(DIGEST);
    expect(plan.selectionRevision).toBe(4);
    expect(plan.servers).toHaveLength(1);
    expect(plan.servers[0]).toMatchObject({ resourceId: RESOURCE, executable: '/tmp/shiploop-mcp', argv: ['--stdio'] });
    expect(plan.tools.map(tool => tool.originalName)).toEqual(['read-file', 'write-file']);
    expect(plan.tools.every(tool => /^mcp_[a-f0-9]+_[a-z0-9_]+$/.test(tool.piName))).toBe(true);
    expect(plan.servers[0]?.allowedTools).toEqual(['read-file', 'write-file']);
  });

  it('[case:fail-closed-boundary] rejects missing access, missing server, empty authorization, and command secrets', () => {
    const noAccess = { ...request() } as Record<string, unknown>;
    delete noAccess.workAccess;
    expectReason(() => buildMcpStartupPlan({ request: noAccess as unknown as RuntimeExecutionRequest, approvedServers: [] }), 'missing_work_access');
    expectReason(() => buildMcpStartupPlan({ request: request(), approvedServers: [] }), 'missing_server');
    expectReason(() => buildMcpStartupPlan({ request: request(), approvedServers: [approved({ allowedTools: [] })] }), 'missing_tool_authorization');
    expectReason(() => buildMcpStartupPlan({ request: request(), approvedServers: [approved({ argv: ['sk-sentinel'] })] }), 'invalid_argv');
    expectReason(() => buildMcpStartupPlan({ request: request(), approvedServers: [approved({ environment: { HOME: '/private' } })] }), 'invalid_environment');
  });

  it('[case:bound-execution-identity] rejects a different invocation or execution version', () => {
    expectReason(() => buildMcpStartupPlan({ request: { ...request(), invocationId: 'other-invocation' }, approvedServers: [approved()] }), 'identity_mismatch');
    expectReason(() => buildMcpStartupPlan({ request: { ...request(), executionVersion: 4 }, approvedServers: [approved()] }), 'identity_mismatch');
  });

  it('[case:optional-transport-gap] records optional non-stdio resources without starting or translating them', () => {
    const access = structuredClone(snapshot()) as unknown as RuntimeWorkAccessSnapshot & { resources: { entries: unknown[] } };
    (access.resources.entries as unknown[])[0] = { ...((access.resources.entries as unknown[])[0] as object), transport: 'streamable_http', capabilities: ['mcp_streamable_http'], required: false, onUnavailable: 'omit' };
    const plan = buildMcpStartupPlan({ request: request(access), approvedServers: [] });
    expect(plan.servers).toEqual([]);
    expect(plan.gaps).toEqual([{ resourceId: RESOURCE, reason: 'unsupported_transport' }]);
    const required = structuredClone(access);
    (required.resources.entries as unknown[])[0] = { ...((required.resources.entries as unknown[])[0] as object), required: true, onUnavailable: 'reject' };
    expectReason(() => buildMcpStartupPlan({ request: request(required as unknown as RuntimeWorkAccessSnapshot), approvedServers: [] }), 'unsupported_transport');
  });

  it('[case:environment-reference-binding] rejects an environment reference changed after the approved snapshot', () => {
    const access = structuredClone(snapshot()) as unknown as RuntimeWorkAccessSnapshot & { resources: { entries: Array<Record<string, unknown>> } };
    access.resources.entries[0]!.environmentRefs = ['55555555-5555-4555-8555-555555555555'];
    expectReason(() => buildMcpStartupPlan({ request: request(access), approvedServers: [approved()] }), 'resource_identity_mismatch');
  });

  it('[case:tool-name-collision] rejects normalization and built-in collisions while retaining original names', () => {
    expectReason(() => buildMcpStartupPlan({ request: request(), approvedServers: [approved({ allowedTools: ['foo-bar', 'foo bar'] })] }), 'tool_name_collision');
    const valid = buildMcpStartupPlan({ request: request(), approvedServers: [approved()] });
    expectReason(() => buildMcpStartupPlan({ request: request(), approvedServers: [approved()], builtInToolNames: [valid.tools[0]!.piName] }), 'built_in_tool_collision');
  });

  it('[case:trusted-resolver] resolves only the selected resource and keeps the request binding in the plan', async () => {
    let resolved = 0;
    const plan = await prepareMcpStartupPlan(request(), { resolver: { resolve(input) {
      resolved += 1;
      expect(input.request.sessionId).toBe('session-1');
      expect(input.resource.id).toBe(RESOURCE);
      return approved();
    } } });
    expect(resolved).toBe(1);
    expect(plan.attemptId).toBe(IDENTITY.attemptId);
    expect(plan.invocationId).toBe('invocation-1');
  });
});
