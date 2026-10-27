/**
 * P05-1 / F-011 规划上下文/候选只读授权查询服务（application 层）。
 *
 * 设计依据：input/p05-planning.md FR-4、core-design/04 §3/§6（原因可查询、
 * 查询零写入）与 docs/p05-1-planning-candidate-contract.md（单候选、历史保留）。
 *
 * 不变量：
 * - 能力核验（project.read）→ 输入校验 → 项目可见性 → 一致读，顺序固定；
 *   跨项目/不存在目标统一 not_found（不区分存在性，不泄漏归属）；
 * - 查询零写入、零事件、零唤醒：不触发模型、恢复、导入或任何状态变更；
 * - 列表复用计划分页规则（plcur_v1_ 受控游标绑定数据根 + 项目 [+ Feature
 *   过滤]；跨项目/跨过滤/跨根重放 invalid_cursor，绝不当从零读取）；
 * - 详情预算投影复用既有 execution.budget.get 纯投影（buildExecutionBudget
 *   Status；Task 面过滤为 planning Task，不创建第二套预算事实）；
 * - 候选正文只经既有受管 Artifact 完整性核验读取（ArtifactVerifier +
 *   hash/size 复核）+ 候选契约校验 + 身份/摘要交叉核对；缺失/损坏
 *   fail-closed 为 corrupt_state，不返回伪造空候选；
 * - 生成前候选明确 pending_generation（candidateId 身份已绑定、Artifact
 *   未发布），候选详情不虚构正文与摘要。
 */
import {
  assertTrustedPrincipal,
  isProjectVisible,
  principalProjectVisibility,
  requireCapability,
  requireProjectVisible,
} from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import { PublicError, WIRE_MESSAGE_SCHEMA_VERSION, mapToPublicError } from '../ports/commands.js';
import { isStorageError } from '../ports/errors.js';
import { requirePlainObject } from '../ports/validation.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import {
  createPlanListCursorBinding,
  decodePlanListCursor,
  encodePlanListCursor,
  validatePlanListFilter,
} from '../ports/queries.js';
import type { PlanListCursorBinding, PlanListRequest, PlanListScope } from '../ports/queries.js';
import type { ExecutionBudgetQueryReadStore } from '../ports/execution-budget-query.js';
import { buildExecutionBudgetStatus } from '../ports/execution-budget-query.js';
import type { ExecutionBudgetStatusResult, ExecutionBudgetView } from '../ports/execution-budget-query.js';
import {
  PLANNING_CANDIDATE_ARTIFACT_KIND,
  computePlanningCandidateDigest,
  validatePlanningCandidatePayload,
} from '../ports/planning-candidates.js';
import type { ValidatedPlanningCandidate } from '../ports/planning-candidates.js';
import {
  PLANNING_CANDIDATE_BODY_MAX_READ_BYTES,
  PLANNING_CANDIDATE_GET_OPERATION,
  PLANNING_CONTEXTS_LIST_OPERATION,
  PLANNING_CONTEXT_GET_OPERATION,
  derivePlanningOutcomeAxes,
  derivePlanningQueryState,
  planningCandidateBodyError,
  planningQueryTargetNotFound,
  toPublicPlanningAttemptRecord,
  toPublicPlanningContextRecord,
  toPublicPlanningContextSummary,
  toPublicPlanningRunRecord,
  validatePlanningContextsListTarget,
  validatePlanningContextTargetInput,
} from '../ports/planning-query.js';
import type {
  PlanningCandidateDetailResult,
  PlanningContextDetailResult,
  PlanningContextListResult,
  PlanningContextQueryView,
  PlanningQueryReadStore,
  PublicPlanningCandidateBody,
} from '../ports/planning-query.js';
import { createArtifactVerifier, isArtifactVerifyError } from './artifact-verify.js';
import { mergeEffectiveSettings } from './effective-settings.js';

