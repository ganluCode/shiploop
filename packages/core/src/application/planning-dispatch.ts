/**
 * P05-1 / F-005 planning Run 派发准备编排（application 层）。
 *
 * 设计依据：ports/planning-claim.ts（认领契约）、application/planning-input-prepare.ts
 * （F-004 输入准备/重核端口）、core-design/04 §3（规划 readiness 依据已授权规划
 * 输入和上下文，不要求尚未生成的业务计划已批准）、core-design/15 §2（SQLite 是
 * 事实来源，唤醒只降低延迟；Slot/资源门控不混同）。
 *
 * 职责边界（全部在写事务外；无进程/Git 写、无模型调用）：
 * - 一致读视图快速判定 planning readiness（Run purpose=plan、上下文 open、
 *   planning Task pending——不满足即结构化拒绝，不进入重准备）；
 * - 调用 F-004 规划输入准备端口完成捕获/组装/发布/正文复验，并立即执行启动前
 *   重核（身份/状态/摘要/制品索引/代码基线；漂移明确拒绝）；
 * - 派生 planning 认领输入（PlanningClaimInput）：claimKey/launch 身份、可信
 *   工作区令牌（verifyPreparation，与编码准备同一权威）、租约上限（缺省 60s，
 *   截止 Batch 绝对 deadline）、F-004 制品组投影为 planning 快照；
 * - 失败保留证据：任一步失败不留下可绑定的半个认领（已发布制品保持不可变）；
 *   秘密纪律：错误 details 只含身份键/摘要/限制值/脱敏原因。
 *
 * 本模块不实现：SQLite 认领事务（adapters/sqlite/planning-claim-store.ts）、
 * 调度器路由（work-scheduler.ts）、Runtime 启动（F-007）。
 */
import { randomUUID } from 'node:crypto';
import { PublicError } from '../ports/commands.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import {
  buildPlanningAttemptInputSnapshot,
  PLANNING_CLAIM_LEASE_MS_DEFAULT,
} from '../ports/planning-claim.js';
import type { PlanningClaimInput } from '../ports/planning-claim.js';
import { PLANNING_RUN_PURPOSE, PLANNING_TASK_KIND } from '../ports/planning-candidates.js';
import type { PlanningInputPreparationViewStore } from '../ports/planning-input-prepare.js';
import type { PlanningInputPreparePort } from './planning-input-prepare.js';
import type { RepositoryBindingRecord } from '../ports/state-store.js';
import type { VerifiedWorkWorkspace } from '../ports/work-resources.js';

/** planning 派发准备操作名（内部端口，不是用户命令面）。 */
export const PLANNING_DISPATCH_OPERATION = 'planning.dispatch.prepare' as const;

/**
 * F-005（P05-1）纯规则（可核对冻结面）：planning 派发准备的影响面。事务外准备
 * 已授权规划输入并派生认领输入；不创建执行实体、不启动 Runtime/Git/检查进程、
 * 不修改规划上下文/Run/Task 状态、不预占 Attempt/Runtime 启动额度。
 */
export const PLANNING_DISPATCH_IMPACT = Object.freeze({
  preparesAuthorizedPlanningInput: true,
  rechecksBeforeClaim: true,
  derivesClaimInputOutsideTransactions: true,
  createsExecutionEntities: false,
  startsRuntimeGitOrChecks: false,
  changesPlanningContextState: false,
  reservesAttemptOrRuntimeQuota: false,
  credentialsRemainReferencesOnly: true,
});

/** planning Task 终态（不可再准备/认领）。 */
const PLANNING_TASK_TERMINAL_OR_RUNNING = new Set(['passed', 'failed', 'skipped', 'cancelled', 'running']);

/** 装配依赖（全部窄端口；不接触具体适配器）。 */
export interface PlanningDispatchPrepareDeps {
  readonly views: PlanningInputPreparationViewStore;
  readonly planningInputs: PlanningInputPreparePort;
  /** 可信工作区权威（与编码准备同一 verifyPreparation 语义）。 */
  readonly workspaceAuthority: {
    verifyPreparation(binding: RepositoryBindingRecord, featureId: string): Promise<VerifiedWorkWorkspace>;
  };
  readonly repositoryBindings: { getRepositoryBinding(projectId: string): Promise<RepositoryBindingRecord> };
  /** 同项目 Run 的 Batch 绝对 deadline 读取（只读事实；无则 null）。 */
  readonly batchDeadline: { readDeadlineUtcMs(projectId: string, runId: string): number | null };
  /** planning Task 行级 CAS 事实（revision/execution_version；缺失 null）。 */
  readonly taskFacts: { readTaskFacts(projectId: string, taskId: string): { revision: number; executionVersion: number } | null };
  /** 本消费者的受信 owner/Host 实例身份（由装配持有；不是模型/用户输入）。 */
  readonly owner: string;
  readonly hostInstanceId: string;
  /** 认领租约时长（毫秒；缺省 PLANNING_CLAIM_LEASE_MS_DEFAULT）。 */
  readonly leaseMs?: number;
  /** 时间源（默认 Date.now；测试注入以获得确定性）。 */
  readonly nowMs?: () => number;
}

