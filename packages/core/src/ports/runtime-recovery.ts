import type { RuntimeStrategyV1 } from './settings-schema.js';
import { validateRuntimeStrategy } from './settings-schema.js';
import {
  rejectUnknownKeys, requireNonEmptyString, requirePlainObject,
  validateSha256Digest, validateStableId, validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const RUNTIME_RECOVERY_SCHEMA_VERSION = 1;
export type ExecutionIdentity =
  | { readonly purpose: 'work'; readonly runId: string; readonly taskId: string; readonly attemptId: string }
  | { readonly purpose: 'chat'; readonly sessionId: string; readonly turnId: string };
export type RuntimeRecoveryKind = 'conversation' | 'checkpoint';

type RecoverySourceIdentity =
  | { readonly purpose: 'work'; readonly sourceTaskId: string; readonly sourceAttemptId: string }
  | { readonly purpose: 'chat'; readonly sourceTurnId: string };
type RecoverySourceKind =
  | { readonly kind: 'conversation' }
  | { readonly kind: 'checkpoint'; readonly checkpointRef: string };

/** References are immutable Core Artifact IDs, never native filesystem paths. */
export type RuntimeRecoveryReference = RecoverySourceIdentity & RecoverySourceKind & {
  readonly schemaVersion: typeof RUNTIME_RECOVERY_SCHEMA_VERSION;
  readonly sourceProjectId: string;
  readonly sourceSessionId: string;
  readonly runtime: string;
  readonly provider: string;
  readonly model: string;
  readonly providerSessionId: string;
  readonly nativeArchiveRef: string;
  readonly nativeFormat: string;
  readonly nativeFormatVersion: string;
  readonly sourceDigest: string;
};
export type RuntimeRecoverySelection =
  | { readonly mode: 'new' }
  | { readonly mode: 'auto'; readonly kind: RuntimeRecoveryKind; readonly source?: RuntimeRecoveryReference }
  | { readonly mode: 'required'; readonly kind: RuntimeRecoveryKind; readonly source: RuntimeRecoveryReference };

/** Recovery portion of a future execution request; not a Runner start authorization. */
export interface RuntimeRecoveryRequest {
  readonly schemaVersion: typeof RUNTIME_RECOVERY_SCHEMA_VERSION;
  readonly projectId: string;
  readonly sessionId: string;
  readonly executionVersion: number;
  readonly identity: ExecutionIdentity;
  /** Authorized adapter invocation, distinct from process-start and SDK request IDs. */
  readonly invocationId: string;
  readonly strategy: RuntimeStrategyV1;
  readonly recovery: RuntimeRecoverySelection;
}

const context: ValidationContext = { operation: 'RuntimeRecovery.validate' };
function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const result = requirePlainObject(value, context, field);
  rejectUnknownKeys(result, keys, context, field);
  return result;
}
function schema(value: unknown, field: string): 1 {
  if (value !== RUNTIME_RECOVERY_SCHEMA_VERSION) {
    throw validationError(context, field, 'unsupported_schema_version');
  }
  return RUNTIME_RECOVERY_SCHEMA_VERSION;
}
function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value)) {
    throw validationError(context, field, 'invalid_version_or_format');
  }
  return value;
}
function text(value: unknown, field: string): string {
  return requireNonEmptyString(value, context, field);
}
function id(value: unknown, field: string): string {
  return validateStableId(value, context, field);
}
function kind(value: unknown, field: string): RuntimeRecoveryKind {
  if (value !== 'conversation' && value !== 'checkpoint') {
    throw validationError(context, field, 'invalid_recovery_kind');
  }
  return value;
}
function identity(value: unknown): ExecutionIdentity {
  const raw = requirePlainObject(value, context, 'request.identity');
  if (raw.purpose === 'work') {
    rejectUnknownKeys(raw, ['purpose', 'runId', 'taskId', 'attemptId'], context, 'request.identity');
    return { purpose: 'work', runId: id(raw.runId, 'request.identity.runId'),
      taskId: id(raw.taskId, 'request.identity.taskId'), attemptId: id(raw.attemptId, 'request.identity.attemptId') };
  }
  if (raw.purpose === 'chat') {
    rejectUnknownKeys(raw, ['purpose', 'sessionId', 'turnId'], context, 'request.identity');
    return { purpose: 'chat', sessionId: id(raw.sessionId, 'request.identity.sessionId'),
      turnId: id(raw.turnId, 'request.identity.turnId') };
  }
  throw validationError(context, 'request.identity.purpose', 'invalid_purpose');
}

