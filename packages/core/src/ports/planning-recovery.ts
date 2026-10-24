/**
 * P05-1 / F-010 规划重启核对与显式恢复契约（ports 契约层：窗口分类、扫描事实、
 * 幂等补完原语输入/输出与恢复结果形态；无 I/O）。
 *
 * 设计依据：input/p05-planning.md FR-4（取消、失败、恢复均保留候选与 Attempt
 * 事实，重放不得重复导入）、core-design/04 §5（恢复先核对副作用；终态 Run 不
 * 重开）、Pi 实验后的实施决定（原生续聊不等于检查点工具可重放；恢复能力以
 * 适配器实测为准）。
 *
 * 四个中断窗口（都只核对持久事实与 Core 受控制品，不重新调用模型）：
 * - candidate_publication_incomplete：候选文件已发布（受管 Artifact ready）但
 *   planning_contexts 登记未完成（status 仍 open）；
 * - candidate_registered_run_open：有效候选已登记（candidate_published）但 Run
 *   未结束（Attempt 仍非终态/中断，且存在可核对的 runtime-settlement 制品）；
 * - run_finished_observation_lost：Run 已终态（succeeded）但唤醒/观察丢失
 *   （派发归属/槽位/占用仍保留）；
 * - decision_receipt_lost：批准应用已提交（applied + coding Tasks 已导入）但
 *   响应丢失（同 commandId 重放返回原回执；本层只核对一致性）。
 *
 * 证据不足（制品缺失/身份漂移/停止不明/内容歧义）一律保留 blocked/interrupted
 * 与诊断，不补完、不重复导入、不启动 Runtime。
 */

/** 规划启动恢复操作名（内部端口，不是用户命令面）。 */
export const PLANNING_RECOVERY_OPERATION = 'planning.startup.recovery' as const;

export const PLANNING_RECOVERY_SCHEMA_VERSION = 1 as const;

/** 中断窗口词汇（固化诊断/事件负载；顺序稳定便于测试断言）。 */
export const PLANNING_RECOVERY_WINDOWS = [
  'candidate_publication_incomplete',
  'candidate_registered_run_open',
  'run_finished_observation_lost',
  'decision_receipt_lost',
] as const;
export type PlanningRecoveryWindow = (typeof PLANNING_RECOVERY_WINDOWS)[number];

/** 单个扫描行核验后仍缺失的证据（有界小写枚举，不含正文/路径）。 */
export const PLANNING_RECOVERY_GAP_REASONS = [
  'candidate_artifact_missing',
  'candidate_artifact_not_ready',
  'candidate_artifact_corrupt',
  'candidate_artifact_ambiguous',
  'candidate_identity_mismatch',
  'candidate_content_invalid',
  'settlement_artifact_missing',
  'settlement_artifact_not_ready',
  'settlement_artifact_corrupt',
  'settlement_identity_mismatch',
  'settlement_result_incomplete',
  'settlement_recording_incomplete',
  'settlement_stop_unconfirmed',
  'session_not_stopped',
  'recording_watermark_missing',
  'recording_gaps_present',
  'attempt_not_recoverable',
  'run_control_won',
  'occupancy_release_unconfirmed',
  'applied_consistency_mismatch',
] as const;
export type PlanningRecoveryGapReason = (typeof PLANNING_RECOVERY_GAP_REASONS)[number];

/** 扫描行事实（一致读；只含身份/状态/引用，不含正文）。 */
export interface PlanningRecoveryScanRow {
  readonly projectId: string;
  readonly runId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly attemptId: string | null;
  readonly candidateId: string;
  readonly contextStatus: string;
  readonly runStatus: string;
  readonly attemptStatus: string | null;
  readonly sessionId: string | null;
  readonly sessionStatus: string | null;
  readonly recordingWatermark: number | null;
  readonly recordingGaps: readonly string[];
  readonly claimState: string | null;
  readonly leaseCount: number;
  /** 待核对的候选制品索引事实（窗口 A；空数组表示无已发布文件）。 */
  readonly candidateArtifacts: readonly {
    readonly artifactId: string;
    readonly contentHash: string | null;
    readonly locator: string;
    readonly status: string;
  }[];
  /** 待核对的 runtime-settlement 制品（窗口 B；null 表示不存在）。 */
  readonly settlementArtifact: {
    readonly artifactId: string;
    readonly contentHash: string | null;
    readonly locator: string;
    readonly status: string;
  } | null;
  /** 初步窗口分类（服务层再按制品内容细化）。 */
  readonly window: PlanningRecoveryWindow | 'consistent' | 'none';
}

