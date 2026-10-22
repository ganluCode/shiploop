/**
 * P04-8/F-002 离线验收共享隔离夹具。
 * 只使用真实临时 Git/SQLite/文件/Node 进程，不调用模型或网络。
 */
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createP048Fixture, type P048Fixture } from '../../../test/helpers/p04-8/index.ts';

// F-002 的公共测试选择由 index/phases/P04/features/P04-8/tasks/F-002.json 引用。
describe('P04-8 F-002 offline acceptance fixture', () => {
  let fixture: P048Fixture;

  beforeAll(() => {
    fixture = createP048Fixture({ prefix: 'shiploop-p04-8-f002-' });
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  it('为每个场景提供独立 Git、项目、SQLite 身份，并生成脱敏资源清单', () => {
    const first = fixture.createScenario('first', 'cloneA');
    const second = fixture.createScenario('second', 'cloneB');

    expect(first.gitRepositoryPath).not.toBe(second.gitRepositoryPath);
    expect(first.projectDirectory).not.toBe(second.projectDirectory);
    expect(first.sqlitePath).not.toBe(second.sqlitePath);
    expect(first.sqlite.pragmaSnapshot().foreignKeysEnabled).toBe(true);
    expect(first.sqlite.pragmaSnapshot().journalMode).toBe('wal');
    expect(first.sqlite.database.prepare('SELECT scenario_id FROM fixture_records').get()).toEqual({ scenario_id: 'first' });
    expect(second.sqlite.database.prepare('SELECT scenario_id FROM fixture_records').get()).toEqual({ scenario_id: 'second' });

    const manifest = fixture.manifest();
    expect(manifest.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'first:git', 'first:project', 'first:sqlite', 'first:home',
      'second:git', 'second:project', 'second:sqlite', 'second:home',
    ]));
    expect(JSON.stringify(manifest)).not.toContain(fixture.root);
    expect(JSON.stringify(manifest)).not.toContain(homedir());
    expect(JSON.stringify(manifest)).not.toContain('state.db' + fixture.root);
    expect(fixture.inner.evidence.serialize()).not.toContain(fixture.root);
    expect(fixture.inner.evidence.serialize()).not.toContain(homedir());
  });

  it('构造确定性的成功、非零失败、延迟和停止升级工具进程', async () => {
    const success = fixture.spawnTool('success');
    expect(await success.waitExit(2_000)).toMatchObject({ code: 0, signal: null });

    const failure = fixture.spawnTool('nonzeroExit', { args: ['7'] });
    expect(await failure.waitExit(2_000)).toMatchObject({ code: 7, signal: null });

    const delayed = fixture.spawnTool('hang');
    expect(await delayed.waitExit(20)).toBeNull();
    expect(delayed.isAlive()).toBe(true);
    const stop = await delayed.verifyStopped({ stepMs: 5 });
    expect(stop.escalated).toContain('SIGTERM');

    const ignoresTerm = fixture.spawnTool('ignoreSigterm');
    // The banner is emitted only after the SIGTERM handler has been installed.
    await expect.poll(() => ignoresTerm.stdout, { timeout: 2_000 }).toContain('sample-ignore-sigterm\n');
    const escalated = await ignoresTerm.verifyStopped({ stepMs: 100 });
    expect(escalated.escalated).toContain('SIGKILL');
    expect(escalated.signal).toBe('SIGKILL');
  });

  it('拒绝未知目录和符号链接逃逸，并保留清理失败证据', () => {
    expect(() => fixture.removeOwnedDirectory(tmpdir())).toThrow(/不在授权临时根/);
    expect(fixture.cleanupEvidence.status).toBe('unknown');
    expect(fixture.cleanupEvidence.failureKind).toBe('not_authorized');

    const owned = join(fixture.root, 'cleanup-check');
    const escape = join(owned, 'outside');
    mkdirSync(owned, { recursive: true });
    symlinkSync(tmpdir(), escape);

    expect(() => fixture.removeOwnedDirectory(owned)).toThrow(/符号链接逃逸/);
    expect(existsSync(owned)).toBe(true);
    expect(fixture.cleanupEvidence.status).toBe('unknown');
    expect(fixture.cleanupEvidence.failureKind).toBe('symlink_escape');

    unlinkSync(escape);
    fixture.removeOwnedDirectory(owned);
    expect(existsSync(owned)).toBe(false);
    expect(fixture.cleanupEvidence.status).toBe('passed');
  });

  it('使受控 HOME 和证据清单保持脱敏', () => {
    const scenario = fixture.createScenario('evidence', 'withHead');
    const env = fixture.inner.childEnv({ SYNTHETIC_TOKEN: 'fixture-token-should-not-leak' });
    expect(env.HOME).toBe(fixture.homeDir);
    expect(env.HOME).not.toBe(homedir());
    expect(env.TMPDIR).toContain(fixture.root);
    expect(fixture.inner.evidence.serialize()).not.toContain('fixture-token-should-not-leak');
    expect(fixture.manifest().find((entry) => entry.id === 'evidence:sqlite')?.relativePath).toBe('data/p04-8-evidence/state.db');
    expect(scenario.projectDirectory).toContain(join(fixture.root, 'projects'));
  });
});
