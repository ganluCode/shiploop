import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { init, parse } from 'es-module-lexer';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const protocolPath = resolve(root, 'packages/core/src/protocol.ts');

async function runtimeEdges(file: string): Promise<string[]> {
  await init;
  const code = stripTypeScriptTypes(readFileSync(file, 'utf8'));
  const [imports] = parse(code);
  return imports.map((entry) => {
    expect(entry.n, `${file}: imports must be literal`).toBeTypeOf('string');
    return entry.n as string;
  });
}

describe('F-013 纯协议公共入口', () => {
  it('生产 exports 声明独立协议入口，不经 Core 根入口', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'));
    expect(manifest.exports['./protocol']).toEqual({
      types: './dist/protocol.d.ts', default: './dist/protocol.js',
    });
  });

  it('协议入口的整个运行时依赖闭包不加载服务/装配/存储/网络', async () => {
    const visited = new Set<string>();
    async function walk(file: string): Promise<void> {
      if (visited.has(file)) return;
      visited.add(file);
      expect(file).not.toMatch(/\/(?:application|adapters)\//);
      for (const specifier of await runtimeEdges(file)) {
        if (specifier.startsWith('node:')) {
          expect(['node:crypto', 'node:buffer', 'node:path']).toContain(specifier);
        } else {
          expect(specifier.startsWith('.')).toBe(true);
          await walk(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
        }
      }
    }
    await walk(protocolPath);
    expect(visited.size).toBeGreaterThan(1);
  });

  it('客户端只依赖协议子路径，不依赖 Core 根入口或其他子路径', () => {
    for (const name of ['app-client.ts', 'app-wire.ts']) {
      const source = readFileSync(resolve(root, 'packages/host/src/client', name), 'utf8');
      const imports = [...source.matchAll(/from\s+['"](shiploop-core[^'"]*)['"]/g)];
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.map((m) => m[1])).toEqual(imports.map(() => 'shiploop-core/protocol'));
    }
  });

  it('复用同一协议算法而非复制校验器；不导出服务或持久化能力', async () => {
    const protocol = await import('../packages/core/src/protocol.js');
    const core = await import('../packages/core/src/index.js');
    expect(protocol.computeCommandRequestDigest).toBe(core.computeCommandRequestDigest);
    expect(protocol.validateCommandEnvelope).toBe(core.validateCommandEnvelope);
    expect(protocol.validateWireCommandReceipt).toBe(core.validateWireCommandReceipt);
    expect(protocol.validateSettingsPayload).toBe(core.validateSettingsPayload);
    expect(protocol.SETTINGS_EXPORT_FORMAT_VERSION).toBe(core.SETTINGS_EXPORT_FORMAT_VERSION);
    expect(Object.keys(protocol).some((key) => /Service|Store|Assembly/.test(key))).toBe(false);
  });
});
