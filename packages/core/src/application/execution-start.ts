/**
 * P03-3 / F-005 显式 ExecutionController 启动编排（application 层）。
 *
 * 设计依据：core-design/04 §6.1（Run 外层的 ExecutionController：显式调用
 * StateStore 创建 Run；所有 Run 归属用户明确授权的 ExecutionBatch；所有计数与
 * 对象创建在同一事务；同 workKey 已成功不得再次自动创建 Run；显式重试失败
 * 工作增加 dispatchOrdinal 但共享预算）、core-design/04 §1（唤醒只降低延迟，
 * 持久状态是权威）、core-design/08 §9（startBatch 携带预览摘要；启动事务重核
 * 实际范围与前置条件；实质变化返回 preview_stale，不静默扩大范围）。
 * 实施契约：docs/p03-3-execution-start-contract.md。
 *
 * 编排顺序：
 * 1. 事务外准备（prepareExecutionStart）：预算深校验（纯）→ 范围形态（空/
 *    多成员结构化拒绝）→ 只读预览重算（复用 F-004 预览端口：一致读视图 +
 *    受控仓库 I/O 全部在写事务之外）→ 用户确认摘要与当前重算摘要比对；
 *    非 ready 或摘要不一致一律折算为 not_startable（事务内固化 rejected
 *    preview_stale，零创建零扣额）；
 * 2. 短写事务内提交（submitExecutionStart）：项目 active、Phase 可执行、
 *    批准依据（P03-2 复合身份）、待执行工作、必需输入解析身份、权限面、
 *    预览身份（previewDigest 以事务内权威视图重算）、活动执行（同 Feature
 *    活动 Run、同 Phase 活动 Batch、基线占用）与预算在同一 BEGIN IMMEDIATE
 *    内重核；全部通过后原子提交 Batch（首次）/runsCreated 递增（重试）、
 *    Run、初始预算修订行、脱敏 execution.run.dispatched 事件与 Work accepted
 *    v6 回执；任一失败整组回滚（零 Batch/零 Run/零回执）。
 *
 * 不变量：
 * - Runtime 启动数恒为零：本模块不启动任何 Runtime/Git/检查进程（runtime_starts
 *   列保持 0，Run 保持 queued；唤醒是提交后窄端口 best-effort 信号，由命令
 *   服务在事务成功后发出）；
 * - accepted 不改变 Task passed 或 Feature completed：不写任何计划实体行；
 * - 幂等由命令面 commandId 回执机制承担：重放在命令服务事务内返回原回执，
 *   不进入本模块提交路径，不再次扣额或唤醒；
 * - workKey 固定 Feature、用途与有效计划/需求输入身份（computeExecutionWorkKey；
 *   不含代码身份：失败重试后的代码进展不改变工作身份）；成功、失败和取消 Run
 *   均不退还 Run 次数（runs_created 只递增，本模块无任何递减路径）；
 * - 新 Batch 只能来自不带 retryBatchId 的新命令（新的明确用户授权）；控制层
 *   不自动创建子批次、不扩大授权范围（单 Feature 范围由 DDL CHECK 与插入
 *   校验双重冻结）；
 * - 秘密纪律：快照/回执/事件只含身份键、摘要、受控原因与有界计数，不含
 *   绝对路径、制品正文或凭据。
 *
 * 本模块不实现：预算预占/结算与 Task 累计额度记账（F-006..F-008）、Run 生命
 * 周期 CAS（F-008）、预算显式修订（F-009）、查询面（F-010）。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PublicError,
  createAcceptedReceipt,
  createCompletedReceipt,
  createRejectedReceipt,
  mapStorageError,
} from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import type { CommandReceipt, ValidatedExecutionStartPayload, WorkAcceptedCommandReceipt } from '../ports/commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import {
  EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
  type ExecutionBatchRecord,
  type RunRecord,
  isExecutionTerminalStatus,
} from '../ports/execution-store.js';
import {
  EXECUTION_IN_PROGRESS_REASON,
  EXECUTION_RUN_NOT_READY_REASON,
  EXECUTION_RUN_PURPOSE,
  EXECUTION_START_OPERATION,
  computeExecutionWorkKey,
} from '../ports/execution-start.js';
import type {
  ExecutionDispatchSignalPort,
  ExecutionStartCommandIdentity,
  ExecutionStartEnvelopeFace,
  ExecutionStartPort,
  ExecutionStartRejectedReason,
  ExecutionStartSubmitContext,
  PreparedExecutionStart,
} from '../ports/execution-start.js';
import type {
  ExecutionPermissionsFace,
  ExecutionPermissionsReader,
} from '../ports/execution-input-prepare.js';
import { computeExecutionPermissionsDigest, computeExecutionStrategyCopyDigest } from '../ports/execution-input-prepare.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { enqueueAuthorizedRunInTransaction } from './execution-dispatch.js';
import type { ExecutionPreviewInputRefSummary } from '../ports/execution-preview.js';
import { computeExecutionPreviewDigest } from '../ports/execution-preview.js';
import type { ExecutionStartPreviewPort } from '../ports/execution-start.js';
import {
  validateExecutionBudgetProposal,
  evaluateBatchBudgetReservation,
} from '../ports/execution-budget.js';
import type { ExecutionBudgetProposal } from '../ports/execution-budget.js';
import { evaluatePlanApprovalValidity } from '../ports/plan-approval-verification.js';
import { resolveCurrentCheckPolicyDigest } from './plan-approval-verification.js';
import { stableStringify } from '../ports/feature-plan.js';
import type { PlanArtifactRef } from '../ports/feature-plan.js';

const OPERATION = EXECUTION_START_OPERATION;

/**
 * F-005 纯规则（可核对冻结面）：显式执行启动的影响面。创建授权 Batch/Run/初始
 * 预算修订行并递增 runsCreated（同事务回执与脱敏事件）；不启动 Runtime/Git/
 * 检查进程（runtime_starts 保持 0）、不修改任何计划实体（Task passed/Feature
 * completed 不变）、不预占 Attempt/Runtime 启动额度（F-006/F-007）、不结算
 * （F-008）、不修改预算（F-009）、不加载未选全局资源。
 */
