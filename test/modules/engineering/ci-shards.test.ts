import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHeavyShards, loadTestStages, planTestShards } from '../../../scripts/test-stages.ts';
import { verifyShardGate } from '../../../scripts/ci-shard-gate.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { fileURLToPath } from 'node:url';
import { commitAll, initGitRepo } from '../../helpers/git-repo.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const commit = 'a'.repeat(40);
const success = Object.fromEntries(['checks', 'heavy-1', 'heavy-2', 'heavy-3', 'heavy-4'].map(id => [id, { result: 'success' }]));

function fixture() {
  const box = createTempSandbox('shiploop-ci-shards-');
  cleanup.push(() => box.cleanup());
  const root = box.path, directory = join(root, 'reports');
  mkdirSync(join(root, 'test'));
  mkdirSync(directory);
  const files = Array.from({ length: 8 }, (_, i) => `test/f${i}.test.ts`);
  for (const file of files) writeFileSync(join(root, file), 'export {};');
  writeFileSync(join(root, 'test/stages.json'), JSON.stringify({ schemaVersion: 1, light: [], standard: [] }));
  writeFileSync(join(root, 'test/ci-timings.json'), JSON.stringify({ schemaVersion: 1, durationsMs: {} }));
  for (const [index, files] of loadHeavyShards(root, 4).entries()) {
    writeFileSync(join(directory, `heavy-${index + 1}.json`), JSON.stringify({ schemaVersion: 1, scope: 'heavy',
      fullSuiteRequested: false, commit, shard: { index: index + 1, total: 4 }, passed: true,
      outcomes: [{ stage: 'heavy', status: 'pass', exitCode: 0, signal: null, error: null, files }] }));
    writeFileSync(join(directory, `heavy-${index + 1}.json.vitest.json`), JSON.stringify({ success: true,
      numFailedTests: 0, numFailedTestSuites: 0, testResults: files.map(file => ({ name: `/runner/${file}`, status: 'passed' })) }));
  }
  const edit = (file: string, mutate: (report: any) => void) => {
    const path = join(directory, file);
    const report = JSON.parse(readFileSync(path, 'utf8'));
    mutate(report);
    writeFileSync(path, JSON.stringify(report));
  };
  return { root, directory, edit, verify: (needs: unknown = success) => verifyShardGate(root, directory, commit, needs) };
}

describe('independent CI shards', () => {
  it('balances duration deterministically and includes every current and new file exactly once', () => {
    const files = ['a', 'b', 'c', 'd', 'new'];
    const durations = { a: 100_000, b: 90_000, c: 20_000, d: 10_000 };
    const plan = planTestShards(files, 2, durations);
    expect(plan.flat().sort()).toEqual(files.sort());
    expect(planTestShards([...files].reverse(), 2, durations)).toEqual(plan);
    expect(() => planTestShards(['a', 'a'], 2, durations)).toThrow();
    expect(() => planTestShards(files, 0, durations)).toThrow();
    expect(() => planTestShards(files, 2, { a: -1 })).toThrow();
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const shards = loadHeavyShards(root, 4).flat();
    expect(shards.sort()).toEqual(loadTestStages(root).find(row => row.stage === 'heavy')!.files);
    expect(new Set(shards).size).toBe(shards.length);
  });

  it('passes only successful jobs with exact same-commit reports and actual Vitest file coverage', () => {
    const f = fixture();
    expect(() => f.verify()).not.toThrow();
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(() => f.verify({ ...success, 'heavy-1': { result } })).toThrow();
    }
    expect(() => f.verify({})).toThrow();
  });

  it('launches the real pinned Vitest with one worker, bail and actual JSON evidence', () => {
    const box = createTempSandbox('shiploop-ci-shard-launch-');
    cleanup.push(() => box.cleanup());
    const root = box.path;
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'test'));
    for (const name of ['run-tests.ts', 'test-stages.ts']) {
      writeFileSync(join(root, 'scripts', name), readFileSync(join(repository, 'scripts', name)));
    }
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'test/stages.json'), JSON.stringify({ schemaVersion: 1, light: [], standard: [] }));
    writeFileSync(join(root, 'test/ci-timings.json'), JSON.stringify({ schemaVersion: 1, durationsMs: {} }));
    const test = join(root, 'test/sample.test.ts');
    writeFileSync(test, "import { it, expect } from 'vitest'; it('works', () => expect(1).toBe(1));");
    initGitRepo(root);
    commitAll(root, 'fixture: shard launcher');
    const run = (report: string) => spawnSync(process.execPath, ['scripts/run-tests.ts', '--stage', 'heavy',
      '--shard', '1/1', '--stage-report', report], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    const good = join(root, 'reports/good.json');
    const passed = run(good);
    expect(passed.status, `${passed.stdout}\n${passed.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(good, 'utf8'))).toMatchObject({ passed: true, fullSuiteRequested: false,
      shard: { index: 1, total: 1 }, outcomes: [{ files: ['test/sample.test.ts'], status: 'pass' }] });
    expect(JSON.parse(readFileSync(`${good}.vitest.json`, 'utf8'))).toMatchObject({ success: true,
      testResults: [{ status: 'passed' }] });
    writeFileSync(test, "import { it, expect } from 'vitest'; it('fails', () => expect(1).toBe(2));");
    const bad = join(root, 'reports/bad.json');
    expect(run(bad).status).toBe(1);
    expect(JSON.parse(readFileSync(bad, 'utf8'))).toMatchObject({ passed: false, outcomes: [{ status: 'fail' }] });
    const invalid = spawnSync(process.execPath, ['scripts/run-tests.ts', '--stage', 'light', '--shard', '1/4',
      '--stage-report', join(root, 'invalid.json')], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    expect(invalid.status).toBe(1);
  }, 60_000);

  it.each(['commit', 'file-set', 'failed', 'signal', 'missing', 'vitest-missing', 'vitest-duplicate', 'vitest-failed'])('rejects %s evidence', kind => {
    const f = fixture();
    if (kind === 'missing') rmSync(join(f.directory, 'heavy-1.json'));
    else if (kind === 'commit') f.edit('heavy-1.json', r => { r.commit = 'b'.repeat(40); });
    else if (kind === 'file-set') f.edit('heavy-1.json', r => { r.outcomes[0].files.pop(); });
    else if (kind === 'failed') f.edit('heavy-1.json', r => { r.passed = false; });
    else if (kind === 'signal') f.edit('heavy-1.json', r => { r.outcomes[0].signal = 'SIGTERM'; });
    else if (kind === 'vitest-missing') f.edit('heavy-1.json.vitest.json', r => { r.testResults.pop(); });
    else if (kind === 'vitest-duplicate') f.edit('heavy-1.json.vitest.json', r => { r.testResults[1] = r.testResults[0]; });
    else f.edit('heavy-1.json.vitest.json', r => { r.testResults[0].status = 'failed'; });
    expect(() => f.verify()).toThrow();
  });
});
