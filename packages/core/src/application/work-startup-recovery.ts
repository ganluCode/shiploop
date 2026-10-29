import { observeWithin } from './execution-supervision.js';
import type { PlanningStartupRecoveryResult } from '../ports/planning-recovery.js';
import type { WorkStartupRecoveryEvidence, WorkStartupRecoveryOptions, WorkStartupRecoveryState, WorkStartupRecoveryTarget } from '../ports/work-startup-recovery.js';

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
  async function stopAll(target: WorkStartupRecoveryTarget): Promise<{
    readonly confirmed: boolean;
    readonly reason: 'stop_failed' | 'stop_unconfirmed' | null;
  }> {
    if (target.processIdentity === null) return { confirmed: false, reason: 'stop_unconfirmed' };
    const identities = [target.processIdentity, ...(target.verificationProcesses ?? [])];
    // A bounded census is stopped sequentially; each adapter verifies PID birth and descendants.
    let confirmed = true;
    let failed = false;
    for (const identity of identities) {
      try {
        const stop = await observeWithin(Promise.resolve().then(() => options.process.recoverStop?.(identity)), 5_000);
        if (stop?.confirmed !== true) confirmed = false;
      } catch { confirmed = false; failed = true; }
    }
    return { confirmed, reason: failed ? 'stop_failed' : confirmed ? null : 'stop_unconfirmed' };
  }
  async function run(): Promise<WorkStartupRecoveryState> {
    try {
      /* P05-1 / F-010：先 fence 撤销旧写入资格，再执行规划窗口恢复（受信制品
       * 核验 + 幂等补完），随后重新 fence 取得补完后的干净扫描；被补完的
       * planning Attempt 不再进入通用逐个核对（planningCompletionFinalized）。 */
      let scan = options.store.fence();
      let planning: PlanningStartupRecoveryResult | null = null;
      if (options.planning !== undefined) {
        planning = await options.planning.recover();
        if (planning.outcomes.length > 0) scan = options.store.fence();
      }
      const pending = new Map<string, WorkStartupRecoveryEvidence>();

      const recheck = async (previous: WorkStartupRecoveryEvidence): Promise<WorkStartupRecoveryEvidence> => {
        // A durable failure is a historical fact, not a release token. On a later
        // controlled startup, recheck only the same committed process identity.
        if (previous.stopConfirmed || previous.processIdentity === null) return previous;
        const gaps = previous.gaps.filter(gap => gap !== 'stop_unconfirmed' && gap !== 'stop_failed');
        let stopConfirmed = false;
        try {
          const stop = await stopAll(previous);
          stopConfirmed = stop.confirmed;
          if (stop.reason !== null) gaps.push(stop.reason);
        } catch { gaps.push('stop_failed'); }
        return {
          ...previous,
          stopConfirmed,
          observedAtUtcMs: now(),
          observationRevision: (previous.observationRevision ?? 1) + 1,
          observationKind: 'reprobe',
          previousObservationAtUtcMs: previous.observedAtUtcMs,
          gaps: [...new Set(gaps)],
        };
      };

      const persistObservation = async (projectId: string, previous: WorkStartupRecoveryEvidence | null,
        evidence: WorkStartupRecoveryEvidence): Promise<WorkStartupRecoveryEvidence> => {
        const changed = previous === null || evidence.observationRevision !== previous.observationRevision;
        if (changed) options.store.observed(evidence, null);
        const evidenceRef = await options.publishEvidence(projectId, evidence);
        options.store.observed(evidence, evidenceRef);
        return evidence;
      };

      for (const target of scan.targets) {
        if (options.store.planningCompletionFinalized?.(target.attemptId) === true) continue;
        const previous = options.store.readObservation(target);
        let evidence = previous;
        if (evidence === null) {
          const gaps = [...target.gaps];
          let stopConfirmed = false;
          if (target.processIdentity !== null && gaps.length === 0) {
            try {
              const stop = await stopAll(target);
              stopConfirmed = stop.confirmed;
              if (stop.reason !== null) gaps.push(stop.reason);
            } catch { gaps.push('stop_failed'); }
          } else if (target.processIdentity === null) gaps.push('process_identity_missing');
          evidence = { ...target, schemaVersion: 1, kind: 'work-startup-recovery',
            stopConfirmed, observedAtUtcMs: now(), workspaceReconciled: false,
            gaps: [...new Set([...gaps, 'workspace_not_reconciled'])] } satisfies WorkStartupRecoveryEvidence;
        } else {
          evidence = await recheck(evidence);
        }
        pending.set(evidence.attemptId, await persistObservation(target.projectId, previous, evidence));
      }
      for (const previous of scan.reconcilable) {
        if (options.store.planningCompletionFinalized?.(previous.attemptId) === true) continue;
        const evidence = await recheck(previous);
        pending.set(evidence.attemptId, await persistObservation(previous.projectId, previous, evidence));
      }

      let reconciled = scan.dispatchBlocked !== true;
      for (const evidence of pending.values()) {
        if (options.reconcile === undefined) { reconciled = false; continue; }
        const result = await options.reconcile(evidence);
        if (result.status !== 'reconciled') reconciled = false;
      }
      if (planning !== null && planning.status === 'blocked') {
        state = { status: 'blocked', reason: 'planning_recovery_required' };
      } else state = scan.limited ? { status: 'blocked', reason: 'scan_limit' }
        : options.reconcile === undefined
          ? (scan.retained || scan.dispatchBlocked ? { status: 'blocked', reason: 'workspace_reconciliation_required' }
            : { status: 'complete', reason: null })
          : (reconciled ? { status: 'complete', reason: null }
            : { status: 'blocked', reason: 'workspace_reconciliation_required' });
    } catch (error) {
      state = { status: 'blocked', reason: 'recovery_failed' };
      // If SQLite itself cannot accept evidence, propagate and refuse Host startup.
      options.store.failed();
    }
    return state;
  }
}
