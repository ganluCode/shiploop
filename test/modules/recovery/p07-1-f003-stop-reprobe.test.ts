import { describe, expect, it, vi } from 'vitest';
import { createWorkStartupRecovery } from '../../../packages/core/src/application/work-startup-recovery.ts';
import type {
  WorkStartupRecoveryEvidence,
  WorkStartupRecoveryStore,
  WorkStartupRecoveryTarget,
} from '../../../packages/core/src/ports/work-startup-recovery.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { StopEscalationProbe } from '../../../packages/core/src/adapters/process/stop-escalation.ts';

const identity = {
  launchId: '11111111-2222-4333-8444-555555555555',
  pid: 4242,
  processGroupId: 4242,
  startTime: 'Mon Oct 10 10:10:10 2026',
} as const;

const target: WorkStartupRecoveryTarget = {
  projectId: 'project-1', runId: 'run-1', attemptId: 'attempt-1', owner: 'owner-1',
  hostInstanceId: 'host-1', executionVersion: 3, executionStage: 'runtime',
  processIdentity: identity, gaps: ['stop_unconfirmed'],
};

function evidence(): WorkStartupRecoveryEvidence {
  return {
    ...target, schemaVersion: 1, kind: 'work-startup-recovery', stopConfirmed: false,
    observedAtUtcMs: 100, workspaceReconciled: false, gaps: ['stop_unconfirmed', 'workspace_not_reconciled'],
    observationRevision: 1, observationKind: 'initial', previousObservationAtUtcMs: null,
  };
}

function storeFor(observation: WorkStartupRecoveryEvidence): WorkStartupRecoveryStore & {
  readonly observedCalls: Array<{ evidence: WorkStartupRecoveryEvidence; ref: string | null }>;
} {
  const observedCalls: Array<{ evidence: WorkStartupRecoveryEvidence; ref: string | null }> = [];
  return {
    observedCalls,
    fence: () => ({ targets: [], limited: false, retained: true, dispatchBlocked: false, reconcilable: [observation] }),
    readObservation: () => observation,
    observed: (next, evidenceRef) => { observedCalls.push({ evidence: next, ref: evidenceRef }); },
    failed: vi.fn(),
  };
}

describe('P07-1 F-003 bounded recovery reprobe', () => {
  it('rechecks an old stop_unconfirmed observation, appends evidence, and removes only the current stop gap after proof', async () => {
    const store = storeFor(evidence());
    const recoverStop = vi.fn(async () => ({ confirmed: true }));
    const published: WorkStartupRecoveryEvidence[] = [];
    const recovery = createWorkStartupRecovery({
      store,
      process: { recoverStop },
      publishEvidence: async (_projectId, next) => { published.push(next); return 'artifact-reprobe'; },
      reconcile: async () => ({ status: 'reconciled', gaps: [], evidenceRef: 'artifact-reprobe', alreadyReconciled: false }),
      nowUtcMs: () => 200,
    });

    await recovery.recover();

    expect(recoverStop).toHaveBeenCalledTimes(1);
    expect(store.observedCalls).toHaveLength(2);
    expect(store.observedCalls[0]!.evidence.stopConfirmed).toBe(true);
    expect(store.observedCalls[0]!.evidence.observationRevision).toBe(2);
    expect(store.observedCalls[0]!.evidence.observationKind).toBe('reprobe');
    expect(store.observedCalls[0]!.evidence.previousObservationAtUtcMs).toBe(100);
    expect(store.observedCalls[0]!.evidence.gaps).toEqual(['workspace_not_reconciled']);
    expect(store.observedCalls[0]!.ref).toBeNull();
    expect(store.observedCalls[1]!.ref).toBe('artifact-reprobe');
    expect(published[0]).toEqual(store.observedCalls[0]!.evidence);
    expect(recovery.state()).toEqual({ status: 'complete', reason: null });
  });

  it('keeps a failed reprobe bounded and retains the prior failure as current evidence', async () => {
    const old = evidence();
    const store = storeFor(old);
    const recoverStop = vi.fn(async () => ({ confirmed: false }));
    const recovery = createWorkStartupRecovery({
      store,
      process: { recoverStop },
      publishEvidence: async () => 'artifact-reprobe-failed',
      reconcile: async () => ({ status: 'quarantined', gaps: ['stop_unconfirmed'], evidenceRef: 'artifact-reprobe-failed', alreadyReconciled: false }),
      nowUtcMs: () => 300,
    });

    await recovery.recover();

    expect(recoverStop).toHaveBeenCalledTimes(1);
    expect(store.observedCalls[0]!.evidence.observationRevision).toBe(2);
    expect(store.observedCalls[0]!.evidence.observationKind).toBe('reprobe');
    expect(store.observedCalls[0]!.evidence.gaps).toEqual(expect.arrayContaining(['stop_unconfirmed', 'workspace_not_reconciled']));
    expect(old.observationRevision).toBe(1);
    expect(recovery.state()).toEqual({ status: 'blocked', reason: 'workspace_reconciliation_required' });
  });
});

describe('P07-1 F-003 retry after failed signal delivery', () => {
  it('rechecks group absence after an identity-matched signal was not delivered without sending a second signal', async () => {
    let groupPresent = true;
    let reads = 0;
    const signals: string[] = [];
    const probe: StopEscalationProbe = {
      readSupervisorRow: async () => ++reads === 1 ? { ...identity, command: `node supervisor.js ${identity.launchId}` } : null,
      listGroupMembers: async () => groupPresent ? [identity.pid] : [],
      signalGroup: () => { signals.push('SIGKILL'); return false; },
      delay: async () => {},
    };
    const adapter = createCommandProcessAdapter({ stopConfirmMs: 100, stopProbe: probe });

    expect(await adapter.recoverStop!(identity)).toEqual({ confirmed: false });
    groupPresent = false;
    expect(await adapter.recoverStop!(identity)).toEqual({ confirmed: true });
    expect(signals).toEqual(['SIGKILL']);
  });
});
