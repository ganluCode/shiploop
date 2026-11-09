import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { expect, it, beforeAll } from 'vitest';
import { runHostStartEntry } from '../../../packages/host/src/runtime/start-entry.ts';
import { connectToHost } from '../../../packages/host/src/index.ts';

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60000 });
}, 65000);

it('标准 Host 入口从指定数据根装配 Pi，允许保存模型策略但启动本身不请求模型', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-production-pi-')));
  let host: Awaited<ReturnType<typeof runHostStartEntry>>['host'];
  const output: string[] = [];
  try {
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    writeFileSync(join(root, 'pi/runtime.json'), JSON.stringify({ schemaVersion: 1,
      providers: [{ id: 'zai-coding-cn', models: ['glm-5.3'] }] }), { mode: 0o600 });
    const outcome = await runHostStartEntry(['node', 'start.js', '--data-root', root], {
      stdout: line => output.push(line), stderr: line => output.push(line),
    });
    host = outcome.host;
    expect(outcome.exitCode, output.join('\n')).toBe(0);
    const client = await connectToHost({ canonicalRoot: root });
    try {
      const receipt = await client.submitCommand({ operation: 'settings.global.create', scope: { kind: 'global' },
        payload: { schemaVersion: 2, strategies: { modelMap: { medium: { runtime: 'pi', provider: 'zai-coding-cn', model: 'glm-5.3',
          credentialRef: 'credential://pi/zai-coding-cn' } } } } });
      expect(receipt.status, JSON.stringify(receipt)).toBe('completed');
    } finally { client.close(); }
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
