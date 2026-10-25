import type { CommandTransaction } from './atomic-commands.js';
import type { GitAgentRepairRequest, GitAgentRepairRuntimeOutput } from './git-agent-repair.js';
import type { TaskClaimDispatch } from './task-claim.js';

export const GIT_AGENT_REPAIR_RUN_PURPOSE = 'git_agent_repair';
export const GIT_AGENT_REPAIR_HOLDS = [
  'public_contract_break', 'requirements_tradeoff', 'high_risk_delete', 'out_of_scope',
  'identity_or_lock', 'budget_exhausted', 'invalid_runtime_output', 'stop_unconfirmed',
] as const;
export type GitAgentRepairHold = typeof GIT_AGENT_REPAIR_HOLDS[number];

/** Immutable command receipt; current control/hold facts are read separately. */
export interface GitAgentRepairReceipt {
  readonly repairId: string;
  readonly parentBatchId: string;
  readonly runId: string | null;
  readonly authorizationDigest: string;
  readonly blockedReason: GitAgentRepairHold | null;
}
export interface GitAgentRepairAttempt {
  readonly id: string;
  readonly repairId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly hostInstanceId: string;
  readonly authorizationVersion: number;
  readonly dispatch: TaskClaimDispatch;
  readonly startedAtUtcMs: number;
  readonly deadlineUtcMs: number;
  readonly maxTokens: number;
  readonly maxRuntimeMs: number;
  readonly output: GitAgentRepairRuntimeOutput | null;
  readonly stoppedAtUtcMs: number | null;
}
export interface GitAgentRepairView {
  readonly receipt: GitAgentRepairReceipt;
  readonly request: GitAgentRepairRequest;
  readonly authorizationVersion: number;
  readonly blockedReason: GitAgentRepairHold | null;
  readonly attempts: readonly GitAgentRepairAttempt[];
}
export interface GitAgentRepairClaim {
  readonly projectId: string;
  readonly repairId: string;
  /** Stable admission identity; a replay with the same key never starts another Attempt. */
  readonly claimKey?: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly hostInstanceId: string;
  readonly authorizationVersion: number;
}

/** Core-only transaction primitives. No model-facing queue or budget mutation API. */
export interface GitAgentRepairStore {
  authorize(tx: CommandTransaction, request: GitAgentRepairRequest, hold?: GitAgentRepairHold): GitAgentRepairReceipt;
  read(tx: CommandTransaction, projectId: string, repairId: string): GitAgentRepairView;
  claim(tx: CommandTransaction, input: GitAgentRepairClaim): GitAgentRepairAttempt | null;
  /** Caller is the supervised Core consumer; stopped evidence is checked outside the transaction. */
  settle(tx: CommandTransaction, input: GitAgentRepairClaim, output: unknown, stopped: boolean): GitAgentRepairView;
  hold(tx: CommandTransaction, projectId: string, repairId: string, reason: GitAgentRepairHold): GitAgentRepairView;
}
