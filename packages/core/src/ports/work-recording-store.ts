/** Public recording indexes only. Body publication and verification happen before this port. */
import type { WorkResourceIdentity } from './work-resources.js';
import type { WorkRecordingIdentity, WorkRecordingManifestRecord, WorkRecordingMessageRecord } from './work-recording.js';

export interface WorkRecordingWriteIdentity extends WorkResourceIdentity, WorkRecordingIdentity {
  readonly purpose: 'work';
}
export interface WorkRecordingCommitInput {
  /** Trusted Core identity, independent of SDK event/request identities. */
  readonly identity: WorkRecordingWriteIdentity;
  readonly expectedSessionRevision: number;
  /** 0 for the first immutable manifest; otherwise the current manifest revision. */
  readonly expectedManifestRevision: number;
  readonly messages: readonly WorkRecordingMessageRecord[];
  /** version and revision must both equal expectedManifestRevision + 1. */
  readonly manifest: WorkRecordingManifestRecord;
}
export interface WorkRecordingCommitResult {
  readonly status: 'applied' | 'duplicate' | 'conflict';
  /** Only newly admitted messages count toward downstream metering. */
  readonly inserted: number;
  readonly manifest: WorkRecordingManifestRecord;
  readonly sessionRevision: number;
}
export const WORK_RECORDING_MAX_BATCH_MESSAGES = 64;
export interface WorkRecordingStore {
  /**
   * One short synchronous transaction: fence, deduplicate, check ready Artifact
   * identities, append indexes/manifest, CAS Session watermark/gaps. No I/O/SDK/UI
   * callbacks. Conflicting identity content commits a bounded diagnostic manifest
   * and returns conflict with inserted=0, preserving all original evidence.
   * An exact retry returns duplicate even after a newer manifest was committed.
   * This does not settle Attempt usage/budgets or reopen terminal Attempts.
   */
  commitRecording(input: WorkRecordingCommitInput): WorkRecordingCommitResult;
  /** Bounded metadata read; authorization belongs to the caller. */
  getLatestManifest(projectId: string, sessionId: string): WorkRecordingManifestRecord | null;
}
