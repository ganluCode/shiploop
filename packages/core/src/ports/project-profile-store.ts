import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';
import { requirePlainObject, rejectUnknownKeys } from './validation.js';
import type {
  CapabilityModule,
  DetectionEvidence,
  ProjectProfile,
} from './project-profile.js';

export interface PersistedCapabilityModule {
  readonly moduleId: string;
  readonly projectId: string;
  readonly module: CapabilityModule;
  readonly digest: string;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

export interface PersistedProjectProfile {
  readonly profileId: string;
  readonly projectId: string;
  readonly profile: ProjectProfile;
  readonly detectionEvidence: readonly DetectionEvidence[];
  readonly profileDigest: string;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

/** Core-internal write primitive. expectedRevision is the latest profile.version;
 * immutable row revision remains 1. Authorization belongs to ProjectProfileService.
 */
export interface ProjectProfileUpdateInput {
  readonly expectedRevision: unknown;
  readonly profile: unknown;
  readonly evidence?: readonly unknown[];
  readonly action: 'confirmed' | 'modified' | 'rejected';
  readonly actorId: unknown;
}

export interface ProjectProfileStore {
  readonly createCapabilityModule: (input: unknown) => PersistedCapabilityModule;
  readonly createCapabilityModules: (inputs: readonly unknown[]) => readonly PersistedCapabilityModule[];
  readonly getCapabilityModule: (projectId: unknown, moduleId: unknown, version?: unknown) => PersistedCapabilityModule;
  readonly listCapabilityModules: (projectId: unknown) => readonly PersistedCapabilityModule[];
  readonly createProjectProfile: (input: unknown) => PersistedProjectProfile;
  readonly updateProjectProfile: (projectId: unknown, input: ProjectProfileUpdateInput) => PersistedProjectProfile;
  readonly getProjectProfile: (projectId: unknown, version?: unknown) => PersistedProjectProfile;
  readonly listProjectProfiles: (projectId: unknown) => readonly PersistedProjectProfile[];
}

export const PROJECT_PROFILE_AUDIT_TYPES = ['project_profile.confirmed', 'project_profile.modified', 'project_profile.rejected'] as const;

/** Durable and public audit payload uses only bounded counts and identity digests, never text or content refs. */
export function validateProfileAuditPayload(raw: unknown): Readonly<Record<string, unknown>> {
  const context = { operation: 'project.profile.audit' };
  const payload = requirePlainObject(raw, context, 'payload');
  rejectUnknownKeys(payload, ['action', 'version', 'previousVersion', 'actorDigest', 'profileDigest', 'moduleCount', 'evidenceCount'], context, 'payload');
  if (!['confirmed', 'modified', 'rejected'].includes(payload.action as string)
    || !Number.isSafeInteger(payload.version) || (payload.version as number) < 2
    || !Number.isSafeInteger(payload.previousVersion) || payload.previousVersion !== (payload.version as number) - 1
    || !Number.isSafeInteger(payload.moduleCount) || (payload.moduleCount as number) < 0 || (payload.moduleCount as number) > 64
    || !Number.isSafeInteger(payload.evidenceCount) || (payload.evidenceCount as number) < 0 || (payload.evidenceCount as number) > 256
    || typeof payload.actorDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.actorDigest)
    || typeof payload.profileDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.profileDigest)) {
    throw new StorageError('validation', context.operation, '画像审计结构无效');
  }
  return { ...payload };
}

/** Stable descriptor digest used by callers when no external Artifact digest is available. */
export function computeCapabilityModuleDigest(module: CapabilityModule): string {
  return createHash('sha256').update(JSON.stringify(module), 'utf8').digest('hex');
}
