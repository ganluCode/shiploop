import { StorageError } from './errors.js';
import { validatePlanDescription, validatePlanTitle } from './feature-plan.js';
import {
  normalizeLabels, rejectUnknownKeys, requirePlainObject, validateExpectedRevision,
  validateStableId, validationError,
} from './validation.js';

export const PHASE_MUTATION_OPERATIONS = [
  'phase.metadata.update', 'phase.close', 'phase.reopen', 'phase.archive',
] as const;
export type PhaseMutationOperation = (typeof PHASE_MUTATION_OPERATIONS)[number];
export interface PhaseMutationPayload {
  readonly phaseId: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
}

/** Partial metadata edits preserve omitted fields. Lifecycle requests carry only phaseId. */
export function validatePhaseMutationPayload(
  operation: PhaseMutationOperation, input: unknown,
): PhaseMutationPayload {
  const context = { operation, entity: { type: 'phase' as const } };
  const object = requirePlainObject(input, context, 'payload');
  rejectUnknownKeys(object, operation === 'phase.metadata.update'
    ? ['phaseId', 'title', 'description', 'labels'] : ['phaseId'], context, 'payload');
  const phaseId = validateStableId(object.phaseId, context, 'payload.phaseId');
  if (operation !== 'phase.metadata.update') return { phaseId };
  if (!['title', 'description', 'labels'].some(key => Object.hasOwn(object, key))) {
    throw validationError(context, 'payload', '至少提供一个元数据字段');
  }
  return {
    phaseId,
    ...(Object.hasOwn(object, 'title') ? { title: validatePlanTitle(object.title, context, 'payload.title') } : {}),
    ...(Object.hasOwn(object, 'description') ? { description: validatePlanDescription(object.description, context, 'payload.description') } : {}),
    ...(Object.hasOwn(object, 'labels') ? { labels: normalizeLabels(object.labels, context, 'payload.labels') } : {}),
  };
}

export function validatePhaseMutationInput(input: unknown) {
  const operation = 'PlanStore.updatePhase';
  const context = { operation };
  const object = requirePlainObject(input, context, 'input');
  rejectUnknownKeys(object, ['projectId', 'expectedRevision', 'operation', 'payload'], context, 'input');
  if (!(PHASE_MUTATION_OPERATIONS as readonly unknown[]).includes(object.operation)) {
    throw new StorageError('validation', operation, '未知 Phase 命令');
  }
  const mutation = object.operation as PhaseMutationOperation;
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    expectedRevision: validateExpectedRevision(object.expectedRevision, context),
    operation: mutation,
    payload: validatePhaseMutationPayload(mutation, object.payload),
  };
}

/** Event payloads describe a user action, never delivery approval or success. */
export const PHASE_MUTATION_EVENTS = {
  'phase.metadata.update': { type: 'phase.metadata.updated', key: 'metadataUpdated' },
  'phase.close': { type: 'phase.closed', key: 'closed' },
  'phase.reopen': { type: 'phase.reopened', key: 'reopened' },
  'phase.archive': { type: 'phase.archived', key: 'archived' },
} as const;
