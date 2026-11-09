import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readSettingsFile } from '../../../packages/cli/src/config-file.ts';

const rootPayload = { schemaVersion: 2, strategies: { modelMap: { medium: { runtime: 'pi', provider: 'p', model: 'm',
  credentialRef: 'credential://pi/p', fallbacks: [{ runtime: 'pi', provider: 'p', model: 'backup', credentialRef: 'credential://pi/p' }] } } } };
const yaml = '# 可修改主备顺序\nschemaVersion: 2\nstrategies:\n  modelMap:\n    medium:\n      runtime: pi\n      provider: p\n      model: m\n      fallbacks:\n        - runtime: pi\n          provider: p\n          model: backup\n';

it('JSON 与带注释 YAML 解析为相同配置', () => {
  const root = mkdtempSync(join(tmpdir(), 'config-file-'));
  try {
    writeFileSync(join(root, 'shiploop.yaml'), yaml);
    writeFileSync(join(root, 'shiploop.json'), JSON.stringify(rootPayload));
    expect(readSettingsFile(join(root, 'shiploop.yaml'), 'config.create', true)).toEqual(rootPayload);
    expect(readSettingsFile(join(root, 'shiploop.json'), 'config.update', true)).toEqual(rootPayload);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(['schemaVersion: 2\nschemaVersion: 2', 'a: &base {x: 1}\nb: *base', 'x: !custom secret',
  '---\nschemaVersion: 2\n---\nschemaVersion: 2', 'schemaVersion: 2\nkey: [',
  'schemaVersion: 2\nstrategies:\n  defaultStrategy:\n    apiKey: secret'])('拒绝重复、别名、标签、多文档、畸形或秘密字段 %#', text => {
  const root = mkdtempSync(join(tmpdir(), 'config-file-'));
  try {
    const file = join(root, 'shiploop.yaml'); writeFileSync(file, text);
    expect(() => readSettingsFile(file, 'config.create', true)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
