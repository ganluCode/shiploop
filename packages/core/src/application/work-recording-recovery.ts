import type { ArtifactRecord } from '../ports/artifact-store.js';
import type { WorkRecordingManifestRecord, WorkRecordingMessageRecord } from '../ports/work-recording.js';
import { validateWorkEvidenceManifest, WORK_EVIDENCE_MANIFEST_KIND } from '../ports/work-evidence-recorder.js';
import { assertWorkRecordingIdentity } from '../ports/work-recording.js';

type RecoveryArtifactVerifier = {
  verifyArtifact(projectId: string, artifactId: string): Promise<{ readonly kind: string }>;
  readVerifiedContent?: (projectId: string, artifactId: string) => Promise<{ readonly content: Uint8Array }>;
};

/** Recovery reads are deliberately smaller than normal recording limits. */
export const WORK_RECORDING_RECOVERY_MAX_MESSAGES = 256;
export const WORK_RECORDING_RECOVERY_MAX_MANIFESTS = 64;
export const WORK_RECORDING_RECOVERY_MAX_ARTIFACTS = 256;
export const WORK_RECORDING_RECOVERY_MAX_READ_BYTES = 4 * 1024 * 1024;

export interface WorkRecordingRecoveryIdentity {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
}

export interface WorkRecordingRecoveryInput {
  readonly identity: WorkRecordingRecoveryIdentity;
  readonly sessionStatus: string;
  readonly sessionWatermark: number | null;
  readonly sessionGaps: readonly string[];
  readonly settlementArtifactId?: string | null;
  readonly messages: readonly WorkRecordingMessageRecord[];
  readonly manifests: readonly WorkRecordingManifestRecord[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly indexLimited?: boolean;
}

export interface WorkRecordingRecoveryResult {
  readonly status: 'verified_prefix' | 'unrecoverable';
  /** A verified prefix may only be closed as metadata; it never grants resume. */
  readonly continuation: 'metadata_only' | 'none';
  readonly watermark: number | null;
  readonly verifiedThrough: number | null;
  readonly messageCount: number;
  readonly manifestCount: number;
  readonly artifactsChecked: number;
  readonly gaps: readonly string[];
  readonly diagnostics: readonly string[];
}

const MAX_GAPS = 32;
const MAX_DIAGNOSTICS = 32;

function add(values: string[], value: string, limit: number): void {
  if (!values.includes(value) && values.length < limit) values.push(value);
}

function reportGap(report: WorkRecordingRecoveryResult, value: string): WorkRecordingRecoveryResult {
  const gaps = [...report.gaps];
  add(gaps, value, MAX_GAPS);
  return { ...report, status: 'unrecoverable', continuation: 'none', gaps };
}

function addDiagnostic(report: WorkRecordingRecoveryResult, value: string): WorkRecordingRecoveryResult {
  const diagnostics = [...report.diagnostics];
  add(diagnostics, value, MAX_DIAGNOSTICS);
  return { ...report, diagnostics };
}

function artifactReportGap(kind: string): string {
  if (kind === 'corrupt') return 'recording_artifact_corrupt';
  if (kind === 'untrusted_file' || kind === 'untrusted_index') return 'recording_artifact_untrusted';
  if (kind === 'not_found') return 'recording_artifact_missing';
  return 'recording_artifact_verification_failed';
}

/**
 * Verify the durable public recording index after the old writer was fenced.
 *
 * This function is intentionally a verifier, not a continuation protocol. It
 * never reads a native archive, creates a Runtime, or synthesizes missing live
 * events. A complete durable prefix can be closed by metadata only; every
 * uncertain tail remains unrecoverable.
 */
export async function inspectWorkRecordingRecovery(
  input: WorkRecordingRecoveryInput,
  verifier: RecoveryArtifactVerifier,
): Promise<WorkRecordingRecoveryResult> {
  const base: WorkRecordingRecoveryResult = {
    status: 'verified_prefix', continuation: 'metadata_only',
    watermark: input.sessionWatermark, verifiedThrough: null,
    messageCount: input.messages.length, manifestCount: input.manifests.length,
    artifactsChecked: 0, gaps: [...new Set(input.sessionGaps)].slice(0, MAX_GAPS), diagnostics: [],
  };
  let result = base;
  if (input.sessionStatus === 'started' || input.sessionStatus === 'ended') {
    result = reportGap(result, 'recording_session_not_stopped');
  }
  if (input.indexLimited === true || input.messages.length > WORK_RECORDING_RECOVERY_MAX_MESSAGES
    || input.manifests.length > WORK_RECORDING_RECOVERY_MAX_MANIFESTS
    || input.artifacts.length > WORK_RECORDING_RECOVERY_MAX_ARTIFACTS) {
    result = reportGap(result, 'recording_recovery_scan_limit');
  }

  const artifacts = new Map(input.artifacts.map(artifact => [artifact.id, artifact]));
  const checked = new Set<string>();
  const verified = new Set<string>();
  const bodies = new Map<string, unknown>();
  const indexed = new Set<string>();
  const verify = async (artifactId: string): Promise<void> => {
    if (checked.has(artifactId)) return;
    checked.add(artifactId);
    const record = artifacts.get(artifactId);
    if (record === undefined) {
      result = reportGap(result, 'recording_artifact_index_missing');
      return;
    }
    if (record.status !== 'ready') {
      result = reportGap(result, record.status === 'pending' ? 'recording_artifact_pending' : 'recording_artifact_failed');
      return;
    }
    try {
      const report = await verifier.verifyArtifact(input.identity.projectId, artifactId);
      if (report.kind !== 'verified_ready') {
        result = reportGap(result, artifactReportGap(report.kind));
        return;
      }
      if (verifier.readVerifiedContent !== undefined) {
        if (record.sizeBytes === null || record.sizeBytes > WORK_RECORDING_RECOVERY_MAX_READ_BYTES) {
          result = reportGap(result, 'recording_artifact_read_limit');
          return;
        }
        try {
          const content = await verifier.readVerifiedContent(input.identity.projectId, artifactId);
          // Recording bodies and manifests are JSON documents. Parsing the
          // bounded read proves the durable block is complete, rather than
          // trusting a path or a final DB row alone.
          const text = Buffer.from(content.content).toString('utf8');
          if (record.mediaType === 'application/x-ndjson') {
            for (const line of text.split('\n').filter(Boolean)) JSON.parse(line);
          } else bodies.set(artifactId, JSON.parse(text));
        } catch {
          result = reportGap(result, 'recording_artifact_body_invalid');
          return;
        }
      }
      verified.add(artifactId);
    } catch {
      result = reportGap(result, 'recording_artifact_verification_failed');
    }
  };

  if (input.settlementArtifactId) {
    indexed.add(input.settlementArtifactId);
    await verify(input.settlementArtifactId);
  }
  const messages = [...input.messages].sort((left, right) => left.sequence - right.sequence);
  let expected = 1;
  for (const message of messages) {
    try {
      assertWorkRecordingIdentity(message, input.identity);
    } catch {
      result = reportGap(result, 'recording_message_identity_mismatch');
    }
    if (message.sequence !== expected) {
      result = reportGap(result, 'recording_sequence_gap');
      expected = Math.max(expected, message.sequence + 1);
    } else expected += 1;
    indexed.add(message.contentRef.artifactId);
    await verify(message.contentRef.artifactId);
    for (const attachment of message.attachments) {
      indexed.add(attachment.artifactId);
      await verify(attachment.artifactId);
    }
  }
  const contiguous = messages.length > 0 && messages[0]!.sequence === 1
    ? messages.reduce((last, message) => message.sequence === last + 1 ? message.sequence : last, 0)
    : messages.length === 0 ? 0 : null;
  const candidateWatermark = input.sessionWatermark;
  if (candidateWatermark !== null && (contiguous === null || contiguous < candidateWatermark)) {
    result = reportGap(result, 'recording_watermark_unverified');
  }
  const verifiedThrough = messages.filter(message => verified.has(message.contentRef.artifactId))
    .reduce((last, message) => message.sequence === last + 1 ? message.sequence : last, 0);
  result = { ...result, verifiedThrough, watermark: candidateWatermark, artifactsChecked: checked.size };
  if (candidateWatermark !== null && verifiedThrough < candidateWatermark) {
    result = reportGap(result, 'recording_watermark_artifact_unverified');
  }

  const manifests = [...input.manifests].sort((left, right) => left.version - right.version);
  let latest: WorkRecordingManifestRecord | undefined;
  let expectedVersion = 1;
  for (const manifest of manifests) {
    latest = manifest;
    try {
      assertWorkRecordingIdentity(manifest, input.identity);
    } catch {
      result = reportGap(result, 'recording_manifest_identity_mismatch');
    }
    if (manifest.version !== expectedVersion) result = addDiagnostic(result, 'manifest_version_gap');
    expectedVersion = Math.max(expectedVersion, manifest.version + 1);
    if (manifest.formatVersion !== 'work-recording/v1') {
      result = reportGap(result, 'recording_manifest_version_unknown');
    }
    const supersededProgress = manifest !== manifests.at(-1) && !manifest.finalized && manifest.source === 'live'
      && !manifest.truncation.applied && (manifest.unknownEventCount === null || manifest.unknownEventCount === 0)
      && manifest.missingReasons.every(reason => reason === 'recording_in_progress' || reason === 'terminal_watermark_unknown');
    if (manifest.manifestRef !== null) {
      indexed.add(manifest.manifestRef.artifactId);
      await verify(manifest.manifestRef.artifactId);
      const record = artifacts.get(manifest.manifestRef.artifactId);
      if (record?.kind === WORK_EVIDENCE_MANIFEST_KIND && verified.has(record.id)) {
        try {
          const evidence = validateWorkEvidenceManifest(bodies.get(record.id));
          if ((['projectId', 'sessionId', 'runId', 'attemptId', 'invocationId', 'executionVersion'] as const)
            .some(key => evidence.identity[key] !== input.identity[key])) {
            result = reportGap(result, 'recording_manifest_identity_mismatch');
            continue;
          }
          for (const chunk of evidence.chunks) {
            indexed.add(chunk.artifactId);
            const artifact = artifacts.get(chunk.artifactId);
            if (!artifact || artifact.contentHash !== chunk.contentHash || artifact.sizeBytes !== chunk.sizeBytes
              || artifact.locator !== chunk.locator) {
              result = reportGap(result, 'recording_chunk_identity_mismatch');
            }
            await verify(chunk.artifactId);
          }
        } catch { result = reportGap(result, 'recording_artifact_body_invalid'); }
      }
    } else if (!supersededProgress) {
      result = reportGap(result, 'recording_manifest_unpublished');
    }
    // Intermediate projections describe progress. Only a published, finalized
    // complete tail may supersede them; historical finalized failures stay gaps.
    if (!supersededProgress && manifest.coverage !== 'complete') {
      result = reportGap(result, 'recording_manifest_incomplete');
    }
    if ((manifest.watermark ?? 0) > (candidateWatermark ?? 0)) {
      result = reportGap(result, 'recording_manifest_watermark_ahead');
    }
    if (manifest.source === 'native' || manifest.source === 'mixed') {
      if (manifest.missingReasons.some(reason => reason.includes('sequence') || reason.includes('event') || reason.includes('live'))) {
        result = reportGap(result, 'recording_native_cannot_fill_live_gap');
      }
    }
  }
  for (const artifact of input.artifacts) {
    if (artifact.locator?.startsWith(`sessions/${input.identity.sessionId}/`) && !indexed.has(artifact.id)) {
      result = reportGap(result, 'recording_unindexed_artifact');
    }
  }
  if (latest !== undefined && !latest.finalized) result = reportGap(result, 'recording_manifest_incomplete');
  if (latest === undefined && (candidateWatermark !== null || messages.length > 0
    || (input.sessionStatus === 'stopped' && input.sessionGaps.length > 0))) {
    result = reportGap(result, 'recording_manifest_missing');
  }
  if (latest !== undefined && latest.coverage === 'complete' && latest.watermark !== null
    && latest.watermark !== latest.finalSequence) {
    result = reportGap(result, 'recording_manifest_watermark_mismatch');
  }
  if (result.gaps.length > 0) {
    result = addDiagnostic(result, 'recording_resume_unsupported');
    result = reportGap(result, 'recording_resume_unsupported');
  }
  return result;
}
