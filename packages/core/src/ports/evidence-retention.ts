import type { RetentionPolicyV2 } from './settings-schema.js';

export const RETENTION_CLEANUP_OPERATION = 'retention.cleanup.execute' as const;
export const RETENTION_CLEANUP_SCHEMA_VERSION = 1 as const;
export const RETENTION_CLEANUP_OBJECT_KINDS = [
  'artifact', 'document-version', 'execution-input', 'verification-output', 'delivery-input',
  'session', 'recorder', 'recovery-source', 'checkpoint', 'operation', 'backup',
] as const;
export type RetentionCleanupObjectKind = (typeof RETENTION_CLEANUP_OBJECT_KINDS)[number];
export type RetentionCleanupObjectStatus = 'candidate' | 'retained' | 'deleted' | 'isolated' | 'skipped';

export interface RetentionReference {
  readonly sourceKind: RetentionCleanupObjectKind | 'database' | 'unknown';
  readonly sourceId: string;
  readonly objectKind: RetentionCleanupObjectKind;
  readonly objectId: string;
  readonly reason: string;
}

export interface RetentionObjectIdentity {
  readonly kind: RetentionCleanupObjectKind;
  readonly id: string;
  readonly projectId?: string;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly bytes: number;
  readonly fileRelativePath?: string;
  readonly fileIdentity?: { readonly dev: number; readonly ino: number; readonly sizeBytes: number; readonly mtimeMs: number };
  readonly digest?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RetentionCleanupSnapshot {
  readonly schemaVersion: typeof RETENTION_CLEANUP_SCHEMA_VERSION;
  readonly generatedAtUtcMs: number;
  readonly policy: RetentionPolicyV2;
  readonly revision: string;
  readonly objects: readonly RetentionObjectIdentity[];
  readonly references: readonly RetentionReference[];
  readonly unknownReasons: readonly string[];
  readonly backups: readonly RetentionObjectIdentity[];
}

export interface RetentionCleanupCandidate {
  readonly object: RetentionObjectIdentity;
  readonly reasons: readonly string[];
  readonly expectedSnapshotRevision: string;
  readonly referenceCount: number;
  readonly status: 'candidate' | 'retained';
}

export interface RetentionCleanupEvaluation {
  readonly schemaVersion: typeof RETENTION_CLEANUP_SCHEMA_VERSION;
  readonly operation: typeof RETENTION_CLEANUP_OPERATION;
  readonly evaluatedAtUtcMs: number;
  readonly snapshotRevision: string;
  readonly candidates: readonly RetentionCleanupCandidate[];
  readonly retained: readonly RetentionCleanupCandidate[];
  readonly unknownReasons: readonly string[];
  readonly backupCandidates: readonly RetentionCleanupCandidate[];
}

export interface RetentionCleanupRunLimits {
  readonly maxItems?: number;
  readonly maxBytes?: number;
  readonly maxDurationMs?: number;
  readonly maxRetries?: number;
}

export interface RetentionCleanupRunResult {
  readonly operationId: string;
  readonly status: 'completed' | 'partial' | 'blocked' | 'failed' | 'unknown';
  readonly evaluated: RetentionCleanupEvaluation;
  readonly deleted: readonly RetentionCleanupCandidate[];
  readonly retained: readonly RetentionCleanupCandidate[];
  readonly skipped: readonly { readonly candidate: RetentionCleanupCandidate; readonly reason: string }[];
  readonly itemsDeleted: number;
  readonly bytesDeleted: number;
  readonly reasons: readonly string[];
}

export interface RetentionCleanupStore {
  readSnapshot(policy: RetentionPolicyV2, nowUtcMs: number): Promise<RetentionCleanupSnapshot>;
  beginOperation(input: { readonly operationId: string; readonly policy: RetentionPolicyV2; readonly snapshot: RetentionCleanupSnapshot; readonly nowUtcMs: number }): Promise<void>;
  readOperation(operationId: string): Promise<{ readonly status: string; readonly snapshotRevision: string; readonly nextIndex: number; readonly itemsDeleted: number; readonly bytesDeleted: number }>;
  recheckCandidate(candidate: RetentionCleanupCandidate, nowUtcMs: number): Promise<{ readonly allowed: boolean; readonly reason?: string; readonly candidate: RetentionCleanupCandidate }>;
  deleteCandidate(candidate: RetentionCleanupCandidate): Promise<{ readonly deleted: boolean; readonly bytesDeleted: number; readonly reason?: string }>;
  finishOperation(input: { readonly operationId: string; readonly status: RetentionCleanupRunResult['status']; readonly nextIndex: number; readonly itemsDeleted: number; readonly bytesDeleted: number; readonly reason?: string; readonly nowUtcMs: number }): Promise<void>;
}

export interface RetentionCleanupService {
  evaluate(input: { readonly policy: RetentionPolicyV2; readonly nowUtcMs?: number }): Promise<RetentionCleanupEvaluation>;
  execute(input: { readonly operationId: string; readonly policy: RetentionPolicyV2; readonly nowUtcMs?: number; readonly limits?: RetentionCleanupRunLimits }): Promise<RetentionCleanupRunResult>;
}
