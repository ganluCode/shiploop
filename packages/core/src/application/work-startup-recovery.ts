import { observeWithin } from './execution-supervision.js';
import type { PlanningStartupRecoveryResult } from '../ports/planning-recovery.js';
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
      for (const target of scan.targets) {
        if (options.store.planningCompletionFinalized?.(target.attemptId) === true) continue;
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
      for (const evidence of scan.reconcilable) {
        if (options.store.planningCompletionFinalized?.(evidence.attemptId) === true) continue;
        pending.set(evidence.attemptId, evidence);
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
