import { StorageError } from './errors.js';
import { isPlainObject, rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from './validation.js';
import type { FeatureDependencyInput, FeatureDependencyRecord } from './feature-dag.js';
import type { PhaseRecord } from './plan-store.js';

export const FEATURE_DAG_UPDATE_OPERATION = 'feature.dag.update' as const;

export interface FeatureDagUpdatePayload {
  readonly phaseId: string;
  readonly edges: readonly FeatureDependencyInput[];
}

export interface FeatureDagUpdateInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly expectedRevision: number;
  readonly edges: readonly FeatureDependencyInput[];
}

export interface FeatureDagUpdateResult {
  readonly phase: PhaseRecord;
  readonly edges: readonly FeatureDependencyRecord[];
}

function context() {
  return { operation: FEATURE_DAG_UPDATE_OPERATION, entity: { type: 'phase' as const } };
}

export function validateFeatureDagUpdatePayload(value: unknown): FeatureDagUpdatePayload {
  const ctx = context();
  const object = requirePlainObject(value, ctx, 'payload');
  rejectUnknownKeys(object, ['phaseId', 'edges'], ctx, 'payload');
  const phaseId = validateStableId(object.phaseId, ctx, 'payload.phaseId');
  if (!Array.isArray(object.edges)) {
    throw validationError(ctx, 'payload.edges', '必须是数组', object.edges);
  }
  // Edge shape and the graph-level rules are rechecked by the SQLite adapter against
  // the authoritative feature rows. The command boundary still rejects non-objects.
  const edges = object.edges.map((edge, index) => {
    const item = requirePlainObject(edge, ctx, `payload.edges[${index}]`);
    rejectUnknownKeys(item, ['id', 'projectId', 'phaseId', 'featureId', 'dependsOnId', 'codeBaselineRef'], ctx, `payload.edges[${index}]`);
    const featureId = validateStableId(item.featureId, ctx, `payload.edges[${index}].featureId`);
    const dependsOnId = validateStableId(item.dependsOnId, ctx, `payload.edges[${index}].dependsOnId`);
    const id = item.id === undefined || item.id === null ? null : validateStableId(item.id, ctx, `payload.edges[${index}].id`);
    const projectId = item.projectId === undefined ? undefined : validateStableId(item.projectId, ctx, `payload.edges[${index}].projectId`);
    const edgePhaseId = item.phaseId === undefined ? undefined : validateStableId(item.phaseId, ctx, `payload.edges[${index}].phaseId`);
    const codeBaselineRef = item.codeBaselineRef === undefined || item.codeBaselineRef === null
      ? null
      : typeof item.codeBaselineRef === 'string' && item.codeBaselineRef.length > 0 && item.codeBaselineRef.length <= 512
        ? item.codeBaselineRef
        : (() => { throw validationError(ctx, `payload.edges[${index}].codeBaselineRef`, '必须是长度不超过 512 的非空字符串或 null', item.codeBaselineRef); })();
    return { id: id ?? undefined, projectId, phaseId: edgePhaseId, featureId, dependsOnId, codeBaselineRef };
  });
  return { phaseId, edges };
}

export function validateFeatureDagUpdateInput(value: unknown): FeatureDagUpdateInput {
  const ctx = context();
  const object = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(object, ['projectId', 'phaseId', 'expectedRevision', 'edges'], ctx, 'input');
  const projectId = validateStableId(object.projectId, ctx, 'input.projectId');
  const phaseId = validateStableId(object.phaseId, ctx, 'input.phaseId');
  if (!Number.isSafeInteger(object.expectedRevision) || (object.expectedRevision as number) < 1) {
    throw validationError(ctx, 'input.expectedRevision', '必须是正整数', object.expectedRevision);
  }
  const payload = validateFeatureDagUpdatePayload({ phaseId, edges: object.edges });
  return { projectId, phaseId, expectedRevision: object.expectedRevision as number, edges: payload.edges };
}

export function featureDagUpdateGraphError(reason: string, details: Readonly<Record<string, unknown>> = {}): StorageError {
  return new StorageError('validation', FEATURE_DAG_UPDATE_OPERATION, 'Feature DAG 更新被拒绝', {
    details: { reason, ...details },
  });
}

export function edgeKey(edge: Pick<FeatureDependencyRecord, 'featureId' | 'dependsOnId'>): string {
  return `${edge.featureId}\u0000${edge.dependsOnId}`;
}

export function isFeatureDagUpdatePayload(value: unknown): value is FeatureDagUpdatePayload {
  return isPlainObject(value) && typeof value.phaseId === 'string' && Array.isArray(value.edges);
}

