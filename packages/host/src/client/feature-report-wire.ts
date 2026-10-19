import { isDeepStrictEqual as same } from 'node:util';
import { WIRE_MESSAGE_SCHEMA_VERSION, ATTEMPT_STATUSES, validateRuntimeRecoverySelection, validateRuntimeRecoveryDecision } from 'shiploop-core/protocol';
import type { FeatureExecutionReport } from 'shiploop-core/protocol';
import { HostProtocolError, isPlainObject } from '../contract/index.js';
import { workSessionWireChecks as work } from './work-session-wire.js';

type Check = (value: unknown) => boolean;
const text: Check = v => typeof v === 'string';
const id: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const natural: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullable = (check: Check): Check => v => v === null || check(v);
const array = (check: Check): Check => v => Array.isArray(v) && v.every(check);
const object = (shape: Record<string, Check>): Check => v => isPlainObject(v) &&
  Object.keys(v).length === Object.keys(shape).length && Object.entries(shape).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]));
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const completeness = oneOf('complete', 'partial');
const issues = array(text);
const reference = object({ artifactId: id, availability: oneOf('ready', 'missing', 'unavailable'), artifact: nullable(work.evidence) });
const usage = object({ basis: oneOf('synthetic', 'reported', 'unknown'), inputTokens: nullable(natural), outputTokens: nullable(natural),
  costMicros: nullable(natural), currency: nullable(text), cacheReadTokens: nullable(natural), cacheWriteTokens: nullable(natural) });
const rework = nullable(object({ previousAttemptId: id, failureEvidenceRefs: array(id) }));
const recovery = nullable(object({ sourceAttemptId: id, sourceSessionId: nullable(id),
  selection: v => { try { validateRuntimeRecoverySelection(v); return true; } catch { return false; } },
  decision: v => { try { validateRuntimeRecoveryDecision(v); return true; } catch { return false; } },
}));
const attemptExtras = {
  signal: nullable(text), runtimeDurationMs: nullable(natural), usage, rework, recovery, sessionIds: array(id),
  evidence: array(reference), diagnostics: array(work.diagnostic), resultEvidence: work.resultEvidence, completeness, issues,
};
const sessionExtras = { attemptId: id, parentSessionId: nullable(id), durationMs: nullable(natural), completeness, issues };
function extended(base: Check, extras: Record<string, Check>): Check {
  return value => {
    if (!isPlainObject(value)) return false;
    const original = { ...value };
    for (const [key, check] of Object.entries(extras)) {
      if (!Object.hasOwn(original, key) || !check(original[key])) return false;
      delete original[key];
    }
    return base(original);
  };
}
const attempt = extended(work.attempt, attemptExtras);
const session = extended(work.session, sessionExtras);
const counts = object(Object.fromEntries(ATTEMPT_STATUSES.map(status => [status, natural])));
function malformed(): never {
  throw new HostProtocolError('response_malformed', 'features.report.get', 'Feature 报告响应不符合线协议', { details: { reason: 'feature_report_malformed' } });
}

/** Reuses the established delivery, verification and Git validators. No I/O or
 * unvalidated extension bags are allowed in the complete history. */
