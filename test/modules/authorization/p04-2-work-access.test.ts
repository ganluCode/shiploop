import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withTempSandbox } from '../../helpers/temp-sandbox.ts';
import * as core from '../../../packages/core/src/index.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const RESOURCE = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';
const identity = { purpose: 'work' as const, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' };
const binding = {
  projectId: PROJECT, identity, executionVersion: 1, invocationId: 'invocation-1',
  hostInstanceId: 'host-1', nowUtcMs: 2000,
  principal: core.createLocalOwnerPrincipal(),
  strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
};
function config() {
  return {
    schemaVersion: 1,
    context: {
      grantId: GRANT, projectId: PROJECT, identity: { ...identity },
      principalId: binding.principal.principalId, hostInstanceId: 'host-1',
      invocationId: 'invocation-1', executionVersion: 1,
      issuedAtUtcMs: 1000, expiresAtUtcMs: 3000,
      operations: ['task.read', 'candidate.submit'],
    },
    runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5',
    authentication: { kind: 'local_login', sourceRef: SOURCE, pluginId: null, environmentRefs: [] as string[] },
    resources: [{
      id: RESOURCE, kind: 'skill', sourceRef: SOURCE, version: '1.0.0',
      contentDigest: 'a'.repeat(64), required: false, onUnavailable: 'omit',
      capabilities: ['resource_selection'], transport: null, environmentRefs: [] as string[],
    }],
  };
}

describe('P04-2 Work 访问契约', () => {
  it('[case:manifest-stable] 由公共入口生成绑定执行身份的稳定脱敏 manifest', () => {
    const value = config();
    const manifest = core.buildWorkAccessManifest(value, binding);
    expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.access.context.identity).toEqual(identity);
    expect(manifest.access.authentication.sourceRef).toBe(SOURCE);
    const reordered = { ...value, context: { ...value.context, operations: [...value.context.operations].reverse() } };
    expect(core.buildWorkAccessManifest(reordered, binding)).toEqual(manifest);
    value.context.operations.push('evidence.submit');
    expect(core.buildWorkAccessManifest(value, binding).digest).not.toBe(manifest.digest);
    expect(manifest.access.context.operations).toEqual(['candidate.submit', 'task.read']);
  });

  it('[case:resource-order] 资源、能力与环境引用按身份规范化，模型或资源变更改变摘要', () => {
    const value = config();
    value.resources[0].capabilities.push('tool_interception');
    value.resources[0].environmentRefs = [SOURCE, RESOURCE];
    value.resources.push({ ...value.resources[0], id: SOURCE, kind: 'extension' });
    const first = core.buildWorkAccessManifest(value, binding);
    const reordered = structuredClone(value);
    reordered.resources.reverse();
    reordered.resources.forEach((r) => { r.environmentRefs.reverse(); r.capabilities.reverse(); });
    expect(core.buildWorkAccessManifest(reordered, binding)).toEqual(first);
    const body = { schemaVersion: first.schemaVersion, access: first.access, gaps: first.gaps };
    expect(first.digest).toBe(createHash('sha256')
      .update(`${core.WORK_ACCESS_DIGEST_DOMAIN}\n${core.stableStringify(body)}`, 'utf8').digest('hex'));
    reordered.model = 'provider/model-v2';
    expect(core.buildWorkAccessManifest(reordered, { ...binding, strategy: { ...binding.strategy, model: reordered.model } }).digest).not.toBe(first.digest);
    const changed = structuredClone(value);
    changed.resources[0].contentDigest = 'b'.repeat(64);
    expect(core.buildWorkAccessManifest(changed, binding).digest).not.toBe(first.digest);
  });

  it('[case:auth-plugin] 认证插件与普通扩展独立批准，凭据只使用引用', () => {
    const value = config();
    const plugin = { ...value.resources[0], kind: 'auth_plugin', required: true, onUnavailable: 'reject' };
    value.resources = [plugin, { ...value.resources[0], id: SOURCE, kind: 'extension' }];
    const candidate = { ...value, authentication: { kind: 'plugin', sourceRef: SOURCE, pluginId: RESOURCE, environmentRefs: [SOURCE] } };
    expect(core.validateWorkAccessConfiguration(candidate, binding).resources.map((r) => r.kind))
      .toEqual(['extension', 'auth_plugin']);
    expectReason({ ...candidate, authentication: { ...candidate.authentication, pluginId: GRANT } }, 'invalid_reference');
    expectReason({ ...candidate, resources: [{ ...plugin, required: false }] }, 'invalid_reference');
    expectReason({ ...candidate, resources: [{ ...plugin, kind: 'extension' }] }, 'invalid_reference');
    expectReason(value, 'invalid_reference');
    expect(core.validateWorkAccessConfiguration({ ...config(), authentication: {
      kind: 'environment', sourceRef: SOURCE, pluginId: null, environmentRefs: [RESOURCE],
    } }, binding).authentication.environmentRefs).toEqual([RESOURCE]);
  });

  it('[case:capability-gap] 显式可选缺口进入摘要，必需能力缺口拒绝而不静默降级', () => {
    const value = config();
    const gap = { resourceId: RESOURCE, capability: 'resource_selection', reason: 'unverified' };
    const manifest = core.buildWorkAccessManifest(value, binding, [gap]);
    expect(manifest.gaps).toEqual([gap]);
    expect(manifest.digest).not.toBe(core.buildWorkAccessManifest(value, binding).digest);
    expect(() => core.buildWorkAccessManifest(value, binding, [gap, gap])).toThrowError(expect.objectContaining({ reason: 'duplicate_identity' }));
    expect(() => core.buildWorkAccessManifest(value, binding, [{ ...gap, resourceId: SOURCE }]))
      .toThrowError(expect.objectContaining({ reason: 'invalid_reference' }));
    expect(() => core.buildWorkAccessManifest(value, binding, [{ ...gap, capability: 'mcp_stdio' }]))
      .toThrowError(expect.objectContaining({ reason: 'invalid_reference' }));
    expect(() => core.buildWorkAccessManifest(value, binding, [{ ...gap, reason: 'arbitrary diagnostic' }]))
      .toThrowError(expect.objectContaining({ reason: 'invalid_value' }));
    value.resources[0].onUnavailable = 'reject';
    expect(() => core.buildWorkAccessManifest(value, binding, [gap]))
      .toThrowError(expect.objectContaining({ reason: 'capability_required' }));
    value.resources[0].required = true;
    expect(() => core.buildWorkAccessManifest(value, binding, [gap]))
      .toThrowError(expect.objectContaining({ reason: 'capability_required' }));
  });

  it('[case:mcp-transport] MCP 仅接受声明的传输，资源至少提供版本或内容摘要', () => {
    const value = config();
    const mcp = { ...value.resources[0], kind: 'mcp', transport: 'stdio', capabilities: ['mcp_stdio'] };
    expect(core.validateWorkAccessConfiguration({ ...value, resources: [mcp] }, binding).resources[0].transport).toBe('stdio');
    expect(core.validateWorkAccessConfiguration({ ...value, resources: [{ ...mcp, transport: 'streamable_http' }] }, binding).resources[0].transport).toBe('streamable_http');
    expectReason({ ...value, resources: [{ ...mcp, transport: 'sse' }] }, 'invalid_value');
    expectReason({ ...value, resources: [{ ...mcp, transport: null }] }, 'invalid_value');
    expectReason({ ...value, resources: [{ ...mcp, kind: 'skill' }] }, 'invalid_value');
    expectReason({ ...value, resources: [{ ...mcp, contentDigest: 'bad' }] }, 'invalid_value');
    expectReason({ ...value, resources: [{ ...mcp, version: undefined }] }, 'invalid_value');
    expect(core.validateWorkAccessConfiguration({ ...value, resources: [{ ...mcp, version: null }] }, binding).resources[0].contentDigest).toBe(mcp.contentDigest);
    expect(core.validateWorkAccessConfiguration({ ...value, resources: [{ ...mcp, contentDigest: null }] }, binding).resources[0].version).toBe('1.0.0');
    expectReason({ ...value, resources: [{ ...mcp, version: null, contentDigest: null }] }, 'invalid_value');
  });

  it('[case:required-context] 缺失任一授权身份、有效期或操作集合时拒绝，sessionId 不能授权', () => {
    for (const field of ['grantId', 'projectId', 'principalId', 'hostInstanceId', 'identity', 'invocationId', 'executionVersion', 'issuedAtUtcMs', 'expiresAtUtcMs', 'operations']) {
      const value: Record<string, unknown> = { ...config().context };
      delete value[field];
      expect(() => core.validateWorkAccessConfiguration({ ...config(), context: value }, binding), field)
        .toThrow(core.WorkAccessError);
    }
    for (const field of ['purpose', 'runId', 'taskId', 'attemptId']) {
      const work: Record<string, unknown> = { ...identity };
      delete work[field];
      expect(() => core.validateWorkAccessConfiguration({ ...config(), context: { ...config().context, identity: work } }, binding), field)
        .toThrow(core.WorkAccessError);
    }
    expectReason({ ...config(), context: { sessionId: 'native-1' } }, 'unknown_key');
    expectReason({ ...config(), context: { ...config().context, operations: [] } }, 'invalid_value');
    expectReason({ ...config(), context: { ...config().context, identity: { ...identity, purpose: 'chat' } } }, 'invalid_value');
  });

  it('[case:bound-identity] 逐项拒绝伪造 principal、跨项目、旧 Host/Run/Task/Attempt 和执行代次', () => {
    const context = config().context;
    const contexts = [
      { ...context, projectId: SOURCE }, { ...context, principalId: 'other' },
      { ...context, hostInstanceId: 'old-host' }, { ...context, invocationId: 'old-invocation' },
      { ...context, executionVersion: 2 },
      ...['runId', 'taskId', 'attemptId'].map((field) => ({ ...context, identity: { ...identity, [field]: 'other' } })),
    ];
    for (const changed of contexts) expectReason({ ...config(), context: changed }, 'identity_mismatch');
    const invisible = { ...binding, principal: {
      principalId: binding.principal.principalId, capabilities: new Set<core.AppCapability>(),
      projectScope: { kind: 'allowlist' as const, projectIds: [SOURCE] },
    } };
    expectReason({ ...config(), model: 'unapproved-model' }, 'identity_mismatch');
    expectReason({ ...config(), provider: 'unapproved-provider' }, 'identity_mismatch');
    expect(() => core.validateWorkAccessConfiguration(config(), invisible))
      .toThrowError(expect.objectContaining({ reason: 'identity_mismatch' }));
  });

  it('[case:validity] 拒绝未来、到期、倒置和超过一天的权限；到期边界不可用', () => {
    const value = config();
    for (const [nowUtcMs, reason] of [[999, 'not_yet_valid'], [3000, 'expired']] as const) {
      expect(() => core.validateWorkAccessConfiguration(value, { ...binding, nowUtcMs }))
        .toThrowError(expect.objectContaining({ reason }));
    }
    for (const expiresAtUtcMs of [1000, 999, 1001 + core.WORK_ACCESS_MAX_LIFETIME_MS]) {
      expectReason({ ...value, context: { ...value.context, expiresAtUtcMs } }, 'invalid_validity');
    }
    expect(core.validateWorkAccessConfiguration(value, { ...binding, nowUtcMs: 1000 })).toBeDefined();
    expectReason({ ...value, context: { ...value.context, executionVersion: NaN } }, 'invalid_value');
  });

  it('[case:fail-closed] 未知类型、操作、能力、重复身份和越界列表一律拒绝', () => {
    const value = config();
    expectReason({ ...value, resources: [{ ...value.resources[0], kind: 'global' }] }, 'unknown_resource');
    expectReason({ ...value, context: { ...value.context, operations: ['task.pass'] } }, 'unknown_operation');
    expectReason({ ...value, resources: [{ ...value.resources[0], capabilities: ['sandbox'] }] }, 'unknown_capability');
    expectReason({ ...value, resources: [value.resources[0], { ...value.resources[0], kind: 'extension' }] }, 'duplicate_identity');
    expectReason({ ...value, context: { ...value.context, operations: ['task.read', 'task.read'] } }, 'duplicate_identity');
    expectReason({ ...value, resources: Array(core.WORK_ACCESS_MAX_RESOURCES + 1).fill(value.resources[0]) }, 'limit_exceeded');
    expectReason({ ...value, authentication: { ...value.authentication, environmentRefs: Array(core.WORK_ACCESS_MAX_ENVIRONMENT_REFS + 1).fill(SOURCE) } }, 'limit_exceeded');
    expectReason({ ...value, authentication: { ...value.authentication, environmentRefs: [SOURCE, SOURCE] } }, 'duplicate_identity');
    expectReason({ ...value, provider: 'a'.repeat(129) }, 'limit_exceeded');
    expectReason({ ...value, schemaVersion: 2 }, 'invalid_value');
    expectReason(Object.assign(new Date(), value), 'invalid_shape');
    expectReason({ ...value, resources: [undefined] }, 'invalid_shape');
  });

  it('[case:secret-rejection] 合成密钥、Bearer、HOME、argv、prompt 和 SDK 配置均被拒绝且不回显', () => {
    const value = config();
    const secret = 'sk-secretSentinel-123456789';
    const contaminated = [
      { ...value, apiKey: secret }, { ...value, [secret]: 'value' },
      { ...value, argv: [secret] }, { ...value, prompt: secret }, { ...value, sdkConfig: { token: secret } },
      { ...value, authentication: { ...value.authentication, apiKey: secret } },
      { ...value, authentication: { ...value.authentication, sourceRef: secret } },
      { ...value, authentication: { ...value.authentication, sourceRef: `Bearer ${secret}` } },
      { ...value, authentication: { ...value.authentication, sourceRef: '/Users/private/.pi/auth.json' } },
      { ...value, resources: [{ ...value.resources[0], sourceRef: '~/skills/private' }] },
      { ...value, resources: [{ ...value.resources[0], path: '/home/private' }] },
      { ...value, resources: [{ ...value.resources[0], environmentRefs: [`KEY=${secret}`] }] },
      ...['provider', 'model'].map((field) => ({ ...value, [field]: secret })),
      { ...value, context: { ...value.context, principalId: `Bearer ${secret}` } },
    ];
    for (const candidate of contaminated) {
      try {
        core.buildWorkAccessManifest(candidate, binding);
        expect.fail('secret-bearing input was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(core.WorkAccessError);
        const failure = error as core.WorkAccessError;
        expect(core.WORK_ACCESS_REASONS).toContain(failure.reason);
        expect(failure.details).toEqual({ reason: failure.reason });
        const rendered = `${failure.stack} ${JSON.stringify(failure)}`;
        for (const forbidden of [secret, 'Bearer', '/Users/private', '/home/private', '~/skills/private']) {
          expect(rendered).not.toContain(forbidden);
        }
        expect(failure.cause).toBeUndefined();
      }
    }
    const good = JSON.stringify(core.buildWorkAccessManifest(value, binding));
    expect(good).not.toContain(secret);
    expect(good).not.toContain('HOME');
  });

  it('[case:public-entry] 干净进程在禁止 SDK、HTTP、ORM 的加载守卫下公开访问契约', () => {
    const child = fileURLToPath(new URL('../../helpers/runtime-recovery/public-entry-child.mjs', import.meta.url));
    const entry = fileURLToPath(new URL('../../../packages/core/src/index.ts', import.meta.url));
    withTempSandbox((root) => {
      const result = spawnSync(process.execPath, [child, 'load', entry], {
        cwd: root, env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root, NODE_NO_WARNINGS: '1' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expect.arrayContaining([
        'validateWorkAccessConfiguration', 'buildWorkAccessManifest', 'WorkAccessError',
      ]));
    }, { prefix: 'shiploop-work-access-' });
  });

  it('[case:unknown-nested] 所有层级拒绝未知键及访问器，不执行配置代码', () => {
    const value = config();
    for (const candidate of [
      { ...value, context: { ...value.context, actorId: 'owner' } },
      { ...value, context: { ...value.context, identity: { ...identity, sessionId: 'native' } } },
      { ...value, resources: [{ ...value.resources[0], privateConfig: {} }] },
    ]) expectReason(candidate, 'unknown_key');
    const withGetter = { ...value };
    Object.defineProperty(withGetter, 'provider', { enumerable: true, get() { throw new Error('secret'); } });
    expectReason(withGetter, 'invalid_shape');
    expectReason({ ...value, [Symbol('private')]: 'secret' }, 'unknown_key');
    expect(() => core.buildWorkAccessManifest(value, binding, [{
      resourceId: RESOURCE, capability: 'resource_selection', reason: 'unverified', secret: 'hidden',
    }])).toThrowError(expect.objectContaining({ reason: 'unknown_key' }));
  });
});

function expectReason(value: unknown, reason: core.WorkAccessReason): void {
  expect(() => core.validateWorkAccessConfiguration(value, binding))
    .toThrowError(expect.objectContaining({ reason }));
}
