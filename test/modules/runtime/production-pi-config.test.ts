import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readProductionPiConfig, readProductionPiKey, readProductionPiCredential, parseProductionPiConfig } from '../../../packages/host/src/runtime/production-pi-config.js';

it('保留各模型独立的上下文、输出、图片输入、兼容开关和 thinkingLevelMap', () => {
  const config = { schemaVersion: 1, providers: [{ id: 'custom', models: ['small', 'large'], custom: {
    api: 'openai-responses', baseUrl: 'https://example.com/v1', contextWindow: 128000, maxTokens: 16384, reasoning: false,
    compat: { supportsDeveloperRole: false }, modelOverrides: {
      small: { name: 'Small', contextWindow: 256000, maxTokens: 16384, reasoning: true, input: ['text'], thinkingLevelMap: { off: null } },
      large: { name: 'Large', contextWindow: 1050000, maxTokens: 128000, reasoning: true, input: ['text', 'image'] },
    },
  } }] };
  expect(parseProductionPiConfig(config)).toEqual(config);
});

it('没有显式配置不启用 Pi；私有配置提供明确模型清单', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'production-pi-')));
  try {
    expect(readProductionPiConfig(root)).toBeUndefined();
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    const config = { schemaVersion: 1, providers: [{ id: 'ark-agentplan', models: ['ark-code-latest'] }] };
    writeFileSync(join(root, 'pi/runtime.json'), JSON.stringify(config), { mode: 0o600 });
    expect(readProductionPiConfig(root)).toEqual(config);
    chmodSync(join(root, 'pi/runtime.json'), 0o666);
    expect(() => readProductionPiConfig(root)).toThrow('production_pi_config_permissions');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('凭据仅从私有文件的指定 Provider 读取，不执行命令引用或回退到其他 Provider', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'production-pi-auth-')));
  try {
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    expect(() => readProductionPiKey(root, 'p')).toThrow('production_pi_auth_missing');
    writeFileSync(join(root, 'pi/auth.json'), JSON.stringify({ p: { type: 'api_key', key: 'offline-key' } }), { mode: 0o600 });
    expect(readProductionPiKey(root, 'p')).toBe('offline-key');
    expect(() => readProductionPiKey(root, 'other')).toThrow('production_pi_auth_missing');
    for (const auth of [{ type: 'api_key', key: '!shell' }, { type: 'api_key', key: '$ENV' },
      { type: 'api_key', key: 'value', env: 'ANY_KEY' }, { type: 'oauth', access: 'value' }]) {
      writeFileSync(join(root, 'pi/auth.json'), JSON.stringify({ p: auth }));
      expect(() => readProductionPiKey(root, 'p')).toThrow();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([
  { schemaVersion: 2, providers: [] },
  { schemaVersion: 1, providers: [] },
  { schemaVersion: 1, providers: [{ id: 'p', models: ['m'], apiKey: 'not-allowed' }] },
  { schemaVersion: 1, providers: [{ id: 'p', models: ['m', 'm'] }] },
  { schemaVersion: 1, providers: [{ id: 'p', models: ['m'] }, { id: 'p', models: ['m'] }] },
])('拒绝畸形或包含秘密的运行时配置 %#', config => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'production-pi-')));
  try {
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    writeFileSync(join(root, 'pi/runtime.json'), JSON.stringify(config), { mode: 0o600 });
    expect(() => readProductionPiConfig(root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('allows only builtin Codex subscription auth and never interprets it as a literal API key', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'production-codex-auth-')));
  try {
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    const credential = { type: 'oauth', access: 'offline-access', refresh: 'offline-refresh', expires: 10000, accountId: 'account' };
    writeFileSync(join(root, 'pi/auth.json'), JSON.stringify({ 'openai-codex': credential }), { mode: 0o600 });
    expect(readProductionPiCredential(root, 'openai-codex')).toEqual(credential);
    expect(() => readProductionPiKey(root, 'openai-codex')).toThrow();
    expect(() => parseProductionPiConfig({ schemaVersion: 1, providers: [{ id: 'openai-codex', models: ['model'],
      custom: { api: 'openai-responses', baseUrl: 'https://example.com', contextWindow: 1000, maxTokens: 100, reasoning: true } }] })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
