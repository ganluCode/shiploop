import {
  rejectUnknownKeys,
  requirePlainObject,
  validateStableId,
  validationError,
  type ValidationContext,
} from './validation.js';

/** P06-3 F-005 resource mutation command identities. */
export const PROJECT_RESOURCE_COMMAND_OPERATIONS = [
  'project.resource.import',
  'project.resource.enable',
  'project.resource.disable',
  'project.resource.revoke',
] as const;

export type ProjectResourceCommandOperation = (typeof PROJECT_RESOURCE_COMMAND_OPERATIONS)[number];

export interface ProjectResourceImportCommandPayload {
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
}

export interface ProjectResourceTargetCommandPayload {
  readonly resourceId: string;
}

export type ProjectResourceCommandPayload =
  | ProjectResourceImportCommandPayload
  | ProjectResourceTargetCommandPayload;

const SHA256 = /^[a-f0-9]{64}$/;

function digest(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw validationError(context, field, 'Expected a lowercase SHA-256 digest');
  }
  return value;
}

/** Validate the resource command payload without reading storage or the filesystem. */
export function validateProjectResourceCommandPayload(
  operation: ProjectResourceCommandOperation,
  value: unknown,
): ProjectResourceCommandPayload {
  const context: ValidationContext = { operation, entity: { type: 'project_resource' } };
  const object = requirePlainObject(value, context, 'payload');
  if (operation === 'project.resource.import') {
    rejectUnknownKeys(object, ['sourceId', 'sourceDigest', 'candidateId', 'candidateDigest'], context, 'payload');
    return {
      sourceId: validateStableId(object.sourceId, context, 'payload.sourceId'),
      sourceDigest: digest(object.sourceDigest, context, 'payload.sourceDigest'),
      candidateId: validateStableId(object.candidateId, context, 'payload.candidateId'),
      candidateDigest: digest(object.candidateDigest, context, 'payload.candidateDigest'),
    };
  }
  rejectUnknownKeys(object, ['resourceId'], context, 'payload');
  return { resourceId: validateStableId(object.resourceId, context, 'payload.resourceId') };
}
