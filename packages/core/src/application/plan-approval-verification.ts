/**
 * P03-2 / F-003 有效批准核验服务（application 层）：从同一权威状态视图校验
 * 项目归属、当前摘要、检查身份与当前审批状态，为后续执行授权（P03-3/4 创建
 * Run/Attempt）与输入准备提供 fail-closed 的审批依据。
 *
 * 设计依据：p03-plan-approval PRD（版本 0.3）FR-1/验收标准 2（批准绑定
 * planDigest；需求或检查政策改动后不能用旧批准执行；标签变化不导致无关
 * 失效）、core-design/02 §10（批准绑定摘要）、core-design/11 §7（approvals
 * 主体摘要变更使旧批准失效）。
 * 实施契约：docs/p03-2-plan-approval-verification-contract.md。
 *
 * 不变量：
 * - 核验是纯读评估：不改写任何实体/决策行（旧决策证据保留），不创建
 *   Batch/Run/Attempt，不调用 Runtime/Git/检查进程；批准有效仍不等于启动
 *   授权（本项不实现 startRun）；
 * - 评估输入必须来自同一权威状态视图：verifyFeaturePlanApprovalInTransaction
 *   在调用方的同一 BEGIN IMMEDIATE 写事务内读取（供 P03-3/4 在创建
 *   Run/Attempt 的写事务内复用）；查询面（features.approvals 的 validity
 *   块）由单一 DEFERRED 读事务提供同一视图；
 * - 适用检查政策身份 = 当前有效 policies.verification 段的内容摘要
 *  （computeFeatureCheckPolicyDigest）：政策内容是经 settings-schema 校验并
 *   按键级合并（项目非空段整体覆盖全局段）后的值，不依赖可变配置路径、
 *   通用配置 revision 或 labels；
 * - fail-closed：未批准、拒绝、过期（plan_changed/check_policy_changed）与
 *   不一致（approval_state_inconsistent）均 valid=false 且携带明确原因；
 *   缺失 not_found、跨项目 ownership 由事务原语抛出（不泄漏存在性）。
 */
import type { CommandTransaction } from '../ports/atomic-commands.js';
import type { PlanApprovalRecord } from '../ports/plan-store.js';
import {
  computeFeatureCheckPolicyDigest,
  evaluatePlanApprovalValidity,
} from '../ports/plan-approval-verification.js';
import type { PlanApprovalValidity } from '../ports/plan-approval-verification.js';
import type { SettingsPayload } from '../ports/settings-schema.js';
import { mergeEffectiveSettings } from './effective-settings.js';

/** 配置 scope 快照最小面（记录或一致读视图快照均可传入）。 */
export interface SettingsScopeSnapshotLike {
  readonly scopeRevision: number;
  readonly payload: SettingsPayload;
}

/**
 * 从全局与项目当前配置快照计算当前适用检查政策身份摘要（两来源经
 * mergeEffectiveSettings 重新校验合并：项目非空 verification 段整体覆盖
 * 全局段，空段继承全局；双方均未配置 → 显式 null 形态摘要）。配置 revision
 * 只作合并输入身份，不进入摘要内容。
 */
export function resolveCurrentCheckPolicyDigest(
  globalSettings: SettingsScopeSnapshotLike | null,
  projectSettings: SettingsScopeSnapshotLike | null,
): string {
  const effective = mergeEffectiveSettings({
    global:
      globalSettings === null
        ? null
        : { scopeRevision: globalSettings.scopeRevision, payload: globalSettings.payload },
    project:
      projectSettings === null
        ? null
        : { scopeRevision: projectSettings.scopeRevision, payload: projectSettings.payload },
  });
  return computeFeatureCheckPolicyDigest(effective.policies.verification?.value);
}

/**
 * 有效批准核验结果：Feature 当前身份（planDigest + 适用检查政策摘要）、
 * fail-closed 评估与绑定当前身份的决策记录（证据引用；无则 null）。
 */
export interface FeaturePlanApprovalVerification {
  readonly projectId: string;
  readonly featureId: string;
  readonly planDigest: string | null;
  readonly checkPolicyDigest: string;
  readonly validity: PlanApprovalValidity;
  /** 绑定当前身份的决策记录（validity.currentDecisionId 对应行）；无则 null。 */
  readonly currentDecision: PlanApprovalRecord | null;
}

/**
 * 在调用方的同一写事务内核验目标 Feature 的有效批准（P03-3/4 创建
 * Run/Attempt 时的复用入口）：项目把关（缺失/不可见 forbidden）→ 计划快照
 * （缺失 not_found、跨项目 ownership）→ 同一事务内读取全部决策记录与全局/
 * 项目当前配置 → 纯规则评估。任何读写都由 CommandTransaction 原语完成，
 * 本函数不产生事务外 I/O，也不写入任何行。
 */
export function verifyFeaturePlanApprovalInTransaction(
  transaction: CommandTransaction,
  projectId: string,
  featureId: string,
): FeaturePlanApprovalVerification {
  // 项目把关：缺失/不可见统一由 getProject 抛出（不泄漏存在性）。
  transaction.getProject(projectId);
  // 计划快照：缺失 not_found、跨项目 ownership 抛出（零写入）。
  const snapshot = transaction.getFeaturePlan(projectId, featureId);
  const decisions = transaction.listPlanApprovals(projectId, featureId);
  const globalSettings = transaction.getGlobalSettingsOrNull();
  const projectSettings = transaction.getProjectSettingsOrNull(projectId);
  const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
    globalSettings === null
      ? null
      : { scopeRevision: globalSettings.revision, payload: globalSettings.payload },
    projectSettings === null
      ? null
      : { scopeRevision: projectSettings.revision, payload: projectSettings.payload },
  );
  const validity = evaluatePlanApprovalValidity({
    planDigest: snapshot.feature.planDigest,
    planStatus: snapshot.feature.planStatus,
    taskCount: snapshot.tasks.length,
    decisions,
    currentCheckPolicyDigest: checkPolicyDigest,
  });
  const currentDecision =
    decisions.find((decision) => decision.id === validity.currentDecisionId) ?? null;
  return {
    projectId,
    featureId,
    planDigest: snapshot.feature.planDigest,
    checkPolicyDigest,
    validity,
    currentDecision,
  };
}
