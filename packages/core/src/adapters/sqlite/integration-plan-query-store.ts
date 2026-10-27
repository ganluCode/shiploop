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
 */
export function createSqliteIntegrationPlanQueryStore(
  plans: Pick<IntegrationPlanAccess, 'readIntegrationPlan'>,
): IntegrationPlanQueryReadStore {
  if (plans === null || typeof plans !== 'object' || typeof plans.readIntegrationPlan !== 'function') {
    throw new TypeError('createSqliteIntegrationPlanQueryStore: readIntegrationPlan 依赖缺失');
  }
  return {
    readIntegrationPlanView(projectId: unknown, integrationId: unknown): IntegrationPlanQueryView | undefined {
      const plan = plans.readIntegrationPlan(projectId, integrationId);
      if (plan === undefined) return undefined;
      if (plan.integrationId !== computeIntegrationIdentity(plan) || plan.inputDigest !== computeIntegrationInputDigest(plan) ||
          !(INTEGRATION_PLAN_STATUSES as readonly string[]).includes(plan.status) ||
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
    },
  };
}