export const EXECUTION_START_IMPACT = Object.freeze({
  createsExecutionEntities: true,
  incrementsRunsCreated: true,
  writesReceiptAndEvent: true,
  registersDispatchIntent: true,
  startsRuntimeGitOrChecks: false,
  keepsRuntimeStartsZero: true,
  changesPlanEntities: false,
  reservesAttemptOrRuntimeQuota: false,
  settlesBudget: false,
  modifiesBudget: false,
  loadsUnselectedGlobalResources: false,
});

/** 启动服务装配依赖（全部窄端口/用例；不接触具体适配器）。 */
export interface ExecutionStartServiceDeps {
  /** F-004 只读预览端口（事务外重算预览身份与仓库 I/O 复用同一契约）。 */
  readonly preview: ExecutionStartPreviewPort;
  /** 权限面同步读取器（事务内重核同一装配权威）。 */
  readonly permissions: ExecutionPermissionsReader;
  /** Trusted startup gate, invoked in the dispatch transaction before creating authorization. */
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

/** 权限面形态核验（fail-closed：装配契约被违反即 corrupt_state，不静默兜底）。 */
function readPermissionsFace(
  reader: ExecutionPermissionsReader,
  input: { projectId: string; featureId: string; taskId: string },
): ExecutionPermissionsFace {
  let face: unknown;
  try {
    face = reader(input);
  } catch (cause) {
    throw new StorageError('corrupt', OPERATION, '权限读取器抛出异常（fail-closed，不默认为空集）', {
      cause,
    });
  }
  if (
    face === null ||
    typeof face !== 'object' ||
    !Array.isArray((face as { grants?: unknown }).grants) ||
    (face as { grants: unknown[] }).grants.some((grant) => typeof grant !== 'string')
  ) {
    throw new StorageError('corrupt', OPERATION, '权限读取器返回非法形态（期望 { grants: string[] }）');
  }
  return face as ExecutionPermissionsFace;
}

function aggregatePlanDigest(features: readonly { readonly id: string; readonly planDigest: string | null }[]): string | null {
  if (features.length === 0 || features.some((feature) => feature.planDigest === null)) return null;
  if (features.length === 1) return features[0]!.planDigest;
  return createHash('sha256').update(`shiploop:execution-preview-plans:v1\n${stableStringify(
    features.map((feature) => ({ featureId: feature.id, planDigest: feature.planDigest }))
      .sort((left, right) => left.featureId < right.featureId ? -1 : 1),
  )}`, 'utf8').digest('hex');
}

function submitMultiExecutionStart(
  deps: ExecutionStartServiceDeps,
  identity: ExecutionStartCommandIdentity,
  envelope: ExecutionStartEnvelopeFace,
  transaction: CommandTransaction,
  prepared: Extract<PreparedExecutionStart, { readonly kind: 'fresh' }>,
  context: ExecutionStartSubmitContext,
  receiptIdentity: {
    readonly principalId: string;
    readonly commandId: string;
    readonly operation: typeof OPERATION;
    readonly scope: ExecutionStartCommandIdentity['scope'];
    readonly requestDigest: string;
    readonly issuedAt: string;
    readonly completedAt: string;
  },
): CommandReceipt {
  const reject = (): CommandReceipt => {
    const receipt = createRejectedReceipt({ ...receiptIdentity, error: new PublicError('conflict', OPERATION, undefined, { details: { reason: 'preview_stale' } }) });
    transaction.saveReceipt(receipt);
    return receipt;
  };
  const memberIds = [...prepared.scopeFeatureIds];
  const requestedIds = new Set(envelope.payload.featureIds);
  if (memberIds.length < 2 || new Set(memberIds).size !== memberIds.length || requestedIds.size !== memberIds.length || memberIds.some((id) => !requestedIds.has(id))) return reject();
  const snapshots = memberIds.map((featureId) => transaction.getFeaturePlan(prepared.projectId, featureId));
  const first = snapshots[0]!.feature;
  const phase = transaction.getPhase(prepared.projectId, prepared.phaseId);
  if (phase.status !== 'open' || phase.revision !== prepared.phaseRevision || snapshots.some((item) => item.feature.phaseId !== phase.id)) return reject();
  const expected = new Map(prepared.memberRevisions.map((member) => [member.featureId, member] as const));
  if (expected.size !== snapshots.length || snapshots.some((item) => {
    const member = expected.get(item.feature.id);
    return member === undefined || member.revision !== item.feature.revision || member.planDigest !== item.feature.planDigest;
  })) return reject();
  const global = transaction.getGlobalSettingsOrNull();
  const project = transaction.getProjectSettingsOrNull(prepared.projectId);
  const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
    global === null ? null : { scopeRevision: global.revision, payload: global.payload },
    project === null ? null : { scopeRevision: project.revision, payload: project.payload },
  );
  if (checkPolicyDigest !== prepared.checkPolicyDigest) return reject();
  const strategies: { readonly taskId: string; readonly digest: string }[] = [];
  const permissions: { readonly taskId: string; readonly digest: string }[] = [];
  const inputMap = new Map<string, ExecutionPreviewInputRefSummary>();
  const facts: Array<{ snapshot: typeof snapshots[number]; pendingTasks: typeof snapshots[number]['tasks']; inputs: ExecutionPreviewInputRefSummary[] }> = [];
  for (const snapshot of snapshots) {
    const validity = evaluatePlanApprovalValidity({ planDigest: snapshot.feature.planDigest, planStatus: snapshot.feature.planStatus, taskCount: snapshot.tasks.length,
      decisions: transaction.listPlanApprovals(prepared.projectId, snapshot.feature.id), currentCheckPolicyDigest: checkPolicyDigest });
    const pendingTasks = snapshot.tasks.filter((task) => task.status === 'pending' || task.status === 'failed');
    if (!validity.valid || snapshot.feature.planDigest === null || pendingTasks.length === 0) return reject();
    const refs = new Map<string, PlanArtifactRef>();
    for (const ref of [...snapshot.feature.sourceRefs, ...snapshot.tasks.flatMap((task) => [...task.requirementsRefs])]) refs.set(`${ref.artifactId}\u0000${ref.contentHash ?? ''}`, ref);
    const inputs: ExecutionPreviewInputRefSummary[] = [];
    for (const ref of [...refs.values()].sort((left, right) => left.artifactId < right.artifactId ? -1 : 1)) {
      try {
        const input = transaction.getArtifactInputRef(prepared.projectId, ref.artifactId);
        if (ref.contentHash !== null && ref.contentHash !== undefined && ref.contentHash !== input.contentHash) return reject();
        const resolved = { artifactId: input.artifactId, version: input.version, contentHash: input.contentHash, sizeBytes: input.sizeBytes };
        inputs.push(resolved); inputMap.set(`${resolved.artifactId}\u0000${resolved.contentHash}`, resolved);
      } catch (error) {
        if (isStorageError(error, 'not_found') || isStorageError(error, 'conflict') || isStorageError(error, 'ownership')) return reject();
        throw error;
      }
    }
    strategies.push(...snapshot.tasks.slice().sort((left, right) => left.id < right.id ? -1 : 1).map((task) => ({ taskId: task.id, digest: computeExecutionStrategyCopyDigest({ executionConfig: task.executionConfig, configSource: task.configSource, configSourceKey: task.configSourceKey }) })));
    permissions.push(...snapshot.tasks.slice().sort((left, right) => left.id < right.id ? -1 : 1).map((task) => ({ taskId: task.id, digest: computeExecutionPermissionsDigest(readPermissionsFace(deps.permissions, { projectId: prepared.projectId, featureId: snapshot.feature.id, taskId: task.id }).grants) })));
    facts.push({ snapshot, pendingTasks, inputs });
  }
  if (stableStringify(strategies) !== stableStringify(prepared.taskStrategyDigests)) return reject();
  if (stableStringify(permissions) !== stableStringify(prepared.permissionDigests)) return reject();
  if (stableStringify([...inputMap.values()].sort((left, right) => left.artifactId < right.artifactId ? -1 : 1)) !== stableStringify([...prepared.inputs])) return reject();
  if (aggregatePlanDigest(snapshots.map((item) => item.feature)) !== prepared.planDigest) return reject();
  for (const snapshot of snapshots) {
    const active = transaction.getActiveExecutionRun(prepared.projectId, snapshot.feature.id);
    if (active !== null) throw publicError('conflict', EXECUTION_IN_PROGRESS_REASON, { runId: active.id, status: active.status });
  }
  if (transaction.readBaselineOccupancy().holderOperationId !== null) throw publicError('resource_busy', 'baseline_in_progress');
  if (transaction.getActivePhaseExecutionBatch(prepared.projectId, phase.id) !== null) throw publicError('conflict', EXECUTION_IN_PROGRESS_REASON);
  const now = (deps.nowMs ?? Date.now)();
  const budget = evaluateBatchBudgetReservation(prepared.budget.batch, { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 }, now);
  if (!budget.allowed || memberIds.length > prepared.budget.batch.maxRuns) return reject();
  const batch = transaction.insertExecutionBatch({ projectId: prepared.projectId, phaseId: phase.id, featureId: first.id, batchId: randomUUID(),
    scopeSnapshot: { schemaVersion: 1, featureIds: memberIds, previewDigest: prepared.previewDigest },
    configSnapshot: { schemaVersion: 1, approval: { planDigest: prepared.planDigest, checkPolicyDigest }, tasks: strategies, permissions,
      members: snapshots.map((item) => ({ featureId: item.feature.id, revision: item.feature.revision, planDigest: item.feature.planDigest })) },
    budgetSnapshot: { schemaVersion: 1, batch: prepared.budget.batch, run: prepared.budget.run }, status: 'queued', runsCreated: memberIds.length, reason: null });
  transaction.insertBatchBudgetRevision({ projectId: prepared.projectId, batchId: batch.id, version: 1,
    budgetSnapshot: { schemaVersion: 1, batch: prepared.budget.batch, run: prepared.budget.run }, approvedBy: identity.principalId, reason: 'initial_authorization' });
  const binding = transaction.getRepositoryBinding(prepared.projectId);
  const runIds: string[] = [];
  for (const fact of facts) {
    const workKey = computeExecutionWorkKey({ featureId: fact.snapshot.feature.id, purpose: EXECUTION_RUN_PURPOSE, planDigest: fact.snapshot.feature.planDigest!, inputs: fact.inputs });
    const run = transaction.insertExecutionRun({ projectId: prepared.projectId, batchId: batch.id, featureId: fact.snapshot.feature.id, runId: randomUUID(), purpose: EXECUTION_RUN_PURPOSE,
      inputSnapshot: { schemaVersion: 1, previewDigest: prepared.previewDigest, workKey, planDigest: fact.snapshot.feature.planDigest, pendingTaskIds: fact.pendingTasks.map((task) => task.id).sort(), inputs: fact.inputs.map((input) => ({ artifactId: input.artifactId, version: input.version, contentHash: input.contentHash })), workspaceBaseline: { repositoryBindingId: binding.id, repositoryBindingRevision: binding.bindingRevision, baseCommit: prepared.code.headCommit } },
      configSnapshot: { schemaVersion: 1, runLimits: prepared.budget.run }, status: 'queued', scopeDigest: prepared.previewDigest, workKey, dispatchOrdinal: 1,
      maxAttemptsPerRun: prepared.budget.run.maxAttemptsPerRun, runTimeLimitMs: prepared.budget.run.runTimeLimitMs, reason: context.schedulerAssembled ? null : EXECUTION_RUN_NOT_READY_REASON });
    transaction.appendExecutionEvent({ projectId: prepared.projectId, eventType: EXECUTION_RUN_DISPATCHED_EVENT_TYPE, aggregateType: 'run', aggregateId: run.id, aggregateRevision: run.revision, payload: { dispatched: true } });
    enqueueAuthorizedRunInTransaction(transaction, { projectId: prepared.projectId, runId: run.id, source: 'start', reason: run.reason });
    runIds.push(run.id);
  }
  const receipt = createAcceptedReceipt({ ...receiptIdentity, operation: OPERATION, operationId: batch.id, batchId: batch.id, runId: runIds[0]! });
  transaction.saveReceipt(receipt);
  return receipt;
}

