/**
 * P03-8 / F-009 Git 意图、实际提交与操作回执只读查询（ports 纯契约层）。
 *
 * 设计依据：input/p03-feature-delivery.md FR-1（意图/实际 commit/回执分别
 * 可查询，不用一条 completed 掩盖失败）与 core-design/07 §4（提交作为
 * operation：意图 → 执行 → 核对 → 回执）；查询面纪律沿用
 * docs/p02-2-commands-events-contract.md §7（查询与分页）。
 *
 * 不变量：
 * - 公开记录是 F-002 持久事实（GitOperationRecord，已经 validateGitOperationRecord
 *   fail-closed 复核）的脱敏投影：不含 worktreePath（开发机固定绝对路径）、
 *   ownerId/hostInstanceId（内部执行归属），绝不携带凭据/敏感环境值/原始堆栈；
 * - 用户身份来源即 F-001 确认的提交身份（confirmed 恒 true，绝不回落开发机
 *   全局身份）；Runtime/provider/model 是独立审计记录，与 Git 身份分离；
 * - 实际 parent：succeeded 的执行/核对已验证实际提交的唯一 parent 等于固定的
 *   预期 HEAD（F-003/F-004 同一核对），公开面按该持久事实展示为
 *   actualParent = expectedHead；其余状态无已核对 parent（null，不冒充事实）；
 * - pending（回执缺失）与 unknown（核对后仍不确定）绝不展示为成功：
 *   status/deliveryStatus 原样保留（Feature unknown 的 deliveryStatus='pending'，
 *   Task 终态恒 not_requested，不投影 Feature 交付，
 *   pending 无回执/无 deliveryStatus），actual 事实未知保持 null；
 * - 列表复用计划分页的同一纪律（有界 limit、稳定 id 升序键集、plcur_v1_
 *   受控游标绑定数据根 + 项目 + 父级）；父级必须且只能为 Feature 或 Run 之一；
 * - 本模块是纯契约：只做类型声明与确定性校验，不读时钟/文件系统/网络/数据库，
 *   不导入 Git、SDK、HTTP 或 ORM。真实 SQLite 读取实现在 adapters 层。
 */
