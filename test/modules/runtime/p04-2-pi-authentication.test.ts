import { describe, expect, it, vi } from 'vitest';
import { chmod, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { createPiAuthenticationCatalog, createPiEnvironmentAuthenticationSource, createPiLocalLoginAuthenticationSource,
  PI_AUTHENTICATION_MAX_FILE_BYTES } from '../../../packages/host/src/runtime/pi-authentication.ts';
import { buildWorkAccessManifest, createLocalOwnerPrincipal, createWorkAuthenticationPreflight } from '../../../packages/core/src/index.js';
import type { WorkAccessBinding, WorkAccessConfiguration } from '../../../packages/core/src/index.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const ENVIRONMENT = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';
const secret = 'sk-synthetic-sentinel-123456789';
const binding: WorkAccessBinding = {
  principal: createLocalOwnerPrincipal(), projectId: PROJECT, hostInstanceId: 'host-1',
  identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
  invocationId: 'invocation-1', executionVersion: 1, nowUtcMs: 2000,
  strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
};
function access(): WorkAccessConfiguration {
  return { schemaVersion: 1, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5',
    context: { grantId: GRANT, principalId: binding.principal.principalId, projectId: PROJECT,
      hostInstanceId: 'host-1', identity: binding.identity, invocationId: 'invocation-1', executionVersion: 1,
      issuedAtUtcMs: 1000, expiresAtUtcMs: 3000, operations: ['task.read'] },
    authentication: { kind: 'local_login', sourceRef: SOURCE, pluginId: null, environmentRefs: [] }, resources: [] };
}
function context() { return { nowUtcMs: 2000, signal: new AbortController().signal }; }

describe('Pi 显式认证适配', () => {
  it('[case:local-login-contract] SDK 1.0.4 的 API key/OAuth 格式在明确文件下 ready，不写锁或复制认证', async () => {
    const sandbox = createTempSandbox('shiploop-pi-auth-');
    try {
      expect(VERSION).toBe('1.0.4');
      const authPath = join(sandbox.path, 'auth.json');
      const source = createPiLocalLoginAuthenticationSource({ provider: 'anthropic', authPath });
      for (const credential of [
        { type: 'api_key' as const, key: secret },
        { type: 'oauth' as const, access: secret, refresh: 'synthetic-refresh', expires: 5000 },
      ]) {
        const data = { anthropic: credential };
        const body = JSON.stringify(data);
        await writeFile(authPath, body, { mode: 0o600 });
        expect(JSON.parse(body).anthropic).toEqual(credential);
        expect(await source.inspect(context())).toBe('ready');
        expect(await readFile(authPath, 'utf8')).toBe(body);
        expect(await readdir(sandbox.path)).toEqual(['auth.json']);
      }
    } finally { sandbox.cleanup(); }
  });

  it('[case:local-invalid] 未登录、登出、过期、损坏和不可解析引用明确拒绝，其他 provider 不兜底', async () => {
    const sandbox = createTempSandbox('shiploop-pi-auth-invalid-');
    try {
      const authPath = join(sandbox.path, 'auth.json');
      const source = createPiLocalLoginAuthenticationSource({ provider: 'anthropic', authPath });
      expect(await source.inspect(context())).toBe('missing');
      for (const [body, state] of [
        ['{}', 'missing'], [JSON.stringify({ openai: { type: 'api_key', key: secret } }), 'missing'],
        ['{invalid', 'invalid'], ['null', 'invalid'], ['[]', 'invalid'],
        [JSON.stringify({ anthropic: { type: 'oauth', access: secret, refresh: 'refresh', expires: 2000 } }), 'expired'],
        [JSON.stringify({ anthropic: { type: 'oauth', access: secret } }), 'invalid'],
        [JSON.stringify({ anthropic: { type: 'api_key', key: '' } }), 'missing'],
      ]) {
        await writeFile(authPath, body);
        expect(await source.inspect(context()), body).toBe(state);
      }
      for (const key of ['!echo never-run', '$UNAPPROVED_KEY', 'bad\nkey']) {
        await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api_key', key } }));
        await expect(source.inspect(context())).rejects.toMatchObject({ reason: 'credential_reference_unsupported' });
      }
      await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api_key', key: secret, env: { TOKEN: secret } } }));
      await expect(source.inspect(context())).rejects.toMatchObject({ reason: 'credential_reference_unsupported' });
      await writeFile(authPath, 'x'.repeat(PI_AUTHENTICATION_MAX_FILE_BYTES + 1));
      await expect(source.inspect(context())).rejects.toMatchObject({ reason: 'input_limit' });
      await symlink(authPath, join(sandbox.path, 'link.json'));
      await expect(createPiLocalLoginAuthenticationSource({ provider: 'anthropic', authPath: join(sandbox.path, 'link.json') }).inspect(context()))
        .rejects.toMatchObject({ reason: 'authentication_directory_denied' });
      await expect(createPiLocalLoginAuthenticationSource({ provider: 'anthropic', authPath: join(sandbox.path, 'missing', 'auth.json') }).inspect(context())).resolves.toBe('missing');
      expect(() => createPiLocalLoginAuthenticationSource({ provider: 'anthropic', authPath: '~/auth.json' })).toThrow();
    } finally { sandbox.cleanup(); }
  });

  it('[case:directory-permission] 认证目录不可写先于凭据读取失败，不把本地读取权限当模型请求授权', async () => {
    const sandbox = createTempSandbox('shiploop-pi-auth-permission-');
    try {
      const authPath = join(sandbox.path, 'auth.json');
      await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api_key', key: secret } }));
      await chmod(sandbox.path, 0o500);
      await expect(createPiLocalLoginAuthenticationSource({ provider: 'anthropic', authPath }).inspect(context()))
        .rejects.toMatchObject({ reason: 'authentication_directory_denied' });
    } finally { await chmod(sandbox.path, 0o700); sandbox.cleanup(); }
  });

  it('[case:environment-reference] 只读批准变量；不存在时不扫描环境，禁止 owner/Host token 引用', async () => {
    const read = vi.fn(() => secret as string | undefined);
    const source = createPiEnvironmentAuthenticationSource({ provider: 'anthropic', environmentRef: ENVIRONMENT,
      variableName: 'ANTHROPIC_API_KEY', readVariable: read });
    expect(await source.inspect(context())).toBe('ready');
    expect(read.mock.calls).toEqual([['ANTHROPIC_API_KEY']]);
    read.mockReturnValue(undefined);
    expect(await source.inspect(context())).toBe('missing');
    for (const variableName of ['SHIPLOOP_OWNER_TOKEN', 'OWNER_TOKEN', 'NEZHA_INVOCATION_ID', 'HOME', 'PATH', 'PI_AUTH_TOKEN']) {
      expect(() => createPiEnvironmentAuthenticationSource({ provider: 'anthropic', environmentRef: ENVIRONMENT, variableName })).toThrow();
    }
    const controller = new AbortController();
    controller.abort();
    await expect(source.inspect({ nowUtcMs: 2000, signal: controller.signal })).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('[case:offline-catalog] 锁定 SDK 的真实离线目录精确区分 provider 和 model 缺失', async () => {
    const catalog = createPiAuthenticationCatalog();
    for (const [provider, model, providerExists, modelExists] of [
      ['anthropic', 'claude-sonnet-4-5', true, true], ['missing-provider', 'm', false, false],
      ['anthropic', 'missing-model', true, false],
    ] as const) {
      const input = { ...access(), provider, model };
      const manifest = buildWorkAccessManifest(input, { ...binding, strategy: { runtime: 'pi', provider, model } });
      expect(await catalog(manifest, context().signal)).toEqual({ sdkVersion: '1.0.4', providerExists, modelExists, plugins: [] });
    }
  });

  it('[case:preflight-secret-boundary] 真实文件及离线 SDK 目录完成预检，合成秘密不进入 manifest、结果或日志', async () => {
    const sandbox = createTempSandbox('shiploop-pi-auth-end-to-end-');
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    try {
      const authPath = join(sandbox.path, 'approved-auth.json');
      await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api_key', key: secret } }));
      await writeFile(join(sandbox.path, 'unapproved-token.json'), 'unapproved-token-sentinel');
      const manifest = buildWorkAccessManifest(access(), binding);
      const service = createWorkAuthenticationPreflight({ sources: new Map([[SOURCE,
        createPiLocalLoginAuthenticationSource({ provider: 'anthropic', authPath })]]),
        authorize: async () => ({ state: 'active', sourceRead: true, modelRequest: true, policyDigest: manifest.digest }),
        catalog: createPiAuthenticationCatalog(), monotonicNow: () => 0 });
      const result = await service.check(access(), binding, manifest.digest);
      expect(result).toMatchObject({ status: 'ready', inference: 'unknown', source: { sourceRef: SOURCE } });
      const output = JSON.stringify({ manifest, result, logs: logs.map(log => log.mock.calls) });
      for (const forbidden of [secret, 'unapproved-token-sentinel', authPath, 'owner-token']) expect(output).not.toContain(forbidden);
      expect(logs.every(log => log.mock.calls.length === 0)).toBe(true);
      await writeFile(authPath, '{}');
      expect(await service.check(access(), binding, manifest.digest)).toMatchObject({ reason: 'authentication_missing' });
      expect(await readdir(sandbox.path)).toEqual(['approved-auth.json', 'unapproved-token.json']);
    } finally { logs.forEach(log => log.mockRestore()); sandbox.cleanup(); }
  });
});
