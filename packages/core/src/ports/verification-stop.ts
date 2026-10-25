/**
 * P03-9 / F-003：Verifier 停止的窄端口。
 *
 * Verifier 的既有停止入口是受监督 CommandProcess 的 AbortSignal（进程组宽限/
 * 升级/身份核验全部由 CommandProcess 承担）。本端口只负责按 Project/Run/Batch/
 * Attempt/operation 登记活动验证批次、请求中止并在有界预算内收集停止证据；
 * 它不是新的进程管理器，也不写 VerificationBatch/CheckResult 业务表。
 */

export interface VerificationStopKey {
  readonly projectId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
  readonly operation: string;
}

export interface VerificationCheckStopRecord {
  readonly checkKey: string;
  /** false＝该检查没有启动受控进程（计划未就绪/已被取消而未启动）。 */
  readonly launched: boolean;
  readonly stopConfirmed: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** true＝观察到强制终止；null＝无法判定（绝不填 false 冒充未升级）。 */
  readonly forced: boolean | null;
  readonly reason: string | null;
  readonly gaps: readonly string[];
}

export interface VerificationStopEvidence {
  readonly key: VerificationStopKey;
  readonly state: 'stopped' | 'unconfirmed' | 'not_started';
  readonly stopConfirmed: boolean;
  readonly checks: readonly VerificationCheckStopRecord[];
  readonly gaps: readonly string[];
}

export interface VerificationStopRegistration {
  readonly signal: AbortSignal;
  /** 记录单个检查的停止观察；可多次调用（顺序执行的多项检查）。 */
  record(record: VerificationCheckStopRecord): void;
  /** 验证批次结束（正常完成、失败或已停止）；之后停止请求不再等待该批次。 */
  complete(): void;
}

export interface VerificationStopControl {
  begin(key: VerificationStopKey): VerificationStopRegistration;
  /** 请求中止匹配的活动验证批次并在有界预算内返回停止证据。 */
  stop(input: {
    readonly projectId: string;
    readonly targetKind: 'run' | 'batch' | 'feature';
    readonly targetId: string;
  }): Promise<readonly VerificationStopEvidence[]>;
}
