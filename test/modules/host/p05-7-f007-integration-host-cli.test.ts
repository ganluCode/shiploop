import { describe, expect, it } from 'vitest';
import {
  validateIntegrationStartCommandResultWire,
  validateIntegrationReconcileCommandResultWire,
  validateGitOperationDetailResultWire,
} from '../../../packages/host/src/client/app-wire.ts';
import {
  buildIntegrationStartCliView,
  buildIntegrationReconcileCliView,
  formatIntegrationReconcileView,
} from '../../../packages/cli/src/app/delivery.ts';

const base = {
  featureId: 'feature-1',
  runId: 'run-1',
  batchId: 'batch-1',
  gitOperationId: 'operation-1',
  reason: 'integration facts matched',
  deliveryStatus: 'succeeded' as const,
  runtimeCalled: false as const,
  executionStarted: false as const,
};

describe('P05-7 F-007 integration Host/CLI projection', () => {
  function operationRecord() {
    return {
      operationId: 'operation-1', projectId: 'project-1', featureId: 'feature-1', runId: 'run-1',
      attemptId: null, executionVersion: 1, operationType: 'integration', intentDigest: 'a'.repeat(64),
      repositoryBindingId: 'binding-1', repoIdentity: 'repo-1', expectedHead: 'a'.repeat(40),
      candidateTree: 'a'.repeat(40), codeDigest: 'b'.repeat(64), actualCommit: null,
      actualTree: null, actualParent: null, verificationRefs: [], approvalRefs: [], message: 'integration',
      gitIdentity: { name: 'Test User', email: 'test@example.test', confirmed: true },
      deliveryPolicyDigest: 'c'.repeat(64), runtimeSource: null, status: 'pending', exitCode: null,
      durationMs: null, reasonCode: null, deliveryStatus: null, receipt: null, settledAt: null,
      revision: 1, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
      integration: {
        integrationId: 'operation-1', targetBase: 'a'.repeat(40), inputDigest: 'd'.repeat(64),
        approvedInputs: [{ inputId: 'input-1', digest: 'e'.repeat(64) }], mergeOrder: ['feature-a'],
        verificationScope: ['module-test'], predecessors: [{ featureId: 'feature-a', commitSha: 'b'.repeat(40), coveredInputIds: ['input-1'] }],
        result: null, recoveryState: null, workspacePreserved: false,
      },
    };
  }

  it('accepts the public integration projection and ordinary operations with null integration', () => {
    const record = operationRecord();
    expect(validateGitOperationDetailResultWire({ operation: record }).operation.integration?.integrationId).toBe('operation-1');
    expect(() => validateGitOperationDetailResultWire({ operation: { ...record, operationType: 'feature_final_commit', integration: null } })).not.toThrow();
  });

  it('rejects unknown nested paths, mismatched identities and malformed integration evidence', () => {
    const record = operationRecord();
    for (const integration of [
      { ...record.integration, worktreePath: '/private/worktree' },
      { ...record.integration, integrationId: 'other-operation' },
      { ...record.integration, result: { commitSha: null, treeSha: null, inputDigest: 'f'.repeat(64), verificationEvidence: null } },
      { ...record.integration, predecessors: [{ ...record.integration.predecessors[0], canonicalPath: '/private/repo' }] },
    ]) {
      expect(() => validateGitOperationDetailResultWire({ operation: { ...record, integration } })).toThrow();
    }
  });

  it('[case:integration-start-wire-and-cli] keeps a started integration pending until Core verification evidence exists', () => {
    const result = validateIntegrationStartCommandResultWire({
      ...base,
      outcome: 'pending_verification',
      reason: null,
      deliveryStatus: null,
      executionStarted: true,
    });
    expect(buildIntegrationStartCliView(result)).toMatchObject({ state: 'pending', canStartSuccessor: false });
  });

  it('[case:integration-reconcile-wire-four-states] accepts Core reconciliation states without treating blocked or unknown as success', () => {
    for (const outcome of ['pending', 'blocked', 'unknown', 'matched'] as const) {
      const result = validateIntegrationReconcileCommandResultWire({ ...base, outcome });
      expect(result.outcome).toBe(outcome);
    }
  });

  it('[case:integration-reconcile-wire-rejects-secret-or-path-fields] rejects extension fields instead of silently exposing them', () => {
    expect(() => validateIntegrationReconcileCommandResultWire({
      ...base,
      outcome: 'matched',
      worktreePath: '/private/worktree',
    })).toThrow();
  });

  it('[case:integration-successor-gate] requires matched and succeeded before successor start is allowed', () => {
    const matched = buildIntegrationReconcileCliView({ ...base, outcome: 'matched' });
    const blocked = buildIntegrationReconcileCliView({ ...base, outcome: 'blocked', deliveryStatus: null });
    const unknown = buildIntegrationReconcileCliView({ ...base, outcome: 'unknown' });

    expect(matched).toMatchObject({ state: 'matched', canStartSuccessor: true });
    expect(blocked).toMatchObject({ state: 'blocked', canStartSuccessor: false });
    expect(unknown).toMatchObject({ state: 'unknown', canStartSuccessor: false });
    expect(formatIntegrationReconcileView(unknown)).toContain('state=unknown');
    expect(formatIntegrationReconcileView(unknown)).toContain('successorStart=false');
  });
});
