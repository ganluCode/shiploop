import { isDeepStrictEqual } from 'node:util';
import type { RuntimeExecutionRequest } from '../ports/runtime-execution.js';
import { validateRuntimeRecoveryRecording } from '../ports/runtime-recovery-recording.js';
import type { RuntimeRecoveryRecording } from '../ports/runtime-recovery-recording.js';
import type { WorkSessionStore } from '../ports/work-session.js';

/** Core watermarks are read from the unified audit index, never inferred from native history. */
export function recoveryRecordingForRequest(request: RuntimeExecutionRequest, observed?: unknown,
  sessions?: Pick<WorkSessionStore, 'getWorkSession'>): RuntimeRecoveryRecording | undefined {
  if (request.recovery.mode === 'new') return undefined;
  const source = request.recovery.source ?? null;
  const facts = observed == null ? null : validateRuntimeRecoveryRecording(observed);
  if (facts !== null && (facts.requestedMode !== request.recovery.mode || !isDeepStrictEqual(facts.source, source))) {
    throw new TypeError('recovery_recording_source_mismatch');
  }
  let sourceWatermark: number | null = null;
  let sourceGaps: readonly string[] = [];
  if (source !== null && sessions !== undefined) {
    try {
      const previous = sessions.getWorkSession(request.projectId, source.sourceSessionId);
      if (source.purpose === 'work' && previous.attemptId === source.sourceAttemptId && previous.kind === 'work') {
        sourceWatermark = previous.recordingWatermark;
        sourceGaps = previous.recordingGaps ?? ['source_gaps_unknown'];
      }
    } catch { /* Missing evidence remains unknown, without inventing a baseline. */ }
  }
  const gaps = [...new Set([
    ...(facts?.gaps ?? ['adapter_recovery_unobserved']),
    ...(sourceWatermark === null ? ['source_watermark_unknown'] : []),
    ...(sourceGaps.length ? ['source_recording_gaps'] : []),
  ])].slice(0, 32);
  return { schemaVersion: 1, requestedMode: request.recovery.mode, source,
    decision: facts?.decision ?? null, sourceWatermark, sourceGaps,
    nativeSourceWatermark: facts?.nativeSourceWatermark ?? null,
    sourceSdkVersion: facts?.sourceSdkVersion ?? null, sdkVersion: facts?.sdkVersion ?? null,
    nativeFormat: facts?.nativeFormat ?? source?.nativeFormat ?? null,
    nativeFormatVersion: facts?.nativeFormatVersion ?? source?.nativeFormatVersion ?? null,
    providerSessionId: facts?.providerSessionId ?? null,
    actualProvider: facts?.actualProvider ?? null, actualModel: facts?.actualModel ?? null,
    historicalUsage: 'excluded_unknown_scope', newEvents: { firstSequence: 1, scope: 'current_invocation' },
    coverage: facts === null ? 'unknown' : 'partial', gaps };
}
