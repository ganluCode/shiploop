/** P05-8 / F-003 GitAgent Runtime narrow contract.
 *
 * This port carries an already authorized, immutable repair request into a
 * supervised runtime. It deliberately has no Core store, Git, approval, budget,
 * lock, or commit capability.
 */
import { createHash } from 'node:crypto';
import type { GitAgentRepairRequest, GitAgentRepairRuntimeUsage } from './git-agent-repair.js';
import { validateGitAgentRepairRequest } from './git-agent-repair.js';
import type { GitAgentRepairClaim } from './git-agent-repair-store.js';
import {
  rejectUnknownKeys, requirePlainObject, validateNonNegativeInteger, validateSha256Digest,
  validateStableId, validationError, type ValidationContext,
} from './validation.js';

function envelopeDigest(authorization: GitAgentRepairRequest, execution: GitAgentRuntimeExecutionIdentity): string {
  return createHash('sha256').update(JSON.stringify({ authorization, execution }), 'utf8').digest('hex');
}

export const GIT_AGENT_RUNTIME_SCHEMA_VERSION = 1 as const;
export const GIT_AGENT_RUNTIME_MAX_CHANGED_PATHS = 512;

export type GitAgentRuntimeTerminal = 'completed' | 'no_change' | 'invalid' | 'failed'
  | 'cancelled' | 'timed_out' | 'process_exited';
export type GitAgentRuntimeFailureClass = 'invalid' | 'out_of_scope' | 'runtime'
  | 'process_exited' | 'stop_unconfirmed' | null;

export interface GitAgentRuntimeExecutionIdentity {
  readonly attemptId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly ownerId: string;
  readonly hostInstanceId: string;
}

/** Core frozen context. The request itself is the authorization snapshot. */
export interface GitAgentRuntimeRequest {
  readonly schemaVersion: typeof GIT_AGENT_RUNTIME_SCHEMA_VERSION;
  readonly authorization: GitAgentRepairRequest;
  readonly execution: GitAgentRuntimeExecutionIdentity;
  readonly requestDigest: string;
}

export interface GitAgentRuntimeVerification {
  readonly strategyId: string;
  readonly strategyDigest: string;
  /** Raw bounded verification evidence; never an approval or passed flag. */
  readonly outputDigest: string | null;
  readonly exitCode: number | null;
}

export interface GitAgentRuntimeFailure {
  readonly classification: Exclude<GitAgentRuntimeFailureClass, null>;
  readonly code: string;
}

export interface GitAgentRuntimeStop {
  readonly confirmed: boolean;
  readonly detail: string | null;
}

export interface GitAgentRuntimeResult {
  readonly schemaVersion: typeof GIT_AGENT_RUNTIME_SCHEMA_VERSION;
  readonly repairId: string;
  readonly terminal: GitAgentRuntimeTerminal;
  readonly execution: GitAgentRuntimeExecutionIdentity;
  readonly changedPaths: readonly string[];
  readonly verification: GitAgentRuntimeVerification;
  readonly usage: GitAgentRepairRuntimeUsage;
  readonly failure: GitAgentRuntimeFailure | null;
  readonly stop: GitAgentRuntimeStop;
}

export interface GitAgentRuntimeHandle {
  readonly result: Promise<GitAgentRuntimeResult>;
  readonly stopped: Promise<GitAgentRuntimeStop>;
  cancel(): Promise<{ readonly accepted: boolean; readonly reason: string | null }>;
}

export interface GitAgentRuntimeAdapter {
  start(request: GitAgentRuntimeRequest): Promise<GitAgentRuntimeHandle>;
}

const CONTEXT: ValidationContext = { operation: 'GitAgentRuntime' };
const TERMINALS: readonly GitAgentRuntimeTerminal[] = [
  'completed', 'no_change', 'invalid', 'failed', 'cancelled', 'timed_out', 'process_exited',
];
const FAILURE_CLASSES: readonly Exclude<GitAgentRuntimeFailureClass, null>[] = [
  'invalid', 'out_of_scope', 'runtime', 'process_exited', 'stop_unconfirmed',
];
const PATH_TOKEN = /^[^/\\\u0000]+(?:\/[^/\\\u0000]+)*$/;
const CODE_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;

function fail(field: string, reason: string): never {
  throw validationError(CONTEXT, field, reason);
}

function path(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !PATH_TOKEN.test(value)
    || value.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)) {
    fail(field, 'invalid_relative_path');
  }
  return value;
}

function nullableDigest(value: unknown, field: string): string | null {
  return value === null ? null : validateSha256Digest(value, CONTEXT, field);
}

