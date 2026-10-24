/**
 * P03-3 / F-004 单 Feature 执行 prepare 预览编排（application 层）。
 *
 * 设计依据：core-design/08 §9（prepareExecution 确定性计算候选范围/策略/检查/
 * 代码基线/预算/阻塞原因；返回预览内容与摘要，不预先创建 Run/Attempt；预览
 * 不是批准记录或永久占用，不保证稍后仍可运行）、core-design/04 §6（本阶段
 * 范围恰为一个 Feature，不自动扩大；所有 Run 归属用户明确授权的 Batch）。
 * 实施契约：docs/p03-3-execution-preview-contract.md。
 *
 * 编排顺序（授权与纯校验先于任何仓库或制品 I/O）：
 * 1. 预算提案深校验（ports/execution-budget 权威校验器；参考时钟校验 deadline
 *    尚未到达）→ 非法预算结构化拒绝（零 I/O）；
 * 2. 范围形态：空范围 → no_work（empty_scope，零 I/O）；多成员 → 结构化拒绝
 *    （本阶段固定单 Feature，不静默截断）；
 * 3. 一致读视图捕获（单一 DEFERRED 读事务：项目/绑定/Phase/Feature/Task/依赖/
 *    决策/配置/必需输入解析/活动 Run/活动 Batch/基线占用）；
 * 4. 有效并发核验（F-001 并发政策：有效并发 > 1 一律 concurrency_not_supported
 *    ——保存政策不等于执行支持）；
 * 5. 待执行工作判定（pending/failed 为待执行；passed/skipped/cancelled 视为无
 *    待执行工作）→ no_work（no_pending_tasks）；
 * 6. 视图内阻塞原因收集（确定性顺序）：批准（P03-2 有效批准复合身份评估）、
 *    项目 active、Phase 可执行、同 Feature 活动 Run、同 Phase 活动 Batch、
 *    基线在途/隔离占用、必需不可变输入引用不可用 → blocked（全部原因列出，
 *    不做仓库 I/O）；
 * 7. 仅当无阻塞时执行受控仓库 I/O：绑定身份核验（realpath/repoIdentity 复用
 *    RepositoryInspector；漂移/缺失结构化拒绝）+ 工作区摘要（复用
 *    BaselineWorkspaceReader；不执行脚本、不安装依赖、不探测模型）；
 * 8. 组装完整输入身份摘要（previewDigest）并返回 ready；runtimeExecution 恒为
 *    false——预算授权预览不宣称已具备 Runtime 执行能力。
 *
 * 不变量：
 * - 只读预览：不创建 Batch/Run/Attempt、不扣预算、不写业务事件、不调用
 *   Runtime/Git 写操作；幂等由命令面 commandId 回执机制承担；
 * - 身份重核按内容身份：策略副本（computeExecutionStrategyCopyDigest）、权限面
 *   （computeExecutionPermissionsDigest）、检查政策（computeFeatureCheckPolicyDigest）、
 *   计划（planDigest）与必需输入解析身份；纯标签/默认 modelMap 变化不改变身份；
 * - 秘密纪律：结果与错误只含身份键、摘要与受控原因，不含绝对路径、正文或凭据。
 *
 * 本模块不实现：start 启动命令与 Batch/Run 创建（F-005）、预算预占/结算
 * （F-006/F-007）、Host/CLI 传输接线、Runtime 装配。
 */