function publicError(
  code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict' | 'resource_busy' | 'corrupt_state' | 'internal',
  reason: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): PublicError {
  return new PublicError(code, PLANNING_DISPATCH_OPERATION, undefined, {
    details: { reason, ...(details ?? {}) },
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** 装配 planning 派发准备服务（供调度器 planning 分支调用；全程写事务外）。 */
export function createPlanningDispatchPrepareService(deps: PlanningDispatchPrepareDeps) {
  const nowMs = deps.nowMs ?? Date.now;
  const leaseMs = deps.leaseMs ?? PLANNING_CLAIM_LEASE_MS_DEFAULT;

  return {
    /** 派生 planning 认领输入；readiness 不满足或输入准备/重核失败时结构化拒绝。 */
    async preparePlanningClaim(ref: { readonly projectId: string; readonly runId: string }): Promise<PlanningClaimInput> {
      /* 1) readiness 快速判定（一致读视图；未装配消费者能力前也不重准备）。 */
      const view = deps.views.readPlanningInputPreparationView(ref.projectId, ref.runId);
      if (view === undefined) {
        throw publicError('not_found', 'planning_run_not_found', { entityType: 'run' });
      }
      if (view.run.purpose !== PLANNING_RUN_PURPOSE) {
        throw publicError('conflict', 'run_purpose_mismatch', { purpose: view.run.purpose });
      }
      if (view.context.status !== 'open') {
        throw publicError('conflict', 'planning_context_not_open', { status: view.context.status });
      }
      if (view.planningTask.kind !== PLANNING_TASK_KIND || PLANNING_TASK_TERMINAL_OR_RUNNING.has(view.planningTask.status)) {
        throw publicError('conflict', 'planning_task_not_pending', { status: view.planningTask.status });
      }

      /* 2) F-004 规划输入准备 + 启动前重核（事务外；漂移结构化拒绝）。 */
      const prepared = await deps.planningInputs.preparePlanningInput(ref.projectId, { runId: ref.runId });
      await deps.planningInputs.recheckPlanningInputPreparation(ref.projectId, prepared);

      /* 3) planning Task 行级 CAS 事实（一致性由认领事务重核；这里只提供输入）。 */
      const taskFacts = deps.taskFacts.readTaskFacts(ref.projectId, view.planningTask.id);
      if (taskFacts === null) {
        throw publicError('not_found', 'planning_task_missing', { taskId: view.planningTask.id });
      }

      /* 4) 可信工作区令牌 + Batch deadline 截断租约。 */
      const binding = await deps.repositoryBindings.getRepositoryBinding(ref.projectId);
      const workspace = await deps.workspaceAuthority.verifyPreparation(binding, view.feature.id);
      const now = nowMs();
      const deadline = deps.batchDeadline.readDeadlineUtcMs(ref.projectId, ref.runId);
      const leaseUntilUtcMs = deadline === null ? now + leaseMs : Math.min(now + leaseMs, deadline);
      if (!Number.isSafeInteger(leaseUntilUtcMs) || leaseUntilUtcMs <= now) {
        throw publicError('conflict', 'deadline_exhausted', { runId: ref.runId });
      }

      /* 5) 派生认领输入（claimKey/launch 身份在此生成；快照为 planning 判别形态）。 */
      return {
        claimKey: randomUUID(),
        projectId: ref.projectId,
        runId: ref.runId,
        taskId: view.planningTask.id,
        owner: deps.owner,
        hostInstanceId: deps.hostInstanceId,
        expectedRevision: taskFacts.revision,
        executionVersion: taskFacts.executionVersion,
        workspace,
        leaseUntilUtcMs,
        inputSnapshot: buildPlanningAttemptInputSnapshot(prepared),
        launch: { sessionId: randomUUID(), invocationId: randomUUID(), parentSessionId: null },
      };
    },
  };
}

export type PlanningDispatchPrepareService = ReturnType<typeof createPlanningDispatchPrepareService>;

/** 调度器侧失败原因提取（与编码 claimErrorReason 同一纪律）。 */
export function planningPrepareErrorReason(error: unknown): string {
  if (error instanceof PublicError && typeof error.details?.reason === 'string') {
    return error.details.reason;
  }
  if (isStorageError(error) && typeof error.details?.reason === 'string') {
    return error.details.reason;
  }
  if (error instanceof StorageError || error instanceof PublicError) return 'claim_rejected';
  return 'claim_rejected';
}