export interface PlanningRecoveryOutcome {
  readonly window: PlanningRecoveryWindow;
  /** completed=幂等补完成功；unresolved=证据不足保留现场；consistent=核对一致无需写入。 */
  readonly status: 'completed' | 'unresolved' | 'consistent';
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string | null;
  readonly gaps: readonly PlanningRecoveryGapReason[];
  /** 补完成的持久步骤名（bounded 枚举，供审计断言）。 */
  readonly completedSteps: readonly string[];
}

export interface PlanningStartupRecoveryResult {
  readonly status: 'complete' | 'blocked';
  readonly outcomes: readonly PlanningRecoveryOutcome[];
}

/** 窗口 A 补完输入（内容级校验在 application 层完成后传入受信结果）。 */
export interface PlanningCandidateRegistrationCompletionInput {
  readonly projectId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly artifactId: string;
  readonly contentHash: string;
  readonly candidateDigest: string;
  readonly summary: string;
}

/** 窗口 B 补完输入（settlement 制品内容核验通过后传入受信事实）。 */
export interface PlanningOutcomeCompletionInput {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly settlementArtifactId: string;
  readonly settlementContentHash: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly exitCode: number | null;
  readonly watermark: number | null;
  readonly startedAtUtcMs: number | null;
}

/** 窗口 C 补完输入（释放仍保留的占用/派发归属）。 */
export interface PlanningObservationReleaseInput {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
}

export type PlanningRecoveryPrimitiveResult = {
  readonly outcome: 'completed' | 'replayed' | 'rejected';
  readonly reason: string | null;
};

/** SQLite 短事务原语集合（每原语自有 BEGIN IMMEDIATE 事务；无进程/Git/模型 I/O）。 */
export interface PlanningRecoveryStore {
  /** 一致读扫描（分页有界；只读）。 */
  scan(): readonly PlanningRecoveryScanRow[];
  /** 窗口 A：补完候选登记（复用 planning_contexts 发布 CAS；同身份重放幂等）。 */
  completeRegistration(input: PlanningCandidateRegistrationCompletionInput): PlanningRecoveryPrimitiveResult;
  /** 窗口 B：补完已登记候选的 Run 终态结算（Attempt/Task/Run/预算/Session 同一短事务）。 */
  completeOutcome(input: PlanningOutcomeCompletionInput): PlanningRecoveryPrimitiveResult;
  /** 窗口 C：释放仍保留的隔离占用与派发归属（停止证据齐全的终态现场）。 */
  releaseObservation(input: PlanningObservationReleaseInput): PlanningRecoveryPrimitiveResult;
  /** 记录诊断事件（phase 词汇受限；不改正文事实）。 */
  recordDiagnostic(input: {
    readonly projectId: string;
    readonly runId: string;
    readonly attemptId: string | null;
    readonly window: PlanningRecoveryWindow | 'session-policy';
    readonly status: PlanningRecoveryOutcome['status'];
    readonly gaps: readonly string[];
  }): void;
}

export interface PlanningRecoveryDeps {
  readonly store: PlanningRecoveryStore;
  /** 受信有界制品读取（Core 受控暂存；身份/摘要不符即失败）。 */
  readonly verifier: {
    readVerifiedContent(projectId: string, artifactId: string): Promise<{
      readonly projectId: string;
      readonly artifactId: string;
      readonly contentHash: string;
      readonly content: Uint8Array;
    }>;
  };
  readonly nowMs?: () => number;
}

export interface PlanningStartupRecovery {
  /** 核对并幂等补完全部可补窗口；证据不足窗口保留现场并返回 blocked。 */
  recover(): Promise<PlanningStartupRecoveryResult>;
}
