import { describe, expect, it } from 'vitest';
import {
  forceStopControlledGroup,
  type StopEscalationProbe,
  type SupervisedProcessRow,
} from '../../../../packages/core/src/adapters/process/stop-escalation.ts';
import { createVerificationStopControl } from '../../../../packages/core/src/application/verification-stop-control.ts';
import type { CommandProcessIdentity } from '../../../../packages/core/src/ports/command-process.ts';

const identity: CommandProcessIdentity = {
  launchId: '11111111-1111-4111-8111-111111111111',
  pid: 42,
  processGroupId: 42,
  startTime: 'Mon Oct 20 12:01:22 2026',
};
const matchingRow: SupervisedProcessRow = {
  pid: 42,
  processGroupId: 42,
  startTime: identity.startTime,
  command: `/usr/bin/node supervisor.js ${identity.launchId}`,
};
const key = {
  projectId: 'project-1', runId: 'run-1', batchId: 'batch-1', attemptId: 'attempt-1',
  executionVersion: 1, operation: 'check',
} as const;

function probe(overrides: Partial<StopEscalationProbe> = {}): StopEscalationProbe {
  return {
    readSupervisorRow: async () => matchingRow,
    listGroupMembers: async () => [],
    signalGroup: () => true,
    delay: async () => {},
    ...overrides,
  };
}

describe('P04-7 / F-007 deterministic stop-control regression', () => {
  it('[case:stop-identity-and-confirmation-matrix] fences PID reuse, startTime, PGID, launchId, failed probes, failed SIGKILL, and budget exhaustion', async () => {
    let signals = 0;
    const base = probe({ signalGroup: () => { signals += 1; return true; } });
    const failedProbe = await forceStopControlledGroup(identity, {
      ...base, readSupervisorRow: async () => undefined,
    }, { confirmMs: 5, pollMs: 1 });
    const reusedPid = await forceStopControlledGroup(identity, {
      ...base, readSupervisorRow: async () => ({ ...matchingRow, startTime: 'reused-pid' }),
    }, { confirmMs: 5, pollMs: 1 });
    const wrongGroup = await forceStopControlledGroup(identity, {
      ...base, readSupervisorRow: async () => ({ ...matchingRow, processGroupId: 99 }),
    }, { confirmMs: 5, pollMs: 1 });
    const wrongLaunch = await forceStopControlledGroup(identity, {
      ...base, readSupervisorRow: async () => ({ ...matchingRow, command: '/usr/bin/node supervisor.js other-launch' }),
    }, { confirmMs: 5, pollMs: 1 });
    expect([failedProbe, reusedPid, wrongGroup, wrongLaunch]).toEqual([
      { confirmed: false, escalated: false, identity: 'probe_failed' },
      { confirmed: false, escalated: false, identity: 'mismatched' },
      { confirmed: false, escalated: false, identity: 'mismatched' },
      { confirmed: false, escalated: false, identity: 'mismatched' },
    ]);
    expect(signals).toBe(0);

    const absent = await forceStopControlledGroup(identity, probe({ readSupervisorRow: async () => null }), {
      confirmMs: 5, pollMs: 1,
    });
    expect(absent).toMatchObject({ confirmed: true, escalated: false, identity: 'absent' });

    let clock = 100;
    const exhausted = await forceStopControlledGroup(identity, probe({
      listGroupMembers: async () => [99],
      delay: async () => { clock += 1; },
      nowUtcMs: () => clock,
    }), { confirmMs: 2, pollMs: 1 });
    expect(exhausted).toMatchObject({ confirmed: false, escalated: true, identity: 'matched' });

    const undelivered = await forceStopControlledGroup(identity, probe({
      signalGroup: () => false,
      nowUtcMs: () => 200,
    }), { confirmMs: 5, pollMs: 1 });
    expect(undelivered).toMatchObject({ confirmed: false, escalated: false, identity: 'matched' });
  });

  it('[case:supervisor-exit-and-group-census] retains uncertainty when the supervisor is gone but a descendant remains or census fails', async () => {
    let clock = 10;
    let scans = 0;
    const remaining = await forceStopControlledGroup(identity, probe({
      readSupervisorRow: async () => null,
      listGroupMembers: async () => { scans += 1; return [99]; },
      delay: async () => { clock += 1; },
      nowUtcMs: () => clock,
    }), { confirmMs: 2, pollMs: 1 });
    expect(remaining).toMatchObject({ confirmed: false, escalated: false, identity: 'absent' });
    expect(scans).toBeGreaterThan(1);

    const censusFailed = await forceStopControlledGroup(identity, probe({
      listGroupMembers: async () => undefined,
      nowUtcMs: () => 20,
      delay: async () => {},
    }), { confirmMs: 0, pollMs: 1 });
    expect(censusFailed).toMatchObject({ confirmed: false, escalated: true, identity: 'matched' });
  });

  it('[case:verifier-stop-evidence-states] distinguishes not-started, unconfirmed, timeout, and cancelled-race evidence', async () => {
    const control = createVerificationStopControl({ waitMs: 1 });

    const notStarted = control.begin(key);
    const notStartedStop = control.stop({ projectId: key.projectId, targetKind: 'run', targetId: key.runId });
    expect(notStarted.signal.aborted).toBe(true);
    notStarted.complete();
    await expect(notStartedStop).resolves.toEqual([expect.objectContaining({
      state: 'not_started', stopConfirmed: true, checks: [],
    })]);

    const unconfirmed = control.begin({ ...key, attemptId: 'attempt-2' });
    const unconfirmedStop = control.stop({ projectId: key.projectId, targetKind: 'run', targetId: key.runId });
    unconfirmed.record({
      checkKey: 'check-1', launched: true, stopConfirmed: false, exitCode: null,
      signal: null, forced: null, reason: 'stop_unconfirmed', gaps: ['process_census_unknown'],
    });
    unconfirmed.complete();
    await expect(unconfirmedStop).resolves.toEqual([expect.objectContaining({
      state: 'unconfirmed', stopConfirmed: false,
      gaps: expect.arrayContaining(['process_census_unknown', 'verifier_stop_unconfirmed']),
    })]);

    const timedOut = control.begin({ ...key, attemptId: 'attempt-3' });
    const timedOutEvidence = await control.stop({ projectId: key.projectId, targetKind: 'run', targetId: key.runId });
    expect(timedOut.signal.aborted).toBe(true);
    expect(timedOutEvidence).toEqual([expect.objectContaining({
      state: 'unconfirmed', stopConfirmed: false, gaps: ['verifier_stop_wait_timeout'],
    })]);
    timedOut.complete();

    const raced = control.begin({ ...key, attemptId: 'attempt-4' });
    expect(raced.signal.aborted).toBe(true);
    raced.complete();
  });
});
