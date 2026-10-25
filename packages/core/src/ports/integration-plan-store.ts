/**
 * P05-6 / F-002 集成计划持久化端口。
 *
 * 集成计划输入和前置成果是冻结的业务事实；SQLite 适配器只负责在既有
 * BEGIN IMMEDIATE 内验证归属、插入/读取和 CAS。Git、网络、模型及验证执行
 * 均不属于本端口。
 */
import type {
  IntegrationPlan,
  IntegrationPlanInput,
  IntegrationPredecessorInput,
  IntegrationResult,
} from './integration-plan.js';

export interface PersistedIntegrationPlan extends IntegrationPlan {
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  /** NULL 表示仍可被事务内冻结；冻结后为应用填入的 UTC 毫秒。 */
  readonly frozenAtUtcMs: number | null;
}

export interface IntegrationPlanCreateInput extends IntegrationPlanInput {
  readonly revision?: number;
}

export interface IntegrationPlanFreezeInput {
  readonly projectId: string;
  readonly integrationId: string;
  readonly expectedRevision: number;
}

export interface IntegrationPlanResultUpdateInput {
  readonly projectId: string;
  readonly integrationId: string;
  readonly expectedRevision: number;
  readonly integrationResult: IntegrationResult | null;
}

export interface IntegrationPlanAccess {
  readonly createIntegrationPlanInTransaction: (input: unknown) => PersistedIntegrationPlan;
  readonly freezeIntegrationPlanInTransaction: (input: unknown) => PersistedIntegrationPlan;
  readonly updateIntegrationPlanResultInTransaction: (input: unknown) => PersistedIntegrationPlan;
  readonly getIntegrationPlanInTransaction: (projectId: string, integrationId: string) => PersistedIntegrationPlan;
  readonly readIntegrationPlan: (projectId: unknown, integrationId: unknown) => PersistedIntegrationPlan | undefined;
}

export type { IntegrationPlan, IntegrationPlanInput, IntegrationPredecessorInput };
