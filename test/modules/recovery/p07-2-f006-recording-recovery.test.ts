import { expect, it } from 'vitest';
import { inspectWorkRecordingRecovery } from '../../../packages/core/src/application/work-recording-recovery.ts';
import { RECORDING_ARTIFACT, RECORDING_MANIFEST, RECORDING_MESSAGE } from '../../helpers/p04-5/recording-fixture.ts';

const identity = {
  projectId: 'project-1', sessionId: 'session-1', runId: 'run-1', attemptId: 'attempt-1', invocationId: 'invocation-1', executionVersion: 1,
};
const artifact = {
  id: RECORDING_ARTIFACT.artifactId, projectId: identity.projectId, kind: 'message', mediaType: 'application/json', status: 'ready' as const,
  expectedHash: RECORDING_ARTIFACT.contentHash, contentHash: RECORDING_ARTIFACT.contentHash, sizeBytes: RECORDING_ARTIFACT.sizeBytes,
  locator: RECORDING_ARTIFACT.locator, version: 1, failureReason: null, revision: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1,
};

const verifier = {
  async verifyArtifact() { return { kind: 'verified_ready' as const }; },
  async readVerifiedContent() { return { content: Buffer.from('{"event":"complete"}') }; },
};

it('[case:verified-prefix-is-metadata-only] verifies the durable prefix without granting Runtime continuation', async () => {
  const result = await inspectWorkRecordingRecovery({ identity, sessionStatus: 'stopped', sessionWatermark: 1, sessionGaps: [],
    messages: [RECORDING_MESSAGE], manifests: [{ ...RECORDING_MANIFEST, manifestRef: RECORDING_ARTIFACT, watermark: 1, finalSequence: 1, sequenceReconciliation: 'match',
      coverage: 'complete', missingReasons: [], unknownEventCount: 0, finalized: true }], artifacts: [artifact] }, verifier);
  expect(result).toMatchObject({ status: 'verified_prefix', continuation: 'metadata_only', watermark: 1, verifiedThrough: 1,
    messageCount: 1, manifestCount: 1, artifactsChecked: 1, gaps: [] });
});

it('[case:identity-drift-is-unrecoverable] refuses a foreign invocation and keeps the old recording fenced', async () => {
  const result = await inspectWorkRecordingRecovery({ identity, sessionStatus: 'stopped', sessionWatermark: 1, sessionGaps: [],
    messages: [{ ...RECORDING_MESSAGE, invocationId: 'late-invocation' }], manifests: [RECORDING_MANIFEST], artifacts: [artifact] }, verifier);
  expect(result.status).toBe('unrecoverable');
  expect(result.continuation).toBe('none');
  expect(result.gaps).toEqual(expect.arrayContaining(['recording_message_identity_mismatch', 'recording_resume_unsupported']));
});

it('[case:native-does-not-fill-live-gap] preserves an unknown live tail even when a native manifest exists', async () => {
  const result = await inspectWorkRecordingRecovery({ identity, sessionStatus: 'stopped', sessionWatermark: 2, sessionGaps: [],
    messages: [RECORDING_MESSAGE], manifests: [{ ...RECORDING_MANIFEST, source: 'mixed', nativeRef: { schemaVersion: 1, storageKind: 'pi', formatVersion: '1' },
      missingReasons: ['sequence_gap'], watermark: 1, finalSequence: null }], artifacts: [artifact] }, verifier);
  expect(result).toMatchObject({ status: 'unrecoverable', continuation: 'none' });
  expect(result.gaps).toEqual(expect.arrayContaining(['recording_watermark_unverified', 'recording_native_cannot_fill_live_gap']));
});
