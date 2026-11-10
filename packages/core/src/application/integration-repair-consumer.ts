import type { GitAgentRuntimeAdapter, GitAgentRuntimeRequest } from '../ports/git-agent-runtime.js';
import { createGitAgentRuntimeRequest, toGitAgentRepairRuntimeOutput } from '../ports/git-agent-runtime.js';
import { superviseGitAgentRuntime } from './git-agent-runtime-supervision.js';
import type { IntegrationRepairAttemptRecord } from '../ports/integration-repair-attempt.js';
import { createGitAgentRepairRequest } from '../ports/git-agent-repair.js';
import type { GitAgentRepairRuntimeOutput } from '../ports/git-agent-repair.js';
import type { GitAgentCandidateFinalizationService, GitAgentCandidateFinalizationResult } from './git-agent-candidate-finalization.js';

export type IntegrationRepairConsumeResult =
  | { readonly outcome: 'candidate'; readonly replayed: boolean; readonly attempt: IntegrationRepairAttemptRecord }
  | { readonly outcome: 'blocked'; readonly reason: string; readonly attempt: IntegrationRepairAttemptRecord | null };

export function createIntegrationRepairConsumer(deps: {
  readonly store: {
    claim(): { attempt: IntegrationRepairAttemptRecord; fresh: boolean };
    read(): IntegrationRepairAttemptRecord;
    bind(request: GitAgentRuntimeRequest): IntegrationRepairAttemptRecord;
    settle(output: unknown, stopped: boolean): IntegrationRepairAttemptRecord;
  };
  readonly runtime: GitAgentRuntimeAdapter;
  readonly assertCurrent: () => Promise<void>;
  readonly onCandidate: (result: GitAgentRepairRuntimeOutput, attempt: IntegrationRepairAttemptRecord) => Promise<void>;
  readonly nowUtcMs?: () => number;
}) {
  return { async consume(): Promise<IntegrationRepairConsumeResult> {
    await deps.assertCurrent();
    const admission = deps.store.claim();
    let attempt = admission.attempt;
    if (attempt.output !== null && attempt.stoppedAtUtcMs !== null) {
      if (attempt.output.failureCode !== null || !['modified', 'no_change'].includes(attempt.output.status)) return { outcome: 'blocked', reason: attempt.output.failureCode ?? 'runtime_not_successful', attempt };
      await deps.onCandidate(attempt.output, attempt);
      return { outcome: 'candidate', replayed: true, attempt };
    }
    if (!admission.fresh) return { outcome: 'blocked', reason: 'stop_unconfirmed', attempt };
    await deps.assertCurrent();
    const { schemaVersion: _schema, authorizationDigest: _auth, commandDigest: _cmd, ...body } = attempt.request;
    const remaining = attempt.deadlineUtcMs - (deps.nowUtcMs ?? Date.now)();
    if (remaining <= 0) return { outcome: 'blocked', reason: 'budget_exhausted', attempt };
    const authorization = createGitAgentRepairRequest({ ...body, budget: { remainingAttempts: 1,
      remainingTokens: attempt.maxTokens, remainingRuntimeMs: Math.min(attempt.maxRuntimeMs, remaining), deadlineUtcMs: attempt.deadlineUtcMs } }, {nowUtcMs:(deps.nowUtcMs ?? Date.now)()});
    const request = createGitAgentRuntimeRequest({ authorization, claim: {
      projectId: attempt.projectId, repairId: attempt.repairId, attemptId: attempt.attemptId, ownerId: attempt.ownerId, hostInstanceId: attempt.hostInstanceId,
      authorizationVersion: attempt.executionVersion,
    }, invocationId: `${attempt.attemptId}-invocation`, executionVersion: attempt.executionVersion });
    attempt = deps.store.bind(request);
    const completion = await superviseGitAgentRuntime(deps.runtime, request, { timeoutMs: authorization.budget.remainingRuntimeMs, stopWaitMs: 250 });
    const mapped = toGitAgentRepairRuntimeOutput(completion.result);
    const output = completion.control === null ? mapped : { ...mapped,
      status: completion.control === 'cancelled' ? 'cancelled' as const : 'failed' as const,
      failureCode: completion.control === 'cancelled' ? 'cancelled' : 'deadline_exceeded' };
    attempt = deps.store.settle(output, completion.stop.confirmed && completion.result.stop.confirmed);
    if (!completion.candidateDelivered || attempt.stoppedAtUtcMs === null) return { outcome: 'blocked', reason: completion.stop.confirmed ? (output.failureCode ?? 'runtime_not_successful') : 'stop_unconfirmed', attempt };
    await deps.assertCurrent();
    await deps.onCandidate(output, attempt);
    return { outcome: 'candidate', replayed: false, attempt };
  } };
}

/** The production-facing result is the Core finalizer conclusion, never Runtime's candidate status. */
export function createIntegrationRepairFinalizationConsumer(deps:
  Omit<Parameters<typeof createIntegrationRepairConsumer>[0],'onCandidate'> & {readonly candidates: GitAgentCandidateFinalizationService}) {
  return {async consume(): Promise<GitAgentCandidateFinalizationResult & {readonly replayed:boolean}> {
    let finalization: GitAgentCandidateFinalizationResult | undefined;
    const consumer = createIntegrationRepairConsumer({...deps,onCandidate:async(_output,attempt)=>{
      finalization = await deps.candidates.finalize({projectId:attempt.projectId,repairId:attempt.repairId,attemptId:attempt.attemptId});
    }});
    const result = await consumer.consume();
    if (result.outcome === 'blocked') return {outcome:'blocked',reason:result.reason,operation:null,successorUnlocked:false,replayed:false};
    if (!finalization) throw new TypeError('Integration repair candidate was not finalized');
    return {...finalization,replayed:result.replayed};
  }};
}
