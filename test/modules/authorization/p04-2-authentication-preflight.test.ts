import { describe, expect, it, vi } from 'vitest';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/index.js';
import * as core from '../../../packages/core/src/index.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const GRANT = '44444444-4444-4444-8444-444444444444';
function fixture() {
  const binding: core.WorkAccessBinding = {
    principal: createLocalOwnerPrincipal(), projectId: PROJECT, hostInstanceId: 'host-1',
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1', executionVersion: 1, nowUtcMs: 2000,
    strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
  };
  const access: core.WorkAccessConfiguration = {
    schemaVersion: 1, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5',
    context: { grantId: GRANT, principalId: binding.principal.principalId, projectId: PROJECT,
      hostInstanceId: 'host-1', identity: binding.identity, invocationId: 'invocation-1', executionVersion: 1,
      issuedAtUtcMs: 1000, expiresAtUtcMs: 3000, operations: ['task.read'] },
    authentication: { kind: 'local_login', sourceRef: SOURCE, pluginId: null, environmentRefs: [] },
    resources: [],
  };
  const digest = core.buildWorkAccessManifest(access, binding).digest;
  const inspect = vi.fn<core.WorkAuthenticationSource['inspect']>(async () => 'ready');
  const authorize = vi.fn<core.WorkAuthenticationPreflightDependencies['authorize']>(async () => ({ state: 'active', policyDigest: digest, sourceRead: true, modelRequest: true }));
  const catalog = vi.fn<core.WorkAuthenticationPreflightDependencies['catalog']>(async () => ({ sdkVersion: '1.0.4', providerExists: true, modelExists: true, plugins: [] }));
  const source = { kind: 'local_login' as const, provider: 'anthropic', environmentRefs: [], inspect };
  const dependencies = { sources: new Map([[SOURCE, source]]), authorize, catalog, monotonicNow: () => 0 };
  return { access, binding, digest, source, inspect, authorize, catalog, dependencies };
}

