import type { ExecutionInputRef } from './execution-input.js';
import type { RuntimeRecoveryReference, RuntimeRecoveryRequest } from './runtime-recovery.js';

export const RUNTIME_RECOVERY_EVIDENCE_KIND = 'runtime-recovery-evidence';

/** Immutable JSON Artifact bound to the original Attempt/Turn input snapshot. */
export interface RuntimeRecoverySourceEvidence {
  readonly schemaVersion: 1;
  readonly source: RuntimeRecoveryReference;
  readonly inputSnapshot: ExecutionInputRef;
  readonly archive: ExecutionInputRef;
  readonly checkpoint?: ExecutionInputRef;
  readonly codeDigest: string;
  readonly permissionsDigest: string;
}
export interface RuntimeRecoveryCurrentContext {
  readonly inputSnapshot: ExecutionInputRef;
  readonly codeDigest: string;
  readonly permissions: { readonly grants: readonly string[] };
}
export interface RuntimeRecoverySourceState {
  readonly evidence: ExecutionInputRef;
  readonly stopped: 'confirmed' | 'active' | 'unknown';
  readonly stopEvidence?: ExecutionInputRef;
}
/**
 * Internal trusted injection, never deserialized from a client payload.
 * readCurrent binds the exact invocation/executionVersion to approved inputs and
 * current permissions; undefined means unavailable or no longer authorized.
 * readSource resolves stored source ownership and fresh supervisor stop evidence.
 * Neither method grants process-start authority or returns a native path.
 */
export interface RuntimeRecoverySourceReader {
  readCurrent(request: RuntimeRecoveryRequest): unknown;
  readSource(projectId: string, source: RuntimeRecoveryReference): unknown;
}
