import { describe, expect, it } from 'vitest';
import * as core from '../../../packages/core/src/index.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const CREDENTIAL = 'credential:local-login';

function resource(overrides: Record<string, unknown> = {}) {
  const base = {
    projectId: PROJECT,
    sourceProjectId: PROJECT,
    kind: 'skill',
    name: 'project-guidance',
    sourceRef: SOURCE,
    sourceRevision: 'revision-1',
    version: '1.2.0',
    contentDigest: 'a'.repeat(64),
    transport: null,
    capabilities: ['resource_selection'],
    credentialRef: null,
    required: false,
    onUnavailable: 'omit',
  };
  const candidate = { ...base, ...overrides };
  return { ...candidate, id: core.deriveProjectResourceIdentity(candidate) };
}

function selection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: core.PROJECT_RESOURCE_SCHEMA_VERSION,
    projectId: PROJECT,
    revision: 3,
    resources: [resource()],
    operations: ['task.read', 'candidate.submit'],
    allowGlobalScan: false,
    allowProjectDirectoryScan: false,
    allowSdkDefaultScan: false,
    ...overrides,
  };
}

describe('P06-3 F-001 项目 Skills/MCP 资源契约', () => {
  it('[case:stable-identity-and-digest] 同一资源身份与摘要确定且只包含脱敏字段', () => {
    const candidate = core.validateProjectResourceCandidate({
      schemaVersion: core.PROJECT_RESOURCE_SCHEMA_VERSION,
      ...resource(),
      state: 'candidate',
    });
    const reordered = core.validateProjectResourceCandidate({
      state: 'candidate',
      ...resource(),
      schemaVersion: core.PROJECT_RESOURCE_SCHEMA_VERSION,
    });
    expect(candidate).toEqual(reordered);
    expect(candidate.id).toBe(core.deriveProjectResourceIdentity(resource()));
    expect(candidate.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(candidate)).not.toContain('apiKey');
    expect(JSON.stringify(candidate)).not.toContain('credential:local-login');
  });

  it('[case:state-separation] 候选、获准选择、实际加载和能力缺口保持不同状态', () => {
    const candidate = core.validateProjectResourceCandidate({
      schemaVersion: core.PROJECT_RESOURCE_SCHEMA_VERSION,
      ...resource(),
      state: 'candidate',
    });
    const approved = core.validateProjectResourceSelection(selection());
    const plan = core.buildProjectResourceLoadPlan(approved);
    const manifest = core.assembleProjectResourceLoadManifest(approved, [{
      ...resource(), status: 'available', unavailableReason: null, loadedCapabilities: ['resource_selection'],
    }]);
    expect(candidate.state).toBe('candidate');
    expect(approved.resources[0].id).toBe(candidate.id);
    expect(plan.resources[0].id).toBe(candidate.id);
    expect(plan.allowGlobalScan).toBe(false);
    expect(manifest.resources[0].status).toBe('available');
    expect(manifest.gaps).toEqual([]);
    expect(manifest).not.toHaveProperty('globalResources');
  });

  it('[case:fail-closed] 未知版本、类型、传输、重复身份、路径凭据和跨项目来源均结构化拒绝', () => {
    const candidate = () => core.validateProjectResourceCandidate({
      schemaVersion: core.PROJECT_RESOURCE_SCHEMA_VERSION,
      ...resource(), state: 'candidate',
    });
    expect(candidate).not.toThrow();
    for (const value of [
      { schemaVersion: 2, ...resource(), state: 'candidate' },
      { schemaVersion: 1, ...resource(), kind: 'extension', state: 'candidate' },
      { schemaVersion: 1, ...resource({ kind: 'mcp', transport: 'sse' }), state: 'candidate' },
      { schemaVersion: 1, ...resource({ credentialRef: '/Users/private/token' }), state: 'candidate' },
      { schemaVersion: 1, ...resource({ credentialRef: 'sk-secret-value' }), state: 'candidate' },
      { schemaVersion: 1, ...resource(), sourceProjectId: OTHER_PROJECT, state: 'candidate' },
    ]) {
      expect(() => core.validateProjectResourceCandidate(value)).toThrowError(
        expect.objectContaining({ reason: expect.any(String), details: expect.any(Object) }),
      );
    }
    expect(() => core.validateProjectResourceSelection(selection({ resources: [resource(), resource()] })))
      .toThrowError(expect.objectContaining({ reason: 'duplicate_identity' }));
  });

  it('[case:authorization-boundary] 只允许声明资源和公开操作，禁止审批、验收、增额、丢弃和 owner 能力', () => {
    const approved = core.validateProjectResourceSelection(selection());
    expect(approved.authorization.resourceIds).toEqual([approved.resources[0].id]);
    expect(approved.authorization.operations).toEqual(['candidate.submit', 'task.read']);
    for (const operation of ['plan.approve', 'task.verify', 'budget.increase', 'workspace.discard', 'owner.assume']) {
      expect(() => core.validateProjectResourceSelection(selection({ operations: [operation] })))
        .toThrowError(expect.objectContaining({ reason: 'unknown_operation' }));
    }
    expect(approved.authorization).not.toHaveProperty('principalId');
    expect(approved.authorization).not.toHaveProperty('owner');
  });

  it('[case:work-access-compatibility] 选择契约转换为既有 WorkAccess 身份和加载计划，revision 不冒充 Attempt 授权', () => {
    const approved = core.validateProjectResourceSelection(selection());
    const binding = {
      projectId: PROJECT,
      identity: { purpose: 'work' as const, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
      executionVersion: 1,
      invocationId: 'invocation-1',
      hostInstanceId: 'host-1',
      nowUtcMs: 2_000,
      principal: core.createLocalOwnerPrincipal(),
      strategy: { runtime: 'pi' as const, provider: 'anthropic', model: 'claude-sonnet-4-5' },
    };
    const access = core.toWorkAccessConfiguration(approved, {
      grantId: '44444444-4444-4444-8444-444444444444',
      issuedAtUtcMs: 1_000,
      expiresAtUtcMs: 3_000,
      binding,
    });
    const validated = core.validateWorkAccessConfiguration(access, binding);
    const plan = core.selectWorkResources(access, binding);
    expect(validated.resources[0]).toMatchObject({ id: approved.resources[0].id, sourceRef: SOURCE });
    expect(plan.resources[0].id).toBe(approved.resources[0].id);
    expect(access).not.toHaveProperty('revision');
    expect(access.context.identity).toEqual(binding.identity);
  });

  it('[case:load-gap] 必需能力缺口拒绝，可选缺口进入实际加载摘要', () => {
    const optional = core.validateProjectResourceSelection(selection());
    const optionalManifest = core.assembleProjectResourceLoadManifest(optional, [{
      ...resource(), status: 'unavailable', unavailableReason: 'unsupported', loadedCapabilities: [],
    }]);
    expect(optionalManifest.gaps[0]).toMatchObject({ resourceId: optional.resources[0].id, reason: 'unsupported' });
    const required = core.validateProjectResourceSelection(selection({
      resources: [resource({ required: true, onUnavailable: 'reject' })],
    }));
    expect(() => core.assembleProjectResourceLoadManifest(required, [{
      ...resource({ required: true, onUnavailable: 'reject' }),
      id: required.resources[0].id, status: 'unavailable', unavailableReason: 'unverified', loadedCapabilities: [],
    }])).toThrowError(expect.objectContaining({ reason: 'required_unavailable' }));
  });
});