function execution(value: unknown, field: string): GitAgentRuntimeExecutionIdentity {
  const raw = requirePlainObject(value, CONTEXT, field);
  rejectUnknownKeys(raw, ['attemptId', 'invocationId', 'executionVersion', 'ownerId', 'hostInstanceId'], CONTEXT, field);
  const executionVersion = raw.executionVersion;
  if (typeof executionVersion !== 'number' || !Number.isSafeInteger(executionVersion) || executionVersion < 1) {
    fail(`${field}.executionVersion`, 'invalid_execution_version');
  }
  return Object.freeze({
    attemptId: validateStableId(raw.attemptId, CONTEXT, `${field}.attemptId`),
    invocationId: validateStableId(raw.invocationId, CONTEXT, `${field}.invocationId`),
    executionVersion,
    ownerId: validateStableId(raw.ownerId, CONTEXT, `${field}.ownerId`),
    hostInstanceId: validateStableId(raw.hostInstanceId, CONTEXT, `${field}.hostInstanceId`),
  });
}

function cloneFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) cloneFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertClaim(request: GitAgentRepairRequest, claim: GitAgentRepairClaim): void {
  if (claim.projectId !== request.projectId || claim.repairId !== request.repairId) fail('execution', 'claim_identity_mismatch');
  validateStableId(claim.attemptId, CONTEXT, 'execution.attemptId');
  validateStableId(claim.ownerId, CONTEXT, 'execution.ownerId');
  validateStableId(claim.hostInstanceId, CONTEXT, 'execution.hostInstanceId');
  if (!Number.isSafeInteger(claim.authorizationVersion) || claim.authorizationVersion < 1) {
    fail('execution.authorizationVersion', 'invalid_authorization_version');
  }
}

export function createGitAgentRuntimeRequest(input: {
  readonly authorization: unknown;
  readonly claim: GitAgentRepairClaim;
  readonly invocationId: unknown;
  readonly executionVersion: unknown;
}): GitAgentRuntimeRequest {
  const authorization = validateGitAgentRepairRequest(input.authorization, { nowUtcMs: 0 });
  assertClaim(authorization, input.claim);
  const invocationId = validateStableId(input.invocationId, CONTEXT, 'execution.invocationId');
  if (typeof input.executionVersion !== 'number' || !Number.isSafeInteger(input.executionVersion) || input.executionVersion < 1) {
    fail('execution.executionVersion', 'invalid_execution_version');
  }
  const executionValue = Object.freeze({
    attemptId: input.claim.attemptId,
    invocationId,
    executionVersion: input.executionVersion,
    ownerId: input.claim.ownerId,
    hostInstanceId: input.claim.hostInstanceId,
  });
  return cloneFreeze({ schemaVersion: GIT_AGENT_RUNTIME_SCHEMA_VERSION, authorization, execution: executionValue,
    requestDigest: envelopeDigest(authorization, executionValue) });
}

export function validateGitAgentRuntimeRequest(value: unknown): GitAgentRuntimeRequest {
  const raw = requirePlainObject(value, CONTEXT, 'request');
  rejectUnknownKeys(raw, ['schemaVersion', 'authorization', 'execution', 'requestDigest'], CONTEXT, 'request');
  if (raw.schemaVersion !== GIT_AGENT_RUNTIME_SCHEMA_VERSION) fail('schemaVersion', 'unsupported_schema_version');
  const authorization = validateGitAgentRepairRequest(raw.authorization, { nowUtcMs: 0 });
  const executionValue = execution(raw.execution, 'execution');
  if (raw.requestDigest !== envelopeDigest(authorization, executionValue)) fail('requestDigest', 'request_digest_mismatch');
  return cloneFreeze({ schemaVersion: GIT_AGENT_RUNTIME_SCHEMA_VERSION, authorization, execution: executionValue,
    requestDigest: raw.requestDigest });
}

