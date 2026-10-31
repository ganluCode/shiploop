import { expect, it } from 'vitest';
import { inspectWorkRecordingRecovery } from '../../../packages/core/src/application/work-recording-recovery.ts';
import { RECORDING_ARTIFACT, RECORDING_MANIFEST, RECORDING_MESSAGE } from '../../helpers/p04-5/recording-fixture.ts';

const identity = { projectId: 'project-1', sessionId: 'session-1', runId: 'run-1', attemptId: 'attempt-1',
  invocationId: 'invocation-1', executionVersion: 1 };
const artifact = { id: RECORDING_ARTIFACT.artifactId, projectId: identity.projectId, kind: 'message',
  mediaType: 'application/json', status: 'ready' as const, expectedHash: RECORDING_ARTIFACT.contentHash,
  contentHash: RECORDING_ARTIFACT.contentHash, sizeBytes: 12, locator: RECORDING_ARTIFACT.locator,
  version: 1, failureReason: null, revision: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1 };
const verifier = { async verifyArtifact() { return { kind: 'verified_ready' as const }; },
  async readVerifiedContent() { return { content: Buffer.from('{"event":"ok"}') }; } };

it('[case:stage-final-manifest-supersedes-progress] accepts unpublished intermediate progress only after a complete published final manifest verifies every message', async () => {
  const result = await inspectWorkRecordingRecovery({ identity, sessionStatus: 'stopped', sessionWatermark: 1, sessionGaps: [],
    messages: [RECORDING_MESSAGE], manifests: [{ ...RECORDING_MANIFEST, missingReasons: ['recording_in_progress'] },
      { ...RECORDING_MANIFEST, id: 'final', version: 2, manifestRef: RECORDING_ARTIFACT,
        watermark: 1, finalSequence: 1, sequenceReconciliation: 'match', coverage: 'complete', missingReasons: [], finalized: true }],
    artifacts: [artifact] }, verifier);
  expect(result).toMatchObject({ status: 'verified_prefix', gaps: [], continuation: 'metadata_only' });
});

it('[case:stage-final-manifest-missing] keeps incomplete final evidence blocked even if a previous version was complete', async () => {
  const result = await inspectWorkRecordingRecovery({ identity, sessionStatus: 'stopped', sessionWatermark: 1, sessionGaps: [],
    messages: [RECORDING_MESSAGE], manifests: [
      { ...RECORDING_MANIFEST, manifestRef: RECORDING_ARTIFACT, watermark: 1, finalSequence: 1,
        coverage: 'complete', missingReasons: [], finalized: true },
      { ...RECORDING_MANIFEST, id: 'tail', version: 2 }], artifacts: [artifact] }, verifier);
  expect(result.status).toBe('unrecoverable');
  expect(result.gaps).toEqual(expect.arrayContaining(['recording_manifest_unpublished', 'recording_manifest_incomplete']));
});

it('[case:stage-historical-gap-kept] a complete final manifest does not erase an earlier unknown event or truncated body', async () => {
  const result = await inspectWorkRecordingRecovery({ identity, sessionStatus: 'stopped', sessionWatermark: 1, sessionGaps: [],
    messages: [RECORDING_MESSAGE], manifests: [RECORDING_MANIFEST,
      { ...RECORDING_MANIFEST, id: 'final', version: 2, manifestRef: RECORDING_ARTIFACT,
        watermark: 1, finalSequence: 1, coverage: 'complete', missingReasons: [], finalized: true }], artifacts: [artifact] }, verifier);
  expect(result.status).toBe('unrecoverable');
  expect(result.gaps).toContain('recording_manifest_incomplete');
});

it('[case:stage-recording-unindexed-refused] refuses an unreferenced session artifact instead of accepting it by path', async () => {
  const result = await inspectWorkRecordingRecovery({ identity, sessionStatus: 'stopped', sessionWatermark: 1, sessionGaps: [],
    messages: [RECORDING_MESSAGE], manifests: [{ ...RECORDING_MANIFEST, manifestRef: RECORDING_ARTIFACT,
      watermark: 1, finalSequence: 1, coverage: 'complete', missingReasons: [], finalized: true }],
    artifacts: [artifact, { ...artifact, id: 'unknown', locator: 'sessions/session-1/event-log/unknown.ndjson' }] }, verifier);
  expect(result.gaps).toContain('recording_unindexed_artifact');
});
