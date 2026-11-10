import type { GitAgentRepairRuntimeOutput, GitAgentRepairRequest } from './git-agent-repair.js';
import type { GitAgentRuntimeRequest } from './git-agent-runtime.js';
import type { TaskClaimDispatch } from './task-claim.js';
import type { CommandProcessIdentity } from './command-process.js';

export interface IntegrationRepairAttemptClaim {
  readonly projectId: string;
  readonly repairId: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
}

export interface IntegrationRepairAttemptRecord extends IntegrationRepairAttemptClaim {
  readonly runId: string;
  readonly operationId: string;
  readonly request: GitAgentRepairRequest;
  readonly runtimeRequest: GitAgentRuntimeRequest | null;
  readonly startedAtUtcMs: number;
  readonly deadlineUtcMs: number;
  readonly maxTokens: number;
  readonly maxRuntimeMs: number;
  readonly dispatch: TaskClaimDispatch;
  readonly processIdentity: CommandProcessIdentity | null;
  readonly output: GitAgentRepairRuntimeOutput | null;
  readonly stoppedAtUtcMs: number | null;
}
