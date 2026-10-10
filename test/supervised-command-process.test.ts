import { execFile, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessHandle, CommandProcessRequest, CommandProcessIdentity } from '../packages/core/src/ports/command-process.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteBaselineStore } from '../packages/core/src/adapters/sqlite/baseline-store.ts';

const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});
function sandbox() {
  const box = createTempSandbox('shiploop-process-');
  resources.push(() => box.cleanup());
  return realpathSync(box.path);
}
function request(cwd: string, script: string, overrides: Partial<CommandProcessRequest> = {}): CommandProcessRequest {
  return { argv: [process.execPath, '-e', script], cwd, environment: {}, timeoutMs: 10_000,
    maxInputBytes: 65_536, maxOutputBytes: 8_388_608, ...overrides };
}
const acknowledge = async (identity: CommandProcessIdentity) => ({ launchId: identity.launchId });
async function start(input: CommandProcessRequest): Promise<CommandProcessHandle> {
  const handle = await createCommandProcessAdapter().start(input, acknowledge);
  resources.push(async () => {
    await handle.cancel();
    expect((await handle.stopped).confirmed).toBe(true);
  });
  return handle;
}
async function collect(handle: CommandProcessHandle) {
  const output = { stdout: '', stderr: '' };
  for await (const chunk of handle.output) output[chunk.stream] += Buffer.from(chunk.bytes).toString();
  return output;
}
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('macOS supervised command port', () => {
  it('commits the Core execution identity before releasing any script', async () => {
    const root = sandbox();
    const sentinel = join(root, 'released');
    const session = openSqliteStorageSession({ path: join(root, 'state.db') });
    resources.push(() => session.close());
    await migrateSqliteStorage(session);
    const operationId = '11111111-1111-4111-8111-111111111111';
    session.database.exec(`INSERT INTO projects (id, created_at, updated_at, display_name, status, labels)
      VALUES ('p', 0, 0, 'p', 'active', '[]');
      INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status)
      VALUES ('${operationId}', 0, 0, 'p', 'baseline', 'accepted');
      INSERT INTO baseline_occupancy (id, holder_operation_id, acquired_at, heartbeat_at)
      VALUES ('global', '${operationId}', 0, 0);`);
    const arrived = barrier<CommandProcessIdentity>();
    const commit = barrier<void>();
    const pending = createCommandProcessAdapter().start(request(root,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`), async (identity) => {
      arrived.resolve(identity);
      await commit.promise;
      session.database.transaction(() => {
        session.database.prepare('UPDATE baseline_occupancy SET process_identity = ? WHERE id = ?')
          .run(JSON.stringify(identity), 'global');
      })();
      const store = createSqliteBaselineStore(session);
      expect(store.readBaselineOccupancy().processIdentity).toEqual(identity);
      return { launchId: identity.launchId };
    });
    const identity = await arrived.promise;
    expect(identity.pid).toBe(identity.processGroupId);
    expect(identity.startTime).toBeTruthy();
    expect(identity.launchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(sentinel)).toBe(false);
    await nextTurn(); // Host event loop remains responsive while Core commit is pending.
    expect(existsSync(sentinel)).toBe(false);
    commit.resolve();
    const handle = await pending;
    resources.push(async () => { await handle.cancel(); expect((await handle.stopped).confirmed).toBe(true); });
    await collect(handle);
    expect((await handle.result).exitCode).toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toBe('ran');
  });

  it.each(['reject', 'wrong_ack', 'disconnect'] as const)('never releases on %s during persistence handshake', async (mode) => {
    const root = sandbox();
    const sentinel = join(root, 'forbidden');
    const controller = new AbortController();
    let supervisorPid = 0;
    await expect(createCommandProcessAdapter().start(request(root,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`), async (identity) => {
      supervisorPid = identity.pid;
      expect(existsSync(sentinel)).toBe(false);
      if (mode === 'reject') throw new Error('injected commit failure /secret');
      if (mode === 'disconnect') {
        process.kill(identity.pid, 'SIGTERM'); // Real supervisor handshake interruption.
        return new Promise(() => {});
      }
      return { launchId: identity.launchId + '-wrong' };
    }, controller.signal)).rejects.toMatchObject({ name: 'CommandProcessError' });
    expect(supervisorPid).toBeGreaterThan(0);
    expect(() => process.kill(supervisorPid, 0)).toThrow();
    expect(existsSync(sentinel)).toBe(false);
  });

  it('fails closed when the Host dies while the persistence handshake is pending', async () => {
    const root = sandbox();
    const sentinel = join(root, 'host-crash-forbidden');
    const child = fork(fileURLToPath(new URL('./helpers/command-process-host-loss.ts', import.meta.url)), [sentinel, root], {
      execArgv: ['--no-warnings', '--import', fileURLToPath(new URL('./helpers/node-ts-loader/register.mjs', import.meta.url))],
      env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    resources.push(async () => { child.kill('SIGKILL'); await closed; });
    const identity = await new Promise<CommandProcessIdentity>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Host fixture handshake timeout')), 5_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('message', (value) => { clearTimeout(timeout); resolve(value as CommandProcessIdentity); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Host fixture exited before handshake')); });
    });
    expect(existsSync(sentinel)).toBe(false);
    child.kill('SIGKILL');
    await closed;
    const deadline = Date.now() + 5_000;
    let remains = true;
    while (remains && Date.now() < deadline) {
      const output = await new Promise<string>((resolve, reject) => execFile('/bin/ps', ['-axo', 'pid=,pgid='],
        { timeout: 1_000, maxBuffer: 1_048_576 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      remains = output.trim().split('\n').some((row) => Number(row.trim().split(/\s+/)[1]) === identity.processGroupId);
    }
    expect(remains).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('snapshots authorized argv/environment before an asynchronous Core commit', async () => {
    const root = sandbox();
    const input = request(root, "process.stdout.write(process.env.APPROVED)", { environment: { APPROVED: 'original' } });
    const handle = await createCommandProcessAdapter().start(input, async (identity) => {
      (input.argv as string[])[2] = "process.stdout.write('unauthorized')";
      (input.environment as Record<string, string>).APPROVED = 'changed';
      return acknowledge(identity);
    });
    resources.push(async () => { await handle.cancel(); expect((await handle.stopped).confirmed).toBe(true); });
    expect((await collect(handle)).stdout).toBe('original');
    expect((await handle.result).exitCode).toBe(0);
  });

  it('abort during an unresolved Core commit does not release the script', async () => {
    const root = sandbox();
    const sentinel = join(root, 'abort-forbidden');
    const controller = new AbortController();
    await expect(createCommandProcessAdapter().start(request(root,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`), async () => {
      controller.abort();
      return new Promise(() => {});
    }, controller.signal)).rejects.toMatchObject({ reason: 'start_aborted' });
    expect(existsSync(sentinel)).toBe(false);
  });

  it('returns real success, nonzero exit and signal outcomes with separate asynchronous streams', async () => {
    const root = sandbox();
    for (const [script, exitCode, signal] of [
      ["process.stdout.write('out'); process.stderr.write('err')", 0, null],
      ['process.exit(7)', 7, null],
      ["process.kill(process.pid, 'SIGTERM')", null, 'SIGTERM'],
    ] as const) {
      const handle = await start(request(root, script));
      const output = await collect(handle);
      expect(await handle.result).toMatchObject({ exitCode, signal, reason: null });
      expect((await handle.stopped).confirmed).toBe(true);
      if (exitCode === 0) expect(output).toEqual({ stdout: 'out', stderr: 'err' });
    }
  });

  it('reports missing executable and permissions as launch errors, not exit-code success', async () => {
    const root = sandbox();
    const forbidden = join(root, 'not-executable');
    writeFileSync(forbidden, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    for (const [command, reason] of [[join(root, 'missing'), 'missing_command'], [forbidden, 'permission_denied']]) {
      const handle = await start(request(root, '', { argv: [command] }));
      await collect(handle);
      expect(await handle.result).toMatchObject({ reason, exitCode: null });
      expect((await handle.stopped).confirmed).toBe(true);
    }
  });

  it('passes literal argv, explicit cwd and only the approved environment/stdin', async () => {
    const root = sandbox();
    const literal = '; touch forbidden | && $HOME';
    const script = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({arg:process.argv[1],cwd:process.cwd(),env:process.env,input:s})))`;
    const handle = await start(request(root, script, { argv: [process.execPath, '-e', script, literal],
      environment: { APPROVED: 'yes' }, stdin: new TextEncoder().encode('hello') }));
    const output = await collect(handle);
    const observed = JSON.parse(output.stdout);
    // Darwin/libuv may inject its locale metadata; no other Host variables are permitted.
    const { __CF_USER_TEXT_ENCODING: localeMetadata, ...environment } = observed.env;
    if (localeMetadata !== undefined) expect(localeMetadata).toMatch(/^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/i);
    expect({ ...observed, env: environment }).toEqual({ arg: literal, cwd: root,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', APPROVED: 'yes' }, input: 'hello' });
    expect((await handle.result).exitCode).toBe(0);
    expect(existsSync(join(root, 'forbidden'))).toBe(false);
  });

  it('bounds output and buffering for a slow consumer without accumulating the full stream', async () => {
    const root = sandbox();
    const handle = await start(request(root, "setInterval(()=>process.stdout.write('x'.repeat(65536)),1)",
      { maxOutputBytes: 100_000 }));
    let total = 0;
    for await (const chunk of handle.output) {
      total += chunk.bytes.length;
      expect(handle.query().bufferedOutputBytes).toBeLessThanOrEqual(131_072);
      await nextTurn();
    }
    expect(total).toBe(100_000);
    expect(await handle.result).toMatchObject({ reason: 'output_overflow' });
    expect((await handle.stopped).confirmed).toBe(true);
  });

  it('keeps a hanging execution queryable and cancels its controlled descendants, not just the parent', async () => {
    const root = sandbox();
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)`;
    const handle = await start(request(root, script));
    const iterator = handle.output[Symbol.asyncIterator]();
    const first = await iterator.next();
    const descendant = Number(Buffer.from(first.value!.bytes).toString().trim());
    expect(descendant).toBeGreaterThan(0);
    expect(handle.query().state).toBe('running');
    let settled = false;
    void handle.result.then(() => { settled = true; });
    await nextTurn();
    expect(settled).toBe(false);
    expect(await handle.cancel()).toEqual({ accepted: true });
    while (!(await iterator.next()).done) { /* drain */ }
    expect((await handle.stopped).confirmed).toBe(true);
    expect(await handle.result).toMatchObject({ reason: 'cancelled' });
    expect(() => process.kill(descendant, 0)).toThrow();
  });

  it('does not report stopped when the command parent exits with a living descendant', async () => {
    const root = sandbox();
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(JSON.stringify([process.pid,c.pid]));c.unref()`;
    const handle = await start(request(root, script));
    const iterator = handle.output[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value!.stream).toBe('stdout');
    const [parent, descendant] = JSON.parse(Buffer.from(first.value!.bytes).toString()) as number[];
    expect(descendant).toBeGreaterThan(0);
    const deadline = Date.now() + 5_000;
    let parentPresent = true;
    while (parentPresent && Date.now() < deadline) {
      const pids = await new Promise<string>((resolve, reject) => execFile('/bin/ps', ['-axo', 'pid='],
        { timeout: 1_000, maxBuffer: 1_048_576 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      parentPresent = pids.trim().split(/\s+/).some((pid) => Number(pid) === parent);
    }
    expect(parentPresent).toBe(false);
    expect(() => process.kill(descendant, 0)).not.toThrow();
    let confirmed = false;
    void handle.stopped.then(() => { confirmed = true; });
    await nextTurn();
    expect(confirmed).toBe(false);
    await handle.cancel();
    while (!(await iterator.next()).done) { /* drain */ }
    expect((await handle.stopped).confirmed).toBe(true);
    expect(() => process.kill(descendant, 0)).toThrow();
  });

  it('enforces a finite runtime timeout even when output is not consumed', async () => {
    const handle = await start(request(sandbox(), "setInterval(()=>process.stdout.write('x'.repeat(65536)),1)", { timeoutMs: 100 }));
    expect(await handle.result).toMatchObject({ reason: 'timed_out' });
    expect((await handle.stopped).confirmed).toBe(true);
  });

  it('rejects unknown platforms and malformed or oversized inputs before confirmation', async () => {
    const root = sandbox();
    let confirmations = 0;
    const confirm = async (identity: CommandProcessIdentity) => { confirmations++; return acknowledge(identity); };
    await expect(createCommandProcessAdapter({ platform: 'linux' }).start(request(root, ''), confirm))
      .rejects.toMatchObject({ reason: 'unsupported_platform' });
    for (const input of [request(root, '', { timeoutMs: Infinity }), request('relative', ''),
      request(root, '', { argv: [] }), request(root, '', { maxOutputBytes: 0 }),
      request(root, '', { maxInputBytes: 1 }), { ...request(root, ''), shell: true }]) {
      await expect(createCommandProcessAdapter().start(input, confirm)).rejects.toMatchObject({ reason: 'invalid_input' });
    }
    expect(confirmations).toBe(0);
  });
});
