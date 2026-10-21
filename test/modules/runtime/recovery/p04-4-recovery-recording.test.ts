import { createPiWorkRunner } from '../../../../packages/host/src/runtime/pi-runner.ts';
import { validatePiRunnerMessage } from '../../../../packages/host/src/runtime/pi-runner-protocol.ts';
import { recoveryRecordingForRequest } from '../../../../packages/core/src/application/runtime-recovery-recording.ts';
import { createWorkEvidenceRecorder, WorkEvidenceRecordingError } from '../../../../packages/core/src/application/work-evidence-recorder.ts';
import { DEFAULT_RECORDER_LIMITS } from '../../../helpers/p03-6/evidence-fixture.ts';
import { describe, expect, it } from 'vitest';
import { openEvidenceFixture } from '../../../helpers/p03-6/evidence-fixture.ts';
import { validateWorkEvidenceManifest } from '../../../../packages/core/src/ports/work-evidence-recorder.ts';

const script = { schemaVersion: 1, steps: [{ op: 'usage', inputTokens: 7, outputTokens: 3, costUsdMicros: 1 }],
  result: { terminal: 'cancelled', reason: 'cancelled', exitCode: null, signal: null, durationMs: null, usage: null } };

async function recoveryFixture() {
  const f = await openEvidenceFixture({ script });
  const source = { schemaVersion: 1 as const, purpose: 'work' as const, kind: 'conversation' as const,
    sourceProjectId: f.projectId, sourceTaskId: f.taskId, sourceAttemptId: 'attempt-old', sourceSessionId: 'session-old',
    runtime: 'fake', provider: 'old-provider', model: 'old-model', providerSessionId: 'native-old',
    nativeArchiveRef: 'archive-old', sourceDigest: 'a'.repeat(64), nativeFormat: 'jsonl', nativeFormatVersion: '3' };
  return { ...f, request: { ...f.request, recovery: { mode: 'required' as const, kind: 'conversation' as const, source } } };
}

