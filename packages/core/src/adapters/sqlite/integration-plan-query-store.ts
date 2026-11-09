import { StorageError } from '../../ports/errors.js';
import type { IntegrationPlanAccess } from '../../ports/integration-plan-store.js';
import { computeIntegrationIdentity, computeIntegrationInputDigest, INTEGRATION_PLAN_STATUSES } from '../../ports/integration-plan.js';
import type {
  IntegrationPlanQueryReadStore,
  IntegrationPlanQueryView,
} from '../../ports/integration-plan-query.js';
import type { IntegrationPlanQueryPredecessor } from '../../ports/integration-plan-query.js';

/**
 * F-005 查询适配器：复用集成计划的短一致读事务和 fail-closed 行校验。
 * 这里不读取工作区、branch HEAD 或 Git；结果只由已持久化的冻结事实构成。
 * F-004（P07 DAG）增加同 Phase 列表投影，供阶段级证据核对与 DAG 只读关联复用。
 */
export function createSqliteIntegrationPlanQueryStore(
  plans: Pick<IntegrationPlanAccess, 'readIntegrationPlan' | 'listIntegrationPlansByPhase'>,
): IntegrationPlanQueryReadStore {
  if (plans === null || typeof plans !== 'object' || typeof plans.readIntegrationPlan !== 'function'
    || typeof plans.listIntegrationPlansByPhase !== 'function') {
    throw new TypeError('createSqliteIntegrationPlanQueryStore: readIntegrationPlan/listIntegrationPlansByPhase 依赖缺失');
  }
  function toQueryView(plan: NonNullable<ReturnType<IntegrationPlanAccess['readIntegrationPlan']>>): IntegrationPlanQueryView {
    if (!(INTEGRATION_PLAN_STATUSES as readonly string[]).includes(plan.status) ||
        !Number.isSafeInteger(plan.revision) || plan.revision < 1 ||
        !Number.isSafeInteger(plan.createdAtUtcMs) || plan.createdAtUtcMs < 1 ||
        !Number.isSafeInteger(plan.updatedAtUtcMs) || plan.updatedAtUtcMs < 1 ||
        (plan.frozenAtUtcMs !== null && (!Number.isSafeInteger(plan.frozenAtUtcMs) || plan.frozenAtUtcMs < 1))) {
      throw new StorageError('corrupt', 'IntegrationPlanQuery.read', '集成计划持久身份或时间字段损坏', {
        entity: { type: 'integration_plan', id: plan.integrationId, projectId: plan.projectId },
      });
    }
    const predecessors: IntegrationPlanQueryPredecessor[] = plan.predecessors.map(predecessor => ({
      featureId: predecessor.featureId,
      dependencyPassed: predecessor.dependencyPassed,
      commitSha: predecessor.delivery?.commitSha ?? null,
      evidenceId: predecessor.delivery?.evidenceId ?? null,
      evidenceDigest: predecessor.delivery?.evidenceDigest ?? null,
      coveredInputIds: [...predecessor.coveredInputIds],
      ancestorVerified: predecessor.ancestorVerified,
    }));
    return {
      plan,
      predecessors,
      integrationResult: plan.integrationResult === null ? null : {
        commitSha: plan.integrationResult.commitSha,
        treeSha: plan.integrationResult.treeSha,
        verificationEvidence: plan.integrationResult.verificationEvidence === null
          ? null
          : { ...plan.integrationResult.verificationEvidence },
        operationStatus: plan.integrationResult.operationStatus ?? null,
      },
    };
  }
  /**
   * 旧版单计划读取保留 F-005 的身份重算检查（未写结果的冻结计划可验证；
   * 写入结果后重算身份必然与创建期固化 ID 漂移，该路径保持既有语义不变）。
   */
  function assertLegacyIdentity(plan: NonNullable<ReturnType<IntegrationPlanAccess['readIntegrationPlan']>>): void {
    if (plan.integrationId !== computeIntegrationIdentity(plan) || plan.inputDigest !== computeIntegrationInputDigest(plan)) {
      throw new StorageError('corrupt', 'IntegrationPlanQuery.read', '集成计划持久身份或时间字段损坏', {
        entity: { type: 'integration_plan', id: plan.integrationId, projectId: plan.projectId },
      });
    }
  }
  return {
    readIntegrationPlanView(projectId: unknown, integrationId: unknown): IntegrationPlanQueryView | undefined {
      const plan = plans.readIntegrationPlan(projectId, integrationId);
      if (plan === undefined) return undefined;
      assertLegacyIdentity(plan);
      return toQueryView(plan);
    },
    listIntegrationPlanViewsByPhase(projectId: unknown, phaseId: unknown): readonly IntegrationPlanQueryView[] {
      return plans.listIntegrationPlansByPhase(projectId, phaseId)
        .map(plan => toQueryView(plan))
        .sort((left, right) => left.plan.integrationId < right.plan.integrationId ? -1
          : left.plan.integrationId > right.plan.integrationId ? 1 : 0);
    },
  };
}
