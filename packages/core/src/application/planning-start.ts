/**
 * P05-1 / F-003 一次性规划启动编排（application 层）。
 *
 * 设计依据：ports/planning-start.ts（命令契约）、core-design/04 §3（planning
 * Task 使用已确认的需求与规划输入版本，不要求存在尚未生成的有效交付计划；
 * 用户授权启动规划不等于批准它将生成的计划）、§6.1（所有 Run 归属用户明确
 * 授权的 ExecutionBatch，包括单次规划；单次规划默认 maxRuns=1；成功、失败、
 * 取消的已创建 Run 都消耗 maxRuns，不退款；禁止通过创建子批次或换 Run ID
 * 绕过预算）、core-design/15 §2（Controller 核对授权、固定 Batch 范围与预算；
 * SQLite 是事实来源，唤醒只降低延迟；Slot/资源门控不混同）、FR-1/FR-4
 * （plan 与同项目编码排他；重复 commandId 复用原结果）。
 *
 * 编排顺序：
 * 1. 事务外准备（preparePlanningStart）：负载项目一致性 → 预算提案深校验
 *    （纯，deadline 以参考时间重核）→ 单次规划固定 batch.maxRuns=1。无仓库/
 *    模型 I/O（规划不需要预览重算或代码身份）；
 * 2. 短写事务内提交（submitPlanningStart）：项目 active、Phase open、Feature
 *    归属与 revision CAS、终态不可重规划、需求制品身份、同项目活动规划/编码
 *    （含 paused/interrupted 未确认停止，不以暂停或租约到期绕过）、活动规划
 *    上下文、基线占用与预算在同一 BEGIN IMMEDIATE 内重核；全部通过后原子
 *    写入单 Feature 授权 Batch、purpose=plan Run、planning Task/上下文（复用
 *    F-002 存储原语）、初始预算修订行、持久派发意图、脱敏事件与 accepted v7
 *    回执；任一失败整组回滚（零 Batch/零 Run/零回执）。
 *
 * 不变量：
 * - 不借用编码计划审批作为规划授权：Feature plan_status=draft 即可规划
 *   （批准状态不是前置条件也不是障碍），首次规划允许尚无可执行计划；
 * - 不在命令提交中启动模型：runtime_starts 恒为 0、Run 保持 queued、
 *   planning Task 恒 pending；accepted 不代表规划完成；
 * - 幂等由命令面 commandId 回执机制承担：重放不进入本模块提交路径；
 * - 单次规划固定 maxRuns=1，成功、失败、取消不退款；不自动创建子 Batch、
 *   不自动重复规划（重复规划只能由新的明确用户授权发起新命令）；
 * - 秘密纪律：快照/回执/事件只含身份键、摘要、受控原因与有界计数。
 */
import { randomUUID } from 'node:crypto';
import {
  PublicError,
  createAcceptedReceipt,
  createRejectedReceipt,
  mapStorageError,
} from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import {
  EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
} from '../ports/execution-store.js';
import {
  EXECUTION_RUN_NOT_READY_REASON,
} from '../ports/execution-start.js';
import type { ExecutionDispatchSignalPort } from '../ports/execution-start.js';
import {
  EXECUTION_IN_PROGRESS_REASON,
  PLANNING_IN_PROGRESS_REASON,
  PLANNING_START_FIXED_MAX_RUNS,
  PLANNING_START_OPERATION,
  computePlanningWorkKey,
} from '../ports/planning-start.js';
import type {
  PlanningStartCommandIdentity,
  PlanningStartEnvelopeFace,
  PlanningStartPort,
  PlanningStartRejectedReason,
  PlanningStartSubmitContext,
  PreparedPlanningStart,
} from '../ports/planning-start.js';
import { PLANNING_RUN_PURPOSE } from '../ports/planning-candidates.js';
import { PLANNING_CONTEXT_TITLE_MAX_LENGTH } from '../ports/planning-context.js';
import {
  validateExecutionBudgetProposal,
  evaluateBatchBudgetReservation,
} from '../ports/execution-budget.js';
import type { ExecutionBudgetProposal } from '../ports/execution-budget.js';
import { selectPlanningPurposeStrategy } from './task-strategy-selection.js';
import { enqueueAuthorizedRunInTransaction } from './execution-dispatch.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import type { PlanArtifactRef } from '../ports/feature-plan.js';

const OPERATION = PLANNING_START_OPERATION;

/** Feature 终态（不满足安全重规划条件）。 */
const FEATURE_TERMINAL_STATUSES = ['completed', 'partial', 'failed'] as const;

