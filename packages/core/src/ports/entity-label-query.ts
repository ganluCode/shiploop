import type { PlanListResultBase, PlanRecordPage, ValidatedPlanListFilter } from './queries.js';
import { validatePlanListFilter } from './queries.js';
import { validateProjectListFilter } from './state-store.js';

export type LabelEntity = 'phase' | 'feature' | 'task' | 'run';
export interface EntityLabelFilter {
  readonly labels: readonly string[];
  readonly match: 'any' | 'all';
}
export interface EntityLabelSelector {
  readonly entity: LabelEntity;
  readonly projectId: string;
  readonly phaseId?: string;
  readonly featureId?: string;
  readonly batchId?: string;
}
export interface EntityLabelCount {
  readonly label: string;
  readonly count: number;
}
export interface EntityLabelCountsResult {
  readonly entity: LabelEntity;
  readonly labels: readonly EntityLabelCount[];
}
/** Only persisted Run metadata is exposed; execution/configuration snapshots stay private. */
export interface PublicLabelRunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly labels: readonly string[];
  readonly status: string;
  readonly purpose: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface RunListResult extends PlanListResultBase {
  readonly scope: 'run-list';
  readonly records: readonly PublicLabelRunRecord[];
}
export interface EntityLabelQueryReadStore {
  countEntityLabels(visibility: unknown, selector: EntityLabelSelector, filter: EntityLabelFilter): readonly EntityLabelCount[];
  listLabelRunRecords(visibility: unknown, selector: EntityLabelSelector,
    request: EntityLabelFilter & { readonly afterId: string | null; readonly limit: number }): PlanRecordPage<PublicLabelRunRecord>;
}
/** Reuses project label normalization/matching and the opaque plan cursor contract. */
export function validateEntityLabelFilter(
  object: Record<string, unknown>, operation: string,
): ValidatedPlanListFilter & EntityLabelFilter {
  const { labels, match } = validateProjectListFilter({ labels: object.labels, match: object.match }, operation);
  return { ...validatePlanListFilter({ limit: object.limit, cursor: object.cursor }, operation), labels, match };
}