import { createHash } from 'node:crypto';
import { PublicError, mapStorageError, mapToPublicError } from '../ports/commands.js';
import type { ValidatedExecutionPreviewPayload } from '../ports/commands.js';
import { RECEIPT_RESULT_MAX_BYTES } from '../ports/commands.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import {
  EXECUTION_PREVIEW_OPERATION,
  EXECUTION_PREVIEW_PENDING_WORK_TASK_STATUSES,
  EXECUTION_PREVIEW_RESULT_SCHEMA_VERSION,
  computeExecutionPreviewDigest,
} from '../ports/execution-preview.js';
import type {
  ExecutionPreviewBlockedReason,
  ExecutionPreviewCodeIdentity,
  ExecutionPreviewInputRefSummary,
  ExecutionPreviewResult,
  ExecutionPreviewScopeView,
  ExecutionPreviewMemberView,
  ExecutionPreviewSummary,
  ExecutionPreviewTaskPermissions,
  ExecutionPreviewTaskSummary,
  ExecutionPreviewView,
  ExecutionPreviewViewStore,
} from '../ports/execution-preview.js';
import { validateExecutionBudgetProposal } from '../ports/execution-budget.js';
import type { ExecutionBudgetProposal } from '../ports/execution-budget.js';
import {
  computeExecutionPermissionsDigest,
  computeExecutionStrategyCopyDigest,
} from '../ports/execution-input-prepare.js';
import type { ExecutionPermissionsFace, ExecutionPermissionsReader } from '../ports/execution-input-prepare.js';
import { evaluatePlanApprovalValidity } from '../ports/plan-approval-verification.js';
import { validateStableId } from '../ports/validation.js';
import { stableStringify } from '../ports/feature-plan.js';
import type { ValidationContext } from '../ports/validation.js';
import type { BaselineWorkspaceReader } from '../ports/baseline.js';
import type { RepositoryInspector } from '../ports/repository-inspector.js';
import { mergeEffectiveSettings } from './effective-settings.js';
import { resolveEffectiveMaxConcurrentWorks } from './execution-authorization-policy.js';
import { resolveCurrentCheckPolicyDigest } from './plan-approval-verification.js';

const OPERATION = EXECUTION_PREVIEW_OPERATION;

/**
 * F-004 纯规则（可核对冻结面）：执行预览的影响面。只读预览（一致读视图 +
 * 受控仓库检查）；不修改任何计划实体、不创建执行实体、不扣预算、不启动
 * Runtime/Git/检查进程、不加载未选全局资源；唯一持久副作用是命令回执本身
 * （幂等重放复用原回执）。
 */
export const EXECUTION_PREVIEW_IMPACT = Object.freeze({
  readsConsistentView: true,
  performsControlledRepositoryInspection: true,
  changesPlanEntities: false,
  createsExecutionEntities: false,
  reservesOrSpendsBudget: false,
  startsRuntimeGitOrChecks: false,
  loadsUnselectedGlobalResources: false,
  runtimeExecutionClaimed: false,
});

/** 预览服务装配依赖（全部窄端口/用例；不接触具体适配器）。 */
export interface ExecutionPreviewServiceDeps {
  readonly views: ExecutionPreviewViewStore;
  readonly inspector: RepositoryInspector;
  readonly workspace: BaselineWorkspaceReader;
  readonly permissions: ExecutionPermissionsReader;
  /** 时间源（默认 Date.now；测试注入以获得确定性）。 */
  readonly nowMs?: () => number;
}

/**
 * 命令服务消费的执行预览端口：事务外预览（全部 I/O 均在写事务之外；预览为
 * 只读，命令短写事务内只持久化 completed 回执）。实现者：
 * createExecutionPreviewService。
 */
export interface ExecutionPreviewPort {
  previewExecution(
    projectId: string,
    payload: ValidatedExecutionPreviewPayload,
  ): Promise<ExecutionPreviewResult>;
}

function publicError(
  code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict' | 'corrupt_state' | 'internal',
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

function semanticMemberIdentityDigest(
  member: ExecutionPreviewMemberView,
  dependencyFeatureIds: readonly string[] = [],
): string {
  const canonical = stableStringify({
    featureId: member.feature.id,
    planDigest: member.feature.planDigest,
    planStatus: member.feature.planStatus,
    status: member.feature.status,
    tasks: member.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      strategy: computeExecutionStrategyCopyDigest({
        executionConfig: task.executionConfig,
        configSource: task.configSource,
        configSourceKey: task.configSourceKey,
      }),
    })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    dependencies: member.dependencies.map((edge) => ({ taskId: edge.taskId, dependsOnId: edge.dependsOnId }))
      .sort((left, right) => `${left.taskId}:${left.dependsOnId}` < `${right.taskId}:${right.dependsOnId}` ? -1 : 1),
    approvals: member.approvals.map((approval) => ({
      id: approval.id,
      subjectDigest: approval.subjectDigest,
      checkPolicyDigest: approval.checkPolicyDigest,
      status: approval.status,
    })),
    inputs: member.resolvedInputs.map((input) => ({
      artifactId: input.artifactId,
      declaredContentHash: input.declaredContentHash,
      resolved: input.resolved,
      unavailableReason: input.unavailableReason,
    })).sort((left, right) => left.artifactId < right.artifactId ? -1 : 1),
    dependencyFeatureIds: [...dependencyFeatureIds].sort(),
    readiness: member.readiness,
  });
  return createHash('sha256').update(`shiploop:execution-preview-member:v1\n${canonical}`, 'utf8').digest('hex');
}