/** 规划查询服务（三个只读入口；principal 由可信装配显式传入）。 */
export interface PlanningQueryService {
  /** planning.contexts.list：项目（可选 Feature 过滤）规划上下文有界分页。 */
  listPlanningContexts(principal: unknown, input: unknown): Promise<PlanningContextListResult>;
  /** planning.context.get：按候选身份的规划详情（身份/状态/决策/预算/停止原因）。 */
  getPlanningContext(principal: unknown, input: unknown): Promise<PlanningContextDetailResult>;
  /** planning.candidate.get：候选详情（正文经受管 Artifact 完整性核验读取）。 */
  getPlanningCandidate(principal: unknown, input: unknown): Promise<PlanningCandidateDetailResult>;
}

export interface PlanningQueryServiceOptions {
  /** 规划上下文一致读窄端口（只读）。 */
  readonly planningReads: PlanningQueryReadStore;
  /** 既有执行预算一致读窄端口（只读；预算投影复用）。 */
  readonly executionBudgetReads: ExecutionBudgetQueryReadStore;
  /** 制品索引（正文经完整性核验读取；只读用法）。 */
  readonly artifacts: ArtifactStore;
  /** 制品文件（只读用法；不推导任意路径）。 */
  readonly artifactFiles: ArtifactFileStore;
  /** 数据根身份（64hex；可信装配由 realpath 数据根派生，绝不来自请求数据）。 */
  readonly dataRootIdentity: string;
  /** UTC 毫秒时钟（默认 Date.now；测试注入以获得确定性预算参考时间）。 */
  readonly nowUtcMs?: () => number;
}

/**
 * 装配规划查询服务。只校验依赖形态，不执行任何 I/O；import 本模块无副作用。
 */
