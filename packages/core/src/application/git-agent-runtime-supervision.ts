/** P05-8 / F-003 supervision boundary for GitAgent Runtime. */
import { RuntimeError } from '../ports/runtime-execution.js';
import {
  validateGitAgentRuntimeRequest, validateGitAgentRuntimeResult,
} from '../ports/git-agent-runtime.js';
import type {
  GitAgentRuntimeAdapter, GitAgentRuntimeRequest, GitAgentRuntimeResult, GitAgentRuntimeStop,
} from '../ports/git-agent-runtime.js';

export type GitAgentSupervisionControl = 'cancelled' | 'timed_out' | null;
export interface GitAgentSupervisionCompletion {
  readonly result: GitAgentRuntimeResult;
  readonly stop: GitAgentRuntimeStop;
  readonly control: GitAgentSupervisionControl;
  /** Unconfirmed stop keeps the workspace quarantined for the caller. */
  readonly isolated: boolean;
  readonly candidateDelivered: boolean;
}

export interface GitAgentSupervisionOptions {
  readonly timeoutMs?: number;
  readonly stopWaitMs?: number;
  readonly onCandidate?: (result: GitAgentRuntimeResult) => Promise<void>;
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

function startFailure(request: GitAgentRuntimeRequest, error: unknown): GitAgentRuntimeResult {
  const reason = error instanceof RuntimeError ? error.reason : 'runtime_start_failed';
  return {
    schemaVersion: 1,
    repairId: request.authorization.repairId,
    terminal: 'failed',
    execution: request.execution,
    changedPaths: [],
    verification: {
      strategyId: request.authorization.verification.strategyId,
      strategyDigest: request.authorization.verification.digest,
      outputDigest: null,
      exitCode: null,
    },
    usage: { consumedTokens: 0, runtimeMs: 0 },
    failure: { classification: 'runtime', code: reason.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 64) || 'runtime_start_failed' },
    stop: { confirmed: true, detail: 'runtime_not_started' },
  };
}

function invalidRuntimeResult(request: GitAgentRuntimeRequest): GitAgentRuntimeResult {
  return {
    schemaVersion: 1, repairId: request.authorization.repairId, terminal: 'invalid', execution: request.execution,
    changedPaths: [],
    verification: { strategyId: request.authorization.verification.strategyId, strategyDigest: request.authorization.verification.digest, outputDigest: null, exitCode: null },
    usage: { consumedTokens: 0, runtimeMs: 0 },
    failure: { classification: 'invalid', code: 'invalid_runtime_output' },
    stop: { confirmed: false, detail: 'invalid_runtime_output' },
  };
}

function raceResult(promise: Promise<GitAgentRuntimeResult>, ms: number): Promise<{ readonly timedOut: true } | { readonly timedOut: false; readonly result: GitAgentRuntimeResult }> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    void promise.then(result => { clearTimeout(timer); resolve({ timedOut: false, result }); });
  });
}

/** Starts one admitted Attempt and never writes Core state or releases resources. */
export async function superviseGitAgentRuntime(
  adapter: GitAgentRuntimeAdapter,
  rawRequest: unknown,
  options: GitAgentSupervisionOptions = {},
): Promise<GitAgentSupervisionCompletion> {
  const request = validateGitAgentRuntimeRequest(rawRequest);
  const timeoutMs = options.timeoutMs ?? request.authorization.budget.remainingRuntimeMs;
  const stopWaitMs = options.stopWaitMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > request.authorization.budget.remainingRuntimeMs) throw new TypeError('GitAgent supervision timeout exceeds authorized budget');
  if (!Number.isSafeInteger(stopWaitMs) || stopWaitMs < 1) throw new TypeError('GitAgent supervision stopWaitMs must be positive');

  let handle;
  try {
    handle = await adapter.start(request);
  } catch (error) {
    const result = startFailure(request, error);
    return { result, stop: result.stop, control: null, isolated: false, candidateDelivered: false };
  }

  let control: GitAgentSupervisionControl = null;
  const resultPromise = handle.result.then(value => {
    try { return validateGitAgentRuntimeResult(value, request); }
    catch { return invalidRuntimeResult(request); }
  }, () => invalidRuntimeResult(request));
  const outcome = await raceResult(resultPromise, timeoutMs);
  if (outcome.timedOut) {
    control = 'timed_out';
    await handle.cancel().catch(() => undefined);
  }
  const result = outcome.timedOut
    ? await timeout(resultPromise, stopWaitMs)
      ?? {
        schemaVersion: 1, repairId: request.authorization.repairId, terminal: 'timed_out' as const,
        execution: request.execution, changedPaths: [],
        verification: { strategyId: request.authorization.verification.strategyId, strategyDigest: request.authorization.verification.digest, outputDigest: null, exitCode: null },
        usage: { consumedTokens: 0, runtimeMs: 0 }, failure: { classification: 'runtime' as const, code: 'timeout' }, stop: { confirmed: false, detail: 'result_unobserved' },
      }
    : outcome.result;
  const stop = await timeout(handle.stopped, stopWaitMs) ?? { confirmed: false, detail: 'stop_unobserved' };
  const isolated = !stop.confirmed || !result.stop.confirmed;
  const candidate = !isolated && control === null && (result.terminal === 'completed' || result.terminal === 'no_change');
  if (candidate) await options.onCandidate?.(result);
  return { result, stop, control, isolated, candidateDelivered: candidate };
}