function semanticRevision(identityDigest: string): number {
  // A bounded semantic revision avoids making a label-only row revision part of
  // authorization identity while remaining stable and auditable in the digest.
  return Number.parseInt(identityDigest.slice(0, 12), 16);
}

function scopeForResult(
  view: ExecutionPreviewScopeView | undefined,
  featureIds: readonly string[],
): ExecutionPreviewResult['scope'] {
  if (view === undefined) return { featureIds: [...featureIds] };
  return {
    featureIds: [...view.selection.memberFeatureIds],
    phaseId: view.phase.id,
    phaseRevision: view.phase.revision,
    requestedFeatureIds: [...view.selection.requestedFeatureIds],
    memberFeatureIds: [...view.selection.memberFeatureIds],
    members: view.members.map((member) => ({
      featureId: member.feature.id,
      revision: member.entity.revision,
      planDigest: member.entity.planDigest,
    })),
  };
}

/** 装配执行预览服务。只校验依赖形态（fail-closed），不执行任何 I/O。 */
export function createExecutionPreviewService(deps: ExecutionPreviewServiceDeps): ExecutionPreviewPort {
  const context: ValidationContext = { operation: `${OPERATION}.create` };
  if (deps === null || typeof deps !== 'object') {
    throw new StorageError('validation', context.operation, `${OPERATION}.create: deps 必须是对象`, {
      details: { field: 'deps', reason: 'invalid_type' },
    });
  }
  for (const [field, value] of [
    ['views', deps.views],
    ['inspector', deps.inspector],
    ['workspace', deps.workspace],
  ] as const) {
    if (value === null || typeof value !== 'object') {
      throw new StorageError(
        'validation',
        context.operation,
        `${OPERATION}.create: deps.${field} 必须是端口实现`,
        { details: { field: `deps.${field}`, reason: 'invalid_type' } },
      );
    }
  }
  if (typeof deps.views.readExecutionPreviewView !== 'function' &&
      typeof deps.views.readExecutionPreviewScopeView !== 'function') {
    throw new StorageError(
      'validation',
      context.operation,
      `${OPERATION}.create: deps.views 必须提供单成员或范围预览读取方法`,
      { details: { field: 'deps.views.readExecutionPreviewView', reason: 'invalid_type' } },
    );
  }
  if (typeof deps.inspector.inspect !== 'function') {
    throw new StorageError(
      'validation',
      context.operation,
      `${OPERATION}.create: deps.inspector 必须提供 inspect 方法`,
      { details: { field: 'deps.inspector.inspect', reason: 'invalid_type' } },
    );
  }
  if (typeof deps.workspace.readWorkspaceSummary !== 'function') {
    throw new StorageError(
      'validation',
      context.operation,
      `${OPERATION}.create: deps.workspace 必须提供 readWorkspaceSummary 方法`,
      { details: { field: 'deps.workspace.readWorkspaceSummary', reason: 'invalid_type' } },
    );
  }
  if (typeof deps.permissions !== 'function') {
    throw new StorageError(
      'validation',
      context.operation,
      `${OPERATION}.create: deps.permissions 必须是权限读取器函数`,
      { details: { field: 'deps.permissions', reason: 'invalid_type' } },
    );
  }
  const nowMs = deps.nowMs ?? Date.now;
  const { views, inspector, workspace, permissions } = deps;

  return {
    async previewExecution(projectId, payload) {
      const operation = OPERATION;
      const projectKey = validateStableId(projectId, { operation }, 'projectId');
      const now = nowMs();

      /* 1. 预算提案深校验（纯；零 I/O，先于视图与仓库/制品访问）。 */
      let budget: ExecutionBudgetProposal;
      try {
        budget = validateExecutionBudgetProposal(
          payload.budget,
          { operation, entity: { type: 'feature', projectId: projectKey } },
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

      const base = {
        schemaVersion: EXECUTION_PREVIEW_RESULT_SCHEMA_VERSION,
        projectId: projectKey,
        runtimeExecution: false as const,
      } as const;

      /* 2. 范围形态与一致读视图选择。Legacy empty featureIds remains P04 no_work. */
      const phaseSelector = payload.phaseId ?? null;
      if (phaseSelector === null && payload.featureIds.length === 0) {
        const emptyResult: ExecutionPreviewResult = {
          ...base,
          scope: { featureIds: [] },
          status: 'no_work',
          noWorkReason: 'empty_scope',
          blocked: [],
          previewDigest: null,
          summary: null,
          generatedAtUtcMs: now,
        };
        return emptyResult;
      }
      if (typeof views.readExecutionPreviewScopeView !== 'function' && payload.featureIds.length !== 1) {
        throw publicError('invalid_input', 'multi_feature_scope_unsupported', {
          featureIds: payload.featureIds.length,
          supported: 1,
        });
      }

      let scopeView: ExecutionPreviewScopeView | undefined;
      let legacyView: ExecutionPreviewView | undefined;
      try {
        if (typeof views.readExecutionPreviewScopeView === 'function' &&
            (phaseSelector !== null || payload.featureIds.length > 1)) {
          scopeView = views.readExecutionPreviewScopeView(projectKey, {
            phaseId: phaseSelector,
            featureIds: [...payload.featureIds],
          });
        } else {
          legacyView = views.readExecutionPreviewView!(projectKey, payload.featureIds[0]!);
        }
      } catch (cause) {
        if (isStorageError(cause, 'ownership')) {
          throw publicError('forbidden', 'ownership_denied', { entityType: phaseSelector === null ? 'feature' : 'phase' }, cause);
        }
        if (isStorageError(cause)) throw mapStorageError(cause, { operation });
        throw cause;
      }
      if (scopeView === undefined && legacyView === undefined) {
        throw publicError('not_found', phaseSelector === null ? 'feature_not_found' : 'phase_not_found', {
          entityType: phaseSelector === null ? 'feature' : 'phase',
        });
      }

      const members: readonly ExecutionPreviewMemberView[] = scopeView?.members ?? [{
        feature: legacyView!.feature,
        tasks: legacyView!.tasks,
        dependencies: legacyView!.dependencies,
        approvals: legacyView!.approvals,
        resolvedInputs: legacyView!.resolvedInputs,
        activeRuns: legacyView!.activeRuns,
        entity: { revision: legacyView!.feature.revision, planDigest: legacyView!.feature.planDigest },
        readiness: {
          featureId: legacyView!.feature.id,
          dependencyCompleted: true,
          dependencyCompletion: 'complete',
          integrationReady: true,
          dependencyIntegrationReady: true,
          ready: true,
          reason: 'ready',
        },
      }];
      const project = scopeView?.project ?? legacyView!.project;
      const phase = scopeView?.phase ?? legacyView!.phase;
      const binding = scopeView?.binding ?? legacyView!.binding;
      const settings = scopeView?.settings ?? legacyView!.settings;
      const activePhaseBatches = scopeView?.activePhaseBatches ?? (
        legacyView!.activePhaseBatch === null ? [] : [{
          id: legacyView!.activePhaseBatch.id,
          featureIds: [legacyView!.activePhaseBatch.featureId],
          status: legacyView!.activePhaseBatch.status,
        }]
      );
      const baselineOccupancy = scopeView?.baselineOccupancy ?? legacyView!.baselineOccupancy;
      const finalFeatureIds = scopeView?.selection.memberFeatureIds ?? [legacyView!.feature.id];
      const scope = scopeForResult(scopeView, finalFeatureIds);

      /* 3. Effective concurrency is shared by every frozen member. */
      let effective;
      try {
        effective = mergeEffectiveSettings({
          global: settings.global === null ? null : { scopeRevision: settings.global.scopeRevision, payload: settings.global.payload },
          project: settings.project === null ? null : { scopeRevision: settings.project.scopeRevision, payload: settings.project.payload },
        });
      } catch (cause) {
        throw mapToPublicError(cause, { operation });
      }
      const concurrency = resolveEffectiveMaxConcurrentWorks(effective.policies);
      if (concurrency.maxConcurrentWorks > 1) {
        throw publicError('invalid_input', 'concurrency_not_supported', {
          maxConcurrentWorks: concurrency.maxConcurrentWorks,
          source: concurrency.source,
        });
      }

      /* 4. No work is a scope-level result: do not hide blockers for a scope
       * that has nothing eligible to execute. */
      const memberPending = members.map((member) => ({
        member,
        tasks: member.tasks.filter((task) =>
          (EXECUTION_PREVIEW_PENDING_WORK_TASK_STATUSES as readonly string[]).includes(task.status),
        ),
      }));
      if (memberPending.every((entry) => entry.tasks.length === 0)) {
        return {
          ...base,
          scope,
          status: 'no_work',
          noWorkReason: 'no_pending_tasks',
          blocked: [],
          previewDigest: null,
          summary: null,
          generatedAtUtcMs: now,
        };
      }

      /* 5. All blockers come from the same consistent view. For a multi-member
       * preview every member blocker carries its member identity. */
      const multiMember = finalFeatureIds.length > 1 || phaseSelector !== null;
      const memberReason = <T extends Record<string, unknown>>(featureId: string, reason: T): T =>
        (multiMember ? { ...reason, featureId } : reason) as T;
      const blocked: ExecutionPreviewBlockedReason[] = [];
      const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
        settings.global === null ? null : { scopeRevision: settings.global.scopeRevision, payload: settings.global.payload },
        settings.project === null ? null : { scopeRevision: settings.project.scopeRevision, payload: settings.project.payload },
      );
      const validityByFeature = new Map<string, ReturnType<typeof evaluatePlanApprovalValidity>>();
      for (const entry of memberPending) {
        const validity = evaluatePlanApprovalValidity({
          planDigest: entry.member.feature.planDigest,
          planStatus: entry.member.feature.planStatus,
          taskCount: entry.member.tasks.length,
          decisions: entry.member.approvals,
          currentCheckPolicyDigest: checkPolicyDigest,
        });
        validityByFeature.set(entry.member.feature.id, validity);
        if (!validity.valid) blocked.push(memberReason(entry.member.feature.id, { kind: 'plan_approval', reason: validity.reason } as const));
      }
      if (project.status !== 'active') {
        for (const entry of memberPending) blocked.push(memberReason(entry.member.feature.id, { kind: 'project_not_active', status: project.status } as const));
      }
      if (phase.status !== 'open') {
        for (const entry of memberPending) blocked.push(memberReason(entry.member.feature.id, { kind: 'phase_not_executable', status: phase.status } as const));
      }
      for (const entry of memberPending) {
        const readiness = entry.member.readiness;
        if (readiness.reason === 'dependency_pending' || readiness.reason === 'dependency_failed') {
          blocked.push({ kind: 'feature_dependency', featureId: entry.member.feature.id, reason: readiness.reason });
        } else if (readiness.reason === 'integration_not_ready') {
          blocked.push({ kind: 'feature_integration', featureId: entry.member.feature.id, reason: readiness.reason });
        }
        for (const run of [...entry.member.activeRuns].sort((left, right) => left.id < right.id ? -1 : 1)) {
          blocked.push(memberReason(entry.member.feature.id, { kind: 'active_run', runId: run.id, status: run.status } as const));
        }
      }
      for (const batch of [...activePhaseBatches].sort((left, right) => left.id < right.id ? -1 : 1)) {
        for (const entry of memberPending) {
          blocked.push({ kind: 'active_batch_in_phase', batchId: batch.id, featureId: entry.member.feature.id, status: batch.status });
        }
      }
      if (baselineOccupancy.holderOperationId !== null) {
        for (const entry of memberPending) {
          blocked.push(memberReason(entry.member.feature.id, {
            kind: 'baseline_occupancy', holderOperationId: baselineOccupancy.holderOperationId,
          } as const));
        }
      }
      const inputEntries = memberPending.flatMap(({ member }) => member.resolvedInputs.map((input) => ({ member, input })));
      for (const { member, input } of inputEntries.sort((left, right) =>
        left.input.artifactId < right.input.artifactId ? -1 : left.input.artifactId > right.input.artifactId ? 1 :
          left.member.feature.id < right.member.feature.id ? -1 : 1)) {
        const detail = input.resolved === null
          ? (input.unavailableReason ?? 'not_found')
          : input.declaredContentHash !== null && input.resolved.contentHash !== input.declaredContentHash
            ? 'content_mismatch' : null;
        if (detail !== null) {
          blocked.push(memberReason(member.feature.id, { kind: 'required_input_unavailable', artifactId: input.artifactId, detail } as const));
        }
      }
      if (blocked.length > 0) {
        return {
          ...base,
          scope,
          status: 'blocked',
          noWorkReason: null,
          blocked,
          previewDigest: null,
          summary: null,
          generatedAtUtcMs: now,
        };
      }

      /* 6. Controlled repository I/O is shared once for the frozen project
       * baseline and remains outside any write transaction. */
      if (binding === null) throw publicError('conflict', 'binding_missing', { entityType: 'repository_binding' });
      let inspection;
      try {
        inspection = await inspector.inspect(binding.canonicalPath);
      } catch (cause) {
        throw mapToPublicError(cause, { operation });
      }
      if (inspection.repoIdentity !== binding.repoIdentity) {
        throw publicError('conflict', 'binding_identity_mismatch', { entityType: 'repository_binding' });
      }
      let workspaceSummary;
      try {
        workspaceSummary = await workspace.readWorkspaceSummary(inspection.canonicalPath);
      } catch (cause) {
        throw mapToPublicError(cause, { operation });
      }
      const code: ExecutionPreviewCodeIdentity = {
        headCommit: inspection.headCommit,
        workingTreeDigest: workspaceSummary.digest,
        hasUncommittedChanges: inspection.hasUncommittedChanges,
      };

      /* 7. Complete frozen identity summary. Labels are deliberately absent from
       * the semantic member identity; plan, approval, task, input, readiness and
       * code-baseline facts remain bound. */
      const validityByMember = new Map<string, ReturnType<typeof evaluatePlanApprovalValidity>>();
      for (const member of members) {
        const validity = validityByFeature.get(member.feature.id) ?? evaluatePlanApprovalValidity({
          planDigest: member.feature.planDigest,
          planStatus: member.feature.planStatus,
          taskCount: member.tasks.length,
          decisions: member.approvals,
          currentCheckPolicyDigest: checkPolicyDigest,
        });
        validityByMember.set(member.feature.id, validity);
        if (!validity.valid || validity.planDigest === null) {
          throw publicError('corrupt_state', 'approval_state_inconsistent', { featureId: member.feature.id });
        }
      }
      const taskEntries = members.flatMap((member) => member.tasks.map((task) => ({ member, task })));
      const tasks: readonly ExecutionPreviewTaskSummary[] = [...taskEntries]
        .sort((left, right) => left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : left.member.feature.id < right.member.feature.id ? -1 : 1)
        .map(({ member, task }) => ({
          taskId: task.id,
          status: task.status,
          strategyCopyDigest: computeExecutionStrategyCopyDigest({
            executionConfig: task.executionConfig,
            configSource: task.configSource,
            configSourceKey: task.configSourceKey,
          }),
          strategyConfigSource: task.configSource,
          ...(multiMember ? { featureId: member.feature.id } : {}),
        }));
      const permissionsEntries: readonly ExecutionPreviewTaskPermissions[] = [...taskEntries]
        .sort((left, right) => left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : left.member.feature.id < right.member.feature.id ? -1 : 1)
        .map(({ member, task }) => ({
          taskId: task.id,
          digest: computeExecutionPermissionsDigest(
            readPermissionsFace(permissions, {
              projectId: projectKey,
              featureId: member.feature.id,
              taskId: task.id,
            }).grants,
          ),
          ...(multiMember ? { featureId: member.feature.id } : {}),
        }));
      const inputRefsByIdentity = new Map<string, ExecutionPreviewInputRefSummary>();
      for (const member of members) {
        for (const input of member.resolvedInputs) {
          if (input.resolved === null) continue;
          const value: ExecutionPreviewInputRefSummary = {
            artifactId: input.artifactId,
            version: input.resolved.version,
            contentHash: input.resolved.contentHash,
            sizeBytes: input.resolved.sizeBytes,
          };
          inputRefsByIdentity.set(`${value.artifactId}\u0000${value.version}\u0000${value.contentHash}`, value);
        }
      }
      const inputRefs = [...inputRefsByIdentity.values()].sort((left, right) => left.artifactId < right.artifactId ? -1 : 1);
      const codeBaselineRefsByMember = new Map<string, string[]>();
      for (const member of members) {
        codeBaselineRefsByMember.set(member.feature.id, (scopeView?.featureDependencies ?? [])
          .filter((edge) => edge.featureId === member.feature.id && edge.codeBaselineRef !== null)
          .map((edge) => edge.codeBaselineRef!)
          .sort());
      }
      const memberIdentityRows = members.map((member) => {
        const dependencyFeatureIds = (scopeView?.featureDependencies ?? [])
          .filter((edge) => edge.featureId === member.feature.id)
          .map((edge) => edge.dependsOnId)
          .sort();
        const identityDigest = semanticMemberIdentityDigest(member, dependencyFeatureIds);
        return {
          featureId: member.feature.id,
          revision: semanticRevision(identityDigest),
          planDigest: member.feature.planDigest,
          identityDigest,
          codeBaselineRefs: codeBaselineRefsByMember.get(member.feature.id) ?? [],
          dependencyFeatureIds,
          readiness: member.readiness,
        };
      });
      const aggregatePlanDigest = members.length === 1
        ? members[0]!.feature.planDigest!
        : createHash('sha256').update(`shiploop:execution-preview-plans:v1\n${stableStringify(
          members.map((member) => ({ featureId: member.feature.id, planDigest: member.feature.planDigest }))
            .sort((left, right) => left.featureId < right.featureId ? -1 : 1),
        )}`, 'utf8').digest('hex');
      const memberSummaries = members.map((member) => ({
        featureId: member.feature.id,
        revision: member.entity.revision,
        planDigest: member.feature.planDigest,
        planStatus: member.feature.planStatus,
        status: member.feature.status,
        readiness: member.readiness,
        codeBaselineRefs: codeBaselineRefsByMember.get(member.feature.id) ?? [],
        taskCount: member.tasks.length,
        pendingTaskIds: member.tasks.filter((task) =>
          (EXECUTION_PREVIEW_PENDING_WORK_TASK_STATUSES as readonly string[]).includes(task.status),
        ).map((task) => task.id).sort(),
      }));
      const aggregateDecisionId = members.length === 1
        ? (validityByMember.get(members[0]!.feature.id)?.currentDecisionId ?? null)
        : null;
      const summary: ExecutionPreviewSummary = {
        members: memberSummaries,
        approval: {
          planDigest: aggregatePlanDigest,
          checkPolicyDigest,
          decisionId: aggregateDecisionId,
        },
        plan: {
          planDigest: aggregatePlanDigest,
          taskCount: tasks.length,
          pendingTaskIds: memberSummaries.flatMap((member) => member.pendingTaskIds)
            .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
        },
        code,
        checkPolicyDigest,
        tasks,
        permissions: { tasks: permissionsEntries },
        inputs: { refs: inputRefs },
        budget,
        concurrency: {
          maxConcurrentWorks: concurrency.maxConcurrentWorks,
          source: concurrency.source,
        },
      };
      const digestInput = {
        projectId: projectKey,
        phaseId: phase.id,
        featureIds: finalFeatureIds,
        planDigest: members.length === 1 ? members[0]!.feature.planDigest : aggregatePlanDigest,
        code,
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          strategyCopyDigest: task.strategyCopyDigest,
          ...(task.featureId === undefined ? {} : { featureId: task.featureId }),
        })),
        checkPolicyDigest,
        permissions: permissionsEntries,
        inputs: inputRefs,
        budget,
        ...(multiMember ? { memberIdentities: memberIdentityRows, concurrency } : {}),
      };
      const previewDigest = computeExecutionPreviewDigest(digestInput);
      const result: ExecutionPreviewResult = {
        ...base,
        scope,
        status: 'ready',
        noWorkReason: null,
        blocked: [],
        previewDigest,
        summary,
        generatedAtUtcMs: now,
      };
      let serialized: string;
      try {
        serialized = JSON.stringify(result);
      } catch {
        throw publicError('internal', 'preview_serialization_failed');
      }
      if (Buffer.byteLength(serialized, 'utf8') > RECEIPT_RESULT_MAX_BYTES) {
        throw publicError('invalid_input', 'preview_result_too_large', {
          field: 'featureIds',
          limitBytes: RECEIPT_RESULT_MAX_BYTES,
        });
      }
      return result;
    },
  };
}