export function validateGitAgentRuntimeResult(value: unknown, request: GitAgentRuntimeRequest): GitAgentRuntimeResult {
  const raw = requirePlainObject(value, CONTEXT, 'result');
  rejectUnknownKeys(raw, ['schemaVersion', 'repairId', 'terminal', 'execution', 'changedPaths', 'verification', 'usage', 'failure', 'stop'], CONTEXT, 'result');
  if (raw.schemaVersion !== GIT_AGENT_RUNTIME_SCHEMA_VERSION) fail('result.schemaVersion', 'unsupported_schema_version');
  const repairId = validateStableId(raw.repairId, CONTEXT, 'result.repairId');
  if (repairId !== request.authorization.repairId) fail('result.repairId', 'repair_identity_mismatch');
  if (!TERMINALS.includes(raw.terminal as GitAgentRuntimeTerminal)) fail('result.terminal', 'invalid_terminal');
  const resultExecution = execution(raw.execution, 'result.execution');
  if (JSON.stringify(resultExecution) !== JSON.stringify(request.execution)) fail('result.execution', 'execution_identity_mismatch');
  if (!Array.isArray(raw.changedPaths) || raw.changedPaths.length > GIT_AGENT_RUNTIME_MAX_CHANGED_PATHS) fail('result.changedPaths', 'invalid_changed_paths');
  const changedPaths = raw.changedPaths.map((item, index) => path(item, `result.changedPaths[${index}]`));
  if (new Set(changedPaths).size !== changedPaths.length) fail('result.changedPaths', 'duplicate_path');
  if (changedPaths.some(item => !request.authorization.writablePaths.includes(item))) fail('result.changedPaths', 'path_outside_authorized_scope');
  const verificationRaw = requirePlainObject(raw.verification, CONTEXT, 'result.verification');
  rejectUnknownKeys(verificationRaw, ['strategyId', 'strategyDigest', 'outputDigest', 'exitCode'], CONTEXT, 'result.verification');
  const verification = Object.freeze({
    strategyId: validateStableId(verificationRaw.strategyId, CONTEXT, 'result.verification.strategyId'),
    strategyDigest: validateSha256Digest(verificationRaw.strategyDigest, CONTEXT, 'result.verification.strategyDigest'),
    outputDigest: nullableDigest(verificationRaw.outputDigest, 'result.verification.outputDigest'),
    exitCode: verificationRaw.exitCode === null ? null : validateNonNegativeInteger(verificationRaw.exitCode, CONTEXT, 'result.verification.exitCode'),
  });
  if (verification.strategyId !== request.authorization.verification.strategyId
    || verification.strategyDigest !== request.authorization.verification.digest) fail('result.verification', 'verification_identity_mismatch');
  const usageRaw = requirePlainObject(raw.usage, CONTEXT, 'result.usage');
  rejectUnknownKeys(usageRaw, ['consumedTokens', 'runtimeMs'], CONTEXT, 'result.usage');
  const usage = Object.freeze({
    consumedTokens: validateNonNegativeInteger(usageRaw.consumedTokens, CONTEXT, 'result.usage.consumedTokens'),
    runtimeMs: validateNonNegativeInteger(usageRaw.runtimeMs, CONTEXT, 'result.usage.runtimeMs'),
  });
  if (usage.consumedTokens > request.authorization.budget.remainingTokens || usage.runtimeMs > request.authorization.budget.remainingRuntimeMs) fail('result.usage', 'budget_exhausted');
  let failure: GitAgentRuntimeFailure | null = null;
  if (raw.failure !== null) {
    const failureRaw = requirePlainObject(raw.failure, CONTEXT, 'result.failure');
    rejectUnknownKeys(failureRaw, ['classification', 'code'], CONTEXT, 'result.failure');
    if (!FAILURE_CLASSES.includes(failureRaw.classification as Exclude<GitAgentRuntimeFailureClass, null>)) fail('result.failure.classification', 'invalid_failure_class');
    if (typeof failureRaw.code !== 'string' || !CODE_TOKEN.test(failureRaw.code)) fail('result.failure.code', 'invalid_failure_code');
    failure = Object.freeze({ classification: failureRaw.classification as Exclude<GitAgentRuntimeFailureClass, null>, code: failureRaw.code });
  }
  const stopRaw = requirePlainObject(raw.stop, CONTEXT, 'result.stop');
  rejectUnknownKeys(stopRaw, ['confirmed', 'detail'], CONTEXT, 'result.stop');
  if (typeof stopRaw.confirmed !== 'boolean') fail('result.stop.confirmed', 'invalid_stop_confirmation');
  const stop = Object.freeze({ confirmed: stopRaw.confirmed, detail: stopRaw.detail === null ? null : String(stopRaw.detail) });
  return cloneFreeze({
    schemaVersion: GIT_AGENT_RUNTIME_SCHEMA_VERSION,
    repairId,
    terminal: raw.terminal as GitAgentRuntimeTerminal,
    execution: resultExecution,
    changedPaths,
    verification,
    usage,
    failure,
    stop,
  });
}

/** Adapt only supervised Runtime facts to the existing Core settlement shape. */
export function toGitAgentRepairRuntimeOutput(result: GitAgentRuntimeResult): import('./git-agent-repair.js').GitAgentRepairRuntimeOutput {
  const status = result.terminal === 'completed'
    ? (result.changedPaths.length === 0 ? 'no_change' : 'modified')
    : result.terminal === 'no_change' ? 'no_change'
      : result.terminal === 'cancelled' ? 'cancelled' : 'failed';
  return Object.freeze({
    schemaVersion: 1,
    repairId: result.repairId,
    status,
    changedPaths: [...result.changedPaths],
    usage: { ...result.usage },
    failureCode: result.failure?.code ?? (result.stop.confirmed ? null : 'stop_unconfirmed'),
  });
}
