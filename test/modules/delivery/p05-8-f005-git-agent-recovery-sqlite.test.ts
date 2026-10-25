import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitAgentRepairRecoveryService } from '../../../packages/core/src/application/git-agent-repair-recovery.ts';
import { createGitAgentRepairService } from '../../../packages/core/src/application/git-agent-repair.ts';
import { createSqliteGitAgentRepairStore } from '../../../packages/core/src/adapters/sqlite/git-agent-repair-store.ts';
import { computeGitAgentRepairBaselineDigest, createGitAgentRepairRequest } from '../../../packages/core/src/ports/git-agent-repair.ts';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';
import { openIntegrationFixture, digest } from '../../helpers/p05-7-integration-vertical.ts';
import { NOW, BUDGET } from '../../helpers/p03-3/budget-fixture.ts';

const fixtures: Awaited<ReturnType<typeof openIntegrationFixture>>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function hash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

describe('P05-8 F-005 SQLite recovery facts', () => {
  it('[case:sqlite-recovery-reopens-and-settles-one-crashed-attempt]', async () => {
    const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
    const f = await openIntegrationFixture({ batch, run: BUDGET.run }); fixtures.push(f);
    const operation = f.operations.registerGitOperation(f.intent).operation;
    const failed = f.operations.finalizeGitOperation({ projectId: f.box.projectId, operationId: operation.intent.operationId,
      expectedRevision: operation.revision, status: 'failed', actualCommit: null, actualTree: null, exitCode: 1, durationMs: 1,
      reasonCode: 'merge_conflict', deliveryStatus: 'not_requested', settledAtUtcMs: NOW + 1, recoveryState: 'preserved', workspacePreserved: true }).operation;
    f.box.session.database.prepare("UPDATE runs SET status = 'failed', ended_at = ? WHERE id = ?").run(NOW + 1, f.plan.runId);
    const request = createGitAgentRepairRequest({
      projectId: f.box.projectId, phaseId: f.plan.phaseId, parentBatchId: f.plan.batchId, featureId: f.box.featureId, runId: f.plan.runId,
      repairId: 'repair-recovery', commandId: 'repair-recovery-command',
      source: { projectId: f.box.projectId, phaseId: f.plan.phaseId, parentBatchId: f.plan.batchId, featureId: f.box.featureId, runId: f.plan.runId,
        integrationId: f.plan.integrationId, operationId: f.intent.operationId, operationType: 'integration', operationDigest: operation.intentDigest,
        failureKind: 'conflict', evidenceId: f.intent.operationId, evidenceDigest: hash(failed.receipt), inputDigest: f.plan.inputDigest },
      target: { repoIdentity: f.plan.target.repoIdentity, baselineCommitSha: f.plan.target.baseCommit,
        baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: f.plan.target.repoIdentity, baselineCommitSha: f.plan.target.baseCommit }) },
      workspace: { workspaceId: f.plan.integrationId, workspaceDigest: hash({ repoIdentity: f.intent.repoIdentity, worktreePath: f.intent.worktreePath, inputDigest: f.plan.inputDigest, baselineCommitSha: f.intent.expectedHead }) },
      conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts'], intent: { intentId: 'intent-1', digest: digest('c') },
      verification: { strategyId: 'combined-tests', digest: digest('d') },
      budget: { remainingAttempts: 2, remainingTokens: 100, remainingRuntimeMs: 1000, deadlineUtcMs: NOW + 5_000 },
    }, { nowUtcMs: NOW });
    const service = createGitAgentRepairService({ atomic: f.box.atomic, store: createSqliteGitAgentRepairStore(f.box.session, { nowUtcMs: () => NOW + 2 }) });
    const receipt = service.authorize(request);
    expect(receipt).toMatchObject({ runId: expect.any(String), blockedReason: null });
    const claim = { projectId: f.box.projectId, repairId: request.repairId, attemptId: 'recovery-attempt', claimKey: 'recovery-claim', ownerId: 'recovery-owner', hostInstanceId: 'recovery-host', authorizationVersion: 1 };
    expect(service.claim(claim)).not.toBeNull();
    expect(() => service.claim({ ...claim, attemptId: 'different-attempt' })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'attempt_identity_conflict' }) }));
    await f.box.reopen();
    const reopened = createGitAgentRepairService({ atomic: f.box.atomic, store: createSqliteGitAgentRepairStore(f.box.session, { nowUtcMs: () => NOW + 3 }) });
    expect(() => reopened.claim({ ...claim, attemptId: 'different-after-reopen' })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'attempt_identity_conflict' }) }));
    const recovery = createGitAgentRepairRecoveryService({
      repair: reopened,
      observe: async () => ({ schemaVersion: 1, phase: 'after_runtime' as const, processStopped: true, processIdentity: 'recovery-process',
        workspace: { repoIdentity: f.plan.target.repoIdentity, head: f.plan.target.baseCommit, tree: f.plan.target.baseCommit },
        operation: { status: 'failed' as const, operationId: null, expectedHead: null, candidateTree: null, actualCommit: null, actualTree: null, intentMatched: false },
        externalSideEffect: 'none' as const }),
      nowUtcMs: () => NOW + 3,
    });
    const result = await recovery.recover({ schemaVersion: 1, ...claim, phase: 'after_runtime', commandId: 'repair-recovery-command', claimKey: 'recovery-claim', repoIdentity: f.plan.target.repoIdentity, baselineCommitSha: f.plan.target.baseCommit,
      requestedOutcome: 'crashed', nowUtcMs: NOW + 3, deadlineUtcMs: NOW + 5_000, remainingAttempts: 1, remainingTokens: 100, remainingRuntimeMs: 1000 });
    expect(result.settled).toBe(true);
    expect(reopened.read(f.box.projectId, request.repairId).attempts[0]).toMatchObject({ stoppedAtUtcMs: expect.any(Number), output: { failureCode: 'process_exited', usage: { consumedTokens: 100, runtimeMs: 1000 } } });
    expect(f.box.session.database.prepare('SELECT attempts_created, runtime_starts FROM execution_batches WHERE id = ?').get(f.plan.batchId)).toEqual({ attempts_created: 1, runtime_starts: 1 });
  });
});
