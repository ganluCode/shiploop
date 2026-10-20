/**
 * P04-3 F-001: pure Runtime failure classification and partial evidence.
 *
 * This port deliberately accepts normalized SDK/transport facts instead of importing
 * an SDK, HTTP client, process API, or storage implementation. It classifies only
 * what the caller can prove and keeps unknown termination unknown.
 */
import type {
  RuntimeErrorKind,
  RuntimeExecutionResult,
  RuntimeTerminalState,
  RuntimeUsageReport,
} from './runtime-execution.js';

export const RUNTIME_FAILURE_CATEGORIES = [
  'authentication', 'configuration', 'quota_blocked', 'transient_connection',
  'transient_server', 'protocol', 'tool_failure', 'timeout', 'cancelled', 'unknown',
] as const;
export type RuntimeFailureCategory = (typeof RUNTIME_FAILURE_CATEGORIES)[number];

export const RUNTIME_FAILURE_SOURCES = [
  'sdk', 'http', 'transport', 'process', 'tool', 'control', 'protocol', 'unknown',
] as const;
export type RuntimeFailureSource = (typeof RUNTIME_FAILURE_SOURCES)[number];
export type RuntimeFailureConfidence = 'high' | 'medium' | 'low' | 'unknown';

export const RUNTIME_FAILURE_MAX_DIAGNOSTICS = 8;
export const RUNTIME_FAILURE_DIAGNOSTIC_MAX_LENGTH = 256;
export const RUNTIME_FAILURE_PARTIAL_TEXT_MAX_LENGTH = 2_048;

export interface RuntimeFailureErrorInput {
  readonly source?: RuntimeFailureSource | string | null;
  readonly name?: string | null;
  readonly code?: string | null;
  readonly message?: string | null;
  /** Opaque persisted reference; the referenced error body stays outside Core diagnostics. */
  readonly reference?: string | null;
}

export interface RuntimeFailureHttpInput {
  readonly status?: number | null;
  /** Headers are inspected for classification only and never copied to evidence. */
  readonly headers?: Readonly<Record<string, string>> | null;
  /** Provider response text is inspected and then discarded after redaction. */
  readonly body?: string | null;
}

export interface RuntimeFailurePartialResultInput {
  readonly text?: string | null;
  readonly turns?: number | null;
  readonly lastEventSequence?: number | null;
  readonly usage?: RuntimeUsageReport | null;
  readonly durationMs?: number | null;
}

export interface RuntimeFailureInput {
  /** SDK terminal, including an unrecognized value when the SDK added one. */
  readonly sdkTerminal?: string | null;
  readonly terminal?: RuntimeTerminalState | string | null;
  readonly terminalObserved?: boolean;
  /** Existing controlled error facts are retained when a caller already has them. */
  readonly existingRuntimeError?: { readonly kind: RuntimeErrorKind; readonly reason: string } | null;
  readonly stream?: 'complete' | 'interrupted' | 'closed' | 'unknown' | null;
  readonly errorChain?: readonly RuntimeFailureErrorInput[];
  readonly http?: RuntimeFailureHttpInput | null;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly lastStage?: string | null;
  readonly lastActivityAtUtc?: string | null;
  readonly partialResult?: RuntimeFailurePartialResultInput | null;
  readonly usage?: RuntimeUsageReport | null;
  readonly durationMs?: number | null;
  readonly cancelRequested?: boolean;
  readonly timeoutObserved?: boolean;
  readonly protocolIssue?: string | null;
  /** Values already authorized for redaction by the trusted caller. */
  readonly secrets?: readonly string[];
}

export interface RuntimeFailureDiagnostic {
  readonly source: RuntimeFailureSource;
  readonly code: string | null;
  readonly message: string;
}

export interface RuntimePartialResultEvidence {
  readonly text: string | null;
  readonly turns: number | null;
  readonly lastEventSequence: number | null;
  readonly usage: RuntimeUsageReport | null;
  readonly durationMs: number | null;
}

export interface RuntimeFailureEvidence {
  /** Opaque reference only; error body and error chain are never retained. */
  readonly rawErrorRef: string | null;
  readonly source: RuntimeFailureSource;
  readonly sourceConfidence: RuntimeFailureConfidence;
  readonly terminal: string | null;
  readonly terminalObserved: boolean;
  readonly httpStatus: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly lastStage: string | null;
  readonly lastActivityAtUtc: string | null;
  readonly partialResult: RuntimePartialResultEvidence | null;
  readonly usage: RuntimeUsageReport | null;
  readonly durationMs: number | null;
  readonly diagnostics: readonly RuntimeFailureDiagnostic[];
}