export function validateRuntimeRecoveryReference(value: unknown): RuntimeRecoveryReference {
  const field = 'recovery.source';
  const raw = requirePlainObject(value, context, field);
  const sourceKind = kind(raw.kind, `${field}.kind`);
  if (raw.purpose !== 'work' && raw.purpose !== 'chat') {
    throw validationError(context, `${field}.purpose`, 'invalid_purpose');
  }
  rejectUnknownKeys(raw, [
    'schemaVersion', 'purpose', 'kind', 'sourceProjectId', 'sourceSessionId', 'runtime', 'provider', 'model',
    'providerSessionId', 'nativeArchiveRef', 'nativeFormat', 'nativeFormatVersion', 'sourceDigest',
    ...(raw.purpose === 'work' ? ['sourceTaskId', 'sourceAttemptId'] : ['sourceTurnId']),
    ...(sourceKind === 'checkpoint' ? ['checkpointRef'] : []),
  ], context, field);
  const sourceIdentity: RecoverySourceIdentity = raw.purpose === 'work'
    ? { purpose: 'work', sourceTaskId: id(raw.sourceTaskId, `${field}.sourceTaskId`),
      sourceAttemptId: id(raw.sourceAttemptId, `${field}.sourceAttemptId`) }
    : { purpose: 'chat', sourceTurnId: id(raw.sourceTurnId, `${field}.sourceTurnId`) };
  const sourceType: RecoverySourceKind = sourceKind === 'checkpoint'
    ? { kind: sourceKind, checkpointRef: id(raw.checkpointRef, `${field}.checkpointRef`) }
    : { kind: sourceKind };
  return {
    schemaVersion: schema(raw.schemaVersion, `${field}.schemaVersion`), ...sourceIdentity, ...sourceType,
    sourceProjectId: id(raw.sourceProjectId, `${field}.sourceProjectId`),
    sourceSessionId: id(raw.sourceSessionId, `${field}.sourceSessionId`),
    runtime: text(raw.runtime, `${field}.runtime`), provider: text(raw.provider, `${field}.provider`),
    model: text(raw.model, `${field}.model`), providerSessionId: text(raw.providerSessionId, `${field}.providerSessionId`),
    nativeArchiveRef: id(raw.nativeArchiveRef, `${field}.nativeArchiveRef`),
    nativeFormat: token(raw.nativeFormat, `${field}.nativeFormat`),
    nativeFormatVersion: token(raw.nativeFormatVersion, `${field}.nativeFormatVersion`),
    sourceDigest: validateSha256Digest(raw.sourceDigest, context, `${field}.sourceDigest`),
  };
}
function selection(value: unknown): RuntimeRecoverySelection {
  const raw = requirePlainObject(value, context, 'request.recovery');
  if (raw.mode === 'new') {
    rejectUnknownKeys(raw, ['mode'], context, 'request.recovery');
    return { mode: 'new' };
  }
  if (raw.mode !== 'auto' && raw.mode !== 'required') {
    throw validationError(context, 'request.recovery.mode', 'invalid_recovery_mode');
  }
  rejectUnknownKeys(raw, ['mode', 'kind', 'source'], context, 'request.recovery');
  const requestedKind = kind(raw.kind, 'request.recovery.kind');
  if (raw.source === undefined) {
    if (raw.mode === 'required') {
      throw validationError(context, 'request.recovery.source', 'required_source_missing');
    }
    return { mode: 'auto', kind: requestedKind };
  }
  const source = validateRuntimeRecoveryReference(raw.source);
  if (source.kind !== requestedKind) {
    throw validationError(context, 'request.recovery.source.kind', 'source_kind_mismatch');
  }
  return { mode: raw.mode, kind: requestedKind, source };
}

