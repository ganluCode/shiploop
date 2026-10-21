import { validateRuntimeRecoveryDecision, validateRuntimeRecoveryReference } from './runtime-recovery.js';
import type { RuntimeRecoveryDecision, RuntimeRecoveryReference } from './runtime-recovery.js';
import { requirePlainObject, rejectUnknownKeys, validateNonNegativeInteger, validationError } from './validation.js';

/** Incremental audit handoff, never authorization or proof that an Attempt succeeded. */
export interface RuntimeRecoveryRecording {
  readonly schemaVersion: 1;
  readonly requestedMode: 'auto' | 'required' | 'new';
  readonly source: RuntimeRecoveryReference | null;
  readonly decision: RuntimeRecoveryDecision | null;
  readonly sourceWatermark: number | null;
  readonly nativeSourceWatermark: { readonly entryCount: number; readonly lastEntryId: string | null } | null;
  readonly sourceGaps: readonly string[];
  readonly sourceSdkVersion: string | null;
  readonly sdkVersion: string | null;
  readonly nativeFormat: string | null;
  readonly nativeFormatVersion: string | null;
  readonly providerSessionId: string | null;
  readonly actualProvider: string | null;
  readonly actualModel: string | null;
  readonly historicalUsage: 'excluded_unknown_scope';
  readonly newEvents: { readonly firstSequence: 1; readonly scope: 'current_invocation' };
  readonly coverage: 'partial' | 'unknown';
  readonly gaps: readonly string[];
}

export function validateRuntimeRecoveryRecording(value: unknown): RuntimeRecoveryRecording {
  const context = { operation: 'RuntimeRecoveryRecording.validate' };
  const raw = requirePlainObject(value, context, 'recording');
  rejectUnknownKeys(raw, ['schemaVersion', 'requestedMode', 'source', 'decision', 'sourceWatermark', 'nativeSourceWatermark', 'sourceGaps',
    'sourceSdkVersion', 'sdkVersion', 'nativeFormat', 'nativeFormatVersion', 'providerSessionId', 'actualProvider',
    'actualModel', 'historicalUsage', 'newEvents', 'coverage', 'gaps'], context, 'recording');
  const fail = (): never => { throw validationError(context, 'recording', 'invalid_recovery_recording'); };
  const text = (value: unknown): string | null => {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/.test(value)) return fail();
    return value;
  };
  const gaps = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 32) return fail();
    return value.map(entry => {
      if (typeof entry !== 'string' || entry.length === 0 || [...entry].length > 256 || /[\u0000-\u001F\u007F]/.test(entry)) return fail();
      return entry;
    });
  };
  if (raw.schemaVersion !== 1 || !['auto', 'required', 'new'].includes(String(raw.requestedMode)) ||
      !['partial', 'unknown'].includes(String(raw.coverage)) || raw.historicalUsage !== 'excluded_unknown_scope') fail();
  const boundary = requirePlainObject(raw.newEvents, context, 'recording.newEvents');
  rejectUnknownKeys(boundary, ['firstSequence', 'scope'], context, 'recording.newEvents');
  if (boundary.firstSequence !== 1 || boundary.scope !== 'current_invocation') fail();
  let nativeSourceWatermark: RuntimeRecoveryRecording['nativeSourceWatermark'] = null;
  if (raw.nativeSourceWatermark !== null) {
    const watermark = requirePlainObject(raw.nativeSourceWatermark, context, 'nativeSourceWatermark');
    rejectUnknownKeys(watermark, ['entryCount', 'lastEntryId'], context, 'nativeSourceWatermark');
    nativeSourceWatermark = { entryCount: validateNonNegativeInteger(watermark.entryCount, context, 'entryCount'), lastEntryId: text(watermark.lastEntryId) };
  }
  return { schemaVersion: 1, requestedMode: raw.requestedMode as RuntimeRecoveryRecording['requestedMode'],
    source: raw.source === null ? null : validateRuntimeRecoveryReference(raw.source),
    decision: raw.decision === null ? null : validateRuntimeRecoveryDecision(raw.decision),
    sourceWatermark: raw.sourceWatermark === null ? null : validateNonNegativeInteger(raw.sourceWatermark, context, 'sourceWatermark'),
    nativeSourceWatermark, sourceGaps: gaps(raw.sourceGaps), sourceSdkVersion: text(raw.sourceSdkVersion), sdkVersion: text(raw.sdkVersion),
    nativeFormat: text(raw.nativeFormat), nativeFormatVersion: text(raw.nativeFormatVersion),
    providerSessionId: text(raw.providerSessionId), actualProvider: text(raw.actualProvider), actualModel: text(raw.actualModel),
    historicalUsage: 'excluded_unknown_scope', newEvents: { firstSequence: 1, scope: 'current_invocation' },
    coverage: raw.coverage as RuntimeRecoveryRecording['coverage'], gaps: gaps(raw.gaps) };
}
