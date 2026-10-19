import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as snapshot from '../../../scripts/acceptance/clean-snapshot-replay.ts';
import { runP03CleanReplay } from '../../../scripts/acceptance/p03-clean-replay.ts';

vi.mock('../../../scripts/acceptance/clean-snapshot-replay.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof snapshot>();
  return { ...actual, createCleanSnapshot: vi.fn(), runNpm: vi.fn(), killTrackedProcessGroups: vi.fn() };
});

const ok: snapshot.BoundedResult = {
  kind: 'exit', code: 0, signal: null, durationMs: 5, stdout: '', stderr: '', message: null,
};
let root: string;
let temp: string;
let out: string;
beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), 'shiploop-f018-unit-'));
  temp = mkdtempSync(join(tmpdir(), 'shiploop-p03-clean-'));
  const source = join(temp, 'snapshot');
  mkdirSync(source);
  out = join(root, 'evidence');
  vi.mocked(snapshot.createCleanSnapshot).mockResolvedValue({
    tempRoot: temp, snapshotRoot: source, commit: 'a'.repeat(40), branch: 'test',
    replacements: { repoRoot: root, snapshotRoot: source, homeDir: root, tempDir: temp },
  });
  vi.mocked(snapshot.runNpm).mockResolvedValue(ok);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});
const run = () => runP03CleanReplay({ root, outDir: out, log: () => {} });

describe('F-018 bounded controller (no real npm/test/phase invocation)', () => {
  it('[case:no-report-no-pass] zero process exit without a phase report never passes', async () => {
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.includes('report') || p.includes('报告'))).toBe(true);
    expect(existsSync(temp)).toBe(true);
    const cleanup = JSON.parse(readFileSync(join(out, 'cleanup-manifest.json'), 'utf8'));
    expect(cleanup.processesGone).toBe(false);
  });

  it('[case:failed-round-stops] first failed round does not launch a second phase run', async () => {
    await run();
    const calls = vi.mocked(snapshot.runNpm).mock.calls;
    expect(calls.map(c => c[1].join(' '))).toEqual(['ci', 'run build', expect.stringContaining('accept:p03')]);
    expect(calls[2]![3]).toBe(7_200_000);
  });

  it('[case:isolated-env] inherited npm lifecycle and prefix cannot redirect a snapshot run', async () => {
    vi.stubEnv('npm_config_local_prefix', root);
    vi.stubEnv('npm_config_prefix', root);
    vi.stubEnv('npm_package_json', join(root, 'package.json'));
    vi.stubEnv('npm_lifecycle_script', 'unsafe-original-script');
    vi.stubEnv('INIT_CWD', root);
    await run();
    for (const call of vi.mocked(snapshot.runNpm).mock.calls) {
      expect(call[2]).toBe(join(temp, 'snapshot'));
      expect(call[4].npm_config_local_prefix).toBeUndefined();
      expect(call[4].npm_config_prefix).toBeUndefined();
      expect(call[4].npm_package_json).toBeUndefined();
      expect(call[4].npm_lifecycle_script).toBeUndefined();
      expect(call[4].INIT_CWD).toBeUndefined();
    }
  });

  it('[case:preserve-progress] retains completed installation evidence if the next step throws', async () => {
    vi.mocked(snapshot.runNpm).mockResolvedValueOnce(ok).mockRejectedValueOnce(new Error('interrupted'));
    const result = await run();
    expect(result.ok).toBe(false);
    const preparation = JSON.parse(readFileSync(join(out, 'prepare.json'), 'utf8'));
    expect(preparation.steps.map((step: {id: string}) => step.id)).toEqual(['npm-ci']);
    const cleanup = JSON.parse(readFileSync(join(out, 'cleanup-manifest.json'), 'utf8'));
    expect(cleanup.processesGone).toBe(false);
    expect(cleanup.confirmed).toBe(false);
    expect(existsSync(temp)).toBe(true);
  });

  it('[case:no-overwrite] refuses a used evidence directory without overwriting old evidence', async () => {
    mkdirSync(out);
    writeFileSync(join(out, 'replay.json'), 'original');
    await expect(run()).rejects.toThrow(/empty|非空/);
    expect(readFileSync(join(out, 'replay.json'), 'utf8')).toBe('original');
    expect(snapshot.runNpm).not.toHaveBeenCalled();
  });

  it('[case:invalid-round] rejects an invalid round before any command or snapshot creation', async () => {
    await expect(runP03CleanReplay({ root, outDir: out, round: 3 as 1 })).rejects.toThrow(/round/);
    expect(snapshot.createCleanSnapshot).not.toHaveBeenCalled();
  });

  it('[case:cli-no-work] real CLI help and invalid arguments never start a replay', () => {
    const script = 'scripts/acceptance/p03-clean-replay.ts';
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 10_000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--round 1|2');
    const invalid = spawnSync(process.execPath, [script, '--round', '3'], { encoding: 'utf8', timeout: 10_000 });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain('--round');
  });
});
