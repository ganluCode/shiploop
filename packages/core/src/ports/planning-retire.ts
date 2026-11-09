import { rejectUnknownKeys, requirePlainObject, validateStableId, validatePositiveInteger } from './validation.js';
import type { ValidationContext } from './validation.js';

export const PLANNING_RETIRE_OPERATION = 'planning.retire' as const;

export interface ValidatedPlanningRetirePayload {
  readonly featureId: string;
  readonly contextId: string;
  readonly candidateId: string;
  readonly runId: string;
  readonly workspaceRevision: number | null;
}

const context: ValidationContext = { operation: PLANNING_RETIRE_OPERATION };

export function validatePlanningRetirePayload(value: unknown): ValidatedPlanningRetirePayload {
  const raw = requirePlainObject(value, context, 'payload');
  rejectUnknownKeys(raw, ['featureId', 'contextId', 'candidateId', 'runId', 'workspaceRevision'], context, 'payload');
  return {
    featureId: validateStableId(raw.featureId, context, 'payload.featureId'),
    contextId: validateStableId(raw.contextId, context, 'payload.contextId'),
    candidateId: validateStableId(raw.candidateId, context, 'payload.candidateId'),
    runId: validateStableId(raw.runId, context, 'payload.runId'),
    workspaceRevision: raw.workspaceRevision === null ? null : validatePositiveInteger(raw.workspaceRevision, context, 'payload.workspaceRevision'),
  };
}

export interface PlanningRetireInput extends ValidatedPlanningRetirePayload {
  readonly projectId: string;
  readonly featureId: string;
  readonly expectedFeatureRevision: number;
}

export interface PlanningRetireResult {
  readonly contextId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly status: 'cancelled';
  readonly resourcesReleased: boolean;
}
