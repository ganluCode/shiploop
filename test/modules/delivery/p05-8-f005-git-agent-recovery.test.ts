import { describe, expect, it, vi } from 'vitest';
import {
  computeGitAgentRepairBaselineDigest,
  createGitAgentRepairRequest,
  createGitAgentRuntimeRequest,
  createGitAgentRepairRecoveryService,
  decideGitAgentRepairRecovery,
  runGitAgentRepairAttempt,
  type GitAgentRepairAuthorizationInput,
} from '../../../packages/core/src/index.ts';
import type { GitAgentRepairClaim, GitAgentRepairView } from '../../../packages/core/src/ports/git-agent-repair-store.ts';
import type { GitAgentRepairRuntimeOutput } from '../../../packages/core/src/ports/git-agent-repair.ts';

const SHA = 'a'.repeat(40);
const DIGEST = (n: string) => n.repeat(64);

function authorization(): GitAgentRepairAuthorizationInput {
  return {
    projectId: 'project-1', phaseId: 'phase-1', parentBatchId: 'batch-1', featureId: 'feature-1', runId: 'run-1', repairId: 'repair-1', commandId: 'command-1',
    source: { projectId: 'project-1', phaseId: 'phase-1', parentBatchId: 'batch-1', featureId: 'feature-1', runId: 'run-1', integrationId: 'integration-1', operationId: 'operation-1', operationType: 'integration', operationDigest: DIGEST('1'), failureKind: 'conflict', evidenceId: 'evidence-1', evidenceDigest: DIGEST('2'), inputDigest: DIGEST('3') },
    target: { repoIdentity: 'repo-1', baselineCommitSha: SHA, baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: 'repo-1', baselineCommitSha: SHA }) },
    workspace: { workspaceId: 'workspace-1', workspaceDigest: DIGEST('4') }, conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts'],
    intent: { intentId: 'intent-1', digest: DIGEST('5') }, verification: { strategyId: 'verification-1', digest: DIGEST('6') },
    budget: { remainingAttempts: 2, remainingTokens: 100, remainingRuntimeMs: 1000, deadlineUtcMs: 4_000_000_000_000 },
  };
}
function request() {
  const auth = createGitAgentRepairRequest(authorization(), { nowUtcMs: 1_000 });
  return createGitAgentRuntimeRequest({ authorization: auth, claim: claim(), invocationId: 'invocation-1', executionVersion: 1 });
}
function claim(): GitAgentRepairClaim {
  return { projectId: 'project-1', repairId: 'repair-1', attemptId: 'attempt-1', ownerId: 'owner-1', hostInstanceId: 'host-1', authorizationVersion: 1 };
}
function observation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, phase: 'after_runtime', processStopped: true, processIdentity: 'pid-1',
    workspace: { repoIdentity: 'repo-1', head: SHA, tree: SHA },
    operation: { status: 'failed', operationId: null, expectedHead: null, candidateTree: null, actualCommit: null, actualTree: null, intentMatched: false },
    externalSideEffect: 'none', ...overrides,
  } as const;
}
function view(output: GitAgentRepairRuntimeOutput | null = null): GitAgentRepairView {
  return {
    receipt: { repairId: 'repair-1', parentBatchId: 'batch-1', runId: 'run-1', authorizationDigest: DIGEST('a'), blockedReason: null },
    request: createGitAgentRepairRequest(authorization(), { nowUtcMs: 1_000 }), authorizationVersion: 1, blockedReason: null,
    attempts: [{ id: 'attempt-1', repairId: 'repair-1', projectId: 'project-1', runId: 'run-1', ownerId: 'owner-1', hostInstanceId: 'host-1', authorizationVersion: 1, dispatch: { claimId: 'claim-1', claimVersion: 1, slotId: 'slot-1' }, startedAtUtcMs: 1_000, deadlineUtcMs: 4_000_000_000_000, maxTokens: 100, maxRuntimeMs: 1_000, output, stoppedAtUtcMs: null }],
  };
}

