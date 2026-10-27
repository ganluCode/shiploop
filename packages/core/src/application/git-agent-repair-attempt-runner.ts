import type { GitAgentRepairClaim } from '../ports/git-agent-repair-store.js';
import type { GitAgentRepairRuntimeOutput } from '../ports/git-agent-repair.js';
import type { GitAgentRepairService } from './git-agent-repair.js';
import {
  superviseGitAgentRuntime,
  type GitAgentSupervisionOptions,
} from './git-agent-runtime-supervision.js';
import {
  toGitAgentRepairRuntimeOutput,
  type GitAgentRuntimeAdapter,
  type GitAgentRuntimeRequest,
} from '../ports/git-agent-runtime.js';

export interface GitAgentRepairAttemptRunnerDependencies {
  readonly repair: Pick<GitAgentRepairService, 'settle'>;
}

export interface GitAgentRepairAttemptRunnerOptions extends GitAgentSupervisionOptions {
  readonly repair: GitAgentRepairAttemptRunnerDependencies['repair'];
  readonly claim: GitAgentRepairClaim;
}

export interface GitAgentRepairAttemptRunResult {
  readonly replayed: boolean;
  readonly completion: Awaited<ReturnType<typeof superviseGitAgentRuntime>> | null;
  readonly output: GitAgentRepairRuntimeOutput | null;
  readonly settled: boolean;
}

function mappedOutput(completion: Awaited<ReturnType<typeof superviseGitAgentRuntime>>): GitAgentRepairRuntimeOutput {
  const output = toGitAgentRepairRuntimeOutput(completion.result);
  const failureCode = completion.control === 'timed_out' ? 'deadline_exceeded'
    : !completion.stop.confirmed || !completion.result.stop.confirmed ? 'stop_unconfirmed'
      : completion.result.failure?.code === 'budget_exhausted' ? 'budget_exhausted'
        : completion.result.failure?.code === 'cancelled' || completion.result.terminal === 'cancelled' ? 'cancelled'
          : output.failureCode;
  return Object.freeze({ ...output, failureCode });
}

/**
 * Runs one already admitted Attempt. A null admission is a durable replay signal;
 * callers must not start an adapter in that case. Settlement goes through the
 * existing store fence and is therefore safe against a late old-owner result.
 */
export async function runGitAgentRepairAttempt(
  adapter: GitAgentRuntimeAdapter,
  request: GitAgentRuntimeRequest,
  admission: ReturnType<GitAgentRepairService['claim']>,
  options: GitAgentRepairAttemptRunnerOptions,
): Promise<GitAgentRepairAttemptRunResult> {
  if (admission === null) return { replayed: true, completion: null, output: null, settled: false };
  const completion = await superviseGitAgentRuntime(adapter, request, options);
  const output = mappedOutput(completion);
  const stopped = completion.stop.confirmed && completion.result.stop.confirmed;
  options.repair.settle(options.claim, output, { stopped });
  return { replayed: false, completion, output, settled: stopped };
}