import type { ConfirmedGitIdentity, RuntimeSourceAuditRecord } from './delivery-policy.js';
import type {
  FeatureDeliveryStatus,
  GitOperationEvidenceRef,
  GitOperationReceipt,
  GitOperationRecord,
  GitOperationStatus,
  GitOperationType,
} from './git-operations.js';
import { WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import type { PlanListRequest, PlanListResultBase, PlanRecordPage } from './queries.js';
import { validateStableId, validationError } from './validation.js';
import type { ValidationContext } from './validation.js';

/** Git 操作查询操作身份（Core 查询面与 Host 路由/能力宣告同源，不漂移）。 */
export const GIT_OPERATIONS_LIST_OPERATION = 'git.operations.list';
export const GIT_OPERATION_GET_OPERATION = 'git.operations.get';
export const GIT_OPERATION_QUERY_OPERATIONS = [
  GIT_OPERATIONS_LIST_OPERATION,
  GIT_OPERATION_GET_OPERATION,
] as const;
export type GitOperationQueryOperation = (typeof GIT_OPERATION_QUERY_OPERATIONS)[number];

/**
 * 公开 Git 操作记录：意图（提交边界/预期 HEAD/tree/依据引用/消息/用户身份/
 * 政策摘要/Runtime 审计）+ 实际事实（parent/commit/tree/退出/耗时/原因）+
 * 回执与交付投影；时间为 ISO UTC。逐字段来自持久记录，不虚构未核对事实。
 */
export interface PublicGitOperationRecord {
  readonly operationId: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly attemptId: string | null;
  readonly executionVersion: number;
  readonly operationType: GitOperationType;
  /** 不可变意图身份摘要（与回执 intentDigest 一致）。 */
  readonly intentDigest: string;
  readonly repositoryBindingId: string;
  readonly repoIdentity: string;
  /** 提交边界（执行前固定）：预期 HEAD 即预期 parent。 */
  readonly expectedHead: string;
  readonly candidateTree: string;
  readonly codeDigest: string;
  /** 实际提交事实（未知保持 null，不以 0/占位填充）。 */
  readonly actualCommit: string | null;
  readonly actualTree: string | null;
  /**
   * 已核对的实际 parent：succeeded 时恒等于 expectedHead（执行/核对已验证
   * 实际提交的唯一 parent）；其余状态无已核对 parent（null，不冒充事实）。
   */
  readonly actualParent: string | null;
  /** 有效验证/审批引用（kind/id/digest；摘要漂移使引用失效）。 */
  readonly verificationRefs: readonly GitOperationEvidenceRef[];
  readonly approvalRefs: readonly GitOperationEvidenceRef[];
  readonly message: string;
  /** 用户身份来源：用户明确配置并确认的提交身份（confirmed 恒 true）。 */
  readonly gitIdentity: ConfirmedGitIdentity;
  readonly deliveryPolicyDigest: string;
  /** Runtime/provider/model 独立审计（与 Git 身份分离；不携带凭据）。 */
  readonly runtimeSource: RuntimeSourceAuditRecord | null;
  readonly status: GitOperationStatus;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** 失败或待核对原因（受控原因码；未知为 null）。 */
  readonly reasonCode: string | null;
  /** pending 为 null；Task 终态为 not_requested；Feature unknown 为 pending。 */
  readonly deliveryStatus: FeatureDeliveryStatus | null;
  /** 权威操作回执（pending 回执缺失为 null——明确的待核对展示，不是成功）。 */
  readonly receipt: GitOperationReceipt | null;
  readonly integration?: PublicGitIntegrationView | null;
  readonly settledAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicGitIntegrationView {
  readonly integrationId: string;
  readonly targetBase: string;
  readonly inputDigest: string;
  readonly approvedInputs: readonly { readonly inputId: string; readonly digest: string }[];
  readonly mergeOrder: readonly string[];
  readonly verificationScope: readonly string[];
  readonly predecessors: readonly {
    readonly featureId: string;
    readonly commitSha: string | null;
    readonly coveredInputIds: readonly string[];
  }[];
  readonly result: GitOperationRecord['integrationResult'];
  readonly recoveryState: GitOperationRecord['recoveryState'];
  readonly workspacePreserved: boolean;
}
/**
 * 持久记录 → 公开投影（纯转换；输入已经 validateGitOperationRecord 复核）。
 * 脱敏纪律：不投影 worktreePath/ownerId/hostInstanceId，也不暴露集成计划中的
 * canonicalPath、gitCommonDir 或预算快照。
 */
export function toPublicGitOperationRecord(record: GitOperationRecord): PublicGitOperationRecord {
  return {
    operationId: record.intent.operationId,
    projectId: record.intent.projectId,
    featureId: record.intent.featureId,
    runId: record.intent.runId,
    attemptId: record.intent.attemptId,
    executionVersion: record.intent.executionVersion,
    operationType: record.intent.operationType,
    intentDigest: record.intentDigest,
    repositoryBindingId: record.intent.repositoryBindingId,
    repoIdentity: record.intent.repoIdentity,
    expectedHead: record.intent.expectedHead,
    candidateTree: record.intent.candidateTree,
    codeDigest: record.intent.codeDigest,
    actualCommit: record.actualCommit,
    actualTree: record.actualTree,
    actualParent: record.status === 'succeeded' ? record.intent.expectedHead : null,
    verificationRefs: record.intent.verificationRefs.map(ref => ({ ...ref })),
    approvalRefs: record.intent.approvalRefs.map(ref => ({ ...ref })),
    message: record.intent.message,
    gitIdentity: { ...record.intent.gitIdentity },
    deliveryPolicyDigest: record.intent.deliveryPolicyDigest,
    runtimeSource:
      record.intent.runtimeSource === null
        ? null
        : {
            runtime: record.intent.runtimeSource.runtime,
            provider: record.intent.runtimeSource.provider,
            model: record.intent.runtimeSource.model,
            source: { ...record.intent.runtimeSource.source },
          },
    status: record.status,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    reasonCode: record.reasonCode,
    deliveryStatus: record.deliveryStatus,
    receipt: record.receipt === null ? null : { ...record.receipt },
    integration: record.intent.integrationPlan === null || record.intent.integrationPlan === undefined ? null : {
      integrationId: record.intent.integrationPlan.integrationId,
      targetBase: record.intent.integrationPlan.target.baseCommit,
      inputDigest: record.intent.integrationPlan.inputDigest,
      approvedInputs: record.intent.integrationPlan.approvedInputs.map(input => ({ ...input })),
      mergeOrder: [...record.intent.integrationPlan.mergeOrder],
      verificationScope: [...record.intent.integrationPlan.verificationScope],
      predecessors: record.intent.integrationPlan.predecessors.map(predecessor => ({
        featureId: predecessor.featureId,
        commitSha: predecessor.delivery?.commitSha ?? null,
        coveredInputIds: [...predecessor.coveredInputIds],
      })),
      result: record.integrationResult,
      recoveryState: record.recoveryState,
      workspacePreserved: record.workspacePreserved,
    },
    settledAt:
      record.settledAtUtcMs === null ? null : new Date(record.settledAtUtcMs).toISOString(),
    revision: record.revision,
    createdAt: new Date(record.createdAtUtcMs).toISOString(),
    updatedAt: new Date(record.updatedAtUtcMs).toISOString(),
  };
}

/** git.operations.list → {schemaVersion, scope:'git-operation-list', records, nextCursor, limit}。 */
export interface GitOperationListResult extends PlanListResultBase {
  readonly scope: 'git-operation-list';
  readonly records: readonly PublicGitOperationRecord[];
}

/** git.operations.get → {operation}（完整意图 + 实际事实 + 回执投影）。 */
export interface GitOperationDetailResult {
  readonly operation: PublicGitOperationRecord;
}

/** 列表父级选择：同项目 Feature 或 Run 之一（必须且只能一个）。 */
export type GitOperationListParent =
  | { readonly kind: 'feature'; readonly featureId: string }
  | { readonly kind: 'run'; readonly runId: string };

/**
 * 列表父级校验（应用层在未知键拒绝之后调用）：featureId 与 runId 必须且只能
 * 提供一个（同时提供/均缺失均为 invalid_input）；身份形态在任何 SQL 之前校验。
 */
export function validateGitOperationListSelector(
  input: Readonly<Record<string, unknown>>,
  operation: string,
): GitOperationListParent {
  const context: ValidationContext = { operation, entity: { type: 'git_operation' } };
  const hasFeature = input.featureId !== undefined;
  const hasRun = input.runId !== undefined;
  if (hasFeature === hasRun) {
    throw validationError(
      context,
      hasFeature ? 'runId' : 'featureId',
      'featureId 与 runId 必须且只能提供一个（列表父级二选一）',
    );
  }
  if (hasFeature) {
    return {
      kind: 'feature',
      featureId: validateStableId(
        input.featureId,
        { operation, entity: { type: 'feature' } },
        'featureId',
      ),
    };
  }
  return {
    kind: 'run',
    runId: validateStableId(input.runId, { operation, entity: { type: 'run' } }, 'runId'),
  };
}

/**
 * Git 操作查询只读窄端口（§7 查询纪律）：授权与可见性判定在应用层完成后
 * 才调用。detail 读取跨项目/不存在统一 undefined（存在性折叠由应用层完成）；
 * 列表可见范围谓词随查询下推 SQL（visibility 非法形状为可信装配编程错误
 * TypeError），稳定 id 升序键集分页（afterId 排他下界，null = 从头）。
 * 全部读取在一致读事务内执行（与其他只读窄端口同一纪律）。
 */
export interface GitOperationQueryReadStore {
  readGitOperationRecord(projectId: unknown, operationId: unknown): GitOperationRecord | undefined;
  listGitOperationRecordsByProject?(
    visibility: unknown,
    projectId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<GitOperationRecord>;
  listGitOperationRecordsByFeature(
    visibility: unknown,
    projectId: unknown,
    featureId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<GitOperationRecord>;
  listGitOperationRecordsByRun(
    visibility: unknown,
    projectId: unknown,
    runId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<GitOperationRecord>;
}
