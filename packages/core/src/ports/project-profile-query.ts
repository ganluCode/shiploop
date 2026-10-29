/** Versioned public query protocol for project profiles. Bodies and paths stay out of this view. */
import type { CapabilityModule, DetectionEvidence, ProjectProfile } from './project-profile.js';
import type { PersistedProjectProfile } from './project-profile-store.js';

export interface ProfileModuleSelection {
  readonly id: string;
  readonly version: string;
  readonly reason: string;
}

export interface ProfileModuleMatchResult {
  readonly status: 'ready' | 'not_ready';
  readonly profileVersion: number | null;
  readonly modules: readonly ProfileModuleSelection[];
  readonly missing: readonly string[];
  readonly reason?: 'profile_not_confirmed' | 'required_module_missing' | 'required_module_not_applicable' | 'module_dependency_missing' | 'task_scope_required' | 'module_scope_unmatched';
}

export const PROJECT_PROFILE_QUERY_SCHEMA_VERSION = 1 as const;

export interface PublicProfileEvidence {
  readonly id: string;
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly source: string;
  readonly summary: string;
  readonly status: DetectionEvidence['status'];
  readonly confirmed: boolean;
}

export interface PublicProfileModule {
  readonly id: string;
  readonly version: string;
  readonly status: CapabilityModule['status'];
  readonly scope: readonly string[];
  readonly appliesTo: readonly string[];
  readonly dependencies: readonly string[];
  readonly digest: string;
}

export interface PublicProfileRecord {
  readonly projectId: string;
  readonly version: number;
  readonly revision?: string;
  readonly status: ProjectProfile['status'];
  readonly confirmed: boolean;
  readonly confirmedBy: string | null;
  readonly modules: ProjectProfile['modules'];
  readonly evidence: readonly PublicProfileEvidence[];
  readonly profileDigest: string;
  readonly storeRevision: number;
}

export interface ProjectProfileQueryResult {
  readonly schemaVersion: typeof PROJECT_PROFILE_QUERY_SCHEMA_VERSION;
  readonly projectId: string;
  readonly candidate: PublicProfileRecord | null;
  readonly confirmed: PublicProfileRecord | null;
  readonly modules: readonly PublicProfileModule[];
}

export interface ProjectProfileMatchQueryResult {
  readonly schemaVersion: typeof PROJECT_PROFILE_QUERY_SCHEMA_VERSION;
  readonly projectId: string;
  readonly match: ProfileModuleMatchResult;
}

export function toPublicProfileRecord(row: PersistedProjectProfile): PublicProfileRecord {
  return {
    projectId: row.projectId,
    version: row.profile.version,
    ...(row.profile.revision === undefined ? {} : { revision: row.profile.revision }),
    status: row.profile.status,
    confirmed: row.profile.status === 'confirmed',
    confirmedBy: row.profile.confirmedBy,
    modules: row.profile.modules,
    evidence: row.detectionEvidence.map((evidence) => ({
      id: evidence.id,
      detectorId: evidence.detectorId,
      detectorVersion: evidence.detectorVersion,
      source: evidence.source,
      summary: evidence.summary,
      status: evidence.status,
      confirmed: evidence.confirmed,
    })),
    profileDigest: row.profileDigest,
    storeRevision: row.revision,
  };
}

export function createProjectProfileQueryResult(input: {
  readonly projectId: string;
  readonly candidate: PersistedProjectProfile | null;
  readonly confirmed: PersistedProjectProfile | null;
  readonly modules: readonly { readonly module: CapabilityModule; readonly digest: string }[];
}): ProjectProfileQueryResult {
  return Object.freeze({
    schemaVersion: PROJECT_PROFILE_QUERY_SCHEMA_VERSION,
    projectId: input.projectId,
    candidate: input.candidate === null ? null : toPublicProfileRecord(input.candidate),
    confirmed: input.confirmed === null ? null : toPublicProfileRecord(input.confirmed),
    modules: input.modules.map(({ module, digest }) => ({
      id: module.id,
      version: module.version,
      status: module.status,
      scope: module.scope,
      appliesTo: module.appliesTo,
      dependencies: module.dependencies,
      digest,
    })),
  });
}
