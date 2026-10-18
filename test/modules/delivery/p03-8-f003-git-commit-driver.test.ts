import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitCommitDriver } from '../../../packages/core/src/adapters/fs/git-commit-driver.ts';
import type { CommandProcessPort, CommandProcessRequest, CommandProcessResult } from '../../../packages/core/src/ports/command-process.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
function fixture(options: { result?: Partial<CommandProcessResult>; output?: string; confirm?: () => void } = {}) {
  const box = createTempSandbox('shiploop-commit-driver-'); cleanup.push(() => box.cleanup());
  const root = realpathSync(box.path); mkdirSync(join(root, '.git'));
  const requests: CommandProcessRequest[] = [];
  const processIdentity = { launchId: randomUUID(), pid: 123, processGroupId: 123, startTime: 'test-start-identity' };
  const processes: CommandProcessPort = { async start(request, confirm) {
    await confirm(processIdentity); requests.push(request);
    const result: CommandProcessResult = { exitCode: 0, signal: null, reason: null, outputBytes: 0,
      droppedOutputBytes: 0, stop: { confirmed: true }, ...options.result };
    return { identity: processIdentity, output: (async function* () {
      if (options.output) yield { stream: 'stdout' as const, bytes: Buffer.from(options.output) };
    })(), result: Promise.resolve(result), stopped: Promise.resolve(result.stop),
    query: () => ({ identity: processIdentity, state: 'stopped', bufferedOutputBytes: 0 }),
    cancel: async () => ({ accepted: true }) };
  } };
  const driver = createGitCommitDriver({ processes, confirmProcessIdentity: async identity => {
    options.confirm?.(); return { launchId: identity.launchId };
  } });
  const baseline = { repositoryBindingId: 'binding', repositoryBindingRevision: 1, repoIdentity: 'repository',
    canonicalPath: root, gitCommonDir: join(root, '.git'), branch: 'main', baseCommit: 'a'.repeat(40) };
  return { driver, baseline, requests };
}

describe('F-003 controlled Git process boundary', () => {
  it('uses argv/stdin, explicit identity and a bounded minimal environment without disabling real hooks', async () => {
    const f = fixture();
    const session = f.driver.open(f.baseline, () => {});
    await session.commit('Message with $(not-a-command)\n', { name: 'User', email: 'user@example.com', confirmed: true });
    const request = f.requests[0];
    expect(request.argv[0]).toBe('/usr/bin/git');
    expect(request.argv.slice(-4)).toEqual(['commit', '--no-gpg-sign', '--cleanup=verbatim', '--file=-']);
    expect(Buffer.from(request.stdin!).toString()).toBe('Message with $(not-a-command)\n');
    expect(request.argv.join(' ')).not.toContain('hooksPath');
    expect(request.environment).toMatchObject({ GIT_AUTHOR_NAME: 'User', GIT_AUTHOR_EMAIL: 'user@example.com',
      GIT_COMMITTER_NAME: 'User', GIT_COMMITTER_EMAIL: 'user@example.com', GIT_LITERAL_PATHSPECS: '1' });
    expect(request.environment).not.toHaveProperty('HOME');
    expect(request.environment).not.toHaveProperty('GIT_INDEX_FILE');
    expect(request.environment).not.toHaveProperty('GIT_DIR');
    expect(request.environment.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(request.timeoutMs).toBeGreaterThan(0); expect(request.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(request.maxOutputBytes).toBe(1024 * 1024);
    expect(request.maxInputBytes).toBe(65_536);
  });

  it('rechecks admission after durable process confirmation yields, before execution is released', async () => {
    let authorized = true;
    const f = fixture({ confirm: () => { authorized = false; } });
    await expect(f.driver.open(f.baseline, () => { if (!authorized) throw new Error('authorization changed'); })
      .commit('message', { name: 'User', email: 'u@example.com', confirmed: true })).rejects.toThrow('authorization changed');
    expect(f.requests).toHaveLength(0);
  });

  it('does not treat exit 0 with an uncertain process group as a known side effect', async () => {
    const f = fixture({ result: { stop: { confirmed: false } } });
    await expect(f.driver.open(f.baseline, () => {}).commit('message', { name: 'User', email: 'u@example.com', confirmed: true }))
      .rejects.toMatchObject({ reason: 'stop_unconfirmed', stopConfirmed: false, exitCode: 0 });
  });

  it('retains a stopped timeout as an observed failure, not success based on its exit code', async () => {
    const f = fixture({ result: { reason: 'timed_out' } });
    expect(await f.driver.open(f.baseline, () => {}).commit('message', { name: 'User', email: 'u@example.com', confirmed: true }))
      .toMatchObject({ reason: 'timed_out', exitCode: 0 });
  });

  it('refuses incomplete output and malformed Git facts instead of fabricating evidence', async () => {
    const f = fixture({ result: { droppedOutputBytes: 1 } });
    await expect(f.driver.open(f.baseline, () => {}).facts()).rejects.toMatchObject({ reason: 'output_limit' });
    const malformed = fixture({ output: 'not-an-oid\n' });
    await expect(malformed.driver.open(malformed.baseline, () => {}).facts()).rejects.toMatchObject({ reason: 'invalid_git_output' });
  });

  it('batches exact path argv within the existing supervised-process limit', async () => {
    const f = fixture();
    const paths = Array.from({ length: 300 }, (_, index) => `literal-${index}.ts`);
    await f.driver.open(f.baseline, () => {}).stage(paths);
    expect(f.requests).toHaveLength(3);
    expect(f.requests.every(request => request.argv.length <= 256)).toBe(true);
    expect(f.requests.flatMap(request => request.argv.slice(request.argv.indexOf('--') + 1))).toEqual(paths);
  });
});
