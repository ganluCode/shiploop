import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  acquireWriterLock, openLockedWriter, createHostFileStore, resolveCanonicalDataRoot,
  CURRENT_HOST_CAPABILITIES, CURRENT_SCHEMA_VERSION, type HostDiscoveryRecord, type WriterLockOptions,
} from '../packages/host/src/index.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repo, timeout: 60_000 });
});

async function sandbox(fn: (root: string) => Promise<void>) {
  const temp = createTempSandbox('shiploop-lock-');
  try { await fn(realpathSync(temp.path)); } finally { temp.cleanup(); }
}
function data(root: string, name = 'data') {
  const path = join(root, name);
  mkdirSync(path);
  return resolveCanonicalDataRoot({ dataRoot: path }).canonicalRoot;
}
function record(root: string, pid = process.pid): HostDiscoveryRecord {
  return {
    schemaVersion: 1, protocolVersion: 1, hostInstanceId: randomUUID(),
    dataRootIdentity: createHostFileStore({ canonicalRoot: root }).dataRootIdentity,
    listenAddress: '127.0.0.1', port: 54321, pid, startedAt: new Date().toISOString(),
  };
}
function response(discovery: HostDiscoveryRecord) {
  const { protocolVersion, hostInstanceId, dataRootIdentity, startedAt } = discovery;
  // 握手线消息版本与发现 schemaVersion 独立（P02-2 §3.1：线消息 v2、发现 v1）。
  return { schemaVersion: CURRENT_SCHEMA_VERSION, protocolVersion, hostInstanceId, dataRootIdentity, startedAt,
    lifecycleState: 'ready', capabilities: CURRENT_HOST_CAPABILITIES };
}