export function validateFeatureReportWire(value: unknown, validate: {
  delivery(value: unknown): unknown;
  verification(value: unknown): void;
  operation(value: unknown): void;
}): FeatureExecutionReport {
  if (isPlainObject(value) && typeof value.schemaVersion === 'number' && value.schemaVersion !== 1) {
    throw new HostProtocolError('unsupported_schema_version', 'features.report.get', '不支持的查询响应版本');
  }
  if (!object({ schemaVersion: v => v === 1, scope: v => v === 'feature-execution-report',
    consistency: object({ mode: v => v === 'single-read-transaction', eventWatermark: natural }),
    feature: isPlainObject, axes: isPlainObject, outcome: isPlainObject,
    tasks: array(object({ current: isPlainObject, latestAttempt: nullable(attempt),
      cumulative: object({ attempts: natural, byStatus: counts, reworks: natural }), attempts: array(attempt) })),
    sessions: array(session), runs: array(isPlainObject), verifications: array(isPlainObject), operations: array(isPlainObject), evidence: array(reference),
    timing: object({ cumulativeSessionMs: nullable(natural), wallClockMs: nullable(natural), measuredSessions: natural,
      totalSessions: natural, completeness }),
    counts: object({ tasks: natural, runs: natural, attempts: natural, sessions: natural, operations: natural }), completeness, issues,
  })(value)) malformed();
  const report = value as FeatureExecutionReport;
  const delivery = (run: unknown) => validate.delivery({ schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION, scope: 'feature-delivery',
    feature: report.feature, axes: report.axes, outcome: report.outcome, run });
  delivery(null);
  report.runs.forEach(delivery);
  report.verifications.forEach(validate.verification);
  report.operations.forEach(validate.operation);
  const attempts = report.tasks.flatMap(t => t.attempts);
  const attemptIds = new Set(attempts.map(a => a.id));
  const sessionIds = new Set(report.sessions.map(s => s.id));
  const runIds = new Set(report.runs.map(r => r.id));
  const taskIds = new Set(report.tasks.map(t => t.current.taskId));
  if (attemptIds.size !== attempts.length || sessionIds.size !== report.sessions.length || runIds.size !== report.runs.length ||
    taskIds.size !== report.tasks.length || new Set(report.evidence.map(e => e.artifactId)).size !== report.evidence.length ||
    new Set(report.verifications.map(v => v.id)).size !== report.verifications.length ||
    new Set(report.operations.map(o => o.operationId)).size !== report.operations.length ||
    report.counts.tasks !== report.tasks.length || report.counts.attempts !== attempts.length ||
    report.counts.runs !== report.runs.length || report.counts.sessions !== report.sessions.length ||
    report.counts.operations !== report.operations.length || report.axes.tasks.records.length !== report.tasks.length) malformed();
  for (const task of report.tasks) {
    if (!same(task.current, report.axes.tasks.records.find(t => t.taskId === task.current.taskId)) ||
      task.cumulative.attempts !== task.attempts.length || task.cumulative.reworks !== task.attempts.filter(a => a.rework !== null).length ||
      !same(task.latestAttempt, task.attempts.at(-1) ?? null)) malformed();
    for (const status of ATTEMPT_STATUSES) if (task.cumulative.byStatus[status] !== task.attempts.filter(a => a.status === status).length) malformed();
    let previousNumber = 0;
    for (const a of task.attempts) {
      const primarySession = report.sessions.find(s => s.id === a.sessionId);
      if (a.taskId !== task.current.taskId || a.featureId !== report.feature.featureId || !runIds.has(a.runId) || a.number <= previousNumber ||
        a.diagnostics.some(d => d.attemptId !== a.id || d.projectId !== a.projectId) ||
        !same(a.sessionIds, report.sessions.filter(s => s.attemptId === a.id).map(s => s.id)) ||
        (primarySession !== undefined && (primarySession.attemptId !== a.id || primarySession.inputRef !== a.inputRef))) malformed();
      previousNumber = a.number;
    }
  }
  for (const s of report.sessions) {
    if (!attemptIds.has(s.attemptId) || (s.parentSessionId !== null && !sessionIds.has(s.parentSessionId))) malformed();
    const duration = s.startedAt === null || s.endedAt === null ? null : Date.parse(s.endedAt) - Date.parse(s.startedAt);
    if (s.durationMs !== duration) malformed();
  }
  const measured = report.sessions.filter(s => s.durationMs !== null);
  const completeTimes = report.sessions.length > 0 && measured.length === report.sessions.length;
  const cumulativeSessionMs = measured.length === 0 ? null : measured.reduce((total, s) => total + s.durationMs!, 0);
  const wallClockMs = completeTimes ? Math.max(...report.sessions.map(s => Date.parse(s.endedAt!))) -
    Math.min(...report.sessions.map(s => Date.parse(s.startedAt!))) : null;
  if (report.timing.cumulativeSessionMs !== cumulativeSessionMs || report.timing.wallClockMs !== wallClockMs ||
    report.timing.completeness !== (completeTimes ? 'complete' : 'partial')) malformed();
  for (const ref of [...report.evidence, ...attempts.flatMap(a => a.evidence)]) {
    if (ref.availability === 'missing' ? ref.artifact !== null : ref.artifact === null ||
      ref.artifact.artifactId !== ref.artifactId || (ref.availability === 'ready') !== (ref.artifact.status === 'ready')) malformed();
  }
  if (report.outcome.identities.featureId !== report.feature.featureId ||
    report.verifications.some(v => v.featureId !== report.feature.featureId) ||
    report.operations.some(o => o.featureId !== report.feature.featureId) ||
    report.timing.totalSessions !== report.sessions.length ||
    report.timing.measuredSessions !== report.sessions.filter(s => s.durationMs !== null).length ||
    report.tasks.some(t => t.attempts.some(a => a.completeness === 'complete' && a.issues.length > 0)) ||
    (report.completeness === 'complete' && (report.issues.length > 0 || report.timing.completeness !== 'complete' ||
      attempts.some(a => a.completeness !== 'complete') || report.sessions.some(s => s.completeness !== 'complete')))) malformed();
  return report;
}
