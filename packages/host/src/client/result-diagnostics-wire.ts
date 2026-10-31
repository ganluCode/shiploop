/**
 * P07-4 / F-003 结果诊断 wire 校验器（纯函数；无 I/O）。
 *
 * 与 work-recording-wire.ts / work-session-wire.ts 同一纪律：
 * - 形状按 Core result-diagnostics 公开投影冻结（三轴 runtime/task/feature、
 *   停止原因/待处理动作、证据/检查/记录/交付引用与用量覆盖）；未知字段、
 *   错误 scope、坏游标、records 超出 limit、行形状与词汇不符一律
 *   response_malformed；schema 版本不符 → unsupported_schema_version；
 * - 公开行只携带稳定身份（artifactId/contentHash/sizeBytes）；不接受 locator、
 *   内部路径或任意文件路径；未知指标保持 null（不以 0 冒充）；
 * - parent/parentFacts 与行归属一致（batch/run/attempt/session 逐一复核）；
 *   冻结词汇（状态/阶段/动作/覆盖）与 Core 同源，不漂移。
 */
import {
  ATTEMPT_EXECUTION_STAGES,
  ATTEMPT_STATUSES,
  EXECUTION_BATCH_STATUSES,
  FEATURE_DELIVERY_STATUSES,
  FEATURE_STATUSES,
  RESULT_PENDING_ACTIONS,
  TASK_STATUSES,
  WIRE_MESSAGE_SCHEMA_VERSION,
  WORK_RECORDING_COVERAGES,
  WORK_RECORDING_SEQUENCE_RECONCILIATIONS,
  WORK_RECORDING_SOURCES,
  WORK_SESSION_QUERY_STATES,
  isIsoUtcDateTime,
} from 'shiploop-core/protocol';
import type {
  PublicResultDiagnosticRecord,
  ResultDiagnosticsListResult,
  ResultDiagnosticsScope,
} from 'shiploop-core/protocol';
import { HostProtocolError, isPlainObject, type HostOperation } from '../contract/index.js';

type Check = (value: unknown) => boolean;
const text: Check = v => typeof v === 'string' && v.length > 0 && v.length <= 256;
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
const object = (shape: Record<string, Check>): Check => v => isPlainObject(v) &&
  Object.keys(v).length === Object.keys(shape).length && Object.entries(shape).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]));

const sessionStatus = oneOf(['reserved', 'started', 'ended', 'stopped']);
const stage = oneOf(ATTEMPT_EXECUTION_STAGES);
const attemptStatus = oneOf(ATTEMPT_STATUSES);
const state = oneOf(WORK_SESSION_QUERY_STATES);
const runStatus = oneOf(EXECUTION_BATCH_STATUSES);
const taskStatus = oneOf(TASK_STATUSES);
const featureStatus = oneOf(FEATURE_STATUSES);
const deliveryStatus = oneOf(FEATURE_DELIVERY_STATUSES);
const pendingAction = oneOf(RESULT_PENDING_ACTIONS);
const issueCode: Check = v => typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v);
const ref = object({ artifactId: id, contentHash: hash, sizeBytes: natural });

const usageSummary = object({
  basis: oneOf(['synthetic', 'reported', 'unknown']),
  coverage: oneOf(['reported', 'partial', 'unknown']),
  inputTokens: nullable(natural),
  outputTokens: nullable(natural),
  cacheReadTokens: nullable(natural),
  cacheWriteTokens: nullable(natural),
  costMicros: nullable(natural),
  currency: nullable(text),
});
const pageUsage = object({
  basis: oneOf(['synthetic', 'reported', 'mixed', 'none']),
  coverage: oneOf(['reported', 'partial', 'unknown']),
  accounting: oneOf(['incremental', 'cumulative', 'unknown']),
  countedObservations: natural,
  inputTokens: nullable(natural),
  outputTokens: nullable(natural),
  cacheReadTokens: nullable(natural),
  cacheWriteTokens: nullable(natural),
  costMicros: nullable(natural),
  diagnostics: array(text, 32),
});
const manifestSummary: Check = object({
  sessionId: id,
  version: positive,
  source: oneOf(WORK_RECORDING_SOURCES),
  coverage: oneOf(WORK_RECORDING_COVERAGES),
  watermark: nullable(natural),
  finalSequence: nullable(natural),
  sequenceReconciliation: oneOf(WORK_RECORDING_SEQUENCE_RECONCILIATIONS),
  finalized: bool,
  unknownEventCount: nullable(natural),
  manifestRef: nullable(ref),
  missingReasons: array(text, 32),
  truncation: object({ applied: bool, reasons: array(text, 32) }),
  redaction: object({ applied: bool, reasons: array(text, 32) }),
});
const verification = object({
  batchId: id,
  operation: text,
  status: text,
  endedAt: nullable(date),
  checks: array(object({ checkKey: text, status: text, outputArtifactId: nullable(id) }), 32),
});
const record: Check = object({
  attemptId: id,
  number: positive,
  taskId: id,
  featureId: id,
  runId: id,
  batchId: id,
  executionStage: stage,
  rework: nullable(object({ previousAttemptId: id })),
  recovery: nullable(object({ sourceAttemptId: nullable(id), selection: text })),
  runtime: object({
    attemptStatus,
    state,
    sessionStatus: nullable(sessionStatus),
    resultKnown: bool,
    exitCode: nullable(integer),
    startedAt: nullable(date),
    endedAt: nullable(date),
    durationMs: nullable(natural),
  }),
  task: object({ taskStatus, manualBlockPending: bool, verification: nullable(verification) }),
  feature: object({ featureStatus, deliveryStatus }),
  blockReasons: array(text, 32),
  pendingActions: array(pendingAction, 16),
  codeRef: nullable(id),
  diagnosticRef: nullable(id),
  resultArtifactId: nullable(id),
  resultEvidenceRef: nullable(id),
  checkRefs: array(object({ batchId: id, operation: text, status: text, endedAt: nullable(date) }), 32),
  gitOperationRefs: array(object({ operationId: id, operationType: text, status: text }), 16),
  recording: nullable(object({
    complete: bool,
    manifestRef: nullable(id),
    failure: nullable(text),
    gaps: array(text, 32),
    watermark: nullable(natural),
  })),
  recorder: nullable(object({ sessions: array(manifestSummary, 16), truncated: bool })),
  usage: usageSummary,
  issues: array(issueCode, 32),
});

