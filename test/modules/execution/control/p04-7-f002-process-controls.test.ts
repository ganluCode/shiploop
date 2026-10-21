import { describe, expect, it } from 'vitest';
import {
  forceStopControlledGroup,
  matchesSupervisorIdentity,
  type StopEscalationProbe,
  type SupervisedProcessRow,
} from '../../../../packages/core/src/adapters/process/stop-escalation.ts';
import { createCommandProcessAdapter } from '../../../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessIdentity } from '../../../../packages/core/src/ports/command-process.ts';

const identity: CommandProcessIdentity = {
  launchId: '11111111-1111-4111-8111-111111111111',
  pid: 42,
  processGroupId: 42,
  startTime: 'Mon Oct 20 12:01:22 2026',
};
const matchingRow: SupervisedProcessRow = {
  pid: identity.pid,
  processGroupId: identity.processGroupId,
  startTime: identity.startTime,
  command: `/usr/bin/node command-supervisor.js ${identity.launchId}`,
};
const budgets = { confirmMs: 25, pollMs: 1 };

function probe(overrides: Partial<StopEscalationProbe> = {}): StopEscalationProbe {
  return {
    readSupervisorRow: async () => matchingRow,
    listGroupMembers: async () => [],
    signalGroup: () => true,
    delay: async () => {},
    ...overrides,
  };
}

describe('P04-7 / F-002 supervised process-group stopping', () => {
  it('[case:identity-fencing-before-signal] refuses missing, mismatched, or failed identity probes without signalling', async () => {
    let signals = 0;
    const base = { ...probe({ signalGroup: () => { signals++; return true; } }) };
    await expect(forceStopControlledGroup(identity, {
      ...base,
      readSupervisorRow: async () => undefined,
    }, budgets)).resolves.toMatchObject({ confirmed: false, escalated: false, identity: 'probe_failed' });
    await expect(forceStopControlledGroup(identity, {
      ...base,
      readSupervisorRow: async () => ({ ...matchingRow, startTime: 'reused-pid' }),
    }, budgets)).resolves.toMatchObject({ confirmed: false, escalated: false, identity: 'mismatched' });
    await expect(forceStopControlledGroup(identity, {
      ...base,
      readSupervisorRow: async () => { throw new Error('ps unavailable'); },
    }, budgets)).resolves.toMatchObject({ confirmed: false, escalated: false, identity: 'probe_failed' });
    expect(signals).toBe(0);
    expect(matchesSupervisorIdentity(matchingRow, identity)).toBe(true);
  });

  it('[case:group-absence-includes-descendants] keeps an exited supervisor unconfirmed while any group member remains', async () => {
    let scans = 0;
    const outcome = await forceStopControlledGroup(identity, probe({
      readSupervisorRow: async () => null,
      listGroupMembers: async () => scans++ === 0 ? [99] : [99],
    }), { confirmMs: 2, pollMs: 1 });
    expect(outcome).toMatchObject({ confirmed: false, escalated: false, identity: 'absent' });
    expect(scans).toBeGreaterThan(0);
  });

  it('[case:signal-failure-is-uncertain] treats a failed group signal and census failure as unconfirmed', async () => {
    const outcome = await forceStopControlledGroup(identity, probe({
      signalGroup: () => { throw new Error('ESRCH'); },
      listGroupMembers: async () => undefined,
    }), budgets);
    expect(outcome).toMatchObject({ confirmed: false, escalated: false, identity: 'matched' });
  });

  it.skipIf(process.platform !== 'darwin')('[case:recovery-stop-is-idempotent] repeats share one bounded escalation for one identity', async () => {
    let signals = 0;
    let scans = 0;
    const adapter = createCommandProcessAdapter({ stopConfirmMs: 100, stopProbe: probe({
      signalGroup: () => { signals++; return true; },
      listGroupMembers: async () => scans++ === 0 ? [identity.pid] : [],
    }) });
    const first = adapter.recoverStop!(identity);
    const second = adapter.recoverStop!(identity);
    await expect(Promise.all([first, second])).resolves.toEqual([{ confirmed: true }, { confirmed: true }]);
    expect(signals).toBe(1);
  });
});