describe('P05-8 F-005 GitAgent recovery', () => {
  it('[case:recovery-stop-unconfirmed-keeps-writer-quarantined]', () => {
    const decision = decideGitAgentRepairRecovery({ schemaVersion: 1, ...claim(), phase: 'after_runtime', commandId: 'command-1', claimKey: 'claim-key-1', repoIdentity: 'repo-1', baselineCommitSha: SHA, requestedOutcome: 'crashed', nowUtcMs: 2, deadlineUtcMs: 100, remainingAttempts: 1, remainingTokens: 10, remainingRuntimeMs: 10 }, observation({ processStopped: false }));
    expect(decision).toEqual({ action: 'blocked', reason: 'stop_unconfirmed', allowNewAttempt: false });
  });

  it('[case:recovery-pending-git-operation-requires-reconcile]', () => {
    const decision = decideGitAgentRepairRecovery({ schemaVersion: 1, ...claim(), phase: 'before_receipt', commandId: 'command-1', claimKey: 'claim-key-1', repoIdentity: 'repo-1', baselineCommitSha: SHA, requestedOutcome: 'crashed', nowUtcMs: 2, deadlineUtcMs: 100, remainingAttempts: 1, remainingTokens: 10, remainingRuntimeMs: 10 }, observation({ operation: { status: 'pending', operationId: 'operation-1', expectedHead: SHA, candidateTree: SHA, actualCommit: null, actualTree: null, intentMatched: false } }));
    expect(decision).toEqual({ action: 'reconcile', reason: 'operation_pending', allowNewAttempt: false });
  });

  it('[case:recovery-fences-stale-owner-without-hold-or-release]', async () => {
    const current = view(); const hold = vi.fn(); const settle = vi.fn();
    const service = createGitAgentRepairRecoveryService({ repair: { read: () => current, hold, settle }, observe: async () => observation() });
    const result = await service.recover({ schemaVersion: 1, ...claim(), ownerId: 'old-owner', phase: 'after_runtime', commandId: 'command-1', claimKey: 'claim-key-1', repoIdentity: 'repo-1', baselineCommitSha: SHA, requestedOutcome: 'crashed', nowUtcMs: 2, deadlineUtcMs: 100, remainingAttempts: 1, remainingTokens: 10, remainingRuntimeMs: 10 });
    expect(result.decision.reason).toBe('stale_owner'); expect(hold).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
  });

  it('[case:recovery-settles-unknown-crash-conservatively-before-explicit-retry]', async () => {
    const current = view(); const settled = view({ schemaVersion: 1, repairId: 'repair-1', status: 'failed', changedPaths: [], usage: { consumedTokens: 100, runtimeMs: 1000 }, failureCode: 'process_exited' });
    const settle = vi.fn(() => settled); const service = createGitAgentRepairRecoveryService({ repair: { read: () => current, hold: vi.fn(), settle }, observe: async () => observation() });
    const result = await service.recover({ schemaVersion: 1, ...claim(), phase: 'after_runtime', commandId: 'command-1', claimKey: 'claim-key-1', repoIdentity: 'repo-1', baselineCommitSha: SHA, requestedOutcome: 'crashed', nowUtcMs: 2, deadlineUtcMs: 100, remainingAttempts: 1, remainingTokens: 100, remainingRuntimeMs: 1000 });
    expect(result.settled).toBe(true); expect(result.canCreateAttempt).toBe(true); expect(settle).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'attempt-1' }), expect.objectContaining({ failureCode: 'process_exited', usage: { consumedTokens: 100, runtimeMs: 1000 } }), { stopped: true });
  });

  it('[case:attempt-runner-settles-cancellation-with-bounded-reason]', async () => {
    const started = vi.fn(async () => ({
      result: Promise.resolve({ schemaVersion: 1, repairId: 'repair-1', terminal: 'cancelled', execution: request().execution,
        changedPaths: [], verification: { strategyId: 'verification-1', strategyDigest: DIGEST('6'), outputDigest: null, exitCode: null },
        usage: { consumedTokens: 7, runtimeMs: 11 }, failure: { classification: 'runtime', code: 'cancelled' }, stop: { confirmed: true, detail: null } } as const),
      stopped: Promise.resolve({ confirmed: true, detail: null }), cancel: vi.fn(async () => ({ accepted: true, reason: 'cancel_requested' })),
    }));
    const repair = { settle: vi.fn() };
    const result = await runGitAgentRepairAttempt({ start: started }, request(), { id: 'attempt-1', repairId: 'repair-1', projectId: 'project-1', runId: 'run-1', ownerId: 'owner-1', hostInstanceId: 'host-1', authorizationVersion: 1, dispatch: { claimId: 'claim-1', claimVersion: 1, slotId: 'slot-1' }, startedAtUtcMs: 1, deadlineUtcMs: 100, maxTokens: 100, maxRuntimeMs: 1000, output: null, stoppedAtUtcMs: null }, { repair, claim: claim() });
    expect(result.output).toMatchObject({ status: 'cancelled', failureCode: 'cancelled', usage: { consumedTokens: 7 } });
    expect(result.settled).toBe(true); expect(repair.settle).toHaveBeenCalledWith(claim(), expect.objectContaining({ failureCode: 'cancelled' }), { stopped: true });
  });
  it('[case:attempt-runner-does-not-start-a-replayed-admission]', async () => {
    const start = vi.fn(); const adapter = { start };
    const repair = { settle: vi.fn() };
    const result = await runGitAgentRepairAttempt(adapter, request(), null, { repair, claim: claim() });
    expect(result.replayed).toBe(true); expect(start).not.toHaveBeenCalled(); expect(repair.settle).not.toHaveBeenCalled();
  });
});
