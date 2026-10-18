/**
 * P03-9 / F-008 显式工作流 resume 契约（ports 契约层：操作名、拒绝词汇、事务原语
 * 输入/输出与事务外准备/事务内提交端口形态；无 I/O）。
 *
 * 设计依据：input/p03-run-control.md FR-2（非终态 Run/Attempt、当前策略/worktree/
 * 记录水位、用户显式 resume；当前策略重新核验、预算不重置；旧执行停止后才继续）、
 * core-design/04（暂停/取消/恢复计数边界）、core-design/14（工作流 resume 不等于
 * SDK resume；新 Attempt/invocation 与原 Session 来源分开；同一存活进程重连不新建
 * Attempt）。
 *
 * 本层不实现原生 SDK resume、不打开供应商原生库、不创建 Session/Attempt、不写
 * 预算/工作区。显式 resume 只重新授权并解除可继续目标上的暂停意图；真正的新
 * Attempt、输入快照持久化、预算预占与 Runtime 启动仍由既有 Task claim / Runner
 * 链路在同一身份纪律下完成。
 */

/** 显式工作流 resume 命令操作名（COMMAND_OPERATIONS 白名单冻结名）。 */
export const EXECUTION_RESUME_OPERATION = 'execution.resume' as const;

/** 事务外准备判定的稳定拒绝原因（固化在 rejected 回执，零业务写入）。 */
export const EXECUTION_RESUME_REJECTED_REASONS = [
  /** 目标已终态或已取消：旧 Run/Batch 不复活。 */
  'already_terminal',
  /** 目标不是可继续的非终态（仍活动/正在停止/从未暂停）。 */
  'not_resumable',
  /** 目标 revision 已变化（并发 resume/其他控制先提交）。 */
  'stale_revision',
  /** 取消意图/取消终态：取消后不自动继续。 */
  'cancelled_not_resumable',
  /** 启动恢复/停止事实不确定，不能解除隔离占用。 */
  'recovery_unsafe',
  /** 当前计划授权/检查政策失效。 */
  'authorization_invalid',
  /** 当前 Phase/依赖/任务策略/权限/必需输入身份与授权快照不一致。 */
  'resume_stale',
  /** 旧 Attempt 仍活动或遗留 held/quarantined 占用。 */
  'occupancy_unresolved',
  /** 受管 worktree 缺失、身份不一致或检查失败。 */
  'workspace_invalid',
  /** 父预算（计数/deadline）已耗尽；resume 不重置预算。 */
  'budget_exhausted',
  /** 已 passed Task 的持久证据不再有效，需显式重新检查/修复授权。 */
  'evidence_invalid',
  /** 目标仍有编码依赖未满足（失败/跳过/等待其他 Task）。 */
  'dependency_blocked',
  /** 启动恢复门控未开放。 */
  'startup_recovery',
] as const;
export type ExecutionResumeRejectedReason = (typeof EXECUTION_RESUME_REJECTED_REASONS)[number];

/** 解除暂停后本次 resume 进入的缺失步骤（不是 Runtime 已启动的证明）。 */
export const EXECUTION_RESUME_SCOPES = ['coding', 'final_verification', 'approval'] as const;
export type ExecutionResumeScope = (typeof EXECUTION_RESUME_SCOPES)[number];

/** resume 事务原语输入（目标身份 + 目标自身 revision + 已核对工作区身份）。 */
export interface ExecutionResumeInput {
  readonly projectId: string;
  readonly targetKind: 'run' | 'batch';
  readonly targetId: string;
  readonly expectedRevision: number;
  /**
   * 事务外受界检查得到的受管工作区身份；null 表示目标 Feature 尚无工作区
   * （从未启动的首次执行）。事务内重核 id/revision 与 status，不允许与
   * 检查时漂移。
   */
  readonly workspace: { readonly workspaceId: string; readonly revision: number } | null;
}

export interface ExecutionResumeResult {
  readonly outcome: 'resumed' | 'already_terminal';
  readonly targetKind: 'run' | 'batch';
  readonly targetId: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly status: 'queued' | 'running';
  readonly revision: number;
  /** 本次解除暂停的 Run 身份（batch 目标可能含一个活动 Run）。 */
  readonly runIds: readonly string[];
  readonly eventId: string | null;
}

/** 事务外准备结果：只含业务/身份事实，不含正文、绝对路径或凭据。 */
export interface PreparedExecutionResumeReady {
  readonly kind: 'ready';
  readonly projectId: string;
  readonly targetKind: 'run' | 'batch';
  readonly targetId: string;
  readonly expectedRevision: number;
  readonly batchId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly resumeScope: ExecutionResumeScope;
  readonly nextTaskIds: readonly string[];
  /** 事务内重核用的授权/策略/输入身份摘要。 */
  readonly resumeDigest: string;
  readonly workspace: { readonly workspaceId: string; readonly revision: number; readonly codeDigest: string | null } | null;
  readonly observedHeadCommit: string | null;
}

export interface PreparedExecutionResumeNotResumable {
  readonly kind: 'not_resumable';
  readonly reason: ExecutionResumeRejectedReason;
  readonly targetKind: 'run' | 'batch';
  readonly targetId: string;
}

export type PreparedExecutionResume = PreparedExecutionResumeReady | PreparedExecutionResumeNotResumable;

/** 命令身份（回执字段的服务端可信来源）。 */
export interface ExecutionResumeCommandIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly scope: { readonly kind: 'project'; readonly projectId: string };
  readonly requestDigest: string;
  readonly issuedAt: string;
}

/** 事务内提交使用的命令信封最小面（操作固定 execution.resume）。 */
export interface ExecutionResumeEnvelopeFace {
  readonly scope: { readonly kind: 'project'; readonly projectId: string };
  readonly payload: { readonly runId: string | null; readonly batchId: string | null };
  readonly expectedRevision: number;
}

/**
 * 显式工作流 resume 端口：prepare 在写事务之外完成全部只读核验（计划/依赖/
 * 审批/worktree/记录水位/预算/deadline），submit 在调用方同一 BEGIN IMMEDIATE
 * 短写事务内重核身份、占用、预算与工作区并原子解除暂停、写事件与回执。
 */
export interface ExecutionResumePort {
  prepareExecutionResume(
    projectId: string,
    payload: ExecutionResumeEnvelopeFace['payload'],
  ): Promise<PreparedExecutionResume>;
  submitExecutionResume(
    identity: ExecutionResumeCommandIdentity,
    envelope: ExecutionResumeEnvelopeFace,
    transaction: import('./atomic-commands.js').CommandTransaction,
    prepared: PreparedExecutionResume,
  ): import('./commands.js').CommandReceipt;
}
