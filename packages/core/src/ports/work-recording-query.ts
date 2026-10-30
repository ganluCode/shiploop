/** Work public indexes only; native SDK storage and Chat are never query sources. */
import { createHash } from 'node:crypto';
import type { ExecutionListRequest, ExecutionRecordPage } from './execution-schedule-query.js';
import type { WorkRecordingArtifactRef, WorkRecordingManifestRecord, WorkRecordingMessageRecord } from './work-recording.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from './validation.js';

export const WORK_RECORDING_LIST_OPERATION = 'execution.recording.list';
export const WORK_RECORDING_BODY_OPERATION = 'execution.recording.body.get';
export type WorkRecordingTarget = { readonly kind: 'run' | 'attempt' | 'session'; readonly id: string };
export type WorkRecordingRecordType = 'messages' | 'manifests';
export interface WorkRecordingQueryRow {
  readonly record: WorkRecordingMessageRecord | WorkRecordingManifestRecord;
  readonly manifest: WorkRecordingManifestRecord | null;
  readonly parentSessionId: string | null;
}
export interface WorkRecordingReadStore {
  /** Undefined folds missing, foreign and non-Work targets together. Same consistent read as the page. */
  listWorkRecordingRows(projectId: string, target: WorkRecordingTarget, recordType: WorkRecordingRecordType,
    request: ExecutionListRequest): ExecutionRecordPage<WorkRecordingQueryRow> | undefined;
  /** Exact persisted message/attachment/manifest membership, never locator-prefix authorization. */
  readWorkRecordingArtifactRef(projectId: string, target: WorkRecordingTarget,
    artifactId: string): WorkRecordingArtifactRef | undefined;
}
export type PublicWorkRecordingArtifactRef = Pick<WorkRecordingArtifactRef, 'artifactId' | 'contentHash' | 'sizeBytes'>;
export function publicWorkRecordingRef(ref: WorkRecordingArtifactRef): PublicWorkRecordingArtifactRef {
  return { artifactId: ref.artifactId, contentHash: ref.contentHash, sizeBytes: ref.sizeBytes };
}
export function validateWorkRecordingTarget(input: unknown, operation: string, body = false) {
  const raw = requirePlainObject(input, { operation }, 'input');
  rejectUnknownKeys(raw, body ? ['projectId', 'sessionId', 'attemptId', 'artifactId']
    : ['projectId', 'runId', 'attemptId', 'sessionId', 'recordType', 'limit', 'cursor'], { operation }, 'input');
  const keys = ['runId', 'attemptId', 'sessionId'].filter(key => raw[key] !== undefined);
  if (keys.length !== 1) throw validationError({ operation }, 'input', 'Exactly one recording parent is required');
  const key = keys[0];
  const target: WorkRecordingTarget = { kind: key === 'runId' ? 'run' : key === 'attemptId' ? 'attempt' : 'session',
    id: validateStableId(raw[key], { operation }, key) };
  if (!body && raw.recordType !== 'messages' && raw.recordType !== 'manifests') {
    throw validationError({ operation }, 'recordType', 'Expected messages or manifests');
  }
  return { raw, target };
}

