import { expect, it } from 'vitest';
import { publicWorkRecordingRow } from '../../../packages/core/src/ports/work-recording-query.ts';
import { validateAppQueryResponse } from '../../../packages/host/src/index.ts';
import { buildWorkRecordingListView, formatWorkRecordingListView } from '../../../packages/cli/src/app/work-recording.ts';
import { RECORDING_MANIFEST } from '../../helpers/p04-5/recording-fixture.ts';

const reasons = [
  'recording_failed:total_bytes_limit_exceeded', 'recording_failed:total_event_limit_exceeded',
  'recording_failed:event_queue_backpressure', 'recording_failed:event_storage_exhausted',
  'recording_failed:event_file_write_failed', 'recording_failed:recording_deadline_exceeded',
  'publication_file_error', 'publication_timeout', 'queue_limit', 'session_storage_quota',
  'evidence_unrecoverable', 'evidence_metadata_unpersisted', 'cleanup_unconfirmed',
  'recording_manifest_missing', 'recording_resume_unsupported', 'recording_artifact_corrupt',
];
function page(missingReasons: string[]) {
  const manifest = { ...RECORDING_MANIFEST, manifestRef: null, coverage: 'failed' as const, missingReasons };
  return { schemaVersion: 5, scope: 'work-recording', recordType: 'manifests', limit: 50, nextCursor: null,
    records: [publicWorkRecordingRow({ record: manifest, manifest, parentSessionId: null })] };
}

it('[case:bounded-diagnostics] Core、HostClient 和 CLI 保留有界故障原因，缺失 Manifest 不伪装为空成功', () => {
  const wire = page(reasons);
  expect(wire.records[0].missingReasons).toEqual(reasons);
  const result = validateAppQueryResponse('execution.recording.list', wire);
  const text = formatWorkRecordingListView(buildWorkRecordingListView(result, { runId: 'run-1' }));
  for (const reason of reasons) expect(text).toContain(reason);
  expect(text).toContain('manifestRef=none');
  expect(text).toContain('coverage=failed');
});

it('[case:diagnostic-secrets] 未知或附带异常正文的原因不透传，客户端拒绝原始诊断', () => {
  const raw = ['recording_failed:event_storage_exhausted:/private/key', 'publication_file_error:SQL secret', '/private/token'];
  const wire = page(raw);
  const serialized = JSON.stringify(wire);
  for (const secret of ['/private', 'SQL', 'secret', 'token']) expect(serialized).not.toContain(secret);
  for (const reason of raw) {
    const unsafe = { ...wire, records: [{ ...wire.records[0], diagnostics: [reason] }] };
    expect(() => validateAppQueryResponse('execution.recording.list', unsafe)).toThrow();
  }
});
