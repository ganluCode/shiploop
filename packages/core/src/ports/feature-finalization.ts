import type { FeatureRecord } from './plan-store.js';
import type { ExecutionBatchRecord, RunRecord } from './execution-store.js';

export const FEATURE_FINALIZED_EVENT_TYPE = 'feature.finalized';
export const FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE = 'feature.finalization_blocked';

export type FeatureFinalizationOutcome = 'completed' | 'partial' | 'failed' | 'awaiting_approval';

export interface FeatureFinalizationRecord {
  readonly feature: FeatureRecord;
  readonly run: RunRecord;
  readonly batch: ExecutionBatchRecord;
  readonly deliveryStatus: FeatureRecord['deliveryStatus'];
  readonly outcome: FeatureFinalizationOutcome;
  readonly reason: string;
  readonly operationId: string | null;
}

export interface FinalizeFeatureDeliveryInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly expectedFeatureRevision: number;
  readonly expectedRunRevision: number;
  readonly expectedBatchRevision: number;
  readonly outcome: FeatureFinalizationOutcome;
  readonly reason: string;
  readonly deliveryStatus: FeatureRecord['deliveryStatus'];
  readonly operationId: string | null;
}

export interface FeatureFinalizationTransaction {
  finalizeFeatureDelivery(input: unknown): FeatureFinalizationRecord;
}
