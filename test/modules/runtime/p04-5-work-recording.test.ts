import { describe, expect, it } from 'vitest';
import {
  validateSessionMessageRecord, validateRecordingManifestRecord, assertWorkRecordingIdentity,
} from '../../../packages/core/src/ports/work-recording.ts';
import { RECORDING_ARTIFACT as artifact, RECORDING_MESSAGE as message, RECORDING_MANIFEST as manifest } from '../../helpers/p04-5/recording-fixture.ts';

const complete = {
  ...manifest, coverage: 'complete', missingReasons: [], watermark: 1, finalSequence: 1,
  sequenceReconciliation: 'match', unknownEventCount: 0, finalized: true,
};

describe('P04-5 Work recording ports', () => {
  it('accepts public messages, nested tools and attachment references without bodies', () => {
    expect(validateSessionMessageRecord(message)).toEqual(message);
    const tool = { ...message, kind: 'tool_finished', role: 'tool', toolCallId: 'tool-child',
      parentToolCallId: 'tool-parent', providerMessageId: 'native-msg-1', source: 'recovered',
      sourceRefs: ['public-export-1'], attachments: [{ ...artifact, name: 'output.txt',
        mediaType: 'text/plain', truncated: true, redacted: true }] };
    expect(validateSessionMessageRecord(tool)).toEqual(tool);
  });

  it('preserves unknown observations, versions and native archive description', () => {
    expect(validateRecordingManifestRecord(manifest)).toEqual(manifest);
    expect(validateRecordingManifestRecord({ ...manifest, coverage: 'failed', source: 'native',
      sdkVersion: '1.0.4', nativeRef: { schemaVersion: 1, storageKind: 'pi', formatVersion: 'v1' },
      missingReasons: ['write_failed'] })).toMatchObject({ sdkVersion: '1.0.4', unknownEventCount: null, watermark: null });
    expect(validateRecordingManifestRecord(complete)).toEqual(complete);
    expect(validateRecordingManifestRecord({ ...manifest, truncation: { applied: true, reasons: ['body_limit'] },
      redaction: { applied: true, reasons: ['credential'] } })).toMatchObject({ coverage: 'partial' });
  });

  it.each([
    { privateBody: 'should-not-be-indexed' }, { sequence: 0 }, { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 }, { eventId: '' }, { recordedAtUtcMs: 99 },
    { source: 'private_sqlite' }, { contentRef: { ...artifact, body: 'secret' } },
    { contentRef: { ...artifact, sizeBytes: -1 } }, { contentRef: { ...artifact, locator: '../private.db' } },
    { contentRef: { ...artifact, contentHash: 'invalid' } }, { sourceRefs: Array(17).fill('ref') },
    { sourceRefs: ['x'.repeat(257)] }, { attachments: Array(33).fill(artifact) },
    { attachments: [{ ...artifact, mediaType: 'x'.repeat(129), name: null, truncated: false, redacted: false }] },
    { attachments: [{ ...artifact, mediaType: 'text/plain', name: null, truncated: false, redacted: false, body: 'secret' }] },
    { kind: 'tool_started' }, { toolCallId: 'tool-1', parentToolCallId: 'tool-1' },
  ])('rejects malformed or unbounded message metadata %j', (override) => {
    expect(() => validateSessionMessageRecord({ ...message, ...override })).toThrow();
  });

  it('bounds attachment metadata by bytes even when each item is individually valid', () => {
    const attachment = { ...artifact, locator: '😀'.repeat(1024), name: 'x'.repeat(200),
      mediaType: 'text/plain', truncated: false, redacted: false };
    expect(() => validateSessionMessageRecord({ ...message, attachments: Array(32).fill(attachment) })).toThrow();
  });

  it.each([
    { extra: true }, { watermark: -1 }, { watermark: 4, finalSequence: 3 },
    { watermark: Number.MAX_SAFE_INTEGER + 1 }, { missingReasons: Array(33).fill('gap') },
    { missingReasons: ['x'.repeat(257)] }, { diagnostics: ['line\nbreak'] },
    { truncation: { applied: true, reasons: [] } }, { redaction: { applied: false, reasons: [], body: 'secret' } },
    { scope: { covers: ['hidden_reasoning'], excludes: manifest.scope.excludes } },
    { scope: { covers: ['public_events'], excludes: [] } },
    { nativeRef: { schemaVersion: 1, storageKind: '/private/pi', formatVersion: 'v1' } },
    { coverage: 'partial', missingReasons: [] }, { coverage: 'failed', missingReasons: [] },
    { coverage: 'invented' }, { unknownEventCount: -1 },
    { sequenceReconciliation: 'match', watermark: 1, finalSequence: 2 },
  ])('rejects invalid manifest boundaries or scopes %j', (override) => {
    expect(() => validateRecordingManifestRecord({ ...manifest, ...override })).toThrow();
  });

  it.each([
    { missingReasons: ['unknown_events'] }, { unknownEventCount: null }, { unknownEventCount: 1 },
    { watermark: null }, { finalSequence: null }, { watermark: 0 },
    { sequenceReconciliation: 'not_available' }, { truncation: { applied: true, reasons: ['body_limit'] } },
  ])('refuses incomplete observations declared complete %j', (override) => {
    expect(() => validateRecordingManifestRecord({ ...complete, ...override })).toThrow();
  });

  it('checks authorized identities separately from record shape, without echoing inputs', () => {
    const authorized = { projectId: message.projectId, sessionId: message.sessionId, runId: message.runId,
      attemptId: message.attemptId, invocationId: message.invocationId, executionVersion: message.executionVersion };
    expect(() => assertWorkRecordingIdentity(validateSessionMessageRecord(message), authorized)).not.toThrow();
    for (const key of ['projectId', 'sessionId', 'runId', 'attemptId', 'invocationId', 'executionVersion'] as const) {
      const changed = { ...message, [key]: key === 'executionVersion' ? 2 : 'foreign-identity' };
      expect(() => assertWorkRecordingIdentity(validateSessionMessageRecord(changed), authorized)).toThrow();
    }
    expect(() => assertWorkRecordingIdentity(validateRecordingManifestRecord(manifest), { ...authorized, projectId: 'foreign' })).toThrow();
    try { validateSessionMessageRecord({ ...message, contentRef: { ...artifact, body: 'synthetic-secret' } }); }
    catch (error) { expect(JSON.stringify(error)).not.toContain('synthetic-secret'); }
  });
});