export function createPlanningQueryService(options: PlanningQueryServiceOptions): PlanningQueryService {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createPlanningQueryService: options 必须是对象');
  }
  const { planningReads, executionBudgetReads, artifacts, artifactFiles, dataRootIdentity } = options;
  if (planningReads === null || typeof planningReads !== 'object') {
    throw new TypeError('createPlanningQueryService: planningReads 必须是 PlanningQueryReadStore');
  }
  if (executionBudgetReads === null || typeof executionBudgetReads !== 'object') {
    throw new TypeError('createPlanningQueryService: executionBudgetReads 必须是 ExecutionBudgetQueryReadStore');
  }
  if (typeof dataRootIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(dataRootIdentity)) {
    throw new TypeError('createPlanningQueryService: dataRootIdentity 必须是 64 位小写十六进制（可信装配派生）');
  }
  const nowUtcMs = options.nowUtcMs ?? Date.now;
  // 候选正文读取器：与 F-006 受限提交入口同一正文界（hash/size 核验失败即拒绝）。
  const candidateVerifier = createArtifactVerifier({
    artifacts,
    files: artifactFiles,
    limits: { maxReadBytes: PLANNING_CANDIDATE_BODY_MAX_READ_BYTES },
  });

  function planCursorBinding(scope: PlanListScope, operation: string): PlanListCursorBinding {
    return createPlanListCursorBinding({ rootIdentity: dataRootIdentity, scope }, operation);
  }

  function planListRequest(
    filter: { readonly limit: number; readonly cursor?: string },
    binding: PlanListCursorBinding,
    operation: string,
  ): PlanListRequest {
    return {
      afterId:
        filter.cursor === undefined
          ? null
          : decodePlanListCursor(filter.cursor, binding, operation).lastId,
      limit: filter.limit,
    };
  }

  /** 详情视图读取（授权后）：目标项目不可见或未命中统一 not_found（不区分存在性）。 */
  function readViewOrNotFound(
    principal: TrustedPrincipal,
    projectId: string,
    candidateId: string,
    operation: string,
  ): PlanningContextQueryView {
    const view = planningReads.readPlanningContextView(projectId, candidateId);
    if (view === undefined || !isProjectVisible(principal, view.context.projectId)) {
      planningQueryTargetNotFound(operation);
    }
    return view;
  }

  /** 预算投影：复用既有纯投影；Task 面过滤为 planning Task（只读派生）。 */
  function buildPlanningBudget(view: PlanningContextQueryView, operation: string): ExecutionBudgetStatusResult {
    const budgetView = executionBudgetReads.readExecutionBudgetView(
      view.context.projectId,
      view.run.batchId,
    );
    if (budgetView === undefined) {
      throw new PublicError('corrupt_state', operation, '规划 Batch 预算视图缺失', {
        details: { reason: 'planning_batch_missing' },
      });
    }
    const planningTaskRow = budgetView.tasks.find((row) => row.taskId === view.context.planningTaskId);
    if (planningTaskRow === undefined) {
      throw new PublicError('corrupt_state', operation, '规划 Batch 预算视图缺少 planning Task 事实', {
        details: { reason: 'planning_task_budget_row_missing' },
      });
    }
    const filtered: ExecutionBudgetView = {
      batch: budgetView.batch,
      runs: budgetView.runs,
      tasks: [planningTaskRow],
      settings: budgetView.settings,
    };
    const effective = mergeEffectiveSettings({
      global: filtered.settings.global,
      project: filtered.settings.project,
    });
    const maxAttemptsPerTask = effective.policies.executionLimits?.value.maxAttemptsPerTask ?? null;
    return buildExecutionBudgetStatus(filtered, { nowUtcMs: nowUtcMs(), maxAttemptsPerTask });
  }

  /** 候选正文核验读取：完整性 → JSON → 契约校验 → 身份/摘要交叉核对。 */
  async function readVerifiedCandidate(
    view: PlanningContextQueryView,
    operation: string,
  ): Promise<PublicPlanningCandidateBody> {
    const context = view.context;
    const artifactId = context.candidateArtifactRef!.artifactId;
    const expectedHash = context.candidateArtifactRef!.contentHash;
    let artifact;
    try {
      artifact = await artifacts.getArtifact(context.projectId, artifactId);
    } catch (error) {
      if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
        planningCandidateBodyError(operation, 'candidate_artifact_missing');
      }
      throw error;
    }
    if (artifact.status !== 'ready') {
      planningCandidateBodyError(operation, 'candidate_artifact_not_ready');
    }
    if (artifact.kind !== PLANNING_CANDIDATE_ARTIFACT_KIND) {
      planningCandidateBodyError(operation, 'candidate_artifact_kind_mismatch');
    }
    if (artifact.contentHash !== expectedHash || artifact.expectedHash !== expectedHash) {
      planningCandidateBodyError(operation, 'candidate_artifact_changed');
    }
    let verified;
    try {
      verified = await candidateVerifier.readVerifiedContent(context.projectId, artifactId);
    } catch (error) {
      if (isArtifactVerifyError(error, 'size_limit_exceeded')) {
        planningCandidateBodyError(operation, 'candidate_body_size_limit');
      }
      if (isArtifactVerifyError(error) && error.corruption?.kind === 'missing') {
        planningCandidateBodyError(operation, 'candidate_body_missing');
      }
      planningCandidateBodyError(operation, 'candidate_body_corrupt');
    }
    if (verified.contentHash !== expectedHash) {
      planningCandidateBodyError(operation, 'candidate_artifact_changed');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(verified.content).toString('utf8')) as unknown;
    } catch {
      planningCandidateBodyError(operation, 'candidate_payload_invalid');
    }
    let candidate: ValidatedPlanningCandidate;
    try {
      candidate = validatePlanningCandidatePayload(parsed, { operation });
    } catch {
      planningCandidateBodyError(operation, 'candidate_payload_invalid');
    }
    if (
      candidate.projectId !== context.projectId ||
      candidate.featureId !== context.featureId ||
      candidate.runId !== context.runId ||
      candidate.candidateId !== context.candidateId
    ) {
      planningCandidateBodyError(operation, 'candidate_identity_mismatch');
    }
    if (candidate.candidateDigest !== context.candidateDigest) {
      planningCandidateBodyError(operation, 'candidate_digest_mismatch');
    }
    // 摘要重算交叉核对（正文与上下文登记的 candidateDigest 双向一致）。
    if (computePlanningCandidateDigest(candidate) !== context.candidateDigest) {
      planningCandidateBodyError(operation, 'candidate_digest_mismatch');
    }
    return {
      state: 'published',
      artifact: {
        artifactId: verified.artifactId,
        contentHash: verified.contentHash,
        sizeBytes: verified.sizeBytes,
      },
      candidateDigest: candidate.candidateDigest,
      summary: candidate.summary,
      plan: {
        feature: {
          title: candidate.plan.feature.title,
          description: candidate.plan.feature.description,
          labels: [...candidate.plan.feature.labels],
        },
        tasks: candidate.plan.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          complexity: task.complexity,
          dependsOn: [...task.dependsOn],
        })),
        taskCount: candidate.plan.taskCount,
        dependencyEdgeCount: candidate.plan.dependencyEdgeCount,
      },
      taskVerification: candidate.taskVerification.map((intent) => ({
        taskId: intent.taskId,
        checkRefs: [...intent.checkRefs],
        moduleRefs: [...intent.moduleRefs],
        impactScope: [...intent.impactScope],
      })),
    };
  }

  return {
    async listPlanningContexts(principal: unknown, input: unknown): Promise<PlanningContextListResult> {
      assertTrustedPrincipal(principal);
      const operation = PLANNING_CONTEXTS_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const raw = requirePlainObject(input, { operation }, 'input');
        const target = validatePlanningContextsListTarget(raw, operation);
        // 可见性先于分页校验：不可见项目携带非法 limit/cursor 也先 forbidden。
        requireProjectVisible(principal, target.projectId, operation);
        const filterSource: Record<string, unknown> = {};
        if (raw.limit !== undefined) filterSource.limit = raw.limit;
        if (raw.cursor !== undefined) filterSource.cursor = raw.cursor;
        const filter = validatePlanListFilter(filterSource, operation);
        // 游标绑定数据根 + 项目 [+ Feature 过滤]：跨项目/跨过滤/跨根重放一律
        // invalid_cursor，绝不当作从零读取，也不先泄漏目标存在性。
        const scope: PlanListScope = target.featureId === null
          ? { kind: 'planning-contexts', projectId: target.projectId }
          : { kind: 'feature-planning-contexts', projectId: target.projectId, featureId: target.featureId };
        const binding = planCursorBinding(scope, operation);
        const request = planListRequest(filter, binding, operation);
        const page = planningReads.listPlanningContextRecords(
          principalProjectVisibility(principal),
          target.projectId,
          target.featureId,
          request,
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'planning-context-list',
          records: page.records.map(toPublicPlanningContextSummary),
          nextCursor: page.nextId === null ? null : encodePlanListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getPlanningContext(principal: unknown, input: unknown): Promise<PlanningContextDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = PLANNING_CONTEXT_GET_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const valid = validatePlanningContextTargetInput(input, operation);
        const view = readViewOrNotFound(principal, valid.projectId, valid.candidateId, operation);
        const latestAttemptStatus = view.attempts.length > 0
          ? view.attempts[view.attempts.length - 1].status
          : null;
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'planning-context',
          context: toPublicPlanningContextRecord(view.context),
          executionState: derivePlanningQueryState({
            contextStatus: view.context.status,
            runStatus: view.run.status,
            latestAttemptStatus,
          }),
          outcomeAxes: derivePlanningOutcomeAxes({
            runStatus: view.run.status,
            featurePlanStatus: view.feature.planStatus,
            codingTaskCount: view.feature.codingTaskCount,
          }),
          run: toPublicPlanningRunRecord(view.run),
          attempts: view.attempts.map(toPublicPlanningAttemptRecord),
          attemptsTruncated: view.attemptsTruncated,
          budget: buildPlanningBudget(view, operation),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getPlanningCandidate(principal: unknown, input: unknown): Promise<PlanningCandidateDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = PLANNING_CANDIDATE_GET_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const valid = validatePlanningContextTargetInput(input, operation);
        const view = readViewOrNotFound(principal, valid.projectId, valid.candidateId, operation);
        const base = {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION as typeof WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'planning-candidate' as const,
          context: toPublicPlanningContextRecord(view.context),
          runStatus: view.run.status,
        };
        // 生成前候选：身份已绑定但 Artifact 未发布——明确 pending_generation，
        // 不读取正文、不伪造摘要/空候选。
        if (view.context.candidateArtifactRef === null || view.context.candidateDigest === null) {
          return { ...base, candidate: { state: 'pending_generation' } };
        }
        return { ...base, candidate: await readVerifiedCandidate(view, operation) };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },
  };
}
