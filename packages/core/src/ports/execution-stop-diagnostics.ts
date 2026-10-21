/**
 * P04-7 / F-001：停止、超时与进程故障的统一公开诊断契约。
 *
 * 这是一个受限的 Core 证据投影：它只保存稳定业务身份、受监督进程身份和
 * 有界观察结果。它不包含 SDK 私有 session、宿主路径、凭据，也不提供任意
 * PID 操作。旧的 ExecutionStopEvidence schema 保持独立，历史证据仍按原版本
 * 校验；本 schema 用于把暂停、取消、超时和宿主/进程故障放在同一诊断视图。
 */
import type { CommandProcessIdentity } from './command-process.js';
import { rejectUnknownKeys, requirePlainObject, validateNonNegativeInteger, validatePositiveInteger, validateStableId, validationError } from './validation.js';
import type { ValidationContext } from './validation.js';

export const EXECUTION_STOP_DIAGNOSTIC_SCHEMA_VERSION = 1;
export const EXECUTION_STOP_DIAGNOSTIC_KIND = 'execution-stop-diagnostic';
export const EXECUTION_STOP_DIAGNOSTIC_MAX_GAPS = 32;
export const EXECUTION_STOP_REQUIRED_BLOCKED_ACTIONS = [
  'release_work_resource', 'release_lease', 'start_attempt', 'switch_fallback',
] as const;

export const EXECUTION_STOP_SOURCES = [
  'pause', 'cancel', 'timeout', 'host_failure', 'crash', 'operator_request',
] as const;
export type ExecutionStopSource = (typeof EXECUTION_STOP_SOURCES)[number];

/** 请求来源与实际停止事实分开，避免把所有终止统一归为 cancel 或 timeout。 */
export const EXECUTION_STOP_REASONS = [
  'pause', 'cancel', 'timeout', 'host_failure', 'crash', 'operator_request',
  'process_exit', 'signal', 'completed', 'unknown',
] as const;
export type ExecutionStopReason = (typeof EXECUTION_STOP_REASONS)[number];

export const EXECUTION_STOP_BUDGET_LAYERS = ['session', 'tool', 'check', 'run', 'batch'] as const;
export type ExecutionStopBudgetLayer = (typeof EXECUTION_STOP_BUDGET_LAYERS)[number];

export const EXECUTION_STOP_OBSERVATION_STATES = [
  'confirmed', 'unconfirmed', 'quarantined', 'not_started', 'unknown',
] as const;
export type ExecutionStopObservationState = (typeof EXECUTION_STOP_OBSERVATION_STATES)[number];

export const EXECUTION_STOP_PHASES = ['not_started', 'requested', 'confirmed', 'unconfirmed', 'unknown'] as const;
export type ExecutionStopPhase = (typeof EXECUTION_STOP_PHASES)[number];

export interface ExecutionStopDiagnosticIdentity {
  readonly projectId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly attemptId: string | null;
  readonly sessionId: string | null;
  readonly toolCallId: string | null;
  readonly checkKey: string | null;
  readonly commandId: string | null;
  readonly owner: string | null;
  readonly hostInstanceId: string | null;
  readonly executionVersion: number | null;
  /** 只作证据关联；不存在通用 signal/kill PID API。 */
  readonly processIdentity: CommandProcessIdentity | null;
}

export interface ExecutionStopDiagnosticOperation {
  readonly operationId: string;
  readonly requestedAtUtc: string;
  readonly observedAtUtc: string;
  readonly observedOnHostInstanceId: string | null;
}

export interface ExecutionStopDiagnosticBudget {
  readonly layer: ExecutionStopBudgetLayer | null;
  readonly limitMs: number | null;
  readonly elapsedMs: number | null;
  readonly deadlineUtc: string | null;
}

export interface ExecutionStopDiagnosticTiming {
  readonly lastActivityAtUtc: string | null;
  readonly lastActivityKind: string | null;
  readonly gracefulRequestedAtUtc: string | null;
  readonly forcedAtUtc: string | null;
}

export interface ExecutionStopDiagnosticExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reason: string | null;
  /** true 仅在观测到强制终止时使用；null 保留无法判定，不能伪造为 false。 */
  readonly forced: boolean | null;
}

