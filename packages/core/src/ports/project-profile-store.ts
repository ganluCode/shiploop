import { createHash } from 'node:crypto';
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

export interface ProjectProfileStore {
  readonly createCapabilityModule: (input: unknown) => PersistedCapabilityModule;
  readonly createCapabilityModules: (inputs: readonly unknown[]) => readonly PersistedCapabilityModule[];
  readonly getCapabilityModule: (projectId: unknown, moduleId: unknown, version?: unknown) => PersistedCapabilityModule;
  readonly listCapabilityModules: (projectId: unknown) => readonly PersistedCapabilityModule[];
  readonly createProjectProfile: (input: unknown) => PersistedProjectProfile;
  readonly getProjectProfile: (projectId: unknown, version?: unknown) => PersistedProjectProfile;
  readonly listProjectProfiles: (projectId: unknown) => readonly PersistedProjectProfile[];
}

/** Stable descriptor digest used by callers when no external Artifact digest is available. */
export function computeCapabilityModuleDigest(module: CapabilityModule): string {
  return createHash('sha256').update(JSON.stringify(module), 'utf8').digest('hex');
}