const parentFacts = (kind: string): Check => {
  switch (kind) {
    case 'batch':
      return object({ kind: v => v === 'batch', batchId: id, batchStatus: runStatus });
    case 'run':
      return object({ kind: v => v === 'run', runId: id, batchId: id, runStatus, runReason: nullable(text) });
    case 'attempt':
      return object({ kind: v => v === 'attempt', attemptId: id, runId: id, batchId: id });
    default:
      return object({ kind: v => v === 'session', sessionId: id, attemptId: id, runId: id, batchId: id });
  }
};

function malformed(operation: HostOperation, reason = 'result_diagnostics_malformed'): never {
  throw new HostProtocolError('response_malformed', operation, '结果诊断响应不符合线协议', { details: { reason } });
}
function validate(operation: HostOperation, value: unknown, check: Check): void {
  if (isPlainObject(value) && value.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    throw new HostProtocolError('unsupported_schema_version', operation, '不支持的查询响应版本');
  }
  if (!check(value)) malformed(operation);
}

export function validateResultDiagnosticsListWire(value: unknown): ResultDiagnosticsListResult {
  const operation = 'execution.result.diagnostics.list';
  const parent = (kind: string): Check => object(
    kind === 'batch' ? { kind: v => v === 'batch', batchId: id }
      : kind === 'run' ? { kind: v => v === 'run', runId: id }
        : kind === 'attempt' ? { kind: v => v === 'attempt', attemptId: id }
          : { kind: v => v === 'session', sessionId: id },
  );
  validate(operation, value, object({
    schemaVersion: v => v === WIRE_MESSAGE_SCHEMA_VERSION,
    scope: v => v === 'result-diagnostics',
    parent: v => isPlainObject(v) && typeof v.kind === 'string' && ['batch', 'run', 'attempt', 'session'].includes(v.kind) && parent(v.kind)(v),
    parentFacts: v => isPlainObject(v) && typeof v.kind === 'string' && ['batch', 'run', 'attempt', 'session'].includes(v.kind) && parentFacts(v.kind)(v),
    records: array(record),
    nextCursor: nullable(v => typeof v === 'string' && /^plcur_v1_/.test(v)),
    limit: v => positive(v) && Number(v) <= 200,
    eventWatermark: natural,
    usage: pageUsage,
  }));
  const result = value as ResultDiagnosticsListResult;
  if (result.records.length > result.limit) malformed(operation);
  if (result.parent.kind !== result.parentFacts.kind) malformed(operation, 'result_diagnostics_scope_mismatch');
  const facts = result.parentFacts as ResultDiagnosticsScope & Record<string, unknown>;
  if (result.parent.kind === 'batch' && facts.batchId !== result.parent.batchId) malformed(operation, 'result_diagnostics_scope_mismatch');
  if (result.parent.kind === 'run' && facts.runId !== result.parent.runId) malformed(operation, 'result_diagnostics_scope_mismatch');
  if (result.parent.kind === 'attempt' && facts.attemptId !== result.parent.attemptId) malformed(operation, 'result_diagnostics_scope_mismatch');
  if (result.parent.kind === 'session' && facts.sessionId !== result.parent.sessionId) malformed(operation, 'result_diagnostics_scope_mismatch');
  for (const row of result.records as readonly PublicResultDiagnosticRecord[]) {
    if (row.batchId !== facts.batchId) malformed(operation, 'result_diagnostics_scope_mismatch');
    if (result.parent.kind === 'run' && row.runId !== facts.runId) malformed(operation, 'result_diagnostics_scope_mismatch');
    if (result.parent.kind === 'attempt' && row.attemptId !== facts.attemptId) malformed(operation, 'result_diagnostics_scope_mismatch');
    if (result.parent.kind === 'session' && row.attemptId !== facts.attemptId) malformed(operation, 'result_diagnostics_scope_mismatch');
  }
  return result;
}
