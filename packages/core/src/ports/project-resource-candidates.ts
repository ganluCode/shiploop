import { createHash } from 'node:crypto';
import type { ProjectResourceCandidate, ProjectResourceKind, ProjectResourceSummary } from './project-resources.js';
import type { WorkAccessCapability } from './work-access.js';

export const PROJECT_RESOURCE_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const PROJECT_RESOURCE_CANDIDATE_MAX_SOURCES = 32;
export const PROJECT_RESOURCE_CANDIDATE_MAX_BYTES = 1_048_576;
export const PROJECT_RESOURCE_CANDIDATE_REASONS = [
  'invalid_input',
  'invalid_path',
  'source_missing',
  'permission_denied',
  'source_io_failed',
  'limit_exceeded',
  'invalid_manifest',
  'unsupported_schema_version',
  'unsupported_resource_version',
  'unknown_resource',
  'unknown_transport',
  'duplicate_identity',
  'duplicate_name',
  'invalid_digest',
  'digest_mismatch',
  'plaintext_credential',
  'invalid_tool_name',
] as const;
export type ProjectResourceCandidateReason = (typeof PROJECT_RESOURCE_CANDIDATE_REASONS)[number];

export class ProjectResourceCandidateDiscoveryError extends Error {
  readonly reason: ProjectResourceCandidateReason;
  readonly details: Readonly<{ reason: ProjectResourceCandidateReason }>;

  constructor(reason: ProjectResourceCandidateReason) {
    super(`Project resource candidate rejected: ${reason}`);
    this.name = 'ProjectResourceCandidateDiscoveryError';
    this.reason = reason;
    this.details = Object.freeze({ reason });
  }
}

/** The only source a discovery adapter may read. The path is never part of a result. */
export interface ProjectResourceCandidateSource {
  readonly sourceId: string;
  readonly path: string;
  readonly expectedDigest?: string;
}

export interface ProjectResourceCandidateSourceContent {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface ProjectResourceCandidateSourceReader {
  read(source: ProjectResourceCandidateSource): Promise<ProjectResourceCandidateSourceContent>;
}

export interface ProjectResourceCandidateDiscoveryInput {
  readonly projectId: string;
  readonly sources: readonly ProjectResourceCandidateSource[];
}

export interface ProjectResourceCandidatePreviewInput extends ProjectResourceCandidateDiscoveryInput {
  readonly selectedResourceIds?: readonly string[];
  readonly existingResources?: readonly ProjectResourceSummary[];
}

export interface ProjectResourceCandidateMetadata {
  readonly description: string | null;
  readonly promptSummary: string | null;
  readonly toolNames: readonly string[];
}

export type DiscoveredProjectResourceCandidate = ProjectResourceCandidate & {
  readonly availability: 'available' | 'unverified';
  readonly metadata: ProjectResourceCandidateMetadata;
};

export interface ProjectResourceCandidateSourceResult {
  readonly sourceId: string;
  readonly sourceDigest: string | null;
  readonly status: 'accepted' | 'rejected';
  readonly candidateIds: readonly string[];
  readonly error: { readonly reason: ProjectResourceCandidateReason } | null;
}

export interface ProjectResourceCandidateDiscoveryResult {
  readonly schemaVersion: typeof PROJECT_RESOURCE_CANDIDATE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly sources: readonly ProjectResourceCandidateSourceResult[];
  readonly candidates: readonly DiscoveredProjectResourceCandidate[];
  readonly rejected: readonly {
    readonly sourceId: string;
    readonly reason: ProjectResourceCandidateReason;
  }[];
  /** Discovery is read-only and never mutates project configuration. */
  readonly configurationChanged: false;
}

export type ProjectResourceCandidatePreviewStatus = 'pending' | 'selected' | 'conflict' | 'rejected';

export interface ProjectResourceCandidatePreviewEntry {
  readonly sourceId: string;
  readonly candidateId: string | null;
  readonly name: string | null;
  readonly status: ProjectResourceCandidatePreviewStatus;
  readonly reason: ProjectResourceCandidateReason | 'already_selected' | 'already_configured' | null;
}

export interface ProjectResourceCandidatePreview {
  readonly schemaVersion: typeof PROJECT_RESOURCE_CANDIDATE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly entries: readonly ProjectResourceCandidatePreviewEntry[];
  readonly candidates: readonly DiscoveredProjectResourceCandidate[];
  readonly rejected: readonly {
    readonly sourceId: string;
    readonly reason: ProjectResourceCandidateReason;
  }[];
  readonly configurationChanged: false;
}

export interface ProjectResourceManifestResourceInput {
  readonly kind: ProjectResourceKind;
  readonly name: string;
  readonly sourceRevision?: string;
  readonly version: string;
  readonly content?: unknown;
  readonly contentDigest?: string | null;
  readonly transport: 'stdio' | 'streamable_http' | null;
  readonly capabilities: readonly WorkAccessCapability[];
  readonly credentialRef?: string | null;
  readonly required: boolean;
  readonly onUnavailable: 'reject' | 'omit';
  readonly description?: string;
  readonly prompt?: string;
  readonly tools?: readonly { readonly name: string }[];
}

export interface ProjectResourceCandidateManifestInput {
  readonly schemaVersion: number;
  readonly resources: readonly ProjectResourceManifestResourceInput[];
}

/** Hash helper used by source adapters and deterministic tests; no content is logged. */
export function sha256CandidateBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