// Public diagnostics are bounded reason codes. Free text and provider IDs can
// contain paths/secrets; opaque tool identities retain equality and parent links.
const PUBLIC_DETAIL_CODES = new Set([
  'sequence_gap', 'recording_in_progress', 'terminal_watermark_unknown', 'recording_manifest_missing',
  'body_truncated', 'configured_literal_redaction', 'body_hash_mismatch', 'body_size_mismatch',
  'body_limit', 'body_timeout', 'body_stream_error', 'body_publication_failed', 'body_unavailable',
  'total_volume_limit', 'attachment_count_limit', 'invalid_message', 'invalid_message_role',
  'diagnostics_overflow', 'usage_scope_unknown', 'events_tail_timeout', 'result_tail_timeout',
  'foreign_event', 'stop_evidence_unavailable', 'best_effort_partial', 'partial_evidence_flush_failed',
  'public_events', 'public_messages', 'public_tools', 'attachments', 'final_result', 'minimal_diagnostics',
  'hidden_reasoning', 'native_private_storage', 'unified_audit', 'unexposed_sdk_content',
  'recording_detail_redacted', 'queue_limit', 'chunk_limit', 'session_storage_quota',
  'publication_timeout', 'publication_file_error', 'publication_storage_error', 'publication_failed',
  'cancelled', 'artifact_not_ready', 'cleanup_unconfirmed', 'evidence_unrecoverable',
  'evidence_metadata_unpersisted', 'mcp_audit_gap', 'gaps_overflow',
  'recording_mode_required', 'recording_mode_best_effort',
  'stop_observed_confirmed', 'stop_observed_unconfirmed', 'stop_observation_unknown',
  'recording_session_not_stopped', 'recording_recovery_scan_limit',
  'recording_artifact_corrupt', 'recording_artifact_untrusted', 'recording_artifact_missing',
  'recording_artifact_verification_failed', 'recording_artifact_index_missing',
  'recording_artifact_pending', 'recording_artifact_failed', 'recording_artifact_read_limit',
  'recording_artifact_body_invalid', 'recording_message_identity_mismatch', 'recording_sequence_gap',
  'recording_watermark_unverified', 'recording_watermark_artifact_unverified',
  'recording_manifest_identity_mismatch', 'recording_manifest_version_unknown',
  'recording_manifest_unpublished', 'recording_manifest_incomplete', 'recording_manifest_watermark_ahead',
  'recording_manifest_watermark_mismatch', 'recording_native_cannot_fill_live_gap',
  'recording_resume_unsupported', 'manifest_version_gap',
  ...[
    'validation', 'session_mismatch', 'stale_execution_identity', 'event_stream_failed',
    'event_publish_failed', 'event_queue_backpressure', 'event_write_timeout', 'event_storage_exhausted',
    'event_file_write_failed', 'manifest_publish_failed', 'manifest_write_timeout',
    'manifest_storage_exhausted', 'manifest_file_write_failed', 'watermark_progress_failed',
    'recording_scope_incomplete', 'total_event_limit_exceeded', 'total_bytes_limit_exceeded',
    'recording_deadline_exceeded', 'aborted',
  ].map(reason => `recording_failed:${reason}`),
]);
const PUBLIC_DETAIL_PREFIXES = new Set([
  'missing_sequences', 'event_body_too_large', 'event_identity_conflict', 'late_event_beyond_window',
  'late_event', 'sequence_identity_conflict', 'invalid_event', 'result_invalid', 'final_sequence_mismatch',
  'unknown_events', 'unknown_event', 'foreign_events', 'recording_failed', 'recovery',
]);
export function isPublicWorkRecordingDetailCode(value: unknown): value is string {
  return typeof value === 'string' && (PUBLIC_DETAIL_CODES.has(value) || PUBLIC_DETAIL_PREFIXES.has(value));
}
const codes = (values: readonly string[]) => values.map(value => {
  if (PUBLIC_DETAIL_CODES.has(value)) return value;
  const prefix = value.split(':', 1)[0];
  return PUBLIC_DETAIL_PREFIXES.has(prefix) ? prefix : 'recording_detail_redacted';
});
function toolRef(sessionId: string, value: string | null): string | null {
  return value === null ? null : createHash('sha256').update(JSON.stringify([sessionId, value])).digest('hex');
}
export function publicWorkRecordingRow(row: WorkRecordingQueryRow) {
  const r = row.record;
  const common = { id: r.id, projectId: r.projectId, runId: r.runId, attemptId: r.attemptId,
    sessionId: r.sessionId, parentSessionId: row.parentSessionId, source: r.source };
  if ('sequence' in r) {
    return { ...common, sequence: r.sequence, kind: r.kind, role: r.role,
      contentRef: publicWorkRecordingRef(r.contentRef),
      toolCallId: toolRef(r.sessionId, r.toolCallId), parentToolCallId: toolRef(r.sessionId, r.parentToolCallId),
      attachments: r.attachments.map(a => ({ ...publicWorkRecordingRef(a), truncated: a.truncated, redacted: a.redacted })),
      occurredAtUtcMs: r.occurredAtUtcMs, recordedAtUtcMs: r.recordedAtUtcMs, truncated: r.truncated, redacted: r.redacted,
      watermark: row.manifest?.watermark ?? null, coverage: row.manifest?.coverage ?? 'partial',
      missingReasons: row.manifest ? codes(row.manifest.missingReasons) : ['recording_manifest_missing'] };
  }
  return { ...common, version: r.version, manifestRef: r.manifestRef === null ? null : publicWorkRecordingRef(r.manifestRef),
    watermark: r.watermark, finalSequence: r.finalSequence, sequenceReconciliation: r.sequenceReconciliation,
    coverage: r.coverage, missingReasons: codes(r.missingReasons), diagnostics: codes(r.diagnostics),
    scope: { covers: codes(r.scope.covers), excludes: codes(r.scope.excludes) },
    truncation: { applied: r.truncation.applied, reasons: codes(r.truncation.reasons) },
    redaction: { applied: r.redaction.applied, reasons: codes(r.redaction.reasons) },
    unknownEventCount: r.unknownEventCount, finalized: r.finalized };
}
export interface WorkRecordingPage {
  readonly schemaVersion: number;
  readonly scope: 'work-recording';
  readonly recordType: WorkRecordingRecordType;
  readonly records: readonly ReturnType<typeof publicWorkRecordingRow>[];
  readonly nextCursor: string | null;
  readonly limit: number;
}
export interface WorkRecordingBody {
  readonly schemaVersion: number;
  readonly scope: 'work-recording-body';
  readonly artifact: PublicWorkRecordingArtifactRef;
  readonly content: Uint8Array;
}
