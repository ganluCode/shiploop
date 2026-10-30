/** SessionRecorder's public index projection. Called serially by the bounded event collector. */
import { randomUUID, createHash } from 'node:crypto';
import type { RuntimeEvent, RuntimeExecutionRequest } from '../ports/runtime-execution.js';
import type { WorkRecordingStore, WorkRecordingWriteIdentity } from '../ports/work-recording-store.js';
import { WORK_RECORDING_MAX_BATCH_MESSAGES } from '../ports/work-recording-store.js';
import { validateWorkRecordingManifest, validateWorkRecordingMessage, WORK_RECORDING_REQUIRED_EXCLUSIONS } from '../ports/work-recording.js';
import type { WorkRecordingArtifactRef, WorkRecordingManifestRecord, WorkRecordingMessageRecord } from '../ports/work-recording.js';
import type { WorkEvidenceManifest } from '../ports/work-evidence-recorder.js';
import type { WorkRecordingPublisher } from './work-recording-publish.js';
import type { WorkRecordingStorageBudget } from './work-recording-budget.js';
import type { ArtifactVerifier } from './artifact-verify.js';

export interface WorkRecordingProjectionDeps {
  readonly publisher: WorkRecordingPublisher;
  readonly store: WorkRecordingStore;
  readonly nowUtcMs?: () => number;
}