/**
 * F-003 纯规则（可核对冻结面）：一次性规划启动的影响面。创建授权 Batch/Run/
 * planning Task/上下文与初始预算修订行并递增 runsCreated（同事务回执与脱敏
 * 事件）；登记持久派发意图；不启动 Runtime/Git/检查进程（runtime_starts 保持
 * 0）、不修改任何计划实体（Feature planStatus/Task passed 不变）、不预占
 * Attempt/Runtime 启动额度、不结算、不修改预算、不加载未选全局资源。
 */
export const PLANNING_START_IMPACT = Object.freeze({
  createsExecutionEntities: true,
  createsPlanningContext: true,
  incrementsRunsCreated: true,
  writesReceiptAndEvent: true,
  registersDispatchIntent: true,
  startsRuntimeGitOrChecks: false,
  keepsRuntimeStartsZero: true,
  changesPlanEntities: false,
  borrowsCodingPlanApproval: false,
  reservesAttemptOrRuntimeQuota: false,
  settlesBudget: false,
  modifiesBudget: false,
  loadsUnselectedGlobalResources: false,
});

/** 启动服务装配依赖（全部窄端口/纯依赖；不接触具体适配器）。 */
export interface PlanningStartServiceDeps {
  /** Trusted startup gate, invoked in the planning submit transaction before creating authorization. */
  readonly assertCanDispatch?: () => void;
  /** 时间源（默认 Date.now；测试注入以获得确定性）。 */
  readonly nowMs?: () => number;
}

