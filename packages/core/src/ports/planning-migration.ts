import { createHash } from 'node:crypto';
import { stableStringify } from './feature-plan.js';
import { rejectUnknownKeys, requirePlainObject, validateSha256Digest, validateStableId, validatePositiveInteger, validationError } from './validation.js';
import { validateWorkspaceCommit } from './workspace.js';
import type { ValidationContext } from './validation.js';

export const PLANNING_MIGRATION_PREVIEW_OPERATION = 'planning.migration.preview' as const;
export const PLANNING_MIGRATION_CONFIRM_OPERATION = 'planning.migration.confirm' as const;
export const PLANNING_MIGRATION_ROLES = ['planning', 'coding'] as const;
export type PlanningMigrationRole = typeof PLANNING_MIGRATION_ROLES[number];

export interface PlanningMigrationPreviewInput {
  readonly projectId: string;
  readonly featureId: string;
}

export interface PlanningMigrationPreview {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly featureId: string;
  readonly featureRevision: number;
  readonly context: {
    readonly contextId: string;
    readonly candidateId: string;
    readonly runId: string;
    readonly status: string;
  };
  readonly workspace: {
    readonly workspaceId: string;
    readonly path: string;
    readonly branch: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly revision: number;
    readonly status: string;
  };
  readonly facts: {
    readonly dirty: boolean;
    readonly unfinishedOperations: readonly string[];
    readonly leases: readonly { readonly id: string; readonly state: string; readonly ownerId: string; readonly executionVersion: number }[];
    readonly processStopProof: { readonly present: boolean; readonly source: string };
  };
  readonly blockers: readonly string[];
  readonly previewDigest: string;
  readonly observedAtUtcMs: number;
}

export interface PlanningMigrationConfirmPayload {
  readonly featureId: string;
  readonly contextId: string;
  readonly candidateId: string;
  readonly runId: string;
  readonly targetRole: PlanningMigrationRole;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly headCommit: string;
  readonly previewDigest: string;
}

export interface PlanningMigrationResult {
  readonly schemaVersion: 1;
  readonly migrated: boolean;
  readonly targetRole: PlanningMigrationRole;
  readonly sourceRole: 'legacy_planner';
  readonly featureId: string;
  readonly contextId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly identities: {
    readonly featureId: string;
    readonly contextId: string;
    readonly candidateId: string;
    readonly runId: string;
    readonly workspaceId: string;
  };
  readonly planningRetired: boolean;
  readonly featurePassed: false;
  readonly taskPassed: false;
  readonly budgetReset: false;
  readonly runtimeStarted: false;
}

const previewContext: ValidationContext = { operation: PLANNING_MIGRATION_PREVIEW_OPERATION };
const confirmContext: ValidationContext = { operation: PLANNING_MIGRATION_CONFIRM_OPERATION };

export function validatePlanningMigrationPreviewInput(value: unknown): PlanningMigrationPreviewInput {
  const raw = requirePlainObject(value, previewContext, 'input');
  rejectUnknownKeys(raw, ['projectId', 'featureId'], previewContext, 'input');
  return { projectId: validateStableId(raw.projectId, previewContext, 'projectId'), featureId: validateStableId(raw.featureId, previewContext, 'featureId') };
}

export function validatePlanningMigrationConfirmPayload(value: unknown): PlanningMigrationConfirmPayload {
  const raw = requirePlainObject(value, confirmContext, 'payload');
  rejectUnknownKeys(raw, ['featureId', 'contextId', 'candidateId', 'runId', 'targetRole', 'workspaceId', 'workspaceRevision', 'headCommit', 'previewDigest'], confirmContext, 'payload');
  if (!PLANNING_MIGRATION_ROLES.includes(raw.targetRole as PlanningMigrationRole)) throw validationError(confirmContext, 'payload.targetRole', 'Unsupported target role');
  return {
    featureId: validateStableId(raw.featureId, confirmContext, 'payload.featureId'),
    contextId: validateStableId(raw.contextId, confirmContext, 'payload.contextId'),
    candidateId: validateStableId(raw.candidateId, confirmContext, 'payload.candidateId'),
    runId: validateStableId(raw.runId, confirmContext, 'payload.runId'),
    targetRole: raw.targetRole as PlanningMigrationRole,
    workspaceId: validateStableId(raw.workspaceId, confirmContext, 'payload.workspaceId'),
    workspaceRevision: validatePositiveInteger(raw.workspaceRevision, confirmContext, 'payload.workspaceRevision'),
    headCommit: validateWorkspaceCommit(raw.headCommit),
    previewDigest: validateSha256Digest(raw.previewDigest, confirmContext, 'payload.previewDigest'),
  };
}

export function computePlanningMigrationPreviewDigest(value: Omit<PlanningMigrationPreview, 'previewDigest'>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function validatePlanningMigrationPreview(value: unknown): PlanningMigrationPreview {
  const raw = requirePlainObject(value, previewContext, 'preview');
  if (raw.schemaVersion !== 1) throw validationError(previewContext, 'preview.schemaVersion', 'Unsupported schema version');
  const preview = raw as unknown as PlanningMigrationPreview;
  if (typeof preview.previewDigest !== 'string' || preview.previewDigest.length !== 64) throw validationError(previewContext, 'preview.previewDigest', 'Invalid digest');
  const { previewDigest, ...withoutDigest } = preview;
  if (computePlanningMigrationPreviewDigest(withoutDigest) !== previewDigest) throw validationError(previewContext, 'preview.previewDigest', 'Preview digest mismatch');
  return preview;
}