export interface RuntimeFailureClassification {
  readonly outcome: 'success' | 'failure';
  /** null is used for a complete successful execution. */
  readonly category: RuntimeFailureCategory | null;
  readonly reason: string;
  /** null means Core must retain the category as unknown/independent control evidence. */
  readonly settlementKind: RuntimeErrorKind | null;
  readonly evidence: RuntimeFailureEvidence;
}

interface Signal {
  readonly category: RuntimeFailureCategory;
  readonly source: RuntimeFailureSource;
  readonly confidence: RuntimeFailureConfidence;
  readonly reason: string;
  readonly code: string;
  readonly rank: number;
}

function bounded(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) || null;
}

function redacted(value: unknown, secrets: readonly string[], limit = RUNTIME_FAILURE_DIAGNOSTIC_MAX_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let result = value;
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join('[REDACTED]');
  result = result
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[REDACTED_ENDPOINT]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  return result.slice(0, limit) || null;
}

function token(value: unknown, fallback: string): string {
  const clean = bounded(value, 96);
  return clean && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(clean) ? clean : fallback;
}

function safeReason(value: unknown, secrets: readonly string[], fallback: string): string {
  const clean = redacted(value, secrets, 200)?.replace(/[^A-Za-z0-9._:-]/g, '_');
  return clean && /^[A-Za-z0-9]/.test(clean) ? clean : fallback;
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function source(value: unknown): RuntimeFailureSource {
  return (typeof value === 'string' && (RUNTIME_FAILURE_SOURCES as readonly string[]).includes(value))
    ? value as RuntimeFailureSource : 'unknown';
}

function evidence(input: RuntimeFailureInput, diagnostics: readonly RuntimeFailureDiagnostic[], selected: Signal | null): RuntimeFailureEvidence {
  const secrets = input.secrets ?? [];
  const first = input.errorChain?.find(error => error.reference !== null && error.reference !== undefined);
  const partialInput = input.partialResult;
  const partial = partialInput === null || partialInput === undefined ? null : {
    text: redacted(partialInput.text, secrets, RUNTIME_FAILURE_PARTIAL_TEXT_MAX_LENGTH),
    turns: nonNegative(partialInput.turns),
    lastEventSequence: nonNegative(partialInput.lastEventSequence),
    usage: partialInput.usage ?? null,
    durationMs: nonNegative(partialInput.durationMs),
  } satisfies RuntimePartialResultEvidence;
  return {
    rawErrorRef: redacted(first?.reference, secrets, 128),
    source: selected?.source ?? 'unknown',
    sourceConfidence: selected?.confidence ?? 'unknown',
    terminal: redacted(input.terminal ?? input.sdkTerminal, secrets, 96),
    terminalObserved: input.terminalObserved === true,
    httpStatus: input.http?.status !== undefined && input.http.status !== null && Number.isInteger(input.http.status)
      ? input.http.status : null,
    exitCode: nonNegative(input.exitCode),
    signal: token(input.signal, '') || null,
    lastStage: redacted(input.lastStage, secrets, 96),
    lastActivityAtUtc: bounded(input.lastActivityAtUtc, 64),
    partialResult: partial,
    usage: input.usage ?? partial?.usage ?? null,
    durationMs: nonNegative(input.durationMs) ?? partial?.durationMs ?? null,
    diagnostics,
  };
}

function settle(category: RuntimeFailureCategory): RuntimeErrorKind | null {
  switch (category) {
    case 'authentication': return 'authentication';
    case 'configuration': return 'configuration';
    case 'quota_blocked': return 'rate_limited';
    case 'transient_connection':
    case 'transient_server': return 'provider';
    case 'protocol': return 'protocol';
    case 'tool_failure': return 'process';
    case 'timeout': return 'timeout';
    case 'cancelled': return null;
    case 'unknown': return null;
  }
}

function textFor(input: RuntimeFailureInput): string {
  const pieces: string[] = [];
  for (const item of input.errorChain ?? []) {
    pieces.push(item.code ?? '', item.name ?? '', item.message ?? '');
  }
  pieces.push(input.protocolIssue ?? '', input.http?.body ?? '', input.sdkTerminal ?? '', input.terminal ?? '', input.signal ?? '', input.lastStage ?? '', input.existingRuntimeError?.reason ?? '');
  return pieces.join(' ').toLowerCase();
}

function codeFor(input: RuntimeFailureInput): string {
  return (input.errorChain ?? []).map(item => item.code ?? '').join(' ').toLowerCase();
}

function addSignal(signals: Signal[], signal: Signal): void { signals.push(signal); }

export function classifyRuntimeFailure(input: RuntimeFailureInput): RuntimeFailureClassification {
  const signals: Signal[] = [];
  const text = textFor(input);
  const code = codeFor(input);
  const httpStatus = input.http?.status ?? null;
  const terminal = input.terminal ?? input.sdkTerminal ?? null;
  const terminalText = typeof terminal === 'string' ? terminal.toLowerCase() : '';
  const explicitCancel = input.cancelRequested === true || terminalText === 'cancelled' || terminalText === 'canceled'
    || /\b(cancelled|canceled|abort(?:ed)?|user_cancel)/.test(code);
  const explicitTimeout = input.timeoutObserved === true || terminalText === 'timed_out'
    || /\b(timeout|timed_out|deadline_exceeded|tool_timeout)\b/.test(`${code} ${text}`);
  const toolStage = typeof input.lastStage === 'string' && /^(tool|tool:|tool_)/i.test(input.lastStage);
  const httpHeaderText = Object.entries(input.http?.headers ?? {}).map(([key, value]) => `${key}:${value}`).join(' ').toLowerCase();
  const hardQuota = httpStatus === 429 || /\b(insufficient_quota|quota_exceeded|quota_blocked|billing_required|payment_required|account_depleted|rate_limit(?:ed)?_?(?:exceeded|blocked)|too_many_requests)\b/.test(`${code} ${text} ${httpHeaderText}`)
    || /(?:x[-_]ratelimit[-_]remaining|ratelimit[-_]remaining)\s*:\s*0\b/.test(httpHeaderText);
  const auth = httpStatus === 401 || /\b(unauthenticated|authentication|invalid_api_key|token_expired|credential_missing|unauthorized)\b/.test(`${code} ${text}`);
  const configuration = /\b(invalid_request|invalid_config|configuration|unsupported_model|model_not_found|context_length|bad_request)\b/.test(`${code} ${text}`);
  const protocol = input.protocolIssue !== null && input.protocolIssue !== undefined
    || /\b(invalid_json|malformed|protocol|schema|runner_missing_terminal|result_watermark|unknown_event)\b/.test(`${code} ${text}`);
  const connection = /\b(econnreset|econnrefused|enotfound|eai_again|socket|network|connection|disconnected|stream_(?:closed|interrupted)|broken_pipe)\b/.test(`${code} ${text}`);
  const server = (typeof httpStatus === 'number' && httpStatus >= 500 && httpStatus <= 599)
    || /\b(service_unavailable|server_error|overloaded|upstream_failure|bad_gateway|gateway_timeout)\b/.test(`${code} ${text}`);
  const existing = input.existingRuntimeError;
  if (existing) {
    const category = existing.kind === 'permission' ? 'unknown'
      : existing.kind === 'authentication' ? 'authentication'
      : existing.kind === 'configuration' ? 'configuration'
      : existing.kind === 'protocol' ? 'protocol'
      : existing.kind === 'timeout' ? 'timeout'
      : existing.kind === 'rate_limited' ? 'quota_blocked' : null;
    if (category !== null) addSignal(signals, { category, source: category === 'protocol' ? 'protocol' : 'sdk', confidence: 'high', reason: safeReason(existing.reason, input.secrets ?? [], existing.kind), code: existing.kind, rank: 115 });
  }

  if (explicitCancel) addSignal(signals, { category: 'cancelled', source: 'control', confidence: 'high', reason: 'runtime_cancelled', code: 'cancelled', rank: 100 });
  if (existing?.kind === 'process' && /\b(cancelled|canceled|abort)/.test(existing.reason.toLowerCase())) {
    addSignal(signals, { category: 'cancelled', source: 'control', confidence: 'high', reason: safeReason(existing.reason, input.secrets ?? [], 'runtime_cancelled'), code: 'cancelled', rank: 116 });
  }
  if (explicitTimeout) addSignal(signals, { category: 'timeout', source: 'control', confidence: 'high', reason: 'runtime_timeout', code: 'timeout', rank: 95 });
  if (toolStage || (input.exitCode !== null && input.exitCode !== undefined && input.exitCode !== 0 && input.lastStage !== null && input.lastStage !== undefined)) {
    addSignal(signals, { category: 'tool_failure', source: toolStage ? 'tool' : 'process', confidence: 'medium', reason: 'tool_failed', code: 'tool_failure', rank: 90 });
  }
  if (hardQuota) addSignal(signals, { category: 'quota_blocked', source: httpStatus === null ? 'sdk' : 'http', confidence: 'high', reason: 'quota_blocked', code: 'quota_blocked', rank: 85 });
  if (auth) addSignal(signals, { category: 'authentication', source: httpStatus === null ? 'sdk' : 'http', confidence: 'high', reason: 'authentication_failed', code: 'authentication', rank: 80 });
  if (configuration) addSignal(signals, { category: 'configuration', source: 'sdk', confidence: 'high', reason: 'configuration_invalid', code: 'configuration', rank: 75 });
  if (protocol) addSignal(signals, { category: 'protocol', source: 'protocol', confidence: 'high', reason: 'protocol_violation', code: 'protocol', rank: 70 });
  if (server) addSignal(signals, { category: 'transient_server', source: 'http', confidence: 'high', reason: 'temporary_server_failure', code: 'transient_server', rank: 60 });
  if (connection || (input.stream === 'interrupted' && httpStatus === 200)) {
    addSignal(signals, { category: 'transient_connection', source: 'transport', confidence: connection ? 'medium' : 'low', reason: 'connection_interrupted', code: 'transient_connection', rank: 55 });
  }

  const completeSuccess = terminalText === 'completed' && input.terminalObserved !== false
    && input.stream !== 'interrupted' && input.stream !== 'closed'
    && (input.exitCode === null || input.exitCode === undefined || input.exitCode === 0)
    && signals.length === 0;
  const unknownTerminal = terminal !== null && terminal !== undefined
    && !['completed', 'failed', 'cancelled', 'canceled', 'timed_out'].includes(terminalText);
  if (unknownTerminal) addSignal(signals, { category: 'unknown', source: 'unknown', confidence: 'unknown', reason: 'unknown_terminal', code: 'unknown_terminal', rank: 110 });
  if (!completeSuccess && signals.length === 0) {
    const reason = input.stream === 'interrupted' ? 'stream_interrupted'
      : terminal === null || terminal === undefined || input.terminalObserved !== true ? 'missing_terminal' : 'unknown_failure';
    addSignal(signals, { category: 'unknown', source: 'unknown', confidence: 'unknown', reason, code: reason, rank: 1 });
  }

  const selected = [...signals].sort((left, right) => right.rank - left.rank)[0] ?? null;
  const diagnostics: RuntimeFailureDiagnostic[] = [];
  for (const item of input.errorChain ?? []) {
    if (diagnostics.length >= RUNTIME_FAILURE_MAX_DIAGNOSTICS) break;
    const message = redacted(item.message ?? item.name ?? item.code, input.secrets ?? []);
    if (message === null) continue;
    diagnostics.push({ source: source(item.source), code: redacted(item.code, input.secrets ?? [], 96), message });
  }
  if (input.protocolIssue !== null && input.protocolIssue !== undefined && diagnostics.length < RUNTIME_FAILURE_MAX_DIAGNOSTICS) {
    diagnostics.push({ source: 'protocol', code: 'protocol_issue', message: redacted(input.protocolIssue, input.secrets ?? []) ?? 'protocol_issue' });
  }
  if (input.existingRuntimeError !== null && input.existingRuntimeError !== undefined && diagnostics.length < RUNTIME_FAILURE_MAX_DIAGNOSTICS) {
    diagnostics.push({ source: 'sdk', code: input.existingRuntimeError.kind, message: redacted(input.existingRuntimeError.reason, input.secrets ?? []) ?? input.existingRuntimeError.kind });
  }
  const finalEvidence = evidence(input, diagnostics.slice(0, RUNTIME_FAILURE_MAX_DIAGNOSTICS), selected);
  if (completeSuccess) return { outcome: 'success', category: null, reason: 'completed', settlementKind: null, evidence: finalEvidence };
  return {
    outcome: 'failure', category: selected?.category ?? 'unknown', reason: selected?.reason ?? 'unknown_failure',
    settlementKind: input.existingRuntimeError?.kind ?? settle(selected?.category ?? 'unknown'), evidence: finalEvidence,
  };
}

/** Compatibility projection for RuntimeSettlementFacts.failure. */
export function toRuntimeSettlementFailure(classification: RuntimeFailureClassification): {
  readonly kind: RuntimeErrorKind;
  readonly reason: string;
} | null {
  return classification.settlementKind === null ? null : { kind: classification.settlementKind, reason: classification.reason };
}

/** Build a classification input from the existing result while preserving null semantics. */
export function classifyRuntimeExecutionResult(result: RuntimeExecutionResult, extras: Omit<RuntimeFailureInput, 'terminal' | 'sdkTerminal' | 'usage' | 'durationMs' | 'exitCode' | 'signal'> = {}): RuntimeFailureClassification {
  return classifyRuntimeFailure({ ...extras, terminal: result.terminal, terminalObserved: true, usage: result.usage,
    durationMs: result.durationMs, exitCode: result.exitCode, signal: result.signal });
}

export type RuntimeFailureResult = RuntimeFailureClassification;
export type RuntimeFailureEvidenceModel = RuntimeFailureEvidence;
export type RuntimeFailurePartialResult = RuntimePartialResultEvidence;
export type RuntimeFailureInputFacts = RuntimeFailureInput;
