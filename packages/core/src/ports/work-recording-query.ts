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
]);
const PUBLIC_DETAIL_PREFIXES = new Set([
  'missing_sequences', 'event_body_too_large', 'event_identity_conflict', 'late_event_beyond_window',
  'late_event', 'sequence_identity_conflict', 'invalid_event', 'result_invalid', 'final_sequence_mismatch',
  'unknown_events', 'unknown_event', 'foreign_events', 'recording_failed', 'recovery',
]);
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