/** 装配显式执行启动服务。只校验依赖形态（fail-closed），不执行任何 I/O。 */
export function createExecutionStartService(deps: ExecutionStartServiceDeps): ExecutionStartPort {
  const context = { operation: `${OPERATION}.create` } as const;
  if (deps === null || typeof deps !== 'object') {
    throw new StorageError('validation', context.operation, `${OPERATION}.create: deps 必须是对象`, {
      details: { field: 'deps', reason: 'invalid_type' },
    });
  }
  if (deps.preview === null || typeof deps.preview !== 'object') {
    throw new StorageError('validation', context.operation, `${OPERATION}.create: deps.preview 必须是端口实现`, {
      details: { field: 'deps.preview', reason: 'invalid_type' },
    });
  }
  if (typeof deps.permissions !== 'function') {
    throw new StorageError('validation', context.operation, `${OPERATION}.create: deps.permissions 必须是权限读取器函数`, {
      details: { field: 'deps.permissions', reason: 'invalid_type' },
    });
  }
  const nowMs = deps.nowMs ?? Date.now;
  const { preview, permissions } = deps;

  return {
    async prepareExecutionStart(projectId, payload: ValidatedExecutionStartPayload): Promise<PreparedExecutionStart> {
      const now = nowMs();
      const featureId = payload.featureIds.length === 0 ? null : payload.featureIds[0];

      /* 1a. 同父 Batch 显式重试：不重算预览（父 Batch 自身即同 Phase 活动位，
       * 新授权预览必报 active_batch_in_phase blocked）；工作身份由 workKey 与
       * 父 Batch 既有 Run 在事务内绑定，预算共享父 Batch 冻结预算。 */
      if (payload.retryBatchId !== null) {
        if (featureId === null) {
          throw publicError('invalid_input', 'empty_scope');
        }
        return {
          kind: 'retry',
          projectId,
          featureId,
          retryBatchId: payload.retryBatchId,
        };
      }

      /* 1b. 新授权：预算提案深校验（纯；零 I/O，先于预览重算与仓库/制品访问）。 */
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

      /* 2. 范围形态：启动必须携带明确目标（空范围结构化拒绝，不产生 no_work
       * 回执——与预览不同，启动没有“空跑”语义）；多成员拒绝（本阶段固定
       * 单 Feature，不静默截断）。 */
      if (payload.featureIds.length === 0) {
        throw publicError('invalid_input', 'empty_scope');
      }

      /* 3. 只读预览重算（事务外：一致读视图 + 受控仓库 I/O 均在写事务之外）；
       * 非 ready（no_work/blocked）或用户摘要与当前重算摘要不一致 → 漂移，
       * 事务内固化 rejected preview_stale（零创建零扣额）。 */
      const current = await preview.previewExecution(projectId, {
        featureIds: payload.featureIds,
        budget: payload.budget,
      });
      if (current.status !== 'ready') {
        return { kind: 'not_startable', currentStatus: current.status };
      }
      if (current.previewDigest === null || current.summary === null) {
        // 防御：ready 结果必携带摘要与 summary（F-004 契约）；缺失按漂移处理。
        return { kind: 'not_startable', currentStatus: 'digest_mismatch' };
      }
      if (current.previewDigest !== payload.previewDigest) {
        return { kind: 'not_startable', currentStatus: 'digest_mismatch' };
      }

      /* 4. 就绪身份捕获（与事务内权威重核比对的一切成分；代码身份来自事务外
       * 受控仓库检查，事务内无法重算——预览摘要以该成分参与重算比对）。 */
      const summary = current.summary;
      return {
        kind: 'fresh',
        projectId,
        featureId: payload.featureIds[0],
        scopeFeatureIds: 'memberFeatureIds' in current.scope ? [...current.scope.memberFeatureIds] : [payload.featureIds[0]!],
        phaseId: 'phaseId' in current.scope ? current.scope.phaseId : '',
        phaseRevision: 'phaseRevision' in current.scope ? current.scope.phaseRevision ?? null : null,
        memberRevisions: current.summary.members.map((member) => ({ featureId: member.featureId, revision: member.revision, planDigest: member.planDigest })),
        previewDigest: current.previewDigest,
        budget,
        code: summary.code,
        inputs: summary.inputs.refs,
        planDigest: summary.approval.planDigest,
        checkPolicyDigest: summary.checkPolicyDigest,
        decisionId: summary.approval.decisionId,
        taskStrategyDigests: summary.tasks.map((task) => ({
          taskId: task.taskId,
          digest: task.strategyCopyDigest,
        })),
        permissionDigests: summary.permissions.tasks.map((entry) => ({
          taskId: entry.taskId,
          digest: entry.digest,
        })),
        pendingTaskIds: summary.plan.pendingTaskIds,
        generatedAtUtcMs: now,
      };
    },

    submitExecutionStart(
      identity: ExecutionStartCommandIdentity,
      envelope: ExecutionStartEnvelopeFace,
      transaction: CommandTransaction,
      prepared: PreparedExecutionStart,
      context: ExecutionStartSubmitContext,
    ): CommandReceipt {
      deps.assertCanDispatch?.();
      const projectId = envelope.scope.projectId;
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
      /** 漂移/业务拒绝：固化稳定 rejected 回执（零创建零扣额）。 */
      const rejected = (reason: ExecutionStartRejectedReason): CommandReceipt => {
        const receipt = createRejectedReceipt({
          ...receiptIdentity,
          error: new PublicError('conflict', OPERATION, undefined, { details: { reason } }),
        });
        transaction.saveReceipt(receipt);
        return receipt;
      };

      /* 0. 事务外准备已判定不可启动（no_work/blocked/摘要不一致）→ 漂移。 */
      if (prepared.kind === 'not_startable') {
        return rejected('preview_stale');
      }
      const fresh = prepared.kind === 'fresh' ? prepared : null;
      const retry = prepared.kind === 'retry' ? prepared : null;

      /* 1. 父级项目把关（同事务权威读）：缺失/不可见统一 forbidden（不泄漏存在性）；
       * 非 active 即漂移。 */
      let project;
      try {
        project = transaction.getProject(projectId);
      } catch (error) {
        mapProjectLookupError(error, OPERATION);
      }
      if (project.status !== 'active') {
        return rejected('preview_stale');
      }

      if (fresh !== null && fresh.scopeFeatureIds.length > 1) {
        return submitMultiExecutionStart(deps, identity, envelope, transaction, fresh, context, receiptIdentity);
      }

      /* 2. 计划快照（同事务权威读）：缺失 not_found、跨项目 ownership 抛出。 */
      const snapshot = transaction.getFeaturePlan(projectId, prepared.featureId);
      const feature = snapshot.feature;
      const targetFeatureId = feature.id;

      /* 3. 批准依据重核（复合身份 = planDigest + 当前检查政策内容摘要）。 */
      const decisions = transaction.listPlanApprovals(projectId, feature.id);
      const globalSettings = transaction.getGlobalSettingsOrNull();
      const projectSettings = transaction.getProjectSettingsOrNull(projectId);
      const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
        globalSettings === null ? null : { scopeRevision: globalSettings.revision, payload: globalSettings.payload },
        projectSettings === null ? null : { scopeRevision: projectSettings.revision, payload: projectSettings.payload },
      );
      const validity = evaluatePlanApprovalValidity({
        planDigest: feature.planDigest,
        planStatus: feature.planStatus,
        taskCount: snapshot.tasks.length,
        decisions,
        currentCheckPolicyDigest: checkPolicyDigest,
      });
      if (!validity.valid || feature.planDigest === null) {
        return rejected('preview_stale');
      }

      /* 4. Phase 可执行重核（open 之外不可执行）。 */
      const phase = transaction.getPhase(projectId, feature.phaseId);
      if (phase.status !== 'open') {
        return rejected('preview_stale');
      }

      /* 5. 待执行工作重核（pending/failed；全空 = no_work 漂移）。 */
      const pendingTasks = snapshot.tasks.filter((task) => task.status === 'pending' || task.status === 'failed');
      if (pendingTasks.length === 0) {
        return rejected('preview_stale');
      }

      /* 6. 必需输入解析身份重核（同事务权威制品索引；身份级，正文不内联；
       * 新授权与重试均需解析结果计算 workKey；新授权额外与准备身份比对）。 */
      const declaredRefs = new Map<string, PlanArtifactRef>();
      for (const ref of [...feature.sourceRefs, ...snapshot.tasks.flatMap((task) => [...task.requirementsRefs])]) {
        declaredRefs.set(`${ref.artifactId}\u0000${ref.contentHash ?? ''}`, ref);
      }
      const resolvedInputs: ExecutionPreviewInputRefSummary[] = [];
      for (const ref of Array.from(declaredRefs.values()).sort((left, right) =>
        left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0,
      )) {
        try {
          const inputRef = transaction.getArtifactInputRef(projectId, ref.artifactId);
          if (ref.contentHash !== null && ref.contentHash !== undefined && ref.contentHash !== inputRef.contentHash) {
            return rejected('preview_stale');
          }
          resolvedInputs.push({
            artifactId: inputRef.artifactId,
            version: inputRef.version,
            contentHash: inputRef.contentHash,
            sizeBytes: inputRef.sizeBytes,
          });
        } catch (error) {
          // 缺失/未 ready/损坏 = 必需输入不可用 → 漂移（预览已把它列为 blocked）。
          if (isStorageError(error, 'not_found') || isStorageError(error, 'conflict') || isStorageError(error, 'ownership')) {
            return rejected('preview_stale');
          }
          if (isStorageError(error)) {
            throw mapStorageError(error, { operation: OPERATION });
          }
          throw error;
        }
      }

      /* 7+8. 新授权专属重核：逐 Task 策略副本/权限面内容身份与预览身份
       * （previewDigest 以事务内权威视图 + 事务外代码身份重算；范围/计划/策略/
       * 检查/权限/输入/预算任一实质变化都改变摘要，纯标签不参与）。重试不携带
       * 新授权依据，身份由 workKey 与父 Batch 既有 Run 绑定（见 11b）。 */
      const taskStrategyDigests = [...snapshot.tasks]
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((task) => ({
          taskId: task.id,
          digest: computeExecutionStrategyCopyDigest({
            executionConfig: task.executionConfig,
            configSource: task.configSource,
            configSourceKey: task.configSourceKey,
          }),
        }));
      const permissionDigests = [...snapshot.tasks]
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((task) => ({
          taskId: task.id,
          digest: computeExecutionPermissionsDigest(
            readPermissionsFace(permissions, { projectId, featureId: feature.id, taskId: task.id }).grants,
          ),
        }));
      if (fresh !== null) {
        if (stableStringify(taskStrategyDigests) !== stableStringify(fresh.taskStrategyDigests)) {
          return rejected('preview_stale');
        }
        if (stableStringify(permissionDigests) !== stableStringify(fresh.permissionDigests)) {
          return rejected('preview_stale');
        }
        const recomputedDigest = computeExecutionPreviewDigest({
          projectId,
          phaseId: feature.phaseId,
          featureIds: [feature.id],
          planDigest: feature.planDigest,
          code: fresh.code,
          tasks: taskStrategyDigests.map((entry) => ({
            taskId: entry.taskId,
            strategyCopyDigest: entry.digest,
          })),
          checkPolicyDigest,
          permissions: permissionDigests,
          inputs: resolvedInputs,
          budget: fresh.budget,
        });
        if (recomputedDigest !== fresh.previewDigest || recomputedDigest !== envelope.payload.previewDigest) {
          return rejected('preview_stale');
        }
        if (stableStringify(resolvedInputs) !== stableStringify([...fresh.inputs])) {
          return rejected('preview_stale');
        }
      }

      /* 9. 活动执行重核（同事务权威行；独立于预览——预览后出现同样拒绝）：
       * 同 Feature 活动 Run / 基线在途隔离占用 → 抛出冲突（零回执，客户端可
       * 换 commandId 重试）；同 Phase 活动 Batch 视首派/重试分别处理。 */
      const activeRun = transaction.getActiveExecutionRun(projectId, feature.id);
      if (activeRun !== null) {
        throw publicError('conflict', EXECUTION_IN_PROGRESS_REASON, {
          runId: activeRun.id,
          status: activeRun.status,
        });
      }
      const occupancy = transaction.readBaselineOccupancy();
      if (occupancy.holderOperationId !== null) {
        throw publicError('resource_busy', 'baseline_in_progress', {
          holderOperationId: occupancy.holderOperationId,
        });
      }

      /* 10. workKey（纯计算：Feature + 用途 + 有效计划摘要 + 必需输入解析身份；
       * 不含代码身份与预算——失败重试后的代码进展与预算修订不改变工作身份）。 */
      const workKey = computeExecutionWorkKey({
        featureId: feature.id,
        purpose: EXECUTION_RUN_PURPOSE,
        planDigest: feature.planDigest,
        inputs: resolvedInputs,
      });

      const now = nowMs();
      const runReason = context.schedulerAssembled ? null : EXECUTION_RUN_NOT_READY_REASON;
      const pendingTaskIds = pendingTasks
        .map((task) => task.id)
        .sort((left, right) => (left < right ? -1 : 1));
      /** Run 输入快照公共成分（身份级；不含正文/绝对路径/凭据）。 */
      const baseInputSnapshot = {
        workKey,
        planDigest: feature.planDigest,
        pendingTaskIds,
        inputs: resolvedInputs.map((ref) => ({
          artifactId: ref.artifactId,
          version: ref.version,
          contentHash: ref.contentHash,
        })),
      };

      let batch: ExecutionBatchRecord;
      let dispatchOrdinal: number;
      let runScopeDigest: string;
      let runLimits: { readonly maxAttemptsPerRun: number; readonly runTimeLimitMs: number };
      let runInputSnapshot: Record<string, unknown>;
      if (fresh !== null) {
        /* 11a. 首次明确授权：同 Phase 活动 Batch 唯一（另一批次持有 → 冲突抛出，
         * 零回执）；预算以提案判定（新批次零用量，deadline 以事务时钟重核）；
         * 创建 Batch（runsCreated=1）+ 初始预算修订行（version=1）。 */
        const activeBatch = transaction.getActivePhaseExecutionBatch(projectId, feature.phaseId);
        if (activeBatch !== null) {
          throw publicError('conflict', EXECUTION_IN_PROGRESS_REASON, {
            batchId: activeBatch.id,
            status: activeBatch.status,
          });
        }
        const freshBudget = evaluateBatchBudgetReservation(
          fresh.budget.batch,
          { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
          now,
        );
        if (!freshBudget.allowed) {
          return rejected('budget_exhausted');
        }
        const batchId = randomUUID();
        batch = transaction.insertExecutionBatch({
          projectId,
          phaseId: feature.phaseId,
          featureId: feature.id,
          batchId,
          scopeSnapshot: {
            schemaVersion: 1,
            featureIds: [feature.id],
            previewDigest: fresh.previewDigest,
          },
          configSnapshot: {
            schemaVersion: 1,
            approval: {
              planDigest: feature.planDigest,
              checkPolicyDigest,
              ...(validity.currentDecisionId === null ? {} : { decisionId: validity.currentDecisionId }),
            },
            tasks: taskStrategyDigests,
            permissions: permissionDigests,
          },
          budgetSnapshot: {
            schemaVersion: 1,
            batch: fresh.budget.batch,
            run: fresh.budget.run,
          },
          status: 'queued',
          runsCreated: 1,
          reason: null,
        });
        transaction.insertBatchBudgetRevision({
          projectId,
          batchId,
          version: 1,
          budgetSnapshot: { schemaVersion: 1, batch: fresh.budget.batch, run: fresh.budget.run },
          approvedBy: identity.principalId,
          reason: 'initial_authorization',
        });
        dispatchOrdinal = 1;
        runScopeDigest = fresh.previewDigest;
        runLimits = fresh.budget.run;
        const binding = transaction.getRepositoryBinding(projectId);
        runInputSnapshot = { schemaVersion: 1, previewDigest: fresh.previewDigest, ...baseInputSnapshot,
          workspaceBaseline: { repositoryBindingId: binding.id, repositoryBindingRevision: binding.bindingRevision,
            baseCommit: fresh.code.headCommit } };
      } else {
        /* 11b. 显式失败重试：同一父 Batch，共享父预算（不携带新预算/新授权依据）；
         * 终态 Batch 不接受新派发；重试工作身份必须与父 Batch 既有 Run 的
         * workKey 一致；同 Batch 已成功 workKey 拒绝再派发；dispatchOrdinal
         * 原子递增，不退还计数。 */
        const retryBatchId = retry!.retryBatchId;
        let parent: ExecutionBatchRecord;
        try {
          parent = transaction.getExecutionBatch(projectId, retryBatchId);
        } catch (error) {
          if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
            throw mapStorageError(error, { operation: OPERATION });
          }
          throw error;
        }
        if (parent.featureId !== targetFeatureId) {
          return rejected('retry_scope_mismatch');
        }
        if (isExecutionTerminalStatus(parent.status)) {
          return rejected('batch_not_active');
        }
        // P03-9 / F-002：取消意图（cancelling）或未确认停止（interrupted）的
        // Batch 不接受新 Run；重试不能绕过取消/隔离现场。
        if (parent.status === 'cancelling' || parent.status === 'interrupted') {
          return rejected('batch_not_active');
        }
        // P03-9 / F-001：暂停意图已生效的 Batch 不接受新 Run（重试也被阻止）；
        // 恢复必须走后续显式 resume 控制，不能借 retryBatchId 绕过暂停。
        if (parent.pauseRequestedAtUtcMs !== null) {
          return rejected('batch_not_active');
        }
        const activePhaseBatch = transaction.getActivePhaseExecutionBatch(projectId, feature.phaseId);
        if (activePhaseBatch !== null && activePhaseBatch.id !== parent.id) {
          throw publicError('conflict', EXECUTION_IN_PROGRESS_REASON, {
            batchId: activePhaseBatch.id,
            status: activePhaseBatch.status,
          });
        }
        const workRuns = transaction.listExecutionRunsForWorkKey(projectId, parent.id, workKey);
        if (workRuns.length === 0) {
          return rejected('retry_work_key_absent');
        }
        if (workRuns.some((run) => run.status === 'succeeded')) {
          return rejected('work_key_succeeded');
        }
        const parentBudget = evaluateBatchBudgetReservation(
          parent.budgetSnapshot.batch,
          {
            runsCreated: parent.runsCreated,
            attemptsCreated: parent.attemptsCreated,
            runtimeStarts: parent.runtimeStarts,
            noProgressRuns: parent.noProgressRuns,
          },
          now,
        );
        if (!parentBudget.allowed) {
          return rejected('budget_exhausted');
        }
        dispatchOrdinal = Math.max(...workRuns.map((run) => run.dispatchOrdinal)) + 1;
        batch = transaction.recordExecutionRunDispatch(projectId, parent.id);
        // 重试 Run 的范围摘要：父 Batch 授权时冻结的预览摘要（授权依据锚点）。
        const parentPreviewDigest = parent.scopeSnapshot.previewDigest;
        if (typeof parentPreviewDigest !== 'string' || !/^[0-9a-f]{64}$/.test(parentPreviewDigest)) {
          throw publicError('corrupt_state', 'batch_scope_digest_corrupt');
        }
        runScopeDigest = parentPreviewDigest;
        runLimits = {
          maxAttemptsPerRun: parent.budgetSnapshot.run.maxAttemptsPerRun,
          runTimeLimitMs: parent.budgetSnapshot.run.runTimeLimitMs,
        };
        runInputSnapshot = { schemaVersion: 1, previewDigest: parentPreviewDigest, ...baseInputSnapshot,
          workspaceBaseline: workRuns[0].inputSnapshot.workspaceBaseline ?? null };
      }

      /* 12. Run 创建（派发身份/上限冻结；queued + 可查询排队原因；不启动任何
       * 进程——runtime_starts 保持 0）。 */
      const runId = randomUUID();
      const run: RunRecord = transaction.insertExecutionRun({
        projectId,
        batchId: batch.id,
        featureId: feature.id,
        runId,
        purpose: EXECUTION_RUN_PURPOSE,
        inputSnapshot: runInputSnapshot,
        configSnapshot: {
          schemaVersion: 1,
          runLimits: {
            maxAttemptsPerRun: runLimits.maxAttemptsPerRun,
            runTimeLimitMs: runLimits.runTimeLimitMs,
          },
        },
        status: 'queued',
        scopeDigest: runScopeDigest,
        workKey,
        dispatchOrdinal,
        maxAttemptsPerRun: runLimits.maxAttemptsPerRun,
        runTimeLimitMs: runLimits.runTimeLimitMs,
        reason: runReason,
      });

      /* 13. 脱敏事件（恒定 payload；聚合为派发创建的 Run 自身）。 */
      transaction.appendExecutionEvent({
        projectId,
        eventType: EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
        aggregateType: 'run',
        aggregateId: run.id,
        aggregateRevision: run.revision,
        payload: { dispatched: true },
      });

      /* 13b. P04-9 / F-002：Run 已授权即持久执行意图。派发元数据与 Run/回执/
       * 事件在同一短写事务内登记；重复入队（同 Run）复用原身份，不新增
       * Batch/Run/Attempt、不重复预算或事件；入队不启动 Runner、不预扣额度。 */
      const dispatchIntent = enqueueAuthorizedRunInTransaction(transaction, {
        projectId,
        runId: run.id,
        source: fresh !== null ? 'start' : 'retry',
        reason: run.reason,
      });

      /* 14. 回执：首次授权 → Work accepted v6（operationId=batchId，同 Batch 唯一
       * ——v10 迁移 operation_id 唯一索引承担）；同父 Batch 重试 → completed v5
       * （同事务同步完成的派发结果；结果只携带身份级事实，不重复关联身份）。
       * 同事务保存（回执持久层核验 Run 行存在——先插 Run 后存回执）。 */
      if (fresh !== null) {
        const receipt = createAcceptedReceipt({
          ...receiptIdentity,
          operation: OPERATION,
          operationId: batch.id,
          batchId: batch.id,
          runId: run.id,
        });
        transaction.saveReceipt(receipt);
        return receipt;
      }
      const completed = createCompletedReceipt({
        ...receiptIdentity,
        resultRef: createResultRef(randomBytes(32)),
        result: {
          schemaVersion: 1,
          dispatched: true,
          batchId: batch.id,
          runId: run.id,
          featureId: feature.id,
          dispatchOrdinal,
          runsCreated: batch.runsCreated,
          status: run.status,
          runtimeExecution: false,
          dispatchIntentId: dispatchIntent.intent.id,
        },
      });
      transaction.saveReceipt(completed);
      return completed;
    },
  };
}