function publicError(
  code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict' | 'resource_busy' | 'corrupt_state' | 'internal',
  reason: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): PublicError {
  return new PublicError(code, OPERATION, undefined, {
    details: { reason, ...(details ?? {}) },
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** planning Task 标题：`规划：<Feature 标题>`，截断到标题上限（码点）。 */
function planningTaskTitle(featureTitle: string): string {
  const title = `规划：${featureTitle}`;
  const points = [...title];
  return points.length <= PLANNING_CONTEXT_TITLE_MAX_LENGTH
    ? title
    : `${points.slice(0, PLANNING_CONTEXT_TITLE_MAX_LENGTH - 1).join('')}…`;
}

/** 装配一次性规划启动服务。只校验依赖形态（fail-closed），不执行任何 I/O。 */
export function createPlanningStartService(deps: PlanningStartServiceDeps = {}): PlanningStartPort {
  if (deps === null || typeof deps !== 'object') {
    throw new StorageError('validation', `${OPERATION}.create`, `${OPERATION}.create: deps 必须是对象`, {
      details: { field: 'deps', reason: 'invalid_type' },
    });
  }
  if (deps.assertCanDispatch !== undefined && typeof deps.assertCanDispatch !== 'function') {
    throw new StorageError('validation', `${OPERATION}.create`, `${OPERATION}.create: deps.assertCanDispatch 必须是函数`, {
      details: { field: 'deps.assertCanDispatch', reason: 'invalid_type' },
    });
  }
  const nowMs = deps.nowMs ?? Date.now;

  return {
    async preparePlanningStart(projectId, payload): Promise<PreparedPlanningStart> {
      const now = nowMs();

      /* 1. 负载项目一致性：请求 v1 的 projectId 必须与命令 scope 一致。 */
      if (payload.request.projectId !== projectId) {
        throw publicError('invalid_input', 'project_mismatch', {
          field: 'payload.projectId',
        });
      }

      /* 2. 预算提案深校验（纯；零 I/O；deadline 以参考时间重核——已到达即拒绝）。 */
      let budget: ExecutionBudgetProposal;
      try {
        budget = validateExecutionBudgetProposal(
          payload.budget,
          { operation: OPERATION, entity: { type: 'feature', projectId } },
          { referenceNowUtcMs: now },
        );
      } catch (error) {
        if (isStorageError(error, 'validation')) {
          throw publicError('invalid_input', 'invalid_budget', {
            field: typeof error.details?.field === 'string' ? error.details.field : 'budget',
            budgetReason: error.details?.reason ?? 'invalid',
          }, error);
        }
        throw error;
      }

      /* 3. 单次规划固定 maxRuns=1（core-design/04 §6.1；重复规划需要新的明确
       * 用户授权发起新命令，不接受更大提案，也不静默改写）。 */
      if (budget.batch.maxRuns !== PLANNING_START_FIXED_MAX_RUNS) {
        throw publicError('invalid_input', 'planning_max_runs_fixed', {
          field: 'budget.batch.maxRuns',
          supported: PLANNING_START_FIXED_MAX_RUNS,
          received: budget.batch.maxRuns,
        });
      }

      return {
        kind: 'fresh',
        projectId,
        request: payload.request,
        budget,
        generatedAtUtcMs: now,
      };
    },

    submitPlanningStart(
      identity: PlanningStartCommandIdentity,
      envelope: PlanningStartEnvelopeFace,
      transaction: CommandTransaction,
      prepared: PreparedPlanningStart,
      context: PlanningStartSubmitContext,
    ): CommandReceipt {
      deps.assertCanDispatch?.();
      const projectId = envelope.scope.projectId;
      const request = prepared.request;
      const completedAt = new Date(nowMs()).toISOString();
      const receiptIdentity = {
        principalId: identity.principalId,
        commandId: identity.commandId,
        operation: OPERATION,
        scope: identity.scope,
        requestDigest: identity.requestDigest,
        issuedAt: identity.issuedAt,
        completedAt,
      };
      /** 目标漂移/业务拒绝：固化稳定 rejected 回执（零创建零扣额）。 */
      const rejected = (reason: PlanningStartRejectedReason, details?: Readonly<Record<string, unknown>>): CommandReceipt => {
        const receipt = createRejectedReceipt({
          ...receiptIdentity,
          error: new PublicError('conflict', OPERATION, undefined, {
            details: { reason, ...(details ?? {}) },
          }),
        });
        transaction.saveReceipt(receipt);
        return receipt;
      };

      /* 1. 父级项目把关（同事务权威读）：缺失/不可见统一 forbidden（不泄漏
       * 存在性）；非 active 即漂移。 */
      let project;
      try {
        project = transaction.getProject(projectId);
      } catch (error) {
        mapProjectLookupError(error, OPERATION);
      }
      if (project.status !== 'active') {
        return rejected('target_stale', { entityType: 'project' });
      }

      /* 2. 计划快照（同事务权威读）：缺失 not_found、跨项目 ownership 抛出。 */
      const snapshot = transaction.getFeaturePlan(projectId, request.featureId);
      const feature = snapshot.feature;

      /* 3. 归属一致：负载 Phase 必须与 Feature 实际归属一致。 */
      if (feature.phaseId !== request.phaseId) {
        return rejected('target_stale', { entityType: 'phase' });
      }

      /* 4. Phase 生命周期重核（open 之外不可规划）。 */
      const phase = transaction.getPhase(projectId, feature.phaseId);
      if (phase.status !== 'open') {
        return rejected('target_stale', { entityType: 'phase' });
      }

      /* 5. Feature 聚合 CAS：信封 expectedRevision 是唯一 CAS 权威（旧 CAS 固化
       * rejected，携带 expected/actual）。 */
      if (feature.revision !== envelope.expectedRevision) {
        return rejected('conflict', {
          entityType: 'feature',
          expectedRevision: envelope.expectedRevision,
          actualRevision: feature.revision,
        });
      }

      /* 6. 安全重规划条件：终态 Feature（completed/partial/failed）不可再规划
       * （批准状态不是前置条件也不是障碍——plan_status 不参与判定）。 */
      if ((FEATURE_TERMINAL_STATUSES as readonly string[]).includes(feature.status)) {
        return rejected('feature_terminal', { entityType: 'feature' });
      }

      /* 7. 同项目活动规划/编码互斥（项目 Work 门控）：任意活动 Run（含
       * paused/interrupted——未确认停止不以暂停或租约到期绕过）或同 Phase
       * 活动 Batch → 抛出冲突（零回执，客户端可换 commandId 重试）。 */
      const activeProjectRun = transaction.getActiveProjectExecutionRun(projectId);
      if (activeProjectRun !== null) {
        throw publicError('conflict', EXECUTION_IN_PROGRESS_REASON, {
          runId: activeProjectRun.id,
          status: activeProjectRun.status,
          purpose: activeProjectRun.purpose,
          featureId: activeProjectRun.featureId,
        });
      }
      const activePhaseBatch = transaction.getActivePhaseExecutionBatch(projectId, feature.phaseId);
      if (activePhaseBatch !== null) {
        throw publicError('conflict', EXECUTION_IN_PROGRESS_REASON, {
          batchId: activePhaseBatch.id,
          status: activePhaseBatch.status,
        });
      }

      /* 8. 基线在途隔离占用（与 execution.start 同一纪律）。 */
      const occupancy = transaction.readBaselineOccupancy();
      if (occupancy.holderOperationId !== null) {
        throw publicError('resource_busy', 'baseline_in_progress', {
          holderOperationId: occupancy.holderOperationId,
        });
      }

      /* 9. 活动 planning 上下文（open/candidate_published）：Run 已终态但上下文
       * 未结算时不接受重复规划（F-009 取消/失败结算接线前的明确阻塞）。 */
      const activePlanning = transaction.getActivePlanningContextForFeature(projectId, feature.id);
      if (activePlanning !== null) {
        throw publicError('conflict', PLANNING_IN_PROGRESS_REASON, {
          candidateId: activePlanning.candidateId,
          status: activePlanning.status,
        });
      }

      /* 10. 需求制品身份重核（同事务权威制品索引；身份级，正文不内联）：
       * 缺失/跨项目抛出（归属类失败不积回执）；未就绪/内容摘要不一致固化
       * rejected（预览同源的 artifact_not_usable 语义）。 */
      const resolvedRequirementRefs: { artifactId: string; version: number; contentHash: string }[] = [];
      for (const ref of request.requirementRefs) {
        try {
          const inputRef = transaction.getArtifactInputRef(projectId, ref.artifactId);
          if (ref.contentHash !== null && ref.contentHash !== undefined && ref.contentHash !== inputRef.contentHash) {
            return rejected('artifact_not_usable', { entityType: 'artifact' });
          }
          resolvedRequirementRefs.push({
            artifactId: inputRef.artifactId,
            version: inputRef.version,
            contentHash: inputRef.contentHash,
          });
        } catch (error) {
          if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
            throw mapStorageError(error, { operation: OPERATION });
          }
          if (isStorageError(error, 'conflict')) {
            return rejected('artifact_not_usable', { entityType: 'artifact' });
          }
          if (isStorageError(error)) {
            throw mapStorageError(error, { operation: OPERATION });
          }
          throw error;
        }
      }

      /* 11. planner 用途策略副本（事务内权威配置解析；冻结进 planning Task，
       * 后续默认配置变化不追溯改写；无条目 no_strategy_match 明确拒绝）。 */
      const globalSettings = transaction.getGlobalSettingsOrNull();
      const projectSettings = transaction.getProjectSettingsOrNull(projectId);
      let selection: ReturnType<typeof selectPlanningPurposeStrategy>;
      try {
        selection = selectPlanningPurposeStrategy({
          ...(globalSettings === null
            ? {}
            : { global: { scopeRevision: globalSettings.revision, payload: globalSettings.payload } }),
          ...(projectSettings === null
            ? {}
            : { project: { scopeRevision: projectSettings.revision, payload: projectSettings.payload } }),
        });
      } catch (error) {
        if (isStorageError(error, 'validation')) {
          throw publicError('invalid_input', 'no_strategy_match', {
            field: 'strategies',
          }, error);
        }
        throw error;
      }

      /* 12. 预算重核（事务时钟）：新批次零用量，计数上限不可能耗尽；deadline
       * 在准备与提交之间到达即固化 rejected budget_exhausted。 */
      const now = nowMs();
      const budgetReservation = evaluateBatchBudgetReservation(
        prepared.budget.batch,
        { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
        now,
      );
      if (!budgetReservation.allowed) {
        return rejected('budget_exhausted');
      }

      /* 13. 原子写入开始：授权 Batch（单 Feature、runsCreated=1）+ 初始预算修订行。 */
      const batchId = randomUUID();
      const runId = randomUUID();
      const candidateId = randomUUID();
      const budgetSnapshot = {
        schemaVersion: 1,
        batch: prepared.budget.batch,
        run: prepared.budget.run,
      };
      transaction.insertExecutionBatch({
        projectId,
        phaseId: feature.phaseId,
        featureId: feature.id,
        batchId,
        scopeSnapshot: {
          schemaVersion: 1,
          featureIds: [feature.id],
          inputDigest: request.inputDigest,
        },
        configSnapshot: {
          schemaVersion: 1,
          planning: {
            approvalMode: request.strategy.approvalMode,
            taskLimit: request.strategy.taskLimit,
          },
          strategyCopy: selection.strategy,
        },
        budgetSnapshot,
        status: 'queued',
        runsCreated: 1,
        reason: null,
      });
      transaction.insertBatchBudgetRevision({
        projectId,
        batchId,
        version: 1,
        budgetSnapshot,
        approvedBy: identity.principalId,
        reason: 'initial_authorization',
      });

      /* 14. purpose=plan Run（规划请求语义身份锚定；queued + 可查询排队原因；
       * 不启动任何进程——runtime_starts 保持 0）。 */
      const workKey = computePlanningWorkKey({
        featureId: feature.id,
        inputDigest: request.inputDigest,
      });
      const runReason = context.schedulerAssembled ? null : EXECUTION_RUN_NOT_READY_REASON;
      const run = transaction.insertExecutionRun({
        projectId,
        batchId,
        featureId: feature.id,
        runId,
        purpose: PLANNING_RUN_PURPOSE,
        inputSnapshot: {
          schemaVersion: 1,
          inputDigest: request.inputDigest,
          requirementRefs: resolvedRequirementRefs,
          constraints: [...request.constraints],
          acceptance: { criteria: [...request.acceptance.criteria] },
          strategy: { approvalMode: request.strategy.approvalMode, taskLimit: request.strategy.taskLimit },
          targetRevision: feature.revision,
          planDigest: feature.planDigest,
          candidateId,
        },
        configSnapshot: {
          schemaVersion: 1,
          runLimits: {
            maxAttemptsPerRun: prepared.budget.run.maxAttemptsPerRun,
            runTimeLimitMs: prepared.budget.run.runTimeLimitMs,
          },
        },
        status: 'queued',
        scopeDigest: request.inputDigest,
        workKey,
        dispatchOrdinal: 1,
        maxAttemptsPerRun: prepared.budget.run.maxAttemptsPerRun,
        runTimeLimitMs: prepared.budget.run.runTimeLimitMs,
        reason: runReason,
      });

      /* 15. planning Task + 规划上下文（F-002 存储原语：同一事务内创建并绑定
       * Run/候选身份/目标依据；策略副本冻结）。 */
      const planningTaskRequirements: PlanArtifactRef[] = request.requirementRefs.map((ref) => ({ ...ref }));
      const planningContext = transaction.createPlanningContextInTransaction({
        projectId,
        phaseId: feature.phaseId,
        featureId: feature.id,
        runId,
        candidateId,
        inputDigest: request.inputDigest,
        targetRevision: feature.revision,
        planDigest: feature.planDigest,
        planningTask: {
          title: planningTaskTitle(feature.title),
          description: null,
          acceptance: { criteria: [...request.acceptance.criteria] },
          requirementsRefs: planningTaskRequirements,
        },
        strategy: selection.strategy,
        strategySource: {
          configSource: selection.configSource,
          configSourceKey: selection.configSourceKey,
        },
      });

      /* 16. 脱敏事件（恒定 payload；聚合为派发创建的 Run 自身）。 */
      transaction.appendExecutionEvent({
        projectId,
        eventType: EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
        aggregateType: 'run',
        aggregateId: run.id,
        aggregateRevision: run.revision,
        payload: { dispatched: true },
      });

      /* 17. 持久派发意图（source='start' 首次授权；与 Run/回执/事件同一事务；
       * 重复入队复用原身份，不重复预算或事件）。 */
      enqueueAuthorizedRunInTransaction(transaction, {
        projectId,
        runId: run.id,
        source: 'start',
        reason: runReason,
      });

      /* 18. accepted v7 回执（operationId=batchId；四重身份；不代表规划完成）；
       * 同事务保存（持久层核验 Run 与规划上下文绑定一致）。 */
      const receipt = createAcceptedReceipt({
        ...receiptIdentity,
        operation: OPERATION,
        operationId: batchId,
        batchId,
        runId: run.id,
        planningTaskId: planningContext.planningTaskId,
        candidateId,
      });
      transaction.saveReceipt(receipt);
      return receipt;
    },
  };
}

/** 命令服务提交后唤醒：仅事务成功且非重放的 planning accepted v7 时 best-effort
 * 发信号（失败吞掉，持久 queued Run 是权威；绝不据此重复创建 Run）。 */
export function signalPlanningRunDispatchAfterCommit(
  signal: ExecutionDispatchSignalPort | undefined,
  receipt: CommandReceipt,
  featureId: string,
): void {
  if (signal === undefined || receipt.replayed) {
    return;
  }
  if (receipt.scope.kind !== 'project') {
    return;
  }
  try {
    if (
      receipt.status === 'accepted' &&
      receipt.schemaVersion === 7 &&
      receipt.operation === OPERATION &&
      receipt.batchId !== undefined &&
      receipt.runId !== undefined
    ) {
      signal.signalRunDispatched({
        projectId: receipt.scope.projectId,
        batchId: receipt.batchId,
        runId: receipt.runId,
        featureId,
      });
    }
  } catch {
    // 唤醒丢失/失败：不重复创建 Run，不回滚已提交事务；持久状态可核对。
  }
}
