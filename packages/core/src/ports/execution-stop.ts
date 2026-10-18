/**
 * P03-9 / F-003：Run/Batch 取消的停止证据与停止控制端口。
 *
 * 契约要点：
 * - 取消回执/停止 operation 只表达意图；真正的进程停止由受信装配的窄控制端口
 *   在短事务提交后执行，并复用既有 CommandProcess 身份/组终止核验；
 * - 证据 Artifact 关联 Project/Run/Attempt/operation、executionStage、实际
 *   退出码/信号、强制停止情况与记录缺口；未知字段保持 null，绝不填 0；
 * - 只有停止经核验才报告 stopped；身份不符、旧组不可核对、探测失败或仍可能
 *   写文件时报告 unconfirmed，由调用方保留占用并记录 interrupted/quarantined；
 * - 本端口不属于 Runtime/Verifier 业务表写入者，也不另建进程管理器。
 */

export const EXECUTION_STOP_EVIDENCE_SCHEMA_VERSION = 1;
export const EXECUTION_STOP_EVIDENCE_KIND = 'execution-stop';

export type ExecutionStopTargetKind = 'run' | 'batch';

/** 取消事务提交后交给停止控制的唯一身份（目标从持久 operation 读取）。 */
export interface ExecutionStopRequest {
  readonly projectId: string;
  readonly stopOperationId: string;
}

export interface ExecutionStopAttemptEvidence {
  readonly attemptId: string;
  readonly taskId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly executionStage: string | null;
  readonly attemptStatus: string | null;
  readonly state: 'stopped' | 'unconfirmed' | 'not_started';
  readonly stopConfirmed: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** true＝观察到强制终止；null＝无法判定（绝不填 false 冒充未升级）。 */
  readonly forced: boolean | null;
  readonly settlementRef: string | null;
  readonly gaps: readonly string[];
}

export interface ExecutionStopEvidence {
  readonly schemaVersion: typeof EXECUTION_STOP_EVIDENCE_SCHEMA_VERSION;
  readonly kind: typeof EXECUTION_STOP_EVIDENCE_KIND;
  readonly projectId: string;
  readonly stopOperationId: string;
  readonly targetKind: ExecutionStopTargetKind;
  readonly targetId: string;
  readonly batchId: string;
  readonly runId: string | null;
  readonly requestedAtUtc: string;
  readonly checkedAtUtc: string;
  readonly outcome: 'stopped' | 'unconfirmed';
  readonly stopConfirmed: boolean;
  readonly forced: boolean | null;
  readonly attempts: readonly ExecutionStopAttemptEvidence[];
  readonly verifiers: readonly import('./verification-stop.js').VerificationStopEvidence[];
  readonly gaps: readonly string[];
}

export interface ExecutionStopOutcome {
  readonly stopConfirmed: boolean;
  readonly evidenceRef: string;
  readonly evidence: ExecutionStopEvidence;
  readonly operationStatus: 'stopped' | 'uncertain';
  readonly interruptedAttemptIds: readonly string[];
}

/** 受信装配的停止控制（不传则取消保持 F-002 的意图/operation 语义）。 */
export interface ExecutionStopControlPort {
  /** 取消事务提交后调用；重复调用幂等，不对终态 operation 做写入。 */
  stop(input: ExecutionStopRequest): Promise<ExecutionStopOutcome | null>;
}
