import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { StopEscalationProbe } from '../../../packages/core/src/adapters/process/stop-escalation.ts';
import { openProcessRecoveryFixture } from '../../helpers/process-recovery-matrix.ts';
import { processRows, until, withProcessMatrix } from '../../helpers/process-matrix.ts';

const faults = ['pid', 'pgid', 'start-time', 'probe', 'stop-evidence', 'launch-receipt', 'native-occupancy', 'flush', 'expired'] as const;
describe.skipIf(process.platform !== 'darwin')('P04-7 real resources conservative fault matrix', () => {
  for (const fault of faults) {
    it(`[case:${fault}] retains all occupancy and blocks replacement until verified reconciliation`, async () => {
      await withProcessMatrix(`resource-${fault}`, async matrix => {
        const f = await openProcessRecoveryFixture(fault !== 'launch-receipt',
          fault === 'native-occupancy' ? 'started' : fault === 'flush' ? 'flush-failed' : 'stopped');
        let complete = false;
        try {
          const handle = await matrix.start('stubborn', {
            confirm: async identity => {
              if (fault !== 'launch-receipt') {
                f.session.transactWrite('matrix.confirm', () => f.createResources().confirmLaunchInTransaction(f.identity, identity));
              } else {
                // Crash/corruption fixture: an OS identity survives without its durable launch receipt.
                f.session.database.prepare('UPDATE workspace_leases SET process_identity = ? WHERE owner_id = ?')
                  .run(JSON.stringify({ schemaVersion: 2, ...identity }), f.identity.attemptId);
              }
            },
          });
          await matrix.writersReady();
          const persistedIdentity = JSON.stringify({ schemaVersion: 2, ...handle.identity });
          if (fault === 'pid' || fault === 'start-time') {
            const bad = { schemaVersion: 2, ...handle.identity };
            // PID points at the still-live test runner; no signal may reach its group.
            if (fault === 'pid') { bad.pid = process.pid; bad.processGroupId = process.pid; }
            if (fault === 'start-time') bad.startTime = 'Mon Jan  1 00:00:00 2001';
            f.session.database.prepare('UPDATE workspace_leases SET process_identity = ? WHERE owner_id = ?')
              .run(JSON.stringify(bad), f.identity.attemptId);
          }
          if (fault === 'expired') {
            f.advance(600_001);
            expect(f.expireLeases()).toBe(1); // One expired Attempt, three retained resource leases.
            expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases WHERE state = ?', 'quarantined')).toEqual({ n: 3 });
          }
          const signals: unknown[] = [];
          const probe: StopEscalationProbe = {
            async readSupervisorRow(pid) {
              if (fault === 'probe') return undefined;
              const row = (await processRows()).find(row => row.pid === pid);
              return row && fault === 'pgid' ? { ...row, processGroupId: row.processGroupId + 1 } : row ?? null;
            },
            async listGroupMembers(pgid) {
              if (fault === 'stop-evidence') return undefined;
              return (await processRows()).filter(row => row.processGroupId === pgid).map(row => row.pid);
            },
            signalGroup(pgid, signal) {
              // These injections exercise refusal without changing the actual writer's lifetime.
              signals.push({ pgid, signal });
              if (fault === 'native-occupancy' || fault === 'flush') {
                try { process.kill(-pgid, signal); return true; } catch { return false; }
              }
              return false;
            },
            delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
          };
          const recoveryProcess = createCommandProcessAdapter({ stopConfirmMs: 100, stopProbe: probe });
          // Missing census evidence must remain unknown even once the real process has stopped.
          if (fault === 'stop-evidence') { await handle.cancel(); await handle.result; }
          const recovered = await f.recover(recoveryProcess);
          expect(recovered.state).toEqual({ status: 'blocked', reason: 'workspace_reconciliation_required' });
          expect(recovered.evidence).toMatchObject({ status: 'quarantined', taskPassed: false, newAttemptCreated: false });
          const expectedGap = {
            pid: 'startup_stop_unconfirmed', pgid: 'startup_stop_unconfirmed', 'start-time': 'startup_stop_unconfirmed',
            probe: 'startup_stop_unconfirmed', 'stop-evidence': 'startup_stop_unconfirmed',
            'launch-receipt': 'launch_receipt_missing', 'native-occupancy': 'native_session_occupancy',
            flush: 'recording_gaps_present', expired: 'stop_unconfirmed',
          }[fault];
          expect(recovered.evidence.gaps).toContain(expectedGap);
          expect(recovered.evidence.manualNextSteps.length).toBeGreaterThan(0);
          if (fault === 'native-occupancy' || fault === 'flush') {
            expect(await matrix.members(handle.identity)).toEqual([]);
            expect(recovered.evidence.startupGaps).not.toContain('stop_unconfirmed');
          }
          if (fault === 'native-occupancy') expect(recovered.evidence.runtime.nativeSessionOccupied).toBe(true);
          if (fault === 'flush') expect(recovered.evidence.recording.gaps).toContain('recording_flush_failed');
          expect(f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'")).toEqual({ n: 3 });
          expect(f.query("SELECT status FROM managed_workspaces")).toEqual({ status: 'quarantined' });
          expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
          expect(() => f.claimTask('t-2')).toThrow();
          if (['pid', 'pgid', 'start-time', 'probe', 'stop-evidence'].includes(fault)) expect(signals).toEqual([]);
          if (!['stop-evidence', 'native-occupancy', 'flush'].includes(fault)) {
            const before = readFileSync(join(matrix.root, 'grandchild.writes'), 'utf8').length;
            await until(() => readFileSync(join(matrix.root, 'grandchild.writes'), 'utf8').length > before,
              'quarantined writer remains owned and writing');
            expect((await matrix.members(handle.identity)).length).toBe(4);
          }
          matrix.record('manual_required', { fault, recovered, signals });
          matrix.resource({ phase: 'quarantined', ...f.snapshot() });
          // Final test ownership cleanup cannot authorize a business retry or erase a gap.
          // The durable quarantine is exported before removing only the test-owned fixture.
          f.session.database.prepare('UPDATE workspace_leases SET process_identity = ? WHERE owner_id = ?')
            .run(persistedIdentity, f.identity.attemptId);
          await handle.cancel();
          expect(await handle.result).toMatchObject({ stop: { confirmed: true } });
          expect(await matrix.members(handle.identity)).toEqual([]);
          matrix.record('pass', { phase: 'owned-final-stop', result: await handle.result });
          matrix.resource({ phase: 'after-final-stop-business-quarantine-retained', ...f.snapshot() });
          // Only test-owned SQLite/Git objects are removed after all physical writers are absent.
          complete = true;
        } finally {
          if (complete) { const root = f.box.root; f.close(); matrix.resource({ phase: 'fixture-cleanup', root, removed: !existsSync(root) }); }
          else { matrix.resource({ phase: 'failure-preserved', ...f.snapshot() }); f.session.close(); }
        }
      });
    }, 25_000);
  }
});