export function createWorkRecordingProjection(deps: WorkRecordingProjectionDeps, request: RuntimeExecutionRequest,
  verifier: Pick<ArtifactVerifier, 'verifyArtifact'>, storageBudget?: WorkRecordingStorageBudget) {
  if (request.identity.purpose !== 'work') throw new Error('work_identity_required');
  const identity: WorkRecordingWriteIdentity = { purpose: 'work', projectId: request.projectId, sessionId: request.sessionId,
    runId: request.identity.runId, attemptId: request.identity.attemptId, invocationId: request.invocationId,
    executionVersion: request.executionVersion, owner: request.owner.principalId, hostInstanceId: request.owner.hostInstanceId };
  const { purpose: _purpose, owner: _owner, hostInstanceId: _host, ...recordIdentity } = identity;
  const nowUtcMs = deps.nowUtcMs ?? Date.now;
  let revision = 0;
  let watermark: number | null = null;
  let pending: WorkRecordingMessageRecord[] = [];
  let truncation = false;
  let redaction = false;
  const publicationGaps = new Set<string>();

  async function check(ref: WorkRecordingArtifactRef): Promise<void> {
    const report = await verifier.verifyArtifact(identity.projectId, ref.artifactId);
    if (report.kind !== 'verified_ready') throw new Error('recording_body_verification_failed');
  }

  return {
    get watermark() { return watermark; },
    get gaps() { return [...publicationGaps]; },
    async prepare(events: readonly { readonly event: RuntimeEvent; readonly redacted: boolean }[]): Promise<void> {
      if (events.length > WORK_RECORDING_MAX_BATCH_MESSAGES || pending.length !== 0) throw new Error('recording_batch_limit');
      // A batch is admitted only after every body has been published and verified.
      // On failure, ready bodies remain evidence; no partial batch advances its watermark.
      const batch: WorkRecordingMessageRecord[] = [];
      for (const entry of events) {
        const { event } = entry;
        const payload = event.payload;
        const tool = payload.kind === 'tool_started' || payload.kind === 'tool_finished';
        const kind = tool ? payload.kind : payload.kind === 'diagnostic' || payload.kind === 'warning' ? 'error' : 'message';
        const role = tool ? 'tool' : payload.kind === 'message' ? payload.role : kind === 'error' ? 'error' : 'system';
        const content = Buffer.from(JSON.stringify(payload), 'utf8');
        const body = await deps.publisher.publishBody({ projectId: request.projectId, kind: kind === 'message' ? 'message' : kind,
          mediaType: 'application/json', locator: `sessions/${request.sessionId}/messages/${event.sequence}.json`,
          expectedHash: createHash('sha256').update(content).digest('hex'),
          ...(storageBudget === undefined ? {} : { budget: storageBudget }),
          content: (function* () { for (let offset = 0; offset < content.length; offset += 1024) yield content.subarray(offset, offset + 1024); })() });
        for (const gap of body.gapReasons) if (publicationGaps.size < 16) publicationGaps.add(gap);
        if (body.ref === null || body.status !== 'complete') throw new Error('recording_body_publication_failed');
        await check(body.ref);
        truncation ||= body.truncated;
        redaction ||= body.redacted || entry.redacted;
        const timestamp = nowUtcMs();
        batch.push(validateWorkRecordingMessage({ ...recordIdentity, id: randomUUID(), revision: 1,
          createdAtUtcMs: timestamp, updatedAtUtcMs: timestamp, occurredAtUtcMs: Date.parse(event.occurredAtUtc), recordedAtUtcMs: timestamp,
          sequence: event.sequence, eventId: event.eventId, messageKey: event.eventId, kind, role,
          contentRef: body.ref, providerMessageId: payload.kind === 'message' ? payload.messageId : null,
          toolCallId: tool ? payload.toolCallId : null, parentToolCallId: tool ? payload.parentToolCallId ?? null : null,
          source: 'live', sourceRefs: [event.eventId], attachments: [], truncated: body.truncated, redacted: body.redacted || entry.redacted }));
      }
      pending = batch;
    },
    commit(input: { sessionRevision: number; watermark: number | null; gaps: readonly string[];
      manifest?: WorkEvidenceManifest; manifestRef?: WorkRecordingArtifactRef | null }): number {
      const timestamp = nowUtcMs();
      const source = input.manifest;
      const recoverySource = source?.recovery?.source;
      const hasRecoveredSource = recoverySource !== undefined && recoverySource !== null;
      const nativeRef = source?.recovery?.nativeFormat !== null && source?.recovery?.nativeFormat !== undefined
        && source?.recovery?.nativeFormatVersion !== null && source?.recovery?.nativeFormatVersion !== undefined
        ? { schemaVersion: 1 as const, storageKind: source.recovery.nativeFormat, formatVersion: source.recovery.nativeFormatVersion }
        : null;
      const missing = [...new Set([...input.gaps, ...publicationGaps])];
      // Intermediate manifests must never claim a completed audit.
      if (source === undefined) missing.unshift('recording_in_progress');
      if (source?.sequenceReconciliation === 'not_available') missing.unshift('terminal_watermark_unknown');
      const nextWatermark = pending.length > 0 ? pending[pending.length - 1].sequence
        : source?.finalEventSequence === 0 && watermark === null ? 0 : watermark;
      // Every accepted Runtime event has an index, including diagnostics and usage.
      if ((nextWatermark ?? 0) !== (input.watermark ?? 0) || missing.some(gap => /missing_sequences|event_body_too_large/.test(gap))) {
        missing.unshift('sequence_gap');
      }
      if (nextWatermark !== null && nextWatermark > 0 && source?.stats.eventsPersisted !== nextWatermark && source !== undefined) {
        missing.unshift('sequence_gap');
      }
      const partial = source?.coverage !== 'complete' || missing.length > 0 || truncation;
      const finalSequence = source?.finalEventSequence ?? null;
      // A mismatching producer terminal behind already durable content is retained
      // in the evidence manifest, never forced into an invalid index manifest.
      const manifest: WorkRecordingManifestRecord = validateWorkRecordingManifest({ ...recordIdentity,
        id: randomUUID(), createdAtUtcMs: timestamp, updatedAtUtcMs: timestamp, revision: revision + 1, version: revision + 1,
        manifestRef: input.manifestRef ?? null, watermark: nextWatermark,
        finalSequence: finalSequence !== null && finalSequence < (nextWatermark ?? 0) ? null : finalSequence,
        sequenceReconciliation: source?.sequenceReconciliation === 'match' && nextWatermark !== null ? 'match' : 'not_available',
        coverage: source?.coverage === 'failed' ? 'failed' : partial ? 'partial' : 'complete', source: hasRecoveredSource ? 'mixed' : 'live',
        scope: { covers: ['public_events', 'public_messages', 'public_tools', 'final_result', 'minimal_diagnostics'],
          excludes: [...WORK_RECORDING_REQUIRED_EXCLUSIONS, 'unexposed_sdk_content'] },
        missingReasons: [...new Set(missing)].slice(0, 32), diagnostics: source?.diagnostics ?? [],
        truncation: { applied: truncation, reasons: truncation ? ['body_truncated'] : [] },
        redaction: { applied: redaction || (source?.redaction.secretValueCount ?? 0) > 0,
          reasons: redaction || (source?.redaction.secretValueCount ?? 0) > 0 ? ['configured_literal_redaction'] : [] },
        sdkVersion: source?.recovery?.sdkVersion ?? null, formatVersion: 'work-recording/v1', nativeRef,
        unknownEventCount: source?.stats.unknownEvents ?? 0, finalized: source !== undefined });
      const result = deps.store.commitRecording({ identity, expectedSessionRevision: input.sessionRevision,
        expectedManifestRevision: revision, messages: pending, manifest });
      revision = result.manifest.revision;
      watermark = result.manifest.watermark;
      pending = [];
      if (result.status === 'conflict') throw new Error('recording_identity_conflict');
      return result.sessionRevision;
    },
    discardPending() { pending = []; },
  };
}