export interface ExecutionStopDiagnosticEscalation {
  readonly graceful: ExecutionStopPhase;
  readonly forced: ExecutionStopPhase;
}

export interface ExecutionStopDiagnosticObservation {
  readonly state: ExecutionStopObservationState;
  readonly checkedAtUtc: string | null;
  readonly detail: string | null;
  /** unknown/unconfirmed/quarantined 必须给出可追踪缺口；不以零值替代未知。 */
  readonly gaps: readonly string[];
}

export interface ExecutionStopProcessObservation extends ExecutionStopDiagnosticObservation {
  readonly tree: ExecutionStopObservationState;
  readonly group: ExecutionStopObservationState;
  readonly processIdentity: CommandProcessIdentity | null;
}

export interface ExecutionStopRuntimeObservation extends ExecutionStopDiagnosticObservation {
  readonly result: ExecutionStopObservationState;
  readonly stop: ExecutionStopObservationState;
}

export interface ExecutionStopRecordingObservation extends ExecutionStopDiagnosticObservation {
  readonly eventFlush: ExecutionStopObservationState;
  readonly manifestRef: string | null;
  readonly finalSequence: number | null;
}

export interface ExecutionStopDiagnosticObservations {
  readonly process: ExecutionStopProcessObservation;
  readonly sdkRuntime: ExecutionStopRuntimeObservation;
  readonly verifier: ExecutionStopDiagnosticObservation;
  readonly recording: ExecutionStopRecordingObservation;
  readonly workResource: ExecutionStopDiagnosticObservation;
  readonly lease: ExecutionStopDiagnosticObservation;
}

export interface ExecutionStopDiagnosticFollowUp {
  readonly allowed: readonly string[];
  readonly blocked: readonly string[];
}

/** 可持久化的统一诊断事实；所有可观察域保持独立，允许部分未知。 */
export interface ExecutionStopDiagnostic {
  readonly schemaVersion: typeof EXECUTION_STOP_DIAGNOSTIC_SCHEMA_VERSION;
  readonly kind: typeof EXECUTION_STOP_DIAGNOSTIC_KIND;
  readonly identity: ExecutionStopDiagnosticIdentity;
  readonly operation: ExecutionStopDiagnosticOperation;
  readonly source: ExecutionStopSource;
  readonly reason: ExecutionStopReason;
  /** 总体边界：未确认或隔离时，后续动作必须遵守 followUp.blocked。 */
  readonly status: ExecutionStopObservationState;
  readonly budget: ExecutionStopDiagnosticBudget;
  readonly timing: ExecutionStopDiagnosticTiming;
  readonly escalation: ExecutionStopDiagnosticEscalation;
  readonly exit: ExecutionStopDiagnosticExit;
  readonly observations: ExecutionStopDiagnosticObservations;
  readonly followUp: ExecutionStopDiagnosticFollowUp;
  readonly gaps: readonly string[];
}

export type ExecutionStopDiagnosticDisposition = 'accepted' | 'replayed' | 'ignored_late' | 'conflict';
export interface ExecutionStopDiagnosticLedgerEntry {
  readonly operationId: string;
  readonly firstObservedAtUtc: string;
  readonly revision: number;
  readonly diagnostic: ExecutionStopDiagnostic;
}
export interface ExecutionStopDiagnosticRecordResult {
  readonly disposition: ExecutionStopDiagnosticDisposition;
  readonly entry: ExecutionStopDiagnosticLedgerEntry;
}

const context: ValidationContext = { operation: 'ExecutionStopDiagnostic.validate' };
const observationStates = EXECUTION_STOP_OBSERVATION_STATES as readonly string[];
const phases = EXECUTION_STOP_PHASES as readonly string[];

