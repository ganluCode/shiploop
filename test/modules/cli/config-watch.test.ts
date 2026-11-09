import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, expect, it } from 'vitest';
import { startHost, connectToHost } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { watchProjectConfig } from '../../../packages/cli/src/config-watch.ts';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';

const projectId = 'acd37b04-391d-45e6-8f74-c6c472087bbb';
const payload = (model: string) => ({ schemaVersion: 2 as const, strategies: { modelMap: { medium: { runtime: 'pi', provider: 'p', model,
  credentialRef: 'credential://pi/p', fallbacks: [{ runtime: 'pi', provider: 'p', model: model === 'a' ? 'b' : 'a', credentialRef: 'credential://pi/p' }] } } } });
beforeAll(() => { execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60000 }); }, 65000);

it('watch 要求显式确认，默认读取项目根目录 shiploop.yaml', () => {
  expect(() => parseAppCliArgs(['config', 'watch', '--project', projectId], {})).toThrow();
  expect(parseAppCliArgs(['config', 'watch', '--project', projectId, '--confirm'], {})).toMatchObject({ commandId: 'config.watch', inputFile: 'shiploop.yaml' });
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'config-watch-'))), repo = join(root, 'repo');
  mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  const host = await startHost({ dataRoot: join(root, 'data'), env: {}, capabilityCatalog: createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'pi', providers: [{ providerId: 'p', models: ['a', 'b', 'c'] }] },
  ]) });
  const client = await connectToHost({ canonicalRoot: host.canonicalRoot });
  const receipt = await client.submitCommand({ operation: 'project.register', scope: { kind: 'registration' }, payload: { repositoryPath: repo, displayName: 'watch' } });
  if (receipt.status !== 'completed') throw new Error('registration_failed');
  const id = (receipt.result as { project: { id: string } }).project.id;
  const file = join(repo, 'shiploop.yaml');
  const events: { event: string; commandId?: string }[] = [];
  const stop = new AbortController();
  return { root, client, id, file, events, stop,
    watch: () => watchProjectConfig({ projectId: id, inputFile: file, client, json: true, signal: stop.signal, intervalMs: 10,
      io: { stdout: line => events.push(JSON.parse(line)), stderr: () => {} } }),
    async close() { stop.abort(); client.close(); await host.close(); rmSync(root, { recursive: true, force: true }); } };
}

it('首次创建、重复保存不写入、坏 YAML 保留旧值，修正后自动更新', async () => {
  const f = await fixture(); let running: ReturnType<typeof f.watch> | undefined;
  try {
    writeFileSync(f.file, 'schemaVersion: 2\nstrategies:\n  modelMap:\n    medium:\n      runtime: pi\n      model: p/a\n      fallbacks:\n        - runtime: pi\n          model: p/b\n'); running = f.watch();
    await expect.poll(() => f.events.filter(e => e.event === 'synced').length).toBe(1);
    writeFileSync(f.file, '# only comment changed\n' + JSON.stringify(payload('a')));
    await delay(60); expect((await f.client.getProjectSettings(f.id)).revision).toBe(1);
    expect((await f.client.getProjectSettings(f.id)).payload).toEqual(payload('a'));
    writeFileSync(f.file, 'schemaVersion: [');
    await expect.poll(() => f.events.some(e => e.event === 'invalid')).toBe(true);
    expect((await f.client.getProjectSettings(f.id)).revision).toBe(1);
    writeFileSync(f.file, JSON.stringify(payload('b')));
    await expect.poll(() => f.events.filter(e => e.event === 'synced').length).toBe(2);
    expect((await f.client.getProjectSettings(f.id)).payload).toEqual(payload('b'));
    f.stop.abort(); expect(await running).toBe(0);
  } finally { f.stop.abort(); await running; await f.close(); }
}, 30000);

it('其他客户端更新配置后停止并告警，不覆盖外部版本', async () => {
  const f = await fixture(); let running: ReturnType<typeof f.watch> | undefined;
  try {
    writeFileSync(f.file, JSON.stringify(payload('a'))); running = f.watch();
    await expect.poll(() => f.events.some(e => e.event === 'synced')).toBe(true);
    const external = await f.client.submitCommand({ operation: 'settings.project.update', scope: { kind: 'project', projectId: f.id },
      expectedRevision: 1, payload: payload('c') });
    expect(external.status).toBe('completed');
    await expect.poll(() => f.events.some(e => e.event === 'conflict')).toBe(true);
    expect(await running).toBe(1);
    expect(f.events.some(e => e.event === 'conflict')).toBe(true);
    expect((await f.client.getProjectSettings(f.id)).payload).toEqual(payload('c'));
  } finally { f.stop.abort(); await running; await f.close(); }
}, 30000);
