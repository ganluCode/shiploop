import {
  rejectUnknownKeys, requirePlainObject, validateExpectedRevision, validatePositiveInteger, validateStableId,
} from './validation.js';

export interface FeaturePhaseMovePayload {
  readonly featureId: string;
  readonly sourcePhaseId: string;
  readonly targetPhaseId: string;
  readonly sourcePhaseRevision: number;
  readonly targetPhaseRevision: number;
}

export function validateFeaturePhaseMovePayload(input: unknown): FeaturePhaseMovePayload {
  const context = { operation: 'feature.phase.move' };
  const object = requirePlainObject(input, context, 'payload');
  rejectUnknownKeys(object, ['featureId', 'sourcePhaseId', 'targetPhaseId',
    'sourcePhaseRevision', 'targetPhaseRevision'], context, 'payload');
  return {
    featureId: validateStableId(object.featureId, context, 'payload.featureId'),
    sourcePhaseId: validateStableId(object.sourcePhaseId, context, 'payload.sourcePhaseId'),
    targetPhaseId: validateStableId(object.targetPhaseId, context, 'payload.targetPhaseId'),
    sourcePhaseRevision: validatePositiveInteger(object.sourcePhaseRevision, context, 'payload.sourcePhaseRevision'),
    targetPhaseRevision: validatePositiveInteger(object.targetPhaseRevision, context, 'payload.targetPhaseRevision'),
  };
}

export function validateFeaturePhaseMoveInput(input: unknown) {
  const context = { operation: 'PlanStore.moveFeaturePhase' };
  const object = requirePlainObject(input, context, 'input');
  rejectUnknownKeys(object, ['projectId', 'expectedRevision', 'payload'], context, 'input');
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    expectedRevision: validateExpectedRevision(object.expectedRevision, context),
    payload: validateFeaturePhaseMovePayload(object.payload),
  };
}