function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, keys, context, field);
  return raw;
}
function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > max || /[\u0000-\u001F\u007F]/.test(value)) {
    throw validationError(context, field, '必须是有界文本');
  }
  return value;
}
function nullableText(value: unknown, field: string, max = 256): string | null {
  return value === null ? null : text(value, field, max);
}
function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw validationError(context, field, '枚举值无效');
  return value as T;
}
function nullableId(value: unknown, field: string): string | null {
  return value === null ? null : validateStableId(value, context, field);
}
function nullableSafeInteger(value: unknown, field: string): number | null {
  return value === null ? null : validateNonNegativeInteger(value, context, field);
}
function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  throw validationError(context, field, '必须是 boolean 或 null');
}
function iso(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || !value.endsWith('Z')) {
    throw validationError(context, field, '必须是 UTC ISO 时间');
  }
  return value;
}
function nullableIso(value: unknown, field: string): string | null {
  return value === null ? null : iso(value, field);
}
function gaps(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > EXECUTION_STOP_DIAGNOSTIC_MAX_GAPS) {
    throw validationError(context, field, '必须是有界缺口数组');
  }
  const result = value.map((item, index) => text(item, `${field}[${index}]`, 256));
  if (new Set(result).size !== result.length) throw validationError(context, field, '缺口不得重复');
  return result;
}
function requireGapForUncertain(state: ExecutionStopObservationState, values: readonly string[], field: string): void {
  if (state !== 'confirmed' && values.length === 0) throw validationError(context, field, '未知或未确认观察必须记录缺口');
}
function processIdentity(value: unknown, field: string): CommandProcessIdentity | null {
  if (value === null) return null;
  const raw = object(value, ['launchId', 'pid', 'processGroupId', 'startTime'], field);
  const pid = validatePositiveInteger(raw.pid, context, `${field}.pid`);
  const processGroupId = validatePositiveInteger(raw.processGroupId, context, `${field}.processGroupId`);
  if (processGroupId !== pid) throw validationError(context, `${field}.processGroupId`, '必须与受监督 PID 一致');
  const startTime = text(raw.startTime, `${field}.startTime`, 128);
  if (startTime.includes('/') || startTime.includes('\\')) throw validationError(context, `${field}.startTime`, '不得携带宿主路径');
  return { launchId: validateStableId(raw.launchId, context, `${field}.launchId`), pid, processGroupId, startTime };
}
function baseObservation(value: unknown, field: string, extraKeys: readonly string[] = []): ExecutionStopDiagnosticObservation {
  const raw = object(value, ['state', 'checkedAtUtc', 'detail', 'gaps', ...extraKeys], field);
  const state = enumValue(raw.state, EXECUTION_STOP_OBSERVATION_STATES, `${field}.state`);
  const checkedAtUtc = nullableIso(raw.checkedAtUtc, `${field}.checkedAtUtc`);
  const detail = nullableText(raw.detail, `${field}.detail`);
  const missing = gaps(raw.gaps, `${field}.gaps`);
  requireGapForUncertain(state, missing, `${field}.gaps`);
  return { state, checkedAtUtc, detail, gaps: missing };
}
function processObservation(value: unknown, field: string): ExecutionStopProcessObservation {
  const base = baseObservation(value, field, ['tree', 'group', 'processIdentity']);
  const raw = object(value, ['state', 'checkedAtUtc', 'detail', 'gaps', 'tree', 'group', 'processIdentity'], field);
  const tree = enumValue(raw.tree, EXECUTION_STOP_OBSERVATION_STATES, `${field}.tree`);
  const group = enumValue(raw.group, EXECUTION_STOP_OBSERVATION_STATES, `${field}.group`);
  requireGapForUncertain(tree, base.gaps, `${field}.gaps`);
  requireGapForUncertain(group, base.gaps, `${field}.gaps`);
  return { ...base, tree, group, processIdentity: processIdentity(raw.processIdentity, `${field}.processIdentity`) };
}
function runtimeObservation(value: unknown, field: string): ExecutionStopRuntimeObservation {
  const base = baseObservation(value, field, ['result', 'stop']);
  const raw = object(value, ['state', 'checkedAtUtc', 'detail', 'gaps', 'result', 'stop'], field);
  const result = enumValue(raw.result, EXECUTION_STOP_OBSERVATION_STATES, `${field}.result`);
  const stop = enumValue(raw.stop, EXECUTION_STOP_OBSERVATION_STATES, `${field}.stop`);
  requireGapForUncertain(result, base.gaps, `${field}.gaps`);
  requireGapForUncertain(stop, base.gaps, `${field}.gaps`);
  return { ...base, result, stop };
}
function recordingObservation(value: unknown, field: string): ExecutionStopRecordingObservation {
  const base = baseObservation(value, field, ['eventFlush', 'manifestRef', 'finalSequence']);
  const raw = object(value, ['state', 'checkedAtUtc', 'detail', 'gaps', 'eventFlush', 'manifestRef', 'finalSequence'], field);
  const eventFlush = enumValue(raw.eventFlush, EXECUTION_STOP_OBSERVATION_STATES, `${field}.eventFlush`);
  requireGapForUncertain(eventFlush, base.gaps, `${field}.gaps`);
  return { ...base, eventFlush, manifestRef: nullableId(raw.manifestRef, `${field}.manifestRef`), finalSequence: nullableSafeInteger(raw.finalSequence, `${field}.finalSequence`) };
}
function observation(value: unknown, field: string): ExecutionStopDiagnosticObservation {
  return baseObservation(value, field);
}

