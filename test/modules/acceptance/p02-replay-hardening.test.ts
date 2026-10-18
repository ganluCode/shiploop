import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayAcceptanceEnv, replayMigrationVersions, replayCommandLogs, treeIndex } from '../../../scripts/acceptance/p02-clean-replay.ts';
import { withTempSandbox } from '../../helpers/temp-sandbox.ts';

describe('P02 replay infrastructure regression', () => {
  it('exports actual command logs before snapshot removal, refusing traversal', () => withTempSandbox((root) => {
    mkdirSync(join(root, 'evidence/commands'), { recursive: true });
    writeFileSync(join(root, 'evidence/commands/01-verify.log'), 'outcome: exit 1\nfailed_test_file: test/regression.test.ts');
    const fn = replayCommandLogs;
    expect(fn(root, ['evidence/config.json', 'evidence/commands/01-verify.log'])).toEqual([{ path: 'evidence/commands/01-verify.log', content: 'outcome: exit 1\nfailed_test_file: test/regression.test.ts' }]);
    expect(() => fn(root, ['evidence/commands/../../outside.log'])).toThrow();
  }));
  it('isolated acceptance propagates only approved budgets, never user credentials', () => {
    const fn = replayAcceptanceEnv;
    const result = fn({ SHIPLOOP_VERIFY_STEP_TIMEOUT_MS: '1200000', SHIPLOOP_TEST_RUN_TIMEOUT_MS: '4800000', API_KEY: 'do-not-import', SHIPLOOP_TEST_EXPLICIT_FILTERS: '["wrong"]' }, { PATH: '/bin', HOME: '/isolated', TMPDIR: '/isolated/tmp' });
    expect(result).toEqual({ PATH: '/bin', HOME: '/isolated', TMPDIR: '/isolated/tmp', SHIPLOOP_VERIFY_STEP_TIMEOUT_MS: '1200000', SHIPLOOP_TEST_RUN_TIMEOUT_MS: '4800000', SHIPLOOP_CLEAN_REPLAY_DEPTH: '1' });
    expect(fn({}, {}).SHIPLOOP_VERIFY_STEP_TIMEOUT_MS).toBe('1200000');
  });

  it('migration scan uses the validated snapshot acceptance manifest, not a frozen P02 count', () => withTempSandbox((root) => {
    mkdirSync(join(root, 'acceptance'));
    const config = JSON.parse(readFileSync(resolve('acceptance/p02.config.json'), 'utf8'));
    config.schemaVersions.sqliteMigrations = [1, 2, 3, 4, 5, 6];
    writeFileSync(join(root, 'acceptance/p02.config.json'), JSON.stringify(config));
    const fn = replayMigrationVersions;
    expect(fn(root)).toEqual([1, 2, 3, 4, 5, 6]);
    config.schemaVersions.sqliteMigrations = [1, 1];
    writeFileSync(join(root, 'acceptance/p02.config.json'), JSON.stringify(config));
    expect(() => fn(root)).toThrow();
  }));

  it('disappearing staging files do not abort cleanup; other filesystem errors still fail', () => withTempSandbox((root) => {
    const file = join(root, 'pending.part');
    writeFileSync(file, 'pending');
    const fn = treeIndex;
    expect(fn([root], (path: string) => { rmSync(path); return statSync(path); }).size).toBe(0);
    writeFileSync(file, 'pending');
    expect(() => fn([root], () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); })).toThrow('denied');
  }));
});
