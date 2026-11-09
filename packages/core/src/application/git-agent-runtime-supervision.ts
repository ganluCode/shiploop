/** P05-8 / F-003 supervision boundary for GitAgent Runtime. */
import { RuntimeError } from '../ports/runtime-execution.js';
import { validateGitAgentRuntimeRequest, validateGitAgentRuntimeResult } from '../ports/git-agent-runtime.js';
import type { GitAgentRuntimeAdapter, GitAgentRuntimeHandle, GitAgentRuntimeRequest,
  GitAgentRuntimeResult, GitAgentRuntimeStop } from '../ports/git-agent-runtime.js';

export type GitAgentSupervisionControl = 'cancelled' | 'timed_out' | null;
export interface GitAgentSupervisionCompletion {
  readonly result: GitAgentRuntimeResult;
  readonly stop: GitAgentRuntimeStop;
  readonly control: GitAgentSupervisionControl;
  readonly isolated: boolean;
  readonly candidateDelivered: boolean;
  readonly hold: { readonly code: 'stop_unconfirmed'; readonly execution: GitAgentRuntimeRequest['execution'] } | null;
}
export interface GitAgentSupervisionOptions {
  readonly timeoutMs?: number;
  readonly stopWaitMs?: number;
  readonly signal?: AbortSignal;
  readonly onCandidate?: (result: GitAgentRuntimeResult) => Promise<void>;
}
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}
function failure(request: GitAgentRuntimeRequest, code: string, terminal: GitAgentRuntimeResult['terminal'] = 'failed'): GitAgentRuntimeResult {
  return {
    schemaVersion: 1, repairId: request.authorization.repairId, terminal, execution: request.execution, changedPaths: [],
    verification: { strategyId: request.authorization.verification.strategyId, strategyDigest: request.authorization.verification.digest,
      outputDigest: null, exitCode: null },
    usage: { consumedTokens: 0, runtimeMs: 0 }, failure: { classification: terminal === 'invalid' ? 'invalid' : 'runtime', code },
    // A rejected/pending start can have spawned a process. Only an independent stop fact can prove otherwise.
    stop: { confirmed: false, detail: code },
  };
}

/** Starts one admitted Attempt and never writes Core state or releases resources. */
export async function superviseGitAgentRuntime(adapter: GitAgentRuntimeAdapter, rawRequest: unknown,
  options: GitAgentSupervisionOptions = {}): Promise<GitAgentSupervisionCompletion> {
  const request = validateGitAgentRuntimeRequest(rawRequest);
  const timeoutMs = options.timeoutMs ?? request.authorization.budget.remainingRuntimeMs;
  const stopWaitMs = options.stopWaitMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > request.authorization.budget.remainingRuntimeMs) throw new TypeError('GitAgent supervision timeout exceeds authorized budget');
  if (!Number.isSafeInteger(stopWaitMs) || stopWaitMs < 1) throw new TypeError('GitAgent supervision stopWaitMs must be positive');
  let interrupt!: (control: Exclude<GitAgentSupervisionControl, null>) => void;
  const interrupted = new Promise<Exclude<GitAgentSupervisionControl, null>>(resolve => { interrupt = resolve; });
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => interrupt('timed_out'), timeoutMs);
  const abort = () => interrupt('cancelled');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const complete = (result: GitAgentRuntimeResult, stop: GitAgentRuntimeStop, control: GitAgentSupervisionControl,
    candidateDelivered = false): GitAgentSupervisionCompletion => {
    const isolated = stop.confirmed !== true || result.stop.confirmed !== true;
    return { result, stop, control, isolated, candidateDelivered,
      hold: isolated ? { code: 'stop_unconfirmed', execution: request.execution } : null };
  };
  const cancel = (handle: GitAgentRuntimeHandle) => within(Promise.resolve().then(() => handle.cancel()), stopWaitMs);
  try {
    if (options.signal?.aborted) {
      const stop = { confirmed: true, detail: 'runtime_not_started' };
      return complete({ ...failure(request, 'cancelled', 'cancelled'), stop }, stop, 'cancelled');
    }
    const starting = Promise.resolve().then(() => adapter.start(request));
    const started = await Promise.race([
      starting.then(handle => ({ kind: 'started' as const, handle }), error => ({ kind: 'failed' as const, error })),
      interrupted.then(control => ({ kind: 'interrupted' as const, control })),
    ]);
    if (started.kind === 'failed') {
      const code = started.error instanceof RuntimeError && /^[a-z][a-z0-9_]{0,63}$/.test(started.error.reason)
        ? started.error.reason : 'runtime_start_failed';
      const result = failure(request, code);
      return complete(result, result.stop, null);
    }
    if (started.kind === 'interrupted') {
      // Observe and cancel late startup; never deliver its candidate after this caller is isolated.
      void starting.then(handle => {
        void handle?.result?.catch(() => undefined);
        void handle?.stopped?.catch(() => undefined);
        return handle && typeof handle.cancel === 'function' ? cancel(handle) : undefined;
      }).catch(() => undefined);
      const result = failure(request, 'start_unobserved', started.control);
      return complete(result, result.stop, started.control);
    }
    const handle = started.handle;
    if (!handle || typeof handle.result?.then !== 'function' || typeof handle.stopped?.then !== 'function' || typeof handle.cancel !== 'function') {
      const result = failure(request, 'invalid_runtime_handle', 'invalid');
      return complete(result, result.stop, null);
    }
    const resultPromise = Promise.resolve(handle.result).then(value => {
      try { return validateGitAgentRuntimeResult(value, request); }
      catch { return failure(request, 'invalid_runtime_output', 'invalid'); }
    }, () => failure(request, 'invalid_runtime_output', 'invalid'));
    const outcome = await Promise.race([
      resultPromise.then(result => ({ kind: 'result' as const, result })),
      interrupted.then(control => ({ kind: 'interrupted' as const, control })),
    ]);
    const control = options.signal?.aborted ? 'cancelled'
      : Date.now() >= deadline ? 'timed_out' : outcome.kind === 'interrupted' ? outcome.control : null;
    if (control) await cancel(handle);
    const result = outcome.kind === 'result' ? outcome.result
      : await within(resultPromise, stopWaitMs) ?? failure(request, 'result_unobserved', control!);
    if (result.terminal === 'invalid') await cancel(handle);
    const observed = await within(handle.stopped, stopWaitMs);
    const stop = observed && typeof observed.confirmed === 'boolean'
      ? { confirmed: observed.confirmed, detail: observed.confirmed ? null : 'stop_unconfirmed' }
      : { confirmed: false, detail: 'stop_unobserved' };
    const candidate = stop.confirmed && result.stop.confirmed && control === null
      && !options.signal?.aborted && result.failure === null && (result.terminal === 'completed' || result.terminal === 'no_change');
    if (candidate) await options.onCandidate?.(result);
    return complete(result, stop, control, candidate);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
