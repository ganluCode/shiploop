import { describe, expect, it } from 'vitest';
import * as core from '../../../packages/core/src/index.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const SKILL = '33333333-3333-4333-8333-333333333333';
const MCP = '44444444-4444-4444-8444-444444444444';
const EXTENSION = '55555555-5555-4555-8555-555555555555';
const GRANT = '66666666-6666-4666-8666-666666666666';
const identity = { purpose: 'work' as const, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' };
const binding = {
  projectId: PROJECT, identity, executionVersion: 1, invocationId: 'invocation-1',
  hostInstanceId: 'host-1', nowUtcMs: 2_000, principal: core.createLocalOwnerPrincipal(),
  strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
};

function config() {
  return {
    schemaVersion: 1,
    context: {
      grantId: GRANT, projectId: PROJECT, identity: { ...identity },
      principalId: binding.principal.principalId, hostInstanceId: 'host-1', invocationId: 'invocation-1',
      executionVersion: 1, issuedAtUtcMs: 1_000, expiresAtUtcMs: 3_000,
      operations: ['task.read'],
    },
    runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5',
    authentication: { kind: 'local_login', sourceRef: SOURCE, pluginId: null, environmentRefs: [] as string[] },
    resources: [
      {
        id: SKILL, kind: 'skill', sourceRef: SOURCE, version: '1.0.0', contentDigest: 'a'.repeat(64),
        required: false, onUnavailable: 'omit', capabilities: ['resource_selection'], transport: null, environmentRefs: [],
      },
      {
        id: MCP, kind: 'mcp', sourceRef: SOURCE, version: '2.0.0', contentDigest: 'b'.repeat(64),
        required: true, onUnavailable: 'reject', capabilities: ['mcp_stdio'], transport: 'stdio', environmentRefs: [],
      },
    ],
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    id: SKILL, kind: 'skill', sourceRef: SOURCE, version: '1.0.0', contentDigest: 'a'.repeat(64),
    capabilities: ['resource_selection'], transport: null, status: 'available', unavailableReason: null,
    ...overrides,
  };
}
function mcpObservation(overrides: Record<string, unknown> = {}) {
  return {
    id: MCP, kind: 'mcp', sourceRef: SOURCE, version: '2.0.0', contentDigest: 'b'.repeat(64),
    capabilities: ['mcp_stdio'], transport: 'stdio', status: 'available', unavailableReason: null,
    ...overrides,
  };
}
function expectReason(action: () => unknown, reason: core.WorkResourceSelectionReason): void {
  expect(action).toThrowError(expect.objectContaining({ reason }));
}

describe('P04-2 Work 项目资源选集与 manifest', () => {
  it('[case:explicit-selection] 计划只含批准资源并永久关闭三类隐式扫描', () => {
    const plan = core.selectWorkResources(config(), binding);
    expect(plan.selectedResourceIds).toEqual([SKILL, MCP]);
    expect(plan.resources.map((resource) => resource.id)).toEqual([SKILL, MCP]);
    expect(plan.allowGlobalScan).toBe(false);
    expect(plan.allowProjectDirectoryScan).toBe(false);
    expect(plan.allowSdkDefaultScan).toBe(false);
    expect(plan).not.toHaveProperty('command');
    expect(plan).not.toHaveProperty('environment');
    expect(plan).not.toHaveProperty('databasePath');
  });

  it('[case:manifest-available] 实际加载与批准身份和能力一致时生成稳定脱敏快照', () => {
    const result = core.assembleWorkResourceManifest(config(), binding, [observation(), mcpObservation()]);
    expect(result.resources.map((resource) => resource.id)).toEqual([SKILL, MCP]);
    expect(result.resources.every((resource) => resource.status === 'available')).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.differences).toEqual([]);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    const reversed = core.assembleWorkResourceManifest(config(), binding, [mcpObservation(), observation()]);
    expect(reversed).toEqual(result);
  });

  it('[case:optional-degradation] 可选资源明确不可用时继续并记录缺口、原因和差异', () => {
    const result = core.assembleWorkResourceManifest(config(), binding, [
      observation({ status: 'unavailable', unavailableReason: 'unsupported' }), mcpObservation(),
    ]);
    expect(result.resources[0].status).toBe('omitted');
    expect(result.gaps).toEqual([{ resourceId: SKILL, capability: 'resource_selection', reason: 'unsupported' }]);
    expect(result.differences).toEqual([{ kind: 'omitted_optional_resource', resourceId: SKILL, reason: 'unsupported' }]);
  });

  it('[case:required-failure] 必需资源或能力不可用时启动前拒绝', () => {
    expectReason(() => core.assembleWorkResourceManifest(config(), binding, [
      observation(), mcpObservation({ status: 'unavailable', unavailableReason: 'unverified' }),
    ]), 'required_unavailable');
    expectReason(() => core.assembleWorkResourceManifest(config(), binding, [
      observation(), mcpObservation({ capabilities: [] }),
    ]), 'required_capability_missing');
  });

  it('[case:actual-drift] 额外全局资源、缺少批准资源、身份漂移和能力扩大均拒绝', () => {
    expectReason(() => core.assembleWorkResourceManifest(config(), binding, [observation(), mcpObservation(), {
      ...observation(), id: EXTENSION, kind: 'extension',
    }]), 'unapproved_extension');
    expectReason(() => core.assembleWorkResourceManifest(config(), binding, [observation()]), 'missing_approved_resource');
    expectReason(() => core.assembleWorkResourceManifest(config(), binding, [
      observation({ sourceRef: GRANT }), mcpObservation(),
    ]), 'resource_identity_mismatch');
    expectReason(() => core.assembleWorkResourceManifest(config(), binding, [
      observation({ capabilities: ['resource_selection', 'tool_interception'] }), mcpObservation(),
    ]), 'unapproved_capability');
  });

  it('[case:transport-and-duplicates] 未知传输和重复身份 fail-closed', () => {
    expectReason(() => core.assembleWorkResourceManifest(config(), binding, [
      observation({ transport: 'sse' }), mcpObservation(),
    ]), 'unknown_transport');
    expectReason(() => core.assembleWorkResourceManifest(config(), binding, [observation(), observation(), mcpObservation()]), 'duplicate_identity');
    expectReason(() => core.assembleWorkResourceManifest(config(), binding, [{
      ...observation(), kind: 'global',
    }, mcpObservation()]), 'unknown_resource');
  });

  it('[case:public-entry] 资源选集通过 Core 公共入口提供且不要求 Pi SDK', () => {
    expect(core.buildWorkResourceLoadPlan(config(), binding).schemaVersion).toBe(1);
    expect(core.buildWorkResourceManifest(config(), binding, [observation(), mcpObservation()]).access.runtime).toBe('pi');
  });
});