/** Pure structural validation. Artifact contents, permissions and stopped evidence remain Core duties. */
export function validateRuntimeRecoveryRequest(value: unknown): RuntimeRecoveryRequest {
  const raw = object(value, [
    'schemaVersion', 'projectId', 'sessionId', 'executionVersion', 'identity', 'invocationId', 'strategy', 'recovery',
  ], 'request');
  if (!Number.isSafeInteger(raw.executionVersion) || (raw.executionVersion as number) < 1) {
    throw validationError(context, 'request.executionVersion', 'invalid_execution_version');
  }
  const result: RuntimeRecoveryRequest = {
    schemaVersion: schema(raw.schemaVersion, 'request.schemaVersion'),
    projectId: id(raw.projectId, 'request.projectId'), sessionId: id(raw.sessionId, 'request.sessionId'),
    executionVersion: raw.executionVersion as number, identity: identity(raw.identity),
    invocationId: id(raw.invocationId, 'request.invocationId'),
    strategy: validateRuntimeStrategy(raw.strategy, context, 'request.strategy'), recovery: selection(raw.recovery),
  };
  if (result.identity.purpose === 'chat' && result.identity.sessionId !== result.sessionId) {
    throw validationError(context, 'request.sessionId', 'chat_session_mismatch');
  }
  if (result.recovery.mode !== 'new' && result.recovery.source !== undefined) {
    const source = result.recovery.source;
    if (source.sourceProjectId !== result.projectId || source.runtime !== result.strategy.runtime ||
        source.purpose !== result.identity.purpose) {
      throw validationError(context, 'request.recovery.source', 'source_identity_mismatch');
    }
    if (source.purpose === 'work' && result.identity.purpose === 'work' &&
        (source.sourceTaskId !== result.identity.taskId || source.sourceAttemptId === result.identity.attemptId)) {
      throw validationError(context, 'request.recovery.source', 'work_source_identity_mismatch');
    }
    if (source.purpose === 'chat' && result.identity.purpose === 'chat' &&
        (source.sourceSessionId !== result.sessionId || source.sourceTurnId === result.identity.turnId)) {
      throw validationError(context, 'request.recovery.source', 'chat_source_identity_mismatch');
    }
  }
  return result;
}