describe('F-005 recovery recording handoff', () => {
  it('[case:core-source-watermark] uses the Core source watermark, preserves old gaps and counts only unique new incremental usage', async () => {
    const f = await recoveryFixture();
    try {
      const previous = { ...f.sessions.getWorkSession(f.projectId, f.sessionId), id: 'session-old', attemptId: 'attempt-old',
        recordingWatermark: 19, recordingGaps: ['missing_sequences:3-4'] };
      const sessions = { ...f.sessions, getWorkSession: (projectId: string, sessionId: string) => sessionId === 'session-old'
        ? previous : f.sessions.getWorkSession(projectId, sessionId) };
      const recorder = createWorkEvidenceRecorder({ publisher: f.publisher, verifier: f.verifier, sessions, limits: DEFAULT_RECORDER_LIMITS });
      const facts = { ...recoveryRecordingForRequest(f.request)!, sourceWatermark: 999, gaps: ['native_cumulative_scope_unknown'],
        decision: { mode: 'resume' as const, kind: 'conversation' as const, reasons: ['verified'] }, sdkVersion: '1.0', sourceSdkVersion: '1.0',
        actualProvider: 'test-provider', actualModel: 'fake-model', providerSessionId: 'native-new' };
      const handle = { ...f.handle, recoveryRecording: Promise.resolve(facts), events: (async function* () {
        for await (const raw of f.handle.events) {
          const event = raw as { kind: string; payload: Record<string, unknown> };
          const next = event.kind === 'usage' ? { ...event, payload: { ...event.payload, basis: 'reported', accounting: 'incremental' } } : raw;
          yield next; yield next;
        }
      })() };
      const outcome = await recorder.record({ request: f.request, handle, eventIdentityPrefix: f.eventIdentityPrefix });
      const bytes = await f.verifier.readVerifiedContent(f.projectId, outcome.manifestArtifactId);
      const manifest = validateWorkEvidenceManifest(JSON.parse(Buffer.from(bytes.content).toString('utf8')));
      expect(manifest.recovery).toMatchObject({ sourceWatermark: 19, sourceGaps: ['missing_sequences:3-4'],
        actualModel: 'fake-model', gaps: expect.arrayContaining(['source_recording_gaps']) });
      expect(manifest.usage.observations.totals).toMatchObject({ inputTokens: 7, outputTokens: 3, costUsdMicros: 1 });
      expect(manifest.stats.duplicatesDropped).toBeGreaterThan(0);
      expect(manifest.watermark).toBeLessThan(19);
      expect(f.sessions.getWorkSession(f.projectId, f.sessionId)).toMatchObject({ providerSessionId: 'native-new',
        nativeRef: { schemaVersion: 1, storageKind: 'jsonl', formatVersion: '3' }, recordingWatermark: manifest.watermark });
    } finally { f.close(); }
  });

  it('[case:empty-new-usage] excludes a final cumulative snapshot and keeps unobserved new usage unknown', async () => {
    const f = await recoveryFixture();
    try {
      const handle = { ...f.handle, events: (async function* () {
        for await (const raw of f.handle.events) if ((raw as { kind: string }).kind !== 'usage') yield raw;
      })(), result: f.handle.result.then(result => ({ ...(result as object), usage: {
        basis: 'reported', inputTokens: 900, outputTokens: 500, costUsdMicros: 100, accounting: 'cumulative', completeness: 'unknown' } })) };
      const outcome = await f.recorder.record({ request: f.request, handle, eventIdentityPrefix: f.eventIdentityPrefix });
      const bytes = await f.verifier.readVerifiedContent(f.projectId, outcome.manifestArtifactId);
      const manifest = validateWorkEvidenceManifest(JSON.parse(Buffer.from(bytes.content).toString('utf8')));
      expect(manifest.usage.observations.totals).toEqual({ inputTokens: null, outputTokens: null, costUsdMicros: null, complete: false });
      expect(manifest.usage.finalReported?.inputTokens).toBe(900);
      expect(manifest.usage.historicalBaseline).toBeNull();
    } finally { f.close(); }
  });

  it('[case:failed-event-stream] retains handoff and durable watermark on recording failure', async () => {
    const f = await recoveryFixture();
    try {
      const handle = { ...f.handle, events: (async function* () {
        for await (const raw of f.handle.events) yield raw;
        throw new Error('transport failed');
      })() };
      let failure: unknown;
      try { await f.recorder.record({ request: f.request, handle, eventIdentityPrefix: f.eventIdentityPrefix }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(WorkEvidenceRecordingError);
      expect(failure).toMatchObject({ reason: 'event_stream_failed', recovery: { source: f.request.recovery.source, coverage: 'unknown' } });
      const error = failure as WorkEvidenceRecordingError;
      const bytes = await f.verifier.readVerifiedContent(f.projectId, error.manifestArtifactId!);
      const manifest = validateWorkEvidenceManifest(JSON.parse(Buffer.from(bytes.content).toString('utf8')));
      expect(manifest).toMatchObject({ coverage: 'failed', recovery: { source: f.request.recovery.source } });
      expect(manifest.watermark).toBe(error.watermark);
    } finally { f.close(); }
  });

  it('[case:runner-handoff] sends bounded recovery facts before the new event stream and validates their wire identity', async () => {
    const f = await recoveryFixture();
    try {
      const handoff = recoveryRecordingForRequest(f.request)!;
      const messages: unknown[] = [];
      await createPiWorkRunner({ adapter: { start: async () => ({ ...f.handle, recoveryRecording: Promise.resolve(handoff) }) },
        write: async bytes => { messages.push(JSON.parse(Buffer.from(bytes).toString('utf8'))); } }).start(f.request);
      expect(messages[0]).toMatchObject({ kind: 'recovery', sequence: 1, body: handoff });
      expect(validatePiRunnerMessage(messages[0], f.request, 0)).toMatchObject({ kind: 'recovery', body: handoff });
      expect(() => validatePiRunnerMessage({ ...messages[0] as object, body: { ...handoff, sessionFile: '/secret/history' } }, f.request, 0)).toThrow();
    } finally { f.close(); }
  });

  it('[case:missing-handoff] preserves known source on cancellation and marks missing old watermark and native evidence', async () => {
    const f = await recoveryFixture();
    try {
      const outcome = await f.recorder.record({ request: f.request, handle: f.handle, eventIdentityPrefix: f.eventIdentityPrefix });
      const bytes = await f.verifier.readVerifiedContent(f.projectId, outcome.manifestArtifactId);
      const manifest = validateWorkEvidenceManifest(JSON.parse(Buffer.from(bytes.content).toString('utf8')));
      expect(manifest).toMatchObject({ coverage: 'partial', recovery: {
        requestedMode: 'required', source: f.request.recovery.source, decision: null,
        sourceWatermark: null, actualProvider: null, actualModel: null,
        historicalUsage: 'excluded_unknown_scope', newEvents: { firstSequence: 1, scope: 'current_invocation' },
        coverage: 'unknown', gaps: expect.arrayContaining(['source_watermark_unknown', 'adapter_recovery_unobserved']),
      } });
      expect(manifest.result?.terminal).toBe('cancelled');
      expect(f.sessions.getWorkSession(f.projectId, f.sessionId).recordingGaps).toContain('recovery:adapter_recovery_unobserved');
    } finally { f.close(); }
  });

  it('[case:unknown-usage] keeps cumulative/unknown observations but never adds them to new usage totals', async () => {
    const f = await recoveryFixture();
    try {
      const handle = { ...f.handle, events: (async function* () {
        for await (const raw of f.handle.events) {
          const event = raw as { kind: string; payload: Record<string, unknown> };
          yield event.kind === 'usage' ? { ...event, payload: { ...event.payload, accounting: 'cumulative', completeness: 'unknown' } } : raw;
        }
      })() };
      const outcome = await f.recorder.record({ request: f.request, handle, eventIdentityPrefix: f.eventIdentityPrefix });
      const bytes = await f.verifier.readVerifiedContent(f.projectId, outcome.manifestArtifactId);
      const manifest = validateWorkEvidenceManifest(JSON.parse(Buffer.from(bytes.content).toString('utf8')));
      expect(manifest.usage.observations.totals).toEqual({ inputTokens: null, outputTokens: null, costUsdMicros: null, complete: false });
      expect(manifest.gaps).toContain('usage_scope_unknown');
      expect(manifest.usage.notAdditive).toBe(true);
    } finally { f.close(); }
  });
});
