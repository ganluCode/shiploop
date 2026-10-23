import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverTestFiles, executeTestStages, loadTestStages, planTestStages } from '../../../scripts/test-stages.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const plans = () => planTestStages(['a.test.ts', 'b.test.ts', 'new.test.ts'],
  { schemaVersion: 1, light: ['a.test.ts'], standard: ['b.test.ts'] });

function fixture() {
  const box = createTempSandbox('shiploop-test-stages-');
  cleanup.push(() => box.cleanup());
  const root = box.path;
  const write = (file: string, value: string) => {
    const path = join(root, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, value, 'utf8');
  };
  write('package.json', '{"type":"module"}');
  for (const file of ['run-tests.ts', 'test-stages.ts']) write(`scripts/${file}`, readFileSync(join(repo, 'scripts', file), 'utf8'));
  write('node_modules/vitest/package.json', JSON.stringify({ name: 'vitest', version: '5.0.3', bin: 'fake.mjs' }));
  // Exercise the actual launcher and process exit propagation without running another suite.
  write('node_modules/vitest/fake.mjs', `import {appendFileSync,writeFileSync} from 'node:fs';
    appendFileSync('calls.jsonl', JSON.stringify({args:process.argv.slice(2),explicit:process.env.SHIPLOOP_TEST_EXPLICIT_FILTERS})+'\\n');
    if (process.env.STAGE_COMPETING_REPORT) writeFileSync(process.env.STAGE_COMPETING_REPORT, 'another run');
    if (process.env.STAGE_SIGNAL === 'yes') process.kill(process.pid, 'SIGTERM');
    process.exit(process.argv.includes(process.env.STAGE_FAIL_FILE) ? 7 : 0);
  `);
  write('test/stages.json', JSON.stringify({ schemaVersion: 1, light: ['test/a.test.ts'], standard: ['test/b.test.ts'] }));
  for (const name of ['a', 'b', 'new']) write(`test/${name}.test.ts`, 'export {};');
  return {
    root,
    calls: () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    run: (args: string[] = [], env: Record<string, string> = {}) => spawnSync(process.execPath,
      ['scripts/run-tests.ts', ...args], { cwd: root, encoding: 'utf8', timeout: 15_000,
        env: { PATH: process.env.PATH, HOME: root, NODE_NO_WARNINGS: '1', ...env } }),
  };
}

describe('test stages preserve the entire collection and fail early', () => {
  it('assigns each test once and defaults new tests to heavy', () => {
    expect(plans()).toEqual([
      { stage: 'light', files: ['a.test.ts'] }, { stage: 'standard', files: ['b.test.ts'] },
      { stage: 'heavy', files: ['new.test.ts'] },
    ]);
    const actual = loadTestStages(repo).flatMap(plan => plan.files).sort();
    expect(actual).toEqual(discoverTestFiles(repo));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('matches the actual Vitest collection, including files outside test/modules', () => {
    const box = createTempSandbox('shiploop-stage-collection-');
    cleanup.push(() => box.cleanup());
    const report = join(box.path, 'collection.json');
    const result = spawnSync(process.execPath,
      ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', `--json=${report}`],
      { cwd: repo, encoding: 'utf8', timeout: 15_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const collected = (JSON.parse(readFileSync(report, 'utf8')) as { file: string }[])
      .map(row => relative(repo, row.file).split('\\').join('/')).sort();
    expect(loadTestStages(repo).flatMap(plan => plan.files).sort()).toEqual(collected);
  });

  it.each([
    { schemaVersion: 1, light: ['missing'], standard: [] },
    { schemaVersion: 1, light: ['a.test.ts'], standard: ['a.test.ts'] },
    { schemaVersion: 2, light: [], standard: [] },
  ])('rejects stale, duplicate or invalid manifests', manifest => {
    expect(() => planTestStages(['a.test.ts'], manifest)).toThrow();
  });

  it('stops after a failed stage, records the others as not_run and shares one total budget', () => {
    let time = 0;
    const budgets: number[] = [];
    const rows = executeTestStages(plans(), 100, (plan, remaining) => {
      budgets.push(remaining); time += 30;
      return { status: plan.stage === 'standard' ? 1 : 0 };
    }, () => time);
    expect(budgets).toEqual([100, 70]);
    expect(rows.map(row => row.status)).toEqual(['pass', 'fail', 'not_run']);
  });

  it('never starts another stage after the total deadline or treats signal/error as success', () => {
    let time = 0;
    expect(executeTestStages(plans(), 10, () => { time += 11; return { status: 0 }; }, () => time)
      .map(row => row.status)).toEqual(['pass', 'fail', 'not_run']);
    for (const result of [{ status: null, signal: 'SIGTERM' }, { status: 0, error: new Error('spawn failed') }]) {
      expect(executeTestStages(plans(), 100, () => result).map(row => row.status)).toEqual(['fail', 'not_run', 'not_run']);
    }
  });

  it('runs light first, excludes other groups and preserves implicit full-suite semantics', () => {
    const f = fixture();
    const report = join(f.root, 'report.json');
    const result = f.run(['--stage', 'all', '--stage-report', report]);
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls().map(call => call.args[1])).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/new.test.ts']);
    expect(f.calls().every(call => call.explicit === '[]')).toBe(true);
    expect(f.calls()[0].args).toEqual(['run', 'test/a.test.ts', '--exclude', 'test/b.test.ts', '--exclude', 'test/new.test.ts']);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ scope: 'all', passed: true });
    expect(f.run(['--stage', 'all', '--stage-report', report]).status).toBe(1);
    expect(f.calls()).toHaveLength(3);
  });

  it('preserves a report created by another run while this run was executing', () => {
    const f = fixture();
    const report = join(f.root, 'competing.json');
    const result = f.run(['--stage', 'light', '--stage-report', report], { STAGE_COMPETING_REPORT: report });
    expect(result.status).toBe(1);
    expect(readFileSync(report, 'utf8')).toBe('another run');
  });

  it('default npm test also stages the full collection', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    expect(f.calls()).toHaveLength(3);
  });

  it('does not launch heavy after light failure and records unexecuted groups', () => {
    const f = fixture();
    const report = join(f.root, 'failed.json');
    expect(f.run(['--stage-report', report], { STAGE_FAIL_FILE: 'test/a.test.ts' }).status).toBe(1);
    expect(f.calls()).toHaveLength(1);
    expect(JSON.parse(readFileSync(report, 'utf8')).outcomes.map((row: { status: string }) => row.status))
      .toEqual(['fail', 'not_run', 'not_run']);
  });

  it('keeps explicit file and case arguments unchanged for Task verification', () => {
    const f = fixture();
    const args = ['test/new.test.ts', '-t', 'a case', '--maxWorkers', '1'];
    expect(f.run(args).status).toBe(0);
    expect(f.calls()).toEqual([{ args: ['run', ...args], explicit: JSON.stringify(['test/new.test.ts', 'a case', '1']) }]);
  });

  it('supports focused group execution, rejects invalid groups and propagates signals', () => {
    const f = fixture();
    expect(f.run(['--stage', 'heavy']).status).toBe(0);
    expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0].args[1]).toBe('test/new.test.ts');
    expect(f.run(['--stage', 'missing']).status).toBe(1);
    expect(f.run(['--stage', 'all', '-t', 'case']).status).toBe(1);
    expect(f.run(['--stage', 'light'], { STAGE_SIGNAL: 'yes' }).status).toBe(1);
  });
});
