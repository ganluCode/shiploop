import type { WorkRecordingMessageRecord, WorkRecordingManifestRecord } from '../../../packages/core/src/ports/work-recording.ts';

export const RECORDING_ARTIFACT = {
  artifactId: 'artifact-1', contentHash: 'ab'.repeat(32), sizeBytes: 12, locator: 'artifacts/artifact-1',
};
export const RECORDING_MESSAGE: WorkRecordingMessageRecord = {
  id: 'message-1', createdAtUtcMs: 100, revision: 1, updatedAtUtcMs: 100,
  projectId: 'project-1', sessionId: 'session-1', runId: 'run-1', attemptId: 'attempt-1',
  invocationId: 'invocation-1', executionVersion: 1, sequence: 1, eventId: 'event-1',
  messageKey: 'message-key-1', kind: 'message', role: 'assistant', contentRef: RECORDING_ARTIFACT,
  providerMessageId: null, toolCallId: null, parentToolCallId: null, source: 'live',
  sourceRefs: [], attachments: [], occurredAtUtcMs: 100, recordedAtUtcMs: 101,
  truncated: false, redacted: false,
};
export const RECORDING_MANIFEST: WorkRecordingManifestRecord = {
  id: 'manifest-1', createdAtUtcMs: 100, revision: 1, updatedAtUtcMs: 100,
  projectId: 'project-1', sessionId: 'session-1', runId: 'run-1', attemptId: 'attempt-1',
  invocationId: 'invocation-1', executionVersion: 1, version: 1, manifestRef: null,
  watermark: null, finalSequence: null, sequenceReconciliation: 'not_available',
  coverage: 'partial', source: 'live',
  scope: { covers: ['public_events'], excludes: ['hidden_reasoning', 'native_private_storage', 'unified_audit'] },
  missingReasons: ['unknown_events'], diagnostics: [],
  truncation: { applied: false, reasons: [] }, redaction: { applied: false, reasons: [] },
  sdkVersion: null, formatVersion: 'work-recording/v1', nativeRef: null,
  unknownEventCount: null, finalized: false,
};
