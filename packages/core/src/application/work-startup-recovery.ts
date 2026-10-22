import { observeWithin } from './execution-supervision.js';
import type { WorkStartupRecoveryEvidence, WorkStartupRecoveryOptions, WorkStartupRecoveryState } from '../ports/work-startup-recovery.js';

/** Conservative restart: no takeover, success settlement, workspace release or Runtime start. */
export function createWorkStartupRecovery(options: WorkStartupRecoveryOptions) {
  let state: WorkStartupRecoveryState = { status: 'idle', reason: null };
  let recovery: Promise<WorkStartupRecoveryState> | null = null;
  const now = options.nowUtcMs ?? Date.now;
  return {
    state: () => state,
    blocked: () => state.status !== 'idle' && state.status !== 'complete',
    enter() { if (state.status === 'idle') state = { status: 'recovering', reason: 'startup_recovery' }; },
    recover(): Promise<WorkStartupRecoveryState> {
      if (recovery !== null) return recovery;
      state = { status: 'recovering', reason: 'startup_recovery' };
      recovery = run();
      return recovery;
    },
  };
  async function run(): Promise<WorkStartupRecoveryState> {
    try {
      const scan = options.store.fence();
      const pending = new Map<string, WorkStartupRecoveryEvidence>();
      for (const target of scan.targets) {
        let evidence = options.store.readObservation(target);
        if (evidence === null) {
          const gaps = [...target.gaps];
          let stopConfirmed = false;
          if (target.processIdentity !== null && gaps.length === 0) {
            try {
              const stop = await observeWithin(Promise.resolve().then(() => options.process.recoverStop?.(target.processIdentity)), 5_000);
              stopConfirmed = stop?.confirmed === true;
              if (!stopConfirmed) gaps.push('stop_unconfirmed');
            } catch { gaps.push('stop_failed'); }
          } else if (target.processIdentity === null) gaps.push('process_identity_missing');
          evidence = { ...target, schemaVersion: 1, kind: 'work-startup-recovery',
            stopConfirmed, observedAtUtcMs: now(), workspaceReconciled: false,
            gaps: [...new Set([...gaps, 'workspace_not_reconciled'])] } satisfies WorkStartupRecoveryEvidence;
          // Save before crossing the Artifact boundary; restart reuses this observation.
          options.store.observed(evidence, null);
        }
        const evidenceRef = await options.publishEvidence(target.projectId, evidence);
        options.store.observed(evidence, evidenceRef);
        pending.set(evidence.attemptId, evidence);
      }
      for (const evidence of scan.reconcilable) pending.set(evidence.attemptId, evidence);

      let reconciled = scan.dispatchBlocked !== true;
      for (const evidence of pending.values()) {
        if (options.reconcile === undefined) { reconciled = false; continue; }
        const result = await options.reconcile(evidence);
        if (result.status !== 'reconciled') reconciled = false;
      }
      state = scan.limited ? { status: 'blocked', reason: 'scan_limit' }
        : options.reconcile === undefined
          ? (scan.retained || scan.dispatchBlocked ? { status: 'blocked', reason: 'workspace_reconciliation_required' }
            : { status: 'complete', reason: null })
          : (reconciled ? { status: 'complete', reason: null }
            : { status: 'blocked', reason: 'workspace_reconciliation_required' });
    } catch {
      state = { status: 'blocked', reason: 'recovery_failed' };
      // If SQLite itself cannot accept evidence, propagate and refuse Host startup.
      options.store.failed();
    }
    return state;
  }
}