/** 命令服务提交后唤醒：仅事务成功且非重放的新派发回执时 best-effort 发信号
 * （失败吞掉，持久 queued Run 是权威；绝不据此重复创建 Run）。首次授权的
 * Work accepted v6 与重试的 completed 派发结果都触发。 */
export function signalRunDispatchAfterCommit(
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
  const projectId = receipt.scope.projectId;
  try {
    if (receipt.status === 'accepted') {
      // Work accepted v6 判别：schemaVersion 字面量判别（v5 baseline accepted 不携带
      // Batch/Run 关联，不进入唤醒路径）。
      if (
        receipt.schemaVersion !== 6 ||
        receipt.operation !== OPERATION ||
        receipt.batchId === undefined ||
        receipt.runId === undefined
      ) {
        return;
      }
      signal.signalRunDispatched({
        projectId,
        batchId: receipt.batchId,
        runId: receipt.runId,
        featureId,
      });
      return;
    }
    if (receipt.status === 'completed' && receipt.operation === OPERATION) {
      const result = receipt.result as { batchId?: unknown; runId?: unknown } | null;
      if (
        result === null ||
        typeof result !== 'object' ||
        typeof result.batchId !== 'string' ||
        typeof result.runId !== 'string'
      ) {
        return;
      }
      signal.signalRunDispatched({
        projectId,
        batchId: result.batchId,
        runId: result.runId,
        featureId,
      });
    }
  } catch {
    // 唤醒丢失/失败：不重复创建 Run，不回滚已提交事务；持久状态可核对。
  }
}
