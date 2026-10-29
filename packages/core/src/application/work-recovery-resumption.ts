/**
 * P07-1 / F-008：显式 resume 前的受信恢复积压结算（application 层）。
 *
 * 只处理「重启诊断已隔离、且存在 pending task_commit 回执」的现场：
 * 1. 从持久恢复观察中取出目标 Run/Batch/Feature 下的受信补回执积压来源；
 * 2. 逐个调用恢复核对的显式 resolve()：全部 pending 提交实测 matched 且其余
 *    事实（停止证据/工作区/Artifact/记录水位/派发身份）通过同一标准核验时，
 *    复用 F-007 已核对的副作用事实在同一收尾事务内补回执并释放隔离；任何
 *    未知/未执行/证据缺失都保持原隔离，不启动模型、不重放 Git；
 * 3. 全部积压解决后重评启动恢复状态（幂等管道），恢复完成才解除 Host 的
 *    startup_recovery 门控；仍有未解决隔离时保持 blocked，由既有门控拒绝。
 *
 * 本模块不创建 Attempt、不写预算、不启动 Runtime、不切换 Session；预算与
 * deadline 的接续由显式 resume 及既有认领链路按原规则累计。
 */
import type { WorkStartupRecoveryEvidence, WorkStartupRecoveryState } from '../ports/work-startup-recovery.js';
import type { WorkRecoveryReconciliationResult } from '../ports/work-recovery-reconciliation.js';

export interface WorkRecoveryResumptionDeps {
  readonly startupRecovery: {
    readonly retry: () => Promise<WorkStartupRecoveryState>;
    readonly state: () => WorkStartupRecoveryState;
  };
  readonly sources: {
    loadRunReceiptBacklogSources?(projectId: string, targetKind: 'run' | 'batch' | 'feature',
      targetId: string): readonly WorkStartupRecoveryEvidence[];
  };
  readonly reconciler: {
    resolve(source: WorkStartupRecoveryEvidence): Promise<WorkRecoveryReconciliationResult>;
  };
  /** 恢复完成后恢复周期调度（幂等；未装配时仅依赖 resume 唤醒信号）。 */
  readonly onRecoveryComplete?: () => void;
}

export interface WorkRecoveryResumptionService {
  /** 返回本次是否实际结算了至少一个受信回执积压。 */
  settleReceiptBacklog(input: { projectId: string; targetKind: 'run' | 'batch' | 'feature'; targetId: string }): Promise<{ settled: boolean }>;
}

export function createWorkRecoveryResumptionService(deps: WorkRecoveryResumptionDeps): WorkRecoveryResumptionService {
  return {
    async settleReceiptBacklog(input) {
      const sources = deps.sources.loadRunReceiptBacklogSources?.(input.projectId, input.targetKind, input.targetId) ?? [];
      if (sources.length === 0) return { settled: false };
      let settled = false;
      const outcomes: WorkRecoveryReconciliationResult[] = [];
      for (const source of sources) {
        const outcome = await deps.reconciler.resolve(source);
        outcomes.push(outcome);
        if (outcome.status === 'reconciled' && !outcome.alreadyReconciled) settled = true;
      }
      if (!settled) return { settled: false };
      const state = await deps.startupRecovery.retry();
      if (state.status === 'complete') deps.onRecoveryComplete?.();
      return { settled };
    },
  };
}
