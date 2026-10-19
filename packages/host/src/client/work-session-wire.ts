import { createHash } from 'node:crypto';
import { ATTEMPT_EXECUTION_STAGES, ATTEMPT_STATUSES, ATTEMPT_NOTIFICATION_DIAGNOSTIC_REASONS,
  WIRE_MESSAGE_SCHEMA_VERSION, WORK_SESSION_QUERY_STATES, isIsoUtcDateTime,
  validatePublicWorkSessionResultEvidence } from 'shiploop-core/protocol';
import type { WorkSessionDetailResult, WorkSessionListResult, WorkSessionEvidenceContent } from 'shiploop-core/protocol';
import { HostProtocolError, isPlainObject, MAX_WORK_SESSION_EVIDENCE_RESPONSE_BYTES, type HostOperation } from '../contract/index.js';

type Check = (value: unknown) => boolean;
const text: Check = v => typeof v === 'string' && v.length > 0;
const id: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const integer: Check = v => typeof v === 'number' && Number.isSafeInteger(v);
const natural: Check = v => integer(v) && Number(v) >= 0;
const positive: Check = v => natural(v) && Number(v) > 0;
const bool: Check = v => typeof v === 'boolean';
const hash: Check = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const date: Check = v => isIsoUtcDateTime(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const oneOf = (values: readonly unknown[]): Check => v => values.includes(v);
const array = (check: Check, max = 200): Check => v => Array.isArray(v) && v.length <= max && v.every(check);
const sessionStatus = oneOf(['reserved', 'started', 'ended', 'stopped']);
const stage = oneOf(ATTEMPT_EXECUTION_STAGES);
const state = oneOf(WORK_SESSION_QUERY_STATES);
const object = (shape: Record<string, Check>): Check => v => isPlainObject(v) &&
  Object.keys(v).length === Object.keys(shape).length && Object.entries(shape).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]));
const usage = object({ schemaVersion: v => v === 1, inputTokens: nullable(natural), outputTokens: nullable(natural),
  costMicros: nullable(natural), currency: nullable(text) });
const summary = object({ sessionId: id, projectId: id, featureId: id, runId: id, taskId: id, attemptId: id,
  attemptNumber: positive, status: sessionStatus, executionStage: stage, executionState: state, runtime: text,
  adapterVersion: text, inputRef: id, resultRef: nullable(id), lastActivityAt: date, startedAt: nullable(date),
  endedAt: nullable(date), stoppedAt: nullable(date), recordingWatermark: nullable(natural), recordingGapCount: nullable(natural) });
const attempt = object({ id, projectId: id, featureId: id, runId: id, taskId: id, number: positive, owner: id,
  hostInstanceId: id, executionVersion: positive, status: oneOf(ATTEMPT_STATUSES), executionStage: stage,
  inputDigest: hash, inputRef: id, sessionId: nullable(id), invocationId: nullable(id), errorKind: nullable(text),
  diagnosticRef: nullable(id), startedAt: nullable(date), endedAt: nullable(date), durationMs: nullable(natural),
  exitCode: nullable(integer), usageSummary: nullable(usage) });
const session = object({ id, status: sessionStatus, kind: v => v === 'work', purpose: text, title: nullable(text),
  runtime: text, adapterVersion: text, executionStage: stage, nativeRef: nullable(object({ schemaVersion: v => v === 1,
    storageKind: text, formatVersion: text })), inputRef: id, resultRef: nullable(id), lastActivityAt: date,
  startedAt: nullable(date), endedAt: nullable(date), stoppedAt: nullable(date), recordingWatermark: nullable(natural),
  recordingGaps: nullable(array(text, 32)), revision: positive, createdAt: date, updatedAt: date });
const occupancy = object({ id, attemptId: id, runId: id, resourceKind: oneOf(['global', 'project', 'workspace']),
  resourceKey: text, state: oneOf(['held', 'quarantined']), leaseUntil: date, processIdentity: bool });
const evidence = object({ artifactId: id, kind: text, mediaType: text, status: oneOf(['pending', 'ready', 'failed']),
  contentHash: nullable(hash), sizeBytes: nullable(natural), version: positive });
const diagnostic = object({ id, projectId: id, attemptId: id, notificationDigest: hash,
  reason: oneOf(ATTEMPT_NOTIFICATION_DIAGNOSTIC_REASONS), occurredAt: date });
const resultEvidence: Check = v => {
  if (v === null) return true;
  try { validatePublicWorkSessionResultEvidence(v); return true; } catch { return false; }
};
// Reused by the complete report's extended Attempt/Session records.
export const workSessionWireChecks = { attempt, session, evidence, diagnostic, resultEvidence };
function malformed(operation: HostOperation): never {
  throw new HostProtocolError('response_malformed', operation, 'Work Session 响应不符合线协议', { details: { reason: 'work_session_malformed' } });
}
function validate(operation: HostOperation, value: unknown, check: Check): void {
  if (isPlainObject(value) && value.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    throw new HostProtocolError('unsupported_schema_version', operation, '不支持的查询响应版本');
  }
  if (!check(value)) malformed(operation);
}
export function validateWorkSessionListWire(value: unknown): WorkSessionListResult {
  const operation = 'execution.sessions.list';
  validate(operation, value, object({ schemaVersion: v => v === WIRE_MESSAGE_SCHEMA_VERSION, scope: v => v === 'work-session-list',
    records: array(summary), nextCursor: nullable(v => typeof v === 'string' && /^plcur_v1_/.test(v)), limit: v => positive(v) && Number(v) <= 200 }));
  const result = value as WorkSessionListResult;
  if (result.records.length > result.limit) malformed(operation);
  return result;
}
export function validateWorkSessionDetailWire(value: unknown): WorkSessionDetailResult {
  const operation = 'execution.session.get';
  validate(operation, value, object({ schemaVersion: v => v === WIRE_MESSAGE_SCHEMA_VERSION, scope: v => v === 'work-session',
    attempt, executionState: state, session: nullable(session), resultEvidence, occupancy: array(occupancy), evidence: array(evidence),
    evidenceTruncated: bool, diagnostics: array(diagnostic), diagnosticsTruncated: bool }));
  const result = value as WorkSessionDetailResult;
  if (result.session && (result.session.id !== result.attempt.sessionId || result.session.inputRef !== result.attempt.inputRef) ||
      result.occupancy.some(row => row.attemptId !== result.attempt.id || row.runId !== result.attempt.runId) ||
      result.diagnostics.some(row => row.projectId !== result.attempt.projectId || row.attemptId !== result.attempt.id)) malformed(operation);
  return result;
}
export function validateWorkSessionEvidenceWire(value: unknown): WorkSessionEvidenceContent {
  const operation = 'execution.session.evidence.get';
  validate(operation, value, object({ schemaVersion: v => v === WIRE_MESSAGE_SCHEMA_VERSION, scope: v => v === 'work-session-evidence',
    artifact: object({ artifactId: id, kind: text, mediaType: text, contentHash: hash, sizeBytes: natural, version: positive }),
    content: v => typeof v === 'string' && v.length <= MAX_WORK_SESSION_EVIDENCE_RESPONSE_BYTES && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v) }));
  const wire = value as Omit<WorkSessionEvidenceContent, 'content'> & { content: string };
  const content = Buffer.from(wire.content, 'base64');
  if (content.length !== wire.artifact.sizeBytes || createHash('sha256').update(content).digest('hex') !== wire.artifact.contentHash) malformed(operation);
  return { ...wire, content };
}