export function validateExecutionStopDiagnostic(value: unknown): ExecutionStopDiagnostic {
  const raw = object(value, [
    'schemaVersion', 'kind', 'identity', 'operation', 'source', 'reason', 'status', 'budget', 'timing',
    'escalation', 'exit', 'observations', 'followUp', 'gaps',
  ], 'diagnostic');
  if (raw.schemaVersion !== EXECUTION_STOP_DIAGNOSTIC_SCHEMA_VERSION || raw.kind !== EXECUTION_STOP_DIAGNOSTIC_KIND) {
    throw validationError(context, 'diagnostic', '不支持的 schemaVersion 或 kind');
  }
  const identity = object(raw.identity, [
    'projectId', 'runId', 'batchId', 'attemptId', 'sessionId', 'toolCallId', 'checkKey', 'commandId',
    'owner', 'hostInstanceId', 'executionVersion', 'processIdentity',
  ], 'diagnostic.identity');
  const operation = object(raw.operation, ['operationId', 'requestedAtUtc', 'observedAtUtc', 'observedOnHostInstanceId'], 'diagnostic.operation');
  const budget = object(raw.budget, ['layer', 'limitMs', 'elapsedMs', 'deadlineUtc'], 'diagnostic.budget');
  const timing = object(raw.timing, ['lastActivityAtUtc', 'lastActivityKind', 'gracefulRequestedAtUtc', 'forcedAtUtc'], 'diagnostic.timing');
  const escalation = object(raw.escalation, ['graceful', 'forced'], 'diagnostic.escalation');
  const exit = object(raw.exit, ['exitCode', 'signal', 'reason', 'forced'], 'diagnostic.exit');
  const observations = object(raw.observations, ['process', 'sdkRuntime', 'verifier', 'recording', 'workResource', 'lease'], 'diagnostic.observations');
  const followUp = object(raw.followUp, ['allowed', 'blocked'], 'diagnostic.followUp');
  const source = enumValue(raw.source, EXECUTION_STOP_SOURCES, 'diagnostic.source');
  const reason = enumValue(raw.reason, EXECUTION_STOP_REASONS, 'diagnostic.reason');
  const status = enumValue(raw.status, EXECUTION_STOP_OBSERVATION_STATES, 'diagnostic.status');
  const budgetLayer = budget.layer === null ? null : enumValue(budget.layer, EXECUTION_STOP_BUDGET_LAYERS, 'diagnostic.budget.layer');
  const limitMs = nullableSafeInteger(budget.limitMs, 'diagnostic.budget.limitMs');
  const elapsedMs = nullableSafeInteger(budget.elapsedMs, 'diagnostic.budget.elapsedMs');
  if (source === 'timeout' && budgetLayer === null) throw validationError(context, 'diagnostic.budget.layer', 'timeout 必须关联预算层级');
  const identityResult: ExecutionStopDiagnosticIdentity = {
    projectId: validateStableId(identity.projectId, context, 'diagnostic.identity.projectId'),
    runId: validateStableId(identity.runId, context, 'diagnostic.identity.runId'),
    batchId: validateStableId(identity.batchId, context, 'diagnostic.identity.batchId'),
    attemptId: nullableId(identity.attemptId, 'diagnostic.identity.attemptId'),
    sessionId: nullableId(identity.sessionId, 'diagnostic.identity.sessionId'),
    toolCallId: nullableId(identity.toolCallId, 'diagnostic.identity.toolCallId'),
    checkKey: nullableId(identity.checkKey, 'diagnostic.identity.checkKey'),
    commandId: nullableId(identity.commandId, 'diagnostic.identity.commandId'),
    owner: nullableId(identity.owner, 'diagnostic.identity.owner'),
    hostInstanceId: nullableId(identity.hostInstanceId, 'diagnostic.identity.hostInstanceId'),
    executionVersion: nullableSafeInteger(identity.executionVersion, 'diagnostic.identity.executionVersion'),
    processIdentity: processIdentity(identity.processIdentity, 'diagnostic.identity.processIdentity'),
  };
  if (identityResult.executionVersion === 0) throw validationError(context, 'diagnostic.identity.executionVersion', '必须为正整数或 null');
  const operationResult: ExecutionStopDiagnosticOperation = {
    operationId: validateStableId(operation.operationId, context, 'diagnostic.operation.operationId'),
    requestedAtUtc: iso(operation.requestedAtUtc, 'diagnostic.operation.requestedAtUtc'),
    observedAtUtc: iso(operation.observedAtUtc, 'diagnostic.operation.observedAtUtc'),
    observedOnHostInstanceId: nullableId(operation.observedOnHostInstanceId, 'diagnostic.operation.observedOnHostInstanceId'),
  };
  const timingResult: ExecutionStopDiagnosticTiming = {
    lastActivityAtUtc: nullableIso(timing.lastActivityAtUtc, 'diagnostic.timing.lastActivityAtUtc'),
    lastActivityKind: nullableText(timing.lastActivityKind, 'diagnostic.timing.lastActivityKind'),
    gracefulRequestedAtUtc: nullableIso(timing.gracefulRequestedAtUtc, 'diagnostic.timing.gracefulRequestedAtUtc'),
    forcedAtUtc: nullableIso(timing.forcedAtUtc, 'diagnostic.timing.forcedAtUtc'),
  };
  const exitCode = nullableSafeInteger(exit.exitCode, 'diagnostic.exit.exitCode');
  if (exitCode !== null && exitCode > 255) throw validationError(context, 'diagnostic.exit.exitCode', '必须在 0..255');
  const gapsResult = gaps(raw.gaps, 'diagnostic.gaps');
  requireGapForUncertain(status, gapsResult, 'diagnostic.gaps');
  const process = processObservation(observations.process, 'diagnostic.observations.process');
  const sdkRuntime = runtimeObservation(observations.sdkRuntime, 'diagnostic.observations.sdkRuntime');
  const verifier = observation(observations.verifier, 'diagnostic.observations.verifier');
  const recording = recordingObservation(observations.recording, 'diagnostic.observations.recording');
  const workResource = observation(observations.workResource, 'diagnostic.observations.workResource');
  const lease = observation(observations.lease, 'diagnostic.observations.lease');
  const allowed = gaps(followUp.allowed, 'diagnostic.followUp.allowed');
  const blocked = gaps(followUp.blocked, 'diagnostic.followUp.blocked');
  if (status === 'unconfirmed' || status === 'quarantined' || status === 'unknown') {
    for (const action of EXECUTION_STOP_REQUIRED_BLOCKED_ACTIONS) {
      if (!blocked.includes(action)) throw validationError(context, 'diagnostic.followUp.blocked', `状态 ${status} 必须阻止 ${action}`);
    }
  }
  const escalationResult: ExecutionStopDiagnosticEscalation = {
    graceful: enumValue(escalation.graceful, EXECUTION_STOP_PHASES, 'diagnostic.escalation.graceful'),
    forced: enumValue(escalation.forced, EXECUTION_STOP_PHASES, 'diagnostic.escalation.forced'),
  };
  return {
    schemaVersion: EXECUTION_STOP_DIAGNOSTIC_SCHEMA_VERSION,
    kind: EXECUTION_STOP_DIAGNOSTIC_KIND,
    identity: identityResult,
    operation: operationResult,
    source,
    reason,
    status,
    budget: { layer: budgetLayer, limitMs, elapsedMs, deadlineUtc: nullableIso(budget.deadlineUtc, 'diagnostic.budget.deadlineUtc') },
    timing: timingResult,
    escalation: escalationResult,
    exit: { exitCode, signal: nullableText(exit.signal, 'diagnostic.exit.signal', 64), reason: nullableText(exit.reason, 'diagnostic.exit.reason', 128), forced: nullableBoolean(exit.forced, 'diagnostic.exit.forced') },
    observations: { process, sdkRuntime, verifier, recording, workResource, lease },
    followUp: { allowed, blocked },
    gaps: gapsResult,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * 记录一次 operation 的首次诊断事实。重复读取返回同一个 entry；迟到结果和跨
 * Host 重放只产生 disposition，不修改首次证据或递增结算。调用方应把返回 entry
 * 作为唯一可持久化事实，并以 operationId 做数据库唯一键/CAS。
 */
export function createExecutionStopDiagnosticLedger(): {
  readonly read: (operationId: unknown) => ExecutionStopDiagnosticLedgerEntry | null;
  readonly record: (value: unknown) => ExecutionStopDiagnosticRecordResult;
} {
  const entries = new Map<string, ExecutionStopDiagnosticLedgerEntry>();
  return {
    read(operationId: unknown): ExecutionStopDiagnosticLedgerEntry | null {
      if (typeof operationId !== 'string') throw new TypeError('operationId must be a string');
      return entries.get(operationId) ?? null;
    },
    record(value: unknown): ExecutionStopDiagnosticRecordResult {
      const diagnostic = validateExecutionStopDiagnostic(value);
      const operationId = diagnostic.operation.operationId;
      const existing = entries.get(operationId);
      if (existing !== undefined) {
        const sameIdentity = existing.diagnostic.identity.projectId === diagnostic.identity.projectId
          && existing.diagnostic.identity.runId === diagnostic.identity.runId
          && existing.diagnostic.identity.batchId === diagnostic.identity.batchId
          && existing.diagnostic.identity.attemptId === diagnostic.identity.attemptId
          && existing.diagnostic.identity.sessionId === diagnostic.identity.sessionId
          && existing.diagnostic.identity.toolCallId === diagnostic.identity.toolCallId
          && existing.diagnostic.identity.checkKey === diagnostic.identity.checkKey
          && existing.diagnostic.identity.commandId === diagnostic.identity.commandId;
        if (!sameIdentity) return { disposition: 'conflict', entry: existing };
        return { disposition: JSON.stringify(existing.diagnostic) === JSON.stringify(diagnostic) ? 'replayed' : 'ignored_late', entry: existing };
      }
      const entry: ExecutionStopDiagnosticLedgerEntry = deepFreeze({
        operationId,
        firstObservedAtUtc: diagnostic.operation.observedAtUtc,
        revision: 1,
        diagnostic,
      });
      entries.set(operationId, entry);
      return { disposition: 'accepted', entry };
    },
  };
}

/** 纯函数版本，适合持久化适配器在 CAS 事务中使用。 */
export function recordExecutionStopDiagnostic(
  existing: ExecutionStopDiagnosticLedgerEntry | null,
  value: unknown,
): ExecutionStopDiagnosticRecordResult {
  const diagnostic = validateExecutionStopDiagnostic(value);
  if (existing === null) {
    return {
      disposition: 'accepted',
      entry: deepFreeze({ operationId: diagnostic.operation.operationId, firstObservedAtUtc: diagnostic.operation.observedAtUtc, revision: 1, diagnostic }),
    };
  }
  const sameIdentity = existing.operationId === diagnostic.operation.operationId
    && existing.diagnostic.identity.projectId === diagnostic.identity.projectId
    && existing.diagnostic.identity.runId === diagnostic.identity.runId
    && existing.diagnostic.identity.batchId === diagnostic.identity.batchId
    && existing.diagnostic.identity.attemptId === diagnostic.identity.attemptId
    && existing.diagnostic.identity.sessionId === diagnostic.identity.sessionId
    && existing.diagnostic.identity.toolCallId === diagnostic.identity.toolCallId
    && existing.diagnostic.identity.checkKey === diagnostic.identity.checkKey
    && existing.diagnostic.identity.commandId === diagnostic.identity.commandId;
  if (!sameIdentity) return { disposition: 'conflict', entry: existing };
  return { disposition: JSON.stringify(existing.diagnostic) === JSON.stringify(diagnostic) ? 'replayed' : 'ignored_late', entry: existing };
}

export function isExecutionStopDiagnostic(value: unknown): value is ExecutionStopDiagnostic {
  try { validateExecutionStopDiagnostic(value); return true; } catch { return false; }
}