describe('Work 认证与模型预检', () => {
  it('[case:ready-unknown] 获准来源 ready 绑定策略与 Work 身份，重复预检不声称推理成功', async () => {
    const f = fixture();
    const service = core.createWorkAuthenticationPreflight(f.dependencies);
    const result = await service.check(f.access, f.binding, f.digest);
    expect(result).toMatchObject({ status: 'ready', reason: null, authentication: 'ready', inference: 'unknown',
      policyDigest: f.digest, projectId: PROJECT, identity: f.binding.identity,
      provider: 'anthropic', model: 'claude-sonnet-4-5', source: { kind: 'local_login', sourceRef: SOURCE } });
    expect(await service.check(f.access, f.binding, f.digest)).toEqual(result);
    expect(f.inspect).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'expired', 'revoked', 'invalid'] as const)(
    '[case:auth-state-%s] 认证状态分别拒绝且不切换来源', async state => {
      const f = fixture();
      f.inspect.mockResolvedValue(state);
      const result = await core.createWorkAuthenticationPreflight(f.dependencies).check(f.access, f.binding, f.digest);
      expect(result).toMatchObject({ status: 'rejected', reason: `authentication_${state}`, authentication: state, inference: 'unknown' });
      expect(f.inspect).toHaveBeenCalledTimes(1);
    });

  it.each([
    ['grant_revoked', { state: 'revoked' }], ['source_access_denied', { sourceRead: false }],
    ['model_request_denied', { modelRequest: false }], ['policy_drift', { policyDigest: 'a'.repeat(64) }],
  ] as const)('[case:permission-%s] 权限独立校验并先于认证读取', async (reason, override) => {
    const f = fixture();
    f.authorize.mockResolvedValue({ state: 'active', policyDigest: f.digest, sourceRead: true, modelRequest: true, ...override });
    expect(await core.createWorkAuthenticationPreflight(f.dependencies).check(f.access, f.binding, f.digest))
      .toMatchObject({ status: 'rejected', reason, inference: 'unknown' });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.catalog).not.toHaveBeenCalled();
  });

  it('[case:drift-before-io] 批准摘要或身份漂移先于所有 I/O 拒绝', async () => {
    const f = fixture();
    const service = core.createWorkAuthenticationPreflight(f.dependencies);
    expect(await service.check(f.access, f.binding, 'a'.repeat(64))).toMatchObject({ reason: 'policy_drift' });
    await expect(service.check(f.access, { ...f.binding, executionVersion: 2 }, f.digest)).rejects.toMatchObject({ reason: 'identity_mismatch' });
    await expect(service.check({ ...f.access, apiKey: 'sk-sentinel' }, f.binding, f.digest)).rejects.toMatchObject({ reason: 'unknown_key' });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it.each([
    ['sdk_version_incompatible', { sdkVersion: '0.84.2' }],
    ['provider_missing', { providerExists: false }], ['model_missing', { modelExists: false }],
    ['policy_drift', { plugins: [{ id: SOURCE, sourceRef: SOURCE, version: '1.0.0', contentDigest: null }] }],
  ] as const)('[case:catalog-%s] 精确核对 SDK、provider/model 与额外认证依赖', async (reason, override) => {
    const f = fixture();
    f.catalog.mockResolvedValue({ sdkVersion: '1.0.4', providerExists: true, modelExists: true, plugins: [], ...override });
    expect(await core.createWorkAuthenticationPreflight(f.dependencies).check(f.access, f.binding, f.digest))
      .toMatchObject({ status: 'rejected', reason });
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it('[case:source-selection] 只解析明确来源及环境引用，不回退其他登录', async () => {
    const f = fixture();
    f.dependencies.sources.clear();
    expect(await core.createWorkAuthenticationPreflight(f.dependencies).check(f.access, f.binding, f.digest)).toMatchObject({ reason: 'source_missing' });
    for (const override of [{ provider: 'openai' }, { kind: 'environment' as const }, { environmentRefs: [GRANT] }]) {
      const sources = new Map([[SOURCE, { ...f.dependencies.sources.get(SOURCE), ...f.source, ...override }]]);
      expect(await core.createWorkAuthenticationPreflight({ ...f.dependencies, sources }).check(f.access, f.binding, f.digest))
        .toMatchObject({ reason: 'source_mismatch' });
    }
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it('[case:auth-plugin-validation] 必需认证插件必须匹配实际 ID、来源、版本和内容', async () => {
    const f = fixture();
    const plugin = { id: SOURCE, sourceRef: SOURCE, version: '1.0.0', contentDigest: 'a'.repeat(64) };
    const access: core.WorkAccessConfiguration = { ...f.access,
      authentication: { ...f.access.authentication, kind: 'plugin', pluginId: SOURCE },
      resources: [{ ...plugin, kind: 'auth_plugin', required: true, onUnavailable: 'reject', capabilities: ['auth_plugin'], transport: null, environmentRefs: [] }] };
    const digest = core.buildWorkAccessManifest(access, f.binding).digest;
    f.authorize.mockResolvedValue({ state: 'active', policyDigest: digest, sourceRead: true, modelRequest: true });
    const service = core.createWorkAuthenticationPreflight({ ...f.dependencies,
      sources: new Map([[SOURCE, { ...f.source, kind: 'plugin' }]]) });
    for (const [plugins, reason] of [
      [[], 'plugin_missing'], [[{ ...plugin, version: '2.0.0' }], 'plugin_version_incompatible'],
      [[{ ...plugin, sourceRef: GRANT }], 'policy_drift'], [[{ ...plugin, contentDigest: null }], 'policy_drift'],
      [[plugin], null],
    ] as const) {
      f.catalog.mockResolvedValue({ sdkVersion: '1.0.4', providerExists: true, modelExists: true, plugins });
      expect(await service.check(access, f.binding, digest)).toMatchObject({ reason });
    }
    f.catalog.mockRejectedValue(new Error('sk-plugin-secret'));
    const rejected = await service.check(access, f.binding, digest);
    expect(rejected.reason).toBe('plugin_error');
    expect(JSON.stringify(rejected)).not.toContain('sk-plugin-secret');
  });

  it('[case:recheck-current-grant] 读取后撤销、策略漂移和授权到期阻止返回 ready，重复调用不缓存成功', async () => {
    const f = fixture();
    const service = core.createWorkAuthenticationPreflight(f.dependencies);
    expect((await service.check(f.access, f.binding, f.digest)).status).toBe('ready');
    f.authorize.mockResolvedValueOnce({ state: 'active', policyDigest: f.digest, sourceRead: true, modelRequest: true })
      .mockResolvedValueOnce({ state: 'revoked', policyDigest: f.digest, sourceRead: true, modelRequest: true });
    expect(await service.check(f.access, f.binding, f.digest)).toMatchObject({ status: 'rejected', reason: 'grant_revoked' });
    let elapsed = 0;
    f.inspect.mockImplementation(async () => { elapsed = 1000; return 'ready'; });
    const expiring = core.createWorkAuthenticationPreflight({ ...f.dependencies, monotonicNow: () => elapsed });
    expect(await expiring.check(f.access, f.binding, f.digest)).toMatchObject({ reason: 'grant_expired' });
  });

  it('[case:bounded-timeout] 未返回的读取有统一 deadline，取消信号传至来源并忽略晚到结果', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let signal: AbortSignal | undefined;
      let complete!: (value: core.WorkAuthenticationState) => void;
      f.inspect.mockImplementation(context => { signal = context.signal; return new Promise(resolve => { complete = resolve; }); });
      const pending = core.createWorkAuthenticationPreflight({ ...f.dependencies, timeoutMs: 50 }).check(f.access, f.binding, f.digest);
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;
      expect(result).toMatchObject({ status: 'rejected', reason: 'timeout', inference: 'unknown' });
      expect(signal?.aborted).toBe(true);
      complete('ready');
      expect(result.reason).toBe('timeout');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('[case:redacted-diagnostics] 异常正文、未知来源返回、SDK 版本和 owner token 不进入诊断', async () => {
    const f = fixture();
    const secret = 'sk-sentinel-secret owner-token /Users/private/auth.json';
    f.inspect.mockRejectedValue(new Error(secret));
    const service = core.createWorkAuthenticationPreflight(f.dependencies);
    const rejected = await service.check(f.access, f.binding, f.digest);
    expect(rejected.reason).toBe('source_error');
    expect(JSON.stringify(rejected)).not.toContain(secret);
    f.inspect.mockResolvedValue(secret as core.WorkAuthenticationState);
    expect((await service.check(f.access, f.binding, f.digest)).reason).toBe('source_error');
    f.catalog.mockResolvedValue({ sdkVersion: secret, providerExists: true, modelExists: true, plugins: [] });
    const version = await service.check(f.access, f.binding, f.digest);
    expect(version.sdkVersion).toBeNull();
    expect(JSON.stringify(version)).not.toContain(secret);
  });
});
