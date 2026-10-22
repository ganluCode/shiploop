import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matrixStopProbe, matrixWriter, processRows, until, withProcessMatrix } from '../../helpers/process-matrix.ts';
import type { CommandProcessIdentity } from '../../../packages/core/src/ports/command-process.ts';
import { openProcessRecoveryFixture } from '../../helpers/process-recovery-matrix.ts';

describe.skipIf(process.platform !== 'darwin')('P04-7 real process fault matrix', () => {
  it('[case:graceful-tree] stops every writer normally and exports cleanup evidence', async () => {
    const manifest = await withProcessMatrix('graceful-tree', async matrix => {
      const handle = await matrix.start('graceful');
      await matrix.writersReady();
      writeFileSync(join(matrix.root, 'release'), 'release');
      expect(await handle.result).toMatchObject({ exitCode: 0, reason: null, stop: { confirmed: true } });
      expect(await matrix.members(handle.identity)).toEqual([]);
      matrix.record('pass', { result: await handle.result });
    });
    expect(manifest).toMatchObject({ status: 'pass', confirmed: true, processesGone: true, removed: true, unconfirmed: [] });
    expect(manifest.processes).toHaveLength(4);
    expect(manifest.files.map(file => file.path)).toEqual(expect.arrayContaining(['parent.writes', 'child.writes', 'grandchild.writes']));
    expect(existsSync(manifest.root)).toBe(false);
    expect(JSON.parse(readFileSync(manifest.manifestPath, 'utf8'))).toEqual(manifest);
    expect(JSON.parse(readFileSync(join(dirname(manifest.manifestPath), 'cleanup.json'), 'utf8'))).toMatchObject({
      status: 'passed', matrixStatus: 'pass', processTreeStopped: true, processGroupsStopped: true, resourcesRemoved: true,
    });
  }, 20_000);

  for (const mode of ['cancel', 'force', 'tool-timeout', 'parent-exits'] as const) {
    it(`[case:${mode}] confirms the whole writing group after ${mode}`, async () => {
      await withProcessMatrix(mode, async matrix => {
        const signals: Array<{ pgid: number; signal: string }> = [];
        const handle = await matrix.start(mode === 'cancel' ? 'graceful' : 'stubborn', {
          timeoutMs: mode === 'tool-timeout' ? 1_500 : 15_000,
          adapter: { stopProbe: matrixStopProbe((pgid, signal) => {
            signals.push({ pgid, signal });
            matrix.record('pass', { phase: 'real-escalation', pgid, signal });
          }) },
        });
        await matrix.writersReady();
        if (mode === 'parent-exits') {
          const { pid } = JSON.parse(readFileSync(join(matrix.root, 'parent.json'), 'utf8')) as { pid: number };
          writeFileSync(join(matrix.root, 'exit-parent'), 'exit');
          await until(async () => !(await processRows()).some(row => row.pid === pid), 'command parent exits');
          expect((await matrix.members(handle.identity)).length).toBeGreaterThan(1);
          expect(handle.query().state).toBe('running');
          const before = readFileSync(join(matrix.root, 'grandchild.writes'), 'utf8').length;
          await until(() => readFileSync(join(matrix.root, 'grandchild.writes'), 'utf8').length > before, 'orphan grandchild continues');
        }
        if (mode !== 'tool-timeout') {
          expect(await handle.cancel()).toEqual({ accepted: true });
          await handle.cancel();
        }
        expect(await handle.result).toMatchObject({ reason: mode === 'tool-timeout' ? 'timed_out' : 'cancelled', stop: { confirmed: true } });
        expect(await matrix.members(handle.identity)).toEqual([]);
        if (mode !== 'cancel') {
          expect(readFileSync(join(matrix.root, 'grandchild.signals'), 'utf8')).toContain('SIGTERM');
          expect(signals).toEqual([{ pgid: handle.identity.processGroupId, signal: 'SIGKILL' }]);
        }
        matrix.record('pass', { result: await handle.result, lastSnapshot: handle.query() });
      });
    }, 20_000);
  }

  for (const mode of ['pending-ack', 'released'] as const) {
    it(`[case:host-loss-${mode}] restarts from durable facts after the real Host is killed`, async () => {
      await withProcessMatrix(`host-loss-${mode}`, async matrix => {
        const f = await openProcessRecoveryFixture();
        let complete = false;
        const child = fork(fileURLToPath(new URL('../../helpers/command-process-host-loss.ts', import.meta.url)),
          [join(matrix.root, 'forbidden'), matrix.root, matrixWriter], {
            execArgv: ['--no-warnings', '--import', fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url))],
            env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          });
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        try {
          await matrix.watch(child.pid!, 'test-host');
          const identity = await new Promise<CommandProcessIdentity>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Host identity timeout')), 5_000);
            child.once('message', value => { clearTimeout(timeout); resolve(value as CommandProcessIdentity); });
            child.once('error', error => { clearTimeout(timeout); reject(error); });
          });
          await matrix.own(identity);
          f.session.transactWrite('matrix.host-confirm', () => f.createResources().confirmLaunchInTransaction(f.identity, identity));
          if (mode === 'released') { child.send({ release: true }); await matrix.writersReady(); }
          child.kill('SIGKILL');
          await closed;
          const recovered = await f.recover();
          expect(recovered.state).toMatchObject({ status: 'complete' });
          expect(recovered.evidence).toMatchObject({ status: 'reconciled', taskPassed: false, newAttemptCreated: false });
          expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual({ n: 0 });
          expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
          expect(await matrix.members(identity)).toEqual([]);
          expect(await f.recover()).toMatchObject({ state: { status: 'complete' } });
          matrix.record('pass', { recovered, hostExit: { code: child.exitCode, signal: child.signalCode } });
          matrix.resource(f.snapshot());
          complete = true;
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await closed;
          if (complete) f.close(); else { matrix.resource(f.snapshot()); f.session.close(); }
        }
      });
    }, 25_000);
  }
});
