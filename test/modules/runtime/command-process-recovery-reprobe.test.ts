import { describe, expect, it, vi } from 'vitest';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { StopEscalationProbe } from '../../../packages/core/src/adapters/process/stop-escalation.ts';
import { forceStopControlledGroup } from '../../../packages/core/src/adapters/process/stop-escalation.ts';

const identity = { launchId: '11111111-2222-4333-8444-555555555555', pid: 4242,
  processGroupId: 4242, startTime: 'Mon Oct 10 10:10:10 2026' };

describe('stopped group recovery census', () => {
  it('confirms a natural exit racing with failed delivery only after fresh supervisor absence proof', async () => {
    let reads = 0;
    const result = await forceStopControlledGroup(identity, {
      readSupervisorRow: async () => ++reads === 1 ? { ...identity,
        command: `node supervisor.js ${identity.launchId}` } : null,
      listGroupMembers: async () => [], signalGroup: () => false, delay: async () => {},
    }, { confirmMs: 100, pollMs: 10 });
    expect(result).toEqual({ confirmed: true, escalated: false, identity: 'matched' });
    expect(reads).toBe(2);
  });
  it.each(['absent', 'matched'] as const)('rechecks a previously %s group without repeating a signal', async state => {
    let present = true;
    let now = 0;
    const signal = vi.fn(() => true);
    const probe: StopEscalationProbe = {
      readSupervisorRow: async () => state === 'absent' ? null : { ...identity,
        command: `node supervisor.js ${identity.launchId}` },
      listGroupMembers: async () => present ? [4243] : [],
      signalGroup: signal,
      nowUtcMs: () => now,
      delay: async ms => { now += ms; },
    };
    const adapter = createCommandProcessAdapter({ stopProbe: probe, stopConfirmMs: 100 });
    expect(await adapter.recoverStop!(identity)).toEqual({ confirmed: false });
    expect(signal).toHaveBeenCalledTimes(state === 'matched' ? 1 : 0);
    present = false;
    expect(await adapter.recoverStop!(identity)).toEqual({ confirmed: true });
    expect(await adapter.recoverStop!(identity)).toEqual({ confirmed: true });
    expect(signal).toHaveBeenCalledTimes(state === 'matched' ? 1 : 0);
  });

  it('never turns a mismatched supervisor into stop proof', async () => {
    const members = vi.fn(async () => []);
    const signal = vi.fn(() => true);
    const adapter = createCommandProcessAdapter({ stopConfirmMs: 100, stopProbe: {
      readSupervisorRow: async () => ({ ...identity, startTime: 'reused', command: 'unrelated' }),
      listGroupMembers: members, signalGroup: signal, delay: async () => {},
    } });
    expect(await adapter.recoverStop!(identity)).toEqual({ confirmed: false });
    expect(await adapter.recoverStop!(identity)).toEqual({ confirmed: false });
    expect(members).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });
});
