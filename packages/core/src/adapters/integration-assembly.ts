import type {
  IntegrationBatchApprovalReader,
  IntegrationPredecessorEvidenceReader,
} from '../application/integration-plan-generation.js';
import type {
  IntegrationPlanDispatchWriter,
  IntegrationPlanScheduleCandidateReader,
} from '../application/integration-plan-scheduler.js';
import { validationError } from '../ports/validation.js';

/** Trusted factory output only. Shape validation does not establish authorization or repository identity. */
export interface IntegrationPlanFacts {
  readonly batches: IntegrationBatchApprovalReader;
  readonly predecessors: IntegrationPredecessorEvidenceReader;
  readonly scheduler?: {
    readonly candidates: IntegrationPlanScheduleCandidateReader;
    readonly dispatch: IntegrationPlanDispatchWriter;
  };
}

function method(value: unknown, key: string): boolean {
  return value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>)[key] === 'function';
}

/** Fail during construction, before a partial plan/scheduler facade can escape the Core root. */
export function validateIntegrationPlanFacts(value: unknown): asserts value is IntegrationPlanFacts {
  const facts = value as Partial<IntegrationPlanFacts> | null | undefined;
  const context = { operation: 'CoreApplication.open' };
  if (!facts || typeof facts !== 'object' || !method(facts.batches, 'readApprovedBatch')
    || !method(facts.predecessors, 'readEvidence')) {
    throw validationError(context, 'integrationPlanFactory', 'integration_fact_adapters_required');
  }
  if (facts.scheduler !== undefined && (!method(facts.scheduler?.candidates, 'list')
    || !method(facts.scheduler?.dispatch, 'reserve'))) {
    throw validationError(context, 'integrationPlanFactory', 'integration_scheduler_adapters_required');
  }
}