// Local to F-004: do not pre-implement the general Host/CLI fixture task F-005.
function candidate(root: string) {
  const child = spawn(process.execPath, [
    '--import', resolve(repo, 'test/helpers/node-ts-loader/register.mjs'),
    resolve(repo, 'test/helpers/writer-lock-child.ts'), root,
  ], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root, NODE_NO_WARNINGS: '1' },
  });
  const messages: Array<{ kind: string; pid?: number; code?: string }> = [];
  let stderr = '';
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  const waiters = new Set<() => void>();
  child.on('message', (message) => { messages.push(message as typeof messages[number]); for (const wake of waiters) wake(); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
    child.once('exit', (code, signal) => { done({ code, signal }); for (const wake of waiters) wake(); });
  });
  child.on('error', () => { for (const wake of waiters) wake(); });
  function wait(kind: string | readonly string[]): Promise<typeof messages[number]> {
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timeout ${kind}: ${stderr}`)); }, 8_000);
      function check() {
        const found = messages.find((m) => typeof kind === 'string' ? m.kind === kind : kind.includes(m.kind));
        if (found) { clearTimeout(timer); waiters.delete(check); done(found); }
        else if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer); waiters.delete(check); reject(new Error(`early exit ${kind}: ${stderr}`));
        }
      }
      waiters.add(check); check();
    });
  }
  return { child, wait, messages, exited };
}
async function exitWithin(child: ChildProcess, exited: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`child ${child.pid} exit unconfirmed`)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function dispose(c: ReturnType<typeof candidate>) {
  if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
  await exitWithin(c.child, c.exited);
}

describe('F-004 direct macOS writer lock', () => {
  it('exclusive on same inode, distinct roots independent; 0600 and stable inode after release', async () => {
    await sandbox(async (root) => {
      const a = data(root, 'a'); const b = data(root, 'b');
      const first = await acquireWriterLock({ canonicalRoot: a });
      const lockPath = join(a, 'host/writer.lock'); const before = statSync(lockPath);
      try {
        expect(before.mode & 0o777).toBe(0o600); expect(before.uid).toBe(process.getuid!());
        await expect(acquireWriterLock({ canonicalRoot: a, timeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
        const other = await acquireWriterLock({ canonicalRoot: b }); other.releaseAfterWritesClosed();
      } finally { first.releaseAfterWritesClosed(); }
      const next = await acquireWriterLock({ canonicalRoot: a }); next.releaseAfterWritesClosed();
      expect(statSync(lockPath).ino).toBe(before.ino);
    });
  });

  it.each(['linux', 'win32', 'unknown'])('unsupported platform %s refuses before creating host/', async (platform) => {
    await sandbox(async (root) => {
      const canonicalRoot = data(root);
      await expect(acquireWriterLock({ canonicalRoot, platform })).rejects.toMatchObject({ code: 'unsupported_platform' });
      expect(existsSync(join(canonicalRoot, 'host'))).toBe(false);
    });
  });

  it('malformed lock inputs are rejected before I/O or native loading', async () => {
    for (const options of [null, [], {}, { canonicalRoot: '/' }, { canonicalRoot: 'relative' },
      { canonicalRoot: '/somewhere', bind: '0.0.0.0' }, { canonicalRoot: '/bad\0root' }]) {
      await expect(acquireWriterLock(options as unknown as WriterLockOptions)).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('missing native lock tool rejects, does not fall back or open writer', async () => {
    await sandbox(async (root) => {
      let opened = false;
      await expect(openLockedWriter({ canonicalRoot: data(root), nativeAddonPath: join(root, 'missing.node') }, async () => {
        opened = true; return { close() {} };
      })).rejects.toMatchObject({ code: 'unsupported_platform' });
      expect(opened).toBe(false);
    });
  });

  it.each(['symlink', 'directory', 'wide', 'hardlink'])('unsafe lock target %s is not overwritten or repaired', async (kind) => {
    await sandbox(async (root) => {
      const canonicalRoot = data(root);
      const store = createHostFileStore({ canonicalRoot }); store.ensureHostDir();
      const target = join(canonicalRoot, 'host/writer.lock'); const outside = join(root, 'outside');
      writeFileSync(outside, 'untouched', { mode: 0o600 });
      if (kind === 'symlink') symlinkSync(outside, target);
      else if (kind === 'directory') mkdirSync(target);
      else if (kind === 'hardlink') {
        const { linkSync } = await import('node:fs'); linkSync(outside, target);
      } else { writeFileSync(target, 'lock', { mode: 0o644 }); chmodSync(target, 0o644); }
      await expect(acquireWriterLock({ canonicalRoot })).rejects.toMatchObject({ code: 'unsafe_discovery' });
      expect(readFileSync(outside, 'utf8')).toBe('untouched');
      if (kind === 'wide') expect(statSync(target).mode & 0o777).toBe(0o644);
    });
  });

  it('sync barrier: only one actual Node writer opens Core; realpath alias competes, loser never migrates', async () => {
    await sandbox(async (root) => {
      const canonicalRoot = data(root); const alias = join(root, 'alias'); symlinkSync(canonicalRoot, alias);
      const a = candidate(canonicalRoot); const b = candidate(alias);
      try {
        await Promise.all([a.wait('ready'), b.wait('ready')]);
        a.child.send('go'); b.child.send('go');
        // Resolve each outcome without polling/sleep-based synchronization.
        const result = await Promise.all([a, b].map((c) => c.wait(['acquired', 'rejected'])));
        expect(result.map((r) => r.kind).sort()).toEqual(['acquired', 'rejected']);
        const winner = result[0]!.kind === 'acquired' ? a : b; const loser = winner === a ? b : a;
        expect(loser.messages.some((m) => m.kind === 'opening')).toBe(false);
        expect(loser.messages.find((m) => m.kind === 'rejected')!.code).toBe('owner_unknown');
        await exitWithin(loser.child, loser.exited); expect(await loser.exited).toEqual({ code: 1, signal: null });
        expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(true);
        expect(winner.messages.find((m) => m.kind === 'acquired')!.pid).toBe(winner.child.pid);
        await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
        winner.child.send('close'); await exitWithin(winner.child, winner.exited);
        expect(await winner.exited).toEqual({ code: 0, signal: null });
        const next = await acquireWriterLock({ canonicalRoot }); next.releaseAfterWritesClosed();
      } finally { await Promise.all([dispose(a), dispose(b)]); }
    });
  });

  it.each(['SIGKILL', 'SIGABRT'] as const)('actual writer %s: OS releases only on writer exit; unrelated process remains alive', async (signal) => {
    await sandbox(async (root) => {
      const canonicalRoot = data(root); const c = candidate(canonicalRoot);
      try {
        await c.wait('ready'); c.child.send('go'); await c.wait('acquired');
        await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
        c.child.kill(signal); await exitWithin(c.child, c.exited);
        expect((await c.exited).signal).toBe(signal);
        const next = await acquireWriterLock({ canonicalRoot }); next.releaseAfterWritesClosed();
        expect(() => process.kill(process.pid, 0)).not.toThrow();
      } finally { await dispose(c); }
    });
  });

  it('missing/broken/stale discovery and PID of unrelated live process never authorize takeover; bounded owner probe', async () => {
    await sandbox(async (root) => {
      const canonicalRoot = data(root); const store = createHostFileStore({ canonicalRoot });
      const lock = await acquireWriterLock({ canonicalRoot });
      try {
        for (const content of [undefined, 'broken', JSON.stringify(record(canonicalRoot, 2147483647)), JSON.stringify(record(canonicalRoot))]) {
          if (content !== undefined) writeFileSync(join(canonicalRoot, 'host/discovery.json'), content, { mode: 0o600 });
          const started = performance.now();
          await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 40 })).rejects.toMatchObject({ code: 'owner_unknown', operation: 'host.discovery' });
          expect(performance.now() - started).toBeLessThan(1_000);
        }
        const discovery = record(canonicalRoot); store.publishDiscovery(discovery); const token = store.issueAuthToken();
        await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 40, ownerProbe: async (d, t) => {
          expect(d).toEqual(discovery); expect(t).toBe(token); return response(d);
        } })).rejects.toMatchObject({ code: 'owner_active', details: { hostInstanceId: discovery.hostInstanceId } });
        let aborted = false;
        await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 40, ownerProbe: async (_d, _t, signal) => {
          signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {});
        } })).rejects.toMatchObject({ code: 'owner_unknown' });
        expect(aborted).toBe(true); expect(() => process.kill(process.pid, 0)).not.toThrow();
        expect(store.readTrustedDiscovery()).toEqual(discovery); expect(store.readTrustedAuthToken()).toBe(token);
      } finally { lock.releaseAfterWritesClosed(); }
    });
  });

  it('different roots admit separate real Core writers concurrently', async () => {
    await sandbox(async (root) => {
      const aRoot = data(root, 'a'); const bRoot = data(root, 'b');
      const a = candidate(aRoot); const b = candidate(bRoot);
      try {
        await Promise.all([a.wait('ready'), b.wait('ready')]);
        a.child.send('go'); b.child.send('go');
        await Promise.all([a.wait('acquired'), b.wait('acquired')]);
        expect(a.child.pid).not.toBe(b.child.pid);
        for (const canonicalRoot of [aRoot, bRoot]) {
          expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(true);
          await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
        }
        a.child.send('close'); b.child.send('close');
        await Promise.all([exitWithin(a.child, a.exited), exitWithin(b.child, b.exited)]);
        expect(await a.exited).toEqual({ code: 0, signal: null });
        expect(await b.exited).toEqual({ code: 0, signal: null });
      } finally { await Promise.all([dispose(a), dispose(b)]); }
    });
  });

  it('bounded waiter can acquire after release; invalid budgets reject before writer opens', async () => {
    await sandbox(async (root) => {
      const canonicalRoot = data(root); const lock = await acquireWriterLock({ canonicalRoot });
      const waiting = acquireWriterLock({ canonicalRoot, timeoutMs: 1_000 });
      lock.releaseAfterWritesClosed();
      const next = await waiting; next.releaseAfterWritesClosed();
      for (const timeoutMs of [-1, 0.5, NaN, Infinity, 10_001]) {
        let opened = false;
        await expect(openLockedWriter({ canonicalRoot, timeoutMs }, async () => {
          opened = true; return { close() {} };
        })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(opened).toBe(false);
      }
    });
  });

  it('cleanup failure retains lock and retries same finalizer; concurrent closes do not release twice', async () => {
    await sandbox(async (root) => {
      const canonicalRoot = data(root); let closes = 0; let cleanups = 0; let failCleanup = true;
      const writer = await openLockedWriter({ canonicalRoot }, async () => ({ close() { closes++; } }));
      const finalize = () => { cleanups++; if (failCleanup) throw new Error('cleanup failed'); };
      await expect(writer.close(finalize)).rejects.toThrow('cleanup failed');
      await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
      failCleanup = false;
      await Promise.all([writer.close(), writer.close()]);
      expect(closes).toBe(1); expect(cleanups).toBe(2);
      const next = await acquireWriterLock({ canonicalRoot });
      try {
        await writer.close(); // stale cleanup/release callback cannot unlock new writer
        await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
      } finally { next.releaseAfterWritesClosed(); }
    });
  });

  it('failed authentication/mismatched response remains owner_unknown, never leaks probe errors or secrets', async () => {
    await sandbox(async (root) => {
      const canonicalRoot = data(root); const lock = await acquireWriterLock({ canonicalRoot });
      const store = createHostFileStore({ canonicalRoot }); store.publishDiscovery(record(canonicalRoot)); const token = store.issueAuthToken();
      try {
        for (const ownerProbe of [async () => { throw new Error(token); }, async (d: HostDiscoveryRecord) => ({ ...response(d), hostInstanceId: randomUUID() })]) {
          try { await acquireWriterLock({ canonicalRoot, timeoutMs: 40, ownerProbe }); expect.unreachable(); }
          catch (error) { expect(error).toMatchObject({ code: 'owner_unknown' }); expect(String(error)).not.toContain(token); expect(String(error)).not.toContain(root); }
        }
      } finally { lock.releaseAfterWritesClosed(); }
    });
  });

  it('open failure releases; close failure retains exclusion; cleanup runs after close while still holding lock', async () => {
    await sandbox(async (root) => {
      const canonicalRoot = data(root);
      await expect(openLockedWriter({ canonicalRoot }, async () => { throw new Error('open failed'); })).rejects.toThrow('open failed');
      let failClose = true; const events: string[] = [];
      const writer = await openLockedWriter({ canonicalRoot }, async () => {
        events.push('open');
        return { async close() { events.push('close'); if (failClose) throw new Error('unconfirmed'); } };
      });
      await expect(writer.close()).rejects.toThrow('unconfirmed');
      await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
      failClose = false;
      await writer.close(async () => {
        events.push('cleanup');
        await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
      });
      await writer.close(); expect(events).toEqual(['open', 'close', 'close', 'cleanup']);
      const next = await acquireWriterLock({ canonicalRoot }); next.releaseAfterWritesClosed();
    });
  });
});