export const RUNTIME_RECOVERY_CAPABILITY_NAMES = [
  'nativeHistory', 'conversationResume', 'executionRecovery', 'modelSwitchOnResume', 'nativeFork',
] as const;
export type RuntimeRecoveryCapabilityName = typeof RUNTIME_RECOVERY_CAPABILITY_NAMES[number];
export type RuntimeRecoveryCapabilityStatus = 'verified' | 'unsupported' | 'unverified';
export type RuntimeRecoveryCapabilityEvidence = {
  readonly status: 'verified'; readonly evidenceRef: string; readonly limits: readonly string[];
} | {
  readonly status: 'unsupported' | 'unverified'; readonly evidenceRef?: string; readonly limits: readonly string[];
};
/** Trusted, environment-specific evidence. This is independent of the configuration catalog. */
export interface RuntimeRecoveryCapabilities {
  readonly schemaVersion: typeof RUNTIME_RECOVERY_SCHEMA_VERSION;
  readonly runtimeId: string;
  readonly adapterVersion: string;
  readonly sdkVersion: string | null;
  readonly nativeFormats: readonly { readonly format: string; readonly versions: readonly string[] }[];
  readonly limits: readonly string[];
  readonly capabilities: Readonly<Record<RuntimeRecoveryCapabilityName, RuntimeRecoveryCapabilityEvidence>>;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw validationError(context, field, 'string_array_required');
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}
function evidence(value: unknown, field: string): RuntimeRecoveryCapabilityEvidence {
  const raw = object(value, ['status', 'limits', 'evidenceRef'], field);
  const limits = strings(raw.limits, `${field}.limits`);
  if (raw.status === 'verified') {
    return { status: raw.status, limits, evidenceRef: id(raw.evidenceRef, `${field}.evidenceRef`) };
  }
  if (raw.status !== 'unsupported' && raw.status !== 'unverified') {
    throw validationError(context, `${field}.status`, 'invalid_capability_status');
  }
  return { status: raw.status, limits,
    ...(raw.evidenceRef === undefined ? {} : { evidenceRef: id(raw.evidenceRef, `${field}.evidenceRef`) }) };
}
export function validateRuntimeRecoveryCapabilities(value: unknown): RuntimeRecoveryCapabilities {
  const raw = object(value, [
    'schemaVersion', 'runtimeId', 'adapterVersion', 'sdkVersion', 'nativeFormats', 'limits', 'capabilities',
  ], 'capabilities');
  const caps = object(raw.capabilities, RUNTIME_RECOVERY_CAPABILITY_NAMES, 'capabilities.capabilities');
  if (!Array.isArray(raw.nativeFormats)) {
    throw validationError(context, 'capabilities.nativeFormats', 'array_required');
  }
  const seen = new Set<string>();
  const nativeFormats = raw.nativeFormats.map((entry, index) => {
    const field = `capabilities.nativeFormats[${index}]`;
    const format = object(entry, ['format', 'versions'], field);
    const name = token(format.format, `${field}.format`);
    const versions = strings(format.versions, `${field}.versions`).map((v) => token(v, `${field}.versions`));
    if (seen.has(name) || versions.length === 0 || new Set(versions).size !== versions.length) {
      throw validationError(context, field, 'duplicate_format_or_invalid_versions');
    }
    seen.add(name);
    return { format: name, versions };
  });
  return {
    schemaVersion: schema(raw.schemaVersion, 'capabilities.schemaVersion'),
    runtimeId: text(raw.runtimeId, 'capabilities.runtimeId'),
    adapterVersion: token(raw.adapterVersion, 'capabilities.adapterVersion'),
    sdkVersion: raw.sdkVersion === null ? null : token(raw.sdkVersion, 'capabilities.sdkVersion'),
    nativeFormats, limits: strings(raw.limits, 'capabilities.limits'),
    capabilities: {
      nativeHistory: evidence(caps.nativeHistory, 'capabilities.nativeHistory'),
      conversationResume: evidence(caps.conversationResume, 'capabilities.conversationResume'),
      executionRecovery: evidence(caps.executionRecovery, 'capabilities.executionRecovery'),
      modelSwitchOnResume: evidence(caps.modelSwitchOnResume, 'capabilities.modelSwitchOnResume'),
      nativeFork: evidence(caps.nativeFork, 'capabilities.nativeFork'),
    },
  };
}
export type RuntimeRecoveryDecision =
  | { readonly mode: 'resume'; readonly kind: RuntimeRecoveryKind; readonly reasons: readonly string[] }
  | { readonly mode: 'new' | 'rejected'; readonly reasons: readonly string[] };

/** Capability-only decision, never proof of authorization, safe side effects or successful recovery. */
export function decideRuntimeRecovery(request: unknown, descriptor: unknown): RuntimeRecoveryDecision {
  const input = validateRuntimeRecoveryRequest(request);
  const capabilities = descriptor === undefined ? undefined : validateRuntimeRecoveryCapabilities(descriptor);
  const recovery = input.recovery;
  if (recovery.mode === 'new') return { mode: 'new', reasons: ['explicit_new'] };
  if (recovery.source === undefined) return { mode: 'new', reasons: ['source:missing'] };
  const reasons: string[] = [];
  if (capabilities === undefined) {
    reasons.push('capabilities:unverified');
  } else {
    if (capabilities.runtimeId !== input.strategy.runtime) {
      return { mode: 'rejected', reasons: ['runtime:mismatch'] };
    }
    const source = recovery.source;
    if (!capabilities.nativeFormats.some((format) =>
      format.format === source.nativeFormat && format.versions.includes(source.nativeFormatVersion))) {
      reasons.push('nativeFormat:unsupported');
    }
    const needed: RuntimeRecoveryCapabilityName[] = [
      recovery.kind === 'checkpoint' ? 'executionRecovery' : 'conversationResume', 'nativeFork',
    ];
    if (source.provider !== input.strategy.provider || source.model !== input.strategy.model) {
      needed.push('modelSwitchOnResume');
    }
    for (const name of needed) {
      const status = capabilities.capabilities[name].status;
      if (status !== 'verified') reasons.push(`${name}:${status}`);
    }
  }
  return reasons.length === 0
    ? { mode: 'resume', kind: recovery.kind, reasons }
    : { mode: recovery.mode === 'required' ? 'rejected' : 'new', reasons };
}
