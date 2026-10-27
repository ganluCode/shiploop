import { describe, expect, it } from 'vitest';
import {
  assertSameGitAgentRepairRequest,
  computeGitAgentRepairBaselineDigest,
  createGitAgentRepairRequest,
  validateGitAgentRepairRuntimeOutput,
  type GitAgentRepairAuthorizationInput,
} from '../../../packages/core/src/ports/git-agent-repair.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

function authorization(): GitAgentRepairAuthorizationInput {
  return {
    projectId: 'project-1',
    phaseId: 'phase-1',
    parentBatchId: 'batch-1',
    featureId: 'feature-successor',
    runId: 'run-1',
    repairId: 'repair-1',
    commandId: 'command-1',
    source: {
      projectId: 'project-1',
      phaseId: 'phase-1',
      parentBatchId: 'batch-1',
      featureId: 'feature-successor',
      runId: 'run-1',
      integrationId: 'integration-1',
      operationId: 'operation-1',
      operationType: 'integration',
      operationDigest: DIGEST('f'),
      failureKind: 'conflict',
      evidenceId: 'failure-evidence-1',
      evidenceDigest: DIGEST('e'),
      inputDigest: DIGEST('a'),
    },
    target: {
      repoIdentity: 'repo-1',
      baselineCommitSha: SHA('b'),
      baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: 'repo-1', baselineCommitSha: SHA('b') }),
    },
    workspace: {
      workspaceId: 'workspace-1',
      workspaceDigest: DIGEST('b'),
    },
    conflictFiles: ['src/feature.ts'],
    writablePaths: ['src/feature.ts', 'test/feature.test.ts'],
    intent: { intentId: 'intent-1', digest: DIGEST('c') },
    verification: { strategyId: 'verification-1', digest: DIGEST('d') },
    budget: {
      remainingAttempts: 2,
      remainingTokens: 10_000,
      remainingRuntimeMs: 60_000,
      deadlineUtcMs: 4_000_000_000_000,
    },
  };
}

describe('P05-8 F-001 GitAgent repair contract', () => {
  it('[case:git-agent-repair-authorized-input-is-frozen-and-redacted]', () => {
    const request = createGitAgentRepairRequest(authorization(), { nowUtcMs: 1_000 });

    expect(request).toMatchObject({
      schemaVersion: 1,
      repairId: 'repair-1',
      commandId: 'command-1',
      source: { failureKind: 'conflict', integrationId: 'integration-1' },
      target: { baselineCommitSha: SHA('b') },
    });
    expect(request.commandDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(request.authorizationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(request)).not.toContain('/Users/');
    expect(JSON.stringify(request)).not.toContain('sqlite');
    expect(JSON.stringify(request)).not.toContain('approval');
    expect(Object.isFrozen(request.target)).toBe(true);
  });

  it('[case:git-agent-repair-requires-persisted-failure-source]', () => {
    const input = authorization();
    const missingSource = { ...input, source: undefined };

    expect(() => createGitAgentRepairRequest(missingSource, { nowUtcMs: 1_000 })).toThrowError(
      expect.objectContaining({ kind: 'validation', details: expect.objectContaining({ reason: 'missing_failure_source' }) }),
    );

    const ordinaryCommit = structuredClone(authorization()) as any;
    ordinaryCommit.source.operationType = 'task_commit';
    expect(() => createGitAgentRepairRequest(ordinaryCommit, { nowUtcMs: 1_000 })).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'source_not_integration' }) }),
    );
  });

  it('[case:git-agent-repair-rejects-baseline-drift-and-expired-deadline]', () => {
    const drifted = structuredClone(authorization()) as any;
    drifted.target.baselineCommitSha = SHA('c');
    expect(() => createGitAgentRepairRequest(drifted, { nowUtcMs: 1_000 })).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'baseline_digest_mismatch' }) }),
    );

    const expired = structuredClone(authorization()) as any;
    expired.budget.deadlineUtcMs = 999;
    expect(() => createGitAgentRepairRequest(expired, { nowUtcMs: 1_000 })).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'deadline_expired' }) }),
    );
  });

  it('[case:git-agent-repair-rejects-cross-project-source-and-path-escape]', () => {
    const crossProject = structuredClone(authorization()) as any;
    crossProject.source.projectId = 'project-2';
    expect(() => createGitAgentRepairRequest(crossProject, { nowUtcMs: 1_000 })).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'cross_project' }) }),
    );

    const escaped = structuredClone(authorization()) as any;
    escaped.writablePaths = ['../package.json'];
    expect(() => createGitAgentRepairRequest(escaped, { nowUtcMs: 1_000 })).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'path_outside_workspace' }) }),
    );
  });

  it('[case:git-agent-repair-detects-duplicate-identity-and-command-digest-conflict]', () => {
    const original = createGitAgentRepairRequest(authorization(), { nowUtcMs: 1_000 });
    const changed = authorization() as any;
    changed.intent = { intentId: 'intent-2', digest: DIGEST('e') };
    const candidate = createGitAgentRepairRequest(changed, { nowUtcMs: 1_000 });

    expect(() => assertSameGitAgentRepairRequest(original, candidate)).toThrowError(
      expect.objectContaining({ kind: 'conflict', details: expect.objectContaining({ reason: 'repair_identity_conflict' }) }),
    );

    const differentRepair = { ...changed, repairId: 'repair-2' };
    const commandConflict = createGitAgentRepairRequest(differentRepair, { nowUtcMs: 1_000 });
    expect(() => assertSameGitAgentRepairRequest(original, commandConflict)).toThrowError(
      expect.objectContaining({ kind: 'conflict', details: expect.objectContaining({ reason: 'command_digest_conflict' }) }),
    );
  });

  it('[case:git-agent-runtime-output-is-scoped-and-cannot-self-approve]', () => {
    const request = createGitAgentRepairRequest(authorization(), { nowUtcMs: 1_000 });
    const output = validateGitAgentRepairRuntimeOutput({
      schemaVersion: 1,
      repairId: request.repairId,
      status: 'modified',
      changedPaths: ['src/feature.ts'],
      usage: { consumedTokens: 100, runtimeMs: 500 },
      failureCode: null,
    }, request);
    expect(output.changedPaths).toEqual(['src/feature.ts']);

    expect(() => validateGitAgentRepairRuntimeOutput({
      schemaVersion: 1,
      repairId: request.repairId,
      status: 'modified',
      changedPaths: ['src/feature.ts'],
      usage: { consumedTokens: 100, runtimeMs: 500 },
      failureCode: null,
      approvalStatus: 'passed',
    }, request)).toThrowError(expect.objectContaining({ kind: 'validation' }));
  });
});
